import {
  MAX_MEMORY_BODY_BYTES,
  MAX_MEMORY_KEYWORDS,
  MAX_MEMORY_KEYWORD_CHARS,
  MAX_MEMORY_TITLE_CHARS,
  MAX_PREFERENCE_KEY_CHARS,
  MAX_SOURCE_IDS,
  MAX_TOPIC_KEY_CHARS,
  MEMORY_AUTO_APPROVE_KIN_JACCARD,
  PREFERENCE_PRECEDENCE,
  TaviError,
  TimestampSchema,
  memoryTextSimilarity,
  memoryTokenSet,
  normaliseMemoryText,
  type MemoryRecord,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

/**
 * The memory service's rules that need no store: the bounds an input must
 * keep, when a record is current, how preferences rank by scope, and how a
 * caller's words become a full-text query.
 */

/** Documented maximum offset; well past any realistic page depth (bounded paging). */
const MAX_LIST_OFFSET = 1_000_000;

/** The most dimensions a hybrid query vector may have: past every embedding model in use. */
export const MAX_QUERY_VECTOR_DIMS = 8_192;
/** Words of a body the near-match search asks for, at most. */
export const NEAR_MATCH_QUERY_TOKENS = 64;

/**
 * The lexical query for a body's near match: its first
 * distinct words, any of them. None for a body without words. Shared by
 * capture's near-match drop and the queue's "similar to" hint.
 */
export function memoryNearMatchQuery(body: string): string | undefined {
  const tokens = [...memoryTokenSet(body)].slice(0, NEAR_MATCH_QUERY_TOKENS);
  return tokens.length === 0 ? undefined : toFtsPhraseQuery(tokens.join(" "), "any");
}

/** The candidates each list of hybrid recall ranks before fusion: four times the hits asked for, at least 40. */
export function hybridPool(limit: number): number {
  return Math.max(limit * 4, 40);
}

// `preferenceRank`'s fractional-offset scheme (below) is
// only correct because `"personal_agent"` and `"personal_workspace"` are
// ADJACENT entries in `PREFERENCE_PRECEDENCE` — a fact nothing else
// enforces. If that array is ever reordered (a new scope kind inserted
// between them, or an unrelated re-sort), the fractional rank would
// silently compute a wrong precedence with no other signal. Fails loudly,
// at module load, instead.
if (PREFERENCE_PRECEDENCE.indexOf("personal_agent") + 1 !== PREFERENCE_PRECEDENCE.indexOf("personal_workspace")) {
  throw new Error(
    "PREFERENCE_PRECEDENCE reordered: preferenceRank's fractional-offset scheme " +
      '(see its own doc comment) assumes "personal_agent" is immediately followed by ' +
      '"personal_workspace" — update preferenceRank to match the new order before shipping this change.',
  );
}

/**
 * Preference-resolution rank (lowest number wins): explicit current-task instruction (not a stored `MemoryScope`,
 * handled by the caller before this) → personal agent *within
 * workspace* → personal workspace → personal agent (workspace-agnostic)
 * → personal → shared-workspace default.
 *
 * `PREFERENCE_PRECEDENCE` alone can't express this: "personal agent
 * within workspace" and "personal agent" are the SAME
 * `MemoryScopeKind` ("personal_agent"), split into two precedence tiers
 * by whether `scope.workspaceId` is present — not two different kinds.
 * The workspace-scoped variant ranks strictly above `personal_workspace`
 * and the workspace-agnostic variant strictly below it, so the more
 * specific one wins rather than a collision surfacing as an unresolved
 * conflict.
 */
export function preferenceRank(scope: MemoryRecord["scope"]): number {
  if (scope.kind === "personal_agent" && scope.workspaceId === undefined) {
    // Workspace-agnostic: ranked BELOW `personal_workspace`
    // (and above `personal`) — a fractional rank between their two
    // fixed slots, leaving `PREFERENCE_PRECEDENCE`'s own "personal_agent"
    // slot for the workspace-scoped variant below.
    return PREFERENCE_PRECEDENCE.indexOf("personal_workspace") + 0.5;
  }
  // Workspace-scoped `personal_agent` naturally lands at
  // `PREFERENCE_PRECEDENCE`'s "personal_agent" slot, which already sits
  // between `run_local` and `personal_workspace` — exactly where
  // "personal agent within workspace" ranks.
  return PREFERENCE_PRECEDENCE.indexOf(scope.kind);
}

export function isCurrent(record: MemoryRecord, now: string): boolean {
  if (record.status !== "approved") return false;
  if (record.validFrom !== undefined && record.validFrom > now) return false;
  if (record.validTo !== undefined && record.validTo <= now) return false;
  if (record.expiryAt !== undefined && record.expiryAt <= now) return false;
  return true;
}

/**
 * Bounds for a proposed or corrected record: an
 * 8 KiB UTF-8 body, a 200-character title, a 120-character preference key,
 * at most 64 source ids, and well-formed observed/expiry timestamps. Every
 * one of these is a case where storing the value would make a later read
 * throw instead of the write itself refusing it.
 */
export function validateBounds(input: {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly preferenceKey?: string | undefined;
  readonly topicKey?: string | undefined;
  readonly keywords?: readonly string[] | undefined;
  readonly sourceIds?: readonly string[] | undefined;
  readonly observedAt?: string | undefined;
  readonly expiryAt?: string | undefined;
  readonly validTo?: string | undefined;
}): void {
  if (input.body !== undefined && Buffer.byteLength(input.body, "utf8") > MAX_MEMORY_BODY_BYTES) {
    throw new TaviError("INVALID_INPUT", `Memory body exceeds ${MAX_MEMORY_BODY_BYTES} UTF-8 bytes`);
  }
  if (input.title !== undefined && input.title.length > MAX_MEMORY_TITLE_CHARS) {
    throw new TaviError("INVALID_INPUT", `Memory title exceeds ${MAX_MEMORY_TITLE_CHARS} characters`);
  }
  if (input.preferenceKey !== undefined && input.preferenceKey.length > MAX_PREFERENCE_KEY_CHARS) {
    throw new TaviError("INVALID_INPUT", `Preference key exceeds ${MAX_PREFERENCE_KEY_CHARS} characters`);
  }
  if (input.topicKey !== undefined && (input.topicKey.length === 0 || input.topicKey.length > MAX_TOPIC_KEY_CHARS)) {
    throw new TaviError(
      "INVALID_INPUT",
      input.topicKey.length === 0 ? "Topic key must not be empty" : `Topic key exceeds ${MAX_TOPIC_KEY_CHARS} characters`,
    );
  }
  if (input.keywords !== undefined) {
    if (input.keywords.length > MAX_MEMORY_KEYWORDS) {
      throw new TaviError("INVALID_INPUT", `A memory revision accepts at most ${MAX_MEMORY_KEYWORDS} keywords`);
    }
    for (const keyword of input.keywords) {
      const trimmed = keyword.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_MEMORY_KEYWORD_CHARS) {
        throw new TaviError(
          "INVALID_INPUT",
          trimmed.length === 0 ? "Memory keyword must not be empty" : `Memory keyword exceeds ${MAX_MEMORY_KEYWORD_CHARS} characters`,
        );
      }
    }
  }
  if (input.sourceIds !== undefined && input.sourceIds.length > MAX_SOURCE_IDS) {
    throw new TaviError("INVALID_INPUT", `A memory record accepts at most ${MAX_SOURCE_IDS} source ids`);
  }
  if (input.observedAt !== undefined && !TimestampSchema.safeParse(input.observedAt).success) {
    throw new TaviError("INVALID_INPUT", "observedAt must be an ISO 8601 timestamp");
  }
  if (input.expiryAt !== undefined && !TimestampSchema.safeParse(input.expiryAt).success) {
    throw new TaviError("INVALID_INPUT", "expiryAt must be an ISO 8601 timestamp");
  }
  if (input.validTo !== undefined && !TimestampSchema.safeParse(input.validTo).success) {
    throw new TaviError("INVALID_INPUT", "validTo must be an ISO 8601 timestamp");
  }
}

/**
 * `forget`/`revoke` reasons are operator-facing audit text, not free-form
 * logging. `forget`'s reason is persisted in the deletion journal;
 * `revoke`'s is validated here but not yet stored anywhere —
 * `applyLifecycle` has no reason field — so it is not recoverable later.
 * Validating it now still catches a blank/oversized value at the boundary
 * rather than accepting it silently; recording it is a follow-up.
 */
export function validateReason(reason: string): void {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new TaviError("INVALID_INPUT", "A reason is required and must not be blank");
  }
  if (trimmed.length > 500) {
    throw new TaviError("INVALID_INPUT", "A reason must be at most 500 characters");
  }
}

/** `list`'s `offset` gets the same integer/bound discipline `limit` already has. */
export function validateOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_LIST_OFFSET) {
    throw new TaviError("INVALID_INPUT", `offset must be an integer between 0 and ${MAX_LIST_OFFSET}`);
  }
  return offset;
}

/** Bound a caller-supplied page size into the documented range. */
export function bound(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1) return Math.min(1, max);
  return Math.min(value, max);
}

/** True when any of `sourceIds` names a currently-revoked evidence source. */
export function citesRevokedSource(sourceIds: readonly string[] | undefined, revoked: ReadonlySet<string>): boolean {
  return sourceIds !== undefined && sourceIds.some((id) => revoked.has(id));
}

/**
 * Quote each token as its own FTS5 phrase, so a caller's `"`, `*` or `NEAR(`
 * is a literal rather than query syntax — without changing match semantics.
 * Quoting the *whole* query would turn it into one exact-adjacency phrase and
 * silently drop ordinary matches where the terms appear out of order or
 * apart (e.g. "Lisbon Alice" would stop matching "Alice moved to Lisbon");
 * quoting per token keeps FTS5's default implicit-AND across terms while
 * still defanging syntax characters inside each one. FTS5 escapes an
 * embedded `"` by doubling it inside a quoted string. `any` joins the
 * phrases with `OR` instead.
 */
export function toFtsPhraseQuery(query: string, match: "all" | "any" = "all"): string {
  return (
    query
      .replace(/(?:'|’)(?:s|t|re|ve|ll|d|m)\b|n(?:'|’)t\b/giu, "")
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map((token) => `"${token.replaceAll('"', '""')}"`)
      // `any`: a hit holds at least one term; bm25 still ranks the fuller matches first.
      .join(match === "any" ? " OR " : " ")
  );
}

/**
 * True when `error` is the SQLite UNIQUE violation for the one-active-preference
 * index. better-sqlite3 reports the violated columns, not the index name:
 * `UNIQUE constraint failed: tavi_memory_records.scope_key, tavi_memory_records.preference_key`.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes("tavi_memory_records.preference_key")
  );
}

/** Content hash over the fields a review approves. */
/**
 * A structured encoding rather than a delimiter-joined string: a review binds
 * this hash, so an ambiguous pre-image (a title/body pair that could collide
 * with a different pair at the join point) would weaken that binding.
 * `JSON.stringify` escapes any character either field could contain.
 */
export function hashContent(title: string | undefined, body: string | undefined): string {
  return sha256Hex(JSON.stringify([title ?? null, body ?? null])).slice(0, 32);
}

const FACT_NUMBER_TOKEN = /\b\d+(?:[.,:/-]\d+)*\b/g;
/** Small number words, read as their digits so "2" and "two" are the same value. */
const FACT_NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};
const FACT_NUMBER_WORD = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi;
const FACT_DATE_WORD =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi;
/** Date words that are also everyday English ("may", "sat", "sun", "mar"): a date only beside a digit. */
const FACT_AMBIGUOUS_DATE_WORD = new Set(["may", "sat", "sun", "mar"]);
const FACT_DIGIT_BEFORE = /\d(?:st|nd|rd|th)?(?:\s+of)?[\s,]*$/i;
const FACT_DIGIT_AFTER = /^\.?[\s,]*\d/;
const FACT_NEGATION =
  /\b(?:not|no|never|none|neither|nor|without|nobody|nowhere|stopped|quit|dont|doesnt|didnt|wont|cant|cannot|isnt|arent|wasnt|werent|hasnt|havent|hadnt)\b|n(?:'|’)t\b/iu;
const FACT_PROPER_NOUN = /(?<![\p{L}\p{N}_])\p{Lu}[\p{L}\p{N}_'-]*(?![\p{L}\p{N}_])/gu;
/** A sentence's first word: capitalised by grammar, not because it names anything. */
const FACT_SENTENCE_START = /(?:^|[.!?]\s+|\n\s*)$/u;

function sameTokenSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

function factNumbers(text: string): ReadonlySet<string> {
  const numbers = new Set(text.match(FACT_NUMBER_TOKEN) ?? []);
  for (const word of text.match(FACT_NUMBER_WORD) ?? []) {
    const digits = FACT_NUMBER_WORDS[word.toLowerCase()];
    if (digits !== undefined) numbers.add(digits);
  }
  return numbers;
}

function factDates(text: string): ReadonlySet<string> {
  const dates = new Set<string>();
  for (const match of text.matchAll(FACT_DATE_WORD)) {
    const word = match[0].toLowerCase();
    const at = match.index ?? 0;
    if (
      FACT_AMBIGUOUS_DATE_WORD.has(word) &&
      !FACT_DIGIT_BEFORE.test(text.slice(0, at)) &&
      !FACT_DIGIT_AFTER.test(text.slice(at + match[0].length))
    ) {
      continue;
    }
    dates.add(word);
  }
  return dates;
}

/** Capitalised words of `text` past each sentence's first word, case-folded. */
function factProperNouns(text: string): readonly string[] {
  const nouns: string[] = [];
  for (const match of text.matchAll(FACT_PROPER_NOUN)) {
    if (FACT_SENTENCE_START.test(text.slice(0, match.index ?? 0))) continue;
    nouns.push(normaliseMemoryText(match[0]));
  }
  return nouns;
}

/** True when some proper noun of `text` is not a word of `other` in any case. */
function properNounMissing(text: string, other: string): boolean {
  const otherTokens = memoryTokenSet(other);
  return factProperNouns(text).some((noun) => [...memoryTokenSet(noun)].some((token) => !otherTokens.has(token)));
}

/**
 * True when two facts differ in their numbers (small number words read as
 * digits), dates, negation polarity, or (when they share words) a
 * capitalised proper noun the other text lacks in any case, so a near match
 * is a possible value update rather than a redundant paraphrase. A sentence's
 * first word is not a proper noun, and "may", "sat", "sun", "mar" are dates
 * only beside a digit.
 */
export function factValuesDiffer(left: string, right: string): boolean {
  if (!sameTokenSet(factNumbers(left), factNumbers(right))) return true;

  if (!sameTokenSet(factDates(left), factDates(right))) return true;

  if (FACT_NEGATION.test(left) !== FACT_NEGATION.test(right)) return true;

  if (memoryTextSimilarity(left, right) >= MEMORY_AUTO_APPROVE_KIN_JACCARD) {
    // A value changed when each side names one the other lacks ("Lisbon" / "Porto");
    // one side naming more ("Lisbon" / "Lisbon, Portugal") only adds detail.
    if (properNounMissing(left, right) && properNounMissing(right, left)) return true;
  }

  return false;
}

const VOWEL = /[aeiou]/;
const STEP2_SUFFIXES: readonly (readonly [string, string])[] = [
  ["ational", "ate"],
  ["tional", "tion"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["izer", "ize"],
  ["abli", "able"],
  ["bli", "ble"],
  ["alli", "al"],
  ["entli", "ent"],
  ["eli", "e"],
  ["ousli", "ous"],
  ["ization", "ize"],
  ["ation", "ate"],
  ["ator", "ate"],
  ["alism", "al"],
  ["iveness", "ive"],
  ["fulness", "ful"],
  ["ousness", "ous"],
  ["aliti", "al"],
  ["iviti", "ive"],
  ["biliti", "ble"],
  ["logi", "log"],
];
const STEP3_SUFFIXES: readonly (readonly [string, string])[] = [
  ["icate", "ic"],
  ["ative", ""],
  ["alize", "al"],
  ["iciti", "ic"],
  ["ical", "ic"],
  ["ful", ""],
  ["ness", ""],
];
const STEP4_SUFFIXES = [
  "al",
  "ance",
  "ence",
  "er",
  "ic",
  "able",
  "ible",
  "ant",
  "ement",
  "ment",
  "ent",
  "ion",
  "ou",
  "ism",
  "ate",
  "iti",
  "ous",
  "ive",
  "ize",
] as const;

function isConsonant(word: string, index: number): boolean {
  const ch = word[index];
  if (ch === undefined) return false;
  if (VOWEL.test(ch)) return false;
  if (ch === "y") return index === 0 ? true : !isConsonant(word, index - 1);
  return true;
}

function measure(stem: string): number {
  let m = 0;
  let inVowel = false;
  for (let i = 0; i < stem.length; i += 1) {
    if (isConsonant(stem, i)) {
      if (inVowel) {
        m += 1;
        inVowel = false;
      }
    } else {
      inVowel = true;
    }
  }
  return m;
}

function hasVowel(stem: string): boolean {
  for (let i = 0; i < stem.length; i += 1) {
    if (!isConsonant(stem, i)) return true;
  }
  return false;
}

function endsWithDoubleConsonant(stem: string): boolean {
  if (stem.length < 2) return false;
  if (stem[stem.length - 1] !== stem[stem.length - 2]) return false;
  return isConsonant(stem, stem.length - 1);
}

function endsCvc(stem: string): boolean {
  if (stem.length < 3) return false;
  const last = stem[stem.length - 1]!;
  if (last === "w" || last === "x" || last === "y") return false;
  return isConsonant(stem, stem.length - 1) && !isConsonant(stem, stem.length - 2) && isConsonant(stem, stem.length - 3);
}

/**
 * Standard Martin Porter (1980) English stemmer, matching SQLite FTS5's
 * `porter` tokenizer for ASCII word tokens.
 */
function porterStem(raw: string): string {
  let word = raw.toLowerCase();
  if (word.length < 3 || !/^[a-z]+$/.test(word)) return word;

  // Step 1a
  if (word.endsWith("sses")) word = word.slice(0, -2);
  else if (word.endsWith("ies")) word = word.slice(0, -2);
  else if (!word.endsWith("ss") && word.endsWith("s")) word = word.slice(0, -1);

  // Step 1b
  let step1bSecond = false;
  if (word.endsWith("eed")) {
    const stem = word.slice(0, -3);
    if (measure(stem) > 0) word = `${stem}ee`;
  } else if (word.endsWith("ed")) {
    const stem = word.slice(0, -2);
    if (hasVowel(stem)) {
      word = stem;
      step1bSecond = true;
    }
  } else if (word.endsWith("ing")) {
    const stem = word.slice(0, -3);
    if (hasVowel(stem)) {
      word = stem;
      step1bSecond = true;
    }
  }
  if (step1bSecond) {
    if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) {
      word = `${word}e`;
    } else if (endsWithDoubleConsonant(word) && !/[lsz]$/.test(word)) {
      word = word.slice(0, -1);
    } else if (measure(word) === 1 && endsCvc(word)) {
      word = `${word}e`;
    }
  }

  // Step 1c
  if (word.endsWith("y")) {
    const stem = word.slice(0, -1);
    if (hasVowel(stem)) word = `${stem}i`;
  }

  // Step 2
  for (const [suffix, replacement] of STEP2_SUFFIXES) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (measure(stem) > 0) word = `${stem}${replacement}`;
      break;
    }
  }

  // Step 3
  for (const [suffix, replacement] of STEP3_SUFFIXES) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (measure(stem) > 0) word = `${stem}${replacement}`;
      break;
    }
  }

  // Step 4
  for (const suffix of STEP4_SUFFIXES) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (suffix === "ion") {
        if (measure(stem) > 1 && /[st]$/.test(stem)) word = stem;
      } else if (measure(stem) > 1) {
        word = stem;
      }
      break;
    }
  }

  // Step 5a
  if (word.endsWith("e")) {
    const stem = word.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !endsCvc(stem))) word = stem;
  }

  // Step 5b
  if (word.endsWith("ll") && measure(word) > 1) {
    word = word.slice(0, -1);
  }

  return word;
}

function foldDiacriticsAndClitics(text: string): string {
  return text
    .replace(/(?:'|’)(?:s|t|re|ve|ll|d|m)\b|n(?:'|’)t\b/giu, "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC")
    .toLowerCase();
}

export interface ParsedQueryTerm {
  readonly raw: string;
  readonly key: string;
  readonly tokens: readonly { readonly exact: string; readonly stem: string }[];
}

/**
 * Distinct query terms from `query`, each broken into its `unicode61` tokens
 * and their Porter stems so `MemoryReads.search` can compute `matchedTerms`
 * across exact and stemmed words.
 */
export function memoryQueryTerms(query: string): readonly ParsedQueryTerm[] {
  const seen = new Set<string>();
  const terms: ParsedQueryTerm[] = [];
  for (const part of query.trim().split(/\s+/)) {
    if (part === "") continue;
    const rawTokens = foldDiacriticsAndClitics(part)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token !== "");
    if (rawTokens.length === 0) continue;
    const tokens = rawTokens.map((exact) => ({ exact, stem: porterStem(exact) }));
    const key = tokens.map((token) => token.stem).join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({ raw: part, key, tokens });
  }
  return terms;
}

/** Set of both exact tokens and Porter stems in `text` (diacritic-folded, clitics stripped). */
export function memoryExactAndStemSet(text: string): ReadonlySet<string> {
  const set = new Set<string>();
  for (const exact of foldDiacriticsAndClitics(text).split(/[^\p{L}\p{N}]+/u)) {
    if (exact === "") continue;
    set.add(exact);
    set.add(porterStem(exact));
  }
  return set;
}

/** True when every token of `term` matches `tokenSet` by exact form or Porter stem. */
export function memoryTermMatchesSet(term: ParsedQueryTerm, tokenSet: ReadonlySet<string>): boolean {
  return term.tokens.length > 0 && term.tokens.every((token) => tokenSet.has(token.exact) || tokenSet.has(token.stem));
}

/**
 * Text shaped like a prompt injection rather than a lesson about the person:
 * an order to ignore or override instructions, a "system instruction", or a
 * link. Such a record is kept out of the always-present profile, where every
 * turn would carry it; search still finds it, as untrusted evidence. Narrow on
 * purpose: "end every reply with a summary" is a lesson, not an attack.
 */
const DIRECTIVE_SHAPES: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}\b(?:instructions?|rules|prompts?|guidelines|guardrails)\b/iu,
  /\bsystem\s+(?:instructions?|prompts?|overrides?|messages?)\b/iu,
  /\b(?:https?:\/\/|www\.)\S+/iu,
  /\b[a-z0-9-]+\.(?:com|net|org|io|xyz|example|info|biz|click|top)\b/iu,
];

export function memoryReadsAsDirective(...texts: readonly (string | undefined)[]): boolean {
  const text = texts.filter((part): part is string => part !== undefined).join("\n");
  return DIRECTIVE_SHAPES.some((shape) => shape.test(text));
}
