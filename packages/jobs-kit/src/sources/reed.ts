import { z } from "zod";

import { JobSourceRecordSchema } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { keywordsText, optionalString, readList, statusOutcome } from "./common.js";
import type { JobSourceAdapter, SourceRequest } from "./types.js";

/** Reed's jobseeker API: UK jobs, the person's key as Basic auth's user name. */
export const reedRecord = JobSourceRecordSchema.parse({
  id: "reed",
  name: "Reed",
  countries: ["GB"],
  hosts: ["www.reed.co.uk"],
  auth: "key-basic",
  credential: ["reedKey"],
  kind: "aggregator",
  tenancy: "global",
  removeInactive: false,
  personalUse: "permitted",
  terms: {
    url: "https://www.reed.co.uk/developers/jobseeker",
    reviewedAt: "2026-10-16",
    licence: "Reed API terms",
    llmUse: "silent",
    cache: { mode: "ttl", days: 30 },
    attribution: "Jobs by reed.co.uk",
    displayRules: ["Link each posting to reed.co.uk"],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 1_000 },
  fields: { salary: "structured", remote: "text", posted: true, reqId: false, fullDescription: false },
});

const PAGE = 100;
export const REED_MAX_PAGES = 3;

const ResultSchema = z.looseObject({
  jobId: z.union([z.number(), z.string()]),
  jobTitle: z.string().min(1),
  jobUrl: z.string(),
  employerName: optionalString,
  locationName: optionalString,
  minimumSalary: z.number().nullish(),
  maximumSalary: z.number().nullish(),
  currency: optionalString,
  date: optionalString,
  expirationDate: optionalString,
  jobDescription: optionalString,
});

/** Reed's `dd/mm/yyyy` as an ISO time. */
const reedDate = (value: string | undefined, end = false): string | undefined => {
  const match = value === undefined ? null : /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match === null ? undefined : `${match[3] ?? ""}-${match[2] ?? ""}-${match[1] ?? ""}T${end ? "23:59:59" : "00:00:00"}Z`;
};

function postingOf(item: unknown): RawPosting {
  const result = ResultSchema.parse(item);
  const min = result.minimumSalary ?? undefined;
  const max = result.maximumSalary ?? undefined;
  const top = max ?? min;
  // Reed states a salary with no period: a day rate and an hourly rate are told by their size.
  const period = top === undefined ? "YEAR" : top < 100 ? "HOUR" : top < 2_000 ? "DAY" : "YEAR";
  return {
    source: "reed",
    sourceRef: String(result.jobId),
    url: result.jobUrl,
    title: result.jobTitle,
    company: result.employerName ?? "",
    locations: result.locationName === undefined ? [] : [`${result.locationName}, UK`],
    descriptionText: result.jobDescription?.trim() ?? "",
    ...(min === undefined && max === undefined
      ? {}
      : {
          salary: {
            currency: result.currency ?? "GBP",
            ...(min === undefined || min <= 0 ? {} : { min }),
            ...(max === undefined || max <= 0 ? {} : { max }),
            period,
            basis: "gross" as const,
            origin: "stated" as const,
          },
        }),
    postedAt: reedDate(result.date),
    validThrough: reedDate(result.expirationDate, true),
    attribution: "Jobs by reed.co.uk",
  };
}

export const reed: JobSourceAdapter = {
  record: reedRecord,
  search: (query, call) => {
    const key = call.credential("reedKey");
    if (key === undefined || (query.countries.length > 0 && !query.countries.includes("GB"))) return [];
    const params = new URLSearchParams({
      resultsToTake: String(PAGE),
      resultsToSkip: "0",
      ...(query.keywords.length === 0 ? {} : { keywords: keywordsText(query.keywords) }),
      ...(query.place === undefined
        ? {}
        : { locationName: query.place.city, distanceFromLocation: String(Math.round(query.place.radiusKm / 1.609)) }),
    });
    return [
      {
        url: `https://www.reed.co.uk/api/1.0/search?${params.toString()}`,
        headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
        body: "json",
        purpose: "search",
      },
    ];
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const body = response.body as { readonly results?: unknown; readonly totalResults?: unknown } | null;
    const outcome = readList(body?.results, postingOf, "results");
    if (outcome.kind !== "ok") return outcome;
    const url = new URL(request.url);
    const skip = Number(url.searchParams.get("resultsToSkip") ?? "0");
    const total = typeof body?.totalResults === "number" ? body.totalResults : 0;
    if (skip + PAGE >= total || skip / PAGE + 1 >= REED_MAX_PAGES) return outcome;
    url.searchParams.set("resultsToSkip", String(skip + PAGE));
    const next: SourceRequest = { ...request, url: url.toString() };
    return { ...outcome, next };
  },
};
