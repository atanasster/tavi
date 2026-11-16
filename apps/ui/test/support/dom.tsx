import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";

/**
 * The DOM harness the canvas's view tests share: a view mounted in its own
 * container on the page, taken down after each test; a click, a settle, a
 * button found by its text, a render anew. A file that imports it gets
 * the clean-up with it.
 */

const mounted: { readonly root: Root; readonly host: HTMLElement }[] = [];

/** Take down every view `mount` put on the page. */
export function unmountAll(): void {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
}

afterEach(unmountAll);

/** `node` rendered into a fresh container on the page; the container. */
export async function mount(node: ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  return host;
}

/** What has been asked of the page so far answered: a macrotask, so every promise queued before it has run. */
export const settle = async (): Promise<void> => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

/**
 * What has been asked of the page so far answered without a timer, for a test whose clock is faked
 * (where `settle`'s timer never fires): `rounds` acts, each letting the microtask queue turn `turns` times.
 */
export async function flush(rounds = 4, turns = 2): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await act(async () => {
      for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
    });
}

/** `node` mounted, and its first loads answered — by `until`, `settle` unless said. */
export async function mountSettled(node: ReactNode, until: () => Promise<void> = settle): Promise<HTMLElement> {
  const host = await mount(node);
  await until();
  return host;
}

/** A click on `element`, which must be there. */
export async function click(element: Element | null | undefined): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error("nothing to click");
  await act(async () => element.click());
}

/** A click on `element`, and what it asked answered — by `until`, `settle` unless said. */
export async function clickSettled(element: Element | null | undefined, until: () => Promise<void> = settle): Promise<void> {
  await click(element);
  await until();
}

/**
 * `settle`, `mountSettled`, `clickSettled` and `rerender` answering by `until` instead: for a file
 * whose tests fake the clock, `settledBy(() => flush(6))`. This `rerender`, unlike the exported one,
 * waits by `until` after rendering.
 */
export function settledBy(until: () => Promise<void>): {
  readonly settle: () => Promise<void>;
  readonly mount: (node: ReactNode) => Promise<HTMLElement>;
  readonly click: (element: Element | null | undefined) => Promise<void>;
  readonly rerender: (node: ReactNode) => Promise<void>;
} {
  return {
    settle: until,
    mount: (node) => mountSettled(node, until),
    click: (element) => clickSettled(element, until),
    rerender: async (node) => {
      await rerender(node);
      await until();
    },
  };
}

/** The button in `container` whose text is exactly `text`. */
export const button = (container: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text);

/** `node` rendered anew into the view last mounted, so its state survives: a prop changed, as its parent would. */
export async function rerender(node: ReactNode): Promise<void> {
  const last = mounted.at(-1);
  if (last === undefined) throw new Error("nothing mounted to render again");
  await act(async () => last.root.render(node));
}
