import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { LiveRunnerOptions } from "../runner.js";

/**
 * The live tool-choice eval: everyday requests, each with the tools that are
 * a right move, put to a model through `tavi run --approval deny` and
 * scored on the calls it makes: a run passes when an expected tool comes
 * within the first few calls with only read-only look-ups before it (and,
 * where a case names them, that call carries its key arguments); the strict
 * first-call rate is reported beside it. Repeated runs give pass^k: a case
 * passes only when every run of it does. It gates changes to tool
 * descriptions, deferral and the system prompt, which the offline selection
 * eval cannot see.
 *
 * Erasable TypeScript only, so `node evals/tool-choice/eval.ts` runs it with
 * no build and `tests/tool-choice-eval.test.ts` imports its pure parts.
 */

// What a template may hold, each run's private copy and the runner's scaffold are shared with the other live evals
// (`node` runs the .ts; the types come from it too).
const {
  chosenById,
  liveRun,
  liveRunnerOptions,
  parseRunnerFlags,
  reportHead,
  repositoryRoot,
  runnerData,
  runWhenMain,
  withRunData,
  writeReport,
} = (await import(new URL("../runner.ts", import.meta.url).href)) as typeof import("../runner.js");

export interface ChoiceCase {
  readonly id: string;
  readonly prompt: string;
  /** Tool ids, `family.*` or `*.verb` patterns, any of which is a right call. */
  readonly expect: readonly string[];
  /** Words the expected call's input must carry, by field, case-insensitively. */
  readonly args?: Readonly<Record<string, string>>;
  /** An answer with no tool call passes too. */
  readonly noToolOk?: boolean;
  /** Look-ups, beyond `LEAD_IN_TOOLS`, this case allows before an expected call (ids or patterns). */
  readonly leadIn?: readonly string[];
  /** What the data directory must hold for the case to be run (`REQUIREMENTS`); without it the case is skipped. */
  readonly requires?: readonly string[];
}

/** What a case may require of the data directory: a connected mail account, a connected calendar. A template holds neither. */
export const REQUIREMENTS = new Set(["mail", "calendar"]);

export interface ChoiceCasesFile {
  readonly version: 1;
  readonly cases: readonly ChoiceCase[];
}

export function parseCasesFile(value: unknown): ChoiceCasesFile {
  const file = value as { version?: unknown; cases?: unknown };
  if (file.version !== 1 || !Array.isArray(file.cases)) throw new Error("cases.json: expected { version: 1, cases: [...] }");
  const ids = new Set<string>();
  for (const entry of file.cases as ChoiceCase[]) {
    if (typeof entry.id !== "string" || typeof entry.prompt !== "string" || !Array.isArray(entry.expect))
      throw new Error(`cases.json: a case needs id, prompt and expect (${JSON.stringify(entry).slice(0, 80)})`);
    if (ids.has(entry.id)) throw new Error(`cases.json: duplicate case ${entry.id}`);
    for (const field of ["leadIn", "requires"] as const) {
      const list = entry[field];
      if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== "string")))
        throw new Error(`cases.json: ${entry.id}.${field} must be a list of strings`);
    }
    const unknown = (entry.requires ?? []).filter((need) => !REQUIREMENTS.has(need));
    if (unknown.length > 0) throw new Error(`cases.json: ${entry.id} requires unknown ${unknown.join(", ")}`);
    ids.add(entry.id);
  }
  return file as ChoiceCasesFile;
}

/** Calls that set up rather than choose: a search for a deferred tool, a plan. They are skipped wherever they come and never count as a call. */
const PRELUDE_TOOLS = new Set(["tools.search", "plan.update"]);

/** How many calls (after preludes) a run has to reach an expected tool, the ones before it all look-ups. */
export const LEAD_IN_WINDOW = 3;

/**
 * Read-only look-ups any case allows before its expected call: listing what
 * exists before creating, searching memory before asking, finding the file
 * before reading it. Never a tool that writes, sends or acts.
 */
export const LEAD_IN_TOOLS: readonly string[] = ["*.list", "*.search", "*.status", "*.info", "fs.glob", "fs.list", "fs.read", "fs.grep"];

export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

export interface RunSummary {
  readonly status: "completed" | "failed" | "unknown";
  /** Calls in the order the model made them: run (`tool.started`) or asked about and refused (`approval.required`). */
  readonly calls: readonly ToolCall[];
  readonly tokens?: number;
  readonly timedOut?: true;
}

export function summarizeStream(ndjson: string): RunSummary {
  let status: RunSummary["status"] = "unknown";
  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  let tokens: number | undefined;
  for (const line of ndjson.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = event["kind"];
    if ((kind === "tool.started" || kind === "approval.required") && typeof event["toolName"] === "string") {
      // A call asked about, then refused, is one call: count it once. A provider may reuse a call id across
      // turns, so the tool's name is part of what makes a call the same one.
      const key = `${typeof event["callId"] === "string" ? event["callId"] : `${calls.length}`}\u0000${event["toolName"]}`;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push({ name: event["toolName"], input: event["input"] });
      }
    } else if (kind === "task.completed" || kind === "task.failed") {
      status = kind === "task.completed" ? "completed" : "failed";
      const metrics = event["metrics"] as { readonly totalTokens?: unknown } | undefined;
      if (typeof metrics?.totalTokens === "number") tokens = (tokens ?? 0) + metrics.totalTokens;
    }
  }
  return { status, calls, ...(tokens === undefined ? {} : { tokens }) };
}

/** Whether `toolId` matches `pattern`: an exact id, `family.*` for any tool of the family, or `*.verb` for any family's tool of that name. */
export function matchesTool(pattern: string, toolId: string): boolean {
  if (pattern.endsWith(".*")) return toolId.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*.")) return toolId.endsWith(pattern.slice(1));
  return pattern === toolId;
}

export interface CaseRun {
  readonly id: string;
  readonly passed: boolean;
  /** Passed on its very first call (after any prelude), with no look-up before it. */
  readonly strict: boolean;
  /** The expected call it reached, else the call that decided the failure, or none. */
  readonly chose?: string;
  /** The look-ups it made before `chose`, when it passed after some. */
  readonly leadIn?: readonly string[];
  readonly reason?: string;
  readonly tokens?: number;
}

export function scoreRun(entry: ChoiceCase, run: RunSummary): CaseRun {
  const calls = run.calls.filter((call) => !PRELUDE_TOOLS.has(call.name));
  const tokens = run.tokens === undefined ? {} : { tokens: run.tokens };
  const fail = (reason: string, chose?: string): CaseRun => ({
    id: entry.id,
    passed: false,
    strict: false,
    ...(chose === undefined ? {} : { chose }),
    reason,
    ...tokens,
  });
  if (run.timedOut === true) return fail("timed out");
  if (calls.length === 0) {
    // No call passes only as an answer: a run that failed, or never ended, chose nothing.
    if (run.status !== "completed") return fail(`run ${run.status}`);
    return entry.noToolOk === true || entry.expect.length === 0
      ? { id: entry.id, passed: true, strict: true, ...tokens }
      : fail("no tool called");
  }
  const expected = (name: string) => entry.expect.some((pattern) => matchesTool(pattern, name));
  const lookUps = [...LEAD_IN_TOOLS, ...(entry.leadIn ?? [])];
  const lookUp = (name: string) => lookUps.some((pattern) => matchesTool(pattern, name));
  const window = calls.slice(0, LEAD_IN_WINDOW);
  const at = window.findIndex((call) => expected(call.name));
  // Before the expected call (or, missing it, anywhere in the window), the first call that is no look-up decides: a wrong action fails.
  const wrong = window.findIndex((call, index) => (at === -1 || index < at) && !lookUp(call.name));
  if (wrong !== -1) return fail(`chose ${window[wrong]?.name}`, window[wrong]?.name);
  if (at === -1) {
    const names = window.map((call) => call.name);
    return fail(
      calls.length > LEAD_IN_WINDOW
        ? `no expected call in the first ${LEAD_IN_WINDOW} (${names.join(", ")})`
        : `only looked up (${names.join(", ")})`,
      names[0],
    );
  }
  const chosen = calls[at] as ToolCall;
  const input = (typeof chosen.input === "object" && chosen.input !== null ? chosen.input : {}) as Record<string, unknown>;
  for (const [field, words] of Object.entries(entry.args ?? {})) {
    const value = JSON.stringify(input[field] ?? "").toLowerCase();
    if (!value.includes(words.toLowerCase())) return fail(`${field} lacks "${words}"`, chosen.name);
  }
  return {
    id: entry.id,
    passed: true,
    strict: at === 0,
    chose: chosen.name,
    ...(at === 0 ? {} : { leadIn: calls.slice(0, at).map((call) => call.name) }),
    ...tokens,
  };
}

/** A case not run: the data directory lacks what it requires. */
export interface SkippedCase {
  readonly id: string;
  readonly requires: readonly string[];
}

/** The cases a data directory holding `available` can run, and the ones it skips. */
export function selectCases(
  cases: readonly ChoiceCase[],
  available: readonly string[],
): { readonly run: readonly ChoiceCase[]; readonly skipped: readonly SkippedCase[] } {
  const run: ChoiceCase[] = [];
  const skipped: SkippedCase[] = [];
  for (const entry of cases) {
    const missing = (entry.requires ?? []).filter((need) => !available.includes(need));
    if (missing.length === 0) run.push(entry);
    else skipped.push({ id: entry.id, requires: missing });
  }
  return { run, skipped };
}

export interface ChoiceSummary {
  readonly cases: number;
  readonly runs: number;
  /** Share of runs that passed, look-ups before the expected call allowed (pass@1, averaged). */
  readonly passRate: number;
  /** Share of cases every run of which passed (pass^k). */
  readonly passAll: number;
  /** The same two, counting a run only when its very first call was the expected one. */
  readonly strictPassRate: number;
  readonly strictPassAll: number;
  readonly failing: readonly string[];
  /** Cases that passed, but not on the first call in every run. */
  readonly strictFailing: readonly string[];
  /** Cases not run: the data directory lacks what they require. */
  readonly skipped: readonly SkippedCase[];
  readonly tokensPerRun?: number;
}

export function summarize(runs: readonly CaseRun[], skipped: readonly SkippedCase[] = []): ChoiceSummary {
  const byCase = new Map<string, CaseRun[]>();
  for (const run of runs) byCase.set(run.id, [...(byCase.get(run.id) ?? []), run]);
  const failing = [...byCase].filter(([, list]) => list.some((run) => !run.passed)).map(([id]) => id);
  const strictMissed = [...byCase].filter(([, list]) => list.some((run) => !run.strict)).map(([id]) => id);
  const counted = runs.filter((run) => run.tokens !== undefined);
  const share = (count: number, of: number) => (of === 0 ? 0 : Math.round((count / of) * 1000) / 1000);
  return {
    cases: byCase.size,
    runs: runs.length,
    passRate: share(runs.filter((run) => run.passed).length, runs.length),
    passAll: share(byCase.size - failing.length, byCase.size),
    strictPassRate: share(runs.filter((run) => run.strict).length, runs.length),
    strictPassAll: share(byCase.size - strictMissed.length, byCase.size),
    failing,
    strictFailing: strictMissed.filter((id) => !failing.includes(id)),
    skipped,
    ...(counted.length === 0
      ? {}
      : { tokensPerRun: Math.round(counted.reduce((total, run) => total + (run.tokens ?? 0), 0) / counted.length) }),
  };
}

export function formatSummary(summary: ChoiceSummary, runs: readonly CaseRun[]): string {
  const lines = [
    `cases ${summary.cases}, runs ${summary.runs}`,
    `pass rate ${summary.passRate}, pass^k ${summary.passAll}${summary.tokensPerRun === undefined ? "" : `, ${summary.tokensPerRun} tokens a run`}`,
    `strict first call: pass rate ${summary.strictPassRate}, pass^k ${summary.strictPassAll}`,
  ];
  if (summary.skipped.length > 0)
    lines.push(`skipped ${summary.skipped.map((entry) => `${entry.id} (needs ${entry.requires.join(", ")})`).join(", ")}`);
  for (const run of runs.filter((entry) => !entry.passed)) lines.push(`  ✗ ${run.id}: ${run.reason ?? "failed"}`);
  for (const run of runs.filter((entry) => entry.passed && entry.leadIn !== undefined))
    lines.push(`  ~ ${run.id}: ${run.chose} after ${run.leadIn?.join(", ")}`);
  return lines.join("\n");
}

export interface RunnerOptions extends LiveRunnerOptions {
  readonly casesPath: string;
  /** What the data directory holds that some cases require (`--with`); cases needing anything else are skipped. */
  readonly available: readonly string[];
}

/** The runner's options; a run without `--template` or `--data-dir` is refused, so it never writes into the default data directory. */
export function parseArgs(argv: readonly string[]): RunnerOptions {
  const available: string[] = [];
  const flags = parseRunnerFlags(argv, {
    fileFlag: "--cases",
    file: join(repositoryRoot, "evals", "tool-choice", "cases.json"),
    onlyFlag: "--case",
    outDir: join(repositoryRoot, "evals", "tool-choice", "results"),
    timeoutSeconds: 120,
    repeat: 3,
    extra: (flag, value) => {
      if (flag !== "--with") return false;
      available.push(...value().split(","));
      return true;
    },
  });
  const unknown = available.filter((need) => !REQUIREMENTS.has(need));
  if (unknown.length > 0) throw new Error(`--with takes ${[...REQUIREMENTS].join(", ")}, not ${unknown.join(", ")}`);
  if (available.length > 0 && flags.template !== undefined)
    throw new Error("--with needs --data-dir: a template holds no mail account or calendar, so its runs could not use them");
  return {
    casesPath: flags.file,
    available,
    ...liveRunnerOptions(flags, runnerData(flags.template, flags.dataDir, "evals/tool-choice/README.md")),
  };
}

/** One run of `prompt` in `dataDir`, read for its calls. */
function taviRun(prompt: string, dataDir: string, options: RunnerOptions): Promise<RunSummary> {
  return liveRun(prompt, dataDir, options, summarizeStream);
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const chosen = chosenById(parseCasesFile(JSON.parse(readFileSync(options.casesPath, "utf8"))).cases, options.only, "case");
  const { run: cases, skipped } = selectCases(chosen, options.available);
  if (cases.length === 0)
    throw new Error(
      `nothing to run: ${skipped.map((entry) => `${entry.id} needs ${entry.requires.join(", ")}`).join("; ")} (--with, with --data-dir)`,
    );
  const log = (message: string): void => void process.stderr.write(`[tool-choice eval] ${message}\n`);
  for (const entry of skipped) log(`skipping ${entry.id}: needs ${entry.requires.join(", ")} (--with)`);
  const startedAt = new Date();
  const runs: CaseRun[] = [];
  await withRunData(options.data, { prefix: "choice-", log }, async (dataDirFor, done) => {
    let count = 0;
    for (const entry of cases)
      for (let run = 1; run <= options.repeat; run += 1) {
        log(`${entry.id} #${run}…`);
        count += 1;
        const dataDir = dataDirFor(`r${count}`);
        try {
          runs.push(scoreRun(entry, await taviRun(entry.prompt, dataDir, options)));
        } finally {
          done(dataDir);
        }
      }
  });
  const summary = summarize(runs, skipped);
  const path = writeReport(options.outDir, startedAt, { ...reportHead(options, startedAt), summary, runs });
  process.stdout.write(`${formatSummary(summary, runs)}\n\nreport: ${path}\n`);
  return summary.failing.length === 0 ? 0 : 1;
}

runWhenMain(import.meta.url, main);
