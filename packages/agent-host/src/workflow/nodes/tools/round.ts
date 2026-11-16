import { z } from "zod";
import {
  type ToolHandler,
  toolResultLabel,
  isTrustedPublic,
  type ContentLabel,
  type ToolResultLabel,
  type WorkflowMessage,
  type ModEnvelope,
  containsRedactionPlaceholder,
  type AgentStateData,
  type InvocationContext,
  type TaskExecutionPolicy,
} from "@tavi/contracts";
import { type CallSchema, dispatchTool, sensitiveCall } from "../../dispatch.js";
import type { readOnlyToolOf } from "../../repeats.js";
import { threadIdOf, executionLeaseOf } from "../../run-config.js";
import type { WorkflowScope } from "../../scope.js";
import { scrubToolOutput, hookInputOf, type DispatchHooks, resultThroughHooks, rewrittenLabel } from "../../tool-hooks.js";
import type { RunnableConfig } from "@langchain/core/runnables";

/** A tool call as the pending list checkpoints it. */
export type ToolCall = z.infer<typeof CallSchema>;

/**
 * One tools-node round: what its parts share, built once per node run after the guards. `builtEnvelope`,
 * `discoveredToolIds`, `scannedUntil` and `parallelReads` change as the round runs and are read only through it.
 */
export interface ToolRound {
  readonly scope: WorkflowScope;
  readonly config: RunnableConfig;
  readonly current: AgentStateData;
  readonly admission: ReturnType<WorkflowScope["observers"]["get"]>;
  readonly toolIdentity: { readonly attemptId?: string };
  readonly calls: readonly ToolCall[];
  /** What the tools act in: this admission's folder, a resume's included. */
  readonly toolInvocation: InvocationContext;
  readonly redact: boolean;
  // Built once, when a call first has a hook to hand it to; whether one does is asked at each call,
  // so a plugin reloaded while the round runs is asked about the calls after it.
  builtEnvelope: Promise<ModEnvelope> | undefined;
  /** The round's results, in call order. */
  readonly messages: WorkflowMessage[];
  discoveredToolIds: AgentStateData["discoveredToolIds"];
  // Read in `tools.ts` as well as in the model node: this node dispatches calls a
  // checkpoint or a provider can still hand it after the tool list was built,
  // so the policy must be consulted immediately before the effect.
  readonly toolsPolicy: TaskExecutionPolicy;
  readonly humanQuestionsAllowedHere: boolean;
  readonly workerWaitsAllowedHere: boolean;
  // Which calls only read, for loop detection: a read checking a write, and a fan-out of reads, are no repeat.
  readonly readOnlyTool: ReturnType<typeof readOnlyToolOf>;
  /**
   * Independent read-only calls run at the same time; their results are
   * still taken in call order in `tools.ts`'s loop, each with its own events. Each run of
   * such calls in a row goes early once the call before it has settled: a
   * read after a write in the same step reads what the write left, so it
   * starts only when the write is done. A call is run early only when nothing
   * stands before its effect: a tool whose effect, as the gate decided it,
   * is read-only, that needs no approval and is not refused. Of two calls
   * on one browser session only the first goes early (a page acts on one
   * thing at a time); the other waits its turn. At most
   * `tools.parallelReads` go together. Asking the person is positional
   * (LangGraph matches resumes to interrupts by order), so an early call
   * that asks is stopped there and runs again in order, asking then: being
   * read-only, running it twice costs only time.
   */
  readonly prefetched: Map<
    number,
    {
      readonly startedAt: number;
      readonly settled: Promise<{ readonly message: WorkflowMessage } | { readonly error: unknown }>;
      readonly asked: () => boolean;
    }
  >;
  // Ends the early calls when `tools.ts`'s loop stops short (a question, a lease lost), so none outlives the node.
  readonly earlyStop: AbortController;
  readonly earlySignal: AbortSignal;
  // The calls a scan has already looked at: a call it left to its turn starts no scan of its own, so
  // the calls after it in the same run, already running, are never started twice.
  scannedUntil: number;
  // `tools.parallelReads`, read once, and only for a step with reads to run together.
  parallelReads: number | undefined;
}

/** The earlier of a deadline and an optional cap, as ISO instants. */
export function earliestInstant(deadline: string, cap: string | undefined): string {
  return cap !== undefined && Date.parse(cap) < Date.parse(deadline) ? cap : deadline;
}

/** The copy of a call's input observers see: the tool itself runs with the real one. */
export function observedInput(round: ToolRound, input: unknown): unknown {
  const { redact } = round;
  return hookInputOf(input, redact);
}

async function hookEnvelopeNow(round: ToolRound): Promise<ModEnvelope | undefined> {
  const { current, toolInvocation } = round;
  const { hookEnvelopeOf, options } = round.scope;
  if (
    options.turnHooks === undefined ||
    (options.turnHooks.hasEvent?.("tool.call") === false && options.turnHooks.hasEvent?.("tool.result") === false)
  )
    return undefined;
  round.builtEnvelope ??= hookEnvelopeOf(current.runId, toolInvocation).then((envelope) => Object.freeze(envelope));
  return round.builtEnvelope;
}

/**
 * What plugins' call and result hooks may see of `call`: it is
 * sensitive when its tool says so, or when it carries a credential.
 */
async function dispatchHooksFor(
  round: ToolRound,
  call: { readonly id: string; readonly name: string; readonly input: unknown },
): Promise<DispatchHooks | undefined> {
  const { config, current, admission, toolInvocation, redact } = round;
  const { options, verdictOf } = round.scope;
  const port = options.turnHooks;
  const definition = options.tools.get(call.name);
  if (port === undefined || definition === undefined) return undefined;
  const hookEnvelope = await hookEnvelopeNow(round);
  if (hookEnvelope === undefined) return undefined;
  let aliases: readonly string[] | undefined;
  try {
    const normalized = z.safeParse(definition.inputSchema, call.input);
    aliases = normalized.success ? definition.assess?.(normalized.data, toolInvocation)?.ruleAliases : undefined;
  } catch {
    aliases = undefined;
  }
  return {
    port,
    envelope: hookEnvelope,
    sensitive: sensitiveCall(definition, verdictOf(current, call)?.subjects),
    signal: admission?.signal ?? config?.signal,
    maskInput: redact,
    ...(aliases === undefined ? {} : { aliases }),
  };
}

/**
 * A directly dispatched call's bookkeeping (`agents.wait`, `ask_user`, a
 * browser handoff): the call recorded and reported started, and the
 * function that pushes its result and reports it, so no exit can forget
 * the terminal event.
 */
export async function startDirectCall(
  round: ToolRound,
  call: { readonly id: string; readonly name: string; readonly input: unknown },
  scrub = false,
): Promise<(output: unknown, isError: boolean, stored?: ContentLabel, own?: ToolResultLabel) => Promise<void>> {
  const { config, current, toolIdentity, redact, messages } = round;
  const { now, observers, options } = round.scope;
  const observer = observers.get(threadIdOf(config));
  const startedAt = performance.now();
  await options.tasks.recordToolCall(current.runId, current.steps, call.id, call.name, now());
  await observer?.onToolEvent?.({
    ...toolIdentity,
    phase: "started",
    callId: call.id,
    toolName: call.name,
    input: observedInput(round, call.input),
  });
  return async (raw, raisedError, stored, own) => {
    const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
    // A handoff's page observation is the page's own text; an answer or a worker's result is a person's or a task's words.
    // The handoff's page is a tool's output like any other: masked, then shown to result hooks.
    const scrubbed = scrubToolOutput(raw, scrub && redact);
    const settled: Awaited<ReturnType<typeof resultThroughHooks>> =
      scrub && !raisedError ? await resultThroughHooks(await dispatchHooksFor(round, call), call, call.name, scrubbed, redact) : scrubbed;
    const { value: output, redacted } = settled;
    const isError = raisedError || settled.withheld === true;
    // Labelled as a dispatched result is: its tool's declaration, `secret` when it held a placeholder before masking,
    // joined with the label its content carries (`stored`: a worker's result), kept even when trusted, as `runHandler` keeps one.
    const definition = options.tools.get(call.name);
    const declared =
      definition === undefined
        ? undefined
        : toolResultLabel(
            definition,
            call,
            {
              untrusted: false,
              secret: containsRedactionPlaceholder(raw),
              // What the output says of itself (a handed-back page's site and title), and what it carries.
              ...(stored === undefined && own === undefined ? {} : { label: { ...own, ...(stored === undefined ? {} : { stored }) } }),
            },
            now(),
          );
    const label = declared === undefined ? undefined : rewrittenLabel(declared, settled);
    messages.push({
      id: `tool-${current.steps}-${call.id}`,
      role: "tool" as const,
      text: "",
      toolCallId: call.id,
      toolName: call.name,
      output,
      isError,
      durationMs,
      ...(redacted === undefined ? {} : { redacted }),
      ...(label === undefined || (isTrustedPublic(label) && (stored === undefined || definition?.builtIn !== true)) ? {} : { label }),
    });
    await observer?.onToolEvent?.(
      isError
        ? {
            ...toolIdentity,
            phase: "failed",
            callId: call.id,
            toolName: call.name,
            message: JSON.stringify(output ?? "tool failed"),
            durationMs,
          }
        : {
            ...toolIdentity,
            phase: "completed",
            callId: call.id,
            toolName: call.name,
            output: output ?? null,
            durationMs,
            ...(redacted === undefined ? {} : { redacted }),
          },
    );
  };
}

/** One call through `dispatchTool`, with the checkpointed verdict's bindings and this turn's context. */
export async function runDispatch(
  round: ToolRound,
  call: ToolCall,
  ask: NonNullable<Parameters<ToolHandler>[0]["ask"]> | undefined,
  signal: AbortSignal | undefined = round.admission?.signal ?? round.config?.signal,
): Promise<WorkflowMessage> {
  const { config, current, toolInvocation, redact, toolsPolicy } = round;
  const { now, operatorApproved, options, replyDisarm, roundApprover, turnLabel, turnTainted, verdictOf } = round.scope;
  return dispatchTool(
    options.tools,
    options.access,
    options.effects,
    call,
    // A worker spawned here starts knowing what this task knows.
    call.name === "agents.spawn" ? { ...toolInvocation, inheritedKnownUrls: current.knownUrls } : toolInvocation,
    {
      taskId: current.runId,
      // The lease carries the admission identity, so the ledger entry is tied
      // to the admission that authorized it.
      admissionId: executionLeaseOf(config)?.admissionId ?? "unknown",
      steps: current.steps,
      // The approval that authorized this call, when it required one. A call
      // that needed no approval binds no approval reference.
      ...(current.approvals[call.id] === undefined ? {} : { approvalId: current.approvals[call.id] }),
      ...((await operatorApproved(current, call)) ? { operatorApproved: true } : {}),
      ...(await (async (): Promise<{ approvedBy?: string; approvedContentHash?: string }> => {
        const approver = await roundApprover(current, call);
        const shown = verdictOf(current, call)?.contentHash;
        return approver === undefined ? {} : { approvedBy: approver, ...(shown === undefined ? {} : { approvedContentHash: shown }) };
      })()),
      // What the gate decided by, so a handler can refuse a target that moved since.
      ...(verdictOf(current, call)?.subjects === undefined ? {} : { assessedSubjects: verdictOf(current, call)?.subjects }),
      // The page's host the gate decided by: a page that moved since is refused there.
      ...((verdictOf(current, call)?.scopeHosts ?? verdictOf(current, call)?.decidedHosts) === undefined
        ? {}
        : { assessedHosts: verdictOf(current, call)?.scopeHosts ?? verdictOf(current, call)?.decidedHosts }),
      ...(verdictOf(current, call)?.bindingHash === undefined ? {} : { expectedBindingHash: verdictOf(current, call)?.bindingHash }),
      ...(verdictOf(current, call)?.ruleId === undefined ? {} : { ruleId: verdictOf(current, call)?.ruleId }),
      // The effect the gate decided by, checkpointed with its verdict: never recomputed at dispatch.
      ...(verdictOf(current, call)?.effect === undefined ? {} : { effect: verdictOf(current, call)?.effect }),
      tainted: verdictOf(current, call)?.risk.tainted ?? turnTainted(current),
      // What a handler joins into what it stores for later, an artifact.
      contextLabel: turnLabel(current),
      // A reply written in a tainted turn goes out with every URL the conversation does not know defanged;
      // so does a send the handler finds is a reply (a schedule's send to its own delivery target).
      ...(["reply", "message"].includes(options.tools.get(call.name)?.sink ?? "none") &&
      (verdictOf(current, call)?.risk.tainted ?? turnTainted(current))
        ? { disarmUrls: await replyDisarm(current) }
        : {}),
      redact,
      now,
      ...(await (async (): Promise<{ hooks?: DispatchHooks }> => {
        const hooks = await dispatchHooksFor(round, call);
        return hooks === undefined ? {} : { hooks };
      })()),
      executionPolicy: toolsPolicy,
      ...(ask === undefined ? {} : { ask }),
    },
    signal,
    options.artifacts,
  );
}
