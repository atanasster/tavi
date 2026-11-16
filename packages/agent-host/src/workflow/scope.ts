import type { CompiledWorkflowGraph } from "./graph.js";
import type { WorkflowAdapterOptions } from "./options.js";
import { createCoreScope } from "./scope/core.js";
import { createGateScope } from "./scope/gate.js";
import { createHookScope } from "./scope/hooks.js";
import { createLabelScope } from "./scope/labels.js";
import { createOfferScope } from "./scope/offer.js";

/** What every node and the admission share: the adapter's options and the helpers built on them, one set per adapter. */
export function createWorkflowScope(options: WorkflowAdapterOptions, compiled: Pick<CompiledWorkflowGraph, "getState">) {
  return createGateScope(createOfferScope(createHookScope(createCoreScope(createLabelScope(options), compiled))));
}

export type WorkflowScope = ReturnType<typeof createWorkflowScope>;
