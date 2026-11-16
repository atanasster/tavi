import { APPROVALS_USAGE } from "../features/approvals/parse.js";
import { ARTIFACTS_USAGE } from "../features/artifacts/parse.js";
import { BINDINGS_USAGE } from "../features/bindings/parse.js";
import { BROWSER_USAGE } from "../features/browser/parse.js";
import { CONFIG_USAGE } from "../features/config/parse.js";
import { CREDENTIALS_USAGE } from "../features/credentials/parse.js";
import { INBOX_USAGE } from "../features/inbox/parse.js";
import { BACKUP_USAGE, EXPORT_USAGE, LOGS_USAGE, PRUNE_USAGE, RESET_USAGE, RESTORE_USAGE } from "../features/maintenance/parse.js";
import { MEMORY_USAGE } from "../features/memory/parse.js";
import { MODELS_USAGE } from "../features/models/parse.js";
import { PERMISSIONS_USAGE } from "../features/permissions/parse.js";
import { PLUGINS_USAGE } from "../features/plugins/parse.js";
import { PROJECTS_USAGE } from "../features/projects/parse.js";
import { REMINDERS_USAGE } from "../features/reminders/parse.js";
import { TODOS_USAGE } from "../features/todos/parse.js";
import { REPORTS_USAGE } from "../features/reports/parse.js";
import { ROUTER_USAGE } from "../features/router/parse.js";
import { ABORT_USAGE, RUN_USAGE } from "../features/run/parse.js";
import { SCHEDULES_USAGE } from "../features/schedules/parse.js";
import { SEARCH_USAGE } from "../features/search/parse.js";
import { SERVICE_USAGE } from "../features/service/parse.js";
import { SKILLS_USAGE } from "../features/skills/parse.js";
import { SYSTEM_PROMPT_USAGE } from "../features/system-prompt/parse.js";
import { CANCEL_USAGE, RECOVER_USAGE } from "../features/tasks/parse.js";
import { UI_USAGE } from "../features/ui/parse.js";
import { SERVE_USAGE } from "../server/parse.js";
import { CHAT_USAGE } from "../tui/parse.js";

/**
 * The command index: every family, one line each.
 *
 * Shared by `formatHelp()` (which appends each family's page — ~30 KB / 546
 * lines, right for `tavi help` on stdout) and by the errors that only need to
 * name the families, where a full manual under the message buries the mistake.
 */
export const COMMAND_INDEX = `tavi — local-first agent runtime

Terms (owner, principal, taint, …): docs/CONCEPTS.md#glossary

Usage:
  tavi onboard [status]         Set up what is still open: a model first (about 2 minutes)
  tavi setup [<step>]           Go through every setup step, or one, keeping what is set
  tavi serve [options]          Start the owner: the background process other commands use
  tavi run [options] <prompt>   Run one task (here, or on the owner when it runs)
  tavi chat [options]           Chat in the terminal (needs the owner running)
  tavi ui [options]             Open the web canvas in a browser (needs the owner running)
  tavi tasks [task-id]          List runs, or show one task's full timeline
  tavi router <action>          Optional model routing: configure it, explain a task's route
  tavi models <action>          Inspect and edit model configuration
  tavi memory <action>          Inspect and edit personal memory
  tavi skills <action>          Manage approved versioned skills
  tavi schedules <action>       Manage recurring unattended runs
  tavi reminders <action>       List, add, snooze, pause and cancel reminders
  tavi todos <action>           Your to-do list: list, add, tick off, remove, export
  tavi ideas <action>           What Tavi offers to do for you: list, try, dismiss, refresh, brief
  tavi heartbeat <action>       Turn the heartbeat on or off, tune it, check now, read its log
  tavi browser <action>         Browser sessions: history (30 days), live (watch), close
  tavi projects <action>        Manage the projects your reports collect data for
  tavi search <action>          Configure the web search providers web_search uses
  tavi plugins <action>         List, install, review, enable and configure plugins
  tavi mcp <action>             Add MCP servers (they are plugins: see tavi plugins)
  tavi apps <action>            Connected apps: every account and app, its health and its fix
  tavi permissions <action>     Tool rules, chat grants and the untrusted-content (taint) check
  tavi system-prompt <action>   Edit and preview the default system prompt
  tavi config <action>          Read and change workspace settings (timezone, summaries, browser thumbnails)
  tavi agents <action>          Manage named agent personas
  tavi service <action>         Generate a launchd/systemd unit that keeps serve alive
  tavi sandbox <action>         Check the sandbox on this host, and set it up where it needs root once
  tavi bindings <action>        Link a channel sender to a Tavi user (a principal)
  tavi channels <action>        Add, change, test and remove channel connections
  tavi artifacts <action>       Review tool output held back until you approve it
  tavi approvals <action>       Answer the approvals a task is suspended on
  tavi needs                    Everything waiting on you: questions, approvals, reviews
  tavi answer <task-id> <text>  Answer a task's open question
  tavi credentials <action>     Store, list and delete secrets the agent never sees
  tavi reports <action>         Inspect a brief; list the history and its trends
  tavi logs [--tail <n>]        Read the owner's log file
  tavi prune [--older-than n]   Delete old, finished message-delivery records
  tavi inbox <action>           See and replay inbound messages that were held
  tavi backup --out <dir>       Snapshot a data directory (database, artifacts)
  tavi export --out <dir>       Write every application table to NDJSON
  tavi restore --from <dir>     Restore a snapshot into the data directory
  tavi reset --yes              Delete all data, as if tavi had just been installed
  tavi recover <task-id>        Free a task stuck on a process that died
  tavi cancel <task-id>         Cancel a task for good
  tavi abort <task-id>          Stop a task's running turn (it can be resumed)
  tavi doctor                   Check what is set up and what works
  tavi --version                Print the version`;

/** The index alone — what a failed invocation needs, not the whole manual. */
export function formatCommandIndex(): string {
  return COMMAND_INDEX;
}

export function formatHelp(): string {
  return `${COMMAND_INDEX}

${SERVE_USAGE}
${MODELS_USAGE}
${ROUTER_USAGE}
${MEMORY_USAGE}
${SKILLS_USAGE}
${BINDINGS_USAGE}
${ARTIFACTS_USAGE}
${APPROVALS_USAGE}
${SCHEDULES_USAGE}
${REMINDERS_USAGE}
${TODOS_USAGE}
${BROWSER_USAGE}
${PROJECTS_USAGE}
${SEARCH_USAGE}
${PLUGINS_USAGE}
${PERMISSIONS_USAGE}
${SYSTEM_PROMPT_USAGE}
${CONFIG_USAGE}
${SERVICE_USAGE}
${CREDENTIALS_USAGE}
${REPORTS_USAGE}
${LOGS_USAGE}
${PRUNE_USAGE}
${INBOX_USAGE}
${BACKUP_USAGE}
${EXPORT_USAGE}
${RESTORE_USAGE}
${RESET_USAGE}
${CANCEL_USAGE}
${ABORT_USAGE}
${RECOVER_USAGE}
${RUN_USAGE}
${CHAT_USAGE}
${UI_USAGE}`;
}

/** `tavi --version`: the build id (the CLI package's version), and the commit of a source checkout. */
export function formatVersion(buildId: string, revision?: string): string {
  return revision === undefined ? `tavi ${buildId}` : `tavi ${buildId} (${revision})`;
}
