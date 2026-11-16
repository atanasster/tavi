import { interrupt } from "@langchain/langgraph";
import {
  isTrustedPublic,
  isUntrusted,
  mergeUrlKeys,
  BROWSER_REQUEST_HANDOFF_TOOL_ID,
  askUserTimeoutMs,
  TaviError,
  type AgentWaitOutcome,
  type WorkflowMessage,
  WorkflowWaitSuspend,
  canonicalizeAdmission,
  parseAgentState,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { CallSchema, MAX_TOOL_QUESTIONS, validateToolInput } from "../dispatch.js";
import { resultUrlKeys, readsTypedPage } from "../known-urls.js";
import { annotateBrowserProgress, REPEATED_CALL_ERROR, readOnlyToolOf, repeatEscalation } from "../repeats.js";
import { threadIdOf, assertLeaseCurrent } from "../run-config.js";
import type { WorkflowScope } from "../scope.js";
import type { WorkflowNode } from "../state.js";
import { AGENTS_WAIT_TOOL_ID, ASK_USER_TOOL_ID, toWaitInterruptPayload, speakingTaskOf } from "../waits.js";
import { type ToolRound, observedInput, runDispatch } from "./tools/round.js";
import { toolQuestionFor } from "./tools/questions.js";
import { startEarlyRun } from "./tools/early.js";
import { runToolSearch } from "./tools/search.js";
import { runHandoffCall } from "./tools/handoff.js";
import { runWaitCall } from "./tools/waits.js";

/**
 * LangGraph workflow adapter.
 *
 * Owns the agent loop, checkpointing through the pinned SQLite saver, and the
 * approval suspend/resume path. It never imports a concrete model or tool
 * implementation: those arrive as injected ports.
 */

/** The tools node: runs the pending calls the gate and the approvals let through. */
export function createToolsNode(scope: WorkflowScope): WorkflowNode {
  const {
    callNeedsApproval,
    executionPolicyOf,
    hardDenyOf,
    labelOf,
    maxToolCalls,
    now,
    observers,
    options,
    originOf,
    outsideResult,
    refreshLease,
    toolContextOf,
    toolDisclosureRefusal,
    turnTainted,
    verdictOf,
    workerModelUrls,
  } = scope;
  const toolsNode: WorkflowNode = async (state, config) => {
    const current = parseAgentState(state);
    const admission = observers.get(threadIdOf(config));
    await assertLeaseCurrent(options, config);
    await refreshLease(config);
    if (admission?.signal?.aborted === true) {
      return { phase: "failed" as const, finalText: "The run was cancelled before tool dispatch." };
    }
    const toolIdentity = current.pendingToolAttemptId === undefined ? {} : { attemptId: current.pendingToolAttemptId };
    const calls = current.pendingToolCalls.map((raw) => CallSchema.parse(raw));
    if (calls.length === 0) return {};
    // What the tools act in: this admission's folder, a resume's included.
    const toolInvocation = toolContextOf(current.invocation, config);
    const redact = (await options.redactToolResults?.(current.invocation)) ?? true;

    if (current.turnToolCalls + calls.length > maxToolCalls) {
      // A response may ask for more calls than the turn has left. That is a
      // **refusal the model must see**, not a dangling batch — and, by the same
      // rule the denial path below follows, an error *result* rather than a failed
      // task. A bare `failed` phase here left the assistant message's tool calls
      // with no results, so the provider rejected the next request outright ("Tool
      // results are missing for tool calls …") and the operator saw that provider
      // error instead of the guard's message; a live evaluation found it.
      //
      // Nothing dispatches (all-or-nothing, so a replay sees one generation) and
      // nothing is counted as dispatched: the budget bounds *work*, so the calls
      // that did not run stay available to the model, which can ask for at most
      // `remaining` in one response or answer with what it has. A model that never
      // answers is still bounded by `maxSteps`, which every model step consumes —
      // one refusal per generation at most, since another generation costs a step.
      // (A batch is itself capped at 64 calls by the wire schema, so the refusal
      // results a turn can add are bounded by `maxSteps` × 64; a conversation that
      // reaches its hard bound fails safely with `BUDGET_EXCEEDED` instead.)
      const remaining = Math.max(0, maxToolCalls - current.turnToolCalls);
      return {
        conversation: calls.map((call) => ({
          // Qualified by the checkpointed step, not just the call id. A provider
          // numbers tool-call ids per response (the scheme this file already
          // accounts for in `waitRowId`), so the same id can appear in two
          // generations of one turn; `mergeConversation` keys messages by id and
          // overwrites **in place**, so an unqualified id would replace the earlier
          // result and leave the newest assistant message with an unanswered call —
          // exactly the provider rejection this branch exists to prevent. Every
          // sole-call guard below gets the same treatment. The *dispatch* path's
          // `tool-${call.id}` messages are left alone deliberately: a task suspended
          // across an upgrade could then carry both shapes for one call, so that
          // rename needs its own migration story rather than riding along here.
          id: `tool-${current.steps}-${call.id}`,
          role: "tool" as const,
          text: "",
          toolCallId: call.id,
          toolName: call.name,
          output: {
            error: "TOOL_CALL_BUDGET_EXCEEDED",
            reason:
              `this response asked for ${calls.length} tool call(s) and the turn allows ${remaining} more, so none of ` +
              `them ran; ask for at most ${remaining} in one response, or answer with what you have`,
          },
          isError: true,
        })),
        pendingToolCalls: [],
        denials: {},
        phase: "running" as const,
      };
    }

    // `agents.wait` must be the sole pending call in its generation: mixing
    // it with another tool call would make the wait's `interrupt()` call
    // non-deterministic on replay unless every OTHER call dispatched first
    // in the same turn is already durably ledgered — true for mutating/
    // external tools, not for read-only ones. Refused by construction
    // here, before any call dispatches, rather than reasoning about
    // partial-turn replay safety.
    // This check lives in `toolsNode`, not
    // `modelNode`: the graph only routes back to `model` through `tools`
    // (`tools -> model`, there is no `model -> model` edge), so a
    // correction has to be produced as ordinary tool-result messages here,
    // the same way `denial`/`TASK_CANCELLED` already are below.
    const soleCallToolIds: readonly string[] = [AGENTS_WAIT_TOOL_ID, ASK_USER_TOOL_ID, BROWSER_REQUEST_HANDOFF_TOOL_ID];
    if (calls.length > 1 && calls.some((call) => soleCallToolIds.includes(call.name))) {
      return {
        conversation: calls.map((call) => ({
          id: `tool-${current.steps}-${call.id}`,
          role: "tool" as const,
          text: "",
          toolCallId: call.id,
          toolName: call.name,
          output: {
            error: "WAIT_MUST_BE_SOLE_CALL",
            reason: `${calls.find((entry) => soleCallToolIds.includes(entry.name))?.name ?? AGENTS_WAIT_TOOL_ID} cannot be combined with other tool calls in the same turn; call it alone`,
          },
          isError: true,
        })),
        pendingToolCalls: [],
        denials: {},
        // Nothing ran, so nothing is charged — the same rule the over-budget branch
        // above follows. Charging it made the refusal self-defeating: with
        // `maxToolCalls: 2`, a mixed `[ask_user, echo]` batch was refused with
        // "call it alone" and consumed the whole budget, so the model's lone retry
        // came back as `TOOL_CALL_BUDGET_EXCEEDED`. Termination is unaffected:
        // every refusal costs a model step, and `maxSteps` bounds the turn.
        phase: "running" as const,
      };
    }

    const toolsPolicy = await executionPolicyOf(current.runId);
    const outer = admission?.signal ?? config?.signal;
    const earlyStop = new AbortController();
    const round: ToolRound = {
      scope,
      config,
      current,
      admission,
      toolIdentity,
      calls,
      toolInvocation,
      redact,
      builtEnvelope: undefined,
      // The invocation context is supplied by the adapter's `invoke`, not read from
      // graph config: the graph must never invent authorization scope.
      messages: [],
      discoveredToolIds: current.discoveredToolIds,
      toolsPolicy,
      humanQuestionsAllowedHere: toolsPolicy.humanQuestionsAllowed,
      workerWaitsAllowedHere: toolsPolicy.workerWaitsAllowed,
      readOnlyTool: readOnlyToolOf(options.tools),
      prefetched: new Map(),
      earlyStop,
      earlySignal: outer === undefined ? earlyStop.signal : AbortSignal.any([outer, earlyStop.signal]),
      scannedUntil: 0,
      parallelReads: undefined,
    };
    const { messages, prefetched, readOnlyTool } = round;
    /**
     * A call refused before it ran (not disclosed, repeated, refused by policy, cancelled, not approved): its answer to
     * the model, and a failed call line for the person. Without the line the transcript and the trajectory never showed
     * it, and a reply that named the refusal read as made up. A call the person denied in its round is `shown` already,
     * by that round's card, and is no call line: nothing ran.
     */
    const refused = async (call: (typeof calls)[number], message: WorkflowMessage, shown = false): Promise<void> => {
      messages.push(message);
      if (shown) return;
      const observer = observers.get(threadIdOf(config));
      await observer?.onToolEvent?.({
        ...toolIdentity,
        phase: "started",
        callId: call.id,
        toolName: call.name,
        input: observedInput(round, call.input),
      });
      await observer?.onToolEvent?.({
        ...toolIdentity,
        phase: "failed",
        callId: call.id,
        toolName: call.name,
        message: JSON.stringify(message.output ?? "refused"),
        durationMs: 0,
      });
    };

    try {
      for (const [index, call] of calls.entries()) {
        // A run of reads starts once the call before it has settled; a lone last call has nothing to run beside.
        if (index >= round.scannedUntil && calls.length - index > 1) await startEarlyRun(round, index);
        const disclosureRefusal = await toolDisclosureRefusal(current, call.name, call.input);
        if (disclosureRefusal !== undefined) {
          await refused(call, {
            id: `tool-${current.steps}-${call.id}`,
            role: "tool",
            text: "",
            toolCallId: call.id,
            toolName: call.name,
            output: { error: "TOOL_NOT_DISCLOSED", reason: disclosureRefusal },
            isError: true,
          });
          continue;
        }
        // A loop the model was told of and went on with: the same call is not run a further time.
        const repeated = repeatEscalation(
          current.conversation.filter(
            (message) => message.role !== "assistant" || message.toolCalls?.some((made) => made.id === call.id) !== true,
          ),
          call.name,
          call.input,
          readOnlyTool,
        );
        if (repeated !== undefined) {
          // Gone on past a refusal too: the person is asked how to go on, as `operator.ask_user` asks, and their
          // answer comes back with the refusal. The call is not run either way. Where nobody may be asked — an
          // unattended run, one that may ask only with a default, no channel to ask on (`toolQuestionFor` is
          // `undefined`) — the refusal stands alone, as at `REPEAT_REFUSED_AT`.
          const ask = repeated.kind === "ask" ? toolQuestionFor(round, current, call) : undefined;
          let answer: AgentWaitOutcome | undefined;
          if (ask !== undefined) {
            try {
              answer = await ask({
                key: "repeated-call",
                question:
                  repeated.alternate === undefined
                    ? `I keep making the same ${call.name} call and getting the same answer. How should I go on?`
                    : `I keep going back and forth between ${call.name} and ${repeated.alternate} and getting the same answers. How should I go on?`,
                context: repeated.reason,
                deadlineMs: askUserTimeoutMs(await originOf(current.runId)),
              });
            } catch (error) {
              if (!(error instanceof WorkflowWaitSuspend)) throw error;
              // Durable before the interrupt, as `ask_user`'s: `waitFor` wrote the wait row before throwing, and on
              // a resume it finds the row settled and answers without throwing, so this does not return.
              interrupt(toWaitInterruptPayload(error));
              throw new TaviError("INTERNAL", `the repeated-call question resumed unexpectedly for wait ${error.waitId}`);
            }
          }
          await refused(call, {
            id: `tool-${current.steps}-${call.id}`,
            role: "tool",
            text: "",
            toolCallId: call.id,
            toolName: call.name,
            output: { error: REPEATED_CALL_ERROR, reason: repeated.reason, ...(answer === undefined ? {} : { person: answer }) },
            isError: true,
          });
          continue;
        }
        const denial = current.denials[call.id];
        if (denial !== undefined) {
          await refused(
            call,
            {
              id: `tool-${call.id}`,
              role: "tool" as const,
              text: "",
              toolCallId: call.id,
              toolName: call.name,
              output: { denied: true, reason: denial },
              isError: true,
            },
            // Denied in a round, its card says so, and by whom; refused by policy before any round, nothing does.
            (await options.approvals.getForCall(current.runId, call.id, current.steps))?.state === "denied",
          );
          continue;
        }

        // A superseded invocation must not dispatch: refuse before the effect.
        await assertLeaseCurrent(options, config);
        // Recheck durable authority immediately before the effect: a checkpoint
        // alone never authorizes one.
        const cancelled = await options.cancellations.get(current.runId);
        if (cancelled !== undefined) {
          await refused(call, {
            id: `tool-${call.id}`,
            role: "tool" as const,
            text: "",
            toolCallId: call.id,
            toolName: call.name,
            output: { error: "TASK_CANCELLED", reason: cancelled.reason },
            isError: true,
          });
          continue;
        }

        if (await runToolSearch(round, call)) continue;

        if (await runHandoffCall(round, call)) continue;

        if (call.name === AGENTS_WAIT_TOOL_ID || call.name === ASK_USER_TOOL_ID) {
          await runWaitCall(round, call);
          continue;
        }

        const definition = options.tools.get(call.name);
        // Refused by policy even when the approve node was skipped — a route
        // straight to `tools`, or an adapter that gates nothing.
        const verdict = verdictOf(current, call);
        // A call without a verdict still meets the hard-deny list, read from the
        // tool's own assessor: it sits below every bypass.
        const unassessedHardDeny =
          verdict === undefined && definition?.assess !== undefined ? hardDenyOf(definition, call.input, toolInvocation) : undefined;
        if (verdict?.decision === "deny" || unassessedHardDeny !== undefined) {
          await refused(call, {
            id: `tool-${call.id}`,
            role: "tool" as const,
            text: "",
            toolCallId: call.id,
            toolName: call.name,
            output: { denied: true, reason: verdict?.reason ?? unassessedHardDeny ?? "refused by policy" },
            isError: true,
          });
          continue;
        }
        if (definition !== undefined && callNeedsApproval(current, call)) {
          const approval = await options.approvals.getForCall(current.runId, call.id, current.steps);
          // The binding is rechecked, not just the state: a grant recorded for a
          // different tool or different inputs must not authorize this call.
          const normalized = validateToolInput(options.tools, call.name, call.input);
          const bound =
            approval !== undefined &&
            approval.state === "granted" &&
            approval.toolId === definition.id &&
            normalized.ok &&
            approval.inputsHash === canonicalizeAdmission(normalized.value ?? null);
          if (!bound) {
            await refused(call, {
              id: `tool-${call.id}`,
              role: "tool" as const,
              text: "",
              toolCallId: call.id,
              toolName: call.name,
              output: {
                error: "APPROVAL_NOT_GRANTED",
                state: approval?.state ?? "missing",
                reason:
                  approval === undefined
                    ? "no approval record for this call"
                    : approval.state !== "granted"
                      ? `approval is ${approval.state}`
                      : approval.toolId !== definition.id
                        ? "approval was granted for a different tool"
                        : "approval was granted for different inputs",
              },
              isError: true,
            });
            continue;
          }
        }
        const observer = observers.get(threadIdOf(config));
        // The tool and the time, so its app's Recent activity can list a read.
        await options.tasks.recordToolCall(current.runId, current.steps, call.id, definition?.id ?? call.name, now());
        await observer?.onToolEvent?.({
          ...toolIdentity,
          phase: "started",
          callId: call.id,
          toolName: call.name,
          input: observedInput(round, call.input),
        });
        // `performance.now()` is monotonic and sub-millisecond; `Date.now()` reports
        // an in-process tool as a flat 0ms, which reads as "not measured".
        let startedAt = performance.now();
        const ask = toolQuestionFor(round, current, call);
        let message: WorkflowMessage | undefined;
        // Run early with the calls beside it: its result, unless it stopped to ask.
        const early = prefetched.get(index);
        if (early !== undefined) {
          prefetched.delete(index);
          const settled = await early.settled;
          if (!early.asked()) {
            if ("error" in settled) throw settled.error;
            message = settled.message;
            startedAt = early.startedAt;
          }
        }
        // A call may ask several questions, one at a time. LangGraph matches resume values to a node's
        // interrupts by position, so each question already answered takes up its interrupt again (it returns at once)
        // before the next unanswered one suspends the task; the call runs again after each.
        for (let asked = 0; message === undefined; asked += 1) {
          try {
            message = await runDispatch(round, call, ask);
          } catch (error) {
            // The call asked its person a question: its wait row is active and the question delivered, so the task
            // suspends on it as on `operator.ask_user`'s. An interrupt that returns is an earlier question's, answered.
            if (!(error instanceof WorkflowWaitSuspend)) throw error;
            if (asked >= MAX_TOOL_QUESTIONS)
              throw new TaviError("CONFLICT", `${call.name} asked more than ${String(MAX_TOOL_QUESTIONS)} questions in one call`);
            interrupt(toWaitInterruptPayload(error));
          }
        }
        if (message === undefined) throw new TaviError("INTERNAL", `${call.name} ended with no result`);
        const annotatedOutput =
          message.isError === true
            ? message.output
            : annotateBrowserProgress([...current.conversation, ...messages], call.name, call.input, message.output);
        const finalMessage = annotatedOutput === message.output ? message : { ...message, output: annotatedOutput };
        const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
        messages.push({ ...finalMessage, id: `tool-${current.steps}-${call.id}`, durationMs });
        await observer?.onToolEvent?.(
          finalMessage.isError === true
            ? {
                ...toolIdentity,
                phase: "failed",
                callId: call.id,
                toolName: call.name,
                message: JSON.stringify(finalMessage.output ?? "tool failed"),
                durationMs,
              }
            : {
                ...toolIdentity,
                phase: "completed",
                callId: call.id,
                toolName: call.name,
                output: finalMessage.output ?? null,
                durationMs,
                ...(finalMessage.redacted === undefined ? {} : { redacted: finalMessage.redacted }),
              },
        );
      }
    } finally {
      // A call run early whose turn never came (the loop stopped short, or the task was cancelled meanwhile)
      // is stopped and waited for, so none outlives the node.
      if (prefetched.size > 0) {
        earlyStop.abort();
        await Promise.all([...prefetched.values()].map((entry) => entry.settled));
      }
    }

    // What became of each call a round decided, for that round's audit trail.
    // A replayed node reports again; the hook is idempotent.
    const decided = calls.filter((call) => current.approvals[call.id] !== undefined || current.denials[call.id] !== undefined);
    if (options.onRoundToolResults !== undefined && decided.length > 0) {
      const resultOf = (callId: string) =>
        [...messages].reverse().find((message) => message.role === "tool" && message.toolCallId === callId);
      try {
        await options.onRoundToolResults({
          taskId: current.runId,
          steps: current.steps,
          results: decided.map((call) => ({
            callId: call.id,
            toolName: call.name,
            status:
              current.denials[call.id] !== undefined
                ? ("denied" as const)
                : resultOf(call.id)?.isError === true
                  ? ("error" as const)
                  : ("ok" as const),
          })),
        });
      } catch (error) {
        options.onDiagnostic?.("an approval round's tool results could not be recorded", {
          taskId: current.runId,
          steps: current.steps,
          error: errorMessage(error),
        });
      }
    }

    // What another task said in this round's results (a wait, a status, a spawn's evidence) is its model's words:
    // the URLs it wrote while they were not known are model-written here too, and no echo makes them known.
    const roundResults = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);
    const carried = await workerModelUrls(
      roundResults.flatMap((message) => {
        const speaker = message.role === "tool" ? speakingTaskOf(message.toolName, message.output) : undefined;
        return speaker === undefined ? [] : [speaker];
      }),
      current.invocation.workspaceId,
    );
    // Their URLs are known from now on, and stay known once a fold summarizes them away.
    // A read of a page the model typed into may show what it typed: none of its URLs is made known.
    const typed = new Set(current.typedPages);
    const inputs = new Map(messages.flatMap((message) => (message.toolCalls ?? []).map((made) => [made.id, made.input] as const)));
    const resultUrls = resultUrlKeys(
      messages,
      current.knownUrls,
      new Set([...current.modelUrls, ...carried]),
      (message) =>
        outsideResult(message) && !readsTypedPage(message, typed, (callId) => (callId === undefined ? undefined : inputs.get(callId))),
    );
    // Their labels join the context's as they enter, and the flag with the label's integrity.
    const resultLabel = labelOf(messages);
    // A round that leaves the turn tainted is told, with the URLs the conversation now holds: the turn is saved
    // as tainted even when no model call follows, and the canvas disarms a novel link with what it knows.
    if (turnTainted(current) || isUntrusted(resultLabel)) {
      try {
        admission?.onUntrustedInput?.(mergeUrlKeys(current.knownUrls, resultUrls));
      } catch (error) {
        options.onDiagnostic?.("an admission's onUntrustedInput observer threw; the turn continues", {
          taskId: current.runId,
          reason: errorMessage(error),
        });
      }
    }
    return {
      conversation: messages,
      ...(resultUrls.length === 0 ? {} : { knownUrls: resultUrls }),
      ...(carried.length === 0 ? {} : { modelUrls: carried }),
      ...(isTrustedPublic(resultLabel) ? {} : { contextLabel: resultLabel }),
      discoveredToolIds: round.discoveredToolIds,
      pendingToolCalls: [],
      denials: {},
      // A round's approvals are spent once its calls ran: a provider reuses call
      // ids, and a later call must not inherit an earlier round's authorization.
      approvals: {},
      toolCallsDispatched: calls.length,
      turnToolCalls: current.turnToolCalls + calls.length,
      phase: "running" as const,
    };
  };
  return toolsNode;
}
