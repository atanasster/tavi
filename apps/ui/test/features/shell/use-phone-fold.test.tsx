// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { usePhoneFold } from "../../../src/features/shell/use-phone-fold.js";
import { isPhone, usePhone } from "../../../src/hooks/page.js";
import { PHONE_MAX_WIDTH } from "../../../src/lib/breakpoints.js";
import { click, mount, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const original = window.matchMedia;
afterEach(() => {
  unmountAll();
  window.matchMedia = original;
});

/** A window of `width`, whose `max-width` queries answer as it is resized, as a real one's do. */
function windowOf(width: number): { readonly resize: (to: number) => Promise<void> } {
  let now = width;
  const listeners = new Set<() => void>();
  window.matchMedia = ((media: string) => ({
    media,
    get matches() {
      return now <= Number(/max-width: (\d+)px/.exec(media)?.[1]);
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  return {
    resize: async (to) => {
      const crossed = now <= PHONE_MAX_WIDTH !== to <= PHONE_MAX_WIDTH;
      now = to;
      if (crossed) await act(async () => [...listeners].forEach((listener) => listener()));
    },
  };
}

/** The sidebar as the shell holds it: open as `App` starts it, with its toggle. */
function Shell() {
  const phone = usePhone();
  const [sidebar, setSidebar] = useState(() => !isPhone());
  usePhoneFold(phone, sidebar, setSidebar);
  return (
    <button type="button" data-open={sidebar} onClick={() => setSidebar((open) => !open)}>
      Toggle
    </button>
  );
}
const open = (page: HTMLElement): boolean => page.querySelector("button")?.dataset["open"] === "true";

describe("a window resized across the phone width", () => {
  it("folds the chats exactly at the breakpoint, stays able to open them, and brings them back on widening", async () => {
    const { resize } = windowOf(1280);
    const page = await mount(<Shell />);
    expect(open(page)).toBe(true);
    await resize(PHONE_MAX_WIDTH + 1);
    expect(open(page)).toBe(true);
    await resize(PHONE_MAX_WIDTH);
    expect(open(page)).toBe(false);
    await click(page.querySelector("button"));
    expect(open(page)).toBe(true);
    await click(page.querySelector("button"));
    await resize(PHONE_MAX_WIDTH + 1);
    expect(open(page)).toBe(true);
  });

  it("leaves chats the reader folded folded, there and back", async () => {
    const { resize } = windowOf(1280);
    const page = await mount(<Shell />);
    await click(page.querySelector("button"));
    await resize(390);
    expect(open(page)).toBe(false);
    await resize(1280);
    expect(open(page)).toBe(false);
  });

  it("keeps chats opened while narrow open once wide", async () => {
    const { resize } = windowOf(1280);
    const page = await mount(<Shell />);
    await click(page.querySelector("button"));
    await resize(390);
    await click(page.querySelector("button"));
    await resize(1280);
    expect(open(page)).toBe(true);
  });

  it("does not open the chats of a session that started narrow, nothing having been folded", async () => {
    const { resize } = windowOf(390);
    const page = await mount(<Shell />);
    expect(open(page)).toBe(false);
    await resize(1280);
    expect(open(page)).toBe(false);
  });
});
