import type { CancellationRecord } from "./ports/approvals.js";
import type { PersistenceRepositories } from "./ports/persistence.js";
import type { AdmitRequest, AdmitResult } from "./ports/tasks.js";
import type { CheckpointStoragePort } from "./checkpoint-storage.js";
import type { PersistenceServicesPort } from "./persistence-services.js";

import type { AsyncRepository, DatabaseTime } from "./persistence-types.js";
export type { AsyncRepository, DatabaseTime, PersistenceData } from "./persistence-types.js";

/** Static adapter prompt policy. The worker reads workspace settings inside admission. */
export interface PromptSelectionPolicy {
  readonly explicitPrompt?: string;
  readonly builtin: { readonly text: string; readonly version: string };
}

export type SerializableAdmitRequest = AdmitRequest;

export type AsyncPersistenceRepositories = {
  readonly [K in keyof PersistenceRepositories]: K extends "tasks"
    ? Omit<AsyncRepository<PersistenceRepositories[K]>, "admit"> & {
        admit(request: SerializableAdmitRequest): Promise<AdmitResult>;
      }
    : AsyncRepository<PersistenceRepositories[K]>;
};

export interface AsyncPersistencePort {
  readonly databasePath: string;
  readonly repositories: AsyncPersistenceRepositories;
  readonly checkpoints: CheckpointStoragePort;
  readonly services: PersistenceServicesPort;
  servicesWith(
    options: (args: readonly unknown[], operation: string) => import("./persistence-services.js").PersistenceServiceOptions,
  ): PersistenceServicesPort;
  cancelTask(input: { readonly taskId: string; readonly reason: string; readonly operator: string; readonly now: DatabaseTime }): Promise<{
    readonly record: CancellationRecord;
    readonly cancelledApprovals: number;
  }>;
}
