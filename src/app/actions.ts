"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { EventConflictSummary, FormState, SafeFormDetails } from "@/components/form-state";
import {
  activeApplicationStageSchema,
  applicationSourceSchema,
  archiveReasonSchema,
  DomainError,
  eventStatusSchema,
  eventTypeSchema,
  parseDomainInput,
  prioritySchema,
} from "@/lib/domain";
import {
  archiveApplication,
  createApplication,
  createEvent,
  restoreApplication,
  setApplicationAttention,
  setApplicationStage,
  updateApplication,
  updateEventStatus,
} from "@/lib/services";

function text(formData: FormData, key: string) {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
}

function rawText(formData: FormData, key: string) {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw : "";
}

function optionalText(formData: FormData, key: string) {
  const result = text(formData, key);
  return result || null;
}

function numberOrUndefined(value: string) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function localDateTime(value: string) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function formValues(formData: FormData) {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && !key.toLocaleLowerCase().includes("csrf")) values[key] = value;
  }
  return values;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeTextValue(value: unknown, maximumLength: number) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximumLength)
    : null;
}

function safeTimeValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function formatConflict(value: unknown): EventConflictSummary | null {
  const candidate = objectValue(value);
  const schedule = objectValue(candidate?.schedule);
  const title = safeTextValue(candidate?.title, 300);
  const type = safeTextValue(candidate?.type, 40);
  if (!candidate || !schedule || !title || !type) return null;

  const timezone = safeTextValue(candidate.timezone, 100);
  if (schedule.kind === "TIMED") {
    const startsAtMs = safeTimeValue(schedule.startsAtMs);
    if (startsAtMs == null) return null;
    return {
      title,
      type,
      timezone,
      schedule: {
        kind: "TIMED",
        startsAtMs,
        endsAtMs: safeTimeValue(schedule.endsAtMs),
      },
    };
  }

  if (schedule.kind === "ALL_DAY") {
    const startDate = safeTextValue(schedule.startDate, 10);
    const endDateExclusive = safeTextValue(schedule.endDateExclusive, 10);
    if (!startDate || !endDateExclusive || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateExclusive)) return null;
    return { title, type, timezone, schedule: { kind: "ALL_DAY", startDate, endDateExclusive } };
  }

  return null;
}

function safeDomainDetails(error: DomainError, formData: FormData): SafeFormDetails | undefined {
  const details = objectValue(error.details);
  if (error.code === "DUPLICATE_CONFIRMATION_REQUIRED" && Array.isArray(details?.matches)) {
    const cycleLabel = safeTextValue(text(formData, "cycleLabel"), 80);
    const matches = details.matches.slice(0, 10).flatMap((value) => {
      const match = objectValue(value);
      const companyName = safeTextValue(match?.companyName, 200);
      const positionTitle = safeTextValue(match?.positionTitle, 300);
      return companyName && positionTitle ? [{ companyName, positionTitle, cycleLabel }] : [];
    });
    return matches.length ? { kind: "DUPLICATE_APPLICATIONS", matches } : undefined;
  }

  if (error.code === "EVENT_CONFLICT_CONFIRMATION_REQUIRED" && Array.isArray(details?.conflicts)) {
    const conflicts = details.conflicts.slice(0, 10).map(formatConflict).filter((value): value is EventConflictSummary => value !== null);
    return conflicts.length ? { kind: "EVENT_CONFLICTS", conflicts } : undefined;
  }

  return undefined;
}

function safeError(error: unknown, formData: FormData): FormState {
  if (error instanceof DomainError) {
    const details = safeDomainDetails(error, formData);
    return {
      code: error.code,
      ...(details ? { details } : {}),
      fieldErrors: Object.fromEntries(Object.entries(error.fieldErrors ?? {}).map(([key, messages]) => [key, messages[0] ?? "请检查此字段"])),
      message: error.message,
      values: formValues(formData),
    };
  }
  return { code: "UNEXPECTED_ERROR", message: "没有保存成功。你的输入仍保留在页面中，请重试。", values: formValues(formData) };
}

function refreshApplication(applicationId?: string) {
  revalidatePath("/");
  revalidatePath("/applications");
  revalidatePath("/calendar");
  if (applicationId) revalidatePath(`/applications/${applicationId}`);
}

function resultId(result: unknown) {
  if (result && typeof result === "object") {
    if ("id" in result && typeof result.id === "string") return result.id;
    if ("application" in result && result.application && typeof result.application === "object" && "id" in result.application && typeof result.application.id === "string") return result.application.id;
  }
  return null;
}

export async function createApplicationAction(_state: FormState, formData: FormData): Promise<FormState> {
  const companyName = text(formData, "companyName");
  const positionTitle = text(formData, "positionTitle");
  if (!companyName || !positionTitle) {
    return {
      code: "VALIDATION_ERROR",
      fieldErrors: {
        ...(!companyName ? { companyName: "请填写公司" } : {}),
        ...(!positionTitle ? { positionTitle: "请填写岗位" } : {}),
      },
      message: "请补全必填内容。",
      values: formValues(formData),
    };
  }

  let result: unknown;
  try {
    const nextActionTitle = optionalText(formData, "nextActionTitle");
    result = await createApplication({
      allowDuplicate: text(formData, "allowDuplicate") === "true",
      attention: nextActionTitle ? { mode: "ACTION", title: nextActionTitle } : { mode: "NEEDS_ACTION" },
      companyName,
      cycleLabel: optionalText(formData, "cycleLabel"),
      location: optionalText(formData, "location"),
      positionTitle,
      priority: parseDomainInput(prioritySchema, text(formData, "priority") || "MEDIUM"),
      sourceDetail: text(formData, "sourceKind") === "CUSTOM" ? optionalText(formData, "sourceDetail") : null,
      sourceKind: parseDomainInput(applicationSourceSchema, text(formData, "sourceKind") || "UNSPECIFIED"),
      sourceUrl: optionalText(formData, "sourceUrl"),
      stage: parseDomainInput(activeApplicationStageSchema, text(formData, "stage") || "OPPORTUNITY_POOL"),
      tagNames: [],
      workMode: "UNSPECIFIED",
    });
  } catch (error) {
    return safeError(error, formData);
  }

  const applicationId = resultId(result);
  refreshApplication(applicationId ?? undefined);
  redirect(applicationId ? `/applications/${applicationId}?created=1` : "/applications");
}

export async function updateApplicationAction(_state: FormState, formData: FormData): Promise<FormState> {
  const applicationId = text(formData, "applicationId");
  try {
    await updateApplication(applicationId, {
      companyName: text(formData, "companyName"),
      cycleLabel: optionalText(formData, "cycleLabel"),
      expectedVersion: numberOrUndefined(text(formData, "expectedVersion")),
      location: optionalText(formData, "location"),
      positionTitle: text(formData, "positionTitle"),
      priority: parseDomainInput(prioritySchema, text(formData, "priority")),
      sourceDetail: text(formData, "sourceKind") === "CUSTOM" ? optionalText(formData, "sourceDetail") : null,
      sourceKind: parseDomainInput(applicationSourceSchema, text(formData, "sourceKind")),
      sourceUrl: optionalText(formData, "sourceUrl"),
    });
  } catch (error) {
    return safeError(error, formData);
  }
  refreshApplication(applicationId);
  return { ok: true, message: "概览已保存。" };
}

export async function updateApplicationNotesAction(_state: FormState, formData: FormData): Promise<FormState> {
  const applicationId = text(formData, "applicationId");
  const expectedVersion = numberOrUndefined(text(formData, "expectedVersion"));
  if (!applicationId || expectedVersion === undefined) {
    return {
      code: "VALIDATION_ERROR",
      message: "无法确认当前备注版本。浏览器草稿仍保留，请刷新页面后重试。",
      values: formValues(formData),
    };
  }

  try {
    const updated = await updateApplication(applicationId, {
      expectedVersion,
      notesMarkdown: rawText(formData, "notesMarkdown"),
    });
    refreshApplication(applicationId);
    return {
      ok: true,
      message: "备注已保存。",
      savedAtMs: updated.updatedAtMs,
      savedNotesMarkdown: updated.notesMarkdown,
      savedVersion: updated.version,
    };
  } catch (error) {
    return safeError(error, formData);
  }
}

export async function setStageAction(_state: FormState, formData: FormData): Promise<FormState> {
  const applicationId = text(formData, "applicationId");
  try {
    await setApplicationStage(
      applicationId,
      parseDomainInput(activeApplicationStageSchema, text(formData, "stage")),
      numberOrUndefined(text(formData, "expectedVersion")),
    );
  } catch (error) {
    return safeError(error, formData);
  }
  refreshApplication(applicationId);
  return { ok: true, message: "阶段已更新，并记录到时间线。" };
}

export async function setAttentionAction(_state: FormState, formData: FormData): Promise<FormState> {
  const applicationId = text(formData, "applicationId");
  const mode = text(formData, "mode");
  try {
    if (mode === "ACTION") {
      const dueAt = text(formData, "dueAt");
      const startsAtMs = dueAt ? localDateTime(dueAt) : null;
      if (dueAt && startsAtMs == null) return { code: "VALIDATION_ERROR", fieldErrors: { dueAt: "截止时间无效" }, message: "请检查时间。", values: formValues(formData) };
      await setApplicationAttention(applicationId, {
        mode: "ACTION",
        title: text(formData, "title"),
        ...(startsAtMs != null ? { due: { kind: "TIMED" as const, startsAtMs } } : {}),
      }, numberOrUndefined(text(formData, "expectedVersion")));
    } else if (mode === "WAITING") {
      const reviewAt = text(formData, "reviewAt");
      const startsAtMs = localDateTime(reviewAt);
      if (!reviewAt || startsAtMs == null) return { code: "VALIDATION_ERROR", fieldErrors: { reviewAt: "请填写有效的复查时间" }, message: "等待状态必须设置复查时间。", values: formValues(formData) };
      await setApplicationAttention(applicationId, { mode: "WAITING", waitingFor: optionalText(formData, "waitingFor"), review: { kind: "TIMED", startsAtMs } }, numberOrUndefined(text(formData, "expectedVersion")));
    } else {
      await setApplicationAttention(applicationId, { mode: "NEEDS_ACTION" }, numberOrUndefined(text(formData, "expectedVersion")));
    }
  } catch (error) {
    return safeError(error, formData);
  }
  refreshApplication(applicationId);
  return { ok: true, message: mode === "NEEDS_ACTION" ? "已加入“缺少下一步”队列。" : "推进方式已保存。" };
}

export async function archiveApplicationAction(_state: FormState, formData: FormData): Promise<FormState> {
  const applicationId = text(formData, "applicationId");
  try {
    await archiveApplication(applicationId, {
      reason: parseDomainInput(archiveReasonSchema, text(formData, "reason")),
      note: optionalText(formData, "note"),
      expectedVersion: numberOrUndefined(text(formData, "expectedVersion")),
    });
  } catch (error) {
    return safeError(error, formData);
  }
  refreshApplication(applicationId);
  redirect(`/applications/${applicationId}?archived=1`);
}

export async function restoreApplicationAction(_state: FormState, formData: FormData): Promise<FormState> {
  const applicationId = text(formData, "applicationId");
  try {
    await restoreApplication(applicationId, {
      stage: parseDomainInput(activeApplicationStageSchema, text(formData, "stage")),
      attention: { mode: "NEEDS_ACTION" },
      expectedVersion: numberOrUndefined(text(formData, "expectedVersion")),
    });
  } catch (error) {
    return safeError(error, formData);
  }
  refreshApplication(applicationId);
  redirect(`/applications/${applicationId}?restored=1`);
}

export async function createEventAction(_state: FormState, formData: FormData): Promise<FormState> {
  const applicationId = text(formData, "applicationId");
  const isAllDay = text(formData, "isAllDay") === "true";
  let schedule: { kind: "ALL_DAY"; startDate: string; endDateExclusive: string } | { kind: "TIMED"; startsAtMs: number; endsAtMs?: number };
  if (isAllDay) {
    schedule = { kind: "ALL_DAY", startDate: text(formData, "startDate"), endDateExclusive: text(formData, "endDateExclusive") };
  } else {
    const startsAtMs = localDateTime(text(formData, "startsAt"));
    const rawEnd = text(formData, "endsAt");
    const endsAtMs = rawEnd ? localDateTime(rawEnd) : null;
    if (startsAtMs == null || (rawEnd && endsAtMs == null)) return { code: "VALIDATION_ERROR", fieldErrors: startsAtMs == null ? { startsAt: "请填写有效开始时间" } : { endsAt: "结束时间无效" }, message: "请检查事件时间。", values: formValues(formData) };
    schedule = { kind: "TIMED", startsAtMs, ...(endsAtMs != null ? { endsAtMs } : {}) };
  }

  try {
    await createEvent({
      allowConflicts: text(formData, "allowConflicts") === "true",
      applicationId,
      isHardDeadline: text(formData, "isHardDeadline") === "true",
      location: optionalText(formData, "location"),
      meetingUrl: optionalText(formData, "meetingUrl"),
      schedule,
      title: text(formData, "title"),
      type: parseDomainInput(eventTypeSchema, text(formData, "type")),
    });
  } catch (error) {
    return safeError(error, formData);
  }
  refreshApplication(applicationId);
  return { ok: true, message: "事件已创建。申请阶段不会自动改变。" };
}

export async function updateEventStatusAction(_state: FormState, formData: FormData): Promise<FormState> {
  const eventId = text(formData, "eventId");
  const requestedStatus = text(formData, "status");
  try {
    await updateEventStatus(eventId, {
      status: parseDomainInput(eventStatusSchema, requestedStatus),
      expectedVersion: numberOrUndefined(text(formData, "expectedVersion")),
    });
  } catch (error) {
    return safeError(error, formData);
  }
  refreshApplication();
  return {
    ok: true,
    message: requestedStatus === "COMPLETED"
      ? "事件已标记完成。若它对应当前推进，申请已进入“缺少下一步”；主阶段没有改变。"
      : requestedStatus === "CANCELLED"
        ? "事件已取消。若它对应当前推进，申请已进入“缺少下一步”；主阶段没有改变。"
        : "事件已重新设为待处理。",
  };
}
