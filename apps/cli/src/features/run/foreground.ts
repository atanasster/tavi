import { emitError } from "../../cli/output.js";
import { EXIT, isOwnershipContention, reportFailure } from "../../cli/exit.js";
import {
  type ApprovalScope,
  TaviError,
  type AdmissionOutcome,
  type AdmissionResult,
  type InvocationContext,
  ATTENDED_TASK_POLICY,
  type TaskRepositoryPort,
  EXECUTION_SUPERSEDED,
  approvalRoundKey,
  automaticDecider,
  expectedStepsOf,
  approvalTitleOf,
  pendingRoundFromAdmission,
  roundResumeKey,
} from "@tavi/contracts";
import type { TaviRuntime } from "../../runtime/types.js";
import { approveReviewRound, automaticDecision, followWorkers, nextSettledOutcome, waitsOnWorkers, type RoundDecision } from "./workers.js";
import { promptForApprovalScope } from "../approvals/prompt.js";
import type { OutputFormat } from "../../cli/parse.js";
import type { RunCommandOptions } from "./parse.js";
import { createClientEventSink, createEventRenderer } from "./client-events.js";
import { createTaskStreamRenderer } from "./run-events.js";
import type { CliIo } from "../../cli/io.js";
import { clientOperationKey } from "../../cli/operation-key.js";
import { definedOnly } from "@tavi/contracts/util";
import { waitingText } from "./waiting-text.js";

export async function executeRun(runtime: TaviRuntime, options: RunCommandOptions, io: CliIo, signal: AbortSignal): Promise<number> {
  const workflow = runtime.workflow;
  if (workflow === undefined || !runtime.host.admissionOpen) {
    io.stderr("Runtime admission is closed: the workflow service is unavailable\n");
    return EXIT.unavailable;
  }

  // The task record owns the identity; the run id is a projection of it, so the
  // context is rebuilt once the durable task id is known.
  const identity = {
    workspaceId: options.workspaceId,
    principalId: options.principalId,
    caller: "cli",
  };
  const contextFor = (runId: string): InvocationContext => ({ ...identity, runId });
  const denied = runtime.access.authorize(contextFor("pending-admission"), ["runs.create", "models.invoke"]);
  if (denied !== undefined) {
    io.stderr(`Not authorized: ${JSON.stringify(denied.details ?? {})}\n`);
    return EXIT.unavailable;
  }

  const tasks = runtime.store.asPort().repositories.tasks;
  const operationKey = clientOperationKey(options.operationKey);
  // Rendered from the bus: the same stream an attached client receives, from
  // the one producer (the admission decorator), so the two cannot drift.
  const view = foregroundStream(runtime, options.format, io);
  const { renderer, stream } = view;

  let runId = "pending-admission";
  // One question at the terminal at a time: the run's own rounds and its workers'.
  let prompting: Promise<unknown> = Promise.resolve();
  const serially = <T>(ask: () => Promise<T>): Promise<T> => {
    const asked = prompting.then(ask);
    // Ordering only: the work's own failure reaches its caller through the promise it was handed.
    prompting = asked.catch(() => undefined);
    return asked;
  };
  // The workers the task spawns are followed, and their rounds decided as the run decides its own.
  let workers: ReturnType<typeof followWorkers> | undefined;
  const followTaskWorkers = (taskId: string): void => {
    workers ??= followWorkers(taskId, {
      subscribe: (followed, deliver) => {
        const subscribed = runtime.runEventBus.subscribe({ taskId: followed, from: "beginning", deliver });
        // The bus hands back what it retained; this caller delivers it before anything live arrives.
        for (const event of subscribed.replayed) deliver(event);
        return () => subscribed.subscription.unsubscribe();
      },
      latestSettledAdmission: (followed) => tasks.latestSettledAdmission(followed),
      decide: async (_workerTaskId, requests) => {
        if (options.approval === "approve" || options.approval === "deny") {
          return requests.map((request) =>
            automaticDecision(request, options.approval === "approve", automaticDecider(identity.principalId)),
          );
        }
        if (!io.isTty) return undefined;
        return serially(async () => {
          const decisions: RoundDecision[] = [];
          for (const request of requests) {
            const verdict = await promptForApprovalScope(
              `A worker: ${approvalTitleOf(request)}`,
              request.input,
              request.allowedScopes ?? ["once"],
              { isTty: io.isTty, write: io.stderr },
            );
            decisions.push({
              callId: request.callId,
              approved: verdict.approved,
              decidedBy: identity.principalId,
              ...(verdict.scope === undefined ? {} : { scope: verdict.scope }),
            });
          }
          return decisions;
        });
      },
      resume: async (workerTaskId, steps, decisions) => {
        await workflow.admit(
          {
            context: contextFor(workerTaskId),
            taskId: workerTaskId,
            operationKey: approvalRoundKey(workerTaskId, steps),
            kind: "approval",
            resume: { decisions: [...decisions], ...expectedStepsOf({ steps }) },
          },
          { signal },
        );
      },
      report: (message) => emitError(io, message),
    });
  };

  try {
    // The task identity is durable before any node runs, so the stream is
    // attached before its first event.
    let admission = await workflow.admit(
      {
        context: contextFor(runId),
        operationKey,
        kind: "start",
        // A person started this from their own terminal, so the run may ask them
        // a question; a creating admission that names no policy would get the
        // unattended default.
        executionPolicy: ATTENDED_TASK_POLICY,
        // The task's durable origin: an operator's own foreground run.
        origin: "cli",
        chatKind: "run",
        prompt: options.prompt,
        onAdmitted: (admitted) => {
          runId = admitted.taskId;
          stream.attach(admitted.taskId);
          followTaskWorkers(admitted.taskId);
        },
      },
      { signal },
    );

    if (admission.replay) {
      io.stderr(`Replayed committed admission for operation key ${operationKey}; no work was re-run.\n`);
    }

    // A suspended graph is resumed only by an explicit decision. A non-interactive
    // caller gets a documented status and exit code instead of an implicit yes.
    // A task that waits on its own worker is resumed when the worker ends: the run stays for it, to the wait's deadline.
    /** The review round this run last acknowledged: met again, it is left waiting rather than acknowledged in a loop. */
    let reviewedKey: string | undefined;
    for (;;) {
      while (
        admission.outcome.status === "waiting" &&
        (admission.outcome.interrupt !== undefined || (options.approval === "approve" && admission.outcome.reviewInterrupt !== undefined))
      ) {
        if (admission.outcome.interrupt === undefined) {
          // `--approval approve` releases what the run's own tools made for the model, as it approves their calls.
          const reviewed = await approveReviewOnce(
            runtime,
            admission.taskId,
            contextFor(admission.taskId),
            identity.principalId,
            reviewedKey,
            signal,
          );
          if (reviewed === undefined) break;
          reviewedKey = reviewed.key;
          admission = reviewed.admission;
          continue;
        }
        const requests = admission.outcome.interrupt.requests;
        // `approval.required` for each request is already on the stream: the
        // decorator mapped this outcome when the admission resolved.

        const decisions: {
          callId: string;
          approved: boolean;
          note?: string;
          decidedBy?: string;
          scope?: ApprovalScope;
        }[] = [];
        for (const request of requests) {
          if (options.approval === "approve" || options.approval === "deny") {
            // Decided for every round unseen: the call runs, but no person
            // allowed where it goes (a browser site off the allowlist stays refused).
            decisions.push(automaticDecision(request, options.approval === "approve", automaticDecider(identity.principalId)));
            continue;
          }
          try {
            // The terminal offers the call's scopes: `s`, `a` where offered.
            const verdict = await serially(() =>
              promptForApprovalScope(approvalTitleOf(request), request.input, request.allowedScopes ?? ["once"], {
                isTty: io.isTty,
                write: io.stderr,
                // `approval.required` printed the call (its diff or input) on the stream above.
                shown: options.format === "text",
              }),
            );
            decisions.push({
              callId: request.callId,
              approved: verdict.approved,
              decidedBy: identity.principalId,
              ...(verdict.scope === undefined ? {} : { scope: verdict.scope }),
            });
          } catch (error) {
            if (error instanceof TaviError && error.code === "APPROVAL_REQUIRED") {
              emitError(io, error.message);
              return EXIT.approvalRequired;
            }
            throw error;
          }
        }

        // Keyed on the round, as every front end deciding an approval is:
        // two front ends deciding one round converge on one admission, and the
        // in-queue precondition (`expectedSteps`) refuses a decision for a round
        // that has moved on. The resume's `attempt.replaced` is the decorator's,
        // published when the resume is claimed.
        const steps = requests[0]?.steps;
        if (steps === undefined) {
          renderer.finish();
          io.stderr(
            `run failed: the approval round shown for task ${admission.taskId} names no call; run \`tavi approvals list\` to see what is pending\n`,
          );
          return EXIT.unavailable;
        }
        const resumeKey = approvalRoundKey(admission.taskId, steps);
        admission = await workflow.admit(
          {
            context: contextFor(admission.taskId),
            taskId: admission.taskId,
            operationKey: resumeKey,
            kind: "approval",
            // `decisions` is authoritative; a top-level `approved` alongside it
            // would be an unread contradiction if the branch order ever changed.
            // The deciding identity is the invoking operator, recorded durably.
            resume: { decisions, ...expectedStepsOf({ steps }) },
          },
          { signal },
        );
      }
      // Only a worker this run saw spawned, and so runs here: a wait on any other is reported, as before.
      if (!waitsOnWorkers(admission.outcome) || workers?.follows(admission.outcome.waitInterrupt.wait.waitingOnWorkerTaskId ?? "") !== true)
        break;
      const resumed = await nextSettledOutcome(
        admission.taskId,
        admission.outcome.waitInterrupt.wait.deadlineAt,
        {
          latestSettledAdmission: (taskId) => tasks.latestSettledAdmission(taskId),
          running: async (taskId) =>
            (await tasks.listAdmissions(taskId)).some(
              (pending) => pending.result === null && (pending.state === "pending" || pending.state === "claimed"),
            ),
        },
        signal,
      );
      if (resumed === undefined) break;
      admission = { ...admission, outcome: resumed };
    }

    renderer.finish();

    return reportOutcome(admission.outcome, admission.taskId, io, options.format);
  } catch (error) {
    renderer.finish();
    return await reportAdmitFailure(error, runId === "pending-admission" ? undefined : runId, tasks, io, "run failed", view);
  } finally {
    workers?.stop();
    stream.detach();
  }
}

/**
 * `--approval approve`'s answer to the review round a task waits on: its
 * pending artifacts approved (`approveReviewRound`), then the suspension
 * acknowledged under the round's own key with the round as the precondition,
 * as `tavi artifacts approve --resume` acknowledges it. `undefined` when the
 * task's durable record names no review round to answer, the round is the one
 * acknowledged last (`previousKey`: it suspended again, so it is not acknowledged
 * in a loop), or an artifact of it is gone or not the run's own: the outcome is
 * then reported as waiting on review.
 */
async function approveReviewOnce(
  runtime: TaviRuntime,
  taskId: string,
  context: InvocationContext,
  principalId: string,
  previousKey: string | undefined,
  signal: AbortSignal,
): Promise<{ readonly admission: AdmissionResult; readonly key: string } | undefined> {
  const workflow = runtime.workflow;
  if (workflow === undefined) return undefined;
  const repositories = runtime.store.asPort().repositories;
  const round = pendingRoundFromAdmission(await repositories.tasks.latestSettledAdmission(taskId));
  if (round?.kind !== "review") return undefined;
  const key = roundResumeKey(taskId, round);
  if (key === previousKey) return undefined;
  const decided = await approveReviewRound(
    { artifacts: repositories.artifacts, materializeArtifact: runtime.materializeArtifact, now: () => runtime.clock.now() },
    { workspaceId: context.workspaceId, taskId },
    round.artifactIds,
    automaticDecider(principalId),
  );
  if (!decided) return undefined;
  const admission = await workflow.admit(
    {
      context,
      taskId,
      operationKey: key,
      kind: "approval",
      resume: { reviewAck: true, ...expectedStepsOf(round) },
    },
    { signal },
  );
  return { admission, key };
}

/**
 * The foreground's view of one task: its bus stream, rendered, and the failure
 * event the stream may lack.
 *
 * The decorator publishes a stream only for an admission it claimed, so a
 * failure before that — an unknown agent, a busy lease — leaves the stream
 * without an end. A `--format json` consumer still gets a terminal
 * `task.failed` for a failure: on the task's own stream when a task exists (same
 * epoch, next sequence — a separate sink would have restarted both in the middle
 * of a stream already rendered), and on a standalone sink only when no task was
 * ever created, so there is no stream to put it on.
 *
 * A **refused** admission is not a failure and gets no terminal event: the task
 * is exactly as it was (often still waiting), and `task.failed` would tell a
 * consumer otherwise. Its stream ends where it was, and the refusal is signalled
 * by exit 4 and stderr (`reportAdmitFailure`; docs/CLI.md, Output Formats).
 */
export function foregroundStream(runtime: TaviRuntime, format: OutputFormat, io: CliIo) {
  const renderer = createEventRenderer({ format, write: io.stdout });
  const stream = createTaskStreamRenderer(runtime.runEventBus, (event) => renderer.render(event));
  return {
    renderer,
    stream,
    failIfOpen(taskId: string | undefined, error: unknown): void {
      if (stream.ended()) return;
      const failure = TaviError.from(error);
      const event = { kind: "task.failed", errorCode: failure.code, message: failure.message } as const;
      if (taskId !== undefined) {
        stream.attach(taskId);
        runtime.runEventBus.publish(taskId, { ...event, runId: taskId, attemptId: runtime.clock.newId("attempt") });
        return;
      }
      createClientEventSink({
        epoch: runtime.clock.newEpochId(),
        now: () => runtime.clock.now(),
        onEvent: (rendered) => renderer.render(rendered),
      }).emit({ ...event, runId: "pending-admission", attemptId: runtime.clock.newId("attempt") });
    },
  };
}

/**
 * Report a `workflow.admit()` call that threw — shared by `tavi run`'s own
 * admission loop, `tavi approvals approve|reject` and `tavi artifacts
 * approve|reject --resume`, so the three cannot drift.
 *
 * Two outcomes:
 *
 * - **Refused** (`CONFLICT`, `NOT_FOUND`, `CANCELLED`, `NOT_AUTHORIZED`, bar the
 *   ownership lock's wording): the admission ran nothing — a stale round,
 *   another principal's task, a cancelled one, a key reused for a different
 *   decision — or its execution was superseded by another generation while it
 *   ran, which then owns the task. Either way the task is left as it is, no
 *   terminal event is published, and the exit is 4.
 * - **Failed**: anything else. A task the store already knows about is marked
 *   `"failed"` rather than left stuck in whatever non-terminal status it had,
 *   and a `task.failed` ends the stream when the decorator did not.
 *
 * `taskId` is `undefined` only for `executeRun`'s very first admission, before
 * the durable task id is known — nothing to mark failed yet.
 */
export async function reportAdmitFailure(
  error: unknown,
  taskId: string | undefined,
  tasks: TaskRepositoryPort,
  io: CliIo,
  prefix: string,
  /**
   * Where the failure is reported as an event when the stream has none: a
   * claimed admission's failure is already on the stream (the decorator
   * published it), and an unclaimed one's is not.
   */
  view: { readonly failIfOpen: (taskId: string | undefined, error: unknown) => void },
): Promise<number> {
  const taviError = TaviError.from(error);
  // The task is exactly as it was — often still waiting — so it is neither
  // marked failed nor reported as `task.failed`.
  if (taviError.details?.["reason"] === EXECUTION_SUPERSEDED) {
    io.stderr(`${prefix}: the execution was superseded while it ran; another generation owns the task (${taviError.message})\n`);
    return EXIT.unavailable;
  }
  if (isRefusedAdmission(taviError)) {
    io.stderr(`${prefix}: the admission was refused (${taviError.code}): ${taviError.message}\n`);
    return EXIT.unavailable;
  }
  if (taskId !== undefined) {
    await tasks.updateStatus(taskId, "failed", taviError.message);
  }
  view.failIfOpen(taskId, error);
  return reportFailure(error, io, prefix);
}

/** Codes an admission is refused with before it runs anything (the ownership lock aside). */
const REFUSED_ADMISSION_CODES: ReadonlySet<string> = new Set(["CONFLICT", "NOT_FOUND", "CANCELLED", "NOT_AUTHORIZED"]);

function isRefusedAdmission(error: TaviError): boolean {
  return REFUSED_ADMISSION_CODES.has(error.code) && !isOwnershipContention(error);
}

/**
 * Report a terminal or suspended `AdmissionOutcome` — shared by `tavi run`'s
 * own admission loop and `tavi artifacts approve|reject --resume`'s
 * re-admission, so both report `completed`/`reviewInterrupt`/`waitInterrupt`/
 * `task.failed` identically rather than drifting into two copies.
 */
export function reportOutcome(outcome: AdmissionOutcome, taskId: string, io: CliIo, format: OutputFormat): number {
  // The outcome's events are already on the stream: the admission decorator
  // mapped it (`emitOutcomeEvents`) before `admit` resolved, and the caller
  // renders that stream. This reports only what the stream cannot — stderr
  // guidance and the exit code.
  if (outcome.status === "completed") {
    if (format === "text") io.stdout("\n");
    return EXIT.ok;
  }

  // A suspended approval reaching here means the resume re-suspended: a model
  // that calls a second gated tool in a later turn. It is the same outcome the
  // foreground loop's own loop reports, and it must not fall through to
  // `task.failed`, which would misreport a task that is still waiting as failed.
  if (outcome.status === "waiting" && outcome.interrupt !== undefined) {
    for (const request of outcome.interrupt.requests) {
      io.stderr(`Pending approval: ${request.toolName} (call ${request.callId})\n`);
    }
    io.stderr(`Task ${taskId} is still waiting on an approval; decide it with \`tavi approvals approve ${taskId}\`.\n`);
    return EXIT.approvalRequired;
  }

  // A review suspension is not resolvable here the way
  // an approval is — the decision requires inspecting an artifact's real
  // content, which this loop has no way to render, so there is
  // deliberately no interactive prompt for it (unlike the approval loop
  // in `executeRun`). Reported distinctly rather than falling through to
  // `task.failed` below, which would misreport a task that is genuinely
  // still waiting — never resolved implicitly, never resolved wrongly.
  if (outcome.status === "waiting" && outcome.reviewInterrupt !== undefined) {
    for (const request of outcome.reviewInterrupt.requests) {
      io.stderr(`Pending artifact review: ${request.artifactId} (from ${request.toolName}, call ${request.callId})\n`);
    }
    io.stderr(
      `Task ${taskId} is waiting on artifact review. Decide with \`tavi artifacts approve <artifact-id>\` or \`tavi artifacts reject <artifact-id>\`, adding \`--resume\` to re-admit this task once every flagged artifact has a decision.\n`,
    );
    return EXIT.reviewRequired;
  }

  // A wait suspension (`agents.wait`) is not an operator decision the
  // way approval/review are — it resolves on its own, via a matching
  // correlated reply, a worker task completing, or its own deadline
  // (`packages/agent-host/src/agents/agent-wait-scheduler.ts`'s periodic sweep,
  // which is started for every model-backed composition — including
  // `tavi run`'s — but practically only gets a chance to fire during a
  // long-running `tavi serve` process: a one-shot `tavi run` stops its
  // own scheduler via `runtime.close()` well before the sweep's
  // 30s-default interval would ever tick). Reported distinctly,
  // honestly, and without inventing an interactive prompt: this loop
  // has nothing to ask an operator, and it must not fall through to `task.failed`
  // below, which would misreport a task that is genuinely still
  // waiting as if it had failed outright.
  if (outcome.status === "waiting" && outcome.waitInterrupt !== undefined) {
    const wait = outcome.waitInterrupt.wait;
    const on =
      wait.correlationId !== undefined
        ? `a reply correlated to ${wait.correlationId}`
        : wait.waitingOnWorkerTaskId !== undefined
          ? `worker task ${wait.waitingOnWorkerTaskId} completing`
          : "its deadline";
    const question = outcome.waitInterrupt.question;
    if (question !== undefined) {
      io.stderr(
        waitingText(taskId, { on, deadlineAt: wait.deadlineAt, question, ...definedOnly({ choices: outcome.waitInterrupt.choices }) }),
      );
      return EXIT.taskWaiting;
    }
    io.stderr(`Task ${taskId} is waiting on ${on} (deadline ${wait.deadlineAt}).\n`);
    io.stderr(
      `This resolves on its own — a matching reply, the worker's completion, or the deadline sweep (only meaningfully active during a long-running \`tavi serve\` process, not this one-shot invocation) — not an operator decision made here. Check \`tavi tasks ${taskId}\` to see whether it has resolved.\n`,
    );
    return EXIT.taskWaiting;
  }

  return EXIT.taskFailed;
}
