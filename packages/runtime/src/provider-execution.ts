import {
  ProviderBindingSchema,
  TaviError,
  type InvocationContext,
  type ProviderBinding,
  type ProviderOperation,
  type ProviderOperationEnvelope,
  type ProviderOperationsPort,
} from "@tavi/contracts";
import { prefixedId } from "@tavi/node-kit";
import { executeProvider, providerRevision, type ResolvedProvider } from "./plugin-host/provider-bindings.js";

export interface ProviderExecutionOptions {
  readonly implementationHash: string;
  readonly ownerSession: string;
  readonly ledger: ProviderOperationsPort;
  readonly signal: AbortSignal;
  /** Whether the principal acts in the workspace (its own, or a person allowed there), and so may use its accounts. */
  readonly actsIn: (workspaceId: string, principalId: string) => boolean;
}

export function scopedProvider<Provider>(
  options: ProviderExecutionOptions,
  context: InvocationContext,
  identity: Omit<ProviderBinding, "workspaceId" | "principalId" | "implementationHash">,
  provider: Provider,
): ResolvedProvider<Provider> {
  options.signal.throwIfAborted();
  if (!options.actsIn(context.workspaceId, context.principalId))
    throw new TaviError("NOT_AUTHORIZED", "Provider account belongs to another workspace or principal");
  const binding = Object.freeze(
    ProviderBindingSchema.parse({
      ...identity,
      workspaceId: context.workspaceId,
      principalId: context.principalId,
      implementationHash: options.implementationHash,
    }),
  );
  return {
    binding,
    bindingHash: providerRevision(binding),
    signal: options.signal,
    get: () => {
      options.signal.throwIfAborted();
      return provider;
    },
  };
}

export async function recordedProviderCall<Provider, Result>(
  options: ProviderExecutionOptions,
  input: {
    readonly resolved: ResolvedProvider<Provider>;
    readonly context: InvocationContext;
    readonly signal: AbortSignal;
    readonly expectedBindingHash: string;
    readonly envelope?: ProviderOperationEnvelope;
    readonly reserve?: (operation: ProviderOperation) => Promise<void>;
    readonly authorize?: () => Promise<void>;
    readonly invoke: (provider: Provider, signal: AbortSignal) => Promise<Result>;
  },
): Promise<Result> {
  const attemptId = prefixedId("provider");
  let recorded = false;
  let result: Result;
  try {
    result = await executeProvider({
      ...input,
      attemptId,
      purpose: input.resolved.binding.kind,
      authorize: input.authorize ?? (async () => {}),
      reserve: async (operation) => {
        await input.reserve?.(operation);
        await options.ledger.reserveOperation(operation, options.ownerSession);
        recorded = true;
      },
    });
  } catch (error) {
    if (recorded) await options.ledger.finishOperation(input.context.runId, attemptId, "uncertain");
    throw error;
  }
  await options.ledger.finishOperation(input.context.runId, attemptId, "completed");
  return result;
}
