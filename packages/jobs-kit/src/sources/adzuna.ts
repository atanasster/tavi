import { htmlToText } from "@tavi/contracts";
import { z } from "zod";

import { JobSourceRecordSchema } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { keywordsText, optionalString, readList, statusOutcome } from "./common.js";
import type { JobSourceAdapter } from "./types.js";

/**
 * Adzuna's search API: the person's key in
 * the query; personal research is a permitted use; displayed text is
 * refreshed within 4 hours and never altered; an "Adzuna" label links back;
 * a predicted salary is marked and never meets a floor.
 */
export const ADZUNA_COUNTRIES: Readonly<Record<string, string>> = {
  GB: "GBP",
  US: "USD",
  AT: "EUR",
  AU: "AUD",
  BE: "EUR",
  BR: "BRL",
  CA: "CAD",
  CH: "CHF",
  DE: "EUR",
  ES: "EUR",
  FR: "EUR",
  IN: "INR",
  IT: "EUR",
  MX: "MXN",
  NL: "EUR",
  NZ: "NZD",
  PL: "PLN",
  SG: "SGD",
  ZA: "ZAR",
};

export const adzunaRecord = JobSourceRecordSchema.parse({
  id: "adzuna",
  name: "Adzuna",
  countries: Object.keys(ADZUNA_COUNTRIES),
  hosts: ["api.adzuna.com"],
  auth: "key-query",
  credential: ["adzunaAppId", "adzunaAppKey"],
  kind: "aggregator",
  tenancy: "global",
  removeInactive: false,
  personalUse: "permitted",
  terms: {
    url: "https://developer.adzuna.com/docs/terms_of_service",
    reviewedAt: "2026-10-16",
    licence: "Adzuna API terms",
    llmUse: "silent",
    cache: { mode: "ttl-hours", hours: 4 },
    attribution: "Jobs by Adzuna",
    displayRules: ["Show the Adzuna label linking back", "Show Adzuna's text unaltered; summaries kept apart"],
    userTriggeredOnly: false,
  },
  // 25 a minute and 250 a day, per the API terms.
  budget: { perSecond: 25 / 60, perDay: 250 },
  fields: { salary: "predicted", remote: "text", posted: true, reqId: false, fullDescription: false },
});

const ResultSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  title: z.string().min(1),
  description: optionalString,
  redirect_url: z.string(),
  created: optionalString,
  company: z.looseObject({ display_name: optionalString }).nullish(),
  location: z.looseObject({ display_name: optionalString, area: z.array(z.string()).nullish() }).nullish(),
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
  salary_is_predicted: z.union([z.string(), z.number(), z.boolean()]).nullish(),
  contract_time: optionalString,
  contract_type: optionalString,
});

function postingOf(item: unknown, country: string): RawPosting {
  const result = ResultSchema.parse(item);
  const predicted = result.salary_is_predicted === "1" || result.salary_is_predicted === 1 || result.salary_is_predicted === true;
  const min = result.salary_min ?? undefined;
  const max = result.salary_max ?? undefined;
  const area = result.location?.area ?? [];
  const city = area.at(-1);
  return {
    source: "adzuna",
    sourceRef: `${country}/${String(result.id)}`,
    url: result.redirect_url,
    // Adzuna marks the searched words in a title with <strong>.
    title: htmlToText(result.title),
    company: result.company?.display_name ?? "",
    places: [
      {
        country,
        ...(area.length > 1 ? { region: (area[1] ?? "").slice(0, 80) } : {}),
        ...(city === undefined || area.length < 2 ? {} : { city: city.slice(0, 80) }),
        ...(result.latitude === null || result.latitude === undefined ? {} : { lat: result.latitude }),
        ...(result.longitude === null || result.longitude === undefined ? {} : { lon: result.longitude }),
      },
    ],
    descriptionHtml: result.description,
    ...(min === undefined && max === undefined
      ? {}
      : {
          salary: {
            currency: ADZUNA_COUNTRIES[country] ?? "EUR",
            ...(min === undefined ? {} : { min }),
            ...(max === undefined ? {} : { max }),
            period: "YEAR" as const,
            basis: "gross" as const,
            origin: predicted ? ("predicted" as const) : ("stated" as const),
          },
        }),
    employmentType: result.contract_type === "contract" ? "CONTRACTOR" : result.contract_time,
    postedAt: result.created,
    attribution: "Jobs by Adzuna",
  };
}

/** The most pages of 50 one country's search reads: its daily budget is 250 calls. */
export const ADZUNA_MAX_PAGES = 3;

export const adzuna: JobSourceAdapter = {
  record: adzunaRecord,
  search: (query, call) => {
    const id = call.credential("adzunaAppId");
    const key = call.credential("adzunaAppKey");
    if (id === undefined || key === undefined) return [];
    return query.countries
      .filter((country) => ADZUNA_COUNTRIES[country] !== undefined)
      .map((country) => {
        const params = new URLSearchParams({
          app_id: id,
          app_key: key,
          results_per_page: "50",
          max_days_old: String(query.postedWithinDays),
          "content-type": "application/json",
          ...(query.keywords.length === 0 ? {} : { what: keywordsText(query.keywords) }),
          ...(query.place === undefined ? {} : { where: query.place.city, distance: String(query.place.radiusKm) }),
        });
        return {
          url: `https://api.adzuna.com/v1/api/jobs/${country.toLowerCase()}/search/1?${params.toString()}`,
          body: "json" as const,
          purpose: "search" as const,
          tenant: country,
        };
      });
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const body = response.body as { readonly results?: unknown; readonly count?: unknown } | null;
    const outcome = readList(body?.results, (item) => postingOf(item, request.tenant ?? ""), "results");
    const url = new URL(request.url);
    const page = Number(/\/search\/(\d+)$/.exec(url.pathname)?.[1] ?? "1");
    const count = typeof body?.count === "number" ? body.count : 0;
    if (outcome.kind !== "ok" || page >= ADZUNA_MAX_PAGES || page * 50 >= count) return outcome;
    url.pathname = url.pathname.replace(/\/search\/\d+$/, `/search/${String(page + 1)}`);
    return { ...outcome, next: { ...request, url: url.toString() } };
  },
};
