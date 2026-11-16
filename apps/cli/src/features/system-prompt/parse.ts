import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

/**
 * `tavi system-prompt`: the
 * default base every *new* task in a workspace runs under.
 */
const SYSTEM_PROMPT_CLI_ACTIONS = ["show", "set", "reset", "preview"] as const;
/**
 * The CLI's action names, deliberately distinct from the contract's
 * `SystemPromptAction` (`get`/`set`/`reset`/`preview`): the operator types `show`, the IPC
 * command says `get`, and `features/system-prompt/client.ts` is the one place that maps between them.
 */
type SystemPromptCliAction = (typeof SYSTEM_PROMPT_CLI_ACTIONS)[number];

export const SYSTEM_PROMPT_USAGE = `tavi system-prompt <action> [options]

The default system prompt for this workspace: the instructions the model
receives before a persona and before retrieved context. Editing it changes the
base from the next message: a new chat, and each existing chat's next turn,
run under the edited base, while a turn already running keeps the base it
started under (an approval or answer resumes it under that base). A chat
started under an explicit base keeps it. A routine's own pinned
instructions always win, and the call that summarizes a chat's older history
keeps its separate prompt.

Actions:
  show                       Print the saved override, or the shipped default
  set --file <path>          Replace the base with this file's exact text
  reset                      Clear the override and follow the shipped default
  preview [--agent <id>]     List the layers a new task's prompt is built from,
                             in order, with their lengths: the shipped default
                             or your prompt, the agent's persona, then the
                             runtime facts and retrieved context generated for
                             each model call

Options:
  --file <path>              The prompt text, read as UTF-8 exactly as written
                             (required for set; leading and trailing whitespace
                             is kept, and the credential-file rules do not apply)
  --expected-revision <n>    Assert the revision this write is based on instead
                             of reading it first; a mismatch is a conflict
  --agent <id>               preview: append this agent's persona
  --workspace <id>           Workspace to act in (default: default)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help

If a write times out its outcome is unknown: run \`tavi system-prompt show\` and
compare before retrying. A retry with the revision you actually read cannot
apply the same change twice.
`;

export interface SystemPromptCommandOptions {
  readonly action: SystemPromptCliAction;
  /** `set`'s text file. */
  readonly file?: string;
  /** The revision the write is based on; read from the owner when omitted. */
  readonly expectedRevision?: number;
  /** `preview`'s agent, whose persona is appended. */
  readonly agentId?: string;
  readonly workspaceId?: string;
  readonly format: "text" | "json";
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
}

export function parseSystemPrompt(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  if (action === "-h" || action === "--help") return { command: "help", usage: SYSTEM_PROMPT_USAGE };
  if (action === undefined) {
    throw new UsageError(`system-prompt needs an action; expected one of ${SYSTEM_PROMPT_CLI_ACTIONS.join(", ")}`, SYSTEM_PROMPT_USAGE);
  }
  if (!(SYSTEM_PROMPT_CLI_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `Unknown system-prompt action ${JSON.stringify(action)}; expected one of ${SYSTEM_PROMPT_CLI_ACTIONS.join(", ")}`,
      SYSTEM_PROMPT_USAGE,
    );
  }
  const resolved = action as SystemPromptCliAction;
  // `show` reads, so an expected revision is meaningless for it and is refused
  // rather than silently ignored.
  const writeOnly = ["--expected-revision"];
  const allowed: Readonly<Record<SystemPromptCliAction, readonly string[]>> = {
    show: ["--data-dir", "--format", "--workspace"],
    set: ["--file", ...writeOnly, "--data-dir", "--format", "--workspace"],
    reset: [...writeOnly, "--data-dir", "--format", "--workspace"],
    preview: ["--agent", "--data-dir", "--format", "--workspace"],
  };
  // A repeated flag is refused rather than last-one-wins: it is a slip, and
  // silently honouring only the second value is how an operator asserts a
  // revision they did not mean.
  const args = parseFlags(rest, {
    usage: SYSTEM_PROMPT_USAGE,
    valued: allowed[resolved],
    unknown: (name) => `system-prompt ${resolved} does not accept ${name}`,
    repeated: (name) => `system-prompt ${resolved} received ${name} twice`,
    repeatedFirst: true,
    positional: (token) => `system-prompt ${resolved} takes no positional argument (${JSON.stringify(token)})`,
  });
  if (args === "help") return { command: "help", usage: SYSTEM_PROMPT_USAGE };
  const { flags } = args;
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, SYSTEM_PROMPT_USAGE);
  }
  const file = flags.get("--file");
  if (resolved === "set" && file === undefined) throw new UsageError("system-prompt set needs --file <path>", SYSTEM_PROMPT_USAGE);
  const revisionFlag = flags.get("--expected-revision");
  let expectedRevision: number | undefined;
  if (revisionFlag !== undefined) {
    if (!/^\d+$/.test(revisionFlag)) {
      throw new UsageError(
        `--expected-revision must be a nonnegative integer, received ${JSON.stringify(revisionFlag)}`,
        SYSTEM_PROMPT_USAGE,
      );
    }
    expectedRevision = Number(revisionFlag);
  }
  const workspaceId = flags.get("--workspace");
  const agentId = flags.get("--agent");
  return {
    command: "system-prompt",
    systemPrompt: {
      action: resolved,
      ...definedOnly({
        file,
        expectedRevision,
        agentId,
        workspaceId,
      }),
      format,
      ...dataDirectoryFlag(flags),
    },
  };
}
