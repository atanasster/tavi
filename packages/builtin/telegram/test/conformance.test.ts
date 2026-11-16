import { describeChannelConformance, type ProviderMood } from "@tavi/channel-kit/conformance";

import { createTelegramConnectorDefinition, TELEGRAM_CHANNEL_DESCRIPTOR } from "../src/connector.js";

/** Telegram against the channel conformance suite. */

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const hang = (signal?: AbortSignal | null): Promise<Response> =>
  new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

function fakeTelegram(mood: ProviderMood): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/getMe")) return json({ ok: true, result: { id: 7 } });
    if (url.endsWith("/getUpdates")) return hang(init?.signal);
    if (mood === "hang") return hang(init?.signal);
    if (mood === "echo") throw new TypeError(`fetch failed for ${url}`);
    if (mood === "garbled") return new Response("<html>bad gateway</html>", { status: 200 });
    return json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 42 } } });
  }) as unknown as typeof fetch;
}

describeChannelConformance("Telegram", {
  descriptor: TELEGRAM_CHANNEL_DESCRIPTOR,
  provider: fakeTelegram,
  create: (fetch) => createTelegramConnectorDefinition({ fetch, requestTimeoutMs: 30, pollTimeoutSeconds: 3600 }),
  connection: {
    connectionId: "telegram-conformance",
    providerId: "telegram",
    accountIdentity: "bot",
    workspaceId: "w",
    configRevision: 1,
    credentialRef: "token",
    enabled: true,
  },
  config: {},
  secret: "s3cret-bot-token",
  target: "42",
});
