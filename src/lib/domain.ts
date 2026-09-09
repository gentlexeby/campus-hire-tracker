import { z } from "zod";

export const APPLICATION_STAGES = [
  "OPPORTUNITY_POOL",
  "PREPARING",
  "APPLIED",
  "ASSESSMENT",
  "INTERVIEWING",
  "OFFER",
  "ARCHIVED",
] as const;

export const ACTIVE_APPLICATION_STAGES = APPLICATION_STAGES.filter(
  (stage) => stage !== "ARCHIVED",
) as Exclude<(typeof APPLICATION_STAGES)[number], "ARCHIVED">[];

export const PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;
export const ATTENTION_MODES = ["ACTION", "WAITING", "NEEDS_ACTION", "INACTIVE"] as const;
export const ARCHIVE_REASONS = ["REJECTED", "ABANDONED", "WITHDRAWN", "OTHER"] as const;
export const APPLICATION_SOURCES = [
  "UNSPECIFIED",
  "OFFICIAL_SITE",
  "JOB_PLATFORM",
  "REFERRAL",
  "RECRUITMENT_FAIR",
  "CAMPUS_CHANNEL",
  "CUSTOM",
] as const;
export const WORK_MODES = ["UNSPECIFIED", "ONSITE", "HYBRID", "REMOTE"] as const;
export const EVENT_TYPES = [
  "INTERVIEW",
  "ASSESSMENT",
  "WRITTEN_TEST",
  "RECRUITMENT_FAIR",
  "APPLICATION_DEADLINE",
  "ACTION_DUE",
  "FOLLOW_UP",
  "OTHER",
] as const;
export const M1_EVENT_TYPES = EVENT_TYPES.filter(
  (type) => type !== "RECRUITMENT_FAIR",
) as Exclude<(typeof EVENT_TYPES)[number], "RECRUITMENT_FAIR">[];
export const EVENT_STATUSES = ["SCHEDULED", "COMPLETED", "CANCELLED"] as const;

export const applicationStageSchema = z.enum(APPLICATION_STAGES);
export const activeApplicationStageSchema = z.enum(ACTIVE_APPLICATION_STAGES);
export const prioritySchema = z.enum(PRIORITIES);
export const attentionModeSchema = z.enum(ATTENTION_MODES);
export const archiveReasonSchema = z.enum(ARCHIVE_REASONS);
export const applicationSourceSchema = z.enum(APPLICATION_SOURCES);
export const workModeSchema = z.enum(WORK_MODES);
export const eventTypeSchema = z.enum(M1_EVENT_TYPES);
export const eventStatusSchema = z.enum(EVENT_STATUSES);

const requiredText = (label: string, max: number) =>
  z.string().trim().min(1, `${label}不能为空`).max(max, `${label}不能超过 ${max} 个字符`);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const optionalMarkdown = (max: number) =>
  z.string().max(max, `内容不能超过 ${max} 个字符`).nullable().optional();
const optionalUrl = z
  .union([z.url({ protocol: /^https?$/ }), z.literal(""), z.null()])
  .optional()
  .transform((value) => (value ? value : null));

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期必须为 YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "日期无效");

export const timedScheduleSchema = z
  .object({
    kind: z.literal("TIMED"),
    startsAtMs: z.number().int().nonnegative(),
    endsAtMs: z.number().int().nonnegative().nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.endsAtMs != null && value.endsAtMs <= value.startsAtMs) {
      context.addIssue({
        code: "custom",
        path: ["endsAtMs"],
        message: "结束时间必须晚于开始时间",
      });
    }
  });

export const allDayScheduleSchema = z
  .object({
    kind: z.literal("ALL_DAY"),
    startDate: isoDateSchema,
    endDateExclusive: isoDateSchema,
  })
  .superRefine((value, context) => {
    if (value.endDateExclusive <= value.startDate) {
      context.addIssue({
        code: "custom",
        path: ["endDateExclusive"],
        message: "全天事件结束日期必须晚于开始日期",
      });
    }
  });

export const eventScheduleSchema = z.union([timedScheduleSchema, allDayScheduleSchema]);

export const applicationAttentionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("NEEDS_ACTION") }),
  z.object({
    mode: z.literal("ACTION"),
    title: requiredText("下一步", 300),
    due: eventScheduleSchema.optional(),
  }),
  z.object({
    mode: z.literal("WAITING"),
    waitingFor: optionalText(300),
    review: eventScheduleSchema,
  }),
]);

const applicationFields = {
  companyName: requiredText("公司", 200),
  positionTitle: requiredText("岗位", 300),
  cycleLabel: optionalText(120),
  department: optionalText(200),
  location: optionalText(200),
  workMode: workModeSchema.default("UNSPECIFIED"),
  jobUrl: optionalUrl,
  stage: activeApplicationStageSchema.default("OPPORTUNITY_POOL"),
  priority: prioritySchema.default("MEDIUM"),
  sourceKind: applicationSourceSchema.default("UNSPECIFIED"),
  sourceDetail: optionalText(200),
  sourceUrl: optionalUrl,
  notesMarkdown: optionalMarkdown(100_000),
  tagNames: z.array(requiredText("标签", 80)).max(30).default([]),
  attention: applicationAttentionSchema.default({ mode: "NEEDS_ACTION" }),
  allowDuplicate: z.boolean().default(false),
};

function validateSource(
  value: { sourceKind?: string; sourceDetail?: string | null },
  context: z.RefinementCtx,
) {
  if (value.sourceKind === "CUSTOM" && !value.sourceDetail?.trim()) {
    context.addIssue({
      code: "custom",
      path: ["sourceDetail"],
      message: "自定义来源必须填写明细",
    });
  }
  if (value.sourceKind !== "CUSTOM" && value.sourceDetail) {
    context.addIssue({
      code: "custom",
      path: ["sourceDetail"],
      message: "只有自定义来源可以填写来源明细",
    });
  }
  if (value.sourceKind === "RECRUITMENT_FAIR") {
    context.addIssue({
      code: "custom",
      path: ["sourceKind"],
      message: "招聘会来源将在后续版本启用",
    });
  }
}

export const createApplicationInputSchema = z
  .object(applicationFields)
  .strict()
  .superRefine(validateSource);

export const updateApplicationInputSchema = z
  .object({
    companyName: applicationFields.companyName.optional(),
    positionTitle: applicationFields.positionTitle.optional(),
    cycleLabel: applicationFields.cycleLabel,
    department: applicationFields.department,
    location: applicationFields.location,
    workMode: workModeSchema.optional(),
    jobUrl: optionalUrl,
    priority: prioritySchema.optional(),
    sourceKind: applicationSourceSchema.optional(),
    sourceDetail: applicationFields.sourceDetail,
    sourceUrl: optionalUrl,
    notesMarkdown: applicationFields.notesMarkdown,
    tagNames: z.array(requiredText("标签", 80)).max(30).optional(),
    attention: applicationAttentionSchema.optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

export const archiveApplicationInputSchema = z
  .object({
    reason: archiveReasonSchema,
    note: optionalText(2_000),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.reason === "OTHER" && !value.note?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "选择其他原因时必须填写说明",
      });
    }
  });

export const restoreApplicationInputSchema = z
  .object({
    stage: activeApplicationStageSchema,
    attention: applicationAttentionSchema.default({ mode: "NEEDS_ACTION" }),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

const eventCommonFields = {
  applicationId: z.uuid(),
  type: eventTypeSchema,
  title: requiredText("事件标题", 300),
  schedule: eventScheduleSchema,
  timezone: requiredText("时区", 100).optional(),
  location: optionalText(500),
  meetingUrl: optionalUrl,
  notesMarkdown: optionalMarkdown(100_000),
  isHardDeadline: z.boolean().default(false),
  allowConflicts: z.boolean().default(false),
};

export const createEventInputSchema = z.object(eventCommonFields).strict();
export const updateEventInputSchema = z
  .object({
    title: eventCommonFields.title.optional(),
    schedule: eventScheduleSchema.optional(),
    timezone: eventCommonFields.timezone,
    location: eventCommonFields.location,
    meetingUrl: optionalUrl,
    notesMarkdown: eventCommonFields.notesMarkdown,
    isHardDeadline: z.boolean().optional(),
    allowConflicts: z.boolean().default(false),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export const updateEventStatusInputSchema = z
  .object({
    status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED"]),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

export type ApplicationStage = z.infer<typeof applicationStageSchema>;
export type ActiveApplicationStage = z.infer<typeof activeApplicationStageSchema>;
export type Priority = z.infer<typeof prioritySchema>;
export type AttentionMode = z.infer<typeof attentionModeSchema>;
export type ArchiveReason = z.infer<typeof archiveReasonSchema>;
export type ApplicationSource = z.infer<typeof applicationSourceSchema>;
export type WorkMode = z.infer<typeof workModeSchema>;
export type EventType = z.infer<typeof eventTypeSchema>;
export type EventStatus = z.infer<typeof eventStatusSchema>;
export type EventScheduleInput = z.infer<typeof eventScheduleSchema>;
export type ApplicationAttentionInput = z.infer<typeof applicationAttentionSchema>;
export type CreateApplicationInput = z.input<typeof createApplicationInputSchema>;
export type UpdateApplicationInput = z.input<typeof updateApplicationInputSchema>;
export type ArchiveApplicationInput = z.input<typeof archiveApplicationInputSchema>;
export type RestoreApplicationInput = z.input<typeof restoreApplicationInputSchema>;
export type CreateEventInput = z.input<typeof createEventInputSchema>;
export type UpdateEventInput = z.input<typeof updateEventInputSchema>;
export type UpdateEventStatusInput = z.input<typeof updateEventStatusInputSchema>;

export function normalizeLookupText(value: string): string {
  return value.trim().replace(/\s+/g, " ").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

export function normalizeOptionalMarkdown(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalizedLineEndings = value.replace(/\r\n?/g, "\n");
  return normalizedLineEndings.trim().length > 0 ? normalizedLineEndings : null;
}

export function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
}

export class DomainError extends Error {
  readonly code: string;
  readonly fieldErrors?: Record<string, string[]>;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    fieldErrors?: Record<string, string[]>,
    details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.details = details;
  }
}

export function parseDomainInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const fieldErrors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "form";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  throw new DomainError("VALIDATION_ERROR", "提交内容有误，请检查后重试", fieldErrors);
}
