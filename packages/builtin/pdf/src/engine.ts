import {
  pagesOf,
  PDF_MAX_ENTRY_BOXES,
  sensitiveOf,
  signedFillRefusal,
  userOnlyOf,
  type DocumentFacts,
  type FieldType,
  type FieldValue,
  type PdfChildFill,
  type PdfChildLimits,
  type PdfField,
  type PdfFillPlan,
  type PdfPageText,
  type PdfRefusal,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

import { MAX_BOX_PAGES, entryBoxes, type EntryBox } from "./boxes.js";
import { labelFor, type Box, type TextRun } from "./labels.js";
import { FPDF, type Pdfium } from "./pdfium.js";
import { encodePng } from "./png.js";
import { PdfiumDocument, type Outline, type WidgetFacts } from "./read-pdfium.js";
import { pageMarkdown, repeatedEdges, withoutEdges } from "./layout.js";
import {
  activeContent,
  answerSheet,
  embedFonts,
  fieldMechanics,
  fill,
  fingerprints,
  hasXfa,
  loadWriter,
  markChanged,
  offLayerNames,
  annotationRects,
  commentCount,
  overlay,
  overlayValues,
  sanitize,
  saveWriter,
  signatureLocked,
  type FieldMechanics,
  type WriterDocument,
} from "./write-pdflib.js";

/**
 * The composite engine: PDFium reads,
 * patched `@cantoo/pdf-lib` writes, and every write is read back through
 * PDFium before it leaves the child. One document per child.
 */

/** Under this many characters a page is probably a scan. */
const IMAGE_ONLY_CHARS = 200;
/** The most objects of one page the covered-text check looks at: a page past it is reported as not checked. */
const MAX_PAGE_OBJECTS = 20_000;
/** The most cover spans one read reports (the answer schema's bound); past it, the page is not checked. */
const MAX_COVER_SPANS = 512;
/** How much text around a `find` match a snippet keeps, each side. */
const SNIPPET_CONTEXT = 300;

export interface RenderedPng {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly png: Uint8Array;
}

export type Refused = { readonly refused: PdfRefusal; readonly field?: string };

export interface FillAnswer {
  readonly bytes: Uint8Array;
  readonly fill: PdfChildFill;
  readonly previews: readonly RenderedPng[];
}

const FIELD_TYPES: Readonly<Record<number, FieldType>> = {
  [FPDF.fieldPushButton]: "button",
  [FPDF.fieldCheckBox]: "checkbox",
  [FPDF.fieldRadioButton]: "radio",
  [FPDF.fieldComboBox]: "combo",
  [FPDF.fieldListBox]: "list",
  [FPDF.fieldTextField]: "text",
  [FPDF.fieldSignature]: "signature",
};

const normalise = (text: string): string => text.normalize("NFKC").replace(/\s+/g, " ").trim();

export class PdfEngine {
  readonly #pdfium: Pdfium;

  constructor(pdfium: Pdfium) {
    this.#pdfium = pdfium;
  }

  /** Open `bytes`, with the user `password` it may need; one that needs another, does not parse, or is too long, is refused. */
  async open(bytes: Uint8Array, limits: PdfChildLimits, password?: string): Promise<OpenedDocument | Refused> {
    if (!startsLikePdf(bytes)) return { refused: "not-a-pdf" };
    const reader = PdfiumDocument.open(this.#pdfium, bytes, password);
    if (!(reader instanceof PdfiumDocument)) return reader;
    if (reader.pageCount > limits.maxPages) {
      reader.close();
      return { refused: "too-many-pages" };
    }
    let writer: WriterDocument;
    try {
      writer = await loadWriter(bytes, false, password);
    } catch {
      reader.close();
      return { refused: "malformed" };
    }
    return new OpenedDocument(this.#pdfium, bytes, reader, writer, limits, password !== undefined);
  }
}

/** `%PDF-` within the first KiB, as viewers accept it. */
function startsLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

export class OpenedDocument {
  readonly #pdfium: Pdfium;
  readonly #bytes: Uint8Array;
  readonly #reader: PdfiumDocument;
  readonly #writer: WriterDocument;
  readonly #limits: PdfChildLimits;
  readonly #offLayers: Set<string>;
  #facts: DocumentFacts | undefined;
  #fields: { readonly fields: PdfField[]; readonly widgets: WidgetFacts[]; readonly truncated: boolean } | undefined;
  #boxes: EntryBox[] | undefined;

  /** Opened with a user password. */
  readonly #userPassword: boolean;

  constructor(
    pdfium: Pdfium,
    bytes: Uint8Array,
    reader: PdfiumDocument,
    writer: WriterDocument,
    limits: PdfChildLimits,
    userPassword = false,
  ) {
    this.#userPassword = userPassword;
    this.#pdfium = pdfium;
    this.#bytes = bytes;
    this.#reader = reader;
    this.#writer = writer;
    this.#limits = limits;
    this.#offLayers = offLayerNames(writer);
  }

  close(): void {
    this.#reader.close();
  }

  /** The characters one call reads of a page at most: the call's text budget, with room for markup and separators. */
  get #maxChars(): number {
    return this.#limits.textPerCall * 2;
  }

  facts(): DocumentFacts {
    if (this.#facts !== undefined) return this.#facts;
    const base = this.#reader.facts();
    const widgets = this.#widgets();
    const imageOnlyPages: number[] = [];
    for (let index = 0; index < base.pageCount; index += 1) {
      const { text } = this.#reader.text(index, this.#offLayers, IMAGE_ONLY_CHARS * 4);
      if (text.replace(/\s/g, "").length < IMAGE_ONLY_CHARS) imageOnlyPages.push(index + 1);
    }
    const form = base.formType === "acroform" && hasXfa(this.#writer) ? "xfa-hybrid" : base.formType;
    this.#facts = {
      sha256: sha256Hex(this.#bytes),
      pageCount: base.pageCount,
      // Opened with a user password: a password-encrypted document, filled only on an answer sheet.
      encryption: this.#userPassword && base.encryption !== "none" ? "password" : base.encryption,
      fillPermitted: base.fillPermitted,
      modifyPermitted: base.modifyPermitted,
      form,
      fieldCount: new Set(widgets.map((widget) => widget.name)).size,
      signatures: base.signatures,
      ...(base.certification === undefined ? {} : { certification: base.certification }),
      activeContent: activeContent(this.#writer).slice(0, 16),
      comments: commentCount(this.#writer),
      imageOnlyPages: imageOnlyPages.slice(0, 500),
    };
    return this.#facts;
  }

  #widgetCache: WidgetFacts[] | undefined;

  #widgets(): WidgetFacts[] {
    this.#widgetCache ??= this.#reader.widgets(this.#limits.maxFields * 4);
    return this.#widgetCache;
  }

  /**
   * Pages of text, within the call's character budget: `pages` (default from
   * page 1), or with `find` only the pages that show the phrase, as snippets
   * around each match. `markdown` (not with `find`): each page in
   * reading order with its tables, running headers and footers dropped.
   */
  read(options: { readonly pages?: string; readonly find?: string; readonly format?: "text" | "markdown" }): {
    readonly pages: PdfPageText[];
    readonly nextPage?: number;
    readonly truncated: boolean;
    readonly coverSpans: { page: number; start: number; end: number }[];
    readonly coverUnchecked: number[];
  } {
    const pageCount = this.#reader.pageCount;
    const wanted = pagesOf(
      options.pages ?? `1-${Math.max(1, pageCount)}`,
      pageCount,
      options.find === undefined ? this.#limits.pagesPerTextCall : this.#limits.maxPages,
    );
    const pages: PdfPageText[] = [];
    let budget = this.#limits.textPerCall;
    let nextPage: number | undefined;
    let truncated = false;
    const coverSpans: { page: number; start: number; end: number }[] = [];
    const coverUnchecked: number[] = [];
    // Markdown is laid out from every page the call may return first: a running header is told by its repeats.
    const markdown = options.format === "markdown" && options.find === undefined;
    const layouts = new Map(
      markdown
        ? wanted
            .slice(0, this.#limits.pagesPerTextCall)
            .map((page) => [page, this.#reader.layout(page - 1, this.#offLayers, this.#maxChars, MAX_PAGE_OBJECTS)] as const)
        : [],
    );
    const edges = repeatedEdges(
      [...layouts.values()].map((layout) => ({ runs: layout.runs, height: layout.box[3] - layout.box[1], bottom: layout.box[1] })),
    );
    for (const page of wanted) {
      if (pages.length >= this.#limits.pagesPerTextCall || budget <= 0) {
        nextPage = page;
        truncated = true;
        break;
      }
      if (options.find !== undefined && this.#reader.find(page - 1, options.find, this.#offLayers, this.#maxChars) === 0) continue;
      const layout = layouts.get(page);
      if (layout !== undefined) {
        // Text under a cover is left out of Markdown unchecked, so its page is said not checked whole.
        let text = pageMarkdown(withoutEdges(layout.runs, edges, layout.box[3] - layout.box[1], layout.box[1]), layout.rules);
        if (text.length > budget) {
          text = text.slice(0, budget);
          truncated = true;
          nextPage = page + 1 <= pageCount ? page + 1 : undefined;
        }
        budget -= text.length;
        if (layout.unchecked) coverUnchecked.push(page);
        pages.push({ page, text, ...(layout.split.hidden.length === 0 ? {} : { hidden: layout.split.hidden.map((run) => ({ ...run })) }) });
        if (truncated) break;
        continue;
      }
      const split = this.#reader.text(page - 1, this.#offLayers, this.#maxChars, MAX_PAGE_OBJECTS);
      let text = options.find === undefined ? split.text : snippets(split.text, options.find);
      if (text.length > budget) {
        text = text.slice(0, budget);
        truncated = true;
        nextPage = page + 1 <= pageCount ? page + 1 : undefined;
      }
      budget -= text.length;
      // Where text lies under something drawn over it: spans of `text`, which a snippet does not keep, so a
      // `find` page with any, or a page past the objects looked at, is reported as not checked.
      // A span the text budget cut, or past the spans one read reports, leaves its page reported as not checked.
      let dropped = false;
      if (options.find === undefined) {
        for (const span of split.coverSpans) {
          if (span.start >= text.length) continue;
          if (span.end <= text.length && coverSpans.length < MAX_COVER_SPANS) coverSpans.push({ page, ...span });
          else dropped = true;
        }
      }
      if (dropped || (options.find !== undefined && split.coverSpans.length > 0) || split.coversTruncated) coverUnchecked.push(page);
      pages.push({ page, text, ...(split.hidden.length === 0 ? {} : { hidden: split.hidden.map((run) => ({ ...run })) }) });
      if (truncated) break;
    }
    if (nextPage === undefined && !truncated && wanted.length > 0 && options.pages === undefined && options.find === undefined) {
      const last = wanted[wanted.length - 1] as number;
      if (last < pageCount) {
        nextPage = last + 1;
        truncated = true;
      }
    }
    return { pages, ...(nextPage === undefined ? {} : { nextPage }), truncated, coverSpans, coverUnchecked };
  }

  /** The form's fields, one per fully qualified name, with labels, options and classification; and the widgets they came from. */
  fields(): { readonly fields: PdfField[]; readonly widgets: WidgetFacts[]; readonly truncated: boolean } {
    if (this.#fields !== undefined) return this.#fields;
    const widgets = this.#widgets();
    let mechanics: Map<string, FieldMechanics>;
    try {
      mechanics = fieldMechanics(this.#writer);
    } catch {
      mechanics = new Map();
    }
    const groups = new Map<string, WidgetFacts[]>();
    for (const widget of widgets) {
      if (widget.name === "") continue;
      const group = groups.get(widget.name) ?? [];
      group.push(widget);
      groups.set(widget.name, group);
    }
    const runs = new Map<number, TextRun[]>();
    const runsOf = (page: number): TextRun[] => {
      let found = runs.get(page);
      if (found === undefined) {
        found = this.#reader.runs(page - 1, this.#offLayers, this.#maxChars);
        runs.set(page, found);
      }
      return found;
    };
    const fields: PdfField[] = [];
    for (const [id, group] of groups) {
      if (fields.length >= this.#limits.maxFields) break;
      fields.push(this.#field(id, group, mechanics.get(id), runsOf));
    }
    this.#fields = { fields, widgets, truncated: groups.size > fields.length };
    return this.#fields;
  }

  #field(id: string, group: readonly WidgetFacts[], mechanics: FieldMechanics | undefined, runsOf: (page: number) => TextRun[]): PdfField {
    const first = group[0] as WidgetFacts;
    const type = FIELD_TYPES[first.fieldType] ?? "button";
    const tooltip = normalise(first.alternateName).slice(0, 200);
    // A radio group's own label is its question, beside the group; each button's label is its option's.
    const label = tooltip !== "" ? tooltip : labelFor(first.rect, type === "checkbox", runsOf(first.page));
    let value: FieldValue | undefined;
    let options: PdfField["options"];
    let onValue: string | undefined;
    if (type === "text" || type === "combo") value = first.value === "" ? undefined : first.value.slice(0, 2_000);
    if (type === "checkbox") {
      value = group.some((widget) => widget.checked);
      onValue = mechanics?.onStates[0] || first.exportValue || undefined;
    }
    if (type === "radio") {
      // The writer lists on-states in `/Kids` order, PDFium widgets in page order: each widget's control index joins them.
      const controls = byControl(group);
      options = controls.slice(0, 200).map((widget) => {
        const state = mechanics?.onStates[widget.controlIndex] ?? widget.exportValue;
        const opt = mechanics?.opt?.[widget.controlIndex]?.shown;
        if (opt !== undefined && opt !== "") return { value: state.slice(0, 200), shown: opt.slice(0, 200), shownFrom: "opt" as const };
        const nearby = labelFor(widget.rect, true, runsOf(widget.page));
        if (nearby === undefined || nearby.toLowerCase() === state.toLowerCase())
          return { value: state.slice(0, 200), shown: state.slice(0, 200), shownFrom: "state-name" as const };
        return { value: state.slice(0, 200), shown: nearby, shownFrom: "nearby-text" as const };
      });
      const selected = controls.findIndex((widget) => widget.checked);
      if (selected >= 0) value = options[selected]?.value;
    }
    if (type === "combo" || type === "list") {
      const opt = mechanics?.opt;
      options = (opt ?? first.options.map((shown) => ({ value: shown, shown }))).slice(0, 200).map((option) => ({
        value: option.value.slice(0, 200),
        shown: option.shown.slice(0, 200),
        shownFrom: opt === undefined ? ("state-name" as const) : ("opt" as const),
      }));
      if (type === "list")
        value = first.selected
          .map((index) => options?.[index]?.value ?? "")
          .filter((choice) => choice !== "")
          .slice(0, 50);
    }
    const flags = first.fieldFlags;
    const hidden = group.every((widget) => isHiddenWidget(widget, this.#pageBox(widget.page)));
    const userOnly = userOnlyOf(type, id, label);
    const sensitive = sensitiveOf(id, label, typeof value === "string" ? value : undefined);
    return {
      id,
      type,
      page: first.page,
      rect: [...first.rect] as [number, number, number, number],
      ...(label === undefined || label === "" ? {} : { label }),
      ...(value === undefined ? {} : { value }),
      ...(options === undefined ? {} : { options }),
      ...(onValue === undefined ? {} : { onValue: onValue.slice(0, 200) }),
      ...(group.length > 1 ? { widgets: group.length } : {}),
      ...(type === "text" && (flags & FPDF.textFlagMultiline) !== 0 ? { multiline: true } : {}),
      ...(mechanics?.maxLength === undefined ? {} : { maxLength: mechanics.maxLength }),
      ...(mechanics?.comb === true ? { comb: true } : {}),
      ...((flags & FPDF.fieldFlagRequired) !== 0 ? { required: true } : {}),
      ...((flags & FPDF.fieldFlagReadOnly) !== 0 ? { readOnly: true } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(mechanics?.duplicate === true ? { duplicateName: true } : {}),
      ...(userOnly === undefined ? {} : { userOnly }),
      ...(sensitive.length === 0 ? {} : { sensitive }),
    };
  }

  #pageBoxes = new Map<number, Box>();

  #pageBox(page: number): Box {
    let box = this.#pageBoxes.get(page);
    if (box === undefined) {
      box = this.#reader.withPage(page - 1, (handle) => this.#reader.cropBox(handle));
      this.#pageBoxes.set(page, box);
    }
    return box;
  }

  /** Pages rendered as PNG, the `highlight` fields outlined in yellow and, when asked, user-only fields in blue. */
  render(
    pages: readonly number[],
    options: { readonly dpi: number; readonly highlight: readonly string[]; readonly outlineUserOnly: boolean },
  ): RenderedPng[] {
    return renderPages(this.#reader, this.fields().fields, this.fields().widgets, pages, options, this.#limits.maxPixelsPerPage);
  }

  /**
   * Fill the form, sanitise it, save it in full, and read every value back
   * through PDFium; previews of the filled pages when asked. A signed form is
   * filled by an incremental update after its signed bytes, unsanitised (it
   * carries no active content, or is refused). An encrypted form gets an
   * answer sheet instead.
   */
  async fill(plan: PdfFillPlan, fonts: readonly Uint8Array[]): Promise<FillAnswer | Refused> {
    const facts = this.facts();
    const unsignable = signedFillRefusal(facts);
    if (unsignable !== undefined) return { refused: unsignable };
    // Filled by an incremental update after the signed bytes: the signature still covers them.
    const signed = facts.signatures > 0;
    if (facts.form === "xfa-dynamic") return { refused: "xfa-dynamic" };
    const { fields, widgets } = this.fields();
    const byId = new Map(fields.map((field) => [field.id, field]));
    for (const row of plan.values) {
      const field = byId.get(row.field);
      if (field === undefined) return { refused: "unknown-field", field: row.field };
      if (field.userOnly !== undefined) return { refused: "user-only-field", field: row.field };
      if (
        field.hidden === true ||
        field.readOnly === true ||
        field.duplicateName === true ||
        field.type === "signature" ||
        field.type === "button"
      )
        return { refused: "locked-field", field: row.field };
      if (!valueFits(field, row.value)) return { refused: "bad-value", field: row.field };
      if (row.documentQuote !== undefined) {
        // The page is bounded before it is read: a page past the end is a refusal, not a damaged document.
        if (row.documentQuote.page > facts.pageCount) return { refused: "document-quote", field: row.field };
        const { text } = this.#reader.text(row.documentQuote.page - 1, this.#offLayers, this.#maxChars);
        if (!normalise(text).includes(normalise(row.documentQuote.quote))) return { refused: "document-quote", field: row.field };
      }
    }
    // A final copy: never of a signed form (its pages would change), never while a field is left for the
    // person (they could no longer complete it), and on permissions-only input only with bit 4.
    if (plan.flatten === true && (signed || fields.some((field) => field.userOnly !== undefined) || !facts.modifyPermitted))
      return { refused: "flatten-not-permitted" };
    // A permissions-only form gets an answer sheet even when filling is granted: the writer's
    // incremental save of an encrypted document neither encrypts the strings it appends nor carries
    // `/Encrypt` into the update, so the filled values do not read back.
    if (facts.encryption !== "none") {
      const rows = plan.values.map((row) => {
        const field = byId.get(row.field);
        return { field: field?.label === undefined ? row.field : `${field.label} (${row.field})`, value: shownValue(field, row.value) };
      });
      const bytes = await answerSheet(`Answers for a form (${facts.sha256.slice(0, 12)})`, rows, fonts);
      return {
        bytes,
        fill: { filled: 0, readBack: [], leftUserOnly: [], leftRequired: [], incremental: false, answerSheet: true, previewPages: [] },
        previews: [],
      };
    }
    const writer = await loadWriter(this.#bytes, signed);
    if (signed) {
      const locked = signatureLocked(writer);
      const row = plan.values.find((value) => locked(value.field));
      if (row !== undefined) return { refused: "locked-field", field: row.field };
    }
    // The snapshot is taken before anything changes; each object that then differs goes into the update.
    const snapshot = signed ? writer.document.takeSnapshot() : undefined;
    const unchanged = signed ? fingerprints(writer) : undefined;
    const embedded = await embedFonts(writer, fonts);
    const outcome = fill(writer, plan.values, embedded);
    if (!outcome.ok) return { refused: outcome.refused, field: outcome.field };
    if (snapshot !== undefined && unchanged !== undefined) markChanged(writer, snapshot, unchanged);
    else sanitize(writer);
    const bytes = await saveWriter(writer, snapshot);
    // The signed bytes come first, byte for byte, or the copy is not kept.
    if (
      signed &&
      (bytes.length <= this.#bytes.length ||
        !Buffer.from(bytes.buffer, bytes.byteOffset, this.#bytes.length).equals(Buffer.from(this.#bytes)))
    )
      return { refused: "verification-failed" };
    const verified = await this.#verify(bytes, plan, fields);
    if ("refused" in verified) return verified;
    const filledIds = new Set(plan.values.map((row) => row.field));
    const userOnlyIds = fields.filter((field) => field.userOnly !== undefined).map((field) => field.id);
    const pageCounts = new Map<number, number>();
    for (const widget of widgets) if (filledIds.has(widget.name)) pageCounts.set(widget.page, (pageCounts.get(widget.page) ?? 0) + 1);
    const previewPages = [...pageCounts.keys()].sort((a, b) => a - b).slice(0, 10);
    if (plan.flatten === true) {
      verified.close();
      const flat = await this.#flatten(bytes, plan, fields);
      if ("refused" in flat) return flat;
      const previews = plan.preview ? flat.render(previewPages) : [];
      flat.close();
      return {
        bytes: flat.bytes,
        fill: {
          filled: plan.values.length,
          readBack: verified.readBack,
          leftUserOnly: [],
          leftRequired: [],
          incremental: false,
          answerSheet: false,
          flattened: true,
          previewPages: plan.preview ? previewPages : [],
        },
        previews,
      };
    }
    const previews = plan.preview ? verified.render(previewPages, [...filledIds]) : [];
    verified.close();
    return {
      bytes,
      fill: {
        filled: plan.values.length,
        readBack: verified.readBack,
        leftUserOnly: userOnlyIds.slice(0, 1_000),
        leftRequired: fields
          .filter(
            (field) =>
              field.required === true &&
              field.userOnly === undefined &&
              !filledIds.has(field.id) &&
              (field.value === undefined || field.value === ""),
          )
          .map((field) => field.id)
          .slice(0, 1_000),
        incremental: signed,
        answerSheet: false,
        previewPages: plan.preview ? previewPages : [],
      },
      previews,
    };
  }

  /**
   * The verified copy flattened: each widget's appearance drawn into its
   * page, the fields removed. Kept only when the pages are the same in number,
   * no field is left, nothing active came back, and each text value is on
   * its field's page.
   */
  async #flatten(
    filled: Uint8Array,
    plan: PdfFillPlan,
    fields: readonly PdfField[],
  ): Promise<
    Refused | { readonly bytes: Uint8Array; readonly render: (pages: readonly number[]) => RenderedPng[]; readonly close: () => void }
  > {
    const refused: Refused = { refused: "verification-failed" };
    let bytes: Uint8Array;
    try {
      const writer = await loadWriter(filled);
      writer.document.getForm().flatten({ updateFieldAppearances: false });
      bytes = await saveWriter(writer, undefined);
      if (activeContent(await loadWriter(bytes)).some((kind) => kind !== "uri")) return refused;
    } catch {
      return refused;
    }
    const reader = PdfiumDocument.open(this.#pdfium, bytes);
    if (!(reader instanceof PdfiumDocument)) return refused;
    const byId = new Map(fields.map((field) => [field.id, field]));
    const pagesOfField = new Map<string, number[]>();
    for (const widget of this.fields().widgets) pagesOfField.set(widget.name, [...(pagesOfField.get(widget.name) ?? []), widget.page]);
    const shown = plan.values.every((row) => {
      if (typeof row.value !== "string" || byId.get(row.field)?.type !== "text" || row.value.trim() === "") return true;
      // A value too long for its box is clipped by its appearance: its first words are what must be there. Spacing
      // is not compared: a comb field's characters read back one per cell, spaced apart.
      const words = normalise(row.value).split(" ").slice(0, 3).join("").replace(/\s+/g, "");
      return (pagesOfField.get(row.field) ?? []).some((page) =>
        normalise(reader.text(page - 1, this.#offLayers, this.#maxChars).text)
          .replace(/\s+/g, "")
          .includes(words),
      );
    });
    if (reader.pageCount !== this.#reader.pageCount || reader.widgets(1).length > 0 || !shown) {
      reader.close();
      return refused;
    }
    const maxPixels = this.#limits.maxPixelsPerPage;
    return {
      bytes,
      render: (pages) => renderPages(reader, fields, [], pages, { dpi: 110, highlight: [], outlineUserOnly: false }, maxPixels),
      close: () => reader.close(),
    };
  }

  /**
   * A flat form's entry boxes (`pdf.overlay`): none for a form with
   * fields; at most `PDF_MAX_ENTRY_BOXES`, page by page.
   */
  boxes(): EntryBox[] {
    if (this.#boxes !== undefined) return this.#boxes;
    const boxes: EntryBox[] = [];
    if (this.facts().fieldCount === 0) {
      let annotations: Map<number, [number, number, number, number][]>;
      try {
        annotations = annotationRects(this.#writer);
      } catch {
        annotations = new Map();
      }
      for (let index = 0; index < Math.min(this.#reader.pageCount, MAX_BOX_PAGES) && boxes.length < PDF_MAX_ENTRY_BOXES; index += 1) {
        boxes.push(
          ...entryBoxes(
            index + 1,
            this.#reader.paths(index, MAX_PAGE_OBJECTS),
            this.#reader.runs(index, this.#offLayers, this.#maxChars),
            annotations.get(index + 1) ?? [],
          ),
        );
      }
    }
    this.#boxes = boxes.slice(0, PDF_MAX_ENTRY_BOXES);
    return this.#boxes;
  }

  /**
   * Write a flat form's values over its entry boxes as FreeText annotations
   * (`pdf.overlay`), sanitise the copy, save it in full, and read every
   * value back; previews of the pages written on. A form with fields is
   * `pdf.fill`'s; a signed one is refused (its pages would change); an
   * encrypted one gets an answer sheet.
   */
  async overlay(plan: PdfFillPlan, fonts: readonly Uint8Array[]): Promise<FillAnswer | Refused> {
    const facts = this.facts();
    if (facts.fieldCount > 0) return { refused: "has-fields" };
    if (facts.signatures > 0) return { refused: "signed" };
    if (facts.form === "xfa-dynamic") return { refused: "xfa-dynamic" };
    const boxes = new Map(this.boxes().map((box) => [box.id, box]));
    const entries: {
      readonly box: string;
      readonly page: number;
      readonly rect: readonly [number, number, number, number];
      readonly value: string;
    }[] = [];
    for (const row of plan.values) {
      const box = boxes.get(row.field);
      if (box === undefined) return { refused: "unknown-field", field: row.field };
      // A signature, initials or "I certify" line stays the person's, as such a field does.
      if (userOnlyOf("text", box.id, box.label) !== undefined) return { refused: "user-only-field", field: row.field };
      if (typeof row.value !== "string" || row.value.trim() === "") return { refused: "bad-value", field: row.field };
      if (row.documentQuote !== undefined) {
        // The page is bounded before it is read: a page past the end is a refusal, not a damaged document.
        if (row.documentQuote.page > facts.pageCount) return { refused: "document-quote", field: row.field };
        const { text } = this.#reader.text(row.documentQuote.page - 1, this.#offLayers, this.#maxChars);
        if (!normalise(text).includes(normalise(row.documentQuote.quote))) return { refused: "document-quote", field: row.field };
      }
      entries.push({ box: box.id, page: box.page, rect: box.rect, value: row.value });
    }
    if (facts.encryption !== "none") {
      const rows = plan.values.map((row) => ({
        field: boxes.get(row.field)?.label === undefined ? row.field : `${boxes.get(row.field)?.label} (${row.field})`,
        value: String(row.value),
      }));
      const bytes = await answerSheet(`Answers for a form (${facts.sha256.slice(0, 12)})`, rows, fonts);
      return {
        bytes,
        fill: { filled: 0, readBack: [], leftUserOnly: [], leftRequired: [], incremental: false, answerSheet: true, previewPages: [] },
        previews: [],
      };
    }
    const writer = await loadWriter(this.#bytes);
    const outcome = overlay(writer, entries, await embedFonts(writer, fonts));
    if (!outcome.ok) return { refused: outcome.refused, field: outcome.field };
    sanitize(writer);
    const bytes = await saveWriter(writer, undefined);
    // Read back: the same pages, nothing active, no field, and each value in a FreeText annotation on its page.
    const refused: Refused = { refused: "verification-failed" };
    const reader = PdfiumDocument.open(this.#pdfium, bytes);
    if (!(reader instanceof PdfiumDocument)) return refused;
    let written: Map<number, string[]>;
    try {
      const reloaded = await loadWriter(bytes);
      if (activeContent(reloaded).some((kind) => kind !== "uri")) throw new Error("active content");
      written = overlayValues(reloaded);
    } catch {
      reader.close();
      return refused;
    }
    // Each value counted against what the source already held: an annotation already there with the same text is not this write.
    const before = overlayValues(this.#writer);
    const count = (values: Map<number, string[]>, entry: (typeof entries)[number]): number =>
      (values.get(entry.page) ?? []).filter((value) => value === entry.value).length;
    const readBack = entries.map((entry) => ({
      field: entry.box,
      ok:
        count(written, entry) >=
        count(before, entry) + entries.filter((other) => other.page === entry.page && other.value === entry.value).length,
    }));
    if (reader.pageCount !== this.#reader.pageCount || reader.widgets(1).length > 0 || readBack.some((row) => !row.ok)) {
      reader.close();
      return refused;
    }
    const previewPages = [...new Set(entries.map((entry) => entry.page))].sort((a, b) => a - b).slice(0, 10);
    const previews = plan.preview
      ? renderPages(reader, [], [], previewPages, { dpi: 110, highlight: [], outlineUserOnly: false }, this.#limits.maxPixelsPerPage)
      : [];
    reader.close();
    return {
      bytes,
      fill: {
        filled: entries.length,
        readBack,
        leftUserOnly: [],
        leftRequired: [],
        incremental: false,
        answerSheet: false,
        previewPages: plan.preview ? previewPages : [],
      },
      previews,
    };
  }

  /** The written bytes read back; any failure refuses the write. */
  async #verify(bytes: Uint8Array, plan: PdfFillPlan, before: readonly PdfField[]): Promise<Refused | VerifiedOutput> {
    const refused: Refused = { refused: "verification-failed" };
    const reader = PdfiumDocument.open(this.#pdfium, bytes);
    if (!(reader instanceof PdfiumDocument)) return refused;
    const close = (): Refused => {
      reader.close();
      return refused;
    };
    const facts = reader.facts();
    const source = this.#reader.facts();
    // The same pages, and the same signatures and certification: an update never adds, drops or breaks one.
    if (
      facts.pageCount !== this.#reader.pageCount ||
      facts.signatures !== source.signatures ||
      facts.certification !== source.certification
    )
      return close();
    let writer: WriterDocument;
    try {
      writer = await loadWriter(bytes);
    } catch {
      return close();
    }
    if (activeContent(writer).some((kind) => kind !== "uri")) return close();
    const after = new Map<string, WidgetFacts[]>();
    for (const widget of reader.widgets(this.#limits.maxFields * 4)) after.set(widget.name, [...(after.get(widget.name) ?? []), widget]);
    const readBack = plan.values.map((row) => ({
      field: row.field,
      ok: readsBack(
        before.find((field) => field.id === row.field),
        after.get(row.field) ?? [],
        row.value,
      ),
    }));
    if (readBack.some((row) => !row.ok)) return close();
    // Fields Tavi never fills come out as they went in: user-only, hidden and read-only ones.
    const state = (widgets: readonly WidgetFacts[]): string =>
      JSON.stringify(widgets.map((widget) => [widget.value, widget.checked, widget.selected]));
    const beforeWidgets = new Map<string, WidgetFacts[]>();
    for (const widget of this.fields().widgets) beforeWidgets.set(widget.name, [...(beforeWidgets.get(widget.name) ?? []), widget]);
    for (const field of before) {
      if (field.userOnly === undefined && field.hidden !== true && field.readOnly !== true) continue;
      if (state(after.get(field.id) ?? []) !== state(beforeWidgets.get(field.id) ?? [])) return close();
    }
    const fields = before;
    const widgets = [...after.values()].flat();
    const maxPixels = this.#limits.maxPixelsPerPage;
    return {
      readBack,
      render: (pages, highlight) => renderPages(reader, fields, widgets, pages, { dpi: 110, highlight, outlineUserOnly: true }, maxPixels),
      close: () => reader.close(),
    };
  }
}

interface VerifiedOutput {
  readonly readBack: PdfChildFill["readBack"];
  readonly render: (pages: readonly number[], highlight: readonly string[]) => RenderedPng[];
  readonly close: () => void;
}

function renderPages(
  reader: PdfiumDocument,
  fields: readonly PdfField[],
  widgets: readonly WidgetFacts[],
  pages: readonly number[],
  options: { readonly dpi: number; readonly highlight: readonly string[]; readonly outlineUserOnly: boolean },
  maxPixels: number,
): RenderedPng[] {
  const highlighted = new Set(options.highlight);
  const userOnly = new Set(fields.filter((field) => field.userOnly !== undefined).map((field) => field.id));
  return pages.map((page) => {
    const outlines: Outline[] = widgets
      .filter((widget) => widget.page === page && (highlighted.has(widget.name) || (options.outlineUserOnly && userOnly.has(widget.name))))
      .map((widget) => ({ rect: widget.rect, colour: highlighted.has(widget.name) ? "yellow" : "blue" }));
    const rendered = reader.render(page - 1, options.dpi, maxPixels, outlines);
    return { page, width: rendered.width, height: rendered.height, png: encodePng(rendered.pixels, rendered.width, rendered.height) };
  });
}

/** Hidden or NoView, zero-size, or entirely off the page. */
function isHiddenWidget(widget: WidgetFacts, page: Box): boolean {
  if ((widget.annotFlags & (FPDF.annotFlagHidden | FPDF.annotFlagNoView)) !== 0) return true;
  const [left, bottom, right, top] = widget.rect;
  if (right - left <= 0 || top - bottom <= 0) return true;
  return right < page[0] || left > page[2] || top < page[1] || bottom > page[3];
}

/** Whether `value` is of the kind `field` takes, within its options and length. */
function valueFits(field: PdfField, value: FieldValue): boolean {
  switch (field.type) {
    case "text":
      return typeof value === "string" && (field.maxLength === undefined || [...value].length <= field.maxLength);
    case "checkbox":
      return typeof value === "boolean";
    case "radio":
    case "combo":
      return typeof value === "string" && (field.options ?? []).some((option) => option.value === value);
    case "list": {
      const chosen = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
      return chosen.length > 0 && chosen.every((choice) => (field.options ?? []).some((option) => option.value === choice));
    }
    default:
      return false;
  }
}

/** Whether a field's widgets, read back, carry `value` (a checkbox's `true` as its on-state). */
function readsBack(field: PdfField | undefined, widgets: readonly WidgetFacts[], value: FieldValue): boolean {
  if (field === undefined || widgets.length === 0) return false;
  const first = widgets[0] as WidgetFacts;
  switch (field.type) {
    case "text":
    case "combo":
      return first.value === value;
    case "checkbox":
      return widgets.some((widget) => widget.checked) === value;
    case "radio": {
      const selected = byControl(widgets).findIndex((widget) => widget.checked);
      return selected >= 0 && field.options?.[selected]?.value === value;
    }
    case "list": {
      const chosen = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
      const shown = first.selected.map((index) => field.options?.[index]?.value);
      return chosen.length === shown.length && chosen.every((choice) => shown.includes(choice));
    }
    default:
      return false;
  }
}

/** A field's widgets in control order, one per control (radio buttons sharing a state count once). */
function byControl(widgets: readonly WidgetFacts[]): WidgetFacts[] {
  const seen = new Set<number>();
  return [...widgets]
    .sort((a, b) => a.controlIndex - b.controlIndex)
    .filter((widget) => !seen.has(widget.controlIndex) && seen.add(widget.controlIndex));
}

/** An answer as the person writes it on the form: a box's yes or no, an option by the label the form shows. */
function shownValue(field: PdfField | undefined, value: FieldValue): string {
  if (typeof value === "boolean") return value ? "Yes (tick the box)" : "No (leave the box empty)";
  const label = (choice: string): string => field?.options?.find((option) => option.value === choice)?.shown ?? choice;
  return Array.isArray(value) ? value.map(label).join(", ") : label(value);
}

/** Up to five snippets of `text` around `phrase`, case-insensitive. */
function snippets(text: string, phrase: string): string {
  const lower = text.toLowerCase();
  const needle = phrase.toLowerCase();
  const parts: string[] = [];
  let from = 0;
  while (parts.length < 5) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    parts.push(text.slice(Math.max(0, at - SNIPPET_CONTEXT), at + needle.length + SNIPPET_CONTEXT));
    from = at + needle.length;
  }
  return parts.length === 0 ? text.slice(0, SNIPPET_CONTEXT * 2) : parts.join(" … ");
}
