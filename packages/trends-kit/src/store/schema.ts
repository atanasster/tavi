import { BUDGETS_TABLE_SQL, type DomainMigration } from "@tavi/domain-kit";

/**
 * `home/trends.db`: tracked topics, their count series, every
 * spike test with its arithmetic, sweep progress, each source's health and
 * budget, and Wikidata's names for a topic, kept 30 days (CC0). Backed up with the person's plugin data.
 */
const TRENDS_DB_SCHEMA = `
CREATE TABLE topics (
  topic_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  input TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'quiet',
  state_since TEXT,
  quiet_sweeps INTEGER NOT NULL DEFAULT 0,
  quiet_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX topics_scope ON topics (principal_id, workspace_id);

CREATE TABLE series (
  topic_id TEXT NOT NULL REFERENCES topics (topic_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  bucket_seconds INTEGER NOT NULL CHECK (bucket_seconds IN (3600, 86400)),
  bucket_start TEXT NOT NULL,
  value REAL NOT NULL CHECK (value >= 0),
  quality TEXT NOT NULL CHECK (quality IN ('ok', 'approximate', 'partial', 'missing')),
  norm REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, source_id, metric, bucket_seconds, bucket_start)
) STRICT, WITHOUT ROWID;
CREATE INDEX series_age ON series (bucket_seconds, bucket_start);

CREATE TABLE tests (
  topic_id TEXT NOT NULL REFERENCES topics (topic_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  at TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (topic_id, source_id, at)
) STRICT, WITHOUT ROWID;
CREATE INDEX tests_at ON tests (at);

CREATE TABLE sweeps (
  topic_id TEXT PRIMARY KEY REFERENCES topics (topic_id) ON DELETE CASCADE,
  last_sweep_at TEXT,
  sources_done TEXT NOT NULL DEFAULT '{}',
  last_outcome TEXT
) STRICT;

CREATE TABLE source_health (
  source TEXT PRIMARY KEY,
  last_success TEXT,
  last_failure TEXT,
  last_class TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  drift_count INTEGER NOT NULL DEFAULT 0,
  disabled_until TEXT,
  calls_today INTEGER NOT NULL DEFAULT 0,
  day TEXT
) STRICT;

${BUDGETS_TABLE_SQL}

CREATE TABLE wikidata_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
`;

export const TRENDS_MIGRATIONS: readonly DomainMigration[] = [{ version: 1, sql: TRENDS_DB_SCHEMA }];

/**
 * `home/cache/items.db`: the items sweeps and searches read, kept
 * only for their source's cache window (a day where the source must honour
 * deletions) and never copied into a backup. Authors exist only as a hash
 * salted per day, so no person can be followed across days: `seen_authors`
 * holds the names of the authors a read saw (the id or handle it gave, and a
 * Bluesky handle beside its DID), each only as a hash under the day's salt,
 * kept for the day, so `watch` refuses a term that is one of them.
 */
const ITEMS_DB_SCHEMA = `
CREATE TABLE items (
  item_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('adapter', 'agent')),
  topic_id TEXT,
  item_set TEXT,
  url TEXT NOT NULL,
  outlet TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  language TEXT,
  author_hash TEXT,
  metrics TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX items_expiry ON items (expires_at);
CREATE INDEX items_topic ON items (topic_id, fetched_at);
CREATE INDEX items_set ON items (item_set);

CREATE TABLE salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
) STRICT;

CREATE TABLE seen_authors (
  name_hash TEXT PRIMARY KEY,
  day TEXT NOT NULL
) STRICT;
`;

export const ITEMS_MIGRATIONS: readonly DomainMigration[] = [{ version: 1, sql: ITEMS_DB_SCHEMA }];
