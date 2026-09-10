import { DomainError, type ResumeDeliveryPdf, type ResumeSourceDocx } from "@/lib/domain";
import {
  deleteResumeFile,
  ResumeFileError,
  storeResumeFile,
  type ResumeFileFormat,
  type StoredResumeFile,
} from "@/lib/resume-files";

export const RESUME_UPLOAD_REQUEST_MAX_BYTES = 21 * 1024 * 1024;

export interface StoredResumeFormFiles {
  sourceDocx: ResumeSourceDocx | null;
  deliveryPdf: ResumeDeliveryPdf | null;
  objectKeys: string[];
}

function selectedFile(formData: FormData, key: string): File | null {
  const value = formData.get(key);
  if (!(value instanceof File)) return null;
  if (!value.name && value.size === 0) return null;
  return value;
}

function metadata(stored: StoredResumeFile) {
  return {
    originalName: stored.originalName,
    relativePath: stored.objectKey,
    mimeType: stored.contentType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
  };
}

async function storeSlot(file: File, expected: ResumeFileFormat): Promise<StoredResumeFile> {
  const stored = await storeResumeFile({
    originalName: file.name,
    declaredMimeType: file.type,
    source: file,
  });
  if (stored.format !== expected) {
    await deleteResumeFile(stored.objectKey);
    throw new DomainError(
      "VALIDATION_ERROR",
      expected === "DOCX" ? "DOCX 源文件栏只能选择 .docx 文件" : "PDF 投递文件栏只能选择 .pdf 文件",
    );
  }
  return stored;
}

export async function storeResumeFormFiles(formData: FormData): Promise<StoredResumeFormFiles> {
  const sourceFile = selectedFile(formData, "sourceDocx");
  const deliveryFile = selectedFile(formData, "deliveryPdf");
  if (!sourceFile && !deliveryFile) {
    throw new DomainError("FILE_REQUIRED", "请至少选择一个 DOCX 源文件或 PDF 投递文件");
  }
  const stored: StoredResumeFile[] = [];
  try {
    if (sourceFile) stored.push(await storeSlot(sourceFile, "DOCX"));
    if (deliveryFile) stored.push(await storeSlot(deliveryFile, "PDF"));
  } catch (error) {
    await Promise.allSettled(stored.map((file) => deleteResumeFile(file.objectKey)));
    throw error;
  }

  const sourceDocx = stored.find((file) => file.format === "DOCX") ?? null;
  const deliveryPdf = stored.find((file) => file.format === "PDF") ?? null;
  return {
    sourceDocx: sourceDocx ? metadata(sourceDocx) as ResumeSourceDocx : null,
    deliveryPdf: deliveryPdf ? metadata(deliveryPdf) as ResumeDeliveryPdf : null,
    objectKeys: stored.map((file) => file.objectKey),
  };
}

export async function cleanupResumeFormFiles(files: StoredResumeFormFiles): Promise<void> {
  await Promise.allSettled(files.objectKeys.map((objectKey) => deleteResumeFile(objectKey)));
}

export function resumeUploadErrorCode(error: unknown): string {
  if (error instanceof ResumeFileError || error instanceof DomainError) return error.code;
  return "UPLOAD_FAILED";
}
