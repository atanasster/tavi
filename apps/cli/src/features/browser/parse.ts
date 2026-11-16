import { BROWSER_LIVE_DEFAULT_WIDTH, BROWSER_LIVE_MAX_WIDTH, BROWSER_LIVE_MIN_WIDTH } from "@tavi/contracts";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, integerFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

/**
 * `tavi browser history`: the browser sessions
 * tasks opened, newest first, as the Command Center's Browser section lists
 * them; URLs are stored without query strings or fragments. `browser live`
 * watches a task's sessions, and `browser close` closes them.
 */
const BROWSER_HISTORY_MAX_LIMIT = 500;
export const BROWSER_USAGE = `tavi browser history [options]
tavi browser live <task-id> --out <dir> [options]
tavi browser close <session-id> | --inactive [options]
tavi browser clear-profile [options]
tavi browser recipes [--forget <host> | --forget-all] [--replay <host> | --stop-replay <host>] [options]
tavi browser site-notes [--propose <host> | --on <id> | --off <id>] [options]

history: the browser sessions tasks opened in the last 30 days, newest first:
the task, the last page (host and path only; query strings are never stored),
how many pages and for how long. Under a running \`tavi serve\` it is read
from there; with none, from the data directory.

live: a debug aid. Watches the browser sessions of a task (and its sub-agents'
tasks) on a live \`tavi serve\`, writing each frame the live view receives to
<dir> as a JPEG and printing what else happens (pages, hidden pages, ends).
Nothing is kept by tavi itself; these files are yours. It stops after
--frames frames, once every session it watched has ended, or on Ctrl-C.

history options:
  --live                     Only sessions open now
  --limit <n>                The most sessions to list (default 20, at most ${BROWSER_HISTORY_MAX_LIMIT})
  --workspace <id>           Workspace (default: default)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help

close: close a browser session the agent left open (its task ended, and it is
kept for the chat's next turn, holding a browser in memory), or with
--inactive every such session. Recorded as closed by the operator. The
session id is the one \`browser history --format json\` lists.

close options:
  --inactive                 Every session whose task has ended, instead of one
  --workspace <id>           Workspace (default: default)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})

clear-profile: forget the workspace's browser profile — the cookies, consent
choices and sign-ins the agent's browser keeps between sessions. On a live
\`tavi serve\` it closes the workspace's open browser sessions first.

clear-profile options:
  --workspace <id>           Workspace (default: default)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})

recipes: the browser steps that last led to results on each site, which the
agent is shown the next time it reaches the site. Never what was typed.

recipes options:
  --forget <host>            Forget one site's recipe first
  --forget-all               Forget every recipe first
  --replay <host>            Mark a site's recipe to replay: its next session runs
                             the steps first, each checked as browser.act is, and
                             stops at the first mismatch or commit
  --stop-replay <host>       Stop replaying a site's recipe
  --workspace <id>           Workspace (default: default)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})

site-notes: the operator's site notes, the .json files in the data
directory's site-notes/ (a tavi.sitenotes/1 note each: hosts, path globs,
notes, a search URL, an extract schema). The agent is shown an enabled note
the first time it reaches the site, as reference notes, not instructions.
Each is off until turned on, and off again once its file changes.

site-notes options:
  --propose <host>           Write a site's recipe as a proposed note (off) to review
  --on <id>                  Turn a note on, as its file reads now
  --off <id>                 Turn a note off
  --workspace <id>           The recipe's workspace, for --propose (default: default)
  --format <text|json>       Output format (default: text)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})

live options:
  --out <dir>                Where frames are written (created when missing; required)
  --session <id>             Only this session (its id from \`browser history\`)
  --width <px>               The widest frame wanted (default ${BROWSER_LIVE_DEFAULT_WIDTH}, at most ${BROWSER_LIVE_MAX_WIDTH})
  --frames <n>               Stop after this many frames
  --workspace <id>           Workspace (default: default)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
`;

export interface BrowserHistoryOptions {
  readonly action: "history";
  readonly dataDirectory?: string;
  readonly workspaceId: string;
  readonly live: boolean;
  readonly limit: number;
  readonly format: OutputFormat;
}

export interface BrowserLiveOptions {
  readonly action: "live";
  readonly dataDirectory?: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly out: string;
  readonly sessionId?: string;
  readonly maxWidth?: number;
  readonly frames?: number;
}

export interface BrowserCloseOptions {
  readonly action: "close";
  readonly dataDirectory?: string;
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly inactive: boolean;
}

export interface BrowserClearProfileOptions {
  readonly action: "clear-profile";
  readonly dataDirectory?: string;
  readonly workspaceId: string;
}

export interface BrowserRecipesOptions {
  readonly action: "recipes";
  readonly dataDirectory?: string;
  readonly workspaceId: string;
  readonly forget?: string | true;
  /** Mark one site's recipe to replay (`on`) or not. */
  readonly replay?: { readonly host: string; readonly on: boolean };
  readonly format: OutputFormat;
}

export interface BrowserSiteNotesOptions {
  readonly action: "site-notes";
  readonly dataDirectory?: string;
  readonly workspaceId: string;
  /** Propose a site's recipe as a note (`propose`), or turn a note on or off. */
  readonly propose?: string;
  readonly turn?: { readonly id: string; readonly on: boolean };
  readonly format: OutputFormat;
}

export type BrowserCommandOptions =
  | BrowserSiteNotesOptions
  | BrowserHistoryOptions
  | BrowserLiveOptions
  | BrowserCloseOptions
  | BrowserClearProfileOptions
  | BrowserRecipesOptions;

export function parseBrowser(argv: readonly string[]): ParsedCommand {
  const usage = BROWSER_USAGE;
  const [action, ...rest] = argv;
  if (action === "-h" || action === "--help") return { command: "help", usage };
  if (action === "live") return parseBrowserLive(rest);
  if (action === "close") return parseBrowserClose(rest);
  if (action === "clear-profile") return parseBrowserClearProfile(rest);
  if (action === "recipes") return parseBrowserRecipes(rest);
  if (action === "site-notes") return parseBrowserSiteNotes(rest);
  if (action !== "history") {
    throw new UsageError(
      action === undefined
        ? "browser needs an action; expected history, live, close, clear-profile, recipes or site-notes"
        : `Unknown browser action ${JSON.stringify(action)}; expected history, live, close, clear-profile, recipes or site-notes`,
      usage,
    );
  }
  const args = parseFlags(rest, {
    usage,
    valued: ["--limit", "--workspace", "--format", "--data-dir"],
    switches: ["--live"],
    unknown: (name) => `browser history does not accept ${name}`,
    positional: (token) => `browser history takes no arguments, received ${JSON.stringify(token)}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags } = args;
  const live = args.switches.has("--live");
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, usage);
  const limitFlag = flags.get("--limit") ?? "20";
  const limit = integerFlag(
    limitFlag,
    { min: 1, max: BROWSER_HISTORY_MAX_LIMIT },
    `--limit expects a whole number from 1 to ${BROWSER_HISTORY_MAX_LIMIT}, received ${JSON.stringify(limitFlag)}`,
    usage,
  );
  return {
    command: "browser",
    browser: { action: "history", workspaceId: flags.get("--workspace") ?? "default", live, limit, format, ...dataDirectoryFlag(flags) },
  };
}

/** `tavi browser close <session-id> | --inactive`. */
function parseBrowserClose(argv: readonly string[]): ParsedCommand {
  const usage = BROWSER_USAGE;
  const args = parseFlags(argv, {
    usage,
    valued: ["--workspace", "--data-dir"],
    switches: ["--inactive"],
    unknown: (name) => `browser close does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags, positionals: positional } = args;
  const inactive = args.switches.has("--inactive");
  if (positional.length > 1) throw new UsageError("browser close takes one session id", usage);
  const sessionId = positional[0];
  if ((sessionId === undefined) === !inactive)
    throw new UsageError("browser close needs a session id, or --inactive for every session whose task has ended", usage);
  return {
    command: "browser",
    browser: {
      action: "close",
      workspaceId: flags.get("--workspace") ?? "default",
      inactive,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...dataDirectoryFlag(flags),
    },
  };
}

/** `tavi browser recipes [--forget <host> | --forget-all] [--replay <host> | --stop-replay <host>]`. */
function parseBrowserRecipes(argv: readonly string[]): ParsedCommand {
  const usage = BROWSER_USAGE;
  const args = parseFlags(argv, {
    usage,
    valued: ["--forget", "--replay", "--stop-replay", "--workspace", "--format", "--data-dir"],
    switches: ["--forget-all"],
    unknown: (name) => `browser recipes does not accept ${name}`,
    positional: (token) => `browser recipes takes no arguments, received ${JSON.stringify(token)}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags } = args;
  const forgetAll = args.switches.has("--forget-all");
  const forgetHost = flags.get("--forget");
  if (forgetAll && forgetHost !== undefined) throw new UsageError("browser recipes takes --forget <host> or --forget-all, not both", usage);
  const replayHost = flags.get("--replay");
  const stopHost = flags.get("--stop-replay");
  if (replayHost !== undefined && stopHost !== undefined)
    throw new UsageError("browser recipes takes --replay <host> or --stop-replay <host>, not both", usage);
  if ((replayHost !== undefined || stopHost !== undefined) && (forgetAll || forgetHost !== undefined))
    throw new UsageError("browser recipes marks a recipe to replay or forgets recipes, not both at once", usage);
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, usage);
  return {
    command: "browser",
    browser: {
      action: "recipes",
      workspaceId: flags.get("--workspace") ?? "default",
      format,
      ...(forgetAll ? { forget: true as const } : forgetHost === undefined ? {} : { forget: forgetHost }),
      ...(replayHost !== undefined
        ? { replay: { host: replayHost, on: true } }
        : stopHost !== undefined
          ? { replay: { host: stopHost, on: false } }
          : {}),
      ...dataDirectoryFlag(flags),
    },
  };
}

/** `tavi browser site-notes [--propose <host> | --on <id> | --off <id>]`. */
function parseBrowserSiteNotes(argv: readonly string[]): ParsedCommand {
  const usage = BROWSER_USAGE;
  const args = parseFlags(argv, {
    usage,
    valued: ["--propose", "--on", "--off", "--workspace", "--format", "--data-dir"],
    unknown: (name) => `browser site-notes does not accept ${name}`,
    positional: (token) => `browser site-notes takes no arguments, received ${JSON.stringify(token)}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags } = args;
  const propose = flags.get("--propose");
  const on = flags.get("--on");
  const off = flags.get("--off");
  if ([propose, on, off].filter((value) => value !== undefined).length > 1)
    throw new UsageError("browser site-notes takes one of --propose, --on and --off", usage);
  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, usage);
  return {
    command: "browser",
    browser: {
      action: "site-notes",
      workspaceId: flags.get("--workspace") ?? "default",
      format,
      ...(propose === undefined ? {} : { propose }),
      ...(on !== undefined ? { turn: { id: on, on: true } } : off !== undefined ? { turn: { id: off, on: false } } : {}),
      ...dataDirectoryFlag(flags),
    },
  };
}

/** `tavi browser clear-profile`. */
function parseBrowserClearProfile(argv: readonly string[]): ParsedCommand {
  const usage = BROWSER_USAGE;
  const args = parseFlags(argv, {
    usage,
    valued: ["--workspace", "--data-dir"],
    unknown: (name) => `browser clear-profile does not accept ${name}`,
    positional: (token) => `browser clear-profile takes no arguments, received ${JSON.stringify(token)}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags } = args;
  return {
    command: "browser",
    browser: { action: "clear-profile", workspaceId: flags.get("--workspace") ?? "default", ...dataDirectoryFlag(flags) },
  };
}

/** `tavi browser live <task-id> --out <dir>`. */
function parseBrowserLive(argv: readonly string[]): ParsedCommand {
  const usage = BROWSER_USAGE;
  const args = parseFlags(argv, {
    usage,
    valued: ["--out", "--session", "--width", "--frames", "--workspace", "--data-dir"],
    unknown: (name) => `browser live does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage };
  const { flags, positionals: positional } = args;
  const [taskId, ...extra] = positional;
  if (taskId === undefined) throw new UsageError("browser live needs the task whose browser to watch", usage);
  if (extra.length > 0) throw new UsageError(`browser live takes one task id, received ${JSON.stringify(extra[0])} too`, usage);
  const out = flags.get("--out");
  if (out === undefined) throw new UsageError("browser live needs --out <dir>, where its frames are written", usage);
  const whole = (name: string, min: number, max: number): number | undefined => {
    const raw = flags.get(name);
    if (raw === undefined) return undefined;
    return integerFlag(raw, { min, max }, `${name} expects a whole number from ${min} to ${max}, received ${JSON.stringify(raw)}`, usage);
  };
  const maxWidth = whole("--width", BROWSER_LIVE_MIN_WIDTH, BROWSER_LIVE_MAX_WIDTH);
  const frames = whole("--frames", 1, 1_000_000);
  return {
    command: "browser",
    browser: {
      action: "live",
      taskId,
      out,
      workspaceId: flags.get("--workspace") ?? "default",
      ...(flags.get("--session") === undefined ? {} : { sessionId: flags.get("--session") as string }),
      ...(maxWidth === undefined ? {} : { maxWidth }),
      ...(frames === undefined ? {} : { frames }),
      ...dataDirectoryFlag(flags),
    },
  };
}
