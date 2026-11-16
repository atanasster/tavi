import type { PersistencePort } from "../persistence/internal-contracts.js";
import { TaviError, type SkillActor } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";

import type { SkillService } from "./service.js";

export interface SkillRolloutServiceOptions {
  readonly now?: () => string;
  readonly newId?: (prefix: string) => string;
}

/**
 * A skill version's bounded rollout: pins a version to an explicit, small,
 * authorized task set (`SkillRolloutRepositoryPort`), narrower than the
 * workspace-wide `SkillActivation` pointer. Absence of any pin for a version
 * means unrestricted. Enforcement (which tasks actually see a pinned version)
 * runs where context is assembled, not here.
 */
export class SkillRolloutService {
  readonly #persistence: PersistencePort;
  readonly #skills: SkillService;
  readonly #now: () => string;
  readonly #newId: (prefix: string) => string;

  constructor(persistence: PersistencePort, skills: SkillService, options: SkillRolloutServiceOptions = {}) {
    this.#persistence = persistence;
    this.#skills = skills;
    this.#now = options.now ?? nowTimestamp;
    this.#newId = options.newId ?? ((prefix: string): string => `${prefix}-${crypto.randomUUID()}`);
  }

  get #skillRollout() {
    return this.#persistence.repositories.skillRollout;
  }

  /** Resolves and requires the currently active version, refusing (NOT_FOUND) when the skill has none. `verb` is appended to the error message when non-empty. */
  #requireActiveVersion(actor: SkillActor, skillId: string, verb: string): { readonly scopeKey: string; readonly activeVersion: string } {
    const scopeKey = actor.workspaceId;
    const activeVersion = this.#skills.show({ actor, skillId }).activation?.activeVersion;
    if (activeVersion === undefined) {
      const suffix = verb.length === 0 ? "" : ` ${verb}`;
      throw new TaviError("NOT_FOUND", `Skill ${skillId} has no active version in workspace ${scopeKey}${suffix}`);
    }
    return { scopeKey, activeVersion };
  }

  /**
   * Pins a version of `skillId` to an explicit task set. With no `version`,
   * pins the CURRENTLY active version (read here, never trusted from the
   * caller, so a pin can't land on a version already rolled back). With an
   * explicit `version`, the version must be stored but need not be active:
   * pinning before activating bounds a version from its very first admission,
   * with no window in which it is live for every task. The read and the
   * writes share one transaction so a concurrent `rollback()`/`activate()`
   * can't leave an orphaned pin.
   */
  pinRollout(input: {
    readonly actor: SkillActor;
    readonly skillId: string;
    readonly taskIds: readonly string[];
    readonly version?: string;
  }): void {
    if (input.taskIds.length === 0) {
      throw new TaviError("INVALID_INPUT", "pinRollout requires at least one taskId");
    }
    this.#persistence.transaction(() => {
      const scopeKey = input.actor.workspaceId;
      const version =
        input.version === undefined
          ? this.#requireActiveVersion(input.actor, input.skillId, "to pin a rollout for").activeVersion
          : this.#requireStoredVersion(input.actor, input.skillId, input.version);
      for (const taskId of input.taskIds) {
        this.#skillRollout.allow({
          entryId: this.#newId("rollout"),
          scopeKey,
          skillId: input.skillId,
          version,
          taskId,
          authorizedBy: input.actor.principalId,
          authorizedAt: this.#now(),
        });
      }
    });
  }

  /** An explicit `pinRollout` version must be one this workspace has stored (any review state), so a typo can't create an orphaned pin. */
  #requireStoredVersion(actor: SkillActor, skillId: string, version: string): string {
    const shown = this.#skills.show({ actor, skillId });
    if (!shown.versions.some((row) => row.version === version)) {
      throw new TaviError(
        "NOT_FOUND",
        `Skill ${skillId} has no stored version ${version} in workspace ${actor.workspaceId} to pin a rollout for`,
      );
    }
    return version;
  }

  /** Lifts the active version's bounded rollout back to general availability; a no-op when it was never pinned. */
  clearRollout(input: { readonly actor: SkillActor; readonly skillId: string }): void {
    this.#persistence.transaction(() => {
      const { scopeKey, activeVersion } = this.#requireActiveVersion(input.actor, input.skillId, "to clear a rollout for");
      this.#skillRollout.clear({ scopeKey, skillId: input.skillId, version: activeVersion });
    });
  }

  /** The active version's rollout status: `pinned: false` means unrestricted; `pinned: true` lists the authorized tasks. */
  getRolloutStatus(input: { readonly actor: SkillActor; readonly skillId: string }): {
    readonly version: string;
    readonly pinned: boolean;
    readonly authorizedTaskIds: readonly string[];
  } {
    const { scopeKey, activeVersion } = this.#requireActiveVersion(input.actor, input.skillId, "");
    const pinned = this.#skillRollout.isPinned({ scopeKey, skillId: input.skillId, version: activeVersion });
    const authorizedTaskIds = pinned
      ? this.#skillRollout.listAllowed({ scopeKey, skillId: input.skillId, version: activeVersion }).map((entry) => entry.taskId)
      : [];
    return { version: activeVersion, pinned, authorizedTaskIds };
  }

  /**
   * Every distinct version of `skillId` with at least one pin, `active`
   * marking the skill's current active version — so a stale pin on a version
   * rolled back away from stays visible. Never throws for a skill with no
   * active version.
   */
  listRolloutPins(input: {
    readonly actor: SkillActor;
    readonly skillId: string;
  }): readonly { readonly version: string; readonly taskCount: number; readonly active: boolean }[] {
    const scopeKey = input.actor.workspaceId;
    const activeVersion = this.#skills.show({ actor: input.actor, skillId: input.skillId }).activation?.activeVersion;
    return this.#skillRollout
      .listPinnedVersions({ scopeKey, skillId: input.skillId })
      .map((entry) => ({ ...entry, active: entry.version === activeVersion }));
  }

  /** Clears every pin for a SPECIFIC version (active or stale); clearing a version with no pins is a no-op. */
  clearRolloutVersion(input: { readonly actor: SkillActor; readonly skillId: string; readonly version: string }): void {
    this.#skillRollout.clear({ scopeKey: input.actor.workspaceId, skillId: input.skillId, version: input.version });
  }
}
