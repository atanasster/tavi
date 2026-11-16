import type { Place } from "./contracts.js";

/**
 * Where a posting is: its location strings as countries, regions and
 * cities, and a remote posting's regions. Boards write locations freely
 * ("San Francisco, CA", "Berlin, Germany", "Remote - US", "Remote (EMEA)"),
 * so this reads the common shapes and leaves the rest a city with no country,
 * which a hard filter treats as unknown, never as a match.
 */

/** Country names and common short forms, lower-case, to ISO 3166 alpha-2. */
const COUNTRIES: Readonly<Record<string, string>> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  america: "US",
  "united kingdom": "GB",
  uk: "GB",
  "u.k.": "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  gb: "GB",
  canada: "CA",
  mexico: "MX",
  brazil: "BR",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  peru: "PE",
  uruguay: "UY",
  germany: "DE",
  deutschland: "DE",
  france: "FR",
  spain: "ES",
  españa: "ES",
  italy: "IT",
  italia: "IT",
  portugal: "PT",
  netherlands: "NL",
  "the netherlands": "NL",
  holland: "NL",
  belgium: "BE",
  belgië: "BE",
  belgique: "BE",
  luxembourg: "LU",
  ireland: "IE",
  switzerland: "CH",
  schweiz: "CH",
  suisse: "CH",
  austria: "AT",
  österreich: "AT",
  sweden: "SE",
  sverige: "SE",
  norway: "NO",
  norge: "NO",
  denmark: "DK",
  danmark: "DK",
  finland: "FI",
  suomi: "FI",
  iceland: "IS",
  poland: "PL",
  polska: "PL",
  "czech republic": "CZ",
  czechia: "CZ",
  slovakia: "SK",
  hungary: "HU",
  romania: "RO",
  bulgaria: "BG",
  greece: "GR",
  croatia: "HR",
  slovenia: "SI",
  serbia: "RS",
  estonia: "EE",
  latvia: "LV",
  lithuania: "LT",
  ukraine: "UA",
  turkey: "TR",
  türkiye: "TR",
  cyprus: "CY",
  malta: "MT",
  israel: "IL",
  "united arab emirates": "AE",
  uae: "AE",
  "saudi arabia": "SA",
  qatar: "QA",
  egypt: "EG",
  "south africa": "ZA",
  nigeria: "NG",
  kenya: "KE",
  morocco: "MA",
  india: "IN",
  pakistan: "PK",
  bangladesh: "BD",
  "sri lanka": "LK",
  singapore: "SG",
  malaysia: "MY",
  indonesia: "ID",
  philippines: "PH",
  thailand: "TH",
  vietnam: "VN",
  "viet nam": "VN",
  japan: "JP",
  "south korea": "KR",
  korea: "KR",
  "republic of korea": "KR",
  china: "CN",
  "hong kong": "HK",
  taiwan: "TW",
  australia: "AU",
  "new zealand": "NZ",
};

const US_STATES: Readonly<Record<string, string>> = {
  AL: "alabama",
  AK: "alaska",
  AZ: "arizona",
  AR: "arkansas",
  CA: "california",
  CO: "colorado",
  CT: "connecticut",
  DE: "delaware",
  DC: "district of columbia",
  FL: "florida",
  GA: "georgia",
  HI: "hawaii",
  ID: "idaho",
  IL: "illinois",
  IN: "indiana",
  IA: "iowa",
  KS: "kansas",
  KY: "kentucky",
  LA: "louisiana",
  ME: "maine",
  MD: "maryland",
  MA: "massachusetts",
  MI: "michigan",
  MN: "minnesota",
  MS: "mississippi",
  MO: "missouri",
  MT: "montana",
  NE: "nebraska",
  NV: "nevada",
  NH: "new hampshire",
  NJ: "new jersey",
  NM: "new mexico",
  NY: "new york",
  NC: "north carolina",
  ND: "north dakota",
  OH: "ohio",
  OK: "oklahoma",
  OR: "oregon",
  PA: "pennsylvania",
  RI: "rhode island",
  SC: "south carolina",
  SD: "south dakota",
  TN: "tennessee",
  TX: "texas",
  UT: "utah",
  VT: "vermont",
  VA: "virginia",
  WA: "washington",
  WV: "west virginia",
  WI: "wisconsin",
  WY: "wyoming",
};
const US_STATE_BY_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(US_STATES).map(([code, name]) => [name, code]),
);

const CA_PROVINCES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);

/** Region words a remote posting names, as the codes `remoteRegions` keeps. */
const REGIONS: Readonly<Record<string, string>> = {
  emea: "EMEA",
  europe: "EUROPE",
  eu: "EU",
  "european union": "EU",
  apac: "APAC",
  "asia pacific": "APAC",
  latam: "LATAM",
  "latin america": "LATAM",
  "north america": "NA",
  americas: "AMER",
  amer: "AMER",
  worldwide: "world",
  global: "world",
  anywhere: "world",
  "anywhere in the world": "world",
};

const EU = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
];
const EUROPE = [...EU, "GB", "CH", "NO", "IS", "UA", "RS", "TR"];
const MIDDLE_EAST_AFRICA = ["IL", "AE", "SA", "QA", "EG", "ZA", "NG", "KE", "MA"];
const LATAM = ["MX", "BR", "AR", "CL", "CO", "PE", "UY"];
const APAC = ["IN", "PK", "BD", "LK", "SG", "MY", "ID", "PH", "TH", "VN", "JP", "KR", "CN", "HK", "TW", "AU", "NZ"];
/** The countries a region code a remote posting names takes in. */
const REGION_COUNTRIES: Readonly<Record<string, ReadonlySet<string>>> = {
  EU: new Set(EU),
  EUROPE: new Set(EUROPE),
  EMEA: new Set([...EUROPE, ...MIDDLE_EAST_AFRICA]),
  NA: new Set(["US", "CA", "MX"]),
  AMER: new Set(["US", "CA", ...LATAM]),
  LATAM: new Set(LATAM),
  APAC: new Set(APAC),
};

/** Whether a remote posting's region (a country code, a region code or `world`) takes in `country`. */
export function regionCovers(region: string, country: string): boolean {
  return region === "world" || region === country || REGION_COUNTRIES[region]?.has(country) === true;
}

/** Cities that name their country well enough, when a board writes only the city. */
const CITIES: Readonly<Record<string, string>> = {
  london: "GB",
  manchester: "GB",
  edinburgh: "GB",
  berlin: "DE",
  munich: "DE",
  münchen: "DE",
  hamburg: "DE",
  frankfurt: "DE",
  cologne: "DE",
  köln: "DE",
  paris: "FR",
  lyon: "FR",
  amsterdam: "NL",
  rotterdam: "NL",
  dublin: "IE",
  madrid: "ES",
  barcelona: "ES",
  lisbon: "PT",
  milan: "IT",
  rome: "IT",
  stockholm: "SE",
  gothenburg: "SE",
  oslo: "NO",
  copenhagen: "DK",
  helsinki: "FI",
  zurich: "CH",
  zürich: "CH",
  vienna: "AT",
  warsaw: "PL",
  prague: "CZ",
  toronto: "CA",
  vancouver: "CA",
  montreal: "CA",
  singapore: "SG",
  bangalore: "IN",
  bengaluru: "IN",
  sydney: "AU",
  melbourne: "AU",
  tokyo: "JP",
  "tel aviv": "IL",
  "new york": "US",
  "new york city": "US",
  nyc: "US",
  "san francisco": "US",
  seattle: "US",
  austin: "US",
  boston: "US",
  chicago: "US",
  "los angeles": "US",
  denver: "US",
};

/** The longest location string read; a longer one is cut, so no pattern below sees an unbounded run. */
const LOCATION_MAX_CHARS = 200;
const clean = (text: string): string => text.slice(0, LOCATION_MAX_CHARS).replace(/\s+/g, " ").trim();
const lower = (text: string): string => clean(text).toLowerCase().replace(/\.$/, "");

/** An ISO alpha-2 code for a country's name or code, if it is one. */
export function countryCode(text: string): string | undefined {
  const key = lower(text);
  const named = COUNTRIES[key];
  if (named !== undefined) return named;
  return /^[a-z]{2}$/.test(key) && Object.values(COUNTRIES).includes(key.toUpperCase()) ? key.toUpperCase() : undefined;
}

/** One location string as a place: "City, ST", "City, Country", "City, Region, Country", "Country". */
export function parsePlace(text: string): Place | undefined {
  // " - " separates parts; a hyphen inside a name (Winston-Salem) does not.
  // Whitespace is single spaces once cleaned, so " - " is matched with no run to backtrack over.
  const parts = clean(text)
    .replace(/\([^()]*\)/g, " ")
    .replace(/ [-–] /g, ",")
    .split(/[,/|·]/)
    .map(clean)
    .filter((part) => part !== "" && !/^(remote|hybrid|on-?site|office)$/i.test(part));
  if (parts.length === 0) return undefined;
  const last = parts.at(-1) ?? "";
  // "City, CA": two capitals after a city are a US state (California, not Canada), unless the city is known elsewhere ("Berlin, DE").
  if (parts.length >= 2 && /^[A-Z]{2}$/.test(last) && US_STATES[last] !== undefined) {
    const known = CITIES[lower(parts[0] ?? "")];
    if (known === undefined || known === "US") return { country: "US", region: last, city: (parts[0] ?? "").slice(0, 80) };
  }
  const country = countryCode(last);
  if (country !== undefined) {
    const rest = parts.slice(0, -1);
    const city = rest[0];
    const region = rest.length > 1 ? rest[1] : undefined;
    return {
      country,
      ...(city === undefined ? {} : { city: city.slice(0, 80) }),
      ...(region === undefined ? {} : { region: region.slice(0, 80) }),
    };
  }
  const upper = last.toUpperCase();
  if (parts.length >= 2 && US_STATES[upper] !== undefined) return { country: "US", region: upper, city: (parts[0] ?? "").slice(0, 80) };
  if (parts.length >= 2 && US_STATE_BY_NAME[lower(last)] !== undefined)
    return { country: "US", region: US_STATE_BY_NAME[lower(last)], city: (parts[0] ?? "").slice(0, 80) };
  if (parts.length >= 2 && CA_PROVINCES.has(upper)) return { country: "CA", region: upper, city: (parts[0] ?? "").slice(0, 80) };
  const cityCountry = CITIES[lower(parts[0] ?? "")];
  return { ...(cityCountry === undefined ? {} : { country: cityCountry }), city: (parts[0] ?? "").slice(0, 80) };
}

/** Whether a location or title says the work is remote, hybrid or on site. */
export function workplaceOf(text: string): "remote" | "hybrid" | "onsite" | undefined {
  if (/\bhybrid\b/i.test(text)) return "hybrid";
  if (
    /\b(remote|work from home|wfh|home[- ]?office|telecommute|distributed|anywhere)\b/i.test(text) &&
    !/\bnot remote\b|\bno remote\b/i.test(text)
  )
    return "remote";
  if (/\b(on-?site|in[- ]office|office[- ]based)\b/i.test(text)) return "onsite";
  return undefined;
}

/**
 * The regions a remote location names: "Remote - US" → `["US"]`,
 * "Remote (EMEA)" → `["EMEA"]`, "Remote, Worldwide" → `["world"]`. A bare
 * "Remote" names none, and a hard filter never reads that as anywhere.
 */
export function remoteRegionsOf(texts: readonly string[]): string[] {
  const regions = new Set<string>();
  for (const text of texts) {
    if (workplaceOf(text) !== "remote") continue;
    for (const piece of clean(text)
      .replace(/ [-–] /g, ",")
      .split(/[,/|()·:;]| or | and /i)
      .map(lower)
      .filter((piece) => piece !== "" && piece !== "remote")) {
      const stripped = piece.replace(/^(remote|based|in|only|within)\s+/g, "").replace(/\s+(only|based|remote)$/g, "");
      const region = REGIONS[stripped];
      if (region !== undefined) regions.add(region);
      const country = countryCode(stripped);
      if (country !== undefined) regions.add(country);
    }
  }
  return [...regions];
}

/** Each location string as a place, the remote ones' regions apart. */
export function placesOf(locations: readonly string[]): {
  readonly places: Place[];
  readonly workplace: "remote" | "hybrid" | "onsite" | undefined;
  readonly remoteRegions: string[];
} {
  const places: Place[] = [];
  let workplace: "remote" | "hybrid" | "onsite" | undefined;
  for (const location of locations) {
    const said = workplaceOf(location);
    if (said === "hybrid" || (said === "remote" && workplace !== "hybrid") || (said === "onsite" && workplace === undefined))
      workplace = said;
    // "Remote - US" is a region, not a place to commute to.
    if (said === "remote" && remoteRegionsOf([location]).length > 0 && !/,.*,/.test(location)) continue;
    const place = parsePlace(location);
    if (
      place !== undefined &&
      places.length < 16 &&
      !places.some((known) => known.city === place.city && known.country === place.country && known.region === place.region)
    )
      places.push(place);
  }
  return { places, workplace, remoteRegions: remoteRegionsOf(locations) };
}
