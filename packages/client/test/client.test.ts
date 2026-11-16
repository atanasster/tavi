import {
  CLIENT_PROTOCOL_VERSION,
  IPC_MAX_RECONNECT_ATTEMPTS,
  IPC_PROTOCOL_VERSION,
  isProtocolMismatch,
  parseCommandPayload,
  type ClientEvent,
  type IpcCommand,
} from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import {
  ADMISSION_TIMEOUT_MS,
  isAdmission,
  RECONNECT_DELAY_MS,
  RETRY_DELAY_MS,
  createClient,
  isResendable,
  type ClientOptions,
  type ClientState,
  type TaviClient,
} from "../src/client.js";
import { CLIENT_DISCONNECTED, CLIENT_TIMEOUT, REQUEST_TIMEOUT_MS } from "../src/connection.js";
import { memoryCursorStore, type CursorStore } from "../src/cursors.js";
import {
  FakeDialer,
  FakeOwner,
  manualScheduler,
  resyncEvent,
  settle,
  textEvent,
  type ManualScheduler,
  type ReceivedRequest,
} from "./support/fakes.js";

/** A `subscribe` answer opening `subscriptionId`, with anything extra the test needs. */
function opened(subscriptionId: string, extra: Record<string, unknown> = {}) {
  return { ok: true, result: { subscriptionId, replayed: 0, resync: false, truncated: false, roundsAnsweredBy: "client", ...extra } };
}

/** An owner that opens a subscription for every `subscribe`, numbering them per owner. */
function subscribing(owner: FakeOwner, extra: (request: ReceivedRequest) => Record<string, unknown> = () => ({})): void {
  let next = 0;
  owner.onRequest = (request) => {
    if (request.command !== "subscribe") return;
    next += 1;
    request.connection.answer(request.requestId, opened(`${owner.sessionId}-sub-${next}`, extra(request)));
  };
}

function start(
  dialer: FakeDialer,
  options: Partial<Omit<ClientOptions, "dialer" | "scheduler">> = {},
): { client: TaviClient; scheduler: ManualScheduler; states: ClientState[] } {
  const scheduler = manualScheduler();
  const client = createClient({ dialer, scheduler, ...options });
  const states: ClientState[] = [];
  client.onState((state) => states.push(state));
  return { client, scheduler, states };
}

async function connected(
  owner: FakeOwner,
  options: Partial<Omit<ClientOptions, "dialer" | "scheduler">> = {},
): Promise<{ client: TaviClient; dialer: FakeDialer; scheduler: ManualScheduler; states: ClientState[] }> {
  const dialer = new FakeDialer(owner);
  const started = start(dialer, options);
  await started.client.connect();
  return { ...started, dialer };
}

const sent = (owner: FakeOwner, command: string) => owner.requests.filter((request) => request.command === command);

describe("connecting", () => {
  it("refuses an owner whose discovery names another protocol, before presenting the cookie", async () => {
    const owner = new FakeOwner("session-a");
    const dialer = new FakeDialer(owner);
    dialer.current = { ...owner.address, protocolVersion: IPC_PROTOCOL_VERSION + 1 };
    const { client } = start(dialer);
    const error = await client.connect().catch((caught: unknown) => caught);
    expect(isProtocolMismatch(error)).toBe(true);
    expect(dialer.opens).toEqual([]);
    expect(client.state).toBe("closed");
  });

  it("re-reads discovery before each attempt, with a growing pause between them", async () => {
    const owner = new FakeOwner("session-a");
    const dialer = new FakeDialer();
    const { client, scheduler, states } = start(dialer);
    const connecting = client.connect();
    await settle();
    expect(dialer.discoveries).toBe(1);
    // The owner publishes while the client waits out its first pause.
    dialer.serve(owner);
    await scheduler.advance(RETRY_DELAY_MS);
    await connecting;
    expect(dialer.discoveries).toBe(2);
    expect(scheduler.requested[0]).toBe(RETRY_DELAY_MS);
    expect(states).toEqual(["connecting", "ready"]);
    expect(client.features).toContain("run");
  });

  it(`stops after ${IPC_MAX_RECONNECT_ATTEMPTS} attempts, the contract's bound`, async () => {
    const dialer = new FakeDialer();
    const { client, scheduler } = start(dialer);
    const outcome = client.connect().catch((caught: unknown) => caught);
    await scheduler.advance(RETRY_DELAY_MS);
    await scheduler.advance(RETRY_DELAY_MS * 2);
    expect(String(await outcome)).toContain("no tavi owner is serving");
    expect(dialer.discoveries).toBe(IPC_MAX_RECONNECT_ATTEMPTS);
    await scheduler.advance(60_000);
    expect(dialer.discoveries).toBe(IPC_MAX_RECONNECT_ATTEMPTS);
  });

  it("clamps the attempts it is given to the contract's bound", async () => {
    for (const [maxAttempts, attempts] of [
      [0, 1],
      [Number.POSITIVE_INFINITY, IPC_MAX_RECONNECT_ATTEMPTS],
      [10, IPC_MAX_RECONNECT_ATTEMPTS],
    ] as const) {
      const dialer = new FakeDialer();
      const { client, scheduler } = start(dialer, { maxAttempts });
      const outcome = client.connect().catch(() => undefined);
      await scheduler.advance(60_000);
      await outcome;
      expect(dialer.discoveries, `maxAttempts ${maxAttempts}`).toBe(attempts);
    }
  });

  it("does not retry an error another attempt cannot fix", async () => {
    const owner = new FakeOwner("session-a");
    const dialer = new FakeDialer(owner);
    dialer.failOpen = () => Object.assign(new Error("permission denied"), { code: "EACCES" });
    const { client } = start(dialer);
    await expect(client.connect()).rejects.toThrow(/permission denied/);
    expect(dialer.opens).toHaveLength(1);
  });

  it("does not retry a cookie the owner discovery names refused", async () => {
    const owner = new FakeOwner("session-a");
    const dialer = new FakeDialer(owner);
    dialer.current = { ...owner.address, token: "not-the-cookie" };
    const { client } = start(dialer);
    await expect(client.connect()).rejects.toThrow(/closed before authentication/);
    expect(dialer.opens).toHaveLength(1);
  });

  it("does not retry a handshake that timed out", async () => {
    const owner = new FakeOwner("session-a");
    owner.accept = () => undefined;
    const dialer = new FakeDialer(owner);
    const { client, scheduler } = start(dialer, { handshakeTimeoutMs: 1_000 });
    const outcome = client.connect().catch((caught: unknown) => caught);
    await scheduler.advance(1_000);
    expect(String(await outcome)).toContain("did not complete the IPC handshake");
    await scheduler.advance(60_000);
    expect(dialer.opens).toHaveLength(1);
  });

  it("retries a refusal once discovery names the owner restarted at the same endpoint", async () => {
    // A crashed owner's record is still on disk; its successor has bound the
    // same socket path but not yet published. The new owner refuses the old
    // session the way a real one does: by closing.
    const endpoint = "/fake/runtime/ipc.sock";
    const crashed = new FakeOwner("session-old", { endpoint });
    const restarted = new FakeOwner("session-new", { endpoint });
    const dialer = new FakeDialer();
    dialer.current = crashed.address;
    dialer.listening.set(endpoint, restarted);
    const originalDiscover = dialer.discover.bind(dialer);
    let calls = 0;
    // The successor publishes just after the first attempt reads the stale record.
    dialer.discover = () => {
      calls += 1;
      if (calls === 2) dialer.current = restarted.address;
      return originalDiscover();
    };
    const { client, scheduler } = start(dialer);
    const connecting = client.connect().catch((caught: unknown) => caught);
    await settle();
    await scheduler.advance(RETRY_DELAY_MS);
    expect(await connecting).toBeUndefined();
    expect(restarted.connections).toHaveLength(2);
    expect(client.features).toContain("run");
  });

  it("retries an endpoint that answered for another session, reading discovery again", async () => {
    // Discovery names session-old, but the listener at its endpoint answers for another session.
    const listener = new FakeOwner("session-old", { endpoint: "/fake/shared.sock" });
    listener.readySession = "session-new";
    const dialer = new FakeDialer(listener);
    const { client, scheduler } = start(dialer);
    const connecting = client.connect().catch((caught: unknown) => caught);
    await settle();
    dialer.serve(new FakeOwner("session-new", { endpoint: "/fake/new.sock" }));
    await scheduler.advance(RETRY_DELAY_MS);
    expect(await connecting).toBeUndefined();
    expect(dialer.opens).toEqual(["/fake/shared.sock", "/fake/new.sock"]);
    expect(dialer.discoveries).toBe(2);
  });

  it("does not adopt a connection that closed in the same chunk as its ready", async () => {
    const broken = new FakeOwner("session-a");
    broken.breakAfterReady = true;
    const dialer = new FakeDialer(broken);
    const { client, scheduler, states } = start(dialer);
    const connecting = client.connect().catch((caught: unknown) => caught);
    await settle();
    expect(client.state).toBe("connecting");
    dialer.serve(new FakeOwner("session-b"));
    await scheduler.advance(RETRY_DELAY_MS);
    expect(await connecting).toBeUndefined();
    expect(states).toEqual(["connecting", "ready"]);
    expect(client.features).toContain("run");
  });

  it("stops reconnecting when closed during a pause, leaving no timer behind", async () => {
    const dialer = new FakeDialer();
    const { client, scheduler } = start(dialer);
    const outcome = client.connect().catch((caught: unknown) => caught);
    await settle();
    expect(scheduler.pending()).toBe(1);
    client.close();
    expect(scheduler.pending()).toBe(0);
    expect(String(await outcome)).toContain("closed");
    await scheduler.advance(60_000);
    expect(dialer.discoveries).toBe(1);
  });

  it("discards a handshake that completes after close()", async () => {
    const owner = new FakeOwner("session-a");
    let release: () => void = () => undefined;
    owner.holdReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dialer = new FakeDialer(owner);
    const { client } = start(dialer);
    const outcome = client.connect().catch((caught: unknown) => caught);
    await settle();
    // The owner has the hello; its ready is held while the client closes.
    expect(owner.connections).toHaveLength(1);
    client.close();
    release();
    await settle();
    expect(String(await outcome)).toContain("closed");
    expect(owner.latest.transport.closed).toBe(true);
    expect(client.state).toBe("closed");
  });

  it("refuses requests before connect(), and subscribe/run outside their own methods", async () => {
    const dialer = new FakeDialer(new FakeOwner("session-a"));
    const { client } = start(dialer);
    await expect(client.request("tasks", {})).rejects.toThrow(/connect\(\) first/);
    await expect(client.subscribe("task-1", { onEvent: () => undefined })).rejects.toThrow(/connect\(\) first/);
    await client.connect();
    await expect(client.request("subscribe", { taskId: "task-1" })).rejects.toThrow(/subscribe\(\)/);
  });

  it("gives an admitting request the admission deadline, and survives a state listener that throws", async () => {
    const owner = new FakeOwner("session-a");
    owner.onRequest = () => undefined;
    const { client, scheduler } = await connected(owner);
    client.onState(() => {
      throw new Error("broken observer");
    });
    const decision = client.request("approve", { taskId: "task-1", workspaceId: "default", expectedSteps: 1, verdict: "approve" });
    const blind = client.request("approve", { taskId: "task-1", workspaceId: "default", verdict: "approve" });
    const review = client.request("review", { taskId: "task-1", workspaceId: "default", decisions: [{ artifactId: "a", approved: true }] });
    const read = client.request("tasks", {});
    const run = client.run(
      { prompt: "p", workspaceId: "default", principal: "operator", operationKey: "op-9", approval: "client" },
      { onEvent: () => undefined },
    );
    await settle();
    expect(scheduler.requested).toEqual(expect.arrayContaining([ADMISSION_TIMEOUT_MS, REQUEST_TIMEOUT_MS]));
    await scheduler.advance(ADMISSION_TIMEOUT_MS);
    expect((await read).error?.code).toBe(CLIENT_TIMEOUT);
    expect((await read).error?.message).not.toContain("outcome is unknown");
    // An admitting request's outcome is unknown, and it says whether a retry is safe.
    expect((await decision).error).toMatchObject({ code: CLIENT_TIMEOUT, message: expect.stringContaining("the outcome is unknown") });
    expect((await decision).error?.message).toContain("again for round 1 is answered from the record");
    expect((await blind).error?.message).toContain("nothing in it makes a retry safe");
    // A review that decides without resuming is safe to repeat, and says so — as its resend does.
    expect((await review).error?.message).toContain("Sending the same decisions again records them once");
    expect(isResendable("review", { taskId: "task-1", workspaceId: "default", decisions: [{ artifactId: "a", approved: true }] })).toBe(
      true,
    );
    expect((await run).response.error?.message).toContain("under operation key op-9 rejoins it");
    client.close();
    expect(client.state).toBe("closed");
  });

  it("counts an approvals decision as an admission: its deadline, and an unknown outcome", async () => {
    expect(isAdmission("approvals", { action: "approve", taskId: "t" })).toBe(true);
    expect(isAdmission("approvals", { action: "reject", taskId: "t" })).toBe(true);
    expect(isAdmission("approvals", { action: "list" })).toBe(false);
    const owner = new FakeOwner("session-a");
    owner.onRequest = () => undefined;
    const { client, scheduler } = await connected(owner);
    const decided = client.request("approvals", { action: "approve", taskId: "task-1", workspaceId: "default" });
    await settle();
    await scheduler.advance(REQUEST_TIMEOUT_MS);
    let answered = false;
    void decided.then(() => (answered = true));
    await settle();
    // Not a read's deadline: still waiting.
    expect(answered).toBe(false);
    await scheduler.advance(ADMISSION_TIMEOUT_MS);
    expect((await decided).error).toMatchObject({ code: CLIENT_TIMEOUT, message: expect.stringContaining("the outcome is unknown") });
    client.close();
  });
});

describe("what is resent after a drop", () => {
  it("resends only a request whose payload carries its durable key", () => {
    expect(isResendable("run", { operationKey: "op-1" })).toBe(true);
    expect(isResendable("approve", { taskId: "t", expectedSteps: 2, verdict: "approve" })).toBe(true);
    // Without its round an approve decides whatever round is pending now.
    expect(isResendable("approve", { taskId: "t", verdict: "approve" })).toBe(false);
    expect(isResendable("review", { artifactId: "a", decisions: [] })).toBe(true);
    expect(isResendable("review", { taskId: "t", resume: true })).toBe(false);
    expect(isResendable("review", { taskId: "t", resume: true, expectedSteps: 1 })).toBe(true);
    expect(isResendable("reply", { workspaceId: "default", conversationId: "c", text: "hi" })).toBe(false);
    expect(isResendable("reply", { workspaceId: "default", conversationId: "c", text: "hi", clientMessageId: "m-1" })).toBe(true);
    for (const command of ["tasks", "cancel", "abort", "models", "schedules"]) expect(isResendable(command, {})).toBe(false);
  });

  it("resends on a key only when the owner's payload schema keeps that key", () => {
    // A key the schema strips is one the owner cannot answer a resend from.
    const keyed: readonly [IpcCommand, Record<string, unknown>, string][] = [
      ["run", { prompt: "p", workspaceId: "default", principal: "operator", operationKey: "op-1", approval: "client" }, "operationKey"],
      ["approve", { taskId: "t", workspaceId: "default", expectedSteps: 2, verdict: "approve" }, "expectedSteps"],
      [
        "review",
        { taskId: "t", workspaceId: "default", expectedSteps: 1, resume: true, decisions: [{ artifactId: "a", approved: true }] },
        "expectedSteps",
      ],
      ["reply", { workspaceId: "default", conversationId: "c", text: "hi", clientMessageId: "m-1" }, "clientMessageId"],
    ];
    for (const [command, payload, key] of keyed) {
      const parsed = parseCommandPayload(command, payload);
      const kept = parsed.ok && key in (parsed.value as Record<string, unknown>);
      expect(isResendable(command, payload), `${command} on ${key}`).toBe(kept);
    }
    // The contract's `reply` keeps its `clientMessageId`, so a reply carrying one is resent.
    expect(isResendable("reply", { workspaceId: "default", conversationId: "c", text: "hi", clientMessageId: "m-1" })).toBe(true);
  });

  it("sends a keyed decision again on the new connection, and answers the rest DISCONNECTED", async () => {
    const owner = new FakeOwner("session-a");
    owner.onRequest = () => undefined;
    const { client, dialer, scheduler, states } = await connected(owner);
    const keyed = client.request("approve", { taskId: "task-1", workspaceId: "default", expectedSteps: 1, verdict: "approve" });
    const unkeyed = client.request("approve", { taskId: "task-2", workspaceId: "default", verdict: "approve" });
    const read = client.request("tasks", {});
    await settle();
    owner.onRequest = (request) => request.connection.answer(request.requestId, { ok: true, result: { resent: request.command } });
    owner.latest.drop();
    await settle();
    expect((await read).error?.code).toBe(CLIENT_DISCONNECTED);
    expect((await unkeyed).error?.code).toBe(CLIENT_DISCONNECTED);
    expect(await keyed).toEqual({ ok: true, result: { resent: "approve" } });
    const approvals = sent(owner, "approve");
    expect(approvals.map((request) => (request.payload as { taskId: string }).taskId)).toEqual(["task-1", "task-2", "task-1"]);
    expect(approvals[0]?.connection).not.toBe(approvals[2]?.connection);
    expect(sent(owner, "tasks")).toHaveLength(1);
    expect(states).toEqual(["connecting", "ready", "reconnecting", "ready"]);
    expect(dialer.discoveries).toBe(2);
    // No pause is pending; only the new connection's young window, which
    // `close()` cancels.
    expect(scheduler.pending()).toBe(1);
    client.close();
    expect(scheduler.pending()).toBe(0);
  });

  it("sends a subscribe that was in flight exactly once more, on the new connection", async () => {
    const owner = new FakeOwner("session-a");
    owner.onRequest = () => undefined;
    const { client } = await connected(owner);
    const opening = client.subscribe("task-1", { from: "beginning", onEvent: () => undefined });
    await settle();
    subscribing(owner);
    owner.latest.drop();
    await settle();
    expect((await opening).subscription?.ended).toBe(false);
    const subscribes = sent(owner, "subscribe");
    expect(subscribes).toHaveLength(2);
    expect(subscribes[0]?.connection).not.toBe(subscribes[1]?.connection);
  });
});

describe("reconnecting", () => {
  it("ends for good, as a mismatch, when the owner sends a frame this client cannot read — a resumption would get it again", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const { client, dialer, scheduler } = await connected(owner);
    let ended: unknown = "not ended";
    await client.subscribe("task-1", { from: "beginning", onEvent: () => undefined, onEnd: (error) => (ended = error) });
    // An event of the next event protocol, under the same IPC protocol.
    const next = { ...textEvent("session-a", 0), protocolVersion: CLIENT_PROTOCOL_VERSION + 1 };
    owner.latest.raw(`${JSON.stringify({ type: "event", subscriptionId: "session-a-sub-1", event: next })}\n`);
    await settle();
    expect(client.state).toBe("closed");
    expect(isProtocolMismatch(ended)).toBe(true);
    expect(String(ended)).toContain("cannot read");
    // The client says why it closed, for a host to report it.
    expect(client.failure).toBe(ended);
    await scheduler.advance(60_000);
    expect(dialer.discoveries).toBe(1);
    expect(owner.connections).toHaveLength(1);
  });

  it("doubles that pause for each young death in a row, and gives up past the attempt bound", async () => {
    const owner = new FakeOwner("session-a");
    const { client, dialer, scheduler } = await connected(owner);
    let failure: unknown;
    client.onState((state) => {
      if (state === "closed") failure = "closed";
    });
    owner.latest.drop();
    await settle();
    expect(dialer.discoveries).toBe(2);
    owner.latest.drop();
    await settle();
    await scheduler.advance(RECONNECT_DELAY_MS);
    expect(dialer.discoveries).toBe(3);
    // The third in a row waits twice as long.
    owner.latest.drop();
    await settle();
    await scheduler.advance(RECONNECT_DELAY_MS);
    expect(dialer.discoveries).toBe(3);
    await scheduler.advance(RECONNECT_DELAY_MS);
    expect(dialer.discoveries).toBe(4);
    expect(client.state).toBe("ready");
    // A fourth, past the bound: the client closes rather than redial for ever.
    owner.latest.drop();
    await settle();
    expect(client.state).toBe("closed");
    expect(failure).toBe("closed");
    await expect(client.request("tasks", {})).resolves.toMatchObject({ ok: false });
    expect(scheduler.pending()).toBe(0);
    expect(dialer.discoveries).toBe(4);
  });

  it("ends a young-loss pause at once on close(), leaving no timer", async () => {
    const owner = new FakeOwner("session-a");
    const { client, scheduler } = await connected(owner);
    owner.latest.drop();
    await settle();
    owner.latest.drop();
    await settle();
    expect(client.state).toBe("reconnecting");
    client.close();
    await settle();
    expect(client.state).toBe("closed");
    expect(scheduler.pending()).toBe(0);
  });

  it("ends for good, but not as a mismatch, when the owner sends a frame out of the protocol's order", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const { client, dialer } = await connected(owner);
    let ended: unknown = "not ended";
    await client.subscribe("task-1", { from: "beginning", onEvent: () => undefined, onEnd: (error) => (ended = error) });
    owner.latest.burst([{ type: "hello", protocolVersion: IPC_PROTOCOL_VERSION, token: owner.token, sessionId: owner.sessionId }]);
    await settle();
    expect(client.state).toBe("closed");
    expect(isProtocolMismatch(ended)).toBe(false);
    expect(String(ended)).toContain("broke the IPC protocol (the owner sent hello after ready)");
    expect(client.failure).toBe(ended);
    client.close();
    // A deliberate close does not overwrite the reason it had already closed for.
    expect(client.failure).toBe(ended);
    expect(dialer.discoveries).toBe(1);
  });

  it("pauses before reconnecting to an owner whose connections keep dying young, and not after one that lived", async () => {
    const owner = new FakeOwner("session-a");
    const { client, dialer, scheduler } = await connected(owner);
    // One dies young: reconnected at once (an owner restarted just after).
    owner.latest.drop();
    await settle();
    expect(client.state).toBe("ready");
    expect(dialer.discoveries).toBe(2);
    // A second in a row: the reconnect waits its first pause.
    owner.latest.drop();
    await settle();
    expect(client.state).toBe("reconnecting");
    expect(dialer.discoveries).toBe(2);
    await scheduler.advance(RECONNECT_DELAY_MS);
    expect(client.state).toBe("ready");
    expect(dialer.discoveries).toBe(3);
    // This one outlives the window: its loss is reconnected at once again.
    await scheduler.advance(RECONNECT_DELAY_MS);
    owner.latest.drop();
    await settle();
    expect(client.state).toBe("ready");
    expect(dialer.discoveries).toBe(4);
    client.close();
  });

  it("finds a restarted owner through discovery and resubscribes from the cursor, which it answers with a resync", async () => {
    const first = new FakeOwner("session-a");
    subscribing(first);
    const { client, dialer, scheduler } = await connected(first);
    const events: ClientEvent[] = [];
    const { subscription } = await client.subscribe("task-1", { from: "beginning", onEvent: (event) => events.push(event) });
    first.latest.event("session-a-sub-1", textEvent("session-a", 0));
    first.latest.event("session-a-sub-1", textEvent("session-a", 1));
    await settle();
    expect(subscription?.cursor).toEqual({ epoch: "session-a", sequence: 1 });

    // The owner restarts: gone for a moment, then back with a new session,
    // cookie and endpoint, found only by reading discovery again.
    dialer.listening.delete(first.endpoint);
    dialer.current = undefined;
    first.latest.drop();
    await settle();
    expect(client.state).toBe("reconnecting");
    const second = new FakeOwner("session-b");
    subscribing(second);
    dialer.serve(second);
    await scheduler.advance(RECONNECT_DELAY_MS);

    expect(dialer.opens.at(-1)).toBe(second.endpoint);
    expect(sent(second, "subscribe")[0]?.payload).toEqual({ taskId: "task-1", from: { epoch: "session-a", sequence: 1 } });
    second.latest.event("session-b-sub-1", resyncEvent("session-b", 7));
    second.latest.event("session-b-sub-1", textEvent("session-b", 8));
    await settle();
    expect(events.map((event) => `${event.epoch}:${event.sequence}:${event.kind}`)).toEqual([
      "session-a:0:text.delta",
      "session-a:1:text.delta",
      "session-b:7:resync.required",
      "session-b:8:text.delta",
    ]);
    expect(subscription?.cursor).toEqual({ epoch: "session-b", sequence: 8 });
    expect(client.cursor("task-1")).toEqual({ epoch: "session-b", sequence: 8 });
  });

  it("resumes a from-now subscription the owner reported no position for, after a restart, into a resync — not the new stream's beginning", async () => {
    const first = new FakeOwner("session-a");
    subscribing(first);
    const { client, dialer, scheduler } = await connected(first);
    const events: ClientEvent[] = [];
    // From now, on a stream the owner holds nothing of: no cursor in the answer.
    await client.subscribe("task-1", { onEvent: (event) => events.push(event) });
    dialer.listening.delete(first.endpoint);
    dialer.current = undefined;
    first.latest.drop();
    await settle();
    const second = new FakeOwner("session-b");
    subscribing(second);
    dialer.serve(second);
    await scheduler.advance(RECONNECT_DELAY_MS);
    // The old session's epoch: the new owner answers it with a resync, so the gap is said.
    expect(sent(second, "subscribe")[0]?.payload).toEqual({ taskId: "task-1", from: { epoch: "session-a", sequence: 0 } });
    client.close();
  });

  it("tries again when a refused handshake finds no owner published — one shutting down, or a successor not yet published", async () => {
    const endpoint = "/fake/runtime/ipc.sock";
    const leaving = new FakeOwner("session-old", { endpoint });
    const successor = new FakeOwner("session-new", { endpoint });
    const dialer = new FakeDialer();
    dialer.current = { ...leaving.address, token: "not-the-cookie" };
    dialer.listening.set(endpoint, leaving);
    const originalDiscover = dialer.discover.bind(dialer);
    let calls = 0;
    dialer.discover = () => {
      calls += 1;
      // Refused, then nothing published; the successor publishes before the next attempt.
      if (calls === 2) dialer.current = undefined;
      if (calls === 3) {
        dialer.listening.set(endpoint, successor);
        dialer.current = successor.address;
      }
      return originalDiscover();
    };
    const { client, scheduler } = start(dialer);
    const connecting = client.connect().catch((caught: unknown) => caught);
    await settle();
    await scheduler.advance(RETRY_DELAY_MS);
    await settle();
    await scheduler.advance(RETRY_DELAY_MS * 4);
    expect(await connecting).toBeUndefined();
    expect(client.state).toBe("ready");
    client.close();
  });

  it("waits out a supervised restart with its default pauses", async () => {
    const first = new FakeOwner("session-a");
    const { client, dialer, scheduler } = await connected(first);
    dialer.current = undefined;
    first.latest.drop();
    await settle();
    // systemd restarts the owner 5 s after it stopped; it publishes a moment later.
    await scheduler.advance(RECONNECT_DELAY_MS);
    expect(client.state).toBe("reconnecting");
    await scheduler.advance(2_000);
    dialer.serve(new FakeOwner("session-b"));
    await scheduler.advance(RECONNECT_DELAY_MS * 2 - 2_000);
    expect(client.state).toBe("ready");
  });

  it("re-subscribes from the cursor after a BACKLOG drop, and drops what the replay repeats", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const { client } = await connected(owner);
    const seen: number[] = [];
    await client.subscribe("task-1", { from: "beginning", onEvent: (event) => seen.push(event.sequence) });
    const created = sent(owner, "subscribe")[0];
    owner.latest.event("session-a-sub-1", textEvent("session-a", 0));
    owner.latest.event("session-a-sub-1", textEvent("session-a", 1));
    await settle();
    owner.latest.answer(created?.requestId ?? "", { ok: false, error: { code: "BACKLOG", message: "re-subscribe from your last cursor" } });
    await settle();
    const resumed = sent(owner, "subscribe")[1];
    expect(resumed?.connection).toBe(created?.connection);
    expect(resumed?.payload).toEqual({ taskId: "task-1", from: { epoch: "session-a", sequence: 1 } });
    // An owner that replays more than it was asked for is not believed twice.
    for (const sequence of [1, 2, 3]) owner.latest.event("session-a-sub-2", textEvent("session-a", sequence));
    // The dropped subscription's id no longer routes anywhere.
    owner.latest.event("session-a-sub-1", textEvent("session-a", 4));
    await settle();
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it("resumes a subscription dropped in the same chunk as its answer, first or resumed, and gives up when it never catches up", async () => {
    const owner = new FakeOwner("session-a");
    let next = 0;
    // Every answer is followed, in the same chunk, by its BACKLOG drop.
    owner.onRequest = (request) => {
      if (request.command !== "subscribe") return;
      next += 1;
      const answer = opened(`sub-${next}`);
      request.connection.burst([
        { type: "response", requestId: request.requestId, ok: true, result: answer.result },
        { type: "response", requestId: request.requestId, ok: false, error: { code: "BACKLOG", message: "fell behind" } },
      ]);
    };
    const { client } = await connected(owner);
    const ends: unknown[] = [];
    const { subscription } = await client.subscribe("task-1", {
      from: "beginning",
      onEvent: () => undefined,
      onEnd: (error) => ends.push(error),
    });
    await settle();
    expect(sent(owner, "subscribe")).toHaveLength(IPC_MAX_RECONNECT_ATTEMPTS);
    expect(subscription?.ended).toBe(true);
    expect(String(ends[0])).toContain("fell behind");
  });

  it("keeps a subscription whose drops each came after progress", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const { client } = await connected(owner);
    const seen: number[] = [];
    const { subscription } = await client.subscribe("task-1", { from: "beginning", onEvent: (event) => seen.push(event.sequence) });
    for (let round = 0; round < IPC_MAX_RECONNECT_ATTEMPTS + 1; round += 1) {
      const creating = sent(owner, "subscribe").at(-1);
      creating?.connection.event(`session-a-sub-${round + 1}`, textEvent("session-a", round));
      await settle();
      creating?.connection.answer(creating.requestId, { ok: false, error: { code: "BACKLOG", message: "fell behind" } });
      await settle();
    }
    expect(subscription?.ended).toBe(false);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it("resumes a subscription opened from now at the position the owner reported, or from the beginning", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner, (request) =>
      (request.payload as { taskId: string }).taskId === "task-1" ? { cursor: { epoch: "session-a", sequence: 5 } } : {},
    );
    const cursors = memoryCursorStore();
    const { client } = await connected(owner, { cursors });
    await client.subscribe("task-1", { onEvent: () => undefined });
    await client.subscribe("task-2", { onEvent: () => undefined });
    // A host persisting cursors has the opening position before any event.
    expect(cursors.get("task-1")).toEqual({ epoch: "session-a", sequence: 5 });
    owner.latest.drop();
    await settle();
    const resumed = sent(owner, "subscribe")
      .slice(2)
      .map((request) => request.payload);
    expect(resumed).toEqual(
      expect.arrayContaining([
        { taskId: "task-1", from: { epoch: "session-a", sequence: 5 } },
        // Nothing of task-2's stream existed when it opened: its beginning is exact.
        { taskId: "task-2", from: "beginning" },
      ]),
    );
  });

  it("tries a resume that timed out again, with the subscription's own deadline, and adopts a late answer", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const { client, scheduler } = await connected(owner);
    const seen: number[] = [];
    const { subscription } = await client.subscribe("task-1", {
      from: "beginning",
      timeoutMs: 2_000,
      onEvent: (event) => seen.push(event.sequence),
    });
    owner.onRequest = () => undefined;
    owner.latest.drop();
    await settle();
    const first = sent(owner, "subscribe")[1];
    await scheduler.advance(2_000);
    expect(subscription?.ended).toBe(false);
    const second = sent(owner, "subscribe")[2];
    expect(second).toBeDefined();
    // The first answer arrives after all: adopted, and the second one released.
    first?.connection.answer(first.requestId, opened("sub-late"));
    await settle();
    second?.connection.answer(second.requestId, opened("sub-spare"));
    await settle();
    first?.connection.event("sub-late", textEvent("session-a", 0));
    first?.connection.event("sub-spare", textEvent("session-a", 1));
    await settle();
    expect(seen).toEqual([0]);
    expect(sent(owner, "unsubscribe").map((request) => request.payload)).toEqual([{ subscriptionId: "sub-spare" }]);
  });

  it("releases what a subscription it closed mid-resume, or one that timed out, was answered with", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const { client, scheduler } = await connected(owner);
    const { subscription } = await client.subscribe("task-1", { from: "beginning", onEvent: () => undefined });
    owner.onRequest = () => undefined;
    owner.latest.drop();
    await settle();
    await subscription?.close();
    const resume = sent(owner, "subscribe").at(-1);
    resume?.connection.answer(resume.requestId, opened("sub-orphaned"));

    const timingOut = client.subscribe("task-2", { from: "beginning", onEvent: () => undefined });
    await settle();
    await scheduler.advance(REQUEST_TIMEOUT_MS);
    expect((await timingOut).response.error?.code).toBe(CLIENT_TIMEOUT);
    const late = sent(owner, "subscribe").at(-1);
    late?.connection.answer(late.requestId, opened("sub-too-late"));
    await settle();
    expect(sent(owner, "unsubscribe").map((request) => request.payload)).toEqual([
      { subscriptionId: "sub-orphaned" },
      { subscriptionId: "sub-too-late" },
    ]);
  });

  it("ends a subscription the owner refuses to resume, and one whose consumer throws", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const { client } = await connected(owner);
    const ends: unknown[] = [];
    const { subscription: refused } = await client.subscribe("task-1", {
      from: "beginning",
      onEvent: () => undefined,
      onEnd: (error) => ends.push(error),
    });
    const { subscription: broken } = await client.subscribe("task-2", {
      from: "beginning",
      onEvent: () => {
        throw new Error("reducer rejected the event");
      },
      onEnd: (error) => ends.push(error),
    });
    owner.latest.event("session-a-sub-2", textEvent("session-a", 0));
    await settle();
    expect(broken?.ended).toBe(true);
    expect(String(ends[0])).toContain("reducer rejected the event");
    expect(owner.requests.at(-1)).toMatchObject({ command: "unsubscribe", payload: { subscriptionId: "session-a-sub-2" } });

    owner.onRequest = (request) =>
      request.connection.answer(request.requestId, { ok: false, error: { code: "NOT_FOUND", message: "Task task-1 does not exist" } });
    owner.latest.drop();
    await settle();
    expect(refused?.ended).toBe(true);
    expect(String(ends[1])).toContain("Task task-1 does not exist");
  });

  it("ends a subscription whose cursor store fails, rather than skipping the event", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const failing: CursorStore = {
      get: () => undefined,
      set: () => {
        throw new Error("disk full");
      },
    };
    const { client } = await connected(owner, { cursors: failing });
    const seen: number[] = [];
    const ends: unknown[] = [];
    await client.subscribe("task-1", {
      from: "beginning",
      onEvent: (event) => seen.push(event.sequence),
      onEnd: (error) => ends.push(error),
    });
    owner.latest.event("session-a-sub-1", textEvent("session-a", 0));
    await settle();
    expect(seen).toEqual([]);
    expect(String(ends[0])).toContain("disk full");
  });

  it("does not keep a stored cursor past an event its consumer could not apply", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const cursors = memoryCursorStore();
    const { client } = await connected(owner, { cursors });
    await client.subscribe("task-1", {
      from: "beginning",
      onEvent: (event) => {
        if (event.sequence === 1) throw new Error("cannot apply");
      },
    });
    owner.latest.event("session-a-sub-1", textEvent("session-a", 0));
    owner.latest.event("session-a-sub-1", textEvent("session-a", 1));
    await settle();
    // A host resuming from the store gets sequence 1 again.
    expect(client.cursor("task-1")).toEqual({ epoch: "session-a", sequence: 0 });
  });

  it("never moves a task's stored cursor back when two subscriptions follow it", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const cursors = memoryCursorStore();
    const { client } = await connected(owner, { cursors });
    await client.subscribe("task-1", { onEvent: () => undefined });
    await client.subscribe("task-1", { from: "beginning", onEvent: () => undefined });
    owner.latest.event("session-a-sub-1", textEvent("session-a", 9));
    for (const sequence of [0, 1, 2]) owner.latest.event("session-a-sub-2", textEvent("session-a", sequence));
    await settle();
    expect(client.cursor("task-1")).toEqual({ epoch: "session-a", sequence: 9 });
  });

  it("hands out a subscription without its routing", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const { client } = await connected(owner);
    const { subscription } = await client.subscribe("task-1", { from: "beginning", onEvent: () => undefined });
    expect(Object.keys(subscription ?? {}).sort()).toEqual(["close", "cursor", "ended", "taskId"]);
    expect((subscription as unknown as Record<string, unknown>)["subscriptionId"]).toBeUndefined();
  });

  it("closes for good when the owner does not come back, ending subscriptions and keyed requests", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const { client, dialer, scheduler, states } = await connected(owner);
    const ends: unknown[] = [];
    await client.subscribe("task-1", { from: "beginning", onEvent: () => undefined, onEnd: (error) => ends.push(error) });
    owner.onRequest = () => undefined;
    const decision = client.request("approve", { taskId: "task-1", workspaceId: "default", expectedSteps: 1, verdict: "approve" });
    await settle();
    dialer.current = undefined;
    owner.latest.drop();
    await settle();
    await scheduler.advance(RECONNECT_DELAY_MS * 3);
    expect(client.state).toBe("closed");
    expect(states.at(-1)).toBe("closed");
    expect((await decision).error?.code).toBe(CLIENT_DISCONNECTED);
    expect(String(ends[0])).toContain("no tavi owner is serving");
  });

  it("ends every subscription without an error when closed deliberately", async () => {
    const owner = new FakeOwner("session-a");
    subscribing(owner);
    const { client } = await connected(owner);
    const ends: unknown[] = [];
    await client.subscribe("task-1", { from: "beginning", onEvent: () => undefined, onEnd: (error) => ends.push(error) });
    client.close();
    expect(ends).toEqual([undefined]);
    expect((await client.request("tasks", {})).error?.code).toBe(CLIENT_DISCONNECTED);
    await expect(client.connect()).rejects.toThrow(/closed/);
  });
});

describe("run", () => {
  it("follows the stream a run opens, routing events that share the answer's chunk, and rejoins by resending", async () => {
    const owner = new FakeOwner("session-a");
    let answered = false;
    owner.onRequest = (request) => {
      if (request.command !== "run") return;
      // The first send is lost with its connection; the resend is answered
      // together with the replayed start of the stream.
      if (!answered) {
        answered = true;
        request.connection.drop();
        return;
      }
      request.connection.burst([
        {
          type: "response",
          requestId: request.requestId,
          ok: true,
          result: { taskId: "task-9", subscriptionId: "sub-run", created: false, replay: true, replayed: 1 },
        },
        { type: "event", subscriptionId: "sub-run", event: textEvent("session-a", 0) },
      ]);
    };
    const cursors = memoryCursorStore();
    const { client } = await connected(owner, { cursors });
    const seen: number[] = [];
    const payload = { prompt: "hello", workspaceId: "default", principal: "operator", operationKey: "op-1", approval: "client" as const };
    const { response, subscription } = await client.run(payload, { onEvent: (event) => seen.push(event.sequence) });
    expect(response.ok).toBe(true);
    expect(subscription?.taskId).toBe("task-9");
    expect(seen).toEqual([0]);
    expect(cursors.get("task-9")).toEqual({ epoch: "session-a", sequence: 0 });
    expect(sent(owner, "run").map((request) => request.payload)).toEqual([payload, payload]);
  });

  it("releases the stream of a run whose answer came after its deadline", async () => {
    const owner = new FakeOwner("session-a");
    owner.onRequest = () => undefined;
    const { client, scheduler } = await connected(owner);
    const payload = { prompt: "hello", workspaceId: "default", principal: "operator", operationKey: "op-2", approval: "client" as const };
    const running = client.run(payload, { onEvent: () => undefined, timeoutMs: 1_000 });
    await settle();
    await scheduler.advance(1_000);
    expect((await running).response.error?.code).toBe(CLIENT_TIMEOUT);
    const late = sent(owner, "run")[0];
    late?.connection.answer(late.requestId, {
      ok: true,
      result: { taskId: "task-9", subscriptionId: "sub-late-run", created: true, replay: false, replayed: 0 },
    });
    await settle();
    expect(sent(owner, "unsubscribe").map((request) => request.payload)).toEqual([{ subscriptionId: "sub-late-run" }]);
  });
});

describe("liveWatch", () => {
  const frame = {
    kind: "frame",
    sessionId: "s1",
    mime: "image/jpeg",
    data: "/9j/",
    width: 16,
    height: 9,
    metadata: { deviceWidth: 16, deviceHeight: 9, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 },
    at: "2026-10-03T10:00:00.000Z",
    source: "live",
  } as const;

  /** An owner that answers every watch with a new live subscription. */
  function watching(owner: FakeOwner, sessions: readonly unknown[] = [{ sessionId: "s1", taskId: "task-1", state: "open" }]): void {
    let next = 0;
    owner.onRequest = (request) => {
      if (request.command !== "browser-live") return;
      const payload = request.payload as { action: string };
      if (payload.action === "watch") {
        next += 1;
        request.connection.answer(request.requestId, { ok: true, result: { subscriptionId: `${owner.sessionId}-live-${next}`, sessions } });
      } else {
        request.connection.answer(request.requestId, { ok: true, result: { ok: true } });
      }
    };
  }

  it("routes a watch's messages, acks a frame on its own binding, and re-watches after the owner restarts", async () => {
    const first = new FakeOwner("session-a");
    watching(first);
    const { client, dialer, scheduler } = await connected(first);
    const seen: string[] = [];
    const sessions: number[] = [];
    let ack: (() => void) | undefined;
    const { watch, response } = await client.liveWatch("task-1", {
      workspaceId: "default",
      maxWidth: 640,
      onMessage: (message, acknowledge) => {
        seen.push(message.kind);
        if (message.kind === "frame") ack = acknowledge;
      },
      onSessions: (listed) => sessions.push(listed.length),
    });
    expect(response.ok).toBe(true);
    expect(sent(first, "browser-live")[0]?.payload).toEqual({ action: "watch", workspaceId: "default", taskId: "task-1", maxWidth: 640 });
    first.latest.burst([
      {
        type: "live",
        subscriptionId: "session-a-live-1",
        seq: 0,
        message: { kind: "session", sessionId: "s1", taskId: "task-1", state: "open" },
      },
      { type: "live", subscriptionId: "session-a-live-1", seq: 1, message: frame },
      { type: "live", subscriptionId: "someone-else", seq: 0, message: frame },
    ]);
    await settle();
    expect(seen).toEqual(["session", "frame"]);
    ack?.();
    ack?.();
    await settle();
    expect(
      sent(first, "browser-live")
        .slice(1)
        .map((request) => request.payload),
    ).toEqual([{ action: "ack", subscriptionId: "session-a-live-1", seq: 1 }]);

    dialer.listening.delete(first.endpoint);
    dialer.current = undefined;
    first.latest.drop();
    await settle();
    const second = new FakeOwner("session-b");
    watching(second);
    dialer.serve(second);
    await scheduler.advance(RECONNECT_DELAY_MS);
    await settle();
    expect(sent(second, "browser-live")[0]?.payload).toEqual({ action: "watch", workspaceId: "default", taskId: "task-1", maxWidth: 640 });
    expect(sessions).toEqual([1, 1]);
    // A frame acknowledged after the reconnect belongs to a binding that is gone.
    ack?.();
    await watch?.close();
    expect(
      sent(second, "browser-live")
        .slice(1)
        .map((request) => request.payload),
    ).toEqual([{ action: "unwatch", subscriptionId: "session-b-live-1" }]);
    expect(watch?.ended).toBe(true);
  });

  it("tells the watcher a session ended when the re-watch after a restart no longer has it", async () => {
    const first = new FakeOwner("session-a");
    watching(first);
    const { client, dialer, scheduler } = await connected(first);
    const seen: unknown[] = [];
    const { watch } = await client.liveWatch("task-1", { workspaceId: "default", onMessage: (message) => seen.push(message) });
    first.latest.burst([
      {
        type: "live",
        subscriptionId: "session-a-live-1",
        seq: 0,
        message: { kind: "session", sessionId: "s2", taskId: "task-1", state: "open" },
      },
    ]);
    await settle();
    dialer.listening.delete(first.endpoint);
    dialer.current = undefined;
    first.latest.drop();
    await settle();
    // The restarted owner closed every session the old one had.
    const second = new FakeOwner("session-b");
    watching(second, []);
    dialer.serve(second);
    await scheduler.advance(RECONNECT_DELAY_MS);
    await settle();
    expect(seen.slice(1)).toEqual([
      { kind: "ended", sessionId: "s1", reason: "owner restarted" },
      { kind: "ended", sessionId: "s2", reason: "owner restarted" },
    ]);
    expect(watch?.ended).toBe(false);
    await watch?.close();
  });

  it("refuses a watch through request(), and answers a first watch the owner refuses without a watch", async () => {
    const owner = new FakeOwner("session-a");
    watching(owner);
    const { client } = await connected(owner);
    await expect(client.request("browser-live", { action: "watch", workspaceId: "default", taskId: "t" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    owner.onRequest = (request) =>
      request.connection.answer(request.requestId, { ok: false, error: { code: "NOT_FOUND", message: "no task t" } });
    const refused = await client.liveWatch("t", { workspaceId: "default", onMessage: () => undefined });
    expect(refused.watch).toBeUndefined();
    expect(refused.response.error?.code).toBe("NOT_FOUND");
  });

  it("ends a watch, with an error, when the owner refuses to reopen it, drops it, or its consumer throws — and unwatches a thrower", async () => {
    const first = new FakeOwner("session-a");
    watching(first);
    const { client, dialer, scheduler } = await connected(first);
    const ends: unknown[] = [];
    const watchWith = (onMessage: () => void) =>
      client.liveWatch("task-1", { workspaceId: "default", onMessage, onEnd: (error) => ends.push(error) });

    // The consumer throws: the watch ends, and is unwatched at the owner.
    const throwing = await watchWith(() => {
      throw new Error("bad consumer");
    });
    first.latest.burst([{ type: "live", subscriptionId: "session-a-live-1", seq: 0, message: frame }]);
    await settle();
    expect(throwing.watch?.ended).toBe(true);
    expect((ends[0] as Error).message).toBe("bad consumer");
    expect(sent(first, "browser-live").map((request) => request.payload)).toContainEqual({
      action: "unwatch",
      subscriptionId: "session-a-live-1",
    });

    // The owner drops it: reported under the request that opened it.
    const dropped = await watchWith(() => undefined);
    const opening = sent(first, "browser-live")
      .filter((request) => (request.payload as { action: string }).action === "watch")
      .at(-1);
    first.latest.burst([
      { type: "response", requestId: opening?.requestId ?? "", ok: false, error: { code: "BACKLOG", message: "dropped" } },
    ]);
    await settle();
    expect(dropped.watch?.ended).toBe(true);
    expect(ends[1]).toMatchObject({ code: "UNAVAILABLE", details: { code: "BACKLOG" } });

    // After a restart, the owner refuses to reopen it.
    const lateMessages: unknown[] = [];
    const refusedLater = await client.liveWatch("task-1", {
      workspaceId: "default",
      onMessage: (message) => lateMessages.push(message),
      onEnd: (error) => ends.push(error),
    });
    dialer.listening.delete(first.endpoint);
    dialer.current = undefined;
    first.latest.drop();
    await settle();
    const second = new FakeOwner("session-b");
    second.onRequest = (request) =>
      request.connection.answer(request.requestId, { ok: false, error: { code: "NOT_FOUND", message: "no task" } });
    dialer.serve(second);
    await scheduler.advance(RECONNECT_DELAY_MS);
    await settle();
    expect(refusedLater.watch?.ended).toBe(true);
    expect(ends[2]).toMatchObject({ code: "UNAVAILABLE", details: { code: "NOT_FOUND" } });
    // The sessions it knew are told they ended before the watch does.
    expect(lateMessages).toEqual([{ kind: "ended", sessionId: "s1", reason: "owner restarted" }]);
  });
});
