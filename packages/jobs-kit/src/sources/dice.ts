import { z } from "zod";

import { JobSourceRecordSchema } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { salaryFromText } from "../salary.js";
import { keywordsText, mcpValue, optionalString, readList, utcTime } from "./common.js";
import type { JobSourceAdapter } from "./types.js";

/** Dice's line its tool requires with its results, carried in each posting's attribution. */
export const DICE_DISCLOSURE = "Found with AI-powered search: verify details with the employer before applying.";

/**
 * Dice's official MCP server: US tech jobs, no account,
 * read-only. Its tool's own rules are the record's display rules; it is never
 * asked for each posting's details, which its tool forbids doing in bulk.
 */
export const diceRecord = JobSourceRecordSchema.parse({
  id: "dice",
  name: "Dice",
  countries: ["US"],
  hosts: ["mcp.dice.com"],
  auth: "none",
  transport: "mcp",
  kind: "mcp",
  tenancy: "global",
  removeInactive: false,
  personalUse: "silent",
  terms: {
    url: "https://claude.com/connectors/dice",
    reviewedAt: "2026-10-16",
    licence: "official MCP server, read-only",
    llmUse: "allowed",
    cache: { mode: "ttl", days: 30 },
    attribution: "via Dice",
    displayRules: [
      "Show the AI-search disclosure with Dice's results",
      "Show each posting's Dice detail link and company page link",
      "Ask for a posting's details only when the person picks it",
    ],
    userTriggeredOnly: false,
  },
  // One unit is one exchange: `initialize`, `initialized` and the call.
  budget: { perSecond: 0.5, perDay: 200 },
  fields: { salary: "text", remote: "structured", posted: true, reqId: false, fullDescription: false },
});

const ENDPOINT = "https://mcp.dice.com/mcp";
const PER_PAGE = 50;
const WORKPLACE = { remote: "Remote", hybrid: "Hybrid", onsite: "On-Site" } as const;

const JobSchema = z.looseObject({
  guid: z.string().min(1).max(100),
  title: z.string().min(1),
  summary: optionalString,
  postedDate: optionalString,
  jobLocation: z.looseObject({ displayName: optionalString }).nullish(),
  detailsPageUrl: z.string().url(),
  companyPageUrl: optionalString,
  companyName: optionalString,
  salary: optionalString,
  employmentType: optionalString,
  workplaceTypes: z.array(z.string()).nullish(),
  isRemote: z.boolean().nullish(),
});

function postingOf(item: unknown): RawPosting {
  const job = JobSchema.parse(item);
  const types = (job.workplaceTypes ?? []).map((type) => type.toLowerCase());
  const workplace =
    job.isRemote === true || types.includes("remote")
      ? "remote"
      : types.includes("hybrid")
        ? "hybrid"
        : types.includes("on-site")
          ? "onsite"
          : undefined;
  const company = (job.companyName ?? "").slice(0, 60);
  const companyPage =
    job.companyPageUrl !== undefined && /^https:\/\/www\.dice\.com\/company\/[\w-]{1,40}$/.test(job.companyPageUrl)
      ? ` (${job.companyPageUrl})`
      : "";
  const kind = job.employmentType ?? "";
  return {
    source: "dice",
    sourceRef: job.guid,
    url: job.detailsPageUrl,
    title: job.title,
    company,
    locations: job.jobLocation?.displayName === undefined ? [] : [job.jobLocation.displayName],
    ...(workplace === undefined ? {} : { workplace }),
    descriptionText: job.summary ?? "",
    ...(job.salary === undefined ? {} : { salary: salaryFromText(`Salary ${job.salary}`) }),
    employmentType: /full/i.test(kind)
      ? "FULL_TIME"
      : /contract|third party/i.test(kind)
        ? "CONTRACTOR"
        : /part/i.test(kind)
          ? "PART_TIME"
          : /intern/i.test(kind)
            ? "INTERN"
            : undefined,
    postedAt: utcTime(job.postedDate),
    // The company link and the disclosure Dice's tool requires (its display rules).
    // The disclosure whole; only the company part is cut to fit.
    attribution: `${`${company === "" ? "" : `${company} `}via Dice${companyPage}.`.slice(0, 199 - DICE_DISCLOSURE.length)} ${DICE_DISCLOSURE}`,
  };
}

export const dice: JobSourceAdapter = {
  record: diceRecord,
  search: (query) => {
    // Its tool needs a keyword; it covers the US only.
    if (query.keywords.length === 0 || (query.countries.length > 0 && !query.countries.includes("US"))) return [];
    const days = query.postedWithinDays;
    const posted = days <= 1 ? "ONE" : days <= 3 ? "THREE" : days <= 7 ? "SEVEN" : undefined;
    const args = {
      keyword: keywordsText(query.keywords),
      jobs_per_page: PER_PAGE,
      sort: "datePosted",
      ...(query.place === undefined
        ? {}
        : { location: query.place.city, radius: Math.max(1, Math.round(query.place.radiusKm)), radius_unit: "km" }),
      ...(posted === undefined ? {} : { posted_date: posted }),
      ...(query.workplace === undefined || query.workplace.length === 0
        ? {}
        : { workplace_types: query.workplace.map((kind) => WORKPLACE[kind]) }),
    };
    return [{ url: ENDPOINT, body: "json", purpose: "search", mcp: { tool: "search_jobs", arguments: args } }];
  },
  parse: (response, _request, call) => {
    const answer = mcpValue(response, call.now);
    if ("kind" in answer) return answer;
    const value = answer.value as { readonly data?: unknown } | null;
    return readList(value?.data, postingOf, "Dice's jobs");
  },
};
