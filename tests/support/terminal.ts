import { readFileSync } from "node:fs";
import { join } from "node:path";

import { errorMessage } from "@tavi/contracts/util";
import { temporaryDirectory } from "@tavi/test-support";

import { run } from "./process.js";

/**
 * A command run under a pseudo-terminal of a fixed size, as `script(1)`
 * provides one, for the gates that must see what a terminal UI writes to a
 * real terminal (`tests/release.test.ts`): a test runner's stdout
 * is not a TTY, and a TUI refuses to run without one.
 *
 * The terminal's size is set inside it, by `stty`, before the command starts,
 * so the command reads it as a real terminal reports it. The input is
 * `/dev/null`: `script` passes its end on as an end-of-file character, which a
 * TUI that reads no input ignores.
 */

export interface TerminalRun {
  /** Everything the command wrote to the terminal, escape sequences included. */
  readonly transcript: string;
}

const quote = (argument: string): string => `'${argument.replace(/'/g, `'\\''`)}'`;

/** How long a command may hold the terminal: a hang fails the gate rather than stalling it. */
const TERMINAL_TIMEOUT_MS = 120_000;

/**
 * Whether this environment can allocate a pseudo-terminal at all.
 *
 * A sandboxed environment can deny `openpty(3)` outright — `script(1)` then exits
 * with `openpty: Operation not permitted` before running anything. That is a
 * property of the environment, not of the command under test, so the default
 * suite skips the terminal cases there (naming the reason) rather than reporting
 * an environment limitation as a failure. Probed once and remembered; the probe
 * itself allocates a terminal, so it is deliberately cheap and quiet.
 *
 * The release gate (`tests/release.test.ts`) does **not** consult this: a release
 * must not be certified by an environment that could not run its checks, so there
 * the same denial fails loudly.
 */
let available: boolean | undefined;
export function pseudoTerminalAvailable(): boolean {
  if (available !== undefined) return available;
  const transcript = join(temporaryDirectory("tavi-terminal-probe-"), "transcript");
  const linux = process.platform === "linux";
  const args = linux ? ["-q", "-e", "-c", "sh -c true", transcript] : ["-q", transcript, "sh", "-c", "true"];
  try {
    run("script", args, {
      encoding: "utf8",
      env: linux ? { ...process.env, SHELL: "/bin/sh" } : process.env,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

export function underTerminal(
  command: readonly string[],
  options: { readonly rows: number; readonly columns: number; readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): TerminalRun {
  const transcript = join(temporaryDirectory("tavi-terminal-"), "transcript");
  const shell = `stty rows ${options.rows} cols ${options.columns} && exec ${command.map(quote).join(" ")}`;
  // util-linux `script` (Linux) takes the command as one string, run by
  // `$SHELL`, and returns its exit status with `-e`; BSD `script` (macOS, the
  // BSDs) takes it as arguments and returns its status as it is.
  const linux = process.platform === "linux";
  const args = linux ? ["-q", "-e", "-c", `sh -c ${quote(shell)}`, transcript] : ["-q", transcript, "sh", "-c", shell];
  try {
    run("script", args, {
      encoding: "utf8",
      cwd: options.cwd,
      env: linux ? { ...options.env, SHELL: "/bin/sh" } : options.env,
      // Input from `/dev/null`, not a pipe: BSD `script` refuses a socket, which
      // is what a Node child's piped stdin is. Its copy of the output is not
      // kept either: the transcript is the file, and a long session's copy
      // would overrun the capture buffer.
      stdio: ["ignore", "ignore", "pipe"],
      timeout: TERMINAL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    const message = errorMessage(error);
    // Name the environment rather than leaving a bare `script failed`: an
    // `openpty` denial is not a defect in the command under test, and a reader
    // should not have to know that to interpret the failure.
    if (/openpty|Operation not permitted/.test(message)) {
      throw new Error(
        `this environment cannot allocate a pseudo-terminal (script(1) reported an openpty denial), so a terminal ` +
          `session cannot be observed here: ${message}`,
        { cause: error },
      );
    }
    throw error;
  }
  return { transcript: readFileSync(transcript, "utf8") };
}
