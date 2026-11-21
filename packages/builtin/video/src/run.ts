import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { killLadder } from "@tavi/child-kit";
import {
  LIMITS_ENTRY_FAILED_EXIT,
  VIDEO_LIMITS,
  type MediaContainer,
  type VideoFailure,
  type VideoInput,
  type VideoRefusal,
  type VideoSandbox,
} from "@tavi/contracts";
import { sha256Hex, systemChildEnv } from "@tavi/node-kit";

import { SNIFF_BYTES, sniffMedia } from "./sniff.js";
import { sizeOf, supervise } from "./supervise.js";

/**
 * One confined, capped run per call: a fresh `0700` run directory under the owner's data, the verified
 * bytes copied in (`0400`, never hard-linked: the directory is the child's
 * one writable path), the binary spawned through the owner's wrap with its
 * own process group, an RSS watchdog and a wall clock, its stdout and stderr
 * read within caps, and what it wrote held to the run directory's cap. Runs
 * are queued one at a time. A video whose run was killed for time or memory,
 * crashed or answered out of protocol is refused for a day.
 */

export interface RunnerOptions {
  readonly sandbox: VideoSandbox;
  /** Where run directories are made (`<data>/video/runs`). */
  readonly runsDirectory: string;
  /** What the binaries need to read inside the denied roots: their library closure (`libraryRoots`). */
  readonly readRoots?: readonly string[];
  /** Runs at once; more wait. */
  readonly concurrency?: number;
  readonly now?: () => number;
  /** The watchdog's sampler (tests replace it). */
  readonly residentKb?: (pid: number) => Promise<number | undefined>;
  /** Told when a child starts and ends. */
  readonly observe?: (event: { readonly kind: "spawn" | "exit"; readonly pid: number | undefined }) => void;
}

/** A run directory, with the input copied in. */
export interface RunDirectory {
  readonly path: string;
  readonly input: VideoInput;
  /** Removes it and everything in it. */
  dispose(): void;
}

export interface ExecRequest {
  readonly binary: string;
  readonly args: readonly string[];
  readonly run: RunDirectory;
  readonly timeoutMs: number;
  /** stdout's cap: past it the run is killed and fails `protocol`. */
  readonly stdoutMaxBytes: number;
  /**
   * `keep-head`: past the cap, stdout's first `stdoutMaxBytes` are kept and the run goes on, never killed for it
   * (a long subtitle track is text, not a fault of the video). `kill` (absent) ends it as `protocol`.
   */
  readonly stdoutPastCap?: "kill" | "keep-head";
}

export type ExecResult =
  | {
      readonly ok: true;
      readonly stdout: Buffer;
      readonly stderr: string;
      readonly peakKb: number;
      readonly wallMs: number;
      readonly truncated?: boolean;
    }
  /** It ran to the end and exited non-zero: FFmpeg's own refusal of the file (corrupt, too many pixels), its diagnostics in `stderr`. */
  | { readonly ok: false; readonly exitCode: number; readonly stderr: string }
  | { readonly ok: false; readonly failure: VideoFailure }
  | { readonly ok: false; readonly refused: "refused-recently"; readonly failure: VideoFailure };

export interface Runner {
  /**
   * A fresh run directory with `source` copied in as `in.<container>`,
   * read-only. The copy itself is checked, sniffed, sized and hashed: a file
   * that changed since the caller sniffed it is refused (`VideoOpenError`).
   */
  open(source: { readonly bytes: Uint8Array } | { readonly file: string }, container: MediaContainer, sha256?: string): RunDirectory;
  /**
   * A run directory for frames the owner made itself (the native-video probe's
   * raw clip): `bytes` written as `name`, no video to sniff; the run's input is
   * that file, standing for the clip it will become.
   */
  scratch(name: string, bytes: Uint8Array): RunDirectory;
  exec(request: ExecRequest): Promise<ExecResult>;
  /**
   * Refuses a video for a day after a run that ended cleanly but answered out
   * of protocol (output the decoder could not read back), as a
   * run killed for time, memory or a crash is.
   */
  refuse(sha256: string, failure: VideoFailure): void;
  /** What a run has written so far, in bytes: its directory less the input's copy. */
  usage(run: RunDirectory): number;
  /** Stops every running child. */
  close(): Promise<void>;
}

/** Why a run directory could not be made for a file: it is no video, too large, or changed since it was sniffed. */
export class VideoOpenError extends Error {
  readonly refusal: Extract<VideoRefusal, "not-video" | "too-large">;
  constructor(refusal: Extract<VideoRefusal, "not-video" | "too-large">, message: string) {
    super(message);
    this.name = "VideoOpenError";
    this.refusal = refusal;
  }
}

/** What a run has written: its directory less the input's copy. */
function written(run: RunDirectory): number {
  return sizeOf(run.path) - statSync(run.input.path).size;
}

/** A capped buffer: once past `max`, `over` is called once and nothing more is kept. */
function collector(
  max: number,
  keepHead = false,
): { readonly push: (chunk: Buffer, over: () => void) => void; readonly value: () => Buffer; readonly truncated: () => boolean } {
  const chunks: Buffer[] = [];
  let length = 0;
  let overflowed = false;
  return {
    push: (chunk, over) => {
      if (overflowed) return;
      if (length + chunk.length > max) {
        overflowed = true;
        // Kept to the cap: what fits is the head, the rest is read and dropped.
        if (keepHead && max > length) {
          chunks.push(chunk.subarray(0, max - length));
          length = max;
        }
        if (!keepHead) over();
        return;
      }
      chunks.push(chunk);
      length += chunk.length;
    },
    value: () => Buffer.concat(chunks, length),
    truncated: () => overflowed,
  };
}

/** The tail of a child's diagnostics: they may quote the file, so they are kept short and never shown. */
function tail(max: number): { readonly push: (chunk: Buffer) => void; readonly value: () => string } {
  let kept = Buffer.alloc(0);
  return {
    push: (chunk) => {
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > max) kept = kept.subarray(kept.length - max);
    },
    value: () => kept.toString("utf8"),
  };
}

export function createRunner(options: RunnerOptions): Runner {
  const now = options.now ?? Date.now;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const killed = new Map<string, { readonly until: number; readonly failure: VideoFailure }>();
  const running = new Set<{ readonly child: ChildProcess; readonly kill?: () => void }>();
  let active = 0;
  const queue: (() => void)[] = [];
  let closed = false;

  const acquire = async (): Promise<void> => {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
  };
  const release = (): void => {
    const next = queue.shift();
    if (next !== undefined) next();
    else active -= 1;
  };

  const open: Runner["open"] = (source, container, given) => {
    mkdirSync(options.runsDirectory, { recursive: true, mode: 0o700 });
    const path = join(options.runsDirectory, `${now().toString(36)}-${randomBytes(6).toString("hex")}`);
    mkdirSync(path, { mode: 0o700 });
    const input = join(path, `in.${container}`);
    try {
      // A copy, never a link: the child may write here, and a link would also mark a folder file as hard-linked.
      if ("bytes" in source) writeFileSync(input, source.bytes, { mode: 0o400, flag: "wx" });
      else {
        copyFileSync(source.file, input);
        chmodSync(input, 0o400);
      }
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
    const dispose = (): void => rmSync(path, { recursive: true, force: true });
    const size = statSync(input).size;
    if (size > VIDEO_LIMITS.maxInputBytes) {
      dispose();
      throw new VideoOpenError(
        "too-large",
        `the video is ${String(Math.ceil(size / 1024 / 1024))} MiB; the most is ${String(VIDEO_LIMITS.maxInputBytes / 1024 / 1024)} MiB`,
      );
    }
    if (sniffMedia(headOf(input), container) !== container) {
      dispose();
      throw new VideoOpenError("not-video", "the file changed after it was checked, or is not the video it was");
    }
    const sha256 = "bytes" in source ? sha256Hex(source.bytes) : hashFile(input);
    if (given !== undefined && given !== sha256) {
      dispose();
      throw new VideoOpenError("not-video", "the file changed after it was checked");
    }
    return { path, input: { path: input, sha256, container }, dispose };
  };

  const scratch: Runner["scratch"] = (name, bytes) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new RangeError("a scratch file is a plain name");
    mkdirSync(options.runsDirectory, { recursive: true, mode: 0o700 });
    const path = join(options.runsDirectory, `${now().toString(36)}-${randomBytes(6).toString("hex")}`);
    mkdirSync(path, { mode: 0o700 });
    const file = join(path, name);
    writeFileSync(file, bytes, { mode: 0o400, flag: "wx" });
    return {
      path,
      input: { path: file, sha256: sha256Hex(bytes), container: "mp4" },
      dispose: () => rmSync(path, { recursive: true, force: true }),
    };
  };

  const remember = (sha256: string, failure: VideoFailure): void => {
    killed.set(sha256, { until: now() + VIDEO_LIMITS.refuseKilledForMs, failure });
    if (killed.size > 1_000) for (const [key, entry] of killed) if (entry.until <= now() || killed.size > 1_000) killed.delete(key);
  };

  const exec: Runner["exec"] = async (request) => {
    if (closed) return { ok: false, failure: "crashed" };
    const sha256 = request.run.input.sha256;
    const before = killed.get(sha256);
    if (before !== undefined && before.until > now()) return { ok: false, refused: "refused-recently", failure: before.failure };
    if (before !== undefined) killed.delete(sha256);
    const argv = [request.binary, ...request.args];
    const env: Record<string, string> = { ...systemChildEnv(), LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
    let launch: {
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly onExit?: () => "oom" | undefined;
      readonly kill?: () => void;
    };
    if (options.sandbox.kind === "none") launch = { command: request.binary, args: request.args, env };
    else {
      const wrapped = options.sandbox.wrap({
        argv,
        env,
        readRoots: options.readRoots ?? [],
        runDirectory: request.run.path,
        workload: "video",
        limits: { memoryBytes: VIDEO_LIMITS.childMemoryMb * 1024 * 1024, processes: VIDEO_LIMITS.processes },
      });
      if ("refused" in wrapped) return { ok: false, failure: "unconfined" };
      launch = wrapped;
    }
    await acquire();
    if (closed) {
      release();
      return { ok: false, failure: "crashed" };
    }
    const started = now();
    const stdout = collector(request.stdoutMaxBytes, request.stdoutPastCap === "keep-head");
    const stderr = tail(VIDEO_LIMITS.stderrMaxBytes);
    let entry: { readonly child: ChildProcess; readonly kill?: () => void } | undefined;
    const outcome = await supervise(launch, {
      cwd: request.run.path,
      timeoutMs: request.timeoutMs,
      written: () => written(request.run),
      stdout: (chunk, over) => stdout.push(chunk, over),
      stderr: (chunk) => stderr.push(chunk),
      ...(options.residentKb === undefined ? {} : { residentKb: options.residentKb }),
      started: (child) => {
        entry = { child, ...(launch.kill === undefined ? {} : { kill: launch.kill }) };
        running.add(entry);
        options.observe?.({ kind: "spawn", pid: child.pid });
      },
      ended: (child) => {
        if (entry !== undefined) running.delete(entry);
        options.observe?.({ kind: "exit", pid: child.pid });
      },
    });
    release();
    // The owner's reasons are the run's failures; a caller's signal is never passed here.
    let why: VideoFailure | undefined = outcome.why === "stopped" ? "crashed" : outcome.why;
    // A binary that never started (not found, not executable) says nothing about the video: not remembered.
    if (why === undefined && outcome.error !== undefined) return { ok: false, failure: "crashed" };
    // Never having run (it could not enter its cgroup) says nothing about the video.
    if (why === undefined && outcome.code === LIMITS_ENTRY_FAILED_EXIT) return { ok: false, failure: "crashed" };
    if (why === undefined && outcome.signal !== null) why = "crashed";
    if (why !== undefined) {
      remember(sha256, why);
      return { ok: false, failure: why };
    }
    if (outcome.code !== 0) return { ok: false, exitCode: outcome.code ?? -1, stderr: stderr.value() };
    return {
      ok: true,
      stdout: stdout.value(),
      stderr: stderr.value(),
      peakKb: outcome.peakKb,
      wallMs: now() - started,
      ...(stdout.truncated() ? { truncated: true } : {}),
    };
  };

  return {
    open,
    scratch,
    exec,
    refuse: remember,
    usage: written,
    close: async () => {
      closed = true;
      for (const waiter of queue.splice(0)) {
        active += 1;
        waiter();
      }
      await Promise.all([...running].map((entry) => killLadder(entry.child, undefined, entry.kill)));
    },
  };
}

/** A file's first bytes, as much as a sniff needs. */
function headOf(path: string): Uint8Array {
  const buffer = Buffer.alloc(SNIFF_BYTES);
  const fd = openSync(path, "r");
  try {
    return buffer.subarray(0, readSync(fd, buffer));
  } finally {
    closeSync(fd);
  }
}

/** A file's sha256, read in chunks so a large video is never held whole. */
export function hashFile(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}
