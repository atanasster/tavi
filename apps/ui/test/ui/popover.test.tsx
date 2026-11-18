// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Popover, keepInside, type PopoverClosedBy } from "../../src/ui/Popover.js";
import { button, click, mount } from "../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The shared popover: a named, non-modal dialog that Escape closes (handled,
 * so the page's own Escape skips it); placed in the page, or — anchored —
 * portaled beside its toggle, closed by a press outside and by Tab past its edge.
 */

const press = async (target: Element | null | undefined, key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => target?.dispatchEvent(event));
  return event;
};

function Opener({ anchored, closed }: { readonly anchored: boolean; readonly closed: (by: PopoverClosedBy) => void }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button type="button" ref={toggle} onClick={() => setOpen((was) => !was)}>
        Toggle
      </button>
      {open ? (
        <Popover
          className="test-popover"
          label="Details"
          initialFocus="button"
          {...(anchored ? { anchor: toggle } : {})}
          onClose={(by) => {
            closed(by);
            setOpen(false);
          }}
        >
          <button type="button">Inside</button>
        </Popover>
      ) : null}
      <button type="button">After</button>
    </div>
  );
}

describe("Popover", () => {
  it("in place: a named dialog in its opener's tree, focused as asked, that Escape closes as handled", async () => {
    const closed = vi.fn();
    const page = await mount(<Opener anchored={false} closed={closed} />);
    await click(button(page, "Toggle"));
    const popover = page.querySelector<HTMLElement>(".test-popover");
    expect(popover?.getAttribute("role")).toBe("dialog");
    expect(popover?.getAttribute("aria-label")).toBe("Details");
    expect(popover?.hasAttribute("style")).toBe(false);
    expect(document.activeElement).toBe(button(page, "Inside"));
    // A press outside leaves a popover in place open.
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(page.querySelector(".test-popover")).not.toBeNull();
    const escape = await press(document.activeElement, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(closed).toHaveBeenCalledWith("escape");
    expect(page.querySelector(".test-popover")).toBeNull();
  });

  it("in place: leaves an Escape pressed elsewhere on the page to the page, and two open ones each their own", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const page = await mount(
      <>
        <Opener anchored={false} closed={first} />
        <Opener anchored={false} closed={second} />
        <input aria-label="Composer" />
      </>,
    );
    const [one, two] = [...page.querySelectorAll<HTMLButtonElement>("button")].filter((each) => each.textContent === "Toggle");
    await click(one);
    await click(two);
    expect(page.querySelectorAll(".test-popover")).toHaveLength(2);
    const outside = await press(page.querySelector("input"), "Escape");
    expect(outside.defaultPrevented).toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    // Pressed inside the second, it closes the second alone.
    await press(page.querySelectorAll(".test-popover")[1]?.querySelector("button"), "Escape");
    expect(second).toHaveBeenCalledWith("escape");
    expect(first).not.toHaveBeenCalled();
    expect(page.querySelectorAll(".test-popover")).toHaveLength(1);
  });

  it("anchored: closes as the page scrolls under it", async () => {
    const closed = vi.fn();
    const page = await mount(<Opener anchored closed={closed} />);
    await click(button(page, "Toggle"));
    await act(async () => document.dispatchEvent(new Event("scroll")));
    expect(closed).toHaveBeenCalledWith("scroll");
  });

  it("does not take an Escape still composing", async () => {
    const closed = vi.fn();
    const page = await mount(<Opener anchored={false} closed={closed} />);
    await click(button(page, "Toggle"));
    await press(document.activeElement, "Escape", { isComposing: true });
    expect(closed).not.toHaveBeenCalled();
  });

  it("anchored: portaled, placed and ready, and closed by a press outside but not on its toggle", async () => {
    const closed = vi.fn();
    const page = await mount(<Opener anchored closed={closed} />);
    await click(button(page, "Toggle"));
    expect(page.querySelector(".test-popover")).toBeNull();
    const popover = document.querySelector<HTMLElement>(".test-popover");
    expect(popover?.parentElement).toBe(document.body);
    expect(popover?.hasAttribute("data-ready")).toBe(true);
    expect(popover?.style.left).toMatch(/px$/);
    expect(document.activeElement).toBe(button(popover!, "Inside"));
    await act(async () => popover?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await act(async () => button(page, "Toggle")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(closed).not.toHaveBeenCalled();
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(closed).toHaveBeenCalledWith("outside");
    expect(document.querySelector(".test-popover")).toBeNull();
  });

  it("anchored: Tab past its last stop closes it and goes on beside its toggle; Shift+Tab past its first goes back to it", async () => {
    const closed = vi.fn();
    const page = await mount(<Opener anchored closed={closed} />);
    await click(button(page, "Toggle"));
    await press(document.activeElement, "Tab");
    expect(closed).toHaveBeenLastCalledWith("tab");
    expect(document.activeElement).toBe(button(page, "After"));
    await click(button(page, "Toggle"));
    await press(document.activeElement, "Tab", { shiftKey: true });
    expect(document.querySelector(".test-popover")).toBeNull();
    expect(document.activeElement).toBe(button(page, "Toggle"));
  });
});

describe("keepInside", () => {
  it("moves an in-place popover back inside the window by the edge it runs off, and leaves one that fits", () => {
    // Opened right-aligned from a chip near the left: it ran 120 px off the left edge.
    expect(keepInside({ left: -120, right: 280 }, 800)).toBe(128);
    expect(keepInside({ left: 600, right: 900 }, 800)).toBe(-108);
    expect(keepInside({ left: 8, right: 792 }, 800)).toBe(0);
    // Wider than the window: its left edge is the one kept.
    expect(keepInside({ left: 4, right: 900 }, 800)).toBe(4);
    expect(keepInside({ left: 0, right: 0 }, 800)).toBe(0);
  });
});
