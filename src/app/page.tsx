import type { Metadata } from "next";
import Link from "next/link";
import { ApplicationCard, EventRow } from "@/components/domain";
import { EventStatusForm } from "@/components/forms";
import { CalendarIcon, ClockIcon, PlusIcon, TodayIcon } from "@/components/icons";
import { EmptyState, PageHeader, Section, StatusPill } from "@/components/ui";
import { updateEventStatusAction } from "@/app/actions";
import { toApplicationView, toEventView } from "@/app/view-models";
import { getTodayDashboard, listApplications, type EventDto } from "@/lib/services";

export const metadata: Metadata = { title: "今日" };
export const dynamic = "force-dynamic";

function eventActions(event: EventDto) {
  return (
    <>
      <Link className="button button-compact" href={`/applications/${event.applicationId}#events`}>查看申请</Link>
      <EventStatusForm action={updateEventStatusAction} available={event.status === "SCHEDULED"} eventId={event.id} expectedVersion={event.version} label={event.type === "ACTION_DUE" || event.type === "FOLLOW_UP" ? "完成并待补下一步" : "标记完成"} status="COMPLETED" />
    </>
  );
}

export default async function TodayPage() {
  const [dashboard, applications] = await Promise.all([
    getTodayDashboard(),
    listApplications(),
  ]);
  const applicationLabels = new Map(applications.map((item) => [item.id, `${item.companyName} · ${item.positionTitle}`]));
  const conflictIds = new Set(dashboard.conflicts.flatMap((pair) => [pair.first.id, pair.second.id]));
  const riskEvents = new Map<string, EventDto>();
  dashboard.overdue.forEach((event) => riskEvents.set(event.id, event));
  dashboard.conflicts.forEach(({ first, second }) => { riskEvents.set(first.id, first); riskEvents.set(second.id, second); });
  const hasAnything = dashboard.counts.activeApplications > 0 || dashboard.counts.today > 0 || dashboard.counts.upcomingSevenDays > 0;
  const todayLabel = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date(dashboard.generatedAtMs));

  return (
    <>
      <PageHeader
        eyebrow={todayLabel}
        title="现在最需要做什么？"
        description={dashboard.counts.overdue || dashboard.counts.conflictPairs ? "先处理逾期与时间冲突，再安排今天的行动。" : "没有紧急风险，按自己的节奏推进今天的事项。"}
        action={<Link className="button button-primary" href="/applications/new"><PlusIcon size={18} />新建申请</Link>}
      />

      <div className="dashboard-summary" aria-label="今日摘要">
        <div className={`summary-tile ${dashboard.counts.overdue || dashboard.counts.conflictPairs ? "is-danger" : ""}`}><span className="summary-tile-icon"><TodayIcon size={20} /></span><div><strong>{dashboard.counts.overdue + dashboard.counts.conflictPairs}</strong><small>逾期 / 冲突</small></div></div>
        <div className="summary-tile is-accent"><span className="summary-tile-icon"><ClockIcon size={20} /></span><div><strong>{dashboard.counts.today}</strong><small>今天</small></div></div>
        <div className="summary-tile"><span className="summary-tile-icon"><CalendarIcon size={20} /></span><div><strong>{dashboard.counts.upcomingSevenDays}</strong><small>未来 7 天</small></div></div>
        <div className={`summary-tile ${dashboard.counts.needsAction ? "is-warning" : ""}`}><span className="summary-tile-icon"><PlusIcon size={20} /></span><div><strong>{dashboard.counts.needsAction}</strong><small>缺少下一步</small></div></div>
      </div>

      {!hasAnything ? (
        <Section><EmptyState icon={<TodayIcon size={27} />} title="还没有求职记录" description="从公司和岗位开始记录，今天该做什么会自动汇总在这里。" href="/applications/new" actionLabel="创建第一条申请" /></Section>
      ) : (
        <div className="dashboard-sections">
          {riskEvents.size ? (
            <Section className="risk-section">
              <div className="dashboard-section-heading"><div><h2>逾期与冲突</h2><p>需要优先确认的日程风险</p></div><StatusPill tone="danger">{riskEvents.size} 项</StatusPill></div>
              <div className="event-list">{Array.from(riskEvents.values()).map((event) => <EventRow actions={eventActions(event)} event={toEventView(event, { applicationLabel: applicationLabels.get(event.applicationId), isConflict: conflictIds.has(event.id) })} key={event.id} />)}</div>
            </Section>
          ) : null}

          {dashboard.today.length ? (
            <Section><div className="dashboard-section-heading"><div><h2>今天</h2><p>今天发生或截止的事项</p></div><StatusPill tone="accent">{dashboard.today.length} 项</StatusPill></div><div className="event-list">{dashboard.today.map((event) => <EventRow actions={eventActions(event)} event={toEventView(event, { applicationLabel: applicationLabels.get(event.applicationId), isConflict: conflictIds.has(event.id) })} key={event.id} />)}</div></Section>
          ) : null}

          {dashboard.upcomingSevenDays.length ? (
            <Section><div className="dashboard-section-heading"><div><h2>未来 7 天</h2><p>从明天开始的近期安排</p></div><Link className="text-link" href="/calendar">查看日程</Link></div><div className="event-list">{dashboard.upcomingSevenDays.map((event) => <EventRow actions={eventActions(event)} event={toEventView(event, { applicationLabel: applicationLabels.get(event.applicationId), isConflict: conflictIds.has(event.id) })} key={event.id} />)}</div></Section>
          ) : null}

          {dashboard.waitingReview.length ? (
            <Section><div className="dashboard-section-heading"><div><h2>等待复查</h2><p>已到或临近复查时间的申请</p></div><StatusPill tone="info">{dashboard.waitingReview.length} 条</StatusPill></div><div className="dashboard-card-grid">{dashboard.waitingReview.map((application) => <ApplicationCard application={toApplicationView(application)} key={application.id} />)}</div></Section>
          ) : null}

          {dashboard.needsAction.length ? (
            <Section><div className="dashboard-section-heading"><div><h2>缺少下一步</h2><p>不是错误，只是提醒你为这些申请安排下一件事</p></div><StatusPill tone="warning">{dashboard.needsAction.length} 条</StatusPill></div><div className="dashboard-card-grid">{dashboard.needsAction.map((application) => <ApplicationCard application={toApplicationView(application)} key={application.id} />)}</div></Section>
          ) : null}

          {!riskEvents.size && !dashboard.today.length && !dashboard.upcomingSevenDays.length && !dashboard.waitingReview.length && !dashboard.needsAction.length ? (
            <Section><EmptyState title="目前没有需要处理的事项" description="所有活跃申请都有清楚的安排。你也可以查看全部申请或新建事件。" href="/applications" actionLabel="查看全部申请" /></Section>
          ) : null}
        </div>
      )}
    </>
  );
}
