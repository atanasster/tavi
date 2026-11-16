// Runs pnpm with variables set, the same on every platform (a `VAR=1 cmd`
// package script needs a POSIX shell, which Windows does not have):
//
//   node scripts/with-env.mjs NAME=value ... -- pnpm <args>
//
// pnpm is the one that started this script (`npm_execpath`), never run
// through a shell.
import { spawnSync } from "node:child_process";

import { pnpmCommand } from "./pnpm-command.mjs";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const assignments = split < 0 ? [] : argv.slice(0, split);
const [command, ...args] = split < 0 ? [] : argv.slice(split + 1);
const env = { ...process.env };
for (const assignment of assignments) {
  const at = assignment.indexOf("=");
  if (at <= 0) {
    process.stderr.write(`with-env: ${assignment} is not NAME=value\n`);
    process.exit(2);
  }
  env[assignment.slice(0, at)] = assignment.slice(at + 1);
}
const pnpm = pnpmCommand(process.env.npm_execpath);
if (command !== "pnpm" || pnpm === undefined) {
  process.stderr.write("usage: with-env.mjs NAME=value ... -- pnpm <args>, run from a pnpm script\n");
  process.exit(2);
}
const ran = spawnSync(pnpm[0], [...pnpm[1], ...args], { env, stdio: "inherit" });
if (ran.error !== undefined) {
  process.stderr.write(`with-env: ${ran.error.message}\n`);
  process.exit(1);
}
process.exit(ran.status ?? 1);
