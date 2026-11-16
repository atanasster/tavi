import { describe, expect, it } from "vitest";

import { PRINT_FONT, PRINT_PALETTE, PRINT_TYPE_SCALE, printThemeCss } from "../src/print-theme.js";

describe("the print theme", () => {
  it("declares every colour, the face and the type scale in the unit asked for, light only", () => {
    const css = printThemeCss("pt");
    expect(css.startsWith(":root{color-scheme:light;")).toBe(true);
    expect(css).not.toContain("prefers-color-scheme");
    for (const value of Object.values(PRINT_PALETTE)) expect(css).toContain(`:${value};`);
    expect(css).toContain("--print-ink-soft:#4a5260;");
    expect(css).toContain("--print-note-fill:#fff8e6;");
    expect(css).toContain(`--print-font:${PRINT_FONT};`);
    for (const [step, size] of Object.entries(PRINT_TYPE_SCALE)) expect(css).toContain(`--print-text-${step}:${size}pt;`);
    expect(printThemeCss("px")).toContain("--print-text-base:11px;");
  });

  it("keeps every colour a hex value and every custom property a single declaration", () => {
    expect(Object.values(PRINT_PALETTE).every((value) => /^#[0-9a-f]{6}$/.test(value))).toBe(true);
    const names = [...printThemeCss("px").matchAll(/(--[a-z0-9-]+):/g)].map((match) => match[1]);
    expect(new Set(names).size).toBe(names.length);
  });
});
