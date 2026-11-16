import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * The bytes the parser child needs, read by the owner and handed to the child:
 * the child never resolves, fetches
 * or reads them itself, so "no network" holds of the code as well as of the
 * sandbox.
 */

const require = createRequire(import.meta.url);

/**
 * PDFium's wasm: beside the built modules in an install (the build copies it
 * into `dist/`, since `@embedpdf/pdfium` is bundled, not installed), else the
 * development dependency's.
 */
export function pdfiumWasmPath(): string {
  const built = join(import.meta.dirname, "pdfium.wasm");
  return existsSync(built) ? built : require.resolve("@embedpdf/pdfium/pdfium.wasm");
}

let wasm: Uint8Array | undefined;

/** PDFium's wasm, read once per owner. */
export function pdfiumWasm(): Uint8Array {
  wasm ??= new Uint8Array(readFileSync(pdfiumWasmPath()));
  return wasm;
}

/** The core font: Noto Sans for Latin, Greek and Cyrillic (OFL-1.1, `assets/NotoSans-OFL.txt`). */
export function coreFontPath(): string {
  return join(import.meta.dirname, "..", "assets", "NotoSans-Regular.ttf");
}

let font: Uint8Array | undefined;

/** The core font's bytes, read once per owner and sent with each fill. */
export function coreFont(): Uint8Array {
  font ??= new Uint8Array(readFileSync(coreFontPath()));
  return font;
}
