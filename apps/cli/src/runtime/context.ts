import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  InboundEvent,
  MemoryActor,
  ModelTarget,
  PdfEnginePort,
  ResourceScope,
  RoutineFence,
  RoutineRun,
  VideoDecoderPort,
  WorkflowPort,
} from "@tavi/contracts";
import type {
  AccessPolicy,
  ChatFolders,
  DatabaseClient,
  DataDirectoryOwner,
  MessageTaken,
  PluginRegistry,
  ProviderExecutionOptions,
  PublicFetchOptions,
  createChainedSecretStore,
  createMessagingService,
  createRunEventBus,
} from "@tavi/runtime";
import type { createAgentCommunicationService } from "@tavi/agent-host/agent-communication";
import type { HeartbeatHostHandle } from "@tavi/agent-host/heartbeat-host";
import type { ScheduleSchedulerDependencies } from "@tavi/agent-host/schedule-scheduler";
import type { ConnectWaits } from "../features/apps/connect-waits.js";
import type { createChannelApprovals } from "../features/approvals/channel-approvals.js";
import type { createHeartbeatButtons } from "../features/heartbeat/buttons.js";
import type { HeartbeatEvents } from "../features/heartbeat/events.js";
import type { createMemoryChannelCards } from "../features/memory/channel-cards.js";
import type { DevPluginLoad } from "../features/plugins/dev.js";
import type { createReminderButtons, operatorTargetsOf } from "../features/reminders/delivery.js";
import type { RoutineNotices } from "../features/routines/notices.js";
import type { ScheduleWebhookIds } from "../features/schedules/webhook.js";
import type { TaviRuntimeOptions, TaviRuntimeOverrides } from "./types.js";

/** What every part of the composition starts from: what `buildRuntime` was given, and the late bindings. */
export interface CompositionBase {
  readonly store: DatabaseClient;
  readonly options: TaviRuntimeOptions;
  readonly overrides: TaviRuntimeOverrides;
  readonly ownership: DataDirectoryOwner | undefined;
  readonly ownershipSessionId: string;
  readonly late: LateBindings;
}

/**
 * What a part of the composition reads from a part composed after it, and what
 * one part sets that another reads: the composition is one graph built in
 * order, and these are its edges that point forward. Each is read when a
 * closure runs, never while composing, so it is set by the time it is read.
 */
export interface LateBindings {
  /** The built-in fetch provider for a policy, resolved per call once the providers are composed. */
  builtinFetchResolver: PublicFetchOptions["provider"];
  /** The metered execution the built-in fetch provider runs under, once the model accounting exists. */
  fetchExecution: ProviderExecutionOptions | undefined;
  /** A due routine run, dispatched into its pipeline once that is composed. */
  routineDispatch: ((run: RoutineRun, fence: RoutineFence) => Promise<void>) | undefined;
  /** A routine's pause and expiry notices, once the chat notices and messaging they go through are composed. */
  routineNotices: RoutineNotices | undefined;
  persistencePort: ReturnType<DatabaseClient["asPort"]>;
  /** The plugins withdrawn since they loaded. */
  withdrawnPlugins: () => ReadonlySet<string>;
  access: AccessPolicy;
  /** Withdraws a running external plugin (or one version of it), once the external plugins are loaded. */
  withdrawExternal: (id: string, version?: string) => Promise<string | undefined>;
  /**
   * The built-in plugins that are withdrawn at once when disabled, by id, while they run: a mod's hooks
   * (`tavi.guard`) leave the turn without a restart. Any other built-in takes a disable at the next start.
   */
  liveBuiltinWithdrawals: Map<string, () => void>;
  /** Releases the built-in channels named from composition: for a composition that fails before its owner runs. */
  releaseBuiltinChannels?: () => void;
  builtinPluginIds: Set<string>;
  devPluginIds: Set<string>;
  resolvedPlugins: (Awaited<ReturnType<PluginRegistry["resolveEnabled"]>>[number] | DevPluginLoad)[];
  /** What routines read of the live model configuration. */
  liveRoutineModels: { readonly target?: ModelTarget; readonly connectionIds: ReadonlySet<string> };
  secrets: ReturnType<typeof createChainedSecretStore>;
  /** The scope the built-in fetch provider's instances live in, while the provider is active. */
  builtinFetchScope: ResourceScope | undefined;
  /**
   * The real admission implementation needs `workflow` (constructed after
   * `messaging` — the same "genuine construction cycle" shape `agentsService`'s
   * own getter already exists to break; see that comment). `messagingAdmitImpl`
   * is assigned once `workflow` exists; until then — or permanently, when
   * `hasModelTransport` is false — `admit` no-ops, matching
   * `MessagingServiceOptions.admit`'s own documented "unset = no-op"
   * default. No messaging connection is opened, and therefore no inbound
   * event can ever be ingested, before the composition returns, so the
   * assignment always lands before it could matter.
   */
  messagingAdmitImpl: ((input: { readonly event: InboundEvent; readonly actor: MemoryActor }) => Promise<void>) | undefined;
  /** The withdrawals a `/new` never finished (an owner stopped after `reset`), run at start; set with the admission. */
  withdrawUnfinishedResets: (() => Promise<void>) | undefined;
  connectWaitsRef: { current?: ConnectWaits };
  messaging: ReturnType<typeof createMessagingService>;
  ingress: ChannelIngress;
  /** The PDF engine, started on its first use. */
  pdfService: PdfEnginePort | undefined;
  /** The video decoder, started on its first use. */
  videoDecoder: Promise<VideoDecoderPort> | undefined;
  /** Desktop control's helper process, while `tavi.desktop` is enabled. */
  desktopBridge: { dispose(): Promise<void> } | undefined;
  chatFolders: ChatFolders;
  /** The heartbeat host while it runs. */
  heartbeatHost: HeartbeatHostHandle | undefined;
  /** What wakes the heartbeat between checks, while its host runs. */
  heartbeatEvents: HeartbeatEvents | undefined;
  /**
   * `createAgentCommunicationService` needs the already-built `WorkflowPort`
   * (to admit spawn/wake/deadline-resume transitions), while
   * `createWorkflowAdapter` needs the agent-communication service (for
   * `toolsNode`'s `agents.wait` dispatch) — a genuine construction cycle.
   * Broken with a getter reading this binding, assigned right after
   * `agents` is built; nothing calls `workflow.admit` before the composition
   * returns, so the getter always resolves by the time it matters
   * (see `WorkflowAdapterOptions.agents`'s own doc comment).
   */
  agentsService: ReturnType<typeof createAgentCommunicationService> | undefined;
  runEventBus: ReturnType<typeof createRunEventBus>;
  /**
   * Rounds announced to, and decided from, the conversation a task came from.
   * The workflow is late-bound: it is built with these hooks.
   */
  workflowForChannels: WorkflowPort | undefined;
  channelApprovals: ReturnType<typeof createChannelApprovals>;
  reminderButtons: ReturnType<typeof createReminderButtons>;
  heartbeatButtons: ReturnType<typeof createHeartbeatButtons>;
  memoryChannelCards: ReturnType<typeof createMemoryChannelCards>;
  workflow: WorkflowPort | undefined;
  reminderTargets: ReminderTargets;
  scheduleDependencies: ScheduleSchedulerDependencies | undefined;
  /** Answers a call to a schedule's webhook ahead of the channels (true), once the schedules are composed. */
  scheduleWebhooks: ((req: IncomingMessage, res: ServerResponse, pathPrefix?: string) => Promise<boolean>) | undefined;
  /** The schedules whose webhook is on, which the ingress reloads whenever it is applied; once the schedules are composed. */
  scheduleWebhookIds: ScheduleWebhookIds | undefined;
  /** Offered each new inbound message once the schedules are composed: what fires the schedules whose email trigger took it. */
  scheduleEmailTriggers: ((event: InboundEvent) => Promise<MessageTaken | undefined>) | undefined;
}

/** The channels' public listener, opened while something receives or a sign-in waits. */
interface ChannelIngress {
  /** The public address in effect, for approval links. */
  readonly publicUrl: () => string | undefined;
  /** The public address the settings name now, whether or not the listener is up. */
  readonly configuredPublicUrl: () => Promise<string | undefined>;
  readonly close: () => Promise<void>;
  /** Listens if a receiving connection is open, where the settings say; closes if none is. */
  readonly ensure: () => Promise<void>;
}

/** Where a reminder or a notice reaches the operator. */
interface ReminderTargets {
  readonly repositories: ReturnType<DatabaseClient["asPort"]>["repositories"];
  readonly operatorTargets: (workspaceId: string, principalId: string) => Promise<ReturnType<typeof operatorTargetsOf>>;
  readonly isLocalConnection: (connectionId: string) => boolean;
}
