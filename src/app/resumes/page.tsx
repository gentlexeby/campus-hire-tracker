import type { Metadata } from "next";
import Link from "next/link";
import { ResumeUploadForm } from "@/components/resume-forms";
import { PlusIcon, ResumeIcon } from "@/components/icons";
import { EmptyState, PageHeader, Section, StatusPill } from "@/components/ui";
import { listResumes } from "@/lib/services";
import { getResumePageMessage } from "@/app/resumes/messages";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type ResumeSummary = (Awaited<ReturnType<typeof listResumes>>)[number];

export const metadata: Metadata = { title: "简历" };
export const dynamic = "force-dynamic";

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDateTime(value: number) {
  return dateTimeFormatter.format(new Date(value));
}

function ResumeCard({ resume }: { resume: ResumeSummary }) {
  const version = resume.latestVersion;
  return (
    <Link
      aria-label={`查看简历：${resume.name}`}
      className={resume.archivedAtMs ? "resume-card is-archived" : "resume-card"}
      href={`/resumes/${encodeURIComponent(resume.id)}`}
    >
      <div className="resume-card-heading">
        <span className="resume-card-icon"><ResumeIcon size={21} /></span>
        <div>
          <h3>{resume.name}</h3>
          <p>{resume.targetDirection || "尚未填写目标方向"}</p>
        </div>
        {resume.archivedAtMs ? <StatusPill>已归档</StatusPill> : null}
      </div>
      <div className="resume-card-meta">
        <span>{resume.language || "语言未填写"}</span>
        <span>{version ? `v${version.versionNumber}` : "暂无版本"}</span>
        {version?.sourceDocx ? <span className="resume-format-badge">DOCX</span> : null}
        {version?.deliveryPdf ? <span className="resume-format-badge is-pdf">PDF</span> : null}
      </div>
      <p className="resume-card-updated">
        {version ? `最新版本 · ${formatDateTime(version.createdAtMs)}` : `更新于 ${formatDateTime(resume.updatedAtMs)}`}
      </p>
    </Link>
  );
}

function ResumeGrid({ resumes }: { resumes: ResumeSummary[] }) {
  return <div className="resume-card-grid">{resumes.map((resume) => <ResumeCard key={resume.id} resume={resume} />)}</div>;
}

export default async function ResumesPage({ searchParams }: PageProps) {
  const [resumes, query] = await Promise.all([
    listResumes({ includeArchived: true }),
    searchParams,
  ]);
  const activeResumes = resumes.filter((resume) => resume.archivedAtMs == null);
  const archivedResumes = resumes.filter((resume) => resume.archivedAtMs != null);
  const message = getResumePageMessage(query);

  return (
    <>
      <PageHeader
        action={<a className="button button-primary" href="#new-resume"><PlusIcon size={18} />新建简历</a>}
        description="保存不同投递方向的 DOCX 与 PDF，按版本回看每次修改；文件只留在这台电脑。"
        eyebrow="投递材料"
        title="简历库"
      />

      {message ? (
        <div
          className={message.kind === "success" ? "form-message is-success page-message" : "form-message is-error page-message"}
          role={message.kind === "success" ? "status" : "alert"}
        >
          {message.text}
        </div>
      ) : null}

      <div className="resume-library-layout">
        <div className="resume-library-main">
          <Section
            description="每张卡片展示当前最新版本；进入详情可以下载或继续添加版本。"
            title={`正在使用 · ${activeResumes.length}`}
          >
            {activeResumes.length ? (
              <ResumeGrid resumes={activeResumes} />
            ) : (
              <EmptyState
                actionLabel="创建第一份简历"
                description="先保存一份 DOCX 源文件或 PDF 投递文件，以后每次修改都可以新增版本。"
                href="#new-resume"
                icon={<ResumeIcon size={26} />}
                title="还没有活跃简历"
              />
            )}
          </Section>

          {archivedResumes.length ? (
            <details className="section-card resume-archived-section" open={activeResumes.length === 0}>
              <summary>
                <span>已归档简历</span>
                <StatusPill>{archivedResumes.length} 份</StatusPill>
              </summary>
              <p className="muted compact">归档只会收起简历，不会删除文件或版本历史。</p>
              <ResumeGrid resumes={archivedResumes} />
            </details>
          ) : null}
        </div>

        <aside className="quick-panel resume-create-panel" id="new-resume">
          <Section
            description="名称用于区分投递方向；首个版本至少上传一种文件。"
            title="新建简历"
          >
            <ResumeUploadForm mode="create" />
          </Section>
          <p className="privacy-footnote">上传内容不会进入 Git 仓库，也不会自动同步到云端。</p>
        </aside>
      </div>
    </>
  );
}
