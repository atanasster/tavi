// Packs a prebuilt Tavi for people who are not building it: every package a
// `tavi` install needs (the set `tests/release.test.ts` packs and installs),
// with the installer and a checksum list, into `release/<version>/`. The
// release workflow attaches that folder to a GitHub Release; `install.sh`
// reads it back.
//
//   node scripts/pack-release.mjs            # build, then pack
//   node scripts/pack-release.mjs --no-build # pack what is already built
//
// Prints the folder it wrote.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { headlessPackageDirectories } from "../tests/support/dependency-rules.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Run `pnpm` through the workspace's wrapper; any failure ends the script with its status. */
function pnpm(args) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "pnpmw.mjs"), ...args], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * `SHA256SUMS` in `directory`: one line per tarball and the installer, as
 * `sha256sum -c` and `shasum -a 256 -c` read them. The tarballs are what
 * install.sh installs, each checked against its line first.
 */
export function writeChecksums(directory) {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".tgz") || name === "install.sh")
    .sort();
  const sums = files.map(
    (name) =>
      `${createHash("sha256")
        .update(readFileSync(join(directory, name)))
        .digest("hex")}  ${name}`,
  );
  writeFileSync(join(directory, "SHA256SUMS"), `${sums.join("\n")}\n`);
}

/**
 * The `## <heading>` section of the changelog, without its heading line, or
 * `undefined`. A heading may go on after the version: `## 0.2.0 — 2026-11-20`.
 */
export function changelogSection(changelog, heading) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === `## ${heading}` || trimmed.startsWith(`## ${heading} `);
  });
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

function main() {
  const version = JSON.parse(readFileSync(join(root, "apps", "cli", "package.json"), "utf8")).version;
  const out = join(root, "release", version);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  if (!process.argv.includes("--no-build")) pnpm(["run", "build"]);
  for (const directory of headlessPackageDirectories(root)) pnpm(["--filter", `./${directory}`, "pack", "--pack-destination", out]);

  copyFileSync(join(root, "scripts", "install.sh"), join(out, "install.sh"));
  writeChecksums(out);

  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const notes = changelogSection(changelog, version) ?? changelogSection(changelog, "Unreleased") ?? "";
  const install = [
    "## Install",
    "",
    "macOS, Linux or WSL2, with Node.js 22.22.2 or later:",
    "",
    "```bash",
    "curl -fsSL https://github.com/atanasster/tavi/releases/latest/download/install.sh | sh",
    "```",
    "",
    "Then `tavi setup`. The installer verifies every file against `SHA256SUMS`.",
  ].join("\n");
  writeFileSync(join(out, "RELEASE_NOTES.md"), `${install}\n\n${notes}\n`);

  process.stdout.write(`${out}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
