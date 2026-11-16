import type { AdmitInput, PersistencePort, WorkflowPort } from "@tavi/contracts";
import type { ScheduleSchedulerDependencies } from "@tavi/agent-host/schedule-scheduler";
import { ChatFolders } from "@tavi/runtime";

/**
 * What an event trigger's test fires through: the scheduler's run-now dependencies over a workflow that only records
 * what it was asked to admit, the log lines, and the schedules whose fire is in flight.
 */
export function scheduleFireHarness(
  repositories: Pick<PersistencePort["repositories"], "schedules" | "executions" | "artifacts">,
  now: () => string,
) {
  const admitted: AdmitInput[] = [];
  const logs: string[] = [];
  let ids = 0;
  const inFlight = new Set<string>();
  const workflow: WorkflowPort = {
    admit: async (input) => {
      admitted.push(input);
      const taskId = `task-${admitted.length}`;
      if (input.kind === "start") await input.onAdmitted?.({ taskId } as never);
      return {
        taskId,
        threadId: `thread-${taskId}`,
        outcome: { status: "completed", finalText: "done" },
        created: true,
        replay: false,
      } as never;
    },
    checkpoints: { list: () => [], get: () => undefined } as unknown as WorkflowPort["checkpoints"],
  };
  const scheduling = {
    schedules: repositories.schedules,
    executions: repositories.executions,
    artifacts: repositories.artifacts,
    workflow,
    now,
    newId: (prefix: string) => `${prefix}-${++ids}`,
    log: (event: { readonly message: string; readonly detail?: unknown }) => logs.push(JSON.stringify(event)),
  } as unknown as ScheduleSchedulerDependencies;
  return { admitted, logs, inFlight, scheduling };
}

/** The owner's folder rule over one `--fs-root` (`root`), as `tavi serve --fs-root <root>` checks a schedule's file or folder. */
export function ownerFolders(root: string, create: () => string, now: () => string): ChatFolders {
  return new ChatFolders({
    dataDirectory: create(),
    fsRoots: [root],
    homeDirectory: create(),
    repository: { get: () => undefined, revision: () => 0, write: () => ({}) as never },
    tasks: { get: async () => undefined } as never,
    agentDelegations: { getByWorkerTaskId: async () => undefined } as never,
    actsIn: () => true,
    now,
  } as ConstructorParameters<typeof ChatFolders>[0]);
}
