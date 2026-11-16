import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";

/**
 * A thin layer over PDFium's raw `FPDF_*`/`EPDF_*` API: memory, strings and the handful of structs the reader uses. Nothing
 * here resolves, fetches or reads a file: the wasm arrives as bytes.
 */
export type Pdfium = WrappedPdfiumModule;

/** Compile PDFium from the wasm the owner sent, and initialise the library once. */
export async function loadPdfium(wasmBinary: Uint8Array): Promise<Pdfium> {
  // A copy into an `ArrayBuffer` of its own: Emscripten takes the binary as is.
  const binary = wasmBinary.slice().buffer;
  const pdfium = await init({ wasmBinary: binary });
  pdfium.PDFiumExt_Init();
  return pdfium;
}

/** Allocations freed together, whatever happens between. */
export class Scratch {
  readonly #pdfium: Pdfium;
  readonly #pointers: number[] = [];

  constructor(pdfium: Pdfium) {
    this.#pdfium = pdfium;
  }

  alloc(bytes: number): number {
    const pointer = this.#pdfium.pdfium.wasmExports.malloc(Math.max(1, bytes));
    if (pointer === 0) throw new Error("PDFium could not allocate memory");
    this.#pointers.push(pointer);
    return pointer;
  }

  /** `bytes` copied into the wasm heap. */
  bytes(bytes: Uint8Array): number {
    const pointer = this.alloc(bytes.length);
    this.#pdfium.pdfium.HEAPU8.set(bytes, pointer);
    return pointer;
  }

  /** `text` as NUL-terminated UTF-16LE (`FPDF_WIDESTRING`). */
  wide(text: string): number {
    const size = (text.length + 1) * 2;
    const pointer = this.alloc(size);
    this.#pdfium.pdfium.stringToUTF16(text, pointer, size);
    return pointer;
  }

  free(): void {
    for (const pointer of this.#pointers.splice(0)) this.#pdfium.pdfium.wasmExports.free(pointer);
  }
}

/** Run `body` with a scratch arena, freed after. */
export function withScratch<T>(pdfium: Pdfium, body: (scratch: Scratch) => T): T {
  const scratch = new Scratch(pdfium);
  try {
    return body(scratch);
  } finally {
    scratch.free();
  }
}

/**
 * A UTF-16 string from a PDFium getter of the usual shape: called with no
 * buffer it returns the byte length including the terminator; called again
 * with a buffer that large it fills it (a smaller buffer is left untouched).
 * `max` bounds the characters kept; a string over `MAX_STRING_BYTES` is not
 * read at all.
 */
export function wideString(pdfium: Pdfium, getter: (buffer: number, length: number) => number, max = 64 * 1024): string {
  const length = getter(0, 0);
  if (length <= 2 || length > MAX_STRING_BYTES) return "";
  return withScratch(pdfium, (scratch) => {
    const buffer = scratch.alloc(length);
    getter(buffer, length);
    return utf16At(pdfium, buffer, length).slice(0, max);
  });
}

/** The longest string the reader takes out of the document in one read. */
const MAX_STRING_BYTES = 4 * 1024 * 1024;

const UTF16 = new TextDecoder("utf-16le");

/** The UTF-16LE string at `pointer`, at most `bytes` long, up to its NUL. */
export function utf16At(pdfium: Pdfium, pointer: number, bytes: number): string {
  const view = pdfium.pdfium.HEAPU8.subarray(pointer, pointer + bytes - (bytes % 2));
  let end = 0;
  while (end + 1 < view.length && (view[end] !== 0 || view[end + 1] !== 0)) end += 2;
  return UTF16.decode(view.subarray(0, end));
}

/** Reads of the wasm heap. */
export function f32(pdfium: Pdfium, pointer: number): number {
  return pdfium.pdfium.getValue(pointer, "float");
}
export function f64(pdfium: Pdfium, pointer: number): number {
  return pdfium.pdfium.getValue(pointer, "double");
}
export function i32(pdfium: Pdfium, pointer: number): number {
  return pdfium.pdfium.getValue(pointer, "i32");
}
export function u32(pdfium: Pdfium, pointer: number): number {
  return pdfium.pdfium.getValue(pointer, "i32") >>> 0;
}

/** PDFium's constants this layer uses (`fpdfview.h`, `fpdf_annot.h`, `fpdf_formfill.h`). */
export const FPDF = {
  errPassword: 4,
  annotWidget: 20,
  annotFlagHidden: 1 << 1,
  annotFlagNoView: 1 << 5,
  fieldUnknown: 0,
  fieldPushButton: 1,
  fieldCheckBox: 2,
  fieldRadioButton: 3,
  fieldComboBox: 4,
  fieldListBox: 5,
  fieldTextField: 6,
  fieldSignature: 7,
  fieldFlagReadOnly: 1 << 0,
  fieldFlagRequired: 1 << 1,
  textFlagMultiline: 1 << 12,
  textFlagComb: 1 << 24,
  choiceFlagMultiSelect: 1 << 21,
  renderAnnotations: 0x01,
  renderLcdText: 0x02,
  renderNoNativeText: 0x04,
  renderPrinting: 0x800,
  formTypeNone: 0,
  formTypeAcroForm: 1,
  formTypeXfaFull: 2,
  formTypeXfaForeground: 3,
  pageObjectText: 1,
  pageObjectPath: 2,
  pageObjectImage: 3,
  pageObjectShading: 4,
  pageObjectForm: 5,
  fillModeNone: 0,
} as const;
