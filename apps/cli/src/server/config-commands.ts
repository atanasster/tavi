import { readAgentTree } from "../features/agents/tree.js";
import { channelDescriptorOf, channelDescriptors } from "../features/channels/catalog.js";
import { pluginChannelPurgePreview, rememberedAccount, schedulePluginChannelPurges } from "../features/channels/purge.js";
import { runPluginAction } from "../features/plugins/actions.js";
import { localizedChannelDescriptors, localizedSnapshotManifest, pluginSnapshots } from "../features/plugins/localized.js";
import type { Locale } from "@tavi/contracts/i18n";
import { runMcpAction } from "../features/mcp/actions.js";
import { mcpRemovalDeps, removeMcpServer } from "../features/mcp/remove.js";
import { mcpSearchLines } from "../features/mcp/bridge.js";
import { MCP_REGISTRY_SETTING } from "../features/mcp/registry.js";
import { mcpAccountPersonal } from "../features/apps/sharing.js";
import { appsCommand } from "../features/apps/owner.js";
import { snapshotSiteNotes, snapshotSites } from "../features/apps/registry.js";
import { routineScheduleAction } from "../features/routines/actions.js";
import type { RoutineService } from "@tavi/runtime";
import {
  MCP_ENABLED_SETTING,
  mcpEnabledOf,
  DEFAULT_WORKSPACE_ID,
  AGENTS_MAILBOX_LIMIT,
  TaviError,
  type AgentsListResult,
  type AgentsMailbox,
  type AgentsPayload,
  type CredentialsPayload,
  type ModelConnection,
  type ModelsPayload,
  type ModelsWriteResult,
  type PersistencePort,
  type ProjectsPayload,
  type ReportsPayload,
  type ScheduleRecord,
  type SchedulesListResult,
  type SchedulesPayload,
  type ModelTarget,
  type ChatModel,
  type TaskRoutingPort,
  type SearchPayload,
  type SearchWriteResult,
  type SystemPromptAnswer,
  type AgentDefinition,
  type SystemPromptPayload,
  type SystemPromptPreview,
  type SystemPromptRepositoryPort,
  type WorkspaceSystemPromptRecord,
  type WebSearchKind,
  WEB_SEARCH_KINDS,
  hostTimeZone,
  localeOf,
  type TaintMode,
  type ChatInstructionsRevision,
  type ToolDefinition,
  englishOf,
  navPath,
} from "@tavi/contracts";
import type { ModelConfigPort as ModelConfigService } from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import type { FireOutcome } from "@tavi/agent-host/schedule-scheduler";
import {
  DEFAULT_SYSTEM_PROMPT,
  SHIPPED_SYSTEM_PROMPT_VERSION,
  composeSystemPromptLayers,
  sampleRuntimeFacts,
  snapshotBase,
} from "@tavi/agent-host/system-prompt";
import { defaultEstimateTokens } from "@tavi/agent-host/context";

import {
  assertSecretReference,
  createLocalCredentialStore,
  credentialKeyFile,
  credentialKeyLocation,
  moveCredentialKey,
  encryptCredentialDirectory,
  listCredentialRefs,
  plainCredentialValue,
  serializeCredentialAction,
} from "../features/credentials/store.js";
import { refusalFrom, refuse, targetRefusal, type IpcAnswer } from "../shared/ipc-decisions.js";
import { join } from "node:path";
import { sleep } from "@tavi/node-kit";

import { probeVideoDecoder } from "../features/video/host.js";
import {
  connectionDocument,
  connectionRecord,
  connectionsNaming,
  connectionSummaries,
  discoverAndRecord,
  modelRolesDocument,
  ownLocalCredential,
  sharedCredentialWarning,
  storeLocalPlaceholder,
  storedCredentialRefs,
  unlistedModelWarning,
  probePdfAndRecord,
  probeVideoAndRecord,
  setVideoModelAndReport,
  testAndRecord,
} from "../features/models/actions.js";
import type { OwnerModelTarget } from "../features/run/owner.js";
import { resolveLiveTarget } from "../features/models/target.js";
import type { LifecycleSyncNoKey, LifecycleSyncReport, StoredLifecycleReport } from "../features/models/lifecycle-sync.js";
import type { ReplacePreview, ReplaceResult } from "../features/models/replace.js";
import {
  resolveSchedule,
  scheduleAgenda,
  scheduledWorkThisMonth,
  scheduleHistory,
  scheduleShow,
  schedulePreview,
  scheduleTools,
  setScheduleEnabled,
  writeSchedule,
} from "../features/schedules/actions.js";
import { setScheduleWebhook } from "../features/schedules/webhook.js";
import { setScheduleEmailTrigger } from "../features/schedules/email-trigger.js";
import { createWebSearchAdapter, searchKeyProblem } from "../features/search/web-search.js";
import type { VoiceSetup } from "../features/video/voice-setup.js";

/**
 * The configuration commands an attached client may run against the owner
 * `agents` (read-only), `models`, `credentials`, `projects`, `schedules`
 * and `search` — the subset a
 * UI needs. `memory export`, `skills` and `bindings` keep
 * refusing under an owner.
 *
 * Each answers what its offline command answers: where an action is more than
 * one store call its result is built by the same function (`features/models/actions.ts`,
 * `features/schedules/actions.ts`), so the two front ends cannot drift. Lists are the
 * exception, projected and bounded to fit one IPC frame.
 */

export interface ConfigDependencies {
  readonly modelConfig: ModelConfigService;
  /**
   * The owner's MCP budget: refuses allowing a server in a workspace whose listed MCP tools it would overflow,
   * and checks every workspace again after `mcp.servers` changes. Absent offline: the next start checks.
   */
  readonly mcpBudget?: {
    readonly checkEnable: (pluginId: string, workspaceId: string, alsoAllowed: readonly string[]) => Promise<void>;
    readonly recheck: () => Promise<void>;
  };
  readonly routines?: RoutineService;
  /**
   * Whether a principal acts in a workspace: its own, or a person allowed there.
   * A schedule of one no longer allowed can be shown, paused and removed, nothing
   * more; one is never made for anyone else. Absent (offline), nothing is refused.
   */
  readonly actsIn?: (workspaceId: string, principalId: string) => boolean;
  /** The principal a workspace belongs to: whom a schedule added with none named is for. */
  readonly workspacePrincipal?: (workspaceId: string) => string | undefined;
  /** Prune the memory vectors no workspace may keep (`pruneMemoryVectors`), after a memory write ends hybrid or personal embedding. */
  readonly pruneMemoryVectors?: () => Promise<number>;
  readonly taskNeeds?: (
    workspaceId: string,
    taskIds: readonly string[],
  ) => Promise<Readonly<Record<string, import("@tavi/contracts").TaskListRow["needs"]>>>;
  /** A worker's latest activity for `agents tree`: its live stream's, else its last saved turn's. */
  readonly workerActivity?: (taskId: string, status: string) => Promise<import("@tavi/contracts").AgentTreeActivity | undefined>;
  readonly repositories: Pick<
    PersistencePort["repositories"],
    | "agents"
    | "agentMailbox"
    | "agentDelegations"
    | "center"
    | "modelConfig"
    | "projects"
    | "reports"
    | "schedules"
    | "searchProviders"
    | "skills"
    | "systemPrompts"
    | "tasks"
    | "workspaceSettings"
    | "chatInstructions"
    | "messagingConnections"
    | "messagingConversations"
    | "memory"
    | "mcp"
  > &
    Partial<Pick<PersistencePort["repositories"], "heartbeats" | "channelIngress">>;
  /** The references the owner's launcher bound (a provider's `--api-key-file`, …): never a search provider's. */
  readonly launcherBindings?: readonly string[];
  /** `search test`'s transport; `fetch` otherwise (a test's stub). */
  readonly searchFetch?: typeof globalThis.fetch;
  readonly dataDirectory: string;
  /** `serve --video-ffmpeg` / `--video-ffprobe`: the FFmpeg the owner's video tools use, which a video probe uses too. */
  readonly videoBinaries?: { readonly ffmpeg?: string; readonly ffprobe?: string };
  /** `models video-status`: doctor's `video` section. */
  readonly videoStatus: () => Promise<Record<string, unknown>>;
  /** `models voice-status` / `voice-setup`: voice messages' transcription, and the job that installs it; absent offline. */
  readonly voice?: VoiceSetup;
  /** `models sync`: what Rhumb says of the models in use, stored; absent offline, where the CLI composes its own runtime. */
  readonly lifecycleSync?: () => Promise<LifecycleSyncReport | LifecycleSyncNoKey>;
  /** `models lifecycle`: what the last sync stored of the models in use, for today; absent offline. */
  readonly lifecycleReport?: () => Promise<StoredLifecycleReport>;
  /** `models replace`: what moving one model to another would change, or the change made; absent offline. */
  readonly replaceModel?: (
    from: ModelTarget,
    to: ModelTarget,
    workspaceId: string,
    confirmed: boolean,
  ) => Promise<ReplacePreview | ReplaceResult>;
  /** The target the owner runs now, in the command's workspace. */
  readonly target: OwnerModelTarget;
  /** What `models chat` and `set-chat` read and save a chat's own model through; absent, an owner with no model routing. */
  readonly taskRouting?: TaskRoutingPort;
  /** The connections the owner was launched with: a credential bound to one of them stays with its origin. */
  readonly startupProviders: readonly { readonly baseUrl: string; readonly credentialRef: string }[];
  /** The owner's own credential chain, for `models test|discover`. */
  readonly readSecret: (credentialRef: string) => Promise<string | null>;
  /**
   * What a request to a model sends: a ChatGPT sign-in's access token,
   * renewed when due. Presence checks read `readSecret`, which never
   * renews. Absent, `readSecret`.
   */
  readonly modelCredential?: (credentialRef: string) => Promise<string | null>;
  /**
   * References an attached client wrote a value to through this owner
   * (`credentials set`): it knows them, so a connection may name them at any
   * origin. Forgotten on `delete`; held in memory, for this owner only.
   */
  readonly credentialsWritten?: Set<string>;
  /** The request came through `tavi ui`'s bridge — a page's. */
  readonly fromBridge?: boolean;
  /** The owner's `serve --taint-policy`, which overrides every workspace's `security.taint`. */
  readonly taintPolicy?: TaintMode;
  /** The built-in plugins turned off: a workspace settings answer names them, so a page hides what only they read. */
  readonly disabledPlugins?: () => Promise<ReadonlySet<string>>;
  /**
   * Whether `workspaceId` is one this owner was configured with.
   * Absent on the offline path, which has no grant map.
   */
  readonly knownWorkspace?: (workspaceId: string) => boolean;
  /**
   * Whether this owner's workflow adapter was built with an explicit system
   * prompt, which outranks the workspace setting. Always false for a composed
   * runtime today; reported so the editor never implies a save took
   * effect somewhere it did not.
   */
  readonly explicitSystemPrompt?: boolean;
  /** The context budget a preview measures a chat's fixed prompt against; absent, no budget is said. */
  readonly contextBudgetTokens?: (workspaceId: string) => Promise<number>;
  readonly now: () => Date;
  /**
   * Fire a schedule now, answering once its run is admitted (`schedules run`).
   * Undefined when the owner has no model connection to run it with.
   */
  readonly fireNow?: (schedule: ScheduleRecord) => Promise<ScheduleRunAnswer>;
  /** The tools registered on this owner and their effects, for `schedules tools`; absent offline, where none is offered. */
  readonly registeredTools?: () => readonly Pick<ToolDefinition, "id" | "effect">[];
  /** Whether a fire of the schedule — scheduled or manual — is in flight here. */
  readonly fireInFlight?: (scheduleId: string) => boolean;
  /** The `--fs-root` rule for a `file-changed` pre-check's file; absent offline, where no such pre-check is saved. */
  readonly precheckFile?: (path: string) => string;
  /** The owner's site profiles for a page or feed pre-check's address; absent offline. */
  readonly precheckSite?: (workspaceId: string, url: string) => Promise<string | undefined>;
  /** The rule a schedule's working folder is held to (`ChatFolders.checkPrimary`); absent offline, where none is saved. */
  readonly scheduleFolder?: (path: string) => string;
  /**
   * Opens or closes the ingress, and reloads the owner's webhook ids, after a schedule's webhook was turned on or off or
   * its schedule removed; absent offline, where none listens.
   */
  readonly webhookChanged?: () => Promise<void>;
  /** Matches the file watchers to the stored schedules after a write; absent offline, where none watches. */
  readonly schedulesChanged?: () => Promise<void>;
}

/**
 * The actor label for a configuration write.
 *
 * Which front end asked, not who the caller is: `viaBridge` is the value an
 * authenticated local client put in its own hello, so any local client can claim
 * it. The *authority* is the socket and the bearer token; this label is
 * attribution metadata only, and keeping the expression in one
 * place is what stops the owner path and the offline path from disagreeing.
 */
export function operatorActor(fromBridge: boolean | undefined): string {
  return fromBridge === true ? "operator:ui" : "operator:cli";
}

/** What `schedules run` answers: the admitted run's task, or the fire's outcome when it ran nothing. */
export type ScheduleRunAnswer = IpcAnswer<{ readonly taskId?: string; readonly outcome?: FireOutcome }>;

/** The most rows a list answers with, so the answer fits one IPC frame (1 MiB); `truncated` says when more exist. */
const CONFIG_LIST_LIMITS = { agents: 500, schedules: 500, projects: 100, searchProviders: 100 } as const;

export const workspaceOf = (input: { readonly workspaceId?: string | undefined }): string => input.workspaceId ?? DEFAULT_WORKSPACE_ID;

/**
 * Run a handler, answering a thrown `TaviError` as its code. The dispatcher
 * would map a throw the same way; doing it here keeps each handler's answer
 * whole wherever it is called from — its own tests included.
 */
export async function answering<R>(
  handler: () => Promise<R> | R,
  detailsOf?: (failure: TaviError) => Readonly<Record<string, unknown>> | undefined,
): Promise<IpcAnswer<R>> {
  try {
    return { ok: true, result: await handler() };
  } catch (error) {
    return refusalFrom(error, detailsOf?.(TaviError.from(error)));
  }
}

export const required = (value: string | undefined, name: string, action: string): string => {
  if (value === undefined) throw new TaviError("INVALID_INPUT", `${action} needs ${name}`);
  return value;
};

const bounded = <T>(rows: readonly T[], limit: number): { readonly rows: readonly T[]; readonly truncated: boolean } => ({
  rows: rows.slice(0, limit),
  truncated: rows.length > limit,
});

/**
 * `agents` — shared owner reads and mutations. The
 * list gives each definition without its `systemPrompt`: up to 20,000
 * characters each, the full list would not fit one frame. `show` gives one
 * whole, as `tavi agents show` does. A `list` naming a task also reports that
 * task's mailbox.
 */
export function agentsCommand(deps: ConfigDependencies, input: AgentsPayload): Promise<IpcAnswer<unknown>> {
  return answering(async () => {
    const workspaceId = workspaceOf(input);
    const agents = deps.repositories.agents;
    const now = deps.now().toISOString();
    // A version asserted on an action that writes no existing row would look
    // honoured while checking nothing.
    if (input.expectedUpdatedAt !== undefined && input.action !== "update" && input.action !== "enable" && input.action !== "disable") {
      throw new TaviError("INVALID_INPUT", "only agents update, enable and disable take expectedUpdatedAt");
    }
    if (input.action === "add" || (input.action === "update" && input.name !== undefined)) {
      // An id another differs from only in case, or a name another has, is a pair nobody can tell apart:
      // agents.spawn takes either in any case, and a channel's @mention names the agent (Mac mini adversarial tests).
      const agentId = input.agentId ?? "";
      const others = (await agents.list(workspaceId)).agents.filter((agent) => agent.agentId !== agentId);
      const sameId = input.action === "add" ? others.find((agent) => agent.agentId.toLowerCase() === agentId.toLowerCase()) : undefined;
      if (sameId !== undefined)
        throw new TaviError("CONFLICT", `agent ${sameId.agentId} is already here: an id may not differ from another's only in case`);
      const name = input.name?.trim().toLowerCase();
      const sameName = others.find((agent) => agent.name.trim().toLowerCase() === name);
      if (sameName !== undefined)
        throw new TaviError("CONFLICT", `agent ${sameName.agentId} is already named ${sameName.name}: give this one another name`);
    }
    if (input.action === "add")
      return await agents.create({
        workspaceId,
        agentId: required(input.agentId, "an agentId", "agents add"),
        name: required(input.name, "a name", "agents add"),
        systemPrompt: required(input.prompt, "a prompt", "agents add"),
        ...(input.description === undefined || input.description === "" ? {} : { description: input.description }),
        enabled: true,
        now,
      });
    if (input.action === "remove") {
      const agentId = required(input.agentId, "an agentId", "agents remove");
      return { removed: agentId, existed: await agents.remove(workspaceId, agentId) };
    }
    if (input.action === "update" || input.action === "enable" || input.action === "disable") {
      const agentId = required(input.agentId, "an agentId", `agents ${input.action}`);
      const updated = await agents.update({
        workspaceId,
        agentId,
        now,
        ...(input.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: input.expectedUpdatedAt }),
        ...(input.action === "update"
          ? {
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.prompt === undefined ? {} : { systemPrompt: input.prompt }),
              ...(input.description === undefined ? {} : { description: input.description === "" ? null : input.description }),
            }
          : { enabled: input.action === "enable" }),
      });
      if (!updated) throw new TaviError("NOT_FOUND", "Agent does not exist in this workspace");
      return await agents.get(workspaceId, agentId);
    }
    if (input.action === "tree") {
      const tree = await readAgentTree(
        deps.repositories,
        workspaceOf(input),
        required(input.taskId, "a taskId", "agents tree"),
        input.limit,
      );
      const needs = await deps.taskNeeds?.(
        workspaceOf(input),
        tree.nodes.map((node) => node.taskId),
      );
      // The root is the chat on screen: only its workers' rows say what they did last.
      // `detail: false` (a list of names and statuses) skips both.
      if (input.detail === false)
        return { ...tree, nodes: tree.nodes.map(({ finalText: _finalText, ...node }) => ({ ...node, needs: needs?.[node.taskId] ?? [] })) };
      // One at a time: a tree of 200 is not 200 reads queued at once.
      const activity: (import("@tavi/contracts").AgentTreeActivity | undefined)[] = [undefined];
      for (const node of tree.nodes.slice(1))
        activity.push(deps.workerActivity === undefined ? undefined : await deps.workerActivity(node.taskId, node.status));
      return {
        ...tree,
        nodes: tree.nodes.map((node, index) => ({
          ...node,
          needs: needs?.[node.taskId] ?? [],
          ...(activity[index] === undefined ? {} : { activity: activity[index] }),
        })),
      };
    }
    if (input.action === "show") {
      if (input.taskId !== undefined)
        throw new TaviError("INVALID_INPUT", "agents show takes no taskId: a task's mailbox is reported by agents list");
      const agentId = required(input.agentId, "an agentId", "agents show");
      const agent = await deps.repositories.agents.get(workspaceOf(input), agentId);
      if (agent === undefined) {
        throw new TaviError("NOT_FOUND", `no agent ${JSON.stringify(agentId)} exists in workspace ${workspaceOf(input)}`);
      }
      return agent;
    }
    // Read first: a task outside the workspace refuses the whole list.
    const mailbox = input.taskId === undefined ? undefined : await mailboxOf(deps, workspaceOf(input), input.taskId);
    const { agents: definitions, unreadable } = await deps.repositories.agents.list(workspaceOf(input));
    const { rows, truncated } = bounded(definitions, CONFIG_LIST_LIMITS.agents);
    // Routine runs use their revision's pinned instructions (a routine's
    // semantics): the page says a persona edit does not reach them.
    const pins = await deps.repositories.center.agentPins({ workspaceId: workspaceOf(input) });
    const pinnedBy = (agentId: string) => pins.filter((pin) => pin.agentId === agentId).map(({ routineId, name }) => ({ routineId, name }));
    const listed: AgentsListResult = {
      agents: rows.map(({ systemPrompt, ...summary }) => {
        const routines = pinnedBy(summary.agentId);
        return { ...summary, systemPromptLength: systemPrompt.length, ...(routines.length === 0 ? {} : { pinnedBy: routines }) };
      }),
      truncated,
      ...(unreadable.length === 0 ? {} : { unreadable }),
      ...(mailbox === undefined ? {} : { mailbox }),
    };
    return listed;
  });
}

/**
 * The envelopes waiting for task `taskId`, oldest first: their addressing, not
 * their content. A task another workspace owns is not found, as it would not
 * be by `tasks`.
 */
/** What a schedule write checks against the running owner: a watched file, a watched site, and the folder it works in. */
function scheduleWriteChecks(deps: ConfigDependencies) {
  return definedOnly({ precheckFile: deps.precheckFile, precheckSite: deps.precheckSite, folder: deps.scheduleFolder });
}

async function mailboxOf(deps: ConfigDependencies, workspaceId: string, taskId: string): Promise<AgentsMailbox> {
  if ((await deps.repositories.tasks.get(taskId))?.workspaceId !== workspaceId) {
    throw new TaviError("NOT_FOUND", `no task ${taskId} exists in workspace ${workspaceId}`);
  }
  const { rows, truncated } = bounded(
    await deps.repositories.agentMailbox.listPending(taskId, AGENTS_MAILBOX_LIMIT + 1),
    AGENTS_MAILBOX_LIMIT,
  );
  return {
    taskId,
    pending: rows.map((envelope) => ({
      messageId: envelope.messageId,
      kind: envelope.kind,
      senderAgentId: envelope.senderAgentId,
      senderTaskId: envelope.senderTaskId,
      createdAt: envelope.createdAt,
      ...(envelope.expiresAt === undefined ? {} : { expiresAt: envelope.expiresAt }),
    })),
    truncated,
  };
}

/**
 * `models` — configuration reads and writes. A write answers
 * `{ result, restartRequired }`, `restartRequired` always false: the owner
 * reads connections and its default target as they are configured at each
 * turn, so a write takes effect on
 * the next model call. `deps.target` is that live target.
 */
export function modelsCommand(deps: ConfigDependencies, input: ModelsPayload): Promise<IpcAnswer<unknown>> {
  return answering(
    async () => {
      const service = deps.modelConfig;
      const workspaceId = workspaceOf(input);
      const connectionId = (): string => required(input.connectionId, "a connectionId", `models ${input.action}`);
      const target = deps.target;
      const write = (result: unknown): ModelsWriteResult => ({ result, restartRequired: false });
      switch (input.action) {
        case "list":
          return await connectionSummaries(service, workspaceId);
        case "show":
          return await connectionDocument(service, connectionId());
        case "roles": {
          // What this owner runs now. `restartTarget` and `restartRequired` stay
          // for clients that read them: a restart resolves what already runs.
          const active = target.source === "placeholder" ? null : { connectionId: target.connectionId, model: target.model };
          return {
            ...(await modelRolesDocument(service, workspaceId)),
            activeTarget: active,
            restartTarget: active,
            restartRequired: false,
          };
        }
        case "add": {
          const id = connectionId();
          const baseUrl = required(input.baseUrl, "--base-url <url>", "models add");
          // A local connection may name no key: it gets a placeholder of its own, as `tavi setup model` gives one.
          const own =
            input.credentialRef === undefined
              ? await ownLocalCredential(service, await storedCredentialRefs(deps.dataDirectory), {
                  connectionId: id,
                  baseUrl,
                  localOnly: input.localOnly,
                })
              : undefined;
          const credentialRef = own?.credentialRef ?? (input.credentialRef as string);
          await refuseKeyNotAModels(deps, baseUrl, credentialRef);
          await refuseKeyToNewOrigin(deps, service, baseUrl, credentialRef);
          const shared = await sharedCredentialWarning(service, { connectionId: id, baseUrl, credentialRef });
          const connection = await service.putConnection({
            connectionId: id,
            label: input.label ?? id,
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            baseUrl,
            credentialRef,
            ...definedOnly({
              defaultModel: input.model,
              localOnly: input.localOnly,
              headers: input.headers,
              pdfInput: input.pdfInput,
            }),
            ...(input.pdfEngine === undefined ? {} : { pdfEngine: input.pdfEngine === "default" ? null : input.pdfEngine }),
            ...(input.streamFirstByteSeconds === undefined
              ? {}
              : { streamFirstByteSeconds: input.streamFirstByteSeconds === "default" ? null : input.streamFirstByteSeconds }),
            ...(input.streamIdleSeconds === undefined
              ? {}
              : { streamIdleSeconds: input.streamIdleSeconds === "default" ? null : input.streamIdleSeconds }),
            ...(input.wireApi === undefined ? {} : { wireApi: input.wireApi }),
          });
          if (own?.placeholder === true) await storePlaceholder(deps, credentialRef);
          return withWarning(write(connectionRecord(connection)), shared);
        }
        case "remove": {
          const id = connectionId();
          await service.removeConnection(id);
          return write({ removed: id });
        }
        case "rebind": {
          const saved = await service.getConnection(connectionId());
          const own =
            input.credentialRef === undefined
              ? await ownLocalCredential(service, await storedCredentialRefs(deps.dataDirectory), saved, "rebind")
              : undefined;
          const credentialRef = own?.credentialRef ?? (input.credentialRef as string);
          await refuseKeyNotAModels(deps, saved.baseUrl, credentialRef);
          await refuseKeyToNewOrigin(deps, service, saved.baseUrl, credentialRef);
          const connection = await service.rebindCredential({ connectionId: saved.connectionId, credentialRef });
          if (own?.placeholder === true) await storePlaceholder(deps, credentialRef);
          return write(connectionRecord(connection));
        }
        case "set-default": {
          const chosen = { connectionId: connectionId(), ...(input.model === undefined ? {} : { model: input.model }) };
          const value = await service.setWorkspaceDefault({ workspaceId, target: chosen });
          return withWarning(write(value), await unlistedModelWarning(service, chosen));
        }
        case "clear-default": {
          await service.clearWorkspaceDefault(workspaceId);
          return write({ cleared: workspaceId });
        }
        case "set-role": {
          const chosen = { connectionId: connectionId(), ...(input.model === undefined ? {} : { model: input.model }) };
          const binding = await service.setRoleBinding({
            workspaceId,
            role: required(input.role, "a role", "models set-role") as NonNullable<ModelsPayload["role"]>,
            target: chosen,
            ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
          });
          return withWarning(write(binding), await unlistedModelWarning(service, chosen));
        }
        case "clear-role": {
          const role = required(input.role, "a role", "models clear-role") as NonNullable<ModelsPayload["role"]>;
          await service.clearRoleBinding(workspaceId, role);
          return write({ cleared: role });
        }
        case "chat":
        case "set-chat": {
          const taskId = required(input.taskId, "a taskId", `models ${input.action}`);
          const task = await deps.repositories.tasks.get(taskId);
          if (task === undefined || task.workspaceId !== workspaceId)
            throw new TaviError("NOT_FOUND", `no task ${taskId} exists in workspace ${workspaceId}`);
          // A worker runs its chat's model: it has none of its own to set.
          if (input.action === "set-chat" && task.chatKind === "worker")
            throw new TaviError("INVALID_INPUT", `task ${taskId} is a worker, not a chat: set the model of the chat it works for`);
          const routing = deps.taskRouting;
          if (routing?.effectiveTarget === undefined || routing.choose === undefined)
            throw new TaviError("UNAVAILABLE", "this owner has no model connection to run a chat with");
          const scope = { workspaceId, principalId: task.principalId };
          if (input.action === "set-chat") {
            const route = await routing.choose(scope, taskId, {
              connectionId: connectionId(),
              model: required(input.model, "a model", "models set-chat"),
            });
            return write({ taskId, target: route.target, source: "chosen" } satisfies ChatModel);
          }
          let chosen: ModelTarget | undefined;
          try {
            chosen = await routing.effectiveTarget(scope, taskId);
          } catch (error) {
            // Its saved model is gone: still the chat's own, which the next turn refuses until another is chosen.
            if (error instanceof TaviError && error.code === "NOT_CONFIGURED")
              return { taskId, target: null, source: "chosen" } satisfies ChatModel;
            throw error;
          }
          if (chosen !== undefined) return { taskId, target: chosen, source: "chosen" } satisfies ChatModel;
          return {
            taskId,
            target: target.source === "placeholder" ? null : { connectionId: target.connectionId, model: target.model },
            source: "default",
          } satisfies ChatModel;
        }
        case "video-status":
          return await deps.videoStatus();
        case "voice-status":
        case "voice-setup":
          if (deps.voice === undefined) throw new Error("voice messages are set up by the running owner: start `tavi serve`");
          return input.action === "voice-status" ? await deps.voice.status() : await deps.voice.start();
        case "sync":
          if (deps.lifecycleSync === undefined) throw new Error("this owner cannot sync model lifecycles");
          return await deps.lifecycleSync();
        case "lifecycle":
          if (deps.lifecycleReport === undefined) throw new Error("this owner cannot read model lifecycles");
          return await deps.lifecycleReport();
        case "replace": {
          if (deps.replaceModel === undefined) throw new Error("this owner cannot replace models");
          if (input.model === undefined || input.replaceWith === undefined)
            throw new TaviError("INVALID_INPUT", "replace needs connectionId, model and replaceWith");
          // The request's workspace only, as every other models write.
          return await deps.replaceModel(
            { connectionId: connectionId(), model: input.model },
            input.replaceWith,
            workspaceOf(input),
            input.confirmed === true,
          );
        }
        case "video":
          return await setVideoModelAndReport(service, connectionId(), {
            ...(input.videoEnable === undefined ? {} : { enable: input.videoEnable }),
            ...(input.videoDisable === undefined ? {} : { disable: input.videoDisable }),
            confirmed: input.disclosureConfirmed === true,
          });
        case "probe": {
          const connection = await service.getConnection(connectionId());
          await refuseKeyNotAModels(deps, connection.baseUrl, connection.credentialRef);
          await refuseCredentialElsewhere(service, connection, deps.startupProviders);
          if (input.probe === "video") {
            const decoder = await probeVideoDecoder(deps.dataDirectory, deps.videoBinaries ?? {});
            try {
              return await probeVideoAndRecord(service, connection.connectionId, input.model, deps.modelCredential ?? deps.readSecret, {
                decoder,
                workDirectory: join(deps.dataDirectory, "video"),
              });
            } finally {
              await decoder.close();
            }
          }
          return await probePdfAndRecord(service, connection.connectionId, input.model, deps.modelCredential ?? deps.readSecret);
        }
        case "test":
        case "discover": {
          const connection = await service.getConnection(connectionId());
          await refuseKeyNotAModels(deps, connection.baseUrl, connection.credentialRef);
          await refuseCredentialElsewhere(service, connection, deps.startupProviders);
          const probed: unknown =
            input.action === "test"
              ? await testAndRecord(service, connection.connectionId, input.model, deps.modelCredential ?? deps.readSecret)
              : await discoverAndRecord(service, connection.connectionId, deps.modelCredential ?? deps.readSecret);
          return probed;
        }
      }
    },
    // Native video's disclosure: the canvas shows it and asks before it confirms.
    (failure) => (typeof failure.details?.["disclosure"] === "string" ? { disclosure: failure.details["disclosure"] } : undefined),
  );
}

/** A local connection's placeholder key, written as `credentials set` writes one: serialized, and marked this owner's. */
async function storePlaceholder(deps: ConfigDependencies, credentialRef: string): Promise<void> {
  await serializeCredentialAction(deps.dataDirectory, () => storeLocalPlaceholder(deps.dataDirectory, credentialRef));
  deps.credentialsWritten?.add(credentialRef);
}

/** A write's answer with the warning the CLI prints beside it (`unlistedModelWarning`), when there is one. */
function withWarning(written: ModelsWriteResult, warning: string | undefined): ModelsWriteResult {
  return warning === undefined ? written : { ...written, ...{ warning } };
}

/**
 * The target this owner runs now:
 * `resolveRunTarget` over the flags it was started with, as `tavi serve` runs
 * it at startup — the flags, else role `main`'s binding, else the workspace
 * default (the default workspace's while the owner's has neither). A target
 * both flags pinned never changes. When stored configuration resolves
 * nothing — none at all, a connection with no model, every target unusable —
 * the owner runs what it started with, a placeholder included.
 */
export async function liveTarget(service: ModelConfigService, target: OwnerModelTarget): Promise<OwnerModelTarget> {
  if (target.source === "flags") return target;
  // An owner described without its flags: a `connection` source pinned exactly that.
  const flags = target.flags ?? (target.source === "connection" ? { connectionId: target.connectionId } : {});
  const resolved = await resolveLiveTarget(service, {
    workspaceId: target.workspaceId,
    connectionId: flags.connectionId,
    model: flags.model,
  });
  if (resolved === undefined) return target;
  return { ...target, source: resolved.source, ...resolved.target, fallback: resolved.fallback.map((entry) => entry.target) };
}

/**
 * Refuse to send a credential to an origin it is not bound to (a confused
 * deputy): over IPC, `models add` can point a connection anywhere and name any
 * reference, and `test|discover` would then send that credential there through
 * the owner's chain — which also resolves the launcher's bindings. A credential
 * another stored connection, or a connection the owner was launched with, uses
 * against a different origin stays with that origin; probing a new origin with
 * it is the offline command's (`--credential-file`), where the operator hands
 * the value over explicitly.
 */
/**
 * Refuse a model connection naming a key that is not a model's to use (and
 * the reverse is refused too): a search provider's — any `search.*` reference, or one a stored
 * provider names — or one the owner's launcher bound for another use (a bot
 * token, a webhook key, a launched connection's key at another origin).
 * Through `tavi ui` a page reaches `models`, and `add` then `test` would send
 * such a key to an origin the page chose; refused at `add` and `rebind` too, so
 * a run after a restart cannot send it either.
 */
async function refuseKeyNotAModels(deps: ConfigDependencies, baseUrl: string, credentialRef: string): Promise<void> {
  // Every name a search key may be stored under (`searchCredentialRefProblem`) —
  // whether or not a provider names it now: `search remove` leaves the key stored.
  const searchNamed = credentialRef.startsWith("search.") || WEB_SEARCH_KINDS.some((kind) => credentialRef.startsWith(`${kind}.`));
  if (
    searchNamed ||
    (await deps.repositories.searchProviders.list()).providers.some((provider) => provider.credentialRef === credentialRef)
  ) {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `credential ${credentialRef} is a search provider's key; a model connection needs a key of its own`,
    );
  }
  // A plugin's key is stored under its own namespace for that plugin alone.
  if (credentialRef.startsWith("plugins.")) {
    throw new TaviError("NOT_AUTHORIZED", `credential ${credentialRef} is a plugin's key; a model connection needs a key of its own`);
  }
  // A launched connection's key is the launcher's too, usable at that connection's own origin only.
  const launchedHere = deps.startupProviders.some(
    (provider) => provider.credentialRef === credentialRef && originOf(provider.baseUrl) === originOf(baseUrl),
  );
  const launcherBound =
    deps.launcherBindings?.includes(credentialRef) === true ||
    deps.startupProviders.some((provider) => provider.credentialRef === credentialRef);
  if (launcherBound && !launchedHere) {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `credential ${credentialRef} is bound by the owner's launcher for another use; an attached client cannot send it to ${originOf(baseUrl)}`,
    );
  }
}

/**
 * Refuse a stored key at an origin nothing binds it to. Through `tavi ui`,
 * `models add` and `rebind` could otherwise move a key the client never saw:
 * point an existing connection at a new origin, or remove a connection and
 * add another under its key — which `test|discover`, or a run after a
 * restart, would then send there. Allowed: a key some stored or launched
 * connection already uses at this origin (the connection being edited counts
 * at its current origin), one this owner stored for an attached client (which
 * knows it), and one not stored at all (nothing to send).
 */
async function refuseKeyToNewOrigin(
  deps: ConfigDependencies,
  service: ModelConfigService,
  baseUrl: string,
  credentialRef: string,
): Promise<void> {
  // A local client holds the owner's cookie, and with it the credentials directory: the rule guards a page.
  if (deps.fromBridge !== true || deps.credentialsWritten?.has(credentialRef) === true) return;
  const origin = originOf(baseUrl);
  const bound = [...(await service.listConnections()), ...deps.startupProviders].some(
    (other) => other.credentialRef === credentialRef && originOf(other.baseUrl) === origin,
  );
  if (bound) return;
  // Only a key known to be absent has nothing to send: one that cannot be read may be there, and is refused as stored.
  const read = await deps.readSecret(credentialRef).then(
    (value) => ({ stored: value !== null }),
    (error: unknown) => ({ stored: true, unreadable: errorMessage(error) }),
  );
  if (!read.stored) return;
  const why = "unreadable" in read ? `could not be read (${read.unreadable.slice(0, 200)}), so it is treated as stored` : "is stored";
  throw new TaviError(
    "NOT_AUTHORIZED",
    `credential ${credentialRef} ${why}, and no connection uses it at ${origin}; an attached client cannot move a key to a new origin — ` +
      "set its value again through this page, or add the connection with `tavi models add` in a terminal",
  );
}

async function refuseCredentialElsewhere(
  service: ModelConfigService,
  connection: ModelConnection,
  startupProviders: ConfigDependencies["startupProviders"],
): Promise<void> {
  const origin = originOf(connection.baseUrl);
  const bound = [
    ...(await service.listConnections()).filter((other) => other.connectionId !== connection.connectionId),
    ...startupProviders,
  ].find((other) => other.credentialRef === connection.credentialRef && originOf(other.baseUrl) !== origin);
  if (bound !== undefined) {
    // `--credential-file` is refused while an owner runs: the way out is a key per connection.
    const user = "connectionId" in bound && typeof bound.connectionId === "string" ? `the connection ${bound.connectionId}` : "the owner";
    throw new TaviError(
      "NOT_AUTHORIZED",
      `credential ${connection.credentialRef} is used by ${user} at ${originOf(bound.baseUrl)} too, not only at ${origin}, ` +
        "so a test may not send it: give each connection a credential of its own " +
        "(`tavi credentials set <name> --file <path>`, then `tavi models rebind <id> --credential <name>`)",
    );
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * `credentials` — through the same writable local store `tavi
 * credentials` uses (`features/credentials/store.ts`), created here per request and reachable
 * from nothing else: never from a tool or the agent. A value is written `0600`
 * and never answered back; the owner's chain reads the file at resolution time,
 * so a new value applies to the next call without a restart. `list` covers that
 * store only — not a launcher's `--credential` bindings, which the chain also
 * resolves.
 */
export function credentialsCommand(deps: ConfigDependencies, input: CredentialsPayload): Promise<IpcAnswer<unknown>> {
  // One credential write at a time on this directory: IPC requests run concurrently.
  return serializeCredentialAction(deps.dataDirectory, () =>
    answering(async () => {
      const reference = (): string => assertSecretReference(required(input.reference, "a reference", `credentials ${input.action}`));
      switch (input.action) {
        case "list": {
          const { valid, invalid } = await listCredentialRefs(deps.dataDirectory);
          // Where the at-rest key is kept (as `tavi credentials key` says), never the key or its path: Settings → Credentials shows it.
          const where = await credentialKeyLocation(deps.dataDirectory);
          return {
            credentials: valid,
            unusable: invalid,
            encryption: { kept: where.kept, ...(where.keychain === undefined ? {} : { keychain: where.keychain }) },
          };
        }
        case "set": {
          const name = reference();
          const value = plainCredentialValue(name, required(input.value, "a value", "credentials set"));
          await createLocalCredentialStore(deps.dataDirectory).setSecret(name, value);
          deps.credentialsWritten?.add(name);
          // The value is never echoed — only where it went.
          return { stored: name };
        }
        case "delete": {
          const name = reference();
          await createLocalCredentialStore(deps.dataDirectory).deleteSecret(name);
          deps.credentialsWritten?.delete(name);
          // The connections left naming it, for the CLI to say.
          return { deleted: name, namedBy: await connectionsNaming(deps.modelConfig, name) };
        }
        case "encrypt":
          // The same routine offline: the key created if absent, each value rewritten encrypted.
          return await encryptCredentialDirectory(deps.dataDirectory);
        case "key":
          return await credentialKeyOnOwner(deps, input.to);
      }
    }),
  );
}

/**
 * `credentials key --to-systemd|--to-file` against the service: only the
 * process systemd started with `LoadCredentialEncrypted=` reads that
 * credential, so the move that checks it, or reads it back into the file,
 * runs here. Never from a page: where the key that opens every credential is
 * kept is the operator's to change, at the terminal. Without `to`, where it is.
 */
async function credentialKeyOnOwner(deps: ConfigDependencies, to: CredentialsPayload["to"]): Promise<unknown> {
  if (deps.fromBridge === true) {
    throw new TaviError("NOT_AUTHORIZED", "a page cannot move the credential key; use `tavi credentials key` at the terminal");
  }
  if (to === undefined) return await credentialKeyLocation(deps.dataDirectory);
  return await moveCredentialKey(deps.dataDirectory, to);
}

/** `reports` — the report history `tavi reports list` and `trends` read, from the owner's own store while it runs. */
export function reportsCommand(deps: ConfigDependencies, input: ReportsPayload): Promise<IpcAnswer<unknown>> {
  return answering(async () =>
    deps.repositories.reports.list({
      workspaceId: input.workspaceId,
      limit: input.limit,
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    }),
  );
}

/** `projects` — the registry the collectors read; `add` takes the project itself. */
export function projectsCommand(deps: ConfigDependencies, input: ProjectsPayload): Promise<IpcAnswer<unknown>> {
  return answering(async () => {
    const projects = deps.repositories.projects;
    const workspaceId = workspaceOf(input);
    switch (input.action) {
      case "list": {
        const { projects: all, unreadable } = await projects.list(workspaceId);
        const { rows, truncated } = bounded(all, CONFIG_LIST_LIMITS.projects);
        return { projects: rows, truncated, ...(unreadable.length === 0 ? {} : { unreadable }) };
      }
      case "add": {
        const project = input.project;
        if (project === undefined) throw new TaviError("INVALID_INPUT", "projects add needs a project");
        return await projects.create({ workspaceId, project, enabled: true, now: deps.now().toISOString() });
      }
      case "show":
      case "remove":
      case "enable":
      case "disable": {
        const projectId = required(input.projectId, "a projectId", `projects ${input.action}`);
        const existing = await projects.get(workspaceId, projectId);
        if (existing === undefined) {
          throw new TaviError("NOT_FOUND", `no project ${JSON.stringify(projectId)} exists in workspace ${workspaceId}`);
        }
        if (input.action === "show") return existing;
        if (input.action === "remove") {
          await projects.remove(workspaceId, projectId);
          return { removed: projectId };
        }
        await projects.update({ workspaceId, projectId, enabled: input.action === "enable", now: deps.now().toISOString() });
        return (await projects.get(workspaceId, projectId)) ?? existing;
      }
    }
  });
}

/**
 * `search` — the web search providers, as `tavi search` configures
 * them. A write answers `{ result, restartRequired }`, `restartRequired`
 * always false: the owner activates a provider added or enabled over IPC on
 * demand and offers `web_search` from the next turn;
 * it stays for clients written when a write needed a restart. `test`
 * searches once, through the adapter
 * `web_search` uses, with the owner's own credential chain — bounded by the
 * adapter's own deadline, not by the requesting connection, which the owner
 * does not hand a handler.
 *
 * A page reaches this through `tavi ui`, so a provider's key must be a search
 * reference (`searchCredentialRefProblem`) that nothing else holds — no model
 * connection, stored or launched, and no launcher binding — checked when it is
 * added and again when it is tested, since connections change in between:
 * `test` would otherwise send another's key to the search provider's endpoint,
 * a third party it was never meant for.
 */
export function searchCommand(deps: ConfigDependencies, input: SearchPayload): Promise<IpcAnswer<unknown>> {
  return answering(async () => {
    const providers = deps.repositories.searchProviders;
    const now = deps.now().toISOString();
    if (input.action === "list") {
      const { providers: all, unreadable } = await providers.list();
      const { rows, truncated } = bounded(all, CONFIG_LIST_LIMITS.searchProviders);
      return { providers: rows, truncated, ...(unreadable.length === 0 ? {} : { unreadable }) };
    }
    const providerId = required(input.providerId, "a providerId", `search ${input.action}`);
    const existing = async (): Promise<NonNullable<Awaited<ReturnType<typeof providers.get>>>> => {
      const found = await providers.get(providerId);
      if (found === undefined) throw new TaviError("NOT_FOUND", `no search provider ${JSON.stringify(providerId)} is configured`);
      return found;
    };
    switch (input.action) {
      case "add": {
        if (input.kind === undefined) throw new TaviError("INVALID_INPUT", "search add needs a kind");
        if (input.credentialRef !== undefined) await refuseForeignKey(deps, input.kind, input.credentialRef, providerId);
        const added = await providers.add({
          providerId,
          kind: input.kind,
          ...(input.credentialRef === undefined ? {} : { credentialRef: input.credentialRef }),
          ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
          enabled: true,
          now,
        });
        const written: SearchWriteResult = { result: added, restartRequired: false };
        return written;
      }
      case "remove":
        if (!(await providers.remove(providerId))) await existing();
        return { result: { removed: providerId }, restartRequired: false } satisfies SearchWriteResult;
      case "enable":
      case "disable": {
        if (!(await providers.setEnabled(providerId, input.action === "enable", now))) await existing();
        // Read back after the write: the row as it now stands.
        const updated = await existing();
        const written: SearchWriteResult = { result: updated, restartRequired: false };
        return written;
      }
      case "test": {
        const provider = await existing();
        if (provider.credentialRef !== undefined) {
          try {
            await refuseForeignKey(deps, provider.kind, provider.credentialRef, provider.providerId);
          } catch (error) {
            // A provider stored before the rule, or one whose key something else took since.
            throw new TaviError(
              "INVALID_INPUT",
              `${errorMessage(error)} — remove ${provider.providerId} and add it again with a key of its own`,
            );
          }
        }
        const adapter = createWebSearchAdapter(provider, {
          readSecret: deps.readSecret,
          ...(deps.searchFetch === undefined ? {} : { fetch: deps.searchFetch }),
        });
        return adapter.search({ query: input.query ?? "tavi", maxResults: 5 }, new AbortController().signal);
      }
    }
  });
}

/** Refuse a search provider's key that is not a search reference, or that something else holds. */
async function refuseForeignKey(deps: ConfigDependencies, kind: WebSearchKind, credentialRef: string, providerId?: string): Promise<void> {
  const problem = searchKeyProblem(
    {
      connections: [...(await deps.repositories.modelConfig.listConnections()), ...deps.startupProviders],
      launcherBindings: deps.launcherBindings ?? [],
      providers: (await deps.repositories.searchProviders.list()).providers.filter((provider) => provider.providerId !== providerId),
    },
    kind,
    credentialRef,
  );
  if (problem !== undefined) throw new TaviError("INVALID_INPUT", problem);
}

/** `answer`, once the file watchers follow the write it answers: a watcher edited, paused or removed is not watched after. */
async function watchersFollow<T>(deps: Pick<ConfigDependencies, "schedulesChanged">, answer: T): Promise<T> {
  await deps.schedulesChanged?.();
  return answer;
}

/**
 * How long an edit or a removal waits for a schedule's fire to end before it is
 * refused. A fire reports after its run ends (the run's record, a report, an
 * alert), so a client that followed the run to its last event can ask the very
 * next moment, while the fire is still in flight: refusing that would make the
 * answer depend on how fast the client got here.
 */
const FIRE_ENDING_GRACE_MS = 2_000;

/** Whether no fire of the schedule is in flight, waiting up to the grace for one that is to end. */
async function fireEnds(fireInFlight: ((scheduleId: string) => boolean) | undefined, scheduleId: string): Promise<boolean> {
  if (fireInFlight === undefined) return true;
  const deadline = Date.now() + FIRE_ENDING_GRACE_MS;
  while (fireInFlight(scheduleId)) {
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
  return true;
}

/**
 * `schedules` — read (with recent fires, or the fire history), enable/disable, remove, fire now, the agenda, a cadence's next runs (`preview`), and the tools a schedule may list (`tools`). The list leaves out each
 * schedule's prompt, which `show` gives: the full records would not fit one
 * frame.
 */
export async function schedulesCommand(deps: ConfigDependencies, input: SchedulesPayload): Promise<IpcAnswer<unknown>> {
  const schedules = deps.repositories.schedules;
  const workspaceId = workspaceOf(input);
  if (input.action === "add") {
    // For the workspace's own principal unless one is named, and only one that acts in the workspace.
    const principalId = input.principalId ?? deps.workspacePrincipal?.(workspaceId);
    if (principalId !== undefined && deps.actsIn !== undefined && !deps.actsIn(workspaceId, principalId))
      return Promise.resolve(refuse("NOT_AUTHORIZED", `${principalId} is not allowed in workspace ${workspaceId}`));
    return answering(async () =>
      watchersFollow(
        deps,
        await writeSchedule(
          deps.repositories,
          principalId === undefined ? input : { ...input, principalId },
          deps.now(),
          scheduleWriteChecks(deps),
        ),
      ),
    );
  }
  if (input.action === "agenda") return answering(() => scheduleAgenda(deps.repositories, input, deps.now()));
  if (input.action === "preview") return answering(() => schedulePreview(deps.repositories, input, deps.now()));
  if (input.action === "tools") return answering(() => scheduleTools(deps.repositories, deps.registeredTools?.() ?? []));
  if (input.action === "list") {
    return answering(async () => {
      const { rows, truncated } = bounded(await schedules.list(workspaceId), CONFIG_LIST_LIMITS.schedules);
      const listed: SchedulesListResult = {
        schedules: await Promise.all(
          rows.map(async ({ prompt: _prompt, ...summary }) => {
            const owner = await deps.routines?.scheduleOwner(summary.scheduleId);
            return { ...summary, ...(owner === undefined ? {} : { routineId: owner.routineId }) };
          }),
        ),
        truncated,
        ...(input.withUsage === true ? { scheduledWork: await scheduledWorkThisMonth(deps.repositories, workspaceId, deps.now()) } : {}),
      };
      return listed;
    });
  }
  if (input.scheduleId === undefined) {
    return Promise.resolve(refuse("INVALID_INPUT", `schedules ${input.action} needs a scheduleId`));
  }
  const schedule = await resolveSchedule(schedules, workspaceId, input.scheduleId);
  if (schedule === undefined) {
    return Promise.resolve(refuse("NOT_FOUND", `no schedule ${JSON.stringify(input.scheduleId)} exists in workspace ${workspaceId}`));
  }
  // Its owner no longer allowed (revoked from Allowed people): it may be shown, paused or removed, never run, resumed or changed.
  if (
    deps.actsIn !== undefined &&
    !deps.actsIn(schedule.workspaceId, schedule.principalId) &&
    !["show", "history", "disable", "remove"].includes(input.action) &&
    !(input.action === "webhook" && input.webhook === "off") &&
    !(input.action === "email-trigger" && input.emailTrigger === "off")
  ) {
    return Promise.resolve(
      refuse(
        "NOT_AUTHORIZED",
        `${schedule.principalId} is no longer allowed in this workspace: their schedule can be shown, paused or removed, not ${input.action}. Allow them again in ${englishOf(navPath("nav.route.settings", "nav.settings.people"))} to use it.`,
      ),
    );
  }
  const routines = deps.routines;
  if (
    routines !== undefined &&
    (await routines.scheduleOwner(schedule.scheduleId)) !== undefined &&
    input.action !== "show" &&
    input.action !== "history"
  )
    return answering(async () => await routineScheduleAction(routines, schedule, input));
  switch (input.action) {
    case "update":
      if (!(await fireEnds(deps.fireInFlight, schedule.scheduleId)))
        return refuse("CONFLICT", `schedule ${schedule.name} has a fire in flight; edit it once the fire ends`);
      return answering(async () =>
        watchersFollow(deps, await writeSchedule(deps.repositories, input, deps.now(), scheduleWriteChecks(deps))),
      );
    case "show":
      return answering(() => scheduleShow(deps.repositories, schedule));
    case "history":
      return answering(() => scheduleHistory(deps.repositories, schedule, input.limit));
    case "enable":
    case "disable":
      return answering(async () =>
        watchersFollow(deps, await setScheduleEnabled(schedules, schedule, input.action === "enable", deps.now())),
      );
    case "remove":
      // A fire in flight would finish against a row that no longer exists, and
      // its outcome would be recorded nowhere.
      if (!(await fireEnds(deps.fireInFlight, schedule.scheduleId))) {
        return refuse(
          "CONFLICT",
          `schedule ${schedule.name} has a fire in flight; remove it once the fire ends (\`tavi abort\` or \`tavi cancel\` its task, or the workers it waits on, to end it sooner)`,
        );
      }
      return answering(async () => {
        await schedules.remove(schedule.scheduleId);
        // Its webhook, if it had one, is gone: the owner's webhook ids follow, and the listener closes after the last.
        await deps.webhookChanged?.();
        return watchersFollow(deps, { removed: schedule.scheduleId });
      });
    case "webhook": {
      const mode = input.webhook;
      if (mode === undefined) return Promise.resolve(refuse("INVALID_INPUT", "schedules webhook needs on, off or rotate"));
      return answering(async () => {
        const answer = await setScheduleWebhook(deps.repositories, schedule, mode, deps.now(), credentialKeyFile(deps.dataDirectory));
        // The listener opens for the first webhook and closes after the last, as it does for a channel.
        await deps.webhookChanged?.();
        return answer;
      });
    }
    case "email-trigger": {
      const setting = input.emailTrigger;
      if (setting === undefined)
        return Promise.resolve(refuse("INVALID_INPUT", "schedules email-trigger needs off, or a connection and its senders"));
      return answering(() => setScheduleEmailTrigger(deps.repositories, schedule, setting, deps.now()));
    }
    case "run": {
      // As `run` refuses it: a fire against the placeholder target would
      // fail inside the model call, and alert as the schedule's own failure.
      if (deps.target.source === "placeholder") {
        return Promise.resolve(
          refuse(
            "NOT_CONFIGURED",
            `this owner runs no configured model (only the placeholder ${deps.target.connectionId}/${deps.target.model}): ` +
              "set one with `tavi models set-default`; the next request runs it",
          ),
        );
      }
      // The client may assert the owner's default as it resolves now.
      const mismatch = targetRefusal(deps.target, input.expectTarget);
      if (mismatch !== undefined) return Promise.resolve(mismatch);
      if (deps.fireNow === undefined) {
        return Promise.resolve(refuse("UNAVAILABLE", "this owner has no model connection to run a schedule with"));
      }
      return deps.fireNow(schedule);
    }
  }
}

/**
 * `system-prompt`: the editable
 * default base for *new* tasks in a workspace.
 *
 * Reads and writes go through the same compare-and-set the store implements, so
 * two operators editing the same workspace cannot silently overwrite each other:
 * a stale `expectedRevision` is `CONFLICT`, and `configOnOwner` maps that to the
 * usage exit.
 *
 * The answer describes the selection a **new** task would make. It says nothing
 * about existing tasks, which keep the snapshot they were admitted with — that
 * distinction is why the field is named `effective` and carries `appliesTo`.
 */
export function systemPromptCommand(
  deps: ConfigDependencies,
  input: SystemPromptPayload,
): Promise<IpcAnswer<SystemPromptAnswer | SystemPromptPreview>> {
  const workspaceId = workspaceOf(input);
  const systemPrompts = deps.repositories.systemPrompts;
  return answering(async () => {
    // The owner knows which workspaces it was configured with, and a write into
    // a workspace nobody granted would persist an override that can never be
    // selected — reported as a success that has no effect.
    // Absent on the offline path, which has no grant map: there the data
    // directory's exclusive ownership is the whole boundary.
    if (deps.knownWorkspace !== undefined && !deps.knownWorkspace(workspaceId)) {
      throw new TaviError("NOT_FOUND", `workspace ${workspaceId} is not configured on this owner`, {
        details: { workspaceId },
      });
    }
    if (input.action === "get") return systemPromptAnswer(deps, workspaceId);
    if (input.action === "preview") {
      return systemPromptPreviewFor(
        deps.repositories,
        workspaceId,
        input.agentId,
        new Date(deps.now()).toISOString(),
        input.taskId,
        deps.contextBudgetTokens === undefined ? undefined : await deps.contextBudgetTokens(workspaceId),
      );
    }
    // The actor records which local front end asked — never a payload-supplied
    // identity, which would let a write claim any attribution.
    const actor = operatorActor(deps.fromBridge);
    const now = new Date(deps.now()).toISOString();
    const expectedRevision = input.expectedRevision;
    // The payload schema already requires this for a write; restated here so the
    // handler's contract does not depend on which caller validated it.
    if (expectedRevision === undefined) {
      throw new TaviError("INVALID_INPUT", `system-prompt ${input.action} needs the expectedRevision it read`);
    }
    if (input.action === "set") {
      const text = required(input.text, "text", "system-prompt set");
      await systemPrompts.set({ workspaceId, text, expectedRevision, actor, now });
    } else {
      await systemPrompts.reset({ workspaceId, expectedRevision, actor, now });
    }
    // A write answers the same shape as `get`, so a client updates its saved
    // state from the acknowledgement alone.
    return systemPromptAnswer(deps, workspaceId);
  });
}

/** Build the editor's answer from the persisted row, failing loudly on a row this build cannot describe. */
async function systemPromptAnswer(deps: ConfigDependencies, workspaceId: string): Promise<SystemPromptAnswer> {
  return await systemPromptAnswerFor(deps.repositories.systemPrompts, workspaceId, deps.explicitSystemPrompt === true);
}

/**
 * The editor's answer, from the repository alone.
 *
 * Exported so the offline CLI path answers with exactly the same shape as the
 * owner does — the two front ends must not drift on what "effective" means.
 */
export async function systemPromptAnswerFor(
  systemPrompts: SystemPromptRepositoryPort,
  workspaceId: string,
  explicitAdapterShadowing: boolean,
): Promise<SystemPromptAnswer> {
  const record = await systemPrompts.get(workspaceId);
  const custom = record.text === null ? null : customPromptOf(record, workspaceId);
  return {
    workspaceId,
    revision: record.revision,
    custom,
    shipped: { text: DEFAULT_SYSTEM_PROMPT, templateVersion: SHIPPED_SYSTEM_PROMPT_VERSION },
    effective:
      record.text === null
        ? { text: DEFAULT_SYSTEM_PROMPT, source: "builtin", revision: null, templateVersion: SHIPPED_SYSTEM_PROMPT_VERSION }
        : { text: record.text, source: "workspace", revision: record.revision, templateVersion: null },
    appliesTo: "next-message",
    explicitAdapterShadowing,
  };
}

/**
 * `system-prompt preview`: the layers a **new**
 * task in this workspace would be given, optionally under `agentId`'s persona —
 * or, with `taskId`, the layers that chat's next turn would be given.
 *
 * Built by `composeSystemPromptLayers`, the function the workflow composes every
 * model request's base and persona with, so the preview cannot drift from what
 * the model receives. The generated layers (runtime facts, retrieved context)
 * depend on each call; the facts layer carries a sample rendering in the
 * workspace's zone at `now`.
 *
 * Exported so the offline CLI answers exactly what the owner answers.
 */
export async function systemPromptPreviewFor(
  repositories: Pick<
    PersistencePort["repositories"],
    "systemPrompts" | "agents" | "workspaceSettings" | "skills" | "tasks" | "chatInstructions"
  >,
  workspaceId: string,
  agentId: string | undefined,
  now: string,
  taskId?: string,
  budgetTokens?: number,
): Promise<SystemPromptPreview> {
  const record = await repositories.systemPrompts.get(workspaceId);
  // A stored override is described through the same check `get` makes, so a
  // row `get` refuses is not previewed as though it were sound.
  const custom = record.text === null ? null : customPromptOf(record, workspaceId);
  // A chat's next turn: the base its next message is admitted under —
  // the workspace's as it is now, for a chat whose own base is the workspace's
  // or the shipped default; an explicit base stays the chat's own —
  // and its current instructions.
  let snapshot: Awaited<ReturnType<typeof repositories.tasks.getPromptSnapshot>>;
  /** The base the chat's latest turn ran under: a chat on a shipped template keeps it when a newer one ships. */
  let pinned: Awaited<ReturnType<typeof repositories.tasks.getPromptSnapshot>>;
  let chat: ChatInstructionsRevision | undefined;
  if (taskId !== undefined) {
    const task = await repositories.tasks.get(taskId);
    if (task === undefined || task.workspaceId !== workspaceId) throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
    snapshot = await repositories.tasks.getPromptSnapshot(taskId);
    const latest = await repositories.tasks.latestSettledAdmission(taskId);
    pinned = latest === undefined ? snapshot : await repositories.tasks.getPromptSnapshot(taskId, latest.admissionId);
    chat = await repositories.chatInstructions.current(taskId);
  }
  // With no override, a chat on a shipped template runs its next turn on that template, which may be older.
  const keptTemplate = custom === null && pinned?.source === "builtin" ? pinned : undefined;
  const own = snapshot === undefined || snapshot.source === "workspace" || snapshot.source === "builtin" ? undefined : snapshot;
  let persona: AgentDefinition | undefined;
  if (agentId !== undefined) {
    persona = await repositories.agents.get(workspaceId, agentId);
    if (persona === undefined) {
      throw new TaviError("NOT_FOUND", `no agent ${JSON.stringify(agentId)} exists in workspace ${workspaceId}`);
    }
  }
  const { settings } = await repositories.workspaceSettings.get(workspaceId);
  const timezone = settings.timezone ?? hostTimeZone();
  // The workspace's language too, so the preview shows the reply-language line and local time the agent reads.
  const factsSample = sampleRuntimeFacts({ now, timezone }, localeOf(settings));
  const composed = composeSystemPromptLayers({
    base:
      own !== undefined
        ? snapshotBase(own)
        : keptTemplate !== undefined
          ? snapshotBase(keptTemplate)
          : custom === null
            ? { text: DEFAULT_SYSTEM_PROMPT, source: "shipped", templateVersion: SHIPPED_SYSTEM_PROMPT_VERSION }
            : { text: custom.text, source: "workspace", revision: custom.revision },
    shipped: { text: DEFAULT_SYSTEM_PROMPT, templateVersion: SHIPPED_SYSTEM_PROMPT_VERSION },
    ...(persona === undefined ? {} : { persona }),
    ...(chat === undefined ? {} : { chat: { text: chat.text, revision: chat.revision } }),
    factsSample,
    // Only an approved version can be activated, so every activation counts.
    skills: (await repositories.skills.listActivations(workspaceId)).length,
  });
  return {
    workspaceId,
    ...(agentId === undefined ? {} : { agentId }),
    layers: [...composed.layers],
    shippedLength: DEFAULT_SYSTEM_PROMPT.length,
    overridden: own !== undefined ? own.source === "explicit" : custom !== null,
    baseText: (own ?? keptTemplate)?.text ?? (custom === null ? DEFAULT_SYSTEM_PROMPT : custom.text),
    ...definedOnly({
      personaText: composed.personaText,
      taskId,
      chatText: composed.chatText,
    }),
    // What every call starts with before memory and skills — the prompt and its runtime facts, as a call is refused by — against the budget.
    ...(budgetTokens === undefined
      ? {}
      : { budget: { fixedTokens: defaultEstimateTokens(`${composed.text}\n\n${factsSample}`), maxTokens: budgetTokens } }),
  };
}

/**
 * The saved override as the contract describes it.
 *
 * A `set` always writes every metadata column, so a missing one is a row this
 * build cannot account for rather than a state to paper over — the same posture
 * `parseStoredRow` takes.
 */
function customPromptOf(record: WorkspaceSystemPromptRecord, workspaceId: string): NonNullable<SystemPromptAnswer["custom"]> {
  const missing = (field: string): never => {
    throw new TaviError("INTERNAL", `Stored system prompt for workspace ${workspaceId} has no ${field}; repair it or restore a backup`);
  };
  return {
    text: record.text ?? missing("text"),
    revision: record.revision,
    updatedAt: record.updatedAt ?? missing("updatedAt"),
    lastOperation: record.lastOperation ?? missing("lastOperation"),
    previousRevision: record.previousRevision ?? missing("previousRevision"),
    actor: record.actor ?? missing("actor"),
    hash: record.hash ?? missing("hash"),
  };
}

/**
 * Who else keeps an account's grant at its provider: the owner sets it once it can project its
 * apps. Every path that revokes asks it first, so removing or signing out one app never ends another's sign-in.
 */
const GRANT_KEPT_BY = new WeakMap<object, (accountId: string) => Promise<readonly string[]>>();

export function setGrantKeptBy(runtime: object, keptBy: (accountId: string) => Promise<readonly string[]>): void {
  GRANT_KEPT_BY.set(runtime, keptBy);
}

async function grantKeptBy(runtime: object, accountId: string): Promise<readonly string[]> {
  return (await GRANT_KEPT_BY.get(runtime)?.(accountId)) ?? [];
}

/**
 * `mcp` — probe, show, approve, reject and verify an MCP server on the owner:
 * the steps `plugins` does not cover.
 */
/**
 * What of an MCP refusal reaches the page, beside its words: a login a server's own client must make (the page asks for
 * that client, with the redirect it registers), and a server that refused its credentials (`apps test` keeps that, so
 * Connected apps offers the key again, QA 2061). Nothing else a failure carries.
 */
export function mcpPageDetails(failure: TaviError): Readonly<Record<string, unknown>> | undefined {
  const details = failure.details;
  if (details?.["needsClient"] === true && typeof details["redirect"] === "string")
    return { needsClient: true, redirect: details["redirect"] };
  if (details?.["mcpFailure"] === "auth" && typeof details["status"] === "number") return { mcpFailure: "auth", status: details["status"] };
  return undefined;
}

/** What of a channels refusal reaches the page: that a connection isn't running, and its name, so the page words it (QA 2033). */
export function channelsPageDetails(failure: TaviError): Readonly<Record<string, unknown>> | undefined {
  const details = failure.details;
  return details?.["notListening"] === true && typeof details["label"] === "string"
    ? { notListening: true, label: details["label"] }
    : undefined;
}

export async function mcpCommand(
  runtime: Pick<
    import("../runtime/types.js").TaviRuntime,
    "plugins" | "dataDirectory" | "store" | "resolveSecret" | "tools" | "clock" | "mcp"
  >,
  input: import("@tavi/contracts").McpPayload,
  actor: string,
): Promise<IpcAnswer<unknown>> {
  const fromBridge = actor === operatorActor(true);
  // From a page, a weaker sandbox state and turning MCP on are refused (as a page may only raise security.taint): both stay the CLI's.
  if (fromBridge) {
    if ((input.action === "probe" || input.action === "approve") && input.sandbox !== undefined && input.sandbox !== "srt") {
      return refuse(
        "NOT_AUTHORIZED",
        `a page cannot run a server ${input.sandbox === "none" ? "unsandboxed" : "in the weaker nested sandbox"}; use \`tavi mcp ${input.action} ${input.pluginId} --${input.sandbox === "none" ? "unsandboxed" : "nested"}\``,
      );
    }
    if (input.action === "switch" && input.on) return refuse("NOT_AUTHORIZED", "a page can turn MCP off, not on; use `tavi mcp on`");
    if (input.action === "registry" && (input.url !== undefined || input.reset))
      return refuse("NOT_AUTHORIZED", "a page cannot change the registry searched; use `tavi mcp registry <url>`");
  }
  const answer = await answering(
    () =>
      runMcpAction(
        {
          registry: runtime.plugins.registry,
          mcp: runtime.store.asPort().repositories.mcp,
          dataDirectory: runtime.dataDirectory,
          resolveSecret: runtime.resolveSecret,
          now: () => runtime.clock.now(),
          registeredToolIds: () => new Set(runtime.tools.list().map((tool) => tool.id)),
          workspaceSettings: runtime.store.asPort().repositories.workspaceSettings,
          personal: async (pluginId) => await mcpAccountPersonal(runtime.plugins.registry, (key) => runtime.store.getMeta(key), pluginId),
          deleteSessionGrants: (toolIds) => runtime.store.asPort().repositories.toolPolicy.deleteSessionGrantsForTools(toolIds),
          // OAuth: the owner's token for a probe, its logins, and a logout that also stops the server.
          oauthToken: (pluginId) => runtime.mcp.oauth.tokens.accessToken(pluginId),
          logins: runtime.mcp.oauth.logins,
          // Revoked at the provider only when no other app keeps its grant; `tavi mcp logout` too.
          logout: async (pluginId, options) =>
            options?.upstream === false
              ? await runtime.mcp.oauth.logout(pluginId, options)
              : await runtime.mcp.oauth.logout(pluginId, (await grantKeptBy(runtime, pluginId)).length > 0 ? { upstream: false } : {}),
          enabled: async () => mcpEnabledOf(await runtime.store.getMeta(MCP_ENABLED_SETTING)),
          setEnabled: async (on) => await runtime.store.setMeta(MCP_ENABLED_SETTING, String(on), runtime.clock.now()),
          searchLines: mcpSearchLines(
            (key) => runtime.store.getMeta(key),
            (key, value) => runtime.store.setMeta(key, value, runtime.clock.now()),
          ),
          registryUrl: {
            get: async () => await runtime.store.getMeta(MCP_REGISTRY_SETTING),
            set: async (url) => await runtime.store.setMeta(MCP_REGISTRY_SETTING, url ?? "", runtime.clock.now()),
          },
          install: async (directory) => {
            const installed = await runtime.plugins.registry.install(directory, actor);
            return { pluginId: installed.record.pluginId, version: installed.record.version, created: installed.created };
          },
          live: {
            status: (pluginId) => runtime.mcp.supervisor.status(pluginId),
            registered: (pluginId) => runtime.mcp.bridge.registered().get(pluginId),
            budget: (settings) => ({ used: runtime.mcp.bridge.used(settings), limit: runtime.mcp.bridge.limit() }),
          },
        },
        input,
        actor,
      ),
    mcpPageDetails,
  );
  if (!answer.ok) return answer;
  // The kill switch acts at once on the running owner.
  if (input.action === "switch") await runtime.mcp.switched(input.on);
  // A new decision (or a probe after a fix) starts the server afresh at its next call, a `failed` one included,
  // with its tools registered again as now approved (`pluginChanged`).
  else if (input.action === "probe" || input.action === "approve" || input.action === "reject") await runtime.mcp.changed(input.pluginId);
  return answer;
}

/**
 * `apps` — Connected apps on the owner:
 * the read model over every source, and a façade whose changes go through
 * `mcp` and `plugins`, so a page meets their refusals unchanged.
 */
export async function appsOwnerCommand(
  runtime: Parameters<typeof mcpCommand>[0] &
    Parameters<typeof pluginsCommand>[0] &
    Pick<import("../runtime/types.js").TaviRuntime, "toolRulesInForce" | "logger" | "channels" | "oauthBroker">,
  input: import("@tavi/contracts").AppsPayload,
  actor: string,
  /** The channels command, from an owner that runs it: a shared client then changes through it. */
  extra: {
    readonly channels?: (payload: import("@tavi/contracts").ChannelsPayload) => Promise<IpcAnswer<unknown>>;
    readonly declineConnect?: (waitId: string, workspaceId: string) => Promise<void>;
    /** The canvas's language: plugins' and channels' words come from their language packs (`features/plugins/localized.ts`). */
    readonly locale?: Locale | undefined;
  } = {},
): Promise<IpcAnswer<unknown>> {
  const repositories = runtime.store.asPort().repositories;
  const locale = extra.locale;
  const snapshotDirectory = (pluginId: string, version: string) => runtime.plugins.registry.snapshotDirectory(pluginId, version);
  // A pack is read only from a snapshot that still has its approved hash; without a language none is read.
  const snapshotOf =
    locale === undefined ? () => undefined : await pluginSnapshots({ list: () => runtime.plugins.registry.list(), snapshotDirectory });
  return await appsCommand(
    {
      ...(extra.channels === undefined ? {} : { channels: extra.channels }),
      ...(extra.declineConnect === undefined ? {} : { declineConnect: extra.declineConnect }),
      mcp: (payload) => mcpCommand(runtime, payload, actor),
      plugins: (payload) => pluginsCommand(runtime, payload, actor),
      views: () => runtime.plugins.registry.list(undefined, locale),
      // A snapshot that no longer reads presents as a bare app, from its view.
      manifestOf: (pluginId, version) =>
        localizedSnapshotManifest(snapshotDirectory(pluginId, version), locale, snapshotOf(pluginId, version)?.contentHash),
      sitesOf: snapshotSites((pluginId, version) => runtime.plugins.registry.snapshotDirectory(pluginId, version)),
      siteNotesOf: snapshotSiteNotes((pluginId, version) => runtime.plugins.registry.snapshotDirectory(pluginId, version)),
      connections: async (workspaceId) => await repositories.messagingConnections.list(workspaceId),
      descriptorOf: (providerId) => {
        const descriptor = channelDescriptorOf(providerId);
        return descriptor === undefined ? undefined : localizedChannelDescriptors([descriptor], locale, snapshotOf)[0];
      },
      descriptors: () => localizedChannelDescriptors(channelDescriptors(), locale, snapshotOf),
      channelStatus: (connectionId) => runtime.channels.statusOf(connectionId),
      channelSetup: (connectionId) => runtime.messaging.probeOf?.(connectionId)?.setup,
      rules: {
        inForce: (workspaceId) => runtime.toolRulesInForce(workspaceId),
        put: async (rule) => await repositories.toolPolicy.putRule(rule),
        remove: async (workspaceId, ruleId) => {
          const removed = await repositories.toolPolicy.deleteRule(workspaceId, ruleId);
          // Undoing a page's own tightening is the one loosening a page makes, so it is logged with who made it.
          if (removed) runtime.logger.info("a Connected apps page removed its own tool rule", { ruleId, workspaceId, actor });
          return removed;
        },
      },
      getMeta: (key) => runtime.store.getMeta(key),
      setMeta: async (key, value) => await runtime.store.setMeta(key, value, runtime.clock.now()),
      workspaceSettings: async (workspaceId) => (await repositories.workspaceSettings.get(workspaceId)).settings,
      workspaceIds: () => runtime.access.workspaceIds(),
      mcpGrant: (pluginId) => runtime.mcp.oauth.tokens.grant(pluginId),
      checkMailConsent: async (connectionId) => {
        const record = await repositories.messagingConnections.get(connectionId);
        if (record !== undefined) await runtime.oauthBroker.markMailConsentMissing(record);
      },
      credentialRefs: async () => new Set((await listCredentialRefs(runtime.dataDirectory)).valid),
      dataDirectory: runtime.dataDirectory,
      now: () => runtime.clock.now(),
      actor,
      activity: {
        effects: async (query) => await repositories.effects.listForTools(query),
        approvals: async (history) => await repositories.approvalInbox.history(history),
        calls: async (query) => await repositories.tasks.listCallsForTools(query),
      },
    },
    input,
  );
}

/**
 * `plugins` — list, install, review, enable/disable and configure plugins on
 * the owner. The answer's `restartRequired` says when a change only
 * takes effect at the next start, since plugins compose when the owner starts.
 */
export async function pluginsCommand(
  runtime: Pick<
    import("../runtime/types.js").TaviRuntime,
    "plugins" | "router" | "routerProviders" | "dataDirectory" | "store" | "mcp" | "access" | "clock" | "channelPurging" | "messaging"
  >,
  input: import("@tavi/contracts").PluginsPayload,
  actor: string,
  /** The canvas's language, for a listing's words (`PluginActionContext.locale`); absent: English as installed. */
  locale?: Locale,
): Promise<IpcAnswer<unknown>> {
  // From a page, an in-process (unsandboxed) approval is refused, as MCP's weaker sandbox is: it stays the CLI's.
  if (actor === operatorActor(true) && input.action === "approve" && input.inProcess === true) {
    return refuse(
      "NOT_AUTHORIZED",
      `a page cannot approve a plugin to run in-process (unsandboxed); use \`tavi plugins approve ${input.pluginId} ${input.version} --in-process\``,
    );
  }
  const boundBefore = "pluginId" in input && input.pluginId !== undefined ? runtime.routerProviders.bound(input.pluginId) : undefined;
  const answer = await answering(() =>
    runPluginAction(runtime.plugins.registry, input, actor, runtime.plugins, {
      ...(locale === undefined ? {} : { locale }),
      workspaceSettings: runtime.store.asPort().repositories.workspaceSettings,
      mcpBudget: (pluginId, version, workspaceId) => runtime.mcp.checkEnable(pluginId, version, workspaceId),
      channelPluginRemove: async (_pluginId, providerIds) =>
        await schedulePluginChannelPurges(
          runtime.channelPurging,
          providerIds,
          async (connectionId) =>
            runtime.messaging.statusOf(connectionId)?.accountRef ??
            (await rememberedAccount({ get: (key) => runtime.store.getMeta(key), set: async () => undefined }, connectionId))?.accountRef,
        ),
      channelPluginPreview: async (providerIds) => await pluginChannelPurgePreview(runtime.channelPurging, providerIds),
      mcpRemove: (pluginId, version) =>
        removeMcpServer(
          mcpRemovalDeps(
            runtime.plugins.registry,
            runtime.store.asPort().repositories,
            runtime.dataDirectory,
            runtime.access.workspaceIds(),
            () => runtime.clock.now(),
            (key, value) => runtime.store.setMeta(key, value, runtime.clock.now()),
            (id, lan, options) => runtime.mcp.oauth.revoke(id, lan, options),
            (id) => grantKeptBy(runtime, id),
          ),
          pluginId,
          version,
          actor,
        ),
    }),
  );
  // An MCP server reconciles live on every change (`pluginChanged`).
  if (
    answer.ok &&
    "pluginId" in input &&
    input.pluginId !== undefined &&
    input.pluginId.startsWith("mcp.") &&
    ["enable", "disable", "remove", "reject", "approve"].includes(input.action)
  )
    await runtime.mcp.changed(input.pluginId);
  if (
    !answer.ok ||
    !("restartRequired" in answer.result) ||
    (input.action !== "disable" && input.action !== "remove" && input.action !== "reject")
  )
    return answer;
  // A routing provider sends task data to a cloud service, so stopping it cannot
  // wait for the restart that unloads its code: unbind it (draining in-flight
  // decisions) and cancel pending router work before answering. Only the version
  // that was loaded counts: removing or rejecting another one leaves it running.
  const bound = boundBefore;
  const version = input.action === "reject" || input.action === "remove" ? input.version : undefined;
  const loaded = bound !== undefined && (version === undefined || bound.version === undefined || bound.version === version);
  if (!loaded) return answer;
  await runtime.routerProviders.unbind(input.pluginId);
  runtime.router.disable();
  return { ...answer, result: { ...answer.result, routingStopped: true } };
}
