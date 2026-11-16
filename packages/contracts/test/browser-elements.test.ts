import { describe, expect, it } from "vitest";

import {
  BROWSER_ELEMENT_TEXT_MAX_CHARS,
  BROWSER_OBSERVATION_MAX_CHARS,
  BROWSER_OBSERVATION_MAX_ELEMENTS,
  MAX_TOOL_RESULT_BYTES,
  compactBrowserElements,
  stripTrackingParams,
  type BrowserScannedElement,
} from "../src/index.js";

describe("an observation's element list (compactBrowserElements)", () => {
  it("drops an element that says nothing, and collapses and clips text", () => {
    const long = `${"word ".repeat(60)}end`;
    const { elements, omitted } = compactBrowserElements([
      { ref: "el-0" },
      { ref: "el-1", role: "button", text: "  Sign \n\n in  " },
      { ref: "el-2", text: long, href: "https://example.com/a" },
    ]);
    expect(elements[0]).toEqual({ ref: "el-1", role: "button", text: "Sign in" });
    expect(elements[1]?.text).toHaveLength(BROWSER_ELEMENT_TEXT_MAX_CHARS);
    expect(elements[1]?.text?.endsWith("…")).toBe(true);
    expect(elements).toHaveLength(2);
    expect(omitted).toBe(0);
  });

  it("never folds a control that submits a form into a same-named one that does not", () => {
    const { elements, omitted } = compactBrowserElements([
      { ref: "el-0", role: "button", text: "Apply" },
      { ref: "el-1", role: "button", text: "Apply", submitsForm: true },
      { ref: "el-2", role: "button", text: "Apply" },
    ]);
    expect(elements.map((element) => element.ref)).toEqual(["el-0", "el-1"]);
    expect(omitted).toBe(1);
  });

  it("keeps repeated controls whose contexts differ, clips context to 60 chars, and counts folded repeats in omitted", () => {
    const { elements, omitted } = compactBrowserElements([
      { ref: "el-0", role: "button", text: "Select", context: "Fare 1 · Morning · $120" },
      { ref: "el-1", role: "button", text: "Select", context: "Fare 2 · Midday · $210" },
      { ref: "el-2", role: "button", text: "Select", context: `Fare 3 · Evening · $300 · ${"x".repeat(60)}` },
      { ref: "el-3", role: "button", text: "Select", context: "Fare 1 · Morning · $120" },
    ]);
    expect(elements.map((element) => element.ref)).toEqual(["el-0", "el-1", "el-2"]);
    expect(elements[2]?.context?.length).toBeLessThanOrEqual(60);
    expect(omitted).toBe(1);
  });

  it("keeps a field's value, clipped, and its state", () => {
    const { elements } = compactBrowserElements([
      { ref: "el-0", role: "combobox", text: "Where from?", value: "  Sofia \n (SOF) ", state: "expanded" },
      { ref: "el-1", role: "checkbox", text: "Direct only", value: "", state: "" },
      { ref: "el-2", role: "textbox", text: "Notes", value: "x".repeat(300) },
    ]);
    expect(elements[0]).toEqual({ ref: "el-0", role: "combobox", text: "Where from?", value: "Sofia (SOF)", state: "expanded" });
    expect(elements[1]).toEqual({ ref: "el-1", role: "checkbox", text: "Direct only" });
    expect(elements[2]?.value).toHaveLength(BROWSER_ELEMENT_TEXT_MAX_CHARS);
  });

  it("never splits a surrogate pair when it clips", () => {
    // The cut would fall between the first emoji's two halves.
    const text = `${"a".repeat(BROWSER_ELEMENT_TEXT_MAX_CHARS - 2)}😀😀😀`;
    const [element] = compactBrowserElements([{ ref: "el-0", role: "heading", text }]).elements;
    expect(element?.text).toBe(`${"a".repeat(BROWSER_ELEMENT_TEXT_MAX_CHARS - 2)}…`);
  });

  it("keeps one element per href — the first with text — and one of each repeated role and text", () => {
    const { elements } = compactBrowserElements([
      { ref: "el-0", href: "https://news.example/story" },
      { ref: "el-1", text: "Muse tops 5 million downloads", href: "https://news.example/story" },
      { ref: "el-2", text: "Muse tops 5 million downloads", href: "https://news.example/story" },
      { ref: "el-3", role: "button", text: "Rewards" },
      { ref: "el-4", role: "button", text: "Rewards" },
      { ref: "el-5", role: "tab", text: "Rewards" },
      { ref: "el-6", href: "https://news.example/logo" },
    ]);
    expect(elements.map((element) => element.ref)).toEqual(["el-1", "el-3", "el-5", "el-6"]);
  });

  it("never merges unlabelled fields: each is its own place to type", () => {
    const { elements } = compactBrowserElements([
      { ref: "el-0", role: "textbox" },
      { ref: "el-1", role: "textbox" },
    ]);
    expect(elements).toHaveLength(2);
  });

  it("fills its bounds with the page's content first, the chrome's controls next, its links last, and lists them in page order", () => {
    const chromeLinks: BrowserScannedElement[] = Array.from({ length: BROWSER_OBSERVATION_MAX_ELEMENTS }, (_, index) => ({
      ref: `el-${index}`,
      text: `Section ${index}`,
      href: `https://news.example/section/${index}`,
      chrome: true,
    }));
    const search: BrowserScannedElement = { ref: "el-500", role: "searchbox", text: "Search", chrome: true };
    const story: BrowserScannedElement = { ref: "el-501", text: "The story", href: "https://news.example/story" };
    const { elements, omitted } = compactBrowserElements([...chromeLinks, search, story]);
    expect(elements).toHaveLength(BROWSER_OBSERVATION_MAX_ELEMENTS);
    expect(elements.slice(-2)).toEqual([
      { ref: "el-500", role: "searchbox", text: "Search" },
      { ref: "el-501", text: "The story", href: "https://news.example/story" },
    ]);
    expect(elements[0]).toEqual({ ref: "el-0", text: "Section 0", href: "https://news.example/section/0" });
    expect(omitted).toBe(2);
  });

  it("stays inside its character budget, far inside what a tool result carries inline", () => {
    const heavy: BrowserScannedElement[] = Array.from({ length: BROWSER_OBSERVATION_MAX_ELEMENTS }, (_, index) => ({
      ref: `el-${index}`,
      text: "漢".repeat(BROWSER_ELEMENT_TEXT_MAX_CHARS),
      href: `https://news.example/${"x".repeat(1_900)}/${index}`,
    }));
    const { elements, omitted } = compactBrowserElements(heavy);
    const json = JSON.stringify(elements);
    expect(json.length).toBeLessThanOrEqual(BROWSER_OBSERVATION_MAX_CHARS);
    expect(new TextEncoder().encode(json).byteLength).toBeLessThan(MAX_TOOL_RESULT_BYTES / 2);
    expect(elements.length + omitted).toBe(BROWSER_OBSERVATION_MAX_ELEMENTS);
    expect(elements.length).toBeGreaterThan(0);
  });
});

describe("an href without its tracking parameters (stripTrackingParams)", () => {
  it("drops utm_* tags and ad click ids, keeping the other parameters and the fragment as written", () => {
    expect(stripTrackingParams("https://news.example/a?id=7&utm_source=bing&UTM_Medium=x&q=a%20b+c&fbclid=IwAR#top")).toBe(
      "https://news.example/a?id=7&q=a%20b+c#top",
    );
    expect(stripTrackingParams("https://news.example/a?utm_source=x&gclid=y")).toBe("https://news.example/a");
    expect(stripTrackingParams("https://news.example/a?utm_source=x#c")).toBe("https://news.example/a#c");
  });

  it("drops a site's own tracking parameters only on that site", () => {
    expect(stripTrackingParams("https://www.msn.com/en-us/news/x/ar-AA1?ocid=BingNewsSerp&cvid=abc")).toBe(
      "https://www.msn.com/en-us/news/x/ar-AA1",
    );
    expect(stripTrackingParams("https://www.bing.com/news/search?q=Meta+Muse&FORM=HDRSC6")).toBe(
      "https://www.bing.com/news/search?q=Meta+Muse",
    );
    expect(stripTrackingParams("https://user@news.msn.com:443/a?ocid=x&id=1")).toBe("https://user@news.msn.com:443/a?id=1");
    const oracle = "https://cloud.oracle.com/compute/instances/x?ocid=ocid1.instance.oc1&region=eu";
    expect(stripTrackingParams(oracle)).toBe(oracle);
    const lookalike = "https://notmsn.com/a?ocid=x";
    expect(stripTrackingParams(lookalike)).toBe(lookalike);
  });

  it("returns an href with nothing to strip, or that does not parse, unchanged", () => {
    for (const href of [
      "https://news.example/a",
      "https://news.example/a?q=1&page=2",
      "https://news.example/a?%E0%A4%A=1",
      "https://news.example/a#x?utm_source=1",
      "not a url?utm_source=x",
    ]) {
      expect(stripTrackingParams(href)).toBe(href);
    }
  });

  it("is applied before links are made unique, so a link tagged twice is listed once", () => {
    const { elements } = compactBrowserElements([
      { ref: "el-0", text: "Muse tops 5 million", href: "https://news.example/story?utm_source=top" },
      { ref: "el-1", text: "Muse tops 5 million", href: "https://news.example/story?utm_source=sidebar" },
    ]);
    expect(elements).toEqual([{ ref: "el-0", text: "Muse tops 5 million", href: "https://news.example/story" }]);
  });
});
