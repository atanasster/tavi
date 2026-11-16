import { memorySeenCount, type ScheduleToolsResult } from "@tavi/contracts";

import type { CanvasRun } from "./store/types.js";

/**
 * What *Repeat this* fills its form with, from a chat: the prompt, the tools
 * the chat used that a schedule may list, and whether it reads as research.
 * The chat's words are data here: they only fill an editable form, and the
 * owner checks them again when it is saved.
 */

/** The web research tools: a chat that used one and nothing that writes is offered as a routine. */
const RESEARCH_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

/** Memory's read-only tools. Reading it does not stop a chat being research, though what is saved runs without it. */
const MEMORY_READS: ReadonlySet<string> = new Set(["memory.list", "memory.search", "memory.get"]);

/** A turn's prompts: its recorded ones (a turn read back after a reload), then its own. */
const promptsOf = (run: Pick<CanvasRun, "prompt" | "recordedPrompts">): readonly string[] => [...(run.recordedPrompts ?? []), run.prompt];

/** The chat's opening message: its first prompt with words in it, or nothing. */
export function openingPrompt(runs: readonly Pick<CanvasRun, "prompt" | "recordedPrompts">[]): string {
  for (const run of runs) for (const prompt of promptsOf(run)) if (prompt.trim() !== "") return prompt.trim();
  return "";
}

/** The tools the chat called and that finished, streamed or saved, each once in first-seen order. */
export function toolsUsed(runs: readonly Pick<CanvasRun, "run" | "recordedHistory">[]): readonly string[] {
  const seen = new Set<string>();
  for (const run of runs) {
    for (const card of run.recordedHistory?.tools ?? []) if (card.status === "completed") seen.add(card.toolName);
    for (const entry of run.run.transcript) if (entry.kind === "tool" && entry.status === "completed") seen.add(entry.toolName);
  }
  return [...seen];
}

/**
 * The used tools a schedule may list — those the owner's `schedules tools`
 * offers by id — split into those allowed ahead (read-only ones, and only
 * from a `trusted` chat) and those offered for the person to add, and the
 * rest, left out.
 */
export function repeatTools(
  used: readonly string[],
  listable: ScheduleToolsResult,
  trusted: boolean,
): { readonly allowed: readonly string[]; readonly offered: readonly string[]; readonly leftOut: readonly string[] } {
  const listed = new Set(listable.tools);
  const readOnly = new Set(listable.readOnly);
  const allowed = trusted ? used.filter((tool) => listed.has(tool) && readOnly.has(tool)) : [];
  return {
    allowed,
    offered: used.filter((tool) => listed.has(tool) && !allowed.includes(tool)),
    leftOut: used.filter((tool) => !listed.has(tool)),
  };
}

/**
 * Whether the chat reads as research: it searched or fetched the web, and
 * every other tool it used reads memory or sits in a family the owner offers
 * as read-only.
 */
export function researchChat(used: readonly string[], listable: ScheduleToolsResult): boolean {
  const readOnly = listable.families.map((family) => family.slice(0, -1));
  return (
    used.some((tool) => RESEARCH_TOOLS.has(tool)) &&
    used.every((tool) => RESEARCH_TOOLS.has(tool) || MEMORY_READS.has(tool) || readOnly.some((prefix) => tool.startsWith(prefix)))
  );
}

/**
 * What the chat read of memory, which neither a routine's run nor a schedule's
 * fire can, so the form says so. `read`: a saved turn names a record, used or
 * listed (a search that found none names nothing). `unknown`: it called a memory tool on a turn
 * with no such word, one saved before it was recorded or not read back yet.
 */
export function memoryRead(runs: readonly Pick<CanvasRun, "run" | "recordedHistory" | "memoryUsed">[]): "read" | "unknown" | undefined {
  if (runs.some((run) => memorySeenCount(run.memoryUsed) > 0)) return "read";
  const unsaid = runs.filter((run) => run.memoryUsed === undefined);
  return toolsUsed(unsaid).some((tool) => MEMORY_READS.has(tool)) ? "unknown" : undefined;
}

/** The prompt as a form takes it: within `max` UTF-16 units, the field's bound, without splitting a character. */
export function repeatPrompt(prompt: string, max: number): string {
  if (prompt.length <= max) return prompt;
  const cut = prompt.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** A name for the new schedule or routine: the prompt's first line, shortened. */
export function repeatName(prompt: string): string {
  const line = (prompt.split("\n").find((each) => each.trim() !== "") ?? "").replace(/\s+/g, " ").trim();
  if (line === "") return "";
  return line.length <= 60 ? line : `${line.slice(0, 59).trimEnd()}…`;
}
