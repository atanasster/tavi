import { z } from "zod";

import { JobSourceRecordSchema, type Salary } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { optionalString, readList, statusOutcome, tenantOf } from "./common.js";
import type { JobSourceAdapter } from "./types.js";

/** Ashby's public job posting API: keyless, per employer, with pay components. */
export const ashbyRecord = JobSourceRecordSchema.parse({
  id: "ashby",
  name: "Ashby",
  countries: ["*"],
  hosts: ["api.ashbyhq.com"],
  auth: "none",
  kind: "ats",
  tenancy: "per-tenant",
  removeInactive: false,
  personalUse: "silent",
  terms: {
    url: "https://developers.ashbyhq.com/docs/public-job-posting-api",
    reviewedAt: "2026-10-16",
    licence: "employer's public job board",
    llmUse: "silent",
    cache: { mode: "ttl", days: 60 },
    attribution: "via Ashby",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
  fields: { salary: "structured", remote: "structured", posted: true, reqId: false, fullDescription: true },
});

const INTERVALS: Readonly<Record<string, Salary["period"]>> = {
  "1 YEAR": "YEAR",
  "1 MONTH": "MONTH",
  "1 WEEK": "WEEK",
  "1 DAY": "DAY",
  "1 HOUR": "HOUR",
};
const WORKPLACES: Readonly<Record<string, "remote" | "hybrid" | "onsite">> = { Remote: "remote", Hybrid: "hybrid", OnSite: "onsite" };
const EMPLOYMENT: Readonly<Record<string, string>> = {
  FullTime: "FULL_TIME",
  PartTime: "PART_TIME",
  Intern: "INTERN",
  Contract: "CONTRACTOR",
  Temporary: "TEMPORARY",
};

const ComponentSchema = z.looseObject({
  compensationType: optionalString,
  interval: optionalString,
  currencyCode: optionalString,
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
});
const JobSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  jobUrl: z.string(),
  applyUrl: optionalString,
  location: optionalString,
  secondaryLocations: z.array(z.looseObject({ location: optionalString })).nullish(),
  isListed: z.boolean().nullish(),
  isRemote: z.boolean().nullish(),
  workplaceType: optionalString,
  employmentType: optionalString,
  publishedAt: optionalString,
  descriptionHtml: optionalString,
  compensation: z.looseObject({ summaryComponents: z.array(ComponentSchema).nullish() }).nullish(),
});

/** The salary component, when it names a currency, a period this reads and an amount. */
function salaryOf(component: z.infer<typeof ComponentSchema>): Salary | undefined {
  const currency = component.currencyCode;
  const period = component.interval === undefined ? undefined : INTERVALS[component.interval];
  const min = component.minValue ?? undefined;
  const max = component.maxValue ?? undefined;
  if (component.compensationType !== "Salary" || currency === undefined || period === undefined || (min === undefined && max === undefined))
    return undefined;
  return {
    currency,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    period,
    basis: "unknown",
    origin: "stated",
  };
}

function postingOf(item: unknown, tenant: string): RawPosting | undefined {
  const job = JobSchema.parse(item);
  // Ashby lists unlisted jobs with a flag; they are not open to the public.
  if (job.isListed === false) return undefined;
  const salary = (job.compensation?.summaryComponents ?? []).map(salaryOf).find((each) => each !== undefined);
  return {
    source: "ashby",
    sourceRef: `${tenant}/${job.id}`,
    tenant,
    url: job.jobUrl,
    applyUrl: job.applyUrl,
    title: job.title,
    company: tenant,
    locations: [job.location, ...(job.secondaryLocations ?? []).map((each) => each.location)].filter(
      (each): each is string => each !== undefined,
    ),
    workplace: job.workplaceType === undefined ? (job.isRemote === true ? "remote" : undefined) : WORKPLACES[job.workplaceType],
    descriptionHtml: job.descriptionHtml,
    ...(salary === undefined ? {} : { salary }),
    employmentType: job.employmentType === undefined ? undefined : (EMPLOYMENT[job.employmentType] ?? job.employmentType),
    postedAt: job.publishedAt,
    attribution: `${tenant} via Ashby`,
  };
}

export const ashby: JobSourceAdapter = {
  record: ashbyRecord,
  search: (_query, _call, tenant) => {
    const board = tenantOf(tenant);
    return board === undefined
      ? []
      : [
          {
            url: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`,
            body: "json",
            purpose: "search",
            tenant: board,
          },
        ];
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const body = response.body as { readonly jobs?: unknown } | null;
    const tenant = request.tenant ?? "";
    // An unlisted job is not drift: count it neither way.
    const jobs = Array.isArray(body?.jobs)
      ? body.jobs.filter((job: unknown) => (job as { readonly isListed?: unknown } | null)?.isListed !== false)
      : body?.jobs;
    return readList(jobs, (item) => postingOf(item, tenant), "jobs");
  },
};
