import { BUDGETS_TABLE_SQL, SOURCE_HEALTH_TABLE_SQL } from "@tavi/domain-kit";

/**
 * `places.db`: OSM elements
 * fetched for the person (ODbL, kept apart as a Collective Database), resolved
 * places, every source's id for each, each source's health and budget, the
 * outbound log with coarsened areas only, and fuel watches with their hits (a
 * watch's area as it was geocoded when the person added it). In the
 * worker's home, so it is backed up (backups leave only `home/cache/` out).
 */
export const PLACES_DB_SCHEMA = `
CREATE TABLE osm_elements (
  osm_id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  tags TEXT NOT NULL,
  fetched_at TEXT NOT NULL
) STRICT;
CREATE INDEX osm_elements_lat ON osm_elements (lat);

CREATE TABLE entities (
  place_id TEXT PRIMARY KEY,
  record TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  resolved_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;
CREATE INDEX entities_lat ON entities (lat);

CREATE TABLE ids (
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (source, external_id)
) STRICT;
CREATE INDEX ids_place ON ids (place_id);

${SOURCE_HEALTH_TABLE_SQL}

${BUDGETS_TABLE_SQL}

CREATE TABLE request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  host TEXT NOT NULL,
  at TEXT NOT NULL,
  status INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  country TEXT,
  precision_decimals INTEGER,
  lat REAL,
  lon REAL
) STRICT;

CREATE TABLE watches (
  watch_id TEXT PRIMARY KEY,
  area TEXT NOT NULL,
  fuel TEXT NOT NULL,
  threshold REAL NOT NULL,
  currency TEXT NOT NULL,
  cadence_hours INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  last_outcome TEXT,
  next_run_at TEXT NOT NULL
) STRICT;
CREATE TABLE hits (
  watch_id TEXT NOT NULL REFERENCES watches (watch_id) ON DELETE CASCADE,
  station_key TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  station TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (watch_id, station_key, price)
) STRICT;
CREATE INDEX hits_first_seen ON hits (first_seen);
`;
