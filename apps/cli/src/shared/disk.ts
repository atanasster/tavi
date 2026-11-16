import { statfsSync } from "node:fs";

import { MIN_FREE_BYTES_FOR_A_FIRE } from "@tavi/agent-host/schedule-scheduler";

/**
 * Free-space probe for the data directory.
 *
 * The daemon has to know how much room it has *before* it needs it: the alert
 * that would report a full disk goes through `messaging.send`, whose outbox row is
 * itself a database write, so a disk discovered full at the moment of failure
 * cannot announce its own failure. Everything here therefore answers one
 * question — "is there still headroom?" — and never throws, because a probe that
 * fails must not be the reason a fire does not run.
 */

/** Free bytes on the filesystem holding `path`, or `undefined` when it cannot be read. */
export function freeBytesAt(path: string): number | undefined {
  try {
    const stats = statfsSync(path);
    // `bavail` is what an unprivileged process may use, which is the number that
    // matters here; `bfree` would count blocks reserved for root.
    return stats.bsize * stats.bavail;
  } catch {
    // A missing directory (a fresh install) or an unsupported platform: unknown,
    // which callers treat as "do not block the run".
    return undefined;
  }
}

/**
 * `doctor`'s view of the same probe, with the verdict already applied.
 *
 * `belowFloor` is `null` when the figure is unknown — not `false`. A report that
 * said "not below the floor" because it could not read the filesystem would be
 * read as a clean bill of health for the one thing the check exists to catch.
 */
export function diskStatus(dataDirectory: string): {
  readonly dataDirectory: string;
  readonly freeBytes: number | null;
  readonly belowFloor: boolean | null;
} {
  const freeBytes = freeBytesAt(dataDirectory);
  return {
    dataDirectory,
    freeBytes: freeBytes ?? null,
    belowFloor: freeBytes === undefined ? null : freeBytes < MIN_FREE_BYTES_FOR_A_FIRE,
  };
}
