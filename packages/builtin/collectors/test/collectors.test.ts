import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Project, ProjectRepositoryPort, SecretReaderPort, ToolRegistrar } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_DOCUMENT_BYTES,
  MAX_TOOL_RESULT_BYTES,
  NEWS_TRIMMED_NOTE,
  NOTES_TRIMMED_NOTE,
  boundDocument,
  loadProjects,
  minorUnitsToMajor,
  monthlyAmount,
  omittedNote,
  parseFeed,
  periodFor,
  registerCollectorTools,
  relevance,
  type ProjectReport,
} from "../src/collectors.js";

/** A registry that keeps what is registered as the host's does, a built-in's (`builtIn`), for its handler to be called. */
class ToolRegistry {
  readonly #tools = new Map<string, Parameters<ToolRegistrar["register"]>[0] & { readonly builtIn: true }>();
  register(definition: Parameters<ToolRegistrar["register"]>[0]): void {
    this.#tools.set(definition.id, { ...definition, builtIn: true });
  }
  get(id: string) {
    return this.#tools.get(id);
  }
  /** The tools offered in `context`, as the host's registry answers: those whose `offered` says so, or has none. */
  async listOffered(context: Parameters<NonNullable<Parameters<ToolRegistrar["register"]>[0]["offered"]>>[0]) {
    const offered = [];
    for (const tool of this.#tools.values()) if (tool.offered === undefined || (await tool.offered(context))) offered.push(tool);
    return offered;
  }
}

/**
 * The deterministic collectors. These pin the properties
 * the unattended 07:00 run depends on: a fixed provider endpoint, per-source
 * isolation including credential resolution, bounded output, and notes that
 * carry no filesystem paths.
 */

const directories = temporaryDirectories();

afterEach(() => directories.cleanup());

function projectDirectory(projects: unknown): string {
  const directory = directories.create("tavi-collectors-");
  writeFileSync(join(directory, "projects.json"), JSON.stringify(projects), { mode: 0o600 });
  return directory;
}

let serviceAccountJson: string;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  serviceAccountJson = JSON.stringify({ client_email: "spike@example.iam.gserviceaccount.com", private_key: privateKey });
});

function secretReader(values: Readonly<Record<string, string>>): SecretReaderPort {
  return {
    async getSecret(reference: string): Promise<string | null> {
      return values[reference] ?? null;
    },
  };
}

interface RouteResult {
  readonly status?: number;
  readonly body?: unknown;
  readonly text?: string;
}

/** A fetch stub that routes by `${hostname}${pathname}`, recording every call. */
function stubFetch(routes: Readonly<Record<string, RouteResult | ((url: URL) => RouteResult)>>): {
  readonly impl: typeof fetch;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const key = `${url.hostname}${url.pathname}`;
    calls.push(key);
    const route = routes[key] ?? Object.entries(routes).find(([prefix]) => key.startsWith(prefix))?.[1];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: { message: `no stub for ${key}` } }), { status: 404 });
    }
    const result = typeof route === "function" ? route(url) : route;
    const status = result.status ?? 200;
    if (result.text !== undefined) return new Response(result.text, { status });
    return new Response(JSON.stringify(result.body ?? {}), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

function toolResult(registry: ToolRegistry, id: string, input: unknown): Promise<unknown> {
  const tool = registry.get(id);
  if (tool === undefined) throw new Error(`${id} is not registered`);
  return tool.handler({
    input,
    context: { workspaceId: "w1", principalId: "alice", runId: "run-1", caller: "model" },
    signal: new AbortController().signal,
  });
}

const PROJECTS = {
  googleServiceAccountRef: "google.serviceAccount",
  lookbackDays: 7,
  news: { feedUrls: ["https://news.example/rss"], maxItemsPerProject: 3 },
  projects: [
    {
      id: "acme",
      name: "Acme",
      ga4PropertyId: "properties/1",
      gscSiteUrl: "sc-domain:acme.example",
      stripeCredentialRef: "acme.stripe.key",
      keywords: ["acme"],
    },
    { id: "globex", name: "Globex", ga4PropertyId: "properties/2" },
  ],
};

const GA4_BODY = { rows: [{ metricValues: [{ value: "406" }, { value: "360" }, { value: "0" }] }] };
const GSC_BODY = {
  rows: [
    { clicks: 100, impressions: 1_000, position: 6 },
    { clicks: 10, impressions: 1_000, position: 4 },
  ],
};

/**
 * An in-memory registry over a `ProjectsFile` fixture.
 *
 * The registry is the collectors' only source for which projects exist, so these
 * tests seed it directly rather than writing a `projects.json` — that file is now
 * only `tavi projects import`'s input, and a fake keeps these tests about the
 * collectors rather than about SQLite.
 */
function registryFixture(file: {
  readonly googleServiceAccountRef?: string;
  readonly lookbackDays?: number;
  readonly news?: { readonly feedUrls?: readonly string[]; readonly maxItemsPerProject?: number; readonly searchCredentialRef?: string };
  readonly projects: readonly Project[];
  /** Rows a real store would report as unreadable, so the reporting paths can be driven. */
  readonly unreadable?: readonly string[];
}): ProjectRepositoryPort {
  const records = file.projects.map((project) => ({
    ...project,
    workspaceId: "default",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const settings = {
    ...(file.googleServiceAccountRef === undefined ? {} : { googleServiceAccountRef: file.googleServiceAccountRef }),
    ...(file.lookbackDays === undefined ? {} : { lookbackDays: file.lookbackDays }),
    ...(file.news === undefined
      ? {}
      : {
          news: {
            ...(file.news.feedUrls === undefined ? {} : { feedUrls: [...file.news.feedUrls] }),
            ...(file.news.maxItemsPerProject === undefined ? {} : { maxItemsPerProject: file.news.maxItemsPerProject }),
            ...(file.news.searchCredentialRef === undefined ? {} : { searchCredentialRef: file.news.searchCredentialRef }),
          },
        }),
  };
  return {
    create: () => {
      throw new Error("not used");
    },
    get: async (_workspaceId, projectId) => records.find((record) => record.id === projectId),
    list: async () => ({ projects: records, unreadable: file.unreadable ?? [] }),
    remove: async () => false,
    update: async () => false,
    getSettings: async () => settings,
    putSettings: async () => settings,
  };
}

function registryWith(
  routes: Parameters<typeof stubFetch>[0],
  values: Record<string, string> = {},
  options: { readonly unreadable?: readonly string[]; readonly projects?: readonly Project[] } = {},
): {
  readonly registry: ToolRegistry;
  readonly calls: string[];
} {
  const stub = stubFetch(routes);
  const registry = new ToolRegistry();
  registerCollectorTools(registry, {
    dataDirectory: projectDirectory(PROJECTS),
    secretReader: secretReader({ "google.serviceAccount": serviceAccountJson, ...values }),
    projects: registryFixture({
      ...PROJECTS,
      ...(options.projects === undefined ? {} : { projects: options.projects }),
      ...(options.unreadable === undefined ? {} : { unreadable: options.unreadable }),
    }),
    fetchImpl: stub.impl,
    now: () => new Date("2026-09-16T07:00:00Z"),
  });
  return { registry, calls: stub.calls };
}

describe("collect.daily news search", () => {
  const SEARCH_BODY = {
    results: [
      {
        title: "Acme raises a round",
        url: "https://news.example/acme-round",
        content: "Acme, the acme of acme stories, raised money.",
        published_date: "2026-09-15T00:00:00Z",
      },
      // A hostile or sloppy result: a non-http destination must be dropped.
      { title: "Click here", url: "javascript:alert(1)", content: "acme" },
      // …and a *plain* http one, because the report hands these links to a
      // reader and the docs promise https only.
      { title: "Downgraded acme", url: "http://news.example/insecure", content: "acme" },
      // No title: nothing to show the reader.
      { title: "", url: "https://news.example/untitled", content: "acme" },
    ],
  };

  it("queries the configured provider with the project's keywords and maps its results", async () => {
    const stub = stubFetch({
      "api.tavily.com/search": { body: SEARCH_BODY },
      "news.example/rss": { text: "<rss><channel></channel></rss>" },
    });
    // The request is captured so the bearer key and the query can be asserted.
    let captured: { readonly url: string; readonly init: RequestInit | undefined } | undefined;
    const registry = new ToolRegistry();
    registerCollectorTools(registry, {
      dataDirectory: projectDirectory(PROJECTS),
      secretReader: secretReader({ "google.serviceAccount": serviceAccountJson, "acme.search.key": "tvly-secret" }),
      projects: registryFixture({
        ...PROJECTS,
        news: { feedUrls: ["https://news.example/rss"], maxItemsPerProject: 3, searchCredentialRef: "acme.search.key" },
      }),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith("https://api.tavily.com")) captured = { url, init };
        return stub.impl(input as never, init as never);
      }) as typeof fetch,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });

    const result = (await toolResult(registry, "collect.daily", { projectIds: ["acme"] })) as {
      projects: {
        news: { title: string; url: string; source: string; snippet?: string; publishedAt?: string }[];
        notes: readonly string[];
      }[];
    };
    const news = result.projects[0]?.news ?? [];
    expect(news.some((item) => item.title === "Acme raises a round" && item.source === "search")).toBe(true);
    // The non-https URLs and the untitled entry were dropped, while the good one
    // was kept.
    expect(news.some((item) => item.url.includes("javascript:"))).toBe(false);
    expect(news.some((item) => item.url.startsWith("http://"))).toBe(false);
    expect(news.some((item) => item.url === "https://news.example/acme-round")).toBe(true);
    expect(news.every((item) => item.url.startsWith("https://"))).toBe(true);

    expect(captured?.url).toBe("https://api.tavily.com/search");
    expect((captured?.init?.headers as Record<string, string> | undefined)?.["authorization"]).toBe("Bearer tvly-secret");
    const body = JSON.parse(String(captured?.init?.body)) as { query: string };
    expect(body.query).toBe("acme");
    // The key never reaches the model-facing result.
    expect(JSON.stringify(result)).not.toContain("tvly-secret");
  });

  it("names an unresolvable credential and an unavailable provider, without failing the project", async () => {
    // `registryWith` keeps the fixture's settings, which name no search ref, so
    // the missing-credential case needs a fixture that does.
    const registry = new ToolRegistry();
    registerCollectorTools(registry, {
      dataDirectory: projectDirectory(PROJECTS),
      secretReader: secretReader({ "google.serviceAccount": serviceAccountJson }),
      projects: registryFixture({
        ...PROJECTS,
        news: { feedUrls: ["https://news.example/rss"], searchCredentialRef: "acme.search.key" },
      }),
      fetchImpl: stubFetch({ "news.example/rss": { text: "<rss><channel></channel></rss>" } }).impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });
    const missing = (await toolResult(registry, "collect.daily", { projectIds: ["acme"] })) as {
      projects: { notes: readonly string[] }[];
    };
    // The note names the class of failure and no path (it reaches the model, the
    // PDF and Telegram), which is what `errorNote` is for.
    expect(missing.projects[0]?.notes).toContain("news: the configured search credential is not configured");

    const unavailable = new ToolRegistry();
    registerCollectorTools(unavailable, {
      dataDirectory: projectDirectory(PROJECTS),
      secretReader: secretReader({ "google.serviceAccount": serviceAccountJson, "acme.search.key": "tvly-secret" }),
      projects: registryFixture({
        ...PROJECTS,
        news: { feedUrls: ["https://news.example/rss"], searchCredentialRef: "acme.search.key" },
      }),
      fetchImpl: stubFetch({
        "news.example/rss": { text: "<rss><channel></channel></rss>" },
        "api.tavily.com/search": { status: 503, body: {} },
      }).impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });
    const failed = (await toolResult(unavailable, "collect.daily", { projectIds: ["acme"] })) as {
      projects: { notes: readonly string[] }[];
    };
    expect(failed.projects[0]?.notes).toContain("news: the search provider was unavailable");

    const rejected = new ToolRegistry();
    registerCollectorTools(rejected, {
      dataDirectory: projectDirectory(PROJECTS),
      secretReader: secretReader({ "google.serviceAccount": serviceAccountJson, "acme.search.key": "tvly-secret" }),
      projects: registryFixture({
        ...PROJECTS,
        news: { feedUrls: ["https://news.example/rss"], searchCredentialRef: "acme.search.key" },
      }),
      fetchImpl: stubFetch({
        "news.example/rss": { text: "<rss><channel></channel></rss>" },
        "api.tavily.com/search": { status: 401, body: {} },
      }).impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });
    const unauthorized = (await toolResult(rejected, "collect.daily", { projectIds: ["acme"] })) as {
      projects: { notes: readonly string[] }[];
    };
    // A rejected key is the operator's to fix; calling it "unavailable" sent them
    // to retry a provider that is working fine.
    expect(unauthorized.projects[0]?.notes).toContain("news: the search provider rejected the configured credential");

    const noKeywords = new ToolRegistry();
    registerCollectorTools(noKeywords, {
      dataDirectory: projectDirectory(PROJECTS),
      secretReader: secretReader({ "google.serviceAccount": serviceAccountJson, "acme.search.key": "tvly-secret" }),
      projects: registryFixture({
        ...PROJECTS,
        news: { searchCredentialRef: "acme.search.key" },
        projects: [{ id: "acme", name: "Acme" }],
      }),
      fetchImpl: stubFetch({}).impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });
    const silent = (await toolResult(noKeywords, "collect.daily", { projectIds: ["acme"] })) as {
      projects: { notes: readonly string[] }[];
    };
    expect(silent.projects[0]?.notes).toContain(
      "news: the search provider is configured but this project has no keywords, so no search was run",
    );
  });
});

describe("collector tools — registration and shape", () => {
  it("registers the five sources and the pipeline as read-only tools", () => {
    const { registry } = registryWith({});
    for (const id of ["ga4.report", "gsc.query", "gcp.billing", "stripe.subscriptions", "news.search", "collect.daily"]) {
      // `read-only` is the point: an unattended run must not raise an approval
      // interrupt nothing under `serve` can answer.
      expect(registry.get(id)?.effect).toBe("read-only");
    }
  });

  it("offers the per-project sources only where a project is configured", async () => {
    // A chat in a fresh deployment reached for `news.search`, spent a turn on
    // the refusal and relayed it: a per-project source with no project is a tool
    // the model can only misfire on. `projects.get` (how it learns there is
    // nothing) and `collect.daily` (which reports that itself) stay.
    const perProject = ["ga4.report", "gsc.query", "gcp.billing", "stripe.subscriptions", "news.search"];
    const configured = (await registryWith({}).registry.listOffered({ workspaceId: "default" })).map((tool) => tool.id);
    expect(configured).toEqual(expect.arrayContaining([...perProject, "projects.get", "collect.daily"]));
    const empty = (await registryWith({}, {}, { projects: [] }).registry.listOffered({ workspaceId: "default" })).map((tool) => tool.id);
    expect(empty).toEqual(expect.arrayContaining(["projects.get", "collect.daily"]));
    for (const id of perProject) expect(empty).not.toContain(id);
    // An unreadable row is still "a project": the source stays offered so its
    // reporting path (the unreadable note) is reachable.
    const unreadable = (
      await registryWith({}, {}, { projects: [], unreadable: ["broken"] }).registry.listOffered({ workspaceId: "default" })
    ).map((tool) => tool.id);
    expect(unreadable).toContain("news.search");
  });

  it("rejects an unknown project rather than guessing", async () => {
    const { registry } = registryWith({});
    await expect(toolResult(registry, "ga4.report", { projectId: "nope" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("names the configured projects and the web_search fallback when the project id is a guess", async () => {
    // A chat asked `news.search` about a domain no project covers, was told only
    // "not configured", and gave up. The ids that *are* configured and the
    // general-purpose path are what let the model recover in one step.
    const { registry } = registryWith({});
    await expect(toolResult(registry, "news.search", { projectId: "typesafe.ai" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringMatching(/configured projects: acme, globex.*call web_search/),
      details: { configuredProjectIds: ["acme", "globex"] },
    });
  });

  it("gives the same recovery when the registry is empty, not the operator's `tavi projects add`", async () => {
    // A fresh deployment's first chat hit this: `loadProjects` refused with an
    // instruction for the operator, the model relayed it, and nothing searched.
    const { registry } = registryWith({}, {}, { projects: [] });
    await expect(toolResult(registry, "news.search", { projectId: "typesafe.ai" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringMatching(/no projects are configured.*call web_search/),
      details: { configuredProjectIds: [] },
    });
  });
});

describe("collector tools — per-source isolation", () => {
  it("collects GA4, GSC and Stripe when they work, and requests only one conversion metric", async () => {
    const { registry } = registryWith(
      {
        "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
        "analyticsdata.googleapis.com/v1beta/properties/1:runReport": { body: GA4_BODY },
        "searchconsole.googleapis.com/webmasters/v3": { body: GSC_BODY },
        "api.stripe.com/v1/subscriptions": { body: { data: [], has_more: false } },
        // `currency` is required to read an amount: an amount whose unit is unknown
        // is excluded now rather than assumed to be dollars.
        "api.stripe.com/v1/charges": { body: { data: [{ paid: true, amount: 5000, currency: "usd", created: 1_789_000_000 }] } },
        "news.example/rss": { text: "<rss><channel></channel></rss>" },
      },
      { "acme.stripe.key": "sk_test_x" },
    );

    const report = (await toolResult(registry, "ga4.report", { projectId: "acme" })) as ProjectReport;
    expect(report.metrics.map((metric) => metric.key)).toEqual(["sessions", "users", "conversions"]);
    expect(report.metrics.find((metric) => metric.key === "sessions")?.value).toBe(406);

    const gsc = (await toolResult(registry, "gsc.query", { projectId: "acme" })) as ProjectReport;
    expect(gsc.metrics.find((metric) => metric.key === "clicks")?.value).toBe(110);
    // Position is impression-weighted, not a plain mean.
    expect(gsc.metrics.find((metric) => metric.key === "position")?.value).toBe(5);

    const stripe = (await toolResult(registry, "stripe.subscriptions", { projectId: "acme" })) as ProjectReport;
    expect(stripe.metrics.map((metric) => metric.key)).toEqual(["mrr", "revenue", "churn"]);
    expect(stripe.notes.join(" ")).toContain("no subscriptions");
  });

  it("turns a dead source into a note and keeps the others", async () => {
    const { registry } = registryWith(
      {
        "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
        "analyticsdata.googleapis.com/v1beta/properties/1:runReport": { status: 403, body: {} },
        "searchconsole.googleapis.com/webmasters/v3": { body: GSC_BODY },
        "api.stripe.com/v1/subscriptions": { status: 401, body: {} },
        "news.example/rss": { text: "<rss><channel></channel></rss>" },
      },
      { "acme.stripe.key": "sk_test_x" },
    );

    const report = (await toolResult(registry, "collect.daily", { projectIds: ["acme"] })) as {
      projects: ProjectReport[];
    };
    const acme = report.projects[0];
    expect(acme).toBeDefined();
    // GA4 failed, GSC still landed, Stripe failed — one section each, not the run.
    expect(acme?.metrics.map((metric) => metric.key)).toContain("clicks");
    expect(acme?.metrics.map((metric) => metric.key)).not.toContain("sessions");
    expect(acme?.notes.join(" | ")).toContain("ga4 is unavailable");
    expect(acme?.notes.join(" | ")).toContain("stripe is unavailable");
    // Notes never carry a filesystem path.
    expect(acme?.notes.join(" ")).not.toContain("/");
  });

  it("says a source is unconfigured instead of dispatching against it", async () => {
    const stub = stubFetch({ "news.example/rss": { text: "<rss><channel></channel></rss>" } });
    const registry = new ToolRegistry();
    // No Google credential at all: `googleServiceAccountRef` is configured in
    // the projects file, but the store has no value for it.
    registerCollectorTools(registry, {
      dataDirectory: projectDirectory(PROJECTS),
      secretReader: secretReader({}),
      projects: registryFixture(PROJECTS),
      fetchImpl: stub.impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });

    const report = (await toolResult(registry, "collect.daily", { projectIds: ["globex"] })) as { projects: ProjectReport[] };
    const globex = report.projects[0];
    // Nothing but the news feed was contacted — no provider call was attempted
    // with an absent credential, which would send `Bearer undefined`.
    expect(stub.calls.filter((call) => !call.startsWith("news.example"))).toEqual([]);
    expect(globex?.notes.join(" ")).toContain("google is not configured");
  });

  it("notes a missing Stripe reference without calling Stripe", async () => {
    const { registry, calls } = registryWith({
      "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
      "analyticsdata.googleapis.com/v1beta/properties/2:runReport": { body: GA4_BODY },
    });
    const report = (await toolResult(registry, "collect.daily", { projectIds: ["globex"] })) as { projects: ProjectReport[] };
    expect(report.projects[0]?.notes.join(" ")).toContain("stripe is not configured");
    expect(calls.some((call) => call.startsWith("api.stripe.com"))).toBe(false);
  });
});

describe("collect.daily — bounding", () => {
  it("keeps a large multi-project document under the review gate", async () => {
    const bigFeed = `<rss><channel>${Array.from({ length: 200 }, (_, index) => `<item><title>acme story ${index}</title><link>https://news.example/${index}</link><description>${"x".repeat(300)}</description></item>`).join("")}</channel></rss>`;
    const { registry } = registryWith(
      {
        "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
        "analyticsdata.googleapis.com/v1beta/properties/1:runReport": { body: GA4_BODY },
        "searchconsole.googleapis.com/webmasters/v3": { body: GSC_BODY },
        "api.stripe.com/v1/subscriptions": { body: { data: [], has_more: false } },
        "api.stripe.com/v1/charges": { body: { data: [] } },
        "news.example/rss": { text: bigFeed },
      },
      { "acme.stripe.key": "sk_test_x" },
    );
    const document = (await toolResult(registry, "collect.daily", {})) as { projects: ProjectReport[] };
    expect(Buffer.byteLength(JSON.stringify(document))).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
  });

  it("bounds a document that is over the gate by trimming news and saying so", () => {
    const document = {
      projects: [
        {
          id: "a",
          name: "A",
          metrics: [],
          notes: [],
          news: Array.from({ length: 2_000 }, (_, index) => ({
            title: `t${index}`,
            url: `https://e/${index}`,
            source: "e",
            snippet: "x".repeat(400),
          })),
        },
      ] as ProjectReport[],
    };
    const bounded = boundDocument(document);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    // The exact constant, not the substring "trimmed": the two markers mean
    // different things and a reader must be able to tell which fired.
    expect(bounded.projects[0]?.notes).toContain(NEWS_TRIMMED_NOTE);
  });

  /**
   * A reproduced regression. The first implementation
   * called its marker-add *inside* the trim loop, so once the marker was the only
   * removable entry the loop deleted it and immediately re-added it: the array
   * never shrank, `over()` never turned false, and this function never returned.
   *
   * NOTE: a reintroduced synchronous loop HANGS the worker rather than failing it
   * — nothing in-process can interrupt it — so these tests passing at all is the
   * termination guard. What they assert quickly is the *other* half of the fix:
   * that a trimmed project says so, and that a marker can never be the reason a
   * compliant brief is refused.
   */
  it("terminates when the notes alone exceed the budget", () => {
    // No news at all, two notes, and a metric big enough that removing notes is
    // the only thing the notes pass can do. The old code oscillated on exactly
    // this shape.
    const document = {
      projects: [
        {
          id: "a",
          name: "A",
          metrics: [{ key: "k", label: "x".repeat(80 * 1024), value: 1, unit: "count", source: "ga4" }],
          news: [],
          notes: ["ga4 is not configured", "stripe is not configured"],
        },
      ] as ProjectReport[],
    };
    expect(() => boundDocument(document)).toThrow(/size budget/);
  });

  it("marks every project it trimmed, exactly once, and keeps both markers", () => {
    const project = (id: string): ProjectReport =>
      ({
        id,
        name: id,
        metrics: [{ key: "k", label: "y".repeat(6 * 1024), value: 1, unit: "count", source: "ga4" }],
        news: [{ title: "t", url: "https://e/1", source: "e", snippet: "s".repeat(200) }],
        notes: ["ga4 is not configured", "n".repeat(4 * 1024)],
      }) as ProjectReport;
    const bounded = boundDocument({ projects: Array.from({ length: 12 }, (_, index) => project(`p${index}`)) });
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    const trimmed = bounded.projects.filter((entry) => entry.notes.includes(NEWS_TRIMMED_NOTE) || entry.notes.includes(NOTES_TRIMMED_NOTE));
    expect(trimmed.length).toBeGreaterThan(0);
    for (const entry of trimmed) {
      // Presence and uniqueness: `<= 1` alone passes at 0, which would let a
      // future edit delete the marker line undetected.
      expect(entry.notes.filter((note) => note === NEWS_TRIMMED_NOTE).length).toBeLessThanOrEqual(1);
      expect(entry.notes.filter((note) => note === NOTES_TRIMMED_NOTE).length).toBeLessThanOrEqual(1);
      // The news marker sits at the tail and must survive the notes pass, or the
      // brief misattributes the truncation to notes.
      expect(entry.news.length === 0 ? entry.notes.includes(NEWS_TRIMMED_NOTE) : true).toBe(true);
    }
  });

  it("returns a bounded brief instead of refusing when only the marker exceeds the cap", () => {
    // One byte over the cap, and the only removable entry is a single news item
    // whose removal frees just enough room that the 64-byte marker no longer
    // fits. Refusing here would fail an unattended run that had already been
    // rescued by trimming.
    const pad = MAX_DOCUMENT_BYTES - 200 + 86;
    const document = {
      projects: [
        { id: "a", name: "n".repeat(pad), metrics: [], news: [{ title: "t", url: "https://e/0", source: "e" }], notes: [] },
      ] as ProjectReport[],
    };
    const bounded = boundDocument(document);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    expect(bounded.projects[0]?.news).toHaveLength(0);
  });

  it("keeps the earliest notes, appends the marker last, and never mutates the caller", () => {
    const notes = ["ga4 is not configured", "gsc is not configured"];
    const refused = {
      projects: [
        {
          id: "a",
          name: "A",
          metrics: [{ key: "k", label: "z".repeat(80 * 1024), value: 1, unit: "count", source: "ga4" }],
          news: [],
          notes,
        },
      ] as ProjectReport[],
    };
    expect(() => boundDocument(refused)).toThrow(/size budget/);
    expect(notes).toEqual(["ga4 is not configured", "gsc is not configured"]);

    // The trimmed path keeps the earliest notes in order and puts the marker at
    // the end — a `shift()`-based regression would evict the earliest instead.
    // The payload has to be genuinely over budget for any of this to happen: a
    // 30 KiB metric plus a 40 KiB note is ~71 KiB against a 60 KiB cap, and
    // dropping the note alone brings it back under.
    const trimmed = boundDocument({
      projects: [
        {
          id: "a",
          name: "A",
          metrics: [{ key: "k", label: "z".repeat(30 * 1024), value: 1, unit: "count", source: "ga4" }],
          news: [],
          notes: ["ga4 is not configured", "gsc is not configured", "s".repeat(40 * 1024)],
        },
      ] as ProjectReport[],
    });
    const survivors = trimmed.projects[0]?.notes ?? [];
    expect(survivors[0]).toBe("ga4 is not configured");
    expect(survivors.at(-1)).toBe(NOTES_TRIMMED_NOTE);
    expect(survivors.filter((note) => note === NOTES_TRIMMED_NOTE)).toHaveLength(1);
  });

  it("says so when it drops whole projects, in both directions", () => {
    const project = (id: string): ProjectReport =>
      ({ id, name: id, metrics: [], news: [], notes: ["x".repeat(40 * 1024)] }) as ProjectReport;
    const bounded = boundDocument({ projects: [project("a"), project("b"), project("c")] });
    expect(bounded.projects.length).toBeLessThan(3);
    expect(bounded.projects[0]?.id).toBe("a");
    // A brief that silently loses a project is the "looks fine, is wrong" failure
    // this module refuses to make elsewhere: the first survivor must carry the
    // count, and it must name the number actually dropped.
    const omitted = (bounded.projects[0]?.notes ?? []).find((note) => note.includes("omitted"));
    expect(omitted).toBeDefined();
    expect(omitted).toBe(omittedNote(3 - bounded.projects.length));
    // Nothing was dropped, so nothing may claim otherwise.
    const intact = boundDocument({ projects: [project("a")] });
    expect(intact.projects[0]?.notes.some((note) => note.includes("omitted"))).toBe(false);
  });
});

describe("the project registry", () => {
  it("refuses an empty registry rather than reporting a quiet week", async () => {
    // An empty brief and a deployment nobody configured look identical in the
    // output, which is the "looks fine, is wrong" failure. The
    // collectors therefore refuse, with the command that fixes it.
    const empty = registryFixture({ projects: [] });
    await expect((async () => await loadProjects(empty, "default"))()).rejects.toThrow(/no projects are configured/);
    await expect((async () => await loadProjects(empty, "default"))()).rejects.toThrow(/tavi projects add/);
    try {
      await loadProjects(empty, "default");
      expect.unreachable("an empty registry must be refused");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("INVALID_INPUT");
    }
  });

  it("excludes disabled projects, so one can be parked without deleting its accounts", async () => {
    const registry = registryFixture(PROJECTS);
    const disabled: ProjectRepositoryPort = { ...registry, list: async () => ({ projects: [], unreadable: [] }) };
    await expect((async () => await loadProjects(disabled, "default"))()).rejects.toThrow(/no projects are configured/);
    // With the registry returning them, both projects are collected.
    expect((await loadProjects(registry, "default")).projects.map((project) => project.id)).toEqual(["acme", "globex"]);
  });

  it("reads the deployment-wide settings from the same place as the projects", async () => {
    const loaded = await loadProjects(registryFixture(PROJECTS), "default");
    expect((await loaded).googleServiceAccountRef).toBe("google.serviceAccount");
    expect((await loaded).lookbackDays).toBe(7);
    expect((await loaded).news?.feedUrls).toEqual(["https://news.example/rss"]);
    // Registry bookkeeping is not part of a project's configuration.
    expect((await loaded).projects[0]).toEqual({
      id: "acme",
      name: "Acme",
      ga4PropertyId: "properties/1",
      gscSiteUrl: "sc-domain:acme.example",
      stripeCredentialRef: "acme.stripe.key",
      keywords: ["acme"],
    });
  });

  it("carries unreadable rows as a warning instead of collecting a smaller registry silently", async () => {
    const loaded = await loadProjects(registryFixture({ ...PROJECTS, unreadable: ["broken-row"] }), "default");
    expect((await loaded).warnings?.[0]).toContain("broken-row");
    // The readable projects are still collected: one bad row must not take the
    // whole workspace down.
    expect((await loaded).projects.map((project) => project.id)).toEqual(["acme", "globex"]);
  });

  it("says the registry is unreadable rather than empty when no row can be read", async () => {
    const registry = registryFixture({ projects: [], unreadable: ["broken-row"] });
    try {
      await loadProjects(registry, "default");
      expect.unreachable("an all-unreadable registry must be refused");
    } catch (error) {
      const message = (error as Error).message;
      // "add one with `tavi projects add`" would send the operator to duplicate a
      // project that already exists.
      expect(message).toContain("broken-row");
      expect(message).not.toContain("no projects are configured");
    }
  });

  it("puts the unreadable warning where the brief and the history can see it", async () => {
    const { registry } = registryWith(
      {
        "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
        "analyticsdata.googleapis.com/v1beta/properties/1:runReport": { body: GA4_BODY },
        "searchconsole.googleapis.com/webmasters/v3": { body: GSC_BODY },
        "api.stripe.com/v1/subscriptions": { body: { data: [], has_more: false } },
        "api.stripe.com/v1/charges": { body: { data: [] } },
      },
      { "acme.stripe.key": "sk_test_x" },
      { unreadable: ["broken-row"] },
    );
    const document = (await toolResult(registry, "collect.daily", {})) as { projects: ProjectReport[] };
    expect(document.projects[0]?.notes.join(" ")).toContain("broken-row");
  });

  it("applies the same configuration gate as the per-source tools", async () => {
    // `collect.daily` once selected sources by presence alone, so a
    // malformed billing table reached BigQuery SQL while `gcp.billing` refused the
    // identical project — two entry points disagreeing about what "configured"
    // means, and only one of them safe.
    const poisoned: Project[] = [
      {
        id: "acme",
        name: "Acme",
        gcp: { billingProjectId: "billing-proj", billingTable: "billing_export` WHERE 1=1 --" },
      },
    ];
    const { registry, calls } = registryWith(
      { "oauth2.googleapis.com/token": { body: { access_token: "tok" } } },
      {},
      { projects: poisoned },
    );

    const document = (await toolResult(registry, "collect.daily", {})) as { projects: ProjectReport[] };
    // No request was issued at all, and the note says why rather than failing the
    // whole brief: the other sources still ran.
    expect(calls.some((url) => url.includes("bigquery.googleapis.com"))).toBe(false);
    expect(document.projects[0]?.notes.join(" ")).toMatch(/Cloud Billing export table/);

    // And the per-source tool refuses the same project, so the two agree.
    await expect(toolResult(registry, "gcp.billing", { projectId: "acme" })).rejects.toThrow(/Cloud Billing export table/);
  });

  it("still skips a merely-absent source without a note", async () => {
    // "Not configured" is the legitimate partial-project case: it must stay silent
    // rather than turning into a degradation note.
    const { registry } = registryWith(
      { "oauth2.googleapis.com/token": { body: { access_token: "tok" } } },
      {},
      {
        projects: [{ id: "acme", name: "Acme" }],
      },
    );
    const document = (await toolResult(registry, "collect.daily", {})) as { projects: ProjectReport[] };
    expect(document.projects[0]?.notes.join(" ")).not.toMatch(/is not a/i);
  });

  it("bounds projects.get as a whole, saying what it left out", async () => {
    // 50 projects x 32 keywords x 128 chars is ~200 KiB at the schema's limits,
    // which crosses the tool-result gate — a *read* that suspends an unattended
    // turn rather than failing it.
    const projects: Project[] = Array.from({ length: 50 }, (_, index) => ({
      id: `p${index}`,
      name: `Project ${index}`,
      keywords: Array.from({ length: 32 }, (_, keyword) => `${"k".repeat(120)}-${index}-${keyword}`),
    }));
    const { registry } = registryWith({}, {}, { projects });
    const listing = (await toolResult(registry, "projects.get", {})) as { note?: string; projects: readonly unknown[] };
    expect(Buffer.byteLength(JSON.stringify(listing))).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    expect(listing.note).toMatch(/omitted to keep this result under/);
    expect(listing.projects.length).toBeGreaterThan(0);
  });

  it("reports unreadable projects to the model, and distinguishes a broken id from an unknown one", async () => {
    const { registry } = registryWith({}, {}, { unreadable: ["broken-row"] });
    const listing = (await toolResult(registry, "projects.get", {})) as {
      unreadableProjects?: { readonly ids: readonly string[]; readonly more: number };
    };
    // Bounded, not verbatim: the ids come from an un-limited query, so a list of
    // them is itself a result that can cross the gate — `{ids, more}` caps it.
    expect(listing.unreadableProjects).toEqual({ ids: ["broken-row"], more: 0 });

    await expect(toolResult(registry, "projects.get", { projectId: "broken-row" })).rejects.toThrow(/unreadable/);
    await expect(toolResult(registry, "projects.get", { projectId: "never-existed" })).rejects.toThrow(/No project/);
  });

  it("keeps the unreadable warning when the document has to be trimmed", () => {
    // The warning is appended last, so the notes pass would evict it first and a
    // reader would learn only that "notes were trimmed" — never that a project
    // was missing.
    const warning = "2 project row(s) could not be read and were skipped: a, b";
    const bounded = boundDocument(
      {
        projects: [
          {
            id: "a",
            name: "A",
            metrics: [{ key: "k", label: "z".repeat(40 * 1024), value: 1, unit: "count" } as never],
            news: [],
            notes: ["ga4 is not configured", "stripe is not configured", warning],
          },
        ] as ProjectReport[],
      },
      { protectedNotes: [warning] },
    );
    expect(bounded.projects[0]?.notes).toContain(warning);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
  });
});

describe("gcp.billing's query", () => {
  it("passes the billing month as a query parameter, never in the SQL text", async () => {
    const bodies: unknown[] = [];
    const routed = stubFetch({
      "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
      "bigquery.googleapis.com/": { body: { rows: [{ f: [{ v: "12.5" }] }] } },
    });
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("bigquery.googleapis.com")) bodies.push(JSON.parse(String(init?.body)));
      return routed.impl(input, init);
    }) as typeof fetch;
    const config = {
      googleServiceAccountRef: "google.serviceAccount",
      projects: [{ id: "acme", gcp: { billingProjectId: "billing-proj", billingTable: "proj.billing.export" } }],
    };
    const registry = new ToolRegistry();
    registerCollectorTools(registry, {
      dataDirectory: projectDirectory(config),
      secretReader: secretReader({ "google.serviceAccount": serviceAccountJson }),
      projects: registryFixture(config),
      fetchImpl: impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });
    await toolResult(registry, "gcp.billing", { projectId: "acme" });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as { query: string; parameterMode?: string; queryParameters?: unknown };
    expect(body.query).not.toContain("202609");
    expect(body.query).toContain("@month");
    expect(body).toMatchObject({
      parameterMode: "NAMED",
      queryParameters: [{ name: "month", parameterType: { type: "STRING" }, parameterValue: { value: "202609" } }],
    });
  });
});

describe("collector tools — repaired defects", () => {
  it("refuses an unconfigured source instead of calling the provider with an empty id", async () => {
    const stub = stubFetch({ "oauth2.googleapis.com/token": { body: { access_token: "tok" } } });
    const registry = new ToolRegistry();
    registerCollectorTools(registry, {
      dataDirectory: projectDirectory({ googleServiceAccountRef: "google.serviceAccount", projects: [{ id: "bare", name: "Bare" }] }),
      secretReader: secretReader({ "google.serviceAccount": serviceAccountJson }),
      projects: registryFixture({ googleServiceAccountRef: "google.serviceAccount", projects: [{ id: "bare", name: "Bare" }] }),
      fetchImpl: stub.impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });

    // `bare` has no GA4 property, so nothing may be dispatched — previously this
    // called `properties/:runReport` and reported the 400 as a refusal.
    const error = await toolResult(registry, "ga4.report", { projectId: "bare" }).catch((thrown: unknown) => thrown);
    expect(String((error as { message?: string }).message)).toContain("is not configured");
    expect(stub.calls).toEqual([]);
  });

  it("refuses a source the project does not configure before resolving a token", async () => {
    const { registry, calls } = registryWith({});
    const error = await toolResult(registry, "gsc.query", { projectId: "globex" }).catch((thrown: unknown) => thrown);
    expect(String((error as { message?: string }).message)).toContain("not configured");
    expect(calls).toEqual([]);
  });

  it("keeps a credential store's path out of a tool error", async () => {
    const stub = stubFetch({});
    const failing = {
      async getSecret(): Promise<string | null> {
        throw new Error("EACCES: permission denied, open '/Users/op/.tavi/credentials/acme.stripe.key'");
      },
    };
    const registry = new ToolRegistry();
    registerCollectorTools(registry, {
      dataDirectory: projectDirectory(PROJECTS),
      secretReader: failing,
      projects: registryFixture(PROJECTS),
      fetchImpl: stub.impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });
    const error = await toolResult(registry, "stripe.subscriptions", { projectId: "acme" }).catch((thrown: unknown) => thrown);
    const message = String((error as { message?: string }).message);
    expect(message).not.toContain("/Users/op");
    expect(message).toContain("is unavailable");
  });

  it("does not report a failed charges call as zero revenue", async () => {
    const { registry } = registryWith(
      {
        "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
        "api.stripe.com/v1/subscriptions": { body: { data: [], has_more: false } },
        "api.stripe.com/v1/charges": { status: 500, body: {} },
      },
      { "acme.stripe.key": "sk_test_x" },
    );
    const stripe = (await toolResult(registry, "stripe.subscriptions", { projectId: "acme" })) as ProjectReport;
    expect(stripe.metrics.map((metric) => metric.key)).not.toContain("revenue");
    expect(stripe.notes.join(" ")).toContain("revenue is unavailable");
  });

  it("bases interval_count and zero-decimal currencies into the MRR conversion", () => {
    // Quarterly is one third of the monthly figure, not three times it.
    expect(monthlyAmount({ unit_amount: 3000, currency: "usd", recurring: { interval: "month", interval_count: 3 } }, 1)).toBeCloseTo(10);
    expect(monthlyAmount({ unit_amount: 24000, currency: "usd", recurring: { interval: "year", interval_count: 2 } }, 1)).toBeCloseTo(10);
    // JPY has no minor unit.
    expect(monthlyAmount({ unit_amount: 1000, currency: "jpy", recurring: { interval: "month" } }, 1)).toBe(1000);
    // And the same conversion is what the *charges* path uses: it hardcoded
    // `/ 100` and never read the charge's currency, so a paid JPY 1 000 charge
    // rendered `revenue = 10` on an account that bills in yen.
    expect(minorUnitsToMajor(1000, "jpy")).toBe(1000);
    expect(minorUnitsToMajor(1000, "usd")).toBe(10);
    // Stripe represents UGX as a two-decimal value for backwards compatibility
    // even though ISO-4217 calls it zero-decimal, so treating it as whole units
    // over-reported revenue by 100x.
    expect(minorUnitsToMajor(500, "ugx")).toBe(5);
    // A code this file does not know is *unknown*, not a guess scaled by 100 and
    // then labelled authoritative.
    expect(minorUnitsToMajor(500, "xyz")).toBeNaN();
    expect(minorUnitsToMajor(1500, "kwd")).toBeCloseTo(1.5);
    // A missing or unrecognised currency is `NaN`, never a silent usd: defaulting
    // to dollars is what made the original bug invisible.
    expect(minorUnitsToMajor(1000, undefined)).toBeNaN();
    expect(minorUnitsToMajor(1000, "not-a-currency")).toBeNaN();
    expect(minorUnitsToMajor(undefined, "jpy")).toBe(0);
  });

  it("reports three-decimal and unreadable currencies honestly", async () => {
    const { registry } = registryWith(
      {
        "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
        "api.stripe.com/v1/subscriptions": { body: { data: [], has_more: false } },
        "api.stripe.com/v1/charges": {
          body: {
            data: [
              { paid: true, amount: 1500, currency: "kwd", created: Math.floor(Date.parse("2026-09-14T00:00:00Z") / 1000) },
              { paid: true, amount: 900, currency: "usd", created: Math.floor(Date.parse("2026-09-14T00:00:00Z") / 1000) },
              { paid: true, amount: 400, created: Math.floor(Date.parse("2026-09-14T00:00:00Z") / 1000) },
            ],
            has_more: false,
          },
        },
      },
      { "acme.stripe.key": "sk_test_x" },
    );
    const stripe = (await toolResult(registry, "stripe.subscriptions", { projectId: "acme" })) as ProjectReport;
    // Two currencies are present, so there is no single `usd` total to report.
    expect(stripe.metrics.find((metric) => metric.key === "revenue")).toBeUndefined();
    const notes = stripe.notes.join(" ");
    expect(notes).toContain("spans kwd, usd");
    // The charge with no currency at all is named as excluded, not assumed to be
    // dollars — which is the original bug.
    expect(notes).toContain("1 paid charge(s) were excluded");
    // 1 500 fils is 1.500 KWD, not 15.00: the zero-decimal-or-100 binary got the
    // three-decimal currencies wrong by 10x.
    expect(minorUnitsToMajor(1500, "bhd")).toBeCloseTo(1.5);
  });

  it("reports a yen charge at its real value and says which currency the metric is in", async () => {
    const { registry } = registryWith(
      {
        "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
        "api.stripe.com/v1/subscriptions": { body: { data: [], has_more: false } },
        "api.stripe.com/v1/charges": {
          body: {
            // Inside the fixture's lookback window (now is 2026-09-16, seven days).
            data: [{ paid: true, amount: 1000, currency: "jpy", created: Math.floor(Date.parse("2026-09-14T00:00:00Z") / 1000) }],
            has_more: false,
          },
        },
      },
      { "acme.stripe.key": "sk_test_x" },
    );
    const stripe = (await toolResult(registry, "stripe.subscriptions", { projectId: "acme" })) as ProjectReport;
    const revenue = stripe.metrics.find((metric) => metric.key === "revenue");
    // 1000 yen is 1000, not 10: the hardcoded `/ 100` reported a twentieth.
    expect(revenue?.value).toBe(1000);
    // The metric's unit enum only has `usd`, so the note carries the correction.
    expect(stripe.notes.join(" ")).toContain("revenue is in jpy, not usd");
  });

  it("refuses rather than returning a document that would suspend the turn", () => {
    const document = {
      projects: [
        { id: "a", name: "A", metrics: [], notes: ["n".repeat(100_000)], news: [] },
        { id: "b", name: "B", metrics: [], notes: ["n".repeat(100_000)], news: [] },
      ] as ProjectReport[],
    };
    expect(() => boundDocument(document)).toThrow(/size budget/);
    // The caller's document is never mutated by a failed bound.
    expect(document.projects[0]?.notes[0]).toHaveLength(100_000);
  });

  it("will not fetch a plain-http feed or follow a feed redirect", async () => {
    const stub = stubFetch({
      "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
      "analyticsdata.googleapis.com/v1beta/properties/1:runReport": { body: GA4_BODY },
      "insecure.example/rss": { text: "<rss><channel></channel></rss>" },
    });
    const projects = {
      ...PROJECTS,
      news: { feedUrls: ["http://insecure.example/rss"], maxItemsPerProject: 3 },
    };
    const registry = new ToolRegistry();
    registerCollectorTools(registry, {
      dataDirectory: projectDirectory(projects),
      secretReader: secretReader({ "google.serviceAccount": serviceAccountJson, "acme.stripe.key": "sk_test_x" }),
      projects: registryFixture(PROJECTS),
      fetchImpl: stub.impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });
    const report = (await toolResult(registry, "news.search", { projectId: "acme" })) as ProjectReport;
    expect(stub.calls.filter((call) => call.startsWith("insecure.example"))).toEqual([]);
    expect(report.notes.join(" ")).toContain("feed was unavailable");
  });

  it("drops a feed link that is not an http(s) destination", () => {
    const items = parseFeed(
      `<rss><channel><item><title>Acme</title><link>javascript:alert(1)</link></item><item><title>Acme ok</title><link>https://e/a</link></item></channel></rss>`,
      "https://e/rss",
    );
    expect(items.map((item) => item.url)).toEqual(["https://e/a"]);
  });

  it("refuses a billing table that is not a table reference", async () => {
    const projects = {
      googleServiceAccountRef: "google.serviceAccount",
      projects: [{ id: "evil", gcp: { billingProjectId: "p", billingTable: "x WHERE 1=1; DROP TABLE y" } }],
    };
    const registry = new ToolRegistry();
    registerCollectorTools(registry, {
      dataDirectory: projectDirectory(projects),
      secretReader: secretReader({ "google.serviceAccount": serviceAccountJson }),
      projects: registryFixture(projects),
      fetchImpl: stubFetch({}).impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });
    // `INVALID_INPUT`, not `UNAVAILABLE`: a registry typo is the operator's to fix,
    // and `UNAVAILABLE` told them to retry a source that would fail identically
    // forever. This assertion previously froze the wrong code.
    await expect(toolResult(registry, "gcp.billing", { projectId: "evil" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("refuses a billing project id that is not a project id, not just its table", async () => {
    // Both halves of the `gcp` pair are interpolated — the table into SQL, the
    // project id into the request path — and only the table was gated. A `..`
    // project id normalized the URL to a different endpoint.
    const projects = {
      googleServiceAccountRef: "google.serviceAccount",
      projects: [{ id: "evil", gcp: { billingProjectId: "..", billingTable: "export" } }],
    };
    const registry = new ToolRegistry();
    const stub = stubFetch({});
    registerCollectorTools(registry, {
      dataDirectory: projectDirectory(projects),
      secretReader: secretReader({ "google.serviceAccount": serviceAccountJson }),
      projects: registryFixture(projects),
      fetchImpl: stub.impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });
    await expect(toolResult(registry, "gcp.billing", { projectId: "evil" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("project id"),
    });
    expect(stub.calls.some((url) => url.includes("bigquery.googleapis.com"))).toBe(false);
  });

  it("announces a malformed source as not configured rather than as configured", async () => {
    // `projects.get` is the surface the operator is told to trust when triaging a
    // brief, and it decided "configured" by presence — so a project both collectors
    // now refuse was announced as ready.
    const { registry } = registryWith(
      {},
      {},
      {
        projects: [
          { id: "acme", name: "Acme", ga4PropertyId: "properties/../../admin" },
          { id: "ok", name: "Ok", ga4PropertyId: "properties/1" },
        ],
      },
    );
    const listing = (await toolResult(registry, "projects.get", {})) as {
      projects: readonly { id: string; sources: { ga4: boolean } }[];
    };
    const byId = new Map(listing.projects.map((entry) => [entry.id, entry.sources.ga4]));
    expect(byId.get("acme")).toBe(false);
    expect(byId.get("ok")).toBe(true);
  });

  it("reports a credential file containing JSON null as a configuration error, not as 'google failed'", async () => {
    // A truncated or half-written secret parses as valid JSON `null` and then
    // crashed on the first property read with a raw TypeError, which can only be
    // reported as the reason-free form.
    const projects = {
      googleServiceAccountRef: "google.serviceAccount",
      projects: [{ id: "acme", ga4PropertyId: "properties/1" }],
    };
    const registry = new ToolRegistry();
    registerCollectorTools(registry, {
      dataDirectory: projectDirectory(projects),
      secretReader: secretReader({ "google.serviceAccount": "null" }),
      projects: registryFixture(projects),
      fetchImpl: stubFetch({}).impl,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });
    await expect(toolResult(registry, "ga4.report", { projectId: "acme" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("service-account key"),
    });
  });

  it("parses a hostile feed in linear time and ignores unterminated tags", () => {
    // A lazy whole-document regex rescans the rest of the feed for every opening
    // tag with no close, so 2 MiB of `<item>` lines — inside `MAX_FEED_BYTES` —
    // stalled the single-threaded daemon.
    const hostile = Array.from({ length: 40_000 }, (_, index) => `<item><title>t${index}</title>`).join("");
    const started = Date.now();
    expect(parseFeed(hostile, "https://news.example/rss")).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);

    // A well-formed feed still parses, including the `<entry>`/`<link href>` shape.
    const atom = `<feed><entry><title>Story</title><link href="https://news.example/a"/><updated>2026-04-05T00:00:00Z</updated></entry></feed>`;
    expect(parseFeed(atom, "https://news.example/rss")).toEqual([
      { title: "Story", url: "https://news.example/a", source: "news.example", publishedAt: "2026-04-05T00:00:00Z" },
    ]);
    // An unterminated tag is skipped, and *later* blocks still parse: the first
    // version of `feedBlocks` broke out of the loop on an unmatched open tag, so a
    // stray `<item>` (in a comment, in CDATA, or a truncated document) silently
    // dropped every entry after it — where the regex it replaced recovered them.
    const trailing = `<item><title>Good</title><link>https://news.example/g</link></item><item><title>Truncated</title><entry><title>After</title><link href="https://news.example/after"/></entry>`;
    expect(parseFeed(trailing, "https://news.example/rss").map((item) => item.title)).toEqual(["Good", "After"]);

    // A single huge block with no close is linear too: the per-tag search was lazy
    // and measured 40 seconds on 1.4 MiB.
    const oneBlock = `<item>${"x".repeat(1_400_000)}`;
    const startedBlock = Date.now();
    expect(parseFeed(oneBlock, "https://news.example/rss")).toEqual([]);
    expect(Date.now() - startedBlock).toBeLessThan(1_000);

    // And a body of `<` with no `>` does not make `stripTags` quadratic.
    const startedTags = Date.now();
    expect(parseFeed(`<item><title>${"<".repeat(400_000)}</title></item>`, "https://news.example/rss")).toEqual([]);
    expect(Date.now() - startedTags).toBeLessThan(1_000);
  });

  it("parses a provider body delivered in many small chunks (the preallocated merge)", async () => {
    // The merge was rewritten from a chunk-copying `reduce` to one allocation
    // and nothing exercised a streamed body: every fixture
    // returned a whole `Response`. This drives the real reader with 512 one-byte
    // chunks, so a merge that dropped or reordered a chunk would fail here.
    const stub = stubFetch({
      "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
      "news.example/rss": { text: "<rss><channel></channel></rss>" },
    });
    const body = new TextEncoder().encode(JSON.stringify(GA4_BODY));
    const streamed = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname !== "analyticsdata.googleapis.com") return stub.impl(input as never, init as never);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of body) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const registry = new ToolRegistry();
    registerCollectorTools(registry, {
      dataDirectory: projectDirectory(PROJECTS),
      secretReader: secretReader({ "google.serviceAccount": serviceAccountJson }),
      projects: registryFixture(PROJECTS),
      fetchImpl: streamed,
      now: () => new Date("2026-09-16T07:00:00Z"),
    });
    const result = (await toolResult(registry, "ga4.report", { projectId: "acme" })) as {
      metrics: { key: string; value: number }[];
    };
    expect(result.metrics.length).toBeGreaterThan(0);
    expect(result.metrics.every((metric) => Number.isFinite(metric.value))).toBe(true);
  });

  it("notes a lower bound when Stripe truncates at the page limit", async () => {
    const { registry } = registryWith(
      {
        "oauth2.googleapis.com/token": { body: { access_token: "tok" } },
        "api.stripe.com/v1/subscriptions": {
          body: {
            data: [
              {
                status: "active",
                items: { data: [{ price: { unit_amount: 1000, currency: "usd", recurring: { interval: "month" } }, quantity: 1 }] },
              },
            ],
            has_more: true,
          },
        },
        "api.stripe.com/v1/charges": { body: { data: [], has_more: true } },
      },
      { "acme.stripe.key": "sk_test_x" },
    );
    const stripe = (await toolResult(registry, "stripe.subscriptions", { projectId: "acme" })) as ProjectReport;
    expect(stripe.notes.join(" ")).toContain("subscriptions: totals cover the first 100 rows only");
    expect(stripe.notes.join(" ")).toContain("charges: revenue covers the first 100 rows only");
    expect(stripe.metrics.find((metric) => metric.key === "mrr")?.value).toBe(10);
  });
});

describe("helpers", () => {
  it("computes a window ending yesterday", () => {
    expect(periodFor(7, new Date("2026-09-16T07:00:00Z"))).toEqual({ start: "2026-09-09", end: "2026-09-15" });
  });

  it("normalizes a price to a monthly amount", () => {
    expect(monthlyAmount({ unit_amount: 1000, recurring: { interval: "month" } }, 1)).toBe(10);
    expect(monthlyAmount({ unit_amount: 12000, recurring: { interval: "year" } }, 1)).toBeCloseTo(10);
  });

  it("parses a feed with links and provenance, and scores relevance", () => {
    const items = parseFeed(
      `<rss><channel>
        <item><title><![CDATA[Acme &amp; partners]]></title><link>https://news.example/a</link><pubDate>Tue, 16 Sep 2026 06:00:00 GMT</pubDate><description>Acme did &lt;things&gt;.</description></item>
        <item><title>Unrelated</title><link>https://other.example/b</link></item>
      </channel></rss>`,
      "https://news.example/rss",
    );
    expect(items).toHaveLength(2);
    const [first, second] = items;
    expect(first?.title).toBe("Acme & partners");
    expect(first?.source).toBe("news.example");
    expect(first?.snippet).toBe("Acme did <things>.");
    expect(first === undefined ? 0 : relevance(first, ["acme"])).toBeGreaterThan(0);
    expect(second === undefined ? 0 : relevance(second, ["acme"])).toBe(0);
  });
});
