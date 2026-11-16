import { DomainSourceRecordSchema, checkDomainSourceRecord } from "@tavi/contracts";
import { KIT_ZOD, objectsOf, type ObjectMode, type Zod } from "@tavi/domain-kit";
import { z } from "zod";

/**
 * The jobs domain's records.
 */

/** A source of postings: the shared record with what jobs needs to know of it. */
export const JobSourceRecordSchema = DomainSourceRecordSchema.extend({
  /** `mcp`: a board's official MCP server; `agent`: postings the agent ingested. */
  kind: z.enum(["ats", "aggregator", "government", "structured", "mcp", "agent"]),
  tenancy: z.enum(["global", "per-tenant"]),
  /** Hours a source holds a posting back before it publishes it (Remotive's 24). */
  delayHours: z.number().int().min(0).max(72).optional(),
  /** A posting the source marks removed is hidden at once (NAV). */
  removeInactive: z.boolean(),
  personalUse: z.enum(["permitted", "silent", "restricted"]),
  fields: z.strictObject({
    salary: z.enum(["structured", "text", "predicted", "none"]),
    remote: z.enum(["structured", "text", "none"]),
    posted: z.boolean(),
    reqId: z.boolean(),
    fullDescription: z.boolean(),
  }),
}).superRefine(checkDomainSourceRecord);
export type JobSourceRecord = z.infer<typeof JobSourceRecordSchema>;

export const SALARY_PERIODS = ["HOUR", "DAY", "WEEK", "MONTH", "YEAR"] as const;

export const SalarySchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  min: z.number().nonnegative().optional(),
  max: z.number().nonnegative().optional(),
  period: z.enum(SALARY_PERIODS),
  basis: z.enum(["gross", "net", "unknown"]),
  /** Only a `stated` salary is held against a floor; a predicted or text one never satisfies it. */
  origin: z.enum(["stated", "predicted", "text"]),
  /** Months paid beyond twelve a year (a 13th or 14th salary). */
  extraMonths: z.number().int().min(0).max(4).optional(),
});
export type Salary = z.infer<typeof SalarySchema>;

/** What a posting is flagged for: a reason to look twice, never a hidden exclusion. */
export const JOB_FLAGS = [
  "hidden-text",
  "injection-suspect",
  "scam:payment",
  "scam:check",
  "scam:id",
  "scam:messaging",
  "scam:free-mail",
  "scam:pay-outlier",
  "ghost:age",
  "ghost:reposted",
  "ghost:evergreen",
  "salary-missing-required",
  "salary-unknown",
  "ai-policy",
] as const;
export const JobFlagSchema = z.enum(JOB_FLAGS);
export type JobFlag = z.infer<typeof JobFlagSchema>;

/** A place, drawn with `zod` (`objectsOf`). */
export const placeInput = (zod: Zod, mode: ObjectMode) =>
  objectsOf(
    zod,
    mode,
  )({
    country: zod.string().length(2).optional(),
    region: zod.string().max(80).optional(),
    city: zod.string().max(80).optional(),
    lat: zod.number().optional(),
    lon: zod.number().optional(),
  });
export const PlaceSchema = placeInput(KIT_ZOD, "strict");
export type Place = z.infer<typeof PlaceSchema>;

export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACTOR", "TEMPORARY", "INTERN", "OTHER"] as const;
export const SENIORITIES = ["intern", "junior", "mid", "senior", "staff", "principal", "manager", "director", "executive"] as const;

export const JobPostingSchema = z.strictObject({
  /** `${source}:${sha256(sourceRef).slice(0, 24)}`. */
  postingId: z.string().min(1).max(80),
  clusterId: z.string().min(1).max(80),
  source: z.string().min(1).max(80),
  sourceRef: z.string().min(1).max(256),
  tenant: z.string().max(128).optional(),
  /** http(s) only: a posting's link is opened, so a `javascript:` one is refused. */
  url: z.url({ protocol: /^https?$/ }).max(2_048),
  applyUrl: z
    .url({ protocol: /^https?$/ })
    .max(2_048)
    .optional(),
  title: z.string().min(1).max(200),
  company: z.string().max(120),
  companyHost: z.string().max(253).optional(),
  places: z.array(PlaceSchema).max(16),
  workplace: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  /** Country codes, region codes (`EMEA`, `EU`, `EUROPE`, `LATAM`, `APAC`, `NA`, `AMER`) or `world`. */
  remoteRegions: z.array(z.string().max(16)).max(32).optional(),
  timezones: z.strictObject({ minUtcOffset: z.number(), maxUtcOffset: z.number() }).optional(),
  salary: SalarySchema.optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  seniority: z.enum(SENIORITIES).optional(),
  postedAt: z.iso.datetime({ offset: true }).optional(),
  validThrough: z.iso.datetime({ offset: true }).optional(),
  reqId: z.string().max(64).optional(),
  /** The reply carries excerpts; the store keeps up to 16 KiB of the description. */
  excerpt: z.string().max(2_000),
  skills: z.array(z.strictObject({ id: z.string().max(80), label: z.string().max(80), required: z.boolean() })).max(64),
  sponsorship: z.enum(["offered", "not-offered", "unknown"]),
  aiPolicy: z.string().max(500).optional(),
  flags: z.array(JobFlagSchema).max(16),
  attribution: z.string().max(200),
});
export type JobPosting = z.infer<typeof JobPostingSchema>;

export const JobQuerySchema = z.strictObject({
  keywords: z.array(z.string().min(1).max(60)).max(10),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(8),
  place: z.strictObject({ city: z.string().max(80), radiusKm: z.number().int().min(0).max(300) }).optional(),
  workplace: z
    .array(z.enum(["remote", "hybrid", "onsite"]))
    .max(3)
    .optional(),
  postedWithinDays: z.number().int().min(1).max(60).default(14),
  /** ATS boards to read: Greenhouse's `acme`, Lever's `acme`, a Workday tenant's site. */
  employers: z
    .array(z.strictObject({ source: z.string().min(1).max(40), tenant: z.string().min(1).max(128) }))
    .max(50)
    .optional(),
  sources: z.array(z.string().min(1).max(40)).max(16).optional(),
});
export type JobQuery = z.infer<typeof JobQuerySchema>;

/** What `match` and `fill_plan` take: read by the model from reviewed memory and passed in; drawn with `zod` (`objectsOf`). */
export const jobProfileInput = (zod: Zod, mode: ObjectMode) => {
  const object = objectsOf(zod, mode);
  return object({
    titles: zod.array(zod.string().max(80)).max(10),
    skills: zod.array(object({ label: zod.string().max(80), years: zod.number().min(0).max(60).optional() })).max(200),
    seniority: zod.enum(SENIORITIES).optional(),
    places: zod.array(placeInput(zod, mode).extend({ radiusKm: zod.number().int().min(0).max(300).optional() })).max(16),
    remote: zod.enum(["only", "prefer", "open", "no"]),
    remoteRegions: zod.array(zod.string().regex(/^[A-Z]{2}$/)).max(32),
    salaryFloor: object({
      currency: zod.string().regex(/^[A-Z]{3}$/),
      amount: zod.number().positive(),
      period: zod.enum(SALARY_PERIODS),
    }).optional(),
    employmentTypes: zod.array(zod.enum(EMPLOYMENT_TYPES)).max(6),
    exclusions: object({ companies: zod.array(zod.string().max(120)).max(200), keywords: zod.array(zod.string().max(60)).max(100) }),
    /** Countries where the person needs sponsorship; never a status. */
    needsSponsorship: zod.array(zod.string().regex(/^[A-Z]{2}$/)).max(10),
  });
};
export const JobProfileInputSchema = jobProfileInput(KIT_ZOD, "strict");
export type JobProfileInput = z.infer<typeof JobProfileInputSchema>;

/** The fewest hours between a watch's sweeps: the heartbeat's own page interval. */
export const WATCH_CADENCE_MIN_HOURS = 1;

/**
 * A watch (`watch`): a query swept in the worker without a model,
 * matched against `criteria`, a snapshot of the profile taken when the person
 * approved it, because sweeps run without memory.
 */
export const JobWatchInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  query: JobQuerySchema,
  criteria: JobProfileInputSchema,
  /** Hours between sweeps. */
  cadence: z.number().int().min(WATCH_CADENCE_MIN_HOURS).max(168).default(24),
  /** The lowest score a fitting posting needs to be a hit. */
  minScore: z.number().min(0).max(1).default(0.3),
  /** When the person wants a digest: the agent makes the schedule. */
  digest: z
    .strictObject({
      at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      timezone: z.string().min(1).max(64),
      deliverTo: z.string().min(1).max(120),
    })
    .optional(),
});
export type JobWatchInput = z.infer<typeof JobWatchInputSchema>;

export interface JobWatch extends JobWatchInput {
  readonly watchId: string;
  readonly enabled: boolean;
  readonly nextRunAt: string;
  readonly lastRunAt?: string;
  /** The last sweep's result, in a few words. */
  readonly lastOutcome?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JobHit {
  readonly watchId: string;
  readonly clusterId: string;
  readonly postingId: string;
  readonly score: number;
  readonly firstSeen: string;
  readonly deliveredAt?: string;
}

export const JOB_APPLICATION_STATES = ["saved", "staged", "applied", "interviewing", "offer", "rejected", "withdrawn", "archived"] as const;
export type JobApplicationState = (typeof JOB_APPLICATION_STATES)[number];
