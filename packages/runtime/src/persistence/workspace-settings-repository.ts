import type { WorkspaceSettingsRepositoryPort } from "./internal-contracts.js";
import {
  IdSchema,
  SetWorkspaceSettingsInputSchema,
  TaviError,
  WorkspaceSettingsRecordSchema,
  WorkspaceSettingsSchema,
  absentWorkspaceSettings,
  type SetWorkspaceSettingsInput,
  type WorkspaceSettings,
  type WorkspaceSettingsRecord,
  parseOrThrow,
} from "@tavi/contracts";
import { isRecord } from "@tavi/contracts/util";

import type { Database } from "./sqlite-loader.js";

interface WorkspaceSettingsRow {
  readonly workspace_id: string;
  readonly settings_json: string;
  readonly revision: number;
  readonly actor: string | null;
  readonly updated_at: string;
}

/** What the repository needs of the store: its handle, and a write-locked transaction for the compare-and-set. */
export interface WorkspaceSettingsStore {
  readonly handle: Database;
  transactionImmediate<T>(fn: () => T): T;
}

/**
 * Per-workspace settings.
 *
 * `set` replaces the whole document under `transactionImmediate`, for the
 * reason `SqliteSystemPromptRepository` gives: a read-then-write inside a
 * deferred transaction is not atomic against another writer under WAL. A stale
 * expected revision is a `CONFLICT` naming both revisions.
 */
export class SqliteWorkspaceSettingsRepository implements WorkspaceSettingsRepositoryPort {
  readonly #store: WorkspaceSettingsStore;

  constructor(store: WorkspaceSettingsStore) {
    this.#store = store;
  }

  get(workspaceId: string): WorkspaceSettingsRecord {
    const id = assertWorkspaceId(workspaceId);
    const row = this.#store.handle.prepare("SELECT * FROM tavi_workspace_settings WHERE workspace_id = ?").get(id) as
      | WorkspaceSettingsRow
      | undefined;
    if (row === undefined) return absentWorkspaceSettings(id);
    const parsed = WorkspaceSettingsRecordSchema.safeParse({
      workspaceId: row.workspace_id,
      settings: knownSettings(storedDocument(row.settings_json)),
      revision: row.revision,
      updatedAt: row.updated_at,
      actor: row.actor,
    });
    if (!parsed.success) {
      throw new TaviError("INTERNAL", `Stored settings for workspace ${id} have an unreadable revision, time or actor; restore a backup`, {
        details: { workspaceId: id, revision: row.revision },
      });
    }
    return parsed.data;
  }

  set(input: SetWorkspaceSettingsInput): WorkspaceSettingsRecord {
    const { workspaceId, settings, expectedRevision, actor, now } = parseOrThrow(
      SetWorkspaceSettingsInputSchema,
      input,
      "The workspace settings are not valid and were not written",
    );
    return this.#store.transactionImmediate(() => {
      const current = this.#revisionOf(workspaceId);
      if (current !== expectedRevision) {
        throw new TaviError(
          "CONFLICT",
          `The settings for workspace ${workspaceId} changed since they were read ` +
            `(expected revision ${expectedRevision}, current revision ${current})`,
          { details: { expectedRevision, currentRevision: current } },
        );
      }
      // Keys this build does not know are carried over, so an older build
      // changing one setting does not erase a newer build's.
      const stored = this.#store.handle
        .prepare("SELECT settings_json FROM tavi_workspace_settings WHERE workspace_id = ?")
        .get(workspaceId) as { readonly settings_json: string } | undefined;
      const document = { ...unknownKeys(stored === undefined ? {} : storedDocument(stored.settings_json)), ...settings };
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_workspace_settings (workspace_id, settings_json, revision, actor, updated_at)
           VALUES (@workspaceId, @settingsJson, @revision, @actor, @now)
           ON CONFLICT (workspace_id) DO UPDATE SET
             settings_json = @settingsJson, revision = @revision, actor = @actor, updated_at = @now`,
        )
        .run({ workspaceId, settingsJson: JSON.stringify(document), revision: current + 1, actor, now });
      return this.get(workspaceId);
    });
  }

  list(): readonly WorkspaceSettingsRecord[] {
    const ids = this.#store.handle.prepare("SELECT workspace_id FROM tavi_workspace_settings ORDER BY workspace_id").all() as {
      readonly workspace_id: string;
    }[];
    const records: WorkspaceSettingsRecord[] = [];
    for (const { workspace_id: workspaceId } of ids) {
      try {
        records.push(this.get(workspaceId));
      } catch {
        // An unreadable row is `get`'s to report, to the reader of that workspace.
      }
    }
    return records;
  }

  /** The stored revision alone, so an unreadable document can still be replaced. No row is revision zero. */
  #revisionOf(workspaceId: string): number {
    const row = this.#store.handle.prepare("SELECT revision FROM tavi_workspace_settings WHERE workspace_id = ?").get(workspaceId) as
      | { readonly revision: unknown }
      | undefined;
    if (row === undefined) return 0;
    const revision = WorkspaceSettingsRecordSchema.shape.revision.safeParse(row.revision);
    if (!revision.success) {
      throw new TaviError("INTERNAL", `Stored settings for workspace ${workspaceId} have an unreadable revision; restore a backup`, {
        details: { workspaceId },
      });
    }
    return revision.data;
  }
}

function assertWorkspaceId(value: unknown): string {
  const parsed = IdSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaviError("INVALID_INPUT", "The settings workspace id is not valid", {
      details: {
        reason: "expected a non-empty id of at most 128 characters",
        length: typeof value === "string" ? value.length : null,
      },
    });
  }
  return parsed.data;
}

/** The stored JSON as an object; anything else (unparseable, an array, a scalar) reads as no settings. */
function storedDocument(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * The keys this build knows, each kept only when its value is valid.
 *
 * A bad or unknown key is dropped rather than failing the read: every model
 * call reads the timezone, and one unusable value must not stop the workspace.
 */
function knownSettings(document: Record<string, unknown>): WorkspaceSettings {
  const settings: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(WorkspaceSettingsSchema.shape)) {
    if (key in document && schema.safeParse(document[key]).success) settings[key] = document[key];
  }
  return WorkspaceSettingsSchema.parse(settings);
}

/** The keys this build does not know, to be written back untouched. */
function unknownKeys(document: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(document).filter(([key]) => !(key in WorkspaceSettingsSchema.shape)));
}
