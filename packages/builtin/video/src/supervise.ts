import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { killLadder, requireJob, watchRss, type Watchdog } from "@tavi/child-kit";
import { VIDEO_LIMITS } from "@tavi/contracts";

/**
 * One video child, started and watched: the decoder's runs and the command analyser's share it. The child
 * gets its own process group; it is ended by the kill ladder on its wall
 * clock, the RSS watchdog, the caller's signal, or its writes passing the
 * run's cap, measured while it runs and once more after it ends.
 */

/** How often a run's writes are measured while it runs. */
export const WRITE_POLL_MS = 200;

/** Regular files' bytes under `path`, links not followed: a planted link to a large file is not the run's. */
export function sizeOf(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += sizeOf(full);
    else if (entry.isFile()) total += lstatSync(full).size;
  }
  return total;
}

/** A launch as the sandbox gave it back. */
export interface SupervisedLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly onExit?: () => "oom" | undefined;
  readonly kill?: () => void;
}

/** Why the owner ended it. */
export type Ended = "timeout" | "memory" | "protocol" | "stopped";

export interface SuperviseOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  /** What the child has written so far, in bytes; past `VIDEO_LIMITS.runDirMaxBytes` it is ended (`protocol`). */
  readonly written: () => number;
  readonly signal?: AbortSignal;
  /** Its stdout, when read; `kill` ends it (`protocol`) for output past a cap. Ignored when absent. */
  readonly stdout?: (chunk: Buffer, kill: () => void) => void;
  readonly stderr?: (chunk: Buffer) => void;
  readonly residentKb?: (pid: number) => Promise<number | undefined>;
  /** The resident memory past which it is ended (`memory`); `VIDEO_LIMITS.childRssMb` by default. */
  readonly rssMb?: number;
  /** Told when it starts and ends: the owner's set of running children, `observe`. */
  readonly started?: (child: ChildProcess, kill: () => Promise<void>) => void;
  readonly ended?: (child: ChildProcess) => void;
}

export interface Supervised {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** It never started (not found, not executable). */
  readonly error?: Error;
  /** Why the owner ended it, when it did; its cgroup ending it out of memory is `memory`. */
  readonly why?: Ended;
  readonly peakKb: number;
}

export async function supervise(launch: SupervisedLaunch, options: SuperviseOptions): Promise<Supervised> {
  let why: Ended | undefined;
  const child = spawn(launch.command, [...launch.args], {
    env: { ...launch.env },
    cwd: options.cwd,
    stdio: ["ignore", options.stdout === undefined ? "ignore" : "pipe", "pipe"],
    // Its own group to end whole; on Windows, its own Job Object.
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  requireJob(child);
  const kill = (reason: Ended): void => {
    why ??= reason;
    void killLadder(child, undefined, launch.kill);
  };
  options.started?.(child, async () => killLadder(child, undefined, launch.kill));
  if (options.stdout !== undefined) {
    const read = options.stdout;
    child.stdout?.on("data", (chunk: Buffer) => read(chunk, () => kill("protocol")));
  }
  child.stderr?.on("data", (chunk: Buffer) => options.stderr?.(chunk));
  const watchdog: Watchdog | undefined =
    child.pid === undefined
      ? undefined
      : watchRss(child.pid, (options.rssMb ?? VIDEO_LIMITS.childRssMb) * 1024, () => kill("memory"), options.residentKb);
  const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
  timer.unref();
  const onAbort = (): void => kill("stopped");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) onAbort();
  // Writes are held to the cap while it runs, not only after: a hostile clip could fill the disk before its clock ends.
  const meter = setInterval(() => {
    try {
      if (options.written() > VIDEO_LIMITS.runDirMaxBytes) kill("protocol");
    } catch {
      // A file gone between listing and stat: measured again next time.
    }
  }, WRITE_POLL_MS);
  meter.unref();
  const outcome = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: Error }>(
    (resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      // `close`, not `exit`: the last bytes may still be in the pipes at `exit`.
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  clearTimeout(timer);
  clearInterval(meter);
  options.signal?.removeEventListener("abort", onAbort);
  watchdog?.stop();
  options.ended?.(child);
  if (launch.onExit?.() === "oom") why = "memory";
  // Measured once more after it ends: what it wrote in its last moments counts.
  if (why === undefined) {
    try {
      if (options.written() > VIDEO_LIMITS.runDirMaxBytes) why = "protocol";
    } catch {
      // Unmeasurable after the end: nothing more to hold it to.
    }
  }
  return { ...outcome, ...(why === undefined ? {} : { why }), peakKb: watchdog?.peakKb() ?? 0 };
}
