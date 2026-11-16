import { WorkerPayloads, type PayloadOperations } from "./payloads.js";
import { createRoutineDispatcher } from "./routine-handlers.js";
import { dispatchStore } from "./store-handlers.js";
import { createSnapshot, exportTables, restoreSnapshot, readRecordedOwner } from "./administration.js";
import type { AdministrationOperations } from "./administration-client.js";
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { TaviError } from "@tavi/contracts";
import { SqliteStore } from "./store.js";
import { wireError } from "./protocol.js";
import { serveWorker } from "./worker-server.js";
import { dispatchRepository } from "./repository-handlers.js";
import { workerClock } from "./worker-clock.js";
import { WorkerCheckpoints } from "./checkpoints.js";
import type { DatabaseOperations } from "./protocol.js";
import { createServiceHandlers, dispatchService, hasServiceOptions } from "./service-handlers.js";
import { dispatchPluginRegistry } from "./plugin-registry-handlers.js";

const optionsSchema = z.strictObject({
  databasePath: z.string(),
  artifactsDirectory: z.string().optional(),
  inMemory: z.boolean().optional(),
  checkpointMode: z.literal("inspect").optional(),
});

if (parentPort === null) throw new Error("The database entry must run in a worker");
let closeResources: (() => void) | undefined;
try {
  if (workerData?.mode === "administration") {
    z.strictObject({ mode: z.literal("administration") }).parse(workerData);
    serveWorker(
      parentPort,
      (operation, input) => {
        switch (operation) {
          case "readRecordedOwner":
            return readRecordedOwner(z.string().parse(input));
          case "createSnapshot":
            return createSnapshot(input as AdministrationOperations["createSnapshot"]["input"]);
          case "exportTables":
            return exportTables(input as AdministrationOperations["exportTables"]["input"]);
          case "restoreSnapshot":
            return restoreSnapshot(input as AdministrationOperations["restoreSnapshot"]["input"]);
          default:
            throw new TaviError("INVALID_INPUT", "Unknown administration operation");
        }
      },
      () => {},
    );
  } else {
    const options = optionsSchema.parse(workerData);
    const store = new SqliteStore({
      databasePath: options.databasePath,
      ...(options.artifactsDirectory === undefined ? {} : { artifactsDirectory: options.artifactsDirectory }),
      ...(options.inMemory === undefined ? {} : { inMemory: options.inMemory }),
    });
    closeResources = () => store.close();
    const repositories = store.asPort().repositories;
    const checkpoints = new WorkerCheckpoints(store, options.checkpointMode);
    closeResources = () => {
      checkpoints.close();
      store.close();
    };
    const services = createServiceHandlers(store);
    const dispatchRoutine = createRoutineDispatcher(store);
    const payloads = new WorkerPayloads();
    closeResources = () => {
      payloads.close();
      checkpoints.close();
      store.close();
    };
    const dispatch = (operation: string, input: unknown): unknown => {
      switch (operation) {
        case "payload.begin":
          return payloads.begin((input as PayloadOperations["payload.begin"]["input"]).size);
        case "payload.append":
          return payloads.append(input as PayloadOperations["payload.append"]["input"]);
        case "payload.execute": {
          const value = input as PayloadOperations["payload.execute"]["input"];
          return payloads.invoke(value.operation, value.id, dispatch);
        }
        case "payload.inline": {
          const value = input as PayloadOperations["payload.inline"]["input"];
          return payloads.execute(value.operation, value.input, dispatch);
        }
        case "payload.read": {
          const value = input as PayloadOperations["payload.read"]["input"];
          return payloads.read(value.id, value.offset);
        }
        case "payload.close":
          return payloads.remove(z.string().parse(input));
      }
      if (operation.startsWith("routine.")) return dispatchRoutine(operation, input);
      // Neither runs inside a transaction: `VACUUM` cannot.
      if (operation === "store.integrityCheck" || operation === "store.reclaimSpace") return dispatchStore(store, operation, input);
      if (operation.startsWith("checkpoint.") && options.checkpointMode === "inspect")
        throw new TaviError("UNAVAILABLE", "Checkpoint operations are disabled during schema inspection");
      if (operation.startsWith("store.")) return store.transactionImmediate(() => dispatchStore(store, operation, input));
      if (operation.startsWith("repository.")) return store.transactionImmediate(() => dispatchRepository(repositories, operation, input));
      if (operation.startsWith("service.")) {
        const request = input as { args: unknown; options: import("@tavi/contracts").PersistenceServiceOptions };
        // Options carry per-request ids, `now`, quotas and policy that the services capture when
        // built, so only a request without any shares the worker's handlers.
        const configured =
          Array.isArray(input) || !hasServiceOptions(request.options) ? services : createServiceHandlers(store, request.options);
        return store.transactionImmediate(() => dispatchService(configured, operation, Array.isArray(input) ? input : request.args));
      }
      if (operation.startsWith("pluginRegistry."))
        return store.transactionImmediate(() => dispatchPluginRegistry(store.asPort(), operation, input));
      switch (operation) {
        case "checkpoint.get":
          return checkpoints.get(input as DatabaseOperations["checkpoint.get"]["input"]);
        case "checkpoint.put":
          return checkpoints.put(input as DatabaseOperations["checkpoint.put"]["input"]);
        case "checkpoint.putWrites":
          return checkpoints.putWrites(input as DatabaseOperations["checkpoint.putWrites"]["input"]);
        case "checkpoint.deleteThread":
          return checkpoints.deleteThread(z.string().parse(input));
        case "checkpoint.pruneThread":
          return checkpoints.pruneThread(z.strictObject({ threadId: z.string(), keep: z.number().int().positive() }).parse(input));
        case "checkpoint.latest":
          return checkpoints.latest(z.string().parse(input));
        case "checkpoint.openCursor":
          return checkpoints.openCursor(input as DatabaseOperations["checkpoint.openCursor"]["input"]);
        case "checkpoint.nextCursor":
          return checkpoints.nextCursor(z.string().parse(input));
        case "checkpoint.closeCursor":
          return checkpoints.closeCursor(z.string().parse(input));
        case "info":
          return { databasePath: store.databasePath, tables: store.listTables() };
        case "meta.get":
          return store.getMeta(z.strictObject({ key: z.string() }).parse(input).key);
        case "meta.set": {
          const value = z.strictObject({ key: z.string(), value: z.string(), now: z.string() }).parse(input);
          return store.transactionImmediate(() => store.setMeta(value.key, value.value, value.now));
        }
        case "tasks.get":
          return store.getTask(z.strictObject({ taskId: z.string() }).parse(input).taskId);
        case "tasks.cancel": {
          const value = z
            .strictObject({
              taskId: z.string().trim().min(1),
              reason: z.string().trim().min(1),
              operator: z.string(),
              now: z.union([z.strictObject({ fixed: z.string() }), z.strictObject({ execution: z.literal(true) })]),
            })
            .parse(input);
          const now = workerClock(value.now);
          return store.transactionImmediate(() => {
            const record = repositories.cancellations.request({
              taskId: value.taskId,
              reason: value.reason,
              requestedBy: value.operator,
              now,
            });
            const cancelledApprovals = repositories.approvals.cancelPendingForTask(value.taskId, now);
            repositories.tasks.updateStatus(value.taskId, "cancelled", null);
            return { record, cancelledApprovals };
          });
        }
        default:
          throw new TaviError("INVALID_INPUT", "Unknown database operation");
      }
    };
    // Forgotten memory stays forgotten: a record the deletion journal names that a restored backup
    // brought back, or a crash left, is forgotten again before anything is served, so before the first turn.
    if (options.checkpointMode !== "inspect") {
      const reconciled = store.reconcileMemoryDeletions();
      if (reconciled.forgotten > 0)
        process.stderr.write(
          `Memory: forgot ${reconciled.forgotten} record(s) again that the deletion journal names (reconciled after restore)\n`,
        );
      if (reconciled.failed > 0)
        process.stderr.write(
          `Memory: ${reconciled.failed} record(s) the deletion journal names could not be forgotten again; the next start tries again\n`,
        );
    }
    serveWorker(
      parentPort,
      dispatch,
      () => {
        payloads.close();
        checkpoints.close();
        store.close();
      },
      (operation) => {
        if (/artifact|publication|restore|Snapshot/i.test(operation)) return "unknown";
        return /^(repository\.|service\.|store\.|checkpoint\.(put|putWrites|deleteThread|pruneThread)$|tasks\.cancel$|meta\.set$)/.test(
          operation,
        )
          ? "rolled-back"
          : "unknown";
      },
      // Every write on the worker's one connection, the checkpoint saver's tables included (a turn's steps signal too).
      (() => {
        const total = store.handle.prepare("SELECT total_changes() AS n");
        return () => (total.get() as { n: number }).n;
      })(),
    );
  }
} catch (error) {
  try {
    closeResources?.();
  } finally {
    parentPort.postMessage({ type: "startup-error", error: wireError(error, "not-dispatched") });
    parentPort.close();
  }
}
