import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { type WorkflowResumeDecision, WorkflowWaitRequestSchema } from "@tavi/contracts";

/**
 * Read interrupt payloads out of a graph result.
 *
 * LangGraph wraps each interrupt as `{ id, value }`; the adapter's approval node
 * passes an array of payloads to `interrupt()`, so the value is flattened back
 * into one entry per pending decision.
 */
export function extractInterrupts(result: unknown): readonly unknown[] {
  if (typeof result !== "object" || result === null) return [];
  const candidate = (result as { __interrupt__?: unknown }).__interrupt__;
  if (!Array.isArray(candidate)) return [];
  const flattened: unknown[] = [];
  for (const entry of candidate) {
    const value = typeof entry === "object" && entry !== null && "value" in entry ? (entry as { value: unknown }).value : entry;
    if (Array.isArray(value)) flattened.push(...value);
    else flattened.push(value);
  }
  return flattened;
}

/**
 * The interrupt a thread's latest checkpoint is suspended on, if any — the same
 * first payload `extractInterrupts` reads off an invocation's result.
 */
export function pendingInterruptOf(state: unknown): unknown {
  const tasks = typeof state === "object" && state !== null ? (state as { tasks?: unknown }).tasks : undefined;
  if (!Array.isArray(tasks)) return undefined;
  for (const task of tasks) {
    const interrupts = typeof task === "object" && task !== null ? (task as { interrupts?: unknown }).interrupts : undefined;
    if (!Array.isArray(interrupts)) continue;
    for (const entry of interrupts) {
      const value = typeof entry === "object" && entry !== null && "value" in entry ? (entry as { value: unknown }).value : entry;
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * The kinds of suspension a pending interrupt can be, each with its round.
 * Recognition only — the node validates the payload it resumes with.
 */
const PendingReviewKindSchema = z.object({
  requests: z.array(z.object({ artifactId: z.string().min(1), steps: z.number().int().nonnegative() })).min(1),
});

const PendingApprovalKindSchema = z.object({
  requests: z.array(z.object({ callId: z.string().min(1), summary: z.string(), steps: z.number().int().nonnegative() })).min(1),
});

/**
 * Whether a resume answers this pending interrupt: the same kind of suspension
 * and, when the resume names a round, that round.
 *
 * A resume that names no round (`tavi approvals`, which decides whatever round
 * is pending) is matched on kind alone: its decisions are still validated by
 * the node, so an ill-formed one fails there as it always has, rather than being
 * mistaken for a thread that moved on. Exported for its unit tests.
 */
export function resumeAnswersInterrupt(payload: unknown, resume: WorkflowResumeDecision): boolean {
  if (payload === undefined) return false;
  const sameRound = (steps: number | undefined): boolean => resume.expectedSteps === undefined || steps === resume.expectedSteps;
  // Review first: its entries carry a `callId` too, so an approval must never be
  // recognised in a review's payload.
  const review = PendingReviewKindSchema.safeParse(payload);
  if (resume.reviewAck === true) return review.success && sameRound(review.data.requests[0]?.steps);
  if (resume.approved !== undefined || resume.decisions !== undefined) {
    if (review.success) return false;
    const approval = PendingApprovalKindSchema.safeParse(payload);
    return approval.success && sameRound(approval.data.requests[0]?.steps);
  }
  return WorkflowWaitRequestSchema.safeParse(payload).success;
}

/**
 * Whether the thread is still suspended on the interrupt a resume answers. A
 * state that cannot be read keeps the resume, as before this check existed.
 */
export async function resumeStillApplies(
  graph: { getState(config: RunnableConfig): Promise<unknown> },
  config: RunnableConfig,
  resume: WorkflowResumeDecision,
): Promise<boolean> {
  try {
    return resumeAnswersInterrupt(pendingInterruptOf(await graph.getState(config)), resume);
  } catch {
    return true;
  }
}
