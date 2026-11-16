import { z } from "zod";

import { JobSourceRecordSchema } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { salaryFromText } from "../salary.js";
import { optionalString, readList, statusOutcome, tenantOf } from "./common.js";
import type { JobSourceAdapter } from "./types.js";

/** Breezy HR's public positions feed: per company subdomain, keyless, no description in the list. */
export const breezyRecord = JobSourceRecordSchema.parse({
  id: "breezy",
  name: "Breezy HR",
  countries: ["*"],
  hosts: ["*.breezy.hr"],
  auth: "none",
  kind: "ats",
  tenancy: "per-tenant",
  removeInactive: false,
  personalUse: "silent",
  terms: {
    url: "https://breezy.hr/terms",
    reviewedAt: "2026-10-16",
    licence: "employer's public careers site",
    llmUse: "silent",
    cache: { mode: "ttl", days: 60 },
    attribution: "via Breezy HR",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
  fields: { salary: "text", remote: "structured", posted: true, reqId: false, fullDescription: false },
});

const LocationSchema = z.looseObject({
  country: z.looseObject({ id: optionalString }).nullish(),
  state: z.looseObject({ id: optionalString }).nullish(),
  city: optionalString,
  is_remote: z.boolean().nullish(),
});
const PositionSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string(),
  published_date: optionalString,
  type: z.looseObject({ name: optionalString }).nullish(),
  salary: optionalString,
  company: z.looseObject({ name: optionalString }).nullish(),
  location: LocationSchema.nullish(),
  locations: z.array(LocationSchema).nullish(),
});

function postingOf(item: unknown, tenant: string): RawPosting {
  const position = PositionSchema.parse(item);
  const locations = position.locations ?? (position.location === null || position.location === undefined ? [] : [position.location]);
  const remote = locations.some((location) => location.is_remote === true);
  const salary = position.salary === undefined ? undefined : salaryFromText(`Salary ${position.salary}`);
  return {
    source: "breezy",
    sourceRef: `${tenant}/${position.id}`,
    tenant,
    url: position.url,
    title: position.name,
    company: position.company?.name ?? tenant,
    places: locations
      .filter((location) => location.is_remote !== true)
      .map((location) => ({
        ...(location.country?.id === undefined ? {} : { country: location.country.id.toUpperCase() }),
        ...(location.state?.id === undefined ? {} : { region: location.state.id }),
        ...(location.city === undefined ? {} : { city: location.city.slice(0, 80) }),
      })),
    ...(remote
      ? {
          workplace: "remote" as const,
          remoteRegions: locations
            .filter((location) => location.is_remote === true && location.country?.id !== undefined)
            .map((location) => (location.country?.id ?? "").toUpperCase()),
        }
      : {}),
    descriptionText: position.salary ?? "",
    ...(salary === undefined ? {} : { salary }),
    employmentType: position.type?.name,
    postedAt: position.published_date,
    attribution: `${position.company?.name ?? tenant} via Breezy HR`,
  };
}

export const breezy: JobSourceAdapter = {
  record: breezyRecord,
  search: (_query, _call, tenant) => {
    const company = tenantOf(tenant);
    return company === undefined || company.includes(".")
      ? []
      : [{ url: `https://${company}.breezy.hr/json`, body: "json", purpose: "search", tenant: company }];
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    return readList(response.body, (item) => postingOf(item, request.tenant ?? ""), "positions");
  },
};
