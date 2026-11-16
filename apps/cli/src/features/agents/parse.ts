import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags, removalAlias } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

/**
 * `tavi agents` — the named-persona registry.
 *
 * Operator-only, like `tavi credentials`: a persona is a standing instruction
 * that shapes what an unattended run does, so writing one is an operator act.
 * A definition carries no authority (no tool allowlist, no credential), so
 * nothing here can widen what an agent is permitted to do.
 */
const AGENTS_ACTIONS = ["add", "list", "show", "update", "remove", "enable", "disable"] as const;
type AgentsAction = (typeof AGENTS_ACTIONS)[number];

export const AGENTS_USAGE = `tavi agents <action> [options]

Manage named agent personas. A task, a spawn or a schedule may name an agent;
its instructions are then used for that task's model calls. Definitions carry no
permissions — what an unattended run may do is its schedule's tool policy.

Under a live \`tavi serve\`, every action runs on the owner over IPC; otherwise
on the data directory.

Actions:
  add <id>                   Create an agent definition (the id is positional)
  list                       List definitions in the workspace
  show <id>                  Show one definition, including its instructions
  update <id>                Edit its name, description or instructions
  remove <id>                Delete a definition (alias: rm, delete)
  enable|disable <id>        Arm or disarm it (a disabled agent cannot be admitted)

Options:
  --name <name>              Human-readable name (required for add)
  --prompt <text>            The persona instructions (required for add)
  --description <text>       One line on what the agent is for; an empty value
                             clears it on update
  --format <text|json>       Output format (default: text)
  --workspace <id>           Workspace (default: default)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export interface AgentsCommandOptions {
  readonly action: AgentsAction;
  /** Positional agent id, for every action but add/list. */
  readonly agentId?: string;
  readonly name?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly format: OutputFormat;
  readonly workspaceId: string;
  readonly dataDirectory?: string;
}

export function parseAgents(argv: readonly string[]): ParsedCommand {
  const [typed, ...rest] = argv;
  // `rm`, `remove` and `delete` all name the removal.
  const action = removalAlias(typed, "remove");
  // `--help` is a request for this page; a missing action is not success
  if (action === "-h" || action === "--help") return { command: "help", usage: AGENTS_USAGE };
  if (action === undefined) {
    throw new UsageError(`agents needs an action; expected one of ${AGENTS_ACTIONS.join(", ")}`, AGENTS_USAGE);
  }
  if (!(AGENTS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown agents action ${JSON.stringify(action)}; expected one of ${AGENTS_ACTIONS.join(", ")}`, AGENTS_USAGE);
  }
  const resolvedAction = action as AgentsAction;
  const editable = ["--name", "--prompt", "--description"];
  const common = ["--data-dir", "--format", "--workspace"];
  const allowedFlags: Readonly<Record<AgentsAction, readonly string[]>> = {
    add: [...editable, ...common],
    list: common,
    show: common,
    // The same three fields `add` writes: an operator who can author a persona
    // can fix one. `AgentDefinitionRepositoryPort.update` has always accepted
    // them — until now nothing called it with anything but `enabled`, so a
    // badly-worded persona could only be repaired by deleting it and its id.
    update: [...editable, ...common],
    remove: common,
    enable: common,
    disable: common,
  };
  const args = parseFlags(rest, {
    usage: AGENTS_USAGE,
    valued: allowedFlags[resolvedAction],
    unknown: (name) => `agents ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage: AGENTS_USAGE };
  const { flags, positionals } = args;

  const agentId = positionals[0];
  if (positionals.length > 1) {
    throw new UsageError(`agents ${action} takes at most one agent id`, AGENTS_USAGE);
  }
  if (resolvedAction !== "add" && resolvedAction !== "list" && agentId === undefined) {
    throw new UsageError(`agents ${resolvedAction} needs an agent id`, AGENTS_USAGE);
  }
  if (resolvedAction === "add") {
    for (const required of ["--name", "--prompt"]) {
      if (flags.get(required) === undefined) {
        throw new UsageError(`agents add needs ${required}`, AGENTS_USAGE);
      }
    }
  }
  if (resolvedAction === "update" && editable.every((flag) => flags.get(flag) === undefined)) {
    // An update with nothing to update is a mistyped command, not a no-op that
    // should report success: it would print the unchanged definition and leave
    // the operator believing their edit landed.
    throw new UsageError(`agents update needs at least one of ${editable.join(", ")}`, AGENTS_USAGE);
  }

  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, AGENTS_USAGE);
  }
  // Validated here so a bad id is a usage error rather than a rejected insert,
  // and so `tavi schedules add --agent` can rely on the same shape.
  //
  // `remove` is exempt, and deliberately: it is the repair path for an id that
  // is already in the table. A row written by an older release or a hand edit can
  // hold an id this pattern rejects, and gating the parser on the pattern makes
  // exactly that row undeletable — the one case where the operator most needs the
  // command. Everything that *creates* or *addresses* a live definition still
  // goes through the check.
  if (agentId !== undefined && resolvedAction !== "remove" && !AGENT_ID_PATTERN.test(agentId)) {
    throw new UsageError(`${JSON.stringify(agentId)} is not a valid agent id (letters, digits, dot, dash, underscore)`, AGENTS_USAGE);
  }
  const name = flags.get("--name");
  const description = flags.get("--description");
  const prompt = flags.get("--prompt");

  return {
    command: "agents",
    agents: {
      action: resolvedAction,
      ...definedOnly({
        agentId,
        name,
        description,
        prompt,
      }),
      format,
      workspaceId: flags.get("--workspace") ?? "default",
      ...dataDirectoryFlag(flags),
    },
  };
}

/** Mirrors `AgentDefinitionSchema`'s id rule, so the CLI rejects a bad id before the store does. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
