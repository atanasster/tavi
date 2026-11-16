import { describe, expect, it } from "vitest";

import { entryBoxes } from "../src/boxes.js";
import type { Box, TextRun } from "../src/labels.js";

/** Entry boxes on a flat form (`pdf.overlay`). */

const run = (text: string, x: number, y: number): TextRun => ({ text, box: [x, y, x + text.length * 5, y + 10] });

describe("entry boxes", () => {
  it("finds an underline's line and an empty rectangle, each named by the text beside it", () => {
    const paths: Box[] = [
      [120, 699.5, 320, 700.5], // an underline after "Name:"
      [120, 640, 320, 660], // a rectangle after "Date of birth"
    ];
    const boxes = entryBoxes(1, paths, [run("Name:", 60, 702), run("Date of birth", 50, 645)]);
    expect(boxes).toEqual([
      { id: "p1.b1", page: 1, rect: [120, 700.5, 320, 714.5], label: "Name" },
      { id: "p1.b2", page: 1, rect: [122, 642, 318, 658], label: "Date of birth" },
    ]);
  });

  it("leaves out a short rule, a rule with text on it, a rectangle with text in it, and a rectangle's own edge", () => {
    const paths: Box[] = [
      [100, 600, 120, 600.5], // too short
      [100, 560, 300, 560.5], // text already written on it
      [100, 500, 300, 520], // a filled-in box
      [100, 440, 300, 460], // an empty box…
      [100, 439.5, 300, 440.5], // …and its bottom edge drawn as a separate path
    ];
    const boxes = entryBoxes(2, paths, [run("Already written", 110, 562), run("Filled value", 110, 505)]);
    expect(boxes.map((box) => box.rect)).toEqual([[102, 442, 298, 458]]);
    expect(boxes[0]?.id).toBe("p2.b1");
  });

  it("numbers boxes top to bottom, left to right, so the same page always gives the same ids", () => {
    const paths: Box[] = [
      [300, 700, 400, 700.5],
      [100, 700, 200, 700.5],
      [100, 650, 200, 650.5],
    ];
    expect(entryBoxes(1, paths, []).map((box) => [box.id, box.rect[0], box.rect[1]])).toEqual([
      ["p1.b1", 100, 700.5],
      ["p1.b2", 300, 700.5],
      ["p1.b3", 100, 650.5],
    ]);
  });

  it("leaves out a box something is already written over: an annotation, as a viewer or an earlier overlay leaves", () => {
    const paths: Box[] = [
      [120, 699.5, 320, 700.5],
      [120, 640, 320, 660],
    ];
    expect(entryBoxes(1, paths, [], [[121, 701, 319, 714]]).map((box) => box.rect)).toEqual([[122, 642, 318, 658]]);
  });
});
