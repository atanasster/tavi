import { turnEnded } from "@tavi/client/browser";

import { formatElapsed } from "../../lib/time.js";
import { reduceModelName } from "../../lib/model-name.js";
import type { CanvasRun } from "./store/types.js";

/**
 * What a finished reply's footer says beside its actions: how long it worked,
 * the model that answered, and its tool calls when it made any. Each is
 * measured or absent, never estimated (`metrics.ts`).
 */
export interface ReplyFacts {
  /** Working time, as `formatElapsed` writes it. */
  readonly time?: string;
  /** The answering models' own names ("gemma4-32k:latest"), joined with " → " when the turn failed over. */
  readonly model?: string;
  /** The full `connection/model` ids, for the title and a screen reader. */
  readonly modelIds?: string;
  /** Tool calls, only when there were some. */
  readonly tools?: number;
}

/**
 * The reply's own facts: its working time from the owner's stamps
 * (`activeMs`, else its first-to-last span); the models its execution
 * reported, else the ones its tool calls name, else — read back from the
 * record — the chat's, when the chat used one model only (then every turn used
 * it); and its tool calls, streamed or recorded. Nothing while the turn runs.
 */
export function replyFacts(run: CanvasRun): ReplyFacts {
  if (!turnEnded(run.run.status)) return {};
  const span = run.startedAt === undefined || run.lastAt === undefined ? Number.NaN : Date.parse(run.lastAt) - Date.parse(run.startedAt);
  // No reply takes no time: a zero is a replayed turn whose stamps were not kept, not a measurement.
  const ms = [run.activeMs, span].find((value) => value !== undefined && Number.isFinite(value) && value > 0);
  // A turn read back from the record holds its calls there rather than in a streamed transcript.
  const streamed = run.run.transcript.flatMap((entry) => (entry.kind === "tool" ? [entry] : []));
  const cards = streamed.length > 0 ? streamed : (run.recordedHistory?.tools ?? []);
  const tools = cards.length;
  const toolModels = [...new Set(cards.flatMap((card) => (card.model === undefined ? [] : [card.model])))];
  const chatModels = run.recordedHistory?.metrics?.models ?? [];
  const models = run.run.metrics?.models.length
    ? run.run.metrics.models
    : toolModels.length > 0
      ? toolModels
      : chatModels.length === 1
        ? chatModels
        : [];
  return {
    ...(ms === undefined ? {} : { time: formatElapsed(ms) }),
    ...(models.length === 0 ? {} : { model: models.map(reduceModelName).join(" → "), modelIds: models.join(" → ") }),
    ...(tools === 0 ? {} : { tools }),
  };
}
