import {
  BROWSER_LIVE_CHECK_INTERVAL_MS,
  BROWSER_LIVE_CONTROL_MAX_FRAME_BYTES,
  BROWSER_LIVE_CONTROL_MAX_WIDTH,
  BROWSER_LIVE_CONTROL_QUALITY,
  BROWSER_LIVE_ENDED_TASK,
  BROWSER_LIVE_INPUT_MAX_EVENTS,
  BROWSER_LIVE_MAX_FRAME_BYTES,
  BROWSER_LIVE_MAX_SCREENCASTS,
  BROWSER_LIVE_MAX_WIDTH,
  BROWSER_LIVE_MIN_WIDTH,
  BROWSER_LIVE_NOTE_MAX,
  BROWSER_LIVE_QUALITY,
  BROWSER_LIVE_TAKE_WAIT_MS,
  BROWSER_LIVE_UNATTENDED_MS,
  BROWSER_LIVE_UPLOAD_MAX_BYTES,
  TaviError,
  clipBrowserTitle,
  refusedShortcut,
  scrubBrowserUrl,
  type BrowserLiveControl,
  type BrowserLiveControlChange,
  type BrowserLiveControlOutcome,
  type BrowserLiveControlState,
  type BrowserLiveFrameMetadata,
  type BrowserLiveInputEvent,
  type BrowserLiveMessage,
  type BrowserLivePhoneViewport,
  type BrowserLiveSessionInfo,
  type BrowserLiveSessionState,
  type BrowserLiveSink,
  type BrowserLiveWatch,
  type LiveTargetFrame,
  type LiveTarget,
  type LiveDialogInfo,
  type LiveControlTarget,
  type LiveActionEvent,
  type BrowserLiveSource,
} from "@tavi/contracts";
import type { Page } from "playwright";

import { PASSWORD_SELECTOR, PAYMENT_SELECTOR, playwrightSensitivePage, sensitivityOf, type SensitiveReason } from "./sensitivity.js";

/**
 * The live view's producer: a
 * session's page as a stream of JPEG frames, from the DevTools screencast,
 * only while someone watches it. Nothing here is stored.
 *
 * - **Demand-driven, shared.** A session's first watcher starts its
 *   screencast, at the widest width any of its watchers asked for; the last
 *   one leaving stops it. At most `BROWSER_LIVE_MAX_SCREENCASTS` run at once:
 *   a watcher past that is told `hidden { paused }` and starts when one frees.
 *   A page swap (a click that opened a new tab) moves the screencast.
 * - **Flow control.** Chromium renders the next frame only once the last is
 *   acknowledged. A frame is acknowledged as soon as one watcher can take
 *   another (its sink answers `true`); otherwise the acknowledgement waits for
 *   a watcher's `demand()`. A frame held back by the gate is not acknowledged
 *   either, so a page nobody can be shown costs nothing.
 * - **Hold until checked.** The sensitivity rules (`sensitivity.ts`) run on
 *   every navigation, and at most every `BROWSER_LIVE_CHECK_INTERVAL_MS`
 *   while frames flow. A frame is sent only when it was taken after the page
 *   was last found clear and within that interval of the last passing check;
 *   otherwise it waits for the next check. A failing check (or one that
 *   throws) sends `hidden`, drops frames and strips action boxes. When a page
 *   clears, the screencast restarts so the first frame shown was taken after
 *   the passing check.
 *
 * - **Takeover.** A session's control state — `agent`,
 *   `requested`, `operator` — lives here, beside its stream. One watch at a
 *   time is the controller: it alone may send input, answer a `<select>` or a
 *   dialog, and hand back. A take waits for the agent's call in flight to
 *   settle, and while anyone but the agent acts, the adapter's browser calls
 *   are refused (`agentCall`). The controller's stream is sharper and wider,
 *   and is the one exception to hold-until-checked: a person signing in must
 *   see the sign-in page. Every other watcher is still told `hidden`.
 * - **Blind takeover (invariant 8).** Input is applied in order through one
 *   queue per session and dropped: never logged, reported or kept. A failure
 *   applying it is reported without the event.
 *
 * The adapter (`playwright.ts`) reports what happens to its sessions through
 * `BrowserLiveSource`'s hooks; the owner's hub watches through the port.
 */

export type {
  LiveTargetFrame,
  LiveTarget,
  LiveSelectInfo,
  LiveDialogInfo,
  LiveControlTarget,
  LiveSessionOpening,
  LiveActionEvent,
  BrowserLiveSource,
} from "@tavi/contracts";

export interface BrowserLiveSourceOptions {
  /** Milliseconds; injectable for tests. */
  readonly now?: () => number;
  /** Where a failure inside the producer is reported. */
  readonly onError?: (error: unknown) => void;
}

/** Frame qualities tried in turn when a frame comes out past `BROWSER_LIVE_MAX_FRAME_BYTES`. */
const QUALITY_STEPS = [BROWSER_LIVE_QUALITY, 45, 30] as const;
/** The same while a person controls the session, under `BROWSER_LIVE_CONTROL_MAX_FRAME_BYTES`. */
const CONTROL_QUALITY_STEPS = [BROWSER_LIVE_CONTROL_QUALITY, BROWSER_LIVE_QUALITY, 45] as const;

interface Watcher {
  readonly maxWidth: number;
  readonly sink: BrowserLiveSink;
  /** Waiting for a free screencast slot. */
  paused: boolean;
  /** The width it asked for as the controller. */
  controlWidth?: number;
  closed?: boolean;
}

interface Control {
  state: BrowserLiveControlState;
  /** The watch holding input; `undefined` while the operator's control is unattended (its tab left). */
  controller: Watcher | undefined;
  /** A take waiting for the agent's step in flight. */
  taking: Watcher | undefined;
  /** When the operator took it (ms). */
  since: number;
  /** Whether the agent asked for it (`requested` before the take): then its wait's deadline bounds it, not the owner's. */
  asked: boolean;
  /** Hands an unattended grab back after `BROWSER_LIVE_UNATTENDED_MS`. */
  unattended: ReturnType<typeof setTimeout> | undefined;
  /** When the controlling tab left (ms), while no tab holds it. */
  leftAt: number | undefined;
  /** Undoes the target's `begin`. */
  end: (() => Promise<void>) | undefined;
  /** Agent calls running now. */
  inFlight: number;
  /** How many times a person has taken the session, asked or not: the adapter withholds what they may have typed. */
  takes: number;
  idle: (() => void)[];
  /** The serial input queue. */
  queue: Promise<void>;
  /** The open `<select>` picker's ref. */
  selectRef: string | undefined;
  /** A press opened a picker: its release is not sent either. */
  swallowUp: boolean;
  /** A dialog waiting for an answer, re-sent to a controller that takes over. */
  dialog: LiveDialogInfo | undefined;
  /** The page's open file chooser, re-sent to a controller that takes over. */
  chooser: { readonly multiple: boolean; readonly accept?: string } | undefined;
  /** Files arriving for it, in order; held in memory only until the page takes them. */
  upload: Upload | undefined;
}

interface Upload {
  readonly count: number;
  readonly files: { readonly name: string; readonly type: string; readonly size: number; readonly chunks: Buffer[]; received: number }[];
}

/** Shared with the canvas, which drops them before sending (`@tavi/contracts`). */
export { refusedShortcut } from "@tavi/contracts";

interface Held {
  readonly frame: LiveTargetFrame;
  readonly at: number;
}

interface LiveSession {
  readonly info: { -readonly [K in keyof BrowserLiveSessionInfo]: BrowserLiveSessionInfo[K] };
  readonly workspaceId: string;
  target: LiveTarget;
  /** The navigation count the browser last reported for its page: a person's own navigation is told under it. */
  epoch: number;
  readonly blockedHosts: () => Promise<readonly string[]>;
  readonly watchers: Set<Watcher>;
  thumbnail: Uint8Array | undefined;
  /** The running screencast, or the promise of one starting. */
  cast: Promise<{ stop(): Promise<void> }> | undefined;
  castWidth: number;
  qualityStep: number;
  /** Bumped whenever the screencast restarts, so frames of an older one are ignored. */
  generation: number;
  stopNavigated: () => void;
  /** When the page was first found clear in the current run of passing checks; `undefined` while it is not known clear. */
  clearSince: number | undefined;
  /** When the last passing check started. */
  lastPass: number | undefined;
  lastCheckStart: number | undefined;
  checking: boolean;
  /** Set when a check is wanted while one runs. */
  recheck: boolean;
  hidden: SensitiveReason | undefined;
  recheckTimer: ReturnType<typeof setTimeout> | undefined;
  /** A frame the gate holds, unacknowledged. */
  held: Held | undefined;
  /** A delivered frame whose acknowledgement waits for a watcher's demand. */
  owed: LiveTargetFrame | undefined;
  readonly controlTarget: LiveControlTarget | undefined;
  readonly control: Control;
  /** The last frame's metadata: the viewport input is clamped to. */
  lastMetadata: BrowserLiveFrameMetadata | undefined;
  /** An action waiting for the operator's approval, for a watcher who arrives meanwhile. */
  pending: LiveActionEvent | undefined;
  /** Stops the page's own sensitive-field watch, while a screencast runs. */
  stopSensitive: Promise<(() => Promise<void>) | undefined> | undefined;
}

export function createBrowserLiveSource(options: BrowserLiveSourceOptions = {}): BrowserLiveSource {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, LiveSession>();
  const listeners = new Set<(workspaceId: string, info: BrowserLiveSessionInfo) => void>();
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A reporter that throws must not break the stream.
    }
  };

  const infoOf = (session: LiveSession): BrowserLiveSessionInfo => ({ ...session.info });

  function announce(session: LiveSession): void {
    for (const listener of listeners) {
      try {
        listener(session.workspaceId, infoOf(session));
      } catch (error) {
        report(error);
      }
    }
  }

  function send(session: LiveSession, message: BrowserLiveMessage, watchers: Iterable<Watcher> = session.watchers): boolean {
    let wantsMore = false;
    for (const watcher of watchers) {
      try {
        if (watcher.sink(message)) wantsMore = true;
      } catch (error) {
        report(error);
      }
    }
    return wantsMore;
  }

  const controlListeners = new Set<(change: BrowserLiveControlChange) => void>();
  function emitControl(change: BrowserLiveControlChange): void {
    for (const listener of controlListeners) {
      try {
        listener(change);
      } catch (error) {
        report(error);
      }
    }
  }

  const castingCount = (): number => [...sessions.values()].filter((session) => session.cast !== undefined).length;
  /** The watch that holds input now, if a person controls the session and is there. */
  const controllerOf = (session: LiveSession): Watcher | undefined =>
    session.control.state === "operator" ? session.control.controller : undefined;
  const widthOf = (session: LiveSession): number => {
    const controlWidth = controllerOf(session)?.controlWidth;
    if (controlWidth !== undefined) return controlWidth;
    return Math.min(BROWSER_LIVE_MAX_WIDTH, Math.max(0, ...[...session.watchers].map((watcher) => watcher.maxWidth)));
  };
  /** The qualities a stream steps down through: sharper while a person controls it. */
  const qualitiesOf = (session: LiveSession): readonly number[] =>
    controllerOf(session) === undefined ? QUALITY_STEPS : CONTROL_QUALITY_STEPS;
  const frameCapOf = (session: LiveSession): number =>
    controllerOf(session) === undefined ? BROWSER_LIVE_MAX_FRAME_BYTES : BROWSER_LIVE_CONTROL_MAX_FRAME_BYTES;
  /** Every watcher but the controller: what `hidden` goes to while a person signs in. */
  const othersThan = (session: LiveSession, watcher: Watcher | undefined): Watcher[] =>
    [...session.watchers].filter((candidate) => candidate !== watcher);

  /** Starts, restarts or stops `session`'s screencast to match its watchers. */
  function reconcile(session: LiveSession, force = false): void {
    // A kept session (its task over) streams only while a person holds it.
    const wanted =
      session.watchers.size > 0 &&
      (session.info.state === "open" || (session.info.state === "inactive" && session.control.state === "operator"));
    if (!wanted) {
      const freed = session.cast !== undefined;
      unwatchSensitive(session);
      stopCast(session);
      clearRecheck(session);
      if (freed) releaseSlot(session);
      return;
    }
    const width = widthOf(session);
    if (session.cast !== undefined && !force && width === session.castWidth) return;
    if (session.cast === undefined && castingCount() >= BROWSER_LIVE_MAX_SCREENCASTS) {
      for (const watcher of session.watchers) {
        if (watcher.paused) continue;
        watcher.paused = true;
        send(session, { kind: "hidden", sessionId: session.info.sessionId, reason: "paused" }, [watcher]);
      }
      return;
    }
    stopCast(session);
    for (const watcher of session.watchers) watcher.paused = false;
    startCast(session, width);
  }

  function startCast(session: LiveSession, width: number): void {
    session.generation += 1;
    const generation = session.generation;
    session.castWidth = width;
    const qualities = qualitiesOf(session);
    const quality = qualities[session.qualityStep] ?? qualities[0] ?? BROWSER_LIVE_QUALITY;
    session.cast = session.target.screencast({ maxWidth: width, quality }, (frame) => onFrame(session, generation, frame));
    watchSensitive(session);
    session.cast.catch((error: unknown) => {
      report(error);
      if (session.generation !== generation) return;
      // It never ran: its watchers wait, as for a slot, and the slot goes to another.
      session.cast = undefined;
      for (const watcher of session.watchers) {
        if (watcher.paused) continue;
        watcher.paused = true;
        send(session, { kind: "hidden", sessionId: session.info.sessionId, reason: "paused" }, [watcher]);
      }
      releaseSlot(session);
    });
    // Check the page as the stream starts. Frames wait for a passing check,
    // and a check still running (of the page before a swap) is made stale.
    check(session, true);
  }

  /** A screencast slot freed: the first other session with paused watchers starts. */
  function releaseSlot(freedBy: LiveSession): void {
    for (const other of sessions.values()) {
      if (other !== freedBy && other.cast === undefined && [...other.watchers].some((watcher) => watcher.paused)) {
        reconcile(other);
        return;
      }
    }
  }

  /**
   * A sensitive field appearing is checked at once, not at the next interval:
   * one watch of the session's page, kept across screencast restarts, ended
   * only when the stream does or the page is another (`unwatchSensitive`).
   */
  function watchSensitive(session: LiveSession): void {
    const target = session.target;
    if (session.stopSensitive !== undefined || target.watchSensitive === undefined) return;
    session.stopSensitive = target
      .watchSensitive(() => {
        if (session.target === target && session.cast !== undefined) invalidate(session);
      })
      .catch((error: unknown) => {
        report(error);
        return undefined;
      });
  }

  function unwatchSensitive(session: LiveSession): void {
    const sensitive = session.stopSensitive;
    session.stopSensitive = undefined;
    void sensitive?.then((stop) => stop?.()).catch(report);
  }

  function stopCast(session: LiveSession): void {
    const cast = session.cast;
    if (cast === undefined) return;
    session.cast = undefined;
    session.generation += 1;
    session.held = undefined;
    session.owed = undefined;
    // A restart keeps its slot: only `releaseSlot` hands one to another session.
    void cast.then((running) => running.stop()).catch(report);
  }

  function clearRecheck(session: LiveSession): void {
    if (session.recheckTimer !== undefined) clearTimeout(session.recheckTimer);
    session.recheckTimer = undefined;
  }

  /** Whether a frame taken at `at` may be shown now. */
  const passes = (session: LiveSession, at: number): boolean =>
    session.hidden === undefined &&
    session.clearSince !== undefined &&
    session.lastPass !== undefined &&
    at >= session.clearSince &&
    at <= session.lastPass + BROWSER_LIVE_CHECK_INTERVAL_MS;

  function onFrame(session: LiveSession, generation: number, frame: LiveTargetFrame): void {
    if (generation !== session.generation) return;
    session.lastMetadata = frame.metadata;
    if (frame.data.length > frameCapOf(session)) {
      // Too large to carry: dropped, and the stream restarted a step lower.
      if (session.qualityStep < qualitiesOf(session).length - 1) {
        session.qualityStep += 1;
        reconcile(session, true);
      } else {
        frame.ack();
      }
      return;
    }
    const at = now();
    if (passes(session, at)) {
      deliver(session, { frame, at });
      return;
    }
    // The person in control sees the page whatever it holds: they must, to sign in.
    const controller = controllerOf(session);
    if (controller !== undefined) {
      deliver(session, { frame, at }, [controller]);
      return;
    }
    // Held, unacknowledged, until a check passes; a newer frame cannot come meanwhile.
    session.held = { frame, at };
    check(session);
  }

  function deliver(session: LiveSession, held: Held, to: Iterable<Watcher> = session.watchers): void {
    const { frame, at } = held;
    const metadata = frame.metadata;
    const size = jpegSize(frame.data);
    const wantsMore = send(
      session,
      {
        kind: "frame",
        sessionId: session.info.sessionId,
        mime: "image/jpeg",
        data: frame.data,
        width: size?.width ?? Math.max(1, Math.round(metadata.deviceWidth)),
        height: size?.height ?? Math.max(1, Math.round(metadata.deviceHeight)),
        metadata,
        at: new Date(at).toISOString(),
        source: "live",
      },
      to,
    );
    if (wantsMore) frame.ack();
    else session.owed = frame;
    // Frames flowing: keep the checks coming at their interval.
    if (session.lastCheckStart === undefined || at - session.lastCheckStart >= BROWSER_LIVE_CHECK_INTERVAL_MS) check(session);
  }

  /**
   * Runs the sensitivity rules now. While a check runs, a frame needs only
   * its answer; `invalidate` (a navigation) makes that answer stale, so the
   * rules run again once it ends.
   */
  function check(session: LiveSession, invalidate = false): void {
    if (session.checking) {
      if (invalidate) session.recheck = true;
      return;
    }
    clearRecheck(session);
    session.checking = true;
    session.recheck = false;
    const started = now();
    session.lastCheckStart = started;
    const generation = session.generation;
    void (async () => {
      let reason: SensitiveReason | undefined;
      try {
        reason = await session.target.sensitivity(await session.blockedHosts());
      } catch (error) {
        // Fail closed: a check that cannot answer is a sensitive page.
        report(error);
        reason = "blocked-host";
      }
      session.checking = false;
      if (session.info.state === "closed") return;
      if (session.recheck) {
        // Something changed while it ran (a navigation): its answer is stale.
        check(session);
        return;
      }
      settle(session, generation, started, reason);
    })();
  }

  function settle(session: LiveSession, generation: number, started: number, reason: SensitiveReason | undefined): void {
    if (reason !== undefined) {
      const changed = session.hidden !== reason;
      session.hidden = reason;
      session.clearSince = undefined;
      session.lastPass = undefined;
      session.held = undefined;
      if (changed) send(session, { kind: "hidden", sessionId: session.info.sessionId, reason }, othersThan(session, controllerOf(session)));
      // Look again while anyone watches: the page may leave its sensitive state.
      if (session.watchers.size > 0) session.recheckTimer = setTimeout(() => check(session), BROWSER_LIVE_CHECK_INTERVAL_MS);
      return;
    }
    const wasClear = session.clearSince !== undefined;
    session.lastPass = started;
    if (!wasClear) session.clearSince = started;
    session.hidden = undefined;
    // Now known clear: an action waiting for approval can show where it is.
    if (!wasClear && session.pending?.box !== undefined)
      send(session, { kind: "action", sessionId: session.info.sessionId, ...session.pending });
    const held = session.held;
    session.held = undefined;
    if (held !== undefined && generation === session.generation && passes(session, held.at)) {
      deliver(session, held);
      return;
    }
    if (!wasClear && session.cast !== undefined) {
      // The held frame (if any) predates the passing check: restart for a
      // fresh one, which an idle page would not otherwise send.
      reconcile(session, true);
      return;
    }
    held?.frame.ack();
  }

  /**
   * The page changed (a navigation, a new tab): it is no longer known clear,
   * and a check running now answers for the page before. Checked again at
   * once while streaming; otherwise when the next screencast starts.
   */
  function invalidate(session: LiveSession): void {
    session.clearSince = undefined;
    session.lastPass = undefined;
    if (session.checking) session.recheck = true;
    else if (session.cast !== undefined) check(session, true);
  }

  /** Where `session`'s page is now, kept and told to its watchers. */
  function showNavigated(session: LiveSession, rawUrl: string, rawTitle: string | undefined, epoch: number): void {
    const url = scrubBrowserUrl(rawUrl);
    const title = clipBrowserTitle(rawTitle);
    if (url === undefined) return;
    session.info.url = url;
    if (title === undefined) delete session.info.title;
    else session.info.title = title;
    send(session, { kind: "navigated", sessionId: session.info.sessionId, url, ...(title === undefined ? {} : { title }), epoch });
  }

  function attach(session: LiveSession): void {
    session.stopNavigated = session.target.onNavigated((page) => {
      if (page === undefined) return invalidate(session);
      // The person's own navigation while they hold the page: the bar and the next card name where they went.
      if (session.control.state === "operator") showNavigated(session, page.url, page.title, session.epoch);
    });
  }

  /** Who acts, as `watcher` sees it. */
  function controlMessage(session: LiveSession, watcher: Watcher): BrowserLiveMessage {
    const control = session.control;
    const controller =
      control.state === "operator"
        ? control.controller === undefined
          ? "none"
          : control.controller === watcher
            ? "you"
            : "other"
        : undefined;
    return {
      kind: "control",
      sessionId: session.info.sessionId,
      state: control.state,
      ...(controller === undefined ? {} : { controller }),
      ...(controller === "none" && control.leftAt !== undefined ? { unattendedMs: Math.max(0, Math.round(now() - control.leftAt)) } : {}),
      ...(control.taking === watcher ? { pending: true as const } : {}),
    };
  }

  function broadcastControl(session: LiveSession): void {
    for (const watcher of session.watchers) send(session, controlMessage(session, watcher), [watcher]);
  }

  function setControlState(session: LiveSession, state: BrowserLiveControlState): void {
    session.control.state = state;
    if (state === "agent") {
      delete session.info.control;
      delete session.info.handoffDeadlineAt;
    } else session.info.control = state;
    announce(session);
  }

  /** Resolves once no agent call runs on the session, or after `ms`. */
  function idle(session: LiveSession, ms: number): Promise<void> {
    if (session.control.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      session.control.idle.push(done);
    });
  }

  /** Lays the page out at a phone's size, or back at the session's own; best effort, as the page may be going. */
  async function layOut(target: LiveControlTarget, viewport: BrowserLivePhoneViewport | undefined): Promise<void> {
    await target.layout?.(viewport).catch(() => report(new Error("laying the page out for the person's screen failed")));
  }

  /** Back to the agent, ending a person's control or a request with `outcome`. */
  function toAgent(session: LiveSession, outcome: BrowserLiveControlOutcome, note?: string, by?: string): void {
    const control = session.control;
    if (control.state === "agent") return;
    const controlledMs = control.state === "operator" ? Math.max(0, now() - control.since) : 0;
    const end = control.end;
    control.end = undefined;
    if (control.unattended !== undefined) clearTimeout(control.unattended);
    control.unattended = undefined;
    control.asked = false;
    control.leftAt = undefined;
    control.controller = undefined;
    control.taking = undefined;
    control.selectRef = undefined;
    control.swallowUp = false;
    control.dialog = undefined;
    control.chooser = undefined;
    dropUpload(control);
    for (const watcher of session.watchers) delete watcher.controlWidth;
    if (end !== undefined) void end().catch(() => report(new Error("ending a person's control of the browser failed")));
    setControlState(session, "agent");
    session.qualityStep = 0;
    // A session closing stops its stream itself; a kept one (its task over) stops streaming here.
    if (session.cast !== undefined && session.info.state !== "closed") reconcile(session, true);
    broadcastControl(session);
    // The controller saw a sensitive page; from now on it is a watcher like any other.
    if (session.hidden !== undefined) send(session, { kind: "hidden", sessionId: session.info.sessionId, reason: session.hidden });
    const clipped = note?.trim().slice(0, BROWSER_LIVE_NOTE_MAX);
    emitControl({
      sessionId: session.info.sessionId,
      taskId: session.info.taskId,
      state: "agent",
      outcome,
      ...(clipped === undefined || clipped === "" ? {} : { note: clipped }),
      controlledMs,
      ...(by === undefined ? {} : { by }),
    });
  }

  /** The viewport's size in CSS pixels, from the last frame, if one came. */
  function clamp(session: LiveSession, x: number, y: number): { x: number; y: number } {
    const metadata = session.lastMetadata;
    const maxX = metadata === undefined ? Number.POSITIVE_INFINITY : Math.max(0, metadata.deviceWidth / metadata.pageScaleFactor - 1);
    const maxY = metadata === undefined ? Number.POSITIVE_INFINITY : Math.max(0, metadata.deviceHeight / metadata.pageScaleFactor - 1);
    return { x: Math.min(maxX, Math.max(0, x)), y: Math.min(maxY, Math.max(0, y)) };
  }

  /** Applies one event: a refused shortcut is dropped, a press on a `<select>` opens the host's picker instead. */
  async function apply(session: LiveSession, target: LiveControlTarget, watcher: Watcher, event: BrowserLiveInputEvent): Promise<boolean> {
    const control = session.control;
    if (refusedShortcut(event)) return false;
    if (event.type === "mouse" || event.type === "wheel") {
      const at = clamp(session, event.x, event.y);
      if (event.type === "mouse" && event.action === "down" && (event.button ?? "left") === "left") {
        const picker = await target.selectAt(at.x, at.y);
        if (picker !== undefined) {
          control.selectRef = picker.ref;
          control.swallowUp = true;
          send(
            session,
            {
              kind: "select",
              sessionId: session.info.sessionId,
              ref: picker.ref,
              ...(picker.box === undefined ? {} : { box: picker.box }),
              options: picker.options.slice(0, 500).map((option) => ({
                value: option.value.slice(0, 1024),
                label: option.label.slice(0, 256),
                selected: option.selected,
                ...(option.disabled === true ? { disabled: true } : {}),
              })),
            },
            [watcher],
          );
          return true;
        }
      }
      if (event.type === "mouse" && event.action === "up" && control.swallowUp) {
        control.swallowUp = false;
        return true;
      }
      await target.input({ ...event, ...at });
      return true;
    }
    await target.input(event);
    return true;
  }

  const isGone = (watcher: Watcher, session: LiveSession): boolean => watcher.closed === true || session.info.state === "closed";
  const chooserMessage = (info: { readonly multiple: boolean; readonly accept?: string }) => ({
    multiple: info.multiple,
    ...(info.accept === undefined || info.accept === "" ? {} : { accept: info.accept.slice(0, 256) }),
  });
  /** Forgets files that were arriving, zeroing what had come. */
  const dropUpload = (control: Control): void => {
    for (const file of control.upload?.files ?? []) for (const chunk of file.chunks) chunk.fill(0);
    control.upload = undefined;
  };

  function controlOf(session: LiveSession, watcher: Watcher): BrowserLiveControl {
    const requireController = (): LiveControlTarget => {
      const target = session.controlTarget;
      if (
        watcher.closed === true ||
        session.control.state !== "operator" ||
        session.control.controller !== watcher ||
        target === undefined
      ) {
        throw new TaviError("NOT_AUTHORIZED", "Only the watch in control of this browser session may do that");
      }
      return target;
    };
    return {
      async take({ maxWidth, viewport }) {
        const target = session.controlTarget;
        if (target === undefined) throw new TaviError("CAPABILITY_MISSING", "This browser session cannot be taken over");
        // A kept session, its task over, is still the person's to take: only a closed one is not.
        if (watcher.closed === true || session.info.state === "closed")
          throw new TaviError("UNAVAILABLE", "This browser session is not open");
        const control = session.control;
        if (control.state === "operator" && control.controller === watcher) {
          // Taken again by the tab that holds it (a phone turned on its side): the page follows its size.
          await layOut(target, viewport);
          return;
        }
        const superseded = control.taking;
        control.taking = watcher;
        // Only the taker is told it waits; for everyone else nothing changed yet — but a take it replaced no longer waits.
        send(session, controlMessage(session, watcher), [watcher]);
        if (superseded !== undefined && superseded !== watcher) send(session, controlMessage(session, superseded), [superseded]);
        // After the agent's step in flight: nothing is aborted halfway, and nothing runs alongside the person.
        await idle(session, BROWSER_LIVE_TAKE_WAIT_MS);
        if (control.taking === watcher && control.inFlight > 0) {
          control.taking = undefined;
          send(session, controlMessage(session, watcher), [watcher]);
          throw new TaviError("CONFLICT", "The agent's current browser step is still running; try again once it finishes");
        }
        // A newer take, a closed watch or session, won meanwhile.
        // (Read through a function: the checks above narrowed them, but the await may have changed both.)
        if (control.taking !== watcher || isGone(watcher, session)) {
          if (control.taking === watcher) control.taking = undefined;
          send(session, controlMessage(session, watcher), [watcher]);
          throw new TaviError("CONFLICT", "Control of this browser session went elsewhere");
        }
        if (control.state !== "operator") {
          // Still `taking` while the page is prepared: no agent call starts, and a newer take or a close wins.
          let end: () => Promise<void>;
          try {
            end = await target.begin({
              dialog: (info) => {
                control.dialog = info;
                const controller = controllerOf(session);
                if (controller !== undefined) send(session, { kind: "dialog", sessionId: session.info.sessionId, ...info }, [controller]);
              },
              fileChooser: (info) => {
                control.chooser = info;
                dropUpload(control);
                const controller = controllerOf(session);
                if (controller !== undefined)
                  send(session, { kind: "chooser", sessionId: session.info.sessionId, ...chooserMessage(info) }, [controller]);
              },
            });
          } catch (error) {
            report(error);
            if (control.taking === watcher) control.taking = undefined;
            send(session, controlMessage(session, watcher), [watcher]);
            throw new TaviError("UNAVAILABLE", "This browser session could not be taken over");
          }
          if (control.taking !== watcher || isGone(watcher, session)) {
            // Lost meanwhile: what was prepared is undone, and nothing changed hands.
            await end().catch(() => report(new Error("undoing a lost takeover failed")));
            if (control.taking === watcher) control.taking = undefined;
            send(session, controlMessage(session, watcher), [watcher]);
            throw new TaviError("CONFLICT", "Control of this browser session went elsewhere");
          }
          control.end = end;
          control.since = now();
          control.asked = control.state === "requested";
          control.takes += 1;
          setControlState(session, "operator");
          emitControl({ sessionId: session.info.sessionId, taskId: session.info.taskId, state: "operator" });
        }
        control.taking = undefined;
        // The newer tab wins; the older one is told. Its half-sent files are not this one's to finish.
        if (control.controller !== watcher) dropUpload(control);
        control.controller = watcher;
        control.leftAt = undefined;
        if (control.unattended !== undefined) clearTimeout(control.unattended);
        control.unattended = undefined;
        for (const other of session.watchers) if (other !== watcher) delete other.controlWidth;
        watcher.controlWidth = Math.min(BROWSER_LIVE_CONTROL_MAX_WIDTH, Math.max(BROWSER_LIVE_MIN_WIDTH, Math.round(maxWidth)));
        // A phone's take lays the page out at its size; any other take, the session's own.
        await layOut(target, viewport);
        session.qualityStep = 0;
        reconcile(session, true);
        broadcastControl(session);
        if (control.dialog !== undefined)
          send(session, { kind: "dialog", sessionId: session.info.sessionId, ...control.dialog }, [watcher]);
        if (control.chooser !== undefined)
          send(session, { kind: "chooser", sessionId: session.info.sessionId, ...chooserMessage(control.chooser) }, [watcher]);
      },

      async input(events) {
        const target = requireController();
        if (events.length > BROWSER_LIVE_INPUT_MAX_EVENTS)
          throw new TaviError("INVALID_INPUT", `At most ${BROWSER_LIVE_INPUT_MAX_EVENTS} input events a batch`);
        const control = session.control;
        let refused = false;
        const run = control.queue.then(async () => {
          for (const event of events) {
            // Control moved mid-batch: the rest is not this watch's to apply.
            if (control.state !== "operator" || control.controller !== watcher) return;
            if (!(await apply(session, target, watcher, event))) refused = true;
          }
        });
        // Ordering only: the work's own failure reaches its caller through the promise it was handed.
        control.queue = run.catch(() => undefined);
        try {
          await run;
        } catch {
          // Never the event itself (invariant 8).
          report(new Error("applying the operator's input to the browser failed"));
          throw new TaviError("UNAVAILABLE", "The input could not be applied to the page");
        }
        if (refused) send(session, { kind: "notice", sessionId: session.info.sessionId, notice: "shortcut-refused" }, [watcher]);
      },

      async select(ref, value) {
        const target = requireController();
        const control = session.control;
        if (control.selectRef !== ref) throw new TaviError("NOT_FOUND", "That list is no longer open");
        control.selectRef = undefined;
        const run = control.queue.then(() => target.selectOption(ref, value));
        // Ordering only: the work's own failure reaches its caller through the promise it was handed.
        control.queue = run.catch(() => undefined);
        try {
          await run;
        } catch {
          report(new Error("answering a list on the page failed"));
          throw new TaviError("UNAVAILABLE", "The choice could not be applied to the page");
        }
      },

      async dialog(accept, text) {
        const target = requireController();
        const control = session.control;
        if (control.dialog === undefined) throw new TaviError("NOT_FOUND", "No dialog is open");
        control.dialog = undefined;
        try {
          await target.answerDialog(accept, text);
        } catch {
          report(new Error("answering a dialog on the page failed"));
          throw new TaviError("UNAVAILABLE", "The dialog could not be answered");
        }
      },

      release(outcome, note, by) {
        requireController();
        toAgent(session, outcome, note, by);
      },

      async upload(chunk) {
        const target = requireController();
        const control = session.control;
        if (control.chooser === undefined) throw new TaviError("NOT_FOUND", "The page is not asking for a file");
        if (!control.chooser.multiple && chunk.count > 1) throw new TaviError("INVALID_INPUT", "The page takes one file");
        const bytes = Buffer.from(chunk.data, "base64");
        // Each file's chunks in order from offset 0, file after file; anything else starts over.
        if (chunk.index === 0 && chunk.offset === 0) {
          dropUpload(control);
          control.upload = { count: chunk.count, files: [] };
        }
        const upload = control.upload;
        const file = upload?.files[chunk.index];
        const expected =
          upload === undefined
            ? false
            : file === undefined
              ? chunk.index === upload.files.length &&
                chunk.offset === 0 &&
                (chunk.index === 0 || upload.files[chunk.index - 1]?.received === upload.files[chunk.index - 1]?.size)
              : file.received === chunk.offset && file.name === chunk.name && file.size === chunk.size;
        if (upload === undefined || !expected || chunk.count !== upload.count || chunk.index >= upload.count) {
          bytes.fill(0);
          dropUpload(control);
          throw new TaviError("INVALID_INPUT", "The upload's pieces came out of order; choose the files again");
        }
        const current = file ?? { name: chunk.name, type: chunk.type, size: chunk.size, chunks: [], received: 0 };
        // The files' declared sizes count from each file's first piece, so the cap holds before their bytes come.
        const declared = upload.files.reduce((total, entry) => total + entry.size, 0) + (file === undefined ? chunk.size : 0);
        if (current.received + bytes.length > current.size || declared > BROWSER_LIVE_UPLOAD_MAX_BYTES) {
          bytes.fill(0);
          dropUpload(control);
          throw new TaviError("INVALID_INPUT", `At most ${BROWSER_LIVE_UPLOAD_MAX_BYTES / (1024 * 1024)} MiB of files`);
        }
        if (file === undefined) upload.files.push(current);
        current.chunks.push(bytes);
        current.received += bytes.length;
        const complete = upload.files.length === upload.count && upload.files.every((entry) => entry.received === entry.size);
        if (!complete) return;
        const files = upload.files.map((entry) => ({
          name: entry.name,
          mimeType: entry.type || "application/octet-stream",
          buffer: Buffer.concat(entry.chunks),
        }));
        // The pieces were copied into each file: zeroed now, the files once the page has them.
        dropUpload(control);
        control.chooser = undefined;
        const run = control.queue.then(() => target.setFiles(files));
        // Ordering only: the work's own failure reaches its caller through the promise it was handed.
        control.queue = run.catch(() => undefined);
        try {
          await run;
        } catch {
          report(new Error("handing files to the page failed"));
          throw new TaviError("UNAVAILABLE", "The files could not be handed to the page");
        } finally {
          // Not kept: what the person chose leaves memory with the page's copy.
          for (const entry of files) entry.buffer.fill(0);
        }
      },

      async cancelUpload() {
        const target = requireController();
        const control = session.control;
        dropUpload(control);
        if (control.chooser === undefined) return;
        control.chooser = undefined;
        await target.dismissChooser().catch(() => report(new Error("dismissing the page's file chooser failed")));
      },

      decline(note, by) {
        if (watcher.closed === true || session.control.state !== "requested")
          throw new TaviError("CONFLICT", "Nobody is being asked to act in this browser session now");
        toAgent(session, "failed", note, by);
      },
    };
  }

  return {
    sessions(scope) {
      const tasks = new Set(scope.taskIds);
      return [...sessions.values()]
        .filter((session) => session.workspaceId === scope.workspaceId && tasks.has(session.info.taskId))
        .map(infoOf);
    },

    watch(sessionId, watchOptions, sink): BrowserLiveWatch {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        sink({ kind: "ended", sessionId, reason: "closed" });
        return { demand: () => undefined, close: () => undefined };
      }
      const watcher: Watcher = { maxWidth: watchOptions.maxWidth, sink, paused: false };
      send(session, { kind: "session", ...infoOf(session) }, [watcher]);
      const inactive = session.info.state === "inactive";
      if (session.thumbnail !== undefined) {
        const size = jpegSize(session.thumbnail);
        if (size !== undefined) {
          send(
            session,
            {
              kind: "frame",
              sessionId,
              mime: "image/jpeg",
              data: Buffer.from(session.thumbnail).toString("base64"),
              width: size.width,
              height: size.height,
              metadata: {
                deviceWidth: size.width,
                deviceHeight: size.height,
                pageScaleFactor: 1,
                offsetTop: 0,
                scrollOffsetX: 0,
                scrollOffsetY: 0,
              },
              at: new Date(now()).toISOString(),
              source: "thumbnail",
            },
            [watcher],
          );
        }
      }
      // An inactive session shows its last picture and says its task ended; it streams nothing until a person takes
      // it or it is in use again, and the watch stays for both.
      if (inactive) send(session, { kind: "ended", sessionId, reason: BROWSER_LIVE_ENDED_TASK }, [watcher]);
      if (session.hidden !== undefined) send(session, { kind: "hidden", sessionId, reason: session.hidden }, [watcher]);
      if (session.control.state !== "agent" || session.control.taking !== undefined)
        send(session, controlMessage(session, watcher), [watcher]);
      if (session.pending !== undefined) {
        // As any action is shown: without its box on a page that is hidden or not yet known clear.
        const { box, ...rest } = session.pending;
        const shown = box !== undefined && session.hidden === undefined && session.clearSince !== undefined;
        send(session, { kind: "action", sessionId, ...rest, ...(shown ? { box } : {}) }, [watcher]);
      }
      session.watchers.add(watcher);
      reconcile(session);
      return {
        demand() {
          if (watcher.closed === true) return;
          const owed = session.owed;
          session.owed = undefined;
          owed?.ack();
        },
        close() {
          if (watcher.closed === true) return;
          watcher.closed = true;
          session.watchers.delete(watcher);
          const control = session.control;
          // A controller leaving keeps the operator in control, unattended, until another tab takes it or the host ends it.
          const wasController = control.controller === watcher;
          if (wasController) {
            control.controller = undefined;
            control.leftAt = now();
            dropUpload(control);
            // Nobody may be there to answer "Still working?": an operator's own grab ends on the owner's clock.
            if (control.state === "operator" && !control.asked) {
              control.unattended = setTimeout(() => {
                control.unattended = undefined;
                if (control.state === "operator" && control.controller === undefined) toAgent(session, "timeout");
              }, BROWSER_LIVE_UNATTENDED_MS);
            }
          }
          if (control.taking === watcher) control.taking = undefined;
          reconcile(session, wasController);
          if (wasController) broadcastControl(session);
        },
        ...(session.controlTarget === undefined ? {} : { control: controlOf(session, watcher) }),
      };
    },

    onSession(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onControl(listener) {
      controlListeners.add(listener);
      return () => controlListeners.delete(listener);
    },

    agentCall(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) return () => undefined;
      const control = session.control;
      if (control.state !== "agent" || control.taking !== undefined) {
        const state = control.state === "agent" ? "operator" : control.state;
        throw new TaviError(
          "CONFLICT",
          state === "requested"
            ? "This browser session waits for a person to act in it"
            : "A person is controlling this browser session; call this browser tool again on its own to wait until they hand it back",
          { details: { control: state } },
        );
      }
      control.inFlight += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        control.inFlight -= 1;
        if (control.inFlight > 0) return;
        for (const resolve of control.idle.splice(0)) resolve();
      };
    },

    controlState(sessionId) {
      return sessions.get(sessionId)?.control.state;
    },

    personTakes(sessionId) {
      return sessions.get(sessionId)?.control.takes ?? 0;
    },

    requestHandoff(sessionId, deadlineAt) {
      const session = sessions.get(sessionId);
      if (session === undefined || session.info.state !== "open" || session.control.state !== "agent") return;
      if (deadlineAt !== undefined) session.info.handoffDeadlineAt = deadlineAt;
      setControlState(session, "requested");
      broadcastControl(session);
      emitControl({ sessionId, taskId: session.info.taskId, state: "requested" });
    },

    endControl(sessionId, outcome) {
      const session = sessions.get(sessionId);
      if (session !== undefined) toAgent(session, outcome);
    },

    opened(opening) {
      const session: LiveSession = {
        info: {
          sessionId: opening.sessionId,
          taskId: opening.taskId,
          state: "open" satisfies BrowserLiveSessionState,
          ...(opening.openedByCallId === undefined ? {} : { openedByCallId: opening.openedByCallId }),
        },
        workspaceId: opening.workspaceId,
        target: opening.target,
        epoch: 0,
        blockedHosts: opening.blockedHosts,
        watchers: new Set(),
        thumbnail: undefined,
        cast: undefined,
        castWidth: 0,
        qualityStep: 0,
        generation: 0,
        stopNavigated: () => undefined,
        clearSince: undefined,
        lastPass: undefined,
        lastCheckStart: undefined,
        checking: false,
        recheck: false,
        hidden: undefined,
        recheckTimer: undefined,
        held: undefined,
        owed: undefined,
        controlTarget: opening.control,
        pending: undefined,
        stopSensitive: undefined,
        control: {
          state: "agent",
          controller: undefined,
          taking: undefined,
          since: 0,
          asked: false,
          unattended: undefined,
          leftAt: undefined,
          end: undefined,
          inFlight: 0,
          takes: 0,
          idle: [],
          queue: Promise.resolve(),
          selectRef: undefined,
          swallowUp: false,
          dialog: undefined,
          chooser: undefined,
          upload: undefined,
        },
        lastMetadata: undefined,
      };
      sessions.set(opening.sessionId, session);
      attach(session);
      announce(session);
    },

    retarget(sessionId, target) {
      const session = sessions.get(sessionId);
      if (session === undefined) return;
      session.stopNavigated();
      // The new page gets its own watch as its screencast starts.
      unwatchSensitive(session);
      session.target = target;
      attach(session);
      invalidate(session);
      if (session.cast !== undefined) {
        // Moved, keeping its slot.
        stopCast(session);
        startCast(session, widthOf(session));
      }
    },

    navigated(sessionId, page) {
      const session = sessions.get(sessionId);
      if (session === undefined) return;
      session.epoch = page.epoch;
      showNavigated(session, page.url, page.title, page.epoch);
    },

    action(sessionId, event) {
      const session = sessions.get(sessionId);
      if (session === undefined) return;
      // An action waiting for approval is kept for whoever starts watching while it waits; any other ends it.
      if (event.phase === "pending") session.pending = event;
      else if (
        session.pending !== undefined &&
        (event.callId === undefined || event.callId === session.pending.callId || event.phase === "started")
      )
        session.pending = undefined;
      if (session.watchers.size === 0) return;
      // A hidden page's layout is not shown either.
      const { box, ...rest } = event;
      const shown = box !== undefined && session.hidden === undefined && session.clearSince !== undefined;
      send(session, { kind: "action", sessionId, ...rest, ...(shown ? { box } : {}) });
    },

    thumbnail(sessionId, jpeg) {
      const session = sessions.get(sessionId);
      if (session !== undefined) session.thumbnail = jpeg;
    },

    inactive(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined || session.info.state !== "open") return;
      toAgent(session, "cancelled");
      session.info.state = "inactive";
      const freed = session.cast !== undefined;
      unwatchSensitive(session);
      stopCast(session);
      clearRecheck(session);
      if (freed) releaseSlot(session);
      send(session, { kind: "session", ...infoOf(session) });
      // Kept, not over: its watchers stay, so a person can still take it and it streams to them once in use again.
      send(session, { kind: "ended", sessionId, reason: BROWSER_LIVE_ENDED_TASK });
      announce(session);
    },

    activated(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined || session.info.state !== "inactive") return;
      session.info.state = "open";
      // Not known clear: the first watcher's screencast checks it again.
      session.clearSince = undefined;
      session.lastPass = undefined;
      send(session, { kind: "session", ...infoOf(session) });
      announce(session);
      reconcile(session);
    },

    closed(sessionId, reason) {
      const session = sessions.get(sessionId);
      if (session === undefined) return;
      toAgent(session, "cancelled");
      session.info.state = "closed";
      session.stopNavigated();
      const freed = session.cast !== undefined;
      unwatchSensitive(session);
      stopCast(session);
      clearRecheck(session);
      if (freed) releaseSlot(session);
      send(session, { kind: "session", ...infoOf(session) });
      send(session, { kind: "ended", sessionId, reason: reason.slice(0, 256) || "closed" });
      session.watchers.clear();
      sessions.delete(sessionId);
      announce(session);
    },
  };
}

/** A JPEG's pixel size, read from its first start-of-frame marker; `undefined` when it has none. Takes base64 or bytes. */
export function jpegSize(jpeg: string | Uint8Array): { readonly width: number; readonly height: number } | undefined {
  // The SOF marker sits in the header: a few KiB of base64 is enough.
  const bytes = typeof jpeg === "string" ? Buffer.from(jpeg.slice(0, 64 * 1024), "base64") : jpeg;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

/** A Playwright page as a `LiveTarget`: its screencast over the DevTools protocol (Chromium only, `chromium.ts`). */
export function playwrightLiveTarget(page: Page): LiveTarget {
  return {
    async screencast({ maxWidth, quality }, onFrame) {
      const cdp = await page.context().newCDPSession(page);
      cdp.on("Page.screencastFrame", (event) => {
        let acked = false;
        onFrame({
          data: event.data,
          metadata: {
            deviceWidth: event.metadata.deviceWidth,
            deviceHeight: event.metadata.deviceHeight,
            pageScaleFactor: event.metadata.pageScaleFactor,
            offsetTop: event.metadata.offsetTop,
            scrollOffsetX: event.metadata.scrollOffsetX,
            scrollOffsetY: event.metadata.scrollOffsetY,
          },
          ack: () => {
            if (acked) return;
            acked = true;
            // Best effort: an unacknowledged frame only slows the screencast.
            void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
          },
        });
      });
      try {
        await cdp.send("Page.startScreencast", { format: "jpeg", quality, maxWidth, everyNthFrame: 1 });
      } catch (error) {
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        await cdp.detach().catch(() => undefined);
        throw error;
      }
      return {
        async stop() {
          // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
          await cdp.send("Page.stopScreencast").catch(() => undefined);
          // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
          await cdp.detach().catch(() => undefined);
        },
      };
    },
    sensitivity: (blockedHosts) => sensitivityOf(playwrightSensitivePage(page), blockedHosts),
    onNavigated(listener) {
      // Only the newest navigation's title is reported, and none once stopped: a slow read never lands over a newer page.
      let latest = 0;
      let stopped = false;
      const handler = (frame: unknown): void => {
        listener();
        if (frame !== page.mainFrame()) return;
        const mine = (latest += 1);
        const url = page.url();
        const report = (title?: string): void => {
          if (!stopped && mine === latest) listener(title === undefined ? { url } : { url, title });
        };
        // Best effort: a page that closes while its title is read reports its address alone.
        void page.title().then(report, () => report());
      };
      page.on("framenavigated", handler);
      return () => {
        stopped = true;
        page.off("framenavigated", handler);
      };
    },
    async watchSensitive(listener) {
      const cdp = await page.context().newCDPSession(page);
      /** Every world the observer runs in, so stopping disconnects each. */
      const worlds = new Set<number>();
      cdp.on("Runtime.executionContextCreated", (event) => {
        if (event.context.name === SENSITIVE_WORLD) worlds.add(event.context.id);
      });
      cdp.on("Runtime.executionContextDestroyed", (event) => void worlds.delete(event.executionContextId));
      cdp.on("Runtime.executionContextsCleared", () => worlds.clear());
      cdp.on("Runtime.bindingCalled", (event) => {
        if (event.name === SENSITIVE_BINDING) listener();
      });
      try {
        // In a world of its own: the page cannot see, call or tamper with the binding or the observer.
        await cdp.send("Runtime.enable");
        await cdp.send("Runtime.addBinding", { name: SENSITIVE_BINDING, executionContextName: SENSITIVE_WORLD });
        await cdp.send("Page.enable");
        const added = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SENSITIVE_OBSERVER, worldName: SENSITIVE_WORLD });
        const frames = await cdp.send("Page.getFrameTree");
        const world = await cdp.send("Page.createIsolatedWorld", { frameId: frames.frameTree.frame.id, worldName: SENSITIVE_WORLD });
        worlds.add(world.executionContextId);
        await cdp.send("Runtime.evaluate", { expression: SENSITIVE_OBSERVER, contextId: world.executionContextId });
        return async () => {
          // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
          await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: added.identifier }).catch(() => undefined);
          // Nothing left watching the page: each observer disconnected, the binding gone.
          await Promise.all(
            [...worlds].map((contextId) =>
              cdp.send("Runtime.evaluate", { expression: SENSITIVE_DISCONNECT, contextId }).catch(() => undefined),
            ),
          );
          // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
          await cdp.send("Runtime.removeBinding", { name: SENSITIVE_BINDING }).catch(() => undefined);
          // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
          await cdp.detach().catch(() => undefined);
        };
      } catch (error) {
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        await cdp.detach().catch(() => undefined);
        throw error;
      }
    },
  };
}

const SENSITIVE_BINDING = "taviSensitiveField";
const SENSITIVE_WORLD = "tavi-sensitive";
/** The fields `sensitivity.ts` looks for: its own selectors, so the two cannot disagree. */
const SENSITIVE_SELECTOR = `${PASSWORD_SELECTOR}, ${PAYMENT_SELECTOR}`;
/** Runs in the isolated world of each document: tells the owner when a sensitive field appears or becomes one. */
const SENSITIVE_OBSERVER = `(() => {
  // One observer a world: one left by an earlier watch is replaced, never doubled.
  globalThis.__taviSensitiveObserver?.disconnect();
  const selector = ${JSON.stringify(SENSITIVE_SELECTOR)};
  const tell = () => { try { ${SENSITIVE_BINDING}(""); } catch {} };
  const sensitive = (node) => node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector) !== null);
  const observer = globalThis.__taviSensitiveObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" ? sensitive(record.target) : [...record.addedNodes].some(sensitive)) return tell();
    }
  });
  // The document itself: a page that replaces its whole content (document.open) is still watched.
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["type", "autocomplete"] });
})();`;
const SENSITIVE_DISCONNECT = "globalThis.__taviSensitiveObserver?.disconnect(); globalThis.__taviSensitiveObserver = undefined;";
