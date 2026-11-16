import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, lstatSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createIpcClient, readDiscovery, readToken } from "@tavi/runtime";
import { delay, needsPosix, temporaryDirectories } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXIT } from "../../src/main.js";

/** Windows skips this file's POSIX cases (`POSIX_ONLY` says why). */
const posixOnly = needsPosix(import.meta.url);

/**
 * Acceptance fixtures for a single owner and crash restart.
 *
 * These run the **built** binary in real processes, because the properties under
 * test are properties of a process, not of a function: two launchers racing for
 * one data directory, a `SIGKILL` that leaves an endpoint behind, a cookie that
 * must not survive into a successor owner, and the modes that stop another
 * account from substituting the endpoint. An in-process test cannot fail the way
 * a killed process fails.
 *
 * Skipped on Windows, where `tavi serve` is designed to refuse, so the
 * platform gap is reported explicitly instead of by five failures.
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const executable = join(repositoryRoot, "apps", "cli", "dist", "executable.mjs");

/** A child with piped stdout/stderr and no stdin, which is all these fixtures need. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

const directories = temporaryDirectories({ prefix: "tavi-accept-" });
const children: PipedChild[] = [];

beforeAll(() => {
  execFileSync(process.execPath, [join(repositoryRoot, "scripts", "pnpmw.mjs"), "run", "build"], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
}, 600_000);

afterAll(async () => {
  while (children.length > 0) {
    const child = children.pop();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  directories.cleanup();
});

interface Launcher {
  readonly child: PipedChild;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  stdout(): string;
  stderr(): string;
}

function track(child: PipedChild): Launcher {
  children.push(child);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((settle) => {
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
  return { child, exited, stdout: () => out, stderr: () => err };
}

function launchServe(directory: string): Launcher {
  return track(
    spawn(process.execPath, [executable, "serve", "--data-dir", directory], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: repositoryRoot,
    }),
  );
}

/** Launch any CLI command as a tracked child, so `afterAll` can never leak one. */
function launchCli(args: readonly string[]): Launcher {
  return track(
    spawn(process.execPath, [executable, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: repositoryRoot,
    }),
  );
}

type LauncherOutcome =
  | { readonly kind: "serving" }
  | { readonly kind: "exited"; readonly code: number | null; readonly signal: string | null };

/**
 * Wait for a launcher's real terminal state.
 *
 * Polling for "serving or exited" replaces a fixed "has it exited yet?" sleep, so
 * a slow machine cannot misclassify a loser as a second owner.
 */
async function outcomeOf(launcher: Launcher, timeoutMs = 30_000): Promise<LauncherOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (launcher.stdout().includes('"serving"')) return { kind: "serving" };
    if (launcher.child.exitCode !== null || launcher.child.signalCode !== null) {
      return { kind: "exited", code: launcher.child.exitCode, signal: launcher.child.signalCode };
    }
    if (Date.now() > deadline) {
      throw new Error(`launcher did not settle within ${timeoutMs}ms: ${launcher.stderr()}`);
    }
    await delay(25);
  }
}

/** Wait until a launcher has published discovery, or fail with its own output. */
async function waitForServing(launcher: Launcher, timeoutMs = 15_000): Promise<void> {
  const outcome = await outcomeOf(launcher, timeoutMs);
  if (outcome.kind !== "serving") {
    throw new Error(`owner exited before serving (code ${outcome.code}, signal ${outcome.signal}): ${launcher.stderr()}`);
  }
}

function describeLaunchers(
  pairs: readonly { readonly launcher: Launcher; readonly outcome: LauncherOutcome }[],
  directory: string,
): string {
  const recorded = readRecordedOwner(directory);
  return `${pairs
    .map(
      ({ launcher, outcome }, index) =>
        `#${index} ${outcome.kind} code=${outcome.kind === "exited" ? String(outcome.code) : "-"} ` +
        `stderr=${JSON.stringify(launcher.stderr().slice(0, 200))}`,
    )
    .join("; ")}; recorded owner=${recorded}`;
}

/**
 * The owner recorded in `owner.lock`, for failure diagnostics.
 *
 * A run where no launcher reports "serving" must say who actually held the
 * directory — otherwise the only evidence is three refusals and a guess.
 */
function readRecordedOwner(directory: string): string {
  const path = join(directory, "owner.lock");
  if (!existsSync(path)) return "no lock file (nobody ever acquired)";
  const bytes = statSync(path).size;
  try {
    // Read-only, so this cannot be mistaken for taking the lock. A live owner
    // holds its transaction open, so its `tavi_owner` row is uncommitted and
    // invisible here — that is the expected state while an owner runs.
    const Database = createRequire(import.meta.url)("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(path, { readonly: true });
    try {
      const row = db.prepare("SELECT session_id, pid, acquired_at FROM tavi_owner").get() as
        | { session_id?: string; pid?: number }
        | undefined;
      return row === undefined ? `lock file ${bytes}B with no committed owner` : `${row.session_id} pid=${String(row.pid)}`;
    } finally {
      db.close();
    }
  } catch (error) {
    return `lock file ${bytes}B, owner unreadable (${String(error)})`;
  }
}

describe.skipIf(posixOnly)("acceptance: single owner and crash restart", () => {
  it("admits exactly one of four simultaneous launchers", async () => {
    const directory = directories.create();
    const launchers = [launchServe(directory), launchServe(directory), launchServe(directory), launchServe(directory)];
    const pairs = await Promise.all(launchers.map(async (launcher) => ({ launcher, outcome: await outcomeOf(launcher) })));
    const owners = pairs.filter(({ outcome }) => outcome.kind === "serving");
    const losers = pairs.filter(({ outcome }) => outcome.kind === "exited");

    // A data directory has one owner; the other three are refused, not queued.
    expect(owners, describeLaunchers(pairs, directory)).toHaveLength(1);
    expect(losers, describeLaunchers(pairs, directory)).toHaveLength(3);
    for (const { launcher, outcome } of losers) {
      if (outcome.kind !== "exited") throw new Error("unreachable");
      // A signal death is not a design refusal, so it must not count as a loser.
      expect(outcome.signal).toBeNull();
      expect(outcome.code).toBe(EXIT.alreadyOwned);
      // Refused by the lock itself, or in the CLI's own wording, naming the holder once its record is up.
      expect(launcher.stderr()).toMatch(
        /already owned by another process|(`tavi serve` \(pid \d+\)|Another (tavi command \(pid \d+\)|process)) already owns/,
      );
    }

    const owner = owners[0];
    if (owner === undefined) throw new Error("no owner");
    owner.launcher.child.kill("SIGTERM");
    const exit = await owner.launcher.exited;
    expect(exit.code).toBe(0);
    // A clean stop removes the endpoint, the cookie and the discovery record.
    expect(existsSync(join(directory, "runtime", "ipc.sock"))).toBe(false);
    expect(existsSync(join(directory, "runtime", "ipc.token"))).toBe(false);
    expect(existsSync(join(directory, "runtime", "ipc.json"))).toBe(false);
    expect(readDiscovery(directory)).toBeUndefined();
  }, 90_000);

  it("resolves a repeated launcher race to exactly one owner each time", async () => {
    // The single-owner gate must hold every time, not usually: a race that leaves
    // the directory owned by nobody is the failure mode this pins (the ownership
    // lock is taken before its schema is created, with a bounded wait).
    for (let round = 1; round <= 3; round += 1) {
      const directory = directories.create();
      const launchers = [launchServe(directory), launchServe(directory), launchServe(directory), launchServe(directory)];
      const pairs = await Promise.all(launchers.map(async (launcher) => ({ launcher, outcome: await outcomeOf(launcher) })));
      const owners = pairs.filter(({ outcome }) => outcome.kind === "serving");
      const losers = pairs.filter(({ outcome }) => outcome.kind === "exited");
      expect(owners, `round ${round}: ${describeLaunchers(pairs, directory)}`).toHaveLength(1);
      expect(losers, `round ${round}: ${describeLaunchers(pairs, directory)}`).toHaveLength(3);
      for (const { launcher, outcome } of losers) {
        if (outcome.kind !== "exited") throw new Error("unreachable");
        expect(outcome.code).toBe(EXIT.alreadyOwned);
        // Refused by the lock itself, or in the CLI's own wording, naming the holder once its record is up.
        expect(launcher.stderr()).toMatch(
          /already owned by another process|(`tavi serve` \(pid \d+\)|Another (tavi command \(pid \d+\)|process)) already owns/,
        );
      }
      const owner = owners[0];
      if (owner === undefined) throw new Error("no owner");
      owner.launcher.child.kill("SIGTERM");
      expect((await owner.launcher.exited).code).toBe(0);
    }
  }, 120_000);

  it("restarts after SIGKILL over the stale socket and rotates the cookie", async () => {
    const directory = directories.create();
    const first = launchServe(directory);
    await waitForServing(first);
    const staleToken = readToken(directory);
    if (staleToken === undefined) throw new Error("owner minted no cookie");
    const endpoint = join(directory, "runtime", "ipc.sock");
    expect(lstatSync(endpoint).isSocket()).toBe(true);

    // A hard kill runs none of the shutdown path, so the socket file remains.
    first.child.kill("SIGKILL");
    await first.exited;
    expect(existsSync(endpoint)).toBe(true);

    const second = launchServe(directory);
    // The service manager's restart must not need a human to delete the artifact.
    await waitForServing(second);
    const rotated = readToken(directory);
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(staleToken);

    // The predecessor's cookie is not a key to the successor.
    const discovery = readDiscovery(directory);
    if (discovery === undefined) throw new Error("successor published no discovery");
    await expect(
      createIpcClient({
        endpoint: discovery.endpoint,
        sessionId: discovery.sessionId,
        token: staleToken,
      }),
    ).rejects.toThrowError();

    second.child.kill("SIGTERM");
    expect((await second.exited).code).toBe(0);
  }, 60_000);

  it("refuses a data directory other accounts can read", async () => {
    const directory = directories.create("tavi-accept-open-");
    chmodSync(directory, 0o755);
    const launcher = launchServe(directory);
    const exit = await launcher.exited;
    // The endpoint, cookie and database live under this directory, so a
    // group/world-accessible directory is refused before anything is minted.
    expect(exit.code).not.toBe(0);
    expect(launcher.stderr()).toContain("accessible to other users");
    expect(existsSync(join(directory, "runtime", "ipc.token"))).toBe(false);
  }, 60_000);

  it("creates the endpoint and credentials with private modes", async () => {
    const directory = directories.create();
    const launcher = launchServe(directory);
    await waitForServing(launcher);
    // Only the owning account may rebind the endpoint path, which is what makes
    // a same-account trust boundary meaningful. The data
    // directory's own mode is set by this fixture; the modes asserted of
    // `runtime/` and its files are the product's.
    const runtimeDirectory = join(directory, "runtime");
    expect(lstatSync(runtimeDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(runtimeDirectory, "ipc.sock")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(runtimeDirectory, "ipc.token")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(runtimeDirectory, "ipc.json")).mode & 0o777).toBe(0o600);
    launcher.child.kill("SIGTERM");
    await launcher.exited;
  }, 60_000);

  it("drains on SIGHUP (its terminal closing) as on SIGTERM, leaving nothing behind", async () => {
    const directory = directories.create();
    const launcher = launchServe(directory);
    await waitForServing(launcher);
    launcher.child.kill("SIGHUP");
    const exit = await launcher.exited;
    expect(exit.code, launcher.stderr()).toBe(0);
    expect(launcher.stderr()).toMatch(/shutting down: received SIGHUP/);
    expect(existsSync(join(directory, "runtime", "ipc.json"))).toBe(false);
    expect(readDiscovery(directory)).toBeUndefined();
  }, 60_000);

  it("treats a killed owner's discovery record as stale and serves the command", async () => {
    const directory = directories.create();
    const launcher = launchServe(directory);
    await waitForServing(launcher);
    // Stop the owner without letting it clean up, then leave its discovery in
    // place: a client must not treat "discovery exists" as "an owner is there".
    launcher.child.kill("SIGKILL");
    await launcher.exited;
    // The stale record and the stale socket file are both still on disk.
    expect(readDiscovery(directory)).toBeDefined();

    const probe = launchCli(["tasks", "--data-dir", directory]);
    const exit = await probe.exited;
    // The contract changed here, deliberately. The
    // SIGKILL left the discovery files behind but the OS released `owner.lock`,
    // so no owner exists — and refusing then made `tavi tasks` and `tavi doctor`
    // exit 4 with a false "An owner is running … did not answer" until someone
    // deleted three undocumented files by hand, which is the opposite of what
    // the two commands an operator reaches for after a crash should do. The
    // lock is now probed: free means the leftovers are cleared and the command
    // proceeds (it still takes the lock before opening the database itself).
    expect(exit.code, probe.stderr()).toBe(EXIT.ok);
    expect(probe.stderr()).not.toContain("An owner is running");
    expect(probe.stderr()).not.toContain("Refusing to open its database directly");
    // The stale record is gone, so the next command starts from a clean state
    // rather than repeating the probe.
    expect(readDiscovery(directory)).toBeUndefined();
  }, 60_000);
});

describe("the built executable", () => {
  it("exits quietly when its reader closes the pipe early (`tavi --help | head`)", async () => {
    const child = spawn(process.execPath, [executable, "--help"], { stdio: ["ignore", "pipe", "pipe"], cwd: repositoryRoot });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    // Close the read end before anything is printed, so the first write meets a closed pipe
    // whatever the help's length.
    child.stdout.destroy();
    const code = await new Promise<number | null>((settle) => child.on("close", (exitCode) => settle(exitCode)));
    expect(stderr).not.toContain("EPIPE");
    expect(code).toBe(0);
  }, 30_000);
});
