import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { DOCKED_MIN_WIDTH } from "../../lib/breakpoints.js";
import { saveChatPanel } from "../chat-panel/ChatPanel.js";
import type { PanelTab } from "../chat-panel/tabs.js";
import type { Navigate, PageRoute, Route } from "./route.js";
import { loadSidebarWidth } from "./SidebarFrame.js";
import { TRANSCRIPT_MIN_WIDTH } from "../../lib/layout.js";

/** The chat panel as the shell holds it: open or not, and on which tab. */
export interface PanelPlace {
  readonly open: boolean;
  readonly tab: PanelTab;
}

/** Whether a docked panel this wide leaves the transcript beside the sessions sidebar too narrow. */
function crowded(panelWidth: number): boolean {
  return window.innerWidth >= DOCKED_MIN_WIDTH && window.innerWidth - loadSidebarWidth() - panelWidth < TRANSCRIPT_MIN_WIDTH;
}

/**
 * The chat panel kept for the next visit and in the address, and docked
 * beside the transcript without crowding it out alongside the sessions sidebar.
 */
export function usePanelLayout({
  page,
  route,
  panel,
  setPanel,
  panelWidth,
  sidebar,
  setSidebar,
  navigate,
}: {
  readonly page: PageRoute;
  readonly route: Route;
  readonly panel: PanelPlace;
  readonly setPanel: Dispatch<SetStateAction<PanelPlace>>;
  readonly panelWidth: number;
  readonly sidebar: boolean;
  readonly setSidebar: Dispatch<SetStateAction<boolean>>;
  readonly navigate: Navigate;
}): void {
  useEffect(() => saveChatPanel(panel), [panel]);
  // The address names the panel's tab beside its session: a link or Back
  // that names one opens it, and the panel the reader
  // opens or closes is written back, so a refresh lands on the same tab.
  /** A tab the address named and the panel has not shown yet: not to be written over by the panel it replaces. */
  const panelFromAddress = useRef(false);
  useEffect(() => {
    if (page.panel === undefined || (panel.open && panel.tab === page.panel)) return;
    panelFromAddress.current = true;
    setPanel({ open: true, tab: page.panel });
  }, [page.panel]);
  useEffect(() => {
    if (panelFromAddress.current) {
      panelFromAddress.current = false;
      return;
    }
    if (route !== "chat" || page.taskId === undefined) return;
    const named = panel.open ? panel.tab : undefined;
    if (page.panel !== named) navigate((now) => ({ ...now, panel: named }), { replace: true });
  }, [route, page.taskId, panel]);
  // Docked beside the transcript, the panel and the sessions sidebar share the
  // window; when they would leave the transcript too narrow, the one the reader
  // opened last stays. Opening or widening the panel folds the sidebar (it is
  // one click back); opening the sidebar again closes the panel.
  const sidebarOpen = useRef(sidebar);
  useEffect(() => {
    if (route !== "chat" || !panel.open) return;
    const check = () => {
      if (sidebarOpen.current && crowded(panelWidth)) setSidebar(false);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [route, panel.open, panelWidth]);
  useEffect(() => {
    const opened = sidebar && !sidebarOpen.current;
    sidebarOpen.current = sidebar;
    if (opened && route === "chat" && panel.open && crowded(panelWidth)) setPanel((now) => ({ ...now, open: false }));
  }, [sidebar]);
}
