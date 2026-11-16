import fontkit from "@cantoo/fontkit";
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFTextField,
  PDFStream,
  type DocumentSnapshot,
  type PDFField,
  type PDFFont,
  type PDFObject,
} from "@cantoo/pdf-lib";
import type { ActiveContent, FieldValue } from "@tavi/contracts";

/**
 * The writer over patched `@cantoo/pdf-lib`: the field mechanics PDFium does not expose (`/Opt` pairs,
 * on-state names), optional content and XFA, the active-content inventory
 * and the sanitise pass, values with appearances in an embedded font, and
 * full or incremental saves.
 */

export interface WriterDocument {
  readonly document: PDFDocument;
  /** The bytes it was loaded from, for an incremental save's prefix. */
  readonly original: Uint8Array;
  readonly encrypted: boolean;
}

/** Load for reading facts, or for a fill (incremental when `incremental`), with the user `password` it may need. The Producer is never stamped. */
export async function loadWriter(bytes: Uint8Array, incremental = false, password = ""): Promise<WriterDocument> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false, preserveXFA: true, password, forIncrementalUpdate: incremental });
  document.registerFontkit(fontkit);
  return { document, original: bytes, encrypted: document.isEncrypted };
}

// ------------------------------------------------------------------ dictionary helpers

const name = (value: string): PDFName => PDFName.of(value);

function lookupDict(dict: PDFDict | undefined, key: string): PDFDict | undefined {
  const value = dict?.lookup(name(key));
  return value instanceof PDFDict ? value : undefined;
}

function lookupArray(dict: PDFDict | undefined, key: string): PDFArray | undefined {
  const value = dict?.lookup(name(key));
  return value instanceof PDFArray ? value : undefined;
}

/** A PDF text string's value, or a name's. */
function textOf(object: PDFObject | undefined): string | undefined {
  if (object instanceof PDFString || object instanceof PDFHexString) return object.decodeText();
  if (object instanceof PDFName) return object.decodeText();
  return undefined;
}

// ------------------------------------------------------------------ optional content and XFA

/** The names of optional-content groups off by default (`/OCProperties /D /OFF`). */
export function offLayerNames(writer: WriterDocument): Set<string> {
  const properties = lookupDict(writer.document.catalog, "OCProperties");
  const off = lookupArray(lookupDict(properties, "D"), "OFF");
  const names = new Set<string>();
  if (off === undefined) return names;
  for (let index = 0; index < Math.min(off.size(), 1_000); index += 1) {
    const group = off.lookup(index);
    const label = group instanceof PDFDict ? textOf(group.lookup(name("Name"))) : undefined;
    if (label !== undefined) names.add(label);
  }
  return names;
}

/** Whether the AcroForm carries an `/XFA` packet. */
export function hasXfa(writer: WriterDocument): boolean {
  return lookupDict(writer.document.catalog, "AcroForm")?.has(name("XFA")) === true;
}

// ------------------------------------------------------------------ active content

/** Action types that run, reach out or bring files in. */
const ACTION_KINDS: Readonly<Record<string, ActiveContent>> = {
  JavaScript: "javascript",
  SubmitForm: "submit-form",
  ImportData: "import-data",
  Launch: "launch",
  GoToR: "remote-goto",
  GoToE: "remote-goto",
  URI: "uri",
  RichMediaExecute: "rich-media",
  Rendition: "rich-media",
  Sound: "rich-media",
  Movie: "rich-media",
};

/** The walk is bounded: a crafted document cannot make it loop or run long. */
const MAX_WALK = 20_000;

interface Walk {
  readonly found: Set<ActiveContent>;
  readonly seen: Set<PDFDict>;
  budget: number;
}

/** An action dictionary and its `/Next` chain. */
function recordAction(walk: Walk, action: PDFObject | undefined): void {
  let current = action;
  for (let depth = 0; depth < 64 && current !== undefined; depth += 1) {
    if (current instanceof PDFArray) {
      for (let index = 0; index < current.size(); index += 1) recordAction(walk, current.lookup(index));
      return;
    }
    if (!(current instanceof PDFDict) || walk.seen.has(current) || walk.budget-- <= 0) return;
    walk.seen.add(current);
    const kind = textOf(current.lookup(name("S")));
    const found = kind === undefined ? undefined : ACTION_KINDS[kind];
    if (found !== undefined) walk.found.add(found);
    current = current.lookup(name("Next"));
  }
}

function recordAdditional(walk: Walk, dict: PDFDict): void {
  const additional = lookupDict(dict, "AA");
  if (additional === undefined) return;
  walk.found.add("additional-actions");
  for (const key of additional.keys()) recordAction(walk, additional.lookup(key));
}

/** The document's active content, in plain words: reported, never run. */
export function activeContent(writer: WriterDocument): ActiveContent[] {
  const document = writer.document;
  const walk: Walk = { found: new Set(), seen: new Set(), budget: MAX_WALK };
  const catalog = document.catalog;
  const names = lookupDict(catalog, "Names");
  if (lookupDict(names, "JavaScript") !== undefined) walk.found.add("javascript");
  if (lookupDict(names, "EmbeddedFiles") !== undefined) walk.found.add("embedded-file");
  // An opening GoTo is navigation, unless its `/Next` chain does more.
  const open = catalog.lookup(name("OpenAction"));
  if (open instanceof PDFDict && actionChain(open).some((action) => textOf(action.lookup(name("S"))) !== "GoTo")) {
    walk.found.add("open-action");
    recordAction(walk, open);
  }
  recordAdditional(walk, catalog);
  if (hasXfa(writer)) walk.found.add("xfa");
  for (const page of document.getPages()) {
    if (walk.budget <= 0) break;
    recordAdditional(walk, page.node);
    const annots = page.node.Annots();
    for (let index = 0; annots !== undefined && index < annots.size() && walk.budget > 0; index += 1) {
      const annot = annots.lookup(index);
      if (!(annot instanceof PDFDict)) continue;
      walk.budget -= 1;
      const subtype = textOf(annot.lookup(name("Subtype")));
      if (subtype === "FileAttachment") walk.found.add("embedded-file");
      if (subtype === "RichMedia" || subtype === "Movie" || subtype === "Screen" || subtype === "Sound" || subtype === "3D")
        walk.found.add("rich-media");
      recordAction(walk, annot.lookup(name("A")));
      recordAdditional(walk, annot);
      // A widget's field parents can carry actions too.
      let parent = lookupDict(annot, "Parent");
      for (let depth = 0; parent !== undefined && depth < 32; depth += 1) {
        recordAdditional(walk, parent);
        parent = lookupDict(parent, "Parent");
      }
    }
  }
  walkOutline(walk, lookupDict(lookupDict(catalog, "Outlines"), "First"));
  return [...walk.found].sort();
}

function walkOutline(walk: Walk, first: PDFDict | undefined): void {
  const stack: PDFDict[] = first === undefined ? [] : [first];
  while (stack.length > 0 && walk.budget-- > 0) {
    const item = stack.pop() as PDFDict;
    if (walk.seen.has(item)) continue;
    walk.seen.add(item);
    recordAction(walk, item.lookup(name("A")));
    const next = lookupDict(item, "Next");
    const child = lookupDict(item, "First");
    if (next !== undefined) stack.push(next);
    if (child !== undefined) stack.push(child);
  }
}

/** Action types the sanitiser removes; `URI` links stay (reported, never followed), and `GoTo` is navigation. */
const STRIPPED_ACTIONS = new Set([
  "JavaScript",
  "SubmitForm",
  "ImportData",
  "Launch",
  "GoToR",
  "GoToE",
  "RichMediaExecute",
  "Rendition",
  "Sound",
  "Movie",
]);
const STRIPPED_ANNOTS = new Set(["FileAttachment", "RichMedia", "Movie", "Screen", "Sound", "3D"]);

/** An action and every action its `/Next` chain reaches (a dictionary or an array of them), bounded and cycle-safe. */
function actionChain(action: PDFObject | undefined): PDFDict[] {
  const chain: PDFDict[] = [];
  const seen = new Set<PDFDict>();
  const stack: PDFObject[] = action === undefined ? [] : [action];
  while (stack.length > 0 && chain.length < 256) {
    const current = stack.pop();
    if (current instanceof PDFArray) {
      for (let index = Math.min(current.size(), 256) - 1; index >= 0; index -= 1) {
        const item = current.lookup(index);
        if (item !== undefined) stack.push(item);
      }
      continue;
    }
    if (!(current instanceof PDFDict) || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    const next = current.lookup(name("Next"));
    if (next !== undefined) stack.push(next);
  }
  return chain;
}

/** Whether an action, or any action its `/Next` chain reaches, is one the sanitiser removes. */
function stripsAction(action: PDFObject | undefined): boolean {
  return actionChain(action).some((link) => STRIPPED_ACTIONS.has(textOf(link.lookup(name("S"))) ?? ""));
}

/**
 * Strip active content from the document before it is written: names-tree JavaScript and embedded files, an
 * `/OpenAction` other than GoTo, every `/AA`, scripted, submitting,
 * importing, launching and remote actions, media and file annotations, and
 * an XFA hybrid's `/XFA` packets and `/NeedsRendering`; and neutralise the
 * `/Info` Producer, Creator and Author and the XMP `/Metadata`.
 */
export function sanitize(writer: WriterDocument): void {
  const document = writer.document;
  const catalog = document.catalog;
  const names = lookupDict(catalog, "Names");
  names?.delete(name("JavaScript"));
  names?.delete(name("EmbeddedFiles"));
  const open = catalog.lookup(name("OpenAction"));
  if (open instanceof PDFDict && actionChain(open).some((action) => textOf(action.lookup(name("S"))) !== "GoTo"))
    catalog.delete(name("OpenAction"));
  catalog.delete(name("AA"));
  catalog.delete(name("Metadata"));
  // An XFA hybrid's XFA layer goes: a viewer that read it would show its own data over the
  // AcroForm values just written, and its packets are never parsed here.
  const acroForm = lookupDict(catalog, "AcroForm");
  const xfa = acroForm?.get(name("XFA"));
  // Its packet streams too, not only the key: a full save would still write them, unreferenced.
  const packets = xfa instanceof PDFRef ? [xfa] : [];
  const array = xfa instanceof PDFRef ? document.context.lookup(xfa) : xfa;
  if (array instanceof PDFArray)
    for (let index = 0; index < array.size(); index += 1) {
      const entry = array.get(index);
      if (entry instanceof PDFRef) packets.push(entry);
    }
  for (const ref of packets) document.context.delete(ref);
  acroForm?.delete(name("XFA"));
  catalog.delete(name("NeedsRendering"));
  for (const page of document.getPages()) {
    page.node.delete(name("AA"));
    const annots = page.node.Annots();
    if (annots === undefined) continue;
    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      const annot = annots.lookup(index);
      if (!(annot instanceof PDFDict)) continue;
      if (STRIPPED_ANNOTS.has(textOf(annot.lookup(name("Subtype"))) ?? "")) {
        annots.remove(index);
        continue;
      }
      annot.delete(name("AA"));
      if (stripsAction(annot.lookup(name("A")))) annot.delete(name("A"));
      let parent = lookupDict(annot, "Parent");
      for (let depth = 0; parent !== undefined && depth < 32; depth += 1) {
        parent.delete(name("AA"));
        parent = lookupDict(parent, "Parent");
      }
    }
  }
  const stack: PDFDict[] = [];
  const first = lookupDict(lookupDict(catalog, "Outlines"), "First");
  if (first !== undefined) stack.push(first);
  const seen = new Set<PDFDict>();
  while (stack.length > 0 && seen.size < MAX_WALK) {
    const item = stack.pop() as PDFDict;
    if (seen.has(item)) continue;
    seen.add(item);
    if (stripsAction(item.lookup(name("A")))) item.delete(name("A"));
    for (const key of ["Next", "First"]) {
      const next = lookupDict(item, key);
      if (next !== undefined) stack.push(next);
    }
  }
  document.setProducer("");
  document.setCreator("");
  document.setAuthor("");
}

// ------------------------------------------------------------------ field mechanics

/** What PDFium does not say of a field. */
export interface FieldMechanics {
  /** `/Opt` as `[export, display]` pairs (a choice field), or per-widget labels (a button). */
  readonly opt?: readonly { readonly value: string; readonly shown: string }[];
  /** Each widget's on-state name, in widget order (checkboxes and radios). */
  readonly onStates: readonly string[];
  readonly maxLength?: number;
  readonly comb: boolean;
  /** More than one terminal field carries this name. */
  readonly duplicate: boolean;
}

export function fieldMechanics(writer: WriterDocument): Map<string, FieldMechanics> {
  const fields = writer.document.getForm().getFields();
  const counts = new Map<string, number>();
  for (const field of fields) counts.set(field.getName(), (counts.get(field.getName()) ?? 0) + 1);
  const mechanics = new Map<string, FieldMechanics>();
  for (const field of fields) {
    const fieldName = field.getName();
    const widgets = field.acroField.getWidgets();
    const onStates =
      field instanceof PDFCheckBox || field instanceof PDFRadioGroup
        ? widgets.map((widget) => widget.getOnValue()?.decodeText() ?? "")
        : [];
    let opt: FieldMechanics["opt"];
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      opt = field.acroField.getOptions().map((option) => ({ value: option.value.decodeText(), shown: option.display.decodeText() }));
    } else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
      const exports = field.acroField.getExportValues();
      if (exports !== undefined) opt = exports.map((value, index) => ({ value: onStates[index] ?? "", shown: value.decodeText() }));
    }
    mechanics.set(fieldName, {
      ...(opt === undefined ? {} : { opt }),
      onStates,
      ...(field instanceof PDFTextField && field.getMaxLength() !== undefined ? { maxLength: field.getMaxLength() as number } : {}),
      comb: field instanceof PDFTextField && field.isCombed(),
      duplicate: (counts.get(fieldName) ?? 0) > 1,
    });
  }
  return mechanics;
}

// ------------------------------------------------------------------ fill

export type FillOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly refused: "unknown-field" | "bad-value" | "font-missing"; readonly field: string };

/** The first font among `fonts` that has a glyph for every character of `text`. */
function fontFor(
  fonts: readonly { readonly font: PDFFont; readonly covers: (text: string) => boolean }[],
  text: string,
): PDFFont | undefined {
  return fonts.find((candidate) => candidate.covers(text))?.font;
}

/** Embed each font, subset, with a coverage test from its own glyph map. */
export async function embedFonts(
  writer: WriterDocument,
  fonts: readonly Uint8Array[],
): Promise<{ readonly font: PDFFont; readonly covers: (text: string) => boolean }[]> {
  const embedded = [];
  for (const bytes of fonts) {
    const parsed = fontkit.create(bytes);
    // A collection (`.ttc`) is not a font the writer embeds.
    if (!("hasGlyphForCodePoint" in parsed)) throw new Error("a font collection cannot be embedded");
    const font = await writer.document.embedFont(bytes, { subset: true });
    const covers = (text: string): boolean =>
      [...text].every((char) => /\s/.test(char) || parsed.hasGlyphForCodePoint(char.codePointAt(0) ?? 0));
    embedded.push({ font, covers });
  }
  return embedded;
}

/** Set a radio group's `/V` to `state` and each widget's `/AS` to it where the widget has that state, else `/Off`. */
function selectRadio(field: PDFRadioGroup, state: string): boolean {
  const widgets = field.acroField.getWidgets();
  const states = widgets.map((widget) => widget.getOnValue()?.decodeText());
  if (!states.includes(state)) return false;
  field.acroField.dict.set(name("V"), name(state));
  for (const widget of widgets) widget.setAppearanceState(widget.getOnValue()?.decodeText() === state ? name(state) : name("Off"));
  return true;
}

/** The size an auto-sized single-line field gets at most. */
const MAX_AUTO_SIZE = 12;
/** The default appearance a field with none anywhere gets: black, the standard Helvetica, auto size. */
const FALLBACK_APPEARANCE = "0 g /Helv 0 Tf";
const TF = /(\d*\.?\d+)(\s+Tf)/;

/**
 * A text field's or dropdown's font size, fitted to its widget for `font`
 * and `value`. pdf-lib centres a single line (and a comb's cells) on the
 * ascender alone, so a font with a deep descender at the size a form asks
 * for, or at pdf-lib's auto size, overflows the box at the bottom. A single
 * line gets the form's size (or 12) capped at what that layout fits in height
 * and, at the same size, in width (per cell for a comb). A multi-line field
 * keeps the form's size when its wrapped lines fit, else pdf-lib's auto size,
 * which measures with the descender.
 *
 * The size is written into the `/DA` of the field and of each widget (pdf-lib
 * reads a widget's own first), from the first `/DA` found on the widget, the
 * field or the form; `setFontSize` is not used, since it throws on a field
 * with no `/DA` of its own and on size 0.
 */
function fitFontSize(field: PDFTextField | PDFDropdown, font: PDFFont, value: string, formAppearance: string | undefined): void {
  const widgets = field.acroField.getWidgets();
  const appearances = [...widgets.map((widget) => widget.getDefaultAppearance()), field.acroField.getDefaultAppearance(), formAppearance];
  const sizeOf = (appearance: string | undefined): number => Number(TF.exec(appearance ?? "")?.[1] ?? 0);
  const given = appearances.map(sizeOf).find((size) => size > 0) ?? 0;
  const base = appearances.find((appearance) => appearance !== undefined && TF.test(appearance)) ?? FALLBACK_APPEARANCE;
  const rectangle = widgets.map((widget) => widget.getRectangle()).reduce((small, next) => (next.height < small.height ? next : small));
  // The layout's box: the widget less its border and a point of padding each side.
  const inner = { width: rectangle.width - 4, height: rectangle.height - 4 };
  const ascent = font.heightAtSize(1, { descender: false });
  const descent = font.heightAtSize(1) - ascent;
  let size: number;
  if (field instanceof PDFTextField && field.isMultiline()) {
    const wrapped = (at: number): number =>
      value
        .split(/\r?\n/)
        .reduce((lines, paragraph) => lines + Math.max(1, Math.ceil(font.widthOfTextAtSize(paragraph, at) / inner.width)), 0);
    size = given > 0 && wrapped(given) * 1.2 * (ascent + descent) * given <= inner.height ? given : 0;
  } else {
    const height = (inner.height / 2 - 0.5) / (ascent / 2 + descent);
    const cells = field instanceof PDFTextField && field.isCombed() ? field.getMaxLength() : undefined;
    const width =
      cells === undefined
        ? inner.width / Math.max(font.widthOfTextAtSize(value, 1), 0.001)
        : (0.75 * (rectangle.width / cells)) / Math.max(...[...value].map((char) => font.widthOfTextAtSize(char, 1)), 0.001);
    size = Math.max(4, Math.floor(Math.min(given > 0 ? given : MAX_AUTO_SIZE, height, width) * 10) / 10);
  }
  const sized = base.replace(TF, `${size}$2`);
  field.acroField.setDefaultAppearance(sized);
  for (const widget of widgets) widget.setDefaultAppearance(sized);
}

/**
 * Select options of a choice field by index. `/V` holds their export values
 * (what a viewer submits and reads back), `/I` their indices; the appearance
 * shows what the form shows, the display strings. pdf-lib's own `setValues`
 * checks values against the display strings and draws `/V`, so it is not used.
 */
function selectChoice(field: PDFDropdown | PDFOptionList, indices: readonly number[], font: PDFFont): void {
  const acro = field.acroField;
  const options = acro.getOptions();
  const pick = (strings: readonly (PDFString | PDFHexString)[]): PDFObject =>
    strings.length === 1 ? (strings[0] as PDFString | PDFHexString) : acro.dict.context.obj([...strings]);
  acro.dict.set(name("V"), pick(indices.map((index) => (options[index] as (typeof options)[number]).display)));
  field.updateAppearances(font);
  acro.dict.set(name("V"), pick(indices.map((index) => (options[index] as (typeof options)[number]).value)));
  if (indices.length > 1) acro.dict.set(name("I"), acro.dict.context.obj([...indices].sort((a, b) => a - b)));
  else acro.dict.delete(name("I"));
}

/**
 * Write `values` into the form, with appearances generated from the embedded
 * fonts (the first that covers each value). Values arrive checked by the
 * owner; the field kind and options are checked again here.
 */
export function fill(
  writer: WriterDocument,
  values: readonly { readonly field: string; readonly value: FieldValue }[],
  fonts: readonly { readonly font: PDFFont; readonly covers: (text: string) => boolean }[],
): FillOutcome {
  const form = writer.document.getForm();
  const formAppearance = textOf(form.acroForm.dict.lookup(name("DA")));
  const byName = new Map<string, PDFField>();
  for (const field of form.getFields()) if (!byName.has(field.getName())) byName.set(field.getName(), field);
  for (const { field: fieldName, value } of values) {
    const field = byName.get(fieldName);
    if (field === undefined) return { ok: false, refused: "unknown-field", field: fieldName };
    const bad: FillOutcome = { ok: false, refused: "bad-value", field: fieldName };
    // No embedded font draws it: the value is fine, a font is missing (a CJK or Arabic name, say: the core font has neither).
    const noFont: FillOutcome = { ok: false, refused: "font-missing", field: fieldName };
    if (field instanceof PDFTextField) {
      if (typeof value !== "string") return bad;
      const maxLength = field.getMaxLength();
      if (maxLength !== undefined && [...value].length > maxLength) return bad;
      const font = fontFor(fonts, value);
      if (font === undefined) return noFont;
      field.setText(value);
      fitFontSize(field, font, value, formAppearance);
      field.updateAppearances(font);
    } else if (field instanceof PDFCheckBox) {
      if (typeof value !== "boolean") return bad;
      if (value) field.check();
      else field.uncheck();
    } else if (field instanceof PDFRadioGroup) {
      if (typeof value !== "string" || !selectRadio(field, value)) return bad;
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const chosen = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
      const options = field.acroField.getOptions();
      if (chosen === undefined || chosen.length === 0 || (field instanceof PDFDropdown && chosen.length > 1)) return bad;
      const indices = chosen.map((choice) => options.findIndex((option) => option.value.decodeText() === choice));
      if (indices.some((index) => index < 0)) return bad;
      if (chosen.length > 1 && !field.isMultiselect()) return bad;
      // A dropdown draws its chosen option; a list box draws every option.
      const drawn = field instanceof PDFDropdown ? indices.map((index) => options[index] as (typeof options)[number]) : options;
      const font = fontFor(fonts, drawn.map((option) => option.display.decodeText()).join(""));
      if (font === undefined) return noFont;
      if (field instanceof PDFDropdown) fitFontSize(field, font, (drawn[0] as (typeof drawn)[number]).display.decodeText(), formAppearance);
      selectChoice(field, indices, font);
    } else {
      return bad;
    }
  }
  return { ok: true };
}

/** Each indirect object's serialised form, for finding what a fill changed (a stream by its dictionary and length). */
export function fingerprints(writer: WriterDocument): Map<number, string> {
  const prints = new Map<number, string>();
  for (const [ref, object] of writer.document.context.enumerateIndirectObjects()) prints.set(ref.objectNumber, fingerprint(object));
  return prints;
}

function fingerprint(object: PDFObject): string {
  if (object instanceof PDFStream) return `${object.dict.toString()}#${object.getContentsSize()}`;
  return object.toString();
}

/**
 * The fields a signature locks (`/Lock`, ISO 32000-1 §12.7.4.5): of a signed
 * signature field only, `All`, the `Include` list, or every field but the
 * `Exclude` list. A fill may not change one: that would break the signature.
 */
export function signatureLocked(writer: WriterDocument): (field: string) => boolean {
  const rules: ((field: string) => boolean)[] = [];
  for (const field of writer.document.getForm().getFields()) {
    const dict = field.acroField.dict;
    if (textOf(dict.lookup(name("FT"))) !== "Sig" || dict.lookup(name("V")) === undefined) continue;
    const lock = lookupDict(dict, "Lock");
    if (lock === undefined) continue;
    const listed = new Set<string>();
    const list = lookupArray(lock, "Fields");
    for (let index = 0; index < (list?.size() ?? 0); index += 1) {
      const entry = textOf(list?.lookup(index));
      if (entry !== undefined) listed.add(entry);
    }
    const action = textOf(lock.lookup(name("Action")));
    // PDF 2.0's `/P 1`: no change at all after this signature. An action this reader does not know locks
    // everything too: a signature is never risked on a guess.
    const noChanges = lock.lookup(name("P"));
    if (noChanges instanceof PDFNumber && noChanges.asNumber() === 1) rules.push(() => true);
    else rules.push(action === "Include" ? (id) => listed.has(id) : action === "Exclude" ? (id) => !listed.has(id) : () => true);
  }
  return (field) => rules.some((locked) => locked(field));
}

/**
 * Mark for an incremental save every object that differs from `before`: the
 * fork saves only objects it was told changed, and edits made in place to a
 * dictionary (a field's `/V`, a sanitised `/AA`) are not tracked.
 */
export function markChanged(writer: WriterDocument, snapshot: DocumentSnapshot, before: ReadonlyMap<number, string>): void {
  for (const [ref, object] of writer.document.context.enumerateIndirectObjects()) {
    if (before.get(ref.objectNumber) !== fingerprint(object)) snapshot.markRefForSave(ref);
  }
}

/** The document's bytes: a full rewrite, or the original followed by an incremental update. */
export async function saveWriter(writer: WriterDocument, snapshot: DocumentSnapshot | undefined): Promise<Uint8Array> {
  if (snapshot === undefined) return writer.document.save({ updateFieldAppearances: false, useObjectStreams: false });
  const update = await writer.document.saveIncremental(snapshot, { useObjectStreams: false });
  const out = new Uint8Array(writer.original.length + update.length);
  out.set(writer.original);
  out.set(update, writer.original.length);
  return out;
}

// ------------------------------------------------------------------ overlay

/** The largest and smallest text an overlay writes, in points. */
const OVERLAY_MAX_SIZE = 11;
const OVERLAY_MIN_SIZE = 6;

/**
 * The text size `value` is written at in a box `width` by `height` points:
 * a line's worth of the box's height, at most `OVERLAY_MAX_SIZE`, made
 * smaller until it fits the width; undefined when it fits at no size from
 * `OVERLAY_MIN_SIZE` up. A value is one line.
 */
function overlaySize(font: PDFFont, value: string, width: number, height: number): number | undefined {
  if (/[\r\n]/.test(value)) return undefined;
  let size = Math.min(OVERLAY_MAX_SIZE, Math.floor(height * 0.75 * 2) / 2);
  while (size >= OVERLAY_MIN_SIZE) {
    if (font.widthOfTextAtSize(value, size) <= width - 4) return size;
    size -= 0.5;
  }
  return undefined;
}

/**
 * Write each value as a FreeText annotation over its entry box
 * (`pdf.overlay`): printed, its text in `/Contents`, drawn by an appearance
 * stream in an embedded font, so every viewer shows what was approved. A
 * value no font covers, or one that fits the box at no allowed size, is
 * refused, naming its box.
 */
export function overlay(
  writer: WriterDocument,
  entries: readonly {
    readonly box: string;
    readonly page: number;
    readonly rect: readonly [number, number, number, number];
    readonly value: string;
  }[],
  fonts: readonly { readonly font: PDFFont; readonly covers: (text: string) => boolean }[],
): FillOutcome {
  const document = writer.document;
  const context = document.context;
  const pages = document.getPages();
  for (const entry of entries) {
    const page = pages[entry.page - 1];
    const font = fontFor(fonts, entry.value);
    if (page === undefined) return { ok: false, refused: "unknown-field", field: entry.box };
    if (font === undefined) return { ok: false, refused: "font-missing", field: entry.box };
    const [left, bottom, right, top] = entry.rect;
    const width = right - left;
    const height = top - bottom;
    const size = overlaySize(font, entry.value, width, height);
    if (size === undefined) return { ok: false, refused: "bad-value", field: entry.box };
    const resource = "F1";
    const baseline = Math.max(1, (height - size) / 2 + size * 0.22);
    const content = `BT /${resource} ${size} Tf 0 g 2 ${baseline.toFixed(2)} Td ${font.encodeText(entry.value).toString()} Tj ET`;
    const appearance = context.register(
      context.stream(content, {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, width, height],
        Resources: { Font: { [resource]: font.ref } },
      } as never),
    );
    const annotation = context.register(
      context.obj({
        Type: "Annot",
        Subtype: "FreeText",
        Rect: [left, bottom, right, top],
        Contents: PDFHexString.fromText(entry.value),
        // Printed (4), and locked against moving (128): it is the approved value, where it was approved.
        F: 4 | 128,
        DA: PDFString.of(`/Helv ${size} Tf 0 g`),
        Border: [0, 0, 0],
        AP: { N: appearance },
      } as never),
    );
    const annots = page.node.Annots();
    if (annots === undefined) page.node.set(name("Annots"), context.obj([annotation]));
    else annots.push(annotation);
  }
  return { ok: true };
}

/** Annotations carrying text a reader may be shown — comments, notes, free text — fields, links and popups aside. */
export function commentCount(writer: WriterDocument): number {
  let count = 0;
  for (const page of writer.document.getPages()) {
    const annots = page.node.Annots();
    for (let at = 0; at < (annots?.size() ?? 0); at += 1) {
      const annot = annots?.lookup(at);
      if (!(annot instanceof PDFDict) || ["Widget", "Link", "Popup"].includes(textOf(annot.lookup(name("Subtype"))) ?? "")) continue;
      if ((textOf(annot.lookup(name("Contents"))) ?? "").trim() !== "" || annot.has(name("RC"))) count += 1;
    }
  }
  return count;
}

/** Each page's annotation rectangles, by page number (links aside): where something is already written over the page. */
export function annotationRects(writer: WriterDocument): Map<number, [number, number, number, number][]> {
  const rects = new Map<number, [number, number, number, number][]>();
  writer.document.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    for (let at = 0; at < (annots?.size() ?? 0); at += 1) {
      const annot = annots?.lookup(at);
      if (!(annot instanceof PDFDict) || ["Link", "Popup"].includes(textOf(annot.lookup(name("Subtype"))) ?? "")) continue;
      const rect = annot.lookup(name("Rect"));
      if (!(rect instanceof PDFArray) || rect.size() !== 4) continue;
      const numbers = [0, 1, 2, 3].map((corner) => rect.lookup(corner));
      if (!numbers.every((value) => value instanceof PDFNumber)) continue;
      const [x1, y1, x2, y2] = numbers.map((value) => (value as PDFNumber).asNumber()) as [number, number, number, number];
      rects.set(index + 1, [...(rects.get(index + 1) ?? []), [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]]);
    }
  });
  return rects;
}

/** The FreeText values an overlay wrote on each page, by page number, as read back from the saved copy. */
export function overlayValues(writer: WriterDocument): Map<number, string[]> {
  const values = new Map<number, string[]>();
  writer.document.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    for (let at = 0; at < (annots?.size() ?? 0); at += 1) {
      const annot = annots?.lookup(at);
      if (!(annot instanceof PDFDict) || textOf(annot.lookup(name("Subtype"))) !== "FreeText") continue;
      const text = textOf(annot.lookup(name("Contents")));
      if (text !== undefined) values.set(index + 1, [...(values.get(index + 1) ?? []), text]);
    }
  });
  return values;
}

// ------------------------------------------------------------------ answer sheet

/**
 * A plain PDF listing each field and its value, for a form Tavi cannot fill
 * in place: the person copies it by hand. Values are wrapped, never
 * cut, and a value's own line breaks are kept.
 */
export async function answerSheet(
  title: string,
  rows: readonly { readonly field: string; readonly value: string }[],
  fonts: readonly Uint8Array[],
): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.registerFontkit(fontkit);
  const writer = { document, original: new Uint8Array(0), encrypted: false };
  const embedded = await embedFonts(writer, fonts);
  const fallback = embedded[0]?.font;
  if (fallback === undefined) throw new Error("an answer sheet needs a font");
  const size = 11;
  const [width, height, margin] = [595, 842, 50];
  let page = document.addPage([width, height]);
  let y = height - margin;
  const write = (text: string, indent: number): void => {
    for (const paragraph of text.split(/\r\n|\r|\n/)) {
      const font = fontFor(embedded, paragraph) ?? fallback;
      for (const line of wrap(paragraph, font, size, width - indent - margin)) {
        if (y < margin) {
          page = document.addPage([width, height]);
          y = height - margin;
        }
        page.drawText(line, { x: indent, y, size, font });
        y -= size * 1.5;
      }
    }
  };
  write(title, margin);
  write("This form cannot be filled in place. Copy these answers into it by hand.", margin);
  y -= size;
  for (const row of rows) {
    write(row.field, margin);
    write(row.value, margin + 20);
    y -= size * 0.5;
  }
  return document.save();
}

/** `text` broken at spaces (or anywhere, for a word wider than the line) into lines at most `maxWidth` wide. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  const fits = (candidate: string): boolean => font.widthOfTextAtSize(candidate, size) <= maxWidth;
  for (const word of text.split(" ")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    current = "";
    for (const char of word) {
      if (!fits(current + char) && current !== "") {
        lines.push(current);
        current = "";
      }
      current += char;
    }
  }
  lines.push(current);
  return lines;
}
