import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ChannelDescriptor, ChannelsCatalogAnswer, ChannelsListAnswer } from "@tavi/contracts";

import { useLoaded } from "../../hooks/use-loaded.js";
import { ask, mapOutcome, type SettingsClient } from "../../lib/ipc.js";

/**
 * What the page calls each channel:
 * a channel's label and icon from its descriptor, and a connection's channel
 * from the workspace's connections — so a channel a plugin adds is named in
 * the Command Center, the inbox and routines like the builtin ones, with no
 * name written here.
 */
export interface ChannelNames {
  /** A channel's name by its provider id; `undefined` for one not installed. */
  readonly label: (providerId: string) => string | undefined;
  /** A connection's channel's name by its connection id; `undefined` for one this workspace has not. */
  readonly connection: (connectionId: string) => string | undefined;
  readonly descriptor: (providerId: string) => ChannelDescriptor | undefined;
  /** Reads them again: after a connection is added or removed in Settings, or when the first read failed. */
  readonly refresh: () => void;
}

const NONE: ChannelNames = { label: () => undefined, connection: () => undefined, descriptor: () => undefined, refresh: () => undefined };
const ChannelNamesContext = createContext<ChannelNames>(NONE);

export function useChannelNames(): ChannelNames {
  return useContext(ChannelNamesContext);
}

/** Loads the catalog and the workspace's connections once; until they arrive, or if they cannot, names fall back to the ids. */
export function ChannelNamesProvider({
  client,
  workspaceId,
  children,
}: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly children: ReactNode;
}) {
  const { data: loaded, reload: refresh } = useLoaded(async () => {
    const quiet = { timeoutMs: 10_000, refused: "", unreachable: "" };
    const [catalog, list] = await Promise.all([
      ask<ChannelsCatalogAnswer>(client, "channels", { action: "catalog" }, quiet),
      ask<ChannelsListAnswer>(client, "channels", { action: "list", workspaceId }, quiet),
    ]);
    return mapOutcome(catalog, (value) => ({
      catalog: value.channels,
      providers: new Map<string, string>(
        list.ok ? list.value.connections.map((connection) => [connection.connectionId, connection.providerId]) : [],
      ),
    }));
  }, [client, workspaceId]);
  const names = useMemo((): ChannelNames => {
    if (loaded === undefined) return { ...NONE, refresh };
    const descriptor = (providerId: string): ChannelDescriptor | undefined =>
      loaded.catalog.find((candidate) => candidate.providerId === providerId);
    return {
      descriptor,
      refresh,
      label: (providerId) => descriptor(providerId)?.label,
      connection: (connectionId) => {
        const providerId = loaded.providers.get(connectionId);
        return providerId === undefined ? undefined : descriptor(providerId)?.label;
      },
    };
  }, [loaded, refresh]);
  return <ChannelNamesContext.Provider value={names}>{children}</ChannelNamesContext.Provider>;
}

/** The builtin glyphs a descriptor's `icon.name` may pick (24×24 strokes). */
const GLYPHS: Readonly<Record<string, ReactNode>> = {
  mail: (
    <>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </>
  ),
  send: (
    <>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </>
  ),
  phone: (
    <>
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </>
  ),
  chat: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
};
const KIND_GLYPH: Readonly<Record<ChannelDescriptor["kind"], string>> = { chat: "chat", email: "mail", sms: "phone" };

/** A channel's icon: the PNG its plugin ships, else the builtin glyph it names, else its kind's. Nothing for a channel not installed. */
export function ChannelIcon({ providerId }: { readonly providerId: string }) {
  const descriptor = useChannelNames().descriptor(providerId);
  if (descriptor === undefined) return null;
  if (descriptor.icon?.png !== undefined) return <img className="channel-icon" src={descriptor.icon.png} alt="" width={14} height={14} />;
  const glyph = GLYPHS[descriptor.icon?.name ?? ""] ?? GLYPHS[KIND_GLYPH[descriptor.kind]];
  return (
    <svg
      className="channel-icon"
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}
