import { z } from "zod";

import { JobSourceRecordSchema, type Salary } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { keywordsText, mcpValue, optionalString, readList, utcTime } from "./common.js";
import type { JobSourceAdapter, SourceOutcome } from "./types.js";

/**
 * Snagajob's official MCP server, run by JobGet:
 * hourly and local US jobs near a place, no account, read-only. Its search
 * needs a place, so a query without one does not ask it.
 */
export const snagajobRecord = JobSourceRecordSchema.parse({
  id: "snagajob",
  name: "Snagajob",
  countries: ["US"],
  hosts: ["platform.jobget.com"],
  auth: "none",
  transport: "mcp",
  kind: "mcp",
  tenancy: "global",
  removeInactive: false,
  personalUse: "silent",
  terms: {
    url: "https://claude.com/connectors/snagajob",
    reviewedAt: "2026-10-16",
    licence: "official MCP server, read-only",
    llmUse: "allowed",
    cache: { mode: "ttl", days: 30 },
    attribution: "via Snagajob",
    displayRules: [],
    userTriggeredOnly: false,
  },
  // One unit is one exchange: `initialize`, `initialized` and the call.
  budget: { perSecond: 0.5, perDay: 200 },
  fields: { salary: "structured", remote: "none", posted: true, reqId: false, fullDescription: false },
});

const ENDPOINT = "https://platform.jobget.com/jobs-mcp/mcp";
const LIMIT = 25;
const KM_PER_MILE = 1.609_344;
const PERIODS: Readonly<Record<string, Salary["period"]>> = { hour: "HOUR", day: "DAY", week: "WEEK", month: "MONTH", year: "YEAR" };
const EMPLOYMENT: Readonly<Record<string, RawPosting["employmentType"]>> = {
  full_time: "FULL_TIME",
  part_time: "PART_TIME",
  seasonal: "TEMPORARY",
  temporary: "TEMPORARY",
};

const pay = z.number().nonnegative().nullish();
const JobSchema = z.looseObject({
  id: z.string().min(1).max(100),
  title: z.string().min(1),
  company: z.string().min(1),
  location_city: optionalString,
  location_state: optionalString,
  location: z.looseObject({ city: optionalString, state: optionalString }).nullish(),
  pay_min: pay,
  pay_max: pay,
  pay_unit: optionalString,
  employment_type: optionalString,
  posted_at: optionalString,
  expires_at: optionalString,
  apply_url: z.string().url(),
  snippet: optionalString,
  description: optionalString,
  requirements: z.array(z.string()).nullish(),
  benefits: z.array(z.string()).nullish(),
});

/** Pay its server states, in dollars; a biweekly or flat amount is left to the text. */
function salaryOf(job: z.infer<typeof JobSchema>): Salary | undefined {
  const period = PERIODS[job.pay_unit ?? ""];
  if (period === undefined || (job.pay_min == null && job.pay_max == null)) return undefined;
  return {
    currency: "USD",
    ...(job.pay_min == null ? {} : { min: job.pay_min }),
    ...(job.pay_max == null ? {} : { max: job.pay_max }),
    period,
    basis: "unknown",
    origin: "stated",
  };
}

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function postingOf(item: unknown): RawPosting {
  const job = JobSchema.parse(item);
  const city = job.location_city ?? job.location?.city;
  const state = job.location_state ?? job.location?.state;
  const salary = salaryOf(job);
  const lists = [
    ["Requirements", job.requirements],
    ["Benefits", job.benefits],
  ] as const;
  // A detail's text and lists, as HTML so a list's heading marks its requirements.
  const detail =
    job.description === undefined
      ? undefined
      : `<p>${escape(job.description)}</p>${lists.map(([heading, items]) => ((items ?? []).length === 0 ? "" : `<h3>${heading}</h3><ul>${(items ?? []).map((line) => `<li>${escape(line)}</li>`).join("")}</ul>`)).join("")}`;
  return {
    source: "snagajob",
    sourceRef: job.id,
    url: job.apply_url,
    title: job.title,
    company: job.company,
    places: [
      {
        country: "US",
        ...(state === undefined ? {} : { region: state.slice(0, 80) }),
        ...(city === undefined ? {} : { city: city.slice(0, 80) }),
      },
    ],
    ...(detail === undefined ? { descriptionText: job.snippet ?? "" } : { descriptionHtml: detail }),
    ...(salary === undefined ? {} : { salary }),
    employmentType: EMPLOYMENT[job.employment_type ?? ""],
    postedAt: utcTime(job.posted_at),
    validThrough: utcTime(job.expires_at),
    attribution: `${job.company.slice(0, 80)} via Snagajob`,
  };
}

export const snagajob: JobSourceAdapter = {
  record: snagajobRecord,
  search: (query) => {
    if (query.place === undefined || (query.countries.length > 0 && !query.countries.includes("US"))) return [];
    const days = query.postedWithinDays;
    const args = {
      location: query.place.city,
      limit: LIMIT,
      ...(query.keywords.length === 0 ? {} : { query: keywordsText(query.keywords) }),
      ...(query.place.radiusKm === 0 ? {} : { radius_miles: Math.min(50, Math.max(1, Math.round(query.place.radiusKm / KM_PER_MILE))) }),
      date_posted: days <= 1 ? "today" : days <= 3 ? "last_3_days" : days <= 7 ? "last_week" : "last_30_days",
    };
    return [{ url: ENDPOINT, body: "json", purpose: "search", mcp: { tool: "search_jobs", arguments: args } }];
  },
  detail: (ref) => ({ url: ENDPOINT, body: "json", purpose: "detail", mcp: { tool: "get_job_details", arguments: { job_id: ref } } }),
  parse: (response, request, call): SourceOutcome => {
    const answer = mcpValue(response, call.now);
    if ("kind" in answer) return answer;
    if (request.purpose === "detail") {
      let posting: RawPosting;
      try {
        posting = postingOf(answer.value);
      } catch {
        return { kind: "drift", detail: "Snagajob's job details are not the shape Tavi reads" };
      }
      return { kind: "ok", postings: [posting], dropped: 0 };
    }
    const value = answer.value as { readonly results?: unknown } | null;
    return readList(value?.results, postingOf, "Snagajob's jobs");
  },
};
