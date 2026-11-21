import { ModelLifecycleSchema, presetOf, type ModelLifecycle } from "@tavi/contracts";

/**
 * Tavi's client for Rhumb (https://rhumbdata.com), the model catalog behind
 * `tavi models suggest` and the model lifecycle sync. Plain HTTP GETs with a
 * deadline and a day's cache; the key travels only in the `Authorization`
 * header and never reaches a log. What is sent: provider names, a task and a
 * machine's limits; never a prompt, a credential or which models a connection
 * uses.
 */

const RHUMB_URL_DEFAULT = "https://rhumbdata.com";

/** Runtimes on the device, in Rhumb's provider vocabulary. */
export const LOCAL_RUNTIMES: ReadonlySet<string> = new Set(["ollama", "lmstudio", "llama.cpp", "mlx", "webllm"]);
/** Cloud providers tavi has presets for, by the same names in Rhumb's vocabulary. */
export const CLOUD_PROVIDERS: ReadonlySet<string> = new Set(["openrouter", "openai", "anthropic", "gemini"]);

/** `/v1/models` pages read at most: 5 × 500 offerings covers the cloud providers' catalogs. */
const MODELS_PAGE_SIZE = 500;
const MODELS_MAX_PAGES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Rhumb key: `RHUMB_KEY`, else `RESOLVER_KEY` (its old name); `undefined` when neither is set. */
export function rhumbKeyOf(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  for (const name of ["RHUMB_KEY", "RESOLVER_KEY"]) {
    const key = env[name]?.trim();
    if (key !== undefined && key !== "") return key;
  }
  return undefined;
}

/** Rhumb's base URL: `RESOLVER_URL` when set, else {@link RHUMB_URL_DEFAULT}. */
export function rhumbUrlOf(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env["RESOLVER_URL"]?.trim() || RHUMB_URL_DEFAULT;
}

/** Rhumb's provider name for an endpoint, by its preset; `undefined` for a custom endpoint. */
export function rhumbProviderOf(baseUrl: string): string | undefined {
  const id = presetOf(baseUrl)?.id;
  return id !== undefined && (LOCAL_RUNTIMES.has(id) || CLOUD_PROVIDERS.has(id)) ? id : undefined;
}

/** A model id as Rhumb lists it: Gemini's API may prefix its own with `models/`. */
export function rhumbModelId(provider: string, model: string): string {
  return provider === "gemini" ? model.replace(/^models\//u, "") : model;
}

export type RhumbCall = (path: "/v1/resolve" | "/v1/models", query: Record<string, string>) => Promise<unknown>;

/** Answers kept for a day, by request; a stale one stands in when Rhumb fails. */
const cache = new Map<string, { readonly at: number; readonly body: unknown }>();

/** Clears the answers kept in this process (tests). */
export function clearRhumbCache(): void {
  cache.clear();
}

/**
 * One Rhumb GET with a deadline and a day's cache; throws on any failure, with the status only.
 * `fresh` reads Rhumb every time and never stands an old answer in for a failure: what a
 * lifecycle sync stores as checked now must be now's. `signal` cancels the request.
 */
export function rhumbCall(
  key: string,
  base: string,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
  options: { readonly fresh?: boolean; readonly signal?: AbortSignal } = {},
): RhumbCall {
  return async (path, query) => {
    const url = `${base.replace(/\/+$/, "")}${path}?${new URLSearchParams(query).toString()}`;
    const hit = options.fresh === true ? undefined : cache.get(url);
    if (hit !== undefined && Date.now() - hit.at < DAY_MS) return hit.body;
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal:
          options.signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal]),
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

/** Rhumb's error code (`no_candidate`, `unauthorized`), never its whole body. */
async function errorCodeOf(response: Response): Promise<string | undefined> {
  try {
    const code = ((await response.json()) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** One provider's offering of a model, as `/v1/models` lists it: the fields tavi reads. */
export interface RhumbOffering {
  readonly provider?: string;
  readonly provider_model_id?: string;
  readonly status?: string;
  readonly deprecated_on?: string;
  readonly retires_on?: string;
  readonly end_claimed_on?: string;
  readonly closed_to_new_on?: string;
  readonly redirect?: { readonly on?: string; readonly to?: string; readonly via?: string };
  readonly next_price?: { readonly effective_from?: string; readonly per_1m?: Readonly<Record<string, string>> };
  readonly price?: { readonly currency?: string; readonly per_1m?: Readonly<Record<string, string>>; readonly effective_from?: string };
}

interface ModelsPage {
  readonly catalog_version?: string;
  readonly total?: number;
  readonly models?: readonly { readonly offerings?: readonly RhumbOffering[] }[];
}

export interface RhumbOfferings {
  readonly catalogVersion?: string;
  /**
   * Whether every page was read. When it is not, a model missing from
   * `offerings` may simply be on a page that was not read: never take it as
   * one Rhumb does not list.
   */
  readonly complete: boolean;
  /** By {@link offeringKey}. */
  readonly offerings: ReadonlyMap<string, RhumbOffering>;
}

/** The key an offering is found by: its provider and its id there. */
export function offeringKey(provider: string, providerModelId: string): string {
  return `${provider}\u0000${providerModelId}`;
}

/**
 * Every offering on `providers`, read page by page. `includeRetired` also
 * lists retired and hidden offerings: a lifecycle check must see a model that
 * has gone, a price sheet must not.
 */
export async function listOfferings(
  call: RhumbCall,
  providers: readonly string[],
  options: { readonly includeRetired?: boolean } = {},
): Promise<RhumbOfferings> {
  const offerings = new Map<string, RhumbOffering>();
  let catalogVersion: string | undefined;
  let complete = false;
  for (let page = 0; page < MODELS_MAX_PAGES; page += 1) {
    const answer = (await call("/v1/models", {
      providers: providers.join(","),
      limit: String(MODELS_PAGE_SIZE),
      offset: String(page * MODELS_PAGE_SIZE),
      ...(options.includeRetired === true ? { include_retired: "true", include_hidden: "true" } : {}),
    })) as ModelsPage;
    catalogVersion ??= answer.catalog_version;
    const models = answer.models ?? [];
    for (const model of models)
      for (const offering of model.offerings ?? [])
        if (offering.provider !== undefined && offering.provider_model_id !== undefined)
          offerings.set(offeringKey(offering.provider, offering.provider_model_id), offering);
    // A short page is the last; with no `total`, only a short page says so.
    if (models.length < MODELS_PAGE_SIZE || (answer.total !== undefined && (page + 1) * MODELS_PAGE_SIZE >= answer.total)) {
      complete = true;
      break;
    }
  }
  return { ...(catalogVersion === undefined ? {} : { catalogVersion }), complete, offerings };
}

/**
 * An offering's lifecycle as tavi keeps it, or `unknown` for a model Rhumb
 * does not list. Each field is checked on its own: one Rhumb sent in a shape
 * tavi does not know is left out, and the rest are kept.
 */
export function lifecycleOfOffering(offering: RhumbOffering | undefined, catalogVersion: string, checkedAt: string): ModelLifecycle {
  const shape = ModelLifecycleSchema.shape;
  const status = shape.status.safeParse(offering?.status);
  const redirect = offering?.redirect;
  const next = offering?.next_price;
  const fields: Partial<ModelLifecycle> = {
    ...kept(shape.retiresOn, "retiresOn", offering?.retires_on),
    ...kept(shape.endClaimedOn, "endClaimedOn", offering?.end_claimed_on),
    ...kept(shape.deprecatedOn, "deprecatedOn", offering?.deprecated_on),
    ...kept(shape.closedToNewOn, "closedToNewOn", offering?.closed_to_new_on),
    ...kept(
      shape.redirect,
      "redirect",
      redirect === undefined ? undefined : definedFields({ to: redirect.to, on: redirect.on, via: redirect.via }),
    ),
    ...kept(shape.nextPrice, "nextPrice", next === undefined ? undefined : { effectiveFrom: next.effective_from, per1m: next.per_1m }),
  };
  return { status: status.success ? status.data : "unknown", catalogVersion, checkedAt, ...fields };
}

/**
 * A redirect target as `provider` names it. Rhumb names the target as its
 * upstream does (`gemini-3.5-flash-lite`, via `gemini`), where a router such
 * as OpenRouter lists it under a namespace (`google/gemini-3.5-flash-lite`):
 * the one offering on `provider` that ends with `/<to>` is that model. Kept as
 * Rhumb gave it when the provider lists it so, or when none or several match.
 */
export function redirectOnProvider(listing: RhumbOfferings, provider: string, to: string): string {
  if (listing.offerings.has(offeringKey(provider, to))) return to;
  const suffix = `/${to}`;
  const matches = [...listing.offerings.values()].filter(
    (offering) => offering.provider === provider && offering.provider_model_id?.endsWith(suffix) === true,
  );
  return matches.length === 1 && matches[0]?.provider_model_id !== undefined ? matches[0].provider_model_id : to;
}

/** `{ [name]: value }` when `value` is present and `schema` accepts it, else nothing. */
function kept<K extends string, T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  name: K,
  value: unknown,
): { [P in K]?: T } {
  if (value === undefined) return {};
  const parsed = schema.safeParse(value);
  return parsed.success && parsed.data !== undefined ? ({ [name]: parsed.data } as { [P in K]?: T }) : {};
}

/** An object without its `undefined` fields: Rhumb leaves a field out, and the schema is strict. */
function definedFields(value: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
