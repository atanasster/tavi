import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument } from "@cantoo/pdf-lib";
import type { PdfChildLimits } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { PdfEngine, type OpenedDocument } from "../src/engine.js";
import { PdfiumDocument } from "../src/read-pdfium.js";
import { testPdfium } from "./support.js";

/** `flatten: true`: a final copy, its values in the pages and its fields gone. */

const limits: PdfChildLimits = { maxPages: 500, maxFields: 1_000, maxPixelsPerPage: 4_000_000, textPerCall: 40_000, pagesPerTextCall: 40 };
const font = new Uint8Array(readFileSync(join(import.meta.dirname, "..", "assets", "NotoSans-Regular.ttf")));

async function form(options: { readonly signature?: boolean } = {}): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([600, 800]);
  const fields = document.getForm();
  fields.createTextField("name").addToPage(page, { x: 100, y: 700, width: 250, height: 20 });
  fields.createCheckBox("photos").addToPage(page, { x: 100, y: 650, width: 15, height: 15 });
  if (options.signature === true) fields.createTextField("parent_signature").addToPage(page, { x: 100, y: 600, width: 250, height: 20 });
  return document.save();
}

async function filled(bytes: Uint8Array): Promise<Awaited<ReturnType<OpenedDocument["fill"]>>> {
  const opened = await new PdfEngine(await testPdfium()).open(bytes, limits);
  if ("refused" in opened) throw new Error(`refused: ${opened.refused}`);
  try {
    return await opened.fill(
      {
        values: [
          { field: "name", value: "Leo Ivanov" },
          { field: "photos", value: true },
        ],
        preview: true,
        flatten: true,
      },
      [font],
    );
  } finally {
    opened.close();
  }
}

describe("a flattened copy", () => {
  it("draws the values into the page and leaves no field", async () => {
    const result = await filled(await form());
    if ("refused" in result) throw new Error(`refused: ${result.refused}`);
    expect(result.fill).toMatchObject({ flattened: true, answerSheet: false, previewPages: [1] });
    expect(result.previews).toHaveLength(1);
    const reader = PdfiumDocument.open(await testPdfium(), result.bytes) as PdfiumDocument;
    try {
      expect(reader.widgets(10)).toHaveLength(0);
      expect(reader.text(0, new Set(), 10_000).text).toContain("Leo Ivanov");
    } finally {
      reader.close();
    }
  });

  it("is refused while a field is left for the person to sign", async () => {
    expect(await filled(await form({ signature: true }))).toMatchObject({ refused: "flatten-not-permitted" });
  });

  it("is refused for a form whose permissions do not allow changing its pages", async () => {
    const locked = await PDFDocument.load(await form(), { updateMetadata: false });
    await locked.encrypt({
      userPassword: "",
      ownerPassword: "owner",
      permissions: { fillingForms: true, annotating: true, modifying: false },
    });
    expect(await filled(await locked.save())).toMatchObject({ refused: "flatten-not-permitted" });
  });
});
