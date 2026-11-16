import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { IPC_PROTOCOL_VERSION, isProtocolMismatch, type ClientEvent } from "@tavi/contracts";
import { needsPosix, temporaryDirectories, waitFor } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { connectToOwner, isRetryableSocketError, openSocket, ownerFiles, readOwner, socketChannel, type TaviClient } from "../src/node.js";
import { refuseUncheckedPipe } from "../src/node/socket.js";
import { discovery, socket } from "./support/discovery.js";
import { FakeOwner, textEvent } from "./support/fakes.js";

/** Windows skips this file's POSIX cases (`POSIX_ONLY` says why). */
const posixOnly = needsPosix(import.meta.url);

const temp = temporaryDirectories({ prefix: "tavi-client-" });
const servers: Server[] = [];
const clients: TaviClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  temp.cleanup();
});

/** Publish `owner` in `directory` as a real owner does: a private runtime directory, a 0600 cookie. */
function publish(directory: string, owner: FakeOwner, protocolVersion = IPC_PROTOCOL_VERSION): void {
  const { discoveryPath, tokenPath } = ownerFiles(directory);
  mkdirSync(join(directory, "runtime"), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, owner.token, { mode: 0o600 });
  writeFileSync(
    discoveryPath,
    JSON.stringify({
      protocolVersion,
      sessionId: owner.sessionId,
      endpoint: owner.endpoint,
      pid: process.pid,
      startedAt: "2026-09-18T12:00:00.000Z",
    }),
    { mode: 0o600 },
  );
}

/** Serve `owner` on a real Unix socket (on Windows, a named pipe) at its endpoint. */
async function listen(owner: FakeOwner): Promise<Server> {
  const server = createServer((socket) => owner.accept(socketChannel(socket)));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(owner.endpoint, resolve));
  return server;
}

/** An endpoint the test owns: a socket file in `directory`, or on Windows a fresh named pipe. */
const endpointIn = (directory: string, name: string): string =>
  process.platform === "win32" ? `\\\\.\\pipe\\tavi-test-${randomBytes(8).toString("hex")}` : join(directory, name);

describe("readOwner", () => {
  it("reads the owner a data directory publishes, and nothing when it publishes nothing", () => {
    const directory = temp.create();
    expect(readOwner(directory, discovery)).toBeUndefined();
    const owner = new FakeOwner("session-a", { endpoint: endpointIn(join(directory, "runtime"), "ipc.sock") });
    publish(directory, owner);
    expect(readOwner(directory, discovery)).toEqual({
      endpoint: owner.endpoint,
      sessionId: "session-a",
      token: owner.token,
      protocolVersion: IPC_PROTOCOL_VERSION,
    });
  });

  it("reads a half-written record, or an empty cookie, as no owner", () => {
    const directory = temp.create();
    publish(directory, new FakeOwner("session-a"));
    writeFileSync(ownerFiles(directory).discoveryPath, '{"protocolVersion":3,');
    expect(readOwner(directory, discovery)).toBeUndefined();
    publish(directory, new FakeOwner("session-a"));
    writeFileSync(ownerFiles(directory).tokenPath, "\n");
    expect(readOwner(directory, discovery)).toBeUndefined();
  });

  // Modes, and symlinks (which need a privilege on Windows), are POSIX's.
  it.skipIf(posixOnly)("refuses a symlinked cookie, a cookie others can read, and a directory others can reach", () => {
    const directory = temp.create();
    publish(directory, new FakeOwner("session-a"));
    const { tokenPath } = ownerFiles(directory);
    chmodSync(tokenPath, 0o644);
    expect(() => readOwner(directory)).toThrow(/readable by other users/);
    chmodSync(tokenPath, 0o600);
    chmodSync(join(directory, "runtime"), 0o755);
    expect(() => readOwner(directory)).toThrow(/accessible to other users/);
    chmodSync(join(directory, "runtime"), 0o700);
    rmSync(tokenPath);
    symlinkSync(join(directory, "elsewhere"), tokenPath);
    expect(() => readOwner(directory)).toThrow(/symlinked IPC path/);
  });

  it.runIf(process.platform === "win32")("refuses every publication on Windows when the caller gives no access-list rule", () => {
    const directory = temp.create();
    publish(directory, new FakeOwner("session-a"));
    expect(() => readOwner(directory)).toThrow(/this account, SYSTEM and Administrators only/);
  });

  it("judges privacy by the caller's rule when one is given (the access-list check on Windows)", () => {
    const directory = temp.create();
    publish(directory, new FakeOwner("session-a"));
    const { tokenPath } = ownerFiles(directory);
    const judged: string[] = [];
    const refuseCookie = (path: string): string | undefined => {
      judged.push(path);
      return path === tokenPath ? "its access list lets S-1-1-0 in" : undefined;
    };
    expect(() => readOwner(directory, { privacyProblem: refuseCookie })).toThrow(
      /readable by other users; expected 0600 \(its access list lets S-1-1-0 in\)/,
    );
    expect(judged).toEqual([join(directory, "runtime"), tokenPath]);
    expect(readOwner(directory, { privacyProblem: () => undefined })?.sessionId).toBe("session-a");
  });

  it.skipIf(posixOnly)("refuses a symlinked record, and a symlinked publication directory", () => {
    const record = temp.create();
    publish(record, new FakeOwner("session-a"));
    const { discoveryPath } = ownerFiles(record);
    rmSync(discoveryPath);
    symlinkSync(join(record, "planted.json"), discoveryPath);
    expect(() => readOwner(record)).toThrow(/symlinked IPC path/);

    const linked = temp.create();
    const elsewhere = temp.create();
    publish(elsewhere, new FakeOwner("session-a"));
    symlinkSync(join(elsewhere, "runtime"), join(linked, "runtime"));
    expect(() => readOwner(linked)).toThrow(/symlinked IPC path/);
  });
});

describe("the socket client", () => {
  it("classifies a missing socket as worth another attempt", async () => {
    const error = await openSocket(endpointIn(temp.create(), "missing.sock"), socket).catch((caught: unknown) => caught);
    expect(isRetryableSocketError(error)).toBe(true);
    expect(isRetryableSocketError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
  });

  it("refuses, on Windows, a named pipe whose owner the caller did not check", () => {
    const pipe = "\\\\.\\pipe\\tavi-0123";
    expect(() => refuseUncheckedPipe(pipe, "win32")).toThrow(/owner was not checked/);
    expect(() => refuseUncheckedPipe(pipe, "linux")).not.toThrow();
    expect(() => refuseUncheckedPipe("C:\\data\\runtime\\ipc.sock", "win32")).not.toThrow();
  });

  it("refuses an owner of another protocol from its discovery record, without connecting", async () => {
    const directory = temp.create();
    const owner = new FakeOwner("session-a", { endpoint: endpointIn(directory, "owner.sock") });
    publish(directory, owner, IPC_PROTOCOL_VERSION + 1);
    await listen(owner);
    const error = await connectToOwner(directory, { discovery, socket }).catch((caught: unknown) => caught);
    expect(isProtocolMismatch(error)).toBe(true);
    expect(owner.connections).toHaveLength(0);
  });

  it("follows a task over the socket and, when the owner restarts elsewhere, finds it through discovery", async () => {
    const directory = temp.create();
    const first = new FakeOwner("session-a", { endpoint: endpointIn(directory, "a.sock") });
    first.onRequest = (request) =>
      request.connection.answer(request.requestId, {
        ok: true,
        result: { subscriptionId: "sub-a", replayed: 0, resync: false, truncated: false, roundsAnsweredBy: "client" },
      });
    publish(directory, first);
    const firstServer = await listen(first);

    const client = await connectToOwner(directory, { retryDelayMs: 20, reconnectDelayMs: 20, discovery, socket });
    clients.push(client);
    const events: ClientEvent[] = [];
    await client.subscribe("task-1", { from: "beginning", onEvent: (event) => events.push(event) });
    first.latest.event("sub-a", textEvent("session-a", 0));
    await waitFor(() => events.length === 1, 5_000, { intervalMs: 5 });

    // The owner goes away and a new one publishes a new session, cookie and socket.
    const second = new FakeOwner("session-b", { endpoint: endpointIn(directory, "b.sock") });
    const resumed: unknown[] = [];
    second.onRequest = (request) => {
      resumed.push(request.payload);
      request.connection.answer(request.requestId, {
        ok: true,
        result: { subscriptionId: "sub-b", replayed: 0, resync: true, truncated: true, roundsAnsweredBy: "client" },
      });
      request.connection.event("sub-b", { ...textEvent("session-b", 4), kind: "resync.required", reason: "new epoch" } as ClientEvent);
    };
    await listen(second);
    publish(directory, second);
    first.latest.drop();
    firstServer.close();

    await waitFor(() => events.length === 2, 5_000, { intervalMs: 5 });
    expect(resumed).toEqual([{ taskId: "task-1", from: { epoch: "session-a", sequence: 0 } }]);
    expect(events[1]).toMatchObject({ kind: "resync.required", epoch: "session-b" });
    expect(client.state).toBe("ready");
  });
});
