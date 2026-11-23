import { isFilePart, TaviError, unsupportedFilePartReceipt } from "@tavi/contracts";
import {
  checkPartCount,
  fetchWithTimeout,
  HEADER_LINE_MAX,
  httpFailureReceipt,
  notRunning,
  parseDestination,
  readJson,
  redactedError,
  redactSecrets,
  referencesHeader,
  replySubject,
  uncertainReceipt,
} from "@tavi/channel-kit";
import { z } from "zod";

import { createMailgunIngress, DEFAULT_MAX_BODY_BYTES } from "./webhook.js";

import type {
  ChannelDescriptor,
  InboundEvent,
  MessagingCapabilities,
  MessagingConnection,
  MessagingConnectionStatus,
  MessagingConnectorDefinition,
  MessagingConnectorInstance,
  MessagingCredentials,
  OutboundMessage,
  SendOutcome,
} from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { nowTimestamp } from "@tavi/contracts/util";

/**
 * Real Mailgun `MessagingConnectorPort` adapter — outbound send here;
 * inbound is webhook-driven and deliberately NOT wired through this file's
 * `onInboundEvent` — see this module's own header note below.
 *
 * **Raw HTTP, no SDK dependency**, mirroring `@tavi/plugin-telegram`'s
 * identical choice: `POST /v3/<domain>/messages` with HTTP Basic auth
 * (`api` / the API key), form-encoded body, over an injectable `fetch`.
 *
 * **`onInboundEvent` is a real, satisfied part of this contract but is
 * never called from inside this file.** Mailgun's inbound path is
 * push-based (a webhook POST), not a poll loop this connector owns —
 * `packages/builtin/mailgun/src/webhook.ts`'s handler calls
 * `MessagingServicePort.ingest(event)` directly once composed
 * (`apps/cli/src/runtime/composition.ts`), bypassing the connector-instance
 * `onInboundEvent` mechanism entirely for this provider.
 * `MessagingService.openConnection` registers `ingest` through that
 * method on every connection, this one included, so it is implemented and
 * the registration is accepted — and ignored, because it is never the
 * delivery path Mailgun uses.
 *
 * **Two secrets, not one**: `credentials.get("apiKey")` answers the API
 * key (outbound send); `credentials.get("webhookSigningKey")` the webhook
 * signing key (inbound HMAC verification, `webhook.ts`). Both are the
 * descriptor's secret fields, read through the injected `credentials`;
 * neither is ever logged or included in a thrown error's message.
 */

/** Mailgun's API for each region a domain can be created in; a connection's `region` setting picks one, and nothing else. */
const MAILGUN_API_BASE_URLS = { us: "https://api.mailgun.net/v3", eu: "https://api.eu.mailgun.net/v3" } as const;

export interface MailgunConnectorOptions {
  /** Injected transport — tests substitute a fake here; production supplies the real `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => string;
  /** Replaces the connection's region's API address: tests point it at a fake. */
  readonly apiBaseUrl?: string;
  /**
   * How long one API request may take before it is abandoned (default 30 s).
   * Without it a hung send would stay pending in the outbox for good; an
   * abandoned send is `uncertain`.
   */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const CAPABILITIES: MessagingCapabilities = {
  receiveMode: "webhook",
  send: true,
  editOrProgress: false,
  formats: ["plain"],
  // Text-only outbound — no MIME attachment publication.
  attachments: false,
  maxAttachmentBytes: 0,
  maxPartsPerMessage: 1,
  threads: false,
  interactions: false,
  // Delivery-status webhooks are not taken.
  deliveryReceipts: false,
  // A conservative bound on one email's text body, well under Mailgun's 25 MB message cap.
  maxTextLength: 100_000,
  // A reply carrying the round's token in its subject decides it.
  approvals: "reply-token",
};

export const MailgunConfigSchema = z.object({
  domain: z.string().min(1).max(253),
  /** The region the domain was created in; absent (a connection saved before it existed) is `us`. */
  region: z.enum(["us", "eu"]).optional(),
});

const MailgunDestinationSchema = z.object({
  to: z.string().min(1).max(998),
  from: z.string().min(1).max(998),
  subject: z.string().min(1).max(998),
  /**
   * Threading headers (RFC 5322) — set on a reply so mail clients group it
   * with the original message instead of rendering it as a new,
   * unthreaded conversation (a generic reply subject alone does not
   * thread reliably; most clients
   * key on these headers first and only fall back to subject matching).
   * Both optional — an outbound message with no originating inbound
   * event (e.g. an operator-initiated send) has neither.
   */
  inReplyTo: z.string().min(1).max(998).optional(),
  references: z.string().min(1).max(998).optional(),
  /**
   * The email thread this reply belongs to (the inbound event's
   * `externalConversationId`). Never sent to Mailgun: it is what lets the
   * outbox row be found and erased with its conversation's transcript, which
   * matches on `destination.conversationId`.
   */
  conversationId: z.string().min(1).max(256).optional(),
});

interface MailgunSendSuccess {
  readonly id: string;
  readonly message: string;
}

interface MailgunApiError {
  readonly message: string;
}

export function createMailgunConnectorDefinition(options: MailgunConnectorOptions = {}): MessagingConnectorDefinition {
  return {
    providerId: "mailgun",
    version: "1.0.0",
    configSchema: MailgunConfigSchema,
    capabilities: CAPABILITIES,
    createConnection: ({ connection, config, credentials }) =>
      createMailgunConnectorInstance(connection, config as z.infer<typeof MailgunConfigSchema>, credentials, options),
    // Inbound mail arrives as webhooks through the host's ingress.
    ingress: createMailgunIngress(),
    // Unlike Telegram, Mailgun's own "conversation" id (`externalConversationId`,
    // the bot's receiving address and a digest of the thread — see `inbound.ts`) is useless as a
    // reply target; a reply must go `to:` the original human sender
    // (`externalSenderId`), `from:` this specific connection's own
    // sending address (`connection.accountIdentity`), matching this file's
    // own MailgunDestinationSchema shape exactly.
    destinationFromInbound: (replyTo, connection) => ({
      conversationId: replyTo.externalConversationId,
      to: replyTo.externalSenderId,
      from: connection.accountIdentity,
      // `Re:` the message's own subject; the
      // In-Reply-To/References headers below are what actually thread the
      // reply in a mail client, subject matching only a fallback.
      subject: replySubject(replyTo.subject),
      ...(replyTo.externalMessageId === undefined
        ? {}
        : {
            inReplyTo: replyTo.externalMessageId,
            // `References` is the full ancestor chain, not just the
            // immediate parent — `In-Reply-To` alone only threads one
            // level deep. `externalReferences` (this inbound message's own
            // `References` header, oldest first) already names every
            // ancestor before it; appending this message's own id extends
            // the chain by one, the same way a real mail client does.
            references: referencesHeader([...(replyTo.externalReferences ?? []), replyTo.externalMessageId]),
          }),
    }),
    // A send that answers nothing starts its own thread, from this connection's address.
    destinationFor: (target, connection) => ({
      to: target.to,
      from: connection.accountIdentity,
      subject: subjectOr(target.subject, "A message from Tavi"),
      ...(target.replyToId === undefined ? {} : { inReplyTo: target.replyToId, references: target.replyToId }),
    }),
  };
}

/** A subject given and not blank, cut to RFC 5322's line limit; `fallback` otherwise. */
function subjectOr(subject: string | undefined, fallback: string): string {
  return subject === undefined || subject.trim() === "" ? fallback : subject.slice(0, HEADER_LINE_MAX);
}

const EMAIL_PATTERN = "[^\\s<>@]+@[^\\s<>@]+\\.[^\\s<>@]+";

/**
 * What Mailgun email is to core: an email
 * channel whose senders are authenticated per message (SPF/DKIM),
 * configured with a sending domain and two keys, receiving through one
 * webhook route. Its words a person reads are `t`'s (English by default), for
 * the workspace's language.
 */
export function mailgunChannelDescriptor(t: CoreT = coreEnglish): ChannelDescriptor {
  return {
    app: {
      name: t("plugins.mailgun.app.name"),
      summary: t("plugins.mailgun.app.summary"),
      category: "email",
      publisher: "Mailgun",
      scopes: [],
    },
    providerId: "mailgun",
    label: t("plugins.mailgun.label"),
    kind: "email",
    icon: { name: "mail" },
    description: t("plugins.mailgun.description"),
    settings: [
      {
        key: "domain",
        label: t("plugins.mailgun.domain.label"),
        type: "string",
        required: true,
        pattern: "(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?",
      },
      { key: "from", label: t("plugins.mailgun.from.label"), type: "string", help: t("plugins.mailgun.from.help") },
      {
        key: "region",
        label: t("plugins.mailgun.region.label"),
        type: "choice",
        choices: ["us", "eu"],
        default: "us",
        help: t("plugins.mailgun.region.help"),
      },
    ],
    hosts: ["api.mailgun.net", "api.eu.mailgun.net"],
    auth: {
      kind: "secrets",
      fields: [
        { key: "apiKey", label: t("plugins.mailgun.apiKey.label"), help: t("plugins.mailgun.apiKey.help") },
        {
          key: "webhookSigningKey",
          label: t("plugins.mailgun.signingKey.label"),
          help: t("plugins.mailgun.signingKey.help"),
        },
      ],
    },
    sender: {
      label: t("plugins.mailgun.address"),
      placeholder: "person@example.com",
      pattern: EMAIL_PATTERN,
      normalize: "lowercase",
      authentication: "per-message",
    },
    target: { label: t("plugins.mailgun.address"), placeholder: "person@example.com", pattern: EMAIL_PATTERN, normalize: "lowercase" },
    // Mailgun's inbound route posts the whole message, attachments included.
    ingress: [{ name: "inbound", methods: ["POST"], scope: "connection", maxBodyBytes: DEFAULT_MAX_BODY_BYTES }],
    // An email's attached files arrive in the inbound request, so its body cap is theirs too: a video and its mail share it.
    media: { inboundMaxBytes: DEFAULT_MAX_BODY_BYTES, mimeTypes: ["image/*", "application/pdf", "text/plain", "audio/*", "video/*"] },
    // A connection sends from its `from` setting, or tavi@<domain>.
    account: { setting: "from", fallback: "tavi@{domain}" },
    setupHelp: t("plugins.mailgun.setupHelp"),
  };
}

export const MAILGUN_CHANNEL_DESCRIPTOR: ChannelDescriptor = mailgunChannelDescriptor();

function createMailgunConnectorInstance(
  connection: MessagingConnection,
  config: z.infer<typeof MailgunConfigSchema>,
  credentials: MessagingCredentials,
  options: MailgunConnectorOptions,
): MessagingConnectorInstance {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const now = options.now ?? nowTimestamp;
  const apiBaseUrl = options.apiBaseUrl ?? MAILGUN_API_BASE_URLS[config.region ?? "us"];

  let status: MessagingConnectionStatus = { state: "stopped", since: now() };
  let apiKey: string | undefined;

  // Unlike Telegram (whose bot token is embedded in the request URL, and so
  // needs `redactToken`-style scrubbing against a leaky injected `fetch`),
  // Mailgun's API key lives only in this header — never a URL or query string.
  // That is not the same as "no scrubbing needed": an echoing provider, a local
  // proxy, or a leaky `fetch` returns the request in the error body, and the
  // message is recorded verbatim in the outbox. So every
  // error that leaves this connector goes through the same redaction Telegram
  // uses.
  function authHeader(): string {
    return `Basic ${Buffer.from(`api:${apiKey}`, "utf8").toString("base64")}`;
  }

  /**
   * Remove the key from anything that will be stored or shown.
   *
   * The literal form is not the form it travels in: this connector sends
   * `authorization: Basic base64("api:" + key)`, so an echoing endpoint returns
   * the base64, and a `split(key)` finds nothing. Both
   * renderings are removed, along with the URL-encoded base64 a query string or a
   * proxy log would carry.
   */
  function redactApiKey(message: string): string {
    return redactSecrets(message, [apiKey], ["api"]);
  }

  /** A thrown fetch error is re-thrown with the key removed, as every send error already is. */
  async function verifyDomain(): Promise<Response> {
    try {
      return await fetchWithTimeout(
        fetchImpl,
        `${apiBaseUrl}/domains/${encodeURIComponent(config.domain)}`,
        { method: "GET", headers: { authorization: authHeader() } },
        requestTimeoutMs,
      );
    } catch (error) {
      throw new Error(redactedError(error, [apiKey], ["api"]));
    }
  }

  return {
    async start(): Promise<void> {
      status = { state: "starting", since: now() };
      const resolved = await credentials.get("apiKey");
      if (resolved === null) {
        status = { state: "failed", detail: "API key credential is absent", since: now() };
        throw new TaviError("NOT_CONFIGURED", `Mailgun connection ${connection.connectionId}'s API key credential is absent`, {
          details: { connectionId: connection.connectionId },
        });
      }
      apiKey = resolved;
      // Mail from another domain than the one it is sent through fails the
      // recipient's DMARC check: refused here, not sent and lost.
      const fromDomain = connection.accountIdentity.slice(connection.accountIdentity.lastIndexOf("@") + 1).toLowerCase();
      if (!connection.accountIdentity.includes("@") || fromDomain !== config.domain.toLowerCase()) {
        status = { state: "failed", detail: `the sender address is not on ${config.domain}`, since: now() };
        throw new TaviError(
          "NOT_CONFIGURED",
          `Mailgun connection ${connection.connectionId} sends from ${connection.accountIdentity}, which is not an address on ${config.domain}`,
          { details: { connectionId: connection.connectionId } },
        );
      }
      // Without its webhook signing key no inbound mail could be verified:
      // refused here, not left running to answer every webhook 403.
      if ((await credentials.get("webhookSigningKey")) === null) {
        status = { state: "failed", detail: "webhook signing key credential is absent", since: now() };
        throw new TaviError("NOT_CONFIGURED", `Mailgun connection ${connection.connectionId}'s webhook signing key credential is absent`, {
          details: { connectionId: connection.connectionId },
        });
      }
      const response = await verifyDomain();
      if (!response.ok) {
        status = { state: "failed", detail: `domain verification failed with status ${response.status}`, since: now() };
        throw new TaviError(
          "UNAVAILABLE",
          `Mailgun domain verification failed for connection ${connection.connectionId} (status ${response.status})`,
          {
            details: { connectionId: connection.connectionId },
          },
        );
      }
      status = { state: "running", since: now() };
    },

    async stop(): Promise<void> {
      status = { state: "stopped", since: now() };
    },

    status(): MessagingConnectionStatus {
      return status;
    },

    async probe() {
      if (status.state !== "running" || apiKey === undefined) {
        return { ok: false, detail: `connection is ${status.state}` };
      }
      const response = await verifyDomain();
      return response.ok ? { ok: true } : { ok: false, detail: `domain check failed with status ${response.status}` };
    },

    async send(message: OutboundMessage): Promise<SendOutcome> {
      if (status.state !== "running" || apiKey === undefined) throw notRunning("Mailgun", connection.connectionId, status.state);
      // Exactly one part: with `maxPartsPerMessage: 1`, a 0-part message is
      // refused too, never sent with an empty body.
      checkPartCount(message, CAPABILITIES.maxPartsPerMessage, "Mailgun");
      const part = message.parts[0];
      if (part === undefined) throw new TaviError("INVALID_INPUT", "Mailgun sends a message of exactly one part");
      const destination = parseDestination(MailgunDestinationSchema, message, "Mailgun");
      // `capabilities.attachments` is false here, so a file part is refused —
      // but as a per-part `rejected` receipt, not a thrown error. `dispatchTool`
      // resolves any thrown handler error as an `uncertain` external effect
      // (`packages/agent-host/src/workflow/dispatch.ts`), which would durably ledger a
      // knowably impossible delivery ("this connector has no attachment path")
      // as one an operator must reconcile, and would show the model a generic
      // failure instead of the specific reason. The shared helper keeps this
      // answer identical to every other connector's.
      if (isFilePart(part)) {
        return { status: "rejected", retryable: false, parts: [unsupportedFilePartReceipt("mailgun", 0)] };
      }
      const content = part.content;
      const body = new URLSearchParams({
        from: destination.from,
        to: destination.to,
        // A caller's subject wins: a round's announcement carries its token there.
        subject: subjectOr(message.subject, destination.subject),
        text: content,
      });
      // Mailgun's Messages API accepts arbitrary MIME headers via
      // `h:<Header-Name>` form fields — this is how In-Reply-To/References
      // reach the actual outgoing email (there is no dedicated API param
      // for them).
      if (destination.inReplyTo !== undefined) body.set("h:In-Reply-To", destination.inReplyTo);
      if (destination.references !== undefined) body.set("h:References", destination.references);
      let response: Response;
      try {
        response = await fetchWithTimeout(
          fetchImpl,
          `${apiBaseUrl}/${encodeURIComponent(config.domain)}/messages`,
          {
            method: "POST",
            headers: { authorization: authHeader(), "content-type": "application/x-www-form-urlencoded" },
            body: body.toString(),
          },
          requestTimeoutMs,
        );
      } catch (error) {
        // A network error or timeout means the send's outcome is genuinely unknown.
        return { status: "uncertain", retryable: true, parts: [uncertainReceipt(0, redactedError(error, [apiKey], ["api"]))] };
      }
      if (response.ok) {
        // A 2xx Mailgun did not answer in JSON says the request reached
        // something, not that the mail was queued: the outcome is unknown.
        // Thrown instead, it would leave the outbox row pending for good.
        const result = (await readJson(response)) as MailgunSendSuccess | undefined;
        if (typeof result?.id !== "string") {
          return { status: "uncertain", retryable: true, parts: [uncertainReceipt(0, `HTTP ${response.status} without a message id`)] };
        }
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: result.id }] };
      }
      const errorBody = (await readJson(response)) as MailgunApiError | undefined;
      // A 4xx is a definitive refusal, never auto-retried at this layer;
      // a 5xx leaves the outcome unknown.
      const receipt = httpFailureReceipt(0, response.status, redactApiKey(errorBody?.message ?? `HTTP ${response.status}`));
      return {
        status: receipt.status === "rejected" ? "rejected" : "uncertain",
        retryable: receipt.status !== "rejected",
        parts: [receipt],
      };
    },

    onInboundEvent(_next: (event: InboundEvent) => Promise<void>): void {
      // Intentionally a no-op: inbound mail arrives as webhooks through the
      // host's ingress (`ingress`, `webhook.ts`), which records each event
      // itself, never through this registration.
    },
  };
}
