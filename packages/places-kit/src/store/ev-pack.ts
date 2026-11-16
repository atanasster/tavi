import type { DatabaseSync } from "node:sqlite";

import { openDomainStore } from "@tavi/domain-kit";

import { CandidateSchema } from "../contracts.js";
import { boxAround, distanceKm } from "../geo.js";
import type { Connector, EvRead } from "../sources/ev.js";

/**
 * Germany's charging register as a pack: one month's file in its
 * own SQLite under the worker's `home/cache/`, out of backups, built again
 * when a newer month is out. Written as the file streams in, so its 55 MB
 * never sits in memory.
 */
const EV_PACK_V1 = `
CREATE TABLE pack (release TEXT NOT NULL, built_at TEXT NOT NULL, sites INTEGER NOT NULL) STRICT;
CREATE TABLE sites (id TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, record TEXT NOT NULL) STRICT;
CREATE INDEX sites_lat ON sites (lat);
`;
const EV_PACK_MIGRATIONS = [{ version: 1, sql: EV_PACK_V1 }];

export interface EvPackWriter {
  add(site: EvRead): void;
  /** Records the release and closes; answers how many sites it holds. */
  finish(release: string, builtAt: string): number;
  /** Leaves the file unfinished: the caller removes it. */
  abort(): void;
}

export function writeEvPack(path: string): EvPackWriter {
  const db = openDomainStore(path, EV_PACK_MIGRATIONS);
  db.exec("BEGIN IMMEDIATE");
  const insert = db.prepare("INSERT OR IGNORE INTO sites (id, lat, lon, record) VALUES (?, ?, ?, ?)");
  let sites = 0;
  return {
    add: (site) => {
      sites += Number(insert.run(site.candidate.sourceId, site.candidate.lat, site.candidate.lon, JSON.stringify(site)).changes);
    },
    finish: (release, builtAt) => {
      db.prepare("INSERT INTO pack (release, built_at, sites) VALUES (?, ?, ?)").run(release, builtAt, sites);
      db.exec("COMMIT");
      db.close();
      return sites;
    },
    abort: () => {
      db.exec("ROLLBACK");
      db.close();
    },
  };
}

export interface EvPack {
  readonly release: string;
  readonly sites: number;
  /** Sites within `radiusKm` with any of `connectors` (all, without), nearest first. */
  near(
    point: { readonly lat: number; readonly lon: number },
    radiusKm: number,
    connectors: readonly Connector[] | undefined,
    limit: number,
  ): EvRead[];
  close(): void;
}

export function openEvPack(path: string): EvPack {
  const db: DatabaseSync = openDomainStore(path, EV_PACK_MIGRATIONS);
  const row = db.prepare("SELECT release, sites FROM pack LIMIT 1").get() as
    | { readonly release: string; readonly sites: number }
    | undefined;
  if (row === undefined) {
    db.close();
    throw new Error("the charging register pack is empty: build it again");
  }
  const inBox = db.prepare("SELECT record FROM sites WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?");
  return {
    release: row.release,
    sites: Number(row.sites),
    near: (point, radiusKm, connectors, limit) => {
      const box = boxAround(point, radiusKm);
      return (inBox.all(box.south, box.north, box.west, box.east) as { readonly record: string }[])
        .map((each) => JSON.parse(each.record) as EvRead)
        .map((site) => ({ ...site, candidate: CandidateSchema.parse(site.candidate) }))
        .filter(
          (site) =>
            distanceKm(point, site.candidate) <= radiusKm &&
            (connectors === undefined || connectors.length === 0 || site.connectors.some((connector) => connectors.includes(connector))),
        )
        .sort((a, b) => distanceKm(point, a.candidate) - distanceKm(point, b.candidate))
        .slice(0, limit);
    },
    close: () => db.close(),
  };
}
