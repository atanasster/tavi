// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSidebarWidth, saveSidebarWidth, SIDEBAR_WIDTH_KEY, SidebarFrame } from "../../../src/features/shell/SidebarFrame.js";
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "../../../src/lib/layout.js";
import { mount, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("sidebar resize and persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    unmountAll();
    window.localStorage.clear();
  });

  it("loads and saves sidebar width with bounds clamping", () => {
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);

    saveSidebarWidth(320);
    expect(loadSidebarWidth()).toBe(320);

    saveSidebarWidth(50); // Below MIN
    expect(loadSidebarWidth()).toBe(MIN_SIDEBAR_WIDTH);

    saveSidebarWidth(1200); // Above MAX
    expect(loadSidebarWidth()).toBe(MAX_SIDEBAR_WIDTH);

    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "invalid");
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it("renders with persisted width and provides accessible separator", async () => {
    saveSidebarWidth(350);
    const container = await mount(
      <SidebarFrame>
        <p>Content</p>
      </SidebarFrame>,
    );
    const sidebar = container.querySelector(".sidebar") as HTMLElement;
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("350px");

    const resizer = container.querySelector(".sidebar-resizer") as HTMLElement;
    expect(resizer).not.toBeNull();
    expect(resizer.getAttribute("role")).toBe("separator");
    expect(resizer.getAttribute("aria-orientation")).toBe("vertical");
    expect(resizer.getAttribute("aria-valuenow")).toBe("350");
    expect(resizer.getAttribute("aria-valuemin")).toBe(String(MIN_SIDEBAR_WIDTH));
    expect(resizer.getAttribute("aria-valuemax")).toBe(String(MAX_SIDEBAR_WIDTH));
  });

  it("supports keyboard resizing", async () => {
    const container = await mount(
      <SidebarFrame initialWidth={250}>
        <p>Content</p>
      </SidebarFrame>,
    );
    const resizer = container.querySelector(".sidebar-resizer") as HTMLElement;
    const sidebar = container.querySelector(".sidebar") as HTMLElement;

    // ArrowRight: +16px
    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("266px");
    expect(loadSidebarWidth()).toBe(266);

    // ArrowLeft: -16px
    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("250px");
    expect(loadSidebarWidth()).toBe(250);

    // Home: MIN_SIDEBAR_WIDTH
    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe(`${MIN_SIDEBAR_WIDTH}px`);
    expect(loadSidebarWidth()).toBe(MIN_SIDEBAR_WIDTH);

    // End: MAX_SIDEBAR_WIDTH
    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe(`${MAX_SIDEBAR_WIDTH}px`);
    expect(loadSidebarWidth()).toBe(MAX_SIDEBAR_WIDTH);

    // Enter: reset to default
    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe(`${DEFAULT_SIDEBAR_WIDTH}px`);
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it("resets to default width on double click", async () => {
    const container = await mount(
      <SidebarFrame initialWidth={400}>
        <p>Content</p>
      </SidebarFrame>,
    );
    const resizer = container.querySelector(".sidebar-resizer") as HTMLElement;
    const sidebar = container.querySelector(".sidebar") as HTMLElement;

    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe(`${DEFAULT_SIDEBAR_WIDTH}px`);
    expect(loadSidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it("resizes via pointer drag and persists on release", async () => {
    const container = await mount(
      <SidebarFrame initialWidth={250}>
        <p>Content</p>
      </SidebarFrame>,
    );
    const resizer = container.querySelector(".sidebar-resizer") as HTMLElement;
    const sidebar = container.querySelector(".sidebar") as HTMLElement;

    // Start drag at x = 250
    await act(async () => {
      resizer.dispatchEvent(new PointerEvent("pointerdown", { clientX: 250, button: 0, bubbles: true }));
    });
    expect(document.body.classList.contains("sidebar-resizing")).toBe(true);

    // Move by +50px
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300, bubbles: true }));
    });
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("300px");

    // Release pointer
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 300, bubbles: true }));
    });
    expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
    expect(sidebar.style.getPropertyValue("--sidebar-width")).toBe("300px");
    expect(loadSidebarWidth()).toBe(300);
  });
});
