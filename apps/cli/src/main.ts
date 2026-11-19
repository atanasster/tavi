import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { errorMessage } from "@tavi/contracts/util";

import { EXIT } from "./cli/exit.js";
import { BUILD_ID } from "./build-id.js";
import { UsageError, parseArgs, type ParsedCommand } from "./cli/parse.js";
import { formatHelp, formatVersion } from "./cli/help.js";
import { fittedText, pageWidth } from "./shared/terminal-text.js";
import { resolveDataDirectory } from "./shared/data-directory.js";
import { MIN_NODE_VERSION, nodeVersionReport } from "./shared/node-version.js";
import { checkoutRevision } from "./cli/checkout-revision.js";
import { type CliIo, DEFAULT_IO } from "./cli/io.js";
import { markTextOutput } from "./cli/output.js";
import { usageErrorLine } from "./cli/usage-error.js";
import { defaultRuntimeFactory, type RuntimeFactory } from "./cli/runtime-options.js";
import { resolveCommand } from "./cli/store.js";
import type { OnboardIo } from "./features/onboard/client.js";
import { offerFirstRun } from "./features/onboard/first-run.js";
export type { CliIo } from "./cli/io.js";
export { type RuntimeFactory, runtimeOptionsForTarget, runtimeOptionsFor } from "./cli/runtime-options.js";
export { type ResolvedModelConnection, resolveModelTarget, type ResolvedRunTarget } from "./cli/run-target.js";
export type { OnboardIo } from "./features/onboard/client.js";
// The first-run check alone: the onboarding flow it offers is loaded only when the offer is made.
export { offerFirstRun };
export { EVAL_OWNER_OFF } from "./server/eval-owner.js";
export { ownerWorkspacePrincipal } from "./cli/owner.js";

export interface MainOptions {
  readonly io?: CliIo;
  readonly runtimeFactory?: RuntimeFactory;
  /**
   * What `tavi onboard` and `tavi setup` read besides argv: the input their
   * prompts take (scripted in tests), the environment detection reads, the
   * fetch its loopback probes use, and the wait before a retried verify.
   */
  readonly onboard?: OnboardIo;
  /** The Node.js version the start-up check reads: `process.versions.node` unless a test plays an older one. */
  readonly nodeVersion?: string;
}

/** The commands that start a runtime: each refuses a Node.js older than `engines.node` before it starts. */
const NODE_CHECKED_COMMANDS: ReadonlySet<ParsedCommand["command"]> = new Set(["serve", "run", "chat", "ui"]);

export { BUILD_ID };
export { EXIT };

/** Commands that print their text form at a terminal when no `--format` is given: a script piping them still gets JSON. */
const TEXT_AT_A_TERMINAL: ReadonlySet<string> = new Set(["tasks", "doctor"]);

export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  const io = options.io ?? DEFAULT_IO;
  const runtimeFactory = options.runtimeFactory ?? defaultRuntimeFactory;
  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
    // `--format text` holds for every command: a JSON-only answer is printed as text.
    // At a terminal, a command whose JSON is long and a person's to read prints text unless `--format json` asks.
    if (parsed.format === "text" || (parsed.format === undefined && io.isTty && TEXT_AT_A_TERMINAL.has(parsed.command))) markTextOutput(io);
  } catch (error) {
    if (error instanceof UsageError) {
      // One line: what was wrong, the nearest valid name, and the help page; `--help` prints the page.
      io.stderr(usageErrorLine(error, argv));
      return EXIT.usage;
    }
    throw error;
  }

  // Under the test runner (and the executables its tests spawn, which inherit
  // `VITEST`) the check runs only when a test names the version: the suite
  // runs on whatever Node the developer has.
  if (NODE_CHECKED_COMMANDS.has(parsed.command) && (options.nodeVersion !== undefined || process.env["VITEST"] === undefined)) {
    const node = nodeVersionReport(options.nodeVersion);
    if (!node.ok) {
      io.stderr(
        `tavi ${parsed.command} needs Node.js ${MIN_NODE_VERSION} or later; this is Node.js ${node.version}. Upgrade Node.js and run it again.\n`,
      );
      return EXIT.unavailable;
    }
  }

  // Each command's handler is loaded when it runs, never at start-up: `--version`,
  // `--help` and an attached command do not pay for the owner runtime, the
  // workflow, or a plugin that another command needs.
  switch (parsed.command) {
    case "help":
      // A page fits the terminal, as `/help` does; 80 in a pipe.
      io.stdout(fittedText(parsed.usage ?? formatHelp(), pageWidth(io.columns)));
      return EXIT.ok;
    case "version":
      io.stdout(`${formatVersion(BUILD_ID, checkoutRevision())}\n`);
      return EXIT.ok;
    case "doctor": {
      const { doctor } = await import("./features/doctor/client.js");
      return doctor(io, runtimeFactory, parsed.dataDirectory, { deep: parsed.deep === true });
    }
    case "tasks": {
      if (parsed.taskFolder !== undefined || parsed.taskFoldersPrune !== undefined) {
        const { taskFolderCli, taskFoldersPruneCli } = await import("./features/folders/client.js");
        if (parsed.taskFolder !== undefined)
          return taskFolderCli(io, resolveDataDirectory(parsed.dataDirectory), parsed.taskFolder, parsed.format);
        if (parsed.taskFoldersPrune !== undefined)
          return taskFoldersPruneCli(io, resolveDataDirectory(parsed.dataDirectory), parsed.taskFoldersPrune);
      }
      const { listTasks, taskHistoryCli, taskInstructionsCli } = await import("./features/tasks/client.js");
      if (parsed.taskInstructions !== undefined)
        return taskInstructionsCli(io, resolveDataDirectory(parsed.dataDirectory), parsed.taskInstructions);
      if (parsed.taskHistory !== undefined) return taskHistoryCli(io, resolveDataDirectory(parsed.dataDirectory), parsed.taskHistory);
      return listTasks(io, parsed.dataDirectory, parsed.taskId);
    }
    case "router": {
      const { routerCliCommand } = await import("./features/router/client.js");
      if (parsed.router === undefined) return EXIT.usage;
      return routerCliCommand(resolveCommand(parsed.router), io);
    }
    case "models": {
      const { modelsCommand } = await import("./features/models/client.js");
      if (parsed.models === undefined) {
        io.stderr("models requires an action\n");
        return EXIT.usage;
      }
      return modelsCommand(resolveCommand(parsed.models), io);
    }
    case "memory": {
      const { memoryCommand } = await import("./features/memory/client.js");
      if (parsed.memory === undefined) {
        io.stderr("memory requires an action\n");
        return EXIT.usage;
      }
      return memoryCommand(resolveCommand(parsed.memory), io);
    }
    case "skills": {
      const { skillsCommand } = await import("./features/skills/client.js");
      if (parsed.skills === undefined) {
        io.stderr("skills requires an action\n");
        return EXIT.usage;
      }
      return skillsCommand(resolveCommand(parsed.skills), io);
    }
    case "bindings": {
      const { bindingsCommand } = await import("./features/bindings/client.js");
      if (parsed.bindings === undefined) {
        io.stderr("bindings requires an action\n");
        return EXIT.usage;
      }
      return bindingsCommand(resolveCommand(parsed.bindings), io);
    }
    case "channels": {
      const { channelsCliCommand } = await import("./features/channels/client.js");
      if (parsed.channels === undefined) {
        io.stderr("channels requires an action\n");
        return EXIT.usage;
      }
      return channelsCliCommand(resolveCommand(parsed.channels), io);
    }
    case "artifacts": {
      const { artifactsCommand } = await import("./features/artifacts/client.js");
      if (parsed.artifacts === undefined) {
        io.stderr("artifacts requires an action\n");
        return EXIT.usage;
      }
      return artifactsCommand(resolveCommand(parsed.artifacts), io, runtimeFactory);
    }
    case "approvals": {
      const { approvalsCommand } = await import("./features/approvals/client.js");
      if (parsed.approvals === undefined) {
        io.stderr("approvals requires an action\n");
        return EXIT.usage;
      }
      return approvalsCommand(resolveCommand(parsed.approvals), io, runtimeFactory);
    }
    case "reports": {
      const { reportsCommand } = await import("./features/reports/client.js");
      if (parsed.reports === undefined) {
        io.stderr("reports requires an action\n");
        return EXIT.usage;
      }
      return reportsCommand(resolveCommand(parsed.reports), io);
    }
    case "credentials": {
      const { credentialsCommand } = await import("./features/credentials/client.js");
      if (parsed.credentials === undefined) {
        io.stderr("credentials requires an action\n");
        return EXIT.usage;
      }
      return credentialsCommand(resolveCommand(parsed.credentials), io);
    }
    case "schedules": {
      const { schedulesCommand } = await import("./features/schedules/client.js");
      if (parsed.schedules === undefined) {
        io.stderr("schedules requires an action\n");
        return EXIT.usage;
      }
      return schedulesCommand(resolveCommand(parsed.schedules), io);
    }
    case "heartbeat": {
      const { heartbeatCliCommand } = await import("./features/heartbeat/client.js");
      if (parsed.heartbeat === undefined) {
        io.stderr("heartbeat requires an action\n");
        return EXIT.usage;
      }
      return heartbeatCliCommand(resolveCommand(parsed.heartbeat), io);
    }
    case "reminders": {
      const { remindersCliCommand } = await import("./features/reminders/client.js");
      if (parsed.reminders === undefined) {
        io.stderr("reminders requires an action\n");
        return EXIT.usage;
      }
      return remindersCliCommand(resolveCommand(parsed.reminders), io);
    }
    case "todos": {
      const { todosCliCommand } = await import("./features/todos/client.js");
      if (parsed.todos === undefined) {
        io.stderr("todos requires an action\n");
        return EXIT.usage;
      }
      return todosCliCommand(resolveCommand(parsed.todos), io);
    }
    case "onboard":
    case "setup": {
      const { onboardCliCommand } = await import("./features/onboard/client.js");
      if (parsed.onboard === undefined) {
        io.stderr(`${parsed.command} needs its options\n`);
        return EXIT.usage;
      }
      return onboardCliCommand(resolveCommand(parsed.onboard), io, options.onboard ?? {});
    }
    case "ideas": {
      const { ideasCliCommand } = await import("./features/ideas/client.js");
      if (parsed.ideas === undefined) {
        io.stderr("ideas requires an action\n");
        return EXIT.usage;
      }
      return ideasCliCommand(resolveCommand(parsed.ideas), io);
    }
    case "browser": {
      const {
        browserClearProfileCommand,
        browserCliCommand,
        browserCloseCommand,
        browserLiveCommand,
        browserRecipesCommand,
        browserSiteNotesCommand,
      } = await import("./features/browser/client.js");
      if (parsed.browser === undefined) {
        io.stderr("browser requires an action\n");
        return EXIT.usage;
      }
      return parsed.browser.action === "live"
        ? browserLiveCommand(resolveCommand(parsed.browser), io)
        : parsed.browser.action === "close"
          ? browserCloseCommand(resolveCommand(parsed.browser), io)
          : parsed.browser.action === "clear-profile"
            ? browserClearProfileCommand(resolveCommand(parsed.browser), io)
            : parsed.browser.action === "recipes"
              ? browserRecipesCommand(resolveCommand(parsed.browser), io)
              : parsed.browser.action === "site-notes"
                ? browserSiteNotesCommand(resolveCommand(parsed.browser), io)
                : browserCliCommand(resolveCommand(parsed.browser), io);
    }
    case "agents": {
      const { agentsCommand } = await import("./features/agents/client.js");
      if (parsed.agents === undefined) {
        io.stderr("agents requires an action\n");
        return EXIT.usage;
      }
      return agentsCommand(resolveCommand(parsed.agents), io);
    }
    case "projects": {
      const { projectsCommand } = await import("./features/projects/client.js");
      if (parsed.projects === undefined) {
        io.stderr("projects requires an action\n");
        return EXIT.usage;
      }
      return projectsCommand(resolveCommand(parsed.projects), io);
    }
    case "search": {
      const { searchCommand } = await import("./features/search/client.js");
      if (parsed.search === undefined) {
        io.stderr("search requires an action\n");
        return EXIT.usage;
      }
      return searchCommand(resolveCommand(parsed.search), io);
    }
    case "plugins": {
      const { pluginsCommand, pluginsUiCommand } = await import("./features/plugins/client.js");
      if (parsed.pluginsUi !== undefined) return pluginsUiCommand(resolveCommand(parsed.pluginsUi), io);
      if (parsed.plugins === undefined) {
        io.stderr("plugins requires an action\n");
        return EXIT.usage;
      }
      return pluginsCommand(resolveCommand(parsed.plugins), io);
    }
    case "mcp": {
      const { mcpCommand } = await import("./features/mcp/cli-command.js");
      if (parsed.mcp === undefined) {
        io.stderr("mcp requires an action\n");
        return EXIT.usage;
      }
      return mcpCommand({ ...parsed.mcp, dataDirectory: resolveCommand(parsed.mcp).dataDirectory }, io, (entryArgv, entryIo) =>
        main(entryArgv, { io: entryIo }),
      );
    }
    case "apps": {
      const { appsCli } = await import("./features/apps/client.js");
      if (parsed.apps === undefined) {
        io.stderr("apps requires an action\n");
        return EXIT.usage;
      }
      return appsCli({ ...parsed.apps, dataDirectory: resolveCommand(parsed.apps).dataDirectory }, io);
    }
    case "permissions": {
      const { permissionsCli } = await import("./features/permissions/client.js");
      if (parsed.permissions === undefined) {
        io.stderr("permissions requires an action\n");
        return EXIT.usage;
      }
      return permissionsCli(resolveCommand(parsed.permissions), io);
    }
    case "system-prompt": {
      const { systemPromptCommand } = await import("./features/system-prompt/client.js");
      if (parsed.systemPrompt === undefined) {
        io.stderr("system-prompt requires an action\n");
        return EXIT.usage;
      }
      return systemPromptCommand(resolveCommand(parsed.systemPrompt), io);
    }
    case "config": {
      const { configCommand } = await import("./features/config/client.js");
      if (parsed.config === undefined) {
        io.stderr("config requires an action\n");
        return EXIT.usage;
      }
      return configCommand(resolveCommand(parsed.config), io);
    }
    case "remote": {
      if (parsed.remote === undefined) {
        io.stderr("remote requires an action\n");
        return EXIT.usage;
      }
      const { remoteConnect } = await import("./features/remote/connect.js");
      const { onInterrupt } = await import("./shared/interrupt.js");
      let stop = (): void => undefined;
      const stopped = new Promise<void>((resolveStop) => {
        stop = resolveStop;
      });
      const off = onInterrupt(stop);
      try {
        return await remoteConnect(parsed.remote, io, { ok: EXIT.ok, usage: EXIT.usage, unavailable: EXIT.unavailable }, { stopped });
      } finally {
        off();
      }
    }
    case "service": {
      const { serviceCommand } = await import("./features/service/client.js");
      if (parsed.service === undefined) {
        io.stderr("service requires an action\n");
        return EXIT.usage;
      }
      return serviceCommand(resolveCommand(parsed.service), io);
    }
    case "sandbox": {
      const { sandboxCommand } = await import("./features/sandbox/client.js");
      if (parsed.sandbox === undefined) {
        io.stderr("sandbox requires an action\n");
        return EXIT.usage;
      }
      return sandboxCommand(resolveCommand(parsed.sandbox), io);
    }
    case "serve": {
      const { serveCommand } = await import("./server/command.js");
      if (parsed.serve === undefined) {
        io.stderr("serve requires options\n");
        return EXIT.usage;
      }
      {
        // A mirror of another computer's owner (`tavi remote connect`) is never served here: said first, before
        // the first-run check (which would reach that owner) or a model target is resolved.
        const dataDirectory = resolveCommand(parsed.serve).dataDirectory;
        const { readRemoteMirror } = await import("@tavi/runtime/owner-attach");
        let mirror;
        try {
          mirror = readRemoteMirror(dataDirectory);
        } catch (error) {
          io.stderr(`tavi serve: ${errorMessage(error)}\n`);
          return EXIT.unavailable;
        }
        if (mirror !== undefined) {
          io.stderr(
            `tavi serve: ${dataDirectory} mirrors the owner on ${mirror.target}, which serves it there; ` +
              "to run an owner on this computer, give it a data directory of its own (--data-dir)\n",
          );
          return EXIT.unavailable;
        }
      }
      {
        const stopped = await offerFirstRun(resolveCommand(parsed.serve).dataDirectory, io, options.onboard ?? {}, "serve");
        if (stopped !== undefined) return stopped;
      }
      return serveCommand(resolveCommand(parsed.serve), io);
    }
    case "logs": {
      const { logsCommand } = await import("./features/maintenance/client.js");
      if (parsed.logs === undefined) {
        io.stderr("logs needs its options\n");
        return EXIT.usage;
      }
      return logsCommand(parsed.logs, io);
    }
    case "inbox": {
      const { inboxListCommand, inboxReplayCommand } = await import("./features/inbox/client.js");
      if (parsed.inbox === undefined) {
        io.stderr("inbox needs its options\n");
        return EXIT.usage;
      }
      return parsed.inbox.action === "list" ? inboxListCommand(parsed.inbox, io) : inboxReplayCommand(parsed.inbox, io);
    }
    case "prune": {
      const { pruneCommand } = await import("./features/maintenance/client.js");
      if (parsed.prune === undefined) {
        io.stderr("prune needs its options\n");
        return EXIT.usage;
      }
      return pruneCommand(parsed.prune, io);
    }
    case "backup":
    case "export":
    case "restore": {
      const { maintenanceCommand } = await import("./features/maintenance/client.js");
      if (parsed.maintenance === undefined) {
        io.stderr(`${parsed.command} needs its options\n`);
        return EXIT.usage;
      }
      return maintenanceCommand(parsed.maintenance, io);
    }
    case "reset": {
      const { resetCommand } = await import("./features/maintenance/reset.js");
      if (parsed.reset === undefined) {
        io.stderr("reset needs its options\n");
        return EXIT.usage;
      }
      return resetCommand(parsed.reset, io);
    }
    case "cancel": {
      const { cancelTask } = await import("./features/tasks/client.js");
      if (parsed.cancel === undefined) {
        io.stderr("cancel requires options\n");
        return EXIT.usage;
      }
      return cancelTask(resolveCommand(parsed.cancel), io);
    }
    case "recover": {
      const { recoverTask } = await import("./features/tasks/client.js");
      if (parsed.recover === undefined) {
        io.stderr("recover requires options\n");
        return EXIT.usage;
      }
      return recoverTask(resolveCommand(parsed.recover), io);
    }
    case "run": {
      const { runTask } = await import("./features/run/client.js");
      if (parsed.options === undefined) {
        io.stderr("run requires options\n");
        return EXIT.usage;
      }
      {
        const stopped = await offerFirstRun(resolveCommand(parsed.options).dataDirectory, io, options.onboard ?? {}, "run");
        if (stopped !== undefined) return stopped;
      }
      return runTask(resolveCommand(parsed.options), io, runtimeFactory);
    }
    case "chat": {
      if (parsed.chat === undefined) {
        io.stderr("chat requires options\n");
        return EXIT.usage;
      }
      // Refused before the TUI is loaded: a pipeline pays for none of it.
      if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
        io.stderr("tavi chat needs a terminal; use `tavi run` in scripts and pipelines\n");
        return EXIT.usage;
      }
      // React picks its build when it is first imported: production, whatever
      // the environment says. The development reconciler retains memory for its
      // profiling marks (~148 MiB), which a long conversation accumulates, and a
      // `NODE_ENV` left over in a shell is not a choice to pay that.
      process.env["NODE_ENV"] = "production";
      // A replay plays a recording and calls no model, so it is never offered setup.
      if (parsed.chat.replay === undefined) {
        const stopped = await offerFirstRun(resolveCommand(parsed.chat).dataDirectory, io, options.onboard ?? {}, "chat");
        if (stopped !== undefined) return stopped;
      }
      // Loaded for this command alone: no other command pays for React, Ink and Yoga.
      const { runChat } = await import("./tui/index.js");
      return runChat(
        resolveCommand(parsed.chat),
        { stdout: process.stdout, stdin: process.stdin, stderr: io.stderr },
        { ok: EXIT.ok, usage: EXIT.usage, unavailable: EXIT.unavailable, detached: EXIT.detached },
      );
    }
    case "ui": {
      if (parsed.ui === undefined) {
        io.stderr("ui requires options\n");
        return EXIT.usage;
      }
      const { runUi } = await import("./features/ui/client.js");
      return runUi(
        resolveCommand(parsed.ui),
        { stdout: io.stdout, stderr: io.stderr, ...(process.stdin.isTTY === true ? { input: process.stdin } : {}) },
        { ok: EXIT.ok, unavailable: EXIT.unavailable },
      );
    }
    case "abort": {
      const { abortTask } = await import("./features/run/client.js");
      if (parsed.abort === undefined) {
        io.stderr("abort requires options\n");
        return EXIT.usage;
      }
      return abortTask(resolveCommand(parsed.abort), io);
    }
    default:
      io.stderr("Unsupported command\n");
      return EXIT.usage;
  }
}

/** Whether Node was started on this module itself (not on a module that imports it), by its real path on any platform. */
function startedHere(entrypoint: string | undefined): boolean {
  if (entrypoint === undefined) return false;
  try {
    return realpathSync(entrypoint) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

const invokedDirectly = startedHere(process.argv[1]);

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
