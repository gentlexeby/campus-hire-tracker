import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AttentionSummary,
  EventRow,
  formatDateTime,
  priorityLabel,
  stageLabel,
  TimelineList,
} from "@/components/domain";
import {
  ApplicationBasicsForm,
  ArchiveForm,
  AttentionForm,
  EventForm,
  EventStatusForm,
  RestoreForm,
  StageForm,
} from "@/components/forms";
import { IcsExport } from "@/components/ics-export";
import { Section, StatusPill } from "@/components/ui";
import { RecoverableNotesEditor } from "@/components/recoverable-notes-editor";
import { ResumeLinkForm } from "@/components/resume-link-form";
import {
  archiveApplicationAction,
  createEventAction,
  restoreApplicationAction,
  setAttentionAction,
  setApplicationResumeVersionAction,
  setStageAction,
  updateApplicationAction,
  updateApplicationNotesAction,
  updateEventStatusAction,
} from "@/app/actions";
import { toApplicationView, toEventView, toTimelineView } from "@/app/view-models";
import { buildIcsPreview, buildIcsSnapshotId } from "@/lib/ics";
import { getApplicationDetail, listResumeVersionChoices } from "@/lib/services";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; archived?: string; restored?: string }>;
};

const archiveReasonLabels: Record<string, string> = {
  REJECTED: "被拒绝",
  ABANDONED: "主动放弃",
  WITHDRAWN: "撤回申请",
  OTHER: "其他",
};

const sourceLabels: Record<string, string> = {
  UNSPECIFIED: "未填写",
  OFFICIAL_SITE: "官网",
  JOB_PLATFORM: "招聘平台",
  REFERRAL: "内推",
  CAMPUS_CHANNEL: "校园渠道",
  CUSTOM: "自定义",
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const application = await getApplicationDetail((await params).id);
  return { title: application ? `${application.companyName} · ${application.positionTitle}` : "申请不存在" };
}

export const dynamic = "force-dynamic";

export default async function ApplicationDetailPage({ params, searchParams }: PageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const [application, resumeChoices] = await Promise.all([
    getApplicationDetail(id),
    listResumeVersionChoices(),
  ]);
  if (!application) notFound();
  const view = toApplicationView(application);
  const isArchived = application.stage === "ARCHIVED";
  const successMessage = query.created ? "申请已创建。现在可以设置下一步或安排事件。" : query.archived ? "申请已归档，历史和事件仍然保留。" : query.restored ? "申请已恢复，并进入“缺少下一步”队列。" : null;

  return (
    <>
      <Link className="detail-breadcrumb" href="/applications">← 返回所有申请</Link>
      {successMessage ? <div className="form-message is-success page-message" role="status">{successMessage}</div> : null}
      <header className="detail-hero">
        <div>
          <p className="detail-company">{application.companyName}</p>
          <h1>{application.positionTitle}</h1>
          <div className="detail-meta">
            <StatusPill tone={isArchived ? "neutral" : "info"}>{stageLabel(application.stage)}</StatusPill>
            <StatusPill tone={application.priority === "HIGH" ? "danger" : application.priority === "LOW" ? "neutral" : "warning"}>{priorityLabel(application.priority)}优先级</StatusPill>
            {application.cycleLabel ? <StatusPill>{application.cycleLabel}</StatusPill> : null}
          </div>
        </div>
        {!isArchived ? <StageForm action={setStageAction} applicationId={application.id} currentStage={application.stage} expectedVersion={application.version} /> : null}
      </header>

      <nav className="anchor-tabs" aria-label="申请详情章节">
        <a href="#overview">概览</a><a href="#process">流程</a><a href="#events">事件</a><a href="#notes">备注</a><a href="#materials">资料</a><a href="#timeline">时间线</a>
      </nav>

      <div className="detail-grid">
        <div className="detail-main">
          <Section id="overview" title="申请概览" description={isArchived ? "归档记录为只读；恢复后可以继续编辑。" : "更新公司、岗位和来源信息。保存失败时输入会留在页面中。"}>
            {isArchived ? (
              <dl className="facts-grid">
                <div><dt>公司</dt><dd>{application.companyName}</dd></div><div><dt>岗位</dt><dd>{application.positionTitle}</dd></div><div><dt>批次</dt><dd>{application.cycleLabel || "未填写"}</dd></div><div><dt>地点</dt><dd>{application.location || "未填写"}</dd></div><div><dt>来源</dt><dd>{sourceLabels[application.sourceKind] ?? application.sourceKind}{application.sourceDetail ? ` · ${application.sourceDetail}` : ""}</dd></div><div><dt>归档时间</dt><dd>{formatDateTime(application.archivedAtMs)}</dd></div>
              </dl>
            ) : <ApplicationBasicsForm action={updateApplicationAction} application={application} />}
          </Section>

          <Section id="process" title="当前流程" description="阶段由你确认；系统不会因为事件结束或结果录入而自动推进。">
            <div className="current-attention"><AttentionSummary application={view} /></div>
            {isArchived ? <p className="muted">恢复申请后，可以重新设置下一步行动或等待复查。</p> : (
              <AttentionForm
                action={setAttentionAction}
                applicationId={application.id}
                attentionAtMs={application.attentionAtMs}
                attentionDate={application.attentionDate}
                currentMode={application.attentionMode}
                expectedVersion={application.version}
                nextActionTitle={application.nextActionTitle}
                waitingFor={application.waitingFor}
              />
            )}
          </Section>

          <Section id="events" title="事件" description="面试、笔试、截止和复查都在同一日程中；事件完成不会改变主阶段。">
            {application.events.length ? (
              <div className="event-list detail-event-list">
                {application.events.map((event) => {
                  const exportInput = {
                    event,
                    companyName: application.companyName,
                    positionTitle: application.positionTitle,
                    ...(event.status === "COMPLETED" ? { reminderMinutes: [] } : {}),
                  };
                  const preview = buildIcsPreview(exportInput);
                  return (
                    <EventRow
                      event={toEventView(event)}
                      key={event.id}
                      actions={<>
                        {isArchived || event.status === "CANCELLED" ? (
                          <span className="muted compact">{isArchived ? "归档申请不导出" : "已取消，不导出"}</span>
                        ) : (
                          <IcsExport
                            href={`/api/calendar-export?scope=event&eventId=${encodeURIComponent(event.id)}&snapshot=${buildIcsSnapshotId([exportInput])}`}
                            items={[preview]}
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
            ) : <p className="muted">还没有事件。</p>}
            {!isArchived ? <details className="form-details event-create-details"><summary>＋ 为这条申请新建事件</summary><div className="details-grid"><EventForm action={createEventAction} applications={[{ id: application.id, companyName: application.companyName, positionTitle: application.positionTitle }]} defaultApplicationId={application.id} /></div></details> : null}
          </Section>

          <Section id="notes" title="申请备注" description={isArchived ? "归档记录为只读；恢复后可以继续编辑。" : "未保存内容会暂存于当前浏览器；重新打开页面时由你决定是否恢复，系统不会静默覆盖。"}>
            {isArchived ? (
              <pre className={application.notesMarkdown ? "notes-readonly" : "notes-readonly is-empty"}>{application.notesMarkdown || "暂无备注"}</pre>
            ) : (
              <RecoverableNotesEditor
                action={updateApplicationNotesAction}
                applicationId={application.id}
                notesMarkdown={application.notesMarkdown}
                serverUpdatedAtMs={application.updatedAtMs}
                serverVersion={application.version}
              />
            )}
          </Section>

          <Section id="materials" title="投递简历" description="关联当时实际使用的 PDF 版本；之后上传新版本不会静默改掉这条记录。">
            <ResumeLinkForm
              action={setApplicationResumeVersionAction}
              applicationId={application.id}
              choices={resumeChoices
                .filter((choice) => !choice.archived || choice.id === application.resumeVersionId)
                .map((choice) => ({
                  id: choice.id,
                  resumeId: choice.resumeId,
                  label: `${choice.resumeName} · V${choice.versionNumber}`,
                  pdfOriginalName: choice.pdfOriginalName,
                  archived: choice.archived,
                }))}
              currentVersionId={application.resumeVersionId}
              disabled={isArchived}
              expectedVersion={application.version}
            />
          </Section>

          <Section id="timeline" title="时间线" description="事实按时间倒序记录，不直接编辑或删除。">
            <TimelineList entries={application.timeline.map(toTimelineView)} />
          </Section>
        </div>

        <aside className="detail-aside">
          <Section title={isArchived ? "已归档" : "推进摘要"}>
            {isArchived ? <><p className="muted">{archiveReasonLabels[application.archiveReason ?? ""] ?? "已结束"}{application.archiveNote ? `：${application.archiveNote}` : ""}</p><RestoreForm action={restoreApplicationAction} applicationId={application.id} expectedVersion={application.version} suggestedStage={application.archivedFromStage ?? "OPPORTUNITY_POOL"} /></> : <><AttentionSummary application={view} />{application.nextEvent ? <div className="aside-fact"><span>最近事件</span><strong>{application.nextEvent.title}</strong></div> : <div className="aside-fact"><span>最近事件</span><strong>尚未安排</strong></div>}</>}
          </Section>

          <Section title="记录信息">
            <dl className="side-facts"><div><dt>创建时间</dt><dd>{formatDateTime(application.createdAtMs)}</dd></div><div><dt>最近更新</dt><dd>{formatDateTime(application.updatedAtMs)}</dd></div><div><dt>来源</dt><dd>{sourceLabels[application.sourceKind] ?? application.sourceKind}</dd></div><div><dt>本地版本</dt><dd>#{application.version}</dd></div></dl>
          </Section>

          {!isArchived ? <Section title="结束这次申请" description="归档不同于删除，历史仍然保留。"><details className="form-details"><summary>归档申请</summary><div className="details-grid"><ArchiveForm action={archiveApplicationAction} applicationId={application.id} expectedVersion={application.version} /></div></details></Section> : null}
        </aside>
      </div>
    </>
  );
}
