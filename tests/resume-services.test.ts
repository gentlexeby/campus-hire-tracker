import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabaseConnectionsForTests, getDatabaseContext } from "@/lib/db/client";
import {
  RESUME_DELIVERY_PDF_MIME_TYPE,
  RESUME_SOURCE_DOCX_MIME_TYPE,
} from "@/lib/domain";
import {
  addResumeVersion,
  createApplication,
  createResumeWithVersion,
  getApplicationDetail,
  getResumeDetail,
  listResumes,
  setApplicationResumeVersion,
  setResumeArchived,
} from "@/lib/services";

const SHA256 = "a".repeat(64);
let dataRoot = "";

function sourceDocx(originalName = "校招简历.docx") {
  return {
    originalName,
    relativePath: `${randomUUID()}.docx`,
    mimeType: RESUME_SOURCE_DOCX_MIME_TYPE,
    sizeBytes: 1_024,
    sha256: SHA256,
  } as const;
}

function deliveryPdf(originalName = "校招简历.pdf") {
  return {
    originalName,
    relativePath: `${randomUUID()}.pdf`,
    mimeType: RESUME_DELIVERY_PDF_MIME_TYPE,
    sizeBytes: 2_048,
    sha256: SHA256,
  } as const;
}

describe("resume services", () => {
  beforeAll(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "campus-hire-resume-services-"));
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
    const cleanupScript = `
      const fs = require('node:fs');
      const target = process.argv[1];
      if (!target || !/campus-hire-resume-services-[^\\\\/]+$/.test(target)) process.exit(2);
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

  it("creates the first version and assigns later version numbers automatically", async () => {
    const created = await createResumeWithVersion(
      { name: "  后端校招简历  ", targetDirection: "后端开发", language: "中文" },
      { sourceDocx: sourceDocx(), changeSummary: "首版" },
    );

    expect(created).toMatchObject({
      name: "后端校招简历",
      targetDirection: "后端开发",
      language: "中文",
      archivedAtMs: null,
      latestVersion: {
        versionNumber: 1,
        changeSummary: "首版",
        deliveryPdf: null,
      },
    });
    expect(created.versions.map((version) => version.versionNumber)).toEqual([1]);
    expect(created.versions[0]?.sourceDocx).toMatchObject({ originalName: "校招简历.docx" });

    const second = await addResumeVersion(created.id, {
      deliveryPdf: deliveryPdf("后端校招简历-v2.pdf"),
      changeSummary: "针对岗位描述调整",
    });
    const third = await addResumeVersion(created.id, {
      sourceDocx: sourceDocx("后端校招简历-v3.docx"),
      deliveryPdf: deliveryPdf("后端校招简历-v3.pdf"),
      changeSummary: "补充项目数据",
    });

    expect(second.versionNumber).toBe(2);
    expect(third.versionNumber).toBe(3);
    const detail = await getResumeDetail(created.id);
    expect(detail?.versions.map((version) => version.versionNumber)).toEqual([3, 2, 1]);
    expect(detail?.latestVersion?.id).toBe(third.id);
  });

  it("links only a PDF version to an application and records the timeline", async () => {
    const resume = await createResumeWithVersion(
      { name: "产品岗位简历" },
      { sourceDocx: sourceDocx(), changeSummary: "可编辑源文件" },
    );
    const application = await createApplication({
      companyName: "示例产品公司",
      positionTitle: "产品经理",
    });
    const sourceOnlyVersion = resume.versions[0]!;
    const beforeRejectedLink = await getApplicationDetail(application.id);

    await expect(
      setApplicationResumeVersion(application.id, sourceOnlyVersion.id),
    ).rejects.toMatchObject({ code: "RESUME_VERSION_NOT_LINKABLE" });
    const afterRejectedLink = await getApplicationDetail(application.id);
    expect(afterRejectedLink).toMatchObject({
      resumeVersionId: null,
      version: beforeRejectedLink?.version,
    });
    expect(afterRejectedLink?.timeline).toHaveLength(beforeRejectedLink?.timeline.length ?? 0);

    const deliveryVersion = await addResumeVersion(resume.id, {
      deliveryPdf: deliveryPdf("产品岗位简历.pdf"),
      changeSummary: "投递版",
    });
    const linked = await setApplicationResumeVersion(
      application.id,
      deliveryVersion.id,
      afterRejectedLink?.version,
    );

    expect(linked.resumeVersionId).toBe(deliveryVersion.id);
    expect(linked.version).toBe((afterRejectedLink?.version ?? 0) + 1);
    const timelineEntry = linked.timeline.find((entry) => entry.entryType === "RESUME_LINKED");
    expect(timelineEntry).toMatchObject({
      actorKind: "USER",
      summary: "关联投递简历：产品岗位简历 · V2",
      sourceEntityType: "RESUME_VERSION",
      sourceEntityId: deliveryVersion.id,
      details: {
        schemaVersion: 1,
        before: null,
        after: deliveryVersion.id,
      },
    });
  });

  it("blocks new changes after archiving while preserving an existing application link", async () => {
    const resume = await createResumeWithVersion(
      { name: "算法岗位简历" },
      { deliveryPdf: deliveryPdf("算法岗位简历.pdf"), changeSummary: "投递版" },
    );
    const deliveryVersion = resume.versions[0]!;
    const linkedApplication = await createApplication({
      companyName: "已投递公司",
      positionTitle: "算法工程师",
    });
    const newApplication = await createApplication({
      companyName: "待投递公司",
      positionTitle: "机器学习工程师",
    });
    await setApplicationResumeVersion(linkedApplication.id, deliveryVersion.id);

    const archived = await setResumeArchived(resume.id, true);
    expect(archived.archivedAtMs).not.toBeNull();
    await expect(
      addResumeVersion(resume.id, { sourceDocx: sourceDocx("归档后.docx") }),
    ).rejects.toMatchObject({ code: "RESUME_ARCHIVED" });
    await expect(
      setApplicationResumeVersion(newApplication.id, deliveryVersion.id),
    ).rejects.toMatchObject({ code: "RESUME_VERSION_NOT_LINKABLE" });

    expect((await getApplicationDetail(linkedApplication.id))?.resumeVersionId).toBe(
      deliveryVersion.id,
    );
    expect((await getApplicationDetail(newApplication.id))?.resumeVersionId).toBeNull();
    expect((await getResumeDetail(resume.id))?.versions).toHaveLength(1);
    expect(await listResumes()).toEqual([]);
    expect(await listResumes({ includeArchived: true })).toHaveLength(1);
  });
});
