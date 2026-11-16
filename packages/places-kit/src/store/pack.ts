import type { DatabaseSync } from "node:sqlite";

import { openDomainStore } from "@tavi/domain-kit";

import { CandidateSchema, type Candidate } from "../contracts.js";
import { boxAround, distanceKm, type BoundingBox } from "../geo.js";
import { planMatches, type QueryPlan } from "../sources/categories.js";

/**
 * An Overture area pack: one area's places from one release, in
 * its own SQLite file under the worker's `home/cache/` (kept out of
 * backups), read-only once built. Losing it loses nothing: it is built again.
 */
const PACK_V1 = `
CREATE TABLE pack (
  release TEXT NOT NULL,
  south REAL NOT NULL, west REAL NOT NULL, north REAL NOT NULL, east REAL NOT NULL,
  built_at TEXT NOT NULL,
  places INTEGER NOT NULL
) STRICT;
CREATE TABLE places (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  record TEXT NOT NULL
) STRICT;
CREATE INDEX places_lat ON places (lat);
`;
const PACK_MIGRATIONS = [{ version: 1, sql: PACK_V1 }];

export interface PackMeta {
  readonly release: string;
  readonly box: BoundingBox;
  readonly builtAt: string;
  readonly places: number;
}

export interface OverturePack {
  readonly meta: PackMeta;
  /** The pack's places within `radiusKm` that answer `plan`, nearest first. */
  near(point: { readonly lat: number; readonly lon: number }, radiusKm: number, plan: QueryPlan, limit: number): Candidate[];
  close(): void;
}

/** Writes a new pack at `path` and answers how many places it holds (a place listed twice is kept once); the caller builds into a new file and renames it. */
export function writeOverturePack(path: string, meta: Omit<PackMeta, "places">, candidates: readonly Candidate[]): number {
  const db = openDomainStore(path, PACK_MIGRATIONS);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = db.prepare("INSERT OR IGNORE INTO places (id, lat, lon, record) VALUES (?, ?, ?, ?)");
      let places = 0;
      for (const candidate of candidates)
        places += Number(insert.run(candidate.sourceId, candidate.lat, candidate.lon, JSON.stringify(candidate)).changes);
      db.prepare("INSERT INTO pack (release, south, west, north, east, built_at, places) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        meta.release,
        meta.box.south,
        meta.box.west,
        meta.box.north,
        meta.box.east,
        meta.builtAt,
        places,
      );
      db.exec("COMMIT");
      return places;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export function openOverturePack(path: string): OverturePack {
  const db: DatabaseSync = openDomainStore(path, PACK_MIGRATIONS);
  const row = db.prepare("SELECT * FROM pack LIMIT 1").get() as Record<string, unknown> | undefined;
  if (row === undefined) {
    db.close();
    throw new Error("the area pack is empty: build it again");
  }
  const meta: PackMeta = {
    release: String(row["release"]),
    box: { south: Number(row["south"]), west: Number(row["west"]), north: Number(row["north"]), east: Number(row["east"]) },
    builtAt: String(row["built_at"]),
    places: Number(row["places"]),
  };
  const inBox = db.prepare("SELECT record FROM places WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?");
  return {
    meta,
    near: (point, radiusKm, plan, limit) => {
      const box = boxAround(point, radiusKm);
      return (inBox.all(box.south, box.north, box.west, box.east) as { readonly record: string }[])
        .map((each) => CandidateSchema.parse(JSON.parse(each.record)))
        .filter((candidate) => distanceKm(point, candidate) <= radiusKm && planMatches(plan, candidate))
        .sort((a, b) => distanceKm(point, a) - distanceKm(point, b))
        .slice(0, limit);
    },
    close: () => db.close(),
  };
}
