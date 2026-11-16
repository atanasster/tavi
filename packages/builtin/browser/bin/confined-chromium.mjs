#!/usr/bin/env node
// @ts-check
// Playwright's `executablePath` for a confined Chromium.
//
// Playwright starts this with Chromium's flags and talks CDP on fds 3 (to the
// browser) and 4 (from it). A sandbox passes only fds 0-2 on, so this starts
// the confinement command the owner wrote (`TAVI_CONFINED_LAUNCH`) and carries
// fd 3 to its stdin and its stdout to fd 4; inside, `chromium-shim.mjs` does
// the reverse for Chromium. A temporary profile Playwright made outside the
// sandbox's writable folder is moved into it; a workspace's own profile (the
// descriptor's `profile`) is kept.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";

/**
 * What the owner wrote for this launch.
 * @type {{ command: string, args: string[], env: NodeJS.ProcessEnv, scratch: string, profile?: string }}
 */
const launch = JSON.parse(readFileSync(process.env["TAVI_CONFINED_LAUNCH"] ?? "", "utf8"));
/** @param {string} directory */
const kept = (directory) => directory === launch.profile || directory.startsWith(`${launch.scratch}/`);
const flags = process.argv
  .slice(2)
  .map((flag) =>
    flag.startsWith("--user-data-dir=") && !kept(flag.slice("--user-data-dir=".length))
      ? `--user-data-dir=${mkdtempSync(join(launch.scratch, "profile-"))}`
      : flag,
  );
const child = spawn(launch.command, [...launch.args, ...flags], { env: launch.env, stdio: ["pipe", "pipe", "inherit"] });
// Sockets, not fs streams: an fs read of a pipe holds a thread, and this process could not exit while it waited.
const toBrowser = new Socket({ fd: 3, readable: true, writable: false });
const fromBrowser = new Socket({ fd: 4, readable: false, writable: true });
toBrowser
  .on("error", () => child.stdin.end())
  .pipe(child.stdin)
  .on("error", () => undefined);
child.stdout.pipe(fromBrowser).on("error", () => undefined);
/** @type {readonly NodeJS.Signals[]} */
const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"];
for (const signal of FORWARDED) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  process.stderr.write(`confined Chromium could not start: ${error.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
