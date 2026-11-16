import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { LIMITS_ENTRY_FAILED, LIMITS_ENTRY_FAILED_EXIT } from "@tavi/contracts";
import { requireJob, signalGroup as signalChild } from "@tavi/child-kit";
import { launchCommand, writeJsonAtomic } from "@tavi/node-kit";
import { z } from "zod";

/**
 * Tavi's own stdio transport for MCP servers. The SDK's
 * `StdioClientTransport` cannot spawn detached, merges its own default
 * environment and kills only its direct child, so this one:
 *
 * - spawns with `detached: true`, no shell and exactly the environment it is
 *   given, so the launched process (the `srt` CLI under a sandbox) leads a
 *   new process group that is never the owner's;
 * - always drains stderr: lines past the log's cap are discarded, but the
 *   stream is never paused, so a server never blocks on a full pipe;
 * - caps each message (`maxMessageBytes`, newline included) as it is read,
 *   holding no more than that, and drops an oversized message without closing;
 * - closes by ending stdin, then SIGTERM, then SIGKILL to the **group**, then a
 *   sweep of the descendants it saw (a `setsid()` escapes the group);
 * - records the group, the leader's start time and the descendants it can see
 *   in a pid file, for the next owner to reap after a crash.
 *
 * It exposes `pid` and `stderr`, which is how the SDK recognises a
 * stdio-shaped transport: a probe timeout then means a legacy server, and the
 * `server/discover` probe runs in place on this pipe, inside the same sandbox.
 */

/** A message's default cap: 1 MiB (`maxMessageBytes`). */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
/** stderr kept per minute; the rest is read and dropped. */
const STDERR_BYTES_PER_MINUTE = 64 * 1024;
/** How long `close()` waits after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** How long `close()` waits for a server to exit on its own once stdin is closed. */
const STDIN_GRACE_MS = 1_000;

export interface TaviStdioOptions {
  /** The program, never a shell line: `process.execPath`, a path, or the `srt` CLI. */
  readonly command: string;
  readonly args: readonly string[];
  /** The whole environment, built by the caller from scratch; nothing of the owner's is added. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly maxMessageBytes?: number;
  /** Where the group, leader start time and descendants are recorded while it runs. */
  readonly pidFile?: string;
  /** Each kept stderr chunk, as text; chunks past `stderrBytesPerMinute` are dropped. */
  readonly onStderr?: (text: string) => void;
  readonly stderrBytesPerMinute?: number;
  readonly stdinGraceMs?: number;
  readonly killGraceMs?: number;
  readonly clock?: () => number;
  /**
   * Each start's argv in a cgroup of its own: called once
   * per process this transport starts, whose `onExit` runs when that process
   * has exited or failed to spawn, releasing the group (and killing any
   * escapee); it says why the group ended the process, when it did (an OOM
   * kill), and that is added to the exit's report.
   */
  readonly place?: (argv: readonly string[]) => { readonly argv: readonly string[]; readonly onExit?: () => string | undefined };
}

/** A pid a record may name: never 0 or 1, which `kill` reads as the caller's group or init. */
const RecordedPidSchema = z.number().int().min(2);

/**
 * What the pid file holds, for the next owner to reap orphans after a crash.
 * Read back through this schema: the file may be half-written, or not ours,
 * and the pids in it drive `kill`.
 */
export const McpRunRecordSchema = z.object({
  pgid: RecordedPidSchema,
  leaderStart: z.string(),
  descendants: z.array(z.object({ pid: RecordedPidSchema, start: z.string() }).readonly()).readonly(),
  recordedAt: z.string(),
});

export type McpRunRecord = Readonly<z.infer<typeof McpRunRecordSchema>>;

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly start: string;
}

const execFileAsync = promisify(execFile);

/** Every process the system lists, with its parent, group and start time; empty when it could not be listed. */
export async function listProcesses(): Promise<ProcessRow[]> {
  return (await processListing()) ?? [];
}

/**
 * Every process the system lists, or undefined when there is no listing to
 * go by (no `ps`, as on Windows, or it failed): told apart from an empty one
 * by a caller that would otherwise read "nothing is running".
 */
export async function processListing(): Promise<ProcessRow[] | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], { maxBuffer: 16 * 1024 * 1024 });
    return stdout.split("\n").flatMap((line): ProcessRow[] => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      // A zombie has already exited: only its parent's wait remains (a container's PID 1 may never reap it).
      if (match === null || match[4]?.startsWith("Z") === true) return [];
      return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), start: match[5] ?? "" }];
    });
  } catch {
    return undefined;
  }
}

/** The processes in group `pgid`, and every descendant of `root` wherever its group is (`setsid` included). */
export function treeOf(rows: readonly ProcessRow[], root: number, pgid: number): ProcessRow[] {
  const found = new Map<number, ProcessRow>();
  for (const row of rows) if (row.pgid === pgid) found.set(row.pid, row);
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const queue = [root, ...found.keys()];
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    for (const child of children.get(pid) ?? []) {
      if (found.has(child.pid)) continue;
      found.set(child.pid, child);
      queue.push(child.pid);
    }
  }
  return [...found.values()].filter((row) => row.pid !== process.pid);
}

const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(pid, name);
  } catch {
    // Gone already, or never ours: nothing to do.
  }
};

/** Kills each recorded process still running with the same start time (a reused pid is left alone). */
export async function sweep(recorded: readonly { readonly pid: number; readonly start: string }[]): Promise<number> {
  if (recorded.length === 0) return 0;
  const alive = new Map((await listProcesses()).map((row) => [row.pid, row.start]));
  let killed = 0;
  for (const entry of recorded) {
    if (entry.pid === process.pid || alive.get(entry.pid) !== entry.start) continue;
    signal(entry.pid, "SIGKILL");
    killed += 1;
  }
  return killed;
}

/** Newline-delimited JSON-RPC framing with a per-message cap, holding at most one message's bytes. */
export class MessageFramer {
  readonly #max: number;
  #chunks: Buffer[] = [];
  #length = 0;
  #discarding = false;

  constructor(max: number) {
    this.#max = max;
  }

  /** The complete lines in `chunk`, each with `oversized` set when it was dropped for passing the cap. */
  push(chunk: Buffer): { readonly lines: string[]; readonly oversized: number } {
    const lines: string[] = [];
    let oversized = 0;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(offset, end);
      if (!this.#discarding) {
        // The cap counts the message and its newline, as the server wrote them: past it, nothing more is held.
        if (this.#length + piece.length + 1 > this.#max) {
          this.#discarding = true;
          this.#chunks = [];
          this.#length = 0;
          oversized += 1;
        } else if (piece.length > 0) {
          this.#chunks.push(Buffer.from(piece));
          this.#length += piece.length;
        }
      }
      if (newline === -1) break;
      if (!this.#discarding && this.#length > 0) {
        const line = Buffer.concat(this.#chunks, this.#length).toString("utf8").replace(/\r$/, "");
        if (line.trim() !== "") lines.push(line);
      }
      this.#chunks = [];
      this.#length = 0;
      this.#discarding = false;
      offset = newline + 1;
    }
    return { lines, oversized };
  }

  clear(): void {
    this.#chunks = [];
    this.#length = 0;
    this.#discarding = false;
  }
}

export class TaviStdioTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<T extends JSONRPCMessage>(message: T) => void) | undefined;
  sessionId?: string | undefined;

  readonly #options: TaviStdioOptions;
  readonly #framer: MessageFramer;
  readonly #clock: () => number;
  #child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
  #exited: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;
  #finished = false;
  #leaderStart = "";
  #stderrWindow = { start: 0, bytes: 0 };
  /** The process printed that it could not enter its cgroup (contracts' `LIMITS_ENTRY_FAILED`): it never ran. */
  #unplaced = false;

  constructor(options: TaviStdioOptions) {
    this.#options = options;
    this.#framer = new MessageFramer(options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
    this.#clock = options.clock ?? Date.now;
  }

  /** The group leader's pid (the SDK reads it to recognise a stdio transport). */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** The server's stderr stream, always drained here. */
  get stderr(): Readable | null {
    return this.#child?.stderr ?? null;
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) throw new Error("TaviStdioTransport already started");
    const placed = this.#options.place?.([this.#options.command, ...this.#options.args]) ?? {
      argv: [this.#options.command, ...this.#options.args],
    };
    let released = false;
    const release = (): string | undefined => {
      if (released) return undefined;
      released = true;
      return placed.onExit?.();
    };
    // On Windows a `.cmd` server (npm's shims) runs through cmd.exe, quoted, or as Node on its entry.
    const launch = launchCommand(placed.argv[0] as string, placed.argv.slice(1), { env: this.#options.env });
    const child = spawn(launch.command, launch.args, {
      // Its own group to signal whole; on Windows, its own Job Object.
      detached: process.platform !== "win32",
      shell: false,
      ...(launch.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: true }),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...this.#options.env },
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
    });
    this.#child = child;
    this.#exited = new Promise((resolve) => child.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        try {
          requireJob(child);
          resolve();
        } catch (error) {
          release();
          reject(error);
        }
      });
      child.once("error", (error) => {
        // A spawn that failed never reaches `close`: its group goes now.
        release();
        reject(error);
      });
    });
    child.on("error", (error) => this.#report(error));
    child.stdin.on("error", (error) => this.#report(error));
    child.stdout.on("error", (error) => this.#report(error));
    child.stderr.on("error", (error) => this.#report(error));
    child.stdout.on("data", (chunk: Buffer) => this.#read(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#drain(chunk));
    child.once("close", (code, name) => {
      const why =
        release() ??
        (code === LIMITS_ENTRY_FAILED_EXIT && this.#unplaced
          ? "it could not enter its resource limits (its cgroup), so it did not run; tavi doctor shows the limits"
          : undefined);
      if (!this.#closed)
        this.#report(new Error(`the MCP server exited (${name ?? `code ${String(code)}`})${why === undefined ? "" : `: ${why}`}`));
      this.#finish();
    });
    // The leader's start time tells it apart from a later process with the same pid; only a run record needs it.
    if (this.#options.pidFile === undefined) return;
    const pid = child.pid as number;
    this.#leaderStart = (await listProcesses()).find((row) => row.pid === pid)?.start ?? "";
    await this.#record([]);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#child?.stdin;
    if (stdin === undefined || this.#closed || stdin.destroyed) throw new Error("the MCP server is not running");
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (error) => (error === null || error === undefined ? resolve() : reject(error)));
    });
  }

  /** stdin closed, then SIGTERM, then SIGKILL to the group after the grace, then the descendant sweep. */
  async close(): Promise<void> {
    this.#closing ??= this.#stop(false);
    return this.#closing;
  }

  /** SIGKILL to the group at once, then the sweep: for a stuck call. */
  async kill(): Promise<void> {
    this.#closing ??= this.#stop(true);
    return this.#closing;
  }

  async #stop(now: boolean): Promise<void> {
    const child = this.#child;
    this.#closed = true;
    if (child === undefined || child.pid === undefined) {
      this.#finish();
      return;
    }
    const pgid = child.pid;
    // Seen before any signal: once a parent dies, a setsid child is reparented and lost from the tree.
    const rows = await listProcesses();
    const tree = treeOf(rows, pgid, pgid).map((row) => ({ pid: row.pid, start: row.start }));
    // An emptied group's id may since lead someone else's group: signal it only while it still has members.
    const grouped = rows.some((row) => row.pgid === pgid);
    const signalGroup = (name: NodeJS.Signals): void => {
      // Windows has no groups to signal: its SIGKILL ends the child's Job Object.
      if (process.platform === "win32") signalChild(child, name);
      else if (grouped) signal(-pgid, name);
    };
    const exited = this.#exited ?? Promise.resolve();
    const within = (ms: number): Promise<boolean> =>
      Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref())]);
    if (!now) {
      child.stdin.end();
      if (!(await within(this.#options.stdinGraceMs ?? STDIN_GRACE_MS))) {
        signalGroup("SIGTERM");
        if (!(await within(this.#options.killGraceMs ?? KILL_GRACE_MS))) signalGroup("SIGKILL");
      }
    }
    signalGroup("SIGKILL");
    await within(1_000);
    await sweep(tree);
    this.#framer.clear();
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    if (this.#options.pidFile !== undefined) await rm(this.#options.pidFile, { force: true }).catch(() => undefined);
    this.#finish();
  }

  #finish(): void {
    if (this.#child !== undefined) {
      const child = this.#child;
      child.stdout.removeAllListeners("data");
      child.stdout.destroy();
      child.stdin.destroy();
      // stderr keeps draining until the process is gone, then is released.
      child.stderr.resume();
    }
    if (this.#finished) return;
    this.#finished = true;
    this.#closed = true;
    try {
      this.onclose?.();
    } catch (error) {
      this.#report(error);
    }
  }

  #read(chunk: Buffer): void {
    const { lines, oversized } = this.#framer.push(chunk);
    if (oversized > 0)
      this.#report(
        new Error(
          `the MCP server sent a message over ${String(this.#options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES)} bytes; it was dropped`,
        ),
      );
    for (const line of lines) {
      let message: JSONRPCMessage;
      try {
        message = JSON.parse(line) as JSONRPCMessage;
      } catch {
        this.#report(new Error("the MCP server wrote a line that is not JSON"));
        continue;
      }
      if (typeof message !== "object" || message === null || (message as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
        this.#report(new Error("the MCP server wrote a message that is not JSON-RPC 2.0"));
        continue;
      }
      try {
        this.onmessage?.(message);
      } catch (error) {
        this.#report(error);
      }
    }
  }

  #drain(chunk: Buffer): void {
    if (!this.#unplaced && chunk.includes(LIMITS_ENTRY_FAILED)) this.#unplaced = true;
    const now = this.#clock();
    if (now - this.#stderrWindow.start >= 60_000) this.#stderrWindow = { start: now, bytes: 0 };
    const cap = this.#options.stderrBytesPerMinute ?? STDERR_BYTES_PER_MINUTE;
    const room = cap - this.#stderrWindow.bytes;
    if (room <= 0) return;
    const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.#stderrWindow.bytes += kept.length;
    try {
      this.#options.onStderr?.(kept.toString("utf8"));
    } catch (error) {
      this.#report(error);
    }
  }

  #report(error: unknown): void {
    try {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // An error handler that throws has nothing left to tell.
    }
  }

  /** Writes the run record atomically; descendants as seen now. */
  async #record(descendants: readonly { readonly pid: number; readonly start: string }[]): Promise<void> {
    const file = this.#options.pidFile;
    const pid = this.#child?.pid;
    if (file === undefined || pid === undefined) return;
    const record: McpRunRecord = {
      pgid: pid,
      leaderStart: this.#leaderStart,
      descendants,
      recordedAt: new Date(this.#clock()).toISOString(),
    };
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      writeJsonAtomic(file, record, { trailingNewline: true });
    } catch (error) {
      this.#report(error);
    }
  }

  /** Re-reads the tree and records it: called after connect, and on each tool listing. */
  async recordDescendants(): Promise<void> {
    const pid = this.#child?.pid;
    if (pid === undefined || this.#closed || this.#options.pidFile === undefined) return;
    const tree = treeOf(await listProcesses(), pid, pid)
      .filter((row) => row.pid !== pid)
      .map((row) => ({ pid: row.pid, start: row.start }));
    await this.#record(tree);
  }
}
