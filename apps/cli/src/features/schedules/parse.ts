import { isAbsolute } from "node:path";

import {
  AGENDA_MAX_DAYS,
  SCHEDULE_DEFAULT_MAX_RUN_MINUTES,
  SCHEDULE_HUMAN_CHECKPOINTS,
  SCHEDULE_MAX_EVERY_HOURS,
  SCHEDULE_MAX_TIMES_PER_DAY,
  SCHEDULE_NOTHING_TO_REPORT,
  SCHEDULE_NOTIFY_MODES,
  SCHEDULE_ONE_CALL_TOKENS,
  SCHEDULE_WATCH_DEFAULT_EVERY_HOURS,
  SCHEDULE_WATCH_MAX_PER_HOUR,
  SCHEDULE_WEBHOOK_MAX_PER_HOUR,
  SCHEDULE_WEBHOOK_MODES,
  hostTimeZone,
  type ScheduleWebhookMode,
  type ScheduleEmailTriggerInput,
  ScheduleEmailTriggerInputSchema,
  ScheduleMaxRunMinutesSchema,
  ScheduleMaxTokensSchema,
  isValidTimeZone,
  parseSchedulePrecheck,
  schedulePrecheckText,
  parseTokenCount,
  parseScheduleWindow,
  tokenCountText,
  type ScheduleHumanCheckpoints,
  type ScheduleNotify,
  type ReminderMonthly,
  type ReminderYearly,
  AGENDA_MAX_LIMIT,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags, removalAlias } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";
import { AGENT_ID_PATTERN } from "../agents/parse.js";
import { parseReminderMonthly, parseReminderYearly } from "../reminders/parse.js";

/**
 * `tavi schedules`.
 *
 * The operator's only way to author the unattended policy a schedule needs: which
 * prompt a schedule runs, which tools it may call without a human present, and
 * where a failure alert goes. A schedule is a grant of standing permission:
 * the agent's `schedules.*` tools write through the same validation, but only
 * read-only tools without a person's approval on a card, and never an alert
 * target or an agent to run as — those are set here.
 */
const SCHEDULES_ACTIONS = [
  "add",
  "watch",
  "update",
  "list",
  "show",
  "remove",
  "enable",
  "disable",
  "run-now",
  "agenda",
  "webhook",
  "email-trigger",
] as const;
type SchedulesAction = (typeof SCHEDULES_ACTIONS)[number];

export const SCHEDULES_USAGE = `tavi schedules <action> [options]

Author recurring unattended runs, and which tools each one may use. A
schedule runs as the person who created it, with the grants they already gave.

Under a live \`tavi serve\`, every action runs on the owner over IPC:
run-now fires on its scheduler and follows the run (Ctrl-C detaches), with the
owner's credentials (--api-key-file is refused) and target (--connection/--model
must name it).

Actions:
  add                        Create a schedule
  watch <name> --page <https url> | --feed <https url> | --file <path>
                             Create a watcher: a schedule that checks on a
                             cadence (--every, default every hour) and runs
                             only when the page, feed or file changed; a check
                             that finds nothing new makes no model call. A file
                             watcher also checks about 30 s after its file
                             changes while \`tavi serve\` runs (at most once a
                             minute and ${SCHEDULE_WATCH_MAX_PER_HOUR} an hour). Takes add's options but
                             --name, --at, --every-hours and --precheck
  update <id|name>           Change supplied fields; omitted fields stay as stored
  list                       List schedules in the workspace
  show <id|name>             Show one schedule, including its effective policy
  remove <id|name>           Delete a schedule (alias: rm, delete)
  enable|disable <id|name>   Arm or disarm it (disabling clears the next fire)
  run-now <id|name>          Run it once, immediately, without disturbing its
                             next scheduled fire (needs a model connection)
  agenda                     Every upcoming occurrence of routine triggers,
                             schedules and reminders, sorted by time (--days
                             window, default 7)
  webhook <id|name> on|off|rotate
                             Let a call to POST <public address>/hooks/schedules/<id>
                             on the webhook listener fire it now (off by
                             default). on and rotate print a new secret once;
                             only its SHA-256 is kept. A call sends it as a
                             bearer token, or signs with the signing key; what
                             it carries (at most 8 KiB) reaches the run as
                             untrusted data, and the run starts tainted. At most
                             one fire a minute and ${SCHEDULE_WEBHOOK_MAX_PER_HOUR} an hour
  email-trigger <id|name> on --connection <id> --from <addr|@domain>[,…] [--subject <text>]
  email-trigger <id|name> off
                             Let an email on an email connection that checks
                             each sender fire it now (off by default), only
                             from a listed sender whose domain the channel
                             verified (the domain, not the person; @domain of a
                             public mailbox such as @outlook.com is refused);
                             --subject also needs the subject to hold
                             that text. The run is tainted and read-only: no
                             tool that changes, sends or fetches anything runs,
                             whatever --allow says, besides its own delivery.
                             Its subject and text (at most 8 KiB) reach it as
                             untrusted data. A matching email is the trigger's,
                             never also a chat message. At most one fire a
                             minute and ${SCHEDULE_WEBHOOK_MAX_PER_HOUR} an hour

Options:
  --name <name>              Schedule name (required for add; unique per workspace)
  --at <HH:MM[,HH:MM]>       Local wall-clock time, or up to ${SCHEDULE_MAX_TIMES_PER_DAY} a day
                             (07:00,19:00); add needs --at or --every-hours
  --every-hours <n>          Every n hours (1-${SCHEDULE_MAX_EVERY_HOURS}) instead of --at, from 00:00
                             or through --between
  --between <HH:MM-HH:MM>    With --every-hours: the window it runs in, e.g.
                             08:00-18:00 (both ends included)
  --timezone <iana>          IANA zone for --at (required for add), e.g. Europe/Sofia
  --prompt <text>            The instruction admitted to the model (required for add)
  --allow <tool>             Tool the schedule may call unattended (repeatable;
                             exact id or \`prefix.*\` family). Omit to deny every
                             tool — allowlisting is deliberate, not implied.
                             \`*\` is refused: it grants every tool including
                             \`sandbox.run\`, and hides what was granted.
  --days <0-6,...|none>      Days of the week to fire on, 0=Sunday (default: daily;
                             update: none fires every day again, dropping
                             --monthly, --yearly and --once too);
                             for agenda, the window in days (1-31, default 7)
  --monthly <day|nth:weekday>
                             Once a month instead: a day of the month (1-31;
                             31 is a shorter month's last day) or its nth
                             weekday (2:tue, last:fri)
  --yearly <MM-DD>           Once a year instead, on that date (02-29 fires on
                             the 28th in a year without one)
  --once <YYYY-MM-DD>        Only on that date; the schedule then finishes
  --until <YYYY-MM-DD|none>  The last date it runs on, inclusive; it then
                             finishes (update: none runs on with no end)
  --limit <n>                agenda: the most occurrences to list (1-200, default 100)
  --missed <policy>          run-once-if-missed-within-6h | skip (default: the former)
  --agent <id>               Run as this named agent (see \`tavi agents\`)
  --no-agent                 update: run on the base instructions again
  --alert-connection <id>    Messaging connection for failure alerts
  --alert-destination <id>   Conversation to alert (e.g. a chat id)
  --no-alert                 update: send no failure alerts (clears both)
  --checkpoints <mode>       off | ask-with-default: whether a fire may ask a
                             question in the alert destination, always with
                             the option it takes if nobody answers before the
                             next fire (default: off; needs an alert destination)
  --deliver-to <home|none>   home: post each run's result into the person's Home
                             as a notice when it settles (it then needs no
                             messaging.send_to of its own); none stops it
  --max-run-minutes <n>      How long a fire's run may work before it is
                             stopped, recorded failed and alerted (1-1440,
                             default ${SCHEDULE_DEFAULT_MAX_RUN_MINUTES}); waiting on a person's answer does
                             not count
  --max-tokens <n|off>       How many tokens a fire's run, its workers
                             included, may use before it is stopped, recorded
                             failed and alerted (1000-100000000; default: no
                             ceiling; update: off removes it); counted as each
                             model call ends, so a run can go past it by one
  --notify <mode>            always | when-sent | if-changed: when a run that
                             went well tells you. when-sent: only when it sends
                             something (a run with nothing to send, or that
                             ends with ${SCHEDULE_NOTHING_TO_REPORT}, is a quiet success);
                             if-changed: never the same result twice in a row.
                             Failures are always told (default: always)
  --precheck <check|none>    A read-only look before each scheduled fire; a
                             fire it finds nothing new for is recorded
                             unchanged and makes no model call (default:
                             none; update: none removes it):
                               page-changed:<https url>  the page's text changed
                               feed-has-new:<https url>  an RSS/Atom feed has
                                                         new items
                               file-changed:<path>       a file under an
                                                         --fs-root changed
                             The run is told what changed (the address or
                             path) and reads it itself. A page or feed is
                             fetched from its own host over the guarded public
                             fetch; a file needs a running owner
  --folder <path|off>        A folder under an --fs-root that each run works
                             in, as a chat's folder (default: each run's own
                             folder; update: off removes it). Checked by the
                             running owner when set and at each run; give a
                             file watcher its file's folder so the run can
                             read the file
  --every <n>h               watch: how often it checks, 1h-${SCHEDULE_MAX_EVERY_HOURS}h (default ${SCHEDULE_WATCH_DEFAULT_EVERY_HOURS}h;
                             60m-720m in whole hours also works)
  --watch <on|off>           update: make a schedule with a pre-check a
                             watcher, or stop it being one
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export interface SchedulesCommandOptions {
  /** `watch` is parsed as the `add` of a watcher. */
  readonly action: Exclude<SchedulesAction, "watch">;
  readonly dataDirectory?: string;
  readonly workspaceId: string;
  readonly principalId: string;
  /** `run-now` only: the model target, resolved exactly as `tavi run` resolves it. */
  readonly connectionId?: string;
  readonly model?: string;
  readonly apiKeyFile?: string;
  /** Positional schedule id or name, for every action but `add`/`list`. */
  readonly scheduleRef?: string;
  readonly name?: string;
  readonly at?: string;
  /** `--at` with several times. */
  readonly times?: readonly string[];
  readonly everyHours?: number;
  /** `--between`'s window; `null` is never parsed (it is cleared with `--at`). */
  readonly between?: { readonly from: string; readonly to: string };
  readonly monthly?: ReminderMonthly;
  readonly yearly?: ReminderYearly;
  readonly once?: string;
  /** `null`: `--until none` on update. */
  readonly until?: string | null;
  readonly timezone?: string;
  readonly prompt?: string;
  readonly allow?: readonly string[];
  /** `null`: `--days none` on update, every day again. */
  readonly days?: readonly number[] | null;
  readonly missed?: string;
  /** `null` with `alertDestination`: `--no-alert` on update. */
  readonly alertConnection?: string | null;
  readonly alertDestination?: string | null;
  /** `--checkpoints`: whether a fire may ask, with a default. */
  readonly humanCheckpoints?: ScheduleHumanCheckpoints;
  /** `--deliver-to`: post each run's result into Home, or stop. */
  readonly deliverTo?: "home" | "none";
  /** `--max-run-minutes`: how long a fire's run may work before it is stopped. */
  readonly maxRunMinutes?: number;
  /** `--max-tokens`: how many tokens a fire's run may use before it is stopped. `null`: `off` on update. */
  readonly maxTokens?: number | null;
  /** `--notify`: when a run that went well tells its person. */
  readonly notify?: ScheduleNotify;
  /** `--precheck`, as typed back (`page-changed:https://…`). `null`: `none` on update. */
  readonly precheck?: string | null;
  /** `--folder`: the host folder its fires work in, checked by the owner. `null`: `off` on update. */
  readonly folder?: string | null;
  /** A watcher (`watch`, which is an `add` of one), or `--watch on|off` on update. */
  readonly watch?: boolean;
  /** The named agent this schedule runs as; see `AgentsCommandOptions`. `null`: `--no-agent` on update. */
  readonly agentId?: string | null;
  /** `agenda`: the window in days from now (`--days`, 1–31). */
  readonly agendaDays?: number;
  /** `agenda`: the most occurrences to list (`--limit`, 1–200). */
  readonly agendaLimit?: number;
  /** `webhook`: what to do with the schedule's webhook. */
  readonly webhook?: ScheduleWebhookMode;
  /** `email-trigger`: turn it off, or on listening as given. */
  readonly emailTrigger?: "off" | ScheduleEmailTriggerInput;
  readonly format: OutputFormat;
}

export function parseSchedules(argv: readonly string[]): ParsedCommand {
  const [typed, ...rest] = argv;
  // `rm`, `remove` and `delete` all name the removal.
  const action = removalAlias(typed, "remove");
  // `--help` is a request for this page; a missing action is not success
  if (action === "-h" || action === "--help") return { command: "help", usage: SCHEDULES_USAGE };
  if (action === undefined) {
    throw new UsageError(`schedules needs an action; expected one of ${SCHEDULES_ACTIONS.join(", ")}`, SCHEDULES_USAGE);
  }
  if (!(SCHEDULES_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `Unknown schedules action ${JSON.stringify(action)}; expected one of ${SCHEDULES_ACTIONS.join(", ")}`,
      SCHEDULES_USAGE,
    );
  }
  if (action === "watch") return parseWatch(rest);
  const resolvedAction = action as Exclude<SchedulesAction, "watch">;
  const addOnly = [
    "--name",
    "--at",
    "--timezone",
    "--prompt",
    "--allow",
    "--days",
    "--every-hours",
    "--between",
    "--monthly",
    "--yearly",
    "--once",
    "--until",
    "--missed",
    "--agent",
    "--alert-connection",
    "--alert-destination",
    "--checkpoints",
    "--deliver-to",
    "--max-run-minutes",
    "--max-tokens",
    "--notify",
    "--precheck",
    "--folder",
  ];
  const common = ["--data-dir", "--format", "--workspace", "--principal"];
  const allowedFlags: Readonly<Record<Exclude<SchedulesAction, "watch">, readonly string[]>> = {
    add: [...addOnly, ...common],
    update: [...addOnly.filter((flag) => flag !== "--name"), "--watch", ...common],
    list: common,
    show: common,
    remove: common,
    enable: common,
    disable: common,
    // `run-now` admits a real run, so it needs the same model-target flags
    // `tavi run` does — the same `resolveModelTarget` path resolves them.
    "run-now": [...common, "--connection", "--model", "--api-key-file"],
    agenda: [...common, "--days", "--limit"],
    webhook: common,
    "email-trigger": [...common, "--connection", "--from", "--subject"],
  };
  // Clearing a field is a change to a schedule that has one: `update` only.
  const clearing = resolvedAction === "update" ? ["--no-agent", "--no-alert"] : [];
  const args = parseFlags(rest, {
    usage: SCHEDULES_USAGE,
    valued: allowedFlags[resolvedAction],
    switches: clearing,
    lists: ["--allow"],
    unknown: (name) => `schedules ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage: SCHEDULES_USAGE };
  const { flags, positionals } = args;
  const allow = args.lists.get("--allow") ?? [];

  const scheduleRef = positionals[0];
  const webhook = resolvedAction === "webhook" ? positionals[1] : undefined;
  const emailTrigger =
    resolvedAction === "email-trigger" && scheduleRef !== undefined ? parseEmailTrigger(positionals[1], flags) : undefined;
  if (positionals.length > (resolvedAction === "webhook" || resolvedAction === "email-trigger" ? 2 : 1)) {
    throw new UsageError(`schedules ${action} takes at most one schedule id or name`, SCHEDULES_USAGE);
  }
  if (resolvedAction === "webhook" && scheduleRef !== undefined && !(SCHEDULE_WEBHOOK_MODES as readonly string[]).includes(webhook ?? ""))
    throw new UsageError(`schedules webhook needs ${SCHEDULE_WEBHOOK_MODES.join(", ")} after the schedule`, SCHEDULES_USAGE);
  if (resolvedAction === "agenda" && scheduleRef !== undefined) {
    throw new UsageError("schedules agenda takes no schedule id or name", SCHEDULES_USAGE);
  }
  if (resolvedAction !== "add" && resolvedAction !== "list" && resolvedAction !== "agenda" && scheduleRef === undefined) {
    throw new UsageError(`schedules ${resolvedAction} needs a schedule id or name`, SCHEDULES_USAGE);
  }

  if (resolvedAction === "add") {
    for (const required of ["--name", "--at", "--timezone", "--prompt"]) {
      if (flags.get(required) === undefined && !(required === "--at" && flags.get("--every-hours") !== undefined)) {
        throw new UsageError(`schedules add needs ${required}${required === "--at" ? " (or --every-hours)" : ""}`, SCHEDULES_USAGE);
      }
    }
  }
  const cadence = parseCadenceFlags(flags, resolvedAction);

  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, SCHEDULES_USAGE);
  }
  const daysFlag = resolvedAction === "agenda" ? undefined : flags.get("--days");
  const agendaDaysFlag = resolvedAction === "agenda" ? flags.get("--days") : undefined;
  if (
    agendaDaysFlag !== undefined &&
    (!/^\d{1,2}$/.test(agendaDaysFlag) || Number(agendaDaysFlag) < 1 || Number(agendaDaysFlag) > AGENDA_MAX_DAYS)
  ) {
    throw new UsageError(`--days for agenda expects 1-${AGENDA_MAX_DAYS}, received ${JSON.stringify(agendaDaysFlag)}`, SCHEDULES_USAGE);
  }
  const agendaLimitFlag = flags.get("--limit");
  if (
    agendaLimitFlag !== undefined &&
    (!/^\d{1,3}$/.test(agendaLimitFlag) || Number(agendaLimitFlag) < 1 || Number(agendaLimitFlag) > AGENDA_MAX_LIMIT)
  ) {
    throw new UsageError(`--limit expects 1-${AGENDA_MAX_LIMIT}, received ${JSON.stringify(agendaLimitFlag)}`, SCHEDULES_USAGE);
  }
  if (daysFlag === "none" && resolvedAction !== "update")
    throw new UsageError("--days none clears a schedule's days: it is for update only", SCHEDULES_USAGE);
  const days =
    daysFlag === undefined
      ? undefined
      : daysFlag === "none"
        ? null
        : daysFlag.split(",").map((part) => {
            const trimmed = part.trim();
            // Anchored, not `Number.parseInt`: `parseInt("1abc")` is 1, so
            // `--days 1abc` silently meant Monday instead of being rejected.
            if (!/^[0-6]$/.test(trimmed)) {
              throw new UsageError(`--days expects 0-6 comma-separated, received ${JSON.stringify(daysFlag)}`, SCHEDULES_USAGE);
            }
            return Number.parseInt(trimmed, 10);
          });

  // Validated here rather than left to `nextOccurrence`, which throws and would
  // surface as an INTERNAL (70) failure for what is a plain typo.
  const timezoneFlag = flags.get("--timezone");
  if (timezoneFlag !== undefined && !isValidTimeZone(timezoneFlag))
    throw new UsageError(`${JSON.stringify(timezoneFlag)} is not a known IANA timezone`, SCHEDULES_USAGE);

  // Read once into locals: `exactOptionalPropertyTypes` distinguishes "absent"
  // from "present but undefined", and a second `flags.get(...)` call is not
  // narrowed by the first check.
  const name = flags.get("--name");
  const timezone = flags.get("--timezone");
  const prompt = flags.get("--prompt");
  const missed = flags.get("--missed");
  const alertConnection = flags.get("--alert-connection");
  const alertDestination = flags.get("--alert-destination");
  const deliverTo = flags.get("--deliver-to");
  if (deliverTo !== undefined && deliverTo !== "home" && deliverTo !== "none")
    throw new UsageError("--deliver-to must be home or none", SCHEDULES_USAGE);
  const maxRunMinutesFlag = flags.get("--max-run-minutes");
  if (
    maxRunMinutesFlag !== undefined &&
    (!/^\d{1,4}$/.test(maxRunMinutesFlag) || !ScheduleMaxRunMinutesSchema.safeParse(Number(maxRunMinutesFlag)).success)
  )
    throw new UsageError(`--max-run-minutes expects 1-1440, received ${JSON.stringify(maxRunMinutesFlag)}`, SCHEDULES_USAGE);
  const maxTokensFlag = flags.get("--max-tokens");
  const maxTokens =
    maxTokensFlag === undefined
      ? undefined
      : maxTokensFlag.trim().toLowerCase() === "off"
        ? null
        : parseTokenCount(maxTokensFlag, ScheduleMaxTokensSchema);
  if (maxTokens === undefined && maxTokensFlag !== undefined)
    throw new UsageError(`--max-tokens expects 1000-100000000 or off, received ${JSON.stringify(maxTokensFlag)}`, SCHEDULES_USAGE);
  if (maxTokens === null && resolvedAction === "add")
    throw new UsageError("--max-tokens off is for update; omit it instead", SCHEDULES_USAGE);
  const notify = flags.get("--notify");
  const folderFlag = flags.get("--folder");
  const folder = folderFlag === undefined ? undefined : folderFlag.trim().toLowerCase() === "off" ? null : folderFlag;
  if (folder === null && resolvedAction === "add") throw new UsageError("--folder off is for update; omit it instead", SCHEDULES_USAGE);
  if (folder !== undefined && folder !== null && !isAbsolute(folder))
    throw new UsageError(`--folder expects an absolute path or off, received ${JSON.stringify(folder)}`, SCHEDULES_USAGE);
  if (notify !== undefined && !(SCHEDULE_NOTIFY_MODES as readonly string[]).includes(notify))
    throw new UsageError(`--notify must be one of ${SCHEDULE_NOTIFY_MODES.join(", ")}`, SCHEDULES_USAGE);
  const precheckFlag = flags.get("--precheck");
  const precheck = precheckFlag === undefined ? undefined : parseSchedulePrecheck(precheckFlag);
  if (precheck !== undefined && !precheck.ok) throw new UsageError(`--precheck: ${precheck.message}`, SCHEDULES_USAGE);
  if (precheck?.ok === true && precheck.precheck === null && resolvedAction === "add")
    throw new UsageError("--precheck none is for update; omit it instead", SCHEDULES_USAGE);
  const watchFlag = flags.get("--watch");
  if (watchFlag !== undefined && watchFlag !== "on" && watchFlag !== "off")
    throw new UsageError("--watch must be on or off", SCHEDULES_USAGE);
  const checkpoints = flags.get("--checkpoints");
  if (checkpoints !== undefined && !(SCHEDULE_HUMAN_CHECKPOINTS as readonly string[]).includes(checkpoints)) {
    throw new UsageError(`--checkpoints must be one of ${SCHEDULE_HUMAN_CHECKPOINTS.join(", ")}`, SCHEDULES_USAGE);
  }
  const agentId = flags.get("--agent");
  if (agentId !== undefined && !AGENT_ID_PATTERN.test(agentId)) {
    throw new UsageError(`${JSON.stringify(agentId)} is not a valid agent id`, SCHEDULES_USAGE);
  }
  const noAgent = args.switches.has("--no-agent");
  const noAlert = args.switches.has("--no-alert");
  if (noAgent && agentId !== undefined) throw new UsageError("--agent and --no-agent cannot be given together", SCHEDULES_USAGE);
  if (noAlert && (alertConnection !== undefined || alertDestination !== undefined))
    throw new UsageError("--no-alert cannot be given with --alert-connection or --alert-destination", SCHEDULES_USAGE);

  // Same defaults `tavi run` uses; a schedule written under a different
  // workspace than the one an operator expects is a silent no-fire.
  const connectionId = resolvedAction === "email-trigger" ? undefined : flags.get("--connection");
  const model = flags.get("--model");
  const apiKeyFile = flags.get("--api-key-file");

  return {
    command: "schedules",
    schedules: {
      action: resolvedAction,
      workspaceId: flags.get("--workspace") ?? "default",
      principalId: flags.get("--principal") ?? "operator",
      ...definedOnly({
        connectionId,
        model,
        apiKeyFile,
        scheduleRef,
        name,
        timezone,
        prompt,
      }),
      ...cadence,
      ...(allow.length === 0 ? {} : { allow }),
      ...(days === undefined ? {} : { days }),
      ...(agendaDaysFlag === undefined ? {} : { agendaDays: Number(agendaDaysFlag) }),
      ...(agendaLimitFlag === undefined ? {} : { agendaLimit: Number(agendaLimitFlag) }),
      ...definedOnly({
        missed,
        alertConnection,
        alertDestination,
      }),
      ...(noAlert ? { alertConnection: null, alertDestination: null } : {}),
      ...(checkpoints === undefined ? {} : { humanCheckpoints: checkpoints as ScheduleHumanCheckpoints }),
      ...(deliverTo === undefined ? {} : { deliverTo }),
      ...(maxRunMinutesFlag === undefined ? {} : { maxRunMinutes: Number(maxRunMinutesFlag) }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(notify === undefined ? {} : { notify: notify as ScheduleNotify }),
      ...(folder === undefined ? {} : { folder }),
      ...(precheck?.ok === true ? { precheck: precheck.precheck === null ? null : schedulePrecheckText(precheck.precheck) } : {}),
      ...(watchFlag === undefined ? {} : { watch: watchFlag === "on" }),
      ...(agentId === undefined ? {} : { agentId }),
      ...(noAgent ? { agentId: null } : {}),
      ...(webhook === undefined ? {} : { webhook: webhook as ScheduleWebhookMode }),
      ...(emailTrigger === undefined ? {} : { emailTrigger }),
      format,
      // Was the bug that made every `--data-dir` in a test write to the default
      // directory: the flag was accepted above but never propagated, so the
      // command silently used the default directory and a second run collided with the first.
      ...dataDirectoryFlag(flags),
    },
  };
}

/** `email-trigger <schedule> on --connection … --from …[ --subject …]` or `… off`, checked as the owner checks it. */
function parseEmailTrigger(mode: string | undefined, flags: ReadonlyMap<string, string>): "off" | ScheduleEmailTriggerInput {
  const connectionId = flags.get("--connection");
  const from = flags.get("--from");
  const subject = flags.get("--subject");
  if (mode === "off") {
    if (connectionId !== undefined || from !== undefined || subject !== undefined)
      throw new UsageError("schedules email-trigger off takes no --connection, --from or --subject", SCHEDULES_USAGE);
    return "off";
  }
  if (mode !== "on") throw new UsageError("schedules email-trigger needs on or off after the schedule", SCHEDULES_USAGE);
  if (connectionId === undefined || from === undefined)
    throw new UsageError(
      "schedules email-trigger on needs --connection <email connection> and --from <sender>[,<sender>…]",
      SCHEDULES_USAGE,
    );
  const parsed = ScheduleEmailTriggerInputSchema.safeParse({
    connectionId,
    senders: from
      .split(",")
      .map((sender) => sender.trim())
      .filter((sender) => sender !== ""),
    ...(subject === undefined ? {} : { subject }),
  });
  if (!parsed.success)
    throw new UsageError(`schedules email-trigger: ${parsed.error.issues[0]?.message ?? "invalid trigger"}`, SCHEDULES_USAGE);
  return parsed.data;
}

/** What a watcher watches: `--page`, `--feed` or `--file`, and the pre-check each makes. */
const WATCH_TARGETS = { "--page": "page-changed", "--feed": "feed-has-new", "--file": "file-changed" } as const;

/** The flags `watch` takes of `add`'s: all but those that say when it runs or what it checks, which `watch` sets. */
const WATCH_ADD_FLAGS = [
  "--prompt",
  "--timezone",
  "--allow",
  "--between",
  "--days",
  "--until",
  "--missed",
  "--agent",
  "--alert-connection",
  "--alert-destination",
  "--checkpoints",
  "--deliver-to",
  "--max-run-minutes",
  "--max-tokens",
  "--notify",
  "--folder",
];

/**
 * `--every` for a watcher, in whole hours: `2h`, `2`, `120m`. A cadence's step is
 * an hour or more, a model's run at most once an hour; a file watcher reacts to
 * a change sooner while the owner serves.
 */
export function parseWatchEvery(text: string): number | undefined {
  const match = /^(\d{1,4})\s*(h|hours?|m|min|minutes?)?$/i.exec(text.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const minutes = /^m/i.test(match[2] ?? "");
  if (minutes && amount % 60 !== 0) return undefined;
  const hours = minutes ? amount / 60 : amount;
  return hours >= 1 && hours <= SCHEDULE_MAX_EVERY_HOURS ? hours : undefined;
}

/**
 * `schedules watch <name> --page|--feed|--file <target> [--every <n>h] --prompt …`:
 * an `add` of a watcher — the pre-check its target names, every `--every` hours
 * (one by default) through the day or `--between`, in `--timezone` (this
 * machine's zone by default), marked `watch`.
 */
function parseWatch(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: SCHEDULES_USAGE,
    valued: [...Object.keys(WATCH_TARGETS), "--every", ...WATCH_ADD_FLAGS, "--data-dir", "--format", "--workspace", "--principal"],
    switches: [],
    lists: ["--allow"],
    unknown: (name) =>
      `schedules watch does not accept ${name}${["--at", "--every-hours", "--precheck", "--name"].includes(name) ? ": watch sets it" : ""}`,
  });
  if (args === "help") return { command: "help", usage: SCHEDULES_USAGE };
  const [name, ...extra] = args.positionals;
  if (name === undefined || extra.length > 0) throw new UsageError("schedules watch takes the watcher's name, once", SCHEDULES_USAGE);
  const targets = Object.entries(WATCH_TARGETS).filter(([flag]) => args.flags.get(flag) !== undefined);
  const [chosen, ...more] = targets;
  if (chosen === undefined || more.length > 0)
    throw new UsageError("schedules watch needs one of --page <https url>, --feed <https url> or --file <path>", SCHEDULES_USAGE);
  const [targetFlag, kind] = chosen;
  const precheck = parseSchedulePrecheck(`${kind}:${args.flags.get(targetFlag) ?? ""}`);
  if (!precheck.ok || precheck.precheck === null)
    throw new UsageError(`${targetFlag}: ${precheck.ok ? "a target is needed" : precheck.message}`, SCHEDULES_USAGE);
  const everyFlag = args.flags.get("--every");
  const everyHours = everyFlag === undefined ? SCHEDULE_WATCH_DEFAULT_EVERY_HOURS : parseWatchEvery(everyFlag);
  if (everyHours === undefined)
    throw new UsageError(
      `--every expects 1h-${SCHEDULE_MAX_EVERY_HOURS}h (or minutes in whole hours), received ${JSON.stringify(everyFlag)}: a watcher's model runs at most once an hour${kind === "file-changed" ? ", and a file watcher also checks soon after its file changes while `tavi serve` runs" : ""}`,
      SCHEDULES_USAGE,
    );
  if (args.flags.get("--prompt") === undefined) throw new UsageError("schedules watch needs --prompt", SCHEDULES_USAGE);
  const flags = new Map(args.flags);
  flags.set("--name", name);
  flags.set("--every-hours", String(everyHours));
  flags.set("--precheck", schedulePrecheckText(precheck.precheck));
  if (!flags.has("--timezone")) flags.set("--timezone", hostTimeZone());
  // Inline, so a value that starts with "--" stays a value.
  const rebuilt = [...flags].flatMap(([flag, value]) => (flag in WATCH_TARGETS || flag === "--every" ? [] : [`${flag}=${value}`]));
  const allowed = args.lists.get("--allow") ?? [];
  const parsed = parseSchedules(["add", ...rebuilt, ...allowed.map((pattern) => `--allow=${pattern}`)]);
  if (parsed.command !== "schedules" || parsed.schedules === undefined) return parsed;
  return { ...parsed, schedules: { ...parsed.schedules, watch: true } };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The cadence flags: `--at` (one time, or several), `--every-hours` with
 * `--between`, and the day patterns `--monthly`, `--yearly`, `--once` and
 * `--until`. Shapes are checked here; whether they make one cadence is the
 * spec's own rule, checked on the write.
 */
function parseCadenceFlags(
  flags: ReadonlyMap<string, string>,
  action: SchedulesAction,
): Pick<SchedulesCommandOptions, "at" | "times" | "everyHours" | "between" | "monthly" | "yearly" | "once" | "until"> {
  const atFlag = flags.get("--at");
  // Each time's shape is the spec's to judge, with the zone, on the write.
  const times = atFlag?.split(",").map((part) => part.trim());
  const everyFlag = flags.get("--every-hours");
  if (everyFlag !== undefined && (!/^\d{1,2}$/.test(everyFlag) || Number(everyFlag) < 1 || Number(everyFlag) > SCHEDULE_MAX_EVERY_HOURS))
    throw new UsageError(`--every-hours expects 1-${SCHEDULE_MAX_EVERY_HOURS}, received ${JSON.stringify(everyFlag)}`, SCHEDULES_USAGE);
  if (everyFlag !== undefined && atFlag !== undefined)
    throw new UsageError(
      "--at and --every-hours cannot be given together: a schedule runs at set times or every few hours",
      SCHEDULES_USAGE,
    );
  const betweenFlag = flags.get("--between");
  const window = betweenFlag === undefined ? undefined : parseScheduleWindow(betweenFlag);
  if (betweenFlag !== undefined && window === undefined)
    throw new UsageError(`--between expects HH:MM-HH:MM, e.g. 08:00-18:00, received ${JSON.stringify(betweenFlag)}`, SCHEDULES_USAGE);
  if (betweenFlag !== undefined && atFlag !== undefined)
    throw new UsageError("--between is the window --every-hours runs in, not --at's", SCHEDULES_USAGE);
  if (betweenFlag !== undefined && everyFlag === undefined && action === "add")
    throw new UsageError("--between goes with --every-hours", SCHEDULES_USAGE);
  const dayPatterns = ["--monthly", "--yearly", "--once"].filter((flag) => flags.get(flag) !== undefined);
  const daysFlag = flags.get("--days");
  if (dayPatterns.length + (daysFlag !== undefined && daysFlag !== "none" ? 1 : 0) > 1)
    throw new UsageError("A schedule runs on --days, --monthly, --yearly or --once: one of them", SCHEDULES_USAGE);
  if (daysFlag === "none" && dayPatterns.length > 0)
    throw new UsageError(`--days none cannot be given with ${dayPatterns.join(", ")}`, SCHEDULES_USAGE);
  const once = flags.get("--once");
  if (once !== undefined && !DATE.test(once))
    throw new UsageError(`--once expects a date YYYY-MM-DD, received ${JSON.stringify(once)}`, SCHEDULES_USAGE);
  const until = flags.get("--until");
  if (until !== undefined && until !== "none" && !DATE.test(until))
    throw new UsageError(
      `--until expects a date YYYY-MM-DD${action === "update" ? " or none" : ""}, received ${JSON.stringify(until)}`,
      SCHEDULES_USAGE,
    );
  if (until === "none" && action !== "update")
    throw new UsageError("--until none clears a schedule's end: it is for update only", SCHEDULES_USAGE);
  if (once !== undefined && until !== undefined && until !== "none")
    throw new UsageError("--once runs on one date: it takes no --until", SCHEDULES_USAGE);
  const monthly = flags.get("--monthly");
  const yearly = flags.get("--yearly");
  return {
    ...(times === undefined ? {} : times.length === 1 ? { at: times[0] as string } : { times }),
    ...(everyFlag === undefined ? {} : { everyHours: Number(everyFlag) }),
    ...(window === undefined ? {} : { between: window }),
    ...(monthly === undefined ? {} : { monthly: parseReminderMonthly(monthly, SCHEDULES_USAGE) }),
    ...(yearly === undefined ? {} : { yearly: parseReminderYearly(yearly, SCHEDULES_USAGE) }),
    ...(once === undefined ? {} : { once }),
    ...(until === undefined ? {} : { until: until === "none" ? null : until }),
  };
}

/**
 * The warning `schedules add|update` print when `--max-tokens` sets a ceiling below one model call
 * (`SCHEDULE_ONE_CALL_TOKENS`): saved as asked, but a run can go past it by the call that crossed it. Empty otherwise.
 */
export function maxTokensWarning(maxTokens: number | null | undefined): string {
  if (maxTokens === undefined || maxTokens === null || maxTokens >= SCHEDULE_ONE_CALL_TOKENS) return "";
  return `warning: a ceiling of ${tokenCountText(maxTokens)} is below one model call: a run can go past it by one call (a run's first call alone takes about 25,000 tokens).\n`;
}
