import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { sleep } from "./sleep.js";

/** The codes Windows answers while another process (an indexer, an antivirus scan) briefly holds a file open. */
const WINDOWS_HELD = new Set(["EPERM", "EACCES", "EBUSY"]);
/** The waits between attempts on a held file: about a second and a half in all. */
const HELD_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640];

const heldOnWindows = (error: unknown, platform: NodeJS.Platform): boolean =>
  platform === "win32" && WINDOWS_HELD.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");

/**
 * `action`, tried again for a short while when Windows answers that another
 * process holds the file (`EPERM`, `EACCES`, `EBUSY`): an indexer or antivirus
 * scan opens a file just written, and a rename or removal over it fails until
 * the scan lets go. Elsewhere, and for any other error, the first failure is
 * thrown. Blocks the thread between attempts.
 */
export function retryWhileHeld<T>(action: () => T, platform: NodeJS.Platform = process.platform): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      const delay = HELD_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !heldOnWindows(error, platform)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

/** `retryWhileHeld`, waiting without blocking the event loop. */
export async function retryWhileHeldAsync<T>(action: () => Promise<T>, platform: NodeJS.Platform = process.platform): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const delay = HELD_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !heldOnWindows(error, platform)) throw error;
      await sleep(delay);
    }
  }
}

export interface AtomicWriteOptions {
  /** The file's mode from the instant it exists (before the umask). Default `0o600`. */
  readonly mode?: number;
  /**
   * Flush the file before the rename and its directory after it, so the new
   * contents survive a crash. A throw from the directory flush comes after the
   * file was already replaced.
   */
  readonly durable?: boolean;
}

export interface AtomicJsonOptions extends AtomicWriteOptions {
  /** `JSON.stringify`'s indent. Default none. */
  readonly indent?: number;
  /** End the file with a newline. */
  readonly trailingNewline?: boolean;
}

/**
 * Replaces `path` with `data` so a reader sees the old contents or the new,
 * never a part: written to `<path>.<12 hex>.tmp` beside it (created exclusively,
 * so two writers never share a temporary file) and renamed over it. The
 * temporary file is removed when any step fails. The parent directory must exist.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(temporary, "wx", options.mode ?? 0o600);
    try {
      writeFileSync(fd, data);
      if (options.durable === true) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    retryWhileHeld(() => renameSync(temporary, path));
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The write's own failure is the one to report.
    }
    throw error;
  }
  if (options.durable === true) flushDirectory(dirname(path));
}

/** `writeFileAtomic`, through a promise: the same temporary file, rename and cleanup, without blocking the event loop. */
export async function writeFileAtomicAsync(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600);
    try {
      await handle.writeFile(data);
      if (options.durable === true) await handle.sync();
    } finally {
      await handle.close();
    }
    await retryWhileHeldAsync(() => rename(temporary, path));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  if (options.durable === true) flushDirectory(dirname(path));
}

/** `value` as JSON, written as `writeFileAtomic` writes. */
export function writeJsonAtomic(path: string, value: unknown, options: AtomicJsonOptions = {}): void {
  const text = JSON.stringify(value, null, options.indent);
  writeFileAtomic(path, options.trailingNewline === true ? `${text}\n` : text, options);
}

/**
 * Flushes one file's bytes to the storage device. `writeFileSync` returning
 * means only that the bytes reached the kernel; this is the boundary that makes
 * a later rename of the file safe to depend on.
 */
export function flushFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Flushes a directory's entries (a rename into it) to disk; a filesystem that
 * cannot is let be. On Windows a directory cannot be opened for a flush, so the
 * durability narrows to "the file was flushed and the rename is atomic".
 */
export function flushDirectory(directory: string): void {
  // A directory cannot be opened for fsync on Windows; the file itself was flushed before the rename.
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } catch (error) {
    // Some filesystems cannot flush a directory; the rename is still in place.
    if (!DIRECTORY_FLUSH_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    closeSync(fd);
  }
}

const DIRECTORY_FLUSH_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);
