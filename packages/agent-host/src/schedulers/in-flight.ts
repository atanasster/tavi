import type { SchedulePrecheck, SchedulePrecheckState } from "@tavi/contracts";

import type { RunBudget } from "./run-budget.js";

/** A pre-check's reading, with the pre-check that took it. */
export interface PrecheckReading {
  readonly of: SchedulePrecheck;
  readonly state: SchedulePrecheckState;
}

/**
 * The tasks a schedule's fire is deciding right now.
 *
 * A schedule-fired task's rounds are answered by the fire's own policy loop
 * while the fire lives, so an operator's `approve` is refused for exactly that
 * window — and only that one: a round left pending by a fire that has ended (a
 * crash, the policy-round limit, a failed resume) belongs to nobody, and is
 * decidable like any other. Keyed by task, because a schedule's next fire can be
 * in flight while an earlier fire's orphaned round waits for an operator.
 * Manual `run-now` fires are recorded too.
 */
export interface InFlightFires {
  /** The schedule whose in-flight fire owns this task, if one does. */
  scheduleOf(taskId: string): string | undefined;
  /** Whether any fire of this schedule is in flight — a manual one included, from its claim on. */
  hasSchedule(scheduleId: string): boolean;
}

export interface InFlightFireRegistry extends InFlightFires {
  /**
   * Take a fire's claim on its schedule, before it has a task: checked and taken
   * in one synchronous step, so of two fires asking at once — a scheduled one
   * that won its fire pointer, and one asked for now by a person, a webhook, an
   * email or a file watcher — exactly one goes on. `undefined` while anything of
   * the schedule is in flight. With `watch`, the claim is a file watcher's. The
   * returned release is idempotent.
   */
  claimSchedule(scheduleId: string, watch?: boolean): (() => void) | undefined;
  /** Whether everything of this schedule in flight is a file watcher's: its claim, its run and its workers. */
  watchOnly(scheduleId: string): boolean;
  /**
   * Record that a fire owns this task — with `watch`, a file watcher's run or
   * one of its workers. Counted: each call takes its own claim and needs its
   * own release. The returned release is idempotent.
   */
  enter(taskId: string, scheduleId: string, watch?: boolean): () => void;
  /** Whether this task in flight is a file watcher's run or one of its workers. */
  watchRun(taskId: string): boolean;
  /**
   * Keep a claim past the call that took it: the run is suspended on a worker
   * or a question, or has yet to hear from a worker it spawned, and goes on by
   * itself once that settles, so the schedule is still in flight until its
   * continuation settles it (`settle`). A hold whose run will not go on — its
   * task was cancelled — is released by `releaseEndedHolds`, and lapses at
   * `until` at the latest. Holding again replaces the earlier hold.
   */
  hold(taskId: string, release: () => void, until: string): void;
  /** Release the claim held for this task, if one is. */
  settle(taskId: string): void;
  /** Release every hold past its `until`, and drop the budget it kept for a continuation that did not come. */
  expireHolds(now: string): void;
  /** The tasks a hold is kept for. */
  heldTasks(): readonly string[];
  /**
   * Mark that a fire is still reporting on this task; the returned function
   * ends it.
   */
  reporting(taskId: string): () => void;
  /**
   * Once nothing reports on this task — its fire, or an earlier continuation —
   * mark that the caller does, so a continuation's record never lands before
   * one that came ahead of it. The returned function ends it.
   */
  reportingAfter(taskId: string): Promise<() => void>;
  /** The tasks a fire of this schedule owns: its run's, and those of the workers it is deciding. */
  tasksOf(scheduleId: string): readonly string[];
  /** The working-time budget a run carries from its fire into its continuations, if one is kept for this task. */
  budgetOf(taskId: string): RunBudget | undefined;
  /**
   * Keep a run's budget for its continuations, or, with `undefined`, drop it.
   * A spent one is kept, so what carries its stopped run on later records
   * nothing more; the oldest spent ones are dropped past a bound.
   */
  keepBudget(taskId: string, budget: RunBudget | undefined): void;
  /**
   * Note that the schedule's policy denied a run a `messaging.send_to`: kept as
   * long as the run's budget is, and only for a task whose budget is kept.
   */
  noteDeniedSend(taskId: string): void;
  /** Whether the schedule's policy denied this run a `messaging.send_to` while its budget is kept. */
  sendDenied(taskId: string): boolean;
  /** Note a call of any tool the schedule's policy denied this run: a quiet result may then only mean it was cut short. */
  noteDeniedCall(taskId: string): void;
  /** How many calls the schedule's policy denied this run while its budget is kept. */
  deniedCalls(taskId: string): number;
  /**
   * Keep what a suspended run's fire's pre-check read, for the report that ends the run: kept as long as the run's
   * budget is, and only for a task whose budget is kept.
   */
  keepReading(taskId: string, reading: PrecheckReading): void;
  /** What a suspended run's fire's pre-check read, while its budget is kept. */
  readingOf(taskId: string): PrecheckReading | undefined;
  /**
   * Charge a worker's model calls to the budget of the run that spawned it
   * while its turn runs; the returned function ends it.
   */
  chargeTo(taskId: string, budget: RunBudget): () => void;
  /**
   * Count `tokens` a model call of this task used on the budget it is charged
   * to: its own, kept for its run, or its run's while it is a worker's turn
   * (`chargeTo`). A task with neither, or a spent budget, counts nothing.
   */
  chargeTokens(taskId: string, tokens: number): void;
  /** Stop counting every kept budget and drop them all, so none stops a run once the owner shuts down. */
  dispose(): void;
}

/** How many spent budgets the registry keeps, so a stopped run's late continuation is recognised. */
const SPENT_BUDGETS_KEPT = 64;

export function createInFlightFires(): InFlightFireRegistry {
  // At most one per schedule: a claim is refused while anything of its schedule is in flight.
  const claims = new Map<string, { readonly watch: boolean }>();
  // Counted: a re-dispatch of one fire resolves to the same task, and the first
  // to finish must not clear the other's claim.
  const owners = new Map<string, { readonly scheduleId: string; readonly watch: boolean; count: number }>();
  const holds = new Map<string, { readonly release: () => void; readonly until: string }>();
  const reports = new Map<string, { readonly done: Promise<void>; readonly end: () => void }>();
  const budgets = new Map<string, RunBudget>();
  const charged = new Map<string, { readonly budget: RunBudget; count: number }>();
  const deniedSends = new Set<string>();
  const deniedCalls = new Map<string, number>();
  const readings = new Map<string, PrecheckReading>();
  const owned = (scheduleId: string): boolean => [...owners.values()].some((owner) => owner.scheduleId === scheduleId);
  const dropBudget = (taskId: string): void => {
    budgets.delete(taskId);
    deniedSends.delete(taskId);
    deniedCalls.delete(taskId);
    readings.delete(taskId);
  };
  const reporting = (taskId: string): (() => void) => {
    const existing = reports.get(taskId);
    if (existing !== undefined) return existing.end;
    let resolve: () => void = () => undefined;
    const done = new Promise<void>((settle) => {
      resolve = settle;
    });
    const entry = {
      done,
      end: () => {
        if (reports.get(taskId) === entry) reports.delete(taskId);
        resolve();
      },
    };
    reports.set(taskId, entry);
    return entry.end;
  };
  return {
    scheduleOf: (taskId) => owners.get(taskId)?.scheduleId,
    hasSchedule: (scheduleId) => claims.has(scheduleId) || owned(scheduleId),
    claimSchedule(scheduleId, watch = false) {
      if (claims.has(scheduleId) || owned(scheduleId)) return undefined;
      const claim = { watch };
      claims.set(scheduleId, claim);
      return () => {
        if (claims.get(scheduleId) === claim) claims.delete(scheduleId);
      };
    },
    watchOnly: (scheduleId) =>
      claims.get(scheduleId)?.watch !== false && [...owners.values()].every((owner) => owner.scheduleId !== scheduleId || owner.watch),
    tasksOf: (scheduleId) => [...owners].filter(([, owner]) => owner.scheduleId === scheduleId).map(([taskId]) => taskId),
    hold(taskId, release, until) {
      const earlier = holds.get(taskId);
      holds.set(taskId, { release, until });
      if (earlier !== undefined && earlier.release !== release) earlier.release();
    },
    settle(taskId) {
      const held = holds.get(taskId);
      holds.delete(taskId);
      held?.release();
    },
    expireHolds(now) {
      for (const [taskId, held] of [...holds]) {
        if (held.until > now) continue;
        holds.delete(taskId);
        held.release();
        // Nothing carries the run on any more: its budget would otherwise be kept for good. A spent one stays, bounded.
        const budget = budgets.get(taskId);
        if (budget === undefined || budget.spent) continue;
        budget.close();
        dropBudget(taskId);
      }
    },
    reporting,
    async reportingAfter(taskId) {
      for (let earlier = reports.get(taskId); earlier !== undefined; earlier = reports.get(taskId)) await earlier.done;
      return reporting(taskId);
    },
    heldTasks: () => [...holds.keys()],
    budgetOf: (taskId) => budgets.get(taskId),
    keepBudget(taskId, budget) {
      if (budget === undefined) {
        dropBudget(taskId);
        return;
      }
      budgets.delete(taskId);
      budgets.set(taskId, budget);
      let spent = [...budgets.values()].filter((kept) => kept.spent).length;
      for (const [id, kept] of budgets) {
        if (spent <= SPENT_BUDGETS_KEPT) break;
        if (!kept.spent) continue;
        dropBudget(id);
        spent -= 1;
      }
    },
    chargeTo(taskId, budget) {
      const entry = charged.get(taskId);
      if (entry !== undefined && entry.budget === budget) entry.count += 1;
      else charged.set(taskId, { budget, count: 1 });
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const current = charged.get(taskId);
        if (current === undefined || current.budget !== budget) return;
        current.count -= 1;
        if (current.count <= 0) charged.delete(taskId);
      };
    },
    chargeTokens(taskId, tokens) {
      if (!(tokens > 0)) return;
      (budgets.get(taskId) ?? charged.get(taskId)?.budget)?.tokens(tokens);
    },
    dispose() {
      for (const budget of budgets.values()) budget.close();
      budgets.clear();
      charged.clear();
      deniedSends.clear();
      deniedCalls.clear();
      readings.clear();
    },
    noteDeniedSend(taskId) {
      if (budgets.has(taskId)) deniedSends.add(taskId);
    },
    sendDenied: (taskId) => deniedSends.has(taskId),
    noteDeniedCall(taskId) {
      if (budgets.has(taskId)) deniedCalls.set(taskId, (deniedCalls.get(taskId) ?? 0) + 1);
    },
    deniedCalls: (taskId) => deniedCalls.get(taskId) ?? 0,
    keepReading(taskId, reading) {
      if (budgets.has(taskId)) readings.set(taskId, reading);
    },
    readingOf: (taskId) => readings.get(taskId),
    watchRun: (taskId) => owners.get(taskId)?.watch === true,
    enter(taskId, scheduleId, watch = false) {
      const entry = owners.get(taskId);
      if (entry === undefined) owners.set(taskId, { scheduleId, watch, count: 1 });
      else entry.count += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = owners.get(taskId);
        if (current === undefined) return;
        current.count -= 1;
        if (current.count <= 0) owners.delete(taskId);
      };
    },
  };
}
