import { BUDGETS_TABLE_SQL, SOURCE_HEALTH_TABLE_SQL } from "@tavi/domain-kit";

/**
 * `jobs.db`: postings and their clusters, each posting's MinHash
 * signature with its band keys for near-duplicate lookup, the person's
 * applications, their watches and those watches' hits, each source's health and
 * budget, and the outbound log. In the worker's home, so it is backed up with
 * the person's pipeline (backups leave only `home/cache/` out).
 */
export const JOBS_DB_SCHEMA = `
CREATE TABLE postings (
  posting_id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  ats_key TEXT,
  fingerprint TEXT NOT NULL,
  record TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  removed_at TEXT,
  minhash TEXT
) STRICT;
CREATE INDEX postings_cluster ON postings (cluster_id);
CREATE INDEX postings_url ON postings (canonical_url);
CREATE INDEX postings_ats ON postings (ats_key);
CREATE INDEX postings_fingerprint ON postings (fingerprint);
CREATE INDEX postings_last_seen ON postings (last_seen);

CREATE TABLE applications (
  cluster_id TEXT PRIMARY KEY,
  posting_id TEXT NOT NULL,
  state TEXT NOT NULL,
  history TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  staged_at TEXT,
  applied_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

${SOURCE_HEALTH_TABLE_SQL}

${BUDGETS_TABLE_SQL}

CREATE TABLE fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  host TEXT NOT NULL,
  at TEXT NOT NULL,
  status INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  keywords TEXT NOT NULL DEFAULT ''
) STRICT;

CREATE TABLE minhash (
  band TEXT NOT NULL,
  posting_id TEXT NOT NULL,
  PRIMARY KEY (band, posting_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX minhash_posting ON minhash (posting_id);

CREATE TABLE watches (
  watch_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  input TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE hits (
  watch_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  posting_id TEXT NOT NULL,
  score REAL NOT NULL,
  first_seen TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (watch_id, cluster_id)
) STRICT;
CREATE INDEX hits_first_seen ON hits (first_seen);
`;
