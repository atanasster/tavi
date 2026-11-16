import {
  APP_MAILBOX_ACCESS,
  APP_PERMISSION_TARGETS,
  APP_SHARING,
  type AppMailboxAccess,
  MCP_PRESET_IDS,
  type AppPermissionTarget,
  type AppSharing,
  type AppsPayload,
  type CatalogRef,
} from "@tavi/contracts";
import type { ParsedCommand } from "../../cli/parse.js";
import { UsageError, dataDirectoryFlag, parseFlags, removalAlias } from "../../cli/argv.js";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";

/**
 * `tavi apps`: Connected apps'
 * thin front over the `apps` command, through the running owner. `tavi mcp`
 * and `tavi channels` keep their own verbs: review, approve, ingress, people,
 * logs.
 *
 * @public Read through the module namespace by test/cli/usage-text.test.ts, which checks every command's usage.
 */
export const APPS_USAGE = `tavi apps <action> [options]

Connected apps (docs/APPS.md): every account and app Tavi works with — MCP
servers, channel connections and plugins — as the canvas's Settings →
Connected apps shows them. Needs a running owner (\`tavi serve\`).

Actions:
  list [--needs-you]           Every app, its health, its accounts, and its fix
                               with the command for it; --needs-you, only those
                               that need you
  catalog [<words>]            Tavi's presets, installed apps not set up and the
                               channels; words also search the MCP Registry
  add <preset> | <registry-name>@<version> --option npm|pypi|mcpb|remote [--switch]
                               Add a preset, or a registry entry by one way in;
                               --switch: a preset that is another way into a
                               server already added (Todoist's sign-in or its
                               API token) replaces that server, its sign-in or
                               key removed and its tools reviewed again
  show <app>                   One app: its accounts, what each tool may do,
                               where its calls go, and what it returns
  connect <app> [--account <id> | --add-account] [--no-open] [--port <n>] [--public | --paste]
                               Sign in (again): the browser opens here and comes
                               back to this computer (on --port, for a tunnel,
                               else any free one); --public:
                               back to the owner's https address; --paste: on
                               another computer, paste the address it lands on.
                               --add-account adds a preset's next account first
  disconnect <app> --account <id> [--remove]
                               Revoke an account's sign-in where the provider
                               allows it, or only forget it here while another
                               app keeps the same grant (it says which);
                               --remove also removes a second account
  test <app> [--account <id>]  Call the account once and say whether it answered
  activity <app> [--account <id>] [--cursor <c>]
                               What its tools changed or sent, what you were
                               asked about them, and its read-only tools' calls,
                               newest first
  permission <app> <tool> allow|ask|block
                               What a tool may do; an MCP write is never allowed
                               without asking
  sharing <app> <account> personal|shared
                               Personal: only your own one-to-one chats; Shared:
                               people you allowed may use it
  remove <app>                 Remove the app and every account of it (alias: rm, delete)
  mailbox <app> <account> off|read|send
                               What the agent may do in a mailbox account: read
                               and draft, or also send drafts you approve, each
                               one shown before it goes
  receive <app> <account> on|off
                               Whether a channel account takes messages in
                               (a Google account: Reach Tavi by email); off, it
                               only carries its mailbox's and calendar's tools
  calendar <app> <account> on|off
                               Let the agent use the account's calendar: read
                               it and find free time, and add or change events
                               you approve; its next sign-in asks Google for it
  sites <app> <site> on|off    Let the agent browse a site the app's profile
                               names, within the profile's rules and budgets;
                               every site is off until you turn it on
  client <app> --file <path> | --id <client id> [--secret-file <path>]
                               Set the OAuth client every app of the app's
                               provider shares (its mail channel's and its
                               calendar's alike): the client file its console
                               downloads (a Google Desktop app client's JSON),
                               or its id and a file holding its secret; the
                               secret is kept only in an encrypted credential
                               store

Common:
  --workspace <id>             The workspace (default: default)
  --format <text|json>         Output format (default: text)
  --data-dir <path>            Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                   Show this help
`;

const ACTIONS = [
  "list",
  "catalog",
  "add",
  "show",
  "connect",
  "disconnect",
  "test",
  "activity",
  "permission",
  "sharing",
  "remove",
  "mailbox",
  "calendar",
  "receive",
  "sites",
  "client",
] as const;
type Action = (typeof ACTIONS)[number];

const ALLOWED: Readonly<Record<Action, readonly string[]>> = {
  list: ["--needs-you", "--workspace"],
  catalog: ["--workspace", "--cursor"],
  add: ["--option", "--switch", "--workspace"],
  show: ["--workspace"],
  connect: ["--account", "--add-account", "--no-open", "--port", "--public", "--paste", "--workspace"],
  disconnect: ["--account", "--remove", "--workspace"],
  test: ["--account", "--workspace"],
  activity: ["--account", "--cursor", "--workspace"],
  permission: ["--workspace"],
  sharing: ["--workspace"],
  remove: ["--workspace"],
  mailbox: ["--workspace"],
  calendar: ["--workspace"],
  receive: ["--workspace"],
  sites: ["--workspace"],
  client: ["--file", "--id", "--secret-file", "--workspace"],
};
const SWITCHES: ReadonlySet<string> = new Set(["--needs-you", "--add-account", "--no-open", "--public", "--paste", "--remove", "--switch"]);

interface Common {
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

/** An `apps` payload as it is sent to the owner; `needsYou` narrows a list as it is printed. */
interface AppsPayloadCommandOptions extends Common {
  readonly action: "payload";
  readonly payload: AppsPayload;
  readonly needsYou?: boolean;
  /** `client`: the file the client secret is read from, into the payload, as it is sent (never an argument). */
  readonly secretFile?: string;
  /** `client`: the provider's client file, read into the payload as it is sent. */
  readonly clientFile?: string;
}

/** `tavi apps connect`: an MCP account's sign-in, as `tavi mcp login` does it, found from the app. */
export interface AppsConnectCommandOptions extends Common {
  readonly action: "connect";
  readonly appId: string;
  readonly accountId?: string;
  readonly addAccount: boolean;
  readonly open: boolean;
  readonly port?: number;
  readonly public: boolean;
  readonly paste: boolean;
  readonly workspaceId: string;
}

/** `tavi apps test`: the app's first account when none is named. */
export interface AppsTestCommandOptions extends Common {
  readonly action: "test";
  readonly appId: string;
  readonly accountId?: string;
  readonly workspaceId: string;
}

export type AppsCommandOptions = AppsPayloadCommandOptions | AppsConnectCommandOptions | AppsTestCommandOptions;

/** A preset by its id, else a registry entry named `<name>@<version>`, added by its `--option`. */
export function catalogRefOf(name: string, option: string | undefined): CatalogRef {
  if ((MCP_PRESET_IDS as readonly string[]).includes(name)) {
    if (option !== undefined) throw new UsageError(`${name} is a preset: it takes no --option`, APPS_USAGE);
    return { kind: "preset", id: name as (typeof MCP_PRESET_IDS)[number] };
  }
  const at = name.lastIndexOf("@");
  if (at <= 0 || at === name.length - 1)
    throw new UsageError(
      `${name} is not a preset (${MCP_PRESET_IDS.join(", ")}); a registry entry is <name>@<version> (tavi apps catalog <words> lists them)`,
      APPS_USAGE,
    );
  if (option === undefined || !/^(?:npm|pypi|mcpb|remote)(?:-\d{1,2})?$/.test(option))
    throw new UsageError("a registry entry needs --option npm, pypi, mcpb or remote (as tavi apps catalog lists it)", APPS_USAGE);
  return { kind: "registry", name: name.slice(0, at), version: name.slice(at + 1), option };
}

export function parseApps(argv: readonly string[]): ParsedCommand {
  const usage = APPS_USAGE;
  const [typed, ...rest] = argv;
  // `rm`, `remove` and `delete` all name the removal.
  const action = removalAlias(typed, "remove");
  if (action === undefined) throw new UsageError(`apps needs an action; expected one of ${ACTIONS.join(", ")}`, usage);
  if (action === "-h" || action === "--help") return { command: "help", usage };
  if (!(ACTIONS as readonly string[]).includes(action))
    throw new UsageError(`Unknown apps action ${JSON.stringify(action)}; expected one of ${ACTIONS.join(", ")}`, usage);
  const name = action as Action;
  const accepted = ["--format", "--data-dir", ...ALLOWED[name]];
  const args = parseFlags(rest, {
    usage,
    valued: accepted,
    switches: accepted.filter((flag) => SWITCHES.has(flag)),
    unknown: (flag) => `apps ${name} does not accept ${flag}`,
    switchValue: (flag) => `${flag} takes no value`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags, switches, positionals } = args;
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, usage);
  const common: Common = { format, ...dataDirectoryFlag(flags) };
  const workspaceId = flags.get("--workspace") ?? "default";
  const payload = (
    value: AppsPayload,
    extra: { readonly needsYou?: boolean; readonly secretFile?: string; readonly clientFile?: string } = {},
  ): ParsedCommand => ({
    command: "apps",
    apps: { action: "payload", payload: value, ...extra, ...common },
  });
  const exactly = (count: number, what: string): readonly string[] => {
    if (positionals.length !== count) throw new UsageError(`apps ${name} needs ${what}`, usage);
    return positionals;
  };
  const account = flags.get("--account");
  switch (name) {
    case "list":
      exactly(0, "no arguments");
      return payload({ action: "list", workspaceId }, switches.has("--needs-you") ? { needsYou: true } : {});
    case "catalog": {
      const cursor = flags.get("--cursor");
      return payload({
        action: "catalog",
        query: positionals.join(" ").slice(0, 200),
        workspaceId,
        ...(cursor === undefined ? {} : { cursor }),
      });
    }
    case "add": {
      const [entry] = exactly(1, "one preset or registry entry");
      return payload({
        action: "add",
        entry: catalogRefOf(entry as string, flags.get("--option")),
        ...(switches.has("--switch") ? { switch: true as const } : {}),
        workspaceId,
      });
    }
    case "show":
    case "remove": {
      const [appId] = exactly(1, "one app");
      return payload({ action: name, appId: appId as string, workspaceId });
    }
    case "connect": {
      const [appId] = exactly(1, "one app");
      if (switches.has("--public") && switches.has("--paste")) throw new UsageError("--public and --paste cannot both be given", usage);
      if (switches.has("--add-account") && account !== undefined)
        throw new UsageError("--add-account and --account cannot both be given", usage);
      const port = flags.get("--port");
      if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65_535))
        throw new UsageError("--port takes 1024 to 65535", usage);
      // A paste comes back to this computer's address too: a tunnel names its port.
      if (port !== undefined && switches.has("--public"))
        throw new UsageError("--port is for coming back to this computer; --public comes back to the owner's https address", usage);
      return {
        command: "apps",
        apps: {
          action: "connect",
          appId: appId as string,
          ...(account === undefined ? {} : { accountId: account }),
          addAccount: switches.has("--add-account"),
          open: !switches.has("--no-open"),
          ...(port === undefined ? {} : { port: Number(port) }),
          public: switches.has("--public"),
          paste: switches.has("--paste"),
          workspaceId,
          ...common,
        },
      };
    }
    case "disconnect": {
      const [appId] = exactly(1, "one app");
      if (account === undefined) throw new UsageError("apps disconnect needs --account <id> (tavi apps show lists them)", usage);
      return payload({ action: "disconnect", appId: appId as string, accountId: account, remove: switches.has("--remove"), workspaceId });
    }
    case "test": {
      const [appId] = exactly(1, "one app");
      return {
        command: "apps",
        apps: { action: "test", appId: appId as string, ...(account === undefined ? {} : { accountId: account }), workspaceId, ...common },
      };
    }
    case "activity": {
      const [appId] = exactly(1, "one app");
      const cursor = flags.get("--cursor");
      return payload({
        action: "activity",
        appId: appId as string,
        ...(account === undefined ? {} : { accountId: account }),
        ...(cursor === undefined ? {} : { cursor }),
        workspaceId,
      });
    }
    case "permission": {
      const [appId, toolId, target] = exactly(3, "an app, a tool and allow, ask or block");
      if (!(APP_PERMISSION_TARGETS as readonly string[]).includes(target as string))
        throw new UsageError(`a tool's target is ${APP_PERMISSION_TARGETS.join(", ")}`, usage);
      return payload({
        action: "permission",
        appId: appId as string,
        toolId: toolId as string,
        target: target as AppPermissionTarget,
        workspaceId,
      });
    }
    case "mailbox": {
      const [appId, accountId, access] = exactly(3, "an app, an account and off, read or send");
      if (!(APP_MAILBOX_ACCESS as readonly string[]).includes(access as string))
        throw new UsageError(`a mailbox is ${APP_MAILBOX_ACCESS.join(", ")}`, usage);
      return payload({
        action: "mailbox",
        appId: appId as string,
        accountId: accountId as string,
        mailbox: access as AppMailboxAccess,
        workspaceId,
      });
    }
    case "receive": {
      const [appId, accountId, state] = exactly(3, "an app, an account and on or off");
      if (state !== "on" && state !== "off") throw new UsageError("whether an account takes messages in is on or off", usage);
      return payload({ action: "receive", appId: appId as string, accountId: accountId as string, on: state === "on", workspaceId });
    }
    case "calendar": {
      const [appId, accountId, state] = exactly(3, "an app, an account and on or off");
      if (state !== "on" && state !== "off") throw new UsageError("an account's calendar is on or off", usage);
      return payload({ action: "calendar", appId: appId as string, accountId: accountId as string, on: state === "on", workspaceId });
    }
    case "sites": {
      const [appId, siteId, state] = exactly(3, "an app, a site and on or off");
      if (state !== "on" && state !== "off") throw new UsageError("a site is on or off", usage);
      return payload({ action: "sites", appId: appId as string, siteId: siteId as string, on: state === "on", workspaceId });
    }
    case "client": {
      const [appId] = exactly(1, "one app");
      const json = flags.get("--file");
      const id = flags.get("--id");
      const secretFile = flags.get("--secret-file");
      if (json !== undefined) {
        if (id !== undefined || secretFile !== undefined)
          throw new UsageError("apps client takes --file <path>, or --id with --secret-file: not both", usage);
        return payload({ action: "configure", appId: appId as string, values: {}, workspaceId }, { clientFile: json });
      }
      if (id === undefined || id.trim() === "") throw new UsageError("apps client needs --file <path>, or --id <client id>", usage);
      return payload(
        { action: "configure", appId: appId as string, values: { clientId: id.trim() }, workspaceId },
        secretFile === undefined ? {} : { secretFile },
      );
    }
    case "sharing": {
      const [appId, accountId, sharing] = exactly(3, "an app, an account and personal or shared");
      if (!(APP_SHARING as readonly string[]).includes(sharing as string)) throw new UsageError("an account is personal or shared", usage);
      return payload({
        action: "sharing",
        appId: appId as string,
        accountId: accountId as string,
        sharing: sharing as AppSharing,
        workspaceId,
      });
    }
  }
}
