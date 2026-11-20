import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";
import { TaviError } from "./errors.js";
import { IdSchema, TimestampSchema } from "./ids.js";
import { ModelTargetSchema, type ModelTarget } from "./models-config.js";
import type { ModelPriceSheet } from "./model-accounting.js";
import { MAX_MODEL_TOOLS, type ModelUsage } from "./model.js";
import { defineProviderError } from "./util.js";

export const ROUTER_FEATURES = ["model", "memory", "tools", "skills"] as const;
export const RouterFeatureSchema = z.enum(ROUTER_FEATURES);
export type RouterFeature = z.infer<typeof RouterFeatureSchema>;
export const RouterModeSchema = z.enum(["off", "shadow", "active"]);
export type RouterMode = z.infer<typeof RouterModeSchema>;
export const RouterScopeSchema = z.strictObject({ workspaceId: IdSchema, principalId: IdSchema });
export type RouterScope = z.infer<typeof RouterScopeSchema>;
export const RouterFenceSchema = z.strictObject({ taskId: IdSchema, generation: z.number().int().positive(), ownerSession: IdSchema });
export type RouterFence = z.infer<typeof RouterFenceSchema>;
const usd = z.number().finite().nonnegative().max(1_000_000);

/** The built-in routing provider's plugin id (`@tavi/plugin-router`); the provider selected when settings name none. */
export const JEV_PROVIDER_ID = "tavi.router";

const settingsFields = {
  enabled: z.boolean().default(false),
  modes: z
    .strictObject({
      model: RouterModeSchema.default("off"),
      memory: RouterModeSchema.default("off"),
      tools: RouterModeSchema.default("off"),
      skills: RouterModeSchema.default("off"),
    })
    .default({ model: "off", memory: "off", tools: "off", skills: "off" }),
  egress: z
    .strictObject({ taskText: z.boolean(), toolDescriptions: z.boolean(), skillMetadata: z.boolean(), memoryExcerpts: z.boolean() })
    .default({ taskText: false, toolDescriptions: false, skillMetadata: false, memoryExcerpts: false }),
  /** Built-in providers' settings by plugin id; each provider's own schema is applied where it is configured (`routerProviderSettings`). */
  providerSettings: z.record(IdSchema, z.record(z.string(), z.unknown())).default({}),
  policyVersion: z.string().min(1).max(64).default("v1"),
  deadlineMs: z.number().int().min(1).max(10_000).default(1_500),
  callsPerTurn: z.number().int().min(1).max(4).default(2),
  callsPerTask: z.number().int().min(1).max(100).default(20),
  concurrency: z.number().int().min(1).max(8).default(2),
  maxRequestBytes: z.number().int().min(256).max(65_536).default(16_384),
  maxResponseBytes: z.number().int().min(256).max(1_048_576).default(262_144),
  maxQuestions: z.number().int().min(1).max(32).default(32),
  requestTokenCap: z.number().int().min(1).max(64_000).default(64_000),
  maxTaskUsd: usd.default(0.05),
  maxWorkspaceUsd: usd.default(5),
  priceRevision: IdSchema.optional(),
  threshold: z.number().min(0).max(1).default(0.9),
  featureThresholds: z
    .strictObject({
      model: z.number().min(0).max(1).optional(),
      memory: z.number().min(0).max(1).optional(),
      tools: z.number().min(0).max(1).optional(),
      skills: z.number().min(0).max(1).optional(),
    })
    .default({}),
};

/** Router settings. */
export const RouterSettingsSchema = z.strictObject({
  ...settingsFields,
  /** The routing provider's plugin id: a built-in, or an installed external plugin that declares one. */
  provider: IdSchema.default(JEV_PROVIDER_ID),
});

/**
 * Settings submitted to `configure`. They are the same as router settings, except that a
 * document which names no `provider` keeps the current one: the settings default
 * (`tavi.router`) must not silently move routing back to Jev when a partial file is reapplied.
 */
export const RouterSettingsSubmissionSchema = z.strictObject({
  ...settingsFields,
  provider: IdSchema.optional(),
});
export type RouterSettings = z.infer<typeof RouterSettingsSchema>;

/** What a built-in provider's readiness reads: no provider request is made. */
export interface RouterReadinessDependencies {
  readonly readSecret: (reference: string) => Promise<string | null>;
  readonly price: (connectionId: string, model: string, at: string) => ModelPriceSheet | undefined | Promise<ModelPriceSheet | undefined>;
  /** The router settings' pinned price revision. */
  readonly priceRevision: string | undefined;
  readonly requestTokenCap: number;
  readonly now: string;
}

/**
 * What the owner knows of a built-in routing provider without running it,
 * offline as in an owner: its settings' schema (kept under
 * `providerSettings[id]`), the price sheet it is charged under, whether a
 * sheet prices it, and its readiness. A built-in plugin declares it; the
 * router's commands and `doctor` name no provider of their own.
 */
export interface BuiltinRouterProvider {
  readonly id: string;
  readonly settings: z.ZodType<Record<string, unknown>>;
  readonly pricing: { readonly connectionId: string; readonly model: string };
  priceUsable(price: ModelPriceSheet): boolean;
  readiness(
    settings: Readonly<Record<string, unknown>>,
    deps: RouterReadinessDependencies,
  ): Promise<Readonly<Record<string, string | boolean>>>;
}

/**
 * `settings.providerSettings` checked against the built-in providers: each
 * built-in's entry parsed by its schema (its defaults filled), and any other
 * provider's entry empty, since an external provider takes its settings from
 * its plugin config. Throws `INVALID_INPUT` naming each problem.
 */
export function routerProviderSettings<
  T extends { readonly providerSettings: Readonly<Record<string, Readonly<Record<string, unknown>>>> },
>(settings: T, builtins: readonly BuiltinRouterProvider[]): T {
  const providerSettings: Record<string, Record<string, unknown>> = {};
  const problems: string[] = [];
  for (const [id, value] of Object.entries(settings.providerSettings)) {
    const builtin = builtins.find((provider) => provider.id === id);
    if (builtin === undefined) {
      if (Object.keys(value).length > 0)
        problems.push(`${id} is not a built-in routing provider; an external provider takes its settings from its plugin config`);
      continue;
    }
    const parsed = builtin.settings.safeParse(value);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        problems.push(`providerSettings.${[id, ...issue.path.map(String)].join(".")}: ${issue.message}`);
    else providerSettings[id] = parsed.data;
  }
  if (problems.length > 0) throw new TaviError("INVALID_INPUT", problems.join("; "));
  return { ...settings, providerSettings };
}
export const RouterConfigurationSchema = z.strictObject({ revision: z.number().int().nonnegative(), settings: RouterSettingsSchema });
export type RouterConfiguration = z.infer<typeof RouterConfigurationSchema>;

export const RouterCandidateSchema = z.strictObject({
  id: IdSchema,
  revision: z.string().min(1).max(128),
  description: z.string().max(2_000),
});
export type RouterCandidate = z.infer<typeof RouterCandidateSchema>;
export const RouterReceiptSchema = z.strictObject({
  decisionId: IdSchema,
  operationId: IdSchema,
  taskId: IdSchema,
  turnId: IdSchema,
  feature: RouterFeatureSchema,
  mode: RouterModeSchema,
  /** The provider that answered or was selected. */
  providerId: IdSchema,
  configRevision: z.number().int().nonnegative(),
  policyVersion: z.string().min(1).max(64),
  candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  permissionRevision: z.string().min(1).max(128),
  state: z.enum(["pending", "finished", "uncertain"]),
  reason: z.enum([
    "selected",
    "off",
    "egress",
    "budget",
    "deadline",
    "concurrency",
    "circuit",
    "credentials",
    "transport",
    "invalid",
    "stale",
    "uncertain",
    "no-candidates",
    "cache",
    "threshold",
    "provider",
  ]),
  selectedIds: z.array(IdSchema).max(64),
  probabilities: z.record(z.string().max(128), z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1).optional(),
  /** Batch transport receipts own the charge; per-feature receipts link to them. */
  batchedFeatures: z.array(RouterFeatureSchema).min(2).max(3).optional(),
  batchDecisionId: IdSchema.optional(),
  cacheHit: z.boolean(),
  elapsedMs: z.number().finite().nonnegative(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  callId: IdSchema.optional(),
});
export type RouterReceipt = z.infer<typeof RouterReceiptSchema>;

export const TaskRouteSchema = z.strictObject({
  taskId: IdSchema,
  target: ModelTargetSchema,
  fallback: z.array(ModelTargetSchema).max(3),
  origin: z.enum(["explicit", "baseline", "router"]),
  configRevision: z.number().int().nonnegative(),
  decisionId: IdSchema.optional(),
  createdAt: TimestampSchema,
});
export type TaskRoute = z.infer<typeof TaskRouteSchema>;
export const ToolDisclosureSchema = z.strictObject({
  taskId: IdSchema,
  attemptId: IdSchema,
  tools: z.array(z.strictObject({ id: IdSchema, revision: z.string().min(1).max(128) })).max(MAX_MODEL_TOOLS),
  createdAt: TimestampSchema,
});
export type ToolDisclosure = z.infer<typeof ToolDisclosureSchema>;

const memoryRef = z.strictObject({ recordId: IdSchema, revisionId: IdSchema });
const skillRef = z.strictObject({ skillId: IdSchema, version: z.string().min(1).max(64) });
export const ContextProjectionSnapshotSchema = z.strictObject({
  taskId: IdSchema,
  attemptId: IdSchema,
  turnId: IdSchema,
  configRevision: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  memoryCandidates: z.array(memoryRef).max(32),
  memoryExposed: z.array(memoryRef).max(1024),
  retrievalCoverage: z.enum(["complete", "partial", "unavailable"]),
  recommendedSkills: z.array(skillRef).max(1024),
  exposedSkills: z.array(skillRef).max(1024),
});
export type ContextProjectionSnapshot = z.infer<typeof ContextProjectionSnapshotSchema>;

export interface RouterDecisionInput {
  readonly scope: RouterScope;
  readonly fence: RouterFence;
  readonly operationId: string;
  readonly turnId: string;
  readonly feature: RouterFeature;
  readonly permissionRevision: string;
  readonly prompt: string;
  readonly candidates: readonly RouterCandidate[];
  readonly signal: AbortSignal;
  /** Optional bounded host eligibility check, run inside the decision deadline before dispatch. */
  readonly beforeDecision?: () => Promise<boolean>;
  /** Rechecks host authority and candidate revisions, including after a cache hit. */
  readonly isCurrent: () => boolean | Promise<boolean>;
}

/** Provider-independent decision service; selections never grant host permissions. */
export interface RouterPort {
  configuration(scope: RouterScope): Promise<RouterConfiguration>;
  decide(input: RouterDecisionInput): Promise<RouterReceipt>;
  /** Batch ready non-model surfaces from one task/turn; model admission remains separate. */
  decideBatch?(inputs: readonly RouterDecisionInput[]): Promise<readonly RouterReceipt[]>;
  /** Cancels in-flight decisions; persisted settings are changed by the owner separately. */
  disable(): void;
  dispose(): Promise<void>;
}

/** Why a provider could not answer. Classified by shape, so plugins need no `@tavi` import. */
// Frozen: plugins receive this very array, and emptying it would unclassify every failure.
export const ROUTER_PROVIDER_FAILURES = Object.freeze(["transport", "invalid", "credentials"] as const);
export type RouterProviderFailure = (typeof ROUTER_PROVIDER_FAILURES)[number];
export class RouterProviderError extends defineProviderError<RouterProviderFailure>() {
  /** Usage the provider was billed for before failing, when it knows it. */
  readonly usage: ModelUsage | undefined;
  constructor(reason: RouterProviderFailure, usage?: ModelUsage) {
    super(reason);
    this.usage = usage;
  }
}
/** The failure a thrown value carries, whatever class it has; undefined when it carries none. */
export function routerProviderFailure(error: unknown): RouterProviderFailure | undefined {
  // A plugin's thrown value may be a Proxy or carry a throwing getter: reading it must not throw.
  try {
    if (error === null || typeof error !== "object" || !("reason" in error)) return undefined;
    const reason = (error as { reason: unknown }).reason;
    return ROUTER_PROVIDER_FAILURES.find((failure) => failure === reason);
  } catch {
    return undefined;
  }
}

export interface RouterProviderLimits {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly requestTokenCap: number;
}

/**
 * One bounded question for a routing provider. The host has already applied
 * modes, disclosure consent, budgets and shortlisting; the provider only
 * answers. It never receives the scope, task or any host store.
 */
export interface RouterProviderRequest {
  /** One feature, or 2–3 distinct non-model features for a batched call. */
  readonly features: readonly RouterFeature[];
  /** Per-feature task text, scrubbed, in `features` order. */
  readonly prompts: Readonly<Partial<Record<RouterFeature, string>>>;
  /** Scrubbed, shortlisted, unique ids; batch ids are opaque and remapped by the host. */
  readonly candidates: readonly (RouterCandidate & { readonly feature: RouterFeature })[];
  /** This scope's provider settings (built-in providers); `{}` for external providers. */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly limits: RouterProviderLimits;
  /** Fires at the host deadline, on disable, or when the provider is unbound. */
  readonly signal: AbortSignal;
  /** Await immediately before sending data anywhere; rejects when the decision is no longer current. */
  readonly checkpoint: () => Promise<void>;
}

export interface RouterProviderAnswer {
  /** Keyed by candidate id. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** The chosen candidate; the model feature only. */
  readonly choice?: string;
  readonly confidence?: number;
  readonly usage?: ModelUsage;
}

/** A routing provider. Selections never grant host permissions. */
export interface RouterProvider {
  /** Price-sheet identity for reservations and accounting. */
  readonly pricing: { readonly connectionId: string; readonly model: string };
  readonly supportsBatch: boolean;
  /** The features the provider may be asked about; all of them when absent (built-in providers). */
  readonly features?: readonly RouterFeature[];
  /** Built-in providers only: worst-case USD for one request under this sheet, or undefined to abstain. */
  maxCostUsd?(price: ModelPriceSheet, limits: RouterProviderLimits): number | undefined;
  /** Bytes the provider would send for this request, so the host can fit it before reserving. */
  measure?(request: Omit<RouterProviderRequest, "signal" | "checkpoint">): number;
  /** A local precondition that fails before any reservation (for example no credential configured). */
  unavailable?(settings: Readonly<Record<string, unknown>>): RouterProviderFailure | undefined;
  classify(request: RouterProviderRequest): Promise<RouterProviderAnswer>;
  /** Readiness for `tavi router status`; must not call the network or reveal secrets. */
  status?(settings: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, string | boolean>>>;
}

/** A model chosen for chats, and how many chats chose it. */
export interface ChosenModelTarget extends ModelTarget {
  readonly chats: number;
}

/** Host-owned durable boundary. No raw candidate descriptions or task text are stored here. */
interface RouterRepositoryPortDefinition {
  configureWithPrices(
    scope: RouterScope,
    input: RouterSettings,
    expectedRevision: number,
    prices: readonly ModelPriceSheet[],
  ): RouterConfiguration;
  recoverPreviousOwner(ownerSession: string, at: string): number;
  selections(): readonly {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly provider: string;
    readonly enabled: boolean;
    readonly priceRevision?: string;
  }[];
  configuration(scope: RouterScope): RouterConfiguration;
  configure(scope: RouterScope, settings: RouterSettings, expectedRevision: number): RouterConfiguration;
  decision(scope: RouterScope, taskId: string, operationId: string): RouterReceipt | undefined;
  reserve(scope: RouterScope, fence: RouterFence, receipt: RouterReceipt, maximumUsd: number): boolean;
  finish(scope: RouterScope, fence: RouterFence, receipt: RouterReceipt, actualUsd?: number): void;
  receipts(scope: RouterScope, taskId: string): readonly RouterReceipt[];
  spent(scope: RouterScope, taskId?: string): number;
  route(scope: RouterScope, taskId: string): TaskRoute | undefined;
  saveRoute(scope: RouterScope, fence: RouterFence, route: TaskRoute): TaskRoute;
  /**
   * A person's choice of model for a chat: replaces whatever route the task has
   * with `target` alone (origin `explicit`), which its next turn runs — a
   * turn already running keeps the chain it began with. Not fenced — a choice
   * is the chat's, not an execution's.
   */
  chooseRoute(scope: RouterScope, taskId: string, target: ModelTarget, at: string): TaskRoute;
  /** The models people chose for their chats in this scope (routes of origin `explicit`), with how many chats chose each. */
  chosenTargets(scope: RouterScope): readonly ChosenModelTarget[];
  disclosure(scope: RouterScope, taskId: string, attemptId: string): ToolDisclosure | undefined;
  contextProjections(scope: RouterScope, taskId: string): readonly ContextProjectionSnapshot[];
  saveContextProjection(scope: RouterScope, fence: RouterFence, projection: ContextProjectionSnapshot): void;
  saveDisclosure(scope: RouterScope, fence: RouterFence, disclosure: ToolDisclosure): void;
}

/** Host policy for task-local routing. The workflow supplies its assembled request bound. */
export interface TaskRoutingPort {
  effectiveTarget?(scope: RouterScope, taskId: string): Promise<{ connectionId: string; model: string } | undefined>;
  /**
   * Set a chat's model: `target`, if a configured connection offers it, is what
   * the task's next turn runs, and every one after it. Refused
   * `NOT_CONFIGURED` for a target no connection can serve.
   */
  choose?(scope: RouterScope, taskId: string, target: ModelTarget): Promise<TaskRoute>;
  /**
   * Whether `choose` would take `target`: a configured connection offers it —
   * its catalog lists the model, or nothing was discovered on it yet — and the
   * catalog does not mark it unavailable.
   */
  accepts?(scope: RouterScope, target: ModelTarget): Promise<boolean>;
  /**
   * The chain a turn with no saved route runs, as configured now — the
   * default's target, then its fallback — so a changed default reaches the
   * next turn. `undefined`: the target the workflow was composed with.
   */
  baseline?(scope: RouterScope): Promise<readonly ModelTarget[] | undefined>;
  prepare(input: {
    readonly scope: RouterScope;
    readonly fence: RouterFence;
    readonly turnId: string;
    readonly newTask: boolean;
    readonly explicit: boolean;
    readonly interactive: boolean;
    readonly prompt: string;
    readonly requestBytes: number;
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean | Promise<boolean>;
  }): Promise<TaskRoute | undefined>;
}

export type RouterRepositoryPort = AsyncRepository<RouterRepositoryPortDefinition>;
