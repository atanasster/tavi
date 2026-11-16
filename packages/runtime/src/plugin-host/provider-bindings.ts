import {
  ProviderBindingSchema,
  ProviderOperationSchema,
  TaviError,
  type InvocationContext,
  type ProviderBinding,
  type ProviderOperation,
  type ProviderOperationEnvelope,
  type ResourceScope,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import type { ProviderInstance } from "./provider-factories.js";

/** Stable digest over JSON settings/identity; raw credentials must never be an input. */
export function providerRevision(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return input;
  };
  const encoded = JSON.stringify(canonical(value));
  if (encoded === undefined) throw new TaviError("INVALID_INPUT", "Provider revision requires JSON data");
  return sha256Hex(encoded);
}

export interface ResolvedProvider<Provider> {
  readonly binding: ProviderBinding;
  readonly bindingHash: string;
  readonly signal: AbortSignal;
  readonly validate?: () => Promise<void>;
  /** Only host dispatch may unwrap after authorization and reservation. */
  get(): Provider;
}

export class ProviderBindings<Provider> {
  readonly #bindings = new Map<string, ResolvedProvider<Provider>>();

  register(binding: ProviderBinding, instance: ProviderInstance<Provider>, owner: ResourceScope): void {
    const parsed = Object.freeze(ProviderBindingSchema.parse(binding));
    owner.signal.throwIfAborted();
    instance.signal.throwIfAborted();
    if (this.#bindings.has(parsed.instanceId)) throw new TaviError("CONFLICT", `Provider instance ${parsed.instanceId} is already bound`);
    const signal = AbortSignal.any([owner.signal, instance.signal]);
    const resolved = {
      binding: parsed,
      bindingHash: providerRevision(parsed),
      signal,
      get: () => {
        signal.throwIfAborted();
        return instance.get();
      },
    };
    owner.defer(() => {
      if (this.#bindings.get(parsed.instanceId) === resolved) this.#bindings.delete(parsed.instanceId);
    });
    this.#bindings.set(parsed.instanceId, resolved);
  }

  resolve(context: Pick<InvocationContext, "workspaceId" | "principalId">, instanceId: string): ResolvedProvider<Provider> {
    const resolved = this.#bindings.get(instanceId);
    if (resolved === undefined || resolved.signal.aborted)
      throw new TaviError("UNAVAILABLE", `Provider instance ${instanceId} is unavailable`);
    if (resolved.binding.workspaceId !== context.workspaceId || resolved.binding.principalId !== context.principalId)
      throw new TaviError("NOT_AUTHORIZED", "Provider account belongs to another workspace or principal");
    return resolved;
  }
}

/** Rechecks a frozen binding after each awaited authority/budget boundary. */
export async function executeProvider<Provider, Result>(input: {
  readonly resolved: ResolvedProvider<Provider>;
  readonly context: InvocationContext;
  readonly attemptId: string;
  readonly purpose: string;
  readonly envelope?: ProviderOperationEnvelope;
  readonly signal: AbortSignal;
  readonly expectedBindingHash: string;
  readonly authorize: (operation: ProviderOperation) => Promise<void>;
  readonly reserve: (operation: ProviderOperation) => Promise<void>;
  readonly invoke: (provider: Provider, signal: AbortSignal, operation: ProviderOperation) => Promise<Result>;
}): Promise<Result> {
  const { resolved, context } = input;
  const check = async () => {
    await resolved.validate?.();
    input.signal.throwIfAborted();
    resolved.signal.throwIfAborted();
    if (
      resolved.binding.workspaceId !== context.workspaceId ||
      resolved.binding.principalId !== context.principalId ||
      resolved.bindingHash !== input.expectedBindingHash ||
      resolved.bindingHash !== providerRevision(resolved.binding)
    )
      throw new TaviError("NOT_AUTHORIZED", "Provider binding no longer matches its authorization");
  };
  await check();
  const operation = providerOperation(resolved, context, input.attemptId, input.purpose, input.envelope);
  await input.authorize(operation);
  await check();
  await input.reserve(operation);
  await check();
  return input.invoke(resolved.get(), AbortSignal.any([input.signal, resolved.signal]), operation);
}

export function providerOperation(
  resolved: Pick<ResolvedProvider<unknown>, "binding" | "bindingHash">,
  context: InvocationContext,
  attemptId: string,
  purpose: string,
  envelope: ProviderOperationEnvelope = {},
): ProviderOperation {
  return ProviderOperationSchema.parse({
    ...envelope,
    version: 1,
    binding: resolved.binding,
    bindingHash: resolved.bindingHash,
    runId: context.runId,
    attemptId,
    purpose,
    caller: context.caller,
  });
}
