import { describe, expect, it } from "vitest";

import { stylesheet } from "../../css.js";

/**
 * The page under the person's hands takes the height the bar leaves (QA 1810): on a phone the page is laid out at the
 * surface's size, so a surface only as tall as its picture would lay it out as a strip. Read from the stylesheet as
 * text, as jsdom lays nothing out; measured in Chromium at 390×844, the surface is then the window's height below the
 * bar.
 */
const rule = (selector: string): string =>
  [
    ...stylesheet("takeover.css")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]+)\{([^}]*)\}/g),
  ].find((match) => match[1]!.split(",").some((each) => each.trim() === selector))?.[2] ?? "";

describe("the takeover's layout", () => {
  it("stacks its parts and gives the page all the height they leave, whichever of them show", () => {
    expect(rule(".takeover")).toMatch(/display:\s*flex/);
    expect(rule(".takeover")).toMatch(/flex-direction:\s*column/);
    expect(rule(".takeover-page")).toMatch(/flex:\s*1 1 0/);
    expect(rule(".takeover-page")).toMatch(/min-height:\s*0/);
  });
});
