import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, integerFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

/**
 * `tavi backup`/`export`/`restore`.
 *
 * One shape for three commands because they differ in exactly one decision:
 * which flag names the other directory, and whether credentials travel with the
 * snapshot. `backup` and `export` read a directory they do not own; `restore`
 * writes one, which is why `features/inbox/client.ts` takes the ownership lock only for it.
 */
/** `tavi logs`. */
/** `tavi prune`. */
/** `tavi inbox list|replay`. */
export interface InboxCommandOptions {
  readonly action: InboxAction;
  /** Positional provider event id for `replay`. */
  readonly providerEventId?: string;
  /** The connection the held event belongs to, for `replay`. */
  readonly connectionId?: string;
  readonly limit: number;
  readonly format: OutputFormat;
  readonly dataDirectory?: string;
  /** `replay` composes a runtime, so it needs a model target like `run-now`. */
  readonly model?: string;
  readonly apiKeyFile?: string;
  readonly workspaceId?: string;
  readonly principalId?: string;
}

const INBOX_ACTIONS = ["list", "replay"] as const;
type InboxAction = (typeof INBOX_ACTIONS)[number];

export const INBOX_USAGE = `tavi inbox <action> [options]

Inspect the inbound messages Tavi recorded but held back (most often because
the sender was not yet linked with \`tavi bindings\`), and replay one now that
its sender is bound.

A message from an unbound sender is durably held rather than dropped, and if the
sender is bound only *after* that exact event was recorded, the ordinary path
never admits it: a redelivery is a duplicate, so it is not re-admitted either.
The row stays \`received\` until an operator sees it here and replays it.

Actions:
  list                        List held messages, oldest first, with the principal
                              each would now resolve to (\`-\` means unbound)
  replay <provider-event-id>  Admit one again, as the binding resolves it now

Options:
  --connection <id>          Connection the held event belongs to (required for replay)
  --limit <n>                Max rows for list (default: 50)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help

Replay needs a model connection, because admitting a message is a model call; it
takes the data directory to itself, so stop \`tavi serve\` first (exit 5). So does
\`list\`, which reads the same database — attaching the listing to a live owner is
part of the remaining operator-surface work. The model connection comes from the
workspace default (\`tavi models set-default\`); \`--connection\` here names the
*messaging* connection the held event belongs to.
`;

/** Parse `tavi serve`, the foreground owner. */
/**
 * `tavi backup --out <dir>`, `tavi export --out <dir>`, `tavi restore --from <dir>`.
 *
 * No action word: each command does one thing, so a missing `--out`/`--from` is
 * the only usage error there is to make.
 */
/** `tavi inbox list|replay`. */
export function parseInbox(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  // Same rule as every other family: `--help` is a request for this page, a
  // missing action is a usage error.
  if (action === "-h" || action === "--help") return { command: "help", usage: INBOX_USAGE };
  // A flag where the action belongs (`tavi inbox --data-dir X`) is a missing
  // action, not an unknown one; the message should say which is missing.
  if (action === undefined || action.startsWith("-")) {
    throw new UsageError(`inbox needs an action; expected one of ${INBOX_ACTIONS.join(", ")}`, INBOX_USAGE);
  }
  if (!(INBOX_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown inbox action ${JSON.stringify(action)}; expected one of ${INBOX_ACTIONS.join(", ")}`, INBOX_USAGE);
  }
  const resolved = action as InboxAction;
  const allowed =
    resolved === "list"
      ? ["--limit", "--format", "--data-dir"]
      : ["--connection", "--connection-id", "--model", "--api-key-file", "--workspace", "--principal", "--format", "--data-dir"];
  const args = parseFlags(rest, {
    usage: INBOX_USAGE,
    valued: allowed,
    unknown: (name) => `inbox ${resolved} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage: INBOX_USAGE };
  const { flags, positionals } = args;
  const limitRaw = flags.get("--limit") ?? "50";
  const limit = integerFlag(
    limitRaw,
    { min: 1, max: 1_000 },
    `--limit must be a positive integer (received ${JSON.stringify(limitRaw)})`,
    INBOX_USAGE,
  );
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, INBOX_USAGE);
  }
  const providerEventId = positionals[0];
  if (resolved === "replay") {
    if (providerEventId === undefined) throw new UsageError("inbox replay needs a provider event id", INBOX_USAGE);
    if (positionals.length > 1) throw new UsageError("inbox replay takes one provider event id", INBOX_USAGE);
  } else if (positionals.length > 0) {
    throw new UsageError("inbox list takes no positional argument", INBOX_USAGE);
  }
  const connectionId = flags.get("--connection") ?? flags.get("--connection-id");
  if (resolved === "replay" && connectionId === undefined) {
    throw new UsageError("inbox replay needs --connection <id>", INBOX_USAGE);
  }
  const model = flags.get("--model");
  const apiKeyFile = flags.get("--api-key-file");
  return {
    command: "inbox",
    inbox: {
      action: resolved,
      ...(providerEventId === undefined ? {} : { providerEventId }),
      ...(connectionId === undefined ? {} : { connectionId }),
      limit,
      format,
      ...(model === undefined ? {} : { model }),
      ...(apiKeyFile === undefined ? {} : { apiKeyFile }),
      ...(flags.get("--workspace") === undefined ? {} : { workspaceId: flags.get("--workspace") ?? "" }),
      ...(flags.get("--principal") === undefined ? {} : { principalId: flags.get("--principal") ?? "" }),
      ...dataDirectoryFlag(flags),
    },
  };
}
