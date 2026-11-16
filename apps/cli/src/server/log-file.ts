import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "@tavi/contracts/util";

/**
 * The daemon's own log file, with rotation.
 *
 * Every warning the scheduler emits — a denied tool call, a stale dispatch
 * marker, a failed alert send — went to stderr and nowhere else. Under launchd
 * or systemd that stream lands in the platform's unified log, which no Tavi
 * command can read; with the printed unit it is a plain append to one file that
 * nothing rotates. A multi-month daemon therefore had an unbounded file the
 * operator could not inspect with Tavi's own tools.
 *
 * The sink writes each JSON line to stderr **and** to the file, so the service
 * manager's own redirect keeps working while `tavi logs` can read the same
 * stream back. Rotation is size-based on the *current* file: `<path>` becomes
 * `<path>.1`, `<path>.1` becomes `<path>.2`, and so on up to `keep`.
 */

/** Default rotation threshold, and how many rotated files to keep. */
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_KEEP = 3;

/** Where a data directory's log lives when the daemon did not name a file. */
export function defaultLogPath(dataDirectory: string): string {
  return join(dataDirectory, "logs", "tavi.log");
}

function rotate(path: string, keep: number): void {
  // Drop the oldest, then shift each remaining one up. `keep` counts rotated
  // files, so `<path>` plus `<path>.1` … `<path>.<keep>` is the whole set.
  rmSync(`${path}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    const from = `${path}.${index}`;
    if (existsSync(from)) renameSync(from, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
}

/**
 * How often a held descriptor is checked against `<path>`, in milliseconds.
 *
 * Something else may move or delete the file under the held descriptor: an
 * operator's logrotate/newsyslog, a manual `mv`/`rm`, or another sink on the
 * same path rotating it. Without a check every later line would go to the moved
 * or unlinked file. A line costs one clock read; the `stat` pair runs at most
 * this often.
 */
const IDENTITY_CHECK_MS = 1000;

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed or never valid; nothing to release.
  }
}

/** A rotating file sink, plus `close` to release its descriptor early. */
export type RotatingFileSink = ((line: string) => void) & { readonly close: () => void };

/**
 * The daemon's log sink, plus `close` to release the log file's descriptor:
 * Windows cannot delete a file a process holds open, so a reset closes it first.
 */
export type LogSink = ((line: string) => void) & { readonly close: () => void };

/** Release `sink`'s log file when it is a `LogSink`; any other sink holds nothing. */
export function closeLogSink(sink: ((line: string) => void) | undefined): void {
  if (sink !== undefined && "close" in sink && typeof sink.close === "function") sink.close();
}

/**
 * A sink that appends to `path`, rotating before it would exceed `maxBytes`.
 *
 * The byte count is kept in memory and seeded from the file, so a line does not
 * cost a `stat` — the sink runs on every log line of a long-lived daemon. For
 * the same reason the file stays open between lines (a held descriptor is ~2 µs
 * a line against ~37 µs for `appendFileSync`'s open/write/close). It is opened
 * on the first write, not here, so a sink that never logs leaves no empty file
 * behind; closed before each rotation so the next line opens the fresh
 * `<path>`; dropped after a failed write so the next line retries a clean
 * open; and reopened when `<path>` no longer names the held file (checked every
 * `IDENTITY_CHECK_MS`, which also reseeds the byte count from the file). It
 * otherwise stays open until the process exits; writes are unbuffered, so there
 * is nothing to flush. Errors still throw — `createLogSink` is the layer that
 * absorbs them.
 */
export function createRotatingFileSink(path: string, maxBytes = DEFAULT_LOG_MAX_BYTES, keep = DEFAULT_LOG_KEEP): RotatingFileSink {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let bytes = existsSync(path) ? statSync(path).size : 0;
  let fd: number | undefined;
  let checkedAt = 0;
  const close = (): void => {
    if (fd === undefined) return;
    closeQuietly(fd);
    fd = undefined;
  };
  // Follow a `<path>` that was moved, deleted or truncated from outside: drop a
  // descriptor whose file is no longer `<path>`, and take the size from the file
  // rather than from this sink's own count.
  const followPath = (): void => {
    if (fd === undefined) return;
    const now = Date.now();
    if (now - checkedAt < IDENTITY_CHECK_MS) return;
    checkedAt = now;
    const current = statSync(path, { throwIfNoEntry: false });
    const held = fstatSync(fd);
    if (current === undefined || current.ino !== held.ino || current.dev !== held.dev) {
      close();
      bytes = current?.size ?? 0;
      return;
    }
    bytes = held.size;
  };
  const sink = (line: string): void => {
    const buffer = Buffer.from(`${line}\n`);
    try {
      followPath();
      // `bytes > 0` so a single line larger than the threshold still gets
      // written rather than rotating forever without progress.
      if (bytes > 0 && bytes + buffer.length > maxBytes) {
        close();
        rotate(path, keep);
        bytes = 0;
      }
      if (fd === undefined) {
        fd = openSync(path, "a", 0o600);
        checkedAt = Date.now();
      }
      // A regular file takes the whole buffer in one call in practice; loop
      // anyway so a short write can never drop the tail of a line.
      let offset = 0;
      while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
    } catch (error) {
      close();
      throw error;
    }
    bytes += buffer.length;
  };
  return Object.assign(sink, { close });
}

/**
 * The log sink: stderr always, plus the file when one was named.
 *
 * **Never throws.** `createLogger` calls its sink from the logger itself, so a
 * sink that raises on a full disk propagates into whatever was being logged —
 * `sendAlert`'s own catch, the sweep before any fire, a promise rejection handler
 * — turning "the log could not be written" into the failure the log existed to
 * report. A failed write is reported once, on stderr, and then
 * the daemon keeps running without the file.
 */
export function createLogSink(options: { readonly path?: string; readonly maxBytes?: number; readonly keep?: number }): LogSink {
  const stderr = (line: string): void => {
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // Nothing left to report to; the alternative is throwing from a logger.
    }
  };
  if (options.path === undefined) return Object.assign(stderr, { close: () => {} });
  const file = createRotatingFileSink(options.path, options.maxBytes, options.keep);
  let reportedFailure = false;
  const sink = (line: string): void => {
    stderr(line);
    try {
      file(line);
    } catch (error) {
      if (reportedFailure) return;
      reportedFailure = true;
      stderr(
        JSON.stringify({
          level: "error",
          message: "the daemon log file could not be written; continuing without it",
          path: options.path,
          reason: errorMessage(error),
        }),
      );
    }
  };
  return Object.assign(sink, { close: file.close });
}

/**
 * The last `count` lines, newest last.
 *
 * Reads the current file and, when it does not hold enough lines, the most
 * recent rotated one — a rotation is exactly when the interesting lines are most
 * likely to straddle two files.
 */
export function readLogTail(path: string, count: number): readonly string[] {
  // A missing file is "no lines yet", not an error; any other read failure
  // (a rotation landing between the check and the read, permissions) is the
  // caller's to report — `logs` must not die with a stack trace on the exact
  // race it exists to serve.
  // Oldest first: the rotated file precedes the current one.
  const ordered = [`${path}.1`, path].filter((candidate) => existsSync(candidate));
  const lines = ordered.flatMap((file) => {
    const fileLines = readFileSync(file, "utf8").split("\n");
    // A trailing newline leaves an empty last element, not a line.
    if (fileLines.at(-1) === "") fileLines.pop();
    return fileLines;
  });
  return lines.slice(Math.max(0, lines.length - count));
}
