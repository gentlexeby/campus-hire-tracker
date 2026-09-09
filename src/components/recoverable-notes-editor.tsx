"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormState } from "@/components/form-state";
import { initialFormState } from "@/components/form-state";
import {
  applicationNotesDraftKey,
  compareEditorRecoveryDraft,
  createApplicationNotesDraft,
  deleteApplicationNotesDraftsMatchingSavedContent,
  deleteEditorRecoveryDraftIfRevision,
  listApplicationNotesDrafts,
  putEditorRecoveryDraft,
  type ConditionalDraftDeleteResult,
  type EditorRecoveryDraft,
  type EditorRecoveryDraftStatus,
} from "@/lib/editor-recovery-draft";

type NotesFormAction = (state: FormState, formData: FormData) => Promise<FormState>;
type SavedNotes = { content: string; version: number; updatedAtMs: number };
type RecoveryChoice = {
  draft: EditorRecoveryDraft;
  status: Exclude<EditorRecoveryDraftStatus, "NONE">;
};

type RecoverableNotesEditorProps = {
  action: NotesFormAction;
  applicationId: string;
  notesMarkdown: string | null;
  serverUpdatedAtMs: number;
  serverVersion: number;
};

function formatDraftTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function isSafeSaveResult(state: FormState): state is FormState & {
  ok: true;
  savedAtMs: number;
  savedVersion: number;
  savedNotesMarkdown: string | null;
} {
  return state.ok === true
    && typeof state.savedAtMs === "number"
    && Number.isSafeInteger(state.savedAtMs)
    && state.savedAtMs >= 0
    && typeof state.savedVersion === "number"
    && Number.isSafeInteger(state.savedVersion)
    && state.savedVersion >= 1
    && (typeof state.savedNotesMarkdown === "string" || state.savedNotesMarkdown === null);
}

function RecoveryComparison({
  choices,
  resolvingKey,
  saved,
  onAbandon,
  onRecover,
}: {
  choices: RecoveryChoice[];
  resolvingKey: string | null;
  saved: SavedNotes;
  onAbandon: (choice: RecoveryChoice) => Promise<void>;
  onRecover: (choice: RecoveryChoice) => Promise<void>;
}) {
  const serverChanged = choices.some(({ status }) => status === "VERSION_CONFLICT" || status === "STALE_DIFFERENT");
  return (
    <section aria-labelledby="notes-recovery-title" className="notes-recovery-panel">
      <div className="notes-recovery-heading">
        <div>
          <p className="eyebrow">浏览器恢复草稿</p>
          <h3 id="notes-recovery-title">发现未保存内容</h3>
          <p className="notes-recovery-count">发现 {choices.length} 份未保存草稿</p>
        </div>
        <span className={serverChanged ? "status-pill tone-warning" : "status-pill tone-info"}>
          {serverChanged ? "需要比较" : "可以恢复"}
        </span>
      </div>
      <p className="notes-recovery-explanation" role={serverChanged ? "alert" : undefined}>
        {serverChanged
          ? "保存版本已变化，请比较后再决定。系统不会自动覆盖任一份内容。"
          : "浏览器草稿与已保存内容不同。请逐份决定恢复或放弃，系统不会静默覆盖。"}
      </p>
      <article className="notes-version-card is-server">
        <div><strong>已保存版本 #{saved.version}</strong><small>保存于 {formatDraftTime(saved.updatedAtMs)}</small></div>
        <pre tabIndex={0}>{saved.content || "（空）"}</pre>
      </article>
      <div className="notes-draft-candidates">
        {choices.map((choice) => {
          const pending = resolvingKey === choice.draft.key;
          return (
            <article className="notes-version-card is-draft" key={`${choice.draft.key}:${choice.draft.revision}`}>
              <div className="notes-candidate-heading">
                <span><strong>未保存草稿（基于版本 #{choice.draft.baseVersion}）</strong><small>草稿保存于 {formatDraftTime(choice.draft.updatedAtMs)}</small></span>
                <span className="status-pill tone-warning">修订 #{choice.draft.revision}</span>
              </div>
              <pre tabIndex={0}>{choice.draft.content || "（空）"}</pre>
              <div className="notes-candidate-actions">
                <button className="button button-primary" disabled={resolvingKey !== null} onClick={() => void onRecover(choice)} type="button">
                  {pending ? "正在处理…" : "恢复这份草稿"}
                </button>
                <button className="button" disabled={resolvingKey !== null} onClick={() => void onAbandon(choice)} type="button">放弃这份草稿</button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function RecoverableNotesEditor({ action, applicationId, notesMarkdown, serverUpdatedAtMs, serverVersion }: RecoverableNotesEditorProps) {
  const [draftId] = useState(() => globalThis.crypto.randomUUID());
  const initialSaved: SavedNotes = { content: notesMarkdown ?? "", updatedAtMs: serverUpdatedAtMs, version: serverVersion };
  const ownDraftKey = applicationNotesDraftKey(applicationId, draftId);
  const [saved, setSaved] = useState(initialSaved);
  const [content, setContent] = useState(initialSaved.content);
  const [formState, setFormState] = useState<FormState>(initialFormState);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [choices, setChoices] = useState<RecoveryChoice[]>([]);
  const [draftStatus, setDraftStatus] = useState("正在检查浏览器草稿…");
  const [browserDraftWarning, setBrowserDraftWarning] = useState<string | null>(null);
  const savedRef = useRef(initialSaved);
  const contentRef = useRef(initialSaved.content);
  const choicesRef = useRef<RecoveryChoice[]>([]);
  const ownDraftRef = useRef<EditorRecoveryDraft | null>(null);
  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  const mutationSequenceRef = useRef(0);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  function replaceChoices(next: RecoveryChoice[]) {
    choicesRef.current = next;
    setChoices(next);
  }
  function removeChoice(key: string) {
    replaceChoices(choicesRef.current.filter(({ draft }) => draft.key !== key));
  }

  useEffect(() => { contentRef.current = content; }, [content]);
  useEffect(() => { choicesRef.current = choices; }, [choices]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const writeDraft = useCallback(async (nextContent: string, base: SavedNotes = savedRef.current) => {
    const previous = ownDraftRef.current;
    const record = createApplicationNotesDraft({
      baseVersion: base.version,
      content: nextContent,
      draftId,
      entityId: applicationId,
      revision: (previous?.revision ?? 0) + 1,
      serverUpdatedAtMs: base.updatedAtMs,
    });
    mutationSequenceRef.current += 1;
    ownDraftRef.current = record;
    const operation = writeQueueRef.current.catch(() => undefined).then(() => putEditorRecoveryDraft(record));
    writeQueueRef.current = operation.catch(() => undefined);
    try {
      await operation;
      if (mountedRef.current) {
        setBrowserDraftWarning(null);
        if (contentRef.current === nextContent) setDraftStatus(`草稿已保存在此浏览器 · ${formatDraftTime(record.updatedAtMs)}`);
      }
      return record;
    } catch {
      if (ownDraftRef.current?.revision === record.revision) ownDraftRef.current = previous;
      if (mountedRef.current) {
        setBrowserDraftWarning("浏览器草稿不可用。请先复制重要内容；正式保存仍然可以使用。");
        setDraftStatus("浏览器草稿没有保存；你仍可尝试正式保存备注。");
      }
      return null;
    }
  }, [applicationId, draftId]);

  const clearOwnDraft = useCallback(async (target: EditorRecoveryDraft | null = ownDraftRef.current) => {
    if (!target) return true;
    const sequence = ++mutationSequenceRef.current;
    const operation = writeQueueRef.current.catch(() => undefined).then(() => deleteEditorRecoveryDraftIfRevision(target.key, target.revision));
    writeQueueRef.current = operation.then(() => undefined, () => undefined);
    try {
      const result = await operation;
      if (result === "CHANGED") {
        if (mountedRef.current) setBrowserDraftWarning("浏览器草稿已在另一个标签页变化，未执行清理。请重新比较。");
        return false;
      }
      if (mutationSequenceRef.current === sequence && ownDraftRef.current?.key === target.key && ownDraftRef.current.revision === target.revision) ownDraftRef.current = null;
      return true;
    } catch {
      if (mountedRef.current) setBrowserDraftWarning("浏览器草稿不可用。已保存内容不受影响，但旧草稿暂时无法清理。");
      return false;
    }
  }, []);

  const cleanupDraftsMatchingSaved = useCallback(async (savedContent: string) => {
    const sequence = ++mutationSequenceRef.current;
    const operation = writeQueueRef.current.catch(() => undefined).then(() => deleteApplicationNotesDraftsMatchingSavedContent(applicationId, savedContent));
    writeQueueRef.current = operation.then(() => undefined, () => undefined);
    try {
      const deletedKeys = await operation;
      if (mutationSequenceRef.current === sequence && ownDraftRef.current && deletedKeys.includes(ownDraftRef.current.key)) ownDraftRef.current = null;
      return true;
    } catch {
      if (mountedRef.current) setBrowserDraftWarning("备注已保存，但部分浏览器草稿暂时无法安全清理。");
      return false;
    }
  }, [applicationId]);

  const deleteChoice = useCallback(async (choice: RecoveryChoice): Promise<ConditionalDraftDeleteResult | null> => {
    const operation = writeQueueRef.current.catch(() => undefined).then(() => deleteEditorRecoveryDraftIfRevision(choice.draft.key, choice.draft.revision));
    writeQueueRef.current = operation.then(() => undefined, () => undefined);
    try { return await operation; }
    catch {
      if (mountedRef.current) setBrowserDraftWarning("浏览器草稿不可用，这份草稿没有被放弃。");
      return null;
    }
  }, []);

  const readRecoveryChoices = useCallback(async (server: SavedNotes) => {
    // Delete only records whose current content already equals the durable value,
    // then take a fresh scope snapshot. This closes the list/delete race where a
    // different revision could otherwise be hidden after a conditional miss.
    await deleteApplicationNotesDraftsMatchingSavedContent(applicationId, server.content);
    const drafts = await listApplicationNotesDrafts(applicationId);
    const next: RecoveryChoice[] = [];
    for (const draft of drafts) {
      if (draft.key === ownDraftRef.current?.key) continue;
      const comparison = compareEditorRecoveryDraft(draft, { content: server.content || null, updatedAtMs: server.updatedAtMs, version: server.version });
      if (!comparison.shouldDelete && comparison.status !== "NONE") next.push({ draft, status: comparison.status });
    }
    return next;
  }, [applicationId]);

  const refreshRecoveryChoices = useCallback(async () => {
    try {
      const next = await readRecoveryChoices(savedRef.current);
      if (mountedRef.current) replaceChoices(next);
      return next;
    } catch {
      if (mountedRef.current) setBrowserDraftWarning("浏览器草稿已变化，但暂时无法重新读取。请刷新页面后再比较。");
      return null;
    }
  }, [readRecoveryChoices]);

  const inspectRecoveryChoices = useCallback(async (server: SavedNotes) => {
    try { return await readRecoveryChoices(server); }
    catch {
      if (mountedRef.current) setBrowserDraftWarning("浏览器草稿已变化，但暂时无法重新读取。请刷新页面后再比较。");
      return null;
    }
  }, [readRecoveryChoices]);

  useEffect(() => {
    let active = true;
    async function loadDrafts() {
      try {
        const next = await readRecoveryChoices(savedRef.current);
        if (!active) return;
        replaceChoices(next);
        setDraftStatus(next.length ? "发现未保存内容，等待你的选择。" : "备注已与本地数据库同步。");
      } catch {
        if (active) {
          setBrowserDraftWarning("浏览器草稿不可用。请先复制重要内容；正式保存仍然可以使用。");
          setDraftStatus("无法检查浏览器恢复草稿。");
        }
      } finally {
        if (active) setHydrated(true);
      }
    }
    void loadDrafts();
    return () => { active = false; };
  }, [ownDraftKey, readRecoveryChoices]);

  useEffect(() => {
    if (!hydrated || savingRef.current) return;
    const incoming: SavedNotes = { content: notesMarkdown ?? "", updatedAtMs: serverUpdatedAtMs, version: serverVersion };
    const currentSaved = savedRef.current;
    if (incoming.version < currentSaved.version) return;
    if (incoming.content === currentSaved.content && incoming.updatedAtMs === currentSaved.updatedAtMs && incoming.version === currentSaved.version) return;
    const hasEditorChanges = contentRef.current !== currentSaved.content;
    savedRef.current = incoming;
    setSaved(incoming);
    const reclassifiedChoices = choicesRef.current.flatMap(({ draft }) => {
      const comparison = compareEditorRecoveryDraft(draft, {
        content: incoming.content || null,
        updatedAtMs: incoming.updatedAtMs,
        version: incoming.version,
      });
      return comparison.status === "NONE" ? [] : [{ draft, status: comparison.status }];
    });
    if (reclassifiedChoices.length !== choicesRef.current.length) void cleanupDraftsMatchingSaved(incoming.content);
    if (choicesRef.current.length) replaceChoices(reclassifiedChoices);
    if (incoming.content === currentSaved.content) {
      if (hasEditorChanges) void writeDraft(contentRef.current, incoming);
      return;
    }
    if (!hasEditorChanges) {
      contentRef.current = incoming.content;
      setContent(incoming.content);
      setDraftStatus(reclassifiedChoices.length ? "保存版本已变化，等待你的选择。" : "备注已与本地数据库同步。");
      return;
    }
    if (hasEditorChanges) {
      void writeDraft(contentRef.current, currentSaved).then((stored) => {
        const candidate = stored ?? ownDraftRef.current;
        if (!candidate || !mountedRef.current) return;
        const comparison = compareEditorRecoveryDraft(candidate, { content: incoming.content || null, updatedAtMs: incoming.updatedAtMs, version: incoming.version });
        if (comparison.status !== "NONE") {
          replaceChoices([...choicesRef.current.filter(({ draft }) => draft.key !== candidate.key), { draft: candidate, status: comparison.status }]);
          setDraftStatus("保存版本已变化，等待你的选择。");
        }
      });
    }
  }, [cleanupDraftsMatchingSaved, hydrated, notesMarkdown, serverUpdatedAtMs, serverVersion, writeDraft]);

  useEffect(() => {
    if (!hydrated || choices.length || saving || savingRef.current) return;
    if (content === saved.content) {
      const target = ownDraftRef.current;
      void (async () => {
        const cleared = target ? await clearOwnDraft(target) : true;
        const remaining = await inspectRecoveryChoices(savedRef.current);
        if (!mountedRef.current) return;
        if (contentRef.current !== savedRef.current.content) {
          const stored = await writeDraft(contentRef.current, savedRef.current);
          setDraftStatus(stored
            ? "当前新修改仍保留为浏览器草稿；其他候选暂未展开。"
            : "当前新修改的浏览器草稿不可用，请复制内容；其他候选暂未展开。");
          return;
        }
        if (remaining === null) {
          setDraftStatus("内容已回到已保存版本；无法确认是否还有其他浏览器草稿。请刷新后核对。");
        } else if (remaining.length > 0) {
          replaceChoices(remaining);
          setDraftStatus(`内容已回到已保存版本；另有 ${remaining.length} 份不同草稿待处理。`);
        } else {
          setDraftStatus(cleared
            ? "内容已回到已保存版本，浏览器草稿已清除。"
            : "内容已回到已保存版本，但浏览器草稿暂时无法清理。");
        }
      })();
      return;
    }
    const timer = window.setTimeout(() => { void writeDraft(content); }, 650);
    return () => window.clearTimeout(timer);
  }, [choices.length, clearOwnDraft, content, hydrated, inspectRecoveryChoices, saved.content, saving, writeDraft]);

  async function recoverChoice(choice: RecoveryChoice) {
    setResolvingKey(choice.draft.key);
    if (contentRef.current !== savedRef.current.content && contentRef.current !== choice.draft.content) {
      replaceChoices([]);
      setDraftStatus("当前编辑内容未被覆盖；候选草稿仍安全保留，请先保存当前内容。" );
      setResolvingKey(null);
      return;
    }
    contentRef.current = choice.draft.content;
    setContent(choice.draft.content);
    const copied = await writeDraft(choice.draft.content, savedRef.current);
    if (!copied) {
      setDraftStatus("无法复制这份草稿；原草稿仍保留，请先复制内容。");
      setResolvingKey(null);
      return;
    }
    // Copy, do not consume: another choice may later replace the editor's own
    // key. Keeping every source candidate is what makes sequential comparison lossless.
    replaceChoices([]);
    setDraftStatus("所选内容已复制到当前编辑器；其他候选仍安全保留，请先正式保存或继续编辑。");
    setFormState(initialFormState);
    setResolvingKey(null);
  }

  async function abandonChoice(choice: RecoveryChoice) {
    setResolvingKey(choice.draft.key);
    const isOwn = ownDraftRef.current?.key === choice.draft.key;
    const result = isOwn ? (await clearOwnDraft(choice.draft) ? "DELETED" : null) : await deleteChoice(choice);
    if (result === "CHANGED") {
      setBrowserDraftWarning("这份草稿刚在另一个标签页更新，请重新比较最新内容。");
      await refreshRecoveryChoices();
    } else if (result) {
      removeChoice(choice.draft.key);
      if (isOwn) {
        contentRef.current = savedRef.current.content;
        setContent(savedRef.current.content);
      }
      setDraftStatus("已放弃所选浏览器草稿；其他草稿不受影响。");
    }
    setResolvingKey(null);
  }

  async function submitNotes(formData: FormData) {
    if (choicesRef.current.length || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setFormState(initialFormState);
    const submittedContent = contentRef.current;
    const submittedBase = savedRef.current;
    const prewrite = await writeDraft(submittedContent, submittedBase);
    formData.set("applicationId", applicationId);
    formData.set("expectedVersion", String(submittedBase.version));
    formData.set("notesMarkdown", submittedContent);
    let result: FormState;
    try { result = await action(initialFormState, formData); }
    catch { result = { code: "UNEXPECTED_ERROR", message: "备注没有正式保存。请检查本地服务后重试。" }; }
    if (!isSafeSaveResult(result)) {
      const latestContent = contentRef.current;
      const latestWrite = latestContent === submittedContent ? prewrite : await writeDraft(latestContent, submittedBase);
      setFormState(result.ok ? { code: "SAVE_METADATA_MISSING", message: "备注可能已保存，但无法确认新版本；请刷新页面核对。" } : result);
      setDraftStatus(latestWrite ? "正式保存未完成，浏览器草稿仍保留。" : "正式保存失败且浏览器草稿不可用，请复制当前内容。");
      savingRef.current = false;
      setSaving(false);
      return;
    }
    const nextSaved: SavedNotes = { content: result.savedNotesMarkdown ?? "", updatedAtMs: result.savedAtMs, version: result.savedVersion };
    savedRef.current = nextSaved;
    setSaved(nextSaved);
    const contentAfterResponse = contentRef.current;
    const hasNewerInput = contentAfterResponse !== submittedContent && contentAfterResponse !== nextSaved.content;
    if (hasNewerInput) {
      let latestWrite = await writeDraft(contentAfterResponse, nextSaved);
      const matchingCleaned = await cleanupDraftsMatchingSaved(nextSaved.content);
      // Keep foreign candidates hidden while this tab still has newer text, so
      // recovering one cannot overwrite the current own draft.
      const remaining = await inspectRecoveryChoices(nextSaved);
      const contentAfterRefresh = contentRef.current;
      let returnedToSavedCleared = true;
      if (contentAfterRefresh !== contentAfterResponse) {
        if (contentAfterRefresh === nextSaved.content) {
          returnedToSavedCleared = await clearOwnDraft(ownDraftRef.current);
          latestWrite = null;
        } else {
          latestWrite = await writeDraft(contentAfterRefresh, nextSaved);
        }
      }
      const stillHasNewerInput = contentRef.current !== nextSaved.content;
      setFormState(stillHasNewerInput ? { ...result, message: "先前备注已保存；提交期间的新修改尚未正式保存。" } : result);
      setDraftStatus(remaining === null
        ? "先前备注已正式保存；无法确认其他浏览器草稿，请刷新后核对。"
        : remaining.length > 0
          ? stillHasNewerInput
            ? `先前备注已正式保存；新修改仍保留，另有 ${remaining.length} 份不同草稿待处理。`
            : `备注已正式保存；另有 ${remaining.length} 份不同草稿待处理。`
          : !stillHasNewerInput
            ? returnedToSavedCleared && matchingCleaned
              ? "备注已正式保存，浏览器草稿已清除。"
              : "备注已正式保存；部分浏览器草稿暂时无法清理。"
            : latestWrite
              ? "先前备注已正式保存；新修改仍保留为浏览器草稿。"
              : "先前备注已正式保存，但新修改的浏览器草稿不可用，请复制当前内容。");
      if (!matchingCleaned) setBrowserDraftWarning("备注已保存，但部分浏览器草稿暂时无法安全清理。");
    } else {
      const ownCleared = await clearOwnDraft(prewrite ?? ownDraftRef.current);
      const matchingCleaned = await cleanupDraftsMatchingSaved(nextSaved.content);
      const contentAfterClear = contentRef.current;
      const changedWhileClearing = contentAfterClear !== submittedContent && contentAfterClear !== nextSaved.content;
      if (changedWhileClearing) {
        let latestWrite = await writeDraft(contentAfterClear, nextSaved);
        const remaining = await inspectRecoveryChoices(nextSaved);
        const contentAfterRefresh = contentRef.current;
        let returnedToSavedCleared = true;
        if (contentAfterRefresh !== contentAfterClear) {
          if (contentAfterRefresh === nextSaved.content) {
            returnedToSavedCleared = await clearOwnDraft(ownDraftRef.current);
            latestWrite = null;
          } else {
            latestWrite = await writeDraft(contentAfterRefresh, nextSaved);
          }
        }
        const stillHasNewerInput = contentRef.current !== nextSaved.content;
        setFormState(stillHasNewerInput ? { ...result, message: "先前备注已保存；提交期间的新修改尚未正式保存。" } : result);
        setDraftStatus(remaining === null
          ? "先前备注已正式保存；无法确认其他浏览器草稿，请刷新后核对。"
          : remaining.length > 0
            ? stillHasNewerInput
              ? `先前备注已正式保存；新修改仍保留，另有 ${remaining.length} 份不同草稿待处理。`
              : `备注已正式保存；另有 ${remaining.length} 份不同草稿待处理。`
            : !stillHasNewerInput
              ? returnedToSavedCleared && matchingCleaned
                ? "备注已正式保存，浏览器草稿已清除。"
                : "备注已正式保存；部分浏览器草稿暂时无法清理。"
              : latestWrite
                ? "先前备注已正式保存；新修改仍保留为浏览器草稿。"
                : "先前备注已正式保存，但新修改的浏览器草稿不可用，请复制当前内容。");
      } else {
        contentRef.current = nextSaved.content;
        setContent(nextSaved.content);
        setFormState(result);
        const remaining = await refreshRecoveryChoices();
        const contentAfterRefresh = contentRef.current;
        if (contentAfterRefresh !== nextSaved.content) {
          const latestWrite = await writeDraft(contentAfterRefresh, nextSaved);
          setFormState({ ...result, message: "先前备注已保存；提交期间的新修改尚未正式保存。" });
          setDraftStatus(remaining === null
            ? "先前备注已正式保存；无法确认其他浏览器草稿，请刷新后核对。"
            : remaining.length > 0
              ? `先前备注已正式保存；新修改仍保留，另有 ${remaining.length} 份不同草稿待处理。`
              : latestWrite
                ? "先前备注已正式保存；新修改仍保留为浏览器草稿。"
                : "先前备注已正式保存，但新修改的浏览器草稿不可用，请复制当前内容。");
        } else {
          setDraftStatus(remaining === null
            ? "备注已正式保存；无法确认是否还有浏览器草稿，请刷新后核对。"
            : remaining.length > 0
              ? `备注已正式保存；另有 ${remaining.length} 份不同草稿待处理。`
              : ownCleared && matchingCleaned
                ? "备注已正式保存，浏览器草稿已清除。"
                : "备注已正式保存；部分浏览器草稿暂时无法清理。");
        }
      }
    }
    savingRef.current = false;
    setSaving(false);
  }

  return (
    <div className="recoverable-notes-editor">
      {choices.length ? <RecoveryComparison choices={choices} onAbandon={abandonChoice} onRecover={recoverChoice} resolvingKey={resolvingKey} saved={saved} /> : null}
      {browserDraftWarning ? <p className="notice notice-warning notes-draft-warning" role="alert">{browserDraftWarning}</p> : null}
      <form action={submitNotes} aria-busy={saving} className="stack-form compact-form">
        <input name="applicationId" type="hidden" value={applicationId} />
        <input name="expectedVersion" type="hidden" value={saved.version} />
        {formState.message ? <div className={formState.ok ? "form-message is-success" : "form-message is-error"} role={formState.ok ? "status" : "alert"}>{formState.message}{formState.code === "VERSION_CONFLICT" ? <strong className="notes-conflict-reminder">版本冲突：正式保存未完成，请按草稿状态提示处理。</strong> : null}</div> : null}
        <div className="field">
          <label className="field-label" htmlFor="application-notes">申请备注</label>
          <span className="field-hint" id="application-notes-help">可记录沟通要点、面试复盘或待确认信息，最多 100,000 字。</span>
          <textarea
            aria-describedby="application-notes-help application-notes-draft-status"
            className="textarea notes-textarea"
            disabled={!hydrated || choices.length > 0}
            id="application-notes"
            maxLength={100_000}
            name="notesMarkdown"
            onChange={(event) => {
              contentRef.current = event.target.value;
              setContent(event.target.value);
              setFormState(initialFormState);
              setDraftStatus("正在保存浏览器草稿…");
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && (event.key === "Enter" || event.key === "NumpadEnter")) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            rows={10}
            value={content}
          />
        </div>
        <div className="notes-editor-footer">
          <p aria-live="polite" className="notes-draft-status" id="application-notes-draft-status">{draftStatus}</p>
          <button className="button button-primary" disabled={!hydrated || choices.length > 0 || saving} type="submit">{saving ? "正在保存…" : "保存备注"}</button>
        </div>
      </form>
    </div>
  );
}
