import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from "@cantoo/pdf-lib";
import type { PdfChildLimits } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { PdfEngine, type OpenedDocument } from "../src/engine.js";
import { testPdfium } from "./support.js";

/**
 * Signed and DocMDP P2/P3 forms: filled by an incremental update
 * after the signed bytes, never one a signature locks, never one whose active
 * content would have to go, and never a P1 certification.
 */

const limits: PdfChildLimits = { maxPages: 500, maxFields: 1_000, maxPixelsPerPage: 4_000_000, textPerCall: 40_000, pagesPerTextCall: 40 };
const font = new Uint8Array(readFileSync(join(import.meta.dirname, "..", "assets", "NotoSans-Regular.ttf")));

interface Options {
  readonly docMdp?: 1 | 2 | 3;
  readonly lock?: { readonly action: "All" | "Include" | "Exclude"; readonly fields?: readonly string[]; readonly p?: 1 | 2 };
  readonly script?: boolean;
}

/** A form with `name` and `email` and a signed signature field. */
async function signedForm(options: Options = {}): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([600, 800]);
  const form = document.getForm();
  form.createTextField("name").addToPage(page, { x: 100, y: 700, width: 200, height: 20 });
  form.createTextField("email").addToPage(page, { x: 100, y: 660, width: 200, height: 20 });
  const context = document.context;
  const value = context.register(
    context.obj({
      Type: "Sig",
      Filter: "Adobe.PPKLite",
      SubFilter: "adbe.pkcs7.detached",
      ByteRange: [0, 0, 0, 0],
      Contents: PDFHexString.of("00".repeat(64)),
      ...(options.docMdp === undefined
        ? {}
        : {
            Reference: [
              { Type: "SigRef", TransformMethod: "DocMDP", TransformParams: { Type: "TransformParams", P: options.docMdp, V: "1.2" } },
            ],
          }),
    } as never),
  );
  const lock =
    options.lock === undefined
      ? {}
      : {
          Lock: {
            Type: "SigFieldLock",
            Action: options.lock.action,
            ...(options.lock.fields === undefined ? {} : { Fields: options.lock.fields.map((field) => PDFString.of(field)) }),
            ...(options.lock.p === undefined ? {} : { P: options.lock.p }),
          },
        };
  const field = context.register(
    context.obj({
      FT: "Sig",
      T: PDFString.of("signature"),
      Type: "Annot",
      Subtype: "Widget",
      Rect: [100, 600, 300, 640],
      F: 4,
      P: page.ref,
      V: value,
      ...lock,
    } as never),
  );
  const annots = page.node.Annots() ?? context.obj([]);
  annots.push(field);
  page.node.set(PDFName.of("Annots"), annots);
  form.acroForm.addField(field);
  form.acroForm.dict.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  if (options.docMdp !== undefined) document.catalog.set(PDFName.of("Perms"), context.obj({ DocMDP: value }));
  if (options.script === true)
    document.catalog.set(PDFName.of("OpenAction"), context.obj({ S: "JavaScript", JS: PDFString.of("app.alert(1)") }));
  return document.save();
}

async function open(bytes: Uint8Array): Promise<OpenedDocument> {
  const opened = await new PdfEngine(await testPdfium()).open(bytes, limits);
  if ("refused" in opened) throw new Error(`refused: ${opened.refused}`);
  return opened;
}

async function fillName(bytes: Uint8Array, field = "name"): Promise<Awaited<ReturnType<OpenedDocument["fill"]>>> {
  const document = await open(bytes);
  try {
    return await document.fill({ values: [{ field, value: "Leo" }], preview: false }, [font]);
  } finally {
    document.close();
  }
}

describe("filling a signed form", () => {
  it("appends the values after the signed bytes, keeping the signature and its certification", async () => {
    for (const docMdp of [undefined, 2, 3] as const) {
      const source = await signedForm(docMdp === undefined ? {} : { docMdp });
      const filled = await fillName(source);
      if ("refused" in filled) throw new Error(`refused: ${filled.refused}`);
      expect(filled.fill).toMatchObject({ incremental: true, readBack: [{ field: "name", ok: true }] });
      expect(Buffer.from(filled.bytes.subarray(0, source.length)).equals(Buffer.from(source))).toBe(true);
      const output = await open(filled.bytes);
      try {
        expect(output.facts()).toMatchObject({ signatures: 1, ...(docMdp === undefined ? {} : { certification: `P${docMdp}` }) });
      } finally {
        output.close();
      }
    }
  });

  it("refuses a P1 certification, a field the signature locks, and a signed form with scripts", async () => {
    expect(await fillName(await signedForm({ docMdp: 1 }))).toMatchObject({ refused: "certified" });
    expect(await fillName(await signedForm({ lock: { action: "Include", fields: ["name"] } }))).toMatchObject({
      refused: "locked-field",
      field: "name",
    });
    expect(await fillName(await signedForm({ lock: { action: "Include", fields: ["name"] } }), "email")).not.toHaveProperty("refused");
    expect(await fillName(await signedForm({ lock: { action: "Exclude", fields: ["email"] } }))).toMatchObject({ refused: "locked-field" });
    expect(await fillName(await signedForm({ lock: { action: "All" } }), "email")).toMatchObject({ refused: "locked-field" });
    expect(await fillName(await signedForm({ script: true }))).toMatchObject({ refused: "signed" });
    // PDF 2.0's `/P 1` on a lock: no change at all after it, whatever the lock lists.
    expect(await fillName(await signedForm({ lock: { action: "Include", fields: ["name"], p: 1 } }), "email")).toMatchObject({
      refused: "locked-field",
    });
    expect(await fillName(await signedForm({ lock: { action: "Include", fields: ["name"], p: 2 } }), "email")).not.toHaveProperty(
      "refused",
    );
  });
});
