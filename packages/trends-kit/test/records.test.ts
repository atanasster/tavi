import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { TrendsSourceRecordSchema } from "../src/index.js";
import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";

import { TR1_RECORDS } from "../src/records.js";

describe("the keyless source records", () => {
  it("are valid shared records, each id once", () => {
    for (const record of TR1_RECORDS) expect(() => TrendsSourceRecordSchema.parse(record), record.id).not.toThrow();
    expect(new Set(TR1_RECORDS.map((record) => record.id)).size).toBe(TR1_RECORDS.length);
  });

  it("are free and keyless, on by default only when documented", () => {
    for (const record of TR1_RECORDS) {
      expect(record.auth, record.id).toBe("none");
      expect(record.trends.cost.usdPerUnit, record.id).toBe(0);
      if (record.defaultOn) expect(record.standing, record.id).toBe("documented");
    }
    // getTrends is unspecced: off until the operator turns it on.
    expect(TR1_RECORDS.find((record) => record.id === "bluesky-trends")).toMatchObject({ standing: "undocumented", defaultOn: false });
  });

  it("keep a source's items no longer than its terms allow: a day where deletions must be honoured", () => {
    for (const record of TR1_RECORDS.filter((each) => each.trends.deletionOnRequest))
      expect(record.terms.cache, record.id).toEqual({ mode: "ttl-hours", hours: 24 });
    expect(
      TR1_RECORDS.filter((record) => record.trends.needsContact)
        .map((record) => record.id)
        .sort(),
    ).toEqual(["wikidata", "wikipedia-pageviews"]);
  });

  it("refuses a record whose terms ban use by a model, and one on by default that is not documented", () => {
    const base = TR1_RECORDS[0];
    expect(() => TrendsSourceRecordSchema.parse({ ...base, terms: { ...base?.terms, llmUse: "banned" } })).toThrow(/leave no record/);
    expect(() => TrendsSourceRecordSchema.parse({ ...base, standing: "unofficial", defaultOn: true })).toThrow(/documented/);
  });
});

describe("the recorded fixtures", () => {
  it("say when each was recorded, and none is over 180 days old", () => {
    const root = domainFixtures("trends");
    const { recordings } = JSON.parse(readFileSync(join(root, "recorded.json"), "utf8")) as {
      recordings: Record<string, { recordedAt: string }>;
    };
    const folders = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(Object.keys(recordings).sort()).toEqual(folders);
    for (const [folder, { recordedAt }] of Object.entries(recordings))
      expect((Date.now() - Date.parse(`${recordedAt}T00:00:00Z`)) / 86_400_000, folder).toBeLessThanOrEqual(180);
  });
});
