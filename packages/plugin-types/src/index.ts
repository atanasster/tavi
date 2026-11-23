import type { FetchProviderFactory, ModelProviderFactory, SearchProviderFactory } from "@tavi/contracts/plugin-sdk";
import type { ChannelHostServices, ChannelMailboxKit } from "@tavi/contracts";
import type {
  HeartbeatProvider,
  HeartbeatProviderError,
  HeartbeatSignalSource,
  IdeasProvider,
  IdeasProviderError,
  MemoryProvider,
  OnboardingProvider,
  MemoryProviderError,
  MessagingConnectorDefinition,
  ModCommandInput,
  ModCommandResult,
  ModEnvelope,
  ModEvent,
  ModHook,
  ModHookMatch,
  PluginConfig,
  PluginToolCallContext,
  ResourceScope,
  ROUTER_PROVIDER_FAILURES,
  RouterProvider,
  RouterProviderError,
  TaviError,
} from "@tavi/contracts";
import type { Locale, MessageParams } from "@tavi/contracts/i18n";
import type { z } from "zod";

/**
 * `@tavi/plugin-types`: what a Tavi plugin's
 * module is handed and may export, as types only, so a plugin type-checks
 * without the monorepo. The owner's loader (`apps/cli/src/features/plugins/external.ts`)
 * implements exactly these.
 *
 * ```ts
 * import type { ExternalPluginContext } from "@tavi/plugin-types";
 * export function register({ hooks }: ExternalPluginContext) {
 *   hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => next(e));
 * }
 * ```
 */

export type {
  MemoryCaptureRequest,
  MemoryCaptureResult,
  MemoryDraft,
  MemoryProvider,
  MemoryProviderStatus,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemorySnapshot,
  MemorySyncBatch,
  PluginMemoryDeclaration,
  RankedId,
} from "@tavi/contracts";
export type {
  IdeaBasis,
  IdeaCapability,
  IdeaCategory,
  IdeaDraft,
  IdeaLedger,
  IdeasGenerateRequest,
  IdeasGenerateResult,
  IdeasProvider,
  IdeasProviderStatus,
  IdeasReceive,
  IdeaTaskExcerpt,
  MemoryExcerpt,
  PluginIdeasDeclaration,
  ProposedIdea,
} from "@tavi/contracts";
export type {
  OnboardingFlow,
  OnboardingFlowRequest,
  OnboardingFlowStep,
  OnboardingProvider,
  PluginOnboardingDeclaration,
} from "@tavi/contracts";
/** The group-chat seam a channel plugin implements (channel ABI 2). */
export type {
  AddressKind,
  AuthorKind,
  ChannelEventInput,
  ChannelGroupPolicy,
  ChannelHostServices,
  ChannelPollInput,
  ChannelPollState,
  ChannelRetention,
  ChannelRoomListing,
  EventCapabilities,
  GroupCapabilities,
  PollCapabilities,
  RecentRoomMessage,
} from "@tavi/contracts";
/** How a plugin's apps present in Connected apps: the manifest's `apps` block. */
export type { AppPresentation, AppScope, AppSettingField, PluginAppsBlock, PluginToolCallContext } from "@tavi/contracts";
export type {
  HeartbeatItem,
  HeartbeatItemHookInput,
  HeartbeatTickHookInput,
  HeartbeatProvider,
  HeartbeatSignal,
  HeartbeatSignalSource,
  HeartbeatTickRequest,
  HeartbeatTickResult,
  ModCommandDeclaration,
  ModCommandInput,
  ModCommandResult,
  ModEnvelope,
  ModEvent,
  ModHook,
  ModHookDeclaration,
  ModHookInput,
  ModHookMatch,
  ModHookResult,
  ModsDeclaration,
  PluginConfig,
  PluginManifest,
} from "@tavi/contracts";

/** The languages `ctx.locale` names, and what `ctx.t` fills a message with. */
export type { Locale, MessageParams } from "@tavi/contracts/i18n";
/** A language pack, `locales/<lang>.json`: its manifest overlay and its messages. */
export type { PluginLocaleFile } from "@tavi/contracts";

export interface ExternalPluginLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Scoped durable state for an external plugin.
 *
 * Persisted in the owner's database across restarts. Capped at 16 namespaces
 * and 256 KiB total serialized payload per plugin. Writes are serialized.
 */
export interface ExternalPluginState {
  /** Loads all state namespaces for this plugin. */
  load(): Promise<Record<string, unknown>>;
  /** Stores a JSON-serializable value in the specified namespace. */
  put(namespace: string, value: unknown): Promise<void>;
}

export interface ExternalPluginContext {
  readonly pluginId: string;
  readonly version: string;
  readonly config: Readonly<PluginConfig>;
  /**
   * The workspace's language (`workspace.locale`: `"en"`, `"bg"`), live: read it each time
   * you say something, so a language changed in Settings is followed without a restart.
   * What a person reads may use it; what the model reads (a tool's result) stays as it is.
   */
  readonly locale: Locale;
  /**
   * `key` from this plugin's own `messages` (its `locales/<lang>.json`) in the
   * workspace's language now, else in English (`locales/en.json`), else the key
   * itself. `{name}` in a message is `params.name`; a plural object
   * (`{ "one": …, "other": … }`) is chosen by `params.count`.
   */
  t(key: string, params?: MessageParams): string;
  readonly z: typeof z;
  readonly log: ExternalPluginLog;
  /** Owned from registration onward, including failed registration/startup. */
  readonly scope: ResourceScope;
  readonly signal: AbortSignal;
  /**
   * The secret behind one of this plugin's `credential` settings, resolved through the owner's
   * credential chain when asked (so a rotated value applies without a restart); `null` when none
   * is stored. Any other key is refused: a plugin reads only the credentials it was configured with.
   */
  secret(key: string): Promise<string | null>;
  readonly state: ExternalPluginState;
  registerTool(tool: {
    readonly name: string;
    readonly inputSchema: z.ZodType;
    readonly beforeCall?: (
      input: unknown,
      options: { readonly signal: AbortSignal },
    ) =>
      | Promise<{ readonly proceed?: boolean; readonly deny?: boolean; readonly reason?: string } | void>
      | { readonly proceed?: boolean; readonly deny?: boolean; readonly reason?: string }
      | void;
    /**
     * Its result reaches the model, except an object's `taviFindings`: up to 8 entries of
     * `{ kind, records, sourceUrl? }`, as `findings.add` takes them, which the owner keeps with the
     * calling task and leaves out of what the model reads. An entry that is not one fails the call.
     * `context` says who the call is for and whether anyone attends it: a source whose terms
     * allow only calls a person makes refuses when `context.unattended` is true. The owner passes it on
     * every call; one outside a model turn is a person's own, so `unattended` is `false` there.
     */
    readonly handler: (
      input: unknown,
      options: { readonly signal: AbortSignal },
      context?: PluginToolCallContext,
    ) => Promise<unknown> | unknown;
  }): void;
  registerSearch<Settings>(name: string, factory: SearchProviderFactory<Settings>): void;
  registerFetch<Settings>(name: string, factory: FetchProviderFactory<Settings>): void;
  registerModel<Settings>(name: string, factory: ModelProviderFactory<Settings>): void;
  /**
   * Supply the connector for a messaging channel the manifest declares
   * (`provides: ["channel"]`): its
   * `providerId` names one of the manifest's `channels`, whose descriptor —
   * reviewed with the plugin — is the channel's, never one the code supplies.
   * `mailbox` is its accounts' mail tools (search, read, send), taken only for
   * a descriptor that declares `app.mailbox`; each account's stay off until
   * the operator turns them on.
   */
  registerChannel(definition: MessagingConnectorDefinition, options?: { readonly mailbox?: ChannelMailboxKit<typeof fetch> }): void;
  /**
   * What the host gives a channel connector (channel ABI 2): the clock, the `fetch`
   * it calls its provider with, and an approved artifact of the sending
   * workspace at most `maxBytes` long, which is what a file part sends. The same
   * services a builtin channel gets. Absent for a plugin built for channel ABI 1.
   */
  readonly channelHost?: ChannelHostServices<typeof fetch>;
  /**
   * Hook into the turn (docs/MODS.md): only events the manifest's
   * `mods` block declares, within the declared match; a match left out is the
   * declared one. Registering anything else fails the plugin's load, with the
   * reason `tavi plugins show` gives. In `register` only.
   */
  readonly hooks: ExternalPluginHooks;
  /**
   * A line in a task's status, and a notice on it: addressed by an
   * event's `envelope` the plugin's hooks were handed, so only a task they
   * saw. Shown in `tavi chat` and the canvas, never on a channel; at most 4 a
   * second. `status(envelope)` with no text clears the line.
   */
  readonly ui: ExternalPluginUi;
  /**
   * Add a slash command its manifest declares: `/name args` in `tavi
   * chat`, the canvas and a channel, answered by `run` with `{ text }` shown to
   * the person who typed it, never to the model. In `register` only.
   */
  readonly commands: ExternalPluginCommands;
  /** Supply the routing provider the manifest declares; at most once. Pricing, batching and features come from the manifest. */
  provideRouter(provider: ExternalRouterProvider): void;
  /** Throw one with a reason from `ROUTER_PROVIDER_FAILURES`; any other throw counts as a transport failure. */
  readonly RouterProviderError: typeof RouterProviderError;
  /**
   * Supply the heartbeat provider the manifest declares (`provides:
   * ["heartbeat"]`); at most once. What it
   * receives comes from the manifest and the person's egress switches, never
   * from the code. Present on owners that load heartbeat providers.
   */
  provideHeartbeat?(provider: HeartbeatProvider): void;
  /** Supply one of the heartbeat signal sources the manifest declares (`provides: ["heartbeat-signals"]`), by its declared id. */
  provideSignals?(source: HeartbeatSignalSource): void;
  /** Throw one with `transport`, `invalid` or `budget`; any other throw counts as `transport`. Present with `provideHeartbeat`. */
  readonly HeartbeatProviderError?: typeof HeartbeatProviderError;
  /**
   * Supply the memory provider the manifest declares (`provides: ["memory"]`,
   * docs/MEMORY-PLUGINS.md); at most once. `recall` is required; `capture` and
   * `consolidate` only when the manifest lists them, `sync` only with
   * `index: "own"`. A workspace selects it with `tavi memory set-provider`;
   * what it receives is that workspace's egress switches, never the code's
   * choice. Present on owners that load memory providers.
   */
  provideMemory?(provider: MemoryProvider): void;
  /** Throw one with `transport`, `invalid` or `budget`; any other throw counts as `transport`. Present with `provideMemory`. */
  readonly MemoryProviderError?: typeof MemoryProviderError;
  /**
   * Supply the ideas provider the manifest declares (`provides: ["ideas"]`,
   * docs/IDEAS-PLUGINS.md); at most once. A workspace selects it with `tavi
   * ideas provider <id>`; what it receives is its manifest's `receives` and
   * that workspace's switches, never the code's choice. It proposes ideas and
   * the host validates, stores and shows them. Present on owners that load
   * ideas providers.
   */
  provideIdeas?(provider: IdeasProvider): void;
  /** Throw one with `transport`, `invalid` or `budget`; any other throw counts as `transport`. Present with `provideIdeas`. */
  readonly IdeasProviderError?: typeof IdeasProviderError;
  /**
   * Supply the onboarding flow the manifest declares (`provides:
   * ["onboarding"]`, docs/ONBOARDING-PLUGINS.md); at most once. The person
   * selects it with `tavi onboard provider <id>`. It answers the steps and
   * their words from the status, the census and the ids available; the host
   * validates the flow, falls back to the built-in when it throws, and makes
   * every change itself. Present on owners that load onboarding flows.
   */
  provideOnboarding?(provider: OnboardingProvider): void;
  /**
   * Tavi's own error, for a code the host acts on: a channel's send refused
   * before it went out (`UNAVAILABLE`, `INVALID_INPUT`), a webhook that is not
   * the provider's shape (`INVALID_INPUT`). Any other throw is treated as one
   * that may have happened part way.
   */
  readonly TaviError: typeof TaviError;
  readonly ROUTER_PROVIDER_FAILURES: typeof ROUTER_PROVIDER_FAILURES;
}

export interface ExternalPluginCommands {
  register(command: {
    readonly name: string;
    readonly run: (input: ModCommandInput) => ModCommandResult | Promise<ModCommandResult>;
  }): void;
}

export interface ExternalPluginUi {
  status(envelope: ModEnvelope, text?: string): void;
  notice(envelope: ModEnvelope, text: string): void;
  /** A value for the plugin's own canvas contribution, on its `mod.state` channel, for the chat the envelope names. JSON, at most 16 KiB. */
  publish(envelope: ModEnvelope, key: string, value: unknown): void;
}

export interface ExternalPluginHooks {
  on<E extends ModEvent>(event: E, hook: ModHook<E>): void;
  on<E extends ModEvent>(event: E, match: ModHookMatch, hook: ModHook<E>): void;
}

/** What a plugin supplies; the host adds the manifest's pricing, batching and features. */
export type ExternalRouterProvider = Pick<RouterProvider, "classify" | "measure" | "unavailable" | "status">;

export interface ExternalPluginModule {
  register?(context: ExternalPluginContext): void | Promise<void>;
  start?(
    context: Omit<
      ExternalPluginContext,
      | "registerTool"
      | "provideRouter"
      | "provideHeartbeat"
      | "provideSignals"
      | "provideMemory"
      | "provideIdeas"
      | "provideOnboarding"
      | "registerSearch"
      | "registerFetch"
      | "registerModel"
      | "registerChannel"
      | "hooks"
      | "commands"
    > & { readonly signal: AbortSignal },
  ): void | Promise<void>;
  stop?(): void | Promise<void>;
}
