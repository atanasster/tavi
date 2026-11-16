import type { RunnableConfig } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { AgentStateDataSchema, type CheckpointDescriptor } from "@tavi/contracts";
import { CallSchema } from "./dispatch.js";
import { GraphState, type WorkflowNode } from "./state.js";
import { AGENTS_WAIT_TOOL_ID, ASK_USER_TOOL_ID } from "./waits.js";

/** Minimal structural view of a compiled graph; avoids naming LangGraph's internals. */
interface InvokableGraph {
  invoke(input: unknown, config: RunnableConfig): Promise<unknown>;
}

export async function invokeGraph(graph: InvokableGraph, input: unknown, config: RunnableConfig): Promise<unknown> {
  // Each admitted task owns an independent checkpoint namespace. A worker
  // admitted from a tool must not inherit LangGraph's ambient parent-node
  // configuration, which treats its approval interrupt as a subgraph interrupt.
  return AsyncLocalStorageProviderSingleton.runWithConfig({}, () => graph.invoke(input, config), true);
}

/** The saver's most recent checkpoint for a thread, if any. */
export async function latestCheckpointOf(saver: BaseCheckpointSaver, threadId: string): Promise<CheckpointDescriptor | undefined> {
  return (await listCheckpoints(saver, threadId, 1))[0];
}

export async function listCheckpoints(
  saver: BaseCheckpointSaver,
  threadId: string,
  limit: number,
): Promise<readonly CheckpointDescriptor[]> {
  const rows: CheckpointDescriptor[] = [];
  for await (const row of saver.list({ configurable: { thread_id: threadId } }, { limit })) {
    rows.push({
      threadId,
      checkpointId: String(row.config.configurable?.["checkpoint_id"]),
      checkpointNamespace: String(row.config.configurable?.["checkpoint_ns"] ?? ""),
      parentCheckpointId: row.parentConfig?.configurable?.["checkpoint_id"] ?? null,
      createdAt: readCreatedAt(row.metadata),
    });
  }
  return rows;
}

/** Checkpoint metadata carries `created_at` in older saver versions. */
function readCreatedAt(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const value = (metadata as { created_at?: unknown }).created_at;
  return typeof value === "string" ? value : null;
}

/** The task graph: model, approve, tools, review and finalize, and the edges between them. */
export function buildWorkflowGraph(
  nodes: {
    readonly modelNode: WorkflowNode;
    readonly approveNode: WorkflowNode;
    readonly toolsNode: WorkflowNode;
    readonly reviewNode: WorkflowNode;
    readonly finalizeNode: WorkflowNode;
  },
  saver: BaseCheckpointSaver,
) {
  const { modelNode, approveNode, toolsNode, reviewNode, finalizeNode } = nodes;
  const graphBuilder = new StateGraph(GraphState)
    .addNode("model", modelNode)
    .addNode("approve", approveNode)
    .addNode("tools", toolsNode)
    .addNode("review", reviewNode)
    .addNode("finalize", finalizeNode)
    .addEdge(START, "model")
    .addConditionalEdges("model", (state) => {
      const parsed = AgentStateDataSchema.safeParse(state);
      const pending = parsed.success ? parsed.data.pendingToolCalls.length : 0;
      const phase = parsed.success ? parsed.data.phase : "failed";
      if (phase === "failed") return "finalize";
      if (pending === 0) return "finalize";
      // A generation mixing `agents.wait` with another call must never
      // reach `approveNode`: if the other call also needs approval,
      // routing through `approve` first would ask an operator to
      // authorize an effect that `toolsNode`'s sole-pending-call guard
      // then unconditionally discards — a real approval wasted on a call
      // that was never going to run. Routing straight to `tools` instead
      // lets that same guard produce the corrective retry before any
      // approval is ever requested (the guard alone, without this
      // routing change, would only protect the read-only-tool case).
      if (parsed.success && pending > 1) {
        const names = parsed.data.pendingToolCalls.map((raw) => CallSchema.parse(raw).name);
        if (names.some((name) => name === AGENTS_WAIT_TOOL_ID || name === ASK_USER_TOOL_ID)) return "tools";
      }
      return "approve";
    })
    .addEdge("approve", "tools")
    .addEdge("tools", "review")
    .addEdge("review", "model")
    .addEdge("finalize", END);

  // The compiled graph type is an implementation detail of this factory.
  const compiled = graphBuilder.compile({ checkpointer: saver });
  return compiled;
}

export type CompiledWorkflowGraph = ReturnType<typeof buildWorkflowGraph>;
/** A thread's checkpointed state as `getState` answers it. */
export type WorkflowThreadState = Awaited<ReturnType<CompiledWorkflowGraph["getState"]>>;
