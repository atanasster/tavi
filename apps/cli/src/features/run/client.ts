import { EXIT, reportFailure } from "../../cli/exit.js";
import { hostPathOf } from "../folders/owner.js";
import { clientCwdFor, remoteFoldersOf } from "../remote/folders.js";
import { IPC_NOT_RUNNING, TaviError } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { TaviRuntime } from "../../runtime/types.js";
import { attachToRunningTask, runOnOwner } from "./attached.js";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import type { AbortCommandOptions, RunCommandOptions } from "./parse.js";
import type { CliIo } from "../../cli/io.js";
import { clientOperationKey, refuseReservedOperationKey } from "../../cli/operation-key.js";
import { attachToOwner, expectTargetOf } from "../../cli/owner.js";
import { noteResolvedTarget, resolveModelTargetOrReport } from "../../cli/run-target.js";
import { type RuntimeFactory, runtimeOptionsForTarget } from "../../cli/runtime-options.js";
import type { ResolvedDataDirectory } from "../../cli/store.js";
import { executeRun } from "./foreground.js";
import { onInterrupt } from "../../shared/interrupt.js";

export async function runTask(
  options: ResolvedDataDirectory<RunCommandOptions>,
  io: CliIo,
  runtimeFactory: RuntimeFactory,
): Promise<number> {
  if (!options.inMemory && options.dataDirectory.trim() === "") {
    io.stderr("--data-dir must not be empty\n");
    return EXIT.usage;
  }
  const reserved = refuseReservedOperationKey(options.operationKey, io);
  if (reserved !== undefined) return reserved;

  // Under a live owner the run is the owner's: dispatched to it
  // and followed here, since the owner holds the data directory.
  const attached = await runAttached(options, io);
  if (attached !== undefined) return attached;
  if (options.attach !== undefined) {
    io.stderr(`tavi run --attach follows a task a live owner is running; no owner is running on ${options.dataDirectory}\n`);
    return EXIT.unavailable;
  }
  if (options.home === true) {
    io.stderr(`tavi run --home posts into Home on a live owner; no owner is running on ${options.dataDirectory}\n`);
    return EXIT.unavailable;
  }
  if (options.folder !== undefined) {
    io.stderr(`tavi run --folder is checked against a live owner's --fs-root folders; no owner is running on ${options.dataDirectory}\n`);
    return EXIT.unavailable;
  }

  const resolved = await resolveModelTargetOrReport(options, io);
  if (typeof resolved === "number") return resolved;
  noteResolvedTarget(io, options, resolved);

  let runtime: TaviRuntime;
  try {
    runtime = await runtimeFactory(runtimeOptionsForTarget(resolved), {
      requireModelTransport: true,
    });
  } catch (error) {
    return reportFailure(error, io, "runtime composition failed");
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort(new Error("interrupted by signal"));
  const stopListening = onInterrupt(onSignal);

  try {
    return await executeRun(runtime, options, io, controller.signal);
  } finally {
    stopListening();
    await runtime.close();
  }
}

/**
 * The `tavi run` flags that shape the owner's composition — its tool policy, its
 * credentials — rather than one run. Under an owner they are the
 * owner's (`tavi serve`), so a run naming one is refused rather than run under a
 * policy the operator did not ask for.
 */
function compositionFlagsOf(options: RunCommandOptions): readonly string[] {
  return [
    ...(options.apiKeyFile === undefined ? [] : ["--api-key-file"]),
    ...((options.httpAllowHosts?.length ?? 0) > 0 ? ["--http-allow-host"] : []),
    ...((options.httpRequestHeaders?.length ?? 0) > 0 ? ["--http-request-header"] : []),
    ...((options.httpCredentialHosts?.length ?? 0) > 0 ? ["--http-credential-host"] : []),
    ...((options.browserAllowHosts?.length ?? 0) > 0 ? ["--browser-allow-host"] : []),
    ...((options.messagingAllowDestinations?.length ?? 0) > 0 ? ["--messaging-allow-destination"] : []),
  ];
}

/**
 * `tavi run` against a live owner — or `undefined` when none is running (or
 * the run is in memory), so the caller runs it in this process.
 */
async function runAttached(options: ResolvedDataDirectory<RunCommandOptions>, io: CliIo): Promise<number | undefined> {
  if (options.inMemory) return undefined;
  const asks = options.approval === "ask";
  const commands =
    options.attach === undefined ? ["run", ...(asks ? ["approvals", "approve"] : [])] : ["subscribe", "tasks", "approvals", "approve"];
  // A folder for an owner on another computer is named as it is there; a path that cannot be is refused before anything is sent.
  let folderPath: string | undefined;
  if (options.folder !== undefined && options.home !== true) {
    try {
      folderPath = hostPathOf(options.folder, undefined, undefined, remoteFoldersOf(options.dataDirectory));
    } catch (error) {
      if (!(error instanceof TaviError) || error.code !== "INVALID_INPUT") throw error;
      io.stderr(`tavi run: ${error.message}\n`);
      return EXIT.usage;
    }
  }
  const client = await connectOwnerOrReport(options.dataDirectory, commands, io, EXIT);
  if (client === undefined || typeof client === "number") return client;
  try {
    const owned = compositionFlagsOf(options);
    if (owned.length > 0) {
      io.stderr(
        `An owner is serving ${options.dataDirectory}, and a run on it uses the owner's tool policy and credentials: ` +
          `${owned.join(", ")} ${owned.length === 1 ? "is" : "are"} the owner's to set (\`tavi serve ...\`). ` +
          "Omit them, or stop `tavi serve` to run with them.\n",
      );
      return EXIT.usage;
    }
    const follow = {
      format: options.format,
      approval: options.approval,
      workspaceId: options.workspaceId,
      principalId: options.principalId,
      exit: EXIT,
      io,
      quiet: options.quiet,
    };
    if (options.attach !== undefined) return await attachToRunningTask(client, options.attach, follow);
    return await runOnOwner(
      client,
      {
        prompt: options.prompt,
        operationKey: clientOperationKey(options.operationKey),
        // Both named: the chat's own model, which the owner runs whatever its
        // default. One alone — or a message to Home, whose model is
        // picked on its own — stays an assertion the owner checks.
        ...(options.connectionId !== undefined && options.model !== undefined && options.home !== true
          ? { model: { connectionId: options.connectionId, model: options.model } }
          : expectTargetOf(options)),
        // A run is a chat of its own, unless it is posted into Home.
        target: options.home === true ? "home" : "run",
        // Where the run's chat works: the folder named, its own, or — when the owner may use it —
        // this terminal's directory. Home keeps its own folder.
        ...(options.home === true
          ? {}
          : folderPath !== undefined
            ? { folder: { path: folderPath } }
            : options.managed === true
              ? { folder: { managed: true as const } }
              : clientCwdFor(options.dataDirectory)),
      },
      follow,
    );
  } finally {
    client.close();
  }
}

/**
 * `tavi abort <task-id>` — stop the turn a live owner is running for a task
 * Needs the owner: with none, nothing here can be aborted.
 */
export async function abortTask(options: ResolvedDataDirectory<AbortCommandOptions>, io: CliIo): Promise<number> {
  let attached: number | undefined;
  try {
    attached = await attachToOwner(options.dataDirectory, "abort", { taskId: options.taskId }, io, undefined, (code) =>
      // Nothing running is nothing to do (8); an unknown task is not found (4).
      code === IPC_NOT_RUNNING ? EXIT.resumeNotApplicable : code === "NOT_FOUND" ? EXIT.unavailable : undefined,
    );
  } catch (error) {
    io.stderr(`abort failed: ${errorMessage(error)}\n`);
    return EXIT.unavailable;
  }
  if (attached !== undefined) return attached;
  io.stderr(
    `No owner is serving ${options.dataDirectory}, so nothing can be aborted from here: a foreground \`tavi run\` ` +
      "is stopped with Ctrl-C in its own terminal, an owner that is shutting down aborts what still runs at its " +
      "drain deadline, and `tavi cancel` cancels a task durably.\n",
  );
  return EXIT.resumeNotApplicable;
}
