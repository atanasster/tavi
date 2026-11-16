#!/usr/bin/env node
/**
 * Executable entry point.
 *
 * The CLI logic lives in `main.ts`, which is also the importable library surface.
 * This module exists only so the built binary always runs: guessing "was I
 * invoked directly" from `process.argv[1]` is fragile across bundle filenames.
 *
 * The shebang is what makes the published `bin` entry work: the installer links
 * `node_modules/.bin/tavi` at this file and makes it executable, so without it the
 * shim fails with ENOEXEC instead of running the CLI.
 */
import { MIN_NODE_VERSION } from "../shared/node-version.js";

// A reader that stops early (`tavi --help | head`) closes the pipe: output with no reader left is
// not a failure, so the CLI exits quietly instead of crashing on the stream's EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

// A Node.js older than the floor's major cannot load the CLI's bundle at all: say so before importing it,
// instead of failing on a syntax or API error. Within the supported major, `main` refuses the commands
// that need the exact floor and still runs `doctor`, which reports it.
const major = Number.parseInt(process.versions.node, 10);
if (major < Number.parseInt(MIN_NODE_VERSION, 10)) {
  process.stderr.write(
    `tavi needs Node.js ${MIN_NODE_VERSION} or later; this is Node.js ${process.versions.node}. Upgrade Node.js and run it again.\n`,
  );
  // EXIT.unavailable, without importing the CLI to read it.
  process.exit(4);
}

const { main } = await import("../main.js");
process.exitCode = await main(process.argv.slice(2));
