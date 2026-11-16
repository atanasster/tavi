import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaviError } from "@tavi/contracts";
import { acquireDataDirectoryOwnership } from "@tavi/runtime";

import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { assertLocalFilesystem } from "../src/persistence/local-filesystem.js";
import { acquireDataDirectoryOwnership as acquireNativeOwnership } from "../src/persistence/ownership.js";

const directories = temporaryDirectories({ prefix: "tavi-owner-", mode: 0o700 });

afterEach(() => {
  directories.cleanup();
});

interface LockHolder {
  readonly child: ChildProcessWithoutNullStreams;
  /** Ask the child to release the lock after `delayMs`, staying alive. */
  releaseAfter(delayMs: number): Promise<void>;
}

/**
 * Hold `lockPath` from another process, the way an owner does.
 *
 * The child takes the same OS lock the owner takes and holds it until told to
 * release it — a peer that gives the lock up while alive — or until it is killed.
 */
async function holdLockInChild(lockPath: string): Promise<LockHolder> {
  const betterSqlite3 = require.resolve("better-sqlite3", {
    paths: [join(process.cwd(), "packages/runtime")],
  });
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const D = require(${JSON.stringify(betterSqlite3)});` +
        `const db = new D(${JSON.stringify(lockPath)});` +
        `db.pragma("locking_mode = EXCLUSIVE");` +
        `db.exec("CREATE TABLE IF NOT EXISTS t (a)");` +
        `db.exec("BEGIN EXCLUSIVE");` +
        `process.stdin.once("data", (chunk) => setTimeout(() => db.close(), Number(String(chunk))));` +
        `process.stdout.write("HELD\\n");` +
        `setInterval(() => {}, 1000);`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  // Wait until the child actually holds the lock.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child never acquired the lock")), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("HELD")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  return {
    child,
    releaseAfter: (delayMs) =>
      // Resolved once the request is in the pipe, so a caller that then blocks
      // synchronously on the lock cannot hold back its own release.
      new Promise<void>((resolve, reject) => {
        child.stdin.write(`${delayMs}\n`, (error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("exclusive data-directory ownership", () => {
  it("grants ownership to the first process and records it", async () => {
    const directory = directories.create();
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-a" });
    expect(owner.sessionId).toBe("session-a");
    expect(owner.dataDirectory).toBe(directory);
    await owner.release();
  });

  it("refuses a second owner while the first holds the directory", async () => {
    const directory = directories.create();
    const first = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-a" });
    // One process owns a data directory and its scheduler.
    await expect(
      (async () => await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-b" }))(),
    ).rejects.toThrowError(/already owned by another process/);
    await first.release();
  });

  it("allows a new owner after the first releases", async () => {
    const directory = directories.create();
    const first = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-a" });
    await first.release();
    const second = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-b" });
    expect(second.sessionId).toBe("session-b");
    await second.release();
  });

  it("releases on crash, so a dead owner does not wedge the directory", async () => {
    const directory = directories.create();
    // The claim under test is that the *operating system* drops the advisory lock
    // when the owner dies — something a PID file cannot do.
    const { child } = await holdLockInChild(join(directory, "owner.lock"));

    // While it is alive, a second owner is refused.
    await expect(
      (async () => await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "while-alive" }))(),
    ).rejects.toThrowError(/already owned by another process/);

    // Kill it without any chance to clean up: this is the crash case.
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "after-crash" });
    expect(owner.sessionId).toBe("after-crash");
    await owner.release();
  }, 30_000);

  it("fails a zero-timeout probe fast against a held lock, and still takes a free one", async () => {
    const directory = directories.create();
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-a" });
    try {
      await expect(
        (async () => await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "probe", lockTimeoutMs: 0 }))(),
      ).rejects.toThrowError(/already owned by another process/);
    } finally {
      await owner.release();
    }

    // Failing fast is not refusing: once the lock is free, the probe takes it.
    const probe = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "probe", lockTimeoutMs: 0 });
    expect(probe.sessionId).toBe("probe");
    await probe.release();
  });

  it("never sleeps or retries a zero-timeout native ownership probe", () => {
    const directory = directories.create();
    const owner = acquireNativeOwnership({ dataDirectory: directory, sessionId: "native-owner" });
    // Assert the lock algorithm directly: worker startup time is unrelated to
    // the lock timeout. A retry must fail this test even on a fast machine.
    const wait = vi.spyOn(Atomics, "wait");
    try {
      expect(() => acquireNativeOwnership({ dataDirectory: directory, sessionId: "probe", lockTimeoutMs: 0 })).toThrowError(
        /already owned by another process/,
      );
      expect(wait).not.toHaveBeenCalled();
    } finally {
      wait.mockRestore();
      owner.release();
    }
  });

  it("keeps the retry that absorbs a lock a peer releases moments later", async () => {
    const directory = directories.create();
    const holder = await holdLockInChild(join(directory, "owner.lock"));
    try {
      // Across processes too, a zero-timeout probe refuses the held lock.
      await expect(
        (async () => await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "probe", lockTimeoutMs: 0 }))(),
      ).rejects.toThrowError(/already owned by another process/);

      // ...while an acquisition at the default timeout still outlasts a peer that
      // gives the lock up mid-attempt: the case the bounded retry exists for.
      await holder.releaseAfter(100);
      const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "successor" });
      expect(owner.sessionId).toBe("successor");
      await owner.release();
    } finally {
      holder.child.kill("SIGKILL");
    }
  }, 30_000);

  it("creates a missing directory privately rather than publicly then chmodding", async () => {
    const parent = directories.create();
    const target = join(parent, "nested", "data");
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: target, sessionId: "session-a" });
    const mode = (statSync(target).mode & 0o777).toString(8);
    expect(mode).toBe("700");
    await owner.release();
  });

  it("refuses a directory other users can reach", async () => {
    const directory = directories.create("tavi-owner-", { mode: 0o755 });
    await expect(
      (async () => await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-a" }))(),
    ).rejects.toThrowError(/accessible to other users/);
    // The message must say how to fix it.
    await expect(
      (async () => await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-a" }))(),
    ).rejects.toThrowError(/chmod 700/);
  });

  it("allows a public directory only when explicitly permitted", async () => {
    const directory = directories.create("tavi-owner-", { mode: 0o755 });
    const owner = await acquireDataDirectoryOwnership({
      dataDirectory: directory,
      sessionId: "session-a",
      allowPublicDirectory: true,
    });
    expect(owner.sessionId).toBe("session-a");
    await owner.release();
  });

  it("refuses a symlinked ownership file", async () => {
    const directory = directories.create();
    const elsewhere = directories.create();
    symlinkSync(join(elsewhere, "target.lock"), join(directory, "owner.lock"));
    await expect(
      (async () => await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-a" }))(),
    ).rejects.toThrowError(/symlinked ownership file/);
  });

  it("refuses a data directory on a 9p mount (a Windows drive under WSL) before creating it, on Linux only", () => {
    const parent = directories.create();
    const target = join(parent, "missing", "data");
    const looked: string[] = [];
    const ninePee = (path: string) => {
      looked.push(path);
      return { type: 0x01021997 };
    };
    expect(() => assertLocalFilesystem(target, { platform: "linux", statfs: ninePee })).toThrowError(/Linux filesystem/);
    // The nearest folder that exists is the one asked about; nothing was created.
    expect(looked).toEqual([parent]);
    expect(() => assertLocalFilesystem(target, { platform: "linux", statfs: () => ({ type: 0xef53 }) })).not.toThrow();
    expect(() => assertLocalFilesystem(target, { platform: "darwin", statfs: ninePee })).not.toThrow();
  });

  it("refuses a path that is not a directory", async () => {
    const directory = directories.create();
    const file = join(directory, "not-a-dir");
    writeFileSync(file, "x");
    await expect((async () => await acquireDataDirectoryOwnership({ dataDirectory: file, sessionId: "session-a" }))()).rejects.toThrowError(
      TaviError,
    );
  });
});

describe("ownership failure modes", () => {
  it("reports a corrupt ownership file as a failure to lock, not as another owner", async () => {
    const directory = directories.create();
    // A file that is not a database: SQLite cannot open it, and nobody holds it.
    writeFileSync(join(directory, "owner.lock"), "this is not a sqlite database at all");
    // Telling the operator to stop a process that does not exist would wedge the
    // directory permanently with advice that cannot work.
    await expect(
      (async () => await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-a" }))(),
    ).rejects.toThrowError(/could not be locked/);
    expect(async () => await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-a" })).not.toThrowError(
      /already owned by another process/,
    );
  });

  it("reports a release failure instead of swallowing it", async () => {
    const directory = directories.create();
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "session-a" });
    expect(await owner.release()).toEqual({ released: true });
    // Releasing twice is a no-op, not an error.
    expect(await owner.release()).toEqual({ released: true });
  });

  it("does not chmod a directory the caller explicitly allowed to be public", async () => {
    const directory = directories.create("tavi-owner-", { mode: 0o755 });
    const owner = await acquireDataDirectoryOwnership({
      dataDirectory: directory,
      sessionId: "session-a",
      allowPublicDirectory: true,
    });
    // The flag means "leave it alone", not "quietly tighten it".
    expect(statSync(directory).mode & 0o777).toBe(0o755);
    await owner.release();
  });
});
