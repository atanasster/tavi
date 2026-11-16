// The sandbox's footprint: wrap time and
// spawn-to-exit for `true`, `python3 -c 1` and `git status` in a 10,000-file repository, p50/p95
// over RUNS runs, the first (cold) apart; the owner's RSS before and after srt's initialize();
// and the policy compile, with the largest compiled profile. Prints a Markdown table.
// Run through scripts/sandbox-footprint.sh, which builds the package first.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const root = new URL("../packages/builtin/sandbox/dist/", import.meta.url);
const { createRuntimeSandbox } = await import(new URL("runtime.mjs", root).href);
const { createSandboxHost } = await import(new URL("host.mjs", root).href);
const { compile } = await import(new URL("policy-compile.mjs", root).href);

const RUNS = Number(process.env.RUNS ?? 50);
const base = mkdtempSync(join(tmpdir(), "tavi-footprint-"));
const work = join(base, "work");
const repo = join(work, "repo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q", repo]);
for (let index = 0; index < 10_000; index += 1) {
  const directory = join(repo, `d${String(Math.floor(index / 100))}`);
  if (index % 100 === 0) mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `f${String(index)}.txt`), String(index));
}
execFileSync("git", ["-C", repo, "add", "-A"]);
execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"]);

const policy = {
  filesystem: {
    allowRead: [work],
    allowWrite: [work],
    denyRead: [tmpdir()],
    protectedNames: [{ root: work, names: [".git", ".git/hooks", ".git/config", ".bashrc", ".envrc", ".vscode"], rootNames: ["HEAD"] }],
  },
  network: { allow: false },
  resources: { timeoutMs: 60_000, maxOutputBytes: 65_536 },
};
const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))];

const rssBefore = rss();
const sandbox = createRuntimeSandbox({ host: createSandboxHost({ dataDirectory: join(base, "data") }) });
const rows = [];
for (const [label, command, args] of [
  ["true", "/bin/sh", ["-c", "true"]],
  ["python3 -c 1", "/bin/sh", ["-c", "python3 -c 1"]],
  ["git status (10,000 files)", "/bin/sh", ["-c", "git -C repo status --short >/dev/null"]],
]) {
  const times = [];
  for (let run = 0; run <= RUNS; run += 1) {
    const started = performance.now();
    const result = await sandbox.run(policy, {
      command,
      args,
      cwd: work,
      env: { PATH: process.env.PATH ?? "", HOME: join(work, ".home") },
      inheritEnv: false,
    });
    if (result.exitCode !== 0) throw new Error(`${label} failed: ${result.stderr}`);
    times.push(performance.now() - started);
  }
  const [cold, ...warm] = times;
  rows.push(`| ${label} | ${cold.toFixed(0)} | ${quantile(warm, 0.5).toFixed(0)} | ${quantile(warm, 0.95).toFixed(0)} |`);
}
const rssAfter = rss();
let compileLine = "";
{
  const started = performance.now();
  const { config } = compile(policy, {}, process.platform === "linux" ? "linux" : "darwin");
  const entries = ["denyRead", "allowRead", "allowWrite", "denyWrite"].reduce(
    (total, key) => total + (config.filesystem[key]?.length ?? 0),
    0,
  );
  compileLine = `\nCompile and walk: ${(performance.now() - started).toFixed(1)} ms, ${String(entries)} filesystem entries (bubblewrap's budget: about 3000 mounts).`;
}
await sandbox.close?.();
rmSync(base, { recursive: true, force: true });
console.log(`Sandbox footprint on ${process.platform} ${process.arch}, Node ${process.versions.node}, ${String(RUNS)} warm runs each (ms, spawn to exit including the wrap):

| Command | Cold | Warm p50 | Warm p95 |
|---|---|---|---|
${rows.join("\n")}

Owner RSS: ${String(rssBefore)} MiB before, ${String(rssAfter)} MiB after srt's initialize() and the runs (+${String(rssAfter - rssBefore)} MiB).${compileLine}`);
process.exit(0);
