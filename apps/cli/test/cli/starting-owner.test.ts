import { IPC_PROTOCOL_VERSION } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { acquireDataDirectoryOwnership, ipcPaths, markStopping, mintToken, publishDiscovery } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { findLiveOwner } from "../../src/cli/live-owner.js";

/**
 * `tavi serve` takes the directory's lock, then composes its runtime, and only
 * then publishes where it answers. A command run in that window found no
 * discovery, went to the directory itself, and was refused CONFLICT: it now
 * waits for the starting owner to answer.
 */
const directories = temporaryDirectories({ prefix: "tavi-starting-owner-" });
const owners: { release(): Promise<unknown> }[] = [];

afterEach(async () => {
  while (owners.length > 0) await owners.pop()?.release();
  directories.cleanup();
});

describe("a command run while tavi serve is starting", () => {
  it("waits for the owner to publish where it answers, instead of opening the directory", async () => {
    const directory = directories.create();
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "serve-test-1" });
    owners.push(owner);
    const found = findLiveOwner(directory);
    // The owner publishes a moment later, as serve does once its runtime is composed.
    setTimeout(() => {
      mintToken(directory, owner);
      publishDiscovery(
        directory,
        {
          protocolVersion: IPC_PROTOCOL_VERSION,
          sessionId: "serve-test-1",
          endpoint: ipcPaths(directory).socketPath,
          pid: process.pid,
          startedAt: nowTimestamp(),
        },
        owner,
      );
    }, 300);
    await expect(found).resolves.toMatchObject({ sessionId: "serve-test-1" });
  });

  it("does not wait for a holder that never answers over IPC (another command)", async () => {
    const directory = directories.create();
    owners.push(await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: `cli-${process.pid}` }));
    const started = Date.now();
    await expect(findLiveOwner(directory)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not wait for a serve that is stopping: it withdrew its discovery to drain", async () => {
    const directory = directories.create();
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "serve-test-2" });
    owners.push(owner);
    mintToken(directory, owner);
    markStopping(directory, owner);
    const started = Date.now();
    await expect(findLiveOwner(directory)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
