import { TaviError } from "@tavi/contracts";
import type { SqliteStore } from "./store.js";
import type { StoreOperations } from "./store-protocol.js";
export function dispatchStore(store: SqliteStore, operation: string, input: unknown): unknown {
  if (!Array.isArray(input)) throw new TaviError("INVALID_INPUT", "Store arguments must be a tuple");
  switch (operation) {
    case "store.countCheckpoints":
      return store.countCheckpoints(...(input as StoreOperations[typeof operation]["input"]));
    case "store.nextWakeups":
      return store.nextWakeups(...(input as StoreOperations[typeof operation]["input"]));
    case "store.routineSchedule":
      return store.routineSchedule(...(input as StoreOperations[typeof operation]["input"]));
    case "store.importProjects":
      return store.importProjects(...(input as StoreOperations[typeof operation]["input"]));

    case "store.getArtifact":
      return store.getArtifact(...(input as StoreOperations[typeof operation]["input"]));
    case "store.readArtifactBody":
      return store.readArtifactBody(...(input as StoreOperations[typeof operation]["input"]));
    case "store.pruneArtifacts":
      return store.pruneArtifacts(...(input as StoreOperations[typeof operation]["input"]));
    case "store.eraseArtifacts":
      return store.eraseArtifacts(...(input as StoreOperations[typeof operation]["input"]));
    case "store.pruneVideo":
      return store.pruneVideo(...(input as StoreOperations[typeof operation]["input"]));
    case "store.listPendingReview":
      return store.listPendingReview(...(input as StoreOperations[typeof operation]["input"]));
    case "store.setReviewState":
      return store.setReviewState(...(input as StoreOperations[typeof operation]["input"]));
    case "store.resolveArtifactPath":
      return store.resolveArtifactPath(...(input as StoreOperations[typeof operation]["input"]));
    case "store.listTables":
      return store.listTables(...(input as StoreOperations[typeof operation]["input"]));
    case "store.listApplicationTables":
      return store.listApplicationTables(...(input as StoreOperations[typeof operation]["input"]));
    case "store.getMeta":
      return store.getMeta(...(input as StoreOperations[typeof operation]["input"]));
    case "store.setMeta":
      return store.setMeta(...(input as StoreOperations[typeof operation]["input"]));
    case "store.integrityCheck":
      return store.integrityCheck(...(input as StoreOperations[typeof operation]["input"]));
    case "store.reclaimSpace":
      return store.reclaimSpace(...(input as StoreOperations[typeof operation]["input"]));
    case "store.optimize":
      return store.optimize(...(input as StoreOperations[typeof operation]["input"]));
    case "store.migrationStatus":
      return store.migrationStatus(...(input as StoreOperations[typeof operation]["input"]));
    case "store.transportRowCounts":
      return store.transportRowCounts(...(input as StoreOperations[typeof operation]["input"]));
    case "store.chatMeasurement":
      return store.chatMeasurement(...(input as StoreOperations[typeof operation]["input"]));
    case "store.memoryCallSpend":
      return store.memoryCallSpend(...(input as StoreOperations[typeof operation]["input"]));
    case "store.memoryEmbeddingSpend":
      return store.memoryEmbeddingSpend(...(input as StoreOperations[typeof operation]["input"]));
    case "store.pruneTransport":
      return store.pruneTransport(...(input as StoreOperations[typeof operation]["input"]));
    case "store.tableColumns":
      return store.tableColumns(...(input as StoreOperations[typeof operation]["input"]));
    case "store.listMeta":
      return store.listMeta(...(input as StoreOperations[typeof operation]["input"]));
    case "store.listSaverTables":
      return store.listSaverTables(...(input as StoreOperations[typeof operation]["input"]));
    case "store.listArtifacts":
      return store.listArtifacts(...(input as StoreOperations[typeof operation]["input"]));
    case "store.listTaskSessions":
      return store.listTaskSessions(...(input as StoreOperations[typeof operation]["input"]));
    case "store.taskPrompts":
      return store.taskPrompts(...(input as StoreOperations[typeof operation]["input"]));
    case "store.taskNeeds":
      return store.taskNeeds(...(input as StoreOperations[typeof operation]["input"]));
    case "store.listTasks":
      return store.listTasks(...(input as StoreOperations[typeof operation]["input"]));
    case "store.getTask":
      return store.getTask(...(input as StoreOperations[typeof operation]["input"]));
    case "store.updateTaskStatus":
      return store.updateTaskStatus(...(input as StoreOperations[typeof operation]["input"]));
    case "store.commitAdmission":
      return store.commitAdmission(...(input as StoreOperations[typeof operation]["input"]));
    case "store.listAdmissions":
      return store.listAdmissions(...(input as StoreOperations[typeof operation]["input"]));
    case "store.listClaimedAdmissions":
      return store.listClaimedAdmissions(...(input as StoreOperations[typeof operation]["input"]));
    case "store.latestSettledAdmission":
      return store.latestSettledAdmission(...(input as StoreOperations[typeof operation]["input"]));
    case "store.searchTaskHistory":
      return store.searchTaskHistory(...(input as StoreOperations[typeof operation]["input"]));
    case "store.getAdmission":
      return store.getAdmission(...(input as StoreOperations[typeof operation]["input"]));
    default:
      throw new TaviError("INVALID_INPUT", "Unknown store operation");
  }
}
