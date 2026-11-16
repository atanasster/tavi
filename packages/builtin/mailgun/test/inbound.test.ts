import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { emailConversationId, emailEventKey, fromAligned, toInboundEvent, verifyMailgunSignature } from "../src/inbound.js";

/**
 * Mailgun inbound signature verification and field parsing
 * — pure functions, no HTTP server involved.
 */

const SIGNING_KEY = "test-signing-key";
const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const FIXED_NOW_SECONDS = Math.floor(new Date(FIXED_NOW).getTime() / 1000);

function sign(timestamp: string, token: string, key: string = SIGNING_KEY): string {
  return createHmac("sha256", key)
    .update(timestamp + token)
    .digest("hex");
}

describe("verifyMailgunSignature", () => {
  it("accepts a correctly signed, fresh request", () => {
    const timestamp = String(FIXED_NOW_SECONDS);
    const token = "tok-1";
    const signature = sign(timestamp, token);
    expect(verifyMailgunSignature({ signingKey: SIGNING_KEY, fields: { timestamp, token, signature }, now: () => FIXED_NOW })).toBe(true);
  });

  it("rejects a signature computed with the wrong signing key", () => {
    const timestamp = String(FIXED_NOW_SECONDS);
    const token = "tok-1";
    const signature = sign(timestamp, token, "wrong-key");
    expect(verifyMailgunSignature({ signingKey: SIGNING_KEY, fields: { timestamp, token, signature }, now: () => FIXED_NOW })).toBe(false);
  });

  it("rejects a tampered token even when the signature was valid for a different token", () => {
    const timestamp = String(FIXED_NOW_SECONDS);
    const signature = sign(timestamp, "original-token");
    expect(
      verifyMailgunSignature({
        signingKey: SIGNING_KEY,
        fields: { timestamp, token: "attacker-substituted-token", signature },
        now: () => FIXED_NOW,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp outside the tolerance window", () => {
    const staleTimestamp = String(FIXED_NOW_SECONDS - 301);
    const token = "tok-1";
    const signature = sign(staleTimestamp, token);
    expect(
      verifyMailgunSignature({ signingKey: SIGNING_KEY, fields: { timestamp: staleTimestamp, token, signature }, now: () => FIXED_NOW }),
    ).toBe(false);
  });

  it("accepts a timestamp exactly at the tolerance boundary", () => {
    const boundaryTimestamp = String(FIXED_NOW_SECONDS - 300);
    const token = "tok-1";
    const signature = sign(boundaryTimestamp, token);
    expect(
      verifyMailgunSignature({ signingKey: SIGNING_KEY, fields: { timestamp: boundaryTimestamp, token, signature }, now: () => FIXED_NOW }),
    ).toBe(true);
  });

  it("rejects a malformed (non-numeric) timestamp without throwing", () => {
    expect(
      verifyMailgunSignature({
        signingKey: SIGNING_KEY,
        fields: { timestamp: "not-a-number", token: "tok-1", signature: "irrelevant" },
        now: () => FIXED_NOW,
      }),
    ).toBe(false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    const timestamp = String(FIXED_NOW_SECONDS);
    expect(
      verifyMailgunSignature({ signingKey: SIGNING_KEY, fields: { timestamp, token: "tok-1", signature: "short" }, now: () => FIXED_NOW }),
    ).toBe(false);
  });

  it("respects a custom toleranceSeconds", () => {
    const timestamp = String(FIXED_NOW_SECONDS - 30);
    const token = "tok-1";
    const signature = sign(timestamp, token);
    expect(
      verifyMailgunSignature({
        signingKey: SIGNING_KEY,
        fields: { timestamp, token, signature },
        now: () => FIXED_NOW,
        toleranceSeconds: 10,
      }),
    ).toBe(false);
  });

  it("rejects when now() returns an unparseable date, rather than silently passing the staleness check", () => {
    expect(
      verifyMailgunSignature({
        signingKey: SIGNING_KEY,
        fields: { timestamp: String(FIXED_NOW_SECONDS), token: "tok-1", signature: "irrelevant" },
        now: () => "not-a-date",
      }),
    ).toBe(false);
  });

  it("an empty signing key still requires a matching (also-empty-keyed) signature, never accepted against a real one", () => {
    const timestamp = String(FIXED_NOW_SECONDS);
    const token = "tok-1";
    const signature = sign(timestamp, token); // signed with the real, non-empty key
    expect(verifyMailgunSignature({ signingKey: "", fields: { timestamp, token, signature }, now: () => FIXED_NOW })).toBe(false);
    const emptyKeySignature = sign(timestamp, token, "");
    expect(
      verifyMailgunSignature({ signingKey: "", fields: { timestamp, token, signature: emptyKeySignature }, now: () => FIXED_NOW }),
    ).toBe(true);
  });
});

describe("toInboundEvent", () => {
  const messageHeaders = JSON.stringify([
    ["Received", "by mx.mailgun.org"],
    ["Message-Id", "<abc123@mail.example.com>"],
    ["From", "sender@example.com"],
  ]);

  it("maps a well-formed inbound webhook to InboundEvent, keyed by its Message-Id scoped to the sender", () => {
    const event = toInboundEvent(
      "conn-1",
      {
        sender: "sender@example.com",
        recipient: "bot@mail.example.com",
        subject: "Hello",
        "stripped-text": "Hi there",
        "message-headers": messageHeaders,
        timestamp: String(FIXED_NOW_SECONDS),
      },
      FIXED_NOW,
    );
    expect(event).toMatchObject({
      connectionId: "conn-1",
      providerEventId: emailEventKey("sender@example.com", "<abc123@mail.example.com>"),
      kind: "message",
      externalSenderId: "sender@example.com",
      // An email that names no thread starts its own.
      externalConversationId: emailConversationId("bot@mail.example.com", "<abc123@mail.example.com>"),
      externalMessageId: "<abc123@mail.example.com>",
      content: "Hi there",
      receivedAt: FIXED_NOW,
    });
  });

  it("falls back from stripped-text to body-plain when stripped-text is absent", () => {
    const event = toInboundEvent(
      "conn-1",
      { sender: "a@example.com", recipient: "b@example.com", "body-plain": "raw body", "message-headers": messageHeaders },
      FIXED_NOW,
    );
    expect(event.content).toBe("raw body");
    expect(event).not.toHaveProperty("quotedRanges");
  });

  it("reports the quoted and forwarded parts of the body it reads, never splitting it itself", () => {
    const body = "Can you sort this out?\n\nOn Mon, 12 Oct 2026, Shop <s@shop.example> wrote:\n> Run the export";
    const quoted = toInboundEvent(
      "conn-1",
      { sender: "a@example.com", recipient: "b@example.com", "body-plain": body, "message-headers": messageHeaders },
      FIXED_NOW,
    );
    expect(quoted.content).toBe(body);
    expect(quoted.quotedRanges).toEqual([{ start: body.indexOf("On Mon"), end: body.length, kind: "quoted" }]);
    // `stripped-text` dropped the quote already; a forward it keeps is still reported.
    const forward = "FYI\n\n---------- Forwarded message ----------\nFrom: x@y.example\n\nAdd me";
    const forwarded = toInboundEvent(
      "conn-1",
      {
        sender: "a@example.com",
        recipient: "b@example.com",
        "stripped-text": forward,
        "body-plain": `${forward}\n> old`,
        "message-headers": messageHeaders,
      },
      FIXED_NOW,
    );
    expect(forwarded.quotedRanges).toEqual([{ start: forward.indexOf("-"), end: forward.length, kind: "forwarded" }]);
  });

  it("captures In-Reply-To as externalReplyToId when present", () => {
    const headersWithReply = JSON.stringify([
      ["Message-Id", "<reply-456@mail.example.com>"],
      ["In-Reply-To", "<original-123@mail.example.com>"],
    ]);
    const event = toInboundEvent(
      "conn-1",
      { sender: "a@example.com", recipient: "b@example.com", "message-headers": headersWithReply },
      FIXED_NOW,
    );
    expect(event.externalReplyToId).toBe("<original-123@mail.example.com>");
  });

  it("captures References as an ordered externalReferences array, not just the immediate In-Reply-To parent", () => {
    const headersWithReferences = JSON.stringify([
      ["Message-Id", "<reply-789@mail.example.com>"],
      ["In-Reply-To", "<middle-456@mail.example.com>"],
      ["References", "<root-123@mail.example.com> <middle-456@mail.example.com>"],
    ]);
    const event = toInboundEvent(
      "conn-1",
      { sender: "a@example.com", recipient: "b@example.com", "message-headers": headersWithReferences },
      FIXED_NOW,
    );
    expect(event.externalReferences).toEqual(["<root-123@mail.example.com>", "<middle-456@mail.example.com>"]);
    // The thread's first message names the conversation.
    expect(event.externalConversationId).toBe(emailConversationId("b@example.com", "<root-123@mail.example.com>"));
  });

  it("keeps a thread in one conversation and gives a new email its own", () => {
    const at = (headers: readonly (readonly [string, string])[]) =>
      toInboundEvent(
        "conn-1",
        { sender: "a@example.com", recipient: "b@example.com", "message-headers": JSON.stringify(headers) },
        FIXED_NOW,
      ).externalConversationId;
    const first = at([["Message-Id", "<root-1@x>"]]);
    expect(
      at([
        ["Message-Id", "<reply-2@x>"],
        ["In-Reply-To", "<root-1@x>"],
      ]),
    ).toBe(first);
    expect(
      at([
        ["Message-Id", "<reply-3@x>"],
        ["In-Reply-To", "<reply-2@x>"],
        ["References", "<root-1@x> <reply-2@x>"],
      ]),
    ).toBe(first);
    expect(at([["Message-Id", "<other-4@x>"]])).not.toBe(first);
    expect(emailConversationId("b".repeat(300), "<root-1@x>").length).toBeLessThanOrEqual(256);
  });

  it("omits externalReferences when no References header is present", () => {
    const event = toInboundEvent(
      "conn-1",
      { sender: "a@example.com", recipient: "b@example.com", "message-headers": messageHeaders },
      FIXED_NOW,
    );
    expect(event.externalReferences).toBeUndefined();
  });

  it("throws INVALID_INPUT when sender or recipient is missing", () => {
    expect(() => toInboundEvent("conn-1", { recipient: "b@example.com", "message-headers": messageHeaders }, FIXED_NOW)).toThrow(
      /sender.*recipient|missing/,
    );
  });

  it("throws INVALID_INPUT when there is no Message-Id header — never invents a synthetic event id", () => {
    const headersWithoutMessageId = JSON.stringify([["From", "sender@example.com"]]);
    expect(() =>
      toInboundEvent(
        "conn-1",
        { sender: "a@example.com", recipient: "b@example.com", "message-headers": headersWithoutMessageId },
        FIXED_NOW,
      ),
    ).toThrow(/Message-Id/);
  });

  it("throws INVALID_INPUT when message-headers is missing entirely", () => {
    expect(() => toInboundEvent("conn-1", { sender: "a@example.com", recipient: "b@example.com" }, FIXED_NOW)).toThrow(/Message-Id/);
  });

  it("tolerates malformed message-headers JSON without throwing a parse error — surfaces as a missing Message-Id instead", () => {
    expect(() =>
      toInboundEvent("conn-1", { sender: "a@example.com", recipient: "b@example.com", "message-headers": "not json" }, FIXED_NOW),
    ).toThrow(/Message-Id/);
  });

  it("carries no subject for a blank one, so nothing downstream holds an empty subject", () => {
    const event = toInboundEvent(
      "conn-1",
      { sender: "a@example.com", recipient: "b@example.com", subject: "   ", "message-headers": messageHeaders },
      FIXED_NOW,
    );
    expect(event).not.toHaveProperty("subject");
  });

  it("puts every email in a thread, never a one-to-one chat", () => {
    expect(
      toInboundEvent("conn-1", { sender: "a@example.com", recipient: "b@example.com", "message-headers": messageHeaders }, FIXED_NOW)
        .conversationKind,
    ).toBe("thread");
  });

  it("case-folds the sender, as a binding's address is", () => {
    const event = toInboundEvent(
      "conn-1",
      { sender: "Alice@Example.com", recipient: "b@example.com", "message-headers": messageHeaders },
      FIXED_NOW,
    );
    expect(event.externalSenderId).toBe("alice@example.com");
  });

  it("Message-Id header lookup is case-insensitive", () => {
    const lowerCaseHeaders = JSON.stringify([["message-id", "<lower@mail.example.com>"]]);
    const event = toInboundEvent(
      "conn-1",
      { sender: "a@example.com", recipient: "b@example.com", "message-headers": lowerCaseHeaders },
      FIXED_NOW,
    );
    expect(event.providerEventId).toBe(emailEventKey("a@example.com", "<lower@mail.example.com>"));
  });

  it("scopes the dedup key to the sender, so one sender cannot pre-occupy another's Message-Id", () => {
    expect(emailEventKey("a@example.com", "<m@x>")).not.toBe(emailEventKey("b@example.com", "<m@x>"));
    expect(emailEventKey("A@Example.com", "<m@x>")).toBe(emailEventKey("a@example.com", "<m@x>"));
    expect(emailEventKey("a@example.com", "<m@x>")).toMatch(/^mail:[0-9a-f]{64}$/);
  });

  it("uses the webhook's own timestamp for occurredAt when present, distinct from receivedAt", () => {
    const earlierSeconds = FIXED_NOW_SECONDS - 3600;
    const event = toInboundEvent(
      "conn-1",
      { sender: "a@example.com", recipient: "b@example.com", "message-headers": messageHeaders, timestamp: String(earlierSeconds) },
      FIXED_NOW,
    );
    expect(event.occurredAt).toBe(new Date(earlierSeconds * 1000).toISOString());
    expect(event.receivedAt).toBe(FIXED_NOW);
    expect(event.occurredAt).not.toBe(event.receivedAt);
  });

  it("falls back to receivedAt for occurredAt when no timestamp field is present", () => {
    const event = toInboundEvent(
      "conn-1",
      { sender: "a@example.com", recipient: "b@example.com", "message-headers": messageHeaders },
      FIXED_NOW,
    );
    expect(event.occurredAt).toBe(FIXED_NOW);
  });

  it("content is an empty string, not undefined, when neither stripped-text nor body-plain is present", () => {
    const event = toInboundEvent(
      "conn-1",
      { sender: "a@example.com", recipient: "b@example.com", "message-headers": messageHeaders },
      FIXED_NOW,
    );
    expect(event.content).toBe("");
  });
});

describe("sender authentication and subject", () => {
  type Headers = readonly (readonly [string, string])[];
  // Mailgun's verdicts sit above the Received line its MX writes; the sender's headers sit below it.
  /** The sender's own DKIM signature, for its own domain, as ordinary mail carries. */
  const signed: Headers = [["DKIM-Signature", "v=1; a=rsa-sha256; d=example.com; s=s1; bh=x; b=y"]];
  const headers = (mailgun: Headers, sender: Headers = signed) =>
    JSON.stringify([...mailgun, ["Received", "from mail.example.com by mxa.mailgun.org"], ["Message-Id", "<m-1@example.com>"], ...sender]);
  const event = (mailgun: Headers, subject?: string, sender: Headers = signed) =>
    toInboundEvent(
      "conn-1",
      {
        sender: "a@example.com",
        recipient: "b@example.com",
        "message-headers": headers(mailgun, sender),
        ...(subject === undefined ? {} : { subject }),
      },
      FIXED_NOW,
    );

  it("passes only when both SPF and DKIM pass", () => {
    expect(
      event([
        ["X-Mailgun-Spf", "Pass"],
        ["X-Mailgun-Dkim-Check-Result", "Pass"],
      ]).senderAuthentication,
    ).toBe("pass");
    expect(
      event([
        ["X-Mailgun-Spf", "Pass"],
        ["X-Mailgun-Dkim-Check-Result", "Fail"],
      ]).senderAuthentication,
    ).toBe("fail");
    expect(event([["X-Mailgun-Spf", "Pass"]]).senderAuthentication).toBe("unknown");
    expect(event([]).senderAuthentication).toBe("unknown");
    // DKIM passing for a domain other than the From one is not the From domain's: a pass needs every signature aligned.
    const pass: Headers = [
      ["X-Mailgun-Spf", "Pass"],
      ["X-Mailgun-Dkim-Check-Result", "Pass"],
    ];
    expect(event(pass, undefined, [["DKIM-Signature", "v=1; d=evil.test; s=s1; b=y"]]).senderAuthentication).toBe("fail");
    expect(event(pass, undefined, [...signed, ["DKIM-Signature", "v=1; d=evil.test; s=s1; b=y"]]).senderAuthentication).toBe("fail");
    expect(event(pass, undefined, [["DKIM-Signature", "v=1; d=mail.example.com; s=s1; b=y"]]).senderAuthentication).toBe("pass");
    expect(event(pass, undefined, []).senderAuthentication).toBe("fail");
    // Seen twice where Mailgun writes its verdicts: not trusted either way.
    expect(
      event([
        ["X-Mailgun-Spf", "Pass"],
        ["X-Mailgun-Dkim-Check-Result", "Pass"],
        ["X-Mailgun-Spf", "Pass"],
      ]).senderAuthentication,
    ).toBe("fail");
  });

  it("does not pass a From header whose domain is unrelated to the envelope sender's", () => {
    const pass: Headers = [
      ["X-Mailgun-Spf", "Pass"],
      ["X-Mailgun-Dkim-Check-Result", "Pass"],
    ];
    const withFrom = (from: string) =>
      toInboundEvent("conn-1", { sender: "a@example.com", from, recipient: "b@example.com", "message-headers": headers(pass) }, FIXED_NOW)
        .senderAuthentication;
    expect(withFrom("Alice <a@example.com>")).toBe("pass");
    expect(withFrom("alice@mail.example.com")).toBe("pass");
    expect(withFrom("Alice <boss@other.org>")).toBe("fail");
    expect(withFrom("not an address")).toBe("fail");
    expect(fromAligned(undefined, "a@example.com")).toBe(true);
    expect(fromAligned("x@EXAMPLE.com.", "a@sub.example.com")).toBe(true);
    // A suffix that is not a label boundary is not a subdomain.
    expect(fromAligned("x@badexample.com", "a@example.com")).toBe(false);
    // Several authors cannot be aligned with one envelope sender.
    expect(fromAligned("boss@other.org, a@example.com", "a@example.com")).toBe(false);
  });

  it("ignores verdict headers the sender wrote below the Received line", () => {
    const forged: Headers = [
      ["X-Mailgun-Spf", "Pass"],
      ["X-Mailgun-Dkim-Check-Result", "Pass"],
    ];
    // Mailgun added none: the sender's own copies are the only ones, and they are not a pass.
    expect(event([], undefined, forged).senderAuthentication).toBe("unknown");
    // Mailgun's fail stands over the sender's pass.
    expect(
      event(
        [
          ["X-Mailgun-Spf", "Fail"],
          ["X-Mailgun-Dkim-Check-Result", "Fail"],
        ],
        undefined,
        forged,
      ).senderAuthentication,
    ).toBe("fail");
    // With no Received line at all, nothing can be told apart from the sender's headers.
    const unplaced = JSON.stringify([
      ["X-Mailgun-Spf", "Pass"],
      ["X-Mailgun-Dkim-Check-Result", "Pass"],
      ["Message-Id", "<m-2@example.com>"],
    ]);
    expect(
      toInboundEvent("conn-1", { sender: "a@example.com", recipient: "b@example.com", "message-headers": unplaced }, FIXED_NOW)
        .senderAuthentication,
    ).toBe("unknown");
  });

  it("carries the subject, where a reply's round token travels", () => {
    expect(event([], "Re: [tavi abcdefgh] Approval needed").subject).toBe("Re: [tavi abcdefgh] Approval needed");
  });
});
