import { FOLDER_PRUNE_DEFAULT_DAYS } from "@tavi/contracts";
import { UsageError, parseFlags } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";
import { TASKS_DOCTOR_USAGE } from "../tasks/parse.js";

const TASK_FOLDER_ACTIONS = ["show", "set", "attach", "detach", "reset"] as const;
export interface TaskFolderOptions {
  readonly action: (typeof TASK_FOLDER_ACTIONS)[number];
  readonly taskId: string;
  readonly workspaceId: string;
  /** `set` and `attach`: the folder, as typed (`~` and a relative path are resolved by the command). */
  readonly path?: string;
  /** `detach`: the attachment's label. */
  readonly label?: string;
  /** `attach --rw`. */
  readonly rw?: boolean;
}

/** The folders' budget and the free-space floor, in bytes (`serve --folder-cap`, `--chats-cap`, `--free-space-floor`). */
export interface FolderRetentionOptions {
  readonly folderCapBytes?: number;
  readonly chatsCapBytes?: number;
  readonly freeSpaceFloorBytes?: number;
}

export interface TaskFoldersPruneOptions {
  readonly olderThanDays: number;
  /** Whether `--older-than` was given: with `--chat` the age applies only then. */
  readonly olderThanGiven: boolean;
  readonly chat?: string;
  readonly workspaceId: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
}

/** `tavi tasks folders prune [--older-than <days>] [--chat <task-id>] [--dry-run] [--yes]`. */
export function parseTaskFoldersPrune(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  if (action === "-h" || action === "--help") return { command: "help", usage: TASKS_DOCTOR_USAGE };
  if (action !== "prune")
    throw new UsageError(`Unknown tasks folders action ${JSON.stringify(action ?? "")}; expected prune`, TASKS_DOCTOR_USAGE);
  const args = parseFlags(rest, {
    usage: TASKS_DOCTOR_USAGE,
    valued: ["--data-dir", "--workspace", "--older-than", "--chat"],
    switches: ["--dry-run", "--yes"],
    unknown: (name) => `Unexpected option ${name} for tasks folders prune`,
    positional: (token) => `Unexpected argument ${token} for tasks folders prune`,
  });
  if (args === "help") return { command: "help", usage: TASKS_DOCTOR_USAGE };
  const dataDirectory = args.flags.get("--data-dir");
  const workspaceId = args.flags.get("--workspace") ?? "default";
  const olderThan = args.flags.get("--older-than");
  const chat = args.flags.get("--chat");
  const dryRun = args.switches.has("--dry-run");
  const yes = args.switches.has("--yes");
  const days =
    olderThan === undefined ? FOLDER_PRUNE_DEFAULT_DAYS : /^\d{1,4}d?$/.test(olderThan) ? Number.parseInt(olderThan, 10) : Number.NaN;
  if (!Number.isInteger(days) || days < 0 || days > 3_650)
    throw new UsageError(
      `--older-than must be a whole number of days from 0 to 3650, like 30 or 30d (received ${JSON.stringify(olderThan)})`,
      TASKS_DOCTOR_USAGE,
    );
  if (chat !== undefined && chat.length > 128) throw new UsageError("A task id is at most 128 characters", TASKS_DOCTOR_USAGE);
  if (workspaceId.length > 128) throw new UsageError("A workspace id is at most 128 characters", TASKS_DOCTOR_USAGE);
  return {
    command: "tasks",
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    taskFoldersPrune: {
      olderThanDays: days,
      olderThanGiven: olderThan !== undefined,
      ...(chat === undefined ? {} : { chat }),
      workspaceId,
      dryRun,
      yes,
    },
  };
}

/** `tavi tasks folder <task-id> [show|set <path>|attach <path> [--rw]|detach <label>|reset]`. */
export function parseTaskFolder(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: TASKS_DOCTOR_USAGE,
    valued: ["--data-dir", "--workspace"],
    switches: ["--rw"],
    unknown: (name) => `Unexpected option ${name} for tasks folder`,
  });
  if (args === "help") return { command: "help", usage: TASKS_DOCTOR_USAGE };
  const dataDirectory = args.flags.get("--data-dir");
  const workspaceId = args.flags.get("--workspace") ?? "default";
  const rw = args.switches.has("--rw");
  const positional = args.positionals;
  const [taskId, action = "show", argument, ...extra] = positional;
  if (taskId === undefined) throw new UsageError("tasks folder needs a task id", TASKS_DOCTOR_USAGE);
  if (taskId.length > 128) throw new UsageError("A task id is at most 128 characters", TASKS_DOCTOR_USAGE);
  if (workspaceId.length > 128) throw new UsageError("A workspace id is at most 128 characters", TASKS_DOCTOR_USAGE);
  if (!(TASK_FOLDER_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `Unknown tasks folder action ${JSON.stringify(action)}; expected one of ${TASK_FOLDER_ACTIONS.join(", ")}`,
      TASKS_DOCTOR_USAGE,
    );
  }
  const takes = action === "set" || action === "attach" ? "a folder" : action === "detach" ? "a label" : undefined;
  if (takes !== undefined && (argument === undefined || argument.trim() === ""))
    throw new UsageError(`tasks folder ${action} needs ${takes}`, TASKS_DOCTOR_USAGE);
  if (takes === undefined && argument !== undefined)
    throw new UsageError(`Unexpected argument ${argument} for tasks folder ${action}`, TASKS_DOCTOR_USAGE);
  if (extra.length > 0)
    throw new UsageError(`Unexpected argument ${extra[0] as string}; quote a path with spaces as one argument`, TASKS_DOCTOR_USAGE);
  if (rw && action !== "attach") throw new UsageError("--rw applies to tasks folder attach only", TASKS_DOCTOR_USAGE);
  return {
    command: "tasks",
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    taskFolder: {
      action: action as TaskFolderOptions["action"],
      taskId,
      workspaceId,
      ...(action === "set" || action === "attach" ? { path: argument as string } : {}),
      ...(action === "detach" ? { label: argument as string } : {}),
      ...(rw ? { rw } : {}),
    },
  };
}
