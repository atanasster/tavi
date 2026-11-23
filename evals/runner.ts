import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunnerData } from "./template.js";

/**
 * The scaffold a live eval's runner shares: its command-line flags, the cases
 * a `--case` picks, each run's data directory, the report it writes and the
 * entry point that runs it. Shared by `evals/fs/eval.ts`,
 * `evals/heartbeat/eval.ts`, `evals/ideas/eval.ts`, `evals/skills/eval.ts`,
 * `evals/tool-choice/eval.ts` and `evals/reply-language/eval.ts`; each reads
 * and scores its own runs.
 *
 * Erasable TypeScript only, so `node` runs it with no build.
 */

// The template a run copies (`node` runs the .ts; the types come from it too).
const template = (await import(new URL("./template.ts", import.meta.url).href)) as typeof import("./template.js");

/** The repository the evals are in: their default paths and the `tavi` they run are under it. */
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `--template` or `--data-dir`, exactly one (`runnerData` in `evals/template.ts`). */
export const runnerData = template.runnerData;

/** The `tavi` children an eval still has running, stopped by an interrupt. */
export const running = new Set<ChildProcess>();

export interface RunnerFlagDefaults {
  /** The flag naming the file the cases are read from (`--cases`, `--worlds`), and its default path. */
  readonly fileFlag: string;
  readonly file: string;
  /** The flag choosing some of them by id, comma-separated or repeated (`--case`, `--world`). */
  readonly onlyFlag: string;
  readonly outDir: string;
  readonly timeoutSeconds: number;
  /** Runs of each case; absent, the runner takes no `--repeat`. */
  readonly repeat?: number;
  /** The most `--repeat` may ask for; absent, any positive whole number. */
  readonly maxRepeat?: number;
  /** An eval's own flag: true when it took `flag`, reading its value, if it has one, with `value`. */
  readonly extra?: (flag: string, value: () => string) => boolean;
}

/** A live runner's flags as given, its data directory not yet chosen (`runnerData` in `evals/template.ts` does that). */
export interface RunnerFlags {
  readonly file: string;
  readonly only: readonly string[];
  readonly connectionId?: string;
  readonly model?: string;
  readonly template?: string;
  readonly dataDir?: string;
  readonly label?: string;
  readonly outDir: string;
  readonly timeoutMs: number;
  readonly repeat: number;
}

/** The flags every live runner takes; an unknown one, or one missing its value, is refused. */
export function parseRunnerFlags(argv: readonly string[], defaults: RunnerFlagDefaults): RunnerFlags {
  let file = defaults.file;
  const only: string[] = [];
  let connectionId: string | undefined;
  let model: string | undefined;
  let template: string | undefined;
  let dataDir: string | undefined;
  let label: string | undefined;
  let outDir = defaults.outDir;
  let timeoutSeconds = defaults.timeoutSeconds;
  let repeat = defaults.repeat ?? 1;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === defaults.fileFlag) file = resolve(value());
    else if (flag === defaults.onlyFlag) only.push(...value().split(","));
    else if (flag === "--connection") connectionId = value();
    else if (flag === "--model") model = value();
    else if (flag === "--template") template = value();
    else if (flag === "--data-dir") dataDir = value();
    else if (flag === "--label") label = value();
    else if (flag === "--out") outDir = resolve(value());
    else if (flag === "--timeout-s") timeoutSeconds = Number(value());
    else if (flag === "--repeat" && defaults.repeat !== undefined) repeat = Number(value());
    else if (defaults.extra?.(flag, value) !== true) throw new Error(`unknown option ${String(argv[index])}`);
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout-s must be a positive whole number");
  if (defaults.maxRepeat === undefined) {
    if (!Number.isInteger(repeat) || repeat <= 0) throw new Error("--repeat must be a positive whole number");
  } else if (!Number.isInteger(repeat) || repeat < 1 || repeat > defaults.maxRepeat)
    throw new Error(`--repeat must be a whole number from 1 to ${defaults.maxRepeat}`);
  return {
    file,
    only,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(model === undefined ? {} : { model }),
    ...(template === undefined ? {} : { template }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(label === undefined ? {} : { label }),
    outDir,
    timeoutMs: timeoutSeconds * 1000,
    repeat,
  };
}

/** What every live runner's options hold beside its own: the cases' file is named by each. */
export interface LiveRunnerOptions {
  readonly only: readonly string[];
  readonly connectionId?: string;
  readonly model?: string;
  readonly data: RunnerData;
  readonly label?: string;
  readonly outDir: string;
  readonly timeoutMs: number;
  readonly repeat: number;
}

/** `flags` as a runner's options, its runs kept in `data`. */
export function liveRunnerOptions(flags: RunnerFlags, data: RunnerData): LiveRunnerOptions {
  return {
    only: flags.only,
    ...(flags.connectionId === undefined ? {} : { connectionId: flags.connectionId }),
    ...(flags.model === undefined ? {} : { model: flags.model }),
    data,
    ...(flags.label === undefined ? {} : { label: flags.label }),
    outDir: flags.outDir,
    timeoutMs: flags.timeoutMs,
    repeat: flags.repeat,
  };
}

/** The entries `only` names (all of them when it names none); an id the file does not have is refused. */
export function chosenById<T extends { readonly id: string }>(all: readonly T[], only: readonly string[], noun: string): readonly T[] {
  const unknown = only.filter((id) => !all.some((entry) => entry.id === id));
  if (unknown.length > 0) throw new Error(`no such ${noun}: ${unknown.join(", ")}`);
  return only.length === 0 ? all : all.filter((entry) => only.includes(entry.id));
}

/**
 * Runs `body` with the data directory each run writes into: with `--data-dir`
 * that one directory for every run; with `--template` a fresh private copy per
 * name, which `done` removes once its run is over (and an interrupt stops
 * `running` and removes them all).
 */
export async function withRunData(
  data: RunnerData,
  input: { readonly prefix: string; readonly log: (message: string) => void },
  body: (dataDirFor: (name: string) => string, done: (dataDir: string) => void) => Promise<void>,
): Promise<void> {
  if ("dataDir" in data) {
    await body(
      () => data.dataDir,
      () => undefined,
    );
    return;
  }
  await template.withTemplateCopies(data.template, { ...input, commands: running }, (copy) =>
    body(copy, (dataDir) => rmSync(dataDir, { recursive: true, force: true })),
  );
}

/**
 * One `tavi run --format json --approval deny` of `prompt` in `dataDir`
 * (`taviRunJson` in `evals/template.ts`), on the runner's connection and
 * model, its stream read by `read`; `timedOut` when it was stopped at the
 * runner's timeout.
 */
export async function liveRun<T>(
  prompt: string,
  dataDir: string,
  options: { readonly connectionId?: string; readonly model?: string; readonly timeoutMs: number },
  read: (stdout: string) => T,
): Promise<T | (T & { readonly timedOut: true })> {
  const { stdout, timedOut } = await template.taviRunJson({
    repositoryRoot,
    prompt,
    dataDir,
    ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    timeoutMs: options.timeoutMs,
    running,
  });
  const summary = read(stdout);
  return timedOut ? { ...summary, timedOut: true as const } : summary;
}

/** What one `tavi run --format json` stream says: its answer, status, tool calls and tokens. */
export interface RunSummary {
  readonly status: "completed" | "failed" | "unknown";
  readonly finalText: string;
  readonly toolCalls: number;
  readonly tokens?: number;
  readonly cacheReadTokens?: number;
  readonly timedOut?: true;
}

/** A `tavi run --format json` stream read for what every live eval scores: its answer, status, tool calls and tokens. */
export function summarizeStream(ndjson: string): RunSummary {
  let status: RunSummary["status"] = "unknown";
  let finalText = "";
  let streamed = "";
  let toolCalls = 0;
  let tokens: number | undefined;
  let cacheReadTokens: number | undefined;
  for (const line of ndjson.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const metrics = (typeof event["metrics"] === "object" && event["metrics"] !== null ? event["metrics"] : {}) as {
      readonly totalTokens?: unknown;
      readonly cacheReadTokens?: unknown;
    };
    switch (event["kind"]) {
      case "text.delta":
        if (typeof event["text"] === "string") streamed += event["text"];
        break;
      case "tool.started":
        toolCalls += 1;
        break;
      case "task.completed":
      case "task.failed":
        status = event["kind"] === "task.completed" ? "completed" : "failed";
        if (typeof metrics.totalTokens === "number") tokens = (tokens ?? 0) + metrics.totalTokens;
        if (typeof metrics.cacheReadTokens === "number") cacheReadTokens = (cacheReadTokens ?? 0) + metrics.cacheReadTokens;
        if (typeof event["finalText"] === "string") finalText = event["finalText"];
        break;
      default:
        break;
    }
  }
  return {
    status,
    finalText: finalText === "" ? streamed : finalText,
    toolCalls,
    ...(tokens === undefined ? {} : { tokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
  };
}

/** A report's opening fields, in the order every runner writes them. */
export function reportHead(
  options: { readonly label?: string; readonly connectionId?: string; readonly model?: string },
  startedAt: Date,
): { readonly label?: string; readonly startedAt: string; readonly connection?: string; readonly model?: string } {
  return {
    ...(options.label === undefined ? {} : { label: options.label }),
    startedAt: startedAt.toISOString(),
    ...(options.connectionId === undefined ? {} : { connection: options.connectionId }),
    ...(options.model === undefined ? {} : { model: options.model }),
  };
}

/** Writes `report` into `outDir`, named by when the eval started; the path it wrote. */
export function writeReport(outDir: string, startedAt: Date, report: unknown): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${startedAt.toISOString().replaceAll(":", "-").replace(".", "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

/** Runs `main` with the command line when `moduleUrl` is the script `node` was started with; exits with its code, or 2 on an error. */
export function runWhenMain(moduleUrl: string, main: (argv: readonly string[]) => Promise<number>): void {
  if (process.argv[1] === undefined || resolve(process.argv[1]) !== fileURLToPath(moduleUrl)) return;
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
