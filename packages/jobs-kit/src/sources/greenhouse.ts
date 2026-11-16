import { z } from "zod";

import { JobSourceRecordSchema, type Salary } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { salaryPeriodIn } from "../salary.js";
import { optionalString, readList, statusOutcome, tenantOf, unescapeHtml } from "./common.js";
import type { JobSourceAdapter } from "./types.js";

/** Greenhouse's public job board API: keyless, per employer; pay only on a job's own answer. */
export const greenhouseRecord = JobSourceRecordSchema.parse({
  id: "greenhouse",
  name: "Greenhouse",
  countries: ["*"],
  hosts: ["boards-api.greenhouse.io"],
  auth: "none",
  kind: "ats",
  tenancy: "per-tenant",
  removeInactive: false,
  personalUse: "silent",
  terms: {
    url: "https://developers.greenhouse.io/job-board.html",
    reviewedAt: "2026-10-16",
    licence: "employer's public job board",
    llmUse: "silent",
    cache: { mode: "ttl", days: 60 },
    attribution: "via Greenhouse",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
  fields: { salary: "structured", remote: "text", posted: true, reqId: true, fullDescription: true },
});

const JobSchema = z.looseObject({
  id: z.number().int(),
  title: z.string().min(1),
  absolute_url: z.string(),
  company_name: optionalString,
  location: z.looseObject({ name: optionalString }).nullish(),
  content: optionalString,
  first_published: optionalString,
  updated_at: optionalString,
  requisition_id: optionalString,
  pay_input_ranges: z
    .array(
      z.looseObject({
        min_cents: z.number().nullish(),
        max_cents: z.number().nullish(),
        currency_type: optionalString,
        title: optionalString,
      }),
    )
    .nullish(),
});

/** A pay range: amounts in cents, the period in its title ("Hourly Pay Range"), a year's when the title names none. */
function payOf(range: NonNullable<z.infer<typeof JobSchema>["pay_input_ranges"]>[number]): Salary | undefined {
  const currency = range.currency_type;
  const min = range.min_cents ?? undefined;
  const max = range.max_cents ?? undefined;
  if (currency === undefined || (min === undefined && max === undefined)) return undefined;
  const title = range.title ?? "";
  const period =
    salaryPeriodIn(title) ??
    (/\bhourly\b|\bhour\b/i.test(title)
      ? "HOUR"
      : /\bmonthly\b|\bmonth\b/i.test(title)
        ? "MONTH"
        : /\bweekly\b/i.test(title)
          ? "WEEK"
          : /\bdaily\b|\bday rate\b/i.test(title)
            ? "DAY"
            : "YEAR");
  return {
    currency,
    ...(min === undefined ? {} : { min: min / 100 }),
    ...(max === undefined ? {} : { max: max / 100 }),
    period,
    basis: "gross",
    origin: "stated",
  };
}

function postingOf(item: unknown, tenant: string): RawPosting {
  const job = JobSchema.parse(item);
  const salary = (job.pay_input_ranges ?? []).map(payOf).find((each) => each !== undefined);
  return {
    source: "greenhouse",
    sourceRef: `${tenant}/${String(job.id)}`,
    tenant,
    url: job.absolute_url,
    title: job.title,
    company: job.company_name ?? tenant,
    locations: (job.location?.name ?? "")
      .split(/;|•/)
      .map((each) => each.trim())
      .filter((each) => each !== ""),
    ...(job.content === undefined ? {} : { descriptionHtml: unescapeHtml(job.content) }),
    postedAt: job.first_published ?? job.updated_at,
    reqId: job.requisition_id,
    ...(salary === undefined ? {} : { salary }),
    attribution: `${job.company_name ?? tenant} via Greenhouse`,
  };
}

export const greenhouse: JobSourceAdapter = {
  record: greenhouseRecord,
  search: (_query, _call, tenant) => {
    const board = tenantOf(tenant);
    return board === undefined
      ? []
      : [
          {
            url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`,
            body: "json",
            purpose: "search",
            tenant: board,
          },
        ];
  },
  // A posting's own page names its board and id: `boards.greenhouse.io/<board>/jobs/<id>`.
  refFromUrl: (url) => {
    const found = /^https:\/\/(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([A-Za-z0-9._-]+)\/jobs\/(\d{1,20})(?:[/?#]|$)/.exec(url);
    return found === null ? undefined : `${found[1] ?? ""}/${found[2] ?? ""}`;
  },
  detail: (ref) => {
    const [board, id] = ref.split("/");
    return tenantOf(board) === undefined || !/^\d{1,20}$/.test(id ?? "")
      ? undefined
      : {
          url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board ?? "")}/jobs/${id ?? ""}?pay_transparency=true`,
          body: "json",
          purpose: "detail",
          tenant: board ?? "",
        };
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const tenant = request.tenant ?? "";
    if (request.purpose === "detail") return readList([response.body], (item) => postingOf(item, tenant), "jobs");
    const body = response.body as { readonly jobs?: unknown } | null;
    return readList(body?.jobs, (item) => postingOf(item, tenant), "jobs");
  },
};
