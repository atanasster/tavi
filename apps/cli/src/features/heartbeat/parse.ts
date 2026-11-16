import { HEARTBEAT_LOG_MAX, HEARTBEAT_PAUSE_MAX_MS, HEARTBEAT_RECEIVES, HEARTBEAT_TELL_ME } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { UsageError, dataDirectoryFlag, integerFlag, parseFlags } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";
import { parseReminderDays } from "../reminders/parse.js";

const HEARTBEAT_ACTIONS = [
  "status",
  "on",
  "off",
  "pause",
  "resume",
  "every",
  "hours",
  "tell",
  "edit",
  "run-now",
  "log",
  "set-provider",
  "egress",
  "mute",
  "unmute",
  "forget",
] as const;
type HeartbeatAction = (typeof HEARTBEAT_ACTIONS)[number];

/** @public Read through the module namespace by test/cli/usage-text.test.ts, which checks every command's usage. */
export const HEARTBEAT_USAGE = `tavi heartbeat <action> [options]

The heartbeat checks, inside the hours you allow, whether anything needs you,
and tells you only then (docs/HEARTBEAT.md). Only the workspace's operator
(you) can change it.

Under a live \`tavi serve\`, every action runs on the owner over IPC; with none,
the data directory is opened directly, except run-now, which needs the owner.

Actions:
  status                     Its settings, state, and next and last check
  on | off                   Turn it on or off (off keeps its history)
  pause [--for <d>]          Pause it, for a while (30m, 2h, 1d) or until resumed
  resume                     End any pause
  every <d>                  How often it checks (15m, 30m, 1h, 2h, 4h)
  hours <HH:MM-HH:MM> [--days <days>]
                             Its active hours, and days (mon-fri, sat,sun)
  tell <mode>                urgent-now, everything-now or digest-only
  edit [--file <path>]       Edit its instructions in $EDITOR, or set them from a
                             file (- reads standard input)
  run-now                    Check now (queued behind a check in progress)
  log [--since <time|d>] [--limit <n>]
                             Its checks, newest first
  set-provider <id|builtin|off>
                             Choose who decides what is worth telling
  egress <field> on|off      What an external provider may receive:
                             instructions, signals, ledger or memory
  mute <key|prefix*> | unmute <key|prefix*>
                             Never tell about an item key, or keys under a prefix
  forget --yes               Delete its log, what it told you, its notes and its
                             tasks; its settings stay

Options:
  --revision <n>             Write only over this revision (default: the current)
  --workspace <id>           The workspace (default: default)
  --format text|json         Output format (default: text)
  --data-dir <path>          The data directory
`;

export interface HeartbeatCommandOptions {
  readonly action: HeartbeatAction;
  readonly workspaceId: string;
  /** The argument the action takes: an interval, hours, a mode, a provider, a field, a key or prefix. */
  readonly argument?: string;
  /** egress's on|off. */
  readonly on?: boolean;
  readonly forMs?: number;
  readonly days?: readonly number[];
  readonly file?: string;
  readonly since?: string;
  readonly limit?: number;
  readonly revision?: number;
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

/** `30m`, `2h`, `1d`, `45s` in milliseconds; undefined for anything else. */
export function parseHeartbeatDuration(value: string): number | undefined {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
  return amount > 0 ? amount * unit : undefined;
}

export function parseHeartbeat(argv: readonly string[]): ParsedCommand {
  const usage = HEARTBEAT_USAGE;
  const [action, ...rest] = argv;
  if (action === "-h" || action === "--help") return { command: "help", usage };
  if (action === undefined) throw new UsageError(`heartbeat needs an action; expected one of ${HEARTBEAT_ACTIONS.join(", ")}`, usage);
  if (!(HEARTBEAT_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown heartbeat action ${JSON.stringify(action)}; expected one of ${HEARTBEAT_ACTIONS.join(", ")}`, usage);
  }
  const resolvedAction = action as HeartbeatAction;
  const common = ["--data-dir", "--format", "--workspace"];
  const writes = [...common, "--revision"];
  const allowedFlags: Readonly<Record<HeartbeatAction, readonly string[]>> = {
    status: common,
    on: writes,
    off: writes,
    pause: [...common, "--for"],
    resume: common,
    every: writes,
    hours: [...writes, "--days"],
    tell: writes,
    edit: [...writes, "--file"],
    "run-now": common,
    log: [...common, "--since", "--limit"],
    "set-provider": writes,
    egress: writes,
    mute: writes,
    unmute: writes,
    forget: [...common, "--yes"],
  };
  const takes: Readonly<Record<HeartbeatAction, number>> = {
    status: 0,
    on: 0,
    off: 0,
    pause: 0,
    resume: 0,
    every: 1,
    hours: 1,
    tell: 1,
    edit: 0,
    "run-now": 0,
    log: 0,
    "set-provider": 1,
    egress: 2,
    mute: 1,
    unmute: 1,
    forget: 0,
  };
  const args = parseFlags(rest, {
    usage,
    valued: allowedFlags[resolvedAction],
    switches: allowedFlags[resolvedAction].filter((flag) => flag === "--yes"),
    switchesInFlags: true,
    unknown: (name) => `heartbeat ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags, positionals } = args;
  if (positionals.length !== takes[resolvedAction]) {
    throw new UsageError(
      takes[resolvedAction] === 0
        ? `heartbeat ${action} takes no argument`
        : `heartbeat ${action} takes ${takes[resolvedAction] === 1 ? "one argument" : "two arguments"}`,
      usage,
    );
  }
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, usage);
  const argument = positionals[0];
  if (resolvedAction === "every" && parseHeartbeatDuration(argument ?? "") === undefined)
    throw new UsageError(`heartbeat every expects a duration such as 30m or 1h, received ${JSON.stringify(argument)}`, usage);
  if (resolvedAction === "hours" && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(argument ?? ""))
    throw new UsageError(`heartbeat hours expects HH:MM-HH:MM, received ${JSON.stringify(argument)}`, usage);
  if (resolvedAction === "tell" && !(HEARTBEAT_TELL_ME as readonly string[]).includes(argument ?? ""))
    throw new UsageError(`heartbeat tell expects ${HEARTBEAT_TELL_ME.join(", ")}, received ${JSON.stringify(argument)}`, usage);
  if (resolvedAction === "egress" && !(HEARTBEAT_RECEIVES as readonly string[]).includes(argument ?? ""))
    throw new UsageError(`heartbeat egress expects ${HEARTBEAT_RECEIVES.join(", ")}, received ${JSON.stringify(argument)}`, usage);
  const onOff = positionals[1];
  if (resolvedAction === "egress" && onOff !== "on" && onOff !== "off")
    throw new UsageError(`heartbeat egress ${argument ?? ""} expects on or off, received ${JSON.stringify(onOff)}`, usage);
  if (resolvedAction === "forget" && flags.get("--yes") !== "true")
    throw new UsageError(
      "forget deletes the heartbeat's log, what it told you, its notes and its tasks, and cannot be undone; pass --yes to confirm",
      usage,
    );
  const forFlag = flags.get("--for");
  const forMs = forFlag === undefined ? undefined : parseHeartbeatDuration(forFlag);
  if (forFlag !== undefined && forMs === undefined)
    throw new UsageError(`--for expects a duration such as 30m, 2h or 1d, received ${JSON.stringify(forFlag)}`, usage);
  if (forMs !== undefined && forMs > HEARTBEAT_PAUSE_MAX_MS)
    throw new UsageError("--for is at most 7d; for longer, pause without --for and resume when you want", usage);
  const revisionFlag = flags.get("--revision");
  // 0 is a heartbeat never saved: a write held to it is refused if a first save was made meanwhile.
  const revision =
    revisionFlag === undefined
      ? undefined
      : integerFlag(
          revisionFlag,
          { min: 0 },
          `--revision expects a whole number (0 for a heartbeat never saved), received ${JSON.stringify(revisionFlag)}`,
          usage,
        );
  const limitFlag = flags.get("--limit");
  const limit =
    limitFlag === undefined
      ? undefined
      : integerFlag(
          limitFlag,
          { min: 1, max: HEARTBEAT_LOG_MAX },
          `--limit expects 1 to ${HEARTBEAT_LOG_MAX}, received ${JSON.stringify(limitFlag)}`,
          usage,
        );
  const sinceFlag = flags.get("--since");
  let since: string | undefined;
  if (sinceFlag !== undefined) {
    const back = parseHeartbeatDuration(sinceFlag);
    if (back !== undefined) since = new Date(Date.now() - back).toISOString();
    else if (!Number.isNaN(Date.parse(sinceFlag))) since = new Date(sinceFlag).toISOString();
    else throw new UsageError(`--since expects an ISO time or a duration such as 24h, received ${JSON.stringify(sinceFlag)}`, usage);
  }
  const daysFlag = flags.get("--days");
  return {
    command: "heartbeat",
    heartbeat: {
      action: resolvedAction,
      workspaceId: flags.get("--workspace") ?? "default",
      ...(argument === undefined ? {} : { argument }),
      ...(resolvedAction === "egress" ? { on: onOff === "on" } : {}),
      ...(forMs === undefined ? {} : { forMs }),
      ...(daysFlag === undefined ? {} : { days: parseReminderDays(daysFlag, usage) }),
      ...(flags.get("--file") === undefined ? {} : { file: flags.get("--file") as string }),
      ...definedOnly({
        since,
        limit,
        revision,
      }),
      format,
      ...dataDirectoryFlag(flags),
    },
  };
}
