import { type HEARTBEAT_TELL_ME, heartbeatCheckRan, type HeartbeatTickRecord } from "@tavi/contracts";

import { localDate, todayIn } from "../../lib/time.js";

/** One-tap lines the instructions can take, each a thing the built-in signals see. */
export const HEARTBEAT_SUGGESTIONS: readonly string[] = [
  "Approvals or questions waiting more than an hour",
  "Reminders and events in the next 2 hours",
  "Scheduled runs that fail",
  "Channels that need signing in again",
];
export const TELL_LABELS: Readonly<Record<(typeof HEARTBEAT_TELL_ME)[number], string>> = {
  "urgent-now": "Urgent things right away; the rest quietly here and in a summary when your next window opens",
  "everything-now": "Everything as it happens (still at most the hourly limit)",
  "digest-only": "Only the summary when your next window opens",
};
export const PAUSES: readonly { readonly value: string; readonly label: string; readonly forMs?: number }[] = [
  { value: "1h", label: "For an hour", forMs: 60 * 60_000 },
  { value: "4h", label: "For 4 hours", forMs: 4 * 60 * 60_000 },
  { value: "1d", label: "For a day", forMs: 24 * 60 * 60_000 },
  { value: "resume", label: "Until I resume it" },
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
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  needs: "Approvals, questions and reviews waiting",
  agenda: "Reminders and events coming up",
  schedules: "Scheduled runs that fail",
  apps: "Apps that need signing in again",
  // An owner without Connected apps names its channels' source so.
  connections: "Channels that need signing in again",
  held: "Messages held for review",
  messages: "Messages waiting for an answer",
  sends: "Messages that bounce or fail",
  routines: "Routines that fail",
  pages: "Watched pages",
  rooms: "Rooms waiting to be added or left",
  storage: "Storage running low",
};
