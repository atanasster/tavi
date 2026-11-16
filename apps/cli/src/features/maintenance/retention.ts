/**
 * Retention policy for the transport tables.
 *
 * A daily daemon accumulates one inbox row per inbound message, one outbox row
 * per send, one mailbox envelope per delegation and one wait-intent row per
 * suspension, and nothing ever pruned any of them: the path to "the disk is
 * full, and then the alert about the disk being full cannot be written" was a
 * straight line with no gate on it.
 *
 * The window is a *default*, not a rule: `tavi prune --older-than` overrides it
 * for one run, and the sweep uses it only for rows whose state says nothing will
 * read them again.
 */

/** How long finished transport rows are kept before the sweep may delete them. */
export const DEFAULT_TRANSPORT_RETENTION_DAYS = 30;

/** How often `serve` prunes, once it has started. */
export const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The ISO instant `days` before `now` — the cutoff `pruneTransport` compares against. */
export function retentionCutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
