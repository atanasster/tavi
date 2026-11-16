import { ROUTINE_CORPUS_VERSION, loadRoutineCorpus, routineCorpusHash, type RoutineCorpusItem } from "./corpus.js";
import { samePublisher } from "../publisher-registry.js";

/**
 * Near-duplicate detection and its *measured* threshold.
 *
 * Two questions are separate and were previously one heuristic: *did the same
 * material appear twice?* (pairwise text similarity, measured below) and *is the
 * second appearance an independent source?* (the publisher registry's job). The
 * threshold below is chosen by sweeping it over the labelled corpus rather than
 * picked by taste, and the sweep is recorded beside the constant so a reader can
 * see the tradeoff that was accepted.
 */

/**
 * Sentence-level containment coefficient of two page bodies, in `[0, 1]`.
 *
 * `|A∩B| / min(|A|, |B|)`, which is the share of the *shorter* body's sentences
 * that also appear in the longer one. It is deliberately not Jaccard
 * (`|A∩B| / |A∪B|`): a syndicated copy that keeps every sentence of the original
 * and adds its own framing should measure as the same material, which Jaccard
 * would penalise for the added sentences. The coefficient is therefore always at
 * least Jaccard, and the method recorded beside the measured threshold says
 * "containment" so a reader re-deriving the number uses the same formula.
 */
export function sentenceOverlap(a: string, b: string): number {
  const sentences = (text: string): Set<string> =>
    new Set(
      text
        .split(/(?:\n+|(?<=[.!?])\s+)/)
        .map((sentence) => sentence.replace(/\s+/g, " ").trim().toLowerCase())
        .filter((sentence) => sentence.length > 0),
    );
  const left = sentences(a);
  const right = sentences(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const sentence of left) if (right.has(sentence)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/** A `[a, b]` source-id pair the corpus labels as the same material. */
export type DuplicatePair = readonly [string, string];

export interface ThresholdSweepRow {
  readonly threshold: number;
  readonly precision: number;
  readonly recall: number;
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
}
export interface ThresholdSweep {
  readonly chosen: number;
  readonly method: string;
  readonly corpusVersion: number;
  readonly corpusHash: string;
  readonly rule: string;
  readonly rows: readonly ThresholdSweepRow[];
}

/** Every unordered pair of sources inside one item, with the label the corpus gives it. */
function pairs(items: readonly RoutineCorpusItem[]): { a: string; b: string; same: boolean; overlap: number }[] {
  const out: { a: string; b: string; same: boolean; overlap: number }[] = [];
  for (const item of items) {
    const labelled = new Set((item.duplicatePairs ?? []).map((pair) => [...pair].sort().join("|")));
    for (let i = 0; i < item.sources.length; i += 1)
      for (let j = i + 1; j < item.sources.length; j += 1) {
        const a = item.sources[i]!;
        const b = item.sources[j]!;
        out.push({
          a: a.sourceId,
          b: b.sourceId,
          same: labelled.has([a.sourceId, b.sourceId].sort().join("|")),
          overlap: sentenceOverlap(a.text, b.text),
        });
      }
  }
  return out;
}

/** The rule the chosen threshold satisfies; stated so the sweep is reproducible. */
export const CLUSTERING_ACCEPTANCE_RULE = "the lowest threshold whose precision is at least 0.95 and whose recall is at least 0.80";
const CANDIDATES: readonly number[] = [0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

/**
 * Sweep the near-duplicate threshold over the labelled corpus.
 *
 * Pairwise and offline: no provider, no network. `precision` is the share of pairs
 * the threshold calls duplicates that the labels agree with, and `recall` the
 * share of labelled duplicates it finds.
 */
export function sweepClusteringThreshold(items: readonly RoutineCorpusItem[], candidates: readonly number[] = CANDIDATES): ThresholdSweep {
  const corpus = pairs(items);
  const rows = candidates.map((threshold) => {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const pair of corpus) {
      const predicted = pair.overlap >= threshold;
      if (predicted && pair.same) truePositive += 1;
      else if (predicted && !pair.same) falsePositive += 1;
      else if (!predicted && pair.same) falseNegative += 1;
    }
    return {
      threshold,
      truePositive,
      falsePositive,
      falseNegative,
      precision: truePositive + falsePositive === 0 ? 1 : truePositive / (truePositive + falsePositive),
      recall: truePositive + falseNegative === 0 ? 1 : truePositive / (truePositive + falseNegative),
    };
  });
  const chosen = rows.find((row) => row.precision >= 0.95 && row.recall >= 0.8)?.threshold ?? 0.7;
  return {
    chosen,
    method: "sentence-containment",
    corpusVersion: ROUTINE_CORPUS_VERSION,
    corpusHash: routineCorpusHash(items),
    rule: CLUSTERING_ACCEPTANCE_RULE,
    rows,
  };
}

/**
 * The threshold in use, with the measurement that chose it.
 *
 * `chosen` is generated by `sweepClusteringThreshold` over the frozen corpus and
 * asserted equal to this constant by the suite, so the number in the code cannot
 * drift from the number that was measured.
 */
export const ROUTINE_CLUSTERING: {
  readonly threshold: number;
  readonly method: string;
  readonly rule: string;
  readonly corpusVersion: number;
} = Object.freeze({
  threshold: sweepClusteringThreshold(loadRoutineCorpus()).chosen,
  method: "sentence-containment",
  rule: CLUSTERING_ACCEPTANCE_RULE,
  corpusVersion: ROUTINE_CORPUS_VERSION,
});

/** The publication-order bar: below the duplicate bar, so the two never overlap. */
export const PUBLISHED_AFTER_OVERLAP_RATIO = 0.5;

export interface SyndicationVerdict {
  readonly syndicated: boolean;
  /** Why, in the operator's terms; `undefined` when the pair is not a duplicate. */
  readonly reason?: "same-publisher" | "near-duplicate-text" | "published-after";
}

/**
 * Whether one source is a non-independent appearance of another.
 *
 * Three signals, any of which is enough and each of which says something the
 * others do not: the same organisation published both, the text is the same
 * material, or one appeared materially *after* the other and repeats it — which is
 * what a syndicated copy looks like when a publisher rewrites a headline.
 */
export function syndicationVerdict(
  first: { publisher: string; excerpt: string; publishedAt: string | null; retrievedAt: string },
  second: { publisher: string; excerpt: string; publishedAt: string | null; retrievedAt: string },
  threshold = ROUTINE_CLUSTERING.threshold,
): SyndicationVerdict {
  if (samePublisher(first.publisher, second.publisher)) return { syndicated: true, reason: "same-publisher" };
  if (sentenceOverlap(first.excerpt, second.excerpt) >= threshold) return { syndicated: true, reason: "near-duplicate-text" };
  const a = Date.parse(first.publishedAt ?? "");
  const b = Date.parse(second.publishedAt ?? "");
  const partial = sentenceOverlap(first.excerpt, second.excerpt);
  if (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) > 0 &&
    Math.abs(a - b) <= 6 * 3_600_000 &&
    partial >= threshold * PUBLISHED_AFTER_OVERLAP_RATIO
  ) {
    return { syndicated: true, reason: "published-after" };
  }
  return { syndicated: false };
}

/**
 * A material change inside one story's identity.
 *
 * A version or a date appearing in the *claims* while the identity stays the same
 * is a new story, not a duplicate: "Model X 2" that now ships with a different
 * context window is news even at the same URL and title. An `llm-releases-v1`
 * story also counts the LLM benchmarks its claims name (`llmBenchmarks`); any
 * other story records none. The caller folds this into the dedup key, which is
 * what makes it visible.
 */
export function materialChangeFingerprint(claims: readonly { text: string }[], llmBenchmarks = false): string {
  const text = claims
    .map((claim) => claim.text)
    .join(" ")
    .toLowerCase();
  // `version 2`, `2.1` and `2.1.3` are all versions; a bare integer only counts
  // when the page calls it one, so a random "2" elsewhere is not a material change.
  const versions = [...text.matchAll(/\bversion\s+(\d+(?:\.\d+)*)\b|\b(\d+\.\d+(?:\.\d+)*)\b/g)]
    .map((match) => match[1] ?? match[2]!)
    .sort();
  const dates = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((match) => match[1]).sort();
  const benchmarks = llmBenchmarks
    ? [...text.matchAll(/\b(mmlu|gsm8k|humaneval|swe-?bench|arc|hellaswag|math|gpqa)\b/g)].map((match) => match[1]).sort()
    : [];
  return JSON.stringify({
    versions: [...new Set(versions)],
    dates: [...new Set(dates)],
    benchmarks: [...new Set(benchmarks)],
    length: text.replace(/\s+/g, " ").trim().length,
  });
}
