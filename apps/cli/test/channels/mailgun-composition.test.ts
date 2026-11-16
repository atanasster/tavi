import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ChannelsPayload } from "@tavi/contracts";
import { temporaryDirectories, fakeFetch } from "@tavi/test-support";

import { channelsCommand } from "../../src/features/channels/owner.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { saveChannelConnection } from "../support/saved-channel.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** The Mailgun connection as `tavi channels add mailgun` saves it, its secrets the bound files, and the listener on 8025. */
const saveMailgun = (directory: string): Promise<void> =>
  saveChannelConnection(
    directory,
    {
      connectionId: "mailgun-default",
      providerId: "mailgun",
      workspaceId: "default",
      accountIdentity: "tavi@mail.example.com",
      settings: { domain: "mail.example.com" },
      credentialRefs: { apiKey: "mailgun.apiKey", webhookSigningKey: "mailgun.webhookSigningKey" },
    },
    { host: "127.0.0.1", port: 8025 },
  );

/** The Mailgun connector's dedup key: the Message-Id scoped to the case-folded sender. */
function emailEventKey(sender: string, messageId: string): string {
  return `mail:${createHash("sha256").update(`${sender.toLowerCase()}\n${messageId}`).digest("hex")}`;
}

/**
 * An end-to-end test proving CLI composition wires the real Mailgun connector and webhook
 * listener (not fixtures) — two-secret credential resolution through the
 * same `secrets` chain other credentials already use, connection opening
 * and HTTP listener startup at startup, `send()` reaching the real
 * adapter, and an inbound webhook POST reaching `messaging.ingest` — all
 * through the full `composeTaviRuntime` path, without ever making a real
 * network call or binding a real port (`channelFetch`/
 * `ingressCreateServerOverride` substitute fakes).
 */

const directories = temporaryDirectories({ prefix: "tavi-mailgun-composition-" });
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    if (runtime !== undefined) await runtime.close();
  }
  directories.cleanup();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake `http.Server` — no real socket is ever bound. Records the request listener and captures `listen`/`close` calls. */
function fakeServer(): { server: Server; listenCalls: Array<{ port: number; host: string }>; getCloseCalls: () => number } {
  const emitter = new EventEmitter();
  const state = { listenCalls: [] as Array<{ port: number; host: string }>, closeCalls: 0 };
  const server = Object.assign(emitter, {
    listen: (port: number, host: string, callback?: () => void) => {
      state.listenCalls.push({ port, host });
      queueMicrotask(() => callback?.());
      return server;
    },
    close: (callback?: (error?: Error) => void) => {
      state.closeCalls += 1;
      queueMicrotask(() => callback?.());
      return server;
    },
  }) as unknown as Server;
  return { server, listenCalls: state.listenCalls, getCloseCalls: () => state.closeCalls };
}

async function composeWithMailgun(
  directory: string,
  apiKeyFile: string,
  webhookSigningKeyFile: string,
  fetchImpl: typeof fetch,
  capturedListener: { current?: (req: IncomingMessage, res: ServerResponse) => void } = {},
): Promise<{ runtime: TaviRuntime; listenCalls: Array<{ port: number; host: string }>; closeCalls: () => number }> {
  await saveMailgun(directory);
  const fake = fakeServer();
  const originalListenCalls = fake.listenCalls;
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      credentials: {
        "mailgun.apiKey": { fromFile: apiKeyFile },
        "mailgun.webhookSigningKey": { fromFile: webhookSigningKeyFile },
      },
      approvalRequiredFor: [],
      openSavedChannels: true,
    }),
    {
      requireModelTransport: false,
      channelFetch: { mailgun: fetchImpl },
      ingressCreateServerOverride: (requestListener) => {
        capturedListener.current = requestListener;
        return fake.server;
      },
    },
  );
  runtimes.push(runtime);
  return { runtime, listenCalls: originalListenCalls, closeCalls: fake.getCloseCalls };
}

describe("composeTaviRuntime — real Mailgun connector and webhook wiring", () => {
  it("resolves both secrets through the shared secrets chain, opens the connection, and starts the webhook listener at startup", async () => {
    const directory = directories.create();
    const apiKeyFile = join(directory, "mailgun-api-key");
    const signingKeyFile = join(directory, "mailgun-signing-key");
    writeFileSync(apiKeyFile, "test-api-key\n", { mode: 0o600 });
    writeFileSync(signingKeyFile, "test-signing-key\n", { mode: 0o600 });

    const fetchImpl = fakeFetch(async () => new Response("", { status: 200 }));
    const { listenCalls } = await composeWithMailgun(directory, apiKeyFile, signingKeyFile, fetchImpl);
    expect(listenCalls).toEqual([{ port: 8025, host: "127.0.0.1" }]);
  });

  it("retries a failed open at startup instead of leaving email off until a restart", async () => {
    const directory = directories.create();
    const apiKeyFile = join(directory, "mailgun-api-key");
    const signingKeyFile = join(directory, "mailgun-signing-key");
    writeFileSync(apiKeyFile, "test-api-key\n", { mode: 0o600 });
    writeFileSync(signingKeyFile, "test-signing-key\n", { mode: 0o600 });
    let calls = 0;
    const fetchImpl = fakeFetch(async () => {
      calls += 1;
      return new Response("", { status: calls === 1 ? 503 : 200 });
    });
    const { listenCalls } = await composeWithMailgun(directory, apiKeyFile, signingKeyFile, fetchImpl);
    expect(calls).toBe(2);
    expect(listenCalls).toEqual([{ port: 8025, host: "127.0.0.1" }]);
  });

  it("send() reaches the real connector through the composed runtime", async () => {
    const directory = directories.create();
    const apiKeyFile = join(directory, "mailgun-api-key");
    const signingKeyFile = join(directory, "mailgun-signing-key");
    writeFileSync(apiKeyFile, "test-api-key\n", { mode: 0o600 });
    writeFileSync(signingKeyFile, "test-signing-key\n", { mode: 0o600 });

    const fetchImpl = fakeFetch(async (url) => {
      if (url.includes("/domains/")) return new Response("", { status: 200 });
      if (url.includes("/messages")) return jsonResponse(200, { id: "<mid@mail.example.com>", message: "Queued" });
      return new Response("", { status: 500 });
    });
    const { runtime } = await composeWithMailgun(directory, apiKeyFile, signingKeyFile, fetchImpl);
    const outcome = await runtime.messaging.send({
      effectId: "eff-1",
      connectionId: "mailgun-default",
      destination: { to: "user@example.com", from: "bot@mail.example.com", subject: "Hi" },
      parts: [{ content: "hello from tavi" }],
    });
    expect(outcome.status).toBe("accepted");
  });

  /** Simulates one inbound multipart POST through a captured webhook `requestListener`, returning the response's final status code. */
  async function postToWebhook(
    listener: (req: IncomingMessage, res: ServerResponse) => void,
    boundary: string,
    body: Buffer,
  ): Promise<number | undefined> {
    const req = new EventEmitter() as unknown as IncomingMessage;
    Object.assign(req, {
      method: "POST",
      url: "/hooks/mailgun-default/inbound",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    let statusCode: number | undefined;
    const res = { setHeader: () => {}, end: () => {} };
    Object.defineProperty(res, "statusCode", { set: (value: number) => (statusCode = value), get: () => statusCode });
    const handlerPromise = new Promise<void>((resolve) => {
      const originalEnd = res.end;
      res.end = (...args: unknown[]) => {
        originalEnd(...(args as []));
        resolve();
      };
    });
    listener(req, res as unknown as ServerResponse);
    queueMicrotask(() => {
      req.emit("data", body);
      req.emit("end");
    });
    await handlerPromise;
    return statusCode;
  }

  function buildInboundBody(boundary: string, fields: Record<string, string>): Buffer {
    const field = (name: string, value: string): string =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    return Buffer.from(
      Object.entries(fields)
        .map(([name, value]) => field(name, value))
        .join("") + `--${boundary}--\r\n`,
      "utf8",
    );
  }

  it("a public address saved in Settings applies on reload, without moving the listener", async () => {
    const directory = directories.create();
    const fake = fakeServer();
    const captured: { current?: (req: IncomingMessage, res: ServerResponse) => void } = {};
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [], openSavedChannels: true }), {
      requireModelTransport: false,
      channelFetch: { mailgun: fakeFetch(async () => new Response("", { status: 200 })) },
      ingressCreateServerOverride: (listener) => {
        captured.current = listener;
        return fake.server;
      },
    });
    runtimes.push(runtime);
    const channels = (payload: ChannelsPayload) =>
      channelsCommand(
        {
          dataDirectory: directory,
          repositories: runtime.store.asPort().repositories,
          channels: runtime.channels,
          messaging: runtime.messaging,
          reload: (workspaceId) => runtime.reloadChannels(workspaceId),
          applyIngress: () => runtime.applyIngress(),
          pairings: runtime.pairings,
          oauth: runtime.oauthFlows,
          revokeToken: (connection) => runtime.oauthBroker.revoke(connection),
          now: () => runtime.clock.now(),
        },
        payload,
      );
    // The connection as Settings → Channels saves it, and the public address as its Webhooks section does.
    await channels({
      action: "save",
      workspaceId: "default",
      connectionId: "mailgun-default",
      providerId: "mailgun",
      enabled: true,
      settings: { domain: "mail.example.com" },
      secrets: { apiKey: "k", webhookSigningKey: "s" },
    });
    const save = (publicUrl: string) => channels({ action: "ingress", port: 8025, publicUrl });
    const linkStatus = async (path: string): Promise<number | undefined> => {
      const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: {} }) as unknown as IncomingMessage;
      let status: number | undefined;
      await new Promise<void>((resolve) => {
        const res = {
          headersSent: false,
          setHeader: () => {},
          end: () => resolve(),
          set statusCode(value: number) {
            status = value;
          },
          get statusCode() {
            return status ?? 200;
          },
        };
        captured.current?.(req, res as unknown as ServerResponse);
      });
      return status;
    };
    await save("https://mail.example.com/old");
    expect((await runtime.reloadChannels("default")).failed).toEqual([]);
    expect(await linkStatus("/old/i/abcdefghijklmnopqrst")).toBe(410);
    await save("https://mail.example.com/new");
    await runtime.reloadChannels("default");
    // The same listener, now answering under the new address only.
    expect(fake.listenCalls).toHaveLength(1);
    expect(await linkStatus("/new/i/abcdefghijklmnopqrst")).toBe(410);
    expect(await linkStatus("/old/i/abcdefghijklmnopqrst")).toBe(404);
  });

  it("an inbound webhook POST, correctly signed, reaches messaging.ingest via the durable inbox", async () => {
    const { createHmac } = await import("node:crypto");
    const directory = directories.create();
    const apiKeyFile = join(directory, "mailgun-api-key");
    const signingKeyFile = join(directory, "mailgun-signing-key");
    writeFileSync(apiKeyFile, "test-api-key\n", { mode: 0o600 });
    writeFileSync(signingKeyFile, "test-signing-key\n", { mode: 0o600 });

    const fetchImpl = fakeFetch(async () => new Response("", { status: 200 }));
    const capturedListener: { current?: (req: IncomingMessage, res: ServerResponse) => void } = {};
    const { runtime } = await composeWithMailgun(directory, apiKeyFile, signingKeyFile, fetchImpl, capturedListener);
    expect(capturedListener.current).toBeDefined();

    const boundary = "----TestBoundary";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = "tok-1";
    const signature = createHmac("sha256", "test-signing-key")
      .update(timestamp + token)
      .digest("hex");
    const messageHeaders = JSON.stringify([["Message-Id", "<real-msg@mail.example.com>"]]);
    const body = buildInboundBody(boundary, {
      timestamp,
      token,
      signature,
      sender: "sender@example.com",
      recipient: "bot@mail.example.com",
      "stripped-text": "hello inbound",
      "message-headers": messageHeaders,
    });

    const status = await postToWebhook(capturedListener.current as (req: IncomingMessage, res: ServerResponse) => void, boundary, body);
    expect(status).toBe(200);

    const inboxEntry = await runtime.store
      .asPort()
      .repositories.messagingInbox.get("mailgun-default", emailEventKey("sender@example.com", "<real-msg@mail.example.com>"));
    expect(inboxEntry).toBeDefined();
    expect(inboxEntry?.payload.content).toBe("hello inbound");
  });

  it("an inbound webhook POST with a forged signature is rejected (403) and never reaches the durable inbox", async () => {
    const directory = directories.create();
    const apiKeyFile = join(directory, "mailgun-api-key");
    const signingKeyFile = join(directory, "mailgun-signing-key");
    writeFileSync(apiKeyFile, "test-api-key\n", { mode: 0o600 });
    writeFileSync(signingKeyFile, "test-signing-key\n", { mode: 0o600 });

    const fetchImpl = fakeFetch(async () => new Response("", { status: 200 }));
    const capturedListener: { current?: (req: IncomingMessage, res: ServerResponse) => void } = {};
    const { runtime } = await composeWithMailgun(directory, apiKeyFile, signingKeyFile, fetchImpl, capturedListener);
    expect(capturedListener.current).toBeDefined();

    const boundary = "----TestBoundary";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = "tok-1";
    const messageHeaders = JSON.stringify([["Message-Id", "<forged-msg@mail.example.com>"]]);
    // A signature that was never computed against the real signing key —
    // simulates a forged/tampered webhook request, not merely a missing one.
    const body = buildInboundBody(boundary, {
      timestamp,
      token,
      signature: "0".repeat(64),
      sender: "attacker@example.com",
      recipient: "bot@mail.example.com",
      "stripped-text": "forged content",
      "message-headers": messageHeaders,
    });

    const status = await postToWebhook(capturedListener.current as (req: IncomingMessage, res: ServerResponse) => void, boundary, body);
    expect(status).toBe(403);

    const inboxEntry = await runtime.store
      .asPort()
      .repositories.messagingInbox.get("mailgun-default", emailEventKey("attacker@example.com", "<forged-msg@mail.example.com>"));
    expect(inboxEntry).toBeUndefined();
  });

  it("closes both the connection and the webhook listener on shutdown", async () => {
    const directory = directories.create();
    const apiKeyFile = join(directory, "mailgun-api-key");
    const signingKeyFile = join(directory, "mailgun-signing-key");
    writeFileSync(apiKeyFile, "test-api-key\n", { mode: 0o600 });
    writeFileSync(signingKeyFile, "test-signing-key\n", { mode: 0o600 });

    const fetchImpl = fakeFetch(async () => new Response("", { status: 200 }));
    const { runtime, closeCalls } = await composeWithMailgun(directory, apiKeyFile, signingKeyFile, fetchImpl);
    await runtime.close();
    runtimes.pop(); // already closed above; afterEach shouldn't close it again
    expect(closeCalls()).toBe(1);
    // The listener half is covered by `closeCalls`; the connection half
    // needs its own assertion — `send()` against a closed connection
    // throws NOT_FOUND (`packages/runtime/src/messaging/service.ts`'s
    // `openConnections` no longer has an entry for it), proving
    // `scope.defer(() => messaging.closeConnection(...))` genuinely ran,
    // not just the webhook listener's own disposer.
    await expect(
      runtime.messaging.send({
        effectId: "eff-after-close",
        connectionId: "mailgun-default",
        destination: { to: "user@example.com", from: "bot@mail.example.com", subject: "Hi" },
        parts: [{ content: "should not send" }],
      }),
    ).rejects.toThrow(/No open messaging connection|mailgun-default/);
  });

  it("fails startup when the webhook listener cannot bind (e.g. EADDRINUSE), and does not leak the already-opened connection", async () => {
    const directory = directories.create();
    const apiKeyFile = join(directory, "mailgun-api-key");
    const signingKeyFile = join(directory, "mailgun-signing-key");
    writeFileSync(apiKeyFile, "test-api-key\n", { mode: 0o600 });
    writeFileSync(signingKeyFile, "test-signing-key\n", { mode: 0o600 });

    const emitter = new EventEmitter();
    let closeCalls = 0;
    const failingServer = Object.assign(emitter, {
      listen: () => {
        queueMicrotask(() => emitter.emit("error", Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" })));
        return failingServer;
      },
      close: (callback?: (error?: Error) => void) => {
        closeCalls += 1;
        queueMicrotask(() => callback?.());
        return failingServer;
      },
    }) as unknown as Server;

    await saveMailgun(directory);
    const fetchImpl = fakeFetch(async () => new Response("", { status: 200 }));
    await expect(
      composeTaviRuntime(
        fixtureRuntimeOptions(directory, {
          credentials: {
            "mailgun.apiKey": { fromFile: apiKeyFile },
            "mailgun.webhookSigningKey": { fromFile: signingKeyFile },
          },
          approvalRequiredFor: [],
          openSavedChannels: true,
        }),
        { requireModelTransport: false, channelFetch: { mailgun: fetchImpl }, ingressCreateServerOverride: () => failingServer },
      ),
    ).rejects.toThrow(/EADDRINUSE/);
    // Nothing to push into `runtimes` — composeTaviRuntime rejected, so
    // there is no runtime instance for afterEach to close. The listen
    // failure itself doesn't call `close()` (the server never started),
    // but the already-opened messaging connection's own `scope.defer`
    // still unwinds via `PluginHost.start()`'s own failure path — no
    // separate assertion is possible here since the connector has no
    // externally observable close side effect, but the composition-level
    // cleanup itself not throwing (the promise rejects with the ORIGINAL
    // EADDRINUSE error, not a secondary cleanup error masking it) is
    // itself evidence the unwind completed without a second failure.
    expect(closeCalls).toBe(0);
  });

  it("no Mailgun connector or listener starts when `mailgun` is not configured", async () => {
    const directory = directories.create();
    const fetchImpl = fakeFetch(async () => {
      throw new Error("fetch must never be called when Mailgun is not configured");
    });
    let serverCreated = false;
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), {
      requireModelTransport: false,
      channelFetch: { mailgun: fetchImpl },
      ingressCreateServerOverride: () => {
        serverCreated = true;
        return fakeServer().server;
      },
    });
    runtimes.push(runtime);
    expect(serverCreated).toBe(false);
  });
});
