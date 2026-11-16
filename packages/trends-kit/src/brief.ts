import { createHash } from "node:crypto";

import type { StoredItem, TrendsSourceKind } from "./contracts.js";
import type { SourceTest } from "./engine/velocity.js";

/**
 * The brief checker: deterministic and model-free. A brief passes
 * only when every bullet cites an item that was fetched and is still kept,
 * every quotation in it is declared and is a verbatim span of a cited item,
 * every velocity figure is one a stored test computed, every bullet names
 * where its claim comes from, and a bullet called corroborated cites two
 * publishers. It fails closed: what it cannot verify, it refuses. Zero
 * uncited claims is use case 4.1's oracle; this is its implementation.
 */

export const BRIEF_BULLETS_MAX = 5;
export const BULLET_CHARS_MAX = 280;
/** The fewest characters a quotation's original words can be. */
const ORIGINAL_MIN_CHARS = 2;

export interface BriefQuote {
  readonly itemId: string;
  /** The words quoted, as the bullet shows them between quotation marks. */
  readonly span: string;
  /** A quote the model translated: `original` must then be the item's own words, and the brief shows them. */
  readonly translated?: boolean;
  readonly original?: string;
}

export interface BriefBullet {
  readonly text: string;
  readonly cites: readonly string[];
  readonly quotes?: readonly BriefQuote[];
  /** Claims two publishers report independently: checked, never taken on trust. */
  readonly corroborated?: boolean;
}

export interface BriefProblem {
  /** The bullet it is about, from 1; 0 for the brief as a whole. */
  readonly bullet: number;
  readonly problem:
    | "count"
    | "length"
    | "layout"
    | "uncited"
    | "unknown-item"
    | "quote-not-declared"
    | "quote-not-cited"
    | "quote-not-verbatim"
    | "translation-without-original"
    | "figure-not-computed"
    | "unattributed"
    | "not-corroborated";
  readonly detail: string;
}

export type BriefCheck =
  | { readonly ok: true; readonly briefId: string; readonly brief: string }
  | { readonly ok: false; readonly problems: readonly BriefProblem[] };

/** What the checker knows of a source: its family, and the name a bullet may attribute to. */
export interface BriefSource {
  readonly kind: TrendsSourceKind;
  readonly name: string;
}

/** Organisations that collect or host others' words: never a publisher for corroboration, whatever the subdomain. */
const AGGREGATORS = new Set([
  "ycombinator.com",
  "reddit.com",
  "lobste.rs",
  "slashdot.org",
  "bsky.app",
  "x.com",
  "twitter.com",
  "threads.net",
  "google.com",
  "mastodon.social",
  "mastodon.online",
  "mstdn.jp",
  "fosstodon.org",
  "chaos.social",
]);
/** Families whose items are a publisher's own reporting; everything else (posts, lists, unknown) is not. */
const PUBLISHER_KINDS: ReadonlySet<TrendsSourceKind> = new Set(["news", "research"]);
/** Second-level labels under a country code that are not an organisation's own (`bbc.co.uk`, `straitstimes.com.sg`). */
const GENERIC_SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "or", "ne", "go", "gob", "nic"]);

/** The organisation a host belongs to: its registrable domain (`news.bbc.co.uk` is `bbc.co.uk`). */
export function publisherOf(host: string): string {
  const parts = host
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  const tld = parts.at(-1) ?? "";
  const second = parts.at(-2) ?? "";
  return tld.length === 2 && GENERIC_SECOND_LEVEL.has(second) && parts.length > 2 ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}

/** Text as quotes are compared: NFC, curly quotes straightened, whitespace folded. */
export function normalized(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″«»„「」『』]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every quotation in a bullet: the text between a pair of double quotation marks (after normalising them). */
function quotationsIn(text: string): string[] {
  return [...normalized(text).matchAll(/"([^"]+)"/g)].map((match) => (match[1] ?? "").trim()).filter((quote) => quote !== "");
}

/** A figure in a bullet, bounded on the left so `1333%` is never read as `333%`. */
const PERCENT = /(?<![\d.,])([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[+-]?\d+(?:\.\d+)?)\s?(?:%|percent\b|per cent\b)/gi;
const MULTIPLE = /(?<![\d.,])(\d+(?:\.\d+)?)\s?(?:×|x\b|times\b|-?fold\b)/gi;

/** The growths the tests computed, each as a percentage and as a multiple. */
function computedGrowths(tests: readonly SourceTest[]): number[] {
  return tests
    .filter((test) => test.test === "count")
    .flatMap((test) => [
      test.g,
      ...(test.growthBaseline !== undefined && test.growthBaseline > 0 ? [test.x / test.growthBaseline - 1] : []),
    ]);
}

const number = (text: string): number => Number(text.replace(/,/g, ""));
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether `text` names `name` as a whole word, ignoring case. */
const namesWord = (text: string, name: string): boolean =>
  name.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "iu").test(text);

/** How an item is named under a bullet. */
function sourceLine(item: StoredItem): string {
  const day = (item.publishedAt ?? item.fetchedAt).slice(0, 10);
  return item.origin === "agent"
    ? `${item.outlet}, as read in the browser on ${item.fetchedAt.slice(0, 10)}: ${item.url}`
    : `${item.outlet} (${day}): ${item.url}`;
}

export function checkBrief(input: {
  readonly bullets: readonly BriefBullet[];
  /** The cited items still kept, found by id. */
  readonly items: ReadonlyMap<string, StoredItem>;
  /** The topic's latest tests: the only source of a velocity figure. */
  readonly tests: readonly SourceTest[];
  /** Each source's family and name; an unknown source is no publisher. */
  readonly sourceOf: (sourceId: string) => BriefSource | undefined;
}): BriefCheck {
  const problems: BriefProblem[] = [];
  if (input.bullets.length === 0 || input.bullets.length > BRIEF_BULLETS_MAX)
    problems.push({
      bullet: 0,
      problem: "count",
      detail: `a brief has 1 to ${String(BRIEF_BULLETS_MAX)} bullets, not ${String(input.bullets.length)}`,
    });
  const growths = computedGrowths(input.tests);
  for (const [index, bullet] of input.bullets.entries()) {
    const at = index + 1;
    const flag = (problem: BriefProblem["problem"], detail: string): void => void problems.push({ bullet: at, problem, detail });
    if (bullet.text.trim().length === 0 || bullet.text.length > BULLET_CHARS_MAX)
      flag("length", `a bullet is 1 to ${String(BULLET_CHARS_MAX)} characters`);
    // One line, as the brief lays it out: a bullet cannot forge another bullet or a source line.
    if (/[\n\r\u2028\u2029\u0000-\u001F\u007F\u2022]/.test(bullet.text))
      flag("layout", "a bullet is one line, with no bullet marks or control characters");
    if (bullet.cites.length === 0) flag("uncited", "every bullet cites at least one item it rests on");
    const cited = bullet.cites.flatMap((itemId) => {
      const item = input.items.get(itemId);
      if (item === undefined) flag("unknown-item", `${itemId} was never fetched, or is past its source's cache window`);
      return item === undefined ? [] : [item];
    });
    // Every quotation the bullet shows is declared, and every declared one is checked.
    const declared = new Set((bullet.quotes ?? []).map((quote) => normalized(quote.span)));
    for (const quotation of quotationsIn(bullet.text))
      if (!declared.has(quotation))
        flag("quote-not-declared", `"${quotation.slice(0, 80)}" is quoted but not declared with the item it comes from`);
    for (const quote of bullet.quotes ?? []) {
      const item = input.items.get(quote.itemId);
      if (!bullet.cites.includes(quote.itemId))
        flag("quote-not-cited", `the quote from ${quote.itemId} is not among the bullet's citations`);
      if (item === undefined) continue;
      const haystack = normalized(`${item.title} ${item.text}`);
      if (quote.translated === true) {
        const original = normalized(quote.original ?? "");
        if (original.length < ORIGINAL_MIN_CHARS || !haystack.includes(original))
          flag("translation-without-original", `a translated quote carries the item's own words, verbatim: ${quote.itemId}`);
      } else if (normalized(quote.span) === "" || !haystack.includes(normalized(quote.span))) {
        flag("quote-not-verbatim", `"${quote.span.slice(0, 80)}" is not in ${quote.itemId}'s text`);
      }
    }
    // Every figure shown is a growth a test computed, as displayed: a percentage to the unit, a multiple to one decimal.
    for (const match of bullet.text.matchAll(PERCENT)) {
      if (!growths.some((growth) => Math.abs(Math.round(growth * 100) - number(match[1] ?? "")) <= 1))
        flag("figure-not-computed", `${match[0].trim()} is not a growth any test computed`);
    }
    for (const match of bullet.text.matchAll(MULTIPLE)) {
      if (!growths.some((growth) => Math.abs(growth + 1 - number(match[1] ?? "")) <= 0.05 + 1e-9))
        flag("figure-not-computed", `${match[0].trim()} is not a multiple any test computed`);
    }
    // A bullet names where its claim comes from: a cited outlet or source by name, or, for people's posts, "posts claim…".
    const named = cited.some(
      (item) =>
        namesWord(bullet.text, publisherOf(item.outlet).split(".")[0] ?? "") ||
        namesWord(bullet.text, input.sourceOf(item.source)?.name ?? ""),
    );
    const posts =
      cited.some((item) => input.sourceOf(item.source)?.kind === "social" || item.origin === "agent") &&
      /\bposts?\s+(claim|claims|say|says|said|suggest|suggests)\b/i.test(bullet.text);
    if (cited.length > 0 && !named && !posts)
      flag(
        "unattributed",
        'name where the claim comes from: a cited outlet or source ("Reuters reported…", "per GDELT"), or "posts claim…" for people\'s posts; never assert it',
      );
    if (bullet.corroborated === true) {
      const publishers = new Set(
        cited
          .filter(
            (item) =>
              item.origin === "adapter" &&
              PUBLISHER_KINDS.has(input.sourceOf(item.source)?.kind ?? "reference") &&
              !AGGREGATORS.has(publisherOf(item.outlet)),
          )
          .map((item) => publisherOf(item.outlet)),
      );
      if (publishers.size < 2)
        flag(
          "not-corroborated",
          `corroborated needs two distinct publishers among the citations (aggregators, posts and unknown sources do not count); found ${String(publishers.size)}`,
        );
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  const brief = input.bullets
    .map((bullet) => {
      const originals = (bullet.quotes ?? [])
        .filter((quote) => quote.translated === true)
        .map((quote) => `  Original: "${normalized(quote.original ?? "")}" (translated)`);
      const sources = bullet.cites.flatMap((itemId) => {
        const item = input.items.get(itemId);
        return item === undefined ? [] : [`  ${sourceLine(item)}`];
      });
      return [`• ${bullet.text.trim()}`, ...originals, ...sources].join("\n");
    })
    .join("\n");
  return { ok: true, briefId: `b_${createHash("sha256").update(brief).digest("hex").slice(0, 16)}`, brief };
}
