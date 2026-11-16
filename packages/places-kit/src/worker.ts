/** What both places plugins' engines share (PLUGINS.md): how a spent daily budget and a paused source are reported. */

/** The outcome a spent daily budget gives a source's report. */
export const DAILY_BUDGET_SPENT = "skipped: its daily budget is spent";

const PAUSED = "skipped: paused until ";

/** The outcome a paused source gives its report: paused after five failures in a row or an answer it could not read (domain-kit's source health). */
export function pausedOutcome(until: string): string {
  return `${PAUSED}${until}`;
}

/**
 * Reports with a spent daily budget marked `exhausted`, with when it resets
 * (the next UTC day, as the budget ledger counts), and a paused source's
 * marked `pausedUntil`, with a note the answer can repeat: the source's
 * results are missing until then.
 */
export function withExhaustion<T extends { readonly source: string; readonly outcome: string }>(
  reports: readonly T[],
  now: string,
): (T & { readonly exhausted?: true; readonly nextAt?: string; readonly pausedUntil?: string; readonly note?: string })[] {
  const day = new Date(now);
  const nextAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1)).toISOString();
  return reports.map((report) => {
    if (report.outcome === DAILY_BUDGET_SPENT) return { ...report, exhausted: true, nextAt };
    if (!report.outcome.startsWith(PAUSED)) return report;
    const pausedUntil = report.outcome.slice(PAUSED.length);
    const shown = `${pausedUntil.slice(0, 16).replace("T", " ")} UTC`;
    return {
      ...report,
      pausedUntil,
      note: `${report.source} is paused until ${shown} after failures, timeouts or a rate limit, so these results may be thin: say so in the answer`,
    };
  });
}
