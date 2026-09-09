import type { Metadata } from "next";
import Link from "next/link";
import { EventRow, formatDate } from "@/components/domain";
import { EventForm, EventStatusForm } from "@/components/forms";
import { CalendarIcon } from "@/components/icons";
import { EmptyState, PageHeader, Section } from "@/components/ui";
import { createEventAction, updateEventStatusAction } from "@/app/actions";
import { toEventView } from "@/app/view-models";
import { listApplications, listCalendarEvents, type EventDto } from "@/lib/services";

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

export default async function CalendarPage() {
  const [events, applications] = await Promise.all([
    listCalendarEvents({ includeArchived: false }),
    listApplications(),
  ]);
  const labels = new Map(applications.map((application) => [application.id, `${application.companyName} · ${application.positionTitle}`]));
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
                {dayEvents.map((event) => (
                  <EventRow
                    key={event.id}
                    event={toEventView(event, { applicationLabel: labels.get(event.applicationId) })}
                    actions={<><Link className="button button-compact" href={`/applications/${event.applicationId}#events`}>查看申请</Link><EventStatusForm action={updateEventStatusAction} available={event.status === "SCHEDULED"} eventId={event.id} expectedVersion={event.version} label={event.type === "ACTION_DUE" || event.type === "FOLLOW_UP" ? "完成并待补下一步" : "标记完成"} status="COMPLETED" /><EventStatusForm action={updateEventStatusAction} available={event.status === "SCHEDULED"} eventId={event.id} expectedVersion={event.version} label={event.type === "ACTION_DUE" || event.type === "FOLLOW_UP" ? "取消并待补下一步" : "取消事件"} status="CANCELLED" /></>}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
        <aside className="quick-panel">
          <Section title="新建事件" description="事件结束不会自动改变申请阶段。">
            {applications.length ? <EventForm action={createEventAction} applications={applications.map(({ id, companyName, positionTitle }) => ({ id, companyName, positionTitle }))} /> : <p className="muted">创建第一条申请后即可安排事件。</p>}
          </Section>
        </aside>
      </div>
    </>
  );
}
