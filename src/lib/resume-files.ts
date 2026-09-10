import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { unzipSync } from "fflate";

import { getDatabaseContext } from "@/lib/db/client";

export const RESUME_FILE_MAX_BYTES = 10 * 1024 * 1024;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const OBJECT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|docx)$/;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const FORMATS = {
  PDF: { extension: ".pdf", contentType: "application/pdf" },
  DOCX: { extension: ".docx", contentType: DOCX_MIME },
} as const;

export type ResumeFileFormat = keyof typeof FORMATS;
export type ResumeFileSource = Blob | ArrayBuffer | Uint8Array;
const MESSAGES = {
  EMPTY_FILE: "文件为空。",
  FILE_TOO_LARGE: "文件超过 10 MiB 上限。",
  INVALID_FILE_NAME: "文件名无效。",
  UNSUPPORTED_FILE_TYPE: "仅支持 PDF 或 DOCX 文件。",
  MIME_MISMATCH: "文件扩展名与 MIME 类型不一致。",
  INVALID_FILE_CONTENT: "文件内容与声明的类型不一致或文件已损坏。",
  INVALID_OBJECT_KEY: "文件标识无效。",
  UNSAFE_STORAGE_PATH: "文件存储路径无效。",
  FILE_NOT_FOUND: "没有找到这个文件。",
  FILE_WRITE_FAILED: "文件保存失败。",
  FILE_READ_FAILED: "文件读取失败。",
} as const;
export type ResumeFileErrorCode = keyof typeof MESSAGES;

export class ResumeFileError extends Error {
  constructor(readonly code: ResumeFileErrorCode, options?: ErrorOptions) {
    super(MESSAGES[code], options);
    this.name = "ResumeFileError";
  }
}

export interface ResumeFileUpload {
  originalName: string;
  declaredMimeType?: string | null;
  source: ResumeFileSource;
}

export interface StoredResumeFile {
  objectKey: string;
  originalName: string;
  format: ResumeFileFormat;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface ReadResumeFile extends Omit<StoredResumeFile, "originalName"> {
  bytes: Uint8Array;
}

export interface ResumeFileStorageOptions {
  /** Trusted injection for isolated tests; normal callers use the active database context. */
  location?: { dataRoot: string; generationId: string };
  createId?: () => string;
}

function error(code: ResumeFileErrorCode, cause?: unknown) {
  return new ResumeFileError(code, cause === undefined ? undefined : { cause });
}

function isInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function attachmentsDirectory(options: ResumeFileStorageOptions, create: boolean) {
  const location = options.location ?? await getDatabaseContext();
  if (!location.dataRoot || !SAFE_GENERATION.test(location.generationId)) {
    throw error("UNSAFE_STORAGE_PATH");
  }
  if (create) await mkdir(location.dataRoot, { recursive: true });
  const dataRoot = await realpath(location.dataRoot);
  const candidate = path.resolve(dataRoot, "stores", location.generationId, "attachments");
  if (!isInside(dataRoot, candidate)) throw error("UNSAFE_STORAGE_PATH");
  if (create) await mkdir(candidate, { recursive: true });
  const resolved = await realpath(candidate);
  if (!isInside(dataRoot, resolved)) throw error("UNSAFE_STORAGE_PATH");
  return resolved;
}

function isBlob(source: unknown): source is Blob {
  return typeof Blob !== "undefined" && source instanceof Blob;
}

async function bytesFrom(source: ResumeFileSource) {
  const size = source instanceof Uint8Array || source instanceof ArrayBuffer
    ? source.byteLength
    : isBlob(source) ? source.size : -1;
  if (size === 0) throw error("EMPTY_FILE");
  if (size < 0) throw error("UNSUPPORTED_FILE_TYPE");
  if (size > RESUME_FILE_MAX_BYTES) throw error("FILE_TOO_LARGE");
  if (source instanceof Uint8Array) return Uint8Array.from(source);
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  return new Uint8Array(await source.arrayBuffer());
}

function formatFromName(name: string): ResumeFileFormat {
  if (typeof name !== "string" || !name.trim() || name.length > 255 || /[\u0000-\u001f\\/]/.test(name)) {
    throw error("INVALID_FILE_NAME");
  }
  const extension = path.extname(name).toLowerCase();
  if (extension === ".pdf") return "PDF";
  if (extension === ".docx") return "DOCX";
  throw error("UNSUPPORTED_FILE_TYPE");
}

function formatFromKey(objectKey: string): ResumeFileFormat {
  const match = OBJECT_KEY.exec(objectKey);
  if (!match) throw error("INVALID_OBJECT_KEY");
  return match[1] === "pdf" ? "PDF" : "DOCX";
}

function validateMime(value: string | null | undefined, format: ResumeFileFormat) {
  if (value == null || value.trim() === "") return;
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  if (mime !== FORMATS[format].contentType) throw error("MIME_MISMATCH");
}

function validateContent(bytes: Uint8Array, format: ResumeFileFormat) {
  if (format === "PDF") {
    const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
    if (!signature.every((value, index) => bytes[index] === value)) throw error("INVALID_FILE_CONTENT");
    return;
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw error("INVALID_FILE_CONTENT");
  }
  try {
    const wanted = new Set(["[Content_Types].xml", "word/document.xml"]);
    const parts = unzipSync(bytes, {
      filter: ({ name, originalSize }) => wanted.has(name) && originalSize <= RESUME_FILE_MAX_BYTES,
    });
    if (!parts["[Content_Types].xml"]?.length || !parts["word/document.xml"]?.length) {
      throw error("INVALID_FILE_CONTENT");
    }
  } catch (cause) {
    if (cause instanceof ResumeFileError) throw cause;
    throw error("INVALID_FILE_CONTENT", cause);
  }
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathFor(directory: string, objectKey: string) {
  if (!OBJECT_KEY.test(objectKey)) throw error("INVALID_OBJECT_KEY");
  const candidate = path.resolve(directory, objectKey);
  if (!isInside(directory, candidate)) throw error("UNSAFE_STORAGE_PATH");
  return candidate;
}

export async function storeResumeFile(upload: ResumeFileUpload, options: ResumeFileStorageOptions = {}): Promise<StoredResumeFile> {
  const originalName = typeof upload.originalName === "string" ? upload.originalName.normalize("NFC").trim() : "";
  const format = formatFromName(originalName);
  validateMime(upload.declaredMimeType ?? (isBlob(upload.source) ? upload.source.type : null), format);
  const bytes = await bytesFrom(upload.source);
  validateContent(bytes, format);
  const directory = await attachmentsDirectory(options, true);
  const createId = options.createId ?? randomUUID;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = createId().toLowerCase();
    if (!SAFE_UUID.test(id)) throw error("FILE_WRITE_FAILED");
    const objectKey = `${id}${FORMATS[format].extension}`;
    try {
      await writeFile(pathFor(directory, objectKey), bytes, { flag: "wx", mode: 0o600, flush: true });
      return { objectKey, originalName, format, contentType: FORMATS[format].contentType, sizeBytes: bytes.length, sha256: sha256(bytes) };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error("FILE_WRITE_FAILED", cause);
    }
  }
  throw error("FILE_WRITE_FAILED");
}

export async function readResumeFile(objectKey: string, options: ResumeFileStorageOptions = {}): Promise<ReadResumeFile> {
  const format = formatFromKey(objectKey);
  try {
    const directory = await attachmentsDirectory(options, false);
    const target = pathFor(directory, objectKey);
    const resolved = await realpath(target);
    if (!isInside(directory, resolved)) throw error("UNSAFE_STORAGE_PATH");
    const info = await stat(resolved);
    if (!info.isFile()) throw error("FILE_READ_FAILED");
    if (info.size > RESUME_FILE_MAX_BYTES) throw error("FILE_TOO_LARGE");
    const bytes = Uint8Array.from(await readFile(resolved));
    if (!bytes.length) throw error("EMPTY_FILE");
    if (bytes.length > RESUME_FILE_MAX_BYTES) throw error("FILE_TOO_LARGE");
    validateContent(bytes, format);
    return { objectKey, format, contentType: FORMATS[format].contentType, sizeBytes: bytes.length, sha256: sha256(bytes), bytes };
  } catch (cause) {
    if (cause instanceof ResumeFileError) throw cause;
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw error("FILE_NOT_FOUND");
    throw error("FILE_READ_FAILED", cause);
  }
}

export async function deleteResumeFile(objectKey: string, options: ResumeFileStorageOptions = {}): Promise<boolean> {
  formatFromKey(objectKey);
  try {
    const directory = await attachmentsDirectory(options, false);
    await rm(pathFor(directory, objectKey));
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (cause instanceof ResumeFileError) throw cause;
    throw error("FILE_WRITE_FAILED", cause);
  }
}
