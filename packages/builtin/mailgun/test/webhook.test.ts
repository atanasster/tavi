import { createHmac } from "node:crypto";

import type { IngressContext, IngressRequest, MessagingConnection } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { emailConversationId, emailEventKey } from "../src/inbound.js";
import { createMailgunIngress } from "../src/webhook.js";

/**
 * Mailgun's inbound webhook as the host's ingress takes it: the host owns the listener, body cap,
 * rate limit and replay cache (`packages/runtime/test/channel-ingress.test.ts`);
 * this checks the signature, names the replay key, and parses the event.
 */

const SIGNING_KEY = "test-signing-key";
const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const FIXED_NOW_SECONDS = Math.floor(new Date(FIXED_NOW).getTime() / 1000);
const BOUNDARY = "----MailgunBoundaryXYZ";
const MESSAGE_HEADERS = JSON.stringify([["Message-Id", "<abc123@mail.example.com>"]]);

function sign(timestamp: string, token: string): string {
  return createHmac("sha256", SIGNING_KEY)
    .update(timestamp + token)
    .digest("hex");
}

function multipartField(name: string, value: string): string {
  return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

function body(fields: Record<string, string>, extra = ""): Uint8Array {
  return Buffer.from(
    Object.entries(fields)
      .map(([name, value]) => multipartField(name, value))
      .join("") +
      extra +
      `--${BOUNDARY}--\r\n`,
    "utf8",
  );
}

function validFields(overrides: Record<string, string> = {}): Record<string, string> {
  const timestamp = String(FIXED_NOW_SECONDS);
  const token = "tok-1";
  return {
    timestamp,
    token,
    signature: sign(timestamp, token),
    sender: "sender@example.com",
    recipient: "bot@mail.example.com",
    subject: "Hi",
    "stripped-text": "Hello there",
    "message-headers": MESSAGE_HEADERS,
    ...overrides,
  };
}

function request(rawBody: Uint8Array, contentType = `multipart/form-data; boundary=${BOUNDARY}`): IngressRequest {
  return { method: "POST", route: "inbound", headers: { "content-type": contentType }, query: {}, rawBody };
}

const connection: MessagingConnection = {
  connectionId: "conn-1",
  providerId: "mailgun",
  accountIdentity: "tavi@mail.example.com",
  workspaceId: "w",
  configRevision: 1,
  enabled: true,
};
function context(signingKey: string | null = SIGNING_KEY, now = FIXED_NOW): IngressContext {
  return {
    connection,
    now: () => now,
    credentials: { get: async (key) => (key === "webhookSigningKey" ? signingKey : null), accessToken: async () => "" },
  };
}

describe("createMailgunIngress", () => {
  it("verifies a correctly signed request, names its token as the replay key for the signature's whole validity, and parses its event", async () => {
    const ingress = createMailgunIngress();
    const signed = request(body(validFields()));
    expect(await ingress.verify(signed, context())).toEqual({ ok: true, replayKey: "tok-1", replayTtlMs: (2 * 300 + 60) * 1000 });
    const { events } = await ingress.handle(signed, context());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      connectionId: "conn-1",
      providerEventId: emailEventKey("sender@example.com", "<abc123@mail.example.com>"),
      externalSenderId: "sender@example.com",
      externalConversationId: emailConversationId("bot@mail.example.com", "<abc123@mail.example.com>"),
      content: "Hello there",
    });
  });

  it("refuses an incorrect, stale or unsigned request, and one for a connection with no signing key", async () => {
    const ingress = createMailgunIngress();
    expect(await ingress.verify(request(body(validFields({ signature: "0".repeat(64) }))), context())).toEqual({ ok: false });
    const stale = String(FIXED_NOW_SECONDS - 3600);
    expect(await ingress.verify(request(body(validFields({ timestamp: stale, signature: sign(stale, "tok-1") }))), context())).toEqual({
      ok: false,
    });
    const { signature: _signature, ...unsigned } = validFields();
    expect(await ingress.verify(request(body(unsigned)), context())).toEqual({ ok: false });
    expect(await ingress.verify(request(body(validFields())), context(null))).toEqual({ ok: false });
    expect(await ingress.verify(request(body(validFields()), "text/plain"), context())).toEqual({ ok: false });
  });

  it("throws INVALID_INPUT for a verified request with no Message-Id, or a body no field can be parsed from", async () => {
    const ingress = createMailgunIngress();
    await expect(ingress.handle(request(body(validFields({ "message-headers": "[]" }))), context())).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(ingress.handle(request(Buffer.from("not multipart at all")), context())).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("does not mistake a boundary-like substring inside a field's own content for a real delimiter", async () => {
    // Quoted or forwarded email text can contain the literal boundary, not preceded by CRLF.
    const tricky = `here is some text --${BOUNDARY} not a real boundary, just quoted text`;
    const { events } = await createMailgunIngress().handle(request(body(validFields({ "stripped-text": tricky }))), context());
    expect(events[0]?.content).toBe(tricky);
  });

  it("hands attachment parts (filename= present) to the host as media, never surfacing them as text fields", async () => {
    const attachment = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="stripped-text"; filename="evil.exe"\r\nContent-Type: application/octet-stream\r\n\r\nBINARYDATA\r\n`;
    const { events } = await createMailgunIngress().handle(request(body(validFields(), attachment)), context());
    expect(events[0]?.content).toBe("Hello there");
    expect(events[0]?.media).toEqual([
      {
        ref: "attachment-1",
        filename: "evil.exe",
        mimeType: "application/octet-stream",
        sizeBytes: 10,
        inline: Uint8Array.from(Buffer.from("BINARYDATA")),
      },
    ]);
    // No file part, no media.
    expect((await createMailgunIngress().handle(request(body(validFields())), context())).events[0]).not.toHaveProperty("media");
  });
});
