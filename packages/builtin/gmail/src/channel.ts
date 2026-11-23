import type { ChannelCalendarKit, ChannelHostServices, ChannelMailboxKit } from "@tavi/contracts";

import { GOOGLE_CALENDAR_LIST_MAX, GoogleCalendar } from "./calendar.js";

import { createGmailConnectorDefinition, GMAIL_CHANNEL_DESCRIPTOR, gmailChannelDescriptor } from "./connector.js";
import { GMAIL_SEARCH_MAX, GmailMailbox, recipientOf } from "./tools.js";

/**
 * Gmail as the owner's catalog takes a builtin channel:
 * its descriptor, its connector made for an owner, and the mailbox its
 * accounts' tools use — in one entry,
 * so core names the channel once, where it lists it.
 */

const mailbox: ChannelMailboxKit<typeof fetch> = {
  searchMax: GMAIL_SEARCH_MAX,
  searchHint: "A Gmail search, as in Gmail's own search box (from:, subject:, newer_than:7d …)",
  open: (options) => new GmailMailbox(options),
  recipientOf,
};

const calendar: ChannelCalendarKit<typeof fetch> = {
  listMax: GOOGLE_CALENDAR_LIST_MAX,
  open: (options) => new GoogleCalendar(options),
};

export const gmailChannel = {
  descriptor: GMAIL_CHANNEL_DESCRIPTOR,
  /** The descriptor in a language's words, for a person's screens. */
  descriptorIn: gmailChannelDescriptor,
  connector: (host: ChannelHostServices<typeof fetch>) => createGmailConnectorDefinition({ now: host.now, fetch: host.fetch }),
  mailbox,
  calendar,
};
