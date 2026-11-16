import {
  MESSAGING_DISPLAY_NAME_MAX,
  type AddressKind,
  type InboundEvent,
  type InboundMediaHandle,
  type MessagingConversationKind,
} from "@tavi/contracts";

/**
 * What Telegram's updates say, as an `InboundEvent`: a message (its
 * addressing, forward origin and media), a button press (`callback_query`)
 * and the bot's own membership of a group (`my_chat_member`).
 */

/** A file a message carries, as Telegram names it: downloaded by its id through `getFile`. */
interface TelegramFile {
  readonly file_id: string;
  readonly file_size?: number;
  readonly file_name?: string;
  readonly mime_type?: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly date: number;
  readonly text?: string;
  /** A media message's text. */
  readonly caption?: string;
  /** One photo in several sizes, smallest first. */
  readonly photo?: readonly TelegramFile[];
  readonly document?: TelegramFile;
  readonly voice?: TelegramFile;
  readonly audio?: TelegramFile;
  readonly video?: TelegramFile;
  /** A round video message: an MP4 with no name of its own. */
  readonly video_note?: TelegramFile;
  /** A GIF or silent MP4 animation: the Bot API sets `document` too, for older clients, so that one is skipped. */
  readonly animation?: TelegramFile;
  readonly chat: { readonly id: number; readonly type?: "private" | "group" | "supergroup" | "channel" };
  readonly from?: {
    readonly id: number;
    readonly is_bot?: boolean;
    readonly first_name?: string;
    readonly last_name?: string;
    readonly username?: string;
  };
  readonly reply_to_message?: { readonly message_id: number; readonly from?: { readonly id: number } };
  /** What the text (or a caption) marks up: a mention of the bot is a `mention` (by username) or a `text_mention` (by id). */
  readonly entities?: readonly TelegramEntity[];
  readonly caption_entities?: readonly TelegramEntity[];
  readonly message_thread_id?: number;
  /** The message is in a forum topic (not a reply thread, which also carries `message_thread_id`). */
  readonly is_topic_message?: boolean;
  /** Set on a forwarded message (Bot API 7.0 `MessageOrigin`): who wrote it first. */
  readonly forward_origin?: TelegramMessageOrigin;
}

/** A forward's origin, as much of it as names its author (display only). */
interface TelegramMessageOrigin {
  readonly type: string;
  readonly sender_user?: { readonly first_name?: string; readonly last_name?: string; readonly username?: string };
  readonly sender_user_name?: string;
  readonly sender_chat?: { readonly title?: string; readonly username?: string };
  readonly chat?: { readonly title?: string; readonly username?: string };
}

interface TelegramEntity {
  readonly type: string;
  /** In UTF-16 code units, as JavaScript counts. */
  readonly offset: number;
  readonly length: number;
  readonly user?: { readonly id: number };
}

/** The bot's own membership of a chat changed (`my_chat_member`): added, promoted, removed or kicked. */
interface TelegramChatMemberUpdated {
  readonly chat: { readonly id: number; readonly type?: string; readonly title?: string };
  readonly from: { readonly id: number };
  readonly date: number;
  /** `is_member` says whether a `restricted` member is in the chat. */
  readonly old_chat_member: { readonly status: string; readonly is_member?: boolean };
  readonly new_chat_member: { readonly status: string; readonly is_member?: boolean };
}

interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: { readonly id: number };
  readonly message?: { readonly message_id: number; readonly chat: { readonly id: number }; readonly message_thread_id?: number };
  readonly data?: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
  readonly my_chat_member?: TelegramChatMemberUpdated;
}

/** Who the bot is, from `getMe`: its id, and the username a mention names it by. */
export interface TelegramBot {
  readonly id: number;
  readonly username?: string;
}

/**
 * An inbound event's dedup key, from what identifies the message itself:
 * the bot, the chat and the message id, or a press's own callback id. Not the
 * `update_id`: Telegram may restart that sequence after a week with no
 * updates, and a token changed to another bot under the same connection
 * starts its own — either would drop new messages as duplicates of old ones.
 */
function eventKey(botId: number, event: { readonly chatId: number; readonly messageId: number } | { readonly callbackId: string }): string {
  return "callbackId" in event ? `bot:${botId}:cb:${event.callbackId}` : `bot:${botId}:chat:${event.chatId}:msg:${event.messageId}`;
}

export function toInboundEvent(
  connectionId: string,
  update: TelegramUpdate,
  receivedAt: string,
  bot: TelegramBot,
): InboundEvent | undefined {
  const botId = bot.id;
  const membership = update.my_chat_member;
  if (membership !== undefined) return membershipEvent(connectionId, membership, receivedAt, botId);
  const press = update.callback_query;
  if (press !== undefined) {
    // A press on a message too old for Telegram to include, or with no data,
    // names nothing: its update is skipped (the offset advances past it), and
    // Telegram times the press out on the presser's client.
    if (press.message === undefined || press.data === undefined) return undefined;
    return {
      connectionId,
      providerEventId: eventKey(botId, { callbackId: press.id }),
      kind: "interaction",
      // Telegram's own authenticated account of who pressed: the sender a
      // binding is resolved from. The data says nothing about who.
      externalSenderId: String(press.from.id),
      externalConversationId: String(press.message.chat.id),
      ...(press.message.message_thread_id === undefined ? {} : { externalThreadId: String(press.message.message_thread_id) }),
      externalMessageId: String(press.message.message_id),
      occurredAt: receivedAt,
      receivedAt,
      interaction: { data: press.data, callbackId: press.id, messageId: String(press.message.message_id) },
    };
  }
  const message = update.message;
  // A message with no `from` names no person: in a group, falling back to the
  // chat id would make the whole group the sender.
  if (message === undefined || message.from === undefined) return undefined;
  const media = mediaOf(message);
  const text = message.text ?? message.caption;
  if (text === undefined && media.length === 0) return undefined;
  const { addressed, content } = addressingOf(message, text, bot);
  return {
    connectionId,
    providerEventId: eventKey(botId, { chatId: message.chat.id, messageId: message.message_id }),
    kind: "message",
    externalSenderId: String(message.from.id),
    ...senderNameOf(message.from),
    externalConversationId: String(message.chat.id),
    ...(message.message_thread_id === undefined ? {} : { externalThreadId: String(message.message_thread_id) }),
    // A forum topic is a side chat of its group's Home; a reply thread is not.
    ...(message.message_thread_id !== undefined && message.is_topic_message === true ? { threadIsTopic: true } : {}),
    ...conversationKindOf(message),
    externalMessageId: String(message.message_id),
    ...(message.reply_to_message === undefined ? {} : { externalReplyToId: String(message.reply_to_message.message_id) }),
    ...(addressed.length === 0 ? {} : { addressed }),
    authorKind: message.from.is_bot === true ? "bot" : "person",
    occurredAt: new Date(message.date * 1000).toISOString(),
    receivedAt,
    ...(content === undefined ? {} : { content }),
    // A forward's words are its author's, never the sender's: reported, labelled by core.
    // What the person adds to a forward arrives as a message of its own, and stays theirs.
    ...(message.forward_origin === undefined ? {} : { forwarded: forwardOf(message.forward_origin) }),
    ...(media.length === 0 ? {} : { media }),
  };
}

/**
 * How a message addressed the bot: a `mention` entity naming its
 * username or a `text_mention` naming its id, and a reply to one of its own
 * messages. A leading mention is the address, not the person's words: it is
 * taken off the text (the host never parses platform markup).
 */
function addressingOf(
  message: TelegramMessage,
  text: string | undefined,
  bot: TelegramBot,
): { readonly addressed: readonly AddressKind[]; readonly content?: string } {
  const entities = (message.text !== undefined ? message.entities : message.caption_entities) ?? [];
  const handle = bot.username === undefined ? undefined : `@${bot.username.toLowerCase()}`;
  const ours = entities.filter(
    (entity) =>
      (entity.type === "text_mention" && entity.user?.id === bot.id) ||
      (entity.type === "mention" &&
        handle !== undefined &&
        text?.slice(entity.offset, entity.offset + entity.length).toLowerCase() === handle),
  );
  const addressed: AddressKind[] = [];
  if (ours.length > 0) addressed.push("mention");
  if (message.reply_to_message?.from?.id === bot.id) addressed.push("reply");
  // A leading command addresses this bot when it names it (`/ask@tavi_bot`) or no bot at all.
  const command = entities.find((entity) => entity.type === "bot_command" && entity.offset === 0);
  const named =
    command === undefined || text === undefined ? undefined : /@([A-Za-z0-9_]+)$/.exec(text.slice(0, command.length))?.[1]?.toLowerCase();
  if (command !== undefined && text !== undefined && (named === undefined || `@${named}` === handle)) {
    addressed.push("command");
    // The bot's name is taken off the command, as a leading mention is.
    return {
      addressed,
      content: named === undefined ? text : `${text.slice(0, command.length - named.length - 1)}${text.slice(command.length)}`,
    };
  }
  const leading = ours.find((entity) => entity.offset === 0);
  if (text === undefined || leading === undefined) return { addressed, ...(text === undefined ? {} : { content: text }) };
  const rest = text.slice(leading.length).trimStart();
  return { addressed, ...(rest === "" ? {} : { content: rest }) };
}

/**
 * The bot added to or removed from a group (`my_chat_member`): who did
 * it, and the group's title, display only. A private chat's (a user blocking
 * the bot) and a channel's are not rooms, and say nothing here.
 */
function membershipEvent(
  connectionId: string,
  update: TelegramChatMemberUpdated,
  receivedAt: string,
  botId: number,
): InboundEvent | undefined {
  if (update.chat.type !== "group" && update.chat.type !== "supergroup") return undefined;
  const inside = (member: { readonly status: string; readonly is_member?: boolean }): boolean =>
    member.status === "member" ||
    member.status === "administrator" ||
    member.status === "creator" ||
    (member.status === "restricted" && member.is_member === true);
  const was = inside(update.old_chat_member);
  const is = inside(update.new_chat_member);
  if (was === is) return undefined;
  return {
    connectionId,
    providerEventId: `bot:${botId}:chat:${update.chat.id}:member:${update.date}:${update.new_chat_member.status}`,
    kind: "membership",
    externalSenderId: String(update.from.id),
    externalConversationId: String(update.chat.id),
    conversationKind: "group",
    occurredAt: new Date(update.date * 1000).toISOString(),
    receivedAt,
    membership: {
      change: is ? "added" : "removed",
      ...(update.chat.title === undefined ? {} : { roomName: update.chat.title.slice(0, 120) }),
    },
  };
}

/** What a forward's origin says of its author, display only: a name, a chat's title, or nothing. */
function forwardOf(origin: TelegramMessageOrigin): { readonly origin?: string } {
  const user = origin.sender_user;
  const named = [user?.first_name, user?.last_name].filter((part) => part !== undefined && part !== "").join(" ");
  const name =
    named !== ""
      ? named
      : (user?.username ??
        origin.sender_user_name ??
        origin.sender_chat?.title ??
        origin.chat?.title ??
        origin.sender_chat?.username ??
        origin.chat?.username);
  return name === undefined || name.trim() === "" ? {} : { origin: name.trim().slice(0, 120) };
}

/** The files a message carries, as handles the host takes in : a photo at its largest size. */
function mediaOf(message: TelegramMessage): readonly InboundMediaHandle[] {
  const handle = (file: TelegramFile, fallbackName: string): InboundMediaHandle => ({
    ref: file.file_id,
    filename: file.file_name ?? fallbackName,
    ...(file.mime_type === undefined ? {} : { mimeType: file.mime_type }),
    ...(file.file_size === undefined ? {} : { sizeBytes: file.file_size }),
  });
  const photo = message.photo?.at(-1);
  return [
    ...(photo === undefined ? [] : [handle(photo, "photo.jpg")]),
    // An animation's `document` is the same file again (the Bot API sets both): taken once, as the animation.
    ...(message.document === undefined || message.animation !== undefined ? [] : [handle(message.document, "document")]),
    ...(message.voice === undefined ? [] : [handle(message.voice, "voice.ogg")]),
    ...(message.audio === undefined ? [] : [handle(message.audio, "audio")]),
    ...(message.video === undefined ? [] : [handle(message.video, "video.mp4")]),
    ...(message.video_note === undefined ? [] : [handle(message.video_note, "video_note.mp4")]),
    ...(message.animation === undefined ? [] : [handle(message.animation, "animation.mp4")]),
  ];
}

/** What Telegram calls the sender — their name, `@username`, or both — display only, within the display-name cap. */
function senderNameOf(from: NonNullable<TelegramMessage["from"]>): { readonly senderName?: string } {
  const full = [from.first_name?.trim(), from.last_name?.trim()].filter((part) => part !== undefined && part !== "").join(" ");
  const handle = from.username !== undefined && from.username.trim() !== "" ? `@${from.username.trim().replace(/^@/, "")}` : undefined;
  if (full !== "" && handle !== undefined) {
    const suffix = ` (${handle})`;
    const combined =
      full.length + suffix.length <= MESSAGING_DISPLAY_NAME_MAX
        ? `${full}${suffix}`
        : `${full.slice(0, Math.max(0, MESSAGING_DISPLAY_NAME_MAX - suffix.length)).trimEnd()}${suffix}`;
    return { senderName: combined.slice(0, MESSAGING_DISPLAY_NAME_MAX) };
  }
  const single = full !== "" ? full : handle;
  return single === undefined ? {} : { senderName: single.slice(0, MESSAGING_DISPLAY_NAME_MAX) };
}

/** A private chat is direct, a forum topic a thread, any other group a group; a chat whose type Telegram did not say names none. */
function conversationKindOf(message: TelegramMessage): { readonly conversationKind?: MessagingConversationKind } {
  if (message.message_thread_id !== undefined && message.is_topic_message === true) return { conversationKind: "thread" };
  if (message.chat.type === "private") return { conversationKind: "direct" };
  if (message.chat.type === "group" || message.chat.type === "supergroup") return { conversationKind: "group" };
  return {};
}
