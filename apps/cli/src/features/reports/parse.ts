import { REPORTS_LIST_MAX } from "@tavi/contracts";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, integerFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

/** Actions `tavi reports` supports — inspect a rendered brief. */
const REPORTS_ACTIONS = ["show", "open", "list", "trends"] as const;
type ReportsAction = (typeof REPORTS_ACTIONS)[number];

export const REPORTS_USAGE = `tavi reports <action> [artifact-id] [options]

Inspect a daily-brief PDF the agent stored. A brief is kept as a stored file
(an artifact), never handed back to the model: even a short one is too large
for a tool result, so these commands are how you read it.

Actions:
  show <artifact-id>          Print the artifact's metadata (never its body)
  open <artifact-id> --out <path>
                              Write the PDF to a path and print where it went
  list                        The reporting history: one line per generated brief
  trends                      One project's metric across periods, with the
                              change between adjacent periods

Options:
  --out <path>           Destination file for open
  --limit <n>            list/trends: how many recent reports to read (default 12,
                         max 52)
  --workspace <id>       list/trends: workspace (default: default)
  --project <id>         trends: limit the series to one project
  --metric <key>         trends: limit the series to one metric key
  --from <yyyy-mm-dd>    list/trends: earliest period start to include
  --to <yyyy-mm-dd>      list/trends: latest period end to include
  --format <text|json>   Output format (default: text)
  --data-dir <path>      Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help             Show this help
`;

export interface ReportsCommandOptions {
  readonly action: ReportsAction;
  /** Required for show/open; absent for list/trends. */
  readonly artifactId: string;
  /** Required for open. */
  readonly out?: string;
  /** `list`/`trends`: how many recent reports to read (default 12, max 52). */
  readonly limit?: number;
  /** `list`/`trends`: the workspace whose history to read. */
  readonly workspaceId?: string;
  /** `trends`: one project, one metric, and the period window. */
  readonly projectId?: string;
  readonly metricKey?: string;
  readonly from?: string;
  readonly to?: string;
  readonly format: OutputFormat;
  readonly dataDirectory?: string;
}

/**
 * A `YYYY-MM-DD` that names a day that exists.
 *
 * `Date.parse` alone is not the check: it accepts `2026-02-31` (rolling it into
 * March), so the parsed instant is compared back against the text it came from.
 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Parse `tavi bindings <action>`. */
export function parseReports(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  // `--help` is a request for this page; a missing action is a usage error.
  // Merging the two would make bare `tavi reports` print the root help and exit 0,
  // so a forgotten action would look like success.
  if (action === "-h" || action === "--help") return { command: "help", usage: REPORTS_USAGE };
  if (action === undefined) {
    throw new UsageError(`reports needs an action; expected one of ${REPORTS_ACTIONS.join(", ")}`, REPORTS_USAGE);
  }
  if (!(REPORTS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown reports action ${JSON.stringify(action)}; expected one of ${REPORTS_ACTIONS.join(", ")}`, REPORTS_USAGE);
  }
  const resolvedAction = action as ReportsAction;
  const allowedFlags: Readonly<Record<ReportsAction, readonly string[]>> = {
    show: ["--data-dir", "--format"],
    open: ["--data-dir", "--out"],
    // The window belongs to both: the store resolves it for either action, the
    // handler already passes it, and an operator reading "what did March
    // produce?" was refused the flag while `trends` accepted it.
    list: ["--data-dir", "--format", "--limit", "--workspace", "--from", "--to"],
    trends: ["--data-dir", "--format", "--limit", "--workspace", "--project", "--metric", "--from", "--to"],
  };
  const args = parseFlags(rest, {
    usage: REPORTS_USAGE,
    valued: allowedFlags[resolvedAction],
    unknown: (name) => `reports ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage: REPORTS_USAGE };
  const { flags, positionals } = args;

  const history = resolvedAction === "list" || resolvedAction === "trends";
  const artifactId = positionals[0];
  if (!history) {
    if (artifactId === undefined) throw new UsageError(`reports ${action} needs an artifact id`, REPORTS_USAGE);
    if (positionals.length > 1) throw new UsageError(`reports ${action} takes one artifact id`, REPORTS_USAGE);
  } else if (positionals.length > 0) {
    throw new UsageError(`reports ${action} takes no positional argument`, REPORTS_USAGE);
  }
  const out = flags.get("--out");
  if (resolvedAction === "open" && out === undefined) {
    throw new UsageError("reports open needs --out <path>", REPORTS_USAGE);
  }
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, REPORTS_USAGE);
  }
  const limitRaw = flags.get("--limit");
  const limit =
    limitRaw === undefined
      ? undefined
      : integerFlag(
          limitRaw,
          { min: 1, max: REPORTS_LIST_MAX },
          `--limit must be an integer between 1 and ${REPORTS_LIST_MAX} (received ${JSON.stringify(limitRaw)})`,
          REPORTS_USAGE,
        );
  for (const name of ["--from", "--to"] as const) {
    const value = flags.get(name);
    // The *shape* is not the date: `2026-02-31` and `2026-13-01` both match the
    // pattern, compare as strings against every real period and quietly match
    // nothing — a typo that reads as "you have no reports".
    if (value !== undefined && !isCalendarDate(value)) {
      throw new UsageError(`${name} must be a real date as YYYY-MM-DD (received ${JSON.stringify(value)})`, REPORTS_USAGE);
    }
  }
  const fromFlag = flags.get("--from");
  const toFlag = flags.get("--to");
  // A reversed window can never match: SQLite is asked for `period_start >= from
  // AND period_end <= to`, so it answers "no recorded report" for what is really
  // a swapped pair of flags.
  if (fromFlag !== undefined && toFlag !== undefined && fromFlag > toFlag) {
    throw new UsageError(`--from ${fromFlag} is after --to ${toFlag}; the window is empty`, REPORTS_USAGE);
  }

  return {
    command: "reports",
    reports: {
      action: resolvedAction,
      // Empty for the history actions, which take no artifact: the command reads
      // the history rather than one document, and an empty string here is
      // narrower than making the field optional for every caller.
      artifactId: artifactId ?? "",
      ...(out === undefined ? {} : { out }),
      ...(limit === undefined ? {} : { limit }),
      ...(flags.get("--workspace") === undefined ? {} : { workspaceId: flags.get("--workspace") ?? "" }),
      ...(flags.get("--project") === undefined ? {} : { projectId: flags.get("--project") ?? "" }),
      ...(flags.get("--metric") === undefined ? {} : { metricKey: flags.get("--metric") ?? "" }),
      ...(flags.get("--from") === undefined ? {} : { from: flags.get("--from") ?? "" }),
      ...(flags.get("--to") === undefined ? {} : { to: flags.get("--to") ?? "" }),
      format,
      ...dataDirectoryFlag(flags),
    },
  };
}
