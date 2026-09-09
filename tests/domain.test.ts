import { describe, expect, it } from "vitest";

import {
  archiveApplicationInputSchema,
  createApplicationInputSchema,
  createEventInputSchema,
  DomainError,
  normalizeLookupText,
  normalizeOptionalMarkdown,
  parseDomainInput,
} from "@/lib/domain";

describe("domain validation", () => {
  it("normalizes lookup text deterministically", () => {
    expect(normalizeLookupText("  字节   跳动  ")).toBe("字节 跳动");
    expect(normalizeLookupText("ＡＢＣ")).toBe("abc");
  });

  it("preserves Markdown whitespace while normalizing line endings", () => {
    expect(normalizeOptionalMarkdown("  第一行\r\n\r\n  - 列表  ")).toBe(
      "  第一行\n\n  - 列表  ",
    );
    expect(normalizeOptionalMarkdown(" \n\t ")).toBeNull();
  });

  it("applies safe application defaults", () => {
    const value = parseDomainInput(createApplicationInputSchema, {
      companyName: "示例公司",
      positionTitle: "后端工程师",
    });
    expect(value).toMatchObject({
      stage: "OPPORTUNITY_POOL",
      priority: "MEDIUM",
      sourceKind: "UNSPECIFIED",
      attention: { mode: "NEEDS_ACTION" },
      allowDuplicate: false,
    });
  });

  it("rejects invalid custom sources with safe field errors", () => {
    expect(() =>
      parseDomainInput(createApplicationInputSchema, {
        companyName: "示例公司",
        positionTitle: "客户端工程师",
        sourceKind: "CUSTOM",
      }),
    ).toThrowError(DomainError);

    try {
      parseDomainInput(createApplicationInputSchema, {
        companyName: "示例公司",
        positionTitle: "客户端工程师",
        sourceKind: "CUSTOM",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("VALIDATION_ERROR");
      expect((error as DomainError).fieldErrors?.sourceDetail).toBeDefined();
    }
  });

  it("rejects reversed timed and all-day ranges", () => {
    for (const schedule of [
      { kind: "TIMED", startsAtMs: 20, endsAtMs: 10 },
      { kind: "ALL_DAY", startDate: "2026-09-10", endDateExclusive: "2026-09-10" },
    ]) {
      expect(() =>
        parseDomainInput(createEventInputSchema, {
          applicationId: "00000000-0000-4000-8000-000000000001",
          type: "INTERVIEW",
          title: "面试",
          schedule,
        }),
      ).toThrowError(DomainError);
    }
  });

  it("requires a note for OTHER archive reason", () => {
    expect(() => parseDomainInput(archiveApplicationInputSchema, { reason: "OTHER" })).toThrowError(
      DomainError,
    );
    expect(parseDomainInput(archiveApplicationInputSchema, { reason: "OTHER", note: "岗位暂停" })).toMatchObject({
      reason: "OTHER",
      note: "岗位暂停",
    });
  });
});
