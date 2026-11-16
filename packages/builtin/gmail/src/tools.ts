import { fetchWithTimeout, readJson, redactedError, referencesHeader, splitEmailText } from "@tavi/channel-kit";
import {
  MAILBOX_LABEL_MAX,
  TaviError,
  type ChannelMailbox,
  type MailboxLabelChange,
  type MailboxLabelled,
  type MailboxSearchPage,
  type MailboxThread,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { addressOf, headerOf, plainTextOf, rawMessage, senderAuthenticationOf, type GmailMessage } from "./connector.js";

/**
 * A Gmail mailbox, for the agent's mailbox tools: search it a page at a
 * time, read one message or a thread, label, archive and mark messages, make
 * a draft, and send a draft. This is the mailbox, not the channel: the host offers these only
 * for an account whose mailbox opt-in is on. Like the channel, it asks only
 * `accessToken()`, and never sees the refresh token or the OAuth app.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const REQUEST_TIMEOUT_MS = 30_000;
/** An RFC 5322 message id, angle brackets and all. */
const MESSAGE_ID = /^<[^<>\s]{1,250}>$/;
/** The most messages one search lists. */
export const GMAIL_SEARCH_MAX = 20;
/** A thread's bounds: its latest messages, each one's own words and quotes cut, and all of them together. */
export const GMAIL_THREAD_BOUNDS = { messages: 25, text: 4_000, quoted: 1_000, total: 40_000 } as const;
/** Labels a triage never moves: what deletes, reports or files a message (Trash, Spam) and what Gmail itself sets. */
const UNMOVED_LABELS = new Set(["TRASH", "SPAM", "DRAFT", "SENT", "CHAT"]);
/** Messages read back at once after a label change: Gmail's per-user quota, not a page of 50 at a time. */
const READ_BACK_AT_ONCE = 10;

export interface GmailMailboxOptions {
  readonly accessToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly apiBaseUrl?: string;
  readonly requestTimeoutMs?: number;
}

/** One message as a search lists it: who, what and when, never its body. */
export interface GmailListed {
  readonly id: string;
  readonly threadId: string;
  readonly from?: string;
  readonly subject?: string;
  readonly date?: string;
  readonly snippet?: string;
  /** Whether Google authenticated it as its From sender (`senderAuthenticationOf`): `fail` means the name is a claim. */
  readonly fromVerified?: "pass" | "fail";
}

/** One message read: the sender's own words apart from what they quoted or forwarded. */
export interface GmailRead extends GmailListed {
  readonly to?: string;
  readonly cc?: string;
  readonly text: string;
  readonly quoted: readonly { readonly kind: string; readonly text: string }[];
  /** The message had no plain-text part: `text` is Gmail's one-line snippet. */
  readonly fromSnippet: boolean;
  /** Cut to a thread's bounds. */
  readonly clipped?: true;
}

export interface GmailDraftInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  /** The message replied to: the draft joins its thread. */
  readonly replyTo?: { readonly threadId: string; readonly messageId?: string | undefined };
}

export class GmailMailbox implements ChannelMailbox {
  readonly #options: GmailMailboxOptions;

  constructor(options: GmailMailboxOptions) {
    this.#options = options;
  }

  /** One Gmail API call; its errors never carry the token, and a refusal is said with its status. */
  async #call(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const token = await this.#options.accessToken();
    let response: Response;
    let body: unknown;
    try {
      response = await fetchWithTimeout(
        this.#options.fetch ?? globalThis.fetch,
        `${this.#options.apiBaseUrl ?? API}${path}`,
        {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            authorization: `Bearer ${token}`,
            accept: "application/json",
          },
        },
        this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        signal,
      );
      body = await readJson(response);
    } catch (error) {
      throw new TaviError("UNAVAILABLE", redactedError(error, [token]));
    }
    if (response.status === 404) throw new TaviError("NOT_FOUND", "Gmail has no such message, thread or draft");
    // Its token refused (revoked at Google before it expired): a sign-in to make, as a lapsed one is.
    if (response.status === 401)
      throw new TaviError("NOT_AUTHORIZED", "Gmail refused its sign-in (HTTP 401)", { details: { signIn: true } });
    // Signed in without Gmail's access (Google's consent lets each box be unticked): a sign-in to make again.
    if (response.status === 403 && /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(JSON.stringify(body ?? "")))
      throw new TaviError("NOT_AUTHORIZED", "This Google account did not allow Gmail's access: sign in again and tick every box", {
        details: { signIn: true },
      });
    if (!response.ok) throw new TaviError("UNAVAILABLE", `Gmail refused the request (HTTP ${String(response.status)})`);
    return body;
  }

  async search(query: string, max: number, signal?: AbortSignal): Promise<readonly GmailListed[]> {
    return (await this.searchPage(query, max, undefined, signal)).messages;
  }

  /** One page of a search: Gmail's own `nextPageToken` asks for the next. */
  async searchPage(query: string, max: number, pageToken: string | undefined, signal?: AbortSignal): Promise<MailboxSearchPage> {
    const limit = Math.max(1, Math.min(GMAIL_SEARCH_MAX, Math.floor(max)));
    const listed = (await this.#call(
      `/messages?${new URLSearchParams({ q: query, maxResults: String(limit), ...(pageToken === undefined ? {} : { pageToken }) }).toString()}`,
      {},
      signal,
    )) as { messages?: readonly { id: string }[]; nextPageToken?: unknown } | undefined;
    // At most `GMAIL_SEARCH_MAX` lookups, asked together, kept in the search's order.
    const messages = await Promise.all(
      (listed?.messages ?? [])
        .slice(0, limit)
        .map(async ({ id }) =>
          listedOf(
            (await this.#call(
              `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Authentication-Results`,
              {},
              signal,
            )) as GmailMessage,
          ),
        ),
    );
    const next = listed?.nextPageToken;
    return { messages, ...(typeof next === "string" && next !== "" ? { nextPageToken: next } : {}) };
  }

  async read(id: string, signal?: AbortSignal): Promise<GmailRead> {
    return readOf((await this.#call(`/messages/${encodeURIComponent(id)}?format=full`, {}, signal)) as GmailMessage);
  }

  /**
   * A thread, within `GMAIL_THREAD_BOUNDS`: its latest messages, oldest first, each read as `read` reads one
   * and cut to the bounds; earlier ones past them are counted in `omitted`, never read.
   */
  async thread(threadId: string, signal?: AbortSignal): Promise<MailboxThread> {
    const thread = (await this.#call(`/threads/${encodeURIComponent(threadId)}?format=full`, {}, signal)) as
      | { id?: unknown; messages?: readonly GmailMessage[] }
      | undefined;
    // As Gmail shows a thread: what was deleted or marked spam is not part of it.
    const all = (thread?.messages ?? []).filter(
      (message) => !(message.labelIds ?? []).some((label) => label === "TRASH" || label === "SPAM"),
    );
    const kept: GmailRead[] = [];
    let total = 0;
    // From the latest back: the newest messages are what a triage answers.
    for (let index = all.length - 1; index >= 0 && kept.length < GMAIL_THREAD_BOUNDS.messages; index--) {
      const message = all[index];
      if (message === undefined) continue;
      const read = clippedRead(readOf(message));
      const size = read.text.length + read.quoted.reduce((sum, part) => sum + part.text.length, 0);
      if (kept.length > 0 && total + size > GMAIL_THREAD_BOUNDS.total) break;
      total += size;
      kept.unshift(read);
    }
    return { threadId: typeof thread?.id === "string" ? thread.id : threadId, messages: kept, omitted: all.length - kept.length };
  }

  /**
   * Adds and removes labels on up to `MAILBOX_LABEL_MAX` messages in one `batchModify`, then reads each back.
   * A label is named as Gmail shows it or by its id; one the mailbox has not is refused before anything
   * changes, as is Trash, Spam or a label Gmail sets itself. Archive takes `INBOX` off; read takes `UNREAD`
   * off, unread puts it on.
   */
  async modifyLabels(change: MailboxLabelChange, signal?: AbortSignal): Promise<readonly MailboxLabelled[]> {
    const ids = [...new Set(change.ids)];
    if (ids.length === 0 || ids.length > MAILBOX_LABEL_MAX)
      throw new TaviError("INVALID_INPUT", `name 1 to ${String(MAILBOX_LABEL_MAX)} messages to label`);
    const listed = (await this.#call("/labels", {}, signal)) as { labels?: readonly { id?: unknown; name?: unknown }[] } | undefined;
    const labels = (listed?.labels ?? []).flatMap((label) =>
      typeof label.id === "string" && typeof label.name === "string" ? [{ id: label.id, name: label.name }] : [],
    );
    const idOf = (given: string): string => {
      const found =
        labels.find((label) => label.id === given) ?? labels.find((label) => label.name.toLowerCase() === given.trim().toLowerCase());
      if (found === undefined) throw new TaviError("INVALID_INPUT", `this mailbox has no label ${JSON.stringify(given.slice(0, 80))}`);
      if (UNMOVED_LABELS.has(found.id)) throw new TaviError("INVALID_INPUT", `${found.name} is not a label a triage moves`);
      return found.id;
    };
    const add = new Set(change.add.map(idOf));
    const remove = new Set(change.remove.map(idOf));
    if (change.archive === true) remove.add("INBOX");
    if (change.read === true) remove.add("UNREAD");
    if (change.read === false) add.add("UNREAD");
    for (const id of add)
      if (remove.has(id)) throw new TaviError("INVALID_INPUT", `a change cannot both add and remove ${nameOf(labels, id)}`);
    if (add.size === 0 && remove.size === 0) throw new TaviError("INVALID_INPUT", "name a label to add or remove, archive, or read");
    await this.#call(
      "/messages/batchModify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, addLabelIds: [...add], removeLabelIds: [...remove] }),
      },
      signal,
    );
    // The read-back: each message's labels as Gmail holds them now, a few at a time.
    const read: MailboxLabelled[] = [];
    for (let at = 0; at < ids.length; at += READ_BACK_AT_ONCE) {
      read.push(
        ...(await Promise.all(
          ids.slice(at, at + READ_BACK_AT_ONCE).map(async (id): Promise<MailboxLabelled> => {
            const message = (await this.#call(`/messages/${encodeURIComponent(id)}?format=minimal`, {}, signal)) as
              | { labelIds?: readonly unknown[] }
              | undefined;
            const held = new Set((message?.labelIds ?? []).filter((label): label is string => typeof label === "string"));
            return {
              id,
              labels: [...held].map((label) => nameOf(labels, label)),
              applied: [...add].every((label) => held.has(label)) && [...remove].every((label) => !held.has(label)),
            };
          }),
        )),
      );
    }
    return read;
  }

  /**
   * A draft, never sent: its id and the id of the message it holds now (an edit in Gmail changes that). A
   * reply names the message by the id its read gave; its threading headers are that message's own RFC 5322
   * `Message-ID` and `References`, read from Gmail, and a message outside the thread named is refused.
   */
  async createDraft(
    input: GmailDraftInput,
    signal?: AbortSignal,
  ): Promise<{
    readonly draftId: string;
    readonly messageId: string;
    readonly replyingTo?: { readonly from?: string; readonly subject?: string };
  }> {
    const original =
      input.replyTo?.messageId === undefined ? undefined : await this.#replied(input.replyTo.threadId, input.replyTo.messageId, signal);
    const raw = rawMessage({
      from: input.from,
      to: input.to.join(", "),
      ...(input.cc === undefined ? {} : { cc: input.cc.join(", ") }),
      subject: input.subject,
      text: input.body,
      ...(original?.inReplyTo === undefined ? {} : { inReplyTo: original.inReplyTo, references: original.references }),
    });
    const made = (await this.#call(
      "/drafts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { raw, ...(input.replyTo === undefined ? {} : { threadId: input.replyTo.threadId }) } }),
      },
      signal,
    )) as { id?: unknown; message?: { id?: unknown } } | undefined;
    if (typeof made?.id !== "string" || typeof made.message?.id !== "string") throw new TaviError("UNAVAILABLE", "Gmail made no draft");
    return { draftId: made.id, messageId: made.message.id, ...(original === undefined ? {} : { replyingTo: original.replyingTo }) };
  }

  /** The message a reply answers: its threading headers, and its sender and subject for the send card. */
  async #replied(
    threadId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly inReplyTo?: string;
    readonly references: string;
    readonly replyingTo: { readonly from?: string; readonly subject?: string };
  }> {
    const query = ["Message-ID", "References", "From", "Subject"].map((name) => `metadataHeaders=${name}`).join("&");
    const message = (await this.#call(`/messages/${encodeURIComponent(id)}?format=metadata&${query}`, {}, signal)) as GmailMessage;
    if (message.threadId !== threadId)
      throw new TaviError("INVALID_INPUT", "that message is not in the thread the reply joins: take both from the same read");
    const headers = message.payload?.headers;
    const given = headerOf(headers, "Message-ID")?.trim();
    const own = given !== undefined && MESSAGE_ID.test(given) ? given : undefined;
    const earlier = (headerOf(headers, "References") ?? "").split(/\s+/).filter((token) => MESSAGE_ID.test(token));
    const from = headerOf(headers, "From");
    const subject = headerOf(headers, "Subject");
    return {
      ...(own === undefined ? {} : { inReplyTo: own }),
      references: referencesHeader([...earlier, ...(own === undefined ? [] : [own])]),
      replyingTo: { ...(from === undefined ? {} : { from }), ...(subject === undefined ? {} : { subject }) },
    };
  }

  /** The id of the message a draft holds now. */
  async draftMessageId(draftId: string, signal?: AbortSignal): Promise<string> {
    const draft = (await this.#call(`/drafts/${encodeURIComponent(draftId)}?format=minimal`, {}, signal)) as
      | { message?: { id?: unknown } }
      | undefined;
    if (typeof draft?.message?.id !== "string") throw new TaviError("NOT_FOUND", "Gmail has no such draft");
    return draft.message.id;
  }

  async sendDraft(draftId: string, signal?: AbortSignal): Promise<{ readonly messageId: string; readonly threadId: string }> {
    const sent = (await this.#call(
      "/drafts/send",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: draftId }) },
      signal,
    )) as { id?: unknown; threadId?: unknown } | undefined;
    if (typeof sent?.id !== "string") throw new TaviError("UNAVAILABLE", "Gmail did not say the draft was sent");
    return { messageId: sent.id, threadId: typeof sent.threadId === "string" ? sent.threadId : "" };
  }

  /** Whether the mailbox's Sent mail holds a message to this address: a first-time recipient is flagged on the send card. */
  async hasSentTo(address: string, signal?: AbortSignal): Promise<boolean> {
    const listed = (await this.#call(
      `/messages?${new URLSearchParams({ q: `in:sent to:${address}`, maxResults: "1" }).toString()}`,
      {},
      signal,
    )) as { messages?: readonly unknown[] } | undefined;
    return (listed?.messages ?? []).length > 0;
  }
}

/** Whether Google authenticated `from`'s address; a From that names no address is never verified. */
function verifiedSender(headers: Parameters<typeof senderAuthenticationOf>[0], from: string): "pass" | "fail" {
  const address = addressOf(from);
  return address === undefined ? "fail" : senderAuthenticationOf(headers, address);
}

/** A label's name as Gmail shows it, else its id. */
function nameOf(labels: readonly { readonly id: string; readonly name: string }[], id: string): string {
  return labels.find((label) => label.id === id)?.name ?? id;
}

/** One message read: the sender's own words are what no quoted or forwarded range covers. */
function readOf(message: GmailMessage): GmailRead {
  const { text, fromSnippet } = plainTextOf(message);
  const ranges = fromSnippet ? [] : splitEmailText(text);
  let own = "";
  let at = 0;
  for (const range of ranges) {
    own += text.slice(at, range.start);
    at = range.end;
  }
  own += text.slice(at);
  const headers = message.payload?.headers;
  const to = headerOf(headers, "To");
  const cc = headerOf(headers, "Cc");
  return {
    ...listedOf(message),
    ...(to === undefined ? {} : { to }),
    ...(cc === undefined ? {} : { cc }),
    text: own.trim(),
    quoted: ranges.map((range) => ({ kind: range.kind, text: text.slice(range.start, range.end).trim() })),
    fromSnippet,
  };
}

/** A thread's message cut to its bounds: its own words, then its quotes in order until their share runs out. */
function clippedRead(read: GmailRead): GmailRead {
  let left = GMAIL_THREAD_BOUNDS.quoted;
  const quoted = read.quoted.flatMap((part) => {
    if (left <= 0) return [];
    const text = part.text.slice(0, left);
    left -= text.length;
    return [{ kind: part.kind, text }];
  });
  const clipped =
    read.text.length > GMAIL_THREAD_BOUNDS.text ||
    quoted.length < read.quoted.length ||
    quoted.some((part, index) => part.text !== read.quoted[index]?.text);
  return { ...read, text: read.text.slice(0, GMAIL_THREAD_BOUNDS.text), quoted, ...(clipped ? { clipped: true as const } : {}) };
}

function listedOf(message: GmailMessage): GmailListed {
  const headers = message.payload?.headers;
  const from = headerOf(headers, "From");
  const subject = headerOf(headers, "Subject");
  const date = headerOf(headers, "Date");
  return {
    id: message.id,
    threadId: message.threadId,
    ...definedOnly({ from, subject, date, snippet: message.snippet }),
    ...(from === undefined ? {} : { fromVerified: verifiedSender(headers, from) }),
  };
}

/** A recipient's bare address, lower-cased, or undefined for one that is not an address. */
export function recipientOf(value: string): string | undefined {
  return addressOf(value.trim())?.toLowerCase();
}
