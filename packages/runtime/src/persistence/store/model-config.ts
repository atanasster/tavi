import type { ModelConfigRepositoryPort } from "../internal-contracts.js";
import {
  ModelCatalogEntrySchema,
  ModelConnectionSchema,
  presetPdfInput,
  ModelRoleBindingSchema,
  type ModelCatalogEntry,
  type ModelConnection,
  type ModelRole,
  type ModelRoleBinding,
  type ModelTarget,
  type ModelWorkspaceDefault,
} from "@tavi/contracts";
import type { StoreContext } from "./context.js";
import { parseJsonColumn, parseStoredRow } from "./stored-values.js";

/**
 * Application-owned model configuration.
 *
 * Rows are written and read whole: these records are operator configuration, not
 * hot-path state, so a read-modify-write transaction is simpler and safer than
 * partial updates that could leave a connection with a stale catalog or a role
 * pointing at a half-updated target.
 */
export class SqliteModelConfigRepository implements ModelConfigRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  listConnections(): readonly ModelConnection[] {
    const rows = this.#store.handle.prepare("SELECT * FROM tavi_model_connections ORDER BY connection_id").all() as ConnectionRow[];
    return rows.map(toConnection);
  }

  getConnection(connectionId: string): ModelConnection | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_model_connections WHERE connection_id = ?").get(connectionId) as
      | ConnectionRow
      | undefined;
    return row === undefined ? undefined : toConnection(row);
  }

  upsertConnection(connection: ModelConnection): ModelConnection {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_model_connections
           (connection_id, label, kind, base_url, credential_ref, default_model, headers_json, local_only, created_at, updated_at, provider_binding_json, pdf_input, pdf_engine, video_models, wire_api, stream_first_byte_seconds, stream_idle_seconds)
         VALUES (@connectionId, @label, @kind, @baseUrl, @credentialRef, @defaultModel, @headersJson, @localOnly, @createdAt, @updatedAt, @providerBindingJson, @pdfInput, @pdfEngine, @videoModels, @wireApi, @streamFirstByteSeconds, @streamIdleSeconds)
         ON CONFLICT(connection_id) DO UPDATE SET
           provider_binding_json = excluded.provider_binding_json,
           label = excluded.label,
           kind = excluded.kind,
           base_url = excluded.base_url,
           credential_ref = excluded.credential_ref,
           default_model = excluded.default_model,
           headers_json = excluded.headers_json,
           local_only = excluded.local_only,
           pdf_input = excluded.pdf_input,
           pdf_engine = excluded.pdf_engine,
           video_models = excluded.video_models,
           wire_api = excluded.wire_api,
           stream_first_byte_seconds = excluded.stream_first_byte_seconds,
           stream_idle_seconds = excluded.stream_idle_seconds,
           updated_at = excluded.updated_at`,
      )
      .run({
        connectionId: connection.connectionId,
        label: connection.label,
        kind: connection.kind,
        baseUrl: connection.baseUrl,
        credentialRef: connection.credentialRef,
        defaultModel: connection.defaultModel ?? null,
        providerBindingJson: connection.providerBinding === undefined ? null : JSON.stringify(connection.providerBinding),
        headersJson: connection.headers === undefined ? null : JSON.stringify(connection.headers),
        localOnly: connection.localOnly ? 1 : 0,
        pdfInput: connection.pdfInput ?? null,
        pdfEngine: connection.pdfEngine ?? null,
        videoModels:
          connection.videoModels === undefined || connection.videoModels.length === 0 ? null : JSON.stringify(connection.videoModels),
        wireApi: connection.wireApi ?? null,
        streamFirstByteSeconds: connection.streamFirstByteSeconds ?? null,
        streamIdleSeconds: connection.streamIdleSeconds ?? null,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      });
    return connection;
  }

  deleteConnection(connectionId: string): boolean {
    const result = this.#store.handle.prepare("DELETE FROM tavi_model_connections WHERE connection_id = ?").run(connectionId);
    return result.changes > 0;
  }

  referencedConnectionIds(): readonly string[] {
    const rows = this.#store.handle
      .prepare(
        `SELECT DISTINCT connection_id FROM tavi_model_catalog
         UNION
         SELECT DISTINCT connection_id FROM tavi_model_roles
         UNION
         SELECT DISTINCT connection_id FROM tavi_model_workspace_defaults`,
      )
      .all() as { connection_id: string }[];
    return rows.map((row) => row.connection_id);
  }

  listCatalog(connectionId: string): readonly ModelCatalogEntry[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_model_catalog WHERE connection_id = ? ORDER BY model_id")
      .all(connectionId) as CatalogRow[];
    return rows.map(toCatalogEntry);
  }

  replaceCatalog(connectionId: string, entries: readonly ModelCatalogEntry[]): void {
    this.#store.transaction(() => {
      this.#store.handle.prepare("DELETE FROM tavi_model_catalog WHERE connection_id = ?").run(connectionId);
      for (const entry of entries) this.putCatalogEntry(entry);
    });
  }

  putCatalogEntry(entry: ModelCatalogEntry): ModelCatalogEntry {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_model_catalog
           (connection_id, model_id, display_name, provenance, state, capabilities_json, context_window, max_tokens, discovered_at)
         VALUES (@connectionId, @modelId, @displayName, @provenance, @state, @capabilitiesJson, @contextWindow, @maxTokens, @discoveredAt)
         ON CONFLICT(connection_id, model_id) DO UPDATE SET
           display_name = excluded.display_name,
           provenance = excluded.provenance,
           state = excluded.state,
           capabilities_json = excluded.capabilities_json,
           context_window = excluded.context_window,
           max_tokens = excluded.max_tokens,
           discovered_at = excluded.discovered_at`,
      )
      .run({
        connectionId: entry.connectionId,
        modelId: entry.modelId,
        displayName: entry.displayName ?? null,
        provenance: entry.provenance,
        state: entry.state,
        capabilitiesJson: JSON.stringify(entry.capabilities),
        contextWindow: entry.contextWindow ?? null,
        maxTokens: entry.maxTokens ?? null,
        discoveredAt: entry.discoveredAt ?? null,
      });
    return entry;
  }

  downgradeCapabilities(connectionId: string): void {
    this.#store.transaction(() => {
      this.#store.handle
        .prepare(
          `UPDATE tavi_model_catalog
              SET state = 'available', capabilities_json = '[]'
            WHERE connection_id = ? AND (state = 'capable' OR capabilities_json <> '[]')`,
        )
        .run(connectionId);
    });
  }

  getWorkspaceDefault(workspaceId: string): ModelWorkspaceDefault | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_model_workspace_defaults WHERE workspace_id = ?").get(workspaceId) as
      | WorkspaceDefaultRow
      | undefined;
    return row === undefined
      ? undefined
      : {
          workspaceId: row.workspace_id,
          target: { connectionId: row.connection_id, model: row.model },
          updatedAt: row.updated_at,
        };
  }

  setWorkspaceDefault(value: ModelWorkspaceDefault): void {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_model_workspace_defaults (workspace_id, connection_id, model, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           connection_id = excluded.connection_id,
           model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .run(value.workspaceId, value.target.connectionId, value.target.model, value.updatedAt);
  }

  clearWorkspaceDefault(workspaceId: string): boolean {
    const result = this.#store.handle.prepare("DELETE FROM tavi_model_workspace_defaults WHERE workspace_id = ?").run(workspaceId);
    return result.changes > 0;
  }

  listRoleBindings(workspaceId: string): readonly ModelRoleBinding[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_model_roles WHERE workspace_id = ? ORDER BY role")
      .all(workspaceId) as RoleRow[];
    return rows.map(toRoleBinding);
  }

  getRoleBinding(workspaceId: string, role: ModelRole): ModelRoleBinding | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_model_roles WHERE workspace_id = ? AND role = ?").get(workspaceId, role) as
      | RoleRow
      | undefined;
    return row === undefined ? undefined : toRoleBinding(row);
  }

  setRoleBinding(binding: ModelRoleBinding): ModelRoleBinding {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_model_roles (workspace_id, role, connection_id, model, fallback_json, updated_at)
         VALUES (@workspaceId, @role, @connectionId, @model, @fallbackJson, @updatedAt)
         ON CONFLICT(workspace_id, role) DO UPDATE SET
           connection_id = excluded.connection_id,
           model = excluded.model,
           fallback_json = excluded.fallback_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        workspaceId: binding.workspaceId,
        role: binding.role,
        connectionId: binding.target.connectionId,
        model: binding.target.model,
        fallbackJson: JSON.stringify(binding.fallback),
        updatedAt: binding.updatedAt,
      });
    return binding;
  }

  clearRoleBinding(workspaceId: string, role: ModelRole): boolean {
    const result = this.#store.handle.prepare("DELETE FROM tavi_model_roles WHERE workspace_id = ? AND role = ?").run(workspaceId, role);
    return result.changes > 0;
  }
}

interface ConnectionRow {
  readonly connection_id: string;
  readonly label: string;
  readonly kind: string;
  readonly base_url: string;
  readonly credential_ref: string;
  readonly default_model: string | null;
  readonly provider_binding_json: string | null;
  readonly headers_json: string | null;
  readonly local_only: number;
  readonly pdf_input: string | null;
  readonly pdf_engine: string | null;
  readonly video_models: string | null;
  readonly wire_api: string | null;
  readonly stream_first_byte_seconds: number | null;
  readonly stream_idle_seconds: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function toConnection(row: ConnectionRow): ModelConnection {
  const headers = row.headers_json === null ? undefined : parseJsonColumn<Record<string, string>>(row.headers_json, "headers");
  return parseStoredRow<ModelConnection>(
    ModelConnectionSchema,
    {
      ...(row.provider_binding_json == null ? {} : { providerBinding: JSON.parse(row.provider_binding_json) as unknown }),
      connectionId: row.connection_id,
      label: row.label,
      kind: row.kind,
      baseUrl: row.base_url,
      credentialRef: row.credential_ref,
      localOnly: row.local_only === 1,
      // Nothing stored (a plugin-managed connection): what its endpoint's preset takes.
      pdfInput: row.pdf_input ?? presetPdfInput(row.base_url),
      ...(row.pdf_engine === null ? {} : { pdfEngine: row.pdf_engine }),
      ...(row.video_models === null ? {} : { videoModels: JSON.parse(row.video_models) as unknown }),
      ...(row.wire_api === null ? {} : { wireApi: row.wire_api }),
      ...(row.stream_first_byte_seconds === null ? {} : { streamFirstByteSeconds: row.stream_first_byte_seconds }),
      ...(row.stream_idle_seconds === null ? {} : { streamIdleSeconds: row.stream_idle_seconds }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.default_model === null ? {} : { defaultModel: row.default_model }),
      ...(headers === undefined ? {} : { headers }),
    },
    "model connection",
  );
}

interface CatalogRow {
  readonly connection_id: string;
  readonly model_id: string;
  readonly display_name: string | null;
  readonly provenance: string;
  readonly state: string;
  readonly capabilities_json: string;
  readonly context_window: number | null;
  readonly max_tokens: number | null;
  readonly discovered_at: string | null;
}

function toCatalogEntry(row: CatalogRow): ModelCatalogEntry {
  return parseStoredRow<ModelCatalogEntry>(
    ModelCatalogEntrySchema,
    {
      connectionId: row.connection_id,
      modelId: row.model_id,
      provenance: row.provenance,
      state: row.state,
      capabilities: parseJsonColumn<string[]>(row.capabilities_json, "capabilities"),
      ...(row.display_name === null ? {} : { displayName: row.display_name }),
      ...(row.context_window === null ? {} : { contextWindow: row.context_window }),
      ...(row.max_tokens === null ? {} : { maxTokens: row.max_tokens }),
      ...(row.discovered_at === null ? {} : { discoveredAt: row.discovered_at }),
    },
    "model catalog",
  );
}

interface RoleRow {
  readonly workspace_id: string;
  readonly role: string;
  readonly connection_id: string;
  readonly model: string;
  readonly fallback_json: string;
  readonly updated_at: string;
}

function toRoleBinding(row: RoleRow): ModelRoleBinding {
  return parseStoredRow<ModelRoleBinding>(
    ModelRoleBindingSchema,
    {
      workspaceId: row.workspace_id,
      role: row.role,
      target: { connectionId: row.connection_id, model: row.model },
      fallback: parseJsonColumn<ModelTarget[]>(row.fallback_json, "fallback"),
      updatedAt: row.updated_at,
    },
    "model role",
  );
}

interface WorkspaceDefaultRow {
  readonly workspace_id: string;
  readonly connection_id: string;
  readonly model: string;
  readonly updated_at: string;
}
