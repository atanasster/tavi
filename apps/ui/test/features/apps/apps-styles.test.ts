import { describe, expect, it } from "vitest";

import { stylesheet } from "../../css.js";

/**
 * An MCP server's review fits its dialog at 1280 (QA 1868: a link in a description and the selects' minimum widths
 * made the table 737 px wide in a 710 px dialog). Read from the stylesheet as text: jsdom lays nothing out, so this
 * proves the rules as written; measured in Chrome, the same review then fits (710 of 710).
 */
const uncommented = (name: string): string => stylesheet(name).replace(/\/\*[\s\S]*?\*\//g, "");
/** The declarations of the rule whose selector list includes `selector`. */
const ruleIn = (name: string, selector: string): string =>
  [...uncommented(name).matchAll(/([^{}]+)\{([^}]*)\}/g)].find((match) =>
    match[1]!.split(",").some((each) => each.trim() === selector),
  )?.[2] ?? "";
const rule = (selector: string): string => ruleIn("apps.css", selector);

describe("the tool review's table", () => {
  it("takes the dialog's width, wraps a long tool id or link, and lets its selects shrink", () => {
    expect(rule(".mcp-tools")).toMatch(/width:\s*100%/);
    expect(rule(".mcp-tools td:first-child")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".mcp-tools .select-trigger")).toMatch(/min-width:\s*0/);
  });
});

describe("the Connected / Discover switch", () => {
  it("draws the segment the page is on as chosen, as the top nav's active one", () => {
    expect(ruleIn("controls.css", '.segment[aria-current="page"]')).toBe(ruleIn("controls.css", ".segment.active"));
    expect(ruleIn("controls.css", ".segment.active")).toMatch(/background:\s*hsl\(var\(--card\)\)/);
  });
});
