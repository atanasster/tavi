import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunSummary } from "../heartbeat/eval.js";
import type { RunnerData } from "../template.js";

// What reads as Bulgarian is shared with the ideas eval (`node` runs the .ts; the types come from it too).
const { BULGARIAN_AT, cyrillicShare } = (await import(new URL("../language.ts", import.meta.url).href)) as typeof import("../language.js");

/**
 * The reply-language eval: whether the agent answers in the language the
 * workspace's reply-language fact asks for (I18N-PLAN decision 8). A Bulgarian
 * workspace's runtime facts say "The person's language is Bulgarian: reply in
 * Bulgarian unless they write in another language."; an English workspace has
 * no such line. Each case is one `tavi run --approval deny` of a prompt in a
 * workspace set to `en` or `bg`, and the answer's language is read from its
 * letters — the share that is Cyrillic — with no judge model.
 *
 * What each case expects follows from the fact (`expectedReply`), and the cases
 * file is checked against it as it is read, so a case cannot drift from it:
 *
 * - a Bulgarian workspace, a Bulgarian prompt: Bulgarian;
 * - a Bulgarian workspace, an English prompt: English, since the person wrote
 *   in another language;
 * - a Bulgarian workspace, a prompt with no words (emoji only): Bulgarian, the
 *   case the fact alone decides;
 * - an English workspace: no fact, as before languages, so the model answers
 *   in the prompt's language, and in English when the prompt has no words.
 *
 * Erasable TypeScript only (with `evals/template.ts`), so
 * `node evals/reply-language/eval.ts` runs it with no build and
 * `tests/reply-language-eval.test.ts` imports its pure parts.
 */

export type ReplyLanguage = "en" | "bg";
export type PromptLanguage = ReplyLanguage | "neutral";
const LANGUAGES: readonly ReplyLanguage[] = ["en", "bg"];
const PROMPT_LANGUAGES: readonly PromptLanguage[] = ["en", "bg", "neutral"];

export interface LanguageCase {
  readonly id: string;
  /** The workspace's `workspace.locale`; `en` is cleared (`config unset`), as a workspace from before languages has it. */
  readonly workspace: ReplyLanguage;
  readonly prompt: string;
  /** The prompt's own language; `neutral` has no letters (emoji, numbers). */
  readonly promptLanguage: PromptLanguage;
  /** The language the reply must be in. */
  readonly expect: ReplyLanguage;
}

/**
 * The reply language decision 8 asks for: in a non-English workspace, the
 * workspace's language unless the person writes in another one; in English,
 * no fact, so the person's own language as models answer by default, and
 * English when they wrote no words.
 */
export function expectedReply(workspace: ReplyLanguage, prompt: PromptLanguage): ReplyLanguage {
  if (prompt === "neutral") return workspace;
  return prompt;
}

/** What a text's letters say of its language. */
export interface LanguageReading {
  readonly language: ReplyLanguage | "mixed" | "unknown";
  readonly cyrillic: number;
  readonly latin: number;
  /** Cyrillic letters over Cyrillic and Latin ones; undefined with neither. */
  readonly cyrillicShare?: number;
}

/** Fewer letters than this say nothing of a language (an emoji, a number, "OK"). */
export const MIN_LETTERS = 12;
/** At most this share reads as English: a quoted Bulgarian word is allowed for. */
export const ENGLISH_AT = 0.1;

/**
 * The language of `text`, read from its letters with no model: code, inline
 * code and addresses are taken out first (they are Latin in any language),
 * then the share of Cyrillic letters among Cyrillic and Latin ones decides.
 */
export function readLanguage(text: string): LanguageReading {
  const prose = text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/giu, " ")
    .replace(/\S+@\S+\.\S+/gu, " ");
  const { cyrillic, latin, share } = cyrillicShare(prose);
  if (share === undefined) return { language: "unknown", cyrillic, latin };
  const language = cyrillic + latin < MIN_LETTERS ? "unknown" : share >= BULGARIAN_AT ? "bg" : share <= ENGLISH_AT ? "en" : "mixed";
  return { language, cyrillic, latin, cyrillicShare: share };
}

/** The cases file, checked as it is read: each case's prompt is in its stated language and its expectation is decision 8's. */
export function parseCasesFile(raw: unknown): { readonly cases: readonly LanguageCase[] } {
  const file = raw as { readonly version?: unknown; readonly cases?: unknown };
  if (file?.version !== 1 || !Array.isArray(file.cases)) throw new Error("reply-language cases: expected { version: 1, cases: [...] }");
  const ids = new Set<string>();
  for (const entry of file.cases as LanguageCase[]) {
    if (typeof entry?.id !== "string" || entry.id === "" || ids.has(entry.id))
      throw new Error(`reply-language cases: a case needs its own id (duplicate or missing: ${String(entry?.id)})`);
    ids.add(entry.id);
    if (!LANGUAGES.includes(entry.workspace)) throw new Error(`reply-language cases: ${entry.id} has no workspace language (en or bg)`);
    if (!PROMPT_LANGUAGES.includes(entry.promptLanguage))
      throw new Error(`reply-language cases: ${entry.id} has no prompt language (en, bg or neutral)`);
    if (typeof entry.prompt !== "string" || entry.prompt.trim() === "") throw new Error(`reply-language cases: ${entry.id} has no prompt`);
    const read = readLanguage(entry.prompt);
    // A neutral prompt has no letters at all: a short worded one ("Thanks!") is written in a language, too few letters or not.
    const said = entry.promptLanguage === "neutral" ? read.cyrillic + read.latin === 0 : read.language === entry.promptLanguage;
    if (!said)
      throw new Error(
        `reply-language cases: ${entry.id}'s prompt reads as ${entry.promptLanguage === "neutral" && read.language === "unknown" ? "words" : read.language}, not ${entry.promptLanguage}`,
      );
    const expected = expectedReply(entry.workspace, entry.promptLanguage);
    if (entry.expect !== expected)
      throw new Error(`reply-language cases: ${entry.id} expects ${String(entry.expect)}, but decision 8 asks for ${expected}`);
  }
  return { cases: file.cases as LanguageCase[] };
}

export interface CaseRun {
  readonly id: string;
  readonly repeat: number;
  readonly passed: boolean;
  readonly expect: ReplyLanguage;
  readonly reading: LanguageReading;
  readonly status: RunSummary["status"];
  readonly problem?: string;
  readonly tokens?: number;
  readonly timedOut?: true;
  /** The reply's first words, for a reader of the report. */
  readonly excerpt: string;
}

/** One run scored: it completed, and its answer reads in the expected language. */
export function scoreRun(entry: LanguageCase, run: RunSummary, repeat = 1): CaseRun {
  const reading = readLanguage(run.finalText);
  const problem =
    run.timedOut === true
      ? "timed out"
      : run.status !== "completed"
        ? `the run ${run.status === "failed" ? "failed" : "did not finish"}`
        : reading.language !== entry.expect
          ? `answered in ${reading.language === "unknown" ? "too few words to tell" : reading.language}, expected ${entry.expect}`
          : undefined;
  return {
    id: entry.id,
    repeat,
    passed: problem === undefined,
    expect: entry.expect,
    reading,
    status: run.status,
    ...(problem === undefined ? {} : { problem }),
    ...(run.tokens === undefined ? {} : { tokens: run.tokens }),
    ...(run.timedOut === true ? { timedOut: true as const } : {}),
    excerpt: run.finalText.replace(/\s+/gu, " ").trim().slice(0, 160),
  };
}

export interface EvalSummary {
  readonly cases: number;
  readonly runs: number;
  /** Runs that passed, of all. */
  readonly passRate: number;
  /** Cases every run of which passed. */
  readonly passAllK: number;
  /** Cases with a run that failed. */
  readonly failing: readonly string[];
}

export function summarize(runs: readonly CaseRun[]): EvalSummary {
  const byCase = new Map<string, CaseRun[]>();
  for (const run of runs) byCase.set(run.id, [...(byCase.get(run.id) ?? []), run]);
  const failing = [...byCase].filter(([, list]) => list.some((run) => !run.passed)).map(([id]) => id);
  return {
    cases: byCase.size,
    runs: runs.length,
    passRate: runs.length === 0 ? 0 : runs.filter((run) => run.passed).length / runs.length,
    passAllK: byCase.size === 0 ? 0 : (byCase.size - failing.length) / byCase.size,
    failing,
  };
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

export function formatSummary(summary: EvalSummary, runs: readonly CaseRun[], label?: string): string {
  return [
    `reply-language eval${label === undefined ? "" : ` (${label})`}: ${summary.runs} runs over ${summary.cases} cases, pass rate ${percent(summary.passRate)}, pass^k ${percent(summary.passAllK)}`,
    ...runs.map(
      (run) =>
        `${run.passed ? "PASS" : "FAIL"} ${run.id} #${run.repeat} (expected ${run.expect}; Cyrillic ${run.reading.cyrillicShare === undefined ? "n/a" : percent(run.reading.cyrillicShare)})${run.problem === undefined ? "" : `: ${run.problem}`}`,
    ),
  ].join("\n");
}

// ------------------------------------------------------------------ the runner

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RunnerOptions {
  readonly casesPath: string;
  readonly only: readonly string[];
  readonly connectionId?: string;
  readonly model?: string;
  readonly data: RunnerData;
  readonly label?: string;
  readonly outDir: string;
  readonly timeoutMs: number;
  readonly repeat: number;
}

/** The runner's options: `--template` or `--data-dir`, so it never writes into the default data directory. */
export async function parseArgs(argv: readonly string[]): Promise<RunnerOptions> {
  let casesPath = join(repositoryRoot, "evals", "reply-language", "cases.json");
  const only: string[] = [];
  let connectionId: string | undefined;
  let model: string | undefined;
  let template: string | undefined;
  let dataDir: string | undefined;
  let label: string | undefined;
  let outDir = join(repositoryRoot, "evals", "reply-language", "results");
  let timeoutSeconds = 120;
  let repeat = 3;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--cases":
        casesPath = resolve(value());
        break;
      case "--case":
        only.push(...value().split(","));
        break;
      case "--connection":
        connectionId = value();
        break;
      case "--model":
        model = value();
        break;
      case "--template":
        template = value();
        break;
      case "--data-dir":
        dataDir = value();
        break;
      case "--label":
        label = value();
        break;
      case "--out":
        outDir = resolve(value());
        break;
      case "--timeout-s":
        timeoutSeconds = Number(value());
        break;
      case "--repeat":
        repeat = Number(value());
        break;
      default:
        throw new Error(`unknown option ${String(flag)}`);
    }
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout-s must be a positive whole number");
  if (!Number.isInteger(repeat) || repeat <= 0) throw new Error("--repeat must be a positive whole number");
  const { runnerData } = (await import(new URL("../template.ts", import.meta.url).href)) as typeof import("../template.js");
  return {
    casesPath,
    only,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(model === undefined ? {} : { model }),
    data: runnerData(template, dataDir, "evals/reply-language/README.md"),
    ...(label === undefined ? {} : { label }),
    outDir,
    timeoutMs: timeoutSeconds * 1000,
    repeat,
  };
}

/** The `tavi` children still running, stopped by an interrupt. */
const running = new Set<ChildProcess>();

/**
 * The workspace's language for a case, in `dataDir`: `tavi config set workspace.locale bg`, or for English
 * `tavi config unset workspace.locale`, as a workspace from before languages has it — whatever the template or an
 * earlier case in a shared `--data-dir` left. Refused, the run stops.
 */
function setLocale(language: ReplyLanguage, dataDir: string, timeoutMs: number): Promise<void> {
  const args = language === "en" ? ["unset", "workspace.locale"] : ["set", "workspace.locale", language];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(repositoryRoot, "scripts", "tavi.mjs"), "config", ...args, "--data-dir", dataDir], {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "inherit"],
    });
    running.add(child);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      running.delete(child);
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`tavi config ${args.join(" ")} exited ${String(code)} in ${dataDir}`));
    });
  });
}

/** One run of `prompt` in `dataDir`, read for its answer. */
async function taviRun(prompt: string, dataDir: string, options: RunnerOptions): Promise<RunSummary> {
  const [{ taviRunJson }, { summarizeStream }] = await Promise.all([
    import(new URL("../template.ts", import.meta.url).href) as Promise<typeof import("../template.js")>,
    import(new URL("../heartbeat/eval.ts", import.meta.url).href) as Promise<typeof import("../heartbeat/eval.js")>,
  ]);
  const { stdout, timedOut } = await taviRunJson({
    repositoryRoot,
    prompt,
    dataDir,
    ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    timeoutMs: options.timeoutMs,
    running,
  });
  return { ...summarizeStream(stdout), ...(timedOut ? { timedOut: true as const } : {}) };
}

async function main(argv: readonly string[]): Promise<number> {
  const options = await parseArgs(argv);
  const file = parseCasesFile(JSON.parse(readFileSync(options.casesPath, "utf8")));
  const unknown = options.only.filter((id) => !file.cases.some((entry) => entry.id === id));
  if (unknown.length > 0) throw new Error(`no such case: ${unknown.join(", ")}`);
  const cases = options.only.length === 0 ? file.cases : file.cases.filter((entry) => options.only.includes(entry.id));
  const startedAt = new Date();
  const runs: CaseRun[] = [];
  const log = (message: string): void => void process.stderr.write(`[reply-language eval] ${message}\n`);
  const runCases = async (dataDirFor: (name: string) => string, done: (dataDir: string) => void): Promise<void> => {
    let count = 0;
    for (const entry of cases)
      for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
        log(`${entry.id} #${repeat}…`);
        count += 1;
        const dataDir = dataDirFor(`r${count}`);
        try {
          await setLocale(entry.workspace, dataDir, options.timeoutMs);
          runs.push(scoreRun(entry, await taviRun(entry.prompt, dataDir, options), repeat));
        } finally {
          done(dataDir);
        }
      }
  };
  const { data } = options;
  if ("dataDir" in data)
    await runCases(
      () => data.dataDir,
      () => undefined,
    );
  else {
    const { withTemplateCopies } = (await import(new URL("../template.ts", import.meta.url).href)) as typeof import("../template.js");
    await withTemplateCopies(data.template, { prefix: "lang-", commands: running, log }, (copy) =>
      runCases(copy, (dataDir) => rmSync(dataDir, { recursive: true, force: true })),
    );
  }
  const summary = summarize(runs);
  const report = {
    ...(options.label === undefined ? {} : { label: options.label }),
    startedAt: startedAt.toISOString(),
    ...(options.connectionId === undefined ? {} : { connection: options.connectionId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    summary,
    runs,
  };
  mkdirSync(options.outDir, { recursive: true });
  const path = join(options.outDir, `${startedAt.toISOString().replaceAll(":", "-").replace(".", "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${formatSummary(summary, runs, options.label)}\n\nreport: ${path}\n`);
  return summary.failing.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
