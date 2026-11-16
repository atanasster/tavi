import { randomUUID } from "node:crypto";
import {
  ModelUsageSchema,
  RouterCandidateSchema,
  RouterReceiptSchema,
  TaviError,
  estimateModelCost,
  routerProviderFailure,
  scrubCredentialText,
  type ModelPriceSheet,
  type ModelUsage,
  type RouterCandidate,
  type RouterDecisionInput,
  type RouterFeature,
  type RouterPort,
  type RouterProvider,
  type RouterProviderAnswer,
  type RouterProviderFailure,
  type RouterProviderLimits,
  type RouterProviderRequest,
  type RouterReceipt,
  type RouterRepositoryPort,
  type RouterSettings,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import type { RouterProviderSlot } from "./slot.js";

export interface RouterGuardOptions {
  readonly repository: RouterRepositoryPort;
  readonly slot: RouterProviderSlot;
  readonly accounting: Pick<import("@tavi/contracts").ModelAccountingPort, "price" | "begin" | "finish">;
  readonly now?: () => number;
  readonly newId?: () => string;
}

interface DecisionAnswer {
  readonly selectedIds: readonly string[];
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

/** A host-side refusal inside the decision deadline; never a provider failure. */
class HostAbstain extends Error {
  readonly reason: "no-candidates";
  constructor(reason: "no-candidates") {
    super(reason);
    this.reason = reason;
  }
}

const missingProjection = (): never => {
  throw new TaviError("INTERNAL", "Missing batch projection");
};
const abortError = (): DOMException => new DOMException("Router decision aborted", "AbortError");
const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

/** Deterministic prefilter used when a catalog exceeds the decision request bound. */
export function lexicalCandidates<T extends RouterCandidate>(prompt: string, candidates: readonly T[], limit: number): readonly T[] {
  const terms = new Set(prompt.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score:
        (candidate.id + " " + candidate.description)
          .toLocaleLowerCase()
          .match(/[\p{L}\p{N}_-]+/gu)
          ?.filter((term) => terms.has(term)).length ?? 0,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

/** This scope's settings for its selected provider: a built-in's validated settings, `{}` for an external one. */
function providerSettings(settings: RouterSettings): Readonly<Record<string, unknown>> {
  return settings.providerSettings[settings.provider] ?? {};
}

const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Validates a provider's answer against what it was asked. Thresholds are the
 * host's: a provider reports probabilities, never a selection.
 */
function readAnswer(
  returned: unknown,
  feature: RouterFeature,
  candidates: readonly RouterCandidate[],
  threshold: number,
  maxResponseBytes: number,
): { readonly answer: DecisionAnswer; readonly usage: ModelUsage } {
  // The usage a provider reports is kept even when its answer is refused: the call was billed.
  let usage: ModelUsage = {};
  const invalid = (): never => {
    throw new HostInvalid(usage);
  };
  // Read the provider's value exactly once, as plain data: getters, proxies and
  // toJSON run here, inside the bound, and nothing validated can change afterwards.
  let answer: RouterProviderAnswer;
  try {
    const text = JSON.stringify(returned);
    if (Buffer.byteLength(text) > maxResponseBytes) return invalid();
    answer = JSON.parse(text) as RouterProviderAnswer;
  } catch {
    return invalid();
  }
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) invalid();
  usage = validUsage(answer.usage) ?? {};
  const raw = answer.probabilities;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  const probabilities: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!allowed.has(id) || !probability(value)) invalid();
    probabilities[id] = value;
  }
  if (answer.confidence !== undefined && !probability(answer.confidence)) invalid();
  const confidence = answer.confidence === undefined ? {} : { confidence: answer.confidence };
  if (feature === "model") {
    const choice = answer.choice;
    if (typeof choice !== "string" || !allowed.has(choice) || Object.keys(probabilities).length !== allowed.size) invalid();
    if (Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.001) invalid();
    const chosen = probabilities[choice as string] ?? 0;
    return { answer: { selectedIds: chosen >= threshold ? [choice as string] : [], probabilities, ...confidence }, usage };
  }
  if (answer.choice !== undefined) invalid();
  return {
    answer: {
      selectedIds: candidates.filter((candidate) => (probabilities[candidate.id] ?? 0) >= threshold).map((candidate) => candidate.id),
      probabilities,
      ...confidence,
    },
    usage,
  };
}

/** A provider's failure, re-made by the host: the provider's own thrown value is never rethrown. */
class ProviderFailure extends Error {
  readonly reason: RouterProviderFailure;
  constructor(reason: RouterProviderFailure) {
    super(reason);
    this.reason = reason;
  }
}

/** Classifies whatever a provider threw without letting reading it throw. */
function providerThrow(error: unknown): { readonly reason: RouterProviderFailure | "abort"; readonly usage?: ModelUsage } {
  try {
    if (isAbort(error)) return { reason: "abort" };
    const reason = routerProviderFailure(error) ?? "transport";
    let usage: ModelUsage | undefined;
    // Read on its own: a usage getter that throws must not hide the failure's reason.
    try {
      usage = validUsage((error as { usage?: unknown } | null)?.usage);
    } catch {
      usage = undefined;
    }
    return usage === undefined ? { reason } : { reason, usage };
  } catch {
    return { reason: "transport" };
  }
}

/** A deep-frozen copy for a provider: it can neither change what the host validates against nor share its objects. */
function frozen<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  };
  freeze(copy);
  return copy;
}

class HostInvalid extends Error {
  readonly reason = "invalid" as const;
  readonly usage: ModelUsage;
  constructor(usage: ModelUsage = {}) {
    super("invalid");
    this.usage = usage;
  }
}

/** A provider hook that runs before any reservation threw; the decision abstains with its reason. */
class HookFailure extends Error {
  readonly reason: RouterProviderFailure;
  constructor(reason: RouterProviderFailure) {
    super(reason);
    this.reason = reason;
  }
}

/** Runs a provider hook; a throw becomes a HookFailure so it can never escape the guard. */
function hook<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new HookFailure(routerProviderFailure(error) ?? "invalid");
  }
}

function validUsage(usage: unknown): ModelUsage | undefined {
  if (usage === undefined) return undefined;
  const parsed = ModelUsageSchema.safeParse(usage);
  if (!parsed.success) return undefined;
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  return Object.values(parsed.data).every((value) => value === undefined || valid(value)) ? parsed.data : undefined;
}

/**
 * The host's worst-case charge for a provider that sets none of its own (an
 * external plugin): a full request at the dearest input rate, plus a full
 * response at the dearest output rate, counting about four bytes a token.
 */
function hostReservation(price: ModelPriceSheet, limits: RouterProviderLimits): number {
  return (
    (limits.requestTokenCap * Math.max(price.input, price.cacheRead, price.cacheWrite) +
      Math.ceil(limits.maxResponseBytes / 4) * Math.max(price.output, price.reasoning ?? 0)) /
    1_000_000
  );
}

interface BatchContext {
  readonly features: readonly RouterFeature[];
  readonly prompts: Readonly<Partial<Record<RouterFeature, string>>>;
  readonly featureOf: ReadonlyMap<string, RouterFeature>;
}

/**
 * The host's routing service. Every provider runs behind it: it applies modes,
 * disclosure consent, budgets, deadlines, concurrency, the circuit breaker,
 * replay and receipts, so a provider only turns a bounded question into
 * probabilities. Only explicit decide calls with enabled, disclosure-approved
 * configuration and a bound provider perform I/O.
 */
export function createRouterGuard(options: RouterGuardOptions): RouterPort {
  const repo = options.repository;
  const clock = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const inFlight = new Map<AbortController, string>();
  const cache = new Map<string, { expiresAt: number; answer: DecisionAnswer }>();
  const circuits = new Map<string, { failures: number; until: number }>();
  const pendingDecisions = new Set<Promise<unknown>>();
  let disposed = false;
  let epoch = 0;
  const disable = (): void => {
    epoch++;
    for (const controller of inFlight.keys()) controller.abort();
    cache.clear();
  };
  const limitsOf = (settings: RouterSettings): RouterProviderLimits => ({
    maxRequestBytes: settings.maxRequestBytes,
    maxResponseBytes: settings.maxResponseBytes,
    requestTokenCap: settings.requestTokenCap,
  });
  const measure = (provider: RouterProvider, request: Omit<RouterProviderRequest, "signal" | "checkpoint">): number => {
    const bytes: unknown = hook(() => provider.measure?.(frozen(request)));
    if (bytes === undefined) return Buffer.byteLength(JSON.stringify({ prompts: request.prompts, candidates: request.candidates }));
    // A size the guard cannot compare would silently skip every request bound.
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) throw new HookFailure("invalid");
    return bytes;
  };

  /**
   * `group` names the non-batched calls a provider without batching makes for
   * one turn's surfaces: they share it as `batchDecisionId` and count as one
   * turn admission.
   */
  const decide = async (input: RouterDecisionInput, batch?: BatchContext, group?: string): Promise<RouterReceipt> => {
    const started = clock();
    const config = await repo.configuration(input.scope);
    const settings = config.settings;
    const startEpoch = epoch;
    const candidates = input.candidates.map((candidate) => RouterCandidateSchema.parse(candidate));
    const fingerprint = sha256Hex(JSON.stringify({ prompt: input.prompt, candidates }));
    const base: RouterReceipt = {
      decisionId: newId(),
      operationId: input.operationId,
      taskId: input.fence.taskId,
      turnId: input.turnId,
      feature: input.feature,
      mode: settings.modes[input.feature],
      configRevision: config.revision,
      policyVersion: settings.policyVersion,
      providerId: settings.provider,
      ...(group === undefined ? {} : { batchDecisionId: group }),
      candidateHash: fingerprint,
      permissionRevision: input.permissionRevision,
      ...(batch === undefined ? {} : { batchedFeatures: [...batch.features] }),
      state: "finished",
      reason: "off",
      selectedIds: [],
      probabilities: {},
      cacheHit: false,
      elapsedMs: 0,
      startedAt: new Date(started).toISOString(),
    };
    const current = async (): Promise<boolean> =>
      !disposed &&
      epoch === startEpoch &&
      !input.signal.aborted &&
      (await input.isCurrent()) &&
      (await repo.configuration(input.scope)).revision === config.revision;
    const local = (reason: RouterReceipt["reason"]): RouterReceipt => ({
      ...base,
      reason,
      elapsedMs: Math.max(0, clock() - started),
      finishedAt: new Date(clock()).toISOString(),
    });
    if (disposed || !settings.enabled || base.mode === "off") return local("off");
    if (!(await current())) return local("stale");
    if (
      !settings.egress.taskText ||
      (input.feature === "memory" && !settings.egress.memoryExcerpts) ||
      (input.feature === "skills" && !settings.egress.skillMetadata) ||
      (input.feature === "tools" && !settings.egress.toolDescriptions)
    )
      return local("egress");
    const existing = await repo.decision(input.scope, input.fence.taskId, input.operationId);
    if (existing !== undefined) {
      if (
        existing.providerId !== settings.provider ||
        existing.feature !== input.feature ||
        existing.turnId !== input.turnId ||
        existing.candidateHash !== fingerprint ||
        existing.configRevision !== config.revision ||
        existing.permissionRevision !== input.permissionRevision ||
        !(await current())
      )
        return local("stale");
      return existing.state === "finished" && input.beforeDecision === undefined ? existing : local("uncertain");
    }
    if (candidates.length === 0) return local("no-candidates");
    if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) return local("invalid");
    const spentMs = (await repo.receipts(input.scope, input.fence.taskId))
      .filter((receipt) => receipt.turnId === input.turnId)
      .reduce((sum, receipt) => sum + receipt.elapsedMs, 0);
    const remaining = settings.deadlineMs - spentMs - (clock() - started);
    if (remaining <= 0) return local("deadline");
    const providerId = settings.provider;
    const provider = options.slot.get(providerId);
    const configured = providerSettings(settings);
    // A provider is asked only about the features it declares.
    if (
      provider === undefined ||
      (provider.features !== undefined && !(batch?.features ?? [input.feature]).every((feature) => provider.features?.includes(feature)))
    )
      return local("provider");
    const key = sha256Hex(
      JSON.stringify({
        scope: input.scope,
        taskId: input.fence.taskId,
        provider: providerId,
        providerSettings: configured,
        revision: config.revision,
        policy: settings.policyVersion,
        permission: input.permissionRevision,
        feature: input.feature,
        fingerprint,
      }),
    );
    const cached = cache.get(key);
    if (input.beforeDecision === undefined && cached !== undefined && cached.expiresAt > clock()) {
      if (!(await current())) return local("stale");
      const pending = { ...base, state: "pending" as const };
      if (!(await repo.reserve(input.scope, input.fence, pending, 0))) return local("budget");
      const receipt = RouterReceiptSchema.parse({ ...local("cache"), ...cached.answer, cacheHit: true });
      await repo.finish(input.scope, input.fence, receipt, 0);
      cache.delete(key);
      cache.set(key, cached);
      return receipt;
    }
    cache.delete(key);
    const circuitKey = JSON.stringify([input.scope, providerId, config.revision, configured]);
    const circuit = circuits.get(circuitKey);
    if (circuit !== undefined && circuit.until > clock()) return local("circuit");
    if ([...inFlight.values()].filter((workspaceId) => workspaceId === input.scope.workspaceId).length >= settings.concurrency)
      return local("concurrency");
    // Provider hooks run before any reservation: a throw abstains, it never escapes.
    const fromHook = (error: unknown): RouterReceipt => {
      if (error instanceof HookFailure) return local(error.reason);
      throw error;
    };
    let unavailable: RouterProviderFailure | undefined;
    try {
      const reported: unknown = hook(() => provider.unavailable?.(configured));
      unavailable = reported === undefined ? undefined : (routerProviderFailure({ reason: reported }) ?? "invalid");
    } catch (error) {
      return fromHook(error);
    }
    if (unavailable !== undefined) return local(unavailable);
    const price = await options.accounting.price(provider.pricing.connectionId, provider.pricing.model, base.startedAt);
    if (price === undefined || settings.priceRevision !== price.revision) return local("budget");
    const limits = limitsOf(settings);
    // A built-in provider sets its own worst case; any other is charged the host's.
    const ownCost = provider.maxCostUsd !== undefined;
    let maximumUsd: number | undefined;
    try {
      maximumUsd = ownCost ? hook(() => provider.maxCostUsd?.(price, limits)) : hostReservation(price, limits);
    } catch (error) {
      return fromHook(error);
    }
    // Reported usage from a provider without its own worst case is advisory: missing, malformed or above the reservation, the reservation is charged.
    const settle = (cost: number | undefined): number | undefined =>
      ownCost || maximumUsd === undefined ? cost : cost === undefined ? maximumUsd : Math.min(cost, maximumUsd);
    if (maximumUsd === undefined) return local("budget");
    const prompt = scrubCredentialText(input.prompt);
    const prompts: Partial<Record<RouterFeature, string>> =
      batch === undefined
        ? { [input.feature]: prompt }
        : Object.fromEntries(batch.features.map((feature) => [feature, scrubCredentialText(batch.prompts[feature] ?? "")]));
    const tag = (candidate: RouterCandidate): RouterCandidate & { feature: RouterFeature } => ({
      ...candidate,
      description: scrubCredentialText(candidate.description),
      feature: batch?.featureOf.get(candidate.id) ?? input.feature,
    });
    const features = batch?.features ?? [input.feature];
    let shortlist = lexicalCandidates(prompt, candidates, input.feature === "model" ? candidates.length : settings.maxQuestions).map(tag);
    const request = (): Omit<RouterProviderRequest, "signal" | "checkpoint"> => ({
      features,
      prompts,
      candidates: shortlist,
      settings: configured,
      limits,
    });
    try {
      let bytes = measure(provider, request());
      while (bytes > settings.maxRequestBytes && input.feature !== "model" && shortlist.length > 1) {
        shortlist = shortlist.slice(0, -1);
        bytes = measure(provider, request());
      }
      if (
        bytes > settings.maxRequestBytes ||
        bytes > Math.min(settings.requestTokenCap, 32_000) ||
        (input.feature === "model" && shortlist.length > 32)
      )
        return local("invalid");
    } catch (error) {
      return fromHook(error);
    }
    const lease = options.slot.acquire(providerId);
    if (lease === undefined) return local("provider");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, input.signal, lease.signal]);
    inFlight.set(controller, input.scope.workspaceId);
    const callId = newId();
    const pending: RouterReceipt = { ...base, state: "pending", callId };
    let reserved = false;
    let dispatched = false;
    let accounted = false;
    let usage: ModelUsage = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const abort = (): void => controller.abort();
    try {
      reserved = await repo.reserve(input.scope, input.fence, pending, maximumUsd);
      if (!reserved) return local("budget");
      await options.accounting.begin({
        callId,
        runId: input.fence.taskId,
        attemptId: callId,
        ownerSession: input.fence.ownerSession,
        connectionId: provider.pricing.connectionId,
        model: provider.pricing.model,
        purpose: "router",
        startedAt: base.startedAt,
        priceRevision: price.revision,
      });
      accounted = true;
      const timeout = new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError());
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(abort, Math.max(1, settings.deadlineMs - spentMs - (clock() - started)));
      });
      const answer = await Promise.race([
        timeout,
        (async () => {
          if (input.beforeDecision !== undefined && !(await input.beforeDecision())) throw new HostAbstain("no-candidates");
          if (signal.aborted || !(await current())) throw abortError();
          const checkpoint = async (): Promise<void> => {
            signal.throwIfAborted();
            if (!(await current())) throw abortError();
            // Policy validation now crosses the database queue. Cancellation can
            // arrive while it is pending; recheck immediately before dispatch.
            signal.throwIfAborted();
            if (clock() - started + spentMs >= settings.deadlineMs) {
              abort();
              signal.throwIfAborted();
            }
            dispatched = true;
          };
          // The provider sees a frozen copy and is validated against the host's own shortlist.
          let returned: unknown;
          try {
            returned = await provider.classify({ ...frozen(request()), signal, checkpoint });
          } catch (error) {
            // A provider failure never escapes the guard: an unknown throw is a transport failure.
            const thrown = providerThrow(error);
            if (thrown.usage !== undefined) usage = thrown.usage;
            throw thrown.reason === "abort" ? abortError() : new ProviderFailure(thrown.reason);
          }
          signal.throwIfAborted();
          const read = readAnswer(
            returned,
            input.feature,
            shortlist,
            settings.featureThresholds[input.feature] ?? settings.threshold,
            settings.maxResponseBytes,
          );
          usage = read.usage;
          return read.answer;
        })(),
      ]);
      const isCurrent = await current();
      const receipt = RouterReceiptSchema.parse({
        ...local(isCurrent ? (answer.selectedIds.length === 0 ? "threshold" : "selected") : "stale"),
        ...(isCurrent ? answer : {}),
        callId,
      });
      const cost = settle(estimateModelCost(usage, price));
      await options.accounting.finish(callId, "completed", usage, receipt.finishedAt ?? base.startedAt);
      accounted = false;
      await repo.finish(input.scope, input.fence, receipt, cost);
      reserved = false;
      circuits.delete(circuitKey);
      if (isCurrent) {
        cache.set(key, { expiresAt: clock() + 300_000, answer: structuredClone(answer) });
        while (cache.size > 256) {
          const first = cache.keys().next();
          if (!first.done) cache.delete(first.value);
        }
      }
      return receipt;
    } catch (error) {
      if (!dispatched) usage = { inputTokens: 0, outputTokens: 0 };
      else if (error instanceof HostInvalid && Object.keys(error.usage).length > 0) usage = error.usage;
      const failure =
        error instanceof HostAbstain || error instanceof HostInvalid || error instanceof ProviderFailure
          ? error.reason
          : routerProviderFailure(error);
      // An unbound provider is neither a timeout nor a failure: it must not trip the circuit.
      const reason = !(await current())
        ? "stale"
        : lease.signal.aborted
          ? "provider"
          : signal.aborted
            ? "deadline"
            : (failure ?? "transport");
      const receipt = { ...local(reason), ...(reserved ? { callId } : {}) };
      if (accounted)
        await options.accounting.finish(callId, dispatched ? "uncertain" : "failed", usage, receipt.finishedAt ?? base.startedAt);
      if (reserved) await repo.finish(input.scope, input.fence, receipt, dispatched ? settle(estimateModelCost(usage, price)) : 0);
      // Host callbacks (eligibility, repositories) keep failing loudly; provider failures were classified above.
      if (!signal.aborted && failure === undefined && !isAbort(error)) throw error;
      if (reason === "credentials") circuits.set(circuitKey, { failures: 1, until: Infinity });
      else if (reason === "transport" || reason === "invalid" || reason === "deadline") {
        const failures = (circuits.get(circuitKey)?.failures ?? 0) + 1;
        circuits.set(circuitKey, { failures, until: failures >= 3 ? clock() + 30_000 : 0 });
      }
      while (circuits.size > 256) {
        const first = circuits.keys().next();
        if (!first.done) circuits.delete(first.value);
      }
      return receipt;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      controller.abort();
      inFlight.delete(controller);
      lease.release();
    }
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pendingDecisions.add(promise);
    void promise.then(
      () => pendingDecisions.delete(promise),
      () => pendingDecisions.delete(promise),
    );
    return promise;
  };
  const port: RouterPort = {
    // The effective configuration: with the selected provider not running,
    // routing is off, so every consumer takes its baseline path rather than
    // routing on abstentions (tool shortlists, discovery, disclosures).
    configuration: async (scope) => {
      const config = await repo.configuration(scope);
      if (!config.settings.enabled) return config;
      const provider = options.slot.get(config.settings.provider);
      if (provider === undefined) return { ...config, settings: { ...config.settings, enabled: false } };
      // A feature the provider does not declare is off too: its consumers take the unrouted path.
      const declared = provider.features;
      if (declared === undefined) return config;
      const mode = (feature: RouterFeature) => (declared.includes(feature) ? config.settings.modes[feature] : ("off" as const));
      return {
        ...config,
        settings: {
          ...config.settings,
          modes: { model: mode("model"), memory: mode("memory"), tools: mode("tools"), skills: mode("skills") },
        },
      };
    },
    disable,
    async dispose() {
      disposed = true;
      disable();
      await Promise.allSettled(pendingDecisions);
      circuits.clear();
    },
    decide: (input) => track(decide(input)),
    decideBatch: (inputs) =>
      track(
        (async () => {
          if (inputs.length === 0) return [];
          const first = inputs[0];
          if (first === undefined) throw new TaviError("INVALID_INPUT", "Missing batch input");
          if (
            inputs.length > 3 ||
            inputs.some(
              (input) =>
                input.feature === "model" ||
                input.beforeDecision !== undefined ||
                JSON.stringify([input.scope, input.fence, input.turnId]) !== JSON.stringify([first.scope, first.fence, first.turnId]),
            ) ||
            new Set(inputs.map((input) => input.feature)).size !== inputs.length
          )
            throw new TaviError("INVALID_INPUT", "Router batch must contain distinct non-model surfaces from one task and turn");
          const config = await repo.configuration(first.scope);
          const batchEpoch = epoch;
          const batchIsCurrent = async () =>
            !disposed && epoch === batchEpoch && (await repo.configuration(first.scope)).revision === config.revision;
          const provider = options.slot.get(config.settings.provider);
          let eligible = inputs.filter(
            (input) =>
              config.settings.enabled &&
              config.settings.modes[input.feature] !== "off" &&
              config.settings.egress.taskText &&
              (input.feature === "tools"
                ? config.settings.egress.toolDescriptions
                : input.feature === "memory"
                  ? config.settings.egress.memoryExcerpts
                  : config.settings.egress.skillMetadata) &&
              input.candidates.length > 0 &&
              new Set(input.candidates.map((candidate) => candidate.id)).size === input.candidates.length &&
              // A surface the provider does not declare stays out of the shared payload, and abstains alone.
              (provider?.features === undefined || provider.features.includes(input.feature)),
          );
          const batchOperation = (members: readonly RouterDecisionInput[]) =>
            sha256Hex(JSON.stringify(["batch-v1", members.map((input) => [input.feature, input.operationId])]));
          // Recover projections from an already reserved batch before considering
          // a different grouping. A saved feature operation is never sent again.
          if ((await repo.decision(first.scope, first.fence.taskId, batchOperation(eligible))) === undefined) {
            const pending: RouterDecisionInput[] = [];
            for (const input of eligible) {
              if ((await repo.decision(input.scope, input.fence.taskId, input.operationId)) === undefined) pending.push(input);
            }
            eligible = pending;
          }
          if (eligible.length < 2 || provider === undefined) return Promise.all(inputs.map((input) => port.decide(input)));
          if (!provider.supportsBatch) {
            // One call per surface, made in turn and admitted as one: the surfaces
            // share a group id, so the turn's call limit counts them once.
            const group = sha256Hex(JSON.stringify(["group-v1", eligible.map((input) => [input.feature, input.operationId])]));
            const grouped = new Map<RouterDecisionInput, RouterReceipt>();
            for (const input of eligible) grouped.set(input, await track(decide(input, undefined, group)));
            return Promise.all(inputs.map((input) => grouped.get(input) ?? port.decide(input)));
          }
          const anchor = eligible[0];
          if (anchor === undefined) throw new TaviError("INVALID_INPUT", "Missing batch anchor");
          const results = new Map<RouterDecisionInput, RouterReceipt>();
          // Off/denied surfaces remain isolated and never enter the shared payload.
          for (const input of inputs.filter((input) => !eligible.includes(input))) results.set(input, await port.decide(input));
          const prompts = Object.fromEntries(eligible.map((input) => [input.feature, input.prompt]));
          const prompt = JSON.stringify(prompts);
          const features = eligible.map((input) => input.feature);
          const limits = limitsOf(config.settings);
          const bound = Math.min(config.settings.maxRequestBytes, config.settings.requestTokenCap, 32_000);
          const pools = eligible.map((input) =>
            lexicalCandidates(
              input.prompt,
              input.candidates.map((candidate) => RouterCandidateSchema.parse(candidate)),
              config.settings.maxQuestions,
            ),
          );
          const candidates: (RouterCandidate & { feature: RouterFeature })[] = [];
          const identities = new Map<string, { input: RouterDecisionInput; id: string }>();
          const size = (entries: readonly (RouterCandidate & { feature: RouterFeature })[]) =>
            measure(provider, { features, prompts, candidates: entries, settings: providerSettings(config.settings), limits });
          // Round-robin allocation gives each surface space before adding extras.
          // A provider whose measure fails gets individual decisions, which abstain on their own.
          try {
            for (let rank = 0; rank < config.settings.maxQuestions && candidates.length < config.settings.maxQuestions; rank++) {
              for (const [group, input] of eligible.entries()) {
                const candidate = pools[group]?.[rank];
                if (candidate === undefined || candidates.length >= config.settings.maxQuestions) continue;
                const id = `g${group}q${rank}`;
                let description = `${input.feature} ${candidate.id}: ${candidate.description}`.slice(0, 2000);
                let entry = { id, revision: candidate.revision, description, feature: input.feature };
                while (size([...candidates, entry]) > bound && description.length > 32) {
                  description = description.slice(0, Math.floor(description.length / 2));
                  entry = { ...entry, description };
                }
                if (size([...candidates, entry]) > bound) continue;
                candidates.push(entry);
                identities.set(id, { input, id: candidate.id });
              }
            }
          } catch (error) {
            if (!(error instanceof HookFailure)) throw error;
            const decided = await Promise.all(eligible.map((input) => port.decide(input)));
            eligible.forEach((input, index) => {
              const receipt = decided[index];
              if (receipt !== undefined) results.set(input, receipt);
            });
            return inputs.map((input) => results.get(input) ?? missingProjection());
          }
          const operationId = batchOperation(eligible);
          const receipt = await decide(
            {
              ...anchor,
              operationId,
              prompt,
              candidates: candidates.map(({ feature: _feature, ...candidate }) => candidate),
              permissionRevision: sha256Hex(JSON.stringify(eligible.map((input) => input.permissionRevision))),
              signal: AbortSignal.any(eligible.map((input) => input.signal)),
              isCurrent: async () =>
                (await batchIsCurrent()) &&
                (await Promise.all(eligible.map(async (input) => !input.signal.aborted && (await input.isCurrent())))).every(Boolean),
            },
            { features, prompts, featureOf: new Map(candidates.map((candidate) => [candidate.id, candidate.feature])) },
          );
          const persisted = await repo.decision(first.scope, first.fence.taskId, operationId);
          for (const input of eligible) {
            const candidateHash = sha256Hex(JSON.stringify({ prompt: input.prompt, candidates: input.candidates }));
            const existing = await repo.decision(input.scope, input.fence.taskId, input.operationId);
            if (existing !== undefined) {
              if (
                existing.providerId === config.settings.provider &&
                existing.feature === input.feature &&
                existing.turnId === input.turnId &&
                existing.candidateHash === candidateHash &&
                existing.configRevision === config.revision &&
                existing.permissionRevision === input.permissionRevision &&
                existing.state === "finished" &&
                (await batchIsCurrent()) &&
                (await input.isCurrent()) &&
                !input.signal.aborted
              )
                results.set(input, existing);
              else
                results.set(input, {
                  ...receipt,
                  operationId: input.operationId,
                  feature: input.feature,
                  mode: config.settings.modes[input.feature],
                  selectedIds: [],
                  probabilities: {},
                  reason: "uncertain",
                });
              continue;
            }
            const probabilities = Object.fromEntries(
              Object.entries(receipt.probabilities).flatMap(([id, probability]) => {
                const identity = identities.get(id);
                return identity?.input === input ? [[identity.id, probability]] : [];
              }),
            );
            const fresh = (await batchIsCurrent()) && !input.signal.aborted && (await input.isCurrent());
            const selectedIds = fresh
              ? Object.keys(probabilities).filter(
                  (id) => (probabilities[id] ?? 0) >= (config.settings.featureThresholds[input.feature] ?? config.settings.threshold),
                )
              : [];
            const { callId: _callId, batchedFeatures: _features, ...shared } = receipt;
            const projected: RouterReceipt = {
              ...shared,
              decisionId: newId(),
              operationId: input.operationId,
              feature: input.feature,
              mode: config.settings.modes[input.feature],
              candidateHash,
              permissionRevision: input.permissionRevision,
              selectedIds,
              probabilities: fresh ? probabilities : {},
              elapsedMs: 0,
              ...(persisted?.decisionId === receipt.decisionId ? { batchDecisionId: receipt.decisionId } : {}),
              reason: !fresh
                ? "stale"
                : Object.keys(probabilities).length === 0
                  ? receipt.reason
                  : selectedIds.length > 0
                    ? "selected"
                    : "threshold",
            };
            // One transport reservation/elapsed duration owns the batch; projections
            // cost no additional calls and preserve each consumer's durable identity.
            if (
              projected.batchDecisionId !== undefined &&
              (await repo.reserve(input.scope, input.fence, { ...projected, state: "pending" }, 0))
            )
              await repo.finish(input.scope, input.fence, projected, 0);
            results.set(input, projected);
          }
          return inputs.map((input) => results.get(input) ?? missingProjection());
        })(),
      ),
  };
  return port;
}
