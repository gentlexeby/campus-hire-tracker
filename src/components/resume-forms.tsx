"use client";

import { useActionState, useState, type ChangeEvent, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { setResumeArchivedAction } from "@/app/actions";
import { initialFormState } from "@/components/form-state";
import { Field } from "@/components/ui";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DOCX_ACCEPT = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_ACCEPT = ".pdf,application/pdf";

type UploadMode = "create" | "version";

function selectedFile(form: HTMLFormElement, name: string) {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement)) return null;
  return field.files?.[0] ?? null;
}

function validateFiles(form: HTMLFormElement, requireOne: boolean) {
  const sourceDocx = selectedFile(form, "sourceDocx");
  const deliveryPdf = selectedFile(form, "deliveryPdf");

  if (requireOne && !sourceDocx && !deliveryPdf) {
    return "请至少选择一个 DOCX 源文件或 PDF 投递文件。";
  }
  if (sourceDocx?.size === 0 || deliveryPdf?.size === 0) {
    return "所选文件是空文件，请重新选择。";
  }
  if (sourceDocx && !sourceDocx.name.toLocaleLowerCase("en-US").endsWith(".docx")) {
    return "DOCX 源文件必须使用 .docx 格式。";
  }
  if (deliveryPdf && !deliveryPdf.name.toLocaleLowerCase("en-US").endsWith(".pdf")) {
    return "PDF 投递文件必须使用 .pdf 格式。";
  }
  if (sourceDocx && sourceDocx.size > MAX_FILE_SIZE_BYTES) {
    return `DOCX 源文件“${sourceDocx.name}”超过 10 MB。`;
  }
  if (deliveryPdf && deliveryPdf.size > MAX_FILE_SIZE_BYTES) {
    return `PDF 投递文件“${deliveryPdf.name}”超过 10 MB。`;
  }
  return null;
}

export function ResumeUploadForm({
  mode,
  resumeId,
}: {
  mode: UploadMode;
  resumeId?: string;
}) {
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const prefix = mode === "create" ? "new-resume" : "resume-version";
  const action = mode === "create"
    ? "/api/resumes"
    : `/api/resumes/${encodeURIComponent(resumeId ?? "")}/versions`;

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const form = event.currentTarget.form;
    if (form) setFileError(validateFiles(form, false));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const error = validateFiles(event.currentTarget, true);
    setFileError(error);
    if (error) {
      event.preventDefault();
      setSubmitting(false);
      return;
    }
    setSubmitting(true);
  }

  return (
    <form
      action={action}
      aria-busy={submitting}
      className="stack-form compact-form resume-upload-form"
      encType="multipart/form-data"
      method="post"
      onSubmit={handleSubmit}
    >
      {mode === "create" ? (
        <div className="form-grid">
          <Field label="简历名称" required>
            <input
              autoFocus
              className="input"
              maxLength={200}
              name="name"
              placeholder="例如：后端开发校招版"
              required
            />
          </Field>
          <Field label="目标方向" hint="可留空，之后按版本继续整理">
            <input
              className="input"
              maxLength={200}
              name="targetDirection"
              placeholder="例如：后端开发 / 数据工程"
            />
          </Field>
          <Field label="语言" hint="可留空">
            <input
              className="input"
              maxLength={80}
              name="language"
              placeholder="例如：中文 / 英文"
            />
          </Field>
          <Field label="初始版本说明" hint="可留空">
            <input
              className="input"
              maxLength={1_000}
              name="changeSummary"
              placeholder="例如：用于互联网后端岗位"
            />
          </Field>
        </div>
      ) : (
        <Field label="本次改动" hint="可留空；建议写下投递方向或主要修改">
          <textarea
            className="textarea resume-summary-input"
            maxLength={1_000}
            name="changeSummary"
            placeholder="例如：压缩项目描述，补充实习成果数据"
            rows={3}
          />
        </Field>
      )}

      <div className="resume-file-fields">
        <Field label="DOCX 源文件" hint="可编辑的 Word 版本">
          <input
            accept={DOCX_ACCEPT}
            aria-describedby={`${prefix}-upload-rules${fileError ? ` ${prefix}-file-error` : ""}`}
            className="input resume-file-input"
            name="sourceDocx"
            onChange={handleFileChange}
            type="file"
          />
        </Field>
        <Field label="PDF 投递文件" hint="实际投递或预览用版本">
          <input
            accept={PDF_ACCEPT}
            aria-describedby={`${prefix}-upload-rules${fileError ? ` ${prefix}-file-error` : ""}`}
            className="input resume-file-input"
            name="deliveryPdf"
            onChange={handleFileChange}
            type="file"
          />
        </Field>
      </div>

      <p className="resume-upload-rules" id={`${prefix}-upload-rules`}>
        至少选择一个文件；每个文件最大 10 MB。文件只保存到这台电脑，不会自动上传到云端。
      </p>
      {fileError ? (
        <p className="form-message is-error" id={`${prefix}-file-error`} role="alert">
          {fileError}
        </p>
      ) : null}
      <div className="form-actions">
        <button className="button button-primary" disabled={submitting} type="submit">
          {submitting ? "正在保存…" : mode === "create" ? "创建简历" : "保存新版本"}
        </button>
      </div>
    </form>
  );
}

function ArchiveSubmitButton({ archived }: { archived: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      className={archived ? "button button-compact" : "button button-danger button-compact"}
      disabled={pending}
      type="submit"
    >
      {pending ? "处理中…" : archived ? "恢复简历" : "归档简历"}
    </button>
  );
}

export function ResumeArchiveForm({ resumeId, archived }: { resumeId: string; archived: boolean }) {
  const [state, formAction] = useActionState(setResumeArchivedAction, initialFormState);

  return (
    <div className="resume-archive-control">
      <form action={formAction}>
        <input name="resumeId" type="hidden" value={resumeId} />
        <input name="archived" type="hidden" value={archived ? "false" : "true"} />
        <ArchiveSubmitButton archived={archived} />
      </form>
      {state.message ? (
        <p className={state.ok ? "form-message is-success" : "form-message is-error"} role={state.ok ? "status" : "alert"}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
