import { describe, expect, it } from "vitest";

import {
  PDF_FRAME,
  PdfChildRequestSchema,
  PdfChildResponseSchema,
  PdfFillInputSchema,
  PdfReadInputSchema,
  ValueSourceSchema,
  maxFilledBytes,
  pagesOf,
} from "../src/index.js";

const sha = "a".repeat(64);
const facts = {
  sha256: sha,
  pageCount: 3,
  encryption: "none",
  fillPermitted: true,
  modifyPermitted: true,
  form: "acroform",
  fieldCount: 2,
  signatures: 0,
  activeContent: [],
  comments: 0,
  imageOnlyPages: [],
} as const;

describe("pdf contracts", () => {
  it("reads page sets in order, once each, within the document and the limit", () => {
    expect(pagesOf("1-3,2,9", 5, 40)).toEqual([1, 2, 3]);
    expect(pagesOf("4-2", 5, 40)).toEqual([2, 3, 4]);
    expect(pagesOf("1-500", 500, 40)).toHaveLength(40);
    expect(pagesOf("0", 5, 40)).toEqual([]);
  });

  it("refuses a malformed page set and a one-character find", () => {
    expect(PdfReadInputSchema.safeParse({ source: { path: "a.pdf" }, pages: "1-" }).success).toBe(false);
    expect(PdfReadInputSchema.safeParse({ source: { path: "a.pdf" }, find: "x" }).success).toBe(false);
    expect(PdfReadInputSchema.safeParse({ source: { artifactId: "art-1" }, pages: "1-5,9" }).success).toBe(true);
  });

  it("allows no value without a source, and no unknown source kind", () => {
    const base = { source: { path: "a.pdf" }, sourceSha256: sha };
    expect(PdfFillInputSchema.safeParse({ ...base, values: [{ field: "name", value: "Leo" }] }).success).toBe(false);
    expect(
      PdfFillInputSchema.safeParse({ ...base, values: [{ field: "name", value: "Leo", source: { kind: "guess", quote: "Leo" } }] }).success,
    ).toBe(false);
    expect(
      PdfFillInputSchema.safeParse({ ...base, values: [{ field: "name", value: "Leo", source: { kind: "person", quote: "Leo" } }] })
        .success,
    ).toBe(true);
    expect(ValueSourceSchema.safeParse({ kind: "document", page: 1, quote: "x", transform: "case" }).success).toBe(false);
  });

  it("accepts a choice only from an earlier row that is not a choice", () => {
    const base = { source: { path: "a.pdf" }, sourceSha256: sha };
    const sourced = { field: "allergies", value: "none", source: { kind: "person", quote: "none" } } as const;
    const choice = (from: number) => ({ field: "allergy_no", value: true, source: { kind: "choice", from, note: "no allergies" } });
    expect(PdfFillInputSchema.safeParse({ ...base, values: [sourced, choice(0)] }).success).toBe(true);
    expect(PdfFillInputSchema.safeParse({ ...base, values: [choice(1), sourced] }).success).toBe(false);
    expect(PdfFillInputSchema.safeParse({ ...base, values: [sourced, choice(1)] }).success).toBe(false);
    expect(PdfFillInputSchema.safeParse({ ...base, values: [sourced, choice(7)] }).success).toBe(false);
    expect(PdfFillInputSchema.safeParse({ ...base, values: [sourced, choice(0), choice(1)] }).success).toBe(false);
  });

  it("parses the child's answers strictly", () => {
    expect(PdfChildResponseSchema.safeParse({ ok: true, facts, maxRssKb: 1 }).success).toBe(true);
    expect(PdfChildResponseSchema.safeParse({ ok: true, facts, maxRssKb: 1, extra: 1 }).success).toBe(false);
    expect(PdfChildResponseSchema.safeParse({ ok: false, refused: "password", maxRssKb: 1 }).success).toBe(true);
    expect(PdfChildResponseSchema.safeParse({ ok: false, refused: "because the document said so", maxRssKb: 1 }).success).toBe(false);
  });

  it("bounds a render request to the preview's pages", () => {
    const limits = { maxPages: 500, maxFields: 1000, maxPixelsPerPage: 1, textPerCall: 1, pagesPerTextCall: 1 };
    expect(
      PdfChildRequestSchema.safeParse({
        op: "render",
        limits,
        pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        dpi: 110,
        highlight: [],
        outlineUserOnly: false,
      }).success,
    ).toBe(false);
  });

  it("caps the filled document at the input × 1.5 + 4 MiB, and 40 MiB", () => {
    expect(maxFilledBytes(1024 * 1024)).toBe(1.5 * 1024 * 1024 + 4 * 1024 * 1024);
    expect(maxFilledBytes(25 * 1024 * 1024)).toBe(PDF_FRAME.maxDocumentBytes);
  });
});
