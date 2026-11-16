import type { ChannelHostServices } from "@tavi/contracts";

import { createMailgunConnectorDefinition, MAILGUN_CHANNEL_DESCRIPTOR } from "./connector.js";

/**
 * Mailgun email as the owner's catalog takes a builtin channel: its descriptor
 * and its connector made for an owner, in one entry, so core names the
 * channel once, where it lists it.
 */
export const mailgunChannel = {
  descriptor: MAILGUN_CHANNEL_DESCRIPTOR,
  connector: (host: ChannelHostServices<typeof fetch>) => createMailgunConnectorDefinition({ now: host.now, fetch: host.fetch }),
};
