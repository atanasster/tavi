import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import {
  GHOST_EVERGREEN_DAYS,
  GHOST_REPOST_DAYS,
  adzunaRecord,
  greenhouseRecord,
  minhashOf,
  minhashSimilarity,
  normalizePosting,
  openJobsStore,
  type JobProfileInput,
  type JobSourceRecord,
  type RawPosting,
} from "../src/index.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());
const path = () => {
  const directory = temp.create("tavi-jobs-j2-");
  return join(directory, "jobs.db");
};
const NOW = "2026-10-16T12:00:00.000Z";
const days = (count: number) => new Date(Date.parse(NOW) + count * 86_400_000).toISOString();
const records: ReadonlyMap<string, JobSourceRecord> = new Map([
  ["greenhouse", greenhouseRecord],
  ["adzuna", adzunaRecord],
]);
const raw = (extra: Partial<RawPosting> = {}): RawPosting => ({
  source: "greenhouse",
  sourceRef: "acme/1",
  tenant: "acme",
  url: "https://boards.greenhouse.io/acme/jobs/1",
  title: "Senior Backend Engineer",
  company: "Acme",
  locations: ["Berlin, Germany"],
  workplace: "hybrid",
  descriptionText: "Build services in Go.",
  attribution: "Acme via Greenhouse",
  ...extra,
});

/** 100 distinct words; `changed` of them at the end replaced: 96 shingles each, sharing 96 - changed. */
const words = Array.from({ length: 100 }, (_, index) => `word${String(index)}`);
const text = (changed: number) =>
  [...words.slice(0, 100 - changed), ...Array.from({ length: changed }, (_, index) => `other${String(index)}`)].join(" ");
const jaccard = (changed: number) => (96 - changed) / (96 + changed);

describe("MinHash near-duplicates", () => {
  it("estimates Jaccard over 5-word shingles", () => {
    const base = minhashOf(text(0)) ?? [];
    expect(base).toHaveLength(64);
    expect(minhashSimilarity(base, minhashOf(text(0)) ?? [])).toBe(1);
    expect(minhashOf("four words only here")).toBeUndefined();
    expect(jaccard(8)).toBeCloseTo(0.85, 2);
    expect(Math.abs(minhashSimilarity(base, minhashOf(text(8)) ?? []) - jaccard(8))).toBeLessThan(0.1);
  });

  it("joins a reposted ad at Jaccard 0.85, not one at 0.6, and only when the companies agree", () => {
    const store = openJobsStore(path(), records);
    const [original] = store.upsert([normalizePosting(raw({ descriptionText: text(0) }), NOW)], NOW);
    // A new id and title, so neither its URL nor its fingerprint joins it: only its words.
    const ad = (ref: string, changed: number, company = "Acme") =>
      normalizePosting(
        raw({
          sourceRef: `acme/${ref}`,
          url: `https://boards.greenhouse.io/acme/jobs/${ref}`,
          title: `Backend Engineer ${ref}`,
          company,
          descriptionText: text(changed),
        }),
        NOW,
      );
    const [close] = store.upsert([ad("2", 8)], NOW);
    const [far] = store.upsert([ad("3", 24)], NOW);
    const [elsewhere] = store.upsert([ad("4", 0, "Globex")], NOW);
    expect(jaccard(24)).toBeCloseTo(0.6, 2);
    expect(close?.clusterId).toBe(original?.clusterId);
    expect(far?.clusterId).not.toBe(original?.clusterId);
    expect(elsewhere?.clusterId).not.toBe(original?.clusterId);
    store.close();
  });
});

describe("a posting's flags", () => {
  it("flags pay a jurisdiction requires when the ad states none, from the day its law applies", () => {
    const flags = (extra: Partial<RawPosting>, now = NOW) => normalizePosting(raw({ locations: [], ...extra }), now).posting.flags;
    expect(flags({ places: [{ country: "US", region: "CA", city: "San Jose" }] })).toContain("salary-missing-required");
    expect(flags({ places: [{ country: "US", region: "Colorado" }] })).toContain("salary-missing-required");
    expect(
      flags({
        places: [{ country: "US", region: "CA" }],
        descriptionText: "Build services in Go. The pay range is $150,000 - $180,000 a year.",
      }),
    ).not.toContain("salary-missing-required");
    expect(flags({ places: [{ country: "US", region: "TX" }] })).not.toContain("salary-missing-required");
    // Before Massachusetts' law applied.
    expect(flags({ places: [{ country: "US", region: "MA" }], postedAt: "2025-09-01T00:00:00Z" })).not.toContain("salary-missing-required");
    expect(flags({ places: [{ country: "US", region: "MA" }], postedAt: "2025-11-01T00:00:00Z" })).toContain("salary-missing-required");
  });

  it("flags short-period pay that comes to an outlier's year", () => {
    const flags = (amount: number, period: "HOUR" | "WEEK" | "YEAR") =>
      normalizePosting(raw({ salary: { currency: "USD", min: amount, period, basis: "unknown", origin: "stated" } }), NOW).posting.flags;
    expect(flags(250, "HOUR")).toContain("scam:pay-outlier");
    expect(flags(8_000, "WEEK")).toContain("scam:pay-outlier");
    expect(flags(45, "HOUR")).not.toContain("scam:pay-outlier");
    expect(flags(400_000, "YEAR")).not.toContain("scam:pay-outlier");
  });

  it("flags a job posted again under a new id long after it was first seen, and one seen for months", () => {
    const store = openJobsStore(path(), records);
    store.upsert([normalizePosting(raw(), NOW)], NOW);
    // The same job (its fingerprint) under a new id: soon after, a repost is not yet a ghost.
    const again = (ref: string, at: string) =>
      store.upsert(
        [
          normalizePosting(
            raw({ sourceRef: `acme/${ref}`, url: `https://boards.greenhouse.io/acme/jobs/${ref}`, source: "adzuna", tenant: undefined }),
            at,
          ),
        ],
        at,
      )[0];
    expect(again("2", days(5))?.flags).not.toContain("ghost:reposted");
    expect(again("3", days(GHOST_REPOST_DAYS + 1))?.flags).toContain("ghost:reposted");
    // Seen again for months: evergreen, and a repost stays one.
    const [seen] = store.upsert(
      [
        normalizePosting(
          raw({ sourceRef: "acme/3", url: "https://boards.greenhouse.io/acme/jobs/3", source: "adzuna", tenant: undefined }),
          days(GHOST_EVERGREEN_DAYS + 1),
        ),
      ],
      days(GHOST_EVERGREEN_DAYS + 1),
    );
    expect(seen?.flags).toEqual(expect.arrayContaining(["ghost:reposted", "ghost:evergreen"]));
    store.close();
  });
});

const criteria: JobProfileInput = {
  titles: ["Backend Engineer"],
  skills: [{ label: "Go" }],
  places: [],
  remote: "open",
  remoteRegions: [],
  employmentTypes: [],
  exclusions: { companies: [], keywords: [] },
  needsSponsorship: [],
};
const watchInput = {
  name: "Backend in Berlin",
  query: { keywords: ["backend"], countries: ["DE"], postedWithinDays: 14 },
  criteria,
  cadence: 6,
  minScore: 0.3,
};

describe("watches and hits", () => {
  it("creates, pauses, resumes and removes a watch; its first sweep is due at once", () => {
    const store = openJobsStore(path(), records);
    const watch = store.createWatch(watchInput, NOW);
    expect(watch).toMatchObject({ name: "Backend in Berlin", enabled: true, nextRunAt: NOW, cadence: 6 });
    expect(store.dueWatches(NOW).map((each) => each.watchId)).toEqual([watch.watchId]);
    store.sweptWatch(watch.watchId, "2 new", NOW, days(0.25));
    expect(store.dueWatches(days(0.1))).toEqual([]);
    store.updateWatch(watch.watchId, { enabled: false }, days(0.3));
    expect(store.dueWatches(days(1))).toEqual([]);
    // Resumed, it is due from then, not at its old time.
    expect(store.updateWatch(watch.watchId, { enabled: true }, days(2))).toMatchObject({
      enabled: true,
      nextRunAt: days(2),
      lastOutcome: "2 new",
    });
    expect(store.removeWatch(watch.watchId)).toBe(true);
    expect(store.watches()).toEqual([]);
    store.close();
  });

  it("keeps each job once per watch, reads hits without writing, and delivers each once", () => {
    const store = openJobsStore(path(), records);
    const watch = store.createWatch(watchInput, NOW);
    const [kept] = store.upsert([normalizePosting(raw(), NOW)], NOW);
    const hit = { clusterId: kept?.clusterId ?? "", postingId: kept?.postingId ?? "", score: 0.7 };
    expect(store.addHits(watch.watchId, [hit], NOW)).toHaveLength(1);
    expect(store.addHits(watch.watchId, [hit], days(1))).toHaveLength(0);
    const before = store.hitsSince(watch.watchId, days(-1));
    expect(store.hitsSince(watch.watchId, days(-1))).toEqual(before);
    expect(before.map((each) => each.deliveredAt)).toEqual([undefined]);
    expect(store.hitsSince(watch.watchId, NOW)).toEqual([]);
    // Only the hits read are marked delivered.
    expect(store.deliverHits(days(-1), days(0.05), 0)).toEqual([]);
    expect(store.deliverHits(days(-1), days(0.1), 10)[0]?.deliveredAt).toBeUndefined();
    expect(store.deliverHits(days(-1), days(0.2), 10)[0]?.deliveredAt).toBe(days(0.1));
    store.close();
  });

  it("tells hits not yet told first, so a sweep's hits past one collection's page are all told", () => {
    const store = openJobsStore(path(), records);
    const watch = store.createWatch(watchInput, NOW);
    // Three hits of one sweep (one first_seen), told two at a time.
    const kept = store.upsert(
      [1, 2, 3].map((n) =>
        normalizePosting(
          raw({
            sourceRef: `r${String(n)}`,
            url: `https://boards.greenhouse.io/acme/jobs/${String(n)}`,
            title: `Engineer ${String(n)}`,
            company: `Acme ${String(n)}`,
            descriptionText: `Role number ${String(n)} in team ${String(n * 7)}.`,
          }),
          NOW,
        ),
      ),
      NOW,
    );
    store.addHits(
      watch.watchId,
      kept.map((posting, index) => ({ clusterId: posting.clusterId, postingId: posting.postingId, score: 0.9 - index / 10 })),
      NOW,
    );
    const first = store.deliverHits(days(-1), days(0.1), 2);
    const second = store.deliverHits(days(-1), days(0.2), 2);
    expect(first.map((hit) => hit.deliveredAt)).toEqual([undefined, undefined]);
    expect(second[0]?.deliveredAt).toBeUndefined();
    expect(new Set([...first, ...second].map((hit) => hit.clusterId)).size).toBe(3);
    store.close();
  });

  it("drops a hit whose posting retention deleted, and forgets watches with everything else", () => {
    const store = openJobsStore(path(), records);
    const watch = store.createWatch(watchInput, NOW);
    const [kept] = store.upsert([normalizePosting(raw(), NOW)], NOW);
    store.addHits(watch.watchId, [{ clusterId: kept?.clusterId ?? "", postingId: kept?.postingId ?? "", score: 0.7 }], NOW);
    store.retain(days(61));
    expect(store.hitsSince(watch.watchId, days(-1))).toEqual([]);
    store.forget();
    expect(store.watches()).toEqual([]);
    store.close();
  });
});
