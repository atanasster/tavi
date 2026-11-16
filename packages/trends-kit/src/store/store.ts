import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { SOURCE_PAUSE_FAILURES, SOURCE_PAUSE_MS, openDomainStore } from "@tavi/domain-kit";

export { SOURCE_PAUSE_MS } from "@tavi/domain-kit";

import {
  BUCKET_SECONDS,
  TopicInputSchema,
  type Bucket,
  type CountQuality,
  type Topic,
  type TopicInput,
  type TopicScope,
  type TopicState,
} from "../contracts.js";
import { TRENDS_MIGRATIONS } from "./schema.js";

/** Hourly buckets are kept this long, then folded into days. */
export const HOURLY_RETENTION_DAYS = 35;
/** Daily buckets are kept this long at most; a source's `seriesMaxDays` shortens it. */
export const DAILY_RETENTION_DAYS = 400;
/** Spike tests are kept this long. */
export const TESTS_RETENTION_DAYS = 35;
/** Topics one principal tracks in one workspace. */
export const TOPICS_MAX = 50;
/** Consecutive failures that pause a source, and for how long: the domain kits' shared values. */
export const FAILURES_TO_PAUSE = SOURCE_PAUSE_FAILURES;
/** A day's calls before its drift rate can pause a source: above half of them drifting does. */
export const DRIFT_MIN_CALLS = 4;

const DAY_MS = 86_400_000;

/** The start of the `bucket` holding `iso`, as ISO UTC. */
export function bucketStart(iso: string, bucket: Bucket): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`not a time: ${iso}`);
  const width = BUCKET_SECONDS[bucket] * 1_000;
  return new Date(ms - (((ms % width) + width) % width)).toISOString();
}

/** `iso` in the one form the store keeps times in, so they compare as strings. */
function isoOf(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`not a time: ${iso}`);
  return new Date(ms).toISOString();
}

/** One bucket of one series, as the store keeps it. */
export interface SeriesPoint {
  readonly topicId: string;
  readonly sourceId: string;
  /** What is counted: `stories`, `views`, `authors`, `uses`… */
  readonly metric: string;
  readonly bucket: Bucket;
  readonly start: string;
  readonly value: number;
  readonly quality: CountQuality;
  readonly norm?: number;
}

/** What went wrong with a source's last read: the class `sources` shows. */
export const HEALTH_CLASSES = ["ok", "auth", "quota", "blocked", "schema", "network"] as const;
export type HealthClass = (typeof HEALTH_CLASSES)[number];

export interface SourceHealth {
  readonly lastSuccess?: string;
  readonly lastFailure?: string;
  readonly lastClass: HealthClass;
  readonly consecutiveFailures: number;
  /** Today's answers whose shape the adapter could not read. */
  readonly driftCount: number;
  readonly disabledUntil?: string;
  readonly callsToday: number;
}

export interface SweepProgress {
  readonly lastSweepAt?: string;
  /** When each source was last read for the topic: a sweep round-robins the oldest first. */
  readonly sourcesDone: Readonly<Record<string, string>>;
  readonly lastOutcome?: string;
}

type TopicRow = {
  topic_id: string;
  principal_id: string;
  workspace_id: string;
  input: string;
  paused: number;
  state: string;
  state_since: string | null;
  quiet_sweeps: number;
  quiet_since: string | null;
  created_at: string;
  updated_at: string;
};

const topicOf = (row: TopicRow): Topic => ({
  ...TopicInputSchema.parse(JSON.parse(row.input)),
  topicId: row.topic_id,
  principalId: row.principal_id,
  workspaceId: row.workspace_id,
  paused: row.paused === 1,
  state: row.state as TopicState,
  ...(row.state_since === null ? {} : { stateSince: row.state_since }),
  quietSweeps: row.quiet_sweeps,
  ...(row.quiet_since === null ? {} : { quietSince: row.quiet_since }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** `trends.db`, opened and migrated by the shared domain-store runner. */
export function openTrendsStore(path: string) {
  const db: DatabaseSync = openDomainStore(path, TRENDS_MIGRATIONS);
  const inScope = (topicId: string, scope: TopicScope): Topic => {
    const row = db
      .prepare("SELECT * FROM topics WHERE topic_id = ? AND principal_id = ? AND workspace_id = ?")
      .get(topicId, scope.principalId, scope.workspaceId) as TopicRow | undefined;
    if (row === undefined) throw new Error(`no topic ${topicId}`);
    return topicOf(row);
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

  const sweepOf = (topicId: string): SweepProgress => {
    const row = db.prepare("SELECT last_sweep_at, sources_done, last_outcome FROM sweeps WHERE topic_id = ?").get(topicId) as
      | { last_sweep_at: string | null; sources_done: string; last_outcome: string | null }
      | undefined;
    return {
      sourcesDone: row === undefined ? {} : (JSON.parse(row.sources_done) as Record<string, string>),
      ...(row?.last_sweep_at == null ? {} : { lastSweepAt: row.last_sweep_at }),
      ...(row?.last_outcome == null ? {} : { lastOutcome: row.last_outcome }),
    };
  };

  const healthOf = (source: string, now: string): SourceHealth => {
    const row = db.prepare("SELECT * FROM source_health WHERE source = ?").get(source) as
      | {
          last_success: string | null;
          last_failure: string | null;
          last_class: string | null;
          consecutive_failures: number;
          drift_count: number;
          disabled_until: string | null;
          calls_today: number;
          day: string | null;
        }
      | undefined;
    if (row === undefined) return { lastClass: "ok", consecutiveFailures: 0, driftCount: 0, callsToday: 0 };
    return {
      ...(row.last_success === null ? {} : { lastSuccess: row.last_success }),
      ...(row.last_failure === null ? {} : { lastFailure: row.last_failure }),
      lastClass: (row.last_class ?? "ok") as HealthClass,
      consecutiveFailures: row.consecutive_failures,
      driftCount: row.day === now.slice(0, 10) ? row.drift_count : 0,
      ...(row.disabled_until === null ? {} : { disabledUntil: row.disabled_until }),
      callsToday: row.day === now.slice(0, 10) ? row.calls_today : 0,
    };
  };

  return {
    db,

    createTopic(scope: TopicScope, input: TopicInput, now: string): Topic {
      const parsed = TopicInputSchema.parse(input);
      const count = (
        db
          .prepare("SELECT COUNT(*) AS n FROM topics WHERE principal_id = ? AND workspace_id = ?")
          .get(scope.principalId, scope.workspaceId) as { n: number }
      ).n;
      if (count >= TOPICS_MAX) throw new Error(`at most ${String(TOPICS_MAX)} topics are tracked; remove one first`);
      const topicId = `t_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      db.prepare("INSERT INTO topics (topic_id, principal_id, workspace_id, input, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        topicId,
        scope.principalId,
        scope.workspaceId,
        JSON.stringify(parsed),
        now,
        now,
      );
      return inScope(topicId, scope);
    },

    updateTopic(topicId: string, scope: TopicScope, input: TopicInput, now: string): Topic {
      inScope(topicId, scope);
      db.prepare("UPDATE topics SET input = ?, updated_at = ? WHERE topic_id = ?").run(
        JSON.stringify(TopicInputSchema.parse(input)),
        now,
        topicId,
      );
      return inScope(topicId, scope);
    },

    setPaused(topicId: string, scope: TopicScope, paused: boolean, now: string): Topic {
      inScope(topicId, scope);
      db.prepare("UPDATE topics SET paused = ?, updated_at = ? WHERE topic_id = ?").run(paused ? 1 : 0, now, topicId);
      return inScope(topicId, scope);
    },

    removeTopic(topicId: string, scope: TopicScope): boolean {
      inScope(topicId, scope);
      return db.prepare("DELETE FROM topics WHERE topic_id = ?").run(topicId).changes > 0;
    },

    topic: inScope,

    topics(scope: TopicScope): Topic[] {
      return (
        db
          .prepare("SELECT * FROM topics WHERE principal_id = ? AND workspace_id = ? ORDER BY created_at, topic_id")
          .all(scope.principalId, scope.workspaceId) as TopicRow[]
      ).map(topicOf);
    },

    /** Every principal's active topics: a heartbeat sweep reads them all. */
    activeTopics(): Topic[] {
      return (db.prepare("SELECT * FROM topics WHERE paused = 0 ORDER BY created_at, topic_id").all() as TopicRow[]).map(topicOf);
    },

    /** A topic's state after a sweep, and since when it has held it (an unchanged state keeps its `since`). */
    setState(
      topicId: string,
      memory: { readonly state: TopicState; readonly quietSweeps: number; readonly quietSince?: string },
      now: string,
    ): void {
      db.prepare(
        "UPDATE topics SET state = ?, state_since = CASE WHEN state = ? THEN state_since ELSE ? END, quiet_sweeps = ?, quiet_since = ? WHERE topic_id = ?",
      ).run(memory.state, memory.state, now, memory.quietSweeps, memory.quietSince ?? null, topicId);
    },

    putSeries(points: readonly SeriesPoint[], now: string): number {
      const write =
        db.prepare(`INSERT INTO series (topic_id, source_id, metric, bucket_seconds, bucket_start, value, quality, norm, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (topic_id, source_id, metric, bucket_seconds, bucket_start) DO UPDATE SET value = excluded.value, quality = excluded.quality, norm = excluded.norm, updated_at = excluded.updated_at`);
      transaction(() => {
        for (const point of points) {
          if (!Number.isFinite(point.value) || point.value < 0)
            throw new Error(`a count is a number of at least 0, not ${String(point.value)}`);
          write.run(
            point.topicId,
            point.sourceId,
            point.metric,
            BUCKET_SECONDS[point.bucket],
            bucketStart(point.start, point.bucket),
            point.value,
            point.quality,
            point.norm ?? null,
            now,
          );
        }
      });
      return points.length;
    },

    /** A topic's series between `from` (inclusive) and `to` (exclusive), oldest first. */
    series(
      topicId: string,
      bucket: Bucket,
      from: string,
      to: string,
      filter: { readonly sourceId?: string; readonly metric?: string } = {},
    ): SeriesPoint[] {
      const rows = db
        .prepare(`SELECT source_id, metric, bucket_start, value, quality, norm FROM series WHERE topic_id = ? AND bucket_seconds = ? AND bucket_start >= ? AND bucket_start < ?
        ${filter.sourceId === undefined ? "" : "AND source_id = ?"} ${filter.metric === undefined ? "" : "AND metric = ?"} ORDER BY source_id, metric, bucket_start`)
        .all(
          topicId,
          BUCKET_SECONDS[bucket],
          isoOf(from),
          isoOf(to),
          ...(filter.sourceId === undefined ? [] : [filter.sourceId]),
          ...(filter.metric === undefined ? [] : [filter.metric]),
        ) as { source_id: string; metric: string; bucket_start: string; value: number; quality: CountQuality; norm: number | null }[];
      return rows.map((row) => ({
        topicId,
        sourceId: row.source_id,
        metric: row.metric,
        bucket,
        start: row.bucket_start,
        value: row.value,
        quality: row.quality,
        ...(row.norm === null ? {} : { norm: row.norm }),
      }));
    },

    recordTest(topicId: string, sourceId: string, at: string, result: Readonly<Record<string, unknown>>): void {
      db.prepare(
        "INSERT INTO tests (topic_id, source_id, at, result) VALUES (?, ?, ?, ?) ON CONFLICT (topic_id, source_id, at) DO UPDATE SET result = excluded.result",
      ).run(topicId, sourceId, at, JSON.stringify(result));
    },

    /** The newest test of each source for a topic. */
    latestTests(topicId: string): { readonly sourceId: string; readonly at: string; readonly result: Record<string, unknown> }[] {
      const rows = db
        .prepare(
          "SELECT t.source_id, t.at, t.result FROM tests t WHERE t.topic_id = ? AND t.at = (SELECT MAX(at) FROM tests u WHERE u.topic_id = t.topic_id AND u.source_id = t.source_id) ORDER BY t.source_id",
        )
        .all(topicId) as { source_id: string; at: string; result: string }[];
      return rows.map((row) => ({ sourceId: row.source_id, at: row.at, result: JSON.parse(row.result) as Record<string, unknown> }));
    },

    sweep: sweepOf,

    sweptSource(topicId: string, sourceId: string, at: string): void {
      const done = { ...sweepOf(topicId).sourcesDone, [sourceId]: at };
      db.prepare(
        "INSERT INTO sweeps (topic_id, sources_done) VALUES (?, ?) ON CONFLICT (topic_id) DO UPDATE SET sources_done = excluded.sources_done",
      ).run(topicId, JSON.stringify(done));
    },

    sweptTopic(topicId: string, at: string, outcome: string): void {
      db.prepare(
        "INSERT INTO sweeps (topic_id, last_sweep_at, last_outcome) VALUES (?, ?, ?) ON CONFLICT (topic_id) DO UPDATE SET last_sweep_at = excluded.last_sweep_at, last_outcome = excluded.last_outcome",
      ).run(topicId, at, outcome.slice(0, 500));
    },

    health: healthOf,

    /**
     * A read's outcome: a success clears the failures; a failure counts, and the
     * fifth in a row, or a pause the source asked for (a 429's wait), pauses it.
     */
    recordOutcome(
      source: string,
      outcome: { readonly ok: true } | { readonly ok: false; readonly class: Exclude<HealthClass, "ok">; readonly pauseUntil?: string },
      at: string,
    ): void {
      const before = healthOf(source, at);
      const calls = before.callsToday + 1;
      const day = at.slice(0, 10);
      if (outcome.ok) {
        db.prepare(`INSERT INTO source_health (source, last_success, last_class, consecutive_failures, drift_count, calls_today, day) VALUES (?, ?, 'ok', 0, ?, ?, ?)
          ON CONFLICT (source) DO UPDATE SET last_success = excluded.last_success, last_class = 'ok', consecutive_failures = 0, drift_count = excluded.drift_count, calls_today = excluded.calls_today, day = excluded.day`).run(
          source,
          at,
          before.driftCount,
          calls,
          day,
        );
        return;
      }
      const failures = before.consecutiveFailures + 1;
      const drift = before.driftCount + (outcome.class === "schema" ? 1 : 0);
      // A source whose answers drift more often than not today (of at least four) has changed: pause it too.
      const drifting = outcome.class === "schema" && calls >= DRIFT_MIN_CALLS && drift * 2 > calls;
      const paused =
        outcome.pauseUntil ??
        (failures >= FAILURES_TO_PAUSE || drifting ? new Date(Date.parse(at) + SOURCE_PAUSE_MS).toISOString() : before.disabledUntil);
      db.prepare(`INSERT INTO source_health (source, last_failure, last_class, consecutive_failures, drift_count, disabled_until, calls_today, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source) DO UPDATE SET last_failure = excluded.last_failure, last_class = excluded.last_class, consecutive_failures = excluded.consecutive_failures, drift_count = excluded.drift_count, disabled_until = excluded.disabled_until, calls_today = excluded.calls_today, day = excluded.day`).run(
        source,
        at,
        outcome.class,
        failures,
        drift,
        paused ?? null,
        calls,
        day,
      );
    },

    /**
     * Keeps the store within its terms: hourly buckets past 35 days are
     * folded into days, days past a source's `seriesMaxDays` (400 at most) and
     * tests past 35 days go.
     */
    retain(now: string, seriesMaxDays: Readonly<Record<string, number>> = {}): void {
      const nowMs = Date.parse(now);
      // Whole days only: a day is folded once, with every hour it has.
      const hourlyCutoff = bucketStart(new Date(nowMs - HOURLY_RETENTION_DAYS * DAY_MS).toISOString(), "day");
      transaction(() => {
        // A day sums the hours read; a missing hour adds nothing and, like an hour never written, makes the day partial.
        db.prepare(`INSERT INTO series (topic_id, source_id, metric, bucket_seconds, bucket_start, value, quality, norm, updated_at)
          SELECT topic_id, source_id, metric, 86400, substr(bucket_start, 1, 10) || 'T00:00:00.000Z', SUM(CASE WHEN quality <> 'missing' THEN value ELSE 0 END),
            CASE WHEN SUM(quality = 'missing') = COUNT(*) THEN 'missing' WHEN COUNT(*) < 24 OR SUM(quality <> 'ok') > 0 THEN 'partial' ELSE 'ok' END,
            CASE WHEN COUNT(norm) = COUNT(*) THEN SUM(norm) END, ?
          FROM series WHERE bucket_seconds = 3600 AND bucket_start < ? GROUP BY topic_id, source_id, metric, substr(bucket_start, 1, 10)
          ON CONFLICT (topic_id, source_id, metric, bucket_seconds, bucket_start) DO NOTHING`).run(now, hourlyCutoff);
        db.prepare("DELETE FROM series WHERE bucket_seconds = 3600 AND bucket_start < ?").run(hourlyCutoff);
        db.prepare("DELETE FROM series WHERE bucket_seconds = 86400 AND bucket_start < ?").run(
          new Date(nowMs - DAILY_RETENTION_DAYS * DAY_MS).toISOString(),
        );
        for (const [source, days] of Object.entries(seriesMaxDays)) {
          if (days < DAILY_RETENTION_DAYS)
            db.prepare("DELETE FROM series WHERE source_id = ? AND bucket_start < ?").run(
              source,
              new Date(nowMs - days * DAY_MS).toISOString(),
            );
        }
        db.prepare("DELETE FROM tests WHERE at < ?").run(new Date(nowMs - TESTS_RETENTION_DAYS * DAY_MS).toISOString());
        db.prepare("DELETE FROM wikidata_cache WHERE expires_at <= ?").run(now);
      });
    },

    /** A cached Wikidata answer, while it is fresh. */
    wikidata(key: string, now: string): unknown {
      const row = db.prepare("SELECT value FROM wikidata_cache WHERE key = ? AND expires_at > ?").get(key, now) as
        | { value: string }
        | undefined;
      return row === undefined ? undefined : JSON.parse(row.value);
    },

    putWikidata(key: string, value: unknown, now: string, ttlMs: number): void {
      db.prepare(
        "INSERT INTO wikidata_cache (key, value, fetched_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
      ).run(key, JSON.stringify(value), now, new Date(Date.parse(now) + ttlMs).toISOString());
    },

    /** Empties the store (the operator's `forget`). */
    forget(): void {
      db.exec(
        "BEGIN IMMEDIATE; DELETE FROM topics; DELETE FROM series; DELETE FROM tests; DELETE FROM sweeps; DELETE FROM source_health; DELETE FROM budgets; DELETE FROM wikidata_cache; COMMIT;",
      );
    },

    close(): void {
      db.close();
    },
  };
}

export type TrendsStore = ReturnType<typeof openTrendsStore>;
