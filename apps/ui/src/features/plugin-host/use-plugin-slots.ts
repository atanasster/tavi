import { useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { TaviClient } from "@tavi/client/browser";
import type { PluginUiNavigation, PluginUiShortcut } from "@tavi/contracts";

import type { SettingsClient } from "../../lib/ipc.js";
import type { FeedRevisions } from "../center/feed.js";
import type { ChatPanelBadge } from "../chat-panel/ChatPanel.js";
import { pluginPanelTab } from "../chat-panel/tabs.js";
import { chatPluginState } from "../chat/store/runs.js";
import type { CanvasRun } from "../chat/store/types.js";
import type { BrowserToolTarget } from "../chat/use-scroll-to-browser-tool.js";
import type { CenterSection, Route } from "../shell/route.js";
import type { Session } from "../shell/shell.js";
import type { PanelPlace } from "../shell/use-panel-layout.js";
import { useOpenBrowserSession } from "./ChatPanelTop.js";
import { usePluginContributions } from "./contributions.js";
import type { LivePluginFrameClient, PluginFrameClient } from "./PluginFrame.js";
import { contributionKey, contributionsForSlot } from "./slots.js";

/**
 * Where UI plugins show on the page — the chat panel's top and tabs, the
 * Center's Browser and heartbeat, Welcome — and where a plugin asks to go.
 */
export function usePluginSlots({
  client,
  workspaceId,
  features,
  revisions,
  current,
  route,
  panel,
  setPanel,
  runs,
  sections,
  openSection,
  setToolTarget,
  setPane,
}: {
  readonly client: SettingsClient & Partial<Pick<TaviClient, "liveWatch">>;
  readonly workspaceId: string;
  readonly features: readonly string[];
  readonly revisions: FeedRevisions;
  readonly current: Session | undefined;
  readonly route: Route;
  readonly panel: PanelPlace;
  readonly setPanel: Dispatch<SetStateAction<PanelPlace>>;
  readonly runs: readonly CanvasRun[];
  readonly sections: readonly CenterSection[];
  readonly openSection: (section: CenterSection) => void;
  readonly setToolTarget: (target: BrowserToolTarget | undefined) => void;
  readonly setPane: (pane: "transcript") => void;
}) {
  /**
   * UI plugins: the contributions this
   * workspace shows, read again on each `plugin` change (a disabled or
   * rejected plugin's frames are torn down at once). The Browser's frames need
   * the live view, so a client without `liveWatch` shows none there; Welcome's
   * and the heartbeat panel's show either way.
   */
  const pluginUi = usePluginContributions(client, workspaceId, features.includes("plugins"), revisions.plugin ?? 0);
  // Kept for the client's life: a new one each render would reopen every live watch (and, for a takeover, drop what was typed).
  // Only an owner that offers the live view is asked for one: an older one would refuse every watch.
  const offersLive = features.includes("browser-live");
  const liveClient = useMemo<LivePluginFrameClient | undefined>(
    () => (client.liveWatch === undefined || !offersLive ? undefined : { liveWatch: client.liveWatch.bind(client) }),
    [client, offersLive],
  );
  const topItems = useMemo(() => contributionsForSlot(pluginUi.contributions, "chat.panel.top"), [pluginUi.contributions]);
  const tabItems = useMemo(() => contributionsForSlot(pluginUi.contributions, "chat.panel.tab"), [pluginUi.contributions]);
  // A contribution placed top and tab shows once: while its own tab is open, the top slot leaves it out.
  const shownTopItems = useMemo(
    () => topItems.filter((item) => panel.tab !== pluginPanelTab(contributionKey(item))),
    [topItems, panel.tab],
  );
  const centerBrowser = useMemo(() => {
    const items = contributionsForSlot(pluginUi.contributions, "center.browser");
    return liveClient === undefined || items.length === 0 ? undefined : { items, client: liveClient, runs: runs };
  }, [pluginUi.contributions, liveClient, runs]);
  // The selected heartbeat provider's own panel, where plugin frames are served.
  // An onboarding flow plugin's own info frames, for Welcome.
  // Neither needs the live view: their frames show with the page's own client, live or not; only the Browser does.
  const frameClient = useMemo<PluginFrameClient>(() => liveClient ?? {}, [liveClient]);
  const onboardingFrames = useMemo(() => {
    const items = contributionsForSlot(pluginUi.contributions, "onboarding.step");
    return items.length === 0 ? undefined : { items, client: frameClient };
  }, [pluginUi.contributions, frameClient]);
  const centerHeartbeat = useMemo(() => {
    const items = contributionsForSlot(pluginUi.contributions, "center.heartbeat");
    return items.length === 0 ? undefined : { items, client: frameClient };
  }, [pluginUi.contributions, frameClient]);
  const [pluginBadges, setPluginBadges] = useState<Readonly<Record<string, ChatPanelBadge>>>({});
  /** "While active": the chat's task is running and a browser session of its tree is open. */
  const chatRunning =
    current !== undefined && (current.status === "working" || current.status === "submitted" || current.status === "input-required");
  const chatShown = route === "chat" && panel.open;
  const runningSession = useOpenBrowserSession(client, workspaceId, current?.taskId, chatRunning && chatShown, revisions.browser ?? 0);
  // Once the turn has finished, the session it kept is still the person's to take over (the panel's Take control).
  const keptSession = useOpenBrowserSession(client, workspaceId, current?.taskId, !chatRunning && chatShown, revisions.browser ?? 0);
  /** The session the chat panel's Take control takes: the one in use, else the one the finished turn kept. */
  const openSession = runningSession ?? keptSession;
  const browserActive = runningSession !== undefined;
  /** Where a plugin asked to go. A plugin never opens a URL or a window: the canvas navigates. */
  const pluginNavigate = (pluginId: string, target: PluginUiNavigation): void => {
    if (target.to === "tool-call") {
      if (current?.taskId !== undefined) setToolTarget({ taskId: current.taskId, callId: target.callId, since: Date.now() });
      setPane("transcript");
    } else if (target.to === "center.browser" || target.slot === "center.browser") {
      if (sections.includes("browser")) openSection("browser");
    } else if (target.slot === "chat.panel.tab") {
      // That plugin's own tab, if it has one: never another plugin's.
      const own = tabItems.find((item) => item.pluginId === pluginId);
      if (own !== undefined) setPanel({ open: true, tab: pluginPanelTab(contributionKey(own)) });
    } else if (target.slot === "chat.panel.top") {
      // The top slot shows with the chat panel: open it, on whatever tab it had.
      if (topItems.some((item) => item.pluginId === pluginId)) setPanel((now) => (now.open ? now : { ...now, open: true }));
    }
  };
  /** A host shortcut a plugin's frame caught: handled as if pressed on the page. */
  const pluginShortcut = (key: PluginUiShortcut): void => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", key === "Escape" ? { key: "Escape" } : { key: ".", code: "Period", metaKey: true, shiftKey: true }),
    );
  };
  const pluginContext = { workspaceId, ...(current?.taskId === undefined ? {} : { taskId: current.taskId }) };
  /** What each plugin's own code published for the chat in view. */
  const modStates = useMemo(() => chatPluginState(runs, current?.taskId), [runs, current?.taskId]);
  return {
    liveClient,
    tabItems,
    shownTopItems,
    centerBrowser,
    onboardingFrames,
    centerHeartbeat,
    pluginBadges,
    setPluginBadges,
    openSession,
    chatActive: { running: chatRunning, browser: browserActive },
    pluginNavigate,
    pluginShortcut,
    pluginContext,
    modStates,
  };
}
