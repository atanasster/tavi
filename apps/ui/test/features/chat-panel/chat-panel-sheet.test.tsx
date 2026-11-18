// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "../../../src/features/chat-panel/ChatPanel.js";
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
  it("takes the height a drag leaves it at, moves between half and full with a tap or steps with the arrow keys, and closes dragged low", async () => {
    const { panel, grip, onOpen } = await mountSheet();
    // A drag of `percent` of the page's height (jsdom's is 768px).
    const by = (percent: number) => (percent / 100) * window.innerHeight;
    const height = () => panel.style.getPropertyValue("--chat-panel-sheet-height");
    expect(panel.className).toContain("sheet-half");
    expect(height()).toBe("45dvh");
    await act(async () => grip.click());
    expect(panel.className).toContain("sheet-full");
    expect(height()).toBe("90dvh");
    expect(grip.getAttribute("aria-label")).toBe("Shrink this chat's panel");
    await drag(grip, by(40));
    expect(height()).toBe("50dvh");
    expect(panel.className).toContain("sheet-half");
    await drag(grip, -by(20));
    expect(height()).toBe("70dvh");
    expect(panel.className).toContain("sheet-full");
    // Never higher than full; the click a browser sends after a drag is not taken as a tap.
    await drag(grip, -by(50));
    await act(async () => grip.click());
    expect(height()).toBe("90dvh");
    expect(panel.style.getPropertyValue("--chat-panel-sheet-drag")).toBe("");
    await act(async () => {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(height()).toBe("80dvh");
    await act(async () => {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(height()).toBe("90dvh");
    // The height is kept for the next visit.
    expect(window.localStorage.getItem("tavi.chatpanel.sheet")).toBe("90");
    await drag(grip, by(70));
    expect(onOpen).toHaveBeenCalledWith(false);
    expect(window.localStorage.getItem("tavi.chatpanel.sheet")).toBe("45");
  });

  it("opens at the height it was left at, and at half for one out of range", async () => {
    window.localStorage.setItem("tavi.chatpanel.sheet", "72");
    expect((await mountSheet()).panel.style.getPropertyValue("--chat-panel-sheet-height")).toBe("72dvh");
    unmountAll();
    window.localStorage.setItem("tavi.chatpanel.sheet", "5");
    expect((await mountSheet()).panel.style.getPropertyValue("--chat-panel-sheet-height")).toBe("45dvh");
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
