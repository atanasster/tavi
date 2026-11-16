import {
  TaviError,
  WEB_SEARCH_BOUNDS,
  WEB_SEARCH_CAPABILITIES,
  scrubCredentialText,
  searchCredentialRefProblem,
  type InvocationContext,
  type ProviderSelection,
  type SearchProviderConfig,
  type WebSearchSource,
  type WebSearchProvider,
  type WebSearchRecency,
  type WebSearchRequest,
  type WebSearchKind,
  WebSearchResultSchema,
  type WebSearchResult,
} from "@tavi/contracts";
import { providerDispatcher, type ProviderExecutionOptions, type ResolvedProvider, type ToolRegistry } from "@tavi/runtime";
import type { ToolHandler } from "@tavi/contracts";
import { errorMessage, isRecord } from "@tavi/contracts/util";
import { BodyTooLargeError, readBoundedBody } from "@tavi/node-kit";
import { z } from "zod";

import { assessWebSearch } from "../approvals/call-assessors.js";

/**
 * Web search: an adapter per
 * provider kind behind `WebSearchProvider`, and the `web_search` tool over the
 * configured providers.
 *
 * Every adapter reaches a fixed endpoint — or, for SearXNG, the instance the
 * operator configured — with the key the operator bound, never one a model
 * names; answers are bounded and normalised onto `WebSearchSource`s before they
 * reach a model.
 */

/** The fixed endpoints of the hosted providers. */
export const WEB_SEARCH_ENDPOINTS = {
  tavily: "https://api.tavily.com/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
  serper: "https://google.serper.dev/search",
} as const;

const DEFAULT_RESULTS = 5;
/** The longest query Brave's Web Search accepts. */
const BRAVE_MAX_QUERY = 400;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface WebSearchAdapterOptions {
  /** The operator's credential chain; `null` is "not configured". */
  readonly readSecret: (reference: string) => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

const clamp = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined;

/** Markup a provider leaves in its text (Brave's `<strong>`), and the entities it escapes. */
const plain = (value: unknown): unknown =>
  typeof value === "string"
    ? value
        .replace(/<[^>]{0,200}>/g, "")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
    : value;

/** Whether `url` is a web address a model may follow: http(s) only. */
const webUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * A provider's result, bounded and in plain text. One with no http(s) URL is
 * dropped; missing titles remain absent.
 */
function result(title: unknown, url: unknown, snippet: unknown, publishedAt: unknown): WebSearchSource | undefined {
  const boundedUrl = clamp(url, WEB_SEARCH_BOUNDS.url);
  if (boundedUrl === undefined || !webUrl(boundedUrl)) return undefined;
  const boundedTitle = clamp(plain(title), WEB_SEARCH_BOUNDS.title);
  const boundedSnippet = clamp(plain(snippet), WEB_SEARCH_BOUNDS.snippet);
  const date = clamp(publishedAt, 100);
  return {
    ...(boundedTitle === undefined ? {} : { title: boundedTitle }),
    url: boundedUrl,
    ...(boundedSnippet === undefined ? {} : { snippet: boundedSnippet }),
    ...(date === undefined ? {} : { publishedAt: date }),
  };
}

const results = (entries: unknown, map: (entry: Record<string, unknown>) => WebSearchSource | undefined): WebSearchSource[] =>
  (Array.isArray(entries) ? entries : [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map(map)
    .filter((entry): entry is WebSearchSource => entry !== undefined);

/** The adapter for one configured provider. */
export function createWebSearchAdapter(config: SearchProviderConfig, options: WebSearchAdapterOptions): WebSearchProvider {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fail = (code: "UNAVAILABLE" | "NOT_AUTHORIZED" | "NOT_CONFIGURED", message: string): TaviError =>
    new TaviError(code, `web search provider ${config.providerId} (${config.kind}): ${message}`, {
      details: { providerId: config.providerId, kind: config.kind },
    });

  /** The key, or `undefined` for a keyless provider; a keyed kind with none is refused, never sent an empty header. */
  const key = async (): Promise<string | undefined> => {
    if (config.credentialRef === undefined) {
      if (WEB_SEARCH_CAPABILITIES[config.kind].supportsKeyless || WEB_SEARCH_CAPABILITIES[config.kind].selfHosted) return undefined;
      throw fail("NOT_CONFIGURED", "it has no credential reference");
    }
    let secret: string | null;
    try {
      secret = await options.readSecret(config.credentialRef);
    } catch {
      // The store's own message may carry a path: the model gets none.
      throw fail("UNAVAILABLE", `its credential ${config.credentialRef} could not be read`);
    }
    if (secret === null || secret.trim() === "") {
      throw fail(
        "NOT_CONFIGURED",
        `its credential ${config.credentialRef} is not set; store it with \`tavi credentials set ${config.credentialRef}\``,
      );
    }
    return secret.trim();
  };
  /** A provider that always takes a key: none stored is refused as `key` refuses it. */
  const requiredKey = async (): Promise<string> => {
    const secret = await key();
    if (secret === undefined) throw fail("NOT_CONFIGURED", "it has no credential reference");
    return secret;
  };

  /**
   * One request, bounded in time and size — the body's reading included — its
   * JSON object answer parsed; every failure typed, naming the provider,
   * never quoting the key.
   */
  const call = async (url: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    /** A thrown fetch or read failure, typed: the caller's cancel, the deadline, or the cause, scrubbed. */
    const broken = (error: unknown, stage: string): TaviError => {
      if (signal.aborted) return new TaviError("CANCELLED", "web_search was cancelled");
      if (timeout.aborted) return fail("UNAVAILABLE", `no answer within ${timeoutMs} ms`);
      const cause = (error as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
      const detail = String(cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : error));
      if (/redirect/i.test(detail) || /redirect/i.test(errorMessage(error, ""))) {
        return fail("UNAVAILABLE", "redirected elsewhere; redirects are not followed");
      }
      return fail("UNAVAILABLE", `${stage} (${scrubCredentialText(detail).slice(0, 200)})`);
    };
    let response: Response;
    try {
      response = await doFetch(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, timeout]) });
    } catch (error) {
      throw broken(error, "unreachable");
    }
    if (!response.ok) {
      // A refused request (4xx but the key's and the rate limit's) usually says why, and the model can fix its query from that.
      if (response.status >= 400 && response.status < 500 && ![401, 403, 429].includes(response.status)) {
        const reason = await refusalReason(response);
        throw fail(
          "UNAVAILABLE",
          `answered ${response.status}${reason === undefined ? "" : `: ${scrubCredentialText(reason).slice(0, 200)}`}`,
        );
      }
      // Best effort: the body is discarded; one already closed has nothing to cancel.
      await response.body?.cancel().catch(() => undefined);
      if (config.kind === "searxng" && response.status === 403) {
        throw fail(
          "UNAVAILABLE",
          "the instance refused the request (403) — most likely `json` is missing from `search.formats` in its settings.yml",
        );
      }
      if (response.status === 401 || response.status === 403)
        throw fail("NOT_AUTHORIZED", `the provider refused the key (${response.status})`);
      if (response.status === 429) throw fail("UNAVAILABLE", "rate limited (429); try again later");
      throw fail("UNAVAILABLE", `answered ${response.status}`);
    }
    let body: string | undefined;
    try {
      body = await readBounded(response);
    } catch (error) {
      throw broken(error, "its answer broke off");
    }
    if (body === undefined) throw fail("UNAVAILABLE", `answered more than ${MAX_RESPONSE_BYTES} bytes`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw fail("UNAVAILABLE", "answered something other than JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw fail("UNAVAILABLE", "answered JSON that is not an object");
    return parsed as Record<string, unknown>;
  };

  const respond = (found: readonly WebSearchSource[], answer: unknown, limit: number): WebSearchResult => {
    const bounded = clamp(answer, WEB_SEARCH_BOUNDS.answer);
    return { sources: found.slice(0, limit), truncated: found.length > limit, ...(bounded === undefined ? {} : { content: bounded }) };
  };

  const search = async (request: WebSearchRequest, signal = new AbortController().signal): Promise<WebSearchResult> => {
    const limit = Math.min(Math.max(1, Math.trunc(request.maxResults ?? DEFAULT_RESULTS)), WEB_SEARCH_BOUNDS.maxResults);
    // A site is asked for as `site:` in the query wherever the provider has no field of its own for it.
    const query = { ...request, query: request.site === undefined ? request.query : `${request.query} site:${request.site}` };
    switch (config.kind) {
      case "tavily": {
        const secret = await key();
        // No key: Tavily's keyless mode, which lets the adapter run before any secret exists.
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "application/json",
          ...(secret === undefined ? { "x-tavily-access-mode": "keyless" } : { authorization: `Bearer ${secret}` }),
        };
        const answer = (await call(
          WEB_SEARCH_ENDPOINTS.tavily,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              query: request.query,
              max_results: limit,
              include_answer: true,
              ...(request.recency === undefined ? {} : { time_range: request.recency }),
              ...(request.site === undefined ? {} : { include_domains: [request.site] }),
            }),
          },
          signal,
        )) as {
          answer?: unknown;
          results?: unknown;
        };
        return respond(
          results(answer.results, (entry) => result(entry["title"], entry["url"], entry["content"], entry["published_date"])),
          answer.answer,
          limit,
        );
      }
      case "brave": {
        // Brave refuses a longer query outright: said here, so the next provider is asked.
        if (query.query.length > BRAVE_MAX_QUERY) throw fail("UNAVAILABLE", `it takes queries of at most ${BRAVE_MAX_QUERY} characters`);
        const secret = await requiredKey();
        const url = `${WEB_SEARCH_ENDPOINTS.brave}?${new URLSearchParams({
          q: query.query,
          count: String(limit),
          ...(query.recency === undefined ? {} : { freshness: BRAVE_FRESHNESS[query.recency] }),
        }).toString()}`;
        const answer = (await call(
          url,
          { method: "GET", headers: { accept: "application/json", "x-subscription-token": secret } },
          signal,
        )) as { web?: { results?: unknown } };
        return respond(
          results(answer.web?.results, (entry) =>
            result(entry["title"], entry["url"], entry["description"], entry["page_age"] ?? entry["age"]),
          ),
          undefined,
          limit,
        );
      }
      case "serper": {
        const secret = await requiredKey();
        const answer = (await call(
          WEB_SEARCH_ENDPOINTS.serper,
          {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json", "x-api-key": secret },
            body: JSON.stringify({
              q: query.query,
              num: limit,
              ...(query.recency === undefined ? {} : { tbs: `qdr:${query.recency[0]}` }),
            }),
          },
          signal,
        )) as { organic?: unknown; answerBox?: { answer?: unknown; snippet?: unknown } };
        return respond(
          results(answer.organic, (entry) => result(entry["title"], entry["link"], entry["snippet"], entry["date"])),
          answer.answerBox?.answer ?? answer.answerBox?.snippet,
          limit,
        );
      }
      case "searxng": {
        const base = parseInstance(config.baseUrl);
        if (base === undefined) throw fail("NOT_CONFIGURED", "its baseUrl is not an http(s) URL");
        const url = new URL("search", base);
        url.search = new URLSearchParams({
          q: query.query,
          format: "json",
          ...(query.recency === undefined ? {} : { time_range: query.recency }),
        }).toString();
        // A language header, as a browser sends: an instance's limiter refuses a request with none.
        const answer = (await call(
          url.toString(),
          { method: "GET", headers: { accept: "application/json", "accept-language": "en" } },
          signal,
        )) as {
          results?: unknown;
          answers?: unknown;
        };
        const first = Array.isArray(answer.answers) ? (answer.answers as unknown[])[0] : undefined;
        return respond(
          results(answer.results, (entry) => result(entry["title"], entry["url"], entry["content"], entry["publishedDate"])),
          typeof first === "object" && first !== null ? (first as { answer?: unknown }).answer : first,
          limit,
        );
      }
    }
  };

  return { id: config.providerId, available: () => config.enabled, search };
}

/** A SearXNG base URL as a directory, so `search` resolves under its path. */
function parseInstance(baseUrl: string | undefined): URL | undefined {
  if (baseUrl === undefined) return undefined;
  try {
    const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The provider's stated reason for refusing a request — Tavily's
 * `{detail:{error}}`, or a plain `error`, `message` or `detail` string — or
 * `undefined` when its body says none.
 */
async function refusalReason(response: Response): Promise<string | undefined> {
  let parsed: unknown;
  try {
    const body = await readBounded(response);
    if (body === undefined) return undefined;
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
    if (!isRecord(value)) return undefined;
    return pick(value["error"]) ?? pick(value["message"]) ?? pick(value["detail"]);
  };
  return pick(parsed);
}

/** The body as text, or `undefined` past the bound. */
async function readBounded(response: Response): Promise<string | undefined> {
  try {
    return new TextDecoder().decode((await readBoundedBody(response, MAX_RESPONSE_BYTES)).bytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return undefined;
    throw error;
  }
}

/** Brave's `freshness` for each recency: past day, week, month, year. */
const BRAVE_FRESHNESS: Readonly<Record<WebSearchRecency, string>> = { day: "pd", week: "pw", month: "pm", year: "py" };

const WebSearchInputSchema = z.strictObject({
  query: z.string().min(1).max(500).describe("What to search the web for"),
  maxResults: z.number().int().min(1).max(WEB_SEARCH_BOUNDS.maxResults).optional().describe("How many results to return (default 5)"),
  recency: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe("Only results published within the last day, week, month or year: for news, prices, releases"),
  site: z
    .string()
    .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i)
    .optional()
    .describe("Only results from this domain and its subdomains, e.g. github.com"),
});

/** What `web_search` may hand a model at most, as JSON: under the 64 KiB tool-result gate, with room to spare. */
export const WEB_SEARCH_MAX_OUTPUT_BYTES = 48 * 1024;

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The answer within `WEB_SEARCH_MAX_OUTPUT_BYTES`: the lowest-ranked results go first, then the answer's tail. */
function withinBound(output: WebSearchResult & { provider: string }): typeof output {
  const bounded = { ...output, sources: [...output.sources] };
  while (bytesOf(bounded) > WEB_SEARCH_MAX_OUTPUT_BYTES && bounded.sources.length > 0) {
    bounded.sources.pop();
    bounded.truncated = true;
  }
  if (bytesOf(bounded) > WEB_SEARCH_MAX_OUTPUT_BYTES && bounded.content !== undefined) {
    bounded.content = bounded.content.slice(0, 1000);
    bounded.truncated = true;
  }
  return bounded;
}

/**
 * Search through the instances the owner has activated. Adding or enabling a
 * provider activates it on demand, and the owner calls this again after each
 * search write, so the first provider is offered from the next turn with no
 * restart; disabling or removing excludes it
 * from new calls. One enabled provider is used automatically; several need a
 * selection or fallback chain in web-providers.json. Provider failures may use
 * the next provider in that chain, while authorization failures, invalid
 * configuration, revocation and cancellation halt dispatch. The tool is an
 * external effect gated by policy and is offered once an available provider
 * exists — never while none does, so a model is not shown a tool that cannot
 * answer — and from then on reads the enabled providers at every call.
 */
export async function registerWebSearchTool(
  registry: ToolRegistry,
  providers: (context?: InvocationContext) => readonly WebSearchProvider[] | Promise<readonly WebSearchProvider[]>,
  execution: ProviderExecutionOptions & {
    resolve: (
      provider: WebSearchProvider,
      context: InvocationContext,
    ) => Promise<ResolvedProvider<WebSearchProvider> & { selectionId?: string }>;
    selection?: (context: InvocationContext) => ProviderSelection | undefined;
    /** Whether `web_fetch` is offered (the owner allows hosts to fetch): only then does the description point at it. */
    fetchOffered?: boolean;
  },
): Promise<void> {
  if ((await providers()).filter((provider) => provider.available()).length === 0) return;
  const dispatcher = providerDispatcher({
    execution,
    ...(execution.selection === undefined ? {} : { selection: execution.selection }),
    candidates: async (context) =>
      Promise.all(
        (await providers(context))
          .filter((provider) => provider.available())
          .map(async (provider) => {
            const resolved = await execution.resolve(provider, context);
            return { id: resolved.selectionId ?? provider.id, resolved };
          }),
      ),
  });
  registry.register({
    id: "web_search",
    sink: "search",
    version: "1.0.0",
    description:
      "Search the web through the operator's configured search providers. Returns ranked sources (url, optional title and snippet) " +
      "and, when the provider gives one, a short synthesised answer. Cite the URLs you rely on. " +
      (execution.fetchOffered === true
        ? "To read a page whose URL you have, use web_fetch; a configured project's own news, news.search."
        : "To read a page whose URL you have, open it with a browser tool where one is offered; a configured project's own news, news.search."),
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    inputSchema: WebSearchInputSchema,
    assess: assessWebSearch,
    resolveBinding: async (_input: unknown, context: InvocationContext) => dispatcher.resolve(context),
    untrustedOutput: true,
    outputSource: "search",
    handler: async ({
      input,
      signal,
      context,
      expectedBindingHash,
      reserveProviderAttempt,
      operationEnvelope,
    }: Parameters<ToolHandler>[0]) => {
      const parsed = WebSearchInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "web_search received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      const query = {
        query: parsed.data.query,
        ...(parsed.data.maxResults === undefined ? {} : { maxResults: parsed.data.maxResults }),
        ...(parsed.data.recency === undefined ? {} : { recency: parsed.data.recency }),
        ...(parsed.data.site === undefined ? {} : { site: parsed.data.site.toLowerCase() }),
      };
      const normalize = (answer: WebSearchResult, provider: string) => {
        const portable = WebSearchResultSchema.parse(answer);
        const maxResults = parsed.data.maxResults ?? DEFAULT_RESULTS;
        return withinBound({
          ...(portable.content === undefined ? {} : { content: portable.content }),
          sources: portable.sources.slice(0, maxResults),
          truncated: portable.truncated || portable.sources.length > maxResults,
          provider,
        });
      };
      if (expectedBindingHash === undefined) throw new TaviError("NOT_AUTHORIZED", "Search requires a resolved authorization binding");
      const answer = await dispatcher.dispatch({
        context,
        signal,
        expectedBindingHash,
        ...(operationEnvelope === undefined ? {} : { envelope: operationEnvelope }),
        ...(reserveProviderAttempt === undefined ? {} : { reserve: reserveProviderAttempt }),
        invoke: async (provider, signal) => normalize(await provider.search(query, signal), provider.id),
      });
      return { ...answer.result, provider: answer.provider };
    },
  });
}

/**
 * Why a search provider of `kind` may not name `credentialRef`, or
 * `undefined` when it may: the key must be a search reference by its name
 * (`searchCredentialRefProblem`), and nothing else may hold it — no model
 * connection, no launcher binding, no provider of another kind (whose
 * endpoint it was stored for). One rule for the owner and the offline
 * `tavi search add`. A SearXNG provider takes no key at all; its own check
 * says so.
 */
export function searchKeyProblem(
  holders: {
    readonly connections: readonly { readonly credentialRef: string }[];
    readonly launcherBindings: readonly string[];
    readonly providers: readonly { readonly kind: WebSearchKind; readonly credentialRef?: string | undefined }[];
  },
  kind: WebSearchKind,
  credentialRef: string,
): string | undefined {
  if (kind === "searxng") return undefined;
  const named = searchCredentialRefProblem(kind, credentialRef);
  if (named !== undefined) return named;
  const holder = holders.connections.some((connection) => connection.credentialRef === credentialRef)
    ? "a model connection's key"
    : holders.launcherBindings.includes(credentialRef)
      ? "bound by the owner's launcher"
      : holders.providers.some((provider) => provider.credentialRef === credentialRef && provider.kind !== kind)
        ? "another kind of search provider's key"
        : undefined;
  return holder === undefined
    ? undefined
    : `credential ${credentialRef} is ${holder}; store the search provider's key under a reference of its own`;
}
