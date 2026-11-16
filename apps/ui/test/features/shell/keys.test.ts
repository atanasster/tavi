import { describe, expect, it } from "vitest";

import { isBareKeyOutsideText, KEY_MAP, matches, type KeyBinding } from "../../../src/features/shell/keys.js";

/**
 * The keyboard map: layered around the chords a
 * browser page does not own, so the page promises only what it can keep.
 */

describe("the keyboard map", () => {
  const find = (action: KeyBinding["action"]): KeyBinding => {
    const binding = KEY_MAP.find((entry) => entry.action === action);
    if (binding === undefined) throw new Error(`no binding for ${action}`);
    return binding;
  };
  const press = (over: Partial<Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">>) => ({
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  it("binds only what a page can keep, and offers the browser's own keys instead", () => {
    // Every chord the browser owns is tier `sheet`: never bound, only offered.
    for (const action of ["newTask", "settings", "models"] as const) {
      expect(find(action).tier, action).toBe("sheet");
      expect(find(action).match, action).toBeUndefined();
    }
    // The chords that are bound each say how to match them.
    for (const binding of KEY_MAP)
      expect(binding.tier === "sheet" ? binding.match === undefined : binding.match !== undefined, binding.action).toBe(true);
    // Every action appears once.
    expect(new Set(KEY_MAP.map((binding) => binding.action)).size).toBe(KEY_MAP.length);
  });

  it("never makes Enter alone an approval", () => {
    const approve = find("approve");
    expect(approve.match?.meta).toBe(true);
    expect(approve.match?.alt).toBe(true);
    expect(matches(press({ key: "Enter" }), approve)).toBe(false);
    expect(matches(press({ key: "Enter", metaKey: true }), approve)).toBe(false);
    expect(matches(press({ key: "Enter", metaKey: true, altKey: true }), approve)).toBe(true);
    // Ctrl stands in for Cmd where there is no Cmd key.
    expect(matches(press({ key: "Enter", ctrlKey: true, altKey: true }), approve)).toBe(true);
  });

  it("refuses a chord carrying a modifier it did not ask for", () => {
    expect(matches(press({ key: "Escape" }), find("stop"))).toBe(true);
    expect(matches(press({ key: "Escape", metaKey: true }), find("stop"))).toBe(false);
    expect(matches(press({ key: "s", metaKey: true, shiftKey: true }), find("sidebar"))).toBe(true);
    expect(matches(press({ key: "S", metaKey: true, shiftKey: true }), find("sidebar"))).toBe(true);
    expect(matches(press({ key: "s", metaKey: true }), find("sidebar"))).toBe(false);
  });

  it("matches the chat panel's chords by the physical key, whatever the layout types", () => {
    const panel = find("panel");
    // Shift+. types ">" on a US layout; the key it is pressed on is what counts.
    expect(matches({ ...press({ key: ">", metaKey: true, shiftKey: true }), code: "Period" }, panel)).toBe(true);
    expect(matches({ ...press({ key: ">", metaKey: true }), code: "Period" }, panel)).toBe(false);
    // Alt+1 types "¡" on a Mac.
    expect(matches({ ...press({ key: "¡", metaKey: true, altKey: true }), code: "Digit1" }, find("panel-activity"))).toBe(true);
    // AltGr reaches the page as Ctrl+Alt on Windows and Linux; AltGr+2 types "@".
    const altGr = {
      ...press({ key: "@", ctrlKey: true, altKey: true }),
      code: "Digit2",
      getModifierState: (key: string) => key === "AltGraph",
    };
    expect(matches(altGr, find("panel-schedule"))).toBe(false);
    // An event without a code (a synthetic one) falls back to the character.
    expect(matches(press({ key: ".", metaKey: true, shiftKey: true }), panel)).toBe(true);
  });
});

describe("a single-key shortcut's guard", () => {
  /** A target `closest` finds a text field around, or not. */
  const target = (inText: boolean, seen: string[] = []) =>
    ({ closest: (selector: string) => (seen.push(selector), inText ? {} : null) }) as unknown as EventTarget;
  const plain = { metaKey: false, ctrlKey: false, altKey: false };

  it("takes a bare key outside a text field, and asks about every field that takes text", () => {
    const seen: string[] = [];
    expect(isBareKeyOutsideText({ ...plain, target: target(false, seen) })).toBe(true);
    // An input with no type takes text too (the case the question card's own check missed).
    expect(seen).toEqual(["textarea, input[type=text], input:not([type])"]);
    expect(isBareKeyOutsideText({ ...plain, target: null })).toBe(true);
  });

  it("leaves a key typed into a text field, or held with a modifier, alone", () => {
    expect(isBareKeyOutsideText({ ...plain, target: target(true) })).toBe(false);
    for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const)
      expect(isBareKeyOutsideText({ ...plain, [modifier]: true, target: target(false) })).toBe(false);
  });
});
