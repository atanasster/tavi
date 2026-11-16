// Ship the web canvas with the CLI: `apps/ui`'s build, copied
// into `ui-dist/` beside `dist/` — not into `dist/`, which tsdown's `clean`
// empties on every build. Turbo builds `@tavi/ui` first (`turbo.json`); a
// canvas that is not there fails the build rather than shipping a CLI whose
// `tavi ui` serves only its placeholder.
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(cli, "..", "ui", "dist");
const target = join(cli, "ui-dist");

if (!existsSync(join(built, "index.html"))) {
  console.error(`copy-canvas: ${built} has no index.html; build @tavi/ui first (pnpm run build builds both)`);
  process.exit(1);
}
// A build run alone (`pnpm --filter @tavi/cli build`, not through turbo) may
// find a canvas older than its sources: said, not refused — the copy is still
// the last canvas built.
const newest = (directory) =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((latest, entry) => Math.max(latest, statSync(join(entry.parentPath, entry.name)).mtimeMs), 0);
const sources = join(cli, "..", "ui", "src");
if (existsSync(sources) && newest(sources) > statSync(join(built, "index.html")).mtimeMs) {
  console.warn(`copy-canvas: ${built} is older than apps/ui/src; \`pnpm run build\` rebuilds it`);
}
rmSync(target, { recursive: true, force: true });
cpSync(built, target, { recursive: true });
console.log(`copy-canvas: ${readdirSync(target, { recursive: true }).length} entries from ${built} into ${target}`);
