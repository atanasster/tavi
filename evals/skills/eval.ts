import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunnerData } from "../template.js";

/**
 * The skill eval pair: each task run twice in a private copy of a template,
 * once with nothing to go on and once with a curated skill for it approved
 * and active (so the agent may load it with `skills.read`). The answers are
 * judged by checks written with the skill, not by the model under test: the
 * headings, formats and words the skill's procedure calls for. The report
 * says how often each arm passed, the difference, and how often the agent
 * loaded the skill, so a change that makes skills hurt (SkillsBench) shows.
 *
 * Erasable TypeScript only, so `node evals/skills/eval.ts` runs it with no
 * build and `tests/skill-eval.test.ts` imports its pure parts.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const { runnerData, taviRunJson, withTemplateCopies } = (await import(
  new URL("../template.ts", import.meta.url).href
)) as typeof import("../template.js");

export interface SkillCaseChecks {
  /** Text the answer must hold, case-sensitively. */
  readonly mustInclude?: readonly string[];
  /** Text it must not hold, case-insensitively. */
  readonly mustNotInclude?: readonly string[];
  /** Patterns it must match (multiline: `^` is a line's start). */
  readonly mustMatch?: readonly string[];
  /** Text that must appear in this order. */
  readonly inOrder?: readonly string[];
}

export interface SkillCase {
  readonly id: string;
  readonly prompt: string;
  readonly skill: { readonly skillId: string; readonly name: string; readonly description: string; readonly body: string };
  readonly checks: SkillCaseChecks;
  /** An answer that follows the skill (it must pass) and a typical one without it (it must fail): the checks' own test. */
  readonly examples: { readonly pass: string; readonly fail: string };
}

export interface SkillCasesFile {
  readonly version: 1;
  readonly cases: readonly SkillCase[];
}

export function parseCasesFile(value: unknown): SkillCasesFile {
  const file = value as { version?: unknown; cases?: unknown };
  if (file.version !== 1 || !Array.isArray(file.cases)) throw new Error("cases.json: expected { version: 1, cases: [...] }");
  const ids = new Set<string>();
  for (const entry of file.cases as SkillCase[]) {
    if (typeof entry.id !== "string" || typeof entry.prompt !== "string" || typeof entry.skill?.body !== "string")
      throw new Error(`cases.json: a case needs id, prompt and skill (${JSON.stringify(entry).slice(0, 80)})`);
    // Checked here, so a bad case is refused before any run is paid for, not when its skill is installed.
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(entry.skill.skillId ?? "") || !entry.skill.name || !entry.skill.description)
      throw new Error(`cases.json: case ${entry.id}'s skill needs a skillId (lower case, digits, hyphens), a name and a description`);
    if (typeof entry.examples?.pass !== "string" || typeof entry.examples?.fail !== "string")
      throw new Error(`cases.json: case ${entry.id} needs examples.pass and examples.fail`);
    if (ids.has(entry.id)) throw new Error(`cases.json: duplicate case ${entry.id}`);
    const checks = entry.checks ?? {};
    if ([checks.mustInclude, checks.mustNotInclude, checks.mustMatch, checks.inOrder].every((list) => (list?.length ?? 0) === 0))
      throw new Error(`cases.json: case ${entry.id} has no checks`);
    for (const pattern of checks.mustMatch ?? []) new RegExp(pattern, "m");
    ids.add(entry.id);
  }
  return file as SkillCasesFile;
}

/** Why `answer` fails `checks`, or `undefined` when it passes them all. Markdown emphasis (`**TL;DR:**`) is read as its text. */
export function judgeAnswer(checks: SkillCaseChecks, given: string): string | undefined {
  const answer = given.replace(/\*\*|__/g, "");
  for (const text of checks.mustInclude ?? []) if (!answer.includes(text)) return `lacks "${text}"`;
  const lower = answer.toLowerCase();
  for (const text of checks.mustNotInclude ?? []) if (lower.includes(text.toLowerCase())) return `holds "${text}"`;
  for (const pattern of checks.mustMatch ?? []) if (!new RegExp(pattern, "m").test(answer)) return `does not match /${pattern}/`;
  let at = -1;
  for (const text of checks.inOrder ?? []) {
    const found = answer.indexOf(text, at + 1);
    if (found < 0) return `"${text}" is out of order`;
    at = found;
  }
  return undefined;
}

export interface RunSummary {
  readonly status: "completed" | "failed" | "unknown";
  readonly finalText: string;
  /** The tools the run called, in order. */
  readonly tools: readonly string[];
  readonly tokens?: number;
  readonly timedOut?: true;
}

export function summarizeStream(ndjson: string): RunSummary {
  let status: RunSummary["status"] = "unknown";
  let finalText = "";
  let streamed = "";
  const tools: string[] = [];
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
    if (kind === "tool.started" && typeof event["toolName"] === "string") tools.push(event["toolName"]);
    else if (kind === "text.delta" && typeof event["text"] === "string") streamed += event["text"];
    else if (kind === "task.completed" || kind === "task.failed") {
      status = kind === "task.completed" ? "completed" : "failed";
      if (typeof event["finalText"] === "string") finalText = event["finalText"];
      const metrics = event["metrics"] as { readonly totalTokens?: unknown } | undefined;
      if (typeof metrics?.totalTokens === "number") tokens = (tokens ?? 0) + metrics.totalTokens;
    }
  }
  return { status, finalText: finalText === "" ? streamed : finalText, tools, ...(tokens === undefined ? {} : { tokens }) };
}

export type Arm = "without" | "with";

export interface ArmRun {
  readonly id: string;
  readonly arm: Arm;
  readonly passed: boolean;
  readonly reason?: string;
  /** Whether the run loaded the skill with `skills.read`. */
  readonly loaded: boolean;
  readonly tokens?: number;
}

export function scoreRun(entry: SkillCase, arm: Arm, run: RunSummary): ArmRun {
  const loaded = run.tools.includes("skills.read");
  const tokens = run.tokens === undefined ? {} : { tokens: run.tokens };
  if (run.timedOut === true) return { id: entry.id, arm, passed: false, reason: "timed out", loaded, ...tokens };
  if (run.status !== "completed") return { id: entry.id, arm, passed: false, reason: `run ${run.status}`, loaded, ...tokens };
  const reason = judgeAnswer(entry.checks, run.finalText);
  return { id: entry.id, arm, passed: reason === undefined, ...(reason === undefined ? {} : { reason }), loaded, ...tokens };
}

export interface ArmSummary {
  readonly runs: number;
  readonly passRate: number;
  /** Share of cases every run of which passed (pass^k). */
  readonly passAll: number;
  readonly loadRate: number;
  readonly tokensPerRun?: number;
}

export interface SkillEvalSummary {
  readonly cases: number;
  readonly without: ArmSummary;
  readonly with: ArmSummary;
  /** `with.passRate - without.passRate`: what the skills added; below zero, they hurt. */
  readonly lift: number;
  /**
   * Cases the skill made worse: runs without it passed more often than with it, by more than one run in three
   * (one noisy run of three is not a regression).
   */
  readonly regressed: readonly string[];
}

const share = (count: number, of: number): number => (of === 0 ? 0 : Math.round((count / of) * 1000) / 1000);

function armSummary(runs: readonly ArmRun[]): ArmSummary {
  const byCase = new Map<string, ArmRun[]>();
  for (const run of runs) byCase.set(run.id, [...(byCase.get(run.id) ?? []), run]);
  const counted = runs.filter((run) => run.tokens !== undefined);
  return {
    runs: runs.length,
    passRate: share(runs.filter((run) => run.passed).length, runs.length),
    passAll: share([...byCase.values()].filter((list) => list.every((run) => run.passed)).length, byCase.size),
    loadRate: share(runs.filter((run) => run.loaded).length, runs.length),
    ...(counted.length === 0
      ? {}
      : { tokensPerRun: Math.round(counted.reduce((total, run) => total + (run.tokens ?? 0), 0) / counted.length) }),
  };
}

export function summarize(runs: readonly ArmRun[]): SkillEvalSummary {
  const without = runs.filter((run) => run.arm === "without");
  const withSkill = runs.filter((run) => run.arm === "with");
  const ids = [...new Set(runs.map((run) => run.id))];
  const passes = (list: readonly ArmRun[], id: string) => list.filter((run) => run.id === id && run.passed).length;
  const a = armSummary(without);
  const b = armSummary(withSkill);
  return {
    cases: ids.length,
    without: a,
    with: b,
    lift: Math.round((b.passRate - a.passRate) * 1000) / 1000,
    regressed: ids.filter((id) => {
      const runsOf = without.filter((run) => run.id === id).length;
      return passes(without, id) - passes(withSkill, id) > Math.floor(runsOf / 3);
    }),
  };
}

export function formatSummary(summary: SkillEvalSummary, runs: readonly ArmRun[]): string {
  const arm = (name: string, value: ArmSummary) =>
    `${name}: pass rate ${value.passRate}, pass^k ${value.passAll}, loaded the skill ${value.loadRate}${value.tokensPerRun === undefined ? "" : `, ${value.tokensPerRun} tokens a run`}`;
  const lines = [
    `cases ${summary.cases}`,
    arm("without the skill", summary.without),
    arm("with the skill", summary.with),
    `lift ${summary.lift}${summary.regressed.length === 0 ? "" : `; worse with the skill: ${summary.regressed.join(", ")}`}`,
  ];
  for (const run of runs.filter((entry) => !entry.passed)) lines.push(`  ✗ ${run.id} (${run.arm}): ${run.reason ?? "failed"}`);
  return lines.join("\n");
}

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

/** The runner's options; a run without `--template` or `--data-dir` is refused, so it never writes into the default data directory. */
export function parseArgs(argv: readonly string[]): RunnerOptions {
  let casesPath = join(repositoryRoot, "evals", "skills", "cases.json");
  const only: string[] = [];
  let connectionId: string | undefined;
  let model: string | undefined;
  let template: string | undefined;
  let dataDir: string | undefined;
  let label: string | undefined;
  let outDir = join(repositoryRoot, "evals", "skills", "results");
  let timeoutSeconds = 180;
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
  const data = runnerData(template, dataDir, "evals/skills/README.md");
  // A shared data directory would carry one arm's skill into the other: each run needs its own copy.
  if ("dataDir" in data) throw new Error("the skill eval needs --template: each run imports its skill into a private copy");
  return {
    casesPath,
    only,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(model === undefined ? {} : { model }),
    data,
    ...(label === undefined ? {} : { label }),
    outDir,
    timeoutMs: timeoutSeconds * 1000,
    repeat,
  };
}

/** The `tavi` children still running, stopped by an interrupt. */
const running = new Set<ChildProcess>();

/** One `tavi skills …` in `dataDir`, refused unless it succeeds. */
function taviSkills(args: readonly string[], dataDir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(repositoryRoot, "scripts", "tavi.mjs"), "skills", ...args, "--data-dir", dataDir], {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    running.add(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      running.delete(child);
      if (code === 0) resolvePromise();
      else reject(new Error(`tavi skills ${args[0] ?? ""} exited ${String(code)}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

/** Imports, approves and activates a case's skill in `dataDir`: the "with" arm's starting point. */
async function installSkill(entry: SkillCase, dataDir: string): Promise<void> {
  const packagePath = join(dataDir, `${entry.skill.skillId}.skill.md`);
  writeFileSync(packagePath, entry.skill.body);
  const { skillId } = entry.skill;
  await taviSkills(
    [
      "import",
      skillId,
      "--version",
      "1.0.0",
      "--package",
      packagePath,
      "--name",
      entry.skill.name,
      "--description",
      entry.skill.description,
      "--provenance",
      "skill eval",
    ],
    dataDir,
  );
  await taviSkills(["approve", skillId, "--version", "1.0.0"], dataDir);
  await taviSkills(["activate", skillId, "--version", "1.0.0"], dataDir);
  rmSync(packagePath, { force: true });
}

async function taviRun(prompt: string, dataDir: string, options: RunnerOptions): Promise<RunSummary> {
  const { stdout, timedOut } = await taviRunJson({
    repositoryRoot,
    prompt,
    dataDir,
    ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    timeoutMs: options.timeoutMs,
    running,
  });
  const summary = summarizeStream(stdout);
  return timedOut ? { ...summary, timedOut: true } : summary;
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const file = parseCasesFile(JSON.parse(readFileSync(options.casesPath, "utf8")));
  const cases = options.only.length === 0 ? file.cases : file.cases.filter((entry) => options.only.includes(entry.id));
  if (cases.length === 0) throw new Error("no case matches --case");
  const startedAt = new Date();
  const runs: ArmRun[] = [];
  const { data } = options;
  if (!("template" in data)) throw new Error("the skill eval needs --template");
  await withTemplateCopies(
    data.template,
    { prefix: "skills-", commands: running, log: (message) => process.stderr.write(`[skill eval] ${message}\n`) },
    async (copy) => {
      let count = 0;
      for (let round = 0; round < options.repeat; round += 1)
        for (const entry of cases)
          for (const arm of ["without", "with"] as const) {
            count += 1;
            const dataDir = copy(`r${count}`);
            try {
              // A skill that cannot be installed fails this run, not the whole eval: the runs already paid for are kept.
              const install =
                arm === "with"
                  ? await installSkill(entry, dataDir).then(
                      () => undefined,
                      (error: unknown) => error,
                    )
                  : undefined;
              if (install !== undefined)
                runs.push({
                  id: entry.id,
                  arm,
                  passed: false,
                  reason: `skill install failed: ${String(install)}`.slice(0, 300),
                  loaded: false,
                });
              else runs.push(scoreRun(entry, arm, await taviRun(entry.prompt, dataDir, options)));
            } finally {
              rmSync(dataDir, { recursive: true, force: true });
            }
          }
    },
  );
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
  process.stdout.write(`${formatSummary(summary, runs)}\n\nreport: ${path}\n`);
  return summary.regressed.length === 0 ? 0 : 1;
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
