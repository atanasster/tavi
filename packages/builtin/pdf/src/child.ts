import { PDF_FRAME, PdfChildRequestSchema, type PdfChildResponse } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { maxRssKb, writeStdout } from "./child-io.js";
import { PdfEngine, type Refused } from "./engine.js";
import { loadPdfium } from "./pdfium.js";
import { ChunkReader, encodeResponse, readInit, readRequest } from "./protocol.js";

/**
 * The parser child: compiles PDFium from the
 * wasm on stdin, waits for one request, answers it on stdout, and exits. It
 * opens no file and no socket; the owner bounds it.
 */

async function answer(
  json: PdfChildResponse,
  pngs: readonly { readonly page: number; readonly png: Uint8Array }[] = [],
  document: Uint8Array = new Uint8Array(0),
): Promise<void> {
  await writeStdout(encodeResponse(json, pngs, document));
}

const refusal = (refused: Refused): PdfChildResponse => ({
  ok: false,
  refused: refused.refused,
  ...(refused.field === undefined ? {} : { field: refused.field }),
  maxRssKb: maxRssKb(),
});

async function main(): Promise<void> {
  const reader = new ChunkReader();
  process.stdin.on("data", (chunk: Buffer) => reader.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)));
  process.stdin.on("end", () => reader.end());
  process.stdin.on("error", (error) => reader.end(error));
  const pdfium = await loadPdfium(await readInit(reader));
  const { header, document, fonts } = await readRequest(reader, PDF_FRAME.maxDocumentBytes);
  const request = PdfChildRequestSchema.parse(header);
  const engine = new PdfEngine(pdfium);
  const opened = await engine.open(document, request.limits, request.password);
  if ("refused" in opened) return answer(refusal(opened));
  try {
    const facts = opened.facts();
    const base = { ok: true as const, facts };
    switch (request.op) {
      case "facts":
        return await answer({ ...base, maxRssKb: maxRssKb() });
      case "read": {
        const read = opened.read(definedOnly({ pages: request.pages, find: request.find, format: request.format }));
        return await answer({
          ...base,
          pages: read.pages,
          ...(read.nextPage === undefined ? {} : { nextPage: read.nextPage }),
          truncated: read.truncated,
          ...(read.coverSpans.length === 0 ? {} : { coverSpans: read.coverSpans }),
          ...(read.coverUnchecked.length === 0 ? {} : { coverUnchecked: read.coverUnchecked }),
          maxRssKb: maxRssKb(),
        });
      }
      case "fields": {
        const { fields, truncated } = opened.fields();
        const boxes = fields.length === 0 ? opened.boxes() : [];
        return await answer({
          ...base,
          fields,
          truncated,
          ...(boxes.length === 0
            ? {}
            : {
                boxes: boxes.map((box) => ({
                  id: box.id,
                  page: box.page,
                  rect: [...box.rect],
                  ...(box.label === undefined ? {} : { label: box.label }),
                })),
              }),
          maxRssKb: maxRssKb(),
        });
      }
      case "render": {
        const pages = request.pages.filter((page) => page <= facts.pageCount);
        const rendered = opened.render(pages, { dpi: request.dpi, highlight: request.highlight, outlineUserOnly: request.outlineUserOnly });
        return await answer(
          { ...base, rendered: rendered.map(({ page, width, height }) => ({ page, width, height })), maxRssKb: maxRssKb() },
          rendered,
        );
      }
      case "fill":
      case "overlay": {
        const filled = request.op === "fill" ? await opened.fill(request.plan, fonts) : await opened.overlay(request.plan, fonts);
        if ("refused" in filled) return await answer(refusal(filled));
        return await answer(
          {
            ...base,
            fill: filled.fill,
            rendered: filled.previews.map(({ page, width, height }) => ({ page, width, height })),
            maxRssKb: maxRssKb(),
          },
          filled.previews,
          filled.bytes,
        );
      }
    }
  } finally {
    opened.close();
  }
}

main().then(
  () => process.exit(0),
  async () => {
    // Nothing of the document goes back: the owner reads "malformed" and the exit code.
    await answer({ ok: false, refused: "malformed", maxRssKb: maxRssKb() }).catch(() => undefined);
    process.exit(1);
  },
);
