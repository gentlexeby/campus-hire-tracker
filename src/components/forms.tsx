"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Field } from "@/components/ui";
import {
  activeApplicationStages,
  applicationStages,
  eventTypeLabel,
  eventTypes,
  formatDate,
  formatDateTime,
  priorities,
} from "@/components/domain";
import type { FormState } from "@/components/form-state";
import { initialFormState } from "@/components/form-state";

export type FormAction = (state: FormState, formData: FormData) => Promise<FormState>;

function SubmitButton({ children, pendingLabel = "正在保存…", className = "button button-primary" }: { children: React.ReactNode; pendingLabel?: string; className?: string }) {
  const { pending } = useFormStatus();
  return <button className={className} disabled={pending} type="submit">{pending ? pendingLabel : children}</button>;
}

function FormMessage({ state }: { state: FormState }) {
  if (!state.message) return null;
  return <div className={state.ok ? "form-message is-success" : "form-message is-error"} role={state.ok ? "status" : "alert"}>{state.message}</div>;
}

function value(state: FormState, name: string, fallback = "") {
  return state.values?.[name] ?? fallback;
}

function DuplicateDetails({ state }: { state: FormState }) {
  if (state.details?.kind !== "DUPLICATE_APPLICATIONS") return null;
  return (
    <div className="confirmation-summary" aria-label="重复申请详情">
      <strong>找到 {state.details.matches.length} 条相同申请</strong>
      <ul>
        {state.details.matches.map((match, index) => (
          <li key={`${match.companyName}-${match.positionTitle}-${index}`}>
            <span>{match.companyName} · {match.positionTitle}</span>
            <small>{match.cycleLabel || "招聘批次未填写"}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function conflictTime(conflict: Extract<NonNullable<FormState["details"]>, { kind: "EVENT_CONFLICTS" }>["conflicts"][number]) {
  if (conflict.schedule.kind === "ALL_DAY") {
    return `${formatDate(conflict.schedule.startDate)} · 全天`;
  }
  const start = formatDateTime(conflict.schedule.startsAtMs);
  const end = conflict.schedule.endsAtMs ? ` 至 ${formatDateTime(conflict.schedule.endsAtMs)}` : " · 时间点";
  return `${start}${end}`;
}

function ConflictDetails({ state }: { state: FormState }) {
  if (state.details?.kind !== "EVENT_CONFLICTS") return null;
  return (
    <div className="confirmation-summary" aria-label="冲突日程详情">
      <strong>与以下 {state.details.conflicts.length} 项日程冲突</strong>
      <ul>
        {state.details.conflicts.map((conflict, index) => (
          <li key={`${conflict.title}-${index}`}>
            <span>{conflict.title} · {eventTypeLabel(conflict.type)}</span>
            <small>{conflictTime(conflict)}{conflict.timezone ? ` · ${conflict.timezone}` : ""}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NewApplicationForm({ action }: { action: FormAction }) {
  const [state, formAction] = useActionState(action, initialFormState);
  const duplicateWarning = state.code === "DUPLICATE_CONFIRMATION_REQUIRED" || state.code === "DUPLICATE_APPLICATION" || state.code === "DUPLICATE_WARNING";
  const canConfirmDuplicate = state.details?.kind === "DUPLICATE_APPLICATIONS" && state.details.matches.length > 0;

  return (
    <form action={formAction} className="stack-form">
      <FormMessage state={state} />
      <div className="form-grid">
        <Field label="公司" required error={state.fieldErrors?.companyName}>
          <input autoFocus className="input" defaultValue={value(state, "companyName")} maxLength={120} name="companyName" placeholder="例如：字节跳动" required />
        </Field>
        <Field label="岗位" required error={state.fieldErrors?.positionTitle}>
          <input className="input" defaultValue={value(state, "positionTitle")} maxLength={160} name="positionTitle" placeholder="例如：后端开发工程师" required />
        </Field>
        <Field label="招聘批次" hint="可留空，例如“2027 秋招”" error={state.fieldErrors?.cycleLabel}>
          <input className="input" defaultValue={value(state, "cycleLabel")} maxLength={80} name="cycleLabel" placeholder="2027 秋招" />
        </Field>
        <Field label="优先级" error={state.fieldErrors?.priority}>
          <select className="select" defaultValue={value(state, "priority", "MEDIUM")} name="priority">
            {priorities.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </Field>
      </div>

      <details className="form-details">
        <summary>添加更多信息</summary>
        <div className="form-grid details-grid">
          <Field label="初始阶段" error={state.fieldErrors?.stage}>
            <select className="select" defaultValue={value(state, "stage", "OPPORTUNITY_POOL")} name="stage">
              {activeApplicationStages.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </Field>
          <Field label="地点" error={state.fieldErrors?.location}>
            <input className="input" defaultValue={value(state, "location")} maxLength={120} name="location" placeholder="例如：上海 / 远程" />
          </Field>
          <Field label="来源" error={state.fieldErrors?.sourceKind}>
            <select className="select" defaultValue={value(state, "sourceKind", "UNSPECIFIED")} name="sourceKind">
              <option value="UNSPECIFIED">未填写</option>
              <option value="OFFICIAL_SITE">官网</option>
              <option value="JOB_PLATFORM">招聘平台</option>
              <option value="REFERRAL">内推</option>
              <option value="CAMPUS_CHANNEL">校园渠道</option>
              <option value="CUSTOM">自定义</option>
            </select>
          </Field>
          <Field label="来源链接" error={state.fieldErrors?.sourceUrl}>
            <input className="input" defaultValue={value(state, "sourceUrl")} maxLength={2048} name="sourceUrl" placeholder="https://…" type="url" />
          </Field>
          <Field label="自定义来源" hint="仅在来源选择“自定义”时填写" error={state.fieldErrors?.sourceDetail}>
            <input className="input" defaultValue={value(state, "sourceDetail")} maxLength={120} name="sourceDetail" />
          </Field>
          <Field label="下一步行动" hint="可以稍后设置；留空后会进入“缺少下一步”" error={state.fieldErrors?.nextActionTitle}>
            <input className="input" defaultValue={value(state, "nextActionTitle")} maxLength={200} name="nextActionTitle" placeholder="例如：今晚完善简历" />
          </Field>
        </div>
      </details>

      {duplicateWarning ? <DuplicateDetails state={state} /> : null}
      {duplicateWarning && canConfirmDuplicate ? (
        <label className="confirm-check">
          <input name="allowDuplicate" required type="checkbox" value="true" />
          <span>以上记录与本次申请重复；我仍要创建一条独立申请</span>
        </label>
      ) : null}
      {duplicateWarning && !canConfirmDuplicate ? <p className="notice notice-warning">未能生成可安全展示的重复摘要。请先返回申请列表核对，再重试。</p> : null}
      <div className="form-actions">
        <Link className="button" href="/applications">取消</Link>
        {!duplicateWarning || canConfirmDuplicate ? <SubmitButton>{duplicateWarning ? "确认创建" : "创建申请"}</SubmitButton> : null}
      </div>
    </form>
  );
}

export function ApplicationBasicsForm({ action, application }: { action: FormAction; application: { id: string; version?: number; companyName: string; positionTitle: string; cycleLabel?: string | null; priority: string; location?: string | null; sourceKind?: string | null; sourceDetail?: string | null; sourceUrl?: string | null } }) {
  const [state, formAction] = useActionState(action, initialFormState);
  return (
    <form action={formAction} className="stack-form compact-form">
      <input name="applicationId" type="hidden" value={application.id} />
      <input name="expectedVersion" type="hidden" value={application.version ?? ""} />
      <FormMessage state={state} />
      <div className="form-grid">
        <Field label="公司" required error={state.fieldErrors?.companyName}>
          <input className="input" defaultValue={value(state, "companyName", application.companyName)} maxLength={120} name="companyName" required />
        </Field>
        <Field label="岗位" required error={state.fieldErrors?.positionTitle}>
          <input className="input" defaultValue={value(state, "positionTitle", application.positionTitle)} maxLength={160} name="positionTitle" required />
        </Field>
        <Field label="招聘批次" error={state.fieldErrors?.cycleLabel}>
          <input className="input" defaultValue={value(state, "cycleLabel", application.cycleLabel ?? "")} maxLength={80} name="cycleLabel" />
        </Field>
        <Field label="优先级" error={state.fieldErrors?.priority}>
          <select className="select" defaultValue={value(state, "priority", application.priority)} name="priority">
            {priorities.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </Field>
        <Field label="地点" error={state.fieldErrors?.location}>
          <input className="input" defaultValue={value(state, "location", application.location ?? "")} maxLength={120} name="location" />
        </Field>
        <Field label="来源" error={state.fieldErrors?.sourceKind}>
          <select className="select" defaultValue={value(state, "sourceKind", application.sourceKind ?? "UNSPECIFIED")} name="sourceKind">
            <option value="UNSPECIFIED">未填写</option><option value="OFFICIAL_SITE">官网</option><option value="JOB_PLATFORM">招聘平台</option><option value="REFERRAL">内推</option><option value="CAMPUS_CHANNEL">校园渠道</option><option value="CUSTOM">自定义</option>
          </select>
        </Field>
        <Field label="自定义来源" error={state.fieldErrors?.sourceDetail}>
          <input className="input" defaultValue={value(state, "sourceDetail", application.sourceDetail ?? "")} maxLength={120} name="sourceDetail" />
        </Field>
        <Field label="来源链接" error={state.fieldErrors?.sourceUrl}>
          <input className="input" defaultValue={value(state, "sourceUrl", application.sourceUrl ?? "")} maxLength={2048} name="sourceUrl" type="url" />
        </Field>
      </div>
      <div className="form-actions"><SubmitButton>保存概览</SubmitButton></div>
    </form>
  );
}

export function StageForm({ action, applicationId, currentStage, expectedVersion }: { action: FormAction; applicationId: string; currentStage: string; expectedVersion?: number }) {
  const [state, formAction] = useActionState(action, initialFormState);
  return (
    <form action={formAction} className="inline-form">
      <input name="applicationId" type="hidden" value={applicationId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion ?? ""} />
      <label><span className="sr-only">主阶段</span><select className="select" defaultValue={currentStage} name="stage">{applicationStages.map(([code, label]) => <option key={code} value={code} disabled={code === "ARCHIVED"}>{label}</option>)}</select></label>
      <SubmitButton className="button button-compact">更新阶段</SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

function dateTimeInputValue(value?: number | null) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function AttentionForm({ action, applicationId, currentMode = "NEEDS_ACTION", nextActionTitle, waitingFor, attentionAtMs, attentionDate, expectedVersion }: { action: FormAction; applicationId: string; currentMode?: string; nextActionTitle?: string | null; waitingFor?: string | null; attentionAtMs?: number | null; attentionDate?: string | null; expectedVersion?: number }) {
  const initialMode = currentMode === "INACTIVE" ? "NEEDS_ACTION" : currentMode;
  const [mode, setMode] = useState(initialMode);
  const [state, formAction] = useActionState(action, initialFormState);
  return (
    <form action={formAction} className="stack-form compact-form">
      <input name="applicationId" type="hidden" value={applicationId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion ?? ""} />
      <FormMessage state={state} />
      <fieldset className="choice-group">
        <legend>当前最需要怎么推进？</legend>
        <label className={mode === "ACTION" ? "choice-card is-selected" : "choice-card"}><input checked={mode === "ACTION"} name="mode" onChange={() => setMode("ACTION")} type="radio" value="ACTION" /><span><strong>有下一步行动</strong><small>明确一件当前最重要的事</small></span></label>
        <label className={mode === "WAITING" ? "choice-card is-selected" : "choice-card"}><input checked={mode === "WAITING"} name="mode" onChange={() => setMode("WAITING")} type="radio" value="WAITING" /><span><strong>等待中</strong><small>设置一个复查时间，避免无限等待</small></span></label>
        <label className={mode === "NEEDS_ACTION" ? "choice-card is-selected" : "choice-card"}><input checked={mode === "NEEDS_ACTION"} name="mode" onChange={() => setMode("NEEDS_ACTION")} type="radio" value="NEEDS_ACTION" /><span><strong>稍后补充</strong><small>会进入今日的“缺少下一步”</small></span></label>
      </fieldset>
      {mode === "ACTION" ? <div className="form-grid"><Field label="下一步行动" required error={state.fieldErrors?.title}><input className="input" defaultValue={value(state, "title", nextActionTitle ?? "")} maxLength={200} name="title" required /></Field><Field label="截止时间" hint="可选"><input className="input" defaultValue={value(state, "dueAt", dateTimeInputValue(attentionAtMs))} name="dueAt" type="datetime-local" /></Field></div> : null}
      {mode === "WAITING" ? <div className="form-grid"><Field label="等待对象" hint="可选，例如 HR 回复"><input className="input" defaultValue={value(state, "waitingFor", waitingFor ?? "")} maxLength={200} name="waitingFor" /></Field><Field label="复查时间" required error={state.fieldErrors?.reviewAt}><input className="input" defaultValue={value(state, "reviewAt", dateTimeInputValue(attentionAtMs) || (attentionDate ? `${attentionDate}T09:00` : ""))} name="reviewAt" required type="datetime-local" /></Field></div> : null}
      {mode === "NEEDS_ACTION" ? <p className="notice notice-warning">保存后，这条申请会明确进入“缺少下一步”队列，不会被系统自动填入行动。</p> : null}
      <div className="form-actions"><SubmitButton>保存推进方式</SubmitButton></div>
    </form>
  );
}

export function ArchiveForm({ action, applicationId, expectedVersion }: { action: FormAction; applicationId: string; expectedVersion?: number }) {
  const [state, formAction] = useActionState(action, initialFormState);
  return (
    <form action={formAction} className="stack-form compact-form">
      <input name="applicationId" type="hidden" value={applicationId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion ?? ""} />
      <FormMessage state={state} />
      <div className="form-grid">
        <Field label="归档原因" required error={state.fieldErrors?.reason}><select className="select" defaultValue={value(state, "reason", "REJECTED")} name="reason"><option value="REJECTED">被拒绝</option><option value="ABANDONED">主动放弃</option><option value="WITHDRAWN">撤回申请</option><option value="OTHER">其他</option></select></Field>
        <Field label="补充说明" hint="选择“其他”时必填" error={state.fieldErrors?.note}><input className="input" defaultValue={value(state, "note")} maxLength={500} name="note" /></Field>
      </div>
      <p className="muted compact">归档后会从活跃列表与今日提醒中移除，事件和时间线仍保留。</p>
      <div className="form-actions"><SubmitButton className="button button-danger">归档申请</SubmitButton></div>
    </form>
  );
}

export function RestoreForm({ action, applicationId, suggestedStage = "OPPORTUNITY_POOL", expectedVersion }: { action: FormAction; applicationId: string; suggestedStage?: string; expectedVersion?: number }) {
  const [state, formAction] = useActionState(action, initialFormState);
  return (
    <form action={formAction} className="stack-form compact-form">
      <input name="applicationId" type="hidden" value={applicationId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion ?? ""} />
      <FormMessage state={state} />
      <Field label="恢复到" required><select className="select" defaultValue={suggestedStage} name="stage">{activeApplicationStages.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></Field>
      <p className="muted compact">恢复后先进入“缺少下一步”，再由你设置行动或复查日期；旧的行动不会自动复活。</p>
      <div className="form-actions"><SubmitButton>恢复为活跃</SubmitButton></div>
    </form>
  );
}

export function EventForm({ action, applications, defaultApplicationId }: { action: FormAction; applications: Array<{ id: string; companyName: string; positionTitle: string }>; defaultApplicationId?: string }) {
  const [state, formAction] = useActionState(action, initialFormState);
  const [allDay, setAllDay] = useState(value(state, "isAllDay") === "true");
  const conflictWarning = state.code === "EVENT_CONFLICT_CONFIRMATION_REQUIRED" || state.code === "EVENT_CONFLICT" || state.code === "CONFLICT_WARNING";
  const canConfirmConflict = state.details?.kind === "EVENT_CONFLICTS" && state.details.conflicts.length > 0;
  return (
    <form action={formAction} className="stack-form compact-form">
      <FormMessage state={state} />
      <div className="form-grid">
        <Field label="事件类型" required error={state.fieldErrors?.type}><select className="select" defaultValue={value(state, "type", "INTERVIEW")} name="type">{eventTypes.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></Field>
        <Field label="关联申请" required error={state.fieldErrors?.applicationId}><select className="select" defaultValue={value(state, "applicationId", defaultApplicationId ?? "")} name="applicationId" required><option disabled value="">请选择申请</option>{applications.map((item) => <option key={item.id} value={item.id}>{item.companyName} · {item.positionTitle}</option>)}</select></Field>
        <Field label="标题" required error={state.fieldErrors?.title}><input className="input" defaultValue={value(state, "title")} maxLength={200} name="title" placeholder="例如：技术一面" required /></Field>
        <label className="checkbox-field"><input checked={allDay} name="isAllDay" onChange={(event) => setAllDay(event.target.checked)} type="checkbox" value="true" /><span>这是全天事件</span></label>
        {allDay ? <><Field label="开始日期" required error={state.fieldErrors?.startDate}><input className="input" defaultValue={value(state, "startDate")} name="startDate" required type="date" /></Field><Field label="结束日期（不含）" required hint="单日事件请选择下一天" error={state.fieldErrors?.endDateExclusive}><input className="input" defaultValue={value(state, "endDateExclusive")} name="endDateExclusive" required type="date" /></Field></> : <><Field label="开始时间" required error={state.fieldErrors?.startsAt}><input className="input" defaultValue={value(state, "startsAt")} name="startsAt" required type="datetime-local" /></Field><Field label="结束时间" hint="可选；留空表示时间点" error={state.fieldErrors?.endsAt}><input className="input" defaultValue={value(state, "endsAt")} name="endsAt" type="datetime-local" /></Field></>}
        <Field label="地点" error={state.fieldErrors?.location}><input className="input" defaultValue={value(state, "location")} maxLength={200} name="location" /></Field>
        <Field label="会议链接" error={state.fieldErrors?.meetingUrl}><input className="input" defaultValue={value(state, "meetingUrl")} maxLength={2048} name="meetingUrl" type="url" /></Field>
        <label className="checkbox-field"><input defaultChecked={value(state, "isHardDeadline") === "true"} name="isHardDeadline" type="checkbox" value="true" /><span>这是硬截止</span></label>
      </div>
      {conflictWarning ? <ConflictDetails state={state} /> : null}
      {conflictWarning && canConfirmConflict ? <label className="confirm-check"><input name="allowConflicts" required type="checkbox" value="true" /><span>以上日程与本事件时间冲突；我仍要保存</span></label> : null}
      {conflictWarning && !canConfirmConflict ? <p className="notice notice-warning">未能生成可安全展示的冲突摘要。请先到日历核对，再重试。</p> : null}
      <div className="form-actions">{!conflictWarning || canConfirmConflict ? <SubmitButton>{conflictWarning ? "确认保存事件" : "创建事件"}</SubmitButton> : null}</div>
    </form>
  );
}

export function EventStatusForm({ action, available = true, eventId, expectedVersion, status, label, tone = "" }: { action: FormAction; available?: boolean; eventId: string; expectedVersion?: number; status: "COMPLETED" | "CANCELLED" | "SCHEDULED"; label: string; tone?: string }) {
  const [state, formAction] = useActionState(action, initialFormState);
  if (!available && !state.message) return null;
  return (
    <div className="event-status-control">
      {available && !state.ok ? <form action={formAction}><input name="eventId" type="hidden" value={eventId} /><input name="expectedVersion" type="hidden" value={expectedVersion ?? ""} /><input name="status" type="hidden" value={status} /><SubmitButton className={`button button-compact ${tone}`.trim()} pendingLabel="处理中…">{label}</SubmitButton></form> : null}
      <FormMessage state={state} />
    </div>
  );
}
