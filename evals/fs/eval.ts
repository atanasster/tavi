import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { LiveRunnerOptions } from "../runner.js";
import type { RunnerData } from "../template.js";

// The runner's scaffold is shared with the other live evals (`node` runs the .ts; the types come from it too).
const { chosenById, liveRunnerOptions, parseRunnerFlags, runWhenMain, writeReport } = (await import(
  new URL("../runner.ts", import.meta.url).href
)) as typeof import("../runner.js");

/**
 * The live file-and-sandbox action eval (plan G3): small tasks a model does
 * with `fs.edit`, `fs.grep`, a line-window `fs.read` and `sandbox.run`, each in
 * a folder the runner seeds with fixtures, scored with no judge: the files the
 * run left, the calls it made (by tool and the input fields it set), and the
 * facts its answer must state.
 *
 * Each case runs as `tavi run --folder <its folder> --approval approve` on a
 * `tavi serve --eval` owner whose `--fs-root` is the runner's scratch folder,
 * so the chat works in a folder seeded before its first turn.
 *
 * Erasable TypeScript only, so `node evals/fs/eval.ts` runs it with no build
 * and `tests/fs-eval.test.ts` imports its pure parts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "..", "..");
const taviScript = join(repositoryRoot, "scripts", "tavi.mjs");
/** The eval runs the CLI as built: `serve` would otherwise rebuild a stale checkout mid-run. */
const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, TAVI_NO_REBUILD: "1" });

// ------------------------------------------------------------------ cases

/** A count of a tool's calls, optionally only those whose input sets `has` and carries `where`'s words. */
export interface CallCheck {
  readonly tool: string;
  readonly min?: number;
  readonly max?: number;
  /** Input fields the counted calls set (present and not empty). */
  readonly has?: readonly string[];
  /** Words a counted call's input field carries, case-insensitively; the field `*` is the whole input. */
  readonly where?: Readonly<Record<string, string>>;
}

/** A file the run must leave: equal to a fixture, or holding and lacking some text. */
export interface FileCheck {
  readonly path: string;
  readonly equals?: string;
  readonly contains?: readonly string[];
  readonly lacks?: readonly string[];
}

export interface FsCase {
  readonly id: string;
  readonly prompt: string;
  /** The folder's files before the run: path in the folder → fixture (a file in `fixtures/`, or `generated:<name>`). */
  readonly files: Readonly<Record<string, string>>;
  readonly expect: {
    readonly files?: readonly FileCheck[];
    readonly calls?: readonly CallCheck[];
    /** Facts the answer states: each entry is one fact, any of its spellings (numbers compared without thousands separators). */
    readonly answer?: readonly (readonly string[])[];
  };
}

export interface FsCasesFile {
  readonly version: 1;
  readonly cases: readonly FsCase[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_PATH = /^(?!\/)(?!.*\.\.)[\w./-]+$/;

/** The case file, checked: unique ids, a prompt, fixtures that exist, at least one expectation, sane counts. */
export function parseCasesFile(value: unknown, fixtureDir: string = join(here, "fixtures")): FsCasesFile {
  const fail = (message: string): never => {
    throw new Error(`invalid fs eval case file: ${message}`);
  };
  const file = value as { readonly version?: unknown; readonly cases?: unknown };
  if (file?.version !== 1 || !Array.isArray(file.cases) || file.cases.length === 0) fail("expected { version: 1, cases: [...] }");
  const ids = new Set<string>();
  for (const entry of file.cases as FsCase[]) {
    if (typeof entry.id !== "string" || !ID.test(entry.id)) fail(`a case id must be a lower-case slug (${JSON.stringify(entry.id)})`);
    if (ids.has(entry.id)) fail(`duplicate case ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.prompt !== "string" || entry.prompt.trim() === "") fail(`${entry.id}: prompt is required`);
    if (typeof entry.files !== "object" || entry.files === null) fail(`${entry.id}: files is required`);
    for (const [path, fixture] of Object.entries(entry.files)) {
      if (!SAFE_PATH.test(path)) fail(`${entry.id}: ${path} is not a relative path inside the folder`);
      if (fixture.startsWith("generated:")) {
        if (!Object.hasOwn(GENERATED, fixture.slice("generated:".length))) fail(`${entry.id}: no generated fixture ${fixture}`);
      } else if (!SAFE_PATH.test(fixture) || !existsSync(join(fixtureDir, fixture))) fail(`${entry.id}: no fixture ${fixture}`);
    }
    const expect = entry.expect ?? {};
    if ((expect.files?.length ?? 0) + (expect.calls?.length ?? 0) + (expect.answer?.length ?? 0) === 0)
      fail(`${entry.id}: expects nothing`);
    for (const check of expect.files ?? []) {
      if (!SAFE_PATH.test(check.path)) fail(`${entry.id}: ${check.path} is not a relative path inside the folder`);
      if (check.equals !== undefined && !existsSync(join(fixtureDir, check.equals))) fail(`${entry.id}: no fixture ${check.equals}`);
    }
    for (const check of expect.calls ?? []) {
      if (typeof check.tool !== "string" || check.tool === "") fail(`${entry.id}: a call check names its tool`);
      if (check.min === undefined && check.max === undefined) fail(`${entry.id}: ${check.tool} check needs min or max`);
      if ((check.min ?? 0) > (check.max ?? Number.POSITIVE_INFINITY)) fail(`${entry.id}: ${check.tool} min is above max`);
    }
    for (const fact of expect.answer ?? [])
      if (!Array.isArray(fact) || fact.length === 0) fail(`${entry.id}: an answer fact lists at least one spelling`);
  }
  return file as FsCasesFile;
}

// ------------------------------------------------------------------ fixtures

/** A small seeded generator (mulberry32), so a generated fixture is the same bytes on every host. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The one ERROR in `app.log`, the line after it, and where they are (1-based). */
export const APP_LOG_ERROR = {
  line: 9137,
  requestId: "r-7f3a9c",
  order: "55821",
  text: "ERROR req=r-7f3a9c payment gateway timeout after 30000ms (order 55821)",
  next: "INFO  req=r-7f3a9c retry scheduled in 120s for order 55821",
} as const;
const APP_LOG_LINES = 16_000;

/** A service log over 1 MiB: requests and a few warnings, and exactly one ERROR at `APP_LOG_ERROR.line`. */
export function appLog(): string {
  const random = seeded(4711);
  const paths = ["/api/items", "/api/basket", "/api/orders", "/api/search", "/health", "/api/users/me"];
  const start = Date.UTC(2026, 9, 1);
  const lines: string[] = [];
  for (let index = 1; index <= APP_LOG_LINES; index += 1) {
    const at = new Date(start + index * 750).toISOString();
    if (index === APP_LOG_ERROR.line) lines.push(`${at} ${APP_LOG_ERROR.text}`);
    else if (index === APP_LOG_ERROR.line + 1) lines.push(`${at} ${APP_LOG_ERROR.next}`);
    else {
      const request = `r${String(index).padStart(6, "0")}`;
      const path = paths[Math.floor(random() * paths.length)] ?? "/";
      const ms = 3 + Math.floor(random() * 240);
      lines.push(
        random() < 0.02
          ? `${at} WARN  req=${request} GET ${path} slow upstream ${ms * 10}ms`
          : `${at} INFO  req=${request} GET ${path} 200 ${ms}ms user=${1000 + Math.floor(random() * 9000)} agent=tavi-eval/1.0`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The fixtures built at run time: too large to commit, the same bytes every time. */
export const GENERATED: Readonly<Record<string, () => string>> = { "app-log": appLog };

/** A fixture's text: a file in `fixtures/`, or a `generated:` one built here. */
export function fixtureText(fixture: string, fixtureDir: string = join(here, "fixtures")): string {
  if (fixture.startsWith("generated:")) {
    const build = GENERATED[fixture.slice("generated:".length)];
    if (build === undefined) throw new Error(`no generated fixture ${fixture}`);
    return build();
  }
  return readFileSync(join(fixtureDir, fixture), "utf8");
}

/** Writes a case's files into `folder` (made if missing). */
export function seedFolder(entry: FsCase, folder: string, fixtureDir: string = join(here, "fixtures")): void {
  for (const [path, fixture] of Object.entries(entry.files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), fixtureText(fixture, fixtureDir));
  }
}

// ------------------------------------------------------------------ the stream and scoring

export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

export interface RunSummary {
  readonly status: "completed" | "failed" | "waiting" | "approval" | "unknown";
  readonly finalText: string;
  /** Calls run (`tool.started`), in order. */
  readonly calls: readonly ToolCall[];
  readonly failedCalls: number;
  readonly tokens?: number;
  readonly timedOut?: true;
}

/** A `tavi run --format json` stream, read for its calls (with their inputs), its answer and its tokens. */
export function summarizeStream(ndjson: string): RunSummary {
  let status: RunSummary["status"] = "unknown";
  let finalText = "";
  let streamed = "";
  let failedCalls = 0;
  let tokens: number | undefined;
  const calls: ToolCall[] = [];
  for (const line of ndjson.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (event["kind"]) {
      case "text.delta":
        if (typeof event["text"] === "string") streamed += event["text"];
        break;
      case "tool.started":
        if (typeof event["toolName"] === "string") calls.push({ name: event["toolName"], input: event["input"] });
        break;
      case "tool.failed":
        failedCalls += 1;
        break;
      case "task.waiting":
        status = "waiting";
        break;
      case "approval.required":
        status = "approval";
        break;
      case "task.completed":
      case "task.failed": {
        status = event["kind"] === "task.completed" ? "completed" : "failed";
        if (typeof event["finalText"] === "string") finalText = event["finalText"];
        const metrics = event["metrics"] as { readonly totalTokens?: unknown } | undefined;
        if (typeof metrics?.totalTokens === "number") tokens = (tokens ?? 0) + metrics.totalTokens;
        break;
      }
      default:
        break;
    }
  }
  return {
    status,
    finalText: finalText === "" ? streamed : finalText,
    calls,
    failedCalls,
    ...(tokens === undefined ? {} : { tokens }),
  };
}

/** Whether a call's input sets every `has` field and carries every `where` word. */
function callMatches(call: ToolCall, check: CallCheck): boolean {
  if (call.name !== check.tool) return false;
  const input = (typeof call.input === "object" && call.input !== null ? call.input : {}) as Record<string, unknown>;
  for (const field of check.has ?? []) {
    const value = input[field];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) return false;
  }
  for (const [field, words] of Object.entries(check.where ?? {}))
    if (
      !JSON.stringify(field === "*" ? input : (input[field] ?? ""))
        .toLowerCase()
        .includes(words.toLowerCase())
    )
      return false;
  return true;
}

/** Text with digit-grouping commas and spaces taken out of numbers: "7,342.42" and "7 342.42" read as "7342.42". */
const ungrouped = (text: string): string => text.replace(/(\d)[,   ](?=\d{3}\b)/g, "$1");

export interface CheckResult {
  readonly id: string;
  readonly pass: boolean;
  readonly reason: string;
}

export interface CaseResult {
  readonly id: string;
  readonly repeat?: number;
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
  readonly tools: Readonly<Record<string, number>>;
  readonly failedCalls: number;
  readonly tokens?: number;
}

/**
 * A run scored against its case: each file check against what the folder
 * holds now (`readFile` returns undefined for a file that is gone), each call
 * check against the calls made, each answer fact against the final text. A run
 * that did not complete fails every check, saying so.
 */
export function scoreCase(
  entry: FsCase,
  run: RunSummary,
  readFile: (path: string) => string | undefined,
  fixture: (name: string) => string = (name) => fixtureText(name),
): CaseResult {
  const checks: CheckResult[] = [];
  const ended = run.timedOut === true ? "timed out" : run.status === "completed" ? undefined : `run ${run.status}`;
  for (const check of entry.expect.files ?? []) {
    const id = `file:${check.path}`;
    const text = readFile(check.path);
    if (text === undefined) {
      checks.push({ id, pass: false, reason: `${check.path} is missing` });
      continue;
    }
    if (check.equals !== undefined && text !== fixture(check.equals)) {
      checks.push({ id, pass: false, reason: `${check.path} differs from ${check.equals}` });
      continue;
    }
    const missing = (check.contains ?? []).find((words) => !text.includes(words));
    const present = (check.lacks ?? []).find((words) => text.includes(words));
    checks.push(
      missing !== undefined
        ? { id, pass: false, reason: `${check.path} lacks ${JSON.stringify(missing)}` }
        : present !== undefined
          ? { id, pass: false, reason: `${check.path} still holds ${JSON.stringify(present)}` }
          : { id, pass: true, reason: "as expected" },
    );
  }
  for (const check of entry.expect.calls ?? []) {
    const count = run.calls.filter((call) => callMatches(call, check)).length;
    const id = `calls:${check.tool}${check.has === undefined ? "" : `+${check.has.join("+")}`}`;
    const low = check.min !== undefined && count < check.min;
    const high = check.max !== undefined && count > check.max;
    checks.push({
      id,
      pass: !low && !high,
      reason: `${count} matching call${count === 1 ? "" : "s"}${low ? `, at least ${check.min} expected` : ""}${high ? `, at most ${check.max} expected` : ""}`,
    });
  }
  const answer = ungrouped(run.finalText).toLowerCase();
  for (const fact of entry.expect.answer ?? []) {
    const pass = fact.some((spelling) => answer.includes(ungrouped(spelling).toLowerCase()));
    checks.push({ id: `answer:${fact[0]}`, pass, reason: pass ? "stated" : `the answer does not state ${JSON.stringify(fact[0])}` });
  }
  const scored = ended === undefined ? checks : checks.map((check) => ({ ...check, pass: false, reason: ended }));
  const tools: Record<string, number> = {};
  for (const call of run.calls) tools[call.name] = (tools[call.name] ?? 0) + 1;
  return {
    id: entry.id,
    passed: scored.length > 0 && scored.every((check) => check.pass),
    checks: scored,
    tools,
    failedCalls: run.failedCalls,
    ...(run.tokens === undefined ? {} : { tokens: run.tokens }),
  };
}

export interface FsSummary {
  readonly cases: number;
  readonly runs: number;
  readonly passRate: number;
  /** Cases every run of which passed (pass^k). */
  readonly passAll: number;
  readonly failing: readonly string[];
  readonly tokensPerRun?: number;
}

export function summarize(results: readonly CaseResult[]): FsSummary {
  const ids = [...new Set(results.map((result) => result.id))];
  const failing = ids.filter((id) => results.some((result) => result.id === id && !result.passed));
  const share = (count: number, of: number) => (of === 0 ? 0 : Math.round((count / of) * 1000) / 1000);
  const counted = results.filter((result) => result.tokens !== undefined);
  return {
    cases: ids.length,
    runs: results.length,
    passRate: share(results.filter((result) => result.passed).length, results.length),
    passAll: share(ids.length - failing.length, ids.length),
    failing,
    ...(counted.length === 0
      ? {}
      : { tokensPerRun: Math.round(counted.reduce((total, result) => total + (result.tokens ?? 0), 0) / counted.length) }),
  };
}

export function formatSummary(summary: FsSummary, results: readonly CaseResult[]): string {
  const lines = [
    `cases ${summary.cases}, runs ${summary.runs}`,
    `pass rate ${summary.passRate}, pass^k ${summary.passAll}${summary.tokensPerRun === undefined ? "" : `, ${summary.tokensPerRun} tokens a run`}`,
  ];
  for (const result of results.filter((entry) => !entry.passed))
    for (const check of result.checks.filter((entry) => !entry.pass)) lines.push(`  ✗ ${result.id} ${check.id}: ${check.reason}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ the live runner

export interface RunnerOptions extends LiveRunnerOptions {
  readonly casesPath: string;
}

/** The runner's options; a run without `--template` or `--data-dir` is refused, so it never writes into the default data directory. */
export function parseArgs(argv: readonly string[], runnerData: (template?: string, dataDir?: string) => RunnerData): RunnerOptions {
  const flags = parseRunnerFlags(argv, {
    fileFlag: "--cases",
    file: join(here, "cases.json"),
    onlyFlag: "--case",
    outDir: join(here, "results"),
    timeoutSeconds: 300,
    repeat: 1,
    maxRepeat: 20,
  });
  return { casesPath: flags.file, ...liveRunnerOptions(flags, runnerData(flags.template, flags.dataDir)) };
}

const targetArgs = (options: RunnerOptions): string[] => [
  ...(options.connectionId === undefined ? [] : ["--connection", options.connectionId]),
  ...(options.model === undefined ? [] : ["--model", options.model]),
];

/** The `tavi` children still running, stopped by an interrupt. */
const running = new Set<ChildProcess>();

/** `tavi serve --eval --fs-root <root>` on `dataDir`, until `stop`. */
async function startOwner(dataDir: string, root: string, options: RunnerOptions): Promise<{ stop(): Promise<void> }> {
  const child = spawn(process.execPath, [taviScript, "serve", "--eval", "--fs-root", root, ...targetArgs(options), "--data-dir", dataDir], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(),
  });
  running.add(child);
  let output = "";
  const keep = (chunk: string): void => {
    output = `${output}${chunk}`.slice(-4_000);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", keep);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", keep);
  let exited = false;
  const closed = new Promise<void>((done) =>
    child.on("close", () => {
      exited = true;
      running.delete(child);
      done();
    }),
  );
  const discovery = join(dataDir, "runtime", "ipc.json");
  const deadline = Date.now() + 120_000;
  while (!existsSync(discovery) && !exited && Date.now() < deadline) await new Promise((done) => setTimeout(done, 200));
  if (!existsSync(discovery) || exited) {
    child.kill("SIGKILL");
    throw new Error(`tavi serve did not start on ${dataDir}: ${output.trim().slice(-1_000)}`);
  }
  // The discovery file is written as the socket listens; give the owner a moment to finish starting.
  await new Promise((done) => setTimeout(done, 500));
  return {
    async stop() {
      if (exited) return;
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      await closed;
      clearTimeout(killer);
    },
  };
}

/** One `tavi run` of `prompt` working in `folder` on the owner, every call approved, to its end. */
function taviRun(prompt: string, folder: string, dataDir: string, options: RunnerOptions): Promise<RunSummary> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        taviScript,
        "run",
        "--format",
        "json",
        "--quiet",
        "--folder",
        folder,
        "--approval",
        "approve",
        ...targetArgs(options),
        "--data-dir",
        dataDir,
        prompt,
      ],
      { cwd: folder, stdio: ["ignore", "pipe", "pipe"], env: childEnv() },
    );
    running.add(child);
    let stdout = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => process.stderr.write(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.on("error", reject);
    child.on("close", () => {
      running.delete(child);
      clearTimeout(timer);
      resolvePromise({ ...summarizeStream(stdout), ...(timedOut ? { timedOut: true as const } : {}) });
    });
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const { runnerData, withTemplateCopies, cleanupOnSignal } = (await import(
    new URL("../template.ts", import.meta.url).href
  )) as typeof import("../template.js");
  const options = parseArgs(argv, (template, dataDir) => runnerData(template, dataDir, "evals/fs/README.md"));
  const cases = chosenById(parseCasesFile(JSON.parse(readFileSync(options.casesPath, "utf8"))).cases, options.only, "case");
  const startedAt = new Date();
  const results: CaseResult[] = [];
  // The folders the chats work in: a private scratch folder, the owner's one --fs-root. Real path: the owner compares it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tfs-w-")));
  chmodSync(root, 0o700);
  const removeSignalCleanup = cleanupOnSignal({ scratch: [root], commands: running });
  const runCases = async (dataDir: string): Promise<void> => {
    const owner = await startOwner(dataDir, root, options);
    try {
      for (const entry of cases)
        for (let run = 1; run <= options.repeat; run += 1) {
          const name = options.repeat === 1 ? entry.id : `${entry.id} #${run}`;
          process.stderr.write(`[fs eval] ${name}…\n`);
          const folder = join(root, `${entry.id}-${run}`);
          seedFolder(entry, folder);
          const summary = await taviRun(entry.prompt, folder, dataDir, options);
          const result = scoreCase(entry, summary, (path) =>
            existsSync(join(folder, path)) ? readFileSync(join(folder, path), "utf8") : undefined,
          );
          results.push(options.repeat === 1 ? result : { ...result, repeat: run });
          process.stderr.write(`[fs eval] ${name}: ${result.passed ? "pass" : "fail"}\n`);
        }
    } finally {
      await owner.stop();
    }
  };
  try {
    const { data } = options;
    if ("dataDir" in data) await runCases(data.dataDir);
    else
      await withTemplateCopies(
        data.template,
        { prefix: "tfs-", commands: running, log: (message) => process.stderr.write(`[fs eval] ${message}\n`) },
        (copy) => runCases(copy("o")),
      );
  } finally {
    removeSignalCleanup();
    rmSync(root, { recursive: true, force: true });
  }
  const summary = summarize(results);
  const report = {
    version: 1,
    ...(options.label === undefined ? {} : { label: options.label }),
    startedAt: startedAt.toISOString(),
    platform: process.platform,
    ...(options.connectionId === undefined ? {} : { connection: options.connectionId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    summary,
    results,
  };
  const path = writeReport(options.outDir, startedAt, report);
  process.stdout.write(`${formatSummary(summary, results)}\n\nreport: ${path}\n`);
  return summary.failing.length === 0 ? 0 : 1;
}

runWhenMain(import.meta.url, main);
