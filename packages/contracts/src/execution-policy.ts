import { z } from "zod";

import { toolPatternMatches } from "./tool-policy.js";
import type { ToolEffect, ToolSink } from "./tools.js";

/**
 * The trusted execution policy of a task.
 *
 * This is durable, task-level state — not prompt content. A prompt may *say*
 * anything about asking a person; only this decides whether the runtime delivers
 * a question, which is why the policy is recorded where the admitting code path
 * puts it and never derived from the base instructions.
 *
 * The policy is supplied by **task-creating** admissions and read from the task
 * row by every later turn. A follow-up cannot upgrade it: a reply, a wake or an
 * approval inherits what the task was created with, so a scheduled run cannot
 * become interactive by being answered.
 */

export const EXECUTION_MODES = ["attended", "unattended"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

const TaskExecutionPolicyShape = z.strictObject({
  /**
   * Whether a person is expected to be reachable for this task. Recorded for
   * attribution and diagnostics; `humanQuestionsAllowed` is the field that
   * decides behavior, so the two are set together by the helpers below rather
   * than independently.
   */
  mode: z.enum(EXECUTION_MODES),
  /** Whether `operator.ask_user` is offered to the model and delivered when called. */
  humanQuestionsAllowed: z.boolean(),
  /**
   * Whether a supported wait on another task is allowed. Kept separate from
   * questions because mailbox coordination between tasks is not a human
   * interaction: an unattended run legitimately waits on a worker.
   */
  workerWaitsAllowed: z.boolean(),
  /**
   * Every question must name its options and the one to go with if nobody
   * answers: set for an unattended run that may ask, so a person who
   * never answers changes nothing but which option is taken.
   */
  requiresDefault: z.boolean().optional(),
  /**
   * The only tools this task may be offered, discover or call, as exact ids
   * or `prefix.*` families. Absent — every
   * policy recorded before it — means no narrowing beyond the rules.
   */
  toolAllowlist: z.array(z.string().min(1).max(128)).max(64).optional(),
  /**
   * Set on a schedule's fire, and carried to every worker it spawns: a call to
   * a tool that creates or changes schedules or routines is denied, whatever
   * an allow rule or grant says (`reachesSchedulingWrite`).
   */
  schedulingWritesDenied: z.boolean().optional(),
  /**
   * A reader session: set on a schedule's run an email started, and carried to
   * every worker it spawns. Only read-only tools that reach nothing outside
   * are offered or run, whatever
   * an allow rule, a grant or the schedule's tool list says; the one
   * exception is a send to the schedule's own delivery destination
   * (`readerSessionAllows`).
   */
  readOnlyTools: z.boolean().optional(),
});

/**
 * A policy whose `mode` and question capability disagree is refused.
 *
 * `mode` is a label and `humanQuestionsAllowed` is what decides behavior, so a
 * row reading `unattended` with questions allowed would either be ignored or
 * would deliver a question to nobody — the exact well-typed lie the task-origin
 * validation next door exists to prevent. The other direction (`attended` with
 * questions disabled) is a legitimate stricter policy and is allowed.
 */
export const TaskExecutionPolicySchema = TaskExecutionPolicyShape.superRefine((policy, ctx) => {
  // An unattended run may ask only when every question carries a default.
  if (policy.mode === "unattended" && policy.humanQuestionsAllowed && policy.requiresDefault !== true) {
    ctx.addIssue({
      code: "custom",
      path: ["humanQuestionsAllowed"],
      message: "an unattended policy can allow human questions only when each must carry a default",
    });
  }
});
export type TaskExecutionPolicy = z.infer<typeof TaskExecutionPolicySchema>;

/** A person is reachable: `ask_user` is offered, and worker waits are supported. */
export const ATTENDED_TASK_POLICY: TaskExecutionPolicy = {
  mode: "attended",
  humanQuestionsAllowed: true,
  workerWaitsAllowed: true,
};

/**
 * Nobody is reachable: `ask_user` is neither offered nor delivered, while
 * mailbox coordination with other tasks stays available.
 */
export const UNATTENDED_TASK_POLICY: TaskExecutionPolicy = {
  mode: "unattended",
  humanQuestionsAllowed: false,
  workerWaitsAllowed: true,
};

/**
 * A scheduled prompt's fire: unattended, and it never creates or changes
 * schedules or routines, nor does a worker it spawns.
 */
export const SCHEDULE_TASK_POLICY: TaskExecutionPolicy = {
  ...UNATTENDED_TASK_POLICY,
  schedulingWritesDenied: true,
};

/**
 * The tools a heartbeat turn may use: an explicit list, not "every
 * read-only tool" — `web_search` and `http.*` are external, `findings.add`
 * writes, `agents.wait` waits, and `tools.search` would discover the rest.
 * `heartbeat.fetch` reads only pages the heartbeat watches, and links found
 * on them, on the hosts granted to it; `heartbeat.report` is the host's
 * structured answer. Read-only plugin tools join per heartbeat
 * through the person's `extraTools`.
 */
export const HEARTBEAT_TOOL_ALLOWLIST: readonly string[] = [
  "memory.search",
  "memory.get",
  "reminders.list",
  "sessions.search",
  "projects.get",
  "reports.history",
  "heartbeat.fetch",
  "heartbeat.report",
];

/**
 * A heartbeat tick's policy: nobody is
 * reachable, nothing waits, and only the allowlist is offered.
 */
export const HEARTBEAT_TASK_POLICY: TaskExecutionPolicy = {
  mode: "unattended",
  humanQuestionsAllowed: false,
  workerWaitsAllowed: false,
  toolAllowlist: [...HEARTBEAT_TOOL_ALLOWLIST],
};

/** Tools offered only to a task whose allowlist names them: the heartbeat's structured answer and its own fetch. */
export const ALLOWLIST_ONLY_TOOL_IDS: readonly string[] = ["heartbeat.report", "heartbeat.fetch"];

/**
 * Whether a policy admits a tool: its allowlist names it, or it has none.
 * An allowlist-only tool needs naming exactly — no wildcard, no absent list.
 */
export function policyAllowsTool(policy: Pick<TaskExecutionPolicy, "toolAllowlist">, toolId: string): boolean {
  if (ALLOWLIST_ONLY_TOOL_IDS.includes(toolId)) return policy.toolAllowlist?.includes(toolId) === true;
  return policy.toolAllowlist === undefined || policy.toolAllowlist.some((pattern) => toolPatternMatches(pattern, toolId));
}

/** The tool a schedule's run delivers to its configured destination with: the one send a reader session keeps. */
export const READER_SESSION_DELIVERY_TOOL_ID = "messaging.send_to";

/**
 * Whether a reader session (`readOnlyTools`) may offer or run a tool: a
 * read-only one that reaches nothing outside (its sink `none`, so not a page
 * fetch, a search or an MCP server's read), or the delivery tool when the run
 * has a delivery destination — and a call of it only when its assessment found
 * it a send to that destination (`sink: "reply"`), which `assessedSink` says
 * at the gate. Any other policy admits everything here.
 */
export function readerSessionAllows(
  policy: Pick<TaskExecutionPolicy, "readOnlyTools">,
  tool: { readonly id: string; readonly effect: ToolEffect; readonly sink?: ToolSink | undefined },
  call: { readonly hasDelivery: boolean; readonly assessedSink?: ToolSink | undefined; readonly atGate?: boolean },
): boolean {
  if (policy.readOnlyTools !== true) return true;
  if (tool.effect === "read-only" && (tool.sink === undefined || tool.sink === "none")) return true;
  if (tool.id !== READER_SESSION_DELIVERY_TOOL_ID || !call.hasDelivery) return false;
  return call.atGate !== true || call.assessedSink === "reply";
}

/**
 * A scheduled routine's task policy: nobody is reachable **and** nothing waits.
 *
 * `UNATTENDED_TASK_POLICY` keeps `workerWaitsAllowed` on because mailbox
 * coordination between tasks is not a human interaction and an ordinary
 * scheduled admission answers its own suspensions (`resolveSuspensions` in the
 * scheduler). A routine-owned schedule does not: `routineDispatch` returns
 * before that resolver, the routine loop is synchronous (its `agents.spawn`
 * returns only once the worker has settled), and neither the chat tool nor the
 * IPC surface has a way to answer a suspended root. A root that reached
 * `waiting` therefore left a durable task no routine-aware owner would ever
 * settle.
 *
 * So a routine task refuses `agents.wait` structurally, before the wait row
 * exists, with the same bounded typed result the workflow adapter already gives
 * an unsupported wait.
 *
 * The backstop covers the rest, and its reach is stated exactly because it is
 * easy to over-claim: `RoutineExecutionService` settles any active wait a run's
 * tasks still hold in `finish`, in `cancel`, in the owner-recovery interrupt and
 * in the busy-slot interrupt, so a run cannot *terminate* over a `waiting` task:
 * a root task whose stored policy is `UNATTENDED_TASK_POLICY`
 * (`workerWaitsAllowed: true`) rather than this one creates the wait through its
 * adapter; the pipeline settles it as soon as the suspension surfaces, and the
 * runtime backstop settles it if the run ends first.
 */
export const ROUTINE_TASK_POLICY: TaskExecutionPolicy = {
  mode: "unattended",
  humanQuestionsAllowed: false,
  workerWaitsAllowed: false,
};

/**
 * A routine with human checkpoints on: it may
 * ask, but only with options and a default, so nobody answering never stops
 * it. Its run holds its slot while the question waits, inside its own budget,
 * and resumes its root itself; other waits stay refused as for any routine.
 */
export const ROUTINE_CHECKPOINT_TASK_POLICY: TaskExecutionPolicy = {
  mode: "unattended",
  humanQuestionsAllowed: true,
  requiresDefault: true,
  workerWaitsAllowed: false,
};

/**
 * A scheduled prompt with human checkpoints on:
 * like any fire it may wait on a worker, and it may ask, only with a default.
 * The question goes to the schedule's alert destination and is decided by its
 * deadline at the latest; the owner continues the task under the schedule's
 * tool policy once it is answered.
 */
export const SCHEDULE_CHECKPOINT_TASK_POLICY: TaskExecutionPolicy = {
  mode: "unattended",
  humanQuestionsAllowed: true,
  requiresDefault: true,
  workerWaitsAllowed: true,
  schedulingWritesDenied: true,
};

/**
 * The policy for a creating admission that supplied none.
 *
 * **Unattended, deliberately.** The two failure modes are asymmetric: an
 * unattended default silently disables `ask_user` for a task whose admitting
 * site forgot to pass a policy (the model is told it cannot ask, and answers with
 * what it has), while an attended default silently *delivers* a question from a
 * run that has nobody listening — a message to a person and a suspended task.
 * Losing a question is recoverable; a spurious outbound message is not.
 *
 * The cost is stated where it is paid: every ordinary attended path (a CLI run,
 * an IPC `run`, an inbound conversation) passes `ATTENDED_TASK_POLICY`
 * explicitly, and a new attended entry point that forgets to will find that its
 * tasks cannot ask questions.
 */
export const DEFAULT_TASK_POLICY: TaskExecutionPolicy = UNATTENDED_TASK_POLICY;
