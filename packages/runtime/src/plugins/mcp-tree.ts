import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { openNoFollowSync } from "@tavi/node-kit";

import { TaviError, type McpTreeIndexEntry } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

/**
 * An MCP server's plugin tree, read without holding it: an npm closure has
 * thousands of files. The walk refuses
 * links and special files as the plugin reader does, under the bounds of its
 * install kind; the hash streams each file and has exactly the plugin
 * reader's format, so a snapshot's `contentHash` is the same whichever reads
 * it. The index (path, size, mtime, inode, sha256) lets an owner start check
 * the tree by `stat`, re-hashing only what changed.
 */

export interface TreeBounds {
  readonly maxFiles: number;
  readonly maxDirectories: number;
  readonly maxDepth: number;
  readonly maxBytes: number;
}

export interface TreeEntry {
  readonly relative: string;
  readonly size: number;
}

const CHUNK = 1024 * 1024;

/** Every regular file under `root`, in the plugin hash's order (each directory's names sorted, depth first). */
export function listTree(root: string, bounds: TreeBounds): readonly TreeEntry[] {
  const entries: TreeEntry[] = [];
  let bytes = 0;
  let directories = 0;
  const walk = (directory: string, depth: number): void => {
    if (++directories > bounds.maxDirectories || depth > bounds.maxDepth)
      throw new TaviError(
        "INVALID_INPUT",
        `the server's files exceed ${String(bounds.maxDirectories)} directories or a depth of ${String(bounds.maxDepth)}`,
      );
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw new TaviError(
          "INVALID_INPUT",
          `the server's files contain a symbolic link (${relative(root, path)}); links are refused so the reviewed bytes are the ones that run`,
        );
      if (stat.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new TaviError("INVALID_INPUT", `the server's files contain a special file (${relative(root, path)})`);
      bytes += stat.size;
      if (entries.length + 1 > bounds.maxFiles || bytes > bounds.maxBytes)
        throw new TaviError(
          "INVALID_INPUT",
          `the server's files exceed ${String(bounds.maxFiles)} files or ${String(bounds.maxBytes)} bytes`,
        );
      entries.push({ relative: relative(root, path).split(sep).join("/"), size: stat.size });
    }
  };
  walk(root, 0);
  return entries;
}

/** One file's bytes, streamed: opened without following links, refused when it is not the size the walk saw. */
function streamFile(
  path: string,
  size: number,
  each: (chunk: Buffer) => void,
): { readonly mtimeMs: number; readonly ctimeMs: number; readonly ino: number } {
  const descriptor = openNoFollowSync(path, "read");
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new TaviError("INVALID_INPUT", `${path} is not a regular file`);
    if (opened.size !== size) throw new TaviError("CONFLICT", `${path} changed while it was being read`);
    const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
    let read = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      read += count;
      if (read > size) throw new TaviError("CONFLICT", `${path} grew while it was being read`);
      each(buffer.subarray(0, count));
    }
    if (read !== size) throw new TaviError("CONFLICT", `${path} changed while it was being read`);
    return { mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs, ino: opened.ino };
  } finally {
    closeSync(descriptor);
  }
}

/** The tree's content hash (the plugin reader's format) and its index, from one streamed read. */
export function hashTree(
  root: string,
  entries: readonly TreeEntry[],
): { readonly hash: string; readonly index: readonly McpTreeIndexEntry[] } {
  const total = createHash("sha256");
  const index: McpTreeIndexEntry[] = [];
  for (const entry of entries) {
    total.update(`${entry.relative}\0${String(entry.size)}\0`);
    const file = createHash("sha256");
    const { mtimeMs, ctimeMs, ino } = streamFile(join(root, ...entry.relative.split("/")), entry.size, (chunk) => {
      total.update(chunk);
      file.update(chunk);
    });
    total.update("\0");
    index.push({ path: entry.relative, size: entry.size, mtimeMs, ctimeMs, ino, sha256: file.digest("hex") });
  }
  return { hash: total.digest("hex"), index };
}

/** Copies the listed files into `target` (which must not exist yet), creating directories private to the owner. */
function copyTree(source: string, target: string, entries: readonly TreeEntry[]): void {
  for (const entry of entries) {
    const to = join(target, ...entry.relative.split("/"));
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(source, ...entry.relative.split("/")), to, constants.COPYFILE_EXCL);
  }
}

/** What a start-time check found: ok, or the first difference. */
export interface TreeCheck {
  readonly ok: boolean;
  readonly files: number;
  /** Files whose stat differed from the index, so their bytes were hashed again. */
  readonly rehashed: number;
  readonly problem?: string;
}

/**
 * A snapshot checked against its index: the same paths, and each file whose
 * size, mtime or inode differs re-hashed and compared. Cheap when nothing
 * changed; a full verify is `hashTree` against the approved hash.
 */
export function checkTree(root: string, index: readonly McpTreeIndexEntry[], bounds: TreeBounds): TreeCheck {
  let entries: readonly TreeEntry[];
  try {
    entries = listTree(root, bounds);
  } catch (error) {
    return { ok: false, files: 0, rehashed: 0, problem: errorMessage(error) };
  }
  const indexed = new Map(index.map((entry) => [entry.path, entry]));
  if (entries.length !== index.length)
    return {
      ok: false,
      files: entries.length,
      rehashed: 0,
      problem: `${String(entries.length)} files where ${String(index.length)} were approved`,
    };
  let rehashed = 0;
  for (const entry of entries) {
    const known = indexed.get(entry.relative);
    if (known === undefined) return { ok: false, files: entries.length, rehashed, problem: `${entry.relative} was not approved` };
    const path = join(root, ...entry.relative.split("/"));
    const stat = statSync(path);
    if (stat.size === known.size && stat.mtimeMs === known.mtimeMs && stat.ctimeMs === known.ctimeMs && stat.ino === known.ino) continue;
    rehashed += 1;
    const file = createHash("sha256");
    try {
      streamFile(path, stat.size, (chunk) => file.update(chunk));
    } catch (error) {
      return { ok: false, files: entries.length, rehashed, problem: errorMessage(error) };
    }
    if (stat.size !== known.size || file.digest("hex") !== known.sha256)
      return { ok: false, files: entries.length, rehashed, problem: `${entry.relative} changed since it was approved` };
  }
  return { ok: true, files: entries.length, rehashed };
}

/**
 * A server's files read, copied into `staging` (which must not exist) and
 * read again there; the staged hash must equal the source's. Done outside
 * the database worker: an npm closure is hundreds of megabytes, and the
 * worker's transaction holds every other database operation while it runs.
 */
export function prepareTree(
  source: string,
  staging: string,
  bounds: TreeBounds,
): { readonly hash: string; readonly index: readonly McpTreeIndexEntry[] } {
  const entries = listTree(source, bounds);
  const { hash } = hashTree(source, entries);
  copyTree(source, staging, entries);
  const staged = hashTree(staging, listTree(staging, bounds));
  if (staged.hash !== hash) throw new TaviError("INTERNAL", "the staged server does not match what was read; nothing was installed");
  // A rename keeps each file's inode, mtime and ctime, so the staging index describes the snapshot.
  return staged;
}

/**
 * A snapshot verified: by its index, re-hashing only files whose stat
 * changed, unless the index is stale or `full` asks for every byte, which
 * then answers a fresh index to store.
 */
export function verifyTree(input: {
  readonly directory: string;
  readonly contentHash: string;
  readonly version: string;
  readonly index: readonly McpTreeIndexEntry[];
  readonly stale: boolean;
  readonly full: boolean;
  readonly bounds: TreeBounds;
}): { readonly check: TreeCheck; readonly index?: readonly McpTreeIndexEntry[] } {
  if (!input.full && !input.stale) return { check: checkTree(input.directory, input.index, input.bounds) };
  try {
    const entries = listTree(input.directory, input.bounds);
    const hashed = hashTree(input.directory, entries);
    if (hashed.hash !== input.contentHash)
      return {
        check: {
          ok: false,
          files: entries.length,
          rehashed: entries.length,
          problem: `the snapshot of ${input.version} no longer matches its approved hash`,
        },
      };
    return { check: { ok: true, files: entries.length, rehashed: entries.length }, index: hashed.index };
  } catch (error) {
    return { check: { ok: false, files: 0, rehashed: 0, problem: errorMessage(error) } };
  }
}
