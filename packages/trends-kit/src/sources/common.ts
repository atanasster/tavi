import { htmlToText } from "@tavi/contracts";
import { isRecord } from "@tavi/contracts/util";
import { retryAfterMs as boundedRetryAfterMs } from "@tavi/domain-kit";

import { BUCKET_SECONDS, type Bucket, type CountPoint, type CountQuality, type RawItem } from "../contracts.js";
import { bucketStart } from "../store/store.js";
import type { CountSeries, ReadOutcome, SourceResponse, Window } from "./types.js";

/** `Retry-After` as milliseconds, as long as the source asks and no less than none: seconds or an HTTP date; a minute when absent or unreadable. */
export const retryAfterMs = (header: string | null | undefined, now: string): number =>
  boundedRetryAfterMs(header, now, { minMs: 0, maxMs: Number.POSITIVE_INFINITY });

/**
 * An answer that is not a 200, as an outcome: a 429 waits; 401 is the key;
 * 402 and 403 are the site saying no (a block, never retried around); a 404
 * or 5xx is the network. `undefined` for a 200, which the adapter reads.
 */
export function failureOf(response: SourceResponse, now: string): ReadOutcome<never> | undefined {
  if (response.status === 200) return undefined;
  if (response.status === 429) return { kind: "rate-limited", retryAfterMs: retryAfterMs(response.retryAfter, now) };
  if (response.status === 401) return { kind: "failed", class: "auth", status: 401 };
  if (response.status === 402 || response.status === 403 || response.status === 451)
    return { kind: "failed", class: "blocked", status: response.status };
  return { kind: "failed", class: "network", status: response.status };
}

/** An answer whose shape the adapter does not read: the source changed (drift). */
export const drift = (detail: string): ReadOutcome<never> => ({ kind: "failed", class: "schema", status: 200, detail });

/** A plain object, or `undefined`. */
export const objectOf = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);
export const stringOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);
export const numberOf = (value: unknown): number | undefined => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
};

/** A time in any form a source writes (ISO, RFC 822, GDELT's `20261015T100000Z`, Unix seconds) as ISO UTC. */
export function isoOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1_000).toISOString();
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim());
  const ms =
    compact === null
      ? Date.parse(value)
      : Date.UTC(
          Number(compact[1]),
          Number(compact[2]) - 1,
          Number(compact[3]),
          Number(compact[4]),
          Number(compact[5]),
          Number(compact[6]),
        );
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** HTML or entity-laden text as plain text, hidden elements dropped. */
export const plainText = (html: string): string => htmlToText(html, { dropHidden: true }).replace(/\s+/g, " ").trim();

/** Whether `text` mentions one of `terms`, case- and accent-insensitive; on word boundaries where the script has them. */
export function mentions(text: string, terms: readonly string[]): boolean {
  const haystack = fold(text);
  return terms.some((term) => {
    const needle = fold(term);
    if (needle === "") return false;
    // Scripts without spaces between words (CJK, Thai) match anywhere.
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(needle))
      return haystack.includes(needle);
    // A plural matches its singular term: battery, batteries; chip, chips; bus, buses.
    return variants(needle).some((variant) => onBoundaries(haystack, variant));
  });
}
const variants = (needle: string): string[] => [
  needle,
  `${needle}s`,
  `${needle}es`,
  ...(needle.endsWith("y") ? [`${needle.slice(0, -1)}ies`] : []),
];
function onBoundaries(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + needle.length])) return true;
    from = at + 1;
  }
}
const fold = (text: string): string => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ");
const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** Whether a source's own search result should be dropped: it mentions an exclusion. Its match itself is the source's (it stems, Tavi does not). */
export const excluded = (text: string, exclude: readonly string[]): boolean => exclude.length > 0 && mentions(text, exclude);

/** Whether an item is about the topic: it mentions a term and none of the exclusions. */
export const about = (text: string, terms: readonly string[], exclude: readonly string[]): boolean =>
  mentions(text, terms) && !mentions(text, exclude);

/** Every bucket start of a window, oldest first. */
export function bucketsOf(window: Window): string[] {
  const width = BUCKET_SECONDS[window.bucket] * 1_000;
  const starts: string[] = [];
  for (let ms = Date.parse(bucketStart(window.from, window.bucket)); ms < Date.parse(window.to); ms += width)
    starts.push(new Date(ms).toISOString());
  return starts;
}

/**
 * Times counted into the window's buckets. A bucket the read could not have
 * covered (before `coveredFrom`) is `missing`, never zero; `quality` marks the
 * rest (a capped read is `partial`).
 */
export function countInto(window: Window, times: readonly string[], quality: CountQuality, coveredFrom?: string): CountPoint[] {
  const counts = new Map(bucketsOf(window).map((start) => [start, 0]));
  for (const time of times) {
    const start = bucketStart(time, window.bucket);
    const count = counts.get(start);
    if (count !== undefined) counts.set(start, count + 1);
  }
  const covered = coveredFrom === undefined ? undefined : bucketStart(coveredFrom, window.bucket);
  return [...counts].map(([start, value]) =>
    covered !== undefined && start < covered ? { start, value: 0, quality: "missing" } : { start, value, quality },
  );
}

/** Points of a finer step summed into `bucket` (GDELT's quarter-hours into hours); a bucket with a missing or absent step is partial. */
export function rebucket(points: readonly CountPoint[], bucket: Bucket): CountPoint[] {
  // The input's step (GDELT's 15 minutes or an hour): a bucket holding fewer steps than fit in it is partial.
  const times = [...new Set(points.map((point) => Date.parse(point.start)))].sort((a, b) => a - b);
  const step = times.slice(1).reduce((min, time, index) => Math.min(min, time - (times[index] ?? time)), Number.POSITIVE_INFINITY);
  const steps = Number.isFinite(step) && step > 0 ? Math.max(1, Math.round((BUCKET_SECONDS[bucket] * 1_000) / step)) : 1;
  const sums = new Map<string, { value: number; norm: number | undefined; quality: CountQuality; hours: number }>();
  for (const point of points) {
    const start = bucketStart(point.start, bucket);
    const sum = sums.get(start) ?? { value: 0, norm: 0, quality: "ok" as CountQuality, hours: 0 };
    sum.value += point.quality === "missing" ? 0 : point.value;
    sum.norm = sum.norm === undefined || point.norm === undefined ? undefined : sum.norm + point.norm;
    if (point.quality !== "ok") sum.quality = "partial";
    sum.hours += 1;
    sums.set(start, sum);
  }
  return [...sums].map(([start, sum]) => ({
    start,
    value: sum.value,
    quality: sum.hours < steps ? "partial" : sum.quality,
    ...(sum.norm === undefined ? {} : { norm: sum.norm }),
  }));
}

/** A query string from parameters, each encoded. */
export const query = (parameters: Readonly<Record<string, string | number | undefined>>): string =>
  Object.entries(parameters)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");

/**
 * One series from several answers (a group's feeds, a topic's articles):
 * each bucket's values summed over the answers that saw it. A bucket none saw
 * stays missing; one some saw is partial; one any answer only estimated is
 * approximate.
 */
export function mergeSeries(parts: readonly (readonly CountPoint[])[]): CountPoint[] {
  const merged = new Map<
    string,
    { value: number; norm: number | undefined; seen: number; missing: number; approximate: boolean; partial: boolean }
  >();
  for (const points of parts) {
    for (const point of points) {
      const entry = merged.get(point.start) ?? { value: 0, norm: 0, seen: 0, missing: 0, approximate: false, partial: false };
      if (point.quality === "missing") entry.missing += 1;
      else {
        entry.seen += 1;
        entry.value += point.value;
        entry.norm = entry.norm === undefined || point.norm === undefined ? undefined : entry.norm + point.norm;
        if (point.quality === "approximate") entry.approximate = true;
        if (point.quality === "partial") entry.partial = true;
      }
      merged.set(point.start, entry);
    }
  }
  return [...merged]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([start, entry]): CountPoint => {
      if (entry.seen === 0) return { start, value: 0, quality: "missing" };
      const quality: CountQuality = entry.partial || entry.missing > 0 ? "partial" : entry.approximate ? "approximate" : "ok";
      return { start, value: entry.value, quality, ...(entry.norm === undefined ? {} : { norm: entry.norm }) };
    });
}

/** Posts and distinct authors a bucket, from one page of a search, newest first; past the page's oldest post, missing. */
export function postPageCounts(posts: readonly RawItem[], window: Window, capped: boolean): CountSeries[] {
  const times = posts.flatMap((post) => post.publishedAt ?? []);
  const oldest = capped
    ? times.reduce<string | undefined>((min, time) => (min === undefined || time < min ? time : min), undefined)
    : undefined;
  // A bucket the page reached into only partly is partial too: its oldest posts may be past the page.
  const quality = capped ? "partial" : "ok";
  const authors = new Map<string, Set<string>>();
  for (const post of posts) {
    if (post.publishedAt === undefined || post.author === undefined) continue;
    const start = bucketStart(post.publishedAt, window.bucket);
    authors.set(start, (authors.get(start) ?? new Set()).add(post.author));
  }
  const postPoints = countInto(window, times, quality, oldest);
  const authorPoints: CountPoint[] = postPoints.map((point) => ({
    ...point,
    value: point.quality === "missing" ? 0 : (authors.get(point.start)?.size ?? 0),
  }));
  return [
    { metric: "posts", points: postPoints },
    { metric: "authors", points: authorPoints },
  ];
}
