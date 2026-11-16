import type { UsageError } from "./argv.js";
import { formatCommandIndex } from "./help.js";
import { nearestOf } from "../shared/nearest.js";

/** The words a usage page offers as actions or commands: its first line's `<a|b|c>`, and each indented entry's first word (after `tavi`). */
function offeredWords(usage: string): string[] {
  const words = new Set<string>();
  const first = usage.split("\n", 1)[0] ?? "";
  for (const match of first.matchAll(/<([a-z][a-z0-9|-]*)>/g)) for (const word of (match[1] ?? "").split("|")) words.add(word);
  // An action's entry (`  list  …`), or a command's in the index (`  tavi models <action>  …`).
  for (const match of usage.matchAll(/^ {2,4}(?:tavi )?([a-z][a-z0-9-]*)(?=\s|$)/gm)) if (match[1] !== undefined) words.add(match[1]);
  return [...words];
}

/** What the error says was typed: its first quoted value, else the first `--option` it names. */
function typedIn(message: string): string | undefined {
  const quoted = /"([^"]+)"/.exec(message)?.[1];
  if (quoted !== undefined) return quoted;
  return /(--[a-z][a-z0-9-]*)/.exec(message)?.[1];
}

/** The valid name nearest to what was typed, when the message does not already offer one. */
function nearestValid(error: UsageError): string | undefined {
  if (/did you mean/.test(error.message)) return undefined;
  const typed = typedIn(error.message);
  if (typed === undefined) return undefined;
  const offered = /expected one of ([^;.]+)/.exec(error.message)?.[1];
  const candidates = typed.startsWith("--")
    ? [...new Set(error.usage.match(/--[a-z][a-z0-9-]*/g) ?? [])]
    : offered !== undefined
      ? offered.split(/,\s*|\s+or\s+/).map((word) => word.trim().replace(/^`|`$/g, ""))
      : offeredWords(error.usage);
  const near = nearestOf(typed, candidates);
  return near === typed ? undefined : near;
}

/**
 * A usage error as the CLI prints it: one line — what was wrong, the nearest
 * valid action, option or command when one is close, and the help page that
 * has the rest. Only `--help` prints a page. An error with no usage page says
 * all there is in its message.
 */
export function usageErrorLine(error: UsageError, argv: readonly string[]): string {
  const message = error.message.replace(/\s+/g, " ").trim();
  if (error.usage === "") return `${message}\n`;
  const family = argv[0];
  const help =
    error.usage === formatCommandIndex() || family === undefined || family.startsWith("-") ? "tavi --help" : `tavi ${family} --help`;
  const near = nearestValid(error);
  const base = message.replace(/[.;:,]+$/, "");
  return near === undefined ? `${base}. See \`${help}\`.\n` : `${base}; did you mean ${near}? See \`${help}\`.\n`;
}
