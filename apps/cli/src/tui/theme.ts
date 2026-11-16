/** The terminal chat's one theme: the tones each kind of line and the UI chrome are drawn in, its glyphs and its rules. */
import type { LineTone } from "./store.js";

/** How a piece of text is drawn: Ink `<Text>` props. */
export interface Tone {
  readonly color?: string;
  readonly dimColor?: boolean;
  readonly bold?: boolean;
}

/** A colour, or none under `NO_COLOR` (no-color.org): any value but an empty one. */
export function colored(color: string, env: Readonly<Record<string, string | undefined>> = process.env): Tone {
  return (env["NO_COLOR"] ?? "") === "" ? { color } : {};
}

/** How each kind of line is drawn. */
export const TONES: Readonly<Record<LineTone, Tone>> = {
  text: {},
  prompt: colored("cyan"),
  tool: { dimColor: true },
  failure: colored("red"),
  notice: colored("yellow"),
  divider: { dimColor: true },
};

/** How the rest of the terminal UI is drawn. */
export const UI_TONES = {
  /** The status row under the transcript. */
  status: { dimColor: true },
  /** A default or a hint beside a question. */
  hint: { dimColor: true },
  /** The option a choice's cursor is on. */
  selected: colored("cyan"),
  /** Why a typed answer was not taken. */
  problem: colored("yellow"),
  /** A question's label. */
  label: { bold: true },
} as const satisfies Record<string, Tone>;

/** The marks the chat draws with. */
export const GLYPHS = {
  /** Enabled, in a pane's list. */
  on: "●",
  /** Disabled, in a pane's list. */
  off: "○",
  done: "✓",
  failed: "✗",
  warning: "⚠",
  /** A tool call. */
  call: "⏺",
  /** Awaiting review. */
  flagged: "⚑",
  /** Waiting on the person. */
  waiting: "⏸",
  /** More than is shown, or work under way. */
  more: "…",
  /** One character of a secret being typed. */
  masked: "•",
  /** An item of a card's list. */
  bullet: "•",
  /** Work under way, in the status row. */
  running: "●",
  /** Where the person types, and what they typed. */
  prompt: "❯",
  /** Where the next character typed will appear. */
  cursor: "█",
  /** What a tool call returned, under its card. */
  result: "⎿",
  /** A notice for the person, or work waiting on their review. */
  notice: "◆",
  /** A form being filled in. */
  form: "✎",
  /** An app to sign in to again. */
  key: "⚷",
  /** Still to do: a step not taken yet, or what the person does next. */
  todo: "○",
  /** A step this setup cannot take here. */
  unavailable: "–",
  /** A step the person skipped. */
  skipped: "·",
} as const;

/** The prompt's cursor, blinking on terminals that honour SGR 5 (`ESC[5m…ESC[25m`). */
export const BLINK_CURSOR = `\u001B[5m${GLYPHS.cursor}\u001B[25m`;

/** The rules a divider is drawn with. */
export const RULES = {
  /** A section of a pane or the help. */
  section: "─",
  /** A boundary in a chat's transcript. */
  boundary: "──",
} as const;

/** A section's title between rules: `─ title ─`, or with a heavier `rule`. */
export function divider(title: string, rule: string = RULES.section): string {
  return `${rule} ${title} ${rule}`;
}
