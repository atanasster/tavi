import { TASK_NEEDS } from "./need-kinds.js";
import { TaskNeedSchema } from "./task-list.js";
import { z } from "zod";
import { IdSchema, TimestampSchema } from "./ids.js";
import { AgentDelegatedBudgetSchema, WORKER_RESULT_TEXT_MAX } from "./agent-communication.js";
export const AGENT_TREE_LIMIT = 200;
/** A worker's one-line latest activity: a tool's name or its newest text's tail. */
export const AGENT_TREE_ACTIVITY_MAX = 200;
export const AgentTreeActivitySchema = z.object({ kind: z.enum(["tool", "text"]), text: z.string().min(1).max(AGENT_TREE_ACTIVITY_MAX) });
export type AgentTreeActivity = z.infer<typeof AgentTreeActivitySchema>;
export const AgentTreeNodeSchema = z.object({
  needs: z.array(TaskNeedSchema).max(TASK_NEEDS.length).optional(),
  taskId: IdSchema,
  parentTaskId: IdSchema.optional(),
  workerAgentId: IdSchema.optional(),
  agentDefinitionId: IdSchema.optional(),
  status: z.string().max(64),
  depth: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  budget: AgentDelegatedBudgetSchema.optional(),
  /** What the worker did last: its live stream's newest tool or text, else its last saved turn's. Absent on an owner from before it. */
  activity: AgentTreeActivitySchema.optional(),
  /** An ended task's final answer, bounded as a worker's result envelope is. */
  finalText: z.string().max(WORKER_RESULT_TEXT_MAX).optional(),
});
export const AgentTreeResultSchema = z.object({
  taskId: IdSchema,
  rootTaskId: IdSchema.optional(),
  workspaceId: IdSchema,
  nodes: z.array(AgentTreeNodeSchema).max(AGENT_TREE_LIMIT),
  ancestors: z.array(IdSchema).max(32),
  truncated: z.boolean(),
  ancestryUnknown: z.boolean(),
});
export type AgentTreeResult = z.infer<typeof AgentTreeResultSchema>;
export type AgentTreeNode = z.infer<typeof AgentTreeNodeSchema>;
