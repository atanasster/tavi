import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * A test-only channel plugin shaped like Meta's WhatsApp Cloud API
 * (docs/CHANNEL-PLUGINS.md): Tavi does not ship
 * WhatsApp, and this proves a plugin can. It has what makes that API its own —
 * one webhook address for every number (a provider-level route), a GET verify
 * challenge, an `X-Hub-Signature-256` HMAC over the raw body, the number an
 * event is for named in its body, e164 senders, up to three reply buttons,
 * media by id, delivery statuses, and the 24-hour customer-service window.
 *
 * Plain JavaScript with Node builtins only, as an external plugin's entry must
 * be. Never connect it to a real number.
 */

const WINDOW_CLOSED = 131047;

/** A sender or target as the channel names it: `15551234567` → `+15551234567`. */
function e164(number) {
  return number.startsWith("+") ? number : `+${number}`;
}

function bodyText(request) {
  return Buffer.from(request.rawBody).toString("utf8");
}

function parsedBody(request) {
  try {
    return JSON.parse(bodyText(request));
  } catch {
    return undefined;
  }
}

/** Every change a webhook delivery carries. */
function changesOf(body) {
  return (body?.entry ?? []).flatMap((entry) => entry?.changes ?? []).map((change) => change?.value ?? {});
}

function statusOf(status) {
  if (status === "read") return "read";
  if (status === "delivered") return "delivered";
  if (status === "failed") return "failed";
  return undefined;
}

/** The connector, over `fetch` (a fake provider in tests). */
export function createWhatsappLikeDefinition({ z, TaviError, fetch: fetchImpl = globalThis.fetch }) {
  const capabilities = {
    receiveMode: "webhook", send: true, editOrProgress: false, formats: ["plain"], attachments: false, maxAttachmentBytes: 0,
    maxPartsPerMessage: 1, threads: false, interactions: true, deliveryReceipts: true, maxTextLength: 4096, approvals: "buttons",
  };
  return {
    providerId: "wa-like",
    version: "1.0.0",
    configSchema: z.object({ phoneNumberId: z.string().regex(/^\d{1,32}$/), apiBaseUrl: z.string().url().optional() }).passthrough(),
    capabilities,
    createConnection: ({ connection, config, credentials }) => {
      const base = config.apiBaseUrl ?? "https://graph.facebook.com/v20.0";
      let state = "stopped";
      let since = new Date().toISOString();
      const timed = (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(config.requestTimeoutMs ?? 30_000) });
      return {
        async start() {
          if ((await credentials.get("accessToken")) === null) throw new Error("no access token");
          state = "running";
          since = new Date().toISOString();
        },
        async stop() {
          state = "stopped";
        },
        status: () => ({ state, since }),
        probe: async () => ({ ok: state === "running" }),
        async send(message) {
          // Refused before it went out, in the host's own words: nothing was sent, and it may be sent again.
          if (state !== "running") throw new TaviError("UNAVAILABLE", `WhatsApp-like connection ${connection.connectionId} is not running`);
          const part = message.parts[0];
          if (part === undefined || "artifactId" in part) return { status: "rejected", retryable: false, parts: [{ index: 0, status: "rejected", error: "wa-like does not support file attachments" }] };
          const to = String(message.destination?.to ?? "").replace(/^\+/, "");
          const buttons = (message.buttons ?? []).flat().slice(0, 3);
          const payload = buttons.length === 0
            ? { messaging_product: "whatsapp", to, type: "text", text: { body: part.content } }
            : { messaging_product: "whatsapp", to, type: "interactive", interactive: { type: "button", body: { text: part.content }, action: { buttons: buttons.map((button) => ({ type: "reply", reply: { id: button.data, title: button.label.slice(0, 20) } })) } } };
          const token = await credentials.get("accessToken");
          let response;
          let answer;
          try {
            response = await timed(`${base}/${connection.accountIdentity}/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
            answer = await response.json().catch(() => undefined);
          } catch (error) {
            // In flight: it may have gone out. Its words never carry the token.
            return { status: "uncertain", retryable: false, parts: [{ index: 0, status: "uncertain", error: String(error?.message ?? error).split(token ?? "\u0000").join("[redacted]") }] };
          }
          const id = answer?.messages?.[0]?.id;
          if (response.ok && typeof id === "string") return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: id }] };
          const code = answer?.error?.code;
          // Outside the 24-hour window a free-form message is refused: only an approved template may open it again.
          if (code === WINDOW_CLOSED) return { status: "rejected", retryable: false, parts: [{ index: 0, status: "rejected", error: "outside the 24-hour customer-service window: the person must write first" }] };
          // Throttled: nothing was sent; the host waits as long as the provider asks and tries again.
          if (response.status === 429) {
            const seconds = Number(response.headers.get("retry-after") ?? "1");
            return { status: "rejected", retryable: true, retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 1000, parts: [{ index: 0, status: "rejected", error: "HTTP 429" }] };
          }
          return { status: response.status >= 400 && response.status < 500 ? "rejected" : "uncertain", retryable: false, parts: [{ index: 0, status: response.status >= 400 && response.status < 500 ? "rejected" : "uncertain", error: `HTTP ${response.status}` }] };
        },
        /** A media id → its address → its bytes, within the cap. */
        async fetchMedia(handle, { signal }) {
          const token = await credentials.get("accessToken");
          const located = await fetchImpl(`${base}/${handle.ref}`, { headers: { authorization: `Bearer ${token}` }, signal });
          if (!located.ok) throw new Error(`the media lookup answered HTTP ${located.status}`);
          const url = (await located.json())?.url;
          if (typeof url !== "string") throw new Error("the provider did not say where the media is");
          // The download itself: the host reads it, and stops at the cap.
          return fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal });
        },
      };
    },
    destinationFor: (target) => ({ to: target.to }),
    destinationFromInbound: (replyTo) => ({ to: replyTo.externalSenderId }),
    paceTargetOf: (destination) => (typeof destination?.to === "string" ? destination.to : undefined),
    ingress: {
      /** One address for every number: the number an event is for is in its body; a GET verify names none, so the host asks each number's verify. */
      connectionFor(request, connections) {
        if (request.method === "GET") return undefined;
        const number = changesOf(parsedBody(request))[0]?.metadata?.phone_number_id;
        return connections.find((candidate) => candidate.accountIdentity === number)?.connectionId;
      },
      async verify(request, context) {
        if (request.method === "GET") {
          const expected = await context.credentials.get("verifyToken");
          return { ok: expected !== null && request.query["hub.mode"] === "subscribe" && request.query["hub.verify_token"] === expected };
        }
        const secret = await context.credentials.get("appSecret");
        const given = String(request.headers["x-hub-signature-256"] ?? "");
        if (secret === null || !given.startsWith("sha256=")) return { ok: false };
        const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(request.rawBody).digest("hex")}`);
        const actual = Buffer.from(given);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false };
        return { ok: true, replayKey: createHash("sha256").update(request.rawBody).digest("hex"), replayTtlMs: 10 * 60 * 1000 };
      },
      async handle(request, context) {
        if (request.method === "GET") return { events: [], response: { status: 200, body: String(request.query["hub.challenge"] ?? ""), contentType: "text/plain" } };
        const body = parsedBody(request);
        if (body?.object !== "whatsapp_business_account") throw new TaviError("INVALID_INPUT", "the delivery is not a WhatsApp Business Account webhook");
        const at = context.now();
        const events = [];
        // Only this connection's number: a delivery batching several numbers' changes names each one's own.
        for (const value of changesOf(body).filter((change) => change.metadata?.phone_number_id === context.connection.accountIdentity)) {
          for (const message of value.messages ?? []) {
            const sender = e164(String(message.from));
            const base = { connectionId: context.connection.connectionId, externalSenderId: sender, externalConversationId: sender, conversationKind: "direct", externalMessageId: message.id, occurredAt: new Date(Number(message.timestamp ?? 0) * 1000 || Date.parse(at)).toISOString(), receivedAt: at };
            if (message.type === "interactive" && message.interactive?.button_reply !== undefined) {
              events.push({ ...base, providerEventId: message.id, kind: "interaction", interaction: { data: message.interactive.button_reply.id, callbackId: message.id, messageId: message.context?.id ?? message.id } });
            } else if (message.type === "image" || message.type === "audio" || message.type === "document") {
              const media = message[message.type];
              events.push({ ...base, providerEventId: message.id, kind: "message", ...(media?.caption === undefined ? {} : { content: media.caption }), media: [{ ref: media.id, ...(media.mime_type === undefined ? {} : { mimeType: media.mime_type }), ...(media.filename === undefined ? {} : { filename: media.filename }) }] });
            } else {
              events.push({ ...base, providerEventId: message.id, kind: "message", content: message.text?.body ?? "" });
            }
          }
          for (const status of value.statuses ?? []) {
            const known = statusOf(status.status);
            if (known === undefined) continue;
            events.push({ connectionId: context.connection.connectionId, providerEventId: `status:${status.id}:${status.status}`, kind: "delivery", externalSenderId: e164(String(status.recipient_id ?? "")), externalConversationId: e164(String(status.recipient_id ?? "")), occurredAt: at, receivedAt: at, delivery: { providerMessageId: status.id, status: known } });
          }
        }
        return { events };
      },
    },
  };
}

export function register({ registerChannel, z, TaviError }) {
  registerChannel(createWhatsappLikeDefinition({ z, TaviError }));
}
