import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Tree walking for the suites that build large trees (`tests/release.test.ts`'s packed install). */

export interface WalkEntry {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly isDirectory: boolean;
}

/** Every entry below `directory`, depth-first. Symlinks are not followed. */
export function* walk(directory: string): Generator<WalkEntry> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const isDirectory = entry.isDirectory();
    yield {
      path,
      name: entry.name,
      size: isDirectory ? 0 : statSync(path).size,
      isDirectory,
    };
    if (isDirectory) yield* walk(path);
  }
}

/** Recursive size of a directory tree in bytes. */
export function directorySize(directory: string): number {
  let total = 0;
  for (const entry of walk(directory)) {
    if (!entry.isDirectory) total += entry.size;
  }
  return total;
}
