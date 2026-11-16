import type { ChannelIngressRepositoryPort, MessagingConnectionRepositoryPort } from "./internal-contracts.js";
import {
  MESSAGING_CONNECTION_AUTH_STATES,
  TaviError,
  type ChannelIngressSettings,
  type MessagingConnectionAuthState,
  type MessagingConnectionInput,
  type MessagingConnectionRecord,
} from "@tavi/contracts";

import type { Database } from "./sqlite-loader.js";

interface MessagingConnectionRow {
  readonly connection_id: string;
  readonly provider_id: string;
  readonly workspace_id: string;
  readonly label: string | null;
  readonly account_identity: string;
  readonly settings_json: string;
  readonly credential_refs_json: string;
  readonly enabled: number;
  readonly config_revision: number;
  readonly auth_state: string;
  readonly created_at: string;
  readonly updated_at: string;
  /** When it was removed; null while it is configured. */
  readonly deleted_at: string | null;
}

/** What the repository needs of the store: its handle, and a write-locked transaction for the read-then-write in `save`. */
export interface MessagingConnectionStore {
  readonly handle: Database;
  transactionImmediate<T>(fn: () => T): T;
}

/**
 * Configured messaging connections. `save` reads the row it replaces under `transactionImmediate`, so two
 * saves of one connection each get their own revision.
 */
export class SqliteMessagingConnectionRepository implements MessagingConnectionRepositoryPort {
  readonly #store: MessagingConnectionStore;

  constructor(store: MessagingConnectionStore) {
    this.#store = store;
  }

  save(input: MessagingConnectionInput, now: string): MessagingConnectionRecord {
    return this.#store.transactionImmediate(() => {
      // A removed connection's id is still its own: reused, it is the same connection back.
      const existing = this.#store.handle
        .prepare("SELECT provider_id, workspace_id FROM tavi_messaging_connections WHERE connection_id = ?")
        .get(input.connectionId) as Pick<MessagingConnectionRow, "provider_id" | "workspace_id"> | undefined;
      if (existing !== undefined && (existing.provider_id !== input.providerId || existing.workspace_id !== input.workspaceId)) {
        throw new TaviError(
          "CONFLICT",
          `Connection ${input.connectionId} belongs to ${existing.provider_id} in workspace ${existing.workspace_id}`,
        );
      }
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_messaging_connections
             (connection_id, provider_id, workspace_id, label, account_identity, settings_json, credential_refs_json, enabled, config_revision, auth_state, created_at, updated_at)
           VALUES (@connectionId, @providerId, @workspaceId, @label, @accountIdentity, @settings, @credentialRefs, @enabled, 1, @authState, @now, @now)
           ON CONFLICT (connection_id) DO UPDATE SET
             label = excluded.label, settings_json = excluded.settings_json, enabled = excluded.enabled,
             -- A sign-in is the sign-in flow's alone (markConnected, setAuthState): a save keeps the row's own, as it is
             -- now and not as the caller last read it, and a removed connection saved again comes back signed out.
             -- An expired one keeps its account too: a client change drops the token, and signing in again must be that account.
             account_identity = CASE WHEN tavi_messaging_connections.deleted_at IS NULL AND (json_extract(tavi_messaging_connections.credential_refs_json, '$.oauth') IS NOT NULL OR tavi_messaging_connections.auth_state = 'expired')
               THEN tavi_messaging_connections.account_identity ELSE excluded.account_identity END,
             credential_refs_json = CASE WHEN tavi_messaging_connections.deleted_at IS NULL AND json_extract(tavi_messaging_connections.credential_refs_json, '$.oauth') IS NOT NULL
               THEN json_set(json_remove(excluded.credential_refs_json, '$.oauth'), '$.oauth', json_extract(tavi_messaging_connections.credential_refs_json, '$.oauth'))
               ELSE json_remove(excluded.credential_refs_json, '$.oauth') END,
             auth_state = CASE WHEN tavi_messaging_connections.deleted_at IS NULL THEN tavi_messaging_connections.auth_state ELSE 'none' END,
             config_revision = tavi_messaging_connections.config_revision + 1, updated_at = excluded.updated_at, deleted_at = NULL`,
        )
        .run({
          connectionId: input.connectionId,
          providerId: input.providerId,
          workspaceId: input.workspaceId,
          label: input.label ?? null,
          accountIdentity: input.accountIdentity,
          settings: JSON.stringify(input.settings),
          credentialRefs: JSON.stringify(input.credentialRefs),
          enabled: input.enabled ? 1 : 0,
          authState: input.authState,
          now,
        });
      const saved = this.get(input.connectionId);
      if (saved === undefined) throw new TaviError("INTERNAL", `Connection ${input.connectionId} could not be read back after saving`);
      return saved;
    });
  }

  get(connectionId: string): MessagingConnectionRecord | undefined {
    const row = this.#store.handle
      .prepare("SELECT * FROM tavi_messaging_connections WHERE connection_id = ? AND deleted_at IS NULL")
      .get(connectionId) as MessagingConnectionRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  list(workspaceId?: string, options: { readonly includeDeleted?: boolean } = {}): readonly MessagingConnectionRecord[] {
    const deleted = options.includeDeleted === true ? "" : " AND deleted_at IS NULL";
    const rows = (
      workspaceId === undefined
        ? this.#store.handle
            .prepare(`SELECT * FROM tavi_messaging_connections WHERE 1 = 1${deleted} ORDER BY created_at, connection_id`)
            .all()
        : this.#store.handle
            .prepare(`SELECT * FROM tavi_messaging_connections WHERE workspace_id = ?${deleted} ORDER BY created_at, connection_id`)
            .all(workspaceId)
    ) as MessagingConnectionRow[];
    return rows.map(toRecord);
  }

  markConnected(input: {
    readonly connectionId: string;
    readonly workspaceId: string;
    readonly accountIdentity: string;
    readonly tokenRef: string;
    readonly now: string;
  }): boolean {
    const result = this.#store.handle
      .prepare(
        `UPDATE tavi_messaging_connections
            SET account_identity = @account, auth_state = 'connected',
                credential_refs_json = json_set(credential_refs_json, '$.oauth', @tokenRef),
                config_revision = config_revision + 1, updated_at = @now
          WHERE connection_id = @connectionId AND workspace_id = @workspaceId AND deleted_at IS NULL`,
      )
      .run({
        account: input.accountIdentity,
        tokenRef: input.tokenRef,
        now: input.now,
        connectionId: input.connectionId,
        workspaceId: input.workspaceId,
      });
    return result.changes > 0;
  }

  setAuthState(input: {
    readonly connectionId: string;
    readonly authState: MessagingConnectionAuthState;
    readonly dropToken?: boolean;
    readonly reopen?: boolean;
    readonly now: string;
  }): boolean {
    const result = this.#store.handle
      .prepare(
        `UPDATE tavi_messaging_connections
            SET auth_state = @authState,
                credential_refs_json = CASE WHEN @dropToken = 1 THEN json_remove(credential_refs_json, '$.oauth') ELSE credential_refs_json END,
                config_revision = config_revision + @bump, updated_at = @now
          WHERE connection_id = @connectionId AND deleted_at IS NULL AND (auth_state <> @authState OR @dropToken = 1)`,
      )
      .run({
        authState: input.authState,
        dropToken: input.dropToken === true ? 1 : 0,
        bump: input.reopen === false ? 0 : 1,
        now: input.now,
        connectionId: input.connectionId,
      });
    return result.changes > 0;
  }

  remove(connectionId: string, now: string): boolean {
    const result = this.#store.handle
      // Signed out with it: its token is deleted, so neither the reference nor a signed-in state outlives it.
      .prepare(
        "UPDATE tavi_messaging_connections SET deleted_at = ?, enabled = 0, auth_state = 'none', credential_refs_json = json_remove(credential_refs_json, '$.oauth'), config_revision = config_revision + 1, updated_at = ? WHERE connection_id = ? AND deleted_at IS NULL",
      )
      .run(now, now, connectionId);
    return result.changes > 0;
  }
}

function toRecord(row: MessagingConnectionRow): MessagingConnectionRecord {
  return {
    connectionId: row.connection_id,
    providerId: row.provider_id,
    workspaceId: row.workspace_id,
    ...(row.label === null ? {} : { label: row.label }),
    accountIdentity: row.account_identity,
    settings: jsonObject(row.settings_json, row.connection_id),
    credentialRefs: stringRecord(jsonObject(row.credential_refs_json, row.connection_id), row.connection_id),
    enabled: row.enabled === 1,
    configRevision: row.config_revision,
    authState: authState(row.auth_state, row.connection_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
  };
}

function jsonObject(text: string, connectionId: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new TaviError("INTERNAL", `Connection ${connectionId} has a malformed stored document`);
  return parsed as Record<string, unknown>;
}

function stringRecord(value: Readonly<Record<string, unknown>>, connectionId: string): Readonly<Record<string, string>> {
  for (const entry of Object.values(value)) {
    if (typeof entry !== "string") throw new TaviError("INTERNAL", `Connection ${connectionId} has a malformed credential reference`);
  }
  return value as Readonly<Record<string, string>>;
}

function authState(value: string, connectionId: string): MessagingConnectionAuthState {
  if (!(MESSAGING_CONNECTION_AUTH_STATES as readonly string[]).includes(value))
    throw new TaviError("INTERNAL", `Connection ${connectionId} has a malformed auth state`);
  return value as MessagingConnectionAuthState;
}

/** Where the channels' webhook ingress listens: one row, the owner's. */
export class SqliteChannelIngressRepository implements ChannelIngressRepositoryPort {
  readonly #store: MessagingConnectionStore;

  constructor(store: MessagingConnectionStore) {
    this.#store = store;
  }

  get(): ChannelIngressSettings | undefined {
    const row = this.#store.handle.prepare("SELECT host, port, public_url FROM tavi_channel_ingress WHERE singleton = 1").get() as
      | { host: string; port: number; public_url: string | null }
      | undefined;
    return row === undefined
      ? undefined
      : { host: row.host, port: row.port, ...(row.public_url === null ? {} : { publicUrl: row.public_url }) };
  }

  set(settings: ChannelIngressSettings, now: string): void {
    this.#store.handle
      .prepare(`INSERT INTO tavi_channel_ingress (singleton, host, port, public_url, updated_at) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT (singleton) DO UPDATE SET host = excluded.host, port = excluded.port, public_url = excluded.public_url, updated_at = excluded.updated_at`)
      .run(settings.host, settings.port, settings.publicUrl ?? null, now);
  }
}
