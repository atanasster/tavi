import type { AsyncRepository } from "../persistence-types.js";
import type { SkillRolloutAllowlistEntry } from "../skill-rollout.js";
import type {
  ActiveSkill,
  SkillActivation,
  SkillActivationHistoryEntry,
  SkillActivationReason,
  SkillManifest,
  SkillReviewState,
  SkillUsage,
  SkillUse,
  SkillVersion,
} from "../skills.js";

/**
 * Storage for approved versioned skills.
 *
 * A version is immutable once inserted: the repository never updates a
 * `(scopeKey, skillId, version)` row's content, only its review state. Activation is a
 * compare-and-set against the current pointer, the same pattern
 * `MemoryRepositoryPort.applyLifecycle` uses for a record's lifecycle.
 */
interface SkillRepositoryPortDefinition {
  insertVersion(version: SkillVersion): void;
  /** One workspace's version: another workspace's `(skillId, version)` is a different row, never this one. */
  getVersion(scopeKey: string, skillId: string, version: string): SkillVersion | undefined;
  listVersions(input: { readonly scopeKey: string; readonly skillId?: string }): readonly SkillVersion[];
  setReviewState(input: {
    readonly scopeKey: string;
    readonly skillId: string;
    readonly version: string;
    readonly reviewState: SkillReviewState;
    readonly reviewedBy: string;
    readonly reviewedAt: string;
  }): void;
  getActivation(scopeKey: string, skillId: string): SkillActivation | undefined;
  listActivations(scopeKey: string): readonly SkillActivation[];
  /**
   * Compare-and-set the active pointer and append a history entry, in one
   * transaction that takes its write lock before reading the current pointer
   * (an immediate, not deferred, transaction) — the read and the write are
   * atomic against a concurrent writer, not just checked-then-hopefully-still-true.
   *
   * `expectedCurrentVersion: string | null` compares against the stored
   * pointer (or its absence, for `null`) and returns `false` on a mismatch,
   * the same conflict-over-overwrite rule `MemoryRepositoryPort.applyLifecycle`
   * uses. `expectedCurrentVersion: undefined` means the caller has no prior
   * expectation and skips the compare — the write still happens atomically
   * (never interleaved with another writer), but nothing is protected against
   * a peer who activated a different version moments earlier; only an
   * explicit `expectedCurrentVersion` from a caller's own prior read gives
   * that protection.
   */
  /** `newVersion: null` clears the activation pointer entirely (`SkillServicePort.disable`) — `getActivation` returns `undefined` afterward, same as a skill never activated. */
  setActivation(input: {
    readonly scopeKey: string;
    readonly skillId: string;
    readonly newVersion: string | null;
    readonly expectedCurrentVersion: string | null | undefined;
    readonly activatedBy: string;
    readonly activatedAt: string;
    readonly reason: SkillActivationReason;
    readonly historyId: string;
  }): boolean;
  listActivationHistory(scopeKey: string, skillId: string): readonly SkillActivationHistoryEntry[];
  /**
   * Record a use (metadata only, never body text). The same `(task, skill,
   * version, source)` again moves its `usedAt` rather than adding a row. Uses
   * past `SKILL_USE_RETENTION_DAYS`, and a skill's past
   * `MAX_SKILL_USES_PER_SKILL`, are pruned in the same transaction.
   */
  recordUse(use: SkillUse): void;
  /** Each skill with a kept use in the workspace: how many, and the latest. */
  listUsage(scopeKey: string): readonly SkillUsage[];
}

export type SkillRepositoryPort = AsyncRepository<SkillRepositoryPortDefinition>;

export interface SkillActor {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly caller: string;
}

interface SkillServicePortDefinition {
  /**
   * Import a package. Enters `proposed` unless exact bytes were already
   * approved for this scope; re-importing the same
   * `(skillId, version)` with different bytes is a conflict, never a silent
   * overwrite.
   */
  import(input: {
    readonly actor: SkillActor;
    readonly skillId: string;
    readonly version: string;
    readonly manifest: SkillManifest;
    readonly packageBody: Uint8Array;
    readonly provenance: string;
    readonly parentVersion?: string;
    /** Enter `proposed` even when the exact bytes were approved before: an agent's proposal is always reviewed. */
    readonly alwaysReview?: boolean;
  }): SkillVersion;
  approve(input: { readonly actor: SkillActor; readonly skillId: string; readonly version: string }): SkillVersion;
  reject(input: { readonly actor: SkillActor; readonly skillId: string; readonly version: string }): SkillVersion;
  /**
   * Point the scope's activation at an approved version. Pass
   * `expectedCurrentVersion` (the version a caller's own prior read observed)
   * to make this a real compare-and-set against a concurrent activation;
   * omitting it still writes atomically but without that protection — see
   * `SkillRepositoryPort.setActivation`.
   */
  activate(input: {
    readonly actor: SkillActor;
    readonly skillId: string;
    readonly version: string;
    readonly expectedCurrentVersion?: string;
  }): SkillActivation;
  /**
   * Same mechanism as `activate`, but only onto a version this scope has
   * activated before — via `activate` or a prior `rollback` (a scope can
   * bounce between any two versions it has ever both had active; this is
   * deliberate, not a gap).
   */
  rollback(input: {
    readonly actor: SkillActor;
    readonly skillId: string;
    readonly version: string;
    readonly expectedCurrentVersion?: string;
  }): SkillActivation;
  /**
   * Clears the scope's activation for this skill entirely — what a skill
   * with no compatible prior version falls back to. No target version,
   * unlike `activate`/`rollback`:
   * `getActivation`/`show` report no activation afterward, the same as a
   * skill that was never activated. Returns `void` — there is no
   * `SkillActivation` to hand back once the pointer is cleared.
   */
  disable(input: { readonly actor: SkillActor; readonly skillId: string; readonly expectedCurrentVersion?: string }): void;
  list(input: { readonly actor: SkillActor; readonly skillId?: string }): readonly SkillVersion[];
  show(input: { readonly actor: SkillActor; readonly skillId: string }): {
    readonly versions: readonly SkillVersion[];
    readonly activation: SkillActivation | undefined;
    readonly history: readonly SkillActivationHistoryEntry[];
  };
  /**
   * The actor's workspace's currently active skills, each with its manifest
   * — the "approved skill/tool manifest" stage of context assembly. Empty
   * when nothing is activated; never includes a
   * `proposed`/`rejected` version, only whatever each skill's activation
   * pointer currently targets.
   */
  listActive(input: { readonly actor: SkillActor }): readonly ActiveSkill[];
}
export type SkillServicePort = AsyncRepository<SkillServicePortDefinition>;

/**
 * Skill bounded-rollout allowlist —
 * see `skill-rollout.ts`'s own header comment for why absence of any
 * row for a `(scopeKey, skillId, version)` triple means unrestricted.
 *
 * **Cleanup:** rows have no foreign key to `tavi_tasks` (deliberate — see
 * the migration's own comment, so a task can be pre-authorized before
 * it is ever admitted). Stale pins for a version that was rolled back
 * and never activated again are surfaced by `listPinnedVersions` and
 * removed by `clear` for that specific version. Rows for a DELETED task
 * need no sweep because no task-deletion mechanism exists in this
 * codebase — if one is ever added, that
 * becomes a real gap again.
 */
interface SkillRolloutRepositoryPortDefinition {
  /** Insert-only; a duplicate `(scopeKey, skillId, version, taskId)` is silently absorbed, not an error — re-authorizing an already-authorized task is a no-op. */
  allow(entry: SkillRolloutAllowlistEntry): void;
  /** True only when a `(scopeKey, skillId, version)` triple has at least one allowlist row AND `taskId` is one of them — false both when the triple is fully unrestricted (no rows at all) and when it's restricted but this taskId isn't listed; use `isPinned` to tell those two apart. */
  isAllowed(input: { readonly scopeKey: string; readonly skillId: string; readonly version: string; readonly taskId: string }): boolean;
  /** True when ANY allowlist row exists for this `(scopeKey, skillId, version)` triple — the triple has moved from "unrestricted" to "bounded," regardless of which specific tasks are listed. */
  isPinned(input: { readonly scopeKey: string; readonly skillId: string; readonly version: string }): boolean;
  listAllowed(input: {
    readonly scopeKey: string;
    readonly skillId: string;
    readonly version: string;
  }): readonly SkillRolloutAllowlistEntry[];
  /** Removes every allowlist row for this triple — the version returns to unrestricted (general availability). */
  clear(input: { readonly scopeKey: string; readonly skillId: string; readonly version: string }): void;
  /**
   * Every DISTINCT version of `skillId` that has
   * at least one allowlist row, with a count of how many tasks are
   * authorized for each — not just the currently active one `isPinned`/
   * `listAllowed` are scoped to. Gives visibility into stale pins: a
   * version can be pinned, then rolled back away
   * from and never activated again, and its allowlist rows would otherwise
   * be invisible to any query scoped to "the active version." Bounded —
   * a workspace/skill is expected to accumulate few distinct pinned
   * versions over its lifetime (an operator action, not a high-volume
   * write path), so no `limit` parameter is exposed; if that assumption
   * ever breaks, add one then.
   */
  listPinnedVersions(input: {
    readonly scopeKey: string;
    readonly skillId: string;
  }): readonly { readonly version: string; readonly taskCount: number }[];
}

export type SkillRolloutRepositoryPort = AsyncRepository<SkillRolloutRepositoryPortDefinition>;
