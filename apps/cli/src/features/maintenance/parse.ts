import { DEFAULT_TRANSPORT_RETENTION_DAYS } from "./retention.js";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, integerFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

export interface PruneCommandOptions {
  readonly olderThanDays: number;
  readonly dryRun: boolean;
  /** Also delete non-report artifacts past the window. */
  readonly includeArtifacts: boolean;
  readonly format: OutputFormat;
  readonly dataDirectory?: string;
}

export interface LogsCommandOptions {
  readonly tail: number;
  /** Explicit file, or undefined for `<data-dir>/logs/tavi.log`. */
  readonly file?: string;
  readonly format: OutputFormat;
  readonly dataDirectory?: string;
}

export interface MaintenanceCommandOptions {
  readonly action: "backup" | "export" | "restore";
  /** `--out` for backup/export. */
  readonly outDirectory?: string;
  /** `--from` for restore. */
  readonly fromDirectory?: string;
  readonly force: boolean;
  readonly includeArtifacts: boolean;
  readonly includeCredentials: boolean;
  readonly format: OutputFormat;
  readonly dataDirectory?: string;
}

/** `tavi reset`. */
export interface ResetCommandOptions {
  readonly format: OutputFormat;
  readonly dataDirectory?: string;
}

export const BACKUP_USAGE = `tavi backup --out <dir> [options]

Write a consistent snapshot of a data directory — the database, the artifacts
directory, the installed plugins, the chats' working folders (chats/, without each folder's .tmp/ and
.home/ or the prune trash; links copied as links), and (only when asked) the
credentials — for an upgrade, a move, or a recovery point. Safe to run while
\`tavi serve\` owns the directory: the snapshot is SQLite's own
consistent-snapshot operation, not a copy of files that a live write could be
halfway through.

The manifest records what the snapshot contains, so a restore is never read as
"everything came back".

Options:
  --out <dir>                Snapshot directory outside the data directory (required;
                             must be empty unless --force)
  --force                    Overwrite a non-empty snapshot directory
  --no-artifacts             Skip the artifacts directory (it can be large)
  --include-credentials      Copy <data-dir>/credentials as well (0600; off by default,
                             because copying secrets to a second location is a decision)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export const EXPORT_USAGE = `tavi export --out <dir> [options]

Write every application table to <dir>/<table>.ndjson. The portable half of a
backup: a snapshot restores this build's schema, while an export can be read by
anything. Read-only, so it is safe while \`tavi serve\` runs.

Options:
  --out <dir>                Export directory (required; must be empty unless --force)
  --force                    Overwrite a non-empty export directory
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export const RESTORE_USAGE = `tavi restore --from <dir> [options]

Restore a snapshot written by \`tavi backup\` into the data directory. The snapshot
is validated before anything moves: it must carry a migration ledger, and every
migration it records must be one this build ships (a snapshot from a newer build
is refused, exactly as this build refuses to open such a schema). The existing
database is moved aside, never deleted, so a wrong snapshot is recoverable; so
are artifacts/, plugins/ and the chats' working folders when the snapshot
carries them (one it does not carry is left as it is), and the output names
where each went.

Unlike \`backup\` and \`export\`, this command writes: it needs the data directory
to itself and refuses while \`tavi serve\` owns it.

Options:
  --from <dir>               Snapshot directory to restore (required)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export const RESET_USAGE = `tavi reset --yes [options]

Delete everything in the data directory, as if tavi had just been installed: the
database (chats, tasks, memory, schedules, settings), artifacts, the chats'
working folders (chats/: keep files you need in a folder you attach), saved
credentials and their key, installed plugins, the web-search choice, messaging
settings, UI preferences and logs.
Nothing is moved aside or kept; take a \`tavi backup\` first to keep a copy. Only
files tavi writes are deleted; anything else in the directory is left and named.

With \`tavi serve\` running, the owner stops, deletes, and starts again on the
empty directory. Otherwise the directory is reset here. Settings → General → Reset instance does the same from the web canvas.

Options:
  --yes                      Confirm the deletion (required)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export const PRUNE_USAGE = `tavi prune [options]

Delete finished message-delivery records older than a cutoff: processed inbox
messages, resolved outbox sends, delivered/expired/rejected messages between
agents (mailbox envelopes) and settled waits. \`tavi serve\` runs the same sweep
every six hours with the default window; this command is for running it now, or inspecting what it would do.
Like every command that writes, it needs the data directory to itself, --dry-run
included: stop \`tavi serve\` first.

Untouched by design: tasks, effects, approvals, reports, artifacts and the
database's own history are the audit trail rather than transport state, and a
delivered PDF is the deliverable. An inbox row a task has not processed yet is
also left alone — it is still somebody's message.

Options:
  --older-than <days>        Keep rows newer than this (default: 30)
  --dry-run                  Count what would go; delete nothing
  --include-artifacts        Also delete artifacts past the window — screenshots,
                             downloads, archived tool output — but never a
                             \`pending\` one, and never a report PDF a report row
                             references. Off by default: the brief is the
                             deliverable, and this is the operator saying the
                             rest may go
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export const LOGS_USAGE = `tavi logs [options]

Read back \`tavi serve\`'s own log file — the same JSON lines it writes to
stderr, kept in <data-dir>/logs/tavi.log and rotated by size.

Options:
  --tail <n>                 How many lines to print, newest last (default: 200)
  --file <path>              Read this file instead of the default
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

/** `tavi prune [--older-than <days>] [--dry-run]`. */
export function parsePrune(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: PRUNE_USAGE,
    valued: ["--older-than", "--format", "--data-dir"],
    switches: ["--dry-run", "--include-artifacts"],
    unknown: (name) => `prune does not accept ${name}`,
    positional: (token) => `Unexpected argument ${JSON.stringify(token)} for prune`,
  });
  if (args === "help") return { command: "help", usage: PRUNE_USAGE };
  const { flags } = args;
  const dryRun = args.switches.has("--dry-run");
  const includeArtifacts = args.switches.has("--include-artifacts");
  const daysRaw = flags.get("--older-than") ?? String(DEFAULT_TRANSPORT_RETENTION_DAYS);
  // `30` or `30d`, as `tavi tasks folders prune --older-than` takes it.
  const olderThanDays = integerFlag(
    daysRaw.endsWith("d") ? daysRaw.slice(0, -1) : daysRaw,
    { min: 1, max: 3_650 },
    `--older-than must be a whole number of days between 1 and 3650 (received ${JSON.stringify(daysRaw)})`,
    PRUNE_USAGE,
  );
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, PRUNE_USAGE);
  }
  return {
    command: "prune",
    prune: { olderThanDays, dryRun, includeArtifacts, format, ...dataDirectoryFlag(flags) },
  };
}

/** `tavi logs [--tail <n>] [--file <path>]`. */
export function parseLogs(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: LOGS_USAGE,
    valued: ["--tail", "--file", "--format", "--data-dir"],
    unknown: (name) => `logs does not accept ${name}`,
    positional: (token) => `Unexpected argument ${JSON.stringify(token)} for logs`,
  });
  if (args === "help") return { command: "help", usage: LOGS_USAGE };
  const { flags } = args;
  const tailRaw = flags.get("--tail") ?? "200";
  const tail = integerFlag(
    tailRaw,
    { min: 1, max: 100_000 },
    `--tail must be a positive integer (received ${JSON.stringify(tailRaw)})`,
    LOGS_USAGE,
  );
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, LOGS_USAGE);
  }
  const file = flags.get("--file");
  return {
    command: "logs",
    logs: {
      tail,
      ...(file === undefined ? {} : { file }),
      format,
      ...dataDirectoryFlag(flags),
    },
  };
}

export function parseReset(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: RESET_USAGE,
    valued: ["--format", "--data-dir"],
    switches: ["--yes"],
    unknown: (name) => `reset does not accept ${name}`,
    switchValue: (name) => `${name} does not take a value`,
    positional: (token) => `Unexpected argument ${JSON.stringify(token)} for reset`,
  });
  if (args === "help") return { command: "help", usage: RESET_USAGE };
  const { flags } = args;
  if (!args.switches.has("--yes"))
    throw new UsageError("reset deletes all of this instance's data and cannot be undone; pass --yes to confirm", RESET_USAGE);
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, RESET_USAGE);
  }
  return { command: "reset", reset: { format, ...dataDirectoryFlag(flags) } };
}

export function parseMaintenance(command: "backup" | "export" | "restore", argv: readonly string[]): ParsedCommand {
  const usage = command === "backup" ? BACKUP_USAGE : command === "export" ? EXPORT_USAGE : RESTORE_USAGE;
  const args = parseFlags(argv, {
    usage,
    valued: ["--out", "--from", "--format", "--data-dir"],
    switches: ["--force", "--no-artifacts", "--include-credentials"],
    unknown: (name) => `${command} does not accept ${name}`,
    switchValue: (name) => `${name} does not take a value`,
    positional: (token) => `Unexpected argument ${JSON.stringify(token)} for ${command}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags, switches } = args;
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, usage);
  }
  const outDirectory = flags.get("--out");
  const fromDirectory = flags.get("--from");
  if (command === "restore") {
    if (fromDirectory === undefined) throw new UsageError("restore needs --from <dir>", usage);
    if (outDirectory !== undefined) throw new UsageError("restore does not accept --out", usage);
  } else {
    if (outDirectory === undefined) throw new UsageError(`${command} needs --out <dir>`, usage);
    if (fromDirectory !== undefined) throw new UsageError(`${command} does not accept --from`, usage);
  }
  return {
    command,
    maintenance: {
      action: command,
      ...(outDirectory === undefined ? {} : { outDirectory }),
      ...(fromDirectory === undefined ? {} : { fromDirectory }),
      force: switches.has("--force"),
      includeArtifacts: !switches.has("--no-artifacts"),
      includeCredentials: switches.has("--include-credentials"),
      format,
      ...dataDirectoryFlag(flags),
    },
  };
}
