import {
  CENTER_GLOBAL_SCOPE,
  McpArgFloorSchema,
  TaviError,
  TimestampSchema,
  type McpNoticeKind,
  type McpNoticeRecord,
  type McpRepositoryPort,
  type McpToolDecision,
  type McpToolRecord,
  type McpToolState,
  type McpTreeIndexEntry,
  type McpVersionRecord,
  type RiskLevel,
  type ToolEffect,
} from "@tavi/contracts";

import { parseJsonColumn, StoredMcpToolDefinitionSchema } from "./json-column.js";
import type { Database } from "./sqlite-loader.js";

/**
 * MCP server versions, their tools, tree indexes and notices. Each call runs in the
 * worker's transaction, so `approveVersion` writes the plugin version's review
 * state, the version's approval and every tool row as one unit.
 */

interface VersionRow {
  readonly plugin_id: string;
  readonly version: string;
  readonly sandbox_state: McpVersionRecord["sandboxState"];
  readonly transport: McpVersionRecord["transport"];
  readonly era_prior_json: string | null;
  readonly http_mode: "streamable" | "sse" | null;
  readonly external_path: string | null;
  readonly external_sha256: string | null;
  readonly interpreter_path: string | null;
  readonly interpreter_sha256: string | null;
  readonly server_info_json: string | null;
  readonly instructions_text: string | null;
  readonly instructions_hash: string | null;
  readonly capabilities_json: string | null;
  readonly tree_index_stale: number;
  readonly added_from_workspace: string | null;
  readonly probed_at: string | null;
  readonly probed_by: string | null;
  readonly approved_at: string | null;
  readonly approved_by: string | null;
}

interface ToolRow {
  readonly plugin_id: string;
  readonly version: string;
  readonly name: string;
  readonly tool_id: string;
  readonly approved_def_hash: string | null;
  readonly approved_def_json: string | null;
  readonly observed_def_hash: string;
  readonly observed_def_json: string;
  readonly suggested_effect: ToolEffect;
  readonly suggested_min_risk: RiskLevel | null;
  readonly effect: ToolEffect | null;
  readonly min_risk: RiskLevel | null;
  readonly arg_floors_json: string | null;
  readonly timeout_ms: number | null;
  readonly ask_tainted: number;
  readonly doubtful: number;
  readonly flagged: number;
  readonly state: McpToolState;
  readonly reviewed_by: string | null;
  readonly reviewed_at: string | null;
}

interface NoticeRow {
  readonly notice_id: string;
  readonly plugin_id: string;
  readonly kind: McpNoticeKind;
  readonly detail_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly delivered_json: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
}

const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));

function toVersion(row: VersionRow): McpVersionRecord {
  return {
    pluginId: row.plugin_id,
    version: row.version,
    sandboxState: row.sandbox_state,
    transport: row.transport,
    ...(row.era_prior_json === null ? {} : { eraPrior: JSON.parse(row.era_prior_json) as unknown }),
    ...(row.http_mode === null ? {} : { httpMode: row.http_mode }),
    ...(row.external_path === null ? {} : { externalPath: row.external_path }),
    ...(row.external_sha256 === null ? {} : { externalSha256: row.external_sha256 }),
    ...(row.interpreter_path === null ? {} : { interpreterPath: row.interpreter_path }),
    ...(row.interpreter_sha256 === null ? {} : { interpreterSha256: row.interpreter_sha256 }),
    ...(row.server_info_json === null ? {} : { serverInfo: JSON.parse(row.server_info_json) as { name: string; version: string } }),
    ...(row.instructions_text === null ? {} : { instructions: row.instructions_text }),
    ...(row.instructions_hash === null ? {} : { instructionsHash: row.instructions_hash }),
    ...(row.capabilities_json === null ? {} : { capabilities: JSON.parse(row.capabilities_json) as unknown }),
    treeIndexStale: row.tree_index_stale === 1,
    ...(row.added_from_workspace === null ? {} : { addedFromWorkspace: row.added_from_workspace }),
    ...(row.probed_at === null ? {} : { probedAt: row.probed_at }),
    ...(row.probed_by === null ? {} : { probedBy: row.probed_by }),
    ...(row.approved_at === null ? {} : { approvedAt: row.approved_at }),
    ...(row.approved_by === null ? {} : { approvedBy: row.approved_by }),
  };
}

function toTool(row: ToolRow): McpToolRecord {
  const decision: McpToolDecision | undefined =
    row.effect === null || row.timeout_ms === null
      ? undefined
      : {
          effect: row.effect,
          ...(row.min_risk === null ? {} : { minRisk: row.min_risk }),
          ...(row.arg_floors_json === null ? {} : { argFloors: McpArgFloorSchema.array().parse(JSON.parse(row.arg_floors_json)) }),
          timeoutMs: row.timeout_ms,
          askTainted: row.ask_tainted === 1,
        };
  return {
    pluginId: row.plugin_id,
    version: row.version,
    name: row.name,
    toolId: row.tool_id,
    ...(row.approved_def_hash === null ? {} : { approvedDefHash: row.approved_def_hash }),
    ...(row.approved_def_json === null
      ? {}
      : { approvedDef: parseJsonColumn(StoredMcpToolDefinitionSchema, row.approved_def_json, "tavi_mcp_tools.approved_def_json") }),
    observedDefHash: row.observed_def_hash,
    observedDef: parseJsonColumn(StoredMcpToolDefinitionSchema, row.observed_def_json, "tavi_mcp_tools.observed_def_json"),
    suggestedEffect: row.suggested_effect,
    ...(row.suggested_min_risk === null ? {} : { suggestedMinRisk: row.suggested_min_risk }),
    ...(decision === undefined ? {} : { decision }),
    doubtful: row.doubtful === 1,
    flagged: row.flagged === 1,
    state: row.state,
    ...(row.reviewed_by === null ? {} : { reviewedBy: row.reviewed_by }),
    ...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
  };
}

function toNotice(row: NoticeRow): McpNoticeRecord {
  return {
    noticeId: row.notice_id,
    pluginId: row.plugin_id,
    kind: row.kind,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    delivered: JSON.parse(row.delivered_json) as Record<string, unknown>,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }),
  };
}

export class SqliteMcpRepository implements McpRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  #pluginVersion(pluginId: string, version: string): { readonly review_state: string } | undefined {
    return this.#db().prepare("SELECT review_state FROM tavi_plugin_versions WHERE plugin_id = ? AND version = ?").get(pluginId, version) as
      | { review_state: string }
      | undefined;
  }

  putVersion(record: McpVersionRecord): McpVersionRecord {
    if (this.#pluginVersion(record.pluginId, record.version) === undefined)
      throw new TaviError("NOT_FOUND", `plugin ${record.pluginId}@${record.version} is not installed`);
    for (const at of [record.probedAt, record.approvedAt]) if (at !== undefined) TimestampSchema.parse(at);
    this.#db()
      .prepare(`INSERT INTO tavi_mcp_versions (plugin_id, version, sandbox_state, transport, era_prior_json, http_mode, external_path, external_sha256, interpreter_path, interpreter_sha256,
        server_info_json, instructions_text, instructions_hash, capabilities_json, tree_index_stale, added_from_workspace, probed_at, probed_by, approved_at, approved_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (plugin_id, version) DO UPDATE SET sandbox_state = excluded.sandbox_state, transport = excluded.transport, era_prior_json = excluded.era_prior_json, http_mode = excluded.http_mode,
        external_path = excluded.external_path, external_sha256 = excluded.external_sha256, interpreter_path = excluded.interpreter_path, interpreter_sha256 = excluded.interpreter_sha256,
        server_info_json = excluded.server_info_json, instructions_text = excluded.instructions_text, instructions_hash = excluded.instructions_hash, capabilities_json = excluded.capabilities_json,
        tree_index_stale = excluded.tree_index_stale, added_from_workspace = COALESCE(tavi_mcp_versions.added_from_workspace, excluded.added_from_workspace),
        probed_at = excluded.probed_at, probed_by = excluded.probed_by, approved_at = excluded.approved_at, approved_by = excluded.approved_by`)
      .run(
        record.pluginId,
        record.version,
        record.sandboxState,
        record.transport,
        json(record.eraPrior),
        record.httpMode ?? null,
        record.externalPath ?? null,
        record.externalSha256 ?? null,
        record.interpreterPath ?? null,
        record.interpreterSha256 ?? null,
        json(record.serverInfo),
        record.instructions ?? null,
        record.instructionsHash ?? null,
        json(record.capabilities),
        record.treeIndexStale ? 1 : 0,
        record.addedFromWorkspace ?? null,
        record.probedAt ?? null,
        record.probedBy ?? null,
        record.approvedAt ?? null,
        record.approvedBy ?? null,
      );
    return this.getVersion(record.pluginId, record.version) as McpVersionRecord;
  }

  getVersion(pluginId: string, version: string): McpVersionRecord | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_mcp_versions WHERE plugin_id = ? AND version = ?").get(pluginId, version) as
      | VersionRow
      | undefined;
    return row === undefined ? undefined : toVersion(row);
  }

  listVersions(pluginId?: string): readonly McpVersionRecord[] {
    const rows = (
      pluginId === undefined
        ? this.#db().prepare("SELECT * FROM tavi_mcp_versions ORDER BY plugin_id, version").all()
        : this.#db().prepare("SELECT * FROM tavi_mcp_versions WHERE plugin_id = ? ORDER BY version").all(pluginId)
    ) as VersionRow[];
    return rows.map(toVersion);
  }

  putObservedTools(
    pluginId: string,
    version: string,
    tools: Parameters<McpRepositoryPort["putObservedTools"]>[2],
  ): readonly McpToolRecord[] {
    if (this.#pluginVersion(pluginId, version) === undefined)
      throw new TaviError("NOT_FOUND", `plugin ${pluginId}@${version} is not installed`);
    const before = new Map(this.listTools(pluginId, version).map((tool) => [tool.name, tool]));
    const names = new Set(tools.map((tool) => tool.name));
    const db = this.#db();
    // A tool the server no longer lists is removed; an approved one whose definition changed is withheld.
    for (const [name, earlier] of before) {
      if (!names.has(name))
        db.prepare("UPDATE tavi_mcp_tools SET state = 'removed' WHERE plugin_id = ? AND version = ? AND name = ?").run(
          pluginId,
          version,
          name,
        );
      else if (earlier.state === "removed")
        db.prepare("UPDATE tavi_mcp_tools SET state = 'pending' WHERE plugin_id = ? AND version = ? AND name = ?").run(
          pluginId,
          version,
          name,
        );
    }
    for (const tool of tools) {
      const earlier = before.get(tool.name);
      const state: McpToolState =
        earlier === undefined
          ? "pending"
          : earlier.state === "approved" && earlier.approvedDefHash !== tool.observedDefHash
            ? "withheld"
            : earlier.state === "removed"
              ? "pending"
              : earlier.state;
      db.prepare(`INSERT INTO tavi_mcp_tools (plugin_id, version, name, tool_id, observed_def_hash, observed_def_json, suggested_effect, suggested_min_risk, doubtful, flagged, state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (plugin_id, version, name) DO UPDATE SET observed_def_hash = excluded.observed_def_hash, observed_def_json = excluded.observed_def_json,
            suggested_effect = excluded.suggested_effect, suggested_min_risk = excluded.suggested_min_risk, doubtful = excluded.doubtful, flagged = excluded.flagged, state = excluded.state`).run(
        pluginId,
        version,
        tool.name,
        tool.toolId,
        tool.observedDefHash,
        JSON.stringify(tool.observedDef),
        tool.suggestedEffect,
        tool.suggestedMinRisk ?? null,
        tool.doubtful ? 1 : 0,
        tool.flagged ? 1 : 0,
        state,
      );
    }
    return this.listTools(pluginId, version);
  }

  listTools(pluginId: string, version?: string): readonly McpToolRecord[] {
    const rows = (
      version === undefined
        ? this.#db().prepare("SELECT * FROM tavi_mcp_tools WHERE plugin_id = ? ORDER BY version, name").all(pluginId)
        : this.#db().prepare("SELECT * FROM tavi_mcp_tools WHERE plugin_id = ? AND version = ? ORDER BY name").all(pluginId, version)
    ) as ToolRow[];
    return rows.map(toTool);
  }

  approveVersion(input: Parameters<McpRepositoryPort["approveVersion"]>[0]): readonly McpToolRecord[] {
    const { pluginId, version, by, now, decisions } = input;
    TimestampSchema.parse(now);
    const plugin = this.#pluginVersion(pluginId, version);
    if (plugin === undefined) throw new TaviError("NOT_FOUND", `plugin ${pluginId}@${version} is not installed`);
    if (plugin.review_state === "rejected")
      throw new TaviError("CONFLICT", `plugin ${pluginId}@${version} was rejected; install a new version to review again`);
    const record = this.getVersion(pluginId, version);
    if (record?.probedAt === undefined)
      throw new TaviError("CONFLICT", `${pluginId}@${version} has not been probed; probe it before approving`);
    const tools = this.listTools(pluginId, version).filter((tool) => tool.state !== "removed");
    const missing = tools.filter((tool) => decisions[tool.name] === undefined).map((tool) => tool.name);
    if (missing.length > 0) throw new TaviError("INVALID_INPUT", `no decision for ${missing.join(", ")}`);
    const unknown = Object.keys(decisions).filter((name) => !tools.some((tool) => tool.name === name));
    if (unknown.length > 0) throw new TaviError("INVALID_INPUT", `no tool named ${unknown.join(", ")}`);
    // Only what was reviewed is pinned: a definition changed since, or a tool added or gone, refuses the approval.
    const changed = tools.filter((tool) => input.expected[tool.name] !== tool.observedDefHash).map((tool) => tool.name);
    if (changed.length > 0 || Object.keys(input.expected).length !== tools.length) {
      throw new TaviError(
        "CONFLICT",
        `${pluginId}@${version}'s tools changed since they were reviewed${changed.length === 0 ? "" : ` (${changed.join(", ")})`}; read \`tavi mcp show ${pluginId}\` again`,
      );
    }
    const db = this.#db();
    const at = now;
    for (const tool of tools) {
      const decision = decisions[tool.name];
      if (decision === "disabled") {
        db.prepare(
          "UPDATE tavi_mcp_tools SET state = 'disabled', reviewed_by = ?, reviewed_at = ? WHERE plugin_id = ? AND version = ? AND name = ?",
        ).run(by, at, pluginId, version, tool.name);
        continue;
      }
      if (decision === undefined) continue;
      db.prepare(`UPDATE tavi_mcp_tools SET state = 'approved', approved_def_hash = observed_def_hash, approved_def_json = observed_def_json, effect = ?, min_risk = ?, arg_floors_json = ?,
          timeout_ms = ?, ask_tainted = ?, reviewed_by = ?, reviewed_at = ? WHERE plugin_id = ? AND version = ? AND name = ?`).run(
        decision.effect,
        decision.minRisk ?? null,
        decision.argFloors === undefined ? null : JSON.stringify(decision.argFloors),
        decision.timeoutMs,
        decision.askTainted ? 1 : 0,
        by,
        at,
        pluginId,
        version,
        tool.name,
      );
    }
    db.prepare(
      "UPDATE tavi_mcp_versions SET approved_at = ?, approved_by = ?, external_sha256 = COALESCE(?, external_sha256) WHERE plugin_id = ? AND version = ?",
    ).run(at, by, input.externalSha256 ?? null, pluginId, version);
    if (plugin.review_state !== "approved") {
      db.prepare(
        "UPDATE tavi_plugin_versions SET review_state = 'approved', reviewed_by = ?, reviewed_at = ? WHERE plugin_id = ? AND version = ?",
      ).run(by, at, pluginId, version);
    }
    return this.listTools(pluginId, version);
  }

  rejectVersion(pluginId: string, version: string, by: string, now: string): void {
    TimestampSchema.parse(now);
    if (this.#pluginVersion(pluginId, version) === undefined)
      throw new TaviError("NOT_FOUND", `plugin ${pluginId}@${version} is not installed`);
    const db = this.#db();
    db.prepare(
      "UPDATE tavi_plugin_versions SET review_state = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE plugin_id = ? AND version = ?",
    ).run(by, now, pluginId, version);
    db.prepare("UPDATE tavi_mcp_tools SET state = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE plugin_id = ? AND version = ?").run(
      by,
      now,
      pluginId,
      version,
    );
  }

  setToolState(pluginId: string, version: string, name: string, state: McpToolState, by: string, now: string): void {
    TimestampSchema.parse(now);
    const changed = this.#db()
      .prepare("UPDATE tavi_mcp_tools SET state = ?, reviewed_by = ?, reviewed_at = ? WHERE plugin_id = ? AND version = ? AND name = ?")
      .run(state, by, now, pluginId, version, name).changes;
    if (changed === 0) throw new TaviError("NOT_FOUND", `no tool ${name} of ${pluginId}@${version}`);
  }

  putTreeIndex(pluginId: string, version: string, entries: readonly McpTreeIndexEntry[]): void {
    const db = this.#db();
    db.prepare("DELETE FROM tavi_mcp_tree_index WHERE plugin_id = ? AND version = ?").run(pluginId, version);
    const insert = db.prepare(
      "INSERT INTO tavi_mcp_tree_index (plugin_id, version, path, size, mtime_ms, ctime_ms, ino, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const entry of entries)
      insert.run(pluginId, version, entry.path, entry.size, entry.mtimeMs, entry.ctimeMs, entry.ino, entry.sha256);
    db.prepare("UPDATE tavi_mcp_versions SET tree_index_stale = 0 WHERE plugin_id = ? AND version = ?").run(pluginId, version);
  }

  getTreeIndex(pluginId: string, version: string): readonly McpTreeIndexEntry[] {
    return (
      this.#db()
        .prepare(
          "SELECT path, size, mtime_ms, ctime_ms, ino, sha256 FROM tavi_mcp_tree_index WHERE plugin_id = ? AND version = ? ORDER BY path",
        )
        .all(pluginId, version) as { path: string; size: number; mtime_ms: number; ctime_ms: number; ino: number; sha256: string }[]
    ).map((row) => ({ path: row.path, size: row.size, mtimeMs: row.mtime_ms, ctimeMs: row.ctime_ms, ino: row.ino, sha256: row.sha256 }));
  }

  markTreeIndexesStale(): number {
    return this.#db().prepare("UPDATE tavi_mcp_versions SET tree_index_stale = 1 WHERE tree_index_stale = 0").run().changes;
  }

  setTreeIndexStale(pluginId: string, version: string, stale: boolean): void {
    this.#db()
      .prepare("UPDATE tavi_mcp_versions SET tree_index_stale = ? WHERE plugin_id = ? AND version = ?")
      .run(stale ? 1 : 0, pluginId, version);
  }

  upsertNotice(input: Parameters<McpRepositoryPort["upsertNotice"]>[0]): McpNoticeRecord {
    TimestampSchema.parse(input.now);
    this.#db()
      .prepare(`INSERT INTO tavi_mcp_notices (notice_id, plugin_id, kind, detail_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (plugin_id, kind) WHERE decided_at IS NULL DO UPDATE SET detail_json = excluded.detail_json, updated_at = excluded.updated_at`)
      .run(input.noticeId, input.pluginId, input.kind, JSON.stringify(input.detail), input.now, input.now);
    this.#noticesChanged();
    const row = this.#db()
      .prepare("SELECT * FROM tavi_mcp_notices WHERE plugin_id = ? AND kind = ? AND decided_at IS NULL")
      .get(input.pluginId, input.kind) as NoticeRow;
    return toNotice(row);
  }

  listNotices(options: { readonly pluginId?: string; readonly open?: boolean }): readonly McpNoticeRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (options.pluginId !== undefined) {
      where.push("plugin_id = ?");
      args.push(options.pluginId);
    }
    if (options.open === true) where.push("decided_at IS NULL");
    if (options.open === false) where.push("decided_at IS NOT NULL");
    const rows = this.#db()
      .prepare(`SELECT * FROM tavi_mcp_notices${where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`} ORDER BY updated_at, notice_id`)
      .all(...args) as NoticeRow[];
    return rows.map(toNotice);
  }

  decideNotice(noticeId: string, by: string, now: string): boolean {
    TimestampSchema.parse(now);
    const decided =
      this.#db()
        .prepare("UPDATE tavi_mcp_notices SET decided_at = ?, decided_by = ? WHERE notice_id = ? AND decided_at IS NULL")
        .run(now, by, noticeId).changes > 0;
    if (decided) this.#noticesChanged();
    return decided;
  }

  setNoticeDelivered(noticeId: string, delivered: Readonly<Record<string, unknown>>): void {
    this.#db().prepare("UPDATE tavi_mcp_notices SET delivered_json = ? WHERE notice_id = ?").run(JSON.stringify(delivered), noticeId);
  }

  deleteNotices(pluginId: string): number {
    const deleted = this.#db().prepare("DELETE FROM tavi_mcp_notices WHERE plugin_id = ?").run(pluginId).changes;
    if (deleted > 0) this.#noticesChanged();
    return deleted;
  }

  /** Center's *Servers* list moved: every open page reads its summary again (the owner-wide `plugin` change, MCP servers being plugins). */
  #noticesChanged(): void {
    this.#db()
      .prepare(
        "INSERT INTO tavi_center_versions (scope, kind, version) VALUES (?, 'plugin', 1) ON CONFLICT (scope, kind) DO UPDATE SET version = version + 1",
      )
      .run(CENTER_GLOBAL_SCOPE);
  }
}
