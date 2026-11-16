import { type ChannelHost, primaryCredentialRef } from "@tavi/runtime";
import { channelDescriptorOf } from "../features/channels/catalog.js";
import { TaviError, channelIdentity } from "@tavi/contracts";
import { ANY_DESTINATION, parseDestinationEntry } from "../features/channels/destination.js";
import type { TaviRuntimeOptions } from "./types.js";

/**
 * The connections this runtime is configured to open, whatever their channel:
 * what a routine may deliver through and an allowlist
 * entry may name.
 */
export function externalConnectionsOf(host: ChannelHost): readonly {
  readonly connectionId: string;
  readonly workspaceId: string;
  readonly credentialRef: string | undefined;
  readonly providerId: string;
}[] {
  return host
    .configured()
    .filter((record) => record.enabled)
    .map((record) => ({
      connectionId: record.connectionId,
      workspaceId: record.workspaceId,
      providerId: record.providerId,
      credentialRef: primaryCredentialRef(record, channelDescriptorOf(record.providerId)),
    }));
}

/**
 * `options` with each `--messaging-allow-destination` target in its channel's
 * own form — `Ana@Example.com` becomes the
 * `ana@example.com` a normalized send target is compared with — so the
 * allowlist and every send through it agree. An entry that is not a target on
 * its connection's channel stops startup, naming it. An entry for no
 * configured connection is left for `assertDestinationEntries` to refuse.
 */
export function withChannelDestinations(options: TaviRuntimeOptions, host: ChannelHost): TaviRuntimeOptions {
  const connections = externalConnectionsOf(host);
  const entries = options.messagingAllowedDestinations;
  if (entries === undefined) return options;
  const normalized = entries.map((entry) => {
    const parsed = parseDestinationEntry(entry);
    const connectionId = parsed?.connectionId ?? (connections.length === 1 ? connections[0]?.connectionId : undefined);
    const descriptor = channelDescriptorOf(connections.find((connection) => connection.connectionId === connectionId)?.providerId);
    // A wildcard, or a target meant for every channel, has no one channel's form to take.
    if (parsed === undefined || descriptor === undefined || parsed.chatId === ANY_DESTINATION || parsed.connectionId === ANY_DESTINATION)
      return entry;
    const target = channelIdentity(parsed.chatId, descriptor.target);
    if (target === undefined)
      throw new TaviError(
        "INVALID_INPUT",
        `--messaging-allow-destination entry ${JSON.stringify(entry)} is not a ${descriptor.target.label.toLowerCase()} on ${descriptor.label}`,
      );
    return parsed.connectionId === undefined ? target : `${parsed.connectionId}:${target}`;
  });
  return { ...options, messagingAllowedDestinations: normalized };
}
