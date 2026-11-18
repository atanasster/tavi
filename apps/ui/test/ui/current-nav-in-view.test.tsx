// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";

import { useCurrentNavInView } from "../../src/ui/useCurrentNavInView.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});

/** jsdom lays nothing out: each box is given the widths and place a phone's strip would have. */
function sized(element: HTMLElement, scrollWidth: number, clientWidth: number, left: number, right: number): void {
  Object.defineProperty(element, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(element, "clientWidth", { configurable: true, get: () => clientWidth });
  element.getBoundingClientRect = () => ({
    left,
    right,
    top: 0,
    bottom: 40,
    width: right - left,
    height: 40,
    x: left,
    y: 0,
    toJSON: () => ({}),
  });
}

function Nav() {
  useCurrentNavInView("heartbeat");
  return null;
}

it("scrolls the strip that scrolls, not the list of tabs inside it, which is as wide as its tabs", async () => {
  host = document.createElement("div");
  host.innerHTML = `<nav class="center-nav"><div class="sidebar-body" style="overflow-x: auto"><ul class="center-nav-list"><li><button>Activity</button></li><li><button aria-current="page">Heartbeat</button></li></ul></div></nav>`;
  document.body.append(host);
  const strip = host.querySelector<HTMLElement>(".sidebar-body")!;
  const list = host.querySelector<HTMLElement>("ul")!;
  const tab = host.querySelector<HTMLElement>('[aria-current="page"]')!;
  sized(strip, 794, 375, 0, 375);
  sized(list, 782, 351, 12, 363);
  sized(tab.parentElement!, 117, 117, 420, 537);
  sized(tab, 117, 117, 420, 537);
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Nav />));
  expect(list.scrollLeft).toBe(0);
  expect(strip.scrollLeft).toBe(537 - 375);
});

it("brings the current tab back when the tabs widen after the page opens, as when their counts arrive", async () => {
  const watched: (() => void)[] = [];
  const Real = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      watched.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  try {
    host = document.createElement("div");
    host.innerHTML = `<nav class="center-nav"><div class="sidebar-body" style="overflow-x: auto"><ul><li><button aria-current="page">Heartbeat</button></li></ul></div></nav>`;
    document.body.append(host);
    const strip = host.querySelector<HTMLElement>(".sidebar-body")!;
    const tab = host.querySelector<HTMLElement>('[aria-current="page"]')!;
    sized(strip, 794, 375, 0, 375);
    sized(tab, 117, 117, 200, 317);
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Nav />));
    expect(strip.scrollLeft).toBe(0);
    // The counts arrive: the tabs before it widen and push it past the strip's edge.
    sized(tab, 117, 117, 300, 417);
    for (const callback of watched) callback();
    expect(strip.scrollLeft).toBe(417 - 375);
  } finally {
    globalThis.ResizeObserver = Real;
  }
});
