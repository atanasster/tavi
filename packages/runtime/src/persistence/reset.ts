import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { TaviError } from "@tavi/contracts";

import { removeTreeSync } from "../folder-retention.js";

/**
 * What tavi writes in a data directory, by name. A reset deletes these and
 * nothing else, so a data directory that was pointed at the wrong place (a home
 * directory, a project) loses no file tavi did not put there.
 *
 * The ownership files (`owner.lock`, its claim and journal, the process record)
 * are not listed: the caller holds the lock while it resets.
 */
const TAVI_ENTRIES = [
  "tavi.sqlite",
  "artifacts",
  // The chats' working folders: app-managed, so a reset erases them;
  // durable files belong in a host folder a chat attaches.
  "chats",
  "sandbox-home",
  // The sandbox's read roots (`read-roots.json`) and its probe's scratch (`.probe/`).
  "sandbox",
  "browser-profiles",
  "credentials",
  "credentials.key",
  "provider-bindings.key",
  "web-providers.json",
  "channels",
  "plugins",
  "ui",
  "logs",
  "runtime",
  "projects.json",
  "cache",
] as const;

/** What a chat's shell wrote (the chats' folders, the shell's former home): what a reset may fail to delete. */
const SHELL_WRITTEN = ["chats", "sandbox-home"] as const;

/**
 * The order a reset deletes in: what a shell wrote first, so a tree it cannot
 * delete stops the reset with the instance whole; then the database, so a
 * later failure leaves files no database refers to rather than a database
 * referring to files that are gone; then the rest.
 */
function deletionRank(name: string): number {
  if (SHELL_WRITTEN.some((entry) => name === entry || name.startsWith(`${entry}.pre-restore-`))) return 0;
  return name.startsWith("tavi.sqlite") ? 1 : 2;
}

/** Whether `name` is one of tavi's entries, or a copy `tavi restore` moved aside. */
function isTaviEntry(name: string): boolean {
  return TAVI_ENTRIES.some(
    (entry) =>
      name === entry ||
      name.startsWith(`${entry}.pre-restore-`) ||
      // The database's WAL sidecars and a restore's staged copy.
      (entry === "tavi.sqlite" && (name.startsWith(`${entry}-`) || name.startsWith(`${entry}.restore-`))),
  );
}

export interface ResetResult {
  /** The entries deleted, by name. */
  readonly removed: readonly string[];
  /** Entries left in place because tavi does not own them (the ownership files excepted). */
  readonly kept: readonly string[];
  /**
   * The memory providers other than the built-in a workspace had selected:
   * an index such a plugin keeps of its own is
   * outside the directory, so the reset did not reach it. Absent when none.
   */
  readonly memoryProviders?: readonly string[];
}

/**
 * Delete a data directory's state, as if tavi had just been installed:
 * the database, artifacts, the chats' folders, credentials and their key, installed plugins, the
 * web-search choice, messaging settings, UI preferences, logs and IPC files.
 * Deleted, not moved aside. The next owner starts on an empty directory and migrations build it.
 * A folder a toolchain left read-only (or a shell made unreadable) is made
 * its owner's and deleted, never through a link (`removeTreeSync`). An entry
 * that still cannot be deleted stops the reset, naming it and what was
 * deleted before it; running the reset again finishes it.
 *
 * The caller must hold the directory's ownership: a live owner would keep
 * writing into a database this removed.
 */
export function resetDataDirectory(dataDirectory: string, options: { readonly memoryProviders?: readonly string[] } = {}): ResetResult {
  if (!existsSync(dataDirectory)) return { removed: [], kept: [] };
  // Read by the caller before the database goes, through the database worker (never on this thread):
  // what the reset cannot reach is said with what it did.
  const memoryProviders = options.memoryProviders ?? [];
  const names = readdirSync(dataDirectory).sort();
  const kept = names.filter((name) => !isTaviEntry(name) && !name.startsWith("owner."));
  const removed: string[] = [];
  for (const name of names.filter(isTaviEntry).sort((a, b) => deletionRank(a) - deletionRank(b))) {
    try {
      removeTreeSync(join(dataDirectory, name));
    } catch (error) {
      const cause = TaviError.from(error);
      const before =
        removed.length === 0
          ? "nothing else was deleted"
          : `${removed.join(", ")} ${removed.length === 1 ? "was" : "were"} deleted before it, nothing after it`;
      throw new TaviError(cause.code, `The reset stopped: ${cause.message}; ${before}. Make it deletable and run tavi reset again.`, {
        cause: error,
        details: { stoppedAt: name, removed },
      });
    }
    removed.push(name);
  }
  return { removed, kept, ...(memoryProviders.length === 0 ? {} : { memoryProviders }) };
}
