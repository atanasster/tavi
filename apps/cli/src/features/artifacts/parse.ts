import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, integerFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import { operationKeyFlag } from "../../cli/parse-flags.js";
import type { ParsedCommand } from "../../cli/parse.js";

/**
 * Actions `tavi artifacts` supports — the first
 * artifact-facing CLI surface this codebase has ever had. A `pending`
 * artifact's real content (a sandboxed command's archived output, a
 * browser screenshot or download) was created by a governed tool a model
 * already called; deciding whether to trust it is a durable, out-of-band
 * operator action, the same "the model decides, nothing happens
 * silently, an operator decides what the model can't" discipline this
 * codebase's other governed-tool surfaces already establish.
 */
const ARTIFACTS_ACTIONS = ["list", "approve", "reject"] as const;
type ArtifactsAction = (typeof ARTIFACTS_ACTIONS)[number];

export interface ArtifactsCommandOptions {
  readonly action: ArtifactsAction;
  /** `approve`/`reject`'s positional argument. */
  readonly artifactId?: string;
  readonly workspaceId: string;
  /** Who decided; defaults to "operator", the same default `tavi bindings bind`'s `--approved-by` and `tavi memory`/`tavi skills`'s acting principal use. */
  readonly reviewedBy: string;
  readonly limit: number;
  readonly format: OutputFormat;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
  /**
   * `approve`/`reject` only: after recording the decision, re-admit the
   * specific task waiting on this artifact (`kind: "approval"`, `resume:
   * { reviewAck: true }`) and report its outcome, instead of leaving the
   * decision recorded but the task still suspended. Opt-in, not the
   * default: the plain decide-only behavior needs no model credentials at
   * all, and changing that by default would be a breaking change to an
   * already-shipped command.
   */
  readonly resume: boolean;
  /** Required when `resume` is true — resuming may call the model for the task's next turn, the same as \`tavi run\`. */
  readonly connectionId?: string;
  readonly model?: string;
  readonly apiKeyFile?: string;
  readonly operationKey?: string;
}

export const ARTIFACTS_USAGE = `tavi artifacts <action> [options]

Review the files a tool held back as \`pending\` — a sandboxed command's
saved output, a browser screenshot or download. The task that produced one
waits until you decide here; the model never sees a pending artifact's content,
and a rejected one never reaches it at all. \`list\`, \`approve\` and
\`reject\` run on the running \`tavi serve\` when there is one, and on the
data directory directly when there is none. With --resume, --connection/--model (still required)
must then name the target the owner runs, and --api-key-file and
--operation-key are refused.

Actions:
  list                       List artifacts still pending review
  approve <artifact-id>      Approve a pending artifact
  reject <artifact-id>       Reject a pending artifact

Options:
  --workspace <id>            Workspace to act in (default: default)
  --reviewed-by <text>         Who is deciding (default: operator)
  --limit <n>                  Max rows for \`list\` (default: 50)
  --format <text|json>          Output format (default: text)
  --data-dir <path>             Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                    Show this help

\`approve\`/\`reject\` only — resuming the suspended task:
  --resume                     Also re-admit the task waiting on this
                                artifact and report its outcome (default:
                                record the decision only, same as before)
  --connection <id>            Model provider connection id (required with --resume)
  --model <id>                 Model id (required with --resume)
  --api-key-file <path>        File containing the provider key (explicit binding)
  --operation-key <key>        Idempotency key for the resume admission
                               (default: the review suspension's own key;
                               may not begin with schedule:, reserved for schedule fires)

Deciding a pending artifact always records the decision durably. Without
\`--resume\`, the task waiting on it stays suspended — decide with \`tavi
artifacts approve|reject\`, then resume separately with \`--resume\` (or a
programmatic caller re-admitting the task directly). With \`--resume\`,
this command re-admits the task itself, streams its next turn the same
way \`tavi run\` does, and exits with the matching code (0 completed, 6
still waiting on another artifact review, 7 still waiting on \`agents.wait\`,
1 failed, 8 if the artifact had no associated task to resume at all —
distinct from 0 so a \`--resume\` caller can tell "nothing to resume" apart
from "resume completed").
`;

/** Parse `tavi artifacts <action>`. */
export function parseArtifacts(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  // `--help` is a request for this page; a missing action is not success
  if (action === "-h" || action === "--help") return { command: "help", usage: ARTIFACTS_USAGE };
  if (action === undefined) {
    throw new UsageError(`artifacts needs an action; expected one of ${ARTIFACTS_ACTIONS.join(", ")}`, ARTIFACTS_USAGE);
  }
  if (!(ARTIFACTS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `Unknown artifacts action ${JSON.stringify(action)}; expected one of ${ARTIFACTS_ACTIONS.join(", ")}`,
      ARTIFACTS_USAGE,
    );
  }

  const allowedFlags: Readonly<Record<ArtifactsAction, readonly string[]>> = {
    list: ["--data-dir", "--workspace", "--limit", "--format"],
    approve: [
      "--data-dir",
      "--workspace",
      "--reviewed-by",
      "--format",
      "--resume",
      "--connection",
      "--model",
      "--api-key-file",
      "--operation-key",
    ],
    reject: [
      "--data-dir",
      "--workspace",
      "--reviewed-by",
      "--format",
      "--resume",
      "--connection",
      "--model",
      "--api-key-file",
      "--operation-key",
    ],
  };
  const allowed = allowedFlags[action as ArtifactsAction];
  const args = parseFlags(rest, {
    usage: ARTIFACTS_USAGE,
    valued: allowed,
    switches: allowed.filter((flag) => flag === "--resume"),
    unknown: (name) => `artifacts ${action} does not accept ${name}`,
    positional: (_token, taken) => (taken.length > 0 ? `artifacts ${action} accepts at most one positional argument` : undefined),
  });
  if (args === "help") return { command: "help", usage: ARTIFACTS_USAGE };
  const { flags } = args;
  const positional = args.positionals[0];
  const resume = args.switches.has("--resume");

  const needsArtifactId = action === "approve" || action === "reject";
  if (needsArtifactId && positional === undefined) {
    throw new UsageError(`artifacts ${action} needs an artifact id`, ARTIFACTS_USAGE);
  }
  if (!needsArtifactId && positional !== undefined) {
    throw new UsageError(`artifacts ${action} does not take a positional argument`, ARTIFACTS_USAGE);
  }

  const format = flags.get("--format");
  if (format !== undefined && format !== "text" && format !== "json") {
    throw new UsageError(`Unknown format ${JSON.stringify(format)}; expected text or json`, ARTIFACTS_USAGE);
  }

  const limitFlag = flags.get("--limit");
  const limit =
    limitFlag === undefined
      ? 50
      : integerFlag(limitFlag, { min: 1 }, `--limit expects a positive integer, received ${limitFlag}`, ARTIFACTS_USAGE);

  const connectionId = flags.get("--connection");
  const model = flags.get("--model");
  if (resume && connectionId === undefined) {
    throw new UsageError("--connection is required with --resume", ARTIFACTS_USAGE);
  }
  if (resume && model === undefined) {
    throw new UsageError("--model is required with --resume", ARTIFACTS_USAGE);
  }
  const apiKeyFile = flags.get("--api-key-file");
  const operationKey = operationKeyFlag(flags, ARTIFACTS_USAGE);

  const parsed: ArtifactsCommandOptions = {
    action: action as ArtifactsAction,
    workspaceId: flags.get("--workspace") ?? "default",
    reviewedBy: flags.get("--reviewed-by") ?? "operator",
    limit,
    format: (format as OutputFormat | undefined) ?? "text",
    resume,
    ...definedOnly({
      connectionId,
      model,
      apiKeyFile,
      operationKey,
      artifactId: positional,
    }),
    ...dataDirectoryFlag(flags),
  };
  return { command: "artifacts", artifacts: parsed };
}
