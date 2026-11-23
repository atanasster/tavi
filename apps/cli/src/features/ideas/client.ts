import { emit } from "../../cli/output.js";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { ownerWords, pageIn, storeWords } from "../../shared/terminal-words.js";
import { EXIT, configRefusalExit, reportCommandFailure } from "../../cli/exit.js";
import type { IdeasCommandOptions } from "./parse.js";
import { terminalText } from "../../shared/terminal-text.js";
import { ideasCommand as runIdeasAction } from "./owner.js";
import { ideasAnswerSchema, ideasMutates, ideasPayload, ideasResultText } from "./text.js";
import type { CliIo } from "../../cli/io.js";
import { runFamily } from "../../cli/owner.js";
import type { ResolvedDataDirectory } from "../../cli/store.js";

/**
 * `tavi ideas <action>`: the `ideas` command on a
 * live owner; with none, the same actions on the directory itself, where
 * `refresh` is refused because no ideas host runs there.
 */
export async function ideasCliCommand(options: ResolvedDataDirectory<IdeasCommandOptions>, io: CliIo): Promise<number> {
  // Text is said in the workspace's language, read only when text is printed; JSON stays as the owner answered.
  const textual = options.format !== "json";
  const print = (result: unknown, t: CoreT = coreEnglish): number => {
    // Read through the answer's schema: an owner of another version answering another shape is said, not printed half-right.
    const parsed = ideasAnswerSchema(options).safeParse(result);
    if (!parsed.success) {
      io.stderr(
        `tavi ideas ${options.action}: the owner answered in a shape this tavi does not read (${terminalText(parsed.error.issues[0]?.message ?? "unknown")}); is it a different version?\n`,
      );
      return EXIT.unavailable;
    }
    emit(io, options.format, parsed.data, () => pageIn(t, ideasResultText(options, parsed.data, io.columns, t), io.columns));
    return EXIT.ok;
  };
  const codes = { NOT_FOUND: EXIT.usage };
  return runFamily(options.dataDirectory, "ideas", io, {
    label: `tavi ideas ${options.action}`,
    mutates: ideasMutates(options),
    codes,
    build: async () => ideasPayload(options),
    render: async (result, client) => print(result, textual ? await ownerWords(client, options.workspaceId) : coreEnglish),
    offline: async (store) => {
      const answer = await runIdeasAction(
        { repositories: store.asPort().repositories, principalOf: () => "operator", now: () => new Date() },
        ideasPayload(options),
      );
      if (!answer.ok) {
        io.stderr(`${terminalText(answer.error.message)}\n`);
        return answer.error.code === "NOT_FOUND" ? codes.NOT_FOUND : configRefusalExit(answer.error.code);
      }
      return print(answer.result, textual ? await storeWords(store, options.workspaceId) : coreEnglish);
    },
    failed: (error) => reportCommandFailure(error, io, "ideas command failed"),
  });
}
