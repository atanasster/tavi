import { labelFor, type Box, type TextRun } from "./labels.js";

/**
 * Entry boxes on a flat form (`pdf.overlay`): the
 * places a person writes on a form with no fields, found from its vector
 * structure. An underline (a horizontal rule at least `MIN_WIDTH` wide) is an
 * entry on the line above it; an empty rectangle of a line's height is an
 * entry inside it. Each is named by the text beside it, as a field without a
 * tooltip is. A box text already sits in is not an entry: it is filled, or it
 * is a table's rule.
 */

export interface EntryBox {
  /** `p<page>.b<n>`, in reading order on its page: the same document always gives the same ids. */
  readonly id: string;
  readonly page: number;
  /** Where a value is written, in page points. */
  readonly rect: Box;
  readonly label?: string;
}

/** An entry is at least this wide, in points: a shorter rule is decoration or a table's. */
const MIN_WIDTH = 40;
/** A rectangle entry is a line high: between these, in points. */
const MIN_HEIGHT = 10;
const MAX_HEIGHT = 40;
/** The writing room above an underline, in points. */
const LINE_ROOM = 14;
/** Entries one page may have; more is not a form's. */
const MAX_BOXES_PER_PAGE = 200;
/** Pages looked at for entry boxes: a form is short, and a long document without fields is not one. */
export const MAX_BOX_PAGES = 50;

const overlaps = (a: Box, b: Box): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const area = (box: Box): number => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);

/** The share of `inner`'s area that lies within `outer`. */
function covered(inner: Box, outer: Box): number {
  const box: Box = [Math.max(inner[0], outer[0]), Math.max(inner[1], outer[1]), Math.min(inner[2], outer[2]), Math.min(inner[3], outer[3])];
  const whole = area(inner);
  return whole === 0 ? 0 : area(box) / whole;
}

/**
 * Page `page`'s entry boxes, from the bounds of its path objects and its
 * visible text runs: rectangles first, then underlines not already a
 * rectangle's edge; at most `MAX_BOXES_PER_PAGE`, top to bottom, left to right.
 */
export function entryBoxes(page: number, paths: readonly Box[], runs: readonly TextRun[], annotations: readonly Box[] = []): EntryBox[] {
  const text = runs.filter((run) => run.text.trim() !== "");
  // Text that sits in a box (most of a run's area inside it) means the box is not empty; so does an
  // annotation over it — an earlier overlay's value, or one typed in a viewer.
  const empty = (box: Box): boolean =>
    !text.some((run) => covered(run.box, box) > 0.5) &&
    !annotations.some((annotation) => overlaps(annotation, box) && covered(box, annotation) > 0.3);
  const rects: Box[] = [];
  for (const path of paths) {
    const [left, bottom, right, top] = path;
    const height = top - bottom;
    if (right - left < MIN_WIDTH || height < MIN_HEIGHT || height > MAX_HEIGHT) continue;
    const inner: Box = [left + 2, bottom + 2, right - 2, top - 2];
    if (empty(inner) && !rects.some((other) => overlaps(other, inner))) rects.push(inner);
  }
  const lines: Box[] = [];
  for (const path of paths) {
    const [left, bottom, right, top] = path;
    if (top - bottom > 2 || right - left < MIN_WIDTH) continue;
    const room: Box = [left, top, right, top + LINE_ROOM];
    // A rectangle's own edge, or a rule under text already written on it, is not another entry.
    if (rects.some((rect) => overlaps(rect, [left, bottom - 3, right, top + 3]) || overlaps(rect, room))) continue;
    if (!empty(room) || lines.some((other) => overlaps(other, room))) continue;
    lines.push(room);
  }
  const ordered = [...rects, ...lines].sort((a, b) => b[3] - a[3] || a[0] - b[0]).slice(0, MAX_BOXES_PER_PAGE);
  return ordered.map((rect, index) => {
    const label = labelFor(rect, false, text);
    return { id: `p${page}.b${index + 1}`, page, rect, ...(label === undefined ? {} : { label }) };
  });
}
