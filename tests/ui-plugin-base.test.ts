import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PLUGIN_UI_THEME_TOKENS } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { PLUGIN_BASE_PATHS, pluginBase, schemes } from "../scripts/plugin-base.mjs";

/**
 * `plugin-base.css`: the theme tokens a UI plugin gets, with the canvas's own
 * values in both schemes, for a page shown before the host's arrive or
 * outside the host. The canvas's `styles/tokens.css` is the source of truth:
 * `scripts/plugin-base.mjs` writes both copies from it, and this regenerates
 * them, so a hand edit to either fails.
 */

const repo = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(repo, path), "utf8");
const base = read("packages/builtin/browser-view/ui/plugin-base.css");
const canvas = read("apps/ui/src/styles/tokens.css");

describe("plugin-base.css", () => {
  const ours = schemes(base);
  const theirs = schemes(canvas);

  it("defines every token the host passes, and nothing else", () => {
    expect([...ours.light.keys()].sort()).toEqual([...PLUGIN_UI_THEME_TOKENS].sort());
    expect([...ours.dark.keys()].every((token) => ours.light.has(token))).toBe(true);
  });

  it("is generated from tokens.css, in the built-in view and in the example plugin", () => {
    const generated = pluginBase(canvas, PLUGIN_UI_THEME_TOKENS);
    expect(PLUGIN_BASE_PATHS.tokens).toBe(join(repo, "apps/ui/src/styles/tokens.css"));
    expect(PLUGIN_BASE_PATHS.copies).toEqual([
      join(repo, "packages/builtin/browser-view/ui/plugin-base.css"),
      join(repo, "examples/ui-plugins/minimal-browser-view/plugin-base.css"),
    ]);
    for (const copy of PLUGIN_BASE_PATHS.copies) expect(readFileSync(copy, "utf8"), copy).toBe(generated);
  });

  it("has the canvas's values in light and in dark", () => {
    for (const token of PLUGIN_UI_THEME_TOKENS) {
      expect(ours.light.get(token), `${token} (light)`).toBe(theirs.light.get(token));
      expect(ours.dark.get(token) ?? ours.light.get(token), `${token} (dark)`).toBe(theirs.dark.get(token) ?? theirs.light.get(token));
    }
  });

  it("refuses a token the canvas lacks, or one that reads a variable the plugin is not given", () => {
    expect(() => pluginBase(canvas, [...PLUGIN_UI_THEME_TOKENS, "--no-such-token"])).toThrow(/--no-such-token is not in tokens.css/);
    expect(() => pluginBase(canvas, ["--line"])).toThrow(/--line reads --border/);
  });

  it("gives every colour a dark value", () => {
    const colours = PLUGIN_UI_THEME_TOKENS.filter((token) => /^\d+ \d+% \d+%$/.test(ours.light.get(token) ?? ""));
    expect(colours.length).toBeGreaterThan(10);
    expect(colours.filter((token) => !ours.dark.has(token))).toEqual([]);
  });

  it("is linked before both plugins' own styles", () => {
    for (const page of ["packages/builtin/browser-view/ui/live.html", "examples/ui-plugins/minimal-browser-view/live.html"]) {
      expect(
        [...read(page).matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) => match[1]),
        page,
      ).toEqual(["plugin-base.css", "live.css"]);
    }
  });

  it("leaves the plugins' own styles no palette of their own", () => {
    for (const sheet of ["packages/builtin/browser-view/ui/live.css", "examples/ui-plugins/minimal-browser-view/live.css"]) {
      const css = read(sheet);
      expect(css, sheet).not.toMatch(/--[a-z0-9-]+\s*:/);
      expect(css, sheet).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(/i);
      expect(css, sheet).not.toMatch(/:\s*Canvas(Text)?\b/);
    }
  });
});

describe("the browser view's tab icon", () => {
  // Drawn as an <img>, it cannot read the host's variables: it carries the canvas's
  // muted foreground, light and dark, and follows the reader's colour scheme itself.
  it("strokes in the canvas's muted foreground, in each scheme", () => {
    const icon = readFileSync(join(repo, "packages/builtin/browser-view/ui/icon.svg"), "utf8");
    const { light, dark } = schemes(readFileSync(join(repo, "apps/ui/src/styles/tokens.css"), "utf8"));
    const strokes = [...icon.matchAll(/stroke:hsl\(([^)]+)\)/g)].map((match) => match[1]);
    expect(strokes).toEqual([light.get("--muted-foreground"), dark.get("--muted-foreground")]);
    // Its colour is the style's, not an attribute's (the pages' check below refuses a literal one).
    expect(icon).not.toMatch(/\bstroke="/);
  });
});

describe("the UI plugins' pages", () => {
  it("set no colour of their own outside the theme: no hex, rgb or named colour in their markup or icons", () => {
    const pages = ["packages/builtin/browser-view/ui", "examples/ui-plugins/minimal-browser-view"].flatMap((directory) =>
      readdirSync(join(repo, directory))
        .filter((name) => /\.(html|svg)$/.test(name))
        .map((name) => `${directory}/${name}`),
    );
    expect(pages.length).toBeGreaterThan(2);
    const literal =
      /(?:^|[^&\w])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|(?:fill|stroke|color|background(?:-color)?|border(?:-color)?)\s*[:=]\s*"?(?:black|white|red|green|blue|gray|grey|silver|orange|yellow|purple|pink)\b/i;
    const offenders = pages.filter((page) => {
      // A character reference (`&#8212;`) and a fragment link (`href="#add"`) are not colours; the
      // tab icon, an <img> that cannot read the host's variables, carries the palette's hsl() values.
      const text = readFileSync(join(repo, page), "utf8")
        .replace(/&#x?[0-9a-f]+;/gi, "")
        .replace(/href="#[^"]*"/g, "");
      return literal.test(page.endsWith("icon.svg") ? text.replace(/hsl\([^)]*\)/g, "") : text);
    });
    expect(offenders).toEqual([]);
  });
});
