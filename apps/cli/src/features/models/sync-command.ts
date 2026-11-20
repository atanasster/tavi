import { existsSync } from "node:fs";

import { EXIT, reportFailure } from "../../cli/exit.js";
import type { CliIo } from "../../cli/io.js";
import { configOnOwner, OWNER_WORKSPACE } from "../../cli/owner.js";
import { emitJson } from "../../cli/output.js";
import type { RuntimeFactory } from "../../cli/runtime-options.js";
import type { ResolvedDataDirectory } from "../../cli/store.js";
import type { TaviRuntime } from "../../runtime/types.js";
import { RHUMB_KEY_HINT, syncRuntimeModelLifecycle, type LifecycleSyncNoKey, type LifecycleSyncReport } from "./lifecycle-sync.js";
import type { ModelsCommandOptions } from "./parse.js";
import { rhumbKeyOf } from "./rhumb-client.js";

/** A sync reads up to five catalog pages: past the owner's usual config deadline. */
const SYNC_TIMEOUT_MS = 120_000;

/**
 * `tavi models sync`: what Rhumb says of the models in use, stored and
 * printed. Under a live owner the owner syncs, with its key; with none, this
 * process composes the directory's runtime and syncs with its own.
 */
export async function modelsSyncCommand(
  options: ResolvedDataDirectory<ModelsCommandOptions>,
  io: CliIo,
  runtimeFactory: RuntimeFactory,
): Promise<number> {
  const onOwner = await configOnOwner(options.dataDirectory, "models", io, {
    label: "tavi models sync",
    mutates: true,
    timeoutMs: SYNC_TIMEOUT_MS,
    build: () => ({ action: "sync", workspaceId: OWNER_WORKSPACE.workspaceId }),
    render: (result) => printSync(result as LifecycleSyncReport | LifecycleSyncNoKey, io),
  });
  if (onOwner !== undefined) return onOwner;
  // No key in the environment and no directory to have stored one in: say so before creating it.
  if (rhumbKeyOf() === undefined && !existsSync(options.dataDirectory)) return printSync({ skipped: "no-key", hint: RHUMB_KEY_HINT }, io);
  let runtime: TaviRuntime;
  try {
    runtime = await runtimeFactory(
      {
        dataDirectory: options.dataDirectory,
        inMemory: false,
        workspaces: [{ ...OWNER_WORKSPACE, permissions: ["models.invoke"] }],
        providers: [],
        credentials: {},
        defaultConnectionId: "unconfigured",
        defaultModel: "unconfigured",
        logger: { level: "warn", sink: (line) => process.stderr.write(`${line}\n`) },
        // Plugins verified, not started: a sync reads the catalog and starts no MCP server.
        externalPlugins: "verify",
      },
      { requireModelTransport: false },
    );
  } catch (error) {
    return reportFailure(error, io, "models sync could not open the data directory");
  }
  try {
    return printSync(await syncRuntimeModelLifecycle(runtime), io);
  } catch (error) {
    return reportFailure(error, io, "models sync failed");
  } finally {
    await runtime.close();
  }
}

function printSync(result: LifecycleSyncReport | LifecycleSyncNoKey, io: CliIo): number {
  if ("skipped" in result) {
    // As `suggest` does: no key is a choice, not a failure.
    io.stderr(`${result.hint}\n`);
    return EXIT.ok;
  }
  emitJson(io, result);
  return EXIT.ok;
}
