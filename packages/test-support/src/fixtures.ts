import { join } from "node:path";

/** The domains whose recorded source answers and labelled sets the suites share. */
export type FixtureDomain = "jobs" | "places" | "trends";

/**
 * Where a domain's recorded fixtures are: one copy, read by its kit's tests
 * and by the external plugins built on that kit, so no package reaches into
 * another's test folder.
 */
export function domainFixtures(domain: FixtureDomain): string {
  return join(import.meta.dirname, "..", "fixtures", domain);
}
