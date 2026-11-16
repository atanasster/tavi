import { SENIORITIES, type JobFlag, type JobPosting, type JobProfileInput, type Place } from "./contracts.js";
import { companyKey, titleKey } from "./dedup.js";
import { convertCurrency, type EuroRates } from "./ecb.js";
import { regionCovers } from "./places.js";
import { annualFloor, annualise } from "./salary.js";
import { skillTokens, type SkillIndex } from "./skills.js";

/**
 * A posting against a person's profile, in code: hard filters first,
 * each with its reason, then a score. A hard filter excludes only what it is
 * sure of (precision 1.0): a field the posting leaves unknown is `maybe`, never
 * `excluded` and never `fits` — except pay, which passes flagged
 * `salary-unknown` unless the source states it. The model explains the result and may re-rank
 * within `fits`; it never moves a posting across a filter.
 */
export type MatchOutcome = "fits" | "maybe" | "excluded";

export interface MatchResult {
  readonly postingId: string;
  readonly outcome: MatchOutcome;
  /** Why it is excluded, or what is unknown for a `maybe`. */
  readonly reasons: readonly string[];
  readonly score: number;
  readonly matched: readonly string[];
  /** Required skills the profile lacks. */
  readonly gaps: readonly string[];
  readonly flags: readonly JobFlag[];
}

export interface MatchOptions {
  readonly now: string;
  readonly skills?: SkillIndex;
  /** The ECB's rates: a stated salary in another currency is converted at them; without them it is unchecked. */
  readonly rates?: EuroRates | undefined;
}

/** A posting naming this many skills, none of yours, scores at this share (tuned on the fixture set). */
const UNRELATED_SKILLS = 3;
const UNRELATED_DISCOUNT = 0.6;
/** The fewest skills a posting's coverage is counted over (tuned on the fixture set). */
const SKILLS_FLOOR = 6;
const WEIGHTS = { skills: 0.45, title: 0.3, seniority: 0.15, recency: 0.1 } as const;
const RECENCY_DAYS = 30;
/** Within this of a profile place, with no radius given, a city counts as near. */
const DEFAULT_RADIUS_KM = 30;

function distanceKm(a: Place, b: Place): number | undefined {
  if (a.lat === undefined || a.lon === undefined || b.lat === undefined || b.lon === undefined) return undefined;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The same city: by name, or a place whose name holds the city as a word ("ASB Pflege und Teilhabe Berlin
 * gGmbH", a board's name for its Berlin site), in no other country.
 */
const sameCity = (a: Place, b: Place): boolean => {
  if (a.city === undefined || b.city === undefined || (a.country !== undefined && b.country !== undefined && a.country !== b.country))
    return false;
  const [x, y] = [a.city.toLowerCase(), b.city.toLowerCase()];
  if (x === y) return true;
  const word = (outer: string, inner: string): boolean =>
    inner.length >= 3 &&
    new RegExp(`(?<![\\p{L}\\p{N}])${inner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(outer);
  return (a.country === undefined && word(x, y)) || (b.country === undefined && word(y, x));
};

/** Whether a posting's place is near one of the profile's: `yes`, `no`, or `unknown` when nothing says. */
function near(posting: readonly Place[], profile: JobProfileInput["places"]): "yes" | "no" | "unknown" {
  if (posting.length === 0 || profile.length === 0) return "unknown";
  let unknown = false;
  for (const place of posting) {
    for (const home of profile) {
      const km = distanceKm(place, home);
      if (km !== undefined) {
        if (km <= (home.radiusKm ?? DEFAULT_RADIUS_KM)) return "yes";
        continue;
      }
      if (sameCity(place, home)) return "yes";
      // Different countries are far apart; a city in the same country, with no coordinates, might be near.
      if (place.country === undefined || home.country === undefined || place.country === home.country) unknown = true;
    }
  }
  return unknown ? "unknown" : "no";
}

/** The hard filters: reasons to exclude, and what is unknown. */
function filters(
  posting: JobPosting,
  profile: JobProfileInput,
  text: string,
  now: string,
  rates: EuroRates | undefined,
): { readonly excluded: string[]; readonly unknown: string[]; readonly flags: JobFlag[] } {
  const excluded: string[] = [];
  const unknown: string[] = [];
  const flags: JobFlag[] = [];
  const company = companyKey(posting.company);
  if (company !== "" && profile.exclusions.companies.some((name) => companyKey(name) === company))
    excluded.push(`company ${posting.company} is excluded`);
  const words = ` ${skillTokens(text).join(" ")} `;
  for (const keyword of profile.exclusions.keywords) {
    const key = skillTokens(keyword).join(" ");
    if (key !== "" && words.includes(` ${key} `)) excluded.push(`mentions the excluded word "${keyword}"`);
  }

  const regionsOk = (posting.remoteRegions ?? []).some((region) => profile.remoteRegions.some((country) => regionCovers(region, country)));
  const regionsKnown = (posting.remoteRegions ?? []).length > 0;
  const commute = near(posting.places, profile.places);
  const remote = (): void => {
    if (!regionsKnown) unknown.push("remote, but the posting names no region it hires in");
    else if (profile.remoteRegions.length > 0 && !regionsOk) excluded.push(`remote only in ${(posting.remoteRegions ?? []).join(", ")}`);
  };
  const local = (): void => {
    if (commute === "no")
      excluded.push(
        `${posting.workplace === "hybrid" ? "hybrid" : "on site"} in ${posting.places.map((place) => place.city ?? place.country ?? "").join(", ")}, not near your places`,
      );
    else if (commute === "unknown") unknown.push("cannot tell whether its place is near yours");
  };
  // Offices and a remote option ("New York; Remote (US)"): the remote option is one way to take it.
  const remoteOffered = posting.workplace === "remote" || regionsKnown;
  if (profile.remote === "only") {
    if (remoteOffered) remote();
    else if (posting.workplace === "unknown") unknown.push("does not say whether it is remote");
    else excluded.push(`${posting.workplace === "hybrid" ? "hybrid" : "on site"}, and you want remote only`);
  } else if (posting.workplace === "unknown") {
    // Near: on site or hybrid it suits anyone who takes an office, and a remote job says it is one, so nothing is unknown.
    const suitsEither = commute === "yes";
    // It may be remote: an office far away excludes it only for someone who wants an office, where remote is excluded too.
    if (profile.remote === "no" && commute === "no")
      excluded.push(
        `in ${posting.places.map((place) => place.city ?? place.country ?? "").join(", ")}, not near your places, and you want an office`,
      );
    else if (!suitsEither) unknown.push("does not say whether it is remote");
  } else if (profile.remote === "no") {
    // A remote posting with an office near you ("London or remote UK") can be taken at the office.
    if (posting.workplace === "remote" && commute !== "yes") excluded.push("remote, and you want an office");
    else local();
  } else if (!(regionsKnown && regionsOk) && commute !== "yes") {
    // Open to either: one way of taking it that suits you is enough, and it is excluded only when every way fails.
    if (posting.places.length === 0 || !remoteOffered) {
      if (remoteOffered) remote();
      else local();
    } else if (regionsKnown && commute === "no")
      excluded.push(`remote only in ${(posting.remoteRegions ?? []).join(", ")}, and its offices are not near your places`);
    else unknown.push("cannot tell whether its remote regions or its offices suit you");
  }

  if (profile.salaryFloor !== undefined) {
    const salary = posting.salary;
    // Predicted, text or absent pay passes, flagged: the flag, never the filter, says the floor is unchecked.
    const year = salary === undefined || salary.origin !== "stated" ? undefined : annualise(salary);
    const stated = year?.max ?? year?.min;
    // Another currency is held against the floor at the day's ECB rate; with no rate it is unchecked too.
    const top =
      stated === undefined || salary === undefined
        ? undefined
        : salary.currency === profile.salaryFloor.currency
          ? stated
          : rates === undefined
            ? undefined
            : convertCurrency(stated, salary.currency, profile.salaryFloor.currency, rates);
    if (top === undefined || salary === undefined) flags.push("salary-unknown");
    else if (top < annualFloor(profile.salaryFloor))
      excluded.push(
        salary.currency === profile.salaryFloor.currency
          ? `pays at most ${String(Math.round(top))} ${salary.currency} a year, under your floor`
          : `pays at most ${String(Math.round(stated ?? 0))} ${salary.currency} a year, about ${String(Math.round(top))} ${profile.salaryFloor.currency} at the ECB's rate of ${rates?.date ?? ""}, under your floor`,
      );
  }
  if (
    profile.employmentTypes.length > 0 &&
    posting.employmentType !== undefined &&
    posting.employmentType !== "OTHER" &&
    !profile.employmentTypes.includes(posting.employmentType)
  )
    excluded.push(`${posting.employmentType.toLowerCase().replace("_", "-")}, not a type you want`);
  if (posting.validThrough !== undefined && Date.parse(posting.validThrough) < Date.parse(now)) excluded.push("closed for applications");
  if (posting.sponsorship === "not-offered" && profile.needsSponsorship.length > 0) {
    const countries = new Set([...posting.places.map((place) => place.country), ...(posting.remoteRegions ?? [])]);
    const blocked = profile.needsSponsorship.filter((country) => countries.has(country));
    if (blocked.length > 0) excluded.push(`offers no visa sponsorship, which you need in ${blocked.join(", ")}`);
  }
  return { excluded, unknown, flags };
}

const titleWords = (title: string): Set<string> =>
  new Set(
    titleKey(title)
      .split(" ")
      .filter((word) => word.length > 1 && !/^(senior|sr|junior|jr|lead|staff|principal|i|ii|iii|iv|mid|level)$/.test(word)),
  );

/** A title's words in order, less its levels: "senior software engineer, storage" is "software engineer storage". */
const titlePhrase = (title: string): string =>
  ` ${titleKey(title)
    .split(" ")
    .filter((word) => titleWords(word).size > 0)
    .join(" ")} `;

/** 1 when the posting's title holds one of the profile's as a phrase ("Software Engineer, Storage"); else the words' overlap. */
function titleSimilarity(posting: string, titles: readonly string[]): number {
  const words = titleWords(posting);
  const phrase = titlePhrase(posting);
  let best = 0;
  for (const title of titles) {
    if (titlePhrase(title).trim() !== "" && phrase.includes(titlePhrase(title))) return 1;
    const wanted = titleWords(title);
    const shared = [...wanted].filter((word) => words.has(word)).length;
    const union = new Set([...words, ...wanted]).size;
    best = Math.max(best, union === 0 ? 0 : shared / union);
  }
  return best;
}

/** One posting against the profile. `text` is the posting's description, for keyword exclusions and skills. */
export function matchPosting(posting: JobPosting, profile: JobProfileInput, text: string, options: MatchOptions): MatchResult {
  const { excluded, unknown, flags } = filters(posting, profile, `${posting.title}\n${text}`, options.now, options.rates);
  const profileSkills = new Set(
    profile.skills.map((skill) => options.skills?.lookup(skill.label)?.id ?? `label:${skillTokens(skill.label).join(" ")}`),
  );
  const postingSkills = posting.skills.length > 0 ? posting.skills : (options.skills?.extract(`${posting.title}\n${text}`) ?? []);
  let total = 0;
  let covered = 0;
  const matched: string[] = [];
  const gaps: string[] = [];
  for (const skill of postingSkills) {
    const weight = skill.required ? 2 : 1;
    total += weight;
    if (profileSkills.has(skill.id)) {
      covered += weight;
      matched.push(skill.label);
    } else if (skill.required) gaps.push(skill.label);
  }
  const level = (value: JobPosting["seniority"]): number | undefined => (value === undefined ? undefined : SENIORITIES.indexOf(value));
  const postingLevel = level(posting.seniority);
  const profileLevel = level(profile.seniority);
  const seniority =
    postingLevel === undefined || profileLevel === undefined ? 0.5 : Math.max(0, 1 - Math.abs(postingLevel - profileLevel) / 4);
  const ageDays = posting.postedAt === undefined ? undefined : (Date.parse(options.now) - Date.parse(posting.postedAt)) / 86_400_000;
  const recency = ageDays === undefined ? 0.5 : Math.max(0, Math.min(1, 1 - ageDays / RECENCY_DAYS));
  // Coverage both ways: of what the posting asks (over at least a few skills: one that names two, both yours, is not
  // a perfect fit), and of what you have that it asks for (a posting asking two of your eight is a lesser fit).
  const asked = covered / Math.max(total, SKILLS_FLOOR);
  const yours =
    profileSkills.size === 0
      ? 0
      : new Set(postingSkills.filter((skill) => profileSkills.has(skill.id)).map((skill) => skill.id)).size / profileSkills.size;
  // A posting that asks for several skills, none of them yours, is a lesser fit whatever its title says.
  const unrelated = covered === 0 && postingSkills.length >= UNRELATED_SKILLS ? UNRELATED_DISCOUNT : 1;
  const score =
    unrelated *
    (WEIGHTS.skills * ((asked + yours) / 2) +
      WEIGHTS.title * titleSimilarity(posting.title, profile.titles) +
      WEIGHTS.seniority * seniority +
      WEIGHTS.recency * recency);
  return {
    postingId: posting.postingId,
    outcome: excluded.length > 0 ? "excluded" : unknown.length > 0 ? "maybe" : "fits",
    reasons: excluded.length > 0 ? excluded : unknown,
    score: Math.round(score * 1_000) / 1_000,
    matched,
    gaps,
    flags: [...new Set([...posting.flags, ...flags])],
  };
}

/** Postings against the profile, best first within `fits`, then `maybe`, then `excluded`. */
export function matchPostings(
  postings: readonly { readonly posting: JobPosting; readonly text: string }[],
  profile: JobProfileInput,
  options: MatchOptions,
): MatchResult[] {
  const rank: Readonly<Record<MatchOutcome, number>> = { fits: 0, maybe: 1, excluded: 2 };
  return postings
    .map(({ posting, text }) => matchPosting(posting, profile, text, options))
    .sort((a, b) => rank[a.outcome] - rank[b.outcome] || b.score - a.score);
}

/** Required skills the profile lacks across results, the most often wanted first. */
export function gapsAcross(results: readonly MatchResult[]): { readonly skill: string; readonly postings: number }[] {
  const counts = new Map<string, number>();
  for (const result of results) for (const gap of result.gaps) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  return [...counts]
    .map(([skill, postings]) => ({ skill, postings }))
    .sort((a, b) => b.postings - a.postings || a.skill.localeCompare(b.skill));
}
