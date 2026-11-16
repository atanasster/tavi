/**
 * The schema a new data directory starts from: the statements of migration `0001_baseline`.
 *
 * Before its first public release Tavi folded its development migrations into this one. Each statement is the
 * text SQLite keeps in `sqlite_master` for the object it creates, copied exactly, so the schema it makes is the one
 * the old chain made, byte for byte. That is why a few tables read `CREATE TABLE "name"` or carry columns after
 * their closing line: the old chain renamed or altered them, and SQLite recorded the text that way.
 * `packages/runtime/test/schema-snapshot.test.ts` pins the result.
 *
 * Never edit a statement here to change the schema once it has shipped: add a migration after
 * `0001_baseline` in `migrations.ts` and regenerate the snapshot.
 *
 * Ownership rules:
 *  - every application table, index and trigger is prefixed `tavi_`;
 *  - the pinned LangGraph saver owns `checkpoints` and `writes`; they are never created here.
 *
 * Order: a table is followed by its indexes and triggers. A trigger body may name a table created later; SQLite
 * resolves those when the trigger fires. SQLite creates the FTS5 shadow tables and `sqlite_sequence` itself.
 */
export const BASELINE_SCHEMA: readonly string[] = [
  // ── Tasks and their execution ───────────────────────────────────────────────────────────────────────────
  // A task is the durable record of one chat or run; its admissions, execution slots, external effects,
  // approvals, cancellations and checkpoint receipts are what make a crashed or replayed turn resolve to the same
  // outcome instead of running twice.
  `CREATE TABLE "tavi_tasks" (
  task_id        TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  principal_id  TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  status        TEXT NOT NULL,
  final_text    TEXT,
  operation_key TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
, checkpoint_namespace TEXT NOT NULL DEFAULT '', origin TEXT, origin_schedule_id TEXT, tool_count INTEGER, execution_policy_json TEXT, title TEXT, summary TEXT, summary_state TEXT CHECK (summary_state IN ('pending', 'done', 'failed', 'skipped')), summarized_at TEXT, title_override TEXT, chat_kind TEXT CHECK (chat_kind IN ('home', 'side', 'worker', 'run')), parent_chat_id TEXT, transcript_seq_floor INTEGER, rewind_admission_ids TEXT, memory_mode TEXT CHECK (memory_mode IN ('off', 'private')), memory_on_at TEXT)`,
  // Creation uniqueness is per principal: an operation key is scoped to the identity that supplied it, so two
  // principals may use one key and neither can resolve the other's task.
  `CREATE UNIQUE INDEX tavi_tasks_creation_key_idx
    ON tavi_tasks (workspace_id, principal_id, operation_key)
    WHERE operation_key IS NOT NULL`,
  `CREATE INDEX tavi_tasks_workspace_idx ON tavi_tasks (workspace_id, created_at DESC)`,
  `CREATE INDEX tavi_tasks_thread_idx ON tavi_tasks (thread_id)`,
  `CREATE INDEX tavi_tasks_session_idx ON tavi_tasks(workspace_id, updated_at DESC, task_id DESC)`,
  `CREATE TRIGGER tavi_router_task_delete AFTER DELETE ON tavi_tasks BEGIN
  DELETE FROM tavi_router_budget_totals WHERE task_key=OLD.task_id AND workspace_id=OLD.workspace_id AND principal_id=OLD.principal_id;
  DELETE FROM tavi_provider_attempts WHERE run_id=OLD.task_id;
END`,
  `CREATE INDEX tavi_tasks_summary_pending_idx ON tavi_tasks (updated_at, task_id) WHERE summary_state = 'pending'`,
  `CREATE UNIQUE INDEX tavi_tasks_home_idx ON tavi_tasks (workspace_id, principal_id) WHERE chat_kind = 'home'`,
  `CREATE INDEX tavi_tasks_parent_chat_idx ON tavi_tasks (parent_chat_id) WHERE parent_chat_id IS NOT NULL`,
  // Generated titles and summaries queue on `summary_state` itself, kept by this trigger and
  // `tavi_admissions_summary_continued`, so no write path that finishes or continues a task can forget it. A Home is
  // summarized per epoch, by its rollover, not per turn.
  `CREATE TRIGGER tavi_tasks_summary_finished AFTER UPDATE OF status ON tavi_tasks
  WHEN NEW.status IN ('completed', 'failed', 'cancelled') AND NEW.status IS NOT OLD.status AND NEW.chat_kind IS NOT 'home'
BEGIN
  UPDATE tavi_tasks SET summary_state = 'pending' WHERE task_id = NEW.task_id AND summary_state IS NOT 'pending';
END`,
  `CREATE INDEX tavi_tasks_private_idx ON tavi_tasks (memory_mode) WHERE memory_mode = 'private'`,
  `CREATE TABLE tavi_admissions (
    admission_id  TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL,
    kind          TEXT NOT NULL,
    intent        TEXT NOT NULL,
    intent_hash   TEXT NOT NULL,
    state         TEXT NOT NULL,
    -- Durable outcome, so replaying a committed or suspended admission returns a
    -- known result instead of re-running the graph.
    result        TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  , instructions_revision INTEGER, prompt_pin INTEGER)`,
  `CREATE UNIQUE INDEX tavi_admissions_key_idx ON tavi_admissions (task_id, operation_key)`,
  `CREATE INDEX tavi_admissions_state_idx ON tavi_admissions (state, created_at)`,
  `CREATE INDEX tavi_admissions_start_idx ON tavi_admissions(task_id, kind, created_at, admission_id)`,
  `CREATE INDEX tavi_admissions_created_idx ON tavi_admissions (created_at)`,
  `CREATE TRIGGER tavi_admissions_summary_continued AFTER INSERT ON tavi_admissions
  WHEN NEW.kind IN ('start', 'reply')
BEGIN
  UPDATE tavi_tasks SET summary_state = 'pending'
    WHERE task_id = NEW.task_id AND summary_state IS NOT 'pending' AND status IS NOT 'cancelled' AND chat_kind IS NOT 'home';
END`,
  `CREATE TABLE tavi_executions (
  task_id           TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  generation        INTEGER NOT NULL,
  owner_session     TEXT NOT NULL,
  admission_id      TEXT NOT NULL,
  state             TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  heartbeat_at      TEXT NOT NULL,
  lease_expires_at  TEXT NOT NULL,
  ended_at          TEXT,
  -- A termination decision is auditable: who decided, and on what basis.
  terminated_reason TEXT,
  terminated_by     TEXT,
  PRIMARY KEY (task_id, generation)
)`,
  `CREATE INDEX tavi_executions_state_idx ON tavi_executions (task_id, state)`,
  `CREATE INDEX tavi_executions_lease_idx ON tavi_executions (state, lease_expires_at)`,
  `CREATE TABLE tavi_effects (
  effect_key   TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  admission_id TEXT NOT NULL,
  tool_id      TEXT NOT NULL,
  inputs       TEXT NOT NULL,
  inputs_hash  TEXT NOT NULL,
  approval_id  TEXT,
  state        TEXT NOT NULL,
  receipt      TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
, label_json TEXT)`,
  `CREATE INDEX tavi_effects_task_idx ON tavi_effects (task_id, created_at)`,
  `CREATE INDEX tavi_effects_state_idx ON tavi_effects (state, updated_at)`,
  `CREATE INDEX tavi_effects_tool_idx ON tavi_effects (tool_id, created_at)`,
  `CREATE TABLE tavi_approvals (
  approval_id  TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  admission_id TEXT NOT NULL,
  tool_id      TEXT NOT NULL,
  call_id      TEXT NOT NULL,
  inputs       TEXT NOT NULL,
  inputs_hash  TEXT NOT NULL,
  state        TEXT NOT NULL,
  decided_by   TEXT,
  decided_at   TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
, steps INTEGER NOT NULL)`,
  `CREATE INDEX tavi_approvals_state_idx ON tavi_approvals (state, created_at)`,
  `CREATE UNIQUE INDEX tavi_approvals_round_idx ON tavi_approvals (task_id, steps, call_id)`,
  // Decided approvals in the history's order, with `state` a residual filter: an index led by `state` cannot
  // return several states in time order.
  `CREATE INDEX tavi_approvals_decided_idx ON tavi_approvals (decided_at DESC, approval_id DESC) WHERE decided_at IS NOT NULL`,
  `CREATE TABLE tavi_cancellations (
  task_id      TEXT PRIMARY KEY REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  reason       TEXT NOT NULL,
  requested_at TEXT NOT NULL
)`,
  `CREATE TABLE "tavi_checkpoint_receipts" (
  receipt_id           TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  thread_id            TEXT NOT NULL,
  checkpoint_namespace TEXT NOT NULL DEFAULT '',
  checkpoint_id        TEXT NOT NULL,
  admission_id         TEXT,
  source               TEXT NOT NULL,
  recorded_at          TEXT NOT NULL
)`,
  `CREATE UNIQUE INDEX tavi_receipts_checkpoint_idx
  ON tavi_checkpoint_receipts (thread_id, checkpoint_namespace, checkpoint_id)`,
  `CREATE INDEX tavi_receipts_task_idx ON tavi_checkpoint_receipts (task_id, recorded_at)`,
  `CREATE TABLE tavi_task_tool_calls (
  task_id TEXT NOT NULL REFERENCES tavi_tasks(task_id) ON DELETE CASCADE,
  steps INTEGER NOT NULL,
  call_id TEXT NOT NULL, tool_id TEXT, created_at TEXT,
  PRIMARY KEY(task_id, steps, call_id)
)`,
  `CREATE INDEX tavi_task_tool_calls_tool_idx ON tavi_task_tool_calls (tool_id, created_at)`,
  `CREATE TABLE tavi_task_routes (
  task_id TEXT PRIMARY KEY REFERENCES tavi_tasks(task_id) ON DELETE CASCADE, data TEXT NOT NULL
)`,
  `CREATE TABLE tavi_task_folders (
  task_id      TEXT PRIMARY KEY REFERENCES tavi_tasks(task_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  primary_kind TEXT NOT NULL CHECK (primary_kind IN ('managed','host')),
  primary_path TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  revision     INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL
, tainted_at TEXT)`,
  `CREATE TABLE tavi_task_findings (
 task_id TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
 seq INTEGER NOT NULL CHECK (seq >= 1),
 workspace_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 record_json TEXT NOT NULL,
 source_url TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY (task_id, seq)
)`,
  `CREATE INDEX tavi_task_findings_kind_idx ON tavi_task_findings (task_id, kind, seq)`,
  `CREATE TABLE tavi_tainted_host_writes (
  path         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  dev          TEXT,
  ino          TEXT,
  workspace_id TEXT NOT NULL,
  task_id      TEXT,
  written_at   TEXT NOT NULL,
  PRIMARY KEY (path, sha256)
)`,
  `CREATE INDEX tavi_tainted_host_writes_file ON tavi_tainted_host_writes (dev, ino)`,
  `CREATE INDEX tavi_tainted_host_writes_task ON tavi_tainted_host_writes (task_id)`,

  // ── Artifacts ───────────────────────────────────────────────────────────────────────────────────────────
  // Stored files a task produced or took in. Four tables hold foreign keys to `tavi_artifacts` and triggers hang
  // off it, and migrations run with foreign keys on: change it in place (ADD COLUMN), never by a DROP TABLE rebuild.
  `CREATE TABLE tavi_artifacts (
  artifact_id    TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  run_id         TEXT,
  relative_path  TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  created_at     TEXT NOT NULL
, review_state TEXT NOT NULL DEFAULT 'approved', reviewed_by TEXT, reviewed_at TEXT, review_note TEXT, purpose TEXT CHECK (purpose IS NULL OR purpose IN ('thumbnail')), untrusted INTEGER NOT NULL DEFAULT 0 CHECK (untrusted IN (0, 1)), file_name TEXT, folder_copy TEXT CHECK (folder_copy IN ('downloads', 'reports')), fold TEXT CHECK (fold IS NULL OR fold IN ('summary', 'epoch')), label_json TEXT, preview TEXT CHECK (preview IS NULL OR preview IN ('pdf-fill', 'pdf-render', 'video-frame', 'video-sheet', 'video-pose')), derived_from TEXT)`,
  `CREATE INDEX tavi_artifacts_scope_idx ON tavi_artifacts (workspace_id, created_at DESC)`,
  `CREATE INDEX tavi_artifacts_run_idx ON tavi_artifacts (run_id)`,
  `CREATE INDEX tavi_artifacts_pending_review_idx ON tavi_artifacts (workspace_id, created_at) WHERE review_state = 'pending'`,
  `CREATE INDEX tavi_artifacts_task_review_idx ON tavi_artifacts(run_id, review_state)`,
  `CREATE INDEX tavi_artifacts_reviewed_idx ON tavi_artifacts (workspace_id, reviewed_at DESC) WHERE reviewed_at IS NOT NULL`,
  `CREATE INDEX tavi_artifacts_purpose_idx ON tavi_artifacts (purpose, created_at) WHERE purpose IS NOT NULL`,
  `CREATE INDEX tavi_artifacts_fold_idx ON tavi_artifacts (run_id, created_at) WHERE fold IS NOT NULL`,
  `CREATE INDEX tavi_artifacts_preview_idx ON tavi_artifacts (run_id, created_at) WHERE preview IS NOT NULL`,
  `CREATE INDEX tavi_artifacts_derived_from_idx ON tavi_artifacts (derived_from) WHERE derived_from IS NOT NULL`,

  // ── The directory itself ────────────────────────────────────────────────────────────────────────────────
  // Facts about the data directory that are not application rows: the profile format, the saver schema
  // version. Deliberately not rows in `tavi_schema_migrations`: an id there that this build does not ship reads as a
  // downgrade and locks the directory out.
  `CREATE TABLE tavi_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,

  // ── Models, providers and routing ───────────────────────────────────────────────────────────────────────
  // Credential material is deliberately absent: a connection stores only an opaque reference, so the database, its
  // backups and its diagnostics can never carry a secret. A model request lives in its own table, keyed by
  // the attempt, so dropping old requests is a DELETE that frees whole pages.
  `CREATE TABLE tavi_model_connections (
  connection_id  TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('openai-compatible')),
  base_url       TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  default_model  TEXT,
  headers_json   TEXT,
  local_only     INTEGER NOT NULL DEFAULT 0 CHECK (local_only IN (0, 1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
, provider_binding_json TEXT, pdf_input TEXT CHECK (pdf_input IS NULL OR pdf_input IN ('none', 'openai-file')), pdf_engine TEXT CHECK (pdf_engine IS NULL OR pdf_engine IN ('pdf-text', 'mistral-ocr', 'native')), video_models TEXT CHECK (video_models IS NULL OR json_valid(video_models)), wire_api TEXT CHECK (wire_api IS NULL OR wire_api IN ('chat', 'responses')))`,
  `CREATE TABLE tavi_model_catalog (
  connection_id  TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  display_name   TEXT,
  provenance     TEXT NOT NULL CHECK (provenance IN ('catalog', 'manual', 'live')),
  state          TEXT NOT NULL CHECK (state IN ('available', 'capable', 'unavailable')),
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  discovered_at  TEXT, context_window INTEGER, max_tokens INTEGER,
  PRIMARY KEY (connection_id, model_id)
)`,
  `CREATE INDEX tavi_model_catalog_state_idx ON tavi_model_catalog (connection_id, state)`,
  `CREATE TABLE tavi_model_workspace_defaults (
  workspace_id   TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL,
  model          TEXT NOT NULL,
  updated_at     TEXT NOT NULL
)`,
  `CREATE TABLE "tavi_model_roles" (
  workspace_id   TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('main', 'extraction', 'compaction', 'fast', 'embedding')),
  connection_id  TEXT NOT NULL,
  model          TEXT NOT NULL,
  fallback_json  TEXT NOT NULL DEFAULT '[]',
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (workspace_id, role)
)`,
  `CREATE TABLE tavi_search_providers (
  provider_id    TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('tavily', 'brave', 'serper', 'searxng')),
  credential_ref TEXT,
  base_url       TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
)`,
  `CREATE TABLE tavi_model_price_sheets (
  revision TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  model TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  data TEXT NOT NULL
)`,
  `CREATE INDEX tavi_model_prices_target ON tavi_model_price_sheets(connection_id, model, effective_at)`,
  `CREATE TABLE tavi_provider_attempts (
  call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  owner_session TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  data TEXT NOT NULL
, purpose TEXT, input_tokens INTEGER)`,
  `CREATE INDEX tavi_provider_attempts_run ON tavi_provider_attempts(run_id, started_at)`,
  `CREATE INDEX tavi_provider_attempts_state ON tavi_provider_attempts(state, started_at)`,
  `CREATE INDEX tavi_provider_attempts_run_state ON tavi_provider_attempts (run_id, state, started_at)`,
  `CREATE TRIGGER tavi_provider_attempt_requests_cascade AFTER DELETE ON tavi_provider_attempts BEGIN
  DELETE FROM tavi_provider_attempt_requests WHERE call_id = OLD.call_id;
END`,
  `CREATE TABLE tavi_provider_attempt_requests (
  call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  request TEXT NOT NULL
)`,
  `CREATE INDEX tavi_provider_attempt_requests_run ON tavi_provider_attempt_requests (run_id, started_at)`,
  `CREATE TABLE tavi_provider_operations (
  run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, owner_session TEXT NOT NULL,
  state TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, attempt_id)
)`,
  `CREATE INDEX tavi_provider_operations_state ON tavi_provider_operations(state, owner_session)`,
  `CREATE TABLE tavi_router_configurations (
  workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(workspace_id, principal_id, revision)
)`,
  `CREATE TABLE tavi_router_decisions (
  task_id TEXT NOT NULL REFERENCES tavi_tasks(task_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL, turn_id TEXT NOT NULL, owner_session TEXT NOT NULL, generation INTEGER NOT NULL,
  reserved_micros INTEGER NOT NULL, charged_micros INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(task_id, operation_id)
)`,
  `CREATE TABLE tavi_tool_disclosures (
  task_id TEXT NOT NULL REFERENCES tavi_tasks(task_id) ON DELETE CASCADE, attempt_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(task_id, attempt_id)
)`,
  `CREATE TABLE tavi_router_budget_totals (
  workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, task_key TEXT NOT NULL, micros INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, principal_id, task_key)
)`,
  `CREATE TABLE tavi_context_projections (
    task_id TEXT NOT NULL REFERENCES tavi_tasks(task_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id, attempt_id)
  )`,

  // ── Memory ──────────────────────────────────────────────────────────────────────────────────────────────
  // Personal memory and its evidence. Scope is stored both expanded (per-identity columns, for
  // authorization filters) and normalized (`scope_key`, for uniqueness), because a partial unique index cannot be
  // expressed over a nullable set of columns. Erasure history is content-free; revocation generations are
  // per scope, so forgetting a record always moves its scope's generation. The FTS table duplicates bounded searchable
  // text while the canonical tables stay authoritative; its tokenizer is pinned by MEMORY_FTS_SCHEMA_VERSION. A
  // record's `content_key` is computed by the service, because SQLite's `lower` folds ASCII only. Vectors are
  // derived data and go with their revision.
  `CREATE TABLE tavi_memory_records (
  record_id            TEXT PRIMARY KEY,
  scope_key            TEXT NOT NULL,
  scope_kind           TEXT NOT NULL CHECK (scope_kind IN
                         ('personal','personal_workspace','personal_agent','shared_workspace','run_local')),
  principal_id         TEXT NOT NULL,
  workspace_id         TEXT,
  agent_id             TEXT,
  run_id               TEXT,
  kind                 TEXT NOT NULL CHECK (kind IN ('preference','fact','lesson','summary')),
  status               TEXT NOT NULL CHECK (status IN
                         ('proposed','approved','rejected','superseded','revoked','expired','deleted')),
  sensitivity          TEXT NOT NULL CHECK (sensitivity IN ('normal','sensitive')),
  preference_key       TEXT,
  current_revision_id  TEXT,
  valid_from           TEXT,
  valid_to             TEXT,
  expiry_at            TEXT,
  confidence           REAL,
  confidence_basis     TEXT,
  supersedes_record_id TEXT,
  revocation_generation INTEGER NOT NULL DEFAULT 0,
  recorded_at          TEXT NOT NULL,
  updated_at           TEXT NOT NULL
, topic_key TEXT, durable INTEGER NOT NULL DEFAULT 0 CHECK (durable IN (0, 1) AND (durable = 0 OR scope_kind = 'run_local')), origin_task_id TEXT, content_key TEXT, local_origin INTEGER NOT NULL DEFAULT 0 CHECK (local_origin IN (0, 1)))`,
  `CREATE UNIQUE INDEX tavi_memory_active_preference_idx
  ON tavi_memory_records (scope_key, preference_key)
  WHERE kind = 'preference' AND status = 'approved' AND valid_to IS NULL AND preference_key IS NOT NULL`,
  `CREATE INDEX tavi_memory_scope_idx ON tavi_memory_records (scope_key, status, kind)`,
  `CREATE INDEX tavi_memory_principal_idx ON tavi_memory_records (principal_id, workspace_id, status)`,
  `CREATE INDEX tavi_memory_validity_idx ON tavi_memory_records (status, valid_from, valid_to)`,
  `CREATE INDEX tavi_memory_expiry_idx ON tavi_memory_records (expiry_at)`,
  `CREATE INDEX tavi_memory_records_topic_idx ON tavi_memory_records (kind, topic_key)
  WHERE topic_key IS NOT NULL`,
  `CREATE INDEX tavi_memory_origin_task_idx ON tavi_memory_records (origin_task_id) WHERE origin_task_id IS NOT NULL`,
  `CREATE INDEX tavi_memory_chat_notes_idx ON tavi_memory_records (run_id) WHERE scope_kind = 'run_local' AND durable = 1`,
  `CREATE INDEX tavi_memory_content_key_idx ON tavi_memory_records (scope_key, kind, content_key)`,
  `CREATE TABLE tavi_memory_revisions (
  revision_id       TEXT PRIMARY KEY,
  record_id         TEXT NOT NULL REFERENCES tavi_memory_records(record_id) ON DELETE CASCADE,
  revision_number   INTEGER NOT NULL,
  schema_version    INTEGER NOT NULL,
  title             TEXT,
  body              TEXT,
  artifact_id       TEXT,
  content_hash      TEXT NOT NULL,
  author            TEXT NOT NULL,
  source_ids_json   TEXT NOT NULL DEFAULT '[]',
  observed_at       TEXT,
  recorded_at       TEXT NOT NULL,
  sensitivity       TEXT NOT NULL CHECK (sensitivity IN ('normal','sensitive')),
  preference_key    TEXT,
  preference_type   TEXT CHECK (preference_type IN ('string','number','boolean','json')),
  preference_value  TEXT, status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','superseded','revoked')), superseded_by_revision_id TEXT, valid_from TEXT, valid_to TEXT, provenance_json TEXT, keywords_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (record_id, revision_number)
)`,
  `CREATE INDEX tavi_memory_revision_record_idx ON tavi_memory_revisions (record_id, revision_number DESC)`,
  `CREATE TABLE tavi_evidence_sources (
  source_id         TEXT PRIMARY KEY,
  scope_key         TEXT NOT NULL,
  record_id         TEXT,
  revision_id       TEXT,
  conversation_id   TEXT,
  message_id        TEXT,
  artifact_id       TEXT,
  operator_input    INTEGER NOT NULL DEFAULT 0 CHECK (operator_input IN (0,1)),
  observed_at       TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  capture_basis     TEXT NOT NULL,
  retention_policy  TEXT NOT NULL,
  revocation_status TEXT NOT NULL CHECK (revocation_status IN ('active','revoked')),
  access_revoked_at TEXT,
  claimed_author    TEXT
)`,
  `CREATE INDEX tavi_evidence_scope_idx ON tavi_evidence_sources (scope_key, revocation_status)`,
  `CREATE INDEX tavi_evidence_revision_idx ON tavi_evidence_sources (revision_id)`,
  `CREATE TABLE tavi_memory_reviews (
  review_id             TEXT PRIMARY KEY,
  record_id             TEXT NOT NULL,
  revision_id           TEXT NOT NULL,
  revision_hash         TEXT NOT NULL,
  reviewer_principal_id TEXT NOT NULL,
  decision              TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason                TEXT,
  decided_at            TEXT NOT NULL
)`,
  `CREATE INDEX tavi_memory_reviews_record_idx ON tavi_memory_reviews (record_id, decided_at DESC)`,
  `CREATE TABLE tavi_lineage_edges (
  edge_id                 TEXT PRIMARY KEY,
  from_revision_id        TEXT NOT NULL,
  to_revision_id          TEXT NOT NULL,
  claim_id                TEXT,
  dependency_kind         TEXT NOT NULL CHECK (dependency_kind IN ('contains','requires','background')),
  derived_freshness       TEXT NOT NULL CHECK (derived_freshness IN ('clean','dirty','blocked')),
  freshness_reason        TEXT,
  affected_source_ids_json TEXT NOT NULL DEFAULT '[]',
  last_validated_generation INTEGER NOT NULL DEFAULT 0,
  UNIQUE (from_revision_id, to_revision_id, dependency_kind)
)`,
  `CREATE INDEX tavi_lineage_to_idx ON tavi_lineage_edges (to_revision_id, derived_freshness)`,
  `CREATE TABLE tavi_memory_deletions (
  deletion_id         TEXT PRIMARY KEY,
  record_id           TEXT NOT NULL,
  scope_key           TEXT NOT NULL,
  deletion_generation INTEGER NOT NULL,
  requested_by        TEXT NOT NULL,
  reason              TEXT NOT NULL,
  requested_at        TEXT NOT NULL,
  cleanup_status      TEXT NOT NULL CHECK (cleanup_status IN ('pending','complete')),
  cleaned_at          TEXT
, pending_providers_json TEXT)`,
  `CREATE INDEX tavi_memory_deletions_scope_idx ON tavi_memory_deletions (scope_key, deletion_generation DESC)`,
  `CREATE TABLE tavi_memory_scope_generations (
  scope_key            TEXT PRIMARY KEY,
  revocation_generation INTEGER NOT NULL DEFAULT 0
)`,
  `CREATE TABLE tavi_memory_fts_map (
  row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id TEXT NOT NULL UNIQUE
)`,
  `CREATE VIRTUAL TABLE tavi_memory_fts USING fts5(
  title,
  body,
  keys,
  tokenize = "unicode61 remove_diacritics 2"
)`,
  `CREATE VIRTUAL TABLE tavi_memory_fts_stem USING fts5(
  title,
  body,
  keys,
  tokenize = "porter unicode61 remove_diacritics 2"
)`,
  `CREATE TABLE tavi_task_memory_use (
  task_id           TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  record_id         TEXT NOT NULL,
  first_used_at     TEXT NOT NULL,
  last_used_at      TEXT NOT NULL,
  last_admission_id TEXT NOT NULL,
  PRIMARY KEY (task_id, record_id)
)`,
  `CREATE INDEX tavi_task_memory_use_recent_idx ON tavi_task_memory_use (task_id, last_used_at DESC)`,
  // TRAP FOR LATER MIGRATIONS: `notice_id` cascades from `tavi_chat_notices`, and migrations run with
  // `foreign_keys = ON`, so a rebuild of the notices table (`DROP TABLE`) deletes every memory card's rows. Copy
  // this table aside first and restore it after. `record_id` has no foreign key: forget deletes a record's rows itself.
  `CREATE TABLE tavi_memory_prompts (
  token        TEXT PRIMARY KEY,
  notice_id    TEXT NOT NULL REFERENCES tavi_chat_notices (notice_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  number       INTEGER NOT NULL CHECK (number >= 1),
  created_at   TEXT NOT NULL,
  settled_at   TEXT,
  UNIQUE (notice_id, record_id),
  UNIQUE (notice_id, number)
)`,
  `CREATE INDEX tavi_memory_prompts_record_idx ON tavi_memory_prompts (record_id)`,
  `CREATE INDEX tavi_memory_prompts_settled_idx ON tavi_memory_prompts (settled_at)`,
  // Every kind a later step needs is in the CHECK already, because widening a CHECK needs a rebuild.
  `CREATE TABLE tavi_memory_marks (
  task_id TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  kind    TEXT NOT NULL CHECK (kind IN ('review', 'flush', 'digest', 'consolidate', 'fresh')),
  mark    TEXT NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (task_id, kind, mark)
)`,
  `CREATE INDEX tavi_memory_marks_kind_idx ON tavi_memory_marks (kind, task_id, at)`,
  `CREATE TABLE tavi_memory_vectors (
  revision_id TEXT NOT NULL REFERENCES tavi_memory_revisions (revision_id) ON DELETE CASCADE,
  model_key   TEXT NOT NULL,
  dims        INTEGER NOT NULL CHECK (dims > 0),
  vector      BLOB NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (revision_id, model_key)
)`,
  `CREATE INDEX tavi_memory_vectors_model_idx ON tavi_memory_vectors (model_key)`,
  `CREATE TABLE tavi_memory_vector_failures (
  revision_id TEXT NOT NULL REFERENCES tavi_memory_revisions (revision_id) ON DELETE CASCADE,
  model_key   TEXT NOT NULL,
  failures    INTEGER NOT NULL CHECK (failures > 0),
  failed_at   TEXT NOT NULL,
  PRIMARY KEY (revision_id, model_key)
)`,

  // ── Skills ──────────────────────────────────────────────────────────────────────────────────────────────
  // Approved skills are immutable versions pinned by content hash; activation is a compare-and-set pointer with an
  // audit trail. A rollout allowlist row bounds one version to an explicit task set.
  `CREATE TABLE tavi_skill_versions (
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
  PRIMARY KEY (skill_id, version)
)`,
  `CREATE INDEX tavi_skill_versions_scope_idx ON tavi_skill_versions (scope_key, skill_id, review_state)`,
  `CREATE TABLE tavi_skill_activations (
  scope_key       TEXT NOT NULL,
  skill_id        TEXT NOT NULL,
  active_version   TEXT NOT NULL,
  activated_by     TEXT NOT NULL,
  activated_at     TEXT NOT NULL,
  PRIMARY KEY (scope_key, skill_id),
  FOREIGN KEY (skill_id, active_version) REFERENCES tavi_skill_versions(skill_id, version)
)`,
  `CREATE TABLE "tavi_skill_activation_history" (
  history_id       TEXT PRIMARY KEY,
  scope_key         TEXT NOT NULL,
  skill_id          TEXT NOT NULL,
  previous_version   TEXT,
  new_version        TEXT,
  reason             TEXT NOT NULL CHECK (reason IN ('activate','rollback','disable')),
  actor               TEXT NOT NULL,
  at                  TEXT NOT NULL
)`,
  `CREATE INDEX tavi_skill_activation_history_idx ON tavi_skill_activation_history (scope_key, skill_id, at DESC)`,
  // No foreign key to `tavi_tasks`: an operator may pre-authorize a task id before the task is admitted.
  `CREATE TABLE tavi_skill_rollout_allowlist (
  entry_id       TEXT PRIMARY KEY,
  scope_key      TEXT NOT NULL,
  skill_id       TEXT NOT NULL,
  version        TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  authorized_by  TEXT NOT NULL,
  authorized_at  TEXT NOT NULL,
  UNIQUE (scope_key, skill_id, version, task_id)
)`,
  `CREATE INDEX tavi_skill_rollout_allowlist_triple_idx ON tavi_skill_rollout_allowlist (scope_key, skill_id, version)`,

  // ── Agents and delegation ───────────────────────────────────────────────────────────────────────────────
  // Delegation and the agent mailbox. A wait is `prepared` before its task suspends and `active` once
  // the suspending checkpoint is durable; the partial unique indexes enforce at most one active wait per task (and
  // per correlation), which the store's lookups assume. A spawn's idempotency key maps to the worker it created, so a
  // crash cannot lose or duplicate the requested task. An agent definition is instructions, not authority: it
  // carries no tool allowlist and no credential.
  `CREATE TABLE tavi_agent_mailbox (
  message_id          TEXT PRIMARY KEY,
  protocol_version     INTEGER NOT NULL,
  workspace_id          TEXT NOT NULL,
  sender_agent_id        TEXT NOT NULL,
  -- Deliberately no REFERENCES/CASCADE from sender_task_id: a delivered
  -- envelope is the recipient's durable record, and the sender's own task
  -- being deleted should not retroactively delete mail it already sent
  -- (unlike recipient_task_id below, whose row this envelope belongs to).
  sender_task_id          TEXT NOT NULL,
  recipient_agent_id       TEXT NOT NULL,
  recipient_task_id         TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  kind                       TEXT NOT NULL CHECK (kind IN ('message','request','reply','progress','result')),
  correlation_id             TEXT,
  causation_id                TEXT,
  created_at                   TEXT NOT NULL,
  expires_at                    TEXT,
  -- Defense in depth only: the real 2-KiB UTF-8 bound is enforced by
  -- AgentEnvelopeSchema's TextEncoder-based refine before a row ever
  -- reaches here. SQLite's length() counts characters, not UTF-8 bytes, so
  -- this bound is deliberately looser (4 bytes/char worst case) rather than
  -- an exact match — it exists only to catch a writer that bypassed schema
  -- validation entirely, not to duplicate the byte-exact application rule.
  content                        TEXT CHECK (content IS NULL OR length(content) <= 2048),
  artifact_id                     TEXT REFERENCES tavi_artifacts(artifact_id),
  delivery_state                   TEXT NOT NULL
    CHECK (delivery_state IN ('pending','delivered','acknowledged','expired','rejected','cancelled','dead-letter')),
  retention_state                   TEXT NOT NULL DEFAULT 'active'
    CHECK (retention_state IN ('active','archived','tombstoned')),
  lease_id                            TEXT,
  lease_expires_at                     TEXT
, label_json TEXT)`,
  `CREATE INDEX tavi_agent_mailbox_recipient_idx
  ON tavi_agent_mailbox (recipient_task_id, delivery_state, created_at)`,
  `CREATE INDEX tavi_agent_mailbox_correlation_idx
  ON tavi_agent_mailbox (correlation_id) WHERE correlation_id IS NOT NULL`,
  `CREATE INDEX tavi_agent_mailbox_retention_idx
  ON tavi_agent_mailbox (workspace_id, retention_state, delivery_state)`,
  `CREATE TABLE tavi_agent_wait_intents (
  wait_id                TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  correlation_id            TEXT,
  waiting_on_worker_task_id   TEXT,
  deadline_at                  TEXT NOT NULL,
  state                         TEXT NOT NULL CHECK (state IN ('prepared','active','settled')),
  settled_outcome_json            TEXT
, choices_json TEXT, settled_at TEXT, resume_pending INTEGER NOT NULL DEFAULT 0, settled_by TEXT, settled_via TEXT, question TEXT, handoff_json TEXT, connect_json TEXT)`,
  `CREATE INDEX tavi_agent_wait_intents_task_idx ON tavi_agent_wait_intents (task_id, state)`,
  `CREATE INDEX tavi_agent_wait_intents_deadline_idx
  ON tavi_agent_wait_intents (state, deadline_at) WHERE state = 'active'`,
  `CREATE UNIQUE INDEX tavi_agent_wait_intents_active_correlation_uidx
  ON tavi_agent_wait_intents (task_id, correlation_id)
  WHERE state = 'active' AND correlation_id IS NOT NULL`,
  `CREATE UNIQUE INDEX tavi_agent_wait_intents_active_task_uidx
  ON tavi_agent_wait_intents (task_id)
  WHERE state = 'active'`,
  `CREATE INDEX tavi_agent_wait_intents_settled_idx ON tavi_agent_wait_intents (settled_at DESC) WHERE state = 'settled'`,
  `CREATE INDEX tavi_agent_wait_intents_resume_pending_idx ON tavi_agent_wait_intents (settled_at) WHERE resume_pending = 1`,
  `CREATE TABLE tavi_agent_delegation_admissions (
  workspace_id       TEXT NOT NULL,
  principal_id        TEXT NOT NULL,
  operation_key         TEXT NOT NULL,
  worker_task_id          TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  worker_agent_id           TEXT NOT NULL,
  created_at                 TEXT NOT NULL, shared_memory_record_ids TEXT, depth INTEGER NOT NULL DEFAULT 1, budget TEXT, agent_definition_id TEXT, parent_task_id TEXT, root_task_id TEXT, held_channel TEXT CHECK (held_channel IS NULL OR held_channel IN ('messaging')), front_end TEXT CHECK (front_end IS NULL OR front_end IN ('web', 'ipc')), held_connection_id TEXT,
  PRIMARY KEY (workspace_id, principal_id, operation_key)
)`,
  `CREATE UNIQUE INDEX tavi_agent_delegation_admissions_worker_task_uidx
  ON tavi_agent_delegation_admissions (worker_task_id)`,
  `CREATE INDEX tavi_delegation_parent_idx ON tavi_agent_delegation_admissions(workspace_id, parent_task_id, worker_task_id)`,
  `CREATE INDEX tavi_delegation_root_idx ON tavi_agent_delegation_admissions(workspace_id, root_task_id, worker_task_id)`,
  `CREATE TABLE tavi_agent_definitions (
  agent_id       TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  system_prompt  TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id)
)`,
  `CREATE INDEX tavi_agent_definitions_workspace_idx ON tavi_agent_definitions (workspace_id, name)`,

  // ── Messaging channels ──────────────────────────────────────────────────────────────────────────────────
  // Inbound events are deduplicated by the provider's own stable key before they are acknowledged upstream, never by
  // a fresh id per retry; outbound sends are recorded `pending` before the connector is called, so a
  // restart can tell whether a send was attempted. One external conversation maps to one task per epoch (`/new`
  // starts another), the newest `active`. An identity binding links one external sender on one connection to
  // exactly one principal.
  `CREATE TABLE tavi_messaging_connections (
      connection_id         TEXT PRIMARY KEY,
      provider_id           TEXT NOT NULL,
      workspace_id          TEXT NOT NULL,
      label                 TEXT,
      account_identity      TEXT NOT NULL,
      settings_json         TEXT NOT NULL,
      credential_refs_json  TEXT NOT NULL,
      enabled               INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      config_revision       INTEGER NOT NULL CHECK (config_revision >= 1),
      auth_state            TEXT NOT NULL CHECK (auth_state IN ('none', 'connected', 'expired', 'revoked', 'needs-consent')),
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    , deleted_at TEXT)`,
  `CREATE INDEX tavi_messaging_connections_workspace ON tavi_messaging_connections (workspace_id, created_at)`,
  `CREATE TABLE tavi_channel_ingress (
      singleton   INTEGER PRIMARY KEY CHECK (singleton = 1),
      host        TEXT NOT NULL,
      port        INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
      public_url  TEXT,
      updated_at  TEXT NOT NULL
    )`,
  `CREATE TABLE tavi_messaging_inbox (
  connection_id       TEXT NOT NULL,
  provider_event_id      TEXT NOT NULL,
  kind                       TEXT NOT NULL,
  payload_json                  TEXT NOT NULL,
  state                            TEXT NOT NULL CHECK (state IN ('received','processed')),
  received_at                        TEXT NOT NULL, replay_claimed_at TEXT,
  PRIMARY KEY (connection_id, provider_event_id)
)`,
  `CREATE INDEX tavi_messaging_inbox_state_idx ON tavi_messaging_inbox (connection_id, state)`,
  `CREATE TABLE tavi_messaging_outbox (
  effect_id       TEXT PRIMARY KEY,
  connection_id      TEXT NOT NULL,
  message_json          TEXT NOT NULL,
  state                    TEXT NOT NULL CHECK (state IN ('pending','resolved')),
  outcome_json                TEXT,
  created_at                     TEXT NOT NULL,
  resolved_at                     TEXT
)`,
  `CREATE INDEX tavi_messaging_outbox_pending_idx ON tavi_messaging_outbox (connection_id, state)`,
  `CREATE INDEX tavi_messaging_outbox_sent_idx ON tavi_messaging_outbox (connection_id, created_at)`,
  `CREATE TABLE tavi_messaging_deliveries (
  connection_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  status TEXT CHECK (status IS NULL OR status IN ('delivered', 'read', 'bounced', 'failed')),
  status_at TEXT,
  detail TEXT,
  PRIMARY KEY (connection_id, provider_message_id)
)`,
  `CREATE INDEX tavi_messaging_deliveries_effect_idx ON tavi_messaging_deliveries (effect_id)`,
  `CREATE INDEX tavi_messaging_deliveries_status_idx ON tavi_messaging_deliveries (status, status_at)`,
  `CREATE TABLE tavi_messaging_identity_bindings (
  connection_id       TEXT NOT NULL,
  external_sender_id     TEXT NOT NULL,
  workspace_id               TEXT NOT NULL,
  principal_id                   TEXT NOT NULL,
  approved_by                        TEXT NOT NULL,
  created_at                             TEXT NOT NULL, display_name TEXT, trust_unverified_by TEXT, trust_unverified_at TEXT,
  PRIMARY KEY (connection_id, external_sender_id)
)`,
  `CREATE TABLE tavi_messaging_inbound_activity (
  connection_id        TEXT NOT NULL,
  conversation_key     TEXT NOT NULL,
  workspace_id         TEXT NOT NULL,
  sender_principal_id  TEXT NOT NULL,
  provider_event_id    TEXT NOT NULL,
  task_id              TEXT,
  received_at          TEXT NOT NULL,
  PRIMARY KEY (connection_id, conversation_key)
)`,
  `CREATE INDEX tavi_messaging_inbound_activity_idx ON tavi_messaging_inbound_activity (workspace_id, received_at)`,
  `CREATE TABLE "tavi_messaging_conversation_tasks" (
  connection_id            TEXT NOT NULL,
  external_conversation_id TEXT NOT NULL,
  epoch                    INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  task_id                  TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  created_at               TEXT NOT NULL,
  reply_to_json            TEXT,
  reset_at                 TEXT, withdrawn_at TEXT, provider_id TEXT, conversation_kind TEXT CHECK (conversation_kind IS NULL OR conversation_kind IN ('direct', 'group', 'thread')),
  PRIMARY KEY (connection_id, external_conversation_id, epoch)
)`,
  `CREATE INDEX tavi_messaging_conversation_tasks_task_idx ON tavi_messaging_conversation_tasks (task_id)`,
  `CREATE UNIQUE INDEX tavi_messaging_conversation_tasks_active_idx ON tavi_messaging_conversation_tasks (connection_id, external_conversation_id) WHERE active = 1`,
  `CREATE TABLE tavi_messaging_grants (
  grant_id      TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  scope_kind    TEXT NOT NULL CHECK (scope_kind IN ('room', 'contact')),
  scope_id      TEXT NOT NULL,
  tool_id       TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('allow', 'deny')),
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT,
  revoked_at    TEXT,
  UNIQUE (connection_id, scope_kind, scope_id, tool_id)
)`,
  `CREATE TABLE tavi_channel_rooms (
  connection_id   TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  label           TEXT NOT NULL,
  trigger_json    TEXT NOT NULL,
  members         TEXT NOT NULL CHECK (members IN ('bound', 'operator-only')),
  context         TEXT NOT NULL DEFAULT 'off' CHECK (context IN ('off', 'recent')),
  intro_state     TEXT NOT NULL CHECK (intro_state IN ('pending', 'sent', 'uncertain')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  disabled_at     TEXT, auto_thread INTEGER NOT NULL DEFAULT 0 CHECK (auto_thread IN (0, 1)),
  PRIMARY KEY (connection_id, conversation_id)
)`,
  `CREATE TABLE tavi_channel_purges (
  connection_id TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  provider_id   TEXT NOT NULL,
  account_ref   TEXT NOT NULL,
  requested_at  TEXT NOT NULL,
  purge_after   TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('scheduled', 'cancelled', 'running', 'done')),
  counts_json   TEXT,
  finished_at   TEXT
)`,
  `CREATE INDEX tavi_channel_purges_due_idx ON tavi_channel_purges (state, purge_after)`,

  // ── Tool policy and approvals ───────────────────────────────────────────────────────────────────────────
  // Operator rules per workspace and the session grants a `session` approval creates, which die with their task.
  // Approval rounds as the channels see them: a token a person can type, where it was announced, when it
  // expires, and single-use links. Seeded rules are recorded so a rule the operator revoked is never
  // seeded again. Gate observations keep tool ids, sinks and reasons only, never a call's arguments.
  `CREATE TABLE tavi_tool_rules (
  workspace_id TEXT NOT NULL,
  rule_id      TEXT NOT NULL,
  tool_pattern TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
  rule_json    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, rule_id)
)`,
  `CREATE TABLE tavi_tool_rule_seeds (
 workspace_id TEXT NOT NULL,
 rule_id TEXT NOT NULL,
 seeded_at TEXT NOT NULL,
 PRIMARY KEY (workspace_id, rule_id)
) WITHOUT ROWID`,
  `CREATE TABLE tavi_session_grants (
  grant_id     TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  tool_id      TEXT NOT NULL,
  grant_json   TEXT NOT NULL,
  created_at   TEXT NOT NULL
)`,
  `CREATE INDEX tavi_session_grants_task_idx ON tavi_session_grants (task_id)`,
  `CREATE TABLE tavi_approval_rounds (
  task_id          TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  steps            INTEGER NOT NULL,
  token            TEXT NOT NULL UNIQUE,
  workspace_id     TEXT NOT NULL,
  connection_id    TEXT,
  conversation_id  TEXT,
  message_ids_json TEXT NOT NULL,
  expires_at       TEXT,
  settled_at       TEXT,
  created_at       TEXT NOT NULL, risk TEXT, call_scopes_json TEXT,
  PRIMARY KEY (task_id, steps)
)`,
  `CREATE INDEX tavi_approval_rounds_expiry_idx ON tavi_approval_rounds (expires_at) WHERE settled_at IS NULL`,
  `CREATE TABLE tavi_approval_events (
  event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  steps       INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  via         TEXT,
  actor       TEXT,
  detail_json TEXT,
  at          TEXT NOT NULL
)`,
  `CREATE INDEX tavi_approval_events_task_idx ON tavi_approval_events (task_id, steps)`,
  `CREATE TABLE tavi_approval_links (
  token_hash TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('round', 'question')),
  steps      INTEGER,
  wait_id    TEXT,
  choice     TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
)`,
  `CREATE INDEX tavi_approval_links_round_idx ON tavi_approval_links (task_id, kind, steps)`,
  `CREATE TABLE tavi_approval_round_deliveries (
  task_id          TEXT NOT NULL,
  steps            INTEGER NOT NULL,
  connection_id    TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('card', 'notice')),
  destination_json TEXT NOT NULL,
  message_ids_json TEXT NOT NULL,
  text             TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (task_id, steps, connection_id, role),
  FOREIGN KEY (task_id, steps) REFERENCES tavi_approval_rounds (task_id, steps) ON DELETE CASCADE
)`,
  `CREATE INDEX tavi_approval_round_deliveries_connection_idx ON tavi_approval_round_deliveries (connection_id)`,
  `CREATE TABLE tavi_need_deliveries (
  wait_id             TEXT NOT NULL REFERENCES tavi_agent_wait_intents (wait_id) ON DELETE CASCADE,
  task_id             TEXT NOT NULL,
  connection_id       TEXT NOT NULL,
  destination_json    TEXT NOT NULL,
  provider_message_id TEXT,
  text                TEXT NOT NULL,
  token               TEXT NOT NULL,
  selected_json       TEXT NOT NULL,
  created_at          TEXT NOT NULL, chat_id TEXT, thread_id TEXT,
  PRIMARY KEY (wait_id, connection_id)
)`,
  `CREATE INDEX tavi_need_deliveries_token_idx ON tavi_need_deliveries (token)`,
  `CREATE INDEX tavi_need_deliveries_message_idx ON tavi_need_deliveries (connection_id, chat_id, provider_message_id) WHERE provider_message_id IS NOT NULL`,
  `CREATE TABLE tavi_pending_reject_reasons (
  reason_key        TEXT PRIMARY KEY,
  token             TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  principal_id      TEXT NOT NULL,
  caller            TEXT NOT NULL,
  reply_target_json TEXT NOT NULL,
  expires_at        TEXT NOT NULL
)`,
  `CREATE INDEX tavi_pending_reject_reasons_expiry_idx ON tavi_pending_reject_reasons (expires_at)`,
  `CREATE TABLE tavi_gate_observations (
  task_id           TEXT NOT NULL,
  call_id           TEXT NOT NULL,
  tool_id           TEXT NOT NULL,
  effect            TEXT NOT NULL CHECK (effect IN ('read-only', 'mutating', 'external')),
  sink              TEXT,
  decision_enforced TEXT NOT NULL CHECK (decision_enforced IN ('allow', 'ask', 'deny')),
  decision_observed TEXT NOT NULL CHECK (decision_observed IN ('allow', 'ask', 'deny')),
  gate_reason       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (task_id, call_id)
)`,
  `CREATE INDEX tavi_gate_observations_created_idx ON tavi_gate_observations (created_at)`,

  // ── Chats ───────────────────────────────────────────────────────────────────────────────────────────────
  // A chat's saved history (one row per admission), its own instructions by revision (nothing overwritten,
  // so a turn names the revision it ran under), steering messages waiting for a running turn, base-prompt pins
  // and notices. The notices' `kind` CHECK can only be widened by rebuilding the table: see the trap
  // note on `tavi_memory_prompts`.
  `CREATE TABLE tavi_transcript_entries (
  task_id      TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq > 0),
  admission_id TEXT,
  turn_json    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
)`,
  `CREATE UNIQUE INDEX tavi_transcript_entries_admission_idx ON tavi_transcript_entries (task_id, admission_id) WHERE admission_id IS NOT NULL`,
  `CREATE TABLE tavi_chat_instructions (
  task_id     TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL CHECK (revision >= 1),
  text        TEXT NOT NULL,
  author      TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
)`,
  `CREATE TABLE tavi_chat_steers (
  steer_id        TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  text            TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'consumed', 'queued')),
  admission_id    TEXT,
  created_at      TEXT NOT NULL
)`,
  `CREATE UNIQUE INDEX tavi_chat_steers_message_idx ON tavi_chat_steers (task_id, message_id)`,
  `CREATE INDEX tavi_chat_steers_open_idx ON tavi_chat_steers (task_id, state, created_at)`,
  `CREATE TABLE "tavi_chat_notices" (
  notice_id         TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  source_key        TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('run-result', 'run-settled', 'side-chat-settled', 'earlier-chats', 'reminder', 'conversation', 'epoch', 'folder', 'heartbeat', 'memory', 'mcp')),
  source_task_id    TEXT,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  after_seq         INTEGER NOT NULL CHECK (after_seq >= 0),
  read_by           TEXT,
  created_at        TEXT NOT NULL,
  artifact_id       TEXT,
  heartbeat_item_id TEXT
)`,
  `CREATE UNIQUE INDEX tavi_chat_notices_source_idx ON tavi_chat_notices (task_id, source_key)`,
  `CREATE INDEX tavi_chat_notices_task_idx ON tavi_chat_notices (task_id, after_seq, created_at)`,
  `CREATE TABLE tavi_task_prompt_pins (
  task_id           TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  pin               INTEGER NOT NULL CHECK (pin > 0),
  source            TEXT NOT NULL CHECK (source IN ('workspace', 'builtin')),
  text              TEXT NOT NULL,
  hash              TEXT NOT NULL,
  settings_revision INTEGER CHECK (settings_revision IS NULL OR settings_revision >= 0),
  template_version  TEXT,
  bound_at          TEXT NOT NULL,
  CHECK (source <> 'workspace' OR (settings_revision IS NOT NULL AND template_version IS NULL)),
  CHECK (source <> 'builtin' OR (settings_revision IS NULL AND template_version IS NOT NULL)),
  PRIMARY KEY (task_id, pin)
)`,

  // ── System prompts ──────────────────────────────────────────────────────────────────────────────────────
  // The operator's current override, one row per workspace and kept after a reset so a stale revision can never match
  // again; and the base each task selected at admission, immutable for that task. Nothing prunes either table.
  `CREATE TABLE tavi_workspace_system_prompts (
 workspace_id TEXT PRIMARY KEY,
 text TEXT,
 revision INTEGER NOT NULL CHECK (revision >= 0),
 last_operation TEXT CHECK (last_operation IS NULL OR last_operation IN ('set', 'reset')),
 previous_revision INTEGER CHECK (previous_revision IS NULL OR previous_revision >= 0),
 actor TEXT,
 hash TEXT,
 updated_at TEXT NOT NULL,
 -- The hash describes the stored text, so the two cannot disagree in the row.
 CHECK ((text IS NULL) = (hash IS NULL))
)`,
  `CREATE TABLE tavi_task_prompt_snapshots (
 task_id TEXT PRIMARY KEY REFERENCES tavi_tasks(task_id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK (source IN ('workspace', 'builtin', 'explicit')),
 text TEXT NOT NULL,
 hash TEXT NOT NULL,
 settings_revision INTEGER CHECK (settings_revision IS NULL OR settings_revision >= 0),
 template_version TEXT,
 bound_at TEXT NOT NULL,
 -- Mirrors the Zod discriminated union as far as SQL states it, as a second line
 -- rather than a replacement: a row which cannot describe any source the schema
 -- knows never lands. That the hash is the hash of the text is the reader's check
 -- (readTaskPromptSnapshot refuses the row as INTERNAL), not the table's.
 CHECK (source <> 'workspace' OR settings_revision IS NOT NULL),
 CHECK (source <> 'builtin' OR template_version IS NOT NULL),
 CHECK (source <> 'explicit' OR (settings_revision IS NULL AND template_version IS NULL))
)`,
  `CREATE INDEX tavi_task_prompt_snapshots_workspace_idx ON tavi_task_prompt_snapshots(workspace_id)`,

  // ── Schedules, projects and reports ─────────────────────────────────────────────────────────────────────
  // `next_run_at` is persisted rather than derived, so a fire missed while the machine slept is detectable at boot
  // instead of silently skipped. Schedule names are unique per workspace: two an operator cannot tell apart are a
  // configuration bug. A report stores the numbers its PDF was rendered from, because a PDF is not queryable.
  `CREATE TABLE tavi_schedules (
  schedule_id               TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL,
  principal_id              TEXT NOT NULL,
  name                      TEXT NOT NULL,
  prompt                    TEXT NOT NULL,
  spec_json                 TEXT NOT NULL,
  missed_run_policy         TEXT NOT NULL,
  auto_approve_tools_json   TEXT NOT NULL,
  alert_json                TEXT,
  enabled                   INTEGER NOT NULL DEFAULT 1,
  next_run_at               TEXT,
  last_run_at               TEXT,
  last_run_task_id          TEXT,
  last_outcome              TEXT,
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
, agent_id TEXT, human_checkpoints TEXT, deliver_to TEXT CHECK (deliver_to IS NULL OR deliver_to IN ('home')))`,
  `CREATE UNIQUE INDEX tavi_schedules_name_uidx ON tavi_schedules (workspace_id, name)`,
  `CREATE INDEX tavi_schedules_due_idx ON tavi_schedules (next_run_at) WHERE enabled = 1`,
  `CREATE TABLE tavi_projects (
  workspace_id              TEXT NOT NULL,
  project_id                TEXT NOT NULL,
  name                      TEXT,
  ga4_property_id           TEXT,
  gsc_site_url              TEXT,
  gcp_billing_project_id    TEXT,
  gcp_billing_table         TEXT,
  stripe_credential_ref     TEXT,
  keywords_json             TEXT,
  language                  TEXT,
  region                    TEXT,
  enabled                   INTEGER NOT NULL DEFAULT 1,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id)
)`,
  `CREATE INDEX tavi_projects_enabled_idx ON tavi_projects (workspace_id, enabled, project_id)`,
  `CREATE TABLE tavi_collector_settings (
  workspace_id                TEXT PRIMARY KEY,
  google_service_account_ref  TEXT,
  lookback_days               INTEGER,
  news_feed_urls_json         TEXT,
  news_max_items              INTEGER,
  news_search_credential_ref  TEXT,
  updated_at                  TEXT NOT NULL
)`,
  `CREATE TABLE tavi_reports (
  report_id     TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  generated_at  TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  pages         INTEGER,
  projects_json TEXT NOT NULL
)`,
  `CREATE INDEX tavi_reports_history_idx ON tavi_reports (workspace_id, generated_at DESC)`,

  // ── Routines ────────────────────────────────────────────────────────────────────────────────────────────
  // Agent routines: revisions, triggers, runs, their ledger and delivery, news sources, control and quality. A run's
  // grant is written in the same transaction as the run, so no run exists without the authority it was admitted
  // under; `run_id` UNIQUE is the only index the grants need, since every statement keys on it.
  `CREATE TABLE tavi_routines (
 routine_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 name TEXT NOT NULL, version INTEGER NOT NULL, active_revision INTEGER, latest_revision INTEGER NOT NULL,
 status TEXT NOT NULL, conversation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`,
  `CREATE INDEX tavi_routines_scope_idx ON tavi_routines(workspace_id, principal_id, updated_at, routine_id)`,
  `CREATE TABLE tavi_routine_revisions (
 routine_id TEXT NOT NULL REFERENCES tavi_routines(routine_id), revision INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL, hash TEXT NOT NULL, author TEXT NOT NULL, change_summary TEXT NOT NULL, created_at TEXT NOT NULL, provenance_json TEXT,
 PRIMARY KEY(routine_id, revision)
)`,
  `CREATE TABLE tavi_agent_revisions (
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, agent_id TEXT NOT NULL, revision INTEGER NOT NULL,
 name TEXT NOT NULL, instructions TEXT NOT NULL, hash TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id, principal_id, agent_id, revision)
)`,
  `CREATE TABLE tavi_routine_evaluations (
 evaluation_id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES tavi_routines(routine_id), revision INTEGER NOT NULL,
 status TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT,
 UNIQUE(routine_id, revision)
)`,
  `CREATE TABLE tavi_routine_operations (
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation_key TEXT NOT NULL, kind TEXT NOT NULL,
 request_hash TEXT NOT NULL, routine_id TEXT NOT NULL REFERENCES tavi_routines(routine_id), revision INTEGER NOT NULL,
 PRIMARY KEY(workspace_id, principal_id, operation_key, kind)
)`,
  `CREATE TABLE tavi_routine_triggers (
 routine_id TEXT NOT NULL REFERENCES tavi_routines(routine_id), trigger_id TEXT NOT NULL,
 schedule_id TEXT NOT NULL UNIQUE REFERENCES tavi_schedules(schedule_id), spec_json TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, adopted_snapshot TEXT,
 PRIMARY KEY(routine_id, trigger_id)
)`,
  `CREATE TABLE tavi_routine_state (
 routine_id TEXT PRIMARY KEY REFERENCES tavi_routines(routine_id), version INTEGER NOT NULL,
 state_json TEXT NOT NULL, research_failures INTEGER NOT NULL DEFAULT 0, delivery_failures INTEGER NOT NULL DEFAULT 0,
 research_blocked_since TEXT, delivery_blocked_since TEXT, heartbeat_at TEXT
)`,
  `CREATE TABLE tavi_routine_runs (
 run_id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES tavi_routines(routine_id), workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 occurrence_key TEXT NOT NULL, trigger_id TEXT, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
 mode TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, task_id TEXT,
 scheduled_for TEXT, claimed_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, data_json TEXT NOT NULL, grant_id TEXT,
 UNIQUE(routine_id, occurrence_key)
)`,
  `CREATE INDEX tavi_routine_runs_history_idx ON tavi_routine_runs(routine_id, claimed_at DESC, run_id)`,
  `CREATE INDEX tavi_routine_runs_task_idx ON tavi_routine_runs (task_id) WHERE task_id IS NOT NULL`,
  `CREATE INDEX tavi_routine_runs_failed_idx ON tavi_routine_runs (workspace_id, status, ended_at)`,
  `CREATE TABLE tavi_routine_attempts (
 attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES tavi_routine_runs(run_id), generation INTEGER NOT NULL,
 owner_epoch TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, heartbeat_at TEXT NOT NULL, data_json TEXT NOT NULL,
 UNIQUE(run_id, generation)
)`,
  `CREATE TABLE tavi_routine_events (
 routine_id TEXT NOT NULL REFERENCES tavi_routines(routine_id), sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
 run_id TEXT, attempt_id TEXT, kind TEXT NOT NULL, at TEXT NOT NULL, envelope_json TEXT NOT NULL, detail_id TEXT, detail_hash TEXT,
 previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL, PRIMARY KEY(routine_id, sequence)
)`,
  `CREATE TABLE tavi_routine_details (
 detail_id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES tavi_routines(routine_id), run_id TEXT, hash TEXT NOT NULL,
 payload TEXT, byte_size INTEGER NOT NULL, created_at TEXT NOT NULL, pruned_at TEXT
)`,
  `CREATE TABLE tavi_routine_delivery_targets (
 target_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, target_json TEXT NOT NULL
)`,
  `CREATE TABLE tavi_routine_delivery_jobs (
 job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES tavi_routine_runs(run_id), effect_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL, not_before TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 data_json TEXT NOT NULL
)`,
  `CREATE INDEX tavi_routine_delivery_due_idx ON tavi_routine_delivery_jobs(status, not_before)`,
  `CREATE TABLE tavi_routine_blob_refs (
 routine_id TEXT NOT NULL REFERENCES tavi_routines(routine_id), run_id TEXT NOT NULL REFERENCES tavi_routine_runs(run_id),
 artifact_id TEXT NOT NULL REFERENCES tavi_artifacts(artifact_id), hash TEXT NOT NULL, pinned INTEGER NOT NULL,
 PRIMARY KEY(run_id, artifact_id)
)`,
  `CREATE TABLE tavi_routine_sources (
 source_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES tavi_routine_runs(run_id),
 workspace_id TEXT NOT NULL, source_json TEXT NOT NULL, created_at TEXT NOT NULL
)`,
  `CREATE INDEX tavi_routine_sources_run_idx ON tavi_routine_sources(run_id, source_id)`,
  `CREATE TABLE tavi_routine_coverage (
 run_id TEXT PRIMARY KEY REFERENCES tavi_routine_runs(run_id), searches INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
)`,
  `CREATE TABLE tavi_routine_staging (
 stage_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES tavi_routine_runs(run_id),
 artifact_id TEXT NOT NULL, kind TEXT NOT NULL, relative_path TEXT NOT NULL, stage_path TEXT NOT NULL,
 hash TEXT NOT NULL, byte_size INTEGER NOT NULL, content_type TEXT NOT NULL, status TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id,kind)
)`,
  `CREATE TABLE tavi_routine_commands (
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation_key TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
 PRIMARY KEY(workspace_id,principal_id,operation_key)
)`,
  `CREATE TABLE tavi_routine_conversations (
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 routine_id TEXT NOT NULL REFERENCES tavi_routines(routine_id), updated_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,principal_id,conversation_id)
)`,
  `CREATE TABLE tavi_routine_quality (
 evaluation_id TEXT PRIMARY KEY REFERENCES tavi_routine_evaluations(evaluation_id),
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 owner_epoch TEXT NOT NULL, status TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL
)`,
  `CREATE INDEX tavi_routine_quality_cache_idx ON tavi_routine_quality(workspace_id,principal_id,fingerprint,status)`,
  `CREATE TABLE tavi_routine_grants (
 grant_id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL UNIQUE REFERENCES tavi_routine_runs(run_id),
 routine_id TEXT NOT NULL REFERENCES tavi_routines(routine_id),
 workspace_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 revision INTEGER NOT NULL, policy_revision INTEGER NOT NULL, mode TEXT NOT NULL,
 grant_json TEXT NOT NULL, grant_hash TEXT NOT NULL,
 created_at TEXT NOT NULL, revoked_at TEXT, revoked_reason TEXT
)`,
  `CREATE TABLE tavi_routine_standing_answers (
  routine_id   TEXT NOT NULL REFERENCES tavi_routines(routine_id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  question     TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (routine_id, question_key)
)`,

  // ── Plugins and MCP servers ─────────────────────────────────────────────────────────────────────────────
  // Installed plugin versions are immutable and reviewed before they run; the row pins the hash of the bytes in the
  // snapshot directory. Hook events are kept within a bound per kind, and a prune is recorded because
  // a count at its bound is not by itself a prune. MCP versions, tools and the tree index go with their plugin
  // version; notices have no version, so the MCP remove hook deletes them.
  `CREATE TABLE tavi_plugin_versions (
  plugin_id     TEXT NOT NULL,
  version       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  review_state  TEXT NOT NULL CHECK (review_state IN ('proposed', 'approved', 'rejected')),
  installed_by  TEXT NOT NULL,
  installed_at  TEXT NOT NULL,
  reviewed_by   TEXT,
  reviewed_at   TEXT, isolation TEXT CHECK (isolation IS NULL OR isolation IN ('process', 'in-process')),
  PRIMARY KEY (plugin_id, version)
)`,
  `CREATE TABLE tavi_plugin_settings (
  plugin_id      TEXT PRIMARY KEY,
  enabled        INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  active_version TEXT,
  config_json    TEXT NOT NULL,
  updated_by     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
, instances_json TEXT NOT NULL DEFAULT '[]')`,
  `CREATE TABLE tavi_plugin_state (
  plugin_id   TEXT NOT NULL,
  namespace   TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (plugin_id, namespace)
)`,
  `CREATE TABLE tavi_plugin_hook_events (
  event_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('decision', 'failure')),
  event         TEXT NOT NULL,
  tool          TEXT,
  task_id       TEXT,
  workspace_id  TEXT,
  rule_id       TEXT,
  detail        TEXT NOT NULL,
  created_at    TEXT NOT NULL
)`,
  `CREATE INDEX tavi_plugin_hook_events_plugin_idx ON tavi_plugin_hook_events (plugin_id, event_seq)`,
  `CREATE INDEX tavi_plugin_hook_events_kind_idx ON tavi_plugin_hook_events (plugin_id, kind, event_seq)`,
  `CREATE TABLE tavi_plugin_hook_prunes (
  plugin_id TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('decision', 'failure')),
  PRIMARY KEY (plugin_id, kind)
)`,
  `CREATE TABLE tavi_mcp_versions (
  plugin_id            TEXT NOT NULL,
  version              TEXT NOT NULL,
  sandbox_state        TEXT NOT NULL CHECK (sandbox_state IN ('srt', 'nested', 'none')),
  transport            TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
  era_prior_json       TEXT,
  http_mode            TEXT CHECK (http_mode IN ('streamable', 'sse')),
  external_path        TEXT,
  external_sha256      TEXT,
  interpreter_path     TEXT,
  interpreter_sha256   TEXT,
  server_info_json     TEXT,
  instructions_text    TEXT,
  instructions_hash    TEXT,
  capabilities_json    TEXT,
  tree_index_stale     INTEGER NOT NULL DEFAULT 0 CHECK (tree_index_stale IN (0, 1)),
  added_from_workspace TEXT,
  probed_at            TEXT,
  probed_by            TEXT,
  approved_at          TEXT,
  approved_by          TEXT,
  PRIMARY KEY (plugin_id, version),
  FOREIGN KEY (plugin_id, version) REFERENCES tavi_plugin_versions (plugin_id, version) ON DELETE CASCADE
)`,
  `CREATE TABLE tavi_mcp_tools (
  plugin_id          TEXT NOT NULL,
  version            TEXT NOT NULL,
  name               TEXT NOT NULL,
  tool_id            TEXT NOT NULL,
  approved_def_hash  TEXT,
  approved_def_json  TEXT,
  observed_def_hash  TEXT NOT NULL,
  observed_def_json  TEXT NOT NULL,
  suggested_effect   TEXT NOT NULL CHECK (suggested_effect IN ('read-only', 'mutating', 'external')),
  suggested_min_risk TEXT CHECK (suggested_min_risk IN ('low', 'medium', 'high', 'critical')),
  effect             TEXT CHECK (effect IN ('read-only', 'mutating', 'external')),
  min_risk           TEXT CHECK (min_risk IN ('low', 'medium', 'high', 'critical')),
  arg_floors_json    TEXT,
  timeout_ms         INTEGER CHECK (timeout_ms IS NULL OR (timeout_ms >= 1000 AND timeout_ms <= 600000)),
  ask_tainted        INTEGER NOT NULL DEFAULT 0 CHECK (ask_tainted IN (0, 1)),
  doubtful           INTEGER NOT NULL DEFAULT 0 CHECK (doubtful IN (0, 1)),
  flagged            INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
  state              TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'withheld', 'disabled', 'removed', 'rejected')),
  reviewed_by        TEXT,
  reviewed_at        TEXT,
  PRIMARY KEY (plugin_id, version, name),
  FOREIGN KEY (plugin_id, version) REFERENCES tavi_plugin_versions (plugin_id, version) ON DELETE CASCADE
)`,
  `CREATE UNIQUE INDEX tavi_mcp_tools_id_idx ON tavi_mcp_tools (plugin_id, version, tool_id)`,
  `CREATE TABLE tavi_mcp_tree_index (
  plugin_id TEXT NOT NULL,
  version   TEXT NOT NULL,
  path      TEXT NOT NULL,
  size      INTEGER NOT NULL CHECK (size >= 0),
  mtime_ms  REAL NOT NULL,
  ctime_ms  REAL NOT NULL,
  ino       INTEGER NOT NULL,
  sha256    TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version, path),
  FOREIGN KEY (plugin_id, version) REFERENCES tavi_plugin_versions (plugin_id, version) ON DELETE CASCADE
)`,
  `CREATE TABLE tavi_mcp_notices (
  notice_id      TEXT PRIMARY KEY,
  plugin_id      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('drift', 'login', 'scope', 'failed', 'budget')),
  detail_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  delivered_json TEXT NOT NULL DEFAULT '{}',
  decided_at     TEXT,
  decided_by     TEXT
)`,
  `CREATE UNIQUE INDEX tavi_mcp_notices_open ON tavi_mcp_notices (plugin_id, kind) WHERE decided_at IS NULL`,

  // ── Workspace settings, reminders and browsing ──────────────────────────────────────────────────────────
  // Workspace settings are one JSON document per workspace, kept whatever it holds so its revision never restarts.
  // A reminder fire is one row per occurrence, keyed by its time, so it fires once and survives a restart. Browser
  // history keeps scrubbed URLs only.
  `CREATE TABLE tavi_workspace_settings (
 workspace_id TEXT PRIMARY KEY,
 settings_json TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK (revision >= 0),
 actor TEXT,
 updated_at TEXT NOT NULL
)`,
  `CREATE TABLE tavi_reminders (
 reminder_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 principal_id TEXT NOT NULL,
 text TEXT NOT NULL,
 prompt TEXT,
 when_json TEXT NOT NULL,
 timezone TEXT NOT NULL,
 deliver_to_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'done', 'cancelled')),
 next_fire_at TEXT,
 last_fired_at TEXT,
 schedule_cursor_at TEXT NOT NULL,
 created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'user')),
 origin_task_id TEXT,
 operation_key TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, label_json TEXT,
 UNIQUE (workspace_id, principal_id, operation_key)
)`,
  `CREATE INDEX tavi_reminders_due ON tavi_reminders (status, next_fire_at)`,
  `CREATE INDEX tavi_reminders_workspace ON tavi_reminders (workspace_id, created_at, reminder_id)`,
  `CREATE TABLE tavi_reminder_fires (
 reminder_id TEXT NOT NULL REFERENCES tavi_reminders (reminder_id) ON DELETE CASCADE,
 fire_at TEXT NOT NULL,
 occurrence TEXT NOT NULL CHECK (occurrence IN ('event', 'notice', 'once', 'repeat')),
 notice_offset TEXT,
 fired_at TEXT,
 outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'delivered', 'delivered-in-app', 'missed', 'failed', 'snoozed')),
 late INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0, 1)),
 task_id TEXT,
 acknowledged_at TEXT,
 snoozed_until TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), retry_at TEXT, retry_until TEXT, token TEXT,
 PRIMARY KEY (reminder_id, fire_at)
) WITHOUT ROWID`,
  `CREATE INDEX tavi_reminder_fires_pending ON tavi_reminder_fires (outcome, fire_at)`,
  `CREATE UNIQUE INDEX tavi_reminder_fires_token ON tavi_reminder_fires (token) WHERE token IS NOT NULL`,
  `CREATE INDEX tavi_reminder_fires_retry ON tavi_reminder_fires (retry_at) WHERE retry_at IS NOT NULL`,
  `CREATE TABLE tavi_browser_sessions (
 session_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
 opened_at TEXT NOT NULL,
 closed_at TEXT,
 close_reason TEXT,
 last_url TEXT,
 last_title TEXT,
 thumbnail_artifact_id TEXT REFERENCES tavi_artifacts (artifact_id) ON DELETE SET NULL,
 pages INTEGER NOT NULL DEFAULT 0 CHECK (pages >= 0)
, opened_by_call_id TEXT, inactive_since TEXT)`,
  `CREATE INDEX tavi_browser_sessions_workspace_idx ON tavi_browser_sessions (workspace_id, opened_at DESC)`,
  `CREATE INDEX tavi_browser_sessions_task_idx ON tavi_browser_sessions (task_id)`,
  `CREATE INDEX tavi_browser_sessions_opened_idx ON tavi_browser_sessions (opened_at)`,
  `CREATE INDEX tavi_browser_sessions_thumbnail_idx ON tavi_browser_sessions (thumbnail_artifact_id) WHERE thumbnail_artifact_id IS NOT NULL`,
  `CREATE TABLE tavi_browser_visits (
 session_id TEXT NOT NULL REFERENCES tavi_browser_sessions (session_id) ON DELETE CASCADE,
 seq INTEGER NOT NULL CHECK (seq >= 1),
 url TEXT NOT NULL,
 title TEXT,
 at TEXT NOT NULL,
 PRIMARY KEY (session_id, seq)
) WITHOUT ROWID`,
  `CREATE TABLE tavi_site_recipes (
 workspace_id TEXT NOT NULL,
 host TEXT NOT NULL,
 steps_json TEXT NOT NULL,
 results INTEGER NOT NULL CHECK (results >= 0),
 uses INTEGER NOT NULL CHECK (uses >= 1),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (workspace_id, host)
)`,
  `CREATE TABLE tavi_site_usage (
 workspace_id TEXT NOT NULL,
 profile TEXT NOT NULL,
 day TEXT NOT NULL,
 pages INTEGER NOT NULL DEFAULT 0 CHECK (pages >= 0),
 final_steps INTEGER NOT NULL DEFAULT 0 CHECK (final_steps >= 0),
 PRIMARY KEY (workspace_id, profile, day)
)`,

  // ── Heartbeat ───────────────────────────────────────────────────────────────────────────────────────────
  // One row per (workspace, principal) with `enabled`, pause and `revision` as columns so the sweep finds due rows
  // through an index; the record of every tick, the item ledger, the signals seen (kept apart from items so retraction
  // reads them by signal key) and the history of the instructions.
  `CREATE TABLE tavi_heartbeats (
  workspace_id       TEXT NOT NULL,
  principal_id       TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  config_json        TEXT NOT NULL,
  revision           INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  paused_reason      TEXT CHECK (paused_reason IN ('user', 'budget', 'failures', 'provider')),
  paused_until       TEXT,
  next_tick_at       TEXT,
  last_deep_tick_at  TEXT,
  last_tick_at       TEXT,
  memo               TEXT,
  offer_dismissed_at TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL, provider_since TEXT, forgot_usage_json TEXT,
  PRIMARY KEY (workspace_id, principal_id)
)`,
  `CREATE INDEX tavi_heartbeats_due_idx ON tavi_heartbeats (enabled, next_tick_at)`,
  `CREATE TABLE tavi_heartbeat_ticks (
  tick_id             TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  principal_id        TEXT NOT NULL,
  kind                TEXT CHECK (kind IN ('signal', 'deep', 'digest', 'window')),
  wake_reason         TEXT CHECK (wake_reason IN ('interval', 'signal', 'event', 'manual', 'catch-up')),
  outcome             TEXT NOT NULL CHECK (outcome IN ('skipped', 'deferred', 'quiet', 'quiet:withheld', 'reported', 'failed', 'delivered')),
  reason              TEXT,
  pause_reason        TEXT CHECK (pause_reason IN ('user', 'budget', 'failures', 'provider')),
  provider_id         TEXT,
  task_id             TEXT,
  items_now           INTEGER NOT NULL DEFAULT 0,
  items_later         INTEGER NOT NULL DEFAULT 0,
  items_retracted     INTEGER NOT NULL DEFAULT 0,
  inputs_json         TEXT,
  hook_decisions_json TEXT,
  tokens              INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL,
  duration_ms         INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  provider_dev        INTEGER NOT NULL DEFAULT 0 CHECK (provider_dev IN (0, 1)),
  created_at          TEXT NOT NULL
)`,
  `CREATE INDEX tavi_heartbeat_ticks_scope_idx ON tavi_heartbeat_ticks (workspace_id, principal_id, created_at)`,
  `CREATE INDEX tavi_heartbeat_ticks_task_idx ON tavi_heartbeat_ticks (task_id)`,
  `CREATE TABLE tavi_heartbeat_items (
  item_id              TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  principal_id         TEXT NOT NULL,
  item_key             TEXT NOT NULL,
  hash                 TEXT NOT NULL,
  signal_keys_json     TEXT NOT NULL DEFAULT '[]',
  urgency              TEXT NOT NULL CHECK (urgency IN ('now', 'later')),
  title                TEXT NOT NULL,
  body                 TEXT,
  sources_json         TEXT NOT NULL DEFAULT '[]',
  instruction_line     INTEGER,
  proposed_action_json TEXT,
  state                TEXT NOT NULL CHECK (state IN ('told', 'resolved', 'muted', 'snoozed', 'filtered')),
  snoozed_until        TEXT,
  feedback             TEXT CHECK (feedback IN ('up', 'down')),
  button_token         TEXT,
  first_told_at        TEXT NOT NULL,
  last_told_at         TEXT NOT NULL,
  updated_at           TEXT NOT NULL
, held_back INTEGER NOT NULL DEFAULT 0 CHECK (held_back IN (0, 1)), digested_at TEXT)`,
  `CREATE UNIQUE INDEX tavi_heartbeat_items_key_idx ON tavi_heartbeat_items (workspace_id, principal_id, item_key)`,
  `CREATE INDEX tavi_heartbeat_items_button_idx ON tavi_heartbeat_items (button_token)`,
  `CREATE INDEX tavi_heartbeat_items_told_idx ON tavi_heartbeat_items (workspace_id, principal_id, last_told_at)`,
  `CREATE TABLE tavi_heartbeat_signals (
  workspace_id  TEXT NOT NULL,
  principal_id  TEXT NOT NULL,
  signal_key    TEXT NOT NULL,
  hash          TEXT NOT NULL,
  source        TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, signal_key)
)`,
  `CREATE TABLE tavi_heartbeat_instructions (
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  text         TEXT NOT NULL,
  author       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, revision)
)`,

  // ── Ideas ───────────────────────────────────────────────────────────────────────────────────────────────
  // Keys repeat across rows (a dismissed idea may be offered again after a reset), so they are indexed, not unique,
  // except that a key is active at most once per workspace, which the store's upsert assumes.
  `CREATE TABLE tavi_ideas (
  idea_id           TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  idea_key          TEXT NOT NULL,
  use_case          TEXT,
  category          TEXT NOT NULL CHECK (category IN ('productivity', 'work', 'learning', 'health-home', 'travel', 'shopping', 'people')),
  icon              TEXT NOT NULL,
  title             TEXT NOT NULL,
  pitch             TEXT NOT NULL,
  label             TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  basis_json        TEXT NOT NULL CHECK (json_valid(basis_json)),
  uses_json         TEXT NOT NULL CHECK (json_valid(uses_json)),
  recurring_cadence TEXT CHECK (recurring_cadence IN ('daily', 'weekly', 'monthly')),
  score             REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  status            TEXT NOT NULL CHECK (status IN ('active', 'tried', 'done', 'snoozed', 'dismissed', 'expired')),
  pinned            INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  shown_runs        INTEGER NOT NULL DEFAULT 1 CHECK (shown_runs >= 0),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  snoozed_until     TEXT, provider_id TEXT NOT NULL DEFAULT 'tavi.ideasagent', last_shown_at TEXT, seeded_task_id TEXT, prepared_task_id TEXT, prepared_text TEXT, prepared_at TEXT,
  CHECK (status <> 'snoozed' OR snoozed_until IS NOT NULL)
)`,
  `CREATE INDEX tavi_ideas_status_idx ON tavi_ideas (workspace_id, status, expires_at)`,
  `CREATE INDEX tavi_ideas_key_idx ON tavi_ideas (workspace_id, idea_key)`,
  `CREATE UNIQUE INDEX tavi_ideas_active_key_idx ON tavi_ideas (workspace_id, idea_key) WHERE status = 'active'`,
  `CREATE INDEX tavi_ideas_seeded_task_idx ON tavi_ideas (seeded_task_id) WHERE seeded_task_id IS NOT NULL`,
  `CREATE TABLE tavi_idea_runs (
  run_id       TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  trigger      TEXT NOT NULL CHECK (trigger IN ('schedule', 'refresh')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('running', 'generated', 'unchanged', 'skipped', 'failed')),
  reason       TEXT,
  inputs_hash  TEXT,
  generated    INTEGER NOT NULL DEFAULT 0 CHECK (generated >= 0),
  dropped      INTEGER NOT NULL DEFAULT 0 CHECK (dropped >= 0),
  tokens       INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  usd          REAL NOT NULL DEFAULT 0 CHECK (usd >= 0)
, provider_id TEXT)`,
  `CREATE INDEX tavi_idea_runs_scope_idx ON tavi_idea_runs (workspace_id, started_at)`,
  `CREATE TABLE tavi_idea_feedback (
  feedback_id   TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  idea_id       TEXT,
  idea_key      TEXT,
  category      TEXT CHECK (category IN ('productivity', 'work', 'learning', 'health-home', 'travel', 'shopping', 'people')),
  basis_ref     TEXT,
  signal        TEXT NOT NULL CHECK (signal IN ('tried', 'edited', 'done', 'ignored', 'not-now', 'not-interested', 'mute-category', 'unmute-category', 'exclude-basis', 'include-basis', 'more-like-this')),
  edited_prompt TEXT,
  at            TEXT NOT NULL
)`,
  `CREATE INDEX tavi_idea_feedback_scope_idx ON tavi_idea_feedback (workspace_id, signal, at)`,
  `CREATE TABLE tavi_idea_settings (
  workspace_id  TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  brief         TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL
)`,

  // ── Onboarding ──────────────────────────────────────────────────────────────────────────────────────────
  // The install's single row (id = 1), seeded by the baseline so the repository only ever updates it; each workspace's
  // step marks; the latest verification per subject; and the setup funnel, kept on this machine only.
  `CREATE TABLE tavi_onboarding (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  provider_id            TEXT,
  first_seen_at          TEXT,
  completed_at           TEXT,
  dismissed_at           TEXT,
  dismissed_flow_version INTEGER,
  flow_version           INTEGER
)`,
  `CREATE TABLE tavi_onboarding_steps (
  workspace_id TEXT NOT NULL,
  step_kind    TEXT NOT NULL,
  state        TEXT CHECK (state IS NULL OR state IN ('skipped', 'seen', 'completed', 'self-managed')),
  created_ref  TEXT,
  at           TEXT NOT NULL,
  PRIMARY KEY (workspace_id, step_kind)
)`,
  `CREATE TABLE tavi_onboarding_verifications (
  workspace_id        TEXT NOT NULL,
  subject             TEXT NOT NULL CHECK (subject IN ('model', 'search')),
  role                TEXT CHECK (role IS NULL OR role IN ('main', 'fast')),
  subject_id          TEXT NOT NULL,
  model               TEXT,
  base_url            TEXT,
  credential_revision TEXT,
  ok                  INTEGER NOT NULL CHECK (ok IN (0, 1)),
  tools_ok            INTEGER CHECK (tools_ok IS NULL OR tools_ok IN (0, 1)),
  error_code          TEXT,
  at                  TEXT NOT NULL
)`,
  `CREATE UNIQUE INDEX tavi_onboarding_verifications_subject_idx ON tavi_onboarding_verifications (workspace_id, subject, COALESCE(role, ''), subject_id)`,
  `CREATE TABLE tavi_onboarding_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  step_kind    TEXT NOT NULL,
  event        TEXT NOT NULL CHECK (event IN ('reached', 'skipped', 'failed')),
  error_code   TEXT,
  at           TEXT NOT NULL
)`,
  `CREATE INDEX tavi_onboarding_events_workspace ON tavi_onboarding_events (workspace_id, step_kind)`,

  // ── Command Center change counters ──────────────────────────────────────────────────────────────────────
  // One row per (scope, kind), bumped by these triggers on every write to the tables behind that kind, so a waiting
  // `center watch` reads a handful of indexed rows instead of aggregating the workspace's history.
  // The scope is the workspace id, except personal memory, keyed `p:<principal id>` so
  // one person's private records never wake another's page; plugin settings and versions bump the global scope. A
  // child row reaches its workspace through its task. A table that joins a kind needs the same three triggers.
  `CREATE TABLE tavi_center_versions (
 scope TEXT NOT NULL,
 kind TEXT NOT NULL,
 version INTEGER NOT NULL CHECK (version >= 0),
 PRIMARY KEY (scope, kind)
) WITHOUT ROWID`,
  `CREATE TRIGGER tavi_tasks_center_insert AFTER INSERT ON tavi_tasks BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'task', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_tasks_center_update AFTER UPDATE ON tavi_tasks BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'task', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_tasks_center_delete AFTER DELETE ON tavi_tasks BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'task', 1 FROM (SELECT OLD.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_approvals_center_insert AFTER INSERT ON tavi_approvals BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'approval', 1 FROM (SELECT (SELECT t.workspace_id FROM tavi_tasks t WHERE t.task_id = NEW.task_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_approvals_center_update AFTER UPDATE ON tavi_approvals BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'approval', 1 FROM (SELECT (SELECT t.workspace_id FROM tavi_tasks t WHERE t.task_id = NEW.task_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_approvals_center_delete AFTER DELETE ON tavi_approvals BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'approval', 1 FROM (SELECT (SELECT t.workspace_id FROM tavi_tasks t WHERE t.task_id = OLD.task_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_agent_wait_intents_center_insert AFTER INSERT ON tavi_agent_wait_intents BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'question', 1 FROM (SELECT (SELECT t.workspace_id FROM tavi_tasks t WHERE t.task_id = NEW.task_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_agent_wait_intents_center_update AFTER UPDATE ON tavi_agent_wait_intents BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'question', 1 FROM (SELECT (SELECT t.workspace_id FROM tavi_tasks t WHERE t.task_id = NEW.task_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_agent_wait_intents_center_delete AFTER DELETE ON tavi_agent_wait_intents BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'question', 1 FROM (SELECT (SELECT t.workspace_id FROM tavi_tasks t WHERE t.task_id = OLD.task_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_routines_center_insert AFTER INSERT ON tavi_routines BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'routine', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_routines_center_update AFTER UPDATE ON tavi_routines BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'routine', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_routines_center_delete AFTER DELETE ON tavi_routines BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'routine', 1 FROM (SELECT OLD.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_schedules_center_insert AFTER INSERT ON tavi_schedules BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'schedule', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_schedules_center_update AFTER UPDATE ON tavi_schedules BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'schedule', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_schedules_center_delete AFTER DELETE ON tavi_schedules BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'schedule', 1 FROM (SELECT OLD.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_memory_records_center_insert AFTER INSERT ON tavi_memory_records BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'memory', 1 FROM (SELECT CASE WHEN NEW.scope_kind = 'run_local' THEN NULL WHEN NEW.scope_kind = 'shared_workspace' THEN NEW.workspace_id ELSE 'p:' || NEW.principal_id END AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_memory_records_center_update AFTER UPDATE ON tavi_memory_records BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'memory', 1 FROM (SELECT CASE WHEN NEW.scope_kind = 'run_local' THEN NULL WHEN NEW.scope_kind = 'shared_workspace' THEN NEW.workspace_id ELSE 'p:' || NEW.principal_id END AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_memory_records_center_delete AFTER DELETE ON tavi_memory_records BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'memory', 1 FROM (SELECT CASE WHEN OLD.scope_kind = 'run_local' THEN NULL WHEN OLD.scope_kind = 'shared_workspace' THEN OLD.workspace_id ELSE 'p:' || OLD.principal_id END AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_memory_revisions_center_insert AFTER INSERT ON tavi_memory_revisions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'memory', 1 FROM (SELECT (SELECT CASE WHEN m.scope_kind = 'run_local' THEN NULL WHEN m.scope_kind = 'shared_workspace' THEN m.workspace_id ELSE 'p:' || m.principal_id END FROM tavi_memory_records m WHERE m.record_id = NEW.record_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_memory_revisions_center_update AFTER UPDATE ON tavi_memory_revisions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'memory', 1 FROM (SELECT (SELECT CASE WHEN m.scope_kind = 'run_local' THEN NULL WHEN m.scope_kind = 'shared_workspace' THEN m.workspace_id ELSE 'p:' || m.principal_id END FROM tavi_memory_records m WHERE m.record_id = NEW.record_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_memory_revisions_center_delete AFTER DELETE ON tavi_memory_revisions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'memory', 1 FROM (SELECT (SELECT CASE WHEN m.scope_kind = 'run_local' THEN NULL WHEN m.scope_kind = 'shared_workspace' THEN m.workspace_id ELSE 'p:' || m.principal_id END FROM tavi_memory_records m WHERE m.record_id = OLD.record_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_reminders_center_insert AFTER INSERT ON tavi_reminders BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'reminder', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_reminders_center_update AFTER UPDATE ON tavi_reminders BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'reminder', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_reminders_center_delete AFTER DELETE ON tavi_reminders BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'reminder', 1 FROM (SELECT OLD.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_reminder_fires_center_insert AFTER INSERT ON tavi_reminder_fires BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'reminder', 1 FROM (SELECT (SELECT m.workspace_id FROM tavi_reminders m WHERE m.reminder_id = NEW.reminder_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_reminder_fires_center_update AFTER UPDATE ON tavi_reminder_fires BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'reminder', 1 FROM (SELECT (SELECT m.workspace_id FROM tavi_reminders m WHERE m.reminder_id = NEW.reminder_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_reminder_fires_center_delete AFTER DELETE ON tavi_reminder_fires BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'reminder', 1 FROM (SELECT (SELECT m.workspace_id FROM tavi_reminders m WHERE m.reminder_id = OLD.reminder_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  // Only an artifact without a `purpose` is a reviewable one: a browser thumbnail written every few seconds
  // must not wake the approvals page.
  `CREATE TRIGGER tavi_artifacts_center_insert AFTER INSERT ON tavi_artifacts WHEN NEW.purpose IS NULL BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'review', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_artifacts_center_update AFTER UPDATE ON tavi_artifacts WHEN NEW.purpose IS NULL BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'review', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_artifacts_center_delete AFTER DELETE ON tavi_artifacts WHEN OLD.purpose IS NULL BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'review', 1 FROM (SELECT OLD.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_browser_sessions_center_insert AFTER INSERT ON tavi_browser_sessions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'browser', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_browser_sessions_center_update AFTER UPDATE ON tavi_browser_sessions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'browser', 1 FROM (SELECT NEW.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_browser_sessions_center_delete AFTER DELETE ON tavi_browser_sessions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'browser', 1 FROM (SELECT OLD.workspace_id AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_browser_visits_center_insert AFTER INSERT ON tavi_browser_visits BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'browser', 1 FROM (SELECT (SELECT s.workspace_id FROM tavi_browser_sessions s WHERE s.session_id = NEW.session_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_browser_visits_center_update AFTER UPDATE ON tavi_browser_visits BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'browser', 1 FROM (SELECT (SELECT s.workspace_id FROM tavi_browser_sessions s WHERE s.session_id = NEW.session_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_browser_visits_center_delete AFTER DELETE ON tavi_browser_visits BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'browser', 1 FROM (SELECT (SELECT s.workspace_id FROM tavi_browser_sessions s WHERE s.session_id = OLD.session_id) AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_plugin_settings_center_insert AFTER INSERT ON tavi_plugin_settings BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'plugin', 1 FROM (SELECT '*' AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_plugin_settings_center_update AFTER UPDATE ON tavi_plugin_settings BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'plugin', 1 FROM (SELECT '*' AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_plugin_settings_center_delete AFTER DELETE ON tavi_plugin_settings BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'plugin', 1 FROM (SELECT '*' AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_plugin_versions_center_insert AFTER INSERT ON tavi_plugin_versions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'plugin', 1 FROM (SELECT '*' AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_plugin_versions_center_update AFTER UPDATE ON tavi_plugin_versions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'plugin', 1 FROM (SELECT '*' AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_plugin_versions_center_delete AFTER DELETE ON tavi_plugin_versions BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version)
  SELECT s, 'plugin', 1 FROM (SELECT '*' AS s) WHERE s IS NOT NULL
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_workspace_settings_center_insert AFTER INSERT ON tavi_workspace_settings WHEN (CASE WHEN json_valid(NEW.settings_json) THEN json_extract(NEW.settings_json, '$.uiRoles') END) IS NOT NULL OR (CASE WHEN json_valid(NEW.settings_json) THEN json_extract(NEW.settings_json, '$.uiPlacements') END) IS NOT NULL BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version) VALUES (NEW.workspace_id, 'plugin', 1)
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
  `CREATE TRIGGER tavi_workspace_settings_center_update AFTER UPDATE ON tavi_workspace_settings
WHEN (CASE WHEN json_valid(NEW.settings_json) THEN json_extract(NEW.settings_json, '$.uiRoles') END) IS NOT (CASE WHEN json_valid(OLD.settings_json) THEN json_extract(OLD.settings_json, '$.uiRoles') END)
  OR (CASE WHEN json_valid(NEW.settings_json) THEN json_extract(NEW.settings_json, '$.uiPlacements') END) IS NOT (CASE WHEN json_valid(OLD.settings_json) THEN json_extract(OLD.settings_json, '$.uiPlacements') END) BEGIN
  INSERT INTO tavi_center_versions (scope, kind, version) VALUES (NEW.workspace_id, 'plugin', 1)
  ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1;
END`,
];
