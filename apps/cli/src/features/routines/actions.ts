import { TaviError, routineTriggerSpec, type RoutineEditResult, type RoutinesPayload } from "@tavi/contracts";
import type { LabelSummary, ScheduleRecord, SchedulesPayload, TaskRecord } from "@tavi/contracts";
import { type RoutineService, type RoutineControlService, changedSections, routineHash } from "@tavi/runtime";
import { composeSpec } from "../schedules/actions.js";

/**
 * Shared owner action surface; CLI and model tools use the same checked service.
 *
 * Every action goes through `RoutineControlService.execute`, which is what
 * production passes (`serve.ts`). A bare `RoutineService` used to be accepted here
 * as a second, embedder-facing router, but it had already drifted for the same
 * action names — its `list` omitted `lastRun` and its `update` returned a bare
 * revision instead of the `changes`/`previousRevision`/`deliveryReadiness`
 * result — so the port answered two shapes for one action. The offline schedule
 * surface (`features/schedules/client.ts`) drives `RoutineService` through `routineScheduleAction`,
 * which is a different, narrower contract by design (C9/C10).
 */
export async function routineAction(service: RoutineControlService, raw: RoutinesPayload): Promise<unknown> {
  return await service.execute(raw);
}

/**
 * A `create` repeated from a chat (`fromTaskId`): the chat, the caller's own,
 * gives the routine the context label it read, as the model's `routines.create`
 * from that chat would carry (`modelLabel`) — read here, never one the caller
 * sent. Any other payload is unchanged.
 */
export async function routineFromChat<Task extends Pick<TaskRecord, "workspaceId" | "principalId">>(
  payload: RoutinesPayload,
  chat: {
    readonly task: (taskId: string) => Promise<Task | undefined>;
    readonly label: (task: Task) => Promise<LabelSummary | null>;
  },
): Promise<RoutinesPayload> {
  const { fromTaskId: taskId, ...rest } = payload;
  if (payload.action !== "create" || taskId === undefined) return payload;
  if (payload.copyOf !== undefined) throw new TaviError("INVALID_INPUT", "A routine is copied or repeated from a chat, not both");
  const task = await chat.task(taskId);
  if (task === undefined || task.workspaceId !== payload.workspaceId || task.principalId !== payload.principalId)
    throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
  const label = await chat.label(task);
  if (label === null) throw new TaviError("UNAVAILABLE", `Tavi could not read what task ${taskId} read; try again`);
  const { integrity, sources, principals, confidentiality, refs } = label;
  return { ...rest, modelLabel: { integrity, sources, principals, confidentiality, refs } };
}

export async function routineScheduleAction(
  service: RoutineService,
  schedule: ScheduleRecord,
  input: SchedulesPayload,
): Promise<unknown | undefined> {
  const owner = await service.scheduleOwner(schedule.scheduleId);
  if (owner === undefined || input.action === "show" || input.action === "list") return undefined;
  const scope = { workspaceId: schedule.workspaceId, principalId: schedule.principalId };
  const current = await service.get(scope, owner.routineId);
  if (input.action === "run") throw new TaviError("UNSUPPORTED", "Use the routine run action to preserve its snapshot and policies");
  if (input.action === "enable" || input.action === "disable" || input.action === "remove")
    return await service.setStatus(
      scope,
      owner.routineId,
      current.routine.version,
      input.action === "enable" ? "active" : input.action === "disable" ? "paused" : "archived",
    );
  if (input.action !== "update") throw new TaviError("UNSUPPORTED", "Unsupported routine-owned schedule action");
  if (input.agentId !== undefined || input.alertConnection !== undefined || input.alertDestination !== undefined)
    throw new TaviError("UNSUPPORTED", "Edit pinned agents and authorized delivery targets through the routine action");
  const snapshot = current.revision.snapshot;
  const next: typeof snapshot = { ...snapshot };
  const triggers = snapshot.triggers.map((trigger) => {
    if (trigger.id !== owner.triggerId) return trigger;
    const spec = routineTriggerSpec(trigger);
    if (spec === undefined) throw new TaviError("UNSUPPORTED", "Edit a one-off runAt through the routine action");
    const { once, ...composed } = composeSpec(input, spec);
    if (once !== undefined)
      throw new TaviError("UNSUPPORTED", "A routine runs once through a one-off trigger: add one through the routine action");
    return { id: trigger.id, kind: "daily" as const, ...composed, timezone: composed.timezone ?? spec.timezone };
  });
  if (input.missed !== undefined && !["skip", "run-once-if-missed-within-6h"].includes(input.missed))
    throw new TaviError("INVALID_INPUT", "Unknown missed-run policy");
  Object.assign(next, {
    triggers,
    objective: input.prompt ?? snapshot.objective,
    permissions: { ...snapshot.permissions, researchTools: input.allow ?? snapshot.permissions.researchTools },
    execution: {
      ...snapshot.execution,
      catchUpHours: input.missed === undefined ? snapshot.execution.catchUpHours : input.missed === "skip" ? 0 : 6,
    },
  });
  // The person rewriting the objective clears the revision's provenance; any other change keeps it.
  const edited = await service.update(
    scope,
    {
      routineId: owner.routineId,
      expectedRevision: current.routine.latestRevision,
      operationKey: `schedule-edit-${routineHash({ input, revision: current.routine.latestRevision })}`,
      ...(input.name === undefined ? {} : { name: input.name }),
      changeSummary: "Edited through owned schedule",
      snapshot: next,
    },
    next.objective !== snapshot.objective ? null : undefined,
  );
  // The edit succeeded; whether a pinned destination is currently authorized is
  // reported alongside it, not turned into a failure of an unrelated edit.
  const result: RoutineEditResult = {
    ...edited,
    changes: changedSections(snapshot, next),
    previousRevision: current.revision.revision,
    deliveryReadiness: await service.deliveryReadiness(scope, owner.routineId, edited.revision.revision),
  };
  return result;
}
