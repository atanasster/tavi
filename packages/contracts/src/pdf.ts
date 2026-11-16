import { z } from "zod";

/**
 * Reading PDFs and filling PDF forms:
 * the four tools' inputs and results, and the bounded protocol between the
 * owner and its single-use parser child.
 *
 * The child is untrusted: everything it answers is parsed with these schemas
 * before the owner reads a field of it.
 */

// ------------------------------------------------------------------ limits

/** The owner's defaults under `pdf.*`. */
export const PDF_LIMITS = {
  /** Input size. */
  maxInputBytes: 25 * 1024 * 1024,
  /** Pages a document may have to be opened at all. */
  maxPages: 500,
  /** Pages one `pdf.read` call returns. */
  pagesPerTextCall: 40,
  /** Characters of text one `pdf.read` call returns; the rest is paginated with `nextPage`. */
  textPerCall: 40_000,
  /** Fields one document may have. */
  maxFields: 1_000,
  /** Pixels per rendered page. */
  maxPixelsPerPage: 4_000_000,
  /** Pages one `pdf.render` call renders. */
  pagesPerRenderCall: 3,
  /** The child's JS heap (`--max-old-space-size`). */
  childHeapMb: 192,
  /** The child's RSS cap: the watchdog's, and the cgroup's `memory.max`. */
  childRssMb: 384,
  /** Wall clock for reads. */
  timeoutMs: 20_000,
  /** Wall clock for fill and render, and for an OCR child's call. */
  heavyTimeoutMs: 60_000,
  /** Pages one `pdf.read` OCRs at most: pages whose text something is drawn over first, then image-only pages. */
  ocrPagesPerCall: 10,
  /** The resolution a page is rendered at for OCR: the most a render takes, an A4 page within `maxPixelsPerPage`. */
  ocrDpi: 200,
  /**
   * The most pages a document `pdf.view` hands the model whole may have: one read's pages, so every page is
   * checked for hidden text first (a model's own PDF parser would read it inline); below OpenAI's 100 a request.
   */
  viewMaxPages: 40,
  /** The most bytes such a document may have: under OpenAI's 32 MB a request once base64-encoded (4/3), with room for the rest. */
  viewMaxBytes: 20 * 1024 * 1024,
} as const;

/** The pages a fill's preview renders at most, and at what resolution. */
export const PDF_PREVIEW_MAX_PAGES = 10;
export const PDF_PREVIEW_DPI = 110;

// ------------------------------------------------------------------ inputs

export const PdfSourceSchema = z.union([
  z.strictObject({ artifactId: z.string().min(1).max(128).describe("An approved PDF artifact, e.g. a chat attachment") }),
  z.strictObject({ path: z.string().min(1).max(4_096).describe("A PDF in your working folder or an attached folder") }),
]);
export type PdfSource = z.infer<typeof PdfSourceSchema>;

/** `1-5,9`: pages and ranges, one-based. */
export const PageSetSchema = z
  .string()
  .max(64)
  .regex(/^\d{1,4}(-\d{1,4})?(,\d{1,4}(-\d{1,4})?)*$/);

/**
 * The pages a page set names, in order and without repeats, within
 * `1..pageCount`; at most `limit` of them. A range written backwards is
 * read forwards.
 */
export function pagesOf(set: string, pageCount: number, limit: number): number[] {
  const pages: number[] = [];
  const seen = new Set<number>();
  for (const part of set.split(",")) {
    const [startText, endText] = part.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    const [low, high] = start <= end ? [start, end] : [end, start];
    for (let page = Math.max(1, low); page <= Math.min(high, pageCount); page += 1) {
      if (seen.has(page)) continue;
      seen.add(page);
      pages.push(page);
      if (pages.length >= limit) return pages;
    }
  }
  return pages;
}

// ------------------------------------------------------------------ facts

export const HiddenReasonSchema = z.enum([
  "invisible-render",
  "background-colour",
  "tiny",
  "off-page",
  "hidden-layer",
  "covered",
  "zero-width",
]);
export type HiddenReason = z.infer<typeof HiddenReasonSchema>;
export const ActiveContentSchema = z.enum([
  "javascript",
  "open-action",
  "additional-actions",
  "submit-form",
  "import-data",
  "launch",
  "remote-goto",
  "uri",
  "embedded-file",
  "rich-media",
  "xfa",
]);
export type ActiveContent = z.infer<typeof ActiveContentSchema>;
export const PdfFormKindSchema = z.enum(["none", "acroform", "xfa-hybrid", "xfa-dynamic"]);
export type PdfFormKind = z.infer<typeof PdfFormKindSchema>;

export const DocumentFactsSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pageCount: z.number().int().min(0),
  encryption: z.enum(["none", "owner-only", "password"]),
  /** Permission bit 6, or bit 9 at R ≥ 3; true when unencrypted. */
  fillPermitted: z.boolean(),
  /** Permission bit 4 (modify the contents), which flattening needs; true when unencrypted. */
  modifyPermitted: z.boolean(),
  form: PdfFormKindSchema,
  fieldCount: z.number().int().min(0),
  /** `/FT /Sig` fields carrying a value; never "valid". */
  signatures: z.number().int().min(0),
  certification: z.enum(["P1", "P2", "P3"]).optional(),
  activeContent: z.array(ActiveContentSchema).max(16),
  /** Comments, notes and other annotations carrying text (not fields or links): a model's own PDF reader would take them in. Every engine counts them. */
  comments: z.number().int().min(0),
  /** Pages with under 200 characters of text: probably a scan. */
  imageOnlyPages: z.array(z.number().int()).max(500),
});
export type DocumentFacts = z.infer<typeof DocumentFactsSchema>;

/**
 * Why a signed form cannot be filled, or undefined: a signed or
 * DocMDP P2/P3 form is filled by an incremental update after its signed bytes;
 * P1 permits no change at all, and a signed form's active content could not be
 * stripped without changing what was signed.
 */
export function signedFillRefusal(
  facts: Pick<DocumentFacts, "certification" | "signatures" | "activeContent">,
): "certified" | "signed" | undefined {
  if (facts.certification === "P1") return "certified";
  if (facts.signatures > 0 && facts.activeContent.some((kind) => kind !== "uri")) return "signed";
  return undefined;
}

// ------------------------------------------------------------------ pdf.read

export const PdfReadInputSchema = z.strictObject({
  source: PdfSourceSchema,
  pages: PageSetSchema.optional().describe("Pages to read, e.g. 1-5,9; default from page 1"),
  find: z.string().min(2).max(200).optional().describe("Return only pages containing this phrase, with snippets"),
  format: z
    .enum(["text", "markdown"])
    .optional()
    .describe(
      "text (default): each page's text as the layer holds it; markdown: in reading order (columns in turn), tables as Markdown, running headers and footers dropped",
    ),
  ocr: z
    .enum(["auto", "off"])
    .optional()
    .describe(
      "auto (default): read scanned pages by OCR, and check pages for text drawn over, when the OCR add-on is installed; off: the text layer only",
    ),
});
export type PdfReadInput = z.infer<typeof PdfReadInputSchema>;

/** `pdf.view`: a whole PDF for the model to read where its connection takes one; its text and first pages anywhere else. */
export const PdfViewInputSchema = z.strictObject({
  source: PdfSourceSchema,
  pages: PageSetSchema.optional().describe(
    "Pages whose text and images stand in for the document where it cannot be sent whole; default from page 1",
  ),
});
export type PdfViewInput = z.infer<typeof PdfViewInputSchema>;

export const HiddenSpanSchema = z.strictObject({ reason: HiddenReasonSchema, text: z.string().max(2_000) });
export const PdfPageTextSchema = z.strictObject({
  page: z.number().int().min(1),
  text: z.string(),
  hidden: z.array(HiddenSpanSchema).max(32).optional(),
});
export type PdfPageText = z.infer<typeof PdfPageTextSchema>;

// ------------------------------------------------------------------ pdf.fields

export const FieldTypeSchema = z.enum(["text", "checkbox", "radio", "combo", "list", "signature", "button"]);
export type FieldType = z.infer<typeof FieldTypeSchema>;
export const UserOnlySchema = z.enum(["signature", "signature-like", "attestation"]);
export type UserOnly = z.infer<typeof UserOnlySchema>;
export const SensitiveSchema = z.enum(["birth-date", "health", "insurance", "government-id", "financial", "contact"]);
export type Sensitive = z.infer<typeof SensitiveSchema>;

export const FieldValueSchema = z.union([z.string().max(2_000), z.boolean(), z.array(z.string().max(200)).max(50)]);
export type FieldValue = z.infer<typeof FieldValueSchema>;

export const FieldOptionSchema = z.strictObject({
  /** The export value written to `/V` (a radio state name, a list or combo export). */
  value: z.string().max(200),
  /** What a viewer shows. */
  shown: z.string().max(200),
  /** `/Opt` display string, the state name itself, or the label search. */
  shownFrom: z.enum(["opt", "state-name", "nearby-text"]),
});
export type FieldOption = z.infer<typeof FieldOptionSchema>;

/** `[llx, lly, urx, ury]` in CropBox-relative PDF points. */
export const RectSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Rect = z.infer<typeof RectSchema>;

export const PdfFieldSchema = z.strictObject({
  /** The fully qualified name: the fill key. */
  id: z.string().min(1).max(512),
  type: FieldTypeSchema,
  page: z.number().int().min(1),
  rect: RectSchema,
  /** `/TU` tooltip, else the nearest text: the document's words. */
  label: z.string().max(200).optional(),
  value: FieldValueSchema.optional(),
  options: z.array(FieldOptionSchema).max(200).optional(),
  /** The checkbox export name when checked (its `/AP /N` key, e.g. "Yes", "1"). */
  onValue: z.string().max(200).optional(),
  /** Widget annotations of the field (radio buttons, cloned headers). */
  widgets: z.number().int().min(1).optional(),
  multiline: z.boolean().optional(),
  maxLength: z.number().int().optional(),
  /** Comb: `maxLength` cells of equal pitch. */
  comb: z.boolean().optional(),
  required: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  /** `/F` hidden or NoView, or a zero-size or off-page widget. */
  hidden: z.boolean().optional(),
  /** Only for conflicting unlinked terminal fields; a valid radio group is not flagged. */
  duplicateName: z.boolean().optional(),
  /** Never filled by Tavi. */
  userOnly: UserOnlySchema.optional(),
  sensitive: z.array(SensitiveSchema).max(6).optional(),
});
export type PdfField = z.infer<typeof PdfFieldSchema>;

export const PdfFieldsInputSchema = z.strictObject({ source: PdfSourceSchema });
export type PdfFieldsInput = z.infer<typeof PdfFieldsInputSchema>;
/**
 * An entry box of a flat form (`pdf.overlay`): where a person would
 * write, found from the page's vector structure (an underline, an empty
 * rectangle), named by the text beside it. Its id is the overlay's key.
 */
export const PdfEntryBoxSchema = z.strictObject({
  id: z.string().regex(/^p\d{1,4}\.b\d{1,4}$/),
  page: z.number().int().min(1),
  rect: RectSchema,
  label: z.string().max(200).optional(),
});
export type PdfEntryBox = z.infer<typeof PdfEntryBoxSchema>;
/** Entry boxes one flat form's `pdf.fields` lists at most. */
export const PDF_MAX_ENTRY_BOXES = 500;

// ------------------------------------------------------------------ pdf.render

export const PdfRenderInputSchema = z.strictObject({
  source: PdfSourceSchema,
  pages: PageSetSchema.describe("At most 3 pages"),
  dpi: z.number().int().min(50).max(200).optional(),
  highlight: z.array(z.string().max(512)).max(512).optional().describe("Field ids to outline in yellow"),
});
export type PdfRenderInput = z.infer<typeof PdfRenderInputSchema>;

// ------------------------------------------------------------------ pdf.fill

export const ValueTransformSchema = z.enum(["exact", "case", "digits", "date", "option-label"]);
export type ValueTransform = z.infer<typeof ValueTransformSchema>;
export const ValueSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file"),
    path: z.string().min(1).max(4_096),
    quote: z.string().min(1).max(500),
    transform: ValueTransformSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("attachment"),
    artifactId: z.string().min(1).max(128),
    quote: z.string().min(1).max(500),
    transform: ValueTransformSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("memory"),
    recordId: z.string().min(1).max(128),
    quote: z.string().min(1).max(500),
    transform: ValueTransformSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("person"), quote: z.string().min(1).max(500), transform: ValueTransformSchema.optional() }),
  z.strictObject({ kind: z.literal("document"), page: z.number().int().min(1), quote: z.string().min(1).max(500) }),
  z.strictObject({
    kind: z.literal("choice"),
    from: z.number().int().min(0).max(511).describe("Preceding row index (from < index, not choice)"),
    note: z.string().max(200),
  }),
]);
export type ValueSource = z.infer<typeof ValueSourceSchema>;

export const FillValueSchema = z.strictObject({
  field: z.string().min(1).max(512),
  value: FieldValueSchema,
  source: ValueSourceSchema,
});
export type FillValue = z.infer<typeof FillValueSchema>;

/** A `choice` row names a strictly preceding row that is not itself a `choice`. */
function choicesNameEarlierRows(input: { readonly values: readonly FillValue[] }, context: z.RefinementCtx): void {
  input.values.forEach((row, index) => {
    if (row.source.kind !== "choice") return;
    const from = input.values[row.source.from];
    if (row.source.from >= index || from === undefined || from.source.kind === "choice") {
      context.addIssue({
        code: "custom",
        path: ["values", index, "source", "from"],
        message: "a choice must name an earlier row whose source is not a choice",
      });
    }
  });
}

export const PdfFillInputSchema = z
  .strictObject({
    source: PdfSourceSchema,
    sourceSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("document.sha256 from pdf.fields"),
    output: z
      .string()
      .min(1)
      .max(4_096)
      .optional()
      .describe("A new .pdf path; default forms/<name>-filled.pdf in your own folder (a free variant if taken)"),
    values: z.array(FillValueSchema).min(1).max(512),
    flatten: z
      .boolean()
      .optional()
      .describe(
        "A final copy: the values become part of the pages and the fields go. Only when asked for one, and refused while the form has fields left for the person",
      ),
  })
  .superRefine(choicesNameEarlierRows);
export type PdfFillInput = z.infer<typeof PdfFillInputSchema>;

/**
 * `pdf.overlay`: a flat form — one with no fields — written over at its
 * entry boxes (`pdf.fields`' `boxes`), each value a line of text with its
 * source, checked and approved as `pdf.fill`'s are.
 */
export const PdfOverlayInputSchema = z
  .strictObject({
    source: PdfSourceSchema,
    sourceSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("document.sha256 from pdf.fields"),
    output: z
      .string()
      .min(1)
      .max(4_096)
      .optional()
      .describe("A new .pdf path; default forms/<name>-filled.pdf in your own folder (a free variant if taken)"),
    values: z
      .array(
        FillValueSchema.extend({
          field: z
            .string()
            .regex(/^p\d{1,4}\.b\d{1,4}$/)
            .describe("An entry box id from pdf.fields' boxes"),
          value: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(512),
  })
  .superRefine(choicesNameEarlierRows);
export type PdfOverlayInput = z.infer<typeof PdfOverlayInputSchema>;

/** A row's source status. */
export const SourceStatusSchema = z.enum(["verified", "unmatched", "document", "choice"]);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

// ------------------------------------------------------------------ the child protocol

/**
 * Why the child would not, or could not, answer. Each maps to a sentence the
 * owner shows; none carries the document's words.
 */
export const PdfRefusalSchema = z.enum([
  "not-a-pdf",
  "malformed",
  "password",
  "too-many-pages",
  "too-large",
  "signed",
  "certified",
  "xfa-dynamic",
  "flatten-not-permitted",
  "has-fields",
  "unknown-field",
  "user-only-field",
  "locked-field",
  "bad-value",
  "font-missing",
  "document-quote",
  "verification-failed",
]);
export type PdfRefusal = z.infer<typeof PdfRefusalSchema>;

/** The fill the child performs: values already checked by the owner, re-checked in the child. */
export const PdfFillPlanSchema = z.strictObject({
  values: z
    .array(
      z.strictObject({
        field: z.string().min(1).max(512),
        value: FieldValueSchema,
        /** A `document` row's quote and page: checked against that page's visible text in the child. */
        documentQuote: z.strictObject({ page: z.number().int().min(1), quote: z.string().min(1).max(500) }).optional(),
      }),
    )
    .min(1)
    .max(512),
  /** Whether to render previews: the child picks the pages holding filled fields and answers them in `previewPages`. */
  preview: z.boolean(),
  /** A final copy: the values drawn into the pages, the fields removed. */
  flatten: z.boolean().optional(),
});
export type PdfFillPlan = z.infer<typeof PdfFillPlanSchema>;

const LimitsHeaderSchema = z.strictObject({
  maxPages: z.number().int().min(1).max(100_000),
  maxFields: z.number().int().min(1).max(100_000),
  maxPixelsPerPage: z.number().int().min(1),
  textPerCall: z.number().int().min(1),
  pagesPerTextCall: z.number().int().min(1),
});
export type PdfChildLimits = z.infer<typeof LimitsHeaderSchema>;

/** A user password the owner read from the credential store for this document: never a tool input. */
const PasswordSchema = z.string().min(1).max(127);

/** The JSON header of a request frame. */
export const PdfChildRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("facts"), limits: LimitsHeaderSchema, password: PasswordSchema.optional() }),
  z.strictObject({
    op: z.literal("read"),
    limits: LimitsHeaderSchema,
    password: PasswordSchema.optional(),
    pages: PageSetSchema.optional(),
    find: z.string().min(2).max(200).optional(),
    format: z.enum(["text", "markdown"]).optional(),
  }),
  z.strictObject({ op: z.literal("fields"), limits: LimitsHeaderSchema, password: PasswordSchema.optional() }),
  z.strictObject({
    op: z.literal("render"),
    limits: LimitsHeaderSchema,
    password: PasswordSchema.optional(),
    pages: z.array(z.number().int().min(1)).min(1).max(PDF_PREVIEW_MAX_PAGES),
    dpi: z.number().int().min(50).max(200),
    highlight: z.array(z.string().max(512)).max(512),
    outlineUserOnly: z.boolean(),
  }),
  z.strictObject({ op: z.literal("fill"), limits: LimitsHeaderSchema, password: PasswordSchema.optional(), plan: PdfFillPlanSchema }),
  /** A flat form written over at its entry boxes: each value's `field` is a box id. */
  z.strictObject({ op: z.literal("overlay"), limits: LimitsHeaderSchema, password: PasswordSchema.optional(), plan: PdfFillPlanSchema }),
]);
export type PdfChildRequest = z.infer<typeof PdfChildRequestSchema>;

/** What a fill answers besides its document bytes. */
export const PdfChildFillSchema = z.strictObject({
  filled: z.number().int().min(0),
  readBack: z.array(z.strictObject({ field: z.string().max(512), ok: z.boolean() })).max(512),
  leftUserOnly: z.array(z.string().max(512)).max(1_000),
  leftRequired: z.array(z.string().max(512)).max(1_000),
  incremental: z.boolean(),
  /** The form does not permit filling: the document is a plain answer sheet to copy by hand. */
  answerSheet: z.boolean(),
  /** The fields were flattened into the pages. */
  flattened: z.boolean().optional(),
  previewPages: z.array(z.number().int().min(1)).max(PDF_PREVIEW_MAX_PAGES),
});
export type PdfChildFill = z.infer<typeof PdfChildFillSchema>;

/**
 * The OCR child's request: the PNGs travel as binary sections, one per
 * page named here, in order. One language, English, is what the add-on ships.
 */
export const PdfOcrRequestSchema = z.strictObject({
  op: z.literal("ocr"),
  language: z.literal("eng"),
  pages: z.array(z.number().int().min(1)).min(1).max(PDF_LIMITS.ocrPagesPerCall),
});
export type PdfOcrRequest = z.infer<typeof PdfOcrRequestSchema>;

export const PdfOcrPageSchema = z.strictObject({
  page: z.number().int().min(1),
  text: z.string().max(PDF_LIMITS.textPerCall),
  /** Tesseract's mean word confidence, 0 to 100. */
  confidence: z.number().min(0).max(100),
});
export type PdfOcrPage = z.infer<typeof PdfOcrPageSchema>;

export const PdfOcrResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    pages: z.array(PdfOcrPageSchema).max(PDF_LIMITS.ocrPagesPerCall),
    maxRssKb: z.number().int().min(0),
  }),
  /** An image Tesseract could not read; nothing of it goes back. */
  z.strictObject({ ok: z.literal(false), refused: z.literal("unreadable-image"), maxRssKb: z.number().int().min(0) }),
]);
export type PdfOcrResponse = z.infer<typeof PdfOcrResponseSchema>;

/** The JSON section of a response frame. PNG frames and the filled document travel as binary sections. */
export const PdfChildResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    facts: DocumentFactsSchema,
    pages: z.array(PdfPageTextSchema).max(40).optional(),
    nextPage: z.number().int().optional(),
    truncated: z.boolean().optional(),
    /**
     * Where a read's text lies under something opaque drawn over it: `[start, end)` of a page's `text`. The
     * owner OCRs the page's render and moves a span the render does not show to `hidden`, as `covered`.
     */
    coverSpans: z
      .array(z.strictObject({ page: z.number().int().min(1), start: z.number().int().min(0), end: z.number().int().min(0) }))
      .max(512)
      .optional(),
    /** Pages not looked at whole for hidden or covered text: a `find` read's snippets, a page past the objects or characters looked at. */
    coverUnchecked: z.array(z.number().int().min(1)).max(40).optional(),
    fields: z.array(PdfFieldSchema).max(1_000).optional(),
    boxes: z.array(PdfEntryBoxSchema).max(PDF_MAX_ENTRY_BOXES).optional(),
    rendered: z
      .array(z.strictObject({ page: z.number().int().min(1), width: z.number().int().min(1), height: z.number().int().min(1) }))
      .max(PDF_PREVIEW_MAX_PAGES)
      .optional(),
    fill: PdfChildFillSchema.optional(),
    /** The child's own high-water mark, `process.resourceUsage().maxRSS`, in KiB. */
    maxRssKb: z.number().int().min(0),
  }),
  z.strictObject({
    ok: z.literal(false),
    refused: PdfRefusalSchema,
    /** A field id, for a field refusal; never document text. */
    field: z.string().max(512).optional(),
    maxRssKb: z.number().int().min(0),
  }),
]);
export type PdfChildResponse = z.infer<typeof PdfChildResponseSchema>;

/** Binary framing on the child's stdio. */
export const PDF_FRAME = {
  /** The initialization frame's magic, ahead of its type byte. */
  magic: "PDF0",
  wasm: 0x01,
  request: 0x02,
  /** The OCR child's request: `0x03 jsonLen:u32be json count:u8 (page:u16be pngLen:u32be png)*`. */
  ocrRequest: 0x03,
  /** Section caps, checked from each length prefix before its bytes are read. */
  maxJsonBytes: 4 * 1024 * 1024,
  maxPngBytes: 16 * 1024 * 1024,
  maxPngFrames: 10,
  /** The filled document: at most the input × 1.5 + 4 MiB, and never above this. */
  maxDocumentBytes: 40 * 1024 * 1024,
  maxFonts: 4,
  maxFontBytes: 24 * 1024 * 1024,
  maxWasmBytes: 16 * 1024 * 1024,
} as const;

/** The largest filled document the owner accepts for an input of `inputBytes`. */
export function maxFilledBytes(inputBytes: number): number {
  return Math.min(Math.floor(inputBytes * 1.5) + 4 * 1024 * 1024, PDF_FRAME.maxDocumentBytes);
}
