import { RoutineEvaluationStore } from "./routine-evaluation-store.js";
import { statfsSync } from "node:fs";
import { routineTriggerNext, TaviError } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { AccessPolicy } from "../access/policy.js";
import { RoutineService } from "../routines/service.js";
import { RoutineExecutionService } from "../routines/runs.js";
import { RoutineNewsService } from "../routines/news.js";
import { RoutinePublicationService } from "../routines/publication.js";
import { RoutineDeliveryService } from "../routines/delivery.js";
import { RoutineArtifactCache, RoutineControlService } from "../routines/control.js";
import { routineSkillContext } from "../routines/skills.js";
import { ROUTINE_METHODS, type RoutineOperations, type RoutinePort, type RoutineWorkerServices } from "./routine-protocol.js";
import { rpcHandlers } from "./rpc.js";
import type { RoutineWorkerConfiguration } from "./routine-configuration.js";
import type { SqliteStore } from "./store.js";

/** Serves a table operation against the worker's routine services, with its argument tuple. */
const dispatchRoutine = rpcHandlers<"routine", RoutinePort, RoutineWorkerServices>(
  "routine",
  ROUTINE_METHODS,
  {},
  { tuple: "Routine arguments must be a tuple", unknown: "Unknown routine operation" },
);

export function createRoutineDispatcher(store: SqliteStore): (operation: string, input: unknown) => unknown {
  let configuration: RoutineWorkerConfiguration = {
    ownerEpoch: "offline",
    workspaces: [],
    toolPermissions: {},
    destinations: [],
    providerConnectionIds: [],
    modelOverride: false,
    executionAvailable: true,
    deliveryAuthorizationAvailable: false,
    allowedHosts: [],
  };
  // Each request builds its own control service; a chunked report download's bytes outlive them.
  const artifactCache = new RoutineArtifactCache();
  return (operation, input) => {
    if (operation === "routine.configure") {
      configuration = input as RoutineWorkerConfiguration;
      new AccessPolicy(configuration.workspaces);
      return;
    }
    if (configuration === undefined) throw new TaviError("UNAVAILABLE", "Routine worker policy has not been configured");
    const controlInput = operation === "routine.control" ? (input as RoutineOperations["routine.control"]["input"]).control : undefined;
    const toolPermissions = (input as { toolPermissions?: RoutineWorkerConfiguration["toolPermissions"] }).toolPermissions;
    const config = { ...configuration, ...controlInput, ...(toolPermissions === undefined ? {} : { toolPermissions }) };
    const envelope = input as { now?: string; ownerEpoch?: string; news?: import("../routines/news.js").RoutineNewsOptions };
    if (envelope.ownerEpoch !== undefined && envelope.ownerEpoch !== config.ownerEpoch)
      throw new TaviError("UNAVAILABLE", "Routine owner session no longer matches the database worker");
    const now = () => envelope.now ?? nowTimestamp();
    const access = new AccessPolicy(config.workspaces);
    for (const [workspaceId, people] of Object.entries(config.people ?? {})) access.setPeople(workspaceId, people);
    const routines = new RoutineService(store, {
      ...(config.toolBindings === undefined ? {} : { toolBindings: config.toolBindings }),
      ...(config.modelBindings === undefined ? {} : { modelBindings: config.modelBindings }),
      now,
      executionAvailable: config.executionAvailable,
      nextOccurrence: routineTriggerNext,
      ...(config.deliveryAuthorizationAvailable === false
        ? {}
        : {
            authorizeTarget: (scope, target) =>
              access.actsIn(scope.workspaceId, scope.principalId) &&
              target.authorizationRef === "operator-destination-allowlist" &&
              config.destinations.some(
                (item) =>
                  item.workspaceId === scope.workspaceId &&
                  item.connectionId === target.connectionId &&
                  item.chatId === String(target.chatId),
              ),
          }),
    });
    const runs: RoutineExecutionService = new RoutineExecutionService(routines, {
      ownerEpoch: config.ownerEpoch,
      now,
      pluginReads: () => config.pluginReads ?? [],
      authorized: (run, step) =>
        access.actsIn(run.workspaceId, run.principalId) &&
        routines.get({ workspaceId: run.workspaceId, principalId: run.principalId }, run.routineId).routine.status !== "archived" &&
        (step !== "research" ||
          run.snapshot.permissions.researchTools.every((id) => {
            const required = config.toolPermissions[id];
            return (
              required !== undefined &&
              access.authorize(
                { workspaceId: run.workspaceId, principalId: run.principalId, runId: run.taskId ?? run.runId, caller: "routine" },
                required,
              ) === undefined
            );
          })),
      researchReady: (run) => {
        const roles = [run.snapshot.models.research, run.snapshot.models.synthesis];
        if (roles.some((policy) => [policy.primary, ...policy.fallbacks].every((target) => runs.knownRetired(run.routineId, target))))
          return { ready: false, code: "model-retired", retryable: false };
        // The same pieces the evaluator's setup check requires: a reachable model
        // per role, and every research tool the routine names registered here.
        const models =
          config.modelOverride ||
          roles.every((policy) =>
            [policy.primary, ...policy.fallbacks].some((target) => config.providerConnectionIds.includes(target.connectionId)),
          );
        const tools = run.snapshot.permissions.researchTools.every((id) => config.toolPermissions[id] !== undefined);
        return config.executionAvailable && models && tools ? { ready: true } : { ready: false, code: "setup-needed", retryable: false };
      },
      freeBytes: () => {
        if (config.dataDirectory === undefined) return undefined;
        try {
          const disk = statfsSync(config.dataDirectory);
          return disk.bavail * disk.bsize;
        } catch {
          return undefined;
        }
      },
      cancelTask: (taskId) => {
        const children = store.handle
          .prepare("SELECT worker_task_id FROM tavi_agent_delegation_admissions WHERE root_task_id=?")
          .all(taskId) as { worker_task_id: string }[];
        const repositories = store.asPort().repositories;
        for (const id of [taskId, ...children.map((row) => row.worker_task_id)]) {
          repositories.cancellations.request({ taskId: id, reason: "Routine cancelled", requestedBy: "routine-owner", now });
          repositories.approvals.cancelPendingForTask(id, now);
          repositories.tasks.updateStatus(id, "cancelled", null);
        }
      },
      onLedgerGap: (event) => process.stderr.write(`Routine ${event.runId}: could not record ${event.code}: ${String(event.error)}\n`),
    });
    const news = new RoutineNewsService(runs, envelope.news);
    const publication = new RoutinePublicationService(runs, { now });
    const delivery = new RoutineDeliveryService(runs, {
      now,
      messaging: {
        buildDestination: () => undefined,
        send: async () => {
          throw new TaviError("INTERNAL", "Messaging cannot run in the database worker");
        },
      },
    });
    const renderer = config.renderer;
    const control = new RoutineControlService(
      {
        routines,
        runs,
        news,
        publication,
        delivery,
        defaultModels: () => config.defaultModels,
        allowedHosts: config.allowedHosts,
        wake: () => {},
        now,
        ...(renderer === undefined ? {} : { renderer: () => renderer }),
        ...(controlInput?.language === undefined ? {} : { language: controlInput.language }),
      },
      artifactCache,
    );
    switch (operation) {
      case "routine.control":
        return control.execute((input as RoutineOperations["routine.control"]["input"]).payload);
      case "routine.skillContext": {
        const value = input as RoutineOperations["routine.skillContext"]["input"];
        return routineSkillContext(store, value.scope, value.pins);
      }
      case "routine.publication.publish": {
        const value = input as RoutineOperations["routine.publication.publish"]["input"];
        return publication.publish(value.args[0], value.args[1], value.args[2], delivery, value.args[3]);
      }
      default:
        return dispatchRoutine(
          { quality: new RoutineEvaluationStore(routines), routines, runs, news, publication, delivery },
          operation,
          (input as { readonly args?: unknown }).args,
        );
    }
  };
}
