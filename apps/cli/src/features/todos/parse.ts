import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags, removalAlias } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

/**
 * `tavi todos`: the operator's to-do list in Tavi (the same list `todos.*`
 * keep from a chat), through the owner when one serves the directory, offline
 * otherwise. `export` writes the whole list out, for a person moving to a task
 * app of their own; the move itself is asked for in a chat, where the agent
 * adds each to-do through the app's server and ticks it off here.
 */
const TODOS_ACTIONS = ["list", "add", "done", "reopen", "remove", "export"] as const;
type TodosAction = (typeof TODOS_ACTIONS)[number];

export const TODOS_USAGE = `tavi todos <action> [options]

Your to-do list in Tavi: the one a chat adds to ("add milk to my list"), on
every channel, with no setup. A to-do with a due time also reminds you then.
When you keep tasks in an app of your own (tavi config set tasks.home
mcp:<server>), chats add your to-dos there, and this list keeps only Tavi's own
follow-ups. There is no sync: to move what is here, export it, or ask in a chat
("move my Tavi to-dos to Todoist"), which adds each through the app and ticks
it off here.

Under a live \`tavi serve\`, every action runs on the owner over IPC; with none,
the data directory is opened directly.

Actions:
  list                       Open to-dos, oldest first (--all for done ones too)
  add "<text>"               Add a to-do
  done <id> | reopen <id>    Tick a to-do off, or put it back on its list
  remove <id>                Remove a to-do for good (alias: rm, delete)
  export                     Every to-do, open and done: a Markdown checklist
                             (--format json for the records)

Options:
  --list <name>              add: the list (default inbox); list, export: only it
  --due <date|time>          add: YYYY-MM-DD (shown), or a time with its offset
                             (2026-10-30T17:00+01:00), which also reminds
  --notes <text>             add: detail kept with it
  --all                      list: done to-dos too
  --workspace <id>           Workspace (default: default)
  --principal <id>           list, export: only this person's to-dos (default:
                             every person's in the workspace); add: whose
                             (default: the operator)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export interface TodosCommandOptions {
  readonly action: TodosAction;
  readonly dataDirectory?: string;
  readonly workspaceId: string;
  /** Only with `--principal`: list and export are then this person's alone, and add is theirs. */
  readonly principalId?: string;
  readonly todoId?: string;
  readonly text?: string;
  readonly list?: string;
  readonly due?: string;
  readonly notes?: string;
  readonly all?: true;
  readonly format: OutputFormat;
}

const DUE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DUE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseTodos(argv: readonly string[]): ParsedCommand {
  const usage = TODOS_USAGE;
  const [typed, ...rest] = argv;
  // `rm`, `remove` and `delete` all name the removal.
  const action = removalAlias(typed, "remove");
  if (action === "-h" || action === "--help") return { command: "help", usage };
  if (action === undefined) throw new UsageError(`todos needs an action; expected one of ${TODOS_ACTIONS.join(", ")}`, usage);
  if (!(TODOS_ACTIONS as readonly string[]).includes(action))
    throw new UsageError(`Unknown todos action ${JSON.stringify(action)}; expected one of ${TODOS_ACTIONS.join(", ")}`, usage);
  const resolved = action as TodosAction;
  const common = ["--data-dir", "--format", "--workspace", "--principal"];
  const valued: Readonly<Record<TodosAction, readonly string[]>> = {
    list: [...common, "--list"],
    add: [...common, "--list", "--due", "--notes"],
    done: common,
    reopen: common,
    remove: common,
    export: [...common, "--list"],
  };
  const args = parseFlags(rest, {
    usage,
    valued: valued[resolved],
    ...(resolved === "list" ? { switches: ["--all"] } : {}),
    unknown: (name) => `todos ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags, positionals, switches } = args;
  if (positionals.length > 1)
    throw new UsageError(
      resolved === "add" ? `todos add takes the text as one argument; quote it ("buy milk")` : `todos ${action} takes one to-do id`,
      usage,
    );
  const positional = positionals[0];
  const needsId = resolved === "done" || resolved === "reopen" || resolved === "remove";
  if (needsId && positional === undefined) throw new UsageError(`todos ${action} needs a to-do id`, usage);
  if (!needsId && resolved !== "add" && positional !== undefined) throw new UsageError(`todos ${action} takes no argument`, usage);
  const text = resolved === "add" ? positional?.trim() : undefined;
  if (resolved === "add" && (text === undefined || text === ""))
    throw new UsageError(`todos add needs the to-do: tavi todos add "buy milk"`, usage);
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, usage);
  const due = flags.get("--due")?.trim();
  if (due !== undefined && !DUE_DATE.test(due) && !(DUE_TIME.test(due) && !Number.isNaN(Date.parse(due))))
    throw new UsageError(
      `--due expects YYYY-MM-DD or a time with its offset (2026-10-30T17:00+01:00), received ${JSON.stringify(due)}`,
      usage,
    );
  return {
    command: "todos",
    todos: {
      action: resolved,
      workspaceId: flags.get("--workspace") ?? "default",
      ...(needsId && positional !== undefined ? { todoId: positional } : {}),
      ...definedOnly({ text, list: flags.get("--list"), due, notes: flags.get("--notes"), principalId: flags.get("--principal") }),
      ...(switches.has("--all") ? { all: true as const } : {}),
      format,
      ...dataDirectoryFlag(flags),
    },
  };
}
