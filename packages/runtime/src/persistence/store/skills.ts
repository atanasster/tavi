import type { SkillRepositoryPort, SkillRolloutRepositoryPort } from "../internal-contracts.js";
import {
  MAX_SKILL_USES_PER_SKILL,
  SKILL_USE_RETENTION_DAYS,
  SkillVersionSchema,
  type SkillActivation,
  type SkillActivationHistoryEntry,
  type SkillActivationReason,
  type SkillReviewState,
  type SkillUsage,
  type SkillUse,
  type SkillVersion,
  SkillRolloutAllowlistEntrySchema,
  type SkillRolloutAllowlistEntry,
} from "@tavi/contracts";
import type { StoreContext } from "./context.js";
import { parseJsonColumn, parseStoredRow } from "./stored-values.js";

/**
 * Approved versioned skills. A version row is
 * inserted once and never updated except its review state; activation is a
 * compare-and-set against the current pointer, the same pattern
 * `SqliteMemoryRepository.applyLifecycle` uses.
 */
export class SqliteSkillRepository implements SkillRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  insertVersion(version: SkillVersion): void {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_skill_versions
           (skill_id, version, content_hash, parent_version, scope_key, manifest_json,
            supported_runtime_versions_json, supported_tool_contract_versions_json, provenance,
            review_state, package_artifact_id, imported_by, imported_at, reviewed_by, reviewed_at)
         VALUES (@skillId, @version, @contentHash, @parentVersion, @scopeKey, @manifestJson,
                 @supportedRuntimeVersionsJson, @supportedToolContractVersionsJson, @provenance,
                 @reviewState, @packageArtifactId, @importedBy, @importedAt, @reviewedBy, @reviewedAt)`,
      )
      .run({
        skillId: version.skillId,
        version: version.version,
        contentHash: version.contentHash,
        parentVersion: version.parentVersion ?? null,
        scopeKey: version.scopeKey,
        manifestJson: JSON.stringify(version.manifest),
        // Retired columns, kept for the rows that still carry them: a new version writes none.
        supportedRuntimeVersionsJson: JSON.stringify(version.manifest.supportedRuntimeVersions ?? []),
        supportedToolContractVersionsJson: JSON.stringify(version.manifest.supportedToolContractVersions ?? []),
        provenance: version.provenance,
        reviewState: version.reviewState,
        packageArtifactId: version.packageArtifactId,
        importedBy: version.importedBy,
        importedAt: version.importedAt,
        reviewedBy: version.reviewedBy ?? null,
        reviewedAt: version.reviewedAt ?? null,
      });
  }

  getVersion(scopeKey: string, skillId: string, version: string): SkillVersion | undefined {
    const row = this.#store.handle
      .prepare("SELECT * FROM tavi_skill_versions WHERE scope_key = ? AND skill_id = ? AND version = ?")
      .get(scopeKey, skillId, version) as SkillVersionRow | undefined;
    return row === undefined ? undefined : toSkillVersion(row);
  }

  listVersions(input: { readonly scopeKey: string; readonly skillId?: string }): readonly SkillVersion[] {
    const rows =
      input.skillId === undefined
        ? (this.#store.handle
            .prepare("SELECT * FROM tavi_skill_versions WHERE scope_key = ? ORDER BY skill_id, imported_at DESC")
            .all(input.scopeKey) as SkillVersionRow[])
        : (this.#store.handle
            .prepare("SELECT * FROM tavi_skill_versions WHERE scope_key = ? AND skill_id = ? ORDER BY imported_at DESC")
            .all(input.scopeKey, input.skillId) as SkillVersionRow[]);
    return rows.map(toSkillVersion);
  }

  setReviewState(input: {
    readonly scopeKey: string;
    readonly skillId: string;
    readonly version: string;
    readonly reviewState: SkillReviewState;
    readonly reviewedBy: string;
    readonly reviewedAt: string;
  }): void {
    this.#store.handle
      .prepare(
        `UPDATE tavi_skill_versions
            SET review_state = @reviewState, reviewed_by = @reviewedBy, reviewed_at = @reviewedAt
          WHERE scope_key = @scopeKey AND skill_id = @skillId AND version = @version`,
      )
      .run(input);
  }

  getActivation(scopeKey: string, skillId: string): SkillActivation | undefined {
    const row = this.#store.handle
      .prepare("SELECT * FROM tavi_skill_activations WHERE scope_key = ? AND skill_id = ?")
      .get(scopeKey, skillId) as SkillActivationRow | undefined;
    return row === undefined ? undefined : toSkillActivation(row);
  }

  listActivations(scopeKey: string): readonly SkillActivation[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_skill_activations WHERE scope_key = ? ORDER BY skill_id")
      .all(scopeKey) as SkillActivationRow[];
    return rows.map(toSkillActivation);
  }

  setActivation(input: {
    readonly scopeKey: string;
    readonly skillId: string;
    readonly newVersion: string | null;
    readonly expectedCurrentVersion: string | null | undefined;
    readonly activatedBy: string;
    readonly activatedAt: string;
    readonly reason: SkillActivationReason;
    readonly historyId: string;
  }): boolean {
    // An immediate transaction: the write lock is taken before this reads
    // the current pointer, so the read and the write are atomic against a
    // concurrent writer rather than merely checked-then-hopefully-still-true
    return this.#store.transactionImmediate(() => {
      const current = this.getActivation(input.scopeKey, input.skillId);
      // `undefined` means the caller has no expectation to compare — the
      // write still proceeds, still serialized by the lock above, just
      // without rejecting a pointer that moved since a read the caller never
      // did.
      if (input.expectedCurrentVersion !== undefined && (current?.activeVersion ?? null) !== input.expectedCurrentVersion) {
        return false;
      }
      if (input.newVersion === null) {
        // `disable`: clear the pointer entirely
        // rather than writing a row `tavi_skill_activations.active_version
        // TEXT NOT NULL` could never represent.
        this.#store.handle
          .prepare("DELETE FROM tavi_skill_activations WHERE scope_key = ? AND skill_id = ?")
          .run(input.scopeKey, input.skillId);
      } else {
        this.#store.handle
          .prepare(
            `INSERT INTO tavi_skill_activations (scope_key, skill_id, active_version, activated_by, activated_at)
             VALUES (@scopeKey, @skillId, @activeVersion, @activatedBy, @activatedAt)
             ON CONFLICT(scope_key, skill_id) DO UPDATE SET
               active_version = excluded.active_version,
               activated_by = excluded.activated_by,
               activated_at = excluded.activated_at`,
          )
          .run({
            scopeKey: input.scopeKey,
            skillId: input.skillId,
            activeVersion: input.newVersion,
            activatedBy: input.activatedBy,
            activatedAt: input.activatedAt,
          });
      }
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_skill_activation_history
             (history_id, scope_key, skill_id, previous_version, new_version, reason, actor, at)
           VALUES (@historyId, @scopeKey, @skillId, @previousVersion, @newVersion, @reason, @actor, @at)`,
        )
        .run({
          historyId: input.historyId,
          scopeKey: input.scopeKey,
          skillId: input.skillId,
          previousVersion: current?.activeVersion ?? null,
          newVersion: input.newVersion,
          reason: input.reason,
          actor: input.activatedBy,
          at: input.activatedAt,
        });
      return true;
    });
  }

  listActivationHistory(scopeKey: string, skillId: string): readonly SkillActivationHistoryEntry[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_skill_activation_history WHERE scope_key = ? AND skill_id = ? ORDER BY at DESC")
      .all(scopeKey, skillId) as SkillActivationHistoryRow[];
    return rows.map(toSkillActivationHistoryEntry);
  }

  recordUse(use: SkillUse): void {
    const cutoff = new Date(Date.parse(use.usedAt) - SKILL_USE_RETENTION_DAYS * 86_400_000).toISOString();
    this.#store.transaction(() => {
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_skill_uses (scope_key, task_id, skill_id, version, source, used_at)
           VALUES (@scopeKey, @taskId, @skillId, @version, @source, @usedAt)
           ON CONFLICT (scope_key, skill_id, task_id, version, source) DO UPDATE SET used_at = excluded.used_at`,
        )
        .run(use);
      // Bounded: a year of uses in the workspace, and no more than the cap for this skill, newest kept.
      this.#store.handle.prepare("DELETE FROM tavi_skill_uses WHERE scope_key = ? AND used_at < ?").run(use.scopeKey, cutoff);
      this.#store.handle
        .prepare(
          `DELETE FROM tavi_skill_uses WHERE rowid IN (
             SELECT rowid FROM tavi_skill_uses WHERE scope_key = ? AND skill_id = ?
              ORDER BY used_at DESC LIMIT -1 OFFSET ?)`,
        )
        .run(use.scopeKey, use.skillId, MAX_SKILL_USES_PER_SKILL);
    });
  }

  listUsage(scopeKey: string): readonly SkillUsage[] {
    const rows = this.#store.handle
      .prepare(
        `SELECT skill_id, COUNT(*) AS uses, MAX(used_at) AS last_used_at FROM tavi_skill_uses
          WHERE scope_key = ? GROUP BY skill_id ORDER BY skill_id`,
      )
      .all(scopeKey) as { readonly skill_id: string; readonly uses: number; readonly last_used_at: string }[];
    return rows.map((row) => ({ skillId: row.skill_id, uses: row.uses, lastUsedAt: row.last_used_at }));
  }
}

interface SkillVersionRow {
  readonly skill_id: string;
  readonly version: string;
  readonly content_hash: string;
  readonly parent_version: string | null;
  readonly scope_key: string;
  readonly manifest_json: string;
  readonly provenance: string;
  readonly review_state: string;
  readonly package_artifact_id: string;
  readonly imported_by: string;
  readonly imported_at: string;
  readonly reviewed_by: string | null;
  readonly reviewed_at: string | null;
}

function toSkillVersion(row: SkillVersionRow): SkillVersion {
  return parseStoredRow<SkillVersion>(
    SkillVersionSchema,
    {
      skillId: row.skill_id,
      version: row.version,
      contentHash: row.content_hash,
      scopeKey: row.scope_key,
      manifest: parseJsonColumn(row.manifest_json, "skill manifest"),
      provenance: row.provenance,
      reviewState: row.review_state,
      packageArtifactId: row.package_artifact_id,
      importedBy: row.imported_by,
      importedAt: row.imported_at,
      ...(row.parent_version === null ? {} : { parentVersion: row.parent_version }),
      ...(row.reviewed_by === null ? {} : { reviewedBy: row.reviewed_by }),
      ...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
    },
    "skill version",
  );
}

interface SkillActivationRow {
  readonly scope_key: string;
  readonly skill_id: string;
  readonly active_version: string;
  readonly activated_by: string;
  readonly activated_at: string;
}

function toSkillActivation(row: SkillActivationRow): SkillActivation {
  return {
    scopeKey: row.scope_key,
    skillId: row.skill_id,
    activeVersion: row.active_version,
    activatedBy: row.activated_by,
    activatedAt: row.activated_at,
  };
}

interface SkillActivationHistoryRow {
  readonly history_id: string;
  readonly scope_key: string;
  readonly skill_id: string;
  readonly previous_version: string | null;
  readonly new_version: string | null;
  readonly reason: string;
  readonly actor: string;
  readonly at: string;
}

function toSkillActivationHistoryEntry(row: SkillActivationHistoryRow): SkillActivationHistoryEntry {
  return {
    historyId: row.history_id,
    scopeKey: row.scope_key,
    skillId: row.skill_id,
    reason: row.reason as SkillActivationReason,
    actor: row.actor,
    at: row.at,
    ...(row.previous_version === null ? {} : { previousVersion: row.previous_version }),
    ...(row.new_version === null ? {} : { newVersion: row.new_version }),
  };
}

export class SqliteSkillRolloutRepository implements SkillRolloutRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  allow(entry: SkillRolloutAllowlistEntry): void {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_skill_rollout_allowlist (entry_id, scope_key, skill_id, version, task_id, authorized_by, authorized_at)
         VALUES (@entryId, @scopeKey, @skillId, @version, @taskId, @authorizedBy, @authorizedAt)
         ON CONFLICT (scope_key, skill_id, version, task_id) DO NOTHING`,
      )
      .run({
        entryId: entry.entryId,
        scopeKey: entry.scopeKey,
        skillId: entry.skillId,
        version: entry.version,
        taskId: entry.taskId,
        authorizedBy: entry.authorizedBy,
        authorizedAt: entry.authorizedAt,
      });
  }

  isAllowed(input: { readonly scopeKey: string; readonly skillId: string; readonly version: string; readonly taskId: string }): boolean {
    const row = this.#store.handle
      .prepare(`SELECT 1 FROM tavi_skill_rollout_allowlist WHERE scope_key = ? AND skill_id = ? AND version = ? AND task_id = ? LIMIT 1`)
      .get(input.scopeKey, input.skillId, input.version, input.taskId);
    return row !== undefined;
  }

  isPinned(input: { readonly scopeKey: string; readonly skillId: string; readonly version: string }): boolean {
    const row = this.#store.handle
      .prepare(`SELECT 1 FROM tavi_skill_rollout_allowlist WHERE scope_key = ? AND skill_id = ? AND version = ? LIMIT 1`)
      .get(input.scopeKey, input.skillId, input.version);
    return row !== undefined;
  }

  listAllowed(input: {
    readonly scopeKey: string;
    readonly skillId: string;
    readonly version: string;
  }): readonly SkillRolloutAllowlistEntry[] {
    const rows = this.#store.handle
      .prepare(`SELECT * FROM tavi_skill_rollout_allowlist WHERE scope_key = ? AND skill_id = ? AND version = ? ORDER BY authorized_at ASC`)
      .all(input.scopeKey, input.skillId, input.version) as SkillRolloutAllowlistRow[];
    return rows.map(toSkillRolloutAllowlistEntry);
  }

  clear(input: { readonly scopeKey: string; readonly skillId: string; readonly version: string }): void {
    this.#store.handle
      .prepare(`DELETE FROM tavi_skill_rollout_allowlist WHERE scope_key = ? AND skill_id = ? AND version = ?`)
      .run(input.scopeKey, input.skillId, input.version);
  }

  // `ORDER BY version ASC` is LEXICOGRAPHIC, not semver-aware — `version`
  // is a free-form string (`SkillRolloutAllowlistEntrySchema.version`),
  // so e.g. "1.10.0" sorts before "1.2.0". Display-ordering only:
  // doesn't affect `isAllowed`/`isPinned`/`clear`
  // correctness, which key on the exact triple string, never on order.
  // A caller wanting semver order should re-sort with a real comparator.
  listPinnedVersions(input: {
    readonly scopeKey: string;
    readonly skillId: string;
  }): readonly { readonly version: string; readonly taskCount: number }[] {
    const rows = this.#store.handle
      .prepare(
        `SELECT version, COUNT(*) AS task_count FROM tavi_skill_rollout_allowlist
           WHERE scope_key = ? AND skill_id = ?
           GROUP BY version
           ORDER BY version ASC`,
      )
      .all(input.scopeKey, input.skillId) as { readonly version: string; readonly task_count: number }[];
    return rows.map((row) => ({ version: row.version, taskCount: row.task_count }));
  }
}

interface SkillRolloutAllowlistRow {
  readonly entry_id: string;
  readonly scope_key: string;
  readonly skill_id: string;
  readonly version: string;
  readonly task_id: string;
  readonly authorized_by: string;
  readonly authorized_at: string;
}

function toSkillRolloutAllowlistEntry(row: SkillRolloutAllowlistRow): SkillRolloutAllowlistEntry {
  return parseStoredRow<SkillRolloutAllowlistEntry>(
    SkillRolloutAllowlistEntrySchema,
    {
      entryId: row.entry_id,
      scopeKey: row.scope_key,
      skillId: row.skill_id,
      version: row.version,
      taskId: row.task_id,
      authorizedBy: row.authorized_by,
      authorizedAt: row.authorized_at,
    },
    "skill rollout allowlist entry",
  );
}
