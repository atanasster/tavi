import { describe, expect, it } from "vitest";

import { browserOutputSensitive } from "../src/browser.js";

/** A browser tool's output from a sensitive page, as hooks are kept from it. */
describe("browserOutputSensitive", () => {
  it("finds the mark on an observation, a read, an outcome's page and a batch's steps", () => {
    expect(browserOutputSensitive({ url: "https://bank.example", elements: [], sensitive: "password-field" })).toBe(true);
    expect(browserOutputSensitive({ status: "accepted", page: { url: "https://pay.example", sensitive: "payment-field" } })).toBe(true);
    expect(browserOutputSensitive({ steps: [{ kind: "type" }, { kind: "click", sensitive: "blocked-host" }] })).toBe(true);
  });

  it("ignores pages without it, a value that is not a reason, and marks deeper than the browser tools put them", () => {
    expect(browserOutputSensitive({ url: "https://news.example", text: "hello" })).toBe(false);
    expect(browserOutputSensitive({ sensitive: true })).toBe(false);
    expect(browserOutputSensitive({ sensitive: "secret-ish" })).toBe(false);
    expect(browserOutputSensitive({ records: [{ sensitive: "password-field" }] })).toBe(false);
    expect(browserOutputSensitive(null)).toBe(false);
  });
});
