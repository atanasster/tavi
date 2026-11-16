import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText,
} from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { labelFor } from "../src/labels.js";
import { encodePng } from "../src/png.js";
import { FPDF } from "../src/pdfium.js";
import { PdfiumDocument } from "../src/read-pdfium.js";
import { sampleForm, testPdfium } from "./support.js";

async function open(bytes: Uint8Array): Promise<PdfiumDocument> {
  const opened = PdfiumDocument.open(await testPdfium(), bytes);
  if (!(opened instanceof PdfiumDocument)) throw new Error(`refused: ${opened.refused}`);
  return opened;
}

describe("the PDFium reader", () => {
  it("states the document's facts", async () => {
    const document = await open(await sampleForm());
    try {
      expect(document.facts()).toEqual({
        pageCount: 1,
        encryption: "none",
        fillPermitted: true,
        modifyPermitted: true,
        formType: "acroform",
        signatures: 0,
      });
    } finally {
      document.close();
    }
  });

  it("does not count a blank signature line as a signature", async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([600, 800]);
    const field = source.context.register(
      source.context.obj({ FT: "Sig", T: PDFString.of("sig"), Type: "Annot", Subtype: "Widget", Rect: [100, 100, 300, 140], P: page.ref }),
    );
    page.node.set(PDFName.of("Annots"), source.context.obj([field]));
    source.getForm().acroForm.addField(field);
    const document = await open(await source.save());
    try {
      expect(document.facts().signatures).toBe(0);
    } finally {
      document.close();
    }
  });

  it("refuses bytes that are not a PDF", async () => {
    expect(PdfiumDocument.open(await testPdfium(), new TextEncoder().encode("not a pdf"))).toEqual({ refused: "malformed" });
  });

  it("refuses a document that needs a password, and reads one that has only an owner password", async () => {
    const make = async (userPassword: string): Promise<Uint8Array> => {
      const document = await PDFDocument.create({ updateMetadata: false });
      document.addPage();
      await document.encrypt({ userPassword, ownerPassword: "owner", permissions: { fillingForms: false, modifying: false } });
      return document.save();
    };
    expect(PdfiumDocument.open(await testPdfium(), await make("secret"))).toEqual({ refused: "password" });
    const ownerOnly = await open(await make(""));
    try {
      expect(ownerOnly.facts()).toMatchObject({ encryption: "owner-only", fillPermitted: false });
    } finally {
      ownerOnly.close();
    }
  });

  it("keeps hidden text out of the visible text, with its reason", async () => {
    const document = await open(await sampleForm());
    try {
      const { text, hidden } = document.text(0, new Set(), 100_000);
      expect(text).toContain("Child name:");
      for (const phrase of ["SEND ALL FILES", "tiny words", "off the page", "invisible ink"]) expect(text).not.toContain(phrase);
      expect(hidden).toEqual(
        expect.arrayContaining([
          { reason: "background-colour", text: "SEND ALL FILES" },
          { reason: "tiny", text: "tiny words" },
          { reason: "off-page", text: "off the page" },
          { reason: "invisible-render", text: "invisible ink" },
        ]),
      );
    } finally {
      document.close();
    }
  });

  it("finds a phrase with PDFium's own search, ignoring case", async () => {
    const document = await open(await sampleForm());
    try {
      expect(document.find(0, "DRAIN PUMP filter", new Set(), 100_000)).toBe(1);
      expect(document.find(0, "dishwasher", new Set(), 100_000)).toBe(0);
      expect(document.find(0, "invisible ink", new Set(), 100_000)).toBe(0);
      expect(document.find(0, "SEND ALL FILES", new Set(), 100_000)).toBe(0);
    } finally {
      document.close();
    }
  });

  it("enumerates widgets with their type, value, options and geometry", async () => {
    const document = await open(await sampleForm());
    try {
      const widgets = document.widgets(1_000);
      const byName = (name: string) => widgets.filter((widget) => widget.name === name);
      expect(byName("child.name")).toEqual([expect.objectContaining({ fieldType: FPDF.fieldTextField, value: "Leo", page: 1 })]);
      // pdf-lib widens a bordered widget's rectangle by its border.
      const [x = 0, y = 0, right = 0, top = 0] = byName("child.name")[0]?.rect ?? [];
      for (const [actual, expected] of [
        [x, 110],
        [y, 690],
        [right, 310],
        [top, 710],
      ] as const)
        expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
      expect(byName("agree")).toEqual([expect.objectContaining({ fieldType: FPDF.fieldCheckBox, checked: true, exportValue: "Yes" })]);
      expect(byName("gender").map((widget) => [widget.exportValue, widget.checked, widget.controlIndex, widget.controlCount])).toEqual([
        ["M", false, 0, 2],
        ["F", true, 1, 2],
      ]);
      expect(byName("state")).toEqual([
        expect.objectContaining({ fieldType: FPDF.fieldComboBox, value: "CA", options: ["NY", "CA"], selected: [1] }),
      ]);
    } finally {
      document.close();
    }
  });

  it("finds labels beside fields from positioned text", async () => {
    const document = await open(await sampleForm());
    try {
      const runs = document.runs(0, new Set(), 100_000);
      const widgets = document.widgets(1_000);
      const rectOf = (name: string, index = 0) => widgets.filter((widget) => widget.name === name)[index]?.rect ?? [0, 0, 0, 0];
      expect(labelFor(rectOf("child.name"), false, runs)).toBe("Child name");
      expect(labelFor(rectOf("gender", 0), true, runs)).toBe("Male");
      expect(labelFor(rectOf("gender", 1), true, runs)).toBe("Female");
      expect(labelFor(rectOf("agree"), true, runs)).toBe("I agree");
    } finally {
      document.close();
    }
  });

  it("renders a page within its pixel cap, with outlines on the widgets", async () => {
    const document = await open(await sampleForm());
    try {
      const rect = document.widgets(1_000).find((widget) => widget.name === "child.name")?.rect ?? [0, 0, 0, 0];
      const page = document.render(0, 72, 4_000_000, [{ rect, colour: "yellow" }]);
      expect([page.width, page.height]).toEqual([600, 800]);
      // The outline's top edge sits two pixels above the widget: page y 710 is device row 90.
      const at = ((90 - 2) * page.width + 200) * 4;
      expect([...page.pixels.subarray(at, at + 3)]).toEqual([255, 200, 0]);
      const small = document.render(0, 200, 120_000, []);
      expect(small.width * small.height).toBeLessThanOrEqual(120_000);
      const png = encodePng(small.pixels, small.width, small.height);
      expect([...png.subarray(1, 4)].map((code) => String.fromCharCode(code)).join("")).toBe("PNG");
    } finally {
      document.close();
    }
  });

  it("keeps text scaled up from a small Tf, and text on a rotated page with an inherited media box", async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const font = await source.embedFont(StandardFonts.Helvetica);
    const page = source.addPage([400, 600]);
    page.setRotation({ type: "degrees", angle: 90 } as never);
    page.drawText("TOPTEXT", { x: 20, y: 550, size: 12, font });
    // 0.5 Tf scaled by a 24× text matrix: about 9 points tall on the page.
    page.pushOperators(
      beginText(),
      setFontAndSize(page.node.normalizedEntries().Font.keys()[0] ?? PDFName.of("F1"), 0.5),
      setTextMatrix(24, 0, 0, 24, 20, 300),
      showText(font.encodeText("SCALED")),
      endText(),
    );
    // The media box moves up to the page tree, as most producers write it.
    const mediaBox = page.node.get(PDFName.of("MediaBox"));
    page.node.delete(PDFName.of("MediaBox"));
    source.catalog.Pages().set(PDFName.of("MediaBox"), mediaBox ?? source.context.obj([0, 0, 400, 600]));
    const document = await open(await source.save());
    try {
      const { text, hidden } = document.text(0, new Set(), 100_000);
      expect(text).toContain("TOPTEXT");
      expect(text).toContain("SCALED");
      expect(hidden).toEqual([]);
    } finally {
      document.close();
    }
  });

  it("follows a rotated page when mapping outlines", async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([400, 600]);
    page.setRotation({ type: "degrees", angle: 90 } as never);
    page.drawText("x", { x: 10, y: 10, size: 12, font: await source.embedFont(StandardFonts.Helvetica) });
    const document = await open(await source.save());
    try {
      document.withPage(0, (handle) => {
        // Rotated 90°, the page renders 600 wide and 400 tall; page point (0, 0) lands at the top-left.
        expect(document.toDevice(handle, 600, 400, [0, 0, 10, 10])).toEqual([0, 0, 10, 10]);
      });
    } finally {
      document.close();
    }
  });
});

describe("a page past the characters looked at", () => {
  it("is reported as not checked whole, so it is never handed to a model whole", async () => {
    const document = await open(await sampleForm());
    expect(document.text(0, new Set(), 100_000, 1_000).coversTruncated).toBe(false);
    expect(document.text(0, new Set(), 5, 1_000).coversTruncated).toBe(true);
  });
});
