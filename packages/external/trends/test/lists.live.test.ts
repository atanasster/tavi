import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GTRENDS_RSS, ListSpecSchema, TR3_RECORDS, gtrendsRss, listAdapter, type TrendsAdapter } from "@tavi/trends-kit";
import { describe, expect, it } from "vitest";

import { createEngine } from "../src/engine.js";
import { workerFetcher } from "../src/index.js";

/**
 * The open-page lists' live reads: each open-page list
 * against its live site once, through the plugin's engine and its real
 * fetch (robots.txt first), and "what's trending in Taiwan today" from
 * Google Trends TW and PTT. No contact is set, so Wikipedia is not read;
 * PTT is its default board, no 18+ board being asserted. GET only; outside
 * CI. Run with
 * `TAVI_REAL_TESTS=1 TAVI_LIVE_TRENDS=1 pnpm --filter @tavi/plugin-trends exec vitest run test/lists.live.test.ts`;
 * the run prints what it read.
 */
const LIVE = process.env["TAVI_LIVE_TRENDS"] === "1";
const root = join(import.meta.dirname, "..");

describe.skipIf(!LIVE)("the open-page lists, live", () => {
  it("reads each list once, and what trends in Taiwan today", async () => {
    const records = new Map(TR3_RECORDS.map((record) => [record.id, record]));
    const lists: TrendsAdapter[] = readdirSync(join(root, "lists"))
      .sort()
      .map((file) => {
        const spec = ListSpecSchema.parse(JSON.parse(readFileSync(join(root, "lists", file), "utf8")));
        const record = records.get(spec.recordId);
        if (record === undefined) throw new Error(spec.recordId);
        return listAdapter(record, spec);
      });
    const home = mkdtempSync(join(tmpdir(), "tavi-trends-lists-live-"));
    const requests: { url: string; status: number | "error"; at: string }[] = [];
    try {
      const radar = createEngine({
        home,
        config: { enabledSources: [...lists.map((adapter) => adapter.record.id), GTRENDS_RSS.id].join(",") },
        version: "0.1.0",
        adapters: [gtrendsRss],
        lists,
        fetcher: async (request, signal) => {
          const at = new Date().toISOString();
          try {
            const answer = await workerFetcher(request, signal);
            requests.push({ url: request.url, status: answer.status, at });
            return answer;
          } catch (error) {
            requests.push({ url: request.url, status: "error", at });
            throw error;
          }
        },
      });
      const operator = { scope: { principalId: "operator", workspaceId: "default" }, unattended: false };
      const byCountry: Record<string, unknown> = {};
      for (const country of ["CN", "JP", "TH", "KR", "TW"]) {
        const snapshot = await radar.snapshot({ country }, new AbortController().signal, operator);
        byCountry[country] = {
          sources: snapshot.sources,
          lists: snapshot.lists.map((list) => ({
            source: list.source,
            entries: list.entries.length,
            top: list.entries.slice(0, 5).map((entry) => entry.title),
          })),
        };
      }
      radar.close();
      console.log(JSON.stringify({ ranAt: new Date().toISOString(), byCountry, requests }, null, 2));
      expect(requests.some((request) => request.url.endsWith("/robots.txt"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
