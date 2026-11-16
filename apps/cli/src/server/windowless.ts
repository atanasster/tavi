import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { placeInJob } from "@tavi/child-kit";
import { detachConsole } from "@tavi/node-kit";

import { EXIT } from "../cli/exit.js";

/**
 * `tavi serve --windowless`, which a Windows logon task starts (`tavi service
 * unit --kind task`): Windows gives a console program run at logon a console
 * window of its own. This process lets go of that console, so the window
 * closes, and runs the owner again with no window, as a service
 * (`TAVI_SERVICE=1`), in a job that ends with it. Task Scheduler restarts only
 * a task that fails to start, not one whose program exits with an error, so
 * the restart is done here: an owner that exits with an error is started
 * again after a pause, and a clean stop ends this process too. So does a
 * refusal (`WINDOWLESS_FINAL`), which starting it again would only repeat.
 */

/** This command line without `--windowless`: what the hidden owner is started with. */
export function windowlessArgv(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== "--windowless");
}

/** The pause before an owner that exited with an error is started again (systemd's `RestartSec=5`). */
export const WINDOWLESS_RESTART_MS = 5_000;

/**
 * The exits that are a designed refusal, not a crash: the command line is wrong
 * (`usage`), serving is not available here (`unavailable`, as on Windows
 * until the pipe is proven), or another owner holds the data directory
 * (`alreadyOwned`). The owner is not started again after one of them.
 */
export const WINDOWLESS_FINAL: ReadonlySet<number> = new Set([EXIT.usage, EXIT.unavailable, EXIT.alreadyOwned]);

/** What `runWindowless` needs of the owner it started: its exit, or why it never started. */
export interface WindowlessChild {
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: () => void): unknown;
}

export interface WindowlessDeps {
  /** The entry point and its arguments, as `process.argv.slice(1)`; `--windowless` is taken out. */
  readonly argv: readonly string[];
  readonly start?: (args: readonly string[]) => WindowlessChild;
  readonly detach?: () => void;
  readonly pause?: (ms: number) => Promise<unknown>;
  /** Whether to start it again after an exit with `code`; by default, unless it was a clean stop or a refusal (`WINDOWLESS_FINAL`). */
  readonly again?: (code: number) => boolean;
}

export async function runWindowless(deps: WindowlessDeps): Promise<number> {
  const start: (args: readonly string[]) => WindowlessChild =
    deps.start ??
    ((args: readonly string[]) => {
      const child = spawn(process.execPath, [...process.execArgv, ...args], {
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, TAVI_SERVICE: "1" },
      });
      placeInJob(child);
      return child;
    });
  // Nothing is written after this: the owner logs to its own log file (`tavi logs`).
  (deps.detach ?? detachConsole)();
  const args = windowlessArgv(deps.argv);
  for (;;) {
    const child = start(args);
    const code = await new Promise<number>((resolve) => {
      child.once("error", () => resolve(EXIT.internal));
      child.once("exit", (exited) => resolve(exited ?? EXIT.internal));
    });
    if (code === EXIT.ok || !(deps.again ?? ((exited) => !WINDOWLESS_FINAL.has(exited)))(code)) return code;
    await (deps.pause ?? sleep)(WINDOWLESS_RESTART_MS);
  }
}
