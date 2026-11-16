import { z } from "zod";

import { ADDRESS_KINDS, type ChannelRoomListing, type RoomDropReason } from "./channel-groups.js";
import { ROOM_CONTEXTS, ROOM_MEMBERS, type ChannelRoomRecord } from "./channel-rooms.js";
import { GRANT_MODES, GRANT_SCOPE_KINDS, type MessagingGrantRecord } from "./messaging-grants.js";
import type { ChannelDescriptor } from "./channels.js";
import type {
  ChannelIngressSettings,
  MessagingConnectionAuthState,
  MessagingConnectionState,
  MessagingIdentityBinding,
  MessagingProbeResult,
  MessagingSetup,
} from "./messaging.js";
import { MESSAGING_DISPLAY_NAME_MAX } from "./messaging.js";

/**
 * The `channels` IPC command: every
 * channel's connections, configured from its descriptor rather than from a
 * page written for it. Settings → Channels and `tavi channels` both speak it,
 * and only the operator does: no tool reaches it.
 */

const WorkspaceId = z.string().min(1).max(128);
const ConnectionId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "A connection id is letters, digits, dot, dash and underscore");
/**
 * Ids a new connection may not take: the ingress answers `/hooks/p/…` (a provider's shared address) and
 * `/hooks/schedules/…` (a schedule's webhook) itself, so a connection by either name would share their routes.
 */
export const RESERVED_CHANNEL_CONNECTION_IDS: ReadonlySet<string> = new Set(["p", "schedules"]);
const SettingValue = z.union([z.string().max(2048), z.number(), z.boolean()]);

export const ChannelsPayloadSchema = z.discriminatedUnion("action", [
  /** Every channel this owner can configure, by its descriptor. */
  z.object({ action: z.literal("catalog") }).strict(),
  /** A workspace's connections, with status, and the owner's ingress. */
  z.object({ action: z.literal("list"), workspaceId: WorkspaceId }).strict(),
  /**
   * Adds a connection (no `connectionId`: one is made) or changes one. Its
   * settings are checked against the channel's descriptor; a secret left out
   * keeps the one stored. The change applies at once.
   */
  z
    .object({
      action: z.literal("save"),
      workspaceId: WorkspaceId,
      connectionId: ConnectionId.optional(),
      providerId: z.string().min(1).max(48),
      label: z.string().trim().min(1).max(80).optional(),
      enabled: z.boolean(),
      settings: z.record(z.string().min(1).max(48), SettingValue),
      secrets: z.record(z.string().min(1).max(48), z.string().min(1).max(16384)).optional(),
    })
    .strict(),
  /** Removes a connection: closed, its secrets deleted; its history kept, except on a channel that purges on removal. */
  z.object({ action: z.literal("delete"), workspaceId: WorkspaceId, connectionId: ConnectionId }).strict(),
  /**
   * A third party's deletion request: erases a sender's messages and files
   * on a connection, their
   * binding, and the notes their own chats taught; answers which conversations
   * still hold their words in saved turns.
   */
  z
    .object({
      action: z.literal("forget-sender"),
      workspaceId: WorkspaceId,
      connectionId: ConnectionId,
      sender: z.string().min(1).max(320),
    })
    .strict(),
  /**
   * A connection's room and contact grants: list them; add one (one of the
   * same scope and tool is
   * replaced); or revoke one, from its next turn on. A room is only ever denied.
   */
  z
    .object({
      action: z.literal("grants"),
      workspaceId: WorkspaceId,
      connectionId: ConnectionId,
      op: z.enum(["list", "add", "revoke"]),
      scopeKind: z.enum(GRANT_SCOPE_KINDS).optional(),
      scopeId: z.string().min(1).max(256).optional(),
      toolId: z.string().min(1).max(200).optional(),
      mode: z.enum(GRANT_MODES).optional(),
      expiresAt: z.string().datetime({ offset: true }).optional(),
      grantId: z.string().min(1).max(64).optional(),
    })
    .strict(),
  /** What removing a connection would erase, for its confirmation. */
  z.object({ action: z.literal("remove-preview"), workspaceId: WorkspaceId, connectionId: ConnectionId }).strict(),
  /**
   * Sends a short message through a connection, to see it works: to a target
   * as the channel names one, or with `direct` to a person allowed on it, at
   * their sender id, one-to-one the way the channel reaches them.
   */
  z
    .object({
      action: z.literal("test"),
      workspaceId: WorkspaceId,
      connectionId: ConnectionId,
      to: z.string().min(1).max(320),
      direct: z.literal(true).optional(),
      text: z.string().min(1).max(1000).optional(),
    })
    .strict(),
  /**
   * Whether a connection's account answers, and what setting it up still asks
   * (its probe): no message is sent, so a connection nobody is paired on yet
   * can be checked.
   */
  z.object({ action: z.literal("probe"), workspaceId: WorkspaceId, connectionId: ConnectionId }).strict(),
  /** Where the webhook ingress listens, and its public address (the owner's, not a workspace's). */
  z
    .object({
      action: z.literal("ingress"),
      port: z.number().int().min(1024).max(65535),
      publicUrl: z
        .string()
        .max(2048)
        .refine((value) => value === "" || /^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(value), "Enter an https address with no query")
        .optional(),
      /**
       * The reverse proxies, besides one on this machine, whose `X-Forwarded-For` names the caller: addresses and CIDR
       * ranges, checked by the owner. Left out, the saved list stays; empty clears it.
       */
      trustedProxies: z
        .array(z.string().regex(/^[0-9A-Fa-f:.]{2,45}(\/\d{1,3})?$/, "Enter an IP address or a CIDR range"))
        .max(64)
        .optional(),
    })
    .strict(),
  /** Who may chat through a workspace's connections. */
  z.object({ action: z.literal("people"), workspaceId: WorkspaceId }).strict(),
  z
    .object({
      action: z.literal("allow"),
      workspaceId: WorkspaceId,
      connectionId: ConnectionId,
      sender: z.string().trim().min(1).max(320),
      principalId: z.string().trim().min(1).max(128),
      name: z.string().trim().min(1).max(MESSAGING_DISPLAY_NAME_MAX).optional(),
      /** Only on a channel that authenticates each message (email): admit this person's unverified messages. */
      trustUnverified: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("revoke"), workspaceId: WorkspaceId, connectionId: ConnectionId, sender: z.string().min(1).max(320) })
    .strict(),
  /** A one-time code for a person to send on a connection, so the operator need not know their sender id. */
  z
    .object({
      action: z.literal("pair"),
      workspaceId: WorkspaceId,
      connectionId: ConnectionId,
      principalId: z.string().trim().min(1).max(128),
      name: z.string().trim().min(1).max(MESSAGING_DISPLAY_NAME_MAX).optional(),
      /** As `allow`'s: applied when the pairing is confirmed. */
      trustUnverified: z.boolean().optional(),
    })
    .strict(),
  /** How a pairing stands: waiting for its code, or claimed by a sender for the operator to confirm. */
  z.object({ action: z.literal("pairing"), workspaceId: WorkspaceId, pairingId: z.string().uuid() }).strict(),
  /** Allows the sender who claimed a pairing as its person. */
  z.object({ action: z.literal("confirm-pair"), workspaceId: WorkspaceId, pairingId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("cancel-pair"), workspaceId: WorkspaceId, pairingId: z.string().uuid() }).strict(),
  /**
   * The operator's own OAuth app for a channel: stored once per
   * provider, used by every connection of it, in place of a plugin's.
   */
  z
    .object({
      action: z.literal("oauth-client"),
      providerId: z.string().min(1).max(48),
      clientId: z.string().trim().min(1).max(512),
      clientSecret: z.string().trim().min(1).max(4096).optional(),
    })
    .strict(),
  /**
   * Lets a channel plugin sign in with the OAuth client a provider's apps share (its descriptor's `app.provider`),
   * or (`pluginId: null`) takes that back. Its signed-in connections are signed out either way.
   */
  z
    .object({
      action: z.literal("share-client"),
      provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
      pluginId: z.string().min(1).max(128).nullable(),
    })
    .strict(),
  /** Forgets the operator's own OAuth app for a channel. */
  z.object({ action: z.literal("oauth-client-clear"), providerId: z.string().min(1).max(48) }).strict(),
  /**
   * Starts signing a saved connection in: the URL to open, and
   * a flow id to ask after. `origin` is the page's own, which a loopback
   * redirect comes back to.
   */
  z
    .object({
      action: z.literal("oauth-start"),
      workspaceId: WorkspaceId,
      connectionId: ConnectionId,
      origin: z
        .string()
        .max(64)
        .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/, "The page's origin is a loopback address")
        .optional(),
      /** Come back to the owner's https address, whatever the channel's own redirect. */
      public: z.boolean().optional(),
      /** Sign in with a code instead (RFC 8628), for a channel that declares it. */
      device: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal("oauth-status"), workspaceId: WorkspaceId, flowId: z.string().uuid() }).strict(),
  /** Paste-back: the address the browser landed on, bound to the flow's state and redirect. */
  z
    .object({
      action: z.literal("oauth-finish"),
      workspaceId: WorkspaceId,
      flowId: z.string().uuid(),
      address: z.string().min(1).max(8192),
    })
    .strict(),
  /** Ends a sign-in still waiting: a browser that comes back later signs nothing in. */
  z.object({ action: z.literal("oauth-cancel"), workspaceId: WorkspaceId, flowId: z.string().uuid() }).strict(),
  /** Signs a connection out: revoked at the provider when it can be, its token deleted, the connection closed. */
  z
    .object({
      action: z.literal("oauth-disconnect"),
      workspaceId: WorkspaceId,
      connectionId: ConnectionId,
      /** `false`: the token deleted here only, the provider's grant left for another app signed in with it. */
      upstream: z.boolean().optional(),
    })
    .strict(),
  /** The provider's redirect, as the bridge or the ingress received it: authenticated by its state alone. */
  z
    .object({
      action: z.literal("oauth-callback"),
      state: z.string().min(16).max(128),
      code: z.string().max(4096).optional(),
      error: z.string().max(256).optional(),
      /** RFC 9207's issuer: an MCP login checks it, and so does a channel whose OAuth spec declares its `issuer`. */
      iss: z.string().max(512).optional(),
    })
    .strict(),
  /**
   * A connection's rooms:
   * list them; add one (its introduction is sent); set its label, trigger,
   * members, whether it answers in threads, or whether it reads its recent
   * messages (introduced again when it starts to); remove it; or leave a room the agent was added to. Every op but
   * `list` names the room's `conversationId`.
   */
  z
    .object({
      action: z.literal("rooms"),
      workspaceId: WorkspaceId,
      connectionId: ConnectionId,
      op: z.enum(["list", "add", "set", "remove", "leave"]),
      conversationId: z.string().min(1).max(256).optional(),
      label: z.string().trim().min(1).max(120).optional(),
      trigger: z.array(z.enum(ADDRESS_KINDS)).min(1).max(ADDRESS_KINDS.length).optional(),
      members: z.enum(ROOM_MEMBERS).optional(),
      autoThread: z.boolean().optional(),
      /** `recent`: a triggered turn in the room also reads its recent messages; `off`, only the message. */
      context: z.enum(ROOM_CONTEXTS).optional(),
    })
    .strict(),
]);
export type ChannelsPayload = z.infer<typeof ChannelsPayloadSchema>;

/** A connection as Settings shows it: never a secret, only whether each is stored. */
export interface ChannelConnectionView {
  readonly connectionId: string;
  readonly providerId: string;
  readonly label: string;
  readonly workspaceId: string;
  readonly accountIdentity: string;
  readonly settings: Readonly<Record<string, unknown>>;
  /** Each secret field the descriptor declares: whether one is stored. */
  readonly secretsStored: Readonly<Record<string, boolean>>;
  readonly enabled: boolean;
  /** An OAuth connection's sign-in: `connected`, or why it needs one again. */
  readonly authState: MessagingConnectionAuthState;
  /** The other apps signed in with the same provider grant: a disconnect leaves it with them. */
  readonly keptBy?: readonly string[];
  readonly status: {
    readonly state: MessagingConnectionState;
    readonly detail?: string;
    /** When this run of the owner last took a message in on it, or sent through it. */
    readonly lastInboundAt?: string;
    readonly lastSendAt?: string;
    /** Why its last send was not accepted. */
    readonly lastError?: string;
  };
}

export interface ChannelsCatalogAnswer {
  readonly channels: readonly ChannelDescriptor[];
}

/** How a channel's OAuth app stands: never the client's values. */
export interface OAuthClientStatus {
  /** Who the descriptor says owns the app. */
  readonly source: "operator" | "plugin";
  /** The operator entered their own client (in place of the plugin's, for a plugin one). */
  readonly own: boolean;
  /** A client is there to connect with. */
  readonly ready: boolean;
}

export interface ChannelsListAnswer {
  readonly connections: readonly ChannelConnectionView[];
  /** Each OAuth channel's app, by provider id. */
  readonly oauthClients: Readonly<Record<string, OAuthClientStatus>>;
  /** Whether the credential store is encrypted at rest: an OAuth sign-in needs it. */
  readonly credentialsEncrypted: boolean;
  readonly ingress: ChannelIngressSettings;
  /** The reverse proxies the ingress believes `X-Forwarded-For` from, besides one on this machine; left out when none. */
  readonly trustedProxies?: readonly string[];
}

/** A room waiting for the operator: the agent was added to it, or it spoke while unlisted. */
export interface ChannelRoomWaiting {
  readonly conversationId: string;
  /** Who added the agent or spoke, as the platform names them (an id, untrusted). */
  readonly by: string;
  /** The platform's name for it, display only and untrusted. */
  readonly roomName?: string;
  readonly how: "added" | "spoke";
  readonly at: string;
}

export interface ChannelsRoomsAnswer {
  readonly rooms: readonly ChannelRoomRecord[];
  /** The rooms the platform lists, where its channel can (display only, untrusted names). */
  readonly candidates?: readonly ChannelRoomListing[];
  /** Rooms nobody listed that are waiting for the operator. */
  readonly waiting: readonly ChannelRoomWaiting[];
  /** What the room policy dropped in this run of the owner, by reason: counts only. */
  readonly drops: Readonly<Partial<Record<RoomDropReason, number>>>;
  /** Why the last send into a room was refused, by conversation id, in this run of the owner. */
  readonly details?: Readonly<Record<string, string>>;
  /** An added room's introduction did not go out, and why; the room is listed all the same. */
  readonly notApplied?: string;
}

/** What removing a connection erases: nothing on a `keep` channel; on a purging one, these, 24 hours after. */
export interface ChannelsRemovePreviewAnswer {
  readonly retention: "keep" | "purge-on-remove";
  readonly conversations: number;
  readonly messages: number;
  readonly files: number;
  /** Its conversations' tasks (at most 20), each exportable first with `tavi tasks history <task> export`. */
  readonly tasks: readonly string[];
  /** Conversations beyond the `tasks` listed. */
  readonly moreTasks: number;
  /** The chat notes its conversations taught, when a running owner could count them. */
  readonly notes?: number;
  /** The routine delivery targets on it, which go with it. */
  readonly routineTargets: readonly string[];
  /** How many heartbeats lose a target on it. */
  readonly heartbeats: number;
}

/** A connection's grants, each with whether it is in force now. */
export interface ChannelsGrantsAnswer {
  readonly grants: readonly (MessagingGrantRecord & { readonly inForce: boolean })[];
}

export interface ChannelsForgetSenderAnswer {
  readonly sender: string;
  /** Their inbound messages erased, admitted and held alike. */
  readonly messages: number;
  /** Others' messages that quoted them (a reply's parent, a picked message), their words taken out and the message kept. */
  readonly quoted: number;
  /** The files those messages carried, erased. */
  readonly files: number;
  readonly bindingRemoved: boolean;
  /** Notes and memory their own chats taught, erased. */
  readonly notes: number;
  /**
   * Conversations they spoke in, with their tasks: saved turns are not split by
   * speaker, so their words stay there until each is forgotten
   * (`tavi tasks history <task> forget`).
   */
  readonly stillInTurns: readonly { readonly conversationId: string; readonly taskIds: readonly string[] }[];
}

export interface ChannelsDeleteAnswer {
  readonly ok: true;
  /** When what it brought in is erased, on a channel that purges on removal; adding the same account back before then cancels it. */
  readonly purgeAfter?: string;
}

export interface ChannelsSaveAnswer {
  readonly connectionId: string;
  /** Removed connections of the same platform account whose purge this cancelled. */
  readonly purgeCancelled?: readonly string[];
  /** The connection could not open with what was saved, and why. */
  readonly notApplied?: string;
}

/** `share-client`: the provider's binding as it now stands, and how many connections signed out for it. */
export interface ChannelsShareClientAnswer {
  readonly sharedClient: { readonly provider: string; readonly pluginId: string | null; readonly signedOut?: number };
}

export interface ChannelsIngressAnswer {
  /** Whether the listener moved to these settings now; when it did not, `notApplied` says why. */
  readonly applied: boolean;
  /** The listener could not move, and why; the settings are saved. */
  readonly notApplied?: string;
}

export interface ChannelsTestAnswer {
  readonly status: "accepted" | "rejected" | "uncertain";
  readonly detail?: string;
  /** What the connection's probe says setting it up still asks (an invite link, a warning), when it says anything. */
  readonly setup?: MessagingSetup;
}

export type ChannelsProbeAnswer = MessagingProbeResult;

export interface ChannelsPairAnswer {
  readonly pairingId: string;
  readonly code: string;
  readonly expiresAt: string;
  /** A deep link that opens the channel's chat with the pairing code handed over (its descriptor's `pairing`), when its test named the account. */
  readonly linkUrl?: string;
  /** The link's words (`pairing.openLabel`), with `linkUrl`. */
  readonly openLabel?: string;
  /** The account's handle (a bot's username, without `@`) when its test named it. */
  readonly account?: string;
}

export interface ChannelsPairingAnswer {
  readonly state: "waiting" | "claimed" | "expired" | "gone";
  readonly connectionId?: string;
  readonly principalId?: string;
  /** The sender whose message carried the code. */
  readonly sender?: string;
  /** What the platform calls that sender, display only. */
  readonly senderName?: string;
  readonly expiresAt?: string;
}

export interface ChannelsOAuthStartAnswer {
  readonly flowId: string;
  readonly authorizeUrl: string;
}

/** `oauth-start` with `device`: the code to enter at the address, on any device (RFC 8628). */
export interface ChannelsOAuthDeviceStartAnswer {
  readonly flowId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** The address with the code already in it, when the provider gives one. */
  readonly verificationUriComplete?: string;
  readonly expiresAt: string;
}

/** A sign-out: `keptBy` names the other apps that keep the provider's grant, so it was deleted here only. */
export interface ChannelsOAuthDisconnectAnswer {
  readonly ok: true;
  readonly keptBy: readonly string[];
}

export interface ChannelsOAuthStatusAnswer {
  readonly state: "pending" | "connected" | "failed" | "expired" | "gone";
  readonly accountIdentity?: string;
  readonly detail?: string;
}

export interface ChannelsPeopleAnswer {
  readonly people: readonly MessagingIdentityBinding[];
  /** The workspace operator's own principal: a sender allowed under it is the operator, not another person. */
  readonly operator?: string;
}
