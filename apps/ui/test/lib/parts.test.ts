import { describe, expect, it } from "vitest";

import { nextPart } from "../../src/lib/parts.js";

const first = (text: string, from?: number): string | undefined => {
  const part = nextPart(text, from);
  return part === undefined ? undefined : text.slice(part.start, part.end);
};

describe("nextPart", () => {
  it("finds a template blank, whole, from where it is asked", () => {
    expect(first("Find a [kind of place] near [area].")).toBe("[kind of place]");
    expect(first("Find a [kind of place] near [area].", 8)).toBe("[area]");
    expect(first("[file or link]: what does it say?")).toBe("[file or link]");
    expect(first("Somewhere warm (near [city]).")).toBe("[city]");
    expect(first("[xylophone] lessons, section [1a]")).toBe("[xylophone]");
  });

  it.each([
    ["a Markdown link", "See [the rules](https://example.com/r)."],
    ["an image", "![a chart](chart.png)"],
    ["a reference link", "See [the rules][1]."],
    ["a link's reference", "[rules]: https://example.com/r"],
    ["a bare number", "section [1]"],
    ["a numbered range", "sections [1, 2] and [3-5]"],
    ["an open task box", "- [ ] pack"],
    ["a ticked task box", "- [x] pack"],
    ["a ticked task box in capitals", "- [X] pack"],
    ["a wiki link", "[[wiki]]"],
    ["empty brackets", "items[]"],
    ["a bracketed address", "Read [https://example.com] now."],
    ["a bracketed address with spaces inside", "Read [ https://example.com/a?b=c ] now."],
    ["a bracketed domain", "Read [example.com] now."],
    ["a bracketed mail address", "Write to [ada@example.com]."],
    ["an index in code", "Use arr[0] and arr[i] in code."],
    ["a key in code", "Use foo[bar] in code."],
    ["a key on a call's result", "Use items()[key] in code."],
  ])("skips %s", (_name, text) => {
    expect(nextPart(text)).toBeUndefined();
  });

  it("still finds a blank spaced, in capitals, or of two words with a stop", () => {
    expect(first("Forecast for [ city ].")).toBe("[ city ]");
    expect(first("Fill in [TODO] here.")).toBe("[TODO]");
    expect(first("Fix [e.g. the sink] today.")).toBe("[e.g. the sink]");
    expect(first("(near [city])")).toBe("[city]");
  });

  it("finds nothing in an IPv6 address, or in code", () => {
    expect(first("Ping [fe80::1]:8080 please.")).toBeUndefined();
    expect(first("Ping [2001:db8::1]:8080 please.")).toBeUndefined();
    expect(first("Run `[city]` literally.")).toBeUndefined();
    expect(first("Use this:\n```\n[section]\nname = value\n```")).toBeUndefined();
    expect(first("Run:\n```\nitems = [item for item in rows]\n```")).toBeUndefined();
    expect(first("Run:\n```\nnever closed [section]")).toBeUndefined();
    expect(first("Use:\n~~~\n[section]\n~~~")).toBeUndefined();
    expect(first("Run ``[city]`` literally.")).toBeUndefined();
    expect(first("Run:\n\n    [city]\n")).toBeUndefined();
    expect(first("Use:\n~~~\n[section]\n~~~\nin [city]")).toBe("[city]");
  });

  it("goes past what it skips to the blank after", () => {
    expect(first("- [x] [the rules](https://example.com/r) [1] [[wiki]] then [city]")).toBe("[city]");
    expect(first("Read [example.com] and foo[bar], then [city]")).toBe("[city]");
    expect(first("Run `[flag]`, then go to [city]")).toBe("[city]");
  });
});
