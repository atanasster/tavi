import { emitJson } from "../../cli/output.js";
import { EXIT, refusalExit } from "../../cli/exit.js";
import { terminalText } from "../../shared/terminal-text.js";
import { TaviError, DEFAULT_WORKSPACE_ID, type SystemPromptAnswer, type SystemPromptPreview } from "@tavi/contracts";
import type { IpcClient, IpcClientResponse } from "@tavi/runtime";
import { readFileSync } from "node:fs";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { operatorActor, systemPromptAnswerFor, systemPromptPreviewFor } from "../../server/config-commands.js";
import type { SystemPromptCommandOptions } from "./parse.js";
import type { CliIo } from "../../cli/io.js";
import { CONFIG_TIMEOUT_MS, configFailureReporter, configOnOwner } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStorePreservingOwnership } from "../../cli/store.js";
import { minuteUtc } from "../../shared/minute-utc.js";

/**
 * Read a prompt file as UTF-8, exactly.
 *
 * Deliberately not `readCredentialValueFromFile`: that trims and enforces the
 * credential-file rules (one line, secret-safe handling), none of which apply to
 * a prompt — a base may be multiline and may begin or end with whitespace, and
 * the accepted text is stored byte for byte.
 */
function readSystemPromptFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new TaviError("INVALID_INPUT", `cannot read the system prompt file ${JSON.stringify(path)}: ${errorMessage(error)}`);
  }
}

/**
 * `tavi system-prompt`: edit the
 * default base new tasks run under, on a live owner over IPC or directly when
 * none serves the data directory.
 *
 * A write is a compare-and-set. Without `--expected-revision` the command reads
 * the current revision first — from the owner on the same connection, or from
 * the store offline — and then asserts it. A racing writer is therefore reported
 * as `CONFLICT` rather than silently overwritten, and a retry with the revision
 * the operator actually saw is never destructive.
 */
export async function systemPromptCommand(options: ResolvedDataDirectory<SystemPromptCommandOptions>, io: CliIo): Promise<number> {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  // The CLI's own action name for the read is `show`; the IPC action is `get`.
  const ipcAction = options.action === "show" ? "get" : options.action;

  /**
   * Report a refusal the way the requested format can read it.
   *
   * `--format json` exists for scripts, so a failure emits the same envelope the
   * IPC answer uses rather than prose alone; the exit code stays the
   * machine-readable summary either way.
   *
   * Deliberately not the module's `reportFailure`: that helper maps a conflict
   * to `EXIT.alreadyOwned` (data-directory contention), while a stale prompt
   * revision is a usage-level refusal here.
   */
  const reportSystemPromptFailure = configFailureReporter(options.format, io);

  // Read the file before connecting: a missing path is the operator's mistake,
  // not something to report as an owner failure. Reported as the usage refusal
  // `INVALID_INPUT` maps to, never a raw throw out of `main`.
  let text: string | undefined;
  if (options.action === "set") {
    try {
      if (options.file === undefined) throw new TaviError("INVALID_INPUT", "system-prompt set needs --file");
      text = readSystemPromptFile(options.file);
    } catch (error) {
      return reportSystemPromptFailure(error);
    }
  }
  const render = (answer: SystemPromptAnswer): number => {
    if (options.format === "json") {
      emitJson(io, answer);
      return EXIT.ok;
    }
    // The text is written verbatim and terminated exactly once: a base that
    // already ends in a newline must not gain a second one, or `show | diff`
    // reports a blank line that is not in the stored text.
    const block = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);
    if (answer.custom === null) {
      io.stdout(`workspace ${answer.workspaceId}: shipped default ${answer.shipped.templateVersion}, revision ${answer.revision}\n`);
      io.stdout(block(answer.shipped.text));
      return EXIT.ok;
    }
    io.stdout(
      `workspace ${answer.workspaceId}: custom override at revision ${answer.custom.revision} ` +
        `(${answer.custom.lastOperation} by ${answer.custom.actor} at ${minuteUtc(answer.custom.updatedAt)})\n`,
    );
    io.stdout(block(answer.custom.text));
    return EXIT.ok;
  };

  const renderPreview = (preview: SystemPromptPreview): number => {
    if (options.format === "json") {
      emitJson(io, preview);
      return EXIT.ok;
    }
    io.stdout(
      `workspace ${preview.workspaceId}${preview.agentId === undefined ? "" : `, agent ${preview.agentId}`}: ` +
        `the layers a new task's prompt is built from, in order\n`,
    );
    for (const layer of preview.layers) {
      const size = layer.generated ? "generated per call" : `${layer.length ?? 0} chars`;
      const skills = layer.skills === undefined ? "" : `, ${layer.skills} active ${layer.skills === 1 ? "skill" : "skills"}`;
      const state = layer.active ? "" : " (not sent)";
      io.stdout(`  ${layer.kind.padEnd(8)} ${terminalText(layer.label)} — ${size}${skills}${state}\n`);
      if (!layer.active && layer.detail !== undefined) io.stdout(`           ${terminalText(layer.detail)}\n`);
    }
    const facts = preview.layers.find((layer) => layer.kind === "facts" && layer.sample === true);
    if (facts?.detail !== undefined) {
      io.stdout(`\nSample runtime facts (the first step of an attended task; each call's own differ):\n${terminalText(facts.detail)}\n`);
    }
    return EXIT.ok;
  };

  const onOwner = await configOnOwner(options.dataDirectory, "system-prompt", io, {
    label: `tavi system-prompt ${options.action}`,
    mutates: options.action !== "show" && options.action !== "preview",
    build: async (client) => {
      if (ipcAction === "get") return { action: "get", workspaceId };
      if (ipcAction === "preview")
        return { action: "preview", workspaceId, ...(options.agentId === undefined ? {} : { agentId: options.agentId }) };
      let expectedRevision = options.expectedRevision;
      if (expectedRevision === undefined) {
        const read = await readSystemPromptRevision(client, io, workspaceId);
        // A refused read is reported, and the write is never sent with a
        // made-up revision: return the exit instead of a payload.
        if ("exit" in read) return read.exit;
        expectedRevision = read.revision;
      }
      return {
        action: ipcAction,
        workspaceId,
        expectedRevision,
        ...(text === undefined ? {} : { text }),
      };
    },
    render: (result) =>
      options.action === "preview" ? renderPreview(result as SystemPromptPreview) : render(result as SystemPromptAnswer),
  });
  if (onOwner !== undefined) return onOwner;

  const now = nowTimestamp();
  try {
    return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const repositories = store.asPort().repositories;
      const systemPrompts = repositories.systemPrompts;
      if (options.action === "preview") return renderPreview(await systemPromptPreviewFor(repositories, workspaceId, options.agentId, now));
      if (options.action !== "show") {
        const expectedRevision = options.expectedRevision ?? (await systemPrompts.get(workspaceId)).revision;
        if (options.action === "set") {
          // Read above, before connecting: a set that could not read its file returned there.
          if (text === undefined) throw new TaviError("INTERNAL", "system-prompt set has no text");
          await systemPrompts.set({ workspaceId, text, expectedRevision, actor: operatorActor(false), now });
        } else {
          await systemPrompts.reset({ workspaceId, expectedRevision, actor: operatorActor(false), now });
        }
      }
      return render(await systemPromptAnswerFor(systemPrompts, workspaceId, false));
    });
  } catch (error) {
    return reportSystemPromptFailure(error);
  }
}

/**
 * The revision a write should assert, read from the owner on the connection the
 * write will use.
 *
 * Tagged rather than a bare number: an exit code and a revision are both
 * numbers, and conflating them would send a write asserting revision 2 because
 * the read failed with `EXIT.usage`.
 */
async function readSystemPromptRevision(
  client: IpcClient,
  io: CliIo,
  workspaceId: string,
): Promise<{ readonly revision: number } | { readonly exit: number }> {
  let response: IpcClientResponse;
  try {
    response = await client.request("system-prompt", { action: "get", workspaceId }, prefixedId("system-prompt-read"), {
      timeoutMs: CONFIG_TIMEOUT_MS,
    });
  } catch (error) {
    io.stderr(`tavi system-prompt: ${errorMessage(error)}\n`);
    return { exit: EXIT.unavailable };
  }
  if (!response.ok) {
    return { exit: refusalExit(io, response.error, "could not read the system prompt") };
  }
  return { revision: (response.result as SystemPromptAnswer).revision };
}
