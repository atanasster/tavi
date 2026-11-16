import type { SqliteStore } from "./store.js";
export type StoreOperations = {
  "store.importProjects": { input: Parameters<SqliteStore["importProjects"]>; output: ReturnType<SqliteStore["importProjects"]> };
  "store.nextWakeups": { input: Parameters<SqliteStore["nextWakeups"]>; output: ReturnType<SqliteStore["nextWakeups"]> };
  "store.routineSchedule": { input: Parameters<SqliteStore["routineSchedule"]>; output: ReturnType<SqliteStore["routineSchedule"]> };
  "store.countCheckpoints": { input: Parameters<SqliteStore["countCheckpoints"]>; output: ReturnType<SqliteStore["countCheckpoints"]> };
  "store.getArtifact": { input: Parameters<SqliteStore["getArtifact"]>; output: ReturnType<SqliteStore["getArtifact"]> };
  "store.readArtifactBody": { input: Parameters<SqliteStore["readArtifactBody"]>; output: ReturnType<SqliteStore["readArtifactBody"]> };
  "store.pruneArtifacts": { input: Parameters<SqliteStore["pruneArtifacts"]>; output: ReturnType<SqliteStore["pruneArtifacts"]> };
  "store.eraseArtifacts": { input: Parameters<SqliteStore["eraseArtifacts"]>; output: ReturnType<SqliteStore["eraseArtifacts"]> };
  "store.pruneVideo": { input: Parameters<SqliteStore["pruneVideo"]>; output: ReturnType<SqliteStore["pruneVideo"]> };
  "store.listPendingReview": { input: Parameters<SqliteStore["listPendingReview"]>; output: ReturnType<SqliteStore["listPendingReview"]> };
  "store.setReviewState": { input: Parameters<SqliteStore["setReviewState"]>; output: ReturnType<SqliteStore["setReviewState"]> };
  "store.resolveArtifactPath": {
    input: Parameters<SqliteStore["resolveArtifactPath"]>;
    output: ReturnType<SqliteStore["resolveArtifactPath"]>;
  };
  "store.listTables": { input: Parameters<SqliteStore["listTables"]>; output: ReturnType<SqliteStore["listTables"]> };
  "store.listApplicationTables": {
    input: Parameters<SqliteStore["listApplicationTables"]>;
    output: ReturnType<SqliteStore["listApplicationTables"]>;
  };
  "store.getMeta": { input: Parameters<SqliteStore["getMeta"]>; output: ReturnType<SqliteStore["getMeta"]> };
  "store.setMeta": { input: Parameters<SqliteStore["setMeta"]>; output: ReturnType<SqliteStore["setMeta"]> };
  "store.integrityCheck": { input: Parameters<SqliteStore["integrityCheck"]>; output: ReturnType<SqliteStore["integrityCheck"]> };
  "store.reclaimSpace": { input: Parameters<SqliteStore["reclaimSpace"]>; output: ReturnType<SqliteStore["reclaimSpace"]> };
  "store.optimize": { input: Parameters<SqliteStore["optimize"]>; output: ReturnType<SqliteStore["optimize"]> };
  "store.migrationStatus": { input: Parameters<SqliteStore["migrationStatus"]>; output: ReturnType<SqliteStore["migrationStatus"]> };
  "store.transportRowCounts": {
    input: Parameters<SqliteStore["transportRowCounts"]>;
    output: ReturnType<SqliteStore["transportRowCounts"]>;
  };
  "store.chatMeasurement": { input: Parameters<SqliteStore["chatMeasurement"]>; output: ReturnType<SqliteStore["chatMeasurement"]> };
  "store.memoryCallSpend": { input: Parameters<SqliteStore["memoryCallSpend"]>; output: ReturnType<SqliteStore["memoryCallSpend"]> };
  "store.memoryEmbeddingSpend": {
    input: Parameters<SqliteStore["memoryEmbeddingSpend"]>;
    output: ReturnType<SqliteStore["memoryEmbeddingSpend"]>;
  };
  "store.pruneTransport": { input: Parameters<SqliteStore["pruneTransport"]>; output: ReturnType<SqliteStore["pruneTransport"]> };
  "store.tableColumns": { input: Parameters<SqliteStore["tableColumns"]>; output: ReturnType<SqliteStore["tableColumns"]> };
  "store.listMeta": { input: Parameters<SqliteStore["listMeta"]>; output: ReturnType<SqliteStore["listMeta"]> };
  "store.listSaverTables": { input: Parameters<SqliteStore["listSaverTables"]>; output: ReturnType<SqliteStore["listSaverTables"]> };
  "store.listArtifacts": { input: Parameters<SqliteStore["listArtifacts"]>; output: ReturnType<SqliteStore["listArtifacts"]> };
  "store.listTaskSessions": { input: Parameters<SqliteStore["listTaskSessions"]>; output: ReturnType<SqliteStore["listTaskSessions"]> };
  "store.taskPrompts": { input: Parameters<SqliteStore["taskPrompts"]>; output: ReturnType<SqliteStore["taskPrompts"]> };
  "store.taskNeeds": { input: Parameters<SqliteStore["taskNeeds"]>; output: ReturnType<SqliteStore["taskNeeds"]> };
  "store.listTasks": { input: Parameters<SqliteStore["listTasks"]>; output: ReturnType<SqliteStore["listTasks"]> };
  "store.getTask": { input: Parameters<SqliteStore["getTask"]>; output: ReturnType<SqliteStore["getTask"]> };
  "store.updateTaskStatus": { input: Parameters<SqliteStore["updateTaskStatus"]>; output: ReturnType<SqliteStore["updateTaskStatus"]> };
  "store.commitAdmission": { input: Parameters<SqliteStore["commitAdmission"]>; output: ReturnType<SqliteStore["commitAdmission"]> };
  "store.listAdmissions": { input: Parameters<SqliteStore["listAdmissions"]>; output: ReturnType<SqliteStore["listAdmissions"]> };
  "store.listClaimedAdmissions": {
    input: Parameters<SqliteStore["listClaimedAdmissions"]>;
    output: ReturnType<SqliteStore["listClaimedAdmissions"]>;
  };
  "store.latestSettledAdmission": {
    input: Parameters<SqliteStore["latestSettledAdmission"]>;
    output: ReturnType<SqliteStore["latestSettledAdmission"]>;
  };
  "store.searchTaskHistory": { input: Parameters<SqliteStore["searchTaskHistory"]>; output: ReturnType<SqliteStore["searchTaskHistory"]> };
  "store.getAdmission": { input: Parameters<SqliteStore["getAdmission"]>; output: ReturnType<SqliteStore["getAdmission"]> };
};
