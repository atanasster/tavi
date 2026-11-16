import { z } from "zod";

import { about } from "../sources/common.js";
import { coordinatedGroups } from "./coord.js";
import { CLUSTER_ITEMS_MAX, CLUSTER_TAU, agglomerate, clusterKeywords, cosine, tfidfVectors } from "./lexical.js";
import { NEAR_DUPLICATE_JACCARD, minhashOf, nearDuplicatePairs, shinglesOf } from "./minhash.js";
import { SHORT_POST_TOKENS, SIMHASH_MAX_DISTANCE, hammingDistance, simhashOf } from "./simhash.js";
import { foldText, tokensOf } from "./text.js";

export { COORDINATION_MIN_AUTHORS, COORDINATION_WINDOW_MS, coordinatedGroups } from "./coord.js";
export { CLUSTER_ITEMS_MAX, CLUSTER_TAU, agglomerate, clusterKeywords, tfidfVectors } from "./lexical.js";
export {
  MINHASH_BANDS,
  MINHASH_PERMUTATIONS,
  NEAR_DUPLICATE_JACCARD,
  bandKeysOf,
  minhashOf,
  minhashSimilarity,
  nearDuplicatePairs,
  shinglesOf,
} from "./minhash.js";
export { SHORT_POST_TOKENS, SIMHASH_MAX_DISTANCE, hammingDistance, simhashOf } from "./simhash.js";
export { foldText, tokensOf } from "./text.js";

/**
 * What a set of items says: copies and coordinated bursts
 * excluded and counted, then lexical themes over what is left, each with its
 * share, its distinguishing words and verbatim quotes, and an Other for the
 * rest. Themes and Other together are every valid item. Labels are the
 * model's, written from the quotes and checked by `brief`; this names no
 * theme and scores no sentiment.
 */
export const EXCLUSION_REASONS = ["duplicate", "near-duplicate", "coordination", "off-topic", "expired"] as const;

export const ClusterResultSchema = z
  .strictObject({
    valid: z.number().int(),
    excluded: z.array(
      z.strictObject({ reason: z.enum(EXCLUSION_REASONS), count: z.number().int(), detail: z.string().max(200).optional() }),
    ),
    themes: z.array(
      z.strictObject({
        id: z.string(),
        share: z.number(),
        count: z.number().int(),
        keywords: z.array(z.string()).max(10),
        quotes: z.array(z.strictObject({ itemId: z.string(), span: z.string().max(400), outlet: z.string().optional() })).max(5),
      }),
    ),
    other: z.strictObject({ share: z.number(), count: z.number().int() }),
  })
  .refine(
    (result) => result.themes.reduce((sum, theme) => sum + theme.count, 0) + result.other.count === result.valid,
    "themes + other = valid",
  );
export type ClusterResult = z.infer<typeof ClusterResultSchema>;

/** An item as clustering reads it. */
export interface ClusterItem {
  readonly itemId: string;
  /** What is clustered and quoted: the item's text, or its title when it has none. */
  readonly text: string;
  /** Its title, read with its text for whether it is on the topic, as the sources matched it. */
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly outlet?: string | undefined;
  readonly authorHash?: string | undefined;
  readonly publishedAt?: string | undefined;
}

export interface ClusterOptions {
  /** The topic's terms and exclusions: an item naming none of the terms, or an exclusion, is off-topic. */
  readonly terms?: readonly string[];
  readonly exclude?: readonly string[];
  /** The fewest items a theme holds: max(5, 2% of the valid items) unless given. */
  readonly minClusterSize?: number;
  readonly tau?: number;
}

const QUOTES_PER_THEME = 5;
const QUOTE_CHARS = 400;
/** MMR's balance: how much a quote should be like its theme, against unlike the quotes already chosen. */
const MMR_LAMBDA = 0.7;

/** A quote: the text from its start, whole characters only (never half an emoji), at most `QUOTE_CHARS` code units. */
function quoteOf(text: string): string {
  let span = "";
  for (const char of text) {
    if (span.length + char.length > QUOTE_CHARS) break;
    span += char;
  }
  return span;
}

/** Indexes joined into components: the first index of each is the one kept. */
function components(n: number, pairs: readonly (readonly [number, number])[]): number[] {
  const parent = Array.from({ length: n }, (_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    while (parent[index] !== root) {
      const next = parent[index] ?? root;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  for (const [a, b] of pairs) {
    const [low, high] = [find(a), find(b)].sort((x, y) => x - y) as [number, number];
    if (low !== high) parent[high] = low;
  }
  return Array.from({ length: n }, (_, index) => find(index));
}

export function clusterItems(input: readonly ClusterItem[], options: ClusterOptions = {}): ClusterResult {
  const items = input.slice(0, CLUSTER_ITEMS_MAX);
  const excluded = new Map<(typeof EXCLUSION_REASONS)[number], { count: number; detail?: string }>();
  const exclude = (reason: (typeof EXCLUSION_REASONS)[number], count: number, detail?: string): void => {
    if (count === 0) return;
    const known = excluded.get(reason);
    excluded.set(reason, {
      count: (known?.count ?? 0) + count,
      ...(detail === undefined ? (known?.detail === undefined ? {} : { detail: known.detail }) : { detail }),
    });
  };
  const textOf = (item: ClusterItem): string => item.text;
  let kept = items.map((_, index) => index);

  // Off the topic: its title and text name none of its terms, or an exclusion.
  if (options.terms !== undefined && options.terms.length > 0) {
    const on = kept.filter((index) =>
      about(`${items[index]?.title ?? ""} ${textOf(items[index] as ClusterItem)}`, options.terms ?? [], options.exclude ?? []),
    );
    exclude("off-topic", kept.length - on.length);
    kept = on;
  }

  // Coordinated bursts: the same text from five or more accounts within ten minutes.
  const groups = coordinatedGroups(
    kept.map((index) => ({
      index,
      text: textOf(items[index] as ClusterItem),
      authorHash: items[index]?.authorHash,
      at: items[index]?.publishedAt,
    })),
  );
  const coordinated = new Set(groups.flatMap((group) => group.members));
  if (coordinated.size > 0) {
    const largest = Math.max(...groups.map((group) => group.authors));
    exclude(
      "coordination",
      coordinated.size,
      `possible coordinated amplification (${String(largest)} accounts, identical text within 10 min)`,
    );
  }
  kept = kept.filter((index) => !coordinated.has(index));

  // Exact copies: the same link or the same text; the first is kept.
  const seen = new Set<string>();
  const unique: number[] = [];
  for (const index of kept) {
    const item = items[index] as ClusterItem;
    const keys = [`t:${foldText(textOf(item))}`, ...(item.url === undefined ? [] : [`u:${item.url}`])];
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    unique.push(index);
  }
  exclude("duplicate", kept.length - unique.length);
  kept = unique;

  // Near-copies: MinHash at Jaccard 0.8 for long texts, SimHash within 3 bits for short posts.
  const long = kept.filter((index) => tokensOf(textOf(items[index] as ClusterItem)).length >= SHORT_POST_TOKENS);
  const short = kept.filter((index) => tokensOf(textOf(items[index] as ClusterItem)).length < SHORT_POST_TOKENS);
  const positionOf = new Map(kept.map((index, position) => [index, position]));
  const at = (index: number | undefined): number => positionOf.get(index ?? -1) ?? 0;
  const pairs: [number, number][] = nearDuplicatePairs(
    long.map((index) => minhashOf(shinglesOf(textOf(items[index] as ClusterItem)))),
    NEAR_DUPLICATE_JACCARD,
  ).map(([a, b]) => [at(long[a]), at(long[b])]);
  const hashes = short.map((index) => simhashOf(textOf(items[index] as ClusterItem)));
  const none: readonly [number, number] = [0, 0];
  for (let i = 0; i < short.length; i += 1)
    for (let j = i + 1; j < short.length; j += 1)
      if (hammingDistance(hashes[i] ?? none, hashes[j] ?? none) <= SIMHASH_MAX_DISTANCE) pairs.push([at(short[i]), at(short[j])]);
  const roots = components(kept.length, pairs);
  const distinct = kept.filter((_, position) => roots[position] === position);
  exclude("near-duplicate", kept.length - distinct.length);
  kept = distinct;

  // Themes over what is left.
  const valid = kept.length;
  const texts = kept.map((index) => textOf(items[index] as ClusterItem));
  const stopwords = new Set((options.terms ?? []).flatMap((term) => tokensOf(term)));
  const vectors = tfidfVectors(texts, stopwords);
  const minSize = Math.max(1, options.minClusterSize ?? Math.max(5, Math.ceil(valid * 0.02)));
  const clusters = agglomerate(vectors, options.tau ?? CLUSTER_TAU)
    .filter((cluster) => cluster.length >= minSize)
    .sort((a, b) => b.length - a.length || (a[0] ?? 0) - (b[0] ?? 0));
  const keywords = clusterKeywords(texts, clusters, 10, stopwords);
  const share = (count: number): number => (valid === 0 ? 0 : Math.round((count / valid) * 10_000) / 10_000);
  const themes = clusters.map((cluster, rank) => {
    // Quotes: the theme's most typical item, then those most like the theme and least like the quotes already chosen, one an author.
    const centroid = new Map<string, number>();
    for (const position of cluster)
      for (const [token, weight] of vectors[position] ?? new Map<string, number>())
        centroid.set(token, (centroid.get(token) ?? 0) + weight / cluster.length);
    const chosen: number[] = [];
    const voices = new Set<string>();
    while (chosen.length < QUOTES_PER_THEME) {
      let best = -1;
      let score = Number.NEGATIVE_INFINITY;
      for (const position of cluster) {
        if (chosen.includes(position)) continue;
        const item = items[kept[position] ?? 0] as ClusterItem;
        if (item.authorHash !== undefined && voices.has(item.authorHash)) continue;
        const like = cosine(vectors[position] ?? new Map(), centroid);
        const redundancy = Math.max(0, ...chosen.map((other) => cosine(vectors[position] ?? new Map(), vectors[other] ?? new Map())));
        const value = MMR_LAMBDA * like - (1 - MMR_LAMBDA) * redundancy;
        if (value > score) {
          score = value;
          best = position;
        }
      }
      if (best === -1) break;
      chosen.push(best);
      const author = items[kept[best] ?? 0]?.authorHash;
      if (author !== undefined) voices.add(author);
    }
    return {
      id: `theme-${String(rank + 1)}`,
      share: share(cluster.length),
      count: cluster.length,
      keywords: keywords[rank] ?? [],
      // A quote is the item's own words, from its start: verbatim, as brief checks it.
      quotes: chosen.map((position) => {
        const item = items[kept[position] ?? 0] as ClusterItem;
        return { itemId: item.itemId, span: quoteOf(item.text), ...(item.outlet === undefined ? {} : { outlet: item.outlet }) };
      }),
    };
  });
  const inThemes = themes.reduce((sum, theme) => sum + theme.count, 0);
  return ClusterResultSchema.parse({
    valid,
    excluded: [...excluded].map(([reason, entry]) => ({
      reason,
      count: entry.count,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    })),
    themes,
    other: { share: share(valid - inThemes), count: valid - inThemes },
  });
}
