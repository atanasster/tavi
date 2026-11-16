import { normalizeSandboxDomain, presetOf, TaviError, type ModelPort } from "@tavi/contracts";
import { parentProxyProblem } from "../features/sandbox/parent-proxy.js";
import type { SandboxCredentialBinding } from "../features/sandbox/tools.js";
import type { TaviRuntime, TaviRuntimeOptions } from "../runtime/types.js";
import { createLogSink } from "../server/log-file.js";
import { definedOnly } from "@tavi/contracts/util";
import type { RunCommandOptions } from "../features/run/parse.js";
import { resolveDataDirectory } from "../shared/data-directory.js";
import { assertHostEntries } from "./flags.js";
import type { ResolvedModelConnection, ResolvedRunTarget } from "./run-target.js";

/**
 * Composition hook.
 *
 * The launcher builds the runtime through this function. It exists so the whole
 * CLI can be exercised end to end with a fixture model transport, and so an embedding launcher can supply its own
 * composition without the CLI reaching into globals.
 *
 * Deliberately narrower than `TaviRuntimeOverrides` — it omits
 * `channelFetch` on purpose. That seam exists only for
 * `composeTaviRuntime`'s own programmatic callers (test suites that
 * construct a runtime directly, see `apps/cli/test/channels/telegram-composition.test.ts`), never for real CLI argument parsing; widening this type to
 * include it would make a test-only fetch substitution reachable from
 * `main()`'s own command-line surface.
 */
export type RuntimeFactory = (
  options: TaviRuntimeOptions,
  overrides?: { readonly requireModelTransport?: boolean; readonly inspectCheckpoints?: boolean; readonly modelOverride?: ModelPort },
) => Promise<TaviRuntime>;

export const defaultRuntimeFactory: RuntimeFactory = async (options, overrides) => {
  // Loaded on first use: a command that never composes a runtime never pays for the owner bundle.
  const { composeTaviRuntime } = await import("../runtime/composition.js");
  return composeTaviRuntime(options, overrides ?? {});
};

/**
 * The runtime options for a resolved target: its stored connection and its
 * fallback composed beside it. Every command that runs a model on a
 * resolved target composes through here, so none can drop the connection's
 * endpoint and credential (as `schedules run-now` and `inbox replay` did).
 */

export function runtimeOptionsForTarget(resolved: ResolvedRunTarget, env: NodeJS.ProcessEnv = process.env): TaviRuntimeOptions {
  return runtimeOptionsFor(resolved.options, env, resolved.connection, resolved.fallback);
}

/** Group `--http-credential-host <ref>=<host>` entries by reference. */
function credentialHostBindings(entries: readonly string[] | undefined): Record<string, readonly string[]> | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  const bindings: Record<string, string[]> = {};
  for (const entry of entries) {
    const at = entry.indexOf("=");
    const reference = entry.slice(0, at).trim();
    const host = entry.slice(at + 1).trim();
    const existing = bindings[reference];
    if (existing === undefined) bindings[reference] = [host];
    else existing.push(host);
  }
  return bindings;
}

/**
 * `serve --sandbox-credential <VAR>=<ref>`, checked when the
 * owner starts: the reference must be bound to hosts with
 * `--http-credential-host`, and each must be an exact host, since the proxy
 * decrypts TLS toward it to put the value in.
 */
function sandboxCredentialsOf(
  entries: readonly string[] | undefined,
  bindings: Record<string, readonly string[]> | undefined,
): { readonly sandboxCredentials?: readonly SandboxCredentialBinding[] } {
  if (entries === undefined || entries.length === 0) return {};
  return {
    sandboxCredentials: entries.map((entry) => {
      const at = entry.indexOf("=");
      const env = entry.slice(0, at);
      const ref = entry.slice(at + 1);
      const hosts = bindings !== undefined && Object.hasOwn(bindings, ref) ? (bindings[ref] ?? []) : [];
      if (hosts.length === 0)
        throw new TaviError(
          "INVALID_INPUT",
          `--sandbox-credential ${entry}: ${ref} is not bound to a host; bind it with --http-credential-host ${ref}=<host>`,
        );
      const pattern = hosts.find((host) => host.includes("*") || host.includes(":") || normalizeSandboxDomain(host) !== host);
      if (pattern !== undefined)
        throw new TaviError(
          "INVALID_INPUT",
          `--sandbox-credential ${entry}: ${ref}'s host ${pattern} must be one exact host in lower case, with no port, since sandbox.run's proxy decrypts TLS toward it and matches it by name`,
        );
      return { env, ref, hosts };
    }),
  };
}

export function runtimeOptionsFor(
  options: RunCommandOptions,
  env: NodeJS.ProcessEnv = process.env,
  connection?: ResolvedModelConnection,
  /** Role `main`'s fallback: composed beside the target, and failed over to. */
  fallback: ResolvedRunTarget["fallback"] = [],
): TaviRuntimeOptions {
  const connectionId = options.connectionId;
  const model = options.model;
  // `resolveModelTarget` guarantees both by the time this is called; the check
  // exists so a direct caller (a test, a future command) fails with a typed
  // error rather than building a runtime around the string "undefined".
  if (connectionId === undefined || model === undefined) {
    throw new TaviError(
      "INVALID_INPUT",
      "A model target is required: pass --connection and --model, or configure one with `tavi models set-default`.",
    );
  }
  // A database-configured connection carries its own endpoint and credential
  // reference, which is what makes `tavi models set-default` meaningful for
  // `run`/`serve`. An explicit flag still wins, and
  // `TAVI_BASE_URL` stays the documented fallback for the flag-only path.
  const credentialRef = connection?.credentialRef ?? `${connectionId}.apiKey`;
  const baseUrl = connection?.baseUrl ?? env["TAVI_BASE_URL"] ?? "https://api.openai.com/v1";
  // A database-configured connection's stored non-credential headers are
  // transport facts too (`tavi models add --header` persists them, and
  // `tavi models test` sends them), so they travel with the endpoint. An
  // explicitly stored `OpenAI-Organization` wins over the env binding, which
  // stays the flag-only path's mechanism.
  const providerHeaders: Record<string, string> = { ...(connection?.headers ?? {}) };
  if (env["TAVI_ORGANIZATION"] !== undefined && providerHeaders["OpenAI-Organization"] === undefined) {
    providerHeaders["OpenAI-Organization"] = env["TAVI_ORGANIZATION"];
  }
  // A credential may only be sent to hosts the operator bound it to: the model
  // names the reference, never the destination.
  const httpCredentialHosts = credentialHostBindings(options.httpCredentialHosts);
  // The flag wins over the environment variable; both are explicit bindings, and
  // neither is an ambient provider-key fallback.
  const credentialFile = options.apiKeyFile ?? env["TAVI_API_KEY_FILE"];
  return {
    dataDirectory: resolveDataDirectory(options.dataDirectory),
    ...(options.shutdownDeadlineMs === undefined ? {} : { shutdownDeadlineMs: options.shutdownDeadlineMs }),
    inMemory: options.inMemory,
    // `serve` sets this; every other command leaves it off, so composing the
    // runtime to read something never deletes rows.
    ...(options.retentionSweepEnabled === undefined ? {} : { retentionSweepEnabled: options.retentionSweepEnabled }),
    // Empty means deny every host, so an unconfigured runtime has no tool-level
    // network egress.
    //
    // Validated here, at composition, rather than only at match time: an entry
    // `normalizeHostEntry` rejects (a wildcard over a shared suffix, a wildcard with
    // a port) would otherwise fail *closed and silently* — every host refused, with
    // nothing saying why. Naming the entry turns the same refusal into a startup
    // error the operator can act on.
    httpAllowedHosts: assertHostEntries(options.httpAllowHosts ?? [], "--http-allow-host"),
    ...definedOnly({
      fsRoots: options.fsRoots,
      sandboxRead: options.sandboxRead,
      sandboxDomains: options.sandboxDomains,
    }),
    ...sandboxCredentialsOf(options.sandboxCredentials, httpCredentialHosts),
    ...(options.sandboxNested === true ? { sandboxNested: true } : {}),
    ...definedOnly({
      sandboxLimits: options.sandboxLimits,
      sandboxTimeouts: options.sandboxTimeouts,
      sandboxLocal: options.sandboxLocal,
      sandboxCache: options.sandboxCache,
      sandboxInspectTls: options.sandboxInspectTls,
      sandboxParentProxy:
        options.sandboxParentProxy ?? parentProxyFromEnvironment(env["TAVI_SANDBOX_PARENT_PROXY"], options.sandboxInspectTls),
      video: options.video,
      pdf: options.pdf,
    }),
    // The off switch: the flag, or TAVI_SANDBOX=off in the service's environment.
    ...(options.sandboxPinnedOff === true || env["TAVI_SANDBOX"] === "off" ? { sandboxPinnedOff: true } : {}),
    ...definedOnly({
      folderRetention: options.folderRetention,
      messagingAllowTools: options.messagingAllowTools,
      approvalExpiryMs: options.approvalExpiryMs,
    }),
    // The operator's extension to the request-header allowlist:
    // validated in `registerHttpTools`, which refuses a non-token name and any
    // credential header rather than quietly widening the surface.
    ...(options.httpRequestHeaders === undefined ? {} : { httpAllowedRequestHeaders: options.httpRequestHeaders }),
    // The browser's navigation allowlist, validated like the HTTP one, so the
    // destination of a model-authored navigation is under the operator's control.
    ...(options.browserAllowHosts === undefined
      ? {}
      : { browserAllowedHosts: assertHostEntries(options.browserAllowHosts, "--browser-allow-host") }),
    // Same deny-by-default reasoning for `messaging.send_to`: the destination is a model-authored argument, so an unconfigured
    // runtime refuses every conversation rather than trusting the model to
    // name the operator's chat.
    messagingAllowedDestinations: options.messagingAllowDestinations ?? [],
    ...(httpCredentialHosts === undefined
      ? {}
      : {
          httpCredentialHosts: Object.fromEntries(
            Object.entries(httpCredentialHosts).map(([reference, hosts]) => [
              reference,
              assertHostEntries(hosts, `--http-credential-host ${reference}`),
            ]),
          ),
        }),
    workspaces: [
      {
        workspaceId: options.workspaceId,
        principalId: options.principalId,
        permissions: ["tools.invoke", "models.invoke", "runs.create"],
      },
    ],
    providers: [
      ...(connection?.providerManaged === true
        ? []
        : [
            {
              connectionId,
              // An unsaved endpoint (`TAVI_BASE_URL` alone) is spoken to as its preset says.
              kind: connection?.kind ?? presetOf(baseUrl)?.kind ?? ("openai-compatible" as const),
              baseUrl,
              credentialRef,
              ...(Object.keys(providerHeaders).length === 0 ? {} : { headers: providerHeaders }),
            },
          ]),
      // Each fallback connection once, as stored: its credential resolves
      // through the owner's chain (the credentials directory, a launcher's
      // binding), never `--api-key-file`, which binds the target's alone.
      ...fallback
        .filter(
          (entry, index) =>
            entry.connection.providerManaged !== true &&
            entry.connectionId !== connectionId &&
            fallback.findIndex((other) => other.connectionId === entry.connectionId) === index,
        )
        .map((entry) => ({
          connectionId: entry.connectionId,
          kind: entry.connection.kind,
          baseUrl: entry.connection.baseUrl,
          credentialRef: entry.connection.credentialRef,
          ...(entry.connection.headers === undefined ? {} : { headers: { ...entry.connection.headers } }),
        })),
    ],
    ...(fallback.length === 0
      ? {}
      : { modelFallback: fallback.map((entry) => ({ connectionId: entry.connectionId, model: entry.model })) }),
    // No binding means no credential: the adapter reports a typed
    // missing-configuration error instead of trying an empty key.
    credentials:
      credentialFile === undefined || connection?.providerManaged === true ? {} : { [credentialRef]: { fromFile: credentialFile } },
    defaultConnectionId: connectionId,
    defaultModel: model,
    explicitModelSelection: options.explicitModelSelection ?? true,
    ...(options.explicitModelTarget === undefined ? {} : { explicitModelTarget: options.explicitModelTarget }),
    approvalRequiredFor: ["mutating", "external"],
    // The operator's standing exemptions (`serve --allow <tool>`): a gated tool
    // named here dispatches without a round, for every task this owner runs.
    ...(options.allowTools === undefined || options.allowTools.length === 0 ? {} : { approvalExemptTools: options.allowTools }),
    logger: {
      level: options.quiet ? "warn" : "info",
      // stderr always; the same JSON lines also go to the daemon's log file when
      // one was named, which is what `tavi logs` reads back.
      sink: createLogSink({
        ...definedOnly({
          path: options.logFile,
          maxBytes: options.logRotateBytes,
          keep: options.logKeep,
        }),
      }),
    },
    // The connections saved in Settings → Channels, for every workspace,
    // opened by composition's channel host.
    openSavedChannels: true,
  };
}

/** `TAVI_SANDBOX_PARENT_PROXY`, held to the flag's check: a value srt would ignore is refused at start, never taken. */
function parentProxyFromEnvironment(raw: string | undefined, inspectTls?: boolean): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (inspectTls === true)
    throw new TaviError(
      "INVALID_INPUT",
      "TAVI_SANDBOX_PARENT_PROXY cannot be used with --sandbox-inspect-tls: the sandbox cannot yet send the connections it inspects through a parent proxy",
    );
  const problem = parentProxyProblem(raw);
  if (problem !== undefined) throw new TaviError("INVALID_INPUT", `TAVI_SANDBOX_PARENT_PROXY ${problem}`);
  return raw;
}
