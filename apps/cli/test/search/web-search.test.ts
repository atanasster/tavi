import { inspectDatabase } from "../support/database-fixture.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  WEB_SEARCH_BOUNDS,
  WEB_SEARCH_CAPABILITIES,
  type InvocationContext,
  type ProviderSelection,
  type SearchProviderConfig,
  type WebSearchProvider,
} from "@tavi/contracts";
import { ToolRegistry, scopedProvider } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import {
  createWebSearchAdapter,
  registerWebSearchTool,
  WEB_SEARCH_ENDPOINTS,
  WEB_SEARCH_MAX_OUTPUT_BYTES,
} from "../../src/features/search/web-search.js";

/** Web search: each adapter's request and normalisation, its refusals, and `web_search` over them. */

const AT = "2026-01-01T00:00:00.000Z";
const provider = (fields: Partial<SearchProviderConfig> & Pick<SearchProviderConfig, "providerId" | "kind">): SearchProviderConfig => ({
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
  ...fields,
});

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A fake `fetch` answering every request with `status` and `body`, remembering what it was sent. */
function fakeFetch(
  answer: { readonly status?: number; readonly body: unknown } | ((url: string) => { readonly status?: number; readonly body: unknown }),
) {
  const seen: Seen[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const given = typeof answer === "function" ? answer(url) : answer;
    return new Response(typeof given.body === "string" ? given.body : JSON.stringify(given.body), {
      status: given.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { seen, doFetch };
}

const signal = new AbortController().signal;
const keys = async (reference: string) =>
  ({ "tavily.apiKey": "tvly-secret", "brave.apiKey": "brave-secret", "serper.apiKey": "serper-secret" })[reference] ?? null;

describe("redirects", () => {
  it("asks fetch to refuse a redirect, and a real 302 from the instance is not followed", async () => {
    // The request itself says so: a SearXNG address a page chose cannot lead the owner elsewhere.
    const inits: (RequestInit | undefined)[] = [];
    const recording = (async (_input: string | URL | Request, init?: RequestInit) => {
      inits.push(init);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof globalThis.fetch;
    await createWebSearchAdapter(provider({ providerId: "home", kind: "searxng", baseUrl: "http://127.0.0.1:1" }), {
      readSecret: keys,
      fetch: recording,
    }).search({ query: "q" }, signal);
    expect(inits[0]?.redirect).toBe("error");

    // Over the network, with the platform's own fetch: an instance answering 302 is refused, and its target never asked.
    const { createServer } = await import("node:http");
    let followed = 0;
    const target = createServer((_request, response) => {
      followed += 1;
      response.end(JSON.stringify({ results: [{ title: "elsewhere", url: "https://elsewhere.example/" }] }));
    });
    const redirecting = createServer((_request, response) => {
      const address = target.address();
      response.writeHead(302, {
        location: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/search?q=q&format=json`,
      });
      response.end();
    });
    await Promise.all(
      [target, redirecting].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))),
    );
    try {
      const address = redirecting.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const adapter = createWebSearchAdapter(provider({ providerId: "home", kind: "searxng", baseUrl: `http://127.0.0.1:${port}` }), {
        readSecret: keys,
      });
      await expect(adapter.search({ query: "q" }, signal)).rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("redirects are not followed"),
      });
      expect(followed).toBe(0);
    } finally {
      await Promise.all([target, redirecting].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  });
});

describe("the adapters", () => {
  it("runs Tavily keyless first — no key, its access-mode header — and with a key as a bearer token", async () => {
    const answer = {
      answer: "Sofia",
      results: [{ title: "Capital", url: "https://example.com/sofia", content: "Sofia is…", published_date: "2026-01-01" }],
    };
    const keyless = fakeFetch({ body: answer });
    const adapter = createWebSearchAdapter(provider({ providerId: "tavily-free", kind: "tavily" }), {
      readSecret: keys,
      fetch: keyless.doFetch,
    });
    expect(WEB_SEARCH_CAPABILITIES.tavily).toMatchObject({ supportsKeyless: true, returnsAnswer: true });
    expect(await adapter.search({ query: "capital of Bulgaria", maxResults: 3 }, signal)).toEqual({
      truncated: false,
      content: "Sofia",
      sources: [{ title: "Capital", url: "https://example.com/sofia", snippet: "Sofia is…", publishedAt: "2026-01-01" }],
    });
    expect(keyless.seen[0]).toMatchObject({
      url: WEB_SEARCH_ENDPOINTS.tavily,
      method: "POST",
      body: { query: "capital of Bulgaria", max_results: 3, include_answer: true },
    });
    expect(keyless.seen[0]?.headers["x-tavily-access-mode"]).toBe("keyless");
    expect(keyless.seen[0]?.headers["authorization"]).toBeUndefined();

    const keyed = fakeFetch({ body: answer });
    await createWebSearchAdapter(provider({ providerId: "tavily", kind: "tavily", credentialRef: "tavily.apiKey" }), {
      readSecret: keys,
      fetch: keyed.doFetch,
    }).search({ query: "q" }, signal);
    expect(keyed.seen[0]?.headers["authorization"]).toBe("Bearer tvly-secret");
    expect(keyed.seen[0]?.headers["x-tavily-access-mode"]).toBeUndefined();
  });

  it("asks Brave, Serper and SearXNG as each expects, normalising their answers", async () => {
    const brave = fakeFetch({
      body: { web: { results: [{ title: "B", url: "https://b.example", description: "about b", page_age: "2026-01-02" }] } },
    });
    expect(
      await createWebSearchAdapter(provider({ providerId: "brave", kind: "brave", credentialRef: "brave.apiKey" }), {
        readSecret: keys,
        fetch: brave.doFetch,
      }).search({ query: "b things", maxResults: 2 }, signal),
    ).toMatchObject({ sources: [{ title: "B", url: "https://b.example", snippet: "about b", publishedAt: "2026-01-02" }] });
    expect(brave.seen[0]?.url).toBe(`${WEB_SEARCH_ENDPOINTS.brave}?q=b+things&count=2`);
    expect(brave.seen[0]?.headers["x-subscription-token"]).toBe("brave-secret");

    const serper = fakeFetch({
      body: { answerBox: { answer: "42" }, organic: [{ title: "S", link: "https://s.example", snippet: "about s" }] },
    });
    expect(
      await createWebSearchAdapter(provider({ providerId: "serper", kind: "serper", credentialRef: "serper.apiKey" }), {
        readSecret: keys,
        fetch: serper.doFetch,
      }).search({ query: "s" }, signal),
    ).toMatchObject({ content: "42", sources: [{ title: "S", url: "https://s.example", snippet: "about s" }] });
    expect(serper.seen[0]).toMatchObject({ url: WEB_SEARCH_ENDPOINTS.serper, method: "POST", body: { q: "s", num: 5 } });
    expect(serper.seen[0]?.headers["x-api-key"]).toBe("serper-secret");

    const searx = fakeFetch({ body: { answers: ["an answer"], results: [{ title: "X", url: "https://x.example", content: "about x" }] } });
    expect(
      await createWebSearchAdapter(provider({ providerId: "home", kind: "searxng", baseUrl: "http://127.0.0.1:8888/searx" }), {
        readSecret: keys,
        fetch: searx.doFetch,
      }).search({ query: "x" }, signal),
    ).toMatchObject({ content: "an answer", sources: [{ title: "X", url: "https://x.example" }] });
    expect(searx.seen[0]?.url).toBe("http://127.0.0.1:8888/searx/search?q=x&format=json");
    expect(Object.keys(searx.seen[0]?.headers ?? {})).not.toContain("authorization");
  });

  it("asks each provider for recent results from one site in its own way", async () => {
    const asked = { query: "release notes", recency: "week" as const, site: "github.com" };
    const brave = fakeFetch({ body: { web: { results: [] } } });
    await createWebSearchAdapter(provider({ providerId: "brave", kind: "brave", credentialRef: "brave.apiKey" }), {
      readSecret: keys,
      fetch: brave.doFetch,
    }).search(asked, signal);
    expect(brave.seen[0]?.url).toBe(`${WEB_SEARCH_ENDPOINTS.brave}?q=release+notes+site%3Agithub.com&count=5&freshness=pw`);
    const serper = fakeFetch({ body: { organic: [] } });
    await createWebSearchAdapter(provider({ providerId: "serper", kind: "serper", credentialRef: "serper.apiKey" }), {
      readSecret: keys,
      fetch: serper.doFetch,
    }).search(asked, signal);
    expect(serper.seen[0]).toMatchObject({ body: { q: "release notes site:github.com", num: 5, tbs: "qdr:w" } });
    const tavily = fakeFetch({ body: { results: [] } });
    await createWebSearchAdapter(provider({ providerId: "tavily", kind: "tavily" }), { readSecret: keys, fetch: tavily.doFetch }).search(
      asked,
      signal,
    );
    expect(tavily.seen[0]).toMatchObject({ body: { query: "release notes", time_range: "week", include_domains: ["github.com"] } });
  });

  it("bounds what a provider answers, and drops results with no URL", async () => {
    const long = "x".repeat(10_000);
    const flood = fakeFetch({
      body: {
        answer: long,
        results: [
          ...Array.from({ length: 40 }, (_, index) => ({ title: long, url: `https://r${index}.example`, content: long })),
          { title: "no url" },
        ],
      },
    });
    const answered = await createWebSearchAdapter(provider({ providerId: "t", kind: "tavily" }), {
      readSecret: keys,
      fetch: flood.doFetch,
    }).search({ query: "q", maxResults: 50 }, signal);
    expect(answered.sources).toHaveLength(WEB_SEARCH_BOUNDS.maxResults);
    expect(answered.content).toHaveLength(WEB_SEARCH_BOUNDS.answer);
    expect(answered.sources[0]?.title).toHaveLength(WEB_SEARCH_BOUNDS.title);
    expect(answered.sources[0]?.snippet).toHaveLength(WEB_SEARCH_BOUNDS.snippet);
    expect(answered.sources.every((entry) => entry.url.startsWith("https://"))).toBe(true);
  });

  it("types each refusal, never quoting the key", async () => {
    const refuse = async (config: SearchProviderConfig, status: number, body: unknown = {}) => {
      const answer = fakeFetch({ status, body });
      return createWebSearchAdapter(config, { readSecret: keys, fetch: answer.doFetch })
        .search({ query: "q" }, signal)
        .then(
          () => undefined,
          (error: unknown) => error as { code: string; message: string },
        );
    };
    const brave = provider({ providerId: "brave", kind: "brave", credentialRef: "brave.apiKey" });
    expect(await refuse(brave, 401)).toMatchObject({ code: "NOT_AUTHORIZED", message: expect.stringContaining("refused the key (401)") });
    expect(await refuse(brave, 429)).toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("rate limited") });
    expect(await refuse(brave, 502)).toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("answered 502") });
    // A refused query keeps the provider's reason, so the model can reword it.
    const tavily = provider({ providerId: "tavily", kind: "tavily", credentialRef: "tavily.apiKey" });
    expect(
      await refuse(tavily, 400, { detail: { error: "Query cannot consist only of site: operators. Please provide search terms." } }),
    ).toMatchObject({
      code: "UNAVAILABLE",
      message:
        "web search provider tavily (tavily): answered 400: Query cannot consist only of site: operators. Please provide search terms.",
    });
    expect(await refuse(brave, 422, "not json")).toMatchObject({ message: "web search provider brave (brave): answered 422" });
    expect(await refuse(provider({ providerId: "home", kind: "searxng", baseUrl: "http://127.0.0.1:8888" }), 403)).toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("`json` is missing from `search.formats`"),
    });
    const notJson = fakeFetch({ body: "<html>captcha</html>" });
    await expect(
      createWebSearchAdapter(brave, { readSecret: keys, fetch: notJson.doFetch }).search({ query: "q" }, signal),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("other than JSON") });
    // A key the store does not hold is the operator's to set, named.
    await expect(
      createWebSearchAdapter(provider({ providerId: "serper", kind: "serper", credentialRef: "missing.apiKey" }), {
        readSecret: keys,
        fetch: notJson.doFetch,
      }).search({ query: "q" }, signal),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED", message: expect.stringContaining("tavi credentials set missing.apiKey") });
    for (const status of [401, 429, 502]) expect(JSON.stringify(await refuse(brave, status))).not.toContain("brave-secret");
  });

  it("types what breaks after the headers: an answer too big, one that stalls, one that is no object", async () => {
    const big = fakeFetch({ body: { results: [], padding: "x".repeat(2 * 1024 * 1024 + 10) } });
    await expect(
      createWebSearchAdapter(provider({ providerId: "t", kind: "tavily" }), { readSecret: keys, fetch: big.doFetch }).search(
        { query: "q" },
        signal,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("more than 2097152 bytes") });

    // Headers at once, then a body that never ends: the deadline covers the reading too.
    const stalling = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200 },
      )) as typeof globalThis.fetch;
    await expect(
      createWebSearchAdapter(provider({ providerId: "t", kind: "tavily" }), {
        readSecret: keys,
        fetch: stalling,
        timeoutMs: 30,
      }).search({ query: "q" }, signal),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("no answer within 30 ms") });

    const nothing = fakeFetch({ body: "null" });
    await expect(
      createWebSearchAdapter(provider({ providerId: "t", kind: "tavily" }), { readSecret: keys, fetch: nothing.doFetch }).search(
        { query: "q" },
        signal,
      ),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("not an object") });
  });

  it("keeps only http(s) results, in plain text, a missing title falling back to the URL", async () => {
    const mixed = fakeFetch({
      body: {
        web: {
          results: [
            {
              title: "<strong>Brave</strong> &amp; co",
              url: "https://b.example",
              description: "a <strong>bold</strong> claim &quot;quoted&quot;",
            },
            { title: "Script", url: "javascript:alert(1)" },
            { title: "File", url: "file:///etc/passwd" },
            { url: "https://untitled.example" },
          ],
        },
      },
    });
    const answered = await createWebSearchAdapter(provider({ providerId: "brave", kind: "brave", credentialRef: "brave.apiKey" }), {
      readSecret: keys,
      fetch: mixed.doFetch,
    }).search({ query: "q" }, signal);
    expect(answered.sources).toEqual([
      { title: "Brave & co", url: "https://b.example", snippet: 'a bold claim "quoted"' },
      { url: "https://untitled.example" },
    ]);
    // A query longer than Brave takes is refused here, so the next provider is asked.
    await expect(
      createWebSearchAdapter(provider({ providerId: "brave", kind: "brave", credentialRef: "brave.apiKey" }), {
        readSecret: keys,
        fetch: mixed.doFetch,
      }).search({ query: "q".repeat(401) }, signal),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("at most 400 characters") });
  });

  it("gives up on a provider that does not answer in time", async () => {
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as typeof globalThis.fetch;
    await expect(
      createWebSearchAdapter(provider({ providerId: "t", kind: "tavily" }), {
        readSecret: keys,
        fetch: hanging,
        timeoutMs: 20,
      }).search({ query: "q" }, signal),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("no answer within 20 ms") });
  });
});

/** The mediated execution boundary production registers `web_search` with, over in-process providers. */
function searchExecution(selection?: ProviderSelection) {
  const execution = {
    ownerSession: "owner",
    implementationHash: "a".repeat(64),
    signal,
    actsIn: (_workspaceId: string, principalId: string) => principalId === "operator",
    ledger: { reserveOperation: async () => {}, finishOperation: async () => {}, operations: async () => [] },
  };
  return {
    ...execution,
    ...(selection === undefined ? {} : { selection: () => selection }),
    resolve: async (provider: WebSearchProvider, context: InvocationContext) =>
      scopedProvider(
        execution,
        context,
        { kind: "search", instanceId: provider.id, accountId: provider.id, endpoint: "in-process", configRevision: "b".repeat(64) },
        provider,
      ),
  };
}

describe("web_search", () => {
  const context = { workspaceId: "w", principalId: "operator", runId: "run-1", caller: "test" };
  const invoke = async (registry: ToolRegistry, input: unknown, callSignal = signal) => {
    const tool = registry.get("web_search");
    const binding = await tool?.resolveBinding?.(input, context);
    return tool?.handler({
      input,
      context,
      signal: callSignal,
      ...(binding === undefined ? {} : { expectedBindingHash: binding.bindingHash }),
    });
  };

  it("is an external effect, offered only when a provider is configured", async () => {
    const none = new ToolRegistry();
    await registerWebSearchTool(none, () => [], searchExecution());
    expect(none.get("web_search")).toBeUndefined();
    const some = new ToolRegistry();
    await registerWebSearchTool(
      some,
      () => [
        createWebSearchAdapter(provider({ providerId: "t", kind: "tavily" }), {
          readSecret: keys,
          fetch: fakeFetch({ body: {} }).doFetch,
        }),
      ],
      searchExecution(),
    );
    expect(some.get("web_search")).toMatchObject({ effect: "external", requiredPermissions: ["tools.invoke"] });
  });

  it("passes the query down the selected chain until one answers, and names the providers when none does", async () => {
    const down = fakeFetch({ status: 503, body: {} });
    const up = fakeFetch({ body: { web: { results: [{ title: "B", url: "https://b.example" }] } } });
    const registry = new ToolRegistry();
    await registerWebSearchTool(
      registry,
      () => [
        createWebSearchAdapter(provider({ providerId: "first", kind: "tavily" }), { readSecret: keys, fetch: down.doFetch }),
        createWebSearchAdapter(provider({ providerId: "second", kind: "brave", credentialRef: "brave.apiKey" }), {
          readSecret: keys,
          fetch: up.doFetch,
        }),
      ],
      searchExecution({ providers: ["first", "second"], timeoutMs: 10_000 }),
    );
    expect(await invoke(registry, { query: "b" })).toEqual({
      provider: "second",
      sources: [{ title: "B", url: "https://b.example" }],
      truncated: false,
    });
    expect(down.seen).toHaveLength(1);

    const none = new ToolRegistry();
    await registerWebSearchTool(
      none,
      () => [createWebSearchAdapter(provider({ providerId: "only", kind: "tavily" }), { readSecret: keys, fetch: down.doFetch })],
      searchExecution(),
    );
    await expect(invoke(none, { query: "b" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "No selected provider answered (web search provider only (tavily): answered 503)",
    });
    await expect(invoke(none, { query: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(invoke(none, { query: "b", extra: true })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("asks for a selection when several providers are enabled and none is chosen", async () => {
    const first = fakeFetch({ body: { results: [] } });
    const registry = new ToolRegistry();
    await registerWebSearchTool(
      registry,
      () => [
        createWebSearchAdapter(provider({ providerId: "first", kind: "tavily" }), { readSecret: keys, fetch: first.doFetch }),
        createWebSearchAdapter(provider({ providerId: "second", kind: "tavily" }), { readSecret: keys, fetch: first.doFetch }),
      ],
      searchExecution(),
    );
    await expect(invoke(registry, { query: "q" })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      message: expect.stringContaining("web-providers.json"),
    });
    expect(first.seen).toEqual([]);
  });

  it("stops at a cancellation, whichever provider it lands in", async () => {
    const controller = new AbortController();
    const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as typeof globalThis.fetch;
    const second = fakeFetch({ body: { results: [] } });
    const registry = new ToolRegistry();
    await registerWebSearchTool(
      registry,
      () => [
        createWebSearchAdapter(provider({ providerId: "first", kind: "tavily" }), { readSecret: keys, fetch: hanging }),
        createWebSearchAdapter(provider({ providerId: "second", kind: "tavily" }), { readSecret: keys, fetch: second.doFetch }),
      ],
      searchExecution({ providers: ["first", "second"], timeoutMs: 10_000 }),
    );
    const pending = invoke(registry, { query: "q" }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(second.seen).toEqual([]);
  });

  it("fits what it hands the model under the tool-result gate, the lowest-ranked results first to go", async () => {
    // Twenty results of wide characters: each field within its own bound, the whole past 48 KiB.
    const wide = "界".repeat(1000);
    const flood = fakeFetch({
      body: {
        answer: "short",
        results: Array.from({ length: 20 }, (_, index) => ({ title: wide, url: `https://r${index}.example`, content: wide })),
      },
    });
    const registry = new ToolRegistry();
    await registerWebSearchTool(
      registry,
      () => [createWebSearchAdapter(provider({ providerId: "t", kind: "tavily" }), { readSecret: keys, fetch: flood.doFetch })],
      searchExecution(),
    );
    const answered = (await invoke(registry, { query: "q", maxResults: 20 })) as { sources: { url: string }[]; content?: string };
    expect(Buffer.byteLength(JSON.stringify(answered), "utf8")).toBeLessThanOrEqual(WEB_SEARCH_MAX_OUTPUT_BYTES);
    expect(answered.sources.length).toBeGreaterThan(0);
    expect(answered.sources.length).toBeLessThan(20);
    expect(answered.sources[0]?.url).toBe("https://r0.example");
    expect(answered.content).toBe("short");
  });

  it("reads the providers on every call: one disabled since is not asked, and none left is said", async () => {
    let enabled = [true, false];
    const first = fakeFetch({ body: { results: [{ title: "1", url: "https://1.example" }] } });
    const second = fakeFetch({ body: { results: [{ title: "2", url: "https://2.example" }] } });
    const registry = new ToolRegistry();
    await registerWebSearchTool(
      registry,
      () =>
        [
          createWebSearchAdapter(provider({ providerId: "first", kind: "tavily" }), { readSecret: keys, fetch: first.doFetch }),
          createWebSearchAdapter(provider({ providerId: "second", kind: "tavily" }), { readSecret: keys, fetch: second.doFetch }),
        ].filter((_, index) => enabled[index]),
      searchExecution(),
    );
    expect(await invoke(registry, { query: "q" })).toMatchObject({ provider: "first" });
    enabled = [false, true];
    expect(await invoke(registry, { query: "q" })).toMatchObject({ provider: "second" });
    expect(first.seen).toHaveLength(1);
    enabled = [false, false];
    await expect(invoke(registry, { query: "q" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("No enabled provider"),
    });
  });
});

describe("composition", () => {
  const directories = temporaryDirectories();
  const runtimes: TaviRuntime[] = [];
  afterEach(async () => {
    while (runtimes.length > 0) await runtimes.pop()?.close();
    directories.cleanup();
  });

  it("offers web_search over the enabled providers stored when it composes", async () => {
    const directory = directories.create("tavi-search-");
    const options = {
      dataDirectory: directory,
      workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
      providers: [],
      credentials: {},
      defaultConnectionId: "none",
      defaultModel: "none",
      logger: { level: "error" as const, sink: () => undefined },
      scheduleSweepEnabled: false,
    };
    const bare = await composeTaviRuntime(options, { requireModelTransport: false });
    expect(bare.tools.get("web_search")).toBeUndefined();
    await bare.store.asPort().repositories.searchProviders.add({ providerId: "off", kind: "tavily", enabled: false, now: AT });
    await bare.store
      .asPort()
      .repositories.searchProviders.add({ providerId: "home", kind: "searxng", baseUrl: "http://127.0.0.1:8888", enabled: true, now: AT });
    await bare.close();

    const stub = fakeFetch({ body: { results: [{ title: "X", url: "https://x.example" }] } });
    const composed = await composeTaviRuntime(options, { requireModelTransport: false, searchFetch: stub.doFetch });
    runtimes.push(composed);
    // No --http-allow-host: web_fetch is not offered, and web_search's description does not send the model to it.
    expect(composed.tools.get("web_search")?.description).not.toContain("web_fetch");
    const authorized = await composed.tools
      .get("web_search")
      ?.resolveBinding?.({ query: "x" }, { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" });
    expect(authorized).toBeDefined();
    const answered = await composed.tools.get("web_search")?.handler({
      ...(authorized === undefined ? {} : { expectedBindingHash: authorized.bindingHash }),
      input: { query: "x" },
      context: { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" },
      signal,
    });
    // The disabled provider was not asked: the enabled one answered first.
    expect(answered).toMatchObject({ provider: "home" });
    expect(stub.seen.map((request) => new URL(request.url).host)).toEqual(["127.0.0.1:8888"]);
    // Disabled while the runtime runs: not asked again, with no restart.
    await composed.store.asPort().repositories.searchProviders.setEnabled("home", false, AT);
    await expect(
      composed.tools.get("web_search")?.handler({
        input: { query: "x" },
        context: { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" },
        signal,
        ...(authorized === undefined ? {} : { expectedBindingHash: authorized.bindingHash }),
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(stub.seen).toHaveLength(1);

    // With hosts to fetch, web_fetch is offered and the description names it.
    await composed.store.asPort().repositories.searchProviders.setEnabled("home", true, AT);
    await composed.close();
    runtimes.splice(runtimes.indexOf(composed), 1);
    const fetching = await composeTaviRuntime(
      { ...options, httpAllowedHosts: ["example.com"] },
      { requireModelTransport: false, searchFetch: stub.doFetch },
    );
    runtimes.push(fetching);
    expect(fetching.tools.get("web_search")?.description).toContain("use web_fetch");
  });

  it("serves a person allowed in the workspace from its provider, and the owner starts with them allowed", async () => {
    const directory = directories.create("tavi-search-");
    const options = {
      dataDirectory: directory,
      workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
      providers: [],
      credentials: {},
      defaultConnectionId: "none",
      defaultModel: "none",
      logger: { level: "error" as const, sink: () => undefined },
      scheduleSweepEnabled: false,
    };
    const bare = await composeTaviRuntime(options, { requireModelTransport: false });
    await bare.store
      .asPort()
      .repositories.searchProviders.add({ providerId: "home", kind: "searxng", baseUrl: "http://127.0.0.1:8888", enabled: true, now: AT });
    // Allowed over a channel under a principal of their own (Settings → Channels → People): the routine bindings
    // resolve web_search for them as the owner starts, which refused them and stopped the owner.
    await bare.store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "telegram-1",
      externalSenderId: "4242",
      workspaceId: "default",
      principalId: "robin",
      approvedBy: "operator",
      createdAt: AT,
    });
    await bare.close();

    const stub = fakeFetch({ body: { results: [{ title: "X", url: "https://x.example" }] } });
    const composed = await composeTaviRuntime(options, { requireModelTransport: false, searchFetch: stub.doFetch });
    runtimes.push(composed);
    const as = (principalId: string) => ({ workspaceId: "default", principalId, runId: "run-1", caller: "test" });
    const authorized = await composed.tools.get("web_search")?.resolveBinding?.({ query: "x" }, as("robin"));
    expect(authorized?.binding.principalId).toBe("robin");
    expect(
      await composed.tools.get("web_search")?.handler({
        input: { query: "x" },
        context: as("robin"),
        signal,
        ...(authorized === undefined ? {} : { expectedBindingHash: authorized.bindingHash }),
      }),
    ).toMatchObject({ provider: "home" });
    // Someone not allowed there is still refused.
    await expect(composed.tools.get("web_search")?.resolveBinding?.({ query: "x" }, as("stranger"))).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
  });

  it("binds a stored provider to the secret behind its reference, so a replaced key is a new binding", async () => {
    const directory = directories.create("tavi-search-");
    const options = {
      dataDirectory: directory,
      workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
      providers: [],
      credentials: {},
      defaultConnectionId: "none",
      defaultModel: "none",
      logger: { level: "error" as const, sink: () => undefined },
      scheduleSweepEnabled: false,
    };
    mkdirSync(join(directory, "credentials"), { mode: 0o700 });
    const key = (value: string) => writeFileSync(join(directory, "credentials", "tavily.apiKey"), value, { mode: 0o600 });
    key("first-account-key");
    const bare = await composeTaviRuntime(options, { requireModelTransport: false });
    await bare.store
      .asPort()
      .repositories.searchProviders.add({ providerId: "tavily", kind: "tavily", credentialRef: "tavily.apiKey", enabled: true, now: AT });
    await bare.close();

    const composed = await composeTaviRuntime(options, {
      requireModelTransport: false,
      searchFetch: fakeFetch({ body: { results: [] } }).doFetch,
    });
    runtimes.push(composed);
    const context = { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" };
    const before = await composed.tools.get("web_search")?.resolveBinding?.({ query: "x" }, context);
    expect(before).toBeDefined();
    expect((await composed.tools.get("web_search")?.resolveBinding?.({ query: "x" }, context))?.bindingHash).toBe(before?.bindingHash);
    key("second-account-key");
    const after = await composed.tools.get("web_search")?.resolveBinding?.({ query: "x" }, context);
    expect(after?.binding.accountId).toBe(before?.binding.accountId);
    expect(after?.bindingHash).not.toBe(before?.bindingHash);
  });

  it("starts with two enabled providers and no selection, and reports the ambiguity on each call", async () => {
    const directory = directories.create("tavi-search-");
    const options = {
      dataDirectory: directory,
      workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
      providers: [],
      credentials: {},
      defaultConnectionId: "none",
      defaultModel: "none",
      logger: { level: "error" as const, sink: () => undefined },
      scheduleSweepEnabled: false,
    };
    const bare = await composeTaviRuntime(options, { requireModelTransport: false });
    await bare.store
      .asPort()
      .repositories.searchProviders.add({ providerId: "one", kind: "searxng", baseUrl: "http://127.0.0.1:8888", enabled: true, now: AT });
    await bare.store
      .asPort()
      .repositories.searchProviders.add({ providerId: "two", kind: "searxng", baseUrl: "http://127.0.0.1:8889", enabled: true, now: AT });
    await bare.close();

    const stub = fakeFetch({ body: { results: [{ title: "X", url: "https://x.example" }] } });
    const composed = await composeTaviRuntime(options, { requireModelTransport: false, searchFetch: stub.doFetch });
    runtimes.push(composed);
    const context = { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" };
    const tool = composed.tools.get("web_search");
    expect(tool).toBeDefined();
    for (let call = 0; call < 2; call++) {
      await expect(tool?.resolveBinding?.({ query: "x" }, context)).rejects.toMatchObject({
        code: "NOT_CONFIGURED",
        message: expect.stringContaining("web-providers.json"),
      });
    }
    expect(stub.seen).toEqual([]);
  });

  it("does not ask a stored provider whose key is not its own — named for a model, or taken by one since", async () => {
    const directory = directories.create("tavi-search-");
    const logged: { message: string; fields?: Record<string, unknown> }[] = [];
    const options = {
      dataDirectory: directory,
      workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
      providers: [],
      credentials: {},
      defaultConnectionId: "none",
      defaultModel: "none",
      logger: { level: "warn" as const, sink: (line: string) => void logged.push(JSON.parse(line) as { message: string }) },
      scheduleSweepEnabled: false,
    };
    const first = await composeTaviRuntime(options, { requireModelTransport: false });
    const repositories = first.store.asPort().repositories;
    // Stored before the rule: a model's key under its own name.
    await repositories.searchProviders.add({ providerId: "old", kind: "brave", credentialRef: "openai.apiKey", enabled: true, now: AT });
    // A search reference that a model connection took since.
    await repositories.searchProviders.add({ providerId: "taken", kind: "serper", credentialRef: "search.shared", enabled: true, now: AT });
    await repositories.modelConfig.upsertConnection({
      connectionId: "main",
      label: "Main",
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      credentialRef: "search.shared",
      localOnly: false,
      createdAt: AT,
      updatedAt: AT,
    });
    await first.close();
    const composed = await composeTaviRuntime(options, { requireModelTransport: false });
    runtimes.push(composed);
    // Neither is asked, so none is offered; each is said once.
    expect(composed.tools.get("web_search")).toBeUndefined();
    const warned = logged.filter((line) => line.message === "a search provider's key is not its own; web_search does not ask it");
    expect(warned.map((line) => line.fields?.["providerId"] ?? (line as unknown as { providerId?: string }).providerId).sort()).toEqual([
      "old",
      "taken",
    ]);
  });

  it("reports a stored provider it cannot read, and leaves it out", async () => {
    const directory = directories.create("tavi-search-");
    const logged: { message: string; fields?: Record<string, unknown> }[] = [];
    const options = {
      dataDirectory: directory,
      workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
      providers: [],
      credentials: {},
      defaultConnectionId: "none",
      defaultModel: "none",
      logger: { level: "warn" as const, sink: (line: string) => void logged.push(JSON.parse(line) as { message: string }) },
      scheduleSweepEnabled: false,
    };
    const first = await composeTaviRuntime(options, { requireModelTransport: false });
    inspectDatabase(first.store)
      .prepare("INSERT INTO tavi_search_providers (provider_id, kind, enabled, created_at, updated_at) VALUES ('broken', 'brave', 1, ?, ?)")
      .run(AT, AT);
    await first.close();
    const composed = await composeTaviRuntime(options, { requireModelTransport: false });
    runtimes.push(composed);
    expect(logged.some((line) => line.message === "a configured search provider could not be read and is not used")).toBe(true);
    expect(composed.tools.get("web_search")).toBeUndefined();
  });
});

it("reserves and records each authorized search provider attempt, including a failed fallback", async () => {
  const attempts: import("@tavi/contracts").ProviderOperation[] = [];
  const finished: string[] = [];
  const first = fakeFetch({ status: 503, body: {} });
  const second = fakeFetch({ body: { results: [{ url: "https://source.example", title: "Source" }] } });
  const providers = [
    createWebSearchAdapter(provider({ providerId: "a", kind: "searxng", baseUrl: "https://a.example" }), {
      readSecret: keys,
      fetch: first.doFetch,
    }),
    createWebSearchAdapter(provider({ providerId: "b", kind: "searxng", baseUrl: "https://b.example" }), {
      readSecret: keys,
      fetch: second.doFetch,
    }),
  ];
  const execution = {
    ownerSession: "owner",
    implementationHash: "a".repeat(64),
    signal,
    actsIn: (workspaceId: string, principalId: string) => principalId === (workspaceId === "w" ? "operator" : undefined),
    ledger: {
      reserveOperation: async (operation: import("@tavi/contracts").ProviderOperation) => {
        attempts.push(operation);
      },
      finishOperation: async (_run: string, _attempt: string, state: string) => {
        finished.push(state);
      },
      operations: async () => [],
    },
  };
  const registry = new ToolRegistry();
  await registerWebSearchTool(registry, () => providers, {
    ...execution,
    selection: () => ({ providers: ["a", "b"], timeoutMs: 10_000 }),
    resolve: async (provider, context) =>
      scopedProvider(
        execution,
        context,
        {
          kind: "search",
          instanceId: provider.id,
          accountId: provider.id,
          endpoint: `https://${provider.id}.example`,
          configRevision: "b".repeat(64),
        },
        provider,
      ),
  });
  const context = { workspaceId: "w", principalId: "operator", runId: "search-run", caller: "routine" };
  const binding = await registry.get("web_search")?.resolveBinding?.({ query: "q" }, context);
  if (binding === undefined) throw new Error("missing binding");
  let budget = 0;
  const result = await registry.get("web_search")?.handler({
    input: { query: "q" },
    context,
    signal,
    expectedBindingHash: binding.bindingHash,
    reserveProviderAttempt: async () => {
      budget++;
    },
  });
  expect(result).toMatchObject({ provider: "b" });
  expect(budget).toBe(2);
  expect(attempts.map((attempt) => attempt.binding.accountId)).toEqual(["a", "b"]);
  expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(2);
  expect(finished).toEqual(["uncertain", "completed"]);
  expect(first.seen).toHaveLength(1);
  expect(second.seen).toHaveLength(1);
  await expect(
    registry
      .get("web_search")
      ?.handler({ input: { query: "q" }, context: { ...context, workspaceId: "other" }, signal, expectedBindingHash: binding.bindingHash }),
  ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  expect(first.seen).toHaveLength(1);
});
