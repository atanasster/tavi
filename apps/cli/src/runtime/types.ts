import type {
  BrowserLiveSource,
  ChatFolder,
  ChromiumSandboxMode,
  MemoryOverride,
  MemoryServicePort,
  EffectiveMemorySettings,
  ToolRule,
  SecretSourceCapability,
  InboundEvent,
  HeartbeatOptions,
  HeartbeatHistoryRemoved,
  HeartbeatToolChoice,
  MessagingIngestHooks,
  MessagingIngestReceipt,
  MessagingServicePort,
  ModelPort,
  BrowserPort,
  TaintMode,
  PdfEnginePort,
  VideoAnalyzerRegistry,
  VideoDecoderPort,
  RenderPort,
  SandboxPort,
  ConfinementPort,
  SandboxHostPort,
  ResourceLimitPort,
  PluginIsolationPort,
  ResourceLimits,
  WorkflowPort,
  ModelTarget,
  ScheduleRecord,
} from "@tavi/contracts";
import type {
  ChannelHost,
  PairingRegistry,
  FloodLimits,
  RunEventBus,
  LiveHub,
  AccessPolicy,
  ChatFolders,
  CredentialKeychain,
  FolderSpace,
  MaterializeArtifact,
  DataDirectoryOwner,
  ModelAccounting,
  RouterRepository,
  RouterProviderSlot,
  PluginHost,
  PluginRegistry,
  PluginLiveStatus,
  DatabaseClient,
  RoutineService,
  RoutineControlService,
  RoutineEvaluationService,
  RoutineExecutionService,
  RoutineNewsService,
  RoutinePublicationService,
  RoutineDeliveryService,
  ToolRegistry,
  TurnHookRegistry,
  createClock,
  createLogger,
  LoggerOptions,
  SecretBinding,
  ShutdownReport,
  WorkspaceGrant,
} from "@tavi/runtime";
import type { ChannelPurgeDependencies } from "../features/channels/purge.js";
import type { AbortRegistry, AdmissionTracker } from "../features/run/run-events.js";
import type { RequestListener, Server } from "node:http";
import type { InFlightFireRegistry, RepeatTimer, ScheduleSchedulerDependencies } from "@tavi/agent-host/schedule-scheduler";
import type {
  HeartbeatProviderRegistry,
  HeartbeatProviderStates,
  HeartbeatSignalRegistry,
  HeartbeatHostHandle,
} from "@tavi/agent-host/heartbeat-host";
import type { IdeasHost, IdeasProviderRegistry } from "@tavi/agent-host/ideas-host";
import type { OnboardingProviderRegistry } from "@tavi/agent-host/onboarding-host";
import type { OnboardingTurnRecorder } from "../features/onboard/verification.js";
import type { OnboardingVerifyGate } from "../features/onboard/owner.js";
import type { OpenRouterSignIns } from "../features/onboard/openrouter.js";
import type { RoomInvitations } from "../features/channels/group-pairing.js";
import type { MemoryProviderRegistry } from "../features/memory/providers.js";
import type { MemoryProviderSync } from "../features/memory/provider-sync.js";
import type { EmbeddingRoleService } from "../features/memory/embedding-role.js";
import type { ChatNotices } from "../features/tasks/notices.js";
import type { ScheduleFireNow } from "../features/schedules/actions.js";
import type { ProviderConnection } from "@tavi/agent-host/models";
import type { ChannelApprovals } from "../features/approvals/channel-approvals.js";
import type { FolderReadScope } from "../features/folders/fs-tools.js";
import type { ConnectWaits } from "../features/apps/connect-waits.js";
import type { MemoryRecallTimes } from "../features/memory/vectors.js";
import type { MemoryJobsNow } from "../features/memory/jobs-now.js";
import type { MemoryChannelCards } from "../features/memory/channel-cards.js";
import type { OAuthFlows } from "../features/oauth/flow.js";
import type { OAuthCallbackRouter } from "../features/oauth/core.js";
import type { ChatGptSignIns, ChatGptCredential } from "../features/onboard/chatgpt.js";
import type { OAuthBroker } from "../features/oauth/broker.js";
import type { McpHost } from "../features/mcp/host.js";
import type { SandboxOwnerOptions } from "../features/sandbox/setup.js";
import type { SandboxCredentialBinding } from "../features/sandbox/tools.js";
import type { ChatGrants } from "../features/permissions/chat-grants.js";

export interface TaviRuntimeOptions {
  readonly dataDirectory: string;
  readonly inMemory?: boolean;
  readonly buildId?: string;
  readonly logger?: LoggerOptions;
  readonly workspaces: readonly WorkspaceGrant[];
  /** Provider connections available to the model adapter. */
  readonly providers: readonly ProviderConnection[];
  /** Explicit credential reference bindings; there is no ambient fallback. */
  readonly credentials: Readonly<Record<string, SecretBinding>>;
  readonly defaultConnectionId: string;
  readonly defaultModel: string;
  readonly explicitModelSelection?: boolean;
  /**
   * `serve` started with no model configured and composed its historical
   * `default`/`default` placeholders. They let the owner start, but name no
   * model: a routine must not pin them as its research or synthesis model.
   * No provider is composed for them: with
   * `liveModelTarget` set, the model transport is composed anyway, and the
   * first model added over IPC is served from the next turn, no restart.
   */
  readonly modelTargetUnconfigured?: boolean;
  readonly explicitModelTarget?: { readonly connectionId?: string; readonly model?: string };
  /**
   * The targets after the default, in order — role `main`'s fallback:
   * a model call failing with `rate_limit` or `provider` moves to the next as
   * a new attempt. Each connection named here must be in `providers`.
   */
  readonly modelFallback?: readonly ModelTarget[];
  /**
   * What `--connection`/`--model` named, when the default target is resolved
   * again at every turn with no saved route — `serve`'s, unless both flags
   * pinned it. Absent, every such
   * turn runs `defaultConnectionId`/`defaultModel` and `modelFallback`.
   */
  readonly liveModelTarget?: { readonly connectionId?: string; readonly model?: string };
  readonly systemPrompt?: string;
  /**
   * Registers the `fixture.echo` tool on the model-facing surface.
   *
   * **Test-only.** It exists so a suite can exercise a real model → tool →
   * model round trip without a provider, and it has no place in a real
   * deployment's tool list. Off by default, and the CLI never sets it: a
   * CLI-driven suite turns it on through `test/support/dev-fixture-tool.ts`.
   */
  readonly devFixtureTools?: boolean;
  /**
   * Operator-authored host allowlist for the `http.request` tool.
   * Exact hosts, or `*.suffix` forms. An empty list denies every host,
   * so an unconfigured runtime has no network egress through a tool — the model
   * can never widen this (`sandbox.run`'s `SandboxPolicy` precedent).
   */
  readonly httpAllowedHosts?: readonly string[];
  /** The folders a chat may use or attach (`serve --fs-root`); the file tools work in each chat's own folder with or without one. */
  readonly fsRoots?: readonly string[];
  /** `serve --sandbox-read`: folders every chat's `sandbox.run` may read beside its own; never the data directory or a credential home. */
  readonly sandboxRead?: readonly string[];
  /** `serve --sandbox-domain`: domains every workspace's `sandbox.run` may reach, beside each workspace's `sandbox.domains`. */
  readonly sandboxDomains?: readonly string[];
  /** `serve --sandbox-credential`: credentials `sandbox.run` uses through its proxy, never holding them. */
  readonly sandboxCredentials?: readonly SandboxCredentialBinding[];
  /**
   * Folder retention (`serve --folder-cap`, `--chats-cap`, `--free-space-floor`):
   * the budget of one chat's
   * managed folder and of every chat's together, and the free space below
   * which host-side writes and new `sandbox.run` calls are refused. Each
   * defaults as `@tavi/contracts` says (2 GiB, 20 GiB, 1 GiB).
   */
  readonly folderRetention?: { readonly folderCapBytes?: number; readonly chatsCapBytes?: number; readonly freeSpaceFloorBytes?: number };
  /** Tools a chat-started task may use despite the messaging profile. */
  readonly messagingAllowTools?: readonly string[];
  /**
   * Extra request headers the model may set, on top of the built-in allowlist
   * (`--http-request-header`). Validated where the tool is registered, which
   * refuses a non-token name and any credential header.
   */
  readonly httpAllowedRequestHeaders?: readonly string[];
  /** Hosts the browser may open when nobody was asked; a call a person allowed opens any http(s) site. */
  readonly browserAllowedHosts?: readonly string[];
  /**
   * Which hosts each credential reference may be sent to by `http.request`.
   * A reference with no entry is refused, so the model cannot pair an operator
   * credential with an arbitrary allowlisted host.
   */
  readonly httpCredentialHosts?: Readonly<Record<string, readonly string[]>>;
  /**
   * Destinations `messaging.send_to` may address — exact provider conversation
   * ids. Empty or absent denies every destination, the
   * same deny-by-default shape as `httpAllowedHosts`, because the destination
   * is a model-authored tool argument and this tool may be auto-approved
   * for unattended runs. `messaging.send` (a reply) is unaffected: its
   * destination comes from the inbound message, not from the model.
   */
  readonly messagingAllowedDestinations?: readonly string[];
  readonly approvalRequiredFor?: readonly ("read-only" | "mutating" | "external")[];
  /**
   * Tool ids exempt from the approval round their effect would otherwise
   * require (`serve --allow <tool>`). A standing decision by the operator, so
   * a task never suspends on it; the tool's own allowlists still apply.
   */
  readonly approvalExemptTools?: readonly string[];
  /** Token budget for `assembleContext`'s retrieved-memory manifest; unset uses its own default. */
  readonly maxContextTokens?: number;
  readonly shutdownDeadlineMs?: number;
  /**
   * How often the wait-expiry sweep (and the approval-round expiry sweep) runs
   * on its own timer. Absent, the owner's due-work planner sweeps when a
   * deadline comes and this timer is a ten-minute fallback; set, it sweeps at
   * this pace as well (tests).
   */
  readonly agentWaitSweepIntervalMs?: number;
  /** How long a ❌ press on a chat round waits for its reason (default 2 minutes). */
  readonly approvalReasonWindowMs?: number;
  /** How long a round announced to a chat waits before it is rejected (`serve --approval-expiry`); 24 hours when absent. */
  readonly approvalExpiryMs?: number;
  /**
   * How often the recurring-schedule sweep runs on its own timer, as
   * `agentWaitSweepIntervalMs`: absent, the planner sweeps when a fire falls
   * due (and every 30 s while routines or held runs need it) and this timer is
   * a ten-minute fallback.
   */
  readonly scheduleSweepIntervalMs?: number;
  /**
   * Run the transport retention sweep. Set by `serve` and by nothing else: a
   * read-only command composing the runtime must not delete rows as a side
   * effect.
   */
  readonly retentionSweepEnabled?: boolean;
  /**
   * `load` (the default) imports enabled external plugins; `verify` only checks them — approval,
   * snapshot hash, settings — and reports each as `verified` or `failed`. `doctor` uses
   * `verify`: a diagnostic must not run third-party code, nor be stopped by a plugin that hangs.
   */
  readonly externalPlugins?: "load" | "verify";
  /** `tavi serve --dev-plugin`: absolute plugin folders loaded unapproved for this run and reloaded on save, each in place of an installed one of its id. */
  readonly devPlugins?: readonly string[];
  /** How often `serve` prunes finished transport rows (default: 6 hours). */
  readonly retentionSweepIntervalMs?: number;
  /**
   * Whether the sweep also deletes non-report artifacts past the window. Off
   * unless an operator asks: a report PDF is the deliverable, and the rest of the
   * artifact store is only theirs to judge.
   */
  readonly retentionSweepArtifacts?: boolean;
  /**
   * How many times to attempt opening a messaging connection at startup;
   * defaults to 3. A scheduled run cannot tell anyone
   * that its delivery channel failed to come up, so a transient provider error
   * at boot must not cost the day's brief.
   */
  readonly messagingOpenAttempts?: number;
  /**
   * Whether this runtime opens the connections saved in Settings → Messaging
   * for every workspace it serves, after importing
   * older settings files. Absent: no channel connection opens.
   */
  readonly openSavedChannels?: boolean;
  /**
   * Whether this composition starts the recurring-schedule sweep; defaults to
   * true.
   *
   * `tavi schedules run-now` sets it false. That command composes a *second*
   * runtime inside the operator's terminal to admit one run, and without this
   * the composed `tavi.schedules` plugin would begin sweeping on its own 30s
   * interval — firing unrelated due schedules during a manual run, and able to
   * fire the very schedule being run by hand. Composing a runtime must not have
   * the side effect of starting a scheduler the operator did not ask for.
   */
  readonly scheduleSweepEnabled?: boolean;
  /**
   * Whether file watchers (`schedules watch --file`) check soon after their
   * files change; off unless set. Set by `serve` only: a watcher's cadence
   * fires wherever the schedule sweep runs, and `scheduleSweepEnabled: false`
   * turns this off as well.
   */
  readonly scheduleWatchersEnabled?: boolean;
  /**
   * Whether this composition fires reminders;
   * off unless set. Set by `serve` and by nothing else, for the reason
   * `retentionSweepEnabled` gives: `run`, `doctor` and the one-shot commands
   * compose this runtime too, and composing one must not deliver someone's
   * reminder as a side effect. `scheduleSweepEnabled: false` turns it off as
   * well: a reminder is scheduled work.
   */
  readonly reminderSweepEnabled?: boolean;
  /** How often the reminder sweep runs on its own timer, as `scheduleSweepIntervalMs`: absent, a ten-minute fallback behind the planner. */
  readonly reminderSweepIntervalMs?: number;
  /**
   * Whether this composition runs the heartbeat host;
   * off unless set. Set by `serve` only, for the reason
   * `reminderSweepEnabled` gives: composing a runtime for a one-shot command
   * must not tick someone's heartbeat. `scheduleSweepEnabled: false` turns it
   * off as well.
   */
  readonly heartbeatEnabled?: boolean;
  /**
   * Whether this composition runs the ideas host, `tavi.ideas`:
   * each workspace's daily run and `/ideas`. Set by `serve` only, as the
   * heartbeat host is; off unless set. A refresh asked for runs either way.
   */
  readonly ideasEnabled?: boolean;
  /**
   * Whether this composition runs the memory host, `tavi.memory`:
   * the chat commands now, its background jobs later. Set by `serve`
   * only, as the heartbeat host is; off unless set.
   */
  readonly memoryHostEnabled?: boolean;
  /**
   * Whether the memory host starts its 60 s tick (the digest, the idle review,
   * the vector backfill and consolidation); defaults to true. False keeps the
   * host's on-demand jobs (`runtime.memoryJobs`) with no timer, for the reason
   * `scheduleSweepEnabled` gives: a one-shot `tavi memory reindex | review-now |
   * consolidate-now` and `tavi serve --eval` must not start scheduled work.
   */
  readonly memoryTickEnabled?: boolean;
  /**
   * Whether this composition announces, once at start, the workers that
   * ended in the last day without their result reaching their parent — an
   * announce a restart lost; off unless set. Set by
   * `serve` only, like the reminder sweep: an announce may wake a parent's
   * turn, which a one-shot command must not run as a side effect.
   */
  readonly workerResultSweepEnabled?: boolean;
  /**
   * Whether this composition deletes the chat grants past their end
   * at start and then every `grantSweepIntervalMs` (an hour by
   * default); off unless set. Set by `serve` only: a grant is otherwise
   * deleted only when its own task's grants are read.
   */
  readonly grantSweepEnabled?: boolean;
  readonly grantSweepIntervalMs?: number;
  /**
   * `serve --taint-policy`: the taint mode for every
   * workspace this owner serves, overriding each one's `security.taint` for
   * the owner's lifetime. Absent: each workspace's own setting.
   */
  readonly taintPolicy?: TaintMode;
  /**
   * Whether this composition writes task titles and summaries;
   * off unless set. Set by `serve` only,
   * like the reminder sweep: a one-shot command must not spend model calls on
   * other tasks as a side effect. Whether a workspace wants summaries is its
   * `activitySummaries` setting, read per task.
   */
  readonly taskSummariesEnabled?: boolean;
  /**
   * Settle the sandbox's tier at start: the host's facts
   * and its live probe, awaited up to `SANDBOX_WARM_TIMEOUT_MS` and logged.
   * `serve` sets it; a short command probes only when it needs the answer.
   */
  readonly sandboxWarm?: boolean;
  /** `serve --sandbox-nested`: srt's weaker nested mode is this owner's tier, for a container that masks `/proc`. */
  readonly sandboxNested?: boolean;
  /** `serve --sandbox-tier unavailable` / `TAVI_SANDBOX=off`: `sandbox.run` is refused whatever the host could do. */
  readonly sandboxPinnedOff?: boolean;
  /** `serve --sandbox-memory`, `--sandbox-pids`, `--sandbox-cpu`: sandbox.run's caps over the defaults. */
  readonly sandboxLimits?: ResourceLimits;
  /** `serve --sandbox-timeout`, `--sandbox-max-timeout`: sandbox.run's default run time and longest allowed, in ms. */
  readonly sandboxTimeouts?: { readonly defaultMs?: number; readonly maxMs?: number };
  /** `serve --sandbox-cache`: one package cache every chat's untainted shell shares, in `~/.cache/tavi-sandbox`. */
  readonly sandboxCache?: boolean;
  /** `serve --sandbox-parent-proxy` (or `TAVI_SANDBOX_PARENT_PROXY`): the proxy sandbox.run's granted connections leave through. */
  readonly sandboxParentProxy?: string;
  /** `serve --sandbox-inspect-tls`: sandbox.run's proxy terminates every grant's TLS and refuses what it cannot inspect. */
  readonly sandboxInspectTls?: boolean;
  /** `serve --sandbox-pty`, `--sandbox-local-bind`: macOS capabilities sandbox.run gets only on the operator's say. */
  readonly sandboxLocal?: { readonly pty?: boolean; readonly localBind?: boolean };
  /** `serve --video-ffmpeg`, `--video-ffprobe`, `--video-allow-unconfined`. */
  readonly video?: { readonly ffmpeg?: string; readonly ffprobe?: string; readonly allowUnconfined?: boolean };
  /** `serve --pdf-allow-unconfined`. */
  readonly pdf?: { readonly allowUnconfined?: boolean };
  /** How often the summary queue is checked; absent, every five minutes behind the drain at each task's end. */
  readonly taskSummaryIntervalMs?: number;
  /** Liveness identity for this runtime; defaults to a fresh session id. */
  readonly ownerSession?: string;
  /**
   * Permit a data directory other users can reach.
   *
   * Off by default; only a deliberate operator choice should relax it.
   */
  readonly allowPublicDirectory?: boolean;
}

/** The owner's way into its local connections; see `TaviRuntime.localMessaging`. */
export interface LocalMessaging {
  /** The workspace's local connection, when it is open. */
  connectionFor(workspaceId: string): string | undefined;
  /**
   * Hand an inbound message to `workspaceId`'s local connection, and only
   * that one — the connection is the workspace's, never one a caller names;
   * see `LocalConnectorInstance.deliver`.
   */
  deliver(workspaceId: string, event: Omit<InboundEvent, "connectionId">, hooks?: MessagingIngestHooks): Promise<MessagingIngestReceipt>;
}

/** The agent's browser and what bounds it, for `doctor`. */
export interface BrowserBoundary {
  readonly display: "headless" | "headed";
  /** Inside srt and its limits (Linux, headless). */
  readonly confined: boolean;
  /** Unconfined: why, and what bounds it instead. */
  readonly why?: string;
  /** Confined: Chromium's own sandbox inside srt, once the first launch chose it. */
  readonly chromiumSandbox?: ChromiumSandboxMode | "chosen at the first launch";
  /** Confined: the browser's memory cap, and whether it fits what every sandbox together may use, where that is known. */
  readonly memory?: { readonly capBytes: number; readonly aggregateBytes?: number; readonly fits?: boolean };
}

export interface TaviRuntime {
  /** The resolved data directory this runtime owns. */
  readonly dataDirectory: string;
  /** Whether and how this host confines: one answer for `sandbox.run`, MCP servers, the PDF children and `doctor`. */
  readonly sandboxHost: SandboxHostPort;
  /**
   * The engine `sandbox.run` runs through, and `plugins.validate` inside
   * `serve` (so it takes its tier, its `--fs-root` check and its shutdown): never a raw handle for a tool, which goes through
   * `dispatchSandboxedTool`.
   */
  readonly sandbox: SandboxPort;
  /** Resource limits: how each child is bounded here. */
  readonly limits: ResourceLimitPort;
  /** `serve --sandbox-memory`, `--sandbox-pids`, `--sandbox-cpu`: sandbox.run's caps over the defaults, for `doctor`. */
  readonly sandboxLimits?: ResourceLimits;
  /** `serve --sandbox-parent-proxy`, for `doctor`. */
  readonly sandboxParentProxy?: string;
  /** The off switch and the sandbox opt-ins this owner was started with, for `doctor`. */
  readonly sandboxOptions?: SandboxOwnerOptions;
  /** Doctor's `video` facts: the person's FFmpeg and its build, or how to install one, and how its runs are confined here. */
  readonly videoDoctor: (sandbox?: {
    readonly works: boolean;
    readonly cause?: string | undefined;
    readonly fix?: string | undefined;
  }) => Promise<Record<string, unknown>>;
  /** `serve --pdf-allow-unconfined`: the PDF children run bare where the sandbox is unavailable, for `doctor`. */
  readonly pdfAllowUnconfined?: boolean;
  /** `serve --video-ffmpeg` / `--video-ffprobe`, as the video tools were given them. */
  readonly videoBinaries: { readonly ffmpeg?: string; readonly ffprobe?: string };
  /** Every messaging connection this owner opens. */
  readonly channels: ChannelHost;
  /** Removed connections' purges: scheduled by a removal, cancelled by the same account's return, run by the retention sweep. */
  readonly channelPurging: ChannelPurgeDependencies;
  /** A forgotten sender's notes (`forget-sender`): what their own conversation tasks taught, as them; answers how many records went. */
  readonly forgetSenderNotes: (principalId: string, taskIds: readonly string[]) => Promise<number>;
  /** How many chat notes these conversation tasks taught, each read as its person: what a removal's purge would forget. */
  readonly countChatNotes: (taskIds: readonly string[]) => Promise<number>;
  /**
   * Applies a Settings save without a restart: the host
   * reopens what changed, and routines learn the destinations it brings.
   * Answers the workspace's connections that could not open, each with why,
   * and the purges the purging connections that opened cancelled.
   */
  readonly reloadChannels: (workspaceId: string) => Promise<{
    readonly failed: readonly { readonly connectionId: string; readonly detail: string }[];
    readonly purgeCancelled: readonly string[];
  }>;
  /** Reads Allowed people again, so a person allowed or revoked through the owner acts, or stops, at once. */
  readonly refreshPeople: () => Promise<void>;
  /**
   * Takes a `models`, `credentials` or `search` write without a restart:
   * built-in search providers enabled since are
   * activated, `web_search` is offered once one is, and routines' model and
   * tool bindings are configured again from the live connections and default.
   */
  readonly refreshProviders: () => Promise<void>;
  /** Moves the webhook listener to the saved ingress settings (a no-op while flags set them). */
  readonly applyIngress: () => Promise<void>;
  /** Pairing codes waiting to be sent. */
  readonly pairings: PairingRegistry;
  /** Rooms a group channel's agent was added to, or that spoke while unlisted, waiting on the operator. */
  readonly roomInvitations: RoomInvitations;
  /** OAuth sign-ins in progress. */
  readonly oauthFlows: OAuthFlows;
  /** Every OAuth callback, dispatched by state: the channels' sign-ins and MCP servers' logins. */
  readonly oauthCallbacks: OAuthCallbackRouter;
  /** OAuth tokens: refresh, and sign-out. */
  readonly oauthBroker: OAuthBroker;
  /** A credential reference's value from the owner's secret chain: an MCP server's headers and variables. */
  readonly resolveSecret: (reference: string) => Promise<string | null>;
  /** The supervised MCP servers. */
  readonly mcp: McpHost;
  readonly store: DatabaseClient;
  readonly routines: RoutineService;
  readonly routineControl: RoutineControlService;
  readonly routineEvaluation: RoutineEvaluationService;
  readonly routineRuns: RoutineExecutionService;
  readonly routineNews: RoutineNewsService;
  readonly routinePublication: RoutinePublicationService;
  readonly routineDelivery: RoutineDeliveryService;
  /**
   * The composed routine workflow, exposed as a reference handle (and the type
   * production calls it with) rather than as a substitution seam.
   *
   * It is the exact function `routineDispatch` runs, kept on the runtime so a
   * caller can reference what production composes. Reassigning the field cannot
   * redirect a fire: dispatch captures the module-local const, and the
   * four-argument type below does not even carry the adapter's optional observer.
   * The substitution point is `executeRoutinePipeline`'s `workflow` option, which
   * is what the release scenario test passes its own implementation to.
   */
  readonly routineWorkflow: (
    run: import("@tavi/contracts").RoutineRun,
    fence: import("@tavi/contracts").RoutineFence,
    instructions: string,
    capture?: (tool: string, input: unknown, output: unknown, origin?: "plugin") => unknown,
  ) => Promise<import("@tavi/contracts").AdmissionResult>;
  readonly tools: ToolRegistry;
  /**
   * The owner's memory service: the one instance the agent's memory tools
   * propose through and the `memory` command reviews and edits through.
   * Typed as the port: every reader
   * and writer goes through `MemoryServicePort`, never the class.
   */
  readonly memory: MemoryServicePort;
  /**
   * Set when `memory` is an embedder's `memoryOverride`: backup,
   * export and `tavi reset` then cover only Tavi's own tables, and doctor
   * says so.
   */
  readonly memoryOverridden?: true;
  /** `serve --taint-policy`, when set: it overrides every workspace's `security.taint`. */
  readonly taintPolicy?: TaintMode;
  /** The memory providers: the built-in and every running plugin's, and each workspace's choice. */
  readonly memoryProviders: MemoryProviderRegistry;
  /** External providers' own indexes and the removals still pending. */
  readonly memoryProviderSync: MemoryProviderSync;
  /**
   * The workspace's memory settings in effect, read per call so a change reaches the next model call: on or
   * paused, capture, and the limits (with this owner's `maxContextTokens` as
   * the default context budget).
   */
  readonly memorySettings: (workspaceId: string) => Promise<EffectiveMemorySettings>;
  /** Memory cards on direct channels and their buttons: what sends a posted card to its chat's channel. */
  readonly memoryChannelCards: MemoryChannelCards;
  /**
   * Whether a person's reminder may be said in this conversation: the
   * one it was asked in, another of theirs, or a target the operator added
   * for them. The operator's `reminders` command checks it too.
   */
  readonly reminderConversationAllowed: (
    owner: { readonly workspaceId: string; readonly principalId: string; readonly originTaskId?: string | undefined },
    connectionId: string,
    conversationId: string,
  ) => Promise<boolean>;
  /** Notices posted into chats: a run's result into Home, settles, "Earlier chats". */
  readonly chatNotices: ChatNotices;
  /** Fresh context: the chat's next message starts a new epoch, whatever its length; kept across a restart. */
  readonly requestFreshContext: (taskId: string) => Promise<void>;
  /**
   * Stop from the browser takeover for a Home, which is never cancelled:
   * the handoffs it (or a worker of it) waits on are withdrawn and it
   * resumes. How many; 0 where no live view is served.
   */
  readonly withdrawHandoffs: (taskId: string, by: string) => Promise<number>;
  /** Connect waits: settled when an account signs in, or by *Not now*. */
  readonly connectWaits: ConnectWaits;
  readonly access: AccessPolicy;
  readonly clock: ReturnType<typeof createClock>;
  /** Runs a slow periodic job on the due-work planner's timer, so an idle owner's timers wake it together. */
  readonly every: RepeatTimer;
  /** Liveness identity of this owner; the IPC endpoint is published under it. */
  readonly ownerSession: string;
  /**
   * Copies an approved browser download or report into `downloads/` or
   * `reports/` in its chat's managed folder.
   * Called where a review approves an artifact; never throws, and copies
   * nothing that is not approved.
   */
  readonly materializeArtifact: MaterializeArtifact;
  /**
   * Each chat's working folder: what `folder` shows and changes, what
   * a run starts a new chat in, resolved once per admission for a turn.
   */
  readonly chatFolders: ChatFolders;
  /** The chats' folders against their budget and the free-space floor: what `folder show` states. */
  readonly folderSpace: FolderSpace;
  /** How the file tools reach a resolved folder (`folderReadScope`): the `folder` command's `files` and `read` reach no further. */
  readonly folderReads: (folder: ChatFolder) => FolderReadScope;
  /**
   * Whether this runtime was composed with an embedding-supplied explicit system
   * prompt, which outranks every workspace setting.
   *
   * No production caller supplies one — the two routine adapters build their own
   * — so this is false everywhere today. It is reported rather than
   * assumed so the settings editor can say when a save would not be what the
   * model actually receives.
   */
  readonly systemPromptExplicit: boolean;
  /** The context budget a workspace's model calls are checked against: its `memory.limits.contextTokens`. */
  readonly contextBudgetTokens: (workspaceId: string) => Promise<number>;
  readonly logger: ReturnType<typeof createLogger>;
  readonly host: PluginHost;
  /**
   * Present only when a model connection is configured; absent closes admission.
   *
   * This is the **wrapped** port (`withRunEvents`), so every admission through it
   * publishes `run.started` and its outcome to `runEventBus`.
   */
  readonly workflow: WorkflowPort | undefined;
  /**
   * Every tool rule in force in a workspace: shipped, this owner's
   * `serve --allow` flags, and the workspace's stored rules — what the gate
   * evaluates, for `tavi permissions` to show.
   */
  readonly toolRulesInForce: (workspaceId: string) => Promise<readonly ToolRule[]>;
  /** Rounds and questions in the conversations tasks came from. */
  readonly channelApprovals: ChannelApprovals;
  /**
   * The per-task event fan-out viewers subscribe to.
   *
   * Exposed so the IPC `subscribe` handler and the TUI's connector can reach it;
   * the port's decorator is what feeds it.
   */
  readonly runEventBus: RunEventBus;
  /** The live browser view's fan-out: what `browser-live` watch, ack and unwatch reach. */
  readonly liveHub: LiveHub;
  /** The browser adapter the browser tools use: what an operator's **Close browser** reaches. */
  readonly browser: BrowserPort;
  /** Whether the browser runs confined, and in what. */
  readonly browserBoundary: () => BrowserBoundary;
  /** Task-keyed abort controllers, owned by the decorator (`abort` signals one). */
  readonly abortRegistry: AbortRegistry;
  /** Admissions in flight through the decorator, so shutdown can drain them. */
  readonly admissions: AdmissionTracker;
  /**
   * The tasks a schedule's fire is deciding right now: an
   * operator's decision is refused for such a task's round while its fire lives.
   * The registry itself, so an owner-side fire (`schedules run-now`) records into
   * the same one the sweep does.
   */
  readonly scheduleFires: InFlightFireRegistry;
  /**
   * Resolve a credential reference through the owner's own chain — the one its
   * runs resolve through — for `models test|discover` over IPC, which probe a
   * connection exactly as a run would reach it. The value goes to the model
   * transport only; no handler returns it.
   */
  readonly readSecret: (credentialRef: string) => Promise<string | null>;
  /** Whether a built-in plugin runs in this owner (disabled ones are left out at start): what setup offers follows it. */
  readonly builtinEnabled: (pluginId: string) => boolean;
  /** The ids of a workspace's active external search instances: setup's search step counts them as ready. */
  readonly externalSearchIds: (workspaceId: string) => readonly string[];
  /** What a request to a model sends: a ChatGPT sign-in's access token, renewed when due. Presence checks use `readSecret`. */
  readonly modelCredential: (credentialRef: string) => Promise<string | null>;
  /** The scheduler's dependencies, as the sweep fires on them; absent without a workflow. */
  readonly scheduleDependencies: ScheduleSchedulerDependencies | undefined;
  /** Whether a schedule is firing, scheduled or by hand (a chat's or the app's "run now"). */
  readonly scheduleFireInFlight: (scheduleId: string) => boolean;
  /** Fire a schedule now, once at a time however many ask: a second while one is in flight is skipped as `overlap`. */
  readonly fireScheduleManually: (schedule: ScheduleRecord) => Promise<ScheduleFireNow>;
  /** The `--fs-root` rule for a schedule's `file-changed` pre-check: the file's real path, or a refusal. */
  readonly precheckFile: (path: string) => string;
  /** The site profiles for a schedule's page or feed pre-check: why they refuse reading its address unattended, or none. */
  readonly precheckSite: (workspaceId: string, url: string) => Promise<string | undefined>;
  /** The rule a schedule's working folder is held to (a chat's primary folder's): its real path, or a refusal. */
  readonly scheduleFolder: (path: string) => string;
  /** Matches the file watchers' watches to the stored schedules now, after a write: a schedule edited, paused or removed stops being watched. */
  readonly scheduleWatchersChanged: () => Promise<void>;
  /** Always present — connectors register regardless of `hasModelTransport`; a connection opens only when `options.telegram` (etc.) is configured. */
  readonly messaging: MessagingServicePort;
  /** A configured messaging connection's name as a person reads it (`Telegram`, `email`); undefined for any other id. */
  readonly channelName?: (connectionId: string) => string | undefined;
  /**
   * The local connections: one per workspace,
   * opened with the runtime, never a destination a model may name. The owner's
   * IPC `run` opens a conversation on its workspace's, and IPC `reply` is its
   * inbound transport.
   */
  readonly localMessaging: LocalMessaging;
  /** The chat grants: `permissions grants` lists them through it, each with its end. */
  readonly chatGrants: ChatGrants;
  /**
   * Non-secret description of where credentials come from.
   *
   * Settings and attached clients use this to disable unsupported writes and to
   * explain which owner holds the binding; it never contains a value.
   */
  readonly secretSource: SecretSourceCapability;
  readonly router: import("@tavi/contracts").RouterPort;
  /** The routing providers bound by running provider plugins. */
  readonly routerProviders: RouterProviderSlot;
  /**
   * The heartbeat: the providers installed, the
   * interval choices this owner offers, and the running host — absent when
   * this composition runs none (anything but `serve`, or `tavi.heartbeat`
   * disabled).
   */
  readonly heartbeat: {
    readonly providers: HeartbeatProviderRegistry;
    readonly signals: HeartbeatSignalRegistry;
    readonly options: HeartbeatOptions;
    readonly host: () => HeartbeatHostHandle | undefined;
    /** What providers published for their panels in Center → Heartbeat. */
    readonly providerStates: HeartbeatProviderStates;
    /** The read-only tools of the loaded plugins, which a person may add to its checks (`extraTools`). */
    toolChoices(): readonly HeartbeatToolChoice[];
    /** *Forget heartbeat history*: its ledger, log, memo, settled tasks and their hook rows. */
    forget(workspaceId: string, principalId: string): Promise<HeartbeatHistoryRemoved>;
  };
  /**
   * Ideas: the providers installed — the built-in
   * one and any approved plugin's — the host that runs them, and the census
   * of what Tavi can do here, which the command also checks ideas against.
   */
  readonly ideas: {
    readonly providers: IdeasProviderRegistry;
    readonly host: IdeasHost;
    census(workspaceId: string): Promise<readonly import("@tavi/contracts").IdeaCapability[]>;
    /** The empty chat's "Continue" chip: the person's newest own chat summarised in the last three days. */
    continueChat(workspaceId: string): Promise<{ readonly taskId: string; readonly title: string } | undefined>;
    /** Whether the operator has an authorized chat on a connection: where the weekly digest may go. */
    digestReachable(workspaceId: string, principalId: string, connectionId: string): Promise<boolean>;
  };
  /**
   * Onboarding: the flows installed —
   * the built-in one and any approved plugin's — and the credential revision
   * a verification is keyed to, never the secret.
   */
  readonly onboarding: {
    readonly providers: OnboardingProviderRegistry;
    credentialRevision(reference: string): Promise<string>;
    /** Real turns' verifications. */
    readonly turns: OnboardingTurnRecorder;
    /** One verify in flight per workspace and role. */
    readonly verifyGate: OnboardingVerifyGate;
    /** The canvas's OpenRouter sign-ins, owned in the OAuth callback router. */
    readonly signIns: OpenRouterSignIns;
    /** The canvas's ChatGPT sign-ins, each on a loopback of its own. */
    readonly chatGptSignIns: ChatGptSignIns;
    /** The ChatGPT sign-in kept now, whose account a new one renews. */
    keptChatGpt(): Promise<ChatGptCredential | undefined>;
  };
  readonly routerRepository: RouterRepository;
  readonly taskRouting: import("@tavi/contracts").TaskRoutingPort;
  /** Which chats are local, and the local models they go on with: a local chat's words stay off remote models. */
  readonly localChats: import("../features/models/local-chats.js").LocalChatModels;
  readonly modelAccounting: ModelAccounting;
  /** The `embedding` model role: its target and locality, and one metered call on it. */
  readonly embeddings: EmbeddingRoleService;
  /** Hybrid turn and tool recall's times, for doctor's p95 (in-process). */
  readonly memoryRecallTimes: MemoryRecallTimes;
  /** The memory host's background jobs on demand (`tavi memory reindex`, `review-now`, `consolidate-now`); `UNAVAILABLE` without the host. */
  readonly memoryJobs: MemoryJobsNow;
  /** Prune the memory vectors no workspace may keep, host or no host: a settings write's opt-out. */
  pruneMemoryVectors(): Promise<number>;
  /** Number of LangGraph checkpoints recorded for this data directory. */
  checkpointCount(): Promise<number>;
  /** The plugin registry and each plugin's phase in this runtime. */
  readonly plugins: PluginLiveStatus & { readonly registry: PluginRegistry };
  /** Plugins' hooks into the turn. */
  readonly turnHooks: TurnHookRegistry;
  /**
   * Release every owned resource.
   *
   * Returns the host's own report rather than discarding it: a caller that is
   * deciding an exit code must be able to tell a clean drain from one that timed
   * out or left a disposer failed: a timeout elapsing does not make
   * a cleanup successful.
   */
  close(): Promise<ShutdownReport>;
}

export interface TaviRuntimeOverrides {
  /** A pre-built store lets tests use a disposable in-memory data directory. */
  readonly store?: DatabaseClient;
  /** Pre-acquired ownership, for a caller that already holds the directory. */
  readonly ownership?: DataDirectoryOwner;
  /**
   * The OS keychain a new data directory's credential key goes to: tests inject
   * an in-memory one, or `null` for none. By default the system's
   * (`systemCredentialKeychain`), which `TAVI_CREDENTIAL_KEYCHAIN=off` turns off.
   */
  readonly credentialKeychain?: CredentialKeychain | null;
  /**
   * When false, a missing model connection is tolerated and the workflow plugin
   * is omitted from the composition instead of failing startup. `doctor` uses
   * this to validate composition without credentials.
   */
  readonly requireModelTransport?: boolean;
  /** Doctor can inspect incompatible checkpoint tables without opening a workflow. */
  readonly inspectCheckpoints?: boolean;
  /**
   * In-process fixture transport. With no configured connections its binding
   * has an explicit in-process endpoint. Network adapters use configured
   * connections or an approved provider factory with declared endpoint identity.
   */
  readonly modelOverride?: ModelPort;
  /** Where a connection's single-use approval links open, in place of the Mailgun public URL: a test's stand-in. */
  readonly approvalLinkBase?: (connectionId: string) => string | undefined;
  /** Tests: which connections are email (subject tokens, reply-only grammar); by default the Mailgun connection. */
  readonly approvalEmailConnection?: (connectionId: string) => boolean;
  /** How often a routine run waiting on a checkpoint question checks on it (tests shorten it). */
  readonly routineCheckpointPollMs?: number;
  /**
   * The heartbeat host's sweep and interval floor: tests only, never a
   * flag, an environment variable or a setting. A lower floor adds test
   * choices to `heartbeat.options` (`heartbeatOptionsFor`). Defaults: a 30 s
   * sweep (a busy Home's one wait; the planner sweeps when a check falls due,
   * behind a ten-minute timer, where a set `sweepMs` is also the timer) and the
   * 15 min floor. A set `needPollMs` reads needs at that pace whether or not
   * anything was written.
   */
  readonly heartbeatTiming?: {
    readonly sweepMs?: number;
    readonly intervalFloorMs?: number;
    readonly eventDebounceMs?: number;
    readonly needPollMs?: number;
  };
  /**
   * The `tavi.memory` host's tick and the clock its jobs read, the
   * memory providers' upkeep pass (the same period) and their sync deadline:
   * tests only, never a flag, an environment variable or a setting.
   * Defaults: a 60 s tick, the owner's clock and `MEMORY_PROVIDER_LIMITS.syncMs`.
   * The default tick and pass are skipped while nothing was written, for up to
   * five minutes; a set `tickMs` runs every time.
   */
  readonly memoryTiming?: { readonly tickMs?: number; readonly now?: () => Date; readonly syncMs?: number };
  /** The watched-pages source's fetch: a test's stub, never the network. */
  readonly heartbeatFetchPage?: (
    url: string,
    allowedHosts: readonly string[],
    signal: AbortSignal,
  ) => Promise<{ readonly status: number; readonly text: string }>;
  /** Substitute transport for the web search adapters: a test's stub, never the network. */
  readonly searchFetch?: typeof globalThis.fetch;
  readonly routerFetch?: typeof globalThis.fetch;
  /**
   * The `fetch` each builtin channel calls its provider with, by provider
   * id. Mirrors `modelOverride` — tests drive `composeTaviRuntime` end to end
   * against a fake provider, one seam for every channel.
   */
  readonly channelFetch?: Readonly<Record<string, typeof globalThis.fetch>>;
  /** The room policy's flood buckets: a suite that sends many messages in a minute raises them. */
  readonly messagingFloodLimits?: FloodLimits;
  /** The `fetch` OAuth sign-ins exchange codes with: a fake provider in tests. */
  readonly oauthFetchOverride?: typeof globalThis.fetch;
  /**
   * Substitute `SandboxPort`/`BrowserPort` implementations.
   *
   * Mirrors `modelOverride`/`channelFetch` — tests drive
   * `composeTaviRuntime` end-to-end against a fixture instead of the real
   * `@anthropic-ai/sandbox-runtime`/Playwright adapters, which would
   * otherwise attempt a real sandboxed process launch / real Chromium
   * launch on every test run. The concrete `createOwnerSandbox()`/
   * `createPlaywrightBrowser()` adapters (below) remain the default.
   */
  readonly sandboxOverride?: SandboxPort;
  /** Substitute `ConfinementPort`: what MCP stdio servers and the PDF engine's children are wrapped in. */
  readonly confinementOverride?: ConfinementPort;
  /** Substitute `SandboxHostPort`: the host's sandbox tier, its cause and fix. */
  readonly sandboxHostOverride?: SandboxHostPort;
  /** Substitute `ResourceLimitPort`. */
  readonly limitsOverride?: ResourceLimitPort;
  /** Substitute `PluginIsolationPort`: where plugins approved as workers run. */
  readonly pluginIsolationOverride?: PluginIsolationPort;
  readonly browserOverride?: BrowserPort;
  /**
   * The live browser view's producer: with
   * `browserOverride`, the one that adapter reports to (the fixture's
   * `live` option), so a test can watch it.
   */
  readonly liveOverride?: BrowserLiveSource;
  /**
   * The owner serves the live view (`tavi serve`): a person can take the
   * agent's browser over in the canvas, so `browser.request_handoff` is
   * offered. An in-process run has nobody to hand it to.
   */
  readonly liveViewServed?: boolean;
  /** Substitute the HTML → PDF renderer. */
  readonly renderOverride?: RenderPort;
  /** Substitute the PDF engine: any `PdfEnginePort`, in place of `@tavi/plugin-pdf`. */
  readonly pdfOverride?: PdfEnginePort;
  /** The video decoder in place of the person's FFmpeg (tests): the tools see only `VideoDecoderPort`. */
  readonly videoDecoderOverride?: VideoDecoderPort;
  /** The video analysers in place of `analyzers.json`'s (tests): the tools see only `VideoAnalyzerRegistry`. */
  readonly videoAnalyzersOverride?: VideoAnalyzerRegistry;
  /** The channels' webhook ingress listener: a test's fake server, never a real port. */
  readonly ingressCreateServerOverride?: (requestListener: RequestListener) => Server;
  /**
   * An embedder's whole memory service in place of the built-in:
   * programmatic only, never a
   * flag or a plugin. It must declare it passes `@tavi/plugin-kit/memory`'s port
   * suite (`conformance: MEMORY_PORT_CONFORMANCE`), or the owner refuses to
   * start. Its records live outside Tavi's tables, so backup, export and
   * `tavi reset` do not cover them, and hybrid recall is the override's own.
   */
  readonly memoryOverride?: MemoryOverride;
}
