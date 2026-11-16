import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http";
import { type AddressInfo, connect as connectSocket, type Socket } from "node:net";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import type { ChannelDescriptor, InboundEvent, MessagingCapabilities, MessagingIngress } from "@tavi/contracts";

import { DatabaseClient } from "../src/persistence/client.js";
import { createMessagingService } from "../src/messaging/service.js";
import {
  applyIngressServerLimits,
  clientAddressOf,
  createChannelIngress,
  createIngressGuards,
  createTrustedProxies,
  failureKeyOf,
  isTrustedProxyEntry,
  type ChannelIngressOptions,
  INGRESS_SERVER_LIMITS,
} from "../src/messaging/ingress.js";
import { delay } from "@tavi/test-support";

/**
 * The host's webhook ingress: a request over its route's cap, over the rate limit, failing
 * verification or replaying a seen key never reaches the connector's parsing
 * or the inbox.
 */

const AT = "2026-10-09T00:00:00.000Z";
const capabilities: MessagingCapabilities = {
  receiveMode: "webhook",
  send: true,
  editOrProgress: false,
  formats: ["plain"],
  attachments: false,
  maxAttachmentBytes: 0,
  maxPartsPerMessage: 1,
  threads: false,
  interactions: false,
  deliveryReceipts: false,
  maxTextLength: 4096,
  approvals: "none",
};
const descriptor: ChannelDescriptor = {
  providerId: "hooky",
  label: "Hooky",
  kind: "chat",
  description: "d",
  settings: [],
  auth: { kind: "none" },
  sender: { label: "S", placeholder: "", pattern: ".+", normalize: "none", authentication: "provider" },
  target: { label: "T", placeholder: "", pattern: ".+", normalize: "none" },
  ingress: [
    { name: "events", methods: ["GET", "POST"], scope: "connection", maxBodyBytes: 64 },
    { name: "all", methods: ["POST"], scope: "provider", maxBodyBytes: 64 },
  ],
};

const clients: DatabaseClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

function fakeRequest(method: string, url: string, body = "", headers: Record<string, string> = {}, address?: string): IncomingMessage {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
    destroy: () => void;
    pause: () => void;
    socket?: { remoteAddress: string };
  };
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => {};
  req.pause = () => {};
  if (address !== undefined) req.socket = { remoteAddress: address };
  setImmediate(() => {
    if (body !== "") req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req as unknown as IncomingMessage;
}

function fakeResponse(): { res: ServerResponse; status: () => number | undefined; body: () => string } {
  const state: { status?: number; body: string } = { body: "" };
  const res = {
    headersSent: false,
    setHeader: () => {},
    on: () => res,
    end: (chunk?: string) => {
      state.body = chunk ?? "";
    },
    set statusCode(value: number) {
      state.status = value;
    },
    get statusCode() {
      return state.status ?? 200;
    },
  };
  return { res: res as unknown as ServerResponse, status: () => state.status, body: () => state.body };
}

async function setup(overrides: Partial<ChannelIngressOptions> = {}) {
  const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  clients.push(db);
  const calls = { verify: 0, handle: 0 };
  let failAdmission = false;
  const ingress: MessagingIngress = {
    verify: async (request) => {
      calls.verify += 1;
      const text = Buffer.from(request.rawBody).toString("utf8");
      return text.startsWith("bad") ? { ok: false } : { ok: true, replayKey: text.split(":")[0]!, replayTtlMs: 1000 };
    },
    handle: async (request, context) => {
      calls.handle += 1;
      if (request.method === "GET") return { events: [], response: { status: 200, body: request.query["challenge"] ?? "" } };
      const text = Buffer.from(request.rawBody).toString("utf8");
      // `x-as` makes it misname the connection, as a buggy or hostile connector might.
      const event: InboundEvent = {
        connectionId: request.headers["x-as"] ?? context.connection.connectionId,
        providerEventId: text,
        kind: "message",
        externalSenderId: "s",
        externalConversationId: "c",
        occurredAt: AT,
        receivedAt: AT,
        content: text,
      };
      return { events: [event] };
    },
    connectionFor: (request, connections) =>
      request.headers["x-route"] ??
      connections.find((connection) => connection.accountIdentity === request.headers["x-account"])?.connectionId,
  };
  const messaging = createMessagingService(db, {
    admit: async () => {
      if (failAdmission) throw new Error("admission failed");
    },
  });
  messaging.registerConnector({
    providerId: "hooky",
    version: "1",
    configSchema: z.unknown(),
    capabilities,
    ingress,
    createConnection: () => ({
      start: async () => {},
      stop: async () => {},
      status: () => ({ state: "running", since: AT }),
      probe: async () => ({ ok: true }),
      send: async () => ({ status: "accepted", retryable: false, parts: [] }),
    }),
  });
  for (const [connectionId, account] of [
    ["h1", "acct-1"],
    ["h2", "acct-2"],
  ] as const) {
    await messaging.openConnection({
      connection: { connectionId, providerId: "hooky", accountIdentity: account, workspaceId: "w", configRevision: 1, enabled: true },
      config: {},
    });
  }
  // A bound sender, so a recorded event goes on to admission.
  await db.repositories.messagingIdentityBindings.bind({
    connectionId: "h1",
    externalSenderId: "s",
    workspaceId: "w",
    principalId: "p",
    approvedBy: "operator",
    createdAt: AT,
  });
  let clock = Date.parse(AT);
  const handler = createChannelIngress({
    messaging,
    descriptorOf: (id) => (id === "hooky" ? descriptor : undefined),
    now: () => new Date(clock).toISOString(),
    rateBurst: 100,
    ratePerSecond: 100,
    ...overrides,
  });
  const send = async (method: string, url: string, body = "", headers: Record<string, string> = {}, address?: string) => {
    const { res, status, body: answer } = fakeResponse();
    await handler(fakeRequest(method, url, body, headers, address), res);
    return { status: status(), body: answer() };
  };
  const inbox = async (connectionId: string, id: string) => db.repositories.messagingInbox.get(connectionId, id);
  return {
    handler,
    send,
    calls,
    inbox,
    advance: (ms: number) => {
      clock += ms;
    },
    setFailAdmission: (value: boolean) => {
      failAdmission = value;
    },
  };
}

describe("createChannelIngress", () => {
  it("routes a connection's request to its connector and records the events, under a public path prefix too", async () => {
    const { send, inbox } = await setup({ pathPrefix: "/tavi" });
    expect(await send("POST", "/hooks/h1/events", "k1:hello")).toEqual({ status: 200, body: "ok" });
    expect(await send("POST", "/tavi/hooks/h1/events", "k2:again")).toEqual({ status: 200, body: "ok" });
    expect((await inbox("h1", "k1:hello"))?.payload.content).toBe("k1:hello");
    expect(await inbox("h1", "k2:again")).toBeDefined();
    // A verification challenge is answered as the connector says.
    expect(await send("GET", "/hooks/h1/events?challenge=xyz")).toEqual({ status: 200, body: "xyz" });
  });

  it("refuses before any connector code: an unknown route or connection, a method the route has not, a body over its cap", async () => {
    const { send, calls } = await setup();
    expect((await send("POST", "/hooks/h1/nope", "k:x")).status).toBe(404);
    expect((await send("POST", "/hooks/nobody/events", "k:x")).status).toBe(404);
    expect((await send("PUT", "/hooks/h1/events", "k:x")).status).toBe(405);
    expect((await send("POST", "/hooks/h1/events", `k:${"x".repeat(100)}`)).status).toBe(413);
    expect(calls.verify).toBe(0);
  });

  it("charges an address's failures, and refuses it before reading a body once they are spent, without touching others", async () => {
    let clock = Date.parse(AT);
    const guards = createIngressGuards({ now: () => new Date(clock).toISOString(), failureBurst: 3 });
    const { send, calls } = await setup({ guards });
    const attacker = "203.0.113.9";
    expect((await send("POST", "/hooks/h1/events", `k:${"x".repeat(100)}`, {}, attacker)).status).toBe(413);
    expect((await send("POST", "/hooks/h1/events", "bad:one", {}, attacker)).status).toBe(403);
    // A provider-wide request no connection accepts is a failure too.
    expect((await send("POST", "/hooks/p/hooky/all", "bad:two", {}, attacker)).status).toBe(403);
    const before = calls.verify;
    expect((await send("POST", "/hooks/h1/events", "k1:now signed", {}, attacker)).status).toBe(429);
    expect(calls.verify).toBe(before);
    // Another address, the provider's, is not held back by them.
    expect((await send("POST", "/hooks/h1/events", "k2:real", {}, "198.51.100.7")).status).toBe(200);
    // Refilled over a minute.
    clock += 60_000;
    expect((await send("POST", "/hooks/h1/events", "k3:later", {}, attacker)).status).toBe(200);
  });

  it("charges the shared rate limit only for a verified request, once, and forged floods never spend it", async () => {
    const guards = createIngressGuards({ now: () => AT, rateBurst: 2, ratePerSecond: 0.0001, failureBurst: 1000 });
    const { send, calls } = await setup({ guards });
    for (let i = 0; i < 50; i += 1) expect((await send("POST", "/hooks/h1/events", `bad:${i}`, {}, `203.0.113.${i}`)).status).toBe(403);
    expect((await send("POST", "/hooks/h1/events", "k1:real")).status).toBe(200);
    // A provider-wide request is charged to `p:<providerId>`, not to the connection that took it.
    expect((await send("POST", "/hooks/p/hooky/all", "k2:wide", { "x-account": "acct-1" })).status).toBe(200);
    expect((await send("POST", "/hooks/p/hooky/all", "k3:wide", { "x-account": "acct-2" })).status).toBe(200);
    expect((await send("POST", "/hooks/h1/events", "k4:real")).status).toBe(200);
    expect((await send("POST", "/hooks/h1/events", "k5:flood")).status).toBe(429);
    expect((await send("POST", "/hooks/p/hooky/all", "k6:wide", { "x-account": "acct-1" })).status).toBe(429);
    expect(calls.handle).toBe(4);
  });

  it("believes X-Forwarded-For only from a loopback proxy, and only its last entry", () => {
    const at = (remoteAddress: string, forwarded?: string) =>
      clientAddressOf({
        socket: { remoteAddress },
        headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
      } as unknown as IncomingMessage);
    expect(at("203.0.113.9", "198.51.100.7")).toBe("203.0.113.9");
    expect(at("127.0.0.1", "10.9.9.9, 198.51.100.7")).toBe("198.51.100.7");
    expect(at("::ffff:127.0.0.1", "198.51.100.7")).toBe("198.51.100.7");
    expect(at("::1", "2001:db8::1")).toBe("2001:db8::1");
    expect(at("127.0.0.1", "not an address")).toBe("127.0.0.1");
    expect(at("127.0.0.1")).toBe("127.0.0.1");
  });

  it("believes X-Forwarded-For from a proxy the operator trusts, and from no other peer", () => {
    const proxies = createTrustedProxies(["192.0.2.10", "10.0.0.0/8", "2001:db8:aa::/48", "not-an-address"]);
    const at = (remoteAddress: string, forwarded: string) =>
      clientAddressOf(
        { socket: { remoteAddress }, headers: { "x-forwarded-for": forwarded } } as unknown as IncomingMessage,
        proxies.trusts,
      );
    expect(at("192.0.2.10", "1.1.1.1, 198.51.100.7")).toBe("198.51.100.7");
    expect(at("::ffff:192.0.2.10", "198.51.100.7")).toBe("198.51.100.7");
    expect(at("10.20.30.40", "198.51.100.7")).toBe("198.51.100.7");
    expect(at("2001:db8:aa:1::2", "2001:db8:ff::9")).toBe("2001:db8:ff::9");
    expect(at("192.0.2.11", "198.51.100.7")).toBe("192.0.2.11");
    expect(at("11.0.0.1", "198.51.100.7")).toBe("11.0.0.1");
    expect(at("2001:db8:ab::1", "198.51.100.7")).toBe("2001:db8:ab::1");
    expect(at("127.0.0.1", "198.51.100.7")).toBe("198.51.100.7");
    // Set again (the operator changed the list): the old entries are gone, and an empty list trusts loopback only.
    proxies.set(["203.0.113.0/24"]);
    expect(at("192.0.2.10", "198.51.100.7")).toBe("192.0.2.10");
    expect(at("203.0.113.5", "198.51.100.7")).toBe("198.51.100.7");
    proxies.set([]);
    expect(at("203.0.113.5", "198.51.100.7")).toBe("203.0.113.5");
    expect(["192.0.2.1", "10.0.0.0/8", "::1", "2001:db8::/32"].every(isTrustedProxyEntry)).toBe(true);
    expect(["", "10.0.0.0/33", "2001:db8::/129", "10.0.0.0/8/1", "proxy.example.com", "10.0.0.0/x"].some(isTrustedProxyEntry)).toBe(false);
  });

  it("charges a trusted proxy's forwarded client, not the proxy, for failed deliveries", async () => {
    const guards = createIngressGuards({ now: () => AT, failureBurst: 1, trustedProxies: ["203.0.113.50"] });
    const { send } = await setup({ guards });
    expect((await send("POST", "/hooks/h1/events", "bad:1", { "x-forwarded-for": "198.51.100.1" }, "203.0.113.50")).status).toBe(403);
    expect((await send("POST", "/hooks/h1/events", "bad:2", { "x-forwarded-for": "198.51.100.1" }, "203.0.113.50")).status).toBe(429);
    // Another client behind the same proxy has its own bucket; an untrusted peer's header names nobody but itself.
    expect((await send("POST", "/hooks/h1/events", "k1:real", { "x-forwarded-for": "198.51.100.2" }, "203.0.113.50")).status).toBe(200);
    expect((await send("POST", "/hooks/h1/events", "bad:3", { "x-forwarded-for": "198.51.100.3" }, "203.0.113.51")).status).toBe(403);
    expect((await send("POST", "/hooks/h1/events", "k2:real", { "x-forwarded-for": "198.51.100.4" }, "203.0.113.51")).status).toBe(429);
  });

  it("counts an IPv6 address's failures by its /64, and any other address as it is", () => {
    expect(failureKeyOf("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(failureKeyOf("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(failureKeyOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(failureKeyOf("::1")).toBe("0:0:0:0::/64");
    expect(failureKeyOf("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(failureKeyOf("::ffff:203.0.113.9")).toBe("::ffff:203.0.113.9");
    expect(failureKeyOf("203.0.113.9")).toBe("203.0.113.9");
  });

  it("answers 503 past the bytes in flight, and gives them back however a read ends", async () => {
    const guards = createIngressGuards({ now: () => AT, maxInFlightBytes: 10 });
    const { send } = await setup({ guards });
    expect((await send("POST", "/hooks/h1/events", "k1:longer than ten")).status).toBe(503);
    expect(guards.bodyBytes.inFlight()).toBe(0);
    expect((await send("POST", "/hooks/h1/events", "k2:short")).status).toBe(200);
    expect(guards.bodyBytes.inFlight()).toBe(0);
  });

  it("holds one address's stalled bodies to its burst and its share of the bytes, so another address's delivery still lands", async () => {
    const guards = createIngressGuards({ now: () => AT, failureBurst: 20, maxInFlightBytes: 200, maxInFlightBytesPerAddress: 50 });
    const { handler } = await setup({ guards });
    const attacker = "2001:db8:1:2::9";
    // Bodies that send a few bytes and then stall, each from another address in the attacker's /64.
    const stalled = Array.from({ length: 60 }, (_, i) => {
      const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
      Object.assign(req, {
        method: "POST",
        url: "/hooks/h1/events",
        headers: {},
        socket: { remoteAddress: `2001:db8:1:2::${(i + 16).toString(16)}` },
        pause: () => {},
        destroy: () => {},
      });
      const answer = fakeResponse();
      const done = handler(req as unknown as IncomingMessage, answer.res);
      return { req, answer, done };
    });
    await new Promise((resolve) => setImmediate(resolve));
    for (const { req } of stalled) req.emit("data", Buffer.from("bad:12345"));
    await new Promise((resolve) => setImmediate(resolve));
    const statuses = stalled.map(({ answer }) => answer.status());
    // Only the burst's worth were let in to be read at all; of those, only the address's share of bytes is held.
    expect(statuses.filter((status) => status === 429)).toHaveLength(40);
    expect(statuses.filter((status) => status === 503)).toHaveLength(15);
    expect(statuses.filter((status) => status === undefined)).toHaveLength(5);
    expect(guards.bodyBytes.forAddress(failureKeyOf(attacker)).inFlight()).toBe(45);
    expect(guards.bodyBytes.inFlight()).toBe(45);
    // A signed delivery from another address is read, verified and taken.
    const { res, status } = fakeResponse();
    await handler(fakeRequest("POST", "/hooks/h1/events", "k1:real", {}, "198.51.100.7"), res);
    expect(status()).toBe(200);
    // The stalled reads end; their bytes come back, and their failures (the 503s' included) stay spent.
    for (const { req } of stalled) req.emit("close");
    await Promise.all(stalled.map(({ done }) => done));
    expect(guards.bodyBytes.inFlight()).toBe(0);
    expect(guards.failures.spent(failureKeyOf(attacker))).toBe(true);
    expect(guards.failures.spent("198.51.100.7")).toBe(false);
  });

  it("closes a connection past its address's share as it opens, but never one from loopback or a trusted proxy", async () => {
    const server = createServer(() => {});
    const trusted = new Set(["192.0.2.10"]);
    applyIngressServerLimits(server, (address) => trusted.has(address));
    const sockets: (EventEmitter & { remoteAddress: string; destroyed: boolean; destroy: () => void })[] = [];
    const connect = (remoteAddress: string) => {
      const socket = Object.assign(new EventEmitter(), {
        remoteAddress,
        destroyed: false,
        destroy() {
          socket.destroyed = true;
        },
      });
      sockets.push(socket);
      // Only the limit's own listener (the last added): the HTTP server's would start parsing this stand-in.
      (server.listeners("connection").at(-1) as (socket: unknown) => void)(socket);
      return socket;
    };
    const max = INGRESS_SERVER_LIMITS.maxConnectionsPerAddress;
    // Slow headers from one /64 hold its share and no more.
    const flood = Array.from({ length: max + 4 }, (_, i) => connect(`2001:db8:1:2::${i + 1}`));
    expect(flood.filter((socket) => socket.destroyed)).toHaveLength(4);
    // Another address, loopback and a trusted proxy still connect.
    expect(connect("198.51.100.7").destroyed).toBe(false);
    expect(Array.from({ length: max + 4 }, () => connect("127.0.0.1")).some((socket) => socket.destroyed)).toBe(false);
    expect(Array.from({ length: max + 4 }, () => connect("192.0.2.10")).some((socket) => socket.destroyed)).toBe(false);
    // A closed connection frees its slot.
    flood[0]!.emit("close");
    expect(connect("2001:db8:1:2::ff").destroyed).toBe(false);
    expect(connect("2001:db8:1:2::fe").destroyed).toBe(true);
  });

  it("over a real socket: a slow-header flood from one address leaves room for another's delivery", async () => {
    const guards = createIngressGuards({ now: () => AT });
    const { handler } = await setup({ guards });
    // Port 0: a free port, never 8025. The flood's connections come from loopback, which is exempt, so the limit is
    // told 127.0.0.1 is an outside address for this test, and the delivery comes from ::1.
    const server = createServer((req, res) => {
      void handler(req, res).catch(() => res.end());
    });
    applyIngressServerLimits(server);
    server.maxConnections = INGRESS_SERVER_LIMITS.maxConnectionsPerAddress + 4;
    const limit = server.listeners("connection").at(-1) as (socket: Socket) => void;
    server.removeListener("connection", limit);
    server.on("connection", (socket: Socket) => {
      if (socket.remoteAddress?.endsWith("127.0.0.1") !== true) return;
      const outside = { remoteAddress: "203.0.113.9", destroy: () => socket.destroy(), once: socket.once.bind(socket) };
      limit(outside as unknown as Socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "::", resolve));
    const { port } = server.address() as AddressInfo;
    const flood: Socket[] = [];
    try {
      for (let i = 0; i < INGRESS_SERVER_LIMITS.maxConnectionsPerAddress + 10; i += 1) {
        const socket = connectSocket({ host: "127.0.0.1", port });
        socket.on("error", () => {});
        socket.write("POST /hooks/h1/events HTTP/1.1\r\nHost: x\r\n");
        flood.push(socket);
      }
      await delay(100);
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: "::1", port, method: "POST", path: "/hooks/h1/events" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end("k1:signed");
      });
      expect(status).toBe(200);
    } finally {
      for (const socket of flood) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sets the server's timeouts and connection cap", () => {
    const server = createServer();
    applyIngressServerLimits(server);
    expect(server.headersTimeout).toBe(INGRESS_SERVER_LIMITS.headersTimeout);
    expect(server.requestTimeout).toBe(INGRESS_SERVER_LIMITS.requestTimeout);
    expect(server.maxConnections).toBe(INGRESS_SERVER_LIMITS.maxConnections);
  });

  it("over a real socket: a slow body is cut off and releases its bytes, and floods from spoofed addresses don't delay a signed delivery", async () => {
    const guards = createIngressGuards({ now: () => AT, failureBurst: 5, maxInFlightBytes: 32 });
    const { handler } = await setup({ guards });
    // Port 0: a free port, never 8025.
    const server = createServer({ requestTimeout: 300, connectionsCheckingInterval: 50 }, (req, res) => {
      void handler(req, res).catch(() => res.end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const post = (body: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/hooks/h1/events", headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end(body);
      });
    try {
      // A slow-loris body: a few bytes, then nothing, until the server's request timeout cuts it off.
      const closed = new Promise<void>((resolve) => {
        const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/hooks/h1/events", headers: { "content-length": "60" } });
        req.on("error", () => resolve());
        req.on("close", () => resolve());
        req.on("socket", (socket: Socket) => socket.on("close", () => resolve()));
        req.write("k9:slow");
      });
      await delay(50);
      expect(guards.bodyBytes.inFlight()).toBe(7);
      await closed;
      await delay(20);
      expect(guards.bodyBytes.inFlight()).toBe(0);
      // Forged posts through the loopback "proxy", each with a different spoofed first entry but the one address the
      // proxy forwarded last: refused once that address's failures are spent, without touching anyone else's.
      const forged: number[] = [];
      for (let i = 0; i < 10; i += 1) forged.push(await post(`bad:${i}`, { "x-forwarded-for": `192.0.2.${i}, 203.0.113.9` }));
      expect(forged.slice(0, 5).every((status) => status === 403)).toBe(true);
      expect(forged.slice(5).every((status) => status === 429)).toBe(true);
      expect(await post("k10:signed", { "x-forwarded-for": "198.51.100.7" })).toBe(200);
      // A body past the bytes every request may have in flight is answered 503 over the socket, not reset.
      expect(await post(`k11:${"x".repeat(40)}`, { "x-forwarded-for": "198.51.100.7" })).toBe(503);
      expect(guards.bodyBytes.inFlight()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a request that fails verification or replays a seen key, and takes a retry after a failed admission", async () => {
    const { send, calls, inbox, advance, setFailAdmission } = await setup();
    expect((await send("POST", "/hooks/h1/events", "bad:forged")).status).toBe(403);
    expect(calls.handle).toBe(0);
    expect(await inbox("h1", "bad:forged")).toBeUndefined();
    expect((await send("POST", "/hooks/h1/events", "k1:first")).status).toBe(200);
    expect((await send("POST", "/hooks/h1/events", "k1:other body")).status).toBe(403);
    expect(await inbox("h1", "k1:other body")).toBeUndefined();
    // Past its TTL a key is forgotten.
    advance(2000);
    expect((await send("POST", "/hooks/h1/events", "k1:later")).status).toBe(200);
    // Recorded but not admitted: 502, and the provider's retry of the same request is taken.
    setFailAdmission(true);
    expect((await send("POST", "/hooks/h1/events", "k3:flaky")).status).toBe(502);
    setFailAdmission(false);
    expect((await send("POST", "/hooks/h1/events", "k3:flaky")).status).toBe(200);
    // And the retry admits it: it is not left held.
    expect((await inbox("h1", "k3:flaky"))?.state).toBe("processed");
  });

  it("takes only the verified connection's events, and routes a provider's request only to one of its own connections", async () => {
    const { send, inbox } = await setup();
    // An event the connector names for another connection is dropped; the rest of the delivery stands.
    expect((await send("POST", "/hooks/h1/events", "k5:misnamed", { "x-as": "h2" })).status).toBe(200);
    expect(await inbox("h2", "k5:misnamed")).toBeUndefined();
    expect(await inbox("h1", "k5:misnamed")).toBeUndefined();
    // A connection the connector picks that is not one of this provider's is no connection at all.
    expect((await send("POST", "/hooks/p/hooky/all", "k6:elsewhere", { "x-route": "telegram-default" })).status).toBe(200);
    expect(await inbox("telegram-default", "k6:elsewhere")).toBeUndefined();
    expect((await send("POST", "/hooks/p/hooky/all", "k7:mine", { "x-route": "h2" })).status).toBe(200);
    expect(await inbox("h2", "k7:mine")).toBeDefined();
  });

  it("takes a retry after the connector failed for its own reasons, and treats a malformed path as unknown", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    let broken = true;
    const messaging = createMessagingService(db);
    messaging.registerConnector({
      providerId: "hooky",
      version: "1",
      configSchema: z.unknown(),
      capabilities,
      ingress: {
        verify: async () => ({ ok: true, replayKey: "same" }),
        handle: async (_request, context) => {
          if (broken) throw new Error("connector bug");
          return {
            events: [
              {
                connectionId: context.connection.connectionId,
                providerEventId: "e",
                kind: "message",
                externalSenderId: "s",
                externalConversationId: "c",
                occurredAt: AT,
                receivedAt: AT,
              },
            ],
          };
        },
      },
      createConnection: () => ({
        start: async () => {},
        stop: async () => {},
        status: () => ({ state: "running", since: AT }),
        probe: async () => ({ ok: true }),
        send: async () => ({ status: "accepted", retryable: false, parts: [] }),
      }),
    });
    await messaging.openConnection({
      connection: { connectionId: "h1", providerId: "hooky", accountIdentity: "a", workspaceId: "w", configRevision: 1, enabled: true },
      config: {},
    });
    const handler = createChannelIngress({ messaging, descriptorOf: () => descriptor, now: () => AT });
    const send = async (url: string) => {
      const { res, status } = fakeResponse();
      try {
        await handler(fakeRequest("POST", url, "x"), res);
      } catch {
        return "threw";
      }
      return status();
    };
    expect(await send("/hooks/h1/events")).toBe("threw");
    broken = false;
    expect(await send("/hooks/h1/events")).toBe(200);
    expect(await send("/hooks/%E0%A4%A/events")).toBe(404);
  });

  it("routes a provider-wide request to the connection it names, and acknowledges one that names none", async () => {
    const { send, inbox } = await setup();
    expect((await send("POST", "/hooks/p/hooky/all", "k1:for two", { "x-account": "acct-2" })).status).toBe(200);
    expect(await inbox("h2", "k1:for two")).toBeDefined();
    expect(await send("POST", "/hooks/p/hooky/all", "k2:for nobody", { "x-account": "acct-9" })).toEqual({ status: 200, body: "ok" });
  });

  it("answers what `before` takes, and refuses a POST to no hooks path", async () => {
    const { send, inbox } = await setup({
      before: async (req, res) => {
        if (!(req.url ?? "").startsWith("/i/")) return false;
        res.statusCode = 200;
        res.end("link page");
        return true;
      },
    });
    expect(await send("GET", "/i/token")).toEqual({ status: 200, body: "link page" });
    expect((await send("POST", "/old/mailgun/path", "k1:other")).status).toBe(404);
    expect(await inbox("h1", "k1:other")).toBeUndefined();
  });
});
