import { SKILL_FEEDBACK_MAX_CHARS } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

/** Actions `tavi memory` supports; configuration-style, same exclusive ownership as `models`. */
/** Actions `tavi skills` supports. `pin-rollout`/`clear-rollout`/`rollout-status` are the operator-facing surface for the bounded-rollout allowlist. */
const SKILLS_ACTIONS = [
  "list",
  "show",
  "import",
  "edit",
  "regenerate",
  "approve",
  "reject",
  "activate",
  "disable",
  "rollback",
  "pin-rollout",
  "clear-rollout",
  "rollout-status",
] as const;
type SkillsAction = (typeof SKILLS_ACTIONS)[number];

export interface SkillsCommandOptions {
  readonly action: SkillsAction;
  readonly workspaceId: string;
  readonly principalId: string;
  /** `show`/`import`/`approve`/`activate`/`rollback`/`pin-rollout`/`clear-rollout`/`rollout-status`'s positional skill id. */
  readonly skillId?: string;
  readonly version?: string;
  readonly packagePath?: string;
  readonly name?: string;
  readonly description?: string;
  readonly provenance?: string;
  readonly format: OutputFormat;
  /** `pin-rollout`'s authorized task ids — repeatable `--task <id>`, matching `tavi models set-role`'s own `--fallback` convention. */
  readonly taskIds?: readonly string[];
  /** `import <folder|SKILL.md|zip>`: an Agent Skills package to read, in place of `--package`. */
  readonly agentSkillPath?: string;
  /** `show --body`: print a version's text (`--version`, else the active one). */
  readonly body?: boolean;
  /** `regenerate --feedback`: what the person wants changed, sent to the proposal's chat. */
  readonly feedback?: string;
  /** `approve --yes`: approve a skill another author wrote without asking. */
  readonly yes?: boolean;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
}

export const SKILLS_USAGE = `tavi skills <action> [options]

Inspect and manage approved versioned skills. While \`tavi serve\` runs they go
through it (the rollout actions stop until it is stopped); otherwise they work
on the data directory directly. Scoped to one workspace.

Actions:
  list                       List skill versions in this workspace
  show <skill-id>            Show every version, the active pointer and history;
                              with --body, a version's text (--version, else the
                              active one)
  import <skill-id>          Import a package as a new version (enters proposed
                              unless exact bytes were already approved)
  import <folder|SKILL.md|zip>
                             Import an Agent Skills package: its frontmatter's
                              name, description, metadata.version (or
                              --version), allowed-tools and compatibility; its
                              references/ and scripts/ are kept as text, never run
  edit <skill-id>            Edit an agent's proposal before approving it: --package
                              is the new text, filed as a new proposed version
                              that follows it (the proposal is set aside)
  regenerate <skill-id>      Send --feedback on an agent's proposal to the chat it
                              came from, asking the agent to propose it again
                              (needs \`tavi serve\`)
  approve <skill-id>         Approve a proposed version: prints its text and hash,
                              and needs --yes when another author wrote it
                              (a chat's proposal, an outside archive)
  reject <skill-id>          Reject a proposed version
  activate <skill-id>        Point this workspace's activation at an approved version
  disable <skill-id>         Clear this workspace's activation: no version is active
  rollback <skill-id>        Activate a version this workspace has activated before
  pin-rollout <skill-id>     Bound a version to an explicit authorized task set
                              (repeatable --task); the active version by default, or
                              a stored, not-yet-active --version so the pin precedes
                              activation; unpinned means unrestricted
  clear-rollout <skill-id>   Lift a bounded rollout — the active version by default,
                              or a specific (possibly stale/inactive) --version
  rollout-status <skill-id>  Show the active version's own pin status plus every
                              OTHER pinned version, including stale ones

Options:
  --version <text>            Skill version (required for import/approve/activate/
                              rollback; optional for pin-rollout/clear-rollout —
                              targets a specific, possibly non-active version)
  --package <path>            Package file to import (required for import), or the
                              edited text (required for edit)
  --feedback <text>           regenerate: what to change (at most 4,000 characters)
  --name <text>               Manifest name (required for import)
  --description <text>        Manifest description
  --provenance <text>         Where the package came from (required for import)
  --body                      show: print the version's text
  --yes                       approve: approve a skill another author wrote
  --task <id>                 Authorized task id for pin-rollout (repeatable, at
                              least one required)
  --workspace <id>            Workspace to act in (default: default)
  --principal <id>            Acting principal (default: operator)
  --format <text|json>        Output format (default: text)
  --data-dir <path>           Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                  Show this help
`;

/** Parse `tavi skills <action>`. */
export function parseSkills(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  // `--help` is a request for this page; a missing action is not success
  if (action === "-h" || action === "--help") return { command: "help", usage: SKILLS_USAGE };
  if (action === undefined) {
    throw new UsageError(`skills needs an action; expected one of ${SKILLS_ACTIONS.join(", ")}`, SKILLS_USAGE);
  }
  if (!(SKILLS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown skills action ${JSON.stringify(action)}; expected one of ${SKILLS_ACTIONS.join(", ")}`, SKILLS_USAGE);
  }

  const allowedFlags: Readonly<Record<SkillsAction, readonly string[]>> = {
    list: ["--data-dir", "--workspace", "--principal", "--format"],
    show: ["--data-dir", "--workspace", "--principal", "--format", "--version"],
    import: ["--data-dir", "--workspace", "--principal", "--version", "--package", "--name", "--description", "--provenance", "--format"],
    edit: ["--data-dir", "--workspace", "--principal", "--version", "--package", "--format"],
    regenerate: ["--data-dir", "--workspace", "--principal", "--version", "--feedback", "--format"],
    approve: ["--data-dir", "--workspace", "--principal", "--version", "--format"],
    reject: ["--data-dir", "--workspace", "--principal", "--version", "--format"],
    activate: ["--data-dir", "--workspace", "--principal", "--version", "--format"],
    disable: ["--data-dir", "--workspace", "--principal", "--format"],
    rollback: ["--data-dir", "--workspace", "--principal", "--version", "--format"],
    "pin-rollout": ["--data-dir", "--workspace", "--principal", "--format", "--task", "--version"],
    "clear-rollout": ["--data-dir", "--workspace", "--principal", "--format", "--version"],
    "rollout-status": ["--data-dir", "--workspace", "--principal", "--format"],
  };
  const allowed = allowedFlags[action as SkillsAction];

  const args = parseFlags(rest, {
    usage: SKILLS_USAGE,
    valued: allowed,
    switches: action === "show" ? ["--body"] : action === "approve" ? ["--yes"] : [],
    lists: ["--task"],
    unknown: (name) => `skills ${action} does not accept ${name}`,
    positional: (_token, taken) => (taken.length > 0 ? `skills ${action} accepts at most one positional argument` : undefined),
  });
  if (args === "help") return { command: "help", usage: SKILLS_USAGE };
  const { flags } = args;
  const taskIds = args.lists.get("--task") ?? [];
  if (taskIds.some((value) => value.trim() === "")) throw new UsageError("skills pin-rollout --task needs a non-empty value", SKILLS_USAGE);
  const positional = args.positionals[0];

  const needsSkillId = action !== "list";
  if (needsSkillId && positional === undefined) {
    throw new UsageError(`skills ${action} needs a skill id`, SKILLS_USAGE);
  }
  if (!needsSkillId && positional !== undefined) {
    throw new UsageError(`skills ${action} does not take a positional argument`, SKILLS_USAGE);
  }

  // `import <folder|SKILL.md|zip>` reads an Agent Skills package: its frontmatter names it, so only the path is needed.
  // Without --package the argument is that path; whether it exists is checked when it is read.
  const agentSkill = action === "import" && flags.get("--package") === undefined;
  const needsVersion =
    (action === "import" && !agentSkill) ||
    action === "edit" ||
    action === "regenerate" ||
    action === "approve" ||
    action === "reject" ||
    action === "activate" ||
    action === "rollback";
  const version = flags.get("--version");
  if (needsVersion && version === undefined) {
    throw new UsageError(`skills ${action} needs --version`, SKILLS_USAGE);
  }
  if (action === "import" && !agentSkill) {
    if (flags.get("--name") === undefined) throw new UsageError("skills import needs --name", SKILLS_USAGE);
    if (flags.get("--provenance") === undefined) {
      throw new UsageError("skills import needs --provenance", SKILLS_USAGE);
    }
  }
  if (action === "edit" && flags.get("--package") === undefined) throw new UsageError("skills edit needs --package", SKILLS_USAGE);
  const feedback = flags.get("--feedback");
  if (action === "regenerate" && (feedback === undefined || feedback.trim() === ""))
    throw new UsageError("skills regenerate needs --feedback", SKILLS_USAGE);
  if (action === "regenerate" && feedback !== undefined && feedback.length > SKILL_FEEDBACK_MAX_CHARS)
    throw new UsageError(`skills regenerate --feedback is at most ${SKILL_FEEDBACK_MAX_CHARS} characters`, SKILLS_USAGE);
  if (action === "pin-rollout" && taskIds.length === 0) {
    throw new UsageError("skills pin-rollout needs at least one --task", SKILLS_USAGE);
  }
  const format = flags.get("--format");
  if (format !== undefined && format !== "text" && format !== "json") {
    throw new UsageError(`Unknown format ${JSON.stringify(format)}; expected text or json`, SKILLS_USAGE);
  }

  const packagePath = flags.get("--package");
  const name = flags.get("--name");
  const description = flags.get("--description");
  const provenance = flags.get("--provenance");
  const parsed: SkillsCommandOptions = {
    action: action as SkillsAction,
    workspaceId: flags.get("--workspace") ?? "default",
    principalId: flags.get("--principal") ?? "operator",
    format: (format as OutputFormat | undefined) ?? "text",
    ...(agentSkill && positional !== undefined
      ? { agentSkillPath: positional }
      : needsSkillId && positional !== undefined
        ? { skillId: positional }
        : {}),
    ...definedOnly({
      version,
      packagePath,
      name,
      description,
      provenance,
      feedback,
    }),
    ...(taskIds.length === 0 ? {} : { taskIds }),
    ...(args.switches.has("--body") ? { body: true } : {}),
    ...(args.switches.has("--yes") ? { yes: true } : {}),
    ...dataDirectoryFlag(flags),
  };
  return { command: "skills", skills: parsed };
}
