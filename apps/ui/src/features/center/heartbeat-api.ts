import {
  HeartbeatForgetAnswerSchema,
  HeartbeatGetAnswerSchema,
  HeartbeatHistoryAnswerSchema,
  HeartbeatItemAnswerSchema,
  HeartbeatLogAnswerSchema,
  HeartbeatRecentAnswerSchema,
  HeartbeatRunNowAnswerSchema,
  heartbeatHookDecisionText,
  heartbeatHookDecisions,
  heartbeatTickContext,
  type HeartbeatForgetAnswer,
  type HeartbeatGetAnswer,
  type HeartbeatHistoryAnswer,
  type HeartbeatItemAnswer,
  type HeartbeatLogAnswer,
  type HeartbeatRecentAnswer,
  type HeartbeatRunNowAnswer,
  type HeartbeatSettingsChange,
  type HeartbeatTickRecord,
} from "@tavi/contracts";

import { z } from "zod";

import { translateCore, translateNow } from "../../lib/i18n.js";
import { mapOutcome, read, type Outcome, type Readable, type SettingsClient } from "../../lib/ipc.js";

/**
 * The canvas's side of the owner's `heartbeat` command. Every write names the revision the page read, so a change made
 * elsewhere meanwhile is refused in the owner's words, never overwritten.
 */

// Every write names the revision it read, 0 for a heartbeat never saved: a first save made meanwhile (chat, the offer)
// is refused, never overwritten.
function beat<T>(client: SettingsClient, payload: Record<string, unknown>, schema: Readable<T>): Promise<Outcome<T>> {
  return read(client, "heartbeat", payload, schema);
}

export function getHeartbeat(client: SettingsClient, workspaceId: string): Promise<Outcome<HeartbeatGetAnswer>> {
  return beat(client, { action: "get", workspaceId }, HeartbeatGetAnswerSchema);
}

export function changeHeartbeat(
  client: SettingsClient,
  workspaceId: string,
  revision: number,
  changes: HeartbeatSettingsChange,
): Promise<Outcome<HeartbeatGetAnswer>> {
  return beat(client, { action: "set", workspaceId, revision, changes }, HeartbeatGetAnswerSchema);
}

export function setHeartbeatInstructions(
  client: SettingsClient,
  workspaceId: string,
  revision: number,
  text: string,
): Promise<Outcome<HeartbeatGetAnswer>> {
  return beat(client, { action: "set-instructions", workspaceId, revision, text }, HeartbeatGetAnswerSchema);
}

export function heartbeatHistory(client: SettingsClient, workspaceId: string): Promise<Outcome<HeartbeatHistoryAnswer>> {
  return beat(client, { action: "history", workspaceId }, HeartbeatHistoryAnswerSchema);
}

export function heartbeatLog(client: SettingsClient, workspaceId: string, limit = 100): Promise<Outcome<HeartbeatLogAnswer>> {
  return beat(client, { action: "log", workspaceId, limit }, HeartbeatLogAnswerSchema);
}

export function checkHeartbeatNow(client: SettingsClient, workspaceId: string): Promise<Outcome<HeartbeatRunNowAnswer>> {
  return beat(client, { action: "run-now", workspaceId }, HeartbeatRunNowAnswerSchema);
}

export function pauseHeartbeat(client: SettingsClient, workspaceId: string, forMs?: number): Promise<Outcome<HeartbeatGetAnswer>> {
  return beat(client, { action: "pause", workspaceId, ...(forMs === undefined ? {} : { forMs }) }, HeartbeatGetAnswerSchema);
}

export function resumeHeartbeat(client: SettingsClient, workspaceId: string): Promise<Outcome<HeartbeatGetAnswer>> {
  return beat(client, { action: "resume", workspaceId }, HeartbeatGetAnswerSchema);
}

export function setHeartbeatProvider(
  client: SettingsClient,
  workspaceId: string,
  revision: number,
  providerId: string,
): Promise<Outcome<HeartbeatGetAnswer>> {
  return beat(client, { action: "set-provider", workspaceId, revision, providerId }, HeartbeatGetAnswerSchema);
}

export function setHeartbeatEgress(
  client: SettingsClient,
  workspaceId: string,
  revision: number,
  field: "instructions" | "signals" | "ledger" | "memory",
  on: boolean,
): Promise<Outcome<HeartbeatGetAnswer>> {
  return beat(client, { action: "egress", workspaceId, revision, field, on }, HeartbeatGetAnswerSchema);
}

/** Tell about what a mute held back again (`unmute`): a key, or a prefix ending in `*`. */
export function unmuteHeartbeat(
  client: SettingsClient,
  workspaceId: string,
  revision: number,
  prefix: string,
): Promise<Outcome<HeartbeatGetAnswer>> {
  return beat(client, { action: "unmute", workspaceId, revision, prefix }, HeartbeatGetAnswerSchema);
}

export function forgetHeartbeat(client: SettingsClient, workspaceId: string): Promise<Outcome<HeartbeatForgetAnswer>> {
  return beat(client, { action: "forget", workspaceId }, HeartbeatForgetAnswerSchema);
}

const OfferDismissedSchema = z.object({ dismissed: z.literal(true) });

/** *Turn on* from the first-run offer: on, with these instructions, in one save. */
export function startHeartbeat(
  client: SettingsClient,
  workspaceId: string,
  revision: number,
  instructions: string,
): Promise<Outcome<HeartbeatGetAnswer>> {
  return beat(client, { action: "start", workspaceId, revision, instructions }, HeartbeatGetAnswerSchema);
}

/** The heartbeat with its first-run offer worked out, which runs the built-in sources: only the offer card asks. */
export function getHeartbeatOffer(client: SettingsClient, workspaceId: string): Promise<Outcome<HeartbeatGetAnswer>> {
  return beat(client, { action: "get", workspaceId, offer: true }, HeartbeatGetAnswerSchema);
}

/** *Not now*: the first-run offer is never shown again. */
export function dismissHeartbeatOffer(client: SettingsClient, workspaceId: string): Promise<Outcome<{ readonly dismissed: true }>> {
  return beat(client, { action: "offer", workspaceId }, OfferDismissedSchema);
}

export function getHeartbeatItem(client: SettingsClient, workspaceId: string, itemId: string): Promise<Outcome<HeartbeatItemAnswer>> {
  return beat(client, { action: "item", workspaceId, itemId }, HeartbeatItemAnswerSchema);
}

/** What it told lately, newest first: the Center's items, which show there with Home off too. */
export function recentHeartbeatItems(client: SettingsClient, workspaceId: string, limit = 20): Promise<Outcome<HeartbeatRecentAnswer>> {
  return beat(client, { action: "recent", workspaceId, limit }, HeartbeatRecentAnswerSchema);
}

/** Useful or not useful (or neither), snooze for `minutes`, un-snooze, mute one item, or un-mute it. */
export function heartbeatItemOp(
  client: SettingsClient,
  workspaceId: string,
  itemId: string,
  op:
    | { readonly op: "feedback"; readonly feedback: "up" | "down" | null }
    | { readonly op: "snooze"; readonly minutes: number }
    | { readonly op: "unsnooze" }
    | { readonly op: "mute" }
    | { readonly op: "unmute" },
): Promise<Outcome<HeartbeatItemAnswer>> {
  return beat(client, { action: "items", workspaceId, itemId, ...op }, HeartbeatItemAnswerSchema);
}

// ---- Pure helpers ---------------------------------------------------------------

/** Minutes from "HH:MM" to "HH:MM", crossing midnight when the end is earlier. */
function activeMinutes(start: string, end: string): number {
  const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const span = minutes(end) - minutes(start);
  return span > 0 ? span : span + 24 * 60;
}

/**
 * The day's estimate: how many checks the hours allow, capped by the
 * daily model-check limit, and the tokens they would spend at `perCheck`
 * (the person's own average, when the log has one), capped by the token limit.
 */
export function heartbeatEstimate(
  config: Pick<HeartbeatGetAnswer["config"], "activeHours" | "everyMs" | "budget">,
  perCheck: number | undefined,
): { readonly checks: number; readonly tokens?: number } {
  const checks = Math.min(
    Math.floor((activeMinutes(config.activeHours.start, config.activeHours.end) * 60_000) / config.everyMs),
    config.budget.modelTicksPerDay,
  );
  return perCheck === undefined ? { checks } : { checks, tokens: Math.min(Math.round(checks * perCheck), config.budget.tokensPerDay) };
}

/** A check that ran the provider: what its tokens average over. */
export const ranProvider = (tick: HeartbeatTickRecord): boolean => (tick.kind === "signal" || tick.kind === "deep") && tick.tokens > 0;

/** The log's filters: everything, what was told, what was skipped, what failed. */
export const LOG_FILTERS = [
  { value: "all", labelKey: "center.heartbeatApi.filter.all" },
  { value: "told", labelKey: "center.heartbeatApi.filter.told" },
  { value: "skipped", labelKey: "center.heartbeatApi.filter.skipped" },
  { value: "failed", labelKey: "center.heartbeatApi.filter.failed" },
] as const;
export type LogFilter = (typeof LOG_FILTERS)[number]["value"];

export function logFilter(filter: LogFilter): (tick: HeartbeatTickRecord) => boolean {
  switch (filter) {
    case "all":
      return () => true;
    case "told":
      return (tick) => tick.itemsNow + tick.itemsLater > 0 || tick.kind === "digest";
    case "skipped":
      return (tick) => tick.outcome === "skipped" || tick.outcome === "deferred";
    case "failed":
      return (tick) => tick.outcome === "failed";
  }
}

/** One log row in words: "Skipped — nothing new", "Looked deeper — all quiet", "Told you 1 now, 2 later", and what mods decided. */
export function logLine(tick: HeartbeatTickRecord): string {
  const decisions = heartbeatHookDecisions(tick.hookDecisions);
  const decided =
    decisions.length === 0 ? "" : ` · ${decisions.map((decision) => heartbeatHookDecisionText(decision, translateCore)).join("; ")}`;
  const context = heartbeatTickContext(tick, translateCore)
    .map((part) => ` · ${part}`)
    .join("");
  return `${tickLine(tick)}${context}${decided}`;
}

function tickLine(tick: HeartbeatTickRecord): string {
  const reason = tick.reason === null ? "" : tick.reason.replaceAll("-", " ");
  if (tick.kind === "window") return translateNow("center.heartbeatApi.closedHours");
  if (tick.kind === "digest") return translateNow("center.heartbeatApi.summary", { count: tick.itemsLater });
  if (tick.outcome === "skipped" || tick.outcome === "deferred") {
    if (tick.outcome === "deferred")
      return reason === "" ? translateNow("center.heartbeatApi.waited") : translateNow("center.heartbeatApi.waitedBecause", { reason });
    return reason === "" ? translateNow("center.heartbeatApi.skipped") : translateNow("center.heartbeatApi.skippedBecause", { reason });
  }
  if (tick.outcome === "failed")
    return reason === "" ? translateNow("center.heartbeatApi.failed") : translateNow("center.heartbeatApi.failedBecause", { reason });
  const deep = tick.kind === "deep";
  if (tick.itemsNow + tick.itemsLater === 0) {
    if (tick.outcome === "quiet:withheld")
      return translateNow(deep ? "center.heartbeatApi.deepWithheld" : "center.heartbeatApi.checkedWithheld");
    return translateNow(deep ? "center.heartbeatApi.deepQuiet" : "center.heartbeatApi.checkedQuiet");
  }
  return translateNow(deep ? "center.heartbeatApi.deepTold" : "center.heartbeatApi.checkedTold", {
    now: tick.itemsNow,
    later: tick.itemsLater,
  });
}

/** A channel heartbeat messages may go to: one of the workspace's enabled connections. */
export interface HeartbeatChannel {
  readonly connectionId: string;
  readonly label: string;
}

/** What *Where* reads of the channels list: each connection's id, name and whether it is on. */
const ChannelConnectionsSchema = z.object({
  connections: z.array(z.object({ connectionId: z.string().min(1), label: z.string(), enabled: z.boolean() })).max(256),
});

/** The workspace's enabled channels, for *Where*. */
export async function heartbeatChannels(client: SettingsClient, workspaceId: string): Promise<Outcome<readonly HeartbeatChannel[]>> {
  const answer = await read(client, "channels", { action: "list", workspaceId }, ChannelConnectionsSchema, { timeoutMs: 10_000 });
  return mapOutcome(answer, (value) =>
    value.connections
      .filter((connection) => connection.enabled)
      .map((connection) => ({ connectionId: connection.connectionId, label: connection.label })),
  );
}
