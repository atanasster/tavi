import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { LiveRunnerOptions, RunSummary } from "../runner.js";

// What reads as Bulgarian is shared with the ideas eval, and the runner's scaffold with the other live evals
// (`node` runs the .ts; the types come from it too).
const [
  { BULGARIAN_AT, cyrillicShare },
  {
    chosenById,
    liveRun,
    liveRunnerOptions,
    parseRunnerFlags,
    reportHead,
    repositoryRoot,
    runnerData,
    running,
    runWhenMain,
    summarizeStream,
    withRunData,
    writeReport,
  },
] = await Promise.all([
  import(new URL("../language.ts", import.meta.url).href) as Promise<typeof import("../language.js")>,
  import(new URL("../runner.ts", import.meta.url).href) as Promise<typeof import("../runner.js")>,
]);

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

export interface RunnerOptions extends LiveRunnerOptions {
  readonly casesPath: string;
}

/** The runner's options: `--template` or `--data-dir`, so it never writes into the default data directory. */
export async function parseArgs(argv: readonly string[]): Promise<RunnerOptions> {
  const flags = parseRunnerFlags(argv, {
    fileFlag: "--cases",
    file: join(repositoryRoot, "evals", "reply-language", "cases.json"),
    onlyFlag: "--case",
    outDir: join(repositoryRoot, "evals", "reply-language", "results"),
    timeoutSeconds: 120,
    repeat: 3,
  });
  return {
    casesPath: flags.file,
    ...liveRunnerOptions(flags, runnerData(flags.template, flags.dataDir, "evals/reply-language/README.md")),
  };
}

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
function taviRun(prompt: string, dataDir: string, options: RunnerOptions): Promise<RunSummary> {
  return liveRun(prompt, dataDir, options, summarizeStream);
}

async function main(argv: readonly string[]): Promise<number> {
  const options = await parseArgs(argv);
  const cases = chosenById(parseCasesFile(JSON.parse(readFileSync(options.casesPath, "utf8"))).cases, options.only, "case");
  const startedAt = new Date();
  const runs: CaseRun[] = [];
  const log = (message: string): void => void process.stderr.write(`[reply-language eval] ${message}\n`);
  await withRunData(options.data, { prefix: "lang-", log }, async (dataDirFor, done) => {
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
  });
  const summary = summarize(runs);
  const path = writeReport(options.outDir, startedAt, { ...reportHead(options, startedAt), summary, runs });
  process.stdout.write(`${formatSummary(summary, runs, options.label)}\n\nreport: ${path}\n`);
  return summary.failing.length === 0 ? 0 : 1;
}

runWhenMain(import.meta.url, main);
