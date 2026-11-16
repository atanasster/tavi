import { createHmac, timingSafeEqual } from "node:crypto";

import { domainOf, domainsAligned, splitEmailText } from "@tavi/channel-kit";
import { TaviError, type InboundEvent } from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

/**
 * Mailgun inbound webhook verification and field parsing — pure functions,
 * no HTTP server involved, so the security-critical signature check has
 * direct unit coverage independent of `webhook.ts`'s handler.
 *
 * **Two independent mechanisms, not one**: `verifyMailgunSignature` proves *this
 * specific POST* really came from Mailgun and isn't stale — nothing
 * about logical-event identity depends on it. `toInboundEvent` derives
 * `providerEventId` from the email's own `Message-Id` header scoped to its
 * sender (`emailEventKey`), which is stable across Mailgun's own automatic
 * retries of one delivery, unlike the per-request
 * `token`/`timestamp`/`signature` triple.
 */

export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface MailgunSignatureFields {
  readonly timestamp: string;
  readonly token: string;
  readonly signature: string;
}

export interface VerifyMailgunSignatureOptions {
  readonly signingKey: string;
  readonly fields: MailgunSignatureFields;
  readonly now: () => string;
  readonly toleranceSeconds?: number;
}

/**
 * `HMAC-SHA256(key = signing key, message = timestamp + token)`, hex
 * digest, constant-time compared against `signature` — Mailgun's real,
 * documented webhook-signing scheme. Rejects
 * before computing the HMAC at all if `timestamp` is missing, malformed,
 * or further than `toleranceSeconds` (default 300s) from `now()` — a
 * cheap staleness/DoS guard that avoids crypto work on an obviously
 * replayed or malformed request.
 */
export function verifyMailgunSignature(options: VerifyMailgunSignatureOptions): boolean {
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const timestampSeconds = Number.parseInt(options.fields.timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowMs = new Date(options.now()).getTime();
  // A malformed `now()` return must fail closed (reject), not silently
  // pass the staleness check via NaN comparison semantics.
  if (!Number.isFinite(nowMs)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) return false;

  const expected = createHmac("sha256", options.signingKey)
    .update(options.fields.timestamp + options.fields.token)
    .digest("hex");
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(options.fields.signature, "utf8");
  // `timingSafeEqual` throws on a length mismatch rather than returning
  // false — a forged/truncated signature of the wrong length is a
  // legitimate mismatch, not an error, so it's handled before the call.
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

/** One `[name, value]` pair from Mailgun's JSON-encoded `message-headers` field. */
type MessageHeaderPair = readonly [string, string];

function findHeader(headers: readonly MessageHeaderPair[], name: string): string | undefined {
  const lowerName = name.toLowerCase();
  return headers.find(([headerName]) => headerName.toLowerCase() === lowerName)?.[1];
}

function parseMessageHeaders(raw: string | undefined): readonly MessageHeaderPair[] {
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is MessageHeaderPair =>
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Mailgun's inbound routing webhook fields this connector reads — a
 * subset of what Mailgun actually sends (attachment fields are not read here).
 */
export interface MailgunInboundFields {
  readonly recipient?: string;
  /** The envelope sender (SMTP `MAIL FROM`): the address SPF checked, and the one a binding names. */
  readonly sender?: string;
  /** The `From` header, as the person's mail client shows it. */
  readonly from?: string;
  readonly subject?: string;
  readonly "body-plain"?: string;
  readonly "stripped-text"?: string;
  readonly "message-headers"?: string;
  readonly timestamp?: string;
}

/**
 * Maps Mailgun's wire fields to the generic `InboundEvent`.
 * `providerEventId` is the email's `Message-Id` header scoped to its sender (`emailEventKey`) — see this
 * module's own header comment for why, not Mailgun's per-request
 * `token`. Throws `INVALID_INPUT` when required fields (`sender`,
 * `recipient`, or a `Message-Id` header) are absent, rather than
 * inventing a synthetic identifier for the durable dedup key to rest on.
 */
export function toInboundEvent(connectionId: string, fields: MailgunInboundFields, receivedAt: string): InboundEvent {
  if (fields.sender === undefined || fields.recipient === undefined) {
    throw new TaviError("INVALID_INPUT", "Mailgun inbound webhook is missing sender/recipient fields");
  }
  const headers = parseMessageHeaders(fields["message-headers"]);
  const messageId = findHeader(headers, "Message-Id");
  if (messageId === undefined) {
    throw new TaviError("INVALID_INPUT", "Mailgun inbound webhook has no Message-Id header to use as a stable event id");
  }
  const inReplyTo = findHeader(headers, "In-Reply-To");
  // RFC 5322 `References` is a whitespace-separated list of message-ids,
  // oldest ancestor first — without it, a reply deeper than one level in
  // a thread only ever threads against its immediate parent
  // (`In-Reply-To`), losing the rest of the chain most mail clients rely
  // on to group a long thread correctly.
  const referencesHeader = findHeader(headers, "References");
  const references = referencesHeader === undefined ? [] : referencesHeader.split(/\s+/).filter((id) => id.length > 0);
  // Mailgun's own verdicts on the sender: a reply that decides a
  // round is accepted only when both SPF and DKIM pass. A forged From passes
  // neither; anything Mailgun did not check is `unknown`, not a pass.
  //
  // A sender can write headers of the same name, and where Mailgun adds none
  // of its own the sender's copy was the only one — and would read as a
  // pass. Mailgun prepends its verdicts above the `Received` line its MX
  // writes on accepting the message, and everything the sender wrote sits
  // below that line, so only the headers above the first `Received` are
  // Mailgun's. A payload with no `Received` at all has no such region, and
  // every verdict reads `unknown`; one seen twice in the region is not trusted.
  const firstReceived = headers.findIndex(([headerName]) => headerName.toLowerCase() === "received");
  const addedByMailgun = firstReceived < 0 ? [] : headers.slice(0, firstReceived);
  const verdict = (name: string): string | undefined | "ambiguous" => {
    const values = addedByMailgun.filter(([headerName]) => headerName.toLowerCase() === name.toLowerCase());
    return values.length > 1 ? "ambiguous" : values[0]?.[1].trim().toLowerCase();
  };
  const spf = verdict("X-Mailgun-Spf");
  const dkim = verdict("X-Mailgun-Dkim-Check-Result");
  const verdicts =
    spf === "pass" && dkim === "pass"
      ? "pass"
      : spf === "ambiguous" || dkim === "ambiguous"
        ? "fail"
        : spf === undefined || dkim === undefined
          ? "unknown"
          : "fail";
  // SPF passing vouches for the envelope sender's domain, which is what a
  // binding names; the From header is what the person reading sees. A From
  // whose domain is unrelated to the envelope's is the shape of a forgery, so
  // the message is not verified. Related means one domain
  // is the other or a subdomain of it — the relaxed alignment DMARC uses,
  // short of a public-suffix list.
  // Mailgun's DKIM verdict says a signature passed, not whose: it counts only when every signature the message
  // carries is for a domain aligned with the From one, so the one that passed is (DKIM d= alignment).
  const signers = headers.filter(([headerName]) => headerName.toLowerCase() === "dkim-signature").map(([, value]) => dkimDomainOf(value));
  const shownDomain = singleAddressDomain(fields.from ?? fields.sender);
  const dkimAligned =
    signers.length > 0 &&
    shownDomain !== undefined &&
    signers.every((signer) => signer !== undefined && domainsAligned(signer, shownDomain));
  const senderAuthentication = verdicts === "pass" && (!fromAligned(fields.from, fields.sender) || !dkimAligned) ? "fail" : verdicts;
  const occurredAtSeconds = fields.timestamp === undefined ? undefined : Number.parseInt(fields.timestamp, 10);
  const occurredAt =
    occurredAtSeconds !== undefined && Number.isFinite(occurredAtSeconds) ? new Date(occurredAtSeconds * 1000).toISOString() : receivedAt;

  const content = fields["stripped-text"] ?? fields["body-plain"] ?? "";
  const quotedRanges = splitEmailText(content);
  return {
    connectionId,
    providerEventId: emailEventKey(fields.sender, messageId),
    kind: "message",
    // Case-folded, as a binding's address is: `Alice@Example.com` is the
    // person allowed as `alice@example.com`.
    externalSenderId: fields.sender.toLowerCase(),
    externalConversationId: emailConversationId(fields.recipient, references[0] ?? inReplyTo ?? messageId),
    externalMessageId: messageId,
    ...(inReplyTo === undefined ? {} : { externalReplyToId: inReplyTo }),
    ...(references.length === 0 ? {} : { externalReferences: references }),
    occurredAt,
    receivedAt,
    content,
    // Which parts are not the sender's own words: `stripped-text` already drops a
    // quoted reply, so this matters for the `body-plain` fallback and for forwards. Core labels them.
    ...(quotedRanges.length === 0 ? {} : { quotedRanges }),
    // A blank subject is no subject: nothing downstream may carry an empty one.
    ...(fields.subject === undefined || fields.subject.trim() === "" ? {} : { subject: fields.subject.slice(0, 998) }),
    senderAuthentication,
    // Every email belongs to a thread, never a one-to-one chat.
    conversationKind: "thread",
  };
}

/** A `DKIM-Signature` header's signing domain (its `d=` tag), lower-cased; undefined when it names none. */
export function dkimDomainOf(header: string): string | undefined {
  const tag = /(?:^|;)\s*d\s*=\s*([^;\s]+)/i.exec(header);
  return tag?.[1]?.toLowerCase().replace(/\.$/, "");
}

/**
 * The domain of the one address a header names, bare or as
 * `Name <local@domain>`; undefined when it names none, or more than one — a
 * From listing several authors cannot be aligned with one envelope sender.
 */
function singleAddressDomain(header: string): string | undefined {
  const addresses = header.match(/[^\s<>,;"@]+@[^\s<>,;"@]+/g) ?? [];
  return addresses.length === 1 && addresses[0] !== undefined ? domainOf(addresses[0]) : undefined;
}

/**
 * Whether the From header's domain is aligned with the envelope sender's: one
 * is the other or a subdomain of it. An absent From is aligned (there is
 * nothing shown that could differ); an unparseable one is not.
 */
export function fromAligned(from: string | undefined, sender: string): boolean {
  if (from === undefined) return true;
  const fromDomain = singleAddressDomain(from);
  const senderDomain = singleAddressDomain(sender);
  if (fromDomain === undefined || senderDomain === undefined) return false;
  return fromDomain === senderDomain || fromDomain.endsWith(`.${senderDomain}`) || senderDomain.endsWith(`.${fromDomain}`);
}

/**
 * An email's dedup key. `Message-Id` alone is chosen by whoever sends the
 * mail, so one sender could pre-occupy another's id and have that person's
 * message dropped as a duplicate; scoped to the (case-folded) envelope sender,
 * a sender can only collide with themselves.
 */
export function emailEventKey(sender: string, messageId: string): string {
  return `mail:${sha256Hex(`${sender.toLowerCase()}\n${messageId}`)}`;
}

/**
 * An email thread as one conversation: the bot's receiving address
 * and a digest of the thread's first message — the oldest `References` entry,
 * else `In-Reply-To`, else the message's own id — so every email in a thread
 * reaches the same chat, and a new email starts its own. Bounded to the 256
 * characters a conversation id may have.
 */
export function emailConversationId(recipient: string, threadRoot: string): string {
  return `${recipient.slice(0, 200)}#${sha256Hex(threadRoot).slice(0, 24)}`;
}
