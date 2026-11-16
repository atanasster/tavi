#!/usr/bin/env node
/**
 * Startup benchmark for the built CLI: spawn-to-exit for `tavi --version`,
 * `tavi tasks` with no owner (it opens the database itself) and with an owner
 * attached (it asks the owner over IPC), and spawn-to-ready for `tavi serve`
 * (its `"serving": true` line on stdout, printed once the IPC endpoint is
 * bound and discovery is published). Each is run once to warm the file cache,
 * then RUNS times (default 5); the median is printed in a Markdown table.
 *
 * Everything runs against a fresh data directory under the system temp
 * directory (TAVI_DATA_DIR and XDG_DATA_HOME both point there, and every other
 * TAVI_* variable is dropped), which is deleted at the end; your own data
 * directory is never opened. The owner listens on a unix socket inside that
 * directory and binds no TCP port in a fresh directory, so no port is chosen.
 *
 *   node scripts/bench-startup.mjs [--runs <n>] [--build]
 *
 * The CLI is built (turbo, `@tavi/cli` and what it depends on) when
 * apps/cli/dist is missing, or always with `--build`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { turboCommand } from "./turbo.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const turbo = turboCommand(root);
const executable = join(root, "apps", "cli", "dist", "executable.mjs");

const USAGE = "usage: node scripts/bench-startup.mjs [--runs <n>] [--build]\n";
const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const RUNS = runsAt === -1 ? 5 : Number(args[runsAt + 1]);
const unknown = args.filter((arg, index) => arg !== "--build" && arg !== "--runs" && (runsAt === -1 || index !== runsAt + 1));
if (!Number.isInteger(RUNS) || RUNS < 1 || unknown.length > 0) {
  process.stderr.write(USAGE);
  process.exit(2);
}
/** How long one command may take before the benchmark gives up on it. */
const TIMEOUT_MS = 60_000;

if (args.includes("--build") || !existsSync(executable)) {
  process.stderr.write("bench-startup: building @tavi/cli…\n");
  const built = spawnSync(turbo[0], [...turbo[1], "run", "build", "--filter=@tavi/cli", "--output-logs=errors-only"], {
    cwd: root,
    stdio: "inherit",
  });
  if (built.status !== 0) {
    const reason = built.error === undefined ? `exit ${built.status ?? built.signal}` : built.error.message;
    process.stderr.write(`bench-startup: the build failed (${reason})\n`);
    process.exit(1);
  }
}

// macOS caps a unix socket path near 104 bytes, and the owner's socket lives in
// the data directory: os.tmpdir() keeps it short where a scratch path may not.
const base = mkdtempSync(join(tmpdir(), "tavi-bench-"));
const dataDirectory = join(base, "data");
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TAVI_")));
env.TAVI_DATA_DIR = dataDirectory;
env.XDG_DATA_HOME = join(base, "xdg");

/** Children still running, stopped on the way out whatever happens. */
const live = new Set();
function cleanup() {
  for (const child of live) child.kill("SIGKILL");
  rmSync(base, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(128 + constants.signals[signal]);
  });
}

function start(cliArgs) {
  const child = spawn(process.execPath, [executable, ...cliArgs], { cwd: base, env, stdio: ["ignore", "pipe", "pipe"] });
  live.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      live.delete(child);
      resolve({ code, signal });
    });
  });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

function timeout(label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} took longer than ${TIMEOUT_MS} ms`)), TIMEOUT_MS).unref());
}

/** Milliseconds from spawn to a zero exit. */
async function timeToExit(cliArgs) {
  const started = performance.now();
  const run = start(cliArgs);
  const { code } = await Promise.race([run.exited, timeout(`tavi ${cliArgs.join(" ")}`)]);
  const elapsed = performance.now() - started;
  if (code !== 0) throw new Error(`tavi ${cliArgs.join(" ")} exited ${code}: ${run.stderr().trim()}`);
  return elapsed;
}

/** Start `tavi serve` and resolve at its ready line, with the milliseconds it took and a stop function. */
async function startOwner() {
  const started = performance.now();
  const run = start(["serve", "--drain-deadline", "2000"]);
  const ready = new Promise((resolve, reject) => {
    const check = () => {
      if (/"serving":\s*true/.test(run.stdout())) resolve(performance.now() - started);
    };
    run.child.stdout.on("data", check);
    void run.exited.then(({ code, signal }) =>
      reject(new Error(`tavi serve exited before it was ready (${code ?? signal}): ${run.stderr().trim()}`)),
    );
  });
  const elapsed = await Promise.race([ready, timeout("tavi serve")]);
  const stop = async () => {
    run.child.kill("SIGTERM");
    await Promise.race([run.exited, timeout("tavi serve shutdown")]);
  };
  return { elapsed, stop };
}

/** One warm-up run, then RUNS measured ones. */
async function measure(once) {
  await once();
  const times = [];
  for (let run = 0; run < RUNS; run += 1) times.push(await once());
  return times;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const rows = [];
try {
  rows.push(["tavi --version", await measure(() => timeToExit(["--version"]))]);
  // The first `tasks` creates and migrates the database; the warm-up absorbs it.
  rows.push(["tavi tasks (no owner)", await measure(() => timeToExit(["tasks"]))]);
  rows.push([
    "tavi serve (to ready)",
    await measure(async () => {
      const owner = await startOwner();
      await owner.stop();
      return owner.elapsed;
    }),
  ]);
  const owner = await startOwner();
  try {
    // With an owner live, `tasks` either attaches or fails (it never opens the
    // database under a live owner), so a zero exit is an attached answer.
    rows.push(["tavi tasks (owner attached)", await measure(() => timeToExit(["tasks"]))]);
  } finally {
    await owner.stop();
  }
} finally {
  cleanup();
}

const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const format = (ms) => `${Math.round(ms)} ms`;
process.stdout.write(
  `Startup, median of ${RUNS} (${revision || "unknown commit"}, Node.js ${process.version}, ${process.platform}/${process.arch})\n\n`,
);
process.stdout.write("| Command | Median | Min | Max |\n| --- | ---: | ---: | ---: |\n");
for (const [label, times] of rows) {
  process.stdout.write(`| ${label} | ${format(median(times))} | ${format(Math.min(...times))} | ${format(Math.max(...times))} |\n`);
}
