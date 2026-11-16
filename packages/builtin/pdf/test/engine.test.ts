import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, PDFName, PDFString, StandardFonts } from "@cantoo/pdf-lib";
import type { PdfChildLimits } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { PdfEngine, type OpenedDocument } from "../src/engine.js";
import { PdfiumDocument } from "../src/read-pdfium.js";
import { activeContent, loadWriter } from "../src/write-pdflib.js";
import { sampleForm, testPdfium } from "./support.js";

const limits: PdfChildLimits = { maxPages: 500, maxFields: 1_000, maxPixelsPerPage: 4_000_000, textPerCall: 40_000, pagesPerTextCall: 40 };
const font = new Uint8Array(readFileSync(join(import.meta.dirname, "..", "assets", "NotoSans-Regular.ttf")));

async function open(bytes: Uint8Array, given: PdfChildLimits = limits): Promise<OpenedDocument> {
  const opened = await new PdfEngine(await testPdfium()).open(bytes, given);
  if ("refused" in opened) throw new Error(`refused: ${opened.refused}`);
  return opened;
}

/** A form with a signature line, an attestation, a sensitive field, a tooltip and active content. */
async function packet(options: { readonly encrypt?: { readonly fillingForms: boolean } } = {}): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([600, 800]);
  const helvetica = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Registration 2026", { x: 30, y: 760, size: 14, font: helvetica });
  page.drawText("Date of birth", { x: 30, y: 705, size: 12, font: helvetica });
  page.drawText("Parent signature", { x: 30, y: 605, size: 12, font: helvetica });
  page.drawText("I certify the above is true", { x: 125, y: 555, size: 12, font: helvetica });
  const form = document.getForm();
  const dob = form.createTextField("patient_dob");
  dob.addToPage(page, { x: 130, y: 700, width: 150, height: 20 });
  const name = form.createTextField("child.full");
  name.addToPage(page, { x: 130, y: 650, width: 250, height: 20 });
  name.acroField.dict.set(PDFName.of("TU"), PDFString.of("Child's full name"));
  form.createTextField("f_sig").addToPage(page, { x: 160, y: 600, width: 200, height: 20 });
  form.createCheckBox("certify").addToPage(page, { x: 100, y: 553, width: 15, height: 15 });
  const hidden = form.createTextField("internal");
  hidden.addToPage(page, { x: 400, y: 50, width: 100, height: 20, hidden: true });
  document.addJavaScript("hello", "app.alert('hi')");
  document.catalog.set(PDFName.of("OpenAction"), document.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert(1)") }));
  if (options.encrypt !== undefined)
    await document.encrypt({
      userPassword: "",
      ownerPassword: "owner",
      permissions: { fillingForms: options.encrypt.fillingForms, modifying: false, annotating: options.encrypt.fillingForms },
    });
  return document.save();
}

describe("the PDF engine", () => {
  it("refuses bytes that are not a PDF, and a document longer than the page limit", async () => {
    const engine = new PdfEngine(await testPdfium());
    expect(await engine.open(new TextEncoder().encode("hello"), limits)).toEqual({ refused: "not-a-pdf" });
    const long = await PDFDocument.create({ updateMetadata: false });
    for (let index = 0; index < 3; index += 1) long.addPage();
    expect(await engine.open(await long.save(), { ...limits, maxPages: 2 })).toEqual({ refused: "too-many-pages" });
  });

  it("states facts with the document's active content", async () => {
    const document = await open(await packet());
    try {
      expect(document.facts()).toMatchObject({ pageCount: 1, form: "acroform", fieldCount: 5, encryption: "none", fillPermitted: true });
      expect(document.facts().activeContent).toEqual(["javascript", "open-action"]);
      expect(document.facts().sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      document.close();
    }
  });

  it("reads within the character budget and says where to go on", async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const helvetica = await source.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < 3; index += 1)
      source.addPage().drawText(`page ${index + 1} ${"word ".repeat(20)}`, { x: 20, y: 700, size: 10, font: helvetica });
    const document = await open(await source.save(), { ...limits, textPerCall: 150 });
    try {
      const first = document.read({});
      expect(first.pages.map((page) => page.page)).toEqual([1, 2]);
      expect(first.truncated).toBe(true);
      expect(first.nextPage).toBe(3);
      expect(document.read({ pages: "3" }).pages[0]?.text).toContain("page 3");
      expect(document.read({ find: "PAGE 2" }).pages.map((page) => page.page)).toEqual([2]);
    } finally {
      document.close();
    }
  });

  it("lists fields with labels, options and what Tavi will not fill", async () => {
    const document = await open(await packet());
    try {
      const fields = new Map(document.fields().fields.map((field) => [field.id, field]));
      expect(fields.get("patient_dob")).toMatchObject({ type: "text", label: "Date of birth", sensitive: ["birth-date"] });
      expect(fields.get("child.full")).toMatchObject({ label: "Child's full name" });
      expect(fields.get("f_sig")).toMatchObject({ label: "Parent signature", userOnly: "signature-like" });
      expect(fields.get("certify")).toMatchObject({ type: "checkbox", userOnly: "attestation", onValue: "Yes" });
      expect(fields.get("internal")).toMatchObject({ hidden: true });
    } finally {
      document.close();
    }
    const sample = await open(await sampleForm());
    try {
      const gender = sample.fields().fields.find((field) => field.id === "gender");
      expect(gender).toMatchObject({
        label: "Gender",
        value: "1",
        widgets: 2,
        options: [
          { value: "0", shown: "M", shownFrom: "opt" },
          { value: "1", shown: "F", shownFrom: "opt" },
        ],
      });
    } finally {
      sample.close();
    }
  });

  it("fills Latin, Cyrillic and Greek values, strips active content, and reads every value back", async () => {
    const document = await open(await packet());
    try {
      const filled = await document.fill(
        {
          values: [
            { field: "patient_dob", value: "2016-03-02" },
            { field: "child.full", value: "Лео Ωmega Müller" },
          ],
          preview: true,
        },
        [font],
      );
      if ("refused" in filled) throw new Error(`refused: ${filled.refused}`);
      expect(filled.fill).toMatchObject({
        filled: 2,
        incremental: false,
        answerSheet: false,
        previewPages: [1],
        leftUserOnly: ["f_sig", "certify"],
      });
      expect(filled.fill.readBack.every((row) => row.ok)).toBe(true);
      expect(activeContent(await loadWriter(filled.bytes))).toEqual([]);
      const reread = PdfiumDocument.open(await testPdfium(), filled.bytes) as PdfiumDocument;
      try {
        expect(reread.widgets(100).find((widget) => widget.name === "child.full")?.value).toBe("Лео Ωmega Müller");
      } finally {
        reread.close();
      }
      const [preview] = filled.previews;
      expect(preview?.page).toBe(1);
      expect([...(preview?.png.subarray(1, 4) ?? [])].map((code) => String.fromCharCode(code)).join("")).toBe("PNG");
    } finally {
      document.close();
    }
  });

  it("refuses user-only, hidden, unknown and ill-typed values, and a document quote the page does not show", async () => {
    const document = await open(await packet());
    try {
      const attempt = (field: string, value: string | boolean, documentQuote?: { page: number; quote: string }) =>
        document.fill({ values: [{ field, value, ...(documentQuote === undefined ? {} : { documentQuote }) }], preview: false }, [font]);
      expect(await attempt("f_sig", "Jane Doe")).toEqual({ refused: "user-only-field", field: "f_sig" });
      expect(await attempt("certify", true)).toEqual({ refused: "user-only-field", field: "certify" });
      expect(await attempt("internal", "x")).toEqual({ refused: "locked-field", field: "internal" });
      expect(await attempt("nope", "x")).toEqual({ refused: "unknown-field", field: "nope" });
      expect(await attempt("patient_dob", true)).toEqual({ refused: "bad-value", field: "patient_dob" });
      expect(await attempt("child.full", "Registration", { page: 1, quote: "Not on the page" })).toEqual({
        refused: "document-quote",
        field: "child.full",
      });
      expect(await attempt("child.full", "Registration 2026", { page: 1, quote: "Registration 2026" })).not.toHaveProperty("refused");
    } finally {
      document.close();
    }
  });

  it("joins radio states to widgets by control index, whatever the page's annotation order", async () => {
    const source = await PDFDocument.load(await sampleForm(), { updateMetadata: false });
    const annots = source.getPage(0).node.Annots();
    const refs = annots?.asArray() ?? [];
    source.getPage(0).node.set(PDFName.of("Annots"), source.context.obj(refs.reverse()));
    const document = await open(await source.save());
    try {
      expect(document.fields().fields.find((field) => field.id === "gender")).toMatchObject({
        value: "1",
        options: [
          { value: "0", shown: "M" },
          { value: "1", shown: "F" },
        ],
      });
      const filled = await document.fill({ values: [{ field: "gender", value: "0" }], preview: false }, [font]);
      expect("refused" in filled ? filled : filled.fill.readBack).toEqual([{ field: "gender", ok: true }]);
    } finally {
      document.close();
    }
  });

  it("fills a list box and ticks a checkbox", async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([600, 800]);
    const list = source.getForm().createOptionList("allergies");
    list.addOptions(["Peanuts", "Pollen", "None"]);
    list.enableMultiselect();
    list.addToPage(page, { x: 100, y: 600, width: 150, height: 60 });
    source.getForm().createCheckBox("asthma").addToPage(page, { x: 100, y: 500, width: 15, height: 15 });
    const document = await open(await source.save());
    try {
      const filled = await document.fill(
        {
          values: [
            { field: "allergies", value: ["Peanuts", "Pollen"] },
            { field: "asthma", value: true },
          ],
          preview: false,
        },
        [font],
      );
      expect("refused" in filled ? filled : filled.fill.readBack).toEqual([
        { field: "allergies", ok: true },
        { field: "asthma", ok: true },
      ]);
    } finally {
      document.close();
    }
  });

  it("says a font is missing rather than that the value is wrong", async () => {
    const document = await open(await packet());
    try {
      expect(await document.fill({ values: [{ field: "child.full", value: "李雷" }], preview: false }, [font])).toEqual({
        refused: "font-missing",
        field: "child.full",
      });
    } finally {
      document.close();
    }
  });

  it("fills a radio group by its state and a dropdown by its export", async () => {
    const document = await open(await sampleForm());
    try {
      expect(await document.fill({ values: [{ field: "gender", value: "M" }], preview: false }, [font])).toEqual({
        refused: "bad-value",
        field: "gender",
      });
      const filled = await document.fill(
        {
          values: [
            { field: "gender", value: "0" },
            { field: "state", value: "NY" },
            { field: "agree", value: false },
          ],
          preview: false,
        },
        [font],
      );
      if ("refused" in filled) throw new Error(`refused: ${filled.refused}`);
      expect(filled.fill.readBack).toEqual([
        { field: "gender", ok: true },
        { field: "state", ok: true },
        { field: "agree", ok: true },
      ]);
    } finally {
      document.close();
    }
  });

  it("answers a permissions-only encrypted form with an answer sheet, filling granted or not", async () => {
    for (const fillingForms of [true, false]) {
      const document = await open(await packet({ encrypt: { fillingForms } }));
      try {
        expect(document.facts()).toMatchObject({ encryption: "owner-only", fillPermitted: fillingForms });
        const filled = await document.fill({ values: [{ field: "child.full", value: "Leo" }], preview: false }, [font]);
        if ("refused" in filled) throw new Error(`refused: ${filled.refused}`);
        expect(filled.fill).toMatchObject({ answerSheet: true, incremental: false });
      } finally {
        document.close();
      }
    }
  });

  it("writes an answer sheet listing each field and value", async () => {
    const document = await open(await packet({ encrypt: { fillingForms: false } }));
    try {
      const long = `Leo ${"of the long name ".repeat(12)}end`;
      const filled = await document.fill(
        {
          values: [
            { field: "child.full", value: long },
            { field: "patient_dob", value: "2016-03-02" },
          ],
          preview: false,
        },
        [font],
      );
      if ("refused" in filled) throw new Error(`refused: ${filled.refused}`);
      expect(filled.fill.answerSheet).toBe(true);
      const sheet = await open(filled.bytes);
      try {
        const text = sheet.read({}).pages[0]?.text ?? "";
        expect(text).toContain("Child's full name (child.full)");
        expect(text).toContain("Leo");
        expect(text.replace(/\s+/g, " ")).toContain(" end");
        expect(text).toContain("2016-03-02");
      } finally {
        sheet.close();
      }
    } finally {
      document.close();
    }
  });
});
