// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { adoptStyleNonce } from "../../src/lib/csp-nonce.js";
import { Select } from "../../src/ui/Select.js";
import { mountSettled as mount, unmountAll } from "../support/dom.js";

afterEach(() => {
  unmountAll();
  document.head.innerHTML = "";
  Reflect.deleteProperty(globalThis, "__webpack_nonce__");
});

describe("adoptStyleNonce", () => {
  it("hands the page's nonce to what injects a style, and nothing when the page names none", () => {
    expect(adoptStyleNonce()).toBeUndefined();
    expect(Reflect.get(globalThis, "__webpack_nonce__")).toBeUndefined();
    document.head.innerHTML = '<meta name="csp-nonce" content="abc123==">';
    expect(adoptStyleNonce()).toBe("abc123==");
    // get-nonce (react-style-singleton's, for the select's scroll lock) falls back to this global.
    expect(Reflect.get(globalThis, "__webpack_nonce__")).toBe("abc123==");
  });

  it("gives the style a select's scroll lock injects the page's nonce", async () => {
    document.head.innerHTML = '<meta name="csp-nonce" content="lock==">';
    // jsdom draws nothing: the list's scroll to its selected option has nowhere to go.
    Element.prototype.scrollIntoView ??= () => undefined;
    adoptStyleNonce();
    const page = await mount(
      <Select value="a" onChange={() => undefined} aria-label="Pick">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    const trigger = page.querySelector<HTMLElement>("[role='combobox']");
    await act(async () => {
      trigger?.focus();
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const injected = [...document.querySelectorAll("style")].filter((style) =>
      style.textContent?.includes("--removed-body-scroll-bar-size"),
    );
    expect(injected.length).toBeGreaterThan(0);
    expect(injected.every((style) => style.getAttribute("nonce") === "lock==")).toBe(true);
    // Every style the open list adds, its viewport's own (which hides the scroll bar) among them.
    const viewport = [...document.querySelectorAll("style")].filter((style) => style.textContent?.includes("data-radix-select-viewport"));
    expect(viewport.length).toBeGreaterThan(0);
    expect([...document.querySelectorAll("style")].map((style) => style.getAttribute("nonce"))).toEqual(
      [...document.querySelectorAll("style")].map(() => "lock=="),
    );
  });
});
