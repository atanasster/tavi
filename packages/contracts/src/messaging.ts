import type { AsyncRepository } from "./persistence-types.js";
import type { z } from "zod";

import type {
  AddressKind,
  AuthorKind,
  RoomDropReason,
  ChannelEventInput,
  ChannelPollInput,
  ChannelPollState,
  ChannelRoomListing,
  GroupCapabilities,
  RecentRoomMessage,
} from "./channel-groups.js";
import { createServiceToken } from "./services.js";

/**
 * Messaging connector contracts.
 *
 * Generic enough for both Telegram and Mailgun without committing to
 * either SDK — this package never imports a provider SDK.
 * `MessagingConnectorDefinition`/`MessagingConnection`/`InboundEvent`/
 * `OutboundMessage`/`SendOutcome`/`DeliveryEvent` are the connector
 * contract's names.
 *
 * Provider-specific behavior (webhook secret validation, Mailgun HMAC
 * signatures, polling offsets, MIME parsing) belongs entirely to the
 * connector packages, not here.
 *
 * **Durable ingestion/outbox**: messaging follows the effect outbox's
 * (`EffectRepositoryPort`) operation-key/receipt *pattern*, but literal
 * reuse of that port does not fit: its
 * `begin`/`resolve` shape is keyed by `taskId`/`admissionId`/`toolId` —
 * an in-flight workflow admission's tool effect — and an inbound messaging
 * event has none of those at ingest time (it arrives before any task
 * exists). `packages/runtime/src/messaging/service.ts` instead builds two
 * new tables (`tavi_messaging_inbox`, `tavi_messaging_outbox`) following
 * the *same* idempotent-operation-key discipline agent delegation/mailbox
 * already uses, rather than forcing an unrelated port's shape onto a state
 * machine it wasn't designed for.
 */

/**
 * `"local"` marks a connector whose inbound events
 * arrive from an authenticated local IPC command rather than a poll loop or an
 * HTTP webhook — the TUI is a messaging channel, and the IPC `reply` command is
 * its inbound transport. The value is descriptive: no runtime code branches on
 * it, because `openConnection` registers `ingest` for any connector that
 * implements `onInboundEvent`.
 */
export const MESSAGING_RECEIVE_MODES = ["poll", "webhook", "local", "none"] as const;
export type MessagingReceiveMode = (typeof MESSAGING_RECEIVE_MODES)[number];

/**
 * "Unknown limits use conservative application caps, not unlimited
 * defaults" — every numeric/boolean field here is required,
 * never optional-meaning-unlimited.
 */
export interface MessagingCapabilities {
  readonly receiveMode: MessagingReceiveMode;
  readonly send: boolean;
  readonly editOrProgress: boolean;
  readonly formats: readonly string[];
  readonly attachments: boolean;
  readonly maxAttachmentBytes: number;
  readonly maxPartsPerMessage: number;
  readonly threads: boolean;
  readonly interactions: boolean;
  readonly deliveryReceipts: boolean;
  /**
   * The longest text one message may carry, in characters. The host splits
   * longer text before it reaches `send`, so no core
   * code carries a provider's limit.
   */
  readonly maxTextLength: number;
  /**
   * How an approval round is decided in this channel:
   * by pressing a button (`interactions` required), by replying with the
   * round's token (email), or not at all.
   */
  readonly approvals: MessagingApprovalMode;
  /**
   * What the channel does for group chats: what it reports of how a message
   * addressed the agent, whether it
   * reaches a sender one-to-one, and the group features its instance
   * implements. Absent: a channel without the group seam (ABI 1).
   */
  readonly groups?: GroupCapabilities;
}

export const MESSAGING_APPROVAL_MODES = ["buttons", "reply-token", "none"] as const;
export type MessagingApprovalMode = (typeof MESSAGING_APPROVAL_MODES)[number];

/**
 * A generic send target: what the agent, a routine or a
 * reminder names, already validated and normalized against the channel's
 * `ChannelDescriptor.target`. The connector turns it into its own
 * destination shape with `destinationFor`.
 */
export interface MessagingTarget {
  readonly to: string;
  readonly threadId?: string;
  readonly subject?: string;
  /** The provider message id this send replies to, where the channel threads by one. */
  readonly replyToId?: string;
}

/**
 * The secrets a connection was configured with, as its connector asks for
 * them. `get` answers a secret field by the key its
 * descriptor declares — `null` when it is not stored; `accessToken` answers a
 * current OAuth access token, refreshed by the host as needed, and throws
 * `NOT_CONFIGURED` for a connection that has none. A connector never sees a
 * refresh token or an OAuth client secret.
 */
export interface MessagingCredentials {
  get(key: string): Promise<string | null>;
  accessToken(): Promise<string>;
}

/**
 * Stable provider ID, version, shared runtime configuration schema, and
 * capability declarations plus a factory.
 * Registration is explicit and duplicate-rejecting — the connector's own
 * plugin registers this through whatever mechanism owns provider setup
 * (out of scope here; see this file's header comment), never at import
 * time.
 */
export interface MessagingConnectorDefinition {
  readonly providerId: string;
  readonly version: string;
  readonly configSchema: z.ZodType;
  readonly capabilities: MessagingCapabilities;
  createConnection(input: {
    readonly connection: MessagingConnection;
    readonly config: unknown;
    readonly credentials: MessagingCredentials;
  }): MessagingConnectorInstance;
  /**
   * The thread a reply opens from this room message, for a room whose
   * operator turned `autoThread` on: its id, which the host gives the
   * message as its `externalThreadId` (a topic of the room) before it is
   * recorded, so the task's chat is that thread from its first message. The
   * connector opens the thread on the first send into it. `undefined`: this
   * message cannot have one. Absent: the channel never opens threads.
   */
  autoThreadOf?(event: InboundEvent): string | undefined;
  /**
   * Builds the provider-specific `OutboundMessage.destination` for a send
   * that starts nothing from an inbound message — `messaging.send_to`, a
   * routine's delivery, a reminder, `ask_user`. `target`
   * is already valid for the channel's descriptor. Optional for now: a
   * connector without it cannot be sent to except as a reply.
   */
  destinationFor?(target: MessagingTarget, connection: MessagingConnection): unknown;
  /**
   * The destination of a one-to-one chat with this sender, on the
   * connection: where a room's approval card goes. `undefined` when the platform
   * cannot open one. Present when `capabilities.groups.directToSender`.
   */
  directDestinationOf?(externalSenderId: string, connection: MessagingConnection): unknown;
  /**
   * How the connector takes webhook requests through the host's ingress,
   * for the routes its descriptor declares. The host
   * owns the listener, the body cap, rate limits and the replay cache; the
   * connector only checks a request is the provider's and turns it into
   * events. Absent for a connector that receives no webhooks.
   */
  ingress?: MessagingIngress;
  /**
   * Who a destination reaches, for the host's per-target send pace: the
   * chat or address, whatever message or topic it replies in.
   * Absent: the whole destination is the target.
   */
  paceTargetOf?(destination: unknown): string | undefined;
  /**
   * Builds the provider-specific `OutboundMessage.destination` for a
   * reply to the conversation named by `externalConversationId`/
   * `externalSenderId` — the `messaging.send`
   * governed tool calls this rather than hardcoding a Telegram `chatId`
   * or Mailgun `to` address shape itself, keeping per-provider
   * destination knowledge with the connector that already owns its own
   * destination schema (`OutboundMessage.destination` is deliberately
   * `unknown`, validated only by each connector's own `send()`). Takes
   * `replyTo` — `externalConversationId`/`externalSenderId` plus the
   * optional `externalMessageId` of the specific inbound message being
   * replied to (present whenever `InvocationContext.messagingReplyTo`
   * carried one — an email connector needs this for
   * `In-Reply-To`/`References` threading headers, without which a reply
   * renders as an unthreaded new conversation in most mail clients; not a
   * full `InboundEvent`, since `messaging.send`'s caller only ever has
   * these three fields to give it) — and the specific open `connection`
   * this reply is going out on, needed because one definition serves
   * every connection for its provider (e.g. Mailgun's own sending
   * address, `connection.accountIdentity`, differs per connection and
   * can't be closed over at definition-registration time). Optional: a
   * connector with no reply concept (or not yet updated) simply can't be
   * replied to via this tool — `messaging.send` fails closed with
   * `NOT_FOUND`/`UNSUPPORTED` rather than guessing a shape.
   */
  destinationFromInbound?(
    replyTo: {
      readonly externalConversationId: string;
      readonly externalSenderId: string;
      readonly externalMessageId?: string;
      readonly externalReferences?: readonly string[];
      /** The forum topic or thread the inbound message arrived in. */
      readonly externalThreadId?: string;
      /** The inbound message's subject, where its channel has one: a reply is `Re:` it. */
      readonly subject?: string;
    },
    connection: MessagingConnection,
  ): unknown;
}

/** A webhook request as the host's ingress hands it to a connector: already within its route's body cap. */
export interface IngressRequest {
  readonly method: "GET" | "POST";
  /** The route's name, as the descriptor declares it. */
  readonly route: string;
  /** Header names lower-cased. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly rawBody: Uint8Array;
}

/** What a connector's ingress answers the provider with, when not a plain `200 ok`. */
export interface IngressResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string;
}

/** The connection a request is for, with its secrets as the connector reads them. */
export interface IngressContext {
  readonly connection: MessagingConnection;
  readonly credentials: MessagingCredentials;
  readonly now: () => string;
}

export interface MessagingIngress {
  /**
   * Whether the request is the provider's own (its signature checks against
   * the connection's secret). `replayKey` names what makes it unique — a
   * signature token, a body digest — which the host refuses to accept twice
   * within `replayTtlMs`.
   */
  verify(
    request: IngressRequest,
    context: IngressContext,
  ): Promise<{ readonly ok: true; readonly replayKey?: string; readonly replayTtlMs?: number } | { readonly ok: false }>;
  /**
   * The events a verified request carries, and what to answer (a
   * verification challenge's echo); a malformed request throws
   * `INVALID_INPUT`. The host records the events, then answers.
   */
  handle(
    request: IngressRequest,
    context: IngressContext,
  ): Promise<{ readonly events: readonly InboundEvent[]; readonly response?: IngressResponse }>;
  /**
   * For a route the descriptor declares at provider scope (one URL for every
   * account): which of these open connections the request is for, by what
   * the request itself names (a phone-number id). `undefined` when none: the
   * request is acknowledged and dropped.
   */
  connectionFor?(request: IngressRequest, connections: readonly MessagingConnection[]): string | undefined;
}

/**
 * Stable instance ID, provider/account identity, workspace routing grant,
 * config revision, credential reference, enabled state. Several
 * Telegram bots or Mailgun domains may coexist as distinct connections
 * under the same connector definition.
 */
export interface MessagingConnection {
  readonly connectionId: string;
  readonly providerId: string;
  /** e.g. a Telegram bot username or a Mailgun sending domain — opaque to this contract. */
  readonly accountIdentity: string;
  readonly workspaceId: string;
  readonly configRevision: number;
  readonly credentialRef?: string;
  /**
   * The credential reference behind each secret field the channel's
   * descriptor declares, by field key — what `MessagingCredentials.get`
   * resolves. A connection configured before these existed has only
   * `credentialRef`.
   */
  readonly credentialRefs?: Readonly<Record<string, string>>;
  readonly enabled: boolean;
}

export const MESSAGING_CONNECTION_STATES = ["starting", "running", "stopped", "failed"] as const;
export type MessagingConnectionState = (typeof MESSAGING_CONNECTION_STATES)[number];

export interface MessagingConnectionStatus {
  readonly state: MessagingConnectionState;
  readonly detail?: string;
  readonly since: string;
  /** When this run of the owner last took a message in on it. */
  readonly lastInboundAt?: string;
  /** When a send through it was last accepted. */
  readonly lastSendAt?: string;
  /** Why the last send through it was not accepted, as its connector said it (secrets redacted there). */
  readonly lastError?: string;
  /**
   * What would fix a `failed` connection, when the connector knows:
   * its credentials (a revoked or reset token), or a setting at the provider
   * (an intent turned off). Connected apps and the heartbeat raise it. A
   * connector whose `start()` fails for one of these says so as the thrown
   * `TaviError`'s `details.repair`.
   */
  readonly repair?: "credentials" | "provider-settings";
  /**
   * The platform's own id for the account this connection is (a bot's or an
   * application's id), once it started: adding the same account
   * again within a removed connection's grace cancels its purge.
   */
  readonly accountRef?: string;
}

export interface MessagingProbeResult {
  readonly ok: boolean;
  readonly detail?: string;
  /**
   * What setting the connection up still asks of its operator: a few
   * short lines, and a link (an invite, a settings page). The host shows the
   * link only when its host is one of the channel's declared `hosts`.
   */
  readonly setup?: MessagingSetup;
}

/** A connection's setup notes (`MessagingProbeResult.setup`): at most 6 lines of 200 characters, and a link. */
export interface MessagingSetup {
  readonly lines: readonly string[];
  readonly link?: { readonly label: string; readonly url: string };
}

/**
 * A download as `fetchMedia` may answer it: the shape of a fetch `Response`
 * the host reads (contracts carry no DOM types), stopping at the cap.
 */
export interface MediaResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: {
    getReader(): { read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> };
    cancel(reason?: unknown): Promise<void>;
  } | null;
}

/**
 * An attachment as a connector names it: a provider media id or URL its
 * connection's `fetchMedia` can download, or the bytes the request itself
 * carried. Its type and size are the provider's word, which the host checks.
 */
export interface InboundMediaHandle {
  /** What `fetchMedia` is given to download it (a provider file id); unused for an inline one. */
  readonly ref: string;
  readonly filename?: string;
  /** The provider's word; the host decides the type from the content itself. */
  readonly mimeType?: string;
  /** The provider's word: one over the channel's cap is skipped without a download. */
  readonly sizeBytes?: number;
  /** The bytes, when the request carried them (an email's attached file). */
  readonly inline?: Uint8Array;
}

/**
 * A connector instance: async start/stop with owned cleanup, structured
 * status, an explicit bounded probe, and send — receive/webhook/edit/
 * interaction methods are optional capability-specific ports, modeled here
 * as `onInboundEvent` rather than
 * a concrete polling/webhook mechanism, which is provider-specific and out
 * of this contract's scope.
 */
export interface MessagingConnectorInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): MessagingConnectionStatus;
  probe(): Promise<MessagingProbeResult>;
  send(message: OutboundMessage): Promise<SendOutcome>;
  /**
   * Shows the agent as typing where a reply to a message goes, while the turn
   * that message admitted runs: the host calls it as the turn starts and every
   * 8 s until it ends. Presentation only: it never throws for the platform's
   * refusal, and a connector paces it itself.
   */
  typing?(destination: unknown): Promise<void>;
  /** Acknowledge a button press, with a short notice to the presser. Present when `capabilities.interactions`. */
  answerInteraction?(callbackId: string, text: string): Promise<void>;
  /**
   * Downloads one attachment handle within `maxBytes` using this connection's
   * credentials. Answer the provider's `Response` and the host reads it,
   * stopping at the cap as the bytes arrive; answer bytes only when they are
   * already bounded.
   */
  fetchMedia?(
    handle: InboundMediaHandle,
    options: { readonly maxBytes: number; readonly signal: AbortSignal },
  ): Promise<Uint8Array | MediaResponse>;
  /**
   * Replace a sent message's text and its buttons — none unless `buttons` is
   * given. Present when `capabilities.editOrProgress`. `destination` is
   * the one the message was sent to.
   */
  editMessage?(input: {
    readonly destination: unknown;
    readonly messageId: string;
    readonly text: string;
    readonly buttons?: readonly (readonly OutboundButton[])[];
  }): Promise<void>;
  /**
   * Registers the callback the owning `MessagingServicePort` uses to learn
   * about inbound events (a real connector calls this from its own
   * poll/webhook loop; the fixture connector calls it directly from a test
   * driving an injected event queue). Absent when `capabilities.receiveMode
   * === "none"`.
   */
  onInboundEvent?(handler: MessagingInboundHandler): void;
  /**
   * The group seam, each present only with its capability in
   * `capabilities.groups`. Rooms the agent can see, for the operator's picker:
   * names are display only.
   */
  listRooms?(): Promise<readonly ChannelRoomListing[]>;
  /** A room's recent messages, newest last, at most `limit` (`groups.recentHistory`). */
  fetchRecent?(
    destination: unknown,
    options: { readonly limit: number; readonly before?: string; readonly signal: AbortSignal },
  ): Promise<readonly RecentRoomMessage[]>;
  /** Posts a poll (`groups.polls`); `effectId` is the idempotency key. */
  createPoll?(input: ChannelPollInput): Promise<SendOutcome>;
  readPoll?(destination: unknown, messageId: string): Promise<ChannelPollState>;
  endPoll?(input: { readonly effectId: string; readonly destination: unknown; readonly messageId: string }): Promise<SendOutcome>;
  /** Creates an event in the room's place (`groups.events`). */
  createEvent?(input: ChannelEventInput): Promise<SendOutcome & { readonly url?: string }>;
  /** Leaves a room the agent was added to (`groups.leaveRoom`). */
  leaveRoom?(destination: unknown): Promise<void>;
}

/**
 * What a connector hands an inbound event to: the owning service's `ingest`.
 * `hooks` reach it unchanged, so a connector whose caller must be answered
 * once the event is durably recorded — the local connection's IPC `reply`
 * — can be, while the turn it admits goes on.
 */
export type MessagingInboundHandler = (event: InboundEvent, hooks?: MessagingIngestHooks) => Promise<MessagingIngestReceipt | void>;

/** Callbacks `ingest` calls as it goes; see `MessagingServicePort.ingest`. */
export interface MessagingIngestHooks {
  /**
   * The event is durably recorded (or found recorded: `duplicate`) and its
   * sender resolved — called before any turn it admits runs, which `ingest`
   * then awaits. A throw, or a promise it returns that rejects, is contained:
   * the recording stands. The turn admitted after it may still fail, and
   * `ingest` then rejects, leaving the inbox row `received` for an operator
   * to replay: an answer given here says the message was recorded, not that
   * its turn ran.
   */
  readonly onRecorded?: (receipt: MessagingIngestReceipt) => void | Promise<void>;
}

/**
 * Connection ID, provider delivery/event ID and event kind, external
 * sender/conversation/thread/message/reply IDs, occurred/received times,
 * normalized content and attachment references. `providerEventId` is the
 * stable, provider-specific dedup key
 * this event's own connection/event-kind scope it against — never a
 * freshly generated UUID per retry.
 */
export interface InboundEvent {
  readonly connectionId: string;
  readonly providerEventId: string;
  readonly kind: string;
  readonly externalSenderId: string;
  /** What the platform calls the sender (a display name and handle), display only and untrusted. */
  readonly senderName?: string;
  readonly externalConversationId: string;
  readonly externalThreadId?: string;
  /**
   * The thread is a forum topic (Telegram `is_topic_message`), not a reply
   * thread: a topic of a group whose conversation has a Home is a side chat of
   * that Home. Absent: not a topic, or a channel without topics.
   */
  readonly threadIsTopic?: boolean;
  /**
   * The host put this room message in the thread a reply to it opens (a
   * room's `autoThread`): `externalThreadId` is that thread, and the chat
   * it starts is the thread's. Set by the host, never by a connector.
   */
  readonly threadOpened?: boolean;
  /**
   * What the conversation is: a one-to-one chat with
   * the sender, a group, or a thread of messages (an email thread, a forum
   * topic). Core decides what a direct message may link to from this, never
   * from a connection id. Absent from a connector that does not say.
   */
  readonly conversationKind?: MessagingConversationKind;
  readonly externalMessageId?: string;
  readonly externalReplyToId?: string;
  /**
   * The full ancestor chain (RFC 5322 `References` header), oldest first,
   * when the provider's inbound event carries one — email threads deeper
   * than one level need this; `externalReplyToId` alone only names the
   * immediate parent.
   */
  readonly externalReferences?: readonly string[];
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly content?: string;
  /**
   * The message is a forward (Telegram `forward_origin`): its words are its
   * original author's, never the sender's. The whole
   * `content` is the forward; text the person adds to one arrives as a message
   * of its own. `origin` is what the provider says of the author, display only.
   * A connector reports this structure; core labels it.
   */
  readonly forwarded?: { readonly origin?: string };
  /**
   * The parts of `content` that are someone else's words: an email's quoted
   * reply (`>` lines, `On … wrote:`) or forwarded message, as half-open UTF-16
   * ranges `[start, end)`, in order and apart. Found by
   * channel-kit's `splitEmailText`, which a connector calls; `unparsed` covers
   * the whole of a message it could not split. Absent: the sender
   * wrote all of it. A range core cannot read makes the whole message quoted.
   */
  readonly quotedRanges?: readonly InboundQuotedRange[];
  /**
   * The message's attachments, stored as untrusted artifacts by the host's
   * media intake. Set by the host, never by a
   * connector: a connector names what it received in `media`.
   */
  readonly attachments?: readonly { readonly artifactId: string; readonly filename?: string }[];
  /**
   * The attachments a connector received, as handles the host takes in: it
   * downloads them, checks their size and type, and
   * stores what passes as untrusted artifacts — only for a sender who is
   * allowed. Never recorded: the inbox keeps `attachments` and a note instead.
   */
  readonly media?: readonly InboundMediaHandle[];
  /**
   * For `kind: "delivery"`: what the provider says of a
   * message this owner sent — recorded on its send, never admitted as a
   * message.
   */
  readonly delivery?: { readonly providerMessageId: string; readonly status: DeliveryEventStatus; readonly detail?: string };
  /** The message's subject line, where the channel has one (email): a reply's round token travels in it. */
  readonly subject?: string;
  /**
   * Whether the provider authenticated the sender (email: SPF and DKIM both
   * pass, and the From header's domain aligned with the envelope sender's).
   * Absent for a channel whose sender is authenticated by the provider's own
   * account model (Telegram). A bound sender's message starts a turn only
   * when this is absent or `"pass"`, or the binding carries the operator's
   * `trustUnverified` override (`senderAuthenticationAdmits`); a reply that
   * decides a round needs absent or `"pass"` regardless.
   */
  readonly senderAuthentication?: "pass" | "fail" | "unknown";
  /**
   * The owner's local connection only: the front end the
   * message was typed in — `web` through `tavi ui`'s bridge, `ipc` from another
   * attached client — set by the owner from the IPC connection, never from a
   * payload. Carried onto the turn's context (`InvocationContext.frontEnd`),
   * where it only narrows the rules; ignored on any other connection.
   */
  readonly frontEnd?: "web" | "ipc";
  /**
   * How the message addressed the agent, as the platform says: the
   * host's room policy matches a room's trigger against it. Absent: the
   * connector does not say (ABI 1), or it did not address the agent.
   */
  readonly addressed?: readonly AddressKind[];
  /** Who wrote it, as the platform says; the host drops `bot` and `system` before anything is recorded. */
  readonly authorKind?: AuthorKind;
  /**
   * A message this one quotes or points at (a reply's parent, a message the
   * person picked): its author's words, never the sender's. `content` is
   * absent when the platform withholds it. Core labels it as that author's.
   */
  readonly referenced?: {
    readonly externalSenderId: string;
    readonly externalMessageId: string;
    readonly content?: string;
    readonly via: "reply" | "picked";
  };
  /**
   * Set on `kind: "membership"`: the agent was added to or removed from the
   * room `externalConversationId`, by `externalSenderId`. `roomName`
   * is the platform's, display only.
   */
  readonly membership?: { readonly change: "added" | "removed"; readonly roomName?: string };
  /**
   * Set on `kind: "interaction"`: a person pressed a button a message
   * carried. `data` is the button's own opaque value, and it is the only thing
   * a button press says: any meaning is looked up server-side, never trusted
   * from the value, since a modified client can send any value it likes.
   */
  readonly interaction?: {
    readonly data: string;
    /** The provider's handle for acknowledging the press (Telegram `callback_query.id`). */
    readonly callbackId?: string;
    /** The message the button was on. */
    readonly messageId?: string;
  };
}

/** One part of an inbound message's `content` that is not the sender's own words (`InboundEvent.quotedRanges`). */
export interface InboundQuotedRange {
  readonly start: number;
  readonly end: number;
  /**
   * A quoted reply, a forwarded message, the whole of a message the splitter
   * could not read (fail safe), or the host's lines naming the message's
   * attachments (`attachment`, set by media intake: their file names are the
   * sender's to choose).
   */
  readonly kind: "quoted" | "forwarded" | "unparsed" | "attachment";
}

export const MESSAGING_CONVERSATION_KINDS = ["direct", "group", "thread"] as const;
export type MessagingConversationKind = (typeof MESSAGING_CONVERSATION_KINDS)[number];

/** One button a message can carry, where the connector has `capabilities.interactions`. */
export interface OutboundButton {
  readonly label: string;
  /** Opaque, at most 64 bytes (Telegram's `callback_data` bound); returned as `InboundEvent.interaction.data`. */
  readonly data: string;
}

/**
 * A text part. `kind` is optional and defaults to `"text"`, so every
 * plain `{ content }` part keeps working unchanged.
 */
export interface OutboundTextPart {
  readonly kind?: "text";
  readonly content: string;
}

/**
 * A file part.
 *
 * It names an **authorized artifact reference**, never a path and never a
 * byte array: the connector resolves bytes through the artifact repository,
 * the same "bounded reference, never raw content" discipline the browser
 * upload intake already uses. Passing bytes through this generic contract
 * would put a whole document into every outbound payload, into the effect
 * ledger's recorded input, and into whatever persists either.
 *
 * `filename`/`mimeType` are metadata the caller may override; the artifact's
 * own recorded values are the fallback and are authoritative for bytes.
 */
export interface OutboundFilePart {
  readonly kind: "file";
  readonly artifactId: string;
  readonly filename?: string;
  readonly mimeType?: string;
  /** Optional accompanying text, for providers that support a caption. */
  readonly caption?: string;
}

export type OutboundMessagePart = OutboundTextPart | OutboundFilePart;

/**
 * Narrows a part to its file variant. Exported because every connector that
 * supports `attachments` needs this exact check, and a hand-written
 * `"kind" in part` test silently answers `true` for text parts that set
 * `kind: "text"` explicitly.
 */
export function isFilePart(part: OutboundMessagePart): part is OutboundFilePart {
  return part.kind === "file";
}

/**
 * The receipt a connector returns for a file part when it has no attachment
 * path (`capabilities.attachments === false`).
 *
 * A receipt rather than a thrown error, deliberately: `dispatchTool` resolves
 * any thrown handler error as an `uncertain` external effect
 * (`packages/agent-host/src/workflow/`), so throwing would durably ledger a
 * knowably impossible delivery as one an operator must reconcile — and the
 * model would see a generic failure instead of the specific reason. Shared so
 * every connector answers a file part identically and `capabilities.attachments`
 * stays the single source of truth rather than a comment that can drift.
 */
export function unsupportedFilePartReceipt(providerId: string, index: number): SendOutcomePartReceipt {
  return { index, status: "rejected", error: `${providerId} does not support file attachments` };
}

/**
 * Logical effect ID, scoped connection/destination, reply/thread
 * reference, content blocks and authorized artifact references.
 * `destination` is deliberately `unknown` here —
 * the concrete addressing shape (Telegram chat/topic/reply IDs, or email
 * recipients/subject/threading headers) is provider-specific and
 * validated by the connector's own `configSchema`-adjacent addressing
 * rules, not this generic contract: a destination carries the selected
 * connection and validated addressing.
 */
export interface OutboundMessage {
  readonly effectId: string;
  readonly connectionId: string;
  readonly destination: unknown;
  /** A subject line for a channel that has one (email), replacing the destination's. */
  readonly subject?: string;
  /**
   * Rows of buttons to show under the message. Honoured only by a connector
   * with `capabilities.interactions`; any other ignores them, so the text must
   * say how to answer without them.
   */
  readonly buttons?: readonly (readonly OutboundButton[])[];
  readonly replyToId?: string;
  readonly threadId?: string;
  readonly parts: readonly OutboundMessagePart[];
  readonly artifactIds?: readonly string[];
  /**
   * The *requesting* task's workspace, when the caller knows it.
   *
   * Distinct from the connection's own `workspaceId`, which is the identity
   * the connection was configured with: `MessagingService.send` refuses a
   * message whose `workspaceId` differs from its connection's, which is how a
   * task in one workspace is stopped from using another workspace's
   * connection. Without this, the connection's workspace
   * is the only identity in play, and a caller sending *through* a foreign
   * connection is indistinguishable from a legitimate one.
   *
   * Optional because a caller that has no workspace notion (a fixture, a
   * future non-workspace caller) must keep working: absent means "no claim",
   * not "any workspace".
   */
  readonly workspaceId?: string;
}

export const SEND_OUTCOME_STATUSES = ["accepted", "rejected", "uncertain"] as const;
export type SendOutcomeStatus = (typeof SEND_OUTCOME_STATUSES)[number];

export interface SendOutcomePartReceipt {
  readonly index: number;
  readonly status: SendOutcomeStatus;
  readonly providerMessageId?: string;
  readonly error?: string;
  /** The platform refused because the recipient cannot be reached one-to-one (DMs closed, never started the bot). */
  readonly unreachable?: true;
}

/**
 * Accepted/rejected/uncertain plus provider message IDs, retryability and
 * per-part receipts. `"uncertain"` — not
 * `"rejected"` — is the outcome for a submission whose result the
 * connector could not confirm (a timeout after submission is uncertain
 * unless provider evidence proves rejection). A multi-part send
 * where only some parts succeeded is `status: "uncertain"` at the
 * top level even though individual `parts` entries are `"accepted"`.
 */
export interface SendOutcome {
  readonly status: SendOutcomeStatus;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly parts: readonly SendOutcomePartReceipt[];
}

export const DELIVERY_EVENT_STATUSES = ["delivered", "read", "bounced", "failed"] as const;
export type DeliveryEventStatus = (typeof DELIVERY_EVENT_STATUSES)[number];

/** The newest status a sent message's channel reported for it; for a message sent in parts, its latest part's. */
export interface MessagingDelivery {
  readonly status: DeliveryEventStatus;
  readonly at: string;
  readonly detail?: string;
}

/** Delivery/bounce/failure updates, kept separate from initial send acceptance. */
export interface DeliveryEvent {
  readonly connectionId: string;
  readonly providerMessageId: string;
  readonly status: DeliveryEventStatus;
  readonly occurredAt: string;
  readonly detail?: string;
}

/** What a replayed inbound event did, one variant per reason an operator runs it. */
export type MessagingReplayOutcome =
  | { readonly outcome: "admitted"; readonly principalId: string; readonly taskId?: string }
  | { readonly outcome: "unbound"; readonly externalSenderId: string }
  /** The sender is bound, but the message was not verified as theirs and the binding has no `trustUnverified` override. */
  | { readonly outcome: "unverified"; readonly externalSenderId: string }
  | { readonly outcome: "already-processed" }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "admission-closed" }
  | { readonly outcome: "in-flight" };

export interface MessagingIngestReceipt {
  readonly accepted: boolean;
  /** True when this exact `(connectionId, providerEventId)` was already durably recorded — a safe no-op, not an error. */
  readonly duplicate: boolean;
  /**
   * The principal `InboundEvent.externalSenderId` resolved to via an
   * explicit, operator-approved `MessagingIdentityBinding`,
   * or absent for an unbound/unknown sender —
   * never a guess. `ingest` still accepts and dedups the event either way:
   * identity resolution gates what a future consumer may DO with the
   * event, not whether the event itself is durably recorded (an unbound
   * sender's messages are held for an operator to inspect and bind, not
   * silently dropped).
   */
  readonly resolvedPrincipalId?: string;
  /**
   * The sender is bound, but the provider could not verify the message came
   * from them (`senderAuthenticationAdmits` is false): recorded, never
   * admitted. Absent otherwise.
   */
  readonly unverified?: true;
  /**
   * The host's room policy dropped the event before recording it: nothing of it is
   * stored, and the connector acknowledges it as handled.
   */
  readonly dropped?: RoomDropReason;
}

/**
 * An explicit, operator-approved link from one external channel identity
 * (a Telegram user id, a Mailgun sender address) to an application
 * principal: the same principal across authorized CLI/Telegram bindings,
 * and a forged/unknown sender denied private memory. Two bindings on two
 * *different* connections
 * (one Telegram, one Mailgun) pointing at the same `principalId` is how
 * "same principal across bindings" is satisfied — there is no separate
 * cross-connection concept, just two rows sharing a `principalId`. Never
 * created automatically from a received message — `MemoryActor`'s own
 * header comment states the rule this type exists to enforce: "a Telegram
 * id or an email address is never an application principal."
 *
 * A plain interface rather than a Zod schema, deliberately — this file defines no
 * Zod object schemas anywhere (`InboundEvent`, `OutboundMessage`,
 * `MessagingConnection` are all plain interfaces too), so matching that
 * existing convention beat introducing this file's first Zod schema for
 * one new type.
 */
export interface MessagingIdentityBinding {
  readonly connectionId: string;
  readonly externalSenderId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  /** Who approved this binding — an operator action, always attributable, never inferred from a message. */
  readonly approvedBy: string;
  readonly createdAt: string;
  /**
   * What the operator calls this person, when they gave a name
   * (`channels allow`'s `name`, `tavi bindings bind --name`), or the
   * platform sender name confirmed during `confirm-pair`: the
   * Command Center shows it in place of the principal id.
   */
  readonly displayName?: string;
  /**
   * The operator's per-person override for a channel whose senders are
   * authenticated per message (email): this person's messages start
   * conversations even when the provider could not verify them — for a
   * sender whose own domain's SPF/DKIM is broken. Who set it and when, never
   * taken from a message. It admits conversation only: an approval is never
   * decided by an unverified message, override or not.
   */
  readonly trustUnverified?: MessagingTrustUnverified;
}

/** Who turned a binding's `trustUnverified` override on, and when. */
export interface MessagingTrustUnverified {
  readonly setBy: string;
  readonly setAt: string;
}

/**
 * Whether an event's sender authentication lets a bound sender's message be
 * admitted. A channel whose provider authenticates every sender through its
 * own account model (Telegram) leaves `senderAuthentication` absent and is
 * always admitted; a channel that authenticates per message (email) needs a
 * `"pass"`, or the binding's `trustUnverified` override. A forged email From
 * of a bound address would otherwise start a turn as that person.
 */
export function senderAuthenticationAdmits(
  event: Pick<InboundEvent, "senderAuthentication">,
  binding: Pick<MessagingIdentityBinding, "trustUnverified"> | undefined,
): boolean {
  return event.senderAuthentication === undefined || event.senderAuthentication === "pass" || binding?.trustUnverified !== undefined;
}

/** The longest display name a binding keeps. */
export const MESSAGING_DISPLAY_NAME_MAX = 80;

/**
 * Conversation Homes. A DM's or group's current-epoch task is that
 * conversation's Home; a forum topic of a group is a side chat of the group's
 * Home, mapped under a key of its own — the group's id and the topic's — so
 * every epoch and `/new` rule of a conversation holds for a topic too.
 */
export const TOPIC_CONVERSATION_SEPARATOR = "#topic:";

/** The mapping key of forum topic `threadId` in group `conversationId`. */
export function topicConversationKey(conversationId: string, threadId: string): string {
  return `${conversationId}${TOPIC_CONVERSATION_SEPARATOR}${threadId}`;
}

/** Whether a mapping key names a forum topic (a side chat), not a conversation. */
export function isTopicConversationKey(key: string): boolean {
  return key.includes(TOPIC_CONVERSATION_SEPARATOR);
}

/** The external conversation a mapping key belongs to: a topic's group, else the key itself. */
export function conversationOfKey(key: string): string {
  const at = key.indexOf(TOPIC_CONVERSATION_SEPARATOR);
  return at < 0 ? key : key.slice(0, at);
}

export const CONVERSATION_HOME_KINDS = ["direct", "group"] as const;
export type ConversationHomeKind = (typeof CONVERSATION_HOME_KINDS)[number];

/**
 * Maps one external conversation (a Telegram chat, a Mailgun thread) to
 * the task admitted for it — one task per
 * `(connectionId, externalConversationId)` and epoch: `/new` ends an epoch and
 * the next message starts another task. Recorded after
 * the first message's `kind: "start"` admission resolves, the same
 * "write the durable mapping after `admit` resolves" ordering `spawn()`
 * (`packages/agent-host/src/agents/agent-communication.ts`) already establishes for
 * delegation, so a crash between the two can never duplicate a
 * conversation's task.
 */
export interface MessagingConversationTask {
  readonly connectionId: string;
  readonly externalConversationId: string;
  readonly taskId: string;
  readonly createdAt: string;
  /**
   * The provider of the connection the conversation is on: what a reader
   * names its channel by, kept with the conversation so
   * it is known whether or not the connection is still open. Absent on a
   * mapping from a connection whose provider was never known.
   */
  readonly providerId?: string;
  /** What the conversation is, as its first message said (`InboundEvent.conversationKind`). */
  readonly conversationKind?: MessagingConversationKind;
  /**
   * Which of the conversation's tasks this is: 0 for the first, one more after
   * each `/new`. Absent on a record written before epochs, read as 0.
   */
  readonly epoch?: number;
  /**
   * The admission's reply target (`InvocationContext.messagingReplyTo`), kept so
   * an approval raised by a task delegated from this conversation can be
   * announced here. Absent on a mapping recorded before it was kept.
   */
  readonly replyTo?: {
    readonly connectionId: string;
    readonly externalConversationId: string;
    readonly externalSenderId: string;
    readonly externalMessageId?: string;
    readonly externalThreadId?: string;
  };
}

interface MessagingConversationRepositoryPortDefinition {
  /**
   * Idempotent for the exact same `(connectionId, externalConversationId,
   * taskId)` triple — a retried `record` call after a crash resolves to
   * the same mapping, not a duplicate write. A DIFFERENT `taskId` for an
   * already-recorded `(connectionId, externalConversationId)` is never
   * expected (the admission pipeline always checks `get` first) and
   * throws `TaviError("CONFLICT", ...)` rather than silently overwriting
   * which task owns a conversation.
   */
  record(mapping: MessagingConversationTask): void;
  /** The conversation's current task: its active epoch's, if it has one. */
  get(connectionId: string, externalConversationId: string): MessagingConversationTask | undefined;
  /** The conversation a task was admitted from, if it was, in whichever epoch. */
  getByTask(taskId: string): MessagingConversationTask | undefined;
  /**
   * The provider recorded for each connection a conversation was held on:
   * how a reader with no owner running names a
   * connection's channel, open or not.
   */
  connectionProviders(): readonly { readonly connectionId: string; readonly providerId: string }[];
  /**
   * The epoch the conversation's next task starts: its active one, or
   * one past the newest when `/new` ended it, or 0 for a conversation never seen.
   */
  nextEpoch(connectionId: string, externalConversationId: string): number;
  /** The conversation's newest mapping, active or ended, if it has any. */
  newest(connectionId: string, externalConversationId: string): MessagingConversationTask | undefined;
  /**
   * Open the conversation again for `taskId`: when
   * it has no active epoch and its newest ended one is `taskId`'s, a new active
   * epoch for the same task (its reply target kept). The active mapping when
   * it already is `taskId`'s; undefined — writing nothing — otherwise.
   */
  reopen(connectionId: string, externalConversationId: string, taskId: string, at: string): MessagingConversationTask | undefined;
  /**
   * End the conversation's active epoch (`/new`): its task stays
   * readable, and the next message starts the next epoch. The ended mapping,
   * or `undefined` when the conversation had no active one.
   */
  reset(connectionId: string, externalConversationId: string, at: string): MessagingConversationTask | undefined;
  /**
   * Record that an ended epoch's withdrawal ran: what its
   * task still waited on was withdrawn after `reset`. True when this call
   * recorded it; false when the epoch is not ended or was already marked.
   */
  markWithdrawn(connectionId: string, externalConversationId: string, epoch: number, at: string): boolean;
  /**
   * Ended epochs whose withdrawal never ran — an owner stopped between `reset`
   * and the withdrawal — oldest first, at most 200. An epoch whose task a later
   * epoch of a conversation continues (`reopen`) is left out: it is not over.
   */
  listUnwithdrawn(): readonly MessagingConversationTask[];
  /**
   * A person's direct conversations as their active tasks, newest
   * first: one-to-one chats whose task is theirs and whose sender is bound to
   * them — where something meant for that person alone, such as their memory
   * digest, may be posted. Groups and threads are never listed.
   */
  directTasksOf(workspaceId: string, principalId: string): readonly MessagingConversationTask[];
}

export type MessagingConversationRepositoryPort = AsyncRepository<MessagingConversationRepositoryPortDefinition>;

/**
 * Durable inbound event dedup/ack state: the event/dedup key and pending
 * processing are persisted in SQLite before acknowledging upstream.
 * `record` is `ON CONFLICT DO NOTHING`-idempotent by
 * `(connectionId, providerEventId)`, mirroring `SqliteAgentWaitRepository
 * .prepare`'s identical replay-safety rationale.
 *
 * **Trust assumption, stated explicitly rather than left implicit**: a
 * second `record` call under an already-seen `(connectionId,
 * providerEventId)` is always treated as a redelivery of the *same*
 * event — its `payload` is silently discarded in favor of the
 * already-stored one, never merged or compared. A provider that ever
 * reused an event ID for two logically different events within one
 * connection would lose the second event's content permanently and
 * silently. This is deliberately not guarded against here (no
 * content-hash mismatch detection): providers are trusted to give each
 * distinct event its own stable ID, the same trust this contract's
 * `providerEventId` doc comment already places in "a provider-specific
 * stable dedup key".
 */
interface MessagingInboxRepositoryPortDefinition {
  record(input: {
    readonly connectionId: string;
    readonly providerEventId: string;
    readonly kind: string;
    readonly payload: InboundEvent;
    readonly now: () => string;
  }): { readonly created: boolean };
  markProcessed(connectionId: string, providerEventId: string): void;
  /**
   * Claim a held row for replay, atomically, and say whether this caller won.
   *
   * `markProcessed` lands only after admission, so nothing else stops two
   * replays (or a crash plus a retry) from admitting the same message twice. A
   * claim older than `staleBefore` is takeable again, so a crashed replay
   * retries rather than stranding the row.
   */
  claimForReplay(input: {
    readonly connectionId: string;
    readonly providerEventId: string;
    readonly now: string;
    readonly staleBefore: string;
  }): boolean;
  /** Give a claim back, after a replay that did not admit. */
  releaseReplayClaim(connectionId: string, providerEventId: string): void;
  get(
    connectionId: string,
    providerEventId: string,
  ): { readonly state: "received" | "processed"; readonly payload: InboundEvent } | undefined;
  /**
   * Inbound events that were recorded but never admitted, oldest first.
   * With `connectionIds`, only those connections' held rows, and their total.
   *
   * The held case: a message whose sender was bound *after* that exact event
   * was recorded stays `received` forever — `created` is `false` on every later
   * redelivery, so the ordinary path never admits it. Without a reader, an
   * operator cannot even see that a message is being held, let alone replay it.
   * `resolvedPrincipalId` is resolved at read time, so the listing says which of
   * these are now admissible.
   */
  listHeld(input: { readonly limit: number; readonly connectionIds?: readonly string[] }): {
    readonly held: readonly {
      readonly connectionId: string;
      readonly providerEventId: string;
      readonly receivedAt: string;
      readonly externalSenderId: string;
      readonly content: string;
      readonly resolvedPrincipalId: string | null;
    }[];
    /** How many held rows exist in total, so a truncated listing says so. */
    readonly total: number;
  };
}

export type MessagingInboxRepositoryPort = AsyncRepository<MessagingInboxRepositoryPortDefinition>;

/**
 * Durable outbound send state, keyed by `effectId`: the destination and
 * part plan persist, accepted parts are tracked, and there is one retry
 * owner. `begin` is `ON CONFLICT DO NOTHING`-idempotent by `effectId` —
 * a retried `send()` call for the same logical effect resolves the
 * already-recorded outcome instead of submitting twice.
 *
 * A `pending` row (between `begin` committing and `resolve` ever running)
 * is deliberately **not** auto-retried by `MessagingServicePort.send()` —
 * a crash in that window could mean the connector was already invoked, so
 * the outside-world send may have already happened, exactly the ambiguity
 * `EffectRepositoryPort.listUnresolved`'s own doc comment already
 * addresses for task effects ("surfaced for reconciliation; never retried
 * automatically"). `listPending` is the messaging equivalent of that
 * surfacing mechanism.
 */
interface MessagingOutboxRepositoryPortDefinition {
  begin(input: {
    readonly effectId: string;
    readonly connectionId: string;
    readonly message: OutboundMessage;
    readonly now: () => string;
  }): {
    readonly created: boolean;
  };
  resolve(input: { readonly effectId: string; readonly outcome: SendOutcome; readonly now: () => string }): void;
  get(
    effectId: string,
  ): { readonly state: "pending" | "resolved"; readonly outcome?: SendOutcome; readonly delivery?: MessagingDelivery } | undefined;
  /**
   * What the provider later said of a sent message, found by the message id
   * a part was accepted under: the send's effect
   * id, or `undefined` for a message this owner did not send. A status never
   * goes back (a read message is not later merely delivered).
   */
  recordDelivery(input: {
    readonly connectionId: string;
    readonly providerMessageId: string;
    readonly status: DeliveryEventStatus;
    readonly at: string;
    readonly detail?: string;
  }): { readonly effectId: string } | undefined;
  /** Rows stuck `pending` — a crash between `begin` and `resolve` — surfaced for reconciliation, never auto-retried. */
  listPending(
    limit: number,
    connectionId?: string,
  ): readonly { readonly effectId: string; readonly connectionId: string; readonly message: OutboundMessage }[];
}

export type MessagingOutboxRepositoryPort = AsyncRepository<MessagingOutboxRepositoryPortDefinition>;

/**
 * Durable storage for `MessagingIdentityBinding` rows. `bind`'s refusal on
 * a conflicting rebind is the concrete
 * mechanism behind "forged-sender denial" at the registration boundary:
 * nothing — not even an operator command — can silently reassign an
 * already-bound external identity to a different principal without an
 * explicit `unbind` first, an auditable two-step action rather than a
 * single overwrite.
 */
interface MessagingIdentityBindingRepositoryPortDefinition {
  /**
   * Throws `TaviError("CONFLICT", ...)` if `(connectionId,
   * externalSenderId)` is already bound to a DIFFERENT principal —
   * existing state refusing the write, not malformed input, matching this
   * codebase's established `CONFLICT` convention for exactly this shape of
   * refusal (e.g. `MemoryService`'s status-conflict checks,
   * `SkillService`'s version/activation conflicts). Re-binding the exact
   * same `(connectionId, externalSenderId, principalId)` triple is
   * idempotent, matching this codebase's other `ON CONFLICT DO NOTHING`
   * -style dedup precedents rather than treating a repeated identical
   * operator action as an error.
   *
   * **Trust assumption, stated explicitly rather than left implicit**
   * (matching `MessagingInboxRepositoryPort`'s own such paragraph): this
   * method never validates `binding.workspaceId` against the actual
   * `MessagingConnectionRecord.workspaceId` for `binding.connectionId` — nothing
   * ties the two together at the repository layer. A caller that supplies a `workspaceId`
   * disagreeing with the connection's real one produces a binding
   * `list()` silently mis-scopes and `resolveSenderActor` hands out a
   * `MemoryActor` whose `workspaceId` disagrees with the
   * connection the event arrived on. Higher-level callers (`channels allow`,
   * `confirm-pair`) verify the connection's workspace before calling `bind`.
   */
  bind(binding: MessagingIdentityBinding): void;
  /**
   * Turns a binding's `trustUnverified` override on (`trust`) or off
   * (`null`). Returns false, changing nothing, when the pair is not bound: an
   * override belongs to a binding and never outlives it.
   */
  setTrustUnverified(connectionId: string, externalSenderId: string, trust: MessagingTrustUnverified | null): boolean;
  /** No-op when the pair is not currently bound — unbinding is idempotent, mirroring `bind`. */
  unbind(connectionId: string, externalSenderId: string): void;
  get(connectionId: string, externalSenderId: string): MessagingIdentityBinding | undefined;
  /**
   * The sender id bound to this principal on this connection, the earliest
   * bound when there are several: where a room's approval card reaches its
   * decider one-to-one.
   */
  senderOf(connectionId: string, principalId: string): string | undefined;
  /** All bindings for a workspace — small, operator-managed, unbounded by design (unlike this file's other `list`-shaped reads, which page). */
  list(workspaceId: string): readonly MessagingIdentityBinding[];
}

export type MessagingIdentityBindingRepositoryPort = AsyncRepository<MessagingIdentityBindingRepositoryPortDefinition>;

export const MESSAGING_CONNECTION_AUTH_STATES = ["none", "connected", "expired", "revoked", "needs-consent"] as const;
export type MessagingConnectionAuthState = (typeof MESSAGING_CONNECTION_AUTH_STATES)[number];

/**
 * A configured messaging connection, as stored: one row
 * per connection, so a channel's kind and label come from its `providerId`'s
 * descriptor rather than from its id, and a workspace may have several
 * connections of one provider. `connectionId` is opaque; connections
 * configured before rows existed keep their `telegram-<ws>`/`mailgun-<ws>`
 * ids so their inbox, outbox, bindings and conversations stay valid.
 * `settings` holds the descriptor's non-secret fields; `credentialRefs` the
 * credential reference behind each secret field, never a secret.
 */
export interface MessagingConnectionRecord {
  readonly connectionId: string;
  readonly providerId: string;
  readonly workspaceId: string;
  /** What the operator calls this connection, when they named it. */
  readonly label?: string;
  readonly accountIdentity: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly credentialRefs: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  /** Bumped on every save; a connection reopens when it changes. */
  readonly configRevision: number;
  readonly authState: MessagingConnectionAuthState;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When it was deleted: kept as a tombstone so its history still names its channel. */
  readonly deletedAt?: string;
}

/** What `save` takes: everything but what the repository keeps itself. */
export type MessagingConnectionInput = Omit<MessagingConnectionRecord, "configRevision" | "createdAt" | "updatedAt" | "deletedAt">;

interface MessagingConnectionRepositoryPortDefinition {
  /**
   * Inserts or replaces the connection named by `input.connectionId`, bumping
   * its `configRevision` (1 for a new one). A connection's provider and
   * workspace never change: saving another's under the same id is a
   * `CONFLICT`.
   */
  save(input: MessagingConnectionInput, now: string): MessagingConnectionRecord;
  /** A connection that is not deleted. */
  get(connectionId: string): MessagingConnectionRecord | undefined;
  /** A workspace's connections, or every workspace's when none is named, oldest first; deleted ones only when asked. */
  list(workspaceId?: string, options?: { readonly includeDeleted?: boolean }): readonly MessagingConnectionRecord[];
  /** Marks a connection deleted, disabled, at a new revision; false when there is none. Saving it again brings it back. */
  remove(connectionId: string, now: string): boolean;
  /**
   * Records a completed OAuth sign-in: the account, the
   * token's credential reference under `oauth`, `authState: "connected"`, at a
   * new revision — in one step, and only on a connection of `workspaceId`
   * that is not deleted, so a removal is never undone by it. False otherwise.
   */
  markConnected(input: {
    readonly connectionId: string;
    readonly workspaceId: string;
    readonly accountIdentity: string;
    readonly tokenRef: string;
    readonly now: string;
  }): boolean;
  /**
   * Records a connection's sign-in state at a new
   * revision, so the host closes or reopens it — unless `reopen` is false
   * (one needing consent keeps running); `dropToken` also forgets its
   * token's reference (a sign-out). False for one deleted or not there.
   */
  setAuthState(input: {
    readonly connectionId: string;
    readonly authState: MessagingConnectionAuthState;
    readonly dropToken?: boolean;
    readonly reopen?: boolean;
    readonly now: string;
  }): boolean;
}

export type MessagingConnectionRepositoryPort = AsyncRepository<MessagingConnectionRepositoryPortDefinition>;

/**
 * Where the host's webhook ingress listens, and the https address it is
 * reached at from outside: one for the owner, not per
 * channel. `publicUrl` also gives approval emails their links.
 */
export interface ChannelIngressSettings {
  readonly host: string;
  readonly port: number;
  readonly publicUrl?: string;
}

/** The ingress before any is configured: loopback only, the port Mailgun's listener always used. */
export const DEFAULT_CHANNEL_INGRESS: ChannelIngressSettings = { host: "127.0.0.1", port: 8025 };

interface ChannelIngressRepositoryPortDefinition {
  /** The saved settings, or `undefined` before any were saved. */
  get(): ChannelIngressSettings | undefined;
  set(settings: ChannelIngressSettings, now: string): void;
}

export type ChannelIngressRepositoryPort = AsyncRepository<ChannelIngressRepositoryPortDefinition>;

/**
 * The one trusted messaging service, in the runtime, for routing, identity
 * resolution and inbox/outbox; provider plugins never invoke the
 * model/agent directly. Mirrors
 * `MemoryService`'s relationship to `MemoryRepositoryPort` — one service,
 * a replaceable repository/provider underneath.
 */
export interface MessagingServicePort {
  registerConnector(definition: MessagingConnectorDefinition): void;
  openConnection(input: { readonly connection: MessagingConnection; readonly config: unknown }): Promise<void>;
  /**
   * Closes a connection once its sends in flight have finished (at most 30 s).
   * With `reopening`, sends that arrive meanwhile wait
   * for the connection to open again (at most 30 s) rather than fail.
   */
  closeConnection(connectionId: string, options?: { readonly reopening?: boolean }): Promise<void>;
  /**
   * Withdraws a provider's connector (its channel plugin stopped): its open
   * connections are closed first, and none of it opens again until it is
   * registered anew. False for one not registered.
   */
  unregisterConnector(providerId: string): Promise<boolean>;
  /**
   * Durably records the event before returning, deduplicating replays,
   * then resolves the sender's identity and (for a genuinely new event
   * from a bound sender) admits a workflow turn via the optional `admit`
   * callback — never for a duplicate/redelivery or
   * an unbound/forged sender.
   */
  ingest(event: InboundEvent, hooks?: MessagingIngestHooks): Promise<MessagingIngestReceipt>;
  /**
   * Admit a held inbound event again, now that its sender may be bound.
   *
   * The same identity resolution and the same `admit` callback as a fresh
   * message, so a replayed event behaves exactly like one that had arrived after
   * the binding; on success the row becomes `processed`. Refuses an unbound
   * sender, a missing row and an already-processed row by *outcome* rather than
   * by throwing, because each is a normal thing for an operator to hit.
   */
  replay(input: { readonly connectionId: string; readonly providerEventId: string }): Promise<MessagingReplayOutcome>;
  /**
   * Denied destinations never reach `connector.send` (denied operations
   * make no call) — `hasGrant`
   * is checked before any connector method runs.
   */
  send(message: OutboundMessage): Promise<SendOutcome>;
  /** Records what the provider said of a sent message; `false` when it names no message this owner sent. */
  recordDelivery(event: DeliveryEvent): Promise<boolean>;
  /** The capabilities of an open connection's connector; `undefined` when it is not open. */
  capabilitiesOf(connectionId: string): MessagingCapabilities | undefined;
  /**
   * How many of a connection's inbound events the room policy dropped in this
   * run of the owner, by reason: counts only, since nothing of a dropped
   * event is kept.
   */
  roomDrops?(connectionId: string): Readonly<Partial<Record<RoomDropReason, number>>>;
  /**
   * Why the last send into each of a connection's rooms was refused, by
   * conversation id, in this run of the owner: a permission the bot
   * lacks there, as its connector said it. A send accepted later clears it.
   */
  roomDetails?(connectionId: string): Readonly<Record<string, string>>;
  /**
   * The group features of an open connection, each refused for a caller of
   * another workspace (`NOT_AUTHORIZED`) and
   * for a connector without it (`UNSUPPORTED`).
   */
  createPoll?(connectionId: string, workspaceId: string, input: ChannelPollInput): Promise<SendOutcome>;
  /**
   * A room's recent messages (`groups.recentHistory`), newest last, at
   * most `limit` and the connector's own most: what a triggered turn in a room
   * whose context is `recent` reads beside the message.
   */
  fetchRecent?(
    connectionId: string,
    workspaceId: string,
    destination: unknown,
    options: { readonly limit: number; readonly before?: string; readonly signal: AbortSignal },
  ): Promise<readonly RecentRoomMessage[]>;
  readPoll?(connectionId: string, workspaceId: string, destination: unknown, messageId: string): Promise<ChannelPollState>;
  endPoll?(
    connectionId: string,
    workspaceId: string,
    input: { readonly effectId: string; readonly destination: unknown; readonly messageId: string },
  ): Promise<SendOutcome>;
  createEvent?(connectionId: string, workspaceId: string, input: ChannelEventInput): Promise<SendOutcome & { readonly url?: string }>;
  /** The rooms the platform lists for the connection: names display-only and untrusted (`groups.listRooms`). */
  listRooms?(connectionId: string, workspaceId: string): Promise<readonly ChannelRoomListing[]>;
  /** Leaves a room the agent was added to (`groups.leaveRoom`). */
  leaveRoom?(connectionId: string, workspaceId: string, destination: unknown): Promise<void>;
  /** Acknowledge a button press; a no-op for a connector that has no interactions. */
  answerInteraction(connectionId: string, callbackId: string, text: string): Promise<void>;
  /** Edit a sent message and replace its buttons (none unless given); `false` when the connector cannot edit. */
  editMessage(
    connectionId: string,
    input: {
      readonly destination: unknown;
      readonly messageId: string;
      readonly text: string;
      readonly buttons?: readonly (readonly OutboundButton[])[];
    },
  ): Promise<boolean>;
  /**
   * The destination of a one-to-one chat with this sender on the connection,
   * through its connector's `directDestinationOf`: where a room's approval
   * card reaches its decider. `undefined` when
   * the connection is not open, is another workspace's, or its channel
   * cannot open one.
   */
  buildDirectDestination?(connectionId: string, externalSenderId: string, workspaceId: string): unknown | undefined;
  /**
   * Builds the provider-specific `OutboundMessage.destination` for a
   * reply on `connectionId`, via that connection's own
   * `MessagingConnectorDefinition.destinationFromInbound` — what the
   * `messaging.send` governed tool calls rather than
   * constructing a destination shape itself. Returns `undefined` when the
   * connection isn't open or its connector defines no
   * `destinationFromInbound` (a connector with no reply concept, or one
   * not yet updated) — `messaging.send` turns that into a failed-closed
   * tool result, never a guessed destination.
   */
  buildReplyDestination(
    connectionId: string,
    replyTo: {
      readonly externalConversationId: string;
      readonly externalSenderId: string;
      readonly externalMessageId?: string;
      readonly externalReferences?: readonly string[];
      /** The forum topic or thread the inbound message arrived in. */
      readonly externalThreadId?: string;
      /** The inbound message's subject, where its channel has one. */
      readonly subject?: string;
    },
  ): unknown | undefined;
  /**
   * Builds the destination for a send to `target` on `connectionId`, via the
   * connector's own `destinationFor`. `undefined` when
   * the connection is not open or its connector cannot be sent to this way.
   */
  buildDestination(connectionId: string, target: MessagingTarget): unknown | undefined;
  /** The provider of an open connection; `undefined` when it is not open. */
  providerOf(connectionId: string): string | undefined;
  /** An open connection's own status; `undefined` when it is not open. */
  statusOf(connectionId: string): MessagingConnectionStatus | undefined;
  /**
   * Probes an open connection now (`MessagingConnectorInstance.probe`), and
   * keeps the answer as its last; `undefined` when it is not open. Its
   * connector's failure is the answer's, never a throw.
   */
  probe?(connectionId: string): Promise<MessagingProbeResult | undefined>;
  /** An open connection's last probe, taken in the background when first read (or a minute after) and by `probe`; `undefined` before one answered. */
  probeOf?(connectionId: string): MessagingProbeResult | undefined;
  /** An open connection's webhook ingress with what it reads; `undefined` when it is not open or takes no webhooks. */
  ingressOf(connectionId: string): { readonly ingress: MessagingIngress; readonly context: IngressContext } | undefined;
  /** A provider's open connections, for a webhook route one URL serves for every account. */
  connectionsOf(providerId: string): readonly MessagingConnection[];
}

export const MessagingService = createServiceToken<MessagingServicePort>("tavi.messaging");

/** The local messaging connection's provider id: the owner's own front ends' channel, one connection per workspace. */
export const LOCAL_PROVIDER_ID = "local";

/** The local connection of a workspace. */
export function localConnectionId(workspaceId: string): string {
  return `${LOCAL_CONNECTION_PREFIX}${workspaceId}`;
}

/**
 * The prefix every local connection id has, and no other connection may: the
 * owner refuses to open another connection under it, so this test is sound.
 */
export const LOCAL_CONNECTION_PREFIX = "local-";

/** Whether `connectionId` names a local connection. */
export function isLocalConnectionId(connectionId: string): boolean {
  return connectionId.startsWith(LOCAL_CONNECTION_PREFIX);
}

/**
 * Whether a turn whose reply goes to `replyTo` answers no channel
 * conversation: none started it, or a local chat did, whose own answer is its
 * reply (`ToolOfferContext.outsideConversation`).
 */
export function answersNoChannelConversation(replyTo: { readonly connectionId: string } | undefined): boolean {
  return replyTo === undefined || isLocalConnectionId(replyTo.connectionId);
}
