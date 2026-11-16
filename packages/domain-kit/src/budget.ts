import type { DatabaseSync } from "node:sqlite";

/**
 * A source's request budget: a token bucket of `perSecond` (a burst of
 * at most one second's worth, never less than one request) and a count per
 * UTC day under `perDay`. Kept in the store, so it holds across a worker's
 * idle stops and every watch that shares the source.
 */
export interface SourceBudget {
  readonly perSecond: number;
  readonly perDay: number;
}

export interface BudgetState {
  readonly tokens: number;
  /** When `tokens` was last refilled, in ms since the epoch. */
  readonly refilledAt: number;
  /** The UTC day `usedToday` counts, `YYYY-MM-DD`. */
  readonly day: string;
  readonly usedToday: number;
}

export type BudgetDecision =
  | { readonly ok: true; readonly state: BudgetState }
  | { readonly ok: false; readonly reason: "per-second" | "per-day"; readonly retryAfterMs: number; readonly state: BudgetState };

const DAY_MS = 86_400_000;
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Whether one request may go now, and the state after it (unchanged when it may not). */
export function takeBudget(budget: SourceBudget, previous: BudgetState | undefined, now: number): BudgetDecision {
  const capacity = Math.max(1, budget.perSecond);
  const day = utcDay(now);
  const usedToday = previous !== undefined && previous.day === day ? previous.usedToday : 0;
  const elapsed = previous === undefined ? Number.POSITIVE_INFINITY : Math.max(0, now - previous.refilledAt);
  const tokens = Math.min(capacity, (previous?.tokens ?? capacity) + (elapsed * budget.perSecond) / 1_000);
  const state: BudgetState = { tokens, refilledAt: now, day, usedToday };
  if (usedToday >= budget.perDay) return { ok: false, reason: "per-day", retryAfterMs: DAY_MS - (now % DAY_MS), state };
  if (tokens < 1) return { ok: false, reason: "per-second", retryAfterMs: Math.ceil(((1 - tokens) * 1_000) / budget.perSecond), state };
  return { ok: true, state: { tokens: tokens - 1, refilledAt: now, day, usedToday: usedToday + 1 } };
}

/** The table a domain's first migration creates for `createBudgetLedger`. */
export const BUDGETS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS budgets (
  source TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  refilled_at INTEGER NOT NULL,
  day TEXT NOT NULL,
  used_today INTEGER NOT NULL
) STRICT;`;

export interface BudgetLedger {
  /** One request of `source` now, if its budget allows; recorded when it does. */
  take(source: string, budget: SourceBudget, now: number): BudgetDecision;
  /** What `source` has used and has left, without taking anything. */
  peek(source: string): BudgetState | undefined;
}

/** Budgets kept in `db`'s `budgets` table (`BUDGETS_TABLE_SQL`). */
export function createBudgetLedger(db: DatabaseSync): BudgetLedger {
  const read = db.prepare("SELECT tokens, refilled_at, day, used_today FROM budgets WHERE source = ?");
  const write = db.prepare(
    "INSERT INTO budgets (source, tokens, refilled_at, day, used_today) VALUES (?, ?, ?, ?, ?) ON CONFLICT (source) DO UPDATE SET tokens = excluded.tokens, refilled_at = excluded.refilled_at, day = excluded.day, used_today = excluded.used_today",
  );
  const peek = (source: string): BudgetState | undefined => {
    const row = read.get(source) as
      | { readonly tokens: number; readonly refilled_at: number; readonly day: string; readonly used_today: number }
      | undefined;
    return row === undefined ? undefined : { tokens: row.tokens, refilledAt: row.refilled_at, day: row.day, usedToday: row.used_today };
  };
  return {
    peek,
    take: (source, budget, now) => {
      const decision = takeBudget(budget, peek(source), now);
      if (decision.ok) write.run(source, decision.state.tokens, decision.state.refilledAt, decision.state.day, decision.state.usedToday);
      return decision;
    },
  };
}
