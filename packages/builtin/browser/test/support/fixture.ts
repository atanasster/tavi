import { randomUUID } from "node:crypto";

import {
  TaviError,
  browserArtifactLabel,
  browserActionNeedsRef,
  compactBrowserElements,
  pageTextPiece,
  type ArtifactRepositoryPort,
  type BrowserAction,
  type BrowserActionOutcome,
  type BrowserCaptureOptions,
  type BrowserCaptureResult,
  type BrowserCreateSessionInput,
  type BrowserElementSummary,
  type BrowserObservation,
  type BrowserPageContent,
  type BrowserPageText,
  type BrowserPort,
  type BrowserSessionHandle,
  type BrowserSessionState,
  type BrowserLiveInputEvent,
} from "@tavi/contracts";

import type { BrowserLiveSource, LiveControlTarget, LiveTarget, LiveTargetFrame } from "../../src/live.js";
import type { SensitiveReason } from "../../src/sensitivity.js";

/**
 * `BrowserPort` fixture adapter — a scripted
 * in-memory DOM/observation fixture, no real browser process. Sufficient
 * to test session lifecycle, stale-reference rejection, and artifact
 * capture plumbing, the same role the sandbox fixture
 * (`@tavi/test-support/sandbox`) already plays for `SandboxPort`.
 *
 * **Scripted pages, not a real DOM**: `pages` maps a URL to the
 * `BrowserElementSummary[]` `navigate` should return for it — a test
 * script, not a rendering engine. An unscripted URL navigates
 * successfully to an empty page (no elements), never an error, matching
 * a real browser's "navigation succeeded, page just has nothing on it
 * yet" behavior rather than treating "no script provided" as failure.
 * A scripted page goes through `compactBrowserElements`, as a real page's
 * scan does: an element it drops is not offered, and `act` rejects its ref.
 *
 * **Trust boundary, same as the sandbox fixture**: `act`
 * does not itself re-validate `action.epoch` against the session's
 * current epoch — `dispatchBrowserAction` (`@tavi/contracts`) is the one
 * place that check happens, deliberately, the same way
 * `dispatchSandboxedTool` is the sole enforcer of "no unsandboxed
 * fallback." A caller invoking `act` directly bypasses that check.
 */

export interface FixtureBrowserOptions {
  /** URL → the elements `navigate`/`observe` should report for it. Omitted URLs navigate to an empty page. */
  readonly pages?: Readonly<Record<string, readonly BrowserElementSummary[]>>;
  /** URL → the text `read` reports for it. Omitted URLs read as empty. */
  readonly texts?: Readonly<Record<string, string>>;
  /** Where `capture` publishes its screenshot artifact. Required only if a test calls `capture`. */
  readonly artifacts?: ArtifactRepositoryPort;
  readonly now?: () => string;
  /**
   * The live view's producer. With it, a
   * session opened for a task is offered to watchers, and its page streams
   * synthetic frames (`FIXTURE_LIVE_JPEG`) every `liveFrameMs` while watched.
   */
  readonly live?: BrowserLiveSource;
  /** URL → why the live view must hide it. */
  readonly sensitive?: Readonly<Record<string, SensitiveReason>>;
  /** How often a watched fixture page repaints. Default 100 ms. */
  readonly liveFrameMs?: number;
  /** URL → the options of a drop-down a press anywhere on that page opens, for takeover. */
  readonly selects?: Readonly<Record<string, readonly { readonly value: string; readonly label: string }[]>>;
  /** Told the kind of each input event a person's takeover applies — never its content. */
  readonly onControlInput?: (type: BrowserLiveInputEvent["type"]) => void;
}

/** A real 16×9 JPEG, base64: the fixture's synthetic frame. */
export const FIXTURE_LIVE_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABsSFBcUERsXFhceHBsgKEIrKCUlKFE6PTBCYFVlZF9VXVtqeJmBanGQc1tdhbWGkJ6jq62rZ4C8ybqmx5moq6T/2wBDARweHigjKE4rK06kbl1upKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKT/wAARCAAJABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCgBRP/2Q==";

/**
 * A fixture page as a `LiveTarget`: it "repaints" every `frameMs`, but — as
 * Chromium's screencast does — sends the next frame only once the last was
 * acknowledged.
 */
function fixtureLiveTarget(
  page: { url(): string; onNavigated(listener: () => void): () => void },
  options: { readonly sensitive?: Readonly<Record<string, SensitiveReason>>; readonly frameMs?: number } = {},
): LiveTarget {
  return {
    async screencast(_settings, onFrame) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = (): void => {
        timer = setTimeout(() => {
          if (stopped) return;
          let acked = false;
          const frame: LiveTargetFrame = {
            data: FIXTURE_LIVE_JPEG,
            metadata: { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 },
            ack: () => {
              if (acked || stopped) return;
              acked = true;
              next();
            },
          };
          onFrame(frame);
        }, options.frameMs ?? 100);
      };
      next();
      return {
        async stop() {
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
        },
      };
    },
    sensitivity: async () => options.sensitive?.[page.url()],
    onNavigated: (listener) => page.onNavigated(listener),
  };
}

/** Takeover of a fixture page: input is counted by kind, and `selects` scripts its drop-downs. */
function fixtureControlTarget(url: () => string, options: Pick<FixtureBrowserOptions, "selects" | "onControlInput">): LiveControlTarget {
  let picks = 0;
  return {
    begin: async () => async () => undefined,
    input: async (event) => options.onControlInput?.(event.type),
    selectAt: async () => {
      const scripted = options.selects?.[url()];
      if (scripted === undefined) return undefined;
      return { ref: `select-${(picks += 1)}`, options: scripted.map((option, index) => ({ ...option, selected: index === 0 })) };
    },
    selectOption: async () => undefined,
    answerDialog: async () => undefined,
    setFiles: async () => undefined,
    dismissChooser: async () => undefined,
  };
}

interface SessionRecord {
  state: BrowserSessionState;
  epoch: number;
  url: string;
  elements: readonly BrowserElementSummary[];
  omitted: number;
  /** The live view's id for it, when it has one. */
  liveId?: string;
  /** The task that opened it, when the caller said. */
  taskId?: string;
  /** Its task ended; kept open for the next turn. */
  inactive?: boolean;
}

export function createFixtureBrowser(options: FixtureBrowserOptions = {}): BrowserPort {
  const now = options.now ?? ((): string => new Date().toISOString());
  const pages = options.pages ?? {};
  let counter = 0;
  const sessions = new Map<string, SessionRecord>();
  const navigationListeners = new Map<string, Set<() => void>>();

  function requireOpenSession(sessionId: string): SessionRecord {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw new TaviError("NOT_FOUND", `No browser session ${sessionId}`);
    }
    if (session.state === "closed") {
      // Session loss: the session existed but is no longer usable —
      // distinct from NOT_FOUND (which means it never existed at all).
      // `dispatchBrowserAction` treats this as "uncertain" for governed
      // write actions.
      throw new TaviError("UNAVAILABLE", `Browser session ${sessionId} is closed`);
    }
    if (session.inactive === true) {
      const active = { ...session, inactive: false };
      sessions.set(sessionId, active);
      if (active.liveId !== undefined) options.live?.activated(active.liveId);
      return active;
    }
    // Refused while a person acts in it; a synchronous fixture call is over as soon as it starts.
    if (session.liveId !== undefined) options.live?.agentCall(session.liveId)();
    return session;
  }

  function observationOf(sessionId: string, session: SessionRecord): BrowserObservation {
    return {
      sessionId,
      epoch: session.epoch,
      url: session.url,
      elements: session.elements,
      ...(session.omitted === 0 ? {} : { elementsOmitted: session.omitted }),
    };
  }

  return {
    async createSession(input: BrowserCreateSessionInput): Promise<BrowserSessionHandle> {
      counter += 1;
      const sessionId = `browser-session-${counter}`;
      const liveId = options.live !== undefined && input.taskId !== undefined ? `fixture-live-${counter}` : undefined;
      sessions.set(sessionId, {
        state: "open",
        epoch: 0,
        url: "about:blank",
        elements: [],
        omitted: 0,
        ...(liveId === undefined ? {} : { liveId }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      });
      if (liveId !== undefined && input.taskId !== undefined) {
        const listeners = new Set<() => void>();
        navigationListeners.set(sessionId, listeners);
        options.live?.opened({
          sessionId: liveId,
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          ...(input.callId === undefined ? {} : { openedByCallId: input.callId }),
          target: fixtureLiveTarget(
            {
              url: () => sessions.get(sessionId)?.url ?? "about:blank",
              onNavigated: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
              },
            },
            {
              ...(options.sensitive === undefined ? {} : { sensitive: options.sensitive }),
              ...(options.liveFrameMs === undefined ? {} : { frameMs: options.liveFrameMs }),
            },
          ),
          blockedHosts: async () => [],
          control: fixtureControlTarget(() => sessions.get(sessionId)?.url ?? "about:blank", options),
        });
      }
      return { sessionId, state: "open" };
    },

    async navigate(sessionId: string, url: string, navigateOptions?: { readonly callId?: string }): Promise<BrowserObservation> {
      const session = requireOpenSession(sessionId);
      const { elements, omitted } = compactBrowserElements(pages[url] ?? []);
      const next: SessionRecord = { ...session, state: "open", epoch: session.epoch + 1, url, elements, omitted };
      sessions.set(sessionId, next);
      if (next.liveId !== undefined) {
        const call = navigateOptions?.callId === undefined ? {} : { callId: navigateOptions.callId };
        options.live?.action(next.liveId, { phase: "started", action: "navigate", ...call });
        for (const listener of navigationListeners.get(sessionId) ?? []) listener();
        options.live?.navigated(next.liveId, { url, epoch: next.epoch });
        options.live?.action(next.liveId, { phase: "ended", action: "navigate", status: "accepted", ...call });
      }
      return observationOf(sessionId, next);
    },

    async observe(sessionId: string): Promise<BrowserObservation> {
      const session = requireOpenSession(sessionId);
      return observationOf(sessionId, session);
    },

    async read(sessionId: string, offset = 0): Promise<BrowserPageText> {
      const session = requireOpenSession(sessionId);
      return pageTextPiece({ sessionId, url: session.url }, options.texts?.[session.url] ?? "", offset);
    },

    async currentUrl(sessionId: string): Promise<string | undefined> {
      return sessions.get(sessionId)?.url;
    },

    async content(sessionId: string, contentOptions?: { readonly ref?: string; readonly epoch?: number }): Promise<BrowserPageContent> {
      const session = requireOpenSession(sessionId);
      // One element's part of the page: its own text and link, under the same reference checks as `act`.
      if (contentOptions?.ref !== undefined) {
        if (session.epoch !== contentOptions.epoch)
          throw new TaviError(
            "INVALID_INPUT",
            `Element reference for session ${sessionId} is stale (expected epoch ${session.epoch}, got ${contentOptions.epoch ?? "none"})`,
          );
        const element = session.elements.find((candidate) => candidate.ref === contentOptions.ref);
        if (element === undefined)
          throw new TaviError("INVALID_INPUT", `Unknown element reference ${contentOptions.ref} for session ${sessionId}`);
        const links =
          element.href === undefined ? [] : [{ ...(element.text === undefined ? {} : { text: element.text }), href: element.href }];
        return { sessionId, url: session.url, text: element.text ?? "", links, truncated: false };
      }
      const text = options.texts?.[session.url] ?? "";
      const links = session.elements.flatMap((element) =>
        element.href === undefined ? [] : [{ ...(element.text === undefined ? {} : { text: element.text }), href: element.href }],
      );
      return { sessionId, url: session.url, text, links, truncated: false };
    },

    async act(action: BrowserAction): Promise<BrowserActionOutcome> {
      const session = requireOpenSession(action.sessionId);
      if (browserActionNeedsRef(action.kind) && action.ref === undefined) {
        throw new TaviError("INVALID_INPUT", `browser ${action.kind} needs the ref of an element from the session's latest observation`);
      }
      // A page action with no element (a key, a scroll, back, a wait) has nothing to check.
      if (action.ref === undefined || action.kind === "back" || action.kind === "wait_for") return { status: "accepted" };
      // Stale-reference rejection is this port's own responsibility
      // (`BrowserPort`'s doc comment) — checked against the session's
      // actual current epoch right here, not via an earlier, separately
      // timed check a generic dispatch wrapper might perform.
      if (session.epoch !== action.epoch) {
        throw new TaviError(
          "INVALID_INPUT",
          `Element reference for session ${action.sessionId} is stale (expected epoch ${session.epoch}, got ${action.epoch})`,
          { details: { sessionId: action.sessionId, expectedEpoch: session.epoch, actualEpoch: action.epoch } },
        );
      }
      // A scripted fixture, not real page interaction: every action on an
      // open session with a known, current-epoch ref succeeds. `ref`
      // existence is checked against the session's current elements — a
      // genuinely unknown ref (never observed at all, even at the current
      // epoch) is rejected outright, kept distinct from staleness above.
      const known = session.elements.some((element) => element.ref === action.ref);
      if (!known) {
        throw new TaviError("INVALID_INPUT", `Unknown element reference ${action.ref} for session ${action.sessionId}`);
      }
      return { status: "accepted" };
    },

    async capture(sessionId: string, captureOptions?: BrowserCaptureOptions): Promise<BrowserCaptureResult> {
      requireOpenSession(sessionId);
      if (options.artifacts === undefined) {
        // Nothing was ever configured (as opposed to a configured store
        // being down) — `NOT_CONFIGURED`, not `UNAVAILABLE`, matching
        // `dispatchSandboxedTool`'s identical distinction
        // (the sandbox fixture's sibling precedent).
        throw new TaviError("NOT_CONFIGURED", "No artifact store is configured for this fixture; pass { artifacts } to capture");
      }
      const session = sessions.get(sessionId);
      const forModel = captureOptions?.forModel === true;
      const artifactId = `art-fixture-${randomUUID()}`;
      const artifact = await options.artifacts.putArtifact({
        artifactId,
        // The page's, with the calling conversation's, as the real adapter's.
        label: browserArtifactLabel({
          contextLabel: captureOptions?.contextLabel,
          source: "web",
          pageUrl: session?.url ?? "",
          ref: artifactId,
          at: now(),
        }),
        workspaceId: "fixture",
        // A capture for the model is an image, approved, as the real adapter's is.
        contentType: forModel ? "image/jpeg" : "text/plain",
        body: `fixture screenshot of ${session?.url ?? "unknown"} at epoch ${session?.epoch ?? 0}`,
        extension: forModel ? "jpg" : "txt",
        // Mirrors the real adapter's identical `reviewState: "pending"`
        // (`packages/builtin/browser/src/playwright.ts`) —
        // a fixture that skipped this would let a test relying on it
        // silently diverge from real behavior.
        reviewState: forModel ? "approved" : "pending",
      });
      return {
        sessionId,
        artifactId: artifact.artifactId,
        capturedAt: now(),
        ...(forModel ? { forModel: true as const, contentType: "image/jpeg" } : {}),
      };
    },

    async cancel(sessionId: string): Promise<void> {
      // No in-flight async work to interrupt in a synchronous fixture —
      // a safe no-op on an existing session, an error on an unknown one,
      // matching the sandbox fixture's own `cancel` precedent.
      requireOpenSession(sessionId);
    },

    async close(sessionId: string): Promise<void> {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        throw new TaviError("NOT_FOUND", `No browser session ${sessionId}`);
      }
      sessions.set(sessionId, { ...session, state: "closed" });
      navigationListeners.delete(sessionId);
      if (session.state === "open" && session.liveId !== undefined) options.live?.closed(session.liveId, "closed");
    },

    async taskEnded(taskId: string): Promise<void> {
      for (const [sessionId, session] of sessions) {
        if (session.state !== "open" || session.inactive === true || session.taskId !== taskId) continue;
        sessions.set(sessionId, { ...session, inactive: true });
        if (session.liveId !== undefined) options.live?.inactive(session.liveId);
      }
    },

    async pendingAction({ sessionId, epoch, kind, callId, decided }) {
      const session = sessions.get(sessionId);
      if (session === undefined || session.state !== "open" || session.epoch !== epoch || session.liveId === undefined) return;
      options.live?.action(
        session.liveId,
        decided === "denied" ? { phase: "ended", action: kind, status: "rejected", callId } : { phase: "pending", action: kind, callId },
      );
    },

    handoffTarget(sessionId: string, targetOptions?: { readonly wake?: boolean }) {
      const kept = sessions.get(sessionId);
      if (kept === undefined || kept.state !== "open" || kept.liveId === undefined || kept.taskId === undefined) return undefined;
      // Woken when kept from the last turn, on a wake only, without the agent's gate: asking for a person is not acting.
      const session = kept.inactive === true && targetOptions?.wake === true ? { ...kept, inactive: false } : kept;
      if (session !== kept) {
        sessions.set(sessionId, session);
        options.live?.activated(kept.liveId);
      }
      return { historyId: kept.liveId, taskId: kept.taskId };
    },

    async closeRecorded(recordedSessionId: string, reason: string): Promise<boolean> {
      for (const [sessionId, session] of sessions) {
        if (session.liveId !== recordedSessionId || session.state !== "open") continue;
        sessions.set(sessionId, { ...session, state: "closed" });
        navigationListeners.delete(sessionId);
        options.live?.closed(recordedSessionId, reason);
        return true;
      }
      return false;
    },
  };
}
