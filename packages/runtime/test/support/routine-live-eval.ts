/**
 * The opt-in live evaluation harness's contract.
 *
 * Everything here is pure: reading the environment, deciding whether a live run
 * is *complete*, and naming the trace files. The harness itself
 * (`packages/runtime/test/routine-live.eval.test.ts`) is skipped unless
 * `TAVI_LIVE_EVAL=1`, and these helpers exist so the parts that decide whether a
 * live result counts can be tested without spending anything.
 */

export interface LiveEvalConfig {
  /** OpenAI-compatible endpoint of the operator's provider. */
  readonly baseUrl: string;
  readonly model: string;
  /** A **file** path. A key in `argv` lands in shell history and `ps`. */
  readonly apiKeyFile: string;
  /** Repetitions, because a live run is stochastic and one number is not a measurement. */
  readonly reps: number;
  /** Total provider calls the whole run may make, across every repetition and role. */
  readonly callCeiling: number;
  /** Where traces land; gitignored. */
  readonly traceDirectory: string;
}

export type LiveEvalConfigResult = { readonly ok: true; readonly config: LiveEvalConfig } | { readonly ok: false; readonly reason: string };

/**
 * Read the live configuration from the environment.
 *
 * Refuses rather than defaulting: a live run spends the operator's money against
 * a named provider, so "which provider, which key file, how many calls" must all
 * be stated. An API key passed any other way is refused by omission — there is no
 * `TAVI_LIVE_EVAL_API_KEY`.
 */
export function liveEvalConfigFromEnv(env: Readonly<Record<string, string | undefined>>): LiveEvalConfigResult {
  if (env["TAVI_LIVE_EVAL"] !== "1") return { ok: false, reason: "TAVI_LIVE_EVAL=1 is required; the live harness never runs by default" };
  const baseUrl = env["TAVI_LIVE_EVAL_BASE_URL"];
  const model = env["TAVI_LIVE_EVAL_MODEL"];
  const apiKeyFile = env["TAVI_LIVE_EVAL_API_KEY_FILE"];
  if (baseUrl === undefined || baseUrl === "") return { ok: false, reason: "TAVI_LIVE_EVAL_BASE_URL is required" };
  if (model === undefined || model === "") return { ok: false, reason: "TAVI_LIVE_EVAL_MODEL is required" };
  if (apiKeyFile === undefined || apiKeyFile === "")
    return { ok: false, reason: "TAVI_LIVE_EVAL_API_KEY_FILE is required (a file path, never a key on the command line)" };
  if (env["TAVI_LIVE_EVAL_API_KEY"] !== undefined)
    return { ok: false, reason: "pass the key in a file (TAVI_LIVE_EVAL_API_KEY_FILE); a key in the environment is refused" };
  const reps = env["TAVI_LIVE_EVAL_REPS"] === undefined ? 1 : Number(env["TAVI_LIVE_EVAL_REPS"]);
  if (!Number.isSafeInteger(reps) || reps < 1 || reps > 10)
    return { ok: false, reason: "TAVI_LIVE_EVAL_REPS must be an integer between 1 and 10" };
  const callCeiling = env["TAVI_LIVE_EVAL_CALL_CEILING"] === undefined ? 200 : Number(env["TAVI_LIVE_EVAL_CALL_CEILING"]);
  if (!Number.isSafeInteger(callCeiling) || callCeiling < 1 || callCeiling > 5_000)
    return { ok: false, reason: "TAVI_LIVE_EVAL_CALL_CEILING must be an integer between 1 and 5000" };
  return {
    ok: true,
    config: { baseUrl, model, apiKeyFile, reps, callCeiling, traceDirectory: env["TAVI_LIVE_EVAL_TRACE_DIR"] ?? ".evidence/routines" },
  };
}

/**
 * One role's result inside one repetition of a live run.
 *
 * A trace does not carry per-item identities — the durable quality row records
 * counters, not the ids of the sampled corpus items — so completeness is decided
 * from the counts the run actually produced: `expected` is what the sample set out
 * to score in that role, `scored` is what the scorer recorded. Re-deriving
 * expected case *names* in the harness is what let a fabricated
 * `research:<rep>:x` list never match the real `<rep>:<corpus id>` keys.
 */
export interface LiveEvalRoleMeasurement {
  readonly repetition: number;
  readonly role: "research" | "synthesis";
  /** Items the sample asked this role to score. */
  readonly expected: number;
  /** Items the scorer actually recorded a verdict for. */
  readonly scored: number;
}
export interface LiveEvalVerdict {
  readonly complete: boolean;
  readonly scored: number;
  readonly expected: number;
  readonly missing: readonly string[];
}

/**
 * Whether a live run may be reported as complete.
 *
 * `complete` means every item the run set out to score, in both roles and every
 * repetition, was actually scored. A run stopped by the call ceiling, a provider
 * failure, an aborted repetition or the deadline is **incomplete** and must be
 * reported as such: a precision measured over the cases that happened to finish is
 * not the precision of the gate.
 */
export function liveEvaluationVerdict(measurements: readonly LiveEvalRoleMeasurement[]): LiveEvalVerdict {
  // `expected <= 0` is not "nothing to do", it is "no sample was recorded" — a
  // trace that cannot say what it set out to score cannot be reported complete.
  const unscored = measurements.filter((entry) => entry.expected <= 0 || entry.scored < entry.expected);
  return {
    // An empty matrix is not a complete run: nothing measured is not a measurement.
    complete: measurements.length > 0 && unscored.length === 0,
    scored: measurements.reduce((sum, entry) => sum + entry.scored, 0),
    expected: measurements.reduce((sum, entry) => sum + entry.expected, 0),
    missing: unscored.map((entry) =>
      entry.expected <= 0
        ? `${entry.repetition}:${entry.role} (no sample recorded)`
        : `${entry.repetition}:${entry.role} (${entry.expected - entry.scored} of ${entry.expected} unscored)`,
    ),
  };
}

/** The trace file a repetition writes; `.evidence/routines/` is gitignored. */
export function liveEvalTracePath(config: LiveEvalConfig, repetition: number, stamp: string): string {
  return `${config.traceDirectory.replace(/\/$/, "")}/live-eval-${stamp}-rep${repetition}.json`;
}
