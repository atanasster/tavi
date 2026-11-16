import { clip } from "@tavi/contracts/util";

import type { Ending } from "../../shared/recorded-task.js";
import { terminalText } from "../../shared/terminal-text.js";

type WaitingChoices = Extract<Ending, { kind: "waiting" }>["choices"];

/** Text a model or a page wrote, as one line a terminal shows as text: no control character, no line break, clipped. */
export function oneLine(text: string, max: number): string {
  return clip(terminalText(text).replace(/\s+/g, " ").trim(), max);
}

/** A question's options as `[1. Yes  2. No]`, or "" without any. */
export function numberedOptions(choices: WaitingChoices): string {
  const options = choices?.options.map((option, index) => `${index + 1}. ${oneLine(option.label, 60)}`).join("  ");
  return options === undefined || options === "" ? "" : `  [${options}]`;
}

/**
 * How a task left waiting is said: a question it asks you, with the command
 * that answers it; anything else (a peer's reply, a worker, a deadline)
 * resolves on its own.
 */
export function waitingText(
  taskId: string,
  wait: { readonly on: string; readonly deadlineAt: string; readonly question?: string; readonly choices?: WaitingChoices },
): string {
  if (wait.question === undefined)
    return `Task ${taskId} is waiting on ${wait.on} (deadline ${wait.deadlineAt}); it resolves on its own, not by a decision made here.\n`;
  return (
    `Task ${taskId} asks you: ${oneLine(wait.question, 400)}${numberedOptions(wait.choices)}\n` +
    `Answer with \`tavi answer ${taskId} <answer>\` (until ${wait.deadlineAt}).\n`
  );
}
