import { createHash, timingSafeEqual } from "node:crypto";

/**
 * A replacement for the built-in Telegram channel (docs/CHANNEL-PLUGINS.md):
 * with `tavi.telegram` disabled it takes the `telegram` provider id. Where
 * the built-in polls `getUpdates`, this one is told by Telegram's webhook,
 * checked by the `X-Telegram-Bot-Api-Secret-Token` header set with
 * `setWebhook`, and answers with `sendMessage`. Text only, direct chats only.
 */

const same = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

function parsed(request) {
  try {
    return JSON.parse(Buffer.from(request.rawBody).toString("utf8"));
  } catch {
    return undefined;
  }
}

export function telegramWebhookChannel({ z, TaviError, fetch = globalThis.fetch }) {
  return {
    providerId: "telegram",
    version: "0.1.0",
    configSchema: z.object({ botUsername: z.string(), apiBaseUrl: z.string().url().optional() }).passthrough(),
    capabilities: {
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
      approvals: "reply-token",
    },
    createConnection: ({ connection, config, credentials }) => {
      const base = config.apiBaseUrl ?? "https://api.telegram.org";
      let state = "stopped";
      let since = new Date().toISOString();
      /** The bot the token signs in as (`getMe`), or why it does not: a revoked token is said, never taken as healthy. */
      const whoAmI = async () => {
        const token = await credentials.get("token");
        if (token === null) return { ok: false, detail: "no bot token is set" };
        try {
          const response = await fetch(`${base}/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
          const answer = await response.json().catch(() => undefined);
          return response.ok && answer?.ok === true
            ? { ok: true, detail: `Bot @${String(answer.result?.username ?? "")}.` }
            : { ok: false, detail: `Telegram refused the token (HTTP ${response.status})` };
        } catch (error) {
          return {
            ok: false,
            detail: String(error?.message ?? error)
              .split(token)
              .join("[redacted]"),
          };
        }
      };
      return {
        async start() {
          const checked = await whoAmI();
          if (!checked.ok) throw new Error(checked.detail);
          state = "running";
          since = new Date().toISOString();
        },
        async stop() {
          state = "stopped";
        },
        status: () => ({ state, since }),
        probe: async () => (state === "running" ? await whoAmI() : { ok: false, detail: "the connection is not running" }),
        async send(message) {
          if (state !== "running") throw new TaviError("UNAVAILABLE", `Telegram connection ${connection.connectionId} is not running`);
          const part = message.parts[0];
          if (part === undefined || "artifactId" in part)
            return {
              status: "rejected",
              retryable: false,
              parts: [{ index: 0, status: "rejected", error: "this channel sends text only" }],
            };
          const token = await credentials.get("token");
          let response;
          let answer;
          try {
            response = await fetch(`${base}/bot${token}/sendMessage`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: message.destination?.chatId, text: part.content }),
              signal: AbortSignal.timeout(30_000),
            });
            answer = await response.json().catch(() => undefined);
          } catch (error) {
            // It may have gone out; the token is in the address, so it never reaches the error.
            return {
              status: "uncertain",
              retryable: false,
              parts: [
                {
                  index: 0,
                  status: "uncertain",
                  error: String(error?.message ?? error)
                    .split(token ?? "\u0000")
                    .join("[redacted]"),
                },
              ],
            };
          }
          const id = answer?.result?.message_id;
          if (response.ok && answer?.ok === true && id !== undefined)
            return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: String(id) }] };
          if (response.status === 429) {
            const seconds = Number(answer?.parameters?.retry_after ?? 1);
            return {
              status: "rejected",
              retryable: true,
              retryAfterMs: Math.round(seconds * 1000),
              parts: [{ index: 0, status: "rejected", error: "HTTP 429" }],
            };
          }
          const status = response.status >= 400 && response.status < 500 ? "rejected" : "uncertain";
          return { status, retryable: false, parts: [{ index: 0, status, error: `HTTP ${response.status}` }] };
        },
      };
    },
    destinationFor: (target) => ({ chatId: target.to }),
    destinationFromInbound: (replyTo) => ({ chatId: replyTo.externalConversationId }),
    directDestinationOf: (externalSenderId) => ({ chatId: externalSenderId }),
    paceTargetOf: (destination) => (destination?.chatId === undefined ? undefined : String(destination.chatId)),
    ingress: {
      async verify(request, context) {
        const secret = await context.credentials.get("webhookSecret");
        const given = String(request.headers["x-telegram-bot-api-secret-token"] ?? "");
        if (secret === null || !same(given, secret)) return { ok: false };
        // Telegram redelivers an update it was not answered 200 for: one update id is taken once.
        const update = parsed(request)?.update_id;
        return {
          ok: true,
          replayKey: createHash("sha256").update(`${context.connection.connectionId}:${update}`).digest("hex"),
          replayTtlMs: 24 * 60 * 60 * 1000,
        };
      },
      async handle(request, context) {
        const update = parsed(request);
        if (typeof update?.update_id !== "number") throw new TaviError("INVALID_INPUT", "the delivery is not a Telegram update");
        const message = update.message;
        // Groups, channels, edits and anything without text are not this example's.
        if (message?.chat?.type !== "private" || typeof message.text !== "string") return { events: [] };
        const sender = String(message.from?.id ?? message.chat.id);
        return {
          events: [
            {
              connectionId: context.connection.connectionId,
              providerEventId: String(update.update_id),
              kind: "message",
              externalSenderId: sender,
              externalConversationId: String(message.chat.id),
              conversationKind: "direct",
              externalMessageId: String(message.message_id),
              occurredAt: new Date(Number(message.date ?? 0) * 1000 || Date.parse(context.now())).toISOString(),
              receivedAt: context.now(),
              content: message.text,
            },
          ],
        };
      },
    },
  };
}

export function register({ registerChannel, z, TaviError }) {
  registerChannel(telegramWebhookChannel({ z, TaviError }));
}
