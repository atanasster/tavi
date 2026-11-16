/**
 * How the video trial judges a fixture against its manifest entry, and how it
 * decides the deny list: kept
 * apart from `trial.ts`, which runs the trial when loaded, so both are
 * tested (`tests/video-eval.test.ts`).
 */

export type Expectation = "decodes" | "refused-before-ffmpeg" | "refused-by-ffmpeg" | "contained";

export interface ManifestEntry {
  readonly sniff: string | null;
  readonly expect: Expectation;
  readonly note?: string;
}

/** One step's outcome: `ok`, `exit:<code>` (FFmpeg's own refusal), `failure:<why>` (killed or crashed), `refused:<why>`. */
export interface StepCost {
  readonly step: string;
  readonly outcome: string;
  readonly wallMs: number;
  readonly peakKb: number;
  /** FFmpeg's last diagnostics, for a step that did not succeed. */
  readonly stderr?: string;
}

/** The owner's worst event-loop delay a fixture may cause: "the owner answers within 1 s". */
export const OWNER_LAG_LIMIT_MS = 1_000;

export function judge(
  expected: ManifestEntry,
  sniff: string | null,
  steps: readonly StepCost[],
  lagMs: number,
): { readonly passed: boolean; readonly detail?: string } {
  const failed = steps.filter((step) => step.outcome !== "ok");
  const described = failed.map((step) => `${step.step}=${step.outcome}`).join(", ");
  const withDetail = (passed: boolean): { readonly passed: boolean; readonly detail?: string } =>
    described === "" ? { passed } : { passed, detail: described };
  if (lagMs > OWNER_LAG_LIMIT_MS) return { passed: false, detail: `the owner stalled ${String(lagMs)} ms` };
  if (sniff !== expected.sniff) return { passed: false, detail: `sniffed ${String(sniff)}, expected ${String(expected.sniff)}` };
  switch (expected.expect) {
    case "refused-before-ffmpeg":
      // Nothing ran: refused by the sniff, by opening it, or by the probe's limits.
      return withDetail(sniff === null || steps.every((step) => step.step === "open" || step.step === "limits"));
    case "decodes":
      return withDetail(failed.length === 0);
    case "refused-by-ffmpeg":
      // FFmpeg's own refusal (a non-zero exit), never a kill or a crash.
      return withDetail(failed.length > 0 && failed.every((step) => step.outcome.startsWith("exit:")));
    case "contained":
      // Any end but a crash of the run (a signal, an error starting it): an answer, a refusal, or a kill within caps.
      return withDetail(!failed.some((step) => step.outcome === "failure:crashed"));
  }
}

/** The extended deny list is adopted only if every fixture's steps end the same under it as under the standard one. */
export function denyListDecision(
  results: readonly { readonly fixture: string; readonly policy: "standard" | "extended"; readonly steps: readonly StepCost[] }[],
): { readonly decision: "adopt-extended" | "keep-standard"; readonly differ: readonly string[] } {
  const ends = (fixture: string, policy: string): string =>
    JSON.stringify(
      results
        .find((result) => result.fixture === fixture && result.policy === policy)
        ?.steps.map((step) => `${step.step}=${step.outcome}`) ?? null,
    );
  const fixtures = [...new Set(results.map((result) => result.fixture))];
  const differ = fixtures.filter((fixture) => ends(fixture, "standard") !== ends(fixture, "extended"));
  return { decision: differ.length === 0 ? "adopt-extended" : "keep-standard", differ };
}
