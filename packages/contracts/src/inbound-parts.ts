/**
 * The inbound split a channel and the host share, zod-free (`@tavi/contracts/inbound-parts`): a channel plugin's
 * bundle carries it without the contracts barrel. Types only from messaging.
 */
import type { InboundEvent, InboundQuotedRange } from "./messaging.js";

/**
 * Inbound structure: which parts of a
 * message are the sender's own words and which are someone else's — an
 * email's quoted reply or forwarded message, a chat forward. A connector
 * reports the structure (`InboundEvent.forwarded`, `quotedRanges`, the latter
 * found by `splitEmailText`); core reads it through `inboundParts` and admits
 * what is not the person's as labelled quoted data, never as their prompt.
 *
 * The split is a heuristic and fails safe: mail it cannot read is untrusted as
 * a whole (`unparsed`). That costs a once-only ask for a sink in that chat;
 * reading a quote as the person's words would cost the gate.
 */

/**
 * Every line is read after NFKC, with zero-width characters and soft hyphens
 * gone: a fullwidth `：` or `＞` is a colon or a quote mark, and a marker
 * cannot be hidden by a character nobody sees. Ranges keep the raw offsets.
 */
const INVISIBLE = /[­​-‏⁠-⁤﻿]/g;
const normal = (text: string): string => text.normalize("NFKC").replace(INVISIBLE, "");

/** The words a forward's or an earlier message's marker line carries, in the languages mail clients write them in. */
const FORWARD_PHRASE = `(?:forwarded message|original message|weitergeleitete nachricht|urspr[üu]ngliche nachricht|message transf[ée]r[ée]|message d'origine|message original|mensaje reenviado|mensaje original|转发的邮件|原始邮件|轉寄郵件|原始郵件|轉寄的郵件)`;
/** A forward's opening line: the phrase fenced by dashes, or Apple Mail's own line. */
const FORWARD_MARKER = new RegExp(
  String.raw`^\s*(?:[-_=]{2,}\s*(?:${FORWARD_PHRASE}|forwarded by\b.*)\s*[-_=]{2,}|-{2,}\s*forwarded by\b.*|(?:begin forwarded message|anfang der weitergeleiteten nachricht|d[ée]but du message r[ée]exp[ée]di[ée])\s*:)\s*$`,
  "i",
);
/** What an attribution says: `wrote`, and the words other clients use for it. */
const ATTRIBUTION_PHRASE =
  /(?:\bwrote\b|\bschrieb\b|\ba [ée]crit\b|\bescribi[óo]\b|\bscrisse\b|\bschreef\b|\bnapisa[lł]|написал|写道|寫道|のメッセージ)/i;
/** An email address, bare or in angle brackets. */
const ADDRESS = /[^\s<>()"',;:@]+@[^\s<>()"',;:@]+\.[^\s<>()"',;:@]+/;
/** A date or a time, as an attribution names one. */
const DATE = /\b\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\b|\b(?:19|20)\d{2}\b|\b\d{1,2}:\d{2}\b|\d+\s*年/;
/** A quoted line. */
const QUOTED_LINE = /^\s*>/;
/** A reply header's lines in the languages mail clients write them in: a sender, then a date and a subject within a few lines. */
const HEADER_FROM = /^\s*\*?(?:from|von|de|exp[ée]diteur|da|van|发件人|寄件者|差出人)\s?:\*?\s*\S/i;
const HEADER_SENT = /^\s*\*?(?:sent|date|gesendet|datum|envoy[ée]|inviato|verzonden|发送时间|日期|寄件日期|送信日時)\s?:\*?\s/i;
const HEADER_SUBJECT = /^\s*\*?(?:subject|betreff|objet|oggetto|onderwerp|主题|主旨|件名)\s?:\*?\s/i;
/** A `Word: value` line, in any script: one line of a header block. */
const FIELD_LINE = /^\s*\*?[\p{L}\p{M}][\p{L}\p{M} .'-]{0,23}\s?:\*?\s+\S/u;
/** A line fenced by dashes, underscores or equals signs on both sides, with words between: a marker of some client's. */
const FENCED_LINE = /^\s*[-_=]{2,}\s*[^-_=\s].*[-_=]{2,}\s*$/;
/** An address in angle brackets. */
const BRACKETED_ADDRESS = /<[^<>\s@]+@[^<>\s]+>/;
/**
 * HTML a client left in a plain-text part: a `<blockquote>`, an `<html>`, or
 * a quote class inside a `class="…"` value — a `…_quote` or `…_quoted` div,
 * prefixes included (`x_…_quote`, as one client re-renders another's),
 * Thunderbird's `moz-cite-prefix` — never a bare identifier like `single_quote`.
 */
const HTML_QUOTE = /<\s*blockquote\b|\bclass\s*=\s*(?:"[^"<>]*?|'[^'<>]*?|)\b(?:(?:[a-z]+_)*[a-z]+_quoted?|moz-cite-prefix)\b|<\s*html\b/i;

interface Line {
  /** The line as read: NFKC, invisible characters gone. */
  readonly text: string;
  readonly start: number;
  /** Where the next line starts: past this line's break. */
  readonly next: number;
}

function linesOf(text: string): readonly Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const brk = text.indexOf("\n", start);
    const end = brk === -1 ? text.length : brk;
    lines.push({ text: normal(text.slice(start, end).replace(/\r$/, "")), start, next: brk === -1 ? text.length : brk + 1 });
    start = brk === -1 ? text.length : brk + 1;
  }
  return lines;
}

const blank = (line: Line | undefined): boolean => line !== undefined && line.text.trim() === "";
const endsWithColon = (text: string): boolean => /:\s*$/.test(text);

/**
 * How many lines the attribution at `index` spans (1 or 2), or 0 when there is
 * none there, and whether it names itself (`wrote`, `schrieb`, `a écrit`,
 * `写道`…). One that does not name itself is a line ending in a colon that
 * holds an address or a date; it counts only directly before `>` lines.
 */
function attributionAt(lines: readonly Line[], index: number): { readonly span: number; readonly named: boolean } {
  const line = lines[index]!.text;
  if (QUOTED_LINE.test(line) || line.trim() === "") return { span: 0, named: false };
  if (endsWithColon(line)) {
    if (ATTRIBUTION_PHRASE.test(line)) return { span: 1, named: true };
    if (ADDRESS.test(line) || DATE.test(line)) return { span: 1, named: false };
  }
  const following = lines[index + 1]?.text;
  if (following !== undefined && !endsWithColon(line) && !QUOTED_LINE.test(following) && endsWithColon(following)) {
    const joined = `${line} ${following}`;
    if (ATTRIBUTION_PHRASE.test(following)) return { span: 2, named: true };
    if (ADDRESS.test(joined) && DATE.test(joined)) return { span: 2, named: false };
  }
  return { span: 0, named: false };
}

/** Whether a reply header opens at `index`: a sender line with a date line and a subject line within the next five. */
function headerAt(lines: readonly Line[], index: number): boolean {
  if (!HEADER_FROM.test(lines[index]!.text)) return false;
  const window = lines.slice(index + 1, index + 6).map((line) => line.text);
  return window.some((text) => HEADER_SENT.test(text)) && window.some((text) => HEADER_SUBJECT.test(text));
}

/** The index just past the run of quoted lines (blank lines between them included) that starts at or after `from`. */
function quotedRunEnd(lines: readonly Line[], from: number): number {
  let last = -1;
  for (let index = from; index < lines.length; index += 1) {
    if (QUOTED_LINE.test(lines[index]!.text)) last = index;
    else if (!blank(lines[index])) break;
  }
  return last + 1;
}

/**
 * Whether the sender's own text, once split, still looks like it holds a
 * reply or a forward in a form the rules did not read. Language-independent
 * signals, so a client in any language fails safe:
 * - an attribution's or a forward's words (`wrote:` anywhere, a forward phrase);
 * - a line ending in a colon that holds an address or a date;
 * - two `Word: value` lines in a row, in any script (a header block);
 * - a line fenced by dashes or underscores around words;
 * - an address in angle brackets with a line right after it;
 * - HTML a client left in a plain-text part.
 */
function looksQuoted(own: string): boolean {
  const lines = own.split("\n").map(normal);
  const whole = lines.join("\n");
  if (/\bwrote\s*:/i.test(whole) || new RegExp(FORWARD_PHRASE, "i").test(whole) || HTML_QUOTE.test(whole)) return true;
  return lines.some((line, index) => {
    const next = lines[index + 1];
    if (endsWithColon(line) && (ATTRIBUTION_PHRASE.test(line) || ADDRESS.test(line) || DATE.test(line))) return true;
    if (FIELD_LINE.test(line) && next !== undefined && FIELD_LINE.test(next)) return true;
    if (FENCED_LINE.test(line)) return true;
    return BRACKETED_ADDRESS.test(line) && next !== undefined && next.trim() !== "";
  });
}

/**
 * The ranges of an email's plain text that are not the sender's own words
 * for `InboundEvent.quotedRanges`:
 * - a forward marker (`---------- Forwarded message ---------`,
 *   `-----Original Message-----`, `Begin forwarded message:`, and their
 *   German, French, Spanish and Chinese forms) starts a `forwarded` part that
 *   runs to the end;
 * - an attribution starts a `quoted` part: a line ending in a colon that says
 *   `wrote` (`schrieb`, `a écrit`, `写道`…), or holds an address or a date,
 *   on one line or wrapped over two. The `>` lines after it are the part; when
 *   none follow, a named attribution takes the rest of the message, as a
 *   top-posted reply quotes it;
 * - a reply header (`From:`/`Von:`/`De :`/`发件人：`, then a date and a
 *   subject line) starts a `quoted` part that runs to the end;
 * - any other run of `>` lines is a `quoted` part, so an interleaved reply
 *   keeps the sender's lines between its quotes.
 *
 * Fail safe: when what is left still looks like a reply or a forward
 * (`looksQuoted`), the whole text is one `unparsed` range. Empty text has none.
 */
export function splitEmailText(text: string): readonly InboundQuotedRange[] {
  if (text.trim() === "") return [];
  const lines = linesOf(text);
  const ranges: InboundQuotedRange[] = [];
  const add = (start: number, end: number, kind: InboundQuotedRange["kind"]) => {
    if (end <= start) return;
    const previous = ranges.at(-1);
    // Ranges apart only by blank text are one part.
    if (previous !== undefined && previous.kind === kind && text.slice(previous.end, start).trim() === "")
      ranges[ranges.length - 1] = { ...previous, end };
    else ranges.push({ start, end, kind });
  };
  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;
    if (FORWARD_MARKER.test(line.text)) {
      add(line.start, text.length, "forwarded");
      break;
    }
    const attribution = attributionAt(lines, index);
    if (attribution.span > 0) {
      let next = index + attribution.span;
      while (blank(lines[next])) next += 1;
      if (next < lines.length && QUOTED_LINE.test(lines[next]!.text)) {
        const end = quotedRunEnd(lines, next);
        add(line.start, lines[end - 1]!.next, "quoted");
        index = end;
        continue;
      }
      if (attribution.named) {
        // A top-posted reply that quotes without `>`: the rest is the earlier message.
        add(line.start, text.length, "quoted");
        break;
      }
    }
    if (headerAt(lines, index)) {
      add(line.start, text.length, "quoted");
      break;
    }
    if (QUOTED_LINE.test(line.text)) {
      const end = quotedRunEnd(lines, index);
      add(line.start, lines[end - 1]!.next, "quoted");
      index = end;
      continue;
    }
    index += 1;
  }
  if (looksQuoted(ownText(text, ranges))) return [{ start: 0, end: text.length, kind: "unparsed" }];
  return ranges;
}

/** `text` without `ranges`, its blank runs folded to one blank line and trimmed. */
function ownText(text: string, ranges: readonly InboundQuotedRange[]): string {
  let own = "";
  let at = 0;
  for (const range of ranges) {
    own += text.slice(at, range.start);
    at = range.end;
  }
  own += text.slice(at);
  return own
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n")
    .trim();
}

/** One part of an inbound message that is someone else's words (`inboundParts`). */
export interface InboundQuotedPart {
  readonly kind: InboundQuotedRange["kind"];
  readonly text: string;
}

/** A message read by its structure: the sender's own words, and what they quote or forward. */
export interface InboundSplit {
  /** The sender's own words: blank when the message is all forward, quote or unparsed. */
  readonly own: string;
  /** Someone else's words, at most one part a kind, in the order they first appear; blank parts left out. */
  readonly quoted: readonly InboundQuotedPart[];
}

/**
 * An inbound message's `content` split by the structure its connector
 * reported: a forward is all quoted; `quotedRanges`
 * cut their parts out of the sender's words. Ranges core cannot trust — out of
 * bounds, overlapping, out of order, not whole numbers — make the whole
 * message `unparsed`, as a message the splitter could not read is.
 * With neither, the whole content is the sender's, as before.
 */
export function inboundParts(event: Pick<InboundEvent, "content" | "forwarded" | "quotedRanges">): InboundSplit {
  const content = event.content ?? "";
  const whole = (kind: InboundQuotedRange["kind"]): InboundSplit => ({
    own: "",
    quoted: content.trim() === "" ? [] : [{ kind, text: content.trim() }],
  });
  if (event.forwarded !== undefined) return whole("forwarded");
  const ranges = event.quotedRanges;
  if (ranges === undefined || ranges.length === 0) return { own: content, quoted: [] };
  let at = 0;
  for (const range of ranges) {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < at ||
      range.end <= range.start ||
      range.end > content.length
    )
      return whole("unparsed");
    if (range.kind !== "quoted" && range.kind !== "forwarded" && range.kind !== "unparsed" && range.kind !== "attachment")
      return whole("unparsed");
    at = range.end;
  }
  if (ranges.some((range) => range.kind === "unparsed")) return whole("unparsed");
  const byKind = new Map<InboundQuotedRange["kind"], string[]>();
  for (const range of ranges) {
    const piece = content.slice(range.start, range.end).trim();
    if (piece === "") continue;
    byKind.set(range.kind, [...(byKind.get(range.kind) ?? []), piece]);
  }
  return {
    own: ownText(content, ranges),
    quoted: [...byKind].map(([kind, pieces]) => ({ kind, text: pieces.join("\n\n[…]\n\n") })),
  };
}
