import { z } from "zod";

import { JobSourceRecordSchema, type Salary } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { keywordsText, optionalString, readList, statusOutcome, utcTime as utc } from "./common.js";
import type { JobSourceAdapter, SourceRequest } from "./types.js";

/**
 * USAJOBS' search API: US federal jobs, with the
 * person's key in `Authorization-Key` and their registered email as
 * `User-Agent`, which the API requires.
 */
export const usajobsRecord = JobSourceRecordSchema.parse({
  id: "usajobs",
  name: "USAJOBS",
  countries: ["US"],
  hosts: ["data.usajobs.gov"],
  auth: "key-header",
  credential: ["usajobsKey"],
  kind: "government",
  tenancy: "global",
  removeInactive: false,
  personalUse: "permitted",
  terms: {
    url: "https://developer.usajobs.gov/",
    reviewedAt: "2026-10-16",
    licence: "US federal government data",
    llmUse: "silent",
    cache: { mode: "ttl", days: 30 },
    attribution: "Jobs from USAJOBS",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 1_000 },
  fields: { salary: "structured", remote: "structured", posted: true, reqId: true, fullDescription: false },
});

/** USAJOBS' rate interval codes; bi-weekly pay is read as a week's at half. */
const INTERVALS: Readonly<Record<string, { readonly period: Salary["period"]; readonly factor: number }>> = {
  PA: { period: "YEAR", factor: 1 },
  PH: { period: "HOUR", factor: 1 },
  PD: { period: "DAY", factor: 1 },
  PW: { period: "WEEK", factor: 1 },
  BW: { period: "WEEK", factor: 0.5 },
  PM: { period: "MONTH", factor: 1 },
};
const PAGE = 100;
/** The most pages one search reads. */
export const USAJOBS_MAX_PAGES = 3;

const ItemSchema = z.looseObject({
  MatchedObjectId: z.union([z.string(), z.number()]),
  MatchedObjectDescriptor: z.looseObject({
    PositionID: optionalString,
    PositionTitle: z.string().min(1),
    PositionURI: z.string(),
    ApplyURI: z.array(z.string()).nullish(),
    PositionLocation: z
      .array(
        z.looseObject({
          LocationName: optionalString,
          CountrySubDivisionCode: optionalString,
          CityName: optionalString,
          Latitude: z.number().nullish(),
          Longitude: z.number().nullish(),
        }),
      )
      .nullish(),
    OrganizationName: optionalString,
    DepartmentName: optionalString,
    PositionSchedule: z.array(z.looseObject({ Name: optionalString })).nullish(),
    QualificationSummary: optionalString,
    PositionRemuneration: z
      .array(
        z.looseObject({
          MinimumRange: z.union([z.string(), z.number()]).nullish(),
          MaximumRange: z.union([z.string(), z.number()]).nullish(),
          RateIntervalCode: optionalString,
        }),
      )
      .nullish(),
    PublicationStartDate: optionalString,
    ApplicationCloseDate: optionalString,
    UserArea: z
      .looseObject({
        Details: z
          .looseObject({ JobSummary: optionalString, MajorDuties: z.array(z.string()).nullish(), RemoteIndicator: z.boolean().nullish() })
          .nullish(),
      })
      .nullish(),
  }),
});

const amount = (value: string | number | null | undefined): number | undefined => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return parsed === null || parsed === undefined || !Number.isFinite(parsed) || parsed <= 0 ? undefined : parsed;
};

function postingOf(item: unknown): RawPosting {
  const parsed = ItemSchema.parse(item);
  const job = parsed.MatchedObjectDescriptor;
  const pay = job.PositionRemuneration?.[0];
  const interval = pay?.RateIntervalCode === undefined ? undefined : INTERVALS[pay.RateIntervalCode];
  const min = amount(pay?.MinimumRange);
  const max = amount(pay?.MaximumRange);
  const details = job.UserArea?.Details;
  const remote = details?.RemoteIndicator === true;
  const summary = [details?.JobSummary, job.QualificationSummary, ...(details?.MajorDuties ?? [])].filter(
    (part): part is string => part !== undefined && part !== null,
  );
  return {
    source: "usajobs",
    sourceRef: String(parsed.MatchedObjectId),
    url: job.PositionURI,
    applyUrl: job.ApplyURI?.[0],
    title: job.PositionTitle,
    company: job.OrganizationName ?? job.DepartmentName ?? "US federal government",
    ...(remote
      ? { workplace: "remote" as const, remoteRegions: ["US"] }
      : {
          places: (job.PositionLocation ?? []).map((place) => ({
            country: "US",
            ...(place.CountrySubDivisionCode === undefined ? {} : { region: place.CountrySubDivisionCode.slice(0, 80) }),
            ...(place.CityName === undefined ? {} : { city: place.CityName.split(",")[0]?.trim().slice(0, 80) ?? "" }),
            ...(place.Latitude === null || place.Latitude === undefined ? {} : { lat: place.Latitude }),
            ...(place.Longitude === null || place.Longitude === undefined ? {} : { lon: place.Longitude }),
          })),
        }),
    descriptionText: summary.join("\n"),
    ...(interval === undefined || (min === undefined && max === undefined)
      ? {}
      : {
          salary: {
            currency: "USD",
            ...(min === undefined ? {} : { min: min * interval.factor }),
            ...(max === undefined ? {} : { max: max * interval.factor }),
            period: interval.period,
            basis: "gross" as const,
            origin: "stated" as const,
          },
        }),
    employmentType: job.PositionSchedule?.[0]?.Name,
    postedAt: utc(job.PublicationStartDate),
    validThrough: utc(job.ApplicationCloseDate),
    reqId: job.PositionID,
    attribution: "Jobs from USAJOBS",
  };
}

export const usajobs: JobSourceAdapter = {
  record: usajobsRecord,
  search: (query, call) => {
    const key = call.credential("usajobsKey");
    // The API requires the registered email as User-Agent: without it, no request.
    if (key === undefined || call.contact === undefined || (query.countries.length > 0 && !query.countries.includes("US"))) return [];
    const params = new URLSearchParams({
      ResultsPerPage: String(PAGE),
      Page: "1",
      DatePosted: String(Math.min(60, query.postedWithinDays)),
      ...(query.keywords.length === 0 ? {} : { Keyword: keywordsText(query.keywords) }),
      ...(query.place === undefined ? {} : { LocationName: query.place.city, Radius: String(Math.round(query.place.radiusKm / 1.609)) }),
    });
    return [
      {
        url: `https://data.usajobs.gov/api/search?${params.toString()}`,
        headers: { "Authorization-Key": key, "User-Agent": call.contact },
        body: "json",
        purpose: "search",
      },
    ];
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const result = (
      response.body as { readonly SearchResult?: { readonly SearchResultItems?: unknown; readonly SearchResultCountAll?: unknown } } | null
    )?.SearchResult;
    const outcome = readList(result?.SearchResultItems, postingOf, "items");
    if (outcome.kind !== "ok") return outcome;
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("Page") ?? "1");
    const total = typeof result?.SearchResultCountAll === "number" ? result.SearchResultCountAll : 0;
    if (page >= USAJOBS_MAX_PAGES || page * PAGE >= total) return outcome;
    url.searchParams.set("Page", String(page + 1));
    const next: SourceRequest = { ...request, url: url.toString() };
    return { ...outcome, next };
  },
};
