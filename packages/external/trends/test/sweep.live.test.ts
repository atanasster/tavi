import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTrendsStore } from "@tavi/trends-kit";
import { describe, expect, it } from "vitest";

import { createEngine, type Fetcher } from "../src/engine.js";
import { workerFetcher } from "../src/index.js";

/**
 * A live day: one sweep of three
 * topics against the real sources, with the plugin's engine and its real
 * `fetch`, outside the sandbox: every request, its status and time, how the
 * budgets paced it, and the rows written. GET only, public endpoints;
 * outside CI. No contact is set, as at install, so Wikimedia's sources stay
 * off. Run with
 * `TAVI_REAL_TESTS=1 TAVI_LIVE_TRENDS=1 pnpm --filter @tavi/plugin-trends exec vitest run test/sweep.live.test.ts`;
 * the run prints what it read.
 */
const LIVE = process.env["TAVI_LIVE_TRENDS"] === "1";

const TOPICS = [
  { label: "Solid-state batteries", terms: { en: ["solid-state battery"] }, countries: ["US"] },
  { label: "Halloween", terms: { en: ["Halloween"], de: ["Halloween"] }, countries: ["DE"] },
  { label: "Rust (language)", terms: { en: ["Rust programming"] }, exclude: ["corrosion"] },
];

describe.skipIf(!LIVE)("a live sweep of three topics", () => {
  it("reads every source through its budget and stores the series", async () => {
    const home = mkdtempSync(join(tmpdir(), "tavi-trends-live-"));
    const requests: { host: string; status: number | "error"; ms: number; at: string }[] = [];
    const fetcher: Fetcher = async (request, signal) => {
      const started = Date.now();
      const at = new Date(started).toISOString();
      try {
        const answer = await workerFetcher(request, signal);
        requests.push({ host: new URL(request.url).host, status: answer.status, ms: Date.now() - started, at });
        return answer;
      } catch (error) {
        requests.push({ host: new URL(request.url).host, status: "error", ms: Date.now() - started, at });
        throw error;
      }
    };
    try {
      const radar = createEngine({ home, fetcher, config: {}, version: "0.1.0" });
      const operator = { scope: { principalId: "operator", workspaceId: "default" }, unattended: false };
      for (const topic of TOPICS) radar.watch({ op: "add", topic }, operator);
      const started = Date.now();
      const swept = await radar.sweep({}, new AbortController().signal, operator);
      const sweepMs = Date.now() - started;
      const health = (await radar.sources({})).sources.map((source) => ({
        id: source.id,
        on: source.on,
        health: source.health,
        usedToday: source.budget.usedToday,
      }));
      radar.close();
      const store = openTrendsStore(join(home, "trends.db"));
      const rows = store.db
        .prepare(
          "SELECT source_id, metric, bucket_seconds, COUNT(*) AS n, SUM(quality = 'missing') AS missing FROM series GROUP BY source_id, metric, bucket_seconds ORDER BY source_id, metric",
        )
        .all();
      store.close();
      const byHost = new Map<string, typeof requests>();
      for (const request of requests) byHost.set(request.host, [...(byHost.get(request.host) ?? []), request]);
      const report = {
        ranAt: new Date().toISOString(),
        sweepMs,
        topics: swept.topics.map((topic) => ({ label: topic.label, state: topic.state, sources: topic.sources })),
        requests: {
          total: requests.length,
          byHost: [...byHost].map(([host, list]) => ({
            host,
            count: list.length,
            statuses: [...new Set(list.map((request) => request.status))],
            medianMs: [...list].sort((a, b) => a.ms - b.ms)[Math.floor(list.length / 2)]?.ms,
          })),
        },
        /** GDELT's budget is one request every 5 s: the gaps between its requests. */
        gdeltGapsMs: requests
          .filter((request) => request.host === "api.gdeltproject.org")
          .map((request, index, list) => (index === 0 ? 0 : Date.parse(request.at) - Date.parse(list[index - 1]?.at ?? request.at)))
          .slice(1),
        health,
        rows,
        trendsDbBytes: statSync(join(home, "trends.db")).size,
      };
      console.log(JSON.stringify(report, null, 2));
      expect(requests.length).toBeGreaterThan(0);
      expect(report.gdeltGapsMs.every((gap) => gap >= 4_900)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 600_000);
});
