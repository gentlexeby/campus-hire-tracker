"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { initialFormState, type FormState } from "@/components/form-state";

type FormAction = (state: FormState, formData: FormData) => Promise<FormState>;

export interface ResumeLinkChoice {
  id: string;
  resumeId: string;
  label: string;
  pdfOriginalName: string;
  archived: boolean;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="button button-primary button-compact" disabled={pending} type="submit">
      {pending ? "正在保存…" : "保存关联"}
    </button>
  );
}

export function ResumeLinkForm({
  action,
  applicationId,
  choices,
  currentVersionId,
  expectedVersion,
  disabled = false,
}: {
  action: FormAction;
  applicationId: string;
  choices: ResumeLinkChoice[];
  currentVersionId: string | null;
  expectedVersion: number;
  disabled?: boolean;
}) {
  const [state, formAction] = useActionState(action, initialFormState);
  const selected = choices.find((choice) => choice.id === currentVersionId) ?? null;

  if (choices.length === 0) {
    return (
      <div className="resume-link-empty">
        <p className="muted">还没有可投递的 PDF 简历版本。</p>
        <Link className="button button-compact" href="/resumes#new-resume">先添加简历</Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="stack-form compact-form">
      <input name="applicationId" type="hidden" value={applicationId} />
      <input name="expectedVersion" type="hidden" value={expectedVersion} />
      {state.message ? (
        <div className={state.ok ? "form-message is-success" : "form-message is-error"} role={state.ok ? "status" : "alert"}>
          {state.message}
        </div>
      ) : null}
      <label className="field">
        <span className="field-label">实际投递版本</span>
        <select
          className="select"
          defaultValue={currentVersionId ?? ""}
          disabled={disabled}
          name="resumeVersionId"
        >
          <option value="">暂不关联</option>
          {choices.map((choice) => (
            <option
              disabled={choice.archived && choice.id !== currentVersionId}
              key={choice.id}
              value={choice.id}
            >
              {choice.label}{choice.archived ? "（已归档）" : ""}
            </option>
          ))}
        </select>
        <span className="field-hint">只列出包含 PDF 的版本；保存后会写入申请时间线。</span>
      </label>
      {selected ? (
        <div className="resume-linked-file">
          <div>
            <span>当前 PDF</span>
            <strong>{selected.pdfOriginalName}</strong>
          </div>
          <Link className="text-link" href={`/resumes/${selected.resumeId}`}>查看版本</Link>
        </div>
      ) : null}
      {!disabled ? <div className="form-actions"><SubmitButton /></div> : null}
    </form>
  );
}
