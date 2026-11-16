import { describe, expect, it } from "vitest";

import {
  HATENA_HOT,
  ListSpecSchema,
  PTT_BOARD,
  jsonAt,
  listAdapter,
  listUrl,
  refusesAiInput,
  robotsContentSignal,
  type AdapterTopic,
  type SourceCall,
  type SourceRequest,
} from "../src/index.js";

/** The open-page list adapter, on small pages written for each rule. */
const NOW = "2026-10-17T12:20:00.000Z";
const call = (settings: Record<string, unknown> = {}): SourceCall => ({ now: NOW, credential: () => undefined, settings });
const topic: AdapterTopic = {
  label: "Typhoon",
  terms: ["typhoon", "颱風"],
  termsByLanguage: { en: ["typhoon"], "zh-Hant": ["颱風"] },
  exclude: [],
  articles: {},
  countries: ["TW"],
};
const ok = (body: unknown, extra: { contentSignal?: string } = {}) => ({ status: 200, body, ...extra });

const anchors = ListSpecSchema.parse({
  recordId: "ptt-board",
  url: "https://www.ptt.cc/bbs/{pttBoard}/index.html",
  extract: { mode: "anchors", href: "^/bbs/[A-Za-z0-9_-]+/M\\.\\d+\\.A\\.[0-9A-F]{3}\\.html$" },
  map: { title: "title" },
  settings: [{ name: "pttBoard", default: "Stock", pattern: "[A-Za-z0-9_-]{2,20}" }],
  cookies: [{ name: "over18", value: "1", assertion: "I am 18 or older", setting: "pttAdultBoards" }],
  refusedWhen: [{ marker: "ask/over18", reason: "an 18+ board", unless: "pttAdultBoards" }],
});
const board = `<div class="r-ent"><div class="title"><a href="/bbs/Stock/M.1792234459.A.4D6.html">[新聞] 颱風 來襲</a></div></div>
<div class="r-ent"><div class="title"><a href="/bbs/Stock/M.1792235124.A.8EB.html">[請益] 這波下殺</a></div></div>
<a href="/bbs/Stock/index123.html">‹ 上頁</a><a href="javascript:alert(1)">x</a>`;

describe("JSON paths", () => {
  it("read a key, an index, every element, and a key at any depth", () => {
    const value = {
      data: { cards: [{ content: [{ content: [{ word: "a" }, { word: "b" }] }] }] },
      frames: [{ children: [{ contents: { data: [1, 2] } }, { contents: { data: [3] } }] }],
    };
    expect(jsonAt(value, "$.data.cards[0].content[0].content[*]")).toEqual([{ word: "a" }, { word: "b" }]);
    expect(jsonAt(value, "$..contents.data[*]")).toEqual([1, 2, 3]);
    expect(jsonAt(value, "$.data.cards[5]")).toEqual([]);
    expect(() => ListSpecSchema.parse({ ...anchors, extract: { mode: "json", path: "data.cards" } })).toThrow(/a path such as/);
  });
});

describe("the list adapter", () => {
  const adapter = listAdapter(PTT_BOARD, anchors);

  it("fills a setting into the address only with a value it allows, and sends the age cookie only with the operator's assertion", () => {
    expect(listUrl(anchors, call())).toBe("https://www.ptt.cc/bbs/Stock/index.html");
    expect(listUrl(anchors, call({ pttBoard: "C_Chat" }))).toBe("https://www.ptt.cc/bbs/C_Chat/index.html");
    expect(listUrl(anchors, call({ pttBoard: "../../etc" }))).toBeUndefined();
    expect(adapter.unconfigured?.(call({ pttBoard: "x/y" }))).toMatch(/pttBoard/);
    // Redirects are the worker's, so each hop's robots.txt is asked.
    expect(adapter.trending?.request({ country: "TW" }, call())).toEqual([
      { url: "https://www.ptt.cc/bbs/Stock/index.html", expect: "text", redirect: "manual" },
    ]);
    expect(adapter.trending?.request({ country: "TW" }, call({ pttAdultBoards: true }))[0]?.headers).toEqual({ Cookie: "over18=1" });
    expect(adapter.robots).toBe(true);
  });

  it("reads a board's threads from its links, absolute and in order", () => {
    const [request] = adapter.trending?.request({ country: "TW" }, call()) ?? [];
    expect(adapter.trending?.parse(ok(board), request as SourceRequest, { country: "TW" }, call())).toEqual({
      kind: "ok",
      value: [
        { title: "[新聞] 颱風 來襲", rank: 1, url: "https://www.ptt.cc/bbs/Stock/M.1792234459.A.4D6.html" },
        { title: "[請益] 這波下殺", rank: 2, url: "https://www.ptt.cc/bbs/Stock/M.1792235124.A.8EB.html" },
      ],
    });
  });

  it("refuses an 18+ board without the assertion, a challenge page, and an answer whose Content-Signal says no to AI input", () => {
    const [request] = adapter.trending?.request({ country: "TW" }, call()) ?? [];
    const adult = `<script>if (document.cookie.indexOf('over18=1') === -1) { location = 'https://www.ptt.cc/ask/over18?from=' }</script>${board}`;
    expect(adapter.trending?.parse(ok(adult), request as SourceRequest, { country: "TW" }, call())).toMatchObject({
      kind: "failed",
      class: "blocked",
      detail: "an 18+ board",
    });
    expect(adapter.trending?.parse(ok(adult), request as SourceRequest, { country: "TW" }, call({ pttAdultBoards: true }))).toMatchObject({
      kind: "ok",
    });
    expect(
      adapter.trending?.parse(
        ok('<html><title>Attention Required! | Cloudflare</title><div id="cf-chl-widget"></div></html>'),
        request as SourceRequest,
        { country: "TW" },
        call(),
      ),
    ).toMatchObject({ kind: "failed", class: "blocked", detail: "a challenge page" });
    expect(
      adapter.trending?.parse(ok(board, { contentSignal: "search=yes, ai-input=no" }), request as SourceRequest, { country: "TW" }, call()),
    ).toMatchObject({ kind: "failed", class: "blocked" });
    expect(adapter.trending?.parse({ status: 403, body: "no" }, request as SourceRequest, { country: "TW" }, call())).toMatchObject({
      kind: "failed",
      class: "blocked",
    });
  });

  it("counts, in the bucket holding now, the entries that name the topic", () => {
    const window = { from: "2026-10-17T10:00:00.000Z", to: "2026-10-17T13:00:00.000Z", bucket: "hour" as const };
    const [request] = adapter.counts?.request({ topic, window }, call()) ?? [];
    expect(adapter.counts?.parse(ok(board), request as SourceRequest, { topic, window }, call())).toEqual({
      kind: "ok",
      value: [
        {
          metric: "entries",
          points: [
            { start: "2026-10-17T10:00:00.000Z", value: 0, quality: "missing" },
            { start: "2026-10-17T11:00:00.000Z", value: 0, quality: "missing" },
            { start: "2026-10-17T12:00:00.000Z", value: 1, quality: "approximate" },
          ],
        },
      ],
    });
  });

  it("reads an RSS 1.0 feed, an embedded JSON value, and a JSON-LD ItemList, each entry's link kept only as http(s)", () => {
    const rss = listAdapter(HATENA_HOT, {
      recordId: "hatena-hot",
      url: "https://b.hatena.ne.jp/hotentry/all.rss",
      extract: { mode: "rss" },
      map: { title: "title" },
      settings: [],
      cookies: [],
      refusedWhen: [],
    });
    const feed = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:hatena="http://www.hatena.ne.jp/info/xmlns#"><channel><title>Hot</title></channel>
      <item rdf:about="https://example.org/a"><title>Typhoon nears Taiwan</title><link>https://example.org/a</link><hatena:bookmarkcount>321</hatena:bookmarkcount></item>
      <item rdf:about="javascript:x"><title>Bad link</title><link>javascript:alert(1)</link></item></rdf:RDF>`;
    expect(
      rss.trending?.parse(ok(feed), { url: "https://b.hatena.ne.jp/hotentry/all.rss", expect: "text" }, { country: "JP" }, call()),
    ).toEqual({
      kind: "ok",
      value: [
        { title: "Typhoon nears Taiwan", rank: 1, url: "https://example.org/a", volume: 321, volumeLabel: "321" },
        { title: "Bad link", rank: 2 },
      ],
    });
    const embedded = listAdapter(HATENA_HOT, {
      recordId: "hatena-hot",
      url: "https://example.org/",
      extract: { mode: "embedded-json", marker: "window.data=", path: "$.list[*]" },
      map: { title: "name", url: "https://example.org/t/{id}" },
      settings: [],
      cookies: [],
      refusedWhen: [],
    });
    expect(
      embedded.trending?.parse(
        ok('<script>window.data={"list":[{"id":7,"name":"A \\"quoted\\" } brace"},{"name":"no id"}]};</script>'),
        { url: "https://example.org/", expect: "text" },
        { country: "JP" },
        call(),
      ),
    ).toEqual({
      kind: "ok",
      value: [
        { title: 'A "quoted" } brace', rank: 1, url: "https://example.org/t/7" },
        { title: "no id", rank: 2 },
      ],
    });
    const jsonld = listAdapter(HATENA_HOT, {
      recordId: "hatena-hot",
      url: "https://example.org/",
      extract: { mode: "jsonld", type: "ItemList" },
      map: { title: "name", url: "url", rank: "position" },
      settings: [],
      cookies: [],
      refusedWhen: [],
    });
    const page = `<script type="application/ld+json">${JSON.stringify({
      "@type": "ItemList",
      itemListElement: [
        { "@type": "ListItem", position: 2, name: "Second", url: "/b" },
        { "@type": "ListItem", position: 1, name: "First", url: "https://example.org/a" },
      ],
    })}</script>`;
    expect(jsonld.trending?.parse(ok(page), { url: "https://example.org/", expect: "text" }, { country: "JP" }, call())).toEqual({
      kind: "ok",
      value: [
        { title: "Second", rank: 2, url: "https://example.org/b" },
        { title: "First", rank: 1, url: "https://example.org/a" },
      ],
    });
  });
});

describe("a hostile page", () => {
  it("costs one pass however its tags are left open", () => {
    const adapter = listAdapter(PTT_BOARD, anchors);
    const [request] = adapter.trending?.request({ country: "TW" }, call()) ?? [];
    for (const body of ['<a href="x">y'.repeat(200_000), '<script type="application/ld+json">{'.repeat(100_000), "<a ".repeat(500_000)]) {
      const started = performance.now();
      adapter.trending?.parse(ok(body), request as SourceRequest, { country: "TW" }, call());
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });
});

describe("Content-Signal", () => {
  it("is a no to AI input only when it says ai-input=no, in a header or a robots.txt", () => {
    expect(refusesAiInput("search=yes, ai-input=no")).toBe(true);
    expect(refusesAiInput("ai-train=no, search=yes, ai-input=yes")).toBe(false);
    expect(refusesAiInput(undefined)).toBe(false);
    expect(robotsContentSignal("User-agent: *\nContent-Signal: search=yes, ai-train=no\nContent-signal: ai-input=no\nAllow: /")).toBe(
      " search=yes, ai-train=no, ai-input=no",
    );
    expect(robotsContentSignal("User-agent: *\nDisallow: /x")).toBeUndefined();
  });
});
