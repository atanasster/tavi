import { dirname, resolve as resolvePath } from "node:path";

import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

/** `tavi sandbox check|setup`. */
const SANDBOX_ACTIONS = ["check", "setup"] as const;
type SandboxAction = (typeof SANDBOX_ACTIONS)[number];

/** @public Read through the module namespace by test/cli/usage-text.test.ts, which checks every command's usage. */
export const SANDBOX_USAGE = `tavi sandbox <action> [options]

Whether shell commands (sandbox.run), local MCP servers and PDF processing can
be confined on this host, and the one-time root step some Linux hosts need.

Actions:
  check                      Run the live probe and print the tier, each check,
                             and the cause and fix when it is unavailable
  setup                      Print the root block this host needs (bubblewrap,
                             socat, ripgrep; on Ubuntu a Tavi-owned bubblewrap
                             under its own AppArmor profile). Nothing runs
                             unless --apply

Options:
  --apply                    (setup) Run the block with sudo after showing it
  --remove                   (setup) Undo what setup did
  --copy                     (setup) Make the bubblewrap copy even where nothing
                             restricts user namespaces (an SELinux host's choice)
  --refresh-hook             (setup) Also re-copy bubblewrap after every apt run
  --group <name>             (setup) The group that may run the copy: the
                             service's (default: tavi when that group exists,
                             else the group of the account that ran sudo, else
                             yours)
  --nested                   (check) Probe srt's weaker nested mode, as
                             serve --sandbox-nested runs
  --format <text|json>       (check) Output format (default: text)
  --data-dir <path>          (check) Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export interface SandboxCommandOptions {
  readonly action: SandboxAction;
  readonly apply?: boolean;
  readonly remove?: boolean;
  readonly copy?: boolean;
  readonly refreshHook?: boolean;
  readonly group?: string;
  readonly format?: "text" | "json";
  readonly nested?: boolean;
  readonly dataDirectory?: string;
}

export function parseSandbox(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  if (action === "-h" || action === "--help") return { command: "help", usage: SANDBOX_USAGE };
  if (action === undefined) throw new UsageError(`sandbox needs an action; expected one of ${SANDBOX_ACTIONS.join(", ")}`, SANDBOX_USAGE);
  if (!(SANDBOX_ACTIONS as readonly string[]).includes(action))
    throw new UsageError(`Unknown sandbox action ${JSON.stringify(action)}; expected ${SANDBOX_ACTIONS.join(", ")}`, SANDBOX_USAGE);
  const args = parseFlags(rest, {
    usage: SANDBOX_USAGE,
    valued: action === "setup" ? ["--group"] : ["--format", "--data-dir"],
    switches: action === "setup" ? ["--apply", "--remove", "--copy", "--refresh-hook"] : ["--nested"],
    unknown: (name) => `sandbox ${action} does not accept ${name}`,
    positional: () => `sandbox ${action} takes no positional arguments`,
  });
  if (args === "help") return { command: "help", usage: SANDBOX_USAGE };
  const { flags, switches: set } = args;
  if (set.has("--remove") && (set.has("--copy") || set.has("--refresh-hook")))
    throw new UsageError("--remove undoes setup: it takes neither --copy nor --refresh-hook", SANDBOX_USAGE);
  const format = flags.get("--format");
  if (format !== undefined && format !== "text" && format !== "json") throw new UsageError("--format must be text or json", SANDBOX_USAGE);
  const group = flags.get("--group");
  if (group !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/.test(group))
    throw new UsageError("--group must be a group name ([A-Za-z0-9_.-], at most 32)", SANDBOX_USAGE);
  return {
    command: "sandbox",
    sandbox: {
      action: action as SandboxAction,
      ...(set.has("--apply") ? { apply: true } : {}),
      ...(set.has("--remove") ? { remove: true } : {}),
      ...(set.has("--copy") ? { copy: true } : {}),
      ...(set.has("--refresh-hook") ? { refreshHook: true } : {}),
      ...(set.has("--nested") ? { nested: true } : {}),
      ...(group === undefined ? {} : { group }),
      ...(format === undefined ? {} : { format: format as "text" | "json" }),
      ...dataDirectoryFlag(flags),
    },
  };
}

/** System folders no `--fs-root` or `--sandbox-read` may be, or hold: every confined child is denied those folders, and needs these. */
const SYSTEM_FOLDERS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/System", "/Library"] as const;

/**
 * Why `value` cannot be a folder given for chats (`--fs-root`, `--sandbox-read`):
 * not absolute, a glob character (the sandbox reads it as a pattern), `/`, a
 * system folder or one holding it, or Tavi's own Node install or a folder in
 * it. Undefined when it can be one.
 */
export function readRootProblem(flag: string, value: string, nodePrefix: string = dirname(dirname(process.execPath))): string | undefined {
  if (!value.startsWith("/")) return `${flag} must be an absolute path, received ${JSON.stringify(value)}`;
  // The sandbox reads these as a pattern: a root spelled with one would make every chat's sandbox.run refuse.
  if (/[*?[\]]/.test(value))
    return `${flag} ${JSON.stringify(value)} has *, ?, [ or ] in its path, which the sandbox reads as a pattern; rename the folder to use it`;
  const path = resolvePath(value);
  const within = (inner: string, outer: string): boolean => outer === "/" || inner === outer || inner.startsWith(`${outer}/`);
  const system = path === "/" ? "/" : SYSTEM_FOLDERS.find((folder) => within(folder, path));
  if (system !== undefined)
    return `${flag} ${JSON.stringify(value)} is ${system === path ? "" : "a folder holding "}the system folder ${system}, which every confined child must read; give the project folder itself`;
  // Node loads its binary and libraries from these; a denied one would stop every confined child from starting.
  // Other folders under the install's prefix (a shared /usr/local/share, say) are the person's to deny.
  const nodeFolders = ["bin", "lib", "include"].map((name) => `${nodePrefix === "/" ? "" : nodePrefix}/${name}`);
  const node = nodeFolders.find((folder) => within(path, folder) || within(folder, path));
  if (node !== undefined)
    return `${flag} ${JSON.stringify(value)} ${within(path, node) ? "is in" : "holds"} ${node}, which the Node Tavi runs on loads from; give the project folder itself`;
  return undefined;
}
