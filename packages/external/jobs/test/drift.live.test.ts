import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SkillDictionary } from "@tavi/jobs-kit";
import { describe, expect, it } from "vitest";

import { createEngine } from "../src/engine.js";
import { workerFetcher } from "../src/index.js";

/**
 * The drift canaries: one live search per documented keyless HTTP
 * adapter, on the public boards its recordings came from
 * (packages/test-support/fixtures/jobs/README.md), failing when an answer is no
 * longer the shape the adapter reads. GET only; weekly, outside CI. A source
 * that needs a key runs when its key is in the environment. Run with
 * `TAVI_REAL_TESTS=1 TAVI_LIVE_JOBS=1 pnpm --filter @tavi/plugin-jobs exec vitest run test/drift.live.test.ts`.
 */
const LIVE = process.env["TAVI_LIVE_JOBS"] === "1";
const dictionary = JSON.parse(readFileSync(join(import.meta.dirname, "..", "assets", "skills.json"), "utf8")) as SkillDictionary;

/** Each canary: its source, and the query its recording answered. */
const CANARIES: readonly { readonly source: string; readonly query: Record<string, unknown>; readonly keys?: readonly string[] }[] = [
  { source: "greenhouse", query: { keywords: [], countries: [], employers: [{ source: "greenhouse", tenant: "gitlab" }] } },
  { source: "lever", query: { keywords: [], countries: [], employers: [{ source: "lever", tenant: "leverdemo" }] } },
  { source: "ashby", query: { keywords: [], countries: [], employers: [{ source: "ashby", tenant: "ashby" }] } },
  {
    source: "smartrecruiters",
    query: { keywords: ["engineer"], countries: [], employers: [{ source: "smartrecruiters", tenant: "ServiceNow" }] },
  },
  { source: "recruitee", query: { keywords: [], countries: [], employers: [{ source: "recruitee", tenant: "bunq" }] } },
  { source: "personio", query: { keywords: [], countries: [], employers: [{ source: "personio", tenant: "personio" }] } },
  { source: "breezy", query: { keywords: [], countries: [], employers: [{ source: "breezy", tenant: "breezy" }] } },
  { source: "workable", query: { keywords: [], countries: [], employers: [{ source: "workable", tenant: "huggingface" }] } },
  { source: "himalayas", query: { keywords: ["backend engineer"], countries: ["US"] } },
  { source: "jobtech", query: { keywords: ["backend"], countries: ["SE"] } },
  { source: "forem", query: { keywords: [], countries: ["BE"] } },
  { source: "adzuna", query: { keywords: ["backend"], countries: ["GB"] }, keys: ["adzunaAppId", "adzunaAppKey"] },
  { source: "usajobs", query: { keywords: ["it"], countries: ["US"] }, keys: ["usajobsKey", "usajobsEmail"] },
  { source: "reed", query: { keywords: ["backend"], countries: ["GB"] }, keys: ["reedKey"] },
  { source: "nav", query: { keywords: [], countries: ["NO"] }, keys: ["navToken"] },
];

/** A key from the environment: `JOBS_KEY_<NAME>` (e.g. `JOBS_KEY_ADZUNAAPPID`). */
const keyOf = (name: string): string | undefined => process.env[`JOBS_KEY_${name.toUpperCase()}`];

describe.skipIf(!LIVE)("drift canaries against the live sources", () => {
  for (const canary of CANARIES) {
    const missing = (canary.keys ?? []).filter((key) => keyOf(key) === undefined);
    it.skipIf(missing.length > 0)(
      `${canary.source} still answers in the shape its adapter reads`,
      async () => {
        const home = mkdtempSync(join(tmpdir(), "tavi-jobs-drift-"));
        try {
          const keys = Object.fromEntries((canary.keys ?? []).map((key) => [key, keyOf(key)]));
          const jobs = createEngine({
            storePath: join(home, "jobs.db"),
            dictionary,
            fetcher: workerFetcher,
            credential: async (key) => (key === "usajobsEmail" ? null : (keys[key] ?? null)),
            config: { sources: canary.source, ...(keys["usajobsEmail"] === undefined ? {} : { usajobsEmail: keys["usajobsEmail"] }) },
            version: "0.1.0",
          });
          try {
            const result = await jobs.search({ postedWithinDays: 60, ...canary.query }, new AbortController().signal, {
              unattended: false,
            });
            const reports = result.sources.filter((report) => report.source === canary.source);
            expect(reports.length, JSON.stringify(result.sources)).toBeGreaterThan(0);
            // A drifted answer reads "changed: its answer is not the shape Tavi reads".
            for (const report of reports) expect(report.outcome, JSON.stringify(report)).not.toMatch(/^changed/);
            expect(
              reports.some((report) => report.outcome === "ok"),
              JSON.stringify(reports),
            ).toBe(true);
          } finally {
            jobs.close();
          }
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      },
      120_000,
    );
  }
});
