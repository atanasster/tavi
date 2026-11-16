import { TERMINAL_TASK_STATUSES } from "@tavi/agent-host/agent-communication";
import {
  AGENT_TREE_ACTIVITY_MAX,
  AGENT_TREE_LIMIT,
  TaviError,
  WORKER_RESULT_TEXT_MAX,
  type AgentTreeActivity,
  type AgentTreeResult,
  type AgentTreeNode,
  type PersistencePort,
} from "@tavi/contracts";
const ENDED = TERMINAL_TASK_STATUSES;
export async function readAgentTree(
  repositories: Pick<PersistencePort["repositories"], "tasks" | "agentDelegations">,
  workspaceId: string,
  taskId: string,
  limit = AGENT_TREE_LIMIT,
): Promise<AgentTreeResult> {
  const task = await repositories.tasks.get(taskId);
  if (!task || task.workspaceId !== workspaceId) throw new TaviError("NOT_FOUND", `no task ${taskId} exists in workspace ${workspaceId}`);
  const bound = Math.max(1, Math.min(AGENT_TREE_LIMIT, limit));
  const original = await repositories.agentDelegations.getByWorkerTaskId(taskId);
  const nodes: AgentTreeNode[] = [];
  const queue = [{ task, edge: original }];
  const visited = new Set([taskId]);
  let truncated = false;
  // A breadth-first walk: `queue` grows behind the walk, as each node's workers are found.
  for (let index = 0, entry = queue[0]; entry !== undefined && nodes.length < bound; index++, entry = queue[index]) {
    const edge = entry.edge;
    nodes.push({
      taskId: entry.task.taskId,
      status: entry.task.status.slice(0, 64),
      depth: edge?.depth ?? 0,
      createdAt: entry.task.createdAt,
      updatedAt: entry.task.updatedAt,
      ...(edge?.parentTaskId ? { parentTaskId: edge.parentTaskId } : {}),
      ...(edge?.workerAgentId ? { workerAgentId: edge.workerAgentId } : {}),
      ...(edge?.agentDefinitionId ? { agentDefinitionId: edge.agentDefinitionId } : {}),
      ...(edge?.budget ? { budget: edge.budget } : {}),
      ...(ENDED.has(entry.task.status) && entry.task.finalText ? { finalText: entry.task.finalText.slice(0, WORKER_RESULT_TEXT_MAX) } : {}),
    });
    const remaining = bound - queue.length;
    const children = await repositories.agentDelegations.listChildren(workspaceId, entry.task.taskId, remaining + 1);
    for (const child of children) {
      if (visited.has(child.workerTaskId)) continue;
      const childTask = await repositories.tasks.get(child.workerTaskId);
      if (!childTask || childTask.workspaceId !== workspaceId) continue;
      if (queue.length >= bound) {
        truncated = true;
        break;
      }
      visited.add(child.workerTaskId);
      queue.push({ task: childTask, edge: child });
    }
  }
  const ancestors: string[] = [];
  const seen = new Set([taskId]);
  let parent = original?.parentTaskId;
  while (parent && ancestors.length < 32 && !seen.has(parent)) {
    const record = await repositories.tasks.get(parent);
    if (!record || record.workspaceId !== workspaceId) break;
    ancestors.unshift(parent);
    seen.add(parent);
    parent = (await repositories.agentDelegations.getByWorkerTaskId(parent))?.parentTaskId;
  }
  if (parent) truncated = true;
  const rootTaskId = original ? original.rootTaskId : taskId;
  return {
    taskId,
    workspaceId,
    nodes,
    ancestors,
    truncated,
    ancestryUnknown: original !== undefined && original.rootTaskId === undefined,
    ...(rootTaskId ? { rootTaskId } : {}),
  };
}
/**
 * What a worker did last, for its agent-tree row: its live
 * stream's newest tool or text while the owner still holds it, else — for a
 * worker not ended — the last item of its newest saved turn. An ended
 * worker's row carries its final text instead, so its history is not read.
 */
export async function workerActivity(
  bus: { latestActivity(taskId: string, maxChars: number): AgentTreeActivity | undefined },
  repositories: Pick<PersistencePort["repositories"], "transcripts">,
  taskId: string,
  status: string,
): Promise<AgentTreeActivity | undefined> {
  const live = bus.latestActivity(taskId, AGENT_TREE_ACTIVITY_MAX);
  if (live !== undefined) return live;
  if (ENDED.has(status)) return undefined;
  const items = (await repositories.transcripts.page(taskId, { limit: 1 })).entries.at(-1)?.turn.items ?? [];
  for (const item of [...items].reverse()) {
    if (item.kind === "tool") return { kind: "tool", text: item.toolName.slice(0, AGENT_TREE_ACTIVITY_MAX) };
    const line = item.text.replace(/\s+/g, " ").trim();
    if (line !== "")
      return {
        kind: "text",
        text: line.length <= AGENT_TREE_ACTIVITY_MAX ? line : `…${line.slice(line.length - AGENT_TREE_ACTIVITY_MAX + 1)}`,
      };
  }
  return undefined;
}
