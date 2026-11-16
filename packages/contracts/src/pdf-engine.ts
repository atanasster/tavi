import type { ConfinedCommand } from "./confinement.js";
import type { PdfChildRequest, PdfChildResponse, PdfOcrPage, PdfPageText, PdfRefusal } from "./pdf.js";

/**
 * The PDF engine's port: what the PDF tools
 * use of a PDF engine, and what an engine package implements, as `RenderPort`
 * and `SandboxPort` are. `@tavi/plugin-pdf` is the built-in engine; the
 * owner chooses one at composition time, and nothing else imports it. The
 * OCR add-on (`@tavi/pdf-ocr`) is described here too, by its files only: the
 * engine is handed them, and never imports the add-on.
 */

/** A child's launch, before confinement. */
export interface PdfLaunch {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** What the child must read besides Node: its own package directory, and the OCR add-on's for the OCR child. */
  readonly readRoots: readonly string[];
}

/**
 * A child's launch, wrapped; `onExit`, called once it has exited, says whether its cgroup ended it out of memory,
 * and `kill` ends every process in its cgroup at once, the kill ladder's last step.
 */
export type PdfWrapped = ConfinedCommand & { readonly onExit?: () => "oom" | undefined; readonly kill?: () => void };

/** A launch the owner's confinement refused: the sandbox is unavailable here, and bare children were not allowed. */
export type PdfRefusedLaunch = { readonly refused: "unconfined" };

/**
 * How the engine's children are confined: the owner wraps each launch (with
 * its `ConfinementPort`), so an engine depends on contracts alone. A wrap may
 * refuse (`unconfined`: a host whose sandbox is unavailable, without
 * `serve --pdf-allow-unconfined`); the engine then answers the call refused
 * without starting a child. `none` runs them bare, for tests.
 */
export type PdfSandbox =
  | { readonly kind: "wrapped"; readonly wrap: (launch: PdfLaunch) => PdfWrapped | PdfRefusedLaunch }
  | { readonly kind: "none" };

/**
 * The OCR add-on's files: Tesseract's WASM build and its language data,
 * as absolute paths in one directory. An engine's OCR child may read the
 * directory, and nothing else of the add-on.
 */
export interface PdfOcrAssets {
  readonly directory: string;
  /** Emscripten's glue, CommonJS. */
  readonly core: string;
  readonly wasm: string;
  /** Each language's model, gzipped: English is what the add-on ships. */
  readonly languages: { readonly eng: string };
}

/**
 * Why a call produced no answer, besides the engine's own refusals. A
 * document whose child was killed (past its memory or wall clock), died
 * without answering, or answered out of protocol is refused at once for a
 * day, with the same failure.
 */
export type PdfFailure = "timeout" | "memory" | "crashed" | "protocol";

export type PdfRunResult =
  | {
      readonly ok: true;
      readonly answer: Extract<PdfChildResponse, { readonly ok: true }>;
      readonly pngs: readonly { readonly page: number; readonly png: Uint8Array }[];
      readonly document: Uint8Array;
      /** The highest resident set the watchdog saw, in KiB. */
      readonly peakKb: number;
      readonly wallMs: number;
    }
  /** `unconfined`: the sandbox is unavailable here and the owner did not allow bare children; no child ran, and the document is not refused later. */
  | { readonly ok: false; readonly refused: PdfRefusal | "unconfined"; readonly field?: string }
  | { readonly ok: false; readonly failure: PdfFailure };

/** A request without its limits: the engine adds them. */
export type PdfOperation = PdfChildRequest extends infer Request
  ? Request extends PdfChildRequest
    ? Omit<Request, "limits">
    : never
  : never;

/** What an OCR call answers: each page's text and confidence, or why not. */
export type PdfOcrResult =
  | { readonly ok: true; readonly pages: readonly PdfOcrPage[]; readonly peakKb: number; readonly wallMs: number }
  /** `too-large`: more pages than `ocrPagesPerCall`, or more image bytes than a frame carries; refused before any child. */
  | { readonly ok: false; readonly refused: "unreadable-image" | "no-ocr" | "too-large" | "unconfined" }
  | { readonly ok: false; readonly failure: PdfFailure };

/** What OCR did for one read. */
export interface PdfReadOcr {
  /** Scanned pages whose text is the OCR's. */
  readonly read: readonly number[];
  /** Pages whose cover spans were compared with their render. */
  readonly checked: readonly number[];
  /** Pages whose cover spans were moved to `hidden` without that comparison (it could not run): failing closed. */
  readonly unconfirmed: readonly number[];
  /** Pages with something drawn over text that was not looked at (no OCR, `ocr: "off"`, a `find` read, too many objects). */
  readonly unchecked: readonly number[];
  /** Scanned pages past `ocrPagesPerCall`: read them in a later call. */
  readonly skipped: readonly number[];
  /** Scanned pages left as images: no OCR add-on, `ocr: "off"`, past the limit, or OCR failed. */
  readonly images: readonly number[];
  /** Why OCR stopped, when it did. */
  readonly failure?: PdfFailure | "unreadable-image" | "too-large" | "render-refused" | "unconfined";
}

/** A read as `pdf.read` makes it: the text, with OCR where it is on and installed, and covered text checked against the render. */
export interface PdfReadOptions {
  readonly pages?: string;
  readonly find?: string;
  readonly ocr?: "auto" | "off";
  readonly format?: "text" | "markdown";
  /** The document's user password, read by the owner from its credential store: never a tool input. */
  readonly password?: string;
}

export interface PdfEnginePort {
  /** One operation on one document, through one confined, single-use child. */
  run(operation: PdfOperation, document: Uint8Array, fonts?: readonly Uint8Array[]): Promise<PdfRunResult>;
  /** A read, with OCR and the covered-text check; the engine's own refusal or failure is returned as is. */
  readWithOcr(
    document: Uint8Array,
    options: PdfReadOptions,
  ): Promise<{ readonly read: PdfRunResult; readonly pages: readonly PdfPageText[]; readonly ocr: PdfReadOcr }>;
  /** Whether the OCR add-on was handed to the engine, so `ocr` can answer. */
  readonly ocrAvailable: boolean;
  /** Page images, a document's own renders, through one OCR child; at most `ocrPagesPerCall`. */
  /** `signal`: a caller that gives up (the video OCR adapter's time, its caller's stop) ends the child at once, as `timeout`. */
  ocr(
    images: readonly { readonly page: number; readonly png: Uint8Array }[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<PdfOcrResult>;
  /** The fonts a fill sends when no add-on adds any: the engine's own core font. */
  coreFonts(): readonly Uint8Array[];
  /** Start a warm child now (a chat now holds a PDF), unless one waits already. */
  prewarm(): void;
  /** Stop the warm child and every running one. */
  close(): Promise<void>;
}
