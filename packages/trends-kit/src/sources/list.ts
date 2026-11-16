import { robotsAllows } from "@tavi/contracts";
import { isRecord } from "@tavi/contracts/util";
import { z } from "zod";

import { childOf, childrenOf, parseXml, textOf } from "@tavi/domain-kit";

import type { CountPoint, TrendEntry, TrendsSourceRecord } from "../contracts.js";
import { bucketStart } from "../store/store.js";
import { about, bucketsOf, drift, failureOf, numberOf, plainText, stringOf } from "./common.js";
import type { ReadOutcome, SourceCall, SourceRequest, SourceResponse, TrendsAdapter } from "./types.js";

/**
 * Open-page lists: a site's own hot list, read by the worker
 * over plain HTTP from a data file, never a browser: RSS, a JSON answer, a
 * page's JSON-LD, JSON a page embeds, or a page's links. The worker asks the
 * site's robots.txt first and honours a `Content-Signal` that says no to AI
 * input; a refusal, a rate limit or a challenge page stops the source for the
 * day. Lists are `unofficial`, so off until the operator turns one on.
 */

/** A path into JSON: `$.a.b[0].c[*]`, and `$..c[*]` for every `c` at any depth. */
const JsonPathSchema = z
  .string()
  .regex(/^\$(\.\.?[A-Za-z_$][\w$-]*|\[(\d+|\*)\])*$/, "a path such as $.data.cards[0].content[*]")
  .max(200);

export const ListSpecSchema = z.strictObject({
  recordId: z.string().min(1).max(40),
  /** The list's address; `{name}` is a setting's value (`{pttBoard}`), checked against its pattern. */
  url: z.string().url().max(500),
  extract: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("rss") }),
    z.strictObject({ mode: z.literal("json"), path: JsonPathSchema }),
    z.strictObject({ mode: z.literal("jsonld"), type: z.string().min(1).max(60) }),
    z.strictObject({ mode: z.literal("embedded-json"), marker: z.string().min(4).max(120), path: JsonPathSchema }),
    /** A page's links whose path matches `href` (a regular expression), each link's text the title: a board's thread list. */
    z.strictObject({ mode: z.literal("anchors"), href: z.string().min(2).max(200) }),
  ]),
  /** Where an entry's fields are: a key of each JSON entry (`word`), or a `{key}` template for its link. */
  map: z.strictObject({
    title: z.string().min(1).max(60),
    url: z.string().min(1).max(200).optional(),
    rank: z.string().min(1).max(60).optional(),
    metric: z.string().min(1).max(60).optional(),
  }),
  /** A setting a `{name}` in the url reads, its default, and what its value may be. */
  settings: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
        default: z.string().max(60),
        pattern: z.string().min(2).max(100),
      }),
    )
    .max(2)
    .default([]),
  // PTT's over18: sent only when the named boolean setting (pttAdultBoards) is on; the assertion is shown at approval.
  cookies: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(40),
        value: z.string().max(100),
        assertion: z.string().max(200),
        setting: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
      }),
    )
    .max(1)
    .default([]),
  /** A marker on a page that means the site asked for something the list cannot give: PTT's 18+ boards send their threads, then ask the age in script; with the `unless` setting on, the operator has answered it. */
  refusedWhen: z
    .array(
      z.strictObject({
        marker: z.string().min(4).max(120),
        reason: z.string().min(1).max(160),
        unless: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
          .optional(),
      }),
    )
    .max(3)
    .default([]),
});
export type ListSpec = z.infer<typeof ListSpecSchema>;

/** The values a path names in `value`. */
export function jsonAt(value: unknown, path: string): unknown[] {
  const steps = [...path.slice(1).matchAll(/(\.\.?)([A-Za-z_$][\w$-]*)|\[(\d+|\*)\]/g)];
  let current: unknown[] = [value];
  for (const step of steps) {
    const [, dots, key, index] = step;
    if (key !== undefined) {
      current =
        dots === ".."
          ? current.flatMap((each) => descendants(each, key))
          : current.flatMap((each) => (isRecord(each) && key in each ? [each[key]] : []));
    } else if (index === "*") current = current.flatMap((each) => (Array.isArray(each) ? each : []));
    else current = current.flatMap((each) => (Array.isArray(each) && Number(index) < each.length ? [each[Number(index)]] : []));
  }
  return current;
}

/** Every value of `key` at any depth under `value`, in document order: at most 64 levels deep and 50,000 nodes walked. */
function descendants(value: unknown, key: string): unknown[] {
  const found: unknown[] = [];
  let budget = 50_000;
  const visit = (node: unknown, depth: number): void => {
    if ((budget -= 1) < 0 || depth > 64 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [name, child] of Object.entries(node)) {
      if (name === key) found.push(child);
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return found;
}

/**
 * A page that is a challenge rather than the list: Cloudflare's interstitial,
 * reCAPTCHA's, hCaptcha's. Cloudflare's passive `challenge-platform` script
 * rides on ordinary pages too (PTT's), so it is no sign of one.
 */
const CHALLENGE =
  /cf-chl-|_cf_chl_opt|<title>Just a moment\.\.\.<\/title>|Attention Required! \| Cloudflare|class="g-recaptcha"|recaptcha\.net\/recaptcha|www\.google\.com\/recaptcha\/api|hcaptcha\.com\/1\/api/i;

/** robots.txt as Tavi honours it everywhere, for the worker's list reads. */
export { robotsAllows };

/** Whether a `Content-Signal` (a robots.txt line or a response header) says no to AI input. */
export function refusesAiInput(signal: string | null | undefined): boolean {
  return signal !== null && signal !== undefined && /(^|[\s,;])ai-input\s*=\s*no\b/i.test(signal);
}

/** A robots.txt's own Content-Signal lines, for the `*` and `tavi` groups alike: a no anywhere is a no. */
export const robotsContentSignal = (robots: string): string | undefined =>
  robots
    .split(/\r?\n/)
    .filter((line) => /^\s*content-signal\s*:/i.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1))
    .join(",") || undefined;

/** Elements one page is scanned for: a hostile page cannot make a read long. */
const ELEMENTS_MAX = 2_000;
/** The longest opening tag read; a longer one is skipped. */
const TAG_MAX = 4_000;

/**
 * The elements named `name` in an HTML page, each as its opening tag and its
 * content, in one pass of `indexOf` (no regular expression over the page, so
 * an unclosed tag costs no more than reading it once). One that never closes
 * ends the scan.
 */
function elementsOf(page: string, name: string): { readonly tag: string; readonly content: string }[] {
  const lower = page.toLowerCase();
  const open = `<${name}`;
  const close = `</${name}>`;
  const found: { tag: string; content: string }[] = [];
  let at = 0;
  while (found.length < ELEMENTS_MAX) {
    const start = lower.indexOf(open, at);
    if (start === -1) break;
    const after = lower[start + open.length];
    // `<a` must be the element, not `<abbr`.
    if (after !== " " && after !== "\t" && after !== "\n" && after !== "\r" && after !== ">") {
      at = start + open.length;
      continue;
    }
    const tagEnd = lower.indexOf(">", start);
    if (tagEnd === -1) break;
    const end = lower.indexOf(close, tagEnd);
    if (end === -1) break;
    if (tagEnd - start <= TAG_MAX) found.push({ tag: page.slice(start, tagEnd + 1), content: page.slice(tagEnd + 1, end) });
    at = end + close.length;
  }
  return found;
}

/** An attribute's value in one opening tag, quoted with `"` or `'`. */
const attributeOf = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
    .exec(tag)
    ?.slice(1)
    .find((value) => value !== undefined);

/** The JSON a page embeds after `marker`: an object or a list, read up to where it closes. */
function embedded(page: string, marker: string): unknown {
  const at = page.indexOf(marker);
  if (at === -1) return undefined;
  const rest = page.slice(at + marker.length).trimStart();
  // A <script type="application/json"> holds its JSON up to the script's end.
  if (marker.endsWith(">")) {
    const end = rest.indexOf("</script>");
    return parseJson(end === -1 ? rest : rest.slice(0, end));
  }
  // Otherwise a JavaScript value: the balanced object or list that starts here.
  const open = rest[0];
  if (open !== "{" && open !== "[") return undefined;
  let depth = 0;
  let quoted: string | undefined;
  for (let index = 0; index < rest.length && index < 8 * 1024 * 1024; index += 1) {
    const char = rest[index];
    if (quoted !== undefined) {
      if (char === "\\") index += 1;
      else if (char === quoted) quoted = undefined;
      continue;
    }
    if (char === '"' || char === "'") quoted = char;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return parseJson(rest.slice(0, index + 1));
    }
  }
  return undefined;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** An entry's field: a key of the entry, or a `{key}` template filled from it. */
function field(entry: Record<string, unknown>, spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined;
  if (spec.includes("{")) {
    let missing = false;
    const filled = spec.replace(/\{([\w$-]+)\}/g, (_, key: string) => {
      const value = entry[key];
      if (typeof value !== "string" && typeof value !== "number") missing = true;
      return encodeURIComponent(String(value ?? ""));
    });
    return missing ? undefined : filled;
  }
  const value = entry[spec];
  return typeof value === "number" ? String(value) : stringOf(value);
}

/** An entry's link, made absolute against the list's page and kept only as http(s). */
function linkOf(href: string | undefined, base: string): string | undefined {
  if (href === undefined) return undefined;
  try {
    const url = new URL(href, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** What a list holds, in its order. */
function entriesOf(spec: ListSpec, body: unknown, base: string): TrendEntry[] | undefined {
  const text = typeof body === "string" ? body : undefined;
  let raw: Record<string, unknown>[] | undefined;
  if (spec.extract.mode === "rss") {
    if (text === undefined) return undefined;
    const document = parseXml(text);
    // RSS 2.0 (rss/channel/item) and RSS 1.0 (rdf:RDF/item), as Hatena serves it.
    const root = childOf(document, "rss") ?? childOf(document, "rdf:RDF");
    if (root === undefined) return undefined;
    const items = [...childrenOf(childOf(root, "channel"), "item"), ...childrenOf(root, "item")];
    raw = items.map((item) => ({
      title: textOf(item, "title") ?? "",
      link: textOf(item, "link") ?? "",
      count: textOf(item, "hatena:bookmarkcount") ?? "",
    }));
  } else if (spec.extract.mode === "anchors") {
    if (text === undefined) return undefined;
    const pattern = new RegExp(spec.extract.href);
    raw = elementsOf(text, "a").flatMap((element) => {
      const href = attributeOf(element.tag, "href");
      return href !== undefined && pattern.test(href) ? [{ href, title: plainText(element.content) }] : [];
    });
  } else {
    let document: unknown;
    if (spec.extract.mode === "json") document = typeof body === "string" ? parseJson(body) : body;
    else if (spec.extract.mode === "embedded-json") document = text === undefined ? undefined : embedded(text, spec.extract.marker);
    else {
      const type = spec.extract.type;
      document =
        text === undefined
          ? undefined
          : elementsOf(text, "script")
              .filter((element) => attributeOf(element.tag, "type")?.toLowerCase() === "application/ld+json")
              .slice(0, 50)
              .map((element) => parseJson(element.content))
              .flatMap((value) => (Array.isArray(value) ? value : [value]))
              .filter((value) => (value as { "@type"?: unknown } | null)?.["@type"] === type);
    }
    if (document === undefined) return undefined;
    const found = spec.extract.mode === "jsonld" ? jsonAt(document, "$[*]..itemListElement[*]") : jsonAt(document, spec.extract.path);
    raw = found.filter(isRecord);
  }
  return raw
    .flatMap((entry, index): TrendEntry[] => {
      const title = field(entry, spec.map.title);
      if (title === undefined || title.trim() === "") return [];
      const url = linkOf(
        field(entry, spec.map.url ?? (spec.extract.mode === "rss" ? "link" : spec.extract.mode === "anchors" ? "href" : undefined)),
        base,
      );
      const rank = numberOf(field(entry, spec.map.rank)) ?? index + 1;
      const volume = numberOf(field(entry, spec.map.metric ?? (spec.extract.mode === "rss" ? "count" : undefined)));
      return [
        {
          title: plainText(title).slice(0, 300),
          rank,
          ...(url === undefined ? {} : { url }),
          ...(volume === undefined ? {} : { volume, volumeLabel: String(volume) }),
        },
      ];
    })
    .filter(
      ((seen: Set<string>) => (entry: TrendEntry) => {
        // An entry the list repeats (a story in two slots) is kept once.
        const key = entry.url ?? entry.title;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })(new Set()),
    )
    .slice(0, 100);
}

/** The list's address with its settings filled in; undefined when a setting's value is not one it allows. */
export function listUrl(spec: ListSpec, call: SourceCall): string | undefined {
  let url = spec.url;
  for (const setting of spec.settings) {
    const raw = call.settings[setting.name];
    const value = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : setting.default;
    if (!new RegExp(`^(?:${setting.pattern})$`).test(value)) return undefined;
    url = url.replaceAll(`{${setting.name}}`, encodeURIComponent(value));
  }
  return url;
}

/** One list's answer read: its entries, or why not (a challenge or a refusal the site wrote is a block). */
function readList(spec: ListSpec, response: SourceResponse, request: SourceRequest, call: SourceCall): ReadOutcome<readonly TrendEntry[]> {
  const failed = failureOf(response, call.now);
  if (failed !== undefined) return failed;
  if (refusesAiInput(response.contentSignal))
    return { kind: "failed", class: "blocked", status: response.status, detail: "its Content-Signal says no to AI input" };
  if (typeof response.body === "string" && CHALLENGE.test(response.body.slice(0, 200_000)))
    return { kind: "failed", class: "blocked", status: response.status, detail: "a challenge page" };
  for (const refusal of spec.refusedWhen) {
    if (refusal.unless !== undefined && call.settings[refusal.unless] === true) continue;
    if (typeof response.body === "string" && response.body.includes(refusal.marker))
      return { kind: "failed", class: "blocked", status: response.status, detail: refusal.reason };
  }
  const entries = entriesOf(spec, response.body, request.url);
  return entries === undefined ? drift("the list is not where its spec says") : { kind: "ok", value: entries };
}

/**
 * A list source as an adapter: `trending` reads the list; `counts` is a
 * snapshot, how many of the list's entries name the topic now, in the
 * bucket holding now (every other bucket unseen). A list never backfills.
 */
export function listAdapter(record: TrendsSourceRecord, spec: ListSpec): TrendsAdapter {
  const parsed = ListSpecSchema.parse(spec);
  const request = (call: SourceCall): SourceRequest[] => {
    const url = listUrl(parsed, call);
    if (url === undefined) return [];
    const cookies = parsed.cookies
      .filter((cookie) => call.settings[cookie.setting] === true)
      .map((cookie) => `${cookie.name}=${cookie.value}`);
    // Redirects are the worker's to follow, so each hop's robots.txt is asked too.
    return [
      {
        url,
        expect: parsed.extract.mode === "json" ? "json" : "text",
        redirect: "manual",
        ...(cookies.length === 0 ? {} : { headers: { Cookie: cookies.join("; ") } }),
      },
    ];
  };
  return {
    record,
    robots: true,
    unconfigured: (call) =>
      listUrl(parsed, call) === undefined
        ? `a setting this list reads is not one it allows: ${parsed.settings.map((setting) => setting.name).join(", ")}`
        : undefined,
    trending: { request: (_input, call) => request(call), parse: (response, req, _input, call) => readList(parsed, response, req, call) },
    counts: {
      request: (_input, call) => request(call),
      parse: (response, req, { topic, window }, call) => {
        const read = readList(parsed, response, req, call);
        if (read.kind !== "ok") return read;
        const naming = read.value.filter((entry) => about(entry.title, topic.terms, topic.exclude)).length;
        const current = bucketStart(call.now, window.bucket);
        return {
          kind: "ok",
          value: [
            {
              metric: "entries",
              points: bucketsOf(window).map(
                (start): CountPoint =>
                  start === current ? { start, value: naming, quality: "approximate" } : { start, value: 0, quality: "missing" },
              ),
            },
          ],
        };
      },
    },
  };
}
