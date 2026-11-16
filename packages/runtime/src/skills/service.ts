import type { PersistencePort, SkillServicePort } from "../persistence/internal-contracts.js";

import {
  MAX_SKILL_ID_CHARS,
  MAX_SKILL_MANIFEST_BYTES,
  MAX_SKILL_PACKAGE_BYTES,
  MAX_SKILL_PROVENANCE_CHARS,
  MAX_SKILL_VERSION_CHARS,
  SkillManifestSchema,
  TaviError,
  type ActiveSkill,
  type SkillActivation,
  type SkillActivationHistoryEntry,
  type SkillActor,
  type SkillManifest,
  type SkillVersion,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";

/**
 * Approved versioned skills.
 *
 * Scope: basic import/approve/reject/activate/rollback, scoped by
 * workspace (`scopeKey` is the actor's `workspaceId`; finer-grained skill
 * scoping — per-agent, per-principal — is not implemented). Every operation
 * here is operator-only: there is no model-driven skill proposal, so unlike `MemoryService` there is
 * no `authority` split on `SkillActor` — a caller reaching this service at
 * all is already trusted.
 *
 * A version is immutable once imported: re-importing the same
 * `(skillId, version)` with different bytes is a conflict, never a silent
 * overwrite, and importing the same bytes again is idempotent. Skill packages
 * carry no activation hooks and are never executed by this service — they
 * are opaque content-addressed blobs; a real archive format would still need
 * internal-path validation.
 */
export class SkillService implements SkillServicePort {
  readonly #persistence: PersistencePort;
  readonly #now: () => string;
  readonly #newId: (prefix: string) => string;

  constructor(persistence: PersistencePort, options: { readonly now?: () => string; readonly newId?: (prefix: string) => string } = {}) {
    this.#persistence = persistence;
    this.#now = options.now ?? nowTimestamp;
    this.#newId = options.newId ?? ((prefix: string): string => `${prefix}-${crypto.randomUUID()}`);
  }

  get #skills() {
    return this.#persistence.repositories.skills;
  }

  get #artifacts() {
    return this.#persistence.repositories.artifacts;
  }

  import(input: Parameters<SkillServicePort["import"]>[0]): SkillVersion {
    this.#validateIdentity(input.skillId, input.version);
    const manifest = this.#validateManifest(input.manifest);
    if (input.provenance.trim().length === 0 || input.provenance.length > MAX_SKILL_PROVENANCE_CHARS) {
      throw new TaviError("INVALID_INPUT", `Provenance must be 1-${MAX_SKILL_PROVENANCE_CHARS} characters`);
    }
    if (input.packageBody.byteLength > MAX_SKILL_PACKAGE_BYTES) {
      throw new TaviError("INVALID_INPUT", `Skill package exceeds ${MAX_SKILL_PACKAGE_BYTES} bytes`);
    }
    if (input.packageBody.byteLength === 0) {
      throw new TaviError("INVALID_INPUT", "Skill package must not be empty");
    }

    const scopeKey = input.actor.workspaceId;
    const existing = this.#skills.getVersion(scopeKey, input.skillId, input.version);
    // Hashed locally, before any write, so an idempotent re-import or a
    // conflicting one can be decided without ever touching the artifact
    // store: publishing first and deciding after would orphan a file (and a
    // tavi_artifacts row) on every duplicate or conflicting import attempt.
    const contentHash = sha256Hex(input.packageBody);
    if (existing !== undefined) {
      if (existing.contentHash === contentHash) return existing; // identical re-import: idempotent
      throw new TaviError(
        "CONFLICT",
        `Skill ${input.skillId}@${input.version} is already imported with different content; versions are immutable`,
        { details: { skillId: input.skillId, version: input.version } },
      );
    }

    // A skill is instructions a model reads (`skills.read`, a routine's pin): text, refused here rather than when
    // first read. A bundle of files (an Agent Skills archive) must check each text entry instead of the whole body.
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(input.packageBody);
    } catch {
      throw new TaviError("INVALID_INPUT", `Skill ${input.skillId}@${input.version} must be UTF-8 text`);
    }

    // Exact bytes already approved for this scope (under any version string)
    // skip the review queue; anything else enters the proposed state.
    const priorApproved = this.#skills
      .listVersions({ scopeKey, skillId: input.skillId })
      .find((version) => version.reviewState === "approved" && version.contentHash === contentHash);

    // Only now, once we know a new row will actually be inserted, publish
    // the bytes. putArtifact computes its own sha256; it must agree with the
    // hash computed above, since both hash the exact same bytes.
    const artifact = this.#artifacts.putArtifact({
      workspaceId: input.actor.workspaceId,
      contentType: "application/octet-stream",
      body: input.packageBody,
      extension: "skillpkg",
    });

    const now = this.#now();
    // Bytes approved before carry that approval over, unless this import must be reviewed whatever it holds.
    const reviewState = priorApproved === undefined || input.alwaysReview === true ? "proposed" : "approved";
    const version: SkillVersion = {
      skillId: input.skillId,
      version: input.version,
      contentHash,
      scopeKey,
      manifest,
      provenance: input.provenance,
      reviewState,
      packageArtifactId: artifact.artifactId,
      importedBy: input.actor.principalId,
      importedAt: now,
      ...(input.parentVersion === undefined ? {} : { parentVersion: input.parentVersion }),
      ...(reviewState === "approved" ? { reviewedBy: input.actor.principalId, reviewedAt: now } : {}),
    };
    this.#skills.insertVersion(version);
    return version;
  }

  approve(input: Parameters<SkillServicePort["approve"]>[0]): SkillVersion {
    return this.#decide(input, "approved");
  }

  reject(input: Parameters<SkillServicePort["reject"]>[0]): SkillVersion {
    return this.#decide(input, "rejected");
  }

  #decide(
    input: { readonly actor: SkillActor; readonly skillId: string; readonly version: string },
    decision: "approved" | "rejected",
  ): SkillVersion {
    const scopeKey = input.actor.workspaceId;
    const version = this.#requireVersion(scopeKey, input.skillId, input.version);
    if (version.reviewState === decision) return version;
    if (version.reviewState !== "proposed") {
      throw new TaviError(
        "CONFLICT",
        `Skill ${input.skillId}@${input.version} is ${version.reviewState}; only a proposed version can be ${decision}`,
      );
    }
    const now = this.#now();
    this.#skills.setReviewState({
      scopeKey,
      skillId: input.skillId,
      version: input.version,
      reviewState: decision,
      reviewedBy: input.actor.principalId,
      reviewedAt: now,
    });
    return this.#requireVersion(scopeKey, input.skillId, input.version);
  }

  activate(input: Parameters<SkillServicePort["activate"]>[0]): SkillActivation {
    return this.#setActivation(input, "activate", { requirePreviouslyActive: false });
  }

  rollback(input: Parameters<SkillServicePort["rollback"]>[0]): SkillActivation {
    return this.#setActivation(input, "rollback", { requirePreviouslyActive: true });
  }

  /**
   * Clears the scope's activation for this
   * skill entirely. Separate from `#setActivation` (shared by
   * `activate`/`rollback`) since there is no target `SkillVersion` to
   * validate or point at — `disable` has nothing in common with those
   * two beyond writing through the same repository method with
   * `newVersion: null`.
   */
  disable(input: Parameters<SkillServicePort["disable"]>[0]): void {
    const scopeKey = input.actor.workspaceId;
    const currentBeforeWrite = this.#skills.getActivation(scopeKey, input.skillId);
    if (currentBeforeWrite === undefined) {
      // Already disabled (or never activated): a no-op, not a new
      // history entry — the history table stays a record of actual
      // changes, matching activate/rollback's own "already there" rule.
      return;
    }
    const applied = this.#skills.setActivation({
      scopeKey,
      skillId: input.skillId,
      newVersion: null,
      expectedCurrentVersion: input.expectedCurrentVersion,
      activatedBy: input.actor.principalId,
      activatedAt: this.#now(),
      reason: "disable",
      historyId: this.#newId("skillact"),
    });
    if (!applied) {
      throw new TaviError("REVISION_CONFLICT", `Skill ${input.skillId}'s activation changed while disabling it`);
    }
  }

  #setActivation(
    input: { readonly actor: SkillActor; readonly skillId: string; readonly version: string; readonly expectedCurrentVersion?: string },
    reason: "activate" | "rollback",
    options: { readonly requirePreviouslyActive: boolean },
  ): SkillActivation {
    const scopeKey = input.actor.workspaceId;
    const target = this.#requireVersion(scopeKey, input.skillId, input.version);
    if (target.reviewState !== "approved") {
      throw new TaviError(
        "CONFLICT",
        `Skill ${input.skillId}@${input.version} is ${target.reviewState}; only an approved version can be activated`,
      );
    }
    if (options.requirePreviouslyActive) {
      const history = this.#skills.listActivationHistory(scopeKey, input.skillId);
      const wasActive = history.some((entry) => entry.newVersion === input.version);
      if (!wasActive) {
        throw new TaviError(
          "INVALID_INPUT",
          `Skill ${input.skillId}@${input.version} was never active in this scope; rollback only targets a version this scope already activated`,
        );
      }
    }
    const currentBeforeWrite = this.#skills.getActivation(scopeKey, input.skillId);
    if (currentBeforeWrite?.activeVersion === input.version) {
      // Already the active version: a no-op, not a new history entry — the
      // history table stays a record of actual changes.
      return currentBeforeWrite;
    }
    // input.expectedCurrentVersion is passed through exactly as given — never
    // filled in from a read this service just did. Re-reading the current
    // pointer here and using it as "expected" would compare against a value
    // observed moments before the repository's own atomic read/write,
    // proving nothing about a genuinely concurrent writer; only a caller's
    // own prior read is a real expectation (see SkillRepositoryPort.setActivation).
    const applied = this.#skills.setActivation({
      scopeKey,
      skillId: input.skillId,
      newVersion: input.version,
      expectedCurrentVersion: input.expectedCurrentVersion,
      activatedBy: input.actor.principalId,
      activatedAt: this.#now(),
      reason,
      historyId: this.#newId("skillact"),
    });
    if (!applied) {
      throw new TaviError(
        "REVISION_CONFLICT",
        `Skill ${input.skillId}'s activation changed while ${reason === "activate" ? "activating" : "rolling back"} it`,
      );
    }
    const activation = this.#skills.getActivation(scopeKey, input.skillId);
    if (activation === undefined) {
      throw new TaviError("INTERNAL", `Skill activation for ${input.skillId} was not persisted`);
    }
    return activation;
  }

  list(input: Parameters<SkillServicePort["list"]>[0]): readonly SkillVersion[] {
    return this.#skills.listVersions({
      scopeKey: input.actor.workspaceId,
      ...(input.skillId === undefined ? {} : { skillId: input.skillId }),
    });
  }

  show(input: Parameters<SkillServicePort["show"]>[0]): {
    readonly versions: readonly SkillVersion[];
    readonly activation: SkillActivation | undefined;
    readonly history: readonly SkillActivationHistoryEntry[];
  } {
    const scopeKey = input.actor.workspaceId;
    return {
      versions: this.#skills.listVersions({ scopeKey, skillId: input.skillId }),
      activation: this.#skills.getActivation(scopeKey, input.skillId),
      history: this.#skills.listActivationHistory(scopeKey, input.skillId),
    };
  }

  listActive(input: Parameters<SkillServicePort["listActive"]>[0]): readonly ActiveSkill[] {
    const scopeKey = input.actor.workspaceId;
    const activations = this.#skills.listActivations(scopeKey);
    return activations.map((activation) => {
      const version = this.#skills.getVersion(scopeKey, activation.skillId, activation.activeVersion);
      if (version === undefined) {
        // Already unreachable in normal operation: `tavi_skill_activations`
        // has a real foreign key into `tavi_skill_versions`, and
        // `setActivation`/`activate`/`rollback` only ever point the pointer
        // at a version `#requireVersion` already confirmed exists. This
        // branch is a defensive fallback, pinned by a test that disables
        // foreign-key enforcement to simulate that guarantee being bypassed.
        throw new TaviError("INTERNAL", `Active skill version ${activation.skillId}@${activation.activeVersion} is missing from storage`);
      }
      return { skillId: activation.skillId, version: activation.activeVersion, manifest: version.manifest };
    });
  }

  #validateIdentity(skillId: string, version: string): void {
    if (skillId.trim().length === 0 || skillId.length > MAX_SKILL_ID_CHARS) {
      throw new TaviError("INVALID_INPUT", `skillId must be 1-${MAX_SKILL_ID_CHARS} characters`);
    }
    if (version.trim().length === 0 || version.length > MAX_SKILL_VERSION_CHARS) {
      throw new TaviError("INVALID_INPUT", `version must be 1-${MAX_SKILL_VERSION_CHARS} characters`);
    }
  }

  #validateManifest(manifest: SkillManifest): SkillManifest {
    const bytes = Buffer.byteLength(JSON.stringify(manifest), "utf8");
    if (bytes > MAX_SKILL_MANIFEST_BYTES) {
      throw new TaviError("INVALID_INPUT", `Skill manifest exceeds ${MAX_SKILL_MANIFEST_BYTES} bytes`);
    }
    const parsed = SkillManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      throw new TaviError("INVALID_INPUT", "Invalid skill manifest", {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }
    return parsed.data;
  }

  /** The scope's own version: another workspace's `(skillId, version)` is not found here. */
  #requireVersion(scopeKey: string, skillId: string, version: string): SkillVersion {
    const found = this.#skills.getVersion(scopeKey, skillId, version);
    if (found === undefined) {
      throw new TaviError("NOT_FOUND", `Skill ${skillId}@${version} does not exist`);
    }
    return found;
  }
}
