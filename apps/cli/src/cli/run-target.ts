import { emitError } from "./output.js";
import { EXIT, isOwnershipContention, reportFailure } from "./exit.js";
import { TaviError, type ModelConnection, type ModelSkip, type ModelTarget } from "@tavi/contracts";
import { join } from "node:path";
import { isConnectionWithoutModel, resolveRunTarget, type RunTarget, type RunTargetSource } from "../features/models/target.js";
import { UsageError } from "./parse.js";
import { RUN_USAGE, type RunCommandOptions } from "../features/run/parse.js";
import { resolveDataDirectory } from "../shared/data-directory.js";
import type { CliIo } from "./io.js";
import { withStorePreservingOwnership } from "./store.js";

/**
 * Build the runtime configuration for a CLI invocation.
 *
 * The provider key comes from one explicit, named binding, in precedence
 * order: the file named by `--api-key-file`, then `TAVI_API_KEY_FILE`. There
 * is no ambient provider or environment-key fallback.
 * The binding is registered under the connection's own `credentialRef` — the
 * CLI-flag default `${connectionId}.apiKey` on the flag path, or the reference
 * stored on the connection when the target came from the database.
 */
/** A model connection resolved from the database rather than from CLI flags. */
export interface ResolvedModelConnection {
  readonly providerManaged?: boolean;
  /** How the connection is spoken to: an OpenAI-compatible endpoint or Anthropic's own Messages API. */
  readonly kind: ModelConnection["kind"];
  readonly baseUrl: string;
  readonly credentialRef: string;
  /** Stored non-credential headers, merged into the provider entry. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Fill in `--connection`/`--model` from durable configuration.
 *
 * `tavi models set-default` has always written
 * `tavi_model_workspace_defaults`, but the model adapter was built only from
 * CLI flags, so the configured default was inert and every invocation had to
 * repeat the target. Reading it here — before
 * composition, from the same data directory composition will own — makes
 * "configure once, then run" true, and carries the connection's own base URL,
 * credential reference and stored headers, so a database-configured endpoint
 * is used instead of `TAVI_BASE_URL`.
 *
 * A fully-flagged invocation takes the fast path and never opens the store.
 */
export async function resolveModelTarget(
  options: RunCommandOptions,
  { requireTarget = true }: { readonly requireTarget?: boolean } = {},
): Promise<ResolvedRunTarget> {
  options = {
    ...options,
    explicitModelTarget: options.explicitModelTarget ?? {
      ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
      ...(options.model === undefined ? {} : { model: options.model }),
    },
    explicitModelSelection: options.explicitModelSelection ?? (options.connectionId !== undefined || options.model !== undefined),
  };
  if (options.connectionId !== undefined && options.model !== undefined) {
    if (options.inMemory === true) return { options, fallback: [], skipped: [] };
    const connectionId = options.connectionId;
    const dataDirectory = resolveDataDirectory(options.dataDirectory);
    const managed = await withStorePreservingOwnership(dataDirectory, async (store) => {
      const stored = await store.asPort().repositories.modelConfig.getConnection(connectionId);
      if (stored?.providerBinding !== undefined) {
        if (stored.providerBinding.workspaceId !== options.workspaceId)
          throw new TaviError("NOT_AUTHORIZED", "Provider connection belongs to another workspace");
        return { providerManaged: true, kind: stored.kind, baseUrl: stored.baseUrl, credentialRef: stored.credentialRef };
      }
      // Offline configured instances have no projected catalog until their first activation.
      // The runtime and the plugin catalog are loaded here, not at the top: `main` re-exports this module.
      const [{ PluginRegistry }, { BUILTIN_PLUGINS }] = await Promise.all([
        import("@tavi/runtime"),
        import("../features/plugins/catalog.js"),
      ]);
      const registry = new PluginRegistry({ client: store, directory: join(dataDirectory, "plugins"), builtins: BUILTIN_PLUGINS });
      for (const plugin of await registry.resolveEnabled()) {
        if (!plugin.ok) continue;
        const instance = plugin.instances.find(
          (candidate) =>
            `${plugin.record.pluginId}.${candidate.id}` === connectionId &&
            plugin.record.manifest.capabilities.some((capability) => capability.id === candidate.factory && capability.kind === "model"),
        );
        if (instance === undefined) continue;
        if (instance.workspaceId !== options.workspaceId)
          throw new TaviError("NOT_AUTHORIZED", "Provider connection belongs to another workspace");
        const endpoint = instance.settings["endpoint"] ?? instance.settings["baseUrl"];
        return {
          providerManaged: true,
          // A plugin's model provider is spoken to as an OpenAI-compatible endpoint.
          kind: "openai-compatible" as const,
          baseUrl: typeof endpoint === "string" ? endpoint : "in-process",
          credentialRef: Object.values(instance.credentials)[0] ?? "provider.anonymous",
        };
      }
      const configured = await store.asPort().repositories.plugins.listSettings();
      if (
        configured.settings.some((setting) => setting.instances?.some((instance) => `${setting.pluginId}.${instance.id}` === connectionId))
      )
        throw new TaviError(
          "NOT_CONFIGURED",
          "Configured provider instance is not an enabled approved model; inspect plugins before retrying",
        );
      return undefined;
    });
    return { options, ...(managed === undefined ? {} : { connection: managed }), fallback: [], skipped: [] };
  }
  if (options.inMemory === true) {
    // There is no durable configuration to read a default from.
    if (!requireTarget) return { options, fallback: [], skipped: [] };
    throw new UsageError("--connection and --model are required with --in-memory", RUN_USAGE);
  }
  const dataDirectory = resolveDataDirectory(options.dataDirectory);
  const { ModelConfigService } = await import("@tavi/runtime");
  return withStorePreservingOwnership(dataDirectory, async (store) => {
    const service = new ModelConfigService(store.asPort());
    // One resolution for run, serve and the restart a `models` write
    // simulates: role `main`'s binding, else the workspace default —
    // the default workspace's for a workspace that configures neither.
    let resolved: RunTarget | undefined;
    try {
      resolved = await resolveRunTarget(service, {
        workspaceId: options.workspaceId,
        connectionId: options.connectionId,
        model: options.model,
      });
    } catch (error) {
      // A connection with no model to run is the operator's to name.
      if (isConnectionWithoutModel(error)) throw new UsageError(error.message, RUN_USAGE);
      throw error;
    }
    if (resolved === undefined) {
      // A caller that can run without a model (`serve`) keeps its historical
      // placeholders; `run` always needs a target.
      if (!requireTarget) return { options, fallback: [], skipped: [] };
      throw new UsageError(
        "no model is configured: run `tavi onboard` (about 2 minutes), pass --connection and --model, or run " +
          "`tavi models set-default --connection <id> --model <id>` (or bind role main with `tavi models set-role main`)",
        RUN_USAGE,
      );
    }
    const transport = (connection: ModelConnection): ResolvedModelConnection => ({
      ...(connection.providerBinding === undefined ? {} : { providerManaged: true }),
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      credentialRef: connection.credentialRef,
      ...(connection.headers === undefined ? {} : { headers: connection.headers }),
    });
    return {
      options: { ...options, connectionId: resolved.target.connectionId, model: resolved.target.model },
      ...(resolved.connection === undefined ? {} : { connection: transport(resolved.connection) }),
      source: resolved.source,
      fallback: resolved.fallback.map((entry) => ({ ...entry.target, connection: transport(entry.connection) })),
      skipped: resolved.skipped,
    };
  });
}

/** What `resolveModelTarget` gives a caller: the options with the target filled in, and how it was reached. */
export interface ResolvedRunTarget {
  readonly options: RunCommandOptions;
  /** The target's stored connection, when it has one. */
  readonly connection?: ResolvedModelConnection;
  /** Absent when both flags named the target and no configuration was read. */
  readonly source?: RunTargetSource;
  /** The targets after the first, in order, each with its connection (a role binding's fallback). */
  readonly fallback: readonly (ModelTarget & { readonly connection: ResolvedModelConnection })[];
  /** Candidates resolution passed over, and why. */
  readonly skipped: readonly ModelSkip[];
}

/**
 * Trace which endpoint an invocation resolved to, so a precedence switch driven
 * by database contents is visible rather than inferred. Never prints a secret.
 */
export function noteResolvedTarget(io: CliIo, options: RunCommandOptions, resolved: ResolvedRunTarget): void {
  if (resolved.connection === undefined || options.quiet === true) return;
  const from = resolved.source === "role" ? " (role main)" : "";
  const fallback =
    resolved.fallback.length === 0
      ? ""
      : `, falling back to ${resolved.fallback.map((entry) => `${entry.connectionId}/${entry.model}`).join(", ")}`;
  for (const skip of resolved.skipped) io.stderr(`passed over ${skip.target.connectionId}/${skip.target.model}: ${skip.reason}\n`);
  io.stderr(
    `using the configured model target ${resolved.options.connectionId}/${resolved.options.model}${from} ` +
      `at ${resolved.connection.baseUrl}${fallback}\n`,
  );
}

/** Resolve the model target, mapping its failures onto the documented exit codes. */
export async function resolveModelTargetOrReport(
  options: RunCommandOptions,
  io: CliIo,
  targetOptions: { readonly requireTarget?: boolean; readonly usage?: string } = {},
): Promise<ResolvedRunTarget | number> {
  try {
    return await resolveModelTarget(options, targetOptions);
  } catch (error) {
    if (error instanceof UsageError) {
      // A caller whose own flag set differs from `tavi run`'s supplies its
      // usage here; `tavi run` itself keeps the default.
      io.stderr(`${error.message}\n\n${targetOptions.usage ?? error.usage}`);
      return EXIT.usage;
    }
    // A mistyped `--connection` is the operator error the exit-code table calls
    // "target not found" (4), not an unrecoverable internal failure (70).
    if (error instanceof TaviError && error.code === "NOT_FOUND") {
      emitError(io, error.message);
      return EXIT.unavailable;
    }
    // Configured, but nothing usable: every target of role main passed over.
    // The operator's configuration to fix, as an unconfigured one is.
    if (error instanceof TaviError && (error.code === "NOT_CONFIGURED" || error.code === "CAPABILITY_MISSING")) {
      io.stderr(`${error.message}\n\`tavi models roles\` shows what each role resolves to.\n`);
      return EXIT.usage;
    }
    // Another process owns the data directory: that is what to say, not a model problem.
    if (error instanceof TaviError && error.code === "CONFLICT" && isOwnershipContention(error)) {
      emitError(io, error.message);
      return EXIT.alreadyOwned;
    }
    return reportFailure(error, io, "could not resolve the model target");
  }
}
