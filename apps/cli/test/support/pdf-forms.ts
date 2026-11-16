import { createHash } from "node:crypto";

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import type { ScriptedTurn } from "@tavi/test-support/fakes";

/** A one-page registration form: a child's name and date of birth. */
export async function registrationForm(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([600, 800]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Child name:", { x: 30, y: 695, size: 12, font });
  page.drawText("Date of birth:", { x: 30, y: 655, size: 12, font });
  const fields = document.getForm();
  fields.createTextField("child.name").addToPage(page, { x: 130, y: 690, width: 200, height: 20 });
  fields.createTextField("child.dob").addToPage(page, { x: 130, y: 650, width: 200, height: 20 });
  return document.save();
}

/**
 * A scripted model's turns that read `form`'s fields and fill its name and
 * date of birth from the person's words. The PDF is named by an artifact
 * stored after the owner starts: set `source.artifactId` before the turn runs,
 * since the calls read their input when they are made.
 */
export function pdfFillTurns(
  form: Uint8Array,
  dobQuote: string,
): { readonly turns: ScriptedTurn[]; readonly source: { artifactId?: string } } {
  const source: { artifactId?: string } = {};
  const sourceSha256 = createHash("sha256").update(form).digest("hex");
  const values = [
    { field: "child.name", value: "Leo Ivanov", source: { kind: "person", quote: "Leo Ivanov" } },
    { field: "child.dob", value: "2016-03-04", source: { kind: "person", quote: dobQuote } },
  ];
  return {
    source,
    turns: [
      { toolCall: { id: "f1", name: "pdf.fields", input: { source } } },
      { toolCall: { id: "f2", name: "pdf.fill", input: { source, sourceSha256, values } } },
      { text: "filled" },
    ],
  };
}
