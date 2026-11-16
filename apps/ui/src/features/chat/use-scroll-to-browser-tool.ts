import { useEffect } from "react";

import type { Session } from "../shell/shell.js";
import { transcriptWindow, TRANSCRIPT_HEAD } from "./store/runs.js";
import type { CanvasStore } from "./store/types.js";

/** A browser card followed from the Center: the task, and the tool call that opened its session. */
export interface BrowserToolTarget {
  readonly taskId: string;
  readonly callId: string;
  /** When it was asked for: a call the transcript never shows is given up on after a while. */
  readonly since: number;
}
/** How long a followed browser card waits for its task's transcript to show the call. */
const BROWSER_TOOL_WAIT_MS = 15_000;
/**
 * Brings the transcript to the call that opened a followed browser session
 * (`openedByCallId`). A turn folded in the middle is expanded first, so the
 * call is on the page; the call's card, and the block folding it, are opened
 * and scrolled to. The transcript replays in batches, so a call not shown yet
 * is waited for: only once every turn has settled, or the wait is over, does
 * the page settle for the task's top instead.
 */
export function useScrollToBrowserTool(
  target: BrowserToolTarget | undefined,
  session: Session | undefined,
  store: CanvasStore,
  done: (target: undefined) => void,
): void {
  useEffect(() => {
    if (target === undefined) return;
    const expired = Date.now() - target.since > BROWSER_TOOL_WAIT_MS;
    if (session?.taskId !== target.taskId) {
      if (expired) done(undefined);
      return;
    }
    const call = session.runs.flatMap((run) =>
      run.run.transcript.flatMap((entry, index) =>
        entry.kind === "tool" && entry.callId === target.callId ? [{ run, entry, index }] : [],
      ),
    )[0];
    if (call === undefined) {
      const settled = session.runs.length > 0 && session.runs.every((run) => run.run.status !== "idle" && run.run.status !== "running");
      if (!settled && !expired) return;
      done(undefined);
      const runs = document.querySelector<HTMLElement>(".runs");
      if (runs !== null) runs.scrollTop = 0;
      return;
    }
    const shown = transcriptWindow(call.run);
    if (shown.hidden > 0 && call.index >= TRANSCRIPT_HEAD && call.index < TRANSCRIPT_HEAD + shown.hidden) {
      store.setExpanded(call.run.id, true);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const card = [...document.querySelectorAll<HTMLElement>("[data-tool-key]")].find(
        (element) => element.dataset["toolKey"] === call.entry.key,
      );
      if (card === undefined) return;
      for (let node: HTMLElement | null = card; node !== null; node = node.parentElement)
        if (node instanceof HTMLDetailsElement) node.open = true;
      card.scrollIntoView?.({ block: "center" });
      done(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, session, store, done]);
}
