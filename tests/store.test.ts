import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertForeignKeysEnabled,
  closeDatabaseConnectionsForTests,
  getDatabaseContext,
} from "@/lib/db/client";
import { publishPreparedInitialFile } from "@/lib/db/atomic-file";
import { DomainError } from "@/lib/domain";
import {
  archiveApplication,
  createApplication,
  createEvent,
  getApplicationDetail,
  getHealthStatus,
  getTodayDashboard,
  listApplications,
  listCalendarEvents,
  restoreApplication,
  setApplicationAttention,
  setApplicationStage,
  updateApplication,
  updateEventStatus,
} from "@/lib/services";

let dataRoot = "";

describe("local data store", () => {
  beforeAll(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "campus-hire-tracker-test-"));
    process.env.CAMPUS_HIRE_TRACKER_DATA_DIR = dataRoot;
    await getDatabaseContext();
  });

  beforeEach(async () => {
    const { client } = await getDatabaseContext();
    await client.executeMultiple(`
      UPDATE applications
      SET attention_mode='NEEDS_ACTION', next_action_title=NULL, current_action_event_id=NULL,
          waiting_for=NULL, waiting_review_event_id=NULL
      WHERE stage <> 'ARCHIVED';
      DELETE FROM timeline_entries;
      DELETE FROM application_tags;
      DELETE FROM events;
      DELETE FROM applications;
      DELETE FROM resume_versions;
      DELETE FROM resumes;
      DELETE FROM positions;
      DELETE FROM tags;
      DELETE FROM companies;
    `);
  });

  afterAll(async () => {
    await closeDatabaseConnectionsForTests();
    delete process.env.CAMPUS_HIRE_TRACKER_DATA_DIR;
    // The native libSQL Windows handle can outlive client.close() until this Vitest worker exits.
    // A detached, hidden helper retries only this verified temp directory after the worker releases it.
    const cleanupScript = `
      const fs = require('node:fs');
      const target = process.argv[1];
      if (!target || !/campus-hire-tracker-test-[^\\\\/]+$/.test(target)) process.exit(2);
      const deadline = Date.now() + 30000;
      const remove = () => fs.rm(target, { recursive: true, force: true }, (error) => {
        if (!error || error.code === 'ENOENT') process.exit(0);
        if (Date.now() >= deadline) process.exit(1);
        setTimeout(remove, 250);
      });
      remove();
    `;
    spawn(process.execPath, ["-e", cleanupScript, dataRoot], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  });

  it("initializes an idempotent generation outside the repository with foreign keys enabled", async () => {
    const first = await getDatabaseContext();
    const second = await getDatabaseContext();
    expect(second.generationId).toBe(first.generationId);
    expect(first.databasePath.startsWith(dataRoot)).toBe(true);
    expect(first.dataRoot).toBe(await realpath(dataRoot));
    expect(first.databasePath).toContain(path.join("stores", first.generationId, "app.db"));
    await access(first.databasePath);
    expect(await assertForeignKeysEnabled()).toBe(true);

    const active = JSON.parse(await readFile(path.join(dataRoot, "runtime", "active.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(active).toMatchObject({
      formatVersion: 1,
      releaseId: "development",
      generationId: first.generationId,
    });
    expect(Number.isNaN(Date.parse(String(active.activatedAt)))).toBe(false);
    await expect(getHealthStatus()).resolves.toMatchObject({ status: "ok", schemaVersion: 2 });
  });

  it("enforces complete resume file slots, per-series version numbers, and application references", async () => {
    const { client, workspaceId } = await getDatabaseContext();
    const now = Date.now();
    const resumeId = randomUUID();
    const sourceVersionId = randomUUID();
    const deliveryVersionId = randomUUID();
    const hash = "a".repeat(64);

    await client.execute({
      sql: `INSERT INTO resumes
        (id, workspace_id, name, target_direction, language, archived_at_ms,
         created_at_ms, updated_at_ms, version)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
      args: [resumeId, workspaceId, "校招主简历", "后端开发", "zh-CN", now, now],
    });

    await client.execute({
      sql: `INSERT INTO resume_versions
        (id, workspace_id, resume_id, version_number,
         source_docx_original_name, source_docx_relative_path, source_docx_mime_type,
         source_docx_size_bytes, source_docx_sha256, change_summary, created_at_ms)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        sourceVersionId,
        workspaceId,
        resumeId,
        "校招简历.docx",
        `${sourceVersionId}.docx`,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        1_024,
        hash,
        "初始版本",
        now,
      ],
    });

    await expect(
      client.execute({
        sql: `INSERT INTO resume_versions
          (id, workspace_id, resume_id, version_number,
           delivery_pdf_original_name, delivery_pdf_relative_path, delivery_pdf_mime_type,
           delivery_pdf_size_bytes, delivery_pdf_sha256, created_at_ms)
          VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, ?)`,
        args: [
          deliveryVersionId,
          workspaceId,
          resumeId,
          "校招简历.pdf",
          `${deliveryVersionId}.pdf`,
          "application/pdf",
          2_048,
          hash,
          now,
        ],
      }),
    ).resolves.toBeDefined();

    await expect(
      client.execute({
        sql: `INSERT INTO resume_versions
          (id, workspace_id, resume_id, version_number,
           delivery_pdf_original_name, delivery_pdf_relative_path, created_at_ms)
          VALUES (?, ?, ?, 3, ?, ?, ?)`,
        args: [
          randomUUID(),
          workspaceId,
          resumeId,
          "不完整.pdf",
          `${randomUUID()}.pdf`,
          now,
        ],
      }),
    ).rejects.toThrow();

    await expect(
      client.execute({
        sql: `INSERT INTO resume_versions
          (id, workspace_id, resume_id, version_number,
           source_docx_original_name, source_docx_relative_path, source_docx_mime_type,
           source_docx_size_bytes, source_docx_sha256, created_at_ms)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        args: [
          randomUUID(),
          workspaceId,
          resumeId,
          "重复版本.docx",
          `${randomUUID()}.docx`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          512,
          hash,
          now,
        ],
      }),
    ).rejects.toThrow();

    const application = await createApplication({
      companyName: "简历关联公司",
      positionTitle: "后端工程师",
    });
    await expect(
      client.execute({
        sql: "UPDATE applications SET resume_version_id = ? WHERE id = ?",
        args: [deliveryVersionId, application.id],
      }),
    ).resolves.toBeDefined();
    await expect(
      client.execute({
        sql: "UPDATE applications SET resume_version_id = ? WHERE id = ?",
        args: [randomUUID(), application.id],
      }),
    ).rejects.toThrow();
  });

  it("migrates a schema-v1 store to schema v2 without losing existing applications", async () => {
    const migrationRoot = path.join(dataRoot, "schema-v1-upgrade");
    const generationId = "schema-v1-generation";
    const databasePath = path.join(migrationRoot, "stores", generationId, "app.db");
    await mkdir(path.dirname(databasePath), { recursive: true });
    await mkdir(path.join(migrationRoot, "stores", generationId, "attachments"), {
      recursive: true,
    });
    await mkdir(path.join(migrationRoot, "runtime", "releases", "development"), {
      recursive: true,
    });
    await writeFile(
      path.join(migrationRoot, "runtime", "active.json"),
      JSON.stringify({
        formatVersion: 1,
        releaseId: "development",
        generationId,
        activatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const url = `file:${databasePath.replace(/\\/g, "/")}`;
    const setupClient = createClient({ url });
    await setupClient.executeMultiple(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE workspace_settings (workspace_id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE companies (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE positions (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE applications (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL
      );
      CREATE TABLE tags (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE application_tags (application_id TEXT NOT NULL, tag_id TEXT NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE timeline_entries (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO workspaces (id) VALUES ('default-workspace');
      INSERT INTO workspace_settings (workspace_id) VALUES ('default-workspace');
      INSERT INTO applications (id, workspace_id)
        VALUES ('existing-application', 'default-workspace');
      PRAGMA user_version = 1;
    `);
    setupClient.close();

    process.env.CAMPUS_HIRE_TRACKER_DATA_DIR = migrationRoot;
    try {
      const migrated = await getDatabaseContext();
      const version = await migrated.client.execute("PRAGMA user_version");
      const tables = await migrated.client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('resumes', 'resume_versions') ORDER BY name",
      );
      const applicationColumns = await migrated.client.execute("PRAGMA table_info(applications)");
      const existingApplication = await migrated.client.execute({
        sql: "SELECT id, resume_version_id FROM applications WHERE id = ?",
        args: ["existing-application"],
      });

      expect(Number(version.rows[0]?.user_version)).toBe(2);
      expect(tables.rows.map((row) => String(row.name))).toEqual([
        "resume_versions",
        "resumes",
      ]);
      expect(applicationColumns.rows.map((row) => String(row.name))).toContain(
        "resume_version_id",
      );
      expect(existingApplication.rows[0]).toMatchObject({
        id: "existing-application",
        resume_version_id: null,
      });
    } finally {
      process.env.CAMPUS_HIRE_TRACKER_DATA_DIR = dataRoot;
    }
  });

  it("publishes the initial pointer safely when Windows reports EXDEV", async () => {
    const temporaryPath = path.join(dataRoot, "runtime", "pointer-fallback.tmp");
    const targetPath = path.join(dataRoot, "runtime", "pointer-fallback.json");
    const contents = '{"formatVersion":1}\n';
    await writeFile(temporaryPath, contents, "utf8");
    const crossDeviceLink = async () => {
      const error = new Error("simulated redirected LocalAppData") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    };
    await expect(
      publishPreparedInitialFile(temporaryPath, targetPath, contents, crossDeviceLink),
    ).resolves.toBe("published");
    await expect(readFile(targetPath, "utf8")).resolves.toBe(contents);
    await expect(access(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unknown higher schema version without downgrading or applying DDL", async () => {
    const futureRoot = path.join(dataRoot, "future-version-store");
    const generationId = "future-generation";
    const databasePath = path.join(futureRoot, "stores", generationId, "app.db");
    await mkdir(path.dirname(databasePath), { recursive: true });
    await mkdir(path.join(futureRoot, "stores", generationId, "attachments"), { recursive: true });
    await mkdir(path.join(futureRoot, "runtime", "releases", "future-release"), { recursive: true });
    await writeFile(
      path.join(futureRoot, "runtime", "active.json"),
      JSON.stringify({
        formatVersion: 1,
        releaseId: "future-release",
        generationId,
        activatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const url = `file:${databasePath.replace(/\\/g, "/")}`;
    const setupClient = createClient({ url });
    await setupClient.execute("PRAGMA user_version = 999");
    setupClient.close();

    process.env.CAMPUS_HIRE_TRACKER_DATA_DIR = futureRoot;
    try {
      await expect(getDatabaseContext()).rejects.toMatchObject({ code: "SCHEMA_INCOMPATIBLE" });
      const verificationClient = createClient({ url });
      const version = await verificationClient.execute("PRAGMA user_version");
      const tables = await verificationClient.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      );
      expect(Number(version.rows[0]?.user_version)).toBe(999);
      expect(tables.rows).toHaveLength(0);
      verificationClient.close();
    } finally {
      process.env.CAMPUS_HIRE_TRACKER_DATA_DIR = dataRoot;
    }
  });

  it("creates company, position, application, tags and timeline atomically", async () => {
    const created = await createApplication({
      companyName: "  示例科技  ",
      positionTitle: "前端工程师",
      cycleLabel: "2027 秋招",
      tagNames: ["重点", " 重点 ", "北京"],
      attention: { mode: "ACTION", title: "完善简历" },
    });
    expect(created.companyName).toBe("示例科技");
    expect(created.attentionMode).toBe("ACTION");
    expect(created.nextActionTitle).toBe("完善简历");
    expect(created.tags.map((tag) => tag.name)).toEqual(["北京", "重点"]);
    expect(created.timeline.map((entry) => entry.entryType)).toEqual(
      expect.arrayContaining(["APPLICATION_CREATED", "ATTENTION_CHANGED"]),
    );
    expect((await listApplications())[0].id).toBe(created.id);
  });

  it("requires explicit duplicate confirmation and rolls back every attempted write", async () => {
    const first = await createApplication({ companyName: "同名公司", positionTitle: "算法工程师" });
    const before = await getApplicationDetail(first.id);

    let thrown: unknown;
    try {
      await createApplication({ companyName: "同名公司", positionTitle: "算法工程师" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe("DUPLICATE_CONFIRMATION_REQUIRED");
    expect((thrown as DomainError).details).toMatchObject({ matches: [{ id: first.id }] });
    expect(await listApplications()).toHaveLength(1);
    expect((await getApplicationDetail(first.id))?.timeline).toHaveLength(before!.timeline.length);

    await createApplication({
      companyName: "同名公司",
      positionTitle: "算法工程师",
      allowDuplicate: true,
    });
    expect(await listApplications()).toHaveLength(2);
  });

  it("enforces mutually exclusive attention modes and cross-row event references", async () => {
    const application = await createApplication({ companyName: "等待公司", positionTitle: "产品经理" });
    const waiting = await setApplicationAttention(application.id, {
      mode: "WAITING",
      waitingFor: "HR 回复",
      review: { kind: "TIMED", startsAtMs: Date.now() - 1_000 },
    });
    expect(waiting.attentionMode).toBe("WAITING");
    expect(waiting.nextActionTitle).toBeNull();
    const review = waiting.events.find((event) => event.type === "FOLLOW_UP");
    expect(review).toBeDefined();

    const { client } = await getDatabaseContext();
    await expect(
      client.execute({
        sql: `UPDATE applications SET attention_mode='ACTION', next_action_title='错误引用',
              current_action_event_id=?, waiting_for=NULL, waiting_review_event_id=NULL WHERE id=?`,
        args: [review!.id, application.id],
      }),
    ).rejects.toThrow();

    const completed = await updateEventStatus(review!.id, { status: "COMPLETED" });
    expect(completed.status).toBe("COMPLETED");
    const after = await getApplicationDetail(application.id);
    expect(after?.attentionMode).toBe("NEEDS_ACTION");
    expect(after?.timeline.map((entry) => entry.entryType)).toContain("EVENT_COMPLETED");
    expect(after?.timeline.map((entry) => entry.entryType)).toContain("ATTENTION_CHANGED");

    const actionable = await setApplicationAttention(application.id, {
      mode: "ACTION",
      title: "准备作品集",
      due: { kind: "TIMED", startsAtMs: Date.now() + 60_000 },
    });
    const actionEvent = actionable.events.find(
      (event) => event.type === "ACTION_DUE" && event.status === "SCHEDULED",
    );
    expect(actionEvent).toBeDefined();
    const switched = await setApplicationAttention(application.id, {
      mode: "WAITING",
      review: { kind: "TIMED", startsAtMs: Date.now() + 120_000 },
    });
    expect(switched.attentionMode).toBe("WAITING");
    expect(switched.events.find((event) => event.id === actionEvent!.id)?.status).toBe("CANCELLED");
  });

  it("writes stage, archive and restore changes with timeline in the same transactions", async () => {
    const application = await createApplication({ companyName: "流程公司", positionTitle: "测试工程师" });
    const actionable = await setApplicationAttention(application.id, {
      mode: "ACTION",
      title: "提交作业",
      due: { kind: "TIMED", startsAtMs: Date.now() + 60_000 },
    });
    const actionEvent = actionable.events.find((event) => event.type === "ACTION_DUE");
    const interview = await createEvent({
      applicationId: application.id,
      type: "INTERVIEW",
      title: "业务面",
      schedule: { kind: "TIMED", startsAtMs: Date.now() + 3_600_000 },
    });
    const staged = await setApplicationStage(application.id, "INTERVIEWING");
    expect(staged.stage).toBe("INTERVIEWING");
    expect(staged.timeline[0].entryType).toBe("STAGE_CHANGED");

    const archived = await archiveApplication(application.id, {
      reason: "REJECTED",
      expectedVersion: staged.version,
    });
    expect(archived).toMatchObject({ stage: "ARCHIVED", attentionMode: "INACTIVE", isArchived: true });
    expect(archived.events.find((event) => event.id === actionEvent!.id)?.status).toBe("SCHEDULED");
    expect(archived.events.find((event) => event.id === interview.id)?.status).toBe("SCHEDULED");
    expect((await listApplications())).toHaveLength(0);
    expect((await listApplications({ includeArchived: true }))).toHaveLength(1);
    expect(await listCalendarEvents()).toHaveLength(0);

    const restored = await restoreApplication(application.id, {
      stage: "PREPARING",
      expectedVersion: archived.version,
    });
    expect(restored).toMatchObject({ stage: "PREPARING", attentionMode: "NEEDS_ACTION", isArchived: false });
    expect(restored.events.find((event) => event.id === actionEvent!.id)?.status).toBe("SCHEDULED");
    expect(restored.events.find((event) => event.id === interview.id)?.status).toBe("SCHEDULED");
    expect((await listCalendarEvents()).map((event) => event.id)).toEqual(
      expect.arrayContaining([actionEvent!.id, interview.id]),
    );
    expect(restored.timeline.map((entry) => entry.entryType)).toEqual(
      expect.arrayContaining(["ARCHIVED", "RESTORED", "ATTENTION_CHANGED"]),
    );
  });

  it("rejects schedule conflicts without writes and allows an explicit retry", async () => {
    const application = await createApplication({ companyName: "日程公司", positionTitle: "数据工程师" });
    const startsAtMs = Date.now() + 3_600_000;
    await createEvent({
      applicationId: application.id,
      type: "INTERVIEW",
      title: "技术一面",
      schedule: { kind: "TIMED", startsAtMs, endsAtMs: startsAtMs + 3_600_000 },
    });
    await expect(
      createEvent({
        applicationId: application.id,
        type: "WRITTEN_TEST",
        title: "笔试",
        schedule: { kind: "TIMED", startsAtMs: startsAtMs + 1_000 },
      }),
    ).rejects.toMatchObject({ code: "EVENT_CONFLICT_CONFIRMATION_REQUIRED" });
    expect(await listCalendarEvents()).toHaveLength(1);

    await createEvent({
      applicationId: application.id,
      type: "WRITTEN_TEST",
      title: "笔试",
      schedule: { kind: "TIMED", startsAtMs: startsAtMs + 1_000 },
      allowConflicts: true,
    });
    expect(await listCalendarEvents()).toHaveLength(2);
    expect((await getTodayDashboard()).counts.conflictPairs).toBe(1);
  });

  it("rolls back update and timeline together on optimistic version conflicts", async () => {
    const application = await createApplication({ companyName: "并发公司", positionTitle: "开发工程师" });
    const staged = await setApplicationStage(application.id, "APPLIED", application.version);
    const before = await getApplicationDetail(application.id);
    await expect(
      updateApplication(application.id, { notesMarkdown: "不应保存", expectedVersion: application.version }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const after = await getApplicationDetail(application.id);
    expect(after?.notesMarkdown).toBeNull();
    expect(after?.timeline).toHaveLength(before!.timeline.length);
    expect(after?.version).toBe(staged.version);
  });

  it("preserves multiline Markdown notes exactly across persistence", async () => {
    const application = await createApplication({ companyName: "备注公司", positionTitle: "前端工程师" });
    const notesMarkdown = "  面试重点\n\n- React\n  - 并发渲染  \n\n```ts\nconst answer = 42;\n```";

    await updateApplication(application.id, {
      notesMarkdown,
      expectedVersion: application.version,
    });

    expect((await getApplicationDetail(application.id))?.notesMarkdown).toBe(notesMarkdown);
  });

  it("increments event versions when an application label used by ICS changes", async () => {
    const application = await createApplication({ companyName: "旧公司", positionTitle: "旧岗位" });
    const createdEvent = await createEvent({
      applicationId: application.id,
      type: "INTERVIEW",
      title: "技术面试",
      schedule: { kind: "TIMED", startsAtMs: Date.now() + 3_600_000 },
    });
    const beforeUpdate = await getApplicationDetail(application.id);

    const updated = await updateApplication(application.id, {
      companyName: "新公司",
      positionTitle: "新岗位",
      expectedVersion: beforeUpdate!.version,
    });

    expect(updated.companyName).toBe("新公司");
    expect(updated.positionTitle).toBe("新岗位");
    expect(updated.events.find((event) => event.id === createdEvent.id)?.version).toBe(
      createdEvent.version + 1,
    );
  });
});
