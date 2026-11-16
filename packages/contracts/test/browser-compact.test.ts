import { describe, expect, it } from "vitest";

import { COMPACT_ELEMENT_FORMAT, compactElementLine, compactObservationForModel, type BrowserObservation } from "../src/browser.js";

/** A browser observation as a model reads it: a line per element, the structured list kept wherever else it is read. */
describe("compact browser observations", () => {
  const page = "https://shop.example/results?q=tent";

  it("writes an element as one line, a same-origin link relative", () => {
    expect(
      compactElementLine({ ref: "el-4", role: "link", text: "Next", context: "Results", href: "https://shop.example/p/2" }, page),
    ).toBe('el-4 link "Next" ["Results"] → /p/2');
    expect(compactElementLine({ ref: "el-5", role: "link", text: "Help", href: "https://other.example/help" }, page)).toBe(
      'el-5 link "Help" → https://other.example/help',
    );
    expect(
      compactElementLine({ ref: "el-6", role: "textbox", text: "Card", value: "", state: "disabled", secret: true, inForm: true }, page),
    ).toBe('el-6 textbox "Card" = "" (disabled) {in-form, secret}');
  });

  it("compacts an observation, or an action's page, and leaves other results alone", () => {
    const observation: BrowserObservation = {
      sessionId: "s1",
      epoch: 3,
      url: page,
      elements: [{ ref: "el-1", role: "button", text: "Search", submitsForm: true }],
    };
    expect(compactObservationForModel(observation)).toEqual({
      ...observation,
      elementsFormat: COMPACT_ELEMENT_FORMAT,
      elements: ['el-1 button "Search" {submits}'],
    });
    expect(compactObservationForModel({ status: "accepted", page: observation })).toMatchObject({
      page: { elements: ['el-1 button "Search" {submits}'] },
    });
    const other = { records: [{ ref: "x" }] };
    expect(compactObservationForModel(other)).toBe(other);
  });

  it("takes a third less room than the structured list on a busy page", () => {
    const elements = Array.from({ length: 40 }, (_, index) => ({
      ref: `el-${index}`,
      role: index % 2 === 0 ? "link" : "button",
      text: `Result ${index}`,
      context: "Search results",
      href: `https://shop.example/item/${index}`,
    }));
    const observation = { sessionId: "s1", epoch: 1, url: page, href: page, elements };
    const before = JSON.stringify(observation).length;
    const after = JSON.stringify(compactObservationForModel(observation)).length;
    expect(after).toBeLessThan(before * 0.7);
  });
});
