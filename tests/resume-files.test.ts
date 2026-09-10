import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import {
  deleteResumeFile,
  readResumeFile,
  RESUME_FILE_MAX_BYTES,
  storeResumeFile,
} from "@/lib/resume-files";

const PDF_BYTES = strToU8("%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n");
const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

function docxBytes(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
    ),
    "word/document.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    ),
  });
}

describe("resume file storage", () => {
  let dataRoot: string | null = null;

  async function options(createId: () => string = () => FIRST_ID) {
    dataRoot ??= await mkdtemp(path.join(os.tmpdir(), "campus-hire-resume-files-"));
    return {
      location: { dataRoot, generationId: "gen-test" },
      createId,
    };
  }

  afterEach(async () => {
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
    dataRoot = null;
  });

  it("stores a PDF under a random internal name and reads it back for download", async () => {
    const storageOptions = await options();
    const stored = await storeResumeFile({
      originalName: "个人简历.PDF",
      declaredMimeType: `${PDF_MIME}; charset=binary`,
      source: PDF_BYTES,
    }, storageOptions);

    expect(stored).toEqual({
      objectKey: `${FIRST_ID}.pdf`,
      originalName: "个人简历.PDF",
      format: "PDF",
      contentType: PDF_MIME,
      sizeBytes: PDF_BYTES.byteLength,
      sha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
    });
    expect(stored.objectKey).not.toContain("个人简历");

    const target = path.join(dataRoot!, "stores", "gen-test", "attachments", stored.objectKey);
    await expect(readFile(target)).resolves.toEqual(Buffer.from(PDF_BYTES));
    await expect(lstat(target)).resolves.toMatchObject({ size: PDF_BYTES.byteLength });
    const read = await readResumeFile(stored.objectKey, storageOptions);
    expect(read.contentType).toBe(PDF_MIME);
    expect(read.sha256).toBe(stored.sha256);
    expect(read.bytes).toEqual(PDF_BYTES);
  });

  it("accepts only a structurally recognizable Word OOXML package as DOCX", async () => {
    const storageOptions = await options();
    const bytes = docxBytes();
    const stored = await storeResumeFile({
      originalName: "campus-resume.docx",
      declaredMimeType: DOCX_MIME,
      source: new Blob([Uint8Array.from(bytes).buffer], { type: DOCX_MIME }),
    }, storageOptions);

    expect(stored).toMatchObject({
      objectKey: `${FIRST_ID}.docx`,
      format: "DOCX",
      contentType: DOCX_MIME,
      sizeBytes: bytes.byteLength,
    });
    await expect(readResumeFile(stored.objectKey, storageOptions)).resolves.toMatchObject({
      format: "DOCX",
      contentType: DOCX_MIME,
    });
  });

  it.each([
    {
      label: "unsupported extension",
      upload: { originalName: "resume.exe", declaredMimeType: "application/octet-stream", source: PDF_BYTES },
      code: "UNSUPPORTED_FILE_TYPE",
    },
    {
      label: "MIME mismatch",
      upload: { originalName: "resume.pdf", declaredMimeType: DOCX_MIME, source: PDF_BYTES },
      code: "MIME_MISMATCH",
    },
    {
      label: "renamed non-PDF content",
      upload: { originalName: "resume.pdf", declaredMimeType: PDF_MIME, source: strToU8("not a pdf") },
      code: "INVALID_FILE_CONTENT",
    },
    {
      label: "unsafe original filename",
      upload: { originalName: "../resume.pdf", declaredMimeType: PDF_MIME, source: PDF_BYTES },
      code: "INVALID_FILE_NAME",
    },
  ])("rejects $label before writing", async ({ upload, code }) => {
    const storageOptions = await options();
    await expect(storeResumeFile(upload, storageOptions)).rejects.toMatchObject({ code });
    await expect(access(path.join(dataRoot!, "stores"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an oversized file before creating storage directories", async () => {
    const storageOptions = await options();
    await expect(storeResumeFile({
      originalName: "resume.pdf",
      declaredMimeType: PDF_MIME,
      source: new Uint8Array(RESUME_FILE_MAX_BYTES + 1),
    }, storageOptions)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(access(path.join(dataRoot!, "stores"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a ZIP that is not a Word OOXML document", async () => {
    const storageOptions = await options();
    const genericZip = zipSync({ "notes.txt": strToU8("hello") });
    await expect(storeResumeFile({
      originalName: "resume.docx",
      declaredMimeType: DOCX_MIME,
      source: genericZip,
    }, storageOptions)).rejects.toMatchObject({ code: "INVALID_FILE_CONTENT" });
  });

  it("never overwrites a colliding object key", async () => {
    const firstOptions = await options(() => FIRST_ID);
    const first = await storeResumeFile({
      originalName: "first.pdf",
      declaredMimeType: PDF_MIME,
      source: PDF_BYTES,
    }, firstOptions);
    const firstPath = path.join(dataRoot!, "stores", "gen-test", "attachments", first.objectKey);
    const originalBytes = await readFile(firstPath);

    const ids = [FIRST_ID, SECOND_ID];
    const second = await storeResumeFile({
      originalName: "second.pdf",
      declaredMimeType: PDF_MIME,
      source: strToU8("%PDF-2.0\nchanged\n%%EOF\n"),
    }, await options(() => ids.shift()!));

    expect(second.objectKey).toBe(`${SECOND_ID}.pdf`);
    await expect(readFile(firstPath)).resolves.toEqual(originalBytes);
  });

  it("rejects traversal-like read keys without touching the filesystem", async () => {
    const storageOptions = await options();
    await expect(readResumeFile("../resume.pdf", storageOptions))
      .rejects.toMatchObject({ code: "INVALID_OBJECT_KEY" });
    await expect(readResumeFile("C:\\resume.pdf", storageOptions))
      .rejects.toMatchObject({ code: "INVALID_OBJECT_KEY" });
  });

  it("revalidates content when reading a stored file", async () => {
    const storageOptions = await options();
    const stored = await storeResumeFile({
      originalName: "resume.pdf",
      declaredMimeType: PDF_MIME,
      source: PDF_BYTES,
    }, storageOptions);
    const target = path.join(dataRoot!, "stores", "gen-test", "attachments", stored.objectKey);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(target, "not a pdf"));

    await expect(readResumeFile(stored.objectKey, storageOptions))
      .rejects.toMatchObject({ code: "INVALID_FILE_CONTENT" });
  });

  it("deletes one exact key and treats a missing file as already deleted", async () => {
    const storageOptions = await options();
    const stored = await storeResumeFile({
      originalName: "resume.pdf",
      declaredMimeType: PDF_MIME,
      source: PDF_BYTES,
    }, storageOptions);
    const target = path.join(dataRoot!, "stores", "gen-test", "attachments", stored.objectKey);

    await expect(deleteResumeFile(stored.objectKey, storageOptions)).resolves.toBe(true);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(deleteResumeFile(stored.objectKey, storageOptions)).resolves.toBe(false);
    await expect(deleteResumeFile("../resume.pdf", storageOptions))
      .rejects.toMatchObject({ code: "INVALID_OBJECT_KEY" });
  });
});
