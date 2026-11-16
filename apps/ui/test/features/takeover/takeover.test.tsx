// @vitest-environment jsdom
import type { BrowserLiveInputEvent, BrowserLiveMessage } from "@tavi/contracts";
import type { LiveWatchOptions } from "@tavi/client/browser";
import { act, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { HandoffCard } from "../../../src/features/takeover/HandoffCard.js";
import { TAKEOVER_IDLE_MS, TAKEOVER_STILL_WORKING_MS, Takeover, type TakeoverClient } from "../../../src/features/takeover/Takeover.js";
import {
  TakeoverContext,
  declineThrough,
  stopLabel,
  stopTakenOverTask,
  type TakeoverActions,
} from "../../../src/features/takeover/context.js";
import {
  InputBatcher,
  formatControlled,
  formatLeft,
  keyEventOf,
  pagePoint,
  textEvents,
  uploadChunks,
  uploadRefusal,
} from "../../../src/features/takeover/input.js";
import { InWorkspace } from "../../support/workspace.js";
import { button, flush, rerender, settledBy, unmountAll } from "../../support/dom.js";

/**
 * Taking the agent's browser over in the canvas: the input mapping, the surface and the handoff card.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const METADATA = { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 };
const SESSION = "6f1d2c3b-0000-4000-8000-000000000001";
const keyOf = (
  key: string,
  code: string,
  extra: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; keyCode: number }> = {},
) => ({ key, code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });

describe("the takeover's input", () => {
  it("maps keys as the page expects them: printable text, Enter as a return, Escape to the page, tab shortcuts dropped", () => {
    expect(keyEventOf(keyOf("a", "KeyA", { keyCode: 65 }), "down")).toEqual({
      type: "key",
      action: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      text: "a",
    });
    expect(keyEventOf(keyOf("A", "KeyA", { shiftKey: true }), "up")).toEqual({
      type: "key",
      action: "up",
      key: "A",
      code: "KeyA",
      modifiers: 8,
    });
    expect(keyEventOf(keyOf("Enter", "Enter", { keyCode: 13 }), "down")).toMatchObject({ key: "Enter", text: "\r" });
    expect(keyEventOf(keyOf("Escape", "Escape"), "down")).toMatchObject({ key: "Escape" });
    expect(keyEventOf(keyOf("c", "KeyC", { ctrlKey: true }), "down")).toEqual({
      type: "key",
      action: "down",
      key: "c",
      code: "KeyC",
      modifiers: 2,
    });
    expect(keyEventOf(keyOf("t", "KeyT", { metaKey: true }), "down")).toBeUndefined();
    expect(keyEventOf(keyOf("w", "KeyW", { ctrlKey: true }), "down")).toBeUndefined();
  });

  it("maps a point over the picture through the frame's metadata, kept inside the viewport", () => {
    const box = { left: 100, top: 50, width: 640, height: 360 };
    expect(pagePoint(box, 420, 230, METADATA)).toEqual({ x: 640, y: 360 });
    expect(pagePoint(box, 2000, -10, METADATA)).toEqual({ x: 1279, y: 0 });
    expect(pagePoint(box, 420, 230, { ...METADATA, pageScaleFactor: 2 })).toEqual({ x: 320, y: 180 });
  });

  it("splits a long paste, and batches input in order, keeping only the last of a run of moves", async () => {
    expect(textEvents("x".repeat(5000)).map((event) => (event.type === "text" ? event.text.length : 0))).toEqual([4096, 904]);
    vi.useFakeTimers();
    try {
      const sent: { seq: number; events: readonly BrowserLiveInputEvent[] }[] = [];
      const batcher = new InputBatcher(async (events, seq) => void sent.push({ seq, events }), 40);
      for (let x = 0; x < 5; x += 1) batcher.push({ type: "mouse", action: "move", x, y: 0 });
      batcher.push({ type: "mouse", action: "down", x: 4, y: 0, button: "left", clickCount: 1 });
      for (let index = 0; index < 70; index += 1) batcher.push({ type: "text", text: "k" });
      await vi.advanceTimersByTimeAsync(40);
      await vi.advanceTimersByTimeAsync(40);
      expect(sent.map((batch) => [batch.seq, batch.events.length])).toEqual([
        [1, 64],
        [2, 8],
      ]);
      expect(sent[0]?.events.slice(0, 2)).toEqual([
        { type: "mouse", action: "move", x: 4, y: 0 },
        { type: "mouse", action: "down", x: 4, y: 0, button: "left", clickCount: 1 },
      ]);
      batcher.push({ type: "text", text: "never sent" });
      batcher.close();
      await vi.advanceTimersByTimeAsync(100);
      expect(sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps batches apart by the clock however the timers bunch up, and drains everything when asked", async () => {
    vi.useFakeTimers();
    try {
      const sent: number[] = [];
      const batcher = new InputBatcher(async (events) => void sent.push(events.length), 40);
      for (let index = 0; index < 130; index += 1) batcher.push({ type: "text", text: "k" });
      // Flushes in a burst (late timers firing together) send one batch, not three.
      await Promise.all([batcher.flush(), batcher.flush(), batcher.flush()]);
      expect(sent).toEqual([64]);
      const drained = batcher.drain();
      await vi.advanceTimersByTimeAsync(200);
      await drained;
      expect(sent).toEqual([64, 64, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spaces what it sends by the clock even after a slow answer, so a catch-up never bursts past the owner's rate", async () => {
    vi.useFakeTimers();
    try {
      const at: number[] = [];
      let slow = true;
      const batcher = new InputBatcher(async () => {
        at.push(Date.now());
        if (slow) {
          slow = false;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }, 40);
      batcher.push({ type: "text", text: "a" });
      // The first answer is slow: batches queue up behind it meanwhile.
      for (let tick = 0; tick < 10; tick += 1) {
        await vi.advanceTimersByTimeAsync(45);
        batcher.push({ type: "text", text: "b" });
      }
      const drained = batcher.drain();
      await vi.advanceTimersByTimeAsync(2000);
      await drained;
      expect(at.length).toBeGreaterThan(2);
      for (let index = 1; index < at.length; index += 1) expect((at[index] ?? 0) - (at[index - 1] ?? 0)).toBeGreaterThanOrEqual(40);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says times as a person reads them", () => {
    expect(formatControlled(72_400)).toBe("1 m 12 s");
    expect(formatControlled(45_000)).toBe("45 s");
    expect(formatLeft(14 * 60_000 + 32_000)).toBe("14:32");
    expect(formatLeft(-5)).toBe("0:00");
  });
});

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** What was asked answered: microtasks only, as some tests here fake the clock. */
const { settle, mount, click } = settledBy(() => flush(6, 1));

/** The takeover of SESSION in the chat `chat`, watched through `client`; `props` add to or change it. */
const takeover = (client: TakeoverClient, props: Partial<ComponentProps<typeof Takeover>> = {}) => (
  <InWorkspace workspaceId="default">
    <Takeover client={client} taskId="chat" sessionId={SESSION} onClose={() => undefined} {...props} />
  </InWorkspace>
);

/** The page's picture on `page`, laid out at 640×360 from the corner, as jsdom lays out nothing. */
function picture(page: HTMLElement): HTMLImageElement {
  const image = page.querySelector("img") as HTMLImageElement;
  image.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 640,
    height: 360,
    right: 640,
    bottom: 360,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return image;
}

/** The input batches sent so far, once the batcher's interval has passed. */
async function inputSent(requests: readonly Record<string, unknown>[]): Promise<BrowserLiveInputEvent[]> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  await settle();
  return requests.filter((request) => request["action"] === "input").flatMap((request) => request["events"] as BrowserLiveInputEvent[]);
}

/** A live watch the test drives: it records what the surface asked of the owner. */
function owner() {
  const requests: Record<string, unknown>[] = [];
  let deliver: LiveWatchOptions["onMessage"] = () => undefined;
  const answers: { take?: { ok: boolean; error?: { code: string; message: string } } } = {};
  const client: TakeoverClient = {
    liveWatch: async (_taskId, options) => {
      deliver = options.onMessage;
      return {
        response: { ok: true },
        watch: {
          ended: false,
          close: async () => void requests.push({ action: "closed" }),
          control: async (request) => {
            requests.push(request as Record<string, unknown>);
            if (request["action"] === "take") return answers.take ?? { ok: true };
            return { ok: true };
          },
        },
      };
    },
  };
  return {
    client,
    requests,
    answers,
    send: async (message: BrowserLiveMessage) => {
      await act(async () => deliver(message, () => undefined));
      await settle();
    },
  };
}

const frame: BrowserLiveMessage = {
  kind: "frame",
  sessionId: SESSION,
  mime: "image/jpeg",
  data: "/9j/4AAQ",
  width: 640,
  height: 360,
  metadata: METADATA,
  at: "2026-10-04T10:00:00.000Z",
  source: "live",
};

describe("the takeover surface", () => {
  it("takes the session, shows the page, and sends what the person does over it, with the host's bar", async () => {
    const test = owner();
    const page = await mount(
      takeover(test.client, {
        handoff: { instructions: "Sign in, then hand back", deadlineAt: new Date(Date.now() + 14 * 60_000).toISOString() },
      }),
    );
    expect(test.requests[0]).toMatchObject({ action: "take", sessionId: SESSION });
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    await test.send(frame);
    await test.send({ kind: "navigated", sessionId: SESSION, url: "https://shop.example/login", title: "Sign in", epoch: 1 });
    expect(page.textContent).toContain("You're in control — Tavi is paused");
    expect(page.textContent).toContain("Tavi doesn't see what you type");
    expect(page.textContent).toContain("shop.example — Sign in");
    expect(page.textContent).toContain("Sign in, then hand back");
    expect(page.querySelector(".takeover-left")?.textContent).toMatch(/^1[34]:\d\d left$/);
    const image = picture(page);
    await act(async () => {
      image.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 320, clientY: 180, button: 0 }));
      image.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 320, clientY: 180, button: 0 }));
    });
    const surface = page.querySelector(".takeover-page") as HTMLElement;
    await act(async () => {
      surface.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "h", code: "KeyH" }));
      surface.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "t", code: "KeyT", ctrlKey: true }));
      surface.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" }));
    });
    const sent = await inputSent(test.requests);
    expect(sent).toEqual([
      { type: "mouse", action: "down", x: 640, y: 360, button: "left", clickCount: 1 },
      { type: "mouse", action: "up", x: 640, y: 360, button: "left", clickCount: 1 },
      { type: "key", action: "down", key: "h", code: "KeyH", text: "h" },
      { type: "key", action: "down", key: "Escape", code: "Escape" },
    ]);
  });

  it("names Stop by what it ends: a chat or a run is cancelled, a Home or a worker only stopped", () => {
    expect(stopLabel(undefined, true)).toBe("Stop the chat");
    expect(stopLabel("side", true)).toBe("Stop the chat");
    expect(stopLabel("run", true)).toBe("Stop the run");
    expect(stopLabel("home", true)).toBe("Stop the agent");
    expect(stopLabel("worker", true)).toBe("Stop the agent");
    expect(stopLabel(undefined, false)).toBe("Stop the agent");
  });

  it("says why the task could not be stopped, rather than closing as if it had been", async () => {
    const test = owner();
    const closed = vi.fn();
    const page = await mount(
      takeover(test.client, { onClose: closed, onStopTask: async () => "The task is already finished.", stopLabel: "Stop the chat" }),
    );
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    await click(button(page, "Stop the chat"));
    await settle();
    expect(page.textContent).toContain("The task is already finished.");
    expect(closed).not.toHaveBeenCalled();
  });

  it("scrolls the page with a one-finger drag and clicks it with a tap", async () => {
    const test = owner();
    const page = await mount(takeover(test.client));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    await test.send(frame);
    const image = picture(page);
    const touch = (type: string, clientX: number, clientY: number) =>
      image.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, clientY, button: 0, pointerType: "touch", pointerId: 7 }));
    await act(async () => {
      touch("pointerdown", 100, 100);
      touch("pointermove", 100, 98);
      touch("pointermove", 100, 60);
      touch("pointerup", 100, 60);
      touch("pointerdown", 320, 180);
      touch("pointerup", 320, 180);
    });
    const sent = await inputSent(test.requests);
    expect(sent).toEqual([
      // A finger that barely moved is still a tap; one that moved further scrolls, the page following it.
      { type: "wheel", x: 200, y: 120, deltaX: 0, deltaY: 80 },
      { type: "mouse", action: "down", x: 640, y: 360, button: "left", clickCount: 1 },
      { type: "mouse", action: "up", x: 640, y: 360, button: "left", clickCount: 1 },
    ]);
  });

  it("keeps its watch, its control and what is being typed when re-rendered with another client object", async () => {
    const test = owner();
    let opened = 0;
    const counting = (): TakeoverClient => ({ liveWatch: (taskId, options) => ((opened += 1), test.client.liveWatch(taskId, options)) });
    const page = await mount(takeover(counting()));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    const surface = page.querySelector(".takeover-page") as HTMLElement;
    await act(async () => surface.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a", code: "KeyA" })));
    await rerender(takeover(counting()));
    await rerender(takeover(counting()));
    const sent = await inputSent(test.requests);
    expect(opened).toBe(1);
    expect(test.requests.filter((request) => request["action"] === "take")).toHaveLength(1);
    expect(sent).toEqual([{ type: "key", action: "down", key: "a", code: "KeyA", text: "a" }]);
  });

  it("is modal: the page behind it is inert while it is open, focus goes in, and comes back to its opener on close", async () => {
    const behind = document.createElement("div");
    const opener = document.createElement("button");
    opener.textContent = "Take over";
    behind.append(opener);
    document.body.append(behind);
    try {
      opener.focus();
      const test = owner();
      const page = await mount(takeover(test.client));
      const overlay = page.querySelector<HTMLElement>('.takeover[role="dialog"]');
      expect(overlay?.contains(document.activeElement)).toBe(true);
      // Tab cannot leave it for the page behind: everything outside it is inert.
      expect(behind.hasAttribute("inert")).toBe(true);
      expect(page.hasAttribute("inert")).toBe(false);
      unmountAll();
      expect(behind.hasAttribute("inert")).toBe(false);
      expect(document.activeElement).toBe(opener);
    } finally {
      behind.remove();
    }
  });

  it("draws the page's own dropdown as a group of buttons it moves through by arrow, and Escape closes", async () => {
    const test = owner();
    const page = await mount(takeover(test.client));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    await test.send({
      kind: "select",
      sessionId: SESSION,
      ref: "select-1",
      options: [
        { value: "s", label: "Small", selected: false },
        { value: "m", label: "Medium", selected: true },
      ],
    });
    expect(document.activeElement?.textContent).toBe("Medium");
    await act(async () =>
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })),
    );
    expect(document.activeElement?.textContent).toBe("Cancel");
    await act(async () =>
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
    );
    expect(page.querySelector(".takeover-picker")).toBeNull();
    expect(document.activeElement?.classList.contains("takeover-page")).toBe(true);
  });

  it("draws the page's list and dialog for the person, and answers them", async () => {
    const test = owner();
    const page = await mount(takeover(test.client));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    await test.send({
      kind: "select",
      sessionId: SESSION,
      ref: "select-1",
      options: [
        { value: "s", label: "Small", selected: true },
        { value: "m", label: "Medium", selected: false },
      ],
    });
    expect(page.querySelector(".takeover-picker")?.textContent).toContain("Medium");
    await click(button(page, "Medium"));
    expect(test.requests.at(-1)).toEqual({ action: "select", sessionId: SESSION, ref: "select-1", value: "m" });
    expect(page.querySelector(".takeover-picker")).toBeNull();
    await test.send({ kind: "dialog", sessionId: SESSION, type: "prompt", message: "Your name?", defaultValue: "guest" });
    expect(page.querySelector(".takeover-dialog")?.textContent).toContain("Your name?");
    await click(button(page, "OK"));
    expect(test.requests.at(-1)).toEqual({ action: "dialog", sessionId: SESSION, accept: true, text: "guest" });
    await test.send({ kind: "notice", sessionId: SESSION, notice: "shortcut-refused" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(page.textContent).toContain("That shortcut is not passed to the page.");
  });

  it("hands back with a note, says it could not be done, or offers to take control where another tab holds it", async () => {
    const test = owner();
    const closed = vi.fn();
    const page = await mount(takeover(test.client, { onClose: closed }));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "other" });
    expect(page.textContent).toContain("Controlled in another tab");
    await click(button(page, "Take control here"));
    expect(test.requests.at(-1)).toMatchObject({ action: "take" });
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    await click(button(page, "Done — hand back"));
    expect(page.textContent).toContain("Don't include passwords or codes; Tavi will read this.");
    const input = page.querySelector(".takeover-note input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Signed in as guest");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button(page, "Hand back"));
    expect(test.requests.filter((request) => request["action"] === "release")).toEqual([
      { action: "release", sessionId: SESSION, outcome: "done", note: "Signed in as guest" },
    ]);
    expect(closed).toHaveBeenCalled();
  });

  it("takes control again by itself when its connection comes back within the grace, and asks after it", async () => {
    const test = owner();
    const page = await mount(takeover(test.client));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    const takes = () => test.requests.filter((request) => request["action"] === "take").length;
    const before = takes();
    // A blip: back after 3 s.
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "none", unattendedMs: 3_000 });
    expect(takes()).toBe(before + 1);
    expect(page.textContent).toContain("You're in control — Tavi is paused");
    // Away longer: asked.
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "none", unattendedMs: 60_000 });
    expect(takes()).toBe(before + 1);
    expect(page.textContent).toContain("You still have control");
  });

  it("says the person still has control when no tab holds it, offers to resume it, and says when Tavi takes the page back", async () => {
    const test = owner();
    const page = await mount(takeover(test.client));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "none" });
    expect(page.textContent).toContain("You still have control");
    await click(button(page, "Resume control"));
    expect(test.requests.at(-1)).toMatchObject({ action: "take" });
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    // The wait's deadline (or the owner's) takes it back: said, not just shown.
    await test.send({ kind: "control", sessionId: SESSION, state: "agent" });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(page.textContent).toContain("Tavi has the browser");
    expect(page.querySelector("[aria-live]")?.textContent ?? "").toBe("Tavi has the browser back.");
  });

  it("cancels an announcement still waiting to be said when the surface closes", async () => {
    const test = owner();
    await mount(takeover(test.client));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    const started = vi.spyOn(window, "setTimeout");
    const cleared = vi.spyOn(window, "clearTimeout");
    await test.send({ kind: "control", sessionId: SESSION, state: "agent" });
    try {
      const saying = started.mock.results.find((_result, at) => started.mock.calls[at]?.[1] === 30)?.value;
      expect(saying).toBeDefined();
      // Only the close's own clearing counts, not one an earlier announcement made.
      cleared.mockClear();
      unmountAll();
      expect(cleared).toHaveBeenCalledWith(saying);
    } finally {
      started.mockRestore();
      cleared.mockRestore();
    }
  });

  it("asks whether the person is still working after ten idle minutes, and hands back as a timeout when nobody answers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const start = Date.parse("2026-10-04T10:00:00.000Z");
    vi.setSystemTime(start);
    const test = owner();
    const page = await mount(takeover(test.client));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TAKEOVER_IDLE_MS + 1000);
    });
    expect(page.textContent).toContain("Still working?");
    // A timeout warning takes focus to its one way out.
    expect(document.activeElement?.textContent).toBe("Keep control");
    expect(document.activeElement?.closest('[role="alertdialog"]')?.getAttribute("aria-describedby")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TAKEOVER_STILL_WORKING_MS);
    });
    await settle();
    expect(test.requests.filter((request) => request["action"] === "release")).toEqual([
      { action: "release", sessionId: SESSION, outcome: "timeout" },
    ]);
  });

  it("checks a person's own grab for idleness even when the agent waits on it, and never an agent's request however it was opened", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const start = Date.parse("2026-10-04T10:00:00.000Z");
    vi.setSystemTime(start);
    const grabbed = owner();
    const own = await mount(
      takeover(grabbed.client, { handoff: { deadlineAt: new Date(start + 60 * 60_000).toISOString(), reason: "operator" } }),
    );
    await grabbed.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    // No countdown for the wait the agent set on the person's own take.
    expect(own.textContent).not.toContain("left");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TAKEOVER_IDLE_MS + 1000);
    });
    expect(own.textContent).toContain("Still working?");
    unmountAll();

    // Opened from a card that knew nothing of the request: the session says it was asked for.
    const asked = owner();
    const page = await mount(takeover(asked.client));
    await asked.send({
      kind: "session",
      sessionId: SESSION,
      taskId: "chat",
      state: "open",
      control: "requested",
      handoffDeadlineAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    await asked.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    // Its time left, from the session itself.
    expect(page.querySelector(".takeover-left")?.textContent).toMatch(/^1[45]:\d\d left$/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TAKEOVER_IDLE_MS + TAKEOVER_STILL_WORKING_MS + 1000);
    });
    expect(page.textContent).not.toContain("Still working?");
    expect(asked.requests.some((request) => request["action"] === "release")).toBe(false);
  });

  it("says what failed when the browser cannot be taken over", async () => {
    const test = owner();
    test.answers.take = { ok: false, error: { code: "CONFLICT", message: "Control of this browser session went elsewhere" } };
    const page = await mount(takeover(test.client));
    expect(page.querySelector('[role="alert"]')?.textContent).toBe("Control of this browser session went elsewhere");
  });
});

describe("taking a kept session, its task over", () => {
  it("takes the page a finished turn kept, and is not told the session ended when its task had", async () => {
    const test = owner();
    const page = await mount(takeover(test.client));
    // A kept session's watch begins with its task's end: the page is still there to take.
    await test.send({ kind: "session", sessionId: SESSION, taskId: "chat", state: "inactive", url: "https://shop.example/form" });
    await test.send(frame);
    await test.send({ kind: "ended", sessionId: SESSION, reason: "task-ended" });
    expect(test.requests[0]).toMatchObject({ action: "take", sessionId: SESSION });
    expect(page.textContent).not.toContain("Tavi has the browser");
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    expect(page.textContent).toContain("You're in control");
    // A session that closes is over, whatever was said before.
    await test.send({ kind: "ended", sessionId: SESSION, reason: "closed" });
    expect(page.textContent).toContain("Tavi has the browser");
  });
});

describe("a phone's takeover", () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });
  /** A window `width` wide: the phone layout's query matches up to 720. */
  const windowOf = (width: number): void => {
    window.matchMedia = ((media: string) => ({
      media,
      matches: width <= Number(/max-width: (\d+)px/.exec(media)?.[1] ?? 0),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  };

  it("asks for the page at the phone's size, so it is drawn at its real size", async () => {
    windowOf(390);
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 700);
    const test = owner();
    await mount(takeover(test.client));
    expect(test.requests[0]).toMatchObject({ action: "take", sessionId: SESSION, viewport: { width: 390, height: 700 } });
  });

  it("lays the page out again at the size the surface has once the person is in control, and only when it changed", async () => {
    windowOf(390);
    vi.stubGlobal("innerWidth", 390);
    // In control, the bar grows a line: the surface is shorter than it was when taken.
    let measured = 0;
    const height = Object.getOwnPropertyDescriptor(window, "innerHeight");
    onTestFinished(
      () =>
        void (height === undefined
          ? delete (window as { innerHeight?: number }).innerHeight
          : Object.defineProperty(window, "innerHeight", height)),
    );
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => (measured++ === 0 ? 700 : 660) });
    const test = owner();
    await mount(takeover(test.client));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    const takes = () => test.requests.filter((request) => request["action"] === "take");
    expect(takes().map((request) => request["viewport"])).toEqual([
      { width: 390, height: 700 },
      { width: 390, height: 660 },
    ]);
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    expect(takes()).toHaveLength(2);
  });

  it("leaves the page at its own size on a wider screen", async () => {
    windowOf(1280);
    const test = owner();
    await mount(takeover(test.client));
    expect(test.requests[0]).toMatchObject({ action: "take", sessionId: SESSION });
    expect(test.requests[0]).not.toHaveProperty("viewport");
  });
});

describe("the handoff card", () => {
  it("asks the person to take control or to say they can't, and sends the note", async () => {
    const opened: unknown[] = [];
    const declined: unknown[] = [];
    const actions: TakeoverActions = {
      open: (target) => void opened.push(target),
      decline: async (target, note) => (declined.push({ target, note }), undefined),
    };
    const deadlineAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const page = await mount(
      <TakeoverContext.Provider value={actions}>
        <HandoffCard
          taskId="chat"
          handoff={{ sessionId: SESSION, reason: "sign-in", instructions: "Sign in to shop.example" }}
          deadlineAt={deadlineAt}
        />
      </TakeoverContext.Provider>,
    );
    expect(page.textContent).toContain("Tavi needs you in the browser");
    expect(page.textContent).toContain("Sign in to shop.example");
    expect(page.textContent).toContain("a screen reader cannot read it");
    await click(button(page, "Take control"));
    expect(opened).toEqual([
      { taskId: "chat", sessionId: SESSION, handoff: { instructions: "Sign in to shop.example", deadlineAt, reason: "sign-in" } },
    ]);
    await click(button(page, "I can't do this"));
    await click(button(page, "Tell Tavi"));
    expect(declined).toEqual([{ target: expect.objectContaining({ sessionId: SESSION }), note: undefined }]);
    expect(page.textContent).toContain("Told Tavi you could not do this.");
  });

  it("offers to resume control when the agent's call waits on the person, and says where to go without a live view", async () => {
    const page = await mount(
      <HandoffCard
        taskId="chat"
        handoff={{ sessionId: SESSION, reason: "operator" }}
        deadlineAt={new Date(Date.now() + 60_000).toISOString()}
      />,
    );
    expect(page.textContent).toContain("Tavi is waiting for you to hand the browser back");
    expect(page.textContent).toContain("Open Tavi where the live browser view is offered");
  });
});

describe("declining the agent's request", () => {
  it("closes its watch whatever the owner answers, and says why it was refused", async () => {
    const test = owner();
    const target = { taskId: "chat", sessionId: SESSION };
    expect(await declineThrough(test.client.liveWatch, "default", target, "No access")).toBeUndefined();
    expect(test.requests).toEqual([{ action: "decline", sessionId: SESSION, note: "No access" }, { action: "closed" }]);
    const refusing: TakeoverClient = {
      liveWatch: async () => ({
        response: { ok: true },
        watch: {
          ended: false,
          close: async () => void test.requests.push({ action: "closed again" }),
          control: async () => ({
            ok: false,
            error: { code: "CONFLICT", message: "Nobody is being asked to act in this browser session now" },
          }),
        },
      }),
    };
    expect(await declineThrough(refusing.liveWatch, "default", target)).toBe("Nobody is being asked to act in this browser session now");
    expect(test.requests.at(-1)).toEqual({ action: "closed again" });
  });
});

describe("the phone's text field", () => {
  it("sends typed text through input, and keys that make no text once", async () => {
    const test = owner();
    const page = await mount(takeover(test.client));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    const field = page.querySelector(".takeover-typing") as HTMLTextAreaElement;
    await act(async () => {
      field.value = "hé";
      field.dispatchEvent(new InputEvent("input", { bubbles: true, data: "hé" }));
      field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace", code: "Backspace" }));
      field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Backspace", code: "Backspace" }));
    });
    const sent = await inputSent(test.requests);
    expect(sent).toEqual([
      { type: "text", text: "hé" },
      { type: "key", action: "down", key: "Backspace", code: "Backspace" },
      { type: "key", action: "up", key: "Backspace", code: "Backspace" },
    ]);
  });
});

describe("a press the page must not keep", () => {
  it("lets go of the button when the pointer is cancelled, and sends nothing for a cancel with none held", async () => {
    const test = owner();
    const page = await mount(takeover(test.client));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    await test.send(frame);
    const image = picture(page);
    await act(async () => {
      image.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, clientX: 1, clientY: 1 }));
      image.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 64, clientY: 36, button: 0 }));
      image.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, clientX: 64, clientY: 36 }));
    });
    const sent = await inputSent(test.requests);
    expect(sent.map((event) => (event.type === "mouse" ? event.action : event.type))).toEqual(["down", "up"]);
  });
});

describe("files for the page", () => {
  it("cuts a file into chunks the owner takes, and refuses what the page or the limits do not allow", () => {
    expect(uploadChunks(new TextEncoder().encode("hello world"), 6)).toEqual([
      { offset: 0, data: btoa("hello ") },
      { offset: 6, data: btoa("world") },
    ]);
    expect(uploadChunks(new Uint8Array())).toEqual([{ offset: 0, data: "" }]);
    expect(uploadRefusal([{ size: 1 }, { size: 1 }], false)).toBe("The page takes one file.");
    expect(uploadRefusal([{ size: 21 * 1024 * 1024 }], true)).toBe("At most 20 MiB of files.");
    expect(uploadRefusal([{ size: 10 }], false)).toBeUndefined();
  });

  it("offers its own picker when the page asks for a file, and sends what the person chooses in order", async () => {
    const test = owner();
    const page = await mount(takeover(test.client));
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    await test.send({ kind: "chooser", sessionId: SESSION, multiple: false, accept: ".txt" });
    const picker = page.querySelector('input[type="file"]') as HTMLInputElement;
    expect(picker.accept).toBe(".txt");
    expect(picker.multiple).toBe(false);
    expect(page.textContent).toContain("Tavi keeps no copy");
    const file = new File(["alpha"], "a.txt", { type: "text/plain" });
    Object.defineProperty(picker, "files", { configurable: true, value: [file] });
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    expect(test.requests.filter((request) => request["action"] === "upload")).toEqual([
      {
        action: "upload",
        sessionId: SESSION,
        count: 1,
        index: 0,
        name: "a.txt",
        type: "text/plain",
        size: 5,
        offset: 0,
        data: btoa("alpha"),
      },
    ]);
    expect(page.querySelector('input[type="file"]')).toBeNull();
    await test.send({ kind: "chooser", sessionId: SESSION, multiple: true });
    // Control went to another tab: this one offers no picker meanwhile.
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "other" });
    expect(page.querySelector('input[type="file"]')).toBeNull();
    await test.send({ kind: "control", sessionId: SESSION, state: "operator", controller: "you" });
    await click(button(page, "Cancel"));
    expect(test.requests.at(-1)).toEqual({ action: "upload-cancel", sessionId: SESSION });
  });
});

describe("Stop from the takeover", () => {
  type Answer = { readonly ok: boolean; readonly error?: { readonly code: string; readonly message: string } };
  const owner = (answers: Record<string, Answer>) => {
    const asked: string[] = [];
    const request = async (command: "abort" | "cancel" | "tasks", payload: Record<string, unknown>): Promise<Answer> => {
      const key = command === "tasks" ? `tasks:${String(payload["action"])}` : command;
      asked.push(key);
      return answers[key] ?? { ok: true };
    };
    return { asked, request };
  };
  const notRunning = { ok: false, error: { code: "NOT_RUNNING", message: "no turn" } };

  it("withdraws a Home's handoff instead of cancelling it", async () => {
    const { asked, request } = owner({ abort: notRunning });
    expect(await stopTakenOverTask(request, { taskId: "home-1", workspaceId: "default", isHome: true })).toMatchObject({ ok: true });
    expect(asked).toEqual(["abort", "tasks:stop-handoff"]);
  });

  it("cancels any other waiting task, and withdraws the handoff of a Home the page had not read when the cancel is refused", async () => {
    const plain = owner({ abort: notRunning });
    await stopTakenOverTask(plain.request, { taskId: "chat-1", workspaceId: "default", isHome: false });
    expect(plain.asked).toEqual(["abort", "cancel"]);
    const unread = owner({ abort: notRunning, cancel: { ok: false, error: { code: "CONFLICT", message: "Home is never cancelled" } } });
    expect(await stopTakenOverTask(unread.request, { taskId: "home-1", workspaceId: "default", isHome: false })).toMatchObject({
      ok: true,
    });
    expect(unread.asked).toEqual(["abort", "cancel", "tasks:stop-handoff"]);
    // Nothing to withdraw either: the cancel's own refusal is what the person reads.
    const neither = owner({
      abort: notRunning,
      cancel: { ok: false, error: { code: "CONFLICT", message: "already over" } },
      "tasks:stop-handoff": notRunning,
    });
    expect(await stopTakenOverTask(neither.request, { taskId: "chat-2", workspaceId: "default", isHome: false })).toMatchObject({
      error: { message: "already over" },
    });
    // A running turn is only aborted.
    const running = owner({});
    await stopTakenOverTask(running.request, { taskId: "home-1", workspaceId: "default", isHome: true });
    expect(running.asked).toEqual(["abort"]);
  });
});
