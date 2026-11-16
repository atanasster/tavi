import type { ServiceToken } from "./services.js";

/**
 * Plugin definition and lifecycle contracts.
 *
 * These live in `contracts` so a plugin can be typed without importing the
 * plugin-host implementation, as service tokens, dependency interfaces and
 * lifecycle scope interfaces do.
 */

/**
 * Resource scope handed to a plugin at startup. Cleanup is registered as each
 * resource is acquired so a partial startup failure can unwind it in reverse
 * acquisition order (responsibility 3).
 */
export interface ResourceScope {
  /** Aborted when the owning plugin is stopped or its runtime is going down. */
  readonly signal: AbortSignal;
  /** Register a disposer. Disposers run once, newest first. */
  defer(disposer: (() => void | Promise<void>) | { dispose(): void | Promise<void> }): void;
  /** Nominal marker: this scope came from the plugin host. */
  readonly ownedByPluginHost: true;
}

/**
 * Resolved dependencies. `get` throws when a required dependency was not
 * provided; every declared dependency is validated before startup, so a
 * successful start implies every `get` succeeds.
 */
export interface DependencyBag {
  get<T>(token: ServiceToken<T>): T;
  /** Present only for optional dependencies. */
  tryGet<T>(token: ServiceToken<T>): T | undefined;
}

/** What a plugin receives at startup. */
export interface PluginStartContext {
  readonly pluginId: string;
  readonly dependencies: DependencyBag;
  readonly scope: ResourceScope;
  readonly signal: AbortSignal;
  /** Best-effort attribution for logs; never a credential. */
  readonly buildId: string;
}

/**
 * Services a plugin publishes, keyed by the token id it declared in `provides`.
 *
 * Returning them from `start` (rather than registering them imperatively) is
 * what lets the host publish a service only after a successful startup and
 * unwind cleanly on failure.
 */
export type PluginExports = Readonly<Record<string, unknown>>;

export interface PluginDefinition {
  readonly id: string;
  readonly version: string;
  /** Services this plugin provides. Duplicate providers are rejected. */
  readonly provides: readonly ServiceToken<unknown>[];
  /** Services this plugin requires. Missing dependencies are rejected before startup. */
  readonly requires: readonly ServiceToken<unknown>[];
  /** Optional dependencies; absence is legal and surfaced as `undefined`. */
  readonly optional?: readonly ServiceToken<unknown>[];
  /**
   * Start the plugin and return the services it provides. Must register every
   * acquired resource through `context.scope.defer` before returning.
   */
  start(context: PluginStartContext): PluginExports | Promise<PluginExports>;
}
