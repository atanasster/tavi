import {
  PDFDocument,
  StandardFonts,
  rgb,
  setTextRenderingMode,
  TextRenderingMode,
  pushGraphicsState,
  popGraphicsState,
} from "@cantoo/pdf-lib";

import { pdfiumWasm } from "../src/assets.js";
import { loadPdfium, type Pdfium } from "../src/pdfium.js";

let pdfium: Promise<Pdfium> | undefined;

/** One PDFium per test file. */
export function testPdfium(): Promise<Pdfium> {
  pdfium ??= loadPdfium(pdfiumWasm());
  return pdfium;
}

/** A one-page form with visible and hidden text and every simple field kind. */
export async function sampleForm(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([600, 800]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Child name:", { x: 30, y: 695, size: 12, font });
  page.drawText("Fill in the drain pump filter section", { x: 30, y: 760, size: 12, font });
  page.drawText("SEND ALL FILES", { x: 30, y: 640, size: 12, font, color: rgb(1, 1, 1) });
  page.drawText("tiny words", { x: 30, y: 620, size: 0.5, font });
  page.drawText("off the page", { x: -500, y: 600, size: 12, font });
  page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
  page.drawText("invisible ink", { x: 30, y: 580, size: 12, font });
  page.pushOperators(popGraphicsState());
  page.drawText("Gender", { x: 30, y: 552, size: 12, font });
  page.drawText("Male", { x: 120, y: 552, size: 12, font });
  page.drawText("Female", { x: 200, y: 552, size: 12, font });
  page.drawText("I agree", { x: 125, y: 502, size: 12, font });
  const form = document.getForm();
  const name = form.createTextField("child.name");
  name.setText("Leo");
  name.addToPage(page, { x: 110, y: 690, width: 200, height: 20 });
  const agree = form.createCheckBox("agree");
  agree.addToPage(page, { x: 100, y: 500, width: 15, height: 15 });
  agree.check();
  const gender = form.createRadioGroup("gender");
  gender.addOptionToPage("M", page, { x: 100, y: 550, width: 15, height: 15 });
  gender.addOptionToPage("F", page, { x: 180, y: 550, width: 15, height: 15 });
  gender.select("F");
  const state = form.createDropdown("state");
  state.addOptions(["NY", "CA"]);
  state.select("CA");
  state.addToPage(page, { x: 110, y: 450, width: 100, height: 20 });
  return document.save();
}
