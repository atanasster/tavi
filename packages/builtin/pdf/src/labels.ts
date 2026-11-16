/**
 * A field's label when it has no `/TU` tooltip: the visible text beside it, searched
 * directionally, then by distance. A label found this way is the document's
 * words; it never verifies an option mapping.
 */

/** `[left, bottom, right, top]` in page points. */
export type Box = readonly [number, number, number, number];

export interface TextRun {
  readonly text: string;
  readonly box: Box;
}

/** How far the distance fallback looks, in points. */
const NEAREST_MAX = 72;
const MAX_LABEL = 200;

const centreY = (box: Box): number => (box[1] + box[3]) / 2;
const inside = (inner: Box, outer: Box): boolean =>
  inner[0] >= outer[0] && inner[2] <= outer[2] && inner[1] >= outer[1] && inner[3] <= outer[3];

function gap(a: Box, b: Box): number {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
}

/** The nearest run in `candidates` by edge distance; earlier wins a tie. */
function nearest(field: Box, candidates: readonly TextRun[]): TextRun | undefined {
  let best: TextRun | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const run of candidates) {
    const distance = gap(field, run.box);
    if (distance < bestGap) {
      best = run;
      bestGap = distance;
    }
  }
  return best;
}

/**
 * The label of a field whose widget is `field`: for a checkbox or radio, the
 * text on its baseline to the right (then the left); for any other field,
 * text to the left on its line or just above it; then the nearest run within
 * an inch. Text inside the widget (a placeholder, a default value) is never
 * its label.
 */
export function labelFor(field: Box, toggle: boolean, runs: readonly TextRun[]): string | undefined {
  const width = field[2] - field[0];
  const height = field[3] - field[1];
  const outside = runs.filter((run) => run.text.trim() !== "" && !inside(run.box, field));
  const sameLine = (run: TextRun): boolean => Math.abs(centreY(run.box) - centreY(field)) < 0.5 * Math.max(height, run.box[3] - run.box[1]);
  const right = (run: TextRun): boolean => run.box[0] >= field[2] && run.box[0] <= field[2] + 4 * Math.max(width, height);
  const left = (run: TextRun, reach: number): boolean => run.box[2] <= field[0] && run.box[2] >= field[0] - reach;
  const above = (run: TextRun): boolean =>
    run.box[1] >= field[3] - 0.2 * height &&
    run.box[1] <= field[3] + 1.5 * height &&
    run.box[2] > field[0] - 0.2 * width &&
    run.box[0] < field[2];
  const windows = toggle
    ? [
        outside.filter((run) => sameLine(run) && right(run)),
        outside.filter((run) => sameLine(run) && left(run, 4 * Math.max(width, height))),
      ]
    : [outside.filter((run) => sameLine(run) && left(run, 3 * width)), outside.filter(above)];
  for (const window of windows) {
    const found = nearest(field, window);
    if (found !== undefined) return clean(found.text);
  }
  const fallback = nearest(field, outside);
  return fallback !== undefined && gap(field, fallback.box) <= NEAREST_MAX ? clean(fallback.text) : undefined;
}

function clean(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:：]\s*$/, "")
    .slice(0, MAX_LABEL);
}
