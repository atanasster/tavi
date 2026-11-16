import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { isPhone } from "../../hooks/page.js";
import type { CanvasRun } from "../chat/store/types.js";
import { notifyHidden } from "../needs/NeedNotify.js";
import type { LivePluginFrameClient } from "../plugin-host/PluginFrame.js";
import type { Session } from "../shell/shell.js";
import type { PanelPlace } from "../shell/use-panel-layout.js";
import { declineThrough, type TakeoverActions, type TakeoverTarget } from "./context.js";

/**
 * The takeover the page holds, how a card or panel opens one, and the
 * open chat's handoff: the panel opens for it (not on a phone, where it would cover
 * the card), and a hidden page is told.
 */
export function useTakeoverState({
  liveClient,
  workspaceId,
  current,
  asking,
  openSession,
  setPanel,
  handoffs,
}: {
  readonly liveClient: LivePluginFrameClient | undefined;
  readonly workspaceId: string;
  readonly current: Session | undefined;
  /** The open chat's handoff, if its task is waiting on one. */
  readonly asking: CanvasRun["run"]["waiting"];
  readonly openSession: string | undefined;
  readonly setPanel: Dispatch<SetStateAction<PanelPlace>>;
  /** The feed's count of handoffs waiting anywhere. */
  readonly handoffs: number | undefined;
}) {
  /**
   * Taking the agent's browser over:
   * the surface the canvas itself draws, opened from a handoff card, the chat
   * panel's live view or the Command Center's Browser.
   */
  const [takeover, setTakeover] = useState<TakeoverTarget>();
  /** The open chat's re-read after a hand-back, for its transcript row. */
  const rereadTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (rereadTimer.current !== undefined) window.clearTimeout(rereadTimer.current);
    },
    [],
  );
  const watchLive = liveClient?.liveWatch;
  const takeoverActions = useMemo<TakeoverActions | undefined>(
    () =>
      watchLive === undefined
        ? undefined
        : {
            open: setTakeover,
            decline: (target, note) => declineThrough(watchLive, workspaceId, target, note),
          },
    [liveClient, workspaceId],
  );
  /** Take over the open chat's browser: the session the agent asked about, else the one open now (or kept from its last turn). */
  const takeOverSession = asking?.handoff?.sessionId ?? openSession;
  /** The chat's turn has finished: its session is kept, with no turn to stop. */
  const finished =
    asking?.handoff === undefined &&
    current !== undefined &&
    current.status !== "working" &&
    current.status !== "submitted" &&
    current.status !== "input-required";
  const takeOverHere =
    current?.taskId === undefined || takeOverSession === undefined
      ? undefined
      : (): void =>
          setTakeover({
            taskId: current.taskId as string,
            sessionId: takeOverSession,
            ...(finished ? { kept: true as const } : {}),
            ...(asking?.handoff === undefined
              ? {}
              : {
                  handoff: {
                    ...(asking.handoff.instructions === undefined ? {} : { instructions: asking.handoff.instructions }),
                    deadlineAt: asking.deadlineAt,
                    reason: asking.handoff.reason,
                  },
                }),
          });
  const handoffKey = asking?.handoff === undefined ? undefined : `${current?.taskId ?? ""}:${asking.waitId ?? asking.deadlineAt}`;
  useEffect(() => {
    if (handoffKey === undefined || asking?.handoff === undefined) return;
    // Asked for: the panel opens (and with it the live view), and a hidden page is told. On a
    // phone the panel is a sheet over the transcript's lower half that would cover the hand-over
    // card's Take control, so there it stays as the person left it.
    if (!isPhone()) setPanel((now) => (now.open ? now : { ...now, open: true }));
    notifyHidden(
      "Tavi needs you in the browser",
      asking.handoff.instructions ?? "Take control to act in the page.",
      `handoff:${handoffKey}`,
    );
  }, [handoffKey]);
  // A handoff in a chat that is not open (or from the Command Center): the feed's count says one more waits.
  const seenHandoffs = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (handoffs === undefined) return;
    const before = seenHandoffs.current;
    seenHandoffs.current = handoffs;
    // The first count is the baseline; the open chat's own handoff is said above, with its instructions.
    if (before === undefined || handoffs <= before || asking?.handoff !== undefined) return;
    notifyHidden(
      "Tavi needs you in the browser",
      "A chat asks you to act in its browser. Open it to take control.",
      `handoffs:${handoffs}`,
    );
  }, [handoffs]);
  return { takeover, setTakeover, rereadTimer, takeoverActions, takeOverHere };
}
