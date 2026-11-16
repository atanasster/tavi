import {
  DEFAULT_SERVICE_LABEL,
  SERVICE_UNIT_KINDS,
  SYSTEMD_SCOPES,
  hasUnsafeUnitChar,
  type ServiceUnitKind,
  type SystemdScope,
} from "./unit.js";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

/**
 * `tavi service unit` — generate the unit that keeps
 * `serve` running, and therefore keeps the 07:00 brief happening.
 *
 * Printed, never installed: writing a launchd/systemd unit needs root, and
 * silently installing a background service is not something an operator asked
 * for by running a CLI. `--out` writes the file for them to place.
 */
const SERVICE_ACTIONS = ["unit"] as const;
type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export const SERVICE_USAGE = `tavi service <action> [options]

Generate the launchd/systemd unit that runs \`tavi serve\` — and with it the
scheduler — so a reboot does not silently end the morning brief. Nothing is
installed: the unit is printed for you to review and place.

Actions:
  unit                       Render the service unit

Options:
  --kind <launchd|systemd|task>
                             Which format to render (default: launchd on macOS,
                             task on Windows, systemd on Linux). task is a
                             Windows logon task (Task Scheduler XML)
  --label <id>               launchd label / systemd unit name / Windows task name
                             (default: dev.tavi.serve)
  --node <path>              Path to the node binary (default: the running one)
  --executable <path>        Path to tavi's executable entry point
  --log-dir <path>           Directory for the service's stdout/stderr (created if
                             missing)
  --serve-arg <arg>          Append this argument to the unit's \`serve\` invocation
                             (repeatable, order preserved). Pass the flags that make
                             delivery work — without them the unit starts serve
                             with no connector and no destination allowlist, so it
                             fires and never delivers
  --out <path>               Write the unit here instead of printing it
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})

systemd only (a non-root, hardened unit):
  --user <name>              The account serve runs as (default: $SUDO_USER, else a
                             \`tavi\` system user the unit says how to create)
  --group <name>             Its group
  --scope <system|user>      A system unit (default), or a \`systemctl --user\` unit
  --allow-root               Render a root unit anyway (refused otherwise)
  --credential <name=path>   A LoadCredential= line (repeatable)
  -h, --help                 Show this help

Every --fs-root among the --serve-arg flags becomes a ReadWritePaths= entry.

Examples:
  tavi service unit \\
    --serve-arg=--api-key-file --serve-arg=/etc/tavi/model.key \\
    --serve-arg=--messaging-allow-destination --serve-arg=8346819670 \\
    --log-dir ~/Library/Logs/tavi \\
    --out ~/Library/LaunchAgents/dev.tavi.serve.plist
`;

export interface ServiceCommandOptions {
  readonly action: ServiceAction;
  readonly kind: ServiceUnitKind;
  readonly label: string;
  readonly nodePath: string;
  readonly executablePath: string;
  readonly logDirectory?: string;
  /** Extra `serve` flags, in the order given; see `SERVICE_USAGE`. */
  readonly serveArgs?: readonly string[];
  readonly out?: string;
  readonly dataDirectory?: string;
  readonly user?: string;
  readonly group?: string;
  readonly scope?: SystemdScope;
  readonly allowRoot?: boolean;
  readonly credentials?: readonly { readonly name: string; readonly path: string }[];
}

export function parseService(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  // `--help` is a request for this page; a missing action is not success
  if (action === "-h" || action === "--help") return { command: "help", usage: SERVICE_USAGE };
  if (action === undefined) {
    throw new UsageError(`service needs an action; expected one of ${SERVICE_ACTIONS.join(", ")}`, SERVICE_USAGE);
  }
  if (!(SERVICE_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown service action ${JSON.stringify(action)}; expected ${SERVICE_ACTIONS.join(", ")}`, SERVICE_USAGE);
  }
  const args = parseFlags(rest, {
    usage: SERVICE_USAGE,
    valued: [
      "--kind",
      "--label",
      "--node",
      "--executable",
      "--log-dir",
      "--out",
      "--data-dir",
      "--serve-arg",
      "--user",
      "--group",
      "--scope",
      "--credential",
    ],
    switches: ["--allow-root"],
    lists: ["--serve-arg", "--credential"],
    // The operator's own command line, repeatable with order preserved: every
    // argument an operator needs here *is* flag-shaped, so the value is taken
    // verbatim from the next token, past the guard that is sound for
    // `--data-dir` followed by `--model`.
    verbatim: ["--serve-arg"],
    unknown: (name) => `service ${action} does not accept ${name}`,
    positional: () => `service ${action} takes no positional arguments`,
  });
  if (args === "help") return { command: "help", usage: SERVICE_USAGE };
  const { flags } = args;
  const allowRoot = args.switches.has("--allow-root");
  const serveArgs = args.lists.get("--serve-arg") ?? [];
  for (const raw of serveArgs)
    if (hasUnsafeUnitChar(raw)) throw new UsageError("--serve-arg must be non-empty and contain no control characters", SERVICE_USAGE);
  const credentials = (args.lists.get("--credential") ?? []).map((raw) => {
    const match = /^([A-Za-z0-9_.-]{1,64})=(\/\S+)$/.exec(raw);
    if (match === null) throw new UsageError("--credential takes <name>=<absolute path>, with no spaces", SERVICE_USAGE);
    return { name: match[1] as string, path: match[2] as string };
  });
  const scopeFlag = flags.get("--scope");
  if (scopeFlag !== undefined && !(SYSTEMD_SCOPES as readonly string[]).includes(scopeFlag)) {
    throw new UsageError(`--scope must be one of ${SYSTEMD_SCOPES.join(", ")}`, SERVICE_USAGE);
  }
  for (const name of ["--user", "--group"]) {
    const value = flags.get(name);
    if (value !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/.test(value))
      throw new UsageError(`${name} must be an account name ([A-Za-z0-9_.-], at most 32)`, SERVICE_USAGE);
  }
  const kindFlag = flags.get("--kind");
  if (kindFlag !== undefined && !(SERVICE_UNIT_KINDS as readonly string[]).includes(kindFlag)) {
    throw new UsageError(`--kind must be one of ${SERVICE_UNIT_KINDS.join(", ")}`, SERVICE_USAGE);
  }
  // Defaulting to this host's own init system is a convenience, not a guess: the
  // unit is printed for review either way, and `--kind` always wins.
  const kind = (kindFlag ??
    (process.platform === "darwin" ? "launchd" : process.platform === "win32" ? "task" : "systemd")) as ServiceUnitKind;
  const label = flags.get("--label") ?? DEFAULT_SERVICE_LABEL;
  // The label becomes a filename, an XML comment and INI directives, so it is
  // restricted to characters that are inert in all three — a newline in it
  // injects real `[Unit]` directives into the generated unit. It is
  // self-inflicted rather than a privilege boundary, but unvalidated text is
  // still a security surface.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(label)) {
    throw new UsageError(`--label must match [A-Za-z0-9._-]{1,64}, received ${JSON.stringify(label)}`, SERVICE_USAGE);
  }
  const logDirectory = flags.get("--log-dir");
  const out = flags.get("--out");
  const nodePath = flags.get("--node") ?? process.execPath;
  const executablePath = flags.get("--executable");
  // These four are interpolated into a generated unit file, so a control
  // character (a newline above all) must be a usage error here rather than a
  // valid-looking unit with an injected directive. The renderer checks too, for
  // callers that do not come through this parser.
  for (const [name, value] of [
    ["--data-dir", dataDirectoryFlag(flags)?.dataDirectory],
    ["--log-dir", logDirectory],
    ["--node", nodePath],
    ["--executable", executablePath],
  ] as const) {
    if (value !== undefined && hasUnsafeUnitChar(value)) {
      throw new UsageError(`${name} must not contain control characters`, SERVICE_USAGE);
    }
  }

  return {
    command: "service",
    service: {
      action: "unit",
      kind,
      label,
      nodePath,
      // Resolved in `serviceCommand`, where the CLI's own location is known.
      executablePath: executablePath ?? "",
      ...(logDirectory === undefined ? {} : { logDirectory }),
      ...(serveArgs.length === 0 ? {} : { serveArgs }),
      ...(out === undefined ? {} : { out }),
      ...dataDirectoryFlag(flags),
      ...(flags.get("--user") === undefined ? {} : { user: flags.get("--user") as string }),
      ...(flags.get("--group") === undefined ? {} : { group: flags.get("--group") as string }),
      ...(scopeFlag === undefined ? {} : { scope: scopeFlag as SystemdScope }),
      ...(allowRoot ? { allowRoot } : {}),
      ...(credentials.length === 0 ? {} : { credentials }),
    },
  };
}
