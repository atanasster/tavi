import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { TaviError, type ChannelDescriptor, type MessagingCapabilities, type MessagingConnection } from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";

import { DatabaseClient } from "../src/persistence/client.js";
import { createMessagingService } from "../src/messaging/service.js";
import { ChannelHost, PROVIDER_MISSING, type ChannelAttachment } from "../src/messaging/channel-host.js";

/** The channel host. */

const AT = "2026-10-09T00:00:00.000Z";
const capabilities: MessagingCapabilities = {
  receiveMode: "none",
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
  providerId: "example",
  label: "Example",
  kind: "chat",
  description: "d",
  settings: [{ key: "region", label: "Region", type: "string" }],
  auth: {
    kind: "secrets",
    fields: [
      { key: "token", label: "Token" },
      { key: "signing", label: "Signing key" },
    ],
  },
  sender: { label: "S", placeholder: "", pattern: ".+", normalize: "none", authentication: "provider" },
  target: { label: "T", placeholder: "", pattern: ".+", normalize: "none" },
};

const clients: DatabaseClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function setup(
  options: {
    readonly failing?: Set<string>;
    readonly refused?: Set<string>;
    readonly failOnce?: Set<string>;
    readonly attachments?: Readonly<Record<string, ChannelAttachment>>;
    readonly openAttempts?: number;
    readonly installed?: () => boolean;
    readonly sendGate?: () => Promise<void>;
  } = {},
) {
  const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  clients.push(db);
  const opened: { connection: MessagingConnection; config: unknown }[] = [];
  const closed: string[] = [];
  /** Which opening of its connection each send went through. */
  const sentThrough: number[] = [];
  const messaging = createMessagingService(db);
  messaging.registerConnector({
    providerId: "example",
    version: "1",
    configSchema: z.record(z.string(), z.unknown()),
    capabilities,
    createConnection: ({ connection, config }) => ({
      start: async () => {
        if (options.failing?.has(connection.connectionId)) throw new Error("bad token");
        if (options.refused?.has(connection.connectionId))
          throw new TaviError("NOT_AUTHORIZED", "token refused", { details: { repair: "credentials" } });
        if (options.failOnce?.delete(connection.connectionId) === true) throw new Error("blip");
        opened.push({ connection, config });
      },
      stop: async () => {
        closed.push(connection.connectionId);
      },
      status: () => ({ state: "running", since: AT }),
      probe: async () => ({ ok: true }),
      send: async () => {
        const generation = opened.filter((entry) => entry.connection.connectionId === connection.connectionId).length;
        await options.sendGate?.();
        sentThrough.push(generation);
        return { status: "accepted", retryable: false, parts: [] };
      },
    }),
  });
  const host = new ChannelHost({
    messaging,
    connections: db.repositories.messagingConnections,
    workspaceIds: ["w1", "w2"],
    descriptorOf: (providerId) => (providerId === "example" && (options.installed?.() ?? true) ? descriptor : undefined),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => AT,
    openAttempts: options.openAttempts ?? 1,
    retryDelaysMs: [1, 1],
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
  });
  const save = (connectionId: string, workspaceId: string, extra: { enabled?: boolean; region?: string } = {}) =>
    db.repositories.messagingConnections.save(
      {
        connectionId,
        providerId: "example",
        workspaceId,
        accountIdentity: "bot",
        settings: { region: extra.region ?? "eu" },
        credentialRefs: { token: `ref.${connectionId}.token`, signing: `ref.${connectionId}.signing` },
        enabled: extra.enabled ?? true,
        authState: "none",
      },
      AT,
    );
  return { db, host, opened, closed, save, messaging, sentThrough };
}

describe("ChannelHost", () => {
  it("opens every served workspace's enabled saved connections, with its secrets as references and its settings as the config", async () => {
    const { host, opened, save } = await setup();
    await save("a", "w1");
    await save("b", "w2");
    await save("off", "w1", { enabled: false });
    await save("elsewhere", "w9");
    await host.load();
    await host.start();
    expect(opened.map((entry) => entry.connection.connectionId).sort()).toEqual(["a", "b"]);
    expect(opened.find((entry) => entry.connection.connectionId === "a")).toMatchObject({
      connection: { credentialRef: "ref.a.token", credentialRefs: { token: "ref.a.token", signing: "ref.a.signing" } },
      config: { region: "eu" },
    });
    expect(host.list().map((view) => [view.connectionId, view.status.state])).toEqual([
      ["a", "running"],
      ["b", "running"],
      ["off", "stopped"],
    ]);
  });

  it("applies a save, a disable and a new connection on reload, touching nothing else", async () => {
    const { host, opened, closed, save } = await setup();
    await save("a", "w1");
    await save("b", "w1");
    await host.load();
    await host.start();
    await save("a", "w1", { region: "us" });
    await save("b", "w1", { enabled: false });
    await save("c", "w2");
    await host.reload();
    expect(closed.sort()).toEqual(["a", "b"]);
    expect(opened.map((entry) => entry.connection.connectionId)).toEqual(["a", "b", "a", "c"]);
    expect(opened[2]?.config).toMatchObject({ region: "us" });
  });

  it("keeps the repair a connector named on the error it failed to open with, and reads a running one's from the service", async () => {
    const { host, save } = await setup({ refused: new Set(["revoked"]), failing: new Set(["bad"]) });
    await save("revoked", "w1");
    await save("bad", "w1");
    await save("good", "w2");
    await host.load();
    await host.start();
    expect(host.statusOf("revoked")).toMatchObject({ state: "failed", detail: "token refused", repair: "credentials" });
    expect(host.statusOf("bad")).not.toHaveProperty("repair");
    expect(host.statusOf("good")).toMatchObject({ state: "running" });
  });

  it("reports a saved connection that cannot open and opens the rest", async () => {
    const { host, opened, save } = await setup({ failing: new Set(["bad"]) });
    await save("bad", "w1");
    await save("good", "w2");
    await host.load();
    await host.start();
    expect(opened.map((entry) => entry.connection.connectionId)).toEqual(["good"]);
    expect(host.list().find((view) => view.connectionId === "bad")?.status).toMatchObject({ state: "failed", detail: "bad token" });
  });

  it("opens nothing on a reload before start or after close, and retries a connection that fails once", async () => {
    const { host, opened, closed, save } = await setup({ failOnce: new Set(["a"]), openAttempts: 2 });
    await save("a", "w1");
    await host.load();
    await host.reload();
    expect(opened).toEqual([]);
    await host.start();
    expect(opened.map((entry) => entry.connection.connectionId)).toEqual(["a"]);
    await host.close();
    expect(closed).toEqual(["a"]);
    await save("b", "w1");
    await host.reload();
    expect(opened.map((entry) => entry.connection.connectionId)).toEqual(["a"]);
  });

  it("opens a provider's attachment with its connection, closes it first, and does not keep a connection whose attachment failed", async () => {
    const events: string[] = [];
    const attachment: ChannelAttachment = {
      open: async (record) => {
        if (record.connectionId === "broken") throw new Error("port in use");
        events.push(`open ${record.connectionId}`);
      },
      close: async (connectionId) => {
        events.push(`close ${connectionId}`);
      },
    };
    const { host, closed, save } = await setup({ attachments: { example: attachment } });
    await save("a", "w1");
    await save("broken", "w2");
    await host.load();
    await host.start();
    expect(host.list().find((view) => view.connectionId === "broken")?.status).toMatchObject({ state: "failed", detail: "port in use" });
    expect(closed).toEqual(["broken"]);
    await host.close();
    expect(events).toEqual(["open a", "close a"]);
    expect(closed).toEqual(["broken", "a"]);
  });

  it("keeps a connection whose channel is not installed closed and says so, and opens it once the channel is back", async () => {
    let installed = false;
    const { host, opened, save } = await setup({ installed: () => installed });
    await save("a", "w1");
    await host.load();
    await host.start();
    expect(opened).toEqual([]);
    expect(host.list()[0]?.status).toMatchObject({ state: "stopped", detail: PROVIDER_MISSING });
    installed = true;
    await host.reload();
    expect(opened.map((entry) => entry.connection.connectionId)).toEqual(["a"]);
    expect(host.list()[0]?.status.state).toBe("running");
  });

  it("reopens a changed connection after its send in flight finishes, and a send meanwhile goes through the new one", async () => {
    let releaseFirst = (): void => undefined;
    const gates = [
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    ];
    const { host, save, messaging, sentThrough, closed } = await setup({ sendGate: () => gates.shift() ?? Promise.resolve() });
    await save("a", "w1");
    await host.load();
    await host.start();
    const message = (effectId: string) => ({ effectId, connectionId: "a", destination: { to: "x" }, parts: [{ content: "hi" }] });
    const inFlight = messaging.send(message("e1"));
    await save("a", "w1", { region: "us" });
    const reloading = host.reload();
    // The close waits for the send already in the connector.
    await sleep(20);
    expect(closed).toEqual([]);
    const meanwhile = messaging.send(message("e2"));
    releaseFirst();
    await reloading;
    expect((await inFlight).status).toBe("accepted");
    expect((await meanwhile).status).toBe("accepted");
    expect(closed).toEqual(["a"]);
    // The first through the old opening, the second through the new.
    expect(sentThrough).toEqual([1, 2]);
  });

  it("lets a send held for a reopen go, refused, when the connection cannot open again", async () => {
    const failing = new Set<string>();
    let releaseFirst = (): void => undefined;
    const gates = [
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    ];
    const { host, save, messaging } = await setup({ failing, sendGate: () => gates.shift() ?? Promise.resolve() });
    await save("a", "w1");
    await host.load();
    await host.start();
    const message = (effectId: string) => ({ effectId, connectionId: "a", destination: { to: "x" }, parts: [{ content: "hi" }] });
    const inFlight = messaging.send(message("e1"));
    failing.add("a");
    await save("a", "w1", { region: "us" });
    const reloading = host.reload();
    await sleep(20);
    const held = messaging.send(message("e2")).then(
      () => undefined,
      (error: unknown) => error,
    );
    releaseFirst();
    await reloading;
    expect((await inFlight).status).toBe("accepted");
    // Released as soon as the reopen failed, not after the 30 s wait.
    expect(await held).toMatchObject({ code: "NOT_FOUND" });
    expect(host.list()[0]?.status).toMatchObject({ state: "failed", detail: "bad token" });
  });

  it("keeps an OAuth connection closed until it is signed in, and lets its connector read no sign-in secret", async () => {
    const db = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(db);
    const oauthDescriptor: ChannelDescriptor = {
      ...descriptor,
      providerId: "inbox",
      auth: {
        kind: "oauth2",
        oauth: {
          authorizeUrl: "https://a.example.com/a",
          tokenUrl: "https://a.example.com/t",
          scopes: [],
          pkce: true,
          client: { source: "operator" },
          redirect: "loopback-any-port",
          tokenAuthMethod: "none",
        },
      },
    };
    const seen: { token?: string; oauthKey?: string } = {};
    const messaging = createMessagingService(db, {
      accessToken: async () => "access-token",
      hiddenCredential: (reference) => reference.startsWith("channels.oauth-client."),
      readSecret: async () => "secret-value",
    });
    messaging.registerConnector({
      providerId: "inbox",
      version: "1",
      configSchema: z.record(z.string(), z.unknown()),
      capabilities,
      createConnection: ({ credentials }) => ({
        start: async () => {
          seen.token = await credentials.accessToken();
          seen.oauthKey = await credentials.get("oauth").then(String, (error: unknown) => `refused: ${String(error)}`);
        },
        stop: async () => {},
        status: () => ({ state: "running", since: AT }),
        probe: async () => ({ ok: true }),
        send: async () => ({ status: "accepted", retryable: false, parts: [] }),
      }),
    });
    const host = new ChannelHost({
      messaging,
      connections: db.repositories.messagingConnections,
      workspaceIds: ["w1"],
      descriptorOf: (id) => (id === "inbox" ? oauthDescriptor : undefined),
      log: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => AT,
      openAttempts: 1,
    });
    await db.repositories.messagingConnections.save(
      {
        connectionId: "mail",
        providerId: "inbox",
        workspaceId: "w1",
        accountIdentity: "Inbox",
        settings: {},
        credentialRefs: {},
        enabled: true,
        authState: "none",
      },
      AT,
    );
    await host.load();
    await host.start();
    expect(host.list()[0]?.status).toMatchObject({ state: "stopped", detail: "not connected: sign in to use it" });
    expect(seen).toEqual({});
    await db.repositories.messagingConnections.markConnected({
      connectionId: "mail",
      workspaceId: "w1",
      accountIdentity: "ana@example.com",
      tokenRef: "channels.x.oauth",
      now: AT,
    });
    await host.reload();
    expect(host.list()[0]?.status.state).toBe("running");
    expect(seen.token).toBe("access-token");
    // A save keeps the sign-in as it is now, whatever the saver read before it.
    await db.repositories.messagingConnections.save(
      {
        connectionId: "mail",
        providerId: "inbox",
        workspaceId: "w1",
        accountIdentity: "Inbox",
        settings: {},
        credentialRefs: {},
        enabled: true,
        authState: "none",
      },
      AT,
    );
    expect(await db.repositories.messagingConnections.get("mail")).toMatchObject({
      authState: "connected",
      accountIdentity: "ana@example.com",
      credentialRefs: { oauth: "channels.x.oauth" },
    });
    // Removed and saved again under its id, it comes back signed out.
    await db.repositories.messagingConnections.remove("mail", AT);
    await db.repositories.messagingConnections.save(
      {
        connectionId: "mail",
        providerId: "inbox",
        workspaceId: "w1",
        accountIdentity: "Inbox",
        settings: {},
        credentialRefs: { oauth: "channels.x.oauth" },
        enabled: true,
        authState: "connected",
      },
      AT,
    );
    expect(await db.repositories.messagingConnections.get("mail")).toMatchObject({
      authState: "none",
      accountIdentity: "Inbox",
      credentialRefs: {},
    });
    expect(seen.oauthKey).toMatch(/^refused: .*credentials\.accessToken/);
    // Needing consent for more, it keeps running on what it was granted.
    await db.repositories.messagingConnections.setAuthState({ connectionId: "mail", authState: "needs-consent", reopen: false, now: AT });
    await host.reload();
    expect(host.list()[0]?.status.state).toBe("running");
    await db.repositories.messagingConnections.setAuthState({ connectionId: "mail", authState: "expired", now: AT });
    await host.reload();
    expect(host.list()[0]?.status).toMatchObject({ state: "stopped", detail: "reconnect needed: its sign-in expired or was revoked" });
  });

  it("shows a connection missing its channel once the connector is withdrawn, and opens it when it is back", async () => {
    let installed = true;
    const { host, save, messaging, closed } = await setup({ installed: () => installed });
    await save("a", "w1");
    await host.load();
    await host.start();
    expect(await messaging.unregisterConnector("example")).toBe(true);
    expect(await messaging.unregisterConnector("example")).toBe(false);
    expect(closed).toEqual(["a"]);
    installed = false;
    await host.reload();
    expect(host.list()[0]?.status).toMatchObject({ state: "stopped", detail: PROVIDER_MISSING });
  });
});
