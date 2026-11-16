import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DomainSourceRecordSchema, checkDomainSourceRecord } from "../src/domain-sources.js";

/** The shared source record: a domain extends it, then holds its fields together. */
const DomainRecord = DomainSourceRecordSchema.extend({ kind: z.enum(["ats", "aggregator"]) }).superRefine(checkDomainSourceRecord);

const base = {
  id: "greenhouse",
  name: "Greenhouse",
  countries: ["*"],
  hosts: ["boards-api.greenhouse.io"],
  auth: "none",
  kind: "ats",
  terms: {
    url: "https://developers.greenhouse.io/job-board.html",
    reviewedAt: "2026-10-16",
    licence: "public job board API",
    llmUse: "silent",
    cache: { mode: "ttl", days: 60 },
    attribution: "",
    displayRules: [],
    userTriggeredOnly: false,
  },
  budget: { perSecond: 1, perDay: 2_000 },
};

describe("a domain source record", () => {
  it("defaults to http, documented and on", () => {
    expect(DomainRecord.parse(base)).toMatchObject({ transport: "http", standing: "documented", defaultOn: true });
  });

  it("takes an hours cache and an mcp transport", () => {
    expect(
      DomainRecord.parse({ ...base, transport: "mcp", terms: { ...base.terms, cache: { mode: "ttl-hours", hours: 4 } } }).terms.cache,
    ).toEqual({ mode: "ttl-hours", hours: 4 });
    expect(DomainRecord.safeParse({ ...base, terms: { ...base.terms, cache: { mode: "ttl-hours", hours: 0 } } }).success).toBe(false);
  });

  it.each([
    ["terms that ban use by a model", { terms: { ...base.terms, llmUse: "banned" } }, "leave no record"],
    ["an undocumented source on by default", { standing: "undocumented" }, "only a documented source"],
    ["a keyed source naming no key", { auth: "key-header" }, "names the config keys"],
  ])("refuses %s", (_name, overrides, message) => {
    const result = DomainRecord.safeParse({ ...base, ...overrides });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(" ")).toContain(message);
  });

  it("allows an undocumented source that is off by default", () => {
    expect(DomainRecord.safeParse({ ...base, standing: "undocumented", defaultOn: false }).success).toBe(true);
  });
});
