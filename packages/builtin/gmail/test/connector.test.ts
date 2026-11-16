import { describe, expect, it, vi } from "vitest";

import { ChannelDescriptorSchema, channelIdentity, type InboundEvent, type MessagingConnection } from "@tavi/contracts";

import {
  addressOf,
  createGmailConnectorDefinition,
  GMAIL_CHANNEL_DESCRIPTOR,
  GmailConfigSchema,
  rawMessage,
  senderAuthenticationOf,
  toInboundEvent,
} from "../src/connector.js";

/** The Gmail channel. */

const connection: MessagingConnection = {
  connectionId: "gmail-1",
  providerId: "gmail",
  accountIdentity: "me@example.com",
  workspaceId: "w",
  configRevision: 1,
  enabled: true,
};
const header = (name: string, value: string) => ({ name, value });
const AT = "2026-10-09T00:00:00.000Z";

function message(id: string, headers: readonly { name: string; value: string }[], text = "hello there") {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(Date.parse(AT)),
    snippet: "hello",
    payload: {
      mimeType: "multipart/alternative",
      headers,
      parts: [
        { mimeType: "text/html", body: { data: Buffer.from("<b>x</b>").toString("base64url") } },
        { mimeType: "text/plain", body: { data: Buffer.from(text).toString("base64url") } },
      ],
    },
  };
}

const signed = (from: string) => [
  header("From", `Ana <${from}>`),
  header("Subject", "Plans"),
  header("Message-ID", `<${from}-1@mail>`),
  header(
    "Authentication-Results",
    "mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=ana@example.com; dmarc=pass header.from=example.com",
  ),
];

describe("the Gmail descriptor", () => {
  it("is a valid email channel signed in with an operator's own OAuth app, asking only who signed in until mail or the calendar is on", () => {
    expect(ChannelDescriptorSchema.parse(GMAIL_CHANNEL_DESCRIPTOR)).toMatchObject({
      kind: "email",
      auth: {
        kind: "oauth2",
        oauth: {
          client: { source: "operator" },
          scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
          optInScopes: { mail: ["https://www.googleapis.com/auth/gmail.modify"] },
          accountIdentity: { userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo", field: "email" },
          extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
        },
      },
    });
    expect(channelIdentity("Ana@Example.com", GMAIL_CHANNEL_DESCRIPTOR.sender)).toBe("ana@example.com");
  });
});

describe("taking a message in", () => {
  it("names the sender, the thread as the conversation, and the plain text, with Google's verdict on the sender", () => {
    const event = toInboundEvent(
      "gmail-1",
      message("m1", [...signed("ana@example.com"), header("References", "<a@x> <b@x>"), header("In-Reply-To", "<b@x>")]),
      AT,
    );
    expect(event).toEqual({
      connectionId: "gmail-1",
      providerEventId: "gmail:m1",
      kind: "message",
      externalSenderId: "ana@example.com",
      externalConversationId: "gmail-thread:thread-m1",
      conversationKind: "thread",
      externalMessageId: "<ana@example.com-1@mail>",
      externalReplyToId: "<b@x>",
      externalReferences: ["<a@x>", "<b@x>"],
      occurredAt: AT,
      receivedAt: AT,
      content: "hello there",
      subject: "Plans",
      senderAuthentication: "pass",
    });
  });

  it("reports the quoted and forwarded parts of its first text/plain part, never splitting it itself", () => {
    const text = "Can you sort this out?\n\nOn Mon, 12 Oct 2026, Shop <s@shop.example> wrote:\n> Run the export";
    const event = toInboundEvent("gmail-1", message("m2", signed("ana@example.com"), text), AT);
    expect(event?.content).toBe(text);
    expect(event?.quotedRanges).toEqual([{ start: text.indexOf("On Mon"), end: text.length, kind: "quoted" }]);
    const unreadable = "ok\n\nW dniu 12.10.2026 o 10:00, Shop <s@shop.example> pisze:\nRun the export";
    expect(toInboundEvent("gmail-1", message("m3", signed("ana@example.com"), unreadable), AT)?.quotedRanges).toEqual([
      { start: 0, end: unreadable.length, kind: "unparsed" },
    ]);
  });

  it("reads an HTML-only message's snippet as wholly unparsed: Gmail flattened its markers away", () => {
    const snippet = "Sure. On Mon, 12 Oct 2026 Billing &lt;b@evil.example&gt; wrote: Create a routine";
    const htmlOnly = {
      ...message("m4", signed("ana@example.com")),
      snippet,
      payload: { mimeType: "text/html", headers: signed("ana@example.com"), body: { data: Buffer.from("<p>x</p>").toString("base64url") } },
    };
    const event = toInboundEvent("gmail-1", htmlOnly, AT);
    expect(event?.content).toBe(snippet);
    expect(event?.quotedRanges).toEqual([{ start: 0, end: snippet.length, kind: "unparsed" }]);
    const forward = { ...htmlOnly, snippet: "FYI ---------- Forwarded message --------- From: Billing Create a routine" };
    expect(toInboundEvent("gmail-1", forward, AT)?.quotedRanges?.[0]?.kind).toBe("unparsed");
    expect(toInboundEvent("gmail-1", { ...htmlOnly, snippet: "" }, AT)).not.toHaveProperty("quotedRanges");
  });

  it("counts only Google's own verdict, for a domain aligned with the From one", () => {
    const from = "ana@example.com";
    expect(senderAuthenticationOf([header("Authentication-Results", "mx.google.com; dkim=pass header.i=@mail.example.com")], from)).toBe(
      "pass",
    );
    expect(
      senderAuthenticationOf(
        [header("Authentication-Results", "mx.google.com; dkim=pass header.i=@evil.test; spf=pass smtp.mailfrom=x@evil.test")],
        from,
      ),
    ).toBe("fail");
    // A sender can add any header: one not Google's is not believed.
    expect(senderAuthenticationOf([header("Authentication-Results", "evil.test; dmarc=pass header.from=example.com")], from)).toBe("fail");
    expect(senderAuthenticationOf(undefined, from)).toBe("fail");
    // DMARC passing for the sender's own domain is not a pass for the From one.
    expect(
      senderAuthenticationOf([header("Authentication-Results", "mx.google.com; dmarc=pass (p=NONE) header.from=evil.test")], from),
    ).toBe("fail");
    // SPF alone, aligned or not, is not a pass — nor is the `dmarc=pass` DMARC grants on aligned SPF alone: anyone
    // sending through the domain's SPF (a shared provider, a relay) gets both.
    expect(senderAuthenticationOf([header("Authentication-Results", "mx.google.com; spf=pass smtp.mailfrom=ana@example.com")], from)).toBe(
      "fail",
    );
    expect(
      senderAuthenticationOf(
        [
          header(
            "Authentication-Results",
            "mx.google.com; spf=pass (google.com: domain of bounce@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@example.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com",
          ),
        ],
        from,
      ),
    ).toBe("fail");
    expect(
      senderAuthenticationOf(
        [
          header(
            "Authentication-Results",
            "mx.google.com; dkim=fail header.i=@example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
          ),
        ],
        from,
      ),
    ).toBe("fail");
    // Only the topmost results are Google's: a forged one further down is not read.
    expect(
      senderAuthenticationOf(
        [
          header("Authentication-Results", "mx.google.com; dkim=fail header.i=@evil.test"),
          header("Authentication-Results", "mx.google.com; dmarc=pass header.from=example.com"),
        ],
        from,
      ),
    ).toBe("fail");
    // Text in a comment, or in a quoted envelope local part, is never read as a verdict.
    const spoofedSpf =
      'mx.google.com; spf=pass (google.com: domain of "x smtp.mailfrom=example.com "@evil.test designates 1.2.3.4 as permitted sender) smtp.mailfrom="x smtp.mailfrom=example.com "@evil.test';
    expect(senderAuthenticationOf([header("Authentication-Results", spoofedSpf)], from)).toBe("fail");
    expect(
      senderAuthenticationOf(
        [
          header(
            "Authentication-Results",
            "mx.google.com; dmarc=fail (p=REJECT dmarc=pass header.from=example.com) header.from=example.com",
          ),
        ],
        from,
      ),
    ).toBe("fail");
    expect(
      senderAuthenticationOf(
        [
          header(
            "Authentication-Results",
            "mx.google.com; dkim=pass header.i=@example.com header.s=s1; spf=pass (google.com: domain of ana@example.com designates 1.2.3.4) smtp.mailfrom=ana@example.com",
          ),
        ],
        from,
      ),
    ).toBe("pass");
    // A display name's quoted text is never the address.
    expect(addressOf('"<boss@example.com>" <attacker@evil.test>')).toBe("attacker@evil.test");
    expect(addressOf("(boss@example.com) attacker@evil.test")).toBe("attacker@evil.test");
    expect(addressOf("a@example.com, b@example.com")).toBeUndefined();
    expect(addressOf("<a@example.com> <b@example.com>")).toBeUndefined();
    const spoof = toInboundEvent(
      "gmail-1",
      message("m9", [
        header("From", '"<boss@example.com>" <attacker@evil.test>'),
        header("Authentication-Results", "mx.google.com; dkim=pass header.i=@evil.test; dmarc=pass header.from=evil.test"),
      ]),
      AT,
    );
    expect(spoof).toMatchObject({ externalSenderId: "attacker@evil.test", senderAuthentication: "pass" });
    // SPF-only mail, even with DMARC passing on it, reaches the host unverified: it fires no email trigger.
    const spfOnly = toInboundEvent(
      "gmail-1",
      message("m10", [
        header("From", "Ana <ana@example.com>"),
        header(
          "Authentication-Results",
          "mx.google.com; spf=pass smtp.mailfrom=ana@example.com; dmarc=pass (p=NONE) header.from=example.com",
        ),
      ]),
      AT,
    );
    expect(spfOnly).toMatchObject({ externalSenderId: "ana@example.com", senderAuthentication: "fail" });
    expect(addressOf('"Ana, Q" <Ana@Example.COM>')).toBe("ana@example.com");
    expect(addressOf("nobody")).toBeUndefined();
    // A control character in a display name stays behind with it; one in the address names no sender, never a stripped one.
    expect(addressOf("Ana\u001b]52;c;eA==\u0007 <ana@example.com>")).toBe("ana@example.com");
    expect(addressOf("<bo\u0000ss@example.com>")).toBeUndefined();
    expect(addressOf("bo\u001bss@example.com")).toBeUndefined();
    expect(addressOf("<boss@exam\u009bple.com>")).toBeUndefined();
  });
});

describe("the label it reads", () => {
  it("takes a label name, and never one that would end the search query", () => {
    expect(GmailConfigSchema.safeParse({ label: "tavi" }).success).toBe(true);
    expect(GmailConfigSchema.safeParse({ label: "Inbox/Tavi requests" }).success).toBe(true);
    expect(GmailConfigSchema.safeParse({ label: 'x" OR in:inbox OR "' }).success).toBe(false);
    expect(GmailConfigSchema.safeParse({ label: "x\\" }).success).toBe(false);
    expect(channelIdentity).toBeDefined();
  });
});

describe("the Gmail connector", () => {
  function fakeGmail(messages: Record<string, ReturnType<typeof message>>) {
    const modified: string[] = [];
    const sent: { raw: string; threadId?: string }[] = [];
    let listed = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = url.replace("https://gmail.googleapis.com/gmail/v1/users/me", "");
      if (path === "/profile") return new Response(JSON.stringify({ emailAddress: "me@example.com" }));
      if (path === "/labels" && init?.method !== "POST") return new Response(JSON.stringify({ labels: [{ id: "INBOX", name: "INBOX" }] }));
      if (path === "/labels") return new Response(JSON.stringify({ id: "L-processed", name: "tavi-processed" }));
      if (path.startsWith("/messages?")) {
        expect(decodeURIComponent(path)).toContain('q=label:"tavi" -label:"tavi-processed"');
        // Each message is listed until it is marked processed.
        const pending = listed ? [] : Object.keys(messages).filter((id) => !modified.includes(id));
        listed = true;
        return new Response(JSON.stringify({ messages: pending.map((id) => ({ id })) }));
      }
      if (path === "/messages/send") {
        sent.push(JSON.parse(String(init?.body)) as { raw: string; threadId?: string });
        return new Response(JSON.stringify({ id: "sent-1", threadId: "t" }));
      }
      const modify = /^\/messages\/([^/]+)\/modify$/.exec(path);
      if (modify?.[1] !== undefined) {
        expect(JSON.parse(String(init?.body))).toEqual({ addLabelIds: ["L-processed"] });
        modified.push(modify[1]);
        return new Response("{}");
      }
      const get = /^\/messages\/([^?]+)\?format=full$/.exec(path);
      if (get?.[1] !== undefined && messages[get[1]] !== undefined) return new Response(JSON.stringify(messages[get[1]]));
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, modified, sent };
  }

  it("takes in each labelled message once it is recorded, marking it processed, and leaves one the host did not take", async () => {
    const gmail = fakeGmail({ m1: message("m1", signed("ana@example.com")), m2: message("m2", signed("bo@example.com")) });
    const definition = createGmailConnectorDefinition({ fetch: gmail.fetchImpl, pollIntervalMs: 60_000, now: () => AT });
    const instance = definition.createConnection({
      connection,
      config: { label: "tavi" },
      credentials: { get: async () => null, accessToken: async () => "token" },
    });
    const received: InboundEvent[] = [];
    instance.onInboundEvent?.(async (event) => {
      if (event.externalSenderId === "bo@example.com") throw new Error("not recorded");
      received.push(event);
    });
    await instance.start();
    // Checked once the start has answered, not during it.
    expect(received).toEqual([]);
    await vi.waitFor(() => expect(gmail.modified).toEqual(["m1"]));
    expect(received.map((event) => event.providerEventId)).toEqual(["gmail:m1"]);
    await instance.stop();
  });

  it("starts once signed in, and a first check that fails is said on its status rather than failing the start", async () => {
    const gmail = fakeGmail({});
    const failingList = (async (url: string, init?: RequestInit) =>
      url.includes("/messages?") ? new Response("{}", { status: 500 }) : gmail.fetchImpl(url, init)) as unknown as typeof fetch;
    const definition = createGmailConnectorDefinition({ fetch: failingList, pollIntervalMs: 60_000, now: () => AT });
    const instance = definition.createConnection({
      connection,
      config: {},
      credentials: { get: async () => null, accessToken: async () => "token" },
    });
    await instance.start();
    try {
      await vi.waitFor(() =>
        expect(instance.status()).toMatchObject({ state: "running", detail: "last check failed: Gmail did not list messages (HTTP 500)" }),
      );
    } finally {
      await instance.stop();
    }
  });

  it("asks Gmail for nothing while it takes no mail in: it runs, checks nothing, and sends nothing as a channel", async () => {
    const asked: string[] = [];
    const definition = createGmailConnectorDefinition({
      fetch: (async (url: string) => {
        asked.push(url);
        return new Response("{}", { status: 403 });
      }) as unknown as typeof fetch,
      pollIntervalMs: 60_000,
      now: () => AT,
    });
    const instance = definition.createConnection({
      connection,
      config: { receive: false },
      credentials: { get: async () => null, accessToken: async () => "token" },
    });
    await instance.start();
    expect(instance.status()).toMatchObject({ state: "running", detail: "not taking mail in" });
    expect(await instance.probe?.()).toEqual({ ok: true, detail: "not taking mail in" });
    await expect(
      instance.send({
        effectId: "e",
        connectionId: connection.connectionId,
        destination: { to: "ana@example.com", subject: "Hi" },
        parts: [{ content: "Hi" }],
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await instance.stop();
    expect(asked).toEqual([]);
  });

  it("refuses to open on a mailbox other than the one it signed in to", async () => {
    const gmail = fakeGmail({});
    const definition = createGmailConnectorDefinition({ fetch: gmail.fetchImpl, pollIntervalMs: 60_000, now: () => AT });
    const elsewhere = definition.createConnection({
      connection: { ...connection, accountIdentity: "bob@example.com" },
      config: {},
      credentials: { get: async () => null, accessToken: async () => "token" },
    });
    await expect(elsewhere.start()).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/answers as me@example\.com/),
    });
  });

  it("keeps a long thread's first message id in a reply's References", () => {
    const definition = createGmailConnectorDefinition({ pollIntervalMs: 60_000, now: () => AT });
    const ancestors = Array.from({ length: 40 }, (_, index) => `<m${index}-${"x".repeat(30)}@x>`);
    const destination = definition.destinationFromInbound?.(
      {
        externalConversationId: "gmail-thread:t-9",
        externalSenderId: "ana@example.com",
        externalMessageId: "<latest@x>",
        externalReferences: ancestors,
        subject: "Plans",
      },
      connection,
    ) as { references?: string } | undefined;
    const references = destination?.references ?? "";
    expect(`References: ${references}`.length).toBeLessThanOrEqual(998);
    expect(references.startsWith("<m0-")).toBe(true);
    expect(references.endsWith("<latest@x>")).toBe(true);
  });

  it("replies in the thread, from the account, threaded and Re: the subject, with no header a value can add", async () => {
    const gmail = fakeGmail({});
    const definition = createGmailConnectorDefinition({ fetch: gmail.fetchImpl, pollIntervalMs: 60_000, now: () => AT });
    const instance = definition.createConnection({
      connection,
      config: {},
      credentials: { get: async () => null, accessToken: async () => "token" },
    });
    await instance.start();
    try {
      const destination = definition.destinationFromInbound?.(
        {
          externalConversationId: "gmail-thread:t-9",
          externalSenderId: "ana@example.com",
          externalMessageId: "<m@x>",
          externalReferences: ["<root@x>"],
          subject: "Plans",
        },
        connection,
      );
      expect(destination).toEqual({
        conversationId: "gmail-thread:t-9",
        to: "ana@example.com",
        subject: "Re: Plans",
        threadId: "t-9",
        inReplyTo: "<m@x>",
        references: "<root@x> <m@x>",
      });
      const outcome = await instance.send({
        effectId: "e",
        connectionId: "gmail-1",
        destination: { ...(destination as object), subject: "Re: Plans\r\nBcc: evil@x" },
        parts: [{ content: "Sounds good" }],
      });
      expect(outcome).toEqual({
        status: "accepted",
        retryable: false,
        parts: [{ index: 0, status: "accepted", providerMessageId: "sent-1" }],
      });
      expect(gmail.sent[0]?.threadId).toBe("t-9");
      const raw = Buffer.from(gmail.sent[0]?.raw ?? "", "base64url").toString("utf8");
      expect(raw).toContain(
        "From: me@example.com\r\nTo: ana@example.com\r\nSubject: Re: Plans Bcc: evil@x\r\nIn-Reply-To: <m@x>\r\nReferences: <root@x> <m@x>\r\n",
      );
      expect(raw).not.toMatch(/\r\nBcc:/);
      expect(Buffer.from(raw.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "", "base64").toString("utf8")).toBe("Sounds good");
    } finally {
      await instance.stop();
    }
    // A sign-in that cannot answer sent nothing: refused, so the send may be made again.
    let down = false;
    const failing = definition.createConnection({
      connection,
      config: {},
      credentials: {
        get: async () => null,
        accessToken: async () => {
          if (down) throw new Error("token endpoint down");
          return "token";
        },
      },
    });
    await failing.start();
    down = true;
    try {
      await expect(
        failing.send({
          effectId: "e2",
          connectionId: "gmail-1",
          destination: { to: "ana@example.com", subject: "x" },
          parts: [{ content: "x" }],
        }),
      ).rejects.toMatchObject({ code: "UNAVAILABLE", message: "token endpoint down" });
      expect(gmail.sent).toHaveLength(1);
    } finally {
      await failing.stop();
    }
    expect(Buffer.from(rawMessage({ from: "a@x", to: "b@x", subject: "Grüße", text: "x" }), "base64url").toString("utf8")).toContain(
      "Subject: =?UTF-8?B?R3LDvMOfZQ==?=",
    );
  });

  it("waits as long as a rate limit says, in seconds or as an HTTP date", async () => {
    const gmail = fakeGmail({});
    for (const [header, wait] of [
      ["30", 30_000],
      [new Date(Date.parse(AT) + 90_000).toUTCString(), 90_000],
      [null, 60_000],
    ] as const) {
      const limited = (async (url: string, init?: RequestInit) =>
        url.endsWith("/messages/send")
          ? new Response("{}", { status: 429, headers: header === null ? {} : { "retry-after": header } })
          : gmail.fetchImpl(url, init)) as unknown as typeof fetch;
      const instance = createGmailConnectorDefinition({ fetch: limited, pollIntervalMs: 60_000, now: () => AT }).createConnection({
        connection,
        config: {},
        credentials: { get: async () => null, accessToken: async () => "token" },
      });
      await instance.start();
      try {
        const outcome = await instance.send({
          effectId: `e-${wait}`,
          connectionId: "gmail-1",
          destination: { to: "ana@example.com", subject: "x" },
          parts: [{ content: "x" }],
        });
        expect(outcome).toMatchObject({ retryAfterMs: wait });
      } finally {
        await instance.stop();
      }
    }
  });
});

describe("where a Google account's calls go", () => {
  it("declares every API host its mailbox, calendar and channel call, so its page lists them beside the sign-in", async () => {
    const { readFileSync } = await import("node:fs");
    const apis = ["connector.ts", "tools.ts", "calendar.ts"].map((file) => {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      return /const API = "https:\/\/([^/"]+)/.exec(source)?.[1];
    });
    expect(apis).toEqual(["gmail.googleapis.com", "gmail.googleapis.com", "www.googleapis.com"]);
    expect(GMAIL_CHANNEL_DESCRIPTOR.hosts).toEqual(expect.arrayContaining([...new Set(apis)]));
    expect(ChannelDescriptorSchema.safeParse(GMAIL_CHANNEL_DESCRIPTOR).success).toBe(true);
  });
});
