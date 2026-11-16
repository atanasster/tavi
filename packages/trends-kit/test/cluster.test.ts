import { describe, expect, it } from "vitest";

import {
  ClusterResultSchema,
  agglomerate,
  clusterItems,
  coordinatedGroups,
  hammingDistance,
  minhashOf,
  minhashSimilarity,
  shinglesOf,
  simhashOf,
  tfidfVectors,
  tokensOf,
  type ClusterItem,
} from "../src/index.js";

/**
 * Clustering: the 1,200-comment fixture, seeded so it is the
 * same on every run: 1,200 comments, of which 140 are verbatim copies of
 * others, and of the 1,060 left 12% are noise and the rest fall in three
 * themes. Plus coordination, near-duplicates and the tokenizer.
 */

/** A small seeded generator (mulberry32), so the fixture never changes. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const THEMES = {
  price:
    "price prices expensive cost costs afford affordable cheaper money budget subsidy dollars pricing premium discount wallet savings fee fees charge",
  range:
    "range miles kilometers charge charging distance battery winter cold highway trip trips commute fast charger chargers mileage road",
  safety:
    "safety fire fires recall recalls crash crashes thermal runaway risk risks danger dangerous insurance standard standards test tests",
};
const FILLER =
  "the a i think this that it is was really just so very honestly maybe probably we they people my our new car cars still about would could should because when what".split(
    " ",
  );
/** Noise: chatter on anything else, drawn from 2,000 made-up words, so two noise comments rarely share one. */
const noiseWord = (next: () => number): string =>
  Array.from({ length: 5 + Math.floor(next() * 4) }, () => "bcdfghklmnprstvz"[Math.floor(next() * 16)] ?? "x").join("");

interface Comment extends ClusterItem {
  readonly gold: string;
}

function fixture(): Comment[] {
  const next = random(42);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const comment = (words: readonly string[], share: number): string =>
    Array.from({ length: 22 + Math.floor(next() * 10) }, () => (next() < share ? pick(words) : pick(FILLER))).join(" ");
  const unique: Comment[] = [];
  const themes = Object.entries(THEMES).map(([name, words]) => [name, words.split(" ")] as const);
  const chatter = Array.from({ length: 2_000 }, () => noiseWord(next));
  for (let index = 0; index < 1_060; index += 1) {
    const noise = index % 25 < 3;
    if (noise)
      unique.push({
        itemId: `c${String(index)}`,
        text: comment(chatter, 0.8),
        gold: `noise-${String(index)}`,
        authorHash: `a${String(index)}`,
      });
    else {
      const [name, words] = themes[index % 3] ?? themes[0] ?? ["", []];
      unique.push({ itemId: `c${String(index)}`, text: comment(words, 0.5), gold: name, authorHash: `a${String(index)}` });
    }
  }
  const copies: Comment[] = Array.from({ length: 140 }, (_, index) => {
    const original = unique[Math.floor(next() * unique.length)] as Comment;
    return { ...original, itemId: `copy${String(index)}`, authorHash: `copier${String(index)}` };
  });
  return [...unique, ...copies];
}

/** B-cubed F1 of a clustering against gold labels, over the items both name. */
function bcubed(predicted: ReadonlyMap<string, string>, gold: ReadonlyMap<string, string>): number {
  const ids = [...predicted.keys()];
  const byPredicted = new Map<string, string[]>();
  const byGold = new Map<string, string[]>();
  for (const id of ids) {
    byPredicted.set(predicted.get(id) ?? "", [...(byPredicted.get(predicted.get(id) ?? "") ?? []), id]);
    byGold.set(gold.get(id) ?? "", [...(byGold.get(gold.get(id) ?? "") ?? []), id]);
  }
  let precision = 0;
  let recall = 0;
  for (const id of ids) {
    const sameCluster = byPredicted.get(predicted.get(id) ?? "") ?? [];
    const sameClass = byGold.get(gold.get(id) ?? "") ?? [];
    const both = sameCluster.filter((other) => gold.get(other) === gold.get(id)).length;
    precision += both / sameCluster.length;
    recall += both / sameClass.length;
  }
  precision /= ids.length;
  recall /= ids.length;
  return (2 * precision * recall) / (precision + recall);
}

describe("the 1,200-comment fixture", () => {
  const comments = fixture();
  const result = clusterItems(comments);

  it("excludes the 140 copies, and its themes and Other are every one of the 1,060 left", () => {
    expect(comments).toHaveLength(1_200);
    expect(result.excluded).toEqual([{ reason: "duplicate", count: 140 }]);
    expect(result.valid).toBe(1_060);
    expect(result.themes.reduce((sum, theme) => sum + theme.count, 0) + result.other.count).toBe(1_060);
    expect(result.themes.reduce((sum, theme) => sum + theme.share, 0) + result.other.share).toBeCloseTo(1, 3);
    expect(ClusterResultSchema.safeParse(result).success).toBe(true);
  });

  it("finds the three themes at B-cubed F1 of 0.8 or more, noise in Other", () => {
    const quoted = new Map(comments.map((comment) => [comment.itemId, comment]));
    // Each theme is named by the words that set it apart.
    expect(result.themes).toHaveLength(3);
    for (const theme of result.themes) {
      const golds = new Set(theme.quotes.map((quote) => quoted.get(quote.itemId)?.gold));
      expect(golds.size, theme.id).toBe(1);
      const [gold] = [...golds];
      expect(
        theme.keywords.some((word) => THEMES[gold as keyof typeof THEMES].split(" ").includes(word)),
        theme.id,
      ).toBe(true);
    }
    // Predicted: each theme's members, and each item in Other alone.
    const vectors = tfidfVectors(comments.slice(0, 1_060).map((comment) => comment.text));
    const clusters = agglomerate(vectors);
    const minSize = Math.max(5, Math.ceil(1_060 * 0.02));
    const predicted = new Map<string, string>();
    clusters.forEach((cluster, index) => {
      for (const position of cluster)
        predicted.set(comments[position]?.itemId ?? "", cluster.length >= minSize ? `theme-${String(index)}` : `other-${String(position)}`);
    });
    const gold = new Map(comments.slice(0, 1_060).map((comment) => [comment.itemId, comment.gold]));
    expect(bcubed(predicted, gold)).toBeGreaterThanOrEqual(0.8);
  });

  it("quotes each theme's items verbatim, from different authors", () => {
    const byId = new Map(comments.map((comment) => [comment.itemId, comment]));
    for (const theme of result.themes) {
      expect(theme.quotes.length, theme.id).toBe(5);
      for (const quote of theme.quotes) expect(byId.get(quote.itemId)?.text.startsWith(quote.span), quote.itemId).toBe(true);
      expect(new Set(theme.quotes.map((quote) => byId.get(quote.itemId)?.authorHash)).size).toBe(5);
    }
  });
});

describe("coordination, near-duplicates and topics", () => {
  const at = (minutes: number): string => new Date(Date.parse("2026-10-17T12:00:00.000Z") + minutes * 60_000).toISOString();
  const text = "Everyone should switch to solid-state batteries today, the old ones are a scam";

  it("excludes the same text from 6 accounts within 2 minutes, and not from 4", () => {
    const six = Array.from({ length: 6 }, (_, index) => ({ index, text, authorHash: `acct${String(index)}`, at: at(index * 0.4) }));
    expect(coordinatedGroups(six)).toEqual([{ members: [0, 1, 2, 3, 4, 5], authors: 6 }]);
    expect(coordinatedGroups(six.slice(0, 4))).toEqual([]);
    // Spread over hours, the same six are not a burst.
    expect(coordinatedGroups(six.map((item, index) => ({ ...item, at: at(index * 30) })))).toEqual([]);
    const items: ClusterItem[] = [
      ...six.map((item) => ({ itemId: `x${String(item.index)}`, text, authorHash: item.authorHash, publishedAt: item.at })),
      { itemId: "y", text: "Solid-state batteries charge faster in cold weather tests", authorHash: "other", publishedAt: at(1) },
    ];
    expect(clusterItems(items, { minClusterSize: 1 }).excluded).toEqual([
      { reason: "coordination", count: 6, detail: "possible coordinated amplification (6 accounts, identical text within 10 min)" },
    ]);
  });

  it("drops a near-copy of a long text (MinHash) and of a short post (SimHash), keeping the first", () => {
    const long =
      "The new solid-state battery pilot line in Japan will start small production next year and the company says costs will fall after that as yields improve across the plant";
    const shingles = shinglesOf(long);
    expect(minhashSimilarity(minhashOf(shingles), minhashOf(shinglesOf(`${long} today`)))).toBeGreaterThanOrEqual(0.8);
    expect(
      hammingDistance(simhashOf("solid-state batteries are finally here!!"), simhashOf("Solid-state batteries are finally here")),
    ).toBeLessThanOrEqual(3);
    const result = clusterItems(
      [
        { itemId: "a", text: long },
        { itemId: "b", text: `${long} today` },
        { itemId: "c", text: "solid-state batteries are finally here!!" },
        { itemId: "d", text: "Solid-state batteries are finally here" },
      ],
      { minClusterSize: 1 },
    );
    // "here!!" and "here" fold to different text, so the short pair is a near-copy too, not an exact one.
    expect(result.excluded).toEqual([{ reason: "near-duplicate", count: 2 }]);
    expect(result.valid).toBe(2);
  });

  it("finds a wave of 2,500 near-copies as one, in linear time", () => {
    const base =
      "Solid-state batteries will make every electric car cheaper and safer next year according to the new report from the industry group that tracks battery prices";
    const wave = Array.from({ length: 2_500 }, (_, index) => ({ itemId: `w${String(index)}`, text: `${base} ${String(index)}` }));
    const started = performance.now();
    const result = clusterItems(wave, { minClusterSize: 1 });
    expect(result.excluded).toEqual([{ reason: "near-duplicate", count: 2_499 }]);
    expect(result.valid).toBe(1);
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  it("quotes whole characters only, never half an emoji", () => {
    const text = `${"a".repeat(399)}😀 and more`;
    const result = clusterItems(
      Array.from({ length: 5 }, (_, index) => ({
        itemId: `e${String(index)}`,
        text: `${text} ${"bcdfg"[index] ?? ""}`.replace("a", "abcde"[index] ?? "a"),
      })),
      { minClusterSize: 1, tau: 0 },
    );
    for (const quote of result.themes.flatMap((theme) => theme.quotes)) expect(quote.span.endsWith("a")).toBe(true);
  });

  it("excludes what names none of the topic's terms, or an exclusion", () => {
    const result = clusterItems(
      [
        { itemId: "a", text: "solid-state battery news" },
        { itemId: "b", text: "a cake recipe" },
        { itemId: "c", text: "solid-state battery phone case" },
      ],
      { terms: ["solid-state battery"], exclude: ["phone"], minClusterSize: 1 },
    );
    expect(result.excluded).toEqual([{ reason: "off-topic", count: 2 }]);
  });

  it("reads Japanese as character bigrams, so it clusters too", () => {
    expect(tokensOf("全固体電池が来年")).toEqual(["全固", "固体", "体電", "電池", "池が", "が来", "来年"]);
    expect(tokensOf("Café  CAFÉ")).toEqual(["cafe", "cafe"]);
  });
});
