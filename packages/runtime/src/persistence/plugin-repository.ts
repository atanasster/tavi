import type { PluginRepositoryPort } from "./internal-contracts.js";
import {
  PluginManifestSchema,
  PluginSettingRecordSchema,
  TaviError,
  TimestampSchema,
  MAX_PLUGIN_HOOK_EVENTS,
  MAX_PLUGIN_HOOK_DECISIONS,
  MAX_PLUGIN_HOOK_FAILURES,
  type PluginHookActivity,
  type PluginHookEventRecord,
  type PluginSettingRecord,
  type PluginVersionRecord,
  type PluginIsolation,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import type { Database } from "./sqlite-loader.js";

interface VersionRow {
  readonly plugin_id: string;
  readonly version: string;
  readonly content_hash: string;
  readonly manifest_json: string;
  readonly review_state: string;
  readonly installed_by: string;
  readonly installed_at: string;
  readonly reviewed_by: string | null;
  readonly reviewed_at: string | null;
  readonly isolation: string | null;
}

interface SettingRow {
  readonly plugin_id: string;
  readonly enabled: number;
  readonly active_version: string | null;
  readonly config_json: string;
  readonly instances_json: string;
  readonly updated_by: string;
  readonly updated_at: string;
}

/** A row that no longer parses is reported by key, never thrown from a list (as elsewhere in the store). */
function toVersion(row: VersionRow): PluginVersionRecord {
  const manifest = PluginManifestSchema.parse(JSON.parse(row.manifest_json));
  if (manifest.id !== row.plugin_id || manifest.version !== row.version) throw new Error("manifest identity differs from its row");
  if (!["proposed", "approved", "rejected"].includes(row.review_state)) throw new Error("unknown review state");
  return {
    pluginId: row.plugin_id,
    version: row.version,
    contentHash: row.content_hash,
    manifest,
    reviewState: row.review_state as PluginVersionRecord["reviewState"],
    installedBy: row.installed_by,
    installedAt: TimestampSchema.parse(row.installed_at),
    ...(row.reviewed_by === null ? {} : { reviewedBy: row.reviewed_by }),
    ...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
    ...(row.isolation === "process" || row.isolation === "in-process" ? { isolation: row.isolation } : {}),
  };
}

function toSetting(row: SettingRow): PluginSettingRecord {
  return PluginSettingRecordSchema.parse({
    pluginId: row.plugin_id,
    enabled: row.enabled === 1,
    ...(row.active_version === null ? {} : { activeVersion: row.active_version }),
    config: JSON.parse(row.config_json),
    instances: JSON.parse(row.instances_json),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }) as PluginSettingRecord;
}

function partition<Row, Value>(rows: readonly Row[], key: (row: Row) => string, read: (row: Row) => Value) {
  const readable: Value[] = [],
    unreadable: string[] = [];
  for (const row of rows) {
    try {
      readable.push(read(row));
    } catch {
      unreadable.push(key(row));
    }
  }
  return { readable, unreadable };
}

/** Plugin registry rows. */
export class SqlitePluginRepository implements PluginRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  addVersion(record: PluginVersionRecord): { readonly record: PluginVersionRecord; readonly created: boolean } {
    const manifest = PluginManifestSchema.safeParse(record.manifest);
    if (
      !manifest.success ||
      manifest.data.id !== record.pluginId ||
      manifest.data.version !== record.version ||
      !/^[a-f0-9]{64}$/.test(record.contentHash)
    ) {
      throw new TaviError("INVALID_INPUT", `plugin ${record.pluginId}@${record.version} is not a valid installed version`);
    }
    const existing = this.getVersion(record.pluginId, record.version);
    if (existing !== undefined) {
      if (existing.contentHash === record.contentHash) return { record: existing, created: false };
      throw new TaviError(
        "CONFLICT",
        `plugin ${record.pluginId}@${record.version} is already installed with different contents; installed versions are immutable, so bump the version`,
        {
          details: { pluginId: record.pluginId, version: record.version },
        },
      );
    }
    this.#db()
      .prepare(`INSERT INTO tavi_plugin_versions (plugin_id, version, content_hash, manifest_json, review_state, installed_by, installed_at, reviewed_by, reviewed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.pluginId,
        record.version,
        record.contentHash,
        JSON.stringify(manifest.data),
        record.reviewState,
        record.installedBy,
        record.installedAt,
        record.reviewedBy ?? null,
        record.reviewedAt ?? null,
      );
    return { record: { ...record, manifest: manifest.data }, created: true };
  }

  getVersion(pluginId: string, version: string): PluginVersionRecord | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_plugin_versions WHERE plugin_id = ? AND version = ?").get(pluginId, version) as
      | VersionRow
      | undefined;
    if (row === undefined) return undefined;
    try {
      return toVersion(row);
    } catch {
      throw new TaviError("UNAVAILABLE", `plugin ${pluginId}@${version} is recorded but no longer readable`);
    }
  }

  listVersions(pluginId?: string) {
    // Complete, never a silent page: installs are capped (PLUGIN_BOUNDS), so the set is bounded.
    const rows = (
      pluginId === undefined
        ? this.#db().prepare("SELECT * FROM tavi_plugin_versions ORDER BY plugin_id, installed_at, rowid").all()
        : this.#db().prepare("SELECT * FROM tavi_plugin_versions WHERE plugin_id = ? ORDER BY installed_at, rowid").all(pluginId)
    ) as VersionRow[];
    const { readable, unreadable } = partition(rows, (row) => `${row.plugin_id}@${row.version}`, toVersion);
    return { versions: readable, unreadable };
  }

  decide(
    pluginId: string,
    version: string,
    state: "approved" | "rejected",
    by: string,
    now: string,
    isolation?: PluginIsolation,
  ): PluginVersionRecord {
    TimestampSchema.parse(now);
    const existing = this.getVersion(pluginId, version);
    if (existing === undefined) throw new TaviError("NOT_FOUND", `plugin ${pluginId}@${version} is not installed`);
    if (existing.reviewState === state) {
      // Approving an approved version again changes only where it runs: one approved before
      // workers (no isolation) or under another choice. Who decided is recorded; `reviewed_at` keeps
      // dating the review of its bytes.
      if (state !== "approved" || isolation === undefined || existing.isolation === isolation) return existing;
      this.#db()
        .prepare(
          "UPDATE tavi_plugin_versions SET isolation = ?, reviewed_by = ? WHERE plugin_id = ? AND version = ? AND review_state = 'approved'",
        )
        .run(isolation, by, pluginId, version);
      return this.#reviewed(pluginId, version);
    }
    // Trust can be revoked (approved → rejected) but a rejection is final: re-approving a
    // version once judged unsafe would be a new review, so it needs a new version.
    if (existing.reviewState === "rejected") {
      throw new TaviError(
        "CONFLICT",
        `plugin ${pluginId}@${version} was already ${existing.reviewState}; install a new version to review again`,
      );
    }
    this.#db()
      .prepare(
        "UPDATE tavi_plugin_versions SET review_state = ?, reviewed_by = ?, reviewed_at = ?, isolation = COALESCE(?, isolation) WHERE plugin_id = ? AND version = ? AND review_state = ?",
      )
      .run(state, by, now, state === "approved" ? (isolation ?? null) : null, pluginId, version, existing.reviewState);
    return this.#reviewed(pluginId, version);
  }

  /** A version just reviewed, read back: one removed meanwhile is said, not returned as undefined. */
  #reviewed(pluginId: string, version: string): PluginVersionRecord {
    const record = this.getVersion(pluginId, version);
    if (record === undefined) throw new TaviError("NOT_FOUND", `plugin ${pluginId}@${version} was removed while it was being reviewed`);
    return record;
  }

  removeVersion(pluginId: string, version: string): boolean {
    return this.#db().prepare("DELETE FROM tavi_plugin_versions WHERE plugin_id = ? AND version = ?").run(pluginId, version).changes > 0;
  }

  getSetting(pluginId: string): PluginSettingRecord | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_plugin_settings WHERE plugin_id = ?").get(pluginId) as SettingRow | undefined;
    if (row === undefined) return undefined;
    try {
      return toSetting(row);
    } catch {
      throw new TaviError("UNAVAILABLE", `settings for plugin ${pluginId} are recorded but no longer readable`);
    }
  }

  listSettings() {
    const rows = this.#db().prepare("SELECT * FROM tavi_plugin_settings ORDER BY plugin_id").all() as SettingRow[];
    const { readable, unreadable } = partition(rows, (row) => row.plugin_id, toSetting);
    return { settings: readable, unreadable };
  }

  putSetting(record: PluginSettingRecord): PluginSettingRecord {
    const parsed = PluginSettingRecordSchema.safeParse(record);
    if (!parsed.success)
      throw new TaviError(
        "INVALID_INPUT",
        `settings for plugin ${record.pluginId} are not valid and were not written: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    const value = parsed.data;
    this.#db()
      .prepare(`INSERT INTO tavi_plugin_settings (plugin_id, enabled, active_version, config_json, instances_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (plugin_id) DO UPDATE SET enabled = excluded.enabled, active_version = excluded.active_version,
                config_json = excluded.config_json, instances_json = excluded.instances_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(
        value.pluginId,
        value.enabled ? 1 : 0,
        value.activeVersion ?? null,
        JSON.stringify(value.config),
        JSON.stringify(value.instances),
        value.updatedBy,
        value.updatedAt,
      );
    return value as PluginSettingRecord;
  }

  removeSetting(pluginId: string): boolean {
    return this.#db().prepare("DELETE FROM tavi_plugin_settings WHERE plugin_id = ?").run(pluginId).changes > 0;
  }

  loadPluginState(pluginId: string): Record<string, unknown> {
    const rows = this.#db()
      .prepare("SELECT namespace, value_json FROM tavi_plugin_state WHERE plugin_id = ? ORDER BY namespace")
      .all(pluginId) as Array<{ namespace: string; value_json: string }>;
    const result: Record<string, unknown> = Object.create(null);
    for (const row of rows) {
      try {
        result[row.namespace] = JSON.parse(row.value_json);
      } catch (error) {
        throw new TaviError(
          "UNAVAILABLE",
          `plugin ${pluginId} state in namespace "${row.namespace}" contains malformed JSON: ${errorMessage(error)}`,
        );
      }
    }
    return result;
  }

  putPluginState(pluginId: string, namespace: string, value: unknown, now: string): void {
    TimestampSchema.parse(now);
    if (typeof namespace !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(namespace) || namespace.length > 64) {
      throw new TaviError("INVALID_INPUT", `invalid plugin state namespace: "${namespace}"`);
    }
    if (namespace === "__proto__" || namespace === "constructor" || namespace === "prototype") {
      throw new TaviError("INVALID_INPUT", `reserved plugin state namespace: "${namespace}"`);
    }
    let serialized: string;
    try {
      const candidate = JSON.stringify(value);
      if (candidate === undefined) {
        throw new Error("value is not JSON serializable");
      }
      serialized = candidate;
    } catch (error) {
      throw new TaviError("INVALID_INPUT", `plugin state value must be JSON serializable: ${errorMessage(error)}`);
    }
    const byteLength = Buffer.byteLength(serialized, "utf8");
    const MAX_PLUGIN_STATE_BYTES = 256 * 1024; // 256 KiB
    const MAX_PLUGIN_STATE_NAMESPACES = 16;

    if (byteLength > MAX_PLUGIN_STATE_BYTES) {
      throw new TaviError("CONFLICT", `plugin ${pluginId} state namespace "${namespace}" exceeds maximum storage limit of 256 KiB`);
    }

    this.#db()
      .transaction(() => {
        const existingRows = this.#db()
          .prepare("SELECT namespace, octet_length(value_json) as bytes FROM tavi_plugin_state WHERE plugin_id = ?")
          .all(pluginId) as Array<{ namespace: string; bytes: number }>;
        const isNewNamespace = !existingRows.some((r) => r.namespace === namespace);
        if (isNewNamespace && existingRows.length >= MAX_PLUGIN_STATE_NAMESPACES) {
          throw new TaviError("CONFLICT", `plugin ${pluginId} state exceeds maximum namespace limit (${MAX_PLUGIN_STATE_NAMESPACES})`);
        }

        let totalBytes = byteLength;
        for (const r of existingRows) {
          if (r.namespace !== namespace) {
            totalBytes += r.bytes;
          }
        }
        if (totalBytes > MAX_PLUGIN_STATE_BYTES) {
          throw new TaviError("CONFLICT", `plugin ${pluginId} total state exceeds maximum storage limit of 256 KiB`);
        }

        this.#db()
          .prepare(`INSERT INTO tavi_plugin_state (plugin_id, namespace, value_json, updated_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT (plugin_id, namespace) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
          .run(pluginId, namespace, serialized, now);
      })
      .immediate();
  }

  clearPluginState(pluginId: string): boolean {
    return this.#db().prepare("DELETE FROM tavi_plugin_state WHERE plugin_id = ?").run(pluginId).changes > 0;
  }

  appendHookEvent(record: PluginHookEventRecord): void {
    TimestampSchema.parse(record.at);
    this.#db()
      .transaction(() => {
        this.#db()
          .prepare(
            "INSERT INTO tavi_plugin_hook_events (plugin_id, kind, event, tool, task_id, workspace_id, rule_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            record.pluginId,
            record.kind,
            record.event,
            record.tool ?? null,
            record.taskId ?? null,
            record.workspaceId ?? null,
            record.ruleId ?? null,
            record.detail.slice(0, 500),
            record.at,
          );
        // Each kind within its own bound: a burst of failures never prunes the decisions an audit needs.
        const pruned = this.#db()
          .prepare(
            "DELETE FROM tavi_plugin_hook_events WHERE plugin_id = ? AND kind = ? AND event_seq <= (SELECT event_seq FROM tavi_plugin_hook_events WHERE plugin_id = ? AND kind = ? ORDER BY event_seq DESC LIMIT 1 OFFSET ?)",
          )
          .run(
            record.pluginId,
            record.kind,
            record.pluginId,
            record.kind,
            record.kind === "decision" ? MAX_PLUGIN_HOOK_DECISIONS : MAX_PLUGIN_HOOK_FAILURES,
          );
        if (pruned.changes > 0)
          this.#db()
            .prepare("INSERT OR IGNORE INTO tavi_plugin_hook_prunes (plugin_id, kind) VALUES (?, ?)")
            .run(record.pluginId, record.kind);
      })
      .immediate();
  }
  hookActivity(pluginId: string, recent: number): PluginHookActivity {
    const counts = this.#db()
      .prepare("SELECT kind, COUNT(*) AS count FROM tavi_plugin_hook_events WHERE plugin_id = ? GROUP BY kind")
      .all(pluginId) as Array<{ kind: "decision" | "failure"; count: number }>;
    const decisions = counts.find((row) => row.kind === "decision")?.count ?? 0;
    const failures = counts.find((row) => row.kind === "failure")?.count ?? 0;
    // Only once a kind's oldest rows were removed: a count at its bound may be every row there was.
    const pruned = this.#db().prepare("SELECT 1 FROM tavi_plugin_hook_prunes WHERE plugin_id = ? LIMIT 1").get(pluginId) !== undefined;
    return { decisions, failures, recent: this.listHookEvents(pluginId, recent), ...(pruned ? { pruned: true as const } : {}) };
  }

  listHookEvents(pluginId: string, limit: number): readonly PluginHookEventRecord[] {
    const rows = this.#db()
      .prepare(
        "SELECT plugin_id, kind, event, tool, task_id, workspace_id, rule_id, detail, created_at FROM tavi_plugin_hook_events WHERE plugin_id = ? ORDER BY event_seq DESC LIMIT ?",
      )
      .all(pluginId, Math.max(0, Math.min(limit, MAX_PLUGIN_HOOK_EVENTS))) as Array<{
      plugin_id: string;
      kind: "decision" | "failure";
      event: PluginHookEventRecord["event"];
      tool: string | null;
      task_id: string | null;
      workspace_id: string | null;
      rule_id: string | null;
      detail: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      pluginId: row.plugin_id,
      kind: row.kind,
      event: row.event,
      ...(row.tool === null ? {} : { tool: row.tool }),
      ...(row.task_id === null ? {} : { taskId: row.task_id }),
      ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
      ...(row.rule_id === null ? {} : { ruleId: row.rule_id }),
      detail: row.detail,
      at: row.created_at,
    }));
  }

  clearHookEvents(pluginId: string): boolean {
    this.#db().prepare("DELETE FROM tavi_plugin_hook_prunes WHERE plugin_id = ?").run(pluginId);
    return this.#db().prepare("DELETE FROM tavi_plugin_hook_events WHERE plugin_id = ?").run(pluginId).changes > 0;
  }
}

/**
 * Delete the hook rows of these tasks (for the heartbeat's retention and
 * *Forget heartbeat history*). A plugin and kind
 * that lost rows is marked pruned, so its counts no longer read as complete.
 * Runs inside the caller's transaction. Answers how many rows went.
 */
export function deleteHookEventsForTasks(db: Database, taskIds: readonly string[]): number {
  if (taskIds.length === 0) return 0;
  const ids = JSON.stringify(taskIds);
  const touched = db
    .prepare("SELECT DISTINCT plugin_id, kind FROM tavi_plugin_hook_events WHERE task_id IN (SELECT value FROM json_each(?))")
    .all(ids) as { plugin_id: string; kind: string }[];
  const deleted = db.prepare("DELETE FROM tavi_plugin_hook_events WHERE task_id IN (SELECT value FROM json_each(?))").run(ids).changes;
  const mark = db.prepare("INSERT OR IGNORE INTO tavi_plugin_hook_prunes (plugin_id, kind) VALUES (?, ?)");
  for (const row of touched) mark.run(row.plugin_id, row.kind);
  return deleted;
}
