import { existsSync } from "node:fs";
import { join } from "node:path";

import { describeSignalSourceConformance } from "@tavi/plugin-kit/heartbeat/conformance";
import { temporaryDirectories } from "@tavi/test-support";
import {
  BLUESKY_TRENDS,
  blueskySearch,
  GDELT_DOC,
  HN_ALGOLIA,
  WIKIPEDIA_PAGEVIEWS,
  bucketsOf,
  failureOf,
  type RawItem,
  type TrendsAdapter,
  type TrendsSourceRecord,
} from "@tavi/trends-kit";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createEngine, type Engine, type Fetched, type Fetcher } from "../src/engine.js";
import { workerFetcher } from "../src/index.js";

/**
 * The trends.radar tools' work over a fake network
 * and a clock a test moves: sources whose hourly counts are steady until
 * `SPIKE`, then ten times as many.
 */
const SPIKE = "2026-10-17T00:00:00.000Z";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());
const home = () => {
  const directory = temp.create("tavi-trends-engine-");
  return directory;
};

/** A source whose request names its window, and whose answer counts `base` an hour, `spiked` from `SPIKE`. */
function fakeSource(record: TrendsSourceRecord, metric: string, base: number, spiked: number, items: readonly RawItem[]): TrendsAdapter {
  const host = record.hosts[0] ?? "example.org";
  return {
    record,
    counts: {
      request: ({ window }) => [
        { url: `https://${host}/counts?from=${window.from}&to=${window.to}&bucket=${window.bucket}`, expect: "json" },
      ],
      parse: (response, _request, { window }) =>
        failureOf(response, window.to) ?? {
          kind: "ok",
          value: [
            {
              metric,
              points: bucketsOf(window).map((start) => ({ start, value: start >= SPIKE ? spiked : base, quality: "ok" as const })),
            },
          ],
        },
    },
    sample: {
      request: () => [{ url: `https://${host}/sample`, expect: "json" }],
      parse: (response) => failureOf(response, SPIKE) ?? { kind: "ok", value: items },
    },
    trending: {
      request: ({ country }) => [{ url: `https://${host}/trending/${country}`, expect: "json" }],
      parse: () => ({
        kind: "ok",
        value: [{ title: "Solid-state batteries", url: `https://${host}/trend/1`, rank: 1, volume: 5_000, volumeLabel: "5,000+" }],
      }),
    },
  };
}

const reuters: RawItem = {
  ref: "a",
  url: "https://www.reuters.com/a",
  title: "Toyota files solid-state battery patents",
  text: "Toyota said it would start pilot production in 2027.",
  publishedAt: "2026-10-17T09:00:00.000Z",
  language: "en",
};
const nikkei: RawItem = {
  ref: "b",
  url: "https://asia.nikkei.com/b",
  title: "Toyota's solid-state push",
  text: "The carmaker plans pilot production in 2027.",
  publishedAt: "2026-10-17T08:00:00.000Z",
  language: "en",
};
const story: RawItem = {
  ref: "c",
  url: "https://news.ycombinator.com/item?id=1",
  title: "Solid-state batteries are here",
  author: "someone",
  publishedAt: "2026-10-17T07:00:00.000Z",
  language: "en",
};
// Bluesky's trends are undocumented, so off until the operator turns them on.
const adapters = [
  fakeSource(GDELT_DOC, "articles", 10, 100, [reuters, nikkei]),
  fakeSource(HN_ALGOLIA, "stories", 2, 20, [story]),
  fakeSource(WIKIPEDIA_PAGEVIEWS, "views", 100, 5_000, []),
  fakeSource(BLUESKY_TRENDS, "trend-posts", 1, 1, []),
];

/** Every request asked for, in order; a host answering `status` instead of 200 when set. */
function network(failing: Record<string, Fetched> = {}): { readonly fetcher: Fetcher; readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetcher: async (request) => {
      asked.push(request.url);
      const failure = Object.entries(failing).find(([host]) => new URL(request.url).hostname === host)?.[1];
      return failure ?? { status: 200, retryAfter: null, body: {}, bytes: 2 };
    },
  };
}

function engine(
  fetcher: Fetcher,
  config: Record<string, unknown> = {},
  at = "2026-10-17T00:30:00.000Z",
  directory = home(),
  using: readonly TrendsAdapter[] = adapters,
) {
  // A clock a source's rate waits move on, so no test sleeps.
  const clock = { ms: Date.parse(at) };
  const created = createEngine({
    home: directory,
    fetcher,
    config,
    version: "test",
    adapters: using,
    excluded: [{ id: "telegram", name: "Telegram channels", reason: "Its terms ban deploying AI on its content." }],
    routing: { DE: ["gdelt-doc", "hn-algolia"] },
    now: () => new Date(clock.ms).toISOString(),
    sleep: async (ms) => {
      clock.ms += ms;
    },
  });
  return Object.assign(created, { clock, directory });
}
const signal = () => new AbortController().signal;
const operator = { scope: { principalId: "operator", workspaceId: "default" }, unattended: false };
const topic = { label: "Solid-state batteries", terms: { en: ["solid-state battery"] } };
/** A topic added: `watch`'s answer to `add`. */
function add(radar: Engine, input: unknown, context = operator) {
  const answer = radar.watch({ op: "add", topic: input }, context);
  if (!("backfill" in answer) || answer.backfill === undefined) throw new Error("not an added topic");
  return answer;
}

describe("watch", () => {
  it("adds a topic for its principal, says which sources backfill, and keeps it from other principals", () => {
    const radar = engine(network().fetcher);
    const added = add(radar, topic);
    expect(added.topic).toMatchObject({
      label: "Solid-state batteries",
      state: "quiet",
      alert: { growth: 3, corroboration: "two_independent" },
    });
    // Every source with history backfills on the first sweep.
    expect(added.backfill.sources).toEqual(["gdelt-doc", "hn-algolia", "wikipedia-pageviews"]);
    expect(radar.topics(operator).topics).toHaveLength(1);
    expect(radar.topics({ ...operator, scope: { principalId: "alice", workspaceId: "default" } }).topics).toEqual([]);
    expect(() =>
      radar.velocity(
        { topicId: added.topic.topicId, window: "7d" },
        { ...operator, scope: { principalId: "alice", workspaceId: "default" } },
      ),
    ).toThrow(/no topic/);
    radar.close();
  });

  it("refuses a person, an unknown source, and any call nobody attends", () => {
    const radar = engine(network().fetcher);
    expect(() => add(radar, { label: "x", terms: { en: ["@someone.bsky.social"] } })).toThrow(/never a person/);
    expect(() => add(radar, { ...topic, sources: ["tiktok"] })).toThrow(/no source tiktok/);
    expect(() => radar.watch({ op: "add", topic }, { ...operator, unattended: true })).toThrow(/person's to approve/);
    expect(radar.topics(operator).topics).toEqual([]);
    radar.close();
  });

  it("pauses, resumes and removes a topic by its id", () => {
    const radar = engine(network().fetcher);
    const { topic: added } = add(radar, topic);
    expect(radar.watch({ op: "pause", topicId: added.topicId }, operator).topic).toMatchObject({ paused: true });
    expect(radar.watch({ op: "resume", topicId: added.topicId }, operator).topic).toMatchObject({ paused: false });
    expect(radar.watch({ op: "remove", topicId: added.topicId }, operator)).toEqual({ removed: true, topicId: added.topicId });
    expect(() => radar.watch({ op: "pause" }, operator)).toThrow(/topicId/);
    radar.close();
  });
});

describe("sweep, velocity, brief and the spikes signal", () => {
  it("backfills, finds nothing before the spike, confirms it with two families after, and signals it", async () => {
    const net = network();
    const radar = engine(net.fetcher);
    const { topic: added } = add(radar, { ...topic, countries: ["DE"] });
    const quiet = await radar.sweep({}, signal(), operator);
    expect(quiet.topics).toMatchObject([{ topicId: added.topicId, state: "quiet", families: [] }]);
    // The country's routing reads GDELT first; Wikipedia is skipped for want of a contact.
    expect(quiet.topics[0]?.sources).toEqual([
      { source: "gdelt-doc", outcome: "ok" },
      { source: "hn-algolia", outcome: "ok" },
      { source: "wikipedia-pageviews", outcome: "skipped", why: expect.stringMatching(/contact/) },
    ]);
    // The first read backfills 35 days of hours.
    expect(net.asked[0]).toMatch(/from=2026-09-12T00:00:00.000Z&to=2026-10-17T00:00:00.000Z&bucket=hour/);

    radar.clock.ms = Date.parse("2026-10-18T00:30:00.000Z");
    const asked = net.asked.length;
    const raised = await radar.sweep({}, signal(), operator);
    // A source read before is read again from two days before its last read.
    expect(net.asked[asked]).toMatch(/from=2026-10-15T00:00:00.000Z&to=2026-10-18T00:00:00.000Z/);
    expect(raised.topics[0]).toMatchObject({ state: "confirmed", previousState: "quiet", families: ["news", "community"] });
    expect(raised.topics[0]?.itemIds).toHaveLength(3);
    expect(raised.routineSources.map((source) => source.url)).toEqual(
      expect.arrayContaining(["https://www.reuters.com/a", "https://asia.nikkei.com/b"]),
    );

    const velocity = radar.velocity({ topicId: added.topicId, window: "24h" }, operator);
    expect(velocity).toMatchObject({ state: "confirmed", bucket: "hour" });
    const gdelt = velocity.tests.find((test) => test.sourceId === "gdelt-doc");
    // 2,400 articles against a median of 240: (2400+5)/(240+5) − 1.
    expect(gdelt).toMatchObject({
      test: "count",
      x: 2_400,
      growthBaseline: 240,
      passed: true,
      pBh: true,
      floorMet: true,
      crossChecked: true,
      growthPercent: Math.round((2_405 / 245 - 1) * 100),
    });

    const brief = radar.brief(
      {
        topicId: added.topicId,
        bullets: [
          {
            text: `News coverage is up ${String(gdelt?.growthPercent)}% on its 7-day median, per GDELT.`,
            cites: [velocity.itemIds.find((id) => id.startsWith("gdelt-doc:")) ?? ""],
          },
          {
            text: "Reuters and Nikkei both report pilot production planned for 2027.",
            cites: velocity.itemIds.filter((id) => id.startsWith("gdelt-doc:")),
            corroborated: true,
          },
        ],
      },
      operator,
    );
    expect(brief).toMatchObject({ ok: true, briefId: expect.stringMatching(/^b_/) });
    // A figure no test computed is refused.
    expect(
      radar.brief(
        { topicId: added.topicId, bullets: [{ text: "Coverage is up 412% per GDELT.", cites: velocity.itemIds.slice(0, 1) }] },
        operator,
      ),
    ).toMatchObject({ ok: false, problems: [{ problem: "figure-not-computed" }] });

    const signals = radar.signals({ ...operator.scope, now: "2026-10-18T00:31:00.000Z" });
    const list = Array.isArray(signals) ? signals : signals.signals;
    expect(list).toEqual([
      {
        key: `topic:${added.topicId}:confirmed:2026-10-18T00`,
        hash: expect.stringMatching(/^confirmed:\d+$/),
        title: expect.stringMatching(/^Solid-state batteries: \+\d+% vs 7-day baseline \(community, news\)$/),
        at: "2026-10-18T00:31:00.000Z",
        source: "Trends",
        data: { topicId: added.topicId, state: "confirmed", g: expect.any(Number), kinds: ["community", "news"], window: "24h" },
      },
    ]);
    // Another principal's heartbeat hears nothing of it.
    const alices = radar.signals({ principalId: "alice", workspaceId: "default", now: "2026-10-18T00:31:00.000Z" });
    expect(Array.isArray(alices) ? alices : alices.signals).toEqual([]);
    await radar.settled();
    radar.close();
  });

  it("reads Wikipedia only with the operator's contact, which goes in the User-Agent", async () => {
    const agents: string[] = [];
    const radar = engine(
      async (request) => {
        agents.push(request.headers?.["User-Agent"] ?? "");
        return { status: 200, retryAfter: null, body: {}, bytes: 2 };
      },
      { contact: "me@example.org" },
    );
    add(radar, { ...topic, articles: { "en.wikipedia": "Solid-state_battery" } });
    const swept = await radar.sweep({}, signal(), operator);
    expect(swept.topics[0]?.sources.map((source) => source.source)).toContain("wikipedia-pageviews");
    expect(swept.topics[0]?.sources.every((source) => source.outcome === "ok")).toBe(true);
    expect(new Set(agents)).toEqual(new Set(["Tavi-trends/test (+me@example.org)"]));
    radar.close();
  });

  it("pauses a source that asked it to wait, and shows the class, never the source's words, in sources", async () => {
    const radar = engine(
      network({
        "api.gdeltproject.org": {
          status: 429,
          retryAfter: "3600",
          body: "Please limit requests to one every 5 seconds <script>alert(1)</script>",
          bytes: 60,
        },
      }).fetcher,
    );
    add(radar, topic);
    const swept = await radar.sweep({}, signal(), operator);
    expect(swept.topics[0]?.sources.find((source) => source.source === "gdelt-doc")).toEqual({
      source: "gdelt-doc",
      outcome: "failed",
      why: "quota",
    });
    const sources = await radar.sources({});
    const gdelt = sources.sources.find((source) => source.id === "gdelt-doc");
    expect(gdelt).toMatchObject({ health: "quota", pausedUntil: "2026-10-17T01:30:00.000Z", budget: { perDay: 2_000, usedToday: 1 } });
    expect(JSON.stringify(sources)).not.toMatch(/limit requests|script/);
    expect(sources.excluded).toEqual([{ id: "telegram", name: "Telegram channels", reason: "Its terms ban deploying AI on its content." }]);
    // Paused, it is skipped until its wait is over.
    const again = await radar.sweep({}, signal(), operator);
    expect(again.topics[0]?.sources.find((source) => source.source === "gdelt-doc")).toMatchObject({
      outcome: "skipped",
      why: expect.stringMatching(/paused until/),
    });
    radar.close();
  });

  it("answers the store-only tools with no request at all", async () => {
    const net = network();
    const radar = engine(net.fetcher);
    const { topic: added } = add(radar, topic);
    await radar.sweep({}, signal(), operator);
    const asked = net.asked.length;
    await radar.sources({ country: "DE", kind: "news" });
    radar.topics(operator);
    radar.velocity({ topicId: added.topicId, window: "30d" }, operator);
    expect(
      radar
        .compare({ topicIds: [added.topicId], window: "7d" }, operator)
        .topics[0]?.series.map((series) => series.sourceId)
        .sort(),
    ).toEqual(["gdelt-doc", "hn-algolia"]);
    radar.brief({ topicId: added.topicId, bullets: [{ text: "x", cites: [] }] }, operator);
    expect(net.asked).toHaveLength(asked);
    radar.close();
  });
});

describe("source admission", () => {
  it("reads a source the operator has not turned on, or turned off, for nobody who names it", async () => {
    const net = network();
    const radar = engine(net.fetcher, { disabledSources: "hn-algolia" });
    expect(() => add(radar, { ...topic, sources: ["bluesky-trends"] })).toThrow(/bluesky-trends is off/);
    expect(() => add(radar, { ...topic, sources: ["hn-algolia", "gdelt-doc"] })).toThrow(/hn-algolia is off/);
    add(radar, { ...topic, sources: ["gdelt-doc"] });
    await radar.search(
      { query: "solid-state battery", window: "7d", sources: ["bluesky-trends", "hn-algolia", "gdelt-doc"] },
      signal(),
      operator,
    );
    await radar.snapshot({ country: "DE", sources: ["bluesky-trends", "hn-algolia"] }, signal(), operator);
    await radar.sweep({}, signal(), operator);
    expect(net.asked.every((url) => new URL(url).hostname === "api.gdeltproject.org")).toBe(true);
    expect((await radar.sources({})).sources.filter((source) => source.on).map((source) => source.id)).toEqual([
      "gdelt-doc",
      "wikipedia-pageviews",
    ]);
    radar.close();
    // Turned on, it is read.
    const on = engine(network().fetcher, { enabledSources: "bluesky-trends" });
    expect(add(on, { ...topic, sources: ["bluesky-trends"] }).backfill.sources).toEqual([]);
    on.close();
  });
});

describe("sweeps one at a time", () => {
  it("runs a chat's sweep after the heartbeat's, from the state that one left", async () => {
    const net = network();
    const radar = engine(net.fetcher);
    add(radar, topic);
    radar.clock.ms = Date.parse("2026-10-18T00:30:00.000Z");
    const background = radar.signals({ ...operator.scope, now: new Date(radar.clock.ms).toISOString() });
    expect(background).toMatchObject({ incomplete: true });
    const chat = await radar.sweep({}, signal(), operator);
    // The heartbeat's sweep raised it first; the chat's saw that state.
    expect(chat.topics[0]).toMatchObject({ state: "confirmed", previousState: "confirmed" });
    await radar.settled();
    radar.close();
  });
});

describe("the worker's fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads JSON when asked, keeps the text when it is not JSON, and refuses an answer over 8 MB", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response('{"hits":[]}', { status: 200, headers: { "retry-after": "5", "content-signal": "search=yes, ai-input=no" } }),
    );
    expect(await workerFetcher({ url: "https://hn.algolia.com/x", expect: "json" }, signal())).toEqual({
      status: 200,
      retryAfter: "5",
      contentSignal: "search=yes, ai-input=no",
      location: null,
      body: { hits: [] },
      bytes: 11,
    });
    vi.stubGlobal("fetch", async () => new Response("Please limit requests", { status: 429 }));
    expect(await workerFetcher({ url: "https://api.gdeltproject.org/x", expect: "json" }, signal())).toMatchObject({
      status: 429,
      body: "Please limit requests",
    });
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), { status: 200 }));
    await expect(workerFetcher({ url: "https://feeds.nos.nl/x", expect: "text" }, signal())).rejects.toThrow(/over 8388608 bytes/);
  });
});

describe("the source and person rules", () => {
  it("refuses a topic or a search that is the name of an author a read saw today", async () => {
    const radar = engine(network().fetcher);
    await radar.search({ query: "solid-state battery", window: "7d" }, signal(), operator);
    // The HN story's author was "someone": only its hash is kept, and it is refused as a term.
    expect(() => add(radar, { label: "Someone", terms: { en: ["someone"] } })).toThrow(/an author's name/);
    await expect(radar.search({ query: "someone", window: "7d" }, signal(), operator)).rejects.toThrow(/an author's name/);
    expect(add(radar, topic).topic.label).toBe("Solid-state batteries");
    radar.close();
  });

  it("says a spent daily budget is exhausted and when it refills, in a sweep and in sources", async () => {
    const tight: TrendsAdapter = { ...(adapters[1] as TrendsAdapter), record: { ...HN_ALGOLIA, budget: { perSecond: 2, perDay: 1 } } };
    const radar = createEngine({
      home: home(),
      fetcher: network().fetcher,
      config: {},
      version: "test",
      adapters: [tight],
      now: () => "2026-10-17T00:30:00.000Z",
    });
    add(radar, topic);
    add(radar, { ...topic, label: "Second" });
    const swept = await radar.sweep({}, signal(), operator);
    expect(swept.topics[1]?.sources[0]).toEqual({
      source: "hn-algolia",
      outcome: "skipped",
      why: "its daily budget is spent",
      exhausted: true,
      nextAt: "2026-10-18T00:00:00.000Z",
    });
    expect((await radar.sources({})).sources[0]?.budget).toEqual({
      perDay: 1,
      usedToday: 1,
      exhausted: true,
      nextAt: "2026-10-18T00:00:00.000Z",
    });
    radar.close();
  });

  it("keeps GDELT's requests five seconds apart, waiting its rate out", async () => {
    const times: number[] = [];
    const holder: { radar?: ReturnType<typeof engine> } = {};
    const radar = engine(async (request) => {
      if (new URL(request.url).hostname === "api.gdeltproject.org") times.push(holder.radar?.clock.ms ?? 0);
      return { status: 200, retryAfter: null, body: {}, bytes: 2 };
    });
    holder.radar = radar;
    add(radar, topic);
    add(radar, { ...topic, label: "Second" });
    add(radar, { ...topic, label: "Third" });
    await radar.sweep({}, signal(), operator);
    expect(times).toHaveLength(3);
    for (let index = 1; index < times.length; index += 1)
      expect((times[index] ?? 0) - (times[index - 1] ?? 0)).toBeGreaterThanOrEqual(5_000);
    radar.close();
  });

  it("compares a day by hour", async () => {
    const radar = engine(network().fetcher);
    const { topic: added } = add(radar, topic);
    await radar.sweep({}, signal(), operator);
    const compared = radar.compare({ topicIds: [added.topicId], window: "24h" }, operator);
    expect(compared).toMatchObject({ bucket: "hour" });
    expect(compared.days[0]).toMatch(/^2026-10-16T00$/);
    radar.close();
  });
});

describe("search and snapshot", () => {
  it("keeps a search's dated sample with ids to cite, and refuses a handle as a query", async () => {
    const radar = engine(network().fetcher);
    const found = await radar.search({ query: "solid-state battery", window: "7d" }, signal(), operator);
    expect(found.items.map((item) => item.outlet)).toEqual(["reuters.com", "asia.nikkei.com", "news.ycombinator.com"]);
    expect(found.items.every((item) => /^[a-z-]+:[0-9a-f]{24}$/.test(item.itemId))).toBe(true);
    // An author is kept only as a salted hash, and no reply shows it.
    expect(JSON.stringify(found)).not.toContain("someone");
    expect(found.counts.map((count) => count.source)).toEqual(["gdelt-doc", "hn-algolia"]);
    expect(found.taviFindings?.[0]).toMatchObject({ kind: "trend-item" });
    await expect(radar.search({ query: "@someone", window: "7d" }, signal(), operator)).rejects.toThrow(/never a person/);
    radar.close();
  });

  it("gives no count for a Bluesky read from one full page, only that it was a sample and where it starts", async () => {
    // A full page of 100 posts from the last four hours: a week and a month read the same posts.
    const posts = Array.from({ length: 100 }, (_, index) => ({
      uri: `at://did:plc:author${String(index)}/app.bsky.feed.post/p${String(index)}`,
      author: { did: `did:plc:author${String(index)}`, handle: `a${String(index)}.bsky.social` },
      record: { text: "WebAssembly news", createdAt: new Date(Date.parse("2026-10-17T00:00:00.000Z") - index * 140_000).toISOString() },
    }));
    const radar = engine(async () => ({ status: 200, retryAfter: null, body: { posts }, bytes: 2 }), {}, undefined, undefined, [
      blueskySearch,
    ]);
    for (const window of ["7d", "30d"] as const) {
      const found = await radar.search({ query: "WebAssembly", window }, signal(), operator);
      // No number to set beside another window's: the sample is named, with where it starts, and counted nowhere.
      expect(found.counts).toEqual([]);
      expect(found.samples).toEqual([
        { source: "bluesky-search", coveredFrom: "2026-10-16T20:00:00.000Z", note: expect.stringMatching(/no count for this window/) },
      ]);
    }
    radar.close();
  });

  it("lists what trends now in a country, each entry an item to cite", async () => {
    const radar = engine(network().fetcher);
    const snapshot = await radar.snapshot({ country: "DE" }, signal(), operator);
    expect(snapshot.lists.map((each) => each.source)).toEqual(["gdelt-doc", "hn-algolia"]);
    expect(snapshot.lists[0]?.entries[0]).toMatchObject({
      rank: 1,
      title: "Solid-state batteries",
      volume: "5,000+",
      itemId: expect.stringMatching(/^gdelt-doc:/),
    });
    expect(snapshot.sources.find((source) => source.source === "wikipedia-pageviews")).toMatchObject({
      outcome: "skipped",
      why: expect.stringMatching(/contact/),
    });
    radar.close();
  });
});

/** A site profile the ingest and cluster tests read from: Weibo's hot search, read in the browser. */
const WEIBO_HOT = {
  id: "weibo-hot",
  name: "Weibo hot search",
  countries: ["CN"],
  hosts: ["s.weibo.com"],
  access: { mode: "read", watchable: false, reason: "r", termsUrl: "https://weibo.com/signup/v5/protocol", reviewedAt: "2026-10-17" },
  budget: { pagesPerTask: 3, pagesPerDay: 10, minIntervalMs: 10_000 },
  notes: "n",
};

describe("profile and ingest", () => {
  const sites = [{ ...WEIBO_HOT, extract: { jsonLdTypes: ["ItemList"] } }];

  it("shows a profile and how to read it, with no request", () => {
    const net = network();
    const radar = createEngine({ home: home(), fetcher: net.fetcher, config: {}, version: "test", adapters, sites });
    expect(radar.profile({ profileId: "weibo-hot" })).toMatchObject({
      profile: { id: "weibo-hot", access: { watchable: false } },
      howToRead: expect.stringMatching(/browser\.structured \(ItemList\)/),
    });
    expect(() => radar.profile({ profileId: "nope" })).toThrow(/no site profile nope: weibo-hot/);
    expect(net.asked).toEqual([]);
    radar.close();
  });

  it("never opens an assist-only site, and keeps nothing read there", () => {
    const assist = [
      {
        ...sites[0],
        id: "douyin-hot",
        name: "Douyin hot list",
        hosts: ["www.douyin.com"],
        access: { ...sites[0]?.access, mode: "assist-only" },
      },
    ] as typeof sites;
    const radar = createEngine({ home: home(), fetcher: network().fetcher, config: {}, version: "test", adapters, sites: assist });
    expect(radar.profile({ profileId: "douyin-hot" }).howToRead).toMatch(/^Never open Douyin hot list: .*ingest refuses it/);
    expect(() =>
      radar.ingest(
        { profileId: "douyin-hot", itemSet: "douyin-hot", items: [{ url: "https://www.douyin.com/hot/1", title: "x" }] },
        operator,
      ),
    ).toThrow(/read for the chat only/);
    radar.close();
  });

  it("keeps rows read in the browser as the agent's, a day, never counted, cited as read in the browser; refusing a run nobody attends and links that are not http(s)", async () => {
    const radar = createEngine({
      home: home(),
      fetcher: network().fetcher,
      config: {},
      version: "test",
      adapters,
      sites,
      now: () => "2026-10-17T00:30:00.000Z",
    });
    const { topic: added } = add(radar, topic);
    expect(() =>
      radar.ingest(
        { profileId: "weibo-hot", itemSet: "weibo-hot", items: [{ url: "https://s.weibo.com/weibo?q=x", title: "x" }] },
        { ...operator, unattended: true },
      ),
    ).toThrow(/person's to approve/);
    expect(() =>
      radar.ingest({ profileId: "nope", itemSet: "x", items: [{ url: "https://s.weibo.com/weibo?q=x", title: "x" }] }, operator),
    ).toThrow(/no site profile nope/);
    const row = { url: "https://s.weibo.com/weibo?q=%E5%85%A8%E5%9B%BA%E4%BD%93", title: "全固体电池 trending", rank: 1, metric: 120_000 };
    // A link that is not http(s), one off the profile's hosts (a page naming another outlet), and a repeat are refused.
    const kept = radar.ingest(
      {
        profileId: "weibo-hot",
        itemSet: "weibo-hot",
        items: [
          row,
          { url: "javascript:alert(1)", title: "bad" },
          { url: "https://www.reuters.com/a", title: "Reuters reported a breakthrough" },
          row,
        ],
      },
      operator,
    );
    expect(kept).toMatchObject({
      itemSet: "weibo-hot",
      refused: 3,
      kept: [{ itemId: expect.stringMatching(/^agent:/), title: "全固体电池 trending" }],
    });
    expect(kept.kept).toHaveLength(1);
    // Nothing relayed enters a series: the topic's velocity has no counts from it.
    expect(radar.velocity({ topicId: added.topicId, window: "24h" }, operator).series).toEqual([]);
    const brief = radar.brief(
      {
        topicId: added.topicId,
        bullets: [{ text: "Posts claim solid-state batteries trend on Weibo.", cites: [kept.kept[0]?.itemId ?? ""] }],
      },
      operator,
    );
    expect(brief).toMatchObject({ ok: true, brief: expect.stringContaining("s.weibo.com, as read in the browser on 2026-10-17") });
    radar.close();
  });
});

describe("cluster", () => {
  const sites = [WEIBO_HOT];

  it("clusters a relayed set into themes with verbatim quotes, copies set aside, and asks nothing", () => {
    const net = network();
    const radar = createEngine({
      home: home(),
      fetcher: net.fetcher,
      config: {},
      version: "test",
      adapters,
      sites,
      now: () => "2026-10-17T00:30:00.000Z",
    });
    // Comments that share a theme's words in varied order, as people write: never near-copies of each other.
    let state = 7;
    const next = (): number => (state = (state * 48_271) % 2_147_483_647) / 2_147_483_647;
    const said = (words: readonly string[]): string =>
      Array.from({ length: 24 }, () => words[Math.floor(next() * words.length)] ?? "").join(" ");
    const filler = ["the", "and", "my", "is", "this", "so", "really", "for", "with", "it"];
    const price = (_: number) => said(["price", "expensive", "cost", "budget", "afford", "money", "cheaper", "subsidy", ...filler]);
    const range = (_: number) => said(["winter", "range", "charging", "highway", "trip", "miles", "cold", "charger", ...filler]);
    const texts = [...Array.from({ length: 8 }, (_, n) => price(n)), ...Array.from({ length: 8 }, (_, n) => range(n))];
    const rows = [...texts, texts[0] ?? ""].map((text, n) => ({
      url: `https://s.weibo.com/weibo?q=${String(n)}`,
      title: text.slice(0, 40),
      text,
    }));
    radar.ingest({ profileId: "weibo-hot", itemSet: "comments", items: rows }, operator);
    const clustered = radar.cluster({ itemSet: "comments", minClusterSize: 3 }, operator);
    expect(clustered).toMatchObject({
      itemSet: "comments",
      read: 17,
      valid: 16,
      excluded: [{ reason: "duplicate", count: 1 }],
      other: { count: 0 },
    });
    expect(clustered.themes.map((theme) => theme.count)).toEqual([8, 8]);
    for (const theme of clustered.themes) {
      // Relayed rows have no author: every one may be quoted, five a theme.
      expect(theme.quotes).toHaveLength(5);
      for (const quote of theme.quotes) expect(rows.some((row) => row.text.startsWith(quote.span))).toBe(true);
    }
    expect(() => radar.cluster({}, operator)).toThrow(/topicId or an itemSet/);
    expect(net.asked).toEqual([]);
    radar.close();
  });

  it("clusters a topic's sampled items, off-topic ones excluded", async () => {
    const radar = engine(network().fetcher);
    const { topic: added } = add(radar, topic);
    await radar.sweep({}, signal(), operator);
    radar.clock.ms = Date.parse("2026-10-18T00:30:00.000Z");
    await radar.sweep({}, signal(), operator);
    const clustered = radar.cluster({ topicId: added.topicId, minClusterSize: 1 }, operator);
    // Nikkei's item names none of the topic's terms in its title or text.
    expect(clustered).toMatchObject({ topicId: added.topicId, read: 3, valid: 2, excluded: [{ reason: "off-topic", count: 1 }] });
    radar.close();
  });
});

describe("the stores", () => {
  it("empties both stores once when forget is set, and not again on the next start", () => {
    const directory = home();
    const first = engine(network().fetcher, {}, undefined, directory);
    first.watch({ op: "add", topic }, operator);
    first.close();
    const forgetting = engine(network().fetcher, { forget: true }, undefined, directory);
    expect(forgetting.topics(operator).topics).toEqual([]);
    forgetting.watch({ op: "add", topic }, operator);
    forgetting.close();
    expect(existsSync(join(directory, "forgotten"))).toBe(true);
    // Still set, a later start keeps what was added since.
    const later = engine(network().fetcher, { forget: true }, undefined, directory);
    expect(later.topics(operator).topics).toHaveLength(1);
    later.close();
    // Set back to false, the marker goes, so the next forget empties again.
    const unset = engine(network().fetcher, {}, undefined, directory);
    unset.topics(operator);
    unset.close();
    expect(existsSync(join(directory, "forgotten"))).toBe(false);
    expect(existsSync(join(directory, "cache", "items.db"))).toBe(true);
  });
});

describe("the spikes source's background sweep", () => {
  it("starts one sweep of every active topic at most each sweepMinutes, and says the batch is not all while it runs", async () => {
    const net = network();
    const radar = engine(net.fetcher);
    add(radar, topic);
    const first = radar.signals({ ...operator.scope, now: new Date(radar.clock.ms).toISOString() });
    expect(first).toEqual({ signals: [], incomplete: true });
    await radar.settled();
    const asked = net.asked.length;
    expect(asked).toBeGreaterThan(0);
    // Within the hour, no new sweep starts.
    radar.clock.ms += 30 * 60_000;
    expect(radar.signals({ ...operator.scope, now: new Date(radar.clock.ms).toISOString() })).toEqual([]);
    expect(net.asked).toHaveLength(asked);
    radar.clock.ms += 31 * 60_000;
    expect(radar.signals({ ...operator.scope, now: new Date(radar.clock.ms).toISOString() })).toEqual({ signals: [], incomplete: true });
    await radar.settled();
    expect(net.asked.length).toBeGreaterThan(asked);
    radar.close();
  });
});

const conforming: Engine[] = [];
afterAll(() => {
  for (const radar of conforming.splice(0)) radar.close();
});
describeSignalSourceConformance("trends.radar spikes", async () => {
  const radar = engine(network().fetcher, {}, "2026-10-17T00:30:00.000Z");
  conforming.push(radar);
  radar.watch({ op: "add", topic }, { scope: { principalId: "alice", workspaceId: "default" }, unattended: false });
  radar.clock.ms = Date.parse("2026-10-18T00:30:00.000Z");
  await radar.sweep({}, signal(), { scope: { principalId: "alice", workspaceId: "default" }, unattended: false });
  return {
    id: "spikes",
    retracts: false,
    collect: async ({ workspaceId, principalId, now }) => radar.signals({ workspaceId, principalId, now }),
  };
});
