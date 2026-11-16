import { channelDescriptorOf, recordedConnectionProviders } from "../features/channels/catalog.js";
import { MemoryService } from "@tavi/runtime";
import {
  channelIdentity,
  formatHomeDmIdentity,
  type HomeDmIdentity,
  TaviError,
  type PersistencePort,
  type WorkspaceSettingKey,
  type WorkspaceSettings,
  type WorkspaceSettingsAnswer,
  type WorkspaceSettingsPayload,
  type WorkspaceSettingsRepositoryPort,
  canonicalTimeZone,
  homeChatOn,
  hostTimeZone,
  parseOnOff,
  parseKeptModelRequests,
  parseMaxOutputTokens,
  parseScheduledMonthlyTokenBudget,
  MIN_SCHEDULED_MONTHLY_TOKEN_BUDGET,
  MAX_SCHEDULED_MONTHLY_TOKEN_BUDGET,
  PROMPT_LAYOUTS,
  PromptLayoutSchema,
  TOOL_DEFERRALS,
  ToolDeferralSchema,
  TasksHomeSchema,
  parseVideoKeepDays,
  parseWholeNumberIn,
  BROWSER_VISION_ENGINES,
  BrowserVisionEngineSchema,
  MAX_BROWSER_DOWNLOAD_MAX_MIB,
  MAX_BROWSER_SESSION_IDLE_MINUTES,
  MAX_PARALLEL_READS,
  MAX_VIDEO_KEEP_DAYS,
  MAX_KEPT_MODEL_REQUESTS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  parseNoThumbnailHosts,
  parseDesktopGrantedApps,
  parseHomeDmLink,
  WorkspaceSettingsSchema,
  normalizeSandboxGrant,
  SANDBOX_DOMAINS_MAX,
  parseSettingModelTarget,
  workspaceSettingsAnswerOf,
  TaintModeSchema,
  InjectionDetectorModeSchema,
  SandboxNetworkModeSchema,
  OPERATOR_NAME_MAX,
  OperatorNameSchema,
  taintModeOf,
  taintModeRank,
  type TaintMode,
  type EffectiveMemorySettings,
  type MemorySettings,
  effectiveMemorySettings,
  memoryQuotasOf,
  memoryEmbeddingDisclosure,
  memoryPersonalEmbeddingDisclosure,
  memoryProviderEgressOf,
  BUILTIN_MEMORY_PROVIDER_ID,
  MEMORY_EMBEDDING_DISCLOSURE_REASON,
  MEMORY_EMBEDDING_PERSONAL_DISCLOSURE_REASON,
  MEMORY_PORT_CONFORMANCE,
} from "@tavi/contracts";
import { connectionLocality } from "@tavi/agent-host/task-summarizer";
import { hybridNearMatch, hybridSearch, MEMORY_VECTOR_FAILURES_MAX, type HybridRecallDependencies } from "../features/memory/vectors.js";
import type { MemoryOverride, MemoryOverrideDependencies, MemoryServicePort, ModelConfigPort as ModelConfigService } from "@tavi/contracts";
import { csvList } from "@tavi/contracts/util";
import { rescheduleHeartbeat } from "../features/heartbeat/owner.js";
import type { IpcAnswer } from "../shared/ipc-decisions.js";

import { answering, operatorActor, required, workspaceOf, type ConfigDependencies } from "./config-commands.js";

/**
 * `workspace-settings`: the per-workspace settings
 * document, one key at a time: `timezone`, `activitySummaries`,
 * `activitySummaryModel`, `browserNoThumbnailHosts`, `homeChat`, `homeDmLink`, `keptModelRequests`, and the UI
 * plugin keys `uiRoles` and `uiPlacements` and the `memory` section (JSON values).
 *
 * `set`/`unset` read the stored document, change the one key, and write the
 * whole document back as a compare-and-set: against `expectedRevision` when
 * the client sends the revision it read (the Settings view), otherwise against
 * the revision just read. Either way a concurrent write between the read and
 * this write is a `CONFLICT`, never silently undone.
 */
export function workspaceSettingsCommand(
  deps: ConfigDependencies,
  input: WorkspaceSettingsPayload,
): Promise<IpcAnswer<WorkspaceSettingsAnswer>> {
  const workspaceId = workspaceOf(input);
  return answering(
    async () => {
      // As `system-prompt`: a setting in a workspace this owner does not serve
      // would be a success with no effect.
      if (deps.knownWorkspace !== undefined && !deps.knownWorkspace(workspaceId)) {
        throw new TaviError("NOT_FOUND", `workspace ${workspaceId} is not configured on this owner`, {
          details: { workspaceId },
        });
      }
      const settings = deps.repositories.workspaceSettings;
      // A page may raise `security.taint`, never lower it: lowering widens what runs unasked (a page only tightens).
      // The write is held to the revision checked, so a change in between is a conflict, not a lowering.
      let checkedRevision: number | undefined;
      if (deps.fromBridge === true && input.key === "securityTaint" && input.action !== "get") {
        const record = await settings.get(workspaceId);
        const asked =
          input.action === "set"
            ? (workspaceSettingValue("securityTaint", required(input.value, "a value", "workspace-settings set")) as TaintMode)
            : taintModeOf({});
        if (taintModeRank(asked) < taintModeRank(taintModeOf(record.settings))) {
          throw new TaviError("NOT_AUTHORIZED", `a page can only raise security.taint; lower it with \`tavi permissions taint ${asked}\``, {
            details: { key: input.key },
          });
        }
        checkedRevision = input.expectedRevision ?? record.revision;
      }
      // Allowing an MCP server here is an enable as far as the budget goes: an overflow is refused.
      if (input.key === "mcpServers" && input.action === "set" && deps.mcpBudget !== undefined) {
        const before = new Set((await settings.get(workspaceId)).settings.mcpServers ?? []);
        // Every server the change adds counts with the others it adds: two that fit alone may not fit together.
        const added = (
          workspaceSettingValue("mcpServers", required(input.value, "a value", "workspace-settings set")) as readonly string[]
        ).filter((pluginId) => !before.has(pluginId));
        for (const pluginId of added)
          await deps.mcpBudget.checkEnable(
            pluginId,
            workspaceId,
            added.filter((other) => other !== pluginId),
          );
      }
      if (input.action !== "get") {
        await applyWorkspaceSetting(settings, {
          connectionProviders: await recordedConnectionProviders(deps.repositories),
          workspaceId,
          key: required(input.key, "a key", `workspace-settings ${input.action}`) as WorkspaceSettingKey,
          value: input.action === "set" ? required(input.value, "a value", "workspace-settings set") : undefined,
          ...(checkedRevision !== undefined
            ? { expectedRevision: checkedRevision }
            : input.expectedRevision === undefined
              ? {}
              : { expectedRevision: input.expectedRevision }),
          actor: operatorActor(deps.fromBridge),
          now: new Date(deps.now()).toISOString(),
          retrievalCheck: () =>
            memoryRetrievalDisclosure(
              deps.modelConfig,
              deps.repositories.memory,
              workspaceId,
              deps.workspacePrincipal?.(workspaceId),
              new Date(deps.now()).toISOString(),
            ),
          dropVectorCache: async () => deps.repositories.memory.dropVectorCache(workspaceId),
          ...(deps.pruneMemoryVectors === undefined ? {} : { pruneVectors: deps.pruneMemoryVectors }),
          ...(input.confirmed === true ? { confirmed: true } : {}),
          ...(input.confirmedConnection === undefined ? {} : { confirmedConnection: input.confirmedConnection }),
          ...(input.retrievalPersonal === undefined ? {} : { retrievalPersonal: input.retrievalPersonal }),
        });
        if (input.key === "mcpServers") await deps.mcpBudget?.recheck();
        // The heartbeat's hours are local: a new timezone moves its next check.
        const principalId = deps.workspacePrincipal?.(workspaceId);
        if (input.key === "timezone" && principalId !== undefined && deps.repositories.heartbeats !== undefined) {
          const timezone = (await settings.get(workspaceId)).settings.timezone ?? hostTimeZone();
          await rescheduleHeartbeat(deps.repositories.heartbeats, { workspaceId, principalId, timezone, now: new Date(deps.now()) });
        }
      }
      return workspaceSettingsAnswerFor(settings, workspaceId, deps.taintPolicy, await deps.disabledPlugins?.());
      // A disclosure's connection goes back with it: the client's confirm names it (`confirmedConnection`).
    },
    (failure) =>
      failure.code === "APPROVAL_REQUIRED" && typeof failure.details?.["connectionId"] === "string"
        ? { connectionId: failure.details["connectionId"] }
        : undefined,
  );
}

/**
 * The workspace's `memory` section in effect, read per call so
 * a change applies from the next model call. `contextTokens` is the owner's
 * default context budget.
 *
 * Exported so the owner and the offline CLI read settings the same way.
 */
export function memorySettingsReader(
  settings: WorkspaceSettingsRepositoryPort,
  defaults: { readonly contextTokens?: number | undefined } = {},
): (workspaceId: string) => Promise<EffectiveMemorySettings> {
  return async (workspaceId) => effectiveMemorySettings((await settings.get(workspaceId)).settings.memory, defaults);
}

/**
 * The owner's memory service, and the offline CLI's: the one
 * construction both use. Charged to the workspace's quotas
 * (`limits.maxRecords`, with the byte quota following it), and typed
 * as the port, so every caller reads and writes memory through
 * `MemoryServicePort` and never the class.
 */
export function openMemoryService(
  port: PersistencePort,
  memorySettings: (workspaceId: string) => Promise<EffectiveMemorySettings>,
  /**
   * Called before each forget, and what it answers after it: the
   * owner edits the channel messages a card holding the record was sent as.
   * Best effort: a failure here never fails the forget.
   */
  aroundForget?: (recordId: string) => Promise<(() => Promise<void>) | undefined>,
  /** Hybrid recall: a search with `semantic` text embeds it under `retrieval: "hybrid"`. Absent: lexical always. */
  hybrid?: Omit<HybridRecallDependencies, "memorySettings">,
): MemoryServicePort {
  const options = { quotasFor: async (workspaceId: string) => memoryQuotasOf(await memorySettings(workspaceId)) };
  if (aroundForget === undefined && hybrid === undefined) return new MemoryService(port, options);
  return new (class extends MemoryService {
    readonly #hybridSearch = hybrid === undefined ? undefined : hybridSearch((input) => super.search(input), { ...hybrid, memorySettings });
    readonly #hybridNearMatch = hybrid === undefined ? undefined : hybridNearMatch({ ...hybrid, memorySettings });
    override async propose(...args: Parameters<MemoryService["propose"]>): ReturnType<MemoryService["propose"]> {
      if (this.#hybridNearMatch !== undefined) return super.propose(await this.#hybridNearMatch(args[0]));
      // Without the wrapper no caller may hand the worker a vector of its own.
      const { nearMatchVector: _vector, ...plain } = args[0];
      return super.propose(plain);
    }
    override async forget(...args: Parameters<MemoryService["forget"]>): ReturnType<MemoryService["forget"]> {
      if (aroundForget === undefined) return super.forget(...args);
      return forgetAround(aroundForget, (...inner) => super.forget(...inner))(...args);
    }
    override search(...args: Parameters<MemoryService["search"]>): ReturnType<MemoryService["search"]> {
      if (this.#hybridSearch !== undefined) return this.#hybridSearch(args[0]);
      // Without the wrapper no caller may hand the worker a vector of its own (`semantic` alone is only read with blank words: no hits).
      const { queryVector: _vector, ...lexical } = args[0];
      return super.search(lexical);
    }
  })(port, options);
}

/** `forget` with the owner's card edits around it; a failing edit never fails the forget. */
function forgetAround(
  aroundForget: (recordId: string) => Promise<(() => Promise<void>) | undefined>,
  forget: MemoryServicePort["forget"],
): MemoryServicePort["forget"] {
  return async (...args) => {
    // A card edit that fails never fails the forget: the record still goes.
    const after = await aroundForget(args[0].recordId).catch(() => undefined);
    const deletion = await forget(...args);
    // A card edit that fails never fails the forget: the record still goes.
    await after?.().catch(() => undefined);
    return deletion;
  };
}

/**
 * Refuse an embedder's `memoryOverride` that has not declared it passes
 * `@tavi/plugin-kit/memory`'s port suite (invariant 15): the owner
 * does not start on a memory service nobody said was checked. Absent: the
 * built-in, nothing to admit.
 */
export function admitMemoryOverride(override: MemoryOverride | undefined): void {
  if (override === undefined) return;
  const declared: unknown = (override as { readonly conformance?: unknown } | null)?.conformance;
  if (declared !== MEMORY_PORT_CONFORMANCE || typeof (override as { readonly create?: unknown }).create !== "function") {
    throw new TaviError(
      "INVALID_INPUT",
      `A memoryOverride must pass @tavi/plugin-kit/memory's port suite and declare it with conformance: "${MEMORY_PORT_CONFORMANCE}"; this one declares ${declared === undefined ? "nothing" : JSON.stringify(declared)}`,
      { details: { expected: MEMORY_PORT_CONFORMANCE } },
    );
  }
}

/**
 * The owner's memory service when an embedder passes `memoryOverride`:
 * its port, built once, with the owner's card edits around each
 * forget as `openMemoryService` has them. Nothing else is wrapped:
 * quotas, hybrid recall and the store are the override's own.
 */
export function openMemoryOverride(
  override: MemoryOverride,
  dependencies: MemoryOverrideDependencies,
  aroundForget?: (recordId: string) => Promise<(() => Promise<void>) | undefined>,
): MemoryServicePort {
  admitMemoryOverride(override);
  const port = override.create(dependencies);
  if (aroundForget === undefined) return port;
  const forget = forgetAround(aroundForget, (...args) => port.forget(...args));
  return new Proxy(port, {
    get(target, property) {
      if (property === "forget") return forget;
      // Bound to the override itself, so a class with private fields still works through the wrapper.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * What turning `memory.retrieval` to `hybrid` needs first (invariant 14):
 * a bound `embedding` role, and, when its connection is
 * remote, the person's acceptance of the disclosure naming where memory text
 * and queries go and how many of the workspace's records (`records`) the
 * backfill sends. Personal memory has its own disclosure
 * (`personalDisclosure`, counting `personal`, the records of `principalId`,
 * the operator who would accept it, alone): a remote connection embeds the
 * operator's own only once that one is accepted too, and nobody else's
 * (`retrievalPersonal`, `embeddedPrincipals`).
 * Answers nothing to say for a local connection.
 */
export async function memoryRetrievalDisclosure(
  modelConfig: Pick<ModelConfigService, "listRoleBindings" | "resolveRole">,
  memory: Pick<PersistencePort["repositories"]["memory"], "vectorStats">,
  workspaceId: string,
  principalId: string | undefined,
  now: string,
): Promise<MemoryRetrievalCheck & { readonly model: string }> {
  const bound = (await modelConfig.listRoleBindings(workspaceId)).some((binding) => binding.role === "embedding");
  if (!bound) {
    throw new TaviError(
      "NOT_CONFIGURED",
      `Hybrid recall needs an embedding model: bind one with \`tavi models set-role embedding --connection <id> --model <id>\`, then turn hybrid on`,
      { details: { workspaceId, role: "embedding" } },
    );
  }
  const resolution = await modelConfig.resolveRole({ workspaceId, role: "embedding" });
  const locality = connectionLocality(resolution.connection);
  const stats = await memory.vectorStats({
    workspaceId,
    principalIds: principalId === undefined ? [] : [principalId],
    now,
    maxFailures: MEMORY_VECTOR_FAILURES_MAX,
  });
  const records = stats.eligible - stats.personal;
  const personal = stats.personal;
  const connectionId = resolution.target.connectionId;
  return {
    connectionId,
    model: resolution.target.model,
    remote: locality === "remote",
    records,
    personal,
    disclosure: memoryEmbeddingDisclosure({ connectionId, records }),
    personalDisclosure: memoryPersonalEmbeddingDisclosure({ connectionId, personal }),
  };
}

/** What `memoryRetrievalDisclosure` answers: where hybrid recall sends memory text, and what each disclosure says. */
export interface MemoryRetrievalCheck {
  readonly remote: boolean;
  readonly connectionId: string;
  /** The workspace's own records the backfill sends. */
  readonly records: number;
  /** The accepting operator's own personal records, sent only with `retrievalPersonal`. */
  readonly personal: number;
  readonly disclosure: string;
  readonly personalDisclosure: string;
}

/**
 * Set (`value`) or clear (`value: undefined`) one key, as a compare-and-set.
 *
 * Exported so the offline CLI writes exactly what the owner writes, including
 * the zone's canonical spelling and the refusal that names a bad value.
 */
export async function applyWorkspaceSetting(
  settings: WorkspaceSettingsRepositoryPort,
  input: {
    readonly workspaceId: string;
    readonly key: WorkspaceSettingKey;
    readonly value: string | undefined;
    readonly expectedRevision?: number;
    readonly actor: string;
    readonly now: string;
    /**
     * Each connection's provider, from `recordedConnectionProviders`: what
     * `chat.home-dm` checks its identities against. Without it no identity
     * can be checked, so none is linked.
     */
    readonly connectionProviders?: ReadonlyMap<string, string>;
    /**
     * Turning `memory.retrieval` to `hybrid` (invariant 14): what it
     * needs first (`memoryRetrievalDisclosure`), and whether the person
     * accepted its disclosure (`confirmed`). Without `retrievalCheck` the
     * change is refused, so no path turns hybrid on unchecked. A confirmed
     * write while hybrid is on checks again. `confirmed` accepts a remote
     * connection's disclosure only with `confirmedConnection` naming the
     * connection it named, still the one bound: otherwise the disclosure of
     * the connection bound now is the refusal. The accepted remote connection
     * is stored as `retrievalConnection`, never as a client sent it.
     */
    readonly retrievalCheck?: () => Promise<MemoryRetrievalCheck>;
    readonly confirmed?: boolean;
    readonly confirmedConnection?: string;
    /**
     * Embedding personal memory through the remote connection too:
     * `true` asks for it, with hybrid, and
     * shows personal memory's own disclosure until `confirmed`; `false` turns
     * it off; absent keeps it. Stored as `retrievalPersonal`, the connection
     * it was accepted for, never as a client sent it; it ends with hybrid, and
     * when another connection is accepted.
     */
    readonly retrievalPersonal?: boolean;
    /**
     * Drop the worker's vector cache for the workspace: called once a
     * write took `memory.retrieval` from hybrid back to lexical, so the cache
     * goes with the write, not on the backfill's next tick (and even with
     * `tavi.memory` off, whose tick never runs). Best effort.
     */
    readonly dropVectorCache?: () => Promise<void>;
    /**
     * Prune the vectors no workspace may keep any more (`pruneMemoryVectors`):
     * called with `dropVectorCache`, so a personal-memory opt-out removes that
     * person's vectors of the workspace's model from the database and every
     * cache with the write, not on a tick that may never run. Best effort.
     */
    readonly pruneVectors?: () => Promise<unknown>;
  },
): Promise<void> {
  let next: WorkspaceSettings;
  const current = await settings.get(input.workspaceId);
  let value = input.value === undefined ? undefined : workspaceSettingValue(input.key, input.value);
  if (input.key === "memory" && value !== undefined) {
    // A section read before another change (a provider switch, say) is a conflict, as the write would be:
    // compared before the provider check below, so a stale section is not mistaken for a provider change.
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      throw new TaviError(
        "CONFLICT",
        `The settings for workspace ${input.workspaceId} changed since they were read (expected revision ${input.expectedRevision}, current revision ${current.revision})`,
        {
          details: { expectedRevision: input.expectedRevision, currentRevision: current.revision },
        },
      );
    }
    // Hybrid recall sends memory text and queries to the embedding connection: shown and accepted first when remote.
    const {
      retrievalConnection: _sent,
      retrievalPersonal: _sentPersonal,
      provider: sentProvider,
      providerEgress: sentEgress,
      ...rest
    } = value as MemorySettings;
    const stored = current.settings.memory;
    // The provider and its egress change only by `tavi memory set-provider` and `egress`, each after its
    // disclosure: a section sent back as read keeps them, and one that changes them is refused.
    const egressOf = (egress: MemorySettings["providerEgress"]): string =>
      JSON.stringify(memoryProviderEgressOf(egress === undefined ? undefined : { providerEgress: egress }));
    if (
      (sentProvider !== undefined && sentProvider !== (stored?.provider ?? BUILTIN_MEMORY_PROVIDER_ID)) ||
      (sentEgress !== undefined && egressOf(sentEgress) !== egressOf(stored?.providerEgress))
    ) {
      throw new TaviError(
        "INVALID_INPUT",
        "The memory provider and its egress change only with tavi memory set-provider and tavi memory egress (or the Center's Provider), which say what they send first",
        { details: { key: input.key } },
      );
    }
    const asked: MemorySettings = {
      ...rest,
      ...(stored?.provider === undefined ? {} : { provider: stored.provider }),
      ...(stored?.providerEgress === undefined ? {} : { providerEgress: stored.providerEgress }),
    };
    const hybrid = asked.retrieval === "hybrid";
    const wantsPersonal = input.retrievalPersonal === true;
    if (wantsPersonal && !hybrid) {
      throw new TaviError(
        "INVALID_INPUT",
        "Personal memory is embedded only with hybrid recall: tavi memory config retrieval hybrid --include-personal",
        { details: { key: input.key } },
      );
    }
    let accepted = hybrid ? stored?.retrievalConnection : undefined;
    // Personal memory's opt-in: kept while hybrid stays on, unless turned off.
    let personal = hybrid && input.retrievalPersonal !== false ? stored?.retrievalPersonal : undefined;
    if (hybrid && (stored?.retrieval !== "hybrid" || input.confirmed === true || wantsPersonal)) {
      if (input.retrievalCheck === undefined)
        throw new TaviError(
          "UNAVAILABLE",
          "Hybrid recall cannot be checked here: turn it on from the Center or `tavi memory config retrieval hybrid`",
          { details: { key: input.key } },
        );
      const check = await input.retrievalCheck();
      // Asking for personal memory where hybrid was already accepted for this connection says only what is new.
      const covered = stored?.retrieval === "hybrid" && stored.retrievalConnection === check.connectionId;
      // A confirm accepts only the connection its disclosure named: one bound since is disclosed afresh.
      const confirmed = input.confirmed === true && input.confirmedConnection === check.connectionId;
      if (check.remote && !confirmed && !(wantsPersonal && covered && stored?.retrievalPersonal === check.connectionId)) {
        const disclosure = !wantsPersonal
          ? check.disclosure
          : covered
            ? check.personalDisclosure
            : `${check.disclosure} ${check.personalDisclosure}`;
        throw new TaviError("APPROVAL_REQUIRED", `${disclosure} Confirm to turn ${wantsPersonal && covered ? "it" : "hybrid recall"} on.`, {
          details: {
            key: input.key,
            reason: wantsPersonal ? MEMORY_EMBEDDING_PERSONAL_DISCLOSURE_REASON : MEMORY_EMBEDDING_DISCLOSURE_REASON,
            disclosure,
            connectionId: check.connectionId,
            records: check.records,
            ...(wantsPersonal ? { personal: check.personal } : {}),
          },
        });
      }
      accepted = check.remote ? check.connectionId : undefined;
      // A local connection embeds personal memory without it: nothing leaves the machine.
      if (wantsPersonal) personal = accepted;
    }
    // Bound to the accepted connection: another one embeds no personal record until accepted again.
    if (personal !== accepted) personal = undefined;
    value = {
      ...asked,
      ...(accepted === undefined ? {} : { retrievalConnection: accepted }),
      ...(personal === undefined ? {} : { retrievalPersonal: personal }),
    };
  }
  // `chat.home-dm off` links nothing: stored as no key, not an empty list. A
  // memory section with every key at its default is no section either.
  // Clearing the memory section keeps its provider and egress, which only their own verbs change.
  if (
    input.key === "memory" &&
    value === undefined &&
    (current.settings.memory?.provider !== undefined || current.settings.memory?.providerEgress !== undefined)
  ) {
    const { provider, providerEgress } = current.settings.memory ?? {};
    value = { ...(provider === undefined ? {} : { provider }), ...(providerEgress === undefined ? {} : { providerEgress }) };
  }
  if (
    value === undefined ||
    (input.key === "homeDmLink" && Array.isArray(value) && value.length === 0) ||
    (input.key === "memory" && typeof value === "object" && Object.keys(value).length === 0)
  ) {
    const { [input.key]: _cleared, ...rest } = current.settings;
    next = rest;
  } else {
    next = { ...current.settings, [input.key]: value };
    // The DM link makes DMs turns of Home: with no Home it would mean nothing.
    if (input.key === "homeDmLink" && !homeChatOn(next)) {
      throw new TaviError("INVALID_INPUT", "chat.home-dm links your DMs to Home, which is off in this workspace: turn chat.home on first", {
        details: { key: input.key },
      });
    }
    if (input.key === "homeDmLink" && Array.isArray(value)) {
      for (const identity of value as readonly HomeDmIdentity[]) {
        const descriptor = channelDescriptorOf(input.connectionProviders?.get(identity.connectionId));
        // Only a known chat channel's connection has one-to-one conversations to link, and the sender must be an id there.
        if (descriptor?.kind !== "chat" || channelIdentity(identity.senderId, descriptor.sender) === undefined) {
          throw new TaviError(
            "INVALID_INPUT",
            `${formatHomeDmIdentity(identity)} is not a sender id on a chat channel's connection this data directory knows; use <connection>:<sender id> such as my-chat:123456789, with a connection saved in Settings or one the person has messaged`,
            { details: { key: input.key } },
          );
        }
      }
    }
  }
  await settings.set({
    workspaceId: input.workspaceId,
    settings: next,
    expectedRevision: input.expectedRevision ?? current.revision,
    actor: input.actor,
    now: input.now,
  });
  const personalEnded =
    current.settings.memory?.retrievalPersonal !== undefined &&
    next.memory?.retrievalPersonal !== current.settings.memory.retrievalPersonal;
  if (current.settings.memory?.retrieval === "hybrid" && (next.memory?.retrieval !== "hybrid" || personalEnded)) {
    // A cache left behind is only memory held: the backfill's tick drops it too. The personal vectors no
    // workspace may embed any more go now as well, even with the tick off.
    await input.dropVectorCache?.().catch(() => undefined);
    // Never throws (it logs its own failure); the backfill's tick prunes again.
    await input.pruneVectors?.().catch(() => undefined);
  }
}

/**
 * The stored form of `value` for `key`, or a refusal that names what was typed:
 * a zone in its canonical spelling, `on`/`off` as a boolean, and
 * `<connection>/<model>` as a target.
 */
function workspaceSettingValue(key: WorkspaceSettingKey, value: string): WorkspaceSettings[WorkspaceSettingKey] {
  switch (key) {
    case "timezone": {
      const timezone = canonicalTimeZone(value);
      if (timezone === undefined) {
        throw new TaviError(
          "INVALID_INPUT",
          `${JSON.stringify(value)} is not an IANA time zone; use a name such as Europe/Berlin or America/New_York`,
          { details: { key } },
        );
      }
      return timezone;
    }
    case "operatorName": {
      const name = OperatorNameSchema.safeParse(value);
      if (!name.success)
        throw new TaviError(
          "INVALID_INPUT",
          `operator.name takes one line of up to ${String(OPERATOR_NAME_MAX)} characters, such as "Robin"`,
          { details: { key } },
        );
      return name.data;
    }
    case "activitySummaries":
    case "homeChat":
    case "travelFlightSearch":
    case "travelGoogleFlights":
    case "skillSuggestions":
    case "pdfEnabled":
    case "videoEnabled":
    case "redactToolResults": {
      const on = parseOnOff(value);
      if (on === undefined) throw new TaviError("INVALID_INPUT", `${JSON.stringify(value)} is not on or off`, { details: { key } });
      return on;
    }
    case "homeDmLink": {
      const parsed = parseHomeDmLink(value);
      if ("invalid" in parsed) {
        throw new TaviError(
          "INVALID_INPUT",
          `${JSON.stringify(parsed.invalid)} is not a DM identity; use <connection>:<sender id> such as my-chat:123456789 (a comma-separated list), or off`,
          { details: { key } },
        );
      }
      return [...parsed.identities];
    }
    case "desktopGrantedApps": {
      const parsed = parseDesktopGrantedApps(value);
      if ("invalid" in parsed)
        throw new TaviError(
          "INVALID_INPUT",
          `${JSON.stringify(parsed.invalid)} is not an app; use a comma-separated list of bundle ids or app names, such as "com.apple.TextEdit,Notes", or none`,
          { details: { key } },
        );
      return [...parsed.apps];
    }
    case "browserNoThumbnailHosts": {
      const parsed = parseNoThumbnailHosts(value);
      if ("invalid" in parsed) {
        throw new TaviError(
          "INVALID_INPUT",
          `${JSON.stringify(parsed.invalid)} is not a host or *.domain; use a comma-separated list such as "mail.example.com,*.bank", or none`,
          { details: { key } },
        );
      }
      return [...parsed.hosts];
    }
    case "uiRoles":
    case "uiPlacements":
    case "memory": {
      // A JSON object, validated by the document's own schema for the key.
      let raw: unknown;
      try {
        raw = JSON.parse(value);
      } catch {
        throw new TaviError(
          "INVALID_INPUT",
          `${key} takes a JSON object, such as ${key === "uiRoles" ? '{"browser-view":"acme.browserview"}' : key === "memory" ? '{"enabled":false}' : '{"acme.browserview/live":"hidden"}'}`,
          { details: { key } },
        );
      }
      const parsed = WorkspaceSettingsSchema.shape[key].safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
        throw new TaviError("INVALID_INPUT", `${key} is not valid: ${where}${issue?.message ?? "unknown problem"}`, { details: { key } });
      }
      return parsed.data;
    }
    case "securityTaint": {
      const mode = TaintModeSchema.safeParse(value.trim().toLowerCase());
      if (!mode.success)
        throw new TaviError("INVALID_INPUT", `${JSON.stringify(value)} is not a taint mode; use off, observe or enforce`, {
          details: { key },
        });
      return mode.data;
    }
    case "securityInjectionDetector": {
      const mode = InjectionDetectorModeSchema.safeParse(value.trim().toLowerCase());
      if (!mode.success)
        throw new TaviError("INVALID_INPUT", `${JSON.stringify(value)} is not an injection detector mode; use off, patterns or model`, {
          details: { key },
        });
      return mode.data;
    }
    case "sandboxNetwork": {
      const mode = SandboxNetworkModeSchema.safeParse(value.trim().toLowerCase());
      if (!mode.success)
        throw new TaviError("INVALID_INPUT", `${JSON.stringify(value)} is not a sandbox network mode; use granted or ask`, {
          details: { key },
        });
      return mode.data;
    }
    case "mcpServers":
    case "mcpPeople": {
      // A comma-separated list of MCP server ids, or none.
      const ids = value.trim().toLowerCase() === "none" ? [] : [...new Set(csvList(value))];
      const parsed = WorkspaceSettingsSchema.shape[key].safeParse(ids);
      if (!parsed.success)
        throw new TaviError(
          "INVALID_INPUT",
          `${JSON.stringify(value)} is not a list of MCP server ids; use a comma-separated list such as mcp.docs,mcp.home, or none`,
          { details: { key } },
        );
      return parsed.data;
    }
    case "sandboxDomains": {
      // A comma-separated list of domains, or none.
      const entries = value.trim().toLowerCase() === "none" ? [] : csvList(value);
      const invalid = entries.find((entry) => normalizeSandboxGrant(entry) === undefined);
      if (invalid !== undefined)
        throw new TaviError(
          "INVALID_INPUT",
          `${JSON.stringify(invalid)} is not a domain sandbox.run may reach; use a comma-separated list such as "pypi.org,*.pythonhosted.org,api.example.com:443" (or @registries), or none`,
          { details: { key } },
        );
      const domains = [...new Set(entries.map((entry) => normalizeSandboxGrant(entry) ?? entry))];
      const parsed = WorkspaceSettingsSchema.shape[key].safeParse(domains);
      if (!parsed.success)
        throw new TaviError("INVALID_INPUT", `sandbox.domains holds at most ${String(SANDBOX_DOMAINS_MAX)} domains`, { details: { key } });
      return parsed.data;
    }
    case "browserSessionIdleMinutes":
    case "browserDownloadMaxMiB":
    case "parallelReads": {
      const [min, max] =
        key === "browserSessionIdleMinutes"
          ? [0, MAX_BROWSER_SESSION_IDLE_MINUTES]
          : key === "parallelReads"
            ? [1, MAX_PARALLEL_READS]
            : [1, MAX_BROWSER_DOWNLOAD_MAX_MIB];
      const number = parseWholeNumberIn(value, min, max);
      if (number === undefined)
        throw new TaviError("INVALID_INPUT", `${JSON.stringify(value)} is not a whole number from ${String(min)} to ${String(max)}`, {
          details: { key },
        });
      return number;
    }
    case "videoKeepDays": {
      const days = parseVideoKeepDays(value);
      if (days === undefined)
        throw new TaviError("INVALID_INPUT", `${JSON.stringify(value)} is not a number of days from 1 to ${String(MAX_VIDEO_KEEP_DAYS)}`, {
          details: { key },
        });
      return days;
    }
    case "browserVisionEngine": {
      const parsed = BrowserVisionEngineSchema.safeParse(value.trim());
      if (!parsed.success)
        throw new TaviError("INVALID_INPUT", `${JSON.stringify(value)} is not a vision engine: ${BROWSER_VISION_ENGINES.join(" or ")}`, {
          details: { key },
        });
      return parsed.data;
    }
    case "toolDeferral": {
      const parsed = ToolDeferralSchema.safeParse(value.trim());
      if (!parsed.success)
        throw new TaviError("INVALID_INPUT", `${JSON.stringify(value)} is not a tool deferral: ${TOOL_DEFERRALS.join(", ")}`, {
          details: { key },
        });
      return parsed.data;
    }
    case "tasksHome": {
      const parsed = TasksHomeSchema.safeParse(value.trim());
      if (!parsed.success)
        throw new TaviError(
          "INVALID_INPUT",
          `${JSON.stringify(value)} is not a task home: tavi, or mcp:<server> (for example mcp:todoist)`,
          {
            details: { key },
          },
        );
      return parsed.data;
    }
    case "promptLayout": {
      const parsed = PromptLayoutSchema.safeParse(value.trim());
      if (!parsed.success)
        throw new TaviError("INVALID_INPUT", `${JSON.stringify(value)} is not a prompt layout: ${PROMPT_LAYOUTS.join(" or ")}`, {
          details: { key },
        });
      return parsed.data;
    }
    case "keptModelRequests": {
      const count = parseKeptModelRequests(value);
      if (count === undefined)
        throw new TaviError("INVALID_INPUT", `${JSON.stringify(value)} is not a count from 0 to ${MAX_KEPT_MODEL_REQUESTS}`, {
          details: { key },
        });
      return count;
    }
    case "maxOutputTokens": {
      const tokens = parseMaxOutputTokens(value);
      if (tokens === undefined)
        throw new TaviError(
          "INVALID_INPUT",
          `${JSON.stringify(value)} is not a number of tokens from ${MIN_MAX_OUTPUT_TOKENS} to ${MAX_MAX_OUTPUT_TOKENS}`,
          { details: { key } },
        );
      return tokens;
    }
    case "scheduledMonthlyTokenBudget": {
      const tokens = parseScheduledMonthlyTokenBudget(value);
      if (tokens === undefined)
        throw new TaviError(
          "INVALID_INPUT",
          `${JSON.stringify(value)} is not a number of tokens from ${MIN_SCHEDULED_MONTHLY_TOKEN_BUDGET} to ${MAX_SCHEDULED_MONTHLY_TOKEN_BUDGET}; unset it for no budget`,
          { details: { key } },
        );
      return tokens;
    }
    case "activitySummaryModel": {
      const target = parseSettingModelTarget(value);
      if (target === undefined) {
        throw new TaviError(
          "INVALID_INPUT",
          `${JSON.stringify(value)} is not <connection>/<model>, for example openrouter/openai/gpt-4.1-mini`,
          { details: { key } },
        );
      }
      return target;
    }
  }
}

/** The answer for one workspace, with the owner host's zone as the default. Shared by the owner and the offline CLI. */
export async function workspaceSettingsAnswerFor(
  settings: WorkspaceSettingsRepositoryPort,
  workspaceId: string,
  taintPolicy?: TaintMode,
  disabledPlugins?: ReadonlySet<string>,
): Promise<WorkspaceSettingsAnswer> {
  return workspaceSettingsAnswerOf(await settings.get(workspaceId), hostTimeZone(), taintPolicy, disabledPlugins);
}
