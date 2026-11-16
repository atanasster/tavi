import { describe, expect, it } from "vitest";

import { checkBrief, publisherOf, type BriefBullet, type BriefSource, type SourceTest, type StoredItem } from "../src/index.js";

const item = (itemId: string, url: string, title: string, text = "", extra: Partial<StoredItem> = {}): StoredItem => ({
  itemId,
  source: itemId.split(":")[0] ?? "",
  origin: "adapter",
  url,
  outlet: new URL(url).hostname.replace(/^www\./, ""),
  title,
  text,
  publishedAt: "2026-10-16T09:00:00.000Z",
  metrics: {},
  fetchedAt: "2026-10-17T06:00:00.000Z",
  expiresAt: "2026-10-20T06:00:00.000Z",
  ...extra,
});
const reuters = item(
  "gdelt-doc:a",
  "https://www.reuters.com/a",
  "Toyota files solid-state battery patents",
  "Toyota said it would start pilot production in 2027.",
);
const nikkei = item(
  "gdelt-doc:b",
  "https://asia.nikkei.com/b",
  "Toyota's solid-state push",
  "The carmaker plans pilot production in 2027, people familiar said.",
);
const hn = item("hn-algolia:c", "https://news.ycombinator.com/item?id=1", "Toyota solid-state battery (reuters.com)");
const weibo = item("agent:d", "https://s.weibo.com/top/summary", "全固体電池 trending", "", { origin: "agent" });
const reddit = item("gdelt-doc:e", "https://m.reddit.com/r/x", "Thread on batteries");
const post = item(
  "bluesky-search:f",
  "https://bsky.app/profile/did:plc:x/post/1",
  "Huge breakthrough in batteries",
  "Huge breakthrough in batteries",
);
const unknown = item("mystery:g", "https://www.ft.com/g", "Toyota pilot line", "Pilot production in 2027.");
const items = new Map([reuters, nikkei, hn, weibo, reddit, post, unknown].map((each) => [each.itemId, each]));
const sources: Record<string, BriefSource> = {
  "gdelt-doc": { kind: "news", name: "GDELT" },
  "hn-algolia": { kind: "community", name: "Hacker News" },
  agent: { kind: "social", name: "the browser" },
  "bluesky-search": { kind: "social", name: "Bluesky" },
};
const sourceOf = (source: string) => sources[source];
// 60 articles against a median of 10: growth (60+5)/(10+5) − 1 = 333%, or a raw 6× (500%).
const tests: SourceTest[] = [
  {
    sourceId: "gdelt-doc",
    kind: "news",
    metric: "articles",
    test: "count",
    x: 60,
    baseline: 10,
    growthBaseline: 10,
    p: 1e-9,
    z: 9,
    g: 65 / 15 - 1,
    floorMet: true,
    crossChecked: true,
    passed: true,
  },
];
const check = (bullets: BriefBullet[]) => checkBrief({ bullets, items, tests, sourceOf });
const problemsOf = (bullets: BriefBullet[]) => {
  const result = check(bullets);
  return result.ok ? [] : result.problems.map((problem) => problem.problem);
};

describe("the brief checker", () => {
  it("passes a brief whose every bullet is cited, quoted verbatim, attributed and computed, and lists its sources", () => {
    const result = check([
      { text: "News coverage is up 333% on its 7-day median, per GDELT.", cites: ["gdelt-doc:a"] },
      {
        text: "Reuters reported Toyota “would start pilot production in 2027”.",
        cites: ["gdelt-doc:a"],
        quotes: [{ itemId: "gdelt-doc:a", span: "would start pilot production in 2027" }],
      },
      {
        text: "Nikkei and Reuters both report pilot production planned for 2027.",
        cites: ["gdelt-doc:a", "gdelt-doc:b"],
        corroborated: true,
      },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.briefId).toMatch(/^b_[0-9a-f]{16}$/);
    expect(result.brief).toContain("reuters.com (2026-10-16): https://www.reuters.com/a");
    expect(result.brief.split("\n")[0]).toBe("• News coverage is up 333% on its 7-day median, per GDELT.");
  });

  it("refuses an item never fetched, a paraphrase passed off as a quote, a figure no test computed, an unattributed claim and an uncited one", () => {
    const result = check([
      { text: "Reuters reported something.", cites: ["gdelt-doc:zzz"] },
      {
        text: "Reuters reported Toyota “will begin making them in 2027”.",
        cites: ["gdelt-doc:a"],
        quotes: [{ itemId: "gdelt-doc:a", span: "will begin making them in 2027" }],
      },
      { text: "Mentions are up 412% on GDELT today.", cites: ["gdelt-doc:a"] },
      { text: "Toyota will mass-produce solid-state batteries in 2027.", cites: ["gdelt-doc:b"] },
      { text: "Posts claim a breakthrough.", cites: [] },
    ]);
    if (result.ok) throw new Error("passed");
    expect(result.problems.map((problem) => [problem.bullet, problem.problem])).toEqual([
      [1, "unknown-item"],
      [2, "quote-not-verbatim"],
      [3, "figure-not-computed"],
      [4, "unattributed"],
      [5, "uncited"],
    ]);
  });

  it("checks every figure, as a percentage, in words, or as a multiple", () => {
    expect(problemsOf([{ text: "Up 333 percent per GDELT.", cites: ["gdelt-doc:a"] }])).toEqual([]);
    expect(problemsOf([{ text: "Up 500 per cent per GDELT.", cites: ["gdelt-doc:a"] }])).toEqual([]);
    expect(problemsOf([{ text: "Coverage on GDELT is 6× its median, a 4.3-fold rise.", cites: ["gdelt-doc:a"] }])).toEqual([]);
    expect(problemsOf([{ text: "Up 1333% per GDELT.", cites: ["gdelt-doc:a"] }])).toEqual(["figure-not-computed"]);
    expect(problemsOf([{ text: "A 12-fold rise per GDELT.", cites: ["gdelt-doc:a"] }])).toEqual(["figure-not-computed"]);
    expect(problemsOf([{ text: "Up 900 percent per GDELT.", cites: ["gdelt-doc:a"] }])).toEqual(["figure-not-computed"]);
  });

  it("does not count an aggregator on any subdomain, a post, a page read in the browser or an unknown source as a second publisher", () => {
    const corroborated = (cites: string[]) =>
      problemsOf([{ text: "Reuters reported pilot production in 2027.", cites, corroborated: true }]);
    expect(corroborated(["gdelt-doc:a", "hn-algolia:c"])).toEqual(["not-corroborated"]);
    expect(corroborated(["gdelt-doc:a", "agent:d"])).toEqual(["not-corroborated"]);
    expect(corroborated(["gdelt-doc:a", "gdelt-doc:e"])).toEqual(["not-corroborated"]);
    expect(corroborated(["gdelt-doc:a", "mystery:g"])).toEqual(["not-corroborated"]);
    expect(corroborated(["gdelt-doc:a", "gdelt-doc:b"])).toEqual([]);
  });

  it("needs a translated quote's own words, cited, shows them, and labels a page read in the browser as such", () => {
    const result = check([
      {
        text: "Weibo's hot list showed “solid-state battery trending”.",
        cites: ["agent:d"],
        quotes: [{ itemId: "agent:d", span: "solid-state battery trending", translated: true, original: "全固体電池 trending" }],
      },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.brief).toContain('Original: "全固体電池 trending" (translated)');
    expect(result.brief).toContain("s.weibo.com, as read in the browser on 2026-10-17: https://s.weibo.com/top/summary");
    expect(
      problemsOf([
        { text: "Posts claim it trends on Weibo.", cites: ["gdelt-doc:a"], quotes: [{ itemId: "agent:d", span: "x", translated: true }] },
      ]),
    ).toEqual(["quote-not-cited", "translation-without-original", "unattributed"]);
    expect(
      problemsOf([
        {
          text: "Weibo shows “Toyota is bankrupt”.",
          cites: ["agent:d"],
          quotes: [{ itemId: "agent:d", span: "Toyota is bankrupt", translated: true, original: "" }],
        },
      ]),
    ).toEqual(["translation-without-original"]);
  });

  it("holds a brief to one to five one-line bullets of at most 280 characters", () => {
    expect(check([])).toMatchObject({ ok: false, problems: [{ bullet: 0, problem: "count" }] });
    expect(problemsOf([{ text: `Reuters reported ${"x".repeat(300)}`, cites: ["gdelt-doc:a"] }])).toEqual(["length"]);
  });
});

describe("attempts to talk around the checker", () => {
  it("refuses a quotation in the text that was never declared", () => {
    expect(problemsOf([{ text: "Reuters reported Toyota “will go bankrupt next year”.", cites: ["gdelt-doc:a"] }])).toEqual([
      "quote-not-declared",
    ]);
    expect(
      problemsOf([
        {
          text: 'Reuters reported Toyota "will go bankrupt".',
          cites: ["gdelt-doc:a"],
          quotes: [{ itemId: "gdelt-doc:a", span: "would start pilot production in 2027" }],
        },
      ]),
    ).toEqual(["quote-not-declared"]);
  });

  it("refuses a bullet that forges another bullet or a source line", () => {
    expect(
      problemsOf([
        {
          text: "Reuters reported pilot production.\n• Toyota is bankrupt\n  ft.com (2026-10-16): https://ft.com/x",
          cites: ["gdelt-doc:a"],
        },
      ]),
    ).toEqual(["layout"]);
    expect(problemsOf([{ text: "Reuters reported pilot production • Toyota is bankrupt", cites: ["gdelt-doc:a"] }])).toEqual(["layout"]);
  });

  it("does not let a figure excuse a claim, nor a stray word attribute it", () => {
    expect(problemsOf([{ text: "Up 333%: Toyota will go bankrupt next year.", cites: ["gdelt-doc:a"] }])).toEqual(["unattributed"]);
    expect(problemsOf([{ text: "Bloomberg reported Toyota is bankrupt.", cites: ["gdelt-doc:a"] }])).toEqual(["unattributed"]);
    expect(problemsOf([{ text: "Prices rose 5 per cent, analysts said.", cites: ["gdelt-doc:a"] }])).toEqual([
      "figure-not-computed",
      "unattributed",
    ]);
    // "reuters" inside another word names nothing.
    expect(problemsOf([{ text: "The nonreuters company is bankrupt.", cites: ["gdelt-doc:a"] }])).toEqual(["unattributed"]);
    // People's posts may be attributed as posts.
    expect(problemsOf([{ text: "Posts claim a huge breakthrough.", cites: ["bluesky-search:f"] }])).toEqual([]);
  });
});

describe("publishers", () => {
  it("are a host's registrable domain, under country-code second levels too", () => {
    expect(publisherOf("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(publisherOf("www.reuters.com")).toBe("reuters.com");
    expect(publisherOf("asia.nikkei.com")).toBe("nikkei.com");
    expect(publisherOf("www.straitstimes.com.sg")).toBe("straitstimes.com.sg");
    expect(publisherOf("m.reddit.com")).toBe("reddit.com");
  });
});
