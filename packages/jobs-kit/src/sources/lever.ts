import { z } from "zod";

import { JobSourceRecordSchema, type Salary } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { optionalString, readList, regionalTenant, statusOutcome } from "./common.js";
import type { JobSourceAdapter } from "./types.js";

/** Lever's postings API: keyless, per employer, on its US and EU hosts (`eu:acme`). */
export const leverRecord = JobSourceRecordSchema.parse({
  id: "lever",
  name: "Lever",
  countries: ["*"],
  hosts: ["api.lever.co", "api.eu.lever.co"],
  auth: "none",
  kind: "ats",
  tenancy: "per-tenant",
  removeInactive: false,
  personalUse: "silent",
  terms: {
    url: "https://github.com/lever/postings-api",
    reviewedAt: "2026-10-16",
    licence: "employer's public job postings",
    llmUse: "silent",
    cache: { mode: "ttl", days: 60 },
    attribution: "via Lever",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
  fields: { salary: "structured", remote: "structured", posted: true, reqId: false, fullDescription: true },
});

const INTERVALS: Readonly<Record<string, Salary["period"]>> = {
  "per-year-salary": "YEAR",
  "per-month-salary": "MONTH",
  "per-week-salary": "WEEK",
  "per-day-wage": "DAY",
  "per-hour-wage": "HOUR",
};
const WORKPLACES: Readonly<Record<string, "remote" | "hybrid" | "onsite">> = {
  remote: "remote",
  hybrid: "hybrid",
  "on-site": "onsite",
  onsite: "onsite",
};

const PostingSchema = z.looseObject({
  id: z.string().min(1),
  text: z.string().min(1),
  hostedUrl: z.string(),
  applyUrl: optionalString,
  createdAt: z.number().nullish(),
  country: optionalString,
  workplaceType: optionalString,
  description: optionalString,
  descriptionBody: optionalString,
  additional: optionalString,
  lists: z.array(z.looseObject({ text: optionalString, content: optionalString })).nullish(),
  categories: z
    .looseObject({ commitment: optionalString, location: optionalString, allLocations: z.array(z.string()).nullish() })
    .nullish(),
  salaryRange: z
    .looseObject({ min: z.number().nullish(), max: z.number().nullish(), currency: optionalString, interval: optionalString })
    .nullish(),
});

function postingOf(item: unknown, tenant: string): RawPosting {
  const posting = PostingSchema.parse(item);
  const period = posting.salaryRange?.interval === undefined ? undefined : INTERVALS[posting.salaryRange.interval];
  const range = posting.salaryRange;
  const sections = (posting.lists ?? []).map((list) => `<h3>${list.text ?? ""}</h3><ul>${list.content ?? ""}</ul>`).join("");
  const locations = posting.categories?.allLocations ?? (posting.categories?.location === undefined ? [] : [posting.categories.location]);
  return {
    source: "lever",
    sourceRef: `${tenant}/${posting.id}`,
    tenant,
    url: posting.hostedUrl,
    applyUrl: posting.applyUrl,
    title: posting.text,
    company: tenant.replace(/^eu:/, ""),
    locations,
    ...(posting.country === undefined ? {} : { places: [{ country: posting.country.toUpperCase() }] }),
    workplace: posting.workplaceType === undefined ? undefined : WORKPLACES[posting.workplaceType.toLowerCase()],
    descriptionHtml: `${posting.descriptionBody ?? posting.description ?? ""}${sections}${posting.additional ?? ""}`,
    ...(range === null ||
    range === undefined ||
    period === undefined ||
    range.currency === undefined ||
    (range.min ?? range.max) === undefined ||
    (range.min ?? range.max) === null
      ? {}
      : {
          salary: {
            currency: range.currency,
            ...(range.min === undefined || range.min === null ? {} : { min: range.min }),
            ...(range.max === undefined || range.max === null ? {} : { max: range.max }),
            period,
            basis: "unknown" as const,
            origin: "stated" as const,
          },
        }),
    employmentType: posting.categories?.commitment,
    postedAt: posting.createdAt === null || posting.createdAt === undefined ? undefined : new Date(posting.createdAt).toISOString(),
    attribution: `${tenant.replace(/^eu:/, "")} via Lever`,
  };
}

export const lever: JobSourceAdapter = {
  record: leverRecord,
  search: (_query, _call, tenant) => {
    const board = regionalTenant(tenant, ["eu"]);
    if (board === undefined) return [];
    const host = board.region === "eu" ? "api.eu.lever.co" : "api.lever.co";
    return [
      {
        url: `https://${host}/v0/postings/${encodeURIComponent(board.name)}?mode=json`,
        body: "json",
        purpose: "search",
        tenant: board.region === undefined ? board.name : `${board.region}:${board.name}`,
      },
    ];
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    return readList(response.body, (item) => postingOf(item, request.tenant ?? ""), "postings");
  },
};
