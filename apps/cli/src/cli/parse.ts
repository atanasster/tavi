import { parseChannels, type ChannelsCommandOptions } from "../features/channels/parse.js";
import { parseApps, type AppsCommandOptions } from "../features/apps/parse.js";
import { parseMcp, type McpCommandOptions } from "../features/mcp/parse.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "./argv.js";
import { type AgentsCommandOptions, parseAgents } from "../features/agents/parse.js";
import { NEEDS_USAGE, type ApprovalsCommandOptions, parseAnswer, parseApprovals } from "../features/approvals/parse.js";
import { type ArtifactsCommandOptions, parseArtifacts } from "../features/artifacts/parse.js";
import { type BindingsCommandOptions, parseBindings } from "../features/bindings/parse.js";
import { type BrowserCommandOptions, parseBrowser } from "../features/browser/parse.js";
import { type ConfigCommandOptions, parseConfig } from "../features/config/parse.js";
import { type CredentialsCommandOptions, parseCredentials } from "../features/credentials/parse.js";
import { parseTaskFolder, parseTaskFoldersPrune, type TaskFolderOptions, type TaskFoldersPruneOptions } from "../features/folders/parse.js";
import { type HeartbeatCommandOptions, parseHeartbeat } from "../features/heartbeat/parse.js";
import { type IdeasCommandOptions, parseIdeas } from "../features/ideas/parse.js";
import { type InboxCommandOptions, parseInbox } from "../features/inbox/parse.js";
import {
  type LogsCommandOptions,
  type MaintenanceCommandOptions,
  parseLogs,
  parseMaintenance,
  parsePrune,
  parseReset,
  type PruneCommandOptions,
  type ResetCommandOptions,
} from "../features/maintenance/parse.js";
import { type MemoryCommandOptions, parseMemory } from "../features/memory/parse.js";
import { type ModelsCommandOptions, parseModels } from "../features/models/parse.js";
import { type OnboardCommandOptions, parseOnboard, parseSetup } from "../features/onboard/parse.js";
import { parsePermissions, type PermissionsCommandOptions } from "../features/permissions/parse.js";
import { parsePlugins, type PluginsCommandOptions, type PluginsUiOptions } from "../features/plugins/parse.js";
import { parseProjects, type ProjectsCommandOptions } from "../features/projects/parse.js";
import { parseReminders, type RemindersCommandOptions } from "../features/reminders/parse.js";
import { parseTodos, type TodosCommandOptions } from "../features/todos/parse.js";
import { parseReports, type ReportsCommandOptions } from "../features/reports/parse.js";
import { parseRouter, type RouterCommandOptions } from "../features/router/parse.js";
import { type AbortCommandOptions, parseAbort, RUN_FOLDER_USAGE, RUN_USAGE, type RunCommandOptions } from "../features/run/parse.js";
import { parseSandbox, type SandboxCommandOptions } from "../features/sandbox/parse.js";
import { parseSchedules, type SchedulesCommandOptions } from "../features/schedules/parse.js";
import { parseSearch, type SearchCommandOptions } from "../features/search/parse.js";
import { parseService, type ServiceCommandOptions } from "../features/service/parse.js";
import { parseSkills, type SkillsCommandOptions } from "../features/skills/parse.js";
import { parseSystemPrompt, type SystemPromptCommandOptions } from "../features/system-prompt/parse.js";
import {
  type CancelCommandOptions,
  parseCancel,
  parseDataDirOnly,
  parseRecover,
  parseTaskHistory,
  parseTaskInstructions,
  type RecoverCommandOptions,
  type TaskHistoryOptions,
  type TaskInstructionsOptions,
} from "../features/tasks/parse.js";
import { parseUi, type UiCommandParsed } from "../features/ui/parse.js";
import { parseServe, type ServeCommandOptions } from "../server/parse.js";
import { type ChatCommandOptions, parseChat } from "../tui/parse.js";
import { formatCommandIndex } from "./help.js";
import { operationKeyFlag, requireBindingShape } from "./parse-flags.js";

export { UsageError } from "./argv.js";
import type { OutputFormat } from "./output.js";
export type { OutputFormat };

export interface ParsedCommand {
  /** `--format`, when it was given: the answer's form, for every command (`emitJson` prints JSON as text under `text`). */
  readonly format?: OutputFormat;
  /** Resolved `--data-dir` for commands that accept it without other options. */
  readonly dataDirectory?: string;
  /**
   * A subcommand's own usage text, when it has one.
   *
   * `tavi schedules --help` printing the general help would leave the flags an
   * operator needs — `--at`, `--timezone`, `--allow` — documented only in error
   * messages. Every subcommand that takes an action sets its own page (for
   * `-h`, for `--help`, and for a missing action, which is a usage error); only
   * the command-less root invocation leaves this absent and gets the general
   * help.
   */
  readonly usage?: string;
  /** `tavi tasks <task-id>`'s positional argument, narrowing to one task. */
  readonly taskId?: string;
  /** `tavi tasks instructions <task-id> …`: a chat's own instructions. */
  readonly taskInstructions?: TaskInstructionsOptions;
  /** `tavi tasks history <task-id> export|forget`: a chat's saved history. */
  readonly taskHistory?: TaskHistoryOptions;
  /** `tavi tasks folder <task-id> …`: a chat's working folder. */
  readonly taskFolder?: TaskFolderOptions;
  /** `tavi tasks folders prune …`: reclaim chats' folders. */
  readonly taskFoldersPrune?: TaskFoldersPruneOptions;
  /** `tavi doctor --deep`: SQLite's full integrity check rather than the quick one. */
  readonly deep?: boolean;
  readonly command:
    | "run"
    | "serve"
    | "doctor"
    | "tasks"
    | "router"
    | "models"
    | "memory"
    | "skills"
    | "bindings"
    | "channels"
    | "artifacts"
    | "credentials"
    | "reports"
    | "schedules"
    | "reminders"
    | "todos"
    | "ideas"
    | "onboard"
    | "setup"
    | "heartbeat"
    | "browser"
    | "agents"
    | "projects"
    | "search"
    | "plugins"
    | "mcp"
    | "apps"
    | "permissions"
    | "system-prompt"
    | "config"
    | "service"
    | "sandbox"
    | "approvals"
    | "help"
    | "version"
    | "recover"
    | "cancel"
    | "abort"
    | "chat"
    | "ui"
    | "backup"
    | "export"
    | "restore"
    | "reset"
    | "logs"
    | "prune"
    | "inbox";
  readonly serve?: ServeCommandOptions;
  readonly options?: RunCommandOptions;
  readonly recover?: RecoverCommandOptions;
  readonly cancel?: CancelCommandOptions;
  readonly abort?: AbortCommandOptions;
  readonly chat?: ChatCommandOptions;
  readonly ui?: UiCommandParsed;
  readonly router?: RouterCommandOptions;
  readonly models?: ModelsCommandOptions;
  readonly memory?: MemoryCommandOptions;
  readonly skills?: SkillsCommandOptions;
  readonly bindings?: BindingsCommandOptions;
  readonly channels?: ChannelsCommandOptions;
  readonly artifacts?: ArtifactsCommandOptions;
  readonly approvals?: ApprovalsCommandOptions;
  readonly credentials?: CredentialsCommandOptions;
  readonly reports?: ReportsCommandOptions;
  readonly schedules?: SchedulesCommandOptions;
  readonly reminders?: RemindersCommandOptions;
  readonly todos?: TodosCommandOptions;
  readonly ideas?: IdeasCommandOptions;
  /** `tavi onboard` and `tavi setup`. */
  readonly onboard?: OnboardCommandOptions;
  readonly heartbeat?: HeartbeatCommandOptions;
  readonly browser?: BrowserCommandOptions;
  readonly agents?: AgentsCommandOptions;
  readonly search?: SearchCommandOptions;
  readonly plugins?: PluginsCommandOptions;
  readonly pluginsUi?: PluginsUiOptions;
  /** `tavi mcp …`. */
  readonly mcp?: McpCommandOptions;
  /** `tavi apps …`. */
  readonly apps?: AppsCommandOptions;
  readonly permissions?: PermissionsCommandOptions;
  readonly systemPrompt?: SystemPromptCommandOptions;
  readonly config?: ConfigCommandOptions;
  readonly projects?: ProjectsCommandOptions;
  readonly service?: ServiceCommandOptions;
  readonly sandbox?: SandboxCommandOptions;
  /** `tavi backup`/`export`/`restore` — see `MaintenanceCommandOptions`. */
  readonly maintenance?: MaintenanceCommandOptions;
  /** `tavi reset` — see `ResetCommandOptions`. */
  readonly reset?: ResetCommandOptions;
  /** `tavi logs` — see `LogsCommandOptions`. */
  readonly logs?: LogsCommandOptions;
  /** `tavi prune` — see `PruneCommandOptions`. */
  readonly prune?: PruneCommandOptions;
  /** `tavi inbox` — see `InboxCommandOptions`. */
  readonly inbox?: InboxCommandOptions;
}

/** Commands that are only interactive: they have no JSON form, and `--format json` is refused saying so. */
const NO_JSON_COMMANDS: ReadonlySet<string> = new Set(["chat", "ui", "serve"]);

/** `--format <value>` / `--format=<value>` in `argv`: its value, whether it was given more than once, and `argv` without it. */
function takeFormat(argv: readonly string[]): { readonly value?: string; readonly repeated: boolean; readonly rest: readonly string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  let count = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--format") {
      value = argv[index + 1];
      count += 1;
      index += 1;
    } else if (token.startsWith("--format=")) {
      value = token.slice("--format=".length);
      count += 1;
    } else rest.push(token);
  }
  return value === undefined ? { repeated: count > 1, rest } : { value, repeated: count > 1, rest };
}

/**
 * Minimal, dependency-free argument parsing with explicit validation.
 *
 * `--format text|json` is global (CLI.md): a command that reads it itself gets
 * it, and one that does not is parsed without it and handed the format — its
 * JSON answer is then printed as text under `--format text` (`emitJson`). An
 * interactive command says it has no JSON form; a repeated flag or another
 * value is refused here, the same for every command.
 */
export function parseArgs(argv: readonly string[]): ParsedCommand {
  const [command, ...rest] = argv;
  const given = takeFormat(rest);
  if (command === undefined || given.value === undefined) return parseCommand(command, rest);
  const format = given.value;
  if (given.repeated) throw new UsageError("--format may be given only once", formatCommandIndex());
  if (format !== "text" && format !== "json")
    throw new UsageError(`--format takes text or json, not ${JSON.stringify(format)}`, formatCommandIndex());
  // Said here, not by the family: a family that refuses it would be parsed again without --format, and the contradiction lost.
  if (format === "text" && given.rest.includes("--json"))
    throw new UsageError("--json and --format text disagree: pass one", formatCommandIndex());
  if (format === "json" && NO_JSON_COMMANDS.has(command)) {
    throw new UsageError(`tavi ${command} is interactive and has no JSON form: drop --format json`, formatCommandIndex());
  }
  let parsed: ParsedCommand;
  try {
    parsed = parseCommand(command, rest);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    // A family that does not read --format itself (each refuses an unknown flag its own way): parsed without
    // it, and handed it below. Refused without it too, the refusal was not the flag's: it is said as it was.
    try {
      parsed = parseCommand(command, given.rest);
    } catch {
      throw error;
    }
  }
  return withFormat(parsed, format);
}

/** `parsed` with `format` on it and on its command's options, as a family that reads --format sets it. */
function withFormat(parsed: ParsedCommand, format: OutputFormat): ParsedCommand {
  const entries = Object.entries(parsed).map(([key, value]) =>
    key !== "command" && value !== null && typeof value === "object" && !Array.isArray(value) ? [key, { ...value, format }] : [key, value],
  );
  return { ...(Object.fromEntries(entries) as unknown as ParsedCommand), format };
}

function parseCommand(command: string | undefined, rest: readonly string[]): ParsedCommand {
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    return { command: "help" };
  }
  if (command === "--version" || command === "version") return { command: "version" };
  if (command === "tasks" && rest[0] === "instructions") return parseTaskInstructions(rest.slice(1));
  if (command === "tasks" && rest[0] === "history") return parseTaskHistory(rest.slice(1));
  if (command === "tasks" && rest[0] === "folder") return parseTaskFolder(rest.slice(1));
  if (command === "tasks" && rest[0] === "folders") return parseTaskFoldersPrune(rest.slice(1));
  if (command === "tasks" || command === "doctor") return parseDataDirOnly(command, rest);
  if (command === "router") return parseRouter(rest);
  if (command === "models") return parseModels(rest);
  if (command === "memory") return parseMemory(rest);
  if (command === "skills") return parseSkills(rest);
  if (command === "bindings") return parseBindings(rest);
  if (command === "channels") return parseChannels(rest);
  if (command === "credentials") return parseCredentials(rest);
  if (command === "reports") return parseReports(rest);
  if (command === "schedules") return parseSchedules(rest);
  if (command === "reminders") return parseReminders(rest);
  if (command === "todos") return parseTodos(rest);
  if (command === "ideas") return parseIdeas(rest);
  if (command === "onboard") return parseOnboard(rest);
  if (command === "setup") return parseSetup(rest);
  if (command === "heartbeat") return parseHeartbeat(rest);
  if (command === "browser") return parseBrowser(rest);
  if (command === "agents") return parseAgents(rest);
  if (command === "search") return parseSearch(rest);
  if (command === "plugins") return parsePlugins(rest);
  if (command === "mcp") return parseMcp(rest);
  if (command === "apps") return parseApps(rest);
  if (command === "permissions") return parsePermissions(rest);
  if (command === "system-prompt") return parseSystemPrompt(rest);
  if (command === "config") return parseConfig(rest);
  if (command === "approvals") return parseApprovals(rest);
  // What waits on you, and answering a question, without the `approvals` noun.
  if (command === "needs")
    return rest.includes("-h") || rest.includes("--help") ? { command: "help", usage: NEEDS_USAGE } : parseApprovals(["needs", ...rest]);
  if (command === "answer") return parseAnswer(rest);
  if (command === "projects") return parseProjects(rest);
  if (command === "service") return parseService(rest);
  if (command === "sandbox") return parseSandbox(rest);
  if (command === "artifacts") return parseArtifacts(rest);
  if (command === "recover") return parseRecover(rest);
  if (command === "cancel") return parseCancel(rest);
  if (command === "abort") return parseAbort(rest);
  if (command === "chat") return parseChat(rest);
  if (command === "ui") return parseUi(rest);
  if (command === "serve") return parseServe(rest);
  if (command === "backup" || command === "export" || command === "restore") return parseMaintenance(command, rest);
  if (command === "reset") return parseReset(rest);
  if (command === "logs") return parseLogs(rest);
  if (command === "prune") return parsePrune(rest);
  if (command === "inbox") return parseInbox(rest);
  if (command !== "run") {
    // A flag before the subcommand (`tavi --data-dir X models add`) is a common
    // slip, and answering it with the *run* usage page sent the operator to the
    // wrong help: `run`'s page is the only one whose options could be mistaken
    // for global. The command *index* is what the mistake needs —
    // not `formatHelp()`, whose ~30 KB of concatenated family pages is right for
    // `tavi help` and wrong under an error message.
    if (command.startsWith("-")) {
      throw new UsageError(
        `Unknown option ${JSON.stringify(command)} before a command; options follow the command (tavi models add --data-dir X)`,
        formatCommandIndex(),
      );
    }
    throw new UsageError(`Unknown command ${JSON.stringify(command)}`, formatCommandIndex());
  }

  const runLists = [
    "--http-allow-host",
    "--http-request-header",
    "--browser-allow-host",
    "--messaging-allow-destination",
    "--http-credential-host",
  ];
  const args = parseFlags(rest, {
    usage: RUN_USAGE,
    valued: [
      "--api-key-file",
      "--approval",
      "--attach",
      "--connection",
      "--data-dir",
      "--folder",
      "--format",
      "--model",
      "--operation-key",
      "--principal",
      "--workspace",
      ...runLists,
    ],
    switches: ["--in-memory", "--home", "--managed", "--quiet"],
    lists: runLists,
    unknown: (name) => `run does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage: RUN_USAGE };
  const { flags, positionals } = args;
  const httpAllowHosts = args.lists.get("--http-allow-host") ?? [];
  const httpRequestHeaders = args.lists.get("--http-request-header") ?? [];
  const browserAllowHosts = args.lists.get("--browser-allow-host") ?? [];
  const messagingAllowDestinations = args.lists.get("--messaging-allow-destination") ?? [];
  const httpCredentialHosts = (args.lists.get("--http-credential-host") ?? []).map((value) => requireBindingShape(value, RUN_USAGE));
  const inMemory = args.switches.has("--in-memory");
  const quiet = args.switches.has("--quiet");
  const home = args.switches.has("--home");
  const managed = args.switches.has("--managed");

  const prompt = positionals.join(" ").trim();
  const attach = flags.get("--attach");
  if (attach !== undefined && prompt !== "") {
    throw new UsageError("run --attach follows an existing task and takes no prompt", RUN_USAGE);
  }
  if (attach === undefined && prompt === "") {
    throw new UsageError("run requires a prompt", RUN_USAGE);
  }
  if (home && (attach !== undefined || inMemory)) {
    throw new UsageError("run --home posts a prompt into Home on a live owner; it takes neither --attach nor --in-memory", RUN_USAGE);
  }

  // Where a new chat works: a run of its own only — Home keeps its folder, and --attach starts nothing.
  const folder = flags.get("--folder");
  // An empty value (an unset shell variable) would resolve to the current directory, which nobody named.
  if (folder?.trim() === "") throw new UsageError("--folder needs a folder: it was given an empty value", RUN_FOLDER_USAGE);
  if (folder !== undefined && managed) throw new UsageError("run takes --folder or --managed, not both", RUN_FOLDER_USAGE);
  if ((folder !== undefined || managed) && (home || attach !== undefined)) {
    throw new UsageError(
      "--folder and --managed choose a new chat's folder; Home keeps its own (/folder in tavi chat), and --attach starts nothing",
      RUN_FOLDER_USAGE,
    );
  }
  if (folder !== undefined && inMemory)
    throw new UsageError(
      "run --folder needs a live owner, whose --fs-root folders it is checked against; it takes no --in-memory",
      RUN_FOLDER_USAGE,
    );

  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, RUN_USAGE);
  }

  const approval = flags.get("--approval") ?? "ask";
  if (approval !== "ask" && approval !== "approve" && approval !== "deny") {
    throw new UsageError('--approval must be "ask", "approve" or "deny"', RUN_USAGE);
  }

  // `--attach` starts nothing: what a run is started with is already the
  // owner's, so a flag that would shape it is refused rather than ignored. An
  // approval policy is the starting run's too — an attached client asks the
  // rounds the owner leaves to it, and nothing else.
  if (attach !== undefined) {
    const inapplicable = [
      ...(approval === "ask" ? [] : [`--approval ${approval}`]),
      ...["--operation-key", "--connection", "--model", "--api-key-file"].filter((name) => flags.has(name)),
      ...(inMemory ? ["--in-memory"] : []),
      ...(httpAllowHosts.length > 0 ? ["--http-allow-host"] : []),
      ...(httpRequestHeaders.length > 0 ? ["--http-request-header"] : []),
      ...(browserAllowHosts.length > 0 ? ["--browser-allow-host"] : []),
      ...(messagingAllowDestinations.length > 0 ? ["--messaging-allow-destination"] : []),
      ...(httpCredentialHosts.length > 0 ? ["--http-credential-host"] : []),
    ];
    if (inapplicable.length > 0) {
      throw new UsageError(
        `run --attach follows a task the owner already runs, so it takes none of: ${inapplicable.join(", ")}`,
        RUN_USAGE,
      );
    }
  }

  // Neither flag is individually required: `resolveModelTarget` (`cli/run-target.ts`)
  // fills whichever is missing from the configured workspace default, and
  // reports a usage error when there is no default to fall back to.
  const connectionId = flags.get("--connection");
  const model = flags.get("--model");

  const apiKeyFile = flags.get("--api-key-file");
  const operationKey = operationKeyFlag(flags, RUN_USAGE);

  return {
    command: "run",
    options: {
      prompt,
      ...(attach === undefined ? {} : { attach }),
      ...(home ? { home } : {}),
      ...(folder === undefined ? {} : { folder }),
      ...(managed ? { managed } : {}),
      format,
      ...(apiKeyFile === undefined ? {} : { apiKeyFile }),
      ...(operationKey === undefined ? {} : { operationKey }),
      workspaceId: flags.get("--workspace") ?? "default",
      principalId: flags.get("--principal") ?? "operator",
      ...(connectionId === undefined ? {} : { connectionId }),
      ...(model === undefined ? {} : { model }),
      ...dataDirectoryFlag(flags),
      approval,
      quiet,
      inMemory,
      ...(httpAllowHosts.length === 0 ? {} : { httpAllowHosts }),
      ...(httpRequestHeaders.length === 0 ? {} : { httpRequestHeaders }),
      ...(browserAllowHosts.length === 0 ? {} : { browserAllowHosts }),
      ...(messagingAllowDestinations.length === 0 ? {} : { messagingAllowDestinations }),
      ...(httpCredentialHosts.length === 0 ? {} : { httpCredentialHosts }),
    },
  };
}
