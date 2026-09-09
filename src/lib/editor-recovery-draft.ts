export const EDITOR_RECOVERY_DRAFT_DB_NAME = "campus-hire-tracker-editor-recovery";
export const EDITOR_RECOVERY_DRAFT_DB_VERSION = 2;
export const EDITOR_RECOVERY_DRAFT_STORE_NAME = "editor-recovery-drafts";
export const EDITOR_RECOVERY_DRAFT_SCOPE_INDEX = "by-scope";
export const EDITOR_RECOVERY_DRAFT_MAX_CONTENT_LENGTH = 100_000;

export const EDITOR_RECOVERY_DRAFT_ENTITY_TYPE = "APPLICATION_NOTES" as const;
export const EDITOR_RECOVERY_DRAFT_FIELD = "notesMarkdown" as const;

const LEGACY_KEY_PREFIX = "editor-recovery-draft:v1";
const KEY_PREFIX = "editor-recovery-draft:v2";
const SCOPE_PREFIX = "editor-recovery-draft-scope:v1";
const LEGACY_DRAFT_ID = "legacy-v1";
const SAFE_IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,127})$/;
const MAX_DATE_MS = 8_640_000_000_000_000;
const RECORD_KEYS = [
  "schemaVersion", "key", "scopeKey", "draftId", "entityType", "entityId", "field", "content",
  "baseVersion", "serverUpdatedAtMs", "updatedAtMs", "revision",
] as const;
const LEGACY_RECORD_KEYS = [
  "key", "entityType", "entityId", "field", "content", "baseVersion", "serverUpdatedAtMs", "updatedAtMs",
] as const;

export interface EditorRecoveryDraft {
  schemaVersion: 2;
  key: string;
  scopeKey: string;
  draftId: string;
  entityType: typeof EDITOR_RECOVERY_DRAFT_ENTITY_TYPE;
  entityId: string;
  field: typeof EDITOR_RECOVERY_DRAFT_FIELD;
  content: string;
  baseVersion: number;
  serverUpdatedAtMs: number;
  updatedAtMs: number;
  revision: number;
}

interface LegacyEditorRecoveryDraft {
  key: string;
  entityType: typeof EDITOR_RECOVERY_DRAFT_ENTITY_TYPE;
  entityId: string;
  field: typeof EDITOR_RECOVERY_DRAFT_FIELD;
  content: string;
  baseVersion: number;
  serverUpdatedAtMs: number;
  updatedAtMs: number;
}

export interface CreateApplicationNotesDraftInput {
  entityId: string;
  draftId: string;
  content: string;
  baseVersion: number;
  serverUpdatedAtMs: number;
  revision?: number;
  updatedAtMs?: number;
}

export interface EditorRecoveryDraftServerState {
  content: string | null;
  version: number;
  updatedAtMs: number;
}

export type EditorRecoveryDraftStatus = "NONE" | "RECOVERABLE" | "VERSION_CONFLICT" | "STALE_DIFFERENT";
export interface EditorRecoveryDraftComparison { status: EditorRecoveryDraftStatus; shouldDelete: boolean; }
export interface EditorRecoveryDraftStorageOptions { indexedDB?: IDBFactory | null; }
export type ConditionalDraftDeleteResult = "DELETED" | "CHANGED" | "MISSING";
export type EditorRecoveryDraftErrorCode =
  | "INDEXED_DB_UNAVAILABLE" | "INVALID_DRAFT" | "CORRUPT_DRAFT" | "OPEN_FAILED"
  | "READ_FAILED" | "WRITE_FAILED" | "DELETE_FAILED";

const SAFE_ERROR_MESSAGES: Record<EditorRecoveryDraftErrorCode, string> = {
  INDEXED_DB_UNAVAILABLE: "浏览器草稿存储不可用，请先复制当前内容再重试。",
  INVALID_DRAFT: "无法保存格式不正确的恢复草稿。",
  CORRUPT_DRAFT: "恢复草稿格式异常，已保留原记录且不会自动覆盖。",
  OPEN_FAILED: "无法打开浏览器草稿存储，请先复制当前内容再重试。",
  READ_FAILED: "无法读取浏览器恢复草稿，请先复制当前内容再重试。",
  WRITE_FAILED: "无法写入浏览器恢复草稿，请先复制当前内容再重试。",
  DELETE_FAILED: "已保存内容，但无法清理浏览器恢复草稿，请稍后重试。",
};

export class EditorRecoveryDraftError extends Error {
  readonly code: EditorRecoveryDraftErrorCode;
  constructor(code: EditorRecoveryDraftErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "EditorRecoveryDraftError";
    this.code = code;
  }
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function isValidTimestamp(value: unknown): value is number {
  return isSafeIntegerAtLeast(value, 0) && value <= MAX_DATE_MS;
}
function requireIdentifier(value: unknown): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) throw new EditorRecoveryDraftError("INVALID_DRAFT");
  return value;
}
function requireDraftId(value: unknown): string {
  const result = requireIdentifier(value);
  if (result === LEGACY_DRAFT_ID) throw new EditorRecoveryDraftError("INVALID_DRAFT");
  return result;
}
function legacyApplicationNotesDraftKey(entityId: string) {
  return `${LEGACY_KEY_PREFIX}:${EDITOR_RECOVERY_DRAFT_ENTITY_TYPE}:${entityId}:${EDITOR_RECOVERY_DRAFT_FIELD}`;
}
export function applicationNotesDraftScopeKey(entityId: string): string {
  const safeEntityId = requireIdentifier(entityId);
  return `${SCOPE_PREFIX}:${EDITOR_RECOVERY_DRAFT_ENTITY_TYPE}:${safeEntityId}:${EDITOR_RECOVERY_DRAFT_FIELD}`;
}
export function applicationNotesDraftKey(entityId: string, draftId: string): string {
  const safeEntityId = requireIdentifier(entityId);
  const safeDraftId = requireDraftId(draftId);
  return `${KEY_PREFIX}:${EDITOR_RECOVERY_DRAFT_ENTITY_TYPE}:${safeEntityId}:${EDITOR_RECOVERY_DRAFT_FIELD}:${safeDraftId}`;
}
function isExactRecord(record: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function copyValidatedLegacyDraft(value: unknown): LegacyEditorRecoveryDraft {
  const invalid = (): never => { throw new EditorRecoveryDraftError("CORRUPT_DRAFT"); };
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (!isExactRecord(record, LEGACY_RECORD_KEYS)) invalid();
  if (
    record.entityType !== EDITOR_RECOVERY_DRAFT_ENTITY_TYPE || record.field !== EDITOR_RECOVERY_DRAFT_FIELD ||
    typeof record.entityId !== "string" || !SAFE_IDENTIFIER.test(record.entityId) ||
    record.key !== legacyApplicationNotesDraftKey(record.entityId) || typeof record.content !== "string" ||
    record.content.length > EDITOR_RECOVERY_DRAFT_MAX_CONTENT_LENGTH ||
    !isSafeIntegerAtLeast(record.baseVersion, 1) || !isValidTimestamp(record.serverUpdatedAtMs) ||
    !isValidTimestamp(record.updatedAtMs)
  ) invalid();
  return record as unknown as LegacyEditorRecoveryDraft;
}
function migrateLegacyDraft(value: unknown): EditorRecoveryDraft {
  const legacy = copyValidatedLegacyDraft(value);
  return {
    schemaVersion: 2,
    key: legacy.key,
    scopeKey: applicationNotesDraftScopeKey(legacy.entityId),
    draftId: LEGACY_DRAFT_ID,
    entityType: EDITOR_RECOVERY_DRAFT_ENTITY_TYPE,
    entityId: legacy.entityId,
    field: EDITOR_RECOVERY_DRAFT_FIELD,
    content: legacy.content,
    baseVersion: legacy.baseVersion,
    serverUpdatedAtMs: legacy.serverUpdatedAtMs,
    updatedAtMs: legacy.updatedAtMs,
    revision: 1,
  };
}

function copyValidatedDraft(value: unknown, errorCode: "INVALID_DRAFT" | "CORRUPT_DRAFT"): EditorRecoveryDraft {
  const invalid = (): never => { throw new EditorRecoveryDraftError(errorCode); };
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (!isExactRecord(record, RECORD_KEYS)) invalid();
  if (
    record.schemaVersion !== 2 || record.entityType !== EDITOR_RECOVERY_DRAFT_ENTITY_TYPE ||
    record.field !== EDITOR_RECOVERY_DRAFT_FIELD || typeof record.entityId !== "string" ||
    !SAFE_IDENTIFIER.test(record.entityId) || typeof record.draftId !== "string" ||
    !SAFE_IDENTIFIER.test(record.draftId) || typeof record.content !== "string" ||
    record.content.length > EDITOR_RECOVERY_DRAFT_MAX_CONTENT_LENGTH ||
    !isSafeIntegerAtLeast(record.baseVersion, 1) || !isValidTimestamp(record.serverUpdatedAtMs) ||
    !isValidTimestamp(record.updatedAtMs) || !isSafeIntegerAtLeast(record.revision, 1)
  ) invalid();
  const entityId = record.entityId as string;
  const draftId = record.draftId as string;
  const expectedScopeKey = applicationNotesDraftScopeKey(entityId);
  const expectedKey = draftId === LEGACY_DRAFT_ID
    ? legacyApplicationNotesDraftKey(entityId)
    : applicationNotesDraftKey(entityId, draftId);
  if (record.scopeKey !== expectedScopeKey || record.key !== expectedKey) invalid();
  return {
    schemaVersion: 2, key: expectedKey, scopeKey: expectedScopeKey, draftId,
    entityType: EDITOR_RECOVERY_DRAFT_ENTITY_TYPE, entityId, field: EDITOR_RECOVERY_DRAFT_FIELD,
    content: record.content, baseVersion: record.baseVersion, serverUpdatedAtMs: record.serverUpdatedAtMs,
    updatedAtMs: record.updatedAtMs, revision: record.revision,
  } as EditorRecoveryDraft;
}

function requireDraftKey(value: unknown): string {
  if (typeof value !== "string") throw new EditorRecoveryDraftError("INVALID_DRAFT");
  const legacyPrefix = `${LEGACY_KEY_PREFIX}:${EDITOR_RECOVERY_DRAFT_ENTITY_TYPE}:`;
  const legacySuffix = `:${EDITOR_RECOVERY_DRAFT_FIELD}`;
  if (value.startsWith(legacyPrefix) && value.endsWith(legacySuffix)) {
    const entityId = value.slice(legacyPrefix.length, -legacySuffix.length);
    if (legacyApplicationNotesDraftKey(requireIdentifier(entityId)) === value) return value;
  }
  const prefix = `${KEY_PREFIX}:${EDITOR_RECOVERY_DRAFT_ENTITY_TYPE}:`;
  const marker = `:${EDITOR_RECOVERY_DRAFT_FIELD}:`;
  if (!value.startsWith(prefix)) throw new EditorRecoveryDraftError("INVALID_DRAFT");
  const remainder = value.slice(prefix.length);
  const markerIndex = remainder.indexOf(marker);
  if (markerIndex < 1) throw new EditorRecoveryDraftError("INVALID_DRAFT");
  const entityId = remainder.slice(0, markerIndex);
  const draftId = remainder.slice(markerIndex + marker.length);
  if (applicationNotesDraftKey(entityId, draftId) !== value) throw new EditorRecoveryDraftError("INVALID_DRAFT");
  return value;
}

function validateServerState(value: EditorRecoveryDraftServerState): void {
  if (
    (typeof value.content !== "string" && value.content !== null) ||
    (typeof value.content === "string" && value.content.length > EDITOR_RECOVERY_DRAFT_MAX_CONTENT_LENGTH) ||
    !isSafeIntegerAtLeast(value.version, 1) || !isValidTimestamp(value.updatedAtMs)
  ) throw new EditorRecoveryDraftError("INVALID_DRAFT");
}
export function createApplicationNotesDraft(input: CreateApplicationNotesDraftInput): EditorRecoveryDraft {
  const entityId = requireIdentifier(input.entityId);
  const draftId = requireDraftId(input.draftId);
  return copyValidatedDraft({
    schemaVersion: 2,
    key: applicationNotesDraftKey(entityId, draftId),
    scopeKey: applicationNotesDraftScopeKey(entityId),
    draftId,
    entityType: EDITOR_RECOVERY_DRAFT_ENTITY_TYPE,
    entityId,
    field: EDITOR_RECOVERY_DRAFT_FIELD,
    content: input.content,
    baseVersion: input.baseVersion,
    serverUpdatedAtMs: input.serverUpdatedAtMs,
    updatedAtMs: input.updatedAtMs ?? Date.now(),
    revision: input.revision ?? 1,
  }, "INVALID_DRAFT");
}

export function compareEditorRecoveryDraft(
  draft: EditorRecoveryDraft | null,
  server: EditorRecoveryDraftServerState,
): EditorRecoveryDraftComparison {
  validateServerState(server);
  if (draft === null) return { status: "NONE", shouldDelete: false };
  const safeDraft = copyValidatedDraft(draft, "INVALID_DRAFT");
  if (safeDraft.content === (server.content ?? "")) return { status: "NONE", shouldDelete: true };
  if (safeDraft.baseVersion === server.version && safeDraft.serverUpdatedAtMs === server.updatedAtMs) {
    return { status: "RECOVERABLE", shouldDelete: false };
  }
  if (server.version < safeDraft.baseVersion) return { status: "VERSION_CONFLICT", shouldDelete: false };
  const serverAdvanced = server.version > safeDraft.baseVersion || server.updatedAtMs > safeDraft.serverUpdatedAtMs;
  if (serverAdvanced && safeDraft.updatedAtMs <= server.updatedAtMs) return { status: "STALE_DIFFERENT", shouldDelete: false };
  return { status: "VERSION_CONFLICT", shouldDelete: false };
}
export function classifyEditorRecoveryDraft(
  draft: EditorRecoveryDraft | null,
  server: EditorRecoveryDraftServerState,
): EditorRecoveryDraftStatus {
  return compareEditorRecoveryDraft(draft, server).status;
}

function resolveIndexedDB(options: EditorRecoveryDraftStorageOptions): IDBFactory {
  if (options.indexedDB === null) throw new EditorRecoveryDraftError("INDEXED_DB_UNAVAILABLE");
  if (options.indexedDB !== undefined) return options.indexedDB;
  try {
    const factory = globalThis.indexedDB;
    if (factory && typeof factory.open === "function") return factory;
  } catch { /* Browser policy may throw while reading the property. */ }
  throw new EditorRecoveryDraftError("INDEXED_DB_UNAVAILABLE");
}

function openEditorRecoveryDraftDatabase(options: EditorRecoveryDraftStorageOptions): Promise<IDBDatabase> {
  const factory = resolveIndexedDB(options);
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let settled = false;
    const rejectOpen = () => {
      if (settled) return;
      settled = true;
      reject(new EditorRecoveryDraftError("OPEN_FAILED"));
    };
    try { request = factory.open(EDITOR_RECOVERY_DRAFT_DB_NAME, EDITOR_RECOVERY_DRAFT_DB_VERSION); }
    catch { rejectOpen(); return; }
    request.onupgradeneeded = (event) => {
      try {
        const database = request.result;
        const store = database.objectStoreNames.contains(EDITOR_RECOVERY_DRAFT_STORE_NAME)
          ? request.transaction!.objectStore(EDITOR_RECOVERY_DRAFT_STORE_NAME)
          : database.createObjectStore(EDITOR_RECOVERY_DRAFT_STORE_NAME, { keyPath: "key" });
        if (!store.indexNames.contains(EDITOR_RECOVERY_DRAFT_SCOPE_INDEX)) {
          store.createIndex(EDITOR_RECOVERY_DRAFT_SCOPE_INDEX, "scopeKey", { unique: false });
        }
        if ((event.oldVersion ?? 0) < 2) {
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            try {
              const updateRequest = cursor.update(migrateLegacyDraft(cursor.value));
              updateRequest.onsuccess = () => cursor.continue();
            } catch {
              // Preserve unreadable legacy bytes. A direct scoped lookup reports corruption later.
              cursor.continue();
            }
          };
        }
      } catch { request.transaction?.abort(); }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = rejectOpen;
    request.onblocked = rejectOpen;
  });
}

type TransactionErrorCode = "READ_FAILED" | "WRITE_FAILED" | "DELETE_FAILED";
async function runStoreTransaction<T>(
  mode: IDBTransactionMode,
  errorCode: TransactionErrorCode,
  options: EditorRecoveryDraftStorageOptions,
  operation: (store: IDBObjectStore, finish: (value: T) => void, fail: (error?: EditorRecoveryDraftError) => void) => void,
): Promise<T> {
  const database = await openEditorRecoveryDraftDatabase(options);
  try {
    return await new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      let result: T;
      let hasResult = false;
      let failure: EditorRecoveryDraftError | null = null;
      let settled = false;
      const rejectOnce = (error: EditorRecoveryDraftError) => {
        if (!settled) { settled = true; reject(error); }
      };
      try { transaction = database.transaction(EDITOR_RECOVERY_DRAFT_STORE_NAME, mode); }
      catch { rejectOnce(new EditorRecoveryDraftError(errorCode)); return; }
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        if (hasResult) resolve(result); else reject(new EditorRecoveryDraftError(errorCode));
      };
      transaction.onerror = () => { failure ??= new EditorRecoveryDraftError(errorCode); };
      transaction.onabort = () => rejectOnce(failure ?? new EditorRecoveryDraftError(errorCode));
      const finish = (value: T) => { result = value; hasResult = true; };
      const fail = (error = new EditorRecoveryDraftError(errorCode)) => {
        failure = error;
        try { transaction.abort(); } catch { rejectOnce(error); }
      };
      try { operation(transaction.objectStore(EDITOR_RECOVERY_DRAFT_STORE_NAME), finish, fail); }
      catch (error) { fail(error instanceof EditorRecoveryDraftError ? error : undefined); }
    });
  } finally { database.close(); }
}

export async function getEditorRecoveryDraft(
  key: string,
  options: EditorRecoveryDraftStorageOptions = {},
): Promise<EditorRecoveryDraft | null> {
  const safeKey = requireDraftKey(key);
  return runStoreTransaction("readonly", "READ_FAILED", options, (store, finish, fail) => {
    const request = store.get(safeKey) as IDBRequest<unknown>;
    request.onsuccess = () => {
      if (request.result === undefined) finish(null);
      else try { finish(copyValidatedDraft(request.result, "CORRUPT_DRAFT")); }
      catch (error) { fail(error as EditorRecoveryDraftError); }
    };
    request.onerror = () => fail();
  });
}

export async function listApplicationNotesDrafts(
  entityId: string,
  options: EditorRecoveryDraftStorageOptions = {},
): Promise<EditorRecoveryDraft[]> {
  const scopeKey = applicationNotesDraftScopeKey(entityId);
  const legacyKey = legacyApplicationNotesDraftKey(requireIdentifier(entityId));
  return runStoreTransaction("readonly", "READ_FAILED", options, (store, finish, fail) => {
    const indexedRequest = store.index(EDITOR_RECOVERY_DRAFT_SCOPE_INDEX).getAll(scopeKey) as IDBRequest<unknown[]>;
    const legacyRequest = store.get(legacyKey) as IDBRequest<unknown>;
    let indexedValues: unknown[] | null = null;
    let legacyValue: unknown;
    let legacyDone = false;
    const complete = () => {
      if (indexedValues === null || !legacyDone) return;
      try {
        const drafts = indexedValues.map((value) => copyValidatedDraft(value, "CORRUPT_DRAFT"));
        if (legacyValue !== undefined && !drafts.some((draft) => draft.key === legacyKey)) {
          drafts.push(copyValidatedDraft(legacyValue, "CORRUPT_DRAFT"));
        }
        drafts.sort((left, right) => right.updatedAtMs - left.updatedAtMs || right.revision - left.revision);
        finish(drafts);
      } catch (error) { fail(error as EditorRecoveryDraftError); }
    };
    indexedRequest.onsuccess = () => { indexedValues = indexedRequest.result; complete(); };
    indexedRequest.onerror = () => fail();
    legacyRequest.onsuccess = () => { legacyValue = legacyRequest.result; legacyDone = true; complete(); };
    legacyRequest.onerror = () => fail();
  });
}

export async function putEditorRecoveryDraft(
  draft: EditorRecoveryDraft,
  options: EditorRecoveryDraftStorageOptions = {},
): Promise<void> {
  const safeDraft = copyValidatedDraft(draft, "INVALID_DRAFT");
  return runStoreTransaction("readwrite", "WRITE_FAILED", options, (store, finish, fail) => {
    const request = store.put(safeDraft);
    request.onsuccess = () => finish(undefined);
    request.onerror = () => fail();
  });
}

export async function deleteEditorRecoveryDraftIfRevision(
  key: string,
  expectedRevision: number,
  options: EditorRecoveryDraftStorageOptions = {},
): Promise<ConditionalDraftDeleteResult> {
  const safeKey = requireDraftKey(key);
  if (!isSafeIntegerAtLeast(expectedRevision, 1)) throw new EditorRecoveryDraftError("INVALID_DRAFT");
  return runStoreTransaction("readwrite", "DELETE_FAILED", options, (store, finish, fail) => {
    const readRequest = store.get(safeKey) as IDBRequest<unknown>;
    readRequest.onsuccess = () => {
      if (readRequest.result === undefined) { finish("MISSING"); return; }
      let current: EditorRecoveryDraft;
      try { current = copyValidatedDraft(readRequest.result, "CORRUPT_DRAFT"); }
      catch (error) { fail(error as EditorRecoveryDraftError); return; }
      if (current.revision !== expectedRevision) { finish("CHANGED"); return; }
      const deleteRequest = store.delete(safeKey);
      deleteRequest.onsuccess = () => finish("DELETED");
      deleteRequest.onerror = () => fail();
    };
    readRequest.onerror = () => fail();
  });
}

export async function deleteApplicationNotesDraftsMatchingSavedContent(
  entityId: string,
  savedContent: string | null,
  options: EditorRecoveryDraftStorageOptions = {},
): Promise<string[]> {
  const scopeKey = applicationNotesDraftScopeKey(entityId);
  if (typeof savedContent !== "string" && savedContent !== null) {
    throw new EditorRecoveryDraftError("INVALID_DRAFT");
  }
  const content = savedContent ?? "";
  if (content.length > EDITOR_RECOVERY_DRAFT_MAX_CONTENT_LENGTH) throw new EditorRecoveryDraftError("INVALID_DRAFT");
  return runStoreTransaction("readwrite", "DELETE_FAILED", options, (store, finish, fail) => {
    const deletedKeys: string[] = [];
    const request = store.index(EDITOR_RECOVERY_DRAFT_SCOPE_INDEX).openCursor(scopeKey);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { finish(deletedKeys); return; }
      let draft: EditorRecoveryDraft;
      try { draft = copyValidatedDraft(cursor.value, "CORRUPT_DRAFT"); }
      catch (error) { fail(error as EditorRecoveryDraftError); return; }
      if (draft.content !== content) { cursor.continue(); return; }
      const deleteRequest = cursor.delete();
      deleteRequest.onsuccess = () => { deletedKeys.push(draft.key); cursor.continue(); };
      deleteRequest.onerror = () => fail();
    };
    request.onerror = () => fail();
  });
}
