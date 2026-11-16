import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { SECRET_KEY_REF_PATTERN, TimestampSchema } from "./ids.js";

/**
 * Web search.
 *
 * One port over several providers, normalised on ranked `WebSearchSource`s with
 * optional provider-generated `content`, each adapter declaring what it can do. A
 * provider is configured by a credential reference **or** a base URL: the
 * hosted APIs take a key, SearXNG is a self-hosted instance with none.
 */

/**
 * Provider kinds, in the order they were added. Perplexity Sonar (ending
 * 2026-09-27), Google CSE (closed), Bing (retired) and DuckDuckGo (no API)
 * are not here; Jina is fetch/extract, not search; Exa is deferred.
 */
export const WEB_SEARCH_KINDS = ["tavily", "brave", "serper", "searxng"] as const;
export type WebSearchKind = (typeof WEB_SEARCH_KINDS)[number];

/** What an adapter returns, and how it is reached. */
export interface WebSearchCapabilities {
  /** Ranked results with URLs. */
  readonly returnsResults: boolean;
  /** A synthesised answer beside them. */
  readonly returnsAnswer: boolean;
  /** Usable with no credential at all (Tavily's keyless mode). */
  readonly supportsKeyless: boolean;
  /** An instance the operator runs, reached by its base URL. */
  readonly selfHosted: boolean;
}

export const WEB_SEARCH_CAPABILITIES: Readonly<Record<WebSearchKind, WebSearchCapabilities>> = {
  tavily: { returnsResults: true, returnsAnswer: true, supportsKeyless: true, selfHosted: false },
  brave: { returnsResults: true, returnsAnswer: false, supportsKeyless: false, selfHosted: false },
  serper: { returnsResults: true, returnsAnswer: true, supportsKeyless: false, selfHosted: false },
  searxng: { returnsResults: true, returnsAnswer: true, supportsKeyless: false, selfHosted: true },
};

/** Bounds on what a provider's answer may put into a model's context. */
export const WEB_SEARCH_BOUNDS = {
  maxResults: 20,
  title: 300,
  url: 2048,
  snippet: 1000,
  answer: 4000,
} as const;

export const WebSearchSourceSchema = z.object({
  title: z.string().max(WEB_SEARCH_BOUNDS.title).optional(),
  url: z
    .url({ protocol: /^https?$/ })
    .max(WEB_SEARCH_BOUNDS.url)
    .refine((value) => /^https?:\/\/[^/?#@\\]+(?:[/?#][^\\]*)?$/.test(value), "source URL cannot contain credentials"),
  snippet: z.string().max(WEB_SEARCH_BOUNDS.snippet).optional(),
  /** As the provider gave it: an ISO date, or its own wording ("2 days ago"). */
  publishedAt: z.string().max(100).optional(),
});
export type WebSearchSource = z.infer<typeof WebSearchSourceSchema>;

export interface WebSearchResult {
  readonly sources: readonly WebSearchSource[];
  readonly content?: string;
  readonly truncated: boolean;
}

export const WebSearchResultSchema = z.strictObject({
  sources: z.array(WebSearchSourceSchema).max(1000),
  content: z.string().max(WEB_SEARCH_BOUNDS.answer).optional(),
  truncated: z.boolean(),
});

/** How recent a search's results must be: published within the last day, week, month or year. */
export type WebSearchRecency = "day" | "week" | "month" | "year";

export interface WebSearchRequest {
  readonly query: string;
  /** 1 to `WEB_SEARCH_BOUNDS.maxResults`; the adapter's default otherwise. */
  readonly maxResults?: number;
  /** Only results this recent, where the provider can filter by date. */
  readonly recency?: WebSearchRecency;
  /** Only results from this domain and its subdomains (`example.com`). */
  readonly site?: string;
}

/** One configured provider, reachable. */
export interface WebSearchProvider {
  readonly id: string;
  available(): boolean;
  search(query: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}

/** A fetch provider's vocabulary: plain data, so a plugin's provider needs no runtime import. */
export interface WebFetchRequest {
  readonly url: string;
}
export type WebFetchBody = { readonly kind: "html"; readonly content: string } | { readonly kind: "text"; readonly content: string };
export interface WebFetchResult {
  readonly url: string;
  readonly statusCode: number;
  readonly body: WebFetchBody;
  readonly truncated: boolean;
}
export interface WebFetchProvider {
  readonly id: string;
  available(): boolean;
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
}

/** Provider ids appear in commands and logs: slug-safe, like connection ids. */
export const SEARCH_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const configFields = {
  providerId: z.string().min(1).max(64).regex(SEARCH_PROVIDER_ID_PATTERN, "expected a lower-case slug"),
  kind: z.enum(WEB_SEARCH_KINDS),
  /** The key, by reference; absent for SearXNG, and for Tavily in keyless mode. */
  credentialRef: z.string().min(1).max(128).regex(SECRET_KEY_REF_PATTERN).optional(),
  /** SearXNG's instance, `http(s)://…`; the hosted APIs have fixed endpoints. */
  baseUrl: z.string().min(1).max(500).optional(),
  enabled: z.boolean(),
};

/**
 * A configured provider. SearXNG is `baseUrl`-only; the hosted kinds take no
 * `baseUrl` and a `credentialRef` — which Tavily alone may leave out, to run
 * keyless.
 */
export const SearchProviderConfigSchema = z
  .object({ ...configFields, createdAt: TimestampSchema, updatedAt: TimestampSchema })
  .superRefine((config, context) => {
    if (config.kind === "searxng") {
      if (config.baseUrl === undefined) context.addIssue({ code: "custom", message: "a searxng provider needs its instance's baseUrl" });
      if (config.credentialRef !== undefined) context.addIssue({ code: "custom", message: "a searxng provider takes no credentialRef" });
      // An http(s) origin and path, with no userinfo: the adapter parses it
      // fully; this is the shape a stored row must have.
      if (config.baseUrl !== undefined && !/^https?:\/\/[^/@\s?#]+(?:\/[^\s?#]*)?$/i.test(config.baseUrl)) {
        context.addIssue({
          code: "custom",
          message: "a searxng baseUrl must be an http(s) URL with no credentials, query or fragment in it",
        });
      }
      return;
    }
    if (config.baseUrl !== undefined)
      context.addIssue({ code: "custom", message: `a ${config.kind} provider has a fixed endpoint and takes no baseUrl` });
    if (config.credentialRef === undefined && !WEB_SEARCH_CAPABILITIES[config.kind].supportsKeyless) {
      context.addIssue({ code: "custom", message: `a ${config.kind} provider needs a credentialRef` });
    }
  });
export type SearchProviderConfig = z.infer<typeof SearchProviderConfigSchema>;

/**
 * Why a search provider may not name `credentialRef`, or `undefined` when it
 * may. Its key must be stored under a search reference — `search.*`,
 * or the kind's own (`brave.*` for Brave) — so a key stored for a model, a
 * messaging connection or anything else can never be named: `test`, which a
 * page can reach through `tavi ui`, would send it to the provider's endpoint.
 * A name alone is not enough — the owner also refuses a search reference that
 * something else holds.
 */
export function searchCredentialRefProblem(kind: WebSearchKind, credentialRef: string): string | undefined {
  if (credentialRef.startsWith("search.") || credentialRef.startsWith(`${kind}.`)) return undefined;
  return `a ${kind} provider's key must be stored under search.<name> or ${kind}.<name>, not ${credentialRef}: store it with \`tavi credentials set search.<name>\``;
}

/**
 * Durable storage for configured search providers. One
 * enabled provider is used automatically; several need a selection or fallback
 * chain in web-providers.json.
 */
interface SearchProviderRepositoryPortDefinition {
  /** Refuses a duplicate id (`CONFLICT`) and an invalid config (`INVALID_INPUT`) before writing. */
  add(input: Omit<SearchProviderConfig, "createdAt" | "updatedAt"> & { readonly now: string }): SearchProviderConfig;
  get(providerId: string): SearchProviderConfig | undefined;
  /** In the order they were added; unreadable rows by id, isolated rather than thrown. */
  list(): { readonly providers: readonly SearchProviderConfig[]; readonly unreadable: readonly string[] };
  remove(providerId: string): boolean;
  setEnabled(providerId: string, enabled: boolean, now: string): boolean;
}

export type SearchProviderRepositoryPort = AsyncRepository<SearchProviderRepositoryPortDefinition>;

/** A host-authored chain: every entry is separately reserved under one deadline. */
export const ProviderSelectionSchema = z.strictObject({
  providers: z
    .array(z.string().min(1).max(256))
    .min(1)
    .max(4)
    .refine((ids) => new Set(ids).size === ids.length, "duplicate provider selection"),
  timeoutMs: z.number().int().min(1).max(30_000).default(10_000),
});
export type ProviderSelection = z.infer<typeof ProviderSelectionSchema>;
export const WebProviderConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaces: z.record(
    z.string().min(1).max(128),
    z.strictObject({ search: ProviderSelectionSchema.optional(), fetch: ProviderSelectionSchema.optional() }),
  ),
});
export type WebProviderConfiguration = z.infer<typeof WebProviderConfigurationSchema>;

export const WebFetchResultSchema = z.strictObject({
  url: z.url().max(2048),
  statusCode: z.number().int().min(100).max(599),
  body: z.strictObject({ kind: z.enum(["html", "text"]), content: z.string().max(8 * 1024 * 1024) }),
  truncated: z.boolean(),
});
/** Observations of the actual guarded transport, supplied by host dispatch. */
export const FetchTransportReceiptSchema = z.strictObject({
  version: z.literal(1),
  url: z.url().max(2048),
  finalUrl: z.url().max(2048),
  status: z.number().int().min(100).max(599),
  contentType: z.string().max(256),
  bytes: z.number().int().nonnegative(),
  address: z.string().min(1).max(128),
  addressClass: z.literal("public"),
  redirects: z
    .array(
      z.strictObject({
        from: z.url().max(2048),
        to: z.url().max(2048),
        status: z.number().int().min(300).max(399),
        address: z.string().min(1).max(128),
      }),
    )
    .max(5),
});
export type FetchTransportReceipt = z.infer<typeof FetchTransportReceiptSchema>;
export const MediatedFetchResultSchema = z.strictObject({
  provider: z.string().min(1).max(256),
  content: WebFetchResultSchema,
  receipt: FetchTransportReceiptSchema,
});
export type MediatedFetchResult = z.infer<typeof MediatedFetchResultSchema>;
