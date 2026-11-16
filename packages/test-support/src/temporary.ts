import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Temporary directories a suite creates and removes. The common shape across
 * the suites: `mkdtempSync(join(tmpdir(), "tavi-<area>-"))`, pushed onto a
 * list an `afterEach` (or `afterAll`) empties with a recursive, forced
 * `rmSync`. `mkdtempSync` already creates the directory owner-only (0o700);
 * `mode` is for a test that needs another.
 */

export interface TemporaryDirectoryOptions {
  /** `chmod` the new directory to this mode. */
  readonly mode?: number;
}

export interface TemporaryDirectoriesOptions extends TemporaryDirectoryOptions {
  /** The name prefix `create` uses when it is given none. Default "tavi-test-". */
  readonly prefix?: string;
  /**
   * What `cleanup` does with a directory it could not remove, after trying
   * every one: "throw" (the default) an `AggregateError` naming them, or
   * "warn" on the console and carry on.
   */
  readonly leftovers?: "throw" | "warn";
}

export interface TemporaryDirectories {
  /** A new directory under the system temporary directory, named `prefix` and six random characters. */
  create(prefix?: string, options?: TemporaryDirectoryOptions): string;
  /** Removes every directory created since the last cleanup, newest first. Pass it to `afterEach` or `afterAll`. */
  cleanup(): void;
  /** The directories not yet removed, oldest first. */
  readonly paths: readonly string[];
}

/** A list of temporary directories and the one call that removes them. */
export function temporaryDirectories(defaults: TemporaryDirectoriesOptions = {}): TemporaryDirectories {
  const created: string[] = [];
  return {
    paths: created,
    create(prefix = defaults.prefix ?? "tavi-test-", options = {}) {
      const directory = mkdtempSync(join(tmpdir(), prefix));
      const mode = options.mode ?? defaults.mode;
      if (mode !== undefined) chmodSync(directory, mode);
      created.push(directory);
      return directory;
    },
    cleanup() {
      const failed: unknown[] = [];
      while (created.length > 0) {
        const directory = created.pop() as string;
        try {
          // A child or a SQLite handle closing late can hold a file for a moment: retried, then reported.
          rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch (error) {
          if (defaults.leftovers === "warn") console.warn(`temporary directory left behind: ${directory} (${String(error)})`);
          else failed.push(error);
        }
      }
      if (failed.length > 0)
        throw new AggregateError(failed, `${failed.length} temporary director${failed.length === 1 ? "y" : "ies"} could not be removed`);
    },
  };
}

const shared = temporaryDirectories({ leftovers: "warn" });

/** A temporary directory on the module's own list, removed by `removeTemporaryDirectories`. */
export function temporaryDirectory(prefix: string, mode?: number): string {
  return shared.create(prefix, mode === undefined ? {} : { mode });
}

/** Removes every directory `temporaryDirectory` made; never throws, and names any leftovers. */
export function removeTemporaryDirectories(): void {
  shared.cleanup();
}
