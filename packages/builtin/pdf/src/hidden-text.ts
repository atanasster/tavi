import type { HiddenReason } from "@tavi/contracts";

/**
 * Hidden-text signals: text a
 * reader never sees but a model would read. Each character is classified
 * from what PDFium reports of it; hidden runs go to `hidden[]` with their
 * reason, never into `text`.
 *
 * `covered` (text under an image or a filled shape) is decided with OCR: a
 * character under something drawn after it is marked here, its run's place
 * in `text` reported as a cover span, and the owner compares the page's
 * render with it by OCR.
 */

export interface Colour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0 is fully transparent. */
  readonly a: number;
}

export interface CharFacts {
  readonly code: number;
  /** The text object's render mode (`Tr`: 0 fill, 1 stroke, 2 both, 3 invisible, 4–6 with clip, 7 clip only). */
  readonly renderMode: number;
  readonly fill: Colour;
  readonly stroke: Colour;
  /** The `Tf` operand: before the text matrix scales it, so not the size a reader sees. */
  readonly fontSize: number;
  /** The character's box in page points, `[left, bottom, right, top]`; undefined for a generated character. */
  readonly box?: readonly [number, number, number, number];
  /** Inside optional content that is off by default. */
  readonly hiddenLayer: boolean;
  /** PDFium generated it (a space or line break between runs). */
  readonly generated: boolean;
  /** Its box lies under something opaque drawn after it: a reader may not see it. */
  readonly underCover?: boolean;
}

/** The page's visible area, `[left, bottom, right, top]` in page points (its crop box). */
export type PageBox = readonly [number, number, number, number];

/** Text render modes that paint nothing: invisible, and clip only. */
const INVISIBLE_MODES = new Set([3, 7]);
/** Modes that paint the fill, and modes that paint the stroke. */
const FILLS = new Set([0, 2, 4, 6]);
const STROKES = new Set([1, 2, 5, 6]);

/** Characters that take no width: zero-width spaces and joiners, the word joiner and the BOM. */
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
/** A glyph box shorter than this is unreadable at any zoom a person uses. */
const TINY_HEIGHT = 0.5;
/** A colour this light reads as the page itself. */
const NEAR_WHITE = 245;

/** Whitespace a document draws: its box is a hairline, so it is a separator, never hidden on its own. */
const isSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0xa0 || code === 0x0d || code === 0x0a;

const unseen = (colour: Colour): boolean => colour.a === 0 || (colour.r >= NEAR_WHITE && colour.g >= NEAR_WHITE && colour.b >= NEAR_WHITE);

/** Why a character is hidden, or undefined when a reader sees it. */
export function hiddenReason(char: CharFacts, page: PageBox): HiddenReason | undefined {
  if (ZERO_WIDTH.has(char.code)) return "zero-width";
  if (char.generated || isSpace(char.code)) return undefined;
  if (char.hiddenLayer) return "hidden-layer";
  if (INVISIBLE_MODES.has(char.renderMode)) return "invisible-render";
  // Only what the mode paints counts: outlined text is seen by its stroke, whatever its fill.
  const painted = [...(FILLS.has(char.renderMode) ? [char.fill] : []), ...(STROKES.has(char.renderMode) ? [char.stroke] : [])];
  if (painted.length > 0 && painted.every(unseen)) return "background-colour";
  if (char.box !== undefined) {
    const [left, bottom, right, top] = char.box;
    // The box, not `Tf`: a small `Tf` scaled up by the text matrix is ordinary text.
    if (top - bottom > 0 && top - bottom < TINY_HEIGHT) return "tiny";
    if (right < page[0] || left > page[2] || top < page[1] || bottom > page[3]) return "off-page";
  }
  return undefined;
}

export interface SplitText {
  readonly text: string;
  readonly hidden: readonly { readonly reason: HiddenReason; readonly text: string }[];
  /** Where in `text` runs of characters under a cover lie, `[start, end)`. */
  readonly coverSpans: readonly { readonly start: number; readonly end: number }[];
}

/** At most this many hidden runs, and this much of each, per page (the result schema's bounds). */
const MAX_HIDDEN_RUNS = 32;
const MAX_HIDDEN_TEXT = 2_000;

/**
 * A page's characters split into what a reader sees and the hidden runs,
 * merged by reason. A generated separator between two hidden characters of
 * the same reason stays in their run, so "SEND ALL" is one run, not two.
 * Zero-width characters are gathered into one run, last: a script that
 * spells with joiners must not crowd out the runs that matter.
 */
export function splitText(chars: readonly CharFacts[], page: PageBox): SplitText {
  let text = "";
  const hidden: { reason: HiddenReason; text: string }[] = [];
  let zeroWidth = "";
  let open: { reason: HiddenReason; text: string } | undefined;
  let pendingSeparator = "";
  const coverSpans: { start: number; end: number }[] = [];
  // A cover span runs across separators, and ends at the next visible character not under a cover.
  let coverOpen = false;
  for (const char of chars) {
    const value = String.fromCodePoint(char.code);
    const reason = hiddenReason(char, page);
    if (reason === "zero-width") {
      zeroWidth += value;
      continue;
    }
    if (reason === undefined && (char.generated || isSpace(char.code)) && open !== undefined) {
      // A separator after a hidden run: kept until the next character says which side it belongs to.
      pendingSeparator += value;
      continue;
    }
    if (reason === undefined) {
      if (open !== undefined) {
        hidden.push(open);
        open = undefined;
      }
      text += pendingSeparator;
      pendingSeparator = "";
      const start = text.length;
      text += value;
      if (char.underCover === true && !isSpace(char.code) && !char.generated) {
        const last = coverSpans[coverSpans.length - 1];
        if (coverOpen && last !== undefined) last.end = text.length;
        else coverSpans.push({ start, end: text.length });
        coverOpen = true;
      } else if (!isSpace(char.code) && !char.generated) {
        coverOpen = false;
      }
      continue;
    }
    if (open !== undefined && open.reason === reason) {
      open.text += pendingSeparator + value;
    } else {
      if (open !== undefined) hidden.push(open);
      // A separator between two runs of different reasons is visible whitespace.
      text += pendingSeparator;
      open = { reason, text: value };
    }
    pendingSeparator = "";
  }
  if (open !== undefined) hidden.push(open);
  text += pendingSeparator;
  const runs = hidden
    .map((run) => ({ reason: run.reason, text: run.text.trim().slice(0, MAX_HIDDEN_TEXT) }))
    .filter((run) => run.text !== "");
  if (zeroWidth !== "") runs.push({ reason: "zero-width", text: zeroWidth.slice(0, MAX_HIDDEN_TEXT) });
  return { text, hidden: runs.slice(0, MAX_HIDDEN_RUNS), coverSpans };
}
