import type { ChannelHostServices } from "@tavi/contracts";

import {
  createTelegramConnectorDefinition,
  TELEGRAM_CHANNEL_DESCRIPTOR,
  TELEGRAM_MAX_ATTACHMENT_BYTES,
  telegramChannelDescriptor,
} from "./connector.js";

/**
 * Telegram as the owner's catalog takes a builtin channel: its descriptor and
 * its connector made for an owner, in one entry, so core names the channel
 * once, where it lists it. An attachment is read no larger than Telegram takes.
 * `descriptorIn` is the descriptor in a language's words, for a person's screens.
 */
export const telegramChannel = {
  descriptor: TELEGRAM_CHANNEL_DESCRIPTOR,
  descriptorIn: telegramChannelDescriptor,
  connector: (host: ChannelHostServices<typeof fetch>) =>
    createTelegramConnectorDefinition({
      now: host.now,
      fetch: host.fetch,
      readArtifact: (artifactId, workspaceId) => host.readArtifact(artifactId, workspaceId, TELEGRAM_MAX_ATTACHMENT_BYTES),
    }),
};
