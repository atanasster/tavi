import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { IPC_PROTOCOL_VERSION } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { acquireDataDirectoryOwnership, ipcPaths, mintToken, publishDiscovery, readDiscovery, readToken } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectLiveOwner } from "../../src/cli/owner-connection.js";
import { EXIT, main } from "../../src/main.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/** Ownership probes an attached command started: each is a worker, the cost the connect-first path avoids. */
const probes = vi.hoisted(() => ({ count: 0 }));
vi.mock("@tavi/runtime/owner-attach", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tavi/runtime/owner-attach")>();
  return {
    ...actual,
    acquireDataDirectoryOwnership: (options: Parameters<typeof actual.acquireDataDirectoryOwnership>[0]) => {
      probes.count += 1;
      return actual.acquireDataDirectoryOwnership(options);
    },
  };
});

/**
 * Stale IPC discovery after a crash.
 *
 * The owner removes `runtime/ipc.{json,sock,token}` only on a **clean** shutdown.
 * A SIGKILL or a power loss leaves all three behind while the OS has already
 * released `owner.lock` — and the CLI trusted the leftovers, failed to connect,
 * and reported "An owner is running … did not answer" for a process that was
 * dead. `tavi tasks` and `tavi doctor` then exited 4 until someone deleted three
 * undocumented files by hand, which is the worst possible recovery path for the
 * two commands an operator reaches for when something has gone wrong.
 */

const directories = temporaryDirectories({ prefix: "tavi-stale-discovery-" });

const handles: ServeHandle[] = [];

beforeEach(() => {
  probes.count = 0;
});

afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

async function startOwner(directory: string): Promise<ServeHandle> {
  const handle = await serve(
    fixtureServeOptions(directory),
    { dataDirectory: directory, drainDeadlineMs: 2_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  return handle;
}

/**
 * Leave a socket file behind exactly as a SIGKILLed owner does: a child binds
 * it and is killed without a graceful close, so Node never unlinks it.
 */
async function leaveStaleSocket(endpoint: string): Promise<void> {
  const script =
    'const net = require("node:net");' +
    "const server = net.createServer();" +
    `server.listen(${JSON.stringify(endpoint)}, () => process.stdout.write("bound"));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("bound")) resolve();
    });
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await once(child, "exit");
}

/** Leave exactly what a killed owner leaves: the three discovery files, no lock holder. */
async function leaveCrashedOwnerDiscovery(directory: string): Promise<void> {
  const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "crashed-owner", lockTimeoutMs: 0 });
  const proof = { dataDirectory: directory, sessionId: owner.sessionId, released: owner.released };
  publishDiscovery(
    directory,
    {
      protocolVersion: IPC_PROTOCOL_VERSION,
      sessionId: "crashed-owner",
      endpoint: join(directory, "runtime", "ipc.sock"),
      pid: 999_999,
      startedAt: nowTimestamp(),
    },
    proof,
  );
  mintToken(directory, proof);
  // The crash: the lock is released (the OS does this for a killed process) but
  // the discovery files are never cleaned up.
  owner.release();
}

describe("stale owner discovery", () => {
  it("treats a dead owner's discovery files as stale and serves the command", async () => {
    const directory = directories.create();
    await leaveCrashedOwnerDiscovery(directory);

    const listed = capture();
    expect(await main(["tasks", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    // The false refusal is what this fix removes: the process is dead, and the
    // remedy is not "stop it".
    expect(listed.stderr()).not.toMatch(/owner is running/);
    // The connection failed, so the probe ran, found the lock free and tidied up.
    expect(probes.count).toBe(1);
    expect(readDiscovery(directory)).toBeUndefined();
  });

  it("serves doctor too, which is the other command the refusal locked out", async () => {
    const directory = directories.create();
    await leaveCrashedOwnerDiscovery(directory);

    const report = capture();
    expect(await main(["doctor", "--data-dir", directory], { io: report.io }), report.stderr()).toBe(EXIT.ok);
    expect(report.stdout()).toContain("buildId");
    expect(report.stderr()).not.toMatch(/owner is running/);
  });

  it("still refuses while a live owner holds the lock", async () => {
    // The probe must not turn "the owner is alive but its socket is broken" into
    // "nobody is here": that would let a second writer open the database.
    const directory = directories.create();
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "live-owner", lockTimeoutMs: 0 });
    try {
      const proof = { dataDirectory: directory, sessionId: owner.sessionId, released: owner.released };
      publishDiscovery(
        directory,
        {
          protocolVersion: IPC_PROTOCOL_VERSION,
          sessionId: "live-owner",
          endpoint: join(directory, "runtime", "ipc.sock"),
          pid: process.pid,
          startedAt: nowTimestamp(),
        },
        proof,
      );
      mintToken(directory, proof);

      const refused = capture();
      // Exit 4 with the "did not answer" message: the owner is holding the lock
      // but no socket is listening, which is a real problem and a different
      // answer from the stale case above.
      expect(await main(["tasks", "--data-dir", directory], { io: refused.io })).toBe(EXIT.unavailable);
      expect(refused.stderr()).toMatch(/did not answer/);
      expect(probes.count).toBe(1);
      // And the live owner's credentials are untouched. The first version of this
      // fix probed the lock, released it, and only then deleted the files — so a
      // different owner that acquired and published in that window had its
      // credentials deleted by a command that was merely listing tasks.
      expect(readDiscovery(directory)).toBeDefined();
      expect(readToken(directory)).toBeDefined();
    } finally {
      owner.release();
    }
  });

  it("treats a dead owner's discovery as stale when its socket file is left too", async () => {
    // The connection is refused outright rather than finding no socket: the probe
    // still decides, and the command still falls back to the database.
    const directory = directories.create();
    await leaveCrashedOwnerDiscovery(directory);
    await leaveStaleSocket(ipcPaths(directory).socketPath);
    expect(existsSync(ipcPaths(directory).socketPath)).toBe(true);

    const listed = capture();
    expect(await main(["tasks", "--data-dir", directory], { io: listed.io }), listed.stderr()).toBe(EXIT.ok);
    expect(listed.stderr()).not.toMatch(/owner is running/);
    expect(probes.count).toBe(1);
    expect(readDiscovery(directory)).toBeUndefined();
  });
});

describe("attaching to a live owner", () => {
  it("connects without the ownership probe when the published owner answers", async () => {
    const directory = directories.create();
    await startOwner(directory);

    const listed = capture();
    expect(await main(["tasks", "--data-dir", directory], { io: listed.io }), listed.stderr()).toBe(EXIT.ok);
    const client = await connectLiveOwner(directory, ["tasks"]);
    expect(client).toBeDefined();
    client?.close();
    expect(probes.count).toBe(0);
  });

  it("connects without the probe through a symlink to the data directory", async () => {
    const directory = directories.create();
    await startOwner(directory);
    const link = join(directories.create(), "linked-data");
    symlinkSync(directory, link);

    const client = await connectLiveOwner(link, ["tasks"]);
    expect(client).toBeDefined();
    client?.close();
    expect(probes.count).toBe(0);
  });

  it("does not trust a record that names another directory's owner", async () => {
    // A copied data directory keeps its original's discovery and cookie, which a
    // live owner elsewhere would accept: the copy must not be served by it, so the
    // record goes to the probe, which finds the copy's lock free.
    const original = directories.create();
    const handle = await startOwner(original);
    const copy = directories.create();
    const from = ipcPaths(original);
    const to = ipcPaths(copy);
    mkdirSync(to.directory, { recursive: true, mode: 0o700 });
    copyFileSync(from.discoveryPath, to.discoveryPath);
    copyFileSync(from.tokenPath, to.tokenPath);
    chmodSync(to.tokenPath, 0o600);

    const listed = capture();
    expect(await main(["tasks", "--data-dir", copy], { io: listed.io }), listed.stderr()).toBe(EXIT.ok);
    expect(probes.count).toBe(1);
    expect(readDiscovery(copy)).toBeUndefined();
    // The original owner is untouched and still published.
    expect(readDiscovery(original)?.sessionId).toBe(handle.runtime.ownerSession);
  });

  it("reports a refused cookie once, without presenting it a second time", async () => {
    const directory = directories.create();
    const handle = await startOwner(directory);
    writeFileSync(ipcPaths(directory).tokenPath, "not-the-cookie", { mode: 0o600 });

    const refused = capture();
    expect(await main(["tasks", "--data-dir", directory], { io: refused.io })).toBe(EXIT.unavailable);
    expect(refused.stderr()).toMatch(/did not answer/);
    // The probe confirmed the owner holds the lock, so the refusal stands as it
    // was, and the owner saw the wrong cookie exactly once.
    expect(probes.count).toBe(1);
    expect(handle.server.authFailures()).toBe(1);
    expect(readDiscovery(directory)).toBeDefined();
  });
});
