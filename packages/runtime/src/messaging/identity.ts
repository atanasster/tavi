import type { MemoryActor, MessagingIdentityBinding, MessagingIdentityBindingRepositoryPort } from "@tavi/contracts";

/**
 * Resolves `InboundEvent.externalSenderId` to a real application
 * `MemoryActor`, or denies by absence for an unbound/unknown/forged
 * sender — never a guess. `MemoryActor`'s own header
 * comment states the rule this function exists to enforce: "a Telegram id
 * or an email address is never an application principal."
 *
 * Denial is `undefined`, not a distinguishable error: the same "existence
 * itself is information" precedent `MemoryService.get` already follows
 * for an unauthorized record — a forged sender and an
 * honestly-unbound one are indistinguishable to the caller.
 */
export async function resolveSenderActor(
  bindings: MessagingIdentityBindingRepositoryPort,
  connectionId: string,
  externalSenderId: string,
): Promise<MemoryActor | undefined> {
  const binding = await bindings.get(connectionId, externalSenderId);
  return senderActorFromBinding(binding, connectionId);
}

export function senderActorFromBinding(binding: MessagingIdentityBinding | undefined, connectionId: string): MemoryActor | undefined {
  if (binding === undefined) return undefined;
  return {
    principalId: binding.principalId,
    workspaceId: binding.workspaceId,
    caller: `messaging:${connectionId}`,
    // A resolved external sender is a real, explicitly-bound human acting
    // through a channel — not a model. `authority: "model"` is reserved
    // for automatic, model-driven memory calls (the propose/approve
    // split); nothing about resolving an identity binding is that.
    authority: "operator",
  };
}
