import type { TranscriptEntry } from "@tavi/client/browser";
import { PLAN_TOOL_ID, planItems, type PlanItem } from "@tavi/contracts";

import type { Session } from "../shell/shell.js";

/** The latest plan the model keeps in these entries: only one the tool accepted, a refused one never was the plan. */
export function latestPlan(entries: readonly TranscriptEntry[]): readonly PlanItem[] | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "tool" && entry.toolName === PLAN_TOOL_ID && entry.status === "completed") {
      const items = planItems(entry.input);
      if (items !== undefined) return items;
    }
  }
  return undefined;
}

/**
 * The transcript of the newest turn before `before` that kept a plan: the plan
 * a turn carries on when it has not made its own. The transcript itself, not
 * its parsed plan, so a memoized card given it sees the same reference.
 */
export function earlierPlanSource(runs: Session["runs"], before: number): readonly TranscriptEntry[] | undefined {
  for (let index = before - 1; index >= 0; index -= 1) {
    const transcript = runs[index]?.run.transcript;
    if (transcript !== undefined && latestPlan(transcript) !== undefined) return transcript;
  }
  return undefined;
}

/** The chat's plan: the newest turn's that kept one — the same plan a running turn's working line counts in. */
export function sessionPlan(session: Session): readonly PlanItem[] | undefined {
  const source = earlierPlanSource(session.runs, session.runs.length);
  return source === undefined ? undefined : latestPlan(source);
}

/**
 * Where a plan stands, for the working line: the step in progress — else the
 * first not done — counted from one. `undefined` once every step is done.
 */
export function planStep(plan: readonly PlanItem[]): { readonly step: number; readonly of: number; readonly content: string } | undefined {
  let index = plan.findIndex((item) => item.status === "in_progress");
  if (index < 0) index = plan.findIndex((item) => item.status !== "done");
  const item = plan[index];
  return item === undefined ? undefined : { step: index + 1, of: plan.length, content: item.content };
}
