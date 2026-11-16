import { ADDRESS_KINDS, MESSAGING_DISPLAY_NAME_MAX, type AddressKind } from "@tavi/contracts";
import { csvList } from "@tavi/contracts/util";
import type { ParsedCommand } from "../../cli/parse.js";
import { UsageError, dataDirectoryFlag, integerFlag, parseFlags, removalAlias } from "../../cli/argv.js";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";

/**
 * `tavi channels`: the same
 * `channels` command Settings → Channels speaks, from a terminal — on the
 * live owner when `tavi serve` runs, else on the data directory itself.
 * Every channel is configured the same way, from its descriptor: settings by
 * their keys as flags, secrets from files.
 */

const CHANNELS_ACTIONS = [
  "list",
  "types",
  "add",
  "set",
  "secret",
  "enable",
  "disable",
  "remove",
  "test",
  "ingress",
  "connect",
  "disconnect",
  "people",
  "link",
  "pair",
  "unlink",
  "revoke",
  "rooms",
  "grant",
  "grants",
  "forget-sender",
  "share-client",
] as const;
export type ChannelsAction = (typeof CHANNELS_ACTIONS)[number];

export const CHANNELS_USAGE =
  `tavi channels <action> [options]

Configure the channels the agent is reached on and sends through. Each
channel's settings and secrets are its own: \`tavi channels types\` lists them.
Changes apply at once on a running \`tavi serve\`, and at its next start
otherwise.

Actions:
  list                         The workspace's connections, with their status
  types                        Every installed channel, its settings and secrets
  add <provider>               Add a connection; settings as --<key> <value>,
                               secrets as --secret-file <key>=<path>
  set <connection>             Change a connection's settings (--<key> <value>,
                               an empty value to clear one)
  secret <connection> <key>    Store one of its secrets from --file <path>
  enable <connection>          Open it
  disable <connection>         Close it; its settings and secrets stay
  remove <connection>          (alias: rm, delete) Close it, delete its secrets, revoke the people
                               allowed on it; its history stays, except on a
                               channel that erases what it brought in 24 hours
                               after removal (it says what, and asks --yes)
  test <connection>            Send a short message to --to <target>
  ingress                      Set the webhook listener's --port,
                               --public-url (empty to clear) and
                               --trusted-proxies
  connect <connection>         Sign a connection in with its provider (OAuth):
                               prints the address to open in a browser, and
                               waits for the sign-in (needs \`tavi serve\`)
  disconnect <connection>      Sign it out at the provider and forget its token
                               (forgotten here only while another app, such
                               as Google Calendar, keeps the same sign-in)
  people [connection]          Who is allowed to chat through the workspace's
                               connections (or one connection)
  link [connection]            Link a person with a one-time code (` +
  "`/link <code>`" +
  `
                               or the channel's deep link), waited for and
                               confirmed before allowing (needs \`tavi serve\`)
  pair [connection]            The same as link
  unlink <connection> <sender> Revoke an allowed person's access on a
                               connection (or --sender <id>)
  revoke <connection> <sender> The same as unlink
  rooms <connection> [list]    A group channel's rooms, the rooms waiting to be
                               added, and what its rooms policy dropped
  rooms <connection> add <id>  Listen in a room (sends it a short
                               introduction; needs \`tavi serve\`)
  rooms <connection> set <id>  Change a room's --label, --trigger, --members, --auto-thread or --context
  rooms <connection> remove <id> (alias: rm, delete)
                               Stop listening in a room
  rooms <connection> leave <id>
                               Leave a room the agent was added to
  grant <connection> room|contact <id> <tool> allow|deny
                               Grant or deny one tool in a room, or in one
                               person's one-to-one chat (by their sender id).
                               A room is only ever denied; --expires <time>
                               ends it (needs \`tavi serve\` or no owner)
  grants <connection> [list]   The connection's grants, and whether each is
                               in force
  grants <connection> revoke <grant-id>
                               Revoke a grant, from its chat's next turn on
  share-client <provider> <plugin>|off
                               Let a channel plugin sign in with the OAuth
                               client <provider>'s apps share (its review
                               names it), or take that back; its signed-in
                               connections sign out, to be connected again
  forget-sender <connection> <sender>
                               Erase what a person sent on a connection, at
                               their request: their messages and files, their
                               binding, and what their own chats taught
                               (needs --yes and \`tavi serve\`); names the
                               conversations whose saved turns still hold
                               their words

Options:
  --name <text>                add/set: the connection's own name; link/pair:
                               the person's display name
  --principal <id>             link/pair: person ID to bind (default: the
                               workspace operator)
  --sender <id>                unlink/revoke: the sender ID to revoke
  --trust-unverified           link/pair: admit unverified messages on a
                               per-message channel (email)
  --disabled                   add: save it without opening it
  --secret-file <key>=<path>   add: a secret, read from a file (repeatable)
  --set <key>=<value>          add/set: a setting, for one whose key is also
                               an option here (repeatable)
  --file <path>                secret: the file the secret is read from
  --to <target>                test: who to send to, as the channel names one
  --text <text>                test: the message (default: a short test line)
  --yes                        remove: erase what it brought in, on a channel
                               that does, without asking; link/pair: confirm
                               the sender who claims the code without asking;
                               forget-sender: go ahead
  --port <port>                ingress: the local port (1024-65535)
  --public-url <url>           ingress: the https address in front of it
  --trusted-proxies <list>     ingress: reverse proxies, besides one on this
                               machine, whose X-Forwarded-For names the
                               caller: IPs or CIDR ranges, comma-separated
                               (empty to clear; left out, the list stays)
  --label <text>               rooms add/set: your name for the room
  --trigger <kinds>            rooms add/set: what addresses the agent there,
                               comma-separated: mention, reply, thread,
                               command, picked (default: the channel's own)
  --members <who>              rooms add/set: bound (anyone you allowed, the
                               default) or operator-only
  --auto-thread <on|off>       rooms add/set: answer each message in a thread
                               opened from it (a channel that can; default off)
  --context <recent|off>       rooms set: also read up to 20 of the room's
                               messages before one that addresses the agent
                               (a channel that can; default off)
  --expires <time>             grant: when it stops (an ISO time)
  --workspace <id>             Workspace to act in (default: default)
  --format <text|json>         Output format (default: text)
  --data-dir <path>            Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                   Show this help
`;

export interface ChannelsCommandOptions {
  readonly action: ChannelsAction;
  /** The provider (`add`) or connection id (the rest). */
  readonly target?: string;
  /** `secret`: the secret's key; `forget-sender`/`unlink`/`revoke`: the sender id. */
  readonly field?: string;
  readonly name?: string;
  /** `link`/`pair`: the principal id to bind (defaults to the workspace operator). */
  readonly principalId?: string;
  /** `unlink`/`revoke`: the sender id to revoke. */
  readonly sender?: string;
  /** `link`/`pair`: whether unverified messages are admitted on a per-message channel. */
  readonly trustUnverified?: boolean;
  readonly disabled?: boolean;
  /** `remove`: what a purging channel erases is agreed to; `link`/`pair`: auto-confirm. */
  readonly yes?: boolean;
  /** Settings as typed: `--<key> <value>`. */
  readonly settings: Readonly<Record<string, string>>;
  readonly secretFiles: Readonly<Record<string, string>>;
  readonly file?: string;
  readonly to?: string;
  readonly text?: string;
  readonly port?: number;
  readonly publicUrl?: string;
  /** `ingress`: the reverse proxies whose `X-Forwarded-For` is believed; empty clears them. */
  readonly trustedProxies?: readonly string[];
  /** `rooms`: what to do, the room it is done to, and the room's settings. */
  readonly roomOp?: "list" | "add" | "set" | "remove" | "leave";
  readonly conversationId?: string;
  readonly label?: string;
  readonly trigger?: readonly AddressKind[];
  readonly members?: "bound" | "operator-only";
  readonly autoThread?: boolean;
  readonly context?: "recent" | "off";
  /** `grant` and `grants`: the grant's scope, tool and mode; the grant revoked; when it stops. */
  readonly grant?: {
    readonly scopeKind: "room" | "contact";
    readonly scopeId: string;
    readonly toolId: string;
    readonly mode: "allow" | "deny";
    readonly expiresAt?: string;
  };
  readonly grantsOp?: "list" | "revoke";
  readonly grantId?: string;
  readonly workspaceId: string;
  readonly format: "text" | "json";
  readonly dataDirectory?: string;
}

/** `channels`' own flags: a channel setting of the same name is given as `--set <key>=<value>`. */
export const FIXED_FLAGS: ReadonlySet<string> = new Set([
  "--name",
  "--principal",
  "--sender",
  "--trust-unverified",
  "--disabled",
  "--yes",
  "--secret-file",
  "--set",
  "--file",
  "--to",
  "--text",
  "--port",
  "--public-url",
  "--trusted-proxies",
  "--label",
  "--trigger",
  "--members",
  "--auto-thread",
  "--context",
  "--expires",
  "--workspace",
  "--format",
  "--data-dir",
]);
const ACTION_FLAGS: Readonly<Record<ChannelsAction, readonly string[]>> = {
  list: [],
  types: [],
  add: ["--name", "--disabled", "--secret-file", "--set"],
  set: ["--name", "--set"],
  secret: ["--file"],
  enable: [],
  disable: [],
  remove: ["--yes"],
  "forget-sender": ["--yes"],
  "share-client": [],
  test: ["--to", "--text"],
  ingress: ["--port", "--public-url", "--trusted-proxies"],
  connect: [],
  disconnect: [],
  people: [],
  link: ["--principal", "--name", "--trust-unverified", "--yes"],
  pair: ["--principal", "--name", "--trust-unverified", "--yes"],
  unlink: ["--sender"],
  revoke: ["--sender"],
  rooms: ["--label", "--trigger", "--members", "--auto-thread", "--context"],
  grant: ["--expires"],
  grants: [],
};
/** How many positionals each fixed-arity action takes. */
const POSITIONALS: Readonly<
  Record<Exclude<ChannelsAction, "rooms" | "grants" | "people" | "link" | "pair" | "unlink" | "revoke">, number>
> = {
  list: 0,
  types: 0,
  add: 1,
  set: 1,
  secret: 2,
  enable: 1,
  disable: 1,
  remove: 1,
  test: 1,
  ingress: 0,
  connect: 1,
  disconnect: 1,
  grant: 5,
  "forget-sender": 2,
  "share-client": 2,
};
const ROOM_OPS = ["list", "add", "set", "remove", "leave"] as const;

/** Parse `tavi channels <action>`. A flag no action names is a setting, for `add` and `set` only. */
export function parseChannels(argv: readonly string[]): ParsedCommand {
  const [typed, ...rest] = argv;
  // `rm`, `remove` and `delete` all name the removal.
  const action = removalAlias(typed, "remove");
  if (action === "-h" || action === "--help") return { command: "help", usage: CHANNELS_USAGE };
  if (action === undefined)
    throw new UsageError(`channels needs an action; expected one of ${CHANNELS_ACTIONS.join(", ")}`, CHANNELS_USAGE);
  if (!(CHANNELS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `Unknown channels action ${JSON.stringify(action)}; expected one of ${CHANNELS_ACTIONS.join(", ")}`,
      CHANNELS_USAGE,
    );
  }
  const resolved = action as ChannelsAction;
  const permitted = ["--workspace", "--format", "--data-dir", ...ACTION_FLAGS[resolved]];
  const takesSettings = resolved === "add" || resolved === "set";
  const args = parseFlags(rest, {
    usage: CHANNELS_USAGE,
    // `add` and `set` take any other flag as a setting.
    ...(takesSettings ? {} : { valued: permitted }),
    switches: ["--disabled", "--yes", "--trust-unverified"],
    switchValue: (name) => `${name} takes no value`,
    lists: ["--set", "--secret-file"],
    unknown: (name) => `channels ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage: CHANNELS_USAGE };
  const { positionals } = args;
  const flags = new Map<string, string>();
  for (const name of args.switches) {
    if (!permitted.includes(name)) throw new UsageError(`channels ${action} does not accept ${name}`, CHANNELS_USAGE);
    flags.set(name, "yes");
  }
  const settings: Record<string, string> = {};
  for (const [name, value] of args.flags) {
    // A setting is named: a bare `--` names none.
    if (name === "--") throw new UsageError(`channels ${action} does not accept --`, CHANNELS_USAGE);
    if (!FIXED_FLAGS.has(name)) settings[name.slice(2)] = value;
    else if (!permitted.includes(name))
      throw new UsageError(
        takesSettings
          ? `channels ${action} does not accept ${name}: give the setting as --set ${name.slice(2)}=<value>`
          : `channels ${action} does not accept ${name}`,
        CHANNELS_USAGE,
      );
    else flags.set(name, value);
  }
  for (const name of args.lists.keys())
    if (!permitted.includes(name)) throw new UsageError(`channels ${action} does not accept ${name}`, CHANNELS_USAGE);
  const secretFiles: Record<string, string> = {};
  for (const value of args.lists.get("--secret-file") ?? []) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) throw new UsageError("--secret-file takes <key>=<path>", CHANNELS_USAGE);
    secretFiles[value.slice(0, separator)] = value.slice(separator + 1);
  }
  for (const value of args.lists.get("--set") ?? []) {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new UsageError("--set takes <key>=<value>", CHANNELS_USAGE);
    settings[value.slice(0, separator)] = value.slice(separator + 1);
  }
  if (resolved === "rooms") return { command: "channels", channels: parsedRooms(positionals, flags) };
  if (resolved === "grants") return { command: "channels", channels: parsedGrants(positionals, flags) };
  if (resolved === "people" || resolved === "link" || resolved === "pair") {
    if (positionals.length > 1) throw new UsageError(`channels ${action} takes at most one connection argument`, CHANNELS_USAGE);
  } else if (resolved === "unlink" || resolved === "revoke") {
    const senderFlag = flags.get("--sender");
    if (positionals.length > 2 || (positionals.length === 2 && senderFlag !== undefined)) {
      throw new UsageError(`channels ${action} takes <connection> <sender>`, CHANNELS_USAGE);
    }
    if (positionals.length < 2 && senderFlag === undefined) {
      throw new UsageError(`channels ${action} needs a sender: \`channels ${action} <connection> <sender>\``, CHANNELS_USAGE);
    }
  } else if (positionals.length !== POSITIONALS[resolved]) {
    const expected = {
      0: "no argument",
      1: "one argument",
      2: "two arguments",
      5: "a connection, room or contact, its id, a tool, and allow or deny",
    }[POSITIONALS[resolved]];
    throw new UsageError(`channels ${action} takes ${expected}`, CHANNELS_USAGE);
  }
  if (resolved === "grant") return { command: "channels", channels: parsedGrant(positionals, flags) };
  if (resolved === "secret" && !flags.has("--file")) throw new UsageError("channels secret needs --file", CHANNELS_USAGE);
  if (resolved === "test" && !flags.has("--to")) throw new UsageError("channels test needs --to", CHANNELS_USAGE);
  if (resolved === "ingress" && !flags.has("--port")) throw new UsageError("channels ingress needs --port", CHANNELS_USAGE);
  const nameFlag = flags.get("--name");
  if (nameFlag !== undefined && (nameFlag.trim() === "" || nameFlag.trim().length > MESSAGING_DISPLAY_NAME_MAX))
    throw new UsageError(`--name must be 1-${MESSAGING_DISPLAY_NAME_MAX} non-blank characters`, CHANNELS_USAGE);
  const principalFlag = flags.get("--principal");
  if (principalFlag !== undefined && principalFlag.trim() === "") throw new UsageError("--principal must not be empty", CHANNELS_USAGE);
  const senderValue = flags.get("--sender") ?? (resolved === "unlink" || resolved === "revoke" ? positionals[1] : undefined);
  if ((resolved === "unlink" || resolved === "revoke") && (senderValue === undefined || senderValue.trim() === ""))
    throw new UsageError(`channels ${action} needs a non-empty sender`, CHANNELS_USAGE);
  const format = formatFlag(flags);
  const portFlag = flags.get("--port");
  const port =
    portFlag === undefined
      ? undefined
      : integerFlag(portFlag, { min: 1024, max: 65535 }, "--port must be between 1024 and 65535", CHANNELS_USAGE);
  const trustedProxiesFlag = flags.get("--trusted-proxies");
  const trustedProxies = trustedProxiesFlag === undefined ? undefined : csvList(trustedProxiesFlag);
  const optional = (flag: string, key: string): Record<string, string> => {
    const value = flags.get(flag);
    return value === undefined ? {} : { [key]: value };
  };
  const options: ChannelsCommandOptions = {
    action: resolved,
    ...(positionals[0] === undefined ? {} : { target: positionals[0] }),
    ...(positionals[1] === undefined ? {} : { field: positionals[1] }),
    ...(nameFlag === undefined ? {} : { name: nameFlag.trim() }),
    ...(principalFlag === undefined ? {} : { principalId: principalFlag.trim() }),
    ...(senderValue === undefined ? {} : { sender: senderValue.trim() }),
    ...(flags.has("--trust-unverified") ? { trustUnverified: true } : {}),
    ...(flags.has("--disabled") ? { disabled: true } : {}),
    ...(flags.has("--yes") ? { yes: true } : {}),
    settings,
    secretFiles,
    ...optional("--file", "file"),
    ...optional("--to", "to"),
    ...optional("--text", "text"),
    ...(port === undefined ? {} : { port }),
    ...optional("--public-url", "publicUrl"),
    ...(trustedProxies === undefined ? {} : { trustedProxies }),
    workspaceId: flags.get("--workspace") ?? "default",
    format,
    ...dataDirectoryFlag(flags),
  };
  return { command: "channels", channels: options };
}

/** `tavi channels rooms <connection> [list|add|set|remove|leave <id>]` and its room settings. */
function parsedRooms(positionals: readonly string[], flags: ReadonlyMap<string, string>): ChannelsCommandOptions {
  const [connectionId, typedOp = "list", conversationId, ...extra] = positionals;
  const op = removalAlias(typedOp, "remove") ?? "list";
  if (connectionId === undefined) throw new UsageError("channels rooms names the connection", CHANNELS_USAGE);
  if (!(ROOM_OPS as readonly string[]).includes(op))
    throw new UsageError(`Unknown rooms action ${JSON.stringify(op)}; expected one of ${ROOM_OPS.join(", ")}`, CHANNELS_USAGE);
  const roomOp = op as (typeof ROOM_OPS)[number];
  if (roomOp === "list" ? conversationId !== undefined : conversationId === undefined || extra.length > 0)
    throw new UsageError(
      roomOp === "list" ? "channels rooms list takes no room" : `channels rooms ${roomOp} takes one room id`,
      CHANNELS_USAGE,
    );
  if (
    roomOp !== "add" &&
    roomOp !== "set" &&
    ["--label", "--trigger", "--members", "--auto-thread", "--context"].some((flag) => flags.has(flag))
  )
    throw new UsageError(`channels rooms ${roomOp} takes no room settings`, CHANNELS_USAGE);
  const triggerFlag = flags.get("--trigger");
  const trigger = triggerFlag === undefined ? undefined : csvList(triggerFlag);
  if (trigger !== undefined && (trigger.length === 0 || trigger.some((kind) => !(ADDRESS_KINDS as readonly string[]).includes(kind))))
    throw new UsageError(`--trigger takes ${ADDRESS_KINDS.join(", ")}, comma-separated`, CHANNELS_USAGE);
  const members = flags.get("--members");
  if (members !== undefined && members !== "bound" && members !== "operator-only")
    throw new UsageError("--members takes bound or operator-only", CHANNELS_USAGE);
  const autoThread = flags.get("--auto-thread");
  if (autoThread !== undefined && autoThread !== "on" && autoThread !== "off")
    throw new UsageError("--auto-thread takes on or off", CHANNELS_USAGE);
  const context = flags.get("--context");
  if (context !== undefined && context !== "recent" && context !== "off")
    throw new UsageError("--context takes recent or off", CHANNELS_USAGE);
  if (context !== undefined && roomOp !== "set")
    throw new UsageError(
      "--context is set on a room already added: `channels rooms <connection> set <id> --context recent`",
      CHANNELS_USAGE,
    );
  const format = formatFlag(flags);
  const label = flags.get("--label");
  return {
    action: "rooms",
    target: connectionId,
    roomOp,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(label === undefined ? {} : { label }),
    ...(trigger === undefined ? {} : { trigger: trigger as AddressKind[] }),
    ...(members === undefined ? {} : { members }),
    ...(autoThread === undefined ? {} : { autoThread: autoThread === "on" }),
    ...(context === undefined ? {} : { context }),
    settings: {},
    secretFiles: {},
    workspaceId: flags.get("--workspace") ?? "default",
    format,
    ...dataDirectoryFlag(flags),
  };
}

/** `tavi channels grant <connection> room|contact <id> <tool> allow|deny [--expires <time>]`. */
function parsedGrant(positionals: readonly string[], flags: ReadonlyMap<string, string>): ChannelsCommandOptions {
  const [connectionId = "", scopeKind, scopeId = "", toolId = "", mode] = positionals;
  if (scopeKind !== "room" && scopeKind !== "contact")
    throw new UsageError(
      "channels grant names a room or a contact: `grant <connection> room|contact <id> <tool> allow|deny`",
      CHANNELS_USAGE,
    );
  if (mode !== "allow" && mode !== "deny") throw new UsageError("channels grant ends with allow or deny", CHANNELS_USAGE);
  const expires = flags.get("--expires");
  if (expires !== undefined && Number.isNaN(Date.parse(expires)))
    throw new UsageError("--expires takes a time, such as 2026-11-01T00:00:00Z", CHANNELS_USAGE);
  return {
    action: "grant",
    target: connectionId,
    grant: { scopeKind, scopeId, toolId, mode, ...(expires === undefined ? {} : { expiresAt: new Date(expires).toISOString() }) },
    settings: {},
    secretFiles: {},
    workspaceId: flags.get("--workspace") ?? "default",
    format: formatFlag(flags),
    ...dataDirectoryFlag(flags),
  };
}

/** `tavi channels grants <connection> [list | revoke <grant-id>]`. */
function parsedGrants(positionals: readonly string[], flags: ReadonlyMap<string, string>): ChannelsCommandOptions {
  const [connectionId, op = "list", grantId, ...extra] = positionals;
  if (connectionId === undefined) throw new UsageError("channels grants names the connection", CHANNELS_USAGE);
  if (op !== "list" && op !== "revoke")
    throw new UsageError(`Unknown grants action ${JSON.stringify(op)}; expected list or revoke`, CHANNELS_USAGE);
  if (op === "list" ? grantId !== undefined : grantId === undefined || extra.length > 0)
    throw new UsageError(
      op === "list" ? "channels grants list takes no grant" : "channels grants revoke takes one grant id",
      CHANNELS_USAGE,
    );
  return {
    action: "grants",
    target: connectionId,
    grantsOp: op,
    ...(grantId === undefined ? {} : { grantId }),
    settings: {},
    secretFiles: {},
    workspaceId: flags.get("--workspace") ?? "default",
    format: formatFlag(flags),
    ...dataDirectoryFlag(flags),
  };
}

function formatFlag(flags: ReadonlyMap<string, string>): "text" | "json" {
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, CHANNELS_USAGE);
  return format;
}
