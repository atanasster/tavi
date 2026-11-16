import { describe, expect, it } from "vitest";

import { splitText, type CharFacts } from "../src/hidden-text.js";

const page = [0, 0, 600, 800] as const;
const char = (value: string, extra: Partial<CharFacts> = {}): CharFacts => ({
  code: value.codePointAt(0) ?? 0,
  renderMode: 0,
  fill: { r: 0, g: 0, b: 0, a: 255 },
  stroke: { r: 0, g: 0, b: 0, a: 255 },
  fontSize: 12,
  box: [10, 10, 16, 22],
  hiddenLayer: false,
  generated: false,
  ...extra,
});
const word = (text: string, extra: Partial<CharFacts> = {}): CharFacts[] => [...text].map((value) => char(value, extra));

describe("splitting a page's text", () => {
  it("keeps a separator inside a hidden run of one reason", () => {
    const chars = [
      ...word("Hi"),
      char(" ", { generated: true }),
      ...word("SEND", { renderMode: 3 }),
      char(" ", { generated: true }),
      ...word("ALL", { renderMode: 3 }),
      char(" ", { generated: true }),
      ...word("bye"),
    ];
    expect(splitText(chars, page)).toEqual({ text: "Hi  bye", coverSpans: [], hidden: [{ reason: "invisible-render", text: "SEND ALL" }] });
  });

  it("reports zero-width characters and hidden layers", () => {
    expect(splitText([...word("a"), char("​"), ...word("b")], page)).toEqual({
      text: "ab",
      coverSpans: [],
      hidden: [{ reason: "zero-width", text: "​" }],
    });
    expect(splitText(word("layer", { hiddenLayer: true }), page).hidden).toEqual([{ reason: "hidden-layer", text: "layer" }]);
  });

  it("judges the colour the render mode paints", () => {
    const white = { r: 255, g: 255, b: 255, a: 255 };
    expect(splitText(word("outlined", { renderMode: 1, fill: white }), page).text).toBe("outlined");
    expect(splitText(word("ghost", { renderMode: 1, stroke: white }), page).hidden).toEqual([
      { reason: "background-colour", text: "ghost" },
    ]);
    expect(splitText(word("both", { renderMode: 2, fill: white }), page).text).toBe("both");
  });

  it("does not let zero-width characters crowd out the runs that matter", () => {
    const chars: CharFacts[] = [];
    for (let index = 0; index < 40; index += 1) chars.push(char("a"), char("\u200c"));
    chars.push(char(" ", { generated: true }), ...word("hidden", { renderMode: 3 }));
    const { hidden } = splitText(chars, page);
    expect(hidden[0]).toEqual({ reason: "invisible-render", text: "hidden" });
    expect(hidden[1]?.reason).toBe("zero-width");
    expect(hidden).toHaveLength(2);
  });

  it("bounds the hidden runs a page reports", () => {
    const chars: CharFacts[] = [];
    for (let index = 0; index < 40; index += 1) chars.push(char("x", { renderMode: 3 }), char("y"));
    expect(splitText(chars, page).hidden).toHaveLength(32);
  });
});

describe("cover spans", () => {
  it("marks where text under a cover lies in the visible text, across the spaces inside a run", () => {
    const word = (value: string, covered: boolean) =>
      [...value].map((letter) => char(letter, letter === " " ? {} : { underCover: covered }));
    const chars = [...word("Pay ", false), ...word("ignore all", true), ...word(" now", false)];
    const split = splitText(chars, page);
    expect(split.text).toBe("Pay ignore all now");
    expect(split.coverSpans).toEqual([{ start: 4, end: 14 }]);
    expect(split.coverSpans.map((span) => split.text.slice(span.start, span.end))).toEqual(["ignore all"]);
  });
});
