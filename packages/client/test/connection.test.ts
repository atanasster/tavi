import { IPC_PROTOCOL_VERSION, isProtocolMismatch, type IpcFrame } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import {
  CLIENT_DISCONNECTED,
  CLIENT_TIMEOUT,
  handshakeFailure,
  openConnection,
  type ClientResponse,
  type Connection,
} from "../src/connection.js";
import { frameTransport } from "../src/transport.js";
import { FakeOwner, channelPair, manualScheduler, settle, textEvent } from "./support/fakes.js";

/** A connection to `owner` over a fresh channel pair. */
function connect(owner: FakeOwner, credentials = { sessionId: owner.sessionId, token: owner.token }) {
  const scheduler = manualScheduler();
  const { client, server } = channelPair();
  owner.accept(server);
  const transport = frameTransport(client);
  return { scheduler, transport, opening: openConnection(transport, credentials, { scheduler }) };
}

describe("frameTransport", () => {
  it("reassembles frames split across chunks and delivers those before a bad frame, then closes", async () => {
    const { client, server } = channelPair();
    const transport = frameTransport(client);
    const frames: IpcFrame[] = [];
    let reason: string | undefined = "open";
    transport.onFrame((frame) => frames.push(frame));
    transport.onClose((why) => (reason = why));
    const hello = JSON.stringify({ type: "response", requestId: "r1", ok: true });
    server.write(new TextEncoder().encode(hello.slice(0, 10)));
    server.write(new TextEncoder().encode(`${hello.slice(10)}\n${hello}\nnot json\n`));
    await settle();
    expect(frames).toHaveLength(2);
    expect(reason).toBe("frame was not valid JSON");
    expect(transport.closed).toBe(true);
  });

  it("contains a listener that throws, and refuses to send a frame the contract forbids", async () => {
    const { client, server } = channelPair();
    const transport = frameTransport(client);
    const seen: string[] = [];
    transport.onFrame(() => {
      throw new Error("broken consumer");
    });
    transport.onFrame((frame) => seen.push(frame.type));
    server.write(new TextEncoder().encode(`${JSON.stringify({ type: "response", requestId: "r1", ok: true })}\n`));
    await settle();
    expect(seen).toEqual(["response"]);
    expect(() => transport.send({ type: "request", requestId: "", command: "tasks", payload: {} })).toThrow(/IPC contract/);
    transport.close();
    // Closed: a valid frame goes nowhere, and a late listener hears of the close at once.
    transport.send({ type: "request", requestId: "r2", command: "tasks", payload: {} });
    let heard = false;
    transport.onClose(() => (heard = true));
    expect(heard).toBe(true);
  });
});

describe("openConnection", () => {
  it("authenticates, and reports the owner's features", async () => {
    const owner = new FakeOwner("session-a");
    owner.features = ["tasks", "subscribe"];
    const { opening } = connect(owner);
    const connection = await opening;
    expect(connection.sessionId).toBe("session-a");
    expect(connection.features).toEqual(["tasks", "subscribe"]);
  });

  it("refuses an endpoint that answers for another session", async () => {
    const owner = new FakeOwner("session-a");
    owner.readySession = "session-b";
    const error = await connect(owner).opening.catch((caught: unknown) => caught);
    expect(handshakeFailure(error)).toBe("session");
    expect(String(error)).toContain("answered for session session-b, not session-a");
  });

  it("raises the typed protocol mismatch when the owner's ready disagrees with its discovery", async () => {
    const owner = new FakeOwner("session-a");
    owner.readyVersion = IPC_PROTOCOL_VERSION + 1;
    const error = await connect(owner).opening.catch((caught: unknown) => caught);
    expect(isProtocolMismatch(error)).toBe(true);
    expect(handshakeFailure(error)).toBe("protocol");
    expect(String(error)).toContain(`speaks protocol ${IPC_PROTOCOL_VERSION + 1}; this CLI speaks ${IPC_PROTOCOL_VERSION}`);
  });

  it("reports a refused cookie only as a close before authentication", async () => {
    const owner = new FakeOwner("session-a");
    const error = await connect(owner, { sessionId: "session-a", token: "wrong" }).opening.catch((caught: unknown) => caught);
    expect(handshakeFailure(error)).toBe("closed");
  });

  it("gives up on an owner that never answers the handshake", async () => {
    const owner = new FakeOwner("session-a");
    owner.accept = () => undefined;
    const { scheduler, transport, opening } = connect(owner);
    const outcome = opening.catch((caught: unknown) => caught);
    await scheduler.advance(5_000);
    expect(handshakeFailure(await outcome)).toBe("timeout");
    expect(transport.closed).toBe(true);
  });
});

describe("a connection's requests", () => {
  async function ready(): Promise<{ owner: FakeOwner; connection: Connection; scheduler: ReturnType<typeof manualScheduler> }> {
    const owner = new FakeOwner("session-a");
    owner.onRequest = () => undefined;
    const { opening, scheduler } = connect(owner);
    return { owner, connection: await opening, scheduler };
  }

  it("routes a subscription's first events after the response that created it, in the same chunk", async () => {
    const { owner, connection } = await ready();
    const order: string[] = [];
    connection.onEvent(({ subscriptionId }) => order.push(`event:${subscriptionId}`));
    const answered = connection.request("subscribe", { taskId: "task-1" }, "r1", {
      onResponse: () => order.push("response"),
    });
    await settle();
    owner.latest.burst([
      { type: "response", requestId: "r1", ok: true, result: { subscriptionId: "sub-1" } },
      { type: "event", subscriptionId: "sub-1", event: textEvent("session-a", 0) },
    ]);
    expect((await answered).ok).toBe(true);
    expect(order).toEqual(["response", "event:sub-1"]);
  });

  it("answers TIMEOUT at the deadline and DISCONNECTED when the connection drops", async () => {
    const { owner, connection, scheduler } = await ready();
    const timed = connection.request("tasks", {}, "r1", { timeoutMs: 1_000 });
    const dropped = connection.request("tasks", {}, "r2", { timeoutMs: 60_000 });
    await scheduler.advance(1_000);
    expect((await timed).error?.code).toBe(CLIENT_TIMEOUT);
    owner.latest.drop();
    await settle();
    expect((await dropped).error?.code).toBe(CLIENT_DISCONNECTED);
    // Answered at once on a closed connection.
    const late: ClientResponse = await connection.request("tasks", {}, "r3");
    expect(late.error?.code).toBe(CLIENT_DISCONNECTED);
  });

  it("passes an answer that arrives after its deadline to onResponse, not to the orphan listeners", async () => {
    const { owner, connection, scheduler } = await ready();
    const late: ClientResponse[] = [];
    const orphans: string[] = [];
    connection.onOrphanResponse((orphan) => orphans.push(orphan.requestId));
    const timed = connection.request("subscribe", { taskId: "task-1" }, "r1", {
      timeoutMs: 1_000,
      onResponse: (answer) => late.push(answer),
    });
    await scheduler.advance(1_000);
    expect((await timed).error?.code).toBe(CLIENT_TIMEOUT);
    owner.latest.answer("r1", { ok: true, result: { subscriptionId: "sub-1" } });
    // Once: a later error under the same id is a BACKLOG notice, an orphan.
    owner.latest.answer("r1", { ok: false, error: { code: "BACKLOG", message: "re-subscribe" } });
    await settle();
    expect(late).toEqual([{ ok: true, result: { subscriptionId: "sub-1" } }]);
    expect(orphans).toEqual(["r1"]);
  });

  it("refuses an id already pending, and reports an error response nothing waits for as an orphan", async () => {
    const { owner, connection } = await ready();
    void connection.request("subscribe", { taskId: "task-1" }, "r1");
    await expect(connection.request("tasks", {}, "r1")).rejects.toThrow(/already pending/);
    const orphans: string[] = [];
    connection.onOrphanResponse((orphan) => orphans.push(`${orphan.requestId}:${orphan.code}`));
    await settle();
    owner.latest.answer("r1", { ok: true, result: { subscriptionId: "sub-1" } });
    owner.latest.answer("r1", { ok: false, error: { code: "BACKLOG", message: "re-subscribe" } });
    await settle();
    expect(orphans).toEqual(["r1:BACKLOG"]);
  });

  it("closes on a frame an authenticated owner may not send", async () => {
    const { owner, connection } = await ready();
    owner.latest.transport.send({ type: "hello", protocolVersion: IPC_PROTOCOL_VERSION, token: "t", sessionId: "s" });
    await settle();
    expect(connection.closed).toBe(true);
  });
});
