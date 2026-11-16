import { JobSourceRecordSchema } from "../contracts.js";
import type { RawPosting } from "../normalize.js";
import { childOf, childrenOf, parseXml, textOf, type XmlElement } from "../xml.js";
import { readList, regionalTenant, statusOutcome } from "./common.js";
import type { JobSourceAdapter } from "./types.js";

/** Personio's XML job feed: keyless, per company, on `.de` or `.com` (`com:acme`). */
export const personioRecord = JobSourceRecordSchema.parse({
  id: "personio",
  name: "Personio",
  countries: ["*"],
  hosts: ["*.jobs.personio.de", "*.jobs.personio.com"],
  auth: "none",
  kind: "ats",
  tenancy: "per-tenant",
  removeInactive: false,
  personalUse: "silent",
  terms: {
    url: "https://support.personio.de/hc/en-us/articles/207576365",
    reviewedAt: "2026-10-16",
    licence: "employer's public job feed",
    llmUse: "silent",
    cache: { mode: "ttl", days: 60 },
    attribution: "via Personio",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
  fields: { salary: "none", remote: "text", posted: true, reqId: false, fullDescription: true },
});

const EMPLOYMENT: Readonly<Record<string, string>> = {
  permanent: "FULL_TIME",
  intern: "INTERN",
  trainee: "INTERN",
  "working-student": "PART_TIME",
  freelance: "CONTRACTOR",
  temporary: "TEMPORARY",
};

function postingOf(position: XmlElement, tenant: { readonly name: string; readonly host: string }): RawPosting | undefined {
  const id = textOf(position, "id");
  const title = textOf(position, "name");
  if (id === undefined || !/^\d{1,20}$/.test(id) || title === undefined) return undefined;
  const offices = [
    textOf(position, "office"),
    ...childrenOf(childOf(position, "additionalOffices"), "office").map((office) => textOf(office)),
  ].filter((office): office is string => office !== undefined);
  const description = childrenOf(childOf(position, "jobDescriptions"), "jobDescription")
    .map((section) => `<h3>${textOf(section, "name") ?? ""}</h3>${textOf(section, "value") ?? ""}`)
    .join("");
  const schedule = textOf(position, "schedule");
  const type = textOf(position, "employmentType");
  return {
    source: "personio",
    sourceRef: `${tenant.host}/${id}`,
    tenant: tenant.host.startsWith(`${tenant.name}.jobs.personio.com`) ? `com:${tenant.name}` : tenant.name,
    url: `https://${tenant.host}/job/${id}`,
    applyUrl: `https://${tenant.host}/job/${id}/apply`,
    title,
    company: textOf(position, "subcompany") ?? tenant.name,
    locations: offices,
    descriptionHtml: description,
    employmentType:
      schedule === "part-time"
        ? "PART_TIME"
        : type === undefined
          ? schedule
          : (EMPLOYMENT[type] ?? (schedule === "full-time" ? "FULL_TIME" : type)),
    postedAt: textOf(position, "createdAt"),
    attribution: `${textOf(position, "subcompany") ?? tenant.name} via Personio`,
  };
}

const hostOf = (tenant: string | undefined): { readonly name: string; readonly host: string } | undefined => {
  const parsed = regionalTenant(tenant, ["com"]);
  return parsed === undefined || parsed.name.includes(".")
    ? undefined
    : { name: parsed.name, host: `${parsed.name}.jobs.personio.${parsed.region === "com" ? "com" : "de"}` };
};

export const personio: JobSourceAdapter = {
  record: personioRecord,
  search: (_query, _call, tenant) => {
    const board = hostOf(tenant);
    return board === undefined
      ? []
      : [{ url: `https://${board.host}/xml?language=en`, body: "text", purpose: "search", tenant: tenant ?? "" }];
  },
  parse: (response, request, call) => {
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    const board = hostOf(request.tenant);
    if (board === undefined || typeof response.body !== "string") return { kind: "drift", detail: "the feed is not text" };
    // A company with no feed answers 200 with a "page not found" page.
    if (/^\s*<!doctype html|^\s*<html/i.test(response.body)) return { kind: "not-found" };
    const root = childOf(parseXml(response.body), "workzag-jobs");
    if (root === undefined) return { kind: "drift", detail: "the feed has no workzag-jobs element" };
    return readList(childrenOf(root, "position"), (item) => postingOf(item as XmlElement, board), "positions");
  },
};
