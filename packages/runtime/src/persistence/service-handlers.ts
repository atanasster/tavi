import { nowTimestamp } from "@tavi/contracts/util";
import { ModelAccounting } from "./model-accounting.js";
import { RouterRepository } from "../router/repository.js";
import type { SqliteStore } from "./store.js";
import { TaviError } from "@tavi/contracts";
import type { PersistencePort } from "./internal-contracts.js";
import { SERVICE_METHODS } from "./service-protocol.js";
import { rpcHandlers } from "./rpc.js";
import type { PersistenceServicesPort } from "@tavi/contracts";
import { MemoryService } from "../memory/service.js";
import { SkillService } from "../skills/service.js";
import { ModelConfigService } from "../models/config.js";
import { SkillRolloutService } from "../skills/rollout.js";
export function createServiceHandlers(store: SqliteStore, configuration: import("@tavi/contracts").PersistenceServiceOptions = {}) {
  const persistence: PersistencePort = store.asPort();
  const offsets = new Map<string, number>();
  const options = {
    ...(configuration.now === undefined ? {} : { now: () => configuration.now ?? nowTimestamp() }),
    ...(configuration.ids === undefined
      ? {}
      : {
          newId: (prefix: string) => {
            const offset = offsets.get(prefix) ?? 0;
            offsets.set(prefix, offset + 1);
            const id = configuration.ids?.[prefix]?.[offset];
            if (id === undefined) throw new TaviError("BUDGET_EXCEEDED", "Operation exceeded its supplied identifier allocation");
            return id;
          },
        }),
    ...(configuration.quotas === undefined ? {} : { quotas: configuration.quotas }),
    ...(configuration.sharedRead === undefined
      ? {}
      : {
          policy: {
            resolveWorkspace: () => undefined,
            authorize: () => "Service policy only supports memory read grants",
            missingPermissions: (context: import("@tavi/contracts").InvocationContext, required: readonly string[]) =>
              configuration.sharedRead?.allowed === true &&
              context.workspaceId === configuration.sharedRead.workspaceId &&
              context.principalId === configuration.sharedRead.principalId
                ? []
                : required,
          },
        }),
  };
  const accounting = new ModelAccounting(store.handle);
  const router = new RouterRepository(store, () => true);
  const memory = new MemoryService(persistence, options);
  const skills = new SkillService(persistence, options);
  const modelConfig = new ModelConfigService(persistence.repositories.modelConfig, options);
  const skillRollout = new SkillRolloutService(persistence, skills, options);
  return { accounting, router, memory, skills, modelConfig, skillRollout };
}
/** Whether a request's options configure its services; one without may share the worker's handlers. */
export function hasServiceOptions(options: import("@tavi/contracts").PersistenceServiceOptions | undefined): boolean {
  return options !== undefined && Object.values(options).some((value) => value !== undefined);
}
/** Serves a persistence service operation against the worker's services, inside the caller's transaction. */
export const dispatchService = rpcHandlers<"service", PersistenceServicesPort, ReturnType<typeof createServiceHandlers>>(
  "service",
  SERVICE_METHODS,
  {},
  { tuple: "Service arguments must be a tuple", unknown: "Unknown persistence service operation" },
);
