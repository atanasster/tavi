import type { RunnableConfig } from "@langchain/core/runnables";
import {
  MAX_MODEL_TOOLS,
  type FailoverCode,
  type ModelError,
  type ModelTarget,
  type ToolDefinition,
  type ToolOfferContext,
  ruleAppliesToTurn,
  toolPatternMatches,
  BROWSER_REQUEST_HANDOFF_TOOL_ID,
  type InvocationContext,
  type PromptLayout,
  STEERS_PER_TURN,
  type ChatSteer,
  type ModelPort,
  policyAllowsTool,
  readerSessionAllows,
  TaviError,
  type WorkflowInvokeOptions,
  type parseAgentState,
  SESSIONS_SEARCH_TOOL_ID,
  isAttendedOrigin,
  answersNoChannelConversation,
  type EffectiveMemorySettings,
  type TaskExecutionPolicy,
  type ToolRule,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import {
  TOOL_SEARCH_ID,
  deferAttendedFamilies,
  deferredFamilyLines,
  toolRevision,
  toolSearchDefinition,
  toolSearchDefinitionFor,
} from "../../tools/tool-routing.js";
import { validateToolInput } from "../dispatch.js";
import { threadIdOf, executionLeaseOf, assertLeaseCurrent } from "../run-config.js";
import { AGENTS_WAIT_TOOL_ID, ASK_USER_TOOL_ID, handoffAllowed } from "../waits.js";
import type { ChatMemoryState } from "../options.js";
import type { TaskRow } from "./core.js";
import type { HookScope } from "./hooks.js";

/** The longest input schema an undisclosed call's refusal carries whole. */
const DISCLOSURE_SCHEMA_MAX_CHARS = 2_000;

/** A turn's models and tools: its baseline chain and failover, the tools it is offered and the steers it takes. */
export function createOfferScope(scope: HookScope) {
  const { channelOf, chatMemoryOf, executionPolicyOf, memorySettingsOf, memoryToolWithheld, now, options, originOf, rulesFor } = scope;
  const saver = options.checkpointSaver;
  /**
   * Per-admission observers, keyed by thread id.
   *
   * A single mutable field would let two concurrent admissions on the same
   * adapter deliver their events to each other's caller.
   */
  const observers = new Map<string, WorkflowInvokeOptions>();
  /**
   * The folder each running admission's tools act in, by thread:
   * the one this admission resolved, a resume's too. A resumed
   * turn keeps the folder its facts state, so the prompt stays byte-identical
   *, but its tools never act on a folder revoked since — a root the
   * owner restarted without, a `/folder reset` — and a folder changed
   * meanwhile is the one they use.
   */
  const admittedFolders = new Map<string, Pick<InvocationContext, "folder" | "folderUnavailable">>();
  /** `invocation` as a tool reads it: with this admission's folder when it resolved one. */
  const toolContextOf = (invocation: InvocationContext, config: RunnableConfig | undefined): InvocationContext => {
    const admitted = admittedFolders.get(threadIdOf(config));
    if (admitted === undefined) return invocation;
    const { folder: _folder, folderUnavailable: _folderUnavailable, ...rest } = invocation;
    return { ...rest, ...admitted };
  };
  /**
   * Stage 2's circuit breaker: consecutive failures per thread, reset at
   * the start of every admission (`invoke`, alongside `observers.set`) —
   * "per admission," not per run, so a thread that starts failing does not
   * stay degraded across a later, separate admission.
   */
  const compactionFailures = new Map<string, number>();
  /**
   * When each target may be called again, after a `Retry-After` it answered:
   * per adapter, so every task of this process honours it. A call
   * starts on the first target of its chain not waiting, and fails over to
   * none that is.
   */
  const coolingUntil = new Map<string, number>();
  const targetKey = (target: ModelTarget): string => `${target.connectionId}\u0000${target.model}`;
  const baselineChain: readonly ModelTarget[] = [{ connectionId: options.connectionId, model: options.model }, ...(options.fallback ?? [])];
  /**
   * Per admission, by thread id: `chain`, the default a turn with no
   * saved route runs — resolved as configured now at its first use — and
   * `held`, the chain the turn's first model step ran, which every later step
   * of the turn runs too. A default changed, or a chat's model chosen, while a
   * turn runs reaches the next turn rather than switching provider inside one.
   * Opened at the start of `invoke`, removed at its end.
   */
  const turnBaselines = new Map<
    string,
    { chain?: Promise<readonly ModelTarget[]>; held?: readonly ModelTarget[]; memoryUnavailableLogged?: boolean }
  >();
  const turnBaseline = (threadId: string, invocation: InvocationContext): Promise<readonly ModelTarget[]> => {
    const scope = { workspaceId: invocation.workspaceId, principalId: invocation.principalId };
    const resolve = async (): Promise<readonly ModelTarget[]> => {
      // A worker runs its chat's own model, when the chat has one: delegating never moves work to another model.
      const chatTaskId = invocation.chatTaskId;
      const chat =
        chatTaskId === undefined || chatTaskId === invocation.runId
          ? undefined
          : await (async () => {
              try {
                return await options.taskRouting?.effectiveTarget?.(scope, chatTaskId);
              } catch (error) {
                // A chat the router keeps no route for in this scope — not a task of this principal's — has no model of its
                // own to pass on; one whose chosen model is gone refuses the worker as it refuses the chat.
                if (error instanceof TaviError && error.code === "NOT_AUTHORIZED") return undefined;
                throw error;
              }
            })();
      if (chat !== undefined) return [chat];
      return (await options.taskRouting?.baseline?.(scope)) ?? baselineChain;
    };
    const turn = turnBaselines.get(threadId);
    if (turn === undefined) return resolve();
    turn.chain ??= resolve();
    return turn.chain;
  };
  /** What fails over: a rate limit or a provider fault. A quota, auth, a bad request or an abort does not. */
  const FAILOVER_CODES: ReadonlySet<ModelError["code"]> = new Set<FailoverCode>([
    "rate_limit",
    "provider",
    ...(options.routineAvailabilityFailover === true ? (["model_retired", "model_unavailable"] as const) : []),
  ]);
  const isFailoverCode = (code: ModelError["code"]): code is FailoverCode => FAILOVER_CODES.has(code);
  /** The workflow's clock in milliseconds; the real one when an injected clock gives no instant. */
  const nowMs = (): number => {
    const at = Date.parse(now());
    return Number.isNaN(at) ? Date.now() : at;
  };
  /** Who a turn's tools are offered to: the person, and whether they are the workspace's operator (MCP's people rule). */
  const offerContextOf = (invocation: InvocationContext): ToolOfferContext => ({
    workspaceId: invocation.workspaceId,
    principalId: invocation.principalId,
    operator: options.access.resolveWorkspace(invocation.workspaceId)?.principalId === invocation.principalId,
    ...(invocation.memoryReach === undefined ? {} : { memoryReach: invocation.memoryReach }),
    ...(invocation.messagingReplyTo === undefined
      ? {}
      : {
          messagingConnectionId: invocation.messagingReplyTo.connectionId,
          messagingConversationKind: invocation.messagingReplyTo.audience === "one-to-one" ? ("one-to-one" as const) : ("group" as const),
        }),
    ...(answersNoChannelConversation(invocation.messagingReplyTo) ? { outsideConversation: true as const } : {}),
  });
  /**
   * What one model step reads of its task, each read once, on first use (`StepFacts`): the step's own
   * listings, its `authorizedTools` and its facts all see the same row, policy, rules and offered list,
   * rather than each re-reading them. A re-check that guards a race (a fingerprint compared before
   * dispatch) takes a fresh one.
   */
  const stepFactsOf = (invocation: InvocationContext, taskId: string): StepFacts => {
    const once = <T>(read: () => Promise<T>): (() => Promise<T>) => {
      let held: Promise<T> | undefined;
      return () => {
        held ??= read();
        return held;
      };
    };
    const task = once(async () => await options.tasks.get(taskId));
    return {
      task,
      policy: once(() => executionPolicyOf(taskId, task())),
      origin: once(() => originOf(taskId, task())),
      channel: once(() => channelOf(invocation)),
      rules: once(() => rulesFor(invocation.workspaceId, invocation)),
      narrowed: once(async () => await options.toolsForTask?.(taskId)),
      memorySettings: once(() => memorySettingsOf(invocation.workspaceId)),
      // The chat's memory mode starts from the step's own row: its parents are read afresh.
      chatMemory: once(async () => chatMemoryOf(taskId, invocation.chatMemoryMode, await task().catch(() => undefined))),
      layout: once(async () => await options.promptLayout?.(invocation.workspaceId)),
      toolDeferral: once(async () => await options.toolDeferral?.(invocation.workspaceId, taskId)),
      offered: once(() => options.tools.listOffered(offerContextOf(invocation))),
    };
  };
  /**
   * A tool-wide deny rule hides the tool from the model and from
   * `tools.search`. The rules are read once per listing, not once per
   * tool: they are a query.
   */
  const hiddenByRule = async (
    invocation: InvocationContext,
    taskId: string,
    facts: StepFacts = stepFactsOf(invocation, taskId),
  ): Promise<(toolId: string) => boolean> => {
    // A profile's deny for this task's origin — or this turn's channel — hides the tool too.
    // A task narrowed to some tools (an agent definition's) is offered only those.
    // A policy's allowlist (a heartbeat tick's) narrows further, `tools.search` included.
    // Paused memory offers no memory tool and no past-chat search; capture off, no `memory.propose`.
    // A chat with memory off, or a private one, none of them either.
    const [origin, channel, rules, narrowed, policy, memorySettings, chatMemory] = await Promise.all([
      facts.origin(),
      facts.channel(),
      facts.rules(),
      facts.narrowed(),
      facts.policy(),
      facts.memorySettings(),
      facts.chatMemory(),
    ]);
    const denied = rules.filter(
      (rule) => rule.decision === "deny" && rule.argMatcher === undefined && ruleAppliesToTurn(rule, origin, channel, invocation.frontEnd),
    );
    // A delegated worker reads only the memory it was given, so not the person's other chats.
    const worker = invocation.memoryScopeRestricted === true;
    return (toolId) =>
      denied.some((rule) => toolPatternMatches(rule.toolPattern, toolId)) ||
      (narrowed !== undefined && toolId !== TOOL_SEARCH_ID && !narrowed(toolId)) ||
      !policyAllowsTool(policy, toolId) ||
      // A reader session is offered only what reads and reaches nothing outside, and its delivery tool when it has a
      // destination.
      !readerSessionAllows(
        policy,
        toolId === TOOL_SEARCH_ID
          ? { id: toolId, effect: "read-only", sink: "none" }
          : { id: toolId, effect: options.tools.get(toolId)?.effect ?? "external", sink: options.tools.get(toolId)?.sink },
        { hasDelivery: invocation.scheduleDelivery !== undefined },
      ) ||
      (worker && toolId === SESSIONS_SEARCH_TOOL_ID) ||
      memoryToolWithheld(memorySettings, toolId, chatMemory, origin) !== undefined;
  };
  /**
   * Whether a task's built-in families wait behind `tools.search` (`ATTENDED_DEFERRED_FAMILIES`): an attended
   * chat's under `models.promptLayout` `v2`, never an unattended task's or a worker's.
   */
  const defersBuiltins = async (
    invocation: InvocationContext,
    taskId: string,
    facts: StepFacts = stepFactsOf(invocation, taskId),
  ): Promise<boolean> =>
    isAttendedOrigin(await facts.origin()) &&
    (await facts.policy()).mode === "attended" &&
    (await facts.layout()) === "v2" &&
    // `models.toolDeferral`: a local model keeps the whole list under `auto`, which it may search badly — unless
    // the list it would keep is past what one request may carry, where only MCP tools can give way: then it defers.
    ((await facts.toolDeferral()) !== false || builtinsPastModelLimit());
  /** `builtinsPastModelLimit`'s answer for the registry listing it was last computed from. */
  let pastLimitOf: { readonly listed: readonly ToolDefinition[]; readonly past: boolean } | undefined;
  /**
   * Whether the tools that are not a server's, `tools.search` with them, are more than one request may list:
   * counted once per registry listing (the registry hands back the same array until a tool is added or removed).
   */
  const builtinsPastModelLimit = (): boolean => {
    const listed = options.tools.list();
    if (pastLimitOf?.listed !== listed) pastLimitOf = { listed, past: pastModelLimit(listed) };
    return pastLimitOf.past;
  };
  /**
   * A task's offered tools as it is offered them: its deferred built-in families marked when it defers them.
   * `facts`: the step's, so one step never sees two layouts.
   */
  const deferredFor = async (
    invocation: InvocationContext,
    taskId: string,
    tools: readonly ToolDefinition[],
    facts: StepFacts = stepFactsOf(invocation, taskId),
  ) =>
    // On any surface — a channel's turn, a worker's, an unattended run's — a list whose tools that are not a server's
    // are past one request's limit defers the families too: only MCP tools give way when a list is fitted.
    (await defersBuiltins(invocation, taskId, facts)) || pastModelLimit(tools) ? deferAttendedFamilies(tools) : tools;
  /** Whether `tools`' own tools that are not a server's, `tools.search` with them, are more than one request may list. */
  const pastModelLimit = (tools: readonly ToolDefinition[]): boolean =>
    tools.filter((tool) => !tool.id.startsWith("mcp.")).length + 1 > MAX_MODEL_TOOLS;
  /**
   * `tools.search` as this person's turn offers it: its description per workspace and principal, with a line
   * for each deferred built-in family `tools` holds, ahead of the servers'.
   */
  const toolSearchFor = async (invocation: InvocationContext, tools: readonly ToolDefinition[] = []): Promise<ToolDefinition> =>
    toolSearchDefinitionFor([
      ...deferredFamilyLines(tools.filter((tool) => tool.deferred === true)),
      ...((await options.toolSearchLines?.(offerContextOf(invocation))) ?? []),
    ]);
  /**
   * The tools `current`'s step may call. `facts`: the step's reads, when it already holds them; a re-check
   * that guards a race leaves them out, and reads afresh.
   */
  const authorizedTools = async (
    current: ReturnType<typeof parseAgentState>,
    facts: StepFacts = stepFactsOf(current.invocation, current.runId),
  ): Promise<readonly ToolDefinition[]> => {
    const [policy, hidden, listed] = await Promise.all([
      facts.policy(),
      hiddenByRule(current.invocation, current.runId, facts),
      facts.offered(),
    ]);
    const offered = await deferredFor(current.invocation, current.runId, listed, facts);
    const usable = offered
      .filter((tool) => tool.id !== ASK_USER_TOOL_ID || policy.humanQuestionsAllowed)
      .filter((tool) => tool.id !== BROWSER_REQUEST_HANDOFF_TOOL_ID || (handoffAllowed(policy) && options.browserHandoff?.() !== undefined))
      .filter((tool) => tool.id !== AGENTS_WAIT_TOOL_ID || policy.workerWaitsAllowed)
      .filter((tool) => options.access.missingPermissions(current.invocation, tool.requiredPermissions).length === 0)
      .filter((tool) => !hidden(tool.id));
    const searchable =
      options.access.missingPermissions(current.invocation, toolSearchDefinition.requiredPermissions).length === 0 &&
      !hidden(TOOL_SEARCH_ID);
    return searchable
      ? [...usable.filter((tool) => tool.id !== TOOL_SEARCH_ID), await toolSearchFor(current.invocation, usable)]
      : usable.filter((tool) => tool.id !== TOOL_SEARCH_ID);
  };
  const toolDisclosureRefusal = async (
    current: ReturnType<typeof parseAgentState>,
    name: string,
    /** The call's input: a tool called by its exact name without being disclosed runs when it validates. */
    input?: unknown,
  ): Promise<string | undefined> => {
    // Not offered, so never dispatched: a call by a name the model was not given is refused here too.
    const narrowed = await options.toolsForTask?.(current.runId);
    if (narrowed !== undefined && name !== TOOL_SEARCH_ID && !narrowed(name)) return "This agent does not use this tool";
    if (!policyAllowsTool(await executionPolicyOf(current.runId), name)) return "This task cannot use this tool";
    // A memory tool withheld by the workspace's settings is refused too, not only left unoffered.
    const withheld = memoryToolWithheld(
      await memorySettingsOf(current.invocation.workspaceId),
      name,
      await chatMemoryOf(current.runId, current.invocation.chatMemoryMode),
      await originOf(current.runId),
    );
    if (withheld !== undefined) return withheld;
    if (!current.toolDisclosureRequired) return undefined;
    const offered =
      current.pendingToolAttemptId === undefined
        ? undefined
        : await options.routing?.repository.disclosure(
            { workspaceId: current.invocation.workspaceId, principalId: current.invocation.principalId },
            current.runId,
            current.pendingToolAttemptId,
          );
    const tool = (await authorizedTools(current)).find((entry) => entry.id === name);
    if (tool === undefined) return "Tool is unknown or no longer authorized";
    if (offered?.tools.some((entry) => entry.id === name && entry.revision === toolRevision(options.tools, tool)) === true)
      return undefined;
    // Called by its exact name though not disclosed: a discovery, as a search would be. It runs when its input fits the
    // whole schema; otherwise the refusal carries that schema, so one retry succeeds.
    const checked = input === undefined ? undefined : validateToolInput(options.tools, name, input);
    if (checked?.ok === true) return undefined;
    const wrong = checked === undefined ? "" : ` (${checked.detail.slice(0, 500)})`;
    const schema = JSON.stringify(options.tools.inputJsonSchemaOf(name) ?? {});
    // A schema too long to send whole is never cut mid-JSON: `tools.search` discloses it.
    return schema.length <= DISCLOSURE_SCHEMA_MAX_CHARS
      ? `${name} was not listed on this model attempt and its input does not fit its schema${wrong}; call it again with input matching: ${schema}`
      : `${name} was not listed on this model attempt and its input does not fit its schema${wrong}; call tools.search with query "select:${name}" for its schema, then call it again.`;
  };

  /**
   * The model port a run's calls go through: the lease, cancellation and
   * `models.invoke` are checked again at dispatch, and the binding resolved for
   * the call is the one it must still match. The model node's calls and an
   * admission's epoch flush alike.
   */
  const authorizeModels = (invocation: InvocationContext, config: RunnableConfig | undefined): ModelPort => ({
    async stream(request, streamOptions) {
      const binding = await options.models.resolveBinding?.(request, invocation);
      await assertLeaseCurrent(options, config);
      streamOptions.signal.throwIfAborted();
      if ((await options.cancellations.get(invocation.runId)) !== undefined)
        throw new TaviError("CANCELLED", "Task was cancelled before model dispatch");
      if (options.access.missingPermissions(invocation, ["models.invoke"]).length > 0)
        throw new TaviError("NOT_AUTHORIZED", "Model invocation permission was revoked before dispatch");
      return options.models.stream(request, {
        ...streamOptions,
        context: invocation,
        ...(binding === undefined ? {} : { expectedBindingHash: binding.bindingHash }),
      });
    },
  });
  /** Whether a target waits out a cooldown or is marked unavailable. */
  const targetWaiting = async (target: ModelTarget): Promise<boolean> =>
    (await options.isModelUnavailable?.(target)) === true || (coolingUntil.get(targetKey(target)) ?? 0) > nowMs();

  /**
   * The chat's open steers this model call takes: at most what is left
   * of the admission's `STEERS_PER_TURN`, none the turn already holds, each
   * claimed for the admission. A failure to read or claim them takes none —
   * they wait, and are the chat's next turn at worst; it never fails the call.
   */
  const takeSteers = async (
    current: ReturnType<typeof parseAgentState>,
    config: RunnableConfig | undefined,
  ): Promise<readonly ChatSteer[]> => {
    const lease = executionLeaseOf(config);
    const room = STEERS_PER_TURN - current.turnSteers.length;
    if (options.steers === undefined || lease === undefined || room <= 0) return [];
    try {
      const held = new Set([...current.turnSteers, ...current.conversation.map((message) => message.id)]);
      const open = (await options.steers.open(current.runId)).filter((steer) => !held.has(steer.steerId)).slice(0, room);
      if (open.length === 0) return [];
      const claimed = new Set(
        await options.steers.claim(
          current.runId,
          lease.admissionId,
          open.map((steer) => steer.steerId),
        ),
      );
      return open.filter((steer) => claimed.has(steer.steerId));
    } catch (error) {
      options.onDiagnostic?.("a chat's steers could not be read; the turn goes on without them", {
        taskId: current.runId,
        reason: errorMessage(error),
      });
      return [];
    }
  };
  return {
    ...scope,
    saver,
    observers,
    admittedFolders,
    toolContextOf,
    compactionFailures,
    coolingUntil,
    targetKey,
    turnBaselines,
    turnBaseline,
    isFailoverCode,
    nowMs,
    hiddenByRule,
    offerContextOf,
    stepFactsOf,
    defersBuiltins,
    deferredFor,
    toolSearchFor,
    authorizedTools,
    toolDisclosureRefusal,
    authorizeModels,
    targetWaiting,
    takeSteers,
  };
}

export type OfferScope = ReturnType<typeof createOfferScope>;

/**
 * What one model step reads of its task, each read once (`stepFactsOf`): the row, its execution policy and
 * origin, the turn's channel and rules, the agent's narrowing, the memory settings, the chat's memory, the
 * prompt layout, the tool deferral and the offered tool list.
 */
export interface StepFacts {
  readonly task: () => Promise<TaskRow>;
  readonly policy: () => Promise<TaskExecutionPolicy>;
  readonly origin: () => Promise<string | null | undefined>;
  readonly channel: () => Promise<string | undefined>;
  readonly rules: () => Promise<readonly ToolRule[]>;
  readonly narrowed: () => Promise<((toolId: string) => boolean) | undefined>;
  readonly memorySettings: () => Promise<EffectiveMemorySettings>;
  readonly chatMemory: () => Promise<ChatMemoryState>;
  readonly layout: () => Promise<PromptLayout | undefined>;
  readonly toolDeferral: () => Promise<boolean | undefined>;
  readonly offered: () => Promise<readonly ToolDefinition[]>;
}
