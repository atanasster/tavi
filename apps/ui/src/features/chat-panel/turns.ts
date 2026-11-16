import type { CanvasRun } from "../chat/store/types.js";

/** One prompt the transcript shows, and the `data-turn` it is marked with. */
export interface TranscriptPrompt {
  readonly turn: number;
  readonly text: string;
}

/**
 * The ordinal of a run's first prompt among the session's prompts — the
 * recorded ones a reload replays, then each run's own — which the transcript
 * writes as `data-turn` for the chat panel to find.
 */
export function firstTurnOf(runs: readonly CanvasRun[], index: number): number {
  let turn = 1;
  for (const run of runs.slice(0, index)) turn += (run.recordedPrompts?.length ?? 0) + (run.prompt === "" ? 0 : 1);
  return turn;
}

/** Every prompt the transcript shows, in order, with its turn. */
export function transcriptPrompts(runs: readonly CanvasRun[]): readonly TranscriptPrompt[] {
  const prompts: TranscriptPrompt[] = [];
  runs.forEach((run, index) => {
    let turn = firstTurnOf(runs, index);
    for (const text of run.recordedPrompts ?? []) prompts.push({ turn: turn++, text });
    if (run.prompt !== "") prompts.push({ turn, text: run.prompt });
  });
  return prompts;
}

/**
 * Each recorded prompt's turn in the transcript, matched by its text in order:
 * the transcript can hold prompts the owner never admitted (refused, or never
 * sent) and the record prompts the page has not drawn (queued before a reload),
 * so counting either side alone would point at the wrong prompt. A prompt with
 * no match has no turn.
 */
export function matchTurns(recorded: readonly string[], shown: readonly TranscriptPrompt[]): readonly (number | undefined)[] {
  let from = 0;
  return recorded.map((text) => {
    const at = shown.findIndex((prompt, index) => index >= from && prompt.text.trim() === text.trim());
    if (at === -1) return undefined;
    from = at + 1;
    return shown[at]?.turn;
  });
}
