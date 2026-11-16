import { describeGroupChannelConformance, type GroupFake, type GroupFakeSend, type GroupScript } from "@tavi/channel-kit/conformance";

import { createTelegramConnectorDefinition, TELEGRAM_CHANNEL_DESCRIPTOR } from "../src/connector.js";

/**
 * Telegram passes the group conformance suite over a fake Bot API: a
 * supergroup, the bot `@conformance_bot`, a
 * user who started it and one who never did.
 */

const BOT = 1;
const ROOM = -1001;
const OPEN = 501;
const CLOSED = 502;
const TOKEN = "123456:conformance-s3cret";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function fakeBotApi(): GroupFake {
  let seq = 0;
  let messageId = 1000;
  const queue: unknown[] = [];
  const sent: GroupFakeSend[] = [];
  /** Waiters for the poll that acknowledges an update id. */
  const acknowledged: { readonly id: number; readonly resolve: () => void }[] = [];
  let wake: (() => void) | undefined;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (method === "getMe") return json({ ok: true, result: { id: BOT, is_bot: true, username: "conformance_bot" } });
    if (method === "getUpdates") {
      const offset = typeof body["offset"] === "number" ? body["offset"] : 0;
      for (const waiter of acknowledged.filter((entry) => entry.id < offset)) {
        acknowledged.splice(acknowledged.indexOf(waiter), 1);
        waiter.resolve();
      }
      while (queue.length === 0) {
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }
      return json({ ok: true, result: queue.splice(0) });
    }
    if (method === "sendMessage") {
      const chat = Number(body["chat_id"]);
      if (chat === CLOSED)
        return json({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
      const preview = (body["link_preview_options"] as { is_disabled?: boolean } | undefined)?.is_disabled !== true;
      const text = String(body["text"]);
      // Telegram has no mass mention: `@everyone` is plain text there.
      sent.push({
        conversation: String(chat),
        visibleInRoom: true,
        text,
        linkPreview: preview && /https?:\/\//.test(text),
        massMention: false,
      });
      messageId += 1;
      return json({ ok: true, result: { message_id: messageId, date: 0, chat: { id: chat } } });
    }
    // A callback answer is a toast on the presser's own client.
    if (method === "answerCallbackQuery") {
      sent.push({
        conversation: "callback",
        visibleInRoom: false,
        text: String(body["text"] ?? ""),
        linkPreview: false,
        massMention: false,
      });
      return json({ ok: true, result: true });
    }
    return json({ ok: true, result: true });
  }) as unknown as typeof fetch;

  const room = { id: ROOM, type: "supergroup", title: "Conformance" };
  const update = (script: GroupScript): Record<string, unknown> => {
    const id = (messageId += 1);
    const base = { message_id: id, date: 1_700_000_000, chat: room, from: { id: OPEN, is_bot: false } };
    switch (script.kind) {
      case "mention":
        return { message: { ...base, text: "@conformance_bot hello", entities: [{ type: "mention", offset: 0, length: 16 }] } };
      case "reply":
        return { message: { ...base, text: "yes", reply_to_message: { message_id: 7, from: { id: BOT } } } };
      case "command":
        return { message: { ...base, text: "/ask@conformance_bot hello", entities: [{ type: "bot_command", offset: 0, length: 20 }] } };
      case "plain":
        return { message: { ...base, text: "just talking" } };
      case "bot":
        return { message: { ...base, text: "beep", from: { id: 99, is_bot: true } } };
      case "system":
        // A service message (someone joined): no text, so nothing is handed over.
        return { message: { ...base, new_chat_members: [{ id: 77 }] } };
      case "press":
        return {
          callback_query: {
            id: `cb-${id}`,
            from: { id: Number(script.presser) },
            data: script.data,
            message: { message_id: 7, chat: { id: ROOM } },
          },
        };
      case "direct":
        return {
          message: { ...base, chat: { id: Number(script.sender), type: "private" }, from: { id: Number(script.sender) }, text: "hi" },
        };
      default:
        throw new Error(`Telegram reports no ${script.kind}`);
    }
  };
  const definition = createTelegramConnectorDefinition({ fetch: fetchImpl, pollErrorBackoffMs: 1, requestTimeoutMs: 1000 });
  const connection = {
    connectionId: "tg-conformance",
    providerId: "telegram",
    accountIdentity: "conformance_bot",
    workspaceId: "w",
    configRevision: 1,
    enabled: true,
    credentialRef: "telegram.token",
  };
  return {
    definition,
    instance: definition.createConnection({
      connection,
      config: {},
      credentials: { get: async () => TOKEN, accessToken: async () => TOKEN },
    }),
    connection,
    room: String(ROOM),
    openSender: String(OPEN),
    closedSender: String(CLOSED),
    secret: TOKEN,
    async emit(script) {
      seq += 1;
      const id = seq;
      queue.push({ update_id: id, ...update(script) });
      wake?.();
      await new Promise<void>((resolve) => acknowledged.push({ id, resolve }));
    },
    sent: () => sent,
  };
}

describeGroupChannelConformance("Telegram", { descriptor: TELEGRAM_CHANNEL_DESCRIPTOR, fake: async () => fakeBotApi() });
