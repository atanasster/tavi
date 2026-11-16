/**
 * A channel's mailbox, for the agent's mailbox tools: what a channel whose
 * app is `mailbox` ships, so the owner's
 * tools are the same for every such channel and name none.
 */

/** One message as a search lists it: who, what and when, never its body. */
export interface MailboxListed {
  readonly id: string;
  readonly threadId: string;
  readonly from?: string;
  readonly subject?: string;
  readonly date?: string;
  readonly snippet?: string;
  /**
   * Whether the provider authenticated the message as its `From` sender (DMARC, or aligned DKIM or SPF):
   * `fail` when it did not or cannot say, so the sender's name is a claim, not a fact.
   */
  readonly fromVerified?: "pass" | "fail";
}

/** One message read: the sender's own words apart from what they quoted or forwarded. */
export interface MailboxRead extends MailboxListed {
  readonly to?: string;
  readonly cc?: string;
  readonly text: string;
  readonly quoted: readonly { readonly kind: string; readonly text: string }[];
  /** The message had no plain-text part: `text` is the provider's one-line snippet. */
  readonly fromSnippet: boolean;
  /** Its text or what it quoted was cut to a thread's bounds: read it whole by its id. */
  readonly clipped?: true;
}

/** One page of a search: its messages, and the token that asks for the next page when there is one. */
export interface MailboxSearchPage {
  readonly messages: readonly MailboxListed[];
  readonly nextPageToken?: string;
}

/**
 * A thread read within bounds: its latest messages, oldest first, each read as `read` reads one (its text
 * and quotes cut to the thread's bounds, `clipped`), and how many earlier messages were left out.
 */
export interface MailboxThread {
  readonly threadId: string;
  readonly messages: readonly MailboxRead[];
  readonly omitted: number;
}

/**
 * A change to some messages' labels, in the words of triage: labels to add and to take off (by name, as the
 * mailbox shows them, or by id), archive (out of the inbox), and read or unread. The mailbox says them in its
 * own terms (Gmail: removing `INBOX`, `UNREAD`).
 */
export interface MailboxLabelChange {
  readonly ids: readonly string[];
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly archive?: boolean;
  readonly read?: boolean;
}

/** One message after a label change, as the mailbox reads it back: the labels it holds now, by name. */
export interface MailboxLabelled {
  readonly id: string;
  readonly labels: readonly string[];
  /** Whether it holds what the change asked: added labels on, removed ones off. */
  readonly applied: boolean;
}

export interface MailboxDraftInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  /** The message replied to, by the ids its read gave: the draft joins its thread. */
  readonly replyTo?: { readonly threadId: string; readonly messageId?: string | undefined };
}

/** A draft made: its id, the message it holds now, and, for a reply, who and what it answers, as the mailbox says. */
export interface MailboxDraftMade {
  readonly draftId: string;
  readonly messageId: string;
  readonly replyingTo?: { readonly from?: string | undefined; readonly subject?: string | undefined } | undefined;
}

/** One account's mailbox, signed in through the owner's broker. */
export interface ChannelMailbox {
  search(query: string, max: number, signal?: AbortSignal): Promise<readonly MailboxListed[]>;
  read(id: string, signal?: AbortSignal): Promise<MailboxRead>;
  createDraft(input: MailboxDraftInput, signal?: AbortSignal): Promise<MailboxDraftMade>;
  /** The message a draft holds now: a draft edited since it was shown holds another. */
  draftMessageId(draftId: string, signal?: AbortSignal): Promise<string>;
  sendDraft(draftId: string, signal?: AbortSignal): Promise<{ readonly messageId: string; readonly threadId: string }>;
  hasSentTo(address: string, signal?: AbortSignal): Promise<boolean>;
  /** A search one page at a time; a mailbox without it lists one page only, and its search tool takes no page token. */
  searchPage?(query: string, max: number, pageToken: string | undefined, signal?: AbortSignal): Promise<MailboxSearchPage>;
  /** A thread read within bounds; a mailbox without it has no thread tool. */
  thread?(threadId: string, signal?: AbortSignal): Promise<MailboxThread>;
  /** Adds and removes labels on up to `MAILBOX_LABEL_MAX` messages at once, and reads each back; a mailbox without it has no label tool. */
  modifyLabels?(change: MailboxLabelChange, signal?: AbortSignal): Promise<readonly MailboxLabelled[]>;
}

/** The most messages one label change names: one approval card, one call to the mailbox. */
export const MAILBOX_LABEL_MAX = 50;

/** What a channel ships for its mailboxes; `Fetch` is the runtime's `fetch`, which this package does not type. */
export interface ChannelMailboxKit<Fetch = unknown> {
  /** The most messages one search lists. */
  readonly searchMax: number;
  /** How to write a search, for the search tool's description of its query (e.g. the provider's own operators). */
  readonly searchHint: string;
  open(options: { readonly accessToken: () => Promise<string>; readonly fetch?: Fetch; readonly apiBaseUrl?: string }): ChannelMailbox;
  /** A recipient as an address, or undefined for one that is not. */
  recipientOf(value: string): string | undefined;
}
