import type { CanvasStore } from "../chat/store/types.js";
import { useNow } from "../../hooks/use-poll.js";
import { announcementOf, useAnnouncer, useSaidOnce } from "./a11y.js";
import type { Route } from "./route.js";
import type { shellState } from "./shell.js";

/** What the shell says out loud, as `announcementOf` words it, of the session on screen. */
export function useShellAnnouncer({
  state,
  current,
  shell,
  routeError,
  route,
  centered,
  freshReminders,
  waiting,
}: {
  readonly state: ReturnType<CanvasStore["getSnapshot"]>;
  readonly current: ReturnType<typeof shellState>["current"];
  readonly shell: ReturnType<typeof shellState>;
  /** Why the address could not be followed, when it could not. */
  readonly routeError: string | undefined;
  readonly route: Route;
  /** The owner offers the Center. */
  readonly centered: boolean;
  /** Reminders fired since the page last said them. */
  readonly freshReminders: Parameters<typeof useSaidOnce>[0];
  /** What waits on the reader, as the tab title counts it. */
  readonly waiting: number;
}): void {
  // What the page says out loud: the handful of discrete events, never tokens.
  // Its subject is the session the reader is looking at — the same one the
  // chords act on — so a chord and the announcement cannot describe different tasks.
  // A fired reminder is said once, with the sentence it arrives in, not again with every later change.
  // While the session in view waits on a question, the clock moves the announcement into its last five minutes.
  // Only on the chat page: elsewhere (the inbox) the card in view says it, and twice would be noise.
  const askingNow = route === "chat" && current?.runs.at(-1)?.run.waiting?.question !== undefined;
  const askingClock = useNow(30_000, askingNow);
  const spoken = { state, current, needs: shell.needs, notice: routeError, ...(askingNow ? { now: askingClock } : {}) };
  const reminderTexts = useSaidOnce(
    centered ? freshReminders : [],
    announcementOf({ ...spoken, ...(centered ? { center: { waiting, reminders: [] } } : {}) }),
  );
  useAnnouncer(announcementOf({ ...spoken, ...(centered ? { center: { waiting, reminders: reminderTexts } } : {}) }));
}
