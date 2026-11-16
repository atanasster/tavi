import { createHash } from "node:crypto";

import { stripTrackingParams } from "@tavi/contracts";

import type { JobPosting } from "./contracts.js";

/**
 * Telling the same job apart from a new one: a canonical URL, the ATS
 * identity `source:tenant:reqId`, and a fingerprint over company, title,
 * place and workplace. MinHash (`minhash.ts`) catches reposts reworded.
 */

/** Job-board tracking parameters beyond the general ones (`stripTrackingParams`). */
const BOARD_TRACKING = new Set([
  "gh_src",
  "lever-source",
  "lever-origin",
  "ref",
  "src",
  "source",
  "utm",
  "trk",
  "trackingid",
  "refid",
  "from",
]);
/** Hosts that are the same board under another name. */
const SAME_HOST: Readonly<Record<string, string>> = {
  "job-boards.greenhouse.io": "boards.greenhouse.io",
  "job-boards.eu.greenhouse.io": "boards.eu.greenhouse.io",
};

/**
 * A posting's URL as one key: tracking parameters gone, host lower-cased and
 * unified, fragment and trailing slash dropped. Greenhouse's `gh_jid` goes
 * only on a Greenhouse board, whose path already names the job; on an
 * employer's own careers page it is the job's only identity, so it stays.
 */
export function canonicalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(stripTrackingParams(url));
  } catch {
    return url;
  }
  parsed.hash = "";
  const host = parsed.hostname.toLowerCase();
  parsed.hostname = SAME_HOST[host] ?? host;
  const greenhouse = parsed.hostname.endsWith("greenhouse.io");
  for (const key of [...parsed.searchParams.keys()]) {
    const name = key.toLowerCase();
    if (BOARD_TRACKING.has(name) || (greenhouse && name === "gh_jid")) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  let path = parsed.pathname;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
}

const LEGAL_SUFFIXES =
  /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|gmbh|ag|se|sa|sas|sarl|bv|nv|ab|asa|as|oy|oyj|plc|corp|corporation|co|company|srl|spa|s\.p\.a|pty|kg|ug|kk|pvt|private)\b\.?/gi;

/** A company's name as a key: case folded, accents and legal suffixes dropped. */
export function companyKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A title as a key: case folded, the words that vary between reposts kept, punctuation and "(m/w/d)"-style tags dropped. */
export function titleKey(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\((?:m|f|w|d|x|all genders?)(?:\s*\/\s*(?:m|f|w|d|x))*\)/g, " ")
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim();
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** `${source}:${sha256(sourceRef).slice(0, 24)}`: stable across fetches of the same record. */
export function postingIdOf(source: string, sourceRef: string): string {
  return `${source}:${sha(sourceRef).slice(0, 24)}`;
}

/** The fingerprint a repost with a new id shares: company, title, the first place and the workplace. */
export function fingerprintOf(posting: Pick<JobPosting, "company" | "title" | "places" | "workplace">): string {
  const place = posting.places[0];
  return sha(
    [companyKey(posting.company), titleKey(posting.title), (place?.city ?? place?.country ?? "").toLowerCase(), posting.workplace].join(
      "|",
    ),
  ).slice(0, 32);
}

/** The keys under which a posting may already be known, strongest first. */
export function dedupKeysOf(
  posting: Pick<JobPosting, "url" | "source" | "tenant" | "reqId" | "company" | "title" | "places" | "workplace">,
): string[] {
  return [
    `url:${canonicalUrl(posting.url)}`,
    ...(posting.reqId === undefined ? [] : [`ats:${posting.source}:${posting.tenant ?? ""}:${posting.reqId}`]),
    `fp:${fingerprintOf(posting)}`,
  ];
}
