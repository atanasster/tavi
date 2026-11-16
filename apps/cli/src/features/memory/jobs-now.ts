import { TaviError, type MemoryConsolidateNowAnswer, type MemoryReindexAnswer, type MemoryReviewNowAnswer } from "@tavi/contracts";

/**
 * The memory host's background jobs run on demand (`tavi memory reindex`,
 * `review-now`, `consolidate-now`): operator conveniences over the same job
 * code the `tavi.memory` tick runs (features/memory/vectors.ts, features/memory/idle-review.ts,
 * features/memory/consolidation.ts), each between ticks, never beside one. Not a new
 * behaviour: every rule of each job holds but its schedule.
 */
export interface MemoryJobsNow {
  /** One backfill pass for the workspace, then its counts. */
  reindex(workspaceId: string): Promise<MemoryReindexAnswer>;
  reviewNow(workspaceId: string, taskId?: string): Promise<MemoryReviewNowAnswer>;
  consolidateNow(workspaceId: string, principalId?: string): Promise<MemoryConsolidateNowAnswer>;
}

/**
 * Where the composition finds the jobs: set by the `tavi.memory` host when it
 * starts, cleared when it stops. Without it (the host disabled, or not
 * composed) each job is `UNAVAILABLE`.
 */
export function createMemoryJobsSlot(): { readonly jobs: MemoryJobsNow; readonly set: (jobs: MemoryJobsNow) => () => void } {
  let current: MemoryJobsNow | undefined;
  const live = (): MemoryJobsNow => {
    if (current === undefined)
      throw new TaviError("UNAVAILABLE", "The memory host (tavi.memory) is not running here: its background jobs cannot run");
    return current;
  };
  return {
    jobs: {
      reindex: async (workspaceId) => await live().reindex(workspaceId),
      reviewNow: async (workspaceId, taskId) => await live().reviewNow(workspaceId, taskId),
      consolidateNow: async (workspaceId, principalId) => await live().consolidateNow(workspaceId, principalId),
    },
    set: (jobs) => {
      current = jobs;
      return () => {
        if (current === jobs) current = undefined;
      };
    },
  };
}

/** How `tavi memory reindex` ended. */
export interface MemoryReindexOutcome {
  readonly last: MemoryReindexAnswer;
  /** Texts embedded over every pass. */
  readonly embedded: number;
  readonly passes: number;
  /** Why it stopped: `done` (nothing missing), `lexical`, `blocked`, `backing-off`, `stuck` (nothing more can be embedded) or `timeout`. */
  readonly stopped: "done" | "lexical" | "blocked" | "backing-off" | "stuck" | "timeout";
}

/**
 * `tavi memory reindex`: backfill passes until nothing is missing or nothing
 * more can be embedded, waiting out the minute's allowance between passes
 * (the backfill's own 600-a-minute bound), within `maxWaitMs` in all.
 * `progress` hears a line after each pass.
 */
export async function runMemoryReindex(input: {
  readonly pass: () => Promise<MemoryReindexAnswer>;
  readonly maxWaitMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly progress: (line: string) => void;
}): Promise<MemoryReindexOutcome> {
  const started = input.now();
  let embedded = 0;
  let passes = 0;
  for (;;) {
    const last = await input.pass();
    passes += 1;
    embedded += last.embedded;
    if (last.retrieval !== "hybrid") return { last, embedded, passes, stopped: "lexical" };
    if (last.blocked !== undefined) return { last, embedded, passes, stopped: "blocked" };
    input.progress(
      `indexed ${last.indexed}, missing ${last.missing}, failed ${last.failedTotal} (this pass: ${last.embedded} embedded${last.failed === 0 ? "" : `, ${last.failed} failed`})`,
    );
    if (last.missing === 0) return { last, embedded, passes, stopped: "done" };
    if (last.backingOff && last.embedded === 0) return { last, embedded, passes, stopped: "backing-off" };
    let wait = 0;
    if (last.limited) wait = Math.max(1_000, last.retryInMs ?? 60_000);
    else if (last.embedded === 0) return { last, embedded, passes, stopped: "stuck" };
    if (input.now() - started + wait > input.maxWaitMs) return { last, embedded, passes, stopped: "timeout" };
    if (wait > 0) {
      input.progress(`waiting ${Math.ceil(wait / 1000)} s for the embedding allowance (600 texts a minute)`);
      await input.sleep(wait);
    }
  }
}

/** The line `tavi memory reindex` ends with, after the counts. */
export function memoryReindexNote(outcome: MemoryReindexOutcome): string | undefined {
  switch (outcome.stopped) {
    case "done":
      return undefined;
    case "lexical":
      return "retrieval is lexical: vectors are only built with hybrid recall (tavi memory config retrieval hybrid)";
    case "blocked":
      return `nothing can be embedded: ${outcome.last.blocked ?? "the backfill is blocked"}`;
    case "backing-off":
      return "an embedding call failed: the backfill waits an hour before calling this model again (see the owner's log)";
    case "stuck":
      return "nothing more can be embedded now: what is missing failed three times on this model, or is waiting on a failed call";
    case "timeout":
      return "stopped at the time limit (--max-wait): run it again to go on";
  }
}
