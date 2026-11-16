import { isFilePart, TaviError, unsupportedFilePartReceipt } from "@tavi/contracts";
import {
  checkPartCount,
  domainOf,
  domainsAligned,
  fetchWithTimeout,
  HEADER_LINE_MAX,
  httpFailureReceipt,
  notRunning,
  parseDestination,
  readJson,
  redactedError,
  referencesHeader,
  replySubject,
  splitEmailText,
  uncertainReceipt,
} from "@tavi/channel-kit";
import { z } from "zod";

import { GOOGLE_CALENDAR_SCOPES } from "./calendar.js";

import type {
  ChannelDescriptor,
  InboundEvent,
  MessagingCapabilities,
  MessagingConnection,
  MessagingConnectionStatus,
  MessagingConnectorDefinition,
  MessagingConnectorInstance,
  MessagingCredentials,
  MessagingInboundHandler,
  OutboundMessage,
  SendOutcome,
} from "@tavi/contracts";
import { errorMessage, nowTimestamp, retryAfterMs } from "@tavi/contracts/util";

/**
 * Gmail as a messaging channel.
 *
 * **A conversation transport, not inbox access.** Only messages carrying the
 * connection's label (`tavi` by default) are read, so the whole inbox is never
 * fed to the agent; the agent gets no way to search or read the mailbox
 * through this channel. Each message taken in is labelled processed
 * (`<label>-processed`), so it is read once and the inbox shows what was.
 *
 * **Sending goes out as the person who connected it**, from their address,
 * into their Sent folder, threaded as a reply where it is one. `send_to`
 * through Gmail needs an explicit destination grant like any channel's.
 *
 * Signing in is the host's: this connector only asks
 * `credentials.accessToken()`, and never sees the refresh token or the
 * OAuth app.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Messages read in one poll at most; the next poll takes the rest. */
const POLL_BATCH = 20;
const EMAIL_PATTERN = "[^\\s<>@]+@[^\\s<>@]+\\.[^\\s<>@]+";

export interface GmailConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => string;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  /** The Gmail API base; a fake provider in tests. */
  readonly apiBaseUrl?: string;
}

const CAPABILITIES: MessagingCapabilities = {
  receiveMode: "poll",
  send: true,
  editOrProgress: false,
  formats: ["plain"],
  // Text only in this release: no attachment is sent or taken in.
  attachments: false,
  maxAttachmentBytes: 0,
  maxPartsPerMessage: 1,
  threads: true,
  interactions: false,
  deliveryReceipts: false,
  maxTextLength: 100_000,
  // A reply carrying the round's token in its subject decides it.
  approvals: "reply-token",
};

/** A Gmail label name as the search query takes it: no quote or backslash, which would end it. */
const LABEL_PATTERN = '[^\\s"\\\\][^"\\\\\\r\\n]{0,99}';

export const GmailConfigSchema = z
  .object({
    label: z
      .string()
      .regex(new RegExp(`^${LABEL_PATTERN}$`, "u"), "A label name has no quote or backslash")
      .optional(),
    /** Off, the account takes no mail in: it only carries its mailbox's and calendar's tools, and never asks Gmail for anything. */
    receive: z.boolean().optional(),
  })
  .passthrough();

const GmailDestinationSchema = z.object({
  to: z.string().min(3).max(320),
  subject: z.string().min(1).max(998),
  /** The Gmail thread a reply goes into. */
  threadId: z.string().min(1).max(128).optional(),
  inReplyTo: z.string().min(1).max(998).optional(),
  references: z.string().min(1).max(998).optional(),
  /** The conversation it answers, so the outbox row is erased with it. Never sent. */
  conversationId: z.string().min(1).max(256).optional(),
});
type GmailDestination = z.infer<typeof GmailDestinationSchema>;

/**
 * What Gmail is to core: an email channel that
 * signs in with Google (an OAuth app of the operator's own), takes in only
 * labelled mail, and whose senders are authenticated per message.
 */
export const GMAIL_CHANNEL_DESCRIPTOR: ChannelDescriptor = {
  providerId: "gmail",
  label: "Gmail",
  kind: "email",
  icon: { name: "mail" },
  description: "Email the agent through your own Gmail account: it reads only mail you label, and replies from your address.",
  settings: [
    {
      key: "label",
      label: "Label to read",
      type: "string",
      default: "tavi",
      pattern: LABEL_PATTERN,
      help: "Only mail with this Gmail label reaches the agent; give it with a filter (for example, mail to you+tavi@gmail.com). Each message read is labelled <label>-processed.",
    },
    {
      key: "receive",
      label: "Reach Tavi by email",
      type: "boolean",
      default: true,
      help: "Take in mail with the label, and answer it from your address. Off, the account only carries its mailbox's and calendar's tools.",
    },
  ],
  // Where its calls go besides its token host: the mailbox and the channel, the calendar, and who signed in.
  hosts: ["gmail.googleapis.com", "www.googleapis.com", "openidconnect.googleapis.com"],
  auth: {
    kind: "oauth2",
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
      // Who signed in, and nothing more, until something that needs more is on. Google answers with the email
      // scope's full name, so it is asked for by that name: a short `email` would read as never granted.
      scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
      optInScopes: {
        // Taking mail in, or its mailbox's tools: read and label the mail, and send as you; nothing broader.
        mail: ["https://www.googleapis.com/auth/gmail.modify"],
        // Its calendar's tools: its list, free or busy, and events.
        calendar: [...GOOGLE_CALENDAR_SCOPES],
      },
      pkce: true,
      // Without these Google issues no refresh token.
      extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
      client: { source: "operator" },
      redirect: "loopback-any-port",
      tokenAuthMethod: "client_secret_post",
      accountIdentity: { userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo", field: "email" },
      // Google's device flow allows none of its mail or calendar scopes.
      disallowsDeviceFlow: true,
      // Google revokes a grant for every client of its Cloud project; its ids lead with the project number.
      clientProjectPattern: "^(\\d+)-[^.]+\\.apps\\.googleusercontent\\.com$",
    },
  },
  sender: {
    label: "Email address",
    placeholder: "person@example.com",
    pattern: EMAIL_PATTERN,
    normalize: "lowercase",
    authentication: "per-message",
  },
  target: { label: "Email address", placeholder: "person@example.com", pattern: EMAIL_PATTERN, normalize: "lowercase" },
  // Google's limits are per user per day; this keeps one connection well inside them.
  sendRate: { perMinute: 60, perTargetPerMinute: 20 },
  // In Connected apps: its client is the one Google's apps share, and its
  // accounts are mailboxes the agent may use, each by its own opt-in.
  app: {
    name: "Google",
    summary: "Your Google account: its calendar and Gmail, each turned on by you, and Tavi reached by email.",
    category: "email",
    publisher: "Google",
    provider: "google",
    dataClass: "personal",
    scopes: [
      {
        scope: "https://www.googleapis.com/auth/userinfo.email",
        says: "See your Google account's email address",
        access: "read",
        optional: false,
      },
      {
        scope: "https://www.googleapis.com/auth/gmail.modify",
        says: "Read and label your mail, write drafts, and send as you (only while Gmail is on)",
        access: "send",
        optional: true,
      },
      {
        scope: "https://www.googleapis.com/auth/calendar.events",
        says: "See your calendars and free time, and add or change events (only while the calendar is on)",
        access: "change",
        optional: true,
      },
    ],
    mailbox: true,
    calendar: true,
  },
  setupHelp:
    "Set up Google once from Connected apps (Set up Google): a Google Cloud project of your own with the Gmail and Calendar APIs, a published consent screen, and an OAuth client of type Desktop app, whose downloaded JSON you drop there; or enter its client ID and secret here. Your other Google apps use the same client. " +
    "An app left in Testing signs in for 7 days at a time. " +
    "Mail sent through this channel goes out as you, from your address, into your Sent folder.",
};

export interface GmailHeader {
  readonly name: string;
  readonly value: string;
}

export interface GmailPart {
  readonly mimeType?: string;
  readonly headers?: readonly GmailHeader[];
  readonly body?: { readonly data?: string; readonly size?: number };
  readonly parts?: readonly GmailPart[];
}

export interface GmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly internalDate?: string;
  readonly snippet?: string;
  readonly labelIds?: readonly string[];
  readonly payload?: GmailPart;
}

export function headerOf(headers: readonly GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function headersOf(headers: readonly GmailHeader[] | undefined, name: string): readonly string[] {
  return (headers ?? []).filter((header) => header.name.toLowerCase() === name.toLowerCase()).map((header) => header.value);
}

/**
 * The first `text/plain` body of a message, decoded; the snippet when it has
 * none (`fromSnippet`), which Gmail flattens to one line, so no quote or
 * forward in it can be told apart.
 */
export function plainTextOf(message: GmailMessage): { readonly text: string; readonly fromSnippet: boolean } {
  const visit = (part: GmailPart | undefined): string | undefined => {
    if (part === undefined) return undefined;
    if (part.mimeType === "text/plain" && part.body?.data !== undefined) return Buffer.from(part.body.data, "base64url").toString("utf8");
    for (const child of part.parts ?? []) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const plain = visit(message.payload);
  return plain !== undefined ? { text: plain, fromSnippet: false } : { text: message.snippet ?? "", fromSnippet: true };
}

/**
 * The one address of a `From` header: `Ana <ana@example.com>` →
 * `ana@example.com`. A display name's quoted text and comments are never read
 * as the address (`"<boss@example.com>" <attacker@evil.test>` is the
 * attacker), and a header naming more than one mailbox names none. Control
 * characters outside the address are left behind with the display name; an
 * address holding one names none — stripped, `bo\x00ss@` would read as `boss@`,
 * and kept, it would reach a terminal.
 */
export function addressOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  // Quoted strings (with their escapes) and comments say nothing of the address.
  const bare = header.replace(/"(?:[^"\\]|\\.)*"/g, " ").replace(/\((?:[^()\\]|\\.)*\)/g, " ");
  if (bare.includes(",")) return undefined;
  const angles = [...bare.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map((match) => match[1]);
  if (angles.length > 1) return undefined;
  const address = angles[0] ?? /^\s*([^\s<>",;]+@[^\s<>",;]+)\s*$/.exec(bare)?.[1];
  return address === undefined || /[\u0000-\u001f\u007f-\u009f]/.test(address) ? undefined : address.toLowerCase();
}

/**
 * Whether Google authenticated the message as its `From` sender, from the
 * `Authentication-Results` it added: DKIM passing for a domain aligned with
 * the From one. SPF alone is not enough — nor is `dmarc=pass`, which DMARC
 * grants on aligned SPF alone — since anyone sending through the domain's
 * SPF (a shared provider, a relay) passes it. Anything else — missing
 * results included — is not a pass.
 */
export function senderAuthenticationOf(headers: readonly GmailHeader[] | undefined, from: string): "pass" | "fail" {
  const fromDomain = domainOf(from);
  // Only the topmost results, which Google's own servers added on receipt, and only when they are Google's: a
  // sender can put any header of its own further down.
  const results = headersOf(headers, "Authentication-Results")[0];
  if (results === undefined || !/^\s*mx\.google\.com\s*;/i.test(results)) return "fail";
  // Comments repeat what the sender chose (an envelope local part, say) and quoted strings can hold anything:
  // neither may be read as a verdict, so both go before the results are read.
  let cleaned = results.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (let previous = ""; previous !== cleaned; ) {
    previous = cleaned;
    cleaned = cleaned.replace(/\((?:[^()\\]|\\.)*\)/g, " ");
  }
  for (const clause of cleaned.split(";").slice(1)) {
    // `method=result`, then its `ptype.property=value` pairs.
    const [verdict, ...rest] = clause.trim().split(/\s+/);
    const [method, result] = (verdict ?? "").toLowerCase().split("=");
    if (result !== "pass") continue;
    const properties = new Map(
      rest.flatMap((token) => {
        const match = /^([a-z]+\.[a-z-]+)=(\S+)$/i.exec(token);
        return match?.[1] === undefined || match[2] === undefined ? [] : [[match[1].toLowerCase(), match[2].toLowerCase()] as const];
      }),
    );
    // Only a DKIM signature by a domain aligned with the From one: `spf=pass` and `dmarc=pass` both hold for
    // SPF-only mail, which anyone sending through the domain's SPF can produce.
    const signer = method === "dkim" ? (properties.get("header.d") ?? properties.get("header.i")) : undefined;
    if (signer !== undefined && domainsAligned(domainOf(`x@${signer.replace(/^.*@/, "")}`), fromDomain)) return "pass";
  }
  return "fail";
}

/** A message as the host takes it in; `undefined` for one with no sender to name. */
export function toInboundEvent(connectionId: string, message: GmailMessage, receivedAt: string): InboundEvent | undefined {
  const headers = message.payload?.headers;
  const from = addressOf(headerOf(headers, "From"));
  if (from === undefined) return undefined;
  const messageId = headerOf(headers, "Message-ID") ?? headerOf(headers, "Message-Id");
  const inReplyTo = headerOf(headers, "In-Reply-To");
  const references = (headerOf(headers, "References") ?? "").split(/\s+/).filter((entry) => entry !== "");
  const subject = headerOf(headers, "Subject");
  const occurred = message.internalDate === undefined ? receivedAt : new Date(Number(message.internalDate)).toISOString();
  const { text: content, fromSnippet } = plainTextOf(message);
  // A snippet is wholly unparsed: its quote and forward markers were flattened away.
  const quotedRanges = fromSnippet
    ? content.trim() === ""
      ? []
      : [{ start: 0, end: content.length, kind: "unparsed" as const }]
    : splitEmailText(content);
  return {
    connectionId,
    // Gmail's own id for the message in this mailbox: a redelivery is the same event.
    providerEventId: `gmail:${message.id}`,
    kind: "message",
    externalSenderId: from,
    // The Gmail thread is the conversation: a reply in it continues its task.
    externalConversationId: `gmail-thread:${message.threadId}`,
    conversationKind: "thread",
    ...(messageId === undefined ? {} : { externalMessageId: messageId }),
    ...(inReplyTo === undefined ? {} : { externalReplyToId: inReplyTo }),
    ...(references.length === 0 ? {} : { externalReferences: references }),
    occurredAt: occurred,
    receivedAt,
    content,
    // Which parts are not the sender's own words: a quoted reply, a forward. Core labels them.
    ...(quotedRanges.length === 0 ? {} : { quotedRanges }),
    ...(subject === undefined ? {} : { subject }),
    senderAuthentication: senderAuthenticationOf(headers, from),
  };
}

/** A header value with no line break in it: nothing a value carries can add a header of its own. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** An RFC 2047 encoded word for a header that is not plain ASCII. */
function encodedHeader(value: string): string {
  const safe = headerSafe(value);
  return /^[\x20-\x7e]*$/.test(safe) ? safe : `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

/** The message as Gmail's `messages.send` takes it: RFC 5322, base64url. */
export function rawMessage(input: {
  readonly from: string;
  readonly to: string;
  readonly cc?: string;
  readonly subject: string;
  readonly text: string;
  readonly inReplyTo?: string;
  readonly references?: string;
}): string {
  const lines = [
    `From: ${headerSafe(input.from)}`,
    `To: ${headerSafe(input.to)}`,
    ...(input.cc === undefined || input.cc === "" ? [] : [`Cc: ${headerSafe(input.cc)}`]),
    `Subject: ${encodedHeader(input.subject)}`,
    ...(input.inReplyTo === undefined ? [] : [`In-Reply-To: ${headerSafe(input.inReplyTo)}`]),
    ...(input.references === undefined ? [] : [`References: ${headerSafe(input.references)}`]),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.text, "utf8")
      .toString("base64")
      .replace(/(.{76})/g, "$1\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export function createGmailConnectorDefinition(options: GmailConnectorOptions = {}): MessagingConnectorDefinition {
  return {
    providerId: "gmail",
    version: "1.0.0",
    configSchema: GmailConfigSchema,
    capabilities: CAPABILITIES,
    createConnection: ({ connection, config, credentials }) => {
      if (credentials === undefined) throw new TaviError("INTERNAL", "the host gives every connector its credentials");
      return createGmailConnectorInstance(connection, config as z.infer<typeof GmailConfigSchema>, credentials, options);
    },
    // A reply goes into the same Gmail thread, to the person who wrote, `Re:` their subject.
    destinationFromInbound: (replyTo) => ({
      conversationId: replyTo.externalConversationId,
      to: replyTo.externalSenderId,
      subject: replySubject(replyTo.subject),
      ...(replyTo.externalConversationId.startsWith("gmail-thread:")
        ? { threadId: replyTo.externalConversationId.slice("gmail-thread:".length) }
        : {}),
      ...(replyTo.externalMessageId === undefined
        ? {}
        : {
            inReplyTo: replyTo.externalMessageId,
            references: referencesHeader([...(replyTo.externalReferences ?? []), replyTo.externalMessageId]),
          }),
    }),
    // A send that answers nothing starts a thread of its own.
    destinationFor: (target) => ({
      to: target.to,
      subject:
        target.subject === undefined || target.subject.trim() === "" ? "A message from Tavi" : target.subject.slice(0, HEADER_LINE_MAX),
      ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
      ...(target.replyToId === undefined ? {} : { inReplyTo: target.replyToId, references: target.replyToId }),
    }),
    paceTargetOf: (destination) => {
      const parsed = GmailDestinationSchema.safeParse(destination);
      return parsed.success ? parsed.data.to.toLowerCase() : undefined;
    },
  };
}

function createGmailConnectorInstance(
  connection: MessagingConnection,
  config: z.infer<typeof GmailConfigSchema>,
  credentials: MessagingCredentials,
  options: GmailConnectorOptions,
): MessagingConnectorInstance {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? nowTimestamp;
  const api = options.apiBaseUrl ?? API;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const label = config.label ?? "tavi";
  const processedLabel = `${label}-processed`;
  let status: MessagingConnectionStatus = { state: "stopped", since: now() };
  let handler: MessagingInboundHandler | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;
  let processedLabelId: string | undefined;
  let polling: Promise<void> = Promise.resolve();

  /** One Gmail API call with the access token (asked for when not given); its errors never carry the token. */
  async function call(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
    given?: string,
  ): Promise<{ readonly response: Response; readonly body: unknown }> {
    const token = given ?? (await credentials.accessToken());
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${api}${path}`,
        {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            authorization: `Bearer ${token}`,
            accept: "application/json",
          },
        },
        timeoutMs,
        signal,
      );
      return { response, body: await readJson(response) };
    } catch (error) {
      throw new Error(redactedError(error, [token]));
    }
  }

  /** The id of the label processed mail is moved under, made when it does not exist yet. */
  async function ensureProcessedLabel(signal: AbortSignal): Promise<string> {
    if (processedLabelId !== undefined) return processedLabelId;
    const listed = await call("/labels", {}, signal);
    const labels = (listed.body as { labels?: readonly { id: string; name: string }[] } | undefined)?.labels ?? [];
    const existing = labels.find((candidate) => candidate.name === processedLabel);
    if (existing !== undefined) return (processedLabelId = existing.id);
    const created = await call(
      "/labels",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: processedLabel, labelListVisibility: "labelShow", messageListVisibility: "show" }),
      },
      signal,
    );
    const id = (created.body as { id?: unknown } | undefined)?.id;
    if (!created.response.ok || typeof id !== "string")
      throw new Error(`Gmail did not make the label ${processedLabel} (HTTP ${created.response.status})`);
    return (processedLabelId = id);
  }

  /** One poll: each labelled, unprocessed message is taken in, then marked processed. A failure leaves it for the next. */
  async function poll(signal: AbortSignal): Promise<void> {
    const labelled = await ensureProcessedLabel(signal);
    const query = encodeURIComponent(`label:"${label}" -label:"${processedLabel}"`);
    const listed = await call(`/messages?q=${query}&maxResults=${POLL_BATCH}`, {}, signal);
    if (!listed.response.ok) throw new Error(`Gmail did not list messages (HTTP ${listed.response.status})`);
    const messages = (listed.body as { messages?: readonly { id: string }[] } | undefined)?.messages ?? [];
    for (const { id } of messages) {
      signal.throwIfAborted();
      const fetched = await call(`/messages/${encodeURIComponent(id)}?format=full`, {}, signal);
      if (!fetched.response.ok) continue;
      const event = toInboundEvent(connection.connectionId, fetched.body as GmailMessage, now());
      // Recorded first: a message is marked processed only once the host has it. One the host did not take is
      // left unmarked for the next poll, and the rest still go on.
      if (event !== undefined && handler !== undefined) {
        try {
          await handler(event);
        } catch {
          continue;
        }
      }
      await call(
        `/messages/${encodeURIComponent(id)}/modify`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addLabelIds: [labelled] }) },
        signal,
      );
    }
  }

  function schedule(delayMs = pollIntervalMs): void {
    const signal = abort?.signal;
    if (signal === undefined || signal.aborted) return;
    timer = setTimeout(() => {
      polling = poll(signal)
        .then(
          () => {
            if (status.state !== "running") status = { state: "running", since: now() };
          },
          (error: unknown) => {
            if (!signal.aborted)
              status = { state: "running", detail: `last check failed: ${errorMessage(error)}`.slice(0, 300), since: now() };
          },
        )
        .finally(() => schedule());
    }, delayMs);
    timer.unref?.();
  }

  return {
    async start() {
      // Not taking mail in: nothing to read, label or answer, and nothing to ask Gmail.
      if (config.receive === false) {
        status = { state: "running", detail: "not taking mail in", since: now() };
        return;
      }
      status = { state: "starting", since: now() };
      abort = new AbortController();
      try {
        // Signed in, and the account it signed in as: a failed start says why.
        const profile = await call("/profile", {}, abort.signal);
        if (!profile.response.ok)
          throw new TaviError("UNAVAILABLE", `Gmail did not answer for this account (HTTP ${profile.response.status})`);
        // The mailbox it signed in to, and no other: its people, threads and replies are that account's.
        const address = (profile.body as { emailAddress?: unknown } | undefined)?.emailAddress;
        if (
          typeof address === "string" &&
          connection.accountIdentity.includes("@") &&
          address.toLowerCase() !== connection.accountIdentity.toLowerCase()
        ) {
          throw new TaviError(
            "CONFLICT",
            `Gmail answers as ${address}, but this connection is ${connection.accountIdentity}: disconnect it and connect again`,
          );
        }
        await ensureProcessedLabel(abort.signal);
      } catch (error) {
        status = { state: "failed", detail: errorMessage(error), since: now() };
        abort.abort();
        throw error;
      }
      status = { state: "running", since: now() };
      // The first check comes once this has answered: a message it takes in starts a turn whose reply needs the connection open.
      schedule(0);
    },
    async stop() {
      abort?.abort();
      if (timer !== undefined) clearTimeout(timer);
      // Stopping: the poll loop reports its own failures as it runs.
      await polling.catch(() => undefined);
      status = { state: "stopped", since: now() };
    },
    status: () => status,
    async probe() {
      // Not taking mail in: there is nothing of Gmail's to check, and it may not be allowed to read mail at all.
      if (config.receive === false) return { ok: true, detail: "not taking mail in" };
      try {
        const profile = await call("/profile");
        return profile.response.ok ? { ok: true } : { ok: false, detail: `HTTP ${profile.response.status}` };
      } catch (error) {
        return { ok: false, detail: errorMessage(error) };
      }
    },
    async send(message: OutboundMessage): Promise<SendOutcome> {
      if (status.state !== "running") throw notRunning("Gmail", connection.connectionId, status.state);
      if (config.receive === false)
        throw new TaviError(
          "UNSUPPORTED",
          "this Google account does not take mail in, so it sends nothing as a channel: turn Reach Tavi by email on",
        );
      checkPartCount(message, CAPABILITIES.maxPartsPerMessage, "Gmail");
      const destination: GmailDestination = parseDestination(GmailDestinationSchema, message, "Gmail");
      const part = message.parts[0];
      if (part === undefined) throw new TaviError("INVALID_INPUT", "Gmail send has no part");
      if (isFilePart(part)) return { status: "rejected", retryable: false, parts: [unsupportedFilePartReceipt("gmail", 0)] };
      const raw = rawMessage({
        from: connection.accountIdentity,
        to: destination.to,
        subject: destination.subject,
        text: part.content,
        ...(destination.inReplyTo === undefined ? {} : { inReplyTo: destination.inReplyTo }),
        ...(destination.references === undefined ? {} : { references: destination.references }),
      });
      // The token first: a sign-in that cannot answer sent nothing, and the send may be made again.
      let token: string;
      try {
        token = await credentials.accessToken();
      } catch (error) {
        throw new TaviError("UNAVAILABLE", errorMessage(error));
      }
      let sent: { readonly response: Response; readonly body: unknown };
      try {
        sent = await call(
          "/messages/send",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ raw, ...(destination.threadId === undefined ? {} : { threadId: destination.threadId }) }),
          },
          undefined,
          token,
        );
      } catch (error) {
        // In flight when it failed: it may have gone out, and is never sent again.
        return { status: "uncertain", retryable: false, parts: [uncertainReceipt(0, errorMessage(error))] };
      }
      const id = (sent.body as { id?: unknown } | undefined)?.id;
      if (sent.response.ok && typeof id === "string")
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: id }] };
      const receipt = httpFailureReceipt(0, sent.response.status, `Gmail answered HTTP ${sent.response.status}`);
      return {
        status: receipt.status,
        retryable: false,
        // Seconds or an HTTP date, as Gmail may send either; a minute when it sends neither.
        ...(sent.response.status === 429 ? { retryAfterMs: retryAfterMs(sent.response.headers.get("retry-after"), now()) } : {}),
        parts: [receipt],
      };
    },
    onInboundEvent(next) {
      handler = next;
    },
  };
}
