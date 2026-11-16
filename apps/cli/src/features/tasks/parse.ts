import { CHAT_INSTRUCTIONS_MAX } from "@tavi/contracts";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, integerFlag, parseFlags } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

export interface RecoverCommandOptions {
  readonly taskId: string;
  readonly generation: number;
  readonly reason: string;
  readonly operator: string;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
}

export const RECOVER_USAGE = `tavi recover <task-id> --generation <n> --reason <text> [options]

Free a task's execution slot when the process that ran it has died.

An expired lease is evidence to investigate, not permission to overlap: this
command is the explicit confirmation required before a replacement
invocation may be admitted. Confirm the previous process has terminated.

Options:
  --generation <n>      Generation to terminate (required)
  --reason <text>       Why it is safe to terminate (required, recorded)
  --operator <id>       Who made the decision (default: $USER)
  --data-dir <path>     Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help            Show this help
`;

/** `tavi doctor --help`: its own page, not `tavi tasks`'. */
const DOCTOR_USAGE = `tavi doctor [--deep] [options]

Checks the installation and prints what it found: the database, the owner,
models, credentials, plugins, the sandbox and its limits. --format text prints
a short summary of each check; the default is the whole report as JSON, which
--format json asks for by name. The database is checked with SQLite's quick
check; --deep runs the full one, which also checks every index (slower on a
large database). A running owner answers doctor itself and skips the check
either way, so it never blocks; its report adds the owner's health trend
(memory, open files and child processes, sampled every 10 minutes).

Options:
  --deep                     The full integrity check
  --format <text|json>       Output format (default: json, the whole report)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

/** Parse a command whose only option is `--data-dir`. */
export const TASKS_DOCTOR_USAGE = `tavi tasks [task-id] [options]
tavi tasks instructions <task-id> [show|history|set <text>|reset] [options]
tavi tasks history <task-id> [export|forget --before <time>|forget --epoch <n> [--with-memory]|rewind --turn <n>] [options]
tavi tasks folder <task-id> [show|set <path>|attach <path> [--rw]|detach <label>|reset] [options]
tavi tasks folders prune [--older-than <days>] [--chat <task-id>] [--workspace <id>] [--dry-run] [--yes] [options]
tavi doctor [--deep] [options]

tasks lists tasks recorded in the data directory; with a task id it shows
that one task's full recorded timeline instead. doctor takes no positional
argument. doctor checks the database with SQLite's quick check; --deep runs
the full one, which also checks every index (slower on a large database). A
running owner answers doctor itself and skips the check either way, so it
never blocks; its report adds the owner's health trend (memory, open files
and child processes, sampled every 10 minutes).

tasks instructions reads and saves one chat's own instructions: the top layer
of its system prompt, after the base and any persona. A save applies from the
chat's next turn and is kept as a revision; reset saves an empty one. set and
reset save against the revision they read, or the one --revision names.

tasks history prints a chat's saved history as Markdown (export, the default:
its latest epoch summary, then its turns and the notices among them, oldest
first), or erases what it saved before a time (forget --before
2026-10-01T00:00:00Z) or before an epoch began (forget --epoch 3): the saved
turns, notices and steers, the prompt and answer text of those turns'
admission records, its messages' text in the messaging inbox and outbox, its older checkpoints,
the archives its summaries folded earlier turns into, and the memory
proposals it made then that still wait (--with-memory also forgets the
approved memories it taught then; without it, forget says how many stay). It
does not reach everything: the newest 20 checkpoints still hold the current
epoch's conversation word for word, and the epoch summary a condensed account
of earlier ones, and side chats and workers begun from the chat their own
copies (forget lists them, to forget in turn). Its memory is forgotten only
on a running owner, and only when the chat is yours.

tasks history rewind --turn 4 takes the chat back to before its turn 4 (the
number export prints as "## Turn 4"): that turn and every later one leave its
saved history, and from the chat's next message on the model is no longer
given them. It prints the turn's message, to send again as it was or edited.
Refused while a turn runs, or waits on an approval, a review or an answer.
Neither forget nor rewind touches the chat's folder: forget names it, with its
size and the command that clears it.

tasks folder shows one chat's working folder — where its file tools and its
shell work, the folders attached to it and their modes — or changes it from
the chat's next message: set makes a folder under one of the owner's
--fs-root folders its working folder, attach adds one (read-only unless
--rw), detach drops one by its label, and reset goes back to the chat's own
folder with its default attachments (also when its folder is gone). It needs
a running owner, whose --fs-root folders a path is checked against; a
relative path is this directory's. The same as /folder in tavi chat.

tasks folders prune reclaims chats' own folders: by default every run's (a
schedule's, a routine's or a reminder's fire, a tavi run) whose chat was last
active more than --older-than days ago (default 30); with --chat, that one
chat's folder whatever it is — the only way a Home's, a side chat's or an
ordinary chat's folder is cleared. A chat with a turn in progress (running,
or waiting on an approval, a review or an answer) is skipped, and so is one
whose folder configuration cannot be read. It prints its plan and asks before
moving anything (--yes skips the question; without a terminal it is
required); --dry-run only prints. Each folder is moved to chats/.trash/ and
deleted after 7 days, when a later prune runs or an owner starts; a chat
whose folder was moved gets an empty one at its next turn. Host folders are
the person's and are never touched. Like tavi prune it takes the data
directory's ownership, so stop a running owner first.

Options:
  --workspace <id>             The chat's workspace, for tasks instructions, tasks folder and tasks folders prune --chat (default: default)
  --rw                         tasks folder attach: the chat may write the folder too
  --older-than <days>          tasks folders prune: chats last active longer ago (default 30; "30d" too)
  --chat <task-id>             tasks folders prune: this chat's folder only, whatever its kind
  --dry-run                    tasks folders prune: print the plan, move nothing
  --yes                        tasks folders prune: do not ask (required without a terminal)
  --revision <n>               The revision a set or reset expects, for tasks instructions
  --before <time>              An ISO time: tasks history forget erases what was saved before it
  --epoch <n>                  tasks history forget erases what was saved before epoch n began
  --with-memory                tasks history forget also forgets the approved memories the chat taught then
  --turn <n>                   tasks history rewind takes back turn n and every later one
  --data-dir <path>            Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                   Show this help
`;

const TASK_HISTORY_ACTIONS = ["export", "forget", "rewind"] as const;
export interface TaskHistoryOptions {
  readonly action: (typeof TASK_HISTORY_ACTIONS)[number];
  readonly taskId: string;
  readonly workspaceId: string;
  readonly before?: string;
  readonly epoch?: number;
  /** `rewind`: the saved turn to take back, with every later one. */
  readonly turn?: number;
  /** `forget`: the approved memories the chat taught then go too. */
  readonly withMemory?: true;
}

/** `tavi tasks history <task-id> [export|forget --before <time>|forget --epoch <n> [--with-memory]|rewind --turn <n>]`. */
export function parseTaskHistory(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: TASKS_DOCTOR_USAGE,
    valued: ["--data-dir", "--workspace", "--before", "--epoch", "--turn"],
    switches: ["--with-memory"],
    unknown: (name) => `Unexpected option ${name} for tasks history`,
  });
  if (args === "help") return { command: "help", usage: TASKS_DOCTOR_USAGE };
  const dataDirectory = args.flags.get("--data-dir");
  const workspaceId = args.flags.get("--workspace") ?? "default";
  const withMemory = args.switches.has("--with-memory");
  const before = args.flags.get("--before");
  const epoch = args.flags.get("--epoch");
  const turn = args.flags.get("--turn");
  const positional = args.positionals;
  const [taskId, action = "export", ...extra] = positional;
  if (taskId === undefined) throw new UsageError("tasks history needs a task id", TASKS_DOCTOR_USAGE);
  if (taskId.length > 128 || workspaceId.length > 128)
    throw new UsageError("A task or workspace id is at most 128 characters", TASKS_DOCTOR_USAGE);
  if (!(TASK_HISTORY_ACTIONS as readonly string[]).includes(action))
    throw new UsageError(
      `Unknown tasks history action ${JSON.stringify(action)}; expected one of ${TASK_HISTORY_ACTIONS.join(", ")}`,
      TASKS_DOCTOR_USAGE,
    );
  if (extra.length > 0) throw new UsageError(`Unexpected argument ${extra[0] as string}`, TASKS_DOCTOR_USAGE);
  if (action !== "forget" && (before !== undefined || epoch !== undefined))
    throw new UsageError("--before and --epoch apply to tasks history forget only", TASKS_DOCTOR_USAGE);
  if (action !== "forget" && withMemory) throw new UsageError("--with-memory applies to tasks history forget only", TASKS_DOCTOR_USAGE);
  if (action !== "rewind" && turn !== undefined) throw new UsageError("--turn applies to tasks history rewind only", TASKS_DOCTOR_USAGE);
  if (action === "rewind" && (turn === undefined || !/^[1-9]\d{0,8}$/.test(turn)))
    throw new UsageError("tasks history rewind needs --turn <n>, a positive whole number", TASKS_DOCTOR_USAGE);
  if (action === "forget" && before !== undefined && epoch !== undefined)
    throw new UsageError("tasks history forget takes --before or --epoch, not both", TASKS_DOCTOR_USAGE);
  if (action === "forget" && epoch !== undefined && !/^[1-9]\d{0,8}$/.test(epoch))
    throw new UsageError("--epoch takes a positive whole number", TASKS_DOCTOR_USAGE);
  if (action === "forget" && epoch === undefined && (before === undefined || Number.isNaN(Date.parse(before))))
    throw new UsageError("tasks history forget needs --before <ISO time> or --epoch <n>", TASKS_DOCTOR_USAGE);
  return {
    command: "tasks",
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    taskHistory: {
      action: action as TaskHistoryOptions["action"],
      taskId,
      workspaceId,
      ...(before === undefined ? {} : { before: new Date(Date.parse(before)).toISOString() }),
      ...(epoch === undefined ? {} : { epoch: Number(epoch) }),
      ...(turn === undefined ? {} : { turn: Number(turn) }),
      ...(withMemory ? { withMemory: true as const } : {}),
    },
  };
}

const TASK_INSTRUCTIONS_ACTIONS = ["show", "history", "set", "reset"] as const;
export interface TaskInstructionsOptions {
  readonly action: (typeof TASK_INSTRUCTIONS_ACTIONS)[number];
  readonly taskId: string;
  readonly workspaceId: string;
  readonly text?: string;
  readonly revision?: number;
}

/** `tavi tasks instructions <task-id> [show|history|set <text>|reset]`. */
export function parseTaskInstructions(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: TASKS_DOCTOR_USAGE,
    valued: ["--data-dir", "--workspace", "--revision"],
    unknown: (name) => `Unexpected option ${name} for tasks instructions`,
  });
  if (args === "help") return { command: "help", usage: TASKS_DOCTOR_USAGE };
  const dataDirectory = args.flags.get("--data-dir");
  const workspaceId = args.flags.get("--workspace") ?? "default";
  const revisionText = args.flags.get("--revision");
  if (revisionText !== undefined && (!/^\d+$/.test(revisionText) || !Number.isSafeInteger(Number(revisionText))))
    throw new UsageError("--revision needs a whole number", TASKS_DOCTOR_USAGE);
  const revision = revisionText === undefined ? undefined : Number(revisionText);
  const positional = args.positionals;
  const [taskId, action = "show", text, ...extra] = positional;
  if (taskId === undefined) throw new UsageError("tasks instructions needs a task id", TASKS_DOCTOR_USAGE);
  // The ids' bound on the wire: past it, the owner and the data directory would both refuse.
  if (taskId.length > 128) throw new UsageError("A task id is at most 128 characters", TASKS_DOCTOR_USAGE);
  if (workspaceId.length > 128) throw new UsageError("A workspace id is at most 128 characters", TASKS_DOCTOR_USAGE);
  if (!(TASK_INSTRUCTIONS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `Unknown tasks instructions action ${JSON.stringify(action)}; expected one of ${TASK_INSTRUCTIONS_ACTIONS.join(", ")}`,
      TASKS_DOCTOR_USAGE,
    );
  }
  if (action === "set" && (text === undefined || text.trim() === ""))
    throw new UsageError("tasks instructions set needs the text, quoted; reset clears them", TASKS_DOCTOR_USAGE);
  if (action === "set" && text !== undefined && text.length > CHAT_INSTRUCTIONS_MAX)
    throw new UsageError(`A chat's instructions are at most ${CHAT_INSTRUCTIONS_MAX} characters`, TASKS_DOCTOR_USAGE);
  if (action !== "set" && text !== undefined)
    throw new UsageError(`Unexpected argument ${text} for tasks instructions ${action}`, TASKS_DOCTOR_USAGE);
  if (extra.length > 0)
    throw new UsageError(`Unexpected argument ${extra[0] as string}; quote the instructions as one argument`, TASKS_DOCTOR_USAGE);
  if (revision !== undefined && (action === "show" || action === "history"))
    throw new UsageError(`--revision applies to set and reset only`, TASKS_DOCTOR_USAGE);
  return {
    command: "tasks",
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    taskInstructions: {
      action: action as TaskInstructionsOptions["action"],
      taskId,
      workspaceId,
      ...(text === undefined ? {} : { text }),
      ...(revision === undefined ? {} : { revision }),
    },
  };
}

export function parseDataDirOnly(command: "tasks" | "doctor", argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: TASKS_DOCTOR_USAGE,
    valued: ["--data-dir"],
    switches: command === "doctor" ? ["--deep"] : [],
    unknown: (name) => `Unexpected argument ${name} for ${command}`,
    // `tavi tasks <task-id>` narrows the document to one task; `doctor` takes
    // no positional argument at all.
    positional: (token, taken) => (command === "tasks" && taken.length === 0 ? undefined : `Unexpected argument ${token} for ${command}`),
  });
  if (args === "help") return { command: "help", usage: command === "doctor" ? DOCTOR_USAGE : TASKS_DOCTOR_USAGE };
  const dataDirectory = args.flags.get("--data-dir");
  const taskId = args.positionals[0];
  return {
    command,
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(args.switches.has("--deep") ? { deep: true } : {}),
  };
}

/** Parse `tavi recover`, which demands explicit termination evidence. */
export function parseRecover(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: RECOVER_USAGE,
    positional: (_token, taken) => (taken.length > 0 ? "recover accepts exactly one task id" : undefined),
  });
  if (args === "help") return { command: "help", usage: RECOVER_USAGE };
  const { flags } = args;
  const taskId = args.positionals[0];

  if (taskId === undefined) {
    throw new UsageError("recover requires a task id", RECOVER_USAGE);
  }
  const generationRaw = flags.get("--generation");
  if (generationRaw === undefined) {
    throw new UsageError("--generation is required", RECOVER_USAGE);
  }
  const generation = integerFlag(generationRaw, { min: 1 }, "--generation must be a positive integer", RECOVER_USAGE);
  const reason = flags.get("--reason");
  if (reason === undefined || reason.trim() === "") {
    // The reason is not cosmetic: it is recorded on the terminated generation.
    throw new UsageError("--reason is required and must not be empty", RECOVER_USAGE);
  }

  return {
    command: "recover",
    recover: {
      taskId,
      generation,
      reason,
      operator: flags.get("--operator") ?? process.env["USER"] ?? "operator",
      ...dataDirectoryFlag(flags),
    },
  };
}

export interface CancelCommandOptions {
  readonly taskId: string;
  readonly reason: string;
  readonly operator: string;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
}

export const CANCEL_USAGE = `tavi cancel <task-id> --reason <text> [options]

Cancel a task for good: it cannot be resumed.

Cancellation is an application-owned record, so it survives restart and a reply
arriving afterwards cannot revive the work. Pending approvals for the task are
closed with it.

Options:
  --reason <text>       Why the task is cancelled (required, recorded)
  --operator <id>       Who cancelled it (default: $USER)
  --data-dir <path>     Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help            Show this help
`;

/** Parse `tavi cancel`, which records an authoritative durable cancellation. */
export function parseCancel(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: CANCEL_USAGE,
    positional: (_token, taken) => (taken.length > 0 ? "cancel accepts exactly one task id" : undefined),
  });
  if (args === "help") return { command: "help", usage: CANCEL_USAGE };
  const { flags } = args;
  const taskId = args.positionals[0];

  if (taskId === undefined) throw new UsageError("cancel requires a task id", CANCEL_USAGE);
  const reason = flags.get("--reason");
  if (reason === undefined || reason.trim() === "") {
    throw new UsageError("--reason is required and must not be empty", CANCEL_USAGE);
  }

  return {
    command: "cancel",
    cancel: {
      taskId,
      reason,
      operator: flags.get("--operator") ?? process.env["USER"] ?? "operator",
      ...dataDirectoryFlag(flags),
    },
  };
}
