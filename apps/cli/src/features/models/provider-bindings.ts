import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProviderBindingSchema, TaviError, type InvocationContext, type ModelConnection, type ModelPort } from "@tavi/contracts";
import { providerRevision, type ResolvedProvider } from "@tavi/runtime";
import { providerConnectionOf, type ProviderConnection } from "@tavi/agent-host/models";

/** Includes the adapter bundle and its local chunks, even with an unchanged package version. */
export function builtinImplementationHash(entry: string): string {
  const directory = dirname(entry);
  const hash = createHash("sha256");
  for (const name of readdirSync(directory)
    .filter((name) => /\.(?:mjs|cjs|js|ts|json)$/.test(name))
    .sort()) {
    hash
      .update(name)
      .update("\0")
      .update(readFileSync(join(directory, name)))
      .update("\0");
  }
  return hash.digest("hex");
}

export function builtinModelResolver(options: {
  readonly models: ModelPort;
  /** `models` sending on exactly one connection: what a resolved binding dispatches through, when the adapter can. */
  readonly pin?: (connection: ProviderConnection) => ModelPort;
  readonly implementationHash: string;
  readonly signal: AbortSignal;
  /** Whether the principal acts in the workspace (its own, or a person allowed there), and so may use its accounts. */
  readonly actsIn: (workspaceId: string, principalId: string) => boolean;
  /** A connection as configured now: what a call binds to, and must still be at dispatch. */
  readonly current: (connectionId: string) => Promise<ProviderConnection | undefined>;
  /** Revision of the secret currently stored under a reference; a replaced secret is a new binding. */
  readonly credentialRevision: (reference: string) => Promise<string>;
}) {
  return async (request: { connectionId: string; model: string }, context: InvocationContext): Promise<ResolvedProvider<ModelPort>> => {
    options.signal.throwIfAborted();
    if (!options.actsIn(context.workspaceId, context.principalId))
      throw new TaviError("NOT_AUTHORIZED", "Model account belongs to another workspace or principal");
    const current = await options.current(request.connectionId);
    if (current === undefined) throw new TaviError("UNAVAILABLE", "Model connection is not active");
    const connection = structuredClone(current);
    const credentialRevision = await options.credentialRevision(connection.credentialRef);
    const binding = Object.freeze(
      ProviderBindingSchema.parse({
        kind: "model",
        instanceId: `builtin:${connection.connectionId}`,
        workspaceId: context.workspaceId,
        principalId: context.principalId,
        accountId: connection.credentialRef,
        implementationHash: options.implementationHash,
        configRevision: providerRevision({ connection, credentialRevision }),
        endpoint: connection.baseUrl,
      }),
    );
    return {
      binding,
      bindingHash: providerRevision(binding),
      signal: options.signal,
      validate: async () => {
        const latest = await options.current(connection.connectionId);
        if (
          latest === undefined ||
          providerRevision(latest) !== providerRevision(connection) ||
          (await options.credentialRevision(connection.credentialRef)) !== credentialRevision
        )
          throw new TaviError("NOT_AUTHORIZED", "Model binding changed before dispatch");
      },
      get: () => {
        options.signal.throwIfAborted();
        return options.pin?.(connection) ?? options.models;
      },
    };
  };
}

/**
 * A builtin connection as configured now, read at each call so one added or
 * changed while the owner runs is served without a restart: the
 * store's — with the headers the launcher added to it, while it still points
 * where it did — else one the owner was launched with that the store never
 * held. One the store held at startup and no longer does is removed, and a
 * provider-managed connection is not a builtin one.
 */
export function liveProviderConnection(options: {
  readonly launched: readonly ProviderConnection[];
  /** The ids the store held when the owner started. */
  readonly storedAtStartup: ReadonlySet<string>;
  readonly stored: (connectionId: string) => Promise<ModelConnection | undefined>;
}): (connectionId: string) => Promise<ProviderConnection | undefined> {
  return async (connectionId) => {
    const launched = options.launched.find((connection) => connection.connectionId === connectionId);
    const stored = await options.stored(connectionId);
    if (stored === undefined) return options.storedAtStartup.has(connectionId) ? undefined : launched;
    if (stored.providerBinding !== undefined) return undefined;
    const sameEndpoint = launched !== undefined && launched.baseUrl === stored.baseUrl && launched.credentialRef === stored.credentialRef;
    const headers = sameEndpoint && launched.headers !== undefined ? { ...launched.headers, ...stored.headers } : stored.headers;
    return { ...providerConnectionOf(stored), ...(headers === undefined ? {} : { headers }) };
  };
}
