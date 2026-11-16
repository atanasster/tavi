import type { TaskListRow } from "@tavi/contracts";
import type { Database } from "./sqlite-loader.js";
/**
 * UNION deduplicates cycles as well as shared ancestry. Workspace checks apply at every hop.
 * A browser handoff is a need of its own: the person acts in the page, not in an answer; so is a
 * connect wait: the person signs an app in again.
 */
export const TASK_NEEDS_CTE = `needs(task_id, workspace_id, need, via_child) AS (
  SELECT t.task_id,t.workspace_id,'approval',0 FROM tavi_tasks t JOIN tavi_approvals p ON p.task_id=t.task_id WHERE p.state='pending'
  UNION SELECT t.task_id,t.workspace_id,'review',0 FROM tavi_tasks t JOIN tavi_artifacts r ON r.run_id=t.task_id AND r.workspace_id=t.workspace_id WHERE r.review_state='pending'
  UNION SELECT t.task_id,t.workspace_id,'question',0 FROM tavi_tasks t JOIN tavi_agent_wait_intents w ON w.task_id=t.task_id WHERE w.state='active' AND w.handoff_json IS NULL AND w.connect_json IS NULL AND EXISTS(SELECT 1 FROM tavi_admissions a WHERE a.task_id=t.task_id AND json_extract(a.result,'$.waitInterrupt.wait.waitId')=w.wait_id AND json_type(a.result,'$.waitInterrupt.question')='text')
  UNION SELECT t.task_id,t.workspace_id,'handoff',0 FROM tavi_tasks t JOIN tavi_agent_wait_intents w ON w.task_id=t.task_id WHERE w.state='active' AND w.handoff_json IS NOT NULL
  UNION SELECT t.task_id,t.workspace_id,'connect',0 FROM tavi_tasks t JOIN tavi_agent_wait_intents w ON w.task_id=t.task_id WHERE w.state='active' AND w.connect_json IS NOT NULL
  UNION SELECT p.task_id,p.workspace_id,n.need,1 FROM needs n JOIN tavi_agent_delegation_admissions d ON d.worker_task_id=n.task_id AND d.workspace_id=n.workspace_id JOIN tavi_tasks p ON p.task_id=d.parent_task_id AND p.workspace_id=n.workspace_id
)`;
export function queryTaskNeeds(
  db: Database,
  workspaceId: string,
  taskIds: readonly string[],
): Readonly<Record<string, TaskListRow["needs"]>> {
  const ids = [...new Set(taskIds)].slice(0, 200);
  if (!ids.length) return {};
  const rows = db
    .prepare(
      `WITH RECURSIVE ${TASK_NEEDS_CTE} SELECT DISTINCT task_id,need FROM needs WHERE workspace_id=? AND task_id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(workspaceId, ...ids) as { task_id: string; need: TaskListRow["needs"][number] }[];
  const result: Record<string, TaskListRow["needs"]> = Object.create(null) as Record<string, TaskListRow["needs"]>;
  for (const row of rows) (result[row.task_id] ??= []).push(row.need);
  return result;
}
