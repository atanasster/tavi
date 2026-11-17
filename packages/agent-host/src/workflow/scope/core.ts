import type { RunnableConfig } from "@langchain/core/runnables";
import {
  isPlumbingOrigin,
  type ModelTarget,
  type ToolRule,
  flagAllowRules,
  type ConversationFold,
  type InvocationContext,
  MAX_TASK_STEPS,
  MAX_WORKFLOW_STEPS,
  MAX_WORKFLOW_TOOL_CALLS,
  type EffectiveMemorySettings,
  effectiveMemorySettings,
  type ChatMemoryMode,
  type ModelPort,
  type BoundTaskPromptSnapshot,
  type TaskExecutionPolicy,
  DEFAULT_TASK_POLICY,
  TaviError,
  type RegisteredTool,
  type WorkflowMessage,
  SESSIONS_SEARCH_TOOL_ID,
  type TaskRecord,
  type TaskRepositoryPort,
} from "@tavi/contracts";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";
import { runEpochMemoryFlush } from "../../memory/epoch-flush.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  HEARTBEAT_SYSTEM_PROMPT,
  HEARTBEAT_SYSTEM_PROMPT_VERSION,
  SHIPPED_SYSTEM_PROMPT_VERSION,
} from "../../prompts/system-prompt.js";
import {
  DEFAULT_COMPACTION_KEEP_RECENT_MESSAGES,
  DEFAULT_COMPACTION_CACHED_MAX_CONTEXT_TOKENS,
  DEFAULT_COMPACTION_MAX_CONTEXT_TOKENS,
  SUPERSEDED_OBSERVATION_STRIDE_CHARS,
} from "../compaction.js";
import { DEFAULT_EPOCH_ROLLOVER_MESSAGES, epochBegunBy, epochRolloverOf } from "../epoch.js";
import type { CompiledWorkflowGraph } from "../graph.js";
import { DEFAULT_COMPACTION_SUMMARY_PROMPT } from "../model-summary.js";
import { type ChatMemoryState, stricterChatMemoryMode } from "../options.js";
import { executionLeaseOf } from "../run-config.js";
import { PROMPT_MESSAGE_PREFIX, type LabelScope } from "./labels.js";

/** A task's durable row, as `tasks.get` answers it. */
export type TaskRow = Awaited<ReturnType<TaskRepositoryPort["get"]>>;

/** The model's way to suggest memory: withdrawn with `capture: "off"`. */
export const MEMORY_PROPOSE_TOOL_ID = "memory.propose";

/** The adapter's limits and what it reads about a task: its prompt, its policy and its memory, its epochs and rollovers, its origin, channel and rules. */
export function createCoreScope(scope: LabelScope, compiled: Pick<CompiledWorkflowGraph, "getState">) {
  const { options, withoutMessagingTurns, withoutUntrustedTurns } = scope;
  const maxSteps = options.maxSteps ?? MAX_WORKFLOW_STEPS;
  /** The most steps any task's own budget may take a turn to: a bound on the graph's recursion too. */
  const stepCeiling = options.maxStepsFor === undefined ? maxSteps : Math.max(maxSteps, MAX_TASK_STEPS);
  const maxStepsOf = async (taskId: string): Promise<number> => {
    const own = await options.maxStepsFor?.(taskId);
    return own === undefined ? maxSteps : Math.min(MAX_TASK_STEPS, Math.max(1, Math.floor(own)));
  };
  const leaseMs = options.leaseMs ?? 60_000;
  /**
   * In-process serialization per task.
   *
   * The database refuses a second owner, but two calls on one adapter would
   * otherwise race between the ownership check and the insert; chaining them
   * makes the refusal deterministic rather than dependent on timing.
   */
  const inFlight = new Map<string, Promise<unknown>>();

  /**
   * Refresh a lease from inside a node.
   *
   * Without this the lease is a fixed deadline and every long run looks expired,
   * which defeats the point of having one.
   */
  async function refreshLease(config: RunnableConfig | undefined): Promise<void> {
    const lease = executionLeaseOf(config);
    if (lease === undefined) return;
    await options.executions.heartbeat({
      taskId: lease.taskId,
      generation: lease.generation,
      ownerSession: options.ownerSession,
      leaseMs,
      now: options.now === undefined ? { execution: true } : { fixed: now() },
    });
  }
  const maxToolCalls = options.maxToolCalls ?? MAX_WORKFLOW_TOOL_CALLS;
  const promptPolicy = {
    ...(options.systemPrompt === undefined ? {} : { explicitPrompt: options.systemPrompt }),
    builtin: { text: DEFAULT_SYSTEM_PROMPT, version: SHIPPED_SYSTEM_PROMPT_VERSION },
  };
  /**
   * A heartbeat check's, under `models.promptLayout` `v2`: the compact shipped base in place of the chat's. A
   * workspace's own base, or the adapter's explicit one, still wins, as it does for every task. Chosen by the
   * admitting call's `origin`: a heartbeat tick is one admission of a task of its own, so no later admission
   * re-pins it (one that did, with no `origin`, keeps the shipped template it has: a chat on one never moves to another).
   */
  const heartbeatPromptPolicy = {
    ...promptPolicy,
    builtin: { text: HEARTBEAT_SYSTEM_PROMPT, version: HEARTBEAT_SYSTEM_PROMPT_VERSION },
  };

  /**
   * The base a task runs under, read from its durable snapshot.
   *
   * Called before every invocation (so a resumed tool call cannot run an effect
   * before a missing snapshot is noticed) and again at each model call, because
   * the store is the authority and a cached value could outlive it. A task with
   * **no** row is corruption: refusing the turn is the
   * documented behavior, and substituting the shipped default would run the task
   * under a base it never selected.
   *
   * With the turn's admission, the base that admission pinned: a chat's
   * prompt re-resolves the workspace's base at its admission, and a resume
   * keeps its turn's, so a round's resume never switches prompts mid-turn.
   */
  async function selectedPromptSnapshot(taskId: string, workspaceId: string, admissionId?: string): Promise<BoundTaskPromptSnapshot> {
    const snapshot = await options.tasks.getPromptSnapshot(taskId, admissionId);
    if (snapshot === undefined) {
      throw new TaviError(
        "INTERNAL",
        `Task ${taskId} has no selected system prompt; the task cannot run without the base it was admitted under`,
        { details: { taskId } },
      );
    }
    // The row must describe the task and workspace it is being read for; a
    // mismatch is corruption the store already refuses on write.
    if (snapshot.taskId !== taskId || snapshot.workspaceId !== workspaceId) {
      throw new TaviError("INTERNAL", `Task ${taskId} has a system prompt bound to another task or workspace`, {
        details: { taskId, workspaceId, snapshotTaskId: snapshot.taskId, snapshotWorkspaceId: snapshot.workspaceId },
      });
    }
    return snapshot;
  }

  /**
   * The trusted execution policy of a task, read from its durable row.
   *
   * Read per turn rather than carried in the checkpointed invocation: the
   * `invocation` channel has no reducer, so a non-resume turn replaces it
   * wholesale and any policy riding there would be dropped on exactly the
   * follow-ups this must survive. The row is the authority, and an
   * unknown task reads as the conservative default rather than as "allowed".
   * `row`: the task's row as the caller already read it (a model step's `StepFacts`).
   */
  async function executionPolicyOf(taskId: string, row?: Promise<TaskRow>): Promise<TaskExecutionPolicy> {
    return (await (row ?? options.tasks.get(taskId)))?.executionPolicy ?? DEFAULT_TASK_POLICY;
  }
  const compactionKeepRecentMessages = options.compactionKeepRecentMessages ?? DEFAULT_COMPACTION_KEEP_RECENT_MESSAGES;
  const epochRolloverMessages = options.epochRolloverMessages ?? DEFAULT_EPOCH_ROLLOVER_MESSAGES;
  const compactionMaxContextTokens = options.compactionMaxContextTokens ?? DEFAULT_COMPACTION_MAX_CONTEXT_TOKENS;
  const compactionCachedMaxContextTokens = options.compactionCachedMaxContextTokens ?? DEFAULT_COMPACTION_CACHED_MAX_CONTEXT_TOKENS;
  /** A rollover's news for whoever keeps what lasts an epoch; never fails the turn. */
  const epochRolledOver = async (taskId: string, fold: ConversationFold): Promise<void> => {
    const rollover = epochRolloverOf(fold);
    if (rollover === undefined) return;
    try {
      await options.onEpochRollover?.(taskId, rollover);
    } catch (error) {
      options.onDiagnostic?.("an epoch rollover's follow-up failed", { taskId, error: errorMessage(error) });
    }
  };
  /**
   * The workspace's memory settings for this call. A reading
   * that fails pauses memory for the call — nothing recalled or captured —
   * rather than failing the turn.
   */
  const memorySettingsOf = async (workspaceId: string): Promise<EffectiveMemorySettings> => {
    const defaults = effectiveMemorySettings(undefined, { contextTokens: options.maxContextTokens });
    if (options.memorySettings === undefined) return defaults;
    try {
      return await options.memorySettings(workspaceId);
    } catch (error) {
      options.onDiagnostic?.("the memory settings could not be read; memory is paused for this call", {
        workspaceId,
        error: errorMessage(error),
      });
      return { ...defaults, enabled: false, capture: "off" };
    }
  };
  /** Why a memory tool is not offered under `settings`, or `undefined` when it is (invariant 13). */
  const memoryToolWithheld = (
    settings: EffectiveMemorySettings,
    toolId: string,
    chat?: ChatMemoryState,
    origin?: string | null,
  ): string | undefined => {
    if (!settings.enabled && (toolId.startsWith("memory.") || toolId === SESSIONS_SEARCH_TOOL_ID))
      return "Memory is paused in this workspace";
    // A schedule's fire is a routine's: it reads, searches and proposes nothing.
    if (origin === "schedule" && (toolId.startsWith("memory.") || toolId === SESSIONS_SEARCH_TOOL_ID))
      return "A scheduled prompt has no memory";
    // A chat with memory off, or a private one, reads and proposes nothing.
    if (chat?.mode !== undefined && (toolId.startsWith("memory.") || toolId === SESSIONS_SEARCH_TOOL_ID))
      return chat.mode === "private" ? "This is a private chat: memory is off" : "Memory is off in this chat";
    if (settings.capture === "off" && toolId === MEMORY_PROPOSE_TOOL_ID) return "Learning from chats is off in this workspace";
    return undefined;
  };
  /**
   * The chat's memory mode for this call: the stricter of the
   * chat's as read now and the one the turn was admitted with (`stamped`, a
   * worker's first turn's from its spawning chat). A reading that fails is
   * off — nothing recalled or captured — rather than a failed turn. `known`
   * is the task's row as this step already read it.
   */
  const chatMemoryOf = async (taskId: string, stamped?: ChatMemoryMode, known?: TaskRecord): Promise<ChatMemoryState> => {
    if (options.chatMemory === undefined) return stamped === undefined ? {} : { mode: stamped };
    try {
      const read = (await options.chatMemory(taskId, known)) ?? {};
      const mode = stricterChatMemoryMode(read.mode, stamped);
      return mode === undefined ? read : { ...read, mode };
    } catch (error) {
      options.onDiagnostic?.("a chat's memory mode could not be read; its memory is off for this call", {
        taskId,
        error: errorMessage(error),
      });
      return { mode: "off" };
    }
  };
  /** The chats and epochs a flush already ran for, when no durable marks are given (`memoryMarks`): a retried rollover proposes nothing again. */
  const flushedEpochs = new Set<string>();
  /** Whether the flush of `epoch` in `taskId` is this call's to run: its durable mark claimed now, else the in-process set's. */
  const claimFlush = async (taskId: string, epoch: number): Promise<boolean> => {
    if (options.memoryMarks !== undefined) {
      try {
        return await options.memoryMarks.claim({ taskId, kind: "flush", mark: `e${epoch}`, at: now() });
      } catch (error) {
        // A claim that cannot be written flushes nothing: never twice is the rule (invariant 17).
        options.onDiagnostic?.("an epoch flush's mark could not be claimed; the epoch is not flushed", {
          taskId,
          epoch,
          error: errorMessage(error),
        });
        return false;
      }
    }
    const key = `${taskId}:${epoch}`;
    if (flushedEpochs.has(key)) return false;
    flushedEpochs.add(key);
    // Bounded: the oldest keys go first.
    if (flushedEpochs.size > 4_096) flushedEpochs.delete(flushedEpochs.values().next().value as string);
    return true;
  };
  /**
   * The messages of `folded` said from `since` on: each turn's
   * messages follow its prompt (`input-<admissionId>`), so a message belongs
   * to the turn whose prompt came last before it. A turn admitted before
   * `since`, one whose admission cannot be read, and anything before the
   * first prompt seen are left out — the narrower reading.
   */
  const saidSince = async (taskId: string, folded: readonly WorkflowMessage[], since: string): Promise<readonly WorkflowMessage[]> => {
    let admittedAt: ReadonlyMap<string, string>;
    try {
      admittedAt = new Map((await options.tasks.listAdmissions(taskId)).map((admission) => [admission.admissionId, admission.createdAt]));
    } catch {
      return [];
    }
    const kept: WorkflowMessage[] = [];
    let current = false;
    for (const message of folded) {
      if (message.role === "user" && message.id.startsWith(PROMPT_MESSAGE_PREFIX)) {
        const at = admittedAt.get(message.id.slice(PROMPT_MESSAGE_PREFIX.length));
        current = at !== undefined && at >= since;
      }
      if (current) kept.push(message);
    }
    return kept;
  };
  /** The target a turn's `role` call runs on: the role's where `roleTarget` allows it, else the turn's own. */
  const backgroundTarget = async (
    role: "compaction" | "extraction",
    invocation: InvocationContext,
    own: ModelTarget,
  ): Promise<ModelTarget> => {
    if (options.roleTarget === undefined) return own;
    try {
      return (await options.roleTarget(role, invocation, own)) ?? own;
    } catch (error) {
      options.onDiagnostic?.("a model role could not be read; the call stays on the turn's own model", {
        taskId: invocation.runId,
        role,
        error: errorMessage(error),
      });
      return own;
    }
  };
  /**
   * The pre-compaction flush, before a rollover folds `removeIds`:
   * once per chat and epoch, bounded, and never in the rollover's way — a
   * flush that fails or runs out of time is logged and the fold goes on.
   * `tainted` is the context label's integrity (`conversationTainted`).
   */
  const flushBeforeRollover = async (
    models: ModelPort,
    target: ModelTarget,
    invocation: InvocationContext,
    conversation: readonly WorkflowMessage[],
    removeIds: readonly string[],
    tainted: boolean,
    signal: AbortSignal | undefined,
    timeoutMs?: number,
  ): Promise<void> => {
    const flush = options.epochMemoryFlush;
    // A declined turn proposes nothing: it is never read by a model again.
    conversation = conversation.filter((message) => message.declined !== true);
    if (flush === undefined || flush === false || options.memory === undefined) return;
    // Paused memory, or capture off, flushes nothing.
    const memorySettings = await memorySettingsOf(invocation.workspaceId);
    if (!memorySettings.enabled || memorySettings.capture === "off") return;
    // Nor does a chat with memory off, or a private one.
    const chatMemory = await chatMemoryOf(invocation.runId, invocation.chatMemoryMode);
    if (chatMemory.mode !== undefined) return;
    // A worker is no chat: its folds propose nothing.
    if (invocation.chatTaskId !== undefined && invocation.chatTaskId !== invocation.runId) return;
    // A messaging conversation's words may be anyone's — a group's members, a
    // page or email the assistant quoted — never only the person's: no flush
    // reads them, so no third party's text can propose memory.
    // Held when the turn is held to the messaging channel, or the chat began there.
    // Nor is a heartbeat tick, a routine's fire, a reminder or a `run` an attended chat:
    // no automatic capture reads them (invariant 6), as the idle review passes them by.
    try {
      if (invocation.heldChannel === "messaging" || (await channelOf(invocation)) === "messaging") return;
      const origin = await originOf(invocation.runId);
      if (origin === "messaging" || isPlumbingOrigin(origin) || origin === "schedule" || origin === "reminder" || origin === "agent")
        return;
      const chatKind = (await options.tasks.get(invocation.runId))?.chatKind;
      if (chatKind === "run" || chatKind === "worker") return;
    } catch {
      // A channel, origin or kind that cannot be read is treated as messaging: nothing is flushed.
      return;
    }
    const removed = new Set(removeIds);
    const epochFolded = conversation.filter((message) => removed.has(message.id));
    const epoch = epochBegunBy(epochFolded);
    // Every turn from the first tainted one is left out, as the idle review leaves out a tainted saved turn.
    // So is a turn held to a messaging channel, as the idle review leaves out a saved turn that came that way (invariant 6).
    const attended = await withoutMessagingTurns(invocation.runId, withoutUntrustedTurns(epochFolded, conversation, tainted));
    if (attended === undefined) return;
    // Turned back on: only what was said from then is read, so nothing said while it was off is captured.
    const folded = chatMemory.onAt === undefined ? attended : await saidSince(invocation.runId, attended, chatMemory.onAt);
    // The workspace's provider drafts: none that captures, nothing to claim the epoch for.
    const provider = await flush.provider(invocation).catch(() => undefined);
    if (provider?.provider.capture === undefined) return;
    if (!(await claimFlush(invocation.runId, epoch))) return;
    try {
      // A date the flush gives ("until Friday") holds through that day in the workspace's zone.
      const timeZone =
        options.workspaceTimezone === undefined
          ? undefined
          : await options.workspaceTimezone(invocation.workspaceId).catch(() => undefined);
      // On the `extraction` role when bound, as the idle review is; else the turn's own target.
      const { proposed, recordIds, dropped } = await runEpochMemoryFlush({
        models,
        memory: options.memory,
        provider,
        target: await backgroundTarget("extraction", invocation, target),
        invocation,
        epoch,
        folded,
        signal,
        newId,
        now,
        // Sensitive topics are dropped unless the workspace asks for them as masked proposals.
        sensitive: memorySettings.sensitive,
        ...(timeZone === undefined ? {} : { timeZone }),
        ...(flush.maxProposals === undefined ? {} : { maxProposals: flush.maxProposals }),
        ...(timeoutMs === undefined && flush.timeoutMs === undefined
          ? {}
          : { timeoutMs: Math.min(timeoutMs ?? Number.POSITIVE_INFINITY, flush.timeoutMs ?? Number.POSITIVE_INFINITY) }),
      });
      // Counts only, never memory text: what was filed, and what the pipeline dropped.
      options.onDiagnostic?.("an epoch flush proposed memory", {
        taskId: invocation.runId,
        epoch,
        proposed,
        droppedSecret: dropped.secret,
        droppedSensitive: dropped.sensitive,
        droppedKnown: dropped.known,
        droppedSimilar: dropped.similar,
      });
      if (recordIds.length > 0) {
        try {
          await flush.onProposed?.(invocation.runId, epoch, recordIds);
        } catch (error) {
          options.onDiagnostic?.("an epoch flush's memory card could not be posted", {
            taskId: invocation.runId,
            epoch,
            error: errorMessage(error),
          });
        }
      }
    } catch (error) {
      options.onDiagnostic?.("an epoch flush failed; the rollover goes on", {
        taskId: invocation.runId,
        epoch,
        error: errorMessage(error),
      });
    }
  };
  /** Whether a person asked for this chat's next message to start a fresh epoch; a failed read is no. */
  const takeFreshContext = async (taskId: string): Promise<boolean> => {
    try {
      return (await options.takeFreshContext?.(taskId)) === true;
    } catch (error) {
      options.onDiagnostic?.("a fresh-context request could not be read", { taskId, error: errorMessage(error) });
      return false;
    }
  };
  /** The admissions a rewind took back from a chat; a failed read is none. */
  const rewindMarker = async (taskId: string): Promise<readonly string[] | undefined> => {
    try {
      return (await options.rewinds?.marker(taskId)) ?? undefined;
    } catch (error) {
      options.onDiagnostic?.("a chat's rewind could not be read", { taskId, error: errorMessage(error) });
      return undefined;
    }
  };
  const contextWindowFor = async (target: { readonly connectionId: string; readonly model: string }): Promise<number | undefined> => {
    try {
      return await options.contextWindowOf?.(target);
    } catch {
      return undefined;
    }
  };
  const supersededObservationStride = options.supersededObservationStrideChars ?? SUPERSEDED_OBSERVATION_STRIDE_CHARS;
  /** Explicit: it wins over the window-relative trigger. */
  const compactionModelTriggerTokens = options.compactionModelTriggerTokens;
  const compactionSummaryPrompt = options.compactionSummaryPrompt ?? DEFAULT_COMPACTION_SUMMARY_PROMPT;
  const approvalFor = new Set(options.approvalRequiredFor ?? ["mutating", "external"]);
  const approvalExempt = new Set(options.approvalExemptTools ?? []);
  /** Whether a call to this tool must wait for a round: its effect is gated and the operator has not exempted it. */
  const needsApproval = (definition: RegisteredTool | undefined): definition is RegisteredTool =>
    definition !== undefined && approvalFor.has(definition.effect) && !approvalExempt.has(definition.id);
  /**
   * The URLs other tasks of the workspace wrote while they were not known
   * (their `modelUrls`): what a worker or a peer says is its model's
   * words, so they are model-written for whoever reads it too. A task that
   * cannot be read carries nothing, and is reported.
   */
  const workerModelUrls = async (taskIds: readonly string[], workspaceId: string): Promise<readonly string[]> => {
    const keys: string[] = [];
    for (const taskId of new Set(taskIds)) {
      try {
        const task = await options.tasks.get(taskId);
        if (task === undefined || task.workspaceId !== workspaceId) continue;
        const state = await compiled.getState({ configurable: { thread_id: task.threadId } });
        keys.push(...((state.values as { readonly modelUrls?: readonly string[] } | undefined)?.modelUrls ?? []));
      } catch (error) {
        options.onDiagnostic?.("the URLs another task wrote could not be read; its answer's URLs are not carried", {
          taskId,
          error: errorMessage(error),
        });
      }
    }
    return keys;
  };
  /**
   * How a task was started, for origin-scoped rules and question deadlines:
   * a delegated worker answers to the origin its chain began with.
   * `row`: the task's row as the caller already read it, for when no `taskOrigin` is given.
   */
  const originOf = async (taskId: string, row?: Promise<TaskRow>): Promise<string | null | undefined> =>
    options.taskOrigin === undefined ? (await (row ?? options.tasks.get(taskId)))?.origin : options.taskOrigin(taskId);
  /**
   * The channel this turn is held to: the one its admission stamped
   * (`heldChannel` — the composition's reading of the caller's context, or a
   * spawning turn's, carried to its worker), else the composition's reading
   * of a context from before the stamp. Rules then apply as the narrower of the task's origin and this
   * channel (`ruleAppliesToTurn`), so a Home turn sent from a chat is held to
   * the messaging profile while a turn from the canvas can never lift what the
   * task's own origin is held to. A resume keeps its turn's context, so its
   * turn's channel.
   */
  const channelOf = async (invocation: InvocationContext): Promise<string | undefined> =>
    // A context its admission stamped (it carries `turnStartedAt`) says the whole answer.
    invocation.heldChannel ?? (invocation.turnStartedAt !== undefined ? undefined : await options.turnChannel?.(invocation));
  /** The connection a held turn came in on (`turnConnection`); none without it, since only the composition knows which connections are local. */
  const turnConnectionOf = async (invocation: InvocationContext): Promise<string | undefined> => await options.turnConnection?.(invocation);
  /**
   * Whether this chat's epoch summaries are written as data: it began
   * in a messaging conversation, so its messages may be anyone's and none may
   * reach the instructions. An origin that cannot be read counts as messaging.
   */
  const epochSummaryUntrusted = async (taskId: string): Promise<boolean> => {
    try {
      return (await originOf(taskId)) === "messaging";
    } catch {
      return true;
    }
  };
  /** `serve --allow` exemptions, as the flag rules they are. */
  const exemptionRules = flagAllowRules([...approvalExempt]);
  const rulesFor = async (workspaceId: string, invocation?: InvocationContext): Promise<readonly ToolRule[]> => [
    ...exemptionRules,
    ...((await options.toolPolicy?.rules(workspaceId, invocation)) ?? []),
  ];
  const newId = options.newId ?? ((prefix: string) => `${prefix}-${crypto.randomUUID()}`);
  const now = options.now ?? nowTimestamp;
  return {
    ...scope,
    maxSteps,
    stepCeiling,
    maxStepsOf,
    leaseMs,
    inFlight,
    refreshLease,
    maxToolCalls,
    promptPolicy,
    heartbeatPromptPolicy,
    selectedPromptSnapshot,
    executionPolicyOf,
    compactionKeepRecentMessages,
    epochRolloverMessages,
    compactionMaxContextTokens,
    compactionCachedMaxContextTokens,
    epochRolledOver,
    memorySettingsOf,
    memoryToolWithheld,
    chatMemoryOf,
    saidSince,
    backgroundTarget,
    flushBeforeRollover,
    takeFreshContext,
    rewindMarker,
    contextWindowFor,
    supersededObservationStride,
    compactionModelTriggerTokens,
    compactionSummaryPrompt,
    approvalFor,
    needsApproval,
    workerModelUrls,
    originOf,
    channelOf,
    turnConnectionOf,
    epochSummaryUntrusted,
    rulesFor,
    newId,
    now,
  };
}

export type CoreScope = ReturnType<typeof createCoreScope>;
