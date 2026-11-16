import type { DatabaseSync } from "node:sqlite";

import { createSourceHealth, openDomainStore, type SourceHealthLedger } from "@tavi/domain-kit";

export { SOURCE_PAUSE_FAILURES, SOURCE_PAUSE_MS, type SourceHealth } from "@tavi/domain-kit";

import { randomUUID } from "node:crypto";

import {
  JOB_APPLICATION_STATES,
  JOB_FLAGS,
  JobPostingSchema,
  JobWatchInputSchema,
  type JobApplicationState,
  type JobFlag,
  type JobHit,
  type JobPosting,
  type JobSourceRecord,
  type JobWatch,
  type JobWatchInput,
} from "../contracts.js";
import { canonicalUrl, companyKey, fingerprintOf } from "../dedup.js";
import { MINHASH_JOIN, minhashBands, minhashOf, minhashSimilarity } from "../minhash.js";
import { JOBS_MIGRATIONS } from "./migrations.js";

/**
 * The jobs plugin's store over `jobs.db`: what the worker keeps of
 * postings, the person's pipeline, and each source's health. Every write is
 * the worker's own, from a source's answer or a `track` the person approved.
 */

/** A posting outside the pipeline goes this long after it was last seen. */
export const POSTING_KEEP_DAYS = 60;
/** A description outside the pipeline is blanked this long after it was last seen. */
export const DESCRIPTION_KEEP_DAYS = 14;
const FETCH_LOG_KEEP = 500;
/** A job first seen this long ago and posted again under a new id is `ghost:reposted` (Tavi's threshold). */
export const GHOST_REPOST_DAYS = 30;
/** A job seen for this long is `ghost:evergreen`: likely a standing ad, not an opening (Tavi's threshold). */
export const GHOST_EVERGREEN_DAYS = 90;
/** Hits one call reads. */
const HITS_MAX = 200;
const DAY_MS = 86_400_000;

export interface StoredPosting {
  readonly posting: JobPosting;
  readonly description: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly removed: boolean;
}

export interface Application {
  readonly clusterId: string;
  readonly postingId: string;
  readonly state: JobApplicationState;
  readonly history: readonly { readonly state: JobApplicationState; readonly at: string; readonly actor: string }[];
  readonly note: string;
  readonly stagedAt?: string;
  readonly appliedAt?: string;
  readonly updatedAt: string;
}

export interface FetchLogEntry {
  readonly source: string;
  readonly host: string;
  readonly at: string;
  readonly status: number;
  readonly bytes: number;
  /** The query's keywords only, never a profile's fields. */
  readonly keywords: string;
}

type Row = Record<string, string | number | null>;
const text = (value: string | number | null | undefined): string | undefined => (typeof value === "string" ? value : undefined);

export interface JobsStore extends SourceHealthLedger {
  readonly db: DatabaseSync;
  /** Keeps each posting, joined to a cluster it repeats (URL, then ATS identity, then fingerprint). Answers the stored postings. */
  upsert(postings: readonly { readonly posting: JobPosting; readonly description: string }[], now: string): JobPosting[];
  /** A posting, its text blank once its source's terms say it has expired (Adzuna's 4 hours), however long since `retain` ran. */
  get(postingId: string, now: string): StoredPosting | undefined;
  /** The posting stored under a URL's canonical form, if any. */
  findByUrl(url: string): string | undefined;
  /** Postings by id, in the order asked, skipping unknown or removed ones. */
  many(postingIds: readonly string[], now: string): StoredPosting[];
  /** Marks postings a source says are gone (NAV's `INACTIVE`, `removeInactive`). */
  remove(postingIds: readonly string[], now: string): void;
  track(
    input: { readonly postingId: string; readonly state: JobApplicationState; readonly note?: string; readonly actor: string },
    now: string,
  ): Application;
  applications(states?: readonly JobApplicationState[]): Application[];
  counts(): Readonly<Record<JobApplicationState, number>>;
  log(entry: FetchLogEntry): void;
  recentFetches(limit: number): FetchLogEntry[];
  /** Retention, at start and daily, by each source's cache terms. */
  retain(now: string): { readonly deleted: number; readonly blanked: number };
  /** Creates a watch the person approved; its first sweep is due at once. */
  createWatch(input: JobWatchInput, now: string): JobWatch;
  /** Changes a watch: its fields, or `enabled` (pause, resume). A changed cadence counts from now. */
  updateWatch(watchId: string, change: { readonly input?: JobWatchInput; readonly enabled?: boolean }, now: string): JobWatch;
  /** Removes a watch and its hits. */
  removeWatch(watchId: string): boolean;
  watch(watchId: string): JobWatch | undefined;
  watches(): JobWatch[];
  /** The enabled watches whose next sweep is due, oldest first. */
  dueWatches(now: string): JobWatch[];
  /** A sweep's end: when the next is due, and what it found. */
  sweptWatch(watchId: string, outcome: string, now: string, nextRunAt: string): void;
  /** Keeps hits a watch has not had before (one per job). Answers the new ones. */
  addHits(
    watchId: string,
    hits: readonly { readonly clusterId: string; readonly postingId: string; readonly score: number }[],
    now: string,
  ): JobHit[];
  /** A watch's hits first seen after `since`, newest first; reads only. */
  hitsSince(watchId: string, since: string): JobHit[];
  /** Every watch's hits first seen after `since`, newest first, at most `limit`, marking those not yet delivered. */
  deliverHits(since: string, now: string, limit: number): JobHit[];
  /** Empties the store (`forget: true`), its freed pages wiped. */
  forget(): void;
  close(): void;
}

/**
 * Opens the store. `records` are the sources' terms: an `ids-only` source's
 * text is never written, and a `ttl-hours` source's is blank once expired.
 */
export function openJobsStore(path: string, records: ReadonlyMap<string, JobSourceRecord>): JobsStore {
  const db = openDomainStore(path, JOBS_MIGRATIONS);
  // What `forget` and expiry remove is overwritten, not left in free pages a backup copies.
  db.exec("PRAGMA secure_delete = ON");
  const cacheOf = (source: string): JobSourceRecord["terms"]["cache"] | undefined => records.get(source)?.terms.cache;
  /** Whether a source's terms keep no text, or no longer keep this text. */
  const textGone = (source: string, fetchedAt: string, now: string): boolean => {
    const cache = cacheOf(source);
    return (
      cache?.mode === "ids-only" ||
      cache?.mode === "none" ||
      (cache?.mode === "ttl-hours" && Date.parse(now) - Date.parse(fetchedAt) > cache.hours * 3_600_000)
    );
  };
  const statements = {
    byId: db.prepare("SELECT * FROM postings WHERE posting_id = ?"),
    byUrl: db.prepare("SELECT cluster_id FROM postings WHERE canonical_url = ? LIMIT 1"),
    byUrlId: db.prepare("SELECT posting_id FROM postings WHERE canonical_url = ? AND removed_at IS NULL LIMIT 1"),
    byAts: db.prepare("SELECT cluster_id FROM postings WHERE ats_key = ? LIMIT 1"),
    byFingerprint: db.prepare("SELECT cluster_id, source, record FROM postings WHERE fingerprint = ? LIMIT 20"),
    insert: db.prepare(
      "INSERT INTO postings (posting_id, cluster_id, source, source_ref, canonical_url, ats_key, fingerprint, record, description, fetched_at, first_seen, last_seen, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    ),
    update: db.prepare(
      "UPDATE postings SET canonical_url = ?, ats_key = ?, fingerprint = ?, record = ?, description = ?, fetched_at = ?, last_seen = ?, removed_at = NULL WHERE posting_id = ?",
    ),
    remove: db.prepare("UPDATE postings SET removed_at = ? WHERE posting_id = ? AND removed_at IS NULL"),
    application: db.prepare("SELECT * FROM applications WHERE cluster_id = ?"),
    putApplication: db.prepare(
      "INSERT INTO applications (cluster_id, posting_id, state, history, note, staged_at, applied_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (cluster_id) DO UPDATE SET posting_id = excluded.posting_id, state = excluded.state, history = excluded.history, note = excluded.note, staged_at = excluded.staged_at, applied_at = excluded.applied_at, updated_at = excluded.updated_at",
    ),
    log: db.prepare("INSERT INTO fetch_log (source, host, at, status, bytes, keywords) VALUES (?, ?, ?, ?, ?, ?)"),
    trimLog: db.prepare("DELETE FROM fetch_log WHERE id <= (SELECT id FROM fetch_log ORDER BY id DESC LIMIT 1 OFFSET ?)"),
    retained: db.prepare("SELECT posting_id, cluster_id, source, record, description, fetched_at, last_seen FROM postings"),
    delete: db.prepare("DELETE FROM postings WHERE posting_id = ?"),
    blank: db.prepare("UPDATE postings SET description = '', record = ? WHERE posting_id = ?"),
    deleteBands: db.prepare("DELETE FROM minhash WHERE posting_id = ?"),
    setMinhash: db.prepare("UPDATE postings SET minhash = ? WHERE posting_id = ?"),
    putBand: db.prepare("INSERT OR IGNORE INTO minhash (band, posting_id) VALUES (?, ?)"),
    byBand: db.prepare(
      "SELECT p.posting_id, p.cluster_id, p.record, p.minhash FROM minhash m JOIN postings p ON p.posting_id = m.posting_id WHERE m.band = ? LIMIT 20",
    ),
    clusterFirstSeen: db.prepare("SELECT min(first_seen) AS first FROM postings WHERE cluster_id = ?"),
    watch: db.prepare("SELECT * FROM watches WHERE watch_id = ?"),
    watches: db.prepare("SELECT * FROM watches ORDER BY created_at"),
    due: db.prepare("SELECT * FROM watches WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at"),
    putWatch: db.prepare(
      "INSERT INTO watches (watch_id, name, input, enabled, next_run_at, last_run_at, last_outcome, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (watch_id) DO UPDATE SET name = excluded.name, input = excluded.input, enabled = excluded.enabled, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at",
    ),
    swept: db.prepare("UPDATE watches SET last_run_at = ?, last_outcome = ?, next_run_at = ? WHERE watch_id = ?"),
    deleteWatch: db.prepare("DELETE FROM watches WHERE watch_id = ?"),
    deleteWatchHits: db.prepare("DELETE FROM hits WHERE watch_id = ?"),
    putHit: db.prepare(
      "INSERT OR IGNORE INTO hits (watch_id, cluster_id, posting_id, score, first_seen, delivered_at) VALUES (?, ?, ?, ?, ?, NULL)",
    ),
    hitsSince: db.prepare("SELECT * FROM hits WHERE watch_id = ? AND first_seen > ? ORDER BY first_seen DESC, score DESC LIMIT ?"),
    // Hits not yet told come first, so a sweep with more than a page of hits is told them all over the next collections.
    allHitsSince: db.prepare(
      "SELECT * FROM hits WHERE first_seen > ? ORDER BY (delivered_at IS NULL) DESC, first_seen DESC, score DESC LIMIT ?",
    ),
    delivered: db.prepare("UPDATE hits SET delivered_at = ? WHERE watch_id = ? AND cluster_id = ? AND delivered_at IS NULL"),
  };

  const stored = (row: Row, now: string): StoredPosting => {
    const posting = JobPostingSchema.parse(JSON.parse(String(row["record"])));
    const gone = textGone(posting.source, String(row["fetched_at"]), now);
    return {
      posting: gone ? { ...posting, excerpt: "" } : posting,
      description: gone ? "" : String(row["description"] ?? ""),
      firstSeen: String(row["first_seen"]),
      lastSeen: String(row["last_seen"]),
      removed: row["removed_at"] !== null,
    };
  };
  const application = (row: Row): Application => ({
    clusterId: String(row["cluster_id"]),
    postingId: String(row["posting_id"]),
    state: String(row["state"]) as JobApplicationState,
    history: JSON.parse(String(row["history"])) as Application["history"],
    note: String(row["note"] ?? ""),
    ...(text(row["staged_at"]) === undefined ? {} : { stagedAt: String(row["staged_at"]) }),
    ...(text(row["applied_at"]) === undefined ? {} : { appliedAt: String(row["applied_at"]) }),
    updatedAt: String(row["updated_at"]),
  });
  const sourceHealth = createSourceHealth(db);
  /**
   * A posting this one repeats by fingerprint: the same job reposted, or seen
   * on another source. Never another posting on the same board, and never one
   * with a different requisition: those are two openings, which an
   * application to one must not mark applied for the other.
   */
  const repostOf = (posting: JobPosting, fingerprint: string): Row | undefined =>
    (statements.byFingerprint.all(fingerprint) as Row[]).find((row) => {
      const other = JobPostingSchema.parse(JSON.parse(String(row["record"])));
      if (other.source === posting.source && other.tenant === posting.tenant) return false;
      return other.reqId === undefined || posting.reqId === undefined || other.reqId === posting.reqId;
    });
  /**
   * A posting this one repeats by its description (MinHash): the same
   * ad, from the same company, at an estimated Jaccard of 0.8 or more: a
   * repost under a new id on its own board too. Never one with a different
   * requisition, as for a fingerprint.
   */
  const nearDuplicateOf = (posting: JobPosting, signature: readonly number[]): Row | undefined => {
    const company = companyKey(posting.company);
    if (company === "") return undefined;
    for (const band of minhashBands(signature)) {
      for (const row of statements.byBand.all(band) as Row[]) {
        if (row["posting_id"] === posting.postingId) continue;
        const other = JobPostingSchema.parse(JSON.parse(String(row["record"])));
        if (!sameCompany(companyKey(other.company), company)) continue;
        if (other.reqId !== undefined && posting.reqId !== undefined && other.reqId !== posting.reqId) continue;
        if (minhashSimilarity(signature, JSON.parse(String(row["minhash"])) as number[]) >= MINHASH_JOIN) return row;
      }
    }
    return undefined;
  };
  /**
   * Whether two company keys name one company, for a description that already
   * matches: equal, equal without spaces (a board's slug, "muttdata", for
   * "Mutt Data"), or one the start of the other ("fieldwire" for "Fieldwire by
   * Hilti", "vannevar" for "Vannevar Labs"), four letters or more.
   */
  const sameCompany = (a: string, b: string): boolean => {
    const [x, y] = [a.replace(/ /g, ""), b.replace(/ /g, "")];
    if (x === y) return x !== "";
    const [short, long] = x.length <= y.length ? [x, y] : [y, x];
    return short.length >= 4 && long.startsWith(short);
  };
  const keepSignature = (postingId: string, signature: readonly number[] | undefined): void => {
    if (signature === undefined) return;
    statements.setMinhash.run(JSON.stringify(signature), postingId);
    for (const band of minhashBands(signature)) statements.putBand.run(band, postingId);
  };
  /** A posting's flags with the ghost flags its cluster's history earns, in `JOB_FLAGS` order. */
  const withGhostFlags = (flags: readonly JobFlag[], clusterFirstSeen: string | undefined, reposted: boolean, now: string): JobFlag[] => {
    const all = new Set(flags);
    const age = clusterFirstSeen === undefined ? 0 : Date.parse(now) - Date.parse(clusterFirstSeen);
    if (reposted && age >= GHOST_REPOST_DAYS * DAY_MS) all.add("ghost:reposted");
    if (age >= GHOST_EVERGREEN_DAYS * DAY_MS) all.add("ghost:evergreen");
    return JOB_FLAGS.filter((flag) => all.has(flag));
  };
  const firstSeenOf = (clusterId: string): string | undefined =>
    text((statements.clusterFirstSeen.get(clusterId) as Row | undefined)?.["first"]);
  const watchOf = (row: Row): JobWatch => {
    const input = JobWatchInputSchema.parse(JSON.parse(String(row["input"])));
    return {
      ...input,
      watchId: String(row["watch_id"]),
      enabled: Number(row["enabled"]) === 1,
      nextRunAt: String(row["next_run_at"]),
      ...(text(row["last_run_at"]) === undefined ? {} : { lastRunAt: String(row["last_run_at"]) }),
      ...(text(row["last_outcome"]) === undefined ? {} : { lastOutcome: String(row["last_outcome"]) }),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
    };
  };
  const hitOf = (row: Row): JobHit => ({
    watchId: String(row["watch_id"]),
    clusterId: String(row["cluster_id"]),
    postingId: String(row["posting_id"]),
    score: Number(row["score"]),
    firstSeen: String(row["first_seen"]),
    ...(text(row["delivered_at"]) === undefined ? {} : { deliveredAt: String(row["delivered_at"]) }),
  });
  const watchOrThrow = (watchId: string): JobWatch => {
    const row = statements.watch.get(watchId) as Row | undefined;
    if (row === undefined) throw new Error(`no watch ${watchId}`);
    return watchOf(row);
  };
  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    db,
    upsert: (postings, now) =>
      transaction(() =>
        postings.map(({ posting, description }) => {
          const url = canonicalUrl(posting.url);
          const ats = posting.reqId === undefined ? null : `${posting.source}:${posting.tenant ?? ""}:${posting.reqId}`;
          const fingerprint = fingerprintOf(posting);
          // A source whose terms keep no text has none written.
          const noText = cacheOf(posting.source)?.mode === "ids-only" || cacheOf(posting.source)?.mode === "none";
          // Its signature is made before any text is dropped: it holds no words.
          const signature = minhashOf(description);
          const record = (clusterId: string, flags: readonly JobFlag[]): JobPosting => ({
            ...posting,
            clusterId,
            flags: [...flags],
            ...(noText ? { excerpt: "" } : {}),
          });
          const existing = statements.byId.get(posting.postingId) as Row | undefined;
          if (existing !== undefined) {
            const clusterId = String(existing["cluster_id"]);
            // A repost stays one: the flag was earned when it joined.
            const wasReposted = JobPostingSchema.parse(JSON.parse(String(existing["record"]))).flags.includes("ghost:reposted");
            const kept = record(
              clusterId,
              withGhostFlags([...posting.flags, ...(wasReposted ? (["ghost:reposted"] as const) : [])], firstSeenOf(clusterId), false, now),
            );
            statements.update.run(url, ats, fingerprint, JSON.stringify(kept), noText ? "" : description, now, now, posting.postingId);
            if (existing["minhash"] === null) keepSignature(posting.postingId, signature);
            return kept;
          }
          const same =
            (statements.byUrl.get(url) as Row | undefined) ?? (ats === null ? undefined : (statements.byAts.get(ats) as Row | undefined));
          // Joined by what it says rather than where it lives: the same job posted again.
          const repeated =
            same === undefined
              ? (repostOf(posting, fingerprint) ?? (signature === undefined ? undefined : nearDuplicateOf(posting, signature)))
              : undefined;
          const joined = same ?? repeated;
          const clusterId = joined === undefined ? posting.postingId : String(joined["cluster_id"]);
          const kept = record(
            clusterId,
            withGhostFlags(posting.flags, joined === undefined ? undefined : firstSeenOf(clusterId), repeated !== undefined, now),
          );
          statements.insert.run(
            posting.postingId,
            kept.clusterId,
            posting.source,
            posting.sourceRef,
            url,
            ats,
            fingerprint,
            JSON.stringify(kept),
            noText ? "" : description,
            now,
            now,
            now,
          );
          keepSignature(posting.postingId, signature);
          return kept;
        }),
      ),
    get: (postingId, now) => {
      const row = statements.byId.get(postingId) as Row | undefined;
      return row === undefined ? undefined : stored(row, now);
    },
    findByUrl: (url) => text((statements.byUrlId.get(canonicalUrl(url)) as Row | undefined)?.["posting_id"]),
    many: (postingIds, now) =>
      postingIds
        .map((id) => statements.byId.get(id) as Row | undefined)
        .filter((row): row is Row => row !== undefined && row["removed_at"] === null)
        .map((row) => stored(row, now)),
    remove: (postingIds, now) =>
      transaction(() => {
        for (const id of postingIds) statements.remove.run(now, id);
      }),
    track: ({ postingId, state, note, actor }, now) =>
      transaction(() => {
        if (!(JOB_APPLICATION_STATES as readonly string[]).includes(state)) throw new Error(`${state} is not an application state`);
        const row = statements.byId.get(postingId) as Row | undefined;
        if (row === undefined) throw new Error(`no posting ${postingId}: search or get it first`);
        const clusterId = String(row["cluster_id"]);
        const previous = statements.application.get(clusterId) as Row | undefined;
        const known = previous === undefined ? undefined : application(previous);
        const history = [...(known?.history ?? []), { state, at: now, actor }].slice(-50);
        const stagedAt = state === "staged" ? now : known?.stagedAt;
        const appliedAt = state === "applied" ? now : known?.appliedAt;
        statements.putApplication.run(
          clusterId,
          postingId,
          state,
          JSON.stringify(history),
          (note ?? known?.note ?? "").slice(0, 500),
          stagedAt ?? null,
          appliedAt ?? null,
          now,
        );
        return application(statements.application.get(clusterId) as Row);
      }),
    applications: (states) => {
      const rows = db.prepare("SELECT * FROM applications ORDER BY updated_at DESC").all() as Row[];
      return rows.map(application).filter((each) => states === undefined || states.length === 0 || states.includes(each.state));
    },
    counts: () => {
      const counts = Object.fromEntries(JOB_APPLICATION_STATES.map((state) => [state, 0])) as Record<JobApplicationState, number>;
      for (const row of db.prepare("SELECT state, count(*) AS n FROM applications GROUP BY state").all() as Row[])
        counts[String(row["state"]) as JobApplicationState] = Number(row["n"]);
      return counts;
    },
    ...sourceHealth,
    log: (entry) => {
      statements.log.run(entry.source, entry.host, entry.at, entry.status, entry.bytes, entry.keywords.slice(0, 200));
      statements.trimLog.run(FETCH_LOG_KEEP);
    },
    recentFetches: (limit) =>
      (db.prepare("SELECT source, host, at, status, bytes, keywords FROM fetch_log ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(
        (row) => ({
          source: String(row["source"]),
          host: String(row["host"]),
          at: String(row["at"]),
          status: Number(row["status"]),
          bytes: Number(row["bytes"]),
          keywords: String(row["keywords"]),
        }),
      ),
    retain: (now) =>
      transaction(() => {
        const nowMs = Date.parse(now);
        const pipeline = new Set(
          (db.prepare("SELECT cluster_id FROM applications").all() as Row[]).map((row) => String(row["cluster_id"])),
        );
        let deleted = 0;
        let blanked = 0;
        for (const row of statements.retained.all() as Row[]) {
          const id = String(row["posting_id"]);
          const source = String(row["source"]);
          const kept = pipeline.has(String(row["cluster_id"]));
          const cache = cacheOf(source);
          const keepDays = cache?.mode === "ttl" ? Math.min(cache.days, POSTING_KEEP_DAYS) : cache?.mode === "none" ? 0 : POSTING_KEEP_DAYS;
          const seenMs = Date.parse(String(row["last_seen"]));
          if (!kept && nowMs - seenMs > keepDays * DAY_MS) {
            statements.delete.run(id);
            statements.deleteBands.run(id);
            deleted += 1;
            continue;
          }
          // Its text goes, its identifiers, title, company and link stay.
          if (!textGone(source, String(row["fetched_at"]), now) && (kept || nowMs - seenMs <= DESCRIPTION_KEEP_DAYS * DAY_MS)) continue;
          const posting = JobPostingSchema.parse(JSON.parse(String(row["record"])));
          if (String(row["description"]) === "" && posting.excerpt === "") continue;
          statements.blank.run(JSON.stringify({ ...posting, excerpt: "" }), id);
          blanked += 1;
        }
        // A hit whose posting is gone goes with it.
        db.exec("DELETE FROM hits WHERE posting_id NOT IN (SELECT posting_id FROM postings)");
        return { deleted, blanked };
      }),
    createWatch: (input, now) => {
      const parsed = JobWatchInputSchema.parse(input);
      const watchId = `w-${randomUUID().slice(0, 8)}`;
      statements.putWatch.run(watchId, parsed.name, JSON.stringify(parsed), 1, now, null, null, now, now);
      return watchOrThrow(watchId);
    },
    updateWatch: (watchId, change, now) => {
      const known = watchOrThrow(watchId);
      const input = change.input === undefined ? undefined : JobWatchInputSchema.parse(change.input);
      const cadenceChanged = input !== undefined && input.cadence !== known.cadence;
      const enabled = change.enabled ?? known.enabled;
      // Resumed, or given a new cadence: due from now, so a long pause does not wait out its old time.
      const nextRunAt = (change.enabled === true && !known.enabled) || cadenceChanged ? now : known.nextRunAt;
      const next =
        input ??
        JobWatchInputSchema.parse({
          name: known.name,
          query: known.query,
          criteria: known.criteria,
          cadence: known.cadence,
          minScore: known.minScore,
          ...(known.digest === undefined ? {} : { digest: known.digest }),
        });
      statements.putWatch.run(watchId, next.name, JSON.stringify(next), enabled ? 1 : 0, nextRunAt, null, null, known.createdAt, now);
      return watchOrThrow(watchId);
    },
    removeWatch: (watchId) =>
      transaction(() => {
        statements.deleteWatchHits.run(watchId);
        return Number(statements.deleteWatch.run(watchId).changes) > 0;
      }),
    watch: (watchId) => {
      const row = statements.watch.get(watchId) as Row | undefined;
      return row === undefined ? undefined : watchOf(row);
    },
    watches: () => (statements.watches.all() as Row[]).map(watchOf),
    dueWatches: (now) => (statements.due.all(now) as Row[]).map(watchOf),
    sweptWatch: (watchId, outcome, now, nextRunAt) => {
      statements.swept.run(now, outcome.slice(0, 200), nextRunAt, watchId);
    },
    addHits: (watchId, hits, now) =>
      transaction(() =>
        hits
          .filter((hit) => Number(statements.putHit.run(watchId, hit.clusterId, hit.postingId, hit.score, now).changes) > 0)
          .map((hit) => ({ watchId, clusterId: hit.clusterId, postingId: hit.postingId, score: hit.score, firstSeen: now })),
      ),
    hitsSince: (watchId, since) => (statements.hitsSince.all(watchId, since, HITS_MAX) as Row[]).map(hitOf),
    deliverHits: (since, now, limit) =>
      transaction(() => {
        const hits = (statements.allHitsSince.all(since, Math.min(limit, HITS_MAX)) as Row[]).map(hitOf);
        for (const hit of hits) if (hit.deliveredAt === undefined) statements.delivered.run(now, hit.watchId, hit.clusterId);
        return hits;
      }),
    forget: () => {
      transaction(() => {
        for (const table of ["postings", "applications", "source_health", "budgets", "fetch_log", "minhash", "watches", "hits"])
          db.exec(`DELETE FROM ${table}`);
      });
      db.exec("VACUUM");
    },
    close: () => db.close(),
  };
}
