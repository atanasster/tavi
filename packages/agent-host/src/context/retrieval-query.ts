/**
 * Keywords from a person's words: the one builder
 * turn retrieval (`retrievalQueryFrom`), the idle review's
 * substantive-message count, the heartbeat and
 * `sessions.search` share: distinct lower-cased terms,
 * newest text first, no stopwords, at least 3 characters — except a
 * 2-letter uppercase acronym, a 2-digit number, or a run of
 * Chinese, Japanese or Korean script, which is kept at any length:
 * "東京" or "회사" is a whole word. Memory's FTS index (`unicode61`)
 * indexes an unspaced CJK run as one token, so a short run finds a
 * record holding that run on its own; bigrams are past-chat search's,
 * never memory's.
 */

/** The most terms one call answers by default. */
const RETRIEVAL_KEYWORDS_MAX_TERMS = 24;
/** The search service's own bound on a query (`MemoryService.search`): the terms and their spaces. */
const RETRIEVAL_KEYWORDS_MAX_CHARS = 512;

/**
 * Words too common to tell one memory from another (English, plus function words in FR, DE, ES, PT, IT, NL).
 * A foreign word that is also an English word or a common name ("die", "con", "plus",
 * "Dan", "Mia", "Sue", "MIT", "Como", "todo") is never listed: dropping it would
 * lose the person's own word.
 */
const RETRIEVAL_STOPWORDS = new Set(
  [
    "the and for are but not you your yours with this that these those was were have has had what when where which who whom why how can could would should will shall may might must from into onto about over under then than them they their there here just also only very much many more most some such any all each both few other own same too out off our ours its isn aren wasn weren hasn haven hadn won wouldn don doesn didn couldn shouldn mustn mightn does did doing done been being let please thanks thank okay yes now get got make made want need like know think see use using used one two",
    // French function words
    "les une dans avec sur mais comme fait sont nous vous leur leurs bien aussi cette ces cet ses vos entre dont donc quoi quand pourquoi parce suis était étaient avoir été être avaient avons avez ont",
    // German function words
    "der das ein eine einer einem einen eines und ist waren wird werden wurde wurden hatte hatten haben auf für von bei nach über unter durch gegen ohne aber denn weil wenn wie wer warum nicht auch noch schon sehr mehr wir ihr sie sich mein dein sein unser euer",
    // Spanish function words
    "los las unos unas por sobre entre hasta desde hacia pero más todos toda todas este estos estas ese esos esas aquel aquella nosotros vosotros ellos ellas tus nuestro nuestra nuestros nuestras está están estaba estaban sido",
    // Portuguese function words
    "uma uns umas das pelo pela pelos pelas mais tudo estes esse esses essas aquele aquela isso isto aquilo nós vós eles elas seu sua seus suas meu minha meus minhas nosso nossa nossos nossas estava estavam foi foram são têm tinha",
    // Italian function words
    "gli dei degli delle dalla dallo dagli dalle nello nei negli nelle sul sulla sullo sugli sulle più tutto tutti tutta tutte questo questa questi queste quello quella quelli quelle noi voi loro suo suoi mio miei mie nostro nostra nostri nostre erano stato stata stati",
    // Dutch function words
    "een voor niet maar ook deze zijn wordt worden werden heeft hebben hadden wij jullie mijn onze jouw geen onder tegen zonder tussen omdat wanneer waarom waar welke",
  ]
    .join(" ")
    .split(" "),
);

/** Short 2-letter emphasis words that are not acronyms even when capitalised. */
const SHORT_EMPHASIS_WORDS = new Set(["ok", "no", "so"]);

/**
 * A run of Han, Hiragana or Katakana only: one unspaced Chinese or Japanese
 * sentence is one such term. Hangul is not in it: Korean puts spaces between
 * words, so a Hangul word counts one keyword like a Latin one.
 */
const CJK_RUN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;

/** A term wholly in Han, Hiragana, Katakana or Hangul: kept as a keyword at any length. */
const CJK_TERM = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+$/u;

/** Where CJK script meets any other non-space character: "AIについて" is the term "AI" and the run "について". */
const CJK_BOUNDARY =
  /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー])(?=[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー\s])|(?<=[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー\s])(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー])/gu;

/** An English clitic ("'s", "'re", "n't"): stripped, and left as `CLITIC_MARK` so the word before it is known to have had one. */
const CLITIC = /(?:'|’)(?:s|t|re|ve|ll|d|m)\b|n(?:'|’)t\b/giu;
const CLITIC_MARK = "\u0001";

/**
 * The distinct keywords of `text`, in the order they first appear, at most
 * `maxTerms` and `maxChars` (each term and a space). Empty when none.
 *
 * Keeps a 2-letter acronym written in capitals (`AI`, `UK`, `QA`, `PR`, `US`,
 * `IT`, `GO`) when the message itself is not all-caps (every letter an
 * uppercase one; uncased scripts such as Japanese are not caps), the word
 * is not in `SHORT_EMPHASIS_WORDS` and it had no clitic (`DON'T` and `IT'S`
 * are words, not `DO` and `IT`), as well as a 2-digit number (`42`).
 *
 * With `bigrams` (past-chat search only), each CJK run longer than 2
 * characters also gives its overlapping 2-character pieces, after every
 * whole term and within the same bounds: a search that matches substrings
 * then finds "天気" inside "明日の天気は晴れ", which the whole run never would.
 * Memory's index never asks: `unicode61` would match a bigram only against a
 * run of exactly those 2 characters.
 */
export function retrievalKeywordsFrom(
  text: string,
  options: { readonly maxTerms?: number; readonly maxChars?: number; readonly bigrams?: boolean } = {},
): readonly string[] {
  const maxTerms = options.maxTerms ?? RETRIEVAL_KEYWORDS_MAX_TERMS;
  const maxChars = options.maxChars ?? RETRIEVAL_KEYWORDS_MAX_CHARS;
  const allCapsMessage = /\p{Lu}/u.test(text) && !/[\p{Ll}\p{Lo}]/u.test(text);
  const normalized = text.replace(CJK_BOUNDARY, " ").replace(CLITIC, CLITIC_MARK);
  const seen = new Set<string>();
  const terms: string[] = [];
  let length = 0;
  for (const match of normalized.matchAll(/[\p{L}\p{N}][\p{L}\p{N}._@/-]*/gu)) {
    const raw = match[0];
    const hadClitic = normalized[match.index + raw.length] === CLITIC_MARK;
    const trimmed = raw.replace(/[._/-]+$/, "");
    const term = trimmed.toLowerCase();
    const isShortKept =
      /^[0-9]{2}$/.test(trimmed) || (!allCapsMessage && !hadClitic && /^\p{Lu}{2}$/u.test(trimmed) && !SHORT_EMPHASIS_WORDS.has(term));
    if (
      ([...term].length < 3 && !CJK_TERM.test(term) && !isShortKept) ||
      RETRIEVAL_STOPWORDS.has(term) ||
      seen.has(term) ||
      term.length > 64
    )
      continue;
    if (length + term.length + 1 > maxChars) break;
    seen.add(term);
    terms.push(term);
    length += term.length + 1;
    if (terms.length >= maxTerms) break;
  }
  if (options.bigrams !== true) return terms;
  for (const run of terms.filter((term) => CJK_TERM.test(term))) {
    const chars = [...run];
    for (let index = 0; chars.length > 2 && index + 2 <= chars.length; index++) {
      const [first, second] = [chars[index], chars[index + 1]];
      if (first === undefined || second === undefined) break;
      const piece = first + second;
      if (terms.length >= maxTerms || length + piece.length + 1 > maxChars) return terms;
      if (seen.has(piece)) continue;
      seen.add(piece);
      terms.push(piece);
      length += piece.length + 1;
    }
  }
  return terms;
}

/**
 * Standing facts a topic's question should recall though it never names
 * them: words recall matches only by their spelling, so "a quick dinner I
 * could cook" finds no "I am vegetarian" unless the query carries the
 * word. Each entry's `when` words (the keyword builder's terms, inflected
 * forms listed) add its `add` words. A small fixed table, English only:
 * deterministic and offline, the words-only stand-in for meaning search.
 */
const QUERY_EXPANSIONS: readonly { readonly when: ReadonlySet<string>; readonly add: readonly string[] }[] = [
  {
    when: new Set(
      "food foods meal meals dinner dinners lunch lunches breakfast breakfasts brunch supper snack snacks recipe recipes cook cooks cooked cooking eat eats eating ate restaurant restaurants menu dish dishes groceries grocery bake baking takeaway takeout".split(
        " ",
      ),
    ),
    add: "diet dietary vegetarian vegan pescatarian meat dairy allergy allergic intolerance gluten lactose peanut shellfish kosher halal".split(
      " ",
    ),
  },
];

/** The most words one query's expansion adds. */
const QUERY_EXPANSION_MAX_TERMS = 16;

/**
 * The words `QUERY_EXPANSIONS` adds for `text`'s keywords, minus those
 * already among them, at most `QUERY_EXPANSION_MAX_TERMS`. Empty when no
 * entry's words are there.
 */
export function queryExpansionFor(text: string): readonly string[] {
  const terms = new Set(retrievalKeywordsFrom(text, { maxTerms: Number.POSITIVE_INFINITY, maxChars: Number.POSITIVE_INFINITY }));
  const added = new Set<string>();
  for (const entry of QUERY_EXPANSIONS) {
    if (![...terms].some((term) => entry.when.has(term))) continue;
    for (const word of entry.add) if (!terms.has(word)) added.add(word);
  }
  return [...added].slice(0, QUERY_EXPANSION_MAX_TERMS);
}

/** Characters of an unspaced CJK run that count as one keyword. */
const CJK_CHARS_PER_KEYWORD = 4;

/**
 * How many keywords a message has for the idle review's substantive count:
 * each keyword counts one, except a CJK run, which counts
 * one per `CJK_CHARS_PER_KEYWORD` characters (rounded down), since an
 * unspaced Chinese or Japanese sentence is a single run. So "ok", "thanks",
 * "done" and "ありがとうございます" count under 3, and a 12-character Japanese
 * sentence counts 3.
 */
export function substantiveKeywordCount(text: string): number {
  let count = 0;
  for (const term of retrievalKeywordsFrom(text, { maxTerms: Number.POSITIVE_INFINITY, maxChars: Number.POSITIVE_INFINITY })) {
    count += CJK_RUN.test(term) ? Math.floor([...term].length / CJK_CHARS_PER_KEYWORD) : 1;
  }
  return count;
}

/** The keywords a message needs to count toward the review's trigger. */
const SUBSTANTIVE_KEYWORDS_MIN = 3;

/** Whether a person's message counts toward the idle review's trigger: at least `SUBSTANTIVE_KEYWORDS_MIN` keywords. */
export function isSubstantiveMessage(text: string): boolean {
  return substantiveKeywordCount(text) >= SUBSTANTIVE_KEYWORDS_MIN;
}

/** Deterministic temporal range parsed from a person's query. */
export interface TemporalQueryRange {
  readonly from: string;
  readonly to: string;
  /** True when `[from, to]` lies wholly before the reference day, allowing ended/superseded facts into turn recall. */
  readonly pastOnly: boolean;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  // FR
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  // DE
  ein: 1,
  eine: 1,
  einem: 1,
  einen: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  fünf: 5,
  fuenf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwölf: 12,
  zwoelf: 12,
  // ES
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  // PT
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  três: 3,
  quatro: 4,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  // IT
  due: 2,
  tre: 3,
  quattro: 4,
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  dieci: 10,
  undici: 11,
  dodici: 12,
  // NL
  een: 1,
  één: 1,
  twee: 2,
  vijf: 5,
  zes: 6,
  zeven: 7,
  negen: 9,
  tien: 10,
  twaalf: 12,
};

const MONTH_NAMES: Readonly<Record<string, number>> = {
  // 1 - January
  january: 1,
  jan: 1,
  janvier: 1,
  januar: 1,
  jänner: 1,
  enero: 1,
  janeiro: 1,
  gennaio: 1,
  januari: 1,
  // 2 - February
  february: 2,
  feb: 2,
  février: 2,
  fevrier: 2,
  februar: 2,
  febrero: 2,
  fevereiro: 2,
  febbraio: 2,
  februari: 2,
  // 3 - March
  march: 3,
  mar: 3,
  mars: 3,
  märz: 3,
  maerz: 3,
  marzo: 3,
  março: 3,
  marco: 3,
  maart: 3,
  // 4 - April
  april: 4,
  apr: 4,
  avril: 4,
  abril: 4,
  aprile: 4,
  // 5 - May
  may: 5,
  mai: 5,
  mayo: 5,
  maio: 5,
  maggio: 5,
  mei: 5,
  // 6 - June
  june: 6,
  jun: 6,
  juin: 6,
  juni: 6,
  junio: 6,
  junho: 6,
  giugno: 6,
  // 7 - July
  july: 7,
  jul: 7,
  juillet: 7,
  juli: 7,
  julio: 7,
  julho: 7,
  luglio: 7,
  // 8 - August
  august: 8,
  aug: 8,
  août: 8,
  aout: 8,
  agosto: 8,
  augustus: 8,
  // 9 - September
  september: 9,
  sep: 9,
  sept: 9,
  septembre: 9,
  septiembre: 9,
  setembro: 9,
  settembre: 9,
  // 10 - October
  october: 10,
  oct: 10,
  octobre: 10,
  oktober: 10,
  octubre: 10,
  outubro: 10,
  ottobre: 10,
  // 11 - November
  november: 11,
  nov: 11,
  novembre: 11,
  noviembre: 11,
  novembro: 11,
  // 12 - December
  december: 12,
  dec: 12,
  décembre: 12,
  decembre: 12,
  dezember: 12,
  diciembre: 12,
  dezembro: 12,
  dicembre: 12,
};

const MONTH_NAME_PATTERN = Object.keys(MONTH_NAMES)
  .sort((left, right) => right.length - left.length)
  .join("|");

const NUMBER_WORD_PATTERN = Object.keys(NUMBER_WORDS)
  .sort((left, right) => right.length - left.length)
  .join("|");

/** `timeZone` when the runtime knows it; undefined (UTC) when blank or unknown. */
function knownTimeZone(timeZone?: string): string | undefined {
  if (timeZone === undefined || timeZone.trim() === "") return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

/** The wall clock in `timeZone` at `epochMs`, read as if it were UTC (seconds precision). */
function wallClockMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

/**
 * The instant at which `timeZone`'s wall clock reads `wallMs` (a local time
 * written as UTC milliseconds). The offset is looked up at the boundary
 * itself, so a range crossing a DST change gets each end's own offset.
 */
function instantOfWallClock(wallMs: number, timeZone: string | undefined): number {
  if (timeZone === undefined) return wallMs;
  const offsetAt = (epochMs: number): number => wallClockMs(epochMs, timeZone) - Math.floor(epochMs / 1000) * 1000;
  const guess = wallMs - offsetAt(wallMs);
  return wallMs - offsetAt(guess);
}

function calendarDateInZone(
  epochMs: number,
  timeZone: string | undefined,
): { readonly year: number; readonly month: number; readonly day: number } {
  const date = new Date(timeZone === undefined ? epochMs : wallClockMs(epochMs, timeZone));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function parseCountToken(raw: string): number | undefined {
  const lower = raw.toLowerCase();
  if (/^\d+$/.test(lower)) {
    const value = Number(lower);
    return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : undefined;
  }
  return NUMBER_WORDS[lower];
}

function classifyUnit(raw: string): "day" | "week" | "month" | "year" | undefined {
  const lower = raw.toLowerCase();
  if (/^(?:day|days|jour|jours|tag|tagen|tage|día|días|dia|dias|giorno|giorni|dag|dagen)$/u.test(lower)) return "day";
  if (/^(?:week|weeks|semaine|semaines|woche|wochen|semana|semanas|settimana|settimane|weken)$/u.test(lower)) return "week";
  if (/^(?:month|months|mois|monat|monaten|monate|mes|meses|mês|mese|mesi|maand|maanden)$/u.test(lower)) return "month";
  if (/^(?:year|years|an|ans|année|années|annee|annees|jahr|jahren|jahre|año|años|ano|anos|anno|anni|jaar|jaren)$/u.test(lower))
    return "year";
  return undefined;
}

/** The only clock a person's words may set: a leading `Reference date: YYYY-MM-DD` line (eval probes). */
const REFERENCE_DATE_PREFIX = /^\s*Reference date\s*:\s*(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b[^\n]*/i;

/**
 * Month names that are also another word or a name: an abbreviation ("Jan",
 * "Mar", French "sept" = seven), "mars" (the planet), "mai", "mei" and
 * "marco" (names), "may" (the verb). Each is a month only before a year
 * that ends the phrase, or after one of the prepositions listed for it.
 * `lowercase` asks the month to be written in lower case, as Dutch and
 * Portuguese write months and a name is not ("in mei" but not "in Mei's").
 */
const AMBIGUOUS_MONTHS: Readonly<Record<string, { readonly prepositions: readonly string[]; readonly lowercase?: boolean }>> = {
  jan: { prepositions: [] },
  feb: { prepositions: [] },
  mar: { prepositions: [] },
  apr: { prepositions: [] },
  jun: { prepositions: [] },
  jul: { prepositions: [] },
  aug: { prepositions: [] },
  sep: { prepositions: [] },
  sept: { prepositions: [] },
  oct: { prepositions: [] },
  nov: { prepositions: [] },
  dec: { prepositions: [] },
  mars: { prepositions: ["en", "au mois de", "depuis"] },
  mai: { prepositions: ["im", "en", "au mois de", "seit", "depuis"] },
  mei: { prepositions: ["in", "sinds", "sedert"], lowercase: true },
  marco: { prepositions: ["em", "no mês de", "no mes de", "desde"], lowercase: true },
  may: { prepositions: ["in", "during", "last", "since"] },
};

/**
 * Whether a year ending at `end` stands alone: at the end of the text, before
 * punctuation, or before a conjunction. "in 2019?" is a year; "in 2000 words"
 * and "in 1984 terms" are not.
 */
function yearStandsAlone(text: string, end: number): boolean {
  return /^(?:\s*$|\s*[^\p{L}\p{N}\s]|\s+(?:and|or|but|when|while|et|ou|und|oder|y|o|e|en|of)(?!\p{L}))/u.test(text.slice(end));
}

/** Whether a matched month name reads as a month here (see `AMBIGUOUS_MONTHS`). */
function monthReadsAsMonth(monthRaw: string, preposition: string | undefined, yearEnd: number | undefined, text: string): boolean {
  const rule = AMBIGUOUS_MONTHS[monthRaw.toLowerCase()];
  if (rule === undefined) return true;
  if (yearEnd !== undefined && yearStandsAlone(text, yearEnd)) return true;
  if (rule.lowercase === true && monthRaw !== monthRaw.toLowerCase()) return false;
  return preposition !== undefined && rule.prepositions.includes(preposition.toLowerCase().replace(/\s+/g, " "));
}

/** French words around a bare "hier", which is also German and Dutch "here": "Que faisais-je hier ?" but not "Was hast du hier gemacht?". */
const FRENCH_CUE =
  /(?<!\p{L})(?:que|est-ce|ai|as|avons|avez|étais|était|mon|ma|mes|le|la|les|soir|matin)(?!\p{L})|(?<!\p{L})(?:j|qu|l)['’]\p{L}|-(?:je|tu|il|elle|on|nous|vous|ils|elles)(?!\p{L})/iu;

/**
 * An English "before" about the person's own past: a personal past subject
 * ("did I", "was I", "I moved") and, after "before", a clause ("before I
 * moved"), a year, or a name ("before Porto", "before joining Contoso"). Not
 * "Did the tests pass before merging?" or "Did I deploy before noon?".
 */
const PAST_SUBJECT = /\b(?:[Dd]id|[Ww]as|[Ww]ere|[Hh]ad)\s+(?:I|we)\b|\b(?:I|[Ww]e)\s+(?:did|was|were|had|\p{L}+ed)\b/u;
const PAST_BEFORE = /\b(?:[Bb]efore|[Pp]rior\s+to)\s+(?:(?:I|we|you|he|she|they)\s+\p{L}|(?:19|20)\d{2}(?!\d)|[^?!.]*?\p{Lu}\p{Ll})/u;

/** A German past auxiliary or participle beside "früher", which is also "earlier" in "Kannst du früher kommen?". */
const GERMAN_PAST = /(?<!\p{L})(?:war|warst|waren|wart|hatte|hattest|hatten|ge\p{L}{2,}(?:t|en))(?!\p{L})/u;

/**
 * Deterministic temporal range parser on a person's query (no model):
 * resolves relative and calendar expressions ("yesterday", "last week",
 * "last month", "last year", "<N> days/weeks/months/years ago",
 * "in <Month> [YYYY]", "since <Month> [YYYY]", "in <YYYY>", "since <YYYY>",
 * and past-history cues such as "Where did I live before Porto?" or
 * "used to" / "previously") in English plus French, German, Spanish,
 * Portuguese, Italian and Dutch against `now` in `timeZone`. Each boundary
 * is a midnight in `timeZone` (UTC when unset or unknown); "last week" is
 * the previous calendar week, Monday to Sunday.
 *
 * Honours an explicit leading `Reference date: YYYY-MM-DD` line in `text`
 * when present so eval probes resolve relative dates against the world's
 * clock; nothing else in the text moves the clock.
 */
export function parseTemporalQueryRange(text: string, now?: string, timeZone?: string): TemporalQueryRange | undefined {
  const zone = knownTimeZone(timeZone);
  const refPrefixMatch = text.match(REFERENCE_DATE_PREFIX);
  let refYear: number;
  let refMonth: number;
  let refDay: number;
  if (refPrefixMatch !== null) {
    refYear = Number(refPrefixMatch[1]);
    refMonth = Number(refPrefixMatch[2]);
    refDay = Number(refPrefixMatch[3]);
  } else if (now !== undefined && now.trim() !== "") {
    const parsedNow = Date.parse(now);
    if (!Number.isFinite(parsedNow)) return undefined;
    const resolved = calendarDateInZone(parsedNow, zone);
    refYear = resolved.year;
    refMonth = resolved.month;
    refDay = resolved.day;
  } else {
    return undefined;
  }

  // Boundaries are computed as wall-clock midnights (local dates written as UTC) and turned into instants in `zone` last.
  const todayStartMs = Date.UTC(refYear, refMonth - 1, refDay, 0, 0, 0, 0);
  const todayEndMs = Date.UTC(refYear, refMonth - 1, refDay + 1, 0, 0, 0, 0) - 1;
  const makeRange = (fromMs: number, toInclusiveMs: number, forcePastOnly?: boolean): TemporalQueryRange => ({
    from: new Date(instantOfWallClock(fromMs, zone)).toISOString(),
    to: new Date(instantOfWallClock(toInclusiveMs + 1, zone) - 1).toISOString(),
    pastOnly: forcePastOnly ?? toInclusiveMs < todayStartMs,
  });

  const queryText = refPrefixMatch === null ? text : text.slice(refPrefixMatch[0].length);

  // 1. Explicit ISO date YYYY-MM-DD in query text.
  const isoDateMatch = queryText.match(/\b(19\d{2}|20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  if (isoDateMatch !== null) {
    const year = Number(isoDateMatch[1]);
    const month = Number(isoDateMatch[2]);
    const day = Number(isoDateMatch[3]);
    return makeRange(Date.UTC(year, month - 1, day, 0, 0, 0, 0), Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0) - 1);
  }

  // 2. Day before yesterday (EN, FR, DE, ES, PT, IT, NL).
  if (
    /\b(?:(?:the\s+)?day\s+before\s+yesterday|avant-hier|vorgestern|anteayer|antes\s+de\s+ontem|anteontem|l['’]altro\s+ieri|eergisteren)\b/iu.test(
      queryText,
    )
  ) {
    return makeRange(
      Date.UTC(refYear, refMonth - 1, refDay - 2, 0, 0, 0, 0),
      Date.UTC(refYear, refMonth - 1, refDay - 1, 0, 0, 0, 0) - 1,
      true,
    );
  }

  // 3. Yesterday (EN, FR, DE, ES, PT, IT, NL); a bare "hier" only among French words.
  if (
    /\b(?:yesterday|gestern|ayer|ontem|ieri|gisteren)\b/iu.test(queryText) ||
    (/\bhier\b/iu.test(queryText) && FRENCH_CUE.test(queryText))
  ) {
    return makeRange(Date.UTC(refYear, refMonth - 1, refDay - 1, 0, 0, 0, 0), todayStartMs - 1, true);
  }

  // 4. "<N> days/weeks/months/years ago" across EN, FR, DE, ES, PT, IT, NL.
  const agoPatterns: readonly { readonly regex: RegExp; readonly countIndex: number; readonly unitIndex: number }[] = [
    {
      // EN, IT, NL: "<N> <unit> ago|fa|geleden"
      regex: new RegExp(
        `\\b(\\d+|${NUMBER_WORD_PATTERN})\\s+(day|days|week|weeks|month|months|year|years|giorno|giorni|settimana|settimane|mese|mesi|anno|anni|dag|dagen|weken|maand|maanden|jaar|jaren)\\s+(?:ago|fa|geleden)\\b`,
        "iu",
      ),
      countIndex: 1,
      unitIndex: 2,
    },
    {
      // FR, DE, ES, PT: "il y a | vor | hace | há <N> <unit>"
      regex: new RegExp(
        `\\b(?:il\\s+y\\s+a|vor|hace|h[áa])\\s+(\\d+|${NUMBER_WORD_PATTERN})\\s+(jour|jours|semaine|semaines|mois|an|ans|ann[ée]e|ann[ée]es|tag|tagen|tage|woche|wochen|monat|monaten|monate|jahr|jahren|jahre|d[íi]a|d[íi]as|semana|semanas|mes|meses|m[êe]s|a[ñn]o|a[ñn]os|ano|anos)\\b`,
        "iu",
      ),
      countIndex: 1,
      unitIndex: 2,
    },
  ];
  for (const { regex, countIndex, unitIndex } of agoPatterns) {
    const match = queryText.match(regex);
    if (match !== null) {
      const count = parseCountToken(match[countIndex] ?? "");
      const unit = classifyUnit(match[unitIndex] ?? "");
      if (count !== undefined && unit !== undefined) {
        if (unit === "day") {
          const fromMs = Date.UTC(refYear, refMonth - 1, refDay - count - 1, 0, 0, 0, 0);
          const toMs = Math.min(todayStartMs - 1, Date.UTC(refYear, refMonth - 1, refDay - count + 2, 0, 0, 0, 0) - 1);
          return makeRange(fromMs, Math.max(fromMs, toMs), true);
        }
        if (unit === "week") {
          const fromMs = Date.UTC(refYear, refMonth - 1, refDay - count * 7 - 3, 0, 0, 0, 0);
          const toMs = Math.min(todayStartMs - 1, Date.UTC(refYear, refMonth - 1, refDay - count * 7 + 4, 0, 0, 0, 0) - 1);
          return makeRange(fromMs, Math.max(fromMs, toMs), true);
        }
        if (unit === "month") {
          const fromMs = Date.UTC(refYear, refMonth - 1 - count, 1, 0, 0, 0, 0);
          const toMs = Math.min(todayStartMs - 1, Date.UTC(refYear, refMonth - count, refDay + 1, 0, 0, 0, 0) - 1);
          return makeRange(fromMs, Math.max(fromMs, toMs), true);
        }
        const fromMs = Date.UTC(refYear - count, 0, 1, 0, 0, 0, 0);
        const toMs = Date.UTC(refYear - count + 1, 0, 1, 0, 0, 0, 0) - 1;
        return makeRange(fromMs, toMs, true);
      }
    }
  }

  // 5. Last week (the previous Monday-to-Sunday week) / last month / last year (EN, FR, DE, ES, PT, IT, NL).
  if (
    /\b(?:(?:last|past|previous)\s+week|(?:la\s+)?semaine\s+derni[èe]re|(?:letzte[nr]?|vergangene[nr]?)\s+woche|(?:la\s+|na\s+)?semana\s+pass?ada|(?:la\s+)?settimana\s+scorsa|(?:vorige|afgelopen)\s+week)\b/iu.test(
      queryText,
    )
  ) {
    const thisMonday = refDay - ((new Date(todayStartMs).getUTCDay() + 6) % 7);
    return makeRange(
      Date.UTC(refYear, refMonth - 1, thisMonday - 7, 0, 0, 0, 0),
      Date.UTC(refYear, refMonth - 1, thisMonday, 0, 0, 0, 0) - 1,
      true,
    );
  }

  if (
    /\b(?:(?:last|past|previous)\s+month|(?:le\s+)?mois\s+dernier|(?:letzte[nrs]?|vergangene[nrs]?)\s+monat|(?:el\s+|no\s+)?m[eê]s\s+pass?ado|(?:il\s+)?mese\s+scorso|(?:vorige|afgelopen)\s+maand)\b/iu.test(
      queryText,
    )
  ) {
    return makeRange(Date.UTC(refYear, refMonth - 2, 1, 0, 0, 0, 0), Date.UTC(refYear, refMonth - 1, 1, 0, 0, 0, 0) - 1, true);
  }

  if (
    /\b(?:(?:last|past|previous)\s+year|l['’]an(?:n[ée]e)?\s+derni[èe]re?|(?:letzte[ns]?|vergangene[ns]?)\s+jahr|(?:el\s+|no\s+)?a[ñn]o\s+pass?ado|(?:l['’])?anno\s+scorso|(?:vorig|afgelopen)\s+jaar)\b/iu.test(
      queryText,
    )
  ) {
    return makeRange(Date.UTC(refYear - 1, 0, 1, 0, 0, 0, 0), Date.UTC(refYear, 0, 1, 0, 0, 0, 0) - 1, true);
  }

  // 6. "since <Month> [YYYY]" or "since <YYYY>" (EN, FR, DE, ES, PT, IT, NL).
  const sinceMonthRegex = new RegExp(
    `\\b(since|depuis|seit|desde|sinds|sedert|dal|dalla)\\s+(${MONTH_NAME_PATTERN})(?:\\s+(19\\d{2}|20\\d{2}))?\\b`,
    "giu",
  );
  for (const sinceMonthMatch of queryText.matchAll(sinceMonthRegex)) {
    const monthRaw = sinceMonthMatch[2] ?? "";
    const month = MONTH_NAMES[monthRaw.toLowerCase()];
    const yearEnd = sinceMonthMatch[3] === undefined ? undefined : sinceMonthMatch.index + sinceMonthMatch[0].length;
    if (month !== undefined && monthReadsAsMonth(monthRaw, sinceMonthMatch[1], yearEnd, queryText)) {
      const explicitYear = sinceMonthMatch[3] === undefined ? undefined : Number(sinceMonthMatch[3]);
      const year = explicitYear ?? (month <= refMonth ? refYear : refYear - 1);
      return makeRange(Date.UTC(year, month - 1, 1, 0, 0, 0, 0), todayEndMs, false);
    }
  }

  for (const sinceYearMatch of queryText.matchAll(/\b(?:since|depuis|seit|desde|sinds|sedert|dal)\s+(19\d{2}|20\d{2})\b/giu)) {
    if (!yearStandsAlone(queryText, sinceYearMatch.index + sinceYearMatch[0].length)) continue;
    const year = Number(sinceYearMatch[1]);
    return makeRange(Date.UTC(year, 0, 1, 0, 0, 0, 0), todayEndMs, false);
  }

  // 7. "in/during/last <Month> [YYYY]" or "<Month> <YYYY>" (EN, FR, DE, ES, PT, IT, NL).
  const inMonthRegex = new RegExp(
    `\\b(in|during|last|en|au\\s+mois\\s+de|au\\s+mois\\s+d['’]|im|no\\s+m[eê]s\\s+de|em|nel\\s+mese\\s+di)\\s+(${MONTH_NAME_PATTERN})(?:\\s+(19\\d{2}|20\\d{2}))?\\b`,
    "giu",
  );
  for (const inMonthMatch of queryText.matchAll(inMonthRegex)) {
    const prep = (inMonthMatch[1] ?? "").toLowerCase();
    const monthRaw = inMonthMatch[2] ?? "";
    const month = MONTH_NAMES[monthRaw.toLowerCase()];
    const yearEnd = inMonthMatch[3] === undefined ? undefined : inMonthMatch.index + inMonthMatch[0].length;
    if (month !== undefined && monthReadsAsMonth(monthRaw, prep, yearEnd, queryText)) {
      const explicitYear = inMonthMatch[3] === undefined ? undefined : Number(inMonthMatch[3]);
      // "last March" is the most recent March before this month; "in March" is this year's unless March is still ahead.
      const year =
        explicitYear ?? (prep === "last" ? (month < refMonth ? refYear : refYear - 1) : month > refMonth ? refYear - 1 : refYear);
      return makeRange(Date.UTC(year, month - 1, 1, 0, 0, 0, 0), Date.UTC(year, month, 1, 0, 0, 0, 0) - 1);
    }
  }

  const monthYearRegex = new RegExp(`\\b(${MONTH_NAME_PATTERN})\\s+(19\\d{2}|20\\d{2})\\b`, "giu");
  for (const monthYearMatch of queryText.matchAll(monthYearRegex)) {
    const monthRaw = monthYearMatch[1] ?? "";
    const month = MONTH_NAMES[monthRaw.toLowerCase()];
    const year = Number(monthYearMatch[2]);
    if (month !== undefined && monthReadsAsMonth(monthRaw, undefined, monthYearMatch.index + monthYearMatch[0].length, queryText)) {
      return makeRange(Date.UTC(year, month - 1, 1, 0, 0, 0, 0), Date.UTC(year, month, 1, 0, 0, 0, 0) - 1);
    }
  }

  // 8. "in/during <YYYY>" (EN, FR, DE, ES, PT, IT, NL), when the number stands alone as a year.
  for (const inYearMatch of queryText.matchAll(/\b(?:in|during|en|im|em|nel)\s+(19\d{2}|20\d{2})\b/giu)) {
    if (!yearStandsAlone(queryText, inYearMatch.index + inYearMatch[0].length)) continue;
    const year = Number(inYearMatch[1]);
    return makeRange(Date.UTC(year, 0, 1, 0, 0, 0, 0), Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - 1);
  }

  // 9. Past-history cues ("Where did I live before Porto?", "used to", "previously", "formerly", etc.).
  const isPastHistoryQuery =
    /\b(?:used\s+to|previously|formerly)\b/iu.test(queryText) ||
    (PAST_SUBJECT.test(queryText) && PAST_BEFORE.test(queryText)) ||
    /\b(?:auparavant|autrefois|avant\s+de\s+(?:rejoindre|passer|d[ée]m[ée]nager|changer|acheter)|avant\s+[A-Z\p{Lu}])/u.test(queryText) ||
    /\b(?:zuvor|ehemals|vor\s+dem\s+Wechsel)\b/iu.test(queryText) ||
    (/\bfr[üu]her\b/iu.test(queryText) && GERMAN_PAST.test(queryText)) ||
    /\b(?:anteriormente|antes\s+de\s+(?:me\s+mudar|mudarme|mudar|cambiar|trocar|unirme|entrar|comprar|pasar|passar))\b/iu.test(queryText) ||
    /\b(?:precedentemente|in\s+precedenza|prima\s+di\s+(?:trasferirmi|cambiare|passare|comprare|entrare))\b/iu.test(queryText) ||
    /\b(?:vroeger|voorheen)\b/iu.test(queryText);
  if (isPastHistoryQuery) {
    return {
      from: "1970-01-01T00:00:00.000Z",
      to: new Date(instantOfWallClock(todayStartMs, zone) - 1).toISOString(),
      pastOnly: true,
    };
  }

  return undefined;
}
