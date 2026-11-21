import { TaviError, TaviErrorCodeSchema } from "@tavi/contracts";
import { prefixedId } from "@tavi/node-kit";

import { EXIT, reportCommandFailure, reportFailure } from "../../cli/exit.js";
import { confirmOnTerminal, type CliIo } from "../../cli/io.js";
import { configOnOwner, OWNER_WORKSPACE } from "../../cli/owner.js";
import { emitJson } from "../../cli/output.js";
import { terminalText } from "../../shared/terminal-text.js";
import type { RuntimeFactory } from "../../cli/runtime-options.js";
import type { ResolvedDataDirectory } from "../../cli/store.js";
import type { TaviRuntime } from "../../runtime/types.js";
import type { ModelsCommandOptions } from "./parse.js";
import { previewReplace, replaceModel, type ReplacePreview, type ReplaceResult } from "./replace.js";
import type { ModelUse } from "./targets-in-use.js";

/** Reading every use, then a routine revision each: past the owner's usual config deadline. */
const REPLACE_TIMEOUT_MS = 120_000;

/**
 * `tavi models replace <connection>/<old> --with <new>`: lists every place
 * the old model is used, asks, then moves them all. `--yes` answers for a
 * script; with no terminal and no `--yes` it lists and changes nothing.
 */
export async function modelsReplaceCommand(
  options: ResolvedDataDirectory<ModelsCommandOptions>,
  io: CliIo,
  runtimeFactory: RuntimeFactory,
): Promise<number> {
  const from = options.replaceFrom;
  const to = options.replaceWith;
  if (from === undefined || to === undefined) {
    io.stderr("models replace needs <connection>/<model> and --with <model>\n");
    return EXIT.usage;
  }
  const onOwner = await configOnOwner(options.dataDirectory, "models", io, {
    label: "tavi models replace",
    mutates: true,
    timeoutMs: REPLACE_TIMEOUT_MS,
    build: async (client) => {
      const payload = {
        action: "replace" as const,
        workspaceId: OWNER_WORKSPACE.workspaceId,
        connectionId: from.connectionId,
        model: from.model,
        replaceWith: to,
      };
      const preview = await client.request("models", payload, prefixedId("models"), { timeoutMs: REPLACE_TIMEOUT_MS });
      if (!preview.ok) {
        const code = TaviErrorCodeSchema.safeParse(preview.error?.code);
        throw new TaviError(code.success ? code.data : "INTERNAL", preview.error?.message ?? "the owner refused the replace");
      }
      const go = await confirmReplace(preview.result as ReplacePreview, options.yes === true, io);
      return go === true ? { ...payload, confirmed: true } : go;
    },
    render: (result) => printReplaced(result as ReplaceResult, io),
  });
  if (onOwner !== undefined) return onOwner;

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
        // Plugins verified, not started: a replace reads and writes configuration and starts no MCP server.
        externalPlugins: "verify",
      },
      { requireModelTransport: false },
    );
  } catch (error) {
    return reportFailure(error, io, "models replace could not open the data directory");
  }
  try {
    const go = await confirmReplace(await previewReplace(runtime, from, to, OWNER_WORKSPACE.workspaceId), options.yes === true, io);
    if (go !== true) return go;
    return printReplaced(await replaceModel(runtime, from, to, OWNER_WORKSPACE.workspaceId), io);
  } catch (error) {
    // A refusal (itself, an unknown connection) exits as the owner's would: usage, or unavailable.
    return reportCommandFailure(error, io, "models replace failed");
  } finally {
    await runtime.close();
  }
}

/** Lists what would change and asks: `true` to go ahead, else the exit code to stop with. */
async function confirmReplace(preview: ReplacePreview, yes: boolean, io: CliIo): Promise<true | number> {
  const target = terminalText(`${preview.from.connectionId}/${preview.from.model}`);
  // Said first: a use where nothing could be read is neither listed nor moved.
  for (const source of preview.unread) io.stderr(`not read: ${terminalText(source)}\n`);
  if (preview.usedBy.length === 0) {
    io.stderr(`${target} is not used anywhere in ${preview.workspaceId} that could be read; nothing to replace\n`);
    return preview.unread.length === 0 ? EXIT.ok : EXIT.taskFailed;
  }
  io.stderr(`${target} is used by:\n${preview.usedBy.map((use) => `  ${terminalText(useInWords(use))}\n`).join("")}`);
  if (yes) return true;
  if (!io.isTty) {
    io.stderr("Nothing changed: run again with --yes to replace it in all of these.\n");
    return EXIT.usage;
  }
  const replacement = terminalText(`${preview.to.connectionId}/${preview.to.model}`);
  if (await confirmOnTerminal(`Replace it with ${replacement} in all of these? [y/N] `)) return true;
  io.stderr("Nothing changed.\n");
  return EXIT.ok;
}

function printReplaced(result: ReplaceResult, io: CliIo): number {
  emitJson(io, result);
  for (const { use, reason } of result.skipped) io.stderr(`not replaced: ${terminalText(`${useInWords(use)}: ${reason}`)}\n`);
  for (const { use, error } of result.failed) io.stderr(`failed: ${terminalText(`${useInWords(use)}: ${error}`)}\n`);
  for (const source of result.unread) io.stderr(`not read, so not replaced there: ${terminalText(source)}\n`);
  for (const note of result.notes) io.stderr(`note: ${terminalText(note)}\n`);
  return result.failed.length === 0 && result.unread.length === 0 ? EXIT.ok : EXIT.taskFailed;
}

/** A use as the confirmation lists it. */
function useInWords(use: ModelUse): string {
  const where = use.workspaceId === undefined ? "" : ` (${use.workspaceId})`;
  switch (use.kind) {
    case "connection-default":
      return "the connection's default";
    case "video":
      return "native video on its connection";
    case "workspace-default":
      return `the workspace default${where}`;
    case "role":
      return `the ${use.detail ?? ""} role${where}`;
    case "role-fallback":
      return `a fallback of the ${use.detail ?? ""} role${where}`;
    case "routine":
      return `the routine ${use.detail ?? ""}${where}`;
    case "routine-fallback":
      return `a fallback of the routine ${use.detail ?? ""}${where}`;
    case "heartbeat":
      return `a heartbeat${where}`;
    case "activity-summary":
      return `activity summaries${where}`;
    case "chat":
      return `${use.count ?? 1} chat(s) that chose it${where}`;
  }
}
