/** RFC 5322's limit on one header line, in characters. */
export const HEADER_LINE_MAX = 998;

/** A reply's subject: `Re:` the message's own (never twice), cut to one header line; a generic one when it had none. */
export function replySubject(subject: string | undefined): string {
  const trimmed = subject?.trim() ?? "";
  if (trimmed === "") return "Re: your message";
  return (/^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`).slice(0, HEADER_LINE_MAX);
}

/** The domain of an address, lower-cased and without a trailing root dot. */
export function domainOf(address: string): string {
  return address
    .slice(address.lastIndexOf("@") + 1)
    .toLowerCase()
    .replace(/\.$/, "");
}

/** One domain is the other or a subdomain of it: the relaxed alignment DMARC uses, short of a public-suffix list. */
export function domainsAligned(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * A reply's `References` value from the thread's message ids, oldest first, fitted so the whole
 * `References: …` line stays within RFC 5322's limit. The first id names the thread's conversation and
 * the last is the message replied to, so the ids between them go first, oldest first (RFC 5322 §3.6.4
 * trims from the middle); dropping the first would move a long thread to a new conversation. Only when
 * the last id alone is too long is it cut. One pass, however many ids a sender's header lists.
 */
export function referencesHeader(ids: readonly string[]): string {
  const maxLength = HEADER_LINE_MAX - "References: ".length;
  const first = ids[0];
  const last = ids[ids.length - 1];
  if (first === undefined || last === undefined) return "";
  if (ids.length === 1) return first.slice(0, maxLength);
  let length = first.length + 1 + last.length;
  if (length > maxLength) return last.slice(0, maxLength);
  // The ids kept between the two ends are ids[start .. length - 2], the newest that fit.
  let start = ids.length - 1;
  while (start > 1) {
    const next = (ids[start - 1] ?? "").length + 1;
    if (length + next > maxLength) break;
    length += next;
    start -= 1;
  }
  return [first, ...ids.slice(start, -1), last].join(" ");
}
