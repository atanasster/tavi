// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "../../../src/features/chat-panel/ChatPanel.js";
import { SHEET_SWIPE_PX } from "../../../src/lib/layout.js";
import { CHAT_SEEN_KEY, markSeen, seenRevision } from "../../../src/features/chat-panel/seen.js";
import { mount, rerender, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountAll();
  window.localStorage.clear();
});

/** The open panel on its activity tab: its sheet, its grip, and what it said of opening. */
async function mountSheet(onOpen = vi.fn()) {
  const host = await mount(
    <ChatPanel open tab="activity" title="Chat" onOpen={onOpen} onTab={() => undefined} render={() => <p>body</p>} />,
  );
  return {
    panel: host.querySelector(".chat-panel") as HTMLElement,
    grip: host.querySelector(".chat-panel-grip") as HTMLButtonElement,
    onOpen,
  };
}

const drag = async (grip: HTMLElement, by: number) => {
  await act(async () => {
    grip.dispatchEvent(new PointerEvent("pointerdown", { clientY: 500, bubbles: true }));
  });
  await act(async () => {
    grip.dispatchEvent(new PointerEvent("pointermove", { clientY: 500 + by / 2, bubbles: true }));
  });
  await act(async () => {
    grip.dispatchEvent(new PointerEvent("pointerup", { clientY: 500 + by, bubbles: true }));
  });
};

describe("the chat panel as a phone sheet", () => {
  it("moves between half and full height with a tap, a swipe or the arrow keys, and swipes shut from half", async () => {
    const { panel, grip, onOpen } = await mountSheet();
    expect(panel.className).toContain("sheet-half");
    await act(async () => grip.click());
    expect(panel.className).toContain("sheet-full");
    expect(grip.getAttribute("aria-label")).toBe("Shrink this chat's panel");
    await drag(grip, SHEET_SWIPE_PX + 10);
    expect(panel.className).toContain("sheet-half");
    await drag(grip, -(SHEET_SWIPE_PX + 10));
    expect(panel.className).toContain("sheet-full");
    // A short drag springs back, and the click a browser sends after it is not taken as a tap.
    await drag(grip, 20);
    await act(async () => grip.click());
    expect(panel.className).toContain("sheet-full");
    expect(panel.style.getPropertyValue("--chat-panel-sheet-drag")).toBe("");
    await act(async () => {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(panel.className).toContain("sheet-half");
    await act(async () => {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(panel.className).toContain("sheet-full");
    await act(async () => {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await drag(grip, SHEET_SWIPE_PX + 10);
    expect(onOpen).toHaveBeenCalledWith(false);
  });

  it("follows the finger while it drags", async () => {
    const { panel, grip } = await mountSheet();
    await act(async () => {
      grip.dispatchEvent(new PointerEvent("pointerdown", { clientY: 500, bubbles: true }));
    });
    await act(async () => {
      grip.dispatchEvent(new PointerEvent("pointermove", { clientY: 540, bubbles: true }));
    });
    expect(panel.style.getPropertyValue("--chat-panel-sheet-drag")).toBe("40px");
    expect(panel.className).toContain("sheet-dragging");
    await act(async () => {
      grip.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
    });
    expect(panel.style.getPropertyValue("--chat-panel-sheet-drag")).toBe("");
    expect(panel.className).not.toContain("sheet-dragging");
  });
});

describe("what the reader last looked at", () => {
  it("keeps one revision per chat, and reads nothing it did not write", () => {
    expect(seenRevision("t1")).toBeUndefined();
    markSeen("t1", 2);
    markSeen("t2", 5);
    markSeen("t1", 3);
    expect(seenRevision("t1")).toBe(3);
    expect(Object.keys(JSON.parse(window.localStorage.getItem(CHAT_SEEN_KEY) ?? "{}"))).toEqual(["t2", "t1"]);
    // At most 200 chats: the ones looked at longest ago are forgotten first.
    for (let index = 0; index < 205; index += 1) markSeen(`c${index}`, index);
    const kept = Object.keys(JSON.parse(window.localStorage.getItem(CHAT_SEEN_KEY) ?? "{}"));
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe("c5");
    expect(seenRevision("t1")).toBeUndefined();
    window.localStorage.setItem(CHAT_SEEN_KEY, "not json");
    expect(seenRevision("t1")).toBeUndefined();
    window.localStorage.setItem(CHAT_SEEN_KEY, JSON.stringify({ t1: "x", t2: -1, t3: 4 }));
    expect([seenRevision("t1"), seenRevision("t2"), seenRevision("t3")]).toEqual([undefined, undefined, 4]);
  });
});

describe("the chat panel shut from elsewhere", () => {
  const view = (open: boolean, badges = {}) => (
    <ChatPanel
      open={open}
      tab="memory"
      title="Chat"
      badges={badges}
      onOpen={() => undefined}
      onTab={() => undefined}
      render={() => <button type="button">inside</button>}
    />
  );

  it("puts focus on the rail's toggle when it was inside the panel, and leaves it elsewhere alone", async () => {
    const host = await mount(view(true));
    (host.querySelector(".chat-panel-body button") as HTMLButtonElement).focus();
    // The shortcut or the sidebar shuts it: not one of its own controls.
    await rerender(view(false));
    expect(document.activeElement).toBe(host.querySelector(".chat-panel-rail .chat-panel-toggle"));
    await rerender(view(true));
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    await rerender(view(false));
    expect(document.activeElement).toBe(outside);
    outside.remove();
    // Focus that was never in the panel (a click that focuses nothing, as Safari's) is not taken.
    await rerender(view(true));
    (document.activeElement as HTMLElement | null)?.blur();
    await rerender(view(false));
    expect(document.activeElement).toBe(document.body);
  });

  it("marks the phone's lone button when any tab has news, and not otherwise", async () => {
    const host = await mount(view(false, { memory: 0 }));
    expect(host.querySelector(".chat-panel-rail-toggle .chat-panel-any")).toBeNull();
    await rerender(view(false, { instructions: "dot" }));
    expect(host.querySelector(".chat-panel-rail-toggle .chat-panel-any")?.getAttribute("aria-label")).toBe("something here changed");
  });
});
