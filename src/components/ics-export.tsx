"use client";

import { useState } from "react";

import type { IcsEventPreview } from "@/lib/ics";

type IcsExportProps = {
  label: string;
  scopeDescription: string;
  href: string;
  items: readonly IcsEventPreview[];
  presentation?: "panel" | "popover";
};

function safeDateTimeFormatter(timezone: string) {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  };

  try {
    return new Intl.DateTimeFormat("zh-CN", options);
  } catch {
    return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone: "UTC" });
  }
}

function formatIsoDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function previousIsoDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function formatSchedule(item: IcsEventPreview) {
  if (item.schedule.kind === "ALL_DAY") {
    const endDate = previousIsoDate(item.schedule.endDateExclusive);
    const range = endDate === item.schedule.startDate
      ? formatIsoDate(item.schedule.startDate)
      : `${formatIsoDate(item.schedule.startDate)} 至 ${formatIsoDate(endDate)}`;
    return `全天 · ${range}`;
  }

  const formatter = safeDateTimeFormatter(item.timezone);
  const start = formatter.format(new Date(item.schedule.startsAtMs));
  const end = item.schedule.endsAtMs == null
    ? null
    : formatter.format(new Date(item.schedule.endsAtMs));
  return `${start}${end ? ` 至 ${end}` : ""}（${item.timezone}）`;
}

function scheduleStartDate(item: IcsEventPreview) {
  if (item.schedule.kind === "ALL_DAY") return item.schedule.startDate;
  let formatter: Intl.DateTimeFormat;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: item.timezone,
  };
  try {
    formatter = new Intl.DateTimeFormat("en-CA", options);
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" });
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(item.schedule.startsAtMs))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatDateRange(items: readonly IcsEventPreview[]) {
  if (items.length === 0) return "无";
  const dates = items.map(scheduleStartDate).sort();
  const first = formatIsoDate(dates[0]);
  const last = formatIsoDate(dates.at(-1)!);
  return first === last ? first : `${first} 至 ${last}`;
}

function formatReminder(minutes: number) {
  if (minutes % (24 * 60) === 0) return `提前 ${minutes / (24 * 60)} 天`;
  if (minutes % 60 === 0) return `提前 ${minutes / 60} 小时`;
  return `提前 ${minutes} 分钟`;
}

function formatReminders(minutes: readonly number[]) {
  return minutes.length ? minutes.map(formatReminder).join("、") : "无提醒";
}

function responseFilename(header: string | null) {
  const match = header?.match(/filename="([A-Za-z0-9._-]+)"/i);
  return match?.[1] ?? "campus-hire-tracker.ics";
}

export function IcsExport({
  label,
  scopeDescription,
  href,
  items,
  presentation = "panel",
}: IcsExportProps) {
  const [downloadState, setDownloadState] = useState<{
    kind: "idle" | "loading" | "success" | "error";
    message?: string;
  }>({ kind: "idle" });

  async function downloadCalendar() {
    setDownloadState({ kind: "loading" });
    try {
      const response = await fetch(href, {
        cache: "no-store",
        headers: { Accept: "text/calendar" },
      });
      if (!response.ok) {
        const serverMessage = (await response.text()).trim();
        setDownloadState({
          kind: "error",
          message: response.status === 409
            ? "事件内容已经变化，请刷新本页并重新核对预览。"
            : serverMessage || "日历文件生成失败，请稍后重试。",
        });
        return;
      }
      if (!response.headers.get("content-type")?.toLowerCase().includes("text/calendar")) {
        throw new Error("unexpected calendar response");
      }

      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = responseFilename(response.headers.get("content-disposition"));
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      setDownloadState({ kind: "success", message: "ICS 文件已下载，请在系统日历中导入。" });
    } catch {
      setDownloadState({ kind: "error", message: "日历文件生成失败，请确认本地服务仍在运行后重试。" });
    }
  }

  return (
    <details className={`ics-export ics-export-${presentation}`}>
      <summary className={presentation === "popover" ? "button button-compact" : "button"}>{label}</summary>
      <div className="ics-export-preview" role="region" aria-label={`${label}预览`}>
        <div className="ics-export-preview-heading">
          <div>
            <p className="eyebrow">ICS 导出预览</p>
            <h3>{label}</h3>
          </div>
          <span className="status-pill tone-info">{items.length} 个事件</span>
        </div>

        <p className="ics-export-scope">{scopeDescription}</p>
        <dl className="ics-export-summary">
          <div><dt>事件数量</dt><dd>{items.length}</dd></div>
          <div><dt>日期范围</dt><dd>{formatDateRange(items)}</dd></div>
        </dl>

        {items.length ? (
          <ol className="ics-preview-list">
            {items.map((item) => (
              <li key={item.eventId}>
                <article className="ics-preview-event">
                  <h4>{item.summary}</h4>
                  <dl>
                    <div><dt>时间</dt><dd>{formatSchedule(item)}</dd></div>
                    <div><dt>地点</dt><dd>{item.location || "不包含"}</dd></div>
                    <div>
                      <dt>链接</dt>
                      <dd>{item.url ? <a className="text-link" href={item.url} rel="noreferrer noopener" target="_blank">{item.url}</a> : "不包含"}</dd>
                    </div>
                    <div><dt>描述</dt><dd className="ics-preview-description">{item.description}</dd></div>
                    <div><dt>提醒</dt><dd>{formatReminders(item.reminderMinutes)}</dd></div>
                  </dl>
                </article>
              </li>
            ))}
          </ol>
        ) : <p className="muted">这个范围内目前没有可导出的事件。</p>}

        <div className="ics-export-boundary">
          <strong>这是单向导出</strong>
          <p>系统日历中的修改不会回写到秋招进度板。普通备注不会包含在导出文件中；文件也不会自动加入系统日历。</p>
        </div>

        {items.length ? (
          <button
            className="button button-primary ics-download-button"
            disabled={downloadState.kind === "loading"}
            onClick={downloadCalendar}
            type="button"
          >
            {downloadState.kind === "loading" ? "正在生成…" : "下载 ICS 文件"}
          </button>
        ) : (
          <span className="button ics-download-button" aria-disabled="true">暂无可下载事件</span>
        )}
        {downloadState.message ? (
          <div
            className={`form-message ${downloadState.kind === "success" ? "is-success" : "is-error"}`}
            role={downloadState.kind === "success" ? "status" : "alert"}
          >
            {downloadState.message}
          </div>
        ) : null}
      </div>
    </details>
  );
}
