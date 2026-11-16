import type {
  AdmissionResult,
  AdmittedTask,
  InboundBlock,
  InvocationContext,
  TaskExecutionPolicy,
  TaskOrigin,
  WorkflowInvokeOptions,
  WorkflowPort,
} from "@tavi/contracts";

/**
 * One unattended run's admission: shared by the
 * schedule scheduler and the heartbeat host. A run is a run, never a chat;
 * its policy is the one its whole task carries; its
 * operation key is deterministic per fire or tick, so a re-dispatch replays
 * the committed admission instead of running twice.
 */
export interface UnattendedAdmission {
  readonly context: InvocationContext;
  readonly operationKey: string;
  readonly prompt: string;
  /** What started the run from outside (a webhook call's payload, an email), as quoted data after the prompt. */
  readonly trigger?: InboundBlock;
  readonly executionPolicy: TaskExecutionPolicy;
  readonly origin: TaskOrigin;
  /** Present exactly when `origin` is `schedule`. */
  readonly originScheduleId?: string;
  /** The run's task identity is durable and its lease held: the window in which an overlap guard can see it. */
  readonly onAdmitted?: (admitted: AdmittedTask) => void | Promise<void>;
}

export async function admitUnattended(
  workflow: Pick<WorkflowPort, "admit">,
  input: UnattendedAdmission,
  options?: WorkflowInvokeOptions,
): Promise<AdmissionResult> {
  return await workflow.admit(
    {
      context: input.context,
      kind: "start",
      executionPolicy: input.executionPolicy,
      operationKey: input.operationKey,
      prompt: input.prompt,
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      origin: input.origin,
      ...(input.originScheduleId === undefined ? {} : { originScheduleId: input.originScheduleId }),
      chatKind: "run",
      ...(input.onAdmitted === undefined ? {} : { onAdmitted: input.onAdmitted }),
    },
    options,
  );
}
