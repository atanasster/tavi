import type { PluginUiPlacement } from "@tavi/contracts";
import { createContext, useContext, useRef } from "react";

import { PluginFrame, type PluginFrameClient } from "./PluginFrame.js";
import { contributionKey, type ResolvedContribution } from "./slots.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * The `center.heartbeat` slot: the selected
 * heartbeat provider's own panel, under *More* in Center → Heartbeat. Only the
 * contribution of the plugin that is the selected provider shows; choosing
 * another provider removes it. The header, rail and notices stay Tavi's own.
 */
export interface CenterHeartbeatSlot {
  readonly items: readonly (ResolvedContribution & { readonly placement: PluginUiPlacement })[];
  readonly client: PluginFrameClient;
}

export const CenterHeartbeatSlotContext = createContext<CenterHeartbeatSlot | undefined>(undefined);

export const useCenterHeartbeatSlot = (): CenterHeartbeatSlot | undefined => useContext(CenterHeartbeatSlotContext);

/** The selected provider's panel, given what it published (its `mod.state` channel); nothing when it contributes none. */
export function ProviderPanel({
  slot,
  providerId,
  state,
}: {
  readonly slot: CenterHeartbeatSlot;
  readonly providerId: string;
  readonly state?: Readonly<Record<string, unknown>> | undefined;
}) {
  const { workspaceId } = useWorkspace();
  const item = slot.items.find((candidate) => candidate.pluginId === providerId);
  // Re-read every few seconds as a new object: the same values stay the same object, so the frame is sent only changes.
  const kept = useRef<{ readonly json: string; readonly state: Readonly<Record<string, unknown>> | undefined }>({
    json: "null",
    state: undefined,
  });
  const json = JSON.stringify(state ?? null);
  if (kept.current.json !== json) kept.current = { json, state };
  if (item === undefined) return null;
  return (
    <PluginFrame
      // Another provider, or a new version, is a new frame: never the old document given the new one's state.
      key={`${contributionKey(item)}@${item.contentHash}`}
      className="heartbeat-provider-panel"
      resolved={item}
      slot="center.heartbeat"
      placement={item.placement}
      context={{ workspaceId }}
      client={slot.client}
      visible
      modState={kept.current.state}
    />
  );
}
