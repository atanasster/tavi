import {
  PluginIdSchema,
  type DependencyBag,
  type PluginDefinition,
  type PluginPhase,
  type PluginStatus,
  type ServiceToken,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { PluginHostError } from "./errors.js";
import { OwnedResourceScope, disposeWithDeadline, type DisposalOutcome } from "./resources.js";

interface PluginRecord {
  readonly definition: PluginDefinition;
  phase: PluginPhase;
  error?: unknown;
  disposersRun?: number;
  scope: OwnedResourceScope | undefined;
}

export interface PluginHostOptions {
  /** Version of the composition; recorded for diagnostics and restart decisions. */
  readonly buildId: string;
  /** Deadline for cooperative disposal before the caller must terminate the process. */
  readonly shutdownDeadlineMs?: number;
}

export interface ShutdownReport {
  readonly timedOut: boolean;
  readonly failures: readonly { readonly pluginId: string; readonly message: string }[];
  /** True only when every started plugin disposed cleanly inside the deadline. */
  readonly clean: boolean;
}

const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * A small application-owned plugin host.
 *
 * Owns exactly five things: typed composition, dependency ordering, owned
 * cleanup, explicit lifetime and safe shutdown. It deliberately does not own
 * workflow execution, scheduling, permission decisions, storage migrations or
 * UI rendering.
 */
export class PluginHost {
  readonly #records = new Map<string, PluginRecord>();
  readonly #services = new Map<string, { readonly value: unknown; readonly provider: string }>();
  readonly #buildId: string;
  readonly #shutdownDeadlineMs: number;
  #admission = false;
  readonly #disposalOutcomes = new Map<string, DisposalOutcome>();

  constructor(plugins: readonly PluginDefinition[], options: PluginHostOptions) {
    this.#buildId = options.buildId;
    this.#shutdownDeadlineMs = options.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;

    for (const definition of plugins) {
      const parsedId = PluginIdSchema.safeParse(definition.id);
      if (!parsedId.success) {
        throw new PluginHostError(
          "INVALID_INPUT",
          `Invalid plugin id ${JSON.stringify(definition.id)}: plugin ids use dotted lowercase segments`,
        );
      }
      if (this.#records.has(definition.id)) {
        throw new PluginHostError("DUPLICATE_PLUGIN", `Duplicate plugin id ${definition.id}`);
      }
      this.#records.set(definition.id, { definition, phase: "registered", scope: undefined });
    }

    this.#validateComposition();
  }

  /** True only once every required plugin reached `ready` (responsibility 4). */
  get admissionOpen(): boolean {
    return this.#admission;
  }

  /** True while the composition is still in its initial `registered` state. */
  get isPristine(): boolean {
    return [...this.#records.values()].every((record) => record.phase === "registered");
  }

  get buildId(): string {
    return this.#buildId;
  }

  status(): readonly PluginStatus[] {
    return [...this.#records.values()].map((record) => {
      const status: {
        id: string;
        phase: PluginPhase;
        error?: unknown;
        disposersRun?: number;
      } = { id: record.definition.id, phase: record.phase };
      if (record.error !== undefined) status.error = record.error;
      if (record.disposersRun !== undefined) status.disposersRun = record.disposersRun;
      return status;
    });
  }

  phaseOf(pluginId: string): PluginPhase | undefined {
    return this.#records.get(pluginId)?.phase;
  }

  /**
   * Start providers before consumers. A failed start unwinds only what it started.
   *
   * A composition may be started once: restarting is an explicit new process (or
   * a new `PluginHost`), because re-running plugins while their services are
   * published would republish live handles and hide a partial failure.
   */
  async start(): Promise<void> {
    if (!this.isPristine) {
      throw new PluginHostError(
        "STARTUP_FAILED",
        `Composition ${this.#buildId} can only be started once; construct a new PluginHost to recompose`,
      );
    }
    const order = this.#startupOrder();
    const started: string[] = [];

    for (const id of order) {
      const record = this.#records.get(id);
      if (record === undefined) throw new PluginHostError("INTERNAL", `Unknown plugin ${id}`);
      const scope = new OwnedResourceScope();
      record.scope = scope;
      record.phase = "starting";
      let exports: Readonly<Record<string, unknown>>;
      try {
        exports = await record.definition.start({
          pluginId: id,
          dependencies: this.#dependenciesFor(record.definition),
          scope,
          signal: scope.signal,
          buildId: this.#buildId,
        });
        this.#validateExports(record.definition, exports);
      } catch (error) {
        record.phase = "failed";
        record.error = error;
        // Unwind the failed plugin's own partial resources, then the plugins this start created.
        const disposal = await disposeWithDeadline(scope, this.#shutdownDeadlineMs);
        this.#disposalOutcomes.set(id, disposal);
        record.disposersRun = disposal.attempted;
        record.scope = undefined;
        for (const startedId of [...started].reverse()) {
          await this.#stopPlugin(startedId);
        }
        const reason = errorMessage(error);
        throw new PluginHostError("STARTUP_FAILED", `Plugin ${id} failed to start: ${reason}`, {
          pluginId: id,
          cause: reason,
        });
      }

      // Publish services only after successful startup.
      for (const token of record.definition.provides) {
        this.#services.set(token.id, { value: exports[token.id], provider: id });
      }
      record.phase = "ready";
      started.push(id);
    }

    this.#admission = true;
  }

  /** A plugin must return exactly the services it declared. */
  #validateExports(definition: PluginDefinition, exports: Readonly<Record<string, unknown>>): void {
    for (const token of definition.provides) {
      if (!(token.id in exports)) {
        throw new PluginHostError("STARTUP_FAILED", `Plugin ${definition.id} declared service ${token.id} but did not provide it`);
      }
      if (exports[token.id] === undefined || exports[token.id] === null) {
        throw new PluginHostError("STARTUP_FAILED", `Plugin ${definition.id} returned an empty value for service ${token.id}`);
      }
    }
    const declared = new Set(definition.provides.map((token) => token.id));
    for (const key of Object.keys(exports)) {
      if (!declared.has(key)) {
        throw new PluginHostError("STARTUP_FAILED", `Plugin ${definition.id} returned undeclared service ${key}`);
      }
    }
  }

  /**
   * Stop consumers before providers, then dispose under a deadline.
   *
   * The returned report distinguishes clean shutdown from a deadline expiry; a
   * timed-out disposal is reported as unclean, never as success (* responsibility 5).
   */
  async stop(): Promise<ShutdownReport> {
    this.#admission = false;
    const order = [...this.#startupOrder()].reverse();
    const failures: { pluginId: string; message: string }[] = [];
    let timedOut = false;

    for (const id of order) {
      const record = this.#records.get(id);
      if (record === undefined || record.scope === undefined) continue;
      if (record.phase !== "ready" && record.phase !== "failed" && record.phase !== "starting") continue;
      await this.#stopPlugin(id);
    }
    for (const [id, result] of this.#disposalOutcomes) {
      if (result.timedOut) timedOut = true;
      if (result.attempted < result.registered) {
        failures.push({
          pluginId: id,
          message: `only ${result.attempted} of ${result.registered} disposers ran before the deadline`,
        });
      }
      for (const failure of result.failures) {
        failures.push({ pluginId: id, message: failure.message });
      }
    }

    for (const token of [...this.#services.keys()]) this.#services.delete(token);

    return { timedOut, failures, clean: !timedOut && failures.length === 0 };
  }

  async #stopPlugin(id: string): Promise<DisposalOutcome> {
    const record = this.#records.get(id);
    if (record === undefined || record.scope === undefined) {
      return { timedOut: false, failures: [], attempted: 0, registered: 0 };
    }
    record.phase = "stopping";
    // Unpublish before disposal so a stopping plugin is never handed to a caller.
    for (const [tokenId, entry] of [...this.#services.entries()]) {
      if (entry.provider === id) this.#services.delete(tokenId);
    }
    const result = await disposeWithDeadline(record.scope, this.#shutdownDeadlineMs);
    this.#disposalOutcomes.set(id, result);
    record.scope = undefined;
    // The honest count of cleanup that actually ran, not the service count.
    record.disposersRun = result.attempted;
    record.phase = result.timedOut ? "failed" : "stopped";
    if (result.timedOut) {
      record.error = new Error(`disposal exceeded ${this.#shutdownDeadlineMs}ms deadline`);
    }
    return result;
  }

  #dependenciesFor(definition: PluginDefinition): DependencyBag {
    const requested = new Set<string>();
    for (const token of [...definition.requires, ...(definition.optional ?? [])]) {
      requested.add(token.id);
    }
    return {
      get: <T>(token: ServiceToken<T>): T => {
        const entry = this.#services.get(token.id);
        if (entry === undefined) {
          throw new PluginHostError("MISSING_DEPENDENCY", `Plugin ${definition.id} requested unavailable service ${token.id}`);
        }
        return entry.value as T;
      },
      tryGet: <T>(token: ServiceToken<T>): T | undefined => {
        if (!requested.has(token.id)) {
          throw new PluginHostError("MISSING_DEPENDENCY", `Plugin ${definition.id} may not read undeclared service ${token.id}`);
        }
        return this.#services.get(token.id)?.value as T | undefined;
      },
    };
  }

  /** Validate ids, providers, missing dependencies and cycles before any startup. */
  #validateComposition(): void {
    const providedBy = new Map<string, string>();
    for (const record of this.#records.values()) {
      for (const token of record.definition.provides) {
        const existing = providedBy.get(token.id);
        if (existing !== undefined) {
          throw new PluginHostError("DUPLICATE_SERVICE", `Service ${token.id} is provided by both ${existing} and ${record.definition.id}`);
        }
        providedBy.set(token.id, record.definition.id);
      }
    }

    for (const record of this.#records.values()) {
      const seen = new Set<string>();
      for (const token of [...record.definition.requires, ...(record.definition.optional ?? [])]) {
        if (seen.has(token.id)) continue;
        seen.add(token.id);
        if (providedBy.has(token.id)) continue;
        if ((record.definition.optional ?? []).some((t) => t.id === token.id)) continue;
        throw new PluginHostError(
          "MISSING_DEPENDENCY",
          `Plugin ${record.definition.id} requires ${token.id}, which no selected plugin provides`,
          { pluginId: record.definition.id, serviceId: token.id },
        );
      }
    }

    this.#startupOrder();
  }

  /**
   * Deterministic topological order: providers before consumers.
   *
   * Ties are broken by plugin id so the same composition always starts and stops
   * in the same order, which makes lifecycle tests meaningful.
   */
  #startupOrder(): readonly string[] {
    const order: string[] = [];
    const state = new Map<string, "visiting" | "done">();

    const visit = (id: string, path: readonly string[]): void => {
      const current = state.get(id);
      if (current === "done") return;
      if (current === "visiting") {
        throw new PluginHostError("DEPENDENCY_CYCLE", `Dependency cycle: ${[...path, id].join(" -> ")}`);
      }
      const record = this.#records.get(id);
      if (record === undefined) return;
      state.set(id, "visiting");
      const dependencies = new Set<string>();
      // Optional dependencies that a selected plugin provides are ordered too:
      // otherwise `tryGet` would silently return undefined for a service that is
      // present but not yet started, purely because of id sort order.
      for (const token of [...record.definition.requires, ...(record.definition.optional ?? [])]) {
        for (const [otherId, other] of this.#records) {
          if (other.definition.provides.some((provided) => provided.id === token.id)) {
            dependencies.add(otherId);
          }
        }
      }
      for (const dependency of [...dependencies].sort()) visit(dependency, [...path, id]);
      state.set(id, "done");
      order.push(id);
    };

    for (const id of [...this.#records.keys()].sort()) visit(id, []);
    return order;
  }
}

/** Convenience for tests and the composition root. */
export function startHost(plugins: readonly PluginDefinition[], options: PluginHostOptions): Promise<PluginHost> {
  const host = new PluginHost(plugins, options);
  return host.start().then(() => host);
}
