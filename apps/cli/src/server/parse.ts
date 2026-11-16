import { MESSAGING_PROFILE_TOOLS } from "../features/channels/profile.js";
import {
  parseByteSize,
  ToolIdSchema,
  STALE_WEB_PATTERN_MESSAGE,
  isStaleWebPattern,
  TAINT_MODES,
  type TaintMode,
  normalizeSandboxGrant,
  SANDBOX_DOMAINS_MAX,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { DATA_DIR_DEFAULT_HELP } from "../shared/data-directory.js";
import { UsageError, dataDirectoryFlag, integerFlag, parseFlags } from "../cli/argv.js";
import { requireBindingShape } from "../cli/parse-flags.js";
import type { ParsedCommand } from "../cli/parse.js";
import type { FolderRetentionOptions } from "../features/folders/parse.js";
import { readRootProblem } from "../features/sandbox/parse.js";
import { parentProxyProblem } from "../features/sandbox/parent-proxy.js";

/** How the video tools find and confine the person's FFmpeg (`serve --video-*`). */
export interface VideoServeOptions {
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  readonly allowUnconfined?: boolean;
}

/** How the PDF tools' children run where the sandbox is unavailable (`serve --pdf-allow-unconfined`). */
export interface PdfServeOptions {
  readonly allowUnconfined?: boolean;
}

export interface ServeCommandOptions {
  /** Raw `--data-dir`; `main.ts` applies the single resolution order. */
  readonly dataDirectory?: string;
  /** `--taint-policy`: the taint mode for every workspace, over each one's `security.taint`, for this owner's lifetime. */
  readonly taintPolicy?: TaintMode;
  /**
   * `--log-file` and the rotation knobs. Absent means the default,
   * `<data-dir>/logs/tavi.log`; `serveCommand` fills that in, so every daemon has
   * a log `tavi logs` can read.
   */
  readonly logFile?: string;
  readonly logRotateBytes?: number;
  readonly logKeep?: number;
  /** `--retention-sweep-artifacts`: also prune non-report artifacts. */
  readonly retentionSweepArtifacts?: boolean;
  /**
   * `--eval`: an owner for the memory eval and cache gate — no reminders,
   * heartbeats, schedule sweep, memory tick (digest, idle review, backfill,
   * consolidation) or messaging channels; the memory host's jobs run on demand.
   */
  readonly evalOwner?: boolean;
  readonly drainDeadlineMs: number;
  /**
   * Model target for tasks admitted by the daemon. Optional: falls back to the
   * configured workspace default, then to the historical `default` placeholders
   * when nothing is configured at all. `serve` still starts on the placeholder
   * path because it composes with `requireModelTransport: false`; a placeholder
   * target is simply not a usable one.
   */
  readonly connectionId?: string;
  readonly model?: string;
  readonly apiKeyFile?: string;
  /** Operator-authored host allowlist for `http.request`; see `RunCommandOptions.httpAllowHosts`. */
  readonly httpAllowHosts?: readonly string[];
  /** See `RunCommandOptions.fsRoots`. */
  readonly fsRoots?: readonly string[];
  /** See `RunCommandOptions.sandboxRead`. */
  readonly sandboxRead?: readonly string[];
  /** See `RunCommandOptions.sandboxDomains`. */
  readonly sandboxDomains?: readonly string[];
  /** See `RunCommandOptions.sandboxCredentials`. */
  readonly sandboxCredentials?: readonly string[];
  /** `--sandbox-nested`: srt's weaker nested mode is accepted. */
  readonly sandboxNested?: boolean;
  /** `--sandbox-tier unavailable`: sandbox.run is refused whatever the host could do. */
  readonly sandboxPinnedOff?: boolean;
  /** `--sandbox-memory`, `--sandbox-pids`, `--sandbox-cpu`: sandbox.run's caps. */
  readonly sandboxLimits?: { readonly memoryBytes?: number; readonly processes?: number; readonly cpuPercent?: number };
  /** `--sandbox-timeout`, `--sandbox-max-timeout`: sandbox.run's default run time and the longest a call may ask for, in ms. */
  readonly sandboxTimeouts?: { readonly defaultMs?: number; readonly maxMs?: number };
  /** `--sandbox-cache`: one package cache every chat's untainted shell shares. */
  readonly sandboxCache?: boolean;
  /** `--sandbox-parent-proxy <url>`: the proxy sandbox.run's granted connections leave through. */
  readonly sandboxParentProxy?: string;
  /** `--sandbox-inspect-tls`: every grant's TLS terminated, and a tunnel that carries none refused. */
  readonly sandboxInspectTls?: boolean;
  /** `--sandbox-pty`, `--sandbox-local-bind`: macOS capabilities a run gets only on the operator's say. */
  readonly sandboxLocal?: { readonly pty?: boolean; readonly localBind?: boolean };
  /** See `RunCommandOptions.video`. */
  readonly video?: VideoServeOptions;
  /** See `RunCommandOptions.pdf`. */
  readonly pdf?: PdfServeOptions;
  /** See `RunCommandOptions.folderRetention`. */
  readonly folderRetention?: FolderRetentionOptions;
  /** `--windowless` (Windows): start the owner again with no console window and wait for it; see `windowless.ts`. */
  readonly windowless?: boolean;
  /** `--dev-plugin`: plugin folders loaded unapproved for this run and reloaded on save; refused under a service. */
  readonly devPlugins?: readonly string[];
  /** See `RunCommandOptions.messagingAllowTools`. */
  readonly messagingAllowTools?: readonly string[];
  /** Gated tools every task under this owner may call unasked; see `RunCommandOptions.allowTools`. */
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
  /** Destinations `messaging.send_to` may address; see `RunCommandOptions.messagingAllowDestinations`. */
  readonly messagingAllowDestinations?: readonly string[];
  /** Credential-to-host bindings for `http.request`; see `RunCommandOptions.httpCredentialHosts`. */
  readonly httpCredentialHosts?: readonly string[];
  /** How long a round announced to a chat waits before it is rejected (`--approval-expiry`); 24 hours when absent. */
  readonly approvalExpiryMs?: number;
}

export const SERVE_USAGE = `tavi serve [options]

Start the owner: the background process that holds the data directory, runs
chats, channels, schedules and the heartbeat, and serves the other tavi
commands. SIGTERM stops it taking new work, lets running turns finish within a
deadline, then exits; restarting it is the service manager's job.

Options:
  --data-dir <path>        Data directory (${DATA_DIR_DEFAULT_HELP})
  --log-file <path>        Write the daemon's JSON log here as well as stderr,
                           rotated by size (default: <data-dir>/logs/tavi.log;
                           read it back with \`tavi logs\`)
  --log-rotate-bytes <n>   Rotate the log file at this size (default: 5242880)
  --log-keep <n>           How many rotated files to keep, 1-20 (default: 3)
  --retention-sweep-artifacts
                           Also let the six-hourly retention sweep delete
                           non-report artifacts (never a pending one, never a
                           report PDF). Off by default.
  --eval                   An owner for evaluation (evals/memory): no reminders,
                           heartbeats, schedules, memory tick (digest, idle
                           review, backfill, consolidation) or messaging
                           channels. The memory jobs run only on demand
                           (tavi memory reindex | review-now | consolidate-now).
                           Channel flags are refused with it.
  --windowless             Windows only: run with no console window, as the logon
                           task \`tavi service unit --kind task\` renders does
  --drain-deadline <ms>    Shutdown deadline for the runtime (default: 10000)
                           The owner exits non-zero if the drain does not finish.
  --connection <id>        Model provider connection id
  --model <id>             Model id
  --api-key-file <path>    File containing the provider key (explicit binding)
  --http-allow-host <host> Allow http.request and web_fetch to reach this host
                           (repeatable; exact or *.suffix). They ask no one, so
                           with none they are not offered at all.
  --allow <tool>           Let every task call this gated tool without an
                           approval round, e.g. --allow web_search (repeatable;
                           '*' is refused). Read-only tools never need it.
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
  --fs-root <path>         A folder a chat may use as its working folder or
                           attach (read-only unless asked); repeatable. The
                           file tools (fs.read, fs.list, fs.glob, fs.grep,
                           fs.write, fs.edit) always work in each chat's own
                           folder and its attached folders. None: every chat
                           works only in its own folder under the data
                           directory. Never / or a system folder
  --sandbox-read <path>    A folder every chat's sandbox.run may read (only
                           read) beside its own folders, for a toolchain or
                           data under $HOME the sandbox does not re-open;
                           repeatable. Never the data directory, a
                           credential directory, / or a system folder
  --sandbox-domain <pattern>
                           A domain every chat's sandbox.run may reach:
                           host, *.domain, either with :port (pypi.org,
                           *.pythonhosted.org, api.example.com:443), or
                           @registries for the package registries;
                           repeatable. Each run gets its own proxy; this
                           host, link-local and cloud metadata addresses stay
                           closed however spelled, a private network unless
                           granted by its dotted address, and a tainted chat
                           gets no network. Add per workspace with
                           tavi config set sandbox.domains
  --sandbox-credential <VAR>=<ref>
                           Let sandbox.run use a stored credential without
                           seeing it: the command reads a placeholder in VAR,
                           and its proxy puts the real value in the
                           Authorization header only toward the hosts
                           --http-credential-host binds <ref> to (exact
                           hosts; their TLS alone is decrypted, with a
                           30-day CA of this owner's); repeatable. A tainted
                           chat gets none
  --sandbox-nested         Accept srt's weaker nested mode, for a container
                           that masks /proc: PID and /proc isolation are given
                           up, and every sandbox.run result says so
  --sandbox-tier unavailable
                           Refuse sandbox.run whatever this host could do (the
                           rollout off switch; TAVI_SANDBOX=off does the same)
  --sandbox-memory <size>  sandbox.run's memory cap (default a quarter of the
                           host's memory, from 256M to 2G; Linux, where the
                           service's cgroup is delegated)
  --sandbox-pids <n>       sandbox.run's processes and threads (default 1024)
  --sandbox-cpu <percent>  sandbox.run's share of one core (default 200, capped
                           at the host's cores)
  --sandbox-cache          One npm and pnpm package cache per workspace, in
                           ~/.cache/tavi-sandbox, which its untainted chats'
                           sandbox.run share
  --sandbox-parent-proxy <url>
                           The proxy sandbox.run's granted connections leave
                           through (a corporate proxy); without it they dial
                           out directly, whatever HTTPS_PROXY says
                           (TAVI_SANDBOX_PARENT_PROXY does the same)
  --sandbox-inspect-tls    sandbox.run's proxy terminates TLS toward every
                           granted domain and refuses a connection it cannot
                           inspect (git over SSH, a raw TCP protocol), so a
                           request is judged by the host it names
  --sandbox-pty            macOS: let sandbox.run allocate pseudo-terminals
                           (script, expect, node-pty tests); it also opens your
                           own terminals' devices to the command
  --sandbox-local-bind     macOS: let sandbox.run listen for connections (test
                           servers, Unix sockets in its $TMPDIR): on every
                           interface, with HOST=127.0.0.1 set; it can then
                           reach this machine's own ports
  --sandbox-timeout <s>    How long a sandbox.run call runs when it asks for no
                           timeoutMs (default 120 seconds)
  --sandbox-max-timeout <s>
                           The longest timeoutMs a call may ask for (default
                           600 seconds)
  --video-ffmpeg <path>    The FFmpeg the video tools run (default: the first
  --video-ffprobe <path>   on PATH, then /opt/homebrew/bin, /usr/local/bin,
                           /usr/bin); Tavi ships none
  --video-allow-unconfined On Linux where the sandbox is unavailable, read
                           videos with FFmpeg unconfined (within its memory
                           and time caps) rather than refuse
  --pdf-allow-unconfined   Where the sandbox is unavailable, read PDFs with
                           the parser child unconfined (within its memory
                           and time caps) rather than refuse
  --folder-cap <size>      A chat's own folder's budget (default 2GB; K, M,
                           G, T are powers of 1024): past 80% the chat is
                           warned; at it, its .tmp/ is emptied, then writes
                           into it and new sandbox.run calls are refused (a
                           running command may overshoot)
  --chats-cap <size>       Every chat's folder together, the trash included
                           (default 20GB), as --folder-cap
  --free-space-floor <size>
                           Below this much free space on the data directory's
                           disk, file writes, copies and sends of a chat's
                           files and new sandbox.run calls are refused
                           (default 1GB; 0 turns it off)
  --dev-plugin <path>      A plugin folder to load for this run without
                           installing or approving it, reloaded after each
                           save and marked dev in tavi plugins list;
                           repeatable. Refused when the owner runs as a
                           service (tavi service)
  --messaging-allow-tool <tool-id>
                           A tool a chat-started task may use despite the
                           messaging profile (sandbox.run, fs.write, fs.edit,
                           plugins.validate, and http.request with a
                           credential are held back from one), in the
                           operator's own one-to-one chats only: never in a
                           group, a thread, an email thread or another
                           person's chat; repeatable
  --approval-expiry <hours>
                           How long an approval sent to a chat or email waits
                           before it is rejected (default 24; 0.25 to 720).
                           Approvals decided in a terminal or the web app
                           never expire
  --taint-policy <mode>    off, observe or enforce: how the approval gate
                           treats a call after untrusted content (a web page,
                           an email) entered the chat, in every workspace this
                           owner serves, over each one's security.taint (set
                           with tavi permissions taint) until the owner
                           restarts without it. Default: each workspace's own
                           setting, enforce unless changed
  -h, --help               Show this help

Platform: qualified on macOS and Linux only. On Windows the owner refuses to
start, because the named-pipe ACL is not provisioned or tested and no bearer
cookie may be released against an unqualified endpoint.
`;

/** A size flag of `serve`: `2GB`, `500M`, `1048576`; never 0 for a cap. */
function sizeFlag(flags: ReadonlyMap<string, string>, name: string, allowZero: boolean): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  const bytes = parseByteSize(raw);
  if (bytes === undefined || (!allowZero && bytes === 0))
    throw new UsageError(
      `${name} takes a size such as 2GB, 500M or a number of bytes${allowZero ? "" : ", more than 0"} (received ${JSON.stringify(raw)})`,
      SERVE_USAGE,
    );
  return bytes;
}

/**
 * A `serve --allow` value: one tool id, never a wildcard. Refused here, at parse
 * time, for the reason a schedule's `--allow '*'` is — it is easy to type
 * without meaning it, and under `serve` it would exempt every gated tool for
 * every task that ever runs.
 */
function requireAllowedToolId(value: string, usage: string): string {
  if (value === "*") throw new UsageError("--allow '*' is refused: name each tool, e.g. --allow web_search", usage);
  if (isStaleWebPattern(value)) throw new UsageError(`--allow ${JSON.stringify(value)} is refused: ${STALE_WEB_PATTERN_MESSAGE}`, usage);
  const parsed = ToolIdSchema.safeParse(value);
  if (!parsed.success) throw new UsageError(`--allow ${JSON.stringify(value)} is not a tool id (expected e.g. web_search)`, usage);
  return parsed.data;
}

export function parseServe(argv: readonly string[]): ParsedCommand {
  const serveLists = [
    "--http-allow-host",
    "--allow",
    "--http-request-header",
    "--browser-allow-host",
    "--messaging-allow-destination",
    "--fs-root",
    "--sandbox-read",
    "--sandbox-credential",
    "--sandbox-domain",
    "--dev-plugin",
    "--messaging-allow-tool",
    "--http-credential-host",
  ];
  const args = parseFlags(argv, {
    usage: SERVE_USAGE,
    valued: [
      "--api-key-file",
      "--approval-expiry",
      "--chats-cap",
      "--connection",
      "--data-dir",
      "--drain-deadline",
      "--folder-cap",
      "--free-space-floor",
      "--log-file",
      "--log-keep",
      "--log-rotate-bytes",
      "--model",
      "--sandbox-cpu",
      "--sandbox-max-timeout",
      "--sandbox-parent-proxy",
      "--sandbox-memory",
      "--sandbox-pids",
      "--sandbox-timeout",
      "--sandbox-tier",
      "--taint-policy",
      "--video-ffmpeg",
      "--video-ffprobe",
      ...serveLists,
    ],
    switches: [
      "--sandbox-nested",
      "--sandbox-cache",
      "--sandbox-inspect-tls",
      "--sandbox-pty",
      "--sandbox-local-bind",
      "--video-allow-unconfined",
      "--pdf-allow-unconfined",
      "--eval",
      "--retention-sweep-artifacts",
      "--windowless",
    ],
    lists: serveLists,
    unknown: (name) => `serve does not accept ${name}`,
    positional: (token) => `Unexpected argument ${token}`,
  });
  if (args === "help") return { command: "help", usage: SERVE_USAGE };
  const { flags } = args;
  const list = (name: string): readonly string[] => args.lists.get(name) ?? [];
  const sandboxNested = args.switches.has("--sandbox-nested");
  const videoAllowUnconfined = args.switches.has("--video-allow-unconfined");
  const pdfAllowUnconfined = args.switches.has("--pdf-allow-unconfined");
  const evalOwner = args.switches.has("--eval");
  const retentionSweepArtifacts = args.switches.has("--retention-sweep-artifacts");
  const httpAllowHosts = [...list("--http-allow-host")];
  const allowTools = list("--allow").map((value) => requireAllowedToolId(value, SERVE_USAGE));
  const httpRequestHeaders = [...list("--http-request-header")];
  const browserAllowHosts = [...list("--browser-allow-host")];
  const messagingAllowDestinations = [...list("--messaging-allow-destination")];
  const devPlugins = [...list("--dev-plugin")];
  const httpCredentialHosts = list("--http-credential-host").map((value) => requireBindingShape(value, SERVE_USAGE));
  const readRoots = (name: string): string[] =>
    list(name).map((value) => {
      const problem = readRootProblem(name, value);
      if (problem !== undefined) throw new UsageError(problem, SERVE_USAGE);
      return value;
    });
  const fsRoots = readRoots("--fs-root");
  const sandboxRead = readRoots("--sandbox-read");
  const sandboxCredentials: string[] = [];
  for (const value of list("--sandbox-credential")) {
    const [variable = "", reference = ""] = [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)];
    if (!value.includes("=") || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) || reference.trim() === "")
      throw new UsageError(`--sandbox-credential expects <VAR>=<credential-reference>, received ${JSON.stringify(value)}`, SERVE_USAGE);
    if (sandboxCredentials.some((entry) => entry.startsWith(`${variable}=`)))
      throw new UsageError(`--sandbox-credential names ${variable} twice`, SERVE_USAGE);
    sandboxCredentials.push(`${variable}=${reference.trim()}`);
  }
  const sandboxDomains: string[] = [];
  for (const value of list("--sandbox-domain")) {
    const domain = normalizeSandboxGrant(value);
    if (domain === undefined)
      throw new UsageError(
        `--sandbox-domain takes a host or *.domain, optionally with :port (never a bare *), or @registries, received ${JSON.stringify(value)}`,
        SERVE_USAGE,
      );
    if (!sandboxDomains.includes(domain)) sandboxDomains.push(domain);
    if (sandboxDomains.length > SANDBOX_DOMAINS_MAX)
      throw new UsageError(`--sandbox-domain is given at most ${String(SANDBOX_DOMAINS_MAX)} times`, SERVE_USAGE);
  }
  const messagingAllowTools = list("--messaging-allow-tool").map((value) => {
    const tool = requireAllowedToolId(value, SERVE_USAGE);
    // Only what the profile holds back can be let through; anything else
    // would be silently ignored, and the owner would think it did something.
    if (!MESSAGING_PROFILE_TOOLS.includes(tool)) {
      throw new UsageError(
        `--messaging-allow-tool takes one of ${MESSAGING_PROFILE_TOOLS.join(", ")}: the messaging profile holds back nothing else`,
        SERVE_USAGE,
      );
    }
    return tool;
  });
  const sandboxTier = flags.get("--sandbox-tier");
  // Only the off switch: `full` and `nested` are what the host is, never a request.
  if (sandboxTier !== undefined && sandboxTier !== "unavailable")
    throw new UsageError(
      `--sandbox-tier takes only "unavailable" (the off switch); the tier itself is what this host supports`,
      SERVE_USAGE,
    );
  const sandboxPinnedOff = sandboxTier !== undefined;
  // Absolute: a video run starts in its own directory, where a relative path names nothing.
  for (const name of ["--video-ffmpeg", "--video-ffprobe"]) {
    const value = flags.get(name);
    if (value !== undefined && !value.startsWith("/"))
      throw new UsageError(`${name} must be an absolute path, received ${JSON.stringify(value)}`, SERVE_USAGE);
  }
  const videoFfmpeg = flags.get("--video-ffmpeg");
  const videoFfprobe = flags.get("--video-ffprobe");

  const logFile = flags.get("--log-file");
  const logRotateRaw = flags.get("--log-rotate-bytes");
  const logRotateBytes =
    logRotateRaw === undefined
      ? undefined
      : integerFlag(logRotateRaw, { min: 1_024 }, "--log-rotate-bytes must be an integer of at least 1024", SERVE_USAGE);
  const logKeepRaw = flags.get("--log-keep");
  const logKeep =
    logKeepRaw === undefined
      ? undefined
      : integerFlag(logKeepRaw, { min: 1, max: 20 }, "--log-keep must be an integer between 1 and 20", SERVE_USAGE);

  const deadlineRaw = flags.get("--drain-deadline");
  const drainDeadlineMs =
    deadlineRaw === undefined
      ? 10_000
      : integerFlag(deadlineRaw, { min: 0 }, "--drain-deadline must be a non-negative integer", SERVE_USAGE);

  const apiKeyFile = flags.get("--api-key-file");
  const serveConnectionId = flags.get("--connection");
  const serveModel = flags.get("--model");
  const sandboxMemory = sizeFlag(flags, "--sandbox-memory", false);
  const count = (name: string, max: number): number | undefined => {
    const raw = flags.get(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new UsageError(`${name} takes a whole number from 1 to ${String(max)} (received ${JSON.stringify(raw)})`, SERVE_USAGE);
    return value;
  };
  const sandboxPids = count("--sandbox-pids", 65_536);
  const sandboxCpu = count("--sandbox-cpu", 6_400);
  const sandboxTimeoutSeconds = count("--sandbox-timeout", 86_400);
  const sandboxMaxTimeoutSeconds = count("--sandbox-max-timeout", 86_400);
  if (sandboxTimeoutSeconds !== undefined && sandboxTimeoutSeconds > (sandboxMaxTimeoutSeconds ?? 600))
    throw new UsageError("--sandbox-timeout cannot be longer than --sandbox-max-timeout (default 600)", SERVE_USAGE);
  const sandboxTimeouts = definedOnly({
    defaultMs: sandboxTimeoutSeconds === undefined ? undefined : sandboxTimeoutSeconds * 1_000,
    maxMs: sandboxMaxTimeoutSeconds === undefined ? undefined : sandboxMaxTimeoutSeconds * 1_000,
  });
  const parentProxyRaw = flags.get("--sandbox-parent-proxy");
  const proxyProblem = parentProxyRaw === undefined ? undefined : parentProxyProblem(parentProxyRaw);
  if (proxyProblem !== undefined) throw new UsageError(`--sandbox-parent-proxy ${proxyProblem}`, SERVE_USAGE);
  const sandboxParentProxy = parentProxyRaw;
  // srt does not yet send TLS it terminates through a parent proxy: inspected, every grant would go around it.
  if (sandboxParentProxy !== undefined && args.switches.has("--sandbox-inspect-tls"))
    throw new UsageError(
      "--sandbox-inspect-tls cannot be used with --sandbox-parent-proxy: the sandbox cannot yet send the connections it inspects through a parent proxy",
      SERVE_USAGE,
    );
  const sandboxLocal = {
    ...(args.switches.has("--sandbox-pty") ? { pty: true } : {}),
    ...(args.switches.has("--sandbox-local-bind") ? { localBind: true } : {}),
  };
  const sandboxLimits = {
    ...definedOnly({
      memoryBytes: sandboxMemory,
      processes: sandboxPids,
      cpuPercent: sandboxCpu,
    }),
  };
  const folderCapBytes = sizeFlag(flags, "--folder-cap", false);
  const chatsCapBytes = sizeFlag(flags, "--chats-cap", false);
  const freeSpaceFloorBytes = sizeFlag(flags, "--free-space-floor", true);
  const folderRetention = {
    ...definedOnly({
      folderCapBytes,
      chatsCapBytes,
      freeSpaceFloorBytes,
    }),
  };
  const taintPolicy = flags.get("--taint-policy");
  if (taintPolicy !== undefined && !(TAINT_MODES as readonly string[]).includes(taintPolicy)) {
    throw new UsageError(`--taint-policy must be one of ${TAINT_MODES.join(", ")}, received ${JSON.stringify(taintPolicy)}`, SERVE_USAGE);
  }
  const approvalExpiryRaw = flags.get("--approval-expiry");
  const approvalExpiryHours = approvalExpiryRaw === undefined ? undefined : Number(approvalExpiryRaw);
  if (
    approvalExpiryHours !== undefined &&
    (!Number.isFinite(approvalExpiryHours) || approvalExpiryHours < 0.25 || approvalExpiryHours > 720)
  ) {
    throw new UsageError("--approval-expiry must be a number of hours from 0.25 to 720", SERVE_USAGE);
  }
  return {
    command: "serve",
    serve: {
      ...dataDirectoryFlag(flags),
      ...definedOnly({
        logFile,
        logRotateBytes,
        logKeep,
      }),
      ...(retentionSweepArtifacts ? { retentionSweepArtifacts: true } : {}),
      ...(evalOwner ? { evalOwner: true } : {}),
      ...(args.switches.has("--windowless") ? { windowless: true } : {}),
      drainDeadlineMs,
      ...(serveConnectionId === undefined ? {} : { connectionId: serveConnectionId }),
      ...(serveModel === undefined ? {} : { model: serveModel }),
      ...(httpAllowHosts.length === 0 ? {} : { httpAllowHosts }),
      ...(allowTools.length === 0 ? {} : { allowTools }),
      ...(httpRequestHeaders.length === 0 ? {} : { httpRequestHeaders }),
      ...(browserAllowHosts.length === 0 ? {} : { browserAllowHosts }),
      ...(messagingAllowDestinations.length === 0 ? {} : { messagingAllowDestinations }),
      ...(fsRoots.length === 0 ? {} : { fsRoots }),
      ...(sandboxRead.length === 0 ? {} : { sandboxRead }),
      ...(sandboxDomains.length === 0 ? {} : { sandboxDomains }),
      ...(sandboxCredentials.length === 0 ? {} : { sandboxCredentials }),
      ...(sandboxNested ? { sandboxNested } : {}),
      ...(sandboxPinnedOff ? { sandboxPinnedOff } : {}),
      ...(Object.keys(sandboxLimits).length === 0 ? {} : { sandboxLimits }),
      ...(Object.keys(sandboxTimeouts).length === 0 ? {} : { sandboxTimeouts }),
      ...(sandboxParentProxy === undefined ? {} : { sandboxParentProxy }),
      ...(args.switches.has("--sandbox-cache") ? { sandboxCache: true } : {}),
      ...(args.switches.has("--sandbox-inspect-tls") ? { sandboxInspectTls: true } : {}),
      ...(sandboxLocal.pty === true || sandboxLocal.localBind === true ? { sandboxLocal } : {}),
      ...(videoFfmpeg === undefined && videoFfprobe === undefined && !videoAllowUnconfined
        ? {}
        : {
            video: {
              ...(videoFfmpeg === undefined ? {} : { ffmpeg: videoFfmpeg }),
              ...(videoFfprobe === undefined ? {} : { ffprobe: videoFfprobe }),
              ...(videoAllowUnconfined ? { allowUnconfined: true } : {}),
            },
          }),
      ...(pdfAllowUnconfined ? { pdf: { allowUnconfined: true } } : {}),
      ...(Object.keys(folderRetention).length === 0 ? {} : { folderRetention }),
      ...(devPlugins.length === 0 ? {} : { devPlugins }),
      ...(messagingAllowTools.length === 0 ? {} : { messagingAllowTools }),
      ...(httpCredentialHosts.length === 0 ? {} : { httpCredentialHosts }),
      ...(apiKeyFile === undefined ? {} : { apiKeyFile }),
      ...(approvalExpiryHours === undefined ? {} : { approvalExpiryMs: Math.round(approvalExpiryHours * 3_600_000) }),
      ...(taintPolicy === undefined ? {} : { taintPolicy: taintPolicy as TaintMode }),
    },
  };
}
