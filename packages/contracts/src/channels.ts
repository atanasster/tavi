import { z } from "zod";

import { APP_CATEGORIES, AppScopeSchema } from "./app-basics.js";
import { IdeaPluginCapabilitySchema } from "./ideas.js";
import { CHANNEL_RETENTIONS, ChannelGroupPolicySchema, ChannelHostSchema } from "./channel-groups.js";

/**
 * Channel descriptors.
 *
 * A messaging channel plugin contributes two halves: this static,
 * JSON-serializable descriptor — what the channel is called, what kind it is,
 * what an operator configures, how its senders and targets look, how it
 * authenticates and what webhook routes it needs — and the code half, a
 * `MessagingConnectorDefinition` (`./messaging.js`) with the same
 * `providerId`. Core learns everything about a channel from these two and
 * never names a provider itself (principle 1): the descriptor is what
 * Settings renders a form from, what the agent's channel list is built from,
 * and what a plugin's review shows before any of its code runs.
 */

/**
 * The version of the channel contract — this descriptor plus
 * `MessagingConnectorDefinition` — a channel plugin is built for. A plugin
 * declaring a version not in `SUPPORTED_CHANNEL_ABIS` is refused with a status
 * saying it needs an update, rather than loaded ("Versioning").
 */
export const CHANNEL_ABI = 2;

/**
 * The channel ABIs this host loads. ABI 2 is additive: it adds the group
 * seam (descriptor `groups`, the
 * connector's group capabilities and methods) and `ctx.channelHost`. An ABI 1
 * plugin keeps working as a chat channel without group features, and may not
 * declare `groups`.
 */
export const SUPPORTED_CHANNEL_ABIS: readonly number[] = [1, 2];

/** What a channel carries: core's only knowledge of a channel's semantics, in place of id-prefix checks. */
export const CHANNEL_KINDS = ["chat", "email", "sms"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/**
 * How a sender id or a send target is normalized before it is matched or
 * stored: `lowercase` for email addresses, `e164` for phone numbers (digits
 * with a leading `+`), `none` for opaque provider ids.
 */
export const CHANNEL_NORMALIZATIONS = ["none", "lowercase", "e164"] as const;
export type ChannelNormalization = (typeof CHANNEL_NORMALIZATIONS)[number];

/** A channel provider's id: what connections, conversations and a task's channel kind name it by. */
export const ChannelProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;

/** A pattern a descriptor declares must compile; one that does not is refused at registration, not at first use. */
const PatternSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((pattern) => {
    try {
      new RegExp(pattern, "u");
      return true;
    } catch {
      return false;
    }
  }, "Enter a valid regular expression");

/** One non-secret setting an operator fills in for a connection. */
export const ChannelFieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY),
    label: z.string().min(1).max(80),
    type: z.enum(["string", "number", "boolean", "choice"]),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    choices: z.array(z.string().min(1).max(80)).min(1).max(50).optional(),
    pattern: PatternSchema.optional(),
    help: z.string().max(500).optional(),
  })
  .strict()
  .refine((field) => (field.type === "choice") === (field.choices !== undefined), "Choices belong to, and only to, a choice field")
  .refine((field) => {
    if (field.default === undefined) return true;
    if (field.type === "choice") return typeof field.default === "string" && (field.choices ?? []).includes(field.default);
    return typeof field.default === field.type;
  }, "A default must match the field's type, and be one of its choices");
export type ChannelField = z.infer<typeof ChannelFieldSchema>;

/** One secret an operator enters for a connection: masked, stored in the credential store, never returned. */
export const ChannelSecretFieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY),
    label: z.string().min(1).max(80),
    help: z.string().max(500).optional(),
  })
  .strict();
export type ChannelSecretField = z.infer<typeof ChannelSecretFieldSchema>;

/**
 * Who owns the OAuth app a channel connects through: the
 * operator enters a client id and secret, or the plugin ships its author's
 * registered client id. The Connect experience is the same either way, and an
 * operator may always use their own client instead.
 */
export const OAuth2ClientSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("operator") }).strict(),
  z
    .object({
      source: z.literal("plugin"),
      clientId: z.string().min(1).max(512),
      /** A credential reference to the client secret when the provider needs one — never the secret inline. */
      clientSecretRef: z.string().min(1).max(256).optional(),
    })
    .strict(),
]);
export type OAuth2Client = z.infer<typeof OAuth2ClientSchema>;

/**
 * Whether a host names this machine or a private network: a channel's OAuth
 * addresses are the host's own requests, so a manifest may not aim them inward.
 */
function isInwardHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (host.includes(":"))
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80") ||
      host.startsWith("::ffff:")
    );
  return false;
}

const HttpsUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((url) => url.startsWith("https://"), "Must be an https URL")
  .refine((url) => {
    // The authority, read without `URL` (contracts run with no DOM or Node types): no user info, and a public host.
    const authority = /^https:\/\/([^/?#]*)/i.exec(url)?.[1] ?? "";
    if (authority.includes("@")) return false;
    const host = /^(\[[^\]]*\]|[^:]*)/.exec(authority)?.[1] ?? "";
    return host !== "" && !isInwardHost(host);
  }, "Must be a public address, with no user name or password in it");

/** Where a plugin's own OAuth client secret is kept: under its channel's name, and nowhere else (it is sent to the plugin's token address). */
export const pluginClientSecretRef = (providerId: string): string => `channels.plugin-client.${providerId}.secret`;

/** What the host sets on every authorize URL itself: a channel's extra parameters may not name them. */
const RESERVED_AUTHORIZE_PARAMS: ReadonlySet<string> = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
]);

/** The authorization-code flow (with PKCE) the host runs for a channel. */
export const OAuth2SpecSchema = z
  .object({
    authorizeUrl: HttpsUrlSchema,
    tokenUrl: HttpsUrlSchema,
    revokeUrl: HttpsUrlSchema.optional(),
    /**
     * The provider's issuer identifier, for one that names itself in its redirect (RFC 9207's `iss`): a redirect
     * naming another issuer, or none, is refused before its code is exchanged — the defence against a mix-up between
     * providers that share the owner's one `/oauth/callback`. Compared as written, as the RFC says.
     */
    issuer: HttpsUrlSchema.optional(),
    scopes: z.array(z.string().min(1).max(256)).max(50),
    /**
     * Scopes an account asks for only once something that needs them is on: `mail` while it takes mail in (its
     * `receive` setting) or its mailbox's tools are on, `calendar` while its calendar's tools are. Its next sign-in asks
     * for them with the rest, and until then it keeps working on what it was granted.
     */
    optInScopes: z
      .strictObject({
        mail: z.array(z.string().min(1).max(256)).max(16).optional(),
        calendar: z.array(z.string().min(1).max(256)).max(16).optional(),
      })
      .optional(),
    pkce: z.literal(true),
    /** e.g. Google's `access_type=offline` and `prompt=consent`, without which no refresh token is issued. */
    extraAuthorizeParams: z
      .record(z.string().min(1).max(64), z.string().max(256))
      .refine(
        (params) => !Object.keys(params).some((key) => RESERVED_AUTHORIZE_PARAMS.has(key)),
        "The host sets the flow's own parameters (state, redirect, client, PKCE); a channel adds only others",
      )
      .optional(),
    client: OAuth2ClientSchema,
    /**
     * Where the provider sends the browser back: any loopback port (Google
     * desktop clients, and any provider following RFC 8252 §7.3), or the public
     * address through the ingress (providers that require https).
     */
    redirect: z.enum(["loopback-any-port", "public"]),
    tokenAuthMethod: z.enum(["client_secret_post", "client_secret_basic", "none"]),
    /** Who connected — shown as "Connected as …". */
    accountIdentity: z
      .object({ userinfoUrl: HttpsUrlSchema, field: z.string().min(1).max(64) })
      .strict()
      .optional(),
    /**
     * Signing in with a code shown here and entered on any device (RFC 8628 device authorization), for a provider
     * that allows it: the sign-in then needs no redirect back.
     */
    deviceAuthorizationUrl: HttpsUrlSchema.optional(),
    /**
     * Its provider's device flow cannot ask for the scopes its apps need (Google's): no channel sharing its
     * `app.provider` client is offered a sign-in by code.
     */
    disallowsDeviceFlow: z.literal(true).optional(),
    /**
     * How its provider's client ids name the project that revokes a grant for every client of it, as a regular
     * expression whose first group is the project (Google's `<project-number>-<id>.apps.googleusercontent.com`).
     * A client id that does not match counts as the same project as any other (the safe side). Honoured only for a
     * channel this build ships: a plugin's is never run.
     */
    clientProjectPattern: z
      .string()
      .min(1)
      .max(200)
      .refine((pattern) => {
        try {
          // A group that captures: an unescaped `(` not opening `(?:`, a lookaround, or a named group (which also captures).
          return new RegExp(pattern).source !== "" && /(?<!\\)\((?!\?(?:[:=!]|<[=!]))/.test(pattern);
        } catch {
          return false;
        }
      }, "Must be a regular expression with a capturing group for the project")
      .optional(),
  })
  .strict()
  .refine(
    (spec) => spec.deviceAuthorizationUrl === undefined || spec.disallowsDeviceFlow === undefined,
    "A channel that disallows its provider's device flow declares no device address",
  );
export type OAuth2Spec = z.infer<typeof OAuth2SpecSchema>;

/** A channel's app presentation (`ChannelDescriptor.app`). */
export const ChannelAppSchema = z.strictObject({
  name: z.string().min(1).max(60),
  summary: z.string().max(200).default(""),
  category: z.enum(APP_CATEGORIES),
  publisher: z.string().max(60).optional(),
  /** The provider whose apps share one OAuth client with this channel, such as Calendar's. */
  provider: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .optional(),
  /** `personal` for mail: its accounts start Personal. */
  dataClass: z.enum(["public", "personal"]).optional(),
  scopes: z.array(AppScopeSchema).max(32).default([]),
  /** Its accounts are mailboxes the agent's tools may use, by each account's opt-in: its channel ships the mailbox. */
  mailbox: z.literal(true).optional(),
  /** Its accounts have calendars the agent's tools may use, by each account's opt-in: its channel ships the calendar. */
  calendar: z.literal(true).optional(),
});
export type ChannelApp = z.infer<typeof ChannelAppSchema>;

export const ChannelAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("secrets"), fields: z.array(ChannelSecretFieldSchema).min(1).max(10) }).strict(),
  z.object({ kind: z.literal("oauth2"), oauth: OAuth2SpecSchema, fields: z.array(ChannelSecretFieldSchema).max(10).optional() }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type ChannelAuth = z.infer<typeof ChannelAuthSchema>;

/**
 * A webhook route the host mounts for a channel: per connection at
 * `<prefix>/hooks/<connectionId>/<name>`, or once per provider at
 * `<prefix>/hooks/p/<providerId>/<name>` for providers that deliver every
 * account's events to one URL.
 */
export const ChannelRouteSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    methods: z
      .array(z.enum(["GET", "POST"]))
      .min(1)
      .max(2),
    scope: z.enum(["connection", "provider"]),
    /** The largest body accepted, checked before any plugin code runs. */
    maxBodyBytes: z
      .number()
      .int()
      .min(0)
      .max(25 * 1024 * 1024),
  })
  .strict();
export type ChannelRoute = z.infer<typeof ChannelRouteSchema>;

const IdentityShapeSchema = z
  .object({
    label: z.string().min(1).max(80),
    placeholder: z.string().max(120),
    pattern: PatternSchema,
    normalize: z.enum(CHANNEL_NORMALIZATIONS),
    /** A line under the field saying what to enter, where the label alone does not (a Telegram chat id that is a user's id). */
    help: z.string().min(1).max(200).optional(),
  })
  .strict();

export const ChannelDescriptorSchema = z
  .object({
    providerId: ChannelProviderIdSchema,
    label: z.string().min(1).max(60),
    kind: z.enum(CHANNEL_KINDS),
    /** A builtin icon name, or a PNG data URI of at most 16 KB; never SVG from a plugin. */
    icon: z
      .object({
        name: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,31}$/)
          .optional(),
        png: z
          .string()
          .max(22_000)
          .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
          .optional(),
      })
      .strict()
      .refine((icon) => (icon.name === undefined) !== (icon.png === undefined), "An icon is a name or a PNG, not both or neither")
      .optional(),
    description: z.string().min(1).max(500),
    settings: z.array(ChannelFieldSchema).max(30),
    auth: ChannelAuthSchema,
    /** How a sender looks in Allowed people, and how its messages are authenticated. */
    sender: IdentityShapeSchema.extend({ authentication: z.enum(["provider", "per-message"]) }).strict(),
    /** What `send_to`, routines and `ask_user` accept as a destination on this channel. */
    target: IdentityShapeSchema,
    ingress: z.array(ChannelRouteSchema).max(10).optional(),
    media: z
      .object({
        inboundMaxBytes: z
          .number()
          .int()
          .min(0)
          .max(100 * 1024 * 1024),
        mimeTypes: z.array(z.string().min(1).max(128)).max(50),
      })
      .strict()
      .optional(),
    sendRate: z
      .object({ perMinute: z.number().int().min(1).max(100_000), perTargetPerMinute: z.number().int().min(1).max(100_000).optional() })
      .strict()
      .optional(),
    setupHelp: z.string().max(4000).optional(),
    /**
     * Pages setting it up starts at (the bot maker, a developer portal), each opened in a tab of its own. A page shows
     * one only on a host its channel declares — its `hosts` or its pairing link's — so a descriptor sends nobody elsewhere.
     */
    setupLinks: z
      .array(z.strictObject({ label: z.string().min(1).max(60), url: HttpsUrlSchema.max(512) }))
      .max(3)
      .optional(),
    /** What Ideas may offer while a connection of it is enabled in a workspace (`messaging` for a chat channel). */
    proves: z.array(IdeaPluginCapabilitySchema).max(4).optional(),
    /**
     * How a person links on this channel beyond sending `/link <code>`: a deep link that opens the chat with the
     * account and hands it the code (shown as a QR code too). `{account}` is the connection's account handle, read
     * from its test's setup link (what follows the template's text before `{account}`); `{code}` is the code.
     */
    pairing: z
      .strictObject({
        deepLinkTemplate: z
          .string()
          .max(512)
          .regex(/^https:\/\/[^\s{}]+\{account\}[^\s{}]*\{code\}[^\s{}]*$/, "an https address with {account}, then {code}, in it"),
        /** The link's words, e.g. "Open in Telegram". */
        openLabel: z.string().min(1).max(60),
      })
      .optional(),
    /**
     * What a connection's account is called (its `accountIdentity`: the address
     * an email channel sends from): a setting's value, else `fallback` with
     * `{key}` replaced by that setting's value. Absent: the channel's label.
     */
    account: z
      .object({ setting: z.string().regex(FIELD_KEY).optional(), fallback: z.string().min(1).max(200).optional() })
      .strict()
      .optional(),
    /**
     * How the channel presents as an app in Connected apps: its channel's
     * own words, so core names no channel. Absent: its label and description.
     */
    app: ChannelAppSchema.optional(),
    /**
     * The channel's group policy: what happens to an unbound sender's group
     * message and to a room
     * nobody listed, and the trigger a new room starts with. Absent: groups
     * behave as before the seam (held, admitted).
     */
    groups: ChannelGroupPolicySchema.optional(),
    /** The hosts the channel reaches: its Connected apps egress and its review's address list. */
    hosts: z.array(ChannelHostSchema).max(16).optional(),
    /** What removing a connection does to what it brought in. Absent: `keep`. */
    retention: z.enum(CHANNEL_RETENTIONS).optional(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    const secretKeys = descriptor.auth.kind === "none" ? [] : (descriptor.auth.fields ?? []).map((field) => field.key);
    const keys = [...descriptor.settings.map((field) => field.key), ...secretKeys];
    // A secret and a setting sharing a key would let one be saved as the other.
    if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Setting and secret keys must be unique" });
    const routes = (descriptor.ingress ?? []).map((route) => route.name);
    if (new Set(routes).size !== routes.length) context.addIssue({ code: "custom", message: "Ingress route names must be unique" });
    // The host sends a plugin's client secret to the plugin's own token address: it may name only its own, never another credential.
    const client = descriptor.auth.kind === "oauth2" ? descriptor.auth.oauth.client : undefined;
    if (
      client?.source === "plugin" &&
      client.clientSecretRef !== undefined &&
      client.clientSecretRef !== pluginClientSecretRef(descriptor.providerId)
    ) {
      context.addIssue({
        code: "custom",
        message: `A plugin's OAuth client secret is kept at ${pluginClientSecretRef(descriptor.providerId)}, not ${client.clientSecretRef}`,
      });
    }
  });
export type ChannelDescriptor = z.infer<typeof ChannelDescriptorSchema>;

/** A connection's account name from its settings, as its descriptor's `account` says. */
export function channelAccountOf(descriptor: ChannelDescriptor, settings: Readonly<Record<string, unknown>>): string {
  const named = descriptor.account?.setting === undefined ? undefined : settings[descriptor.account.setting];
  if (typeof named === "string" && named.trim() !== "") return named.trim();
  const fallback = descriptor.account?.fallback;
  if (fallback === undefined) return descriptor.label;
  return fallback.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_whole, key: string) => String(settings[key] ?? ""));
}

/** Normalizes a sender id or target the way a descriptor says; `undefined` when an `e164` value has no digits to keep. */
export function normalizeChannelIdentity(value: string, normalize: ChannelNormalization): string | undefined {
  const trimmed = value.trim();
  if (normalize === "lowercase") return trimmed.toLowerCase();
  if (normalize === "e164") {
    // Only an international number is accepted: a leading `+` or `00`. A
    // national number (`4155550100`) has no country code to infer, and
    // guessing one would name someone else's number.
    const compact = trimmed.replace(/[\s().-]/g, "");
    const international = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
    return /^\+[1-9]\d{6,14}$/.test(international) ? international : undefined;
  }
  return trimmed;
}

/**
 * Whether `value`, normalized, is a valid sender id or target for the shape a
 * descriptor declares — the pattern is matched whole, never as a substring.
 * Returns the normalized value, or `undefined` when it is not valid.
 */
export function channelIdentity(
  value: string,
  shape: { readonly pattern: string; readonly normalize: ChannelNormalization },
): string | undefined {
  const normalized = normalizeChannelIdentity(value, shape.normalize);
  if (normalized === undefined || normalized === "") return undefined;
  return new RegExp(`^(?:${shape.pattern})$`, "u").test(normalized) ? normalized : undefined;
}

/**
 * A connection the agent can send through, as it is told of it: in its
 * runtime facts each turn, and by
 * the read-only `messaging.channels` tool. Never a setting, a secret's name or
 * an OAuth state — what the agent may reach, not how it is configured.
 */
export interface ReachableChannel {
  readonly connectionId: string;
  /** The connection's own name. */
  readonly label: string;
  /** Its channel's name (`Telegram`, `Email`). */
  readonly channel: string;
  readonly kind: ChannelKind;
  /** What a send target is on this channel (`Telegram chat id`, `Email address`). */
  readonly target: string;
  /** Whether a message can carry buttons. */
  readonly buttons: boolean;
  /** Whether a message can carry a file. */
  readonly files: boolean;
  /** The longest text one message takes; a longer one is split. */
  readonly maxTextLength: number;
  /** Who `messaging.send_to` may address on it, as the operator allowlisted them; `*` is anyone. */
  readonly allowedTargets: readonly string[];
}
