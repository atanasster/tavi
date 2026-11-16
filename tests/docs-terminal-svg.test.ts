import { expect, it } from "vitest";

import { screenOf } from "../scripts/docs/terminal-svg.mjs";

/**
 * The documentation's terminal pictures play what a command wrote into a grid
 * (`scripts/docs/terminal-svg.mjs`): the cursor moves the terminal UI uses
 * must land where a terminal puts them, or a picture shows a screen the
 * program never drew.
 */

const text = (transcript: string, cols = 20, rows = 8) =>
  screenOf(transcript, cols, rows).map((cells) =>
    cells
      .map((cell) => cell.ch)
      .join("")
      .trimEnd(),
  );

it("moves to the start of a later or earlier line with CNL and CPL", () => {
  // Up to the first line, down two (CNL), then up one (CPL): each lands at column 0.
  expect(text("one\r\ntwo\r\nthree\x1b[3A\x1b[2Ex\x1b[1Fy")).toEqual(["one", "ywo", "xhree"]);
  // A count of 0 is 1.
  expect(text("one\r\ntwo\x1b[0Fx\x1b[0Ey")).toEqual(["xne", "ywo"]);
});

it("keeps a line the live region was drawn under, as a terminal does", () => {
  // tavi chat's frame: the question stays, the live rows below it are redrawn in place.
  const frame = "❯ question\r\n● starting\r\n❯ █\r\n\x1b[2A\x1b[1G● running\x1b[K\r\n\x1b[E\x1b[2A\x1b[1Ganswer\x1b[K\r\n";
  expect(text(frame)).toEqual(["❯ question", "answer", "❯ █"]);
});
