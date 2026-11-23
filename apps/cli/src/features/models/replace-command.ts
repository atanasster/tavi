import { TaviError, TaviErrorCodeSchema } from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { prefixedId } from "@tavi/node-kit";

import { EXIT, reportCommandFailure, reportFailure } from "../../cli/exit.js";
import { confirmOnTerminal, type CliIo } from "../../cli/io.js";
import { configOnOwner, OWNER_WORKSPACE } from "../../cli/owner.js";
import { emitJson } from "../../cli/output.js";
import { terminalText } from "../../shared/terminal-text.js";
import { ownerWords, storeWords, yesNoHint } from "../../shared/terminal-words.js";
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
  // The workspace's words, read once before the plan is printed: the plan, the question and the outcome all say them.
  let t: CoreT = coreEnglish;
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
      t = await ownerWords(client);
      const go = await confirmReplace(preview.result as ReplacePreview, options.yes === true, io, t);
      return go === true ? { ...payload, confirmed: true } : go;
    },
    render: (result) => printReplaced(result as ReplaceResult, io, t),
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
    const preview = await previewReplace(runtime, from, to, OWNER_WORKSPACE.workspaceId);
    t = await storeWords(runtime.store);
    const go = await confirmReplace(preview, options.yes === true, io, t);
    if (go !== true) return go;
    return printReplaced(await replaceModel(runtime, from, to, OWNER_WORKSPACE.workspaceId), io, t);
  } catch (error) {
    // A refusal (itself, an unknown connection) exits as the owner's would: usage, or unavailable.
    return reportCommandFailure(error, io, "models replace failed");
  } finally {
    await runtime.close();
  }
}

/** Lists what would change and asks: `true` to go ahead, else the exit code to stop with. */
async function confirmReplace(preview: ReplacePreview, yes: boolean, io: CliIo, t: CoreT = coreEnglish): Promise<true | number> {
  const target = terminalText(`${preview.from.connectionId}/${preview.from.model}`);
  // Said first: a use where nothing could be read is neither listed nor moved.
  for (const source of preview.unread) io.stderr(`${t("prompt.models.notRead", { source: terminalText(source) })}\n`);
  if (preview.usedBy.length === 0) {
    io.stderr(`${t("prompt.models.unused", { model: target, workspace: preview.workspaceId })}\n`);
    return preview.unread.length === 0 ? EXIT.ok : EXIT.taskFailed;
  }
  io.stderr(
    `${t("prompt.models.usedBy", { model: target })}\n${preview.usedBy.map((use) => `  ${terminalText(useInWords(use, t))}\n`).join("")}`,
  );
  if (yes) return true;
  if (!io.isTty) {
    io.stderr(`${t("prompt.models.needsYes")}\n`);
    return EXIT.usage;
  }
  const replacement = terminalText(`${preview.to.connectionId}/${preview.to.model}`);
  if (await confirmOnTerminal(`${t("prompt.models.replace", { model: replacement })} ${yesNoHint(false, t)} `)) return true;
  io.stderr(`${t("prompt.models.nothingChanged")}\n`);
  return EXIT.ok;
}

function printReplaced(result: ReplaceResult, io: CliIo, t: CoreT = coreEnglish): number {
  emitJson(io, result);
  for (const { use, reason } of result.skipped)
    io.stderr(`${t("prompt.models.notReplaced", { what: terminalText(`${useInWords(use, t)}: ${reason}`) })}\n`);
  for (const { use, error } of result.failed)
    io.stderr(`${t("prompt.models.failed", { what: terminalText(`${useInWords(use, t)}: ${error}`) })}\n`);
  for (const source of result.unread) io.stderr(`${t("prompt.models.notReadThere", { source: terminalText(source) })}\n`);
  for (const note of result.notes) io.stderr(`${t("prompt.models.note", { note: terminalText(note) })}\n`);
  return result.failed.length === 0 && result.unread.length === 0 ? EXIT.ok : EXIT.taskFailed;
}

/** A use as the confirmation lists it. */
function useInWords(use: ModelUse, t: CoreT = coreEnglish): string {
  const where = use.workspaceId === undefined ? "" : ` (${use.workspaceId})`;
  const name = use.detail ?? "";
  switch (use.kind) {
    case "connection-default":
      return t("prompt.models.use.connectionDefault");
    case "video":
      return t("prompt.models.use.video");
    case "workspace-default":
      return t("prompt.models.use.workspaceDefault", { where });
    case "role":
      return t("prompt.models.use.role", { name, where });
    case "role-fallback":
      return t("prompt.models.use.roleFallback", { name, where });
    case "routine":
      return t("prompt.models.use.routine", { name, where });
    case "routine-fallback":
      return t("prompt.models.use.routineFallback", { name, where });
    case "heartbeat":
      return t("prompt.models.use.heartbeat", { where });
    case "activity-summary":
      return t("prompt.models.use.activitySummary", { where });
    case "chat":
      return t("prompt.models.use.chat", { n: String(use.count ?? 1), count: use.count ?? 1, where });
  }
}
