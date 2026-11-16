import { parseSlots } from "./ui-client.js";
import { PLUGIN_UI_ROLES, PLUGIN_UI_SLOTS, type PluginUiRole, type PluginUiSlot } from "@tavi/contracts";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags, removalAlias } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";

const PLUGINS_ACTIONS = [
  "list",
  "show",
  "install",
  "add",
  "approve",
  "reject",
  "enable",
  "disable",
  "config",
  "remove",
  "validate",
  "audit",
] as const;
type PluginsAction = (typeof PLUGINS_ACTIONS)[number];

export const PLUGINS_USAGE = `tavi plugins <action> [options]

List, install, review, enable and configure plugins. Built-in plugins
ship with tavi; one that provides a service others need (core) cannot be
disabled. An external plugin is a directory with a tavi-plugin.json manifest
and an ES module entry: install copies it into the data directory as an
immutable, content-hashed version, proposed for review. It runs only after
you approve and enable it: as a confined worker (its own folder, the hosts its
manifest declares, no other credentials or files) when it can be one, else in
the owner's process with its privileges only if you approve it --in-process,
so approve only code you trust. Its tools keep the approval policy of the effect
the manifest declares. Plugins load when the owner (\`tavi serve\`) starts: a
change that alters what runs says a restart is needed, except that disabling or
rejecting withdraws a loaded plugin immediately. Under a running \`tavi serve\`
these actions run there; otherwise on the data directory.

Actions:
  list                         List built-in and installed plugins
  show <id>                    One plugin: versions, tools, settings, state
  install <path>               Install a plugin directory (alias: add)
  validate <path>              Check a plugin directory as install would, without
                               installing it; on macOS also run its register in
                               the sandbox and compare what it adds with the manifest
  approve|reject <id> <ver>    Review a version; reject also revokes an
                               approved one and withdraws it if loaded.
                               Approved code runs as a confined worker; one
                               that cannot be (channels, providers) or whose
                               manifest asks otherwise needs --in-process
  audit                        What each plugin running in-process would lose
                               as a worker: files, undeclared hosts, the
                               environment, child processes, native addons
  enable <id> [--version v]    Run it (default: the newest approved version)
  disable <id>                 Stop running it; a running owner withdraws a
                               loaded plugin immediately, as does rejecting
                               or removing the version it loaded
  config <id> --set k=v ...    Change an external plugin's settings or
             --unset k ...     provider instances; with --version, against
             --instances json  that version's settings (prepare an upgrade
                               before enabling it)
  remove <id> [--version v]    (alias: rm, delete) Uninstall an external plugin, or one version;
         [--yes]               a channel plugin whose channel purges says
                               first what its connections would erase in
                               24 hours, and goes only with --yes
  ui <action>                  Canvas roles and placements (tavi plugins ui --help)

Options:
  --version <ver>              The version enable, config or remove acts on
  --in-process                 approve: run it in the owner's process, unsandboxed
                               (UNSANDBOXED in list and doctor), not as a worker
  --set <key>=<value>          A setting (repeatable); typed by the manifest. A
                               credential setting takes a reference under
                               plugins.<id>. (tavi credentials set), never a secret
  --unset <key>                Clear a setting (repeatable)
  --instances <json>           Replace provider account instances
  --format <text|json>         Output format (default: text)
  --data-dir <path>            Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                   Show this help
`;

export interface PluginsCommandOptions {
  readonly action: Exclude<PluginsAction, "add">;
  readonly pluginId?: string | undefined;
  readonly version?: string | undefined;
  readonly path?: string | undefined;
  readonly instances?: string | undefined;
  /** `approve --in-process`: run it in the owner's process, unsandboxed. */
  readonly inProcess?: boolean | undefined;
  /** `remove`: confirmed, so a channel plugin whose connections are owed a purge is removed. */
  readonly yes?: boolean | undefined;
  readonly set: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

/** @public Read through the module namespace by test/cli/usage-text.test.ts, which checks every command's usage. */
export const PLUGINS_UI_USAGE = `tavi plugins ui <action> [options]

Which UI plugin fills each canvas role, and where plugins' canvas
contributions are shown, for one workspace. Changes apply to every
open page at once; nothing needs a restart. Under a running \`tavi serve\`
these run there; otherwise on the data directory.

Actions:
  list                               Roles, and every enabled contribution: shown
                                     or not, its slots, the channels it receives
  set-role <role> <plugin>           Fill a role (browser-view) with an enabled,
                                     approved plugin that declares it; builtin
                                     for the built-in, off for none. A plugin
                                     that receives a channel needs --yes, after
                                     its disclosure is shown
  place <plugin>/<contribution> <slots>
                                     Show it in these slots (comma-separated:
                                     ${PLUGIN_UI_SLOTS.join(", ")}) instead of
                                     its manifest's; hidden, or default again

Options:
  --show <while-active|always>       With place: when a chat.panel.top slot shows
  --yes                              With set-role: you saw the disclosure
  --workspace <id>                   Workspace (default: default)
  --format <text|json>               Output format (default: text)
  --data-dir <path>                  Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                         Show this help
`;

export interface PluginsUiOptions {
  readonly action: "list" | "set-role" | "place";
  readonly role?: PluginUiRole;
  /** set-role: a plugin id, `builtin` or `off`. */
  readonly plugin?: string;
  /** place: `<plugin-id>/<contribution-id>`. */
  readonly key?: string;
  readonly slots?: readonly PluginUiSlot[] | "hidden" | "default";
  readonly show?: "while-active" | "always";
  readonly yes: boolean;
  readonly workspaceId: string;
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

/** `tavi plugins ui <action>`. */
function parsePluginsUi(argv: readonly string[]): ParsedCommand {
  const usage = PLUGINS_UI_USAGE;
  const [action, ...rest] = argv;
  if (action === undefined || action === "-h" || action === "--help") return { command: "help", usage };
  if (action !== "list" && action !== "set-role" && action !== "place")
    throw new UsageError(`Unknown plugins ui action ${JSON.stringify(action)}; expected list, set-role or place`, usage);
  const args = parseFlags(rest, {
    usage,
    valued: ["--workspace", "--format", "--data-dir", ...(action === "place" ? ["--show"] : [])],
    switches: ["--yes"],
    unknown: (name) => `plugins ui ${action} does not accept ${name}`,
    switchValue: (name) => `plugins ui ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags, positionals } = args;
  const yes = args.switches.has("--yes");
  if (yes && action !== "set-role") throw new UsageError("--yes applies to plugins ui set-role only", usage);
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, usage);
  const base = { yes, workspaceId: flags.get("--workspace") ?? "default", format, ...dataDirectoryFlag(flags) } as const;
  if (action === "list") {
    if (positionals.length > 0) throw new UsageError("plugins ui list takes no arguments", usage);
    return { command: "plugins", pluginsUi: { action, ...base } };
  }
  if (action === "set-role") {
    const [role, plugin, ...extra] = positionals;
    if (role === undefined || plugin === undefined || extra.length > 0)
      throw new UsageError("plugins ui set-role needs a role and a plugin (or builtin, or off)", usage);
    if (!(PLUGIN_UI_ROLES as readonly string[]).includes(role))
      throw new UsageError(`Unknown role ${JSON.stringify(role)}; expected ${PLUGIN_UI_ROLES.join(", ")}`, usage);
    return { command: "plugins", pluginsUi: { action, role: role as PluginUiRole, plugin, ...base } };
  }
  const [key, where, ...extra] = positionals;
  if (key === undefined || where === undefined || extra.length > 0)
    throw new UsageError("plugins ui place needs <plugin>/<contribution> and slots, hidden or default", usage);
  const slots = parseSlots(where);
  if (slots === undefined)
    throw new UsageError(`${JSON.stringify(where)} is not a slot list; expected ${PLUGIN_UI_SLOTS.join(", ")}, hidden or default`, usage);
  const show = flags.get("--show");
  if (show !== undefined && show !== "while-active" && show !== "always")
    throw new UsageError(`--show must be "while-active" or "always", received ${JSON.stringify(show)}`, usage);
  return { command: "plugins", pluginsUi: { action, key, slots, ...(show === undefined ? {} : { show }), ...base } };
}

export function parsePlugins(argv: readonly string[]): ParsedCommand {
  const [typed, ...rest] = argv;
  // `rm`, `remove` and `delete` all name the removal.
  const given = removalAlias(typed, "remove");
  if (given === "-h" || given === "--help") return { command: "help", usage: PLUGINS_USAGE };
  if (given === "ui") return parsePluginsUi(rest);
  if (given === undefined) throw new UsageError(`plugins needs an action; expected one of ${PLUGINS_ACTIONS.join(", ")}`, PLUGINS_USAGE);
  if (!(PLUGINS_ACTIONS as readonly string[]).includes(given)) {
    throw new UsageError(`Unknown plugins action ${JSON.stringify(given)}; expected one of ${PLUGINS_ACTIONS.join(", ")}`, PLUGINS_USAGE);
  }
  const action = (given === "add" ? "install" : given) as PluginsCommandOptions["action"];
  const common = ["--data-dir", "--format"];
  const allowed: Readonly<Record<PluginsCommandOptions["action"], readonly string[]>> = {
    list: common,
    show: common,
    install: common,
    approve: ["--in-process", ...common],
    reject: common,
    disable: common,
    enable: ["--version", ...common],
    remove: ["--version", "--yes", ...common],
    config: ["--set", "--unset", "--instances", "--version", ...common],
    // Reads only the folder: a data directory (given, or as every plugins command takes one) is accepted and unused.
    validate: common,
    audit: common,
  };
  const switches = ["--in-process", "--yes"].filter((name) => allowed[action].includes(name));
  const args = parseFlags(rest, {
    usage: PLUGINS_USAGE,
    valued: allowed[action],
    // Switches: bare, or `=true`/`=false` (checked below); they never take the next argument.
    switches,
    switchesInFlags: true,
    lists: ["--set", "--unset"],
    unknown: (name) => `plugins ${given} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage: PLUGINS_USAGE };
  const { flags, positionals } = args;
  for (const name of switches) {
    const value = flags.get(name);
    if (value !== undefined && value !== "true" && value !== "false")
      throw new UsageError(`${name} takes no value (or =true / =false), received ${JSON.stringify(value)}`, PLUGINS_USAGE);
  }
  const set: Record<string, string> = {};
  for (const value of args.lists.get("--set") ?? []) {
    const at = value.indexOf("=");
    if (at <= 0) throw new UsageError(`--set takes key=value, received ${JSON.stringify(value)}`, PLUGINS_USAGE);
    set[value.slice(0, at)] = value.slice(at + 1);
  }
  const unset = [...(args.lists.get("--unset") ?? [])];

  const expected = action === "list" || action === "audit" ? 0 : action === "approve" || action === "reject" ? 2 : 1;
  if (positionals.length !== expected) {
    const what =
      action === "install" || action === "validate"
        ? "a plugin directory path"
        : action === "approve" || action === "reject"
          ? "a plugin id and a version"
          : "a plugin id";
    throw new UsageError(
      expected === 0 ? `plugins ${given} takes no positional arguments` : `plugins ${given} needs ${what}`,
      PLUGINS_USAGE,
    );
  }
  // Present for every action that takes one: the count was checked above.
  const subject = (): string => {
    const first = positionals[0];
    if (first === undefined) throw new UsageError(`plugins ${given} needs a plugin id`, PLUGINS_USAGE);
    return first;
  };
  if (action === "config" && Object.keys(set).length === 0 && unset.length === 0 && !flags.has("--instances"))
    throw new UsageError("plugins config needs --set key=value, --unset key or --instances json", PLUGINS_USAGE);
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, PLUGINS_USAGE);
  const version = action === "approve" || action === "reject" ? positionals[1] : flags.get("--version");
  const instances = flags.get("--instances");
  return {
    command: "plugins",
    plugins: {
      action,
      ...(action === "install" || action === "validate"
        ? { path: subject() }
        : action === "list" || action === "audit"
          ? {}
          : { pluginId: subject() }),
      ...(version === undefined ? {} : { version }),
      set,
      unset,
      format,
      ...(instances === undefined ? {} : { instances }),
      ...(flags.get("--in-process") === "true" ? { inProcess: true } : {}),
      ...(flags.get("--yes") === "true" ? { yes: true } : {}),
      ...dataDirectoryFlag(flags),
    },
  };
}
