import type { ProviderFactories, ProviderFactory } from "@tavi/contracts/plugin-sdk";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";
import {
  SUPPORTED_CHANNEL_ABIS,
  GroupCapabilitiesSchema,
  type ChannelHostServices,
  type ChannelMailboxKit,
  type RoutineTemplate,
  createServiceToken,
  HeartbeatProviderError,
  IdeasProviderError,
  type IdeasProvider,
  MemoryProviderError,
  type OnboardingProvider,
  type MemoryProvider,
  ROUTER_PROVIDER_FAILURES,
  RouterProviderError,
  TaviError,
  maxRisk,
  type HeartbeatProvider,
  type HeartbeatSignalSource,
  type CallAssessment,
  type ChannelDescriptor,
  type MessagingConnectorDefinition,
  type PluginDefinition,
  type PluginStartContext,
  type PluginVersionRecord,
  pluginToolOutputTrust,
  type RouterProvider,
  type ResourceScope,
  type ModEnvelope,
  type ModEvent,
  type ModHook,
  type ModHookMatch,
  MAX_MOD_HOOKS,
  PLUGIN_NOTICE_MAX_CHARS,
  PLUGIN_STATE_MAX_CHARS,
  PLUGIN_STATUS_MAX_CHARS,
  workerRefusal,
  type ModHookAnswer,
  type PluginIsolationPort,
  type ToolJsonSchema,
  type PluginToolCallContext,
  FindingWriteInputSchema,
  cardRows,
  clipText,
  PLUGIN_RESULT_FINDINGS_MAX,
  TASK_FINDING_MAX_CHARS,
  oversizedFindingIndex,
  type TaskFindingRepositoryPort,
  pluginTranslate,
  type PluginMessages,
} from "@tavi/contracts";
import type { Locale, MessageParams } from "@tavi/contracts/i18n";
import { zodIssues } from "@tavi/contracts/zod-util";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";
import {
  SearchFactoriesService,
  FetchFactoriesService,
  ModelFactoriesService,
  LoggerService,
  PersistenceService,
  OwnedResourceScope,
  declarationFor,
  disposeWithDeadline,
  findUnrepresentable,
  hookMatchOf,
  readPluginMessages,
  type ResolvedExternalPlugin,
  type RouterProviderSlot,
  type ToolRegistry,
  type TurnHookRegistry,
} from "@tavi/runtime";

import { cleanSchema, schemaFlags } from "../mcp/review.js";

/**
 * Loading approved external plugins.
 *
 * A plugin module exports (default or named) any of:
 *
 * - `register(context)`: called once before the runtime starts. It may call
 *   `context.registerTool({ name, inputSchema, handler })` for tools its
 *   manifest declares. The id (`<pluginId>.<name>`), description and effect
 *   come from the approved manifest, never from the code, so approval policy
 *   (mutating/external tools need an approval round) applies unchanged.
 * - `start(context)` / `stop()`: lifecycle, run inside the plugin host.
 *
 * - `context.provideRouter(provider)` (in `register`): a routing provider, when
 *   the approved manifest declares one (`provides: ["router"]`). It is asked
 *   only the features the manifest lists, is priced by the manifest's sheet,
 *   and answers only while the plugin runs. The host guard applies consent,
 *   budgets and deadlines first and validates every answer; see docs/PLUGINS.md.
 * - `context.provideHeartbeat(provider)` / `context.provideSignals(source)`
 *   (in `register`): a heartbeat provider and signal sources the approved
 *   manifest declares (docs/HEARTBEAT-PLUGINS.md). What a provider receives is
 *   the manifest's and the person's egress switches; both answer only while
 *   the plugin runs, and stopping it stops a tick it is answering.
 * - `context.provideMemory(provider)` (in `register`): a memory provider the
 *   approved manifest declares (`provides: ["memory"]`, docs/MEMORY-PLUGINS.md):
 *   only the capabilities it lists, answering only while the plugin runs. A
 *   workspace selects it with `tavi memory set-provider`; what it receives is
 *   that workspace's egress switches, and the host re-checks every id it ranks.
 *
 * `context.z` is tavi's own Zod, so a plugin needs no copy to describe input.
 * A version approved `process` runs in a confined worker
 * through `PluginIsolationPort`, and what it registers there is registered
 * here through the same checks (`workerModule`). Any other runs in the
 * owner's process: approval is the trust decision, and the snapshot's hash
 * was re-verified immediately before this import.
 */

import type {
  ExternalPluginLog,
  ExternalPluginState,
  ExternalPluginContext,
  ExternalPluginCommands,
  ExternalPluginUi,
  ExternalPluginHooks,
  ExternalRouterProvider,
  ExternalPluginModule,
} from "@tavi/plugin-types";

export type { ExternalPluginLog } from "@tavi/plugin-types";

/** What a plugin shows on a task, for the owner to publish on its stream. */
export type PluginUiMessage =
  | { readonly kind: "status"; readonly text?: string }
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "state"; readonly key: string; readonly value: unknown };

const HOOK_DEADLINE_MS = 10_000;
/** Published values one plugin may have waiting for its rate: the oldest beyond it is dropped. */
const MAX_WAITING_PUBLISHED = 64;
/** A router status is a local check answered while an operator waits. */
const ROUTER_STATUS_DEADLINE_MS = 1_000;
/** What a plugin's router status may report: short named facts, no nested data. */
const RouterStatusSchema = z
  .record(z.string().max(64), z.union([z.string().max(256), z.boolean()]))
  .refine((status) => Object.keys(status).length <= 16, "too many status fields");

function withDeadline<T>(work: Promise<T>, what: string, ms = HOOK_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function logFor(logger: ExternalPluginLog, pluginId: string): ExternalPluginLog {
  return {
    info: (message, fields) => logger.info(message, { ...fields, pluginId }),
    warn: (message, fields) => logger.warn(message, { ...fields, pluginId }),
    error: (message, fields) => logger.error(message, { ...fields, pluginId }),
  };
}

function moduleShape(loaded: Record<string, unknown>): ExternalPluginModule {
  const fallback = loaded["default"];
  const candidate = (typeof fallback === "object" && fallback !== null ? fallback : loaded) as Record<string, unknown>;
  const hook = (name: string) =>
    typeof candidate[name] === "function" ? (candidate[name] as (...args: never[]) => unknown).bind(candidate) : undefined;
  const register = hook("register"),
    start = hook("start"),
    stop = hook("stop");
  if (register === undefined && start === undefined) throw new Error("the entry exports neither register nor start");
  return {
    ...(register === undefined ? {} : { register: register as ExternalPluginModule["register"] }),
    ...(start === undefined ? {} : { start: start as ExternalPluginModule["start"] }),
    ...(stop === undefined ? {} : { stop: stop as ExternalPluginModule["stop"] }),
  } as ExternalPluginModule;
}

export interface ExternalPluginLoad {
  /** Host definitions for the plugins that loaded; their start failures are recorded, not thrown. */
  readonly definitions: readonly PluginDefinition[];
  /** Why each plugin that did not load (or later failed to start) is not running. */
  readonly failures: Map<string, string>;
  readonly withdrawn: ReadonlySet<string>;
  /** Stop a loaded plugin; resolves to a warning when its cleanup failed, since the durable change already committed. */
  withdraw(pluginId: string, version?: string): Promise<string | undefined>;
  /** Stop a composed plugin and start it again from `plugin` (a dev plugin's new snapshot); resolves to why it is not running, or a cleanup warning. */
  reload(plugin: Extract<ResolvedExternalPlugin, { ok: true }>): Promise<string | undefined>;
}

/**
 * Prepare host definitions; import and register only inside owned startup. One plugin's failure never stops
 * another, nor the owner: a plugin that failed leaves no tools behind.
 */
/**
 * Where a plugin's channels go: its descriptor joins the
 * catalog and its connector the messaging service; the function returned
 * withdraws both, and is called when the plugin stops.
 */
export interface ExternalChannelHost {
  /** Installs one of plugin `pluginId`'s channels; the function returned withdraws it. */
  register(
    descriptor: ChannelDescriptor,
    definition: MessagingConnectorDefinition,
    plugin: {
      readonly pluginId: string;
      /** The approved version: a shared client the operator bound is this version's only. */
      readonly version: string;
      readonly mailbox?: ChannelMailboxKit<typeof fetch>;
    },
  ): Promise<() => Promise<void>> | (() => Promise<void>);
  /** Whether a channel of this provider id is already installed (a builtin, or another plugin's). */
  taken(providerId: string): boolean;
  /**
   * The services a channel plugin built for channel ABI 2 is handed as
   * `ctx.channelHost`, for
   * the channels it declares: the same clock, `fetch` and artifact reader a
   * builtin channel gets. Absent: plugins get none.
   */
  services?(providerIds: readonly string[]): ChannelHostServices<typeof fetch>;
}

/**
 * Where a plugin's heartbeat provider and signal sources go:
 * each function installs one and answers how to withdraw it, which the
 * plugin's lifetime does when it stops.
 */
export interface ExternalHeartbeatHost {
  installProvider(record: PluginVersionRecord, provider: HeartbeatProvider, signal: AbortSignal): () => void;
  installSource(record: PluginVersionRecord, source: HeartbeatSignalSource): () => void;
}

/**
 * Where a plugin's memory provider goes:
 * composition's registry, under the plugin's id, with its declaration; the
 * function returned withdraws it, which the plugin's lifetime does when it stops.
 */
export interface ExternalMemoryHost {
  installProvider(record: PluginVersionRecord, provider: MemoryProvider): () => void;
}

/**
 * Where a plugin's ideas provider goes (docs/IDEAS-PLUGINS.md): the ideas
 * host's registry, under the plugin's id, with its declaration; the function
 * returned withdraws it, which the plugin's lifetime does when it stops.
 */
export interface ExternalIdeasHost {
  installProvider(record: PluginVersionRecord, provider: IdeasProvider, signal: AbortSignal): () => void;
}

/**
 * Where a plugin's onboarding flow goes (docs/ONBOARDING-PLUGINS.md):
 * the onboarding host's registry, under the plugin's id, with its declaration;
 * the function returned withdraws it, which the plugin's lifetime does when it
 * stops, so the host falls back to the built-in flow.
 */
export interface ExternalOnboardingHost {
  installProvider(record: PluginVersionRecord, provider: OnboardingProvider, signal: AbortSignal): () => void;
}

/**
 * Where a plugin's routine report templates go (its manifest's
 * `routineTemplates`): installed once it runs, withdrawn when it stops; a
 * routine saved meanwhile copies its own into the revision.
 */
export interface ExternalRoutineTemplateHost {
  install(pluginId: string, templates: readonly RoutineTemplate[]): () => void;
}

/** The workspace's language for plugins' `ctx.locale`: what it is now, and each change. */
export interface ExternalPluginLanguage {
  current(): Locale;
  /** Hears each change; answers the unsubscribe. */
  onChange?(listener: (locale: Locale) => void): () => void;
}

/**
 * `context` with `locale`, read live from `language` on each use (English
 * without one), and `t`, the plugin's own `messages` in that language with
 * English, then the key, behind it. A spread copies a getter's value, so each
 * context a plugin is handed is given its own.
 */
function withLanguage<T extends object>(
  context: T,
  language: ExternalPluginLanguage | undefined,
  messages: PluginMessages,
): T & { readonly locale: Locale; t(key: string, params?: MessageParams): string } {
  const now = (): Locale => language?.current() ?? "en";
  return Object.defineProperties(context, {
    locale: { get: now, enumerable: true, configurable: true },
    t: {
      value: (key: string, params?: MessageParams) => pluginTranslate(messages, now(), key, params),
      enumerable: true,
      configurable: true,
    },
  }) as T & { readonly locale: Locale; t(key: string, params?: MessageParams): string };
}

export async function loadExternalPlugins(
  resolved: readonly ResolvedExternalPlugin[],
  tools: ToolRegistry,
  logger: ExternalPluginLog,
  resolveSecret: (reference: string) => Promise<string | null>,
  routers: Pick<RouterProviderSlot, "bind">,
  activate?: (plugin: Extract<ResolvedExternalPlugin, { ok: true }>, scope: ResourceScope) => Promise<void>,
  shutdown?: AbortSignal,
  channels?: ExternalChannelHost,
  turnHooks?: TurnHookRegistry,
  pluginUi?: (pluginId: string, taskId: string, message: PluginUiMessage) => void,
  heartbeat?: ExternalHeartbeatHost,
  memory?: ExternalMemoryHost,
  isolation?: PluginIsolationPort,
  household?: ExternalPluginHousehold,
  findings?: ExternalPluginFindings,
  ideas?: ExternalIdeasHost,
  onboarding?: ExternalOnboardingHost,
  routineTemplates?: ExternalRoutineTemplateHost,
  language?: ExternalPluginLanguage,
): Promise<ExternalPluginLoad> {
  const definitions: PluginDefinition[] = [];
  const failures = new Map<string, string>();
  const withdrawn = new Set<string>();
  const lifetimes = new Map<string, { version: string; lifetime: OwnedResourceScope; stop: () => void }>();
  // Each plugin's host start, kept so a dev plugin can be started again on save.
  const kernels = new Map<string, PluginStartContext>();
  const startPlugin = async (
    plugin: Extract<ResolvedExternalPlugin, { ok: true }>,
    { scope, signal, dependencies }: PluginStartContext,
  ): Promise<boolean> => {
    const { record, config } = plugin;
    const log = logFor(logger, record.pluginId);
    // Registered only if register() completes and every tool fits: a failure leaves no tool behind.
    // Tools answer only while the plugin runs, so one whose start fails offers nothing.
    const state = { running: false, signal: new AbortController().signal };
    const lifetime = new OwnedResourceScope();
    state.signal = lifetime.signal;
    lifetimes.set(record.pluginId, {
      version: record.version,
      lifetime,
      stop: () => {
        state.running = false;
      },
    });
    scope.defer(() => closeLifetime(lifetime));
    const abort = () => {
      state.running = false;
      lifetime.abort(signal.reason);
    };
    const ownerSignal = shutdown === undefined ? signal : AbortSignal.any([signal, shutdown]);
    ownerSignal.addEventListener("abort", abort, { once: true });
    lifetime.defer(() => ownerSignal.removeEventListener("abort", abort));
    if (ownerSignal.aborted) abort();
    let registering = true;
    const pending: Parameters<ToolRegistry["registerExternal"]>[0][] = [];
    try {
      signal.throwIfAborted();
      // An MCP server runs out of process: nothing of its is ever imported here.
      if (record.manifest.mcp !== undefined) throw new Error("it is an MCP server, which runs out of process and is never imported");
      // Built for another channel contract: refused before any of its code runs, with what it needs.
      if (record.manifest.channels.length > 0 && !SUPPORTED_CHANNEL_ABIS.includes(record.manifest.channelAbi ?? 0)) {
        throw new Error(
          `it needs an update: its channels are built for channel ABI ${String(record.manifest.channelAbi)}, and this tavi speaks ${SUPPORTED_CHANNEL_ABIS.join(" and ")}`,
        );
      }
      // A channel already installed (a builtin's id) is not a plugin's to declare: refused before its code runs.
      const claimed = record.manifest.channels.find((channel) => channels?.taken(channel.providerId) === true);
      if (claimed !== undefined) throw new Error(`its channel ${claimed.providerId} is already installed`);
      // Its own words by language, from the packs approved with it, read from its snapshot only while it has its approved hash (`ctx.t`).
      const messages = readPluginMessages(plugin.directory, record.manifest, record.contentHash);
      const module =
        record.isolation === "process"
          ? workerModule(plugin, isolation, language, messages)
          : moduleShape(
              await withDeadline(
                import(`${pathToFileURL(plugin.entryPath).href}?sha256=${record.contentHash}`) as Promise<Record<string, unknown>>,
                "import",
              ),
            );
      lifetime.signal.throwIfAborted();
      if (module.stop !== undefined) lifetime.defer(() => withDeadline(Promise.resolve(module.stop?.()), "stop"));
      const secret = async (key: string): Promise<string | null> => {
        lifetime.signal.throwIfAborted();
        const reference = config[key];
        if (record.manifest.config[key]?.type !== "credential")
          throw new TaviError("NOT_AUTHORIZED", `${key} is not a credential setting of ${record.pluginId}`);
        // A declared credential nobody set is absent: the plugin decides what it does without it.
        if (typeof reference !== "string") return null;
        const value = await resolveSecret(reference);
        lifetime.signal.throwIfAborted();
        return value;
      };
      const persistence = dependencies.tryGet(PersistenceService);
      let writeQueue = Promise.resolve();
      lifetime.defer(async () => {
        await writeQueue;
      });
      const stateStore: ExternalPluginState = {
        load: async () => {
          lifetime.signal.throwIfAborted();
          if (!persistence) throw new TaviError("UNAVAILABLE", "plugin state needs the persistence service");
          // After every write already queued, so a load never reads behind the plugin's own put.
          await writeQueue;
          return (await persistence.repositories.plugins.loadPluginState(plugin.stateId ?? record.pluginId)) as Record<string, unknown>;
        },
        put: async (namespace: string, value: unknown) => {
          lifetime.signal.throwIfAborted();
          if (!persistence) throw new TaviError("UNAVAILABLE", "plugin state needs the persistence service");
          return new Promise<void>((resolve, reject) => {
            // A write accepted before the plugin stopped still lands: the lifetime awaits the queue.
            writeQueue = writeQueue.then(async () => {
              try {
                await persistence.repositories.plugins.putPluginState(plugin.stateId ?? record.pluginId, namespace, value, nowTimestamp());
                resolve();
              } catch (err) {
                reject(err);
              }
            });
          });
        },
      };
      // At most 4 a second, on tasks its hooks were handed.
      const handedTask = (envelope: ModEnvelope): string => {
        lifetime.signal.throwIfAborted();
        const taskId = turnHooks?.handedTask(record.pluginId, envelope);
        if (taskId === undefined)
          throw new TaviError(
            "NOT_AUTHORIZED",
            "a plugin shows a status, notice or published value only on a task its hooks were handed: pass the event's envelope",
          );
        return taskId;
      };
      // Only what is sent counts against a limit, so a plugin that slows down is heard again.
      const admitted = (sent: number[]): boolean => {
        const at = Date.now();
        for (let first = sent[0]; first !== undefined && at - first >= 1_000; first = sent[0]) sent.shift();
        if (sent.length >= 4) return false;
        sent.push(at);
        return true;
      };
      const shown: number[] = [];
      // The tasks this plugin shows a status line on, cleared when it stops (a withdrawn plugin leaves no stale line).
      const statusTasks = new Set<string>();
      lifetime.defer(() => {
        for (const taskId of statusTasks) pluginUi?.(record.pluginId, taskId, { kind: "status" });
        statusTasks.clear();
      });
      const show = (envelope: ModEnvelope, message: PluginUiMessage): void => {
        const taskId = handedTask(envelope);
        // A clear of a line it shows is never held to the limit: dropped, the line would stay. One with no line to clear sends nothing.
        const clearing = message.kind === "status" && message.text === undefined;
        if (clearing && !statusTasks.has(taskId)) return;
        if (!clearing && !admitted(shown)) return;
        if (message.kind === "status") {
          if (message.text === undefined) statusTasks.delete(taskId);
          else statusTasks.add(taskId);
        }
        pluginUi?.(record.pluginId, taskId, message);
      };
      // Published values have their own limit; one over it waits, the newest per key, since a pane is never sent it again.
      const published: number[] = [];
      const waiting = new Map<string, { readonly taskId: string; readonly key: string; readonly value: unknown }>();
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let dropped = 0;
      const flush = (): void => {
        flushTimer = undefined;
        if (dropped > 0) log.warn("published values were dropped: the plugin publishes faster than values are sent", { dropped });
        dropped = 0;
        if (lifetime.signal.aborted) {
          waiting.clear();
          return;
        }
        for (const [slot, entry] of waiting) {
          if (!admitted(published)) break;
          waiting.delete(slot);
          try {
            pluginUi?.(record.pluginId, entry.taskId, { kind: "state", key: entry.key, value: entry.value });
          } catch (error) {
            log.warn("a published value was not sent", { key: entry.key, error });
          }
        }
        const oldest = published[0];
        if (waiting.size > 0) flushTimer = setTimeout(flush, oldest === undefined ? 0 : Math.max(0, 1_000 - (Date.now() - oldest)));
      };
      lifetime.signal.addEventListener("abort", () => clearTimeout(flushTimer), { once: true });
      const ui: ExternalPluginUi = {
        status: (envelope, text) =>
          show(
            envelope,
            text === undefined || text === ""
              ? { kind: "status" }
              : { kind: "status", text: String(text).slice(0, PLUGIN_STATUS_MAX_CHARS) },
          ),
        notice: (envelope, text) => {
          const clipped = String(text).slice(0, PLUGIN_NOTICE_MAX_CHARS);
          if (clipped.trim() !== "") show(envelope, { kind: "notice", text: clipped });
        },
        publish: (envelope, key, value) => {
          if (typeof key !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(key))
            throw new TaviError("INVALID_INPUT", "a published key is 1-64 letters, digits, dots, dashes or underscores");
          let json: string | undefined;
          try {
            json = JSON.stringify(value ?? null);
          } catch {
            json = undefined;
          }
          if (json === undefined || json.length > PLUGIN_STATE_MAX_CHARS)
            throw new TaviError("INVALID_INPUT", `a published value is JSON of at most ${PLUGIN_STATE_MAX_CHARS} characters`);
          const taskId = handedTask(envelope);
          const parsed: unknown = JSON.parse(json);
          if (waiting.size === 0 && admitted(published)) {
            pluginUi?.(record.pluginId, taskId, { kind: "state", key, value: parsed });
            return;
          }
          const slot = `${taskId}\u0000${key}`;
          waiting.delete(slot);
          waiting.set(slot, { taskId, key, value: parsed });
          // Bounded: a plugin publishing faster than it is sent loses its oldest value, never the owner's memory.
          if (waiting.size > MAX_WAITING_PUBLISHED) {
            const oldest = waiting.keys().next().value;
            if (oldest !== undefined) waiting.delete(oldest);
            // Told once per flush, however many: a flood of keys must not flood the owner\'s log too.
            dropped += 1;
          }
          flushTimer ??= setTimeout(flush, 0);
        },
      };
      const base = withLanguage(
        {
          pluginId: record.pluginId,
          version: record.version,
          config: Object.freeze({ ...config }),
          z,
          log,
          secret,
          state: stateStore,
          scope: lifetime,
          signal: lifetime.signal,
          ui,
          RouterProviderError,
          ROUTER_PROVIDER_FAILURES,
          TaviError,
        },
        language,
        messages,
      );
      let router: RouterProvider | undefined;
      let refused: string | undefined;
      // A refusal fails the load even if the plugin catches it.
      const refuse = (why: string): never => {
        refused ??= why;
        throw new Error(why);
      };
      const provideRouter = (provider: ExternalRouterProvider): void => {
        if (!registering || lifetime.signal.aborted) refuse("plugin registration is closed");
        if (router !== undefined) refuse("provideRouter was already called");
        try {
          router = routerProvider(record, provider);
        } catch (error) {
          refuse(errorMessage(error));
        }
      };
      let heartbeatProvider: HeartbeatProvider | undefined;
      const provideHeartbeat = (provider: HeartbeatProvider): void => {
        if (!registering || lifetime.signal.aborted) refuse("plugin registration is closed");
        if (heartbeatProvider !== undefined) refuse("provideHeartbeat was already called");
        try {
          heartbeatProvider = externalHeartbeatProvider(record, provider, state);
        } catch (error) {
          refuse(errorMessage(error));
        }
      };
      const signalSources = new Map<string, HeartbeatSignalSource>();
      const provideSignals = (source: HeartbeatSignalSource): void => {
        if (!registering || lifetime.signal.aborted) refuse("plugin registration is closed");
        try {
          const checked = externalSignalSource(record, source, state);
          if (signalSources.has(checked.id)) refuse(`provideSignals was already called for ${checked.id}`);
          signalSources.set(checked.id, checked);
        } catch (error) {
          refuse(errorMessage(error));
        }
      };
      const heartbeatContext = heartbeat === undefined ? {} : { provideHeartbeat, provideSignals, HeartbeatProviderError };
      let memoryProvider: MemoryProvider | undefined;
      const provideMemory = (provider: MemoryProvider): void => {
        if (!registering || lifetime.signal.aborted) refuse("plugin registration is closed");
        if (memoryProvider !== undefined) refuse("provideMemory was already called");
        try {
          memoryProvider = externalMemoryProvider(record, provider, state);
        } catch (error) {
          refuse(errorMessage(error));
        }
      };
      const memoryContext = memory === undefined ? {} : { provideMemory, MemoryProviderError };
      let ideasProvider: IdeasProvider | undefined;
      const provideIdeas = (provider: IdeasProvider): void => {
        if (!registering || lifetime.signal.aborted) refuse("plugin registration is closed");
        if (ideasProvider !== undefined) refuse("provideIdeas was already called");
        try {
          ideasProvider = externalIdeasProvider(record, provider, state);
        } catch (error) {
          refuse(errorMessage(error));
        }
      };
      const ideasContext = ideas === undefined ? {} : { provideIdeas, IdeasProviderError };
      let onboardingProvider: OnboardingProvider | undefined;
      const provideOnboarding = (provider: OnboardingProvider): void => {
        if (!registering || lifetime.signal.aborted) refuse("plugin registration is closed");
        if (onboardingProvider !== undefined) refuse("provideOnboarding was already called");
        try {
          onboardingProvider = externalOnboardingProvider(record, provider, state);
        } catch (error) {
          refuse(errorMessage(error));
        }
      };
      // Offered only to a plugin whose approved manifest declares a flow.
      const onboardingContext = onboarding === undefined || record.manifest.onboarding === undefined ? {} : { provideOnboarding };
      const registerFactory = <Provider, Settings>(
        kind: "search" | "fetch" | "model",
        name: string,
        factory: ProviderFactory<Provider, Settings>,
        registry: ProviderFactories<Provider>,
      ): void => {
        if (
          !registering ||
          lifetime.signal.aborted ||
          !record.manifest.capabilities.some((item) => item.id === name && item.kind === kind)
        ) {
          refused = `factory ${name} is undeclared or registration is closed`;
          throw new Error(refused);
        }
        registry.register(`${record.pluginId}.${name}`, factory, lifetime);
      };
      const channelConnectors: {
        readonly descriptor: ChannelDescriptor;
        readonly definition: MessagingConnectorDefinition;
        readonly mailbox?: ChannelMailboxKit<typeof fetch>;
      }[] = [];
      const registerChannel = (
        definition: MessagingConnectorDefinition,
        options?: { readonly mailbox?: ChannelMailboxKit<typeof fetch> },
      ): void => {
        if (!registering || lifetime.signal.aborted) refuse("plugin registration is closed");
        const descriptor = record.manifest.channels.find((channel) => channel.providerId === definition.providerId);
        if (descriptor === undefined) refuse(`channel ${definition.providerId} is not declared in the manifest`);
        if (channelConnectors.some((entry) => entry.definition.providerId === definition.providerId))
          refuse(`channel ${definition.providerId} was registered twice`);
        if (channels === undefined) refuse("this owner takes no channel plugins");
        if (descriptor === undefined) return;
        // Groups are channel ABI 2's: an ABI 1 plugin's are not read; an ABI 2 plugin's must parse, and a new room's trigger use only what it reports.
        const { groups, ...rest } = definition.capabilities;
        let capabilities = definition.capabilities;
        if (groups !== undefined && (record.manifest.channelAbi ?? 1) < 2) capabilities = rest;
        else if (groups !== undefined) {
          const parsed = GroupCapabilitiesSchema.safeParse(groups);
          if (!parsed.success)
            refuse(
              `channel ${descriptor.providerId}'s group capabilities are invalid: ${parsed.error.issues[0]?.message ?? "they do not parse"}`,
            );
          const unreported = descriptor.groups?.defaultTrigger.filter((kind) => !groups.addressing.includes(kind)) ?? [];
          if (unreported.length > 0)
            refuse(`channel ${descriptor.providerId}'s default trigger uses ${unreported.join(", ")}, which its connector does not report`);
        }
        // A mailbox is reviewed with the descriptor: one it does not declare is refused, never quietly dropped.
        if (options?.mailbox !== undefined && descriptor.app?.mailbox !== true)
          refuse(`channel ${descriptor.providerId} registered a mailbox its manifest does not declare (app.mailbox)`);
        // Pinned to the reviewed id: what the host later withdraws is the declared channel, whatever the object says then.
        channelConnectors.push({
          descriptor,
          definition: Object.freeze({ ...definition, providerId: descriptor.providerId, capabilities }),
          ...(options?.mailbox === undefined ? {} : { mailbox: options.mailbox }),
        });
      };
      // Channel ABI 2's host services: an artifact is read only up to what a channel this plugin registered may send.
      const hostServices =
        (record.manifest.channelAbi ?? 1) >= 2 && record.manifest.channels.length > 0
          ? channels?.services?.(record.manifest.channels.map((channel) => channel.providerId))
          : undefined;
      const channelHost: ChannelHostServices<typeof fetch> | undefined =
        hostServices === undefined
          ? undefined
          : {
              now: hostServices.now,
              fetch: hostServices.fetch,
              readArtifact: async (artifactId, workspaceId, maxBytes) => {
                if (lifetime.signal.aborted) return undefined;
                const sendable = Math.max(
                  0,
                  ...channelConnectors
                    .filter((entry) => entry.definition.capabilities.attachments)
                    .map((entry) => entry.definition.capabilities.maxAttachmentBytes),
                );
                return sendable === 0 ? undefined : hostServices.readArtifact(artifactId, workspaceId, Math.min(maxBytes, sendable));
              },
            };
      const declaredHooks = record.manifest.mods?.hooks ?? [];
      const pendingHooks: (() => () => void)[] = [];
      const registeredEvents = new Set<ModEvent>();
      let commandsAdded = 0;
      const registeredCommands = new Set<string>();
      const on = (event: ModEvent, matchOrHook: ModHookMatch | ModHook<ModEvent>, maybeHook?: ModHook<ModEvent>): void => {
        if (!registering || lifetime.signal.aborted) refuse("plugin registration is closed");
        if (turnHooks === undefined) refuse("this owner takes no plugin hooks");
        const hook = typeof matchOrHook === "function" ? matchOrHook : maybeHook;
        const match = typeof matchOrHook === "function" ? undefined : matchOrHook;
        if (typeof hook !== "function") refuse(`hooks.on("${event}") needs a hook function`);
        // As many as a manifest may declare: each has its own budget on every dispatch it matches.
        if (pendingHooks.length - commandsAdded >= MAX_MOD_HOOKS)
          refuse(`plugin ${record.pluginId} registered more than ${MAX_MOD_HOOKS} hooks`);
        // Checked now, so a hook the manifest did not declare, or a match that is no match, fails the load with the reason.
        // The parsed copy is what registers: a plugin that changes its object later widens nothing.
        let checked: ModHookMatch | undefined;
        try {
          checked = hookMatchOf(record.pluginId, event, match);
          declarationFor(record.pluginId, declaredHooks, event, checked);
        } catch (error) {
          refuse(errorMessage(error));
        }
        if (turnHooks !== undefined && hook !== undefined) {
          registeredEvents.add(event);
          pendingHooks.push(() => turnHooks.register(record.pluginId, declaredHooks, event, checked, hook));
        }
      };
      const hooks: ExternalPluginHooks = { on: on as ExternalPluginHooks["on"] };
      const declaredCommands = record.manifest.mods?.commands ?? [];
      const commands: ExternalPluginCommands = {
        register: (command) => {
          if (!registering || lifetime.signal.aborted) refuse("plugin registration is closed");
          if (turnHooks === undefined) refuse("this owner takes no plugin commands");
          if (typeof command?.run !== "function") refuse("commands.register needs a run function");
          if (!declaredCommands.some((declared) => declared.name === command.name))
            refuse(`plugin ${record.pluginId} did not declare a /${String(command.name)} command in its manifest's mods block`);
          // Once each: a second registration would make the command unreachable by its own name.
          if (registeredCommands.has(command.name)) refuse(`plugin ${record.pluginId} registered its /${command.name} command twice`);
          registeredCommands.add(command.name);
          if (turnHooks !== undefined) {
            commandsAdded += 1;
            pendingHooks.push(() => turnHooks.registerCommand(record.pluginId, declaredCommands, command.name, command.run));
          }
        },
      };
      await withDeadline(
        Promise.resolve(
          module.register?.(
            withLanguage(
              {
                ...base,
                ...heartbeatContext,
                ...memoryContext,
                ...ideasContext,
                ...onboardingContext,
                registerChannel,
                ...(channelHost === undefined ? {} : { channelHost }),
                hooks,
                commands,
                registerSearch: (name, factory) => registerFactory("search", name, factory, dependencies.get(SearchFactoriesService)),
                registerFetch: (name, factory) => registerFactory("fetch", name, factory, dependencies.get(FetchFactoriesService)),
                registerModel: (name, factory) => registerFactory("model", name, factory, dependencies.get(ModelFactoriesService)),
                registerTool: (tool) => {
                  if (!registering || lifetime.signal.aborted) throw new Error("plugin registration is closed");
                  const raw = rawModelSchemaOf(tool);
                  const registration = toolRegistration(record, tool, raw, state, household, findings, (id) => tools.has(id));
                  // Its schema reads like instructions: said in the log, as `tavi plugins validate` says it to the author. The
                  // raw schema is reviewed, so hidden characters that cleaning takes out of a property name are flagged too.
                  const flagged = schemaFlags(raw, "/inputSchema");
                  if (flagged.length > 0)
                    log.warn("a tool's schema reads like instructions", { tool: registration.id, at: flagged.slice(0, 10) });
                  pending.push(registration);
                },
                provideRouter,
              },
              language,
              messages,
            ),
          ),
        ),
        "register",
      );
      registering = false;
      lifetime.signal.throwIfAborted();
      if (refused !== undefined) throw new Error(refused);
      // An external tool that states no sink in its manifest takes the
      // external entry point's default, a request with a model-chosen payload.
      lifetime.defer(tools.registerExternalBatch(pending));
      const undeclared = record.manifest.tools.filter(
        (tool) => !pending.some((registration) => registration.id === `${record.pluginId}.${tool.name}`),
      );
      if (undeclared.length > 0) log.warn("declared tools were not registered", { tools: undeclared.map((tool) => tool.name) });
      if (record.manifest.router !== undefined && router === undefined) log.warn("the declared routing provider was not supplied");
      if (heartbeat !== undefined && record.manifest.heartbeat !== undefined && heartbeatProvider === undefined)
        log.warn("the declared heartbeat provider was not supplied");
      if (memory !== undefined && record.manifest.memory !== undefined && memoryProvider === undefined)
        log.warn("the declared memory provider was not supplied");
      if (ideas !== undefined && record.manifest.ideas !== undefined && ideasProvider === undefined)
        log.warn("the declared ideas provider was not supplied");
      if (onboarding !== undefined && record.manifest.onboarding !== undefined && onboardingProvider === undefined)
        log.warn("the declared onboarding flow was not supplied");
      const unsourced =
        heartbeat === undefined ? [] : (record.manifest.heartbeatSignals?.sources ?? []).filter((id) => !signalSources.has(id));
      if (unsourced.length > 0) log.warn("declared heartbeat signal sources were not supplied", { sources: unsourced });
      const unsupplied = record.manifest.channels.filter(
        (channel) => !channelConnectors.some((entry) => entry.descriptor.providerId === channel.providerId),
      );
      if (unsupplied.length > 0)
        log.warn("declared channels were not registered", { channels: unsupplied.map((channel) => channel.providerId) });
      const unhooked = declaredHooks.filter((hook) => !registeredEvents.has(hook.event));
      if (unhooked.length > 0) log.warn("declared hooks were not registered", { events: unhooked.map((hook) => hook.event) });
      await withDeadline(Promise.resolve(module.start?.(base)), "start");
      lifetime.signal.throwIfAborted();
      await activate?.(plugin, lifetime);
      lifetime.signal.throwIfAborted();
      if (router !== undefined) lifetime.defer(routers.bind(record.pluginId, router, record.version));
      // Its heartbeat provider and sources answer once it runs; stopping it withdraws them and stops a tick in flight.
      if (heartbeat !== undefined && heartbeatProvider !== undefined)
        lifetime.defer(heartbeat.installProvider(record, heartbeatProvider, lifetime.signal));
      if (heartbeat !== undefined) for (const source of signalSources.values()) lifetime.defer(heartbeat.installSource(record, source));
      // Its channels join the catalog and the messaging service once it runs, and leave them when it stops.
      for (const { descriptor, definition, mailbox } of channelConnectors) {
        const withdraw = await channels?.register(descriptor, definition, {
          pluginId: record.pluginId,
          version: record.version,
          ...(mailbox === undefined ? {} : { mailbox }),
        });
        if (withdraw !== undefined) lifetime.defer(withdraw);
      }
      // Its hooks run while it does: they join once it has started, and leave with its lifetime.
      for (const add of pendingHooks) lifetime.defer(add());
      state.running = true;
      lifetime.defer(() => {
        state.running = false;
      });
      // Its memory provider joins composition's registry once it runs (and is sent what it missed), and leaves
      // it when it stops: a workspace that selected it falls back to the built-in.
      if (memory !== undefined && memoryProvider !== undefined) lifetime.defer(memory.installProvider(record, memoryProvider));
      if (ideas !== undefined && ideasProvider !== undefined) lifetime.defer(ideas.installProvider(record, ideasProvider, lifetime.signal));
      if (onboarding !== undefined && onboardingProvider !== undefined)
        lifetime.defer(onboarding.installProvider(record, onboardingProvider, lifetime.signal));
      // Its routine templates are data, reviewed with the version: offered while it runs.
      const templates = record.manifest.routineTemplates ?? [];
      if (routineTemplates !== undefined && templates.length > 0) lifetime.defer(routineTemplates.install(record.pluginId, templates));
      log.info("external plugin loaded", { version: record.version, tools: pending.length, hooks: pendingHooks.length });
      // Third-party code beside the owner: tagged in the log as in `plugins list`, `doctor` and the canvas.
      if (record.isolation !== "process")
        log.warn("external plugin runs UNSANDBOXED in the owner's process, with its privileges", {
          version: record.version,
          isolation: record.isolation ?? "none recorded (approved before workers, or a dev plugin)",
        });
    } catch (error) {
      registering = false;
      let message = errorMessage(error);
      try {
        await closeLifetime(lifetime);
      } catch (cleanup) {
        message += `; cleanup: ${errorMessage(cleanup)}`;
      }
      if (lifetimes.get(record.pluginId)?.lifetime === lifetime) lifetimes.delete(record.pluginId);
      failures.set(record.pluginId, message);
      log.error("external plugin failed to load", { error: message });
    }
    return state.running;
  };
  for (const plugin of resolved) {
    if (!plugin.ok) {
      failures.set(plugin.pluginId, plugin.error);
      logger.warn("external plugin not loaded", { pluginId: plugin.pluginId, error: plugin.error });
      continue;
    }
    const { record } = plugin;
    const ready = createServiceToken<boolean>(`${record.pluginId}.registered`);
    definitions.push({
      id: record.pluginId,
      version: record.version,
      provides: [ready],
      requires: [LoggerService, SearchFactoriesService, FetchFactoriesService, ModelFactoriesService],
      optional: [PersistenceService],
      start: async (kernel) => {
        kernels.set(record.pluginId, kernel);
        return { [ready.id]: await startPlugin(plugin, kernel) };
      },
    });
  }
  const withdraw = async (pluginId: string, version?: string): Promise<string | undefined> => {
    const active = lifetimes.get(pluginId);
    if (active === undefined || (version !== undefined && active.version !== version)) return undefined;
    lifetimes.delete(pluginId);
    active.stop();
    withdrawn.add(pluginId);
    active.lifetime.abort(new TaviError("NOT_AUTHORIZED", `Plugin ${pluginId} was withdrawn`));
    try {
      await closeLifetime(active.lifetime);
      return undefined;
    } catch (error) {
      const warning = `${pluginId} was withdrawn but its cleanup failed: ${errorMessage(error)}`;
      failures.set(pluginId, warning);
      logger.warn("external plugin cleanup failed", { pluginId, error: warning });
      return warning;
    }
  };
  return {
    definitions,
    failures,
    withdrawn,
    withdraw,
    reload: async (plugin) => {
      const pluginId = plugin.record.pluginId;
      const kernel = kernels.get(pluginId);
      if (kernel === undefined) throw new TaviError("NOT_FOUND", `${pluginId} was not composed in this owner run`);
      kernel.signal.throwIfAborted();
      const warning = await withdraw(pluginId);
      withdrawn.delete(pluginId);
      failures.delete(pluginId);
      // New code: the old code's failures do not count against it.
      turnHooks?.reset(pluginId);
      const running = await startPlugin(plugin, kernel);
      return running ? warning : failures.get(pluginId);
    },
  };
}

/**
 * The host's wrapper around a plugin's heartbeat provider: its methods are
 * taken once, when it is supplied, so a plugin that changes its object later
 * changes nothing; each call is refused unless the plugin runs. What a tick
 * carries, and what comes back, is the host's to decide and validate.
 */
function externalHeartbeatProvider(
  record: PluginVersionRecord,
  provider: HeartbeatProvider,
  state: { readonly running: boolean },
): HeartbeatProvider {
  if (record.manifest.heartbeat === undefined) throw new Error("provideHeartbeat needs a heartbeat declaration in the approved manifest");
  if (provider === null || typeof provider !== "object" || typeof provider.tick !== "function")
    throw new Error("provideHeartbeat needs a tick function");
  const { tick, precheck, status } = provider;
  const running = (): void => {
    if (!state.running) throw new HeartbeatProviderError("transport");
  };
  return Object.freeze({
    tick: async (request: Parameters<HeartbeatProvider["tick"]>[0]) => {
      running();
      return await tick.call(provider, request);
    },
    ...(typeof precheck === "function"
      ? {
          precheck: async (request: Parameters<NonNullable<HeartbeatProvider["precheck"]>>[0]) => {
            running();
            return await precheck.call(provider, request);
          },
        }
      : {}),
    ...(typeof status === "function"
      ? {
          status: () => {
            if (!state.running) return { ready: false, detail: `plugin ${record.pluginId} is not running` };
            return status.call(provider);
          },
        }
      : {}),
  });
}

/**
 * The host's wrapper around a plugin's onboarding flow: `flow` is taken once,
 * when it is supplied, so a plugin that changes its object later changes
 * nothing; a call is refused unless the plugin runs, and the host falls back
 * to the built-in flow then, as for any throw.
 */
function externalOnboardingProvider(
  record: PluginVersionRecord,
  provider: OnboardingProvider,
  state: { readonly running: boolean },
): OnboardingProvider {
  if (record.manifest.onboarding === undefined)
    throw new Error("provideOnboarding needs an onboarding declaration in the approved manifest");
  if (provider === null || typeof provider !== "object" || typeof provider.flow !== "function")
    throw new Error("provideOnboarding needs a flow function");
  const { flow } = provider;
  return Object.freeze({
    flow: async (request: Parameters<OnboardingProvider["flow"]>[0]) => {
      if (!state.running) throw new Error(`plugin ${record.pluginId} is not running`);
      return await flow.call(provider, request);
    },
  });
}

/**
 * The host's wrapper around a plugin's ideas provider: its methods are taken
 * once, when it is supplied, so a plugin that changes its object later
 * changes nothing; each call is refused unless the plugin runs. The ideas
 * host stops a generation when the plugin does (the lifetime signal it was
 * installed with), and decides and validates what a call carries and returns.
 */
function externalIdeasProvider(record: PluginVersionRecord, provider: IdeasProvider, state: { readonly running: boolean }): IdeasProvider {
  if (record.manifest.ideas === undefined) throw new Error("provideIdeas needs an ideas declaration in the approved manifest");
  if (provider === null || typeof provider !== "object" || typeof provider.generate !== "function")
    throw new Error("provideIdeas needs a generate function");
  const { generate, status } = provider;
  return Object.freeze({
    generate: async (request: Parameters<IdeasProvider["generate"]>[0]) => {
      if (!state.running) throw new IdeasProviderError("transport");
      // The host already aborts the request when this plugin stops (the lifetime signal it was installed with).
      return await generate.call(provider, request);
    },
    ...(typeof status === "function"
      ? {
          status: () => {
            if (!state.running) return { ready: false, detail: `plugin ${record.pluginId} is not running` };
            return status.call(provider);
          },
        }
      : {}),
  });
}

/**
 * The host's wrapper around a plugin's memory provider: the manifest
 * must declare one, and each method it supplies must be a capability the
 * manifest lists (`sync` only for an index of its own). Its methods are taken
 * once, so a plugin that changes its object later changes nothing; each call
 * is refused unless the plugin runs, and a recall or capture stops when the
 * plugin does. What a call carries, and what comes back, is the host's to
 * decide and validate.
 */
function externalMemoryProvider(
  record: PluginVersionRecord,
  provider: MemoryProvider,
  state: { readonly running: boolean; readonly signal: AbortSignal },
): MemoryProvider {
  const declared = record.manifest.memory;
  if (declared === undefined) throw new Error("provideMemory needs a memory declaration in the approved manifest");
  if (provider === null || typeof provider !== "object" || typeof provider.recall !== "function")
    throw new Error("provideMemory needs a recall function");
  const { recall, capture, consolidate, sync, status } = provider;
  for (const [name, method] of [
    ["capture", capture],
    ["consolidate", consolidate],
  ] as const) {
    if (typeof method === "function" && !declared.capabilities.includes(name))
      throw new Error(`provideMemory: ${name} is not a capability the approved manifest lists`);
  }
  if (typeof sync === "function" && declared.index !== "own")
    throw new Error('provideMemory: sync keeps an index of its own, and the approved manifest says index "host"');
  const running = (): void => {
    if (!state.running) throw new MemoryProviderError("transport");
  };
  /** A request whose signal also aborts when the plugin stops. */
  const stopping = <T extends { readonly signal: AbortSignal }>(request: T): T =>
    Object.freeze({ ...request, signal: AbortSignal.any([request.signal, state.signal]) });
  return Object.freeze({
    recall: async (request: Parameters<MemoryProvider["recall"]>[0]) => {
      running();
      return await recall.call(provider, stopping(request));
    },
    ...(typeof capture === "function"
      ? {
          capture: async (request: Parameters<NonNullable<MemoryProvider["capture"]>>[0]) => {
            running();
            return await capture.call(provider, stopping(request));
          },
        }
      : {}),
    ...(typeof consolidate === "function"
      ? {
          consolidate: async (request: Parameters<NonNullable<MemoryProvider["consolidate"]>>[0]) => {
            running();
            return await consolidate.call(provider, stopping(request));
          },
        }
      : {}),
    ...(typeof sync === "function"
      ? {
          sync: async (batch: Parameters<NonNullable<MemoryProvider["sync"]>>[0]) => {
            running();
            // A batch the host gave up on, or one sent as the plugin stops, says so through its signal.
            await sync.call(
              provider,
              Object.freeze({
                ...batch,
                signal: batch.signal === undefined ? state.signal : AbortSignal.any([batch.signal, state.signal]),
              }),
            );
          },
        }
      : {}),
    ...(typeof status === "function"
      ? {
          status: () => {
            if (!state.running) return { ready: false, detail: `plugin ${record.pluginId} is not running` };
            return status.call(provider);
          },
        }
      : {}),
  });
}

/** The host's wrapper around one of a plugin's signal sources: one its manifest declares, by that id, answering only while the plugin runs. */
function externalSignalSource(
  record: PluginVersionRecord,
  source: HeartbeatSignalSource,
  state: { readonly running: boolean; readonly signal: AbortSignal },
): HeartbeatSignalSource {
  if (source === null || typeof source !== "object" || typeof source.collect !== "function")
    throw new Error("provideSignals needs a source with an id and a collect function");
  const declared = record.manifest.heartbeatSignals?.sources.find((id) => id === source.id);
  if (declared === undefined) throw new Error(`provideSignals: the source ${String(source.id)} is not declared in the approved manifest`);
  const { collect } = source;
  // Its first-run offer line is the approved manifest's, never one its code supplies.
  const offer = record.manifest.heartbeatSignals?.offers?.[declared];
  return Object.freeze({
    id: declared,
    // Read once, as supplied: a source whose signals leave by age says so (`retracts: false`).
    ...(source.retracts === false ? { retracts: false as const } : {}),
    ...(offer === undefined ? {} : { offer }),
    collect: async (input: Parameters<HeartbeatSignalSource["collect"]>[0]) => {
      if (!state.running) throw new TaviError("UNAVAILABLE", `plugin ${record.pluginId} is not running`);
      return await collect.call(source, Object.freeze({ ...input, signal: AbortSignal.any([input.signal, state.signal]) }));
    },
  });
}

async function closeLifetime(lifetime: OwnedResourceScope): Promise<void> {
  const outcome = await disposeWithDeadline(lifetime, HOOK_DEADLINE_MS);
  const failures = outcome.failures.map((failure) => failure.error);
  if (outcome.timedOut) failures.push(new Error("plugin cleanup did not finish before its deadline"));
  if (failures.length > 0)
    throw new AggregateError(failures, `plugin cleanup failed: ${failures.map((failure) => errorMessage(failure)).join("; ")}`);
}

/**
 * The household rule for a plugin's account, as the MCP bridge applies it:
 * a Personal one is offered, and answers, only in its operator's own chats, never one whose memory is the chat's only.
 */
export interface ExternalPluginHousehold {
  /** Whether the plugin's account is Personal now: the page's choice, else its `apps` block's data class. Read at every offer. */
  readonly personal: (pluginId: string, dataClass: "public" | "personal" | undefined) => Promise<boolean>;
  readonly operatorOf: (workspaceId: string) => string | undefined;
}

/** Where a plugin tool's `taviFindings` are kept: the task's findings. */
export interface ExternalPluginFindings {
  readonly add: TaskFindingRepositoryPort["add"];
  readonly now: () => string;
}

const PluginResultFindingsSchema = z.array(FindingWriteInputSchema).max(PLUGIN_RESULT_FINDINGS_MAX);

/**
 * A plugin tool's result without its `taviFindings`: each entry is a `findings.add` input, kept with
 * the calling task as that tool keeps one, and left out of what the model reads. An entry that is not one fails the call, so a plugin never thinks
 * it kept what it did not.
 */
async function keepResultFindings(
  id: string,
  result: unknown,
  context: { readonly runId: string; readonly workspaceId: string },
  findings: ExternalPluginFindings | undefined,
): Promise<unknown> {
  if (result === null || typeof result !== "object" || Array.isArray(result) || !Object.hasOwn(result, "taviFindings")) return result;
  const { taviFindings, ...rest } = result as Record<string, unknown>;
  const parsed = PluginResultFindingsSchema.safeParse(taviFindings);
  if (!parsed.success)
    throw new TaviError(
      "TOOL_FAILED",
      `${id} returned taviFindings that are not findings: ${zodIssues(parsed.error).slice(0, 3).join("; ")}`,
    );
  for (const [index, entry] of parsed.data.entries()) {
    if (oversizedFindingIndex(entry.records) !== -1)
      throw new TaviError(
        "TOOL_FAILED",
        `${id} returned a finding in taviFindings[${String(index)}] over ${String(TASK_FINDING_MAX_CHARS)} characters`,
      );
  }
  if (findings !== undefined) {
    for (const entry of parsed.data)
      await findings.add({
        taskId: context.runId,
        workspaceId: context.workspaceId,
        kind: entry.kind,
        records: entry.records,
        sourceUrl: entry.sourceUrl,
        createdAt: findings.now(),
      });
  }
  return rest;
}

function toolRegistration(
  record: PluginVersionRecord,
  tool: Parameters<ExternalPluginContext["registerTool"]>[0],
  /** Its model-facing schema before cleaning (`rawModelSchemaOf`). */
  rawSchema: ToolJsonSchema | undefined,
  state: { readonly running: boolean; readonly signal: AbortSignal },
  household?: ExternalPluginHousehold,
  findings?: ExternalPluginFindings,
  /** Whether a tool is registered now: what the manifest's `requiresTools` are read against at each offer. */
  registered: (toolId: string) => boolean = () => true,
): Parameters<ToolRegistry["registerExternal"]>[0] {
  const declared = record.manifest.tools.find((candidate) => candidate.name === tool.name);
  if (declared === undefined) throw new Error(`tool ${tool.name} is not declared in the approved manifest`);
  if (typeof tool.handler !== "function") throw new Error(`tool ${tool.name} has no handler`);
  const id = `${record.pluginId}.${declared.name}`;
  const minRisk = declared.minRisk;
  // Its `apps` block's data class, from the approved manifest: mail and calendar are personal.
  const dataClass = record.manifest.apps?.apps[0]?.dataClass;
  const personal = async (): Promise<boolean> => (await household?.personal(record.pluginId, dataClass)) === true;
  // Another plugin's tools it needs (the browser's, say): while one is not registered, this one is of no use.
  const missingRequired = (): string | undefined => declared.requiresTools?.find((required) => !registered(required));
  return {
    id,
    version: record.version,
    description: declared.description,
    effect: declared.effect,
    requiredPermissions: ["tools.invoke"],
    inputSchema: tool.inputSchema,
    // The model-facing schema, cleaned: a worker's as it reported it, else the Zod schema's own, converted here.
    ...(rawSchema === undefined ? {} : { inputJsonSchema: cleanSchema(rawSchema) as ToolJsonSchema }),
    // Both from the approved manifest, never the code: a
    // plugin's own assessor could argue a call down, so the only reading is
    // the declared floor over the effect's default, with no subjects — a rule
    // for the tool covers every call of it, as it would with no assessor.
    // Untrusted unless the manifest says `untrustedOutput: false`.
    ...(pluginToolOutputTrust(declared) === "untrusted" ? { untrustedOutput: true } : {}),
    ...(dataClass === "personal" ? { outputConfidentiality: "personal" as const } : {}),
    // What Ideas may offer while it is registered: the manifest's word, never the code's.
    ...(declared.proves === undefined ? {} : { proves: declared.proves }),
    // The manifest's sink; a tool silent on it takes the external default in `registerExternal`.
    ...(declared.sink === undefined ? {} : { sink: declared.sink, ...(declared.sink === "network" ? { urlOnly: false } : {}) }),
    // From the approved manifest only: a floor over the effect's risk, a person deciding every call
    // and input values the card shows. Rows only add: they never change the risk, title or scope.
    ...(minRisk === undefined && declared.attendedOnly !== true && declared.card === undefined
      ? {}
      : {
          assess: (input: unknown): CallAssessment => {
            const rows = cardRows(input, declared.card?.fields ?? [], clipText);
            const effectRisk = declared.effect === "read-only" ? "low" : "medium";
            return {
              display: { title: `Run ${id}`, ...(rows.length === 0 ? {} : { detail: rows.join("\n") }) },
              subjects: [],
              risk: minRisk === undefined ? effectRisk : maxRisk(effectRisk, minRisk),
              reasons: [
                ...(minRisk === undefined ? [] : [`the plugin's approved manifest rates this tool at least ${minRisk} risk`]),
                ...(declared.attendedOnly === true ? ["the plugin's approved manifest has a person decide every call of this tool"] : []),
              ],
              ...(declared.attendedOnly === true ? { attendedOnly: true } : {}),
            };
          },
        }),
    // Fails closed: never offered, and refused if called, unless the plugin started and has not stopped; a Personal
    // account only to its operator, outside a chat whose memory is the chat's only.
    offered: async (context) =>
      state.running &&
      missingRequired() === undefined &&
      (!(await personal()) || (context.operator === true && context.memoryReach !== "chat-only")),
    handler: async ({ input, signal, context, executionPolicy }) => {
      if (!state.running) throw new TaviError("UNAVAILABLE", `plugin ${record.pluginId} is not running`);
      const missing = missingRequired();
      if (missing !== undefined) throw new TaviError("UNAVAILABLE", `${id} needs ${missing}, which is not offered here`);
      if (
        (await personal()) &&
        (household?.operatorOf(context.workspaceId) !== context.principalId || context.memoryReach === "chat-only")
      ) {
        throw new TaviError("NOT_AUTHORIZED", `${id} is a Personal account's: only its owner's own chats may use it`);
      }
      const toolSignal = AbortSignal.any([signal, state.signal]);
      if (typeof tool.beforeCall === "function") {
        const check = await tool.beforeCall(input, { signal: toolSignal });
        if (check && typeof check === "object" && (check.deny === true || check.proceed === false)) {
          throw new TaviError("TOOL_FAILED", check.reason ?? `Execution denied by ${id} pre-call check`);
        }
        // The plugin may have stopped, or the call been cancelled, while the check ran.
        toolSignal.throwIfAborted();
        if (!state.running) throw new TaviError("UNAVAILABLE", `plugin ${record.pluginId} is not running`);
      }
      // Who the call is for, and whether anyone attends it: a run outside a model turn is a person's own.
      const call: PluginToolCallContext = {
        principalId: context.principalId,
        workspaceId: context.workspaceId,
        unattended: executionPolicy?.mode === "unattended",
      };
      return keepResultFindings(id, await tool.handler(input, { signal: toolSignal }, call), context, findings);
    },
  };
}

/** A worker's tools' JSON Schemas, as its worker reported them; the worker validates each call's input itself. */
const workerSchemas = new WeakMap<object, ToolJsonSchema>();

/**
 * A plugin tool's model-facing schema before cleaning: a worker's as its worker reported it; an in-process tool's Zod
 * schema converted as the registry converts it, and kept as the validator. It is offered cleaned (`cleanSchema`: no
 * controls or format characters, forged fences quoted, prose cut at 300 characters) and reviewed raw. None when the
 * registry's own gate refuses the Zod schema (a refinement, a type JSON Schema cannot say), so its refusal names why.
 */
function rawModelSchemaOf(tool: { readonly inputSchema: unknown }): ToolJsonSchema | undefined {
  const reported = workerSchemas.get(tool);
  if (reported !== undefined) return reported;
  const schema = tool.inputSchema;
  if (schema === null || typeof schema !== "object" || typeof (schema as { safeParse?: unknown }).safeParse !== "function")
    return undefined;
  if (findUnrepresentable(schema, "$") !== undefined) return undefined;
  try {
    return z.toJSONSchema(schema as z.ZodType, { io: "input", target: "draft-7", unrepresentable: "throw" }) as ToolJsonSchema;
  } catch {
    return undefined;
  }
}

/**
 * A worker-approved plugin as a module: `register` starts its worker
 * and registers what it registered there through the context, so the owner
 * checks it as it checks an imported plugin's (declared tools and hooks,
 * matches, commands). Its credential settings outside `rawSecrets` are read
 * now and handed to the worker's proxy only; its state, raw secrets, log and
 * status lines are the context's.
 */
function workerModule(
  plugin: Extract<ResolvedExternalPlugin, { ok: true }>,
  isolation: PluginIsolationPort | undefined,
  language: ExternalPluginLanguage | undefined,
  messages: PluginMessages,
): ExternalPluginModule {
  const { record } = plugin;
  let stop: (() => Promise<void>) | undefined;
  // Set once the load gave up on it (its register deadline passed, the owner stopped): a worker that starts after that stops at once.
  let abandoned = false;
  return {
    register: async (context: ExternalPluginContext) => {
      if (isolation === undefined) throw new Error("it is approved to run as a confined worker, and this owner has no worker host");
      const refusal = workerRefusal(record.manifest);
      if (refusal !== undefined) throw new Error(`it is approved to run as a confined worker, but ${refusal}`);
      const raw = new Set(record.manifest.rawSecrets ?? []);
      const maskedSecrets: Record<string, string> = {};
      for (const [key, field] of Object.entries(record.manifest.config)) {
        if (field.type !== "credential" || raw.has(key)) continue;
        const value = await context.secret(key);
        if (value !== null) maskedSecrets[key] = value;
      }
      const handle = await isolation.start(
        {
          pluginId: record.pluginId,
          version: record.version,
          contentHash: record.contentHash,
          directory: plugin.directory,
          entryPath: plugin.entryPath,
          manifest: record.manifest,
          config: plugin.config,
          maskedSecrets,
          home: join(dirname(plugin.directory), "home"),
          locale: context.locale,
          messages,
        },
        {
          loadState: () => context.state.load(),
          putState: (namespace, value) => context.state.put(namespace, value),
          rawSecret: (key) => context.secret(key),
          log: (level, message, meta) => context.log[level === "debug" ? "info" : level](message, meta),
          ui: (kind, envelope, text, key, value) => {
            if (kind === "status") context.ui.status(envelope, text);
            else if (kind === "notice") context.ui.notice(envelope, text ?? "");
            else context.ui.publish(envelope, key ?? "", value);
          },
        },
      );
      // Its `ctx.locale` follows the workspace's language while it runs.
      const unfollow = handle.setLocale === undefined ? undefined : language?.onChange?.((locale) => handle.setLocale?.(locale));
      stop = () => {
        unfollow?.();
        return handle.stop();
      };
      if (abandoned || context.signal.aborted) {
        unfollow?.();
        await handle.stop();
        throw new Error("it was stopped while its worker started");
      }
      for (const tool of handle.registrations.tools) {
        const declared = record.manifest.tools.find((candidate) => candidate.name === tool.name);
        const effect = declared?.effect === "read-only" ? "read" : "write";
        const registration: Parameters<ExternalPluginContext["registerTool"]>[0] = {
          name: tool.name,
          inputSchema: z.record(z.string(), z.unknown()),
          ...(tool.beforeCall
            ? {
                beforeCall: (input: unknown, options: { readonly signal: AbortSignal }) =>
                  handle.beforeCall(tool.name, input, options.signal),
              }
            : {}),
          handler: (input: unknown, options: { readonly signal: AbortSignal }, call?: PluginToolCallContext) =>
            handle.callTool(tool.name, input, options.signal, effect, call),
        };
        workerSchemas.set(registration, tool.inputJsonSchema);
        context.registerTool(registration);
      }
      // Its signal sources, each collected in the worker; the owner checks each against the manifest as an in-process one.
      for (const source of handle.registrations.signalSources) {
        if (context.provideSignals === undefined) throw new Error("it provides heartbeat signal sources, and this owner has no heartbeat");
        context.provideSignals({
          id: source.id,
          ...(source.retracts === false ? { retracts: false as const } : {}),
          collect: async ({ workspaceId, principalId, now, timezone, signal }) =>
            (await handle.collect(source.id, { workspaceId, principalId, now, timezone }, signal)) as Awaited<
              ReturnType<HeartbeatSignalSource["collect"]>
            >,
        });
      }
      handle.registrations.hooks.forEach((hook, index) => {
        // The dispatcher parses every answer by its event's result schema, as it does an imported plugin's.
        const forward: ModHook<ModEvent> = async (input, next) =>
          (await handle.hook(index, input, (given) => next(given as never), next.signal)) as Awaited<ModHookAnswer<ModEvent>>;
        const match = hook.match === undefined ? undefined : hookMatchOf(record.pluginId, hook.event, hook.match);
        if (match === undefined) context.hooks.on(hook.event, forward);
        else context.hooks.on(hook.event, match, forward);
      });
      for (const name of handle.registrations.commands)
        context.commands.register({
          name,
          run: (input) => handle.command(name, { envelope: input.envelope, args: input.args }, input.signal),
        });
    },
    stop: async () => {
      abandoned = true;
      await stop?.();
    },
  };
}

/**
 * The router settings a plugin's provider is handed: none. It takes its
 * settings from its plugin config, whatever the scope's `providerSettings`
 * holds.
 */
const NO_PROVIDER_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * The host's wrapper around a plugin's routing provider. Its identity, price
 * sheet, batching and features are the approved manifest's. It marks the
 * request dispatched before any plugin code runs, since the host cannot see
 * where plugin code sends data; `maxCostUsd` is never taken from plugin code.
 */
function routerProvider(record: PluginVersionRecord, provider: ExternalRouterProvider): RouterProvider {
  const declared = record.manifest.router;
  if (declared === undefined) throw new Error("provideRouter needs a router declaration in the approved manifest");
  if (provider === null || typeof provider !== "object" || typeof provider.classify !== "function")
    throw new Error("provideRouter needs a classify function");
  const { measure, unavailable, status } = provider;
  return {
    pricing: declared.pricing,
    supportsBatch: declared.batch,
    features: declared.features,
    // Never smaller than the host's own measure of what the request carries.
    ...(typeof measure === "function"
      ? {
          measure: (request) =>
            Math.max(
              measure.call(provider, { ...request, settings: NO_PROVIDER_SETTINGS }),
              Buffer.byteLength(JSON.stringify({ prompts: request.prompts, candidates: request.candidates })),
            ),
        }
      : {}),
    ...(typeof unavailable === "function" ? { unavailable: () => unavailable.call(provider, NO_PROVIDER_SETTINGS) } : {}),
    ...(typeof status === "function"
      ? {
          status: async () =>
            RouterStatusSchema.parse(
              await withDeadline(Promise.resolve(status.call(provider, NO_PROVIDER_SETTINGS)), "status", ROUTER_STATUS_DEADLINE_MS),
            ),
        }
      : {}),
    classify: async (request) => {
      await request.checkpoint();
      return provider.classify({ ...request, settings: NO_PROVIDER_SETTINGS });
    },
  };
}
