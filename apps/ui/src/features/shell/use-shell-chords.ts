import type { Dispatch, SetStateAction } from "react";

import { abortableRun, decidableRound } from "../chat/store/runs.js";
import type { CanvasStore } from "../chat/store/types.js";
import { CHAT_PANEL_TABS, type ChatPanelTab } from "../chat-panel/tabs.js";
import type { TakeoverTarget } from "../takeover/context.js";
import { useKeyboard } from "./keys.js";
import type { Route } from "./route.js";
import type { shellState } from "./shell.js";
import type { PanelPlace } from "./use-panel-layout.js";

/**
 * The chords the shell keeps: help, search, the sidebar, the chat panel and
 * its tabs, Escape (an expanded browser view first, then the running turn),
 * and approving or rejecting the round that waits. Answers the running turn
 * of the chat on screen, which the takeover overlay stops too.
 */
export function useShellChords({
  current,
  store,
  route,
  sheet,
  setSheet,
  setSidebar,
  setPanel,
  openPanel,
  browserExpanded,
  setBrowserExpanded,
  takeover,
}: {
  readonly current: ReturnType<typeof shellState>["current"];
  readonly store: CanvasStore;
  readonly route: Route;
  /** The keyboard sheet is up. */
  readonly sheet: boolean;
  readonly setSheet: Dispatch<SetStateAction<boolean>>;
  readonly setSidebar: Dispatch<SetStateAction<boolean>>;
  readonly setPanel: Dispatch<SetStateAction<PanelPlace>>;
  readonly openPanel: (tab: ChatPanelTab) => void;
  readonly browserExpanded: boolean;
  readonly setBrowserExpanded: (expanded: boolean) => void;
  readonly takeover: TakeoverTarget | undefined;
}) {
  // The chords the page can keep.
  const deciding = current?.runs.find((run) => decidableRound(run) !== undefined);
  const running = current?.runs.find(abortableRun);
  useKeyboard({
    help: () => setSheet((open) => !open),
    ...(!sheet
      ? {
          search: () => {
            setSidebar(true);
            requestAnimationFrame(() => document.getElementById("session-search")?.focus());
          },
        }
      : {}),
    ...(sheet ? {} : { sidebar: () => setSidebar((open) => !open) }),
    ...(sheet || route !== "chat"
      ? {}
      : {
          panel: () => setPanel((now) => ({ ...now, open: !now.open })),
          ...Object.fromEntries(CHAT_PANEL_TABS.map((tab) => [`panel-${tab}`, () => openPanel(tab)])),
        }),
    // While the sheet is up, Escape is its dialog's (`KeySheet`), never a
    // running turn's. While the person is in the page, Escape is the page's.
    // An expanded browser view shrinks back first, so it never stops the turn it shows.
    ...(browserExpanded
      ? { stop: () => setBrowserExpanded(false) }
      : running === undefined || takeover !== undefined
        ? {}
        : { stop: () => store.abort(running.id) }),
    ...(sheet || deciding === undefined
      ? {}
      : {
          approve: () => {
            [...document.querySelectorAll<HTMLButtonElement>(".approval-trigger")]
              .find((button) => button.dataset["run"] === deciding.id)
              ?.click();
          },
          reject: () => store.decide(deciding.id, false),
        }),
  });
  return running;
}
