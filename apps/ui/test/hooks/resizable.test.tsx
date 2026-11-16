// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PanelBounds, loadWidth, useResizablePanel } from "../../src/hooks/resizable.js";
import { mount, unmountAll } from "../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RIGHT: PanelBounds = { side: "right", key: "test.width", min: 280, max: 640, initial: 340, reserve: 480, snapCollapse: 200 };

function Panel({ onCollapse }: { readonly onCollapse?: () => void }) {
  const { width, separator } = useResizablePanel(RIGHT, { onCollapse });
  return (
    <div className="panel" data-width={width}>
      <div className="handle" role="separator" tabIndex={0} {...separator} />
    </div>
  );
}

describe("a right-hand resizable column", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    unmountAll();
    window.localStorage.clear();
  });

  /** `ui` mounted: its column and the column's handle. */
  async function mountPanel(ui: React.ReactNode) {
    const host = await mount(ui);
    return { panel: host.querySelector(".panel") as HTMLElement, handle: host.querySelector(".handle") as HTMLElement };
  }

  const drag = async (handle: HTMLElement, from: number, to: number) => {
    await act(async () => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { clientX: from, button: 0, bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: to, bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: to, bubbles: true }));
    });
  };

  it("grows as the pointer moves left and saves on release", async () => {
    const { panel, handle } = await mountPanel(<Panel />);
    await drag(handle, 700, 640);
    expect(panel.dataset["width"]).toBe("400");
    expect(loadWidth(RIGHT)).toBe(400);
  });

  it("keeps the arrow keys with the handle: left widens, right narrows", async () => {
    const { panel, handle } = await mountPanel(<Panel />);
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(panel.dataset["width"]).toBe("356");
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(panel.dataset["width"]).toBe("324");
  });

  it("closes instead of resizing when released below the snap width, and keeps the saved width", async () => {
    const onCollapse = vi.fn();
    const { panel, handle } = await mountPanel(<Panel onCollapse={onCollapse} />);
    await drag(handle, 700, 900);
    expect(onCollapse).toHaveBeenCalledOnce();
    expect(panel.dataset["width"]).toBe("340");
    expect(window.localStorage.getItem(RIGHT.key)).toBeNull();
  });

  it("never narrows below the minimum while dragging without a collapse", async () => {
    const { panel, handle } = await mountPanel(<Panel />);
    await drag(handle, 700, 900);
    expect(panel.dataset["width"]).toBe("280");
  });

  it("clamps to the minimum, not collapsing, when released between the snap width and the minimum", async () => {
    const onCollapse = vi.fn();
    const { panel, handle } = await mountPanel(<Panel onCollapse={onCollapse} />);
    await drag(handle, 700, 800);
    expect(onCollapse).not.toHaveBeenCalled();
    expect(panel.dataset["width"]).toBe("280");
    expect(loadWidth(RIGHT)).toBe(280);
  });

  it("puts the width back, without saving or collapsing, when the browser cancels the drag", async () => {
    const onCollapse = vi.fn();
    const { panel, handle } = await mountPanel(<Panel onCollapse={onCollapse} />);
    await act(async () => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { clientX: 700, button: 0, bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 640, bubbles: true }));
    });
    expect(panel.dataset["width"]).toBe("400");
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointercancel", { clientX: 0, bubbles: true }));
    });
    expect(panel.dataset["width"]).toBe("340");
    expect(onCollapse).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(RIGHT.key)).toBeNull();
    expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
  });
});
