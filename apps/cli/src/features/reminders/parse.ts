import { REMINDER_SNOOZE_MAX_MINUTES, REMINDER_STATUSES, isValidTimeZone, parseReminderOffset, type ReminderStatus } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

/**
 * `tavi reminders`: the operator's reminders,
 * through the owner when one serves the directory, offline otherwise. A
 * reminder added here is delivered in the app (the Command Center's badge and
 * rail); one that goes to a chat is asked for in that chat.
 */
const REMINDERS_ACTIONS = ["list", "show", "add", "cancel", "snooze", "pause", "resume"] as const;
type RemindersAction = (typeof REMINDERS_ACTIONS)[number];

export const REMINDERS_USAGE = `tavi reminders <action> [options]

Reminders say something at a time: once, before an event, or on repeat. Those
added here are delivered in the app (the Command Center's badge and rail, and a
browser notification when turned on), or with --deliver-to home as a notice in
the person's Home. To be reminded in a chat, ask for it there.

Under a live \`tavi serve\`, every action runs on the owner over IPC; with none,
the data directory is opened directly (the owner delivers what falls due once
it starts).

Actions:
  list                       Active and paused reminders (--status to choose)
  show <id>                  One reminder, its next fires and its recent fires
  add "<text>"               Create a reminder: one of --at, --event or --repeat
  cancel <id>                Cancel a reminder
  pause <id> | resume <id>   Stop and restart a reminder (resuming starts from now)
  snooze <id> --minutes <n>  Bring the latest delivered fire back later

Options for add:
  --at <time>                Once, at an ISO time with its offset
                             (2026-10-05T10:00+02:00) or "YYYY-MM-DD HH:MM" local
  --event <time>             An event at that time, reminded before it
  --notify <offsets>         The event's notices, comma-separated (default
                             -1d@20:00,-1h: the evening before at 20:00, and one
                             hour before); each -<n>m, -<n>h, -<n>d or -<n>d@HH:MM
  --repeat <HH:MM[,HH:MM]>   Every day at these times (at most 6)
  --days <days>              With --repeat: mon-fri, sat,sun, or 0-6 (0=Sunday)
  --monthly <day|nth:weekday>
                             With --repeat: once a month, on a day of the month
                             (1-31; 31 is a shorter month's last day) or on its
                             nth weekday (2:tue, last:fri)
  --yearly <MM-DD>           With --repeat: once a year on that date (12-25);
                             02-29 fires on the 28th in a year without one
  --until <YYYY-MM-DD>       With --repeat: the last day it fires, inclusive
  --prompt <text>            Also start a task with this prompt on each fire
  --task <task-id>           add: the chat it is asked from, which lists it; list: only that chat's
  --deliver-to <app|home>    Where it is said (default app): home posts each fire,
                             and its task's result, as a notice in the person's
                             Home (the app when there is none)
  --zone <iana>              The zone local times are read in (default: the
                             workspace's, see \`tavi config get workspace.timezone\`)

Other options:
  --status <list>            list: active, paused, done, cancelled (comma-separated)
  --minutes <n>              snooze: how long, 1 to ${REMINDER_SNOOZE_MAX_MINUTES} (a week)
  --workspace <id>           Workspace (default: default)
  --principal <id>           Offline: the operator a reminder is for (default: operator)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

/** A local wall time, read in the reminder's zone when the command runs. */
interface ReminderLocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}
/** `--at`/`--event` as typed: an instant with its offset, or a local time. */
export type ReminderTimeInput = { readonly instant: string } | { readonly local: ReminderLocalTime };
export type ReminderWhenInput =
  | { readonly kind: "once"; readonly at: ReminderTimeInput }
  | { readonly kind: "event"; readonly at: ReminderTimeInput; readonly notify: readonly string[] }
  | {
      readonly kind: "repeat";
      readonly times: readonly string[];
      readonly daysOfWeek?: readonly number[];
      readonly monthly?: ReminderMonthlyInput;
      readonly yearly?: { readonly month: number; readonly day: number };
      readonly until?: string;
    };
/** `--monthly`: a day of the month, or its nth weekday (`nth: -1` the last). */
export type ReminderMonthlyInput = { readonly dayOfMonth: number } | { readonly nth: 1 | 2 | 3 | 4 | 5 | -1; readonly weekday: number };

export interface RemindersCommandOptions {
  readonly action: RemindersAction;
  readonly dataDirectory?: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly reminderId?: string;
  readonly text?: string;
  readonly when?: ReminderWhenInput;
  readonly prompt?: string;
  readonly zone?: string;
  readonly minutes?: number;
  readonly statuses?: readonly ReminderStatus[];
  /** `--task`: the chat a reminder is asked from (add), or whose reminders are listed (list). */
  readonly taskId?: string;
  /** `--deliver-to`: where an added reminder is said. */
  readonly deliverTo?: "app" | "home";
  readonly format: OutputFormat;
}

const REMINDER_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const REMINDER_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
const REMINDER_CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/** `--at`/`--event`: an ISO instant with its offset, or `YYYY-MM-DD HH:MM` local time. */
function parseReminderTime(flag: string, value: string, usage: string): ReminderTimeInput {
  const text = value.trim();
  if (REMINDER_INSTANT.test(text) && !Number.isNaN(Date.parse(text))) return { instant: text };
  const local = REMINDER_LOCAL.exec(text);
  if (local !== null) {
    const [year, month, day, hour, minute] = local.slice(1).map((part) => Number.parseInt(part, 10)) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day && hour <= 23 && minute <= 59)
      return { local: { year, month, day, hour, minute } };
  }
  throw new UsageError(
    `${flag} expects an ISO time with its offset (2026-10-05T10:00+02:00) or "YYYY-MM-DD HH:MM", received ${JSON.stringify(value)}`,
    usage,
  );
}

/** `--days`: `mon-fri`, `sat,sun`, `1,3,5` or `0-6` (0 = Sunday); a range may wrap (`fri-mon`). */
export function parseReminderDays(value: string, usage: string): readonly number[] {
  const day = (token: string): number => {
    const lowered = token.trim().toLowerCase();
    if (/^[0-6]$/.test(lowered)) return Number(lowered);
    const named = WEEKDAY_NAMES[lowered];
    if (named === undefined)
      throw new UsageError(`--days expects mon-fri, sat,sun or 0-6 (0 = Sunday), received ${JSON.stringify(value)}`, usage);
    return named;
  };
  const days = new Set<number>();
  for (const part of value.split(",")) {
    if (part.trim() === "") throw new UsageError(`--days has an empty entry: ${JSON.stringify(value)}`, usage);
    const range = part.split("-");
    if (range.length === 1) days.add(day(part));
    else if (range.length === 2) {
      const [from, to] = [day(range[0] ?? ""), day(range[1] ?? "")];
      for (let current = from; ; current = (current + 1) % 7) {
        days.add(current);
        if (current === to) break;
      }
    } else throw new UsageError(`--days expects mon-fri, sat,sun or 0-6 (0 = Sunday), received ${JSON.stringify(value)}`, usage);
  }
  return [...days].sort((a, b) => a - b);
}

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** `--monthly`: `1`..`31`, or `<1-5|last>:<weekday>` (`2:tue`, `last:fri`). */
export function parseReminderMonthly(value: string, usage: string): ReminderMonthlyInput {
  const text = value.trim().toLowerCase();
  const refuse = (): never => {
    throw new UsageError(
      `--monthly expects a day of the month (1-31) or the nth weekday (2:tue, last:fri), received ${JSON.stringify(value)}`,
      usage,
    );
  };
  if (/^\d{1,2}$/.test(text)) {
    const day = Number(text);
    return day >= 1 && day <= 31 ? { dayOfMonth: day } : refuse();
  }
  const match = /^([1-5]|last):([a-z0-6]+)$/.exec(text);
  if (match === null) return refuse();
  const token = match[2] ?? "";
  const weekday = /^[0-6]$/.test(token) ? Number(token) : WEEKDAY_NAMES[token];
  if (weekday === undefined) return refuse();
  const nth = match[1] === "last" ? -1 : (Number(match[1]) as 1 | 2 | 3 | 4 | 5);
  return { nth, weekday };
}

/** `--yearly`: `MM-DD`, a date that some year has (`02-29` included). */
export function parseReminderYearly(value: string, usage: string): { readonly month: number; readonly day: number } {
  const match = /^(\d{2})-(\d{2})$/.exec(value.trim());
  const month = Number(match?.[1]);
  const day = Number(match?.[2]);
  if (match === null || month < 1 || month > 12 || day < 1 || day > (MONTH_DAYS[month - 1] ?? 31))
    throw new UsageError(`--yearly expects a date MM-DD (12-25), received ${JSON.stringify(value)}`, usage);
  return { month, day };
}

export function parseReminders(argv: readonly string[]): ParsedCommand {
  const usage = REMINDERS_USAGE;
  const [action, ...rest] = argv;
  if (action === "-h" || action === "--help") return { command: "help", usage };
  if (action === undefined) throw new UsageError(`reminders needs an action; expected one of ${REMINDERS_ACTIONS.join(", ")}`, usage);
  if (!(REMINDERS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown reminders action ${JSON.stringify(action)}; expected one of ${REMINDERS_ACTIONS.join(", ")}`, usage);
  }
  const resolvedAction = action as RemindersAction;
  const common = ["--data-dir", "--format", "--workspace", "--principal"];
  const allowedFlags: Readonly<Record<RemindersAction, readonly string[]>> = {
    list: [...common, "--status", "--task"],
    show: common,
    add: [
      ...common,
      "--at",
      "--event",
      "--notify",
      "--repeat",
      "--days",
      "--monthly",
      "--yearly",
      "--until",
      "--prompt",
      "--zone",
      "--task",
      "--deliver-to",
    ],
    cancel: common,
    pause: common,
    resume: common,
    snooze: [...common, "--minutes"],
  };
  const args = parseFlags(rest, {
    usage,
    valued: allowedFlags[resolvedAction],
    unknown: (name) => `reminders ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags, positionals } = args;
  if (positionals.length > 1) {
    throw new UsageError(
      resolvedAction === "add"
        ? `reminders add takes the text as one argument; quote it ("take your pills")`
        : `reminders ${action} takes one reminder id`,
      usage,
    );
  }
  const positional = positionals[0];
  if (resolvedAction === "list" && positional !== undefined) throw new UsageError("reminders list takes no reminder id", usage);
  if (resolvedAction !== "list" && resolvedAction !== "add" && positional === undefined)
    throw new UsageError(`reminders ${action} needs a reminder id`, usage);

  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, usage);

  let statuses: ReminderStatus[] | undefined;
  const statusFlag = flags.get("--status");
  if (statusFlag !== undefined) {
    statuses = [];
    for (const part of statusFlag.split(",")) {
      const status = part.trim();
      if (!(REMINDER_STATUSES as readonly string[]).includes(status)) {
        throw new UsageError(
          `--status expects ${REMINDER_STATUSES.join(", ")} (comma-separated), received ${JSON.stringify(statusFlag)}`,
          usage,
        );
      }
      if (!statuses.includes(status as ReminderStatus)) statuses.push(status as ReminderStatus);
    }
  }

  let minutes: number | undefined;
  if (resolvedAction === "snooze") {
    const minutesFlag = flags.get("--minutes")?.trim();
    if (
      minutesFlag === undefined ||
      !/^\d{1,5}$/.test(minutesFlag) ||
      Number(minutesFlag) < 1 ||
      Number(minutesFlag) > REMINDER_SNOOZE_MAX_MINUTES
    )
      throw new UsageError(
        `reminders snooze needs --minutes from 1 to ${REMINDER_SNOOZE_MAX_MINUTES} (a week)${minutesFlag === undefined ? "" : `, received ${JSON.stringify(minutesFlag)}`}`,
        usage,
      );
    minutes = Number(minutesFlag);
  }

  let when: ReminderWhenInput | undefined;
  let text: string | undefined;
  if (resolvedAction === "add") {
    text = positional?.trim();
    if (text === undefined || text === "")
      throw new UsageError(`reminders add needs the reminder's text: tavi reminders add "take your pills" --repeat 21:00`, usage);
    const kinds = (["--at", "--event", "--repeat"] as const).filter((flag) => flags.has(flag));
    if (kinds.length !== 1) throw new UsageError("reminders add needs exactly one of --at, --event or --repeat", usage);
    const kind = kinds[0];
    if (kind !== "--event" && flags.has("--notify")) throw new UsageError("--notify goes with --event", usage);
    if (kind !== "--repeat" && ["--days", "--monthly", "--yearly", "--until"].some((flag) => flags.has(flag)))
      throw new UsageError("--days, --monthly, --yearly and --until go with --repeat", usage);
    if (["--days", "--monthly", "--yearly"].filter((flag) => flags.has(flag)).length > 1)
      throw new UsageError("A reminder repeats on --days, --monthly or --yearly: one of them", usage);
    if (kind === "--at") when = { kind: "once", at: parseReminderTime("--at", flags.get("--at") ?? "", usage) };
    else if (kind === "--event") {
      const notifyFlag = flags.get("--notify");
      const notify = notifyFlag === undefined ? ["-1d@20:00", "-1h"] : notifyFlag.split(",").map((part) => part.trim());
      for (const notice of notify) {
        if (parseReminderOffset(notice) === undefined) {
          throw new UsageError(
            `--notify expects notices such as -15m, -2h, -1d or -1d@20:00 (at most 30 days before), received ${JSON.stringify(notice)}`,
            usage,
          );
        }
      }
      when = { kind: "event", at: parseReminderTime("--event", flags.get("--event") ?? "", usage), notify };
    } else {
      const times = (flags.get("--repeat") ?? "").split(",").map((part) => part.trim());
      for (const time of times) {
        if (!REMINDER_CLOCK.test(time))
          throw new UsageError(
            `--repeat expects 24-hour HH:MM times, comma-separated, received ${JSON.stringify(flags.get("--repeat"))}`,
            usage,
          );
      }
      const daysFlag = flags.get("--days");
      const monthlyFlag = flags.get("--monthly");
      const yearlyFlag = flags.get("--yearly");
      const until = flags.get("--until");
      if (until !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(`${until}T00:00:00Z`)))) {
        throw new UsageError(`--until expects a date YYYY-MM-DD, received ${JSON.stringify(until)}`, usage);
      }
      when = {
        kind: "repeat",
        times,
        ...(daysFlag === undefined ? {} : { daysOfWeek: parseReminderDays(daysFlag, usage) }),
        ...(monthlyFlag === undefined ? {} : { monthly: parseReminderMonthly(monthlyFlag, usage) }),
        ...(yearlyFlag === undefined ? {} : { yearly: parseReminderYearly(yearlyFlag, usage) }),
        ...(until === undefined ? {} : { until }),
      };
    }
  }
  const zone = flags.get("--zone");
  if (zone !== undefined && !isValidTimeZone(zone)) throw new UsageError(`${JSON.stringify(zone)} is not a known IANA timezone`, usage);
  const prompt = flags.get("--prompt")?.trim();
  if (prompt !== undefined && prompt === "") throw new UsageError("--prompt needs some text", usage);
  const deliverTo = flags.get("--deliver-to");
  if (deliverTo !== undefined && deliverTo !== "app" && deliverTo !== "home")
    throw new UsageError(`--deliver-to expects app or home, received ${JSON.stringify(deliverTo)}`, usage);

  return {
    command: "reminders",
    reminders: {
      action: resolvedAction,
      workspaceId: flags.get("--workspace") ?? "default",
      principalId: flags.get("--principal") ?? "operator",
      ...(resolvedAction !== "add" && positional !== undefined ? { reminderId: positional } : {}),
      ...definedOnly({
        text,
        when,
        prompt,
        zone,
        minutes,
        statuses,
      }),
      ...(flags.get("--task") === undefined ? {} : { taskId: flags.get("--task") as string }),
      ...(deliverTo === undefined ? {} : { deliverTo }),
      format,
      ...dataDirectoryFlag(flags),
    },
  };
}
