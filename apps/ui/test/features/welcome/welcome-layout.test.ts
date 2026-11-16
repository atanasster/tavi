import { describe, expect, it } from "vitest";

import { canvasCss, stylesheet } from "../../css.js";

/**
 * Welcome holds at 375 px, read from
 * the canvas's stylesheets as text: `.welcome` is one flex column that may shrink, every
 * grid inside it takes its column's minimum through `min(100%, …)`, every
 * field but a checkbox or radio is the column's full width, and no Welcome
 * rule sets a width wider than a 375 px screen leaves inside the page's
 * padding or forbids text from wrapping.
 *
 * What it proves is the rules as written. It does not lay anything out —
 * jsdom has no layout engine — so it cannot see an element that overflows
 * through a class shared with the rest of the canvas (`.actions`, a button's
 * own padding), a long unbroken word, or a rule elsewhere that outranks one
 * of these. A real 375 px viewport in a browser is what shows those.
 */

const css = canvasCss().replace(/\/\*[\s\S]*?\*\//g, "");

/** The token block's lengths, so a rule's `var(--width-prose)` is read as the 44rem it is. */
const tokens = new Map(
  [...(/:root\s*\{([^}]*)\}/.exec(stylesheet("tokens.css"))?.[1] ?? "").matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(
    (match) => [match[1]!, match[2]!.trim()] as const,
  ),
);
const resolve = (value: string): string => value.replace(/var\((--[a-z0-9-]+)\)/g, (whole, name: string) => tokens.get(name) ?? whole);

/** Every rule as its selector list and declarations, a media query's included, nested at most one level as the sheet is. */
function rules(
  sheet: string,
): { readonly selectors: readonly string[]; readonly declarations: ReadonlyMap<string, string>; readonly media?: string }[] {
  const found: { selectors: readonly string[]; declarations: ReadonlyMap<string, string>; media?: string }[] = [];
  const walk = (text: string, media?: string): void => {
    let at = 0;
    while (at < text.length) {
      const open = text.indexOf("{", at);
      if (open < 0) return;
      const prelude = text.slice(at, open).trim();
      let depth = 1;
      let close = open + 1;
      for (; close < text.length && depth > 0; close += 1) {
        if (text[close] === "{") depth += 1;
        else if (text[close] === "}") depth -= 1;
      }
      const body = text.slice(open + 1, close - 1);
      if (prelude.startsWith("@media")) walk(body, prelude);
      else if (!prelude.startsWith("@")) {
        const declarations = new Map(
          body
            .split(";")
            .map((part) => part.split(":"))
            .filter((pair) => pair.length >= 2)
            .map(([property, ...value]) => [property!.trim(), resolve(value.join(":").trim())] as const),
        );
        found.push({
          selectors: prelude.split(",").map((selector) => selector.trim()),
          declarations,
          ...(media === undefined ? {} : { media }),
        });
      }
      at = close;
    }
  };
  walk(sheet);
  return found;
}

const all = rules(css);
const welcome = all.filter((rule) => rule.selectors.some((selector) => /(^|\s)\.welcome([-\s.:[]|$)/.test(selector)));
const one = (selector: string) => {
  const matched = all.filter((rule) => rule.selectors.includes(selector) && rule.media === undefined);
  expect(matched, selector).toHaveLength(1);
  return matched[0]!.declarations;
};
/** The page's width in px for a length in px or rem (1rem = 14px, `--text-md` at the root). */
const px = (length: string): number | undefined => {
  const match = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(length);
  return match === null ? undefined : Number(match[1]) * (match[2] === "rem" ? 14 : 1);
};

describe("Welcome at 375 px", () => {
  it("finds the Welcome rules to check", () => {
    expect(welcome.length).toBeGreaterThan(10);
  });

  it("is a single flex column that may shrink below its content", () => {
    const page = one(".welcome");
    expect(page.get("display")).toBe("flex");
    expect(page.get("flex-direction")).toBe("column");
    expect(page.get("min-width")).toBe("0");
    // Capped, never fixed: on a phone the column is the screen's.
    expect(page.get("width")).toBeUndefined();
    expect(page.get("max-width")).toMatch(/rem$/);
  });

  it("gives every grid's column a minimum of min(100%, …), so one column fits a phone", () => {
    const grids = welcome.filter((rule) => rule.declarations.has("grid-template-columns"));
    expect(grids.map((rule) => rule.selectors.join(", "))).toEqual(expect.arrayContaining([".welcome .provider-grid", ".welcome-cards"]));
    for (const grid of grids)
      expect(grid.declarations.get("grid-template-columns"), grid.selectors.join(", ")).toMatch(
        /^repeat\(auto-fill, minmax\(min\(100%, [\d.]+rem\), 1fr\)\)$/,
      );
    // The provider grid's own 190 px minimum is what `.welcome .provider-grid` overrides.
    expect(one(".provider-grid").get("grid-template-columns")).toContain("190px");
  });

  it("makes every field the column's width, except a checkbox or a radio", () => {
    const fields = welcome.find((rule) => rule.selectors.includes('.welcome input:not([type="checkbox"]):not([type="radio"])'));
    expect(fields?.selectors).toContain(".welcome .select-trigger");
    expect(fields?.declarations.get("width")).toBe("100%");
    expect(fields?.declarations.get("max-width")).toBe("100%");
    expect(fields?.declarations.get("box-sizing")).toBe("border-box");
    // No other Welcome rule widens an input (a checkbox at 100% would be a bar across the page).
    const others = welcome.filter(
      (rule) => rule !== fields && rule.selectors.some((selector) => /\b(input|select)\b/.test(selector)) && rule.declarations.has("width"),
    );
    expect(others).toEqual([]);
  });

  it("sets no width wider than a 375 px screen leaves, and lets text wrap", () => {
    // 375 px less the page's 16 px padding each side.
    const room = 375 - 2 * 16;
    for (const rule of welcome) {
      for (const property of ["width", "min-width", "flex-basis"]) {
        const value = rule.declarations.get(property);
        const length = value === undefined ? undefined : px(value);
        if (length !== undefined) expect(length, `${rule.selectors.join(", ")} ${property}`).toBeLessThanOrEqual(room);
      }
      expect(rule.declarations.get("white-space"), rule.selectors.join(", ")).not.toBe("nowrap");
    }
    // Rows of links and choices wrap rather than run off the side.
    for (const selector of [".welcome-stepper", ".welcome-later", ".welcome-choices"])
      expect(one(selector).get("flex-wrap"), selector).toBe("wrap");
  });
});
