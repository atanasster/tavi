import { IDEA_BRIEF_MAX } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

const IDEAS_ACTIONS = [
  "list",
  "try",
  "dismiss",
  "restore",
  "refresh",
  "brief",
  "provider",
  "digest",
  "hours",
  "budget",
  "prepare",
  "reset",
  "on",
  "off",
] as const;
type IdeasAction = (typeof IDEAS_ACTIONS)[number];

export const IDEAS_USAGE = `tavi ideas <action> [options]

Ideas are things Tavi offers to do for you, grounded in what it knows about you
and limited to what it can actually do here. They also seed the suggested
prompts in an empty chat. Trying one never runs anything by itself: the
terminal prints its prompt, which you can paste into a chat.

Under a live \`tavi serve\`, every action runs on the owner over IPC; with none,
the data directory is opened directly.

Actions:
  list                       The active ideas, best first (--all adds tried,
                             snoozed and dismissed ones)
  try <id>                   Print an idea's prompt and mark it tried
  dismiss <id>               Not interested: the idea is not offered again
  restore <id>               Undo a dismissal or a snooze
  refresh                    Ask the owner for new ideas now (at most 3 an hour)
  brief ["<text>"]           Print the ideas brief, or replace it with <text>
                             ("" clears it): topics to favour or avoid, read as
                             written by the generator
  provider [<id>]            Print the providers installed and the one in use,
                             or switch to <id> (a running owner only); the old
                             provider's unpinned ideas are retired
  digest [<connection> <day>|off]
                             Print the weekly ideas digest, send it to your own
                             chat on channel connection <connection> each <day>
                             (mon … sun), or turn it off (off by default)
  hours [<HH:MM-HH:MM>]      Print or set the hours the daily look and the digest
                             run in (08:00-22:00 by default; may cross midnight)
  budget [<tokens>]          Print or set the tokens a day Ideas' model turns may
                             spend (20000 by default; 0 turns them off)
  prepare [on|off]           Print or set whether a provider that reads your
                             memory, tasks or brief may prepare its ideas' first
                             steps: an unattended read-only run whose searches
                             carry its words (off by default; the built-in
                             provider always may)
  reset [ledger|sections]    Forget every dismissal, snooze, exclusion, ignored
                             idea and rewritten prompt kept as an example
                             (ledger, the default), or unmute every section
  on | off                   Turn ideas on or off (an empty chat still suggests what Tavi can do)

Options:
  --all                      list: also tried, snoozed and dismissed ideas
  --workspace <id>           Workspace (default: default)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export interface IdeasCommandOptions {
  readonly action: IdeasAction;
  readonly dataDirectory?: string;
  readonly workspaceId: string;
  readonly ideaId?: string;
  /** `brief <text>`: the new brief; absent, the brief is printed. */
  readonly brief?: string;
  /** `provider <id>`: the provider to switch to; absent, the providers are printed. */
  readonly provider?: string;
  /** `hours <HH:MM-HH:MM>`: the daily look's hours; absent, they are printed. */
  readonly hours?: { readonly start: string; readonly end: string };
  /** `budget <tokens>`: the day's tokens for model turns; absent, it is printed. */
  readonly budget?: number;
  /** `prepare on|off`: whether an external provider that reads more than the ledger may prepare; absent, it is printed. */
  readonly prepareExternal?: boolean;
  /** `digest <connection> <day>`: where and when; `null`, off; absent, it is printed. */
  readonly digest?: { readonly channel: string; readonly weekday: number } | null;
  /** `reset`: what to forget. */
  readonly reset?: "ledger" | "sections";
  /** `list --all`. */
  readonly all?: boolean;
  readonly format: OutputFormat;
}

export function parseIdeas(argv: readonly string[]): ParsedCommand {
  const usage = IDEAS_USAGE;
  const [action, ...rest] = argv;
  if (action === "-h" || action === "--help") return { command: "help", usage };
  if (action === undefined) throw new UsageError(`ideas needs an action; expected one of ${IDEAS_ACTIONS.join(", ")}`, usage);
  if (!(IDEAS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown ideas action ${JSON.stringify(action)}; expected one of ${IDEAS_ACTIONS.join(", ")}`, usage);
  }
  const resolvedAction = action as IdeasAction;
  const args = parseFlags(rest, {
    usage,
    valued: ["--data-dir", "--format", "--workspace"],
    switches: resolvedAction === "list" ? ["--all"] : [],
    unknown: (name) => `ideas ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags, positionals } = args;
  const all = args.switches.has("--all");
  const takesId = resolvedAction === "try" || resolvedAction === "dismiss" || resolvedAction === "restore";
  if (takesId && positionals.length !== 1) throw new UsageError(`ideas ${action} takes one idea id`, usage);
  if (resolvedAction === "brief" && positionals.length > 1)
    throw new UsageError(`ideas brief takes the brief as one argument; quote it ("more about the garden")`, usage);
  if (resolvedAction === "provider" && positionals.length > 1) throw new UsageError("ideas provider takes at most one provider id", usage);
  if (
    resolvedAction === "reset" &&
    (positionals.length > 1 || (positionals[0] !== undefined && positionals[0] !== "ledger" && positionals[0] !== "sections"))
  ) {
    throw new UsageError(`ideas reset takes ledger or sections, received ${JSON.stringify(positionals.join(" "))}`, usage);
  }
  const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  let digest: { readonly channel: string; readonly weekday: number } | null | undefined;
  if (resolvedAction === "digest") {
    if (positionals.length === 1 && positionals[0] === "off") digest = null;
    else if (positionals.length === 2) {
      const named = (positionals[1] ?? "").toLowerCase();
      // A day's three letters or its whole name: "monkey" is no day.
      const weekday = weekdays.findIndex(
        (day, index) => named === day || named === ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][index],
      );
      if (weekday < 0)
        throw new UsageError(`ideas digest takes a day such as mon or friday, received ${JSON.stringify(positionals[1])}`, usage);
      digest = { channel: positionals[0] ?? "", weekday };
    } else if (positionals.length !== 0) throw new UsageError("ideas digest takes a connection and a day, or off", usage);
  }
  let hours: { readonly start: string; readonly end: string } | undefined;
  if (resolvedAction === "hours" && positionals.length > 0) {
    const range = /^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(positionals.join(""));
    if (range === null || range[1] === range[2])
      throw new UsageError(`ideas hours takes a range such as 08:00-22:00, received ${JSON.stringify(positionals.join(" "))}`, usage);
    hours = { start: range[1] ?? "", end: range[2] ?? "" };
  }
  let budget: number | undefined;
  if (resolvedAction === "budget" && positionals.length > 0) {
    // Digits only: `Number` reads "" as 0, and "1e3" or "0x10" as numbers no one typed as a budget.
    budget = /^\d+$/u.test(positionals[0] ?? "") ? Number(positionals[0]) : Number.NaN;
    if (positionals.length > 1 || !Number.isInteger(budget) || budget < 0 || budget > 1_000_000)
      throw new UsageError("ideas budget takes a whole number of tokens from 0 to 1000000", usage);
  }
  let prepareExternal: boolean | undefined;
  if (resolvedAction === "prepare" && positionals.length > 0) {
    if (positionals.length > 1 || (positionals[0] !== "on" && positionals[0] !== "off"))
      throw new UsageError("ideas prepare takes on or off", usage);
    prepareExternal = positionals[0] === "on";
  }
  if (
    !takesId &&
    !["brief", "provider", "reset", "digest", "hours", "budget", "prepare"].includes(resolvedAction) &&
    positionals.length > 0
  )
    throw new UsageError(`ideas ${action} takes no argument`, usage);
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, usage);
  const ideaId = takesId ? positionals[0] : undefined;
  const brief = resolvedAction === "brief" ? positionals[0]?.trim() : undefined;
  if (brief !== undefined && brief.length > IDEA_BRIEF_MAX)
    throw new UsageError(`The ideas brief is at most ${IDEA_BRIEF_MAX} characters`, usage);
  return {
    command: "ideas",
    ideas: {
      action: resolvedAction,
      workspaceId: flags.get("--workspace") ?? "default",
      ...(ideaId === undefined ? {} : { ideaId }),
      ...(brief === undefined ? {} : { brief }),
      ...(resolvedAction === "provider" && positionals[0] !== undefined ? { provider: positionals[0] } : {}),
      ...(resolvedAction === "reset" ? { reset: positionals[0] === "sections" ? ("sections" as const) : ("ledger" as const) } : {}),
      ...definedOnly({
        digest,
        hours,
        budget,
        prepareExternal,
      }),
      ...(all ? { all } : {}),
      format,
      ...dataDirectoryFlag(flags),
    },
  };
}
