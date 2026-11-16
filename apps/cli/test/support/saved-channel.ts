import { join } from "node:path";

import type { ChannelIngressSettings, MessagingConnectionInput } from "@tavi/contracts";
import { DatabaseClient } from "@tavi/runtime";

/**
 * A channel connection saved in the data directory before an owner starts, as
 * `tavi channels add` stores it, and, when given, the
 * webhook listener's settings. Its `credentialRefs` name secrets the owner
 * resolves: a test binds them with `credentials` or stores them itself.
 */
export async function saveChannelConnection(
  directory: string,
  connection: Omit<MessagingConnectionInput, "enabled" | "authState"> & Partial<Pick<MessagingConnectionInput, "enabled" | "authState">>,
  ingress?: ChannelIngressSettings,
): Promise<void> {
  const store = await DatabaseClient.open({
    databasePath: join(directory, "tavi.sqlite"),
    artifactsDirectory: join(directory, "artifacts"),
  });
  try {
    const now = "2026-01-01T00:00:00.000Z";
    await store.asPort().repositories.messagingConnections.save({ enabled: true, authState: "none", ...connection }, now);
    if (ingress !== undefined) await store.asPort().repositories.channelIngress.set(ingress, now);
  } finally {
    await store.close();
  }
}
