import { z } from "zod";

import { JobSourceRecordSchema, type Salary } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { countryCode } from "../places.js";
import { keywordsText, optionalString, readList, statusOutcome } from "./common.js";
import type { JobSourceAdapter } from "./types.js";

/**
 * Himalayas' remote jobs API: keyless from a shared pool,
 * or with the person's free key; link back and name Himalayas; never resubmit
 * its postings to other boards.
 */
export const himalayasRecord = JobSourceRecordSchema.parse({
  id: "himalayas",
  name: "Himalayas",
  countries: ["*"],
  hosts: ["himalayas.app"],
  auth: "public-token",
  credential: ["himalayasKey"],
  kind: "aggregator",
  tenancy: "global",
  removeInactive: false,
  personalUse: "permitted",
  terms: {
    url: "https://himalayas.app/api",
    reviewedAt: "2026-10-16",
    licence: "Himalayas API terms",
    llmUse: "silent",
    cache: { mode: "ttl", days: 30 },
    attribution: "Remote jobs from Himalayas",
    displayRules: ["Link back to the posting on Himalayas and name Himalayas", "Never resubmit its postings to another board"],
    userTriggeredOnly: false,
  },
  // Keyed: 60 a minute, 10,000 a day.
  budget: { perSecond: 1, perDay: 10_000 },
  fields: { salary: "structured", remote: "structured", posted: true, reqId: false, fullDescription: true },
});

const PERIODS: Readonly<Record<string, Salary["period"]>> = {
  hourly: "HOUR",
  hour: "HOUR",
  daily: "DAY",
  weekly: "WEEK",
  monthly: "MONTH",
  month: "MONTH",
  yearly: "YEAR",
  annual: "YEAR",
  annually: "YEAR",
  year: "YEAR",
};
/** Himalayas' seniority words; a posting open to several takes the first it lists. */
const SENIORITY: Readonly<Record<string, NonNullable<RawPosting["seniority"]>>> = {
  "Entry-level": "junior",
  "Mid-level": "mid",
  Senior: "senior",
  Manager: "manager",
  Director: "director",
  Executive: "executive",
};

const JobSchema = z.looseObject({
  title: z.string().min(1),
  companyName: optionalString,
  guid: z.string().min(1),
  applicationLink: optionalString,
  description: optionalString,
  employmentType: optionalString,
  minSalary: z.union([z.number(), z.string()]).nullish(),
  maxSalary: z.union([z.number(), z.string()]).nullish(),
  currency: optionalString,
  salaryPeriod: optionalString,
  seniority: z.array(z.string()).nullish(),
  locationRestrictions: z.array(z.string()).nullish(),
  timezoneRestrictions: z.array(z.number()).nullish(),
  pubDate: z.union([z.number(), z.string()]).nullish(),
  expiryDate: z.union([z.number(), z.string()]).nullish(),
});

const number = (value: number | string | null | undefined): number | undefined => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return parsed === null || parsed === undefined || !Number.isFinite(parsed) || parsed <= 0 ? undefined : parsed;
};
/** Unix seconds, as Himalayas sends them, as an ISO time. */
const seconds = (value: number | string | null | undefined): string | undefined => {
  const parsed = number(value);
  return parsed === undefined ? undefined : new Date(parsed * 1_000).toISOString();
};

function postingOf(item: unknown): RawPosting {
  const job = JobSchema.parse(item);
  const min = number(job.minSalary);
  const max = number(job.maxSalary);
  const period = job.salaryPeriod === undefined ? undefined : PERIODS[job.salaryPeriod.toLowerCase()];
  const restrictions = job.locationRestrictions ?? [];
  // No restriction is anywhere; a restriction it cannot read is not read as anywhere.
  const regions =
    restrictions.length === 0
      ? ["world"]
      : restrictions.map((name) => countryCode(name)).filter((code): code is string => code !== undefined);
  const zones = job.timezoneRestrictions ?? [];
  const seniority = (job.seniority ?? []).map((word) => SENIORITY[word]).find((level) => level !== undefined);
  return {
    source: "himalayas",
    sourceRef: job.guid,
    url: job.guid,
    applyUrl: job.applicationLink,
    title: job.title,
    company: job.companyName ?? "",
    workplace: "remote",
    remoteRegions: regions,
    descriptionHtml: job.description,
    ...((min === undefined && max === undefined) || period === undefined || job.currency === undefined
      ? {}
      : {
          salary: {
            currency: job.currency.toUpperCase(),
            ...(min === undefined ? {} : { min }),
            ...(max === undefined ? {} : { max }),
            period,
            basis: "unknown" as const,
            origin: "stated" as const,
          },
        }),
    employmentType: job.employmentType,
    postedAt: seconds(job.pubDate),
    validThrough: seconds(job.expiryDate),
    attribution: "Remote jobs from Himalayas",
    ...(zones.length === 0 ? {} : { timezones: { minUtcOffset: Math.min(...zones), maxUtcOffset: Math.max(...zones) } }),
    ...(seniority === undefined ? {} : { seniority }),
  };
}

export const himalayas: JobSourceAdapter = {
  record: himalayasRecord,
  search: (query, call) => {
    const key = call.credential("himalayasKey");
    const countries = query.countries.length === 0 ? [undefined] : query.countries;
    return countries.map((country) => {
      const params = new URLSearchParams({
        ...(query.keywords.length === 0 ? {} : { q: keywordsText(query.keywords) }),
        ...(country === undefined ? {} : { country }),
      });
      return {
        url: `https://himalayas.app/jobs/api/search?${params.toString()}`,
        ...(key === undefined ? {} : { headers: { Authorization: `Bearer ${key}` } }),
        body: "json" as const,
        purpose: "search" as const,
      };
    });
  },
  parse: (response, _request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    return readList((response.body as { readonly jobs?: unknown } | null)?.jobs, postingOf, "jobs");
  },
};
