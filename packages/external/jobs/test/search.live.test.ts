import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { greenhouseRecord, leverRecord, openJobsStore, type SkillDictionary } from "@tavi/jobs-kit";
import { describe, expect, it } from "vitest";

import { createEngine } from "../src/engine.js";
import { workerFetcher } from "../src/index.js";

/**
 * A live acceptance run and the drift canary: a job search against live
 * Greenhouse and Lever boards for the
 * fixture profile. GET only, public boards; outside CI. Run with
 * `TAVI_REAL_TESTS=1 TAVI_LIVE_JOBS=1 pnpm --filter @tavi/plugin-jobs exec vitest run test/search.live.test.ts`;
 * each run prints what it found.
 */
const LIVE = process.env["TAVI_LIVE_JOBS"] === "1";
const dictionary = JSON.parse(readFileSync(join(import.meta.dirname, "..", "assets", "skills.json"), "utf8")) as SkillDictionary;

const profile = {
  titles: ["Senior Backend Engineer", "Backend Engineer", "Software Engineer"],
  skills: [{ label: "Go" }, { label: "Python" }, { label: "PostgreSQL" }, { label: "Kubernetes" }],
  seniority: "senior",
  places: [],
  remote: "only",
  remoteRegions: ["US"],
  salaryFloor: { currency: "USD", amount: 160_000, period: "YEAR" },
  employmentTypes: ["FULL_TIME"],
  exclusions: { companies: [], keywords: [] },
  needsSponsorship: [],
};

describe.skipIf(!LIVE)("a job search against live boards", () => {
  it("fetches, filters, matches and attributes", async () => {
    const home = mkdtempSync(join(tmpdir(), "tavi-jobs-live-"));
    try {
      const storePath = join(home, "jobs.db");
      const jobs = createEngine({
        storePath,
        dictionary,
        fetcher: workerFetcher,
        credential: async () => null,
        config: { sources: "greenhouse,lever" },
        version: "0.1.0",
      });
      const employers = [
        ...["stripe", "datadog", "cloudflare", "gitlab"].map((tenant) => ({ source: "greenhouse", tenant })),
        ...["palantir", "spotify"].map((tenant) => ({ source: "lever", tenant })),
      ];
      const result = await jobs.search(
        { keywords: ["backend"], countries: ["US"], postedWithinDays: 30, employers },
        new AbortController().signal,
        { unattended: false },
      );
      jobs.close();
      const store = openJobsStore(
        storePath,
        new Map([
          ["greenhouse", greenhouseRecord],
          ["lever", leverRecord],
        ]),
      );
      const ids = (store.db.prepare("SELECT posting_id FROM postings").all() as { posting_id: string }[]).map((row) => row.posting_id);
      const log = store.recentFetches(50);
      store.close();
      const again = createEngine({
        storePath,
        dictionary,
        fetcher: workerFetcher,
        credential: async () => null,
        config: { sources: "greenhouse,lever" },
        version: "0.1.0",
      });
      const matched = again.match({ postingIds: ids.slice(0, 200), profile });
      again.close();
      const reasons = new Map<string, number>();
      for (const entry of matched.results.filter((each) => each.outcome !== "fits")) {
        for (const reason of entry.reasons) {
          const key = reason.replace(/\d[\d,]*/g, "N");
          reasons.set(key, (reasons.get(key) ?? 0) + 1);
        }
      }
      const report = {
        ranAt: new Date().toISOString(),
        sources: result.sources,
        fetched: ids.length,
        shown: result.postings.length,
        counts: matched.counts,
        reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 12),
        top: matched.results
          .filter((each) => each.outcome === "fits")
          .slice(0, 10)
          .map((each) => ({
            title: each.title,
            company: each.company,
            score: each.score,
            matched: each.matched,
            gaps: each.gaps,
            flags: each.flags,
          })),
        maybeTop: matched.results
          .filter((each) => each.outcome === "maybe")
          .slice(0, 10)
          .map((each) => ({ title: each.title, company: each.company, score: each.score, reasons: each.reasons, flags: each.flags })),
        gaps: matched.gaps,
        attribution: result.attribution,
        outbound: log.map((entry) => ({
          source: entry.source,
          host: entry.host,
          status: entry.status,
          bytes: entry.bytes,
          keywords: entry.keywords,
        })),
      };
      console.log(JSON.stringify(report, null, 2));
      expect(ids.length).toBeGreaterThan(0);
      expect(matched.results).toHaveLength(Math.min(ids.length, 200));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});

/**
 * A live run of watches, on the sources
 * that need no key: one watch per region, swept once as the heartbeat starts
 * it, then its items and a digest. Run as the one above.
 */
describe.skipIf(!LIVE)("watches per region, swept once", () => {
  it("sweeps, tells the hits and digests them", async () => {
    const home = mkdtempSync(join(tmpdir(), "tavi-jobs-live-j2-"));
    try {
      const storePath = join(home, "jobs.db");
      const jobs = createEngine({
        storePath,
        dictionary,
        fetcher: workerFetcher,
        credential: async () => null,
        config: {},
        version: "0.1.0",
      });
      const open = { ...profile, remote: "open", salaryFloor: undefined, seniority: undefined, employmentTypes: [] };
      const watches = [
        {
          name: "US backend: ATS boards and Dice",
          query: {
            keywords: ["backend"],
            countries: ["US"],
            postedWithinDays: 14,
            employers: [{ source: "greenhouse", tenant: "gitlab" }],
            sources: ["greenhouse", "dice"],
          },
          criteria: open,
        },
        {
          name: "US systems software: a Workday tenant",
          query: {
            keywords: ["software"],
            countries: ["US"],
            postedWithinDays: 30,
            employers: [{ source: "workday", tenant: "nvidia.wd5/NVIDIAExternalCareerSite" }],
            sources: ["workday"],
          },
          criteria: {
            ...open,
            titles: ["Software Engineer", "System Software Engineer"],
            places: [{ country: "US", city: "Santa Clara", radiusKm: 50 }],
          },
        },
        {
          name: "SE developer: JobTech",
          query: { keywords: ["utvecklare"], countries: ["SE"], postedWithinDays: 7, sources: ["jobtech"] },
          criteria: {
            ...open,
            titles: ["Utvecklare", "Developer"],
            skills: [{ label: "Java" }, { label: "Python" }],
            places: [{ country: "SE", city: "Stockholm", radiusKm: 50 }],
          },
        },
        {
          name: "US hourly near Austin: Snagajob",
          query: {
            keywords: ["cook"],
            countries: ["US"],
            postedWithinDays: 7,
            place: { city: "Austin, TX", radiusKm: 16 },
            sources: ["snagajob"],
          },
          criteria: {
            ...open,
            titles: ["Cook", "Prep Cook", "Line Cook"],
            skills: [],
            places: [{ country: "US", city: "Austin", radiusKm: 30 }],
          },
        },
      ];
      const ids = watches.map((watch) => jobs.watch({ action: "create", cadence: 1, minScore: 0.2, ...watch }).watch?.watchId ?? "");
      await jobs.sweep();
      const items = jobs.signals();
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const digests = ids.map((watchId) => jobs.digest({ watchId, since }));
      const sources = jobs.sources();
      jobs.close();
      const store = openJobsStore(storePath, new Map());
      const requests = new Map<string, number>();
      for (const entry of store.recentFetches(500))
        requests.set(`${entry.source} ${String(entry.status)}`, (requests.get(`${entry.source} ${String(entry.status)}`) ?? 0) + 1);
      const bySource = (sourceIds: readonly string[]) =>
        (
          store.db
            .prepare(`SELECT posting_id FROM postings WHERE source IN (${sourceIds.map(() => "?").join(", ")})`)
            .all(...sourceIds) as { posting_id: string }[]
        ).map((row) => row.posting_id);
      const kept = watches.map((watch) => bySource(watch.query.sources));
      store.close();
      // Why the rest did not fit, per watch: its stored postings against its criteria.
      const again = createEngine({
        storePath,
        dictionary,
        fetcher: workerFetcher,
        credential: async () => null,
        config: {},
        version: "0.1.0",
      });
      const outcomes = watches.map((watch, index) => {
        const matched = again.match({ postingIds: kept[index] ?? [], profile: watch.criteria });
        const reasons = new Map<string, number>();
        for (const entry of matched.results.filter((each) => each.outcome !== "fits"))
          for (const reason of entry.reasons)
            reasons.set(reason.replace(/\d[\d,.]*/g, "N"), (reasons.get(reason.replace(/\d[\d,.]*/g, "N")) ?? 0) + 1);
        return { watch: watch.name, counts: matched.counts, reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5) };
      });
      again.close();
      const report = {
        ranAt: new Date().toISOString(),
        requests: Object.fromEntries(requests),
        outcomes,
        watches: sources.watches.map((watch) => ({ name: watch.name, lastOutcome: watch.lastOutcome, nextRunAt: watch.nextRunAt })),
        items: items.map((item) => ({ key: item.key.replace(/:[^:]+$/, ":…"), title: item.title })),
        digests: digests.map((digest) => ({
          watch: digest.watch.name,
          count: digest.count,
          top: digest.hits.slice(0, 3).map((hit) => ({
            title: "title" in hit ? hit.title : hit.postingId,
            company: "company" in hit ? hit.company : "",
            score: hit.score,
            attribution: "attribution" in hit ? hit.attribution : "",
          })),
        })),
      };
      console.log(JSON.stringify(report, null, 2));
      expect(sources.watches.every((watch) => watch.lastOutcome !== undefined && !watch.lastOutcome.startsWith("failed"))).toBe(true);
      expect(items.length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 600_000);
});
