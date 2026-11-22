/**
 * The words a person reads, in the language the workspace is set to: a
 * catalogue per language and namespace, a translator that falls back to
 * English, plural forms chosen by `Intl.PluralRules`, `{name}` parameters, and a
 * pseudo-locale that stretches and marks every string so a word still written
 * inline in code stands out.
 *
 * Zod-free and free of Node and DOM APIs, like `./util`, so the canvas, the
 * terminal, the owner and a plugin iframe all use the same one.
 */

/** The languages Tavi speaks. English is the source and the fallback. */
export const SUPPORTED_LOCALES = ["en", "bg"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** The language when none is set. */
export const DEFAULT_LOCALE: Locale = "en";

/** Whether `value` names a language Tavi speaks. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Each language's name in its own words, as a picker lists it. */
export const LOCALE_NAMES: { readonly [L in Locale]: string } = { en: "English", bg: "Български" };

/**
 * The BCP 47 tag `Intl` formats a language's numbers with. English keeps
 * `en-US` so a count reads "20,000" on every machine, whatever its own locale.
 */
export const INTL_LOCALE: { readonly [L in Locale]: string } = { en: "en-US", bg: "bg-BG" };

/**
 * A counted message: one form per plural category the language has, `other`
 * always. `{count}` in a form is the count, formatted for the language.
 */
export interface PluralMessage {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

export type Message = string | PluralMessage;

/** A namespace's messages in one language, by key. */
export type Catalog = { readonly [key: string]: Message };

/**
 * Another language's catalogue for the namespace whose English is `Source`:
 * every key, nothing more, a plural where English has one. `satisfies`
 * against it makes a missing or extra key a type error.
 */
export type CatalogFor<Source extends Catalog> = {
  readonly [K in keyof Source]: Source[K] extends string ? string : PluralMessage;
};

/** The values a message's `{name}` parameters take. */
export type MessageParams = { readonly [name: string]: string | number };

/** A function that says `key` in one language: what label helpers take so the caller chooses the language. */
export type Translate<Key extends string = string> = (key: Key, params?: MessageParams) => string;

const pluralRules = new Map<Locale, Intl.PluralRules>();
const numberFormats = new Map<Locale, Intl.NumberFormat>();

/** The plural category `count` takes in `locale` (`one`, `other`, …). */
export function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(INTL_LOCALE[locale]);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

/** `value` as a person in `locale` writes it: "20,000" in English, "20 000" and "1,5" in Bulgarian. */
export function formatNumber(value: number, locale: Locale): string {
  let format = numberFormats.get(locale);
  if (format === undefined) {
    format = new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: 20 });
    numberFormats.set(locale, format);
  }
  return format.format(value);
}

/**
 * `template` with each `{name}` replaced by its parameter (a number formatted
 * for `locale`). A name with no parameter is left as written, so a gap shows
 * rather than an empty space.
 */
export function fillMessage(template: string, params: MessageParams | undefined, locale: Locale): string {
  if (params === undefined) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) return whole;
    return typeof value === "number" ? formatNumber(value, locale) : value;
  });
}

/**
 * The form of `message` for `params.count` (`other` when there is no count),
 * filled. The form follows the plural rules of `locale`, the language the
 * message is written in; numbers are written for `numbersIn` (the reader's
 * language, which differs when an English fallback is shown to a Bulgarian).
 */
export function formatMessage(message: Message, locale: Locale, params?: MessageParams, numbersIn: Locale = locale): string {
  if (typeof message === "string") return fillMessage(message, params, numbersIn);
  const count = params?.["count"];
  const form = typeof count === "number" ? (message[pluralCategory(locale, count)] ?? message.other) : message.other;
  return fillMessage(form, params, numbersIn);
}

const PSEUDO_LETTERS: { readonly [letter: string]: string } = {
  a: "à",
  c: "ç",
  e: "é",
  i: "ì",
  n: "ñ",
  o: "ö",
  u: "ü",
  y: "ý",
  A: "Å",
  C: "Ç",
  E: "É",
  I: "Ì",
  N: "Ñ",
  O: "Ö",
  T: "Ŧ",
  U: "Ü",
};

/** The opening mark of a pseudo-localised string: a test that finds it knows the text went through a catalogue. */
export const PSEUDO_OPEN = "[";
/** The closing mark of a pseudo-localised string. */
export const PSEUDO_CLOSE = " ··]";

/**
 * `text` accented, about a third longer and bracketed: "Save" becomes
 * "[Sàvé ··]". Text that never reaches it stays plain, so a string still written
 * inline in code shows on a pseudo-localised screen.
 */
export function pseudoLocalize(text: string): string {
  const accented = Array.from(text, (letter) => PSEUDO_LETTERS[letter] ?? letter).join("");
  const padding = "·".repeat(Math.max(0, Math.ceil(text.length * 0.35) - PSEUDO_CLOSE.length + 1));
  return `${PSEUDO_OPEN}${accented}${padding}${PSEUDO_CLOSE}`;
}

export interface TranslatorOptions {
  /** Stretch and mark every string (`pseudoLocalize`): the overflow check's longer-than-Bulgarian pass. */
  readonly pseudo?: boolean;
}

/** A namespace's catalogues: English always, another language once it is loaded. */
export type Catalogs<Source extends Catalog> = { readonly en: Source } & { readonly [L in Exclude<Locale, "en">]?: CatalogFor<Source> };

/**
 * A translator for one namespace in `locale`. A key the language's catalogue
 * lacks (or a catalogue not loaded yet) says the English; a key English lacks
 * says the key itself, so it is visible rather than blank.
 */
export function createTranslator<Source extends Catalog>(
  catalogs: Catalogs<Source>,
  locale: Locale,
  options: TranslatorOptions = {},
): Translate<Extract<keyof Source, string>> {
  const chosen = (locale === "en" ? catalogs.en : catalogs[locale]) as Catalog | undefined;
  return (key, params) => {
    // Own keys only: a key such as "toString" must not find `Object.prototype`'s.
    const own = chosen !== undefined && Object.hasOwn(chosen, key) ? chosen[key] : undefined;
    const english = catalogs.en as Catalog;
    const message = own ?? (Object.hasOwn(english, key) ? english[key] : undefined);
    const text = message === undefined ? key : formatMessage(message, own === undefined ? "en" : locale, params, locale);
    return options.pseudo === true ? pseudoLocalize(text) : text;
  };
}
