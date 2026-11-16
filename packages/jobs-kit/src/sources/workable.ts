import { z } from "zod";

import { JobSourceRecordSchema } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { optionalString, readList, statusOutcome, tenantOf } from "./common.js";
import type { JobSourceAdapter } from "./types.js";

/** Workable's careers widget API: an account's published jobs, keyless, descriptions with `details=true`. */
export const workableRecord = JobSourceRecordSchema.parse({
  id: "workable",
  name: "Workable",
  countries: ["*"],
  hosts: ["apply.workable.com"],
  auth: "none",
  kind: "ats",
  tenancy: "per-tenant",
  removeInactive: false,
  personalUse: "silent",
  terms: {
    url: "https://www.workable.com/terms-of-service",
    reviewedAt: "2026-10-16",
    licence: "employer's public careers page",
    llmUse: "silent",
    cache: { mode: "ttl", days: 60 },
    attribution: "via Workable",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
  fields: { salary: "none", remote: "structured", posted: true, reqId: false, fullDescription: true },
});

const JobSchema = z.looseObject({
  shortcode: z.string().min(1),
  title: z.string().min(1),
  url: z.string(),
  application_url: optionalString,
  telecommuting: z.boolean().nullish(),
  employment_type: optionalString,
  published_on: optionalString,
  description: optionalString,
  locations: z
    .array(z.looseObject({ countryCode: optionalString, city: optionalString, region: optionalString, hidden: z.boolean().nullish() }))
    .nullish(),
});

function postingOf(item: unknown, tenant: string, company: string): RawPosting {
  const job = JobSchema.parse(item);
  const locations = (job.locations ?? []).filter((location) => location.hidden !== true);
  return {
    source: "workable",
    sourceRef: `${tenant}/${job.shortcode}`,
    tenant,
    url: job.url,
    applyUrl: job.application_url,
    title: job.title,
    company,
    places: locations.map((location) => ({
      ...(location.countryCode === undefined ? {} : { country: location.countryCode.toUpperCase() }),
      ...(location.region === undefined ? {} : { region: location.region.slice(0, 80) }),
      ...(location.city === undefined ? {} : { city: location.city.slice(0, 80) }),
    })),
    ...(job.telecommuting === true ? { workplace: "remote" as const } : {}),
    descriptionHtml: job.description ?? "",
    employmentType: job.employment_type,
    postedAt: job.published_on === undefined ? undefined : `${job.published_on}T00:00:00Z`,
    attribution: `${company} via Workable`,
  };
}

export const workable: JobSourceAdapter = {
  record: workableRecord,
  search: (_query, _call, tenant) => {
    const account = tenantOf(tenant);
    return account === undefined
      ? []
      : [
          {
            url: `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}?details=true`,
            body: "json",
            purpose: "search",
            tenant: account,
          },
        ];
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const body = response.body as { readonly jobs?: unknown; readonly name?: unknown } | null;
    const tenant = request.tenant ?? "";
    const company = typeof body?.name === "string" && body.name.trim() !== "" ? body.name.trim().slice(0, 120) : tenant;
    return readList(body?.jobs, (item) => postingOf(item, tenant, company), "jobs");
  },
};
