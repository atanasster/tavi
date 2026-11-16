import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { TaviError } from "@tavi/contracts";
import { ownedHere, privacyProblem } from "@tavi/node-kit";

/**
 * The owner's own staging directory:
 * `<tmpdir>/tavi-<uid>/`, mode 0700, where the database spool, browser
 * uploads and `plugins.validate` stage. One directory, so every sandbox denies
 * it by one literal path — a spool created during a run is covered too.
 *
 * The system temporary directory is shared, so another user may have made the
 * path first: it is used only when it is a real directory this user owns and
 * nobody else can open.
 */
export function ownerStagingDirectory(base: string = tmpdir()): string {
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  const directory = join(base, `tavi-${owner === undefined ? userInfo().username : String(owner)}`);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(directory);
  // By uid and mode bits, or on Windows by owner SID and access list.
  const shared = stat.isDirectory() && (!ownedHere(directory, stat) || privacyProblem(directory, stat) !== undefined);
  if (!stat.isDirectory() || shared) {
    throw new TaviError(
      "UNAVAILABLE",
      `${directory} is not a private directory of this user (another user made it, it is a link, or others can open it); remove it and start Tavi again`,
      { details: { path: directory } },
    );
  }
  return directory;
}

/** Names the owner stages under directly in the system temporary directory: the fixture renderer's. */
export const OWNER_TEMPORARY_STAGING = ["tavi-render-*"] as const;

/**
 * A dead process's database scratch directories under `directory`; live PIDs
 * are never collected, and neither is another user's (the shared temporary
 * directory may hold theirs): a cleanup never stops the spool starting.
 */
export function reclaimDeadSpools(directory: string): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^tavi-database-(\d+)-[A-Za-z0-9_-]+$/.exec(entry.name);
    if (match === null || !entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    try {
      if (!ownedHere(path, lstatSync(path))) continue;
      process.kill(Number(match[1]), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  }
}

/** A database worker's scratch directory, in the owner's staging; dead processes' ones are reclaimed first. */
export function workerTempDirectory(): string {
  const staging = ownerStagingDirectory();
  reclaimDeadSpools(staging);
  return mkdtempSync(join(staging, `tavi-database-${process.pid}-`));
}
