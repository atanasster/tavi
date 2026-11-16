import { readFileSync } from "node:fs";
import { join } from "node:path";

import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";

import {
  TR1_ADAPTERS,
  approxTraffic,
  rebucket,
  retryAfterMs,
  arxiv,
  blueskySearch,
  blueskyTrends,
  feedItems,
  gdeltDoc,
  gdeltQuery,
  gtrendsRss,
  hashtagOf,
  hnAlgolia,
  instancesOf,
  mastodonTrends,
  mentions,
  mergeSeries,
  postUrl,
  rssEurope,
  wikidataEntity,
  wikidataSearch,
  wikipediaPageviews,
  type AdapterTopic,
  type SourceCall,
  type SourceResponse,
  type Window,
} from "../src/index.js";

/** Answers recorded from each source on 2026-10-17 (authors pseudonymised); no test reaches the network. */
const fixtures = domainFixtures("trends");
const json = (path: string): unknown => JSON.parse(readFileSync(join(fixtures, path), "utf8"));
const text = (path: string): string => readFileSync(join(fixtures, path), "utf8");
const ok = (body: unknown): SourceResponse => ({ status: 200, retryAfter: null, body });
const call = (now = "2026-10-17T13:10:00.000Z", settings: Record<string, unknown> = {}): SourceCall => ({
  now,
  credential: () => undefined,
  settings,
});

const topic: AdapterTopic = {
  label: "Solid-state batteries",
  terms: ["solid-state battery", "solid state battery", "全固体電池", "Festkörperbatterie"],
  termsByLanguage: { en: ["solid-state battery", "solid state battery"], ja: ["全固体電池"], de: ["Festkörperbatterie"] },
  exclude: [],
  articles: { "en.wikipedia": "Solid-state_battery" },
  countries: [],
};

describe("the adapters' contract", () => {
  it("each has a record whose hosts its requests stay within", () => {
    const window: Window = { from: "2026-10-10T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z", bucket: "day" };
    for (const adapter of TR1_ADAPTERS) {
      const requests = [
        ...(adapter.counts?.request({ topic, window }, call()) ?? []),
        ...(adapter.sample?.request({ topic, window, limit: 20 }, call()) ?? []),
        ...(adapter.trending?.request({ country: "JP" }, call()) ?? []),
      ];
      for (const request of requests)
        expect(adapter.record.hosts, `${adapter.record.id}: ${request.url}`).toContain(new URL(request.url).hostname);
    }
  });

  it("reads a 429 as a wait, a 401 as the key, a 403 as a block, and an unreadable 200 as drift", () => {
    const input = { topic, window: { from: "2026-10-16T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z", bucket: "hour" as const } };
    const [request] = hnAlgolia.counts?.request(input, call()) ?? [];
    if (request === undefined) throw new Error("no request");
    expect(hnAlgolia.counts?.parse({ status: 429, retryAfter: "30", body: "" }, request, input, call())).toEqual({
      kind: "rate-limited",
      retryAfterMs: 30_000,
    });
    expect(hnAlgolia.counts?.parse({ status: 401, body: "" }, request, input, call())).toMatchObject({ kind: "failed", class: "auth" });
    expect(
      blueskySearch.sample?.parse({ status: 403, body: text("bluesky/search-page2.html") }, request, { ...input, limit: 5 }, call()),
    ).toMatchObject({ kind: "failed", class: "blocked", status: 403 });
    expect(hnAlgolia.counts?.parse(ok({ unexpected: true }), request, input, call())).toMatchObject({ kind: "failed", class: "schema" });
  });
});

describe("Hacker News through Algolia", () => {
  const window: Window = { from: "2025-09-17T00:00:00.000Z", to: "2025-10-17T00:00:00.000Z", bucket: "day" };

  it("counts a window's stories by day from their times, approximate as Algolia says", () => {
    const input = { topic, window };
    const [request] = hnAlgolia.counts?.request(input, call()) ?? [];
    expect(request?.url).toContain("query=solid-state%20battery");
    expect(request?.url).toContain(`created_at_i%3E%3D${String(Date.parse(window.from) / 1_000)}`);
    const read = hnAlgolia.counts?.parse(ok(json("hn-algolia/search.json")), request ?? { url: "", expect: "json" }, input, call());
    if (read?.kind !== "ok") throw new Error(JSON.stringify(read));
    const points = read.value[0]?.points ?? [];
    expect(points).toHaveLength(30);
    // Six stories, five on the page: the buckets undercount, so they are partial.
    expect(points.reduce((sum, point) => sum + point.value, 0)).toBe(5);
    expect(points.find((point) => point.start === "2025-10-10T00:00:00.000Z")).toEqual({
      start: "2025-10-10T00:00:00.000Z",
      value: 1,
      quality: "partial",
    });
    // The page's oldest story is from 2025-10-03: the buckets before it were never read.
    expect(points.filter((point) => point.quality === "missing").map((point) => point.start)).toEqual(
      points.filter((point) => point.start < "2025-10-03T00:00:00.000Z").map((point) => point.start),
    );
    expect(points.find((point) => point.start === "2025-10-02T00:00:00.000Z")?.quality).toBe("missing");
  });

  it("samples stories with points and comments, and lists the front page by points", () => {
    const read = hnAlgolia.sample?.parse(
      ok(json("hn-algolia/search.json")),
      { url: "", expect: "json" },
      { topic, window, limit: 5 },
      call(),
    );
    if (read?.kind !== "ok") throw new Error("not ok");
    expect(read.value.find((item) => item.ref !== "")?.metrics).toHaveProperty("points");
    expect(read.value.every((item) => item.language === "en" && item.author?.startsWith("user"))).toBe(true);
    const front = hnAlgolia.trending?.parse(ok(json("hn-algolia/front-page.json")), { url: "", expect: "json" }, { country: "US" }, call());
    if (front?.kind !== "ok") throw new Error("not ok");
    expect(front.value[0]).toMatchObject({
      rank: 1,
      title: "Tesla Roadster",
      volume: 1488,
      url: expect.stringMatching(/^https:\/\/news\.ycombinator\.com\/item\?id=/),
    });
  });
});

describe("Wikipedia pageviews", () => {
  it("reads an article's daily views; today and the unpublished yesterday are missing, not quiet", () => {
    const window: Window = { from: "2026-10-10T00:00:00.000Z", to: "2026-10-18T00:00:00.000Z", bucket: "day" };
    const [request] = wikipediaPageviews.counts?.request({ topic, window }, call()) ?? [];
    expect(request?.url).toBe(
      "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Solid-state_battery/daily/20261010/20261017",
    );
    const read = wikipediaPageviews.counts?.parse(
      ok(json("wikipedia-pageviews/per-article.json")),
      request ?? { url: "", expect: "json" },
      { topic, window },
      call(),
    );
    if (read?.kind !== "ok") throw new Error("not ok");
    const points = read.value[0]?.points ?? [];
    expect(points.find((point) => point.start === "2026-10-15T00:00:00.000Z")).toEqual({
      start: "2026-10-15T00:00:00.000Z",
      value: 333,
      quality: "ok",
    });
    expect(points.filter((point) => point.quality === "missing").map((point) => point.start)).toEqual([
      "2026-10-16T00:00:00.000Z",
      "2026-10-17T00:00:00.000Z",
    ]);
    // Hourly windows read nothing here: per-article views are daily only.
    expect(wikipediaPageviews.counts?.request({ topic, window: { ...window, bucket: "hour" } }, call())).toEqual([]);
  });

  it("lists a country's edition's top articles without main pages and other namespaces", () => {
    const [request] = wikipediaPageviews.trending?.request({ country: "JP" }, call()) ?? [];
    expect(request?.url).toBe("https://wikimedia.org/api/rest_v1/metrics/pageviews/top/ja.wikipedia/all-access/2026/10/16");
    const read = wikipediaPageviews.trending?.parse(
      ok(json("wikipedia-pageviews/top-ja.json")),
      request ?? { url: "", expect: "json" },
      { country: "JP" },
      call(),
    );
    if (read?.kind !== "ok") throw new Error("not ok");
    expect(read.value[0]).toMatchObject({ rank: 1, volume: 230_680, url: expect.stringMatching(/^https:\/\/ja\.wikipedia\.org\/wiki\//) });
    expect(read.value.map((entry) => entry.title)).not.toContain("メインページ");
  });
});

describe("Wikidata", () => {
  it("finds an entity, and its names and articles in each language", () => {
    expect(wikidataSearch.parse(ok(json("wikidata/search.json")), call())).toEqual({ kind: "ok", value: "Q7557794" });
    const entity = wikidataEntity.parse(ok(json("wikidata/entity.json")), "Q7557794", call());
    if (entity.kind !== "ok") throw new Error("not ok");
    expect(entity.value.terms).toMatchObject({
      en: ["solid-state battery"],
      ja: ["全固体電池"],
      de: ["Festkörperbatterie", "Feststoffbatterie"],
    });
    expect(entity.value.articles).toMatchObject({ "en.wikipedia": "Solid-state battery", "ja.wikipedia": "全固体電池" });
    expect(wikidataEntity.request("Q7557794", ["en", "ja"]).url).toContain("sitefilter=enwiki%7Cjawiki");
  });
});

describe("GDELT", () => {
  const window: Window = { from: "2026-10-16T00:00:00.000Z", to: "2026-10-17T14:00:00.000Z", bucket: "hour" };

  it("asks for the topic's terms OR'ed, and reads the article count with its norm; hours it has not reached are missing", () => {
    expect(gdeltQuery(topic)).toBe('("solid-state battery" OR "solid state battery" OR "全固体電池" OR "Festkörperbatterie")');
    expect(gdeltQuery({ ...topic, terms: ["ai"], exclude: ["cheese"] })).toBeUndefined();
    const read = gdeltDoc.counts?.parse(ok(json("gdelt-doc/timeline.json")), { url: "", expect: "json" }, { topic, window }, call());
    if (read?.kind !== "ok") throw new Error("not ok");
    const points = read.value[0]?.points ?? [];
    expect(points.find((point) => point.start === "2026-10-17T12:00:00.000Z")).toEqual({
      start: "2026-10-17T12:00:00.000Z",
      value: 0,
      quality: "ok",
      norm: 8293,
    });
    expect(points.find((point) => point.start === "2026-10-17T13:00:00.000Z")?.quality).toBe("missing");
  });

  it("reads its plea to slow down as a wait of at least 5 seconds, and lists articles with their language", () => {
    expect(
      gdeltDoc.counts?.parse(ok(text("gdelt-doc/rate-limited.txt")), { url: "", expect: "json" }, { topic, window }, call()),
    ).toMatchObject({ kind: "rate-limited" });
    const read = gdeltDoc.sample?.parse(
      ok(json("gdelt-doc/artlist.json")),
      { url: "", expect: "json" },
      { topic, window, limit: 5 },
      call(),
    );
    if (read?.kind !== "ok") throw new Error("not ok");
    expect(read.value.map((item) => [item.language, item.publishedAt])).toEqual([
      ["en", "2026-10-16T23:00:00.000Z"],
      ["tr", "2026-10-16T13:30:00.000Z"],
    ]);
    expect(read.value[0]?.title).toBe("Solid Power, Inc. (NASDAQ: SLDPW) Shares Shorted: Short Interest Up 85.7% in September");
  });
});

describe("Google Trends' trending-now feed", () => {
  it("lists a country's surging searches with their traffic, and counts a topic only in the bucket of now", () => {
    expect(approxTraffic("1000+")).toBe(1_000);
    expect(approxTraffic("2K+")).toBe(2_000);
    expect(approxTraffic("lots")).toBeUndefined();
    const read = gtrendsRss.trending?.parse(ok(text("gtrends-rss/us.xml")), { url: "", expect: "text" }, { country: "US" }, call());
    if (read?.kind !== "ok") throw new Error("not ok");
    expect(read.value).toHaveLength(10);
    expect(read.value[0]).toMatchObject({
      title: "remain calm",
      rank: 1,
      volume: 1_000,
      volumeLabel: "1000+",
      url: expect.stringMatching(/^https:\/\//),
    });
    const window: Window = { from: "2026-10-17T11:00:00.000Z", to: "2026-10-17T14:00:00.000Z", bucket: "hour" };
    const counted = gtrendsRss.counts?.parse(
      ok(text("gtrends-rss/us.xml")),
      { url: "", expect: "text" },
      { topic: { ...topic, terms: ["remain calm"] }, window },
      call(),
    );
    if (counted?.kind !== "ok") throw new Error("not ok");
    expect(counted.value[0]?.points).toEqual([
      { start: "2026-10-17T11:00:00.000Z", value: 0, quality: "missing" },
      { start: "2026-10-17T12:00:00.000Z", value: 0, quality: "missing" },
      { start: "2026-10-17T13:00:00.000Z", value: 1_000, quality: "approximate" },
    ]);
  });
});

describe("Bluesky", () => {
  const window: Window = { from: "2026-10-17T11:00:00.000Z", to: "2026-10-17T14:00:00.000Z", bucket: "hour" };

  it("searches one window's first page, counting posts and distinct authors an hour", () => {
    const [request] = blueskySearch.counts?.request({ topic, window }, call()) ?? [];
    expect(request?.url).toContain("sort=latest");
    expect(request?.url).toContain(`since=${encodeURIComponent(window.from)}`);
    const read = blueskySearch.counts?.parse(
      ok(json("bluesky/search.json")),
      request ?? { url: "", expect: "json" },
      { topic, window },
      call(),
    );
    if (read?.kind !== "ok") throw new Error("not ok");
    const byMetric = Object.fromEntries(read.value.map((series) => [series.metric, series.points.map((point) => point.value)]));
    // Bluesky matched the query (it stems); all five recorded posts fall in the window, and none is excluded.
    expect(byMetric["posts"]).toEqual([1, 4, 0]);
    const excluding = blueskySearch.counts?.parse(
      ok(json("bluesky/search.json")),
      request ?? { url: "", expect: "json" },
      { topic: { ...topic, exclude: ["breakthroughs"] }, window },
      call(),
    );
    if (excluding?.kind !== "ok") throw new Error("not ok");
    expect(excluding.value.find((series) => series.metric === "posts")?.points.map((point) => point.value)).toEqual([0, 1, 0]);
    expect(byMetric["authors"]?.every((value, index) => value <= (byMetric["posts"]?.[index] ?? 0))).toBe(true);
  });

  it("links a post to its page and keeps its author as a DID only, for the store to hash", () => {
    expect(postUrl("at://did:plc:abc/app.bsky.feed.post/3my34")).toBe("https://bsky.app/profile/did:plc:abc/post/3my34");
    expect(postUrl("https://evil.example/")).toBeUndefined();
    const read = blueskySearch.sample?.parse(
      ok(json("bluesky/search.json")),
      { url: "", expect: "json" },
      { topic, window, limit: 5 },
      call(),
    );
    if (read?.kind !== "ok") throw new Error("not ok");
    for (const item of read.value) expect(item.author).toMatch(/^did:plc:examplepost\d$/);
  });

  it("reads its trends with their post counts", () => {
    const read = blueskyTrends.trending?.parse(ok(json("bluesky/trends.json")), { url: "", expect: "json" }, { country: "US" }, call());
    if (read?.kind !== "ok") throw new Error("not ok");
    expect(read.value[0]).toMatchObject({ title: "No Kings protests October 17", rank: 1, volume: 5_412 });
    expect(read.value[0]).not.toHaveProperty("text");
  });
});

describe("Mastodon", () => {
  it("makes hashtags of terms, reads a tag's week, and lists an instance's trending tags", () => {
    expect(hashtagOf("Solid-state battery")).toBe("solidstatebattery");
    expect(hashtagOf("AI")).toBeUndefined();
    expect(instancesOf(call(undefined, { mastodonInstances: "mstdn.jp, evil.example" }))).toEqual(["mstdn.jp"]);
    const window: Window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z", bucket: "day" };
    const read = mastodonTrends.counts?.parse(ok(json("mastodon/tag.json")), { url: "", expect: "json" }, { topic, window }, call());
    if (read?.kind !== "ok") throw new Error("not ok");
    const uses = read.value.find((series) => series.metric === "uses")?.points ?? [];
    // 1792108800 is 2026-10-16: 8 uses by 8 accounts.
    expect(uses.find((point) => point.start === "2026-10-16T00:00:00.000Z")).toEqual({
      start: "2026-10-16T00:00:00.000Z",
      value: 8,
      quality: "ok",
    });
    expect(uses.find((point) => point.start === "2026-10-01T00:00:00.000Z")?.quality).toBe("missing");
    const trending = mastodonTrends.trending?.parse(
      ok(json("mastodon/trends-tags.json")),
      { url: "", expect: "json" },
      { country: "US" },
      call(),
    );
    if (trending?.kind !== "ok") throw new Error("not ok");
    expect(trending.value[0]).toMatchObject({ title: "#DepartmentStoreABook", volume: 321 });
  });
});

describe("arXiv", () => {
  it("counts a window's papers by day, from totalResults and the entries", () => {
    const window: Window = { from: "2026-10-08T00:00:00.000Z", to: "2026-10-16T00:00:00.000Z", bucket: "day" };
    const [request] = arxiv.counts?.request({ topic, window }, call()) ?? [];
    expect(decodeURIComponent(request?.url ?? "")).toContain("submittedDate:[202610080000 TO 202610152359]");
    const read = arxiv.counts?.parse(
      ok(text("arxiv/query.xml")),
      request ?? { url: "", expect: "text" },
      { topic: { ...topic, terms: ["superionic"] }, window },
      call(),
    );
    if (read?.kind !== "ok") throw new Error("not ok");
    expect(read.value[0]?.points.reduce((sum, point) => sum + point.value, 0)).toBe(1);
  });
});

describe("broadcasters' feeds", () => {
  it("matches a term's plural, on word boundaries, without accents or case", () => {
    expect(mentions("Solid-State Batteries are here", ["solid-state battery"])).toBe(true);
    expect(mentions("A new Festkörperbatterie", ["festkorperbatterie"])).toBe(true);
    expect(mentions("ambush", ["bus"])).toBe(false);
    expect(mentions("トヨタの全固体電池", ["全固体電池"])).toBe(true);
  });

  it("reads RSS 2.0 and tagesschau's JSON, and counts back only as far as the feed reaches", () => {
    const bbc = feedItems(text("rss/bbc.xml"), "en");
    expect(bbc?.length).toBe(26);
    expect(bbc?.[0]).toMatchObject({
      url: expect.stringMatching(/^https:\/\/www\.bbc\./),
      language: "en",
      publishedAt: "2026-10-17T12:14:52.000Z",
    });
    const tagesschau = feedItems(json("rss/tagesschau.json"), "de");
    expect(tagesschau?.[0]).toMatchObject({
      language: "de",
      publishedAt: "2026-10-17T11:57:58.578Z",
      url: expect.stringMatching(/^https:\/\/www\.tagesschau\.de\//),
    });
    expect(feedItems("<html>not a feed</html>", "en")).toBeUndefined();
    const window: Window = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-18T00:00:00.000Z", bucket: "day" };
    const read = rssEurope.counts?.parse(ok(text("rss/bbc.xml")), { url: "", expect: "text", tag: "0" }, { topic, window }, call());
    if (read?.kind !== "ok") throw new Error("not ok");
    expect(read.value[0]?.points.find((point) => point.start === "2026-09-01T00:00:00.000Z")?.quality).toBe("missing");
    expect(read.value[0]?.points.find((point) => point.start === "2026-10-17T00:00:00.000Z")?.quality).toBe("approximate");
  });
});

describe("answers' edges", () => {
  it("reads Retry-After as seconds or an HTTP date, and waits a minute for one it cannot read", () => {
    expect(retryAfterMs("Sat, 17 Oct 2026 13:11:00 GMT", "2026-10-17T13:10:00.000Z")).toBe(60_000);
    expect(retryAfterMs("soon", "2026-10-17T13:10:00.000Z")).toBe(60_000);
    expect(retryAfterMs("2.5", "2026-10-17T13:10:00.000Z")).toBe(2_500);
  });

  it("sums quarter-hours into hours, a hour short of a step partial", () => {
    expect(
      rebucket(
        [
          { start: "2026-10-17T10:00:00.000Z", value: 1, quality: "ok", norm: 10 },
          { start: "2026-10-17T10:15:00.000Z", value: 2, quality: "ok", norm: 10 },
          { start: "2026-10-17T10:30:00.000Z", value: 0, quality: "ok", norm: 10 },
          { start: "2026-10-17T10:45:00.000Z", value: 4, quality: "ok", norm: 10 },
          { start: "2026-10-17T11:00:00.000Z", value: 5, quality: "ok", norm: 10 },
          { start: "2026-10-17T11:15:00.000Z", value: 5, quality: "ok", norm: 10 },
        ],
        "hour",
      ),
    ).toEqual([
      { start: "2026-10-17T10:00:00.000Z", value: 7, quality: "ok", norm: 40 },
      { start: "2026-10-17T11:00:00.000Z", value: 10, quality: "partial", norm: 20 },
    ]);
  });

  it("reads Wikipedia's and Mastodon's 404 as quiet where the source has spoken, and missing where it has not", () => {
    const window: Window = { from: "2026-10-09T00:00:00.000Z", to: "2026-10-18T00:00:00.000Z", bucket: "day" };
    const wikipedia = wikipediaPageviews.counts?.parse({ status: 404, body: null }, { url: "", expect: "json" }, { topic, window }, call());
    if (wikipedia?.kind !== "ok") throw new Error("not ok");
    expect(wikipedia.value[0]?.points.filter((point) => point.quality === "missing").map((point) => point.start)).toEqual([
      "2026-10-16T00:00:00.000Z",
      "2026-10-17T00:00:00.000Z",
    ]);
    const mastodon = mastodonTrends.counts?.parse({ status: 404, body: null }, { url: "", expect: "json" }, { topic, window }, call());
    if (mastodon?.kind !== "ok") throw new Error("not ok");
    // Today and the six days before: a week.
    expect(mastodon.value[0]?.points.filter((point) => point.quality === "ok")).toHaveLength(7);
    // Yesterday's top list not out yet is no failure.
    expect(wikipediaPageviews.trending?.parse({ status: 404, body: null }, { url: "", expect: "json" }, { country: "JP" }, call())).toEqual(
      { kind: "ok", value: [] },
    );
  });

  it("reads an Atom feed's entries and their link hrefs", () => {
    const atom =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:a,1</id><title>Solid-state battery &amp; more</title><link href="https://news.example/a"/><updated>2026-10-17T10:00:00Z</updated><summary>A &lt;b&gt;story&lt;/b&gt;</summary></entry><entry><title>No link</title></entry></feed>';
    expect(feedItems(atom, "en")).toEqual([
      {
        ref: "tag:a,1",
        url: "https://news.example/a",
        title: "Solid-state battery & more",
        text: "A story",
        publishedAt: "2026-10-17T10:00:00.000Z",
        language: "en",
      },
    ]);
  });

  it("reads an hourly GDELT window's last week only; its earlier hours are missing", () => {
    const window: Window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-17T14:00:00.000Z", bucket: "hour" };
    const [request] = gdeltDoc.counts?.request({ topic, window }, call()) ?? [];
    expect(request?.url).toContain("STARTDATETIME=20261010140000");
    const read = gdeltDoc.counts?.parse(
      ok(json("gdelt-doc/timeline.json")),
      request ?? { url: "", expect: "json" },
      { topic, window },
      call(),
    );
    if (read?.kind !== "ok") throw new Error("not ok");
    expect(read.value[0]?.points.find((point) => point.start === "2026-10-05T00:00:00.000Z")?.quality).toBe("missing");
  });
});

describe("merging a series from several answers", () => {
  it("sums what was seen, keeps a bucket nobody saw missing, and marks a bucket some saw partial", () => {
    expect(
      mergeSeries([
        [
          { start: "a", value: 1, quality: "ok", norm: 10 },
          { start: "b", value: 0, quality: "missing" },
          { start: "c", value: 0, quality: "missing" },
        ],
        [
          { start: "a", value: 2, quality: "approximate", norm: 5 },
          { start: "b", value: 3, quality: "ok" },
          { start: "c", value: 0, quality: "missing" },
        ],
      ]),
    ).toEqual([
      { start: "a", value: 3, quality: "approximate", norm: 15 },
      { start: "b", value: 3, quality: "partial" },
      { start: "c", value: 0, quality: "missing" },
    ]);
  });
});
