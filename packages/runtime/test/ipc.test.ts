import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CLIENT_PROTOCOL_VERSION, IPC_COMMANDS, IPC_MAX_FRAME_BYTES, IPC_PROTOCOL_VERSION, type ClientEvent } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import {
  clampMessage,
  clearDiscovery,
  createIpcClient,
  createIpcServer,
  encodeFrame,
  ipcPaths,
  mintToken,
  publishDiscovery,
  readDiscovery,
  readToken,
  tokenMatches,
  FrameReader,
} from "@tavi/runtime";

import { afterEach, describe, expect, it } from "vitest";
import { sleep } from "@tavi/node-kit";
import { temporaryDirectories, waitFor } from "@tavi/test-support";

const directories = temporaryDirectories({ prefix: "tavi-ipc-" });

/** A live ownership proof for an arbitrary directory. */
const ownedBy = (directory: string) => ({
  dataDirectory: directory,
  sessionId: "session-1",
  released: false,
});

afterEach(() => {
  directories.cleanup();
});

describe("the commands an owner advertises", () => {
  it("refuses to advertise a command the contract does not declare, before it listens", () => {
    const endpoint = join(directories.create(), "ipc.sock");
    expect(() =>
      createIpcServer({
        endpoint,
        sessionId: "session-1",
        token: "token-a",
        features: ["tasks", "bogus"],
        onRequest: async () => ({ ok: true }),
      }),
    ).toThrow(/refusing to advertise "bogus"/);
    expect(existsSync(endpoint)).toBe(false);
  });
});

describe("subscriptions, back-pressure and drain", () => {
  /** A server whose `subscribe` handler registers a pushable subscription. */
  async function startPushServer(options: { readonly backlog?: number } = {}) {
    const directory = directories.create();
    const endpoint = join(directory, "ipc.sock");
    const dropped: string[] = [];
    const connections: { send: (subscriptionId: string, event: ClientEvent) => boolean }[] = [];
    const server = createIpcServer({
      endpoint,
      sessionId: "session-1",
      token: "token-a",
      ...(options.backlog === undefined ? {} : { maxSubscriptionBacklogBytes: options.backlog }),
      onRequest: async ({ command, payload, requestId, connection }) => {
        if (command === "subscribe") {
          const { subscriptionId } = payload as { subscriptionId: string };
          connection.createSubscription({
            subscriptionId,
            requestId,
            onDropped: (reason) => dropped.push(reason),
          });
          connections.push({ send: (id, event) => connection.sendEvent(id, event) });
          return { ok: true, result: { subscriptionId } };
        }
        return { ok: true, result: { command } };
      },
    });
    await server.listening;
    const client = await createIpcClient({ endpoint, sessionId: "session-1", token: "token-a" });
    return { server, client, dropped, endpoint, send: (id: string, event: ClientEvent) => connections[0]!.send(id, event) };
  }

  const delta = (taskId: string, text: string, attemptId = "attempt-1"): ClientEvent => ({
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "session-1",
    sequence: 0,
    runId: taskId,
    attemptId,
    at: "2026-01-01T00:00:00.000Z",
    kind: "text.delta",
    blockId: "block-1",
    text,
  });

  it("delivers pushed events for two subscriptions on one socket, in order", async () => {
    const { server, client, send } = await startPushServer();
    const seen: { subscriptionId: string; text: string }[] = [];
    client.onEvent((frame) =>
      seen.push({ subscriptionId: frame.subscriptionId, text: frame.event.kind === "text.delta" ? frame.event.text : "" }),
    );
    try {
      await client.request("subscribe", { subscriptionId: "sub-a" }, "sub-a");
      await client.request("subscribe", { subscriptionId: "sub-b" }, "sub-b");

      send("sub-a", delta("task-1", "a1"));
      send("sub-b", delta("task-2", "b1"));
      send("sub-a", delta("task-1", "a2"));

      await waitFor(() => seen.length >= 3);
      // Per-subscription order is preserved, and neither subscription's events
      // are delivered under the other's id.
      expect(seen).toEqual([
        { subscriptionId: "sub-a", text: "a1" },
        { subscriptionId: "sub-b", text: "b1" },
        { subscriptionId: "sub-a", text: "a2" },
      ]);
    } finally {
      client.close();
      await server.close();
    }
  });

  it("does not drop a sibling subscription when one stalls", async () => {
    const { server, client, dropped, send } = await startPushServer({ backlog: 512 });
    const seen: string[] = [];
    client.onEvent((frame) => seen.push(frame.subscriptionId));
    try {
      await client.request("subscribe", { subscriptionId: "slow" }, "slow");
      await client.request("subscribe", { subscriptionId: "fast" }, "fast");

      // Fill the slow subscription past its budget without the client reading.
      // `socket.write` returns false only once the kernel buffer is full, so this
      // is driven by volume rather than by a single write.
      const wide = "x".repeat(64 * 1024);
      for (let index = 0; index < 200; index += 1) {
        send("slow", delta("task-1", wide));
      }
      // The healthy subscription keeps working regardless.
      send("fast", delta("task-2", "still here"));
      await waitFor(() => seen.includes("fast"), 3_000);
      expect(seen).toContain("fast");
      expect(dropped).toContain("BACKLOG");
    } finally {
      client.close();
      await server.close();
    }
  });

  it("keeps serving requests while a subscriber is not reading", async () => {
    const { server, client, send } = await startPushServer({ backlog: 256 });
    try {
      await client.request("subscribe", { subscriptionId: "slow" }, "slow");
      const wide = "x".repeat(64 * 1024);
      for (let index = 0; index < 200; index += 1) send("slow", delta("task-1", wide));

      // The run's own progress is not held up by a client that stopped reading:
      // a request still completes promptly.
      const started = Date.now();
      const response = await client.request("tasks", {}, "r-progress");
      expect(response.ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      client.close();
      await server.close();
    }
  });

  it("still destroys the socket on an unknown frame", async () => {
    const directory = directories.create();
    const endpoint = join(directory, "ipc.sock");
    const server = createIpcServer({
      endpoint,
      sessionId: "session-1",
      token: "token-a",
      onRequest: async () => ({ ok: true }),
    });
    await server.listening;
    try {
      const net = await import("node:net");
      const socket = net.createConnection(endpoint);
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      // Authenticate, then send a frame no version of the contract defines.
      socket.write(encodeFrame({ type: "hello", protocolVersion: IPC_PROTOCOL_VERSION, token: "token-a", sessionId: "session-1" }));
      await sleep(50);
      // The connection is live first, so "count is 0" below means it was torn
      // down rather than never established.
      await waitFor(() => server.connectionCount() === 1);
      expect(server.connectionCount()).toBe(1);

      socket.write(Buffer.from('{"type":"nonsense"}\n', "utf8"));
      // Asserted on the server's own connection count: that is the property the
      // contract promises (the reader refuses the frame and the socket goes),
      // and it does not depend on how the peer's close event is delivered.
      await waitFor(() => server.connectionCount() === 0);
      expect(server.connectionCount()).toBe(0);
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  it("refuses a v1 client at the handshake", async () => {
    const directory = directories.create();
    const endpoint = join(directory, "ipc.sock");
    const server = createIpcServer({
      endpoint,
      sessionId: "session-1",
      token: "token-a",
      onRequest: async () => ({ ok: true }),
    });
    await server.listening;
    try {
      const net = await import("node:net");
      const socket = net.createConnection(endpoint);
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.write(encodeFrame({ type: "hello", protocolVersion: 3, token: "token-a", sessionId: "session-1" }));
      const closed = await new Promise<boolean>((resolve) => {
        socket.once("close", () => resolve(true));
        setTimeout(() => resolve(false), 1_000);
      });
      expect(closed).toBe(true);
      expect(server.authFailures()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("reports a protocol mismatch before connecting, with the remedy", async () => {
    // No server at all: the check is on the discovery record, so a v1 owner is
    // reported without a handshake that would only say "closed before
    // authentication".
    await expect(
      createIpcClient({ endpoint: "/nonexistent/ipc.sock", sessionId: "session-1", token: "t", protocolVersion: 1 }),
    ).rejects.toThrow(/speaks protocol 1.*restart the service/);
  });

  it("drains a live connection promptly, delivering the events it buffered", async () => {
    const { server, client, send } = await startPushServer();
    const seen: string[] = [];
    client.onEvent((frame) => seen.push(frame.event.kind));
    try {
      await client.request("subscribe", { subscriptionId: "sub-a" }, "sub-a");
      // Push into the socket buffer, then drain: the events must arrive rather
      // than being destroyed with the connection.
      for (let index = 0; index < 50; index += 1) send("sub-a", delta("task-1", `d${index}`));

      const started = Date.now();
      await server.drain(5_000);
      const elapsed = Date.now() - started;
      // Completes because the buffer emptied, not because the deadline passed —
      // resolving on the deadline would be a test that cannot fail.
      expect(elapsed).toBeLessThan(1_000);
      await waitFor(() => seen.filter((kind) => kind === "text.delta").length > 0);
      expect(seen.filter((kind) => kind === "text.delta").length).toBeGreaterThan(0);
    } finally {
      client.close();
      await server.close();
    }
  });

  it("stops accepting new connections without waiting for the live ones", async () => {
    const { server, client, endpoint } = await startPushServer();
    try {
      // A client is attached and idle. `closeListener` must return promptly —
      // `server.close`'s callback would wait for this connection to end, and
      // shutdown would hang before `drain` ever ran.
      const started = Date.now();
      await server.closeListener();
      expect(Date.now() - started).toBeLessThan(1_000);

      // The listening handle is genuinely released: a new client is refused at
      // the real endpoint…
      await expect(createIpcClient({ endpoint, sessionId: "session-1", token: "token-a", maxAttempts: 1 })).rejects.toThrow();
      // …while the attached one is still served.
      expect((await client.request("tasks", {}, "r-still")).ok).toBe(true);
    } finally {
      client.close();
      await server.close();
    }
  });
});

/**
 * A client whose reading the test controls: it authenticates, then reads only
 * while `resume()`d. A stalled subscriber is a peer that stops reading, and the
 * kernel's own buffer means only a raw socket can show what the owner holds.
 */
async function rawClient(endpoint: string) {
  const net = await import("node:net");
  const socket = net.createConnection(endpoint);
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const reader = new FrameReader();
  const frames: ReturnType<FrameReader["push"]>["frames"][number][] = [];
  let received = 0;
  /** Stall reading once this many bytes have arrived, inside the data handler. */
  let pauseAt = Infinity;
  socket.on("data", (chunk: Buffer) => {
    received += chunk.byteLength;
    const { frames: parsed, error } = reader.push(chunk);
    if (error !== undefined) throw new Error(error);
    frames.push(...parsed);
    if (received >= pauseAt) {
      pauseAt = Infinity;
      socket.pause();
    }
  });
  socket.write(encodeFrame({ type: "hello", protocolVersion: IPC_PROTOCOL_VERSION, token: "token-a", sessionId: "session-1" }));
  await waitFor(() => frames.some((frame) => frame.type === "ready"));
  return {
    socket,
    frames,
    received: () => received,
    send: (command: string, payload: unknown, requestId: string) =>
      socket.write(encodeFrame({ type: "request", requestId, command, payload })),
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    pauseAfter: (bytes: number) => {
      pauseAt = bytes;
    },
  };
}

describe("backlog accounting, ceilings, ordering and close", () => {
  /** A server exposing each connection, with the limits a test sets. */
  async function startServer(
    limits: {
      readonly backlog?: number;
      readonly ceiling?: number;
      readonly perConnection?: number;
    } = {},
    handler?: Parameters<typeof createIpcServer>[0]["onRequest"],
  ) {
    const directory = directories.create();
    const endpoint = join(directory, "ipc.sock");
    const dropped: string[] = [];
    const diagnostics: string[] = [];
    const connections: Parameters<Parameters<typeof createIpcServer>[0]["onRequest"]>[0]["connection"][] = [];
    const server = createIpcServer({
      endpoint,
      sessionId: "session-1",
      token: "token-a",
      ...definedOnly({
        maxSubscriptionBacklogBytes: limits.backlog,
        maxConnectionBacklogBytes: limits.ceiling,
        maxSubscriptionsPerConnection: limits.perConnection,
      }),
      onDiagnostic: (message) => diagnostics.push(message),
      onRequest:
        handler ??
        (async ({ command, payload, requestId, connection }) => {
          if (!connections.includes(connection)) connections.push(connection);
          if (command === "subscribe") {
            const { subscriptionId } = payload as { subscriptionId: string };
            connection.createSubscription({
              subscriptionId,
              requestId,
              onDropped: (reason) => dropped.push(`${subscriptionId}:${reason}`),
            });
            return { ok: true, result: { subscriptionId } };
          }
          if (command === "big") return { ok: true, result: { blob: "b".repeat((payload as { size: number }).size) } };
          return { ok: true, result: { command } };
        }),
    });
    await server.listening;
    return { server, endpoint, dropped, diagnostics, connections };
  }

  /** A `tool.completed` of about `bytes` encoded — sized freely, unlike a text delta. */
  const output = (bytes: number, sequence = 0): ClientEvent => ({
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "session-1",
    sequence,
    runId: "task-1",
    attemptId: "attempt-1",
    at: "2026-01-01T00:00:00.000Z",
    kind: "tool.completed",
    callId: "call-1",
    toolName: "fixture.write",
    output: "o".repeat(bytes),
    durationMs: 1,
  });

  const event = (text: string, sequence = 0): ClientEvent => ({
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "session-1",
    sequence,
    runId: "task-1",
    attemptId: "attempt-1",
    at: "2026-01-01T00:00:00.000Z",
    kind: "text.delta",
    blockId: "block-1",
    text,
  });

  it("answers each request exactly once under back-pressure, never with a false INTERNAL", async () => {
    const { server, endpoint } = await startServer();
    const client = await rawClient(endpoint);
    try {
      client.pause();
      // Responses large enough that the socket is back-pressured while they are
      // written: `socket.write` returning false used to be read as "could not be
      // encoded", and a second, INTERNAL response followed the real one.
      for (let index = 0; index < 8; index += 1) client.send("big", { size: 512 * 1024 }, `big-${index}`);
      await sleep(100);
      client.resume();
      await waitFor(() => client.frames.filter((frame) => frame.type === "response").length >= 8, 5_000);
      await sleep(50);
      const responses = client.frames.filter((frame) => frame.type === "response");
      expect(responses).toHaveLength(8);
      expect(responses.every((frame) => frame.type === "response" && frame.ok)).toBe(true);
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("charges a subscription only for its own unflushed frames, whoever writes in between", async () => {
    // The defect: drained bytes were credited to whichever subscription wrote
    // next, so a response written between a partial drain and the subscription's
    // next frame took the credit. Staged so a write request completes *without*
    // the socket emptying (no 'drain' reset): one large frame goes out as its own
    // write request, the rest queue behind it, and the client reads just past
    // the large one before stalling again.
    const budget = 256 * 1024;
    const { server, endpoint, dropped, connections } = await startServer({ backlog: budget });
    const client = await rawClient(endpoint);
    try {
      client.send("subscribe", { subscriptionId: "sub-a" }, "sub-a");
      await waitFor(() => client.frames.some((frame) => frame.type === "response" && frame.requestId === "sub-a"));
      const connection = connections[0]!;
      const readBefore = client.received();
      client.pause();

      const big = output(128 * 1024);
      connection.sendEvent("sub-a", big);
      for (let index = 0; index < 4; index += 1) connection.sendEvent("sub-a", output(25 * 1024));

      // Read just past the large frame, then stall inside the data handler.
      const bigFrame = encodeFrame({ type: "event", subscriptionId: "sub-a", event: big }).byteLength;
      client.pauseAfter(readBefore + bigFrame);
      client.resume();
      await waitFor(() => client.received() >= readBefore + bigFrame, 5_000);
      await sleep(50);

      // Another request's response is written in between…
      client.send("tasks", {}, "in-between");
      await sleep(50);
      // …then the subscription publishes more. Its real unflushed total (the
      // queued 100 KiB plus these 75 KiB) is within budget; the stolen credit put
      // the old accounting at ~303 KiB, over it.
      for (let index = 0; index < 3; index += 1) connection.sendEvent("sub-a", output(25 * 1024));
      expect(dropped).toEqual([]);
      expect(connection.subscriptions()).toContain("sub-a");
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("does not drop a steady sibling while a heavy subscription on the same connection is dropped", async () => {
    const { server, endpoint, dropped, connections } = await startServer({ backlog: 256 * 1024 });
    const client = await rawClient(endpoint);
    try {
      client.send("subscribe", { subscriptionId: "heavy" }, "heavy");
      client.send("subscribe", { subscriptionId: "steady" }, "steady");
      await waitFor(() => client.frames.filter((frame) => frame.type === "response").length === 2);
      const connection = connections[0]!;
      client.pause();
      const wide = "h".repeat(64 * 1024);
      // Interleaved: the sibling publishes throughout the heavy burst.
      for (let index = 0; index < 40; index += 1) {
        connection.sendEvent("heavy", event(wide, index));
        connection.sendEvent("steady", event(`s${index}`, index));
      }
      expect(dropped).toEqual(["heavy:BACKLOG"]);
      expect(connection.subscriptions()).toEqual(["steady"]);
      // Once the client reads again, every one of the sibling's events arrives,
      // in order.
      client.resume();
      await waitFor(
        () => client.frames.filter((frame) => frame.type === "event" && frame.subscriptionId === "steady").length === 40,
        5_000,
      );
      const steady = client.frames.flatMap((frame) =>
        frame.type === "event" && frame.subscriptionId === "steady" && frame.event.kind === "text.delta" ? [frame.event.text] : [],
      );
      expect(steady).toEqual(Array.from({ length: 40 }, (_, index) => `s${index}`));
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("keeps publishing fast while a subscriber is stalled (measured)", async () => {
    // The run's progress is the publisher's: `sendEvent` must stay cheap with a
    // stalled reader attached, and the stalled subscription is dropped rather
    // than buffered without end.
    const { server, endpoint, dropped, connections } = await startServer({ backlog: 1024 * 1024 });
    const client = await rawClient(endpoint);
    try {
      client.send("subscribe", { subscriptionId: "stalled" }, "stalled");
      await waitFor(() => client.frames.some((frame) => frame.type === "response"));
      client.pause();
      const connection = connections[0]!;
      const text = "p".repeat(1024);
      const started = performance.now();
      for (let index = 0; index < 5_000; index += 1) connection.sendEvent("stalled", event(text, index));
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(2_000);
      expect(dropped).toEqual(["stalled:BACKLOG"]);
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("closes a connection whose subscriptions together exceed its ceiling, once", async () => {
    // One stalled connection could hold its per-subscription budget once per
    // subscription; the ceiling bounds the connection as a whole. Sized so the
    // ceiling trips before any one subscription reaches its own budget.
    const budget = 256 * 1024;
    const ceiling = budget + IPC_MAX_FRAME_BYTES;
    const { server, endpoint, diagnostics, connections, dropped } = await startServer({ backlog: budget, ceiling });
    const client = await rawClient(endpoint);
    try {
      for (let index = 0; index < 8; index += 1) client.send("subscribe", { subscriptionId: `sub-${index}` }, `sub-${index}`);
      await waitFor(() => client.frames.filter((frame) => frame.type === "response").length === 8);
      client.pause();
      const connection = connections[0]!;
      const wide = "c".repeat(32 * 1024);
      let refusedAt: number | undefined;
      for (let round = 0; round < 40 && refusedAt === undefined; round += 1) {
        for (let index = 0; index < 8; index += 1) {
          if (!connection.sendEvent(`sub-${index}`, event(wide, round))) {
            refusedAt = round;
            break;
          }
        }
      }
      // Refused from the moment the ceiling tripped — not accepted into a
      // destroyed socket until its close event arrives.
      expect(refusedAt).toBeDefined();
      expect(connection.sendEvent("sub-0", event("after"))).toBe(false);
      expect(dropped).toEqual([]);
      await waitFor(() => server.connectionCount() === 0);
      expect(diagnostics.filter((message) => message.includes("exceeded its ceiling"))).toHaveLength(1);
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("refuses a ceiling too small for one subscription's budget", () => {
    // Otherwise the connection closes before any single subscription could be
    // dropped, and one stalled tab takes every tab with it.
    expect(() =>
      createIpcServer({
        endpoint: join(directories.create(), "ipc.sock"),
        sessionId: "session-1",
        token: "token-a",
        maxSubscriptionBacklogBytes: 4 * 1024 * 1024,
        maxConnectionBacklogBytes: 512 * 1024,
        onRequest: async () => ({ ok: true }),
      }),
    ).toThrowError(/ceiling/);
  });

  it("refuses a subscription beyond the per-connection limit", async () => {
    const { server, endpoint } = await startServer({ perConnection: 2 });
    const client = await rawClient(endpoint);
    try {
      for (const id of ["one", "two", "three"]) client.send("subscribe", { subscriptionId: id }, id);
      await waitFor(() => client.frames.filter((frame) => frame.type === "response").length === 3);
      const third = client.frames.find((frame) => frame.type === "response" && frame.requestId === "three");
      expect(third?.type === "response" && third.ok).toBe(false);
      expect(third?.type === "response" && third.error?.message).toMatch(/already holds 2 subscriptions/);
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("writes a subscription's events only after the response that names it", async () => {
    // A client learns the subscription id from the response; an event before it
    // would be addressed to an id the client cannot yet correlate.
    const { server, endpoint } = await startServer({}, async ({ command, requestId, connection }) => {
      if (command === "subscribe") {
        connection.createSubscription({ subscriptionId: "sub-1", requestId, onDropped: () => {} });
        connection.sendEvent("sub-1", event("replayed", 0));
        await sleep(20);
        connection.sendEvent("sub-1", event("live", 1));
        return { ok: true, result: { subscriptionId: "sub-1" } };
      }
      if (command === "fail") {
        connection.createSubscription({ subscriptionId: "sub-2", requestId, onDropped: () => {} });
        connection.sendEvent("sub-2", event("never", 0));
        return { ok: false, error: { code: "INVALID_INPUT", message: "no" } };
      }
      return { ok: true };
    });
    const client = await rawClient(endpoint);
    try {
      client.send("subscribe", {}, "subscribe-1");
      client.send("fail", {}, "fail-1");
      await waitFor(() => client.frames.filter((frame) => frame.type === "response").length === 2);
      await sleep(50);
      const order = client.frames
        .filter((frame) => frame.type !== "ready")
        .map((frame) =>
          frame.type === "response" ? `response:${frame.requestId}` : frame.type === "event" ? `event:${frame.subscriptionId}` : frame.type,
        );
      expect(order.indexOf("response:subscribe-1")).toBeLessThan(order.indexOf("event:sub-1"));
      expect(order.filter((entry) => entry === "event:sub-1")).toHaveLength(2);
      // A failed request's subscription is discarded with its events.
      expect(order).not.toContain("event:sub-2");
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("carries live browser-view frames on a live subscription after its response, outside the event backlog budget", async () => {
    const jpeg = "A".repeat(4096);
    const message = {
      kind: "frame",
      sessionId: "s1",
      mime: "image/jpeg",
      data: jpeg,
      width: 16,
      height: 9,
      metadata: { deviceWidth: 16, deviceHeight: 9, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 },
      at: "2026-01-01T00:00:00.000Z",
      source: "live",
    } as const;
    const refused: boolean[] = [];
    const backlogs: number[] = [];
    // A budget smaller than the frames sent: an event subscription would be dropped.
    const { server, endpoint } = await startServer(
      { backlog: 16 * 1024, ceiling: 16 * 1024 + 1024 * 1024 },
      async ({ command, requestId, connection }) => {
        if (command === "watch") {
          connection.createSubscription({ subscriptionId: "live-1", requestId, onDropped: () => {}, live: true });
          for (let seq = 0; seq < 8; seq += 1) connection.sendLive("live-1", seq, message);
          // A live subscription carries no events, and an event one no live frames.
          refused.push(connection.sendEvent("live-1", event("x")));
          connection.createSubscription({ subscriptionId: "sub-1", requestId, onDropped: () => {} });
          refused.push(connection.sendLive("sub-1", 0, message));
          backlogs.push(connection.backlogBytes());
          return { ok: true, result: { subscriptionId: "live-1" } };
        }
        return { ok: true };
      },
    );
    const client = await rawClient(endpoint);
    try {
      client.send("watch", {}, "watch-1");
      await waitFor(() => client.frames.filter((frame) => frame.type === "live").length === 8);
      const order = client.frames.filter((frame) => frame.type !== "ready").map((frame) => frame.type);
      expect(order[0]).toBe("response");
      expect(client.frames.flatMap((frame) => (frame.type === "live" ? [frame.seq] : []))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(refused).toEqual([false, false]);
      // Held until the response: counted in the connection's backlog.
      expect(backlogs[0]).toBeGreaterThan(8 * jpeg.length);
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("tells a handler when its connection closes, and releases the connection's subscriptions", async () => {
    const { server, endpoint, connections } = await startServer();
    const client = await rawClient(endpoint);
    try {
      client.send("subscribe", { subscriptionId: "sub-1" }, "sub-1");
      await waitFor(() => connections.length === 1);
      let closed = 0;
      connections[0]!.onClose(() => {
        closed += 1;
      });
      client.socket.destroy();
      await waitFor(() => closed === 1);
      expect(connections[0]!.subscriptions()).toEqual([]);
      expect(connections[0]!.sendEvent("sub-1", event("late"))).toBe(false);
      // Registered after the close: called at once rather than never.
      let late = false;
      connections[0]!.onClose(() => {
        late = true;
      });
      expect(late).toBe(true);
    } finally {
      await server.close();
    }
  });

  /** A server whose `subscribe` handler replays `count` events of `bytes` each before answering. */
  async function replayServer(behaviour: {
    readonly count: number;
    readonly bytes: number;
    readonly backlog?: number;
    readonly onFalse?: "dropSubscription";
    readonly answer?: "ok" | "fail" | "throw" | "unencodable";
  }) {
    const dropped: string[] = [];
    const answers: boolean[] = [];
    const started = await startServer(
      { ...(behaviour.backlog === undefined ? {} : { backlog: behaviour.backlog }) },
      async ({ command, requestId, connection }) => {
        if (command !== "subscribe") return { ok: true };
        connection.createSubscription({ subscriptionId: "sub-1", requestId, onDropped: (reason) => dropped.push(reason) });
        for (let index = 0; index < behaviour.count; index += 1) {
          const accepted = connection.sendEvent("sub-1", output(behaviour.bytes, index));
          answers.push(accepted);
          if (!accepted) {
            if (behaviour.onFalse === "dropSubscription") connection.dropSubscription("sub-1");
            break;
          }
        }
        switch (behaviour.answer ?? "ok") {
          case "fail":
            return { ok: false, error: { code: "INVALID_INPUT", message: "refused" } };
          case "throw":
            throw new Error("handler exploded");
          case "unencodable":
            return { ok: true, result: { blob: "u".repeat(IPC_MAX_FRAME_BYTES) } };
          default:
            return { ok: true, result: { subscriptionId: "sub-1" } };
        }
      },
    );
    return { ...started, dropped, answers };
  }

  const responsesFor = (frames: readonly unknown[], requestId: string) =>
    frames.filter(
      (frame): frame is { type: "response"; requestId: string; ok: boolean; error?: { code: string } } =>
        (frame as { type?: string }).type === "response" && (frame as { requestId?: string }).requestId === requestId,
    );

  it("sends the BACKLOG notice after the response when a held subscription overflows", async () => {
    const { server, endpoint, dropped } = await replayServer({ count: 20, bytes: 32 * 1024, backlog: 128 * 1024 });
    const client = await rawClient(endpoint);
    try {
      client.send("subscribe", {}, "subscribe-1");
      await waitFor(() => responsesFor(client.frames, "subscribe-1").length === 2);
      const [first, second] = responsesFor(client.frames, "subscribe-1");
      expect(first?.ok).toBe(true);
      expect(second).toMatchObject({ ok: false, error: { code: "BACKLOG" } });
      expect(dropped).toEqual(["BACKLOG"]);
      // Nothing held was released after the drop.
      expect(client.frames.some((frame) => frame.type === "event")).toBe(false);
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("keeps an owed BACKLOG notice when the handler releases the subscription on false", async () => {
    // `sendEvent` returning false invites a handler to release its state; doing
    // so must not erase the only news the client gets that its subscription died.
    const { server, endpoint, answers } = await replayServer({
      count: 20,
      bytes: 32 * 1024,
      backlog: 128 * 1024,
      onFalse: "dropSubscription",
    });
    const client = await rawClient(endpoint);
    try {
      client.send("subscribe", {}, "subscribe-1");
      await waitFor(() => responsesFor(client.frames, "subscribe-1").length === 2);
      expect(responsesFor(client.frames, "subscribe-1").map((frame) => frame.ok)).toEqual([true, false]);
      // The event that tipped it over was not delivered, so it was not accepted.
      expect(answers.at(-1)).toBe(false);
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  it("discards an owed notice when the creating response fails", async () => {
    const { server, endpoint } = await replayServer({ count: 20, bytes: 32 * 1024, backlog: 128 * 1024, answer: "fail" });
    const client = await rawClient(endpoint);
    try {
      client.send("subscribe", {}, "subscribe-1");
      await waitFor(() => responsesFor(client.frames, "subscribe-1").length >= 1);
      await sleep(50);
      // One answer: the failure. The client never learned of the subscription.
      expect(responsesFor(client.frames, "subscribe-1").map((frame) => frame.ok)).toEqual([false]);
    } finally {
      client.socket.destroy();
      await server.close();
    }
  });

  for (const answer of ["throw", "unencodable"] as const) {
    it(`discards a held subscription and tells its owner when the handler's answer ${answer === "throw" ? "throws" : "cannot be encoded"}`, async () => {
      const { server, endpoint, dropped } = await replayServer({ count: 3, bytes: 1024, answer });
      const client = await rawClient(endpoint);
      try {
        client.send("subscribe", {}, "subscribe-1");
        await waitFor(() => responsesFor(client.frames, "subscribe-1").length >= 1);
        await sleep(50);
        expect(responsesFor(client.frames, "subscribe-1")).toEqual([
          expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "INTERNAL" }) }),
        ]);
        expect(client.frames.some((frame) => frame.type === "event")).toBe(false);
        // The handler believed the subscription live; it must learn otherwise.
        expect(dropped).toEqual(["FAILED"]);
      } finally {
        client.socket.destroy();
        await server.close();
      }
    });
  }

  it("lets a subscribe caller observe every replayed event, through onResponse", async () => {
    // Held events follow the response in the same chunk; a listener registered
    // after `await request(...)` would already have missed them.
    const { server, endpoint } = await replayServer({ count: 3, bytes: 1024 });
    const client = await createIpcClient({ endpoint, sessionId: "session-1", token: "token-a" });
    try {
      const seen: number[] = [];
      let subscriptionId: string | undefined;
      client.onEvent((frame) => {
        if (frame.subscriptionId === subscriptionId) seen.push(frame.event.sequence);
      });
      const response = await client.request("subscribe", {}, "subscribe-1", {
        onResponse: (answer) => {
          subscriptionId = (answer.result as { subscriptionId: string }).subscriptionId;
        },
      });
      expect(response.ok).toBe(true);
      await waitFor(() => seen.length === 3);
      expect(seen).toEqual([0, 1, 2]);
    } finally {
      client.close();
      await server.close();
    }
  });

  it("refuses a request id that is still pending on the connection", async () => {
    const { server, endpoint } = await startServer({}, async () => {
      await sleep(100);
      return { ok: true };
    });
    const client = await createIpcClient({ endpoint, sessionId: "session-1", token: "token-a" });
    try {
      const first = client.request("tasks", {}, "same-id");
      await expect(client.request("tasks", {}, "same-id")).rejects.toThrow(/already pending/);
      expect((await first).ok).toBe(true);
    } finally {
      client.close();
      await server.close();
    }
  });

  it("tells a client when its owner goes away, and answers a later request at once", async () => {
    const { server, endpoint } = await startServer();
    const client = await createIpcClient({ endpoint, sessionId: "session-1", token: "token-a" });
    let closed = false;
    client.onClose(() => {
      closed = true;
    });
    await server.close();
    await waitFor(() => closed);
    const started = Date.now();
    const response = await client.request("tasks", {}, "after-close");
    expect(Date.now() - started).toBeLessThan(200);
    expect(response).toMatchObject({ ok: false, error: { code: "DISCONNECTED" } });
  });
});

describe("IPC framing", () => {
  it("reassembles frames split across chunks", () => {
    const reader = new FrameReader();
    const frame = encodeFrame({
      type: "request",
      requestId: "r1",
      command: "tasks",
      payload: {},
    });
    const first = reader.push(frame.subarray(0, 5));
    expect(first.frames).toHaveLength(0);
    const second = reader.push(frame.subarray(5));
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0]).toMatchObject({ type: "request", command: "tasks" });
  });

  it("refuses a frame that exceeds the bound while bytes arrive", () => {
    const reader = new FrameReader(64);
    const result = reader.push(Buffer.alloc(65, 0x61));
    // Refused on accumulation, not after a full line was buffered.
    expect(result.error).toMatch(/exceeded 64 bytes/);
  });

  it("refuses invalid JSON and a frame that violates the contract", () => {
    expect(new FrameReader().push(Buffer.from("not json\n")).error).toMatch(/not valid JSON/);
    expect(new FrameReader().push(Buffer.from('{"type":"nonsense"}\n')).error).toMatch(/did not match the IPC contract/);
  });

  it("ignores blank lines", () => {
    expect(new FrameReader().push(Buffer.from("\n\n")).frames).toHaveLength(0);
  });

  it("accepts a legal frame near the bound when the next frame arrives in the same chunk", () => {
    // The bound is per frame: bounding the whole chunk refused two legal frames
    // that merely arrived together.
    const near = encodeFrame({
      type: "request",
      requestId: "r-near",
      command: "tasks",
      payload: "n".repeat(IPC_MAX_FRAME_BYTES - 200),
    });
    const next = encodeFrame({ type: "request", requestId: "r-next", command: "tasks", payload: {} });
    expect(near.byteLength).toBeLessThanOrEqual(IPC_MAX_FRAME_BYTES);
    const combined = new Uint8Array(near.byteLength + next.byteLength);
    combined.set(near, 0);
    combined.set(next, near.byteLength);
    const result = new FrameReader().push(combined);
    expect(result.error).toBeUndefined();
    expect(result.frames.map((frame) => (frame.type === "request" ? frame.requestId : ""))).toEqual(["r-near", "r-next"]);
  });

  it("still refuses one oversized frame among legal ones, and an oversized unterminated tail", () => {
    const small = encodeFrame({ type: "request", requestId: "r", command: "tasks", payload: {} });
    const limit = small.byteLength + 8;
    const reader = new FrameReader(limit);
    const oversized = new Uint8Array(limit + 10).fill(0x61);
    const withTerminator = new Uint8Array(small.byteLength + oversized.byteLength + 1);
    withTerminator.set(small, 0);
    withTerminator.set(oversized, small.byteLength);
    withTerminator[withTerminator.byteLength - 1] = 0x0a;
    const refused = reader.push(withTerminator);
    expect(refused.frames).toHaveLength(1);
    expect(refused.error).toMatch(new RegExp(`exceeded ${limit} bytes`));

    const tail = new FrameReader(64);
    expect(tail.push(new Uint8Array(40).fill(0x61)).error).toBeUndefined();
    expect(tail.push(new Uint8Array(40).fill(0x61)).error).toMatch(/exceeded 64 bytes/);
  });

  it("refuses to send an oversized frame", () => {
    const huge = "x".repeat(IPC_MAX_FRAME_BYTES + 1);
    expect(() => encodeFrame({ type: "request", requestId: "r", command: "tasks", payload: huge })).toThrowError(
      /refusing to send a frame/,
    );
  });
});

describe("IPC credentials", () => {
  /** A live ownership proof for the directory under test. */
  const owned = (directory: string) => ({
    dataDirectory: directory,
    sessionId: "session-1",
    released: false,
  });

  it("mints a 256-bit cookie in a private directory with private permissions", () => {
    const directory = directories.create();
    const { token, paths } = mintToken(directory, owned(directory));

    // 32 random bytes, base64: 256 bits of entropy.
    expect(Buffer.from(token, "base64").byteLength).toBe(32);
    expect(statSync(paths.directory).mode & 0o777).toBe(0o700);
    expect(statSync(paths.tokenPath).mode & 0o777).toBe(0o600);
  });

  it("creates the token file with its final mode rather than chmodding afterwards", () => {
    const directory = directories.create();
    const { paths } = mintToken(directory, owned(directory));
    // The file was created with `wx` and mode 0600, so it was never readable by
    // anyone else at any point.
    expect(readFileSync(paths.tokenPath, "utf8").length).toBeGreaterThan(0);
    expect(statSync(paths.tokenPath).mode & 0o777).toBe(0o600);
  });

  it("rotates the token so an old session cannot authenticate", () => {
    const directory = directories.create();
    const first = mintToken(directory, owned(directory)).token;
    const second = mintToken(directory, owned(directory)).token;
    expect(second).not.toBe(first);
    expect(readToken(directory)).toBe(second);
  });

  it("refuses a token other users can read", () => {
    const directory = directories.create();
    const { paths } = mintToken(directory, owned(directory));
    chmodSync(paths.tokenPath, 0o644);
    expect(() => readToken(directory)).toThrowError(/readable by other users/);
  });

  it("refuses a symlinked token", () => {
    const directory = directories.create();
    const paths = ipcPaths(directory);
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    symlinkSync(join(directory, "elsewhere"), paths.tokenPath);
    expect(() => readToken(directory)).toThrowError(/symlinked IPC path/);
  });

  it("refuses a credential directory other users can reach", () => {
    const directory = directories.create();
    const paths = ipcPaths(directory);
    mkdirSync(paths.directory, { recursive: true, mode: 0o755 });
    chmodSync(paths.directory, 0o755);
    expect(() => mintToken(directory, owned(directory))).toThrowError(/accessible to other users/);
  });

  it("compares tokens in constant time and rejects a different length", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    // A length mismatch must not throw.
    expect(tokenMatches("abc", "abcd")).toBe(false);
  });
});

describe("IPC discovery", () => {
  it("publishes discovery atomically", () => {
    const directory = directories.create();
    publishDiscovery(
      directory,
      {
        protocolVersion: IPC_PROTOCOL_VERSION,
        sessionId: "s1",
        endpoint: "/tmp/socket",
        pid: 1234,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      ownedBy(directory),
    );
    expect(readDiscovery(directory)?.sessionId).toBe("s1");
    // No temporary file is left behind.
    const paths = ipcPaths(directory);
    expect(existsSync(`${paths.discoveryPath}.${process.pid}.tmp`)).toBe(false);
  });

  it("treats a corrupt discovery file as absent rather than failing", () => {
    const directory = directories.create();
    const paths = ipcPaths(directory);
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    writeFileSync(paths.discoveryPath, "not json");
    expect(readDiscovery(directory)).toBeUndefined();
  });

  it("clears discovery", () => {
    const directory = directories.create();
    publishDiscovery(
      directory,
      {
        protocolVersion: IPC_PROTOCOL_VERSION,
        sessionId: "s1",
        endpoint: "/tmp/socket",
        pid: 1,
        startedAt: "t",
      },
      ownedBy(directory),
    );
    clearDiscovery(directory);
    expect(readDiscovery(directory)).toBeUndefined();
  });
});

describe("IPC server authentication", () => {
  async function startServer(token: string) {
    const directory = directories.create();
    const endpoint = join(directory, "ipc.sock");
    const requests: string[] = [];
    const server = createIpcServer({
      endpoint,
      sessionId: "session-1",
      token,
      onRequest: async ({ command }) => {
        requests.push(command);
        return { ok: true, result: { command } };
      },
    });
    await server.listening;
    return { server, endpoint, requests };
  }

  it("accepts an authenticated client and serves a command", async () => {
    const { server, endpoint, requests } = await startServer("token-a");
    try {
      const client = await createIpcClient({
        endpoint,
        sessionId: "session-1",
        token: "token-a",
      });
      const response = await client.request("tasks", {}, "r1");
      expect(response.ok).toBe(true);
      expect(requests).toEqual(["tasks"]);
      client.close();
    } finally {
      await server.close();
    }
  });

  it("refuses a wrong token without disclosing why", async () => {
    const { server, endpoint, requests } = await startServer("token-a");
    try {
      await expect(createIpcClient({ endpoint, sessionId: "session-1", token: "wrong" })).rejects.toThrowError();
      expect(requests).toEqual([]);
      expect(server.authFailures()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("refuses a client that presents the right token but the wrong session", async () => {
    const { server, endpoint, requests } = await startServer("token-a");
    try {
      // A token without the matching session is an endpoint-substitution signal.
      await expect(createIpcClient({ endpoint, sessionId: "a-different-session", token: "token-a" })).rejects.toThrowError();
      expect(requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("refuses a protocol version mismatch", async () => {
    const { server, endpoint, requests } = await startServer("token-a");
    try {
      const { createConnection } = await import("node:net");
      const socket = createConnection(endpoint);
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.write(`${JSON.stringify({ type: "hello", protocolVersion: 99, token: "token-a", sessionId: "session-1" })}\n`);
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      expect(requests).toEqual([]);
      await server.close();
    } catch (error) {
      await server.close();
      throw error;
    }
  });

  it("refuses a protocol-6 client: it would drop a run's folder unread", async () => {
    const { server, endpoint, requests } = await startServer("token-a");
    try {
      const { createConnection } = await import("node:net");
      const socket = createConnection(endpoint);
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      let answered = "";
      socket.on("data", (chunk: Buffer) => {
        answered += chunk.toString("utf8");
      });
      socket.write(`${JSON.stringify({ type: "hello", protocolVersion: 6, token: "token-a", sessionId: "session-1" })}\n`);
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      // Closed with no `ready`: the client reports the standard upgrade message from its own check.
      expect(answered).not.toContain("ready");
      expect(requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("rejects a command sent before authentication", async () => {
    const { server, endpoint, requests } = await startServer("token-a");
    const { createConnection } = await import("node:net");
    const socket = createConnection(endpoint);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    try {
      // Every command is refused until the connection is authenticated.
      socket.write(`${JSON.stringify({ type: "request", requestId: "r", command: "tasks", payload: {} })}\n`);
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      expect(requests).toEqual([]);
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it("closes an unauthenticated connection at the auth deadline", async () => {
    const directory = directories.create();
    const endpoint = join(directory, "ipc.sock");
    const server = createIpcServer({
      endpoint,
      sessionId: "s",
      token: "t",
      authDeadlineMs: 50,
      onRequest: async () => ({ ok: true }),
    });
    await server.listening;
    const { createConnection } = await import("node:net");
    const socket = createConnection(endpoint);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    try {
      // An idle peer cannot hold a slot indefinitely.
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      await waitFor(() => server.connectionCount() === 0);
      expect(server.connectionCount()).toBe(0);
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it("refuses a connection beyond the configured limit", async () => {
    const directory = directories.create();
    const endpoint = join(directory, "ipc.sock");
    const server = createIpcServer({
      endpoint,
      sessionId: "s",
      token: "t",
      maxConnections: 1,
      onRequest: async () => ({ ok: true }),
    });
    await server.listening;
    const { createConnection } = await import("node:net");
    const first = createConnection(endpoint);
    await new Promise<void>((resolve) => first.once("connect", () => resolve()));
    try {
      const second = createConnection(endpoint);
      await new Promise<void>((resolve) => second.once("close", () => resolve()));
      expect(server.connectionCount()).toBe(1);
      second.destroy();
    } finally {
      first.destroy();
      await server.close();
    }
  });

  it("holds peers that have not authenticated to their own quota, so they cannot take an authenticated client's slot", async () => {
    const directory = directories.create();
    const endpoint = join(directory, "ipc.sock");
    const server = createIpcServer({
      endpoint,
      sessionId: "session-1",
      token: "token-a",
      maxConnections: 4,
      maxUnauthenticated: 2,
      onRequest: async () => ({ ok: true }),
    });
    await server.listening;
    const { createConnection } = await import("node:net");
    const client = await rawClient(endpoint);
    const idle = [createConnection(endpoint), createConnection(endpoint)];
    try {
      await Promise.all(idle.map((socket) => new Promise<void>((resolve) => socket.once("connect", () => resolve()))));
      await waitFor(() => server.connectionCount() === 3);
      // A third peer that has not authenticated is refused although a slot is free.
      const third = createConnection(endpoint);
      await new Promise<void>((resolve) => third.once("close", () => resolve()));
      expect(server.connectionCount()).toBe(3);
      expect(client.socket.destroyed).toBe(false);
    } finally {
      for (const socket of idle) socket.destroy();
      client.socket.destroy();
      await server.close();
    }
  });

  it("destroys a connection taken before the endpoint's access is confirmed", async () => {
    const directory = directories.create();
    const endpoint = join(directory, "ipc.sock");
    let confirmed = false;
    const server = createIpcServer({
      endpoint,
      sessionId: "session-1",
      token: "token-a",
      admitting: () => confirmed,
      onRequest: async () => ({ ok: true }),
    });
    await server.listening;
    const { createConnection } = await import("node:net");
    try {
      const early = createConnection(endpoint);
      await new Promise<void>((resolve) => early.once("close", () => resolve()));
      expect(server.connectionCount()).toBe(0);
      confirmed = true;
      const client = await rawClient(endpoint);
      expect(server.connectionCount()).toBe(1);
      client.socket.destroy();
    } finally {
      await server.close();
    }
  });
});

describe("IPC credential exclusivity and outgoing frames", () => {
  const owned = (directory: string) => ({
    dataDirectory: directory,
    sessionId: "session-1",
    released: false,
  });

  it("refuses to mint or publish without live exclusive ownership", () => {
    const directory = directories.create();
    // A released owner must not be able to rotate a cookie or replace metadata:
    // that is how a second launcher would hijack a live session.
    const released = { dataDirectory: directory, sessionId: "session-1", released: true };
    expect(() => mintToken(directory, released)).toThrowError(/after ownership was released/);
    expect(() =>
      publishDiscovery(
        directory,
        {
          protocolVersion: IPC_PROTOCOL_VERSION,
          sessionId: "s2",
          endpoint: "/tmp/other.sock",
          pid: 2,
          startedAt: "t",
        },
        released,
      ),
    ).toThrowError(/after ownership was released/);
  });

  it("refuses an ownership proof for a different directory", () => {
    const directory = directories.create();
    const elsewhere = directories.create();
    expect(() => mintToken(directory, owned(elsewhere))).toThrowError(/does not cover/);
  });

  it("refuses a symlinked credential directory instead of following it", () => {
    const directory = directories.create();
    const target = directories.create();
    // A symlinked `runtime/` would write the cookie somewhere the owner never
    // chose.
    symlinkSync(target, ipcPaths(directory).directory);
    expect(() => mintToken(directory, owned(directory))).toThrowError(/symlinked IPC path/);
    expect(existsSync(join(target, "ipc.token"))).toBe(false);
  });

  it("refuses a malformed discovery document rather than publishing it", () => {
    const directory = directories.create();
    expect(() => publishDiscovery(directory, { protocolVersion: 0 } as never, owned(directory))).toThrowError(
      /malformed discovery metadata/,
    );
  });

  it("refuses to send a frame that violates the contract", () => {
    // A 3000-character error message exceeds the contract's 2000-character bound;
    // sending it would make the peer drop the connection and hang the request.
    expect(() =>
      encodeFrame({
        type: "response",
        requestId: "r",
        ok: false,
        error: { code: "INTERNAL", message: "x".repeat(3_000) },
      }),
    ).toThrowError(/violates the IPC contract/);
  });

  it("clamps a long message into the contract bound", () => {
    expect(clampMessage("x".repeat(5_000)).length).toBe(2_000);
    expect(clampMessage("short")).toBe("short");
  });

  it("survives a handler that throws, instead of killing the owner", async () => {
    const directory = directories.create();
    const endpoint = join(directory, "ipc.sock");
    const server = createIpcServer({
      endpoint,
      sessionId: "session-1",
      token: "token-a",
      onRequest: async () => {
        throw new Error("y".repeat(4_000));
      },
    });
    await server.listening;
    try {
      const client = await createIpcClient({ endpoint, sessionId: "session-1", token: "token-a" });
      const response = await client.request("tasks", {}, "r1");
      // The failure is reported as a clamped error, and the process is intact.
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("INTERNAL");
      expect((response.error?.message ?? "").length).toBeLessThanOrEqual(2_000);
      client.close();
    } finally {
      await server.close();
    }
  });

  it("retries the handshake a bounded number of times and then gives up", async () => {
    const endpoint = join(directories.create(), "ipc.sock");
    // Nothing is listening, so every attempt fails with a retryable error. The
    // delay is observable: three attempts at 25 ms spend at least two delays
    // between them, and the failure is reported instead of looping forever.
    const started = Date.now();
    await expect(
      createIpcClient({
        endpoint,
        sessionId: "session-1",
        token: "token-a",
        retryDelayMs: 25,
        // Asking for more than the contract allows must be clamped, not honoured:
        // an unbounded value here would make the upper time bound below fail.
        maxAttempts: 99,
      }),
    ).rejects.toThrowError(/ENOENT|no such file/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("refuses a substituted endpoint that answers for a different session", async () => {
    const endpoint = join(directories.create(), "ipc.sock");
    // A rogue listener that speaks the protocol: it accepts any cookie and
    // answers `ready`, but it cannot know the session the discovery record named.
    // This is the endpoint-substitution case, modelled directly.
    const rogue = createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          `${JSON.stringify({
            type: "ready",
            protocolVersion: IPC_PROTOCOL_VERSION,
            sessionId: "the-substituted-owner",
            features: [...IPC_COMMANDS],
          })}\n`,
        );
      });
    });
    await new Promise<void>((settle) => rogue.listen(endpoint, () => settle()));
    try {
      await expect(createIpcClient({ endpoint, sessionId: "the-real-owner", token: "token-a" })).rejects.toThrowError(
        /answered for session/,
      );
    } finally {
      await new Promise<void>((settle) => rogue.close(() => settle()));
    }
  });

  it("reconnects when the owner appears between attempts", async () => {
    const endpoint = join(directories.create(), "ipc.sock");
    const clientPromise = createIpcClient({
      endpoint,
      sessionId: "session-1",
      token: "token-a",
      // Wide enough that binding cannot lose the race on a loaded machine.
      retryDelayMs: 200,
    });
    // Attached immediately so a failure is reported as this test failing rather
    // than as a stray unhandled rejection.
    const guarded = clientPromise.catch((error: unknown) => {
      throw new Error(`client gave up before the owner appeared: ${String(error)}`);
    });
    // The owner binds while the client is between attempts.
    await sleep(50);
    const server = createIpcServer({
      endpoint,
      sessionId: "session-1",
      token: "token-a",
      onRequest: async () => ({ ok: true, result: { connected: true } }),
    });
    await server.listening;
    try {
      const client = await guarded;
      const response = await client.request("tasks", {}, "r1");
      expect(response.ok).toBe(true);
      client.close();
    } finally {
      await server.close();
    }
  });

  it("does not retry an authentication refusal", async () => {
    const endpoint = join(directories.create(), "ipc.sock");
    const server = createIpcServer({
      endpoint,
      sessionId: "session-1",
      token: "token-a",
      onRequest: async () => ({ ok: true }),
    });
    await server.listening;
    try {
      await expect(createIpcClient({ endpoint, sessionId: "session-1", token: "wrong", retryDelayMs: 5 })).rejects.toThrowError(
        /before authentication/,
      );
      // One presented cookie, not three: a refusal is not retried.
      expect(server.authFailures()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("bounds an oversized incoming chunk without copying it first", () => {
    const reader = new FrameReader(64);
    // A 32 MiB chunk must be refused before it is concatenated into the buffer.
    const result = reader.push(Buffer.alloc(32 * 1024 * 1024, 0x61));
    expect(result.error).toMatch(/exceeded 64 bytes/);
  });
});
