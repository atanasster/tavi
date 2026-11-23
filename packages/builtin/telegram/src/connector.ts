import { TaviError } from "@tavi/contracts";
import { z } from "zod";

import type {
  InboundEvent,
  InboundMediaHandle,
  MessagingConnection,
  MessagingConnectionStatus,
  MessagingConnectorDefinition,
  MessagingConnectorInstance,
  MessagingCredentials,
  OutboundMessage,
  SendOutcome,
  SendOutcomePartReceipt,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { aggregateStatus, checkPartCount, notRunning, parseDestination } from "@tavi/channel-kit";

import { createTelegramApi, DEFAULT_API_BASE_URL, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_UPLOAD_TIMEOUT_MS } from "./api.js";
import { TELEGRAM_CAPABILITIES } from "./descriptor.js";
import type { TelegramBot } from "./inbound.js";
import { DEFAULT_POLL_ERROR_BACKOFF_MS, DEFAULT_POLL_TIMEOUT_SECONDS, TelegramPoller } from "./polling.js";
import { inlineKeyboard, sendPart, TELEGRAM_CALLBACK_DATA_MAX_BYTES, TelegramDestinationSchema, type TelegramAttachment } from "./send.js";

export { TELEGRAM_CHANNEL_DESCRIPTOR, TELEGRAM_MAX_ATTACHMENT_BYTES, telegramChannelDescriptor } from "./descriptor.js";
export { TELEGRAM_CALLBACK_DATA_MAX_BYTES, type TelegramAttachment } from "./send.js";

/**
 * Real Telegram `MessagingConnectorPort` adapter — long polling only;
 * webhook mode is not supported. The Bot API client is `api.ts`, receiving
 * `polling.ts`, an update's reading `inbound.ts`, and delivery `send.ts`.
 */

export interface TelegramConnectorOptions {
  /** Injected transport — tests substitute a fake here; production supplies the real `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => string;
  readonly apiBaseUrl?: string;
  readonly pollTimeoutSeconds?: number;
  readonly pollErrorBackoffMs?: number;
  /**
   * How long one Bot API request may take before it is abandoned (default 30 s;
   * a `getUpdates` long poll gets its own poll timeout on top). Without it a
   * hung request would leave a send pending in the outbox for good; an abandoned send is `uncertain`, which is what a
   * request with no answer is.
   */
  readonly requestTimeoutMs?: number;
  /** The same for a file upload (`sendDocument`), default 120 s: up to 50 MB goes out in one request. */
  readonly uploadTimeoutMs?: number;
  /**
   * Resolves an `OutboundFilePart.artifactId` to the bytes a `sendDocument`
   * call uploads. Injected for the same reason `credentials` is: this
   * adapter never touches an `ArtifactRepositoryPort` directly.
   *
   * Receives the sending connection's own `workspaceId` because the artifact
   * id is model-authored: without it the reader could not tell an artifact the
   * calling workspace owns from one it merely knows the name of, and a model
   * could name another workspace's document and have it delivered. The
   * connector itself is workspace-agnostic and does not interpret the value; it
   * only forwards the identity the connection was configured with.
   *
   * Unset means "this deployment wired no artifact store to Telegram", and a
   * file part is then rejected with a visible per-part error rather than
   * being silently dropped or degraded to a text message that says a
   * document exists.
   */
  readonly readArtifact?: (
    artifactId: string,
    workspaceId: string,
  ) => TelegramAttachment | undefined | Promise<TelegramAttachment | undefined>;
}

export function createTelegramConnectorDefinition(options: TelegramConnectorOptions = {}): MessagingConnectorDefinition {
  // Shared across every connection this ONE definition instance creates —
  // `apps/cli/src/runtime/composition.ts` calls this factory once per process, so
  // this set's lifetime matches the configured deployment: one active
  // receiver owns a bot credential across it, and same-bot conflicts are
  // surfaced rather than treated as independent connections. Two `MessagingConnection`s
  // (different `connectionId`s) that resolve to the SAME real Telegram bot
  // (its own numeric bot id from `getMe`, not the configured
  // `connectionId` or credential reference, which could differ while
  // pointing at the same token) refuse to both run at once.
  const activeBotIds = new Set<number>();
  return {
    providerId: "telegram",
    version: "1.0.0",
    // No connector-specific configuration is needed — routing
    // and the bot token both come from `MessagingConnection` itself.
    configSchema: z.object({}).passthrough(),
    capabilities: TELEGRAM_CAPABILITIES,
    createConnection: ({ connection, credentials }) => createTelegramConnectorInstance(connection, credentials, options, activeBotIds),
    // A reply goes back to the same chat the inbound message arrived on —
    // Telegram has no separate "sender address" distinct from the chat
    // the way Mailgun does, so `externalSenderId` is
    // unused here.
    destinationFromInbound: (replyTo) => ({
      chatId: replyTo.externalConversationId,
      // A forum topic's reply stays in that topic (OpenClaw #54505 is what
      // posting to the chat's general topic instead looks like).
      ...(replyTo.externalThreadId === undefined ? {} : { threadId: replyTo.externalThreadId }),
    }),
    // Telegram's pace to one chat counts every send to it, whichever topic or message it is in.
    paceTargetOf: (destination) => {
      const parsed = TelegramDestinationSchema.safeParse(destination);
      return parsed.success ? String(parsed.data.chatId) : undefined;
    },
    // A private chat's id is its user's: a sender is reached one-to-one at their own id.
    directDestinationOf: (externalSenderId) => ({ chatId: externalSenderId }),
    // A send that answers nothing goes to the chat named, in its topic when one is named.
    destinationFor: (target) => ({
      chatId: target.to,
      ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
      ...(target.replyToId === undefined ? {} : { replyToMessageId: target.replyToId }),
    }),
  };
}

function createTelegramConnectorInstance(
  connection: MessagingConnection,
  credentials: MessagingCredentials,
  options: TelegramConnectorOptions,
  activeBotIds: Set<number>,
): MessagingConnectorInstance {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? nowTimestamp;
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
  const pollErrorBackoffMs = options.pollErrorBackoffMs ?? DEFAULT_POLL_ERROR_BACKOFF_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;

  let status: MessagingConnectionStatus = { state: "stopped", since: now() };
  let token: string | undefined;
  /**
   * Whether this instance has been started and not stopped.
   *
   * Kept separate from `status.state` because the two answer different
   * questions. `status` is *receive* health: the poll loop sets it to
   * `"failed"` on a `getUpdates` transport error and back to `"running"` after
   * a 2s backoff. Gating `send()` on it would make a transient polling
   * hiccup fail an unrelated delivery with "connection is not running" — a
   * lost schedule failure alert, say. Sending needs a token, not a healthy poll loop.
   */
  let started = false;
  let abortController: AbortController | undefined;
  let pollLoop: Promise<void> | undefined;
  let handler: ((event: InboundEvent) => Promise<void>) | undefined;
  /** This instance's own claim on `activeBotIds`, so `stop()` releases only what THIS instance actually reserved. */
  let ownedBotId: number | undefined;

  const api = createTelegramApi({
    fetch: fetchImpl,
    token: () => token,
    apiBaseUrl,
    requestTimeoutMs,
    uploadTimeoutMs,
    pollTimeoutSeconds,
  });
  const poller = new TelegramPoller({
    api,
    connectionId: connection.connectionId,
    now,
    pollTimeoutSeconds,
    pollErrorBackoffMs,
    status: {
      get: () => status,
      set: (next) => {
        status = next;
      },
    },
    handler: () => handler,
  });
  const sendContext = { api, readArtifact: options.readArtifact, workspaceId: connection.workspaceId };

  return {
    async start(): Promise<void> {
      status = { state: "starting", since: now() };
      // `credentials` is given by `createConnection`'s caller
      // (ultimately `MessagingServicePort.openConnection`) — this adapter
      // never touches a `SecretStorePort` directly.
      const resolved = await credentials.get("token");
      if (resolved === null) {
        status = { state: "failed", detail: "bot token credential is absent", since: now() };
        throw new TaviError("NOT_CONFIGURED", `Telegram connection ${connection.connectionId}'s bot token credential is absent`, {
          details: { connectionId: connection.connectionId },
        });
      }
      token = resolved;
      const me = await api.call<TelegramBot>("getMe", {});
      if (!me.ok) {
        // A refused token (revoked, or reset in @BotFather) is fixed by pasting a new one.
        const repair = me.error_code === 401 ? { repair: "credentials" as const } : {};
        status = { state: "failed", detail: me.description, since: now(), ...repair };
        throw new TaviError("UNAVAILABLE", `Telegram getMe failed for connection ${connection.connectionId}: ${me.description}`, {
          details: { connectionId: connection.connectionId, ...repair },
        });
      }
      // Same-bot deployment conflicts are surfaced, not treated as
      // independent connections: the bot's own numeric id
      // (not `connectionId`/`credentialRef`, which could legitimately
      // differ while pointing at the same underlying token) is the real
      // identity that would collide — two pollers both calling
      // `getUpdates` for the same bot race each other for updates and
      // each redeliver what the other already claimed.
      if (activeBotIds.has(me.result.id)) {
        status = { state: "failed", detail: `bot ${me.result.id} is already running under another connection`, since: now() };
        throw new TaviError(
          "CONFLICT",
          `Telegram connection ${connection.connectionId} resolves to bot ${me.result.id}, which is already running under a different connection in this deployment`,
          { details: { connectionId: connection.connectionId, botId: me.result.id } },
        );
      }
      activeBotIds.add(me.result.id);
      ownedBotId = me.result.id;
      started = true;
      status = { state: "running", since: now() };
      abortController = new AbortController();
      pollLoop = poller.run(abortController.signal, me.result);
    },

    async stop(): Promise<void> {
      abortController?.abort();
      // Stopping: the poll loop reports its own failures as it runs.
      await pollLoop?.catch(() => {});
      abortController = undefined;
      pollLoop = undefined;
      if (ownedBotId !== undefined) {
        activeBotIds.delete(ownedBotId);
        ownedBotId = undefined;
      }
      started = false;
      status = { state: "stopped", since: now() };
    },

    status(): MessagingConnectionStatus {
      // The bot's own id, once it started: the account a purge is cancelled by.
      return ownedBotId === undefined ? status : { ...status, accountRef: String(ownedBotId) };
    },

    async probe() {
      // `probe` answers "is this connector healthy", and for a polling adapter
      // that includes the poll loop — so unlike `send()` this deliberately still
      // reads `status`: a degraded receive side must be visible to an operator
      // (and to `tavi doctor`), even though it no longer blocks delivery.
      if (!started || token === undefined || status.state !== "running") {
        return { ok: false, detail: `connection is ${status.state}` };
      }
      const me = await api.call<TelegramBot>("getMe", {});
      if (!me.ok) return { ok: false, detail: me.description };
      // The bot's name, and the chat a person opens to message it : where a pairing code goes.
      const username = me.result.username;
      if (username === undefined) return { ok: true };
      const line = `Bot @${username}.`;
      return { ok: true, detail: line, setup: { lines: [line], link: { label: "Open the chat", url: `https://t.me/${username}` } } };
    },

    async send(message: OutboundMessage): Promise<SendOutcome> {
      // `message.threadId` and top-level `message.replyToId` are intentionally
      // ignored — only `destination.replyToMessageId` and `destination.threadId`
      // (this adapter's own addressing shape) are honored. A caller that
      // populates the generic fields for this provider gets no error; they are
      // silently inapplicable, not a bug.
      //
      // `message.artifactIds` is different: the file PART is the
      // way a document ships (so every artifact that goes out was asked for
      // explicitly and has an index a per-part failure can name), which makes
      // the bare list a no-op that a caller could reasonably expect to deliver
      // something. It is refused loudly rather than ignored, so the
      // misleading-but-harmless case cannot be mistaken for a working one.
      if (message.artifactIds !== undefined && message.artifactIds.length > 0) {
        throw new TaviError(
          "INVALID_INPUT",
          `Telegram effect ${message.effectId} sets artifactIds, which this connector does not honor — name each document as a \`{ kind: "file", artifactId }\` part instead`,
          { details: { effectId: message.effectId, artifactIds: message.artifactIds.length } },
        );
      }
      if (!started || token === undefined) throw notRunning("Telegram", connection.connectionId, status.state);
      checkPartCount(message, TELEGRAM_CAPABILITIES.maxPartsPerMessage, "Telegram");
      const destination = parseDestination(TelegramDestinationSchema, message, "Telegram");
      const keyboard = inlineKeyboard(message.buttons);
      if (keyboard === null) {
        throw new TaviError(
          "INVALID_INPUT",
          `Telegram effect ${message.effectId} has a button whose data exceeds ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes`,
          {
            details: { effectId: message.effectId },
          },
        );
      }
      const parts: SendOutcomePartReceipt[] = [];
      let retryAfterMs: number | undefined;
      for (const [index, part] of message.parts.entries()) {
        const { retryAfterMs: partRetryAfterMs, ...receipt } = await sendPart(
          sendContext,
          index,
          part,
          destination,
          message.workspaceId,
          keyboard,
        );
        if (partRetryAfterMs !== undefined) retryAfterMs = partRetryAfterMs;
        parts.push(receipt);
      }
      const status_ = aggregateStatus(parts);
      return {
        status: status_,
        // Only an unconfirmed submission is safe to retry at this layer —
        // a confirmed rejection (429 included) is surfaced for
        // reconciliation, not silently resubmitted (mirrors this
        // contract's own outbox `"pending"`-row discipline, `messaging.ts`'s
        // `MessagingOutboxRepositoryPort` doc comment). `retryAfterMs` is
        // still forwarded as informational metadata for a caller that
        // chooses to retry deliberately.
        retryable: status_ === "uncertain",
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        parts,
      };
    },

    async fetchMedia(
      handle: InboundMediaHandle,
      fetchOptions: { readonly maxBytes: number; readonly signal: AbortSignal },
    ): Promise<Uint8Array> {
      if (token === undefined) throw new TaviError("UNAVAILABLE", `Telegram connection ${connection.connectionId} is not running`);
      // `getFile` names where the file is; the file itself is under `/file/bot<token>/`.
      const located = await api.call<{ readonly file_path?: string }>("getFile", { file_id: handle.ref }, fetchOptions.signal);
      if (!located.ok || located.result?.file_path === undefined)
        throw new TaviError("UNAVAILABLE", "Telegram did not say where the file is");
      return api.downloadFile(located.result.file_path, fetchOptions.maxBytes, fetchOptions.signal);
    },

    async answerInteraction(callbackId: string, text: string): Promise<void> {
      if (token === undefined) return;
      // Answered on every press, or the presser's client shows a spinner until
      // it times out. Best effort: the decision it acknowledges stands either way.
      await api.call("answerCallbackQuery", { callback_query_id: callbackId, text: text.slice(0, 200) });
    },

    async editMessage(input: {
      readonly destination: unknown;
      readonly messageId: string;
      readonly text: string;
      readonly buttons?: OutboundMessage["buttons"];
    }): Promise<void> {
      if (token === undefined) throw new TaviError("UNAVAILABLE", `Telegram connection ${connection.connectionId} is not running`);
      const destination = TelegramDestinationSchema.safeParse(input.destination);
      if (!destination.success) throw new TaviError("INVALID_INPUT", "Telegram edit destination is invalid");
      const keyboard = inlineKeyboard(input.buttons);
      if (keyboard === null) throw new TaviError("INVALID_INPUT", `a button's data exceeds ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes`);
      const result = await api.call("editMessageText", {
        chat_id: destination.data.chatId,
        message_id: Number(input.messageId),
        text: input.text,
        // An empty keyboard removes the buttons: a decided round offers nothing to press.
        reply_markup: keyboard ?? { inline_keyboard: [] },
      });
      if (!result.ok) throw new TaviError("UNAVAILABLE", `Telegram refused the edit: ${result.description}`);
    },

    async typing(destination: unknown): Promise<void> {
      if (token === undefined) return;
      const parsed = TelegramDestinationSchema.safeParse(destination);
      if (!parsed.success) return;
      // Telegram shows "typing…" for 5 s or until the next message; the host asks again within that.
      // Presentation only: a refusal or a failure shows nothing and changes nothing.
      await api
        .call("sendChatAction", {
          chat_id: parsed.data.chatId,
          action: "typing",
          ...(parsed.data.threadId === undefined ? {} : { message_thread_id: Number(parsed.data.threadId) }),
        })
        .catch(() => undefined);
    },

    onInboundEvent(next: (event: InboundEvent) => Promise<void>): void {
      handler = next;
    },

    async leaveRoom(destination: unknown): Promise<void> {
      if (!started || token === undefined) throw notRunning("Telegram", connection.connectionId, status.state);
      const parsed = TelegramDestinationSchema.safeParse(destination);
      if (!parsed.success) throw new TaviError("INVALID_INPUT", "Telegram leave destination is invalid");
      const result = await api.call("leaveChat", { chat_id: parsed.data.chatId });
      if (!result.ok) throw new TaviError("UNAVAILABLE", `Telegram refused to leave the chat: ${result.description}`);
    },
  };
}
