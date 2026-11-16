import { describe, expect, it } from "vitest";

import { cuesWithin, MAX_SUBTITLE_CUES, parseSubRip, plainCueText } from "../src/subtitles.js";

/** A subtitle track's text: SubRip parsed, its markup gone, a malformed block skipped. */
describe("SubRip cues", () => {
  it("parses blocks, CRLF and dots as well, and drops markup", () => {
    const cues = parseSubRip(
      "1\r\n00:00:01,000 --> 00:00:02,500\r\n<font color=red>Hi</font>\r\n\r\n2\n01:00:00.250 --> 01:00:01.000\nline one\nline two\n",
    );
    expect(cues).toEqual([
      { startSec: 1, endSec: 2.5, text: "Hi" },
      { startSec: 3600.25, endSec: 3601, text: "line one line two" },
    ]);
    expect(plainCueText("{\\an8}<b>Top</b>\\Nnext")).toBe("Top next");
  });

  it("skips a block with no timing, a reversed one, or no words", () => {
    expect(
      parseSubRip("1\nno timing here\n\n2\n00:00:05,000 --> 00:00:04,000\nbackwards\n\n3\n00:00:06,000 --> 00:00:07,000\n<i></i>\n"),
    ).toEqual([]);
  });

  it("holds a hostile track to its caps: so many cues, so long a cue, markup that never closes, in little time", () => {
    const many = Array.from(
      { length: MAX_SUBTITLE_CUES + 50 },
      (_, index) => `${String(index + 1)}\n00:00:01,000 --> 00:00:02,000\nline ${String(index)}`,
    ).join("\n\n");
    expect(parseSubRip(many)).toHaveLength(MAX_SUBTITLE_CUES);
    expect(plainCueText("word ".repeat(1_000)).length).toBeLessThanOrEqual(1_000);
    const started = performance.now();
    const hostile = parseSubRip(`1\n00:00:01,000 --> 00:00:02,000\n${"{\\".repeat(200_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
    expect(hostile.length).toBeLessThanOrEqual(1);
  });

  it("keeps the cues shown during a range", () => {
    const cues = [
      { startSec: 0, endSec: 1, text: "a" },
      { startSec: 2, endSec: 3, text: "b" },
      { startSec: 5, endSec: 6, text: "c" },
    ];
    expect(cuesWithin(cues, 0.5, 2.5).map((cue) => cue.text)).toEqual(["a", "b"]);
  });
});
