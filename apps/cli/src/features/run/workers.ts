import {
  TaviError,
  pendingRoundFromAdmission,
  unattendedDenial,
  type AdmissionOutcome,
  type AdmissionRecord,
  type ArtifactRepositoryPort,
  type ClientEvent,
  type WorkflowApprovalRequest,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { sleep } from "@tavi/node-kit";

/**
 * A one-shot `tavi run` and the workers its task spawns. Under `tavi serve` a
 * person decides a worker's approvals in the chat, and the owner keeps running until the workers end and the task they
 * report to answers. A one-shot run had neither: it exited when its task
 * waited on a worker, and nobody decided the rounds its workers raised.
 *
 * - `followWorkers` follows the task's workers — and theirs — and decides each
 *   round a worker suspends on the way the run decides its own (`--approval`,
 *   or the terminal), so a worker's call is never decided by a policy the run
 *   was not given.
 * - `nextSettledOutcome` waits, bounded by the wait's own deadline, for the
 *   task's next recorded outcome once a worker's ending resumes it.
 */

/** The decisions of one round, as a resume carries them. */
export interface RoundDecision {
  readonly callId: string;
  readonly approved: boolean;
  readonly decidedBy?: string;
  readonly scope?: "once" | "session" | "always";
  /** A refusal's reason, which the model reads as the call's result. */
  readonly note?: string;
}

/**
 * `--approval approve|deny` on one call of a round nobody sees. `deny` refuses
 * it. `approve` approves it unless `unattendedDenial` says a run nobody attends
 * must not (a taint-step ask, a tainted `askWhenTainted` call, a `critical`
 * call; an `attendedOnly` call such as a form fill), and then refuses it with that reason.
 */
export function automaticDecision(
  request: Pick<WorkflowApprovalRequest, "callId" | "gateReason" | "tainted" | "askWhenTainted" | "attendedOnly" | "risk">,
  approve: boolean,
  decidedBy: string,
): RoundDecision {
  const denial = approve ? unattendedDenial(request) : undefined;
  return {
    callId: request.callId,
    approved: approve && denial === undefined,
    decidedBy,
    ...(denial === undefined ? {} : { note: denial }),
  };
}

/**
 * `--approval approve` on a review round nobody sees: every artifact of the
 * round still `pending` is approved, recorded as decided by `decidedBy` (the
 * run's `auto:` decider), and copied into its chat's folder as an approval by a
 * person is — a download into `downloads/`. The run approved the calls that
 * made them (a download, a capture, an upload by path whose call passed the same
 * unattended checks as every other), so the model reads what its own tools
 * fetched, still labelled as they were stored. A decision another front end
 * made first stands. `deny` leaves the round for a person, as before.
 *
 * Only the run's own artifacts are released: one another task stored (its
 * `runId`), or of another workspace, is left for a person even when the
 * round names it — a tool result can name any id it was handed.
 *
 * Whether every artifact of the round now has a decision: a record that is gone,
 * or not the run's own, stays undecided (the review node treats it as pending),
 * so the caller stops rather than acknowledging a round that would only suspend again.
 */
export async function approveReviewRound(
  deps: {
    readonly artifacts: Pick<ArtifactRepositoryPort, "getArtifact" | "setReviewState">;
    readonly materializeArtifact?: (artifactId: string) => Promise<unknown>;
    readonly now: () => string;
  },
  owner: { readonly workspaceId: string; readonly taskId: string },
  artifactIds: readonly string[],
  decidedBy: string,
): Promise<boolean> {
  let decided = true;
  for (const artifactId of new Set(artifactIds)) {
    const record = await deps.artifacts.getArtifact(artifactId);
    if (record === undefined || record.workspaceId !== owner.workspaceId || record.runId !== owner.taskId) {
      decided = false;
      continue;
    }
    if (record.reviewState !== "pending") continue;
    try {
      await deps.artifacts.setReviewState({ artifactId, reviewState: "approved", reviewedBy: decidedBy, reviewedAt: deps.now() });
    } catch (error) {
      // Another front end decided it first (the compare-and-set from `pending`): its decision stands.
      if (!(error instanceof TaviError && error.code === "CONFLICT")) throw error;
      continue;
    }
    await deps.materializeArtifact?.(artifactId);
  }
  return decided;
}

type RoundRequests = NonNullable<Extract<ReturnType<typeof pendingRoundFromAdmission>, { readonly kind: "approval" }>["requests"]>;

export interface WorkerFollowDeps {
  /** Every event of `taskId`, from the first still retained: a worker spawned before the follow began is not missed. */
  readonly subscribe: (taskId: string, deliver: (event: ClientEvent) => void) => () => void;
  readonly latestSettledAdmission: (taskId: string) => Promise<AdmissionRecord | undefined>;
  /** The decisions for a worker's round, or `undefined` to leave it for a person (no policy, no terminal). */
  readonly decide: (workerTaskId: string, requests: RoundRequests) => Promise<readonly RoundDecision[] | undefined>;
  /** Resume the worker's round with the decisions. */
  readonly resume: (workerTaskId: string, steps: number, decisions: readonly RoundDecision[]) => Promise<void>;
  /** Something the person running should know: a round left undecided, or one that could not be decided. */
  readonly report: (message: string) => void;
  /** How long to wait for a round's outcome to be recorded after its event, in all. */
  readonly settleMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Follows the workers `rootTaskId` spawns, at any depth, deciding their rounds; answers how to stop. */
export function followWorkers(rootTaskId: string, deps: WorkerFollowDeps): { stop(): void; follows(taskId: string): boolean } {
  const wait = deps.sleep ?? sleep;
  const followed = new Map<string, () => void>();
  const handled = new Set<string>();
  // One round decided at a time — a terminal asks one question at once — but each resumed on its own: a resume
  // runs the worker's turn to its next stop, and the run's other workers must not wait behind it.
  let queue: Promise<void> = Promise.resolve();
  const failed =
    (taskId: string) =>
    (error: unknown): void => {
      deps.report(`A round of worker ${taskId} could not be decided: ${errorMessage(error)}`);
    };
  let stopped = false;

  /** The round's decisions, or `undefined` when it was not found or is left for a person. */
  const decideRound = async (workerTaskId: string, steps: number): Promise<readonly RoundDecision[] | undefined> => {
    // The event is published as the admission's outcome is recorded: read it back, briefly retried.
    let requests: RoundRequests | undefined;
    for (let waited = 0; requests === undefined && waited <= (deps.settleMs ?? 2_000); waited += 100) {
      const round = pendingRoundFromAdmission(await deps.latestSettledAdmission(workerTaskId));
      if (round?.kind === "approval" && round.steps === steps) requests = round.requests;
      else await wait(100);
    }
    if (requests === undefined || stopped) return undefined;
    const decisions = await deps.decide(workerTaskId, requests);
    if (decisions === undefined)
      deps.report(
        `Worker ${workerTaskId} is waiting on an approval: decide it with \`tavi approvals approve ${workerTaskId}\` (or reject).`,
      );
    return decisions;
  };

  const follow = (taskId: string): void => {
    if (followed.has(taskId) || stopped) return;
    followed.set(taskId, () => undefined);
    const stop = deps.subscribe(taskId, (event) => {
      if (event.kind === "task.spawned") follow(event.childRunId);
      // The root's own rounds are the run's loop's: only a worker's are decided here.
      if (event.kind !== "approval.required" || taskId === rootTaskId) return;
      const key = `${taskId}\u0000${event.steps}`;
      if (handled.has(key)) return;
      handled.add(key);
      const decided = queue.then(() => decideRound(taskId, event.steps));
      queue = decided.then(
        () => undefined,
        () => undefined,
      );
      void decided
        .then((decisions) => (decisions === undefined || stopped ? undefined : deps.resume(taskId, event.steps, decisions)))
        .catch(failed(taskId));
    });
    followed.set(taskId, stop);
  };

  follow(rootTaskId);
  return {
    // A worker this run saw spawned: one it can sit a wait out for.
    follows: (taskId) => taskId !== rootTaskId && followed.has(taskId),
    stop() {
      stopped = true;
      for (const stop of followed.values()) stop();
      followed.clear();
    },
  };
}

/**
 * Whether `outcome` is a wait one of the task's own workers ends (`agents.wait`
 * on a worker). A wait on a correlated reply, a handoff or a person's answer
 * is not the run's to sit out.
 */
export function waitsOnWorkers(
  outcome: AdmissionOutcome,
): outcome is AdmissionOutcome & { readonly waitInterrupt: NonNullable<AdmissionOutcome["waitInterrupt"]> } {
  return outcome.status === "waiting" && outcome.waitInterrupt?.wait.waitingOnWorkerTaskId !== undefined;
}

/**
 * The task's next recorded outcome after the one it holds now — the admission
 * a worker's ending (or the wait's deadline) starts — or `undefined` once
 * `deadlineAt` (plus a grace for the deadline sweep) passes while nothing of
 * the task runs, or `signal` aborts. A turn the deadline itself started is
 * waited for to its end: giving up then would shut the runtime under it.
 */
export async function nextSettledOutcome(
  taskId: string,
  deadlineAt: string,
  deps: {
    readonly latestSettledAdmission: (taskId: string) => Promise<AdmissionRecord | undefined>;
    /** Whether a turn of the task is under way now: an admission claimed or pending, with no outcome yet. */
    readonly running?: (taskId: string) => Promise<boolean>;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly pollMs?: number;
    readonly graceMs?: number;
  },
  signal: AbortSignal,
): Promise<AdmissionOutcome | undefined> {
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  const current = (await deps.latestSettledAdmission(taskId))?.admissionId;
  const until = Date.parse(deadlineAt) + (deps.graceMs ?? 90_000);
  while (!signal.aborted && (now() <= until || (await deps.running?.(taskId)) === true)) {
    await wait(deps.pollMs ?? 500);
    const latest = await deps.latestSettledAdmission(taskId);
    if (latest !== undefined && latest.admissionId !== current && latest.result !== null && latest.result !== undefined)
      return latest.result;
  }
  return undefined;
}
