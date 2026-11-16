// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import { Composer } from "../../../src/features/chat/Composer.js";
import { mount, rerender } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An idea's *Try it*: Tab walks the `[parts]` still to fill in, and leaves the box when none is ahead. */

const WORDS = "Practise [situation] at [level] level.";
const view = (seed?: { readonly text: string; readonly key: number; readonly placeholder?: boolean }) => (
  <Composer disabled={false} placeholder="Message" onSubmit={() => undefined} onRetry={() => undefined} seed={seed} />
);
async function seeded(seed: { readonly text: string; readonly key: number; readonly placeholder?: boolean }): Promise<HTMLTextAreaElement> {
  const page = await mount(view());
  await rerender(view(seed));
  await act(async () => new Promise((done) => requestAnimationFrame(() => done(undefined))));
  const box = page.querySelector("textarea");
  if (box === null) throw new Error("no box");
  return box;
}
/** Tab in the box: whether the page kept it, rather than the browser moving focus on. */
async function tab(box: HTMLTextAreaElement, init: KeyboardEventInit = {}): Promise<boolean> {
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...init });
  await act(async () => box.dispatchEvent(event));
  return event.defaultPrevented;
}
const selected = (box: HTMLTextAreaElement) => box.value.slice(box.selectionStart, box.selectionEnd);

describe("Tab through an idea's parts", () => {
  it("goes to each next [part], and leaves the box when none is ahead", async () => {
    const box = await seeded({ text: WORDS, key: 1, placeholder: true });
    expect(selected(box)).toBe("[situation]");
    expect(await tab(box)).toBe(true);
    expect(selected(box)).toBe("[level]");
    // None ahead: the browser takes it, so a keyboard user is never held here.
    expect(await tab(box)).toBe(false);
  });

  it("walks the same blanks Make it recurring warns of: links, task boxes, numbers and wiki links are not stops", async () => {
    const box = await seeded({
      text: "- [x] read [the rules](https://example.com/r), section [1], [[wiki]], for [exam] on [date]",
      key: 1,
      placeholder: true,
    });
    expect(selected(box)).toBe("[exam]");
    expect(await tab(box)).toBe(true);
    expect(selected(box)).toBe("[date]");
    expect(await tab(box)).toBe(false);
  });

  it("leaves Shift+Tab alone", async () => {
    const box = await seeded({ text: WORDS, key: 1, placeholder: true });
    expect(await tab(box, { shiftKey: true })).toBe(false);
    expect(selected(box)).toBe("[situation]");
  });

  it("is only for an idea's words: brackets in a rewound message are not blanks", async () => {
    const box = await seeded({ text: WORDS, key: 1 });
    box.setSelectionRange(0, 0);
    expect(await tab(box)).toBe(false);
  });
});
