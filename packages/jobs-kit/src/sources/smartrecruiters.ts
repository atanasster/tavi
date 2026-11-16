import { z } from "zod";

import { JobSourceRecordSchema } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { keywordsText, optionalString, readList, statusOutcome, tenantOf } from "./common.js";
import type { JobSourceAdapter, SourceRequest } from "./types.js";

/**
 * SmartRecruiters' posting API: keyless reads per company,
 * a description only on a posting's own answer. An unknown company answers
 * 200 with no postings, not 404 (ids are case-sensitive).
 */
export const smartrecruitersRecord = JobSourceRecordSchema.parse({
  id: "smartrecruiters",
  name: "SmartRecruiters",
  countries: ["*"],
  hosts: ["api.smartrecruiters.com"],
  auth: "none",
  kind: "ats",
  tenancy: "per-tenant",
  removeInactive: false,
  personalUse: "silent",
  terms: {
    url: "https://developers.smartrecruiters.com/docs/posting-api",
    reviewedAt: "2026-10-16",
    licence: "employer's public job postings",
    llmUse: "silent",
    cache: { mode: "ttl", days: 60 },
    attribution: "via SmartRecruiters",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
  fields: { salary: "none", remote: "structured", posted: true, reqId: true, fullDescription: true },
});

const LocationSchema = z
  .looseObject({
    city: optionalString,
    region: optionalString,
    country: optionalString,
    remote: z.boolean().nullish(),
    hybrid: z.boolean().nullish(),
    fullLocation: optionalString,
  })
  .nullish();
const PostingSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  refNumber: optionalString,
  releasedDate: optionalString,
  company: z.looseObject({ name: optionalString }).nullish(),
  location: LocationSchema,
  typeOfEmployment: z.looseObject({ label: optionalString }).nullish(),
  postingUrl: optionalString,
  applyUrl: optionalString,
  jobAd: z
    .looseObject({ sections: z.record(z.string(), z.looseObject({ title: optionalString, text: optionalString }).nullish()).nullish() })
    .nullish(),
});

function postingOf(item: unknown, tenant: string): RawPosting {
  const posting = PostingSchema.parse(item);
  const location = posting.location;
  const sections = posting.jobAd?.sections ?? {};
  const html = ["jobDescription", "qualifications", "additionalInformation"]
    .map((key) => sections[key])
    .filter((section) => section !== undefined && section !== null && section.text !== undefined)
    .map((section) => `<h3>${section?.title ?? ""}</h3>${section?.text ?? ""}`)
    .join("");
  return {
    source: "smartrecruiters",
    sourceRef: `${tenant}/${posting.id}`,
    tenant,
    url: posting.postingUrl ?? `https://jobs.smartrecruiters.com/${encodeURIComponent(tenant)}/${encodeURIComponent(posting.id)}`,
    applyUrl: posting.applyUrl,
    title: posting.name,
    company: posting.company?.name ?? tenant,
    ...(location === null || location === undefined
      ? {}
      : {
          places: [
            {
              ...(location.country === undefined ? {} : { country: location.country.toUpperCase() }),
              ...(location.region === undefined ? {} : { region: location.region.slice(0, 80) }),
              ...(location.city === undefined ? {} : { city: location.city.slice(0, 80) }),
            },
          ],
        }),
    workplace:
      location?.remote === true
        ? "remote"
        : location?.hybrid === true
          ? "hybrid"
          : location === null || location === undefined
            ? undefined
            : "onsite",
    ...(html === "" ? {} : { descriptionHtml: html }),
    employmentType: posting.typeOfEmployment?.label,
    postedAt: posting.releasedDate,
    reqId: posting.refNumber,
    attribution: `${posting.company?.name ?? tenant} via SmartRecruiters`,
  };
}

/** The most postings one board's search pages through: SmartRecruiters answers 100 a page. */
export const SMARTRECRUITERS_MAX_POSTINGS = 500;

/** The same search's next page, when the board says it has more and the cap allows. */
function nextPage(
  request: SourceRequest,
  body: { readonly offset?: unknown; readonly limit?: unknown; readonly totalFound?: unknown } | null,
): SourceRequest | undefined {
  const offset = typeof body?.offset === "number" ? body.offset : 0;
  const limit = typeof body?.limit === "number" && body.limit > 0 ? body.limit : 100;
  const total = typeof body?.totalFound === "number" ? body.totalFound : 0;
  const next = offset + limit;
  if (next >= total || next >= SMARTRECRUITERS_MAX_POSTINGS) return undefined;
  const url = new URL(request.url);
  url.searchParams.set("offset", String(next));
  return { ...request, url: url.toString() };
}

export const smartrecruiters: JobSourceAdapter = {
  record: smartrecruitersRecord,
  search: (query, _call, tenant) => {
    const company = tenantOf(tenant);
    if (company === undefined) return [];
    const params = new URLSearchParams({ limit: "100", ...(query.keywords.length === 0 ? {} : { q: keywordsText(query.keywords) }) });
    return [
      {
        url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?${params.toString()}`,
        body: "json",
        purpose: "search",
        tenant: company,
      },
    ];
  },
  // A posting's own page: `jobs.smartrecruiters.com/<company>/<id>-<title>`.
  refFromUrl: (url) => {
    const found = /^https:\/\/jobs\.smartrecruiters\.com\/([A-Za-z0-9._-]{1,100})\/(\d{1,20})(?:-[^/?#]*)?(?:[/?#]|$)/.exec(url);
    return found === null ? undefined : `${found[1] ?? ""}/${found[2] ?? ""}`;
  },
  detail: (ref) => {
    const [company, id] = ref.split("/");
    return tenantOf(company) === undefined || !/^[A-Za-z0-9-]{1,64}$/.test(id ?? "")
      ? undefined
      : {
          url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company ?? "")}/postings/${id ?? ""}`,
          body: "json",
          purpose: "detail",
          tenant: company ?? "",
        };
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const tenant = request.tenant ?? "";
    if (request.purpose === "detail") return readList([response.body], (item) => postingOf(item, tenant), "postings");
    const body = response.body as {
      readonly content?: unknown;
      readonly offset?: unknown;
      readonly limit?: unknown;
      readonly totalFound?: unknown;
    } | null;
    const outcome = readList(body?.content, (item) => postingOf(item, tenant), "postings");
    const next = outcome.kind === "ok" ? nextPage(request, body) : undefined;
    return outcome.kind === "ok" && next !== undefined ? { ...outcome, next } : outcome;
  },
};
