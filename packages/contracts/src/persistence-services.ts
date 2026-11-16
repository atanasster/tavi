import type { ModelAccountingPort } from "./model-accounting.js";
import type { RouterRepositoryPort } from "./router.js";
import type { MemoryServicePort } from "./ports/memory-service.js";
import type { ModelConfigPort } from "./ports/model.js";
import type { SkillActor, SkillServicePort } from "./ports/skills.js";

/** A skill version's bounded rollout: pins a version to an explicit task set. */
export interface SkillRolloutServicePort {
  pinRollout(input: {
    readonly actor: SkillActor;
    readonly skillId: string;
    readonly taskIds: readonly string[];
    readonly version?: string;
  }): Promise<void>;
  clearRollout(input: { readonly actor: SkillActor; readonly skillId: string }): Promise<void>;
  getRolloutStatus(input: {
    readonly actor: SkillActor;
    readonly skillId: string;
  }): Promise<{ readonly version: string; readonly pinned: boolean; readonly authorizedTaskIds: readonly string[] }>;
  listRolloutPins(input: {
    readonly actor: SkillActor;
    readonly skillId: string;
  }): Promise<readonly { readonly version: string; readonly taskCount: number; readonly active: boolean }[]>;
  clearRolloutVersion(input: { readonly actor: SkillActor; readonly skillId: string; readonly version: string }): Promise<void>;
}
export interface PersistenceServicesPort {
  readonly accounting: ModelAccountingPort;
  readonly router: RouterRepositoryPort;
  readonly memory: MemoryServicePort;
  readonly skills: SkillServicePort;
  readonly modelConfig: ModelConfigPort;
  readonly skillRollout: SkillRolloutServicePort;
}

/** Captured per-operation configuration; callbacks never cross the worker boundary. */
export interface PersistenceServiceOptions {
  readonly now?: string;
  readonly ids?: Readonly<Record<string, readonly string[]>>;
  readonly quotas?: { readonly maxRecords: number; readonly maxBytes: number };
  readonly sharedRead?: { readonly workspaceId: string; readonly principalId: string; readonly allowed: boolean };
}
