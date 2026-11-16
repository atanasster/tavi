import { z } from "zod";

import { JobSourceRecordSchema, type Salary } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { optionalString, readList, statusOutcome, tenantOf } from "./common.js";
import type { JobSourceAdapter } from "./types.js";

/** Recruitee's careers site API: keyless, per company subdomain. */
export const recruiteeRecord = JobSourceRecordSchema.parse({
  id: "recruitee",
  name: "Recruitee",
  countries: ["*"],
  hosts: ["*.recruitee.com"],
  auth: "none",
  kind: "ats",
  tenancy: "per-tenant",
  removeInactive: false,
  personalUse: "silent",
  terms: {
    url: "https://support.recruitee.com/en/articles/1066282",
    reviewedAt: "2026-10-16",
    licence: "employer's public careers site",
    llmUse: "silent",
    cache: { mode: "ttl", days: 60 },
    attribution: "via Recruitee",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
  fields: { salary: "structured", remote: "structured", posted: true, reqId: false, fullDescription: true },
});

const PERIODS: Readonly<Record<string, Salary["period"]>> = {
  year: "YEAR",
  yearly: "YEAR",
  month: "MONTH",
  monthly: "MONTH",
  week: "WEEK",
  day: "DAY",
  hour: "HOUR",
  hourly: "HOUR",
};
const EMPLOYMENT: Readonly<Record<string, string>> = {
  fulltime: "FULL_TIME",
  fulltime_permanent: "FULL_TIME",
  fulltime_fixed_term: "TEMPORARY",
  parttime: "PART_TIME",
  parttime_permanent: "PART_TIME",
  parttime_fixed_term: "TEMPORARY",
  internship: "INTERN",
  freelance: "CONTRACTOR",
  contract: "CONTRACTOR",
  temporary: "TEMPORARY",
};

const OfferSchema = z.looseObject({
  id: z.number().int(),
  title: z.string().min(1),
  careers_url: z.string(),
  careers_apply_url: optionalString,
  company_name: optionalString,
  location: optionalString,
  locations: z
    .array(z.looseObject({ city: optionalString, state: optionalString, country: optionalString, country_code: optionalString }))
    .nullish(),
  country_code: optionalString,
  city: optionalString,
  remote: z.boolean().nullish(),
  hybrid: z.boolean().nullish(),
  on_site: z.boolean().nullish(),
  description: optionalString,
  requirements: optionalString,
  published_at: optionalString,
  created_at: optionalString,
  employment_type_code: optionalString,
  salary: z
    .looseObject({
      min: z.union([z.number(), z.string()]).nullish(),
      max: z.union([z.number(), z.string()]).nullish(),
      period: optionalString,
      currency: optionalString,
    })
    .nullish(),
});

const amount = (value: number | string | null | undefined): number | undefined => {
  const number = typeof value === "string" ? Number(value) : value;
  return number === null || number === undefined || !Number.isFinite(number) || number <= 0 ? undefined : number;
};
/** "2026-10-15 09:31:36 UTC" as ISO. */
const recruiteeDate = (value: string | undefined): string | undefined => value?.replace(" UTC", "Z").replace(" ", "T");

function postingOf(item: unknown, tenant: string): RawPosting {
  const offer = OfferSchema.parse(item);
  const period = offer.salary?.period === undefined ? undefined : PERIODS[offer.salary.period.toLowerCase()];
  const min = amount(offer.salary?.min);
  const max = amount(offer.salary?.max);
  const places = (offer.locations ?? []).map((place) => ({
    ...(place.country_code === undefined ? {} : { country: place.country_code.toUpperCase() }),
    ...(place.state === undefined ? {} : { region: place.state.slice(0, 80) }),
    ...(place.city === undefined ? {} : { city: place.city.slice(0, 80) }),
  }));
  return {
    source: "recruitee",
    sourceRef: `${tenant}/${String(offer.id)}`,
    tenant,
    url: offer.careers_url,
    applyUrl: offer.careers_apply_url,
    title: offer.title,
    company: offer.company_name ?? tenant,
    ...(places.length > 0
      ? { places }
      : offer.country_code === undefined
        ? { locations: offer.location === undefined ? [] : [offer.location] }
        : { places: [{ country: offer.country_code.toUpperCase(), ...(offer.city === undefined ? {} : { city: offer.city }) }] }),
    workplace: offer.remote === true ? "remote" : offer.hybrid === true ? "hybrid" : offer.on_site === true ? "onsite" : undefined,
    descriptionHtml: `${offer.description ?? ""}${offer.requirements ?? ""}`,
    ...(period === undefined || offer.salary?.currency === undefined || (min ?? max) === undefined
      ? {}
      : {
          salary: {
            currency: offer.salary.currency.toUpperCase(),
            ...(min === undefined ? {} : { min }),
            ...(max === undefined ? {} : { max }),
            period,
            basis: "unknown" as const,
            origin: "stated" as const,
          },
        }),
    employmentType:
      offer.employment_type_code === undefined ? undefined : (EMPLOYMENT[offer.employment_type_code] ?? offer.employment_type_code),
    postedAt: recruiteeDate(offer.published_at ?? offer.created_at),
    attribution: `${offer.company_name ?? tenant} via Recruitee`,
  };
}

export const recruitee: JobSourceAdapter = {
  record: recruiteeRecord,
  search: (_query, _call, tenant) => {
    const company = tenantOf(tenant);
    // A subdomain: no dots of its own.
    return company === undefined || company.includes(".")
      ? []
      : [{ url: `https://${company}.recruitee.com/api/offers/`, body: "json", purpose: "search", tenant: company }];
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    return readList(
      (response.body as { readonly offers?: unknown } | null)?.offers,
      (item) => postingOf(item, request.tenant ?? ""),
      "offers",
    );
  },
};
