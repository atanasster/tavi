/**
 * The known-URL rule: a URL
 * the model asks to open is "known" only when it exactly matches, after one
 * fixed normalization, a URL already present in the conversation — a person
 * message, a tool result, a page's listed link, a redirect hop. A URL the model
 * composed or extended (an extra path segment, an extra or reordered query
 * parameter) never matches, because that is how text a page planted would carry
 * the conversation's material to a host of the page's choosing.
 *
 * The fragment is dropped, which suits a fetch (a fragment is never sent). A
 * caller that navigates a browser must compare or strip the fragment itself:
 * page script can read a model-appended `#…`.
 *
 * Pure: no I/O, no clock. Shared by the taint step and a routine's open-web
 * `web_fetch` (`packages/runtime/src/routines/grants.ts`).
 */
import { z } from "zod";

import { fragmentOf, KNOWN_URL_LIMITS, navigationKeyOf, normalizeUrl, trimTrailing, URL_IN_TEXT } from "./url-text.js";

export { disarmUrls, isKnownNavigation, KNOWN_URL_LIMITS, navigationKeyOf, normalizeUrl, trimTrailing } from "./url-text.js";

/** The `knownUrls` channel's stored value: normalized URLs, oldest first, each once. */
export const KnownUrlsSchema = z.array(z.string().min(1).max(KNOWN_URL_LIMITS.maxUrlLength)).max(KNOWN_URL_LIMITS.maxUrls);
export type KnownUrls = readonly string[];

/**
 * The http(s) URLs in a text — a person message, a tool result, a page's text
 * as `htmlToText` writes it (`words (https://…)`), a Markdown link — in their
 * normal form, each once, in order of first appearance. Unparseable or
 * over-long candidates are left out.
 */
export function extractUrls(text: string): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const normalized = normalizeUrl(trimTrailing(match[0]));
    if (normalized === undefined || seen.has(normalized)) continue;
    seen.add(normalized);
    found.push(normalized);
  }
  return found;
}

/**
 * Adds URLs to the bounded known set: each is normalized (one that does not
 * normalize is dropped), moved to the newest end if already present, and only
 * the newest 2,000 are kept. Usable as a channel reducer: deterministic,
 * idempotent (`merge(merge(a, b), b)` equals `merge(a, b)`) and associative.
 */
export function mergeKnownUrls(current: KnownUrls, next: readonly string[]): KnownUrls {
  const incoming: string[] = [];
  const incomingSet = new Set<string>();
  for (const raw of next) {
    const normalized = normalizeUrl(raw);
    if (normalized === undefined) continue;
    // A repeat inside `next` counts at its last position, the newest.
    if (incomingSet.has(normalized)) incoming.splice(incoming.indexOf(normalized), 1);
    incomingSet.add(normalized);
    incoming.push(normalized);
  }
  if (incoming.length === 0 && current.length <= KNOWN_URL_LIMITS.maxUrls) return current;
  const kept = current.filter((url) => !incomingSet.has(url));
  const merged = [...kept, ...incoming];
  return merged.length > KNOWN_URL_LIMITS.maxUrls ? merged.slice(merged.length - KNOWN_URL_LIMITS.maxUrls) : merged;
}

/** A lookup set of the normalized forms of `urls`; ones that do not normalize are left out. */
export function knownUrlSet(urls: Iterable<string>): ReadonlySet<string> {
  const set = new Set<string>();
  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (normalized !== undefined) set.add(normalized);
  }
  return set;
}

/**
 * Whether `url` is known: its normal form is exactly one in `known`, a set of
 * normal forms (`knownUrlSet`, `extractUrls`, `mergeKnownUrls`). Never a prefix,
 * host or pattern match; an unparseable or over-long URL is never known.
 */
export function isKnownUrl(url: string, known: ReadonlySet<string>): boolean {
  const normalized = normalizeUrl(url);
  return normalized !== undefined && known.has(normalized);
}

/**
 * The navigation keys (`navigationKeyOf`) of the URLs in a text that carry a
 * fragment, each once: added to a known set beside `extractUrls`, so a link
 * with a fragment the conversation holds is known to a navigation too.
 */
export function extractFragmentUrls(text: string): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const candidate = trimTrailing(match[0]);
    if (fragmentOf(candidate) === undefined) continue;
    const key = navigationKeyOf(candidate);
    if (key === undefined || key.length > KNOWN_URL_LIMITS.maxUrlLength || seen.has(key)) continue;
    seen.add(key);
    found.push(key);
  }
  return found;
}

/**
 * The keys a text's URLs are known by: each one's normal form, and the
 * navigation key (`navigationKeyOf`) of each one written with a fragment.
 */
export function urlKeysIn(text: string): readonly string[] {
  return [...extractUrls(text), ...extractFragmentUrls(text)];
}

/**
 * `mergeKnownUrls` for URL keys: a normal form, or a navigation key with its
 * fragment (`navigationKeyOf`), which is kept, so an approved navigation to a
 * page's `#section` is known as such next time. Same bounds and order.
 */
export function mergeUrlKeys(current: KnownUrls, next: readonly string[]): KnownUrls {
  const incoming: string[] = [];
  const incomingSet = new Set<string>();
  for (const raw of next) {
    const key = navigationKeyOf(raw);
    if (key === undefined || key.length > KNOWN_URL_LIMITS.maxUrlLength) continue;
    if (incomingSet.has(key)) incoming.splice(incoming.indexOf(key), 1);
    incomingSet.add(key);
    incoming.push(key);
  }
  if (incoming.length === 0 && current.length <= KNOWN_URL_LIMITS.maxUrls) return current;
  const merged = [...current.filter((key) => !incomingSet.has(key)), ...incoming];
  return merged.length > KNOWN_URL_LIMITS.maxUrls ? merged.slice(merged.length - KNOWN_URL_LIMITS.maxUrls) : merged;
}

/**
 * Bounds of the known URLs a tainted turn's events and saved turn carry for
 * the canvas, which disarms a link in the turn's answer that is none of them
 * (`isKnownNavigation`, the rule `disarmUrls` applies on channels).
 * Newest kept; a URL left out only makes its link ask before it opens.
 */
export const TURN_KNOWN_URLS_LIMITS = {
  maxUrls: 256,
  /** Their characters together, so an event carrying them stays well inside an IPC frame. */
  maxChars: 64 * 1024,
} as const;

/** A tainted turn's known URLs, as its events and saved turn carry them (`boundTurnKnownUrls`). */
export const TurnKnownUrlsSchema = z.array(z.string().min(1).max(KNOWN_URL_LIMITS.maxUrlLength)).max(TURN_KNOWN_URLS_LIMITS.maxUrls);

/**
 * The newest of a `knownUrls` channel's keys — normal forms, and navigation
 * keys with their fragment (`navigationKeyOf`) — oldest first, within
 * `TURN_KNOWN_URLS_LIMITS`.
 */
export function boundTurnKnownUrls(keys: readonly string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (let index = keys.length - 1; index >= 0 && kept.length < TURN_KNOWN_URLS_LIMITS.maxUrls; index -= 1) {
    const key = keys[index];
    if (typeof key !== "string" || seen.has(key) || navigationKeyOf(key) !== key) continue;
    if (chars + key.length > TURN_KNOWN_URLS_LIMITS.maxChars) break;
    seen.add(key);
    chars += key.length;
    kept.push(key);
  }
  return kept.reverse();
}
