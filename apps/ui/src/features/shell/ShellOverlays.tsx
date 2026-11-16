import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { CanvasRun, CanvasStore } from "../chat/store/types.js";
import type { useChatModel } from "../chat/use-chat-model.js";
import { NeedToast, NotifyOffer, type useNeedNotifications } from "../needs/NeedNotify.js";
import type { usePluginSlots } from "../plugin-host/use-plugin-slots.js";
import type { TakeoverTarget } from "../takeover/context.js";
import { TakeoverOverlay } from "../takeover/TakeoverOverlay.js";
import type { SettingsClient } from "../../lib/ipc.js";
import { KeySheet } from "./KeySheet.js";
import type { Navigate, Route } from "./route.js";
import type { shellState } from "./shell.js";
import { StatsStrip } from "./StatsStrip.js";
import type { useChatNavigation } from "./use-chat-navigation.js";

/**
 * What sits at the canvas's end: the stats strip (not on Setup), the keyboard
 * sheet, the offer to notify or a need's toast, and the takeover surface.
 */
export function ShellOverlays({
  setup,
  stats,
  target,
  targetError,
  chatModelLabel,
  route,
  sheet,
  setSheet,
  newLabel,
  newSession,
  navigate,
  needsNotice,
  follow,
  openSection,
  takeover,
  setTakeover,
  liveClient,
  client,
  state,
  current,
  running,
  store,
  rereadTimer,
}: {
  readonly setup: boolean;
  readonly stats: ReturnType<typeof shellState>["stats"];
  readonly target: ReturnType<typeof useChatModel>["target"];
  readonly targetError: ReturnType<typeof useChatModel>["targetError"];
  readonly chatModelLabel: ReturnType<typeof useChatModel>["chatModelLabel"];
  readonly route: Route;
  readonly sheet: boolean;
  readonly setSheet: Dispatch<SetStateAction<boolean>>;
  readonly newLabel: string;
  readonly newSession: ReturnType<typeof useChatNavigation>["newSession"];
  readonly navigate: Navigate;
  readonly needsNotice: ReturnType<typeof useNeedNotifications>;
  readonly follow: ReturnType<typeof useChatNavigation>["follow"];
  readonly openSection: ReturnType<typeof useChatNavigation>["openSection"];
  readonly takeover: TakeoverTarget | undefined;
  readonly setTakeover: (takeover: TakeoverTarget | undefined) => void;
  readonly liveClient: ReturnType<typeof usePluginSlots>["liveClient"];
  readonly client: SettingsClient;
  readonly state: ReturnType<CanvasStore["getSnapshot"]>;
  readonly current: ReturnType<typeof shellState>["current"];
  /** The running turn of the chat on screen. */
  readonly running: CanvasRun | undefined;
  readonly store: CanvasStore;
  readonly rereadTimer: MutableRefObject<number | undefined>;
}) {
  return (
    <>
      {setup ? null : (
        <StatsStrip
          stats={stats}
          target={chatModelLabel ?? target?.running}
          unconfigured={target?.unconfigured === true}
          afterRestart={target?.restartRequired === true ? target.afterRestart : undefined}
          unreadable={targetError !== undefined}
          chat={route === "chat"}
          onHelp={() => setSheet((open) => !open)}
        />
      )}
      {sheet ? (
        <KeySheet
          onClose={() => setSheet(false)}
          labels={{ newTask: newLabel }}
          onAction={{
            newTask: newSession,
            settings: () => navigate((current) => ({ ...current, route: "settings" })),
            models: () => navigate((current) => ({ ...current, route: "settings", view: "models" })),
          }}
        />
      ) : null}
      {needsNotice.offer ? (
        <NotifyOffer onAccept={needsNotice.accept} onDecline={needsNotice.decline} />
      ) : needsNotice.toast !== undefined ? (
        <NeedToast
          key={needsNotice.toast.need.needId}
          toast={needsNotice.toast}
          onOpen={(need) => {
            needsNotice.dismiss();
            // A worker is no chat: its need is decided in the chat that started it.
            void follow((need.kind === "approval" ? need.approval.rootTaskId : undefined) ?? need.taskId);
          }}
          onOpenAll={() => {
            needsNotice.dismiss();
            openSection("approvals");
          }}
          onDismiss={needsNotice.dismiss}
          onAnswered={needsNotice.answeredHere}
        />
      ) : null}
      {takeover === undefined || liveClient === undefined ? null : (
        <TakeoverOverlay
          takeover={takeover}
          setTakeover={setTakeover}
          client={liveClient}
          request={(command, payload) => client.request(command, payload)}
          home={state.home}
          directory={state.directory}
          current={current}
          running={running}
          store={store}
          rereadTimer={rereadTimer}
        />
      )}
    </>
  );
}
