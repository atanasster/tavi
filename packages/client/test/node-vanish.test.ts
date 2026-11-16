import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { IPC_PROTOCOL_VERSION } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * An owner stopping removes its record, then its cookie, and one starting
 * rewrites the cookie: a read that interleaves finds the file gone between
 * checking for it and reading it. `readFileSync` is replaced so that happens
 * on demand.
 */
const vanishing = new Set<string>();

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: ((path: string, options?: unknown) => {
      if (vanishing.has(String(path))) throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: "ENOENT" });
      return fs.readFileSync(path, options as never);
    }) as typeof fs.readFileSync,
  };
});

const { ownerFiles, readOwner } = await import("../src/node.js");
const { discovery } = await import("./support/discovery.js");

const temp = temporaryDirectories();

afterEach(() => {
  vanishing.clear();
  temp.cleanup();
});

describe("readOwner while the owner publishes or withdraws", () => {
  it("reads a record or cookie that vanishes mid-read as no owner, so the next attempt reads again", () => {
    const directory = temp.create("tavi-client-vanish-");
    const { discoveryPath, tokenPath } = ownerFiles(directory);
    mkdirSync(join(directory, "runtime"), { mode: 0o700 });
    writeFileSync(tokenPath, "cookie", { mode: 0o600 });
    writeFileSync(
      discoveryPath,
      JSON.stringify({
        protocolVersion: IPC_PROTOCOL_VERSION,
        sessionId: "s",
        endpoint: "/x.sock",
        pid: 1,
        startedAt: "2026-09-18T12:00:00.000Z",
      }),
    );
    expect(readOwner(directory, discovery)?.sessionId).toBe("s");
    vanishing.add(tokenPath);
    expect(readOwner(directory, discovery)).toBeUndefined();
    vanishing.clear();
    vanishing.add(discoveryPath);
    expect(readOwner(directory, discovery)).toBeUndefined();
  });
});
