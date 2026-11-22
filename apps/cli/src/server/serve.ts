import { emitJson } from "../cli/output.js";
import {
  routerCommand,
  routerProviderCandidate,
  routerProviderPricing,
  routerProviderState,
  runningProviderReadiness,
} from "../features/router/owner.js";
import type {
  AppsCatalogAnswer,
  ConnectableApp,
  ResetInstanceResult,
  ModEnvelope,
  PluginCommandsAnswer,
  SandboxStatus,
} from "@tavi/contracts";
import { MOD_COMMAND_TEXT_MAX_CHARS, maskPluginText } from "@tavi/contracts";
import { channelsCommand } from "../features/channels/owner.js";
import { runtimeLifecycleReport, startLifecycleSync, syncRuntimeModelLifecycle } from "../features/models/lifecycle-sync.js";
import { previewReplace, replaceModel } from "../features/models/replace.js";
import { uiPreferencesCommand } from "../features/ui/preferences.js";
import { permissionsCommand } from "../features/permissions/owner.js";
import { browserLiveCommand } from "../features/browser/live-owner.js";
import { readAgentTree, workerActivity } from "../features/agents/tree.js";
import { artifactsReadCommand, browserCommand, type BrowserDependencies } from "../features/browser/owner.js";
import { SITE_NOTES_DIRECTORY } from "../features/browser/site-notes.js";
import { chatContextCommand } from "../features/tasks/history-owner.js";
import { FolderPicks, browseCommand, folderCommand } from "../features/folders/owner.js";
import { AttachmentUploads, artifactsUploadCommand } from "../features/artifacts/upload-owner.js";
import { plainCredentialStoreWarning } from "../features/credentials/store.js";
import { weakerSandboxServersOf } from "../features/mcp/sandbox-nudge.js";
import { SkillService, measureFolder, SERVE_SESSION_PREFIX } from "@tavi/runtime";
import { centerCommand } from "./center.js";
import { createHealthWatch, type HealthWatch } from "../features/doctor/health.js";
import { memoryCommand, workspaceZoneOf } from "../features/memory/owner.js";
import { skillsOwnerCommand, storeTaskTools } from "../features/skills/owner.js";
import { memoryUnreachedNote } from "../features/memory/channel-cards.js";
import { remindersCommand } from "../features/reminders/owner.js";
import { heartbeatCommand, heartbeatItemSeed } from "../features/heartbeat/owner.js";
import { ideaChatSeeded, ideaPreparedAnswer, ideasCommand, ideasProviderViews } from "../features/ideas/owner.js";
import { appsSignalsSource, heartbeatOfferInstructions } from "../features/heartbeat/sources.js";
import { appRepairList } from "../features/apps/registry.js";
import { keptByAccount } from "../features/apps/shared-grants.js";
import { registerAppsTools } from "../features/apps/tool.js";
import { registerMailboxTools, type MailboxToolsHandle } from "../features/apps/mailbox-tools.js";
import { registerCalendarTools, type CalendarToolsHandle } from "../features/apps/calendar-tools.js";
import {
  APPS_CALENDAR_SETTING,
  APPS_MAILBOX_SETTING,
  APPS_SHARING_SETTING,
  parseCalendar,
  parseMailbox,
  parseSharing,
  sharingOf,
} from "../features/apps/sharing.js";
import { routineAction, routineFromChat } from "../features/routines/actions.js";
import type { RoutinesPayload } from "@tavi/contracts";
import { chmodSync, lstatSync, rmSync, statSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";

import {
  ARTIFACT_STAGING_DIRECTORY,
  IPC_NOT_RUNNING,
  homeChatOn,
  pdfToolsOn,
  videoToolsOn,
  IPC_PROTOCOL_VERSION,
  CHECKPOINTS_KEPT,
  TRANSCRIPT_PAGE_DEFAULT,
  NOTICES_LIST_DEFAULT,
  TaviError,
  type ChannelMailboxKit,
  parseCommandPayload,
  DEFAULT_WORKSPACE_ID,
  APPROVAL_HISTORY_DEFAULT_LIMIT,
  type ApprovalsListResult,
  type ApprovalsShowResult,
  approvalCallsOf,
  toolResultRedactionOn,
  type ScheduleRecord,
  type IpcCommand,
  type IpcParsedPayload,
  type SubscribeResult,
  type TaskLabelAnswer,
} from "@tavi/contracts";
import { definedOnly, errorMessage, isRecord, nowTimestamp } from "@tavi/contracts/util";
import { isPipeEndpoint, newPipeEndpoint, prefixedId, protectPipe } from "@tavi/node-kit";
import {
  type IpcConnection,
  type RunEventSubscription,
  clearToken,
  createIpcServer,
  ipcPaths,
  mintToken,
  publishDiscovery,
  clearDiscovery,
  clearStopping,
  markStopping,
  type IpcServer,
} from "@tavi/runtime";

import { composeTaviRuntime } from "../runtime/composition.js";
import { lastingChat } from "../runtime/chat-scope.js";
import type { TaviRuntime, TaviRuntimeOptions, TaviRuntimeOverrides } from "../runtime/types.js";
import { decideRound, type DecideRoundDependencies } from "../features/approvals/owner.js";
import { approvalListRowOf, listNeeds, withChannels } from "../features/approvals/inbox.js";
import { answerNeed } from "../features/approvals/needs-answer.js";
import { reviewRound } from "../features/artifacts/review-owner.js";
import {
  createAnsweringRuns,
  startRun,
  type AnsweringRuns,
  type OwnerModelTarget,
  type ReservedSubscription,
} from "../features/run/owner.js";
import { SIDE_CHAT_SEED_TURNS, buildSideChatSeed, sideChatSeedLabel } from "./side-chat-seed.js";
import { bindSender, replyToConversation } from "./reply.js";
import {
  agentsCommand,
  liveTarget,
  credentialsCommand,
  modelsCommand,
  projectsCommand,
  reportsCommand,
  schedulesCommand,
  searchCommand,
  pluginsCommand,
  mcpCommand,
  channelsPageDetails,
  appsOwnerCommand,
  operatorActor,
  systemPromptCommand,
  type ConfigDependencies,
  type ScheduleRunAnswer,
  setGrantKeptBy,
} from "./config-commands.js";
import { workspaceSettingsCommand } from "./workspace-settings-commands.js";
import { recordCancellation, terminateExecution } from "../features/tasks/mutations.js";
import {
  buildDoctorDocument,
  videoStatusDocument,
  buildTaskDocument,
  buildTaskShowDocument,
  taskContextLabel,
  weakTaintWorkspaces,
  strandedAdmissions,
  strandedTurnWarnings,
} from "../features/doctor/reports.js";
import { MIN_FREE_BYTES_FOR_A_FIRE, releaseEndedHolds } from "@tavi/agent-host/schedule-scheduler";
import { freeBytesAt } from "../shared/disk.js";
import { refusalFrom, refuseKeyed, type IpcRefusal } from "../shared/ipc-decisions.js";
import type { CliIo } from "../cli/io.js";
import { onboardingCommand, type OnboardingCommandDependencies } from "../features/onboard/owner.js";
import { ownerOnboardingDependencies } from "../features/onboard/owner-dependencies.js";
import { calendarKitOf, channelDescriptors, channelGrantsOf, mailboxKitOf } from "../features/channels/catalog.js";

// Kept importable from here: it moved to a module of its own so attached commands need not load this one.
export { findLiveOwner } from "../cli/live-owner.js";

/**
 * `tavi serve`: own the runtime and expose it to attachable clients.
 *
 * The process takes exclusive ownership of the data directory first, then mints
 * a fresh cookie and publishes discovery. That order is what makes "a second
 * launcher must not rotate a live owner's token" true: a second launcher cannot
 * acquire ownership, and the credential layer refuses to publish without it.
 *
 * SIGTERM closes admission, drains under a deadline and releases every resource;
 * the service manager owns restart and backoff, so this never supervises itself.
 */
export interface ServeOptions {
  readonly dataDirectory: string;
  readonly drainDeadlineMs: number;
  /**
   * The model target the owner resolved at startup, and whether configuration
   * named it — what each command resolves the live target
   * from (`liveTarget`). With nothing configured `tavi serve` composes
   * against placeholders, with no provider behind them, and `run` answers
   * `NOT_CONFIGURED` until a default resolves instead of failing inside the
   * model call; the first model added over IPC is served from the next turn,
   * with no restart. Absent means the runtime
   * options' own target, fixed as flags are.
   */
  readonly modelTarget?: OwnerModelTarget;
  /**
   * An embedder's memory service in place of the built-in:
   * programmatic `serve()` only, never `tavi serve`. Refused at start unless
   * it declares `@tavi/plugin-kit/memory`'s port suite (`TaviRuntimeOverrides`).
   */
  readonly memoryOverride?: TaviRuntimeOverrides["memoryOverride"];
}

/**
 * What a test may substitute in an owner — never passed by `tavi serve`.
 *
 * Kept off `ServeOptions` so no production caller can swap a live owner's model
 * transport: it exists so the IPC surface can be exercised end to end against a
 * scripted model, exactly as `composeTaviRuntime`'s own tests are.
 */
export interface ServeTestingOverrides {
  readonly modelOverride?: TaviRuntimeOverrides["modelOverride"];
  readonly browserOverride?: TaviRuntimeOverrides["browserOverride"];
  readonly sandboxOverride?: TaviRuntimeOverrides["sandboxOverride"];
  readonly liveOverride?: TaviRuntimeOverrides["liveOverride"];
  readonly channelFetch?: TaviRuntimeOverrides["channelFetch"];
  readonly oauthFetchOverride?: TaviRuntimeOverrides["oauthFetchOverride"];
  /** The heartbeat host's sweep and interval floor, so a test ticks in seconds. */
  readonly heartbeatTiming?: TaviRuntimeOverrides["heartbeatTiming"];
  /** The `tavi.memory` host's tick and its jobs' clock, so a test's digest is due when it says. */
  readonly memoryTiming?: TaviRuntimeOverrides["memoryTiming"];
}

/**
 * What the app may still do with a routine whose owner is no longer allowed in
 * the workspace: look at it, archive it, and withdraw from it — never run,
 * resume or change it.
 */
const REVOKED_OWNER_ROUTINE_ACTIONS: ReadonlySet<string> = new Set([
  "get",
  "revisions",
  "history",
  "inspect",
  "explain",
  "targets",
  "sources",
  "detail",
  "ledger",
  "artifact",
  "readiness",
  "answers",
  "checkpoints",
  "archive",
  "cancel",
  "revoke_grant",
  "forget_answer",
]);

/** The `channels` actions that change who is allowed in a workspace. */
const PEOPLE_ACTIONS: ReadonlySet<string> = new Set(["allow", "revoke", "confirm-pair", "delete"]);
/** The `models` actions that change nothing a turn, a routine or a reminder reads; every other one refreshes the providers. */
const MODELS_READS: ReadonlySet<string> = new Set([
  "list",
  "show",
  "roles",
  "chat",
  "video-status",
  "voice-status",
  "voice-setup",
  "sync",
  "lifecycle",
]);
/** How long cut-off admissions get to publish their ends after being aborted. */
const ABORT_GRACE_MS = 1_000;
/** How far back serve start looks for a chat turn its history lost; an older gap is saved by the chat's next turn. */
const TRANSCRIPT_RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
/** How many chats serve start saves lost turns of; the rest are saved by their next turn. */
const TRANSCRIPT_RECONCILE_CHATS = 200;

/** How a shutdown ended; the owner's exit code is derived from this. */
export interface ShutdownOutcome {
  readonly clean: boolean;
  readonly reason: string;
  /** The shutdown was a `reset-instance`: the caller deletes the directory's state and serves again. */
  readonly reset?: true;
}

export interface ServeHandle {
  readonly runtime: TaviRuntime;
  readonly server: IpcServer;
  /**
   * Resolves when a shutdown has completed, for tests and for signal handling.
   *
   * Carries the outcome because the exit code must distinguish a clean drain from
   * one that timed out or failed.
   */
  readonly stopped: Promise<ShutdownOutcome>;
  /**
   * Idempotent: concurrent callers share one shutdown and one outcome.
   * `deadlineMs` shortens the drain deadline for this stop (never lengthens it).
   */
  shutdown(reason: string, deadlineMs?: number): Promise<void>;
}

export async function serve(
  runtimeOptions: TaviRuntimeOptions,
  options: ServeOptions,
  io: CliIo,
  testing?: ServeTestingOverrides,
): Promise<ServeHandle> {
  // No platform may serve attachment on an endpoint not proven private. The
  // Windows named pipe is given its access list below, but the two-user proof
  // (another account cannot open, squat or read it) has not yet run in CI, so
  // serving is refused there until it has. Refused before ownership is taken,
  // so nothing has to be released.
  if (process.platform === "win32") {
    throw new TaviError(
      "UNAVAILABLE",
      "tavi serve is not available on Windows yet: the named pipe's access list is not yet " +
        "proven against a second account, and the bearer cookie is never released on an " +
        "unproven endpoint. Use a single foreground command, or run the owner under WSL2.",
    );
  }

  // Ownership is acquired by composition, before any credential is minted.
  // Named as serve's, so a command run while it starts waits for it to answer (`findLiveOwner`).
  const runtime = await composeTaviRuntime(
    { ...runtimeOptions, ownerSession: runtimeOptions.ownerSession ?? prefixedId(`${SERVE_SESSION_PREFIX}${process.pid}`) },
    {
      requireModelTransport: false,
      // `tavi ui` shows the live view, where a person can take the browser over.
      liveViewServed: true,
      ...(testing?.modelOverride === undefined ? {} : { modelOverride: testing.modelOverride }),
      ...(testing?.browserOverride === undefined ? {} : { browserOverride: testing.browserOverride }),
      ...(testing?.sandboxOverride === undefined ? {} : { sandboxOverride: testing.sandboxOverride }),
      ...(testing?.liveOverride === undefined ? {} : { liveOverride: testing.liveOverride }),
      ...(testing?.channelFetch === undefined ? {} : { channelFetch: testing.channelFetch }),
      ...(testing?.oauthFetchOverride === undefined ? {} : { oauthFetchOverride: testing.oauthFetchOverride }),
      ...(testing?.heartbeatTiming === undefined ? {} : { heartbeatTiming: testing.heartbeatTiming }),
      ...(testing?.memoryTiming === undefined ? {} : { memoryTiming: testing.memoryTiming }),
      ...(options.memoryOverride === undefined ? {} : { memoryOverride: options.memoryOverride }),
    },
  );

  // SQLite's own verdict on the file, once, at startup. `quick` rather
  // than `full` because this runs on every boot and both read every page; a
  // problem is reported at error level rather than refusing to start, because a
  // daemon that can still serve is better than one that exits and takes the
  // scheduler with it — `doctor` is where the operator acts on it.
  // Free disk space, said at startup, while there is still room to act on it.
  const freeBytes = freeBytesAt(options.dataDirectory);
  if (freeBytes !== undefined && freeBytes < MIN_FREE_BYTES_FOR_A_FIRE) {
    runtime.logger.error("the data directory's filesystem is nearly full; fires will refuse until space is freed", {
      freeBytes,
      floor: MIN_FREE_BYTES_FOR_A_FIRE,
    });
  }

  const integrity = await runtime.store.integrityCheck("quick");
  if (!integrity.ok) {
    runtime.logger.error("the database failed SQLite's integrity check", {
      problems: integrity.problems.slice(0, 10),
      problemCount: integrity.problems.length,
      advice: "run `tavi doctor`, then restore a snapshot (`tavi backup` writes one)",
    });
  }

  // Uploads under way died with the last owner: their staged pieces go.
  try {
    rmSync(join(options.dataDirectory, "artifacts", ARTIFACT_STAGING_DIRECTORY), { recursive: true, force: true });
  } catch (error) {
    // Never a reason not to start: what is left is cleared at the next start, or by hand.
    runtime.logger.warn("the artifact staging directory could not be cleared", { error: errorMessage(error) });
  }

  // The mailbox channels' tools: each account's by its own opt-in, signed in through the broker.
  const mailboxTools: MailboxToolsHandle[] = [];
  for (const descriptor of channelDescriptors()) {
    // A mailbox only of a channel granted one: a built-in's, or a reviewed plugin's that registered its kit.
    const kit = mailboxKitOf(descriptor.providerId);
    if (channelGrantsOf(descriptor.providerId)?.mailbox !== true || kit === undefined) continue;
    // The kit registered now, read at each call: a plugin restarted (or updated) registers a new one, which its
    // tools then use; none while it is stopped. Only its search bounds, read for the tools' words, are the first's.
    const current = (): ChannelMailboxKit<typeof globalThis.fetch> => {
      const now = mailboxKitOf(descriptor.providerId);
      if (now === undefined) throw new TaviError("UNAVAILABLE", `${descriptor.label}'s mailbox is not running`);
      return now;
    };
    const live: ChannelMailboxKit<typeof globalThis.fetch> = {
      searchMax: kit.searchMax,
      searchHint: kit.searchHint,
      open: (options) => current().open(options),
      recipientOf: (value) => current().recipientOf(value),
    };
    mailboxTools.push(
      registerMailboxTools(runtime.tools, {
        channel: { providerId: descriptor.providerId, label: descriptor.label, kit: live },
        // None while no kit is granted now (its plugin stopped): its tools then offer nothing.
        connections: async () =>
          mailboxKitOf(descriptor.providerId) !== undefined && channelGrantsOf(descriptor.providerId)?.mailbox === true
            ? (await runtime.store.asPort().repositories.messagingConnections.list()).filter(
                (record) => record.providerId === descriptor.providerId,
              )
            : [],
        mailbox: async () => parseMailbox(await runtime.store.getMeta(APPS_MAILBOX_SETTING)),
        personal: async (connectionId) =>
          sharingOf(parseSharing(await runtime.store.getMeta(APPS_SHARING_SETTING)), connectionId, "personal") === "personal",
        operatorOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
        accessToken: (connection) => runtime.oauthBroker.accessToken(connection),
        log: (message, fields) => runtime.logger.error(message, fields),
      }),
    );
  }
  // The calendars of the accounts that carry one: each by its own opt-in, signed in through the broker.
  const calendarTools: CalendarToolsHandle[] = [];
  for (const descriptor of channelDescriptors()) {
    const kit = calendarKitOf(descriptor.providerId);
    if (channelGrantsOf(descriptor.providerId)?.calendar !== true || kit === undefined) continue;
    calendarTools.push(
      registerCalendarTools(runtime.tools, {
        channel: { providerId: descriptor.providerId, label: descriptor.app?.name ?? descriptor.label, kit },
        connections: async () =>
          (await runtime.store.asPort().repositories.messagingConnections.list()).filter(
            (record) => record.providerId === descriptor.providerId,
          ),
        calendarOn: async () => parseCalendar(await runtime.store.getMeta(APPS_CALENDAR_SETTING)),
        personal: async (connectionId) =>
          sharingOf(parseSharing(await runtime.store.getMeta(APPS_SHARING_SETTING)), connectionId, "personal") === "personal",
        operatorOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
        accessToken: (connection) => runtime.oauthBroker.accessToken(connection),
        log: (message, fields) => runtime.logger.error(message, fields),
      }),
    );
  }
  ACCOUNT_TOOLS.set(runtime, [...mailboxTools, ...calendarTools]);
  // Who else keeps a grant, weighed as Connected apps weighs it, for every path that revokes one.
  setGrantKeptBy(runtime, async (accountId) => {
    for (const workspaceId of runtime.access.workspaceIds()) {
      const apps = await appsOfWorkspace(runtime, workspaceId);
      if (apps === undefined) throw new TaviError("UNAVAILABLE", "the apps signed in with this account could not be read; try again");
      const kept = keptByAccount(apps).get(accountId);
      if (kept !== undefined) return kept;
    }
    return [];
  });
  await refreshAccountTools(runtime);

  // A taint mode weaker than enforce is the operator's choice, said once at start (and by tavi doctor).
  const weakTaint = await weakTaintWorkspaces(runtime).catch((error: unknown) => {
    // Unread, the warning is not skipped silently: the failure is said in its place.
    runtime.logger.warn("the workspaces' taint modes could not be read to warn of a weak one; `tavi doctor` checks them", {
      error: errorMessage(error),
    });
    return [];
  });
  for (const weak of weakTaint)
    runtime.logger.warn(weak.warning, {
      workspaceId: weak.workspaceId,
      mode: weak.mode,
      ...(runtime.taintPolicy === undefined ? {} : { via: "serve --taint-policy" }),
    });

  // A credential store left plain (no OS keychain could keep a key) is said at start, as tavi doctor reports it.
  const plainStore = await plainCredentialStoreWarning(options.dataDirectory);
  if (plainStore !== undefined) runtime.logger.warn(plainStore);

  // An MCP server approved weaker than this host now confines is said at start, as tavi doctor reports it.
  // Off the start path, and the sandbox probed only when such a server exists: nothing waits on this.
  void (async () => {
    const status = async (): Promise<SandboxStatus> => {
      const current = runtime.sandboxHost.current();
      return current.tier === "checking" ? await runtime.sandboxHost.check() : current;
    };
    for (const weaker of await weakerSandboxServersOf(runtime, status))
      runtime.logger.warn(weaker.warning, { pluginId: weaker.pluginId, version: weaker.version, sandboxState: weaker.sandboxState });
  })().catch((error: unknown) => {
    runtime.logger.warn("MCP servers' sandbox states could not be read to warn of a weaker one; `tavi doctor` checks them", {
      error: errorMessage(error),
    });
  });

  // A turn the last owner's unclean stop cut off waits for the person: said once at start, as `tavi doctor` reports it.
  const stranded = await strandedAdmissions(runtime).catch((error: unknown) => {
    runtime.logger.warn("turns an unclean stop may have cut off could not be read; `tavi doctor` checks them", {
      error: errorMessage(error),
    });
    return undefined;
  });
  if (stranded !== undefined) for (const warning of strandedTurnWarnings(stranded)) runtime.logger.warn(warning.message, warning.fields);

  // The agent's way to ask for a connection: it reads the owner's apps projection, here.
  registerAppsTools(runtime.tools, {
    operatorOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
    apps: async (workspaceId) => (await appsOfWorkspace(runtime, workspaceId)) ?? [],
    catalog: async (workspaceId) => {
      const answer = await appsOwnerCommand(runtime, { action: "catalog", query: "", workspaceId }, operatorActor(false));
      if (!answer.ok) return [];
      return (answer.result as { readonly catalog: AppsCatalogAnswer }).catalog.sections
        .filter((section) => section.section !== "registry")
        .flatMap((section) => section.entries);
    },
  });

  // Apps that need signing in again: read from the owner's apps projection, which lives beside the IPC.
  runtime.heartbeat.signals.install(
    "apps",
    appsSignalsSource({
      apps: (workspaceId) => appsOfWorkspace(runtime, workspaceId),
      connections: runtime.store.asPort().repositories.messagingConnections,
      operatorOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
      usedIn: async (accountId) => {
        const repositories = runtime.store.asPort().repositories;
        const offering = await Promise.all(
          runtime.access
            .workspaceIds()
            .map(async (workspaceId) =>
              (await repositories.workspaceSettings.get(workspaceId)).settings.mcpServers?.includes(accountId) === true
                ? [workspaceId]
                : [],
            ),
        );
        return offering.flat();
      },
    }),
    "builtin",
  );

  const ownership = {
    dataDirectory: options.dataDirectory,
    sessionId: runtime.ownerSession,
    released: false,
  };

  const endpoint = ownerEndpoint(options.dataDirectory);
  const pipe = isPipeEndpoint(endpoint);
  // A unix socket path is bounded by `sun_path` (104 bytes on macOS, 108 on
  // Linux). Binding a longer path fails with a misleading error, so the limit is
  // checked here and reported as the operator error it is.
  if (!pipe && Buffer.byteLength(endpoint) > 100) {
    await runtime.close();
    throw new TaviError(
      "INVALID_INPUT",
      `Data directory path is too long for a unix socket (${Buffer.byteLength(endpoint)} bytes, ` +
        "limit 100): choose a shorter --data-dir",
      { details: { endpoint } },
    );
  }

  const state: DispatchState = {
    // Absent (a test's owner): the runtime options' own target, fixed as flags are.
    target: options.modelTarget ?? {
      source: "flags",
      connectionId: runtimeOptions.defaultConnectionId,
      model: runtimeOptions.defaultModel,
      workspaceId: DEFAULT_WORKSPACE_ID,
    },
    startupProviders: runtimeOptions.providers.map((provider) => ({
      baseUrl: provider.baseUrl,
      credentialRef: provider.credentialRef,
    })),
    // Every reference the launcher bound — a model's, a messaging connection's — none a search provider may name.
    launcherBindings: [...Object.keys(runtimeOptions.credentials), ...Object.keys(runtimeOptions.httpCredentialHosts ?? {})],
    credentialsWritten: new Set(),
    answeringRuns: createAnsweringRuns(),
    conversationHolds: new Map(),
    stopping: false,
    resetRequested: false,
    shutdown: new AbortController(),
    health: createHealthWatch({ every: runtime.every }),
    busSubscriptions: new WeakMap(),
    folderPicks: new WeakMap(),
    uploads: new WeakMap(),
  };

  // Startup is all-or-nothing. Ownership has already been taken, so a failure
  // here must hand the directory back: otherwise a crashed start would leave the
  // data directory owned by a process that is about to exit, and the service
  // manager's restart would be refused forever.
  let bound: IpcServer | undefined;
  // Assigned once `shutdown` exists; the request closure only runs later, after
  // the server is listening, so this cannot fire before it is set.
  let requestShutdown: (reason: string) => void = () => {};
  try {
    // Notices a turn claimed and never ran — the last owner stopped between
    // claim and commit — go back to unread before any client can send a turn.
    try {
      const released = await runtime.store.asPort().repositories.transcripts.releaseOrphanedNotices();
      if (released > 0) runtime.logger.info("handed back notices claimed by turns that never ran", { released });
    } catch (error) {
      runtime.logger.warn("notices claimed by turns that never ran could not be handed back", { reason: errorMessage(error) });
    }
    // Steers a model call claimed before the last owner stopped, whose admission
    // never settled them: pending again, so nothing typed is lost.
    try {
      const released = await runtime.store.asPort().repositories.transcripts.releaseOrphanedSteers();
      if (released > 0) runtime.logger.info("handed back steers claimed by turns that never settled", { released });
    } catch (error) {
      runtime.logger.warn("steers claimed by turns that never settled could not be handed back", { reason: errorMessage(error) });
    }
    // Turns that ended but were never saved to their chat's history — the last
    // owner stopped before the append — are saved from their admissions, once
    // per chat, before a new turn can be saved after them.
    try {
      const transcripts = runtime.store.asPort().repositories.transcripts;
      const since = new Date(Date.parse(runtime.clock.now()) - TRANSCRIPT_RECONCILE_WINDOW_MS).toISOString();
      let saved = 0;
      for (const taskId of await transcripts.listUnreconciled({ since, limit: TRANSCRIPT_RECONCILE_CHATS }))
        saved += await transcripts.reconcile(taskId);
      if (saved > 0) runtime.logger.info("saved turns their chats' history lost from their admissions", { saved });
    } catch (error) {
      runtime.logger.warn("turns lost from chats' history could not be saved from their admissions", { reason: errorMessage(error) });
    }
    const { token } = mintToken(options.dataDirectory, ownership);
    // A crashed owner leaves its socket file behind, and binding over it fails
    // with EADDRINUSE even though nothing is listening. Ownership is held
    // exclusively at this point, so any socket already at this path is a crash
    // artifact and restart must not require manual cleanup.
    if (!pipe) discardStaleSocket(endpoint);
    // No connection is taken until the endpoint's access is confirmed below.
    let admitting = false;
    const server = createIpcServer({
      endpoint,
      admitting: () => admitting,
      // The dispatcher below implements a subset of the v2 contract. Advertising
      // only what is served is the direction the invariant allows — the handshake must never
      // name a command that would answer UNSUPPORTED.
      features: DISPATCHED_IPC_COMMANDS,
      sessionId: runtime.ownerSession,
      token,
      onRequest: async ({ command, payload, connection, requestId }) =>
        dispatchCommand(runtime, command, payload, connection, requestId, (reason) => requestShutdown(reason), state),
      // Security-relevant: refused clients, protocol mismatches and malformed
      // frames must reach an operator, so they are logged at `warn`.
      onDiagnostic: (message, fields) => runtime.logger.warn(message, fields),
    });
    bound = server;
    await server.listening;

    // The endpoint must be reachable by this user only. A socket is created by
    // the bind with the process umask, so its mode is set explicitly and verified
    // rather than assumed; a pipe is given the owner's private access list and
    // read back. A connection taken before this was destroyed unread.
    if (pipe) {
      try {
        protectPipe(endpoint);
      } catch (error) {
        throw new TaviError("NOT_AUTHORIZED", errorMessage(error), { cause: error });
      }
    } else {
      chmodSync(endpoint, 0o600);
      const socketMode = statSync(endpoint).mode & 0o777;
      if ((socketMode & 0o077) !== 0) {
        throw new TaviError(
          "NOT_AUTHORIZED",
          `IPC socket ${endpoint} is accessible to other users (mode ${socketMode.toString(8)}); expected 0600`,
        );
      }
    }
    // The setting above ran without yielding, so a connection made while it did is still queued: one
    // turn of the event loop lets the server take (and destroy) it before admission opens.
    await new Promise<void>((resolve) => setImmediate(resolve));
    admitting = true;

    // Published only now: exclusive ownership is held and the endpoint is bound.
    clearStopping(options.dataDirectory);
    publishDiscovery(
      options.dataDirectory,
      {
        protocolVersion: IPC_PROTOCOL_VERSION,
        sessionId: runtime.ownerSession,
        endpoint,
        pid: process.pid,
        startedAt: runtime.clock.now(),
      },
      ownership,
    );
  } catch (error) {
    // Unpublish before releasing: a stale discovery record would send clients to
    // an endpoint that no longer exists. Release failures are reported but never
    // replace the startup error the caller needs to see.
    try {
      clearDiscovery(options.dataDirectory);
      clearToken(options.dataDirectory);
    } catch (releaseError) {
      io.stderr(`could not remove IPC credentials: ${errorMessage(releaseError)}\n`);
    }
    if (bound !== undefined) {
      await bound.close().catch((closeError: unknown) => {
        io.stderr(`could not close the IPC endpoint: ${errorMessage(closeError)}\n`);
      });
    }
    await runtime.close().catch((closeError: unknown) => {
      io.stderr(`could not release the data directory: ${errorMessage(closeError)}\n`);
    });
    throw error;
  }
  const server: IpcServer = bound;

  emitJson(io, { serving: true, sessionId: runtime.ownerSession, endpoint });
  // Its own memory, descriptors and children every 10 minutes, in memory only, until shutdown begins.
  state.health.start(state.shutdown.signal);
  // What Rhumb says of the models in use, now and daily, with RHUMB_KEY set: one log line, never a model change.
  startLifecycleSync(runtime.logger, (aborted) => syncRuntimeModelLifecycle(runtime, { signal: aborted }), state.shutdown.signal);

  let resolveStopped: (outcome: ShutdownOutcome) => void = () => {};
  const stopped = new Promise<ShutdownOutcome>((resolve) => {
    resolveStopped = resolve;
  });

  // Every call gets the same promise, so a signal handler and a test cleanup that
  // race cannot both believe they performed the shutdown, and no caller can
  // observe "finished" while the first shutdown is still running.
  let inFlight: Promise<void> | undefined;

  const shutdown = (reason: string, deadlineMs?: number): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    const deadline = Math.min(options.drainDeadlineMs, deadlineMs ?? options.drainDeadlineMs);
    inFlight = (async () => {
      io.stderr(`shutting down: ${reason}\n`);
      let outcome: ShutdownOutcome = { clean: false, reason };
      const started = Date.now();
      const remaining = (): number => Math.max(0, deadline - (Date.now() - started));
      try {
        // Order matters: admission closes first, but attached clients
        // stay connected until the runs they watch have finished inside the
        // deadline and their final events have been flushed to them. Tearing the
        // connections down first would drop exactly those events.
        //
        // 1. Close admission — for every producer, not only IPC: a schedule fire,
        //    a chat message or a sweep that admitted during the drain would extend
        //    it, or start on a store being disposed. No new connections, and no
        //    new commands on the live ones.
        state.stopping = true;
        state.shutdown.abort();
        runtime.admissions.close();
        await server.closeListener();
        clearDiscovery(options.dataDirectory);
        // A command that now finds the directory held does not wait for this owner to answer.
        markStopping(options.dataDirectory, ownership);
        // The cookie is ephemeral: never leave it behind for a successor process.
        clearToken(options.dataDirectory);
        // 2. Let the admissions already running finish, publishing their ends.
        //    Any still running at the deadline are aborted, so they end — with an
        //    `ABORTED` failure an attached client sees — rather than run on
        //    against a store being disposed.
        const drained = await runtime.admissions.idle(remaining());
        if (!drained) {
          const aborted = runtime.abortRegistry.abortAll(new Error("the owner is shutting down"));
          io.stderr(`drain deadline passed with admissions running; aborted ${aborted}\n`);
          await runtime.admissions.idle(ABORT_GRACE_MS);
        }
        // 3. Dispose the runtime under its own deadline, as it always had: a turn
        //    that used the drain's time must not also cost disposal its budget.
        const report = await withDeadline(runtime.close(), deadline);
        if (report === "timeout") {
          // The exit code is the only signal a service manager is guaranteed to
          // read, so an abandoned drain must not look like a clean stop. Forcing
          // termination itself belongs to the supervisor; this process
          // reports honestly and lets the event loop drain.
          io.stderr(`drain exceeded ${deadline}ms; the runtime was not disposed cleanly\n`);
          outcome = { clean: false, reason: `drain exceeded ${deadline}ms` };
        } else if (!report.clean) {
          io.stderr("runtime disposal reported failures during shutdown\n");
          outcome = { clean: false, reason: "disposal failed" };
        } else if (!drained) {
          // Work was cut off: not a clean stop, however tidy the disposal was.
          outcome = { clean: false, reason: "admissions were cut off at the drain deadline" };
        } else {
          outcome = { clean: true, reason };
        }
      } catch (error) {
        // A rejection here must not become an unhandled rejection inside a signal
        // handler: that kills the process with a stack trace and leaves `stopped`
        // pending forever.
        io.stderr(`shutdown failed: ${errorMessage(error)}\n`);
        outcome = { clean: false, reason: "shutdown failed" };
      } finally {
        // 4. Flush what the connections still hold, then end them — always, even
        // after a failed disposal, so no connection outlives the owner.
        try {
          await server.drain(Math.max(remaining(), ABORT_GRACE_MS));
          await server.close();
        } catch (error) {
          io.stderr(`could not close the IPC endpoint: ${errorMessage(error)}\n`);
        }
        resolveStopped(state.resetRequested ? { ...outcome, reset: true } : outcome);
      }
    })();
    return inFlight;
  };
  requestShutdown = (reason: string): void => {
    void shutdown(reason);
  };

  return { runtime, server, stopped, shutdown };
}

/**
 * The commands `dispatchCommand` below actually implements.
 *
 * Kept beside the switch it describes so the two are read together; the
 * handshake advertises this set rather than the whole contract.
 */
const DISPATCHED_IPC_COMMANDS = [
  "artifacts",
  "tasks",
  "cancel",
  "recover",
  "doctor",
  "approvals",
  "shutdown",
  "subscribe",
  "unsubscribe",
  "abort",
  "approve",
  "review",
  "run",
  "agents",
  "models",
  "router",
  "credentials",
  "channels",
  "ui-preferences",
  "projects",
  "reports",
  "schedules",
  "routines",
  "search",
  "plugins",
  "mcp",
  "apps",
  "reply",
  "system-prompt",
  "permissions",
  "workspace-settings",
  "center",
  "memory",
  "skills",
  "reminders",
  "heartbeat",
  "ideas",
  "onboarding",
  "browser",
  "chat-context",
  "browser-live",
  "reset-instance",
  "plugin-commands",
  "folder",
  "browse",
] as const;

/** What the dispatcher keeps across requests, for the owner's lifetime. */
interface DispatchState {
  /** Set once shutdown begins: no new command is started after it. */
  stopping: boolean;
  /** Set by `reset-instance`: the stop that follows hands the directory back to be reset. */
  resetRequested: boolean;
  /** Aborted as shutdown begins, so a waiting `center watch` answers rather than holding the drain up. */
  readonly shutdown: AbortController;
  /** The owner's health samples: `doctor` reports their trend and the Command Center warns on sustained growth. */
  readonly health: HealthWatch;
  /**
   * The model target resolved at startup, with the flags it was resolved
   * from: what `liveTarget` resolves the target the owner runs now from.
   */
  readonly target: OwnerModelTarget;
  /** The connections the owner was launched with: their credentials stay with their origins. */
  readonly startupProviders: readonly { readonly baseUrl: string; readonly credentialRef: string }[];
  /** The references the owner's launcher bound. */
  readonly launcherBindings: readonly string[];
  /** References an attached client wrote a value to through this owner. */
  readonly credentialsWritten: Set<string>;
  /**
   * Conversations on a local connection an IPC run is being admitted under,
   * by `connectionId\0conversationId`, with the principal it is for: held
   * until the conversation is recorded, so two principals' runs under one
   * operation key cannot both take it.
   */
  readonly conversationHolds: Map<string, string>;
  /** Tasks whose rounds an IPC run's `"approve"`/`"deny"` loop answers here. */
  readonly answeringRuns: AnsweringRuns;
  /**
   * Per connection, the bus subscription behind each transport subscription.
   *
   * The transport owns the outbound budget and the bus owns the ring cursor;
   * releasing one without the other leaks the other. Keyed by the transport's
   * id — the only one a client ever sees — and released on `unsubscribe`, on a
   * transport drop, on a failed delivery and when the connection closes.
   */
  readonly busSubscriptions: WeakMap<IpcConnection, Map<string, RunEventSubscription>>;
  /**
   * Per connection, the picker tokens `browse` issued on it: a
   * token is redeemed only on the connection it was issued on, and goes with
   * the connection.
   */
  readonly folderPicks: WeakMap<IpcConnection, FolderPicks>;
  /** Per connection, the attachment uploads under way: dropped, zeroed, when it closes. */
  readonly uploads: WeakMap<IpcConnection, AttachmentUploads>;
}

/**
 * A routine create or update from the web bridge that would pin a host
 * folder (I-web): refused. An update that keeps the folder the
 * routine already has is not a new path, so the canvas can still edit it.
 */
export async function refuseBridgeRoutineFolder(runtime: Pick<TaviRuntime, "routines">, payload: RoutinesPayload): Promise<void> {
  const named =
    payload.action === "create" ? payload.create?.folder : payload.action === "update" ? payload.update?.snapshot.folder : undefined;
  if (named === undefined) return;
  if (payload.action === "update" && payload.update !== undefined) {
    const current = (
      await runtime.routines.get({ workspaceId: payload.workspaceId, principalId: payload.principalId }, payload.update.routineId)
    ).revision.snapshot.folder;
    if (current?.path === named.path) return;
  }
  throw new TaviError("NOT_AUTHORIZED", "The canvas cannot name a host folder for a routine; pin it from a terminal");
}

/** The picker tokens `connection` was issued; none without a connection. */
function picksOf(state: DispatchState, connection: IpcConnection | undefined): FolderPicks | undefined {
  if (connection === undefined) return undefined;
  let picks = state.folderPicks.get(connection);
  if (picks === undefined) {
    picks = new FolderPicks();
    state.folderPicks.set(connection, picks);
  }
  return picks;
}

/** The uploads under way on `connection`; none without a connection. */
function uploadsOf(state: DispatchState, connection: IpcConnection | undefined): AttachmentUploads | undefined {
  if (connection === undefined) return undefined;
  let uploads = state.uploads.get(connection);
  if (uploads === undefined) {
    const created = new AttachmentUploads();
    state.uploads.set(connection, created);
    connection.onClose(() => created.clear());
    uploads = created;
  }
  return uploads;
}

/** The bus subscriptions a connection holds, released together when it closes. */
function subscriptionsOf(state: DispatchState, connection: IpcConnection): Map<string, RunEventSubscription> {
  let registry = state.busSubscriptions.get(connection);
  if (registry === undefined) {
    const created = new Map<string, RunEventSubscription>();
    state.busSubscriptions.set(connection, created);
    connection.onClose(() => {
      for (const subscription of created.values()) subscription.unsubscribe();
      created.clear();
    });
    registry = created;
  }
  return registry;
}

/**
 * A transport subscription on `connection`, fed from a task's bus stream.
 *
 * Reserved first and attached to a task second, so `run` can refuse a
 * connection with no subscription left *before* it admits anything, and attach
 * once `onAdmitted` names the task. The subscription id is the transport's: the
 * bus delivers *through* the connection, so the per-subscription backlog budget
 * applies to pushed events and a stalled subscriber is dropped rather than
 * holding a run's events in memory. Its events are held until the
 * response of `requestId` is written, so they always follow it; a failed
 * response discards them and releases the subscription.
 */
function openSubscription(runtime: TaviRuntime, state: DispatchState, connection: IpcConnection, requestId: string): ReservedSubscription {
  const subscriptionId = prefixedId("sub");
  const registry = subscriptionsOf(state, connection);
  let bus: RunEventSubscription | undefined;
  // Latched, so a release that runs before the bus side exists still releases
  // it once it does.
  let released = false;
  const release = (): void => {
    released = true;
    bus?.unsubscribe();
    registry.delete(subscriptionId);
  };
  // A transport drop (backlog, or a failed creating response) releases the bus
  // side too. Throws for a connection that holds no more subscriptions.
  connection.createSubscription({ subscriptionId, requestId, onDropped: release });
  return {
    subscriptionId,
    release: () => {
      connection.dropSubscription(subscriptionId);
      release();
    },
    attach(taskId, from) {
      try {
        const result = runtime.runEventBus.subscribe({
          taskId,
          ...(from === undefined ? {} : { from }),
          // A delivery the connection refuses means the subscription is gone.
          deliver: (event) => {
            if (!connection.sendEvent(subscriptionId, event)) release();
          },
        });
        bus = result.subscription;
        if (released) bus.unsubscribe();
        else registry.set(subscriptionId, bus);
        // Replay, then the resync marker, then live events. The transport holds
        // them until the creating response is written, so they always follow it.
        for (const event of result.replayed) {
          if (!connection.sendEvent(subscriptionId, event)) {
            release();
            break;
          }
        }
        if (result.resync !== null && !released && !connection.sendEvent(subscriptionId, result.resync)) release();
        return {
          replayed: result.replayed.length,
          resync: result.resync !== null,
          // A late attach says so: the bus knows when its ring was
          // trimmed, and a retained transcript that does not open with
          // `run.started` began before this owner's epoch. An empty one is not
          // evidence either way — a task still queued behind its lease has
          // published nothing yet.
          truncated: result.truncated || (from === "beginning" && result.replayed.length > 0 && result.replayed[0]?.kind !== "run.started"),
        };
      } catch (error) {
        connection.dropSubscription(subscriptionId);
        release();
        throw error;
      }
    },
  };
}

/** Each owner's mailbox and calendar tools, by channel, registered again when an opt-in or a connection changes. */
const ACCOUNT_TOOLS = new WeakMap<TaviRuntime, readonly { readonly refresh: () => Promise<void> }[]>();

/** After a command: a refresh that fails is logged, never put in place of the command's own answer. */
async function refreshAccountTools(runtime: TaviRuntime): Promise<void> {
  for (const tools of ACCOUNT_TOOLS.get(runtime) ?? []) {
    await tools
      .refresh()
      .catch((error: unknown) => runtime.logger.error("a channel account's tools could not be registered", { error: errorMessage(error) }));
  }
}

/** What the channels command needs from the owner's runtime. */
function channelsDependencies(runtime: TaviRuntime): Parameters<typeof channelsCommand>[0] {
  return {
    dataDirectory: runtime.dataDirectory,
    repositories: runtime.store.asPort().repositories,
    channels: runtime.channels,
    messaging: runtime.messaging,
    reload: (workspaceId) => runtime.reloadChannels(workspaceId),
    applyIngress: () => runtime.applyIngress(),
    pairings: runtime.pairings,
    roomInvitations: runtime.roomInvitations,
    eraseArtifacts: (artifactIds) => runtime.channelPurging.eraseArtifacts(artifactIds),
    forgetNotes: (principalId, taskIds) => runtime.forgetSenderNotes(principalId, taskIds),
    countNotes: (taskIds) => runtime.countChatNotes(taskIds),
    operatorOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
    // Started and read by the channels' flows; a callback reaches whichever sign-in owns its state.
    oauth: {
      start: (input) => runtime.oauthFlows.start(input),
      startDevice: (input) => runtime.oauthFlows.startDevice(input),
      status: (flowId, workspaceId) => runtime.oauthFlows.status(flowId, workspaceId),
      callback: (input) => runtime.oauthCallbacks.callback(input),
      finish: (flowId, workspaceId, address) => runtime.oauthFlows.finish(flowId, workspaceId, address),
      cancel: (flowId, workspaceId) => runtime.oauthFlows.cancel(flowId, workspaceId),
    },
    revokeToken: (connection, options) => runtime.oauthBroker.revoke(connection, options),
    // Weighed as Connected apps weighs it, so a mail channel's disconnect here leaves Calendar's sign-in alone.
    sharedGrants: async (workspaceId) => {
      const apps = await appsOfWorkspace(runtime, workspaceId);
      if (apps === undefined) throw new TaviError("UNAVAILABLE", "the apps signed in with this account could not be read; try again");
      return keptByAccount(apps);
    },
    now: () => runtime.clock.now(),
    meta: {
      get: (key) => runtime.store.getMeta(key),
      set: async (key, value) => await runtime.store.setMeta(key, value, runtime.clock.now()),
    },
  };
}

/** The workspace's Connected apps as the owner projects them, or undefined when it cannot now. */
async function appsOfWorkspace(runtime: TaviRuntime, workspaceId: string): Promise<readonly ConnectableApp[] | undefined> {
  const answer = await appsOwnerCommand(runtime, { action: "list", workspaceId }, operatorActor(false));
  return answer.ok ? (answer.result as { readonly apps: readonly ConnectableApp[] }).apps : undefined;
}

/**
 * `onboarding` on this owner, its writes through the same `models` and
 * `credentials` commands a client sends. `wrote` hears each write that
 * succeeded, so the caller can read providers again once the call is done.
 */
function onboardingDependencies(
  runtime: TaviRuntime,
  state: DispatchState,
  target: OwnerModelTarget,
  connection?: IpcConnection,
  wrote?: () => void,
): OnboardingCommandDependencies {
  // Not marked as written by the page: a detected key is bound to the preset's origin by the connection added first.
  const { credentialsWritten: _written, ...config } = configDependencies(runtime, state, target, connection);
  return ownerOnboardingDependencies(runtime, {
    fromBridge: connection?.viaBridge() === true,
    launchedWithModel: state.startupProviders.length > 0,
    // Through the same commands a client sends, so their guards apply as they would.
    config: {
      credentials: async (payload) => {
        const answer = await credentialsCommand(config, payload);
        if (answer.ok && payload.action !== "list") wrote?.();
        return answer;
      },
      models: async (payload) => {
        const answer = await modelsCommand(config, payload);
        if (answer.ok && !MODELS_READS.has(payload.action)) wrote?.();
        return answer;
      },
    },
  });
}

/** What the configuration commands need from the owner's runtime. */
/** `target`: the live one (`ownerTarget`) for a command that reads it — `models`, `schedules` — else the startup one, unread. */

function configDependencies(
  runtime: TaviRuntime,
  state: DispatchState,
  target: OwnerModelTarget,
  connection?: IpcConnection,
): ConfigDependencies {
  const repositories = runtime.store.asPort().repositories;
  const scheduling = runtime.scheduleDependencies;
  return {
    modelConfig: runtime.store.services.modelConfig,
    mcpBudget: {
      checkEnable: (pluginId, workspaceId, alsoAllowed) => runtime.mcp.checkEnable(pluginId, undefined, workspaceId, alsoAllowed),
      recheck: () => runtime.mcp.checkBudget(),
    },
    routines: runtime.routines,
    repositories,
    taskNeeds: async (workspaceId, taskIds) => await runtime.store.taskNeeds(workspaceId, taskIds),
    taskRouting: runtime.taskRouting,
    workerActivity: (taskId, status) => workerActivity(runtime.runEventBus, repositories, taskId, status),
    dataDirectory: runtime.dataDirectory,
    videoBinaries: runtime.videoBinaries,
    videoStatus: () => videoStatusDocument(runtime),
    voice: runtime.voiceSetup,
    lifecycleSync: () => syncRuntimeModelLifecycle(runtime),
    lifecycleReport: () => runtimeLifecycleReport(runtime),
    replaceModel: (from, to, workspaceId, confirmed) =>
      confirmed ? replaceModel(runtime, from, to, workspaceId) : previewReplace(runtime, from, to, workspaceId),
    target,
    startupProviders: state.startupProviders,
    readSecret: runtime.readSecret,
    modelCredential: runtime.modelCredential,
    explicitSystemPrompt: runtime.systemPromptExplicit,
    contextBudgetTokens: runtime.contextBudgetTokens,
    knownWorkspace: (workspaceId) => runtime.access.resolveWorkspace(workspaceId) !== undefined,
    actsIn: (workspaceId, principalId) => runtime.access.actsIn(workspaceId, principalId),
    workspacePrincipal: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
    pruneMemoryVectors: () => runtime.pruneMemoryVectors(),
    launcherBindings: state.launcherBindings,
    credentialsWritten: state.credentialsWritten,
    fromBridge: connection?.viaBridge() === true,
    ...(runtime.taintPolicy === undefined ? {} : { taintPolicy: runtime.taintPolicy }),
    disabledPlugins: () => runtime.plugins.registry.disabledBuiltins(),
    now: () => new Date(runtime.clock.now()),
    // Scheduled or manual: a removal waits for either.
    fireInFlight: runtime.scheduleFireInFlight,
    precheckFile: runtime.precheckFile,
    precheckSite: runtime.precheckSite,
    scheduleFolder: runtime.scheduleFolder,
    webhookChanged: () => runtime.applyIngress(),
    schedulesChanged: () => runtime.scheduleWatchersChanged(),
    registeredTools: () => runtime.tools.list().map((tool) => ({ id: tool.id, effect: tool.effect })),
    ...(scheduling === undefined
      ? {}
      : {
          // A manual fire on the owner's own scheduler dependencies — the
          // in-flight registry included, so `approve` leaves its rounds to it —
          // held with a chat's to one per schedule at a time. Answered once the
          // run is admitted (a UI subscribes by task id), or with the outcome
          // when the fire ran nothing.
          fireNow: (schedule: ScheduleRecord) =>
            runtime.fireScheduleManually(schedule).then(
              (result): ScheduleRunAnswer => ({ ok: true, result }),
              (error: unknown): ScheduleRunAnswer => {
                return refusalFrom(error);
              },
            ),
        }),
  };
}

/** What `browser` and `artifacts read` read: browser history and thumbnails, for workspaces this owner serves. */
function browserDependencies(
  runtime: TaviRuntime,
  repositories: ReturnType<TaviRuntime["store"]["asPort"]>["repositories"],
): BrowserDependencies {
  return {
    repositories,
    principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
    now: () => new Date(runtime.clock.now()),
    // The operator's own notes, where `tavi browser site-notes --propose` writes them.
    siteNotesDirectory: join(runtime.dataDirectory, SITE_NOTES_DIRECTORY),
    taskTree: async (workspaceId, taskId) => (await readAgentTree(repositories, workspaceId, taskId)).nodes.map((node) => node.taskId),
    ...(runtime.browser.closeRecorded === undefined
      ? {}
      : {
          closeSession: (sessionId: string, reason: string) => runtime.browser.closeRecorded?.(sessionId, reason) ?? Promise.resolve(false),
        }),
    ...(runtime.browser.clearProfile === undefined
      ? {}
      : { clearProfile: (workspaceId: string) => runtime.browser.clearProfile?.(workspaceId) ?? Promise.resolve({ closed: 0 }) }),
  };
}

/** What `decideRound` needs from the owner's runtime. */
function decisionDependencies(runtime: TaviRuntime, target: OwnerModelTarget): DecideRoundDependencies {
  return {
    ...(runtime.channelName === undefined ? {} : { channelName: runtime.channelName }),
    repositories: runtime.store.asPort().repositories,
    workflow: runtime.workflow,
    scheduleFires: runtime.scheduleFires,
    ownerSession: runtime.ownerSession,
    target,
    targetForTask: async (task) => {
      const target = await runtime.taskRouting.effectiveTarget?.(
        { workspaceId: task.workspaceId, principalId: task.principalId },
        task.taskId,
      );
      return target === undefined ? undefined : { ...target, source: "saved-task-route" };
    },
    streamHead: (taskId) => runtime.runEventBus.head(taskId),
  };
}

/** An owner's answer to one command. */
type CommandAnswer = { ok: boolean; result?: unknown; error?: IpcRefusal["error"] };

/**
 * Commands an authenticated client may invoke.
 *
 * This handles exactly the commands the handshake advertises
 * (`DISPATCHED_IPC_COMMANDS`), and it answers them through the same document builders and
 * the same cancellation transaction as the direct CLI path, so an attached
 * caller cannot receive a different answer than an unattached one.
 */
async function dispatchCommand(
  runtime: TaviRuntime,
  command: string,
  payload: unknown,
  connection: IpcConnection,
  requestId: string,
  requestShutdown: (reason: string) => void,
  state: DispatchState,
): Promise<CommandAnswer> {
  // Once shutdown begins nothing new starts. A client may still release what it
  // holds, and may still `abort` — it only stops work, and during a drain it is
  // how an operator ends the run holding shutdown up. Its subscriptions keep
  // receiving the ends of runs that finish inside the drain.
  if (state.stopping && command !== "unsubscribe" && command !== "abort") {
    return refuseKeyed("UNAVAILABLE", "error.owner.shuttingDown");
  }
  const repositories = runtime.store.asPort().repositories;
  // The target this owner runs now, in the workspace the command names,
  // read once a command needs it.
  let target: Promise<OwnerModelTarget> | undefined;
  const ownerTarget = (): Promise<OwnerModelTarget> =>
    (target ??= liveTarget(runtime.store.services.modelConfig, {
      ...state.target,
      workspaceId: commandWorkspace ?? state.target.workspaceId,
    }));
  // Parse before any handler reads the payload: every schema lives in
  // contracts, and reading through `as` casts would let a handler ignore its
  // own `action` or pass an unbounded `limit` straight to the repository.
  // Who acts in the workspace, read again after a change to Allowed people. Its failure is logged, never the
  // command's answer: the change itself was made, and the next admission reads it again.
  const refreshPeopleAfterChange = (): Promise<void> =>
    runtime
      .refreshPeople()
      .catch((error: unknown) =>
        runtime.logger.error("Allowed people could not be read again after a change", { error: errorMessage(error) }),
      );
  // The providers and routine bindings, read again after a `models`, `credentials` or `search` write, so the first model
  // or search provider takes effect with no restart. Like the above, its failure is logged.
  const refreshProvidersAfterWrite = (): Promise<void> =>
    runtime
      .refreshProviders()
      .catch((error: unknown) =>
        runtime.logger.error("providers could not be read again after a configuration change", { error: errorMessage(error) }),
      );
  // A page names no principal: a routine it names is addressed as its owner's —
  // the workspace's, or a person's from Allowed people — and a list is the workspace's.
  let routinesOfWorkspace = false;
  let routineOwnerRevoked = false;
  if (command === "routines" && isRecord(payload)) {
    const input = payload;
    const workspaceId = input["workspaceId"];
    // A principal named by the caller acts in the workspace — its own, or a person allowed there — or is refused:
    // a routine is never made for, nor run as, anyone else, nor reached past the revoked-owner check below.
    if (
      typeof input["principalId"] === "string" &&
      typeof workspaceId === "string" &&
      !runtime.access.actsIn(workspaceId, input["principalId"])
    ) {
      return refuseKeyed("NOT_AUTHORIZED", "error.access.notAllowedInWorkspace", { principalId: input["principalId"], workspaceId });
    }
    if (input["principalId"] === undefined && typeof workspaceId === "string") {
      const ref: { routineId?: string; runId?: string; jobId?: string } = {};
      for (const key of ["routineId", "runId", "jobId"] as const) {
        const value = input[key];
        if (typeof value === "string") ref[key] = value;
      }
      // A copy (Duplicate) is made for the owner of the routine it copies, as a reminder's copy is.
      const copied = input["copyOf"];
      if (ref.routineId === undefined && typeof copied === "string") ref.routineId = copied;
      const owner = Object.keys(ref).length === 0 ? undefined : await runtime.routines.ownerOf(workspaceId, ref);
      // A revoked person's routine is kept, so it can be seen and archived, and nothing more.
      routineOwnerRevoked = owner !== undefined && !runtime.access.actsIn(workspaceId, owner);
      if (routineOwnerRevoked && !REVOKED_OWNER_ROUTINE_ACTIONS.has(String(input["action"]))) {
        return refuseKeyed("NOT_AUTHORIZED", "error.routine.ownerRevoked", { owner: String(owner), action: String(input["action"]) });
      }
      payload = { ...input, principalId: owner ?? runtime.access.resolveWorkspace(workspaceId)?.principalId };
      routinesOfWorkspace = input["action"] === "list" && Object.keys(ref).length === 0;
    }
  }
  const parsed = parseCommandPayload(command as IpcCommand, payload);
  if (!parsed.ok) {
    return { ok: false, error: { code: parsed.code ?? "INVALID_INPUT", message: parsed.message } };
  }
  const named = (parsed.value as { readonly workspaceId?: unknown } | null)?.workspaceId;
  const commandWorkspace = typeof named === "string" ? named : undefined;
  // One handler per command: the table is exhaustive over `IpcCommand`, so a
  // command the contract declares and the owner does not answer stops the build.
  const routes: { readonly [C in IpcCommand]: (value: IpcParsedPayload<C>) => Promise<CommandAnswer> } = {
    approvals: async (approvalsInput) => {
      if (approvalsInput.action === "show") {
        // The audit trail of one task's rounds, in the caller's workspace only.
        const task = approvalsInput.taskId === undefined ? undefined : await repositories.tasks.get(approvalsInput.taskId);
        if (task === undefined || task.workspaceId !== (approvalsInput.workspaceId ?? DEFAULT_WORKSPACE_ID)) {
          return approvalsInput.taskId === undefined
            ? refuseKeyed("NOT_FOUND", "error.task.notInWorkspaceUnnamed")
            : refuseKeyed("NOT_FOUND", "error.task.notInWorkspace", { taskId: approvalsInput.taskId });
        }
        const shown: ApprovalsShowResult = {
          taskId: task.taskId,
          rounds: await repositories.approvalRounds.listForTask(task.taskId),
          events: await repositories.approvalRounds.listEvents(task.taskId),
          calls: approvalCallsOf(
            await repositories.approvals.listForTask(task.taskId),
            toolResultRedactionOn((await repositories.workspaceSettings.get(task.workspaceId)).settings),
          ),
        };
        return { ok: true, result: shown };
      }
      if (approvalsInput.action === "approve" || approvalsInput.action === "reject") {
        // The offline command's semantics over IPC: one verdict for
        // every call of the pending round, `--call`/a row id only asserting
        // that it is the round's one call. Decided through `approve`'s path,
        // so the two cannot answer differently.
        const taskId =
          approvalsInput.taskId ??
          (approvalsInput.approvalId === undefined ? undefined : (await repositories.approvals.get(approvalsInput.approvalId))?.taskId);
        if (taskId === undefined) {
          return {
            ok: false,
            error: {
              code: approvalsInput.approvalId === undefined ? "INVALID_INPUT" : "NOT_FOUND",
              message:
                approvalsInput.approvalId === undefined
                  ? `approvals ${approvalsInput.action} needs a task id or an approval id`
                  : `approval ${approvalsInput.approvalId} does not exist`,
            },
          };
        }
        return await decideRound(decisionDependencies(runtime, await ownerTarget()), {
          taskId,
          ...(approvalsInput.expectTarget === undefined ? {} : { expectTarget: approvalsInput.expectTarget }),
          workspaceId: approvalsInput.workspaceId ?? DEFAULT_WORKSPACE_ID,
          verdict: approvalsInput.action,
          ...definedOnly({
            callId: approvalsInput.callId,
            approvalId: approvalsInput.approvalId,
            decidedBy: approvalsInput.decidedBy,
            note: approvalsInput.note,
            scope: approvalsInput.scope,
          }),
          // The page may decide through this family too.
          via: connection?.viaBridge() === true ? "bridge" : "cli",
        });
      }
      const workspaceId = approvalsInput.workspaceId ?? DEFAULT_WORKSPACE_ID;
      if (approvalsInput.action === "answer") {
        // A question answered from the web or a terminal, whichever
        // channel its task started from.
        const principalId = runtime.access.resolveWorkspace(workspaceId)?.principalId;
        if (principalId === undefined || approvalsInput.taskId === undefined || approvalsInput.answer === undefined) {
          return { ok: false, error: { code: "INVALID_INPUT", message: "approvals answer needs a task, an answer and a known workspace" } };
        }
        const via = connection?.viaBridge() === true ? "bridge" : "cli";
        return await answerNeed(
          {
            repositories,
            channelApprovals: runtime.channelApprovals,
            operatorOf: (id) => runtime.access.resolveWorkspace(id)?.principalId,
          },
          {
            actor: { workspaceId, principalId, caller: via, authority: "operator" },
            taskId: approvalsInput.taskId,
            answer: approvalsInput.answer,
            via,
            ...(approvalsInput.waitId === undefined ? {} : { waitId: approvalsInput.waitId }),
          },
        );
      }
      if (approvalsInput.action === "needs") {
        // Everything waiting on a person, as one queue.
        const needs = await listNeeds(
          repositories,
          {
            workspaceId,
            ...(approvalsInput.taskId === undefined ? {} : { taskId: approvalsInput.taskId }),
            // A root chat's workers' questions and handoffs, answered from the root.
            ...(approvalsInput.rootTaskId === undefined ? {} : { rootTaskId: approvalsInput.rootTaskId }),
            ...(approvalsInput.limit === undefined ? {} : { limit: approvalsInput.limit }),
          },
          runtime.channelName,
        );
        return { ok: true, result: needs };
      }
      if (approvalsInput.action === "history") {
        // Every decision made before, across the workspace's tasks:
        // approvals, reviews and questions,
        // newest first. Nothing in it carries a call's input or an artifact's body.
        const {
          action: _action,
          workspaceId: _workspaceId,
          limit,
          cursor,
          kinds,
          states,
          since,
          until,
          toolId,
          principalId,
          taskId,
        } = approvalsInput;
        const history = await repositories.approvalInbox.history({
          workspaceId,
          limit: limit ?? APPROVAL_HISTORY_DEFAULT_LIMIT,
          ...definedOnly({
            cursor,
            kinds,
            states,
            since,
            until,
            toolId,
            principalId,
            taskId,
          }),
        });
        return { ok: true, result: withChannels(history, runtime.channelName) };
      }
      // The queue an operator needs to see *while* the daemon runs, without
      // stopping `serve` to look at it. `list` is the read-only half;
      // `approve`/`reject` are decided above, through `decideRound`. Scoped to
      // the workspace in SQL, oldest first, so another workspace's rows can
      // never crowd this one's out. With `taskId`, that task's rows only: an
      // attached run lists the round it is about to ask.
      const pending = await repositories.approvalInbox.pending({
        workspaceId,
        // Already bounded by `ApprovalsPayloadSchema` (`.max(1000)`).
        limit: approvalsInput.limit ?? 50,
        ...(approvalsInput.taskId === undefined ? {} : { taskId: approvalsInput.taskId }),
        ...(approvalsInput.cursor === undefined ? {} : { cursor: approvalsInput.cursor }),
      });
      // A Home's or a messaging chat's rounds, asked once per task: a round's calls share their chat.
      const taskIds = [...new Set(pending.rows.map((row) => row.taskId))];
      // A display badge only ("Allow until tomorrow"): one that cannot be judged is not shown; granting judges it again, and refuses.
      const lasting = new Map(
        await Promise.all(taskIds.map(async (taskId) => [taskId, await lastingChat(repositories, taskId).catch(() => false)] as const)),
      );
      const listed: ApprovalsListResult = {
        // Projected, never the whole `TaskRecord` or the call's input: the
        // prompt, the final text and the input are unbounded enough to
        // overflow the IPC frame. A card reads the
        // call's one-line headline instead.
        rows: pending.rows.map((row) => ({
          ...approvalListRowOf(row, runtime.channelName),
          ...(lasting.get(row.taskId) === true ? { lastingChat: true as const } : {}),
        })),
        truncated: pending.truncated,
        ...(pending.nextCursor === undefined ? {} : { nextCursor: pending.nextCursor }),
      };
      return { ok: true, result: listed };
    },
    tasks: async (value) => {
      // The parsed value, not the raw payload: whatever the schema checks or defaults is what is read.
      const taskInput = value;
      if ("action" in taskInput && taskInput.action === "list") {
        const { action: _action, ...filters } = taskInput;
        // A chat's notes are counted as the operator keeps them, as its panel lists them: by the memory
        // service, after the page query, never by the list's own SQL.
        // A list without a workspace spans every one: each workspace's rows are counted as its operator keeps them.
        const page = await runtime.store.listTaskSessions(filters);
        const byWorkspace = new Map<string, string[]>();
        for (const row of page.rows) byWorkspace.set(row.workspaceId, [...(byWorkspace.get(row.workspaceId) ?? []), row.taskId]);
        const counted = await Promise.all(
          [...byWorkspace].map(async ([workspaceId, taskIds]) => {
            const principalId = runtime.access.resolveWorkspace(workspaceId)?.principalId;
            if (principalId === undefined) return {};
            return (await runtime.memory.counts({ actor: { principalId, workspaceId, caller: "tasks", authority: "operator" }, taskIds }))
              .chatNotes;
          }),
        );
        const notes: Readonly<Record<string, number>> = Object.assign({}, ...counted);
        const listed = {
          ...page,
          rows: page.rows.map((row) => (notes[row.taskId] === undefined ? row : { ...row, chatNotes: notes[row.taskId] })),
        };
        return { ok: true, result: listed };
      }
      if ("action" in taskInput && taskInput.action === "prompts") {
        const { action: _action, ...filters } = taskInput;
        const prompts = await runtime.store.taskPrompts(filters);
        // One answer for a task that does not exist and one in another workspace, so a read never says which.
        if (prompts === undefined) return refuseKeyed("NOT_FOUND", "error.task.notFound", { taskId: filters.taskId });
        return { ok: true, result: prompts };
      }
      if ("action" in taskInput && taskInput.action === "transcript") {
        // As `prompts`: a task in another workspace reads as one that does not exist.
        const missing = taskNotFound(await repositories.tasks.get(taskInput.taskId), taskInput);
        if (missing !== undefined) return missing;
        return {
          ok: true,
          result: await repositories.transcripts.page(taskInput.taskId, {
            ...(taskInput.before === undefined ? {} : { before: taskInput.before }),
            limit: taskInput.limit ?? TRANSCRIPT_PAGE_DEFAULT,
          }),
        };
      }
      if ("action" in taskInput && taskInput.action === "notices") {
        // A chat's newest notices, read as its transcript is.
        const missing = taskNotFound(await repositories.tasks.get(taskInput.taskId), taskInput);
        if (missing !== undefined) return missing;
        return {
          ok: true,
          result: {
            notices: [...(await repositories.transcripts.notices(taskInput.taskId, { limit: taskInput.limit ?? NOTICES_LIST_DEFAULT }))],
          },
        };
      }
      if ("action" in taskInput && taskInput.action === "label") {
        // The chat's context label, as the gate reads it now: the header's taint chip.
        const task = await repositories.tasks.get(taskInput.taskId);
        if (task === undefined || (taskInput.workspaceId !== undefined && task.workspaceId !== taskInput.workspaceId)) {
          return refuseKeyed("NOT_FOUND", "error.task.notFound", { taskId: taskInput.taskId });
        }
        const answer: TaskLabelAnswer = { taskId: task.taskId, contextLabel: await taskContextLabel(runtime, task) };
        return { ok: true, result: answer };
      }
      if ("action" in taskInput && taskInput.action === "stop-handoff") {
        const task = await repositories.tasks.get(taskInput.taskId);
        if (task === undefined || (taskInput.workspaceId !== undefined && task.workspaceId !== taskInput.workspaceId)) {
          return refuseKeyed("NOT_FOUND", "error.task.notFound", { taskId: taskInput.taskId });
        }
        const withdrawn = await runtime.withdrawHandoffs(task.taskId, operatorActor(connection?.viaBridge() === true));
        if (withdrawn === 0)
          return { ok: false, error: { code: IPC_NOT_RUNNING, message: `Task ${task.taskId} is not waiting on a browser handoff` } };
        return { ok: true, result: { taskId: task.taskId, withdrawn } };
      }
      const input = taskInput as { taskId?: string };
      // This owner holds the lock, so reading its record would answer none: it names itself, as the record does.
      const self = { session_id: runtime.ownerSession, pid: process.pid };
      if (input?.taskId === undefined) {
        return {
          ok: true,
          result: await buildTaskDocument(runtime.store, runtime.dataDirectory, runtime.clock.now(), self),
        };
      }
      const now = runtime.clock.now();
      const shown = await buildTaskShowDocument(runtime.store, runtime.dataDirectory, input.taskId, now, self);
      if (shown["found"] !== true) {
        return refuseKeyed("NOT_FOUND", "error.task.notFound", { taskId: input.taskId });
      }
      return { ok: true, result: shown };
    },
    subscribe: async (input) => {
      // Refused for an unknown task, as `abort` is: subscribing used to create
      // an event ring for any id a client named, and nothing evicted it.
      if ((await repositories.tasks.get(input.taskId)) === undefined) {
        return refuseKeyed("NOT_FOUND", "error.task.notFound", { taskId: input.taskId });
      }
      const subscription = openSubscription(runtime, state, connection, requestId);
      // Read in the same turn as the attach, so no event lands between them.
      const cursor = input.from === undefined ? runtime.runEventBus.head(input.taskId) : undefined;
      const attached = subscription.attach(input.taskId, input.from);
      const firing = runtime.scheduleFires.scheduleOf(input.taskId);
      const schedule = firing === undefined ? undefined : await repositories.schedules.get(firing);
      const result: SubscribeResult = {
        subscriptionId: subscription.subscriptionId,
        ...attached,
        ...(cursor === undefined ? {} : { cursor }),
        // A round the owner answers itself is not the subscriber's to ask.
        roundsAnsweredBy: state.answeringRuns.has(input.taskId) || firing !== undefined ? "owner" : "client",
        ...(firing === undefined ? {} : { schedule: { scheduleId: firing, name: schedule?.name ?? firing } }),
      };
      return { ok: true, result };
    },
    unsubscribe: async (input) => {
      // A live browser-view watch is the hub's: released there, screencasts and all.
      if (runtime.liveHub.owns(connection, input.subscriptionId)) {
        runtime.liveHub.unwatch(connection, input.subscriptionId);
        return { ok: true, result: { unsubscribed: true } };
      }
      const registry = state.busSubscriptions.get(connection);
      const bus = registry?.get(input.subscriptionId);
      connection.dropSubscription(input.subscriptionId);
      bus?.unsubscribe();
      registry?.delete(input.subscriptionId);
      return { ok: true, result: { unsubscribed: bus !== undefined } };
    },
    run: async (value) => {
      // Answered once the task is admitted; the turn arrives on the
      // subscription `run` opens on this connection.
      return await startRun(
        {
          workflow: runtime.workflow,
          repositories,
          artifacts: repositories.artifacts,
          access: runtime.access,
          target: await ownerTarget(),
          taskRouting: runtime.taskRouting,
          // A side chat of a local chat stays on a local model.
          localChats: runtime.localChats,
          ownerSession: runtime.ownerSession,
          reserveSubscription: () => openSubscription(runtime, state, connection, requestId),
          log: (level, message, fields) => runtime.logger[level](message, fields),
          answering: state.answeringRuns,
          // An `approve` run releases its review rounds as it approves its calls.
          reviews: { artifacts: repositories.artifacts, materializeArtifact: runtime.materializeArtifact },
          // Where the loop says it stopped answering a round, so an attached run ends on it.
          stream: runtime.runEventBus,
          // Decided by the connection, not the payload.
          origin: connection?.viaBridge() === true ? "web" : "ipc",
          homeOf: async (workspaceId, principalId) => await repositories.tasks.homeOf(workspaceId, principalId),
          homeOn: async (workspaceId) => homeChatOn((await repositories.workspaceSettings.get(workspaceId)).settings),
          // A side chat begins from its parent's latest epoch summary and newest saved turns.
          sideChatSeed: async (parent, notice) => {
            const [page, epochSummary] = await Promise.all([
              repositories.transcripts.page(parent.taskId, { limit: SIDE_CHAT_SEED_TURNS }),
              runtime.workflow?.checkpoints.latestEpochSummary?.(parent.threadId),
            ]);
            const seed = buildSideChatSeed({
              parentChatId: parent.taskId,
              turns: page.entries,
              ...(page.nextBefore === undefined ? {} : { older: true }),
              ...(epochSummary === undefined ? {} : { epochSummary }),
              // A reply to a notice quotes the run's output too.
              ...(notice === undefined ? {} : { notice }),
            });
            if (seed === undefined) return undefined;
            // What it quotes carries its sources' labels: the parent's, and the notice's run's.
            const source = notice === undefined ? [] : [(await repositories.tasks.get(notice.sourceTaskId))?.threadId];
            const checkpoints = runtime.workflow?.checkpoints;
            const label = await sideChatSeedLabel(
              [parent.threadId, ...source],
              checkpoints?.contextLabel === undefined ? undefined : async (threadId) => await checkpoints.contextLabel?.(threadId),
            );
            return { ...seed, label };
          },
          noticeSource: (noticeId, parent) => runtime.chatNotices.noticeSource(noticeId, parent),
          // *Do it* and *Chat about this* on a heartbeat item: seeded from the person's own ledger row.
          heartbeatSeed: async (workspaceId, principalId, itemId, action) =>
            await heartbeatItemSeed(repositories.heartbeats, { workspaceId, principalId, itemId }, action, nowTimestamp()),
          // A new Home begins with its "Earlier chats" notice.
          onHomeCreated: (home) => runtime.chatNotices.postEarlierChats(home),
          // A chat an idea's *Try it* started: ideas are the operator's.
          ideaSeeded: async (seed) =>
            await ideaChatSeeded(
              {
                repositories,
                principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
                now: () => new Date(runtime.clock.now()),
                memoryModeOf: async (taskId) => (await repositories.tasks.get(taskId))?.memoryMode,
              },
              seed,
            ),
          ideaPrepared: async (workspaceId, principalId, ideaId) =>
            await ideaPreparedAnswer(
              {
                repositories,
                principalOf: (workspace) => runtime.access.resolveWorkspace(workspace)?.principalId,
                now: () => new Date(runtime.clock.now()),
              },
              workspaceId,
              principalId,
              ideaId,
            ),
          // A new chat's folder or the client's directory; a picker token only on the connection that was issued it.
          folders: runtime.chatFolders,
          redeemPick: (token) => picksOf(state, connection)?.redeem(token),
          conversations: {
            connectionFor: (workspaceId) => runtime.localMessaging.connectionFor(workspaceId),
            holderOf: async (connectionId, conversationId) => {
              const held = state.conversationHolds.get(`${connectionId}\u0000${conversationId}`);
              if (held !== undefined) return held;
              const recorded = await repositories.messagingConversations.get(connectionId, conversationId);
              return recorded === undefined ? undefined : (await repositories.tasks.get(recorded.taskId))?.principalId;
            },
            hold: (connectionId, conversationId, principalId) => {
              const key = `${connectionId}\u0000${conversationId}`;
              state.conversationHolds.set(key, principalId);
              return () => {
                if (state.conversationHolds.get(key) === principalId) state.conversationHolds.delete(key);
              };
            },
            open: async ({ connectionId, conversationId, taskId, principalId, workspaceId }) => {
              const now = runtime.clock.now();
              await bindSender({ repositories, now: () => now }, connectionId, principalId, workspaceId);
              const providerId = runtime.messaging.providerOf(connectionId);
              await repositories.messagingConversations.record({
                connectionId,
                externalConversationId: conversationId,
                taskId,
                createdAt: now,
                ...(providerId === undefined ? {} : { providerId }),
                conversationKind: "direct",
              });
              // A conversation of this task an earlier local `/new` ended (before it was text there) is opened again.
              await repositories.messagingConversations.reopen(connectionId, conversationId, taskId, now);
            },
          },
        },
        value,
      );
    },
    reply: async (value) => {
      // Answered once the message is recorded; its turn goes on, on the
      // conversation's task's stream.
      return await replyToConversation(
        {
          repositories,
          localMessaging: runtime.localMessaging,
          now: () => runtime.clock.now(),
          newId: () => runtime.clock.newId("steer"),
          log: (level, message, fields) => runtime.logger[level](message, fields),
          principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
          // Decided by the connection, not the payload.
          frontEnd: connection?.viaBridge() === true ? "web" : "ipc",
        },
        value,
      );
    },
    agents: async (value) => {
      return await agentsCommand(configDependencies(runtime, state, state.target), value);
    },
    routines: async (routinesInput) => {
      // The canvas never names a host path (I-web): a routine's folder is pinned from a terminal.
      if (connection?.viaBridge() === true) await refuseBridgeRoutineFolder(runtime, routinesInput);
      if (!routinesOfWorkspace) {
        const fromChat = await routineFromChat(routinesInput, {
          task: async (taskId) => await repositories.tasks.get(taskId),
          label: async (task) => await taskContextLabel(runtime, task),
        });
        const result = await routineAction(runtime.routineControl, fromChat);
        return {
          ok: true,
          result:
            routineOwnerRevoked && routinesInput.action === "get" && result !== null && typeof result === "object"
              ? { ...result, ownerRevoked: true }
              : result,
        };
      }
      // Everyone's in the workspace, newest first: the principal's own, each allowed person's, and a revoked person's, marked so.
      const workspaceId = routinesInput.workspaceId;
      const principals = [
        ...new Set([routinesInput.principalId, ...runtime.access.peopleOf(workspaceId), ...(await runtime.routines.owners(workspaceId))]),
      ];
      const lists = await Promise.all(
        principals.map(async (principalId) => {
          const listed = (await routineAction(runtime.routineControl, { ...routinesInput, principalId })) as {
            readonly routines: readonly { readonly routineId: string; readonly updatedAt: string }[];
          };
          return runtime.access.actsIn(workspaceId, principalId)
            ? listed.routines
            : listed.routines.map((routine) => ({ ...routine, ownerRevoked: true }));
        }),
      );
      const routines = lists
        .flat()
        .sort((a, b) => (a.updatedAt === b.updatedAt ? a.routineId.localeCompare(b.routineId) : b.updatedAt.localeCompare(a.updatedAt)));
      return { ok: true, result: { routines: routines.slice(0, routinesInput.limit ?? 100) } };
    },
    router: async (value) => {
      return {
        ok: true,
        result: await routerCommand(
          {
            repository: runtime.routerRepository,
            service: runtime.router,
            accounting: runtime.modelAccounting,
            readSecret: runtime.readSecret,
            now: () => runtime.clock.now(),
            providerState: async (providerId) =>
              await routerProviderState(runtime.plugins.registry, providerId, { ...runtime.plugins, providers: runtime.routerProviders }),
            providerCandidate: async (providerId) => await routerProviderCandidate(runtime.plugins.registry, providerId),
            providerReadiness: runningProviderReadiness(runtime.routerProviders),
            providerPricing: async (providerId) =>
              await routerProviderPricing(runtime.plugins.registry, providerId, runtime.routerProviders),
          },
          value,
        ),
      };
    },
    models: async (input) => {
      const answer = await modelsCommand(configDependencies(runtime, state, await ownerTarget(), connection), input);
      if (answer.ok && !MODELS_READS.has(input.action)) await refreshProvidersAfterWrite();
      return answer;
    },
    channels: async (value) => {
      try {
        return await channelsCommand(channelsDependencies(runtime), value);
      } catch (error) {
        // Its refusal's words are the terminal's; the facts the page words it from go along (QA 2033).
        const details = channelsPageDetails(TaviError.from(error));
        if (details === undefined) throw error;
        return refusalFrom(error, details);
      } finally {
        await refreshAccountTools(runtime);
        // Allowing, revoking, pairing or removing a connection changes who acts in the workspace, even part way.
        if (PEOPLE_ACTIONS.has(value.action)) await refreshPeopleAfterChange();
      }
    },
    "ui-preferences": async (value) => {
      return uiPreferencesCommand(runtime.dataDirectory, value);
    },
    credentials: async (input) => {
      const answer = await credentialsCommand(configDependencies(runtime, state, state.target, connection), input);
      if (answer.ok && input.action !== "list") await refreshProvidersAfterWrite();
      return answer;
    },
    projects: async (value) => {
      return await projectsCommand(configDependencies(runtime, state, state.target), value);
    },
    reports: async (value) => {
      return await reportsCommand(configDependencies(runtime, state, state.target), value);
    },
    schedules: async (value) => {
      return await schedulesCommand(configDependencies(runtime, state, await ownerTarget()), value);
    },
    search: async (input) => {
      const answer = await searchCommand(configDependencies(runtime, state, state.target), input);
      if (answer.ok && input.action !== "list" && input.action !== "test") await refreshProvidersAfterWrite();
      return answer;
    },
    permissions: async (value) => {
      return permissionsCommand(
        {
          repositories: runtime.store.asPort().repositories,
          rulesInForce: runtime.toolRulesInForce,
          now: () => runtime.clock.now(),
          chatGrants: runtime.chatGrants,
          fromBridge: connection?.viaBridge() === true,
          via: connection?.viaBridge() === true ? "bridge" : "ipc",
        },
        value,
      );
    },
    plugins: async (value) => {
      // Operator-only (CLI or canvas), never a tool: plugin code runs with the owner's privileges.
      return await pluginsCommand(runtime, value, operatorActor(connection?.viaBridge() === true));
    },
    mcp: async (value) => {
      // Operator-only as plugins are: probing runs a server's code, approving trusts its tools.
      return await mcpCommand(runtime, value, operatorActor(connection?.viaBridge() === true));
    },
    apps: async (value) => {
      // Operator-only like `mcp` and `plugins`, whose commands it calls: a page meets their refusals.
      // A shared client changes through the channels command, which signs a channel's older sign-ins out.
      try {
        return await appsOwnerCommand(runtime, value, operatorActor(connection?.viaBridge() === true), {
          channels: (payload) => channelsCommand(channelsDependencies(runtime), payload),
          declineConnect: (waitId, workspaceId) => runtime.connectWaits.decline(waitId, workspaceId),
        });
      } finally {
        // A mailbox opt-in, or a connection added or signed out, changes which accounts have tools.
        await refreshAccountTools(runtime);
      }
    },
    "system-prompt": async (value) => {
      // `connection` is passed, not omitted: it is the only producer of
      // `fromBridge`, and without it every Settings-editor save would be
      // attributed to the CLI.
      return await systemPromptCommand(configDependencies(runtime, state, state.target, connection), value);
    },
    "workspace-settings": async (value) => {
      // `connection` for the same reason: it attributes a Settings save to the page.
      return await workspaceSettingsCommand(configDependencies(runtime, state, state.target, connection), value);
    },
    center: async (value) => {
      // A `watch` may wait up to 25 s: it ends early when its client goes
      // away or the owner starts to shut down.
      const closed = new AbortController();
      const release = connection.onClose(() => closed.abort());
      try {
        return await centerCommand(
          {
            repositories,
            memory: runtime.memory,
            principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
            now: () => new Date(runtime.clock.now()),
            appRepairs: async (workspaceId) => {
              const apps = await appsOfWorkspace(runtime, workspaceId);
              return apps === undefined ? undefined : appRepairList(apps);
            },
            healthWarnings: () => state.health.growth().map((growth) => growth.warning),
            signal: AbortSignal.any([closed.signal, state.shutdown.signal]),
            // A waiting watch answers as soon as a write moves the Center, not at its next one-second read.
            onWrite: (listener) => runtime.store.onWrite(listener),
          },
          value,
        );
      } finally {
        release();
      }
    },
    skills: async (value) => {
      // The operator's: as the workspace's principal, a change attributed to the page or the CLI.
      return await skillsOwnerCommand(
        {
          service: new SkillService(runtime.store.asPort()),
          skills: repositories.skills,
          readArtifactBody: async (artifactId) => await runtime.store.readArtifactBody(artifactId),
          principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
          readTaskTools: storeTaskTools(runtime.store),
          now: () => runtime.clock.now(),
          fromBridge: connection?.viaBridge() === true,
        },
        value,
      );
    },
    memory: async (value) => {
      // Reviews and edits are the operator's: `fromBridge` attributes one to the page.
      return await memoryCommand(
        {
          memory: runtime.memory,
          repositories,
          principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
          fromBridge: connection?.viaBridge() === true,
          now: () => new Date(runtime.clock.now()),
          memorySettings: runtime.memorySettings,
          // A *Keep longer* date holds through its day in the workspace's zone.
          timeZoneOf: workspaceZoneOf(repositories.workspaceSettings),
          // A card's Keep all posts its receipt card.
          newId: (prefix) => runtime.clock.newId(prefix),
          // The workspace's memory provider and its egress.
          providers: { settings: repositories.workspaceSettings, providers: runtime.memoryProviders, sync: runtime.memoryProviderSync },
          // The memory host's jobs on demand (`tavi memory reindex`, `review-now`, `consolidate-now`).
          jobs: runtime.memoryJobs,
          // A forget's receipt names the channels whose card messages cannot be edited.
          channelNote: async (recordId) => memoryUnreachedNote((await runtime.memoryChannelCards.beforeForget(recordId)).unreached),
        },
        value,
      );
    },
    reminders: async (value) => {
      // The operator's view of every person's reminders, and the operator's edits.
      return await remindersCommand(
        {
          repositories,
          principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
          now: () => new Date(runtime.clock.now()),
          conversationAllowed: runtime.reminderConversationAllowed,
        },
        value,
      );
    },
    heartbeat: async (value) => {
      // The operator's heartbeat: Check now reaches this owner's host.
      return await heartbeatCommand(
        {
          repositories,
          principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
          options: runtime.heartbeat.options,
          providers: () => runtime.heartbeat.providers.list(),
          providerStates: runtime.heartbeat.providerStates,
          toolChoices: () => runtime.heartbeat.toolChoices(),
          sources: () =>
            runtime.heartbeat.signals.list().map(({ id, kind, label }) => (label === undefined ? { id, kind } : { id, kind, label })),
          host: () => runtime.heartbeat.host(),
          // The first-run offer, when a built-in source has something to watch for this person.
          offerInstructions: async (scope) => await heartbeatOfferInstructions(runtime.heartbeat.signals, scope),
          author: "ipc",
          now: () => new Date(runtime.clock.now()),
        },
        value,
      );
    },
    ideas: async (value) => {
      // Ideas: the tab, the empty chat's suggested prompts and `tavi ideas`.
      // Refresh asks the selected provider through the host, which also runs each workspace daily.
      return await ideasCommand(
        {
          repositories,
          principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
          now: () => new Date(runtime.clock.now()),
          census: runtime.ideas.census,
          providers: () => ideasProviderViews(runtime.ideas.providers.list()),
          refresh: async (workspaceId) => await runtime.ideas.host.refresh(workspaceId),
          nextRunAt: async (workspaceId) => await runtime.ideas.host.nextAt(workspaceId),
          continueChat: runtime.ideas.continueChat,
          digestReachable: runtime.ideas.digestReachable,
          chatTitle: async (workspaceId, taskId) => {
            const task = await repositories.tasks.get(taskId);
            // The operator's own chat only: anyone else's is never named to them.
            const own = task?.workspaceId === workspaceId && task.principalId === runtime.access.resolveWorkspace(workspaceId)?.principalId;
            return own && typeof task.title === "string" && task.title !== "" ? task.title : undefined;
          },
          routineExists: async (workspaceId, principalId, routineId) => {
            try {
              await runtime.routines.get({ workspaceId, principalId }, routineId);
              return true;
            } catch (error) {
              if (TaviError.from(error).code === "NOT_FOUND") return false;
              throw error;
            }
          },
          modelSet: async (workspaceId) =>
            (await repositories.modelConfig.listRoleBindings(workspaceId)).some((binding) => binding.role === "fast"),
          fromBridge: connection?.viaBridge() === true,
        },
        value,
      );
    },
    onboarding: async (value) => {
      // Onboarding: the operator's status, flow and marks; it writes only its own tables.
      // A connection or key it added is read like one `models` or `credentials` added, once the call is done.
      let wrote = false;
      try {
        return await onboardingCommand(
          onboardingDependencies(runtime, state, await ownerTarget(), connection, () => {
            wrote = true;
          }),
          value,
        );
      } finally {
        if (wrote) await refreshProvidersAfterWrite();
      }
    },
    approve: async (value) => {
      // A round, decided under its own key with the round as the in-queue
      // precondition; answered once the decision is claimed.
      // `via` names the front end for the audit trail and for the origin an
      // `always` rule records: the canvas's bridge, or any other IPC client.
      return await decideRound(decisionDependencies(runtime, await ownerTarget()), {
        ...value,
        via: connection?.viaBridge() === true ? "bridge" : "ipc",
      });
    },
    artifacts: async (payload) => {
      // `read` serves browser thumbnails only; a list has no action.
      if ("action" in payload && payload.action === "upload") {
        const putStagedArtifact = repositories.artifacts.putStagedArtifact;
        if (putStagedArtifact === undefined)
          return { ok: false, error: { code: "UNSUPPORTED", message: "this owner's store takes no uploads" } };
        return await artifactsUploadCommand(
          {
            artifacts: { putStagedArtifact: putStagedArtifact.bind(repositories.artifacts) },
            stagingDirectory: join(runtime.dataDirectory, "artifacts", ARTIFACT_STAGING_DIRECTORY),
            principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
            now: () => runtime.clock.now(),
            pdfEnabled: async (workspaceId) => pdfToolsOn((await repositories.workspaceSettings.get(workspaceId)).settings),
            // Only where the video tools are offered (FFmpeg found) and on in the workspace: else nothing could read it.
            videoEnabled: async (workspaceId) =>
              runtime.tools.get("video.frames") !== undefined &&
              videoToolsOn((await repositories.workspaceSettings.get(workspaceId)).settings),
            uploads: uploadsOf(state, connection),
            checkSpace: () => runtime.folderSpace.checkFloor(),
          },
          payload,
        );
      }
      if ("action" in payload) return await artifactsReadCommand(browserDependencies(runtime, repositories), payload);
      return { ok: true, result: await runtime.store.listArtifacts(payload) };
    },
    browser: async (value) => {
      // Browser history (scrubbed URLs and titles, per task), and the operator's close.
      return await browserCommand(browserDependencies(runtime, repositories), value);
    },
    "browser-live": async (value) => {
      // The live browser view: watch, credit, unwatch.
      return await browserLiveCommand(
        {
          hub: runtime.liveHub,
          knownWorkspace: (workspaceId) => runtime.access.resolveWorkspace(workspaceId) !== undefined,
          actor: operatorActor(connection?.viaBridge() === true),
        },
        value,
        connection,
        requestId,
      );
    },
    "chat-context": async (value) => {
      // A chat's own instructions, saved under the front end that asked.
      return await chatContextCommand(
        {
          repositories,
          author: operatorActor(connection?.viaBridge() === true),
          principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
          now: () => runtime.clock.now(),
          pruneCheckpoints: (threadId) => runtime.store.checkpoints.pruneThread({ threadId, keep: CHECKPOINTS_KEPT }),
          requestFreshContext: runtime.requestFreshContext,
          epochSummary: async (threadId) => runtime.workflow?.checkpoints.latestEpochSummary?.(threadId),
          // A forget also takes the chat's fold archives and the memory it made.
          memory: runtime.memory,
          dropRetainedEvents: (taskId, before) => void runtime.runEventBus.dropRetained(taskId, before),
          folderOf: async (workspaceId, taskId) => await measureFolder(await runtime.chatFolders.managedFolderPath(workspaceId, taskId)),
        },
        value,
      );
    },
    folder: async (value) => {
      // A chat's working folder: shown, changed from the chat's next message, listed and downloaded.
      const picks = picksOf(state, connection);
      return await folderCommand(
        {
          folders: runtime.chatFolders,
          repositories,
          principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
          frontEnd: connection?.viaBridge() === true ? "web" : "ipc",
          readScope: runtime.folderReads,
          space: runtime.folderSpace,
          ...(picks === undefined ? {} : { picks }),
        },
        value,
      );
    },
    browse: async (value) => {
      // The canvas's attach picker: folders under the roots, each by a token issued on this connection (I-web).
      const picks = picksOf(state, connection);
      return await browseCommand(
        {
          folders: runtime.chatFolders,
          principalOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
          ...(picks === undefined ? {} : { picks }),
        },
        value,
      );
    },
    review: async (value) => {
      // Artifact decisions, and with `resume` the review suspension's
      // acknowledgement under its own key.
      return await reviewRound(
        {
          ...decisionDependencies(runtime, await ownerTarget()),
          now: () => runtime.clock.now(),
          materializeArtifact: runtime.materializeArtifact,
        },
        value,
      );
    },
    abort: async (value) => {
      // Signals the *current* admission's controller from the decorator's
      // registry, so it reaches a resumed turn and not only an
      // IPC-started one. Distinct from `cancel`, which also ends the task on the ledger.
      const input = value;
      if ((await repositories.tasks.get(input.taskId)) === undefined) {
        return refuseKeyed("NOT_FOUND", "error.task.notFound", { taskId: input.taskId });
      }
      const signal = runtime.abortRegistry.signalFor(input.taskId);
      if (signal === undefined) {
        return {
          ok: false,
          error: {
            code: IPC_NOT_RUNNING,
            message: `Task ${input.taskId} has no running admission; use \`tavi cancel ${input.taskId}\` to cancel it`,
          },
        };
      }
      runtime.abortRegistry.abort(input.taskId);
      return { ok: true, result: { aborted: true } };
    },
    doctor: async () => {
      // `skip`: either integrity check (quick or `--deep`) reads every page synchronously, and this runs in
      // the daemon's own event loop — an attached `doctor` would freeze IPC and
      // the scheduler for the duration. The report says the
      // check was skipped, and the direct path still runs it.
      return { ok: true, result: await buildDoctorDocument(runtime, { integrity: "skip", health: await state.health.trend() }) };
    },
    cancel: async (value) => {
      // Required by the schema: a payload without them never reaches here.
      const input = value;
      const cancelled = await repositories.tasks.get(input.taskId);
      if (cancelled === undefined) {
        return refuseKeyed("NOT_FOUND", "error.task.notFound", { taskId: input.taskId });
      }
      // Home never ends: Stop aborts its turn, and nothing cancels the chat.
      if (cancelled.chatKind === "home") return refuseKeyed("CONFLICT", "error.task.homeNeverCancelled");
      const { record, cancelledApprovals } = await recordCancellation(
        runtime.store,
        {
          taskId: input.taskId,
          reason: input.reason,
          operator: input.operator ?? "operator",
        },
        () => runtime.clock.now(),
      );
      // The record stops what comes next; a turn running now hears of it here, or it would answer in full.
      runtime.abortRegistry.abort(input.taskId);
      // A scheduled run that will not go on now frees its schedule at once, not at its wait's deadline.
      if (runtime.scheduleDependencies !== undefined) await releaseEndedHolds(runtime.scheduleDependencies, runtime.clock.now());
      return { ok: true, result: { ...record, cancelledApprovals } };
    },
    recover: async (value) => {
      // `taskId` and `generation` are required by the schema.
      const input = value;
      const document = await terminateExecution(
        runtime.store,
        {
          taskId: input.taskId,
          generation: input.generation,
          reason: input.reason ?? "",
          operator: input.operator ?? "operator",
        },
        () => runtime.clock.now(),
      );
      return { ok: true, result: document };
    },
    shutdown: async (input) => {
      // Acknowledged before it is acted on: the client must not wait for the
      // server it is talking to to disappear.
      setImmediate(() => requestShutdown(input?.reason ?? "requested over IPC"));
      return { ok: true, result: { stopping: true } };
    },
    "plugin-commands": async (value) => {
      // Plugins' slash commands: listed for a front end's help, and run — answered by the plugin, never a turn.
      const payload = value;
      if (payload.action === "list") return { ok: true, result: { commands: runtime.turnHooks.commands() } satisfies PluginCommandsAnswer };
      const workspaceId = payload.workspaceId ?? "default";
      const principalId = runtime.access.resolveWorkspace(workspaceId)?.principalId;
      if (principalId === undefined)
        return { ok: false, error: { code: "NOT_AUTHORIZED", message: `no operator acts in workspace ${workspaceId}` } };
      // The chat's task only when it is this workspace's and this person's, as `approvals show` holds it.
      const named = payload.taskId === undefined ? undefined : await repositories.tasks.get(payload.taskId);
      const taskId =
        named !== undefined && named.workspaceId === workspaceId && named.principalId === principalId
          ? named.taskId
          : prefixedId("command");
      const viaBridge = connection?.viaBridge() === true;
      const envelope: ModEnvelope = Object.freeze({
        workspaceId,
        principalId,
        taskId,
        runId: taskId,
        source: viaBridge ? "web" : "ipc",
        frontEnd: viaBridge ? ("web" as const) : ("ipc" as const),
        attended: true,
      });
      const answer = await runtime.turnHooks.runCommand(payload.name.toLowerCase(), { envelope, args: payload.args });
      if (answer === undefined) return refuseKeyed("NOT_FOUND", "error.plugin.noCommand", { name: payload.name });
      return { ok: true, result: { text: maskPluginText(answer.text, MOD_COMMAND_TEXT_MAX_CHARS) } satisfies PluginCommandsAnswer };
    },
    "reset-instance": async () => {
      // The payload schema already demanded the typed confirmation. Deleting
      // waits for the owner to stop: its database is open until then.
      state.resetRequested = true;
      // Read before the stop: an external memory provider's own index is not the reset's to reach.
      const memoryProviders = await runtime.memoryProviderSync.selectedExternal().catch(() => []);
      setImmediate(() => requestShutdown("instance reset requested"));
      return {
        ok: true,
        result: { resetting: true, ...(memoryProviders.length === 0 ? {} : { memoryProviders }) } satisfies ResetInstanceResult,
      };
    },
  };
  try {
    // The schema parsed the payload for this command: the route takes it as its own.
    return await (routes[command as IpcCommand] as (value: unknown) => Promise<CommandAnswer>)(parsed.value);
  } catch (error) {
    return refusalFrom(error);
  }
}

/**
 * Where the owner binds: a socket file in the private `runtime/` directory; on
 * Windows a named pipe under a fresh random name, published through discovery
 * as the socket is.
 */
function ownerEndpoint(dataDirectory: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? newPipeEndpoint() : ipcPaths(dataDirectory).socketPath;
}

/**
 * Remove a socket file left behind by a crashed owner.
 *
 * Only a socket is removed. Anything else at the endpoint path — a regular file,
 * or a symlink the operator may not have created — is reported instead of
 * clobbered, because deleting it could destroy unrelated data.
 */
function discardStaleSocket(endpoint: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isSocket()) {
    throw new TaviError("UNAVAILABLE", `${endpoint} exists and is not a socket; move it aside before starting the owner`);
  }
  unlinkSync(endpoint);
}

/** Run a promise under a deadline; `"timeout"` means the deadline expired. */
async function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    // `finally`, not a trailing statement: a rejecting `work` used to throw
    // straight past the clear, leaving the timer scheduled.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The one answer for a task that does not exist and one in another workspace, so a read never says which. */
function taskNotFound(
  task: { readonly workspaceId: string } | undefined,
  input: { readonly taskId: string; readonly workspaceId?: string | undefined },
): IpcRefusal | undefined {
  if (task !== undefined && (input.workspaceId === undefined || task.workspaceId === input.workspaceId)) return undefined;
  return refuseKeyed("NOT_FOUND", "error.task.notFound", { taskId: input.taskId });
}
