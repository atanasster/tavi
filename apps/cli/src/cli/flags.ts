import { TaviError } from "@tavi/contracts";
import { normalizeHostEntry } from "@tavi/runtime/host-policy";

export function requireFlag(value: string | undefined, flag: string): string {
  if (value === undefined) throw new TaviError("INVALID_INPUT", `${flag} is required`);
  return value;
}

/**
 * Refuse a host allowlist entry that cannot mean what it says.
 *
 * `normalizeHostEntry` is the single place that decides what an entry means, and it
 * returns `undefined` for an entry it will not honor. Silently dropping that entry
 * makes the whole allowlist look enforced while it is not, so this turns it into a
 * named error at the point the operator can still fix it.
 */
export function assertHostEntries(entries: readonly string[], flag: string): readonly string[] {
  for (const entry of entries) {
    if (normalizeHostEntry(entry) === undefined) {
      throw new TaviError(
        "INVALID_INPUT",
        `${flag} ${JSON.stringify(entry)} is not a usable host entry: a wildcard cannot carry a port, and a ` +
          "wildcard over a shared/multi-tenant domain (s3.amazonaws.com, workers.dev, github.io, …) would grant " +
          "every domain under it. Name the exact host instead",
        { details: { entry, flag } },
      );
    }
  }
  return entries;
}
