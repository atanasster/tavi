import {
  TaviError,
  ProviderSelectionSchema,
  type InvocationContext,
  type ProviderOperation,
  type ProviderOperationEnvelope,
  type ProviderSelection,
} from "@tavi/contracts";
import { providerRevision, type ResolvedProvider } from "./plugin-host/provider-bindings.js";
import { recordedProviderCall, type ProviderExecutionOptions } from "./provider-execution.js";

export interface ProviderCandidate<P> {
  readonly id: string;
  readonly resolved: ResolvedProvider<P>;
}

/** Operator selection is resolved before authorization; fallback cannot enlarge it. */
export function providerDispatcher<P>(options: {
  readonly execution: ProviderExecutionOptions;
  readonly candidates: (context: InvocationContext) => Promise<readonly ProviderCandidate<P>[]>;
  readonly selection?: (context: InvocationContext) => ProviderSelection | undefined;
}) {
  const resolve = async (context: InvocationContext) => {
    const candidates = await options.candidates(context);
    if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length)
      throw new TaviError("CONFLICT", "Provider IDs are ambiguous");
    const configured = options.selection?.(context);
    const selection = configured === undefined ? undefined : ProviderSelectionSchema.parse(configured);
    if (selection === undefined && candidates.length > 1)
      throw new TaviError("NOT_CONFIGURED", "Select a provider or an explicit fallback chain in web-providers.json");
    const ids = selection?.providers ?? candidates.map((candidate) => candidate.id);
    if (ids.length === 0) throw new TaviError("UNAVAILABLE", "No enabled provider is available");
    const chain = ids.map((id) => {
      const candidate = candidates.find((candidate) => candidate.id === id);
      if (candidate === undefined) throw new TaviError("UNAVAILABLE", `Selected provider ${id} is unavailable`);
      return candidate;
    });
    const first = chain[0];
    if (first === undefined) throw new TaviError("UNAVAILABLE", "Provider chain is empty");
    const timeoutMs = selection?.timeoutMs ?? 10_000;
    const binding = {
      ...first.resolved.binding,
      configRevision: providerRevision({ providers: chain.map((item) => ({ id: item.id, binding: item.resolved.binding })), timeoutMs }),
    };
    return { binding, bindingHash: providerRevision(binding), chain, timeoutMs };
  };
  return {
    resolve,
    async dispatch<R>(input: {
      readonly context: InvocationContext;
      readonly signal: AbortSignal;
      readonly expectedBindingHash: string;
      readonly envelope?: ProviderOperationEnvelope;
      readonly reserve?: (operation: ProviderOperation) => Promise<void>;
      readonly invoke: (provider: P, signal: AbortSignal) => Promise<R>;
    }): Promise<{ provider: string; result: R }> {
      const selected = await resolve(input.context);
      if (selected.bindingHash !== input.expectedBindingHash)
        throw new TaviError("NOT_AUTHORIZED", "Provider selection changed since authorization");
      const deadline = AbortSignal.timeout(selected.timeoutMs);
      const signal = AbortSignal.any([input.signal, deadline]);
      const failures: string[] = [];
      for (const candidate of selected.chain) {
        try {
          const result = await withProviderSignal(
            recordedProviderCall(options.execution, {
              resolved: {
                ...candidate.resolved,
                validate: async () => {
                  await candidate.resolved.validate?.();
                  if ((await resolve(input.context)).bindingHash !== input.expectedBindingHash)
                    throw new TaviError("NOT_AUTHORIZED", "Provider selection changed before dispatch");
                },
              },
              context: input.context,
              signal,
              expectedBindingHash: candidate.resolved.bindingHash,
              ...(input.envelope === undefined ? {} : { envelope: input.envelope }),
              ...(input.reserve === undefined ? {} : { reserve: input.reserve }),
              invoke: (provider, signal) => withProviderSignal(input.invoke(provider, signal), signal),
            }),
            signal,
          );
          return { provider: candidate.id, result };
        } catch (error) {
          if (input.signal.aborted) throw new TaviError("CANCELLED", "Provider call was cancelled");
          if (deadline.aborted) throw new TaviError("UNAVAILABLE", `Provider chain exceeded ${selected.timeoutMs}ms`);
          if (candidate.resolved.signal.aborted) throw new TaviError("NOT_AUTHORIZED", "Provider was withdrawn");
          const failure = TaviError.from(error);
          if (["NOT_AUTHORIZED", "NOT_CONFIGURED", "CANCELLED", "CONFLICT"].includes(failure.code)) throw failure;
          // The adapter's own reason, so the model can act on it (a malformed query reworded, a limit waited out).
          failures.push(
            error instanceof TaviError
              ? failure.details?.["providerId"] === candidate.id
                ? failure.message
                : `${candidate.id}: ${failure.message}`
              : candidate.id,
          );
        }
      }
      throw new TaviError("UNAVAILABLE", `No selected provider answered (${failures.join("; ")})`);
    },
  };
}

/** Bound an adapter even when its implementation ignores cancellation. */
export async function withProviderSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}
