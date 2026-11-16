import {
  MemoryScopeTargetSchema,
  MEMORY_CONFIG_KEYS,
  MEMORY_EGRESS_FIELDS,
  MEMORY_KINDS,
  type MemoryConfigKey,
  type MemoryEgressField,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, integerFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";

const MEMORY_ACTIONS = [
  "list",
  "proposals",
  "review",
  "search",
  "show",
  "remember",
  "correct",
  "approve",
  "reject",
  "forget",
  "move",
  "why",
  "export",
  "config",
  "set-provider",
  "egress",
  "reindex",
  "review-now",
  "consolidate-now",
] as const;
type MemoryAction = (typeof MEMORY_ACTIONS)[number];

/**
 * The scope kinds selectable from the CLI, `agent:<agent id>` (the
 * principal's memory for one agent in the workspace) and `chat:<task id>`
 * (one chat's notes).
 */
const MEMORY_SCOPE_NAMES = ["personal", "workspace", "shared"] as const;
type MemoryScopeName = (typeof MEMORY_SCOPE_NAMES)[number] | `agent:${string}` | `chat:${string}`;
/** The scopes `remember` writes to: shared memory is changed by an explicit share only, never from here. */
const MEMORY_REMEMBER_SCOPES = "personal, workspace, agent:<agent id> or chat:<task id>";

export interface MemoryCommandOptions {
  readonly action: MemoryAction;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly scope?: MemoryScopeName;
  /** `show`/`correct`/`approve`/`reject`/`forget`'s positional record id. */
  readonly recordId?: string;
  /** `search`'s positional query. */
  readonly query?: string;
  readonly kind?: string;
  readonly title?: string;
  readonly body?: string;
  readonly preferenceKey?: string;
  readonly preferenceValue?: string;
  readonly topicKey?: string;
  readonly sensitive?: boolean;
  readonly reason?: string;
  /** `approve`/`reject`'s note, recorded with the review. */
  readonly note?: string;
  readonly limit?: number;
  readonly offset?: number;
  /** `list`: only what this chat taught (`--origin-task`). */
  readonly originTaskId?: string;
  /** `list`: what this chat's turns were given (`--used-in`). */
  readonly usedInTaskId?: string;
  /** `list`: every chat's notes (`--chat-notes`). */
  readonly chatNotes?: boolean;
  /** `list`: ended facts and expired preferences and lessons (`--past`). */
  readonly past?: boolean;
  /** `correct`: *Keep longer* — the record's new end date, or `null` for none (`--until <date|none>`). */
  readonly until?: string | null;
  /** `config`'s key, and the value to set it to. */
  readonly configKey?: MemoryConfigKey;
  readonly configValue?: string;
  /** `config`: the settings revision a write is held to (`--revision`); absent, the one just read. */
  readonly expectedRevision?: number;
  /** `config retrieval hybrid`: the disclosure of a remote embedding connection accepted (`--yes`); `set-provider` and `egress`'s too. */
  readonly confirmed?: boolean;
  /**
   * `config retrieval hybrid`: the embedding connection the accepted
   * disclosure named (`--yes=<connection>`): the owner accepts only while it
   * is still the one bound.
   */
  readonly confirmedConnection?: string;
  /**
   * `config retrieval hybrid`: personal memory embedded through a remote
   * connection too (`--include-personal`, after its own disclosure), or not
   * (without it). Absent for every other change.
   */
  readonly retrievalPersonal?: boolean;
  /** `set-provider`'s provider: an installed plugin's id, or `builtin`. */
  readonly providerId?: string;
  /** `egress`'s switch and whether it goes on. */
  readonly egressField?: MemoryEgressField;
  readonly egressOn?: boolean;
  /** `why`'s positional chat. */
  readonly chatTaskId?: string;
  /** `why`: the chat's turn to explain (`--turn`); absent, its newest. */
  readonly turn?: number;
  /** `reindex`: how long it may take in all, waiting out the embedding allowance (`--max-wait <seconds>`). */
  readonly maxWaitSeconds?: number;
  /** `consolidate-now`: only this person (`--principal`); absent, everyone with approved memory. */
  readonly forPrincipalId?: string;
  readonly format: OutputFormat;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
}

export const MEMORY_USAGE = `tavi memory <action> [options]

Inspect and edit personal memory, and review what the agent proposes.

While \`tavi serve\` runs, these commands go through it and act as the
workspace's operator: they see the operator's personal, workspace and agent
memory and the workspace's shared memory (another person's personal memory is
counted, never listed), and --principal applies only offline. \`export\` is
offline only. With no owner running they open the data directory directly.

Actions:
  list                     List records the principal can see (--past: ended
                           facts and expired preferences and lessons)
  proposals                List what the agent proposed and nobody reviewed yet
  review                   Decide each waiting proposal in turn: k keep, d discard,
                           e edit (then keep), s skip, q quit; shows its kind,
                           where it applies, its expiry and the chat it came from
  search <query>           Bounded lexical search with citations
  show <record-id>         Show one record
  remember                 Propose and approve exact content in one call
  correct <record-id>      Replace an approved value with a new revision;
                           --until moves its end date (Keep longer)
  approve <record-id>      Approve a proposal
  reject <record-id>       Reject a proposal; --note says why
  forget <record-id>       Erase a record; requires --reason
  move <record-id>         Move an approved record to the --scope given: a chat
                           note to every chat (personal), or back (chat:<task id>)
  why <chat-task-id>       The memories a chat's newest answer used (--turn <n>
                           for an earlier turn), each with its date, source chat
                           and id
  export                   Everything the principal may see, for inspection
  config [<key> [<value>]] Show the workspace's memory settings, or change one
                           (the workspace operator's; applies from the next
                           model call). Keys:
                             enabled               on, or off to pause memory:
                                                   nothing recalled or captured
                                                   anywhere; records are kept
                             capture               suggest (the model may
                                                   propose memory) or off (only
                                                   what you write yourself)
                             auto-approve          none, or a comma list of
                                                   preference, fact and lesson:
                                                   your own proposals of those
                                                   kinds are kept without
                                                   asking when the words are
                                                   ones you typed (not quoted,
                                                   code or pasted), and shown
                                                   Saved with Undo. Never a
                                                   sensitive, tainted,
                                                   messaging, worker or other
                                                   person's proposal, an
                                                   update, or a preference
                                                   keyed auth., payment.,
                                                   channel., exec. or
                                                   credential.
                             sensitive           skip (automatic capture
                                                   drops health, beliefs,
                                                   money and similar) or
                                                   suggest (filed masked)
                             retrieval             lexical, or hybrid: recall
                                                   by meaning too, through the
                                                   embedding model role (bind
                                                   one first); on a remote
                                                   connection it says what is
                                                   sent there and needs
                                                   --yes=<connection>, the one
                                                   it names. Your personal
                                                   memory (shared by all your
                                                   workspaces) is sent too only
                                                   with --include-personal,
                                                   which says so first; hybrid
                                                   without it stops sending it.
                                                   Other people's personal
                                                   memory never goes to a
                                                   remote connection
                             digest                weekly or off: the review
                                                   digest of waiting proposals
                             consolidation         off or weekly: tidy-up
                                                   suggestions (merge, replace,
                                                   end kept memories), filed as
                                                   proposals you decide
                             limits.contextTokens  2000-32000: budget for a
                                                   call's instructions and
                                                   memory together
                             limits.evidence       0-20: records recalled a call
                             limits.proposalDays   7-90: days a proposal waits
                             limits.maxRecords     10-20000: records a person may
                                                   keep (the byte quota follows)
                           "default" as the value clears a key.
  set-provider <id>|builtin
                           Choose the workspace's memory provider: an installed
                           plugin that provides memory, or the built-in. Says
                           what the provider does and needs --yes; its egress
                           starts off. One that stops running falls back to
                           the built-in, and doctor says so
  egress <records|conversation|personal> on|off
                           What the workspace's external memory provider may
                           receive: records (approved memories, never sensitive
                           ones), conversation (each recall's query and the
                           chat spans it drafts from) and personal (your
                           personal memory too, shared by all your workspaces;
                           only with records on). Turning one on says what it
                           sends and needs --yes; turning records or personal
                           off removes those records from its index
  reindex                  Run hybrid recall's vector backfill now, until
                           nothing is missing or nothing more can be embedded,
                           waiting out its 600-a-minute allowance (--max-wait
                           <seconds>, default 600; progress on stderr); then
                           prints indexed, missing and failed. Only with
                           retrieval hybrid
  review-now               Run the idle review now for every eligible chat
                           (--chat <task-id>: that one), without the 10-minute
                           idle wait; every other rule holds (three new
                           substantive messages, the daily cap, the marks).
                           Prints what each chat filed
  consolidate-now          Run consolidation now for each person (--principal:
                           that one), without the weekly 03:00 schedule; needs
                           consolidation weekly. Prints the tidy-ups filed

A proposal nobody approves or rejects within 30 days (memory config
limits.proposalDays) expires.

list/search/export default to every scope the principal is authorized to
read (personal, personal-workspace, and shared workspace memory when
granted); pass --scope to narrow to exactly one. A chat's notes are listed
only when named (--scope chat:<task id>, or --chat-notes for every chat's).
remember always writes to one concrete scope (default: personal), since a
write needs a single target: personal, workspace, agent:<agent id> or
chat:<task id> — shared memory is changed by an explicit share only.
A chat:<task id> scope, --origin-task, --used-in, --chat-notes, move, review
and why need a running owner.

Options:
  --workspace <id>         Workspace to act in (default: default)
  --principal <id>         Personal principal (default: operator);
                           consolidate-now: only this person
  --scope <scope>          personal, workspace, shared, agent:<agent id> or
                           chat:<task id>: narrow to one scope (default: every
                           authorized scope for reads); remember's target
                           (default: personal; not shared); move's destination
  --origin-task <task id>  list: only the records that chat wrote (what it taught)
  --used-in <task id>      list: the records that chat's turns were given, most
                           recent first
  --chat-notes             list: every chat's notes instead of the scopes
  --past                   list: Past — ended facts (kept) and expired
                           preferences and lessons (erased limits.proposalDays
                           after they expired), each with its date
  --until <date|none>      correct: Keep longer — a new end date (YYYY-MM-DD,
                           through that day, or a date-time), in the future;
                           none keeps it with no end. An expired record
                           returns to approved
  --kind <fact|preference|lesson|summary>  Record kind for remember (default: fact)
  --title <text>           Optional title
  --body <text>            Record body
  --key <text>             Preference key (kind=preference; remember only)
  --value <text>           Preference value, stored as a string (kind=preference for remember; correct changes an existing preference's value)
  --topic <text>           Topic key naming what this record is about (remember only, any kind; contradictory kind=fact records sharing one are flagged)
  --sensitive              Mark the record sensitive
  --reason <text>          Why (required for forget; recorded for remember/correct/move)
  --note <text>            Recorded with an approval or rejection
  --limit <n>               Page size for list/proposals/search (bounded)
  --offset <n>              Page offset for list/proposals
  --turn <n>                why: the chat's turn to explain (default: its newest)
  --max-wait <seconds>      reindex: how long it may take in all (default: 600)
  --chat <task-id>          review-now: only this chat
  --revision <n>            config: the settings revision a change is held to
                            (default: the one just read); a stale one is refused
  --format <text|json>      Output format (default: text; renders as JSON for show/remember/correct/forget)
  --data-dir <path>         Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help                Show this help
`;

/** Parse `tavi memory <action>`, the personal-memory surface. */
export function parseMemory(argv: readonly string[]): ParsedCommand {
  const [action, ...rest] = argv;
  // `--help` is a request for this page; a missing action is not success
  if (action === "-h" || action === "--help") return { command: "help", usage: MEMORY_USAGE };
  if (action === undefined) {
    throw new UsageError(`memory needs an action; expected one of ${MEMORY_ACTIONS.join(", ")}`, MEMORY_USAGE);
  }
  if (!(MEMORY_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`Unknown memory action ${JSON.stringify(action)}; expected one of ${MEMORY_ACTIONS.join(", ")}`, MEMORY_USAGE);
  }

  const allowedFlags: Readonly<Record<MemoryAction, readonly string[]>> = {
    list: [
      "--data-dir",
      "--workspace",
      "--principal",
      "--scope",
      "--kind",
      "--limit",
      "--offset",
      "--format",
      "--origin-task",
      "--used-in",
      "--chat-notes",
      "--past",
    ],
    proposals: ["--data-dir", "--workspace", "--principal", "--scope", "--kind", "--limit", "--offset", "--format"],
    review: ["--data-dir", "--workspace"],
    why: ["--data-dir", "--workspace", "--turn", "--format"],
    search: ["--data-dir", "--workspace", "--principal", "--scope", "--limit", "--format"],
    show: ["--data-dir", "--workspace", "--principal", "--format"],
    remember: [
      "--data-dir",
      "--workspace",
      "--principal",
      "--scope",
      "--kind",
      "--title",
      "--body",
      "--key",
      "--value",
      "--topic",
      "--sensitive",
      "--reason",
      "--format",
    ],
    correct: ["--data-dir", "--workspace", "--principal", "--title", "--body", "--value", "--until", "--reason", "--format"],
    approve: ["--data-dir", "--workspace", "--principal", "--note", "--format"],
    reject: ["--data-dir", "--workspace", "--principal", "--note", "--format"],
    forget: ["--data-dir", "--workspace", "--principal", "--reason", "--format"],
    move: ["--data-dir", "--workspace", "--principal", "--scope", "--reason", "--format"],
    export: ["--data-dir", "--workspace", "--principal", "--scope", "--format"],
    config: ["--data-dir", "--workspace", "--revision", "--format", "--yes", "--include-personal"],
    "set-provider": ["--data-dir", "--workspace", "--revision", "--format", "--yes"],
    egress: ["--data-dir", "--workspace", "--revision", "--format", "--yes"],
    reindex: ["--data-dir", "--workspace", "--format", "--max-wait"],
    "review-now": ["--data-dir", "--workspace", "--format", "--chat"],
    "consolidate-now": ["--data-dir", "--workspace", "--format", "--principal"],
  };
  const allowed = allowedFlags[action as MemoryAction];

  /** `config`, `set-provider` and `egress` take words (a key and a value); the rest at most one argument. */
  const takesWords = action === "config" || action === "set-provider" || action === "egress";
  // `--sensitive` has always been taken by every action; the other switches only where they apply.
  const switches = ["--sensitive", ...["--yes", "--chat-notes", "--past", "--include-personal"].filter((name) => allowed.includes(name))];
  if (action === "config" && rest.includes("--yes="))
    throw new UsageError("--yes= needs the connection its disclosure named: --yes=<connection>", MEMORY_USAGE);
  const args = parseFlags(rest, {
    usage: MEMORY_USAGE,
    valued: allowed,
    switches,
    unknown: (name) => `memory ${action} does not accept ${name}`,
    positional: (_token, taken) =>
      !takesWords && taken.length > 0 ? `memory ${action} accepts at most one positional argument` : undefined,
  });
  if (args === "help") return { command: "help", usage: MEMORY_USAGE };
  const flags = new Map(args.flags);
  for (const name of args.switches) flags.set(name, "true");
  // `config retrieval hybrid --yes=<connection>`: the connection whose disclosure was accepted.
  const yesConnection = args.flags.get("--yes");
  if (yesConnection !== undefined) {
    if (action !== "config") throw new UsageError(`memory ${action} takes --yes without a value`, MEMORY_USAGE);
    flags.set("--yes", "true");
    flags.set("--yes-connection", yesConnection);
  }
  const configWords = takesWords ? args.positionals : [];
  const positional = takesWords ? undefined : args.positionals[0];
  if (action === "config") return parseMemoryConfig(configWords, flags);
  if (action === "set-provider" || action === "egress") return parseMemoryProvider(action, configWords, flags);

  if (action === "why") return parseMemoryWhy(positional, flags);
  if (action === "reindex" || action === "review-now" || action === "consolidate-now") return parseMemoryJob(action, positional, flags);
  const needsRecordId =
    action === "show" || action === "correct" || action === "approve" || action === "reject" || action === "forget" || action === "move";
  if (needsRecordId && positional === undefined) {
    throw new UsageError(`memory ${action} needs a record id`, MEMORY_USAGE);
  }
  if (action === "search" && positional === undefined) {
    throw new UsageError("memory search needs a query", MEMORY_USAGE);
  }
  if (!needsRecordId && action !== "search" && positional !== undefined) {
    throw new UsageError(`memory ${action} does not take a positional argument`, MEMORY_USAGE);
  }
  if (action === "forget" && flags.get("--reason") === undefined) {
    throw new UsageError("memory forget needs --reason", MEMORY_USAGE);
  }
  if (action === "move" && flags.get("--scope") === undefined) {
    throw new UsageError("memory move needs --scope, the scope to move the record to", MEMORY_USAGE);
  }
  if (flags.get("--chat-notes") !== undefined && (flags.get("--scope") !== undefined || flags.get("--used-in") !== undefined)) {
    throw new UsageError("--chat-notes lists every chat's notes in place of --scope and --used-in", MEMORY_USAGE);
  }
  if (flags.get("--used-in") !== undefined && flags.get("--offset") !== undefined) {
    throw new UsageError("--used-in answers one page: it takes no --offset", MEMORY_USAGE);
  }
  if (flags.get("--past") !== undefined && (flags.get("--used-in") !== undefined || flags.get("--chat-notes") !== undefined)) {
    throw new UsageError("--past lists past records on their own, without --used-in or --chat-notes", MEMORY_USAGE);
  }

  const scope = flags.get("--scope");
  if (scope !== undefined && !MemoryScopeTargetSchema.safeParse(scope).success) {
    throw new UsageError(
      `Unknown scope ${JSON.stringify(scope)}; expected one of ${MEMORY_SCOPE_NAMES.join(", ")}, agent:<agent id> or chat:<task id>`,
      MEMORY_USAGE,
    );
  }
  if ((action === "remember" || action === "move") && scope === "shared") {
    throw new UsageError(
      `memory ${action} cannot write shared memory: it is changed by an explicit share only; expected ${MEMORY_REMEMBER_SCOPES}`,
      MEMORY_USAGE,
    );
  }
  const format = flags.get("--format");
  if (format !== undefined && format !== "text" && format !== "json") {
    throw new UsageError(`Unknown format ${JSON.stringify(format)}; expected text or json`, MEMORY_USAGE);
  }
  const limitFlag = flags.get("--limit");
  const offsetFlag = flags.get("--offset");
  const whole = (raw: string, name: string): number =>
    integerFlag(raw, { min: 0 }, `${name} must be a whole number (0 or more), received ${JSON.stringify(raw)}`, MEMORY_USAGE);
  const limit = limitFlag === undefined ? undefined : whole(limitFlag, "--limit");
  const offset = offsetFlag === undefined ? undefined : whole(offsetFlag, "--offset");

  const title = flags.get("--title");
  const preferenceKey = flags.get("--key");
  const preferenceValue = flags.get("--value");
  const topicKey = flags.get("--topic");
  const reason = flags.get("--reason");
  const note = flags.get("--note");
  const kind = flags.get("--kind");
  // A preference kept from its key and value alone reads as its value.
  const body =
    flags.get("--body") ?? (action === "correct" || (action === "remember" && kind === "preference") ? preferenceValue : undefined);
  const originTaskId = flags.get("--origin-task");
  const usedInTaskId = flags.get("--used-in");
  const until = flags.get("--until");

  // Checked here, so an owner and the offline path refuse in the same words and with the same exit code.
  if (action === "remember" || action === "correct") {
    for (const name of ["--body", "--value"]) {
      if (flags.get(name)?.trim() === "") throw new UsageError(`${name} can't be blank`, MEMORY_USAGE);
    }
  }
  if (action === "correct" && title === undefined && body === undefined && until === undefined) {
    throw new UsageError("A correction needs a new title, body, value or end date", MEMORY_USAGE);
  }
  if (action === "remember") {
    if (kind !== undefined && !(MEMORY_KINDS as readonly string[]).includes(kind)) {
      throw new UsageError(`--kind must be one of ${MEMORY_KINDS.join(", ")}`, MEMORY_USAGE);
    }
    if (kind !== "preference" && (preferenceKey !== undefined || preferenceValue !== undefined)) {
      throw new UsageError("--key/--value only apply to --kind preference", MEMORY_USAGE);
    }
    if (kind === "preference" && preferenceKey !== undefined && preferenceValue === undefined) {
      throw new UsageError("--value is required alongside --key for --kind preference", MEMORY_USAGE);
    }
  }

  const parsed: MemoryCommandOptions = {
    action: action as MemoryAction,
    workspaceId: flags.get("--workspace") ?? "default",
    principalId: flags.get("--principal") ?? "operator",
    format: (format as OutputFormat | undefined) ?? "text",
    ...(scope === undefined ? {} : { scope: scope as MemoryScopeName }),
    ...(needsRecordId && positional !== undefined ? { recordId: positional } : {}),
    ...(action === "search" && positional !== undefined ? { query: positional } : {}),
    ...definedOnly({
      kind,
      title,
      body,
      preferenceKey,
      preferenceValue,
      topicKey,
    }),
    ...(flags.get("--sensitive") === undefined ? {} : { sensitive: true }),
    ...(reason === undefined ? {} : { reason }),
    ...(note === undefined ? {} : { note }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
    ...(originTaskId === undefined ? {} : { originTaskId }),
    ...(usedInTaskId === undefined ? {} : { usedInTaskId }),
    ...(flags.get("--chat-notes") === undefined ? {} : { chatNotes: true }),
    ...(flags.get("--past") === undefined ? {} : { past: true }),
    ...(until === undefined ? {} : { until: until === "none" ? null : until }),
    ...dataDirectoryFlag(flags),
  };
  return { command: "memory", memory: parsed };
}

/** `tavi memory why <chat-task-id> [--turn <n>]`. */
function parseMemoryWhy(chatTaskId: string | undefined, flags: ReadonlyMap<string, string>): ParsedCommand {
  if (chatTaskId === undefined) throw new UsageError("memory why needs a chat's task id", MEMORY_USAGE);
  const turn = flags.get("--turn");
  if (turn !== undefined && !/^[1-9]\d{0,8}$/.test(turn)) throw new UsageError("--turn must be a turn number from 1", MEMORY_USAGE);
  const format = flags.get("--format");
  if (format !== undefined && format !== "text" && format !== "json") {
    throw new UsageError(`Unknown format ${JSON.stringify(format)}; expected text or json`, MEMORY_USAGE);
  }
  const parsed: MemoryCommandOptions = {
    action: "why",
    workspaceId: flags.get("--workspace") ?? "default",
    principalId: "operator",
    format: (format as OutputFormat | undefined) ?? "text",
    chatTaskId,
    ...(turn === undefined ? {} : { turn: Number(turn) }),
    ...dataDirectoryFlag(flags),
  };
  return { command: "memory", memory: parsed };
}

/** `tavi memory reindex | review-now | consolidate-now`: the memory host's background jobs, run now. */
function parseMemoryJob(
  action: "reindex" | "review-now" | "consolidate-now",
  positional: string | undefined,
  flags: ReadonlyMap<string, string>,
): ParsedCommand {
  if (positional !== undefined) throw new UsageError(`memory ${action} does not take a positional argument`, MEMORY_USAGE);
  const format = flags.get("--format");
  if (format !== undefined && format !== "text" && format !== "json") {
    throw new UsageError(`Unknown format ${JSON.stringify(format)}; expected text or json`, MEMORY_USAGE);
  }
  const maxWait = flags.get("--max-wait");
  if (maxWait !== undefined && !/^[1-9]\d{0,5}$/.test(maxWait))
    throw new UsageError("--max-wait must be a whole number of seconds from 1", MEMORY_USAGE);
  const chat = flags.get("--chat");
  const principal = flags.get("--principal");
  const parsed: MemoryCommandOptions = {
    action,
    workspaceId: flags.get("--workspace") ?? "default",
    principalId: "operator",
    format: (format as OutputFormat | undefined) ?? "text",
    ...(maxWait === undefined ? {} : { maxWaitSeconds: Number(maxWait) }),
    ...(chat === undefined ? {} : { chatTaskId: chat }),
    ...(principal === undefined ? {} : { forPrincipalId: principal }),
    ...dataDirectoryFlag(flags),
  };
  return { command: "memory", memory: parsed };
}

/** `tavi memory config [<key> [<value>]] [--revision <n>]`. */
function parseMemoryConfig(words: readonly string[], flags: ReadonlyMap<string, string>): ParsedCommand {
  const [key, value, ...extra] = words;
  if (extra.length > 0) throw new UsageError("memory config takes at most a key and a value", MEMORY_USAGE);
  if (key !== undefined && !(MEMORY_CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new UsageError(`Unknown memory setting ${JSON.stringify(key)}; expected one of ${MEMORY_CONFIG_KEYS.join(", ")}`, MEMORY_USAGE);
  }
  const revision = flags.get("--revision");
  if (revision !== undefined && (value === undefined || !/^\d{1,15}$/.test(revision))) {
    throw new UsageError(
      value === undefined
        ? "--revision applies only to a change: memory config <key> <value> --revision <n>"
        : "--revision must be a whole number",
      MEMORY_USAGE,
    );
  }
  const confirmedConnection = flags.get("--yes-connection");
  if (confirmedConnection !== undefined && (key !== "retrieval" || value !== "hybrid")) {
    throw new UsageError("--yes=<connection> goes only with memory config retrieval hybrid", MEMORY_USAGE);
  }
  const includePersonal = flags.get("--include-personal") === "true";
  if (includePersonal && (key !== "retrieval" || value !== "hybrid")) {
    throw new UsageError("--include-personal goes only with memory config retrieval hybrid", MEMORY_USAGE);
  }
  const format = flags.get("--format");
  if (format !== undefined && format !== "text" && format !== "json") {
    throw new UsageError(`Unknown format ${JSON.stringify(format)}; expected text or json`, MEMORY_USAGE);
  }
  const parsed: MemoryCommandOptions = {
    action: "config",
    workspaceId: flags.get("--workspace") ?? "default",
    principalId: "operator",
    format: (format as OutputFormat | undefined) ?? "text",
    ...(key === undefined ? {} : { configKey: key as MemoryConfigKey }),
    ...(value === undefined ? {} : { configValue: value }),
    ...(revision === undefined ? {} : { expectedRevision: Number(revision) }),
    // The disclosure hybrid recall on a remote embedding connection needs, accepted for the connection it named.
    ...(flags.get("--yes") === "true" ? { confirmed: true } : {}),
    ...(confirmedConnection === undefined ? {} : { confirmedConnection }),
    // `retrieval hybrid` says the whole choice: personal memory embedded through a remote connection too, or not.
    ...(key === "retrieval" && value === "hybrid" ? { retrievalPersonal: includePersonal } : {}),
    ...dataDirectoryFlag(flags),
  };
  return { command: "memory", memory: parsed };
}

/** `tavi memory set-provider <id>|builtin` and `tavi memory egress <records|conversation|personal> on|off`. */
function parseMemoryProvider(
  action: "set-provider" | "egress",
  words: readonly string[],
  flags: ReadonlyMap<string, string>,
): ParsedCommand {
  const revision = flags.get("--revision");
  if (revision !== undefined && !/^\d{1,15}$/.test(revision)) throw new UsageError("--revision must be a whole number", MEMORY_USAGE);
  const format = flags.get("--format");
  if (format !== undefined && format !== "text" && format !== "json") {
    throw new UsageError(`Unknown format ${JSON.stringify(format)}; expected text or json`, MEMORY_USAGE);
  }
  const common = {
    workspaceId: flags.get("--workspace") ?? "default",
    principalId: "operator",
    format: (format as OutputFormat | undefined) ?? "text",
    ...(revision === undefined ? {} : { expectedRevision: Number(revision) }),
    ...(flags.get("--yes") === "true" ? { confirmed: true } : {}),
    ...dataDirectoryFlag(flags),
  };
  if (action === "set-provider") {
    const [providerId] = words;
    if (words.length !== 1 || providerId === undefined)
      throw new UsageError("memory set-provider takes one provider id, or builtin", MEMORY_USAGE);
    return { command: "memory", memory: { action, ...common, providerId } };
  }
  const [field, onOff, ...extra] = words;
  if (!(MEMORY_EGRESS_FIELDS as readonly string[]).includes(field ?? "") || extra.length > 0) {
    throw new UsageError(`memory egress expects ${MEMORY_EGRESS_FIELDS.join(", ")}, then on or off`, MEMORY_USAGE);
  }
  if (onOff !== "on" && onOff !== "off")
    throw new UsageError(`memory egress ${field ?? ""} expects on or off, received ${JSON.stringify(onOff)}`, MEMORY_USAGE);
  return { command: "memory", memory: { action, ...common, egressField: field as MemoryEgressField, egressOn: onOff === "on" } };
}
