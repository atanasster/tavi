import {
  EXECUTION_BUSY,
  IPC_EXECUTION_BUSY,
  IPC_NOT_PENDING,
  TaviError,
  decidableRound,
  latestSettledAdmission,
  pendingRoundFromAdmission,
  type AdmissionOutcome,
  type AdmitInput,
  type ExpectTarget,
  type IpcCursor,
  type PendingRound,
  type PersistencePort,
  type TaskRecord,
  type TextRef,
  type TextRefParams,
  type WorkflowPort,
  englishOf,
  textRef,
} from "@tavi/contracts";
import type { CanvasCoreKey } from "@tavi/contracts/locales/core";
import type { InFlightFires } from "@tavi/agent-host/schedule-scheduler";

import { scheduleInFlightMessage, undecidableRoundMessage } from "./rounds.js";

/**
 * A follow-up refused because the task waits on a round to decide: a turn
 * would run past the round, leaving it pending and its calls unanswered in the
 * thread. Unless a turn is already under way (the decision's own), after which
 * a follow-up is an ordinary one. `reply` and a `run` into Home share it.
 */
export async function pendingRoundRefusal(
  tasks: Pick<PersistencePort["repositories"]["tasks"], "listAdmissions">,
  taskId: string,
  named: string,
): Promise<IpcRefusal | undefined> {
  const admissions = await tasks.listAdmissions(taskId);
  const inFlight = admissions.some(
    (admission) => admission.result === null && (admission.state === "pending" || admission.state === "claimed"),
  );
  const round = inFlight ? undefined : pendingRoundFromAdmission(latestSettledAdmission(admissions));
  if (round === undefined) return undefined;
  return refuse(
    "CONFLICT",
    `${named} waits on its ${round.kind} round ${round.steps}: decide it (${round.kind === "approval" ? "approve" : "review"}) first; nothing was delivered`,
  );
}

/**
 * What the owner's decision commands share: `approve` decides
 * an approval round, `review` artifact records and a review suspension.
 *
 * Both gate a request the same way — the task, its workspace, a schedule's fire
 * still deciding it, the round pending — and admit their resume the same way:
 * under the round's own key, answered once the resume is claimed. Kept here,
 * not in either command, so the two cannot drift in wording or order.
 */

export interface DecisionDependencies {
  readonly repositories: PersistencePort["repositories"];
  /** The decorated port, so the resumed turn publishes to the task's stream. */
  readonly workflow: WorkflowPort | undefined;
  readonly scheduleFires: InFlightFires;
  /** This owner's session: an execution lease it holds is a turn running here. */
  readonly ownerSession: string;
  /**
   * The model target the owner runs, as it resolves now: a resume on a placeholder is
   * refused, and one asserting another target too. Absent in a harness that
   * composes no target, which then checks neither.
   */
  readonly target?: OwnerTarget;
  readonly targetForTask?: (task: TaskRecord) => Promise<OwnerTarget | undefined>;
  /** The task's stream position, answered with a resume so a client follows exactly the resumed turn. */
  readonly streamHead?: (taskId: string) => IpcCursor | undefined;
}

/** What the decision commands read of the owner's model target. */
export interface OwnerTarget {
  readonly source: string;
  readonly connectionId: string;
  readonly model: string;
}

/**
 * A resume's target checks, in the offline order: after the task is found (an
 * unknown task is "nothing to decide" before it is anything else), before
 * anything is written or admitted.
 */
export async function resumeTargetRefusal(
  deps: Pick<DecisionDependencies, "target" | "targetForTask">,
  expected: ExpectTarget | undefined,
  task?: TaskRecord,
): Promise<IpcRefusal | undefined> {
  const target = (task === undefined ? undefined : await deps.targetForTask?.(task)) ?? deps.target;
  if (target === undefined) return undefined;
  return unconfiguredRefusal(target, "resuming the task") ?? targetRefusal(target, expected);
}

/** A refused request: the code a client acts on, and facts some refusals add (`settled` on a decision that came too late). */
export type IpcRefusal = {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    /** `message` by key, when a person reads it: the canvas says it in the workspace's language. */
    readonly i18n?: TextRef;
  };
};

/** An IPC command's answer: its result, or an error code a client acts on. */
export type IpcAnswer<R> = { readonly ok: true; readonly result: R } | IpcRefusal;

export const refuse = (code: string, message: string): IpcRefusal => ({ ok: false, error: { code, message } });

/** A refusal a person reads, by key: its message is the key's English, so the terminal reads what it always did. */
export function refuseKeyed(code: string, key: CanvasCoreKey, params?: TextRefParams): IpcRefusal {
  const i18n = textRef(key, params);
  return { ok: false, error: { code, message: englishOf(i18n), i18n } };
}

/**
 * A thrown error as a refusal: its code, its words and, when they are Tavi's, their key (`TaviError.toData`).
 * Its `details` go along only when given here, as each command decides which facts a client reads.
 */
export function refusalFrom(error: unknown, details?: Readonly<Record<string, unknown>>): IpcRefusal {
  const { code, message, i18n } = TaviError.from(error).toData();
  return {
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }), ...(i18n === undefined ? {} : { i18n }) },
  };
}

export const isRefusal = <T>(value: T | IpcRefusal): value is IpcRefusal =>
  typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;

/**
 * The refusal of a request that would run a model turn on an owner composed
 * against placeholders: the turn would fail inside the model call, and a
 * resumed task would be marked failed for a reason that is only configuration.
 */
export function unconfiguredRefusal(target: OwnerTarget, what: string): IpcRefusal | undefined {
  if (target.source !== "placeholder") return undefined;
  return refuse(
    "NOT_CONFIGURED",
    `this owner runs no configured model (only the placeholder ${target.connectionId}/${target.model}), and ${what} needs one: ` +
      "set one with `tavi models set-default --connection <id> --model <id>`; the next request runs it",
  );
}

/**
 * The refusal of a request asserting another target than the owner runs:
 * `INVALID_INPUT`, naming the owner's own, before anything is admitted or
 * written. `expectTarget` asserts the owner's default as it resolves now; a
 * chat's own model is chosen with `run`'s `model` or `models set-chat`.
 */
export function targetRefusal(target: OwnerTarget, expected: ExpectTarget | undefined): IpcRefusal | undefined {
  if (expected === undefined) return undefined;
  const connectionMatches = expected.connectionId === undefined || expected.connectionId === target.connectionId;
  const modelMatches = expected.model === undefined || expected.model === target.model;
  if (connectionMatches && modelMatches) return undefined;
  return refuse(
    "INVALID_INPUT",
    `this owner runs ${target.connectionId}/${target.model}, not ` +
      `${expected.connectionId ?? target.connectionId}/${expected.model ?? target.model}: ` +
      `name ${target.connectionId}/${target.model} (or omit --connection and --model where they are optional), ` +
      "or make the other target the default (`tavi models set-default`)",
  );
}

/**
 * The task a decision is for, or why there is none to decide.
 *
 * - No such task is `NOT_PENDING` — nothing to decide — as the offline commands
 *   answer it (exit 8), so an attached caller gets the unattached answer.
 * - Another workspace's task is `INVALID_INPUT`: the decision runs as the task's
 *   own principal, in the task's own workspace.
 * - A task a schedule's fire is still deciding is `NOT_AUTHORIZED`:
 *   the fire's policy answers it; an operator decides only what a dead fire
 *   left behind.
 */
export async function taskToDecide(
  deps: DecisionDependencies,
  taskId: string,
  workspaceId: string,
): Promise<{ readonly task: TaskRecord } | IpcRefusal> {
  const task = await deps.repositories.tasks.get(taskId);
  if (task === undefined) return refuse(IPC_NOT_PENDING, `no task ${JSON.stringify(taskId)} exists; nothing to decide`);
  if (task.workspaceId !== workspaceId) {
    return refuse("INVALID_INPUT", `Task ${taskId} belongs to workspace ${task.workspaceId}, not ${workspaceId}`);
  }
  const schedule = deps.scheduleFires.scheduleOf(taskId);
  if (schedule !== undefined) return refuse("NOT_AUTHORIZED", scheduleInFlightMessage(taskId, schedule));
  return { task };
}

/**
 * The round of `kind` the task is waiting on, checked against the round the
 * client saw — or why it cannot be decided (`NOT_PENDING`, or `CONFLICT` when
 * another round is pending).
 */
export async function pendingRoundOfKind<K extends PendingRound["kind"]>(
  deps: DecisionDependencies,
  task: TaskRecord,
  kind: K,
  expectedSteps: number | undefined,
): Promise<{ readonly round: Extract<PendingRound, { readonly kind: K }> } | IpcRefusal> {
  const decidability = await decidableRound(deps.repositories, task);
  if (!decidability.decidable) return refuse(IPC_NOT_PENDING, undecidableRoundMessage(task.taskId, decidability, kind));
  const round = decidability.round;
  if (round.kind !== kind) {
    return refuse(
      IPC_NOT_PENDING,
      round.kind === "review"
        ? `task ${task.taskId} is waiting on an artifact review, not an approval; decide it with \`review\` (or \`tavi artifacts approve|reject --resume\`)`
        : `task ${task.taskId} is waiting on an approval, not an artifact review; decide it with \`approve\` (or \`tavi approvals approve|reject\`)`,
    );
  }
  if (expectedSteps !== undefined && round.steps !== expectedSteps) {
    const what = kind === "review" ? "review round" : "round";
    return refuse(
      "CONFLICT",
      `${what} ${expectedSteps} of task ${task.taskId} is no longer pending (round ${round.steps} is); nothing was decided`,
    );
  }
  return { round: round as Extract<PendingRound, { readonly kind: K }> };
}

/** What the lease checks read: the task's admissions and executions, and this owner's session. */
type LeaseView = {
  readonly repositories: Pick<PersistencePort["repositories"], "tasks" | "executions">;
  readonly ownerSession: string;
};

/** Whether the admission under this key is the turn this owner is running now. */
export async function runningHere(deps: LeaseView, taskId: string, operationKey: string): Promise<boolean> {
  const existing = await deps.repositories.tasks.getAdmission(taskId, operationKey);
  if (existing === undefined) return false;
  return isRunningHere(existing, await deps.repositories.executions.current(taskId), deps.ownerSession);
}

/**
 * Whether `admission` is the turn `ownerSession` is running now: claimed with
 * no outcome, under an active lease that session holds for that very
 * admission. The one definition the decision handlers and `doctor` share.
 */
export function isRunningHere(
  admission: { readonly admissionId: string; readonly state: string; readonly result: unknown },
  lease: { readonly state: string; readonly admissionId: string; readonly ownerSession: string } | null | undefined,
  ownerSession: string,
): boolean {
  return (
    admission.state === "claimed" &&
    admission.result === null &&
    lease?.state === "active" &&
    lease.admissionId === admission.admissionId &&
    lease.ownerSession === ownerSession
  );
}

/** The `tavi recover` that frees a task's slot, as every message names it. */
export const recoverCommand = (taskId: string, generation: number | string): string =>
  `\`tavi recover ${taskId} --generation ${generation} --reason <text>\``;

/**
 * `EXECUTION_BUSY` when the task's execution slot is held by anything but the
 * admission under this key running here — checked before a command writes, so
 * the usual busy slot (an owner that died holding it) refuses first rather than
 * after. The admission's own `acquire` stays the authority for a race.
 */
export async function slotHeldElsewhere(deps: LeaseView, taskId: string, operationKey: string): Promise<IpcRefusal | undefined> {
  const lease = await deps.repositories.executions.current(taskId);
  if (lease === undefined || lease.state !== "active") return undefined;
  if (await runningHere(deps, taskId, operationKey)) return undefined;
  return refuse(
    IPC_EXECUTION_BUSY,
    `Task ${taskId} is executing under ${lease.ownerSession} (generation ${lease.generation}); nothing was decided — ` +
      `if that owner is gone, ${recoverCommand(taskId, lease.generation)} frees it`,
  );
}

/**
 * Admit a decision (`approve`'s resume, `review`'s acknowledgement) and answer
 * the IPC request once it is **claimed** — or from the record, for a replay.
 *
 * The turn itself runs on and ends on the task's stream; the caller has its
 * answer by then. `running` says the decision's key is already claimed by a
 * turn this owner is running: an identical decision queued behind it would only
 * be answered when that whole turn ends, long after a client's request timeout,
 * so it is answered as soon as its content has been checked against the running
 * one — `onAdmitted` fires after that check, and a different decision conflicts
 * before it. `stillPending` says, for a busy slot, what the caller has left
 * undone ("the decision", or "the acknowledgement" once records were written).
 */
export function admitAnsweredOnClaim<R>(
  workflow: WorkflowPort,
  input: Omit<AdmitInput, "onAdmitted" | "onClaimed"> & { readonly taskId: string },
  options: { readonly running: boolean; readonly stillPending: string },
  answerFor: (replayed: boolean, status?: AdmissionOutcome["status"]) => R,
): Promise<IpcAnswer<R>> {
  const { taskId } = input;
  return new Promise<IpcAnswer<R>>((resolve) => {
    let answered = false;
    const answer = (value: IpcAnswer<R>): void => {
      if (answered) return;
      answered = true;
      resolve(value);
    };
    const ok = (replayed: boolean, status?: AdmissionOutcome["status"]): IpcAnswer<R> => ({
      ok: true,
      result: answerFor(replayed, status),
    });
    workflow
      .admit({
        ...input,
        onAdmitted: (admitted) => {
          if (options.running && !admitted.created) answer(ok(true));
        },
        onClaimed: () => answer(ok(false)),
      })
      .then(
        (admission) => {
          if (answered) return;
          // Answered without a claim. A cancellation recorded after the caller's
          // checks — or replayed from an earlier such answer — decided nothing.
          if (admission.outcome.error?.code === "CANCELLED") {
            answer(refuse("CANCELLED", admission.outcome.finalText));
            return;
          }
          answer(ok(admission.replay, admission.outcome.status));
        },
        (error: unknown) => {
          // After the claim the caller already has its answer, and the turn's
          // failure is on the stream and reported by the decorator.
          if (answered) return;
          answer(refusalOf(error, taskId, options.stillPending));
        },
      );
  });
}

/**
 * The IPC refusal for an admission that failed before it was claimed. A busy
 * slot — a turn still running, or an owner that died holding it — is
 * `EXECUTION_BUSY`, naming what is still pending and the `tavi recover` that
 * frees a dead owner's slot.
 */
export function refusalOf(error: unknown, taskId: string, stillPending: string): IpcRefusal {
  const failure = TaviError.from(error);
  if (failure.details?.["reason"] === EXECUTION_BUSY) {
    const generation = failure.details["generation"];
    return refuse(
      IPC_EXECUTION_BUSY,
      `${failure.message}; ${stillPending} is still pending — if that owner is gone, ` +
        `${recoverCommand(taskId, typeof generation === "number" ? generation : "<n>")} frees it`,
    );
  }
  return refusalFrom(failure);
}
