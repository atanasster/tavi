import { describe, expect, it } from "vitest";

import { MODEL_PICKER_EDGE_PX, POPOVER_EDGE_PX, POPOVER_FIT_PX, POPOVER_GAP_PX } from "../../src/lib/layout.js";
import { stylesheet } from "../css.js";

/**
 * `lib/layout.ts` keeps the script's layout numbers as constants; the ones that
 * are a spacing token are held here to `styles/tokens.css`, so a theme edit to
 * the token cannot leave the script on the old number.
 */
const tokens = stylesheet("tokens.css");
const tokenPx = (name: string): number => {
  const match = new RegExp(`${name}:\\s*([\\d.]+)px;`).exec(tokens);
  if (match === null) throw new Error(`${name} is not a px token in tokens.css`);
  return Number(match[1]);
};

describe("the script's layout numbers are the theme's tokens", () => {
  it("spaces a popover from its anchor and the window's edges by --space-2", () => {
    expect(POPOVER_GAP_PX).toBe(tokenPx("--space-2"));
    expect(POPOVER_EDGE_PX).toBe(tokenPx("--space-2"));
  });

  it("keeps the model picker --space-3 from the window's edges", () => {
    expect(MODEL_PICKER_EDGE_PX).toBe(tokenPx("--space-3"));
  });

  it("asks a popover for --space-4 beyond its height to fit on a side", () => {
    expect(POPOVER_FIT_PX).toBe(tokenPx("--space-4"));
  });
});
