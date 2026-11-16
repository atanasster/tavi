import {
  PDF_FRAME,
  PDF_LIMITS,
  type PdfEnginePort,
  type PdfOcrResult,
  type PdfPageText,
  type PdfReadOcr,
  type PdfReadOptions,
  type PdfRunResult,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

/**
 * OCR for `pdf.read`: a scanned page's text,
 * and text something is drawn over. The parser child reads the text layer
 * and marks, by geometry, the spans of it that lie under something opaque
 * drawn after them; the parser renders those pages and the scanned ones, and
 * the OCR child reads the renders.
 *
 * - A cover span the render does not show is moved from `text` to `hidden`,
 *   as `covered`: a reader never sees it, so it is data, never instructions.
 * - A cover span that could not be checked — the call's OCR limit, a failed
 *   render or OCR, a render read with low confidence — is moved too, and the
 *   page is reported as `unconfirmed`: the check fails closed.
 * - Without the OCR add-on, or with `ocr: "off"`, the spans stay in `text`
 *   and their pages are reported as `unchecked`, so the model is told.
 * - A scanned page takes the OCR's text.
 */

/** Under this mean confidence the render's words are not trusted to say what a reader sees. */
const COVERED_MIN_CONFIDENCE = 60;
/** A page keeps at most this many hidden runs, each at most this long (the result schema's bounds). */
const MAX_HIDDEN_RUNS = 32;
const MAX_HIDDEN_TEXT = 2_000;

const WORD = /[\p{L}\p{N}]+/gu;
const wordsOf = (text: string): string[] => text.normalize("NFKC").toLowerCase().match(WORD) ?? [];

type Span = { readonly start: number; readonly end: number };

/**
 * The cover spans of `text` that `ocrText` (the page's render, read) does not
 * show. The render's words are spent first on the text outside the spans, which
 * a reader sees; a span is shown when at least half of its words are among
 * those left. So a covered copy of a visible phrase cannot borrow the visible
 * copy's words, and a covered word repeated elsewhere is still missing here.
 */
export function coveredSpans(text: string, spans: readonly Span[], ocrText: string): Span[] {
  const left = new Map<string, number>();
  for (const word of wordsOf(ocrText)) left.set(word, (left.get(word) ?? 0) + 1);
  const spend = (word: string): boolean => {
    const count = left.get(word) ?? 0;
    if (count === 0) return false;
    left.set(word, count - 1);
    return true;
  };
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let at = 0;
  for (const span of ordered) {
    for (const word of wordsOf(text.slice(at, span.start))) spend(word);
    at = Math.max(at, span.end);
  }
  for (const word of wordsOf(text.slice(at))) spend(word);
  return ordered.filter((span) => {
    const words = wordsOf(text.slice(span.start, span.end));
    if (words.length === 0) return false;
    const shown = words.filter(spend).length;
    return shown * 2 < words.length;
  });
}

/** `text` without `spans`, and the spans' text: what goes to `hidden`. */
export function cutSpans(text: string, spans: readonly Span[]): { readonly text: string; readonly cut: readonly string[] } {
  if (spans.length === 0) return { text, cut: [] };
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let kept = "";
  let at = 0;
  for (const span of ordered) {
    if (span.start < at) continue;
    kept += text.slice(at, span.start);
    at = span.end;
  }
  kept += text.slice(at);
  return {
    text: kept
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    cut: ordered.map((span) => text.slice(span.start, span.end).trim()).filter((cut) => cut !== ""),
  };
}

/** A read, with OCR where it is on and installed. The parser's own refusal or failure is returned as is. */
export async function readWithOcr(
  service: Pick<PdfEnginePort, "run" | "ocr" | "ocrAvailable">,
  document: Uint8Array,
  options: PdfReadOptions,
): Promise<{ readonly read: PdfRunResult; readonly pages: readonly PdfPageText[]; readonly ocr: PdfReadOcr }> {
  // The document's password, when it needs one, goes with every run of the read: its render for OCR too.
  const password = options.password === undefined ? {} : { password: options.password };
  const read = await service.run(
    { op: "read", ...definedOnly({ pages: options.pages, find: options.find, format: options.format }), ...password },
    document,
  );
  if (!read.ok) return { read, pages: [], ocr: { read: [], checked: [], unconfirmed: [], unchecked: [], skipped: [], images: [] } };
  const pages = (read.answer.pages ?? []).map((page) => ({ ...page }));
  const returned = new Set(pages.map((page) => page.page));
  const spans = new Map<number, Span[]>();
  for (const span of read.answer.coverSpans ?? []) {
    if (!returned.has(span.page)) continue;
    spans.set(span.page, [...(spans.get(span.page) ?? []), { start: span.start, end: span.end }]);
  }
  const covered = [...spans.keys()];
  const scanned = read.answer.facts.imageOnlyPages.filter((page) => returned.has(page));
  const unlooked = (read.answer.coverUnchecked ?? []).filter((page) => returned.has(page));
  if (options.ocr === "off" || !service.ocrAvailable) {
    // A page with text under a cover is told as such, not as an image.
    return {
      read,
      pages,
      ocr: {
        read: [],
        checked: [],
        unconfirmed: [],
        unchecked: [...new Set([...covered, ...unlooked])].sort((a, b) => a - b),
        skipped: [],
        images: scanned.filter((page) => !spans.has(page)),
      },
    };
  }

  // Covered text first: an author must not push it past the call's limit with scanned pages ahead of it.
  const queue = [...covered, ...scanned.filter((page) => !spans.has(page))];
  const targets = queue.slice(0, PDF_LIMITS.ocrPagesPerCall);
  const texts = new Map<number, { readonly text: string; readonly confidence: number }>();
  let failure: PdfReadOcr["failure"];
  let batch: { page: number; png: Uint8Array }[] = [];
  let batchBytes = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0 || failure !== undefined) return;
    const ocr: PdfOcrResult = await service.ocr(batch);
    batch = [];
    batchBytes = 0;
    if (!ocr.ok) {
      failure = "failure" in ocr ? ocr.failure : ocr.refused === "no-ocr" ? "unreadable-image" : ocr.refused;
      return;
    }
    for (const page of ocr.pages) texts.set(page.page, { text: page.text, confidence: page.confidence });
  };
  for (let at = 0; at < targets.length && failure === undefined; at += PDF_LIMITS.pagesPerRenderCall) {
    const rendered = await service.run(
      {
        op: "render",
        pages: targets.slice(at, at + PDF_LIMITS.pagesPerRenderCall),
        dpi: PDF_LIMITS.ocrDpi,
        highlight: [],
        outlineUserOnly: false,
        ...password,
      },
      document,
    );
    if (!rendered.ok) {
      failure = "failure" in rendered ? rendered.failure : "render-refused";
      break;
    }
    for (const image of rendered.pngs) {
      if (batch.length > 0 && batchBytes + image.png.length > PDF_FRAME.maxPngBytes) await flush();
      batch.push(image);
      batchBytes += image.png.length;
    }
  }
  await flush();

  let budget = PDF_LIMITS.textPerCall - pages.reduce((sum, page) => sum + page.text.length, 0);
  const readPages: number[] = [];
  const checked: number[] = [];
  const unconfirmed: number[] = [];
  for (const page of pages) {
    const ocr = texts.get(page.page);
    const pageSpans = spans.get(page.page);
    if (pageSpans !== undefined) {
      // Checked when the render was read with confidence; otherwise every span goes, unconfirmed.
      const trusted = ocr !== undefined && ocr.confidence >= COVERED_MIN_CONFIDENCE;
      const gone = trusted ? coveredSpans(page.text, pageSpans, ocr.text) : pageSpans;
      (trusted ? checked : unconfirmed).push(page.page);
      const before = page.text.length;
      const { text, cut } = cutSpans(page.text, gone);
      page.text = text;
      budget += before - text.length;
      if (cut.length > 0)
        page.hidden = [
          ...(page.hidden ?? []),
          ...cut.map((run) => ({ reason: "covered" as const, text: run.slice(0, MAX_HIDDEN_TEXT) })),
        ].slice(0, MAX_HIDDEN_RUNS);
    }
    if (ocr !== undefined && scanned.includes(page.page)) {
      // What a reader sees of the page: never covered text, which the render does not show.
      const text = ocr.text.trim().slice(0, Math.max(0, budget + page.text.length));
      if (text.length > page.text.length) {
        budget -= text.length - page.text.length;
        page.text = text;
      }
      readPages.push(page.page);
    }
  }
  return {
    read,
    pages,
    ocr: {
      read: readPages,
      checked,
      unconfirmed,
      unchecked: unlooked,
      skipped: queue.slice(PDF_LIMITS.ocrPagesPerCall).filter((page) => scanned.includes(page)),
      images: scanned.filter((page) => !readPages.includes(page)),
      ...(failure === undefined ? {} : { failure }),
    },
  };
}
