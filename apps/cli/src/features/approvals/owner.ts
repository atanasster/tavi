import {
  IPC_NOT_PENDING,
  approvalChannelLabel,
  approvalRoundKey,
  roundResumeKey,
  type ApprovePayload,
  type ApproveResult,
  type ApprovalScope,
  type ExpectTarget,
} from "@tavi/contracts";

import {
  admitAnsweredOnClaim,
  isRefusal,
  pendingRoundOfKind,
  refuse,
  resumeTargetRefusal,
  runningHere,
  taskToDecide,
  type DecisionDependencies,
  type IpcAnswer,
} from "../../shared/ipc-decisions.js";
import { singleCallProblem } from "../../shared/rounds.js";

/**
 * IPC `approve`, and `approvals approve|reject` over IPC.
 *
 * A decision is for a **round** — every gated call one model turn produced — and
 * is admitted under the round's own key with the round as its in-queue
 * precondition, exactly as the foreground loop, the offline command and chat
 * decide one. So every front end deciding one round converges on one admission,
 * and a decision for a round that has moved on is refused rather than applied to
 * whatever is pending now.
 *
 * Every refusal this handler can make is made **before** admitting: an
 * admission refused by the precondition is committed under the round key, and a
 * correct decision under that key would then conflict with the refusal.
 */

export interface DecideRoundRequest {
  readonly taskId: string;
  readonly workspaceId: string;
  /** The round the client saw; a different pending round is refused, not decided. */
  readonly expectedSteps?: number | undefined;
  /** Exactly one of `verdict` (every call of the round) and `decisions` (each call once). */
  readonly verdict?: ApprovePayload["verdict"];
  readonly decisions?: ApprovePayload["decisions"];
  readonly decidedBy?: string | undefined;
  readonly note?: string | undefined;
  /** With `verdict: "approve"`: the scope for every call. */
  readonly scope?: ApprovalScope | undefined;
  /** The front end the decision came through, for the audit trail: `ipc` unless said. */
  readonly via?: string | undefined;
  /** `approvals approve|reject --call`: assert this is the round's only call. */
  readonly callId?: string | undefined;
  /** `approvals approve|reject` by row: the row must be the round's only call. */
  readonly approvalId?: string | undefined;
  /** `approvals approve|reject --connection/--model`: the target the resume must run on. */
  readonly expectTarget?: ExpectTarget | undefined;
}

export type DecideRoundAnswer = IpcAnswer<ApproveResult>;

/** What `decideRound` reads beyond a decision's own dependencies. */
export interface DecideRoundDependencies extends DecisionDependencies {
  /** A messaging connection's name as a person reads it (`Telegram`, `email`), for a late decision's `settled.channel`. */
  readonly channelName?: (connectionId: string) => string | undefined;
}

/** What deciding a round needs: its number, its calls, and the key it is decided under. */
interface RoundToDecide {
  readonly steps: number;
  readonly callIds: readonly string[];
  readonly operationKey: string;
}

/**
 * Decide a task's pending approval round.
 *
 * Answered when the decision is **claimed** — the precondition passed and the
 * resumed turn holds the execution slot — so a stale or partial decision is an
 * error the caller sees, not an event it has to find; the turn itself runs on
 * and ends on the task's stream. An identical decision already committed for the
 * round is answered from the record, and one already running under the round's
 * key is answered at once rather than after its turn ends.
 */
export async function decideRound(deps: DecideRoundDependencies, request: DecideRoundRequest): Promise<DecideRoundAnswer> {
  return withSettlement(deps, request, await decide(deps, request));
}

/**
 * A decision refused because its round is no longer pending (`NOT_PENDING`,
 * or `CONFLICT` for a different decision already committed) carries how the
 * round was settled as `details.settled` (`ApprovalSettlementSchema`), so a
 * page deciding from its inbox can say "Already decided in Telegram by Ana,
 * 14:02" rather than show an error. The code
 * and the message stay what they were: a client that reads neither loses
 * nothing. The round is the one the request named — by `expectedSteps`, or by
 * its approval row — else the task's most recently decided one.
 */
async function withSettlement(
  deps: DecideRoundDependencies,
  request: DecideRoundRequest,
  answer: DecideRoundAnswer,
): Promise<DecideRoundAnswer> {
  if (answer.ok || (answer.error.code !== IPC_NOT_PENDING && answer.error.code !== "CONFLICT")) return answer;
  try {
    const row = request.approvalId === undefined ? undefined : await deps.repositories.approvals.get(request.approvalId);
    const steps = request.expectedSteps ?? (row?.taskId === request.taskId ? row.steps : undefined);
    const settled = await deps.repositories.approvalInbox.settlement({ taskId: request.taskId, ...(steps === undefined ? {} : { steps }) });
    if (settled === undefined) return answer;
    const channel = settled.via === undefined ? undefined : approvalChannelLabel(settled.via, deps.channelName);
    return { ok: false, error: { ...answer.error, details: { settled: { ...settled, ...(channel === undefined ? {} : { channel }) } } } };
  } catch {
    // The refusal is the answer; how the round was settled only decorates it.
    return answer;
  }
}

async function decide(deps: DecisionDependencies, request: DecideRoundRequest): Promise<DecideRoundAnswer> {
  const workflow = deps.workflow;
  if (workflow === undefined) {
    return refuse("UNAVAILABLE", "this owner has no model connection, and a decision resumes the task's turn");
  }
  // Refused here, not left to the caller's validation: a request with neither
  // would otherwise read as a rejection of every call.
  if ((request.verdict === undefined) === (request.decisions === undefined)) {
    return refuse("INVALID_INPUT", "a decision needs exactly one of `verdict` or `decisions`");
  }
  const { taskId } = request;
  const found = await taskToDecide(deps, taskId, request.workspaceId);
  if (isRefusal(found)) return found;
  const { task } = found;
  const untargeted = await resumeTargetRefusal(deps, request.expectTarget, task);
  if (untargeted !== undefined) return untargeted;

  // A round already decided: the round the client names was decided and committed —
  // by this client, before a lost response, or by another front end. The same
  // decision is answered from the record and a different one conflicts, however
  // far the task has moved on since; only the round's own key can say which.
  let round = request.expectedSteps === undefined ? undefined : await committedRound(deps, taskId, request.expectedSteps);
  if (round === undefined) {
    const pending = await pendingRoundOfKind(deps, task, "approval", request.expectedSteps);
    if (isRefusal(pending)) return pending;
    round = { steps: pending.round.steps, callIds: pending.round.callIds, operationKey: roundResumeKey(taskId, pending.round) };
  }

  let callId = request.callId;
  if (request.approvalId !== undefined) {
    const row = await deps.repositories.approvals.get(request.approvalId);
    const inRound = row !== undefined && row.taskId === taskId && round.callIds.includes(row.callId) && row.steps === round.steps;
    if (!inRound) return refuse(IPC_NOT_PENDING, `approval ${request.approvalId} is not part of task ${taskId}'s pending round`);
    if (callId !== undefined && callId !== row.callId) {
      return refuse("INVALID_INPUT", `approval ${request.approvalId} is for call ${row.callId}, not ${callId}`);
    }
    callId = row.callId;
  }
  if (callId !== undefined) {
    const problem = singleCallProblem(taskId, round.callIds, callId);
    if (problem !== undefined) return refuse(problem.kind === "multi-call" ? "INVALID_INPUT" : IPC_NOT_PENDING, problem.message);
  }

  const decidedBy = request.decidedBy ?? "operator";
  let decisions: { callId: string; approved: boolean; note?: string; decidedBy: string; scope?: ApprovalScope }[];
  if (request.decisions !== undefined) {
    const problem = incompleteDecisions(round, request.decisions);
    if (problem !== undefined) return refuse("INVALID_INPUT", problem);
    decisions = request.decisions.map((decision) => {
      const note = decision.note ?? request.note;
      const scope = decision.approved ? (decision.scope ?? request.scope) : undefined;
      return {
        callId: decision.callId,
        approved: decision.approved,
        decidedBy,
        ...(note === undefined ? {} : { note }),
        ...(scope === undefined ? {} : { scope }),
      };
    });
  } else {
    // A verdict is expanded to the round's calls here, so its admission is the
    // same content as the equivalent per-call decisions from another front end.
    const approved = request.verdict === "approve";
    decisions = round.callIds.map((pendingCall) => ({
      callId: pendingCall,
      approved,
      decidedBy,
      ...(request.note === undefined ? {} : { note: request.note }),
      ...(approved && request.scope !== undefined ? { scope: request.scope } : {}),
    }));
  }

  const { operationKey, steps } = round;
  // Read before admitting: everything after it on the stream is the resumed turn.
  const cursor = deps.streamHead?.(taskId);
  return admitAnsweredOnClaim(
    workflow,
    {
      // The task's own identity: a follow-up admission is refused for any other
      // principal. `decidedBy` is attribution, recorded on the rows.
      context: { workspaceId: task.workspaceId, principalId: task.principalId, caller: "ipc", runId: taskId },
      taskId,
      operationKey,
      kind: "approval",
      resume: { decisions, decidedBy, via: request.via ?? "ipc", expectedSteps: steps },
    },
    { running: await runningHere(deps, taskId, operationKey), stillPending: "the decision" },
    (replayed, status) => ({
      taskId,
      steps,
      operationKey,
      decisions: decisions.map((decision) => ({ callId: decision.callId, approved: decision.approved })),
      replayed,
      ...(status === undefined ? {} : { status }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
}

/**
 * A round already decided and committed under its own key, as the round its
 * decision named: its calls are the approval rows written for that round.
 */
async function committedRound(deps: DecisionDependencies, taskId: string, steps: number): Promise<RoundToDecide | undefined> {
  const operationKey = approvalRoundKey(taskId, steps);
  const admission = await deps.repositories.tasks.getAdmission(taskId, operationKey);
  if (admission === undefined || admission.result === null || admission.state === "refused") return undefined;
  const callIds = (await deps.repositories.approvals.listForTask(taskId)).filter((row) => row.steps === steps).map((row) => row.callId);
  if (callIds.length === 0) return undefined;
  return { steps, callIds, operationKey };
}

/** Why a decision set is not exactly the round's calls, each once — or nothing. */
function incompleteDecisions(round: RoundToDecide, decisions: readonly { readonly callId: string }[]): string | undefined {
  const pending = new Set(round.callIds);
  const named = decisions.map((decision) => decision.callId);
  const repeated = named.filter((callId, index) => named.indexOf(callId) !== index);
  const unknown = named.filter((callId) => !pending.has(callId));
  const missing = round.callIds.filter((callId) => !named.includes(callId));
  if (repeated.length === 0 && unknown.length === 0 && missing.length === 0) return undefined;
  const parts = [
    ...(missing.length === 0 ? [] : [`missing ${missing.join(", ")}`]),
    ...(unknown.length === 0 ? [] : [`not in the round: ${unknown.join(", ")}`]),
    ...(repeated.length === 0 ? [] : [`repeated: ${[...new Set(repeated)].join(", ")}`]),
  ];
  return `decisions must name every call of round ${round.steps} exactly once (${parts.join("; ")}); nothing was decided`;
}
