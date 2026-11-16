import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { AsyncDataDirectoryOwner } from "../src/persistence/ownership-client.js";
import { acquireDataDirectoryOwnership } from "../src/persistence/ownership.js";
import { OWNER_PROCESS_FILE } from "../src/persistence/owner-process.js";
import { machineIdentity } from "../src/persistence/machine-identity.js";
import { mintToken } from "../src/ipc/credentials.js";

const directories = temporaryDirectories();
const owners: AsyncDataDirectoryOwner[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.release()));
  directories.cleanup();
});

function directory(): string {
  return directories.create("tavi-owner-worker-");
}

async function acquire(dataDirectory: string, sessionId: string): Promise<AsyncDataDirectoryOwner> {
  const owner = await AsyncDataDirectoryOwner.acquire({ dataDirectory, sessionId, lockTimeoutMs: 0 });
  owners.push(owner);
  return owner;
}

describe("asynchronous directory ownership", () => {
  it("publishes process identity and permits reacquisition only after clean release", async () => {
    const path = directory();
    const owner = await acquire(path, "first");
    expect(owner.released).toBe(false);
    expect(JSON.parse(readFileSync(join(path, OWNER_PROCESS_FILE), "utf8"))).toMatchObject({
      version: 3,
      pid: process.pid,
      started: expect.any(String),
      machine: machineIdentity(),
      host: hostname(),
      sessionId: "first",
    });
    await expect(AsyncDataDirectoryOwner.acquire({ dataDirectory: path, sessionId: "second", lockTimeoutMs: 0 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await owner.release()).toEqual({ released: true });
    expect(owner.released).toBe(true);
    const next = await acquire(path, "next");
    expect(next.sessionId).toBe("next");
  });

  it("refuses a separate contender after worker death while the parent remains alive", async () => {
    const path = directory();
    const owner = await acquire(path, "live-parent");
    const credentials = mintToken(path, owner);
    await owner.abort();
    expect(owner.released).toBe(true);
    expect(() => mintToken(path, owner)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    const modulePath = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const { acquireDataDirectoryOwnership } = require(process.argv[1]);
      (async () => { try {
        const owner = await acquireDataDirectoryOwnership({ dataDirectory: process.argv[2], sessionId: 'contender', lockTimeoutMs: 0 });
        await owner.release(); process.stdout.write('acquired');
      } catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); } })();
    `,
        modulePath,
        path,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("still alive") });
    expect(JSON.parse(readFileSync(join(path, OWNER_PROCESS_FILE), "utf8"))).toMatchObject({ sessionId: "live-parent" });
    expect(readFileSync(credentials.paths.tokenPath, "utf8").trim()).toBe(credentials.token);
  });

  it("refuses unknown identity, corrupt records and a reused live PID", () => {
    const path = directory();
    const marker = join(path, OWNER_PROCESS_FILE);
    for (const record of [
      "not-json",
      JSON.stringify({ version: 1, pid: process.pid, host: "another-host", sessionId: "old" }),
      JSON.stringify({ version: 1, pid: process.pid, host: hostname(), sessionId: "old" }),
      JSON.stringify({ version: 2, pid: process.pid, machine: "machine:another", host: hostname(), sessionId: "old" }),
      JSON.stringify({ version: 2, pid: process.pid, machine: machineIdentity(), host: "renamed-host", sessionId: "old" }),
    ]) {
      writeFileSync(marker, record, { mode: 0o600 });
      expect(() => acquireDataDirectoryOwnership({ dataDirectory: path, sessionId: "new", lockTimeoutMs: 0 })).toThrowError(
        expect.objectContaining({ code: "CONFLICT" }),
      );
      expect(readFileSync(marker, "utf8")).toBe(record);
    }
  });

  it("recovers an owner whose whole process exits without releasing its worker", async () => {
    const path = directory();
    const modulePath = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const { AsyncDataDirectoryOwner } = require(process.argv[1]);
      AsyncDataDirectoryOwner.acquire({ dataDirectory: process.argv[2], sessionId: 'crashed-startup' })
        .then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    `,
        modulePath,
        path,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(path, OWNER_PROCESS_FILE), "utf8"))).toMatchObject({ sessionId: "crashed-startup" });
    const next = await acquire(path, "recovered");
    expect(next.released).toBe(false);
    expect(JSON.parse(readFileSync(join(path, OWNER_PROCESS_FILE), "utf8"))).toMatchObject({ pid: process.pid, sessionId: "recovered" });
  });
});
