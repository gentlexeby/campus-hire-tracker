import { createClient, type Client } from "@libsql/client/node";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { defaultTimezone, DomainError } from "@/lib/domain";
import { publishPreparedInitialFile } from "@/lib/db/atomic-file";
import * as schema from "@/lib/db/schema";

export const DATABASE_SCHEMA_VERSION = 2;
export const DEFAULT_WORKSPACE_ID = "default-workspace";

export interface ActiveRuntimePointer {
  formatVersion: 1;
  releaseId: string;
  generationId: string;
  activatedAt: string;
}

export interface DatabaseContext {
  client: Client;
  db: LibSQLDatabase<typeof schema>;
  dataRoot: string;
  generationId: string;
  databasePath: string;
  workspaceId: string;
}

const RESUME_TABLES_SQL = `
CREATE TABLE resumes (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  target_direction TEXT,
  language TEXT,
  archived_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX resumes_workspace_archive_idx
  ON resumes(workspace_id, archived_at_ms, updated_at_ms);

CREATE TABLE resume_versions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resume_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK(version_number > 0),
  source_docx_original_name TEXT,
  source_docx_relative_path TEXT,
  source_docx_mime_type TEXT,
  source_docx_size_bytes INTEGER,
  source_docx_sha256 TEXT,
  delivery_pdf_original_name TEXT,
  delivery_pdf_relative_path TEXT,
  delivery_pdf_mime_type TEXT,
  delivery_pdf_size_bytes INTEGER,
  delivery_pdf_sha256 TEXT,
  change_summary TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(resume_id, version_number),
  FOREIGN KEY(resume_id) REFERENCES resumes(id) ON DELETE RESTRICT,
  CHECK(
    (source_docx_original_name IS NULL) = (source_docx_relative_path IS NULL) AND
    (source_docx_original_name IS NULL) = (source_docx_mime_type IS NULL) AND
    (source_docx_original_name IS NULL) = (source_docx_size_bytes IS NULL) AND
    (source_docx_original_name IS NULL) = (source_docx_sha256 IS NULL)
  ),
  CHECK(
    (delivery_pdf_original_name IS NULL) = (delivery_pdf_relative_path IS NULL) AND
    (delivery_pdf_original_name IS NULL) = (delivery_pdf_mime_type IS NULL) AND
    (delivery_pdf_original_name IS NULL) = (delivery_pdf_size_bytes IS NULL) AND
    (delivery_pdf_original_name IS NULL) = (delivery_pdf_sha256 IS NULL)
  ),
  CHECK(source_docx_relative_path IS NOT NULL OR delivery_pdf_relative_path IS NOT NULL)
);
`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) > 0),
  locale TEXT NOT NULL,
  timezone TEXT NOT NULL CHECK(length(trim(timezone)) > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0)
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  theme TEXT NOT NULL CHECK(theme IN ('SYSTEM','LIGHT','DARK')),
  last_application_view TEXT NOT NULL CHECK(last_application_view IN ('BOARD','TABLE')),
  week_starts_on INTEGER NOT NULL CHECK(week_starts_on BETWEEN 0 AND 6),
  browser_notifications_enabled INTEGER NOT NULL CHECK(browser_notifications_enabled IN (0,1)),
  daily_backup_retention INTEGER NOT NULL CHECK(daily_backup_retention BETWEEN 1 AND 365),
  trash_retention_days INTEGER NOT NULL CHECK(trash_retention_days = 30),
  onboarding_completed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0)
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  normalized_name TEXT NOT NULL CHECK(length(normalized_name) > 0),
  website_url TEXT,
  notes_markdown TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0 CHECK(is_sample IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  deleted_at_ms INTEGER,
  UNIQUE(workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_active_name_uq
  ON companies(workspace_id, normalized_name) WHERE deleted_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  normalized_title TEXT NOT NULL CHECK(length(normalized_title) > 0),
  department TEXT,
  location TEXT,
  work_mode TEXT NOT NULL CHECK(work_mode IN ('UNSPECIFIED','ONSITE','HYBRID','REMOTE')),
  job_url TEXT,
  notes_markdown TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0 CHECK(is_sample IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  deleted_at_ms INTEGER,
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, company_id) REFERENCES companies(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS positions_match_idx
  ON positions(workspace_id, company_id, normalized_title, location, deleted_at_ms);

${RESUME_TABLES_SQL}

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position_id TEXT NOT NULL,
  cycle_label TEXT,
  normalized_cycle_label TEXT,
  stage TEXT NOT NULL CHECK(stage IN ('OPPORTUNITY_POOL','PREPARING','APPLIED','ASSESSMENT','INTERVIEWING','OFFER','ARCHIVED')),
  priority TEXT NOT NULL CHECK(priority IN ('HIGH','MEDIUM','LOW')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('UNSPECIFIED','OFFICIAL_SITE','JOB_PLATFORM','REFERRAL','RECRUITMENT_FAIR','CAMPUS_CHANNEL','CUSTOM')),
  source_detail TEXT,
  source_url TEXT,
  source_fair_id TEXT,
  resume_version_id TEXT REFERENCES resume_versions(id) ON DELETE RESTRICT,
  attention_mode TEXT NOT NULL CHECK(attention_mode IN ('ACTION','WAITING','NEEDS_ACTION','INACTIVE')),
  next_action_title TEXT,
  current_action_event_id TEXT,
  waiting_for TEXT,
  waiting_review_event_id TEXT,
  applied_at_ms INTEGER,
  offer_at_ms INTEGER,
  archived_at_ms INTEGER,
  archived_from_stage TEXT,
  archive_reason TEXT,
  archive_note TEXT,
  notes_markdown TEXT,
  last_activity_at_ms INTEGER NOT NULL,
  is_sample INTEGER NOT NULL DEFAULT 0 CHECK(is_sample IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  deleted_at_ms INTEGER,
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, position_id) REFERENCES positions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, current_action_event_id) REFERENCES events(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id, waiting_review_event_id) REFERENCES events(workspace_id, id) ON DELETE RESTRICT,
  CHECK(
    (attention_mode = 'ACTION' AND stage <> 'ARCHIVED' AND length(trim(next_action_title)) > 0
      AND waiting_for IS NULL AND waiting_review_event_id IS NULL)
    OR (attention_mode = 'WAITING' AND stage <> 'ARCHIVED' AND next_action_title IS NULL
      AND current_action_event_id IS NULL AND waiting_review_event_id IS NOT NULL
      AND (waiting_for IS NULL OR length(trim(waiting_for)) > 0))
    OR (attention_mode = 'NEEDS_ACTION' AND stage <> 'ARCHIVED' AND next_action_title IS NULL
      AND current_action_event_id IS NULL AND waiting_for IS NULL AND waiting_review_event_id IS NULL)
    OR (attention_mode = 'INACTIVE' AND stage = 'ARCHIVED' AND next_action_title IS NULL
      AND current_action_event_id IS NULL AND waiting_for IS NULL AND waiting_review_event_id IS NULL)
  ),
  CHECK(
    (stage = 'ARCHIVED' AND archived_at_ms IS NOT NULL
      AND archived_from_stage IN ('OPPORTUNITY_POOL','PREPARING','APPLIED','ASSESSMENT','INTERVIEWING','OFFER')
      AND archive_reason IN ('REJECTED','ABANDONED','WITHDRAWN','OTHER')
      AND (archive_reason <> 'OTHER' OR length(trim(archive_note)) > 0))
    OR (stage <> 'ARCHIVED' AND archived_at_ms IS NULL AND archived_from_stage IS NULL
      AND archive_reason IS NULL AND archive_note IS NULL)
  ),
  CHECK(
    (source_kind = 'CUSTOM' AND length(trim(source_detail)) > 0 AND source_fair_id IS NULL)
    OR (source_kind = 'RECRUITMENT_FAIR' AND source_detail IS NULL AND source_fair_id IS NOT NULL)
    OR (source_kind NOT IN ('CUSTOM','RECRUITMENT_FAIR') AND source_detail IS NULL AND source_fair_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS applications_stage_idx ON applications(workspace_id, stage, deleted_at_ms);
CREATE INDEX IF NOT EXISTS applications_attention_idx ON applications(workspace_id, attention_mode, deleted_at_ms);
CREATE INDEX IF NOT EXISTS applications_duplicate_idx ON applications(workspace_id, position_id, normalized_cycle_label, deleted_at_ms);
CREATE INDEX IF NOT EXISTS applications_priority_idx ON applications(workspace_id, priority, last_activity_at_ms);
CREATE INDEX IF NOT EXISTS applications_resume_version_idx ON applications(workspace_id, resume_version_id);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  normalized_name TEXT NOT NULL CHECK(length(normalized_name) > 0),
  color_token TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  deleted_at_ms INTEGER,
  UNIQUE(workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_active_name_uq
  ON tags(workspace_id, normalized_name) WHERE deleted_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS application_tags (
  workspace_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, application_id, tag_id),
  FOREIGN KEY(workspace_id, application_id) REFERENCES applications(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id, tag_id) REFERENCES tags(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('INTERVIEW','ASSESSMENT','WRITTEN_TEST','APPLICATION_DEADLINE','ACTION_DUE','FOLLOW_UP','OTHER')),
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  status TEXT NOT NULL CHECK(status IN ('SCHEDULED','COMPLETED','CANCELLED')),
  is_all_day INTEGER NOT NULL CHECK(is_all_day IN (0,1)),
  starts_at_ms INTEGER,
  ends_at_ms INTEGER,
  all_day_start_date TEXT,
  all_day_end_date_exclusive TEXT,
  timezone TEXT NOT NULL CHECK(length(trim(timezone)) > 0),
  location TEXT,
  meeting_url TEXT,
  notes_markdown TEXT,
  is_hard_deadline INTEGER NOT NULL DEFAULT 0 CHECK(is_hard_deadline IN (0,1)),
  completed_at_ms INTEGER,
  ics_uid TEXT NOT NULL,
  is_sample INTEGER NOT NULL DEFAULT 0 CHECK(is_sample IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  deleted_at_ms INTEGER,
  UNIQUE(workspace_id, id),
  UNIQUE(workspace_id, ics_uid),
  FOREIGN KEY(workspace_id, application_id) REFERENCES applications(workspace_id, id) ON DELETE CASCADE,
  CHECK(
    (is_all_day = 0 AND starts_at_ms IS NOT NULL AND (ends_at_ms IS NULL OR ends_at_ms > starts_at_ms)
      AND all_day_start_date IS NULL AND all_day_end_date_exclusive IS NULL)
    OR (is_all_day = 1 AND starts_at_ms IS NULL AND ends_at_ms IS NULL
      AND all_day_start_date IS NOT NULL AND all_day_end_date_exclusive > all_day_start_date)
  ),
  CHECK(
    (status = 'COMPLETED' AND completed_at_ms IS NOT NULL)
    OR (status IN ('SCHEDULED','CANCELLED') AND completed_at_ms IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS events_schedule_idx ON events(workspace_id, status, starts_at_ms, deleted_at_ms);
CREATE INDEX IF NOT EXISTS events_all_day_idx ON events(workspace_id, all_day_start_date, deleted_at_ms);
CREATE INDEX IF NOT EXISTS events_application_idx ON events(workspace_id, application_id, type, deleted_at_ms);

CREATE TRIGGER IF NOT EXISTS applications_action_reference_insert
BEFORE INSERT ON applications
WHEN NEW.current_action_event_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.workspace_id = NEW.workspace_id AND e.id = NEW.current_action_event_id
    AND e.application_id = NEW.id AND e.type = 'ACTION_DUE'
    AND e.status = 'SCHEDULED' AND e.deleted_at_ms IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid current action event');
END;

CREATE TRIGGER IF NOT EXISTS applications_action_reference_update
BEFORE UPDATE OF current_action_event_id, attention_mode ON applications
WHEN NEW.current_action_event_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.workspace_id = NEW.workspace_id AND e.id = NEW.current_action_event_id
    AND e.application_id = NEW.id AND e.type = 'ACTION_DUE'
    AND e.status = 'SCHEDULED' AND e.deleted_at_ms IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid current action event');
END;

CREATE TRIGGER IF NOT EXISTS applications_waiting_reference_insert
BEFORE INSERT ON applications
WHEN NEW.waiting_review_event_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.workspace_id = NEW.workspace_id AND e.id = NEW.waiting_review_event_id
    AND e.application_id = NEW.id AND e.type = 'FOLLOW_UP'
    AND e.status = 'SCHEDULED' AND e.deleted_at_ms IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid waiting review event');
END;

CREATE TRIGGER IF NOT EXISTS applications_waiting_reference_update
BEFORE UPDATE OF waiting_review_event_id, attention_mode ON applications
WHEN NEW.waiting_review_event_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.workspace_id = NEW.workspace_id AND e.id = NEW.waiting_review_event_id
    AND e.application_id = NEW.id AND e.type = 'FOLLOW_UP'
    AND e.status = 'SCHEDULED' AND e.deleted_at_ms IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid waiting review event');
END;

CREATE TRIGGER IF NOT EXISTS events_protect_attention_reference
BEFORE UPDATE OF application_id, type, status, deleted_at_ms ON events
WHEN EXISTS (
  SELECT 1 FROM applications a
  WHERE a.workspace_id = OLD.workspace_id
    AND (a.current_action_event_id = OLD.id OR a.waiting_review_event_id = OLD.id)
    AND (
      NEW.workspace_id <> a.workspace_id OR NEW.application_id <> a.id
      OR NEW.status <> 'SCHEDULED' OR NEW.deleted_at_ms IS NOT NULL
      OR (a.current_action_event_id = OLD.id AND NEW.type <> 'ACTION_DUE')
      OR (a.waiting_review_event_id = OLD.id AND NEW.type <> 'FOLLOW_UP')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'event is an active attention reference');
END;

CREATE TABLE IF NOT EXISTS timeline_entries (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('USER','SYSTEM','IMPORT')),
  happened_at_ms INTEGER NOT NULL,
  summary TEXT NOT NULL CHECK(length(trim(summary)) > 0),
  details_json TEXT,
  source_entity_type TEXT,
  source_entity_id TEXT,
  correlation_id TEXT NOT NULL,
  reverts_entry_id TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, application_id) REFERENCES applications(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id, reverts_entry_id) REFERENCES timeline_entries(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS timeline_application_idx
  ON timeline_entries(workspace_id, application_id, happened_at_ms DESC, id);

`;

const REQUIRED_SCHEMA_V1_TABLES = [
  "workspaces",
  "workspace_settings",
  "companies",
  "positions",
  "applications",
  "tags",
  "application_tags",
  "events",
  "timeline_entries",
] as const;

const REQUIRED_TABLES = [
  ...REQUIRED_SCHEMA_V1_TABLES,
  "resumes",
  "resume_versions",
] as const;

async function migrateSchemaVersion1To2(client: Client): Promise<void> {
  const transaction = await client.transaction("write");
  try {
    await transaction.executeMultiple(RESUME_TABLES_SQL);
    await transaction.execute(
      "ALTER TABLE applications ADD COLUMN resume_version_id TEXT REFERENCES resume_versions(id) ON DELETE RESTRICT",
    );
    await transaction.execute(
      "CREATE INDEX applications_resume_version_idx ON applications(workspace_id, resume_version_id)",
    );
    await transaction.execute(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

const contexts = new Map<string, Promise<DatabaseContext>>();

export function getDataRoot(): string {
  const override = process.env.CAMPUS_HIRE_TRACKER_DATA_DIR?.trim();
  if (override) return path.resolve(override);

  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) return path.join(localAppData, "CampusHireTracker");

  return path.join(os.homedir(), ".local", "share", "CampusHireTracker");
}

function safePointer(value: unknown): ActiveRuntimePointer | null {
  if (!value || typeof value !== "object") return null;
  const pointer = value as Record<string, unknown>;
  if (
    pointer.formatVersion !== 1 ||
    typeof pointer.releaseId !== "string" ||
    typeof pointer.generationId !== "string" ||
    typeof pointer.activatedAt !== "string" ||
    Number.isNaN(Date.parse(pointer.activatedAt))
  ) return null;
  const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  if (!safeSegment.test(pointer.releaseId) || !safeSegment.test(pointer.generationId)) return null;
  return {
    formatVersion: 1,
    releaseId: pointer.releaseId,
    generationId: pointer.generationId,
    activatedAt: pointer.activatedAt,
  };
}

async function readOrCreateActivePointer(dataRoot: string): Promise<ActiveRuntimePointer> {
  const runtimeDirectory = path.join(dataRoot, "runtime");
  const storesDirectory = path.join(dataRoot, "stores");
  const releasesDirectory = path.join(runtimeDirectory, "releases");
  const activePath = path.join(runtimeDirectory, "active.json");
  await mkdir(runtimeDirectory, { recursive: true });
  await mkdir(storesDirectory, { recursive: true });
  await mkdir(releasesDirectory, { recursive: true });

  try {
    const parsed = safePointer(JSON.parse(await readFile(activePath, "utf8")));
    if (!parsed) throw new DomainError("DATA_INITIALIZATION_FAILED", "本地数据指针无效，请运行恢复工具");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const pointer: ActiveRuntimePointer = {
    formatVersion: 1,
    releaseId: "development",
    generationId: `gen-${Date.now()}-${randomUUID()}`,
    activatedAt: new Date().toISOString(),
  };
  await mkdir(path.join(releasesDirectory, pointer.releaseId), { recursive: true });
  await mkdir(path.join(storesDirectory, pointer.generationId, "attachments"), { recursive: true });

  const temporaryPath = `${activePath}.tmp-${process.pid}-${randomUUID()}`;
  const serializedPointer = `${JSON.stringify(pointer, null, 2)}\n`;
  await writeFile(temporaryPath, serializedPointer, {
    encoding: "utf8",
    flag: "wx",
    flush: true,
  });
  // A hard link publishes the already-flushed inode in one directory operation and avoids
  // a Windows runtime that can report EXDEV for a same-directory rename.
  const result = await publishPreparedInitialFile(
    temporaryPath,
    activePath,
    serializedPointer,
  );
  if (result === "exists") {
    const parsed = safePointer(JSON.parse(await readFile(activePath, "utf8")));
    if (!parsed) throw new DomainError("DATA_INITIALIZATION_FAILED", "本地数据指针无效，请运行恢复工具");
    return parsed;
  }
  return pointer;
}

function databaseUrl(databasePath: string): string {
  return `file:${databasePath.replace(/\\/g, "/")}`;
}

async function initializeDatabase(dataRoot: string): Promise<DatabaseContext> {
  // Windows Store/AppContainer can transparently redirect LocalAppData to another volume.
  // Resolve the existing root first, then derive every child path from the physical parent;
  // otherwise an existing temp file and a not-yet-existing target can resolve to different drives.
  await mkdir(dataRoot, { recursive: true });
  const canonicalDataRoot = await realpath(dataRoot);
  const pointer = await readOrCreateActivePointer(canonicalDataRoot);
  const generationDirectory = path.resolve(canonicalDataRoot, "stores", pointer.generationId);
  const storesDirectory = path.resolve(canonicalDataRoot, "stores");
  if (!generationDirectory.startsWith(`${storesDirectory}${path.sep}`)) {
    throw new DomainError("DATA_INITIALIZATION_FAILED", "本地数据目录不安全，请运行恢复工具");
  }
  await mkdir(path.join(generationDirectory, "attachments"), { recursive: true });

  const databasePath = path.join(generationDirectory, "app.db");
  const client = createClient({ url: databaseUrl(databasePath) });
  try {
    // This read is deliberately the first database statement. Never execute DDL or
    // rewrite user_version until the on-disk version has been classified.
    const versionResult = await client.execute("PRAGMA user_version");
    const existingVersion = Number(versionResult.rows[0]?.user_version ?? -1);
    if (!Number.isSafeInteger(existingVersion) || existingVersion < 0) {
      throw new DomainError("SCHEMA_INCOMPATIBLE", "无法识别本地数据版本，请使用兼容版本恢复");
    }
    if (existingVersion > DATABASE_SCHEMA_VERSION) {
      throw new DomainError("SCHEMA_INCOMPATIBLE", "本地数据由更新版本创建，请升级应用后再打开");
    }
    if (
      existingVersion !== 0 &&
      existingVersion !== 1 &&
      existingVersion !== DATABASE_SCHEMA_VERSION
    ) {
      throw new DomainError("SCHEMA_INCOMPATIBLE", "本地数据版本不受支持，请使用兼容版本恢复");
    }

    let isFreshDatabase = false;
    if (existingVersion === 0) {
      const existingTables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
      );
      if (existingTables.rows.length > 0) {
        throw new DomainError(
          "SCHEMA_INCOMPATIBLE",
          "检测到未标记版本的本地数据，已停止初始化以避免覆盖",
        );
      }
      isFreshDatabase = true;
    } else {
      const tableResult = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      );
      const presentTables = new Set(tableResult.rows.map((row) => String(row.name)));
      const expectedTables = existingVersion === 1 ? REQUIRED_SCHEMA_V1_TABLES : REQUIRED_TABLES;
      const missingTables = expectedTables.filter((table) => !presentTables.has(table));
      if (missingTables.length > 0) {
        throw new DomainError("SCHEMA_INCOMPATIBLE", "本地数据结构不完整，请使用恢复工具检查");
      }
    }

    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA synchronous = FULL");
    await client.execute("PRAGMA busy_timeout = 5000");
    if (isFreshDatabase) {
      await client.executeMultiple(SCHEMA_SQL);
      await client.execute(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);

      const now = Date.now();
      await client.batch(
        [
          {
            sql: `INSERT INTO workspaces
              (id, display_name, locale, timezone, created_at_ms, updated_at_ms, version)
              VALUES (?, ?, ?, ?, ?, ?, 1)`,
            args: [DEFAULT_WORKSPACE_ID, "我的秋招", "zh-CN", defaultTimezone(), now, now],
          },
          {
            sql: `INSERT INTO workspace_settings
              (workspace_id, theme, last_application_view, week_starts_on,
               browser_notifications_enabled, daily_backup_retention, trash_retention_days,
               onboarding_completed_at_ms, created_at_ms, updated_at_ms, version)
              VALUES (?, 'SYSTEM', 'BOARD', 1, 0, 14, 30, NULL, ?, ?, 1)`,
            args: [DEFAULT_WORKSPACE_ID, now, now],
          },
        ],
        "write",
      );
    } else if (existingVersion === 1) {
      await migrateSchemaVersion1To2(client);
    }

    const db = drizzle(client, { schema });
    const workspace = await db
      .select({ id: schema.workspaces.id, settingsWorkspaceId: schema.workspaceSettings.workspaceId })
      .from(schema.workspaces)
      .innerJoin(
        schema.workspaceSettings,
        eq(schema.workspaceSettings.workspaceId, schema.workspaces.id),
      )
      .where(eq(schema.workspaces.id, DEFAULT_WORKSPACE_ID))
      .limit(1);
    if (!workspace[0]) throw new DomainError("DATA_INITIALIZATION_FAILED", "本地工作区初始化失败");

    return {
      client,
      db,
      dataRoot: canonicalDataRoot,
      generationId: pointer.generationId,
      databasePath,
      workspaceId: DEFAULT_WORKSPACE_ID,
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function getDatabaseContext(): Promise<DatabaseContext> {
  const dataRoot = getDataRoot();
  let context = contexts.get(dataRoot);
  if (!context) {
    context = initializeDatabase(dataRoot).catch((error) => {
      contexts.delete(dataRoot);
      throw error;
    });
    contexts.set(dataRoot, context);
  }
  return context;
}

export async function closeDatabaseConnectionsForTests(): Promise<void> {
  const pending = [...contexts.values()];
  contexts.clear();
  const settled = await Promise.allSettled(pending);
  for (const result of settled) {
    if (result.status === "fulfilled") result.value.client.close();
  }
}

export async function assertForeignKeysEnabled(): Promise<boolean> {
  const { client } = await getDatabaseContext();
  const result = await client.execute("PRAGMA foreign_keys");
  return Number(result.rows[0]?.foreign_keys ?? 0) === 1;
}

export async function readWorkspaceTimezone(): Promise<string> {
  const { db, workspaceId } = await getDatabaseContext();
  const rows = await db
    .select({ timezone: schema.workspaces.timezone })
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspaceId)))
    .limit(1);
  return rows[0]?.timezone ?? "Asia/Shanghai";
}
