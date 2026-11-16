/**
 * The parts of the known-URL rules that read text
 * and need no schema: an http(s) URL's normal form, a navigation's key, and
 * the boundary a URL is cut from running text by. Zod-free, so a channel
 * plugin's bundle can carry the channel kit's link disarming without the
 * contracts barrel;
 * `known-url.ts` builds the rest on it.
 */

/** Tavi's public repository: where a request that names its client (a User-Agent) points. */
export const TAVI_REPOSITORY_URL = "https://github.com/atanasster/tavi";

// Contracts compile without the DOM or Node libraries; `URL` is a global in
// every runtime this package runs in (Node, browsers), so only its type is
// declared here.
declare const URL: new (
  input: string,
) => {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly host: string;
  readonly hostname: string;
  readonly pathname: string;
};

/** A URL's host name, lower-cased, and its path; undefined when it does not parse. */
export function hostAndPathOf(raw: string): { readonly hostname: string; readonly pathname: string } | undefined {
  try {
    const parsed = new URL(raw);
    return { hostname: parsed.hostname.toLowerCase(), pathname: parsed.pathname };
  } catch {
    return undefined;
  }
}

/** Bounds of the `knownUrls` checkpoint channel. */
export const KNOWN_URL_LIMITS = {
  /** A longer URL is never known: it is asked about. */
  maxUrlLength: 2048,
  /** The channel keeps the newest this many; an evicted URL is asked about again. */
  maxUrls: 2000,
} as const;

// Characters the WHATWG parser would silently strip or that cannot be part of
// a written address; an input carrying them is not compared byte for byte.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The known-URL normal form of an http(s) URL, or `undefined` when `raw` is not one,
 * cannot be parsed, or is longer than 2,048 characters (never known):
 * - scheme lower-cased; host lower-cased and in its ASCII (punycode) form;
 * - a default port dropped; an empty path becomes `/`;
 * - the fragment dropped;
 * - the query string kept byte for byte, as written — never re-encoded or
 *   reordered, so `?a=1&b=2` and `?b=2&a=1` are different URLs.
 * Userinfo is kept (as the parser encodes it): dropping it would let
 * `https://secret@known.example/` pass for `https://known.example/`.
 */
export function normalizeUrl(raw: string): string | undefined {
  // Only plain spaces are trimmed, as the parser does (controls are refused
  // below). Any other white space at either end (NBSP, U+2000–U+200A, U+3000,
  // U+FEFF…) would be sent with the request, so such an input is refused.
  const trimmed = raw.replace(/^ +| +$/gu, "");
  if (trimmed !== raw.trim()) return undefined;
  if (trimmed.length === 0 || trimmed.length > KNOWN_URL_LIMITS.maxUrlLength || CONTROL.test(trimmed)) return undefined;
  if (!/^https?:/i.test(trimmed)) return undefined;
  let parsed: InstanceType<typeof URL>;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  // The query as written: the parser ends the authority and path at the first
  // `?` and the query at the first `#`, so the first `?` before any `#` starts it.
  const hash = trimmed.indexOf("#");
  const beforeFragment = hash === -1 ? trimmed : trimmed.slice(0, hash);
  // A space before the fragment would end the normalized form and be trimmed
  // on the next pass, so the result would not be stable: refused.
  if (beforeFragment.endsWith(" ")) return undefined;
  const question = beforeFragment.indexOf("?");
  const query = question === -1 ? "" : beforeFragment.slice(question);
  const userinfo =
    parsed.username === "" && parsed.password === "" ? "" : `${parsed.username}${parsed.password === "" ? "" : `:${parsed.password}`}@`;
  const normalized = `${parsed.protocol}//${userinfo}${parsed.host}${parsed.pathname === "" ? "/" : parsed.pathname}${query}`;
  return normalized.length > KNOWN_URL_LIMITS.maxUrlLength ? undefined : normalized;
}

// An http(s) address in running text. It ends at whitespace or at a character
// that cannot appear unencoded in one; sentence punctuation and an unbalanced
// closing bracket are trimmed after the match.
export const URL_IN_TEXT = /https?:\/\/[^\s<>"'`{}|\\^]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?*]+$/;

/**
 * A URL candidate cut from running text without its trailing sentence
 * punctuation and an unbalanced closing bracket, so `(see https://a.example/x_(y)).`
 * keeps `x_(y)`. Shared with channel-kit's `disarmUrls`, so a link is known by
 * the same boundary it was extracted with.
 */
export function trimTrailing(candidate: string): string {
  let url = candidate;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING_PUNCTUATION, "");
    const last = url.at(-1);
    const pairs: Record<string, string> = { ")": "(", "]": "[" };
    const open = last === undefined ? undefined : pairs[last];
    if (open !== undefined && last !== undefined && url.split(last).length > url.split(open).length) url = url.slice(0, -1);
    if (url === before) return url;
  }
}

/**
 * The fragment of `raw` as written (after the first `#`), or `undefined` when
 * it has none or an empty one. Page script reads it, so a navigation compares it.
 */
export function fragmentOf(raw: string): string | undefined {
  const hash = raw.indexOf("#");
  if (hash === -1) return undefined;
  const fragment = raw.slice(hash + 1).replace(/ +$/u, "");
  return fragment === "" ? undefined : fragment;
}

/**
 * The key a browser navigation is known by: the known-URL normal form, with the
 * fragment as written appended when it has one. A fetch drops the fragment
 * (it is never sent); a navigation must not, since page script reads it — a
 * model-appended `#…` on a known page would carry data to it.
 */
export function navigationKeyOf(raw: string): string | undefined {
  const normalized = normalizeUrl(raw);
  if (normalized === undefined) return undefined;
  const fragment = fragmentOf(raw);
  return fragment === undefined ? normalized : `${normalized}#${fragment}`;
}

/**
 * Whether a browser navigation to `url` is known: as `isKnownUrl`, and when it
 * carries a fragment, that exact fragment on that URL is in `known` too
 * (`extractFragmentUrls`). A known set without fragment keys — the bounded
 * `knownUrls` channel keeps normal forms only — fails safe: asked again.
 */
export function isKnownNavigation(url: string, known: ReadonlySet<string>): boolean {
  const key = navigationKeyOf(url);
  return key !== undefined && known.has(key);
}

/**
 * An address in text: anything with a scheme (`https://…`, `ftp://[::1]/`), a
 * bare IPv4 address, or a bare domain a channel would link (`evil.example/x`,
 * `x_y.пример.рф`), with its port and path.
 */
const ADDRESS = new RegExp(
  [
    // Ends where known-URL extraction ends one (`extractUrls`), balanced brackets kept.
    String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'\x60{}|\\^]+`,
    String.raw`(?<![\p{L}\p{M}\p{N}_])\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?(?:\/[^\s<>"'\])]*)?`,
    // An ASCII host written with ideographic or full-width full stops, which some clients read as dots.
    String.raw`(?<![\p{L}\p{M}\p{N}_])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.\u3002\uFF0E\uFF61])+[a-z]{2,63}(?![\p{L}\p{M}\p{N}])(?::\d{1,5})?(?:\/[^\s<>"'\])]*)?`,
    String.raw`(?<![\p{L}\p{M}\p{N}_])(?:[\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]{0,62}\.)+\p{L}[\p{L}\p{M}\p{N}-]{1,62}(?::\d{1,5})?(?:\/[^\s<>"'\])]*)?`,
  ].join("|"),
  "giu",
);

/**
 * `text` with every address disarmed (`https://evil.example/?q=…` becomes
 * `hxxps[:]//evil[.]example/?q=…`), except a URL in `known` — a set of
 * known-URL keys (`knownUrlSet`, `urlKeysIn`), compared
 * by `isKnownNavigation`: an exact match, its fragment included, since page
 * script reads a fragment the model appended to a known link.
 *
 * A channel fetches a link's preview unattended, and a person may tap it, so
 * an address the model composed — perhaps from a page telling it to put what
 * it read into one — must never be a link (HEARTBEAT.md step 7). A bare
 * domain or IP is never known: only a full
 * http(s) URL can match.
 */
export function disarmUrls(text: string, known: ReadonlySet<string>): string {
  return text.replace(ADDRESS, (address) => {
    if (isKnownNavigation(trimTrailing(address), known)) return address;
    return address
      .replace(
        /^([a-z][a-z0-9+.-]*):\/\//i,
        (_whole, scheme: string) =>
          `${scheme.toLowerCase() === "https" ? "hxxps" : scheme.toLowerCase() === "http" ? "hxxp" : scheme}[:]//`,
      )
      .replace(/^((?:[^/]*\[:\]\/\/)?[^/?#]*)/, (host) => host.replace(/[.\u3002\uFF0E\uFF61]/g, "[.]"));
  });
}
