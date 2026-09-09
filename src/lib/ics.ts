import { createHash } from "node:crypto";

import type { EventType } from "@/lib/domain";
import type { EventDto } from "@/lib/services";

const CRLF = "\r\n";
const TEXT_ENCODER = new TextEncoder();
const DEFAULT_CALENDAR_NAME = "秋招日程";
const PRODID = "-//Campus Hire Tracker//Campus Hire Tracker//ZH-CN";

export type IcsExportScope = "event" | "visible" | "future";
export type IcsSupportedEventType = EventType | "RECRUITMENT_FAIR";

export interface IcsEventInput {
  event: EventDto;
  companyName: string;
  positionTitle: string;
  /** Overrides the type defaults. An empty array explicitly disables alarms. */
  reminderMinutes?: readonly number[];
}

export interface IcsCalendarOptions {
  /** Captured once by the caller so every event gets one deterministic DTSTAMP. */
  exportedAtMs: number;
  calendarName?: string;
}

export interface IcsEventPreview {
  eventId: string;
  summary: string;
  schedule: EventDto["schedule"];
  timezone: string;
  location: string | null;
  url: string | null;
  description: string;
  reminderMinutes: readonly number[];
}

const EVENT_TYPE_LABELS: Readonly<Record<IcsSupportedEventType, string>> = {
  INTERVIEW: "面试",
  ASSESSMENT: "测评",
  WRITTEN_TEST: "笔试",
  RECRUITMENT_FAIR: "招聘会",
  APPLICATION_DEADLINE: "投递截止",
  ACTION_DUE: "行动截止",
  FOLLOW_UP: "跟进复查",
  OTHER: "其他日程",
};

const DAY_AND_HOUR = Object.freeze([24 * 60, 60]);
const THREE_DAYS_AND_DAY = Object.freeze([3 * 24 * 60, 24 * 60]);
const DAY = Object.freeze([24 * 60]);
const NO_REMINDERS = Object.freeze([]) as readonly number[];

function assertSafeEpochMs(value: number, field: string): Date {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} 必须是非负的安全整数毫秒时间戳`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${field} 不是有效时间`);
  }
  if (date.getUTCFullYear() > 9_999) {
    throw new TypeError(`${field} 超出 ICS 四位年份范围`);
  }
  return date;
}

function formatUtcDateTime(value: number, field: string): string {
  return assertSafeEpochMs(value, field)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function formatUtcFilenameTime(value: number): string {
  const utc = formatUtcDateTime(value, "exportedAtMs");
  return `${utc.slice(0, 8)}-${utc.slice(9)}`;
}

function formatDateValue(value: string, field: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`${field} 必须是 YYYY-MM-DD`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new TypeError(`${field} 不是有效日期`);
  }
  return `${match[1]}${match[2]}${match[3]}`;
}

function normalizeUserText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/\t/g, " ");
}

function requiredUserText(value: string, field: string): string {
  const normalized = normalizeUserText(value).trim();
  if (!normalized) throw new TypeError(`${field} 不能为空`);
  return normalized;
}

function optionalUserText(value: string | null): string | null {
  if (value == null) return null;
  const normalized = normalizeUserText(value).trim();
  return normalized || null;
}

function escapeText(value: string): string {
  return normalizeUserText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function serializeHttpUrl(value: string | null): string | null {
  if (value == null) return null;
  if (/[\u0000-\u0020\u007f-\u009f]/.test(value)) {
    throw new TypeError("日历链接包含非法控制字符或空白");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("日历链接不是有效 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("日历链接只支持 http 或 https");
  }
  return parsed.toString();
}

function validateUid(value: string): string {
  if (!value || value.length > 1_024 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new TypeError("事件缺少合法的稳定 ICS UID");
  }
  return value;
}

function normalizeReminderMinutes(values: readonly number[]): readonly number[] {
  const unique = new Set<number>();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("提醒提前分钟数必须是非负安全整数");
    }
    unique.add(value);
  }
  return Object.freeze([...unique].sort((left, right) => right - left));
}

function formatDuration(minutes: number): string {
  if (minutes === 0) return "PT0M";
  const days = Math.floor(minutes / (24 * 60));
  const afterDays = minutes % (24 * 60);
  const hours = Math.floor(afterDays / 60);
  const remainingMinutes = afterDays % 60;
  const datePart = days > 0 ? `${days}D` : "";
  const timePart = hours > 0 || remainingMinutes > 0
    ? `T${hours > 0 ? `${hours}H` : ""}${remainingMinutes > 0 ? `${remainingMinutes}M` : ""}`
    : "";
  return `P${datePart}${timePart}`;
}

function foldContentLine(line: string): string[] {
  if (line.includes("\r") || line.includes("\n")) {
    throw new TypeError("ICS content line 不能包含裸换行");
  }
  if (TEXT_ENCODER.encode(line).byteLength <= 75) return [line];

  const physicalLines: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const codePoint of line) {
    const codePointBytes = TEXT_ENCODER.encode(codePoint).byteLength;
    if (currentBytes + codePointBytes > 75) {
      physicalLines.push(current);
      current = ` ${codePoint}`;
      currentBytes = 1 + codePointBytes;
    } else {
      current += codePoint;
      currentBytes += codePointBytes;
    }
  }
  physicalLines.push(current);
  return physicalLines;
}

function serializeContentLines(lines: readonly string[]): string {
  return `${lines.flatMap(foldContentLine).join(CRLF)}${CRLF}`;
}

function scheduleSortKey(event: EventDto): string {
  if (event.schedule.kind === "TIMED") {
    return `${assertSafeEpochMs(event.schedule.startsAtMs, "startsAtMs").toISOString()}\u0001${event.icsUid}`;
  }
  formatDateValue(event.schedule.startDate, "startDate");
  return `${event.schedule.startDate}T00:00:00.000\u0001${event.icsUid}`;
}

function renderEvent(
  input: IcsEventInput,
  preview: IcsEventPreview,
  dtstamp: string,
): string[] {
  const { event } = input;
  const uid = validateUid(event.icsUid);
  if (!Number.isSafeInteger(event.version) || event.version < 0) {
    throw new TypeError("事件 SEQUENCE 必须是非负安全整数");
  }

  const lines = [
    "BEGIN:VEVENT",
    `UID:${escapeText(uid)}`,
    `DTSTAMP:${dtstamp}`,
    `SEQUENCE:${event.version}`,
  ];

  if (event.schedule.kind === "TIMED") {
    const start = formatUtcDateTime(event.schedule.startsAtMs, "startsAtMs");
    lines.push(`DTSTART:${start}`);
    if (event.schedule.endsAtMs != null) {
      if (event.schedule.endsAtMs <= event.schedule.startsAtMs) {
        throw new TypeError("定时事件结束时间必须晚于开始时间");
      }
      const end = formatUtcDateTime(event.schedule.endsAtMs, "endsAtMs");
      if (end <= start) {
        throw new TypeError("定时事件按秒导出后的结束时间必须晚于开始时间");
      }
      lines.push(`DTEND:${end}`);
    }
  } else {
    const start = formatDateValue(event.schedule.startDate, "startDate");
    const end = formatDateValue(event.schedule.endDateExclusive, "endDateExclusive");
    if (event.schedule.endDateExclusive <= event.schedule.startDate) {
      throw new TypeError("全天事件结束日期必须晚于开始日期");
    }
    lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`);
  }

  lines.push(
    `SUMMARY:${escapeText(preview.summary)}`,
    `DESCRIPTION:${escapeText(preview.description)}`,
  );
  if (preview.location) lines.push(`LOCATION:${escapeText(preview.location)}`);
  if (preview.url) lines.push(`URL:${preview.url}`);

  for (const minutes of preview.reminderMinutes) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `TRIGGER:${minutes === 0 ? "PT0M" : `-${formatDuration(minutes)}`}`,
      `DESCRIPTION:${escapeText(`提醒：${preview.summary}`)}`,
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT");
  return lines;
}

export function defaultIcsReminderOffsets(type: IcsSupportedEventType): readonly number[] {
  switch (type) {
    case "INTERVIEW":
    case "ASSESSMENT":
    case "WRITTEN_TEST":
    case "RECRUITMENT_FAIR":
      return DAY_AND_HOUR;
    case "APPLICATION_DEADLINE":
    case "ACTION_DUE":
      return THREE_DAYS_AND_DAY;
    case "FOLLOW_UP":
      return DAY;
    case "OTHER":
      return NO_REMINDERS;
  }
}

export function buildIcsPreview(input: IcsEventInput): IcsEventPreview {
  const type = input.event.type as IcsSupportedEventType;
  const companyName = requiredUserText(input.companyName, "公司名称");
  const positionTitle = requiredUserText(input.positionTitle, "岗位名称");
  const eventTitle = requiredUserText(input.event.title, "事件标题");
  const typeLabel = EVENT_TYPE_LABELS[type];
  if (!typeLabel) throw new TypeError("不支持的事件类型");
  const reminderMinutes = normalizeReminderMinutes(
    input.reminderMinutes ?? defaultIcsReminderOffsets(type),
  );

  return {
    eventId: input.event.id,
    summary: `【${typeLabel}】${companyName} · ${positionTitle} · ${eventTitle}`,
    schedule: input.event.schedule,
    timezone: input.event.timezone,
    location: optionalUserText(input.event.location),
    url: serializeHttpUrl(input.event.meetingUrl),
    description: `申请：${companyName} · ${positionTitle}\n类型：${typeLabel}`,
    reminderMinutes,
  };
}

export function buildIcsCalendar(
  inputs: readonly IcsEventInput[],
  options: IcsCalendarOptions,
): string {
  const dtstamp = formatUtcDateTime(options.exportedAtMs, "exportedAtMs");
  const calendarName = requiredUserText(options.calendarName ?? DEFAULT_CALENDAR_NAME, "日历名称");

  const seenUids = new Set<string>();
  for (const { event } of inputs) {
    const uid = validateUid(event.icsUid);
    if (seenUids.has(uid)) throw new TypeError("同一日历不能包含重复的事件 UID");
    seenUids.add(uid);
    if (event.status === "CANCELLED") {
      throw new TypeError("日历快照不能包含已取消事件");
    }
  }

  const sorted = [...inputs].sort((left, right) => {
    const leftKey = scheduleSortKey(left.event);
    const rightKey = scheduleSortKey(right.event);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const input of sorted) {
    lines.push(...renderEvent(input, buildIcsPreview(input), dtstamp));
  }
  lines.push("END:VCALENDAR");
  return serializeContentLines(lines);
}

/** Detects preview/download drift. This unkeyed digest is not an authorization token. */
export function buildIcsSnapshotId(inputs: readonly IcsEventInput[]): string {
  const records = inputs.map((input) => {
    const { event } = input;
    const preview = buildIcsPreview(input);
    const uid = validateUid(event.icsUid);
    if (!Number.isSafeInteger(event.version) || event.version < 0) {
      throw new TypeError("事件 SEQUENCE 必须是非负安全整数");
    }
    const schedule = event.schedule.kind === "TIMED"
      ? ["TIMED", event.schedule.startsAtMs, event.schedule.endsAtMs ?? null]
      : ["ALL_DAY", event.schedule.startDate, event.schedule.endDateExclusive];
    return {
      eventId: event.id,
      uid,
      sequence: event.version,
      status: event.status,
      schedule,
      timezone: preview.timezone,
      summary: preview.summary,
      location: preview.location,
      url: preview.url,
      description: preview.description,
      reminderMinutes: [...preview.reminderMinutes],
    };
  }).sort((left, right) => {
    if (left.eventId !== right.eventId) return left.eventId < right.eventId ? -1 : 1;
    return left.uid < right.uid ? -1 : left.uid > right.uid ? 1 : 0;
  });

  return createHash("sha256").update(JSON.stringify(records), "utf8").digest("hex");
}

export function buildIcsFilename(scope: IcsExportScope, exportedAtMs: number): string {
  if (scope !== "event" && scope !== "visible" && scope !== "future") {
    throw new TypeError("不支持的 ICS 导出范围");
  }
  return `campus-hire-tracker-${scope}-${formatUtcFilenameTime(exportedAtMs)}.ics`;
}
