import { decodeEntities, htmlToText } from "@tavi/contracts";

import type { RawPosting } from "./normalize.js";

/**
 * Job-alert emails in the person's own mailbox:
 * the postings a board's alert links to, read from the email's untrusted
 * body. Only an alert from a board on the allowlist is read; its links are
 * kept as the postings' addresses and never fetched (LinkedIn and Indeed are
 * `navigate: false`). A posting's text is what the email says of it: a title,
 * and the company and place lines beside the link.
 */

/** The most of an email body read, and the postings one email gives. */
export const ALERT_BODY_MAX_CHARS = 512 * 1024;
export const ALERT_POSTINGS_MAX = 50;

/** Whether `host` is `domain` or a name under it: `uk.indeed.com`, never `notindeed.com`. */
const onDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

interface AlertBoard {
  readonly name: string;
  /** A job link's canonical address and id, or `undefined` for a link that is not a posting. */
  readonly posting: (href: URL) => { readonly url: string; readonly id: string } | undefined;
}

/** The boards whose alerts are read, by the sender's domain. */
const ALERT_BOARDS: Readonly<Record<string, AlertBoard>> = {
  "linkedin.com": {
    name: "LinkedIn",
    posting: (href) => {
      if (!onDomain(href.hostname, "linkedin.com")) return undefined;
      const id = /\/(?:comm\/)?jobs\/view\/(?:[^/]*-)?(\d{6,20})\/?/.exec(href.pathname)?.[1];
      return id === undefined ? undefined : { url: `https://www.linkedin.com/jobs/view/${id}/`, id };
    },
  },
  "indeed.com": {
    name: "Indeed",
    posting: (href) => {
      if (!onDomain(href.hostname, "indeed.com")) return undefined;
      const id = href.searchParams.get("jk") ?? href.searchParams.get("vjk");
      if (id === null || !/^[0-9a-f]{8,32}$/i.test(id)) return undefined;
      return { url: `https://${href.hostname}/viewjob?jk=${id.toLowerCase()}`, id: id.toLowerCase() };
    },
  },
};

/** The allowlisted board a sender's address is from, if any: its own domain or one under it. */
export function alertBoardOf(from: string): { readonly domain: string; readonly board: AlertBoard } | undefined {
  const address = /<([^>]+)>\s*$/.exec(from)?.[1] ?? from;
  const domain = address
    .slice(address.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase();
  for (const [known, board] of Object.entries(ALERT_BOARDS)) {
    if (onDomain(domain, known)) return { domain: known, board };
  }
  return undefined;
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const TAG_MAX_CHARS = 4_096;
const ANCHOR_TEXT_MAX_CHARS = 2_000;

/**
 * Each `<a href>` in `html`, with its text and where it ends, in one pass:
 * found by `indexOf`, each tag's attributes and text read within a bound, so
 * a hostile body costs time in proportion to its length.
 */
function* anchorsOf(html: string): Generator<{ readonly href: string; readonly text: string; readonly end: number }> {
  const lower = html.toLowerCase();
  // The next ">" and "</a" at or after a point, each found once and kept while the scan moves forward: linear in the body.
  let gt = -2;
  let close = -2;
  const nextGt = (from: number): number => {
    if (gt === -2 || (gt !== -1 && gt < from)) gt = lower.indexOf(">", from);
    return gt;
  };
  const nextClose = (from: number): number => {
    if (close === -2 || (close !== -1 && close < from)) close = lower.indexOf("</a", from);
    return close;
  };
  let at = lower.indexOf("<a", 0);
  while (at !== -1) {
    const tagEnd = /[\s>]/.test(lower.charAt(at + 2)) ? nextGt(at) : -1;
    // No ">" left: no tag can end, so no anchor is left either.
    if (tagEnd === -1 && /[\s>]/.test(lower.charAt(at + 2))) return;
    if (tagEnd !== -1 && tagEnd - at <= TAG_MAX_CHARS) {
      const end = nextClose(tagEnd);
      if (end === -1) return;
      const href = HREF.exec(html.slice(at, tagEnd + 1));
      if (href !== null && end - tagEnd <= ANCHOR_TEXT_MAX_CHARS) {
        yield { href: href[1] ?? href[2] ?? "", text: html.slice(tagEnd + 1, end), end: lower.indexOf(">", end) + 1 || end };
        at = lower.indexOf("<a", end);
        continue;
      }
    }
    at = lower.indexOf("<a", at + 2);
  }
}
const LINES_AFTER_CHARS = 600;

/** The lines a reader sees after a link: the company, then the place, in an alert's usual layout. */
function linesAfter(html: string, index: number): string[] {
  const following = html.slice(index, index + LINES_AFTER_CHARS);
  // Up to the next link: its lines are the next posting's.
  const next = following.search(/<a\b/i);
  return htmlToText(next === -1 ? following : following.slice(0, next), { dropHidden: true })
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "" && line.length <= 120);
}

/**
 * The postings an alert email links to, or `undefined` for a sender off the
 * allowlist. Each link once; a link that is not a posting is skipped.
 */
export function postingsFromAlert(email: { readonly from: string; readonly body: string }): RawPosting[] | undefined {
  const sender = alertBoardOf(email.from);
  if (sender === undefined) return undefined;
  const html = email.body.slice(0, ALERT_BODY_MAX_CHARS);
  const seen = new Set<string>();
  const postings: RawPosting[] = [];
  for (const anchor of anchorsOf(html)) {
    if (postings.length >= ALERT_POSTINGS_MAX) break;
    let href: URL;
    try {
      href = new URL(decodeEntities(anchor.href));
    } catch {
      continue;
    }
    const posting = sender.board.posting(href);
    const title = htmlToText(anchor.text, { dropHidden: true }).replace(/\s+/g, " ").trim();
    // An image link to the same posting comes first in some alerts: its title is the next link's.
    if (posting === undefined || title === "" || seen.has(posting.id)) continue;
    seen.add(posting.id);
    const [company = "", place] = linesAfter(html, anchor.end);
    postings.push({
      source: `agent:${new URL(posting.url).hostname}`,
      sourceRef: posting.url,
      url: posting.url,
      title: title.slice(0, 200),
      company: company.slice(0, 120),
      ...(place === undefined ? {} : { locations: [place] }),
      descriptionText: "",
      attribution: `${company === "" ? "" : `${company.slice(0, 80)} `}via your ${sender.board.name} job alert`,
    });
  }
  return postings;
}
