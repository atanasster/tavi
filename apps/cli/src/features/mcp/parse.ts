import {
  mcpSlugOf,
  type McpBlock,
  type McpPresetId,
  type McpPayload,
  type McpSandboxState,
  type RiskLevel,
  type ToolEffect,
} from "@tavi/contracts";

import type { ParsedCommand } from "../../cli/parse.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { McpAddForm } from "./add.js";
import { AVAILABLE_PRESETS } from "./presets/index.js";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";

/**
 * `tavi mcp`: the operator's front for MCP-specific steps.
 *
 * @public Read through the module namespace by test/cli/usage-text.test.ts, which checks every command's usage.
 */
export const MCP_USAGE = `tavi mcp <action> [options]

MCP servers are plugins (docs/MCP.md): \`tavi plugins\` lists, configures,
enables and removes them; \`tavi mcp\` adds, probes, reviews and approves
them. Only you can, never the agent.

Actions:
  add <name> --url <url> [--header Name=value | Name=[prefix]@setting]... [--lan] [--oauth]
                               A remote server (Streamable HTTP). A header fed
                               by @setting becomes a credential setting, set
                               with \`tavi plugins config mcp.<name> --set\`
  add <name> --npm <package>@<version> [-- <args>...]
                               An npm server, fetched with every install
                               script off and its whole closure pinned
  add <name> --pypi <package>==<version> [-- <args>...]
                               A Python server: wheels only, its whole closure
                               pinned by hash with uv, run on a uv-managed
                               interpreter pinned by path and hash (needs uv)
  add <name> --dir <path> -- <argv>...
                               A local stdio server, copied from a directory;
                               argv paths are inside it (node is Tavi's own)
  add <name> --mcpb <file> [-- <args>...]
                               A .mcpb bundle: its files copied with the
                               server, its command and settings from its
                               manifest (a sensitive field a credential); a
                               signature is shown, not trusted
  add <name> --command <abs-path> -- <args>...
                               A system binary; its path and hash are
                               recorded when it is approved
  add <name> --preset homeassistant|google-maps|todoist|todoist-token
                               A reviewed template (its settings — a url and
                               token, or your OAuth client — are set after,
                               with \`tavi plugins config\`); its effects and
                               floors join each tool's suggestion at approval
  add <name> --registry <server>[@<version>] --option npm|pypi|mcpb|remote
                               An MCP Registry entry, read again from the
                               registry: the package or remote named, its
                               inputs as settings (a secret one a credential)
  search [<words>] [--cursor <c>]
                               Search the MCP Registry: each entry's labels
                               (installable, remote, oci-unsupported …) and
                               the add for each way in. Its listings are the
                               publishers' words, never a reason to trust one
  registry [<url> | --default] The registry searched (https; the official
                               one unless you name another)
  import <file> [--dry-run] [--no-probe]
                               Propose every server in another client's file
                               (Claude Desktop, Claude Code, Cursor, VS Code):
                               npx -y pkg becomes --npm pkg@<exact>, literal
                               secrets move into credentials (the file is not
                               changed), and what cannot be rewritten is listed
                               and skipped. Nothing is approved
  probe <id> [--version <v>]   Start it in its sandbox and list its tools (no
                               tool is called); after settings are set
  show <id> [--version <v>] [--full]
                               The review: exact command or url, sandbox,
                               protocol, instructions, each tool's suggestion
                               and marks; --full adds each tool's schemas,
                               cleaned, as the model is shown them
  review <id> [--version <v>]  The same, for what waits: the server's open
                               notices, and each tool CHANGED since approval,
                               NEW, or unchanged (as decided before); approve
                               then asks only about those
  approve <id> <version> [--effect <tool>=<read-only|mutating|external>]...
          [--floor <tool>=<low|medium|high|critical>]... [--timeout <tool>=<ms>]...
          [--disable <tool>]...    The trust decision, for every tool at once. A
                               doubtful or flagged tool needs --effect or --disable
  reject <id> <version>        Reject a version; its tools never run
  verify <id> [--version <v>] [--full]
                               Check its files against what was approved
  logs <id> [--lines <n>]      The server's log: starts, calls (by tool and
                               outcome, never arguments), failures, and its
                               stderr with every credential masked
  list [--workspace <w>]       Every server: its state (running, stopped, backing
                               off, failed, login required; off), sandbox,
                               exposure, tools listed against the budget, what
                               waits for review, open notices
  on | off                     The kill switch (also with no owner running): off
                               stops every server and withdraws every tool. On
                               by default
  remove-all [--yes]           The commands that remove every server (before a
                               downgrade); --yes runs them
  login <id> [--no-open] [--port <n>] [--paste | --public]
                               Sign in to an OAuth server (with tavi serve running):
                               the browser opens on its https sign-in page (or
                               the address is printed), and comes back here, to
                               http://127.0.0.1:<port>/oauth/callback (a fixed
                               --port for a client that registers its redirect,
                               such as Google's). --paste: signing in on another
                               computer, paste the address the browser lands on;
                               --public: come back to the owner's https address
  logout <id>                  Revoke and forget its sign-in
  line <id> [<text> | --clear] Its line in tools.search's description while its
                               tools wait behind search: yours, or (--clear,
                               the default) Tavi's own count and tool names
  people <id> on|off [--workspace <w>]
                               Whether other people's chats (bound from
                               channels) are offered its tools; they run with
                               your credentials. Default off

  The new version is proposed: nothing runs until it is probed, and nothing
  is offered until it is approved and enabled (\`tavi plugins enable\`, which
  adds it to the workspace's mcp.servers).

Sandbox (add, probe, approve), for a stdio server:
  (default)                    srt: Seatbelt on macOS, bubblewrap on Linux; where
                               it cannot run, the probe names the cause and fix
  --nested                     srt's weaker nested mode, for a container that
                               masks /proc
  --unsandboxed                no sandbox, by your choice; approve asks for it again

Options for add:
  --env KEY=value | KEY=@setting   A stdio server's variable (repeatable)
  --secret <setting>              A setting --env names is a credential, whatever
                                  its variable is called (repeatable)
  --domain <domain>               A domain a stdio server may reach (repeatable)
  --read <path>                   A folder a stdio server may read (repeatable)
  --write <path>                  A folder a stdio server may write (repeatable)
  --exposure <auto|always|search> How its tools reach the model (default auto)
  --version <x.y.z>               The plugin version (default 1.0.0)
  --name <text>                   Its display name (default: the name given)
  --description <text>            Its description
  --no-probe                      Do not probe after adding

Common:
  --format <text|json>            Output format (default: text)
  --data-dir <path>               Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                      Show this help
`;

interface McpAddCommandOptions {
  readonly action: "add";
  readonly slug: string;
  readonly form: McpAddForm;
  readonly env: readonly string[];
  /** Settings declared as credentials whatever their variables' names look like (`--secret`). */
  readonly secrets?: readonly string[];
  readonly domains: readonly string[];
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly exposure?: McpBlock["exposure"];
  readonly version?: string;
  readonly name?: string;
  readonly description?: string;
  readonly sandbox?: McpSandboxState;
  readonly probe: boolean;
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

/** Every other action is an `mcp` payload as it is sent to the owner. */
interface McpActionCommandOptions {
  readonly action: "payload";
  readonly payload: McpPayload;
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

/** `tavi mcp logs`: read on the data directory, with or without an owner. */
interface McpLogsCommandOptions {
  readonly action: "logs";
  readonly pluginId: string;
  readonly lines: number;
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

/** `tavi mcp remove-all`: the removal commands, or with `--yes` every server removed (before a downgrade). */
interface McpRemoveAllCommandOptions {
  readonly action: "remove-all";
  readonly yes: boolean;
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

/** `tavi mcp login`: an OAuth server's sign-in, through the running owner. */
interface McpLoginCommandOptions {
  readonly action: "login";
  readonly pluginId: string;
  readonly open: boolean;
  /** The loopback listener's port; any free one by default. */
  readonly port?: number;
  /** Come back to the owner's https address. */
  readonly public?: boolean;
  /** Also read the address the browser lands on from stdin. */
  readonly paste?: boolean;
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

/** `tavi mcp import <file>`: each server proposed, as `add` would add it. */
interface McpImportCommandOptions {
  readonly action: "import";
  readonly file: string;
  readonly dryRun: boolean;
  readonly probe: boolean;
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

export type McpCommandOptions =
  | McpAddCommandOptions
  | McpActionCommandOptions
  | McpLogsCommandOptions
  | McpRemoveAllCommandOptions
  | McpLoginCommandOptions
  | McpImportCommandOptions;

const ACTIONS = [
  "add",
  "import",
  "probe",
  "show",
  "review",
  "approve",
  "reject",
  "verify",
  "logs",
  "people",
  "list",
  "on",
  "off",
  "remove-all",
  "login",
  "logout",
  "line",
  "search",
  "registry",
] as const;
const REPEATED = new Set([
  "--secret",
  "--header",
  "--env",
  "--domain",
  "--read",
  "--write",
  "--effect",
  "--floor",
  "--timeout",
  "--disable",
]);
const SWITCHES = new Set([
  "--clear",
  "--lan",
  "--nested",
  "--unsandboxed",
  "--full",
  "--no-probe",
  "--yes",
  "--no-open",
  "--oauth",
  "--dry-run",
  "--default",
  "--public",
  "--paste",
]);
const ALLOWED: Readonly<Record<(typeof ACTIONS)[number], readonly string[]>> = {
  add: [
    "--url",
    "--npm",
    "--pypi",
    "--dir",
    "--command",
    "--mcpb",
    "--registry",
    "--option",
    "--preset",
    "--header",
    "--lan",
    "--oauth",
    "--env",
    "--secret",
    "--domain",
    "--read",
    "--write",
    "--exposure",
    "--version",
    "--name",
    "--description",
    "--nested",
    "--unsandboxed",
    "--no-probe",
  ],
  import: ["--dry-run", "--no-probe"],
  search: ["--cursor"],
  registry: ["--default"],
  probe: ["--version", "--nested", "--unsandboxed"],
  show: ["--version", "--full"],
  review: ["--version"],
  approve: ["--effect", "--floor", "--timeout", "--disable", "--nested", "--unsandboxed"],
  reject: [],
  verify: ["--version", "--full"],
  logs: ["--lines"],
  people: ["--workspace"],
  list: ["--workspace"],
  on: [],
  off: [],
  "remove-all": ["--yes"],
  login: ["--no-open", "--port", "--public", "--paste"],
  logout: [],
  line: ["--clear"],
};

/** `tool=value` pairs of a repeated flag, by tool. */
function pairs(values: readonly string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const at = value.lastIndexOf("=");
    if (at <= 0) throw new UsageError(`${flag} takes <tool>=<value>, received ${JSON.stringify(value)}`, MCP_USAGE);
    out[value.slice(0, at)] = value.slice(at + 1);
  }
  return out;
}

/** `tavi mcp …`. */
export function parseMcp(argv: readonly string[]): ParsedCommand {
  const usage = MCP_USAGE;
  const [action, ...rest] = argv;
  if (action === undefined) throw new UsageError(`mcp needs an action; expected one of ${ACTIONS.join(", ")}`, usage);
  if (action === "-h" || action === "--help") return { command: "help", usage };
  if (!(ACTIONS as readonly string[]).includes(action))
    throw new UsageError(`Unknown mcp action ${JSON.stringify(action)}; expected one of ${ACTIONS.join(", ")}`, usage);
  const name = action as (typeof ACTIONS)[number];
  // Everything after `--` is the server's own argv, taken as given.
  const split = rest.indexOf("--");
  const own = split === -1 ? rest : rest.slice(0, split);
  const serverArgv = split === -1 ? undefined : rest.slice(split + 1);
  if (serverArgv !== undefined && name !== "add") throw new UsageError(`mcp ${name} takes no argv after --`, usage);
  const accepted = ["--format", "--data-dir", ...ALLOWED[name]];
  const args = parseFlags(own, {
    usage,
    valued: accepted,
    switches: accepted.filter((flag) => SWITCHES.has(flag)),
    lists: accepted.filter((flag) => REPEATED.has(flag)),
    unknown: (flag) => `mcp ${name} does not accept ${flag}`,
    switchValue: (flag) => `${flag} takes no value`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags, switches, positionals, lists: repeated } = args;
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, usage);
  if (switches.has("--nested") && switches.has("--unsandboxed"))
    throw new UsageError("--nested and --unsandboxed cannot both be given", usage);
  const sandbox: McpSandboxState | undefined = switches.has("--unsandboxed") ? "none" : switches.has("--nested") ? "nested" : undefined;
  const all = (flag: string): readonly string[] => repeated.get(flag) ?? [];
  const common = { format, ...dataDirectoryFlag(flags) } as const;
  const payload = (value: McpPayload): ParsedCommand => ({ command: "mcp", mcp: { action: "payload", payload: value, ...common } });
  const version = flags.get("--version");
  if (name === "logs") {
    const [pluginId, ...extra] = positionals;
    if (pluginId === undefined || extra.length > 0 || mcpSlugOf(pluginId) === undefined)
      throw new UsageError("mcp logs needs exactly one server id (mcp.<name>)", usage);
    const lines = flags.get("--lines") ?? "100";
    if (!/^\d+$/.test(lines) || Number(lines) < 1 || Number(lines) > 10_000) throw new UsageError("--lines takes 1 to 10000", usage);
    return { command: "mcp", mcp: { action: "logs", pluginId, lines: Number(lines), ...common } };
  }
  if (name === "list" || name === "on" || name === "off") {
    if (positionals.length > 0) throw new UsageError(`mcp ${name} takes no arguments`, usage);
    if (name === "list") return payload({ action: "list", workspaceId: flags.get("--workspace") ?? "default" });
    return payload({ action: "switch", on: name === "on" });
  }
  if (name === "login" || name === "logout") {
    const [pluginId, ...extra] = positionals;
    if (pluginId === undefined || extra.length > 0 || mcpSlugOf(pluginId) === undefined)
      throw new UsageError(`mcp ${name} needs exactly one server id (mcp.<name>)`, usage);
    if (name === "logout") return payload({ action: "logout", pluginId });
    const port = flags.get("--port");
    if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65_535))
      throw new UsageError("--port takes 1024 to 65535", usage);
    if (switches.has("--public") && (switches.has("--paste") || port !== undefined))
      throw new UsageError("--public comes back to the owner's https address: it takes neither --paste nor --port", usage);
    return {
      command: "mcp",
      mcp: {
        action: "login",
        pluginId,
        open: !switches.has("--no-open"),
        ...(port === undefined ? {} : { port: Number(port) }),
        ...(switches.has("--public") ? { public: true } : {}),
        ...(switches.has("--paste") ? { paste: true } : {}),
        ...common,
      },
    };
  }
  if (name === "import") {
    const [file, ...extra] = positionals;
    if (file === undefined || extra.length > 0) throw new UsageError("mcp import needs exactly one file", usage);
    return {
      command: "mcp",
      mcp: { action: "import", file, dryRun: switches.has("--dry-run"), probe: !switches.has("--no-probe"), ...common },
    };
  }
  if (name === "search") {
    const query = positionals.join(" ").trim();
    if (query.length > 200) throw new UsageError("mcp search takes at most 200 characters", usage);
    const cursor = flags.get("--cursor");
    return payload({ action: "search", query, ...(cursor === undefined ? {} : { cursor }) });
  }
  if (name === "registry") {
    const [url, ...extra] = positionals;
    if (extra.length > 0 || (url !== undefined && switches.has("--default")))
      throw new UsageError("mcp registry takes a registry address, or --default, or nothing to show it", usage);
    return payload({ action: "registry", ...(url === undefined ? {} : { url }), reset: switches.has("--default") });
  }
  if (name === "line") {
    const [pluginId, ...words] = positionals;
    if (pluginId === undefined || mcpSlugOf(pluginId) === undefined) throw new UsageError("mcp line needs a server id (mcp.<name>)", usage);
    const text = words.join(" ").trim();
    if (switches.has("--clear") === (text !== "")) throw new UsageError("mcp line takes its text, or --clear", usage);
    return payload({ action: "line", pluginId, ...(text === "" ? {} : { text }) });
  }
  if (name === "remove-all") {
    if (positionals.length > 0) throw new UsageError("mcp remove-all takes no arguments", usage);
    return { command: "mcp", mcp: { action: "remove-all", yes: switches.has("--yes"), ...common } };
  }
  if (name === "people") {
    const [pluginId, state, ...extra] = positionals;
    if (pluginId === undefined || (state !== "on" && state !== "off") || extra.length > 0)
      throw new UsageError("mcp people needs a server id and on or off", usage);
    return payload({ action: "people", pluginId, on: state === "on", workspaceId: flags.get("--workspace") ?? "default" });
  }
  // `review` is `show` of what waits: a drifted or new tool, an upgrade, with the server's open notices first.
  if (name === "review") {
    const [pluginId, ...extra] = positionals;
    if (pluginId === undefined || extra.length > 0) throw new UsageError("mcp review needs exactly one server id (mcp.<name>)", usage);
    return payload({ action: "show", pluginId, ...(version === undefined ? {} : { version }) });
  }
  if (name === "probe" || name === "show" || name === "verify") {
    const [pluginId, ...extra] = positionals;
    if (pluginId === undefined || extra.length > 0) throw new UsageError(`mcp ${name} needs exactly one server id (mcp.<name>)`, usage);
    if (name === "probe")
      return payload({
        action: "probe",
        pluginId,
        ...(version === undefined ? {} : { version }),
        ...(sandbox === undefined ? {} : { sandbox }),
      });
    if (name === "show")
      return payload({
        action: "show",
        pluginId,
        ...(version === undefined ? {} : { version }),
        ...(switches.has("--full") ? { full: true } : {}),
      });
    return payload({ action: "verify", pluginId, ...(version === undefined ? {} : { version }), full: switches.has("--full") });
  }
  if (name === "approve" || name === "reject") {
    const [pluginId, at, ...extra] = positionals;
    if (pluginId === undefined || at === undefined || extra.length > 0)
      throw new UsageError(`mcp ${name} needs a server id and its version`, usage);
    if (name === "reject") return payload({ action: "reject", pluginId, version: at });
    const effects = pairs(all("--effect"), "--effect");
    for (const [tool, effect] of Object.entries(effects))
      if (effect !== "read-only" && effect !== "mutating" && effect !== "external")
        throw new UsageError(`--effect ${tool}= must be read-only, mutating or external`, usage);
    const floors = pairs(all("--floor"), "--floor");
    for (const [tool, floor] of Object.entries(floors))
      if (!["low", "medium", "high", "critical"].includes(floor))
        throw new UsageError(`--floor ${tool}= must be low, medium, high or critical`, usage);
    const timeouts = Object.fromEntries(
      Object.entries(pairs(all("--timeout"), "--timeout")).map(([tool, ms]) => {
        if (!/^\d+$/.test(ms)) throw new UsageError(`--timeout ${tool}= takes milliseconds`, usage);
        return [tool, Number(ms)];
      }),
    );
    return payload({
      action: "approve",
      pluginId,
      version: at,
      effects: effects as Record<string, ToolEffect>,
      floors: floors as Record<string, RiskLevel>,
      timeouts,
      disabled: [...all("--disable")],
      ...(sandbox === undefined ? {} : { sandbox }),
    });
  }
  const [slug, ...extra] = positionals;
  if (slug === undefined || extra.length > 0) throw new UsageError("mcp add needs exactly one server name", usage);
  const forms = ["--url", "--npm", "--pypi", "--dir", "--command", "--mcpb", "--registry", "--preset"].filter((flag) => flags.has(flag));
  if (forms.length !== 1)
    throw new UsageError("mcp add needs one of --url, --npm, --pypi, --dir, --command, --mcpb, --registry or --preset", usage);
  if (flags.has("--option") && !flags.has("--registry"))
    throw new UsageError("--option names a way to add a registry entry (--registry)", usage);
  let form: McpAddForm;
  if (flags.has("--preset")) {
    const preset = flags.get("--preset") as string;
    if (!(AVAILABLE_PRESETS as readonly string[]).includes(preset))
      throw new UsageError(`--preset must be one of ${AVAILABLE_PRESETS.join(", ")}, received ${JSON.stringify(preset)}`, usage);
    if (serverArgv !== undefined || all("--header").length > 0 || switches.has("--lan") || sandbox !== undefined)
      throw new UsageError("a preset sets its own address, headers and network; set its settings with `tavi plugins config` after", usage);
    for (const flag of ["--env", "--secret", "--domain", "--read", "--write"])
      if (all(flag).length > 0)
        throw new UsageError(`${flag} applies to a stdio server (--npm, --pypi, --dir, --command or --mcpb)`, usage);
    form = { kind: "preset", preset: preset as McpPresetId };
  } else if (flags.has("--url")) {
    if (serverArgv !== undefined) throw new UsageError("a remote server takes no argv after --", usage);
    for (const flag of ["--env", "--secret", "--domain", "--read", "--write"])
      if (all(flag).length > 0)
        throw new UsageError(`${flag} applies to a stdio server (--npm, --pypi, --dir, --command or --mcpb)`, usage);
    if (sandbox !== undefined)
      throw new UsageError("a remote server runs no code here; --nested and --unsandboxed apply to stdio servers", usage);
    form = {
      kind: "url",
      url: flags.get("--url") as string,
      headers: all("--header"),
      lan: switches.has("--lan"),
      oauth: switches.has("--oauth"),
    };
  } else {
    if (all("--header").length > 0 || switches.has("--lan") || switches.has("--oauth"))
      throw new UsageError("--header, --lan and --oauth apply to a remote server (--url)", usage);
    if (flags.has("--npm")) form = { kind: "npm", spec: flags.get("--npm") as string, args: serverArgv ?? [] };
    else if (flags.has("--pypi")) form = { kind: "pypi", spec: flags.get("--pypi") as string, args: serverArgv ?? [] };
    else if (flags.has("--mcpb")) form = { kind: "mcpb", path: flags.get("--mcpb") as string, args: serverArgv ?? [] };
    else if (flags.has("--registry")) {
      // An entry's own arguments and inputs are its listing's; Tavi's options here add to them.
      if (serverArgv !== undefined) throw new UsageError("a registry entry takes its arguments from its listing; no argv after --", usage);
      const entry = flags.get("--registry") as string;
      const at = entry.lastIndexOf("@");
      const option = flags.get("--option");
      if (option === undefined || !/^(?:npm|pypi|mcpb|remote)(?:-\d{1,2})?$/.test(option))
        throw new UsageError("mcp add --registry needs --option npm|pypi|mcpb|remote (as `tavi mcp search` lists them)", usage);
      form = { kind: "registry", name: at > 0 ? entry.slice(0, at) : entry, version: at > 0 ? entry.slice(at + 1) : "latest", option };
    } else if (flags.has("--dir")) {
      if (serverArgv === undefined || serverArgv.length === 0)
        throw new UsageError("mcp add --dir needs the server's argv after --, such as -- node index.js", usage);
      form = { kind: "dir", path: flags.get("--dir") as string, argv: serverArgv };
    } else form = { kind: "command", path: flags.get("--command") as string, args: serverArgv ?? [] };
  }
  const exposure = flags.get("--exposure");
  if (exposure !== undefined && exposure !== "auto" && exposure !== "always" && exposure !== "search")
    throw new UsageError(`--exposure must be auto, always or search, received ${JSON.stringify(exposure)}`, usage);
  const optional = (flag: string, key: "version" | "name" | "description") => (flags.has(flag) ? { [key]: flags.get(flag) as string } : {});
  return {
    command: "mcp",
    mcp: {
      action: "add",
      slug,
      form,
      env: all("--env"),
      ...(all("--secret").length === 0 ? {} : { secrets: all("--secret") }),
      domains: all("--domain"),
      read: all("--read"),
      write: all("--write"),
      ...(exposure === undefined ? {} : { exposure }),
      ...optional("--version", "version"),
      ...optional("--name", "name"),
      ...optional("--description", "description"),
      ...(sandbox === undefined ? {} : { sandbox }),
      probe: !switches.has("--no-probe"),
      ...common,
    },
  };
}
