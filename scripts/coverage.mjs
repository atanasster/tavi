// Line, statement, branch and function coverage per workspace, report-only:
//
//   pnpm test:coverage [<turbo args>...]     e.g. pnpm test:coverage --filter=@tavi/contracts
//
// Runs every workspace's tests through turbo with `--coverage` (each workspace's project writes its
// own `coverage/`, configured in vitest.config.ts), then sums each one's `coverage-summary.json` into
// a table: printed, written to `coverage/summary.md` at the root, and appended to the GitHub job
// summary when `GITHUB_STEP_SUMMARY` is set. A failing test still reports what ran; the exit status
// is the tests'. No floor is enforced yet. TAVI_COVERAGE=1 is set for the run, so a wall-time check can skip. A child process a test starts (plugin workers, confined
// helpers) is not measured, so those packages read low.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { pnpmCommand } from "./pnpm-command.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
/** The `pnpm-workspace.yaml` package folders, as vitest.config.ts reads them. */
const PARENTS = ["apps", "packages", "packages/builtin", "packages/external"];
const METRICS = ["lines", "statements", "branches", "functions"];

/** Every workspace with a `test` script: its name and folder. */
function workspaces() {
  const found = [];
  for (const parent of PARENTS) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, parent, entry.name);
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name && parsed.scripts?.test) found.push({ name: parsed.name, dir });
    }
  }
  return found;
}

const pnpm = pnpmCommand(process.env.npm_execpath);
if (pnpm === undefined) {
  process.stderr.write("coverage: run it as `pnpm test:coverage`\n");
  process.exit(2);
}

const all = workspaces();
// A workspace a filtered run skips must not report last run's numbers.
for (const { dir } of all) rmSync(join(dir, "coverage"), { recursive: true, force: true });

const ran = spawnSync(pnpm[0], [...pnpm[1], "exec", "turbo", "run", "test", "--continue", ...process.argv.slice(2), "--", "--coverage"], {
  cwd: root,
  stdio: "inherit",
  // Tests with a wall-time budget skip under it: instrumentation slows them several-fold.
  env: { ...process.env, TAVI_COVERAGE: "1" },
});
if (ran.error !== undefined) {
  process.stderr.write(`coverage: ${ran.error.message}\n`);
  process.exit(1);
}

const percent = (covered, total) => (total === 0 ? "—" : `${((100 * covered) / total).toFixed(1)}%`);
const rows = [];
const sum = Object.fromEntries(METRICS.map((metric) => [metric, { covered: 0, total: 0 }]));
for (const { name, dir } of all) {
  const file = join(dir, "coverage", "coverage-summary.json");
  if (!existsSync(file)) continue;
  const total = JSON.parse(readFileSync(file, "utf8")).total;
  for (const metric of METRICS) {
    sum[metric].covered += total[metric].covered;
    sum[metric].total += total[metric].total;
  }
  rows.push(
    `| ${name} | ${METRICS.map((metric) => percent(total[metric].covered, total[metric].total)).join(" | ")} | ${String(total.lines.total)} | ${relative(root, join(dir, "coverage", "index.html"))} |`,
  );
}

const table = [
  "## Coverage",
  "",
  "Report-only: no floor is enforced. Child processes a test starts are not measured.",
  "",
  "| Package | Lines | Statements | Branches | Functions | Lines measured | Report |",
  `|---|${METRICS.map(() => "---:").join("|")}|---:|---|`,
  ...rows.sort(),
  `| **All** | ${METRICS.map((metric) => `**${percent(sum[metric].covered, sum[metric].total)}**`).join(" | ")} | ${String(sum.lines.total)} | |`,
  "",
].join("\n");

mkdirSync(join(root, "coverage"), { recursive: true });
writeFileSync(join(root, "coverage", "summary.md"), table);
process.stdout.write(`\n${table}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
if (rows.length === 0) process.stderr.write("coverage: no workspace wrote a summary\n");
process.exit(ran.status ?? 1);
