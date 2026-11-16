import { chmodSync, closeSync, existsSync, lstatSync, openSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import { TaviError } from "@tavi/contracts";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";
import { makePrivateDirectory, privacyProblem, privateRemedy } from "@tavi/node-kit";

import { loadBetterSqlite3 } from "./sqlite-loader.js";
import { assertLocalFilesystem } from "./local-filesystem.js";
import { assertPreviousOwnerStopped, publishOwnerProcess, removeOwnerProcess } from "./owner-process.js";

/**
 * Exclusive data-directory ownership.
 *
 * One process owns a data directory and its scheduler. The lock is a SQLite
 * database in the directory held under an exclusive transaction for the lifetime
 * of the owner:
 *
 *  - it is **OS-backed**, because SQLite takes POSIX advisory locks on the file,
 *    so no portable JavaScript lock library is needed and the guarantee does not
 *    depend on our own bookkeeping;
 *  - it **releases on crash**, because the operating system drops advisory locks
 *    when the owning process dies — a stale PID file would survive and lie;
 *  - it is a **separate file** from `tavi.sqlite`, so holding it cannot block WAL
 *    checkpointing or write traffic in the application database.
 *
 * Initialization order matters and is deliberate: the lock is taken **before**
 * the ownership table is created, and the table creation is never committed until
 * the owner releases. A process that loses the race therefore always sees a
 * contender that either holds the lock or has released it — never one that is
 * halfway through creating its schema — which is what makes "exactly one of N
 * simultaneous launchers wins" true rather than usually true.
 */
export interface DataDirectoryOwner {
  readonly dataDirectory: string;
  readonly lockPath: string;
  readonly sessionId: string;
  readonly acquiredAt: string;
  /** True once released; credential publication requires a live owner. */
  readonly released: boolean;
  /** Returns a message when the lock could not be released cleanly. */
  release(): { readonly released: boolean; readonly error?: string };
}

export interface AcquireOwnershipOptions {
  readonly dataDirectory: string;
  /** Liveness identity of the new owner, recorded for diagnostics. */
  readonly sessionId: string;
  readonly now?: () => string;
  /**
   * How long to wait for the lock before reporting contention.
   *
   * A positive timeout is what makes a race between several launchers resolve to
   * exactly one owner: with an immediate failure every contender can observe the
   * other's half-initialized file and refuse, leaving a directory with no owner
   * at all.
   *
   * It bounds the wait for the claim and, separately, the retry of the upgrade, so
   * `0` is a probe: one attempt at each, failing fast against a held lock. That is
   * for a caller that only asks whether the directory is owned, never for one
   * that means to become the owner.
   */
  readonly lockTimeoutMs?: number;
  /**
   * Permit a group/world-accessible directory.
   *
   * Off by default: the data directory must be private, and refusing here is
   * cheaper than discovering a world-readable secret file later.
   */
  readonly allowPublicDirectory?: boolean;
}

const LOCK_FILE = "owner.lock";
const CLAIM_FILE = "owner.lock.claim";

/** Long enough to outlast another contender's initialization, short enough to fail fast. */
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

/**
 * A claim older than this is treated as a crashed contender and reclaimed.
 *
 * Initialization takes milliseconds; the bound only has to be far longer than
 * that, because the claim is a serializer and never the authority on ownership.
 */
const STALE_CLAIM_MS = 5_000;

export function acquireDataDirectoryOwnership(options: AcquireOwnershipOptions): DataDirectoryOwner {
  const dataDirectory = resolve(options.dataDirectory);
  const now = options.now ?? nowTimestamp;

  prepareDirectory(dataDirectory, options.allowPublicDirectory === true);

  const lockPath = join(dataDirectory, LOCK_FILE);
  const claimPath = join(dataDirectory, CLAIM_FILE);
  assertNotSymlink(lockPath);
  assertNotSymlink(claimPath);

  const db = claimExclusiveLock({
    dataDirectory,
    lockPath,
    claimPath,
    timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  });

  const acquiredAt = now();
  try {
    assertPreviousOwnerStopped(dataDirectory);
    db.exec("DELETE FROM tavi_owner");
    db.prepare("INSERT INTO tavi_owner (session_id, pid, acquired_at) VALUES (?, ?, ?)").run(options.sessionId, process.pid, acquiredAt);
    publishOwnerProcess(dataDirectory, options.sessionId);
  } catch (error) {
    releaseQuietly(db);
    if (error instanceof TaviError) throw error;
    throw new TaviError("INTERNAL", `Could not record ownership of ${dataDirectory}`, { cause: error });
  }

  let released = false;
  return {
    dataDirectory,
    lockPath,
    sessionId: options.sessionId,
    acquiredAt,
    get released(): boolean {
      return released;
    },
    release(): { readonly released: boolean; readonly error?: string } {
      if (released) return { released: true };
      released = true;
      let recordFailure: string | undefined;
      try {
        removeOwnerProcess(dataDirectory, options.sessionId);
      } catch (error) {
        recordFailure = describe(error);
      }
      const failure = releaseQuietly(db) ?? recordFailure;
      return failure === undefined ? { released: true } : { released: false, error: failure };
    },
  };
}

/**
 * Take the exclusive ownership lock.
 *
 * The exclusive transaction alone is not enough, and that is the subtle part:
 * two connections that have each read the database header hold a *shared* lock,
 * and SQLite refuses an upgrade to exclusive for both — immediately, without
 * consulting `busy_timeout`, because waiting cannot resolve that deadlock. With
 * four launchers racing, every one of them could therefore be refused and the
 * directory would be left owned by nobody. Measured before this change: 5 of 80
 * races on an already-initialized lock file, which is the ordinary restart case.
 *
 * The fix is a serializer in front of the upgrade: an atomically created claim
 * file (`open(..., "wx")`) that only one contender can hold, so only one
 * connection is ever inside the upgrade at a time. The claim is not the lock —
 * the SQLite transaction is — so a claim left behind by a crash is harmless: a
 * waiter that finds it stale reclaims it, and ownership is still decided by the
 * database lock.
 */
function claimExclusiveLock(options: {
  readonly dataDirectory: string;
  readonly lockPath: string;
  readonly claimPath: string;
  readonly timeoutMs: number;
}): ReturnType<ReturnType<typeof loadBetterSqlite3>> {
  const Database = loadBetterSqlite3();
  const deadline = Date.now() + options.timeoutMs;
  let delayMs = 5;

  for (;;) {
    let claim: number | undefined;
    try {
      claim = openSync(options.claimPath, "wx", 0o600);
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }

    if (claim !== undefined) {
      try {
        // Serialized: no other contender can be mid-upgrade, so a busy database
        // is either a live owner or a lock a just-failed contender released. A
        // short bounded retry distinguishes the two.
        return attemptExclusive(Database, options);
      } finally {
        closeSync(claim);
        try {
          unlinkSync(options.claimPath);
        } catch {
          // Another contender reclaimed a stale claim first; nothing to undo.
        }
      }
    }

    // Someone else is initializing. Wait, and reclaim the claim if its holder
    // never finished (a crash between claiming and locking).
    if (Date.now() >= deadline) {
      // The authority is the database lock, not the claim: an unheld lock means
      // the claim is stale, and the caller may try again.
      throw new TaviError(
        "CONFLICT",
        `Data directory ${options.dataDirectory} is already owned by another process ` +
          "(or another launcher is still acquiring it). One process owns a data directory and its " +
          "scheduler; stop the other owner or use a different --data-dir.",
        { details: { dataDirectory: options.dataDirectory, lockPath: options.lockPath } },
      );
    }
    if (claimIsStale(options.claimPath)) {
      try {
        unlinkSync(options.claimPath);
      } catch {
        // Another waiter won the reclaim; keep waiting.
      }
    }
    sleepSync(delayMs);
    delayMs = Math.min(delayMs * 2, 40);
  }
}

/**
 * One upgrade attempt; a bounded retry absorbs a lock released by a failed peer.
 *
 * The retry is bounded twice: by an attempt budget, and by the caller's lock
 * timeout measured from when this contender took the claim. The timeout bound is
 * what lets a probe (`lockTimeoutMs: 0`) fail fast: it makes exactly one attempt
 * and reports a live owner in milliseconds, instead of spending the whole budget —
 * about a second — confirming what the first attempt already showed. At the
 * default timeout the attempt budget is the tighter bound, so an acquisition keeps
 * its full retry. The window starts at the claim rather than at the caller's
 * start, so a contender that queued behind another's claim still gets all of it.
 */
function attemptExclusive(
  Database: ReturnType<typeof loadBetterSqlite3>,
  options: { readonly dataDirectory: string; readonly lockPath: string; readonly timeoutMs: number },
): ReturnType<ReturnType<typeof loadBetterSqlite3>> {
  const attempts = 40;
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let db: ReturnType<typeof Database> | undefined;
    try {
      db = new Database(options.lockPath);
      db.pragma("busy_timeout = 0");
      // Exclusive locking mode plus an exclusive transaction takes the OS lock
      // and holds it until this process releases it or dies.
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("CREATE TABLE IF NOT EXISTS tavi_owner (session_id TEXT NOT NULL, pid INTEGER NOT NULL, acquired_at TEXT NOT NULL)");
      return db;
    } catch (error) {
      db?.close();
      lastError = error;
      const code = (error as { code?: string }).code ?? "";
      if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") {
        throw new TaviError(
          "INTERNAL",
          `Could not take ownership of ${options.dataDirectory}: the ownership file ` +
            `${options.lockPath} could not be locked (${describe(error)}). It is probably corrupt ` +
            "or on a read-only filesystem; move it aside to recover.",
          { details: { dataDirectory: options.dataDirectory, lockPath: options.lockPath } },
        );
      }
      // A live owner keeps the lock for its lifetime, so this only helps a
      // transient failure; a live owner exhausts the budget and is reported.
      const remainingMs = deadline - Date.now();
      if (attempt === attempts - 1 || remainingMs <= 0) break;
      sleepSync(Math.min(2 + attempt, remainingMs));
    }
  }
  throw new TaviError(
    "CONFLICT",
    `Data directory ${options.dataDirectory} is already owned by another process. ` +
      "One process owns a data directory and its scheduler; stop the other owner " +
      "or use a different --data-dir.",
    { details: { dataDirectory: options.dataDirectory, lockPath: options.lockPath, cause: describe(lastError) } },
  );
}

/** Whether a claim file is older than the initialization bound. */
function claimIsStale(claimPath: string): boolean {
  try {
    return Date.now() - statSync(claimPath).mtimeMs > STALE_CLAIM_MS;
  } catch {
    return false;
  }
}

/**
 * Block for a few milliseconds.
 *
 * Ownership acquisition is synchronous and only waits under contention; blocking
 * the thread for a bounded interval is what keeps a race from being resolved by
 * chance instead of by the lock.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Prepare the data directory.
 *
 * A directory that does not exist is created privately at creation (0700; on
 * Windows a protected access list everything inside inherits), never created
 * publicly and fixed afterwards, and an existing one is verified rather than
 * assumed safe.
 */
function prepareDirectory(dataDirectory: string, allowPublic: boolean): void {
  assertLocalFilesystem(dataDirectory);
  if (!existsSync(dataDirectory)) makePrivateDirectory(dataDirectory);
  const stats = statSync(dataDirectory);
  if (!stats.isDirectory()) {
    throw new TaviError("INVALID_INPUT", `${dataDirectory} exists and is not a directory`);
  }
  const shared = allowPublic ? undefined : privacyProblem(dataDirectory, stats);
  if (shared !== undefined) {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `Data directory ${dataDirectory} is accessible to other users (${shared}); ` +
        `expected a private directory. Run: ${privateRemedy(dataDirectory, "directory")}`,
      { details: { mode: (stats.mode & 0o777).toString(8) } },
    );
  }
  // The operator explicitly accepted a reachable directory (a service-managed
  // directory with its own ACLs, for instance); do not override that choice.
  // Windows has no mode to set: the access list checked above is the boundary there.
  if (allowPublic || process.platform === "win32") return;
  try {
    chmodSync(dataDirectory, 0o700);
  } catch {
    // Best effort: the permission check above already refused an unsafe directory.
  }
}

/**
 * Refuse a symlinked lock file, which could redirect ownership elsewhere.
 *
 * `lstat` is used rather than `existsSync`, because a *dangling* symlink reports
 * as non-existent while still redirecting the file that SQLite would create.
 */
function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new TaviError("INVALID_INPUT", `Refusing a symlinked ownership file at ${path}`);
    }
  } catch (error) {
    if (error instanceof TaviError) throw error;
    // ENOENT is the expected case: there is no lock file yet.
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

/** Release the lock, reporting the first failure rather than swallowing it. */
function releaseQuietly(db: ReturnType<ReturnType<typeof loadBetterSqlite3>> | undefined): string | undefined {
  if (db === undefined) return undefined;
  let failure: string | undefined;
  try {
    db.exec("COMMIT");
  } catch (error) {
    // The transaction may already be gone; closing the handle releases the lock.
    failure = describe(error);
  }
  try {
    db.close();
  } catch (error) {
    failure ??= describe(error);
  }
  return failure;
}

function describe(error: unknown): string {
  return errorMessage(error);
}
