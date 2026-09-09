import { describe, expect, it, vi } from "vitest";

import {
  applicationNotesDraftKey,
  applicationNotesDraftScopeKey,
  classifyEditorRecoveryDraft,
  compareEditorRecoveryDraft,
  createApplicationNotesDraft,
  deleteApplicationNotesDraftsMatchingSavedContent,
  deleteEditorRecoveryDraftIfRevision,
  EDITOR_RECOVERY_DRAFT_DB_NAME,
  EDITOR_RECOVERY_DRAFT_DB_VERSION,
  EDITOR_RECOVERY_DRAFT_MAX_CONTENT_LENGTH,
  EDITOR_RECOVERY_DRAFT_SCOPE_INDEX,
  EDITOR_RECOVERY_DRAFT_STORE_NAME,
  EditorRecoveryDraftError,
  getEditorRecoveryDraft,
  listApplicationNotesDrafts,
  putEditorRecoveryDraft,
  type CreateApplicationNotesDraftInput,
  type EditorRecoveryDraft,
} from "@/lib/editor-recovery-draft";

type RequestHandler<T> = ((this: IDBRequest<T>, event: Event) => unknown) | null;
type TransactionHandler = ((this: IDBTransaction, event: Event) => unknown) | null;
type OperationKind = "get" | "getAll" | "put" | "delete" | "cursor" | "update";

interface MutableRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: RequestHandler<T>;
  onerror: RequestHandler<T>;
}
interface MutableTransaction {
  oncomplete: TransactionHandler;
  onerror: TransactionHandler;
  onabort: TransactionHandler;
  objectStore(name: string): IDBObjectStore;
  abort(): void;
}
interface MutableOpenRequest extends MutableRequest<IDBDatabase> {
  onupgradeneeded: ((this: IDBOpenDBRequest, event: IDBVersionChangeEvent) => unknown) | null;
  onblocked: ((this: IDBOpenDBRequest, event: Event) => unknown) | null;
  transaction: IDBTransaction | null;
}
interface FakeIndexedDB {
  factory: IDBFactory;
  records: Map<string, unknown>;
  openCalls: Array<{ name: string; version: number | undefined }>;
  failNextOperation(kind: OperationKind): void;
}

function event(oldVersion = 0): IDBVersionChangeEvent {
  return { oldVersion } as IDBVersionChangeEvent;
}

function createFakeIndexedDB(options: { version?: number; records?: Map<string, unknown> } = {}): FakeIndexedDB {
  const records = options.records ?? new Map<string, unknown>();
  const openCalls: Array<{ name: string; version: number | undefined }> = [];
  let databaseVersion = options.version ?? 0;
  let storeCreated = databaseVersion > 0;
  let indexCreated = databaseVersion >= 2;
  let nextFailure: OperationKind | null = null;

  function makeTransaction(mode: IDBTransactionMode, afterComplete?: () => void) {
    const snapshot = mode === "readwrite"
      ? new Map([...records].map(([key, value]) => [key, structuredClone(value)]))
      : null;
    let pending = 0;
    let aborted = false;
    let completeQueued = false;
    const transaction: MutableTransaction = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      abort() {
        if (aborted) return;
        aborted = true;
        if (snapshot) {
          records.clear();
          for (const [key, value] of snapshot) records.set(key, structuredClone(value));
        }
        queueMicrotask(() => transaction.onabort?.call(transaction as unknown as IDBTransaction, event()));
      },
      objectStore(name: string) {
        expect(name).toBe(EDITOR_RECOVERY_DRAFT_STORE_NAME);
        return store;
      },
    };

    const scheduleComplete = () => {
      if (aborted || pending > 0 || completeQueued) return;
      completeQueued = true;
      queueMicrotask(() => {
        completeQueued = false;
        if (aborted || pending > 0) return;
        transaction.oncomplete?.call(transaction as unknown as IDBTransaction, event());
        afterComplete?.();
      });
    };

    const run = <T>(kind: OperationKind, work: () => T): IDBRequest<T> => {
      pending += 1;
      const request: MutableRequest<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (aborted) { pending -= 1; return; }
        try {
          if (nextFailure === kind) { nextFailure = null; throw new Error("fake operation failure"); }
          request.result = work();
          request.onsuccess?.call(request as unknown as IDBRequest<T>, event());
        } catch {
          request.error = new DOMException("fake operation failed");
          request.onerror?.call(request as unknown as IDBRequest<T>, event());
          transaction.onerror?.call(transaction as unknown as IDBTransaction, event());
          transaction.abort();
        } finally {
          pending -= 1;
          scheduleComplete();
        }
      });
      return request as unknown as IDBRequest<T>;
    };

    const cursorRequest = (scopeKey?: string): IDBRequest<IDBCursorWithValue | null> => {
      pending += 1;
      const request: MutableRequest<IDBCursorWithValue | null> = {
        result: null, error: null, onsuccess: null, onerror: null,
      };
      const keys = [...records.keys()].filter((key) => {
        if (scopeKey === undefined) return true;
        const value = records.get(key);
        return typeof value === "object" && value !== null && (value as { scopeKey?: unknown }).scopeKey === scopeKey;
      });
      let index = 0;
      const advance = () => queueMicrotask(() => {
        if (aborted) return;
        if (nextFailure === "cursor") {
          nextFailure = null;
          request.error = new DOMException("fake cursor failed");
          request.onerror?.call(request as unknown as IDBRequest<IDBCursorWithValue | null>, event());
          transaction.onerror?.call(transaction as unknown as IDBTransaction, event());
          transaction.abort();
          pending -= 1;
          return;
        }
        if (index >= keys.length) {
          request.result = null;
          request.onsuccess?.call(request as unknown as IDBRequest<IDBCursorWithValue | null>, event());
          pending -= 1;
          scheduleComplete();
          return;
        }
        const key = keys[index];
        const cursor = {
          get value() { return structuredClone(records.get(key)); },
          update(value: unknown) {
            return run("update", () => {
              expect((value as { key: string }).key).toBe(key);
              records.set(key, structuredClone(value));
              return key;
            });
          },
          delete() {
            return run("delete", () => { records.delete(key); return undefined; });
          },
          continue() { index += 1; advance(); },
        } as unknown as IDBCursorWithValue;
        request.result = cursor;
        request.onsuccess?.call(request as unknown as IDBRequest<IDBCursorWithValue | null>, event());
      });
      advance();
      return request as unknown as IDBRequest<IDBCursorWithValue | null>;
    };

    const index = {
      getAll(scopeKey: IDBValidKey) {
        return run("getAll", () => [...records.values()]
          .filter((value) => typeof value === "object" && value !== null
            && (value as { scopeKey?: unknown }).scopeKey === String(scopeKey))
          .map((value) => structuredClone(value)));
      },
      openCursor(scopeKey: IDBValidKey) { return cursorRequest(String(scopeKey)); },
    } as IDBIndex;

    const store = {
      indexNames: { contains: (name: string) => indexCreated && name === EDITOR_RECOVERY_DRAFT_SCOPE_INDEX },
      createIndex(name: string, keyPath: string, parameters?: IDBIndexParameters) {
        expect(name).toBe(EDITOR_RECOVERY_DRAFT_SCOPE_INDEX);
        expect(keyPath).toBe("scopeKey");
        expect(parameters).toEqual({ unique: false });
        indexCreated = true;
        return index;
      },
      index(name: string) { expect(name).toBe(EDITOR_RECOVERY_DRAFT_SCOPE_INDEX); return index; },
      get(key: IDBValidKey) {
        return run("get", () => {
          const value = records.get(String(key));
          return value === undefined ? undefined : structuredClone(value);
        });
      },
      put(value: unknown) {
        return run("put", () => {
          const key = (value as { key: string }).key;
          records.set(key, structuredClone(value));
          return key;
        });
      },
      delete(key: IDBValidKey) { return run("delete", () => { records.delete(String(key)); return undefined; }); },
      openCursor() { return cursorRequest(); },
    } as IDBObjectStore;

    return { transaction: transaction as unknown as IDBTransaction, store, scheduleComplete };
  }

  let normalController: ReturnType<typeof makeTransaction> | null = null;
  const database = {
    objectStoreNames: { contains: (name: string) => storeCreated && name === EDITOR_RECOVERY_DRAFT_STORE_NAME },
    createObjectStore(name: string, parameters?: IDBObjectStoreParameters) {
      expect(name).toBe(EDITOR_RECOVERY_DRAFT_STORE_NAME);
      expect(parameters).toEqual({ keyPath: "key" });
      storeCreated = true;
      return normalController!.store;
    },
    transaction(name: string, mode: IDBTransactionMode = "readonly") {
      expect(name).toBe(EDITOR_RECOVERY_DRAFT_STORE_NAME);
      const controller = makeTransaction(mode);
      queueMicrotask(controller.scheduleComplete);
      return controller.transaction;
    },
    close: () => undefined,
    onversionchange: null,
  } as unknown as IDBDatabase;

  const factory = {
    open(name: string, version?: number) {
      openCalls.push({ name, version });
      const targetVersion = version ?? databaseVersion;
      const needsUpgrade = targetVersion > databaseVersion;
      const finishOpen = () => {
        databaseVersion = targetVersion;
        request.onsuccess?.call(request as unknown as IDBRequest<IDBDatabase>, event());
      };
      const upgradeController = makeTransaction("readwrite", finishOpen);
      normalController = upgradeController;
      const request: MutableOpenRequest = {
        result: database, error: null, onsuccess: null, onerror: null,
        onupgradeneeded: null, onblocked: null, transaction: upgradeController.transaction,
      };
      queueMicrotask(() => {
        if (needsUpgrade) {
          request.onupgradeneeded?.call(request as unknown as IDBOpenDBRequest, event(databaseVersion));
          upgradeController.scheduleComplete();
        } else finishOpen();
      });
      return request as unknown as IDBOpenDBRequest;
    },
  } as IDBFactory;

  return {
    factory,
    records,
    openCalls,
    failNextOperation(kind) { nextFailure = kind; },
  };
}

const ENTITY_ID = "00000000-0000-4000-8000-000000000001";
function draft(overrides: Partial<CreateApplicationNotesDraftInput> = {}): EditorRecoveryDraft {
  return createApplicationNotesDraft({
    entityId: ENTITY_ID,
    draftId: "session-a",
    content: "第一行\n\n第二行",
    baseVersion: 3,
    serverUpdatedAtMs: 1_000,
    updatedAtMs: 2_000,
    revision: 1,
    ...overrides,
  });
}

describe("EditorRecoveryDraft validation and classification", () => {
  it("builds deterministic scope and per-editor keys", () => {
    expect(applicationNotesDraftScopeKey(ENTITY_ID)).toBe(
      `editor-recovery-draft-scope:v1:APPLICATION_NOTES:${ENTITY_ID}:notesMarkdown`,
    );
    expect(applicationNotesDraftKey(ENTITY_ID, "session-a")).not.toBe(
      applicationNotesDraftKey(ENTITY_ID, "session-b"),
    );
    for (const invalid of ["", "../application", "包含中文", "a".repeat(129)]) {
      expect(() => applicationNotesDraftKey(invalid, "session-a")).toThrowError(
        expect.objectContaining({ code: "INVALID_DRAFT" }),
      );
    }
  });

  it("preserves Markdown and validates length, versions, revisions, and date range", () => {
    expect(draft().content).toBe("第一行\n\n第二行");
    for (const overrides of [
      { content: "x".repeat(EDITOR_RECOVERY_DRAFT_MAX_CONTENT_LENGTH + 1) },
      { baseVersion: 0 }, { revision: 0 }, { updatedAtMs: 8_640_000_000_000_001 },
    ]) {
      expect(() => draft(overrides)).toThrowError(expect.objectContaining({ code: "INVALID_DRAFT" }));
    }
  });

  it("deletes only identical content and classifies every different value explicitly", () => {
    expect(compareEditorRecoveryDraft(null, { content: "saved", version: 3, updatedAtMs: 1_000 }))
      .toEqual({ status: "NONE", shouldDelete: false });
    expect(compareEditorRecoveryDraft(draft({ content: "saved" }), { content: "saved", version: 99, updatedAtMs: 9_999 }))
      .toEqual({ status: "NONE", shouldDelete: true });
    expect(classifyEditorRecoveryDraft(draft(), { content: "saved", version: 3, updatedAtMs: 1_000 }))
      .toBe("RECOVERABLE");
    expect(compareEditorRecoveryDraft(draft({ updatedAtMs: 1_500 }), { content: "new", version: 4, updatedAtMs: 2_000 }))
      .toEqual({ status: "STALE_DIFFERENT", shouldDelete: false });
    expect(compareEditorRecoveryDraft(draft({ updatedAtMs: 3_000 }), { content: "new", version: 4, updatedAtMs: 2_000 }))
      .toEqual({ status: "VERSION_CONFLICT", shouldDelete: false });
  });

  it("does not touch IndexedDB while importing in an SSR-like environment", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get() { throw new Error("must not access IndexedDB during import"); },
    });
    try {
      vi.resetModules();
      await expect(import("@/lib/editor-recovery-draft")).resolves.toBeDefined();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
      else Reflect.deleteProperty(globalThis, "indexedDB");
    }
  });
});

describe("EditorRecoveryDraft IndexedDB v2 storage", () => {
  it("keeps two editor candidates independently and deletes only the requested revision", async () => {
    const fake = createFakeIndexedDB();
    const options = { indexedDB: fake.factory };
    const first = draft({ draftId: "tab-a", content: "A", updatedAtMs: 2_000 });
    const second = draft({ draftId: "tab-b", content: "B", updatedAtMs: 3_000 });
    await putEditorRecoveryDraft(first, options);
    await putEditorRecoveryDraft(second, options);
    await expect(listApplicationNotesDrafts(ENTITY_ID, options)).resolves.toEqual([second, first]);
    await expect(deleteEditorRecoveryDraftIfRevision(first.key, first.revision, options)).resolves.toBe("DELETED");
    await expect(listApplicationNotesDrafts(ENTITY_ID, options)).resolves.toEqual([second]);
  });

  it("refuses to delete a newer revision observed after the UI snapshot", async () => {
    const fake = createFakeIndexedDB();
    const options = { indexedDB: fake.factory };
    const original = draft({ revision: 1 });
    const newer = draft({ content: "newer", revision: 2, updatedAtMs: 3_000 });
    await putEditorRecoveryDraft(original, options);
    await putEditorRecoveryDraft(newer, options);
    await expect(deleteEditorRecoveryDraftIfRevision(original.key, 1, options)).resolves.toBe("CHANGED");
    await expect(getEditorRecoveryDraft(original.key, options)).resolves.toEqual(newer);
  });

  it("atomically cleans only candidates identical to the saved content", async () => {
    const fake = createFakeIndexedDB();
    const options = { indexedDB: fake.factory };
    const same = draft({ draftId: "same", content: "saved" });
    const different = draft({ draftId: "different", content: "unsaved", updatedAtMs: 3_000 });
    await putEditorRecoveryDraft(same, options);
    await putEditorRecoveryDraft(different, options);
    await expect(deleteApplicationNotesDraftsMatchingSavedContent(ENTITY_ID, "saved", options)).resolves.toEqual([same.key]);
    await expect(listApplicationNotesDrafts(ENTITY_ID, options)).resolves.toEqual([different]);
  });

  it("rolls back matching-content cleanup when any scoped record is corrupt", async () => {
    const fake = createFakeIndexedDB();
    const options = { indexedDB: fake.factory };
    const same = draft({ draftId: "a-same", content: "saved" });
    await putEditorRecoveryDraft(same, options);
    const corrupt = { ...draft({ draftId: "z-corrupt", content: "other" }), content: 42 };
    fake.records.set(corrupt.key, corrupt);

    await expect(deleteApplicationNotesDraftsMatchingSavedContent(ENTITY_ID, "saved", options))
      .rejects.toMatchObject({ code: "CORRUPT_DRAFT" });
    expect(fake.records.get(same.key)).toEqual(same);
    expect(fake.records.get(corrupt.key)).toEqual(corrupt);
  });

  it("migrates a valid v1 draft in place and makes it scope-searchable", async () => {
    const legacyKey = `editor-recovery-draft:v1:APPLICATION_NOTES:${ENTITY_ID}:notesMarkdown`;
    const legacy = {
      key: legacyKey, entityType: "APPLICATION_NOTES", entityId: ENTITY_ID, field: "notesMarkdown",
      content: "legacy", baseVersion: 2, serverUpdatedAtMs: 100, updatedAtMs: 200,
    };
    const fake = createFakeIndexedDB({ version: 1, records: new Map([[legacyKey, legacy]]) });
    const values = await listApplicationNotesDrafts(ENTITY_ID, { indexedDB: fake.factory });
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ key: legacyKey, draftId: "legacy-v1", revision: 1, content: "legacy" });
    expect(fake.records.get(legacyKey)).toMatchObject({ schemaVersion: 2, scopeKey: applicationNotesDraftScopeKey(ENTITY_ID) });
  });

  it("preserves and reports a corrupt v1 record instead of silently migrating or deleting it", async () => {
    const legacyKey = `editor-recovery-draft:v1:APPLICATION_NOTES:${ENTITY_ID}:notesMarkdown`;
    const corrupt = {
      key: legacyKey, entityType: "APPLICATION_NOTES", entityId: ENTITY_ID, field: "notesMarkdown",
      content: 42, baseVersion: 2, serverUpdatedAtMs: 100, updatedAtMs: 200,
    };
    const fake = createFakeIndexedDB({ version: 1, records: new Map([[legacyKey, corrupt]]) });
    await expect(listApplicationNotesDrafts(ENTITY_ID, { indexedDB: fake.factory }))
      .rejects.toMatchObject({ code: "CORRUPT_DRAFT" });
    expect(fake.records.get(legacyKey)).toEqual(corrupt);
  });

  it("maps request failures to safe operation errors without leaking browser details", async () => {
    const fake = createFakeIndexedDB();
    fake.failNextOperation("put");
    const promise = putEditorRecoveryDraft(draft(), { indexedDB: fake.factory });
    await expect(promise).rejects.toMatchObject({ code: "WRITE_FAILED" });
    await expect(promise).rejects.not.toThrow("fake operation failure");

    fake.failNextOperation("get");
    await expect(listApplicationNotesDrafts(ENTITY_ID, { indexedDB: fake.factory }))
      .rejects.toMatchObject({ code: "READ_FAILED" });

    const value = draft();
    await putEditorRecoveryDraft(value, { indexedDB: fake.factory });
    fake.failNextOperation("delete");
    await expect(deleteEditorRecoveryDraftIfRevision(value.key, value.revision, { indexedDB: fake.factory }))
      .rejects.toMatchObject({ code: "DELETE_FAILED" });
    expect(fake.records.get(value.key)).toEqual(value);
  });

  it("fails safely when storage or database open is unavailable", async () => {
    const promise = listApplicationNotesDrafts(ENTITY_ID, { indexedDB: null });
    await expect(promise).rejects.toBeInstanceOf(EditorRecoveryDraftError);
    await expect(promise).rejects.toMatchObject({ code: "INDEXED_DB_UNAVAILABLE" });

    const failingFactory = { open() { throw new Error("sensitive browser detail"); } } as unknown as IDBFactory;
    const failedOpen = listApplicationNotesDrafts(ENTITY_ID, { indexedDB: failingFactory });
    await expect(failedOpen).rejects.toMatchObject({ code: "OPEN_FAILED" });
    await expect(failedOpen).rejects.not.toThrow("sensitive browser detail");
  });

  it("opens the expected v2 database and store/index contract", async () => {
    const fake = createFakeIndexedDB();
    await expect(listApplicationNotesDrafts(ENTITY_ID, { indexedDB: fake.factory })).resolves.toEqual([]);
    expect(fake.openCalls).toContainEqual({ name: EDITOR_RECOVERY_DRAFT_DB_NAME, version: EDITOR_RECOVERY_DRAFT_DB_VERSION });
    expect(EDITOR_RECOVERY_DRAFT_STORE_NAME).toBe("editor-recovery-drafts");
    expect(EDITOR_RECOVERY_DRAFT_SCOPE_INDEX).toBe("by-scope");
  });
});
