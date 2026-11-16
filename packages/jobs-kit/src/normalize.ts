import { htmlToTextDetailed, normaliseUntrustedText } from "@tavi/contracts";

import { EMPLOYMENT_TYPES, JobPostingSchema, type JobPosting, type Place, type Salary } from "./contracts.js";
import { postingIdOf } from "./dedup.js";
import { aiPolicyOf, flagsOf } from "./flags.js";
import { placesOf, workplaceOf } from "./places.js";
import { salaryFromText } from "./salary.js";
import type { SkillIndex } from "./skills.js";

/**
 * One source's posting as Tavi's: what an adapter read, as the fields
 * every source shares. The description is untrusted throughout: what the page
 * hid from a reader is dropped and flagged, forged fences and chat
 * tokens are quoted (`normaliseUntrustedText`), and nothing in it decides more
 * than a flag.
 */
export interface RawPosting {
  readonly source: string;
  readonly sourceRef: string;
  readonly tenant?: string | undefined;
  readonly url: string;
  readonly applyUrl?: string | undefined;
  readonly title: string;
  readonly company: string;
  readonly companyHost?: string | undefined;
  /** Location strings as the source writes them, or places it already split. */
  readonly locations?: readonly string[] | undefined;
  readonly places?: readonly Place[] | undefined;
  /** What the source's own field says, when it has one. */
  readonly workplace?: "remote" | "hybrid" | "onsite" | undefined;
  readonly remoteRegions?: readonly string[] | undefined;
  readonly descriptionHtml?: string | undefined;
  readonly descriptionText?: string | undefined;
  /** A structured salary; without one, a range the text states is read, as `text`. */
  readonly salary?: Salary | undefined;
  readonly employmentType?: string | undefined;
  readonly postedAt?: string | undefined;
  readonly validThrough?: string | undefined;
  readonly reqId?: string | undefined;
  /** The source's own seniority field; a title's words are read when it has none. */
  readonly seniority?: JobPosting["seniority"];
  /** The UTC offsets a remote posting restricts to (Himalayas'). */
  readonly timezones?: { readonly minUtcOffset: number; readonly maxUtcOffset: number } | undefined;
  readonly attribution: string;
}

export interface NormalizedPosting {
  readonly posting: JobPosting;
  /** The description as a reader sees it, up to 16 KiB, for the store. */
  readonly description: string;
}

/** The most of a description the store keeps. */
export const DESCRIPTION_MAX_CHARS = 16_384;

const EMPLOYMENT_WORDS: readonly (readonly [RegExp, JobPosting["employmentType"]])[] = [
  [/\b(intern(ship)?|praktikum|stage|trainee|werkstudent)\b/i, "INTERN"],
  [/\b(contract(or)?|freelance|consultant|b2b)\b/i, "CONTRACTOR"],
  [/\b(temp(orary)?|fixed[- ]term|befristet|seasonal)\b/i, "TEMPORARY"],
  [/\b(part[- ]?time|teilzeit|temps partiel)\b/i, "PART_TIME"],
  [/\b(full[- ]?time|permanent|vollzeit|temps plein|cdi|regular)\b/i, "FULL_TIME"],
];

/**
 * A term the title or text gives when the source gives none: "(Contract)",
 * "Ausbildung" or "12 month FTC" in a title, "a fixed-term contract" or "maternity cover" in
 * the text. Only those exact phrases: "contract negotiation" is a skill.
 */
function employmentTermOf(title: string, description: string): JobPosting["employmentType"] {
  if (/\b(ausbildung|apprentice(ship)?|trainee(ship)?|internship|intern|praktikum|praktikant(in)?|werkstudent(in)?)\b/i.test(title))
    return "INTERN";
  if (
    /\b(contract|contractor|freelance)\b/i.test(title) &&
    !/\bcontract (manager|management|specialist|analyst|administrator|counsel|lawyer|negotiat)/i.test(title)
  )
    return "CONTRACTOR";
  if (/\b(FTC|fixed[- ]term|temporary|temp|maternity cover)\b/i.test(title)) return "TEMPORARY";
  if (
    /\b(fixed[- ]term (contract|role|position|basis)|maternity (leave )?cover|\d{1,2}[- ]months? (fixed[- ]term|FTC|contract))\b/i.test(
      description,
    )
  )
    return "TEMPORARY";
  return undefined;
}

/** A source's employment type ("Full-time", "FULL_TIME", "Contract") as schema.org's. */
export function employmentTypeOf(text: string | undefined): JobPosting["employmentType"] {
  if (text === undefined || text.trim() === "") return undefined;
  const upper = text
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if ((EMPLOYMENT_TYPES as readonly string[]).includes(upper)) return upper as JobPosting["employmentType"];
  return EMPLOYMENT_WORDS.find(([words]) => words.test(text))?.[1] ?? "OTHER";
}

const SENIORITY_WORDS: readonly (readonly [RegExp, NonNullable<JobPosting["seniority"]>])[] = [
  [/\b(intern|internship|praktikant|werkstudent)\b/i, "intern"],
  [/\b(chief|cto|ceo|cfo|coo|cpo|vp|vice president|head of)\b/i, "executive"],
  [/\bdirector\b/i, "director"],
  [/\bprincipal\b|\bdistinguished\b/i, "principal"],
  [/\bstaff\b/i, "staff"],
  [/\b(senior|sr\.?|lead|iii|iv)\b/i, "senior"],
  [/\bmanager\b/i, "manager"],
  [/\b(junior|jr\.?|entry[- ]level|graduate|associate|i)\b/i, "junior"],
  [/\b(mid[- ]?level|intermediate|ii)\b/i, "mid"],
];

/** The seniority a title states, if it states one. */
export function seniorityOf(title: string): JobPosting["seniority"] {
  return SENIORITY_WORDS.find(([words]) => words.test(title))?.[1];
}

/** Whether a description offers visa sponsorship, refuses it, or says nothing. */
export function sponsorshipOf(text: string): JobPosting["sponsorship"] {
  if (
    /\b(not|no|unable to|cannot|can't|won't|will not|do not|does not)\b[^.\n]{0,40}\b(sponsor|sponsorship)\b|\bwithout (visa )?sponsorship\b|\bsponsorship (is )?not (available|offered|provided)\b/i.test(
      text,
    )
  )
    return "not-offered";
  if (/\b(visa )?sponsorship (is )?(available|offered|provided)\b|\b(we|will|can) (offer |provide )?(visa )?sponsor(ship)?\b/i.test(text))
    return "offered";
  return "unknown";
}

/** A date as an ISO datetime with an offset; `undefined` for one that does not parse. */
export function isoDateTime(value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * One raw posting as Tavi's; throws when what the adapter read cannot be one
 * (a missing title, a URL that is not http(s)). With `skills`, the skills its
 * visible text names are read in.
 */
export function normalizePosting(raw: RawPosting, now: string, options: { readonly skills?: SkillIndex } = {}): NormalizedPosting {
  const read =
    raw.descriptionHtml !== undefined
      ? htmlToTextDetailed(raw.descriptionHtml, { base: raw.url, dropHidden: true })
      : { text: raw.descriptionText ?? "", hiddenText: "" };
  const description = normaliseUntrustedText(read.text).slice(0, DESCRIPTION_MAX_CHARS);
  const title = normaliseUntrustedText(raw.title.replace(/\s+/g, " ").trim()).slice(0, 200);
  const located = placesOf(raw.locations ?? []);
  const places = [...(raw.places ?? []), ...located.places].slice(0, 16);
  // A place says where, not how: a posting that never says it is on site may be hybrid or remote, so it stays unknown.
  const workplace = raw.workplace ?? located.workplace ?? workplaceOf(title) ?? "unknown";
  const remoteRegions = [...new Set([...(raw.remoteRegions ?? []), ...located.remoteRegions])].slice(0, 32);
  const postedAt = isoDateTime(raw.postedAt);
  const salary = raw.salary ?? salaryFromText(description);
  const aiPolicy = aiPolicyOf(description);
  const posting: JobPosting = {
    postingId: postingIdOf(raw.source, raw.sourceRef),
    clusterId: postingIdOf(raw.source, raw.sourceRef),
    source: raw.source,
    sourceRef: raw.sourceRef.slice(0, 256),
    ...(raw.tenant === undefined ? {} : { tenant: raw.tenant.slice(0, 128) }),
    url: raw.url,
    ...(raw.applyUrl === undefined ? {} : { applyUrl: raw.applyUrl }),
    title,
    company: normaliseUntrustedText(raw.company.replace(/\s+/g, " ").trim()).slice(0, 120),
    ...(raw.companyHost === undefined ? {} : { companyHost: raw.companyHost.slice(0, 253) }),
    places,
    workplace,
    ...(workplace === "remote" || remoteRegions.length > 0 ? { remoteRegions } : {}),
    ...(salary === undefined ? {} : { salary }),
    // A term the posting states (an apprenticeship, a fixed term, a contract) over the hours a source gives ("full-time").
    ...((employmentTermOf(title, description) ?? employmentTypeOf(raw.employmentType)) === undefined
      ? {}
      : { employmentType: employmentTermOf(title, description) ?? employmentTypeOf(raw.employmentType) }),
    ...((raw.seniority ?? seniorityOf(title)) === undefined ? {} : { seniority: raw.seniority ?? seniorityOf(title) }),
    ...(raw.timezones === undefined
      ? {}
      : { timezones: { minUtcOffset: raw.timezones.minUtcOffset, maxUtcOffset: raw.timezones.maxUtcOffset } }),
    ...(postedAt === undefined ? {} : { postedAt }),
    ...(isoDateTime(raw.validThrough) === undefined ? {} : { validThrough: isoDateTime(raw.validThrough) }),
    ...(raw.reqId === undefined || raw.reqId === "" ? {} : { reqId: raw.reqId.slice(0, 64) }),
    excerpt: description.slice(0, 2_000),
    skills: options.skills?.extract(`${title}\n${description}`) ?? [],
    sponsorship: sponsorshipOf(description),
    ...(aiPolicy === undefined ? {} : { aiPolicy }),
    flags: flagsOf({ title, description, hiddenText: read.hiddenText, postedAt, now, places, salary }),
    attribution: raw.attribution.slice(0, 200),
  };
  return { posting: JobPostingSchema.parse(posting), description };
}
