import { isPersonMessage, type WorkflowMessage, MEMORY_SEMANTIC_QUERY_MAX_CHARS } from "@tavi/contracts";
import { parseTemporalQueryRange, queryExpansionFor, retrievalKeywordsFrom, type TemporalQueryRange } from "../context/retrieval-query.js";

/** Truncated conversation text used as the retrieval query for this model call. */
const MAX_CONTEXT_QUERY_CHARS = 512;

/**
 * Truncate to at most `maxChars` Unicode code points (not UTF-16 code
 * units), so an astral character (many emoji, some CJK extension
 * characters) straddling the cut is never split into a lone surrogate.
 */
function truncateAtCodePoint(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return Array.from(text).slice(0, maxChars).join("");
}

/**
 * Retrieval query for this model call: the most recent user turn's text.
 *
 * Restricted to the person's messages (`isPersonMessage`) rather than "the most recent non-empty
 * turn regardless of speaker" so that an assistant's own rationale or final
 * answer earlier in a tool-calling loop never becomes the query context
 * retrieval is built from.
 */
export function contextQueryFrom(conversation: readonly WorkflowMessage[]): string | undefined {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message !== undefined && isPersonMessage(message) && message.text.trim().length > 0) {
      return truncateAtCodePoint(message.text, MAX_CONTEXT_QUERY_CHARS);
    }
  }
  return undefined;
}

/** How much of the chat's recent turns the retrieval query reads. */
const RETRIEVAL_WINDOW_CHARS = 2_000;

/** The newest message of the person's share of that window. */
const RETRIEVAL_LATEST_CHARS = 1_200;

/**
 * The text the retrieval query is built from: the person's newest
 * message (up to `RETRIEVAL_LATEST_CHARS`), the one before it, and the
 * assistant's final answer to it — newest first, all within
 * `RETRIEVAL_WINDOW_CHARS`. Only a final answer (an assistant message with
 * no tool calls, before the person's newest message) is read, never the
 * running turn's rationale, so a tool round's chatter does not steer retrieval.
 * A notices block, a side chat's background or an epoch summary written as
 * data is no message of the person's: neither is read.
 */
export function retrievalWindowFrom(conversation: readonly WorkflowMessage[]): string | undefined {
  const latestIndex = conversation.findLastIndex((message) => isPersonMessage(message) && message.text.trim().length > 0);
  const latest = conversation[latestIndex];
  if (latest === undefined) return undefined;
  const parts = [truncateAtCodePoint(latest.text, RETRIEVAL_LATEST_CHARS)];
  const earlier = conversation.slice(0, latestIndex);
  const answer = earlier.findLast(
    (message) =>
      message.role === "assistant" && message.text.trim().length > 0 && (message.toolCalls === undefined || message.toolCalls.length === 0),
  );
  const previous = earlier.findLast((message) => isPersonMessage(message) && message.text.trim().length > 0);
  for (const message of [answer, previous]) {
    const used = parts.reduce((total, part) => total + part.length + 1, 0);
    if (message === undefined || used >= RETRIEVAL_WINDOW_CHARS) continue;
    parts.push(truncateAtCodePoint(message.text, RETRIEVAL_WINDOW_CHARS - used));
  }
  return parts.join("\n");
}

/**
 * The retrieval query: distinct keywords from `retrievalWindowFrom`,
 * newest first, at most `RETRIEVAL_KEYWORDS_MAX_TERMS` and the search's own 512
 * characters, matched as any of them (bm25 ranks the fuller matches first).
 * The query used to be the newest message's first 512 characters matched as
 * all of its words, so a sentence-long message rarely matched anything.
 * Bounded either way: one search, a capped term list.
 */
export function retrievalQueryFrom(conversation: readonly WorkflowMessage[]): string | undefined {
  const window = retrievalWindowFrom(conversation);
  if (window === undefined) return undefined;
  // The shared keyword builder: the same terms the idle review counts.
  const terms = retrievalKeywordsFrom(window);
  return terms.length === 0 ? undefined : terms.join(" ");
}

/** A turn's recall query: its keywords, and the person's newest message for hybrid recall. */
export interface TurnRetrievalQuery {
  readonly keywords: string;
  readonly semantic?: string;
  /** Ids already shown in this epoch's context delta (`WorkflowMessage.contextShown`), exempt from the floor and MMR drop. */
  readonly alreadyShownIds?: readonly string[];
  /** Deterministic temporal range parsed from the person's newest message, when present. */
  readonly range?: TemporalQueryRange;
}

const SHORT_FOLLOWUP_MAX_KEYWORDS = 3;
const SHORT_FOLLOWUP_MAX_CHARS = 60;

/**
 * The person's newest message, up to `MEMORY_SEMANTIC_QUERY_MAX_CHARS`: what
 * hybrid recall embeds on a turn. When that message has fewer than 3 keywords
 * or under 60 characters, the previous person message is appended after it
 * (newest first, within `MEMORY_SEMANTIC_QUERY_MAX_CHARS`). Only the owner's
 * hybrid wrapper reads it, and only with `retrieval: "hybrid"`.
 */
export function semanticQueryFrom(conversation: readonly WorkflowMessage[]): string | undefined {
  const latestIndex = conversation.findLastIndex((message) => isPersonMessage(message) && message.text.trim().length > 0);
  const latest = conversation[latestIndex];
  if (latest === undefined) return undefined;
  const trimmed = latest.text.trim();
  const isShortFollowUp =
    Array.from(trimmed).length < SHORT_FOLLOWUP_MAX_CHARS || retrievalKeywordsFrom(trimmed).length < SHORT_FOLLOWUP_MAX_KEYWORDS;
  if (!isShortFollowUp) {
    return truncateAtCodePoint(trimmed, MEMORY_SEMANTIC_QUERY_MAX_CHARS);
  }
  const previous = conversation.slice(0, latestIndex).findLast((message) => isPersonMessage(message) && message.text.trim().length > 0);
  const combined = previous === undefined ? trimmed : `${trimmed}\n${previous.text.trim()}`;
  return truncateAtCodePoint(combined, MEMORY_SEMANTIC_QUERY_MAX_CHARS);
}

/** The search's own bound on a query (`MemoryService.search`): the terms and their spaces. */
const RETRIEVAL_QUERY_MAX_CHARS = 512;

/**
 * `keywords` with `queryExpansionFor` the person's newest message after
 * them, within the search's 512 characters: "a quick dinner I could cook"
 * also asks for diet and allergy words, so lexical recall finds "I am
 * vegetarian". Only the newest message triggers it, never the assistant's
 * answer or an earlier turn. Under hybrid the words join bm25's half of
 * the fusion; the embedded text is unchanged.
 */
function withExpansion(keywords: string | undefined, latest: string | undefined): string | undefined {
  if (latest === undefined) return keywords;
  const seen = new Set(keywords === undefined ? [] : keywords.split(" "));
  let query = keywords ?? "";
  for (const word of queryExpansionFor(latest)) {
    if (seen.has(word)) continue;
    const next = query === "" ? word : `${query} ${word}`;
    if (next.length > RETRIEVAL_QUERY_MAX_CHARS) break;
    seen.add(word);
    query = next;
  }
  return query === "" ? undefined : query;
}

/**
 * The turn's recall query, or undefined when there is nothing to recall by.
 * Words with no keyword (a paraphrase) still carry the newest message
 * as `semantic`, with blank `keywords`: hybrid recall then ranks by meaning
 * alone, and lexical recall answers no hits, as before.
 */
export function turnRetrievalQueryFrom(
  conversation: readonly WorkflowMessage[],
  options: { readonly now?: string; readonly timeZone?: string } = {},
): TurnRetrievalQuery | undefined {
  const latest = conversation.findLast((message) => isPersonMessage(message) && message.text.trim().length > 0);
  const keywords = withExpansion(retrievalQueryFrom(conversation), latest?.text);
  const semantic = semanticQueryFrom(conversation);
  const range = latest === undefined ? undefined : parseTemporalQueryRange(latest.text, options.now, options.timeZone);
  const alreadyShownIds = [...new Set(conversation.flatMap((message) => message.contextShown ?? []))];
  const extras = {
    ...(alreadyShownIds.length === 0 ? {} : { alreadyShownIds }),
    ...(range === undefined ? {} : { range }),
  };
  if (keywords === undefined) return semantic === undefined ? undefined : { keywords: "", semantic, ...extras };
  return semantic === undefined ? { keywords, ...extras } : { keywords, semantic, ...extras };
}
