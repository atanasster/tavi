import type { RunnableConfig } from "@langchain/core/runnables";
import { ReducedValue, StateSchema, type ReducedValueInit } from "@langchain/langgraph";
import { z } from "zod";
import {
  KNOWN_URL_LIMITS,
  mergeUrlKeys,
  TYPED_PAGES_MAX,
  ContentLabelSchema,
  joinLabels,
  trustedLabel,
  type ContentLabel,
  AgentStateDataSchema,
  type ConversationFold,
  type ConversationUpdate,
  ConversationUpdateSchema,
  isModelSummaryDataMessage,
  isQuotedDataMessage,
  MAX_CONVERSATION_MESSAGES,
  RunPhaseSchema,
  TaviError,
  type WorkflowMessage,
  WorkflowMessageSchema,
} from "@tavi/contracts";

/**
 * Build an accumulating state channel from a Zod schema.
 *
 * Zod schemas are standard-schema compatible, but LangGraph's schema view is
 * invariant in its input and output types while Zod's `.default()` and check
 * wrappers are not, so the two constructor overloads cannot both be satisfied by
 * inference. The value schema is therefore taken as `unknown` and asserted to
 * the exact schema type the constructor names, inside this helper — runtime
 * validation is still performed by the Zod schema itself. Keeping the
 * assertion in a function means the rest of the adapter stays fully typed.
 */
function accumulate<T>(
  valueSchema: unknown,
  init: {
    readonly reducer: (current: T, next: T) => T;
    readonly default: () => T;
    readonly jsonSchemaExtra?: Record<string, unknown>;
  },
): ReducedValue<T, T> {
  return new ReducedValue<T, T>(valueSchema as ConstructorParameters<typeof ReducedValue<T, T>>[0], init);
}

/**
 * Same as {@link accumulate}, for a channel whose reducer accepts a
 * different shape than it stores — the conversation channel's fold
 * operation (stage 2 and the epoch rollover) needs to express "remove these ids" in a
 * way a plain `WorkflowMessage[]` cannot, so its input schema is a superset
 * union rather than the stored array type itself.
 */
function accumulateWithInput<Value, Input>(
  valueSchema: unknown,
  inputSchema: unknown,
  init: {
    readonly reducer: (current: Value, next: Input) => Value;
    readonly default: () => Value;
    readonly jsonSchemaExtra?: Record<string, unknown>;
  },
): ReducedValue<Value, Input> {
  // As in `accumulate`: each schema asserted to the type the constructor's schema-taking overload names.
  type InputSchema = Extract<ReducedValueInit<Value, Input>, { readonly inputSchema: unknown }>["inputSchema"];
  return new ReducedValue<Value, Input>(valueSchema as ReducedValue<Value, Input>["valueSchema"], {
    ...init,
    inputSchema: inputSchema as InputSchema,
  });
}

/** Reuse the contract's field schemas verbatim; never redeclare their types. */
export const GraphState = new StateSchema({
  stateVersion: AgentStateDataSchema.shape.stateVersion,
  runId: AgentStateDataSchema.shape.runId,
  phase: RunPhaseSchema,
  // The bound lives in the contract; the channel must not restate it. The
  // input schema is a superset of the stored type (plain array, or a fold)
  // so a compaction update can express removal — see `accumulateWithInput`.
  conversation: accumulateWithInput<WorkflowMessage[], ConversationUpdate>(
    AgentStateDataSchema.shape.conversation,
    ConversationUpdateSchema,
    {
      default: () => [],
      reducer: (current, next) => mergeConversation(current, next),
    },
  ),
  /**
   * Authenticated invocation identity, persisted in checkpointed state so a
   * resumed node never has to re-derive scope from ambient configuration.
   */
  invocation: AgentStateDataSchema.shape.invocation,
  steps: accumulate<number>(z.number().int().nonnegative(), {
    default: () => 0,
    reducer: (current, next) => current + next,
  }),
  toolCallsDispatched: accumulate<number>(z.number().int().nonnegative(), {
    default: () => 0,
    reducer: (current, next) => current + next,
  }),
  /**
   * The same counts within the current turn — the one answering the latest
   * user message, `turnMessageId`. The loop guards bound these: `steps`
   * and `toolCallsDispatched` are the task's totals, and `steps` is the
   * approval round's identity, so neither may start over; a turn's budget
   * does. Written whole by the node that advances them (nodes of one thread
   * run one at a time), and started over when the model node finds a user
   * message newer than the turn's.
   */
  turnSteps: AgentStateDataSchema.shape.turnSteps,
  turnToolCalls: AgentStateDataSchema.shape.turnToolCalls,
  turnMessageId: AgentStateDataSchema.shape.turnMessageId,
  /** The steers this admission merged: reset by a new admission, kept by a resume. */
  turnSteers: AgentStateDataSchema.shape.turnSteers,
  pendingToolCalls: AgentStateDataSchema.shape.pendingToolCalls,
  pendingToolAttemptId: AgentStateDataSchema.shape.pendingToolAttemptId,
  toolDisclosureRequired: AgentStateDataSchema.shape.toolDisclosureRequired,
  discoveredToolIds: AgentStateDataSchema.shape.discoveredToolIds,
  routedToolIds: AgentStateDataSchema.shape.routedToolIds,
  promptCacheModel: AgentStateDataSchema.shape.promptCacheModel,
  /**
   * Approval denials for the current pending calls, keyed by call id. A denial is
   * data the model must see, not a task failure.
   */
  denials: AgentStateDataSchema.shape.denials,
  /** Approval references for the calls that were gated and granted. */
  approvals: AgentStateDataSchema.shape.approvals,
  /** Policy verdicts for the pending calls, decided when they were emitted. */
  gateVerdicts: AgentStateDataSchema.shape.gateVerdicts,
  /**
   * The context label: monotone, since its
   * reducer is the label join — a fold, a rollover or *Fresh context* never
   * lowers it, so a fold cannot launder untrusted content.
   */
  contextLabel: accumulate<ContentLabel>(ContentLabelSchema, {
    default: () => trustedLabel("public"),
    reducer: (current, next) => joinLabels(current, next),
  }),
  /**
   * The known-URL rule's memory: the URLs of the
   * person's messages and of tool results as they arrived, and the ones a
   * person approved, so a fold does not make a summarized page's links novel.
   * Normal forms, and navigation keys with their fragment. Bounded and newest
   * kept (`mergeUrlKeys`); an evicted URL is asked about again.
   */
  knownUrls: accumulateWithInput<string[], readonly string[]>(
    AgentStateDataSchema.shape.knownUrls,
    z.array(z.string()).max(KNOWN_URL_LIMITS.maxUrls * 4),
    {
      default: () => [],
      reducer: (current, next) => [...mergeUrlKeys(current, next)],
    },
  ),
  /**
   * The URLs the model wrote while they were not known (its answers, its
   * calls' inputs): a tool result that echoes one never makes it known.
   */
  modelUrls: accumulateWithInput<string[], readonly string[]>(
    AgentStateDataSchema.shape.modelUrls,
    z.array(z.string()).max(KNOWN_URL_LIMITS.maxUrls * 4),
    {
      default: () => [],
      reducer: (current, next) => [...mergeUrlKeys(current, next)],
    },
  ),
  /** The browser pages the model typed into: a later read of one never makes a URL known. */
  typedPages: accumulateWithInput<string[], readonly string[]>(
    AgentStateDataSchema.shape.typedPages,
    z.array(z.string()).max(TYPED_PAGES_MAX * 4),
    {
      default: () => [],
      reducer: (current, next) => {
        const merged = [...current.filter((entry) => !next.includes(entry)), ...new Set(next)];
        return merged.length > TYPED_PAGES_MAX ? merged.slice(merged.length - TYPED_PAGES_MAX) : merged;
      },
    },
  ),
  finalText: AgentStateDataSchema.shape.finalText,
});

export type WorkflowState = typeof GraphState.State;

export type WorkflowUpdate = typeof GraphState.Update;

/** Node signature derived from the composed graph state, never redeclared by hand. */
export type WorkflowNode = (state: WorkflowState, config: RunnableConfig) => WorkflowUpdate | Promise<WorkflowUpdate>;

/** Re-validate a merged conversation against its bounded-array schema, typed errors only. */
function boundConversation(merged: readonly WorkflowMessage[]): WorkflowMessage[] {
  const parsed = z.array(WorkflowMessageSchema).max(MAX_CONVERSATION_MESSAGES).safeParse(merged);
  if (!parsed.success) {
    // An epoch rollover folds the conversation well before this bound,
    // at every model step and at each admission, so reaching it means a
    // rollover could not run: a state no turn's guards should produce.
    throw new TaviError(
      "BUDGET_EXCEEDED",
      `Workflow conversation exceeded its bounded size (${MAX_CONVERSATION_MESSAGES} messages) and could not be rolled over`,
      {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      },
    );
  }
  // Every caller merges by id before reaching here, so this should be
  // unreachable in practice — a defense-in-depth check that turns a silent
  // duplicate-id corruption into an immediate, typed failure instead.
  const seen = new Set<string>();
  for (const message of parsed.data) {
    if (seen.has(message.id)) {
      throw new TaviError("INTERNAL", `Conversation update produced a duplicate message id: ${message.id}`);
    }
    seen.add(message.id);
  }
  return parsed.data;
}

/**
 * Bounded append-merge for the conversation channel, plus the one operation
 * that shrinks it: a fold (stage 2's model summary or the epoch rollover).
 *
 * The ordinary path (`next` is a plain array — every node but a compacting
 * model-node call) merges messages by id, unchanged from before folding
 * existed: a replay that re-supplies the same input cannot duplicate it.
 * The fold path (`next` is a `ConversationFold`) removes `removeIds` from
 * `current`, appends the synthetic `summary`, then appends any new messages
 * produced the same turn (`append`) — one update expresses both "fold away"
 * and "add the model's response" atomically, since a channel can only be
 * written once per node per step.
 */
export function mergeConversation(current: readonly WorkflowMessage[], next: ConversationUpdate): WorkflowMessage[] {
  if (Array.isArray(next)) {
    const byId = new Map<string, WorkflowMessage>();
    for (const message of current) byId.set(message.id, message);
    for (const message of next) byId.set(message.id, message);
    return boundConversation([...byId.values()]);
  }
  const fold: ConversationFold = next;
  const removeIds = new Set(fold.removeIds);
  // Merge by id here too, exactly as the array branch does: a replayed or
  // retried application of the same fold must be a no-op, not a second
  // `summary`/`append` appended under the same ids.
  const byId = new Map<string, WorkflowMessage>();
  // An epoch summary written as data (a user-role one), or the stub that
  // opens a tail beginning with an assistant message, opens the conversation,
  // where the span it folds stood: at the end it would pass for the newest message. A system summary's place does not matter — the model
  // adapter lifts it into the instructions — so it joins after.
  for (const message of [fold.summary, ...fold.append])
    if (isQuotedDataMessage(message) && message.id.startsWith("epoch-")) byId.set(message.id, message);
  // A stage-2 summary written as data (`foldsum-…`) stands where the span it
  // folds stood — at the first message the fold removes — for the same reason.
  const modelSummaries = [fold.summary, ...fold.append].filter(isModelSummaryDataMessage);
  let placed = modelSummaries.length === 0;
  for (const message of current) {
    if (!removeIds.has(message.id)) byId.set(message.id, message);
    else if (!placed) {
      for (const summary of modelSummaries) byId.set(summary.id, summary);
      placed = true;
    }
  }
  byId.set(fold.summary.id, fold.summary);
  for (const message of fold.append) byId.set(message.id, message);
  return boundConversation([...byId.values()]);
}
