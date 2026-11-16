import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { FuelHit, FuelWatch } from "../contracts.js";

/**
 * Fuel watches in `places.db`: what the person approved, when each
 * runs next, and the stations it found under its threshold, each told to the
 * heartbeat once.
 */

type Row = Record<string, unknown>;
const watchOf = (row: Row): FuelWatch => ({
  watchId: String(row["watch_id"]),
  area: JSON.parse(String(row["area"])) as FuelWatch["area"],
  fuel: String(row["fuel"]) as FuelWatch["fuel"],
  threshold: Number(row["threshold"]),
  currency: String(row["currency"]),
  cadenceHours: Number(row["cadence_hours"]),
  enabled: Number(row["enabled"]) === 1,
  createdAt: String(row["created_at"]),
  ...(row["last_run_at"] === null ? {} : { lastRunAt: String(row["last_run_at"]) }),
  ...(row["last_outcome"] === null ? {} : { lastOutcome: String(row["last_outcome"]) }),
  nextRunAt: String(row["next_run_at"]),
});
const hitOf = (row: Row): FuelHit => ({
  watchId: String(row["watch_id"]),
  stationKey: String(row["station_key"]),
  price: Number(row["price"]),
  currency: String(row["currency"]),
  station: String(row["station"]),
  reportedAt: String(row["reported_at"]),
  firstSeen: String(row["first_seen"]),
});

/** Watches one workspace keeps at most. */
export const WATCHES_MAX = 20;

export function openWatchStore(db: DatabaseSync) {
  const statements = {
    insert: db.prepare(
      "INSERT INTO watches (watch_id, area, fuel, threshold, currency, cadence_hours, enabled, created_at, updated_at, next_run_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
    ),
    update: db.prepare(
      "UPDATE watches SET fuel = ?, threshold = ?, currency = ?, cadence_hours = ?, enabled = ?, updated_at = ?, next_run_at = ? WHERE watch_id = ?",
    ),
    remove: db.prepare("DELETE FROM watches WHERE watch_id = ?"),
    get: db.prepare("SELECT * FROM watches WHERE watch_id = ?"),
    all: db.prepare("SELECT * FROM watches ORDER BY created_at"),
    due: db.prepare("SELECT * FROM watches WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at"),
    swept: db.prepare("UPDATE watches SET last_run_at = ?, last_outcome = ?, next_run_at = ? WHERE watch_id = ?"),
    hit: db.prepare(
      "INSERT OR IGNORE INTO hits (watch_id, station_key, price, currency, station, reported_at, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    since: db.prepare("SELECT * FROM hits WHERE watch_id = ? AND first_seen > ? ORDER BY first_seen DESC, price LIMIT 50"),
    undelivered: db.prepare("SELECT * FROM hits WHERE delivered_at IS NULL AND first_seen > ? ORDER BY first_seen DESC LIMIT ?"),
    deliver: db.prepare("UPDATE hits SET delivered_at = ? WHERE watch_id = ? AND station_key = ? AND price = ?"),
    clearWatch: db.prepare("DELETE FROM hits WHERE watch_id = ?"),
    clearStation: db.prepare("DELETE FROM hits WHERE watch_id = ? AND station_key = ?"),
    prune: db.prepare("DELETE FROM hits WHERE first_seen < ?"),
  };
  return {
    watches: (): FuelWatch[] => (statements.all.all() as Row[]).map(watchOf),
    watch: (watchId: string): FuelWatch | undefined => {
      const row = statements.get.get(watchId) as Row | undefined;
      return row === undefined ? undefined : watchOf(row);
    },
    /** A new watch, due at once; refused past `WATCHES_MAX`. */
    add: (
      watch: Omit<FuelWatch, "watchId" | "enabled" | "createdAt" | "nextRunAt" | "lastRunAt" | "lastOutcome">,
      now: string,
    ): FuelWatch => {
      if ((statements.all.all() as Row[]).length >= WATCHES_MAX)
        throw new Error(`at most ${String(WATCHES_MAX)} watches: remove one first`);
      const watchId = `fw_${createHash("sha256")
        .update(`${now}|${JSON.stringify(watch)}`)
        .digest("hex")
        .slice(0, 12)}`;
      statements.insert.run(
        watchId,
        JSON.stringify(watch.area),
        watch.fuel,
        watch.threshold,
        watch.currency,
        watch.cadenceHours,
        now,
        now,
        now,
      );
      return watchOf(statements.get.get(watchId) as Row);
    },
    change: (
      watchId: string,
      change: Partial<Pick<FuelWatch, "fuel" | "threshold" | "currency" | "cadenceHours" | "enabled">>,
      now: string,
    ): FuelWatch => {
      const known = watchOf(statements.get.get(watchId) as Row);
      // Hits found under the old terms say nothing of the new ones.
      if (
        (change.fuel !== undefined && change.fuel !== known.fuel) ||
        (change.threshold !== undefined && change.threshold !== known.threshold) ||
        (change.currency !== undefined && change.currency !== known.currency)
      )
        statements.clearWatch.run(watchId);
      // A change runs at once: the person wants to know under the new terms.
      statements.update.run(
        change.fuel ?? known.fuel,
        change.threshold ?? known.threshold,
        change.currency ?? known.currency,
        change.cadenceHours ?? known.cadenceHours,
        (change.enabled ?? known.enabled) ? 1 : 0,
        now,
        now,
        watchId,
      );
      return watchOf(statements.get.get(watchId) as Row);
    },
    remove: (watchId: string): boolean => Number(statements.remove.run(watchId).changes) > 0,
    due: (now: string): FuelWatch[] => (statements.due.all(now) as Row[]).map(watchOf),
    swept: (watchId: string, outcome: string, at: string, next: string): void =>
      void statements.swept.run(at, outcome.slice(0, 300), next, watchId),
    /** Stations found under the threshold; one already seen at the same price is not new. Answers how many were new. */
    addHits: (watchId: string, hits: readonly Omit<FuelHit, "watchId" | "firstSeen">[], now: string): number =>
      hits.reduce(
        (count, hit) =>
          count +
          Number(
            statements.hit.run(watchId, hit.stationKey, hit.price, hit.currency, hit.station.slice(0, 200), hit.reportedAt, now).changes,
          ),
        0,
      ),
    /** Stations a sweep read above the threshold: a later drop under it is news again. */
    clearStations: (watchId: string, stationKeys: readonly string[]): void => {
      for (const key of stationKeys) statements.clearStation.run(watchId, key);
    },
    /** Drops hits first seen before `before`. */
    prune: (before: string): number => Number(statements.prune.run(before).changes),
    hitsSince: (watchId: string, since: string): FuelHit[] => (statements.since.all(watchId, since) as Row[]).map(hitOf),
    /** Hits since `since` not yet told to the heartbeat, at most `limit`, marked told. */
    deliver: (since: string, now: string, limit: number): FuelHit[] => {
      const hits = (statements.undelivered.all(since, limit) as Row[]).map(hitOf);
      for (const hit of hits) statements.deliver.run(now, hit.watchId, hit.stationKey, hit.price);
      return hits;
    },
  };
}
export type WatchStore = ReturnType<typeof openWatchStore>;
