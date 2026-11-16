import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The OCR add-on's files: Tesseract's WASM
 * build with the LSTM engine only (`tesseract.js-core`'s
 * `tesseract-core-simd-lstm`) and the English `best_int` model. The PDF
 * tools' OCR child reads them from this directory; nothing is fetched.
 */
export interface OcrAssets {
  /** The directory holding them: the OCR child is allowed to read it, and nothing else of the add-on. */
  readonly directory: string;
  /** Emscripten's glue, CommonJS. */
  readonly core: string;
  readonly wasm: string;
  /** `eng.traineddata`, gzipped. */
  readonly languages: { readonly eng: string };
}

/** The add-on's files: beside this module once built, or, run from source, in the package's `dist/`. */
export function ocrAssets(): OcrAssets {
  const beside = import.meta.dirname;
  const directory = existsSync(join(beside, CORE)) ? beside : join(beside, "..", "dist");
  return { directory, core: join(directory, CORE), wasm: join(directory, WASM), languages: { eng: join(directory, ENG) } };
}

export const CORE = "tesseract-core-simd-lstm.cjs";
export const WASM = "tesseract-core-simd-lstm.wasm";
export const ENG = "eng.traineddata.gz";
