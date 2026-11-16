import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stylesheet } from "../css.js";

/**
 * `public/favicon.svg` is `TaviMark` with its colours written in: the same
 * shapes, painted in the `--mark-*` tokens' colours.
 */
const root = join(import.meta.dirname, "..", "..");
const favicon = readFileSync(join(root, "public", "favicon.svg"), "utf8");
const mark = readFileSync(join(root, "src", "ui", "TaviMark.tsx"), "utf8");

const shapes = (source: string): string[] => [...source.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]!);

/** A token's `H S% L%` triplet as `#rrggbb`. */
function hexOf(token: string): string {
  const value = new RegExp(`--${token}:\\s*([^;]+);`).exec(stylesheet("tokens.css"))?.[1];
  if (value === undefined) throw new Error(`no --${token} in tokens.css`);
  const [h, s, l] = value.split(/\s+/).map((part) => Number.parseFloat(part)) as [number, number, number];
  const chroma = (1 - Math.abs((2 * l) / 100 - 1)) * (s / 100);
  const channel = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

describe("the favicon", () => {
  it("draws the mark's shapes", () => {
    expect(shapes(favicon)).toEqual(shapes(mark));
  });

  it("paints them in the mark's colours", () => {
    const colours = [...favicon.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/g)].map((match) => match[1]);
    expect(colours).toEqual([hexOf("mark"), hexOf("mark-leaf"), hexOf("mark-leaf"), hexOf("mark-sun")]);
  });
});
