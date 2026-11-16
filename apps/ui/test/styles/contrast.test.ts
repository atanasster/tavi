import { describe, expect, it } from "vitest";

import { canvasCss, stylesheet } from "../css.js";

/**
 * The contrast the canvas's colours keep, worked out from `styles/tokens.css`
 * in both schemes (jsdom computes no colours, so axe's colour-contrast rule
 * cannot run on the rendered page). Text needs 4.5:1; a control's edge, a
 * focus indicator or a state shown only by colour needs 3:1 (WCAG 1.4.3, 1.4.11).
 */

type Rgb = readonly [number, number, number];

function schemes(): { readonly light: ReadonlyMap<string, string>; readonly dark: ReadonlyMap<string, string> } {
  const css = stylesheet("tokens.css");
  const declarations = (block: string): Map<string, string> =>
    new Map([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));
  const light = /^:root\s*\{([^}]*)\}/m.exec(css)?.[1];
  const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1];
  if (light === undefined || dark === undefined) throw new Error("no light or dark :root block in tokens.css");
  const lightTokens = declarations(light);
  return { light: lightTokens, dark: new Map([...lightTokens, ...declarations(dark)]) };
}

function rgbOf(hsl: string): Rgb {
  const [h, s, l] = hsl.split(/\s+/).map((part) => Number.parseFloat(part)) as [number, number, number];
  const sat = s / 100;
  const light = l / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return light - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

const luminance = ([r, g, b]: Rgb): number => {
  const channel = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const ratio = (a: Rgb, b: Rgb): number => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
};

/** `top` at `alpha` over `under`. */
const over = (top: Rgb, alpha: number, under: Rgb): Rgb =>
  [0, 1, 2].map((i) => top[i]! * alpha + under[i]! * (1 - alpha)) as unknown as Rgb;

const TEXT = 4.5;
const EDGE = 3;

/** [foreground, background, least ratio]; a background `name@N` is that token at N% over the card. */
const PAIRS: readonly (readonly [string, string, number])[] = [
  ["foreground", "background", TEXT],
  ["foreground", "card", TEXT],
  ...["background", "card", "muted", "secondary", "popover"].map((bg) => ["muted-foreground", bg, TEXT] as const),
  ["primary", "background", TEXT],
  ["primary", "card", TEXT],
  ["primary-foreground", "primary", TEXT],
  ...["card", "muted", "secondary"].map((bg) => ["destructive", bg, TEXT] as const),
  ["destructive-foreground", "destructive", TEXT],
  // The sun is a fill: the ink on it. It marks nothing by colour alone, so it has no edge pair.
  ["sun-foreground", "sun", TEXT],
  ...["positive", "warning", "info"].map((fg) => [fg, "card", TEXT] as const),
  // A tone's text on its own tint (badges, notices).
  ...["destructive", "positive", "warning", "info", "primary"].map((tone) => [tone, `${tone}@10`, TEXT] as const),
  // Code in an answer, on the code block's secondary.
  ...["keyword", "string", "number", "comment", "title"].map((token) => [`code-${token}`, "secondary", TEXT] as const),
  // Field and button edges, the focus ring, the select's ringed option, the off switch's track.
  ["input", "background", EDGE],
  ["input", "card", EDGE],
  ["border", "card", EDGE],
  ["ring", "background", EDGE],
  ["ring", "card", EDGE],
  ["ring", "accent", EDGE],
  // The current chat's bar and a selected segment's edge.
  ["primary", "card", EDGE],
  ["input", "secondary", EDGE],
];

describe("the canvas's colours keep their contrast", () => {
  const { light, dark } = schemes();
  for (const [scheme, tokens] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`in ${scheme} mode`, () => {
      const colour = (name: string): Rgb => {
        const [token, alpha] = name.split("@") as [string, string | undefined];
        const value = tokens.get(`--${token}`);
        if (value === undefined) throw new Error(`no --${token} in tokens.css`);
        return alpha === undefined ? rgbOf(value) : over(rgbOf(value), Number(alpha) / 100, colour("card"));
      };
      const short = PAIRS.map(([fg, bg, least]) => ({
        pair: `${fg} on ${bg}`,
        ratio: Math.round(ratio(colour(fg), colour(bg)) * 100) / 100,
        least,
      })).filter(({ ratio: got, least }) => got < least);
      expect(short).toEqual([]);
    });
  }

  it("draws state with these tokens: the off switch's track, the current chat's bar, a selected segment's edge", () => {
    const css = canvasCss();
    expect(css).toMatch(/\.switch\s*\{[^}]*background:\s*hsl\(var\(--border\)\)/);
    expect(css).toMatch(/\.session-item\.current\s*\{[^}]*box-shadow:\s*var\(--shadow-inset-stripe\)/);
    expect(css).toMatch(/--shadow-inset-stripe:\s*inset[^;]*hsl\(var\(--primary\)\)/);
    expect(css).toMatch(/\.segment\.active\s*\{[^}]*border:\s*var\(--border-width\) solid hsl\(var\(--input\)\)/);
  });
});
