import type { HeartbeatGetAnswer } from "@tavi/contracts";
import type { ReactNode } from "react";
import type { useLoaded } from "../../hooks/use-loaded.js";
import type { Outcome } from "../../lib/ipc.js";
import { durationText } from "../../lib/time.js";
import type { RecurringKind } from "./RecurringRow.js";
import { weekdaysText } from "./schedule-model.js";

/** A list as `useLoaded` holds it. */
export type Loaded<T> = ReturnType<typeof useLoaded<T>>;

/** What a row says when nothing has run yet, whatever its kind. */
export const NOT_RUN = "Not run yet.";

/** The filter chips, in order. */
export const FILTERS = [
  { value: "all", label: "All" },
  { value: "reminder", label: "Reminders" },
  { value: "routine", label: "Routines" },
  { value: "schedule", label: "Schedules" },
  { value: "watcher", label: "Watchers" },
  { value: "failing", label: "Failing" },
  { value: "paused", label: "Paused" },
] as const;

export type Filter = (typeof FILTERS)[number]["value"];

/** One row of Recurring with what the list sorts, filters and pauses it by. */
export interface Entry {
  /** `kind:id`: the row's key, and what a held delete hides. */
  readonly key: string;
  readonly kind: RecurringKind;
  readonly name: string;
  /** When it runs next: the list's order, soonest first, nothing due last. */
  readonly next: string | null | undefined;
  readonly failing: boolean;
  readonly paused: boolean;
  /** A schedule whose trigger is a change (`watch`). */
  readonly watcher?: boolean;
  /** Pause it (Pause all): absent when it is not running or cannot be paused. */
  readonly pause?: (() => Promise<Outcome<unknown>>) | undefined;
  /** Resume it (after Pause all): absent unless it is paused and can be resumed. */
  readonly resume?: (() => Promise<Outcome<unknown>>) | undefined;
  readonly row: ReactNode;
}

/** Soonest next run first; nothing due after, by name. */
export function byNextRun(a: Entry, b: Entry): number {
  const at = (entry: Entry): number =>
    entry.next === null || entry.next === undefined ? Number.POSITIVE_INFINITY : Date.parse(entry.next);
  const gap = at(a) - at(b);
  return Number.isNaN(gap) || gap === 0 ? a.name.localeCompare(b.name) : gap;
}

export function matches(entry: Entry, filter: Filter, text: string): boolean {
  if (filter === "failing" && !entry.failing) return false;
  if (filter === "paused" && !entry.paused) return false;
  if (filter === "watcher" && entry.watcher !== true) return false;
  if ((filter === "reminder" || filter === "routine" || filter === "schedule") && entry.kind !== filter) return false;
  return text === "" || entry.name.toLowerCase().includes(text);
}

/** A routine's state that means something is wrong with it. */
export const ROUTINE_TROUBLE: ReadonlySet<string> = new Set(["credential-blocked", "paused-failures", "setup-needed"]);

/** The heartbeat's cadence in the words a schedule's has: "Mon–Fri every 30 min 08:00–22:00 · Europe/Berlin". */
export function heartbeatCadence(answer: Pick<HeartbeatGetAnswer, "config" | "timezone">): string {
  const { config } = answer;
  return `${weekdaysText(config.daysOfWeek) ?? "Daily"} every ${durationText(config.everyMs)} ${config.activeHours.start}–${config.activeHours.end} · ${answer.timezone}`;
}
