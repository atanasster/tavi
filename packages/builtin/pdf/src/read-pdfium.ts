import type { PdfFormKind, PdfRefusal } from "@tavi/contracts";

import { hiddenReason, splitText, type CharFacts, type Colour, type PageBox, type SplitText } from "./hidden-text.js";
import type { Box, TextRun } from "./labels.js";
import type { Rule } from "./layout.js";
import { FPDF, f32, f64, i32, type Pdfium, u32, utf16At, wideString, withScratch } from "./pdfium.js";

/**
 * The reader over PDFium's raw API: facts,
 * text with hidden-text signals, native search, form widgets, rendering and
 * coordinate mapping. One instance holds one document; the child closes it
 * and exits.
 */

export interface PdfiumFacts {
  readonly pageCount: number;
  readonly encryption: "none" | "owner-only";
  readonly fillPermitted: boolean;
  /** Whether flattening would be allowed: permission bit 4. */
  readonly modifyPermitted: boolean;
  readonly formType: PdfFormKind;
  /** Signature fields that carry a signature: a blank signature line is not one. */
  readonly signatures: number;
  readonly certification?: "P1" | "P2" | "P3";
}

/** One widget annotation of a form field, as PDFium reports it. */
export interface WidgetFacts {
  readonly name: string;
  readonly alternateName: string;
  readonly fieldType: number;
  readonly fieldFlags: number;
  readonly annotFlags: number;
  readonly page: number;
  /** `[left, bottom, right, top]` in page points. */
  readonly rect: Box;
  readonly value: string;
  readonly exportValue: string;
  readonly checked: boolean;
  readonly options: readonly string[];
  readonly selected: readonly number[];
  readonly controlCount: number;
  readonly controlIndex: number;
}

export interface RenderedPage {
  readonly width: number;
  readonly height: number;
  /** RGBA, `width * 4` bytes per row. */
  readonly pixels: Uint8Array;
}

/** An outline drawn over a render, in page points. */
export interface Outline {
  readonly rect: Box;
  readonly colour: "yellow" | "blue";
}

/** `FPDF_GetFormType`'s answers: full XFA needs its own renderer; foreground XFA sits over an AcroForm. */
const FORM_KINDS: Readonly<Record<number, PdfFormKind>> = {
  [FPDF.formTypeNone]: "none",
  [FPDF.formTypeAcroForm]: "acroform",
  [FPDF.formTypeXfaFull]: "xfa-dynamic",
  [FPDF.formTypeXfaForeground]: "xfa-hybrid",
};

/** Annotation subtypes a render draws over the page that can hide text: free text, square, circle, polygon, stamp, ink. */
const COVERING_ANNOTATIONS: ReadonlySet<number> = new Set([3, 5, 6, 7, 13, 15]);

const OUTLINE_RGB: Readonly<Record<Outline["colour"], readonly [number, number, number]>> = { yellow: [255, 200, 0], blue: [30, 100, 255] };

export class PdfiumDocument {
  readonly #pdfium: Pdfium;
  readonly #document: number;
  readonly #bytes: number;
  readonly #formInfo: number;
  readonly #form: number;
  #closed = false;

  private constructor(pdfium: Pdfium, document: number, bytes: number, formInfo: number, form: number) {
    this.#pdfium = pdfium;
    this.#document = document;
    this.#bytes = bytes;
    this.#formInfo = formInfo;
    this.#form = form;
  }

  /** Open `bytes` from memory, with the user `password` it may need; one that needs another, or does not parse, is refused. */
  static open(pdfium: Pdfium, bytes: Uint8Array, password = ""): PdfiumDocument | { readonly refused: PdfRefusal } {
    const pointer = pdfium.pdfium.wasmExports.malloc(Math.max(1, bytes.length));
    if (pointer === 0) return { refused: "too-large" };
    pdfium.pdfium.HEAPU8.set(bytes, pointer);
    const document = pdfium.FPDF_LoadMemDocument(pointer, bytes.length, password);
    if (document === 0) {
      const error = pdfium.FPDF_GetLastError();
      pdfium.pdfium.wasmExports.free(pointer);
      return { refused: error === FPDF.errPassword ? "password" : "malformed" };
    }
    const formInfo = pdfium.PDFiumExt_OpenFormFillInfo();
    const form = pdfium.PDFiumExt_InitFormFillEnvironment(document, formInfo);
    return new PdfiumDocument(pdfium, document, pointer, formInfo, form);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const pdfium = this.#pdfium;
    if (this.#form !== 0) pdfium.PDFiumExt_ExitFormFillEnvironment(this.#form);
    if (this.#formInfo !== 0) pdfium.PDFiumExt_CloseFormFillInfo(this.#formInfo);
    pdfium.FPDF_CloseDocument(this.#document);
    pdfium.pdfium.wasmExports.free(this.#bytes);
  }

  get pageCount(): number {
    return this.#pdfium.FPDF_GetPageCount(this.#document);
  }

  facts(): PdfiumFacts {
    const pdfium = this.#pdfium;
    const encrypted = pdfium.EPDF_IsEncrypted(this.#document);
    const permissions = pdfium.FPDF_GetDocPermissions(this.#document) >>> 0;
    const revision = pdfium.FPDF_GetSecurityHandlerRevision(this.#document);
    // Bit 6 (fill and annotate), or bit 9 (fill only) at revision 3 and later (ISO 32000-1 §7.6.3.2).
    const fillPermitted = !encrypted || (permissions & (1 << 5)) !== 0 || (revision >= 3 && (permissions & (1 << 8)) !== 0);
    const formType = pdfium.FPDF_GetFormType(this.#document);
    // PDFium lists every `/FT /Sig` field; one is signed only when its value carries `/Contents`.
    let signatures = 0;
    let certification: PdfiumFacts["certification"];
    for (let index = 0; index < pdfium.FPDF_GetSignatureCount(this.#document); index += 1) {
      const signature = pdfium.FPDF_GetSignatureObject(this.#document, index);
      if (signature === 0 || pdfium.FPDFSignatureObj_GetContents(signature, 0, 0) === 0) continue;
      signatures += 1;
      const permission = pdfium.FPDFSignatureObj_GetDocMDPPermission(signature);
      if (permission >= 1 && permission <= 3) certification = `P${permission}` as "P1" | "P2" | "P3";
    }
    return {
      pageCount: this.pageCount,
      encryption: encrypted ? "owner-only" : "none",
      fillPermitted,
      modifyPermitted: !encrypted || (permissions & (1 << 3)) !== 0,
      formType: FORM_KINDS[formType] ?? "none",
      signatures,
      ...(certification === undefined ? {} : { certification }),
    };
  }

  /** Run `body` with page `index` (zero-based) loaded and its form hooks called. */
  withPage<T>(index: number, body: (page: number) => T): T {
    const pdfium = this.#pdfium;
    const page = pdfium.FPDF_LoadPage(this.#document, index);
    if (page === 0) throw new Error(`page ${index + 1} does not load`);
    pdfium.FORM_OnAfterLoadPage(page, this.#form);
    try {
      return body(page);
    } finally {
      pdfium.FORM_OnBeforeClosePage(page, this.#form);
      pdfium.FPDF_ClosePage(page);
    }
  }

  /**
   * The page's visible area, `[left, bottom, right, top]` in unrotated page
   * points: its crop box within its media box, either inherited from the
   * page tree.
   */
  cropBox(page: number): PageBox {
    const pdfium = this.#pdfium;
    return withScratch(pdfium, (scratch) => {
      const out = scratch.alloc(16);
      if (!pdfium.FPDF_GetPageBoundingBox(page, out)) throw new Error("the page has no bounding box");
      // FS_RECTF is left, top, right, bottom.
      const [left, top, right, bottom] = [f32(pdfium, out), f32(pdfium, out + 4), f32(pdfium, out + 8), f32(pdfium, out + 12)];
      return [Math.min(left, right), Math.min(top, bottom), Math.max(left, right), Math.max(top, bottom)] as const;
    });
  }

  /**
   * Page `index`'s characters with their hidden-text facts. `offLayers` are
   * the names of optional-content groups off by default (read by the writer
   * library: PDFium's WASM build has no OCG API).
   */
  chars(
    index: number,
    offLayers: ReadonlySet<string>,
    maxChars: number,
    coverObjects = 0,
  ): { readonly chars: CharFacts[]; readonly box: PageBox; readonly coversTruncated: boolean } {
    const pdfium = this.#pdfium;
    return this.withPage(index, (page) => {
      const box = this.cropBox(page);
      // What is drawn over text: asked for with the most page objects to look at.
      const covers = coverObjects > 0 ? this.#covers(page, coverObjects) : undefined;
      let coversTruncated = covers?.truncated ?? false;
      const text = pdfium.FPDFText_LoadPage(page);
      if (text === 0) return { chars: [], box, coversTruncated };
      try {
        const total = pdfium.FPDFText_CountChars(text);
        const count = Math.min(total, maxChars);
        // Characters past the cap are not looked at: the page is not checked whole for hidden text either.
        if (total > maxChars) coversTruncated = true;
        const chars: CharFacts[] = [];
        const layerOf = new Map<number, boolean>();
        withScratch(pdfium, (scratch) => {
          const colour = scratch.alloc(16);
          const strokeColour = scratch.alloc(16);
          const charBox = scratch.alloc(32);
          for (let at = 0; at < count; at += 1) {
            const code = pdfium.FPDFText_GetUnicode(text, at);
            const generated = pdfium.FPDFText_IsGenerated(text, at) === 1;
            const object = generated ? 0 : pdfium.FPDFText_GetTextObject(text, at);
            const filled = !generated && pdfium.FPDFText_GetFillColor(text, at, colour, colour + 4, colour + 8, colour + 12);
            const stroked =
              !generated && pdfium.FPDFText_GetStrokeColor(text, at, strokeColour, strokeColour + 4, strokeColour + 8, strokeColour + 12);
            const boxed = !generated && pdfium.FPDFText_GetCharBox(text, at, charBox, charBox + 8, charBox + 16, charBox + 24);
            let hiddenLayer = false;
            if (object !== 0 && offLayers.size > 0) {
              const known = layerOf.get(object);
              hiddenLayer = known ?? this.#inOffLayer(object, offLayers);
              layerOf.set(object, hiddenLayer);
            }
            chars.push({
              code: code === 0 ? 0xfffd : code,
              renderMode: object === 0 ? 0 : pdfium.FPDFTextObj_GetTextRenderMode(object),
              fill: filled ? colourAt(pdfium, colour) : BLACK,
              stroke: stroked ? colourAt(pdfium, strokeColour) : BLACK,
              fontSize: generated ? 0 : pdfium.FPDFText_GetFontSize(text, at),
              // FPDFText_GetCharBox answers left, right, bottom, top.
              ...(boxed
                ? { box: [f64(pdfium, charBox), f64(pdfium, charBox + 16), f64(pdfium, charBox + 8), f64(pdfium, charBox + 24)] as const }
                : {}),
              ...(covers !== undefined &&
              boxed &&
              covers.over(object, [f64(pdfium, charBox), f64(pdfium, charBox + 16), f64(pdfium, charBox + 8), f64(pdfium, charBox + 24)])
                ? { underCover: true }
                : {}),
              hiddenLayer,
              generated,
            });
          }
        });
        return { chars, box, coversTruncated };
      } finally {
        pdfium.FPDFText_ClosePage(text);
      }
    });
  }

  /**
   * What is drawn over text on a page: every opaque path fill, image,
   * shading and form XObject in the page's drawing order, and the annotations
   * a render draws on top that can hide text (free text, shapes, stamps, ink).
   * `over` says whether a character of a text object lies under one drawn
   * after that object; a text object it cannot place (inside a form XObject)
   * counts as drawn first. Past `maxObjects`, the rest is not looked at.
   */
  #covers(
    page: number,
    maxObjects: number,
  ): { readonly over: (object: number, box: readonly [number, number, number, number]) => boolean; readonly truncated: boolean } {
    const pdfium = this.#pdfium;
    const order = new Map<number, number>();
    const covers: { readonly after: number; readonly box: readonly [number, number, number, number] }[] = [];
    const total = pdfium.FPDFPage_CountObjects(page);
    withScratch(pdfium, (scratch) => {
      const bounds = scratch.alloc(16);
      const modes = scratch.alloc(8);
      for (let at = 0; at < Math.min(total, maxObjects); at += 1) {
        const object = pdfium.FPDFPage_GetObject(page, at);
        const type = pdfium.FPDFPageObj_GetType(object);
        if (type === FPDF.pageObjectText) {
          order.set(object, at);
          continue;
        }
        if (
          type !== FPDF.pageObjectPath &&
          type !== FPDF.pageObjectImage &&
          type !== FPDF.pageObjectShading &&
          type !== FPDF.pageObjectForm
        )
          continue;
        // Something drawn see-through hides nothing.
        if (pdfium.FPDFPageObj_HasTransparency(object)) continue;
        // A stroked outline hides nothing; only a fill does.
        if (
          type === FPDF.pageObjectPath &&
          (!pdfium.FPDFPath_GetDrawMode(object, modes, modes + 4) || i32(pdfium, modes) === FPDF.fillModeNone)
        )
          continue;
        // Left, bottom, right, top.
        if (!pdfium.FPDFPageObj_GetBounds(object, bounds, bounds + 4, bounds + 8, bounds + 12)) continue;
        covers.push({ after: at, box: [f32(pdfium, bounds), f32(pdfium, bounds + 4), f32(pdfium, bounds + 8), f32(pdfium, bounds + 12)] });
      }
      const annotations = pdfium.FPDFPage_GetAnnotCount(page);
      for (let at = 0; at < annotations; at += 1) {
        const annot = pdfium.FPDFPage_GetAnnot(page, at);
        if (annot === 0) continue;
        try {
          if (!COVERING_ANNOTATIONS.has(pdfium.FPDFAnnot_GetSubtype(annot))) continue;
          pdfium.FPDFAnnot_GetRect(annot, bounds);
          // FS_RECTF is left, top, right, bottom.
          const [left, top, right, bottom] = [
            f32(pdfium, bounds),
            f32(pdfium, bounds + 4),
            f32(pdfium, bounds + 8),
            f32(pdfium, bounds + 12),
          ];
          covers.push({
            after: Number.POSITIVE_INFINITY,
            box: [Math.min(left, right), Math.min(top, bottom), Math.max(left, right), Math.max(top, bottom)],
          });
        } finally {
          pdfium.FPDFPage_CloseAnnot(annot);
        }
      }
    });
    return {
      truncated: total > maxObjects,
      over: (object, [left, bottom, right, top]) => {
        const placed = order.get(object) ?? -1;
        const [x, y] = [(left + right) / 2, (bottom + top) / 2];
        return covers.some(
          (cover) => cover.after > placed && cover.box[0] <= x && x <= cover.box[2] && cover.box[1] <= y && y <= cover.box[3],
        );
      },
    };
  }

  /** Whether a text object sits in marked content of an optional-content group that is off. */
  #inOffLayer(object: number, offLayers: ReadonlySet<string>): boolean {
    const pdfium = this.#pdfium;
    const marks = pdfium.FPDFPageObj_CountMarks(object);
    for (let index = 0; index < marks; index += 1) {
      const mark = pdfium.FPDFPageObj_GetMark(object, index);
      const name = markString(pdfium, (buffer, length, out) => pdfium.FPDFPageObjMark_GetName(mark, buffer, length, out));
      if (name !== "OC") continue;
      const layer = markString(pdfium, (buffer, length, out) =>
        pdfium.FPDFPageObjMark_GetParamStringValue(mark, "Name", buffer, length, out),
      );
      if (layer !== "" && offLayers.has(layer)) return true;
    }
    return false;
  }

  /** Page `index`'s visible text, hidden runs and cover spans (`coverObjects`: page objects to look at for covers; 0, none). */
  text(
    index: number,
    offLayers: ReadonlySet<string>,
    maxChars: number,
    coverObjects = 0,
  ): SplitText & { readonly coversTruncated: boolean } {
    const { chars, box, coversTruncated } = this.chars(index, offLayers, maxChars, coverObjects);
    return { ...splitText(chars, box), coversTruncated };
  }

  /**
   * Page `index` laid out: its visible runs (none under a cover), its
   * hidden runs, whether any text is under a cover or past what was looked
   * at, and its horizontal ruling lines (thin filled or stroked paths), for
   * tables.
   */
  layout(
    index: number,
    offLayers: ReadonlySet<string>,
    maxChars: number,
    coverObjects: number,
  ): { readonly runs: TextRun[]; readonly split: SplitText; readonly unchecked: boolean; readonly rules: Rule[]; readonly box: PageBox } {
    const { chars, box, coversTruncated } = this.chars(index, offLayers, maxChars, coverObjects);
    const split = splitText(chars, box);
    return {
      runs: textRuns(chars, box, { skipCovered: true }),
      split,
      unchecked: coversTruncated || chars.some((char) => char.underCover === true),
      rules: this.#rules(index, coverObjects),
      box,
    };
  }

  /** Page `index`'s horizontal ruling lines: paths at most 2 points high and 20 wide, among its first `maxObjects` objects. */
  #rules(index: number, maxObjects: number): Rule[] {
    return this.paths(index, maxObjects).flatMap(([left, bottom, right, top]) =>
      top - bottom <= 2 && right - left >= 20 ? [{ y: (top + bottom) / 2, left, right }] : [],
    );
  }

  /** The bounds of page `index`'s path objects, among its first `maxObjects` objects. */
  paths(index: number, maxObjects: number): Box[] {
    const pdfium = this.#pdfium;
    return this.withPage(index, (page) =>
      withScratch(pdfium, (scratch) => {
        const bounds = scratch.alloc(16);
        const paths: Box[] = [];
        const count = Math.min(pdfium.FPDFPage_CountObjects(page), maxObjects);
        for (let at = 0; at < count; at += 1) {
          const object = pdfium.FPDFPage_GetObject(page, at);
          if (pdfium.FPDFPageObj_GetType(object) !== FPDF.pageObjectPath) continue;
          if (!pdfium.FPDFPageObj_GetBounds(object, bounds, bounds + 4, bounds + 8, bounds + 12)) continue;
          paths.push([f32(pdfium, bounds), f32(pdfium, bounds + 4), f32(pdfium, bounds + 8), f32(pdfium, bounds + 12)]);
        }
        return paths;
      }),
    );
  }

  /** Page `index`'s visible text as positioned runs, for label search. */
  runs(index: number, offLayers: ReadonlySet<string>, maxChars: number): TextRun[] {
    const { chars, box } = this.chars(index, offLayers, maxChars);
    return textRuns(chars, box);
  }

  /**
   * How many times page `index` shows `phrase` in its visible text
   * (case-insensitive), by PDFium's own search. A match touching a hidden
   * character is not counted: hidden text is never evidence.
   */
  find(index: number, phrase: string, offLayers: ReadonlySet<string>, maxChars: number): number {
    const pdfium = this.#pdfium;
    const { chars, box } = this.chars(index, offLayers, maxChars);
    return this.withPage(index, (page) => {
      const text = pdfium.FPDFText_LoadPage(page);
      if (text === 0) return 0;
      try {
        return withScratch(pdfium, (scratch) => {
          const search = pdfium.FPDFText_FindStart(text, scratch.wide(phrase), 0, 0);
          if (search === 0) return 0;
          let hits = 0;
          try {
            while (pdfium.FPDFText_FindNext(search)) {
              const start = pdfium.FPDFText_GetSchResultIndex(search);
              const matched = chars.slice(start, start + pdfium.FPDFText_GetSchCount(search));
              if (matched.every((char) => hiddenReason(char, box) === undefined)) hits += 1;
            }
          } finally {
            pdfium.FPDFText_FindClose(search);
          }
          return hits;
        });
      } finally {
        pdfium.FPDFText_ClosePage(text);
      }
    });
  }

  /** Every widget annotation on the document's pages, up to `maxWidgets`. */
  widgets(maxWidgets: number): WidgetFacts[] {
    const pdfium = this.#pdfium;
    const form = this.#form;
    const widgets: WidgetFacts[] = [];
    for (let index = 0; index < this.pageCount && widgets.length < maxWidgets; index += 1) {
      this.withPage(index, (page) => {
        const count = pdfium.FPDFPage_GetAnnotCount(page);
        for (let at = 0; at < count && widgets.length < maxWidgets; at += 1) {
          const annot = pdfium.FPDFPage_GetAnnot(page, at);
          if (annot === 0) continue;
          try {
            if (pdfium.FPDFAnnot_GetSubtype(annot) !== FPDF.annotWidget) continue;
            const rect = withScratch(pdfium, (scratch) => {
              const out = scratch.alloc(16);
              pdfium.FPDFAnnot_GetRect(annot, out);
              // FS_RECTF is left, top, right, bottom.
              const [left, top, right, bottom] = [f32(pdfium, out), f32(pdfium, out + 4), f32(pdfium, out + 8), f32(pdfium, out + 12)];
              return [Math.min(left, right), Math.min(top, bottom), Math.max(left, right), Math.max(top, bottom)] as const;
            });
            const optionCount = Math.max(0, Math.min(pdfium.FPDFAnnot_GetOptionCount(form, annot), 200));
            const options: string[] = [];
            const selected: number[] = [];
            for (let option = 0; option < optionCount; option += 1) {
              options.push(
                wideString(pdfium, (buffer, length) => pdfium.FPDFAnnot_GetOptionLabel(form, annot, option, buffer, length), 200),
              );
              if (pdfium.FPDFAnnot_IsOptionSelected(form, annot, option)) selected.push(option);
            }
            widgets.push({
              name: wideString(pdfium, (buffer, length) => pdfium.FPDFAnnot_GetFormFieldName(form, annot, buffer, length), 512),
              alternateName: wideString(
                pdfium,
                (buffer, length) => pdfium.FPDFAnnot_GetFormFieldAlternateName(form, annot, buffer, length),
                200,
              ),
              fieldType: pdfium.FPDFAnnot_GetFormFieldType(form, annot),
              fieldFlags: pdfium.FPDFAnnot_GetFormFieldFlags(form, annot),
              annotFlags: pdfium.FPDFAnnot_GetFlags(annot),
              page: index + 1,
              rect,
              value: wideString(pdfium, (buffer, length) => pdfium.FPDFAnnot_GetFormFieldValue(form, annot, buffer, length), 2_000),
              exportValue: wideString(
                pdfium,
                (buffer, length) => pdfium.FPDFAnnot_GetFormFieldExportValue(form, annot, buffer, length),
                200,
              ),
              checked: pdfium.FPDFAnnot_IsChecked(form, annot),
              options,
              selected,
              controlCount: pdfium.FPDFAnnot_GetFormControlCount(form, annot),
              controlIndex: pdfium.FPDFAnnot_GetFormControlIndex(form, annot),
            });
          } finally {
            pdfium.FPDFPage_CloseAnnot(annot);
          }
        }
      });
    }
    return widgets;
  }

  /**
   * Page `index` rendered at `dpi`, scaled down to at most `maxPixels`, with
   * its form fields drawn and `outlines` stroked over it. Outlines are mapped
   * through `FPDF_PageToDevice`, so they follow the page's `/Rotate` and crop
   * box.
   */
  render(index: number, dpi: number, maxPixels: number, outlines: readonly Outline[]): RenderedPage {
    const pdfium = this.#pdfium;
    return this.withPage(index, (page) => {
      const widthPoints = pdfium.FPDF_GetPageWidthF(page);
      const heightPoints = pdfium.FPDF_GetPageHeightF(page);
      let scale = dpi / 72;
      if (widthPoints * heightPoints * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (widthPoints * heightPoints));
      const width = Math.max(1, Math.floor(widthPoints * scale));
      const height = Math.max(1, Math.floor(heightPoints * scale));
      const bitmap = pdfium.FPDFBitmap_Create(width, height, 1);
      if (bitmap === 0) throw new Error("PDFium could not allocate the bitmap");
      try {
        pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
        pdfium.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, FPDF.renderAnnotations);
        pdfium.FPDF_FFLDraw(this.#form, bitmap, page, 0, 0, width, height, 0, FPDF.renderAnnotations);
        const stride = pdfium.FPDFBitmap_GetStride(bitmap);
        const source = pdfium.pdfium.HEAPU8.subarray(
          pdfium.FPDFBitmap_GetBuffer(bitmap),
          pdfium.FPDFBitmap_GetBuffer(bitmap) + stride * height,
        );
        const pixels = new Uint8Array(width * height * 4);
        for (let row = 0; row < height; row += 1) {
          for (let column = 0; column < width; column += 1) {
            const from = row * stride + column * 4;
            const to = (row * width + column) * 4;
            // PDFium's bitmap is BGRA.
            pixels[to] = source[from + 2] as number;
            pixels[to + 1] = source[from + 1] as number;
            pixels[to + 2] = source[from] as number;
            pixels[to + 3] = 255;
          }
        }
        for (const outline of outlines)
          strokeRect(pixels, width, height, this.toDevice(page, width, height, outline.rect), OUTLINE_RGB[outline.colour]);
        return { width, height, pixels };
      } finally {
        pdfium.FPDFBitmap_Destroy(bitmap);
      }
    });
  }

  /** A page-point box as device pixels `[left, top, right, bottom]` in a `width × height` render. */
  toDevice(page: number, width: number, height: number, rect: Box): readonly [number, number, number, number] {
    const pdfium = this.#pdfium;
    return withScratch(pdfium, (scratch) => {
      const out = scratch.alloc(16);
      const corners = [
        [rect[0], rect[1]],
        [rect[2], rect[3]],
      ] as const;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [x, y] of corners) {
        pdfium.FPDF_PageToDevice(page, 0, 0, width, height, 0, x, y, out, out + 4);
        xs.push(pdfium.pdfium.getValue(out, "i32"));
        ys.push(pdfium.pdfium.getValue(out + 4, "i32"));
      }
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
    });
  }
}

const BLACK: Colour = { r: 0, g: 0, b: 0, a: 255 };

function colourAt(pdfium: Pdfium, pointer: number): Colour {
  return { r: u32(pdfium, pointer), g: u32(pdfium, pointer + 4), b: u32(pdfium, pointer + 8), a: u32(pdfium, pointer + 12) };
}

/** A marked-content string of PDFium's shape: byte length first, then the UTF-16 bytes; empty when absent. */
function markString(pdfium: Pdfium, getter: (buffer: number, length: number, out: number) => boolean): string {
  return withScratch(pdfium, (scratch) => {
    const out = scratch.alloc(4);
    if (!getter(0, 0, out)) return "";
    const length = Math.min(pdfium.pdfium.getValue(out, "i32"), 1_024);
    if (length <= 2) return "";
    const buffer = scratch.alloc(length);
    if (!getter(buffer, length, out)) return "";
    return utf16At(pdfium, buffer, length);
  });
}

/** A 2-pixel outline of `device` (left, top, right, bottom), clipped to the image. */
function strokeRect(
  pixels: Uint8Array,
  width: number,
  height: number,
  device: readonly [number, number, number, number],
  [r, g, b]: readonly [number, number, number],
): void {
  const [left, top, right, bottom] = device;
  const paint = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 4;
    pixels[at] = r;
    pixels[at + 1] = g;
    pixels[at + 2] = b;
  };
  for (let thickness = 0; thickness < 2; thickness += 1) {
    for (let x = left - 2; x <= right + 2; x += 1) {
      paint(x, top - 2 + thickness);
      paint(x, bottom + 1 + thickness);
    }
    for (let y = top - 2; y <= bottom + 2; y += 1) {
      paint(left - 2 + thickness, y);
      paint(right + 1 + thickness, y);
    }
  }
}

/**
 * Visible characters grouped into runs of words on one line: a run breaks at
 * a line break, a change of line, or a gap wider than twice the font size.
 */
function textRuns(chars: readonly CharFacts[], page: PageBox, options: { readonly skipCovered?: boolean } = {}): TextRun[] {
  const runs: TextRun[] = [];
  let text = "";
  let box: [number, number, number, number] | undefined;
  let lastSize = 0;
  const flush = (): void => {
    if (box !== undefined && text.trim() !== "") runs.push({ text: text.trim(), box });
    text = "";
    box = undefined;
  };
  for (const char of chars) {
    const value = String.fromCodePoint(char.code);
    if (char.code === 0x0d || char.code === 0x0a) {
      flush();
      continue;
    }
    if (char.generated || char.box === undefined) {
      if (box !== undefined) text += value;
      continue;
    }
    // A hidden character is no label: a reader would not see it there; nor, asked, one under a cover.
    if (hiddenReason(char, page) !== undefined || (options.skipCovered === true && char.underCover === true)) continue;
    const [left, bottom, right, top] = char.box;
    if (box !== undefined) {
      const size = Math.max(lastSize, char.fontSize, top - bottom);
      const sameLine = Math.abs((bottom + top) / 2 - (box[1] + box[3]) / 2) < size * 0.6;
      if (!sameLine || left - box[2] > 2 * size) flush();
    }
    text += value;
    box =
      box === undefined
        ? [left, bottom, right, top]
        : [Math.min(box[0], left), Math.min(box[1], bottom), Math.max(box[2], right), Math.max(box[3], top)];
    lastSize = char.fontSize;
  }
  flush();
  return runs;
}
