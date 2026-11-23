import { emit } from "../../cli/output.js";
import { EXIT, configRefusalExit, refusalExit, reportCommandFailure } from "../../cli/exit.js";
import type { HeartbeatCommandOptions } from "./parse.js";
import { terminalText } from "../../shared/terminal-text.js";
import { ownerWords, pageIn, storeWords } from "../../shared/terminal-words.js";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { heartbeatCommand as runHeartbeatAction } from "./owner.js";
import { editedInstructions, heartbeatPayload, heartbeatResultText } from "./text.js";
import {
  TaviErrorCodeSchema,
  HEARTBEAT_PRODUCTION_OPTIONS,
  type HeartbeatOptions,
  type HeartbeatPayload,
  TaviError,
} from "@tavi/contracts";
import { readFileSync } from "node:fs";
import { prefixedId } from "@tavi/node-kit";
import type { CliIo } from "../../cli/io.js";
import { configOnOwner } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStorePreservingOwnership } from "../../cli/store.js";

/**
 * `tavi heartbeat <action>`: the `heartbeat`
 * command on a live owner, as the workspace's operator; with none, the same
 * actions on the directory itself — every one a store write — except Check
 * now, which needs the owner's host.
 */
export async function heartbeatCliCommand(options: ResolvedDataDirectory<HeartbeatCommandOptions>, io: CliIo): Promise<number> {
  // Text is said in the workspace's language; JSON stays as programs read it.
  const textual = options.format !== "json";
  const print = (result: unknown, t: CoreT = coreEnglish): number => {
    emit(io, options.format, result, () => pageIn(t, heartbeatResultText(options, result, t), io.columns));
    return EXIT.ok;
  };
  if (options.action === "edit" && options.file === undefined && !io.isTty) {
    io.stderr("heartbeat edit opens your editor in a terminal; elsewhere pass --file <path> (- reads standard input)\n");
    return EXIT.usage;
  }
  const editing = { readStdin: () => readFileSync(0, "utf8") };
  const codes = { NOT_FOUND: EXIT.usage };
  const onOwner = await configOnOwner(options.dataDirectory, "heartbeat", io, {
    label: `tavi heartbeat ${options.action}`,
    mutates: options.action !== "status" && options.action !== "log",
    codes,
    build: async (client) => {
      const read = async (payload: Record<string, unknown>): Promise<unknown> => {
        const answer = await client.request("heartbeat", payload, prefixedId("heartbeat"));
        if (!answer.ok) {
          const code = TaviErrorCodeSchema.safeParse(answer.error?.code);
          throw new TaviError(
            code.success ? code.data : "UNAVAILABLE",
            terminalText(answer.error?.message ?? "The owner refused the heartbeat read"),
          );
        }
        return answer.result;
      };
      // The owner's interval choices (a test owner's include sub-minute ones), and the text `edit` starts from.
      const choices =
        options.action === "every"
          ? ((await read({ action: "options", workspaceId: options.workspaceId })) as HeartbeatOptions)
          : HEARTBEAT_PRODUCTION_OPTIONS;
      let instructions: string | undefined;
      let readRevision: number | undefined;
      if (options.action === "edit") {
        const current = (await read({ action: "instructions", workspaceId: options.workspaceId })) as {
          readonly text: string;
          readonly revision: number;
        };
        readRevision = current.revision;
        instructions = editedInstructions(options, current.text, editing);
        if (instructions === undefined) {
          io.stdout(
            options.format === "json" ? `${JSON.stringify({ unchanged: true })}\n` : "The instructions are unchanged; nothing was saved.\n",
          );
          return EXIT.ok;
        }
      }
      return heartbeatPayload(options, {
        choices,
        ...(instructions === undefined ? {} : { instructions }),
        ...(readRevision === undefined ? {} : { readRevision }),
      });
    },
    render: async (result, client) => print(result, textual ? await ownerWords(client, options.workspaceId) : coreEnglish),
  });
  if (onOwner !== undefined) return onOwner;
  if (options.action === "run-now") {
    io.stderr("heartbeat run-now needs a running owner (tavi serve); none is serving this data directory\n");
    return EXIT.unavailable;
  }
  try {
    return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const deps = {
        repositories: store.asPort().repositories,
        principalOf: () => "operator",
        options: HEARTBEAT_PRODUCTION_OPTIONS,
        providers: () => [],
        host: () => undefined,
        author: "cli",
        now: () => new Date(),
      };
      let instructions: string | undefined;
      let readRevision: number | undefined;
      if (options.action === "edit") {
        const current = await runHeartbeatAction(deps, { action: "instructions", workspaceId: options.workspaceId });
        if (!current.ok) {
          return refusalExit(io, current.error);
        }
        const read = current.result as { readonly text: string; readonly revision: number };
        readRevision = read.revision;
        instructions = editedInstructions(options, read.text, editing);
        if (instructions === undefined) {
          io.stdout(
            options.format === "json" ? `${JSON.stringify({ unchanged: true })}\n` : "The instructions are unchanged; nothing was saved.\n",
          );
          return EXIT.ok;
        }
      }
      let payload: HeartbeatPayload;
      try {
        payload = heartbeatPayload(options, {
          choices: HEARTBEAT_PRODUCTION_OPTIONS,
          ...(instructions === undefined ? {} : { instructions }),
          ...(readRevision === undefined ? {} : { readRevision }),
        });
      } catch (error) {
        return refusalExit(io, TaviError.from(error));
      }
      const answer = await runHeartbeatAction(deps, payload);
      if (!answer.ok) {
        io.stderr(`${terminalText(answer.error.message)}\n`);
        return answer.error.code === "NOT_FOUND" ? codes.NOT_FOUND : configRefusalExit(answer.error.code);
      }
      return print(answer.result, textual ? await storeWords(store, options.workspaceId) : coreEnglish);
    });
  } catch (error) {
    return reportCommandFailure(error, io, "heartbeat command failed");
  }
}
