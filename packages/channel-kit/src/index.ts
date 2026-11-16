import type { z } from "zod";

import {
  TaviError,
  type MessagingConnectionState,
  type OutboundMessage,
  type SendOutcomePartReceipt,
  type SendOutcomeStatus,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

/**
 * What every messaging channel connector does the same way: keeping secrets out of what it
 * reports, bounding each provider request in time, reading a provider's JSON
 * without trusting it to be JSON, refusing a send it cannot make before
 * calling out, and summing per-part receipts. A connector — builtin or a
 * plugin's — uses these rather than writing its own.
 */

/**
 * `message` with every secret given removed, and the HTTP Basic form
 * (`<user>:<secret>` in base64, plain and URL-encoded) of each under the
 * users given — a fetch failure may quote a request's URL or headers, and a
 * provider's error body may echo a key.
 */
export function redactSecrets(message: string, secrets: readonly (string | undefined)[], basicUsers: readonly string[] = []): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret === undefined || secret === "") continue;
    const forms = [
      secret,
      ...basicUsers.flatMap((user) => {
        const basic = Buffer.from(`${user}:${secret}`, "utf8").toString("base64");
        return [basic, encodeURIComponent(basic)];
      }),
    ];
    for (const form of forms) redacted = redacted.split(form).join("<redacted>");
  }
  return redacted;
}

/** The text of an unknown thrown value, with the given secrets removed. */
export function redactedError(error: unknown, secrets: readonly (string | undefined)[], basicUsers: readonly string[] = []): string {
  return redactSecrets(errorMessage(error), secrets, basicUsers);
}

/**
 * A provider request that gives up after `timeoutMs` (and on `signal`): a
 * hung request would otherwise leave a send pending in the outbox for good.
 * An abandoned request rejects like any network failure.
 */
export function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const limit = AbortSignal.timeout(timeoutMs);
  return fetchImpl(url, { ...init, signal: signal === undefined ? limit : AbortSignal.any([signal, limit]) });
}

/**
 * A response body read to at most `maxBytes`: past it the read stops and this
 * throws, so a download over a channel's cap is never held whole.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`the download is ${declared} bytes, over ${maxBytes}`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`the download passed ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A response body as JSON, or `undefined` when it is not JSON (a proxy's HTML page): never a throw. */
export async function readJson(response: Response): Promise<unknown> {
  // A body that is not JSON reads as none: the caller checks the shape it needs.
  return response.json().catch(() => undefined);
}

/** The refusal of a send through a connection that is not running: recorded as rejected, never sent. */
export function notRunning(providerLabel: string, connectionId: string, state: MessagingConnectionState): TaviError {
  return new TaviError("UNAVAILABLE", `${providerLabel} connection ${connectionId} is not running (state: ${state})`, {
    details: { connectionId },
  });
}

/** A message's destination in the connector's own shape, or an `INVALID_INPUT` naming what is wrong with it. */
export function parseDestination<T extends z.ZodType>(schema: T, message: OutboundMessage, providerLabel: string): z.infer<T> {
  const parsed = schema.safeParse(message.destination);
  if (!parsed.success) {
    throw new TaviError(
      "INVALID_INPUT",
      `${providerLabel} destination for effect ${message.effectId} is invalid: ${parsed.error.message}`,
      { details: { effectId: message.effectId } },
    );
  }
  return parsed.data;
}

/** An `INVALID_INPUT` for a message with more parts than the connector takes in one send. */
export function checkPartCount(message: OutboundMessage, maxParts: number, providerLabel: string): void {
  if (message.parts.length === 0 || message.parts.length > maxParts) {
    throw new TaviError(
      "INVALID_INPUT",
      `${providerLabel} effect ${message.effectId} has ${message.parts.length} parts; 1 to ${maxParts} are taken (maxPartsPerMessage=${maxParts})`,
      { details: { effectId: message.effectId } },
    );
  }
}

/** A part whose outcome is unknown because the request failed in flight: a network error, a timeout. */
export function uncertainReceipt(index: number, error: string): SendOutcomePartReceipt {
  return { index, status: "uncertain", error };
}

/**
 * A part's receipt from an HTTP status the provider answered with no
 * usable body: 4xx is a definitive refusal, anything else — a 5xx, a 2xx
 * without the id it should carry — leaves the outcome unknown.
 */
export function httpFailureReceipt(index: number, status: number, error: string): SendOutcomePartReceipt {
  return status >= 400 && status < 500 ? { index, status: "rejected", error } : { index, status: "uncertain", error };
}

/** Parts' receipts summed: accepted only when all are, rejected only when all are, uncertain otherwise. */
export function aggregateStatus(parts: readonly SendOutcomePartReceipt[]): SendOutcomeStatus {
  if (parts.length > 0 && parts.every((part) => part.status === "accepted")) return "accepted";
  if (parts.length > 0 && parts.every((part) => part.status === "rejected")) return "rejected";
  return "uncertain";
}

// Link disarming and the inbound split are the host's too, so they live in contracts; named here for channel authors.
// The zod-free entry, so a channel plugin that bundles this kit carries no schema library for it.
export { disarmUrls } from "@tavi/contracts/url-text";
export { domainOf, domainsAligned, HEADER_LINE_MAX, referencesHeader, replySubject } from "./email.js";
export { inboundParts, splitEmailText, type InboundQuotedPart, type InboundSplit } from "@tavi/contracts/inbound-parts";
