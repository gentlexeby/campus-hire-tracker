import type { Metadata } from "next";
import Link from "next/link";
import { EventRow, formatDate } from "@/components/domain";
import { EventForm, EventStatusForm } from "@/components/forms";
import { IcsExport } from "@/components/ics-export";
import { CalendarIcon } from "@/components/icons";
import { EmptyState, PageHeader, Section } from "@/components/ui";
import { createEventAction, updateEventStatusAction } from "@/app/actions";
import { toEventView } from "@/app/view-models";
import { buildIcsPreview, buildIcsSnapshotId, type IcsEventInput } from "@/lib/ics";
import { listApplications, listCalendarEvents, listFutureCalendarEvents, type EventDto } from "@/lib/services";

export const metadata: Metadata = { title: "日历" };
export const dynamic = "force-dynamic";

function dateKey(event: EventDto) {
  if (event.schedule.kind === "ALL_DAY") return event.schedule.startDate;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: event.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(event.schedule.startsAtMs));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function exportInputs(
  events: readonly EventDto[],
  labels: ReadonlyMap<string, { companyName: string; positionTitle: string }>,
): IcsEventInput[] {
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

function batchExportHref(scope: "visible" | "future", inputs: readonly IcsEventInput[]) {
  return `/api/calendar-export?scope=${scope}&snapshot=${buildIcsSnapshotId(inputs)}`;
}

export default async function CalendarPage() {
  const [events, applications, futureSnapshot] = await Promise.all([
    listCalendarEvents({ includeArchived: false }),
    listApplications({ includeArchived: false }),
    listFutureCalendarEvents(),
  ]);
  const applicationContext = new Map(applications.map((application) => [application.id, {
    companyName: application.companyName,
    positionTitle: application.positionTitle,
  }]));
  const labels = new Map(applications.map((application) => [application.id, `${application.companyName} · ${application.positionTitle}`]));
  const visibleInputs = exportInputs(
    events.filter((event) => event.status !== "CANCELLED"),
    applicationContext,
  );
  const futureInputs = exportInputs(futureSnapshot.events, applicationContext);
  const visiblePreviews = visibleInputs.map(buildIcsPreview);
  const futurePreviews = futureInputs.map(buildIcsPreview);
  const grouped = new Map<string, EventDto[]>();
  for (const event of events) {
    const key = dateKey(event);
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }

  return (
    <>
      <PageHeader eyebrow="统一日程" title="日历" description="这里先以清晰的日程列表呈现所有安排。冲突会提醒，但最终是否保存由你决定。" />
      <div className="calendar-layout">
        <div className="detail-main">
          {events.length === 0 ? (
            <Section><EmptyState icon={<CalendarIcon size={26} />} title="还没有日程" description={applications.length ? "从右侧为某条申请创建面试、笔试、截止或复查事件。" : "先创建一条申请，再为它安排日程。"} href={applications.length ? undefined : "/applications/new"} actionLabel={applications.length ? undefined : "新建申请"} /></Section>
          ) : Array.from(grouped.entries()).map(([date, dayEvents]) => (
            <section className="calendar-day-group" key={date}>
              <div className="calendar-day-heading"><h2>{formatDate(date)}</h2><span>{dayEvents.length} 项</span></div>
              <div className="event-list">
                {dayEvents.map((event) => {
                  const eventInputs = exportInputs([event], applicationContext);
                  return (
                    <EventRow
                      key={event.id}
                      event={toEventView(event, { applicationLabel: labels.get(event.applicationId) })}
                      actions={<>
                        <Link className="button button-compact" href={`/applications/${event.applicationId}#events`}>查看申请</Link>
                        {event.status === "CANCELLED" ? (
                          <span className="muted compact">已取消，不导出</span>
                        ) : (
                          <IcsExport
                            href={`/api/calendar-export?scope=event&eventId=${encodeURIComponent(event.id)}&snapshot=${buildIcsSnapshotId(eventInputs)}`}
                            items={eventInputs.map(buildIcsPreview)}
                            label="导出此事件"
                            presentation="popover"
                            scopeDescription={event.status === "COMPLETED" ? "只导出此事件。事件已完成，因此不会写入提醒。" : "只导出此事件，并写入下方预览的默认提醒。"}
                          />
                        )}
                        <EventStatusForm action={updateEventStatusAction} available={event.status === "SCHEDULED"} eventId={event.id} expectedVersion={event.version} label={event.type === "ACTION_DUE" || event.type === "FOLLOW_UP" ? "完成并待补下一步" : "标记完成"} status="COMPLETED" />
                        <EventStatusForm action={updateEventStatusAction} available={event.status === "SCHEDULED"} eventId={event.id} expectedVersion={event.version} label={event.type === "ACTION_DUE" || event.type === "FOLLOW_UP" ? "取消并待补下一步" : "取消事件"} status="CANCELLED" />
                      </>}
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        <aside className="quick-panel">
          <Section title="导出到系统日历" description="下载标准 ICS 文件，再导入你使用的系统日历。">
            <div className="ics-export-stack">
              <IcsExport
                href={batchExportHref("visible", visibleInputs)}
                items={visiblePreviews}
                label="导出当前列表"
                scopeDescription="当前页面没有筛选：这里包含完整日程列表中的所有未取消事件，含过去与未来；已完成事件不带提醒。"
              />
              <IcsExport
                href={batchExportHref("future", futureInputs)}
                items={futurePreviews}
                label="导出全部未来事件"
                scopeDescription="包含活跃申请中从现在起仍有效的已安排事件；不包含已完成、已取消或归档申请的事件。"
              />
            </div>
          </Section>
          <Section title="新建事件" description="事件结束不会自动改变申请阶段。">
            {applications.length ? <EventForm action={createEventAction} applications={applications.map(({ id, companyName, positionTitle }) => ({ id, companyName, positionTitle }))} /> : <p className="muted">创建第一条申请后即可安排事件。</p>}
          </Section>
        </aside>
      </div>
    </>
  );
}
