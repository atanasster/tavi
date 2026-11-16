import { MODEL_PROVIDER_PRESETS, keyPageOf, type ModelProviderPreset } from "./models-config.js";
import {
  ONBOARDING_ABI,
  OnboardingFlowSchema,
  type OnboardingFlow,
  type OnboardingFlowStep,
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

/** How to start each local server when it isn't running. */
const START_LOCAL: Readonly<Record<string, string>> = {
  ollama: "Ollama isn't running: start it with `ollama serve`.",
  lmstudio: "LM Studio's server isn't running: start it in LM Studio (Developer → Start server), or with `lms server start`.",
};

/** The advice for `code`, worded for the connection it happened on. */
export function verifyAdvice(code: VerifyAdviceCode, context: VerifyAdviceContext = {}): string {
  const preset = presetNamed(context.preset);
  const provider = preset?.name ?? "The provider";
  const model = context.model ?? "this model";
  switch (code) {
    case "auth":
      return preset === undefined
        ? "The key was refused. Check it, or create a new one."
        : `The key was refused. Check it, or create a new one at ${keyPageOf(preset)}.`;
    case "quota_exceeded":
      return `${provider} refused for quota or billing. Check the account's credits and limits, then try again.`;
    case "rate_limit":
      return `${provider} is rate-limiting this key. Wait a minute, then try again.`;
    case "model_unavailable":
      return `This account can't use ${model}. Pick another.`;
    case "model_retired":
      return `${model} has been retired. Pick another.`;
    case "invalid_request":
      return `${provider} refused the request for ${model}. Pick another model, or check the endpoint.`;
    case "unreachable":
      if (preset !== undefined && preset.localOnly)
        return START_LOCAL[preset.id] ?? `${preset.name} isn't running. Start it, then try again.`;
      return `Tavi couldn't reach ${preset?.name ?? "the provider"}${context.baseUrl === undefined ? "" : ` at ${context.baseUrl}`}. Check the address and your network.`;
    case "timeout":
      return `${provider} didn't answer within ${String(Math.round((context.timeoutMs ?? 20_000) / 1000))} seconds. Try again, or pick a smaller model.`;
    case "no-tools":
      return "This model can chat but didn't call a tool. Tavi needs tools for most tasks: pick another model if you can.";
    case "provider":
      return `${provider} failed. Try again, or pick another model.`;
  }
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
      /^openai\/gpt-5(\.\d+)?$/u,
      /^google\/gemini-[\d.]+-pro/u,
      /^anthropic\/claude-opus/u,
      /^qwen\/qwen3/u,
    ],
    fast: [
      /^anthropic\/claude-haiku/u,
      /^openai\/gpt-5(\.\d+)?-mini/u,
      /^google\/gemini-[\d.]+-flash(?!-lite)/u,
      /^openai\/gpt-4\.1-mini/u,
    ],
  },
  openai: {
    main: [/^gpt-5(\.\d+)?$/u, /^gpt-4\.1$/u, /^o\d$/u],
    fast: [/^gpt-5(\.\d+)?-mini$/u, /^gpt-4\.1-mini$/u, /^gpt-5(\.\d+)?-nano$/u],
  },
  anthropic: {
    main: [/^claude-sonnet/u, /^claude-opus/u],
    fast: [/^claude-haiku/u],
  },
  gemini: {
    main: [/^(models\/)?gemini-[\d.]+-pro/u],
    fast: [/^(models\/)?gemini-[\d.]+-flash(?!-lite)/u, /^(models\/)?gemini-[\d.]+-flash-lite/u],
  },
  ollama: LOCAL_TABLE,
  lmstudio: LOCAL_TABLE,
};

/** Newest first: the higher version number in the name wins (`claude-sonnet-4.5` before `claude-sonnet-4`), then the name. */
const newestFirst = (left: string, right: string): number => right.localeCompare(left, "en", { numeric: true });

/** Dated snapshots (`-2025-04-14`) and previews lose to the plain alias of the same family. */
const plainFirst = (left: string, right: string): number => {
  const pinned = (model: string) => (/-\d{4}-?\d{2}-?\d{2}|preview|exp/iu.test(model) ? 1 : 0);
  return pinned(left) - pinned(right);
};

function ranked(table: readonly RegExp[], models: readonly string[]): string[] {
  const out: string[] = [];
  for (const pattern of table) {
    const matches = models.filter((model) => pattern.test(model) && !out.includes(model));
    out.push(...[...matches].sort(newestFirst).sort(plainFirst));
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

/** The `main` and `fast` models to propose for a connection of `preset`, from what it discovered. */
export function suggestRoles(preset: string, discovered: readonly string[]): RoleSuggestion {
  const chat = [...new Set(discovered)].filter((model) => !isEmbeddingModel(model));
  const table = ROLE_TABLES[preset];
  const local = preset === "ollama" || preset === "lmstudio";
  const usable = local ? chat.filter(toolCapableFamily) : chat;
  const mains = table === undefined ? [] : ranked(table.main, usable);
  const fasts = table === undefined ? [] : ranked(table.fast, usable);
  const rest = (local && usable.length > 0 ? usable : chat).filter((model) => !mains.includes(model)).sort();
  const candidates = [...mains, ...rest].slice(0, 5);
  const main = candidates[0];
  const fast = fasts.find((model) => model !== main);
  return { ...(main === undefined ? {} : { main }), ...(fast === undefined ? {} : { fast }), candidates };
}
