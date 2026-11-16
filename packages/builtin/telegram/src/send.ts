import { redactedError } from "@tavi/channel-kit";
import type { OutboundFilePart, OutboundMessage, OutboundMessagePart, SendOutcomePartReceipt } from "@tavi/contracts";
import { isFilePart } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { z } from "zod";

import type { TelegramApi, TelegramApiResult } from "./api.js";
import { TELEGRAM_CAPABILITIES } from "./descriptor.js";
import type { TelegramMessage } from "./inbound.js";

/**
 * Delivery to Telegram: one Bot API call per part — a text through
 * `sendMessage`, an artifact uploaded through `sendDocument` — buttons as an
 * inline keyboard, and each answer as the part's receipt.
 */

/**
 * Bytes plus content type for an authorized artifact reference. Defined here
 * rather than reusing `ArtifactRecord` so this adapter never depends on the
 * artifact store's own record shape — it is handed exactly what
 * `sendDocument` needs and nothing else.
 */
export interface TelegramAttachment {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** Telegram's 403 descriptions for a user the bot cannot write to: never started it, blocked it, or the account is gone. */
const UNREACHABLE_USER = /can't initiate conversation|bot was blocked by the user|user is deactivated/i;

export const TelegramDestinationSchema = z.object({
  chatId: z.union([z.string(), z.number()]),
  replyToMessageId: z.union([z.string(), z.number()]).optional(),
  /** The forum topic to post in (`message_thread_id`). */
  threadId: z.union([z.string(), z.number()]).optional(),
});

export type TelegramDestination = z.infer<typeof TelegramDestinationSchema>;

/** Telegram's bound on `callback_data`, in bytes. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export interface TelegramInlineKeyboard {
  readonly inline_keyboard: readonly (readonly { readonly text: string; readonly callback_data: string }[])[];
}

/**
 * `OutboundMessage.buttons` as an inline keyboard; `undefined` for none, and
 * `null` when a button's data exceeds Telegram's 64-byte `callback_data`
 * bound — refused, never truncated, since a clipped value names something else.
 */
export function inlineKeyboard(buttons: OutboundMessage["buttons"]): TelegramInlineKeyboard | undefined | null {
  if (buttons === undefined || buttons.length === 0) return undefined;
  const encoder = new TextEncoder();
  if (buttons.some((row) => row.some((button) => encoder.encode(button.data).byteLength > TELEGRAM_CALLBACK_DATA_MAX_BYTES))) return null;
  return { inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.label.slice(0, 64), callback_data: button.data }))) };
}

export interface TelegramSendContext {
  readonly api: TelegramApi;
  /** See `TelegramConnectorOptions.readArtifact`. */
  readonly readArtifact:
    | ((artifactId: string, workspaceId: string) => TelegramAttachment | undefined | Promise<TelegramAttachment | undefined>)
    | undefined;
  /** The connection's own workspace, when the message names none. */
  readonly workspaceId: string;
}

export type TelegramPartReceipt = SendOutcomePartReceipt & { readonly retryAfterMs?: number };

export async function sendPart(
  context: TelegramSendContext,
  index: number,
  part: OutboundMessagePart,
  destination: TelegramDestination,
  workspaceId: string | undefined,
  keyboard: TelegramInlineKeyboard | undefined,
): Promise<TelegramPartReceipt> {
  if (isFilePart(part)) return sendFilePart(context, index, part, destination, workspaceId);
  let result: TelegramApiResult<TelegramMessage>;
  try {
    result = await context.api.call<TelegramMessage>("sendMessage", {
      chat_id: destination.chatId,
      text: part.content,
      ...definedOnly({
        reply_to_message_id: destination.replyToMessageId,
        message_thread_id: destination.threadId,
        reply_markup: keyboard,
      }),
    });
  } catch (error) {
    // A network error or timeout means the send's outcome is genuinely
    // unknown — Telegram may or may not have received it.
    return { index, status: "uncertain", error: redactedError(error, [context.api.token()]) };
  }
  return toPartReceipt(index, result);
}

/**
 * Uploads one artifact as a document.
 *
 * Every failure *before* the request leaves is `"rejected"`, not
 * `"uncertain"`: nothing was submitted, so there is no ambiguity to
 * reconcile and the caller may safely decide to retry. Only a transport
 * failure at the request itself is uncertain, matching the text path.
 *
 * What counts as releasable is the injected reader's decision, not this
 * adapter's: an unreleased or missing artifact both surface here as a `null`
 * read, and the rejection message says so without claiming to know which.
 */
async function sendFilePart(
  context: TelegramSendContext,
  index: number,
  part: OutboundFilePart,
  destination: TelegramDestination,
  workspaceId: string | undefined,
): Promise<TelegramPartReceipt> {
  // Every field below is model-authored, and the contract explicitly
  // envisions a persisted row being replayed for reconciliation — the store
  // deserializes those with an unchecked `JSON.parse(...) as OutboundMessage`
  // (`packages/runtime/src/persistence/store/messaging.ts`). TypeScript's types are not
  // a runtime guard, so a malformed part is rejected here instead of reaching
  // `defaultFilename`/`Blob` and either throwing out of the whole `send()` or
  // uploading a zero-byte document.
  if (typeof part.artifactId !== "string" || part.artifactId === "") {
    return { index, status: "rejected", error: "file part has no usable artifactId" };
  }
  const reader = context.readArtifact;
  if (reader === undefined) {
    return { index, status: "rejected", error: "no artifact store is wired to the Telegram connector" };
  }
  // A reader throwing (an unreadable blob, a store error) is this part's
  // rejection, not the whole send's. The cause is NOT forwarded: a store
  // error message carries an absolute path under the data directory
  // (`readArtifactBody` is a `readFileSync`), and this string becomes a part
  // receipt, the model-visible tool result and the durable effect receipt.
  // The text path redacts the bot token for the same reason.
  let attachment: TelegramAttachment | undefined;
  try {
    attachment = await reader(part.artifactId, workspaceId ?? context.workspaceId);
  } catch {
    return { index, status: "rejected", error: `artifact ${part.artifactId} could not be read` };
  }
  if (attachment === undefined) {
    return {
      index,
      status: "rejected",
      error: `artifact ${part.artifactId} is not available for delivery (unknown, unreadable, or not released)`,
    };
  }
  if (!(attachment.bytes instanceof Uint8Array) || attachment.bytes.byteLength === 0) {
    return { index, status: "rejected", error: `artifact ${part.artifactId} has no readable bytes` };
  }
  if (attachment.bytes.byteLength > TELEGRAM_CAPABILITIES.maxAttachmentBytes) {
    return {
      index,
      status: "rejected",
      error: `artifact ${part.artifactId} is ${attachment.bytes.byteLength} bytes, exceeding maxAttachmentBytes=${TELEGRAM_CAPABILITIES.maxAttachmentBytes}`,
    };
  }
  const contentType = part.mimeType ?? attachment.contentType;
  const filename = safeFilename(part.filename ?? defaultFilename(part.artifactId, contentType));
  let result: TelegramApiResult<TelegramMessage>;
  try {
    result = await context.api.callMultipart<TelegramMessage>(
      "sendDocument",
      {
        chat_id: String(destination.chatId),
        ...(part.caption === undefined ? {} : { caption: part.caption }),
        ...(destination.replyToMessageId === undefined ? {} : { reply_to_message_id: String(destination.replyToMessageId) }),
        ...(destination.threadId === undefined ? {} : { message_thread_id: String(destination.threadId) }),
      },
      { field: "document", filename, contentType, bytes: attachment.bytes },
    );
  } catch (error) {
    return { index, status: "uncertain", error: redactedError(error, [context.api.token()]) };
  }
  return toPartReceipt(index, result);
}

/** Shared Bot API result → per-part receipt mapping, so the text and document paths cannot drift on rejection/retry semantics. */
function toPartReceipt(index: number, result: TelegramApiResult<TelegramMessage>): TelegramPartReceipt {
  if (result.ok) {
    return { index, status: "accepted", providerMessageId: String(result.result.message_id) };
  }
  // Every rejection — 429 included — is treated as final at this layer
  // (never auto-retried here); `retry_after`, when present, is still
  // forwarded up as informational metadata for a caller that chooses to
  // retry deliberately.
  const retryAfterSeconds = result.parameters?.retry_after;
  return {
    index,
    status: "rejected",
    error: result.description,
    // A user who never started the bot, or blocked it, cannot be written to one-to-one.
    ...(result.error_code === 403 && UNREACHABLE_USER.test(result.description) ? { unreachable: true as const } : {}),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterMs: retryAfterSeconds * 1000 }),
  };
}

/**
 * Extensions for the content types this deployment actually produces. A type
 * outside this map still sends; it just gets a neutral `.bin` name, which
 * Telegram accepts (it does not require a recognizable extension).
 */
const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** A stable, recognizable filename when the caller named none — the artifact id keeps two documents in one chat distinguishable. */
function defaultFilename(artifactId: string, contentType: string): string {
  const extension = CONTENT_TYPE_EXTENSIONS[contentType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "bin";
  const stem = artifactId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return `${stem === "" ? "artifact" : stem}.${extension}`;
}

/**
 * Neutralizes a caller-supplied filename before it reaches the multipart
 * `Content-Disposition` header.
 *
 * The name arrives from a model-authored tool argument, so it is untrusted
 * input. Quotes, control characters and path separators are *replaced* with
 * `-` rather than deleted — deleting would silently join `"a\r\nb"` into
 * `"ab"`, a name nobody chose — `..` runs are collapsed so a downstream
 * consumer that joins this name to a path cannot traverse, and leading dots
 * are stripped. The result is always a plain base name.
 *
 * Header injection is prevented twice over already — here, and by Node's own
 * multipart serializer, which percent-escapes `"`/CR/LF — but this sanitizer
 * must not depend on which `fetch` implementation is injected. The Unicode
 * format controls are stripped too: they cannot break the header, but
 * `invoice\u202Efdp.exe` renders reversed in the recipient's chat, which is a
 * display-spoofing vector aimed at the human reading the message.
 */
function safeFilename(name: string): string {
  const collapsed = name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "-")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/["\\/]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .trim();
  return collapsed === "" ? "artifact" : collapsed.slice(0, 128);
}
