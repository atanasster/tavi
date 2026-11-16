/**
 * Whether `address` can be the From of mail sent through the Mailgun
 * `domain`: a plain address on that domain, compared case-insensitively.
 * Mail from any other domain fails the recipient's DMARC checks.
 */
export function isMailFromOnDomain(address: string, domain: string): boolean {
  const at = address.lastIndexOf("@");
  return /^[^\s<>@]+@[^\s<>@]+$/.test(address) && address.slice(at + 1).toLowerCase() === domain.toLowerCase();
}

/** The From of mail sent through `domain` when none was chosen. */
export function defaultMailFrom(domain: string): string {
  return `tavi@${domain}`;
}
