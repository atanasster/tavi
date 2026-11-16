import type { MessagingConnection, MessagingCredentials } from "@tavi/contracts";
import { describe, expect, it, vi } from "vitest";

import { ChannelDescriptorSchema, channelIdentity } from "@tavi/contracts";
import { MAILGUN_CHANNEL_DESCRIPTOR, createMailgunConnectorDefinition } from "../src/connector.js";

/**
 * Real Mailgun `MessagingConnectorPort` outbound adapter. Every test injects a fake `fetch` — no real network call is
 * ever made.
 */

function connectionFixture(): MessagingConnection {
  return {
    connectionId: "conn-1",
    providerId: "mailgun",
    accountIdentity: "tavi@mail.example.com",
    workspaceId: "w1",
    configRevision: 1,
    credentialRef: "mailgun.apiKey",
    enabled: true,
  };
}

const config = { domain: "mail.example.com" };

/** A connection's credentials: its API key and webhook signing key. */
function mailgunCredentials(apiKey: string | null, webhookSigningKey: string | null = "signing-key"): MessagingCredentials {
  const values: Record<string, string | null> = { apiKey, webhookSigningKey };
  return { get: async (key) => values[key] ?? null, accessToken: async () => "" };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createMailgunConnectorDefinition", () => {
  it("declares webhook-receive, text-only capabilities", () => {
    const definition = createMailgunConnectorDefinition();
    expect(definition.providerId).toBe("mailgun");
    expect(definition.capabilities.receiveMode).toBe("webhook");
    expect(definition.capabilities.attachments).toBe(false);
    expect(definition.capabilities.deliveryReceipts).toBe(false);
  });

  it("describes itself as a valid channel, and sends a new thread from the connection's address", () => {
    expect(ChannelDescriptorSchema.safeParse(MAILGUN_CHANNEL_DESCRIPTOR).success).toBe(true);
    // A mailed video of any container is taken in; the intake's sniff decides what it is.
    expect(MAILGUN_CHANNEL_DESCRIPTOR.media?.mimeTypes).toContain("video/*");
    expect(MAILGUN_CHANNEL_DESCRIPTOR.providerId).toBe(createMailgunConnectorDefinition().providerId);
    expect(channelIdentity("Ana@Example.com", MAILGUN_CHANNEL_DESCRIPTOR.target)).toBe("ana@example.com");
    const definition = createMailgunConnectorDefinition();
    const connection = { ...connectionFixture(), accountIdentity: "tavi@mail.example.com" };
    expect(definition.destinationFor?.({ to: "ana@example.com" }, connection)).toEqual({
      to: "ana@example.com",
      from: "tavi@mail.example.com",
      subject: "A message from Tavi",
    });
    expect(definition.destinationFor?.({ to: "ana@example.com", subject: "Weekly report" }, connection)).toMatchObject({
      subject: "Weekly report",
    });
  });

  it("destinationFromInbound replies to the original sender, from this connection's own address", () => {
    const definition = createMailgunConnectorDefinition();
    // externalConversationId (Mailgun's own receiving address — see
    // inbound.ts) is deliberately NOT the reply target; externalSenderId
    // (the human's own address) is.
    expect(
      definition.destinationFromInbound?.(
        { externalConversationId: "bot@mail.example.com", externalSenderId: "alice@example.com" },
        connectionFixture(),
      ),
    ).toEqual({
      conversationId: "bot@mail.example.com",
      to: "alice@example.com",
      from: "tavi@mail.example.com",
      subject: "Re: your message",
    });
  });

  it("destinationFor threads a send under the message it names", () => {
    const destination = createMailgunConnectorDefinition().destinationFor?.(
      { to: "ana@example.com", replyToId: "<m-1@x>" },
      connectionFixture(),
    );
    expect(destination).toMatchObject({ inReplyTo: "<m-1@x>", references: "<m-1@x>" });
  });

  it("destinationFromInbound replies Re: the thread's own subject, never Re: twice", () => {
    const definition = createMailgunConnectorDefinition();
    const reply = (subject?: string) =>
      (
        definition.destinationFromInbound?.(
          { externalConversationId: "c", externalSenderId: "a@example.com", ...(subject === undefined ? {} : { subject }) },
          connectionFixture(),
        ) as { subject: string }
      ).subject;
    expect(reply("Weekly numbers")).toBe("Re: Weekly numbers");
    expect(reply("RE: Weekly numbers")).toBe("RE: Weekly numbers");
    expect(reply("  ")).toBe("Re: your message");
    expect(reply()).toBe("Re: your message");
  });

  it("destinationFromInbound sets In-Reply-To/References when the inbound message's id is known, for mail-client threading", () => {
    const definition = createMailgunConnectorDefinition();
    expect(
      definition.destinationFromInbound?.(
        {
          externalConversationId: "bot@mail.example.com",
          externalSenderId: "alice@example.com",
          externalMessageId: "<abc123@mail.example.com>",
        },
        connectionFixture(),
      ),
    ).toEqual({
      conversationId: "bot@mail.example.com",
      to: "alice@example.com",
      from: "tavi@mail.example.com",
      subject: "Re: your message",
      inReplyTo: "<abc123@mail.example.com>",
      references: "<abc123@mail.example.com>",
    });
  });

  it("destinationFromInbound extends the full References ancestor chain, not just the immediate parent", () => {
    const definition = createMailgunConnectorDefinition();
    const result = definition.destinationFromInbound?.(
      {
        externalConversationId: "bot@mail.example.com",
        externalSenderId: "alice@example.com",
        externalMessageId: "<abc123@mail.example.com>",
        externalReferences: ["<root@mail.example.com>", "<middle@mail.example.com>"],
      },
      connectionFixture(),
    );
    expect(result).toMatchObject({
      inReplyTo: "<abc123@mail.example.com>",
      references: "<root@mail.example.com> <middle@mail.example.com> <abc123@mail.example.com>",
    });
  });

  it("truncates the References chain after its first entry when the joined header would exceed RFC 5322's 998-char line limit", () => {
    const definition = createMailgunConnectorDefinition();
    // 30 ancestor ids of ~40 chars each (~1200 chars joined) — well over 998.
    const ancestors = Array.from({ length: 30 }, (_, i) => `<ancestor-${i}-${"x".repeat(20)}@mail.example.com>`);
    const result = definition.destinationFromInbound?.(
      {
        externalConversationId: "bot@mail.example.com",
        externalSenderId: "alice@example.com",
        externalMessageId: "<latest@mail.example.com>",
        externalReferences: ancestors,
      },
      connectionFixture(),
    ) as { references?: string } | undefined;
    expect(result?.references).toBeDefined();
    const references = result?.references ?? "";
    expect(references.length).toBeLessThanOrEqual(998);
    // The newest entry (the message actually being replied to) is never
    // dropped, and neither is the first: it names the thread's conversation.
    // The ancestors in between go, oldest first.
    expect(references.endsWith("<latest@mail.example.com>")).toBe(true);
    expect(references.startsWith("<ancestor-0-")).toBe(true);
    expect(references).not.toContain("<ancestor-1-");
  });

  it("hard-truncates a single ancestor id that alone exceeds 998 characters, rather than returning it unshortened", () => {
    const definition = createMailgunConnectorDefinition();
    const oversizedLatest = `<${"y".repeat(1200)}@mail.example.com>`;
    const result = definition.destinationFromInbound?.(
      { externalConversationId: "bot@mail.example.com", externalSenderId: "alice@example.com", externalMessageId: oversizedLatest },
      connectionFixture(),
    ) as { references?: string } | undefined;
    expect(result?.references).toBeDefined();
    expect((result?.references ?? "").length).toBeLessThanOrEqual(998);
  });

  it("send() forwards In-Reply-To/References as Mailgun h: header fields when the destination carries them", async () => {
    const capturedBodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBodies.push(String(init.body));
      return jsonResponse(200, { id: "<sent@mail.example.com>", message: "Queued" });
    });
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("test-key") });
    await instance.start();
    await instance.send({
      effectId: "eff-1",
      connectionId: "conn-1",
      destination: {
        to: "alice@example.com",
        from: "tavi@mail.example.com",
        subject: "Re: your message",
        inReplyTo: "<abc123@mail.example.com>",
        references: "<abc123@mail.example.com>",
      },
      parts: [{ content: "reply body" }],
    });
    const body = new URLSearchParams(capturedBodies[capturedBodies.length - 1]);
    expect(body.get("h:In-Reply-To")).toBe("<abc123@mail.example.com>");
    expect(body.get("h:References")).toBe("<abc123@mail.example.com>");
  });

  it("send() uses a message's own subject over the destination's", async () => {
    const capturedBodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBodies.push(String(init.body));
      return jsonResponse(200, { id: "<sent@mail.example.com>", message: "Queued" });
    });
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("test-key") });
    await instance.start();
    await instance.send({
      effectId: "eff-subject",
      connectionId: "conn-1",
      destination: { to: "alice@example.com", from: "tavi@mail.example.com", subject: "Re: your message" },
      subject: "[tavi abcdefgh] Approval needed",
      parts: [{ content: "approve?" }],
    });
    expect(new URLSearchParams(capturedBodies[capturedBodies.length - 1]).get("subject")).toBe("[tavi abcdefgh] Approval needed");
  });

  it("start() throws NOT_CONFIGURED when the bound credential resolves to null", async () => {
    const definition = createMailgunConnectorDefinition({ fetch: vi.fn() as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials(null) });
    await expect(instance.start()).rejects.toThrow(/absent/);
  });

  it("start() surfaces a failed domain verification as UNAVAILABLE and a failed status", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await expect(instance.start()).rejects.toThrow(/domain verification failed/);
    expect(instance.status().state).toBe("failed");
  });

  it("start() refuses a connection with no webhook signing key, which could verify no inbound mail", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const instance = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch }).createConnection({
      connection: connectionFixture(),
      config,
      credentials: mailgunCredentials("key-1", null),
    });
    await expect(instance.start()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(instance.status().state).toBe("failed");
  });

  it("start() succeeds through a real domain-verification call and reaches running status", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await instance.start();
    expect(instance.status().state).toBe("running");
    await instance.stop();
    expect(instance.status().state).toBe("stopped");
  });

  it("reaches Mailgun's EU API for an EU-region domain, its US API otherwise, and declares both hosts", async () => {
    const region = MAILGUN_CHANNEL_DESCRIPTOR.settings.find((field) => field.key === "region");
    expect(region).toMatchObject({ type: "choice", choices: ["us", "eu"], default: "us" });
    expect(MAILGUN_CHANNEL_DESCRIPTOR.hosts).toEqual(["api.mailgun.net", "api.eu.mailgun.net"]);
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response("", { status: 200 });
    });
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    for (const given of [{ ...config, region: "eu" }, { ...config, region: "us" }, config]) {
      const instance = definition.createConnection({
        connection: connectionFixture(),
        config: given,
        credentials: mailgunCredentials("k"),
      });
      await instance.start();
      await instance.stop();
    }
    expect(urls).toEqual([
      "https://api.eu.mailgun.net/v3/domains/mail.example.com",
      "https://api.mailgun.net/v3/domains/mail.example.com",
      "https://api.mailgun.net/v3/domains/mail.example.com",
    ]);
    // Only the two regions: no other host can be named.
    expect(definition.configSchema.safeParse({ ...config, region: "https://evil.example" }).success).toBe(false);
  });

  it("start() sends the API key as HTTP Basic auth, never in a query string or body", async () => {
    let capturedAuth: string | null = null;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? null;
      return new Response("", { status: 200 });
    });
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config,
      credentials: mailgunCredentials("secret-key"),
    });
    await instance.start();
    expect(capturedAuth).toBe(`Basic ${Buffer.from("api:secret-key", "utf8").toString("base64")}`);
  });

  it("send() maps a successful send to an accepted outcome with a providerMessageId", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/domains/")) return new Response("", { status: 200 });
      if (url.includes("/messages")) return jsonResponse(200, { id: "<mid@mail.example.com>", message: "Queued" });
      return new Response("", { status: 500 });
    });
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await instance.start();
    const outcome = await instance.send({
      effectId: "e1",
      connectionId: "conn-1",
      destination: { to: "user@example.com", from: "bot@mail.example.com", subject: "Hi" },
      parts: [{ content: "hello" }],
    });
    expect(outcome).toEqual({
      status: "accepted",
      retryable: false,
      parts: [{ index: 0, status: "accepted", providerMessageId: "<mid@mail.example.com>" }],
    });
  });

  it("send() maps a 4xx rejection to a non-retryable rejected outcome, never auto-retried", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/domains/")) return new Response("", { status: 200 });
      return jsonResponse(400, { message: "'to' parameter is not a valid address" });
    });
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await instance.start();
    const outcome = await instance.send({
      effectId: "e1",
      connectionId: "conn-1",
      destination: { to: "not-an-email", from: "bot@mail.example.com", subject: "Hi" },
      parts: [{ content: "hello" }],
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.retryable).toBe(false);
  });

  it("send() maps a 5xx response to an uncertain, retryable outcome", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/domains/")) return new Response("", { status: 200 });
      return jsonResponse(502, { message: "Bad Gateway" });
    });
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await instance.start();
    const outcome = await instance.send({
      effectId: "e1",
      connectionId: "conn-1",
      destination: { to: "user@example.com", from: "bot@mail.example.com", subject: "Hi" },
      parts: [{ content: "hello" }],
    });
    expect(outcome.status).toBe("uncertain");
    expect(outcome.retryable).toBe(true);
  });

  it("keeps the API key, plain or as Basic auth, out of error bodies and fetch errors", async () => {
    const key = "secret-mg-key";
    const basic = Buffer.from(`api:${key}`, "utf8").toString("base64");
    let mode: "ok" | "throw" | "4xx" | "5xx" = "ok";
    const fetchImpl = vi.fn(async (url: string) => {
      if (mode === "throw") throw new TypeError(`fetch failed with ${key} and ${basic}`);
      if (url.includes("/domains/")) return new Response("", { status: 200 });
      return jsonResponse(mode === "4xx" ? 401 : 503, { message: `bad key ${key} (${basic})` });
    });
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials(key) });
    await instance.start();
    const send = () =>
      instance.send({
        effectId: "e1",
        connectionId: "conn-1",
        destination: { to: "user@example.com", from: "bot@mail.example.com", subject: "Hi" },
        parts: [{ content: "hello" }],
      });
    for (const next of ["4xx", "5xx", "throw"] as const) {
      mode = next;
      const outcome = JSON.stringify(await send());
      expect(outcome).toContain("<redacted>");
      expect(outcome).not.toContain(key);
      expect(outcome).not.toContain(basic);
    }
    const probed = await instance.probe().then(
      (result) => JSON.stringify(result),
      (error: unknown) => String(error),
    );
    expect(probed).not.toContain(key);
    expect(probed).not.toContain(basic);
  });

  it("send() is uncertain, never left pending, when Mailgun hangs or answers 2xx without JSON", async () => {
    let mode: "hang" | "html" = "hang";
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/domains/")) return new Response("", { status: 200 });
      if (mode === "html") return new Response("<html>proxy page</html>", { status: 200 });
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))),
      );
    });
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, requestTimeoutMs: 20 });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await instance.start();
    const send = () =>
      instance.send({
        effectId: "e1",
        connectionId: "conn-1",
        destination: { to: "user@example.com", from: "bot@mail.example.com", subject: "Hi" },
        parts: [{ content: "hello" }],
      });
    expect(await send()).toMatchObject({ status: "uncertain", retryable: true });
    mode = "html";
    expect(await send()).toMatchObject({ status: "uncertain", retryable: true, parts: [{ error: "HTTP 200 without a message id" }] });
  });

  it("send() maps a network error to an uncertain, retryable outcome", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/domains/")) return new Response("", { status: 200 });
      throw new Error("network unreachable");
    });
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await instance.start();
    const outcome = await instance.send({
      effectId: "e1",
      connectionId: "conn-1",
      destination: { to: "user@example.com", from: "bot@mail.example.com", subject: "Hi" },
      parts: [{ content: "hello" }],
    });
    expect(outcome.status).toBe("uncertain");
    expect(outcome.retryable).toBe(true);
  });

  it("send() throws INVALID_INPUT for a malformed destination, never softened into an outcome", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/domains/") ? new Response("", { status: 200 }) : new Response("", { status: 500 }),
    );
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await instance.start();
    await expect(
      instance.send({ effectId: "e1", connectionId: "conn-1", destination: { wrongField: true }, parts: [{ content: "hi" }] }),
    ).rejects.toThrow(/invalid/);
  });

  it("send() rejects a file part as a per-part receipt, never sending an empty-body email and never throwing", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/domains/") ? new Response("", { status: 200 }) : new Response("", { status: 500 }),
    );
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await instance.start();
    const outcome = await instance.send({
      effectId: "e1",
      connectionId: "conn-1",
      destination: { to: "user@example.com", from: "bot@mail.example.com", subject: "Hi" },
      parts: [{ kind: "file", artifactId: "art-1" }],
    });
    // A receipt, not a throw: `dispatchTool` records any thrown handler error as
    // an *uncertain* external effect, so throwing would ledger a knowably
    // impossible delivery ("this connector has no attachment path") as one an
    // operator must reconcile, and would hide the reason from the model.
    expect(outcome.status).toBe("rejected");
    expect(outcome.retryable).toBe(false);
    expect(outcome.parts[0]).toEqual({ index: 0, status: "rejected", error: "mailgun does not support file attachments" });
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/messages"), expect.anything());
  });

  it("send() rejects a message with more parts than maxPartsPerMessage before calling the API", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/domains/") ? new Response("", { status: 200 }) : new Response("", { status: 500 }),
    );
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await instance.start();
    await expect(
      instance.send({
        effectId: "e1",
        connectionId: "conn-1",
        destination: { to: "user@example.com", from: "bot@mail.example.com", subject: "Hi" },
        parts: [{ content: "a" }, { content: "b" }],
      }),
    ).rejects.toThrow(/maxPartsPerMessage/);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/messages"), expect.anything());
  });

  it("send() rejects a message with zero parts before calling the API, never sending an empty-body email", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/domains/") ? new Response("", { status: 200 }) : new Response("", { status: 500 }),
    );
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await instance.start();
    await expect(
      instance.send({
        effectId: "e1",
        connectionId: "conn-1",
        destination: { to: "user@example.com", from: "bot@mail.example.com", subject: "Hi" },
        parts: [],
      }),
    ).rejects.toThrow(/exactly 1|parts/i);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/messages"), expect.anything());
  });

  it("send() refuses to call the API when not running", async () => {
    const definition = createMailgunConnectorDefinition({ fetch: vi.fn() as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    await expect(
      instance.send({
        effectId: "e1",
        connectionId: "conn-1",
        destination: { to: "user@example.com", from: "bot@mail.example.com", subject: "Hi" },
        parts: [{ content: "hi" }],
      }),
    ).rejects.toThrow(/not running/);
  });

  it("probe() reports ok only while running, and reflects a real domain-verification call", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const definition = createMailgunConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    expect((await instance.probe()).ok).toBe(false);
    await instance.start();
    expect((await instance.probe()).ok).toBe(true);
  });

  it("onInboundEvent is a satisfied no-op — Mailgun's inbound path never calls it", () => {
    const definition = createMailgunConnectorDefinition();
    const instance = definition.createConnection({ connection: connectionFixture(), config, credentials: mailgunCredentials("key-1") });
    expect(() => instance.onInboundEvent?.(async () => {})).not.toThrow();
  });
});
