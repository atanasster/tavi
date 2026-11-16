import { describe, expect, it } from "vitest";

import { stylesheet } from "../../css.js";

/**
 * The decisions History holds its columns together on a phone by scrolling sideways (`--width-table-min`), never on a
 * desktop: at 1280×800 with the Center's rail the History card is 649 px wide (measured in Chromium, QA 1908), so a
 * floor above that cut its last column, When, to "Wh…". Read from the stylesheet as text, as jsdom lays nothing out.
 */
const DESKTOP_HISTORY_WIDTH = 649;

describe("the decisions History", () => {
  it("scrolls sideways only below a desktop's History card", () => {
    const floor = /--width-table-min:\s*(\d+)px/.exec(stylesheet("tokens.css"))?.[1];
    expect(Number(floor)).toBeLessThanOrEqual(DESKTOP_HISTORY_WIDTH - 32);
    expect(stylesheet("center.css")).toMatch(/\.center-history\s*\{[^}]*min-width:\s*var\(--width-table-min\)/);
  });
});
