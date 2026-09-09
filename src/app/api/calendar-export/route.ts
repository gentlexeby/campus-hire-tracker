import { buildIcsCalendar, buildIcsFilename, buildIcsSnapshotId, type IcsEventInput } from "@/lib/ics";
import { listApplications, listCalendarEvents, listFutureCalendarEvents, type EventDto } from "@/lib/services";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_PATTERN = /^[0-9a-f]{64}$/;
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

type ExportRequest =
  | { scope: "event"; eventId: string; snapshot: string }
  | { scope: "visible" | "future"; snapshot: string };

function errorResponse(message: string, status: number) {
  return new Response(message, {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function parseExportRequest(url: URL): ExportRequest | null {
  const params = url.searchParams;
  const allowedKeys = new Set(["scope", "eventId", "snapshot"]);
  if ([...params.keys()].some((key) => !allowedKeys.has(key))) return null;
  if (
    params.getAll("scope").length !== 1
    || params.getAll("eventId").length > 1
    || params.getAll("snapshot").length !== 1
  ) return null;

  const scope = params.get("scope");
  const eventId = params.get("eventId");
  const snapshot = params.get("snapshot");
  if (!snapshot || !SNAPSHOT_PATTERN.test(snapshot)) return null;
  if (scope === "event") {
    return eventId && UUID_PATTERN.test(eventId) ? { scope, eventId, snapshot } : null;
  }
  if ((scope === "visible" || scope === "future") && eventId === null) {
    return { scope, snapshot };
  }
  return null;
}

function eventRevisionSet(events: readonly EventDto[]) {
  return JSON.stringify(
    events
      .map((event) => [event.id, event.version] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
}

async function addApplicationContext(events: readonly EventDto[]): Promise<IcsEventInput[]> {
  const applications = await listApplications({ includeArchived: false });
  const labels = new Map(
    applications.map((application) => [
      application.id,
      { companyName: application.companyName, positionTitle: application.positionTitle },
    ]),
  );

  return events.flatMap((event) => {
    const application = labels.get(event.applicationId);
    if (!application) return [];
    return [{
      event,
      ...application,
      ...(event.status === "COMPLETED" ? { reminderMinutes: [] } : {}),
    }];
  });
}

export async function GET(request: Request) {
  const parsed = parseExportRequest(new URL(request.url));
  if (!parsed) return errorResponse("导出参数无效", 400);

  let exportedAtMs: number;
  let events: EventDto[];

  if (parsed.scope === "event") {
    exportedAtMs = Date.now();
    const candidates = await listCalendarEvents({ includeArchived: false });
    const event = candidates.find((candidate) => candidate.id === parsed.eventId);
    if (!event) return errorResponse("没有找到可导出的事件", 404);
    if (event.status === "CANCELLED") return errorResponse("已取消事件不能加入当前日历快照", 400);
    events = [event];
  } else if (parsed.scope === "visible") {
    exportedAtMs = Date.now();
    events = (await listCalendarEvents({ includeArchived: false }))
      .filter((event) => event.status !== "CANCELLED");
  } else {
    const futureSnapshot = await listFutureCalendarEvents();
    exportedAtMs = futureSnapshot.capturedAtMs;
    events = futureSnapshot.events;
  }

  const exportItems = await addApplicationContext(events);
  if (exportItems.length === 0) return errorResponse("这个范围内没有可导出的事件", 404);
  if (exportItems.length !== events.length || buildIcsSnapshotId(exportItems) !== parsed.snapshot) {
    return errorResponse("事件内容已在预览后变化，请刷新页面并重新核对", 409);
  }

  let verifiedEvents: EventDto[];
  if (parsed.scope === "event") {
    verifiedEvents = (await listCalendarEvents({ includeArchived: false }))
      .filter((event) => event.id === parsed.eventId && event.status !== "CANCELLED");
  } else if (parsed.scope === "visible") {
    verifiedEvents = (await listCalendarEvents({ includeArchived: false }))
      .filter((event) => event.status !== "CANCELLED");
  } else {
    verifiedEvents = await listCalendarEvents({
      fromMs: exportedAtMs,
      includeArchived: false,
      status: "SCHEDULED",
    });
  }
  if (eventRevisionSet(verifiedEvents) !== eventRevisionSet(events)) {
    return errorResponse("事件内容已在预览后变化，请刷新页面并重新核对", 409);
  }

  const calendar = buildIcsCalendar(exportItems, {
    calendarName: "秋招进度板",
    exportedAtMs,
  });
  const filename = buildIcsFilename(parsed.scope, exportedAtMs)
    .replace(/[^A-Za-z0-9._-]/g, "_");

  return new Response(calendar, {
    status: 200,
    headers: {
      ...RESPONSE_HEADERS,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "text/calendar; charset=utf-8",
    },
  });
}
