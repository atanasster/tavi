import stringWidth from "string-width";

/** Provider text for a terminal: its control characters (escape sequences included) removed, line breaks kept. */
export const terminalText = (text: string): string => text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");

/** A word cut between its characters into pieces of at most `columns`; a single character wider than that is one piece. */
function brokenWord(word: string, columns: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(word)) {
    if (piece !== "" && stringWidth(piece) + stringWidth(segment) > columns) {
      pieces.push(piece);
      piece = segment;
    } else piece += segment;
  }
  return piece === "" ? pieces : [...pieces, piece];
}

/** Text cut at spaces into lines of at most `width` columns, each starting with `indent`. A word too long for a line of its own is broken. */
export function indentedLines(text: string, indent: string, width: number): string[] {
  const room = Math.max(1, width - stringWidth(indent));
  const words = text.split(/\s+/).flatMap((word) => (stringWidth(word) > room ? brokenWord(word, room) : [word]));
  const lines: string[] = [];
  let line = "";
  for (const word of words.filter((part) => part !== "")) {
    if (line !== "" && stringWidth(indent) + stringWidth(line) + 1 + stringWidth(word) > width) {
      lines.push(`${indent}${line}`);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") lines.push(`${indent}${line}`);
  return lines;
}

/**
 * Rows of cells as aligned lines, two spaces between columns, the last column
 * left unpadded. Widths are terminal columns (`string-width`), so a wide
 * character — CJK, an emoji — does not push the columns after it.
 */
export function alignedColumns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, column) => (widths[column] = Math.max(widths[column] ?? 0, stringWidth(cell))));
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell + " ".repeat((widths[column] ?? 0) - stringWidth(cell))))
      .join("  ")
      .trimEnd(),
  );
}

/**
 * `text` padded with spaces to `width` terminal columns (`string-width`), as
 * `padEnd` pads ASCII: Cyrillic is one column a letter, a wide character two.
 * Text as wide as `width` or wider is left as it is.
 */
export function paddedCell(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - stringWidth(text)));
}

/** Where a clause of a one-row line ends: a part (`·`, `;`), a list item (`,`) or an aside (`—`). */
const CLAUSE_BREAKS = / · |; |, | — /g;

/**
 * One row of at most `columns` terminal columns: as it is when it fits, else
 * cut at the last place that fits where a clause ends (`·`, `;`, `,`, `—`) —
 * or where a word does, when a clause's end would keep less than half the row
 * — and ended with `…`, so no word is cut in two. A first word wider than the
 * row is cut between its characters, as nothing else can be. A width of 0 or
 * less is no width: the text is left as it is.
 */
export function fittedRow(text: string, columns: number): string {
  if (columns <= 0 || stringWidth(text) <= columns) return text;
  if (columns === 1) return "…";
  const room = columns - 1;
  const kept = (cut: number): string => text.slice(0, cut).replace(/[\s·,;—]+$/u, "");
  const lastFitting = (breaks: RegExp): number | undefined => {
    let cut: number | undefined;
    for (const match of text.matchAll(breaks)) {
      const piece = kept(match.index);
      if (piece === "") continue;
      if (stringWidth(piece) > room) break;
      cut = match.index;
    }
    return cut;
  };
  const clause = lastFitting(CLAUSE_BREAKS);
  const word = lastFitting(/ +/g);
  const cut = clause !== undefined && (word === undefined || stringWidth(kept(clause)) * 2 >= room) ? clause : word;
  if (cut !== undefined) return `${kept(cut)}…`;
  return `${brokenWord(text, room)[0] ?? ""}…`;
}

/**
 * Text whose lines wider than `columns` are each cut at spaces, the first
 * using the whole width and the rest going on at its indent plus `deeper`.
 * Unlike `fittedText`, every line stands alone — command output, not a help
 * page's paragraphs — and none is joined to the next. A line with a tab, or
 * with columns aligned by runs of spaces, is a table row, left as it is; so is
 * every line when `columns` is 0 or less (no width is known).
 */
export function wrappedLines(text: string, columns: number, deeper = "  "): string {
  if (columns <= 0) return text;
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.includes("\t") || stringWidth(line) <= columns) return [line];
      const head = /^ */.exec(line)?.[0] ?? "";
      if (/\S {2,}\S/.test(line.slice(head.length))) return [line];
      const indent = `${head}${deeper}`;
      const widest = Math.max(1, columns - stringWidth(indent));
      const lines: string[] = [];
      let current = head;
      let empty = true;
      for (const word of line.slice(head.length).split(" ")) {
        if (word === "") continue;
        for (const piece of stringWidth(word) > widest ? brokenWord(word, widest) : [word]) {
          if (!empty && stringWidth(current) + 1 + stringWidth(piece) > columns) {
            lines.push(current);
            current = indent;
            empty = true;
          }
          current = empty ? `${current}${piece}` : `${current} ${piece}`;
          empty = false;
        }
      }
      if (!empty) lines.push(current);
      return lines;
    })
    .join("\n");
}

/** The width a CLI page is laid out to: the terminal's columns, 80 in a pipe. */
export const pageWidth = (columns: number | undefined): number => columns ?? 80;

/** A help page's option: its label, two or more spaces, then words; the label's column ends where the words start. */
const labelOf = (line: string): string | undefined => /^( *\S(?:.*?\S)? {2,})(?=\S)/.exec(line)?.[1];

/** A line that goes on the prose at `indent`: words at that indent, not an option, a list item or a table row. */
const continuesProse = (line: string, indent: string): boolean =>
  line.startsWith(indent) && /^[^\s\-*•]/.test(line.slice(indent.length)) && labelOf(line) === undefined && !line.includes("\t");

/**
 * Text whose lines wider than `columns` are cut at spaces. A line that is a
 * label, two or more spaces, then words (a help page's option) goes on in the
 * words' column, and the lines after it already in that column are its own:
 * when any of them is too wide, the description is joined and wrapped once,
 * so no word is stranded on a line of its own. Any other line goes on at its
 * own indent plus `deeper`. A line with a tab is a table row, left as it is.
 */
export function fittedText(text: string, columns: number, deeper = ""): string {
  const lines = text.split("\n");
  const fitted: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.includes("\t")) {
      fitted.push(line);
      continue;
    }
    const labelled = labelOf(line);
    const option = labelled !== undefined && stringWidth(labelled) <= columns / 2 ? labelled : undefined;
    // An option's description: the lines after it that start, unlabelled, in its words' column.
    const group = [line];
    if (option !== undefined) {
      const column = " ".repeat(stringWidth(option));
      for (
        let next = lines[index + 1];
        next !== undefined && next.startsWith(column) && /^\S/.test(next.slice(column.length)) && !next.includes("\t");
        next = lines[index + group.length]
      )
        group.push(next);
    } else if (labelled === undefined && line.trim() !== "" && stringWidth(line) > columns) {
      // A line of prose too wide (a paragraph, or a description under a long label): it goes on in the lines after it
      // at its indent, joined and wrapped once so its last words are not stranded on a line of their own (QA 2032).
      const own = /^ */.exec(line)?.[0] ?? "";
      for (let next = lines[index + 1]; next !== undefined && continuesProse(next, own); next = lines[index + group.length])
        group.push(next);
    }
    if (group.every((part) => stringWidth(part) <= columns)) {
      fitted.push(...group);
      index += group.length - 1;
      continue;
    }
    index += group.length - 1;
    const head = option ?? /^ */.exec(line)?.[0] ?? "";
    const indent = option !== undefined ? " ".repeat(stringWidth(head)) : `${head}${deeper}`;
    const words = [line.slice(head.length), ...group.slice(1).map((part) => part.trim())].join(" ");
    const [first = "", ...rest] = indentedLines(words, indent, columns);
    fitted.push(`${head}${first.slice(indent.length)}`, ...rest);
  }
  return fitted.join("\n");
}
