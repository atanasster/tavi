// How to start pnpm without a shell, on every platform. pnpm 12 ships as a
// native binary (spawned as it is); older or corepack-cached copies are a
// JavaScript entry (run by this Node). A `.cmd` shim on PATH is never used:
// Node will not spawn one without a shell.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** `[command, leadingArgs]` for the pnpm at `entry`, or undefined when there is none. */
export function pnpmCommand(entry) {
  if (entry === undefined || entry === "" || !existsSync(entry)) return undefined;
  return /\.[cm]?js$/.test(entry) ? [process.execPath, [entry]] : [entry, []];
}

/**
 * The pnpm on `PATH`, as something to spawn: the command `pnpm` off Windows;
 * on Windows `pnpm.exe`, or the JavaScript entry beside a `pnpm.cmd` from a
 * global npm install (Node will not spawn the `.cmd` itself).
 */
export function pnpmOnPath(path = process.env.PATH ?? process.env.Path ?? "") {
  if (process.platform !== "win32") return ["pnpm", []];
  for (const directory of path.split(delimiter)) {
    if (directory === "") continue;
    const native = join(directory, "pnpm.exe");
    if (existsSync(native)) return [native, []];
    if (!existsSync(join(directory, "pnpm.cmd"))) continue;
    for (const entry of ["pnpm.cjs", "pnpm.mjs"]) {
      const command = pnpmCommand(join(directory, "node_modules", "pnpm", "bin", entry));
      if (command !== undefined) return command;
    }
  }
  return undefined;
}
