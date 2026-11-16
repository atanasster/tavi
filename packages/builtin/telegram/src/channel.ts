import type { ChannelHostServices } from "@tavi/contracts";

import { createTelegramConnectorDefinition, TELEGRAM_CHANNEL_DESCRIPTOR, TELEGRAM_MAX_ATTACHMENT_BYTES } from "./connector.js";

/**
 * Telegram as the owner's catalog takes a builtin channel: its descriptor and
 * its connector made for an owner, in one entry, so core names the channel
 * once, where it lists it. An attachment is read no larger than Telegram takes.
 */
export const telegramChannel = {
  descriptor: TELEGRAM_CHANNEL_DESCRIPTOR,
  connector: (host: ChannelHostServices<typeof fetch>) =>
    createTelegramConnectorDefinition({
      now: host.now,
      fetch: host.fetch,
      readArtifact: (artifactId, workspaceId) => host.readArtifact(artifactId, workspaceId, TELEGRAM_MAX_ATTACHMENT_BYTES),
    }),
};
