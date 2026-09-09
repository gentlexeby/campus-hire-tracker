import {
  expect,
  test,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";
import { createClient, type Client } from "@libsql/client/node";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1_000;
const E2E_DATA_ROOT = path.resolve(process.cwd(), ".test-data", "e2e");

test.describe.configure({ timeout: 90_000 });

type EventType =
  | "INTERVIEW"
  | "ASSESSMENT"
  | "WRITTEN_TEST"
  | "APPLICATION_DEADLINE"
  | "ACTION_DUE"
  | "FOLLOW_UP"
  | "OTHER";

type EventFixture = {
  id: string;
  icsUid: string;
  version: number;
  startsAtMs: number | null;
  endsAtMs: number | null;
  allDayStartDate: string | null;
  allDayEndDateExclusive: string | null;
};

type TimedEventInput = {
  kind: "TIMED";
  title: string;
  type?: EventType;
  startsAtMs: number;
  endsAtMs?: number;
  location?: string;
  meetingUrl?: string;
};

type AllDayEventInput = {
  kind: "ALL_DAY";
  title: string;
  type?: EventType;
  startDate: string;
  endDateExclusive: string;
  location?: string;
  meetingUrl?: string;
};

type EventInput = TimedEventInput | AllDayEventInput;

function uniqueValue(prefix: string) {
  return `${prefix} ${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toLocalDateTimeInput(epochMs: number) {
  const value = new Date(epochMs);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function addIsoDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatUtcDateTime(epochMs: number) {
  return new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function formatIcsDate(value: string) {
  return value.replaceAll("-", "");
}

function escapeIcsText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
    .replace(/\t/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function decodeIcs(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function unfoldIcs(value: string) {
  return value.replace(/\r\n[ \t]/g, "");
}

function logicalLines(value: string) {
  return unfoldIcs(value).split("\r\n").filter(Boolean);
}

function extractUidOrder(value: string) {
  return logicalLines(value)
    .filter((line) => line.startsWith("UID:"))
    .map((line) => line.slice("UID:".length));
}

function eventBlock(value: string, uid: string) {
  const blocks = unfoldIcs(value).match(/BEGIN:VEVENT\r\n[\s\S]*?END:VEVENT\r\n/g) ?? [];
  const block = blocks.find((candidate) => candidate.includes(`UID:${uid}\r\n`));
  expect(block, `ICS should contain VEVENT ${uid}`).toBeDefined();
  return block!;
}

function normalizeDtstamp(value: string) {
  return value.replace(/DTSTAMP:\d{8}T\d{6}Z\r\n/g, "DTSTAMP:<captured-once>\r\n");
}

function assertCanonicalIcs(bytes: Uint8Array) {
  expect(Array.from(bytes.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
  const text = decodeIcs(bytes);
  expect(text.endsWith("\r\n")).toBe(true);
  expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);

  const physicalLines = text.split("\r\n");
  expect(physicalLines.at(-1)).toBe("");
  for (const line of physicalLines.slice(0, -1)) {
    expect(Buffer.byteLength(line, "utf8"), `line exceeds 75 octets: ${line}`).toBeLessThanOrEqual(75);
  }
  return text;
}

async function withDatabase<T>(run: (client: Client) => Promise<T>) {
  const pointerPath = path.join(E2E_DATA_ROOT, "runtime", "active.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
    generationId?: unknown;
  };
  if (typeof pointer.generationId !== "string") {
    throw new Error(`Invalid E2E active pointer at ${pointerPath}`);
  }

  const databasePath = path.join(
    E2E_DATA_ROOT,
    "stores",
    pointer.generationId,
    "app.db",
  );
  const client = createClient({ url: `file:${databasePath.replace(/\\/g, "/")}` });
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

function fixtureFromRow(row: Record<string, unknown>): EventFixture {
  return {
    id: String(row.id),
    icsUid: String(row.icsUid),
    version: Number(row.version),
    startsAtMs: row.startsAtMs == null ? null : Number(row.startsAtMs),
    endsAtMs: row.endsAtMs == null ? null : Number(row.endsAtMs),
    allDayStartDate: row.allDayStartDate == null ? null : String(row.allDayStartDate),
    allDayEndDateExclusive: row.allDayEndDateExclusive == null
      ? null
      : String(row.allDayEndDateExclusive),
  };
}

async function lookupEventsByTitle(titles: readonly string[]) {
  return withDatabase(async (client) => {
    const placeholders = titles.map(() => "?").join(", ");
    const result = await client.execute({
      sql: `
        SELECT
          id,
          ics_uid AS icsUid,
          version,
          starts_at_ms AS startsAtMs,
          ends_at_ms AS endsAtMs,
          all_day_start_date AS allDayStartDate,
          all_day_end_date_exclusive AS allDayEndDateExclusive,
          title
        FROM events
        WHERE deleted_at_ms IS NULL AND title IN (${placeholders})
      `,
      args: [...titles],
    });
    const rows = new Map(
      result.rows.map((row) => [String(row.title), fixtureFromRow(row)]),
    );
    for (const title of titles) {
      expect(rows.has(title), `database should contain event ${title}`).toBe(true);
    }
    return rows;
  });
}

async function mutateEventForEscaping(
  originalTitle: string,
  title: string,
  location: string,
  notesMarkdown: string,
) {
  return withDatabase(async (client) => {
    const result = await client.execute({
      sql: `
        UPDATE events
        SET
          title = ?,
          location = ?,
          notes_markdown = ?,
          updated_at_ms = ?,
          version = version + 1
        WHERE title = ? AND deleted_at_ms IS NULL
        RETURNING
          id,
          ics_uid AS icsUid,
          version,
          starts_at_ms AS startsAtMs,
          ends_at_ms AS endsAtMs,
          all_day_start_date AS allDayStartDate,
          all_day_end_date_exclusive AS allDayEndDateExclusive
      `,
      args: [title, location, notesMarkdown, Date.now(), originalTitle],
    });
    expect(result.rows).toHaveLength(1);
    return fixtureFromRow(result.rows[0]);
  });
}

async function createApplication(
  page: Page,
  companyName: string,
  positionTitle: string,
) {
  await page.goto("/applications/new", { waitUntil: "networkidle" });
  await page.getByLabel("公司 *").fill(companyName);
  await page.getByLabel("岗位 *").fill(positionTitle);

  await Promise.all([
    page.waitForURL(/\/applications\/[0-9a-f-]+\?created=1$/),
    page.getByRole("button", { name: "创建申请" }).click(),
  ]);
  await expect(
    page.getByRole("heading", { level: 1, name: positionTitle }),
  ).toBeVisible();
  return new URL(page.url()).pathname;
}

async function createEvent(
  page: Page,
  applicationPath: string,
  input: EventInput,
) {
  await page.goto(`${applicationPath}#events`, { waitUntil: "networkidle" });
  const opener = page.locator("summary").filter({
    hasText: /^＋ 为这条申请新建事件$/,
  });
  const details = opener.locator("xpath=..");
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await opener.click();
  }
  const form = details.locator("form");
  await expect(form).toBeVisible();

  await form.getByLabel("事件类型").selectOption(input.type ?? "INTERVIEW");
  await form.getByLabel("标题").fill(input.title);
  const allDayToggle = form.getByLabel("这是全天事件");
  if (input.kind === "ALL_DAY") {
    await allDayToggle.check();
    await form.getByLabel("开始日期 *").fill(input.startDate);
    await form.getByLabel("结束日期（不含） *").fill(input.endDateExclusive);
  } else {
    await allDayToggle.uncheck();
    await form.getByLabel("开始时间 *").fill(toLocalDateTimeInput(input.startsAtMs));
    if (input.endsAtMs != null) {
      await form.getByLabel("结束时间").fill(toLocalDateTimeInput(input.endsAtMs));
    }
  }
  if (input.location) await form.getByLabel("地点").fill(input.location);
  if (input.meetingUrl) await form.getByLabel("会议链接").fill(input.meetingUrl);

  const createdHeading = page.getByRole("heading", {
    level: 3,
    name: input.title,
    exact: true,
  });
  await form.getByRole("button", { name: "创建事件", exact: true }).click();
  const confirmButton = form.getByRole("button", {
    name: "确认保存事件",
    exact: true,
  });
  await expect(createdHeading.or(confirmButton)).toBeVisible();
  if (await confirmButton.isVisible()) {
    await form
      .getByLabel("以上日程与本事件时间冲突；我仍要保存")
      .check();
    await confirmButton.click();
  }
  await expect(createdHeading).toBeVisible();
}

function eventRow(page: Page, title: string) {
  return page.getByRole("article").filter({
    has: page.getByRole("heading", { level: 3, name: title, exact: true }),
  });
}

async function setEventStatus(
  page: Page,
  applicationPath: string,
  title: string,
  actionLabel: "标记完成" | "取消事件",
) {
  await page.goto(`${applicationPath}#events`, { waitUntil: "networkidle" });
  const row = eventRow(page, title);
  await row.getByRole("button", { name: actionLabel, exact: true }).click();
  await expect(
    row.getByText(actionLabel === "标记完成" ? "已完成" : "已取消", { exact: true }),
  ).toBeVisible();
}

async function downloadFromPreview(
  page: Page,
  region: Locator,
  scope: "event" | "visible" | "future",
) {
  const button = region.getByRole("button", {
    name: "下载 ICS 文件",
    exact: true,
  });
  const [download, response] = await Promise.all([
    page.waitForEvent("download"),
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/calendar-export"
        && url.searchParams.get("scope") === scope;
    }),
    button.click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(
    region.getByText("ICS 文件已下载，请在系统日历中导入。", { exact: true }),
  ).toBeVisible();
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  return {
    bytes: await readFile(downloadPath!),
    href: response.url(),
    response,
    suggestedFilename: download.suggestedFilename(),
  };
}

async function expectFailClosed(
  response: APIResponse,
  status: number,
  message: string,
) {
  expect(response.status()).toBe(status);
  expect(response.headers()["content-type"]).toContain("text/plain");
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["content-disposition"]).toBeUndefined();
  const body = await response.text();
  expect(body).toBe(message);
  expect(body).not.toContain("BEGIN:VCALENDAR");
  expect(body).not.toContain("BEGIN:VEVENT");
}

test("single-event preview and download preserve calendar semantics without leaking private notes", async ({
  page,
  request,
}) => {
  const companyName = uniqueValue("E2E 中文,公司;路径\\");
  const positionTitle = uniqueValue("后端;工程师,校招\\");
  const originalTitle = uniqueValue("ICS 单事件原始标题");
  const injectionMarker = uniqueValue("INJECTED-BEGIN");
  const exportedTitle = `${uniqueValue("中文,分号;反斜杠\\")}\nBEGIN:VEVENT ${injectionMarker}`;
  const exportedLocation = `${uniqueValue("北京,朝阳;会议室\\")}\nEND:VEVENT ${"长中文".repeat(24)}`;
  const secretNote = uniqueValue("SECRET-notesMarkdown-不得泄漏");
  const meetingUrl = `https://example.com/interview/${randomUUID()}?from=e2e`;
  const start = Math.floor((Date.now() + 370 * DAY_MS) / 60_000) * 60_000;
  const end = start + 90 * 60_000;
  const applicationPath = await createApplication(page, companyName, positionTitle);

  await createEvent(page, applicationPath, {
    kind: "TIMED",
    title: originalTitle,
    type: "INTERVIEW",
    startsAtMs: start,
    endsAtMs: end,
    location: "稍后替换的地点",
    meetingUrl,
  });
  const fixture = await mutateEventForEscaping(
    originalTitle,
    exportedTitle,
    exportedLocation,
    secretNote,
  );
  expect(fixture.startsAtMs).not.toBeNull();
  expect(fixture.endsAtMs).not.toBeNull();

  await page.goto("/calendar", { waitUntil: "networkidle" });
  const row = eventRow(page, exportedTitle);
  await row.locator("summary").filter({ hasText: /^导出此事件$/ }).click();
  const preview = row.getByRole("region", { name: "导出此事件预览" });
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole("heading", { level: 4 }).filter({ hasText: injectionMarker }),
  ).toBeVisible();
  await expect(preview).toContainText(companyName);
  await expect(preview).toContainText(positionTitle);
  await expect(preview).toContainText(exportedLocation);
  await expect(preview).toContainText(meetingUrl);
  await expect(preview).toContainText("提前 1 天、提前 1 小时");
  await expect(preview.getByText("这是单向导出", { exact: true })).toBeVisible();
  await expect(preview).toContainText("系统日历中的修改不会回写到秋招进度板。");
  await expect(preview).toContainText("普通备注不会包含在导出文件中");
  await expect(preview).not.toContainText(secretNote);

  const downloaded = await downloadFromPreview(page, preview, "event");
  expect(downloaded.suggestedFilename).toMatch(
    /^campus-hire-tracker-event-\d{8}-\d{6}Z\.ics$/,
  );
  const downloadedText = assertCanonicalIcs(downloaded.bytes);
  expect(downloadedText).toContain(`UID:${fixture.icsUid}`);
  expect(downloadedText).not.toContain(secretNote);

  const response = await request.get(downloaded.href);
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["content-type"]).toBe("text/calendar; charset=utf-8");
  expect(headers["content-disposition"]).toMatch(
    /^attachment; filename="campus-hire-tracker-event-\d{8}-\d{6}Z\.ics"$/,
  );
  expect(headers["cache-control"]).toBe("no-store, max-age=0");
  expect(headers.pragma).toBe("no-cache");
  expect(headers["x-content-type-options"]).toBe("nosniff");

  const bytes = await response.body();
  const text = assertCanonicalIcs(bytes);
  const lines = logicalLines(text);
  const expectedSummary = `【面试】${companyName} · ${positionTitle} · ${exportedTitle}`;
  const expectedDescription = `申请：${companyName} · ${positionTitle}\n类型：面试`;

  expect(lines.filter((line) => line === "BEGIN:VCALENDAR")).toHaveLength(1);
  expect(lines.filter((line) => line === "END:VCALENDAR")).toHaveLength(1);
  expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(1);
  expect(lines.filter((line) => line === "END:VEVENT")).toHaveLength(1);
  expect(lines.some((line) => line.startsWith("METHOD:"))).toBe(false);
  expect(lines).toContain(`UID:${fixture.icsUid}`);
  expect(lines).toContain(`SEQUENCE:${fixture.version}`);
  expect(lines).toContain(`DTSTART:${formatUtcDateTime(fixture.startsAtMs!)}`);
  expect(lines).toContain(`DTEND:${formatUtcDateTime(fixture.endsAtMs!)}`);
  expect(lines.filter((line) => /^DTSTAMP:\d{8}T\d{6}Z$/.test(line))).toHaveLength(1);
  expect(lines).toContain(`SUMMARY:${escapeIcsText(expectedSummary)}`);
  expect(lines).toContain(`DESCRIPTION:${escapeIcsText(expectedDescription)}`);
  expect(lines).toContain(`LOCATION:${escapeIcsText(exportedLocation)}`);
  expect(lines).toContain(`URL:${new URL(meetingUrl).toString()}`);
  expect(lines.filter((line) => line === "BEGIN:VALARM")).toHaveLength(2);
  expect(lines.filter((line) => line === "END:VALARM")).toHaveLength(2);
  expect(lines.filter((line) => line === "ACTION:DISPLAY")).toHaveLength(2);
  expect(lines).toContain("TRIGGER:-P1D");
  expect(lines).toContain("TRIGGER:-PT1H");
  expect(text.split("\r\n").some((line) => line.startsWith(" "))).toBe(true);
  expect(text).not.toContain(secretNote);
  expect(lines.filter((line) => line === `BEGIN:VEVENT ${injectionMarker}`)).toHaveLength(0);

  const repeatedResponse = await request.get(downloaded.href);
  expect(repeatedResponse.status()).toBe(200);
  expect(extractUidOrder(await repeatedResponse.text())).toEqual([fixture.icsUid]);
});

test("visible and future batch exports respect status and time boundaries, keep all-day end exclusive, and stay stable", async ({
  page,
  request,
}) => {
  const companyName = uniqueValue("E2E ICS 批量公司");
  const positionTitle = uniqueValue("ICS 批量岗位");
  const futureTitle = uniqueValue("未来定时面试");
  const allDayTitle = uniqueValue("未来全天截止");
  const pastTitle = uniqueValue("过去但属于当前列表");
  const cancelledTitle = uniqueValue("已取消未来笔试");
  const completedTitle = uniqueValue("已完成未来测评");
  const roundedNow = Math.floor(Date.now() / 60_000) * 60_000;
  const futureStart = roundedNow + 400 * DAY_MS;
  const pastStart = roundedNow - 40 * DAY_MS;
  const cancelledStart = roundedNow + 430 * DAY_MS;
  const completedStart = roundedNow + 440 * DAY_MS;
  const allDayStart = new Date(roundedNow + 420 * DAY_MS).toISOString().slice(0, 10);
  const allDayEndExclusive = addIsoDays(allDayStart, 3);
  const applicationPath = await createApplication(page, companyName, positionTitle);

  await createEvent(page, applicationPath, {
    kind: "TIMED",
    title: futureTitle,
    type: "INTERVIEW",
    startsAtMs: futureStart,
    endsAtMs: futureStart + 60 * 60_000,
  });
  await createEvent(page, applicationPath, {
    kind: "ALL_DAY",
    title: allDayTitle,
    type: "APPLICATION_DEADLINE",
    startDate: allDayStart,
    endDateExclusive: allDayEndExclusive,
  });
  await createEvent(page, applicationPath, {
    kind: "TIMED",
    title: pastTitle,
    type: "OTHER",
    startsAtMs: pastStart,
    endsAtMs: pastStart + 60 * 60_000,
  });
  await createEvent(page, applicationPath, {
    kind: "TIMED",
    title: cancelledTitle,
    type: "WRITTEN_TEST",
    startsAtMs: cancelledStart,
    endsAtMs: cancelledStart + 60 * 60_000,
  });
  await createEvent(page, applicationPath, {
    kind: "TIMED",
    title: completedTitle,
    type: "ASSESSMENT",
    startsAtMs: completedStart,
    endsAtMs: completedStart + 60 * 60_000,
  });
  await setEventStatus(page, applicationPath, cancelledTitle, "取消事件");
  await setEventStatus(page, applicationPath, completedTitle, "标记完成");

  const fixtures = await lookupEventsByTitle([
    futureTitle,
    allDayTitle,
    pastTitle,
    cancelledTitle,
    completedTitle,
  ]);
  const futureEvent = fixtures.get(futureTitle)!;
  const allDayEvent = fixtures.get(allDayTitle)!;
  const pastEvent = fixtures.get(pastTitle)!;
  const cancelledEvent = fixtures.get(cancelledTitle)!;
  const completedEvent = fixtures.get(completedTitle)!;

  await page.goto("/calendar", { waitUntil: "networkidle" });
  await page.locator("summary").filter({ hasText: /^导出当前列表$/ }).click();
  const visiblePreview = page.getByRole("region", { name: "导出当前列表预览" });
  await expect(visiblePreview).toBeVisible();
  await expect(visiblePreview).toContainText("这里包含完整日程列表中的所有未取消事件，含过去与未来");
  for (const title of [futureTitle, allDayTitle, pastTitle, completedTitle]) {
    await expect(visiblePreview).toContainText(title);
  }
  await expect(visiblePreview).not.toContainText(cancelledTitle);

  await page.locator("summary").filter({ hasText: /^导出全部未来事件$/ }).click();
  const futurePreview = page.getByRole("region", { name: "导出全部未来事件预览" });
  await expect(futurePreview).toBeVisible();
  await expect(futurePreview).toContainText("不包含已完成、已取消或归档申请的事件");
  await expect(futurePreview).toContainText(futureTitle);
  await expect(futurePreview).toContainText(allDayTitle);
  for (const title of [pastTitle, cancelledTitle, completedTitle]) {
    await expect(futurePreview).not.toContainText(title);
  }

  const visibleDownload = await downloadFromPreview(page, visiblePreview, "visible");
  const futureDownload = await downloadFromPreview(page, futurePreview, "future");
  const visibleHref = visibleDownload.href;
  const futureHref = futureDownload.href;
  const visibleUrl = new URL(visibleHref);
  const futureUrl = new URL(futureHref);
  expect(visibleUrl.pathname).toBe("/api/calendar-export");
  expect(visibleUrl.searchParams.get("scope")).toBe("visible");
  expect(visibleUrl.searchParams.get("snapshot")).toMatch(/^[0-9a-f]{64}$/);
  expect(futureUrl.pathname).toBe("/api/calendar-export");
  expect(futureUrl.searchParams.get("scope")).toBe("future");
  expect(futureUrl.searchParams.get("snapshot")).toMatch(/^[0-9a-f]{64}$/);

  const [visibleResponse, firstFutureResponse] = await Promise.all([
    request.get(visibleHref),
    request.get(futureHref),
  ]);
  expect(visibleResponse.status()).toBe(200);
  expect(firstFutureResponse.status()).toBe(200);
  expect(visibleResponse.headers()["content-disposition"]).toMatch(
    /^attachment; filename="campus-hire-tracker-visible-\d{8}-\d{6}Z\.ics"$/,
  );
  expect(firstFutureResponse.headers()["content-disposition"]).toMatch(
    /^attachment; filename="campus-hire-tracker-future-\d{8}-\d{6}Z\.ics"$/,
  );

  const visibleIcs = assertCanonicalIcs(await visibleResponse.body());
  const firstFutureIcs = assertCanonicalIcs(await firstFutureResponse.body());
  const visibleUids = extractUidOrder(visibleIcs);
  const futureUids = extractUidOrder(firstFutureIcs);

  for (const event of [futureEvent, allDayEvent, pastEvent, completedEvent]) {
    expect(visibleUids).toContain(event.icsUid);
  }
  expect(visibleUids).not.toContain(cancelledEvent.icsUid);
  expect(futureUids).toContain(futureEvent.icsUid);
  expect(futureUids).toContain(allDayEvent.icsUid);
  for (const event of [pastEvent, cancelledEvent, completedEvent]) {
    expect(futureUids).not.toContain(event.icsUid);
  }
  expect(futureUids.indexOf(futureEvent.icsUid)).toBeLessThan(
    futureUids.indexOf(allDayEvent.icsUid),
  );

  const allDayBlock = eventBlock(firstFutureIcs, allDayEvent.icsUid);
  expect(allDayBlock).toContain(
    `DTSTART;VALUE=DATE:${formatIcsDate(allDayStart)}\r\n`,
  );
  expect(allDayBlock).toContain(
    `DTEND;VALUE=DATE:${formatIcsDate(allDayEndExclusive)}\r\n`,
  );
  expect(allDayBlock).not.toContain(
    `DTEND;VALUE=DATE:${formatIcsDate(addIsoDays(allDayEndExclusive, -1))}\r\n`,
  );

  const completedBlock = eventBlock(visibleIcs, completedEvent.icsUid);
  expect(completedBlock).not.toContain("BEGIN:VALARM");
  const cancelledSingle = await request.get(
    `/api/calendar-export?scope=event&eventId=${cancelledEvent.id}&snapshot=${"0".repeat(64)}`,
  );
  await expectFailClosed(
    cancelledSingle,
    400,
    "已取消事件不能加入当前日历快照",
  );

  const secondFutureResponse = await request.get(futureHref);
  expect(secondFutureResponse.status()).toBe(200);
  const secondFutureIcs = assertCanonicalIcs(await secondFutureResponse.body());
  expect(extractUidOrder(secondFutureIcs)).toEqual(futureUids);
  expect(normalizeDtstamp(secondFutureIcs)).toBe(normalizeDtstamp(firstFutureIcs));
});

test("stale UI previews fail closed with a 409 and never download changed event content", async ({
  context,
  page,
}) => {
  const companyName = uniqueValue("E2E ICS 快照竞态公司");
  const positionTitle = uniqueValue("ICS 快照竞态岗位");
  const eventTitle = uniqueValue("预览后被修改的面试");
  const start = Math.floor((Date.now() + 480 * DAY_MS) / 60_000) * 60_000;
  const applicationPath = await createApplication(page, companyName, positionTitle);
  await createEvent(page, applicationPath, {
    kind: "TIMED",
    title: eventTitle,
    type: "INTERVIEW",
    startsAtMs: start,
    endsAtMs: start + 60 * 60_000,
  });

  await page.goto("/calendar", { waitUntil: "networkidle" });
  const row = eventRow(page, eventTitle);
  await row.locator("summary").filter({ hasText: /^导出此事件$/ }).click();
  const preview = row.getByRole("region", { name: "导出此事件预览" });
  await expect(preview).toContainText(eventTitle);
  await expect(preview).toContainText("提前 1 天、提前 1 小时");

  const updater = await context.newPage();
  try {
    await setEventStatus(updater, applicationPath, eventTitle, "标记完成");

    const downloadedFiles: string[] = [];
    const recordDownload = (download: { suggestedFilename(): string }) => {
      downloadedFiles.push(download.suggestedFilename());
    };
    page.on("download", recordDownload);
    try {
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/calendar-export"
          && url.searchParams.get("scope") === "event";
      });
      await preview
        .getByRole("button", { name: "下载 ICS 文件", exact: true })
        .click();
      const response = await responsePromise;
      const requestUrl = new URL(response.url());

      expect(requestUrl.searchParams.get("snapshot")).toMatch(/^[0-9a-f]{64}$/);
      expect(response.status()).toBe(409);
      expect(response.headers()["content-type"]).toContain("text/plain");
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(response.headers()["content-disposition"]).toBeUndefined();
      expect(await response.text()).toBe("事件内容已在预览后变化，请刷新页面并重新核对");
      await expect(
        preview.getByRole("alert").filter({
          hasText: "事件内容已经变化，请刷新本页并重新核对预览。",
        }),
      ).toBeVisible();
      expect(downloadedFiles).toHaveLength(0);
    } finally {
      page.off("download", recordDownload);
    }
  } finally {
    await updater.close();
  }
});

test("calendar export rejects malformed, missing, mixed, and nonexistent event IDs without partial output", async ({
  request,
}) => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const validSnapshot = "0".repeat(64);
  const malformedCases = [
    "/api/calendar-export?scope=event",
    `/api/calendar-export?scope=event&snapshot=${validSnapshot}`,
    `/api/calendar-export?scope=event&eventId=not-a-uuid&snapshot=${validSnapshot}`,
    `/api/calendar-export?scope=event&eventId=%0D%0ABEGIN%3AVEVENT&snapshot=${validSnapshot}`,
    `/api/calendar-export?scope=event&eventId=${firstId}&eventId=${secondId}&snapshot=${validSnapshot}`,
    `/api/calendar-export?scope=event&eventId=${firstId}&snapshot=${validSnapshot}&unexpected=1`,
    `/api/calendar-export?scope=visible&eventId=${firstId}&snapshot=${validSnapshot}`,
    `/api/calendar-export?scope=visible&scope=future&snapshot=${validSnapshot}`,
    `/api/calendar-export?scope=everything&snapshot=${validSnapshot}`,
    `/api/calendar-export?scope=event&eventId=${firstId}&snapshot=not-a-digest`,
    `/api/calendar-export?scope=event&eventId=${firstId}&snapshot=${validSnapshot}&snapshot=${"1".repeat(64)}`,
  ];

  for (const url of malformedCases) {
    await expectFailClosed(
      await request.get(url),
      400,
      "导出参数无效",
    );
  }

  await expectFailClosed(
    await request.get(
      `/api/calendar-export?scope=event&eventId=${firstId}&snapshot=${validSnapshot}`,
    ),
    404,
    "没有找到可导出的事件",
  );
});
