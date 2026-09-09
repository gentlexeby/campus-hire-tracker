import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  buildIcsCalendar,
  buildIcsFilename,
  buildIcsPreview,
  buildIcsSnapshotId,
  defaultIcsReminderOffsets,
  type IcsEventInput,
} from "@/lib/ics";
import type { EventDto } from "@/lib/services";

const EXPORTED_AT_MS = Date.UTC(2026, 8, 9, 1, 2, 3, 987);

function event(overrides: Partial<EventDto> = {}): EventDto {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    applicationId: "00000000-0000-4000-8000-000000000001",
    type: "INTERVIEW",
    title: "技术一面",
    status: "SCHEDULED",
    schedule: {
      kind: "TIMED",
      startsAtMs: Date.UTC(2026, 8, 10, 2, 3, 4, 567),
      endsAtMs: Date.UTC(2026, 8, 10, 3, 33, 4, 999),
    },
    timezone: "Asia/Shanghai",
    location: "上海总部",
    meetingUrl: "https://meet.example.com/room?a=1&b=2",
    notesMarkdown: "PRIVATE-NOTES-MUST-NEVER-LEAK",
    isHardDeadline: false,
    completedAtMs: null,
    icsUid: "00000000-0000-4000-8000-000000000101@campus-hire-tracker.local",
    createdAtMs: Date.UTC(2026, 8, 1),
    updatedAtMs: Date.UTC(2026, 8, 2),
    version: 7,
    ...overrides,
  };
}

function input(eventValue = event(), overrides: Partial<IcsEventInput> = {}): IcsEventInput {
  return {
    event: eventValue,
    companyName: "示例科技",
    positionTitle: "后端工程师",
    ...overrides,
  };
}

function logicalLines(calendar: string): string[] {
  return calendar.replace(/\r\n /g, "").split("\r\n").slice(0, -1);
}

describe("ICS export", () => {
  it("builds a safe preview without reading private notes", () => {
    const preview = buildIcsPreview(input());

    expect(preview).toEqual({
      eventId: "00000000-0000-4000-8000-000000000101",
      summary: "【面试】示例科技 · 后端工程师 · 技术一面",
      schedule: event().schedule,
      timezone: "Asia/Shanghai",
      location: "上海总部",
      url: "https://meet.example.com/room?a=1&b=2",
      description: "申请：示例科技 · 后端工程师\n类型：面试",
      reminderMinutes: [1440, 60],
    });
    expect(JSON.stringify(preview)).not.toContain("PRIVATE-NOTES-MUST-NEVER-LEAK");
  });

  it("exports timed events in UTC with stable UID, sequence and default alarms", () => {
    const calendar = buildIcsCalendar([input()], { exportedAtMs: EXPORTED_AT_MS });
    const lines = logicalLines(calendar);

    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("CALSCALE:GREGORIAN");
    expect(lines.some((line) => line.startsWith("METHOD:"))).toBe(false);
    expect(lines).toContain("DTSTAMP:20260909T010203Z");
    expect(lines).toContain("DTSTART:20260910T020304Z");
    expect(lines).toContain("DTEND:20260910T033304Z");
    expect(lines).not.toContain(expect.stringContaining("TZID"));
    expect(lines).toContain(
      "UID:00000000-0000-4000-8000-000000000101@campus-hire-tracker.local",
    );
    expect(lines).toContain("SEQUENCE:7");
    expect(lines).toContain("TRIGGER:-P1D");
    expect(lines).toContain("TRIGGER:-PT1H");
    expect(lines.filter((line) => line === "BEGIN:VALARM")).toHaveLength(2);
    expect(calendar).not.toContain("PRIVATE-NOTES-MUST-NEVER-LEAK");
  });

  it("leaves DTEND absent for a point event", () => {
    const point = event({
      schedule: { kind: "TIMED", startsAtMs: Date.UTC(2026, 8, 10, 2, 3, 4) },
    });
    const lines = logicalLines(buildIcsCalendar([input(point)], { exportedAtMs: EXPORTED_AT_MS }));

    expect(lines).toContain("DTSTART:20260910T020304Z");
    expect(lines.some((line) => line.startsWith("DTEND"))).toBe(false);
  });

  it("rejects a timed range that collapses to zero length at ICS second precision", () => {
    const startsAtMs = Date.UTC(2026, 8, 10, 2, 3, 4, 100);
    const sameSecondRange = event({
      schedule: { kind: "TIMED", startsAtMs, endsAtMs: startsAtMs + 500 },
    });

    expect(() =>
      buildIcsCalendar([input(sameSecondRange)], { exportedAtMs: EXPORTED_AT_MS }),
    ).toThrow("定时事件按秒导出后的结束时间必须晚于开始时间");
  });

  it("uses VALUE=DATE and preserves the exclusive end date for all-day events", () => {
    const allDay = event({
      schedule: {
        kind: "ALL_DAY",
        startDate: "2026-09-10",
        endDateExclusive: "2026-09-12",
      },
    });
    const lines = logicalLines(buildIcsCalendar([input(allDay)], { exportedAtMs: EXPORTED_AT_MS }));

    expect(lines).toContain("DTSTART;VALUE=DATE:20260910");
    expect(lines).toContain("DTEND;VALUE=DATE:20260912");
    expect(lines.some((line) => line.startsWith("DTSTART;TZID"))).toBe(false);
  });

  it("escapes TEXT and prevents CRLF component injection", () => {
    const malicious = event({
      title: "一面;重点,算法\\系统\r\nBEGIN:VEVENT\nEND:VCALENDAR",
      location: "会议室 A;B,三楼\\东侧\r\nX-EVIL:YES",
    });
    const calendar = buildIcsCalendar(
      [input(malicious, { companyName: "甲公司\r\nBEGIN:VCALENDAR" })],
      { exportedAtMs: EXPORTED_AT_MS },
    );
    const lines = logicalLines(calendar);
    const summary = lines.find((line) => line.startsWith("SUMMARY:"));
    const location = lines.find((line) => line.startsWith("LOCATION:"));

    expect(summary).toContain("\\;重点\\,算法\\\\系统\\nBEGIN:VEVENT\\nEND:VCALENDAR");
    expect(summary).toContain("甲公司\\nBEGIN:VCALENDAR");
    expect(location).toBe("LOCATION:会议室 A\\;B\\,三楼\\\\东侧\\nX-EVIL:YES");
    expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines.filter((line) => line === "BEGIN:VCALENDAR")).toHaveLength(1);
    expect(lines.filter((line) => line === "X-EVIL:YES")).toHaveLength(0);
  });

  it("uses only CRLF and folds long Chinese lines at 75 UTF-8 octets without splitting code points", () => {
    const longTitle = `很长的中文面试标题${"中".repeat(90)}`;
    const calendar = buildIcsCalendar([input(event({ title: longTitle }))], {
      exportedAtMs: EXPORTED_AT_MS,
      calendarName: `秋招${"日历".repeat(40)}`,
    });
    const physicalLines = calendar.split("\r\n");

    expect(physicalLines.at(-1)).toBe("");
    expect(calendar.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const line of physicalLines.slice(0, -1)) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(line))).not.toThrow();
    }
    expect(physicalLines.some((line) => line.startsWith(" "))).toBe(true);
    expect(logicalLines(calendar)).toContain(
      `SUMMARY:【面试】示例科技 · 后端工程师 · ${longTitle}`,
    );
  });

  it("normalizes configurable alarms deterministically, including a zero-minute trigger", () => {
    const calendar = buildIcsCalendar(
      [input(event(), { reminderMinutes: [60, 0, 1440, 60] })],
      { exportedAtMs: EXPORTED_AT_MS },
    );
    const triggers = logicalLines(calendar).filter((line) => line.startsWith("TRIGGER:"));

    expect(triggers).toEqual(["TRIGGER:-P1D", "TRIGGER:-PT1H", "TRIGGER:PT0M"]);
    expect(buildIcsPreview(input(event(), { reminderMinutes: [] })).reminderMinutes).toEqual([]);
    expect(() => buildIcsPreview(input(event(), { reminderMinutes: [-1] }))).toThrow(
      "提醒提前分钟数必须是非负安全整数",
    );
  });

  it("provides documented reminder defaults by event type", () => {
    expect(defaultIcsReminderOffsets("INTERVIEW")).toEqual([1440, 60]);
    expect(defaultIcsReminderOffsets("ASSESSMENT")).toEqual([1440, 60]);
    expect(defaultIcsReminderOffsets("WRITTEN_TEST")).toEqual([1440, 60]);
    expect(defaultIcsReminderOffsets("RECRUITMENT_FAIR")).toEqual([1440, 60]);
    expect(defaultIcsReminderOffsets("APPLICATION_DEADLINE")).toEqual([4320, 1440]);
    expect(defaultIcsReminderOffsets("ACTION_DUE")).toEqual([4320, 1440]);
    expect(defaultIcsReminderOffsets("FOLLOW_UP")).toEqual([1440]);
    expect(defaultIcsReminderOffsets("OTHER")).toEqual([]);
  });

  it("is byte-deterministic for fixed metadata and canonicalizes batch order", () => {
    const later = input(event({
      id: "00000000-0000-4000-8000-000000000202",
      icsUid: "00000000-0000-4000-8000-000000000202@campus-hire-tracker.local",
      title: "二面",
      schedule: { kind: "TIMED", startsAtMs: Date.UTC(2026, 8, 12, 1) },
    }));
    const earlier = input(event());
    const options = { exportedAtMs: EXPORTED_AT_MS } as const;

    expect(buildIcsCalendar([later, earlier], options)).toBe(
      buildIcsCalendar([earlier, later], options),
    );

    const updated = buildIcsCalendar(
      [input(event({ version: 8, title: "技术一面（改期）" }))],
      options,
    );
    expect(logicalLines(updated)).toContain(
      "UID:00000000-0000-4000-8000-000000000101@campus-hire-tracker.local",
    );
    expect(logicalLines(updated)).toContain("SEQUENCE:8");
  });

  it("rejects cancelled events instead of emitting incomplete scheduling messages", () => {
    const cancelled = input(event({ status: "CANCELLED", version: 8 }));
    expect(() => buildIcsCalendar([cancelled], { exportedAtMs: EXPORTED_AT_MS })).toThrow(
      "日历快照不能包含已取消事件",
    );
  });

  it("rejects malformed schedules, duplicate UIDs and unsafe URLs", () => {
    const invalidDate = input(event({
      schedule: { kind: "ALL_DAY", startDate: "2026-02-30", endDateExclusive: "2026-03-02" },
    }));
    expect(() => buildIcsCalendar([invalidDate], { exportedAtMs: EXPORTED_AT_MS })).toThrow(
      "startDate 不是有效日期",
    );

    expect(() =>
      buildIcsCalendar([input(), input()], { exportedAtMs: EXPORTED_AT_MS }),
    ).toThrow("同一日历不能包含重复的事件 UID");

    expect(() =>
      buildIcsPreview(input(event({ meetingUrl: "https://example.com/\r\nBEGIN:VEVENT" }))),
    ).toThrow("日历链接包含非法控制字符或空白");

    expect(() => buildIcsCalendar([
      input(event({
        schedule: { kind: "TIMED", startsAtMs: Date.UTC(10_000, 0, 1) },
      })),
    ], { exportedAtMs: EXPORTED_AT_MS })).toThrow("startsAtMs 超出 ICS 四位年份范围");
  });

  it("creates deterministic ASCII-only filenames", () => {
    expect(buildIcsFilename("future", EXPORTED_AT_MS)).toBe(
      "campus-hire-tracker-future-20260909-010203Z.ics",
    );
    expect(buildIcsFilename("event", EXPORTED_AT_MS)).toMatch(/^[\x20-\x7e]+$/);
    expect(() => buildIcsFilename("../危险" as "future", EXPORTED_AT_MS)).toThrow(
      "不支持的 ICS 导出范围",
    );
  });

  it("fingerprints the exact previewed export fields without hashing private notes", () => {
    const first = input();
    const second = input(event({
      id: "00000000-0000-4000-8000-000000000202",
      icsUid: "00000000-0000-4000-8000-000000000202@campus-hire-tracker.local",
      title: "技术二面",
      version: 3,
    }));
    const snapshot = buildIcsSnapshotId([first, second]);

    expect(snapshot).toMatch(/^[0-9a-f]{64}$/);
    expect(buildIcsSnapshotId([second, first])).toBe(snapshot);
    expect(buildIcsSnapshotId([input(event({ notesMarkdown: "另一份私人备注" })), second])).toBe(snapshot);
    expect(buildIcsSnapshotId([input(event({ version: 8 })), second])).not.toBe(snapshot);
    expect(buildIcsSnapshotId([input(event(), { companyName: "新公司" }), second])).not.toBe(snapshot);
  });
});
