import {
  memoryProvenanceUntrusted,
  redactToolText,
  type MemoryActor,
  type MemoryProposeOutcome,
  type MemoryProvenance,
  type MemoryRecord,
  type MemoryRevision,
  type MemorySensitiveMode,
  type MemoryServicePort,
} from "@tavi/contracts";

/**
 * The capture pipeline: what automatic capture — the epoch flush, the idle
 * review — does with each draft between the model's answer and the review
 * queue. Every step drops rather than files, so a draft that fails one never
 * becomes a card.
 *
 * **Dedup.** A draft is filed through `MemoryService.propose`
 * with `nearMatch: "drop"`: the service answers a draft whose normalised
 * content a pending proposal or a record in force already holds with that
 * record (`known: "exact"`), and, for capture only, one whose body is a near
 * match of the top lexical hit in its scope (`known: "near"`), writing
 * nothing either way. Only pending and current records are compared, so an
 * ended fact said again is filed as new. A person's own `memory.propose` is
 * not capture: a near match is filed there, with a "similar to" hint.
 *
 * **Secrets and sensitive topics.** Before dedup, a draft
 * carrying a key-shaped secret (a shape `redactToolText` masks) or a stated
 * password or PIN is dropped, whatever the settings. A draft the model marked sensitive, or that the
 * host's category list below matches, follows the workspace's `sensitive`
 * setting: dropped under `"skip"` (the default), filed with `sensitivity:
 * "sensitive"` under `"suggest"` — so it is masked on every card, the
 * terminal and the digest, and never recalled automatically. The setting
 * governs automatic capture only: a `memory.propose` the person asked for is
 * filed either way, marked sensitive when the list matches.
 */

/**
 * The host's sensitive categories: special-category data in the GDPR's
 * sense, money, account numbers and government ids, and where the person lives. Whole words, English
 * only, matched over a draft's title, body, topic key and preference key and value; a
 * miss falls back to the model's own mark, which the extractor prompt and the
 * tool's guidance ask for (others' private details, in particular, are left
 * to it: no word list finds them).
 */
const SENSITIVE_TOPICS: readonly { readonly topic: SensitiveTopic; readonly pattern: RegExp }[] = [
  {
    topic: "health",
    pattern:
      /\b(?:health (?:conditions?|issues?|problems?)|health(?=\.[a-z])|medical|medic(?:ation|ine)s?|diagnos(?:is|ed|es)|illness(?:es)?|sick(?:ness)?|diseases?|syndromes?|symptoms? of|chronic|cancer|tumou?rs?|diabet(?:es|ic)|asthma(?:tic)?|allerg(?:y|ies|ic)|epilep(?:sy|tic)|migraines?|hiv|pregnan(?:t|cy)|miscarriages?|surger(?:y|ies)|prescri(?:bed|ption)s?|therap(?:y|ies|ists?)|psychiatr(?:y|ists?|ic)|mental(?:ly)? (?:health|ill)|depress(?:ion|ed)|anxiety|antidepressants?|adhd|autis(?:m|tic)|bipolar|ocd|ptsd|eating disorders?|anorexi[ac]|bulimi[ac]|addict(?:ion|ed)|rehab|disabilit(?:y|ies)|blood (?:type|pressure|sugar|test)|insulin|vaccinat(?:ed|ion)|(?:a|my|his|her|their|our|your|family) doctors?|doctors|hospitals?|hospitali[sz]ed)\b/i,
  },
  {
    topic: "sex-life",
    pattern:
      /\b(?:sexual(?:ity| orientation| health| life)?|sex life|gay|lesbian|bisexual|transgender|trans (?:man|woman)|queer|lgbtq?|asexual|non-binary|nonbinary)\b/i,
  },
  {
    topic: "beliefs",
    pattern:
      /\b(?:religio(?:n|us)|church(?:es)?|mosques?|synagogues?|pray(?:s|ed|ing|ers?)?|christianity|catholics?|protestants?|muslims?|islam(?:ic)?|jews?|jewish|judaism|hindu(?:s|ism)?|buddhis(?:ts?|m)|sikhs?|atheis(?:ts?|m)|agnostic|spiritual(?:ity)?)\b/i,
  },
  {
    topic: "politics",
    pattern:
      /\b(?:politics|political (?:part(?:y|ies)|views?|beliefs?|affiliation)|vot(?:e|es|ed|ing) (?:for|against)|democrat(?:s|ic)?|republicans?|labour party|tory|tories|socialists?|communists?|libertarians?|left-wing|right-wing|liberal party|conservative party|green party|activists?)\b/i,
  },
  { topic: "ethnicity", pattern: /\b(?:ethnic(?:ity)?|racial(?:ly)?|immigration status|refugees?|asylum)\b/i },
  { topic: "union", pattern: /\b(?:trade union|labou?r union|union member(?:ship)?|union dues)\b/i },
  {
    topic: "money",
    pattern:
      /\b(?:salary|salaries|income tax|wages?|(?<!technical )debts?|loans?|mortgages?|credit score|bankrupt(?:cy)?|net worth|(?<!cost )savings|tax returns?|pensions?)\b/i,
  },
  {
    topic: "identifiers",
    pattern:
      /\b(?:account number|routing number|sort code|iban|swift code|card number|cvv|pin code|passport number|social security|ssn|national insurance|tax (?:id|number)|driver'?s licen[cs]e(?: number)?)\b|\b\d{3}-\d{2}-\d{4}\b/i,
  },
  // Where the person lives: a home address or a precise spot, not a city.
  {
    topic: "location",
    // "Lives at" only as a person's: a fact's own opening, or after a personal pronoun, so "the config lives at ~/.tavi" is not one.
    pattern:
      /\b(?:me\.home_area|home (?:address|postcode|post code|zip(?: code)?)|street address|my (?:gps )?coordinates)\b|(?:^|[.!?]\s+|\b(?:i|we|he|she|they|who)\s+)(?:lives?|living|resides?|residing) at\b/im,
  },
  // An IBAN: case-sensitive, so lowercase hex that starts with two letters and two digits is not one.
  { topic: "identifiers", pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/ },
];

/** A category of the host's sensitive list. */
export type SensitiveTopic = "health" | "sex-life" | "beliefs" | "politics" | "ethnicity" | "union" | "money" | "identifiers" | "location";

/** Digits only, 13 to 19 of them, passing the Luhn check: a payment card number, however it is spaced. */
function holdsCardNumber(text: string): boolean {
  for (const match of text.matchAll(/\b\d(?:[ -]?\d){12,18}\b/g)) {
    const digits = match[0].replace(/[ -]/g, "");
    let sum = 0;
    for (let index = 0; index < digits.length; index += 1) {
      let digit = Number(digits[digits.length - 1 - index]);
      if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
      sum += digit;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** The first sensitive category `texts` touch, or undefined. */
export function sensitiveTopicOf(texts: readonly (string | undefined)[]): SensitiveTopic | undefined {
  const text = texts.filter((part): part is string => part !== undefined).join("\n");
  if (text === "") return undefined;
  for (const { topic, pattern } of SENSITIVE_TOPICS) if (pattern.test(text)) return topic;
  return holdsCardNumber(text) ? "identifiers" : undefined;
}

/** A stated password: a password, passcode or passphrase word, then `:`, `=` or "is", then a value. */
const STATED_PASSWORD = /\b(?:password|passcode|passphrase)s?\s*(?:[:=]|\bis\b)\s*\S/i;
/** The same for a PIN, upper case only, so the verb "pin" (a dependency, a tab) is not one. */
const STATED_PIN = /\bPINs?\s*(?:[:=]|\b[Ii]s\b)\s*\S/;

/**
 * Whether any of `texts` holds a key-shaped secret (`redactToolText` would
 * mask it) or a stated password or PIN: such a draft is never filed.
 * Generic key names such as "token" are not read, since memories
 * mention `max_tokens: 4096` and design tokens.
 */
export function holdsSecret(texts: readonly (string | undefined)[]): boolean {
  return texts.some(
    (text) => text !== undefined && (redactToolText(text).masked.length > 0 || STATED_PASSWORD.test(text) || STATED_PIN.test(text)),
  );
}

/** A draft's words the two checks read: its title, body, topic key, keywords, and a preference's key and value. */
function draftTexts(
  draft: Pick<Parameters<MemoryServicePort["propose"]>[0], "title" | "body" | "preferenceKey" | "topicKey" | "preference" | "keywords">,
): readonly (string | undefined)[] {
  const value = draft.preference?.value;
  return [
    draft.title,
    draft.body,
    draft.topicKey,
    draft.preferenceKey,
    typeof value === "string" ? value : value === undefined ? undefined : JSON.stringify(value),
    ...(draft.keywords ?? []),
  ];
}

/** What filing one draft came to: the proposal filed, or why nothing was. */
export type CaptureOutcome =
  | { readonly filed: true; readonly record: MemoryProposeOutcome }
  /** Dedup: the record already holding it. */
  | { readonly filed: false; readonly dropped: "known" | "similar"; readonly record: MemoryProposeOutcome }
  /** Never sent to the service: nothing was written. */
  | { readonly filed: false; readonly dropped: "secret" | "sensitive" };

/** Drafts automatic capture dropped, by reason, for the run's log line (never their text). */
export interface CaptureDropCounts {
  readonly secret: number;
  readonly sensitive: number;
  readonly known: number;
  readonly similar: number;
}

/** No drafts dropped yet. */
export const NO_CAPTURE_DROPS: CaptureDropCounts = { secret: 0, sensitive: 0, known: 0, similar: 0 };

/**
 * File one captured draft as a proposal, under the secret, sensitive-topic,
 * dedup and near-match rules above. `sensitive` is the workspace's setting;
 * absent, `"skip"` (the default). A tidy-up passes
 * `nearMatch: false`: its replacement is meant to resemble the records it
 * supersedes, so only exact dedup applies (and never against its inputs).
 */
export async function fileCapturedDraft(
  memory: Pick<MemoryServicePort, "propose">,
  draft: Omit<Parameters<MemoryServicePort["propose"]>[0], "nearMatch">,
  sensitive: MemorySensitiveMode = "skip",
  options: { readonly nearMatch?: boolean } = {},
): Promise<CaptureOutcome> {
  const texts = draftTexts(draft);
  if (holdsSecret(texts)) return { filed: false, dropped: "secret" };
  const marked = draft.sensitivity === "sensitive" || sensitiveTopicOf(texts) !== undefined;
  if (marked && sensitive === "skip") return { filed: false, dropped: "sensitive" };
  // A marked draft never asks for the near-match drop: under hybrid that would embed it (invariants 7/14); exact dedup still applies.
  const record = await memory.propose({
    ...draft,
    ...(marked ? { sensitivity: "sensitive" as const } : {}),
    ...(options.nearMatch === false || marked ? {} : { nearMatch: "drop" as const }),
  });
  if (record.known === "exact") return { filed: false, dropped: "known", record };
  if (record.known === "near") return { filed: false, dropped: "similar", record };
  return { filed: true, record };
}

/**
 * Auto-approve: the operator's standing decision to keep some kinds without
 * asking. Opt-in per kind (`autoApprove`), and only for a proposal of the
 * operator's own, attended, untainted, non-messaging turn or idle review —
 * never a worker's, the flush's, consolidation's or a bound channel user's —
 * whose words the person typed (the host's quote check below), whose preference
 * key is not reserved, and that is not sensitive, an update, a near match or
 * akin to a kept record of its kind (a likely contradiction: "Lives in Berlin"
 * beside a kept "Lives in Lisbon"). Anything else stays proposed: every refusal
 * fails safe into an ordinary card.
 */

/**
 * Preference-key words auto-approve never keeps: no code acts on a
 * preference key today, so this is defence in depth — such a record would
 * read to the model like policy. Fixed in code; extended by the step that
 * first lets code act on a key.
 */
export const MEMORY_RESERVED_PREFERENCE_WORDS = ["auth", "payment", "channel", "exec", "credential"] as const;

/**
 * Whether `key` is a reserved preference key: any of its segments (split on
 * `.`, `_`, `-`, `/`, `:`) is a reserved word or its plural, case-folded
 * after NFKC and with format characters (zero-width ones) taken out — so
 * `payment`, `payments.card`, `payment_method` and `tools.exec.allow` all
 * are. A key holding anything but printable ASCII is reserved too: a
 * lookalike letter from another script reads the same to a person and to
 * the model.
 */
export function isReservedPreferenceKey(key: string | undefined): boolean {
  if (key === undefined) return false;
  if (/[^\x20-\x7e]/.test(key)) return true;
  const folded = key
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .trim()
    .toLowerCase();
  return folded
    .split(/[._\-/:\s]+/)
    .some((segment) => MEMORY_RESERVED_PREFERENCE_WORDS.some((word) => segment === word || segment === `${word}s`));
}

/** The share of a body's content words one person message must hold. */
export const MEMORY_QUOTE_CHECK_SHARE = 0.8;

/** A list item's markers (`-`, `*`, `+`, `1.`, `1)`), any number deep, before a quote or a fence. */
const LIST_MARKERS = String.raw`(?:(?:[-*+]|\d{1,9}[.)])\s+)*`;
const FENCE_OPENER = new RegExp(String.raw`^\s*${LIST_MARKERS}(\`{3,}|~{3,})`);
const QUOTED_LINE = new RegExp(String.raw`^\s*${LIST_MARKERS}>`);

/**
 * What the person typed in `message`: lines quoted with `>` (in a
 * list item too), fenced code (``` or ~~~, opened in a list item too),
 * indented code (four spaces or a tab), HTML `<blockquote>`, `<pre>` and
 * `<code>`, inline code, and spans inside quotation marks — double ones
 * (straight, curly, fullwidth or double-prime, low-opening, guillemets),
 * curly single ones, and straight single ones of three words or more — are
 * taken out: that is usually pasted from elsewhere. An unclosed HTML span or
 * backtick runs to the end, so it is taken out too.
 */
export function personTypedText(message: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of message.replace(/\r\n?/g, "\n").split("\n")) {
    const opener = FENCE_OPENER.exec(line);
    if (fence !== undefined) {
      if (opener?.[1]?.startsWith(fence) === true) fence = undefined;
      continue;
    }
    if (opener?.[1] !== undefined) {
      fence = opener[1].slice(0, 3);
      continue;
    }
    if (QUOTED_LINE.test(line) || /^(?: {4}|\t)/.test(line)) continue;
    kept.push(line);
  }
  return (
    kept
      .join("\n")
      .replace(/<(blockquote|pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
      .replace(/(`+)[\s\S]*?(?:\1|$)/g, " ")
      .replace(/"[^"]*"/g, " ")
      .replace(/“[^”]*”/g, " ")
      .replace(/＂[^＂]*＂/g, " ")
      .replace(/″[^″]*″/g, " ")
      // A low opening quote („…“ or „…”) and guillemets count too.
      .replace(/„[^“”"]*[“”"]/g, " ")
      .replace(/«[^»]*»/g, " ")
      // A curly single quote closes where ’ is no apostrophe (one a letter follows, as in "don’t").
      .replace(/‘[\s\S]*?’(?![\p{L}\p{N}])/gu, " ")
      .replace(/(?<![\p{L}\p{N}])'([\s\S]*?)'(?![\p{L}\p{N}])/gu, (span, inner: string) =>
        (inner.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 3 ? " " : span,
      )
  );
}

/** Words that carry no content of their own, and the words a body names the person or the act of keeping with. */
const STOP_WORDS = new Set(
  (
    "a an the and or but nor so yet of to in on at by for with from as into onto about over under than then that this these those " +
    "is are was were be been being am do does did done has have had having will would shall should can could may might must " +
    "i me my mine myself you your yours yourself we us our ours they them their theirs he him his she her hers it its " +
    "im ive id ill youre theyre " +
    "yes very really just also too only always please thanks thank ok okay " +
    "user person someone remember remembers note notes " +
    "there here what which who whom whose when where why how all any each some such own same"
  ).split(" "),
);

/**
 * Words that turn a statement around: content words, all read as one
 * (`NEGATION`), so "doesn't" meets "do not". "No longer" and "used to" are
 * each one, and "stopped" and "quit" are one too: what was true is not now.
 */
const NEGATORS = new Set(
  "not no never dont doesnt didnt wont cant cannot isnt arent without none nothing neither nor nobody nowhere stopped quit".split(" "),
);
const NEGATION = "not";
/**
 * Words that make a sentence a supposition or a wish, not a statement ("if I
 * lived in Paris…", "I would…", "I'd…", "I wish…"): read as `UNCERTAIN`,
 * which no word of letters or digits can be; any of them makes its whole
 * sentence one the quote check does not take.
 */
const CONDITIONALS = new Set("if unless would wish wishes wished".split(" "));
const UNCERTAIN = "?";
/** Verbs after "would" or "'d" that make it a stated preference ("I'd like replies in Spanish"), not a supposition. */
const PREFERENCE_VERBS = new Set("like prefer love rather".split(" "));

/** The fewest distinct content words a body needs before the quote check can pass it: a word or two is too easy to echo. */
const MEMORY_QUOTE_CHECK_MIN_WORDS = 3;

/**
 * A word folded for comparison: a possessive, then a plural or verb ending,
 * then a final silent e taken off, so "lives", "lived" and "live" (and
 * "prefers", "preferred") read alike. Crude on purpose: it only has to make
 * a model's third-person body meet the person's first-person words.
 */
function stem(word: string): string {
  let folded = word.replace(/['’]s$/, "");
  if (folded.length > 4 && folded.endsWith("ies")) folded = `${folded.slice(0, -3)}y`;
  else if (folded.length > 5 && folded.endsWith("ing")) folded = folded.slice(0, -3);
  else if (folded.length > 4 && folded.endsWith("ed")) folded = folded.slice(0, -2);
  else if (folded.length > 3 && folded.endsWith("s") && !folded.endsWith("ss")) folded = folded.slice(0, -1);
  if (folded.length > 3 && folded.endsWith("e")) folded = folded.slice(0, -1);
  return folded;
}

/**
 * `text`'s content words, stemmed: letters and digits in any script, stop
 * words left out, every negation read as `NEGATION` and every conditional
 * as `UNCERTAIN`.
 */
export function contentWords(text: string): readonly string[] {
  const words: string[] = [];
  const found = [...text.normalize("NFKC").matchAll(/[\p{L}\p{N}]+(?:['’]\p{L}+)*/gu)].map((match) => match[0].toLowerCase());
  for (let index = 0; index < found.length; index += 1) {
    const word = found[index] ?? "";
    const bare = word.replace(/['’]/g, "");
    const next = found[index + 1];
    if (NEGATORS.has(bare) || /n['’]t$/.test(word) || (bare === "used" && next === "to")) {
      words.push(NEGATION);
      // "No longer" and "used to" are one negation each.
      if ((bare === "no" && next === "longer") || bare === "used") index += 1;
      continue;
    }
    if (CONDITIONALS.has(bare) || /['’]d$/.test(word)) {
      // "I would like…", "I'd prefer…", "I'd rather…" state a preference, not a supposition.
      if ((bare === "would" || /['’]d$/.test(word)) && next !== undefined && PREFERENCE_VERBS.has(next)) continue;
      words.push(UNCERTAIN);
      continue;
    }
    if (STOP_WORDS.has(bare)) continue;
    words.push(stem(word));
  }
  return words;
}

/** One clause's content words, and whether its sentence is a supposition. */
interface Clause {
  readonly words: readonly string[];
  readonly uncertain: boolean;
}

/**
 * `text` as clauses: sentences (split on `.`, `!`, `?`, `;` and new lines),
 * each split on `,` and `:` and on "but", "and", "or", "although", "though"
 * and "except" — so "I drink coffee, not tea" holds a plain clause and a
 * negated one. A clause that is a negation alone ("…, but no longer") joins
 * the one before it. A conditional anywhere in a sentence makes all its
 * clauses uncertain.
 */
function clausesOf(text: string): readonly Clause[] {
  const clauses: Clause[] = [];
  for (const sentence of text.split(/[.!?;\n]+/)) {
    const parts: string[][] = [];
    for (const part of sentence.split(/[,:]|\b(?:but|and|or|although|though|except)\b/i)) {
      const words = [...contentWords(part)];
      if (words.length === 0) continue;
      const previous = parts.at(-1);
      if (previous !== undefined && words.every((word) => word === NEGATION || word === UNCERTAIN)) previous.push(...words);
      else parts.push(words);
    }
    const uncertain = parts.some((words) => words.includes(UNCERTAIN));
    for (const words of parts) clauses.push({ words: words.filter((word) => word !== UNCERTAIN), uncertain });
  }
  return clauses.filter((clause) => clause.words.length > 0);
}

/**
 * Whether one clause of a draft is said in the person's clauses with the
 * same polarity: every typed clause holding most of its words is no
 * supposition, and holds a negation exactly when it does. A clause none of
 * whose words were typed is left to the share check.
 */
function clauseHeld(wanted: Clause, typed: readonly Clause[]): boolean {
  const negated = wanted.words.includes(NEGATION);
  const plain = [...new Set(wanted.words.filter((word) => word !== NEGATION))];
  if (plain.length === 0) return true;
  const coverage = typed.map((clause) => plain.filter((word) => clause.words.includes(word)).length);
  const most = Math.max(0, ...coverage);
  if (most === 0) return true;
  return typed.every((clause, index) => coverage[index] !== most || (!clause.uncertain && clause.words.includes(NEGATION) === negated));
}

/**
 * Whether one message's clauses hold `text`: it is no supposition itself, at
 * least `MEMORY_QUOTE_CHECK_SHARE` of its distinct words (and at least
 * `least` of them) are in the message, and each of its clauses is said there
 * with the same polarity — a negation in the same clause as the words on
 * both sides, or on neither.
 */
function heldBy(text: string, typed: readonly Clause[], least: number): boolean {
  const words = contentWords(text);
  if (words.includes(UNCERTAIN)) return false;
  const distinct = [...new Set(words)];
  if (distinct.length === 0 || distinct.length < least) return false;
  const all = new Set(typed.flatMap((clause) => clause.words));
  if (distinct.filter((word) => all.has(word)).length / distinct.length < MEMORY_QUOTE_CHECK_SHARE) return false;
  return clausesOf(text).every((clause) => clauseHeld(clause, typed));
}

/**
 * The host's quote check, all in ONE of the person's messages
 * of that turn or span, counting only what they typed (`personTypedText`):
 * at least 80% of the body's content words — at least
 * `MEMORY_QUOTE_CHECK_MIN_WORDS` of them, negations among them — with each
 * clause said with the same polarity and none as a supposition; and the
 * title's words so too, since recall and the card show it. A preference's
 * value must be typed so too, and every word of its key, and its key and
 * value must name at least `MEMORY_QUOTE_CHECK_MIN_WORDS` content words
 * between them; its body as well unless it only restates its key and value.
 * A model's own `from: "person"` never stands in for it.
 */
export function quoteCheckPasses(input: {
  readonly body: string;
  readonly title?: string | undefined;
  readonly preferenceKey?: string | undefined;
  readonly preferenceValue?: string | undefined;
  readonly personMessages: readonly string[];
}): boolean {
  const body = contentWords(input.body);
  const value = input.preferenceValue === undefined ? undefined : contentWords(input.preferenceValue);
  const key = contentWords(input.preferenceKey ?? "");
  const restated = new Set([...key, ...(value ?? [])]);
  const restates = value !== undefined && body.every((word) => restated.has(word)) && body.includes(NEGATION) === value.includes(NEGATION);
  // A preference names enough between its key and value: `theme: dark` alone is too easy to echo.
  if (
    value !== undefined &&
    new Set([...key, ...value].filter((word) => word !== NEGATION && word !== UNCERTAIN)).size < MEMORY_QUOTE_CHECK_MIN_WORDS
  )
    return false;
  const titled = contentWords(input.title ?? "").length > 0;
  for (const message of input.personMessages) {
    const typed = clausesOf(personTypedText(message));
    if (typed.length === 0) continue;
    if (titled && !heldBy(input.title ?? "", typed, 1)) continue;
    if (value === undefined) {
      if (heldBy(input.body, typed, MEMORY_QUOTE_CHECK_MIN_WORDS)) return true;
      continue;
    }
    const all = new Set(typed.flatMap((clause) => clause.words));
    if (!key.every((word) => all.has(word))) continue;
    if (heldBy(input.preferenceValue ?? "", typed, 1) && (restates || heldBy(input.body, typed, MEMORY_QUOTE_CHECK_MIN_WORDS))) return true;
  }
  return false;
}

/** Where a proposal came from, as the host knows it — never as the model described it. */
export interface AutoApproveSource {
  /** `tool`: `memory.propose` in a turn; `review`: the idle review. The flush and consolidation are never kept without asking. */
  readonly path: "tool" | "review" | "flush" | "consolidation";
  /** The chat and the proposal are the workspace operator's own (never a bound channel user's). */
  readonly operatorOwn: boolean;
  /** An attended chat: a Home, side or ordinary chat, never a `run`, a worker, a routine, a reminder or a heartbeat tick. */
  readonly attended: boolean;
  /** A worker's (a delegated task's) proposal. */
  readonly worker: boolean;
  /** The turn ran in a tainted chat: untrusted data read in it or any turn before, or its notices block. */
  readonly tainted: boolean;
  /** The turn was held to a messaging channel (the operator's linked DM, a channel conversation). */
  readonly messaging: boolean;
  /** The draft's own `from`: a hint, never enough alone. */
  readonly from?: "person" | "assistant" | undefined;
  /** The person's messages of that turn or span, as they wrote them. */
  readonly personMessages: readonly string[];
}

/** Why a proposal stays proposed. */
export type AutoApproveRefusal =
  | "kind"
  | "source"
  | "not-operator"
  | "unattended"
  | "worker"
  | "tainted"
  | "messaging"
  | "assistant"
  | "not-proposed"
  | "sensitive"
  | "reserved-key"
  | "tidy-up"
  | "update"
  | "similar"
  | "akin"
  | "quote"
  | "provenance";

/** A proposal as the rule reads it: the record, its newest revision's words and what it is related to. */
export interface AutoApproveCandidate {
  readonly kind: string;
  readonly status: string;
  readonly sensitivity: string;
  readonly preferenceKey?: string | undefined;
  readonly preferenceValue?: string | undefined;
  /** The revision's title: recall and the card show it, so it is quote-checked too. */
  readonly title?: string | undefined;
  readonly body: string;
  /** The revision's author: a flush's (`epoch-flush:e<N>`) or a consolidation's (`…:consolidate`) is never kept. */
  readonly author?: string | undefined;
  /** It updates a record in force (its preference key or fact's topic key). */
  readonly updates: boolean;
  /** It is a near match of a record in force ("similar to …"). */
  readonly similar: boolean;
  /** A kept record of its kind and scope is akin to it (`related`'s `kin`): perhaps the same thing, perhaps its contradiction. */
  readonly akin?: boolean | undefined;
  /** A tidy-up: it supersedes kept records. */
  readonly supersedes: boolean;
  /**
   * The revision's provenance: stamped by `memory.propose` from its call's
   * context label. Untrusted, it is never kept without asking. A lower bound: the turn's end state
   * (`AutoApproveSource.tainted`) is read too, since a later call of the turn may read a page.
   */
  readonly provenance?: MemoryProvenance | undefined;
}

/**
 * The auto-approve rule, pure: undefined when `candidate` may be kept without asking
 * under `kinds`, else the first reason it may not. Exact dedup ran before (a
 * duplicate files nothing to decide).
 */
export function autoApproveRefusal(
  kinds: readonly string[],
  source: AutoApproveSource,
  candidate: AutoApproveCandidate,
): AutoApproveRefusal | undefined {
  if (!kinds.includes(candidate.kind)) return "kind";
  if (source.path !== "tool" && source.path !== "review") return "source";
  if (candidate.author !== undefined && (candidate.author.startsWith("epoch-flush:") || candidate.author.endsWith(":consolidate")))
    return "source";
  if (!source.operatorOwn) return "not-operator";
  if (source.worker) return "worker";
  if (!source.attended) return "unattended";
  if (source.tainted) return "tainted";
  if (memoryProvenanceUntrusted(candidate.provenance)) return "provenance";
  if (source.messaging) return "messaging";
  if (source.from === "assistant") return "assistant";
  if (candidate.status !== "proposed") return "not-proposed";
  if (
    candidate.sensitivity === "sensitive" ||
    sensitiveTopicOf([candidate.body, candidate.preferenceKey, candidate.preferenceValue]) !== undefined
  )
    return "sensitive";
  if (candidate.kind === "preference" && isReservedPreferenceKey(candidate.preferenceKey)) return "reserved-key";
  if (candidate.supersedes) return "tidy-up";
  if (candidate.updates) return "update";
  if (candidate.similar) return "similar";
  if (candidate.akin === true) return "akin";
  const preference =
    candidate.kind === "preference" ? { preferenceKey: candidate.preferenceKey, preferenceValue: candidate.preferenceValue } : {};
  if (!quoteCheckPasses({ body: candidate.body, title: candidate.title, ...preference, personMessages: source.personMessages }))
    return "quote";
  return undefined;
}

/** The review note an auto-approval records: the settings revision whose `autoApprove` allowed it. */
export function autoApproveReviewNote(settingsRevision: number): string {
  return `auto-approve (settings revision ${settingsRevision})`;
}

/** A draft's vector under hybrid recall's rules, for `related`'s kin by meaning; undefined when none may be made. */
export type AutoApproveDraftVector = (draft: {
  readonly actor: Omit<MemoryActor, "authority">;
  readonly record: MemoryRecord;
  readonly revision: MemoryRevision;
}) => Promise<{ readonly modelKey: string; readonly vector: readonly number[] } | undefined>;

/**
 * Keep `recordId` without asking when the auto-approve rule allows it: the record, its
 * newest revision and what it is related to — its kin among kept records by
 * words, and once every other part of the rule holds, by meaning when
 * `draftVector` gives one — are read, the rule applied, and `approve` called
 * with the operator's authority, held to that revision, its review note
 * naming `settingsRevision`. A refusal, a race, or another value kept for
 * the key meanwhile (`MEMORY_CONFLICT`) leaves it proposed. Never throws.
 */
export async function autoApproveProposal(
  memory: Pick<MemoryServicePort, "get" | "history" | "related" | "approve">,
  input: {
    /** The workspace operator, as the actor that approves. */
    readonly operator: Omit<MemoryActor, "authority">;
    readonly recordId: string;
    readonly kinds: readonly string[];
    readonly settingsRevision: number;
    readonly source: AutoApproveSource;
    /** Under hybrid recall, the draft's vector for kin by meaning; absent, kin by words alone. */
    readonly draftVector?: AutoApproveDraftVector | undefined;
  },
): Promise<{ readonly approved: true } | { readonly approved: false; readonly refusal: AutoApproveRefusal | "failed" }> {
  if (input.kinds.length === 0) return { approved: false, refusal: "kind" };
  // Another person's proposal is never read with the operator's authority, let alone kept.
  if (!input.source.operatorOwn) return { approved: false, refusal: "not-operator" };
  try {
    const actor: MemoryActor = { ...input.operator, authority: "operator" };
    const record = await memory.get({ actor, recordId: input.recordId });
    const { revisions } = await memory.history({ actor, recordId: input.recordId });
    const revision = revisions.find((each) => each.revisionId === record.currentRevisionId) ?? revisions[0];
    if (revision === undefined) return { approved: false, refusal: "failed" };
    const related = record.status === "proposed" ? await memory.related({ actor, recordId: input.recordId, kin: {} }) : {};
    const value = revision.preference?.value;
    const candidate: AutoApproveCandidate = {
      kind: record.kind,
      status: record.status,
      sensitivity: record.sensitivity,
      preferenceKey: record.preferenceKey,
      preferenceValue: typeof value === "string" ? value : value === undefined ? undefined : JSON.stringify(value),
      title: revision.title,
      body: revision.body ?? "",
      author: revision.author,
      updates: related.updates !== undefined || related.mayUpdate !== undefined,
      similar: related.similarTo !== undefined,
      // A service that cannot say (no `kin` in its answer) is read as akin: when in doubt, the proposal waits.
      akin: related.kin !== null,
      supersedes: (related.supersedes?.length ?? 0) > 0,
      provenance: revision.provenance,
    };
    const refusal = autoApproveRefusal(input.kinds, input.source, candidate);
    if (refusal !== undefined) return { approved: false, refusal };
    // Kin by meaning, asked only now: the draft's words go to the embedding role only when nothing else holds it back.
    const vector = input.draftVector === undefined ? undefined : await input.draftVector({ actor: input.operator, record, revision });
    if (vector !== undefined && (await memory.related({ actor, recordId: input.recordId, kin: { vector } })).kin !== null)
      return { approved: false, refusal: "akin" };
    await memory.approve({
      actor,
      recordId: input.recordId,
      expectedRevisionId: revision.revisionId,
      reason: autoApproveReviewNote(input.settingsRevision),
    });
    return { approved: true };
  } catch {
    return { approved: false, refusal: "failed" };
  }
}
