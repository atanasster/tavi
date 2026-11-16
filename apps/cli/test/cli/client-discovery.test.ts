import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readOwner } from "@tavi/client/node";
import { IPC_PROTOCOL_VERSION } from "@tavi/contracts";
import { ipcPaths, mintToken, readDiscovery, readToken } from "@tavi/runtime";
import { needsPosix, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

/** Windows skips this file's POSIX cases (`POSIX_ONLY` says why). */
const posixOnly = needsPosix(import.meta.url);

/**
 * `@tavi/client/node` reads what an owner publishes with its own copy of the
 * owner's read-side checks: the client may not depend on the runtime. This
 * suite runs both readers over the same directories, so the copy cannot drift
 * from the original.
 */

const directories = temporaryDirectories({ prefix: "tavi-conformance-" });

afterEach(() => directories.cleanup());

/** Publish as an owner does: a private directory, a 0600 cookie, a record. */
function publish(directory: string): void {
  const paths = ipcPaths(directory);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.tokenPath, "cookie", { mode: 0o600 });
  writeFileSync(
    paths.discoveryPath,
    JSON.stringify({
      protocolVersion: IPC_PROTOCOL_VERSION,
      sessionId: "session-a",
      endpoint: paths.socketPath,
      pid: process.pid,
      startedAt: "2026-09-18T12:00:00.000Z",
    }),
    { mode: 0o600 },
  );
}

/** What the owner's own readers make of `directory`: its address, nothing, or the refusal. */
function ownerReads(directory: string): unknown {
  try {
    const discovery = readDiscovery(directory);
    const token = readToken(directory);
    if (discovery === undefined || token === undefined) return undefined;
    return { endpoint: discovery.endpoint, sessionId: discovery.sessionId, protocolVersion: discovery.protocolVersion, token };
  } catch (error) {
    return { refused: (error as { code?: string }).code };
  }
}

function clientReads(directory: string): unknown {
  try {
    return readOwner(directory);
  } catch (error) {
    return { refused: (error as { code?: string }).code };
  }
}

describe.skipIf(posixOnly)("the client reads discovery as the owner does", () => {
  const cases: readonly (readonly [string, (directory: string) => void])[] = [
    ["nothing published", () => undefined],
    ["a published owner", publish],
    [
      "a half-written record",
      (directory) => {
        publish(directory);
        writeFileSync(ipcPaths(directory).discoveryPath, '{"protocolVersion":3,');
      },
    ],
    [
      "a symlinked cookie",
      (directory) => {
        publish(directory);
        rmSync(ipcPaths(directory).tokenPath);
        symlinkSync(join(directory, "elsewhere"), ipcPaths(directory).tokenPath);
      },
    ],
    [
      "a cookie others can read",
      (directory) => {
        publish(directory);
        chmodSync(ipcPaths(directory).tokenPath, 0o644);
      },
    ],
    [
      "a symlinked record",
      (directory) => {
        publish(directory);
        rmSync(ipcPaths(directory).discoveryPath);
        symlinkSync(join(directory, "planted.json"), ipcPaths(directory).discoveryPath);
      },
    ],
  ];

  for (const [name, arrange] of cases) {
    it(`agrees on ${name}`, () => {
      const directory = directories.create();
      arrange(directory);
      expect(clientReads(directory)).toEqual(ownerReads(directory));
    });
  }

  it("is stricter about a publication directory others can reach, which no owner publishes into", () => {
    const directory = directories.create();
    publish(directory);
    chmodSync(ipcPaths(directory).directory, 0o755);
    expect(clientReads(directory)).toEqual({ refused: "NOT_AUTHORIZED" });
    // The owner refuses to mint a cookie there, so refusing to read one loses nothing.
    expect(() => mintToken(directory, { dataDirectory: directory, sessionId: "s", released: false })).toThrow(/accessible to other users/);
  });
});
