import { coreEnglish, type CoreKey, type CoreT } from "./locales/core.js";
import { clip } from "./util.js";
import { daysBetween, LIFECYCLE_WARNING_DAYS, type ModelLifecycle } from "./model-lifecycle.js";
import { MODEL_PROVIDER_PRESETS, keyPageOf, type ModelProviderPreset } from "./models-config.js";
import { CORE_EN } from "./locales/core-en.js";
import {
  fastModelFailure,
  ONBOARDING_ABI,
  ONBOARDING_STEP_DETAIL_MAX,
  OnboardingFlowSchema,
  type OnboardingFlow,
  type OnboardingDetailText,
  type OnboardingFlowStep,
  type OnboardingStepStatus,
  type OnboardingStepKind,
  type OnboardingSurface,
} from "./onboarding.js";

/*
 * Setup's shared reading of a model and a flow: the verify step's advice, a
 * flow's steps on a surface, and which discovered models the model step
 * proposes. The host's onboarding reads them, and a flow provider may use
 * them as they are (`@tavi/plugin-kit/onboarding` names them for it).
 */

/**
 * Plain advice for a failed verify: what the
 * person can do next, never the provider's raw error. The codes are the model
 * adapter's `ModelError` codes, plus the few a connection test reports
 * otherwise (it could not connect, it ran out of time, the model never called
 * the probe tool).
 */
export const VERIFY_ADVICE_CODES = [
  "auth",
  "quota_exceeded",
  "rate_limit",
  "model_unavailable",
  "model_retired",
  "invalid_request",
  "unreachable",
  "timeout",
  "no-tools",
  "provider",
] as const;
export type VerifyAdviceCode = (typeof VERIFY_ADVICE_CODES)[number];

/** The lasting codes: a real turn failing with one marks the model failed; the rest may pass. */
export const LASTING_VERIFY_CODES: readonly VerifyAdviceCode[] = [
  "auth",
  "quota_exceeded",
  "model_unavailable",
  "model_retired",
  "invalid_request",
];

export interface VerifyAdviceContext {
  /** The preset the connection was made from, by id; absent for one made by hand. */
  readonly preset?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** The verify deadline the failure ran out of, for the timeout advice. */
  readonly timeoutMs?: number;
}

const presetNamed = (id: string | undefined): ModelProviderPreset | undefined =>
  id === undefined ? undefined : MODEL_PROVIDER_PRESETS.find((preset) => preset.id === id);

/** How to start each local server when it isn't running, by preset id. */
const START_LOCAL: Readonly<Record<string, CoreKey>> = {
  ollama: "onboarding.advice.startOllama",
  lmstudio: "onboarding.advice.startLmStudio",
};

/** A `core` key and its parameters: a message said in whichever language the reader's surface speaks. */
export interface CoreText {
  readonly key: CoreKey;
  readonly params?: Readonly<Record<string, string>>;
}

/** The advice for `code` as a key and its parameters, worded for the connection it happened on. */
export function verifyAdviceText(code: VerifyAdviceCode, context: VerifyAdviceContext = {}): CoreText {
  const preset = presetNamed(context.preset);
  const provider = preset === undefined ? {} : { provider: preset.name };
  const model = context.model === undefined ? {} : { model: context.model };
  // Each sentence once with the provider or model named, once without: "The provider" and "this model" are words, not data.
  const named = (key: CoreKey, any: CoreKey, params: Readonly<Record<string, string>>): CoreText =>
    preset === undefined ? { key: any, params } : { key, params: { ...provider, ...params } };
  switch (code) {
    case "auth":
      return preset === undefined
        ? { key: "onboarding.advice.auth" }
        : { key: "onboarding.advice.authAt", params: { page: keyPageOf(preset) } };
    case "quota_exceeded":
      return named("onboarding.advice.quota", "onboarding.advice.quotaAny", {});
    case "rate_limit":
      return named("onboarding.advice.rateLimit", "onboarding.advice.rateLimitAny", {});
    case "model_unavailable":
      return context.model === undefined
        ? { key: "onboarding.advice.modelUnavailableAny" }
        : { key: "onboarding.advice.modelUnavailable", params: model };
    case "model_retired":
      return context.model === undefined
        ? { key: "onboarding.advice.modelRetiredAny" }
        : { key: "onboarding.advice.modelRetired", params: model };
    case "invalid_request":
      return context.model === undefined
        ? named("onboarding.advice.invalidRequestAnyModel", "onboarding.advice.invalidRequestAny", {})
        : named("onboarding.advice.invalidRequest", "onboarding.advice.invalidRequestAnyProvider", model);
    case "unreachable": {
      if (preset !== undefined && preset.localOnly) {
        const start = START_LOCAL[preset.id];
        return start === undefined ? { key: "onboarding.advice.startLocal", params: provider } : { key: start };
      }
      return context.baseUrl === undefined
        ? named("onboarding.advice.unreachable", "onboarding.advice.unreachableAny", {})
        : named("onboarding.advice.unreachableAt", "onboarding.advice.unreachableAnyAt", { url: context.baseUrl });
    }
    case "timeout":
      return named("onboarding.advice.timeout", "onboarding.advice.timeoutAny", {
        seconds: String(Math.round((context.timeoutMs ?? 20_000) / 1000)),
      });
    case "no-tools":
      return { key: "onboarding.advice.noTools" };
    case "provider":
      return named("onboarding.advice.failed", "onboarding.advice.failedAny", {});
  }
}

/** The advice for `code`, worded for the connection it happened on. */
export function verifyAdvice(code: VerifyAdviceCode, context: VerifyAdviceContext = {}, t: CoreT = coreEnglish): string {
  const { key, params } = verifyAdviceText(code, context);
  return t(key, params);
}

const isCoreKey = (key: string): key is CoreKey => Object.hasOwn(CORE_EN, key);

/** A detail message in `t`'s language, each parameter that is a message of its own said first; undefined for a key this build lacks. */
function detailIn(text: OnboardingDetailText, t: CoreT): string | undefined {
  if (!isCoreKey(text.key)) return undefined;
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(text.params ?? {})) {
    if (typeof value !== "object") params[name] = value;
    else if (isCoreKey(value.key)) params[name] = t(value.key, value.params);
    else return undefined;
  }
  return t(text.key, params);
}

/**
 * A step's detail in `t`'s language: its `detailText` when it has one this
 * build knows, else the owner's English `detail`; cut as the owner cuts it.
 */
export function onboardingStepDetail(step: Pick<OnboardingStepStatus, "detail" | "detailText">, t: CoreT = coreEnglish): string {
  const said = step.detailText === undefined ? undefined : detailIn(step.detailText, t);
  return said === undefined ? step.detail : clip(said, ONBOARDING_STEP_DETAIL_MAX);
}

/** `fastModelFailure` in `t`'s language: the advice after a failed fast model, from the step's `detailText` when it carries it. */
export function fastModelFailureIn(
  step: Pick<OnboardingStepStatus, "state" | "detail" | "detailText"> | undefined,
  t: CoreT = coreEnglish,
): string | undefined {
  const english = fastModelFailure(step);
  const fast = step?.detailText?.params?.["fast"];
  if (english === undefined || fast === undefined || typeof fast !== "object") return english;
  return detailIn(fast, t) ?? english;
}

/** What a failure says of itself, as far as a connection test reports it. */
export interface VerifyFailure {
  /** The adapter's `ModelError` code, when the failure carried one. */
  readonly modelCode?: string;
  readonly status?: number;
  /** The test's scrubbed message (`<TaviError code>: <message>`). */
  readonly message?: string;
}

/** The advice code for a failed verify: the adapter's own code when it has one, else read from the status and message. */
export function classifyVerifyFailure(failure: VerifyFailure): VerifyAdviceCode {
  const known = (VERIFY_ADVICE_CODES as readonly string[]).includes(failure.modelCode ?? "")
    ? (failure.modelCode as VerifyAdviceCode)
    : undefined;
  const status = failure.status;
  const message = failure.message ?? "";
  const unknownModel = status === 404 || /\b404\b|model[_ ]not[_ ]found|unknown model|no such model|does not exist/iu.test(message);
  // The adapter files a 404 for the model as a refused request: the person needs to hear it is the model.
  if (known === "invalid_request" && unknownModel) return "model_unavailable";
  if (known !== undefined && known !== "provider") return known;
  if (status === 401 || status === 403 || /\bNOT_AUTHORIZED\b|\b40[13]\b|unauthori[sz]ed|invalid api key|incorrect api key/iu.test(message))
    return "auth";
  if (status === 402 || /\b402\b|quota|billing|insufficient (credits|funds|balance)/iu.test(message)) return "quota_exceeded";
  if (status === 429 || /\b429\b|rate.?limit/iu.test(message)) return "rate_limit";
  if (unknownModel) return "model_unavailable";
  if (/exceeded \d+ ?ms|timed? ?out|\bETIMEDOUT\b/iu.test(message)) return "timeout";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connection refused|fetch failed|getaddrinfo|socket hang up/iu.test(message)) return "unreachable";
  return "provider";
}

/**
 * Helpers for writing a flow. The host checks
 * every flow anyway and falls back to the built-in one on any error; these let
 * a provider find a mistake at build time instead.
 */

export type OnboardingFlowInput = Omit<OnboardingFlow, "abi"> & { readonly abi?: OnboardingFlow["abi"] };

/** A flow checked against the contract (its schema, unique ids, one step per kind), with the ABI filled in. */
export function defineOnboardingFlow(flow: OnboardingFlowInput): OnboardingFlow {
  return OnboardingFlowSchema.parse({ abi: ONBOARDING_ABI, ...flow });
}

/** Whether `step` is shown on `surface` (absent `surfaces`: both). */
export function stepOnSurface(step: OnboardingFlowStep, surface: OnboardingSurface): boolean {
  return step.surfaces === undefined || step.surfaces.includes(surface);
}

/** The flow's steps for one surface, in order. */
export function stepsFor(flow: OnboardingFlow, surface: OnboardingSurface): readonly OnboardingFlowStep[] {
  return flow.steps.filter((step) => stepOnSurface(step, surface));
}

/** What a step's `featured` may name now, by kind: presets, channel kinds or app ids; undefined for a kind that features nothing. */
export function availableFor(
  kind: OnboardingStepKind,
  available: { readonly presets: readonly string[]; readonly channels: readonly string[]; readonly apps: readonly string[] },
): readonly string[] | undefined {
  return kind === "model" ? available.presets : kind === "channels" ? available.channels : kind === "apps" ? available.apps : undefined;
}

/** `step` featuring only what is in `available`, and recommending only what it still features. */
export function withAvailableFeatured(step: OnboardingFlowStep, available: readonly string[] | undefined): OnboardingFlowStep {
  if (available === undefined || step.featured === undefined) return step;
  const featured = step.featured.filter((id) => available.includes(id));
  const { featured: _featured, recommended, ...rest } = step;
  return { ...rest, featured, ...(recommended !== undefined && featured.includes(recommended) ? { recommended } : {}) };
}

/** The step kinds a flow version offers on a surface: what a newer version is compared against. */
export function stepKinds(flow: OnboardingFlow, surface: OnboardingSurface): readonly OnboardingStepKind[] {
  return stepsFor(flow, surface).map((step) => step.kind);
}

/**
 * Which discovered models the model step proposes for `main` and `fast`,
 * and which local models can call tools. Suggestions only: the person can
 * always pick another, and the
 * verify step's tool probe is what proves a model works.
 */

/** Embedding models answer no chat: never proposed, never counted as tool-capable. */
const EMBEDDING = [/embed/iu, /^bge[-:]/iu, /^all-minilm/iu, /(^|\/)text-embedding/iu, /rerank/iu];

/** Whether `model` is an embedding (or reranking) model. */
export function isEmbeddingModel(model: string): boolean {
  return EMBEDDING.some((pattern) => pattern.test(model));
}

/**
 * Local model families Ollama marks as tool-capable, for an Ollama too old to
 * report `capabilities` from `POST /api/show`. The name is matched without its
 * tag (`qwen3:8b` is `qwen3`) and without a namespace (`library/…`).
 */
const TOOL_CAPABLE_FAMILIES = [
  /^llama3\.[1-3]/u,
  /^(meta-)?llama-3\.[1-3]/u,
  /^llama4/u,
  /^(meta-)?llama-4/u,
  /^qwen-?2\.5/u,
  /^qwen-?3/u,
  /^qwq/u,
  /^mistral(-nemo|-small[\d.]*|-large[\d.]*)?$/u,
  /^mixtral/u,
  /^ministral/u,
  /^devstral/u,
  /^magistral/u,
  /^command-r/u,
  /^command-a/u,
  /^firefunction/u,
  /^hermes3/u,
  /^granite3/u,
  /^granite4/u,
  /^gpt-oss/u,
  /^deepseek-r1/u,
  /^deepseek-v3/u,
  /^nemotron/u,
  /^cogito/u,
  /^smollm2/u,
  /^phi4-mini/u,
  /^athene-v2/u,
  /^kimi-k2/u,
  /^glm-4/u,
];

/** Whether a local model's family is known to call tools, from its name alone. */
export function toolCapableFamily(model: string): boolean {
  if (isEmbeddingModel(model)) return false;
  const family = (model.split("/").pop() ?? model).split(":")[0]?.toLowerCase() ?? "";
  return TOOL_CAPABLE_FAMILIES.some((pattern) => pattern.test(family));
}

interface RoleTable {
  readonly main: readonly RegExp[];
  readonly fast: readonly RegExp[];
}

/** Local servers run the same open models. */
const LOCAL_TABLE: RoleTable = {
  main: [/^qwen3(?!.*:(0\.6|1\.7)b)/u, /^gpt-oss/u, /^llama3\.[13]/u, /^mistral-small/u, /^devstral/u],
  fast: [/^qwen3.*:(1\.7|4)b/u, /^llama3\.2/u, /^qwen2\.5.*:(1\.5|3)b/u, /^phi4-mini/u],
};

/** Per preset, the families to propose, best first. The newest matching model of a family wins. */
const ROLE_TABLES: Readonly<Record<string, RoleTable>> = {
  openrouter: {
    main: [
      /^anthropic\/claude-sonnet/u,
      /^openai\/gpt-\d+(\.\d+)?-sol$/u,
      /^openai\/gpt-5(\.\d+)?$/u,
      /^google\/gemini-\d+(\.\d+)?-(carbon|argon)$/u,
      /^google\/gemini-[\d.]+-pro/u,
      /^anthropic\/claude-opus/u,
      /^qwen\/qwen3/u,
    ],
    fast: [
      /^anthropic\/claude-haiku/u,
      /^openai\/gpt-\d+(\.\d+)?-luna$/u,
      /^openai\/gpt-5(\.\d+)?-mini/u,
      /^google\/gemini-[\d.]+-flash(?!-lite)/u,
      /^openai\/gpt-4\.1-mini/u,
    ],
  },
  // GPT-6 names its tiers: astra (largest), sol, terra, luna (smallest). Sol is the Sonnet-priced tier.
  openai: {
    main: [/^gpt-\d+(\.\d+)?-sol$/u, /^gpt-\d+(\.\d+)?-terra$/u, /^gpt-5(\.\d+)?$/u, /^gpt-4\.1$/u],
    fast: [/^gpt-\d+(\.\d+)?-luna$/u, /^gpt-5(\.\d+)?-mini$/u, /^gpt-4\.1-mini$/u],
  },
  anthropic: {
    main: [/^claude-sonnet/u, /^claude-opus/u],
    fast: [/^claude-haiku/u],
  },
  // Gemini 4 names its models, not its tiers: carbon and argon are the Pro-priced ones.
  gemini: {
    main: [/^(models\/)?gemini-\d+(\.\d+)?-(carbon|argon)$/u, /^(models\/)?gemini-[\d.]+-pro/u],
    fast: [/^(models\/)?gemini-[\d.]+-flash(?!-lite)/u, /^(models\/)?gemini-[\d.]+-flash-lite/u],
  },
  ollama: LOCAL_TABLE,
  lmstudio: LOCAL_TABLE,
};

/** Newest first: the higher version number in the name wins (`claude-sonnet-4.5` before `claude-sonnet-4`), then the name. */
const newestFirst = (left: string, right: string): number => right.localeCompare(left, "en", { numeric: true });

/**
 * A model's name without what pins or varies it: a dated snapshot (`-2025-04-14`), a preview or
 * experiment (`-preview-customtools`), or an OpenRouter variant (`:batch`, `:free`). A local tag
 * with a size in it (`qwen3:8b`) is the model itself and stays.
 */
const baseOf = (model: string): string =>
  model
    .replace(/:[a-z-]+$/iu, "")
    .replace(/-\d{4}-?\d{2}-?\d{2}.*$/u, "")
    .replace(/-(preview|exp)\b.*$/iu, "");

/**
 * Newest version first; of one version, the plain alias before its snapshots, previews and
 * variants. A preview of a newer version still beats an older plain one: the older one is
 * the one a provider retires first.
 */
const byRank = (left: string, right: string): number => {
  const version = newestFirst(baseOf(left), baseOf(right));
  if (version !== 0) return version;
  const pinned = (model: string) => (baseOf(model) === model ? 0 : 1);
  return pinned(left) - pinned(right) || newestFirst(left, right);
};

function ranked(table: readonly RegExp[], models: readonly string[]): string[] {
  const out: string[] = [];
  for (const pattern of table) {
    const matches = models.filter((model) => pattern.test(model) && !out.includes(model));
    out.push(...[...matches].sort(byRank));
  }
  return out;
}

export interface RoleSuggestion {
  /** Absent only when nothing chat-capable was discovered. */
  readonly main?: string;
  /** Absent when the connection offers nothing smaller: `fast` then falls back to `main`. */
  readonly fast?: string;
  /** The top candidates for `main`, best first, at most five: the CLI's list before "Other…". */
  readonly candidates: readonly string[];
}

/**
 * Whether a lifecycle says not to propose a model for a new role: retired,
 * deprecated, closed to new users, or redirected or retiring within
 * {@link LIFECYCLE_WARNING_DAYS} (an undated redirect counts as now) — the
 * same horizon at which the model warns. A model with no lifecycle, or
 * `unknown`, is proposed as before.
 */
export function avoidForNewRole(lifecycle: ModelLifecycle | undefined, today: string): boolean {
  if (lifecycle === undefined) return false;
  const soon = (date: string | undefined): boolean => date !== undefined && daysBetween(today, date) <= LIFECYCLE_WARNING_DAYS;
  return (
    lifecycle.status === "retired" ||
    lifecycle.status === "deprecated" ||
    (lifecycle.redirect !== undefined && (lifecycle.redirect.on === undefined || soon(lifecycle.redirect.on))) ||
    (lifecycle.closedToNewOn !== undefined && lifecycle.closedToNewOn <= today) ||
    soon(lifecycle.retiresOn)
  );
}

/** A catalog's stored lifecycles by model id, as `models show` carries them; `undefined` when none is stored. */
export function lifecycleByModel(
  catalog: readonly { readonly modelId: string; readonly lifecycle?: ModelLifecycle | undefined }[],
): ReadonlyMap<string, ModelLifecycle> | undefined {
  const rows = catalog.flatMap((row) => (row.lifecycle === undefined ? [] : [[row.modelId, row.lifecycle] as const]));
  return rows.length === 0 ? undefined : new Map(rows);
}

/**
 * The `main` and `fast` models to propose for a connection of `preset`, from
 * what it discovered. With `lifecycle` (what a sync stored, by model id), a
 * model {@link avoidForNewRole} names is left out of each ranked list, unless
 * that would empty the list: a role's best-ranked choice is never traded for an
 * unranked model by the catalog alone.
 */
export function suggestRoles(
  preset: string,
  discovered: readonly string[],
  options: { readonly lifecycle?: ReadonlyMap<string, ModelLifecycle>; readonly today?: string } = {},
): RoleSuggestion {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const lifecycle = options.lifecycle;
  // A `:batch` variant answers later, through a batch job: never a chat's model.
  const chat = [...new Set(discovered)].filter((model) => !isEmbeddingModel(model) && !/:batch$/u.test(model));
  // Avoided models leave a list only when something is left in it.
  const keep = (models: readonly string[]): string[] => {
    if (lifecycle === undefined) return [...models];
    const current = models.filter((model) => !avoidForNewRole(lifecycle.get(model), today));
    return current.length === 0 ? [...models] : current;
  };
  const table = ROLE_TABLES[preset];
  const local = preset === "ollama" || preset === "lmstudio";
  const usable = local ? chat.filter(toolCapableFamily) : chat;
  const mains = table === undefined ? [] : keep(ranked(table.main, usable));
  const fasts = table === undefined ? [] : keep(ranked(table.fast, usable));
  const rest = keep((local && usable.length > 0 ? usable : chat).filter((model) => !mains.includes(model))).sort();
  const candidates = [...mains, ...rest].slice(0, 5);
  const main = candidates[0];
  const fast = fasts.find((model) => model !== main);
  return { ...(main === undefined ? {} : { main }), ...(fast === undefined ? {} : { fast }), candidates };
}
