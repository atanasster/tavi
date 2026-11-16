import { DATA_DIR_DEFAULT_HELP } from "../../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, parseFlags } from "../../cli/argv.js";
import type { OutputFormat } from "../../cli/output.js";
import type { ParsedCommand } from "../../cli/parse.js";
import type { PdfServeOptions, VideoServeOptions } from "../../server/parse.js";
import type { FolderRetentionOptions } from "../folders/parse.js";

export interface RunCommandOptions {
  /** Internal provenance retained when target defaults are resolved. */
  readonly explicitModelSelection?: boolean;
  readonly explicitModelTarget?: { readonly connectionId?: string; readonly model?: string };
  readonly prompt: string;
  /**
   * `--attach <task-id>`: follow a task an owner is running, from its beginning,
   * instead of starting one. Needs a live owner; takes no prompt.
   */
  readonly attach?: string;
  /** `--home`: post the prompt into the person's Home rather than a run of its own; needs a live owner. */
  readonly home?: boolean;
  /**
   * `--folder <path>`: the new chat works in this host folder, under one of
   * the owner's `--fs-root` folders; needs a live owner. Without
   * it (and without `--managed`) the run sends this terminal's directory,
   * which the owner uses when it may.
   */
  readonly folder?: string;
  /** `--managed`: the new chat works in its own folder, whatever this terminal's directory. */
  readonly managed?: boolean;
  readonly format: OutputFormat;
  readonly workspaceId: string;
  readonly principalId: string;
  /**
   * Model target. Both are optional at the CLI boundary: when either is
   * omitted, `resolveModelTarget` (`cli/run-target.ts`) reads the workspace default
   * that `tavi models set-default` writes, and the connection's own
   * `base_url`/`credential_ref`, so the configured default takes effect
   * rather than the adapter being built from flags only.
   */
  readonly connectionId?: string;
  readonly model?: string;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
  /** `ask` prompts on a TTY, errors when non-interactive; `approve`/`deny` are explicit. */
  readonly approval: "ask" | "approve" | "deny";
  /**
   * Explicit credential binding for this invocation.
   *
   * A path, never a secret value: the file is read at resolve time. This is
   * deliberately an explicit binding, not an ambient `OPENAI_API_KEY` fallback.
   */
  readonly apiKeyFile?: string;
  /**
   * Run the transport retention sweep. Set only by `serve`:
   * a command that composes the runtime to read something must not
   * delete rows as a side effect.
   */
  readonly retentionSweepEnabled?: boolean;
  /**
   * Let the daemon's retention sweep delete non-report artifacts too.
   * Off by default: a report PDF is the deliverable and the rest of
   * the artifact store is the operator's to judge.
   */
  readonly retentionSweepArtifacts?: boolean;
  /**
   * The daemon's own log file, rotated by size. The
   * sink writes stderr as well, so the service manager's redirect keeps working;
   * this is the copy `tavi logs` can read back.
   */
  readonly logFile?: string;
  readonly logRotateBytes?: number;
  readonly logKeep?: number;
  /**
   * Operator-authored host allowlist for `http.request`.
   * Repeatable; hosts are exact (`api.stripe.com`) or suffix (`*.googleapis.com`).
   * An empty allowlist denies every host, so the tool fails closed.
   */
  readonly httpAllowHosts?: readonly string[];
  /** Folders a chat may use or attach (`serve --fs-root`); the file tools work in each chat's own folder with or without one. */
  readonly fsRoots?: readonly string[];
  /** Folders every chat's `sandbox.run` may read beside its own (`serve --sandbox-read`): absolute; never the data directory or a credential home. */
  readonly sandboxRead?: readonly string[];
  /** Domains every workspace's `sandbox.run` may reach (`serve --sandbox-domain`), in stored form; a tainted chat gets none. */
  readonly sandboxDomains?: readonly string[];
  /** `serve --sandbox-credential <VAR>=<ref>`: a credential `sandbox.run` may use as a placeholder in `VAR`, injected toward its `--http-credential-host` hosts. */
  readonly sandboxCredentials?: readonly string[];
  /** `serve --sandbox-nested`. */
  readonly sandboxNested?: boolean;
  /** `serve --sandbox-tier unavailable`, or `TAVI_SANDBOX=off`. */
  readonly sandboxPinnedOff?: boolean;
  /** `serve --sandbox-memory`, `--sandbox-pids`, `--sandbox-cpu`. */
  readonly sandboxLimits?: { readonly memoryBytes?: number; readonly processes?: number; readonly cpuPercent?: number };
  /** `serve --sandbox-timeout`, `--sandbox-max-timeout`, in ms. */
  readonly sandboxTimeouts?: { readonly defaultMs?: number; readonly maxMs?: number };
  /** `serve --sandbox-cache`. */
  readonly sandboxCache?: boolean;
  /** `serve --sandbox-parent-proxy`. */
  readonly sandboxParentProxy?: string;
  /** `serve --sandbox-inspect-tls`. */
  readonly sandboxInspectTls?: boolean;
  /** `serve --sandbox-pty`, `--sandbox-local-bind`. */
  readonly sandboxLocal?: { readonly pty?: boolean; readonly localBind?: boolean };
  /** `serve --video-ffmpeg`, `--video-ffprobe`, `--video-allow-unconfined`. */
  readonly video?: VideoServeOptions;
  /** `serve --pdf-allow-unconfined`. */
  readonly pdf?: PdfServeOptions;
  /** `serve --folder-cap`, `--chats-cap`, `--free-space-floor`; each absent is its default. */
  readonly folderRetention?: FolderRetentionOptions;
  /** Tools a chat-started task may use despite the messaging profile in the operator's own one-to-one chats (`serve --messaging-allow-tool`). */
  readonly messagingAllowTools?: readonly string[];
  /**
   * Gated tools that run without an approval round (repeatable). The same shape
   * a schedule's `--allow` has: named tool ids, never `*`. A `read-only` tool is
   * never gated, so naming one changes nothing.
   */
  readonly allowTools?: readonly string[];
  /**
   * Extra request headers the model may set on `http.request`, on top of the
   * built-in list (repeatable). A credential header is refused here; bind it with
   * `--http-credential-host` instead.
   */
  readonly httpRequestHeaders?: readonly string[];
  /**
   * Hosts `browser.navigate` may reach (repeatable; exact or `*.suffix`). Unset
   * denies every destination, because the URL is model-authored and the browser
   * tools have no other control on it.
   */
  readonly browserAllowHosts?: readonly string[];
  /**
   * Destinations `messaging.send_to` may address.
   * Repeatable; each entry is an exact provider conversation id (a Telegram
   * chat id, a Mailgun recipient). An empty allowlist denies every
   * destination, so an unattended run cannot be told where to send by a model.
   */
  readonly messagingAllowDestinations?: readonly string[];
  /**
   * Binds a credential reference to the hosts it may be sent to, as
   * `<reference>=<host>` (repeatable). A reference with no binding is refused by
   * `http.request`, so the model cannot pair an operator credential with an
   * arbitrary allowlisted host.
   */
  readonly httpCredentialHosts?: readonly string[];
  /** How long a round announced to a chat waits before it is rejected (`--approval-expiry`); 24 hours when absent. */
  readonly approvalExpiryMs?: number;
  /**
   * Caller idempotency key.
   *
   * Re-running with the same key resolves the same task and admission instead of
   * starting new work, so a retried command cannot duplicate side effects.
   */
  readonly operationKey?: string;
  readonly quiet: boolean;
  /** Disposable in-memory database; the spike never touches real operator data by default. */
  readonly inMemory: boolean;
  /** Deadline for the runtime's own cooperative disposal, when serving. */
  readonly shutdownDeadlineMs?: number;
}

/** What a run's folder flags take, under their usage errors: the reason stays on screen, not above the whole page. */
export const RUN_FOLDER_USAGE = `tavi run [--folder <path> | --managed] [options] <prompt>

A new chat works in --folder (under an owner's --fs-root) or, with --managed,
in its own folder. See \`tavi run --help\` for every option.
`;

export const RUN_USAGE = `tavi run [options] <prompt>
       tavi run --attach <task-id> [options]

Run one task, stream readable or JSON output, then exit.

With no owner running, the task runs in this process, and Ctrl-C aborts it.
Under a live \`tavi serve\` the task is dispatched to the owner and its stream
followed here: Ctrl-C then only detaches (exit 130; SIGTERM exits 143) and the
run continues; \`tavi run --attach <task-id>\` follows it again. --connection
and --model together make that model the chat's own, which the owner runs
whatever its default (one no configured connection offers is refused); either
alone asserts the owner's own target, and another is refused (exit 2). The
owner keeps its own tool policy: the tool-policy and credential flags
(--api-key-file, --http-*, --browser-allow-host and
--messaging-allow-destination) are refused (exit 2). --attach takes only --format,
--workspace, --principal, --data-dir and --quiet. A run is a chat of its own;
--home posts the prompt into your Home chat instead, as its next turn (needs a
live owner). Under an owner the run's chat works in this terminal's directory
when it lies under one of the owner's --fs-root folders (and is not your home
folder itself), else in its own folder, and a line says so; --folder names
another folder, --managed keeps it in its own.

Options:
  --format <text|json>     Output format (default: text)
  --workspace <id>         Workspace to act in (default: default)
  --principal <id>         Personal principal (default: operator)
  --connection <id>        Model provider connection id; defaults to the
                           workspace default set by tavi models set-default
  --model <id>             Model id; same default, else the connection's own
  --data-dir <path>        Data directory (${DATA_DIR_DEFAULT_HELP})
  --api-key-file <path>    File containing the provider key (explicit binding)
  --http-allow-host <host> Allow http.request and web_fetch to reach this host
                           (repeatable; exact or *.suffix). They ask no one, so
                           with none they are not offered at all.
  --http-request-header <name>
                           Let the model set this extra request header
                           (repeatable). Credential headers are refused here;
                           bind those with --http-credential-host.
  --browser-allow-host <host>
                           Let the browser open this host when nobody was asked
                           (repeatable; exact or *.suffix). A person who allows
                           the browser for a task lets it open any http(s) site.
  --http-credential-host <ref>=<host>
                           Bind a credential reference to a host it may be sent
                           to (repeatable). Unbound references are refused.
  --messaging-allow-destination <destination>
                           Allow messaging.send_to to address this destination
                           (repeatable): \`chatId\` for any connection,
                           \`connectionId:chatId\` for exactly one, \`*:chatId\`
                           for every connection, or \`providerId:*\` for anyone
                           on that channel. The bare form is honoured only
                           while a single messaging connection is configured. Omit to deny every
                           destination.
  --operation-key <key>    Idempotency key; a retry resolves the same task
                           (may not begin with schedule:, reminder: or home:,
                           which are reserved)
  --approval <mode>        ask | approve | deny (default: ask)
  --attach <task-id>       Follow a task a live owner is running, from its
                           beginning, instead of starting one
  --home                   Post the prompt into your Home chat as its next
                           turn (needs a live owner)
  --folder <path>          The chat works in this folder, under one of the
                           owner's --fs-root folders (needs a live owner)
  --managed                The chat works in its own folder, not this
                           terminal's directory
  --in-memory              Use a disposable in-memory database
  --quiet                  Suppress diagnostics on stderr
  -h, --help               Show this help
`;

export interface AbortCommandOptions {
  readonly taskId: string;
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
}

export const ABORT_USAGE = `tavi abort <task-id> [options]

Stop the turn a running \`tavi serve\` is running for a task; unlike cancel,
the task can still be resumed or replied to.

Distinct from \`tavi cancel\`: an abort ends the running turn (the task's status
becomes stopped) and records nothing on the ledger, so the task can be resumed
or replied to later; a cancellation is durable and final. A task with
no running turn — finished, or suspended on an approval, a review or a wait —
has nothing to abort (exit 8): cancel it instead. Needs a running owner; with
none, nothing is running to abort.

Options:
  --data-dir <path>     Data directory (${DATA_DIR_DEFAULT_HELP})
  -h, --help            Show this help
`;

/** Parse `tavi abort`, which signals a task's running turn under an owner. */
export function parseAbort(argv: readonly string[]): ParsedCommand {
  const args = parseFlags(argv, {
    usage: ABORT_USAGE,
    valued: ["--data-dir"],
    unknown: (name) => `abort does not accept ${name}`,
    positional: (_token, taken) => (taken.length > 0 ? "abort accepts exactly one task id" : undefined),
  });
  if (args === "help") return { command: "help", usage: ABORT_USAGE };
  const { flags } = args;
  const taskId = args.positionals[0];
  if (taskId === undefined) throw new UsageError("abort requires a task id", ABORT_USAGE);
  return { command: "abort", abort: { taskId, ...dataDirectoryFlag(flags) } };
}
