import type { DatabaseSync } from "node:sqlite";

import { createSourceHealth, openDomainStore, type SourceHealthLedger } from "@tavi/domain-kit";

export { SOURCE_PAUSE_FAILURES, SOURCE_PAUSE_MS, type SourceHealth } from "@tavi/domain-kit";

import { PlaceSchema, type Place, type PlacesSourceRecord } from "../contracts.js";
import { boxAround } from "../geo.js";
import { PLACES_MIGRATIONS } from "./migrations.js";

/**
 * The places store. What each source's terms allow decides what is
 * kept (`terms.cache`): a place is stored only when every source in it may be
 * kept, and until the shortest of their times; a source that keeps only ids
 * leaves its id and nothing else. Nothing the model relayed is written here.
 */

const REQUEST_LOG_KEEP = 500;
const DAY_MS = 86_400_000;

/** One outbound request as `sources` shows it: its source, host and status, and the area only as coarse as it was sent. */
export interface RequestLogEntry {
  readonly source: string;
  readonly host: string;
  readonly at: string;
  readonly status: number;
  readonly bytes: number;
  readonly country?: string | undefined;
  readonly precisionDecimals?: number | undefined;
  readonly roundedLatLon?: { readonly lat: number; readonly lon: number } | undefined;
}

export interface OsmElement {
  readonly osmId: string;
  readonly lat: number;
  readonly lon: number;
  readonly tags: Readonly<Record<string, string>>;
}

export interface PlacesStore extends SourceHealthLedger {
  readonly db: DatabaseSync;
  /** OSM elements as fetched, kept apart from other sources' data. */
  putOsm(elements: readonly OsmElement[], now: string): void;
  osmNear(point: { readonly lat: number; readonly lon: number }, radiusKm: number): OsmElement[];
  /** Places, kept only as their sources' terms allow; each source's id recorded, unless its terms keep nothing. A place keeps an id it was stored under before. */
  putPlaces(
    places: readonly Place[],
    now: string,
  ): { readonly stored: number; readonly idsOnly: number; readonly places: readonly Place[] };
  place(placeId: string, now: string): Place | undefined;
  placesNear(point: { readonly lat: number; readonly lon: number }, radiusKm: number, now: string): Place[];
  /** The place a source's own id was resolved into, if any. */
  placeIdOf(source: string, externalId: string): string | undefined;
  log(entry: RequestLogEntry): void;
  recentRequests(limit: number): RequestLogEntry[];
  /** Deletes what has outlived its sources' terms. */
  retain(now: string): { readonly deleted: number };
  /** Empties the store, its freed pages wiped. */
  forget(): void;
  close(): void;
}

type Row = Record<string, unknown>;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** The latest a place may be kept, by its sources' terms: `null` for no limit, `undefined` when it may not be kept at all. */
export function placeExpiry(place: Place, records: ReadonlyMap<string, PlacesSourceRecord>, now: string): string | null | undefined {
  let expires: number | null = null;
  for (const source of Object.keys(place.ids)) {
    const cache = records.get(source)?.terms.cache;
    // A source with no record (a relayed one) is never kept.
    if (cache === undefined || cache.mode === "none" || cache.mode === "ids-only") return undefined;
    const ms = cache.mode === "ttl" ? cache.days * DAY_MS : cache.mode === "ttl-hours" ? cache.hours * 3_600_000 : undefined;
    if (ms !== undefined) expires = Math.min(expires ?? Number.POSITIVE_INFINITY, Date.parse(now) + ms);
  }
  return expires === null ? null : new Date(expires).toISOString();
}

export function openPlacesStore(path: string, records: ReadonlyMap<string, PlacesSourceRecord>): PlacesStore {
  const db = openDomainStore(path, PLACES_MIGRATIONS);
  db.exec("PRAGMA secure_delete = ON");
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
  const statements = {
    putOsm: db.prepare(
      "INSERT INTO osm_elements (osm_id, lat, lon, tags, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (osm_id) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, tags = excluded.tags, fetched_at = excluded.fetched_at",
    ),
    osmBox: db.prepare("SELECT osm_id, lat, lon, tags FROM osm_elements WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 2000"),
    putEntity: db.prepare(
      "INSERT INTO entities (place_id, record, lat, lon, resolved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (place_id) DO UPDATE SET record = excluded.record, lat = excluded.lat, lon = excluded.lon, resolved_at = excluded.resolved_at, expires_at = excluded.expires_at",
    ),
    entity: db.prepare("SELECT record, expires_at FROM entities WHERE place_id = ?"),
    deleteEntity: db.prepare("DELETE FROM entities WHERE place_id = ?"),
    entityBox: db.prepare("SELECT record, expires_at FROM entities WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 2000"),
    putId: db.prepare(
      "INSERT INTO ids (source, external_id, place_id, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (source, external_id) DO UPDATE SET place_id = excluded.place_id, seen_at = excluded.seen_at",
    ),
    idOf: db.prepare("SELECT place_id FROM ids WHERE source = ? AND external_id = ?"),
    log: db.prepare(
      "INSERT INTO request_log (source, host, at, status, bytes, country, precision_decimals, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    trimLog: db.prepare("DELETE FROM request_log WHERE id <= (SELECT id FROM request_log ORDER BY id DESC LIMIT 1 OFFSET ?)"),
    expired: db.prepare("DELETE FROM entities WHERE expires_at IS NOT NULL AND expires_at <= ?"),
  };
  const live = (row: Row | undefined, now: string): Place | undefined => {
    if (row === undefined) return undefined;
    const expires = text(row["expires_at"]);
    if (expires !== undefined && Date.parse(expires) <= Date.parse(now)) return undefined;
    return PlaceSchema.parse(JSON.parse(String(row["record"])));
  };
  const sourceHealth = createSourceHealth(db);
  const box = (point: { readonly lat: number; readonly lon: number }, radiusKm: number) => {
    const bounds = boxAround(point, radiusKm);
    return [bounds.south, bounds.north, bounds.west, bounds.east] as const;
  };
  return {
    db,
    putOsm: (elements, now) =>
      transaction(() => {
        for (const element of elements) statements.putOsm.run(element.osmId, element.lat, element.lon, JSON.stringify(element.tags), now);
      }),
    osmNear: (point, radiusKm) =>
      (statements.osmBox.all(...box(point, radiusKm)) as Row[]).map((row) => ({
        osmId: String(row["osm_id"]),
        lat: Number(row["lat"]),
        lon: Number(row["lon"]),
        tags: JSON.parse(String(row["tags"])) as Record<string, string>,
      })),
    putPlaces: (places, now) =>
      transaction(() => {
        let stored = 0;
        let idsOnly = 0;
        const kept: Place[] = [];
        for (const resolved of places) {
          // A place keeps the id an earlier resolution gave it through any of its sources' ids; a stale copy under another id goes.
          const earlier = [
            ...new Set(
              Object.entries(resolved.ids)
                .map(([source, externalId]) => text((statements.idOf.get(source, externalId) as Row | undefined)?.["place_id"]))
                .filter((id): id is string => id !== undefined),
            ),
          ];
          const placeId = earlier[0] ?? resolved.placeId;
          const place = placeId === resolved.placeId ? resolved : { ...resolved, placeId };
          for (const stale of earlier.slice(1)) statements.deleteEntity.run(stale);
          kept.push(place);
          const expiry = placeExpiry(place, records, now);
          for (const [source, externalId] of Object.entries(place.ids)) {
            const mode = records.get(source)?.terms.cache.mode;
            // A source with no record (relayed) or whose terms keep nothing leaves no trace, not even its id.
            if (mode !== undefined && mode !== "none") statements.putId.run(source, externalId, place.placeId, now);
          }
          if (expiry === undefined) {
            idsOnly += 1;
            continue;
          }
          // Whether it is open is the asking call's time, never a fact to keep: a later read would show it as current.
          const timeless = place.hours === undefined ? place : { ...place, hours: { ...place.hours, openNow: "unknown" as const } };
          statements.putEntity.run(place.placeId, JSON.stringify(timeless), place.location.lat, place.location.lon, now, expiry);
          stored += 1;
        }
        return { stored, idsOnly, places: kept };
      }),
    place: (placeId, now) => live(statements.entity.get(placeId) as Row | undefined, now),
    placesNear: (point, radiusKm, now) =>
      (statements.entityBox.all(...box(point, radiusKm)) as Row[])
        .map((row) => live(row, now))
        .filter((place): place is Place => place !== undefined),
    placeIdOf: (source, externalId) => text((statements.idOf.get(source, externalId) as Row | undefined)?.["place_id"]),
    ...sourceHealth,
    log: (entry) => {
      statements.log.run(
        entry.source,
        entry.host,
        entry.at,
        entry.status,
        entry.bytes,
        entry.country ?? null,
        entry.precisionDecimals ?? null,
        entry.roundedLatLon?.lat ?? null,
        entry.roundedLatLon?.lon ?? null,
      );
      statements.trimLog.run(REQUEST_LOG_KEEP);
    },
    recentRequests: (limit) =>
      (db.prepare("SELECT * FROM request_log ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((row) => ({
        source: String(row["source"]),
        host: String(row["host"]),
        at: String(row["at"]),
        status: Number(row["status"]),
        bytes: Number(row["bytes"]),
        ...(text(row["country"]) === undefined ? {} : { country: String(row["country"]) }),
        ...(row["precision_decimals"] === null ? {} : { precisionDecimals: Number(row["precision_decimals"]) }),
        ...(row["lat"] === null || row["lon"] === null ? {} : { roundedLatLon: { lat: Number(row["lat"]), lon: Number(row["lon"]) } }),
      })),
    retain: (now) => ({ deleted: Number(statements.expired.run(now).changes) }),
    forget: () => {
      transaction(() => {
        // A watch holds the person's area: forgetting empties it with the rest.
        for (const table of ["osm_elements", "entities", "ids", "source_health", "budgets", "request_log", "hits", "watches"])
          db.exec(`DELETE FROM ${table}`);
      });
      db.exec("VACUUM");
    },
    close: () => db.close(),
  };
}
