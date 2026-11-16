import type { ChannelDescriptor, MessagingCapabilities } from "@tavi/contracts";

/**
 * Telegram's documented Bot API ceiling for an uploaded document, read as
 * decimal "50 MB".
 *
 * Exported because a caller that must materialize the bytes (the composition
 * root's artifact reader) has to apply the same ceiling *before* reading — a
 * second hard-coded number there would be free to drift from this one.
 */
export const TELEGRAM_MAX_ATTACHMENT_BYTES = 50_000_000;

export const TELEGRAM_CAPABILITIES: MessagingCapabilities = {
  receiveMode: "poll",
  send: true,
  // `editMessageText`: a decided round's message loses its buttons.
  editOrProgress: true,
  // Telegram's Bot API hard limit for `sendMessage` text.
  formats: ["plain"],
  // Documents go out through `sendDocument` as multipart/form-data.
  attachments: true,
  // See `TELEGRAM_MAX_ATTACHMENT_BYTES`: decimal "50 MB", the conservative
  // reading (if the enforced ceiling is binary, 52,428,800, this rejects up to
  // ~2.3 MB of genuinely sendable documents, and the failure is a visible
  // per-part `rejected`). A larger artifact is never uploaded — the check runs
  // before the request, so an oversized file cannot become a half-sent upload.
  maxAttachmentBytes: TELEGRAM_MAX_ATTACHMENT_BYTES,
  // Each `OutboundMessagePart` maps to one Bot API call — no batching.
  maxPartsPerMessage: 1,
  // A forum topic is carried as `destination.threadId` (`message_thread_id`).
  threads: true,
  // Inline keyboards out, `callback_query` in.
  interactions: true,
  // The Bot API has no delivery-receipt mechanism.
  deliveryReceipts: false,
  // The Bot API's limit on one message's text.
  maxTextLength: 4096,
  approvals: "buttons",
  // Group chats on the seam:
  // a mention of the bot and a reply to one of its messages are reported; a
  // private chat with a sender is its own id; `my_chat_member` reports the bot
  // added or removed, and `leaveChat` leaves. Telegram lists no rooms.
  groups: { addressing: ["mention", "reply", "command"], directToSender: true, listRooms: false, membershipEvents: true, leaveRoom: true },
};

/**
 * What Telegram is to core: a chat
 * channel whose senders Telegram itself authenticates, configured with a bot
 * token, reached by chat id.
 */
export const TELEGRAM_CHANNEL_DESCRIPTOR: ChannelDescriptor = {
  app: {
    name: "Telegram",
    summary: "Chat with Tavi from Telegram through a bot you create.",
    category: "chat",
    publisher: "Telegram",
    scopes: [],
  },
  providerId: "telegram",
  label: "Telegram",
  kind: "chat",
  icon: { name: "send" },
  description: "Chat with the agent through a Telegram bot.",
  settings: [],
  auth: {
    kind: "secrets",
    fields: [{ key: "token", label: "Bot token", help: "From @BotFather: /newbot, then copy the token it gives you." }],
  },
  sender: { label: "Telegram user ID", placeholder: "123456789", pattern: "[1-9]\\d{0,19}", normalize: "none", authentication: "provider" },
  // A private chat's id is the user's; a group's is negative.
  target: {
    label: "Chat ID",
    placeholder: "123456789",
    pattern: "-?[1-9]\\d{0,19}",
    normalize: "none",
    help: "To message someone directly, enter their Telegram user ID: a private chat's ID is the user's. A group's chat ID is negative. They must have messaged the bot first.",
  },
  // The Bot API's documented bounds: about 30 messages a second overall, one a second to one chat.
  sendRate: { perMinute: 1800, perTargetPerMinute: 60 },
  // A bot may download files of up to 20 MB (`getFile`).
  media: {
    inboundMaxBytes: 20 * 1024 * 1024,
    mimeTypes: [
      "image/*",
      "application/pdf",
      "text/plain",
      "audio/*",
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "video/3gpp",
      "video/x-matroska",
    ],
  },
  // A chat channel: Ideas may offer what is done by messaging while a connection of it is on.
  proves: ["messaging"],
  // A person links from the bot's chat: its `start` parameter hands the bot the code.
  pairing: { deepLinkTemplate: "https://t.me/{account}?start={code}", openLabel: "Open in Telegram" },
  setupHelp:
    "Create a bot with @BotFather: send it /newbot, pick a name and a username ending in bot, and paste the token it answers with. Then pair yourself with a one-time code.",
  setupLinks: [{ label: "Open @BotFather", url: "https://t.me/BotFather" }],
  // Groups: an unknown sender's group message is held, as before; a group nobody listed is
  // dropped and named to the operator — the groups it was in before are listed as rooms.
  groups: { unboundSenders: "hold", unlistedRooms: "drop", defaultTrigger: ["mention", "reply", "command"] },
  hosts: ["api.telegram.org"],
  // Telegram's Bot terms (s.4.2(c)): what a removed bot brought in goes.
  retention: "purge-on-remove",
};
