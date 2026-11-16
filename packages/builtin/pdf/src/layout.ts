import type { Box, TextRun } from "./labels.js";

/**
 * Reading order, tables and Markdown, from a
 * page's positioned visible runs and its ruling lines:
 *
 * - **Tables** first: three or more lines whose runs start at two or more
 *   shared column positions, with ruling lines among them or three or more
 *   columns (two aligned columns of prose are a two-column page, not a
 *   table), emitted as a Markdown table.
 * - **Reading order** by XY-cut: a block is split at a full-width horizontal
 *   gap first, else at a full-height vertical gap, recursively; columns are
 *   read in turn, top to bottom.
 * - **Paragraphs** from lines close together; a short line set larger than
 *   the page's body text is a heading.
 *
 * Headers and footers repeated across pages are removed by the caller
 * (`repeatedEdges`), which sees every page of a read.
 */

/** A horizontal ruling line: `y`, from `left` to `right`, in page points. */
export interface Rule {
  readonly y: number;
  readonly left: number;
  readonly right: number;
}

/** Runs whose starts lie this close share a table column, in points. */
const COLUMN_SNAP = 6;
/** The least whitespace between columns of text, in points. */
const COLUMN_GAP = 12;
/** A table has at least this many rows, and is looked for up to this many. */
const TABLE_MIN_ROWS = 3;
const TABLE_MAX_ROWS = 200;
/** A table of more columns than this is not looked for. */
const TABLE_MAX_COLUMNS = 12;
/** An unruled table's cells are short: a median this long or longer is prose. */
const TABLE_MAX_CELL_CHARS = 24;
/** A page of more runs than this is read top to bottom, left to right, without layout. */
const MAX_LAYOUT_RUNS = 5_000;
/** A gap this many body-line heights splits a block into bands. */
const BAND_GAP_LINES = 1.5;
/** A line this many times the body height, and this short, is a heading. */
const HEADING_SCALE = 1.3;
const HEADING_MAX_CHARS = 120;

interface Line {
  readonly runs: TextRun[];
  readonly box: Box;
}

/** A unit the reading order places: a run of text, or a whole table, which is never split. */
interface Unit {
  readonly box: Box;
  /** The table's Markdown, for a table; undefined for a run. */
  readonly table?: string;
  /** The run, for a run. */
  readonly run?: TextRun;
}

const centreY = (box: Box): number => (box[1] + box[3]) / 2;
const union = (boxes: readonly Box[]): Box => [
  Math.min(...boxes.map((box) => box[0])),
  Math.min(...boxes.map((box) => box[1])),
  Math.max(...boxes.map((box) => box[2])),
  Math.max(...boxes.map((box) => box[3])),
];
const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** Runs grouped into lines, top to bottom, each line's runs left to right. */
function linesOf(runs: readonly TextRun[]): Line[] {
  const sorted = [...runs].sort((a, b) => centreY(b.box) - centreY(a.box) || a.box[0] - b.box[0]);
  const lines: TextRun[][] = [];
  for (const run of sorted) {
    const line = lines.at(-1);
    const height = run.box[3] - run.box[1];
    if (line !== undefined) {
      const lineBox = union(line.map((member) => member.box));
      if (Math.abs(centreY(lineBox) - centreY(run.box)) < 0.5 * Math.max(height, lineBox[3] - lineBox[1])) {
        line.push(run);
        continue;
      }
    }
    lines.push([run]);
  }
  return lines.map((line) => {
    const ordered = line.sort((a, b) => a.box[0] - b.box[0]);
    return { runs: ordered, box: union(ordered.map((run) => run.box)) };
  });
}

/** Column positions the starts of `lines`' runs share, left to right: each a cluster within `COLUMN_SNAP`. */
function anchorsOf(lines: readonly Line[]): number[] {
  const starts = lines.flatMap((line) => line.runs.map((run) => run.box[0])).sort((a, b) => a - b);
  const anchors: number[] = [];
  for (const start of starts) {
    const last = anchors.at(-1);
    if (last === undefined || start - last > COLUMN_SNAP) anchors.push(start);
  }
  return anchors;
}

const columnOf = (anchors: readonly number[], x: number): number => anchors.findIndex((anchor) => Math.abs(anchor - x) <= COLUMN_SNAP);

/**
 * Whether `lines` read as one table. It opens with a full row (its header);
 * every row but a sparse one (a total, an empty cell) fills two or more
 * columns; each column is used by at least half the rows. Then: ruling lines
 * run across it, or it has three or more columns of short cells. Columns of
 * prose, however aligned, are long runs: a page in columns, not a table.
 */
function isTable(lines: readonly Line[], rules: readonly Rule[]): boolean {
  if (lines.length < TABLE_MIN_ROWS || (lines[0]?.runs.length ?? 0) < 2) return false;
  const anchors = anchorsOf(lines);
  if (anchors.length < 2 || anchors.length > TABLE_MAX_COLUMNS) return false;
  if (lines.filter((line) => line.runs.length >= 2).length < lines.length - 1) return false;
  const used = anchors.map(
    (anchor) => lines.filter((line) => line.runs.some((run) => Math.abs(run.box[0] - anchor) <= COLUMN_SNAP)).length,
  );
  if (used.some((count) => count * 2 < lines.length)) return false;
  const box = union(lines.map((line) => line.box));
  const ruled =
    rules.filter((rule) => rule.y >= box[1] - 12 && rule.y <= box[3] + 12 && rule.left <= box[0] + 12 && rule.right >= box[2] - 12)
      .length >= 2;
  if (ruled) return true;
  const cells = lines.flatMap((line) => line.runs.map((run) => run.text.length));
  return anchors.length >= 3 && median(cells) <= TABLE_MAX_CELL_CHARS;
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function tableMarkdown(lines: readonly Line[]): string {
  const anchors = anchorsOf(lines);
  const rows = lines.map((line) => {
    const cells = anchors.map(() => [] as string[]);
    for (const run of line.runs) cells[Math.max(0, columnOf(anchors, run.box[0]))]?.push(run.text);
    return `| ${cells.map((parts) => cell(parts.join(" "))).join(" | ")} |`;
  });
  const [header, ...body] = rows;
  return [header, `| ${anchors.map(() => "---").join(" | ")} |`, ...body].join("\n");
}

/** The page's lines as units: runs of lines that form tables become one unit each, the rest their runs. */
function unitsOf(lines: readonly Line[], rules: readonly Rule[]): Unit[] {
  const units: Unit[] = [];
  for (let at = 0; at < lines.length; ) {
    // A table can start only at a full row, and runs on while no two lines in a row are single runs.
    let reach = 0;
    if ((lines[at]?.runs.length ?? 0) >= 2) {
      reach = 1;
      while (
        at + reach < lines.length &&
        reach < TABLE_MAX_ROWS &&
        !((lines[at + reach]?.runs.length ?? 0) < 2 && (lines[at + reach + 1]?.runs.length ?? 0) < 2)
      )
        reach += 1;
    }
    // The longest run of lines from here, within that reach, that reads as a table.
    let found = 0;
    for (let length = reach; length >= TABLE_MIN_ROWS; length -= 1) {
      if (isTable(lines.slice(at, at + length), rules)) {
        found = length;
        break;
      }
    }
    if (found > 0) {
      const table = lines.slice(at, at + found);
      units.push({ box: union(table.map((line) => line.box)), table: tableMarkdown(table) });
      at += found;
      continue;
    }
    for (const run of (lines[at] as Line).runs) units.push({ box: run.box, run });
    at += 1;
  }
  return units;
}

/** `units` split at the widest gap in the projection of their boxes on one axis, when one is at least `minimum`. */
function splitAt(units: readonly Unit[], axis: "x" | "y", minimum: number): [Unit[], Unit[]] | undefined {
  if (units.length < 2) return undefined;
  const [low, high] = axis === "x" ? [0, 2] : [1, 3];
  const spans = units.map((unit) => [unit.box[low] as number, unit.box[high] as number] as const).sort((a, b) => a[0] - b[0]);
  let reach = spans[0]?.[1] ?? 0;
  let best: { readonly at: number; readonly width: number } | undefined;
  for (const [start, end] of spans.slice(1)) {
    if (start - reach >= minimum && (best === undefined || start - reach > best.width))
      best = { at: (start + reach) / 2, width: start - reach };
    reach = Math.max(reach, end);
  }
  if (best === undefined) return undefined;
  const at = best.at;
  const before: Unit[] = [];
  const after: Unit[] = [];
  for (const unit of units) (axis === "x" ? unit.box[2] <= at : unit.box[1] >= at) ? before.push(unit) : after.push(unit);
  if (before.length === 0 || after.length === 0) return undefined;
  // Top to bottom: on the y axis, what lies above the gap comes first.
  return [before, after];
}

/**
 * XY-cut: the units in reading order, as blocks; a full-width band first, else
 * a full-height column. Iterative, so a page of many uneven gaps cannot
 * exhaust the stack.
 */
function readingOrder(units: readonly Unit[], body: number): Unit[][] {
  const blocks: Unit[][] = [];
  // Last in, first out: the block to read next is on top.
  const pending: Unit[][] = [[...units]];
  while (pending.length > 0) {
    const block = pending.pop() as Unit[];
    const split = splitAt(block, "y", Math.max(body * BAND_GAP_LINES, 4)) ?? splitAt(block, "x", COLUMN_GAP);
    if (split === undefined) {
      if (block.length > 0) blocks.push(block);
      continue;
    }
    pending.push(split[1], split[0]);
  }
  return blocks;
}

/**
 * One block as Markdown: a table as it is; runs as lines, lines close together
 * joined as a paragraph, a large short line a heading. A block with both (a
 * table with text beside it, past every cut) gives its tables first.
 */
function blockMarkdown(block: readonly Unit[], body: number): string {
  const tables = block.flatMap((unit) => (unit.table === undefined ? [] : [unit]));
  const runs = block.flatMap((unit) => (unit.run === undefined ? [] : [unit.run]));
  const parts = tables.sort((a, b) => centreY(b.box) - centreY(a.box)).map((unit) => unit.table as string);
  let paragraph: string[] = [];
  let previous: Line | undefined;
  const flush = (): void => {
    if (paragraph.length > 0) parts.push(paragraph.join("\n"));
    paragraph = [];
  };
  for (const line of linesOf(runs)) {
    const text = line.runs.map((run) => run.text).join(" ");
    const height = line.box[3] - line.box[1];
    if (body > 0 && height >= body * HEADING_SCALE && text.length <= HEADING_MAX_CHARS) {
      flush();
      parts.push(`## ${text}`);
      previous = undefined;
      continue;
    }
    if (previous !== undefined && previous.box[1] - line.box[3] > body * BAND_GAP_LINES) flush();
    paragraph.push(text);
    previous = line;
  }
  flush();
  return parts.join("\n\n");
}

/** A page's visible runs and ruling lines as Markdown, in reading order. */
export function pageMarkdown(runs: readonly TextRun[], rules: readonly Rule[]): string {
  const lines = linesOf(runs.filter((run) => run.text.trim() !== ""));
  if (lines.length === 0) return "";
  // A page this crowded is read as its lines, top to bottom: layout would cost more than it is worth.
  if (runs.length > MAX_LAYOUT_RUNS) return lines.map((line) => line.runs.map((run) => run.text).join(" ")).join("\n");
  const body = median(lines.map((line) => line.box[3] - line.box[1]));
  const units = unitsOf(lines, rules);
  return readingOrder(units, body)
    .map((block) => blockMarkdown(block, body))
    .filter((part) => part !== "")
    .join("\n\n");
}

/** Text as headers and footers repeat it: a standalone number of up to four digits stands for any page number; an amount stays. */
const edgeKey = (text: string): string =>
  text
    .replace(/(?<![\d.,])\d{1,4}(?![\d.,]*\d)/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * The lines of `pages` that sit at a page's top or bottom edge (the outer 8%
 * of its height) and repeat, digits aside, on at least half of three or more
 * pages: a running header or footer. Returned as their keys, to drop.
 * "On at least half" means at least three repeats and at least half the pages.
 */
export function repeatedEdges(
  pages: readonly { readonly runs: readonly TextRun[]; readonly height: number; readonly bottom: number }[],
): Set<string> {
  if (pages.length < 3) return new Set();
  const counts = new Map<string, number>();
  for (const page of pages) {
    const margin = page.height * 0.08;
    const keys = new Set(
      linesOf(page.runs)
        .filter((line) => line.box[1] >= page.bottom + page.height - margin || line.box[3] <= page.bottom + margin)
        .map((line) => edgeKey(line.runs.map((run) => run.text).join(" "))),
    );
    for (const key of keys) if (key !== "" && key !== "#") counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count >= Math.max(3, Math.ceil(pages.length / 2))).map(([key]) => key));
}

/** `runs` without the lines `repeatedEdges` named, at the page's edges. */
export function withoutEdges(runs: readonly TextRun[], drop: ReadonlySet<string>, height: number, bottom: number): TextRun[] {
  if (drop.size === 0) return [...runs];
  const margin = height * 0.08;
  const gone = new Set(
    linesOf(runs)
      .filter(
        (line) =>
          (line.box[1] >= bottom + height - margin || line.box[3] <= bottom + margin) &&
          drop.has(edgeKey(line.runs.map((run) => run.text).join(" "))),
      )
      .flatMap((line) => line.runs),
  );
  return runs.filter((run) => !gone.has(run));
}
