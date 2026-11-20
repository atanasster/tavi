import { totalmem } from "node:os";

import { ModelPriceSheetSchema, presetOf, type ModelPriceSheet } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { freeBytesAt } from "../../shared/disk.js";

/**
 * `tavi models suggest`: suggestions from the model resolver
 * (https://rhumbdata.com), never a change.
 *
 * With `RESOLVER_KEY` set it asks the resolver two things over plain HTTP:
 * the best local model on the operator's local runtimes that fits this
 * machine (`/v1/resolve`), and price sheets for the models on the operator's
 * cloud connections (`/v1/models`). It only prints them: the owner decides,
 * and installs a price sheet with `tavi router configure`. With no key, or on
 * any failure, it suggests nothing and tavi behaves exactly as it does without
 * it. The key and the request never reach a log; no prompt is ever sent.
 */

const RESOLVER_URL_DEFAULT = "https://rhumbdata.com";
export const RESOLVER_KEY_HINT = "Set RESOLVER_KEY to a model resolver key to get model suggestions; nothing was changed.";

/** Each resolver call's deadline: a suggestion is never worth a long wait. */
const RESOLVER_TIMEOUT_MS = 2_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** `/v1/models` pages read at most: 5 × 500 offerings covers the cloud providers' catalogs. */
const MODELS_PAGE_SIZE = 500;
const MODELS_MAX_PAGES = 5;
/** An agent turn carries tools and a long system prompt: the context a local model must hold. */
const LOCAL_MIN_CONTEXT = 32_768;
/** Share of the machine's memory a local model may use, leaving room for the OS and tavi. */
const LOCAL_MEMORY_SHARE = 0.75;

/** Runtimes on the device, in the resolver's provider vocabulary. */
const LOCAL_RUNTIMES: ReadonlySet<string> = new Set(["ollama", "lmstudio", "llama.cpp", "mlx", "webllm"]);
/** Cloud providers tavi has presets for, by the same names in the resolver's vocabulary. */
const CLOUD_PROVIDERS: ReadonlySet<string> = new Set(["openrouter", "openai", "anthropic", "gemini"]);

/** A connection as the suggestion reads it: where it points and the models it is known to have. */
export interface SuggestConnection {
  readonly connectionId: string;
  readonly baseUrl: string;
  /** Its catalog's model ids and its default model. */
  readonly models: readonly string[];
}

/** The machine's limits for a local model, in GB (10^9 bytes). */
export interface MachineLimits {
  readonly memoryGb: number;
  /** Known only for unified memory (Apple silicon), where GPU memory is the same memory. */
  readonly vramGb?: number;
  readonly diskGb?: number;
}

interface LocalModelSuggestion {
  readonly connectionId: string;
  readonly provider: string;
  readonly model: string;
  readonly providerModelId: string;
  readonly quantization?: string;
  readonly requirements?: { readonly memoryGb: number; readonly vramGb?: number; readonly diskGb?: number };
  readonly reason?: string;
}

export interface ModelSuggestions {
  readonly catalogVersion: string | null;
  readonly machine: MachineLimits;
  /** `null` when there is no local runtime connected, nothing fits, or the resolver did not answer. */
  readonly localModel: LocalModelSuggestion | null;
  /** In the form `tavi router configure` installs under `priceSheets`. */
  readonly priceSheets: readonly ModelPriceSheet[];
  /** What was not suggested, and why: never a key or a prompt. */
  readonly notes: readonly string[];
}

export interface SuggestDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly machine?: MachineLimits;
}

/** The machine's limits: three quarters of its memory, free disk under the data directory, and unified GPU memory. */
export function machineLimits(dataDirectory: string): MachineLimits {
  const memoryGb = Math.floor((totalmem() / 1e9) * LOCAL_MEMORY_SHARE);
  const freeBytes = freeBytesAt(dataDirectory);
  return {
    memoryGb,
    // Apple silicon shares its memory with the GPU; elsewhere GPU memory is not read, so it is not sent.
    ...(process.platform === "darwin" && process.arch === "arm64" ? { vramGb: memoryGb } : {}),
    ...(freeBytes === undefined ? {} : { diskGb: Math.floor(freeBytes / 1e9) }),
  };
}

/** Whether the resolver is configured; with no key nothing is asked. */
export function resolverKeyOf(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const key = env["RESOLVER_KEY"]?.trim();
  return key === undefined || key === "" ? undefined : key;
}

/** The resolver's provider name for a connection, by its endpoint's preset; `undefined` for a custom endpoint. */
function providerOf(connection: SuggestConnection): string | undefined {
  const id = presetOf(connection.baseUrl)?.id;
  return id !== undefined && (LOCAL_RUNTIMES.has(id) || CLOUD_PROVIDERS.has(id)) ? id : undefined;
}

/**
 * Suggest a local model and price sheets for these connections, or `undefined`
 * with no `RESOLVER_KEY` (the caller prints the hint). Never throws: a failed
 * call is a note, and its suggestion is left out.
 */
export async function suggestModels(
  connections: readonly SuggestConnection[],
  machine: MachineLimits,
  deps: SuggestDependencies = {},
): Promise<ModelSuggestions | undefined> {
  const env = deps.env ?? process.env;
  const key = resolverKeyOf(env);
  if (key === undefined) return undefined;
  const call = resolverCall(key, env["RESOLVER_URL"]?.trim() || RESOLVER_URL_DEFAULT, deps.fetch ?? globalThis.fetch);
  const notes: string[] = [];
  const unmapped = connections.filter((connection) => providerOf(connection) === undefined).map((connection) => connection.connectionId);
  if (unmapped.length > 0) notes.push(`not a known provider's endpoint, so not asked about: ${unmapped.join(", ")}`);

  const [local, prices] = await Promise.all([suggestLocal(connections, machine, call, notes), suggestPrices(connections, call, notes)]);
  return {
    catalogVersion: local.catalogVersion ?? prices.catalogVersion ?? null,
    machine,
    localModel: local.suggestion ?? null,
    priceSheets: prices.sheets,
    notes,
  };
}

type ResolverCall = (path: "/v1/resolve" | "/v1/models", query: Record<string, string>) => Promise<unknown>;

/** Answers kept for a day, by request; a stale one stands in when the resolver fails. */
const cache = new Map<string, { readonly at: number; readonly body: unknown }>();

/** Clears the answers kept in this process (tests). */
export function clearResolverCache(): void {
  cache.clear();
}

/** One resolver GET with a 2 s deadline and a day's cache; throws on any failure, with the status only. */
function resolverCall(key: string, base: string, fetchImpl: typeof globalThis.fetch): ResolverCall {
  return async (path, query) => {
    const url = `${base.replace(/\/+$/, "")}${path}?${new URLSearchParams(query).toString()}`;
    const hit = cache.get(url);
    if (hit !== undefined && Date.now() - hit.at < DAY_MS) return hit.body;
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(RESOLVER_TIMEOUT_MS),
      });
      if (!response.ok) {
        const code = await errorCodeOf(response);
        throw new Error(`the resolver answered ${response.status}${code === undefined ? "" : ` ${code}`}`);
      }
      const body: unknown = await response.json();
      cache.set(url, { at: Date.now(), body });
      return body;
    } catch (error) {
      if (hit !== undefined) return hit.body;
      throw error;
    }
  };
}

/** The resolver's error code (`no_candidate`, `unauthorized`), never its whole body. */
async function errorCodeOf(response: Response): Promise<string | undefined> {
  try {
    const code = ((await response.json()) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

interface ResolveAnswer {
  readonly catalog_version?: string;
  readonly reason?: string;
  readonly model?: {
    readonly id?: string;
    readonly provider?: string;
    readonly provider_model_id?: string;
    readonly quantization?: string;
    readonly requirements?: { readonly memory_gb?: number; readonly vram_gb?: number; readonly disk_gb?: number };
  };
}

async function suggestLocal(
  connections: readonly SuggestConnection[],
  machine: MachineLimits,
  call: ResolverCall,
  notes: string[],
): Promise<{ readonly suggestion?: LocalModelSuggestion; readonly catalogVersion?: string }> {
  const local = connections.filter((connection) => LOCAL_RUNTIMES.has(providerOf(connection) ?? ""));
  if (local.length === 0) {
    notes.push("no local runtime is connected (ollama, lmstudio), so no local model is suggested");
    return {};
  }
  const runtimes = [...new Set(local.map((connection) => providerOf(connection) as string))];
  let answer: ResolveAnswer;
  try {
    answer = (await call("/v1/resolve", {
      task: "text.chat",
      providers: runtimes.join(","),
      needs: "tools",
      optimize: "quality",
      min_context: String(LOCAL_MIN_CONTEXT),
      // Always sent: the resolver fits a local answer to the device only with them.
      max_memory_gb: String(machine.memoryGb),
      ...(machine.vramGb === undefined ? {} : { max_vram_gb: String(machine.vramGb) }),
      ...(machine.diskGb === undefined ? {} : { max_disk_gb: String(machine.diskGb) }),
    })) as ResolveAnswer;
  } catch (error) {
    notes.push(`no local model suggested: ${errorMessage(error)}`);
    return {};
  }
  const model = answer.model;
  const connection = local.find((candidate) => providerOf(candidate) === model?.provider);
  if (model?.provider === undefined || model.provider_model_id === undefined || connection === undefined) {
    notes.push("no local model suggested: the resolver's answer named no connected runtime");
    return answer.catalog_version === undefined ? {} : { catalogVersion: answer.catalog_version };
  }
  const requirements = model.requirements;
  return {
    ...(answer.catalog_version === undefined ? {} : { catalogVersion: answer.catalog_version }),
    suggestion: {
      connectionId: connection.connectionId,
      provider: model.provider,
      model: model.id ?? model.provider_model_id,
      providerModelId: model.provider_model_id,
      ...(model.quantization === undefined ? {} : { quantization: model.quantization }),
      ...(requirements?.memory_gb === undefined
        ? {}
        : {
            requirements: {
              memoryGb: requirements.memory_gb,
              ...(requirements.vram_gb === undefined ? {} : { vramGb: requirements.vram_gb }),
              ...(requirements.disk_gb === undefined ? {} : { diskGb: requirements.disk_gb }),
            },
          }),
      ...(answer.reason === undefined ? {} : { reason: answer.reason }),
    },
  };
}

interface ModelsPage {
  readonly catalog_version?: string;
  readonly total?: number;
  readonly models?: readonly {
    readonly offerings?: readonly {
      readonly provider?: string;
      readonly provider_model_id?: string;
      readonly price?: { readonly currency?: string; readonly per_1m?: Readonly<Record<string, string>>; readonly effective_from?: string };
    }[];
  }[];
}

type Offering = NonNullable<NonNullable<ModelsPage["models"]>[number]["offerings"]>[number];

async function suggestPrices(
  connections: readonly SuggestConnection[],
  call: ResolverCall,
  notes: string[],
): Promise<{ readonly sheets: readonly ModelPriceSheet[]; readonly catalogVersion?: string }> {
  const cloud = connections.filter((connection) => CLOUD_PROVIDERS.has(providerOf(connection) ?? ""));
  if (cloud.length === 0) {
    notes.push("no cloud provider is connected, so no price sheet is suggested");
    return { sheets: [] };
  }
  const providers = [...new Set(cloud.map((connection) => providerOf(connection) as string))];
  const offerings = new Map<string, Offering>();
  let catalogVersion: string | undefined;
  try {
    for (let page = 0; page < MODELS_MAX_PAGES; page += 1) {
      const answer = (await call("/v1/models", {
        providers: providers.join(","),
        limit: String(MODELS_PAGE_SIZE),
        offset: String(page * MODELS_PAGE_SIZE),
      })) as ModelsPage;
      catalogVersion ??= answer.catalog_version;
      const models = answer.models ?? [];
      for (const model of models)
        for (const offering of model.offerings ?? [])
          if (offering.provider !== undefined && offering.provider_model_id !== undefined)
            offerings.set(`${offering.provider}\u0000${offering.provider_model_id}`, offering);
      if (models.length < MODELS_PAGE_SIZE || (page + 1) * MODELS_PAGE_SIZE >= (answer.total ?? 0)) break;
    }
  } catch (error) {
    notes.push(`no price sheet suggested: ${errorMessage(error)}`);
    return { sheets: [] };
  }

  const sheets: ModelPriceSheet[] = [];
  const unpriced: string[] = [];
  for (const connection of cloud) {
    const provider = providerOf(connection) as string;
    for (const model of new Set(connection.models)) {
      const sheet = priceSheetOf(connection.connectionId, model, offerings.get(`${provider}\u0000${model}`), catalogVersion);
      if (sheet === undefined) unpriced.push(`${connection.connectionId}/${model}`);
      else sheets.push(sheet);
    }
  }
  if (unpriced.length > 0) notes.push(`no USD price in the catalog for: ${unpriced.join(", ")}`);
  return { sheets, ...(catalogVersion === undefined ? {} : { catalogVersion }) };
}

/**
 * A price sheet from an offering's USD prices per million tokens. A provider
 * with no cache prices charges cached input as input, so both cache rates
 * fall back to the input rate: never an underestimate.
 */
function priceSheetOf(
  connectionId: string,
  model: string,
  offering: Offering | undefined,
  catalogVersion: string | undefined,
): ModelPriceSheet | undefined {
  const price = offering?.price;
  if (price?.currency !== "USD" || price.per_1m === undefined) return undefined;
  const rate = (name: string): number | undefined => {
    const value = price.per_1m?.[name];
    const parsed = value === undefined ? Number.NaN : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const input = rate("input");
  const output = rate("output");
  if (input === undefined || output === undefined) return undefined;
  const effective = new Date(price.effective_from ?? "");
  const reasoning = rate("reasoning");
  const parsed = ModelPriceSheetSchema.safeParse({
    revision: `resolver-${catalogVersion ?? "unknown"}`.slice(0, 128),
    connectionId,
    model,
    effectiveAt: Number.isNaN(effective.getTime()) ? new Date().toISOString() : effective.toISOString(),
    currency: "USD",
    input,
    cacheRead: rate("cache_read") ?? input,
    cacheWrite: rate("cache_write_5m") ?? rate("cache_write_1h") ?? input,
    output,
    ...(reasoning === undefined ? {} : { reasoning }),
  });
  return parsed.success ? parsed.data : undefined;
}
