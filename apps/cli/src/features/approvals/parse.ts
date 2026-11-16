import {
  APPROVAL_NOTE_MAX_CHARS,
  IPC_MAX_PROMPT_CHARS,
  APPROVAL_HISTORY_KINDS,
  APPROVAL_HISTORY_MAX_LIMIT,
  APPROVAL_HISTORY_STATES,
  ApprovalInboxCursorSchema,
  type ApprovalHistoryKind,
  type ApprovalHistoryState,
  type ApprovalScope,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, integerFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import { operationKeyFlag } from "../../cli/parse-flags.js";
import type { ParsedCommand } from "../../cli/parse.js";

const APPROVALS_ACTIONS = ["list", "approve", "reject", "show", "history", "needs", "answer"] as const;
type ApprovalsAction = (typeof APPROVALS_ACTIONS)[number];

export interface ApprovalsCommandOptions {
  readonly action: ApprovalsAction;
  /** `approve`/`reject`'s positional argument: the task the approval belongs to. */
  readonly taskId?: string;
  /** Decide only this call instead of every pending approval for the task. */
  readonly callId?: string;
  readonly workspaceId: string;
  /** Who decided; the same default the other operator-facing decisions use. */
  readonly decidedBy: string;
  /** `approve --scope`: how long the approval stands. */
  readonly scope?: ApprovalScope;
  /** `reject --note`: the reason the model reads. */
  readonly note?: string;
  /** `history --kind`: which kinds of decision; all when absent. */
  readonly kinds?: readonly ApprovalHistoryKind[];
  /** `history --state`: which outcomes; all when absent. */
  readonly states?: readonly ApprovalHistoryState[];
  /** `history --since`/`--until`: the decision-time window, as ISO instants. */
  readonly since?: string;
  readonly until?: string;
  /** `history --tool`: approvals of this tool only (reviews and questions have none). */
  readonly toolId?: string;
  /** `history --principal`: decisions on this person's tasks only. */
  readonly principalId?: string;
  /** `history --cursor`: the page after the one that printed it. */
  readonly cursor?: string;
  /** `answer --answer`: the answer to the task's open question. */
  readonly answer?: string;
  /** `answer --wait`: the question's wait, asserting it is still the one open. */
  readonly waitId?: string;
  readonly limit: number;
  readonly format: OutputFormat;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
  /**
   * Model target for the resume.
   *
   * Optional, like `tavi run`: an unset pair falls back to the workspace default
   * (`tavi models set-default`), because resuming is the *write* — the workflow's
   * approval node records the decision — and that needs a model. Flag-only paths
   * would make this command unusable in exactly the deployment the `serve` gap
   * describes.
   */
  readonly connectionId?: string;
  readonly model?: string;
  readonly apiKeyFile?: string;
  readonly operationKey?: string;
}

export const APPROVALS_USAGE = `tavi approvals <action> [options]

Inspect and answer the approvals a task is suspended on.

A task that called a tool the deployment requires approval for stops, and stays
stopped until a decision is recorded. This command is the operator's surface for
a suspended approval, and deciding resumes the task exactly as the foreground
\`tavi run\` prompt does.

Actions:
  list                    List pending approvals, oldest first
  approve <task-id>       Grant them (or the one named by --call), and resume
  reject <task-id>        Deny them (or the one named by --call), and resume
  show <task-id>          The task's rounds that were sent to a chat (token,
                          conversation, expiry) and what happened to each:
                          announced, decided (by whom, via what, with what
                          scope), refused, expired, grants and rules created,
                          each call's result; then every call it asked about,
                          with its full input
  history                 Decisions made before, newest first: approvals
                          (granted, denied, expired, cancelled — by whom, via
                          which channel, with what scope), artifact reviews
                          and answered questions, across the workspace's tasks
  needs                   Everything waiting on you, as one queue: open
                          questions (with their options and deadline),
                          pending approvals and reviews, soonest deadline
                          first (also \`tavi needs\`)
  answer <task-id>        Answer the task's open question with --answer,
                          whichever channel it started from; needs a running
                          owner (also \`tavi answer <task-id> <answer>\`)

The decision is recorded against the task's own owner: the resume re-enters the
task as the principal and workspace that created it, and \`--decided-by\` is only
the attribution stored on the decision. An approval whose task cannot be read is
not listed and cannot be decided.

While \`tavi serve\` owns the directory, every action is the live owner's, over
IPC: \`approve\`/\`reject\` decide the round on it, and the resumed turn is
followed to its end with the same exit codes. Under an owner, --connection/
--model only assert the target the owner runs (another is refused, exit 2), and
--api-key-file and --operation-key are refused (exit 2): the owner resumes with
its own credentials, under the round's own key.

Options:
  --call <call-id>           Assert that this is the *only* pending call. The
                             workflow requires a decision for every call in a
                             turn, so a partial decision is refused here rather
                             than failing the task
  --limit <n>                Max rows for \`list\` (default: 50) or \`history\`
                             (default: 50, at most ${APPROVAL_HISTORY_MAX_LIMIT})
  --kind <kinds>             history: approval, review and/or question,
                             comma-separated (default: all)
  --state <states>           history: ${APPROVAL_HISTORY_STATES.join(", ")},
                             comma-separated (default: all)
  --since <time>             history: decided at or after (ISO date or time)
  --until <time>             history: decided at or before (ISO date or time)
  --tool <tool-id>           history: approvals of this tool only (reviews and
                             questions name no tool, so they are left out)
  --principal <id>           history: decisions on this person's tasks only
  --cursor <cursor>          history: the next page, as the previous one printed
                             it; with the same filters
  --decided-by <text>        Recorded as who decided (default: operator)
  --scope <once|session|always>
                             approve: once, for the rest of this chat (in Home
                             or a messaging chat: a day, or until it rolls
                             over), or as a workspace rule matching what was
                             shown (for a browser call: the whole browser) —
                             applied only where every call offers it. Default:
                             once, but a browser round is allowed for the rest
                             of this chat
  --note <text>              reject: the reason the task's model reads
  --answer <text>            answer: an option's number or label (several,
                             comma-separated, for a multi-select), or your own
                             words where the question allows them
  --wait <wait-id>           answer: assert this is the question still open
  --connection <id>          Model connection for the resume; defaults to the
                             workspace default set by \`tavi models set-default\`
  --model <id>               Model id for the resume; same default
  --api-key-file <path>      File containing the provider key (explicit binding)
  --operation-key <key>      Idempotency key for the resume admission
                             (default: the round's own key, shared by every
                             front end; may not begin with schedule:, reserved
                             for schedule fires)
  --format <text|json>       Output format (default: text)
  --workspace <id>           Workspace (default: default)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help

Deciding needs a model: the decision is recorded by the workflow's own approval
node when the task resumes, so the resume is the write. A task with no pending
approval under the given id exits 8, distinct from 0, so a caller can tell
"nothing was pending" from "decided and resumed".
`;

/** `tavi needs --help`: its own page, not `tavi approvals`'. */
export const NEEDS_USAGE = `tavi needs [--limit <n>] [options]

Everything waiting on you, as one queue: questions a task asks (with their
options), approvals and reviews, the soonest deadline first. Each is two
lines: what it asks, then its chat, when it stops waiting, and the command
that answers it. Also \`tavi approvals needs\`.

Options:
  --limit <n>                How many to list (default: 50)
  --format <text|json>       Output format (default: text)
  --workspace <id>           Workspace (default: default)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

/** `tavi answer --help`: its own page, not `tavi approvals`'. */
const ANSWER_USAGE = `tavi answer <task-id> <answer> [options]

Answer the question a task asks you (tavi needs lists them), whichever
channel it started from: an option's number or label (several, comma-
separated, for a multi-select), or your own words where the question allows
them. The words after the task id, up to the first option, are the answer.
Needs a running owner. Also \`tavi approvals answer <task-id> --answer <text>\`.

Options:
  --wait <wait-id>           Assert this is the question still open
  --format <text|json>       Output format (default: text)
  --workspace <id>           Workspace (default: default)
  --data-dir <path>          Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                 Show this help
`;

/**
 * `tavi answer <task-id> <answer…> [options]`: the words after the task, up to
 * the first option, are the answer — so `tavi answer t1 2` and
 * `tavi answer t1 next Monday --wait w1` both read as written.
 */
export function parseAnswer(argv: readonly string[]): ParsedCommand {
  const [taskId, ...rest] = argv;
  if (taskId === "-h" || taskId === "--help" || rest.includes("-h") || rest.includes("--help"))
    return { command: "help", usage: ANSWER_USAGE };
  if (taskId === undefined || taskId.startsWith("--")) throw new UsageError("answer needs a task id and an answer", ANSWER_USAGE);
  const firstFlag = rest.findIndex((token) => token.startsWith("--"));
  const words = firstFlag < 0 ? rest : rest.slice(0, firstFlag);
  const flags = firstFlag < 0 ? [] : rest.slice(firstFlag);
  return parseApprovals(["answer", taskId, ...(words.length === 0 ? [] : ["--answer", words.join(" ")]), ...flags]);
}

/**
 * Parse `tavi approvals`.
 *
 * Structurally the same as `parseArtifacts`: `list` is offline, `approve`/`reject`
 * take one positional task id and resume it. `--call` narrows a decision to one
 * call, which matters when a turn asked for several effects and the operator
 * wants to grant one and deny another.
 */
export function parseApprovals(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  // `--help` is a request for this page; a missing action is not success
  if (action === "-h" || action === "--help") return { command: "help", usage: APPROVALS_USAGE };
  if (action === undefined) {
    throw new UsageError(`approvals needs an action; expected one of ${APPROVALS_ACTIONS.join(", ")}`, APPROVALS_USAGE);
  }
  if (!(APPROVALS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `Unknown approvals action ${JSON.stringify(action)}; expected one of ${APPROVALS_ACTIONS.join(", ")}`,
      APPROVALS_USAGE,
    );
  }

  const allowedFlags: Readonly<Record<ApprovalsAction, readonly string[]>> = {
    list: ["--data-dir", "--workspace", "--limit", "--format"],
    approve: [
      "--data-dir",
      "--workspace",
      "--call",
      "--decided-by",
      "--format",
      "--connection",
      "--model",
      "--api-key-file",
      "--operation-key",
      "--scope",
    ],
    reject: [
      "--data-dir",
      "--workspace",
      "--call",
      "--decided-by",
      "--format",
      "--connection",
      "--model",
      "--api-key-file",
      "--operation-key",
      "--note",
    ],
    show: ["--data-dir", "--workspace", "--format"],
    history: [
      "--data-dir",
      "--workspace",
      "--kind",
      "--state",
      "--since",
      "--until",
      "--tool",
      "--principal",
      "--cursor",
      "--limit",
      "--format",
    ],
    needs: ["--data-dir", "--workspace", "--limit", "--format"],
    answer: ["--data-dir", "--workspace", "--answer", "--wait", "--format"],
  };
  const args = parseFlags(rest, {
    usage: APPROVALS_USAGE,
    valued: allowedFlags[action as ApprovalsAction],
    unknown: (name) => `approvals ${action} does not accept ${name}`,
    positional: (_token, taken) => (taken.length > 0 ? `approvals ${action} accepts at most one positional argument` : undefined),
  });
  if (args === "help") return { command: "help", usage: APPROVALS_USAGE };
  const { flags } = args;
  const positional = args.positionals[0];

  const decides = action === "approve" || action === "reject" || action === "show" || action === "answer";
  if (decides && positional === undefined) {
    throw new UsageError(`approvals ${action} needs a task id`, APPROVALS_USAGE);
  }
  if (!decides && positional !== undefined) {
    throw new UsageError(`approvals ${action} does not take a positional argument`, APPROVALS_USAGE);
  }

  const format = flags.get("--format");
  if (format !== undefined && format !== "text" && format !== "json") {
    throw new UsageError(`Unknown format ${JSON.stringify(format)}; expected text or json`, APPROVALS_USAGE);
  }

  const limitFlag = flags.get("--limit");
  let limit = 50;
  if (limitFlag !== undefined) {
    limit = integerFlag(
      limitFlag,
      { min: 1 },
      `--limit expects a positive integer, received ${JSON.stringify(limitFlag)}`,
      APPROVALS_USAGE,
    );
    if (action === "history" && limit > APPROVAL_HISTORY_MAX_LIMIT) {
      throw new UsageError(`--limit for approvals history is at most ${APPROVAL_HISTORY_MAX_LIMIT}`, APPROVALS_USAGE);
    }
  }
  const kinds = listFlag(flags.get("--kind"), APPROVAL_HISTORY_KINDS, "--kind");
  const states = listFlag(flags.get("--state"), APPROVAL_HISTORY_STATES, "--state");
  const since = instantFlag(flags.get("--since"), "--since", "start");
  const until = instantFlag(flags.get("--until"), "--until", "end");
  if (since !== undefined && until !== undefined && since > until) {
    throw new UsageError("--since must not follow --until", APPROVALS_USAGE);
  }
  const toolId = flags.get("--tool");
  if (toolId !== undefined && (toolId.trim() === "" || toolId.length > 128)) {
    throw new UsageError("--tool expects a tool id of 1-128 characters", APPROVALS_USAGE);
  }
  const principalId = flags.get("--principal");
  if (principalId !== undefined && (principalId.trim() === "" || principalId.length > 128)) {
    throw new UsageError("--principal expects a principal id of 1-128 characters", APPROVALS_USAGE);
  }
  const cursor = flags.get("--cursor");
  if (cursor !== undefined && !ApprovalInboxCursorSchema.safeParse(cursor).success) {
    throw new UsageError(`--cursor expects the cursor a previous page printed, received ${JSON.stringify(cursor)}`, APPROVALS_USAGE);
  }

  // Both reach the workflow's reply schema as non-blank bounded
  // strings, so a blank or over-long value must be a usage error here rather
  // than a confusing failure (or, for `--decided-by`, a destructive one) later.
  const decidedBy = flags.get("--decided-by") ?? "operator";
  if (decidedBy.trim() === "" || decidedBy.length > 128) {
    throw new UsageError("--decided-by must be 1-128 non-blank characters", APPROVALS_USAGE);
  }
  const callId = flags.get("--call");
  if (callId !== undefined && callId.trim() === "") {
    throw new UsageError("--call expects a call id", APPROVALS_USAGE);
  }

  const connectionId = flags.get("--connection");
  const model = flags.get("--model");
  const apiKeyFile = flags.get("--api-key-file");
  const operationKey = operationKeyFlag(flags, APPROVALS_USAGE);
  const scope = flags.get("--scope");
  if (scope !== undefined && scope !== "once" && scope !== "session" && scope !== "always") {
    throw new UsageError(`--scope expects once, session or always, received ${JSON.stringify(scope)}`, APPROVALS_USAGE);
  }
  const answer = flags.get("--answer");
  if (action === "answer" && (answer === undefined || answer.trim() === "" || answer.length > IPC_MAX_PROMPT_CHARS)) {
    throw new UsageError(`approvals answer needs --answer: 1-${IPC_MAX_PROMPT_CHARS} non-blank characters`, APPROVALS_USAGE);
  }
  const waitId = flags.get("--wait");
  if (waitId !== undefined && (waitId.trim() === "" || waitId.length > 512)) {
    throw new UsageError("--wait expects the question's wait id", APPROVALS_USAGE);
  }
  const note = flags.get("--note");
  if (note !== undefined && (note.trim() === "" || note.length > APPROVAL_NOTE_MAX_CHARS)) {
    throw new UsageError(`--note must be 1-${APPROVAL_NOTE_MAX_CHARS} non-blank characters`, APPROVALS_USAGE);
  }

  const parsed: ApprovalsCommandOptions = {
    action: action as ApprovalsAction,
    workspaceId: flags.get("--workspace") ?? "default",
    decidedBy,
    limit,
    format: (format as OutputFormat | undefined) ?? "text",
    ...definedOnly({
      callId,
      connectionId,
      model,
      apiKeyFile,
      operationKey,
      taskId: positional,
    }),
    ...(scope === undefined ? {} : { scope: scope as ApprovalScope }),
    ...definedOnly({
      note,
      kinds,
      states,
      since,
      until,
      toolId,
      principalId,
      cursor,
      answer,
      waitId,
    }),
    ...dataDirectoryFlag(flags),
  };
  return { command: "approvals", approvals: parsed };
}

/** A comma-separated flag whose every value is one of `allowed`, deduplicated. */
function listFlag<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T[] | undefined {
  if (value === undefined) return undefined;
  const values = value.split(",").map((part) => part.trim());
  const unknown = values.filter((part) => !(allowed as readonly string[]).includes(part));
  if (values.length === 0 || unknown.length > 0) {
    throw new UsageError(`${name} expects ${allowed.join(", ")} (comma-separated), received ${JSON.stringify(value)}`, APPROVALS_USAGE);
  }
  return [...new Set(values as T[])];
}

/**
 * An ISO instant, or a date (`2026-09-01`) read as the start or the end of
 * that UTC day, so `--until 2026-09-01` includes the whole day.
 */
function instantFlag(value: string | undefined, name: string, edge: "start" | "end"): string | undefined {
  if (value === undefined) return undefined;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z` : value;
  const parsed = Date.parse(date);
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(date) || Number.isNaN(parsed)) {
    throw new UsageError(`${name} expects an ISO date or time, received ${JSON.stringify(value)}`, APPROVALS_USAGE);
  }
  return new Date(parsed).toISOString();
}
