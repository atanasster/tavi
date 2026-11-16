import { type ContentLabel, type CheckpointDescriptor, type InvocationContext, TaviError, type WorkflowMessage } from "@tavi/contracts";
import { createAdmit, createOpenHome } from "./admission.js";
import { isEpochSummaryMessage } from "./epoch.js";
import { latestCheckpointOf, listCheckpoints, buildWorkflowGraph, type CompiledWorkflowGraph } from "./graph.js";
import { createRunInvocation } from "./invocation.js";
import { knownUrlSetOf } from "./known-urls.js";
import { createApproveNode } from "./nodes/approve.js";
import { createModelNode } from "./nodes/model.js";
import { createReviewNode, createFinalizeNode } from "./nodes/review.js";
import { createToolsNode } from "./nodes/tools.js";
import type { WorkflowAdapterOptions } from "./options.js";
import { createWorkflowScope } from "./scope.js";
import { GraphState } from "./state.js";
import { createTurnSupport } from "./turns.js";

/**
 * The adapter satisfies the published port. The annotation is what keeps the
 * factory's inferred shape from drifting away from the contract.
 */
export type WorkflowAdapter = ReturnType<typeof createWorkflowAdapter>;

export function createWorkflowAdapter(options: WorkflowAdapterOptions) {
  // `workerModelUrls` reads the compiled graph's state, and the graph is compiled from the nodes built on that scope.
  let graph: CompiledWorkflowGraph | undefined;
  const scope = createWorkflowScope(options, {
    getState: (...args) => {
      if (graph === undefined) throw new TaviError("INTERNAL", "the workflow graph was read before it was compiled");
      return graph.getState(...args);
    },
  });
  const compiled = buildWorkflowGraph(
    {
      modelNode: createModelNode(scope),
      approveNode: createApproveNode(scope),
      toolsNode: createToolsNode(scope),
      reviewNode: createReviewNode(scope),
      finalizeNode: createFinalizeNode(scope),
    },
    scope.saver,
  );
  graph = compiled;
  const run = { ...scope, compiled };
  const runInvocation = createRunInvocation(run);
  const admit = createAdmit({ ...run, ...createTurnSupport(run), runInvocation });
  const { saver, contextLabelOf, previousLabelState, originOf } = scope;

  return {
    graphStateSchema: GraphState,

    admit,

    openHome: createOpenHome(scope),

    checkpoints: {
      listCheckpoints(threadId: string, limit: number): Promise<readonly CheckpointDescriptor[]> {
        return listCheckpoints(saver, threadId, limit);
      },
      latest(threadId: string): Promise<CheckpointDescriptor | undefined> {
        return latestCheckpointOf(saver, threadId);
      },
      async latestEpochSummary(threadId: string): Promise<string | undefined> {
        // A failed read is the caller's to report: it is not "never rolled over".
        const state = await compiled.getState({ configurable: { thread_id: threadId } });
        const conversation = (state.values as { readonly conversation?: readonly WorkflowMessage[] } | undefined)?.conversation ?? [];
        return conversation.findLast(isEpochSummaryMessage)?.text;
      },
      async contextLabel(threadId: string): Promise<ContentLabel | undefined> {
        // As the gate read it last (`contextLabelOf`): the sticky channel and what the conversation holds.
        const state = await compiled.getState({ configurable: { thread_id: threadId } });
        const values = state.values as { readonly conversation?: readonly WorkflowMessage[] } | undefined;
        if (values?.conversation === undefined) return undefined;
        return contextLabelOf(previousLabelState(values, values.conversation));
      },
      async knownUrls(threadId: string): Promise<ReadonlySet<string> | undefined> {
        // As a reply's disarm reads them (`replyDisarm`): the channel and the person's messages, never the system text.
        const state = await compiled.getState({ configurable: { thread_id: threadId } });
        const values = state.values as
          | {
              readonly conversation?: readonly WorkflowMessage[];
              readonly knownUrls?: readonly string[];
              readonly invocation?: InvocationContext;
            }
          | undefined;
        if (values?.conversation === undefined) return undefined;
        const origin = values.invocation === undefined ? undefined : await originOf(values.invocation.runId);
        return knownUrlSetOf(values.knownUrls ?? [], values.conversation, "", origin);
      },
    },
  };
}
