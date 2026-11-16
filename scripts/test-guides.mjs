#!/usr/bin/env node
// Walks the how-to guides (tests/guides/), on purpose: each walk drives its own
// throwaway owner, canvas and (for most) the real model, so they are left out of
// `pnpm test`. Build first (`pnpm run build`).
//
//   pnpm test:guides                                   every guide
//   pnpm test:guides get-started/first-chat            one guide
//   pnpm test:guides everyday/travel --update-shots    a folder, retaking its pictures
//
// --update-shots  retake each step's picture (a canvas one is kept when only its masked boxes moved)
// --strict        fail a walk on any finding its screens show (a clipped label, a console error…)
// --key-file <p>  the plain-text OpenRouter key (default: the `openrouter` credential of your data directory)
// --provided <a,b> what you have set up for the walks that need you (a Telegram bot, a Google sign-in…)
//
// Search keys come from .env.tutorials at the repository root (gitignored): TAVILY_API_KEY, BRAVE_API_KEY,
// SERPER_API_KEY. A walk's data directory stores each as the credential search.<kind>, and adds Tavily with its key.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultKeyFile } from "./docs/session.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
// Found here, before the test run points every data directory at a scratch one.
const env = { ...process.env, TAVI_GUIDE_TESTS: "1", TAVI_GUIDE_KEY_FILE: defaultKeyFile() };
// The search keys, in the gitignored .env.tutorials (TAVILY_API_KEY, BRAVE_API_KEY, SERPER_API_KEY): read by the
// session from the file, so no key is ever in this environment. Without it, Tavily runs keyless.
if (existsSync(join(root, ".env.tutorials"))) env["TAVI_GUIDE_SEARCH_KEYS"] = join(root, ".env.tutorials");
const paths = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--update-shots") env["TAVI_GUIDE_UPDATE_SHOTS"] = "1";
  else if (arg === "--strict") env["TAVI_GUIDE_STRICT"] = "1";
  else if (arg === "--key-file") env["TAVI_GUIDE_KEY_FILE"] = args[++index];
  else if (arg === "--provided") env["TAVI_GUIDE_PROVIDED"] = args[++index];
  else {
    const base = join("tests/guides", arg.replace(/\.md$/, ""));
    const file = `${base}.guide.test.ts`;
    if (existsSync(join(root, file))) paths.push(file);
    else if (existsSync(join(root, base))) paths.push(base);
    else {
      console.error(`no guide walk at ${file}, and no folder ${base}`);
      process.exit(2);
    }
  }
}
if (!existsSync(join(root, "apps/cli/dist/executable.mjs"))) {
  console.error("apps/cli/dist is missing: run pnpm run build first");
  process.exit(2);
}
const project = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const run = spawnSync(process.execPath, [vitest, "run", "--project", project, ...(paths.length === 0 ? ["tests/guides"] : paths)], {
  cwd: root,
  env,
  stdio: "inherit",
});
process.exit(run.status ?? 1);
