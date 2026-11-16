import { MESSAGING_DISPLAY_NAME_MAX } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

/** Actions `tavi bindings` supports — always an explicit operator action, never inferred from a received message. */
const BINDINGS_ACTIONS = ["bind", "unbind", "list"] as const;
type BindingsAction = (typeof BINDINGS_ACTIONS)[number];

export interface BindingsCommandOptions {
  readonly action: BindingsAction;
  /** Required for bind/unbind. */
  readonly connectionId?: string;
  /** Required for bind/unbind. */
  readonly externalSenderId?: string;
  /**
   * Defaults to "default", matching `tavi memory`/`tavi skills`. Always an
   * explicit operator-supplied flag, never resolved from `connectionId` —
   * this codebase has no durable connection catalog a CLI command could
   * query a connection's workspace from.
   */
  readonly workspaceId: string;
  /** Required for bind. */
  readonly principalId?: string;
  /** `bind --name`: what the Command Center calls this person; the principal id when absent. */
  readonly displayName?: string;
  /** `bind --trust-unverified yes|no`: turn the per-person override for unverified email on or off; unchanged when absent. */
  readonly trustUnverified?: boolean;
  /** Who approved this binding, for the audit trail — defaults to "operator", the same default `tavi memory`/`tavi skills` use for their own acting principal. */
  readonly approvedBy: string;
  readonly format: OutputFormat;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
}

export const BINDINGS_USAGE = `tavi bindings <action> [options]

Link one sender on one of your channel connections (as its channel names
them: a chat user id, an email address) to a principal, the Tavi user their
messages act as. Only you create a binding — never a received message. These
commands work on the data directory directly, so they refuse while
\`tavi serve\` runs (the same as \`tavi memory\`/\`tavi skills\`).

Actions:
  bind                       Link --connection/--sender to --principal
  unbind                     Remove a binding (idempotent if already unbound)
  list                       List all bindings in this workspace

Options:
  --connection <id>            Messaging connection id (required for bind/unbind)
  --sender <id>                External sender id, in the connection's channel's
                               form (\`tavi channels types\`); required for
                               bind/unbind
  --workspace <id>             Workspace to act in (default: default)
  --principal <id>             Principal to bind to (required for bind)
  --name <text>                bind: what the Command Center calls this person
                               (default: the principal id); binding the same
                               sender again with a new name renames them
  --trust-unverified <yes|no>  bind: admit this person's email even when it
                               cannot be verified (SPF/DKIM not passing) —
                               for a sender with a broken mail setup; anyone
                               can then write as them. Never decides an
                               approval. Unchanged when omitted
  --approved-by <text>         Who approved this binding (default: operator)
  --format <text|json>         Output format (default: text)
  --data-dir <path>            Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                   Show this help
`;

export function parseBindings(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  // `--help` is a request for this page; a missing action is not success
  if (action === "-h" || action === "--help") return { command: "help", usage: BINDINGS_USAGE };
  if (action === undefined) {
    throw new UsageError(`bindings needs an action; expected one of ${BINDINGS_ACTIONS.join(", ")}`, BINDINGS_USAGE);
  }
  if (!(BINDINGS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `Unknown bindings action ${JSON.stringify(action)}; expected one of ${BINDINGS_ACTIONS.join(", ")}`,
      BINDINGS_USAGE,
    );
  }

  const allowedFlags: Readonly<Record<BindingsAction, readonly string[]>> = {
    bind: [
      "--data-dir",
      "--connection",
      "--sender",
      "--workspace",
      "--principal",
      "--name",
      "--trust-unverified",
      "--approved-by",
      "--format",
    ],
    unbind: ["--data-dir", "--connection", "--sender", "--workspace", "--format"],
    list: ["--data-dir", "--workspace", "--format"],
  };
  const args = parseFlags(rest, {
    usage: BINDINGS_USAGE,
    valued: allowedFlags[action as BindingsAction],
    unknown: (name) => `bindings ${action} does not accept ${name}`,
    positional: () => `bindings ${action} does not take a positional argument`,
  });
  if (args === "help") return { command: "help", usage: BINDINGS_USAGE };
  const { flags } = args;

  const needsConnectionAndSender = action === "bind" || action === "unbind";
  if (needsConnectionAndSender && flags.get("--connection") === undefined) {
    throw new UsageError(`bindings ${action} needs --connection`, BINDINGS_USAGE);
  }
  if (needsConnectionAndSender && flags.get("--sender") === undefined) {
    throw new UsageError(`bindings ${action} needs --sender`, BINDINGS_USAGE);
  }
  if (action === "bind" && flags.get("--principal") === undefined) {
    throw new UsageError("bindings bind needs --principal", BINDINGS_USAGE);
  }
  const format = flags.get("--format");
  if (format !== undefined && format !== "text" && format !== "json") {
    throw new UsageError(`Unknown format ${JSON.stringify(format)}; expected text or json`, BINDINGS_USAGE);
  }

  const connectionId = flags.get("--connection");
  const externalSenderId = flags.get("--sender");
  const principalId = flags.get("--principal");
  const displayName = flags.get("--name")?.trim();
  if (displayName !== undefined && (displayName === "" || displayName.length > MESSAGING_DISPLAY_NAME_MAX)) {
    throw new UsageError(`--name must be 1-${MESSAGING_DISPLAY_NAME_MAX} non-blank characters`, BINDINGS_USAGE);
  }
  const trust = flags.get("--trust-unverified");
  if (trust !== undefined && trust !== "yes" && trust !== "no") {
    throw new UsageError("--trust-unverified must be yes or no", BINDINGS_USAGE);
  }
  const parsed: BindingsCommandOptions = {
    action: action as BindingsAction,
    ...(trust === undefined ? {} : { trustUnverified: trust === "yes" }),
    workspaceId: flags.get("--workspace") ?? "default",
    approvedBy: flags.get("--approved-by") ?? "operator",
    format: (format as OutputFormat | undefined) ?? "text",
    ...definedOnly({
      connectionId,
      externalSenderId,
      principalId,
      displayName,
    }),
    ...dataDirectoryFlag(flags),
  };
  return { command: "bindings", bindings: parsed };
}
