import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  like,
  ne,
  or,
  sql,
} from "drizzle-orm";

import {
  activeApplicationStageSchema,
  applicationAttentionSchema,
  archiveApplicationInputSchema,
  createApplicationInputSchema,
  createEventInputSchema,
  defaultTimezone,
  DomainError,
  normalizeLookupText,
  normalizeOptionalMarkdown,
  normalizeOptionalText,
  parseDomainInput,
  restoreApplicationInputSchema,
  updateApplicationInputSchema,
  updateEventInputSchema,
  updateEventStatusInputSchema,
  type ActiveApplicationStage,
  type ApplicationAttentionInput,
  type ApplicationSource,
  type ApplicationStage,
  type ArchiveApplicationInput,
  type ArchiveReason,
  type AttentionMode,
  type CreateApplicationInput,
  type CreateEventInput,
  type EventScheduleInput,
  type EventStatus,
  type EventType,
  type Priority,
  type RestoreApplicationInput,
  type UpdateApplicationInput,
  type UpdateEventInput,
  type UpdateEventStatusInput,
  type WorkMode,
} from "@/lib/domain";
import {
  DATABASE_SCHEMA_VERSION,
  getDatabaseContext,
  type DatabaseContext,
} from "@/lib/db/client";
import {
  applications,
  applicationTags,
  companies,
  events,
  positions,
  tags,
  timelineEntries,
  workspaces,
  workspaceSettings,
  type ApplicationRow,
  type EventRow,
} from "@/lib/db/schema";

export * from "@/lib/domain";

type AppDatabase = DatabaseContext["db"];
type TransactionCallback = Parameters<AppDatabase["transaction"]>[0];
type AppTransaction = Parameters<TransactionCallback>[0];

export interface TagDto {
  id: string;
  name: string;
  colorToken: string | null;
}

export interface EventDto {
  id: string;
  applicationId: string;
  type: EventType;
  title: string;
  status: EventStatus;
  schedule: EventScheduleInput;
  timezone: string;
  location: string | null;
  meetingUrl: string | null;
  notesMarkdown: string | null;
  isHardDeadline: boolean;
  completedAtMs: number | null;
  icsUid: string;
  createdAtMs: number;
  updatedAtMs: number;
  version: number;
}

export interface TimelineEntryDto {
  id: string;
  applicationId: string;
  entryType: string;
  actorKind: "USER" | "SYSTEM" | "IMPORT";
  happenedAtMs: number;
  summary: string;
  details: unknown | null;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  correlationId: string;
  createdAtMs: number;
}

export interface ApplicationSummary {
  id: string;
  companyId: string;
  companyName: string;
  positionId: string;
  positionTitle: string;
  cycleLabel: string | null;
  stage: ApplicationStage;
  priority: Priority;
  sourceKind: ApplicationSource;
  sourceDetail: string | null;
  attentionMode: AttentionMode;
  nextActionTitle: string | null;
  waitingFor: string | null;
  attentionAtMs: number | null;
  attentionDate: string | null;
  nextEvent: EventDto | null;
  tags: TagDto[];
  lastActivityAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  version: number;
  isArchived: boolean;
}

export interface ApplicationDetail extends ApplicationSummary {
  department: string | null;
  location: string | null;
  workMode: WorkMode;
  jobUrl: string | null;
  sourceUrl: string | null;
  notesMarkdown: string | null;
  appliedAtMs: number | null;
  offerAtMs: number | null;
  archivedAtMs: number | null;
  archivedFromStage: ActiveApplicationStage | null;
  archiveReason: ArchiveReason | null;
  archiveNote: string | null;
  events: EventDto[];
  timeline: TimelineEntryDto[];
}

export interface ListApplicationsOptions {
  includeArchived?: boolean;
  stage?: ApplicationStage | ApplicationStage[];
  priority?: Priority | Priority[];
  attentionMode?: AttentionMode | AttentionMode[];
  search?: string;
}

export interface CalendarEventsOptions {
  fromMs?: number;
  toMs?: number;
  status?: EventStatus | EventStatus[];
  applicationId?: string;
  includeArchived?: boolean;
}

export interface DashboardData {
  generatedAtMs: number;
  overdue: EventDto[];
  today: EventDto[];
  upcomingSevenDays: EventDto[];
  waitingReview: ApplicationSummary[];
  needsAction: ApplicationSummary[];
  conflicts: Array<{ first: EventDto; second: EventDto }>;
  counts: {
    activeApplications: number;
    archivedApplications: number;
    overdue: number;
    today: number;
    upcomingSevenDays: number;
    waitingReview: number;
    needsAction: number;
    conflictPairs: number;
  };
}

export interface WorkspaceSettingsDto {
  workspaceId: string;
  displayName: string;
  locale: string;
  timezone: string;
  theme: "SYSTEM" | "LIGHT" | "DARK";
  lastApplicationView: "BOARD" | "TABLE";
  weekStartsOn: number;
  onboardingCompletedAtMs: number | null;
  version: number;
}

export interface HealthStatus {
  status: "ok";
  appVersion: string;
  schemaVersion: number;
  schemaCompatible: true;
  databaseReadable: true;
  generationReady: true;
}

type JoinedApplicationRow = {
  application: ApplicationRow;
  position: typeof positions.$inferSelect;
  company: typeof companies.$inferSelect;
};

function cleanDetails(value: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: 1, ...value });
}

function parseDetails(value: string | null): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function scheduleColumns(schedule: EventScheduleInput) {
  if (schedule.kind === "TIMED") {
    return {
      isAllDay: 0,
      startsAtMs: schedule.startsAtMs,
      endsAtMs: schedule.endsAtMs ?? null,
      allDayStartDate: null,
      allDayEndDateExclusive: null,
    };
  }
  return {
    isAllDay: 1,
    startsAtMs: null,
    endsAtMs: null,
    allDayStartDate: schedule.startDate,
    allDayEndDateExclusive: schedule.endDateExclusive,
  };
}

function eventSchedule(row: EventRow): EventScheduleInput {
  if (row.isAllDay === 1) {
    return {
      kind: "ALL_DAY",
      startDate: row.allDayStartDate!,
      endDateExclusive: row.allDayEndDateExclusive!,
    };
  }
  return {
    kind: "TIMED",
    startsAtMs: row.startsAtMs!,
    endsAtMs: row.endsAtMs,
  };
}

function eventDto(row: EventRow): EventDto {
  return {
    id: row.id,
    applicationId: row.applicationId,
    type: row.type as EventType,
    title: row.title,
    status: row.status as EventStatus,
    schedule: eventSchedule(row),
    timezone: row.timezone,
    location: row.location,
    meetingUrl: row.meetingUrl,
    notesMarkdown: row.notesMarkdown,
    isHardDeadline: row.isHardDeadline === 1,
    completedAtMs: row.completedAtMs,
    icsUid: row.icsUid,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    version: row.version,
  };
}

function timelineDto(row: typeof timelineEntries.$inferSelect): TimelineEntryDto {
  return {
    id: row.id,
    applicationId: row.applicationId,
    entryType: row.entryType,
    actorKind: row.actorKind as TimelineEntryDto["actorKind"],
    happenedAtMs: row.happenedAtMs,
    summary: row.summary,
    details: parseDetails(row.detailsJson),
    sourceEntityType: row.sourceEntityType,
    sourceEntityId: row.sourceEntityId,
    correlationId: row.correlationId,
    createdAtMs: row.createdAtMs,
  };
}

function valueArray<T>(value: T | T[] | undefined): T[] | undefined {
  return value === undefined ? undefined : Array.isArray(value) ? value : [value];
}

function verifyVersion(row: { version: number }, expectedVersion: number | undefined) {
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw new DomainError("VERSION_CONFLICT", "这条记录已在其他页面更新，请刷新后重试");
  }
}

function requireCasUpdate(rows: readonly unknown[]) {
  if (rows.length !== 1) {
    throw new DomainError("VERSION_CONFLICT", "这条记录已在其他页面更新，请刷新后重试");
  }
}

async function insertTimeline(
  tx: AppTransaction,
  input: {
    workspaceId: string;
    applicationId: string;
    entryType: string;
    summary: string;
    details?: Record<string, unknown>;
    sourceEntityType?: string;
    sourceEntityId?: string;
    correlationId: string;
    happenedAtMs: number;
  },
) {
  await tx.insert(timelineEntries).values({
    id: randomUUID(),
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    entryType: input.entryType,
    actorKind: "USER",
    happenedAtMs: input.happenedAtMs,
    summary: input.summary,
    detailsJson: input.details ? cleanDetails(input.details) : null,
    sourceEntityType: input.sourceEntityType ?? null,
    sourceEntityId: input.sourceEntityId ?? null,
    correlationId: input.correlationId,
    revertsEntryId: null,
    createdAtMs: Date.now(),
  });
}

async function requireApplication(tx: AppTransaction, workspaceId: string, id: string) {
  const rows = await tx
    .select()
    .from(applications)
    .where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, id), isNull(applications.deletedAtMs)))
    .limit(1);
  if (!rows[0]) throw new DomainError("APPLICATION_NOT_FOUND", "没有找到这条岗位申请");
  return rows[0];
}

async function cancelAttentionEvents(
  tx: AppTransaction,
  application: ApplicationRow,
  now: number,
) {
  const ids = [application.currentActionEventId, application.waitingReviewEventId].filter(
    (id): id is string => Boolean(id),
  );
  if (ids.length === 0) return;
  await tx
    .update(events)
    .set({ status: "CANCELLED", completedAtMs: null, updatedAtMs: now, version: sql`${events.version} + 1` })
    .where(and(inArray(events.id, ids), eq(events.status, "SCHEDULED")));
}

async function applyAttention(
  tx: AppTransaction,
  workspaceId: string,
  application: ApplicationRow,
  attentionInput: ApplicationAttentionInput,
  options: { now: number; correlationId: string; incrementVersion: boolean },
) {
  const attention = parseDomainInput(applicationAttentionSchema, attentionInput);
  if (application.stage === "ARCHIVED") {
    throw new DomainError("APPLICATION_ARCHIVED", "请先恢复归档申请，再设置下一步");
  }

  const cleared = await tx
    .update(applications)
    .set({
      attentionMode: "NEEDS_ACTION",
      nextActionTitle: null,
      currentActionEventId: null,
      waitingFor: null,
      waitingReviewEventId: null,
    })
    .where(
      and(
        eq(applications.workspaceId, workspaceId),
        eq(applications.id, application.id),
        eq(applications.version, application.version),
        isNull(applications.deletedAtMs),
      ),
    )
    .returning({ id: applications.id });
  requireCasUpdate(cleared);
  await cancelAttentionEvents(tx, application, options.now);

  let currentActionEventId: string | null = null;
  let waitingReviewEventId: string | null = null;
  let nextActionTitle: string | null = null;
  let waitingFor: string | null = null;

  if (attention.mode === "ACTION") {
    nextActionTitle = attention.title;
    if (attention.due) {
      currentActionEventId = randomUUID();
      await tx.insert(events).values({
        id: currentActionEventId,
        workspaceId,
        applicationId: application.id,
        type: "ACTION_DUE",
        title: attention.title,
        status: "SCHEDULED",
        ...scheduleColumns(attention.due),
        timezone: defaultTimezone(),
        location: null,
        meetingUrl: null,
        notesMarkdown: null,
        isHardDeadline: 0,
        completedAtMs: null,
        icsUid: `${currentActionEventId}@campus-hire-tracker.local`,
        isSample: 0,
        createdAtMs: options.now,
        updatedAtMs: options.now,
        version: 1,
        deletedAtMs: null,
      });
    }
  } else if (attention.mode === "WAITING") {
    waitingFor = normalizeOptionalText(attention.waitingFor);
    waitingReviewEventId = randomUUID();
    await tx.insert(events).values({
      id: waitingReviewEventId,
      workspaceId,
      applicationId: application.id,
      type: "FOLLOW_UP",
      title: waitingFor ? `复查：${waitingFor}` : "复查等待进展",
      status: "SCHEDULED",
      ...scheduleColumns(attention.review),
      timezone: defaultTimezone(),
      location: null,
      meetingUrl: null,
      notesMarkdown: null,
      isHardDeadline: 0,
      completedAtMs: null,
      icsUid: `${waitingReviewEventId}@campus-hire-tracker.local`,
      isSample: 0,
      createdAtMs: options.now,
      updatedAtMs: options.now,
      version: 1,
      deletedAtMs: null,
    });
  }

  const updated = await tx
    .update(applications)
    .set({
      attentionMode: attention.mode,
      nextActionTitle,
      currentActionEventId,
      waitingFor,
      waitingReviewEventId,
      lastActivityAtMs: options.now,
      updatedAtMs: options.now,
      ...(options.incrementVersion ? { version: sql`${applications.version} + 1` } : {}),
    })
    .where(
      and(
        eq(applications.workspaceId, workspaceId),
        eq(applications.id, application.id),
        eq(applications.version, application.version),
        isNull(applications.deletedAtMs),
      ),
    )
    .returning({ id: applications.id });
  requireCasUpdate(updated);

  await insertTimeline(tx, {
    workspaceId,
    applicationId: application.id,
    entryType: "ATTENTION_CHANGED",
    summary:
      attention.mode === "ACTION"
        ? `设置下一步：${attention.title}`
        : attention.mode === "WAITING"
          ? "进入等待中"
          : "标记为缺少下一步",
    details: { before: application.attentionMode, after: attention.mode },
    correlationId: options.correlationId,
    happenedAtMs: options.now,
  });
}

function dateAtTimezone(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function timezoneMidnight(date: string, timezone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const wantedUtc = Date.UTC(year, month - 1, day);
  let candidate = wantedUtc;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]),
    );
    const representedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    candidate += wantedUtc - representedAsUtc;
  }
  return candidate;
}

function nextIsoDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

type EventExtent = { point: true; at: number } | { point: false; start: number; end: number };

function eventExtent(event: EventDto): EventExtent {
  if (event.schedule.kind === "ALL_DAY") {
    return {
      point: false,
      start: timezoneMidnight(event.schedule.startDate, event.timezone),
      end: timezoneMidnight(event.schedule.endDateExclusive, event.timezone),
    };
  }
  if (event.schedule.endsAtMs == null) return { point: true, at: event.schedule.startsAtMs };
  return {
    point: false,
    start: event.schedule.startsAtMs,
    end: event.schedule.endsAtMs,
  };
}

export function eventsConflict(first: EventDto, second: EventDto): boolean {
  const a = eventExtent(first);
  const b = eventExtent(second);
  if (a.point && b.point) return a.at === b.at;
  if (a.point && !b.point) return b.start <= a.at && a.at < b.end;
  if (!a.point && b.point) return a.start <= b.at && b.at < a.end;
  if (!a.point && !b.point) return a.start < b.end && b.start < a.end;
  return false;
}

function eventSortValue(event: EventDto): number {
  return event.schedule.kind === "TIMED"
    ? event.schedule.startsAtMs
    : timezoneMidnight(event.schedule.startDate, event.timezone);
}

async function tagsByApplicationIds(db: AppDatabase, workspaceId: string, ids: string[]) {
  const grouped = new Map<string, TagDto[]>();
  if (ids.length === 0) return grouped;
  const rows = await db
    .select({
      applicationId: applicationTags.applicationId,
      id: tags.id,
      name: tags.name,
      colorToken: tags.colorToken,
    })
    .from(applicationTags)
    .innerJoin(tags, and(eq(tags.workspaceId, applicationTags.workspaceId), eq(tags.id, applicationTags.tagId)))
    .where(
      and(
        eq(applicationTags.workspaceId, workspaceId),
        inArray(applicationTags.applicationId, ids),
        isNull(tags.deletedAtMs),
      ),
    )
    .orderBy(asc(tags.name));
  for (const row of rows) {
    const list = grouped.get(row.applicationId) ?? [];
    list.push({ id: row.id, name: row.name, colorToken: row.colorToken });
    grouped.set(row.applicationId, list);
  }
  return grouped;
}

async function eventsByApplicationIds(db: AppDatabase, workspaceId: string, ids: string[]) {
  const grouped = new Map<string, EventDto[]>();
  if (ids.length === 0) return grouped;
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.workspaceId, workspaceId),
        inArray(events.applicationId, ids),
        isNull(events.deletedAtMs),
      ),
    );
  for (const row of rows) {
    const list = grouped.get(row.applicationId) ?? [];
    list.push(eventDto(row));
    grouped.set(row.applicationId, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => eventSortValue(a) - eventSortValue(b));
  return grouped;
}

function applicationSummary(
  row: JoinedApplicationRow,
  applicationEvents: EventDto[],
  applicationTagList: TagDto[],
): ApplicationSummary {
  const now = Date.now();
  const nextEvent =
    applicationEvents.find((event) => event.status === "SCHEDULED" && eventSortValue(event) >= now) ?? null;
  const attentionEvent = applicationEvents.find(
    (event) =>
      event.id === row.application.currentActionEventId || event.id === row.application.waitingReviewEventId,
  );
  return {
    id: row.application.id,
    companyId: row.company.id,
    companyName: row.company.name,
    positionId: row.position.id,
    positionTitle: row.position.title,
    cycleLabel: row.application.cycleLabel,
    stage: row.application.stage as ApplicationStage,
    priority: row.application.priority as Priority,
    sourceKind: row.application.sourceKind as ApplicationSource,
    sourceDetail: row.application.sourceDetail,
    attentionMode: row.application.attentionMode as AttentionMode,
    nextActionTitle: row.application.nextActionTitle,
    waitingFor: row.application.waitingFor,
    attentionAtMs:
      attentionEvent?.schedule.kind === "TIMED" ? attentionEvent.schedule.startsAtMs : null,
    attentionDate:
      attentionEvent?.schedule.kind === "ALL_DAY" ? attentionEvent.schedule.startDate : null,
    nextEvent,
    tags: applicationTagList,
    lastActivityAtMs: row.application.lastActivityAtMs,
    createdAtMs: row.application.createdAtMs,
    updatedAtMs: row.application.updatedAtMs,
    version: row.application.version,
    isArchived: row.application.stage === "ARCHIVED",
  };
}

export async function getHealthStatus(): Promise<HealthStatus> {
  const { client } = await getDatabaseContext();
  const result = await client.execute("SELECT 1 AS readable, (SELECT user_version FROM pragma_user_version) AS schema_version");
  if (Number(result.rows[0]?.readable) !== 1) {
    throw new DomainError("DATABASE_UNAVAILABLE", "本地数据库暂时不可用");
  }
  const schemaVersion = Number(result.rows[0]?.schema_version ?? 0);
  if (schemaVersion !== DATABASE_SCHEMA_VERSION) {
    throw new DomainError("SCHEMA_INCOMPATIBLE", "本地数据版本与应用不兼容");
  }
  return {
    status: "ok",
    appVersion: "0.1.0",
    schemaVersion,
    schemaCompatible: true,
    databaseReadable: true,
    generationReady: true,
  };
}

export async function getWorkspaceSettings(): Promise<WorkspaceSettingsDto> {
  const { db, workspaceId } = await getDatabaseContext();
  const rows = await db
    .select({ workspace: workspaces, settings: workspaceSettings })
    .from(workspaces)
    .innerJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new DomainError("WORKSPACE_NOT_FOUND", "本地工作区尚未初始化");
  return {
    workspaceId: row.workspace.id,
    displayName: row.workspace.displayName,
    locale: row.workspace.locale,
    timezone: row.workspace.timezone,
    theme: row.settings.theme as WorkspaceSettingsDto["theme"],
    lastApplicationView: row.settings.lastApplicationView as WorkspaceSettingsDto["lastApplicationView"],
    weekStartsOn: row.settings.weekStartsOn,
    onboardingCompletedAtMs: row.settings.onboardingCompletedAtMs,
    version: row.settings.version,
  };
}

export async function listApplications(options: ListApplicationsOptions = {}): Promise<ApplicationSummary[]> {
  const { db, workspaceId } = await getDatabaseContext();
  const conditions = [eq(applications.workspaceId, workspaceId), isNull(applications.deletedAtMs)];
  if (!options.includeArchived) conditions.push(ne(applications.stage, "ARCHIVED"));

  const stages = valueArray(options.stage);
  if (stages?.length) conditions.push(inArray(applications.stage, stages));
  const priorities = valueArray(options.priority);
  if (priorities?.length) conditions.push(inArray(applications.priority, priorities));
  const attentionModes = valueArray(options.attentionMode);
  if (attentionModes?.length) conditions.push(inArray(applications.attentionMode, attentionModes));
  const search = normalizeOptionalText(options.search);
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(like(companies.name, pattern), like(positions.title, pattern))!,
    );
  }

  const rows = await db
    .select({ application: applications, position: positions, company: companies })
    .from(applications)
    .innerJoin(
      positions,
      and(eq(positions.workspaceId, applications.workspaceId), eq(positions.id, applications.positionId)),
    )
    .innerJoin(
      companies,
      and(eq(companies.workspaceId, positions.workspaceId), eq(companies.id, positions.companyId)),
    )
    .where(and(...conditions))
    .orderBy(desc(applications.lastActivityAtMs), desc(applications.id));

  const ids = rows.map((row) => row.application.id);
  const [tagMap, eventMap] = await Promise.all([
    tagsByApplicationIds(db, workspaceId, ids),
    eventsByApplicationIds(db, workspaceId, ids),
  ]);
  return rows.map((row) =>
    applicationSummary(row, eventMap.get(row.application.id) ?? [], tagMap.get(row.application.id) ?? []),
  );
}

export async function getApplicationDetail(id: string): Promise<ApplicationDetail | null> {
  if (!zodUuid(id)) return null;
  const { db, workspaceId } = await getDatabaseContext();
  const rows = await db
    .select({ application: applications, position: positions, company: companies })
    .from(applications)
    .innerJoin(
      positions,
      and(eq(positions.workspaceId, applications.workspaceId), eq(positions.id, applications.positionId)),
    )
    .innerJoin(
      companies,
      and(eq(companies.workspaceId, positions.workspaceId), eq(companies.id, positions.companyId)),
    )
    .where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, id), isNull(applications.deletedAtMs)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const [tagMap, eventMap, timelineRows] = await Promise.all([
    tagsByApplicationIds(db, workspaceId, [id]),
    eventsByApplicationIds(db, workspaceId, [id]),
    db
      .select()
      .from(timelineEntries)
      .where(and(eq(timelineEntries.workspaceId, workspaceId), eq(timelineEntries.applicationId, id)))
      .orderBy(desc(timelineEntries.happenedAtMs), desc(timelineEntries.id)),
  ]);
  const applicationEvents = eventMap.get(id) ?? [];
  return {
    ...applicationSummary(row, applicationEvents, tagMap.get(id) ?? []),
    department: row.position.department,
    location: row.position.location,
    workMode: row.position.workMode as WorkMode,
    jobUrl: row.position.jobUrl,
    sourceUrl: row.application.sourceUrl,
    notesMarkdown: row.application.notesMarkdown,
    appliedAtMs: row.application.appliedAtMs,
    offerAtMs: row.application.offerAtMs,
    archivedAtMs: row.application.archivedAtMs,
    archivedFromStage: row.application.archivedFromStage as ActiveApplicationStage | null,
    archiveReason: row.application.archiveReason as ArchiveReason | null,
    archiveNote: row.application.archiveNote,
    events: applicationEvents,
    timeline: timelineRows.map(timelineDto),
  };
}

export const getApplication = getApplicationDetail;

function zodUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function replaceTags(
  tx: AppTransaction,
  workspaceId: string,
  applicationId: string,
  tagNames: string[],
  now: number,
) {
  await tx
    .delete(applicationTags)
    .where(and(eq(applicationTags.workspaceId, workspaceId), eq(applicationTags.applicationId, applicationId)));
  const unique = new Map(tagNames.map((name) => [normalizeLookupText(name), name.trim()]));
  for (const [normalizedName, name] of unique) {
    let tag = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.workspaceId, workspaceId), eq(tags.normalizedName, normalizedName), isNull(tags.deletedAtMs)))
      .limit(1);
    if (!tag[0]) {
      const tagId = randomUUID();
      await tx.insert(tags).values({
        id: tagId,
        workspaceId,
        name,
        normalizedName,
        colorToken: null,
        createdAtMs: now,
        updatedAtMs: now,
        version: 1,
        deletedAtMs: null,
      });
      tag = [{ id: tagId }];
    }
    await tx.insert(applicationTags).values({ workspaceId, applicationId, tagId: tag[0].id, createdAtMs: now });
  }
}

export async function createApplication(input: CreateApplicationInput): Promise<ApplicationDetail> {
  const data = parseDomainInput(createApplicationInputSchema, input);
  const { db, workspaceId } = await getDatabaseContext();
  const applicationId = randomUUID();
  const correlationId = randomUUID();
  const now = Date.now();
  await db.transaction(async (tx) => {
    const normalizedCompanyName = normalizeLookupText(data.companyName);
    const normalizedPositionTitle = normalizeLookupText(data.positionTitle);
    const normalizedCycleLabel = data.cycleLabel ? normalizeLookupText(data.cycleLabel) : null;

    const duplicateRows = await tx
      .select({
        id: applications.id,
        companyName: companies.name,
        positionTitle: positions.title,
        stage: applications.stage,
        updatedAtMs: applications.updatedAtMs,
      })
      .from(applications)
      .innerJoin(positions, and(eq(positions.workspaceId, applications.workspaceId), eq(positions.id, applications.positionId)))
      .innerJoin(companies, and(eq(companies.workspaceId, positions.workspaceId), eq(companies.id, positions.companyId)))
      .where(
        and(
          eq(applications.workspaceId, workspaceId),
          isNull(applications.deletedAtMs),
          isNull(positions.deletedAtMs),
          isNull(companies.deletedAtMs),
          eq(companies.normalizedName, normalizedCompanyName),
          eq(positions.normalizedTitle, normalizedPositionTitle),
          normalizedCycleLabel === null
            ? isNull(applications.normalizedCycleLabel)
            : eq(applications.normalizedCycleLabel, normalizedCycleLabel),
        ),
      );
    if (duplicateRows.length > 0 && !data.allowDuplicate) {
      throw new DomainError(
        "DUPLICATE_CONFIRMATION_REQUIRED",
        "已有相同公司、岗位和招聘批次的申请，请确认是否继续创建",
        undefined,
        { matches: duplicateRows },
      );
    }

    const existingCompany = await tx
      .select()
      .from(companies)
      .where(
        and(
          eq(companies.workspaceId, workspaceId),
          eq(companies.normalizedName, normalizedCompanyName),
          isNull(companies.deletedAtMs),
        ),
      )
      .limit(1);
    const companyId = existingCompany[0]?.id ?? randomUUID();
    if (!existingCompany[0]) {
      await tx.insert(companies).values({
        id: companyId,
        workspaceId,
        name: data.companyName,
        normalizedName: normalizedCompanyName,
        websiteUrl: null,
        notesMarkdown: null,
        isSample: 0,
        createdAtMs: now,
        updatedAtMs: now,
        version: 1,
        deletedAtMs: null,
      });
    }

    const positionId = randomUUID();
    await tx.insert(positions).values({
      id: positionId,
      workspaceId,
      companyId,
      title: data.positionTitle,
      normalizedTitle: normalizedPositionTitle,
      department: normalizeOptionalText(data.department),
      location: normalizeOptionalText(data.location),
      workMode: data.workMode,
      jobUrl: data.jobUrl ?? null,
      notesMarkdown: null,
      isSample: 0,
      createdAtMs: now,
      updatedAtMs: now,
      version: 1,
      deletedAtMs: null,
    });

    await tx.insert(applications).values({
      id: applicationId,
      workspaceId,
      positionId,
      cycleLabel: normalizeOptionalText(data.cycleLabel),
      normalizedCycleLabel,
      stage: data.stage,
      priority: data.priority,
      sourceKind: data.sourceKind,
      sourceDetail: normalizeOptionalText(data.sourceDetail),
      sourceUrl: data.sourceUrl ?? null,
      sourceFairId: null,
      attentionMode: "NEEDS_ACTION",
      nextActionTitle: null,
      currentActionEventId: null,
      waitingFor: null,
      waitingReviewEventId: null,
      appliedAtMs: null,
      offerAtMs: null,
      archivedAtMs: null,
      archivedFromStage: null,
      archiveReason: null,
      archiveNote: null,
      notesMarkdown: normalizeOptionalMarkdown(data.notesMarkdown),
      lastActivityAtMs: now,
      isSample: 0,
      createdAtMs: now,
      updatedAtMs: now,
      version: 1,
      deletedAtMs: null,
    });
    await replaceTags(tx, workspaceId, applicationId, data.tagNames, now);
    await insertTimeline(tx, {
      workspaceId,
      applicationId,
      entryType: "APPLICATION_CREATED",
      summary: `创建申请：${data.companyName} · ${data.positionTitle}`,
      details: { stage: data.stage, priority: data.priority },
      correlationId,
      happenedAtMs: now,
    });
    if (data.attention.mode !== "NEEDS_ACTION") {
      const created = await requireApplication(tx, workspaceId, applicationId);
      await applyAttention(tx, workspaceId, created, data.attention, {
        now,
        correlationId,
        incrementVersion: false,
      });
    }
  });
  return (await getApplicationDetail(applicationId))!;
}

export async function updateApplication(
  id: string,
  input: UpdateApplicationInput,
): Promise<ApplicationDetail> {
  const data = parseDomainInput(updateApplicationInputSchema, input);
  const { db, workspaceId } = await getDatabaseContext();
  const correlationId = randomUUID();
  const now = Date.now();
  await db.transaction(async (tx) => {
    const application = await requireApplication(tx, workspaceId, id);
    verifyVersion(application, data.expectedVersion);
    if (application.stage === "ARCHIVED") {
      throw new DomainError("APPLICATION_ARCHIVED", "归档申请只能先恢复后再编辑");
    }
    const positionRows = await tx
      .select()
      .from(positions)
      .where(and(eq(positions.workspaceId, workspaceId), eq(positions.id, application.positionId)))
      .limit(1);
    const position = positionRows[0];
    if (!position) throw new DomainError("DATA_INTEGRITY_ERROR", "岗位数据不完整，请运行数据检查");

    if (data.companyName !== undefined) {
      const normalizedName = normalizeLookupText(data.companyName);
      let target = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.workspaceId, workspaceId), eq(companies.normalizedName, normalizedName), isNull(companies.deletedAtMs)))
        .limit(1);
      if (!target[0]) {
        const companyId = randomUUID();
        await tx.insert(companies).values({
          id: companyId,
          workspaceId,
          name: data.companyName,
          normalizedName,
          websiteUrl: null,
          notesMarkdown: null,
          isSample: 0,
          createdAtMs: now,
          updatedAtMs: now,
          version: 1,
          deletedAtMs: null,
        });
        target = [{ id: companyId }];
      }
      await tx.update(positions).set({ companyId: target[0].id }).where(eq(positions.id, position.id));
    }

    const positionChanges: Partial<typeof positions.$inferInsert> = {};
    if (data.positionTitle !== undefined) {
      positionChanges.title = data.positionTitle;
      positionChanges.normalizedTitle = normalizeLookupText(data.positionTitle);
    }
    if (data.department !== undefined) positionChanges.department = normalizeOptionalText(data.department);
    if (data.location !== undefined) positionChanges.location = normalizeOptionalText(data.location);
    if (data.workMode !== undefined) positionChanges.workMode = data.workMode;
    if (data.jobUrl !== undefined) positionChanges.jobUrl = data.jobUrl;
    if (Object.keys(positionChanges).length > 0) {
      await tx
        .update(positions)
        .set({ ...positionChanges, updatedAtMs: now, version: sql`${positions.version} + 1` })
        .where(eq(positions.id, position.id));
    }

    const sourceKind = data.sourceKind ?? (application.sourceKind as ApplicationSource);
    const sourceDetail =
      sourceKind === "CUSTOM"
        ? normalizeOptionalText(data.sourceDetail ?? application.sourceDetail)
        : null;
    if (sourceKind === "CUSTOM" && !sourceDetail) {
      throw new DomainError("VALIDATION_ERROR", "自定义来源必须填写明细", {
        sourceDetail: ["自定义来源必须填写明细"],
      });
    }
    if (sourceKind === "RECRUITMENT_FAIR") {
      throw new DomainError("VALIDATION_ERROR", "招聘会来源将在后续版本启用", {
        sourceKind: ["招聘会来源将在后续版本启用"],
      });
    }

    const changes: Partial<typeof applications.$inferInsert> = {
      updatedAtMs: now,
      lastActivityAtMs: now,
    };
    if (data.cycleLabel !== undefined) {
      changes.cycleLabel = normalizeOptionalText(data.cycleLabel);
      changes.normalizedCycleLabel = changes.cycleLabel ? normalizeLookupText(changes.cycleLabel) : null;
    }
    if (data.priority !== undefined) changes.priority = data.priority;
    if (data.sourceKind !== undefined || data.sourceDetail !== undefined) {
      changes.sourceKind = sourceKind;
      changes.sourceDetail = sourceDetail;
    }
    if (data.sourceUrl !== undefined) changes.sourceUrl = data.sourceUrl;
    if (data.notesMarkdown !== undefined) changes.notesMarkdown = normalizeOptionalMarkdown(data.notesMarkdown);
    const updatedApplication = await tx
      .update(applications)
      .set({ ...changes, ...(data.attention ? {} : { version: sql`${applications.version} + 1` }) })
      .where(
        and(
          eq(applications.workspaceId, workspaceId),
          eq(applications.id, id),
          eq(applications.version, application.version),
          isNull(applications.deletedAtMs),
        ),
      )
      .returning({ id: applications.id });
    requireCasUpdate(updatedApplication);

    if (data.tagNames !== undefined) await replaceTags(tx, workspaceId, id, data.tagNames, now);
    await insertTimeline(tx, {
      workspaceId,
      applicationId: id,
      entryType: "APPLICATION_UPDATED",
      summary: "更新申请信息",
      details: { fields: Object.keys(data).filter((key) => !["expectedVersion", "attention"].includes(key)) },
      correlationId,
      happenedAtMs: now,
    });
    if (data.attention) {
      const current = await requireApplication(tx, workspaceId, id);
      await applyAttention(tx, workspaceId, current, data.attention, { now, correlationId, incrementVersion: true });
    }
  });
  return (await getApplicationDetail(id))!;
}

export async function setApplicationStage(
  id: string,
  stageInput: ActiveApplicationStage,
  expectedVersion?: number,
): Promise<ApplicationDetail> {
  const stage = parseDomainInput(activeApplicationStageSchema, stageInput);
  const { db, workspaceId } = await getDatabaseContext();
  const now = Date.now();
  const correlationId = randomUUID();
  await db.transaction(async (tx) => {
    const application = await requireApplication(tx, workspaceId, id);
    verifyVersion(application, expectedVersion);
    if (application.stage === "ARCHIVED") {
      throw new DomainError("APPLICATION_ARCHIVED", "请使用恢复操作重新激活申请");
    }
    if (application.stage === stage) return;
    const updated = await tx
      .update(applications)
      .set({ stage, updatedAtMs: now, lastActivityAtMs: now, version: sql`${applications.version} + 1` })
      .where(
        and(
          eq(applications.workspaceId, workspaceId),
          eq(applications.id, id),
          eq(applications.version, application.version),
          isNull(applications.deletedAtMs),
        ),
      )
      .returning({ id: applications.id });
    requireCasUpdate(updated);
    await insertTimeline(tx, {
      workspaceId,
      applicationId: id,
      entryType: "STAGE_CHANGED",
      summary: `阶段由 ${application.stage} 调整为 ${stage}`,
      details: { before: application.stage, after: stage },
      correlationId,
      happenedAtMs: now,
    });
  });
  return (await getApplicationDetail(id))!;
}

export async function setApplicationAttention(
  id: string,
  attentionInput: ApplicationAttentionInput,
  expectedVersion?: number,
): Promise<ApplicationDetail> {
  const attention = parseDomainInput(applicationAttentionSchema, attentionInput);
  const { db, workspaceId } = await getDatabaseContext();
  const now = Date.now();
  const correlationId = randomUUID();
  await db.transaction(async (tx) => {
    const application = await requireApplication(tx, workspaceId, id);
    verifyVersion(application, expectedVersion);
    await applyAttention(tx, workspaceId, application, attention, {
      now,
      correlationId,
      incrementVersion: true,
    });
  });
  return (await getApplicationDetail(id))!;
}

export async function archiveApplication(
  id: string,
  input: ArchiveApplicationInput,
): Promise<ApplicationDetail> {
  const data = parseDomainInput(archiveApplicationInputSchema, input);
  const { db, workspaceId } = await getDatabaseContext();
  const now = Date.now();
  const correlationId = randomUUID();
  await db.transaction(async (tx) => {
    const application = await requireApplication(tx, workspaceId, id);
    verifyVersion(application, data.expectedVersion);
    if (application.stage === "ARCHIVED") return;
    const updated = await tx
      .update(applications)
      .set({
        stage: "ARCHIVED",
        attentionMode: "INACTIVE",
        nextActionTitle: null,
        currentActionEventId: null,
        waitingFor: null,
        waitingReviewEventId: null,
        archivedAtMs: now,
        archivedFromStage: application.stage,
        archiveReason: data.reason,
        archiveNote: normalizeOptionalText(data.note),
        updatedAtMs: now,
        lastActivityAtMs: now,
        version: sql`${applications.version} + 1`,
      })
      .where(
        and(
          eq(applications.workspaceId, workspaceId),
          eq(applications.id, id),
          eq(applications.version, application.version),
          isNull(applications.deletedAtMs),
        ),
      )
      .returning({ id: applications.id });
    requireCasUpdate(updated);
    await insertTimeline(tx, {
      workspaceId,
      applicationId: id,
      entryType: "ARCHIVED",
      summary: "归档申请",
      details: { fromStage: application.stage, reason: data.reason },
      correlationId,
      happenedAtMs: now,
    });
  });
  return (await getApplicationDetail(id))!;
}

export async function restoreApplication(
  id: string,
  input: RestoreApplicationInput,
): Promise<ApplicationDetail> {
  const data = parseDomainInput(restoreApplicationInputSchema, input);
  const { db, workspaceId } = await getDatabaseContext();
  const now = Date.now();
  const correlationId = randomUUID();
  await db.transaction(async (tx) => {
    const application = await requireApplication(tx, workspaceId, id);
    verifyVersion(application, data.expectedVersion);
    if (application.stage !== "ARCHIVED") {
      throw new DomainError("APPLICATION_NOT_ARCHIVED", "这条申请当前没有归档");
    }
    const restoredRows = await tx
      .update(applications)
      .set({
        stage: data.stage,
        attentionMode: "NEEDS_ACTION",
        nextActionTitle: null,
        currentActionEventId: null,
        waitingFor: null,
        waitingReviewEventId: null,
        archivedAtMs: null,
        archivedFromStage: null,
        archiveReason: null,
        archiveNote: null,
        updatedAtMs: now,
        lastActivityAtMs: now,
      })
      .where(
        and(
          eq(applications.workspaceId, workspaceId),
          eq(applications.id, id),
          eq(applications.version, application.version),
          isNull(applications.deletedAtMs),
        ),
      )
      .returning({ id: applications.id });
    requireCasUpdate(restoredRows);
    await insertTimeline(tx, {
      workspaceId,
      applicationId: id,
      entryType: "RESTORED",
      summary: `恢复到 ${data.stage}`,
      details: { stage: data.stage },
      correlationId,
      happenedAtMs: now,
    });
    const restored = await requireApplication(tx, workspaceId, id);
    await applyAttention(tx, workspaceId, restored, data.attention, {
      now,
      correlationId,
      incrementVersion: true,
    });
  });
  return (await getApplicationDetail(id))!;
}

async function findConflictsForSchedule(
  tx: AppTransaction,
  workspaceId: string,
  candidate: EventDto,
  excludeId?: string,
): Promise<EventDto[]> {
  const rows = await tx
    .select({ event: events, stage: applications.stage })
    .from(events)
    .innerJoin(
      applications,
      and(eq(applications.workspaceId, events.workspaceId), eq(applications.id, events.applicationId)),
    )
    .where(
      and(
        eq(events.workspaceId, workspaceId),
        eq(events.status, "SCHEDULED"),
        isNull(events.deletedAtMs),
        isNull(applications.deletedAtMs),
        ne(applications.stage, "ARCHIVED"),
        excludeId ? ne(events.id, excludeId) : undefined,
      ),
    );
  return rows.map((row) => eventDto(row.event)).filter((event) => eventsConflict(candidate, event));
}

export async function createEvent(input: CreateEventInput): Promise<EventDto> {
  const data = parseDomainInput(createEventInputSchema, input);
  const { db, workspaceId } = await getDatabaseContext();
  const now = Date.now();
  const id = randomUUID();
  const correlationId = randomUUID();
  const timezone = data.timezone ?? (await getWorkspaceSettings()).timezone;
  await db.transaction(async (tx) => {
    const application = await requireApplication(tx, workspaceId, data.applicationId);
    if (application.stage === "ARCHIVED") {
      throw new DomainError("APPLICATION_ARCHIVED", "归档申请不能新建事件");
    }
    const row: EventRow = {
      id,
      workspaceId,
      applicationId: data.applicationId,
      type: data.type,
      title: data.title,
      status: "SCHEDULED",
      ...scheduleColumns(data.schedule),
      timezone,
      location: normalizeOptionalText(data.location),
      meetingUrl: data.meetingUrl ?? null,
      notesMarkdown: normalizeOptionalMarkdown(data.notesMarkdown),
      isHardDeadline: data.isHardDeadline ? 1 : 0,
      completedAtMs: null,
      icsUid: `${id}@campus-hire-tracker.local`,
      isSample: 0,
      createdAtMs: now,
      updatedAtMs: now,
      version: 1,
      deletedAtMs: null,
    };
    const conflicts = await findConflictsForSchedule(tx, workspaceId, eventDto(row));
    if (conflicts.length > 0 && !data.allowConflicts) {
      throw new DomainError(
        "EVENT_CONFLICT_CONFIRMATION_REQUIRED",
        "该时段与已有日程冲突，请确认是否仍要保存",
        undefined,
        {
          conflicts: conflicts.map((event) => ({ ...event, notesMarkdown: null })),
        },
      );
    }
    await tx.insert(events).values(row);
    const updatedApplication = await tx
      .update(applications)
      .set({ lastActivityAtMs: now, updatedAtMs: now, version: sql`${applications.version} + 1` })
      .where(
        and(
          eq(applications.workspaceId, workspaceId),
          eq(applications.id, data.applicationId),
          eq(applications.version, application.version),
          isNull(applications.deletedAtMs),
        ),
      )
      .returning({ id: applications.id });
    requireCasUpdate(updatedApplication);
    await insertTimeline(tx, {
      workspaceId,
      applicationId: data.applicationId,
      entryType: "EVENT_CREATED",
      summary: `创建事件：${data.title}`,
      details: { type: data.type, schedule: data.schedule },
      sourceEntityType: "EVENT",
      sourceEntityId: id,
      correlationId,
      happenedAtMs: now,
    });
  });
  const rows = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return eventDto(rows[0]);
}

export async function updateEvent(id: string, input: UpdateEventInput): Promise<EventDto> {
  const data = parseDomainInput(updateEventInputSchema, input);
  const { db, workspaceId } = await getDatabaseContext();
  const now = Date.now();
  const correlationId = randomUUID();
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.id, id), isNull(events.deletedAtMs)))
      .limit(1);
    const event = rows[0];
    if (!event) throw new DomainError("EVENT_NOT_FOUND", "没有找到这个事件");
    verifyVersion(event, data.expectedVersion);
    if (event.status !== "SCHEDULED" && data.schedule) {
      throw new DomainError("EVENT_NOT_SCHEDULED", "只有未结束的事件可以改期");
    }
    const application = await requireApplication(tx, workspaceId, event.applicationId);
    const changes: Partial<typeof events.$inferInsert> = {
      updatedAtMs: now,
    };
    if (data.title !== undefined) changes.title = data.title;
    if (data.schedule !== undefined) Object.assign(changes, scheduleColumns(data.schedule));
    if (data.timezone !== undefined) changes.timezone = data.timezone;
    if (data.location !== undefined) changes.location = normalizeOptionalText(data.location);
    if (data.meetingUrl !== undefined) changes.meetingUrl = data.meetingUrl;
    if (data.notesMarkdown !== undefined) changes.notesMarkdown = normalizeOptionalMarkdown(data.notesMarkdown);
    if (data.isHardDeadline !== undefined) changes.isHardDeadline = data.isHardDeadline ? 1 : 0;
    const candidate = eventDto({ ...event, ...changes, version: event.version + 1 } as EventRow);
    const conflicts = await findConflictsForSchedule(tx, workspaceId, candidate, id);
    if (conflicts.length > 0 && !data.allowConflicts) {
      throw new DomainError(
        "EVENT_CONFLICT_CONFIRMATION_REQUIRED",
        "该时段与已有日程冲突，请确认是否仍要保存",
        undefined,
        { conflicts: conflicts.map((conflict) => ({ ...conflict, notesMarkdown: null })) },
      );
    }
    const updatedEvent = await tx
      .update(events)
      .set({ ...changes, version: sql`${events.version} + 1` })
      .where(
        and(
          eq(events.workspaceId, workspaceId),
          eq(events.id, id),
          eq(events.version, event.version),
          isNull(events.deletedAtMs),
        ),
      )
      .returning({ id: events.id });
    requireCasUpdate(updatedEvent);
    const updatedApplication = await tx
      .update(applications)
      .set({ lastActivityAtMs: now, updatedAtMs: now, version: sql`${applications.version} + 1` })
      .where(
        and(
          eq(applications.workspaceId, workspaceId),
          eq(applications.id, event.applicationId),
          eq(applications.version, application.version),
          isNull(applications.deletedAtMs),
        ),
      )
      .returning({ id: applications.id });
    requireCasUpdate(updatedApplication);
    await insertTimeline(tx, {
      workspaceId,
      applicationId: event.applicationId,
      entryType: data.schedule ? "EVENT_RESCHEDULED" : "EVENT_UPDATED",
      summary: data.schedule ? "调整事件时间" : "更新事件",
      details: { eventId: id },
      sourceEntityType: "EVENT",
      sourceEntityId: id,
      correlationId,
      happenedAtMs: now,
    });
  });
  const rows = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return eventDto(rows[0]);
}

export async function updateEventStatus(
  id: string,
  input: UpdateEventStatusInput,
): Promise<EventDto> {
  const data = parseDomainInput(updateEventStatusInputSchema, input);
  const { db, workspaceId } = await getDatabaseContext();
  const now = Date.now();
  const correlationId = randomUUID();
  await db.transaction(async (tx) => {
    const eventRows = await tx
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.id, id), isNull(events.deletedAtMs)))
      .limit(1);
    const event = eventRows[0];
    if (!event) throw new DomainError("EVENT_NOT_FOUND", "没有找到这个事件");
    verifyVersion(event, data.expectedVersion);
    if (event.status === data.status) return;
    const application = await requireApplication(tx, workspaceId, event.applicationId);
    const clearsAttention =
      data.status !== "SCHEDULED" &&
      (application.currentActionEventId === id || application.waitingReviewEventId === id);
    const updatedApplication = await tx
      .update(applications)
      .set({
        ...(clearsAttention
          ? {
              attentionMode: "NEEDS_ACTION",
              nextActionTitle: null,
              currentActionEventId: null,
              waitingFor: null,
              waitingReviewEventId: null,
            }
          : {}),
        lastActivityAtMs: now,
        updatedAtMs: now,
        version: sql`${applications.version} + 1`,
      })
      .where(
        and(
          eq(applications.workspaceId, workspaceId),
          eq(applications.id, event.applicationId),
          eq(applications.version, application.version),
          isNull(applications.deletedAtMs),
        ),
      )
      .returning({ id: applications.id });
    requireCasUpdate(updatedApplication);
    const updatedEvent = await tx
      .update(events)
      .set({
        status: data.status,
        completedAtMs: data.status === "COMPLETED" ? now : null,
        updatedAtMs: now,
        version: sql`${events.version} + 1`,
      })
      .where(
        and(
          eq(events.workspaceId, workspaceId),
          eq(events.id, id),
          eq(events.version, event.version),
          isNull(events.deletedAtMs),
        ),
      )
      .returning({ id: events.id });
    requireCasUpdate(updatedEvent);
    await insertTimeline(tx, {
      workspaceId,
      applicationId: event.applicationId,
      entryType:
        data.status === "COMPLETED"
          ? "EVENT_COMPLETED"
          : data.status === "CANCELLED"
            ? "EVENT_CANCELLED"
            : "EVENT_REOPENED",
      summary:
        data.status === "COMPLETED" ? "完成事件" : data.status === "CANCELLED" ? "取消事件" : "重新打开事件",
      details: { eventId: id, before: event.status, after: data.status, attentionCleared: clearsAttention },
      sourceEntityType: "EVENT",
      sourceEntityId: id,
      correlationId,
      happenedAtMs: now,
    });
    if (clearsAttention) {
      await insertTimeline(tx, {
        workspaceId,
        applicationId: event.applicationId,
        entryType: "ATTENTION_CHANGED",
        summary: "事件结束，标记为缺少下一步",
        details: { before: application.attentionMode, after: "NEEDS_ACTION" },
        correlationId,
        happenedAtMs: now,
      });
    }
  });
  const rows = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return eventDto(rows[0]);
}

export async function cancelEvent(id: string, expectedVersion?: number): Promise<EventDto> {
  return updateEventStatus(id, { status: "CANCELLED", expectedVersion });
}

export async function listCalendarEvents(options: CalendarEventsOptions = {}): Promise<EventDto[]> {
  const { db, workspaceId } = await getDatabaseContext();
  const conditions = [eq(events.workspaceId, workspaceId), isNull(events.deletedAtMs), isNull(applications.deletedAtMs)];
  if (!options.includeArchived) conditions.push(ne(applications.stage, "ARCHIVED"));
  if (options.applicationId) conditions.push(eq(events.applicationId, options.applicationId));
  const statuses = valueArray(options.status);
  if (statuses?.length) conditions.push(inArray(events.status, statuses));
  const rows = await db
    .select({ event: events })
    .from(events)
    .innerJoin(
      applications,
      and(eq(applications.workspaceId, events.workspaceId), eq(applications.id, events.applicationId)),
    )
    .where(and(...conditions));
  return rows
    .map((row) => eventDto(row.event))
    .filter((event) => {
      const extent = eventExtent(event);
      const start = extent.point ? extent.at : extent.start;
      const end = extent.point ? extent.at : extent.end;
      return (options.fromMs === undefined || end >= options.fromMs) && (options.toMs === undefined || start < options.toMs);
    })
    .sort((a, b) => eventSortValue(a) - eventSortValue(b));
}

export async function getTodayDashboard(options: { now?: number } = {}): Promise<DashboardData> {
  const now = options.now ?? Date.now();
  const settings = await getWorkspaceSettings();
  const todayDate = dateAtTimezone(now, settings.timezone);
  const tomorrowStart = timezoneMidnight(nextIsoDate(todayDate, 1), settings.timezone);
  const eightDaysStart = timezoneMidnight(nextIsoDate(todayDate, 8), settings.timezone);
  const [allApplications, scheduledEvents] = await Promise.all([
    listApplications({ includeArchived: true }),
    listCalendarEvents({ status: "SCHEDULED" }),
  ]);
  const eventStart = (event: EventDto) => eventSortValue(event);
  const overdue = scheduledEvents.filter((event) => eventStart(event) < now);
  const today = scheduledEvents.filter((event) => {
    const start = eventStart(event);
    return start >= now && start < tomorrowStart;
  });
  const upcomingSevenDays = scheduledEvents.filter((event) => {
    const start = eventStart(event);
    return start >= tomorrowStart && start < eightDaysStart;
  });
  const activeApplications = allApplications.filter((application) => !application.isArchived);
  const waitingReview = activeApplications.filter((application) => {
    if (application.attentionMode !== "WAITING") return false;
    if (application.attentionAtMs !== null) return application.attentionAtMs <= now;
    return application.attentionDate !== null && application.attentionDate <= todayDate;
  });
  const needsAction = activeApplications.filter((application) => application.attentionMode === "NEEDS_ACTION");
  const conflicts: DashboardData["conflicts"] = [];
  for (let first = 0; first < scheduledEvents.length; first += 1) {
    for (let second = first + 1; second < scheduledEvents.length; second += 1) {
      if (eventsConflict(scheduledEvents[first], scheduledEvents[second])) {
        conflicts.push({ first: scheduledEvents[first], second: scheduledEvents[second] });
      }
    }
  }
  return {
    generatedAtMs: now,
    overdue,
    today,
    upcomingSevenDays,
    waitingReview,
    needsAction,
    conflicts,
    counts: {
      activeApplications: activeApplications.length,
      archivedApplications: allApplications.length - activeApplications.length,
      overdue: overdue.length,
      today: today.length,
      upcomingSevenDays: upcomingSevenDays.length,
      waitingReview: waitingReview.length,
      needsAction: needsAction.length,
      conflictPairs: conflicts.length,
    },
  };
}

export const getDashboardData = getTodayDashboard;
