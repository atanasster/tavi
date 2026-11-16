import { execFile } from "node:child_process";

import { endJob, jobPeakKb } from "./job.js";

/**
 * Bounding a confined engine child: the PDF engine's parser and OCR children
 * and the video decoder's and
 * analysers' runs, which share this
 * one kill ladder rather than each keeping a copy. The per-run cgroup is
 * the resource limits' (Linux); the RSS watchdog here is the cap on macOS and a
 * backstop on Linux. The kill ladder is the sandbox's: `SIGTERM`, a grace, then
 * `SIGKILL`, escalated to `cgroup.kill` where there is a cgroup. On Windows,
 * which has no signals or process groups, the child is asked in band (its
 * standard input is closed), given the same grace, then its Job Object is
 * ended (`placeInJob`), which ends everything it started.
 */

/** How often the watchdog samples the child's resident set. */
export const RSS_POLL_MS = 200;
/** How long a child has between `SIGTERM` and `SIGKILL`. */
export const KILL_GRACE_MS = 500;

/**
 * The resident set of `pid` and every process under it, in KiB, or undefined
 * once `pid` is gone: the child runs under srt's wrapper, so the tree is
 * what is capped. `ps` answers on both macOS and Linux; on Windows the
 * child's Job Object keeps its peak, which is read instead.
 */
export async function residentKb(pid: number, platform: NodeJS.Platform = process.platform): Promise<number | undefined> {
  if (platform === "win32") return jobPeakKb(pid);
  const table = await new Promise<string | undefined>((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,rss="],
      { env: { ...process.env, LC_ALL: "C" }, timeout: 2_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error === null ? stdout : undefined),
    );
  });
  if (table === undefined) return undefined;
  return treeRss(table, pid);
}

/** Sum the `rss` column over `root` and its descendants in a `pid ppid rss` table. */
export function treeRss(table: string, root: number): number | undefined {
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of table.split("\n")) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || kb === undefined || !Number.isFinite(pid) || !Number.isFinite(kb)) continue;
    rss.set(pid, kb);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  if (!rss.has(root)) return undefined;
  let total = 0;
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

export interface Watchdog {
  /** The highest resident set it saw, in KiB. */
  readonly peakKb: () => number;
  stop(): void;
}

/**
 * Poll `pid` every `RSS_POLL_MS`; call `over` once when its resident set
 * passes `capKb`. A sample that comes back after `stop` is ignored.
 */
export function watchRss(
  pid: number,
  capKb: number,
  over: (kb: number) => void,
  poll: (pid: number) => Promise<number | undefined> = residentKb,
): Watchdog {
  let peak = 0;
  let stopped = false;
  let fired = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void poll(pid).then((kb) => {
      inFlight = false;
      if (stopped || kb === undefined) return;
      peak = Math.max(peak, kb);
      if (kb > capKb && !fired) {
        fired = true;
        over(kb);
      }
    });
  }, RSS_POLL_MS);
  timer.unref();
  return {
    peakKb: () => peak,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** A spawned process leading its own group (on Windows, its own Job Object): the group is what a signal reaches. */
export interface Killable {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  /** On Windows, closed to ask the child to stop. */
  readonly stdin?: { end(): unknown } | null;
  /** On Windows, the last resort for a child in no job. */
  kill?(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
}

/**
 * Signal `child`'s whole process group (it was spawned `detached`),
 * tolerating one already gone; when the group cannot be signalled (a child
 * not leading one), the child itself is. On Windows a `SIGKILL` ends the
 * child's Job Object (or, in none, the child itself), and any other signal is
 * the in-band request: its standard input is closed.
 */
export function signalGroup(child: Killable, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  if (child.pid === undefined) return;
  try {
    if (platform !== "win32") process.kill(-child.pid, signal);
    else if (signal !== "SIGKILL") child.stdin?.end();
    else if (!endJob(child.pid)) child.kill?.("SIGKILL");
  } catch {
    try {
      // No group to reach (or it has already exited): the child, which `kill` tolerates being gone.
      child.kill?.(signal);
    } catch {
      // The child has already exited.
    }
  }
}

/**
 * `SIGTERM` to the group, then `SIGKILL` after `KILL_GRACE_MS` unless the
 * child has exited by then. `killGroup`, where the child has a cgroup,
 * escalates the `SIGKILL` to `cgroup.kill`, which reaches what left the
 * process group (`setsid`) too.
 */
export function killLadder(child: Killable, graceMs = KILL_GRACE_MS, killGroup?: () => void): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const sigkill = (): void => {
    signalGroup(child, "SIGKILL");
    try {
      killGroup?.();
    } catch {
      // The cgroup is already gone.
    }
  };
  return new Promise((resolve) => {
    const timer = setTimeout(sigkill, graceMs);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      // Whatever it left behind in its group goes too.
      sigkill();
      resolve();
    });
    signalGroup(child, "SIGTERM");
  });
}
export { endJob, jobPeakKb, placeInJob, requireJob, type Jobbable } from "./job.js";
export { encodePng, type PngLayout } from "./png.js";
