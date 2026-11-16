import type { PluginUiPlacement } from "@tavi/contracts";
import { createContext, useContext, useMemo } from "react";

import { chatPluginState } from "../chat/store/runs.js";
import type { CanvasRun } from "../chat/store/types.js";

import { PluginFrame, type PluginFrameClient } from "./PluginFrame.js";
import { contributionKey, type ResolvedContribution } from "./slots.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * The Command Center's `center.browser` slot: a live session's card shows the browser view's contribution
 * there, live, in place of its thumbnail. At most `CENTER_LIVE_TILES` cards
 * do at once — each is a watch on the one owner connection every tab shares —
 * and the rest keep their thumbnails.
 */
export const CENTER_LIVE_TILES = 2;

export interface CenterBrowserSlot {
  readonly items: readonly (ResolvedContribution & { readonly placement: PluginUiPlacement })[];
  readonly client: PluginFrameClient;
  /** The canvas's turns, for what a plugin's own code published for a tile's task. */
  readonly runs?: readonly CanvasRun[];
}

export const CenterBrowserSlotContext = createContext<CenterBrowserSlot | undefined>(undefined);

export const useCenterBrowserSlot = (): CenterBrowserSlot | undefined => useContext(CenterBrowserSlotContext);

/** One session's live tile: the role's view first, else the first contribution placed here. */
export function LiveTile({
  slot,
  taskId,
  sessionId,
}: {
  readonly slot: CenterBrowserSlot;
  readonly taskId: string;
  readonly sessionId: string;
}) {
  const { workspaceId } = useWorkspace();
  const item = slot.items.find((candidate) => candidate.contribution.role === "browser-view") ?? slot.items[0];
  const modStates = useMemo(() => chatPluginState(slot.runs ?? [], taskId), [slot.runs, taskId]);
  if (item === undefined) return null;
  return (
    <PluginFrame
      // A new version, or another plugin, is a new frame: never the old document given the new one's role (invariant 3).
      key={`${contributionKey(item)}@${item.contentHash}`}
      className="browser-tile"
      resolved={item}
      slot="center.browser"
      placement={item.placement}
      context={{ workspaceId, taskId, sessionId }}
      client={slot.client}
      visible
      modState={modStates[item.pluginId]}
    />
  );
}
