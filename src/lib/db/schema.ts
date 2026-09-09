import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  locale: text("locale").notNull(),
  timezone: text("timezone").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: integer("version").notNull(),
});

export const workspaceSettings = sqliteTable("workspace_settings", {
  workspaceId: text("workspace_id").primaryKey(),
  theme: text("theme").notNull(),
  lastApplicationView: text("last_application_view").notNull(),
  weekStartsOn: integer("week_starts_on").notNull(),
  browserNotificationsEnabled: integer("browser_notifications_enabled").notNull(),
  dailyBackupRetention: integer("daily_backup_retention").notNull(),
  trashRetentionDays: integer("trash_retention_days").notNull(),
  onboardingCompletedAtMs: integer("onboarding_completed_at_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: integer("version").notNull(),
});

export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  websiteUrl: text("website_url"),
  notesMarkdown: text("notes_markdown"),
  isSample: integer("is_sample").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: integer("version").notNull(),
  deletedAtMs: integer("deleted_at_ms"),
});

export const positions = sqliteTable("positions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  companyId: text("company_id").notNull(),
  title: text("title").notNull(),
  normalizedTitle: text("normalized_title").notNull(),
  department: text("department"),
  location: text("location"),
  workMode: text("work_mode").notNull(),
  jobUrl: text("job_url"),
  notesMarkdown: text("notes_markdown"),
  isSample: integer("is_sample").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: integer("version").notNull(),
  deletedAtMs: integer("deleted_at_ms"),
});

export const applications = sqliteTable("applications", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  positionId: text("position_id").notNull(),
  cycleLabel: text("cycle_label"),
  normalizedCycleLabel: text("normalized_cycle_label"),
  stage: text("stage").notNull(),
  priority: text("priority").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceDetail: text("source_detail"),
  sourceUrl: text("source_url"),
  sourceFairId: text("source_fair_id"),
  attentionMode: text("attention_mode").notNull(),
  nextActionTitle: text("next_action_title"),
  currentActionEventId: text("current_action_event_id"),
  waitingFor: text("waiting_for"),
  waitingReviewEventId: text("waiting_review_event_id"),
  appliedAtMs: integer("applied_at_ms"),
  offerAtMs: integer("offer_at_ms"),
  archivedAtMs: integer("archived_at_ms"),
  archivedFromStage: text("archived_from_stage"),
  archiveReason: text("archive_reason"),
  archiveNote: text("archive_note"),
  notesMarkdown: text("notes_markdown"),
  lastActivityAtMs: integer("last_activity_at_ms").notNull(),
  isSample: integer("is_sample").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: integer("version").notNull(),
  deletedAtMs: integer("deleted_at_ms"),
});

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  colorToken: text("color_token"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: integer("version").notNull(),
  deletedAtMs: integer("deleted_at_ms"),
});

export const applicationTags = sqliteTable(
  "application_tags",
  {
    workspaceId: text("workspace_id").notNull(),
    applicationId: text("application_id").notNull(),
    tagId: text("tag_id").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.applicationId, table.tagId] })],
);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  applicationId: text("application_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  isAllDay: integer("is_all_day").notNull(),
  startsAtMs: integer("starts_at_ms"),
  endsAtMs: integer("ends_at_ms"),
  allDayStartDate: text("all_day_start_date"),
  allDayEndDateExclusive: text("all_day_end_date_exclusive"),
  timezone: text("timezone").notNull(),
  location: text("location"),
  meetingUrl: text("meeting_url"),
  notesMarkdown: text("notes_markdown"),
  isHardDeadline: integer("is_hard_deadline").notNull(),
  completedAtMs: integer("completed_at_ms"),
  icsUid: text("ics_uid").notNull(),
  isSample: integer("is_sample").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: integer("version").notNull(),
  deletedAtMs: integer("deleted_at_ms"),
});

export const timelineEntries = sqliteTable("timeline_entries", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  applicationId: text("application_id").notNull(),
  entryType: text("entry_type").notNull(),
  actorKind: text("actor_kind").notNull(),
  happenedAtMs: integer("happened_at_ms").notNull(),
  summary: text("summary").notNull(),
  detailsJson: text("details_json"),
  sourceEntityType: text("source_entity_type"),
  sourceEntityId: text("source_entity_id"),
  correlationId: text("correlation_id").notNull(),
  revertsEntryId: text("reverts_entry_id"),
  createdAtMs: integer("created_at_ms").notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type ApplicationRow = typeof applications.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type TimelineEntryRow = typeof timelineEntries.$inferSelect;
