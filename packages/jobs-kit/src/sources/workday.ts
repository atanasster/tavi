import { JobSourceRecordSchema } from "../contracts.js";
import { jobPostingsInHtml, rawPostingFromJsonLd } from "../jsonld.js";
import { robotsAllows } from "../robots.js";
import { childOf, childrenOf, parseXml, textOf } from "../xml.js";
import { statusOutcome } from "./common.js";
import type { JobSourceAdapter, SourceOutcome, SourceRequest } from "./types.js";

/**
 * Workday career sites the person names: read
 * the way the site publishes them for search engines, never through its
 * `cxs` API. The tenant's robots.txt first; then its `siteMap.xml`, at most
 * once a day; then new job pages whose address answers the query, at most
 * one request every 2 s, each read for its JobPosting JSON-LD.
 *
 * A tenant is `<company>.wd<N>/<site>`: `nvidia.wd5/NVIDIAExternalCareerSite`.
 */
export const workdayRecord = JobSourceRecordSchema.parse({
  id: "workday",
  name: "Workday career sites",
  countries: ["*"],
  hosts: ["*.myworkdayjobs.com"],
  auth: "none",
  kind: "structured",
  tenancy: "per-tenant",
  removeInactive: false,
  personalUse: "silent",
  terms: {
    url: "https://www.workday.com/en-us/legal/site-terms.html",
    reviewedAt: "2026-10-16",
    licence: "employer's public careers site",
    llmUse: "silent",
    cache: { mode: "ttl", days: 60 },
    attribution: "via Workday",
    displayRules: [],
    userTriggeredOnly: false,
  },
  // One request every 2 s, whatever the tenant.
  budget: { perSecond: 0.5, perDay: 500 },
  fields: { salary: "text", remote: "structured", posted: true, reqId: true, fullDescription: true },
});

/** New job pages one search reads per tenant: 10 at one every 2 s is 20 s of the search's minute. */
export const WORKDAY_PAGES_PER_SEARCH = 10;
/** Addresses a tenant's cursor keeps from its sitemap. */
const SITEMAP_URLS_MAX = 2_000;
const TENANT = /^([a-z0-9][a-z0-9-]{0,62})\.(wd\d{1,3})\/([A-Za-z0-9_-]{1,100})$/;

interface Tenant {
  readonly host: string;
  readonly site: string;
}

const tenantOf = (tenant: string | undefined): Tenant | undefined => {
  const match = tenant === undefined ? null : TENANT.exec(tenant);
  return match === null ? undefined : { host: `${match[1] ?? ""}.${match[2] ?? ""}.myworkdayjobs.com`, site: match[3] ?? "" };
};

/** What a tenant's cursor holds: the day its sitemap was read, and the job pages it listed. */
interface WorkdayCursor {
  readonly readOn: string;
  readonly urls: readonly string[];
}

const readCursor = (cursor: string | undefined): WorkdayCursor | undefined => {
  try {
    const parsed = JSON.parse(cursor ?? "") as Partial<WorkdayCursor>;
    return typeof parsed.readOn === "string" && Array.isArray(parsed.urls)
      ? { readOn: parsed.readOn, urls: parsed.urls.filter((url): url is string => typeof url === "string") }
      : undefined;
  } catch {
    return undefined;
  }
};

/** A sitemap's address, decoded; one with a bad escape is read as written. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Whether a job page's address answers the keywords: Workday's slugs carry the title's words. */
function slugAnswers(url: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true;
  const slug = decoded(url.slice(url.lastIndexOf("/job/") + 5))
    .toLowerCase()
    .replace(/[-_/]+/g, " ");
  return keywords.some((keyword) =>
    keyword
      .toLowerCase()
      .split(/\s+/)
      .every((word) => ` ${slug} `.includes(` ${word} `)),
  );
}

/**
 * The job pages to read: the tenant's own, answering the keywords. All of
 * them: the engine reads a kept one from its store, and fetches at most
 * `WORKDAY_PAGES_PER_SEARCH` of the rest.
 */
function pageRequests(tenant: string, place: Tenant, urls: readonly string[], keywords: readonly string[]): SourceRequest[] {
  return urls
    .filter((url) => url.startsWith(`https://${place.host}/${place.site}/job/`) && slugAnswers(url, keywords))
    .map((url) => ({ url, body: "text" as const, purpose: "detail" as const, tenant, keywords }));
}

const sitemapRequest = (tenant: string, place: Tenant, keywords: readonly string[]): SourceRequest => ({
  url: `https://${place.host}/${place.site}/siteMap.xml`,
  body: "text",
  purpose: "search",
  tenant,
  keywords,
});

/** A job page's id: the requisition after the slug's last `_` (`..._JR2025370`), else the slug. */
function pageRef(path: string): string {
  const slug = path.slice(path.lastIndexOf("/") + 1);
  const requisition = /_([A-Za-z0-9-]{1,40})$/.exec(slug)?.[1];
  return requisition ?? slug.slice(0, 200);
}

export const workday: JobSourceAdapter = {
  record: workdayRecord,
  requestsPerSearch: 2 + WORKDAY_PAGES_PER_SEARCH,
  // The sitemap was read today: its pages, from the cursor. Otherwise robots.txt first.
  search: (query, call, tenant) => {
    const place = tenantOf(tenant);
    if (place === undefined || tenant === undefined) return [];
    const cursor = readCursor(call.cursor);
    if (cursor?.readOn === call.now.slice(0, 10)) return pageRequests(tenant, place, cursor.urls, query.keywords);
    return [{ url: `https://${place.host}/robots.txt`, body: "text", purpose: "search", tenant, keywords: query.keywords }];
  },
  parse: (response, request, call): SourceOutcome => {
    const place = tenantOf(request.tenant);
    if (place === undefined || request.tenant === undefined) return { kind: "drift", detail: "the request names no tenant" };
    const path = new URL(request.url).pathname;
    // A robots.txt that is not there (any 4xx but 429, RFC 9309 §2.3.1.3) is no rule.
    if (path === "/robots.txt" && response.status >= 400 && response.status < 500 && response.status !== 429)
      return { kind: "ok", postings: [], dropped: 0, more: [sitemapRequest(request.tenant, place, request.keywords ?? [])] };
    const status = statusOutcome(response, call.now);
    if (status !== undefined) return status;
    if (typeof response.body !== "string") return { kind: "drift", detail: "the answer is not text" };
    if (path === "/robots.txt") {
      if (!robotsAllows(response.body, `/${place.site}/siteMap.xml`) || !robotsAllows(response.body, `/${place.site}/job/`))
        return { kind: "disallowed", why: `${place.host}'s robots.txt disallows ${place.site}` };
      return { kind: "ok", postings: [], dropped: 0, more: [sitemapRequest(request.tenant, place, request.keywords ?? [])] };
    }
    if (path.endsWith("/siteMap.xml")) {
      const urlset = childOf(parseXml(response.body), "urlset");
      if (urlset === undefined) return { kind: "drift", detail: "the sitemap has no urlset" };
      const urls = childrenOf(urlset, "url")
        .map((entry) => textOf(entry, "loc"))
        .filter((url): url is string => url !== undefined && url.startsWith(`https://${place.host}/${place.site}/job/`))
        .slice(0, SITEMAP_URLS_MAX);
      return {
        kind: "ok",
        postings: [],
        dropped: 0,
        cursor: JSON.stringify({ readOn: call.now.slice(0, 10), urls }),
        more: pageRequests(request.tenant, place, urls, request.keywords ?? []),
      };
    }
    // A job page: its JobPosting JSON-LD. A page without one (a closed job's) is dropped, not drift.
    const [posting] = jobPostingsInHtml(response.body);
    const raw =
      posting === undefined
        ? undefined
        : rawPostingFromJsonLd(posting, "workday", `${request.tenant}_${pageRef(path)}`, request.url, {
            tenant: request.tenant,
            attribution: (company) => `${company === "" ? (place.host.split(".")[0] ?? "") : company} via Workday`,
          });
    return raw === undefined ? { kind: "ok", postings: [], dropped: 1 } : { kind: "ok", postings: [raw], dropped: 0 };
  },
};
