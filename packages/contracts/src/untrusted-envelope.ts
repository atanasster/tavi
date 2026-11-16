/**
 * The untrusted-content envelope: untrusted content reaches the model fenced as
 *
 * ```
 * [untrusted:<16 hex> source=web host=example.com]
 * …
 * [/untrusted:<16 hex>]
 * ```
 *
 * applied when a request is converted for a provider, never in the
 * checkpoint, which keeps the raw result. The id is derived from the tool call
 * (or message) id by the caller, so a wrapped result renders byte for byte the
 * same on every later request and the prompt cache holds.
 *
 * Hygiene, not a gate: the envelope only tells the model where data starts and
 * ends. Before the content is fenced, anything in it that could pass for a
 * fence is rewritten — a forged envelope line (`[untrusted:<hex> …]`,
 * `[/untrusted:<hex>]`, `[/untrusted]`, `</untrusted>`), a `context-` or
 * `inbound-` block marker, and chat-template special tokens by
 * their exact names —
 * matched on a folded reading of the text (NFKC, invisible characters gone,
 * look-alike letters folded to Latin, lower case). The folding is for finding
 * markers only: every character outside a rewritten marker is left as it was.
 *
 * Pure: no I/O, no clock, no Node or browser API.
 */
import { z } from "zod";

// Acyclic: content-label.ts imports only zod.
import { DESKTOP_HOST_PREFIX, SourceKindSchema } from "./content-label.js";

/** An envelope id: 16 lower-case hex digits, derived from the call or message id. */
const UNTRUSTED_ENVELOPE_ID_PATTERN = /^[0-9a-f]{16}$/;
/** A host as an envelope names it: what Tavi parsed, never the content's own words. Anything else is left out. */
const ENVELOPE_HOST_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?)*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;

export const UntrustedEnvelopeSchema = z.strictObject({
  id: z.string().regex(UNTRUSTED_ENVELOPE_ID_PATTERN),
  /** The content label's sources, in the label's order. */
  sources: z.array(SourceKindSchema).min(1).max(16),
  host: z.string().max(253).optional(),
});
export type UntrustedEnvelope = z.infer<typeof UntrustedEnvelopeSchema>;

/**
 * Characters that render as nothing (or nearly nothing) and so can split a
 * marker without showing: soft hyphen, combining grapheme joiner, the
 * zero-width and bidi controls, word joiners, the BOM, variation selectors
 * (and their supplement, U+E0100\u2013U+E01EF) and tag characters (U+E0000\u2013
 * U+E007F). Stripped for marker matching only. The supplementary ranges are
 * written as code points: under the `u` flag a surrogate pair spelled out in a
 * pattern matches lone surrogates only, never the character the pair encodes.
 */
const INVISIBLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: U+034F (combining grapheme joiner) is listed on its own on purpose, as one of the characters to strip
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;

/**
 * Look-alikes folded to the Latin letter or the ASCII punctuation they pass
 * for (Cyrillic, Greek, Armenian, and the brackets, slashes and bars NFKC
 * leaves alone). Not a full confusables table: the letters of the markers
 * and tokens this module rewrites, and those a detector pattern reads.
 */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a",
  в: "b",
  г: "r",
  д: "d",
  е: "e",
  ё: "e",
  і: "i",
  ї: "i",
  ј: "j",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  п: "n",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  ѕ: "s",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  ӏ: "l",
  ь: "b",
  ѵ: "v",
  А: "a",
  В: "b",
  Е: "e",
  Ё: "e",
  К: "k",
  М: "m",
  Н: "h",
  О: "o",
  Р: "p",
  С: "c",
  Т: "t",
  У: "y",
  Х: "x",
  Ѕ: "s",
  І: "i",
  Ї: "i",
  Ј: "j",
  Ԁ: "d",
  Ԛ: "q",
  Ԝ: "w",
  Ӏ: "l",
  // Greek
  α: "a",
  β: "b",
  γ: "y",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ω: "w",
  Α: "a",
  Β: "b",
  Ε: "e",
  Ζ: "z",
  Η: "h",
  Ι: "i",
  Κ: "k",
  Μ: "m",
  Ν: "n",
  Ο: "o",
  Ρ: "p",
  Τ: "t",
  Υ: "y",
  Χ: "x",
  // Armenian and Latin extensions
  ս: "u",
  ո: "n",
  օ: "o",
  ց: "g",
  ı: "i",
  ȷ: "j",
  ɡ: "g",
  ɑ: "a",
  ʀ: "r",
  ꜱ: "s",
  ᴛ: "t",
  ᴜ: "u",
  ᴅ: "d",
  ᴇ: "e",
  ɴ: "n",
  ᴄ: "c",
  ᴏ: "o",
  ᴋ: "k",
  // Punctuation NFKC leaves alone
  "⁄": "/",
  "∕": "/",
  "⧸": "/",
  "╱": "/",
  "⟦": "[",
  "⟧": "]",
  "〚": "[",
  "〛": "]",
  "⁅": "[",
  "⁆": "]",
  "‹": "<",
  "›": ">",
  "〈": "<",
  "〉": ">",
  "⟨": "<",
  "⟩": ">",
  "❮": "<",
  "❯": ">",
  ǀ: "|",
  "∣": "|",
  "│": "|",
  "￨": "|",
  "▏": "|",
};

/**
 * `text` folded for marker matching, with where each folded UTF-16 unit came
 * from: `starts[i]`/`ends[i]` are the original span of the code point that
 * produced folded unit `i`. Per code point: NFKC, invisible characters
 * dropped, look-alikes folded, lower case.
 */
export function foldForMarkers(text: string): {
  readonly folded: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
} {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const point of text) {
    const end = index + point.length;
    if (!INVISIBLE.test(point)) {
      for (const char of point.normalize("NFKC")) {
        if (INVISIBLE.test(char)) continue;
        const mapped = (LOOK_ALIKES[char] ?? char).toLowerCase();
        for (let unit = 0; unit < mapped.length; unit += 1) {
          starts.push(index);
          ends.push(end);
        }
        folded += mapped;
      }
    }
    index = end;
  }
  return { folded, starts, ends };
}

/** Just the folded text (`foldForMarkers`): what a detector reads. */
export function foldedText(text: string): string {
  return foldForMarkers(text).folded;
}

/** One rewrite: a pattern on the folded text, and what a match becomes. */
interface MarkerRewrite {
  readonly pattern: RegExp;
  readonly replace: (match: RegExpExecArray) => string;
}

/** A matched token's name, for its quoted form: letters, digits, `_` and `-` only. */
const tokenName = (text: string): string =>
  text
    .replace(/[^a-z0-9_-]+/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 40) || "token";

/** The `<|name|>` special tokens of the chat templates in use, by name (folded: lower case, NFKC). */
export const CHAT_TEMPLATE_TOKEN_NAMES = [
  "im_start",
  "im_end",
  "im_sep",
  "endoftext",
  "begin_of_text",
  "end_of_text",
  "start_header_id",
  "end_header_id",
  "eot_id",
  "eom_id",
  "python_tag",
  "finetune_right_pad_id",
  "system",
  "user",
  "assistant",
  "end",
  "tool",
  "start_of_turn_token",
  "end_of_turn_token",
  "system_token",
  "user_token",
  "chatbot_token",
  "begin▁of▁sentence",
  "end▁of▁sentence",
  "tool▁calls▁begin",
  "tool▁calls▁end",
  "tool▁call▁begin",
  "tool▁call▁end",
  "tool▁sep",
  "tool▁outputs▁begin",
  "tool▁outputs▁end",
  "tool▁output▁begin",
  "tool▁output▁end",
] as const;
const CHAT_TOKEN_PIPED = new RegExp(`<\\|(?:${CHAT_TEMPLATE_TOKEN_NAMES.join("|")})\\|>`, "gu");

const MARKER_REWRITES: readonly MarkerRewrite[] = [
  // The envelope's own lines, `[untrusted:<hex> …]` and `[/untrusted:<hex>]`: the keyword and id are
  // rewritten and whatever follows them up to the bracket is kept. The bare closing forms `[/untrusted]`
  // and `</untrusted>` (`<untrusted>`) are rewritten whole. Any other bracketed "untrusted" text is prose.
  { pattern: /\[\s*(\/?)\s*untrusted\s*:\s*[0-9a-f]{1,32}(?=[^\]\n]{0,200}\])/gu, replace: (match) => `[${match[1]}untrusted (quoted)` },
  { pattern: /\[\s*\/\s*untrusted\s*\]/gu, replace: () => "[/untrusted (quoted)]" },
  { pattern: /<\s*(\/?)\s*untrusted\s*>/gu, replace: (match) => `<${match[1]}untrusted (quoted)>` },
  // A context block's markers and an inbound block's fences.
  { pattern: /\[\s*(\/?)\s*context\s*\]/gu, replace: (match) => `[${match[1]}context (quoted)]` },
  { pattern: /\[\s*(\/?)\s*inbound\s*\]/gu, replace: (match) => `[${match[1]}inbound (quoted)]` },
  // Chat-template special tokens, by their exact names: ChatML and Qwen (`<|im_start|>`, `<|endoftext|>`),
  // Llama 3 (`<|begin_of_text|>`, `<|start_header_id|>`, `<|eot_id|>`), Phi (`<|user|>`, `<|end|>`), Cohere
  // (`<|START_OF_TURN_TOKEN|>`), DeepSeek (`<｜begin▁of▁sentence｜>`, its bars folded by NFKC), Gemma
  // (`<start_of_turn>`), Llama 2 and Mistral (`[INST]`, `<<SYS>>`, `[SYSTEM_PROMPT]`, `[TOOL_CALLS]`), and
  // Hermes-style tool tags.
  { pattern: CHAT_TOKEN_PIPED, replace: (match) => `[chat token ${tokenName(match[0])} (quoted)]` },
  {
    pattern:
      /<\s*\/?\s*(?:start_of_turn|end_of_turn|start_of_image|end_of_image|bos|eos|tool_call|tool_response|function_call|function_response|im_start|im_end)\s*>/gu,
    replace: (match) => `[chat token ${tokenName(match[0])} (quoted)]`,
  },
  {
    pattern: /\[\s*\/?\s*(?:inst|system_prompt|tool_calls|tool_results|available_tools)\s*\]/gu,
    replace: (match) => `[chat token ${tokenName(match[0])} (quoted)]`,
  },
  { pattern: /<<\s*\/?\s*sys\s*>>/gu, replace: (match) => `[chat token ${tokenName(match[0])} (quoted)]` },
];

/**
 * A character class of every character whose folded reading holds `[` or
 * `<`: the two themselves, their fullwidth, small and vertical forms, and
 * the brackets `LOOK_ALIKES` folds to them (directly or after NFKC). Precomputed:
 * trying every Basic Multilingual Plane code point through `foldForMarkers`
 * costs about 73 ms, once per process. A unit test runs that scan and
 * compares, so a look-alike added above fails it until this list is updated.
 * Verified on Unicode 17.0. An assigned character's NFKC mapping never changes
 * (Unicode's normalization stability policy), so only a character a later
 * Unicode assigns could be missing, and only on a Node newer than the one the
 * tests last ran on: re-running the test after a Node upgrade is the check.
 */
export const MARKER_START_PATTERN =
  /[\u{3c}\u{5b}\u{2039}\u{2045}\u{2329}\u{276e}\u{27e6}\u{27e8}\u{3008}\u{301a}\u{fe3f}\u{fe47}\u{fe64}\u{ff1c}\u{ff3b}]/u;

/**
 * `text` with every forged fence and chat-template token rewritten as its
 * quoted form (`[/untrusted (quoted)]`, `[context (quoted)]`, `[chat token
 * im_start (quoted)]`, …). Matched on the folded reading (`foldForMarkers`),
 * so a marker in fullwidth letters, Cyrillic look-alikes or split by a
 * zero-width character is found; the rewrite replaces the marker's original
 * span, and nothing outside a marker changes. Idempotent.
 */
export function normaliseUntrustedText(text: string): string {
  // Every rewrite's pattern begins with `[` or `<` in the folded reading: a text holding no character that folds to
  // either has nothing to rewrite, and is returned without folding it (folding costs ~0.1 ms a kilobyte).
  if (!MARKER_START_PATTERN.test(text)) return text;
  const { folded, starts, ends } = foldForMarkers(text);
  const found: { readonly start: number; readonly end: number; readonly text: string }[] = [];
  for (const rewrite of MARKER_REWRITES) {
    rewrite.pattern.lastIndex = 0;
    for (let match = rewrite.pattern.exec(folded); match !== null; match = rewrite.pattern.exec(folded)) {
      if (match[0] === "") {
        rewrite.pattern.lastIndex += 1;
        continue;
      }
      found.push({ start: starts[match.index]!, end: ends[match.index + match[0].length - 1]!, text: rewrite.replace(match) });
    }
  }
  if (found.length === 0) return text;
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let at = 0;
  for (const span of found) {
    if (span.start < at) continue; // Overlaps one already rewritten.
    out += text.slice(at, span.start) + span.text;
    at = span.end;
  }
  return out + text.slice(at);
}

/** The envelope's opening line. */
export function untrustedEnvelopeHead(envelope: UntrustedEnvelope): string {
  // A desktop app's host (`desktop:<app>`) names no host, though `desktop:12345` would pass for one with a port.
  const host =
    envelope.host !== undefined && !envelope.host.startsWith(DESKTOP_HOST_PREFIX) && ENVELOPE_HOST_PATTERN.test(envelope.host)
      ? ` host=${envelope.host.toLowerCase()}`
      : "";
  return `[untrusted:${envelope.id} source=${envelope.sources.join(",")}${host}]`;
}

/** The envelope's closing line. */
export function untrustedEnvelopeEnd(envelope: Pick<UntrustedEnvelope, "id">): string {
  return `[/untrusted:${envelope.id}]`;
}

const CLIPPED = "\n[… clipped]";

/** How many wrapped texts `wrapUntrusted` remembers: a long chat's untrusted results, each re-sent on every request. */
const WRAP_CACHE_LIMIT = 512;
/** …and how many UTF-16 units of bodies and texts, all told. */
const WRAP_CACHE_UNITS = 8 * 1024 * 1024;
/** Wrapped texts by envelope line and bound, with the body each was made from; oldest first. */
const wrapCache = new Map<string, { readonly body: string; readonly text: string }>();
let wrapCacheUnits = 0;
let wrapCacheHits = 0;

/** How many `wrapUntrusted` calls the cache answered, and how many texts it holds (for tests). */
export function wrapUntrustedCacheStats(): { readonly hits: number; readonly size: number } {
  return { hits: wrapCacheHits, size: wrapCache.size };
}

/**
 * `body` fenced by `envelope`: normalised (`normaliseUntrustedText`), then
 * between the opening and closing lines. With `maxLength` (UTF-16 units, as a
 * message's text is bounded), the body is clipped so the whole fits, the cut
 * said, never splitting a surrogate pair: the closing line is always the
 * last. Deterministic: the same body and envelope give the same text.
 *
 * Every request re-sends every untrusted result, so the last
 * `WRAP_CACHE_LIMIT` wrapped texts are remembered by envelope and bound, and
 * one is reused only for the very body it was made from.
 */
export function wrapUntrusted(body: string, envelope: UntrustedEnvelope, maxLength?: number): string {
  const parsed = UntrustedEnvelopeSchema.parse(envelope);
  const head = untrustedEnvelopeHead(parsed);
  const end = untrustedEnvelopeEnd(parsed);
  const key = `${head}\u0000${maxLength ?? ""}`;
  const cached = wrapCache.get(key);
  if (cached !== undefined && cached.body === body) {
    wrapCacheHits += 1;
    wrapCache.delete(key);
    wrapCache.set(key, cached);
    return cached.text;
  }
  const text = wrapBody(body, head, end, maxLength);
  forget(key);
  wrapCache.set(key, { body, text });
  wrapCacheUnits += body.length + text.length;
  // Oldest first (a Map keeps insertion order), until the cache is back within both bounds.
  for (
    let oldest = wrapCache.keys().next();
    (wrapCache.size > WRAP_CACHE_LIMIT || wrapCacheUnits > WRAP_CACHE_UNITS) && oldest.done !== true;
    oldest = wrapCache.keys().next()
  )
    forget(oldest.value);
  return text;
}

/** Drops one remembered text. */
function forget(key: string): void {
  const entry = wrapCache.get(key);
  if (entry === undefined) return;
  wrapCacheUnits -= entry.body.length + entry.text.length;
  wrapCache.delete(key);
}

/** `wrapUntrusted`'s work, uncached. */
function wrapBody(body: string, head: string, end: string, maxLength: number | undefined): string {
  let inner = normaliseUntrustedText(body);
  if (maxLength !== undefined) {
    const room = maxLength - head.length - end.length - 2;
    if (inner.length > room) {
      let cut = Math.max(0, room - CLIPPED.length);
      const last = inner.charCodeAt(cut - 1);
      if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1;
      inner = `${inner.slice(0, cut)}${CLIPPED}`;
    }
  }
  return `${head}\n${inner}\n${end}`;
}

/** The text a provider is sent for a tool result's output: its JSON, wrapped when the result carries an envelope. */
export function toolResultText(output: unknown, envelope: UntrustedEnvelope | undefined): string {
  const json = JSON.stringify(output ?? null) ?? "null";
  return envelope === undefined ? json : wrapUntrusted(json, envelope);
}
