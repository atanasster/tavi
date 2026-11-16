// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { IconButton } from "../../src/ui/IconButton.js";
import { mount } from "../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** The Pin button mounted, with `props`. */
const pin = (props: { disabled?: boolean; tooltip?: string; onClick?: () => void } = {}) =>
  mount(<IconButton icon="pin" label="Pin" {...props} />);
const escape = () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });

it("shows a custom tooltip on focus, reads no name twice, and lets an Escape go on", async () => {
  const host = await pin();
  const button = host.querySelector("button")!;
  expect(button.hasAttribute("title")).toBe(false);
  expect(button.getAttribute("aria-label")).toBe("Pin");
  await act(async () => button.focus());
  const tip = document.querySelector('[role="tooltip"]')!;
  expect(tip.textContent).toBe("Pin");
  // The tooltip says what the name says: describing the button with it would read "Pin" twice.
  expect(button.hasAttribute("aria-describedby")).toBe(false);
  expect(host.contains(tip)).toBe(false);
  const key = escape();
  await act(async () => button.dispatchEvent(key));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(document.activeElement).toBe(button);
  // It came with focus: the page's own Escape (stopping a turn) still hears the key.
  expect(key.defaultPrevented).toBe(false);
});

it("doesn't stay over what's next after a click leaves it focused", async () => {
  const host = await pin();
  const trigger = host.querySelector<HTMLElement>(".tooltip-trigger")!;
  const button = host.querySelector("button")!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    button.focus();
  });
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});

it("describes its control when it says more than the name", async () => {
  const host = await pin({ tooltip: "Pin to the top of the list" });
  const button = host.querySelector("button")!;
  await act(async () => button.focus());
  expect(button.getAttribute("aria-describedby")).toBe(document.querySelector('[role="tooltip"]')?.id);
});

it("takes an Escape for itself when it was opened by hovering", async () => {
  const host = await pin();
  const trigger = host.querySelector<HTMLElement>(".tooltip-trigger")!;
  await act(async () => trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  const key = escape();
  await act(async () => document.body.dispatchEvent(key));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(key.defaultPrevented).toBe(true);
});

it("leaves Escape to a dialog it is in, so the dialog still closes", async () => {
  const host = await mount(
    <dialog open>
      <IconButton icon="pin" label="Pin" />
    </dialog>,
  );
  const trigger = host.querySelector<HTMLElement>(".tooltip-trigger")!;
  await act(async () => trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  const key = escape();
  await act(async () => trigger.dispatchEvent(key));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  expect(key.defaultPrevented).toBe(false);
});

it("keeps a disabled icon button focusable and named, its presses doing nothing", async () => {
  const onClick = vi.fn();
  const host = await pin({ disabled: true, onClick });
  const button = host.querySelector("button")!;
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  // No nameless tab stop around it.
  expect(host.querySelector("[tabindex]")).toBeNull();
  const trigger = host.querySelector<HTMLElement>(".tooltip-trigger")!;
  await act(async () => trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Pin");
  await act(async () => button.focus());
  expect(document.activeElement).toBe(button);
  await act(async () => button.click());
  expect(onClick).not.toHaveBeenCalled();
  await act(async () => button.blur());
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
