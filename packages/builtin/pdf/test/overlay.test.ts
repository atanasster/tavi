import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import type { PdfChildLimits } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { PdfEngine, type OpenedDocument } from "../src/engine.js";
import { loadWriter, overlayValues } from "../src/write-pdflib.js";
import { testPdfium } from "./support.js";

/** `pdf.overlay`: a flat form's entry boxes found, and written over as FreeText annotations. */

const limits: PdfChildLimits = { maxPages: 500, maxFields: 1_000, maxPixelsPerPage: 4_000_000, textPerCall: 40_000, pagesPerTextCall: 40 };
const font = new Uint8Array(readFileSync(join(import.meta.dirname, "..", "assets", "NotoSans-Regular.ttf")));

/** A printed form: "Name" over an underline, "Date of birth" beside an empty box. */
async function flatForm(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([612, 792]);
  const helvetica = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Name:", { x: 60, y: 702, size: 11, font: helvetica });
  page.drawLine({ start: { x: 120, y: 700 }, end: { x: 360, y: 700 }, thickness: 0.75 });
  page.drawText("Date of birth", { x: 40, y: 645, size: 11, font: helvetica });
  page.drawRectangle({ x: 130, y: 638, width: 160, height: 22, borderColor: rgb(0, 0, 0), borderWidth: 0.75 });
  return document.save();
}

async function open(bytes: Uint8Array): Promise<OpenedDocument> {
  const opened = await new PdfEngine(await testPdfium()).open(bytes, limits);
  if ("refused" in opened) throw new Error(`refused: ${opened.refused}`);
  return opened;
}

describe("a flat form's overlay", () => {
  it("finds its entry boxes by the text beside them, and writes each value over its box", async () => {
    const document = await open(await flatForm());
    try {
      const boxes = document.boxes();
      expect(boxes.map((box) => [box.id, box.label])).toEqual([
        ["p1.b1", "Name"],
        ["p1.b2", "Date of birth"],
      ]);
      const written = await document.overlay(
        {
          values: [
            { field: "p1.b1", value: "Leo Ivanov" },
            { field: "p1.b2", value: "2016-03-02" },
          ],
          preview: true,
        },
        [font],
      );
      if ("refused" in written) throw new Error(`refused: ${written.refused}`);
      expect(written.fill).toMatchObject({
        filled: 2,
        readBack: [
          { field: "p1.b1", ok: true },
          { field: "p1.b2", ok: true },
        ],
        previewPages: [1],
      });
      expect(written.previews).toHaveLength(1);
      expect(overlayValues(await loadWriter(written.bytes)).get(1)).toEqual(["Leo Ivanov", "2016-03-02"]);
      // A second overlay on the copy finds only what is still empty: nothing is written over a value.
      const partial = await document.overlay({ values: [{ field: "p1.b1", value: "Leo Ivanov" }], preview: false }, [font]);
      if ("refused" in partial) throw new Error(`refused: ${partial.refused}`);
      const again = await open(partial.bytes);
      try {
        expect(again.boxes().map((box) => box.label)).toEqual(["Date of birth"]);
      } finally {
        again.close();
      }
    } finally {
      document.close();
    }
  });

  it("refuses an unknown box, a value too long for its box, and a form that has fields", async () => {
    const document = await open(await flatForm());
    try {
      expect(await document.overlay({ values: [{ field: "p1.b9", value: "Leo" }], preview: false }, [font])).toMatchObject({
        refused: "unknown-field",
        field: "p1.b9",
      });
      expect(
        await document.overlay(
          { values: [{ field: "p1.b2", value: "a value far too long to fit in this small box at any allowed size" }], preview: false },
          [font],
        ),
      ).toMatchObject({ refused: "bad-value", field: "p1.b2" });
    } finally {
      document.close();
    }
    const withFields = await PDFDocument.create({ updateMetadata: false });
    withFields
      .getForm()
      .createTextField("name")
      .addToPage(withFields.addPage([600, 800]), { x: 100, y: 700, width: 200, height: 20 });
    const fielded = await open(await withFields.save());
    try {
      expect(fielded.boxes()).toEqual([]);
      expect(await fielded.overlay({ values: [{ field: "p1.b1", value: "Leo" }], preview: false }, [font])).toMatchObject({
        refused: "has-fields",
      });
    } finally {
      fielded.close();
    }
  });
});
