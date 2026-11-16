import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MEMORY_PROVIDER_LIMITS,
  MEMORY_RRF_K,
  MEMORY_SEARCH_DEFAULT,
  MEMORY_SEARCH_MAX,
  MemoryProviderError,
  MemoryRecallResultSchema,
  TaviError,
  createServiceToken,
  memoryProviderEgressOf,
  memoryProviderFailure,
  memoryScopeKey,
  type EffectiveMemorySettings,
  type MemoryActor,
  type MemoryProvider,
  type MemoryProviderEgress,
  type MemoryProviderFailure,
  type MemoryProviderStatus,
  type MemoryRecallRequest,
  type MemoryScope,
  type MemorySearchHit,
  type MemorySearchResult,
  type MemoryServicePort,
  type MemorySnapshot,
  type PluginMemoryDeclaration,
  type PluginRepositoryPort,
  type RankedId,
} from "@tavi/contracts";
import { clip, errorMessage, isRecord } from "@tavi/contracts/util";

/**
 * The host's memory providers.
 *
 * **The registry is composition's**, not the disable-able `tavi.memory`
 * host's: turning that plugin off stops background work and the
 * commands, never recall. The built-in `tavi.memoryprovider` is installed
 * under `BUILTIN_MEMORY_PROVIDER_ID` as the heartbeat's built-in is; an
 * approved plugin's provider is installed under its plugin id while the
 * plugin runs (`context.provideMemory`). Each workspace selects one
 * (`tavi memory set-provider`); one that is not installed now (not approved,
 * disabled, not started) falls back to the built-in, said once.
 *
 * **Recall through a provider.** A search that names a `purpose` (a turn's
 * context, the `memory.search` tool, a heartbeat check) asks the workspace's
 * provider to rank, under the recall deadline (1.5 s on a turn, 5 s
 * otherwise). The provider answers ids; the host keeps only those its own
 * search found eligible for this actor, at the revision it found, or that
 * the service's `eligible` finds so by id, and renders them from the host's
 * rows (filter before rank, invariant 4). A provider that throws, times out
 * or answers out of contract is a failure: the host's own search answers
 * instead, `partial`, saying so. A turn's step asks the provider once
 * (`recallKey`), however often its context searches. An operator's search
 * names no purpose and goes to the service directly.
 *
 * **Egress (invariant 26).** An external provider is asked to recall
 * only with the workspace's `conversation` switch on (every query is the
 * person's words), and never for the heartbeat; otherwise the built-in
 * serves. It is given `candidates` only with `records` on, and `personal`
 * records (and an agent's with no workspace, `spansWorkspaces`) only with
 * `includePersonal` too. What it was not given is still
 * recalled (invariant 26): the host's own search over what was withheld (the
 * personal records; everything, with `records` off) is fused with the
 * provider's ranks (RRF, k = 60). A provider that fails is answered for by
 * the host's own search of the caller's query, at the caller's limit, never
 * by one it asked through `host.lexical`.
 */

/** The service `tavi.memoryprovider` provides: the host's registry, with the built-in installed. */
export const MemoryProvidersService = createServiceToken<MemoryProviderRegistry>("tavi.memoryproviders");

/** A provider the registry holds, with what it declares. */
export interface InstalledMemoryProvider {
  readonly id: string;
  readonly kind: "builtin" | "plugin";
  readonly provider: MemoryProvider;
  readonly declaration: PluginMemoryDeclaration;
}

/** A workspace's provider as the host uses it now. */
export interface MemoryProviderChoice {
  /** The provider the workspace selected (its `memory.provider`). */
  readonly chosen: string;
  /** The one that serves: the selected one when installed, else the built-in. Undefined only before the built-in starts. */
  readonly provider: InstalledMemoryProvider | undefined;
  /** What the selected provider may receive: its switches as its declaration allows them (meaningful for an external one only). */
  readonly egress: MemoryProviderEgress;
  /** Why the selected provider does not serve now, as the operator is told; absent when it does. */
  readonly fallback?: string;
}

export interface MemoryProviderRegistryOptions {
  /** The workspace's memory settings: which provider it selected and its egress. Absent: every workspace's is the built-in. */
  readonly settingsOf?: (workspaceId: string) => Promise<Pick<EffectiveMemorySettings, "provider" | "providerEgress">>;
  /**
   * The operator is told once that a workspace's selected provider is not
   * available and the built-in serves, with what to do about it;
   * told again only after it served once more, or the selection changed.
   */
  readonly onFallback?: (workspaceId: string, notice: string) => void;
}

/** What the operator is told when a workspace's selected memory provider is not available. */
function memoryProviderFallbackNotice(chosen: string): string {
  return `Memory provider ${chosen} is not available (not approved, disabled or not running), so the built-in serves this workspace's memory. Use built-in: tavi memory set-provider builtin. Pick another: tavi memory set-provider <id>.`;
}

/**
 * What `tavi reset`, `tavi memory export` and doctor say of a provider other
 * than the built-in: an index it keeps of its own is outside
 * Tavi's tables, so neither a reset nor a backup reaches it.
 */
export function externalMemoryIndexNote(providers: readonly string[]): string {
  const one = providers.length === 1;
  return `memory provider${one ? "" : "s"} ${providers.join(", ")} ${one ? "keeps" : "keep"} any index of ${one ? "its" : "their"} own outside Tavi's tables: clearing it is ${one ? "the plugin's" : "each plugin's"}`;
}

/** The longest `status().detail` doctor shows: the provider's own words, on one line. */
export const MEMORY_PROVIDER_STATUS_DETAIL_MAX = 200;

/**
 * A provider's `status()` as doctor shows it, guarded and
 * bounded: a throw, a promise or a malformed answer is "not ready" with why,
 * `indexed` only when it is a count, and `detail` one line of at most
 * `MEMORY_PROVIDER_STATUS_DETAIL_MAX` characters. Undefined when the
 * provider reports no status.
 */
export function readMemoryProviderStatus(provider: MemoryProvider): MemoryProviderStatus | undefined {
  if (typeof provider.status !== "function") return undefined;
  // A plugin's answer may be a Proxy or carry throwing getters: every read of it is guarded, so doctor always answers.
  try {
    const answer: unknown = provider.status();
    if (typeof answer === "object" && answer !== null && typeof (answer as { then?: unknown }).then === "function") {
      // `status()` is synchronous by contract: a promise is not waited on, and its failure is not left unhandled.
      void Promise.resolve(answer).catch(() => undefined);
      return { ready: false, detail: "its status is not synchronous" };
    }
    if (typeof answer !== "object" || answer === null) return { ready: false, detail: "its status is not a status" };
    const { ready, indexed, detail } = answer as { readonly ready?: unknown; readonly indexed?: unknown; readonly detail?: unknown };
    const line = typeof detail === "string" ? detail.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
    return {
      ready: ready === true,
      ...(typeof indexed === "number" && Number.isSafeInteger(indexed) && indexed >= 0 ? { indexed } : {}),
      ...(line === "" ? {} : { detail: clip(line, MEMORY_PROVIDER_STATUS_DETAIL_MAX) }),
    };
  } catch {
    return { ready: false, detail: "its status could not be read" };
  }
}

export function effectiveMemoryProviderEgress(
  egress: MemoryProviderEgress,
  installed: InstalledMemoryProvider | undefined,
): MemoryProviderEgress {
  if (installed?.kind !== "plugin") return egress;
  return egressAsDeclared(egress, installed.declaration);
}

/** A workspace's switches as a declaration allows them: what `effectiveMemoryProviderEgress` applies, for a provider read from its approved record while it does not run. */
export function egressAsDeclared(
  egress: MemoryProviderEgress,
  declaration: Pick<PluginMemoryDeclaration, "receives">,
): MemoryProviderEgress {
  const records = egress.records && declaration.receives.includes("records");
  return {
    records,
    conversation: egress.conversation && declaration.receives.includes("conversation"),
    includePersonal: records && egress.includePersonal,
  };
}

/**
 * Whether a scope is read in every workspace of its person: `personal`, and
 * an agent's scope with no workspace (it spans workspaces). Either
 * reaches an external provider only with `includePersonal`, in sync,
 * candidates, `scopeKeys` and consolidation alike.
 */
export function spansWorkspaces(scope: MemoryScope): boolean {
  return scope.kind === "personal" || (scope.kind === "personal_agent" && scope.workspaceId === undefined);
}

/**
 * The memory provider an approved plugin declares, read from its
 * record: the active version's, else the newest approved one's. What a
 * provider that does not run now is known by (whether it keeps an index of
 * its own, what it receives); undefined when no approved version declares one.
 */
export async function approvedMemoryDeclaration(
  plugins: Pick<PluginRepositoryPort, "getSetting" | "getVersion" | "listVersions">,
  pluginId: string,
): Promise<PluginMemoryDeclaration | undefined> {
  const active = (await plugins.getSetting(pluginId))?.activeVersion;
  const running = active === undefined ? undefined : await plugins.getVersion(pluginId, active);
  if (running?.reviewState === "approved" && running.manifest.memory !== undefined) return running.manifest.memory;
  const approved = (await plugins.listVersions(pluginId)).versions.filter(
    (version) => version.reviewState === "approved" && version.manifest.memory !== undefined,
  );
  // The newest approved: the one most recently reviewed, then installed.
  const newest = approved.sort((left, right) =>
    (right.reviewedAt ?? right.installedAt) < (left.reviewedAt ?? left.installedAt) ? -1 : 1,
  )[0];
  return newest?.manifest.memory;
}

export class MemoryProviderRegistry {
  readonly #providers = new Map<string, InstalledMemoryProvider>();
  readonly #options: MemoryProviderRegistryOptions;
  /** Each workspace's selected provider it fell back from, while it does: told once. */
  readonly #fallbacks = new Map<string, string>();
  readonly #installed = new Set<(installed: InstalledMemoryProvider) => void>();

  constructor(options: MemoryProviderRegistryOptions = {}) {
    this.#options = options;
  }

  /** Install a provider under `id`; answers its removal. A second install under one id is refused. */
  install(id: string, entry: Omit<InstalledMemoryProvider, "id">): () => void {
    if (this.#providers.has(id)) throw new Error(`memory provider ${id} is already installed`);
    const installed: InstalledMemoryProvider = Object.freeze({ id, ...entry });
    this.#providers.set(id, installed);
    // A provider that starts takes what it missed: pending removals, and its index again.
    for (const listener of this.#installed) {
      try {
        listener(installed);
      } catch {
        // A listener's own failure is its to report.
      }
    }
    return () => {
      if (this.#providers.get(id) === installed) this.#providers.delete(id);
    };
  }

  /** Be told each provider installed from now on; answers how to stop. */
  onInstalled(listener: (installed: InstalledMemoryProvider) => void): () => void {
    this.#installed.add(listener);
    return () => this.#installed.delete(listener);
  }

  get(id: string): InstalledMemoryProvider | undefined {
    return this.#providers.get(id);
  }

  list(): readonly InstalledMemoryProvider[] {
    return [...this.#providers.values()];
  }

  /**
   * A workspace's provider now: the one it selected when installed,
   * else the built-in, with the fallback said once. Read per call, so a
   * change applies from the next recall.
   */
  async choice(workspaceId: string): Promise<MemoryProviderChoice> {
    const settings = this.#options.settingsOf === undefined ? undefined : await this.#options.settingsOf(workspaceId);
    const chosen = settings?.provider ?? BUILTIN_MEMORY_PROVIDER_ID;
    const egress = settings?.providerEgress ?? memoryProviderEgressOf(undefined);
    const builtin = this.#providers.get(BUILTIN_MEMORY_PROVIDER_ID);
    const selected = this.#providers.get(chosen);
    if (selected !== undefined || chosen === BUILTIN_MEMORY_PROVIDER_ID) {
      this.#fallbacks.delete(workspaceId);
      return { chosen, provider: selected ?? builtin, egress: effectiveMemoryProviderEgress(egress, selected) };
    }
    const fallback = memoryProviderFallbackNotice(chosen);
    if (this.#fallbacks.get(workspaceId) !== chosen) {
      this.#fallbacks.set(workspaceId, chosen);
      this.#options.onFallback?.(workspaceId, fallback);
    }
    return { chosen, provider: builtin, egress, fallback };
  }

  /** The provider that serves a workspace's recall and capture now (`choice`'s). */
  async selected(workspaceId: string): Promise<InstalledMemoryProvider | undefined> {
    return (await this.choice(workspaceId)).provider;
  }
}

/**
 * The provider that drafts a workspace's idle review (invariant 26): an external one only with the `conversation` switch on (a
 * span is the person's words), else the built-in; told only the titles its
 * `records` and `includePersonal` switches let it receive (`knows`).
 */
export async function captureProviderOf(
  providers: Pick<MemoryProviderRegistry, "choice" | "get">,
  workspaceId: string,
): Promise<
  | { readonly id: string; readonly provider: MemoryProvider; readonly knows?: { readonly personal: boolean; readonly chat: boolean } }
  | undefined
> {
  const choice = await providers.choice(workspaceId);
  if (choice.provider?.kind !== "plugin") return choice.provider;
  if (!choice.egress.conversation) return providers.get(BUILTIN_MEMORY_PROVIDER_ID);
  return {
    id: choice.provider.id,
    provider: choice.provider.provider,
    knows: { chat: choice.egress.records, personal: choice.egress.includePersonal },
  };
}

/**
 * `captureProviderOf`, for one chat: never an external provider for a chat on a local connection (invariant 27;
 * `chatIsLocal` answers true when it cannot tell), whose span the built-in drafts instead.
 */
export async function chatCaptureProviderOf(
  providers: Pick<MemoryProviderRegistry, "choice" | "get">,
  workspaceId: string,
  chatIsLocal: () => Promise<boolean>,
): ReturnType<typeof captureProviderOf> {
  const chosen = await captureProviderOf(providers, workspaceId);
  if (chosen?.knows === undefined) return chosen;
  return (await chatIsLocal().catch(() => true)) ? providers.get(BUILTIN_MEMORY_PROVIDER_ID) : chosen;
}

/**
 * The scope keys an actor reads (`scopeKeys`), opaque to a provider: an
 * own index pre-filters by them, and the host re-checks every id anyway.
 * They are the service's grants, as the keys a snapshot carries
 * (`MemorySnapshot.scopeKey`): the run's own scope; a delegated task's
 * chat's notes (`chatTaskId`) and a side chat's parent's (`parentChatId`),
 * which the service grants as `CHAT_NOTES_KEY_PREFIX` keys over those chats'
 * run scopes and are given here as those scopes' own keys (only their
 * durable records render: the host re-checks); the person's scopes; and the
 * shared scope only with the reader grant (`shared`), as the service checks
 * it. `personal`, and an agent's scope with no workspace, are left out when
 * the provider is not given personal records (`spansWorkspaces`).
 */
export function readableScopeKeys(
  actor: MemoryActor,
  options: { readonly personal: boolean; readonly shared?: boolean },
): readonly string[] {
  const keys: string[] = [];
  const runScope = (runId: string): string =>
    memoryScopeKey({ kind: "run_local", principalId: actor.principalId, workspaceId: actor.workspaceId, runId });
  if (actor.runId !== undefined) keys.push(runScope(actor.runId));
  for (const chat of [actor.chatTaskId, actor.parentChatId]) {
    if (chat !== undefined && chat !== "" && !keys.includes(runScope(chat))) keys.push(runScope(chat));
  }
  const chatOnly = actor.reach === "chat-only";
  if (!chatOnly && actor.scopeRestricted !== true) {
    if (options.personal) keys.push(memoryScopeKey({ kind: "personal", principalId: actor.principalId }));
    keys.push(memoryScopeKey({ kind: "personal_workspace", principalId: actor.principalId, workspaceId: actor.workspaceId }));
    if (actor.agentId !== undefined) {
      // An agent's scope with no workspace spans them, as `personal` does (`spansWorkspaces`).
      if (options.personal) keys.push(memoryScopeKey({ kind: "personal_agent", principalId: actor.principalId, agentId: actor.agentId }));
      keys.push(
        memoryScopeKey({ kind: "personal_agent", principalId: actor.principalId, agentId: actor.agentId, workspaceId: actor.workspaceId }),
      );
    }
  }
  // Membership alone does not make the shared scope readable: the reader grant does.
  if (!chatOnly && options.shared === true) keys.push(memoryScopeKey({ kind: "shared_workspace", workspaceId: actor.workspaceId }));
  return Object.freeze(keys);
}

/** Reciprocal-rank fusion (k = 60, as hybrid recall's) of ranked hit lists: each list's order is its rank. */
function fuseRanked(lists: readonly (readonly MemorySearchHit[])[], limit: number): MemorySearchHit[] {
  const scored = new Map<string, { hit: MemorySearchHit; score: number; first: number }>();
  let order = 0;
  for (const list of lists) {
    list.forEach((hit, index) => {
      const key = `${hit.recordId}:${hit.revisionId}`;
      const entry = scored.get(key);
      const add = 1 / (MEMORY_RRF_K + index + 1);
      if (entry === undefined) scored.set(key, { hit, score: add, first: order++ });
      else entry.score += add;
    });
  }
  return [...scored.values()]
    .sort((left, right) => right.score - left.score || left.first - right.first)
    .slice(0, limit)
    .map((entry) => entry.hit);
}

type SearchInput = Parameters<MemoryServicePort["search"]>[0];
type Search = (input: SearchInput) => Promise<MemorySearchResult>;
type Eligible = (input: Parameters<MemoryServicePort["eligible"]>[0]) => Promise<readonly MemorySearchHit[]>;

/** What recall asks of the memory service: its search, and its by-id eligibility check. */
export interface MemoryRecallHost {
  readonly search: Search;
  readonly eligible: Eligible;
}

export interface MemoryProviderRecallOptions {
  /** A provider's failure, logged once a recall, never its text. */
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
  /** Recall deadlines, for tests: `MEMORY_PROVIDER_LIMITS` otherwise. */
  readonly deadlineMs?: { readonly turn: number; readonly other: number };
  /**
   * The approved, normal-sensitivity records an actor reads, as snapshots
   * (`personal` ones only when asked): an `index: "host"` provider's
   * `candidates`, sent only with `records` egress. Absent: none are sent.
   */
  readonly snapshots?: (
    actor: MemoryActor,
    options: { readonly personal: boolean; readonly limit: number },
  ) => Promise<readonly MemorySnapshot[]>;
  /**
   * Whether a task is a heartbeat check's: its turn's own searches (the
   * `memory.search` tool) are the heartbeat's recall, and never leave the
   * built-in (invariant 26). Absent: only `purpose: "heartbeat"` is.
   */
  readonly heartbeatTask?: (taskId: string) => Promise<boolean>;
  /**
   * Whether the reader's chat used, or runs on, a local connection: its
   * query then never leaves the built-in, as the heartbeat's does not. Absent: none does.
   */
  readonly localChat?: (actor: MemoryActor) => Promise<boolean>;
  /**
   * Whether an actor holds the shared scope's reader grant, as the memory
   * service checks it: only then is that scope's key among a recall's
   * `scopeKeys`. Absent: none does (the owner's service has no such grant).
   */
  readonly sharedRead?: (actor: MemoryActor) => boolean;
}

type Providers = Pick<MemoryProviderRegistry, "choice" | "get">;

/** How many turn steps' provider answers recall keeps for their later searches (`recallKey`). */
const RECALLS_KEPT = 64;

/** What one provider recall came to: its ranked ids, or why it failed. */
type RecallOutcome = { readonly ranked: readonly RankedId[] } | { readonly failure: MemoryProviderFailure };

/** A hit count as the memory service bounds it: a whole number from 1 to `MEMORY_SEARCH_MAX`, else 1. */
function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? Math.min(value, MEMORY_SEARCH_MAX) : 1;
}

/** `value` as JSON with every object's keys sorted: two searches asking the same compare equal, whatever order they were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    isRecord(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : entry,
  );
}

/** `work`, or a rejection once `signal` aborts. */
async function before<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // A late provider's answer, or its failure, is dropped: it must not surface as an unhandled rejection.
  work.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("the memory provider's recall ran past its deadline"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** The host's own answer, said to be one: a provider that failed leaves recall `partial`, never silently the same. */
function failedOver(own: MemorySearchResult, providerId: string, failure: MemoryProviderFailure): MemorySearchResult {
  if (own.coverage === "unavailable") return own;
  const said = `memory provider ${providerId} failed (${failure}); the host's own search answered`;
  return {
    ...own,
    coverage: "partial",
    reducedReason: (own.reducedReason === undefined ? said : `${said}; ${own.reducedReason}`).slice(0, 300),
  };
}

/**
 * Wrap a memory service's `search` so that recall (a search naming a
 * `purpose`) goes through the workspace's provider. `host.search` is the
 * service's own, hybrid-wrapped: it is the host's index the
 * built-in ranks with (`host.lexical`), what every provider's ids are
 * checked against, and what answers when a provider fails. An id the
 * provider ranks that none of those searches carried (an own index's, a
 * vector's) is checked by `host.eligible`, which applies the same
 * filters. Searches naming one `recallKey` (a turn's step) ask the provider
 * once, and re-check its ids against a fresh search each time.
 */
export function recallThroughProviders(host: MemoryRecallHost, providers: Providers, options: MemoryProviderRecallOptions = {}): Search {
  const { search, eligible } = host;
  /** A turn step's provider answer, and what it was asked: a later search asking anything else asks again. */
  const recalls = new Map<string, { readonly asked: string; readonly outcome: Promise<RecallOutcome> }>();
  /** Whether the actor's turn is a heartbeat check's, by its chat's task or its run (as hybrid recall asks). */
  const inHeartbeatTask = async (actor: MemoryActor): Promise<boolean> => {
    if (options.heartbeatTask === undefined || actor.runId === undefined) return false;
    if (actor.chatTaskId !== undefined && (await options.heartbeatTask(actor.chatTaskId))) return true;
    return await options.heartbeatTask(actor.runId);
  };
  return async (input) => {
    const { purpose, recallKey, ...rest } = input;
    // A turn with no keyword recalls by meaning alone: the host's own vectors, never a provider asked to rank no words.
    if (purpose === undefined || rest.view !== undefined || rest.query.trim() === "") return await search(rest);
    // The heartbeat's recall never leaves the built-in: its query is other people's words.
    // A heartbeat check's turn searching through its tools is the heartbeat's recall too.
    // A local chat's query stays on the built-in too: a provider may send it anywhere.
    const heartbeat =
      purpose === "heartbeat" || (await inHeartbeatTask(rest.actor)) || (await options.localChat?.(rest.actor).catch(() => true)) === true;
    const choice = heartbeat ? undefined : await providers.choice(rest.actor.workspaceId);
    const asking = choice === undefined ? providers.get(BUILTIN_MEMORY_PROVIDER_ID) : choice.provider;
    // Every recall query is conversation (invariant 26): an external provider is asked only with that switch on.
    const installed =
      asking?.kind === "plugin" && choice?.egress.conversation !== true ? providers.get(BUILTIN_MEMORY_PROVIDER_ID) : asking;
    if (installed === undefined) return await search(rest);
    const external = installed.kind === "plugin";
    const egress = choice?.egress ?? memoryProviderEgressOf(undefined);
    // Personal memory reaches an external provider only with `records` and `includePersonal`; otherwise the host ranks it.
    const withholdsPersonal = external && !(egress.records && egress.includePersonal);
    // With `records` off an external provider is given no record at all (no candidates, no index): every one is withheld.
    const withholdsAll = external && !egress.records;
    const limit = boundedLimit(rest.limit ?? MEMORY_SEARCH_DEFAULT);
    /** The host's own searches of the caller's query at the caller's limit or more (the provider's own, or one made to check its ids). */
    const callerAsked: Promise<MemorySearchResult>[] = [];
    /** The host's own answer to the caller's search: one the provider asked the same of, cut to the limit, else a fresh one. */
    const ownAnswer = async (): Promise<MemorySearchResult> => {
      const settled = callerAsked.length === 0 ? undefined : (await Promise.allSettled(callerAsked)).at(-1);
      if (settled?.status === "fulfilled") return { ...settled.value, hits: settled.value.hits.slice(0, limit) };
      // A search the host refused (a blank query, one too long) is then the caller's error, as it is without a provider.
      return await search(rest);
    };
    /** Withheld records are still recalled (invariant 26): the host's own search over them, fused with the provider's ranks. */
    const withWithheld = async (result: MemorySearchResult): Promise<MemorySearchResult> => {
      if (withholdsAll) {
        // Recall must not hang on the provider asking the host: the host's own answer to the caller is fused in whole.
        const own = await ownAnswer().catch(() => undefined);
        return own === undefined || own.hits.length === 0 ? result : { ...result, hits: fuseRanked([result.hits, own.hits], limit) };
      }
      // A search narrowed to another scope asked for none of them.
      if (!withholdsPersonal || (rest.scope !== undefined && !spansWorkspaces(rest.scope))) return result;
      // The person's own scope, and an agent's with no workspace: both span workspaces (`spansWorkspaces`).
      const { principalId, agentId } = rest.actor;
      const scopes: readonly MemoryScope[] =
        rest.scope !== undefined
          ? [rest.scope]
          : [
              { kind: "personal", principalId },
              ...(agentId === undefined ? [] : [{ kind: "personal_agent" as const, principalId, agentId }]),
            ];
      const withheld: (readonly MemorySearchHit[])[] = [];
      for (const scope of scopes) {
        try {
          const hits = (await search({ ...rest, scope })).hits;
          if (hits.length > 0) withheld.push(hits);
        } catch {
          // An actor that reads no personal memory (a chat-only turn) has none withheld.
        }
      }
      return withheld.length === 0 ? result : { ...result, hits: fuseRanked([result.hits, ...withheld], limit) };
    };

    /** The provider's ranked ids, filtered before they render (invariant 4) and rendered from the host's own rows. */
    const render = async (ranked: readonly RankedId[], answers: Promise<MemorySearchResult>[]): Promise<MemorySearchResult> => {
      // The provider ranked without asking the host: its ids are checked against the host's own search.
      if (answers.length === 0) {
        const fresh = search(rest);
        answers.push(fresh);
        callerAsked.push(fresh);
      }
      const own = await Promise.all(answers);
      const rows = new Map<string, MemorySearchHit>();
      const rowsByRevision = new Map<string, MemorySearchHit>();
      for (const answer of own) {
        for (const hit of answer.hits) {
          if (!rows.has(hit.recordId)) rows.set(hit.recordId, hit);
          if (!rowsByRevision.has(`${hit.recordId}:${hit.revisionId}`)) {
            rowsByRevision.set(`${hit.recordId}:${hit.revisionId}`, hit);
          }
        }
      }
      // Never empty: with no answer of the caller's, one was searched above.
      const last = own.at(-1);
      if (last === undefined) throw new TaviError("INTERNAL", "a provider's ranking was rendered with no search of the host's");
      let result: MemorySearchResult = last;
      // Ids none of those searches carried (an own index's, a vector's): checked by id, with the same filters.
      const unchecked = [...new Set(ranked.map((hit) => hit.recordId).filter((recordId) => !rows.has(recordId)))].slice(
        0,
        MEMORY_SEARCH_MAX,
      );
      if (unchecked.length > 0) {
        try {
          const checked = await eligible({
            actor: rest.actor,
            recordIds: unchecked,
            ...(rest.scope === undefined ? {} : { scope: rest.scope }),
            ...(rest.includeSensitive === undefined ? {} : { includeSensitive: rest.includeSensitive }),
          });
          // Only what was asked: a check answering another id renders nothing of it.
          for (const hit of checked) {
            if (unchecked.includes(hit.recordId) && !rows.has(hit.recordId)) {
              rows.set(hit.recordId, hit);
              rowsByRevision.set(`${hit.recordId}:${hit.revisionId}`, hit);
            }
          }
        } catch (error) {
          options.log?.("memory provider ids could not be checked; only those the host's search found render", {
            providerId: installed.id,
            purpose,
            error: errorMessage(error, "unknown").slice(0, 200),
          });
          if (last.coverage !== "unavailable")
            result = {
              ...last,
              coverage: "partial",
              reducedReason: "some of the memory provider's records could not be checked, so they were left out",
            };
        }
      }
      const rendered: MemorySearchHit[] = [];
      const seen = new Set<string>();
      for (const hit of ranked) {
        if (rendered.length >= limit) break;
        const row = rest.includePast === true ? rowsByRevision.get(`${hit.recordId}:${hit.revisionId}`) : rows.get(hit.recordId);
        const dedupKey = rest.includePast === true ? `${hit.recordId}:${hit.revisionId}` : hit.recordId;
        // Filter before rank (invariant 4): an id the host did not find eligible, or at another revision, never renders.
        if (row === undefined || row.revisionId !== hit.revisionId || seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        rendered.push(row);
      }
      return await withWithheld({ ...result, hits: rendered });
    };

    // A later search of the same turn step asking the same: the
    // provider's answer is reused, and re-checked against a fresh search, so a record forgotten since
    // never renders.
    const asked = canonical([installed.id, purpose, rest]);
    const kept = recallKey === undefined ? undefined : recalls.get(recallKey);
    if (kept !== undefined && kept.asked === asked) {
      const outcome = await kept.outcome;
      return "ranked" in outcome ? await render(outcome.ranked, []) : failedOver(await search(rest), installed.id, outcome.failure);
    }

    const deadline = AbortSignal.timeout(
      purpose === "turn"
        ? (options.deadlineMs?.turn ?? MEMORY_PROVIDER_LIMITS.recallTurnMs)
        : (options.deadlineMs?.other ?? MEMORY_PROVIDER_LIMITS.recallOtherMs),
    );
    /** The host's own answers, in the order they were asked: what the provider's ids are checked against and rendered from. */
    const answers: Promise<MemorySearchResult>[] = [];
    /** Host answers the provider asked for that have not settled yet. */
    let pending = 0;
    /** Whether the provider's recall has answered, failed or run past its deadline. */
    let closed = false;
    // Never a cut in practice: the service refuses a query past 512 characters, and the turn and tool bound theirs to it.
    const query = rest.query.slice(0, MEMORY_PROVIDER_LIMITS.queryChars);
    const lexical = async (text: string, max: number): Promise<readonly RankedId[]> => {
      // A late or finished provider's search is nobody's to read: it would cost a host search (and an embedding) for nothing.
      if (closed || deadline.aborted) throw new MemoryProviderError("budget");
      // Each is a host search, and under hybrid recall an embedding: a recall makes a few, no more.
      if (answers.length >= MEMORY_PROVIDER_LIMITS.lexicalCalls) throw new MemoryProviderError("budget");
      // The query it was given is searched as the caller asked it, whole.
      const answer = search({ ...rest, query: text === query ? rest.query : String(text), limit: boundedLimit(max) });
      answers.push(answer);
      // Only a search of the caller's own query, as deep as the caller asked, may answer for the caller.
      if (text === query && boundedLimit(max) >= limit) callerAsked.push(answer);
      pending += 1;
      const done = () => {
        pending -= 1;
      };
      void answer.then(done, done);
      const { hits: found } = await answer;
      // A provider not given personal records is not told their ids either: the host ranks those itself.
      const hits = withholdsPersonal ? found.filter((hit) => !spansWorkspaces(hit.scope)) : found;
      // A rank, not a relevance: the service answers its hits best first.
      return Object.freeze(
        hits.map((hit, index) => Object.freeze({ recordId: hit.recordId, revisionId: hit.revisionId, score: hits.length - index })),
      );
    };
    const recall = (async (): Promise<RecallOutcome> => {
      let answer: unknown;
      try {
        // Records reach an external provider only with `records` on, never a sensitive one (invariant 26);
        // the built-in ranks the host's own index and is given none.
        const candidates =
          external && installed.declaration.index === "host" && egress.records && options.snapshots !== undefined
            ? await before(
                options.snapshots(rest.actor, { personal: !withholdsPersonal, limit: MEMORY_PROVIDER_LIMITS.candidates }),
                deadline,
              )
            : undefined;
        const request: MemoryRecallRequest = Object.freeze({
          query,
          purpose,
          // What this actor reads, for an own index to pre-filter by; the built-in needs none.
          scopeKeys: external
            ? readableScopeKeys(rest.actor, { personal: !withholdsPersonal, shared: options.sharedRead?.(rest.actor) === true })
            : Object.freeze([]),
          ...(candidates === undefined ? {} : { candidates: Object.freeze(candidates.slice(0, MEMORY_PROVIDER_LIMITS.candidates)) }),
          limit,
          // `embed` is not offered yet (keeping a local chat's query off a remote embedding connection needs the chat's connection here): hybrid recall stays the host's.
          host: Object.freeze({ lexical }),
          signal: deadline,
        });
        answer = await before(installed.provider.recall(request), deadline);
      } catch (error) {
        return { failure: memoryProviderFailure(error) };
      } finally {
        closed = true;
      }
      try {
        // Read once, as plain data: a provider's answer may carry getters or be a Proxy.
        const parsed = MemoryRecallResultSchema.safeParse(JSON.parse(JSON.stringify(answer ?? null)));
        // An answer out of contract is the provider's own failure: `invalid`, not the transport's.
        return parsed.success ? { ranked: parsed.data.hits } : { failure: "invalid" };
      } catch {
        return { failure: "invalid" };
      }
    })();
    if (recallKey !== undefined) {
      recalls.delete(recallKey);
      recalls.set(recallKey, { asked, outcome: recall });
      for (const key of recalls.keys()) {
        if (recalls.size <= RECALLS_KEPT) break;
        recalls.delete(key);
      }
    }
    const outcome = await recall;
    if ("ranked" in outcome) return await render(outcome.ranked, answers);
    // The deadline fired while the host's own search was still answering the provider: the host was slow, not the provider.
    const hostWasSlow = deadline.aborted && pending > 0;
    // The host's own answer to the caller's search: never one the provider chose the query or depth of.
    const own = await ownAnswer();
    // The host's own answer holds every record this actor reads, withheld ones too: nothing to fuse.
    if (hostWasSlow) {
      // Not the provider's failure: a later search of this step asks it again.
      if (recallKey !== undefined && recalls.get(recallKey)?.outcome === recall) recalls.delete(recallKey);
      return own;
    }
    options.log?.("memory provider recall failed; the host's own search answered", {
      providerId: installed.id,
      purpose,
      reason: `failed:${outcome.failure}`,
    });
    return failedOver(own, installed.id, outcome.failure);
  };
}

/** A memory port whose recall goes through `providers` (`recallThroughProviders`); everything else is the port's own. */
export function withProviderRecall(
  port: MemoryServicePort,
  providers: Providers,
  options: MemoryProviderRecallOptions = {},
): MemoryServicePort {
  const search = recallThroughProviders(
    { search: (input) => Promise.resolve(port.search(input)), eligible: (input) => Promise.resolve(port.eligible(input)) },
    providers,
    options,
  );
  return new Proxy(port, {
    get(target, property) {
      if (property === "search") return search;
      // Bound to the port itself, so a class with private fields still works through the wrapper.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
