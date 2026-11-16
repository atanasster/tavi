import { csvList, definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags, removalAlias } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

/**
 * `tavi projects` — the registry the collectors read.
 *
 * `import` is the one-way door out of `<dataDir>/projects.json`: after it runs,
 * the database is the authority and the file is inert. That direction matters —
 * a deployment with two authorities is a deployment whose brief silently reads
 * one of them.
 */
const PROJECTS_ACTIONS = ["add", "list", "show", "remove", "enable", "disable", "import"] as const;
type ProjectsAction = (typeof PROJECTS_ACTIONS)[number];

export const PROJECTS_USAGE = `tavi projects <action> [options]

Manage the projects your reports collect data for (analytics, search,
billing). Replaces <data-dir>/projects.json,
which is now only an import source.

Under a live \`tavi serve\`, every action but import runs on the owner over IPC;
import needs the owner stopped.

Actions:
  add <id>                   Add a project (the id is positional)
  list                       List projects in the workspace
  show <id>                  Show one project and its source configuration
  remove <id>                Delete a project (alias: rm, delete)
  enable|disable <id>        Enable or park it (a parked project keeps its ids
                             but is skipped by every collector)
  import                     Read <data-dir>/projects.json into the registry

Options:
  --name <name>              Human-readable name
  --ga4 <property>           GA4 property, e.g. properties/513076108
  --gsc <site>               Search Console property, e.g. sc-domain:example.com
  --gcp-project <id>         BigQuery billing project (with --gcp-table)
  --gcp-table <table>        BigQuery billing export table (with --gcp-project)
  --stripe-ref <ref>         Credential reference for the Stripe key
  --keyword <word>           News keyword (repeatable, or comma-separated)
  --language <code>          News language, e.g. en
  --region <code>            News region, e.g. US
  --format <text|json>       Output format (default: text)
  --workspace <id>           Workspace (default: default)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

export interface ProjectsCommandOptions {
  readonly action: ProjectsAction;
  readonly projectId?: string;
  readonly name?: string;
  readonly ga4?: string;
  readonly gsc?: string;
  readonly gcpProject?: string;
  readonly gcpTable?: string;
  readonly stripeRef?: string;
  readonly keywords?: readonly string[];
  readonly language?: string;
  readonly region?: string;
  readonly format: OutputFormat;
  readonly workspaceId: string;
  readonly dataDirectory?: string;
}

export function parseProjects(argv: readonly string[]): ParsedCommand {
  const [typed, ...rest] = argv;
  // `rm`, `remove` and `delete` all name the removal.
  const action = removalAlias(typed, "remove");
  // `--help` is a request for this page; a missing action is not success
  if (action === "-h" || action === "--help") return { command: "help", usage: PROJECTS_USAGE };
  if (action === undefined) {
    throw new UsageError(`projects needs an action; expected one of ${PROJECTS_ACTIONS.join(", ")}`, PROJECTS_USAGE);
  }
  if (!(PROJECTS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `Unknown projects action ${JSON.stringify(action)}; expected one of ${PROJECTS_ACTIONS.join(", ")}`,
      PROJECTS_USAGE,
    );
  }
  const resolvedAction = action as ProjectsAction;
  const addOnly = ["--name", "--ga4", "--gsc", "--gcp-project", "--gcp-table", "--stripe-ref", "--keyword", "--language", "--region"];
  const common = ["--data-dir", "--format", "--workspace"];
  const allowedFlags: Readonly<Record<ProjectsAction, readonly string[]>> = {
    add: [...addOnly, ...common],
    list: common,
    show: common,
    remove: common,
    enable: common,
    disable: common,
    // The import file carries the deployment-wide settings itself, so it needs
    // no flags beyond the destination.
    import: common,
  };
  const args = parseFlags(rest, {
    usage: PROJECTS_USAGE,
    valued: allowedFlags[resolvedAction],
    lists: ["--keyword"],
    unknown: (name) => `projects ${action} does not accept ${name}`,
  });
  if (args === "help") return { command: "help", usage: PROJECTS_USAGE };
  const { flags, positionals } = args;
  const keywords = (args.lists.get("--keyword") ?? []).flatMap((value) => csvList(value));

  const projectId = positionals[0];
  if (positionals.length > 1) {
    throw new UsageError(`projects ${action} takes at most one project id`, PROJECTS_USAGE);
  }
  if (resolvedAction !== "add" && resolvedAction !== "list" && resolvedAction !== "import" && projectId === undefined) {
    throw new UsageError(`projects ${resolvedAction} needs a project id`, PROJECTS_USAGE);
  }
  if (resolvedAction === "add" && projectId === undefined) {
    throw new UsageError("projects add needs a project id", PROJECTS_USAGE);
  }
  if (resolvedAction !== "add" && addOnly.some((flag) => flags.has(flag) || (flag === "--keyword" && keywords.length > 0))) {
    throw new UsageError(`projects ${action} accepts only --data-dir, --format and --workspace`, PROJECTS_USAGE);
  }

  const format = flags.get("--format") ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", received ${JSON.stringify(format)}`, PROJECTS_USAGE);
  }
  // Both billing coordinates come from one object in the registry, so half of
  // one is a mistake rather than a partial configuration.
  const gcpProject = flags.get("--gcp-project");
  const gcpTable = flags.get("--gcp-table");
  if ((gcpProject === undefined) !== (gcpTable === undefined)) {
    throw new UsageError("--gcp-project and --gcp-table must be given together", PROJECTS_USAGE);
  }
  const name = flags.get("--name");
  const ga4 = flags.get("--ga4");
  const gsc = flags.get("--gsc");
  const stripeRef = flags.get("--stripe-ref");
  const language = flags.get("--language");
  const region = flags.get("--region");

  return {
    command: "projects",
    projects: {
      action: resolvedAction,
      ...definedOnly({
        projectId,
        name,
        ga4,
        gsc,
        gcpProject,
        gcpTable,
        stripeRef,
      }),
      ...(keywords.length === 0 ? {} : { keywords }),
      ...(language === undefined ? {} : { language }),
      ...(region === undefined ? {} : { region }),
      format,
      workspaceId: flags.get("--workspace") ?? "default",
      ...dataDirectoryFlag(flags),
    },
  };
}
