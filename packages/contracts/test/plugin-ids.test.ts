import { describe, expect, it } from "vitest";

import { comparePluginVersions, isTaintReason } from "../src/index.js";

describe("comparePluginVersions", () => {
  it("orders versions by semantic-version precedence", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.2.0",
      "2.0.0",
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(comparePluginVersions(ordered[index - 1]!, ordered[index]!)).toBeLessThan(0);
      expect(comparePluginVersions(ordered[index]!, ordered[index - 1]!)).toBeGreaterThan(0);
    }
    expect(comparePluginVersions("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
    expect(comparePluginVersions("10.0.0", "9.0.0")).toBeGreaterThan(0);
  });
});

describe("isTaintReason", () => {
  it("recognises only the taint reason the gate adds", () => {
    expect(isTaintReason("the conversation contains untrusted content from the web or a document")).toBe(true);
    expect(isTaintReason("this plugin asks for approval before its tools run")).toBe(false);
  });
});
