import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ResumeArchiveForm, ResumeUploadForm } from "@/components/resume-forms";
import { ResumeIcon } from "@/components/icons";
import { EmptyState, Section, StatusPill } from "@/components/ui";
import { getResumeDetail } from "@/lib/services";
import { getResumePageMessage } from "@/app/resumes/messages";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type ResumeDetail = NonNullable<Awaited<ReturnType<typeof getResumeDetail>>>;
type ResumeVersion = ResumeDetail["versions"][number];
type ResumeFile = NonNullable<ResumeVersion["sourceDocx"] | ResumeVersion["deliveryPdf"]>;

export const dynamic = "force-dynamic";

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDateTime(value: number) {
  return dateTimeFormatter.format(new Date(value));
}

function formatFileSize(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function ResumeFileLink({
  file,
  format,
  version,
}: {
  file: ResumeFile;
  format: "DOCX" | "PDF";
  version: ResumeVersion;
}) {
  const route = format === "PDF" ? "pdf" : "docx";
  return (
    <a
      aria-label={`${format === "PDF" ? "预览" : "下载"} v${version.versionNumber} ${format}：${file.originalName}`}
      className="resume-file-card"
      href={`/api/resume-files/${encodeURIComponent(version.id)}/${route}`}
      rel={format === "PDF" ? "noreferrer" : undefined}
      target={format === "PDF" ? "_blank" : undefined}
    >
      <span className={format === "PDF" ? "resume-format-badge is-pdf" : "resume-format-badge"}>{format}</span>
      <span className="resume-file-copy">
        <strong>{file.originalName}</strong>
        <small>{formatFileSize(file.sizeBytes)} · SHA-256 {file.sha256.slice(0, 12)}…</small>
      </span>
      <span className="resume-file-action">{format === "PDF" ? "预览" : "下载"}</span>
    </a>
  );
}

function VersionCard({ version, latest }: { version: ResumeVersion; latest: boolean }) {
  return (
    <article className={latest ? "resume-version-card is-latest" : "resume-version-card"}>
      <header className="resume-version-heading">
        <div>
          <div className="resume-version-title">
            <h3>版本 {version.versionNumber}</h3>
            {latest ? <StatusPill tone="accent">当前最新</StatusPill> : null}
          </div>
          <time dateTime={new Date(version.createdAtMs).toISOString()}>{formatDateTime(version.createdAtMs)}</time>
        </div>
      </header>
      <p className={version.changeSummary ? "resume-version-summary" : "resume-version-summary is-empty"}>
        {version.changeSummary || "未填写本次改动说明"}
      </p>
      <div className="resume-version-files">
        {version.deliveryPdf ? <ResumeFileLink file={version.deliveryPdf} format="PDF" version={version} /> : null}
        {version.sourceDocx ? <ResumeFileLink file={version.sourceDocx} format="DOCX" version={version} /> : null}
      </div>
    </article>
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resume = await getResumeDetail((await params).id);
  return { title: resume ? resume.name : "简历不存在" };
}

export default async function ResumeDetailPage({ params, searchParams }: PageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const resume = await getResumeDetail(id);
  if (!resume) notFound();

  const archived = resume.archivedAtMs != null;
  const message = getResumePageMessage(query);

  return (
    <>
      <Link className="detail-breadcrumb" href="/resumes">← 返回简历库</Link>
      {message ? (
        <div
          className={message.kind === "success" ? "form-message is-success page-message" : "form-message is-error page-message"}
          role={message.kind === "success" ? "status" : "alert"}
        >
          {message.text}
        </div>
      ) : null}

      <header className="detail-hero resume-detail-hero">
        <div>
          <p className="detail-company">简历库</p>
          <h1>{resume.name}</h1>
          <div className="detail-meta">
            <StatusPill tone={archived ? "neutral" : "success"}>{archived ? "已归档" : "正在使用"}</StatusPill>
            {resume.latestVersion ? <StatusPill tone="accent">最新 v{resume.latestVersion.versionNumber}</StatusPill> : <StatusPill>暂无版本</StatusPill>}
            {resume.targetDirection ? <StatusPill>{resume.targetDirection}</StatusPill> : null}
            {resume.language ? <StatusPill>{resume.language}</StatusPill> : null}
          </div>
        </div>
        <ResumeArchiveForm archived={archived} resumeId={resume.id} />
      </header>

      <div className="detail-grid resume-detail-grid">
        <div className="detail-main">
          <Section
            description="每次上传都会生成独立版本；旧文件不会被新版本覆盖。"
            title={`版本历史 · ${resume.versions.length}`}
          >
            {resume.versions.length ? (
              <div className="resume-version-list">
                {resume.versions.map((version) => (
                  <VersionCard
                    key={version.id}
                    latest={version.id === resume.latestVersion?.id}
                    version={version}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                description={archived ? "这份归档简历没有可下载的版本。" : "上传 DOCX 或 PDF，建立第一条可回看的版本记录。"}
                icon={<ResumeIcon size={26} />}
                title="还没有版本"
              />
            )}
          </Section>
        </div>

        <aside className="detail-aside">
          {archived ? (
            <Section title="新增版本" description="归档简历保持只读。">
              <p className="notice notice-info">先恢复这份简历，再上传新的 DOCX 或 PDF 版本。</p>
            </Section>
          ) : (
            <Section
              description="至少选择 DOCX 或 PDF 之一；旧版本会继续保留。"
              title="新增版本"
            >
              <ResumeUploadForm mode="version" resumeId={resume.id} />
            </Section>
          )}

          <Section title="简历信息">
            <dl className="side-facts">
              <div><dt>目标方向</dt><dd>{resume.targetDirection || "未填写"}</dd></div>
              <div><dt>语言</dt><dd>{resume.language || "未填写"}</dd></div>
              <div><dt>创建时间</dt><dd>{formatDateTime(resume.createdAtMs)}</dd></div>
              <div><dt>最近更新</dt><dd>{formatDateTime(resume.updatedAtMs)}</dd></div>
              {resume.archivedAtMs ? <div><dt>归档时间</dt><dd>{formatDateTime(resume.archivedAtMs)}</dd></div> : null}
            </dl>
          </Section>
        </aside>
      </div>
    </>
  );
}
