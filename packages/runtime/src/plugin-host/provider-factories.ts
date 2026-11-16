import type { ObserveFetch, ProviderFactories, ProviderFactory, ResourceScope } from "@tavi/contracts/plugin-sdk";
import { OwnedResourceScope, disposeWithDeadline } from "./resources.js";

export interface ProviderInstanceInput {
  readonly instanceId: string;
  readonly settings: unknown;
  readonly credentials: Readonly<Record<string, string>>;
  readonly readSecret: (reference: string) => Promise<string | null>;
  readonly owner: ResourceScope;
  readonly observeFetch?: ObserveFetch;
}

export interface ProviderInstance<Provider> {
  readonly instanceId: string;
  readonly signal: AbortSignal;
  /** Refuses retained handles after withdrawal. Dispatch must also use signal. */
  get(): Provider;
}

/** Application composition only; consumers use the authorized dispatcher. */
export class ProviderFactoryRegistry<Provider> implements ProviderFactories<Provider> {
  readonly #factories = new Map<string, (input: ProviderInstanceInput) => Promise<ProviderInstance<Provider>>>();

  register<Settings>(id: string, factory: ProviderFactory<Provider, Settings>, owner: ResourceScope): void {
    owner.signal.throwIfAborted();
    if (this.#factories.has(id)) throw new Error(`Provider factory ${id} is already registered`);
    const create = async (input: ProviderInstanceInput): Promise<ProviderInstance<Provider>> => {
      owner.signal.throwIfAborted();
      input.owner.signal.throwIfAborted();
      const settings = factory.settingsSchema.parse(input.settings);
      const credentials = new Map(Object.entries(input.credentials));
      const scope = new OwnedResourceScope();
      const abort = () => scope.abort(new Error(`Provider instance ${input.instanceId} was withdrawn`));
      const close = async () => {
        const result = await disposeWithDeadline(scope, 10_000);
        if (result.timedOut || result.failures.length > 0) {
          throw new AggregateError(
            result.failures.map((failure) => failure.error),
            result.timedOut ? "Provider cleanup timed out" : "Provider cleanup failed",
          );
        }
      };
      owner.signal.addEventListener("abort", abort, { once: true });
      input.owner.signal.addEventListener("abort", abort, { once: true });
      scope.defer(() => {
        owner.signal.removeEventListener("abort", abort);
        input.owner.signal.removeEventListener("abort", abort);
      });
      owner.defer(close);
      if (input.owner !== owner) input.owner.defer(close);
      let rejectAbort: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(scope.signal.reason);
        scope.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      const deadline = setTimeout(() => scope.abort(new Error("Provider construction timed out")), 10_000);
      try {
        const construction = Promise.resolve().then(() => {
          scope.signal.throwIfAborted();
          return factory.create({
            instanceId: input.instanceId,
            settings,
            scope,
            signal: scope.signal,
            ...(input.observeFetch === undefined ? {} : { observeFetch: input.observeFetch }),
            credential: async (name) => {
              scope.signal.throwIfAborted();
              const reference = credentials.get(name);
              if (reference === undefined) throw new Error(`Credential ${name} is not configured for ${input.instanceId}`);
              const value = await input.readSecret(reference);
              scope.signal.throwIfAborted();
              return value;
            },
          });
        });
        const provider = await Promise.race([construction, cancelled]);
        scope.signal.throwIfAborted();
        return {
          instanceId: input.instanceId,
          signal: scope.signal,
          get() {
            scope.signal.throwIfAborted();
            return provider;
          },
        };
      } catch (error) {
        try {
          await close();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "Provider construction and cleanup failed");
        }
        throw error;
      } finally {
        clearTimeout(deadline);
        if (rejectAbort !== undefined) scope.signal.removeEventListener("abort", rejectAbort);
      }
    };
    owner.defer(() => {
      if (this.#factories.get(id) === create) this.#factories.delete(id);
    });
    this.#factories.set(id, create);
  }

  async create(factoryId: string, input: ProviderInstanceInput): Promise<ProviderInstance<Provider>> {
    const create = this.#factories.get(factoryId);
    if (create === undefined) throw new Error(`Provider factory ${factoryId} is unavailable`);
    return create(input);
  }
}
