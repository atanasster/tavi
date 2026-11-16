// @vitest-environment jsdom
import { labelSummary } from "@tavi/contracts";
import { act, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { TaintChipView } from "../../../src/features/chat/TaintChip.js";
import { useKeyboard } from "../../../src/features/shell/keys.js";
import { useDismiss } from "../../../src/hooks/use-dismiss.js";
import { IconButton } from "../../../src/ui/IconButton.js";
import { mount } from "../../support/dom.js";

/**
 * Escape closes the innermost thing the person opened, and only that: a
 * popover's Escape never also stops the running turn behind it (the page's
 * own bare-Esc chord), while a tooltip that merely came with focus does not
 * keep the key from the page.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A real key press: it bubbles to the window, and can be marked handled. */
const escapeOn = async (target: Element | null | undefined): Promise<void> => {
  await act(async () => target?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
};

function Page({ stop, children }: { readonly stop: () => void; readonly children: React.ReactNode }) {
  useKeyboard({ stop });
  return <>{children}</>;
}

function Popover() {
  const [open, setOpen] = useState(true);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), { inside: [panel, toggle] });
  return (
    <>
      <button type="button" ref={toggle}>
        More
      </button>
      {open ? (
        <div ref={panel} className="popover">
          <button type="button">Pin</button>
        </div>
      ) : null}
    </>
  );
}

describe("Escape in a layer", () => {
  it("closes the taint chip's details and leaves the running turn alone", async () => {
    const stop = vi.fn();
    const onClose = vi.fn();
    const label = labelSummary({ integrity: "untrusted", sources: ["web"], principals: [], confidentiality: "public", refs: [] });
    const page = await mount(
      <Page stop={stop}>
        <TaintChipView label={label} open onToggle={() => undefined} onClose={onClose} />
      </Page>,
    );
    await escapeOn(page.querySelector(".taint-chip"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("closes a dismissable popover and leaves the running turn alone; the next Escape stops it", async () => {
    const stop = vi.fn();
    const page = await mount(
      <Page stop={stop}>
        <Popover />
      </Page>,
    );
    await escapeOn(page.querySelector(".popover button"));
    expect(page.querySelector(".popover")).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    await escapeOn(page.querySelector("button"));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("lets an Escape past a tooltip that came with focus, so a panel around it still closes", async () => {
    const closed = vi.fn();
    const page = await mount(
      <section
        onKeyDown={(event) => {
          if (event.key === "Escape") closed();
        }}
      >
        <IconButton icon="close" label="Close" />
      </section>,
    );
    const button = page.querySelector("button");
    await act(async () => button?.focus());
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await escapeOn(button);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
