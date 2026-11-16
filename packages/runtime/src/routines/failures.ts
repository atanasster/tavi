import {
  EXECUTION_BUSY,
  TaviError,
  modelOutcomeObservation,
  noteProviderObservation,
  providerFailureOf,
  thrownProviderObservation,
  type ModelPort,
  type ProviderFailureClass,
  type ProviderObservation,
  type RoutineFence,
  type RoutineRun,
  type ToolRegistryPort,
} from "@tavi/contracts";

/**
 * How a routine attempt that threw is settled.
 *
 * - `cancel`: the run was cancelled.
 * - `interrupt`: nothing is wrong with the routine — the owner is shutting down,
 *   or the execution slot was busy — so the run is left `interrupted` for the
 *   next drain (or the next start) to resume, and no research failure is counted.
 * - `transient`: a provider failed transiently, or an attempt that followed one
 *   ran out of budget. The run is interrupted for a bounded retry with its cut
 *   short step excused, and no research failure is counted unless the retries
 *   run out (`RoutineExecutionService.interrupt`).
 * - `credentials`: a model or tool could not authenticate; the routine becomes
 *   `credential-blocked` and its credential grace applies instead of the
 *   failure threshold.
 * - `unsupported` / `failed`: a real failure, counted toward the auto-pause.
 */
export type RoutineFailureSettlement = "cancel" | "interrupt" | "transient" | "credentials" | "unsupported" | "failed";

/**
 * What the providers underneath one attempt reported, by role.
 *
 * The research worker and the synthesis root each hide their provider's error
 * behind a generic failed outcome — the worker's behind the root's spawn tool —
 * so the classification is observed where the provider answers, keyed by the
 * attempt's fence (the object the drain hands down to the model and tool ports).
 * How an observation is classified, and how they add up, is shared with the
 * schedules (`provider-failures.ts` in `@tavi/contracts`).
 */
const observed = new WeakMap<RoutineFence, Map<string, ProviderFailureClass>>();

function observe(fence: RoutineFence, role: string, value: ProviderObservation | undefined): void {
  if (value === undefined) return;
  let roles = observed.get(fence);
  if (roles === undefined) {
    roles = new Map();
    observed.set(fence, roles);
  }
  noteProviderObservation(roles, role, value);
}

/**
 * Observe the provider-facing model port one routine role calls.
 *
 * Wraps the adapter *beneath* the routine's own grant checks, so a refusal the
 * routine makes (a changed binding, a revoked grant) is never mistaken for a
 * credential problem.
 */
export function observeRoutineModels(models: ModelPort, fence: RoutineFence, role: "research" | "synthesis"): ModelPort {
  return {
    ...(models.resolveBinding === undefined
      ? {}
      : {
          resolveBinding: async (request, context) => {
            try {
              return await models.resolveBinding!(request, context);
            } catch (error) {
              observe(fence, role, thrownProviderObservation(error));
              throw error;
            }
          },
        }),
    async stream(request, options) {
      let outcome;
      try {
        outcome = await models.stream(request, options);
      } catch (error) {
        observe(fence, role, thrownProviderObservation(error));
        throw error;
      }
      observe(fence, role, modelOutcomeObservation(outcome));
      return outcome;
    },
  };
}

/**
 * Observe the research tools beneath the routine's own grant checks.
 *
 * Only a missing configuration from the tool itself, or a refusal from its
 * credential resolution, is a credential problem: a tool's own `NOT_AUTHORIZED`
 * from its handler is as often an egress refusal as a key.
 */
export function observeRoutineTools(tools: ToolRegistryPort, fence: RoutineFence): ToolRegistryPort {
  return new Proxy(tools, {
    get(target, property) {
      if (property !== "get") {
        // Bound to the registry itself: its methods may read private state.
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      return (id: string) => {
        const tool = target.get(id);
        if (tool === undefined) return undefined;
        const resolveBinding = tool.resolveBinding;
        return {
          ...tool,
          ...(resolveBinding === undefined
            ? {}
            : {
                resolveBinding: async (input: unknown, context: Parameters<typeof resolveBinding>[1]) => {
                  try {
                    return await resolveBinding(input, context);
                  } catch (error) {
                    observe(fence, "research", thrownProviderObservation(error));
                    throw error;
                  }
                },
              }),
          handler: async (call: Parameters<typeof tool.handler>[0]) => {
            try {
              return await tool.handler(call);
            } catch (error) {
              if (error instanceof TaviError && error.code === "NOT_CONFIGURED") observe(fence, "research", "credentials");
              throw error;
            }
          },
        };
      };
    },
  });
}

/**
 * Decide how the drain settles an attempt whose dispatch threw. `run` is the run
 * as it stands after the throw: its budget mark says whether this attempt ran out.
 */
export function routineFailureSettlement(
  error: unknown,
  fence: RoutineFence,
  stopping: boolean,
  run?: Pick<RoutineRun, "data">,
): RoutineFailureSettlement {
  if (error instanceof TaviError && error.code === "CANCELLED") return "cancel";
  // A shutdown aborts providers and stops background work under a running
  // attempt; whatever that makes it throw is the shutdown, not the routine.
  if (stopping || (error instanceof TaviError && error.details?.["reason"] === EXECUTION_BUSY)) return "interrupt";
  if (error instanceof TaviError && error.code === "UNSUPPORTED") return "unsupported";
  const provider = providerFailureOf(observed.get(fence));
  if (provider !== undefined) return provider;
  // The budget a retried run has left is what its excused attempts did not give
  // back; running out of it is the transient failure's doing, not the routine's.
  if (run !== undefined && run.data.budgetExhausted === fence.generation && (run.data.transientRetries ?? 0) > 0) return "transient";
  return "failed";
}
