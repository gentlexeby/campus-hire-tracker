import { describe, expect, it } from "vitest";

import {
  assertResumeVersionCanBeSubmitted,
  createResumeInputSchema,
  createResumeVersionInputSchema,
  DomainError,
  parseDomainInput,
  RESUME_DELIVERY_PDF_MIME_TYPE,
  RESUME_SOURCE_DOCX_MIME_TYPE,
  setApplicationResumeVersionInputSchema,
} from "@/lib/domain";

const RESUME_ID = "123e4567-e89b-42d3-a456-426614174000";
const VERSION_ID = "123e4567-e89b-42d3-a456-426614174001";
const SHA256 = "a".repeat(64);

function sourceDocx() {
  return {
    originalName: "校招简历.docx",
    relativePath: `${VERSION_ID}.docx`,
    mimeType: RESUME_SOURCE_DOCX_MIME_TYPE,
    sizeBytes: 12_345,
    sha256: SHA256,
  } as const;
}

function deliveryPdf() {
  return {
    originalName: "校招简历.pdf",
    relativePath: `${VERSION_ID}.pdf`,
    mimeType: RESUME_DELIVERY_PDF_MIME_TYPE,
    sizeBytes: 23_456,
    sha256: SHA256,
  } as const;
}

describe("resume domain validation", () => {
  it("requires a name while keeping direction and language optional", () => {
    expect(parseDomainInput(createResumeInputSchema, { name: "  校招主简历  " })).toEqual({
      name: "校招主简历",
    });
    expect(
      parseDomainInput(createResumeInputSchema, {
        name: "校招主简历",
        targetDirection: "   ",
        language: "",
      }),
    ).toEqual({ name: "校招主简历", targetDirection: null, language: null });
    expect(() => parseDomainInput(createResumeInputSchema, { name: "   " })).toThrowError(
      DomainError,
    );
  });

  it("accepts source-only, delivery-only, and combined version payloads", () => {
    for (const files of [
      { sourceDocx: sourceDocx() },
      { deliveryPdf: deliveryPdf() },
      { sourceDocx: sourceDocx(), deliveryPdf: deliveryPdf() },
    ]) {
      expect(
        parseDomainInput(createResumeVersionInputSchema, {
          resumeId: RESUME_ID,
          changeSummary: "针对后端岗位调整",
          ...files,
        }),
      ).toMatchObject(files);
    }
  });

  it("rejects an empty version and keeps version numbers server-owned", () => {
    expect(() =>
      parseDomainInput(createResumeVersionInputSchema, { resumeId: RESUME_ID }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));

    expect(() =>
      parseDomainInput(createResumeVersionInputSchema, {
        resumeId: RESUME_ID,
        sourceDocx: sourceDocx(),
        versionNumber: 7,
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("rejects partial, mislabeled, unsafe, or unverified file metadata", () => {
    const invalidFiles = [
      { ...sourceDocx(), mimeType: "application/pdf" },
      { ...sourceDocx(), relativePath: "../outside.docx" },
      { ...sourceDocx(), relativePath: `resumes/${RESUME_ID}/source.pdf` },
      { ...sourceDocx(), sizeBytes: 0 },
      { ...sourceDocx(), sha256: "A".repeat(64) },
      { originalName: "missing.docx" },
    ];

    for (const source of invalidFiles) {
      expect(() =>
        parseDomainInput(createResumeVersionInputSchema, {
          resumeId: RESUME_ID,
          sourceDocx: source,
        }),
      ).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }
  });

  it("only allows versions with a complete delivery PDF to be submitted", () => {
    const sourceOnly = parseDomainInput(createResumeVersionInputSchema, {
      resumeId: RESUME_ID,
      sourceDocx: sourceDocx(),
    });
    expect(() => assertResumeVersionCanBeSubmitted(sourceOnly)).toThrowError(
      expect.objectContaining({ code: "RESUME_VERSION_NOT_DELIVERABLE" }),
    );

    const deliverable = parseDomainInput(createResumeVersionInputSchema, {
      resumeId: RESUME_ID,
      deliveryPdf: deliveryPdf(),
    });
    expect(() => assertResumeVersionCanBeSubmitted(deliverable)).not.toThrow();
  });

  it("accepts assigning or clearing the application delivery version", () => {
    expect(
      parseDomainInput(setApplicationResumeVersionInputSchema, {
        resumeVersionId: VERSION_ID,
        expectedVersion: 2,
      }),
    ).toEqual({ resumeVersionId: VERSION_ID, expectedVersion: 2 });
    expect(
      parseDomainInput(setApplicationResumeVersionInputSchema, { resumeVersionId: null }),
    ).toEqual({ resumeVersionId: null });
  });
});
