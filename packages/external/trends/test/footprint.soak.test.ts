import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARXIV,
  BLUESKY_SEARCH,
  GDELT_DOC,
  HN_ALGOLIA,
  MASTODON_TRENDS,
  RSS_EUROPE,
  bucketsOf,
  type TrendsAdapter,
  type TrendsSourceRecord,
} from "@tavi/trends-kit";
import { describe, expect, it } from "vitest";

import { createEngine } from "../src/engine.js";

/**
 * The store's footprint: `trends.db`'s size
 * after 7 simulated days of hourly sweeps, 08:00 to 22:00, of 20 topics over
 * six sources (four hourly, two daily), every bucket written; and how long
 * the heartbeat's `collect` takes from a cold start on that store. A fake
 * network: the numbers are the store's and the engine's, not the sources'.
 * A soak suite (about 15 s): it runs with `TAVI_REAL_TESTS=1` and prints what it measured.
 */
const START = "2026-10-10T08:00:00.000Z";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A source that counts a varying few an hour, with no request beyond one per read. */
function steady(record: TrendsSourceRecord, metric: string): TrendsAdapter {
  return {
    record,
    counts: {
      request: ({ window }) => [{ url: `https://${record.hosts[0] ?? "example.org"}/c?from=${window.from}`, expect: "json" }],
      parse: (_response, _request, { window }) => ({
        kind: "ok",
        value: [
          {
            metric,
            points: bucketsOf(window).map((start) => ({ start, value: (Date.parse(start) / HOUR_MS) % 7, quality: "ok" as const })),
          },
        ],
      }),
    },
  };
}
const adapters = [
  steady(HN_ALGOLIA, "stories"),
  steady(GDELT_DOC, "articles"),
  steady(BLUESKY_SEARCH, "authors"),
  steady(RSS_EUROPE, "stories"),
  steady(MASTODON_TRENDS, "accounts"),
  steady(ARXIV, "papers"),
];

describe("trends.db after 7 days of 20 topics", () => {
  it("measures the store and a cold collect", async () => {
    const home = mkdtempSync(join(tmpdir(), "tavi-trends-footprint-"));
    try {
      const clock = { ms: Date.parse(START) };
      const options = {
        home,
        fetcher: async () => ({ status: 200, retryAfter: null, body: {}, bytes: 2 }),
        config: { countries: "DE" },
        version: "0.1.0",
        adapters,
        now: () => new Date(clock.ms).toISOString(),
        sleep: async (ms: number) => void (clock.ms += ms),
      };
      const operator = { scope: { principalId: "operator", workspaceId: "default" }, unattended: false };
      const radar = createEngine(options);
      for (let index = 0; index < 20; index += 1)
        radar.watch({ op: "add", topic: { label: `Topic ${String(index)}`, terms: { en: [`topic${String(index)}`] } } }, operator);
      let sweeps = 0;
      const sweepMs: number[] = [];
      for (let day = 0; day < 7; day += 1) {
        for (let hour = 0; hour <= 14; hour += 1) {
          clock.ms = Date.parse(START) + day * DAY_MS + hour * HOUR_MS;
          const started = performance.now();
          await radar.sweep({}, new AbortController().signal, operator);
          sweepMs.push(performance.now() - started);
          sweeps += 1;
        }
      }
      radar.close();
      const bytes = statSync(join(home, "trends.db")).size + (statSync(join(home, "trends.db-wal"), { throwIfNoEntry: false })?.size ?? 0);
      // A cold engine on that store: the heartbeat's collect, which reads the states and starts the next sweep.
      const coldStarted = performance.now();
      const cold = createEngine(options);
      cold.signals({ ...operator.scope, now: new Date(clock.ms).toISOString() });
      const collectMs = performance.now() - coldStarted;
      await cold.settled();
      cold.close();
      const sorted = [...sweepMs].sort((a, b) => a - b);
      const report = {
        topics: 20,
        sources: adapters.length,
        sweeps,
        trendsDbBytes: bytes,
        sweepMs: { median: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), max: Math.round(sorted.at(-1) ?? 0) },
        coldCollectMs: Math.round(collectMs),
      };
      console.log(JSON.stringify(report, null, 2));
      expect(collectMs).toBeLessThan(5_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 900_000);
});
