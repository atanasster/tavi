import { EXIT, reportFailure } from "../cli/exit.js";
import { closeLogSink, defaultLogPath } from "./log-file.js";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import { resolve } from "node:path";
import { serve, type ShutdownOutcome } from "./serve.js";
import type { ServeCommandOptions } from "./parse.js";
import type { RunCommandOptions } from "../features/run/parse.js";
import type { CliIo } from "../cli/io.js";
import { OWNER_WORKSPACE } from "../cli/owner.js";
import { noteResolvedTarget, resolveModelTargetOrReport } from "../cli/run-target.js";
import { runtimeOptionsFor } from "../cli/runtime-options.js";
import type { ResolvedDataDirectory } from "../cli/store.js";
import { externalMemoryProvidersOf, resetDataDirectoryAndKey, resetSummary } from "../features/maintenance/reset.js";
import { EVAL_OWNER_OFF } from "./eval-owner.js";
import { runWindowless } from "./windowless.js";

/** How long past its drain deadline a faulted owner may take to stop before it is ended with 70. */
const FAULT_EXIT_GRACE_MS = 10_000;

/** The drain deadline on Windows when the console window closes: the most of the 10 s Windows allows, with room for the release after it. */
const WINDOWS_HANGUP_DRAIN_MS = 5_000;

/**
 * Run the foreground owner until a signal asks it to stop.
 *
 * The service manager owns restart and backoff; this process only shuts itself
 * down cleanly on SIGTERM/SIGINT/SIGHUP (on Windows, its console window
 * closing), and drains the same way, exiting non-zero, on
 * an unhandled rejection or uncaught exception.
 */
export async function serveCommand(options: ResolvedDataDirectory<ServeCommandOptions>, io: CliIo): Promise<number> {
  if (options.windowless === true) {
    if (process.platform !== "win32") {
      io.stderr("tavi serve: --windowless is for a Windows logon task (tavi service unit --kind task)\n");
      return EXIT.usage;
    }
    return runWindowless({ argv: process.argv.slice(1) });
  }
  // A dev plugin runs unapproved code the operator vouches for at the keyboard; a service restarts unattended.
  if (options.devPlugins !== undefined && process.env["TAVI_SERVICE"] === "1") {
    io.stderr("tavi serve: --dev-plugin is refused when the owner runs as a service; run tavi serve in a terminal to develop a plugin\n");
    return 2;
  }
  const baseRunOptions: RunCommandOptions = {
    prompt: "",
    format: "text",
    ...OWNER_WORKSPACE,
    ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    dataDirectory: options.dataDirectory,
    // Every daemon gets a Tavi-readable log by default: without this the
    // JSON stream only reached the platform's unified log, where no Tavi command
    // can read it. `--log-file` overrides it.
    logFile: options.logFile ?? defaultLogPath(options.dataDirectory),
    ...(options.logRotateBytes === undefined ? {} : { logRotateBytes: options.logRotateBytes }),
    ...(options.logKeep === undefined ? {} : { logKeep: options.logKeep }),
    shutdownDeadlineMs: options.drainDeadlineMs,
    approval: "deny",
    quiet: true,
    inMemory: false,
    ...(options.apiKeyFile === undefined ? {} : { apiKeyFile: options.apiKeyFile }),
    // Every allowlist `serve` parses. One left out here is silently ignored —
    // `serve --http-allow-host` / `--http-request-header` / `--browser-allow-host` /
    // `--messaging-allow-destination` / `--http-credential-host` — and the daemon
    // starts with no egress, no destinations or no browser policy, so a schedule
    // that fires cannot deliver.
    ...definedOnly({
      httpAllowHosts: options.httpAllowHosts,
      fsRoots: options.fsRoots,
      sandboxRead: options.sandboxRead,
      sandboxDomains: options.sandboxDomains,
      sandboxCredentials: options.sandboxCredentials,
    }),
    ...(options.sandboxNested === true ? { sandboxNested: true } : {}),
    ...definedOnly({
      sandboxLimits: options.sandboxLimits,
      sandboxTimeouts: options.sandboxTimeouts,
      sandboxLocal: options.sandboxLocal,
      sandboxParentProxy: options.sandboxParentProxy,
      sandboxCache: options.sandboxCache,
      sandboxInspectTls: options.sandboxInspectTls,
      video: options.video,
      pdf: options.pdf,
    }),
    // `runtimeOptionsFor` adds TAVI_SANDBOX=off from the environment.
    ...(options.sandboxPinnedOff === true ? { sandboxPinnedOff: true } : {}),
    ...definedOnly({
      folderRetention: options.folderRetention,
      messagingAllowTools: options.messagingAllowTools,
      approvalExpiryMs: options.approvalExpiryMs,
      allowTools: options.allowTools,
      httpRequestHeaders: options.httpRequestHeaders,
      browserAllowHosts: options.browserAllowHosts,
      messagingAllowDestinations: options.messagingAllowDestinations,
      httpCredentialHosts: options.httpCredentialHosts,
    }),
    // The artifact half of the retention sweep is a serve-time choice, like the
    // sweep itself.
    retentionSweepArtifacts: options.retentionSweepArtifacts === true,
  };
  // The retention sweep runs only here: `run`/`doctor`/`prune` compose the same
  // runtime and must not delete rows just by being run.
  const retentionSweepEnabled = true;

  // A bare `serve` resolves its target as `run` does — role `main`, else the
  // workspace default — at startup, and again at each turn and each
  // command that reads it (`liveModelTarget`, `liveTarget`); the historical
  // `default` placeholders apply only when nothing at all is configured, and
  // `serve` still starts in that case because it composes with
  // `requireModelTransport: false`. Configured but unusable, it is refused.
  const resolved = await resolveModelTargetOrReport(baseRunOptions, io, { requireTarget: false });
  if (typeof resolved === "number") return resolved;
  noteResolvedTarget(io, baseRunOptions, resolved);
  const unconfigured = resolved.options.connectionId === undefined;
  // The flags choose the model a new chat runs; they assert nothing about a chat
  // that has its own (`/model`, the canvas's picker), so no admission checks them.
  const { explicitModelTarget: _chosenByFlags, ...ownerOptions } = resolved.options;
  const composed = runtimeOptionsFor(
    {
      ...ownerOptions,
      retentionSweepEnabled,
      connectionId: resolved.options.connectionId ?? "default",
      model: resolved.options.model ?? "default",
    },
    process.env,
    resolved.connection,
    resolved.fallback,
  );
  const runOptions = {
    ...composed,
    // The `default` placeholders above name no real model, and no provider is
    // composed for them — not a fabricated `default` connection at
    // api.openai.com — so the first model added over IPC is the only one
    // there is, served from the next turn with no restart.
    // `liveModelTarget` below keeps the model transport composed.
    ...(unconfigured ? { providers: composed.providers.filter((provider) => provider.connectionId !== composed.defaultConnectionId) } : {}),
    // Nothing may pin the placeholders.
    modelTargetUnconfigured: unconfigured,
    // Unless both flags pinned it, the default is resolved again at each turn.
    ...(baseRunOptions.connectionId !== undefined && baseRunOptions.model !== undefined
      ? {}
      : {
          liveModelTarget: {
            ...(baseRunOptions.connectionId === undefined ? {} : { connectionId: baseRunOptions.connectionId }),
            ...(baseRunOptions.model === undefined ? {} : { model: baseRunOptions.model }),
          },
        }),
    ...(options.devPlugins === undefined ? {} : { devPlugins: options.devPlugins.map((path) => resolve(path)) }),
    // Reminders fire in the owner only, like the retention sweep.
    reminderSweepEnabled: true,
    // So do file watchers' checks soon after a change; each watcher is one a person made.
    scheduleWatchersEnabled: true,
    // So does the heartbeat host; each heartbeat is off until its person turns it on.
    heartbeatEnabled: true,
    // And the ideas host: each workspace's daily ideas run and `/ideas`.
    ideasEnabled: true,
    // And the memory host's commands.
    memoryHostEnabled: true,
    // A worker's result a restart left unannounced reports at start.
    workerResultSweepEnabled: true,
    // Chat grants past their end are deleted at start and hourly.
    grantSweepEnabled: true,
    // `--taint-policy`: every workspace's taint mode for this owner's lifetime, over its `security.taint`.
    ...(options.taintPolicy === undefined ? {} : { taintPolicy: options.taintPolicy }),
    // So are task summaries: each workspace's `activitySummaries` decides whether a call is made.
    taskSummariesEnabled: true,
    // The sandbox's tier is settled at start, so the first `sandbox.run` does not wait for the probe.
    sandboxWarm: true,
    ...(options.evalOwner === true ? EVAL_OWNER_OFF : {}),
  };

  // Signal handlers are installed before startup, not after: a SIGTERM during
  // composition or binding must still run the release path, otherwise the
  // process dies with the default action and leaves its socket and cookie behind
  // for the next start to trip over.
  let handle: Awaited<ReturnType<typeof serve>> | undefined;
  let earlySignal: NodeJS.Signals | undefined;
  // A stop asked for while a reset drains: the reset still runs, but nothing serves after it.
  let stopSignal: NodeJS.Signals | undefined;
  let shuttingDown = false;
  const shutdownOnce = (reason: string, deadlineMs?: number): void => {
    if (shuttingDown || handle === undefined) return;
    shuttingDown = true;
    // `shutdown` reports its own failures and never rejects, so this is safe
    // inside a signal handler.
    void handle.shutdown(reason, deadlineMs);
  };
  // Windows ends a process about 10 s after its console window closes (`SIGHUP`): the drain is held
  // well inside that, so the ownership release and the discovery cleanup after it still run.
  const deadlineFor = (signal: NodeJS.Signals): number | undefined =>
    signal === "SIGHUP" && process.platform === "win32" ? WINDOWS_HANGUP_DRAIN_MS : undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (handle === undefined) {
      earlySignal = signal;
      return;
    }
    stopSignal = signal;
    shutdownOnce(`received ${signal}`, deadlineFor(signal));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  process.once("SIGHUP", onSignal);
  // A stray rejection or throw would otherwise end the process at once, past
  // the drain, the ownership release and the socket and cookie cleanup: it is
  // logged and the owner stops as on SIGTERM, but not cleanly. A watchdog ends
  // the process with 70 should that stop never finish (a startup that hangs, a
  // drain past its deadline).
  let fault: string | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  const onFault =
    (kind: "an unhandled rejection" | "an uncaught exception") =>
    (error: unknown): void => {
      const detail = errorMessage(error);
      const stack = error instanceof Error ? error.stack : undefined;
      if (handle === undefined) {
        io.stderr(`tavi serve: ${kind}: ${detail}\n${stack === undefined ? "" : `${stack}\n`}`);
        process.exitCode = EXIT.internal;
      } else {
        try {
          handle.runtime.logger.error(`${kind} stopped the owner`, { error: detail, ...(stack === undefined ? {} : { stack }) });
        } catch {
          // The logger itself failed: the fault is still said where the service manager reads it.
          io.stderr(`tavi serve: ${kind}: ${detail}\n`);
        }
      }
      fault ??= kind;
      if (watchdog === undefined) {
        watchdog = setTimeout(() => process.exit(EXIT.internal), options.drainDeadlineMs + FAULT_EXIT_GRACE_MS);
        watchdog.unref();
      }
      shutdownOnce(kind);
    };
  const onRejection = onFault("an unhandled rejection");
  const onException = onFault("an uncaught exception");
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  let outcome: ShutdownOutcome;
  try {
    try {
      handle = await serve(
        runOptions,
        {
          ...options,
          // Where the target came from: `run` over IPC refuses a placeholder
          // as NOT_CONFIGURED rather than failing inside the model call
          // until a default resolves, and `liveTarget` resolves the target
          // again from the flags it records — both flags pin it.
          modelTarget: {
            source:
              baseRunOptions.connectionId !== undefined && baseRunOptions.model !== undefined
                ? "flags"
                : resolved.options.connectionId === undefined || resolved.options.model === undefined
                  ? "placeholder"
                  : baseRunOptions.connectionId !== undefined
                    ? "connection"
                    : resolved.source === "role"
                      ? "role"
                      : "default",
            connectionId: runOptions.defaultConnectionId,
            model: runOptions.defaultModel,
            ...(resolved.fallback.length === 0
              ? {}
              : { fallback: resolved.fallback.map((entry) => ({ connectionId: entry.connectionId, model: entry.model })) }),
            workspaceId: baseRunOptions.workspaceId,
            flags: {
              ...(baseRunOptions.connectionId === undefined ? {} : { connectionId: baseRunOptions.connectionId }),
              ...(baseRunOptions.model === undefined ? {} : { model: baseRunOptions.model }),
            },
          },
        },
        io,
      );
    } catch (error) {
      return reportFailure(error, io, "serve could not start");
    }
    if (earlySignal !== undefined) shutdownOnce(`received ${earlySignal}`, deadlineFor(earlySignal));
    else if (fault !== undefined) shutdownOnce(fault);
    outcome = await handle.stopped;
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGHUP", onSignal);
    process.removeListener("unhandledRejection", onRejection);
    process.removeListener("uncaughtException", onException);
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
  // A fault is never a clean stop, and nothing serves after it.
  if (fault !== undefined) return EXIT.internal;
  // A drain that timed out or left a disposer failed is not a clean stop, so
  // the service manager must not see exit 0.
  if (outcome.reset !== true) return outcome.clean ? EXIT.ok : EXIT.internal;
  // `reset-instance`: delete the state once the runtime has let go of
  // it, then serve again on the empty directory, with the same flags — whether
  // or not a service manager would have restarted this process.
  if (!outcome.clean) {
    io.stderr("the owner did not stop cleanly, so the instance was not reset\n");
    return EXIT.internal;
  }
  try {
    // The log file may be inside the directory, and Windows cannot delete a file held open.
    closeLogSink(runOptions.logger?.sink);
    const memoryProviders = await externalMemoryProvidersOf(options.dataDirectory);
    const result = await resetDataDirectoryAndKey(options.dataDirectory, memoryProviders);
    io.stderr(resetSummary(options.dataDirectory, result));
  } catch (error) {
    return reportFailure(error, io, "the instance could not be reset");
  }
  if (stopSignal !== undefined) return EXIT.ok;
  // `--connection` without `--model` named a stored connection, which the reset
  // deleted: the restart resolves the target as a fresh install does.
  const { connectionId, ...unpinned } = options;
  if (connectionId !== undefined && options.model === undefined) {
    io.stderr(`connection ${connectionId} was deleted with the rest; serving again without --connection\n`);
    return serveCommand(unpinned, io);
  }
  return serveCommand(options, io);
}
