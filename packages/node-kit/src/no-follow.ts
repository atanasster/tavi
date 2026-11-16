import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";

import { privacyProblem, privateExpectation } from "./private-path.js";

/** Why `readNoFollow` refused a file. */
export type NoFollowRefusal = "symlink" | "not-file" | "linked" | "shared" | "too-large" | "path-form";

/** A refusal by `readNoFollow`: `reason` says which check failed, so a caller can word its own. */
export class NoFollowReadError extends Error {
  override readonly name = "NoFollowReadError";
  readonly reason: NoFollowRefusal;
  readonly path: string;

  constructor(reason: NoFollowRefusal, path: string, message: string) {
    super(message);
    this.reason = reason;
    this.path = path;
  }
}

export interface NoFollowReadOptions {
  /** The most bytes read; a larger file, or one that grows past it while read, is refused, never cut. */
  readonly maxBytes?: number;
  /** Refuse a file other accounts may read or write: any of mode `0o077`, or on Windows another trustee in its access list (`privacyProblem`). */
  readonly privateOnly?: boolean;
  /** Refuse a file with another name (a hard link elsewhere may change it). */
  readonly singleLink?: boolean;
  /** The platform whose rules apply (default: this one's). */
  readonly platform?: NodeJS.Platform;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/**
 * Open flags that never follow a link at the last component nor block on a
 * FIFO: `read` an existing file, `write` one without creating it, `create` a
 * new one (`O_EXCL`), `append` to one, creating it when missing. A link earlier
 * in the path is followed; a caller that confines a path resolves it first.
 */
export const NO_FOLLOW_FLAGS = {
  read: constants.O_RDONLY | NOFOLLOW | NONBLOCK,
  write: constants.O_WRONLY | NOFOLLOW | NONBLOCK,
  create: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK,
  append: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW | NONBLOCK,
} as const;

export type NoFollowOpen = keyof typeof NO_FOLLOW_FLAGS;

export interface NoFollowOpenOptions {
  /** The permission bits a created file gets (default `0o600`). */
  readonly mode?: number;
  /** The platform whose rules apply (default: this one's). */
  readonly platform?: NodeJS.Platform;
}

/** Windows's names for devices, whatever extension follows: `nul.txt` is `NUL`. */
const RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/**
 * Why Windows would read `path` as something other than the file it names, or
 * `undefined` when it would not (always, off Windows): a drive-relative path
 * (`C:name`, against that drive's own current folder), a device path
 * (`\\?\`, `\\.\`, `\??\`), an alternate data stream (`name:stream`), a name ending in
 * a dot or a space (which Windows drops, so `a.` is `a`), or a reserved
 * device name (`CON`, `NUL`, `COM1`, `nul.txt`).
 */
export function windowsPathRefusal(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return undefined;
  if (/^[\\/]{2}[?.][\\/]/.test(path) || /^[\\/]\?\?[\\/]/.test(path)) return "is a device path";
  if (/^[A-Za-z]:(?![\\/])/.test(path)) return "is drive-relative; give the full path";
  const names = path.replace(/^[A-Za-z]:/, "").split(/[\\/]/);
  for (const name of names) {
    if (name === "" || name === "." || name === "..") continue;
    if (name.includes(":")) return "names an alternate data stream";
    if (name.endsWith(".") || name.endsWith(" ")) return "has a name ending in a dot or a space, which Windows drops";
    if (RESERVED.test(name)) return "has a reserved device name";
  }
  return undefined;
}

/** An `ELOOP` as `open(2)` gives for a link under `O_NOFOLLOW`, so a caller's handling of one covers Windows too. */
function linkRefused(path: string, why = "is a link; refusing to follow it"): NodeJS.ErrnoException {
  return Object.assign(new Error(`${path} ${why}`), { code: "ELOOP", path });
}

function formRefused(path: string, platform: NodeJS.Platform): void {
  const refusal = windowsPathRefusal(path, platform);
  if (refusal !== undefined) throw new NoFollowReadError("path-form", path, `${path} ${refusal}`);
}

/** Windows' stand-in for `O_NOFOLLOW`, before the open: a link, junction or app execution alias is refused. */
function checkedBefore(path: string, stats: BigIntStats | undefined): BigIntStats | undefined {
  if (stats?.isSymbolicLink() === true) throw linkRefused(path);
  return stats;
}

/** After the open: the handle must be what the name was (or, for a new file, is), so a link swapped in meanwhile is caught. */
function sameAsNamed(opened: BigIntStats, named: BigIntStats | undefined): boolean {
  return named !== undefined && !named.isSymbolicLink() && named.dev === opened.dev && named.ino === opened.ino;
}

/**
 * `path` opened as `how` says, never through a link at its last component.
 * Elsewhere `O_NOFOLLOW` does that; Windows has none, so there the name is
 * `lstat`ed first (a link, junction or app execution alias is refused) and the
 * opened handle must be that same file by its 64-bit id. A link is refused
 * with `ELOOP` on every platform; a Windows path form that names something
 * else (`windowsPathRefusal`) with `NoFollowReadError` `path-form`.
 */
export function openNoFollowSync(path: string, how: NoFollowOpen, options: NoFollowOpenOptions = {}): number {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return openSync(path, NO_FOLLOW_FLAGS[how], options.mode ?? 0o600);
  formRefused(path, platform);
  const before = checkedBefore(path, lstatSync(path, { bigint: true, throwIfNoEntry: false }));
  const fd = openSync(path, NO_FOLLOW_FLAGS[how], options.mode ?? 0o600);
  try {
    const named = before ?? lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!sameAsNamed(fstatSync(fd, { bigint: true }), named)) throw linkRefused(path, "changed while it was opened");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** `openNoFollowSync`, as a `FileHandle`. */
export async function openNoFollow(path: string, how: NoFollowOpen, options: NoFollowOpenOptions = {}): Promise<FileHandle> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return await open(path, NO_FOLLOW_FLAGS[how], options.mode ?? 0o600);
  formRefused(path, platform);
  const before = checkedBefore(path, await lstat(path, { bigint: true }).catch(absentOnly));
  const handle = await open(path, NO_FOLLOW_FLAGS[how], options.mode ?? 0o600);
  try {
    const named = before ?? (await lstat(path, { bigint: true }).catch(absentOnly));
    if (!sameAsNamed(await handle.stat({ bigint: true }), named)) throw linkRefused(path, "changed while it was opened");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** A failed `lstat` that means "nothing is there": only `ENOENT`. A permission error is never "absent". */
function absentOnly(error: unknown): undefined {
  if ((error as { readonly code?: unknown }).code === "ENOENT") return undefined;
  throw error;
}

function notDirectory(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${path} is not a directory`), { code: "ENOTDIR", path });
}

/**
 * A directory opened for reading, never through a link at its last
 * component (`O_DIRECTORY | O_NOFOLLOW`): a link is refused with `ELOOP`,
 * anything else with `ENOTDIR`. Windows cannot open a directory that way:
 * there it is `lstat`ed and checked the same, and there is no descriptor
 * (`undefined`), so the caller works by path with its own identity checks.
 */
export function openDirectoryNoFollowSync(path: string, options: Pick<NoFollowOpenOptions, "platform"> = {}): number | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
  formRefused(path, platform);
  const stats = checkedBefore(path, lstatSync(path, { bigint: true }));
  if (stats?.isDirectory() !== true) throw notDirectory(path);
  return undefined;
}

/** `openDirectoryNoFollowSync`, as a `FileHandle`. */
export async function openDirectoryNoFollow(
  path: string,
  options: Pick<NoFollowOpenOptions, "platform"> = {},
): Promise<FileHandle | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
  formRefused(path, platform);
  const stats = checkedBefore(path, await lstat(path, { bigint: true }));
  if (stats?.isDirectory() !== true) throw notDirectory(path);
  return undefined;
}

/** How much one read asks for when the file's size is not trusted. */
const CHUNK = 64 * 1024;

/**
 * A file's bytes, or `undefined` when it does not exist, read from the inode
 * that was checked: opened `O_NOFOLLOW` and `fstat`ed, so a path swapped for a
 * symlink or a looser file between a check and the read is never read
 * through. A symlink, anything but a regular file, and what `options` refuses
 * throw `NoFollowReadError`; any other open failure is thrown as it is. The
 * read runs to the end of the file, whatever size `fstat` reported.
 */
export function readNoFollowSync(path: string, options: NoFollowReadOptions = {}): Buffer | undefined {
  let fd: number;
  try {
    fd = openNoFollowSync(path, "read", options.platform === undefined ? {} : { platform: options.platform });
  } catch (error) {
    return opened(error, path);
  }
  try {
    check(fstatSync(fd), path, options);
    const limit = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const chunks: Buffer[] = [];
    let length = 0;
    // Read to the end, at most one byte past the limit: a file that grew since the fstat is refused, not cut.
    while (length <= limit) {
      const chunk = Buffer.alloc(Math.min(CHUNK, limit + 1 - length));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      length += count;
    }
    if (length > limit) throw tooLarge(path, limit);
    return Buffer.concat(chunks, length);
  } finally {
    closeSync(fd);
  }
}

/** `readNoFollowSync`, through a promise. */
export async function readNoFollow(path: string, options: NoFollowReadOptions = {}): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await openNoFollow(path, "read", options.platform === undefined ? {} : { platform: options.platform });
  } catch (error) {
    return opened(error, path);
  }
  try {
    check(await handle.stat(), path, options);
    const limit = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= limit) {
      const chunk = Buffer.alloc(Math.min(CHUNK, limit + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (length > limit) throw tooLarge(path, limit);
    return Buffer.concat(chunks, length);
  } finally {
    await handle.close();
  }
}

function opened(error: unknown, path: string): undefined {
  const code = (error as { readonly code?: unknown }).code;
  if (code === "ENOENT") return undefined;
  if (code === "ELOOP") throw new NoFollowReadError("symlink", path, `${path} is a symlink; refusing to follow it`);
  throw error;
}

function check(stats: Stats, path: string, options: NoFollowReadOptions): void {
  if (!stats.isFile()) throw new NoFollowReadError("not-file", path, `${path} is not a regular file`);
  if (options.singleLink === true && stats.nlink > 1) throw new NoFollowReadError("linked", path, `${path} has another name (a hard link)`);
  const problem = options.privateOnly === true ? privacyProblem(path, stats, options.platform) : undefined;
  if (problem !== undefined)
    throw new NoFollowReadError(
      "shared",
      path,
      `${path} is accessible to other users (${problem}); ${privateExpectation("600", options.platform)}`,
    );
  if (options.maxBytes !== undefined && stats.size > options.maxBytes) throw tooLarge(path, options.maxBytes);
}

function tooLarge(path: string, limit: number): NoFollowReadError {
  return new NoFollowReadError("too-large", path, `${path} is over the ${String(limit)}-byte limit`);
}
