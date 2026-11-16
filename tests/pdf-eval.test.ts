import { existsSync } from "node:fs";
import { join } from "node:path";

import type { PdfRunResult } from "@tavi/plugin-pdf/host";
import { describe, expect, it } from "vitest";

import { FIXTURES, LEO_MEDICAL_YAML, buildFixture } from "../evals/pdf/build-fixtures.js";
import { check, decodePng, framesRotated, matches, readManifest, runEval, type FixtureExpectation } from "../evals/pdf/eval.js";

/**
 * The PDF eval's pure parts, the manifest against the builder, and a run of
 * the fixtures that matter most for safety through the built child.
 * The full suite is `node
 * evals/pdf/eval.ts`.
 */
const childBuilt = existsSync(join(import.meta.dirname, "..", "packages", "builtin", "pdf", "dist", "child.mjs"));

describe("the PDF eval", () => {
  it("has an expectation for every fixture the builder makes, and no other", () => {
    const known = new Set([
      "group",
      "facts",
      "refused",
      "contained",
      "contains",
      "absent",
      "hidden",
      "fields",
      "absentFieldFlags",
      "fieldCount",
      "fill",
      "refusals",
      "find",
      "render",
      "ocrPresence",
      "needsOcr",
      "markdown",
      "overlay",
      "password",
      "pending",
      "note",
    ]);
    for (const [name, expectation] of Object.entries(readManifest().fixtures))
      expect(
        Object.keys(expectation).filter((key) => !known.has(key)),
        name,
      ).toEqual([]);
    expect(Object.keys(readManifest().fixtures).sort()).toEqual(Object.keys(FIXTURES).sort());
    expect(LEO_MEDICAL_YAML).toContain("MMR 2016-03-02");
  });

  it("builds every fixture byte for byte the same each time", async () => {
    for (const name of Object.keys(FIXTURES)) {
      expect(Buffer.from(await buildFixture(name)).equals(Buffer.from(await buildFixture(name))), name).toBe(true);
    }
  });

  it("matches partially at the top of objects and exactly in arrays", () => {
    expect(matches({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(matches([1, 2], [1, 2, 3])).toBe(false);
    expect(matches({ o: [{ v: "x" }] }, { o: [{ v: "x", s: "y" }] })).toBe(true);
  });

  it("fails a fixture that departs from its expectation, and passes one that does not", () => {
    const expectation: FixtureExpectation = { group: "injection", absent: ["Ignore"], hidden: ["tiny"] };
    const facts: Extract<PdfRunResult, { ok: true }>["answer"]["facts"] = {
      sha256: "a".repeat(64),
      pageCount: 1,
      encryption: "none",
      fillPermitted: true,
      modifyPermitted: true,
      form: "none",
      fieldCount: 0,
      signatures: 0,
      activeContent: [],
      comments: 0,
      imageOnlyPages: [],
    };
    const read = (text: string, hidden: { reason: "tiny"; text: string }[]) => ({
      ok: true as const,
      answer: { ok: true as const, facts, pages: [{ page: 1, text, hidden }], maxRssKb: 1 },
      pngs: [],
      document: new Uint8Array(0),
      peakKb: 1,
      wallMs: 1,
    });
    expect(check(expectation, { read: read("Statement", [{ reason: "tiny", text: "Ignore" }]) })).toEqual([]);
    expect(check(expectation, { read: read("Statement Ignore", []) })).toEqual(['text: holds "Ignore"', "hidden: no tiny span"]);
    expect(check({ group: "resource", contained: true }, { read: { ok: false, failure: "crashed" } })).toHaveLength(1);
    expect(check({ group: "resource", contained: true }, { read: { ok: false, failure: "memory" } })).toEqual([]);
  });

  it("finds an outline framing a widget on a quarter-turned page", () => {
    const [width, height] = [100, 100];
    const pixels = new Uint8Array(width * height * 4).fill(255);
    const paint = (x: number, y: number) => pixels.set([255, 200, 0], (y * width + x) * 4);
    // Page rect [60, 20, 80, 30] with crop origin (50, 10): device x 10..20, y 10..30.
    for (let x = 10; x <= 20; x += 1) [10, 30].forEach((y) => paint(x, y));
    for (let y = 10; y <= 30; y += 1) [10, 20].forEach((x) => paint(x, y));
    expect(framesRotated({ width, height, pixels }, [60, 20, 80, 30], [50, 10, 500, 700], 1)).toBe(true);
    expect(framesRotated({ width, height, pixels }, [20, 60, 30, 80], [50, 10, 500, 700], 1)).toBe(false);
    expect(decodePng).toBeTypeOf("function");
  });

  it.skipIf(!childBuilt)(
    "passes the mechanics, injection, active-content and bomb fixtures through the built child",
    async () => {
      const names = [
        "opt-combo",
        "radio-opt",
        "radio-nearby-only",
        "checkbox-onvalue",
        "rotated-90",
        "school-packet",
        "hidden-render-mode-3",
        "hidden-ocg-off",
        "js-openaction",
        "launch",
        "signed",
        "owner-only-nofill",
        "user-password",
        "flate-bomb",
        "page-bomb",
        "truncated",
      ];
      const reports = await runEval({ names });
      expect(reports.filter((report) => report.status !== "pass").map((report) => `${report.name}: ${report.problems.join("; ")}`)).toEqual(
        [],
      );
    },
    120_000,
  );
});
