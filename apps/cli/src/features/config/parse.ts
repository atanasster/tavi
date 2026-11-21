import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { ParsedCommand } from "../../cli/parse.js";
import { nearestOf } from "../../shared/nearest.js";

/**
 * `tavi config`: the per-workspace settings, one
 * dotted key at a time. The CLI's keys carry their document's name
 * (`workspace.timezone`) so later documents can add their own; `features/config/client.ts` maps
 * each to the IPC key.
 */
const CONFIG_CLI_ACTIONS = ["get", "set", "unset"] as const;
type ConfigCliAction = (typeof CONFIG_CLI_ACTIONS)[number];
const CONFIG_KEYS = [
  "workspace.timezone",
  "operator.name",
  "activity.summaries",
  "activity.summaryModel",
  "browser.noThumbnailHosts",
  "browser.sessionIdleMinutes",
  "browser.downloadMaxMiB",
  "browser.visionEngine",
  "desktop.grantedApps",
  "ui.roles",
  "ui.placements",
  "chat.home",
  "chat.home-dm",
  "models.keptRequests",
  "models.maxOutputTokens",
  "scheduled.monthlyTokenBudget",
  "models.promptLayout",
  "models.toolDeferral",
  "tasks.home",
  "travel.flightSearch",
  "travel.googleFlights",
  "skills.suggestions",
  "pdf.enabled",
  "video.enabled",
  "video.keepDays",
  "tools.redactResults",
  "tools.parallelReads",
  "memory",
  "security.taint",
  "security.injectionDetector",
  "mcp.servers",
  "mcp.people",
  "sandbox.domains",
  "sandbox.network",
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export const CONFIG_USAGE = `tavi config <action> [options]

Workspace settings. On a live owner the change applies to the next model call;
without one the data directory is changed directly.

Actions:
  get [key]                  Print one setting, or every setting
  set <key> <value>          Change a setting
  unset <key>                Clear a setting and use its default

Keys:
  workspace.timezone         The IANA time zone (for example Europe/Berlin) the
                             agent states the current local time in, and that
                             "today" and relative times resolve in. Default:
                             the owner host's zone
  operator.name              What you are called, as onboarding's about step
                             sets it (one line, up to 80 characters). Default:
                             unset
  activity.summaries         on or off: whether a finished task gets a generated
                             title and one-line summary (one small model call on
                             the fast role, else the task's own model). Default: on
  activity.summaryModel      <connection>/<model> that writes summaries instead
                             of the fast role, else the task's own model. Never used for a task that
                             ran on a local connection when it is remote.
                             Default: the fast role when bound, else the task's own model
  browser.noThumbnailHosts   Comma-separated hosts whose pages never get a
                             browser thumbnail in the Command Center, such as
                             "mail.example.com,*.bank" (*.domain matches the
                             domain and its subdomains); "none" for no host.
                             Replaces the default list. A page with a password,
                             payment or one-time-code field never gets one.
                             Default: common webmail and payment hosts, and *.bank
  browser.sessionIdleMinutes Minutes (0–1440) a browser session nobody is using
                             stays open before it closes (its sign-ins stay in
                             the profile); 0 keeps it until it is closed. Default: 30
  browser.downloadMaxMiB     The largest file a browser download keeps, in MiB
                             (1–4096); a larger one is cancelled. Default: 256
  browser.visionEngine       generic or native: what acts by sight — Tavi's own
                             loop, or the model's native computer-use tool where
                             its connection offers one (experimental). Default: generic
  desktop.grantedApps        Comma-separated bundle ids or app names desktop
                             control may see and act in, each at its built-in
                             tier (browsers view-only, terminals click-only,
                             system apps asked about each time), or none.
                             Needs the experimental tavi.desktop plugin.
                             Default: none
  ui.roles                   JSON: which plugin fills each UI role, such as
                             {"browser-view":"acme.browserview"}; "off" as a
                             role's value turns the role off. Default: the
                             built-in (tavi.browserview)
  ui.placements              JSON: per <plugin-id>/<contribution-id>, the slots
                             it is shown in instead of its manifest's, or
                             "hidden". Default: each manifest's own
  chat.home                  on or off: whether the workspace has a Home chat,
                             one persistent chat that / and a bare tavi chat
                             open. Off, chats work as before. Default: on
  chat.home-dm               <connection>:<sender id>[,...], or off: your own
                             chat-channel DM identities (for example
                             my-chat:123456789) whose private chats
                             with the bot are turns of your Home, answered in
                             the DM, instead of a conversation of their own.
                             Each must still be bound to you, the workspace's
                             operator, when a message arrives. Home's whole
                             context can then shape what is sent to the DM, and
                             the DM is shown in Home. Groups, forum topics,
                             email and unlisted identities are never linked;
                             /new in a linked DM ends nothing. Needs chat.home
                             on. Default: off
  models.keptRequests        0-1000: how many of a task's newest model calls
                             keep their whole request in model accounting;
                             older calls keep usage, cost and the request's
                             hash. 0 keeps none once a call ends. Default: 10
  models.maxOutputTokens     256-1000000: the most one model call may write
                             (its max_tokens). A heartbeat's or an idea's own
                             cap is used instead. Default: 16384
  scheduled.monthlyTokenBudget
                             Tokens (1000 or more) the workspace's schedules
                             and routines, with their workers, are meant to
                             use in a calendar month in workspace.timezone:
                             you are told once a month when they reach 80%.
                             Nothing is stopped; tavi doctor and the Schedule
                             page show the month's total. Default: none
  models.promptLayout        v1 or v2: how a model call's prompt is laid out
                             for prompt caching. v2 is the cache-stable layout
                             the prompt-cache changes are gated on; setting v1
                             again rolls them back. Default: v2
  models.toolDeferral        auto, on or off: whether a chat's rarely used
                             built-ins (routines, PDF, plugins, …) wait behind
                             tools.search under v2. auto defers them unless
                             the chat runs on a local model. Default: auto
  tasks.home                 tavi, or mcp:<server>: where you keep your tasks.
                             tavi is Tavi's own to-do list; mcp:<server> a task
                             app connected as an MCP server (tavi mcp add
                             todoist --preset todoist), which then takes your
                             to-dos, Tavi's list keeping only its own
                             follow-ups. No sync: tavi todos export, or ask
                             in a chat to move them. Default: tavi
  travel.flightSearch        on or off: travel.flights_search asks Kiwi.com's
                             public flight search. Off, it refuses and the
                             agent browses flight sites. Default: on
  travel.googleFlights       on or off: flight answers link Google Flights (an
                             unofficial, best-effort back end) to confirm a
                             fare or when the search fails. Default: on
  skills.suggestions         on or off: the agent may offer a procedure that
                             worked as a skill for you to review. Off, it
                             offers one only when asked. Default: on
  pdf.enabled                on or off: the PDF tools (read, fields, render,
                             fill). Off, they refuse. Default: on
  video.enabled              on or off: the video tools (facts and frames of
                             a video, with the person's own FFmpeg) and voice
                             message transcription. Off, they refuse.
                             Default: on
  video.keepDays             How many days a video or voice message taken
                             from a channel or an upload is kept (1-3650); a
                             video's frames stay with its chat. Default: 30
  tools.redactResults        on or off: credential shapes (AWS keys, tokens,
                             private keys, JWTs) in tool results are masked as
                             [redacted:<kind>] before the model, the archive or
                             a client sees them, and a write that would put a
                             placeholder back is refused. Default: on
  tools.parallelReads        How many independent read-only calls of one step
                             run at the same time (1-32); 1 runs each call in
                             turn. Results keep call order. Default: 8
  memory                     JSON: the whole memory section, such as
                             {"enabled":false}; tavi memory config changes one
                             key of it at a time. Default: memory on, the model
                             may suggest memory, sensitive topics skipped,
                             default limits
  security.taint             off, observe or enforce: once untrusted content
                             (a web page, an email, a search result) is in the
                             chat, enforce asks before a call that could send
                             data out, use a credential or save something;
                             observe decides as before and records each call it
                             would have asked (tavi doctor counts them); off
                             does neither and is deprecated.
                             A page may only raise it. serve --taint-policy
                             overrides it. Default: enforce
  security.injectionDetector off, patterns or model: a detector reads untrusted
                             content and flags a call made after a likely
                             injection — a reason, high risk and a warning line
                             on its approval. It never allows, refuses or
                             lowers anything. patterns is local text matching;
                             model also asks the fast role, else the chat's
                             own model (a local chat's own model for a chat on
                             a local connection), about what the patterns
                             pass. Default: patterns

Options:
  --expected-revision <n>    Assert the revision this write is based on instead
                             of reading it first; a mismatch is a conflict
  --workspace <id>           Workspace to act in (default: default)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export interface ConfigCommandOptions {
  readonly action: ConfigCliAction;
  /** Absent only for `get`, which then prints every key. */
  readonly key?: ConfigKey;
  /** `set`'s value, validated by the owner so the refusal can name it. */
  readonly value?: string;
  readonly expectedRevision?: number;
  readonly workspaceId?: string;
  readonly format: "text" | "json";
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
}

export function parseConfig(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  if (action === "-h" || action === "--help") return { command: "help", usage: CONFIG_USAGE };
  if (action === undefined) {
    throw new UsageError(`config needs an action; expected one of ${CONFIG_CLI_ACTIONS.join(", ")}`, CONFIG_USAGE);
  }
  if (!(CONFIG_CLI_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown config action ${JSON.stringify(action)}; expected one of ${CONFIG_CLI_ACTIONS.join(", ")}`, CONFIG_USAGE);
  }
  const resolved = action as ConfigCliAction;
  const args = parseFlags(rest, {
    usage: CONFIG_USAGE,
    valued:
      resolved === "get" ? ["--data-dir", "--format", "--workspace"] : ["--expected-revision", "--data-dir", "--format", "--workspace"],
    unknown: (name) => `config ${resolved} does not accept ${name}`,
    repeated: (name) => `config ${resolved} received ${name} twice`,
    repeatedFirst: true,
  });
  if (args === "help") return { command: "help", usage: CONFIG_USAGE };
  const { flags, positionals } = args;
  const arity = { get: [0, 1], set: [2, 2], unset: [1, 1] } as const;
  const [least, most] = arity[resolved];
  if (positionals.length < least || positionals.length > most) {
    const shape = { get: "get [key]", set: "set <key> <value>", unset: "unset <key>" }[resolved];
    throw new UsageError(`config ${resolved} takes ${shape}`, CONFIG_USAGE);
  }
  const [rawKey, value] = positionals;
  if (rawKey !== undefined && !(CONFIG_KEYS as readonly string[]).includes(rawKey)) {
    // One line, so a typo is not scrolled away by the help: the nearest key, and where the rest are.
    const near = nearestOf(rawKey, CONFIG_KEYS);
    throw new UsageError(
      `Unknown config key ${JSON.stringify(rawKey)}; ` +
        (near === undefined
          ? "`tavi config get` lists every key, and `tavi config --help` describes each"
          : `did you mean ${near}? \`tavi config get\` lists every key`),
      "",
    );
  }
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, CONFIG_USAGE);
  }
  const revisionFlag = flags.get("--expected-revision");
  let expectedRevision: number | undefined;
  if (revisionFlag !== undefined) {
    if (!/^\d+$/.test(revisionFlag)) {
      throw new UsageError(`--expected-revision must be a nonnegative integer, received ${JSON.stringify(revisionFlag)}`, CONFIG_USAGE);
    }
    expectedRevision = Number(revisionFlag);
  }
  const workspaceId = flags.get("--workspace");
  return {
    command: "config",
    config: {
      action: resolved,
      ...(rawKey === undefined ? {} : { key: rawKey as ConfigKey }),
      ...definedOnly({
        value,
        expectedRevision,
        workspaceId,
      }),
      format,
      ...dataDirectoryFlag(flags),
    },
  };
}
