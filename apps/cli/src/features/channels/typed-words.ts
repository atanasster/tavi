/**
 * The words a person types to a command, in any language Tavi speaks: a chat
 * app's `/memory keep all` is also `/memory запази всички`, and `/heartbeat
 * pause 2h` is also `/heartbeat пауза 2ч`, whatever language the workspace
 * speaks. English is always taken exactly as before; the other languages'
 * words, with the forms a person naturally types, map onto it. Help lists the
 * words of the workspace's language (the `channels` catalogue part).
 */

/**
 * Each English sub-word with the other words taken for it, lower case. A word
 * that is not listed is not a sub-word.
 */
export type TypedWords<Word extends string> = { readonly [W in Word]: readonly string[] };

/**
 * The English sub-word `typed` stands for: itself when it is one (exactly, as
 * before), or the one whose aliases name it, case aside. Undefined otherwise.
 */
export function typedWord<Word extends string>(typed: string | undefined, words: TypedWords<Word>): Word | undefined {
  if (typed === undefined) return undefined;
  if (Object.hasOwn(words, typed)) return typed as Word;
  const lower = typed.toLowerCase();
  for (const [word, aliases] of Object.entries(words) as [Word, readonly string[]][]) if (aliases.includes(lower)) return word;
  return undefined;
}

/** `typed` with every word that stands for an English sub-word put as that word: `запази всички` → `keep all`. */
export function typedWords<Word extends string>(typed: readonly string[], words: TypedWords<Word>): readonly string[] {
  return typed.map((word) => typedWord(word, words) ?? word);
}

/** Pause and resume, as both `/memory` and `/heartbeat` take them. */
const PAUSE_WORDS = ["пауза", "спри"] as const;
const RESUME_WORDS = ["продължи", "пусни", "възобнови"] as const;
const STATUS_WORDS = ["състояние", "статус"] as const;

/** `/memory`'s sub-words. */
export const MEMORY_WORDS: TypedWords<"status" | "review" | "keep" | "all" | "discard" | "off" | "on" | "pause" | "resume"> = {
  status: STATUS_WORDS,
  review: ["преглед", "прегледай"],
  keep: ["запази", "запазвам"],
  all: ["всички", "всичко"],
  discard: ["отхвърли", "отхвърлям"],
  off: ["изключи", "изкл"],
  on: ["включи", "вкл"],
  pause: PAUSE_WORDS,
  resume: RESUME_WORDS,
};

/** `/remember`'s flag for this chat only: `--chat`, `--чат`. */
export const REMEMBER_CHAT_FLAGS: readonly string[] = ["--chat", "--чат"];

/** `/heartbeat`'s sub-words. */
export const HEARTBEAT_WORDS: TypedWords<"status" | "pause" | "resume" | "now"> = {
  status: STATUS_WORDS,
  pause: PAUSE_WORDS,
  resume: RESUME_WORDS,
  now: ["сега", "провери"],
};

/** `/ideas`'s sub-words. */
export const IDEAS_WORDS: TypedWords<"refresh"> = { refresh: ["обнови", "опресни"] };

/** A duration's units in other languages, lower case, as milliseconds: `2ч`, `30мин`, `1д`, `2 часа`. */
const DURATION_UNITS: Readonly<Record<string, number>> = {
  с: 1_000,
  сек: 1_000,
  секунди: 1_000,
  секунда: 1_000,
  м: 60_000,
  мин: 60_000,
  минута: 60_000,
  минути: 60_000,
  ч: 3_600_000,
  час: 3_600_000,
  часа: 3_600_000,
  д: 86_400_000,
  ден: 86_400_000,
  дни: 86_400_000,
  дена: 86_400_000,
};

/**
 * A duration in another language's words, `2ч`, `30мин`, `1д` or `2 часа`, in
 * milliseconds; undefined when it is not one (English, `2h`, is the caller's
 * own parser's).
 */
export function otherLanguageDuration(typed: string): number | undefined {
  const match = /^(\d+)\s*(\p{L}+)\.?$/u.exec(typed.trim());
  if (match === null) return undefined;
  const unit = DURATION_UNITS[(match[2] ?? "").toLowerCase()];
  const amount = Number(match[1]);
  return unit === undefined || amount <= 0 ? undefined : amount * unit;
}

/**
 * Typed words with an amount and its unit written apart joined as one: `2 часа` → `2часа`.
 * Only another language's units join, so English is split as before.
 */
export function joinedAmounts(words: readonly string[]): readonly string[] {
  const joined: string[] = [];
  for (const word of words) {
    const previous = joined.at(-1);
    if (previous !== undefined && /^\d+$/.test(previous) && Object.hasOwn(DURATION_UNITS, word.replace(/\.$/, "").toLowerCase()))
      joined[joined.length - 1] = `${previous}${word}`;
    else joined.push(word);
  }
  return joined;
}
