import { TaviError, type RouterProvider } from "@tavi/contracts";

/** One in-flight use of a bound provider. Its signal fires when the provider is unbound. */
export interface RouterProviderLease {
  readonly provider: RouterProvider;
  readonly signal: AbortSignal;
  release(): void;
}

interface Binding {
  readonly provider: RouterProvider;
  readonly version: string | undefined;
  readonly leases: Set<{ readonly controller: AbortController; readonly done: Promise<void> }>;
}

/**
 * The routing providers that are running, by plugin id. A provider plugin binds
 * itself when it starts and unbinds when it stops; unbinding aborts and drains
 * that provider's in-flight decisions. Holds no I/O of its own.
 */
export class RouterProviderSlot {
  readonly #bindings = new Map<string, Binding>();

  /** Returns the unbind function. Binding an id twice is refused. `version` is the plugin version that was loaded. */
  bind(id: string, provider: RouterProvider, version?: string): () => Promise<void> {
    if (this.#bindings.has(id)) throw new TaviError("CONFLICT", `Router provider ${id} is already bound`);
    const binding: Binding = { provider, version, leases: new Set() };
    this.#bindings.set(id, binding);
    return async () => {
      await this.#release(id, binding);
    };
  }

  /** Unbinds whatever is bound under `id`, draining its decisions; false when nothing was bound. */
  async unbind(id: string): Promise<boolean> {
    const binding = this.#bindings.get(id);
    if (binding === undefined) return false;
    await this.#release(id, binding);
    return true;
  }

  async #release(id: string, binding: Binding): Promise<void> {
    if (this.#bindings.get(id) !== binding) return;
    this.#bindings.delete(id);
    for (const lease of binding.leases) lease.controller.abort();
    await Promise.allSettled([...binding.leases].map((lease) => lease.done));
  }

  get(id: string): RouterProvider | undefined {
    return this.#bindings.get(id)?.provider;
  }

  /** Whether `id` is bound, and the plugin version it was loaded from (none for a built-in). */
  bound(id: string): { readonly version: string | undefined } | undefined {
    const binding = this.#bindings.get(id);
    return binding === undefined ? undefined : { version: binding.version };
  }

  /** A lease for one decision, or undefined when the provider is not bound. */
  acquire(id: string): RouterProviderLease | undefined {
    const binding = this.#bindings.get(id);
    if (binding === undefined) return undefined;
    const controller = new AbortController();
    let resolve: () => void = () => {};
    const entry = {
      controller,
      done: new Promise<void>((done) => {
        resolve = done;
      }),
    };
    binding.leases.add(entry);
    return {
      provider: binding.provider,
      signal: controller.signal,
      release: () => {
        binding.leases.delete(entry);
        resolve();
      },
    };
  }
}
