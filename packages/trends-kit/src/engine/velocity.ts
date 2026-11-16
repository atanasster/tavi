import { BUCKET_SECONDS, type Bucket, type CountQuality, type TopicAlert, type TopicState, type TrendsSourceKind } from "../contracts.js";
import { bucketStart } from "../store/store.js";
import { benjaminiHochberg, dispersion, mad, median, negativeBinomialUpperTail, normalUpperTail } from "./stats.js";

/**
 * The velocity engine: per source, a 24-hour count against
 * a seasonal baseline, tested for significance, floored, and cross-checked;
 * per sweep, Benjamini–Hochberg across every test; per topic, a state that
 * needs two independent families to be `confirmed`, with hysteresis and a
 * cooldown. Every number it uses is returned, so `velocity` can show it.
 */

export interface EngineParams {
  /** Smoothing of the displayed growth: 1 → 4 reads +50%, not +300%. */
  readonly alpha: number;
  /** Benjamini–Hochberg's false-discovery level per sweep. */
  readonly q: number;
  /** A baseline median at or above this uses the robust z, below it the negative binomial. */
  readonly robustZFrom: number;
  /** Hours before a topic that fell quiet may be raised again. */
  readonly cooldownHours: number;
  /** Sweeps in a row below one standard deviation before a raised topic falls quiet. */
  readonly quietSweepsToExit: number;
  /** The 24-hour count each family must reach before a test can pass. */
  readonly floors: Readonly<Record<TrendsSourceKind, number>>;
  /** For attention (pageviews): the count must also be this many times its 30-day median. */
  readonly attentionMultiple: number;
  /** For a search series (Naver's ratio): the 24 hours must be this many times the baseline. */
  readonly searchMultiple: number;
}

export const DEFAULT_PARAMS: EngineParams = {
  alpha: 5,
  q: 0.05,
  robustZFrom: 50,
  cooldownHours: 12,
  quietSweepsToExit: 2,
  // Community is HN, which counts stories, not authors: 5 a day is a lot for a niche topic there.
  floors: { news: 10, community: 5, social: 20, attention: 1_000, search: 1, markets: 1, research: 5, reference: Number.POSITIVE_INFINITY },
  attentionMultiple: 2,
  searchMultiple: 2,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The newest bucket a source has read must be this recent for a test to stand. */
const STALE_AFTER_MS = 3 * DAY_MS;
/** The fewest earlier 24-hour blocks a baseline is drawn from. */
const BASELINE_MIN_BLOCKS = 3;
/** Weeks a seasonal baseline looks back, and the fewest it needs. */
const SEASONAL_WEEKS = 8;
const SEASONAL_MIN_WEEKS = 4;

/** One bucket as the engine reads a series. */
export interface Observation {
  readonly start: string;
  readonly value: number;
  readonly quality: CountQuality;
}

/** What one source's test came to: every number behind it. */
export interface SourceTest {
  readonly sourceId: string;
  readonly kind: TrendsSourceKind;
  readonly metric: string;
  /** `presence`: on a trending list right now (Google Trends); `count`: a 24-hour count tested against its baseline. */
  readonly test: "count" | "presence" | "insufficient";
  /** Why a test could not stand: too little history, a stale source, too many missing hours. */
  readonly reason?: string;
  /** The 24 hours tested: [from, to). */
  readonly window?: { readonly from: string; readonly to: string };
  readonly x: number;
  readonly baseline: number;
  /** Where the baseline came from: the same hours of earlier weeks, or the previous days. */
  readonly baselineKind?: "seasonal" | "previous-days";
  /** The previous seven days' median, which growth is measured against. */
  readonly growthBaseline?: number;
  readonly k?: number;
  readonly p: number;
  readonly z: number;
  /** Smoothed growth over the previous days' median: 3.0 is +300%. */
  readonly g: number;
  readonly floorMet: boolean;
  readonly crossChecked: boolean;
  /** Filled in by the sweep's Benjamini–Hochberg. */
  readonly pBh?: boolean;
  readonly passed?: boolean;
}

/** The 24-hour block ending at `end`: its sum, and whether enough of it was seen. */
function blockAt(
  byStart: ReadonlyMap<string, Observation>,
  end: number,
  bucket: Bucket,
): { readonly sum: number; readonly seen: number; readonly expected: number } {
  const width = BUCKET_SECONDS[bucket] * 1_000;
  let sum = 0;
  let seen = 0;
  let expected = 0;
  for (let at = end - DAY_MS; at < end; at += width) {
    expected += 1;
    const observation = byStart.get(new Date(at).toISOString());
    if (observation === undefined || observation.quality === "missing") continue;
    seen += 1;
    sum += observation.value;
  }
  return { sum, seen, expected };
}

/** A block counts when at least three quarters of it was seen. */
const enough = (block: { readonly seen: number; readonly expected: number }): boolean =>
  block.expected > 0 && block.seen * 4 >= block.expected * 3;

/**
 * One source's 24-hour test. `observations` are its buckets
 * of one metric, hourly or daily; the block tested ends at the newest bucket
 * it has seen (a day behind for daily sources).
 */
export function testSource(input: {
  readonly sourceId: string;
  readonly kind: TrendsSourceKind;
  readonly metric: string;
  readonly bucket: Bucket;
  readonly observations: readonly Observation[];
  readonly now: string;
  readonly alert: TopicAlert;
  readonly params?: EngineParams;
}): SourceTest {
  const params = input.params ?? DEFAULT_PARAMS;
  const base = { sourceId: input.sourceId, kind: input.kind, metric: input.metric };
  const insufficient = (reason: string): SourceTest => ({
    ...base,
    test: "insufficient",
    reason,
    x: 0,
    baseline: 0,
    p: 1,
    z: 0,
    g: 0,
    floorMet: false,
    crossChecked: false,
  });
  const byStart = new Map(input.observations.map((observation) => [bucketStart(observation.start, input.bucket), observation]));
  const width = BUCKET_SECONDS[input.bucket] * 1_000;
  const newest = [...byStart]
    .filter(([, observation]) => observation.quality !== "missing")
    .reduce((max, [start]) => Math.max(max, Date.parse(start)), Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(newest)) return insufficient("nothing read yet");
  const end = newest + width;
  if (Date.parse(input.now) - end > STALE_AFTER_MS) return insufficient("the source has read nothing for over three days");

  // An hourly search source is a trending list (Google's); a daily one (Naver) is counted.
  if (input.kind === "search" && input.bucket === "hour") {
    // Google's trending list is itself a surge test: on it in the newest bucket read, within the last two hours, or not.
    // It carries no p-value or growth of its own (0 for both) and takes no part in Benjamini–Hochberg.
    const latest = byStart.get(new Date(newest).toISOString());
    const recent = Date.parse(input.now) - end <= 2 * HOUR_MS;
    const present = recent ? (latest?.value ?? 0) : 0;
    const floorMet = present >= params.floors.search;
    return {
      ...base,
      test: "presence",
      window: { from: new Date(newest).toISOString(), to: new Date(end).toISOString() },
      x: present,
      baseline: 0,
      p: 1,
      z: 0,
      g: 0,
      floorMet,
      crossChecked: true,
    };
  }

  const current = blockAt(byStart, end, input.bucket);
  if (!enough(current)) return insufficient("too much of the last 24 hours is missing");
  // Earlier blocks: the previous days, and the same 24 hours of earlier weeks.
  const previousDays = [1, 2, 3, 4, 5, 6, 7]
    .map((days) => blockAt(byStart, end - days * DAY_MS, input.bucket))
    .filter(enough)
    .map((block) => block.sum);
  const weekEnds = Array.from({ length: SEASONAL_WEEKS }, (_, index) => end - (index + 1) * 7 * DAY_MS).filter((weekEnd) =>
    enough(blockAt(byStart, weekEnd, input.bucket)),
  );
  const weeks = weekEnds.map((weekEnd) => blockAt(byStart, weekEnd, input.bucket).sum);
  /** The seven days before a block, summed, when all seven were read: a week's level. */
  const levelBefore = (blockEnd: number): number | undefined => {
    const days = [1, 2, 3, 4, 5, 6, 7].map((days) => blockAt(byStart, blockEnd - days * DAY_MS, input.bucket));
    return days.every(enough) ? days.reduce((sum, block) => sum + block.sum, 0) : undefined;
  };
  if (previousDays.length < BASELINE_MIN_BLOCKS)
    return insufficient(`a baseline needs ${String(BASELINE_MIN_BLOCKS)} earlier days; ${String(previousDays.length)} were read`);
  let baseline = median(previousDays);
  let sample = previousDays;
  let baselineKind: "seasonal" | "previous-days" = "previous-days";
  if (weeks.length >= SEASONAL_MIN_WEEKS) {
    // The same weekday's 24 hours in earlier weeks, scaled by how the last seven days ran against the seven before each of them.
    const now = levelBefore(end);
    const before = weekEnds.flatMap((weekEnd) => levelBefore(weekEnd) ?? []);
    const level = now === undefined || before.length === 0 || median(before) <= 0 ? 1 : now / median(before);
    baseline = median(weeks) * Math.min(2, Math.max(0.5, level));
    sample = weeks;
    baselineKind = "seasonal";
  }
  const x = current.sum;
  // Growth is over the previous days' median, whichever baseline the test used.
  const growthBaseline = median(previousDays);
  const g = (x + params.alpha) / (growthBaseline + params.alpha) - 1;
  let p: number;
  let z: number;
  let k: number | undefined;
  if (median(sample) >= params.robustZFrom) {
    const scale = Math.max(1.4826 * mad(sample), Math.sqrt(Math.max(baseline, 1)), 1);
    z = (x - baseline) / scale;
    p = normalUpperTail(z);
  } else {
    k = dispersion(sample);
    // One mean for both, never 0: a quiet baseline still has a spread.
    const mean = Math.max(baseline, 0.5);
    const sd = Math.sqrt(mean + (Number.isFinite(k) ? (mean * mean) / k : 0));
    z = (x - mean) / sd;
    p = negativeBinomialUpperTail(Math.round(x), mean, k);
  }
  const month = Array.from({ length: 30 }, (_, index) => blockAt(byStart, end - (index + 1) * DAY_MS, input.bucket))
    .filter(enough)
    .map((block) => block.sum);
  // Pageviews must also be a multiple of their 30-day median; a search ratio (Naver) a multiple of its baseline.
  const floorMet =
    x >= params.floors[input.kind] &&
    (input.kind !== "attention" || x >= params.attentionMultiple * Math.max(1, median(month))) &&
    (input.kind !== "search" || x >= params.searchMultiple * baseline);
  // It must also beat the same hours yesterday and last week, where they were read.
  const yesterday = blockAt(byStart, end - DAY_MS, input.bucket);
  const lastWeek = blockAt(byStart, end - 7 * DAY_MS, input.bucket);
  const crossChecked = (!enough(yesterday) || x > yesterday.sum) && (!enough(lastWeek) || x > lastWeek.sum);
  return {
    ...base,
    test: "count",
    window: { from: new Date(end - DAY_MS).toISOString(), to: new Date(end).toISOString() },
    x,
    baseline,
    growthBaseline,
    baselineKind,
    ...(k === undefined || !Number.isFinite(k) ? {} : { k }),
    p,
    z,
    g,
    floorMet,
    crossChecked,
  };
}

/**
 * The sweep's tests after Benjamini–Hochberg: a count test
 * passes when it is a discovery, meets its floor, and beats yesterday and
 * last week. A presence test passes when present; it takes no part in the
 * correction. The topic's growth rule is the topic's, in `nextState`.
 */
export function judgeSweep(tests: readonly SourceTest[], params: EngineParams = DEFAULT_PARAMS): SourceTest[] {
  const counted = tests.flatMap((test, index) => (test.test === "count" ? [index] : []));
  const discoveries = benjaminiHochberg(
    counted.map((index) => tests[index]?.p ?? 1),
    params.q,
  );
  const discovered = new Set(counted.filter((_, rank) => discoveries[rank] === true));
  return tests.map((test, index) => {
    if (test.test === "insufficient") return { ...test, passed: false };
    if (test.test === "presence") return { ...test, passed: test.floorMet };
    const pBh = discovered.has(index);
    return { ...test, pBh, passed: pBh && test.floorMet && test.crossChecked };
  });
}

/** A topic's state across sweeps. */
export interface TopicStateMemory {
  readonly state: TopicState;
  /** Sweeps in a row whose every test was below one standard deviation. */
  readonly quietSweeps: number;
  /** When the topic last fell quiet: it is not raised again within the cooldown. */
  readonly quietSince?: string;
}

/**
 * The topic's next state: raised only when its rule holds, a
 * passing count test growing past `growth` (or a presence on Google's list);
 * then `confirmed` with two or more families passing, `signal` with one. A raised topic falls quiet only after
 * `quietSweepsToExit` sweeps in a row below one standard deviation (a sweep
 * with no count test is no evidence of calm), and is not raised again within
 * the cooldown of falling quiet. A raised topic stays raised: a confirmed one
 * with one family left is still confirmed until it falls quiet.
 */
export function nextState(
  previous: TopicStateMemory,
  tests: readonly SourceTest[],
  now: string,
  growth: number,
  params: EngineParams = DEFAULT_PARAMS,
): TopicStateMemory {
  const passing = tests.filter((test) => test.passed === true && test.kind !== "reference");
  const kinds = new Set(passing.map((test) => test.kind));
  const ruleHolds = passing.some((test) => test.test === "presence" || test.g > growth);
  const raised: TopicState = !ruleHolds ? "quiet" : kinds.size >= 2 ? "confirmed" : "signal";
  const counts = tests.filter((test) => test.test === "count");
  const calm = counts.length > 0 && counts.every((test) => test.z < 1);
  const since = previous.quietSince === undefined ? {} : { quietSince: previous.quietSince };
  if (previous.state === "quiet") {
    const cooling = previous.quietSince !== undefined && Date.parse(now) - Date.parse(previous.quietSince) < params.cooldownHours * HOUR_MS;
    return raised === "quiet" || cooling ? { state: "quiet", quietSweeps: 0, ...since } : { state: raised, quietSweeps: 0, ...since };
  }
  if (raised !== "quiet")
    return { state: raised === "confirmed" || previous.state === "signal" ? raised : previous.state, quietSweeps: 0, ...since };
  const quietSweeps = calm ? previous.quietSweeps + 1 : 0;
  if (quietSweeps >= params.quietSweepsToExit) return { state: "quiet", quietSweeps: 0, quietSince: now };
  return { ...previous, quietSweeps };
}
