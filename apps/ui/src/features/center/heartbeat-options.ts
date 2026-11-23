import { type HEARTBEAT_TELL_ME, heartbeatCheckRan, type HeartbeatTickRecord } from "@tavi/contracts";

import { translateNow } from "../../lib/i18n.js";
import { localDate, todayIn } from "../../lib/time.js";
import type { UiKey } from "../../locales/en.js";

/** One-tap lines the instructions can take, each a thing the built-in signals see. */
const HEARTBEAT_SUGGESTION_KEYS: readonly UiKey[] = [
  "center.heartbeatOptions.suggest.needs",
  "center.heartbeatOptions.suggest.upcoming",
  "center.heartbeatOptions.suggest.failedRuns",
  "center.heartbeatOptions.suggest.channels",
];

/** The suggested lines in the reader's language: added to the instructions as the person's own words. */
export const heartbeatSuggestions = (): readonly string[] => HEARTBEAT_SUGGESTION_KEYS.map((key) => translateNow(key));
export const TELL_LABELS: Readonly<Record<(typeof HEARTBEAT_TELL_ME)[number], UiKey>> = {
  "urgent-now": "center.heartbeatOptions.tell.urgentNow",
  "everything-now": "center.heartbeatOptions.tell.everythingNow",
  "digest-only": "center.heartbeatOptions.tell.digestOnly",
};
export const PAUSES: readonly { readonly value: string; readonly labelKey: UiKey; readonly forMs?: number }[] = [
  { value: "1h", labelKey: "center.heartbeatOptions.pause.hour", forMs: 60 * 60_000 },
  { value: "4h", labelKey: "center.heartbeatOptions.pause.fourHours", forMs: 4 * 60 * 60_000 },
  { value: "1d", labelKey: "center.heartbeatOptions.pause.day", forMs: 24 * 60 * 60_000 },
  { value: "resume", labelKey: "center.heartbeatOptions.pause.resume" },
];
export const EGRESS = ["instructions", "signals", "ledger", "memory"] as const;
/** Today's figures from the log: checks, deeper looks and tokens since the workspace's midnight. */
export function todaysFigures(
  ticks: readonly HeartbeatTickRecord[],
  timeZone: string,
): { readonly checks: number; readonly deep: number; readonly tokens: number; readonly usd: number | null } {
  const today = todayIn(timeZone);
  const ran = ticks.filter((tick) => localDate(tick.createdAt, timeZone) === today && heartbeatCheckRan(tick));
  const priced = ran.every((tick) => tick.costUsd !== null || tick.tokens === 0);
  return {
    checks: ran.length,
    deep: ran.filter((tick) => tick.kind === "deep").length,
    tokens: ran.reduce((sum, tick) => sum + tick.tokens, 0),
    usd: priced ? ran.reduce((sum, tick) => sum + (tick.costUsd ?? 0), 0) : null,
  };
}
/** The built-in signal sources by what they watch. */
const SOURCE_LABELS: Readonly<Record<string, UiKey>> = {
  needs: "center.heartbeatOptions.source.needs",
  agenda: "center.heartbeatOptions.source.agenda",
  schedules: "center.heartbeatOptions.source.schedules",
  apps: "center.heartbeatOptions.source.apps",
  // An owner without Connected apps names its channels' source so.
  connections: "center.heartbeatOptions.source.connections",
  held: "center.heartbeatOptions.source.held",
  messages: "center.heartbeatOptions.source.messages",
  sends: "center.heartbeatOptions.source.sends",
  routines: "center.heartbeatOptions.source.routines",
  pages: "center.heartbeatOptions.source.pages",
  rooms: "center.heartbeatOptions.source.rooms",
  storage: "center.heartbeatOptions.source.storage",
};

/** A built-in signal source's name, in the page's language; undefined for one that is not built in. */
export function sourceLabel(id: string): string | undefined {
  const key = SOURCE_LABELS[id];
  return key === undefined ? undefined : translateNow(key);
}

/** How often, as a choice in a list: "Every 30m", "Every 2h". */
export function everyInterval(ms: number): string {
  return translateNow("center.heartbeatOptions.every", { interval: heartbeatInterval(ms) });
}

/** A heartbeat interval in the page's language: "30m", "2h", "45s". */
export function heartbeatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return translateNow("center.heartbeatOptions.interval.hours", { count: ms / 3_600_000 });
  if (ms % 60_000 === 0) return translateNow("center.heartbeatOptions.interval.minutes", { count: ms / 60_000 });
  return translateNow("center.heartbeatOptions.interval.seconds", { count: Math.round(ms / 1000) });
}
