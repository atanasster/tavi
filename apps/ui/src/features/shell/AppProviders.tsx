import type { ContextType, ReactNode } from "react";

import type { SettingsClient } from "../../lib/ipc.js";
import { ConnectCardContext, type ConnectCardPage } from "../apps/ConnectCard.js";
import { CenterBrowserSlotContext, type CenterBrowserSlot } from "../plugin-host/CenterBrowserSlot.js";
import { CenterHeartbeatSlotContext, type CenterHeartbeatSlot } from "../plugin-host/CenterHeartbeatSlot.js";
import { PluginFramesCoveredContext } from "../plugin-host/PluginFrame.js";
import { TakeoverContext, type TakeoverActions } from "../takeover/context.js";
import { FillDownloadContext, PreviewImageContext } from "../transcript/FillReview.js";
import { OpenChatContext } from "../transcript/ToolCards.js";
import { ChannelNamesProvider } from "./ChannelNames.js";
import { WorkspaceProvider } from "./Workspace.js";

/** What every view below the shell reads from context rather than props. */
export function AppProviders({
  client,
  workspaceId,
  timeZone,
  takeover,
  covered,
  centerBrowser,
  centerHeartbeat,
  openChat,
  connectCards,
  readPreview,
  downloadFilled,
  children,
}: {
  readonly client: SettingsClient;
  readonly workspaceId: string;
  readonly timeZone: string | undefined;
  readonly takeover: TakeoverActions | undefined;
  /** A takeover is open over the page: plugin frames under it stand down. */
  readonly covered: boolean;
  readonly centerBrowser: CenterBrowserSlot | undefined;
  readonly centerHeartbeat: CenterHeartbeatSlot | undefined;
  readonly openChat: (taskId: string) => void;
  readonly connectCards: ConnectCardPage;
  readonly readPreview: NonNullable<ContextType<typeof PreviewImageContext>>;
  readonly downloadFilled: (path: string) => Promise<string | undefined>;
  readonly children: ReactNode;
}) {
  return (
    <ChannelNamesProvider client={client} workspaceId={workspaceId}>
      <TakeoverContext.Provider value={takeover}>
        <CenterBrowserSlotContext.Provider value={centerBrowser}>
          <CenterHeartbeatSlotContext.Provider value={centerHeartbeat}>
            <PluginFramesCoveredContext.Provider value={covered}>
              <OpenChatContext.Provider value={openChat}>
                <WorkspaceProvider client={client} workspaceId={workspaceId} timeZone={timeZone}>
                  <ConnectCardContext.Provider value={connectCards}>
                    <PreviewImageContext.Provider value={readPreview}>
                      <FillDownloadContext.Provider value={downloadFilled}>{children}</FillDownloadContext.Provider>
                    </PreviewImageContext.Provider>
                  </ConnectCardContext.Provider>
                </WorkspaceProvider>
              </OpenChatContext.Provider>
            </PluginFramesCoveredContext.Provider>
          </CenterHeartbeatSlotContext.Provider>
        </CenterBrowserSlotContext.Provider>
      </TakeoverContext.Provider>
    </ChannelNamesProvider>
  );
}
