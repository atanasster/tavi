import { interrupt } from "@langchain/langgraph";
import type { z } from "zod";
import {
  AgentWaitInputSchema,
  agentWaitInputConflict,
  AskUserInputSchema,
  askUserChoicesOf,
  askUserTimeoutMs,
  boundAskUserDeadline,
  standingAnswerApplies,
  TaviError,
  waitRowId,
  WorkflowWaitSuspend,
  displaySafe,
} from "@tavi/contracts";
import { toModelError } from "../../../models/models.js";
import { disarmedQuestion, failureOutput, invalidInputOutput } from "../../dispatch.js";
import { AGENTS_WAIT_TOOL_ID, ASK_USER_TOOL_ID, toWaitInterruptPayload, waitOutputLabel, unlabelledWaitOutput } from "../../waits.js";
import { type ToolCall, type ToolRound, earliestInstant, startDirectCall } from "./round.js";

/**
 * `agents.wait` is dispatched directly against the agent-communication
 * service, bypassing `dispatchTool`/`runHandler`: both catch every
 * thrown error and convert it to a `TOOL_FAILED` message, which would
 * silently swallow `WorkflowWaitSuspend` instead of letting it become
 * a real `interrupt()`. The sole-pending-call guard in `tools.ts`
 * guarantees this is the only call in `calls` when it appears, so this
 * branch never interacts with the ledgered multi-call replay-safety
 * question that guard exists to avoid.
 *
 * The direct-dispatch branch reports through `onToolEvent` exactly as the
 * generic path does.
 *
 * Without it, an `ask_user` or `agents.wait` call — the
 * two calls an operator most wants to see — would be absent from the event
 * stream an attached client renders, while every ordinary tool reports
 * there.
 *
 * Not "exactly as the generic path does": this branch can suspend, and
 * `interrupt()` throws through the `try` below, so a suspending call emits
 * `started` and no terminal event until it settles. A resume re-enters this
 * node and emits a second `started` for the same `callId`; that is the
 * shape to expect in a stream, not a bug, but it is a shape the generic
 * path cannot produce.
 *
 * Deliberately **not** given an effect-ledger row: the durable record of
 * this call is the wait row (`waitId` derived deterministically from
 * `runId`/`steps`/`callId`, so a replay finds it) plus the messaging outbox
 * row for the question it sent. A ledger entry would be a third record of
 * the same act, with its own replay semantics to reconcile against the
 * other two.
 */
export async function runWaitCall(round: ToolRound, call: ToolCall): Promise<void> {
  const { current, toolsPolicy, humanQuestionsAllowedHere, workerWaitsAllowedHere } = round;
  const { now, options, originOf, replyDisarm, turnTainted } = round.scope;
  const finishDirect = await startDirectCall(round, call);
  // `agents.wait`'s result is labelled by what settled it, not untrusted wholesale: the
  // envelope's sender's label, never shown to the model. `ask_user`'s is its tool's, as before.
  const finish = (output: unknown, isError: boolean): Promise<void> =>
    call.name === AGENTS_WAIT_TOOL_ID
      ? finishDirect(unlabelledWaitOutput(output), isError, waitOutputLabel(output))
      : finishDirect(output, isError);
  const agents = options.agents?.();
  if (agents === undefined) {
    await finish({ error: "UNKNOWN_TOOL", toolName: call.name }, true);
    return;
  }
  const missing = options.access.missingPermissions(current.invocation, ["tools.invoke"]);
  if (missing.length > 0) {
    await finish({ error: "NOT_AUTHORIZED", missingPermissions: missing }, true);
    return;
  }
  // Deterministic across a replay: derived from checkpointed
  // `runId`/`callId`, never a freshly generated id, so a node that
  // restarts from the top on resume calls `waitFor` with the exact
  // same `waitId` every time (see `AgentWaitForInput.waitId`'s own
  // doc comment). Length-prefixing `runId` rules out the
  // `wait:${runId}:${callId}` composite colliding across two
  // different `(runId, callId)` pairs that happen to differ only in
  // where a colon falls (neither id is forbidden from containing
  // one) — e.g. `runId="A:B", callId="C"` vs. `runId="A",
  // callId="B:C"` would otherwise both produce `wait:A:B:C`.
  // `steps` is part of the key, not decoration: the id is built from the
  // *model-supplied* `call.id`, and a provider may reuse one across turns
  // (a counter-style scheme does exactly that). Without a per-turn
  // component, a second `operator.ask_user` reusing an earlier call id
  // found the first question's row and (a) never asked, while (b) handing
  // the model the *previous* answer as this call's result — silent wrong
  // data, reproduced in review. `steps` is checkpointed, so a replay of
  // the same turn still derives the same id and finds its settled row.
  const deterministicWaitId = waitRowId(current.runId, current.steps, call.id);

  // `ask_user` is `agents.wait` with a message in front of it: the question
  // goes out to the operator, and the wait it then creates is the
  // bare-deadline shape `messagingAdmitImpl` settles with a human's reply.
  let askUserInput: z.infer<typeof AskUserInputSchema> | undefined;
  if (call.name === ASK_USER_TOOL_ID) {
    // Checked again here, not only at the descriptor build: a replayed
    // checkpoint, a provider that ignores the offered tool list, or a
    // hand-crafted call still reaches this branch, and delivering the
    // question would put a message in front of a person who is not there
    // and suspend the task on a wait nobody can settle.
    if (!humanQuestionsAllowedHere) {
      await finish(
        {
          error: "HUMAN_INPUT_UNAVAILABLE",
          detail:
            "This run is unattended: it cannot ask a person a question. Answer with the information available and state what was missing.",
        },
        true,
      );
      return;
    }
    const parsedAsk = AskUserInputSchema.safeParse(call.input);
    if (!parsedAsk.success) {
      await finish(invalidInputOutput(parsedAsk.error.issues.map((issue) => issue.message)), true);
      return;
    }
    // Every surface shows what a question hides — a terminal control, a bidi override, an invisible character — as a mark.
    askUserInput = disarmedQuestion(parsedAsk.data, displaySafe);
    // A question written in a tainted turn goes out with its unknown URLs defanged, its options too.
    if (turnTainted(current)) askUserInput = disarmedQuestion(askUserInput, await replyDisarm(current));
    // An unattended run asks only what it can go on from unanswered.
    if (toolsPolicy.requiresDefault === true && (askUserInput.options === undefined || askUserInput.defaultOption === undefined)) {
      await finish(
        invalidInputOutput(
          "Nobody may be there to answer in this run: ask only with `options` and a `defaultOption`, the option to go with if nobody answers in time.",
        ),
        true,
      );
      return;
    }
    if (options.askUser === undefined) {
      // No channel is configured, so the question could never reach a
      // person. Failing here is the honest answer: suspending would park
      // the task until its deadline for a question nobody was asked.
      await finish({ error: "UNSUPPORTED", detail: "no messaging channel is configured, so the operator cannot be asked anything" }, true);
      return;
    }
  }

  // A non-question wait is refused the same way a question is when the
  // policy does not support it: before the wait row exists, with a bounded
  // typed result, so an unsupported wait fails visibly rather than
  // suspending a run nobody can settle.
  if (askUserInput === undefined && !workerWaitsAllowedHere) {
    await finish({ error: "HUMAN_INPUT_UNAVAILABLE", detail: "Waiting on another task is not supported for this run." }, true);
    return;
  }

  const parsedWait = AgentWaitInputSchema.safeParse(call.input);
  if (askUserInput === undefined && !parsedWait.success) {
    await finish(invalidInputOutput(parsedWait.error.issues.map((issue) => issue.message)), true);
    return;
  }
  const waitConflict = askUserInput === undefined && parsedWait.success ? agentWaitInputConflict(parsedWait.data) : undefined;
  if (waitConflict !== undefined) {
    await finish(invalidInputOutput(waitConflict), true);
    return;
  }

  const asked = askUserInput;
  const askUser = options.askUser;
  // A model's own deadline for its question, held to a minute–a week.
  const askedDeadline = asked?.deadlineAt === undefined ? undefined : boundAskUserDeadline(asked.deadlineAt, now());
  // Held inside the run's own budget, where it has one.
  const deadlineCap =
    asked === undefined || options.askUserDeadlineCap === undefined ? undefined : await options.askUserDeadlineCap(current.runId);
  if (deadlineCap !== undefined && Date.parse(deadlineCap) - Date.parse(now()) < 60_000) {
    await finish(
      {
        error: "HUMAN_INPUT_UNAVAILABLE",
        detail: "This run has no time left to wait for an answer: go on with the default and say so.",
      },
      true,
    );
    return;
  }
  const askUserChoices = asked === undefined ? undefined : askUserChoicesOf(asked);
  const standing =
    asked === undefined || askUserChoices === undefined || options.standingAnswer === undefined
      ? undefined
      : await options.standingAnswer({
          taskId: current.runId,
          waitId: deterministicWaitId,
          question: asked.question,
          choices: askUserChoices,
        });
  const standingOutcome =
    standing !== undefined && askUserChoices !== undefined && standingAnswerApplies(standing.answers, askUserChoices)
      ? standing
      : undefined;
  try {
    const output = await agents.waitFor({
      actor: {
        principalId: current.invocation.principalId,
        workspaceId: current.invocation.workspaceId,
        runId: current.runId,
        caller: current.invocation.caller,
      },
      taskId: current.runId,
      waitId: deterministicWaitId,
      // The question travels with the wait so a later attacher sees it,
      // and its choices so the answer can be read against them.
      ...(askUserInput?.question === undefined ? {} : { question: askUserInput.question }),
      ...(askUserChoices === undefined ? {} : { choices: askUserChoices }),
      ...(askUserInput?.context === undefined ? {} : { context: askUserInput.context }),
      ...(standingOutcome === undefined
        ? {}
        : {
            standing: {
              outcome: { kind: "answered" as const, answers: [...standingOutcome.answers] },
              by: standingOutcome.by,
              via: "standing-answer",
            },
          }),
      // The question goes out only once its wait row is active, so an
      // answer that lands at once settles it. A
      // question that could not be delivered must not suspend the task:
      // nobody knows it was asked, so the deadline would be the only thing
      // that ever resolved it — `waitFor` settles the row and rethrows.
      ...(asked === undefined || askUser === undefined
        ? {}
        : {
            deliver: async () => {
              await askUser({
                question: asked.question,
                ...(askUserChoices === undefined ? {} : { choices: askUserChoices }),
                ...(asked.context === undefined ? {} : { context: asked.context }),
                invocation: current.invocation,
                taskId: current.runId,
                waitId: deterministicWaitId,
                ...(asked.connectionId === undefined ? {} : { connectionId: asked.connectionId }),
                ...(asked.chatId === undefined ? {} : { chatId: asked.chatId }),
              });
            },
          }),
      ...(parsedWait.data?.correlationId === undefined ? {} : { correlationId: parsedWait.data.correlationId }),
      ...(parsedWait.data?.waitingOnWorkerTaskId === undefined ? {} : { waitingOnWorkerTaskId: parsedWait.data.waitingOnWorkerTaskId }),
      deadlineAt: earliestInstant(
        askedDeadline ??
          parsedWait.data?.deadlineAt ??
          // A person at a terminal or the canvas is there now; one asked
          // in a chat may answer tomorrow.
          new Date(Date.parse(now()) + askUserTimeoutMs(await originOf(current.runId))).toISOString(),
        deadlineCap,
      ),
    });
    // A replay of a turn whose delivery failed reads the same failure from
    // the row, and reports it as the error the first pass did.
    await finish(output, output.outcome.kind === "cancelled" && output.outcome.error?.code === "DELIVERY_FAILED");
  } catch (error) {
    if (error instanceof WorkflowWaitSuspend) {
      // The request is durable BEFORE the interrupt is raised — `waitFor`
      // already wrote the `prepared`/`active` row before throwing — so a
      // crash while suspended still leaves a record of exactly what this
      // call was waiting on, matching `approveNode`'s identical ordering
      // guarantee for approval requests.
      interrupt(toWaitInterruptPayload(error));
      // `interrupt()` throws to suspend on the first pass. It is not
      // expected to return here on a resume: `waitFor`'s own durable-row
      // check short-circuits before ever reaching this `catch` block
      // again once the wait is settled, so a resumed pass never re-enters
      // this branch's `try`. If it somehow does return (defensive-only —
      // no legitimate path produces this), fail loudly rather than guess.
      // Deliberately untested: reaching this line requires LangGraph's
      // own `interrupt()` to return instead of throw, which is not a
      // behavior this codebase can induce from a test without faking
      // LangGraph internals — doing so would test the fake, not this
      // branch.
      throw new TaviError("INTERNAL", `agents.wait resumed unexpectedly for wait ${error.waitId}`);
    }
    await finish(failureOutput(undefined, toModelError(error).message, error), true);
  }
  return;
}
