import { z } from "zod";

import { postingsFromAlert } from "./alerts.js";
import { canonicalUrl } from "./dedup.js";
import { rawPostingFromJsonLd } from "./jsonld.js";
import type { RawPosting } from "./normalize.js";
import { salaryFromText } from "./salary.js";

/**
 * What the agent gathered, for `ingest`: a page's
 * `browser.structured` JobPosting, a `browser.extract` record, an alert email
 * from the person's mailbox, or a career page's links. Every field is
 * untrusted third-party text; the person approves each call.
 */
const PageUrl = z
  .string()
  .url()
  .max(2_048)
  .refine((url) => /^https?:\/\//i.test(url), "an http(s) address");

export const IngestItemSchema = z.discriminatedUnion("kind", [
  /** A JobPosting `browser.structured` read, with the page it was on. */
  z.strictObject({ kind: z.literal("jsonld"), url: PageUrl, record: z.record(z.string(), z.unknown()) }),
  /** A record `browser.extract` read. */
  z.strictObject({
    kind: z.literal("record"),
    url: PageUrl,
    title: z.string().min(1).max(200),
    company: z.string().max(120).default(""),
    location: z.string().max(200).optional(),
    description: z.string().max(16_384).optional(),
    salary: z.string().max(200).optional(),
    postedAt: z.string().max(40).optional(),
    applyUrl: PageUrl.optional(),
  }),
  /** An alert email the agent read in the person's mailbox: its sender and its body. */
  z.strictObject({
    kind: z.literal("email"),
    from: z.string().min(3).max(320),
    subject: z.string().max(300).optional(),
    body: z.string().max(1_048_576),
  }),
  /** A career page's links, to find the ATS board behind it. */
  z.strictObject({ kind: z.literal("links"), url: PageUrl, links: z.array(z.string().max(2_048)).max(500) }),
]);
export type IngestItem = z.infer<typeof IngestItemSchema>;

/** An ATS board a career page links to: an `employers` entry for search and watch. */
export interface FoundEmployer {
  readonly source: string;
  readonly tenant: string;
}

export interface IngestRead {
  readonly postings: readonly RawPosting[];
  readonly employers: readonly FoundEmployer[];
  /** Items not read, by their index, with why. */
  readonly refused: readonly { readonly index: number; readonly why: string }[];
}

/**
 * The ATS boards, by the address of a page on them: the board
 * a link names, as the source's own tenant. Workday's tenant is its career
 * site (`<company>.wd<N>/<site>`).
 */
const ATS_LINKS: readonly { readonly source: string; readonly match: (url: URL) => string | undefined }[] = [
  {
    source: "greenhouse",
    match: (url) => {
      if (!/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(url.hostname)) return undefined;
      // An embedded board names its tenant in `for`: /embed/job_board?for=acme.
      if (url.pathname.startsWith("/embed/")) return url.searchParams.get("for") ?? undefined;
      return /^\/([A-Za-z0-9._-]+)/.exec(url.pathname)?.[1];
    },
  },
  {
    source: "lever",
    match: (url) => {
      if (url.hostname !== "jobs.lever.co" && url.hostname !== "jobs.eu.lever.co") return undefined;
      const tenant = /^\/([A-Za-z0-9._-]+)/.exec(url.pathname)?.[1];
      return tenant === undefined ? undefined : `${url.hostname === "jobs.eu.lever.co" ? "eu:" : ""}${tenant}`;
    },
  },
  { source: "ashby", match: (url) => (url.hostname === "jobs.ashbyhq.com" ? /^\/([A-Za-z0-9._%-]+)/.exec(url.pathname)?.[1] : undefined) },
  {
    source: "smartrecruiters",
    match: (url) =>
      url.hostname === "jobs.smartrecruiters.com" || url.hostname === "careers.smartrecruiters.com"
        ? /^\/([A-Za-z0-9._-]+)/.exec(url.pathname)?.[1]
        : undefined,
  },
  { source: "recruitee", match: (url) => /^([a-z0-9-]+)\.recruitee\.com$/.exec(url.hostname)?.[1] },
  {
    source: "personio",
    match: (url) => {
      const found = /^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/.exec(url.hostname);
      return found === null ? undefined : `${found[2] === "com" ? "com:" : ""}${found[1] ?? ""}`;
    },
  },
  {
    source: "workable",
    match: (url) => (url.hostname === "apply.workable.com" ? /^\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1] : undefined),
  },
  { source: "breezy", match: (url) => /^([a-z0-9-]+)\.breezy\.hr$/.exec(url.hostname)?.[1] },
  {
    source: "workday",
    match: (url) => {
      const host = /^([a-z0-9-]+)\.(wd\d{1,3})\.myworkdayjobs\.com$/.exec(url.hostname);
      const site = /^\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
      return host === null || site === undefined ? undefined : `${host[1] ?? ""}.${host[2] ?? ""}/${site}`;
    },
  },
];

/** The ATS board a link is on, if any. */
export function employerOfLink(link: string): FoundEmployer | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  for (const ats of ATS_LINKS) {
    const tenant = ats.match(url);
    if (tenant !== undefined && tenant !== "" && tenant.length <= 128) return { source: ats.source, tenant };
  }
  return undefined;
}

const hostOf = (url: string): string => new URL(url).hostname.toLowerCase();

/** An agent-gathered posting's source: `agent:<host>`, so the store and its reports say where it came from. */
export const agentSourceOf = (url: string): string => `agent:${hostOf(url)}`;

/**
 * The postings and boards the items hold. A page on a site Tavi reads for the
 * turn only (`readOnlyHosts`: an `assist-only` profile's) is refused, unless
 * the person saves the one posting they opened (`personSaved`, one at most).
 * An email from a sender off the alert allowlist is ignored.
 */
export function readIngestItems(
  items: readonly IngestItem[],
  options: { readonly readOnlyHost: (host: string) => boolean; readonly personSaved: boolean },
): IngestRead {
  const postings: RawPosting[] = [];
  const employers = new Map<string, FoundEmployer>();
  const refused: { index: number; why: string }[] = [];
  const pages = items.filter((item) => (item.kind === "jsonld" || item.kind === "record") && options.readOnlyHost(hostOf(item.url))).length;
  for (const [index, item] of items.entries()) {
    if (item.kind === "email") {
      const read = postingsFromAlert(item);
      if (read === undefined) refused.push({ index, why: "the sender is not a job board whose alerts Tavi reads" });
      else postings.push(...read);
      continue;
    }
    if (item.kind === "links") {
      for (const link of item.links) {
        const employer = employerOfLink(link);
        if (employer !== undefined) employers.set(`${employer.source}:${employer.tenant}`, employer);
      }
      continue;
    }
    const host = hostOf(item.url);
    // A site read for the turn only is not stored, but for the one posting the person saves.
    if (options.readOnlyHost(host) && !(options.personSaved && pages === 1)) {
      refused.push({
        index,
        why: options.personSaved
          ? "the person saves one posting at a time from this site"
          : `${host} is read for the chat only: the person may save the one posting they opened (personSaved)`,
      });
      continue;
    }
    const url = canonicalUrl(item.url);
    if (item.kind === "jsonld") {
      const raw = rawPostingFromJsonLd(item.record, agentSourceOf(item.url), url, item.url, {
        attribution: (company) => `${company === "" ? "" : `${company.slice(0, 80)} `}via ${host}`,
      });
      if (raw === undefined) refused.push({ index, why: "the record is not a JobPosting with a title" });
      else postings.push(raw);
      continue;
    }
    const salary = item.salary === undefined ? undefined : salaryFromText(`Salary ${item.salary}`);
    postings.push({
      source: agentSourceOf(item.url),
      sourceRef: url,
      url: item.url,
      ...(item.applyUrl === undefined ? {} : { applyUrl: item.applyUrl }),
      title: item.title,
      company: item.company,
      ...(item.location === undefined ? {} : { locations: [item.location] }),
      descriptionText: item.description ?? "",
      ...(salary === undefined ? {} : { salary }),
      ...(item.postedAt === undefined ? {} : { postedAt: item.postedAt }),
      attribution: `${item.company === "" ? "" : `${item.company.slice(0, 80)} `}via ${host}`,
    });
  }
  return { postings, employers: [...employers.values()], refused };
}
