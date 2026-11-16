import {
  IPC_EXECUTION_BUSY,
  TaviError,
  roundResumeKey,
  type AdmissionOutcome,
  type ArtifactRecord,
  type ArtifactRepositoryPort,
  type ReviewPayload,
  type ReviewResult,
  type TaskRecord,
} from "@tavi/contracts";

import {
  admitAnsweredOnClaim,
  isRefusal,
  pendingRoundOfKind,
  refuse,
  resumeTargetRefusal,
  runningHere,
  slotHeldElsewhere,
  taskToDecide,
  type DecisionDependencies,
  type IpcAnswer,
  type IpcRefusal,
} from "../../shared/ipc-decisions.js";
import { artifactProblem } from "../../shared/rounds.js";

/**
 * IPC `review`: the artifact-review counterpart of `approve`.
 *
 * It decides artifacts the way `tavi artifacts approve|reject` does — each
 * artifact's review record, compare-and-set from `pending` — and, with
 * `resume`, acknowledges the task's review suspension the way `--resume` does:
 * under the suspension's own key, with the round as the in-queue precondition,
 * answered once the acknowledgement is claimed.
 *
 * Unlike the offline command, which records a decision and then finds there is
 * nothing to resume (exit 8), every refusal this handler's own checks make comes
 * before anything is written. Only the admission itself can still refuse after
 * the records are written — a busy slot or a cancellation that raced the
 * checks, or the in-queue precondition — and then the records stay decided and
 * the same request, sent again, acknowledges them.
 */

export interface ReviewDependencies extends DecisionDependencies {
  readonly now: () => string;
  /**
   * Copies an artifact this request approves, or finds already approved,
   * into its chat's folder — a download into `downloads/` — so approving again retries a copy that
   * failed. It never throws: a copy that fails leaves the decision as it is.
   */
  readonly materializeArtifact?: (artifactId: string) => Promise<unknown>;
}

interface PlannedDecision {
  readonly artifactId: string;
  readonly reviewState: "approved" | "rejected";
  readonly note?: string;
  /** Already in this state (with this note), so nothing is written for it. */
  alreadyDecided: boolean;
}

export async function reviewRound(deps: ReviewDependencies, request: ReviewPayload): Promise<IpcAnswer<ReviewResult>> {
  const resume = request.resume === true;
  const workflow = resume ? deps.workflow : undefined;
  if (resume && workflow === undefined) {
    return refuse("UNAVAILABLE", "this owner has no model connection, and `resume` re-admits the task's turn");
  }
  // Only a resume is checked against a round; without one it would be accepted
  // and never read, which a client could take to mean the round is current.
  if (!resume && request.expectedSteps !== undefined) {
    return refuse("INVALID_INPUT", "`expectedSteps` is only meaningful with `resume`");
  }
  const artifacts = deps.repositories.artifacts;
  const named = request.decisions.map((decision) => decision.artifactId);
  const repeated = [...new Set(named.filter((artifactId, index) => named.indexOf(artifactId) !== index))];
  if (repeated.length > 0) return refuse("INVALID_INPUT", `each artifact may be decided once (repeated: ${repeated.join(", ")})`);

  // Every artifact is checked, and read once, before any is written.
  const records: ArtifactRecord[] = [];
  for (const decision of request.decisions) {
    const checked = await checkedArtifact(artifacts, decision.artifactId, request.workspaceId);
    if (isRefusal(checked)) return checked;
    records.push(checked);
  }

  // Addressed by task, or by the artifacts alone — then their own task, or none.
  let taskId: string | null;
  if (request.taskId !== undefined) {
    taskId = request.taskId;
  } else {
    const owning = artifactsTask(records);
    if (isRefusal(owning)) return owning;
    taskId = owning.taskId;
  }
  let task: TaskRecord | undefined;
  if (taskId !== null) {
    const found = await taskToDecide(deps, taskId, request.workspaceId);
    if (isRefusal(found)) return found;
    task = found.task;
    // A resume runs a model turn; artifacts no task produced resume nothing.
    if (resume) {
      const untargeted = await resumeTargetRefusal(deps, request.expectTarget, task);
      if (untargeted !== undefined) return untargeted;
    }
  }

  const planned: PlannedDecision[] = [];
  for (const [index, decision] of request.decisions.entries()) {
    const artifact = records[index];
    if (artifact === undefined) throw new TaviError("INTERNAL", `artifact ${decision.artifactId} was checked but not kept`);
    if (artifact.runId !== taskId) return refuse("INVALID_INPUT", `Artifact ${decision.artifactId} does not belong to task ${taskId}`);
    const entry: PlannedDecision = {
      artifactId: decision.artifactId,
      reviewState: decision.approved ? "approved" : "rejected",
      ...(decision.note === undefined ? {} : { note: decision.note }),
      alreadyDecided: false,
    };
    if (artifact.reviewState !== "pending") {
      if (!sameDecision(artifact, entry)) {
        return refuse(
          "CONFLICT",
          `Artifact ${decision.artifactId} was already ${artifact.reviewState}` +
            `${artifact.reviewState === entry.reviewState ? " with a different note" : ""}; nothing was decided`,
        );
      }
      entry.alreadyDecided = true;
    }
    planned.push(entry);
  }
  const writes = planned.some((entry) => !entry.alreadyDecided);
  const result = (): ReviewResult["decisions"] =>
    planned.map(({ artifactId, reviewState, alreadyDecided }) => ({ artifactId, reviewState, alreadyDecided }));
  // Re-read after the writes: what `tavi artifacts approve|reject` prints.
  const decidedRecords = async (): Promise<readonly ArtifactRecord[]> =>
    (await Promise.all(planned.map(async (entry) => await artifacts.getArtifact(entry.artifactId)))).filter(
      (record) => record !== undefined,
    );

  let round: { readonly steps: number; readonly operationKey: string } | undefined;
  // Artifacts no task produced are only decided: no suspension waits on them.
  if (resume && task !== undefined && taskId !== null) {
    // A round the client names is replayed, as `approve` answers it: a retry of a request
    // whose acknowledgement committed finds every artifact already decided, and
    // an acknowledgement of that round made after those decisions — which saw
    // them. It is answered from that record, however far the task has moved on.
    if (!writes && request.expectedSteps !== undefined) {
      const acknowledged = await acknowledgementAfter(deps, taskId, request.expectedSteps, planned);
      if (acknowledged !== undefined) {
        return {
          ok: true,
          result: {
            taskId,
            decisions: result(),
            records: await decidedRecords(),
            resumed: {
              steps: request.expectedSteps,
              operationKey: acknowledged.operationKey,
              replayed: true,
              ...(acknowledged.status === undefined ? {} : { status: acknowledged.status }),
            },
          },
        };
      }
    }
    const pending = await pendingRoundOfKind(deps, task, "review", request.expectedSteps);
    if (isRefusal(pending)) return pending;
    const operationKey = roundResumeKey(taskId, pending.round);
    const held = await slotHeldElsewhere(deps, taskId, operationKey);
    if (held !== undefined) return held;
    // An acknowledgement of this suspension is already running: an ack carries
    // no content, so this one would be answered as that one — which may already
    // have read the artifacts, and not see what this request would write.
    if (writes && (await runningHere(deps, taskId, operationKey))) {
      return refuse(
        IPC_EXECUTION_BUSY,
        `task ${taskId}'s review is being acknowledged right now; nothing was decided — send this again once it settles`,
      );
    }
    round = { steps: pending.round.steps, operationKey };
  }

  const reviewedBy = request.reviewedBy ?? "operator";
  const written: string[] = [];
  for (const entry of planned) {
    if (!entry.alreadyDecided) {
      const failed = await decide(artifacts, entry, reviewedBy, deps.now(), written);
      if (failed !== undefined) return failed;
      if (!entry.alreadyDecided) written.push(entry.artifactId);
    }
    // Approving again retries a copy that failed; one already made is found and kept.
    if (entry.reviewState === "approved") await deps.materializeArtifact?.(entry.artifactId);
  }
  if (round === undefined) return { ok: true, result: { taskId, decisions: result(), records: await decidedRecords() } };
  if (workflow === undefined || task === undefined || taskId === null) {
    throw new TaviError("INTERNAL", "a review resume reached admission without a workflow or a task");
  }

  const { steps, operationKey } = round;
  const decisions = result();
  const decided = await decidedRecords();
  // Read before admitting: everything after it on the stream is the resumed turn.
  const cursor = deps.streamHead?.(taskId);
  return admitAnsweredOnClaim(
    workflow,
    {
      context: { workspaceId: task.workspaceId, principalId: task.principalId, caller: "ipc", runId: taskId },
      taskId,
      operationKey,
      kind: "approval",
      resume: { reviewAck: true, expectedSteps: steps },
    },
    {
      running: await runningHere(deps, taskId, operationKey),
      stillPending: "the acknowledgement (the artifact decisions are recorded)",
    },
    (replayed, status) => ({
      taskId,
      decisions,
      records: decided,
      resumed: {
        steps,
        operationKey,
        replayed,
        ...(status === undefined ? {} : { status }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  );
}

/** An artifact that exists in the workspace, or why it cannot be decided there. */
async function checkedArtifact(
  artifacts: ArtifactRepositoryPort,
  artifactId: string,
  workspaceId: string,
): Promise<ArtifactRecord | IpcRefusal> {
  const artifact = await artifacts.getArtifact(artifactId);
  const problem = artifactProblem(artifactId, artifact, workspaceId);
  if (problem !== undefined) return refuse(problem.code, problem.message);
  if (artifact === undefined) return refuse("NOT_FOUND", `No artifact ${artifactId}`);
  return artifact;
}

/**
 * The one task the named artifacts belong to — `null` when no task produced
 * them — or why they cannot be reviewed together.
 */
function artifactsTask(records: readonly ArtifactRecord[]): { readonly taskId: string | null } | IpcRefusal {
  const owners = new Set(records.map((record) => record.runId));
  if (owners.size > 1) {
    return refuse(
      "INVALID_INPUT",
      `the named artifacts belong to different tasks (${[...owners].map((owner) => owner ?? "none").join(", ")}); ` +
        "review each task's artifacts separately",
    );
  }
  return { taskId: [...owners][0] ?? null };
}

/** One decision, made again: the same state and — for a rejection, which the model reads — the same note. */
function sameDecision(artifact: { readonly reviewState: string; readonly reviewNote?: string }, entry: PlannedDecision): boolean {
  if (artifact.reviewState !== entry.reviewState) return false;
  return entry.reviewState === "approved" || artifact.reviewNote === entry.note;
}

/**
 * The committed acknowledgement of review round `steps` made at or after every
 * named artifact's decision, if there is one: it re-read those artifacts, so a
 * retry of the request that decided them has nothing left to do.
 */
async function acknowledgementAfter(
  deps: DecisionDependencies,
  taskId: string,
  steps: number,
  planned: readonly PlannedDecision[],
): Promise<{ readonly operationKey: string; readonly status?: AdmissionOutcome["status"] } | undefined> {
  const artifacts = deps.repositories.artifacts;
  const reviewedAt = await Promise.all(planned.map(async (entry) => (await artifacts.getArtifact(entry.artifactId))?.reviewedAt ?? ""));
  // biome-ignore lint/complexity/useMathMinMax: ISO timestamps, compared as strings; Math.max would make them NaN.
  const decidedAt = reviewedAt.reduce((latest, at) => (at > latest ? at : latest), "");
  const prefix = `review:${taskId.length}:${taskId}:${steps}:`;
  const admissions = await deps.repositories.tasks.listAdmissions(taskId);
  for (let index = admissions.length - 1; index >= 0; index -= 1) {
    const admission = admissions[index];
    if (admission === undefined || !admission.operationKey.startsWith(prefix)) continue;
    if (admission.result === null || admission.state === "refused" || admission.createdAt < decidedAt) continue;
    return { operationKey: admission.operationKey, status: admission.result.status };
  }
  return undefined;
}

/**
 * Write one artifact decision. A concurrent decider that got there first with
 * the same decision is the same decision; with another it is a conflict,
 * reported with what this request had already written.
 */
async function decide(
  artifacts: ArtifactRepositoryPort,
  entry: PlannedDecision,
  reviewedBy: string,
  reviewedAt: string,
  written: readonly string[],
): Promise<IpcAnswer<ReviewResult> | undefined> {
  try {
    await artifacts.setReviewState({
      artifactId: entry.artifactId,
      reviewState: entry.reviewState,
      reviewedBy,
      reviewedAt,
      ...(entry.note === undefined ? {} : { note: entry.note }),
    });
    return undefined;
  } catch (error) {
    const failure = TaviError.from(error);
    const now = await artifacts.getArtifact(entry.artifactId);
    if (failure.code === "CONFLICT" && now !== undefined && sameDecision(now, entry)) {
      entry.alreadyDecided = true;
      return undefined;
    }
    return refuse(
      failure.code,
      `${failure.message}; decided by this request before it: ${written.length === 0 ? "none" : written.join(", ")}; ` +
        "the task was not resumed",
    );
  }
}
