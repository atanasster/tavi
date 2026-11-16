/**
 * The one print theme: the palette, the face and the type scale every
 * document Tavi renders to print or PDF (the daily brief, a routine's news
 * report) is set in. Print is light only: ink on white paper, whatever scheme
 * the reader's screen is in. Zod-free and free of Node and DOM APIs, so a
 * plugin imports it without the contracts barrel.
 *
 * The palette is the daily brief's neutral ink, the fuller of the two the
 * documents had (body, secondary, faint, hairline and a note's fill and
 * edge); the news report's two roles the brief lacked, a source link and a
 * caveat, keep the news report's colours.
 */

/** The print palette, by role. */
export const PRINT_PALETTE = {
  /** Body text, headings and heavy rules. */
  ink: "#14181f",
  /** Secondary text: a snippet, a dateline. */
  inkSoft: "#4a5260",
  /** Labels: a column header, a section kicker. */
  muted: "#5b6472",
  /** Faint text: metadata, an empty state. */
  faint: "#8892a0",
  /** Hairlines between rows and sections. */
  rule: "#e6e9ee",
  /** A link to a source. */
  link: "#174ca0",
  /** A caveat or a gap in coverage. */
  caution: "#684d1a",
  /** A note's fill and its edge stripe. */
  noteFill: "#fff8e6",
  noteEdge: "#e0a800",
} as const;

/** The print face. */
export const PRINT_FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** The type scale's steps, in the unit a document sets its type in (`printThemeCss`). */
export const PRINT_TYPE_SCALE = { xs: 9, sm: 10, base: 11, md: 12, lg: 15, xl: 21, "2xl": 24 } as const;

const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * The theme as custom properties on `:root`, for the head of a print
 * document's stylesheet: `--print-<role>` for each colour (`--print-ink-soft`),
 * `--print-font`, and `--print-text-<step>` in `unit` — a dense sheet sets
 * type in `px`, a reading document in `pt`.
 */
export function printThemeCss(unit: "px" | "pt"): string {
  const colours = Object.entries(PRINT_PALETTE).map(([role, value]) => `--print-${kebab(role)}:${value};`);
  const sizes = Object.entries(PRINT_TYPE_SCALE).map(([step, size]) => `--print-text-${step}:${size}${unit};`);
  return `:root{color-scheme:light;${colours.join("")}--print-font:${PRINT_FONT};${sizes.join("")}}`;
}
