import {
  ToolPatternSchema,
  STALE_WEB_PATTERN_MESSAGE,
  isStaleWebPattern,
  ArgMatcherSchema,
  TAINT_MODES,
  type TaintMode,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags, removalAlias } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

const PERMISSIONS_ACTIONS = ["list", "add", "rm", "grants", "revoke", "taint"] as const;
type PermissionsAction = (typeof PERMISSIONS_ACTIONS)[number];

export const PERMISSIONS_USAGE = `tavi permissions <action> [options]

The rules that decide a tool call before any approval round, and the session
grants approvals created. Rules are checked in order: the
hard-deny list, then deny, ask and allow rules (deny wins), then session
grants, then the default by effect (a call with an effect outside the chat
asks). Shipped rules allow a reply into the task's own conversation and a
question to you; override them with a deny or ask rule. \`taint\` sets the check
that applies once untrusted ("tainted") content, such as a web page or an
email, is in a chat. Under a running \`tavi serve\` these actions run there;
otherwise on the data directory.

Actions:
  list                         Every rule in force: shipped, serve --allow, stored
  add --tool <pattern> --decision <allow|ask|deny> [--match <glob>] [--note <text>] [--match-unparsed]
                               Store a rule. <pattern> is a tool id or a dotted
                               glob (browser.*); --match is a glob over what the
                               call does — a shell command, "POST https://…", a
                               destination — with * and ? as wildcards and \\
                               to escape them. An allow for every tool is refused.
                               A deny or ask rule also matches a command's other
                               spellings (env curl, /usr/bin/curl as curl). An
                               allow rule never covers a sandbox.run line no rule
                               can read ($(…), eval, a here-document) unless
                               --match-unparsed says it should
  rm <rule-id>                 Remove a stored rule (alias: remove, delete)
  grants [--task <task-id>]    Chat grants: for the rest of a chat (in Home or
                               a messaging chat: a day, or until it rolls
                               over), what an approval with scope session
                               allowed, each with when it ends
  revoke <grant-id>            Drop a chat grant
  taint [off|observe|enforce]  Show or set security.taint: once untrusted
                               content (a web page, an email) is in a chat,
                               enforce asks before a call that could send
                               data out, use a credential or save something,
                               and no rule or grant lifts it (the default);
                               observe decides as before and records what it
                               would have asked, which tavi doctor counts; off
                               does neither (deprecated). An
                               owner's serve --taint-policy overrides it

Options:
  --workspace <id>             Workspace (default: default)
  --format <text|json>         Output format (default: text)
  --data-dir <path>            Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                   Show this help
`;

export interface PermissionsCommandOptions {
  readonly action: PermissionsAction;
  readonly workspaceId: string;
  readonly format: "text" | "json";
  readonly toolPattern?: string;
  readonly argMatcher?: string;
  readonly decision?: "allow" | "ask" | "deny";
  readonly note?: string;
  /** `add --match-unparsed`: an allow rule that also covers a line no rule can read. */
  readonly matchUnparsed?: boolean;
  readonly ruleId?: string;
  readonly grantId?: string;
  readonly taskId?: string;
  /** `taint <mode>`: the mode to set; absent, `taint` shows it. */
  readonly taintMode?: TaintMode;
  readonly dataDirectory?: string;
}

export function parsePermissions(argv: readonly string[]): ParsedCommand {
  const [typed, ...rest] = argv;
  // `rm`, `remove` and `delete` all name the removal.
  const given = removalAlias(typed, "rm");
  if (given === "-h" || given === "--help") return { command: "help", usage: PERMISSIONS_USAGE };
  if (given === undefined)
    throw new UsageError(`permissions needs an action; expected one of ${PERMISSIONS_ACTIONS.join(", ")}`, PERMISSIONS_USAGE);
  if (!(PERMISSIONS_ACTIONS as readonly string[]).includes(given)) {
    throw new UsageError(
      `Unknown permissions action ${JSON.stringify(given)}; expected one of ${PERMISSIONS_ACTIONS.join(", ")}`,
      PERMISSIONS_USAGE,
    );
  }
  const action = given as PermissionsAction;
  const common = ["--data-dir", "--format", "--workspace"];
  const allowed: Readonly<Record<PermissionsAction, readonly string[]>> = {
    list: common,
    add: ["--tool", "--match", "--decision", "--note", ...common],
    rm: common,
    grants: ["--task", ...common],
    revoke: common,
    taint: common,
  };
  const args = parseFlags(rest, {
    usage: PERMISSIONS_USAGE,
    valued: allowed[action],
    ...(action === "add" ? { switches: ["--match-unparsed"] } : {}),
    unknown: (name) => `permissions ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage: PERMISSIONS_USAGE };
  const { flags, positionals } = args;
  const takesId = action === "rm" || action === "revoke";
  if (action === "taint") {
    if (positionals.length > 1)
      throw new UsageError("permissions taint takes at most one mode: off, observe or enforce", PERMISSIONS_USAGE);
    const mode = positionals[0];
    if (mode !== undefined && !(TAINT_MODES as readonly string[]).includes(mode))
      throw new UsageError(`permissions taint takes off, observe or enforce, received ${JSON.stringify(mode)}`, PERMISSIONS_USAGE);
  } else if (positionals.length !== (takesId ? 1 : 0)) {
    throw new UsageError(
      takesId ? `permissions ${action} needs ${action === "rm" ? "a rule id" : "a grant id"}` : `permissions ${action} takes no arguments`,
      PERMISSIONS_USAGE,
    );
  }
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, PERMISSIONS_USAGE);
  let toolPattern: string | undefined;
  let decision: PermissionsCommandOptions["decision"];
  if (action === "add") {
    const tool = ToolPatternSchema.safeParse(flags.get("--tool"));
    if (isStaleWebPattern(flags.get("--tool") ?? ""))
      throw new UsageError(`--tool ${JSON.stringify(flags.get("--tool"))} is refused: ${STALE_WEB_PATTERN_MESSAGE}`, PERMISSIONS_USAGE);
    if (!tool.success)
      throw new UsageError(
        `--tool expects a tool id or dotted glob (e.g. web_search, browser.*), received ${JSON.stringify(flags.get("--tool") ?? "")}`,
        PERMISSIONS_USAGE,
      );
    toolPattern = tool.data;
    const given = flags.get("--decision");
    if (given !== "allow" && given !== "ask" && given !== "deny")
      throw new UsageError("--decision expects allow, ask or deny", PERMISSIONS_USAGE);
    decision = given;
    const match = flags.get("--match");
    if (match !== undefined && !ArgMatcherSchema.safeParse(match).success)
      throw new UsageError("--match must be 1-512 characters", PERMISSIONS_USAGE);
    if (args.switches.has("--match-unparsed") && given !== "allow")
      throw new UsageError("--match-unparsed widens an allow rule; it takes --decision allow", PERMISSIONS_USAGE);
  }
  const note = flags.get("--note");
  if (note !== undefined && (note.trim() === "" || note.length > 500))
    throw new UsageError("--note must be 1-500 non-blank characters", PERMISSIONS_USAGE);
  const task = flags.get("--task");
  const match = flags.get("--match");
  const id = positionals[0];
  return {
    command: "permissions",
    permissions: {
      action,
      workspaceId: flags.get("--workspace") ?? "default",
      format,
      ...definedOnly({
        toolPattern,
        argMatcher: match,
        decision,
        note,
      }),
      ...(action === "add" && args.switches.has("--match-unparsed") ? { matchUnparsed: true } : {}),
      ...(action === "rm" && id !== undefined ? { ruleId: id } : {}),
      ...(action === "revoke" && id !== undefined ? { grantId: id } : {}),
      ...(task === undefined ? {} : { taskId: task }),
      ...(action === "taint" && id !== undefined ? { taintMode: id as TaintMode } : {}),
      ...dataDirectoryFlag(flags),
    },
  };
}
