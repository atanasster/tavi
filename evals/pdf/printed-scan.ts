// Makes evals/pdf/assets/printed-scan.png, the page image of the `scan-printed` fixture: PRINTED_TEXT set
// in Helvetica and rendered by the PDF parser at OCR resolution, as a scanner would give it. Run once, after
// `pnpm --filter @tavi/plugin-pdf build`: `node evals/pdf/printed-scan.ts`. The image is committed, so the
// fixture builds byte for byte the same without a child.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { createPdfService } from "@tavi/plugin-pdf/host";

const { PRINTED_TEXT } = (await import(new URL("./build-fixtures.ts", import.meta.url).href)) as typeof import("./build-fixtures.js");

const document = await PDFDocument.create({ updateMetadata: false });
// Half an A4 page: the image stays small, and the text the size a letter is printed at.
const page = document.addPage([595, 420]);
const font = await document.embedFont(StandardFonts.Helvetica);
PRINTED_TEXT.split("\n").forEach((line, index) => page.drawText(line, { x: 48, y: 380 - index * 18, size: 11, font }));
const service = createPdfService({ sandbox: { kind: "none" }, warm: false });
try {
  // 200 dpi: `PDF_LIMITS.ocrDpi`, what `pdf.read` renders a page at for OCR.
  const rendered = await service.run({ op: "render", pages: [1], dpi: 200, highlight: [], outlineUserOnly: false }, await document.save());
  if (!rendered.ok || rendered.pngs[0] === undefined) throw new Error(`the page did not render: ${JSON.stringify(rendered)}`);
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "assets", "printed-scan.png"), rendered.pngs[0].png);
} finally {
  await service.close();
}
