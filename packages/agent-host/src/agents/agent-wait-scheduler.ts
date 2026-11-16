import {
  askUserTimeoutOutcome,
  waitResumeOperationKey,
  type AgentDelegationRepositoryPort,
  type AgentWaitOutcome,
  type AgentWaitRepositoryPort,
  type InvocationContext,
  type TaskRecord,
  type TaskRepositoryPort,
  type WorkflowPort,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";

import type { RepeatTimer } from "../schedulers/sweep-loop.js";

/**
 * Wait-expiry sweep.
 *
 * There is no general due-task admission mechanism to reuse, so this is
 * the narrow, wait-specific
 * mechanism scoped to exactly what a deadline needs: periodically find
 * `active` waits whose deadline has passed and resume the graph each one
 * suspended, the same way `send()`'s wait-aware branch resumes one that
 * settled from a reply (`packages/agent-host/src/agents/agent-communication.ts`).
 *
 * A general due-work scheduler (also serving future non-wait due-work,
 * e.g. retries) is explicitly out of scope here.
 */

export interface SweepExpiredWaitsOptions {
  readonly waits: AgentWaitRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly workflow: WorkflowPort;
  /**
   * Restores a worker's `memoryScopeRestricted`/`delegatedMemoryRecordIds`
   * on the `InvocationContext` this sweep builds, the same way
   * `agent-communication.ts`'s `contextFrom` does for every context it
   * rebuilds. Optional only in the sense that a
   * caller who omits it gets an unrestricted context here — today that is
   * harmless because a `kind: "deadline"` resume admission never rewrites
   * the checkpointed `invocation` channel (`workflow/invocation.ts`'s `runInvocation`
   * only sets `invocation: input.context` when `resume === undefined`), so
   * this sweep's context is never actually read back for a worker's later
   * turns. Passed unconditionally by the real composition root
   * (`apps/cli/src/runtime/composition.ts` already has `agentDelegations`
   * available); left optional so existing fixtures/tests that construct
   * this port set don't all need updating for a field that is not yet
   * load-bearing.
   */
  readonly delegations?: AgentDelegationRepositoryPort;
  readonly now?: () => string;
  /**
   * How long a settled wait's promised resume may stay unadmitted before the
   * sweep admits it itself. The settler admits at once; this only
   * keeps the sweep from racing an admission still in flight. Default 30 s.
   */
  readonly resumeGraceMs?: number;
  /** Told of each wait this sweep settles by its deadline, before its task resumes — a question's message says it expired. */
  readonly onSettled?: (waitId: string, outcome: AgentWaitOutcome) => Promise<void>;
}

export interface SweepExpiredWaitsResult {
  /** Waits found past their deadline and successfully settled+resumed by this sweep. */
  readonly settled: number;
  /** Waits found past their deadline but already settled by a racing admission (e.g. a reply arriving concurrently) — not an error. */
  readonly alreadySettled: number;
  /** Waits found past their deadline whose owning task no longer exists — orphaned rows, logged for visibility rather than silently skipped. */
  readonly orphaned: readonly string[];
  /** Settled waits whose resume had not been admitted, re-admitted by this sweep. */
  readonly recovered: number;
  /** Waits whose recovered resume failed to admit; each is retried by the next sweep. */
  readonly failedResumes: readonly string[];
}

export const DEFAULT_RESUME_GRACE_MS = 30_000;

/**
 * One sweep pass: find every `active` wait past its deadline and resume
 * the task suspended on it. Safe to call repeatedly and concurrently —
 * `AgentWaitRepositoryPort.settle`'s conditional-transition-once contract
 * is what actually prevents a double-resume, exactly as it already does
 * for `send()`'s racing wait-settle path (`agent-wait-races.test.ts`
 * exercises the reply/deadline race settling exactly once).
 */
export async function sweepExpiredWaits(options: SweepExpiredWaitsOptions): Promise<SweepExpiredWaitsResult> {
  const now = options.now ?? nowTimestamp;
  const nowValue = now();
  const due = await options.waits.listActivePastDeadline(nowValue);

  let settled = 0;
  let alreadySettled = 0;
  const orphaned: string[] = [];

  for (const wait of due) {
    const task = await options.tasks.get(wait.taskId);
    if (task === undefined) {
      // The task was deleted (or never existed) after the wait was
      // registered; there is nothing to resume. Reported rather than
      // silently dropped so an orphaned row is visible, not a mystery.
      // Currently unreachable against the real SQLite-backed repository —
      // `tavi_agent_wait_intents.task_id` is `REFERENCES tavi_tasks
      // ON DELETE CASCADE` and nothing in this codebase deletes a task row
      // — kept for interface-level defensiveness (the port makes no such
      // guarantee) and for whenever task deletion/retention pruning is
      // added.
      orphaned.push(wait.waitId);
      continue;
    }
    // A question that named a default is answered with it.
    const outcome: AgentWaitOutcome = askUserTimeoutOutcome(wait.choices);
    const didSettle = await options.waits.settle({ waitId: wait.waitId, outcome, resume: true, by: "policy", via: "policy" });
    if (!didSettle) {
      // Lost the race to a concurrent settlement (e.g. `send()`'s
      // wait-aware branch settling the same wait from a reply that
      // arrived just before the deadline). Its own resume already
      // happened or is in flight — admitting a second one here would be
      // redundant, not merely harmless.
      alreadySettled += 1;
      continue;
    }
    await options.onSettled?.(wait.waitId, outcome);
    await resumeTask(options, task, wait.waitId, outcome, { via: "policy", decidedBy: "policy" });
    settled += 1;
  }

  // A settled wait whose resume was promised but never admitted — a crash or
  // a failed admit between the two — would leave its task `waiting` forever:
  // nothing else scans settled rows. The key is the one every settler uses,
  // so a resume that did run is replayed, not repeated.
  const settledBefore = new Date(Date.parse(nowValue) - (options.resumeGraceMs ?? DEFAULT_RESUME_GRACE_MS)).toISOString();
  let recovered = 0;
  const failedResumes: string[] = [];
  for (const wait of await options.waits.listPendingResumes(settledBefore)) {
    try {
      const task = await options.tasks.get(wait.taskId);
      // The admission under the wait's key is the record that its resume was
      // admitted — the turn may still be running (a task never reads
      // `running`: it stays `waiting` until the turn ends), or it finished
      // before `markResumed` ran. Either way there is nothing to re-admit.
      const admitted = task === undefined ? undefined : await options.tasks.getAdmission(task.taskId, waitResumeOperationKey(wait.waitId));
      if (task?.status === "waiting" && admitted === undefined && wait.settledOutcome !== undefined) {
        await resumeTask(options, task, wait.waitId, wait.settledOutcome);
        recovered += 1;
      } else {
        // Admitted already, or the task is gone or finished: no suspension is
        // left for this wait to resume.
        await options.waits.markResumed(wait.waitId);
      }
    } catch {
      // One resume that cannot be admitted must not hold back the others; it
      // stays pending and is tried again by the next sweep.
      failedResumes.push(wait.waitId);
    }
  }

  return { settled, alreadySettled, orphaned, recovered, failedResumes };
}

/**
 * Admits the resume a settled wait promised, then records that it ran.
 * `attribution` names who settled it, when this sweep did; a recovered resume
 * has none to give, and attribution is not part of the resume's identity.
 */
export async function resumeTask(
  options: Pick<SweepExpiredWaitsOptions, "waits" | "delegations" | "workflow">,
  task: TaskRecord,
  waitId: string,
  outcome: AgentWaitOutcome,
  attribution: { readonly via: string; readonly decidedBy: string } | undefined = undefined,
): Promise<void> {
  const delegation = await options.delegations?.getByWorkerTaskId(task.taskId);
  const context: InvocationContext = {
    workspaceId: task.workspaceId,
    principalId: task.principalId,
    runId: task.taskId,
    caller: "agent-wait-scheduler",
    ...(delegation === undefined
      ? {}
      : {
          memoryScopeRestricted: true,
          ...(delegation.sharedMemoryRecordIds === undefined ? {} : { delegatedMemoryRecordIds: delegation.sharedMemoryRecordIds }),
        }),
  };
  await options.workflow.admit({
    context,
    operationKey: waitResumeOperationKey(waitId),
    kind: "deadline",
    taskId: task.taskId,
    resume: { waitOutcome: outcome, waitId, ...attribution },
  });
  await options.waits.markResumed(waitId);
}

export interface AgentWaitSchedulerHandle {
  /** Stops future sweeps. Idempotent — calling it more than once is a no-op. */
  stop(): void;
  /** Sweep now rather than at the next tick (a deadline fell due); joins a sweep already running. */
  sweep(): Promise<SweepExpiredWaitsResult | undefined>;
}

export interface StartAgentWaitSchedulerOptions extends SweepExpiredWaitsOptions {
  readonly intervalMs: number;
  readonly onError?: (error: unknown) => void;
  /**
   * Called with every completed sweep's result, including ones that found
   * nothing to do. A caller that wants visibility into orphaned wait rows
   * (`SweepExpiredWaitsResult.orphaned` — see its own doc comment; normally
   * empty, currently unreachable against the real store per the note in
   * `sweepExpiredWaits`) should inspect it here, since a sweep that completes
   * without error never reaches `onError`.
   */
  readonly onSwept?: (result: SweepExpiredWaitsResult) => void;
  /** What runs the interval, where an owner coalesces its timers; ahead of `setIntervalFn`. */
  readonly every?: RepeatTimer;
  /** Injectable for tests; defaults to the real timer functions. */
  readonly setIntervalFn?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * Thin interval wrapper around `sweepExpiredWaits` for the composition root
 * (`apps/cli/src/runtime/composition.ts`) to run on a live process. Kept separate
 * from `sweepExpiredWaits` itself so a unit test can drive the sweep
 * directly, one call at a time, without a real timer in the loop.
 *
 * Safe under the CLI's single-data-directory-owner invariant
 * (`acquireDataDirectoryOwnership`): only the process holding that lock
 * ever constructs a `WorkflowPort` to pass in here, so there is never more
 * than one sweeper racing another process's sweeper over the same rows —
 * only the already-handled racing-admission case within one process
 * (`send()` vs. this sweep), covered by `settle`'s conditional transition.
 */
export function startAgentWaitScheduler(options: StartAgentWaitSchedulerOptions): AgentWaitSchedulerHandle {
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let stopped = false;
  // A sweep still admitting resumes when the next tick fires is left to
  // finish: two passes over the same pending rows would only queue duplicate
  // admissions behind each other.
  let sweeping: Promise<SweepExpiredWaitsResult | undefined> | undefined;
  const sweep = (): Promise<SweepExpiredWaitsResult | undefined> => {
    if (sweeping !== undefined) return sweeping;
    if (stopped) return Promise.resolve(undefined);
    sweeping = sweepExpiredWaits(options)
      .then(
        (result) => {
          options.onSwept?.(result);
          return result;
        },
        (error: unknown) => {
          options.onError?.(error);
          return undefined;
        },
      )
      .finally(() => {
        sweeping = undefined;
      });
    return sweeping;
  };
  const stopTicks =
    options.every?.(() => void sweep(), options.intervalMs) ??
    (() => {
      const handle = setIntervalFn(() => {
        void sweep();
      }, options.intervalMs);
      // Node's timer keeps the event loop alive by default; a scheduler a test
      // forgets to `stop()` should never be the reason a process hangs. Browser
      // `setInterval`'s return value has no `unref`, hence the guard.
      const unref = (handle as { unref?: () => void }).unref;
      if (typeof unref === "function") unref.call(handle);
      return () => clearIntervalFn(handle);
    })();
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      stopTicks();
    },
    sweep,
  };
}
