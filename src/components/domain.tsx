import Link from "next/link";
import type { ReactNode } from "react";
import { CalendarIcon, ClockIcon } from "@/components/icons";
import { StatusPill } from "@/components/ui";

export const applicationStages = [
  ["OPPORTUNITY_POOL", "机会池"],
  ["PREPARING", "准备投递"],
  ["APPLIED", "已投递"],
  ["ASSESSMENT", "测评 / 笔试"],
  ["INTERVIEWING", "面试中"],
  ["OFFER", "Offer"],
  ["ARCHIVED", "已归档"],
] as const;

export const activeApplicationStages = applicationStages.filter(
  ([code]) => code !== "ARCHIVED",
);

export const priorities = [
  ["HIGH", "高"],
  ["MEDIUM", "中"],
  ["LOW", "低"],
] as const;

export const eventTypes = [
  ["INTERVIEW", "面试"],
  ["ASSESSMENT", "测评"],
  ["WRITTEN_TEST", "笔试"],
  ["APPLICATION_DEADLINE", "投递截止"],
  ["FOLLOW_UP", "跟进 / 复查"],
  ["OTHER", "其他"],
] as const;

export type ApplicationView = {
  id: string;
  companyName: string;
  positionTitle: string;
  cycleLabel?: string | null;
  stage: string;
  priority: string;
  attentionMode: string;
  nextActionTitle?: string | null;
  waitingFor?: string | null;
  reviewAtMs?: number | null;
  reviewDate?: string | null;
  nextEventTitle?: string | null;
  nextEventAtMs?: number | null;
  updatedAtMs?: number | null;
  isSample?: boolean;
};

export type EventView = {
  id: string;
  applicationId?: string | null;
  applicationLabel?: string | null;
  companyName?: string | null;
  positionTitle?: string | null;
  type: string;
  title: string;
  status: string;
  isAllDay: boolean;
  startsAtMs?: number | null;
  endsAtMs?: number | null;
  allDayStartDate?: string | null;
  allDayEndDateExclusive?: string | null;
  timezone?: string | null;
  location?: string | null;
  meetingUrl?: string | null;
  isHardDeadline?: boolean;
  isConflict?: boolean;
};

export type TimelineView = {
  id: string;
  entryType: string;
  summary: string;
  happenedAtMs: number;
};

const stageLabels = Object.fromEntries(applicationStages) as Record<string, string>;
const priorityLabels = Object.fromEntries(priorities) as Record<string, string>;
const eventTypeLabels = Object.fromEntries(eventTypes) as Record<string, string>;

export function stageLabel(stage: string) {
  return stageLabels[stage] ?? stage;
}

export function priorityLabel(priority: string) {
  return priorityLabels[priority] ?? priority;
}

export function eventTypeLabel(type: string) {
  return eventTypeLabels[type] ?? type;
}

export function formatDateTime(value?: number | null, options?: { dateOnly?: boolean }) {
  if (!value) return "未设置";
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    ...(options?.dateOnly ? {} : { hour: "2-digit", minute: "2-digit", hour12: false }),
  });
  return formatter.format(new Date(value));
}

export function formatDate(date?: string | null) {
  if (!date) return "未设置";
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? date
    : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", weekday: "short" }).format(parsed);
}

export function AttentionSummary({ application }: { application: ApplicationView }) {
  if (application.attentionMode === "ACTION") {
    return (
      <div className="attention-line attention-action">
        <span className="attention-marker" />
        <span><strong>下一步</strong>{application.nextActionTitle || "待填写"}</span>
      </div>
    );
  }

  if (application.attentionMode === "WAITING") {
    const date = application.reviewAtMs
      ? formatDateTime(application.reviewAtMs)
      : formatDate(application.reviewDate);
    return (
      <div className="attention-line attention-waiting">
        <ClockIcon size={15} />
        <span><strong>等待中</strong>{application.waitingFor || "等待结果"} · {date}复查</span>
      </div>
    );
  }

  if (application.attentionMode === "INACTIVE") {
    return <div className="attention-line"><span>已归档，不参与今日提醒</span></div>;
  }

  return (
    <div className="attention-line attention-missing">
      <span className="attention-marker" />
      <span><strong>缺少下一步</strong>需要补充行动或复查日期</span>
    </div>
  );
}

export function ApplicationCard({ application, footer }: { application: ApplicationView; footer?: ReactNode }) {
  return (
    <article className="application-card">
      <Link className="application-card-link" href={`/applications/${application.id}`}>
        <div className="card-title-row">
          <div>
            <p className="company-name">{application.companyName}</p>
            <h3>{application.positionTitle}</h3>
          </div>
          <StatusPill tone={application.priority === "HIGH" ? "danger" : application.priority === "LOW" ? "neutral" : "warning"}>
            {priorityLabel(application.priority)}优先级
          </StatusPill>
        </div>
        {application.cycleLabel ? <p className="muted compact">{application.cycleLabel}</p> : null}
        <AttentionSummary application={application} />
        {application.nextEventTitle ? (
          <div className="next-event">
            <CalendarIcon size={15} />
            <span>{application.nextEventTitle}{application.nextEventAtMs ? ` · ${formatDateTime(application.nextEventAtMs)}` : ""}</span>
          </div>
        ) : null}
      </Link>
      {footer ? <div className="application-card-footer">{footer}</div> : null}
    </article>
  );
}

export function EventRow({ event, actions }: { event: EventView; actions?: ReactNode }) {
  const date = event.isAllDay ? formatDate(event.allDayStartDate) : formatDateTime(event.startsAtMs);
  return (
    <article className={event.status === "CANCELLED" ? "event-row is-cancelled" : "event-row"}>
      <div className="event-date-block">
        <span>{event.isAllDay ? "全天" : event.startsAtMs ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(event.startsAtMs)) : "—"}</span>
        <small>{date}</small>
      </div>
      <div className="event-row-content">
        <div className="event-heading">
          <StatusPill tone={event.isHardDeadline ? "danger" : event.type === "INTERVIEW" ? "accent" : "info"}>{eventTypeLabel(event.type)}</StatusPill>
          {event.isConflict ? <StatusPill tone="danger">时间冲突</StatusPill> : null}
          {event.status === "COMPLETED" ? <StatusPill tone="success">已完成</StatusPill> : null}
          {event.status === "CANCELLED" ? <StatusPill>已取消</StatusPill> : null}
        </div>
        <h3>{event.title}</h3>
        {event.applicationLabel || event.companyName ? <p>{event.applicationLabel || `${event.companyName ?? ""} · ${event.positionTitle ?? ""}`}</p> : null}
        {event.location ? <p className="muted compact">地点：{event.location}</p> : null}
      </div>
      {actions ? <div className="event-actions">{actions}</div> : null}
    </article>
  );
}

export function TimelineList({ entries }: { entries: TimelineView[] }) {
  if (entries.length === 0) return <p className="muted">还没有历史记录。</p>;
  return (
    <ol className="timeline-list">
      {entries.map((entry) => (
        <li key={entry.id}>
          <span className="timeline-dot" />
          <div>
            <p>{entry.summary}</p>
            <time dateTime={new Date(entry.happenedAtMs).toISOString()}>{formatDateTime(entry.happenedAtMs)}</time>
          </div>
        </li>
      ))}
    </ol>
  );
}
