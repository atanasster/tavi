import {
  BROWSER_LIVE_CHECK_INTERVAL_MS,
  BROWSER_LIVE_CONTROL_QUALITY,
  BROWSER_LIVE_INPUT_MAX_EVENTS,
  BROWSER_LIVE_MAX_FRAME_BYTES,
  BROWSER_LIVE_MAX_SCREENCASTS,
  BROWSER_LIVE_TAKE_WAIT_MS,
  BROWSER_LIVE_UNATTENDED_MS,
  type BrowserLiveControlChange,
  type BrowserLiveInputEvent,
  type BrowserLiveMessage,
} from "@tavi/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIXTURE_LIVE_JPEG } from "./support/fixture.js";
import {
  createBrowserLiveSource,
  jpegSize,
  refusedShortcut,
  type LiveControlTarget,
  type LiveDialogInfo,
  type LiveTarget,
  type LiveTargetFrame,
} from "../src/live.js";
import type { SensitiveReason } from "../src/sensitivity.js";

const METADATA = { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 };

/** A page whose screencast, sensitivity and navigations a test drives by hand. */
function fakeTarget() {
  const casts: { settings: { maxWidth: number; quality: number }; onFrame: (frame: LiveTargetFrame) => void; stopped: boolean }[] = [];
  const navigated = new Set<(page?: { readonly url: string; readonly title?: string }) => void>();
  let sensitivity: () => Promise<SensitiveReason | undefined> = async () => undefined;
  const acks: number[] = [];
  let frames = 0;
  const target: LiveTarget = {
    async screencast(settings, onFrame) {
      const cast = { settings, onFrame, stopped: false };
      casts.push(cast);
      return { stop: async () => void (cast.stopped = true) };
    },
    sensitivity: () => sensitivity(),
    onNavigated(listener) {
      navigated.add(listener);
      return () => navigated.delete(listener);
    },
  };
  return {
    target,
    casts,
    acks,
    running: () => casts.filter((cast) => !cast.stopped),
    /** Chromium paints a frame on the running screencast; answers its number. */
    paint(data = FIXTURE_LIVE_JPEG): number {
      const cast = casts.filter((entry) => !entry.stopped).at(-1);
      if (cast === undefined) throw new Error("no screencast is running");
      const id = (frames += 1);
      cast.onFrame({ data, metadata: METADATA, ack: () => acks.push(id) });
      return id;
    },
    navigated,
    navigate: () => {
      for (const listener of navigated) listener();
    },
    setSensitivity(next: () => Promise<SensitiveReason | undefined>) {
      sensitivity = next;
    },
  };
}

function sinkOf(answer: () => boolean = () => true) {
  const messages: BrowserLiveMessage[] = [];
  return {
    messages,
    sink: (message: BrowserLiveMessage) => (messages.push(message), answer()),
    kinds: () => messages.map((message) => (message.kind === "hidden" ? `hidden:${message.reason}` : message.kind)),
  };
}

/** Lets the source's async sensitivity checks settle. */
const flush = () => vi.advanceTimersByTimeAsync(0);

let clock = 0;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
});
afterEach(() => vi.useRealTimers());

function sourceWith(...targets: ReturnType<typeof fakeTarget>[]) {
  const source = createBrowserLiveSource({ now: () => clock });
  targets.forEach((page, index) =>
    source.opened({
      sessionId: `s${index + 1}`,
      workspaceId: "w",
      taskId: `t${index + 1}`,
      openedByCallId: `call-${index + 1}`,
      target: page.target,
      blockedHosts: async () => [],
    }),
  );
  return source;
}

describe("the live view's producer", () => {
  it("runs no screencast without a watcher, shares one at the widest width, and stops it with the last watcher (invariant 7)", async () => {
    const page = fakeTarget();
    const source = sourceWith(page);
    expect(page.casts).toHaveLength(0);
    const narrow = source.watch("s1", { maxWidth: 320, quality: 60 }, sinkOf().sink);
    expect(page.running().map((cast) => cast.settings.maxWidth)).toEqual([320]);
    const wide = source.watch("s1", { maxWidth: 800, quality: 60 }, sinkOf().sink);
    await flush();
    expect(page.running().map((cast) => cast.settings.maxWidth)).toEqual([800]);
    wide.close();
    await flush();
    expect(page.running().map((cast) => cast.settings.maxWidth)).toEqual([320]);
    narrow.close();
    await flush();
    expect(page.running()).toEqual([]);
  });

  it("tells a new watcher the session first, then streams frames only once the page was checked clear", async () => {
    const page = fakeTarget();
    let release: (reason: SensitiveReason | undefined) => void = () => undefined;
    page.setSensitivity(() => new Promise((resolve) => (release = resolve)));
    const source = sourceWith(page);
    const viewer = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    expect(viewer.messages[0]).toEqual({ kind: "session", sessionId: "s1", taskId: "t1", state: "open", openedByCallId: "call-1" });
    page.paint();
    // Held, and not acknowledged, while the check runs.
    expect(viewer.kinds()).toEqual(["session"]);
    expect(page.acks).toEqual([]);
    await flush();
    release(undefined);
    await flush();
    expect(viewer.kinds()).toEqual(["session", "frame"]);
    expect(viewer.messages[1]).toMatchObject({
      kind: "frame",
      sessionId: "s1",
      mime: "image/jpeg",
      width: 16,
      height: 9,
      source: "live",
      metadata: METADATA,
    });
    expect(page.acks).toEqual([1]);
  });

  it("hides a sensitive page, drops its frames, and shows it again from a fresh frame once it clears (invariant 2)", async () => {
    const page = fakeTarget();
    let reason: SensitiveReason | undefined = "password-field";
    page.setSensitivity(async () => reason);
    const source = sourceWith(page);
    const viewer = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    await flush();
    expect(viewer.kinds()).toEqual(["session", "hidden:password-field"]);
    page.paint();
    await flush();
    expect(viewer.kinds()).toEqual(["session", "hidden:password-field"]);
    reason = undefined;
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_CHECK_INTERVAL_MS);
    // The frame taken while the page was sensitive is never sent; the stream restarted.
    expect(viewer.kinds()).toEqual(["session", "hidden:password-field"]);
    expect(page.casts.filter((cast) => cast.stopped)).toHaveLength(1);
    page.paint();
    await flush();
    expect(viewer.kinds()).toEqual(["session", "hidden:password-field", "frame"]);
  });

  it("counts a check that fails as sensitive (fail closed)", async () => {
    const page = fakeTarget();
    page.setSensitivity(async () => {
      throw new Error("frame detached");
    });
    const source = sourceWith(page);
    const viewer = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    await flush();
    page.paint();
    await flush();
    expect(viewer.kinds()).toEqual(["session", "hidden:blocked-host"]);
  });

  it("holds a frame newer than the last passing check by more than the interval until the next check passes", async () => {
    const page = fakeTarget();
    let checks = 0;
    let release: (reason: SensitiveReason | undefined) => void = () => undefined;
    page.setSensitivity(() => {
      checks += 1;
      return checks === 1 ? Promise.resolve(undefined) : new Promise((resolve) => (release = resolve));
    });
    const source = sourceWith(page);
    const viewer = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    await flush();
    page.paint();
    await flush();
    expect(viewer.kinds()).toEqual(["session", "frame"]);
    clock += BROWSER_LIVE_CHECK_INTERVAL_MS + 1;
    page.paint();
    await flush();
    expect(viewer.kinds()).toEqual(["session", "frame"]);
    expect(checks).toBe(2);
    release("payment-field");
    await flush();
    expect(viewer.kinds()).toEqual(["session", "frame", "hidden:payment-field"]);
    expect(page.acks).toEqual([1]);
  });

  it("re-checks on every navigation, holding frames until it answers", async () => {
    const page = fakeTarget();
    let reason: SensitiveReason | undefined;
    page.setSensitivity(async () => reason);
    const source = sourceWith(page);
    const viewer = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    await flush();
    reason = "payment-field";
    page.navigate();
    page.paint();
    await flush();
    expect(viewer.kinds()).toEqual(["session", "hidden:payment-field"]);
  });

  it("acknowledges a frame only when a watcher can take another, and otherwise on its demand", async () => {
    const page = fakeTarget();
    let credit = false;
    const source = sourceWith(page);
    const viewer = sinkOf(() => credit);
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    await flush();
    page.paint();
    await flush();
    expect(viewer.kinds()).toEqual(["session", "frame"]);
    expect(page.acks).toEqual([]);
    credit = true;
    watch.demand();
    expect(page.acks).toEqual([1]);
    watch.demand();
    expect(page.acks).toEqual([1]);
  });

  it(`runs at most ${BROWSER_LIVE_MAX_SCREENCASTS} screencasts, pausing the next watcher until one frees`, async () => {
    const pages = Array.from({ length: BROWSER_LIVE_MAX_SCREENCASTS + 1 }, () => fakeTarget());
    const source = sourceWith(...pages);
    const watches = pages
      .slice(0, BROWSER_LIVE_MAX_SCREENCASTS)
      .map((_, index) => source.watch(`s${index + 1}`, { maxWidth: 640, quality: 60 }, sinkOf().sink));
    const last = sinkOf();
    source.watch(`s${pages.length}`, { maxWidth: 640, quality: 60 }, last.sink);
    expect(last.kinds()).toEqual(["session", "hidden:paused"]);
    expect(pages.at(-1)?.casts).toHaveLength(0);
    watches[0]?.close();
    await flush();
    expect(pages.at(-1)?.running()).toHaveLength(1);
  });

  it("keeps the cap while a running screencast restarts or follows a new tab: the paused watcher stays paused", async () => {
    const pages = Array.from({ length: BROWSER_LIVE_MAX_SCREENCASTS + 1 }, () => fakeTarget());
    const source = sourceWith(...pages);
    for (let index = 0; index < BROWSER_LIVE_MAX_SCREENCASTS; index += 1)
      source.watch(`s${index + 1}`, { maxWidth: 320, quality: 60 }, sinkOf().sink);
    const last = sinkOf();
    source.watch(`s${pages.length}`, { maxWidth: 320, quality: 60 }, last.sink);
    // A wider watcher restarts s1's screencast; a new tab moves s2's.
    source.watch("s1", { maxWidth: 800, quality: 60 }, sinkOf().sink);
    const popup = fakeTarget();
    source.retarget("s2", popup.target);
    await flush();
    const running =
      [...pages.slice(0, BROWSER_LIVE_MAX_SCREENCASTS), popup].reduce((count, page) => count + page.running().length, 0) +
      (pages.at(-1)?.running().length ?? 0);
    expect(running).toBe(BROWSER_LIVE_MAX_SCREENCASTS);
    expect(pages.at(-1)?.running()).toEqual([]);
    expect(popup.running()).toHaveLength(1);
    expect(last.kinds()).toEqual(["session", "hidden:paused"]);
  });

  it("discards a check's answer when the page navigated while it ran, even with nobody streaming", async () => {
    const page = fakeTarget();
    const releases: ((reason: SensitiveReason | undefined) => void)[] = [];
    page.setSensitivity(() => new Promise((resolve) => releases.push(resolve)));
    const source = sourceWith(page);
    const viewer = sinkOf();
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    await flush();
    watch.close();
    page.navigate();
    // The old page's check passes after the navigation: its answer must not clear the new page.
    releases[0]?.(undefined);
    await flush();
    expect(releases).toHaveLength(2);
    const next = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, next.sink);
    page.paint();
    await flush();
    expect(next.kinds()).toEqual(["session"]);
  });

  it("tells watchers a screencast that failed to start is paused, and gives its slot to a waiting session", async () => {
    const pages = Array.from({ length: BROWSER_LIVE_MAX_SCREENCASTS + 1 }, () => fakeTarget());
    const broken = pages[0];
    if (broken === undefined) throw new Error("no page");
    const source = sourceWith(...pages);
    broken.target.screencast = async () => {
      throw new Error("Target closed");
    };
    const first = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, first.sink);
    for (let index = 1; index < BROWSER_LIVE_MAX_SCREENCASTS; index += 1)
      source.watch(`s${index + 1}`, { maxWidth: 640, quality: 60 }, sinkOf().sink);
    source.watch(`s${pages.length}`, { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await flush();
    expect(first.kinds()).toEqual(["session", "hidden:paused"]);
    expect(pages.at(-1)?.running()).toHaveLength(1);
  });

  it("moves the screencast to the new page when the session follows a new tab", async () => {
    const page = fakeTarget();
    const popup = fakeTarget();
    const source = sourceWith(page);
    source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await flush();
    source.retarget("s1", popup.target);
    await flush();
    expect(page.running()).toEqual([]);
    expect(popup.running()).toHaveLength(1);
  });

  it("sends the stored thumbnail first, scrubbed navigations, and action boxes only on a page that is not hidden", async () => {
    const page = fakeTarget();
    const source = sourceWith(page);
    source.thumbnail("s1", Buffer.from(FIXTURE_LIVE_JPEG, "base64"));
    const viewer = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    expect(viewer.messages[1]).toMatchObject({ kind: "frame", source: "thumbnail", width: 16, height: 9 });
    await flush();
    source.navigated("s1", { url: "https://example.com/a?token=secret#x", title: "A", epoch: 2 });
    expect(viewer.messages.at(-1)).toEqual({ kind: "navigated", sessionId: "s1", url: "https://example.com/a", title: "A", epoch: 2 });
    const box = { x: 1, y: 2, width: 3, height: 4 };
    source.action("s1", { phase: "started", action: "click", box, callId: "call-9" });
    expect(viewer.messages.at(-1)).toEqual({ kind: "action", sessionId: "s1", phase: "started", action: "click", box, callId: "call-9" });
    page.setSensitivity(async () => "password-field");
    page.navigate();
    await flush();
    source.action("s1", { phase: "started", action: "type", box });
    expect(viewer.messages.at(-1)).toEqual({ kind: "action", sessionId: "s1", phase: "started", action: "type" });
  });

  it("drops a frame past the byte bound and asks for a lower quality", async () => {
    const page = fakeTarget();
    const source = sourceWith(page);
    const viewer = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    await flush();
    page.paint("A".repeat(BROWSER_LIVE_MAX_FRAME_BYTES + 1));
    await flush();
    expect(viewer.kinds()).toEqual(["session"]);
    expect(page.running().map((cast) => cast.settings.quality)).toEqual([45]);
  });

  it("lists a task tree's sessions, announces each one, and ends a closed session's watchers", async () => {
    const announced: string[] = [];
    const source = createBrowserLiveSource({ now: () => clock });
    source.onSession((workspaceId, info) => announced.push(`${workspaceId}/${info.sessionId}:${info.state}`));
    const page = fakeTarget();
    source.opened({ sessionId: "s1", workspaceId: "w", taskId: "t1", target: page.target, blockedHosts: async () => [] });
    source.opened({ sessionId: "s2", workspaceId: "w", taskId: "t2", target: fakeTarget().target, blockedHosts: async () => [] });
    expect(source.sessions({ workspaceId: "w", taskIds: ["t1"] }).map((info) => info.sessionId)).toEqual(["s1"]);
    expect(source.sessions({ workspaceId: "other", taskIds: ["t1", "t2"] })).toEqual([]);
    const viewer = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    await flush();
    source.closed("s1", "closed");
    await flush();
    expect(viewer.messages.slice(-2)).toEqual([
      { kind: "session", sessionId: "s1", taskId: "t1", state: "closed" },
      { kind: "ended", sessionId: "s1", reason: "closed" },
    ]);
    expect(page.running()).toEqual([]);
    expect(announced).toEqual(["w/s1:open", "w/s2:open", "w/s1:closed"]);
    const late = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, late.sink);
    expect(late.messages).toEqual([{ kind: "ended", sessionId: "s1", reason: "closed" }]);
  });
});

describe("immediate hiding", () => {
  it("checks the page at once when it grows a sensitive field, and stops the page's watch with the screencast", async () => {
    const page = fakeTarget();
    let found: () => void = () => undefined;
    const stopped: number[] = [];
    let installed = 0;
    let reason: SensitiveReason | undefined;
    page.setSensitivity(async () => reason);
    page.target.watchSensitive = async (listener) => {
      installed += 1;
      found = listener;
      return async () => void stopped.push(1);
    };
    const source = sourceWith(page);
    const viewer = sinkOf();
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    await flush();
    page.paint();
    await flush();
    expect(viewer.kinds()).toContain("frame");
    // A password field appears: hidden now, not at the next interval.
    reason = "password-field";
    found();
    await flush();
    expect(viewer.kinds().at(-1)).toBe("hidden:password-field");
    // The page clears again: its screencast restarts, its one watch stays.
    reason = undefined;
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_CHECK_INTERVAL_MS);
    expect(page.casts.filter((cast) => cast.stopped).length).toBeGreaterThan(0);
    expect(installed).toBe(1);
    expect(stopped).toEqual([]);
    watch.close();
    await flush();
    expect(stopped).toEqual([1]);
  });
});

describe("an action waiting for approval", () => {
  it("is shown to a watcher who arrives while it waits, outlined once the page is known clear, and forgotten once it runs or is denied", async () => {
    const page = fakeTarget();
    const source = sourceWith(page);
    const box = { x: 1, y: 2, width: 3, height: 4 };
    source.action("s1", { phase: "pending", action: "submit", box, callId: "call-submit" });
    const late = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, late.sink);
    // Not known clear yet: the action, without where it is.
    expect(late.messages.filter((message) => message.kind === "action")).toEqual([
      { kind: "action", sessionId: "s1", phase: "pending", action: "submit", callId: "call-submit" },
    ]);
    await flush();
    expect(late.messages.filter((message) => message.kind === "action").at(-1)).toEqual({
      kind: "action",
      sessionId: "s1",
      phase: "pending",
      action: "submit",
      box,
      callId: "call-submit",
    });
    source.action("s1", { phase: "ended", action: "submit", status: "rejected", callId: "call-submit" });
    const later = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, later.sink);
    expect(later.messages.some((message) => message.kind === "action")).toBe(false);
  });
});

describe("inactive sessions", () => {
  it("stops a session's stream when its task ends but keeps its watchers, tells a later watch it is kept, and streams again once in use", async () => {
    const page = fakeTarget();
    const source = sourceWith(page);
    const announced: string[] = [];
    source.onSession((_workspaceId, info) => announced.push(info.state));
    source.thumbnail("s1", Buffer.from(FIXTURE_LIVE_JPEG, "base64"));
    const viewer = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, viewer.sink);
    await flush();
    source.inactive("s1");
    expect(viewer.messages.slice(-2)).toEqual([
      { kind: "session", sessionId: "s1", taskId: "t1", state: "inactive", openedByCallId: "call-1" },
      { kind: "ended", sessionId: "s1", reason: "task-ended" },
    ]);
    await flush();
    expect(page.running()).toEqual([]);
    expect(source.sessions({ workspaceId: "w", taskIds: ["t1"] }).map((info) => info.state)).toEqual(["inactive"]);
    const late = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, late.sink);
    expect(late.kinds()).toEqual(["session", "frame", "ended"]);
    await flush();
    expect(page.running()).toEqual([]);
    source.activated("s1");
    expect(announced).toEqual(["inactive", "open"]);
    // The kept watchers are told it is in use again, and see it live without watching it anew.
    expect(viewer.messages.at(-1)).toMatchObject({ kind: "session", sessionId: "s1", state: "open" });
    await flush();
    expect(page.running()).toHaveLength(1);
  });

  it("lets a person take a kept session after its task ended, streams it only while they hold it, and hands it back still kept", async () => {
    const page = fakeTarget();
    const { control, state } = fakeControl();
    const { source, changes } = controlledSource(page, control);
    const panel = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, panel.sink);
    await flush();
    source.inactive("s1");
    await flush();
    expect(page.running()).toEqual([]);
    const mine = sinkOf();
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, mine.sink);
    expect(watch.control).toBeDefined();
    await watch.control?.take({ maxWidth: 1200 });
    expect(state.begun).toBe(1);
    expect(source.controlState("s1")).toBe("operator");
    expect(changes).toEqual([{ sessionId: "s1", taskId: "t1", state: "operator" }]);
    // Every view says the person holds it, and the stream runs while they do.
    expect(controls(panel).at(-1)).toEqual({ kind: "control", sessionId: "s1", state: "operator", controller: "other" });
    await flush();
    expect(page.running().map((cast) => cast.settings)).toEqual([{ maxWidth: 1200, quality: BROWSER_LIVE_CONTROL_QUALITY }]);
    expect(source.sessions({ workspaceId: "w", taskIds: ["t1"] })[0]).toMatchObject({ state: "inactive", control: "operator" });
    clock += 30_000;
    watch.control?.release("done", undefined, "operator:ui");
    expect(changes.at(-1)).toMatchObject({ state: "agent", outcome: "done", controlledMs: 30_000, by: "operator:ui" });
    await flush();
    // Handed back, it is kept as it was: nothing streams until the chat's next turn uses it.
    expect(page.running()).toEqual([]);
    expect(source.sessions({ workspaceId: "w", taskIds: ["t1"] })[0]?.state).toBe("inactive");
    // A closed session is not taken.
    source.closed("s1", "closed");
    await expect(watch.control?.take({ maxWidth: 1200 })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("a phone's takeover", () => {
  it("lays the page out at the phone's size while that phone holds it, and restores it for a wider tab or once handed back", async () => {
    const page = fakeTarget();
    const { control, state } = fakeControl();
    const { source } = controlledSource(page, control);
    const phone = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    const laptop = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await phone.control?.take({ maxWidth: 1170, viewport: { width: 390, height: 700 } });
    expect(state.layouts).toEqual(["390x700"]);
    // Taken again on the same phone, turned on its side: the new size.
    await phone.control?.take({ maxWidth: 1170, viewport: { width: 700, height: 360 } });
    await laptop.control?.take({ maxWidth: 1400 });
    expect(state.layouts).toEqual(["390x700", "700x360", "own"]);
    await phone.control?.take({ maxWidth: 1170, viewport: { width: 390, height: 700 } });
    phone.control?.release("done");
    // Handing back undoes the take, which restores the session's own viewport.
    expect(state.ended).toBe(1);
    expect(state.layouts).toEqual(["390x700", "700x360", "own", "390x700"]);
  });
});

/** A page a person can take over: what reaches it is recorded by kind and position only. */
function fakeControl(options: { readonly picker?: { x: number; y: number } } = {}) {
  const applied: string[] = [];
  const events: {
    dialog?: (info: LiveDialogInfo) => void;
    fileChooser?: (info: { readonly multiple: boolean; readonly accept?: string }) => void;
  } = {};
  const state = {
    begun: 0,
    ended: 0,
    failNext: false,
    selected: [] as string[],
    answers: [] as string[],
    files: [] as string[],
    layouts: [] as string[],
  };
  const control: LiveControlTarget = {
    async begin(handlers) {
      state.begun += 1;
      Object.assign(events, handlers);
      return async () => void (state.ended += 1);
    },
    async layout(viewport) {
      state.layouts.push(viewport === undefined ? "own" : `${viewport.width}x${viewport.height}`);
    },
    async input(event) {
      if (state.failNext) {
        state.failNext = false;
        throw new Error(`could not apply ${JSON.stringify(event)}`);
      }
      applied.push(
        event.type === "mouse"
          ? `${event.action}@${event.x},${event.y}`
          : event.type === "key"
            ? `key:${event.action}:${event.key}`
            : event.type === "text"
              ? "text"
              : "wheel",
      );
    },
    async selectAt(x, y) {
      const at = options.picker;
      return at !== undefined && at.x === x && at.y === y
        ? {
            ref: "select-1",
            options: [
              { value: "a", label: "A", selected: true },
              { value: "b", label: "B", selected: false },
            ],
          }
        : undefined;
    },
    async selectOption(ref, value) {
      state.selected.push(`${ref}=${value}`);
    },
    async answerDialog(accept, text) {
      state.answers.push(`${accept}:${text ?? ""}`);
    },
    async setFiles(files) {
      state.files.push(files.map((file) => `${file.name}:${file.mimeType}:${Buffer.from(file.buffer).toString("utf8")}`).join("|"));
    },
    async dismissChooser() {
      state.files.push("dismissed");
    },
  };
  return { control, applied, events, state };
}

function controlledSource(page: ReturnType<typeof fakeTarget>, control: LiveControlTarget, onError?: (error: unknown) => void) {
  const source = createBrowserLiveSource({ now: () => clock, ...(onError === undefined ? {} : { onError }) });
  source.opened({ sessionId: "s1", workspaceId: "w", taskId: "t1", target: page.target, blockedHosts: async () => [], control });
  const changes: BrowserLiveControlChange[] = [];
  source.onControl?.((change) => changes.push(change));
  return { source, changes };
}

const controls = (viewer: ReturnType<typeof sinkOf>) => viewer.messages.filter((message) => message.kind === "control");
const click = (x: number, y: number): BrowserLiveInputEvent[] => [
  { type: "mouse", action: "down", x, y, button: "left", clickCount: 1 },
  { type: "mouse", action: "up", x, y, button: "left", clickCount: 1 },
];

describe("operator takeover", () => {
  it("takes control after the agent's step in flight, refuses the agent meanwhile, streams sharper to the controller, and hands back with the outcome", async () => {
    const page = fakeTarget();
    const { control, state } = fakeControl();
    const { source, changes } = controlledSource(page, control);
    const mine = sinkOf();
    const theirs = sinkOf();
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, mine.sink);
    source.watch("s1", { maxWidth: 320, quality: 60 }, theirs.sink);
    await flush();
    const step = source.agentCall("s1");
    let took = false;
    const taking = watch.control?.take({ maxWidth: 1400 }).then(() => (took = true));
    await flush();
    // The take waits for the step, and no new step starts meanwhile.
    expect(took).toBe(false);
    expect(controls(mine).at(-1)).toEqual({ kind: "control", sessionId: "s1", state: "agent", pending: true });
    expect(() => source.agentCall("s1")).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    step();
    await taking;
    expect(state.begun).toBe(1);
    expect(source.controlState("s1")).toBe("operator");
    // Counted, so the adapter withholds what the person may type once the agent acts again.
    expect(source.personTakes?.("s1")).toBe(1);
    expect(source.personTakes?.("unknown")).toBe(0);
    expect(source.sessions({ workspaceId: "w", taskIds: ["t1"] })[0]?.control).toBe("operator");
    expect(controls(mine).at(-1)).toEqual({ kind: "control", sessionId: "s1", state: "operator", controller: "you" });
    expect(controls(theirs).at(-1)).toEqual({ kind: "control", sessionId: "s1", state: "operator", controller: "other" });
    await flush();
    expect(page.running().map((cast) => cast.settings)).toEqual([{ maxWidth: 1400, quality: BROWSER_LIVE_CONTROL_QUALITY }]);
    expect(changes).toEqual([{ sessionId: "s1", taskId: "t1", state: "operator" }]);
    expect(() => source.agentCall("s1")).toThrow(expect.objectContaining({ code: "CONFLICT", details: { control: "operator" } }));
    // The person's own navigation while they hold the page reaches every watcher: the bar names where they went.
    for (const listener of page.navigated) listener({ url: "https://shop.example/account", title: "Your account" });
    expect(theirs.messages.filter((message) => message.kind === "navigated").at(-1)).toMatchObject({
      url: "https://shop.example/account",
      title: "Your account",
    });

    clock += 72_000;
    watch.control?.release("done", "  Signed in as the shop's guest.  ", "operator:ui");
    expect(source.controlState("s1")).toBe("agent");
    expect(state.ended).toBe(1);
    expect(changes.at(-1)).toEqual({
      sessionId: "s1",
      taskId: "t1",
      state: "agent",
      outcome: "done",
      note: "Signed in as the shop's guest.",
      controlledMs: 72_000,
      by: "operator:ui",
    });
    expect(controls(theirs).at(-1)).toEqual({ kind: "control", sessionId: "s1", state: "agent" });
    await flush();
    expect(page.running().map((cast) => cast.settings)).toEqual([{ maxWidth: 640, quality: 60 }]);
    expect(source.agentCall("s1")).toBeTypeOf("function");
  });

  it("never takes alongside an agent's step: it waits for a long one, and is refused, the agent still in control, past its bound", async () => {
    const page = fakeTarget();
    const { control } = fakeControl();
    const { source } = controlledSource(page, control);
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    // A long step (a download, say) that settles inside the bound: the take follows it.
    const done = source.agentCall("s1");
    const waiting = watch.control?.take({ maxWidth: 800 });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(source.controlState("s1")).toBe("agent");
    done();
    await waiting;
    expect(source.controlState("s1")).toBe("operator");
    watch.control?.release("done");

    // One that outlives it: refused, nothing changed hands.
    source.agentCall("s1");
    const refused = watch.control?.take({ maxWidth: 800 });
    const outcome = expect(refused).rejects.toMatchObject({ code: "CONFLICT" });
    await vi.advanceTimersByTimeAsync(BROWSER_LIVE_TAKE_WAIT_MS);
    await outcome;
    expect(source.controlState("s1")).toBe("agent");
  });

  it("accepts input from the controller alone, in order, clamped to the viewport, dropping browser shortcuts (invariants 8 and 9)", async () => {
    const page = fakeTarget();
    const { control, applied } = fakeControl();
    const { source } = controlledSource(page, control);
    const mine = sinkOf();
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, mine.sink);
    const other = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await expect(watch.control?.input(click(1, 1)) ?? Promise.resolve()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await watch.control?.take({ maxWidth: 1280 });
    await flush();
    page.paint();
    await expect(other.control?.input(click(1, 1)) ?? Promise.resolve()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await other.control?.take({ maxWidth: 1 });
    // The newer tab took it: the first is told, and refused.
    expect(controls(mine).at(-1)).toMatchObject({ state: "operator", controller: "other" });
    await expect(watch.control?.input(click(1, 1)) ?? Promise.resolve()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(() => watch.control?.release("done")).toThrow(expect.objectContaining({ code: "NOT_AUTHORIZED" }));
    await watch.control?.take({ maxWidth: 1280 });
    const batches = [
      watch.control?.input([...click(5000, -20), { type: "key", action: "down", key: "t", code: "KeyT", modifiers: 2 }]),
      watch.control?.input([
        { type: "key", action: "down", key: "F5", code: "F5" },
        { type: "text", text: "secret" },
      ]),
    ];
    await Promise.all(batches);
    expect(applied).toEqual(["down@1279,0", "up@1279,0", "key:down:F5", "text"]);
    expect(mine.messages.filter((message) => message.kind === "notice")).toEqual([
      { kind: "notice", sessionId: "s1", notice: "shortcut-refused" },
    ]);
    const tooMany = Array.from({ length: BROWSER_LIVE_INPUT_MAX_EVENTS + 1 }, () => ({
      type: "wheel" as const,
      x: 1,
      y: 1,
      deltaX: 0,
      deltaY: 1,
    }));
    await expect(watch.control?.input(tooMany) ?? Promise.resolve()).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("reports a failure applying input without the input itself", async () => {
    const page = fakeTarget();
    const { control, state } = fakeControl();
    const reported: string[] = [];
    const { source } = controlledSource(page, control, (error) => reported.push(String(error)));
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await watch.control?.take({ maxWidth: 800 });
    state.failNext = true;
    await expect(watch.control?.input([{ type: "text", text: "hunter2" }]) ?? Promise.resolve()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(reported.join("\n")).not.toContain("hunter2");
    expect(reported).toHaveLength(1);
    // The queue goes on.
    await watch.control?.input([{ type: "text", text: "next" }]);
  });

  it("opens a drop-down through the host instead of pressing it, and answers it once", async () => {
    const page = fakeTarget();
    const { control, applied, state } = fakeControl({ picker: { x: 30, y: 40 } });
    const { source } = controlledSource(page, control);
    const mine = sinkOf();
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, mine.sink);
    await watch.control?.take({ maxWidth: 800 });
    await watch.control?.input(click(30, 40));
    expect(applied).toEqual([]);
    expect(mine.messages.at(-1)).toEqual({
      kind: "select",
      sessionId: "s1",
      ref: "select-1",
      options: [
        { value: "a", label: "A", selected: true },
        { value: "b", label: "B", selected: false },
      ],
    });
    await watch.control?.select("select-1", "b");
    expect(state.selected).toEqual(["select-1=b"]);
    await expect(watch.control?.select("select-1", "a") ?? Promise.resolve()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await watch.control?.input(click(1, 2));
    expect(applied).toEqual(["down@1,2", "up@1,2"]);
  });

  it("shows the page's dialog to the controller only, again to one who takes over, and answers it", async () => {
    const page = fakeTarget();
    const { control, events, state } = fakeControl();
    const { source } = controlledSource(page, control);
    const first = sinkOf();
    const second = sinkOf();
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, first.sink);
    const next = source.watch("s1", { maxWidth: 640, quality: 60 }, second.sink);
    await watch.control?.take({ maxWidth: 800 });
    events.dialog?.({ type: "prompt", message: "Your name?", defaultValue: "guest" });
    events.fileChooser?.({ multiple: false, accept: ".pdf" });
    const dialogs = (viewer: ReturnType<typeof sinkOf>) =>
      viewer.messages.filter((message) => message.kind === "dialog" || message.kind === "chooser");
    expect(dialogs(first)).toEqual([
      { kind: "dialog", sessionId: "s1", type: "prompt", message: "Your name?", defaultValue: "guest" },
      { kind: "chooser", sessionId: "s1", multiple: false, accept: ".pdf" },
    ]);
    expect(dialogs(second)).toEqual([]);
    await next.control?.take({ maxWidth: 800 });
    expect(dialogs(second)).toEqual([
      { kind: "dialog", sessionId: "s1", type: "prompt", message: "Your name?", defaultValue: "guest" },
      { kind: "chooser", sessionId: "s1", multiple: false, accept: ".pdf" },
    ]);
    await expect(watch.control?.dialog(true, "x") ?? Promise.resolve()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await next.control?.dialog(true, "Ada");
    expect(state.answers).toEqual(["true:Ada"]);
    await expect(next.control?.dialog(false) ?? Promise.resolve()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("streams a sensitive page to the controller alone, and hides it from it again once handed back (invariant 2)", async () => {
    const page = fakeTarget();
    page.setSensitivity(async () => "password-field");
    const { control } = fakeControl();
    const { source } = controlledSource(page, control);
    const mine = sinkOf();
    const theirs = sinkOf();
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, mine.sink);
    source.watch("s1", { maxWidth: 640, quality: 60 }, theirs.sink);
    await flush();
    await watch.control?.take({ maxWidth: 800 });
    await flush();
    page.paint();
    await flush();
    expect(mine.kinds().filter((kind) => kind === "frame")).toHaveLength(1);
    expect(theirs.kinds()).not.toContain("frame");
    expect(theirs.kinds()).toContain("hidden:password-field");
    watch.control?.release("failed");
    expect(mine.kinds().at(-1)).toBe("hidden:password-field");
    page.paint();
    await flush();
    expect(mine.kinds().filter((kind) => kind === "frame")).toHaveLength(1);
  });

  it("keeps the operator in control when the controller's tab leaves, until another takes it or the host ends it", async () => {
    const page = fakeTarget();
    const { control } = fakeControl();
    const { source, changes } = controlledSource(page, control);
    const watcher = sinkOf();
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    const other = source.watch("s1", { maxWidth: 640, quality: 60 }, watcher.sink);
    await watch.control?.take({ maxWidth: 800 });
    watch.close();
    expect(source.controlState("s1")).toBe("operator");
    expect(controls(watcher).at(-1)).toEqual({ kind: "control", sessionId: "s1", state: "operator", controller: "none", unattendedMs: 0 });
    // A newcomer is told at once.
    const late = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, late.sink);
    // A newcomer is told how long nobody has held it: one back within its grace takes it again by itself.
    clock += 4_000;
    const later = sinkOf();
    source.watch("s1", { maxWidth: 640, quality: 60 }, later.sink);
    expect(controls(late)).toEqual([{ kind: "control", sessionId: "s1", state: "operator", controller: "none", unattendedMs: 0 }]);
    expect(controls(later)).toEqual([{ kind: "control", sessionId: "s1", state: "operator", controller: "none", unattendedMs: 4_000 }]);
    await other.control?.take({ maxWidth: 800 });
    expect(controls(watcher).at(-1)).toMatchObject({ controller: "you" });
    source.endControl("s1", "timeout");
    expect(changes.at(-1)).toMatchObject({ state: "agent", outcome: "timeout" });
  });

  it("hands an operator's own grab back as a timeout once no tab has held it for the unattended limit, but not an agent's request", async () => {
    const page = fakeTarget();
    const { control } = fakeControl();
    const { source, changes } = controlledSource(page, control);
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await watch.control?.take({ maxWidth: 800 });
    watch.close();
    vi.advanceTimersByTime(BROWSER_LIVE_UNATTENDED_MS - 1);
    expect(source.controlState("s1")).toBe("operator");
    // Taken again meanwhile: the clock stops.
    const again = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await again.control?.take({ maxWidth: 800 });
    vi.advanceTimersByTime(BROWSER_LIVE_UNATTENDED_MS);
    expect(source.controlState("s1")).toBe("operator");
    again.close();
    vi.advanceTimersByTime(BROWSER_LIVE_UNATTENDED_MS);
    expect(changes.at(-1)).toMatchObject({ state: "agent", outcome: "timeout" });

    // An agent's request is bounded by its wait's deadline instead.
    source.requestHandoff("s1");
    const asked = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await asked.control?.take({ maxWidth: 800 });
    asked.close();
    vi.advanceTimersByTime(BROWSER_LIVE_UNATTENDED_MS * 2);
    expect(source.controlState("s1")).toBe("operator");
  });

  it("waits, with nothing acting, while the agent asks for a person, and ends the control when the session ends", async () => {
    const page = fakeTarget();
    const { control } = fakeControl();
    const { source, changes } = controlledSource(page, control);
    source.requestHandoff("s1", "2026-10-04T10:15:00.000Z");
    expect(source.controlState("s1")).toBe("requested");
    expect(() => source.agentCall("s1")).toThrow(expect.objectContaining({ code: "CONFLICT", details: { control: "requested" } }));
    // Its deadline is the session's while the request stands, so any view can show the time left.
    expect(source.sessions({ workspaceId: "w", taskIds: ["t1"] })[0]).toMatchObject({
      control: "requested",
      handoffDeadlineAt: "2026-10-04T10:15:00.000Z",
    });
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await watch.control?.take({ maxWidth: 800 });
    expect(changes.map((change) => change.state)).toEqual(["requested", "operator"]);
    expect(source.sessions({ workspaceId: "w", taskIds: ["t1"] })[0]?.handoffDeadlineAt).toBe("2026-10-04T10:15:00.000Z");
    watch.control?.release("done");
    expect(source.sessions({ workspaceId: "w", taskIds: ["t1"] })[0]?.handoffDeadlineAt).toBeUndefined();
    source.requestHandoff("s1");
    await watch.control?.take({ maxWidth: 800 });
    source.closed("s1", "closed");
    expect(changes.at(-1)).toMatchObject({ state: "agent", outcome: "cancelled" });
    // A session without takeover offers none.
    const plain = sourceWith(fakeTarget());
    expect(plain.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink).control).toBeUndefined();
  });

  it("lets nothing in while the page is being prepared for a take: no agent call, a newer take wins, a close undoes it (invariants 9 and 10)", async () => {
    const page = fakeTarget();
    const { control, state } = fakeControl();
    let prepared: () => void = () => undefined;
    const begin = control.begin.bind(control);
    control.begin = async (handlers) => {
      await new Promise<void>((resolve) => (prepared = resolve));
      return begin(handlers);
    };
    const { source, changes } = controlledSource(page, control);
    const first = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    const second = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    const firstTake = first.control?.take({ maxWidth: 800 });
    await flush();
    expect(() => source.agentCall("s1")).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    const firstPrepared = prepared;
    const secondTake = second.control?.take({ maxWidth: 800 });
    await flush();
    firstPrepared();
    await expect(firstTake).rejects.toMatchObject({ code: "CONFLICT" });
    // The first's preparation was undone; the second's goes on.
    expect(state).toMatchObject({ begun: 1, ended: 1 });
    prepared();
    await secondTake;
    expect(source.controlState("s1")).toBe("operator");
    expect(state).toMatchObject({ begun: 2, ended: 1 });
    second.control?.release("done");

    // A session closing while it is prepared: nothing changes hands, nothing is left to settle.
    const third = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    const thirdTake = third.control?.take({ maxWidth: 800 });
    await flush();
    source.closed("s1", "closed");
    prepared();
    await expect(thirdTake).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state).toMatchObject({ begun: 3, ended: 3 });
    expect(changes.map((change) => change.state)).toEqual(["operator", "agent"]);
  });

  it("tells a take a newer one replaced that it no longer waits, and fails it", async () => {
    const page = fakeTarget();
    const { control } = fakeControl();
    const { source } = controlledSource(page, control);
    const older = sinkOf();
    const newer = sinkOf();
    const first = source.watch("s1", { maxWidth: 640, quality: 60 }, older.sink);
    const second = source.watch("s1", { maxWidth: 640, quality: 60 }, newer.sink);
    const step = source.agentCall("s1");
    const firstTake = first.control?.take({ maxWidth: 800 });
    await flush();
    expect(controls(older).at(-1)).toEqual({ kind: "control", sessionId: "s1", state: "agent", pending: true });
    const secondTake = second.control?.take({ maxWidth: 800 });
    await flush();
    // Told at once, not left showing "Taking control…" until the newer take settles.
    expect(controls(older).at(-1)).toEqual({ kind: "control", sessionId: "s1", state: "agent" });
    expect(controls(newer).at(-1)).toEqual({ kind: "control", sessionId: "s1", state: "agent", pending: true });
    step();
    await expect(firstTake).rejects.toMatchObject({ code: "CONFLICT" });
    await secondTake;
    expect(controls(older).at(-1)).toEqual({ kind: "control", sessionId: "s1", state: "operator", controller: "other" });
  });

  it("lets any watch decline the agent's request without taking the page, and the controller hand back as a timeout", async () => {
    const page = fakeTarget();
    const { control, state } = fakeControl();
    const { source, changes } = controlledSource(page, control);
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    expect(() => watch.control?.decline()).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    source.requestHandoff("s1");
    watch.control?.decline("  No access to that account  ");
    expect(source.controlState("s1")).toBe("agent");
    expect(changes.at(-1)).toEqual({
      sessionId: "s1",
      taskId: "t1",
      state: "agent",
      outcome: "failed",
      note: "No access to that account",
      controlledMs: 0,
    });
    expect(state.begun).toBe(0);
    await watch.control?.take({ maxWidth: 800 });
    watch.control?.release("timeout");
    expect(changes.at(-1)).toMatchObject({ state: "agent", outcome: "timeout" });
  });

  it("hands the page's file chooser the person's files, assembled in order in memory, within its limits", async () => {
    const page = fakeTarget();
    const { control, events, state } = fakeControl();
    const { source } = controlledSource(page, control);
    const mine = sinkOf();
    const watch = source.watch("s1", { maxWidth: 640, quality: 60 }, mine.sink);
    const other = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await watch.control?.take({ maxWidth: 800 });
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    const chunk = (index: number, name: string, size: number, offset: number, text: string, count = 2) => ({
      count,
      index,
      name,
      type: "text/plain",
      size,
      offset,
      data: b64(text),
    });
    await expect(watch.control?.upload(chunk(0, "a.txt", 3, 0, "abc")) ?? Promise.resolve()).rejects.toMatchObject({ code: "NOT_FOUND" });
    events.fileChooser?.({ multiple: true });
    expect(mine.messages.at(-1)).toEqual({ kind: "chooser", sessionId: "s1", multiple: true });
    await expect(other.control?.upload(chunk(0, "a.txt", 3, 0, "abc")) ?? Promise.resolve()).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    // Out of order: refused, and started over.
    await expect(watch.control?.upload(chunk(1, "b.txt", 2, 0, "de")) ?? Promise.resolve()).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await watch.control?.upload(chunk(0, "a.txt", 5, 0, "abc"));
    await watch.control?.upload(chunk(0, "a.txt", 5, 3, "de"));
    expect(state.files).toEqual([]);
    await watch.control?.upload(chunk(1, "b.txt", 2, 0, "fg"));
    expect(state.files).toEqual(["a.txt:text/plain:abcde|b.txt:text/plain:fg"]);
    // Taken: the chooser is gone, and more is refused.
    await expect(watch.control?.upload(chunk(0, "a.txt", 3, 0, "abc", 1)) ?? Promise.resolve()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // One file only, when the page takes one; past its size, refused.
    events.fileChooser?.({ multiple: false, accept: "image/*" });
    await expect(watch.control?.upload(chunk(0, "a.txt", 3, 0, "abc", 2)) ?? Promise.resolve()).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(watch.control?.upload(chunk(0, "a.txt", 2, 0, "abc", 1)) ?? Promise.resolve()).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await watch.control?.cancelUpload();
    expect(state.files.at(-1)).toBe("dismissed");
  });

  it("lets no one finish another's upload, caps the files' declared size, and zeroes their bytes once handed over", async () => {
    const page = fakeTarget();
    const { control, events } = fakeControl();
    const handed: Uint8Array[] = [];
    control.setFiles = async (files) => void handed.push(...files.map((file) => file.buffer));
    const { source } = controlledSource(page, control);
    const first = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    const second = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await first.control?.take({ maxWidth: 800 });
    events.fileChooser?.({ multiple: true });
    const piece = (name: string, size: number, offset: number, text: string, index = 0, count = 1) => ({
      count,
      index,
      name,
      type: "text/plain",
      size,
      offset,
      data: Buffer.from(text).toString("base64"),
    });
    await first.control?.upload(piece("mine.txt", 6, 0, "mine"));
    // Another tab takes over: the first one's half-sent file is gone, not finished by the second.
    await second.control?.take({ maxWidth: 800 });
    await expect(second.control?.upload(piece("mine.txt", 6, 4, "!!")) ?? Promise.resolve()).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    // Declared past the cap: refused at the first piece.
    await expect(second.control?.upload(piece("big.bin", 15 * 1024 * 1024, 0, "x", 0, 2)) ?? Promise.resolve()).resolves.toBeUndefined();
    await expect(second.control?.upload(piece("bigger.bin", 15 * 1024 * 1024, 0, "y", 1, 2)) ?? Promise.resolve()).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await second.control?.upload(piece("ok.txt", 2, 0, "ok"));
    expect(handed).toHaveLength(1);
    expect(handed[0]?.every((byte) => byte === 0)).toBe(true);
    // A controller leaving drops what it was sending.
    events.fileChooser?.({ multiple: true });
    await second.control?.upload(piece("left.txt", 6, 0, "half"));
    second.close();
    const third = source.watch("s1", { maxWidth: 640, quality: 60 }, sinkOf().sink);
    await third.control?.take({ maxWidth: 800 });
    await expect(third.control?.upload(piece("left.txt", 6, 4, "!!")) ?? Promise.resolve()).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("names the refused shortcuts: tabs and the browser's own UI, never the page's keys", () => {
    const key = (key: string, modifiers?: number): BrowserLiveInputEvent => ({
      type: "key",
      action: "down",
      key,
      code: "",
      ...(modifiers === undefined ? {} : { modifiers }),
    });
    expect([key("t", 2), key("W", 4), key("l", 2), key("Tab", 2), key("3", 4)].every(refusedShortcut)).toBe(true);
    expect([key("t"), key("F5"), key("Escape"), key("a", 2), key("t", 8), key("Tab")].some(refusedShortcut)).toBe(false);
  });
});

describe("jpegSize", () => {
  it("reads a JPEG's size from its frame header, and refuses what is not one", () => {
    expect(jpegSize(FIXTURE_LIVE_JPEG)).toEqual({ width: 16, height: 9 });
    expect(jpegSize(Buffer.from(FIXTURE_LIVE_JPEG, "base64"))).toEqual({ width: 16, height: 9 });
    expect(jpegSize("iVBORw0KGgo=")).toBeUndefined();
    expect(jpegSize(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
  });
});
