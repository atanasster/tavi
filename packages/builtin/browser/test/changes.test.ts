import { describe, expect, it } from "vitest";

import { MAX_CHANGE_LINES, describeChanges, pageStateOf, type PageState } from "../src/changes.js";

const state = (overrides: Partial<PageState> = {}): PageState => ({
  url: "https://flights.example/",
  title: "Flights",
  focus: "",
  fields: {},
  overlays: [],
  ...overrides,
});

describe("describeChanges", () => {
  it("says what a form action changed: values, lists that opened and closed, focus", () => {
    const before = state({ fields: { "Where from?": "Sofia", Departure: "Tue, Nov 24" }, overlays: ['dialog "Dates"'] });
    const after = state({
      fields: { "Where from?": "Sofia", Departure: "" },
      overlays: ["listbox (5 options)"],
      focus: "combobox Where to?",
    });
    expect(describeChanges(before, after)).toEqual([
      'Departure: "Tue, Nov 24" → empty',
      "appeared: listbox (5 options)",
      'closed: dialog "Dates"',
      "focus is on combobox Where to?",
    ]);
  });

  it("says a new page by its URL alone, and nothing for an action that changed nothing", () => {
    expect(describeChanges(state(), state({ url: "https://flights.example/results", fields: { x: "1" } }))).toEqual([
      "the page is now https://flights.example/results",
    ]);
    expect(describeChanges(state({ fields: { a: "1" } }), state({ fields: { a: "1" } }))).toEqual([]);
    expect(describeChanges(state(), state({ title: "Results" }))).toEqual(['the title is now "Results"']);
  });

  it("names a changed field without its values on a page a person held", () => {
    const before = state({ fields: { User: "typed by a person" } });
    const after = state({ fields: { User: "typed by a person!" } });
    expect(describeChanges(before, after, true)).toEqual(["User changed"]);
  });

  it("keeps a long summary short", () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index}`, "a"]));
    const changed = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index}`, "b"]));
    const lines = describeChanges(state({ fields: many }), state({ fields: changed }));
    expect(lines).toHaveLength(MAX_CHANGE_LINES);
    expect(lines.at(-1)).toBe("and 11 more changes");
  });

  it("reads back only a well-formed sample", () => {
    expect(pageStateOf({ url: "u", title: "t", focus: "", fields: { a: "1", b: 2 }, overlays: ["x", 3] })).toEqual({
      url: "u",
      title: "t",
      focus: "",
      fields: { a: "1" },
      overlays: ["x"],
    });
    expect(pageStateOf(null)).toBeUndefined();
    expect(pageStateOf({ url: "u" })).toBeUndefined();
  });
});
