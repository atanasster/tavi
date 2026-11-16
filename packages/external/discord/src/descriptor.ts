import type { ChannelDescriptor, MessagingCapabilities } from "@tavi/contracts";

/**
 * Discord as Tavi sees it:
 * a group channel reached through a bot the operator creates, whose rooms are
 * the server channels the operator lists. The manifest's `channels[0]` is this
 * descriptor, reviewed with the plugin; a test holds the two equal.
 */
export const DISCORD_CHANNEL_DESCRIPTOR: ChannelDescriptor = {
  app: {
    name: "Discord",
    summary: "Chat with Tavi in Discord DMs and the server channels you choose, through a bot you create.",
    category: "chat",
    publisher: "Discord",
    dataClass: "personal",
    scopes: [],
  },
  providerId: "discord",
  // A chat channel: Ideas may offer what is done by messaging while a connection of it is on.
  proves: ["messaging"],
  label: "Discord",
  kind: "chat",
  icon: { name: "message-circle" },
  description: "Chat with the agent through your own Discord bot.",
  // Rooms are host records, not settings.
  settings: [],
  auth: {
    kind: "secrets",
    fields: [
      { key: "token", label: "Bot token", help: "Discord Developer Portal → your application → Bot → Reset Token. Turn Public Bot off." },
    ],
  },
  sender: {
    label: "Discord user ID",
    placeholder: "123456789012345678",
    pattern: "[1-9]\\d{16,19}",
    normalize: "none",
    authentication: "provider",
  },
  target: { label: "Channel ID, or dm:<user ID>", placeholder: "123456789012345678", pattern: "(dm:)?[1-9]\\d{16,19}", normalize: "none" },
  sendRate: { perMinute: 600, perTargetPerMinute: 30 },
  media: {
    inboundMaxBytes: 25 * 1024 * 1024,
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
  groups: { unboundSenders: "drop", unlistedRooms: "drop", defaultTrigger: ["mention", "reply", "thread", "command", "picked"] },
  hosts: ["discord.com", "gateway.discord.gg", "*.discord.gg", "cdn.discordapp.com", "media.discordapp.net"],
  // Discord's Developer Terms s.5(b): what a removed app brought in goes.
  retention: "purge-on-remove",
  setupHelp:
    "Create an application at discord.com/developers, add a bot, turn Public Bot off, paste its token. Open the invite link Tavi shows, DM the bot, allow your user ID in Allowed people, then add rooms.",
  setupLinks: [{ label: "Open the Developer Portal", url: "https://discord.com/developers/applications" }],
};

/** The most of one message's text Discord takes. */
export const DISCORD_MAX_TEXT = 2000;

/** The most of one file the bot sends: within what Discord takes from a bot in any server. */
export const DISCORD_MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * What the connector can do: DMs and guild-channel rooms, addressed
 * by a mention, a reply, a message in a thread the bot opened, `/tavi` or
 * "Ask Tavi about this", with buttons, edits, files of up to 20 MiB and
 * private acknowledgements; a room's polls and events; its recent
 * messages, with the Message Content intent on.
 */
export const DISCORD_CAPABILITIES: MessagingCapabilities = {
  receiveMode: "poll",
  send: true,
  editOrProgress: true,
  formats: ["plain"],
  attachments: true,
  maxAttachmentBytes: DISCORD_MAX_FILE_BYTES,
  maxPartsPerMessage: 1,
  threads: true,
  interactions: true,
  deliveryReceipts: false,
  maxTextLength: DISCORD_MAX_TEXT,
  approvals: "buttons",
  groups: {
    addressing: ["mention", "reply", "thread", "command", "picked"],
    directToSender: true,
    listRooms: true,
    membershipEvents: true,
    leaveRoom: true,
    autoThread: true,
    // Discord's own bounds: a 300-character question, 10 answers of 55, at most 32 days.
    polls: { maxQuestion: 300, maxAnswers: 10, maxAnswerLength: 55, maxHours: 768, multiSelect: true, results: "fetch" },
    events: { kinds: ["external"], maxTitle: 100, maxDescription: 1000 },
    // A room's last 20 messages, with the Message Content intent on.
    recentHistory: { maxMessages: 20 },
  },
};
