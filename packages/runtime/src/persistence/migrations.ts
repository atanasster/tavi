import { TaviError } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";

import { BASELINE_SCHEMA } from "./baseline-schema.js";
import { PROFILE_FORMAT, PROFILE_FORMAT_KEY } from "./profile-format.js";
import type { Database } from "./sqlite-loader.js";

/**
 * Application schema migrations.
 *
 *  - every application table and index is prefixed `tavi_`;
 *  - the pinned LangGraph saver owns `checkpoints` and `writes` and is never
 *    touched by an application migration;
 *  - migrations are forward-only, recorded in `tavi_schema_migrations`, and run
 *    inside a transaction so a failed step leaves no partial schema;
 *  - a shipped migration is never amended: a change is a new entry
 *    appended to `MIGRATIONS`, with the schema snapshot regenerated
 *    (`packages/runtime/test/schema-snapshot.test.ts`).
 *
 * `0001_baseline` creates the whole schema of the first public release
 * (`baseline-schema.ts`). A directory made by the development chain it replaced
 * carries an older profile format and is refused before migrating
 * (`profile-validation.ts`).
 */

export interface Migration {
  readonly id: string;
  readonly up: (db: Database) => void;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_baseline",
    up: (db) => {
      for (const statement of BASELINE_SCHEMA) db.exec(statement);
      // The profile format commits with the first tables, so a directory is never
      // a schema without its format (`assertProfileFormat`).
      db.prepare("INSERT INTO tavi_meta (key, value, updated_at) VALUES (?, ?, ?)").run(PROFILE_FORMAT_KEY, PROFILE_FORMAT, nowTimestamp());
      // The install's one onboarding row, which the repository only ever updates.
      db.exec("INSERT INTO tavi_onboarding (id) VALUES (1)");
    },
  },
  {
    // A connection may speak Anthropic's own Messages API (`anthropic-messages`), not only an OpenAI-compatible one.
    // SQLite cannot change a CHECK in place: the table is rebuilt with the same columns and rows.
    id: "0002_anthropic_messages_connections",
    up: (db) => {
      db.exec(`CREATE TABLE tavi_model_connections_rebuilt (
  connection_id  TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('openai-compatible', 'anthropic-messages')),
  base_url       TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  default_model  TEXT,
  headers_json   TEXT,
  local_only     INTEGER NOT NULL DEFAULT 0 CHECK (local_only IN (0, 1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  provider_binding_json TEXT,
  pdf_input TEXT CHECK (pdf_input IS NULL OR pdf_input IN ('none', 'openai-file')),
  pdf_engine TEXT CHECK (pdf_engine IS NULL OR pdf_engine IN ('pdf-text', 'mistral-ocr', 'native')),
  video_models TEXT CHECK (video_models IS NULL OR json_valid(video_models)),
  wire_api TEXT CHECK (wire_api IS NULL OR wire_api IN ('chat', 'responses'))
)`);
      const columns =
        "connection_id, label, kind, base_url, credential_ref, default_model, headers_json, local_only, created_at, updated_at, provider_binding_json, pdf_input, pdf_engine, video_models, wire_api";
      db.exec(`INSERT INTO tavi_model_connections_rebuilt (${columns}) SELECT ${columns} FROM tavi_model_connections`);
      db.exec("DROP TABLE tavi_model_connections");
      db.exec("ALTER TABLE tavi_model_connections_rebuilt RENAME TO tavi_model_connections");
    },
  },
  {
    // What a task's summary was written from (`summary_input_hash`): a pass over the same words keeps it unasked.
    id: "0003_task_summary_input_hash",
    up: (db) => {
      db.exec("ALTER TABLE tavi_tasks ADD COLUMN summary_input_hash TEXT");
    },
  },
  {
    // Porter-stemmed companion FTS5 table alongside `tavi_memory_fts`, sharing `tavi_memory_fts_map` rowids.
    id: "0004_memory_fts_stem",
    up: (db) => {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS tavi_memory_fts_stem USING fts5(
  title,
  body,
  tokenize = "porter unicode61 remove_diacritics 2"
)`);
      db.exec("DELETE FROM tavi_memory_fts_stem");
      db.exec("INSERT INTO tavi_memory_fts_stem(rowid, title, body) SELECT rowid, title, body FROM tavi_memory_fts");
    },
  },
  {
    // Write-time keywords on `tavi_memory_revisions`, indexed in a third `keys` column on `tavi_memory_fts` and `tavi_memory_fts_stem`.
    id: "0005_memory_fts_keywords",
    up: (db) => {
      const revisionColumns = (db.prepare("SELECT name FROM pragma_table_info('tavi_memory_revisions')").all() as { name: string }[]).map(
        (row) => row.name,
      );
      if (revisionColumns.length > 0 && !revisionColumns.includes("keywords_json")) {
        db.exec("ALTER TABLE tavi_memory_revisions ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]'");
      }
      db.exec("DROP TABLE IF EXISTS tavi_memory_fts");
      db.exec("DROP TABLE IF EXISTS tavi_memory_fts_stem");
      db.exec(`CREATE VIRTUAL TABLE tavi_memory_fts USING fts5(
  title,
  body,
  keys,
  tokenize = "unicode61 remove_diacritics 2"
)`);
      db.exec(`CREATE VIRTUAL TABLE tavi_memory_fts_stem USING fts5(
  title,
  body,
  keys,
  tokenize = "porter unicode61 remove_diacritics 2"
)`);
      db.exec(`INSERT INTO tavi_memory_fts(rowid, title, body, keys)
        SELECT m.row_id,
               COALESCE(v.title, ''),
               COALESCE(v.body, ''),
               COALESCE((SELECT group_concat(value, ' ') FROM json_each(v.keywords_json)), '')
          FROM tavi_memory_fts_map m
          JOIN tavi_memory_revisions v ON v.revision_id = m.revision_id`);
      db.exec(`INSERT INTO tavi_memory_fts_stem(rowid, title, body, keys)
        SELECT rowid, title, body, keys FROM tavi_memory_fts`);
    },
  },
  {
    // FTS5 `secure-delete` on both memory indexes (memory invariant 9): a deleted row's tokens are erased from the
    // `*_data` segment blobs at once, not left there until a merge, where `VACUUM INTO` backups would carry them.
    // The option is stored in each table's `*_config`, so it holds across reopen and `rebuildSearchIndex` (which
    // deletes rows, never drops the tables). The one `optimize` merges away what earlier deletes left behind.
    id: "0006_memory_fts_secure_delete",
    up: (db) => {
      for (const table of ["tavi_memory_fts", "tavi_memory_fts_stem"]) {
        db.exec(`INSERT INTO ${table}(${table}, rank) VALUES('secure-delete', 1)`);
        db.exec(`INSERT INTO ${table}(${table}) VALUES('optimize')`);
      }
    },
  },
  {
    // Whether a person marked a site's recipe to replay (`tavi browser recipes --replay`): kept across restarts.
    id: "0007_site_recipe_replay",
    up: (db) => {
      db.exec("ALTER TABLE tavi_site_recipes ADD COLUMN replay INTEGER NOT NULL DEFAULT 0 CHECK (replay IN (0, 1))");
    },
  },
  {
    // A skill version belongs to its workspace: the key was `(skill_id, version)`, so one workspace could approve,
    // activate or collide with another's version. Both tables are rebuilt together because the activation's foreign
    // key must name the new key. An activation that pointed across workspaces had no version of its own: it is dropped.
    id: "0008_skill_versions_scoped",
    up: (db) => {
      db.exec(`CREATE TABLE tavi_skill_versions_rebuilt (
  skill_id             TEXT NOT NULL,
  version               TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  parent_version         TEXT,
  scope_key              TEXT NOT NULL,
  manifest_json           TEXT NOT NULL,
  supported_runtime_versions_json TEXT NOT NULL DEFAULT '[]',
  supported_tool_contract_versions_json TEXT NOT NULL DEFAULT '[]',
  provenance             TEXT NOT NULL,
  review_state            TEXT NOT NULL CHECK (review_state IN ('proposed','approved','rejected')),
  package_artifact_id     TEXT NOT NULL REFERENCES tavi_artifacts(artifact_id),
  imported_by             TEXT NOT NULL,
  imported_at             TEXT NOT NULL,
  reviewed_by             TEXT,
  reviewed_at             TEXT,
  PRIMARY KEY (scope_key, skill_id, version)
)`);
      const versionColumns =
        "skill_id, version, content_hash, parent_version, scope_key, manifest_json, supported_runtime_versions_json, supported_tool_contract_versions_json, provenance, review_state, package_artifact_id, imported_by, imported_at, reviewed_by, reviewed_at";
      db.exec(`INSERT INTO tavi_skill_versions_rebuilt (${versionColumns}) SELECT ${versionColumns} FROM tavi_skill_versions`);
      db.exec(`CREATE TABLE tavi_skill_activations_rebuilt (
  scope_key       TEXT NOT NULL,
  skill_id        TEXT NOT NULL,
  active_version   TEXT NOT NULL,
  activated_by     TEXT NOT NULL,
  activated_at     TEXT NOT NULL,
  PRIMARY KEY (scope_key, skill_id),
  FOREIGN KEY (scope_key, skill_id, active_version) REFERENCES tavi_skill_versions_rebuilt(scope_key, skill_id, version)
)`);
      db.exec(`INSERT INTO tavi_skill_activations_rebuilt (scope_key, skill_id, active_version, activated_by, activated_at)
SELECT a.scope_key, a.skill_id, a.active_version, a.activated_by, a.activated_at FROM tavi_skill_activations a
 WHERE EXISTS (SELECT 1 FROM tavi_skill_versions_rebuilt v WHERE v.scope_key = a.scope_key AND v.skill_id = a.skill_id AND v.version = a.active_version)`);
      // A dropped pointer is recorded as a disable, so the history agrees with the activation and a rollback never
      // targets a version the workspace only "activated" through another workspace's row.
      db.exec(`INSERT INTO tavi_skill_activation_history (history_id, scope_key, skill_id, previous_version, new_version, reason, actor, at)
SELECT 'skillact-0008-' || lower(hex(randomblob(12))), a.scope_key, a.skill_id, a.active_version, NULL, 'disable', 'migration:0008',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM tavi_skill_activations a
 WHERE NOT EXISTS (SELECT 1 FROM tavi_skill_activations_rebuilt r WHERE r.scope_key = a.scope_key AND r.skill_id = a.skill_id)`);
      // The activations go first: dropping the versions table deletes its rows, which the old foreign key checks.
      // Renaming the rebuilt versions table rewrites the new activations' foreign key to its final name.
      db.exec("DROP TABLE tavi_skill_activations");
      db.exec("DROP TABLE tavi_skill_versions");
      db.exec("ALTER TABLE tavi_skill_versions_rebuilt RENAME TO tavi_skill_versions");
      db.exec("ALTER TABLE tavi_skill_activations_rebuilt RENAME TO tavi_skill_activations");
      db.exec("CREATE INDEX tavi_skill_versions_scope_idx ON tavi_skill_versions (scope_key, skill_id, review_state)");
    },
  },
  {
    // The canvas's Skills panel follows a skill's versions and activation as the Command Center's feed does memory.
    id: "0009_skills_center_versions",
    up: (db) => {
      db.exec(`CREATE TRIGGER tavi_skill_versions_center_insert AFTER INSERT ON tavi_skill_versions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version) VALUES (NEW.scope_key, 'skill', 1)
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`);
      db.exec(`CREATE TRIGGER tavi_skill_versions_center_update AFTER UPDATE ON tavi_skill_versions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version) VALUES (NEW.scope_key, 'skill', 1)
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`);
      db.exec(`CREATE TRIGGER tavi_skill_versions_center_delete AFTER DELETE ON tavi_skill_versions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version) VALUES (OLD.scope_key, 'skill', 1)
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`);
      db.exec(`CREATE TRIGGER tavi_skill_activations_center_insert AFTER INSERT ON tavi_skill_activations BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version) VALUES (NEW.scope_key, 'skill', 1)
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`);
      db.exec(`CREATE TRIGGER tavi_skill_activations_center_update AFTER UPDATE ON tavi_skill_activations BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version) VALUES (NEW.scope_key, 'skill', 1)
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`);
      db.exec(`CREATE TRIGGER tavi_skill_activations_center_delete AFTER DELETE ON tavi_skill_activations BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version) VALUES (OLD.scope_key, 'skill', 1)
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`);
    },
  },
  {
    // A skill's uses — a chat's `skills.read`, a routine run's pinned skill — as metadata, never body text, so
    // `tavi skills list` and the canvas can show how often each is used and flag one gone stale. No foreign key to a
    // task: a routine's use can precede its task. Bounded by the repository (a year, and a cap per skill), and no
    // Center trigger: a use is not a change to the skill.
    id: "0010_skill_uses",
    up: (db) => {
      db.exec(`CREATE TABLE tavi_skill_uses (
  scope_key  TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  skill_id   TEXT NOT NULL,
  version    TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('chat','routine')),
  used_at    TEXT NOT NULL,
  PRIMARY KEY (scope_key, skill_id, task_id, version, source)
)`);
      db.exec("CREATE INDEX tavi_skill_uses_recent_idx ON tavi_skill_uses (scope_key, used_at)");
      db.exec("CREATE INDEX tavi_skill_uses_skill_idx ON tavi_skill_uses (scope_key, skill_id, used_at)");
    },
  },
  {
    // To-dos live in the reminders table: a row of `kind` 'todo' is open or done, on a list, with notes and a
    // due date or time (a due time also reminds, through the row's own schedule). Every existing row is a reminder.
    id: "0011_todos",
    up: (db) => {
      db.exec("ALTER TABLE tavi_reminders ADD COLUMN kind TEXT NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder', 'todo'))");
      db.exec("ALTER TABLE tavi_reminders ADD COLUMN todo_status TEXT CHECK (todo_status IN ('open', 'done'))");
      db.exec("ALTER TABLE tavi_reminders ADD COLUMN list TEXT");
      db.exec("ALTER TABLE tavi_reminders ADD COLUMN notes TEXT");
      db.exec("ALTER TABLE tavi_reminders ADD COLUMN due TEXT");
      db.exec("ALTER TABLE tavi_reminders ADD COLUMN completed_at TEXT");
      db.exec(
        "CREATE INDEX tavi_reminders_todos ON tavi_reminders (workspace_id, todo_status, created_at, reminder_id) WHERE kind = 'todo'",
      );
    },
  },
  {
    // A schedule's fires, each with why it ended so — run, missed, skipped for overlap or a full disk — where the
    // schedule's own row keeps only the last. Bounded per schedule by the repository, and removed with the schedule.
    // No foreign key to the schedule: a fire is recorded by a sweep that may race its removal, and a fire for a
    // schedule removed mid-sweep is dropped rather than failing the fire's own record.
    id: "0012_schedule_fires",
    up: (db) => {
      db.exec(`CREATE TABLE tavi_schedule_fires (
  schedule_id   TEXT NOT NULL,
  fire_time     TEXT NOT NULL,
  outcome_kind  TEXT NOT NULL CHECK (outcome_kind IN ('succeeded','failed','skipped')),
  outcome       TEXT NOT NULL,
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('ok','undelivered','failed','waiting','asked','missed','overlap','disk','disabled','orphaned','manual')),
  task_id       TEXT,
  at            TEXT NOT NULL
)`);
      db.exec("CREATE INDEX tavi_schedule_fires_recent_idx ON tavi_schedule_fires (schedule_id, at)");
    },
  },
  {
    // A schedule may bound how long its fire's run works (NULL: the default), and the fire ledger
    // records a run stopped at that bound as `timeout`. SQLite cannot change a CHECK in place: the
    // ledger is rebuilt with the same columns and rows.
    id: "0013_schedule_max_run",
    up: (db) => {
      db.exec(
        "ALTER TABLE tavi_schedules ADD COLUMN max_run_minutes INTEGER CHECK (max_run_minutes IS NULL OR max_run_minutes BETWEEN 1 AND 1440)",
      );
      db.exec(`CREATE TABLE tavi_schedule_fires_rebuilt (
  schedule_id   TEXT NOT NULL,
  fire_time     TEXT NOT NULL,
  outcome_kind  TEXT NOT NULL CHECK (outcome_kind IN ('succeeded','failed','skipped')),
  outcome       TEXT NOT NULL,
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('ok','undelivered','failed','timeout','waiting','asked','missed','overlap','disk','disabled','orphaned','manual')),
  task_id       TEXT,
  at            TEXT NOT NULL
)`);
      db.exec(
        `INSERT INTO tavi_schedule_fires_rebuilt (rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at)
         SELECT rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at FROM tavi_schedule_fires`,
      );
      db.exec("DROP TABLE tavi_schedule_fires");
      db.exec("ALTER TABLE tavi_schedule_fires_rebuilt RENAME TO tavi_schedule_fires");
      db.exec("CREATE INDEX tavi_schedule_fires_recent_idx ON tavi_schedule_fires (schedule_id, at)");
    },
  },
  {
    // A schedule may tell its person only when a run has something (NULL: always), keeping the hash
    // of the last result it delivered, and the fire ledger records a run with nothing to tell as
    // `quiet`. The ledger is rebuilt for its CHECK, as 0013 did, with the same columns and rows.
    id: "0014_schedule_notify",
    up: (db) => {
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN notify TEXT CHECK (notify IS NULL OR notify IN ('when-sent','if-changed'))");
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN last_delivered_hash TEXT");
      db.exec(`CREATE TABLE tavi_schedule_fires_rebuilt (
  schedule_id   TEXT NOT NULL,
  fire_time     TEXT NOT NULL,
  outcome_kind  TEXT NOT NULL CHECK (outcome_kind IN ('succeeded','failed','skipped')),
  outcome       TEXT NOT NULL,
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('ok','undelivered','quiet','failed','timeout','waiting','asked','missed','overlap','disk','disabled','orphaned','manual')),
  task_id       TEXT,
  at            TEXT NOT NULL
)`);
      db.exec(
        `INSERT INTO tavi_schedule_fires_rebuilt (rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at)
         SELECT rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at FROM tavi_schedule_fires`,
      );
      db.exec("DROP TABLE tavi_schedule_fires");
      db.exec("ALTER TABLE tavi_schedule_fires_rebuilt RENAME TO tavi_schedule_fires");
      db.exec("CREATE INDEX tavi_schedule_fires_recent_idx ON tavi_schedule_fires (schedule_id, at)");
    },
  },
  {
    // A fire that failed on provider weather is tried again (retry_count of retry_of_fire_time, armed at
    // next_run_at), and a schedule whose runs keep failing is paused with its reason. The fire ledger keeps
    // which try each row is (0: the fire's first) and records `retry` and `paused`; it is rebuilt for its
    // CHECK, as 0014 did, with the same rows, each a first try.
    id: "0015_schedule_retry_pause",
    up: (db) => {
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0)");
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN retry_of_fire_time TEXT");
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN paused_reason TEXT CHECK (paused_reason IS NULL OR paused_reason IN ('failures'))");
      db.exec(`CREATE TABLE tavi_schedule_fires_rebuilt (
  schedule_id   TEXT NOT NULL,
  fire_time     TEXT NOT NULL,
  outcome_kind  TEXT NOT NULL CHECK (outcome_kind IN ('succeeded','failed','skipped')),
  outcome       TEXT NOT NULL,
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('ok','undelivered','quiet','failed','timeout','waiting','asked','missed','overlap','disk','disabled','orphaned','manual','retry','paused')),
  task_id       TEXT,
  at            TEXT NOT NULL,
  retry_count   INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0)
)`);
      db.exec(
        `INSERT INTO tavi_schedule_fires_rebuilt (rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at)
         SELECT rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at FROM tavi_schedule_fires`,
      );
      db.exec("DROP TABLE tavi_schedule_fires");
      db.exec("ALTER TABLE tavi_schedule_fires_rebuilt RENAME TO tavi_schedule_fires");
      db.exec("CREATE INDEX tavi_schedule_fires_recent_idx ON tavi_schedule_fires (schedule_id, at)");
    },
  },
  {
    // A schedule may bound how many tokens its fire's run uses (NULL: no ceiling), and the fire ledger
    // records a run stopped at that bound as `budget`. The ledger is rebuilt for its CHECK, as 0015 did,
    // with the same columns and rows, each keeping which try it was.
    id: "0016_schedule_max_tokens",
    up: (db) => {
      db.exec(
        "ALTER TABLE tavi_schedules ADD COLUMN max_tokens INTEGER CHECK (max_tokens IS NULL OR max_tokens BETWEEN 1000 AND 100000000)",
      );
      db.exec(`CREATE TABLE tavi_schedule_fires_rebuilt (
  schedule_id   TEXT NOT NULL,
  fire_time     TEXT NOT NULL,
  outcome_kind  TEXT NOT NULL CHECK (outcome_kind IN ('succeeded','failed','skipped')),
  outcome       TEXT NOT NULL,
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('ok','undelivered','quiet','failed','timeout','budget','waiting','asked','missed','overlap','disk','disabled','orphaned','manual','retry','paused')),
  task_id       TEXT,
  at            TEXT NOT NULL,
  retry_count   INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0)
)`);
      db.exec(
        `INSERT INTO tavi_schedule_fires_rebuilt (rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
         SELECT rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count FROM tavi_schedule_fires`,
      );
      db.exec("DROP TABLE tavi_schedule_fires");
      db.exec("ALTER TABLE tavi_schedule_fires_rebuilt RENAME TO tavi_schedule_fires");
      db.exec("CREATE INDEX tavi_schedule_fires_recent_idx ON tavi_schedule_fires (schedule_id, at)");
    },
  },
  {
    // A routine's daily run limit counts its runs that started on the run's local day, which each run keeps
    // in its data as it starts. The index is on that same expression, so the count reads index entries
    // rather than every run the routine ever had; existing rows are indexed as they are.
    id: "0017_routine_run_local_day",
    up: (db) => {
      db.exec("CREATE INDEX tavi_routine_runs_local_day_idx ON tavi_routine_runs (routine_id, json_extract(data_json, '$.localDay'))");
    },
  },
  {
    // A schedule may name a read-only pre-check (NULL: none) and keeps what it last read, and the fire
    // ledger records a fire whose pre-check found nothing new as `unchanged`. The ledger is rebuilt for its
    // CHECK, as 0016 did, with the same columns and rows, each keeping which try it was.
    id: "0018_schedule_precheck",
    up: (db) => {
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN precheck_json TEXT");
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN precheck_state_json TEXT");
      db.exec(`CREATE TABLE tavi_schedule_fires_rebuilt (
  schedule_id   TEXT NOT NULL,
  fire_time     TEXT NOT NULL,
  outcome_kind  TEXT NOT NULL CHECK (outcome_kind IN ('succeeded','failed','skipped')),
  outcome       TEXT NOT NULL,
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('ok','undelivered','quiet','unchanged','failed','timeout','budget','waiting','asked','missed','overlap','disk','disabled','orphaned','manual','retry','paused')),
  task_id       TEXT,
  at            TEXT NOT NULL,
  retry_count   INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0)
)`);
      db.exec(
        `INSERT INTO tavi_schedule_fires_rebuilt (rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
         SELECT rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count FROM tavi_schedule_fires`,
      );
      db.exec("DROP TABLE tavi_schedule_fires");
      db.exec("ALTER TABLE tavi_schedule_fires_rebuilt RENAME TO tavi_schedule_fires");
      db.exec("CREATE INDEX tavi_schedule_fires_recent_idx ON tavi_schedule_fires (schedule_id, at)");
    },
  },
  {
    // A schedule may have a webhook (NULL: none), kept as its secret's SHA-256, its signing key encrypted with the
    // credential key (NULL: no signed calls) and when that secret was made, and the fire ledger records a fire a webhook call started as `webhook` and refused calls as
    // `webhook-refused`. The ledger is rebuilt for its CHECK, as 0018 did, with the same columns and rows.
    id: "0019_schedule_webhook",
    up: (db) => {
      db.exec(
        "ALTER TABLE tavi_schedules ADD COLUMN webhook_secret_hash TEXT CHECK (webhook_secret_hash IS NULL OR length(webhook_secret_hash) = 64)",
      );
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN webhook_signing_key_enc TEXT");
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN webhook_since TEXT");
      db.exec(`CREATE TABLE tavi_schedule_fires_rebuilt (
  schedule_id   TEXT NOT NULL,
  fire_time     TEXT NOT NULL,
  outcome_kind  TEXT NOT NULL CHECK (outcome_kind IN ('succeeded','failed','skipped')),
  outcome       TEXT NOT NULL,
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('ok','undelivered','quiet','unchanged','failed','timeout','budget','waiting','asked','missed','overlap','disk','disabled','orphaned','manual','webhook','webhook-refused','retry','paused')),
  task_id       TEXT,
  at            TEXT NOT NULL,
  retry_count   INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0)
)`);
      db.exec(
        `INSERT INTO tavi_schedule_fires_rebuilt (rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
         SELECT rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count FROM tavi_schedule_fires`,
      );
      db.exec("DROP TABLE tavi_schedule_fires");
      db.exec("ALTER TABLE tavi_schedule_fires_rebuilt RENAME TO tavi_schedule_fires");
      db.exec("CREATE INDEX tavi_schedule_fires_recent_idx ON tavi_schedule_fires (schedule_id, at)");
    },
  },
  {
    // A schedule may be a watcher (0: none is), whose pre-check is its trigger, and the fire ledger records a check a
    // file watcher made because its file changed as `watch`. The ledger is rebuilt for its CHECK, as 0019 did, with
    // the same columns and rows.
    id: "0020_schedule_watch",
    up: (db) => {
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN watch INTEGER NOT NULL DEFAULT 0 CHECK (watch IN (0, 1))");
      db.exec(`CREATE TABLE tavi_schedule_fires_rebuilt (
  schedule_id   TEXT NOT NULL,
  fire_time     TEXT NOT NULL,
  outcome_kind  TEXT NOT NULL CHECK (outcome_kind IN ('succeeded','failed','skipped')),
  outcome       TEXT NOT NULL,
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('ok','undelivered','quiet','unchanged','failed','timeout','budget','waiting','asked','missed','overlap','disk','disabled','orphaned','manual','webhook','webhook-refused','watch','retry','paused')),
  task_id       TEXT,
  at            TEXT NOT NULL,
  retry_count   INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0)
)`);
      db.exec(
        `INSERT INTO tavi_schedule_fires_rebuilt (rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
         SELECT rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count FROM tavi_schedule_fires`,
      );
      db.exec("DROP TABLE tavi_schedule_fires");
      db.exec("ALTER TABLE tavi_schedule_fires_rebuilt RENAME TO tavi_schedule_fires");
      db.exec("CREATE INDEX tavi_schedule_fires_recent_idx ON tavi_schedule_fires (schedule_id, at)");
    },
  },
  {
    // A schedule may have an email trigger (NULL: none is on), kept as its connection, senders, subject filter and
    // when it was turned on, and the fire ledger records a run an email started as `email` and refused emails as
    // `email-refused`. The ledger is rebuilt for its CHECK, as 0020 did, with the same columns and rows.
    id: "0021_schedule_email_trigger",
    up: (db) => {
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN email_trigger_json TEXT");
      db.exec(`CREATE TABLE tavi_schedule_fires_rebuilt (
  schedule_id   TEXT NOT NULL,
  fire_time     TEXT NOT NULL,
  outcome_kind  TEXT NOT NULL CHECK (outcome_kind IN ('succeeded','failed','skipped')),
  outcome       TEXT NOT NULL,
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('ok','undelivered','quiet','unchanged','failed','timeout','budget','waiting','asked','missed','overlap','disk','disabled','orphaned','manual','webhook','webhook-refused','watch','email','email-refused','retry','paused')),
  task_id       TEXT,
  at            TEXT NOT NULL,
  retry_count   INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0)
)`);
      db.exec(
        `INSERT INTO tavi_schedule_fires_rebuilt (rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
         SELECT rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count FROM tavi_schedule_fires`,
      );
      db.exec("DROP TABLE tavi_schedule_fires");
      db.exec("ALTER TABLE tavi_schedule_fires_rebuilt RENAME TO tavi_schedule_fires");
      db.exec("CREATE INDEX tavi_schedule_fires_recent_idx ON tavi_schedule_fires (schedule_id, at)");
    },
  },
  {
    // The run drain reads the runs waiting to start, in claim order, on every sweep and every wake. Runs are kept,
    // so the index holds only the waiting ones, in that order, and the read stays as small as the queue.
    id: "0022_routine_runs_pending",
    up: (db) => {
      db.exec(
        "CREATE INDEX tavi_routine_runs_pending_idx ON tavi_routine_runs (claimed_at, run_id) WHERE status IN ('queued','interrupted')",
      );
    },
  },
  {
    // A connection may set how long a call waits for the provider's first output and between chunks before it fails
    // over, in seconds. NULL: the built-in deadlines, which every connection saved before keeps.
    id: "0023_model_connection_stream_timeouts",
    up: (db) => {
      db.exec("ALTER TABLE tavi_model_connections ADD COLUMN stream_first_byte_seconds INTEGER");
      db.exec("ALTER TABLE tavi_model_connections ADD COLUMN stream_idle_seconds INTEGER");
    },
  },
  {
    // Indexes for hot reads that scanned their table (the gate, hook-event, outbox, task, approval-link, memory-deletion and routine reads), each checked against its query with
    // `EXPLAIN QUERY PLAN` (`test/persistence/query-plans.test.ts`).
    id: "0024_hot_query_indexes",
    up: (db) => {
      for (const statement of [
        "CREATE INDEX IF NOT EXISTS tavi_plugin_hook_events_task_idx ON tavi_plugin_hook_events (task_id, kind, event, created_at)",
        "CREATE INDEX IF NOT EXISTS tavi_messaging_outbox_state_created_idx ON tavi_messaging_outbox (state, created_at)",
        "CREATE INDEX IF NOT EXISTS tavi_tasks_created_idx ON tavi_tasks (created_at DESC)",
        "CREATE INDEX IF NOT EXISTS tavi_approval_links_question_idx ON tavi_approval_links (kind, wait_id) WHERE wait_id IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS tavi_memory_deletions_record_idx ON tavi_memory_deletions (record_id, requested_at DESC, deletion_id DESC)",
        "CREATE INDEX IF NOT EXISTS tavi_routine_details_run_idx ON tavi_routine_details (run_id)",
        "CREATE INDEX IF NOT EXISTS tavi_routine_details_routine_idx ON tavi_routine_details (routine_id, created_at)",
        "CREATE INDEX IF NOT EXISTS tavi_routine_delivery_jobs_run_idx ON tavi_routine_delivery_jobs (run_id, created_at, job_id)",
        "CREATE INDEX IF NOT EXISTS tavi_routine_blob_refs_routine_idx ON tavi_routine_blob_refs (routine_id, pinned)",
        "CREATE INDEX IF NOT EXISTS tavi_routine_blob_refs_artifact_idx ON tavi_routine_blob_refs (artifact_id)",
      ])
        db.exec(statement);
    },
  },
  {
    // Past-chat search (`sessions.search`) looks substrings up in an index instead of a `LIKE` over every turn's raw
    // JSON. Each admission's words as the search decodes them — its intent's and its result's `prompt` and
    // `finalText`, joined as `searchTaskHistory` joins them — are indexed as trigrams, so any substring of 3 or
    // more characters is found, case-folded, CJK included. Contentless: the words stay only in `tavi_admissions`.
    // Keyed through `tavi_task_history_fts_map`, as memory's index is, because an admission's implicit rowid may
    // change under `VACUUM`. Triggers keep it in step with every write: an admission added, its words rewritten
    // (forget, rewind, a purge) or deleted with its chat. `secure-delete` erases a deleted row's trigrams at once,
    // so a forgotten turn's words do not linger in the index's pages for a backup to carry.
    id: "0025_task_history_fts",
    up: (db) => {
      const words = (row: "NEW" | "a") =>
        `COALESCE(${historyTextSql(`${row}.intent`)}, '') || ' ' || COALESCE(${historyTextSql(`${row}.result`)}, '')`;
      for (const statement of [
        `CREATE TABLE tavi_task_history_fts_map (
  row_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id TEXT NOT NULL UNIQUE
)`,
        `CREATE VIRTUAL TABLE tavi_task_history_fts USING fts5(
  body,
  content = '',
  contentless_delete = 1,
  tokenize = "trigram"
)`,
        "INSERT INTO tavi_task_history_fts(tavi_task_history_fts, rank) VALUES ('secure-delete', 1)",
        "INSERT INTO tavi_task_history_fts_map (admission_id) SELECT admission_id FROM tavi_admissions ORDER BY created_at, rowid",
        `INSERT INTO tavi_task_history_fts (rowid, body)
  SELECT m.row_id, ${words("a")} FROM tavi_task_history_fts_map m JOIN tavi_admissions a ON a.admission_id = m.admission_id`,
        `CREATE TRIGGER tavi_admissions_history_insert AFTER INSERT ON tavi_admissions
BEGIN
  INSERT INTO tavi_task_history_fts_map (admission_id) VALUES (NEW.admission_id);
  INSERT INTO tavi_task_history_fts (rowid, body)
    SELECT row_id, ${words("NEW")} FROM tavi_task_history_fts_map WHERE admission_id = NEW.admission_id;
END`,
        `CREATE TRIGGER tavi_admissions_history_update AFTER UPDATE OF intent, result ON tavi_admissions
  WHEN OLD.intent IS NOT NEW.intent OR OLD.result IS NOT NEW.result
BEGIN
  DELETE FROM tavi_task_history_fts WHERE rowid = (SELECT row_id FROM tavi_task_history_fts_map WHERE admission_id = NEW.admission_id);
  INSERT INTO tavi_task_history_fts (rowid, body)
    SELECT row_id, ${words("NEW")} FROM tavi_task_history_fts_map WHERE admission_id = NEW.admission_id;
END`,
        `CREATE TRIGGER tavi_admissions_history_delete AFTER DELETE ON tavi_admissions
BEGIN
  DELETE FROM tavi_task_history_fts WHERE rowid = (SELECT row_id FROM tavi_task_history_fts_map WHERE admission_id = OLD.admission_id);
  DELETE FROM tavi_task_history_fts_map WHERE admission_id = OLD.admission_id;
END`,
      ])
        db.exec(statement);
    },
  },
  {
    // An inbound email looks up the schedules whose email trigger listens on its connection (`emailTriggered`) in an
    // index instead of reading every schedule's trigger JSON. The key is the connection as `emailTriggered` reads it,
    // NULL for unreadable JSON; the query must keep this exact expression for SQLite to use the index.
    id: "0026_schedule_email_trigger_index",
    up: (db) => {
      db.exec(`CREATE INDEX IF NOT EXISTS tavi_schedules_email_trigger_idx ON tavi_schedules (
  (CASE WHEN json_valid(email_trigger_json) THEN json_extract(email_trigger_json, '$.connectionId') END), name
) WHERE email_trigger_json IS NOT NULL`);
    },
  },
  {
    // A checkpoint stored per channel (`AsyncCheckpointSaver`'s `channelBlobs`, off unless TAVI_CHECKPOINT_BLOBS=1)
    // keeps each channel's value once per version here, and its `checkpoints` row only the versions; a read rejoins
    // them. The saver's own `checkpoints` and `writes` keep their shape. Rows go with their thread (`deleteThread`, a
    // purge) and with the last checkpoint naming them (`pruneThread`).
    id: "0027_checkpoint_blobs",
    up: (db) => {
      db.exec(`CREATE TABLE tavi_checkpoint_blobs (
  thread_id     TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  channel       TEXT NOT NULL,
  version       TEXT NOT NULL,
  type          TEXT NOT NULL,
  blob          BLOB NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
)`);
    },
  },
  {
    // A schedule may pin the host folder its fires work in, as a routine pins its own: a real path checked against
    // the owner's --fs-root folders when it is set and again at each fire. NULL: each fire's own managed folder.
    id: "0028_schedule_folder",
    up: (db) => {
      db.exec("ALTER TABLE tavi_schedules ADD COLUMN folder_path TEXT");
    },
  },
  {
    // A turn the person stopped ends a task as `stopped`, an ending a summary is owed for like any other. The rows of
    // the builds that wrote `failed` with `STOPPED` were never released, and still reply as a failed chat does.
    id: "0029_stopped_task_summary",
    up: (db) => {
      db.exec("DROP TRIGGER tavi_tasks_summary_finished");
      db.exec(`CREATE TRIGGER tavi_tasks_summary_finished AFTER UPDATE OF status ON tavi_tasks
  WHEN NEW.status IN ('completed', 'failed', 'stopped', 'cancelled') AND NEW.status IS NOT OLD.status AND NEW.chat_kind IS NOT 'home'
BEGIN
  UPDATE tavi_tasks SET summary_state = 'pending' WHERE task_id = NEW.task_id AND summary_state IS NOT 'pending';
END`);
    },
  },
  {
    // A fire a person stopped is recorded `stopped`: no reason the ledger had says it, and `failed` counts toward a
    // pause. The ledger is rebuilt for its CHECK, as 0021 did, with the same columns and rows.
    id: "0030_schedule_fire_stopped",
    up: (db) => {
      db.exec(`CREATE TABLE tavi_schedule_fires_rebuilt (
  schedule_id   TEXT NOT NULL,
  fire_time     TEXT NOT NULL,
  outcome_kind  TEXT NOT NULL CHECK (outcome_kind IN ('succeeded','failed','skipped')),
  outcome       TEXT NOT NULL,
  reason_code   TEXT NOT NULL CHECK (reason_code IN ('ok','undelivered','quiet','unchanged','failed','timeout','budget','waiting','asked','missed','overlap','disk','disabled','orphaned','manual','webhook','webhook-refused','watch','email','email-refused','retry','paused','stopped')),
  task_id       TEXT,
  at            TEXT NOT NULL,
  retry_count   INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0)
)`);
      db.exec(
        `INSERT INTO tavi_schedule_fires_rebuilt (rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count)
         SELECT rowid, schedule_id, fire_time, outcome_kind, outcome, reason_code, task_id, at, retry_count FROM tavi_schedule_fires`,
      );
      db.exec("DROP TABLE tavi_schedule_fires");
      db.exec("ALTER TABLE tavi_schedule_fires_rebuilt RENAME TO tavi_schedule_fires");
      db.exec("CREATE INDEX tavi_schedule_fires_recent_idx ON tavi_schedule_fires (schedule_id, at)");
    },
  },
  {
    // What Rhumb last said of each model's lifecycle (retired, retiring, redirected), by connection and model. Its
    // own table: model discovery rewrites the catalog, and a model in use may not be in the catalog at all.
    id: "0031_model_lifecycle",
    up: (db) => {
      db.exec(`CREATE TABLE tavi_model_lifecycle (
  connection_id    TEXT NOT NULL,
  model_id         TEXT NOT NULL,
  lifecycle_json   TEXT NOT NULL,
  PRIMARY KEY (connection_id, model_id)
)`);
    },
  },
  {
    // A notice's title and summary, and a fire's outcome, by key and parameters beside their English, so each is said
    // in its reader's language at read time; NULL for a row written before, which shows its English. Added columns,
    // never a rebuild: `tavi_memory_prompts.notice_id` cascades from `tavi_chat_notices`.
    id: "0032_stored_text_keys",
    up: (db) => {
      db.exec("ALTER TABLE tavi_chat_notices ADD COLUMN title_key TEXT");
      db.exec("ALTER TABLE tavi_chat_notices ADD COLUMN title_params_json TEXT");
      db.exec("ALTER TABLE tavi_chat_notices ADD COLUMN summary_key TEXT");
      db.exec("ALTER TABLE tavi_chat_notices ADD COLUMN summary_params_json TEXT");
      db.exec("ALTER TABLE tavi_schedule_fires ADD COLUMN outcome_key TEXT");
      db.exec("ALTER TABLE tavi_schedule_fires ADD COLUMN outcome_params_json TEXT");
    },
  },
];

/**
 * The words `searchTaskHistory` decodes from one admission column, as SQL: an object's `prompt` and
 * `finalText` when each is a string, joined by " — "; NULL for anything else. Used only by
 * `0025_task_history_fts`, whose triggers keep the SQL it wrote: never change it, add a migration.
 */
function historyTextSql(column: string): string {
  return `CASE WHEN json_valid(${column}) THEN CASE WHEN json_type(${column}) = 'object' THEN concat_ws(' — ',
    CASE WHEN json_type(${column}, '$.prompt') = 'text' THEN json_extract(${column}, '$.prompt') END,
    CASE WHEN json_type(${column}, '$.finalText') = 'text' THEN json_extract(${column}, '$.finalText') END) END END`;
}

/**
 * Apply every migration this build knows that the database has not recorded.
 *
 * @param migrations **@internal**, for tests only. The list "this build" knows.
 * Production passes nothing and gets `MIGRATIONS`; a test passes a *prefix* of it
 * to play an older build, which is the only way to show that a directory a later
 * migration touched is refused rather than opened (after any migration,
 * rollback is a restore). Anything but a prefix is refused: applying
 * or skipping migrations out of order is never a legitimate call.
 */
export function runMigrations(db: Database, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  if (migrations !== MIGRATIONS && !migrations.every((migration, index) => MIGRATIONS[index] === migration)) {
    throw new TaviError("INVALID_INPUT", "runMigrations accepts only a prefix of MIGRATIONS (an older build's list)");
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS tavi_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at   TEXT NOT NULL
);`);

  const applied = new Set(
    (db.prepare("SELECT migration_id FROM tavi_schema_migrations").all() as { migration_id: string }[]).map((row) => row.migration_id),
  );

  // Refuse a schema this binary does not recognise before applying anything.
  //
  // Migrations are forward-only and unknown ids were previously ignored, so an
  // older build would happily open a newer schema, skip the parts it does not
  // know, and write rows the newer build then reads under different assumptions —
  // silently, with no way to tell afterwards which build wrote what. A downgrade is an operator decision, not an
  // accident: the refusal names the ids so installing the newer build, restoring a
  // backup, or choosing another `--data-dir` are all obvious next steps.
  //
  // Note the two ways an id can be unknown, because the wording has to be true of
  // both: a newer build *added* it, or this binary's own history *renamed or
  // removed* it. Renaming a shipped id is therefore fatal by design — the id is
  // the record, and a database carrying the old name is one this build can no
  // longer account for. Amending a shipped migration's SQL under the same id is
  // not detectable here at all (there is no fingerprint), which is why it is
  // forbidden.
  //
  // `UNAVAILABLE`, not `INVALID_INPUT`: the operator's input was fine and the
  // on-disk state is what this binary cannot use. The code also matters —
  // `INVALID_INPUT` mapped to a usage error in one CLI failure path and to exit 70
  // in the other, so the same refusal looked like a typo to one command and a
  // crash to the next.
  const known = new Set(migrations.map((migration) => migration.id));
  const unknown = [...applied].filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    throw new TaviError(
      "UNAVAILABLE",
      `This data directory's schema is not known to this build of tavi: ${unknown.length} applied migration(s) ` +
        `were not applied by it (${unknown.join(", ")}). Refusing to open it. Install the build that wrote it, ` +
        "restore a backup, or start from a different --data-dir.",
      { details: { unknownMigrations: unknown } },
    );
  }

  const appliedNow: string[] = [];
  const already: string[] = [];

  const apply = (): void => {
    for (const migration of migrations) {
      if (applied.has(migration.id)) {
        already.push(migration.id);
        continue;
      }
      const run = db.transaction(() => {
        migration.up(db);
        db.prepare("INSERT INTO tavi_schema_migrations (migration_id, applied_at) VALUES (?, ?)").run(migration.id, nowTimestamp());
      });
      run();
      appliedNow.push(migration.id);
    }
  };
  // A new database migrates in one transaction, so the profile-format marker the
  // baseline writes commits with its first tables: an interrupted first run leaves
  // no unmarked schema that would be refused as an older profile.
  if (applied.size === 0) db.transaction(apply)();
  else apply();
  repairBaselineColumns(db);

  return { applied: appliedNow, alreadyApplied: already };
}

/**
 * Columns the baseline gained in place, added to a data directory created
 * before them: such a directory recorded the baseline as applied, so the
 * migration that would have added them never runs there.
 */
function repairBaselineColumns(db: Database): void {
  const columns = (db.prepare("SELECT name FROM pragma_table_info('tavi_memory_records')").all() as { name: string }[]).map(
    (row) => row.name,
  );
  if (columns.length > 0 && !columns.includes("local_origin")) {
    db.exec("ALTER TABLE tavi_memory_records ADD COLUMN local_origin INTEGER NOT NULL DEFAULT 0 CHECK (local_origin IN (0, 1))");
  }
  const revisionColumns = (db.prepare("SELECT name FROM pragma_table_info('tavi_memory_revisions')").all() as { name: string }[]).map(
    (row) => row.name,
  );
  if (revisionColumns.length > 0 && !revisionColumns.includes("keywords_json")) {
    db.exec("ALTER TABLE tavi_memory_revisions ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]'");
  }
}

/** Tables the application owns; used by fixtures and backup qualification. */
export const APPLICATION_TABLES = [
  // Kept literal (not derived from the schema) because it is the *declaration*
  // the completeness test compares the live schema against; a derived list would
  // agree with any schema, including a wrong one. A stale list once qualified
  // backups that silently lost every messaging and delegation row.
  "tavi_schema_migrations",
  "tavi_tasks",
  "tavi_admissions",
  "tavi_executions",
  "tavi_effects",
  "tavi_approvals",
  "tavi_cancellations",
  "tavi_checkpoint_receipts",
  "tavi_checkpoint_blobs",
  "tavi_task_tool_calls",
  "tavi_task_routes",
  "tavi_task_folders",
  "tavi_task_findings",
  "tavi_tainted_host_writes",
  "tavi_artifacts",
  "tavi_meta",
  "tavi_model_connections",
  "tavi_model_catalog",
  "tavi_model_workspace_defaults",
  "tavi_model_roles",
  "tavi_model_lifecycle",
  "tavi_search_providers",
  "tavi_model_price_sheets",
  "tavi_provider_attempts",
  "tavi_provider_attempt_requests",
  "tavi_provider_operations",
  "tavi_router_configurations",
  "tavi_router_decisions",
  "tavi_tool_disclosures",
  "tavi_router_budget_totals",
  "tavi_context_projections",
  "tavi_memory_records",
  "tavi_memory_revisions",
  "tavi_evidence_sources",
  "tavi_memory_reviews",
  "tavi_lineage_edges",
  "tavi_memory_deletions",
  "tavi_memory_scope_generations",
  "tavi_memory_fts_map",
  "tavi_task_history_fts_map",
  "tavi_task_memory_use",
  "tavi_memory_prompts",
  "tavi_memory_marks",
  "tavi_memory_vectors",
  "tavi_memory_vector_failures",
  "tavi_skill_versions",
  "tavi_skill_activations",
  "tavi_skill_activation_history",
  "tavi_skill_rollout_allowlist",
  "tavi_skill_uses",
  "tavi_agent_mailbox",
  "tavi_agent_wait_intents",
  "tavi_agent_delegation_admissions",
  "tavi_agent_definitions",
  "tavi_messaging_connections",
  "tavi_channel_ingress",
  "tavi_messaging_inbox",
  "tavi_messaging_outbox",
  "tavi_messaging_deliveries",
  "tavi_messaging_identity_bindings",
  "tavi_messaging_inbound_activity",
  "tavi_messaging_conversation_tasks",
  "tavi_messaging_grants",
  "tavi_channel_rooms",
  "tavi_channel_purges",
  "tavi_tool_rules",
  "tavi_tool_rule_seeds",
  "tavi_session_grants",
  "tavi_approval_rounds",
  "tavi_approval_events",
  "tavi_approval_links",
  "tavi_approval_round_deliveries",
  "tavi_need_deliveries",
  "tavi_pending_reject_reasons",
  "tavi_gate_observations",
  "tavi_transcript_entries",
  "tavi_chat_instructions",
  "tavi_chat_steers",
  "tavi_chat_notices",
  "tavi_task_prompt_pins",
  "tavi_workspace_system_prompts",
  "tavi_task_prompt_snapshots",
  "tavi_schedules",
  "tavi_schedule_fires",
  "tavi_projects",
  "tavi_collector_settings",
  "tavi_reports",
  "tavi_routines",
  "tavi_routine_revisions",
  "tavi_agent_revisions",
  "tavi_routine_evaluations",
  "tavi_routine_operations",
  "tavi_routine_triggers",
  "tavi_routine_state",
  "tavi_routine_runs",
  "tavi_routine_attempts",
  "tavi_routine_events",
  "tavi_routine_details",
  "tavi_routine_delivery_targets",
  "tavi_routine_delivery_jobs",
  "tavi_routine_blob_refs",
  "tavi_routine_sources",
  "tavi_routine_coverage",
  "tavi_routine_staging",
  "tavi_routine_commands",
  "tavi_routine_conversations",
  "tavi_routine_quality",
  "tavi_routine_grants",
  "tavi_routine_standing_answers",
  "tavi_plugin_versions",
  "tavi_plugin_settings",
  "tavi_plugin_state",
  "tavi_plugin_hook_events",
  "tavi_plugin_hook_prunes",
  "tavi_mcp_versions",
  "tavi_mcp_tools",
  "tavi_mcp_tree_index",
  "tavi_mcp_notices",
  "tavi_workspace_settings",
  "tavi_reminders",
  "tavi_reminder_fires",
  "tavi_browser_sessions",
  "tavi_browser_visits",
  "tavi_site_recipes",
  "tavi_site_usage",
  "tavi_heartbeats",
  "tavi_heartbeat_ticks",
  "tavi_heartbeat_items",
  "tavi_heartbeat_signals",
  "tavi_heartbeat_instructions",
  "tavi_ideas",
  "tavi_idea_runs",
  "tavi_idea_feedback",
  "tavi_idea_settings",
  "tavi_onboarding",
  "tavi_onboarding_steps",
  "tavi_onboarding_verifications",
  "tavi_onboarding_events",
  "tavi_center_versions",
] as const;

/** The routine tables, which the routine release test checks a snapshot carries. */
export const ROUTINE_TABLES = [
  "tavi_routines",
  "tavi_routine_revisions",
  "tavi_agent_revisions",
  "tavi_routine_evaluations",
  "tavi_routine_operations",
  "tavi_routine_triggers",
  "tavi_routine_state",
  "tavi_routine_runs",
  "tavi_routine_attempts",
  "tavi_routine_events",
  "tavi_routine_details",
  "tavi_routine_delivery_targets",
  "tavi_routine_delivery_jobs",
  "tavi_routine_blob_refs",
  "tavi_routine_sources",
  "tavi_routine_coverage",
  "tavi_routine_staging",
  "tavi_routine_commands",
  "tavi_routine_conversations",
  "tavi_routine_quality",
  "tavi_routine_grants",
  "tavi_routine_standing_answers",
] as const satisfies readonly (typeof APPLICATION_TABLES)[number][];

/**
 * FTS5 shadow tables, created by SQLite itself when `tavi_memory_fts`,
 * `tavi_memory_fts_stem` and `tavi_task_history_fts` (contentless: no
 * `*_content`) are created. They are backed up with the database like
 * every other table, but they have no independent schema to migrate, so they
 * are named here rather than in `APPLICATION_TABLES` — the completeness test
 * expects exactly this set.
 */
export const FTS_SHADOW_TABLES = [
  "tavi_memory_fts",
  "tavi_memory_fts_data",
  "tavi_memory_fts_idx",
  "tavi_memory_fts_content",
  "tavi_memory_fts_docsize",
  "tavi_memory_fts_config",
  "tavi_memory_fts_stem",
  "tavi_memory_fts_stem_data",
  "tavi_memory_fts_stem_idx",
  "tavi_memory_fts_stem_content",
  "tavi_memory_fts_stem_docsize",
  "tavi_memory_fts_stem_config",
  "tavi_task_history_fts",
  "tavi_task_history_fts_data",
  "tavi_task_history_fts_idx",
  "tavi_task_history_fts_docsize",
  "tavi_task_history_fts_config",
] as const;

/** Tables owned by the pinned LangGraph saver; application code must not migrate them. */
export const SAVER_TABLES = ["checkpoints", "writes"] as const;

/**
 * The saver schema this build expects, recorded in `tavi_meta` at composition.
 * Bump it when re-verifying a new pinned
 * `@langchain/langgraph-checkpoint-sqlite`: `doctor` reports a directory whose
 * recorded value differs, because the saver's `CREATE TABLE IF NOT EXISTS` will
 * not reshape an existing `checkpoints`/`writes` and the failure otherwise
 * surfaces inside a graph run with nothing on disk to explain it.
 */
export const SAVER_SCHEMA_VERSION = 1;

/** `tavi_meta` key holding {@link SAVER_SCHEMA_VERSION}'s value for a directory. */
export const SAVER_SCHEMA_VERSION_KEY = "saver.schema_version";

/**
 * The columns the pinned saver's prepared statements use, so a directory whose
 * `checkpoints`/`writes` were created by an older pin can be *shown* to be
 * missing one — `IF NOT EXISTS` never adds a column, and the failure otherwise
 * appears inside a graph run. Mirrors
 * `@langchain/langgraph-checkpoint-sqlite`'s DDL; `doctor` reports what is
 * missing rather than refusing to open the directory.
 */
export const SAVER_EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  checkpoints: ["thread_id", "checkpoint_ns", "checkpoint_id", "parent_checkpoint_id", "type", "checkpoint", "metadata"],
  writes: ["thread_id", "checkpoint_ns", "checkpoint_id", "task_id", "idx", "channel", "type", "value"],
};
