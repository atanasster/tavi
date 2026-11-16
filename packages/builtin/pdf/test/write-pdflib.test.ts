import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PDFContentStream, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { PdfiumDocument } from "../src/read-pdfium.js";
import { embedFonts, fill, fingerprints, loadWriter, markChanged, saveWriter } from "../src/write-pdflib.js";
import { testPdfium } from "./support.js";

const font = new Uint8Array(readFileSync(join(import.meta.dirname, "..", "assets", "NotoSans-Regular.ttf")));

async function oneField(encrypt: boolean): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document
    .getForm()
    .createTextField("name")
    .addToPage(document.addPage([600, 800]), { x: 100, y: 600, width: 200, height: 20 });
  if (encrypt)
    await document.encrypt({
      userPassword: "",
      ownerPassword: "owner",
      permissions: { fillingForms: true, annotating: true, modifying: false },
    });
  return document.save();
}

/** An incremental fill, as certified forms would use it. */
async function fillIncrementally(source: Uint8Array): Promise<Uint8Array> {
  const writer = await loadWriter(source, true);
  const snapshot = writer.document.takeSnapshot();
  const before = fingerprints(writer);
  expect(fill(writer, [{ field: "name", value: "Leo" }], await embedFonts(writer, [font]))).toEqual({ ok: true });
  markChanged(writer, snapshot, before);
  return saveWriter(writer, snapshot);
}

async function valueOf(bytes: Uint8Array): Promise<string | undefined> {
  const reader = PdfiumDocument.open(await testPdfium(), bytes);
  if (!(reader instanceof PdfiumDocument)) return undefined;
  try {
    return reader.widgets(10)[0]?.value;
  } finally {
    reader.close();
  }
}

describe("the incremental writer", () => {
  it("appends the changed objects after the original bytes, and the value reads back", async () => {
    const source = await oneField(false);
    const bytes = await fillIncrementally(source);
    expect(Buffer.from(bytes.subarray(0, source.length)).equals(Buffer.from(source))).toBe(true);
    expect(await valueOf(bytes)).toBe("Leo");
  });

  it("does not yet keep an encrypted document readable: the measurement that sends such forms to the answer sheet", async () => {
    // The fork drops `/Encrypt` from the update and encrypts streams only, never strings.
    // When this starts passing as "Leo", permissions-only forms can be filled in place.
    expect(await valueOf(await fillIncrementally(await oneField(true)))).not.toBe("Leo");
  });
});

describe("the writer's appearances", () => {
  async function form(build: (document: PDFDocument) => void): Promise<Awaited<ReturnType<typeof loadWriter>>> {
    const document = await PDFDocument.create({ updateMetadata: false });
    build(document);
    return loadWriter(await document.save());
  }

  const appearanceOf = (writer: Awaited<ReturnType<typeof loadWriter>>, field: string): string => {
    const normal = writer.document
      .getForm()
      .getField(field)
      .acroField.getWidgets()[0]
      ?.dict.lookup(PDFName.of("AP"), PDFDict)
      .lookup(PDFName.of("N"));
    if (!(normal instanceof PDFRawStream) && !(normal instanceof PDFContentStream)) throw new Error("no appearance");
    return new TextDecoder("latin1").decode(
      normal instanceof PDFRawStream ? decodePDFRawStream(normal).decode() : normal.getUnencodedContents(),
    );
  };
  const sizeIn = (appearance: string): number => Number(/([\d.]+) Tf/.exec(appearance)?.[1]);

  it("fills a field whose /DA is on its widget alone", async () => {
    const writer = await form((document) => {
      const field = document.getForm().createTextField("name");
      field.addToPage(document.addPage([600, 800]), { x: 100, y: 600, width: 200, height: 20 });
      const appearance = field.acroField.getDefaultAppearance() ?? "";
      field.acroField.dict.delete(PDFName.of("DA"));
      field.acroField.getWidgets()[0]?.setDefaultAppearance(appearance);
    });
    expect(fill(writer, [{ field: "name", value: "Leo" }], await embedFonts(writer, [font]))).toEqual({ ok: true });
    expect(await valueOf(await saveWriter(writer, undefined))).toBe("Leo");
  });

  it("keeps a line inside its box: descenders in, a long value narrowed, a comb glyph per cell", async () => {
    const writer = await form((document) => {
      const page = document.addPage([600, 800]);
      document.getForm().createTextField("short").addToPage(page, { x: 100, y: 600, width: 200, height: 20 });
      document.getForm().createTextField("long").addToPage(page, { x: 100, y: 500, width: 120, height: 20 });
      const comb = document.getForm().createTextField("comb");
      comb.setMaxLength(9);
      comb.enableCombing();
      comb.addToPage(page, { x: 100, y: 400, width: 270, height: 24 });
    });
    const fonts = await embedFonts(writer, [font]);
    const long = "Bartholomew Montgomery-Featherstonehaugh";
    expect(
      fill(
        writer,
        [
          { field: "short", value: "gyp" },
          { field: "long", value: long },
          { field: "comb", value: "123456789" },
        ],
        fonts,
      ),
    ).toEqual({ ok: true });
    const noto = fonts[0]?.font;
    if (noto === undefined) throw new Error("no font");
    const ascent = noto.heightAtSize(1, { descender: false });
    const descent = noto.heightAtSize(1) - ascent;
    // pdf-lib centres on the ascender: the descender stays in the inner box (the widget less 4 points) when
    // size ≤ (inner / 2 − 0.5) / (a/2 + d). pdf-lib widens a bordered widget's rectangle by its border.
    const heightOf = (field: string): number =>
      writer.document.getForm().getField(field).acroField.getWidgets()[0]?.getRectangle().height ?? 0;
    const widthOf = (field: string): number =>
      writer.document.getForm().getField(field).acroField.getWidgets()[0]?.getRectangle().width ?? 0;
    expect(sizeIn(appearanceOf(writer, "short"))).toBeLessThanOrEqual(((heightOf("short") - 4) / 2 - 0.5) / (ascent / 2 + descent));
    expect(noto.widthOfTextAtSize(long, sizeIn(appearanceOf(writer, "long")))).toBeLessThanOrEqual(widthOf("long") - 4);
    const cells = new Set([...appearanceOf(writer, "comb").matchAll(/1 0 0 1 (-?[\d.]+) -?[\d.]+ Tm/g)].map((match) => match[1]));
    expect(cells.size).toBe(9);
  });

  it("writes a choice's export values, its option indices, and draws its display strings", async () => {
    const writer = await form((document) => {
      const page = document.addPage([600, 800]);
      const grade = document.getForm().createDropdown("grade");
      grade.addToPage(page, { x: 100, y: 600, width: 150, height: 20 });
      grade.acroField.setOptions([
        { value: PDFString.of("K"), display: PDFString.of("Kindergarten") },
        { value: PDFString.of("1"), display: PDFString.of("Grade 1") },
      ]);
      const allergies = document.getForm().createOptionList("allergies");
      allergies.addOptions(["Peanuts", "Pollen", "None"]);
      allergies.enableMultiselect();
      allergies.addToPage(page, { x: 100, y: 500, width: 150, height: 60 });
    });
    const fonts = await embedFonts(writer, [font]);
    expect(
      fill(
        writer,
        [
          { field: "grade", value: "1" },
          { field: "allergies", value: ["None", "Peanuts"] },
        ],
        fonts,
      ),
    ).toEqual({ ok: true });
    const grade = writer.document.getForm().getDropdown("grade").acroField;
    expect(grade.dict.lookup(PDFName.of("V"))?.toString()).toBe("(1)");
    const encoded = fonts[0]?.font.encodeText("Grade 1").toString() ?? "";
    expect(appearanceOf(writer, "grade")).toContain(encoded);
    const allergies = writer.document.getForm().getOptionList("allergies").acroField;
    expect(allergies.dict.lookup(PDFName.of("I"))?.toString()).toBe("[ 0 2 ]");
  });
});
