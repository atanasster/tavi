import parsePhoneNumberFromString, { type CountryCode } from "libphonenumber-js/min";

/**
 * The forms resolution compares: a name's words without case, accents or legal form; a phone in
 * E.164; an address's postcode, house number and street; a website's
 * registrable domain.
 */

/** NFKC, lower case, accents and punctuation gone, spaces collapsed. */
export function foldText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Cyrillic in Latin letters, Bulgaria's official system (its Transliteration
 * Act, 2009), so a name OSM writes "Аптека Ерудита" and another source
 * "Apteka Erudita" compare as one. Russian's other letters follow its
 * passport system.
 */
const CYRILLIC: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sht",
  ъ: "a",
  ь: "y",
  ю: "yu",
  я: "ya",
  ё: "e",
  ы: "y",
  э: "e",
  ѝ: "i",
  і: "i",
  ї: "yi",
  є: "ye",
  ґ: "g",
  ў: "u",
  ј: "j",
  љ: "lj",
  њ: "nj",
  ћ: "c",
  ђ: "dj",
  џ: "dz",
  ѓ: "gj",
  ќ: "kj",
  ѕ: "dz",
};

/** `foldText` with Cyrillic written in Latin letters: the form names are compared in, whatever script a source wrote them in. */
export function latinText(text: string): string {
  // A final "-ия" is "ia", as the Act writes София and България.
  return foldText(
    text
      .normalize("NFC")
      .toLowerCase()
      .replace(/ия(?![\p{L}\p{M}])/gu, "ia")
      .replace(/[\u0400-\u04ff]/g, (letter) => CYRILLIC[letter] ?? letter),
  );
}

/** Legal forms and filler that say nothing about which place it is. */
const NAME_NOISE = new Set([
  "gmbh",
  "mbh",
  "ag",
  "kg",
  "ohg",
  "gbr",
  "ug",
  "ek",
  "ltd",
  "limited",
  "llc",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "lp",
  "llp",
  "ood",
  "eood",
  "ead",
  "ooo",
  "zao",
  "oao",
  "pao",
  "sarl",
  "sas",
  "sa",
  "sl",
  "slu",
  "srl",
  "spa",
  "snc",
  "bv",
  "nv",
  "vof",
  "oy",
  "ab",
  "as",
  "aps",
  "kk",
  "pty",
  "pvt",
  "the",
  "and",
  "of",
  "le",
  "la",
  "les",
  "du",
  "de",
  "des",
  "der",
  "die",
  "das",
  "el",
  "los",
  "del",
  "il",
  "della",
]);

/** A name's words for comparing, in Latin letters, its legal form and articles left out; the words alone when that leaves none. */
export function nameTokens(name: string): readonly string[] {
  const words = latinText(name)
    .split(" ")
    .filter((word) => word !== "");
  const kept = words.filter((word) => !NAME_NOISE.has(word));
  return kept.length > 0 ? kept : words;
}

/** A phone number in E.164, read in `country` when it has no country code; `undefined` when it is not one. */
export function normalizePhone(raw: string, country?: string): string | undefined {
  const parsed = parsePhoneNumberFromString(raw, country === undefined ? undefined : { defaultCountry: country as CountryCode });
  return parsed !== undefined && parsed.isPossible() ? parsed.number : undefined;
}

/** Second-level suffixes under which a registrable domain has three labels (`shop.co.uk`). */
const SECOND_LEVEL = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "or.jp",
  "ne.jp",
  "com.br",
  "com.mx",
  "co.in",
  "co.kr",
  "or.kr",
  "com.sg",
  "com.tr",
  "co.za",
  "com.ar",
  "com.cn",
  "com.hk",
  "com.tw",
  "co.il",
  "com.my",
  "co.id",
  "com.ph",
  "com.vn",
  "co.th",
]);

/** A website's registrable domain, lower case, without `www.`; `undefined` for what is not an http(s) address. */
export function registrableDomain(website: string): string | undefined {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(website) ? website : `https://${website}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const labels = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .split(".")
    .filter((label) => label !== "");
  if (labels.length < 2) return undefined;
  const lastTwo = labels.slice(-2).join(".");
  return SECOND_LEVEL.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join(".") : lastTwo;
}

/** Hosts on which many businesses each have a page: two sites there are two businesses unless the page is the same. */
const SHARED_HOSTS = new Set([
  "facebook.com",
  "fb.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "linkedin.com",
  "youtube.com",
  "yelp.com",
  "tripadvisor.com",
  "google.com",
  "g.page",
  "goo.gl",
  "linktr.ee",
  "wixsite.com",
  "wix.com",
  "github.io",
  "blogspot.com",
  "wordpress.com",
  "squarespace.com",
  "weebly.com",
  "business.site",
  "godaddysites.com",
  "square.site",
  "carrd.co",
  "jimdosite.com",
  "webnode.page",
  "tumblr.com",
  "medium.com",
  "booksy.com",
  "fresha.com",
  "treatwell.co.uk",
  "opentable.com",
  "doctolib.fr",
  "zocdoc.com",
]);

/**
 * What says two websites are one business's: the registrable domain, or, on
 * a host many businesses share (a Facebook page, a Wix or GitHub site), the
 * full host with the page's first path segment.
 */
export function siteKey(website: string): string | undefined {
  const domain = registrableDomain(website);
  if (domain === undefined || !SHARED_HOSTS.has(domain)) return domain;
  const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(website) ? website : `https://${website}`);
  const host = url.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/^m\./, "");
  const first = url.pathname
    .split("/")
    .find((segment) => segment !== "")
    ?.toLowerCase();
  return first === undefined ? host : `${host}/${first}`;
}

/** A PO box or the like: no storefront is there. */
export const PO_BOX =
  /\b(?:p\.?\s?o\.?\s?box|post office box|postfach|apartado(?: de correos)?|boite postale|bo[iî]te postale|casella postale)\b/i;
