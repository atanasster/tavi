import type { Dispatch, SetStateAction } from "react";

import { CenterNav } from "../center/CenterNav.js";
import type { CanvasStore } from "../chat/store/types.js";
import { SessionDirectory } from "../sessions/SessionDirectory.js";
import { SettingsNav } from "../settings/SettingsNav.js";
import { ViewBoundary } from "../../ui/ViewBoundary.js";
import type { Route, SettingsView } from "./route.js";
import type { shellState } from "./shell.js";
import { SidebarRail } from "./SidebarFrame.js";
import type { useChatNavigation } from "./use-chat-navigation.js";
import type { useOwnerFeatures } from "./use-owner-features.js";

/**
 * The shell's left zone: the Center's nav on the Center and Settings' on
 * Settings (each a strip of tabs on a phone), the chat list on Chat and Ideas,
 * each folded to its rail; nothing on Setup.
 */
export function ShellSidebar({
  route,
  setup,
  sidebar,
  setSidebar,
  phone,
  section,
  summary,
  sections,
  openSection,
  state,
  store,
  homeChat,
  principal,
  current,
  select,
  foldOnPhone,
  newSession,
  newLabel,
  newPrivateSession,
  newOwnSession,
  openHome,
  settingsView,
  ideas,
  onSettingsView,
}: {
  readonly route: Route;
  /** Setup is a page of its own: no chats beside it. */
  readonly setup: boolean;
  /** The sidebar is open, not folded to its rail. */
  readonly sidebar: boolean;
  readonly setSidebar: Dispatch<SetStateAction<boolean>>;
  readonly phone: boolean;
  readonly section: ReturnType<typeof useOwnerFeatures>["section"];
  readonly summary: Parameters<typeof CenterNav>[0]["summary"];
  readonly sections: ReturnType<typeof useOwnerFeatures>["sections"];
  readonly openSection: ReturnType<typeof useChatNavigation>["openSection"];
  readonly state: ReturnType<CanvasStore["getSnapshot"]>;
  readonly store: CanvasStore;
  readonly homeChat: boolean;
  readonly principal: string | undefined;
  readonly current: ReturnType<typeof shellState>["current"];
  readonly select: ReturnType<typeof useChatNavigation>["select"];
  /** On a phone, picking a chat folds the sidebar again. */
  readonly foldOnPhone: () => void;
  readonly newSession: ReturnType<typeof useChatNavigation>["newSession"];
  readonly newLabel: string;
  readonly newPrivateSession: ReturnType<typeof useChatNavigation>["newPrivateSession"];
  readonly openHome: ReturnType<typeof useChatNavigation>["openHome"];
  readonly newOwnSession: ReturnType<typeof useChatNavigation>["newOwnSession"];
  /** The Settings view on screen, and the owner offers Ideas. */
  readonly settingsView: SettingsView;
  readonly ideas: boolean;
  readonly onSettingsView: (view: SettingsView) => void;
}) {
  return (
    <ViewBoundary resetKey={route} what="panel">
      {setup ? null : route === "center" ? (
        sidebar || phone ? (
          <CenterNav section={section} summary={summary} sections={sections} onSection={openSection} onCollapse={() => setSidebar(false)} />
        ) : (
          <SidebarRail panel="center" onExpand={() => setSidebar(true)} />
        )
      ) : route === "settings" ? (
        sidebar || phone ? (
          <SettingsNav view={settingsView} ideas={ideas} onView={onSettingsView} onCollapse={() => setSidebar(false)} />
        ) : (
          <SidebarRail panel="settings" onExpand={() => setSidebar(true)} />
        )
      ) : sidebar ? (
        <SessionDirectory
          state={state}
          store={store}
          homeChat={homeChat}
          principal={principal}
          selected={current?.key}
          onSelect={(taskId) => {
            select(taskId);
            foldOnPhone();
          }}
          onNew={newSession}
          newLabel={newLabel}
          onNewPrivate={newPrivateSession}
          onNewOwn={homeChat ? newOwnSession : undefined}
          onHome={() => {
            openHome();
            foldOnPhone();
          }}
          onCollapse={() => setSidebar(false)}
        />
      ) : (
        <SidebarRail
          onExpand={() => setSidebar(true)}
          onNew={newSession}
          newLabel={newLabel}
          onNewOwn={homeChat ? newOwnSession : undefined}
        />
      )}
    </ViewBoundary>
  );
}
