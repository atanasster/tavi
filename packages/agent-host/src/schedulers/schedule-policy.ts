import {
  type AdmissionResult,
  type InvocationContext,
  ROUND_REFUSED,
  type ScheduleRecord,
  TaviError,
  expectedStepsOf,
  isPromotedFolderFile,
  reachesSchedulingWrite,
  scheduledWorkDenial,
  unattendedDenial,
  textRef,
} from "@tavi/contracts";

import { sendAlert } from "./schedule-alerts.js";
import type { ScheduleSchedulerDependencies } from "./schedule-dependencies.js";

/** Bound on approval/review resolution rounds within one fire, so a pathological run cannot spin forever. */
const MAX_POLICY_ROUNDS = 50;

/**
 * Whether `toolName` is permitted by an operator-authored allowlist.
 *
 * Allowlist semantics, deny by default: `*` permits everything, `prefix.*`
 * permits the `prefix.` family, anything else is an exact id. Exported so the
 * CLI's `schedules show` can explain a decision with the same function that
 * makes it, rather than a re-implementation that can drift.
 */
export function toolAllowed(toolName: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern === "web_*") return toolName === "web_search" || toolName === "web_fetch";
    if (pattern.endsWith(".*")) return toolName.startsWith(`${pattern.slice(0, -1)}`);
    return toolName === pattern;
  });
}

export function suspensionKind(admission: AdmissionResult): string {
  const { interrupt, reviewInterrupt, waitInterrupt } = admission.outcome;
  if (waitInterrupt !== undefined) return "a wait";
  if (reviewInterrupt !== undefined) return "an artifact review it could not decide";
  if (interrupt !== undefined) return `${interrupt.requests.length} approval request(s) it could not decide`;
  return "an unknown suspension";
}

/**
 * Answer a suspended run's approval and artifact-review prompts by the
 * schedule's allowlist, re-admitting until it either finishes or suspends on
 * something this policy cannot decide.
 *
 * This mirrors `tavi run`'s `--approval approve` loop deliberately: that loop
 * is the reference implementation, and the only new thing here is
 * that the decision is per-tool and per-schedule rather than process-wide.
 *
 * A `wait` suspension is *not* answered here: a worker's result, an answer or
 * the wait's deadline carries the run on (`continueScheduledTask`), and any
 * other wait has nobody to reply, so it is returned to the caller to report.
 */
export async function resolveSuspensions(
  admission: AdmissionResult,
  schedule: ScheduleRecord,
  operationKey: string,
  deps: ScheduleSchedulerDependencies,
  /** The run's budget: a decision's resume is aborted with the turn it continues. */
  signal?: AbortSignal,
): Promise<{ readonly admission: AdmissionResult; readonly refusal?: RoundRefusal }> {
  let current = admission;
  const invoke = signal === undefined ? undefined : { signal };
  // One round's decision, refused by the round precondition when another front
  // end decided that round first: reported as the fire's outcome, with the task
  // it belongs to, rather than thrown to the "could not start" path.
  const decide = async (steps: number | undefined, admit: () => Promise<AdmissionResult>): Promise<RoundRefusal | undefined> => {
    try {
      current = await admit();
      return undefined;
    } catch (error) {
      if (!(error instanceof TaviError && error.code === "CONFLICT" && error.details?.["reason"] === ROUND_REFUSED)) throw error;
      return { taskId: current.taskId, steps, message: error.message };
    }
  };
  const context = (): InvocationContext => ({
    workspaceId: schedule.workspaceId,
    principalId: schedule.principalId,
    runId: current.taskId,
    caller: `schedule:${schedule.name}`,
  });

  // The scheduling entries already told about in this fire; across fires, the alert's key tells it once.
  const told = new Set<string>();
  for (let round = 0; round < MAX_POLICY_ROUNDS; round += 1) {
    if (current.outcome.status !== "waiting") return { admission: current };
    const { interrupt, reviewInterrupt, waitInterrupt } = current.outcome;
    if (waitInterrupt !== undefined) return { admission: current };

    if (reviewInterrupt !== undefined) {
      // The archived tool output is `pending`; the producing tool's presence in
      // the allowlist is what decides whether it may be released. Deciding via
      // `setReviewState` (not a resume value) is how the review gate is
      // designed to be resolved — `tavi artifacts approve --resume` does
      // exactly this, then acknowledges with `reviewAck`.
      // A file a call took from the chat's folder to send out is a person's to release: the fire leaves it pending, for the inbox.
      let leftForPerson = false;
      for (const request of reviewInterrupt.requests) {
        const approved = toolAllowed(request.toolName, schedule.autoApproveTools);
        const record = await deps.artifacts.getArtifact(request.artifactId);
        if (record === undefined || record.reviewState !== "pending") continue;
        if (isPromotedFolderFile(record)) {
          leftForPerson = true;
          deps.log({
            level: "warn",
            message: "schedule left a file from the chat's folder for a person to review",
            detail: { scheduleId: schedule.scheduleId, artifactId: request.artifactId, toolName: request.toolName },
          });
          continue;
        }
        try {
          await deps.artifacts.setReviewState({
            artifactId: request.artifactId,
            reviewState: approved ? "approved" : "rejected",
            reviewedBy: `schedule:${schedule.name}`,
            reviewedAt: deps.now(),
          });
          if (approved) await deps.materializeArtifact?.(request.artifactId);
        } catch (error) {
          if (!(error instanceof TaviError && error.code === "CONFLICT")) throw error;
          // A concurrent decider won the compare-and-set; their decision stands.
        }
        deps.log({
          level: approved ? "info" : "warn",
          message: approved ? "schedule released an archived tool result" : "schedule rejected an archived tool result",
          detail: { scheduleId: schedule.scheduleId, artifactId: request.artifactId, toolName: request.toolName },
        });
      }
      if (leftForPerson) return { admission: current };
      const steps = reviewInterrupt.requests[0]?.steps;
      const refusal = await decide(steps, () =>
        deps.workflow.admit(
          {
            context: context(),
            taskId: current.taskId,
            operationKey: `${operationKey}:review:${round}`,
            kind: "approval",
            // The round it answers, as a precondition: a fire keeps its own
            // key, but it must never acknowledge a round other than the one it read.
            resume: { reviewAck: true, ...(steps === undefined ? {} : expectedStepsOf({ steps })) },
          },
          invoke,
        ),
      );
      if (refusal !== undefined) return { admission: current, refusal };
      continue;
    }

    if (interrupt !== undefined) {
      // Which calls were denied because they create or change schedules or routines, by request index.
      const schedulingRefused: boolean[] = [];
      // A tainted, taint-asked or critical call is denied for every tool, whatever
      // the tool list says: nobody attends a fire to judge it.
      const decisions = interrupt.requests.map((request, index) => {
        // Only a read-only MCP tool is ever auto-approved: one re-approved as a write since
        // the schedule listed it is denied, whatever the list says.
        const listed = toolAllowed(request.toolName, schedule.autoApproveTools);
        const otherwiseDenied =
          unattendedDenial(request) ??
          (listed && request.toolName.startsWith("mcp.") && request.effect !== "read-only"
            ? "denied: a schedule auto-approves only read-only MCP tools"
            : undefined);
        const schedulingDenial = otherwiseDenied === undefined && listed ? scheduledWorkDenial(request.toolName) : undefined;
        schedulingRefused[index] = schedulingDenial !== undefined;
        const unattended = otherwiseDenied ?? schedulingDenial;
        const approved = unattended === undefined && listed;
        return {
          callId: request.callId,
          approved,
          decidedBy: `schedule:${schedule.name}`,
          note: approved ? "auto-approved by this schedule's tool policy" : (unattended ?? "denied: not in this schedule's tool policy"),
        };
      });
      for (const [index, request] of interrupt.requests.entries()) {
        const decision = decisions[index];
        if (decision === undefined || decision.approved) continue;
        if (request.toolName === "messaging.send_to") deps.inFlight?.noteDeniedSend(current.taskId);
        deps.inFlight?.noteDeniedCall(current.taskId);
        deps.log({
          level: "warn",
          message: "schedule denied a tool call",
          detail: { scheduleId: schedule.scheduleId, toolName: request.toolName, reason: decision.note },
        });
        // A list saved before scheduling tools were refused still names one: told once per entry, keyed
        // on the entry rather than the fire, so a daily schedule does not repeat it every morning.
        if (schedulingRefused[index] === true) {
          const entry = schedule.autoApproveTools.find(
            (pattern) => reachesSchedulingWrite(pattern) && toolAllowed(request.toolName, [pattern]),
          );
          if (entry !== undefined && !told.has(entry)) {
            told.add(entry);
            await sendAlert(
              schedule,
              {
                identity: `allow:${entry}`,
                kind: "scheduling-refused",
                text: textRef("channel.schedule.alert.schedulingRefused", { name: schedule.name, tool: request.toolName, entry }),
              },
              deps,
            );
          }
        }
      }
      const steps = interrupt.requests[0]?.steps;
      const refusal = await decide(steps, () =>
        deps.workflow.admit(
          {
            context: context(),
            taskId: current.taskId,
            operationKey: `${operationKey}:approval:${round}`,
            kind: "approval",
            resume: { decisions, ...(steps === undefined ? {} : expectedStepsOf({ steps })) },
          },
          invoke,
        ),
      );
      if (refusal !== undefined) return { admission: current, refusal };
      continue;
    }

    // `waiting` with no recognizable suspension: nothing this policy can answer.
    return { admission: current };
  }
  throw new TaviError("INTERNAL", `Schedule ${schedule.scheduleId} exceeded ${MAX_POLICY_ROUNDS} policy rounds in one fire`);
}

/** A fire's decision refused because another front end decided that round first. */
export interface RoundRefusal {
  readonly taskId: string;
  readonly steps: number | undefined;
  readonly message: string;
}
