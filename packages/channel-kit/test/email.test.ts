import { describe, expect, it } from "vitest";

import { domainOf, domainsAligned, referencesHeader, replySubject } from "../src/index.js";

describe("email helpers", () => {
  it("prefixes a reply's subject once and names a blank one", () => {
    expect(replySubject("Plans")).toBe("Re: Plans");
    expect(replySubject(" re: Plans ")).toBe("re: Plans");
    expect(replySubject("  ")).toBe("Re: your message");
    expect(replySubject(undefined)).toBe("Re: your message");
    expect(replySubject("x".repeat(2000))).toHaveLength(998);
  });

  it("reads a domain and aligns it relaxedly", () => {
    expect(domainOf("Ana@Mail.Example.COM.")).toBe("mail.example.com");
    expect(domainsAligned("mail.example.com", "example.com")).toBe(true);
    expect(domainsAligned("example.com", "example.com")).toBe(true);
    expect(domainsAligned("example.org", "example.com")).toBe(false);
  });

  it("keeps a long thread's first and last ids, dropping the oldest of those between", () => {
    const ids = Array.from({ length: 40 }, (_, index) => `<m${index}-${"x".repeat(30)}@example.com>`);
    const references = referencesHeader(ids);
    expect(`References: ${references}`.length).toBeLessThanOrEqual(998);
    expect(references.startsWith(ids[0] ?? "")).toBe(true);
    expect(references.endsWith(ids[39] ?? "")).toBe(true);
    expect(references).not.toContain("<m1-");
    expect(references).toContain("<m38-");
  });

  it("leaves a short chain alone and cuts a single overlong id", () => {
    expect(referencesHeader(["<a@x>", "<b@x>"])).toBe("<a@x> <b@x>");
    expect(referencesHeader([])).toBe("");
    expect(`References: ${referencesHeader([`<${"y".repeat(1200)}@x>`])}`).toHaveLength(998);
  });

  it("fits a sender's very long References list in one pass", () => {
    const ids = Array.from({ length: 200_000 }, (_, index) => `<m${index}@x>`);
    const started = performance.now();
    const references = referencesHeader(ids);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(references.startsWith("<m0@x> ")).toBe(true);
    expect(references.endsWith("<m199999@x>")).toBe(true);
  });
});
