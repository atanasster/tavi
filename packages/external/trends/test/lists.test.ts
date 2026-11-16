import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import {
  ListSpecSchema,
  TR3_RECORDS,
  listAdapter,
  robotsAllows,
  type SourceCall,
  type SourceRequest,
  type TrendsAdapter,
} from "@tavi/trends-kit";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Fetched, type Fetcher } from "../src/engine.js";

/**
 * The open-page lists: each shipped spec read against the
 * page it was written from, recorded on 2026-10-17 (Hatena's feed cut to 30
 * items; Pantip's and Daum's pages cut to the data each spec reads; authors
 * pseudonymised), and the worker's rules for an open page: robots.txt first,
 * a refusal or a challenge stops the source for the day.
 */
const root = join(import.meta.dirname, "..");
const fixtures = join(import.meta.dirname, "fixtures", "lists");
const page = (file: string): string => readFileSync(join(fixtures, file), "utf8");
const records = new Map(TR3_RECORDS.map((record) => [record.id, record]));
const lists: TrendsAdapter[] = readdirSync(join(root, "lists"))
  .sort()
  .map((file) => {
    const spec = ListSpecSchema.parse(JSON.parse(readFileSync(join(root, "lists", file), "utf8")));
    const record = records.get(spec.recordId);
    if (record === undefined) throw new Error(`no record ${spec.recordId}`);
    return listAdapter(record, spec);
  });
const byId = new Map(lists.map((adapter) => [adapter.record.id, adapter]));
const call = (settings: Record<string, unknown> = {}): SourceCall => ({
  now: "2026-10-17T12:00:00.000Z",
  credential: () => undefined,
  settings,
});

/** One list's entries from its recorded page. */
function read(id: string, body: unknown, settings: Record<string, unknown> = {}) {
  const adapter = byId.get(id);
  const [request] = adapter?.trending?.request({ country: "XX" }, call(settings)) ?? [];
  const answer = adapter?.trending?.parse({ status: 200, body }, request as SourceRequest, { country: "XX" }, call(settings));
  if (answer?.kind !== "ok") throw new Error(`${id}: ${JSON.stringify(answer)}`);
  return { request, entries: answer.value };
}

describe("each shipped list against its recorded page", () => {
  it("ships a spec for each list record, and the records' hosts are the specs'", () => {
    expect(lists.map((adapter) => adapter.record.id)).toEqual(["baidu-hot", "daum-top", "hatena-hot", "pantip-hot", "ptt-board"]);
    for (const adapter of lists) {
      const [request] = adapter.trending?.request({ country: "XX" }, call()) ?? [];
      expect(adapter.record.hosts, adapter.record.id).toContain(new URL(request?.url ?? "").host);
      expect(adapter.record).toMatchObject({ standing: "unofficial", defaultOn: false });
    }
  });

  it("reads Baidu's hot search, in rank order", () => {
    const { entries } = read("baidu-hot", JSON.parse(page("baidu-hot.json")));
    expect(entries.length).toBeGreaterThanOrEqual(30);
    expect(entries[0]).toMatchObject({ title: "总书记心系万里绿色长城", url: expect.stringMatching(/^https:\/\/m\.baidu\.com\/s\?word=/) });
    expect(entries[1]).toMatchObject({ rank: 1, title: "多地试点直升高中" });
  });

  it("reads Hatena's hot entries with their bookmark counts", () => {
    const { entries } = read("hatena-hot", page("hatena-hot.rss"));
    expect(entries).toHaveLength(30);
    expect(entries[0]).toMatchObject({ rank: 1, url: "https://local-historia.jp/", volume: expect.any(Number) });
    expect(entries.every((entry) => entry.title.length > 0)).toBe(true);
  });

  it("reads a PTT board's threads, and refuses an 18+ board without the operator's assertion", () => {
    const { request, entries } = read("ptt-board", page("ptt-stock.html"));
    expect(request?.url).toBe("https://www.ptt.cc/bbs/Stock/index.html");
    expect(request?.headers).toBeUndefined();
    // 13 rows: one thread was deleted, and a deleted thread has no link.
    expect(entries).toHaveLength(12);
    expect(entries[0]).toMatchObject({
      rank: 1,
      title: "Re: [新聞] 台股今年大漲62% 基金經理人反掀離職潮",
      url: "https://www.ptt.cc/bbs/Stock/M.1792234459.A.4D6.html",
    });
    const adapter = byId.get("ptt-board");
    const [gossiping] = adapter?.trending?.request({ country: "TW" }, call({ pttBoard: "Gossiping" })) ?? [];
    expect(
      adapter?.trending?.parse(
        { status: 200, body: page("ptt-gossiping.html") },
        gossiping as SourceRequest,
        { country: "TW" },
        call({ pttBoard: "Gossiping" }),
      ),
    ).toMatchObject({ kind: "failed", class: "blocked", detail: expect.stringMatching(/pttAdultBoards/) });
    const allowed = read("ptt-board", page("ptt-gossiping.html"), { pttBoard: "Gossiping", pttAdultBoards: true });
    expect(allowed.request?.headers).toEqual({ Cookie: "over18=1" });
    expect(allowed.entries.length).toBeGreaterThan(10);
  });

  it("reads Pantip's hot topics with their views, and links each to its topic", () => {
    const { entries } = read("pantip-hot", page("pantip-hot.html"));
    expect(entries).toHaveLength(10);
    expect(entries[0]).toMatchObject({
      rank: 1,
      url: expect.stringMatching(/^https:\/\/pantip\.com\/topic\/\d+$/),
      volume: expect.any(Number),
    });
  });

  it("reads Daum's front-page stories once each", () => {
    const { entries } = read("daum-top", page("daum-top.html"));
    expect(entries.length).toBeGreaterThanOrEqual(50);
    expect(new Set(entries.map((entry) => entry.url)).size).toBe(entries.length);
    expect(entries.some((entry) => entry.url?.startsWith("https://v.daum.net/v/") === true)).toBe(true);
  });

  it("were recorded within 180 days", () => {
    const { recordings } = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "recorded.json"), "utf8")) as {
      recordings: Record<string, { recordedAt: string }>;
    };
    expect(Object.keys(recordings)).toEqual(["lists"]);
    for (const { recordedAt } of Object.values(recordings))
      expect((Date.now() - Date.parse(`${recordedAt}T00:00:00Z`)) / 86_400_000).toBeLessThanOrEqual(180);
  });

  it("asks only paths the sites' recorded robots.txt allow", () => {
    expect(robotsAllows(page("www.daum.net.robots.txt"), "/")).toBe(true);
    expect(robotsAllows(page("www.daum.net.robots.txt"), "/news")).toBe(false);
    expect(robotsAllows(page("b.hatena.ne.jp.robots.txt"), "/hotentry/all.rss")).toBe(true);
    expect(robotsAllows(page("pantip.com.robots.txt"), "/")).toBe(true);
  });
});

describe("the worker's rules for an open page", () => {
  const temp = temporaryDirectories();
  afterEach(() => temp.cleanup());
  const engine = (fetcher: Fetcher, config: Record<string, unknown> = {}) => {
    const directory = temp.create("tavi-trends-lists-");
    const clock = { ms: Date.parse("2026-10-17T12:00:00.000Z") };
    return Object.assign(
      createEngine({
        home: directory,
        fetcher,
        config: { enabledSources: "daum-top,hatena-hot", ...config },
        version: "test",
        adapters: [],
        lists,
        now: () => new Date(clock.ms).toISOString(),
        sleep: async (ms) => void (clock.ms += ms),
      }),
      { clock },
    );
  };
  const operator = { scope: { principalId: "operator", workspaceId: "default" }, unattended: false };
  const signal = () => new AbortController().signal;
  const serve = (routes: Record<string, Fetched>): { readonly fetcher: Fetcher; readonly asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      fetcher: async (request) => {
        asked.push(request.url);
        return routes[request.url] ?? { status: 404, retryAfter: null, body: "not found", bytes: 9 };
      },
    };
  };
  const ok = (body: string): Fetched => ({ status: 200, retryAfter: null, body, bytes: body.length });

  it("reads robots.txt first, once a day, and reads the list only where it allows", async () => {
    const net = serve({
      "https://www.daum.net/robots.txt": ok(page("www.daum.net.robots.txt")),
      "https://www.daum.net/": ok(page("daum-top.html")),
    });
    const radar = engine(net.fetcher);
    const snapshot = await radar.snapshot({ country: "KR" }, signal(), operator);
    // A snapshot keeps a list's first 50 entries.
    expect(snapshot.lists.map((list) => [list.source, list.entries.length])).toEqual([["daum-top", 50]]);
    // Past Daum's budget of one request every 10 seconds, a second read needs no second robots.txt.
    radar.clock.ms += 20_000;
    await radar.snapshot({ country: "KR" }, signal(), operator);
    expect(net.asked).toEqual(["https://www.daum.net/robots.txt", "https://www.daum.net/", "https://www.daum.net/"]);
    radar.close();
  });

  it("stops a source for the day when its robots.txt disallows the list, says no to AI input, or the page is a challenge", async () => {
    for (const [robots, list, why] of [
      ["User-agent: *\nDisallow: /", page("daum-top.html"), /robots\.txt disallows \//],
      ["User-agent: *\nContent-Signal: search=yes, ai-input=no\nAllow: /", page("daum-top.html"), /Content-Signal says no to AI input/],
    ] as const) {
      const net = serve({ "https://www.daum.net/robots.txt": ok(robots), "https://www.daum.net/": ok(list) });
      const radar = engine(net.fetcher);
      expect((await radar.snapshot({ country: "KR" }, signal(), operator)).sources).toEqual([
        { source: "daum-top", outcome: "skipped", why: expect.stringMatching(why) },
      ]);
      expect(net.asked).toEqual(["https://www.daum.net/robots.txt"]);
      expect((await radar.sources({})).sources.find((source) => source.id === "daum-top")).toMatchObject({
        health: "blocked",
        pausedUntil: "2026-10-18T00:00:00.000Z",
      });
      radar.close();
    }
    const challenge = serve({
      "https://www.daum.net/robots.txt": ok(page("www.daum.net.robots.txt")),
      "https://www.daum.net/": ok("<title>Attention Required! | Cloudflare</title>"),
    });
    const radar = engine(challenge.fetcher);
    expect((await radar.snapshot({ country: "KR" }, signal(), operator)).sources).toEqual([
      { source: "daum-top", outcome: "failed", why: "blocked" },
    ]);
    expect((await radar.sources({})).sources.find((source) => source.id === "daum-top")).toMatchObject({
      pausedUntil: "2026-10-18T00:00:00.000Z",
    });
    radar.clock.ms += 3_600_000;
    expect((await radar.snapshot({ country: "KR" }, signal(), operator)).sources[0]).toMatchObject({
      outcome: "skipped",
      why: expect.stringMatching(/paused until 2026-10-18/),
    });
    radar.close();
  });

  it("follows a redirect only on the source's own hosts, asking each hop's robots.txt", async () => {
    const redirect = (location: string): Fetched => ({ status: 301, retryAfter: null, location, body: "", bytes: 0 });
    const robots = ok("User-agent: *\nDisallow: /\nAllow : /$\nAllow : /m/$");
    const hop = serve({
      "https://www.daum.net/robots.txt": robots,
      "https://www.daum.net/": redirect("/m/"),
      "https://www.daum.net/m/": ok(page("daum-top.html")),
    });
    const radar = engine(hop.fetcher);
    expect((await radar.snapshot({ country: "KR" }, signal(), operator)).lists[0]?.entries.length).toBe(50);
    expect(hop.asked).toEqual(["https://www.daum.net/robots.txt", "https://www.daum.net/", "https://www.daum.net/m/"]);
    radar.close();
    for (const [location, why] of [
      ["https://evil.example/list", /off its own hosts/],
      ["/news/", /robots\.txt disallows \/news\//],
    ] as const) {
      const net = serve({
        "https://www.daum.net/robots.txt": robots,
        "https://www.daum.net/": redirect(location),
        "https://evil.example/list": ok(page("daum-top.html")),
        "https://www.daum.net/news/": ok(page("daum-top.html")),
      });
      const off = engine(net.fetcher);
      expect((await off.snapshot({ country: "KR" }, signal(), operator)).sources).toEqual([
        { source: "daum-top", outcome: "skipped", why: expect.stringMatching(why) },
      ]);
      expect(net.asked).toEqual(["https://www.daum.net/robots.txt", "https://www.daum.net/"]);
      expect((await off.sources({})).sources.find((source) => source.id === "daum-top")).toMatchObject({
        health: "blocked",
        pausedUntil: "2026-10-18T00:00:00.000Z",
      });
      off.close();
    }
  });

  it("reads a site with no robots.txt as allowing all, skips without pausing when one cannot be read, and leaves a 401 until tomorrow", async () => {
    const none = serve({ "https://www.daum.net/": ok(page("daum-top.html")) });
    const radar = engine(none.fetcher);
    expect((await radar.snapshot({ country: "KR" }, signal(), operator)).lists[0]?.entries.length).toBe(50);
    radar.close();
    const broken = serve({ "https://www.daum.net/robots.txt": { status: 503, retryAfter: null, body: "busy", bytes: 4 } });
    const unread = engine(broken.fetcher);
    expect((await unread.snapshot({ country: "KR" }, signal(), operator)).sources).toEqual([
      { source: "daum-top", outcome: "skipped", why: "its robots.txt could not be read" },
    ]);
    expect((await unread.sources({})).sources.find((source) => source.id === "daum-top")).not.toHaveProperty("pausedUntil");
    unread.close();
    const refused = serve({
      "https://www.daum.net/robots.txt": ok(page("www.daum.net.robots.txt")),
      "https://www.daum.net/": { status: 401, retryAfter: null, body: "no", bytes: 2 },
    });
    const auth = engine(refused.fetcher);
    await auth.snapshot({ country: "KR" }, signal(), operator);
    expect((await auth.sources({})).sources.find((source) => source.id === "daum-top")).toMatchObject({
      health: "auth",
      pausedUntil: "2026-10-18T00:00:00.000Z",
    });
    auth.close();
  });

  it("leaves a page that asks it to slow down until tomorrow, whatever its Retry-After", async () => {
    const net = serve({
      "https://b.hatena.ne.jp/robots.txt": ok(page("b.hatena.ne.jp.robots.txt")),
      "https://b.hatena.ne.jp/hotentry/all.rss": { status: 429, retryAfter: "60", body: "slow down", bytes: 9 },
    });
    const radar = engine(net.fetcher);
    await radar.snapshot({ country: "JP" }, signal(), operator);
    expect((await radar.sources({})).sources.find((source) => source.id === "hatena-hot")).toMatchObject({
      health: "quota",
      pausedUntil: "2026-10-18T00:00:00.000Z",
    });
    radar.close();
  });
});
