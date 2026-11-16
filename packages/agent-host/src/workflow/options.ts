import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { EpochFlushProvider } from "../memory/epoch-flush.js";
import type {
  ReachableChannel,
  ModelTarget,
  TaskRoutingPort,
  RouterPort,
  RouterRepositoryPort,
  ToolOfferContext,
  GateVerdict,
  SessionGrant,
  ToolRule,
  GateObservation,
  TaintMode,
  SourceKind,
  ApprovalScope,
  ApprovalProvenance,
  AccessPolicyPort,
  AgentCommunicationServicePort,
  AgentDefinitionRepositoryPort,
  ChatInstructionsRepositoryPort,
  TaskMemoryUseRepositoryPort,
  AgentMailboxRepositoryPort,
  ApprovalRepositoryPort,
  ArtifactRepositoryPort,
  BrowserHandoffPort,
  AskUserChoices,
  CancellationRepositoryPort,
  CheckpointReceiptRepositoryPort,
  EffectRepositoryPort,
  ExecutionRepositoryPort,
  InvocationContext,
  ChatFolder,
  FrontEnd,
  TurnChannel,
  ChatSteer,
  MemoryReach,
  MemoryServicePort,
  EffectiveMemorySettings,
  ChatMemoryMode,
  ModelPort,
  ModelCallSite,
  PromptLayout,
  SkillRepositoryPort,
  SkillRolloutRepositoryPort,
  SkillServicePort,
  TaskRecord,
  TaskRepositoryPort,
  TaskOrigin,
  ToolRegistryPort,
  TurnHooksPort,
} from "@tavi/contracts";
import type { WorkspacePromptSettingsPort } from "../prompts/system-prompt.js";
import type { EpochRollover } from "./epoch.js";

export interface WorkflowAdapterOptions {
  readonly taskRouting?: TaskRoutingPort;
  readonly routing?: { readonly service: RouterPort; readonly repository: RouterRepositoryPort };
  readonly explicitModelSelection?: boolean;
  readonly explicitModelTarget?: { readonly connectionId?: string; readonly model?: string };
  /** Recover a pending start from its already committed input checkpoint. */
  readonly recoverPendingStart?: boolean;
  /**
   * Pinned LangGraph saver. Injected by the composition root, which owns the
   * shared database handle, so this package never imports a runtime
   * implementation.
   */
  readonly checkpointSaver: BaseCheckpointSaver;
  readonly models: ModelPort;
  readonly tools: ToolRegistryPort;
  /**
   * Whether this workspace masks credential shapes in tool results
   * (`tools.redactResults`), read once per tools round. Absent: on.
   */
  readonly redactToolResults?: (context: InvocationContext) => Promise<boolean>;
  /**
   * Plugins' hooks into the turn. Late-bound: plugins
   * register after the adapter exists, and every dispatch reads it. Absent: none.
   */
  readonly turnHooks?: TurnHooksPort;
  /** The provider whose heartbeat check a turn is, named on its hooks' envelope so that plugin's own hooks pass it over. */
  readonly heartbeatProviderOf?: (taskId: string) => string | undefined;
  /** The provider whose idea a prepared step runs, named on its hooks' envelope so that plugin's own hooks pass it over. */
  readonly ideasProviderOf?: (taskId: string) => string | undefined;
  /**
   * Whether a turn is an open heartbeat turn, whose system prompt carries no
   * memory manifest. Only a shortcut: every turn of a `heartbeat`-origin task
   * is judged the same by its origin, and this answer only
   * saves that read.
   */
  readonly memoryWithheld?: (taskId: string) => boolean;
  /**
   * Whether an open heartbeat turn's prompt may carry the host's memory block:
   * its provider was handed memory this tick (never when withheld, and
   * none when nothing was found). Fixed when the turn is opened, before its
   * first call, so the runtime facts it keys stay turn-stable. Absent
   * or false: a heartbeat turn is told nothing about memory.
   */
  readonly heartbeatMemoryShown?: (taskId: string) => boolean;
  /**
   * Under `models.promptLayout` `v2`, which of the memory revision ids a chat's
   * kept context blocks showed (`WorkflowMessage.contextShown`'s `memory:` and
   * `profile:` ids, and the winning revision a stored `preference:` id names)
   * are no longer in force: forgotten, deleted or revoked. Asked
   * once per model call with every id the conversation's blocks list; the blocks
   * that showed one are dropped from the call and cleared in the checkpoint, so
   * a forgotten record never reaches the model again. Absent: nothing is checked.
   */
  readonly forgottenMemory?: (workspaceId: string, revisionIds: readonly string[]) => Promise<ReadonlySet<string>>;
  /**
   * How far a task's memory reaches: `"chat-only"` for a group
   * conversation's Home, its topics' side chats and their workers. Read at
   * every admission and stamped as `InvocationContext.memoryReach`; a reading
   * that fails is `"chat-only"`, the narrower answer. Absent: no task is narrowed.
   * `known` is the task's row as the caller read it moments ago (the admission's
   * own), which the reading may start from instead of reading it again.
   */
  readonly memoryReach?: (taskId: string, known?: TaskRecord) => MemoryReach | undefined | Promise<MemoryReach | undefined>;
  /**
   * The workspace's memory settings in effect,
   * read per model call so a change applies from the next one. Paused
   * (`enabled: false`): no manifest, no `memory.*` or `sessions.search` tool,
   * no flush. `capture: "off"`: no flush and no `memory.propose`. Its
   * `limits.contextTokens` is the call's system-text budget in place of
   * `maxContextTokens`, and `limits.evidence` bounds the retrieved records. A
   * reading that fails is paused, the narrower answer. Absent: the defaults,
   * with `maxContextTokens` as the budget.
   */
  readonly memorySettings?: (workspaceId: string) => EffectiveMemorySettings | Promise<EffectiveMemorySettings>;
  /**
   * The chat's memory mode, read per
   * model call: `mode` is `off` or `private` when the chat a task belongs to —
   * itself, or for a worker the chat it works for — has memory off; then the
   * call has no manifest, no `memory.*` or `sessions.search` tool, and no
   * flush. `onAt` is when memory was last turned back on: a flush reads only
   * the turns admitted from then. A reading that fails is off, the narrower
   * answer. Absent: every chat's memory is on. `known` is the task's row as
   * the caller read it in this admission or model step, which the reading
   * starts from instead of reading it again; its parents are read afresh.
   */
  readonly chatMemory?: (taskId: string, known?: TaskRecord) => ChatMemoryState | undefined | Promise<ChatMemoryState | undefined>;
  /**
   * Where a caller-supplied observer's failure is reported.
   *
   * An admission's lifecycle callbacks (`onClaimed`) are observers: one that
   * throws must not abandon an admission the adapter has already claimed, so its
   * failure is reported here rather than propagated.
   */
  readonly onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * Told after a chat's conversation rolled over into a new epoch, so
   * what lasts an epoch — a Home's grants — can end with it, and the
   * chat can show where it happened (`rollover` names the epoch begun
   * and the archive of what was folded). Best effort: a failure never fails
   * the turn.
   */
  readonly onEpochRollover?: (taskId: string, rollover: EpochRollover) => Promise<void> | void;
  /**
   * Called with the task's thread once a turn is committed, while the turn
   * still holds the task's execution lease, to delete all but its newest
   * checkpoints: a resume reads only the newest, and the receipt
   * just recorded names it. Best effort: a failure never fails the turn.
   */
  readonly pruneCheckpoints?: (threadId: string) => Promise<void>;
  /**
   * The pre-compaction flush: before a rollover folds a span, one
   * bounded private model call proposes what in it is worth remembering, as
   * proposed memory records and chat notes for a person to review. Needs
   * `memory`. Omitted (or `false`), no flush runs. Never fails the rollover.
   * `onProposed` is told what one flush proposed, for the chat's memory card;
   * a failure there is logged, never the rollover's.
   */
  /**
   * Internal switches for turn recall's quality steps, so the memory eval can
   * run each on and off: the relevance floor with its near-duplicate drop, the
   * "About the person" profile section, the recency and confirmation priors in
   * ranking, and date-aware ranking. Each is on unless `false`. Not a user
   * setting.
   */
  readonly memoryRecall?: MemoryRecallSwitches;
  readonly epochMemoryFlush?:
    | false
    | {
        /**
         * The memory provider that drafts from the chat's span (its `capture`): the workspace's, an external one
         * only with the `conversation` egress switch on and never for a chat on a local connection. None, or one
         * without `capture`, flushes nothing.
         */
        readonly provider: (invocation: InvocationContext) => Promise<EpochFlushProvider | undefined>;
        readonly maxProposals?: number;
        readonly timeoutMs?: number;
        readonly onProposed?: (taskId: string, epoch: number, recordIds: readonly string[]) => Promise<void>;
      };
  /**
   * Memory's durable marks (`tavi_memory_marks`): the flush claims
   * `e<N>` (kind `flush`) before it runs, so an epoch is flushed at most once
   * across restarts (invariant 17). A claim that fails flushes nothing.
   * Omitted (an engine with no store), a process-local set stands in.
   */
  readonly memoryMarks?: {
    readonly claim: (input: {
      readonly taskId: string;
      readonly kind: "flush";
      readonly mark: string;
      readonly at: string;
    }) => Promise<boolean>;
  };
  /**
   * Which of `admissionIds` (a chat's folded turns, by their prompts) were
   * held to a messaging channel, as their saved turns record it:
   * the flush leaves such a turn out whole, as the idle review does
   * (invariant 6) — an earlier Home turn from the operator's linked DM is no
   * attended turn because a later one is. A read that fails flushes nothing.
   * Omitted (an engine with no transcript), only the current turn's channel
   * and the chat's origin are checked.
   */
  readonly messagingTurns?: (taskId: string, admissionIds: readonly string[]) => Promise<ReadonlySet<string>>;
  /**
   * The model a turn's background call runs on: the stage-2
   * summary asks for `compaction`, the pre-compaction flush for `extraction`.
   * Answers the workspace's binding of that role where it may be used — an
   * explicit binding only, and never a remote one for a chat that used or
   * runs on a local connection — or `undefined` for the turn's own
   * target `own`. Omitted, or failing, both stay on the turn's own target.
   */
  readonly roleTarget?: (
    role: "compaction" | "extraction",
    invocation: InvocationContext,
    own: ModelTarget,
  ) => Promise<ModelTarget | undefined>;
  /**
   * Fresh context: asked as an admission joins a chat, true once when
   * a person asked for the chat's next message to start a new epoch whatever
   * its length — the rollover planner then folds everything before it.
   * Consulted only where an admission may roll over (not a resume, not a
   * suspended thread), and taken there: it answers true at most once a request.
   */
  readonly takeFreshContext?: (taskId: string) => Promise<boolean> | boolean;
  /**
   * Rewind: the admissions a person took back from a chat, held
   * until a turn applies them. An admission that joins a chat holding some —
   * not a resume, not a suspended thread — folds the conversation back to
   * before the earliest of their messages, in the write that adds its own;
   * once the thread's checkpoint holds none of them the hold is cleared. Omitted, no
   * chat is rewound.
   */
  readonly rewinds?: {
    readonly marker: (taskId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
    readonly clear: (taskId: string, admissionIds: readonly string[]) => Promise<void> | void;
  };
  /**
   * Steering: the messages a person sent into a chat's running turn.
   * Before each model call the turn takes the chat's open steers (at most
   * `STEERS_PER_TURN` an admission), claims them and appends them as user
   * messages, checkpointed with the call's own update; at the admission's end
   * the claims its checkpoint holds are settled consumed, and any other is
   * handed back pending — for the composition to send as the chat's next turn.
   * Omitted, no turn is steered.
   */
  readonly steers?: {
    readonly open: (taskId: string) => Promise<readonly ChatSteer[]>;
    readonly claim: (taskId: string, admissionId: string, steerIds: readonly string[]) => Promise<readonly string[]>;
    readonly settle: (taskId: string, heldIds: readonly string[]) => Promise<void>;
  };
  /** The model the graph calls first: role `main`'s target. */
  readonly connectionId: string;
  readonly model: string;
  /**
   * The targets after it, in order (role `main`'s fallback, at most three).
   * A model call that fails with `rate_limit` or `provider` moves to the next
   * as a new attempt, discarding its partial output; every other
   * failure ends the turn as before.
   */
  readonly fallback?: readonly ModelTarget[];
  /** Routine policies may fail over permanent unavailability without changing general chat behavior. */
  readonly routineAvailabilityFailover?: boolean;
  readonly isModelUnavailable?: (target: ModelTarget) => boolean | Promise<boolean>;
  readonly maxSteps?: number;
  readonly maxToolCalls?: number;
  /**
   * A task's own step budget per turn, when it has one — an agent definition's,
   * such as the browser worker's: at most
   * `MAX_TASK_STEPS`; absent, `maxSteps`.
   */
  readonly maxStepsFor?: (taskId: string) => Promise<number | undefined>;
  /**
   * The cap on each of a task's model calls' output: its own when it has one (a
   * heartbeat turn's), else its workspace's; absent, the model's own.
   */
  readonly maxOutputTokensFor?: (taskId: string, workspaceId: string) => Promise<number | undefined>;
  /**
   * The site a task's model calls are recorded under in the ledger
   * (`tavi doctor`'s per-site report), when the host knows better than the
   * task's origin: a routine's research or synthesis adapter.
   */
  readonly callSite?: ModelCallSite;
  /**
   * How a task's model calls are cached beyond its own run, passed to the transport with each call and never part
   * of the request: `ttl` `1h` for calls worth keeping an hour (a heartbeat turn whose next check comes between 5
   * and 55 minutes later), and `key` for calls that share a prefix across tasks (a heartbeat's ticks).
   */
  readonly cacheFor?: (taskId: string) => { readonly ttl?: "1h"; readonly key?: string } | undefined;
  /**
   * The tools a task may use, when it is narrowed to some — an agent
   * definition's: the rest are neither offered nor dispatched. Absent, every
   * tool the policy allows.
   */
  readonly toolsForTask?: (taskId: string) => Promise<((toolId: string) => boolean) | undefined>;
  /**
   * The lines `tools.search`'s description carries for this person in this
   * workspace: one per server whose tools wait behind
   * the search. Absent, the description is the static one.
   */
  readonly toolSearchLines?: (context: ToolOfferContext) => Promise<readonly string[]>;
  /**
   * The adapter's own base prompt, when it has one.
   *
   * Its presence is what selects the `explicit` tier of the precedence:
   * `explicit adapter prompt → workspace override → shipped default`. The
   * routine adapters are built by spreading the base options and then setting
   * this, which is why precedence is structural rather than an ordering check —
   * a workspace edit can never displace a routine's pinned instructions.
   */
  readonly systemPrompt?: string;
  /**
   * The workspace's persisted system-prompt override.
   *
   * Consulted only when this adapter was built **without** an explicit
   * `systemPrompt`, and only to resolve a base at admission: a new task's, and
   * each later prompt's (`start`/`reply`) of an existing one. Absent
   * means standalone use: an explicit prompt or the shipped default, exactly as
   * before this feature existed.
   */
  readonly promptSettings?: WorkspacePromptSettingsPort;
  /**
   * The workspace's timezone, resolved on every
   * model call so the runtime facts state the current local time in it.
   * Absent, or resolving to `undefined`: no local-time fact, as before.
   */
  readonly workspaceTimezone?: (workspaceId: string) => Promise<string | undefined>;
  /**
   * The MCP server the person keeps their tasks in (`tasks.home` `mcp:<server>`),
   * read per model call, or `undefined` while Tavi's own list is their home.
   * Set, the runtime facts send to-dos there. Absent: Tavi's own list.
   */
  readonly tasksHomeServer?: (workspaceId: string) => Promise<string | undefined>;
  /**
   * The workspace's prompt layout (`models.promptLayout`), read per model call
   * so a `tavi config set` reaches a running task's next call. Absent: `v1`.
   */
  readonly promptLayout?: (workspaceId: string) => Promise<PromptLayout>;
  /**
   * Whether a task's rarely used built-in families wait behind `tools.search`
   * under `v2` (`models.toolDeferral`, resolved for the task's model: `auto`
   * keeps a local model's whole list). Absent: they do.
   */
  readonly toolDeferral?: (workspaceId: string, taskId: string) => Promise<boolean>;
  /**
   * How many independent read-only calls of one step run at the same time
   * (`tools.parallelReads`; 1 runs each in turn), read only when a step has
   * two or more such calls in a row. Absent: `DEFAULT_PARALLEL_READS`.
   */
  readonly parallelReads?: (workspaceId: string) => Promise<number>;
  /**
   * The connections a workspace can send through, stated in the runtime facts
   * while `messaging.send_to` is offered. Read per call, so
   * a connection opened or closed from Settings reaches the next one.
   */
  readonly reachableChannels?: (workspaceId: string) => readonly ReachableChannel[];
  /**
   * Personal-memory service. Optional: when omitted, the model node's system
   * prompt is the task's selected base (its snapshot), byte for byte, matching
   * the adapter's pre-memory behavior. When present, resolved preferences and
   * retrieved evidence are assembled via `assembleContext` (`./context.js`)
   * and appended after the mandatory instructions on every model call,
   * rechecked each step rather than computed once at adapter construction,
   * so source validity and current grants are rechecked before each later model
   * call.
   */
  readonly memory?: MemoryServicePort;
  /**
   * Approved-skills service. Optional: when omitted, the assembled context's
   * skill/tool manifest stage is empty, matching the adapter's pre-wiring
   * behavior — the same additive-when-present pattern as `memory`. Only
   * meaningful when `memory` is also set, since `assembleContext` is not
   * called at all otherwise.
   */
  readonly skills?: SkillServicePort;
  /** Token budget passed to `assembleContext`; only meaningful when `memory` is set. */
  readonly maxContextTokens?: number;
  /**
   * Agent delegation/mailbox service, as a getter rather than a plain
   * value: `createAgentCommunicationService` itself needs the already-built
   * `WorkflowPort` this adapter returns (to `admit()` wake/spawn/resume
   * transitions), so the two cannot be constructed in either order without
   * one seeing the other unfinished. The composition root builds `workflow`
   * first with a getter closing over a variable it assigns right after
   * building the agent-communication service — by the time any real
   * admission calls into `toolsNode`, the getter always resolves (nothing
   * calls `admit()` before composition finishes). Optional: when omitted
   * (or the getter returns `undefined`), `agents.wait` is refused as an
   * unknown tool the same way any other unregistered call would be —
   * matching `memory`/`skills`'s additive-when-present pattern.
   */
  readonly agents?: () => AgentCommunicationServicePort | undefined;
  /**
   * Handing a browser session to a person,
   * a getter like `agents`. Absent — no live view anyone could take a
   * page over in — `browser.request_handoff` is not offered, and a browser call
   * refused because a person controls its session fails as any refusal does.
   */
  readonly browserHandoff?: () => BrowserHandoffPort | undefined;
  /**
   * The task's kept findings, digested, for the final step's answer;
   * `undefined` when it kept none. Absent,
   * the final step has only the conversation.
   */
  readonly keptFindings?: (workspaceId: string, taskId: string) => Promise<string | undefined>;
  /**
   * Tells the chat a task came from that it waits for an app to be connected: Tavi's
   * words only, never a link or a token. Absent, or for a task with no such chat, nothing is sent.
   */
  readonly tellConnect?: (input: { readonly taskId: string; readonly waitId: string; readonly text: string }) => Promise<void>;
  /**
   * Delivers an `ask_user` question to the operator.
   *
   * Injected, like `agents`, because the workflow must not know how a message
   * reaches a person: the composition root owns the messaging connector and the
   * operator-destination allowlist. Absent means "no channel is configured", and
   * `ask_user` then fails visibly instead of suspending a task on a question
   * nobody was asked.
   */
  readonly askUser?: (input: {
    readonly question: string;
    /** The question's choices, to render as buttons or a numbered list. */
    readonly choices?: AskUserChoices;
    /** Why it is asked, shown under the question. */
    readonly context?: string;
    readonly invocation: InvocationContext;
    readonly taskId: string;
    /** The wait this question belongs to, so a resumed turn does not ask twice. */
    readonly waitId: string;
    readonly connectionId?: string;
    readonly chatId?: string | number;
    /** Who asks, for the question's header, when the caller knows it better than the task row (a routine's name). */
    readonly origin?: string;
    /**
     * Where to ask, chosen by the operator rather than the model — a routine's
     * delivery destination — so it is not held to the model's allowlist.
     */
    readonly destination?: { readonly connectionId: string; readonly chatId: string };
    /**
     * A tool's question, which names no channel: sent into the
     * task's conversation when it has one; otherwise it waits in "Needs you"
     * (Center, `tavi needs`), and delivering it is not a failure.
     */
    readonly bestEffort?: boolean;
  }) => Promise<void>;
  /**
   * The latest a question of this task may wait until, or `undefined` for no
   * cap: a routine's run holds its question inside its own budget. A
   * question that would have less than a minute is refused, so the model goes
   * on without asking.
   */
  readonly askUserDeadlineCap?: (taskId: string) => Promise<string | undefined>;
  /**
   * An answer the operator gave in advance for a question like this one (a
   * standing answer), or `undefined`. Consulted only for a question
   * with options; one naming a label the question no longer offers is ignored.
   */
  readonly standingAnswer?: (input: {
    readonly taskId: string;
    readonly waitId: string;
    readonly question: string;
    readonly choices: AskUserChoices;
  }) => Promise<{ readonly answers: readonly string[]; readonly by: string } | undefined>;
  /**
   * Named agent personas. Optional, like `memory`/`skills`:
   * when omitted, every task runs under its selected base alone, exactly as
   * before this existed, and an `agentDefinitionId` on a context resolves to
   * nothing.
   */
  readonly agentDefinitions?: AgentDefinitionRepositoryPort;
  /**
   * Each chat's own instructions. Optional:
   * when omitted no chat layer is joined. Read per model call by the turn's
   * admission, so every call of a turn gets the revision it was admitted
   * under, however the chat's instructions change while it runs.
   */
  readonly chatInstructions?: Pick<ChatInstructionsRepositoryPort, "forAdmission">;
  /**
   * The task's agent mailbox — deliberately the
   * raw repository, not `agents`/`AgentCommunicationServicePort`. Context
   * assembly only peeks at it (a count of what is still waiting, on every
   * model call, when `memory` is set); a turn that begins claims its pending
   * envelopes once, under the admission, as a quoted data message, and
   * acknowledges them when it has run. Optional: when
   * omitted, no mail reaches a turn.
   */
  readonly mailbox?: AgentMailboxRepositoryPort;
  /**
   * Bounded-rollout enforcement —
   * passed straight through to `assembleContext`'s own `skillRollout`
   * option; see that field's own doc comment (`packages/agent-host/src/
   * context.ts`) for the exact enforcement semantics. Optional,
   * additive-when-present like `mailbox`: when omitted, every active
   * skill is included unconditionally regardless of any pin
   * (byte-identical to the pre-enforcement manifest). Only meaningful
   * when `memory` is also set, since `assembleContext` is not called at
   * all otherwise.
   */
  readonly skillRollout?: SkillRolloutRepositoryPort;
  /**
   * The workspace's skill uses, passed to `assembleContext`'s own `skillUsage`:
   * read once a model call, and only when the active skills are past the
   * listing cap, so the recently used are listed. Optional: absent, the
   * listing ranks by the turn's words alone.
   */
  readonly skillUsage?: Pick<SkillRepositoryPort, "listUsage">;
  /**
   * Which memories each chat's turns were given:
   * the evidence each model call's context retrieved, noted best-effort — a
   * failed write never fails the call. Omitted, nothing is noted.
   */
  readonly memoryUse?: Pick<TaskMemoryUseRepositoryPort, "record">;
  /**
   * Content-addressed artifact storage. Optional: when omitted, a tool
   * result over `MAX_TOOL_RESULT_BYTES` falls back to `boundToolOutput`'s
   * existing lossy truncation, byte-identical to the pre-archiving adapter.
   * When present, the full result is archived via `putArtifact` instead of
   * being discarded, so a bulky payload is replaced by a deterministic
   * bounded summary and an artifact
   * reference. Archiving is best-effort: a `putArtifact` that throws
   * (for example a store with no configured artifacts directory, as
   * `--in-memory` CLI mode is) falls back to the same lossy truncation as
   * omitting `artifacts` entirely — never a tool-call failure.
   */
  readonly artifacts?: ArtifactRepositoryPort;
  /** Messages never folded, regardless of age. Defaults to 40. */
  readonly compactionKeepRecentMessages?: number;
  /**
   * Conversation length at which an epoch rollover folds everything before the
   * recent tail into one epoch summary, at a model step or as an admission
   * joins. Runs with or without `artifacts`
   * (without, the fold says it is lossy). Defaults to
   * `MAX_CONVERSATION_MESSAGES` - 96.
   */
  readonly epochRolloverMessages?: number;
  /**
   * The model's context window, in tokens, for a target, when the catalog
   * knows it. With it stage 2's trigger and the verbatim tail follow
   * the window, and a request estimated past 85% of it is folded before it is
   * sent; without it the fixed defaults apply. A lookup that fails is taken
   * as unknown.
   */
  readonly contextWindowOf?: (target: { readonly connectionId: string; readonly model: string }) => Promise<number | undefined>;
  /** The cost budget on stage 2's window-relative trigger, in estimated tokens. Defaults to 64,000. */
  readonly compactionMaxContextTokens?: number;
  /**
   * The cap in place of `compactionMaxContextTokens` once a task's calls report prompt-cache reads. Defaults
   * to 128,000.
   */
  readonly compactionCachedMaxContextTokens?: number;
  /**
   * Stage 2's trigger for a turn's model whose window `contextWindowOf` does not know, in place of
   * `DEFAULT_COMPACTION_MODEL_TRIGGER_TOKENS`: a local model's smaller one, say. `undefined`: the default. It
   * sets no hard limit: only a known window does.
   */
  readonly unknownWindowTriggerTokens?: (target: { readonly connectionId: string; readonly model: string }) => Promise<number | undefined>;
  /**
   * How far the conversation grows (in characters of its messages) between
   * the moments older tool results — superseded browser observations and file
   * reads, long command, search and fetch output, archived results — are
   * shrunk in the model's view: see `compactSupersededObservations`. Defaults
   * to `SUPERSEDED_OBSERVATION_STRIDE_CHARS`; 0 shrinks each one as soon as it
   * is superseded, or as soon as a step has answered it.
   */
  readonly supersededObservationStrideChars?: number;
  /**
   * Estimated token size of `conversationForThisCall` above which the
   * model node attempts a stage-2 model-summarized fold,
   * on top of whatever a rollover already folded this
   * step. Only meaningful when `artifacts` is also set. Defaults to 6,000.
   */
  readonly compactionModelTriggerTokens?: number;
  /**
   * Instructions for the stage-2 summarization call. Defaults to
   * `DEFAULT_COMPACTION_SUMMARY_PROMPT`. Only meaningful when `artifacts`
   * is also set — stage 2 never runs without it.
   */
  readonly compactionSummaryPrompt?: string;
  /**
   * Effects that require an explicit approval before dispatch. The default gates
   * mutating and external effects; read-only fixtures run unattended.
   */
  readonly approvalRequiredFor?: readonly ("read-only" | "mutating" | "external")[];
  /**
   * How the gate's taint step applies in a workspace (`security.taint`):
   * `enforce` asks, `observe` records on the verdict
   * what it would have asked (`observedGateReason`) and decides as before,
   * `off` skips it. Absent: `enforce`.
   */
  readonly taintMode?: (workspaceId: string) => TaintMode | Promise<TaintMode>;
  /**
   * The injection detector (`security.injectionDetector`):
   * given the untrusted content of a tainted conversation, the
   * hits it finds. Read for each call the gate asks about (the one decision
   * whose card shows the warning); a hit only adds a reason and
   * raises the verdict's risk to `high` (`withInjectionWarning`), after every
   * decision is made. Absent, or `off` for the workspace: nothing is read.
   * Its errors do nothing.
   */
  readonly injectionScan?: (input: {
    readonly workspaceId: string;
    readonly taskId: string;
    /** The turn's invocation: a classifier call is made in it (the `model` mode). */
    readonly invocation: InvocationContext;
    readonly items: readonly { readonly ref: string; readonly source: SourceKind; readonly text: string }[];
    readonly signal?: AbortSignal | undefined;
  }) => Promise<readonly { readonly ref: string; readonly source: SourceKind; readonly signals: readonly string[] }[]>;
  /**
   * Record a call the taint step asked, or under `observe` would have asked
   * (`tavi_gate_observations`): its tool, effect, sink and reason, never
   * its arguments. Best effort: a failure is reported, never a failed turn.
   */
  readonly recordGateObservation?: (observation: GateObservation) => unknown;
  /**
   * The runs of this adapter have nobody to ask (a routine's research and
   * synthesis): a taint-step ask is a denial with the same reason, recorded
   * on the verdict. A heartbeat tick's turn is held to it by its origin.
   */
  readonly taintAsksDeny?: boolean;
  /**
   * Tool ids that dispatch without an approval round whatever their effect: the
   * operator's standing exemptions (`serve --allow web_search`). Exemption is by
   * exact id, and only lifts the round — the tool's permissions and its own
   * allowlists are checked exactly as before.
   */
  readonly approvalExemptTools?: readonly string[];
  /**
   * The rules and session grants the approval gate evaluates. Read once
   * per emitted call, when the model node checkpoints the verdict. Absent,
   * `approvalExemptTools` are the only rules and there are no grants — the
   * gate behaves exactly as it did before rules existed.
   */
  /**
   * The origin a task's rules and deadlines follow. Absent, the task's
   * own recorded origin; the composition passes its delegation root's, so a
   * worker a chat task spawned is held to the messaging profile too.
   */
  readonly taskOrigin?: (taskId: string) => Promise<string | null | undefined>;
  /**
   * The channel a turn is held to, read from its context: `messaging`
   * for a turn sent from a messaging conversation, or for a worker whose
   * spawning turn was; else undefined. Read at each admission (with the
   * context's `runId` set to the admitted task) and stamped on the turn as
   * `heldChannel`. Rules then apply as the narrower of the task's origin and
   * this channel (`ruleAppliesToTurn`). Absent, no turn names a channel and
   * the task's origin alone decides, as before; the composition supplies it,
   * because only it knows which connections are the owner's own local ones
   * and where a worker's delegation is recorded.
   */
  readonly turnChannel?: (invocation: InvocationContext) => string | undefined | Promise<string | undefined>;
  /**
   * The front end a turn is held to besides the one its caller names:
   * a worker's spawning turn's, from its delegation row, so a
   * worker a canvas turn spawned is held to `web` rules whoever admits its
   * later turns. Read at each admission (the context's `runId` the admitted
   * task); a value it answers wins over the caller's. Absent: the caller's.
   */
  readonly turnFrontEnd?: (invocation: InvocationContext) => FrontEnd | undefined | Promise<FrontEnd | undefined>;
  /**
   * The messaging connection a turn held to `messaging` came in on: its own
   * reply target's when that is no local connection, else a worker's spawning
   * turn's, from its delegation row. Read at each admission of a held turn and
   * stamped as `heldConnectionId`; plugins' hooks see it as the turn's
   * `channel`. Absent: none, as only the composition knows which connections
   * are the owner's own local ones.
   */
  readonly turnConnection?: (invocation: InvocationContext) => string | undefined | Promise<string | undefined>;
  /**
   * The chat's working folder as this turn sees it:
   * read once at each admission — with the context's `runId` the admitted
   * task and the turn's held channel and taint — and stamped as `folder`, so a
   * change applies from the chat's next message and no caller or
   * model chooses it. One that throws refuses nothing here: the turn
   * runs with no `folder` and its error as `folderUnavailable`, which the tools
   * that need a folder report. Absent: no turn carries a folder.
   * Answering `undefined` gives the turn no folder at all — a heartbeat tick's
   * by the task's `origin` — and nothing is created for it.
   */
  readonly turnFolder?: (
    invocation: InvocationContext,
    turn: {
      readonly heldChannel?: TurnChannel | undefined;
      readonly tainted: boolean;
      readonly origin?: TaskOrigin | undefined;
      /** The task's row as the admission read it, whose creation facts the folder need not read again. */
      readonly task?: TaskRecord | undefined;
    },
  ) => ChatFolder | undefined | Promise<ChatFolder | undefined>;
  /**
   * A turn ended — completed, failed or cancelled, never one left waiting on
   * an approval, a review or an answer — with the folder it was given:
   * the owner empties the chat's `.tmp/`. Best
   * effort: a failure is reported, never the turn's.
   */
  readonly onTurnEnded?: (ended: {
    readonly taskId: string;
    readonly workspaceId: string;
    readonly folder?: ChatFolder | undefined;
  }) => Promise<void> | void;
  readonly toolPolicy?: {
    /**
     * Every rule in force in a workspace: shipped, flag and stored alike. With
     * the turn's context, the rules for that turn: a flag may lift a profile
     * rule in some conversations only (`serve --messaging-allow-tool`).
     */
    readonly rules: (workspaceId: string, invocation?: InvocationContext) => Promise<readonly ToolRule[]>;
    readonly sessionGrants: (taskId: string) => Promise<readonly SessionGrant[]>;
    /** Record a `session` decision's grant. Idempotent by grant id. Absent: `session` decisions grant once. */
    readonly grantSession?: (grant: SessionGrant) => Promise<void>;
    /** Record an `always` decision's workspace rule. Idempotent by rule id. Absent: `always` decisions grant once. */
    readonly addRule?: (rule: ToolRule) => Promise<void>;
  };
  /**
   * Put a round in front of a person where they are: called after the
   * round's rows are written and before the graph suspends, and again each
   * time the suspended node re-enters on resume — so it must be idempotent,
   * and a round it already announced must be a no-op. A throw is reported and
   * never fails the round: the round stays decidable from every front end.
   */
  readonly announceRound?: (round: ApprovalRoundAnnouncement) => Promise<void>;
  /** Called once a round is decided, with each call's outcome, so the channels that announced it can say so. */
  readonly onRoundSettled?: (settlement: ApprovalRoundSettlement) => Promise<void>;
  /** Called after dispatch with what became of each call a round decided — ran, failed or denied — for the round's audit trail. Idempotent: a replayed node calls it again. */
  readonly onRoundToolResults?: (report: {
    readonly taskId: string;
    readonly steps: number;
    readonly results: readonly { readonly callId: string; readonly toolName: string; readonly status: "ok" | "error" | "denied" }[];
  }) => Promise<void>;
  /**
   * Authorization for tool dispatch.
   *
   * Required: a tool's declared permissions are enforced before its handler runs,
   * so "missing policy denies execution" is a property of the adapter rather than
   * of each handler.
   */
  readonly access: AccessPolicyPort;
  /**
   * Durable task and admission records.
   *
   * Required: the workflow service owns the single admission path, and admission
   * has to commit with task creation before any node runs.
   */
  readonly tasks: TaskRepositoryPort;
  /** Execution ownership; one invocation slot per task. */
  readonly executions: ExecutionRepositoryPort;
  /** External effect ledger; every mutating or external effect is recorded. */
  readonly effects: EffectRepositoryPort;
  /**
   * Durable approvals.
   *
   * Required: the authorized action is owned by the application, not by the
   * checkpoint, so a resumed run rechecks this record before dispatch.
   */
  readonly approvals: ApprovalRepositoryPort;
  /** Durable cancellations; a cancelled task is never revived by a late reply. */
  readonly cancellations: CancellationRepositoryPort;
  /**
   * Application receipts for durable checkpoints.
   *
   * Required: making it optional would let this gate disappear silently, which is
   * exactly what a durability guarantee must not allow.
   */
  readonly receipts: CheckpointReceiptRepositoryPort;
  /**
   * Liveness identity for this process.
   *
   * A second session holding the slot refuses acquisition, so two invocations
   * for one task can never overlap.
   */
  readonly ownerSession: string;
  /** Lease duration for an invocation; refreshed by a heartbeat. */
  readonly leaseMs?: number;
  /**
   * Checkpoint namespace this graph writes under.
   *
   * A root graph uses `""`; the value is recorded on the task so the
   * thread-and-namespace mapping is a real persisted value.
   */
  readonly checkpointNamespace?: string;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
}

/** What `announceRound` receives: the round, as its interrupt payload will carry it. */
export interface ApprovalRoundAnnouncement {
  readonly taskId: string;
  readonly steps: number;
  readonly invocation: InvocationContext;
  readonly requests: readonly {
    readonly callId: string;
    readonly toolName: string;
    readonly summary: string;
    readonly input: unknown;
    readonly risk?: GateVerdict["risk"] | undefined;
    readonly display?: GateVerdict["display"] | undefined;
    readonly allowedScopes?: readonly ApprovalScope[] | undefined;
    /** The call's rule subjects; none means a wider scope covers any call of the tool. */
    readonly subjects?: readonly string[] | undefined;
    /** The tools a wider scope covers as one permission (`browser.*`). */
    readonly scopeGroup?: string | undefined;
    /** The taint step's reason, when it asked. */
    readonly gateReason?: GateVerdict["gateReason"] | undefined;
    /** Why the call is asked, and from where. */
    readonly provenance?: ApprovalProvenance | undefined;
  }[];
}

/** What `onRoundSettled` receives. `scope` is the scope applied, which may be narrower than the one asked for. */
export interface ApprovalRoundSettlement {
  readonly taskId: string;
  readonly steps: number;
  readonly invocation: InvocationContext;
  readonly via?: string;
  readonly decisions: readonly {
    readonly callId: string;
    readonly toolName: string;
    readonly approved: boolean;
    readonly scope: ApprovalScope;
    readonly decidedBy: string;
    readonly note?: string;
    /** The session grants or workspace rules the decision created, so the audit trail can say what to revoke. */
    readonly created?: readonly { readonly id: string; readonly argMatcher?: string }[];
  }[];
}

/** A chat's memory as the workflow reads it: its mode, and when it was last turned back on. */
export interface ChatMemoryState {
  readonly mode?: ChatMemoryMode | undefined;
  readonly onAt?: string | undefined;
}

/** The stricter of two chat memory modes: private, then off, then on (absent). */
export function stricterChatMemoryMode(a: ChatMemoryMode | undefined, b: ChatMemoryMode | undefined): ChatMemoryMode | undefined {
  return a === "private" || b === "private" ? "private" : (a ?? b);
}

/** `WorkflowOptions.memoryRecall`: each switch is on unless `false`. */
export interface MemoryRecallSwitches {
  readonly relevanceFloor?: boolean;
  readonly profile?: boolean;
  readonly rankingPriors?: boolean;
  readonly temporalRanking?: boolean;
}
