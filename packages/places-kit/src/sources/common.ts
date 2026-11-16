import { retryAfterMs } from "@tavi/domain-kit";

import type { Failure, SourceResponse } from "./types.js";

/** The outcome of an answer that is not a 200, or `undefined` for a 200 the adapter reads. */
export function statusOutcome(response: SourceResponse, now: string): Failure | undefined {
  if (response.status === 200) return undefined;
  if (response.status === 404 || response.status === 410) return { kind: "not-found" };
  // Overpass answers 429, or 504 when its servers are full: both mean wait.
  if (response.status === 429 || response.status === 504)
    return { kind: "rate-limited", retryAfterMs: retryAfterMs(response.retryAfter, now) };
  if (response.status === 401 || response.status === 403) return { kind: "unauthorized" };
  return { kind: "failed", status: response.status };
}

/** Whether an answer of `total` records with `dropped` unreadable is the source changing shape: more than half of a non-empty answer. */
export function drifted(dropped: number, total: number): boolean {
  return total > 0 && dropped * 2 > total;
}

/** A date OSM-style (`2026-09-30`, or a full time) as an ISO time, or `undefined`. */
export function isoOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00Z` : value.trim();
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The longest one word may be once made safe. */
const SAFE_WORD_MAX = 40;

/**
 * Words safe inside an Overpass regex or a query string: letters, digits and
 * spaces only, so nothing a model wrote can change the query's shape.
 */
export function safeWords(words: readonly string[]): string[] {
  return words
    .map((word) =>
      word
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .slice(0, SAFE_WORD_MAX),
    )
    .filter((word) => word.length >= 2)
    .slice(0, 6);
}
