import { z } from "zod";

import { JobSourceRecordSchema } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { keywordsText, optionalString, readList, statusOutcome, utcTime as utc } from "./common.js";
import type { JobSourceAdapter, SourceRequest } from "./types.js";

/** JobTech's JobSearch API: Arbetsförmedlingen's ads for Sweden, keyless, CC0. */
export const jobtechRecord = JobSourceRecordSchema.parse({
  id: "jobtech",
  name: "JobTech (Arbetsförmedlingen)",
  countries: ["SE"],
  hosts: ["jobsearch.api.jobtechdev.se"],
  auth: "none",
  kind: "government",
  tenancy: "global",
  removeInactive: true,
  personalUse: "permitted",
  terms: {
    url: "https://jobtechdev.se/en/components/jobsearch",
    reviewedAt: "2026-10-16",
    licence: "CC0 1.0",
    llmUse: "allowed",
    cache: { mode: "ttl", days: 60 },
    attribution: "Ads from Arbetsförmedlingen (JobTech)",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
  fields: { salary: "text", remote: "text", posted: true, reqId: false, fullDescription: true },
});

const PAGE = 100;
export const JOBTECH_MAX_PAGES = 3;

const Labelled = z.looseObject({ label: optionalString }).nullish();
const HitSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  headline: z.string().min(1),
  webpage_url: z.string(),
  removed: z.boolean().nullish(),
  application_deadline: optionalString,
  publication_date: optionalString,
  description: z.looseObject({ text: optionalString, text_formatted: optionalString }).nullish(),
  employment_type: Labelled,
  working_hours_type: Labelled,
  salary_description: optionalString,
  employer: z.looseObject({ name: optionalString, workplace: optionalString }).nullish(),
  application_details: z.looseObject({ url: optionalString }).nullish(),
  workplace_address: z
    .looseObject({
      municipality: optionalString,
      region: optionalString,
      city: optionalString,
      coordinates: z.array(z.number().nullable()).nullish(),
    })
    .nullish(),
});

function postingOf(item: unknown): RawPosting {
  const hit = HitSchema.parse(item);
  const address = hit.workplace_address;
  const [lon, lat] = address?.coordinates ?? [];
  const hours = hit.working_hours_type?.label ?? "";
  const kind = hit.employment_type?.label ?? "";
  const applyUrl = hit.application_details?.url;
  return {
    source: "jobtech",
    sourceRef: String(hit.id),
    url: hit.webpage_url,
    // Only a web address: the field also holds text an employer typed.
    ...(applyUrl !== undefined && /^https?:\/\/[^\s]+$/.test(applyUrl) ? { applyUrl } : {}),
    title: hit.headline,
    company: hit.employer?.name ?? hit.employer?.workplace ?? "",
    places: [
      {
        country: "SE",
        ...(address?.region === undefined ? {} : { region: address.region.slice(0, 80) }),
        ...((address?.city ?? address?.municipality) === undefined
          ? {}
          : { city: (address?.city ?? address?.municipality ?? "").slice(0, 80) }),
        ...(typeof lat === "number" && typeof lon === "number" ? { lat, lon } : {}),
      },
    ],
    ...(hit.description?.text_formatted === undefined
      ? { descriptionText: [hit.description?.text, hit.salary_description].filter((part) => part !== undefined).join("\n") }
      : {
          descriptionHtml: `${hit.description.text_formatted}${hit.salary_description === undefined ? "" : `<p>${hit.salary_description}</p>`}`,
        }),
    employmentType: /tidsbegränsad|vikariat|säsong/i.test(kind)
      ? "TEMPORARY"
      : /deltid/i.test(hours)
        ? "PART_TIME"
        : /heltid/i.test(hours)
          ? "FULL_TIME"
          : undefined,
    postedAt: utc(hit.publication_date),
    validThrough: utc(hit.application_deadline),
    attribution: "Ads from Arbetsförmedlingen (JobTech)",
  };
}

export const jobtech: JobSourceAdapter = {
  record: jobtechRecord,
  search: (query, call) => {
    if (query.countries.length > 0 && !query.countries.includes("SE")) return [];
    const after = new Date(Date.parse(call.now) - query.postedWithinDays * 86_400_000).toISOString().slice(0, 19);
    const params = new URLSearchParams({
      limit: String(PAGE),
      offset: "0",
      "published-after": after,
      ...(query.keywords.length === 0 ? {} : { q: keywordsText(query.keywords) }),
    });
    return [{ url: `https://jobsearch.api.jobtechdev.se/search?${params.toString()}`, body: "json", purpose: "search" }];
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const body = response.body as { readonly hits?: unknown; readonly total?: { readonly value?: unknown } } | null;
    const hits = Array.isArray(body?.hits) ? body.hits : undefined;
    // An ad marked removed is gone: hidden at once, not read.
    const removed = (hits ?? [])
      .filter((hit: unknown) => (hit as { readonly removed?: unknown } | null)?.removed === true)
      .map((hit: unknown) => String((hit as { readonly id?: unknown }).id));
    const outcome = readList(
      hits?.filter((hit: unknown) => (hit as { readonly removed?: unknown } | null)?.removed !== true) ?? body?.hits,
      postingOf,
      "hits",
    );
    if (outcome.kind !== "ok") return outcome;
    const url = new URL(request.url);
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const total = typeof body?.total?.value === "number" ? body.total.value : 0;
    const withRemoved = removed.length === 0 ? outcome : { ...outcome, removed };
    if (offset + PAGE >= total || offset / PAGE + 1 >= JOBTECH_MAX_PAGES) return withRemoved;
    url.searchParams.set("offset", String(offset + PAGE));
    const next: SourceRequest = { ...request, url: url.toString() };
    return { ...withRemoved, next };
  },
};
