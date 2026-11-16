import { type PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { activeContent, loadWriter, sanitize } from "../src/write-pdflib.js";

/** A document carrying each kind of active content the sanitiser strips. */
async function armed(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([600, 800]);
  const context = document.context;
  const js = (code: string) => context.obj({ S: "JavaScript", JS: PDFString.of(code) });
  document.setAuthor("Sender Name");
  document.setProducer("Sender Tool");
  document.setCreator("Sender App");
  // An opening GoTo that chains to a script.
  document.catalog.set(PDFName.of("OpenAction"), context.obj({ S: "GoTo", D: [page.ref, "Fit"], Next: js("app.alert(1)") }));
  page.node.set(PDFName.of("AA"), context.obj({ O: js("open page") }));
  const field = document.getForm().createTextField("name");
  field.addToPage(page, { x: 100, y: 600, width: 200, height: 20 });
  field.acroField.getWidgets()[0]?.dict.set(PDFName.of("AA"), context.obj({ K: js("keystroke") }));
  const annots = page.node.Annots() ?? context.obj([]);
  const annot = (dict: Record<string, unknown>) =>
    annots.push(context.register(context.obj({ Type: "Annot", Rect: [0, 0, 10, 10], ...dict } as never)));
  annot({ Subtype: "Link", A: { S: "Launch", F: PDFString.of("calc.exe") } });
  annot({ Subtype: "Link", A: { S: "URI", URI: PDFString.of("https://example.com") } });
  annot({ Subtype: "FileAttachment", FS: { Type: "Filespec", F: PDFString.of("evil.exe") } });
  if (page.node.Annots() === undefined) page.node.set(PDFName.of("Annots"), annots);
  const outlines = context.obj({ Type: "Outlines" });
  const item = context.obj({ Title: PDFString.of("Start"), Parent: outlines, A: js("outline") });
  outlines.set(PDFName.of("First"), context.register(item));
  outlines.set(PDFName.of("Last"), context.register(item));
  document.catalog.set(PDFName.of("Outlines"), context.register(outlines));
  return document.save();
}

describe("the sanitiser", () => {
  it("finds every kind of active content, through /Next chains", async () => {
    expect(activeContent(await loadWriter(await armed()))).toEqual([
      "additional-actions",
      "embedded-file",
      "javascript",
      "launch",
      "open-action",
      "uri",
    ]);
  });

  it("strips all of it but links, and neutralises who made the file", async () => {
    const writer = await loadWriter(await armed());
    sanitize(writer);
    const saved = await loadWriter(await writer.document.save());
    expect(activeContent(saved)).toEqual(["uri"]);
    expect(saved.document.catalog.has(PDFName.of("OpenAction"))).toBe(false);
    expect([saved.document.getAuthor(), saved.document.getProducer(), saved.document.getCreator()]).toEqual(["", "", ""]);
    const annots = saved.document.getPage(0).node.Annots() as PDFArray;
    const subtypes = annots.asArray().map((ref) => (saved.document.context.lookup(ref) as PDFDict).get(PDFName.of("Subtype"))?.toString());
    expect(subtypes).not.toContain("/FileAttachment");
  });

  it("drops an XFA hybrid's XFA layer, so the copy is a plain fillable form", async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([600, 800]);
    document.getForm().createTextField("name").addToPage(page, { x: 100, y: 600, width: 200, height: 20 });
    const writer = await loadWriter(await document.save());
    const loaded = writer.document;
    const packet = loaded.context.register(loaded.context.stream('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><template/>'));
    loaded.catalog.lookup(PDFName.of("AcroForm"), PDFDict).set(PDFName.of("XFA"), loaded.context.obj([PDFString.of("template"), packet]));
    loaded.catalog.set(PDFName.of("NeedsRendering"), loaded.context.obj(true));
    expect(activeContent(writer)).toContain("xfa");
    sanitize(writer);
    expect(activeContent(writer)).not.toContain("xfa");
    expect(writer.document.catalog.has(PDFName.of("NeedsRendering"))).toBe(false);
    // The packet itself is gone, not only the key: the saved copy never carries it.
    expect(loaded.context.lookup(packet)).toBeUndefined();
    expect(Buffer.from(await loaded.save()).toString("latin1")).not.toContain("DOCTYPE");
  });
});
