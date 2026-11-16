import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * A replacement for the built-in Mailgun channel (docs/CHANNEL-PLUGINS.md):
 * with `tavi.mailgun` disabled it takes the `mailgun` provider id. Mailgun's
 * inbound route posts each email to the connection's `inbound` webhook; the
 * post is checked against the webhook signing key (HMAC-SHA256 of
 * timestamp + token, compared in constant time, within five minutes), and
 * the token is the replay key, so a captured post is never taken twice.
 * Replies go out through the Messages API. Text only: attachments are
 * dropped, never read.
 */

const TOLERANCE_SECONDS = 300;
/** Mailgun's HMAC covers only timestamp + token, so the token is remembered for the whole window a timestamp may be accepted in. */
const REPLAY_TTL_MS = (2 * TOLERANCE_SECONDS + 60) * 1000;
const MAX_HEADER = 998;

const same = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** A header value with no line breaks, so nothing put in it can add a header such as `Bcc:`. */
const headerSafe = (value) =>
  String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, MAX_HEADER);

/** The text fields of the post, urlencoded or multipart, parsed once per request; file parts are skipped. */
const parsedFields = new WeakMap();
async function fieldsOf(request) {
  const cached = parsedFields.get(request);
  if (cached !== undefined) return cached;
  let fields;
  try {
    const form = await new Response(request.rawBody, {
      headers: { "content-type": String(request.headers["content-type"] ?? "") },
    }).formData();
    fields = {};
    for (const [name, value] of form) if (typeof value === "string") fields[name] = value;
  } catch {
    fields = undefined;
  }
  parsedFields.set(request, fields);
  return fields;
}

/** Mailgun's signature: fresh, and HMAC-SHA256(signing key, timestamp + token) in hex. */
export function signatureHolds(fields, signingKey, now) {
  const { timestamp, token, signature } = fields;
  if (typeof timestamp !== "string" || typeof token !== "string" || typeof signature !== "string" || token === "") return false;
  const seconds = Number.parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.parse(now) / 1000);
  if (!Number.isFinite(seconds) || !Number.isFinite(nowSeconds) || Math.abs(nowSeconds - seconds) > TOLERANCE_SECONDS) return false;
  return same(
    signature,
    createHmac("sha256", signingKey)
      .update(timestamp + token)
      .digest("hex"),
  );
}

const addressOf = (header) => {
  const all = String(header ?? "").match(/[^\s<>,;"@]+@[^\s<>,;"@]+/g) ?? [];
  return all.length === 1 ? all[0].toLowerCase() : undefined;
};
const domainOf = (address) => address?.split("@")[1];
const aligned = (left, right) =>
  left !== undefined && right !== undefined && (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`));

/**
 * Whether Mailgun vouches for the sender: its own SPF and DKIM verdicts, which
 * it writes above the first `Received` line (anything below is the sender's),
 * both `Pass`, and the From address's domain aligned with the envelope sender's.
 */
export function senderAuthenticationOf(fields) {
  let headers;
  try {
    headers = JSON.parse(fields["message-headers"] ?? "[]");
  } catch {
    return "unknown";
  }
  if (!Array.isArray(headers)) return "unknown";
  const firstReceived = headers.findIndex((pair) => String(pair?.[0]).toLowerCase() === "received");
  if (firstReceived < 0) return "unknown";
  const ours = headers.slice(0, firstReceived);
  const verdict = (name) => {
    const values = ours.filter((pair) => String(pair?.[0]).toLowerCase() === name);
    return values.length === 1 ? String(values[0][1]).trim().toLowerCase() : undefined;
  };
  const spf = verdict("x-mailgun-spf");
  const dkim = verdict("x-mailgun-dkim-check-result");
  if (spf === undefined || dkim === undefined) return "unknown";
  if (spf !== "pass" || dkim !== "pass") return "fail";
  return aligned(domainOf(addressOf(fields.from ?? fields.sender)), domainOf(addressOf(fields.sender))) ? "pass" : "fail";
}

const headerOf = (fields, name) => {
  try {
    const headers = JSON.parse(fields["message-headers"] ?? "[]");
    return headers.find((pair) => String(pair?.[0]).toLowerCase() === name.toLowerCase())?.[1];
  } catch {
    return undefined;
  }
};

const digest = (text) => createHash("sha256").update(text).digest("hex");

export function mailgunLiteChannel({ z, TaviError, fetch = globalThis.fetch }) {
  return {
    providerId: "mailgun",
    version: "0.1.0",
    configSchema: z
      .object({ domain: z.string().min(1).max(253), from: z.string().optional(), apiBaseUrl: z.string().url().optional() })
      .passthrough(),
    capabilities: {
      receiveMode: "webhook",
      send: true,
      editOrProgress: false,
      formats: ["plain"],
      attachments: false,
      maxAttachmentBytes: 0,
      maxPartsPerMessage: 1,
      threads: true,
      interactions: false,
      deliveryReceipts: false,
      maxTextLength: 100_000,
      approvals: "reply-token",
    },
    createConnection: ({ connection, config, credentials }) => {
      const base = (config.apiBaseUrl ?? "https://api.mailgun.net/v3").replace(/\/+$/, "");
      let state = "stopped";
      let since = new Date().toISOString();
      const auth = async () => {
        const key = await credentials.get("apiKey");
        if (key === null) throw new TaviError("UNAVAILABLE", "no Mailgun API key is set");
        return { key, header: `Basic ${Buffer.from(`api:${key}`).toString("base64")}` };
      };
      /** Mailgun's own word on the domain and key; the key is in a header, never the address, and never in an error. */
      const checkDomain = async () => {
        try {
          const { header } = await auth();
          const response = await fetch(`${base}/domains/${encodeURIComponent(config.domain)}`, {
            headers: { authorization: header },
            signal: AbortSignal.timeout(10_000),
          });
          return response.ok ? { ok: true } : { ok: false, detail: `Mailgun refused the domain check (HTTP ${response.status})` };
        } catch (error) {
          return { ok: false, detail: error instanceof TaviError ? error.message : "Mailgun could not be reached" };
        }
      };
      return {
        async start() {
          const checked = await checkDomain();
          if (!checked.ok) throw new Error(checked.detail);
          state = "running";
          since = new Date().toISOString();
        },
        async stop() {
          state = "stopped";
        },
        status: () => ({ state, since }),
        probe: async () => (state === "running" ? await checkDomain() : { ok: false, detail: "the connection is not running" }),
        async send(message) {
          if (state !== "running") throw new TaviError("UNAVAILABLE", `Mailgun connection ${connection.connectionId} is not running`);
          const part = message.parts[0];
          if (message.parts.length !== 1 || part === undefined || "artifactId" in part)
            return {
              status: "rejected",
              retryable: false,
              parts: [{ index: 0, status: "rejected", error: "this channel sends one text part" }],
            };
          const to = message.destination?.to;
          if (typeof to !== "string")
            return { status: "rejected", retryable: false, parts: [{ index: 0, status: "rejected", error: "no recipient" }] };
          const { header } = await auth();
          const body = new URLSearchParams({
            from: headerSafe(message.destination?.from ?? connection.accountIdentity),
            to: headerSafe(to),
            subject: headerSafe(message.subject ?? message.destination?.subject ?? "A message from Tavi"),
            text: part.content,
          });
          if (message.destination?.inReplyTo !== undefined) body.set("h:In-Reply-To", headerSafe(message.destination.inReplyTo));
          if (message.destination?.references !== undefined) body.set("h:References", headerSafe(message.destination.references));
          let response;
          try {
            response = await fetch(`${base}/${encodeURIComponent(config.domain)}/messages`, {
              method: "POST",
              headers: { authorization: header, "content-type": "application/x-www-form-urlencoded" },
              body: body.toString(),
              signal: AbortSignal.timeout(30_000),
            });
          } catch {
            // It may have gone out: unknown, and never retried blind.
            return { status: "uncertain", retryable: false, parts: [{ index: 0, status: "uncertain", error: "Mailgun did not answer" }] };
          }
          const answer = await response.json().catch(() => undefined);
          if (response.ok && typeof answer?.id === "string")
            return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: answer.id }] };
          if (response.status === 429)
            return {
              status: "rejected",
              retryable: true,
              retryAfterMs: 60_000,
              parts: [{ index: 0, status: "rejected", error: "HTTP 429" }],
            };
          const status = response.ok || response.status >= 500 ? "uncertain" : "rejected";
          return { status, retryable: false, parts: [{ index: 0, status, error: `HTTP ${response.status}` }] };
        },
      };
    },
    // A reply goes to the person who wrote, from this connection's address, in the same thread.
    destinationFromInbound: (replyTo, connection) => ({
      conversationId: replyTo.externalConversationId,
      to: replyTo.externalSenderId,
      from: connection.accountIdentity,
      subject: headerSafe(/^re:/i.test(replyTo.subject ?? "") ? replyTo.subject : `Re: ${replyTo.subject ?? "your message"}`),
      ...(replyTo.externalMessageId === undefined
        ? {}
        : {
            inReplyTo: replyTo.externalMessageId,
            references: [...(replyTo.externalReferences ?? []), replyTo.externalMessageId].join(" "),
          }),
    }),
    destinationFor: (target, connection) => ({
      to: target.to,
      from: connection.accountIdentity,
      subject: target.subject ?? "A message from Tavi",
    }),
    directDestinationOf: (externalSenderId, connection) => ({ to: externalSenderId, from: connection?.accountIdentity }),
    paceTargetOf: (destination) => (typeof destination?.to === "string" ? destination.to : undefined),
    ingress: {
      async verify(request, context) {
        const fields = await fieldsOf(request);
        const signingKey = await context.credentials.get("webhookSigningKey");
        if (fields === undefined || signingKey === null || !signatureHolds(fields, signingKey, context.now())) return { ok: false };
        return { ok: true, replayKey: digest(`${context.connection.connectionId}:${fields.token}`), replayTtlMs: REPLAY_TTL_MS };
      },
      async handle(request, context) {
        const fields = await fieldsOf(request);
        const sender = addressOf(fields?.sender);
        const messageId = headerOf(fields ?? {}, "Message-Id");
        if (fields === undefined || sender === undefined || typeof fields.recipient !== "string" || typeof messageId !== "string")
          throw new TaviError("INVALID_INPUT", "the post is not a Mailgun inbound message");
        const inReplyTo = headerOf(fields, "In-Reply-To");
        const references = String(headerOf(fields, "References") ?? "")
          .split(/\s+/)
          .filter((id) => id !== "");
        const root = references[0] ?? inReplyTo ?? messageId;
        const seconds = Number.parseInt(fields.timestamp ?? "", 10);
        const subject = String(fields.subject ?? "").trim();
        return {
          events: [
            {
              connectionId: context.connection.connectionId,
              // Scoped to the sender: one sender cannot take another's Message-Id first and have their mail dropped.
              providerEventId: `mail:${digest(`${sender}\n${messageId}`)}`,
              kind: "message",
              externalSenderId: sender,
              externalConversationId: `${fields.recipient.slice(0, 200)}#${digest(root).slice(0, 24)}`,
              conversationKind: "thread",
              externalMessageId: messageId,
              ...(typeof inReplyTo === "string" ? { externalReplyToId: inReplyTo } : {}),
              ...(references.length === 0 ? {} : { externalReferences: references }),
              occurredAt: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : context.now(),
              receivedAt: context.now(),
              content: fields["stripped-text"] ?? fields["body-plain"] ?? "",
              ...(subject === "" ? {} : { subject: subject.slice(0, MAX_HEADER) }),
              senderAuthentication: senderAuthenticationOf(fields),
            },
          ],
        };
      },
    },
  };
}

export function register({ registerChannel, z, TaviError }) {
  registerChannel(mailgunLiteChannel({ z, TaviError }));
}
