import type { ChannelHostServices } from "@tavi/contracts";

import { createMailgunConnectorDefinition, MAILGUN_CHANNEL_DESCRIPTOR, mailgunChannelDescriptor } from "./connector.js";

/**
 * Mailgun email as the owner's catalog takes a builtin channel: its descriptor
 * and its connector made for an owner, in one entry, so core names the
 * channel once, where it lists it.
 */
export const mailgunChannel = {
  descriptor: MAILGUN_CHANNEL_DESCRIPTOR,
  /** The descriptor in a language's words, for a person's screens. */
  descriptorIn: mailgunChannelDescriptor,
  connector: (host: ChannelHostServices<typeof fetch>) => createMailgunConnectorDefinition({ now: host.now, fetch: host.fetch }),
};
