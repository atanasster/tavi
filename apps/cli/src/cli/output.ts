/** How a command prints: its answer as text or JSON on standard output, and a line on standard error. */

/** The two answer forms a command prints: a person's text, or a script's JSON. */
export type OutputFormat = "text" | "json";

export interface OutputSink {
  readonly stdout: (chunk: string) => void;
}

export interface ErrorSink {
  readonly stderr: (chunk: string) => void;
}

/** A value as the JSON a command answers with: indented, one trailing newline. */
export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The sinks of invocations given `--format text`: a JSON answer is printed to them as text (`recordText`). */
const textOnly = new WeakSet<OutputSink>();

/** `io` is an invocation's given `--format text`: `emitJson` never prints JSON to it. */
export function markTextOutput(io: OutputSink): void {
  textOnly.add(io);
}

/** Whether `io`'s invocation was given `--format text`: a command with a text summary of its own prints it. */
export function isTextOutput(io: OutputSink): boolean {
  return textOnly.has(io);
}

/**
 * Print a value as JSON on standard output — or, for an invocation given
 * `--format text`, as text (`recordText`): `--format text` never prints JSON.
 */
export function emitJson(io: OutputSink, value: unknown): void {
  io.stdout(textOnly.has(io) ? recordText(value) : jsonText(value));
}

/** How many entries of a list `recordText` prints before saying how many more there are. */
const RECORD_TEXT_LIST_MAX = 200;

/**
 * A JSON value as plain text a person reads: `key: value` lines, nested ones
 * indented under their key, a list's entries one after another with `- `. A
 * command with a text form of its own prints that instead; this is for one
 * whose answer is a record.
 */
export function recordText(value: unknown): string {
  const lines: string[] = [];
  const scalar = (item: unknown): string | undefined =>
    item === null || item === undefined
      ? "-"
      : typeof item === "string"
        ? item.replace(/[\u0000-\u001f\u007f]+/g, " ")
        : typeof item === "number" || typeof item === "boolean"
          ? String(item)
          : undefined;
  const walk = (item: unknown, indent: string): void => {
    if (Array.isArray(item)) {
      if (item.length === 0) lines.push(`${indent}(none)`);
      for (const entry of item.slice(0, RECORD_TEXT_LIST_MAX)) {
        const plain = scalar(entry);
        if (plain !== undefined) lines.push(`${indent}- ${plain}`);
        else {
          lines.push(`${indent}-`);
          walk(entry, `${indent}  `);
        }
      }
      if (item.length > RECORD_TEXT_LIST_MAX) lines.push(`${indent}(${item.length - RECORD_TEXT_LIST_MAX} more: --format json lists all)`);
      return;
    }
    if (item !== null && typeof item === "object") {
      const entries = Object.entries(item);
      if (entries.length === 0) lines.push(`${indent}(none)`);
      for (const [key, entry] of entries) {
        const plain = scalar(entry);
        if (plain !== undefined) lines.push(`${indent}${key}: ${plain}`);
        else if (isEmpty(entry)) lines.push(`${indent}${key}: (none)`);
        else {
          lines.push(`${indent}${key}:`);
          walk(entry, `${indent}  `);
        }
      }
      return;
    }
    lines.push(`${indent}${scalar(item) ?? ""}`);
  };
  walk(value, "");
  return `${lines.join("\n")}\n`;
}

/** An empty list or map: said as `(none)`, never a key with nothing after it. */
function isEmpty(item: unknown): boolean {
  if (Array.isArray(item)) return item.length === 0;
  return item !== null && typeof item === "object" && Object.keys(item).length === 0;
}

/**
 * Print a command's answer: `value` as JSON, or the text form `text` renders
 * (only when it is wanted), followed by a newline.
 */
export function emit<T>(io: OutputSink, format: OutputFormat, value: T, text: (value: T) => string): void {
  io.stdout(format === "json" ? jsonText(value) : `${text(value)}\n`);
}

/** Print one line on standard error. */
export function emitError(io: ErrorSink, message: string): void {
  io.stderr(`${message}\n`);
}
