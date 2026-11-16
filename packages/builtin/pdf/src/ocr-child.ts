import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";

import { PDF_LIMITS, PdfOcrRequestSchema, type PdfOcrPage, type PdfOcrResponse } from "@tavi/contracts";

import { maxRssKb, writeStdout } from "./child-io.js";
import { ChunkReader, encodeResponse, readOcrRequest } from "./protocol.js";

/**
 * The OCR child: a second single-use process,
 * apart from the PDFium child so the reader's memory cap and measurements stay
 * its own. It loads Tesseract from the OCR add-on's files (their paths are
 * its arguments; it never looks the add-on up), reads one request of page images on stdin, answers
 * each page's text on stdout, and exits. It opens no socket.
 */

/** Tesseract's LSTM engine, the only one the add-on's build has. */
const OEM_LSTM_ONLY = 1;

interface TessApi {
  Init(path: string, language: string, oem: number): number;
  SetImageFile(exif: number, angle: number): number;
  Recognize(monitor: null): number;
  GetUTF8Text(): string;
  MeanTextConf(): number;
  Clear(): void;
  End(): void;
}
interface TessCore {
  readonly FS: { writeFile(path: string, data: Uint8Array): void; unlink(path: string): void };
  readonly TessBaseAPI: new () => TessApi;
}

const answer = (json: PdfOcrResponse): Promise<void> => writeStdout(encodeResponse(json, [], new Uint8Array(0)));

async function main(): Promise<void> {
  // The add-on's files, as the owner was handed them (`PdfOcrAssets`): its glue, its WASM, its English model.
  const [corePath, wasmPath, engPath] = process.argv.slice(2);
  if (corePath === undefined || wasmPath === undefined || engPath === undefined) throw new Error("no add-on files");
  const reader = new ChunkReader();
  process.stdin.on("data", (chunk: Buffer) => reader.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)));
  process.stdin.on("end", () => reader.end());
  process.stdin.on("error", (error) => reader.end(error));
  const { header, images } = await readOcrRequest(reader);
  const request = PdfOcrRequestSchema.parse(header);
  if (images.length !== request.pages.length) throw new Error("the images do not match the pages named");
  const factory = createRequire(import.meta.url)(corePath) as (options: Record<string, unknown>) => Promise<TessCore>;
  // The wasm is handed over: the glue reads and fetches nothing itself.
  const core = await factory({
    wasmBinary: readFileSync(wasmPath),
    locateFile: (name: string) => name,
    print: () => undefined,
    printErr: () => undefined,
  });
  core.FS.writeFile(`/${request.language}.traineddata`, gunzipSync(readFileSync(engPath)));
  const api = new core.TessBaseAPI();
  if (api.Init("/", request.language, OEM_LSTM_ONLY) !== 0) throw new Error("Tesseract did not start");
  const pages: PdfOcrPage[] = [];
  // One call's text is one read's budget, across its pages.
  let budget = PDF_LIMITS.textPerCall;
  try {
    for (const image of images) {
      core.FS.writeFile("/input", image.png);
      // 1: no EXIF rotation; 0: no further angle.
      if (api.SetImageFile(1, 0) !== 0) return await answer({ ok: false, refused: "unreadable-image", maxRssKb: maxRssKb() });
      api.Recognize(null);
      const text = api.GetUTF8Text().slice(0, budget);
      budget -= text.length;
      pages.push({ page: image.page, text, confidence: Math.max(0, Math.min(100, api.MeanTextConf())) });
      api.Clear();
    }
  } finally {
    api.End();
  }
  await answer({ ok: true, pages, maxRssKb: maxRssKb() });
}

main().then(
  () => process.exit(0),
  () => {
    // Nothing of the images goes back: the owner reads the exit code and no answer.
    process.exit(1);
  },
);
