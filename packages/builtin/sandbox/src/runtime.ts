import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LIMITS_ENTRY_FAILED,
  LIMITS_ENTRY_FAILED_EXIT,
  TaviError,
  refusedEarly,
  sandboxConfines,
  type SandboxCapabilities,
  type SandboxHostPort,
  type ResourceLimitPort,
  type SandboxViolation,
  SANDBOX_REACHED_NETWORK_DETAIL,
  SANDBOX_REQUESTS_MAX,
  type SandboxRequest,
  type SandboxCommand,
  type SandboxPolicy,
  type SandboxPort,
  type SandboxRunResult,
  type SandboxSessionState,
  type SandboxStatus,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { signalGroup as signalChildGroup } from "@tavi/child-kit";
import { sleep } from "@tavi/node-kit";
import { LinuxSandboxProfileError, SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import { proxyCa, type ProxyCa } from "./ca.js";
import { unsupportedPlatformFailure } from "./host.js";
import { hostProcessPath, shellQuote, srtHelperConfig } from "./paths.js";
import { TAVI_BWRAP, srtHelpersDirectory } from "./srt-cli.js";
import { dialedHost, egressDenyLists, hostProcessEventOf, type HostProcessRequest } from "./egress.js";
import { compile, type CompileFs, type CompilePlatform } from "./policy-compile.js";

export { runtimeSharedWritePaths } from "./policy-compile.js";

/**
 * Real `SandboxPort` adapter over `@anthropic-ai/sandbox-runtime`:
 * Seatbelt on macOS, and on Linux bubblewrap with seccomp at the tier host
 * detection settled; `@anthropic-ai/sandbox-runtime`'s own Windows support
 * is alpha.
 *
 * **Injectable seams, mirroring `packages/agent-host/src/models/models.ts`'s
 * `fetch` option**: `manager` (a narrow subset of the real package's
 * `ISandboxManager` — `isSupportedPlatform`/`initialize`/`updateConfig`/
 * `wrapWithSandboxArgv`, the only four methods this adapter calls) and
 * `spawn` (Node's `child_process.spawn`) are both substitutable, so this
 * file's own unit tests never invoke the real library's actual OS-level
 * sandboxing or spawn a real process — the same discipline every other
 * real adapter in this codebase already follows. `SandboxManager` (the
 * real package's default export, a global singleton) satisfies the
 * narrow `manager` interface structurally and is the production default.
 *
 * **Test split**: `test/runtime.test.ts` unit-tests policy-mapping and
 * dispatch logic against a fake `manager`/`spawn`, so it runs anywhere.
 * `test/runtime.real.test.ts` (macOS-gated via `describe.skipIf`) runs
 * the real library against real Seatbelt enforcement on an actual macOS
 * host — this repository has no CI today, so it exists for whichever
 * macOS host happens to run the suite. A real macOS run (this one
 * included) is what caught the symlink-canonicalization bug `compile`
 * fixes below — the fake-manager suite alone could not have found it.
 *
 * Two real-library asymmetries were caught reading the installed
 * package's own source and, for the second, confirmed by a real macOS
 * run: `denyRead`/`allowRead` are not symmetric with `denyWrite`/
 * `allowWrite` (see `compile`'s own doc comment, `policy-compile.ts`); and Seatbelt's
 * path filters match the kernel-resolved (symlink-canonical) path, not
 * the caller's literal spelling (see `canonicalize`'s own doc comment) —
 * confirmed live: `denyPaths: ["/etc/hosts"]` silently failed to block
 * `cat /etc/hosts` until paths were canonicalized first.
 */

export interface SandboxRuntimeManager {
  isSupportedPlatform(): boolean;
  initialize(config: SandboxRuntimeConfig, askCallback?: undefined, enableLogMonitor?: boolean): Promise<void>;
  /** Releases a successful wrap's placeholders; once per wrap that did not throw. */
  cleanupAfterCommand(): void;
  getSandboxViolationStore?(): { getViolationsForCommand(command: string): readonly { readonly line: string }[] };
  getLinuxGlobPatternWarnings?(): string[];
  /** Stops srt's proxies and log monitor (shutdown). */
  reset?(): Promise<void>;
  updateConfig(config: SandboxRuntimeConfig): void;
  wrapWithSandboxArgv(
    command: string,
    binShell: string | undefined,
    customConfig: Partial<SandboxRuntimeConfig> | undefined,
    abortSignal: AbortSignal | undefined,
    cwd: string | undefined,
    options: { readonly commandId?: string } | undefined,
  ): Promise<{ readonly argv: string[]; readonly env: NodeJS.ProcessEnv }>;
}

export interface RuntimeSandboxOptions {
  readonly manager?: SandboxRuntimeManager;
  readonly spawn?: typeof spawn;
  /**
   * The proxy a run's granted connections leave through (`serve --sandbox-parent-proxy`), as a URL; absent, they
   * dial out directly, whatever proxy the owner's own environment names.
   */
  readonly parentProxy?: string;
  /**
   * `serve --sandbox-inspect-tls`: a run's proxy terminates TLS toward every
   * grant with the owner's CA, and refuses a tunnel it cannot inspect.
   */
  readonly inspectTls?: boolean;
  /** Reads the process table and the marker's holders for the macOS sweep (`sweepRun`); tests replace it. */
  readonly runLister?: RunLister;
  /** Where srt's Linux helpers (`socat`, `rg`) are; default `helperPath` (tests replace it). */
  readonly helperPath?: (name: string) => string | undefined;
  /** Overrides `process.platform` for `capabilities()` and the compile — test-only; production always reads the real platform. */
  readonly platform?: NodeJS.Platform;
  /** What the compiler reads of the filesystem (tests replace it). */
  readonly fs?: CompileFs;
  /**
   * Host detection: the tier `capabilities()` reports and `run()`
   * waits for. Without one, Linux is unavailable and macOS answers from the
   * runtime's own platform check, as before.
   */
  readonly host?: SandboxHostPort;
  /** `serve --sandbox-nested`: the weaker nested tier is accepted, and srt runs in that mode. */
  readonly nested?: boolean;
  /** `serve --sandbox-tier unavailable` / `TAVI_SANDBOX=off`: refused whatever the host could do. */
  readonly pinnedOff?: boolean;
  /**
   * The bubblewrap to run; by default `tavi sandbox setup`'s copy when it
   * exists, read at each run, so a host fixed (or set back) while the owner
   * runs needs no restart.
   */
  readonly bwrapPath?: string | (() => string | undefined);
  /** Where each run records the placeholders bubblewrap may leave (an owner-private directory), swept at start. */
  readonly stateDirectory?: string;
  /** How long an aborted run's process group has between `SIGTERM` and `SIGKILL`. */
  readonly killGraceMs?: number;
  /** Resource limits: each run in a cgroup of its own, entered before it runs; none by default. */
  readonly limits?: ResourceLimitPort;
  /** Where network runs keep their proxy's sockets; by default the service's or the session's runtime directory. */
  readonly runtimeDirectory?: string;
  /**
   * Where the CA that terminates TLS toward credential hosts lives: a
   * folder no policy lets a command read (the owner's data directory). One
   * CA per owner session, valid a day, minted at the first credentialed run
   * and again before it expires; older ones are removed. Without it a run
   * with credentials is refused.
   */
  readonly caDirectory?: string;
  /** Domains no grant reaches; paste and file-drop sites by default, each with why. */
  readonly deniedDomains?: readonly string[];
  /**
   * What the engine could not express here, each once:
   * srt's glob warnings at start, and an entry a run's compile dropped. Every
   * one is also in `capabilities().checks` (doctor) and the run's `warnings`.
   */
  readonly onWarning?: (message: string) => void;
}

export { DEFAULT_DENIED_DOMAINS } from "./egress.js";

/** The grace bubblewrap has to pass a `SIGTERM` on and exit before the group is killed. */
export const KILL_GRACE_MS = 500;
/**
 * `promise`, until `signal` aborts (rejecting with its reason) or, with
 * `limitMs`, until that long has passed (resolving `undefined`); whichever
 * ends it, its listener and timer are gone. The promise itself goes on.
 */
async function waitFor<T>(promise: Promise<T>, signal: AbortSignal, limitMs?: number): Promise<T | undefined> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
      ...(limitMs === undefined ? [] : [new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), limitMs)))]),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The owner's variables the srt host process gets: what finding programs, the locale and certificates need. */
const HOST_PROCESS_VARIABLES =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TERM|TZ|XDG_RUNTIME_DIR|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|SRT_DEBUG|SYSTEMROOT)$/;

/** The owner's environment for the srt host process: by name, never whole. */
export function hostProcessEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && HOST_PROCESS_VARIABLES.test(entry[0])),
  );
}

/** How long a run waits after its command exits for the streams a leftover process may hold. */
export const SETTLE_AFTER_EXIT_MS = 2_000;

/** The variable a run's processes carry on macOS, so whatever of a run outlives it can be found (`runSurvivors`). */
export const RUN_TAG = "TAVI_RUN";

/**
 * The processes that still carry a run's tag in their environment: of `ps`'s
 * listing with environments (`withEnvironment`, `ps -A -E -ww -o
 * pid=,command=`), the part past each process's command line as `ps` prints
 * it without (`plain`), so a word in a process's arguments never counts.
 * macOS prints no environment for its own binaries (`/bin/sh`, `sleep`): the
 * run's marker (`holdersOf`) finds those.
 */
export function runSurvivors(withEnvironment: string, plain: string, tag: string, self: number = process.pid): readonly number[] {
  const marker = `${RUN_TAG}=${tag}`;
  const commands = new Map<number, string>();
  for (const line of plain.split("\n")) {
    const match = /^\s*(\d+) (.*)$/.exec(line);
    if (match !== null) commands.set(Number(match[1]), match[2] ?? "");
  }
  const found: number[] = [];
  for (const line of withEnvironment.split("\n")) {
    const match = /^\s*(\d+) (.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const command = commands.get(pid);
    const full = match[2] ?? "";
    if (command === undefined || !full.startsWith(command)) continue;
    if (full.slice(command.length).split(/\s+/).includes(marker) && pid > 1 && pid !== self) found.push(pid);
  }
  return found;
}

/** What `lsof -t` names as holding a file open: one pid a line. */
export function holdersOf(lsofOutput: string, self: number = process.pid): readonly number[] {
  return lsofOutput
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== self);
}

/** How the macOS sweep reads the process table and who holds a run's marker. */
export interface RunLister {
  /** `ps`'s listing, with each process's environment or without. */
  readonly processes: (environment: boolean) => Promise<string>;
  /** `lsof -t -- <path>`: who holds the file open. */
  readonly holders: (path: string) => Promise<string>;
}

/**
 * Kills what of a run outlived it on macOS, where no cgroup or PID namespace
 * holds a detached process (`setsid`, a double fork): every process still
 * holding the run's marker open (an inherited descriptor every process of the
 * run gets), and every one still carrying its tag. Pass after pass, so one
 * that forked while the last was killed goes too. `false` when the process
 * table could not be read: the run then says so.
 */
async function sweepRun(tag: string, marker: string | undefined, lister: RunLister): Promise<boolean> {
  for (let pass = 0; pass < 4; pass += 1) {
    let survivors: readonly number[];
    try {
      const [withEnvironment, plain, held] = await Promise.all([
        lister.processes(true),
        lister.processes(false),
        marker === undefined ? Promise.resolve("") : lister.holders(marker),
      ]);
      survivors = [...new Set([...runSurvivors(withEnvironment, plain, tag), ...holdersOf(held)])];
    } catch {
      return false;
    }
    if (survivors.length === 0) return true;
    for (const pid of survivors) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, or not this user's.
      }
    }
    await sleep(50);
  }
  return true;
}

/** A run's warnings, when it has any. */
function warningsOf(warnings: readonly string[]): { readonly warnings?: readonly string[] } {
  return warnings.length === 0 ? {} : { warnings };
}

/** A run's marker on macOS: its tag, and a file every process of the run holds open. */
interface RunMarker {
  readonly tag: string;
  readonly path: string;
  readonly fd: number;
}

/** The warning of a run whose leftovers could not be looked for. */
const SWEEP_UNCHECKED = "could not check for processes the run left behind; one may still be running";

/** A run's marker, made for this run alone; `undefined` when no file could be made (the tag still finds most). */
function runMarker(tag: string, directory: string): RunMarker | undefined {
  const path = join(directory, `tavi-run-${tag}`);
  try {
    return { tag, path, fd: openSync(path, "wx", 0o600) };
  } catch {
    return undefined;
  }
}

/** Lets go of a run's marker: the owner's descriptor, then the file. */
function releaseMarker(marker: RunMarker | undefined): void {
  if (marker === undefined) return;
  try {
    closeSync(marker.fd);
  } catch {
    // Already closed.
  }
  rmSync(marker.path, { force: true });
}

/** The process table and `lsof`, as macOS has them. */
const darwinLister: RunLister = {
  processes: (environment) =>
    new Promise((resolve, reject) =>
      execFile(
        "ps",
        ["-A", ...(environment ? ["-E"] : []), "-ww", "-o", "pid=,command="],
        { maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
      ),
    ),
  // `lsof` exits 1 when nobody holds the file: that is an answer, not a failure.
  holders: (path) =>
    new Promise((resolve, reject) =>
      execFile("lsof", ["-t", "--", path], { maxBuffer: 1024 * 1024 }, (error, stdout) =>
        error === null || (error as { code?: unknown }).code === 1 ? resolve(stdout) : reject(error),
      ),
    ),
};

/** A refused host checked again before it refuses a run: once its failure is this old. */
export const RECHECK_AFTER_MS = 30_000;
/** How long a run waits for that check before it is refused on the old answer (the check goes on). */
export const RECHECK_WAIT_MS = 5_000;

/**
 * What bubblewrap leaves for an absent deny path: an empty, read-only,
 * singly linked regular file (srt makes it 0444), or an empty folder (made for
 * a path below it) — and, given `until`, one last changed no later than
 * then, so what a person made at the path after the run is left alone. Only
 * ever asked of a path a run recorded as absent before it started; never a
 * link.
 */
export function isStalePlaceholder(path: string, until?: number): boolean {
  try {
    const stat = lstatSync(path);
    if (until !== undefined && stat.ctimeMs > until) return false;
    if (stat.isFile()) return stat.size === 0 && (stat.mode & 0o222) === 0 && stat.nlink === 1;
    return stat.isDirectory() && readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/** A recorded placeholder: its path, and the time past which a change there is no run's. */
export interface PlaceholderRecord {
  readonly path: string;
  readonly until?: number;
}

/** Removes each recorded path that is still a placeholder, the deepest first, so a folder emptied by a path below it goes too. */
export function removePlaceholders(records: readonly PlaceholderRecord[]): void {
  // When each was last changed is read first: removing a path below a folder changes the folder's own.
  const unchanged = new Set(
    records.filter(({ path, until }) => {
      try {
        return until === undefined || lstatSync(path).ctimeMs <= until;
      } catch {
        return false;
      }
    }),
  );
  for (const { path } of [...unchanged].sort((a, b) => b.path.length - a.path.length)) {
    if (!isStalePlaceholder(path)) continue;
    try {
      if (lstatSync(path).isDirectory()) rmdirSync(path);
      else unlinkSync(path);
    } catch {
      // Gone, or no longer ours to remove.
    }
  }
}

/** One mount point an absent deny path needs: a folder for a path below it, else an empty read-only file. */
export interface Placeholder {
  readonly path: string;
  readonly kind: "file" | "directory";
}

/**
 * The mount points bubblewrap needs for the absent ones of `denies`, as srt
 * would make them: each missing component from the first absent one down, a
 * folder where another deny lies below it, else an empty read-only file.
 */
export function placeholdersFor(denies: readonly string[]): readonly Placeholder[] {
  const absent = denies.filter((path) => !existsSync(path));
  const below = (path: string): boolean => absent.some((other) => other.startsWith(`${path}/`));
  const out = new Map<string, Placeholder>();
  for (const deny of absent) {
    const first = firstAbsent(deny);
    for (let path = first; ; path = `${path}/${deny.slice(path.length + 1).split("/")[0] ?? ""}`) {
      out.set(path, { path, kind: path !== deny || below(path) ? "directory" : "file" });
      if (path === deny || path.length >= deny.length) break;
    }
  }
  return [...out.values()];
}

/** Makes each placeholder, shallowest first; one already there, or one that cannot be made (srt then refuses the run), is left. */
export function makePlaceholders(placeholders: readonly Placeholder[]): void {
  for (const { path, kind } of [...placeholders].sort((a, b) => a.path.length - b.path.length)) {
    try {
      if (kind === "directory") mkdirSync(path, { mode: 0o755 });
      else writeFileSync(path, "", { mode: 0o444, flag: "wx" });
    } catch {
      // There already, or not ours to make.
    }
  }
}

/** The first component of `path` that does not exist: where bubblewrap makes the placeholder for it (srt's `findFirstNonExistentComponent`). */
export function firstAbsent(path: string): string {
  let current = "";
  for (const part of path.split("/")) {
    if (part === "") continue;
    current = `${current}/${part}`;
    if (!existsSync(current)) return current;
  }
  return path;
}

/**
 * Removes what earlier runs recorded as possible placeholders and a killed
 * owner left behind: only a path a run's compiled policy named that still
 * passes srt's own test, so a person's own empty read-only file elsewhere is
 * never touched.
 */
export function sweepStalePlaceholders(stateDirectory: string): void {
  const directory = join(stateDirectory, "placeholders");
  let records: string[];
  try {
    records = readdirSync(directory);
  } catch {
    return;
  }
  // Every record's paths together, so a folder one recorded goes after a path inside it another recorded.
  const placeholders: PlaceholderRecord[] = [];
  const files: string[] = [];
  const held: string[] = [];
  for (const record of records) {
    const file = join(directory, record);
    // Another owner alive on this data directory still holds its own records.
    const owner = Number(/^(\d+)-/.exec(record)?.[1]);
    if (Number.isInteger(owner) && owner !== process.pid && processAlive(owner)) {
      held.push(...recordedPaths(file));
      continue;
    }
    files.push(file);
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      // A record from before `until` was kept: what changed after it was written is not the run's.
      const legacy = Array.isArray(parsed);
      const paths = legacy ? parsed : (parsed as { paths?: unknown }).paths;
      const until = legacy ? statSync(file).mtimeMs : (parsed as { until?: unknown }).until;
      if (Array.isArray(paths) && typeof until === "number")
        for (const path of paths) if (typeof path === "string") placeholders.push({ path, until });
    } catch {
      // A record half written when the owner died: nothing it names is trusted.
    }
  }
  // A path another live owner recorded too may be its run's mount point: left for it.
  removePlaceholders(placeholders.filter((placeholder) => !held.includes(placeholder.path)));
  for (const file of files) rmSync(file, { force: true });
}

/** The paths a record names; none when it cannot be read. */
function recordedPaths(file: string): readonly string[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const paths = Array.isArray(parsed) ? parsed : (parsed as { paths?: unknown }).paths;
    return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
  } catch {
    return [];
  }
}

/** What the orphaned-bridge sweep reads of this host's processes (tests replace it). */
export interface ProcessTable {
  readonly pids: () => readonly number[];
  /** A process's argv, parent, real uid and name; undefined when it is gone or unreadable. */
  readonly read: (
    pid: number,
  ) => { readonly argv: readonly string[]; readonly ppid: number; readonly uid: number; readonly comm: string } | undefined;
  readonly kill: (pid: number) => void;
}

/** Linux's `/proc`, as the sweep reads it. */
export const procProcessTable: ProcessTable = {
  pids: () => {
    try {
      return readdirSync("/proc")
        .filter((name) => /^\d+$/.test(name))
        .map(Number);
    } catch {
      return [];
    }
  },
  read: (pid) => {
    try {
      const status = readFileSync(`/proc/${String(pid)}/status`, "utf8");
      const argv = readFileSync(`/proc/${String(pid)}/cmdline`, "utf8")
        .split("\0")
        .filter((arg, index, all) => arg !== "" || index < all.length - 1);
      return {
        argv,
        ppid: Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? -1),
        uid: Number(/^Uid:\s*(\d+)/m.exec(status)?.[1] ?? -1),
        comm: readFileSync(`/proc/${String(pid)}/comm`, "utf8").trim(),
      };
    } catch {
      return undefined;
    }
  },
  kill: (pid) => {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Gone already.
    }
  },
};

/** srt's Linux network bridge, exactly as `initializeLinuxNetworkBridge` starts it: a socat from a `claude-http-`/`claude-socks-` socket to its proxy. */
const BRIDGE_LISTEN = /^UNIX-LISTEN:\/.*\/claude-(?:http|socks)-[0-9a-f]{16}\.sock,fork,reuseaddr$/;
const BRIDGE_CONNECT = /^TCP:localhost:\d+,keepalive,keepidle=10,keepintvl=5,keepcnt=3$/;

/**
 * Stops srt's network-bridge socat helpers that a killed owner (or srt host
 * process) left running: only this user's, only one whose argv is
 * srt's bridge exactly, and only one orphaned — its parent init or a
 * subreaper (`systemd --user`), never a live owner's or srt process's.
 * Returns the pids it stopped.
 */
export function sweepOrphanedBridges(
  table: ProcessTable = procProcessTable,
  uid: number | undefined = process.getuid?.(),
): readonly number[] {
  if (uid === undefined) return [];
  const stopped: number[] = [];
  for (const pid of table.pids()) {
    const entry = table.read(pid);
    if (entry === undefined || entry.uid !== uid || entry.comm !== "socat" || entry.argv.length !== 3) continue;
    if (!BRIDGE_LISTEN.test(entry.argv[1] ?? "") || !BRIDGE_CONNECT.test(entry.argv[2] ?? "")) continue;
    // Reparented: to init (unless this process is init, a container's, whose own children it would then be), or to a subreaper.
    const orphaned = (entry.ppid === 1 && process.pid !== 1) || table.read(entry.ppid)?.comm === "systemd";
    if (!orphaned) continue;
    table.kill(pid);
    stopped.push(pid);
  }
  return stopped;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A violation line (`deny file-write-create /path`, `deny network-outbound host:443 (...)`) as a kind and target.
 * A refused sysctl read is none: Seatbelt files one as many tools start (git reads `kern.iossupportversion`),
 * it stops nothing, and reporting it made a plain `git log` look refused.
 */
export function violationOf(line: string): SandboxViolation | undefined {
  const match = /\bdeny(?:\(\d+\))?\s+([a-z-]+)\s+(\S+)/.exec(line);
  if (match === null) return undefined;
  const [, operation = "", target = ""] = match;
  // A refused read of the system's own facts stops nothing: a sysctl read, or system-info (`vfs.disk-space`, which git
  // and Python ask for as they start).
  if (operation === "sysctl-read" || operation === "system-info") return undefined;
  const kind = operation.startsWith("file-read")
    ? "read"
    : operation.startsWith("file-write")
      ? "write"
      : operation.startsWith("network")
        ? "network"
        : "socket";
  return { kind, target };
}

/** A profile bubblewrap cannot run: what the caller passed (too long, a NUL) or what the host allows. */
function profileRefusal(profileError: string, message: string): TaviError {
  const code = profileError === "command_too_long" || profileError === "nul_in_path" ? "INVALID_INPUT" : "UNAVAILABLE";
  return new TaviError(code, `the sandbox could not run this command: ${message}`, { details: { profileError } });
}

/** srt's violation line for a name the address guard would not dial: `deny network-outbound host:port (resolved to …)`. */
const ADDRESS_REFUSAL = /\(resolve[sd] to /;

/**
 * A network run's audit: each host and port once, at most
 * `SANDBOX_REQUESTS_MAX` of them, with how often it was asked, whether
 * every attempt got through, and how many did. srt records each refusal as a
 * violation, the grants' own and the deny list's and the address guard's
 * alike, so a host's count is the larger of its grant decisions and its
 * refusals. The address guard refuses after the grants said yes, so a request
 * it refused is taken off the granted ones: it never reached the network.
 */
function requestAudit() {
  type Entry = {
    readonly host: string;
    readonly port: number;
    asked: number;
    denied: number;
    refused: number;
    /** Refusals by the address guard, each after a grant: what it resolved to may not be dialled. */
    addressRefused: number;
    readonly credentials: Set<string>;
  };
  const entries = new Map<string, Entry>();
  let dropped = false;
  /** How many requests to it got through. */
  const allowedCount = (entry: Entry): number => Math.max(0, entry.asked - entry.denied - entry.addressRefused);
  /** An entry that only records refusals, which a request that got through may take the place of. */
  const refusedOnly = (entry: Entry): boolean => allowedCount(entry) === 0 && entry.credentials.size === 0;
  // Past the cap a refused host is dropped, and one that got through (or was given a credential) takes the oldest refused
  // entry's place: a flood of refused names never hides a host the command reached.
  const entry = (host: string, port: number, reached: boolean) => {
    const key = `${host}:${String(port)}`;
    const known = entries.get(key);
    if (known !== undefined) return known;
    if (entries.size >= SANDBOX_REQUESTS_MAX) {
      dropped = true;
      const evicted = reached ? [...entries].find(([, candidate]) => refusedOnly(candidate)) : undefined;
      if (evicted === undefined) return undefined;
      entries.delete(evicted[0]);
    }
    const added: Entry = { host, port, asked: 0, denied: 0, refused: 0, addressRefused: 0, credentials: new Set<string>() };
    entries.set(key, added);
    return added;
  };
  return {
    /** A decision by the run's grants. */
    record(host: string, port: number, allowed: boolean): void {
      const found = entry(host, port, allowed);
      if (found === undefined) return;
      found.asked += 1;
      if (!allowed) found.denied += 1;
    },
    /** Credentials the proxy put into a request to this host and port. */
    inject(host: string, port: number, credentials: readonly string[]): void {
      const found = entry(host, port, true);
      for (const name of credentials) found?.credentials.add(name);
    },
    /** A refusal srt recorded; `address` when the address guard made it, after the grants let the request through. */
    refuse(host: string, port: number, address: boolean): void {
      const found = entry(host, port, false);
      if (found === undefined) return;
      found.refused += 1;
      if (address) found.addressRefused += 1;
    },
    requests: (): readonly SandboxRequest[] =>
      [...entries.values()].map((found) => ({
        host: found.host,
        port: found.port,
        allowed: found.denied === 0 && found.refused === 0,
        count: Math.max(found.asked, found.refused),
        allowedCount: allowedCount(found),
        ...(found.credentials.size === 0 ? {} : { credentials: [...found.credentials] }),
      })),
    truncated: (): boolean => dropped,
  };
}

interface SessionRecord {
  state: SandboxSessionState;
  readonly controller: AbortController;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The deny-everything base `initialize()` gets; every run brings its own filesystem config, and a run granted the network its own srt. */
const BASE_CONFIG: SandboxRuntimeConfig = {
  network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
  filesystem: { denyRead: ["/"], allowRead: [], allowWrite: [], denyWrite: ["/"] },
};

/**
 * How many adapters have initialized each manager and not yet closed: srt's
 * manager is a process-wide singleton, and its `reset()` unmounts every run's
 * placeholders and drops its config, so only the last adapter to close resets
 * it.
 */
const openAdapters = new WeakMap<SandboxRuntimeManager, number>();

/**
 * Run ids, counted per process: srt files violations under a wrap's
 * `commandId` in one store for the whole process, so two engines (the
 * owner's and a command's own) never share an id.
 */
let runCounter = 0;
/**
 * Runs of this process under way, whatever engine started them: bubblewrap's
 * placeholders are shared, and one unlinked while another run has a mount on
 * it would detach that run's bind.
 */
let activeRuns = 0;

/** How many distinct warnings an engine keeps for `capabilities()`. */
const WARNINGS_KEPT = 32;

/**
 * The inner shell line the runtime wraps. With `inheritEnv: false` every
 * variable of `command.env` is assigned here, inside the sandbox, as the
 * line's prefix — so the command sees exactly the environment the caller
 * built, whatever the runtime's own `env` wrapper sets around it (it sets
 * TMPDIR to its default scratch path, overriding one passed to `spawn`:
 * `generateProxyEnvVars` in the installed library). Otherwise only a TMPDIR
 * the caller sets is, for the same reason.
 */
function renderShellCommand(command: SandboxCommand): string {
  const line = [command.command, ...(command.args ?? [])].map(shellQuote).join(" ");
  const entries =
    command.inheritEnv === false
      ? Object.entries(command.env ?? {})
      : Object.entries(command.env ?? {}).filter(([name]) => name === "TMPDIR");
  const malformed = entries.find(([name]) => !ENV_NAME.test(name));
  if (malformed !== undefined)
    throw new TaviError("INVALID_INPUT", `sandbox environment variable name is not an identifier: ${malformed[0]}`);
  return entries.length === 0 ? line : `${entries.map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ")} ${line}`;
}

interface RunProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** Byte-accurate output bounding straight off the real Buffer stream — see `@tavi/plugin-sandbox`'s fixture on why char-slicing a string overshoots for non-ASCII content; slicing bytes before decoding avoids that entirely. */
function runProcess(
  spawnImpl: typeof spawn,
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string | undefined;
    readonly env: NodeJS.ProcessEnv;
    readonly signal: AbortSignal;
    readonly maxOutputBytes: number;
    readonly killGraceMs: number;
    readonly killGroup?: () => void;
    /** A JSON-lines channel on fd 3 (the srt host process): the request written, each line read back. */
    readonly control?: { readonly request: string; readonly onLine: (line: string) => void };
    /** The command's standard input (`SandboxCommand.stdin`); absent, it reads end-of-file at once. */
    readonly stdin?: string;
    /** An open descriptor every process of the run inherits (the run's marker, macOS): fd 3, or fd 4 after `control`. */
    readonly marker?: number;
    /**
     * Run once it has ended: what else of the run is still alive goes (macOS, which has no cgroup to end it).
     * `false` when it could not tell.
     */
    readonly sweep?: () => Promise<boolean>;
  },
): Promise<RunProcessResult & { readonly swept?: boolean }> {
  return new Promise((resolve, reject) => {
    // Its own process group, so an abort reaches every process the wrapper
    // started (the shell, `sandbox-exec` and the command it runs), not only
    // the outer shell the `signal` option would kill.
    // The abort is the ladder's (below), not `spawn`'s own `signal`, which would SIGTERM the wrapper alone.
    const child = spawnImpl(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      // The srt host process passes its own stdin on to the command (`host-process.ts`).
      ...(options.control === undefined
        ? options.marker === undefined
          ? {}
          : { stdio: ["pipe", "pipe", "pipe", options.marker] }
        : {
            stdio: [
              options.stdin === undefined ? "ignore" : "pipe",
              "pipe",
              "pipe",
              "pipe",
              ...(options.marker === undefined ? [] : [options.marker]),
            ],
          }),
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
    if (child.stdin !== null && child.stdin !== undefined) {
      // A command that exits without reading all of it closes the pipe: that is its business, not a failure.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin ?? "");
    }
    if (options.control !== undefined) {
      const channel = child.stdio[3] as import("node:stream").Duplex | null | undefined;
      if (channel !== null && channel !== undefined) {
        const { onLine } = options.control;
        let pending = "";
        channel.on("data", (chunk: Buffer) => {
          pending += chunk.toString("utf8");
          for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
            onLine(pending.slice(0, at));
            pending = pending.slice(at + 1);
          }
        });
        channel.on("error", () => undefined);
        channel.write(`${options.control.request}\n`);
      }
    }
    // The run's process group, through the one ladder every child Tavi starts shares (`@tavi/child-kit`).
    const signalGroup = (signal: NodeJS.Signals): void => signalChildGroup(child, signal);
    // The ladder's last rung: the run's cgroup where there is one (no setsid outruns it), and its process group.
    const killGroup = (): void => {
      options.killGroup?.();
      signalGroup("SIGKILL");
    };
    let escalation: NodeJS.Timeout | undefined;
    // The cancellation ladder: SIGTERM to the group, a grace for bubblewrap to pass it on and exit, then SIGKILL.
    const abortLadder = (): void => {
      signalGroup("SIGTERM");
      escalation = setTimeout(killGroup, options.killGraceMs);
      escalation.unref();
    };
    if (options.signal.aborted) abortLadder();
    else options.signal.addEventListener("abort", abortLadder, { once: true });
    const stdout = outputCollector(options.maxOutputBytes);
    const stderr = outputCollector(options.maxOutputBytes);

    child.stdout?.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.once("error", (error) => {
      options.signal.removeEventListener("abort", abortLadder);
      clearTimeout(escalation);
      reject(error);
    });
    // A process the command left behind (`setsid`, `nohup … &`) may hold its output open, and then `close` never
    // comes: a while after the command exits its streams are let go, so the run ends with it.
    let settle: NodeJS.Timeout | undefined;
    child.once("exit", () => {
      settle = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, SETTLE_AFTER_EXIT_MS);
      settle.unref();
    });
    child.once("close", (exitCode) => {
      options.signal.removeEventListener("abort", abortLadder);
      clearTimeout(escalation);
      clearTimeout(settle);
      // Whatever the command left running in its group goes too, so nothing
      // of this run outlives it into the next run's network allowlist.
      killGroup();
      const ended = {
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.dropped() > 0 || stderr.dropped() > 0,
      };
      if (options.sweep === undefined) resolve(ended);
      else void options.sweep().then((swept) => resolve({ ...ended, swept }));
    });
  });
}

/**
 * One output stream kept to `maxBytes`: its first half and its last half, with
 * how much was left out between them. A long run's useful part is often its end
 * (a test's failure, a build's error), which keeping only the head would lose.
 */
export function outputCollector(maxBytes: number): {
  add(data: Buffer): void;
  text(): string;
  dropped(): number;
} {
  const headLimit = Math.ceil(maxBytes / 2);
  const tailLimit = maxBytes - headLimit;
  const head: Buffer[] = [];
  let headBytes = 0;
  let tail: Buffer[] = [];
  let tailBytes = 0;
  let total = 0;
  return {
    add(data: Buffer): void {
      total += data.byteLength;
      let rest = data;
      if (headBytes < headLimit) {
        const taken = rest.subarray(0, headLimit - headBytes);
        head.push(taken);
        headBytes += taken.byteLength;
        rest = rest.subarray(taken.byteLength);
      }
      if (rest.byteLength === 0 || tailLimit === 0) return;
      tail.push(rest);
      tailBytes += rest.byteLength;
      if (tailBytes > tailLimit * 2) {
        const kept = Buffer.concat(tail).subarray(tailBytes - tailLimit);
        tail = [kept];
        tailBytes = kept.byteLength;
      }
    },
    text(): string {
      const headBuffer = Buffer.concat(head);
      const tailBuffer = Buffer.concat(tail);
      // Nothing left out: one buffer, decoded once, so a character across the halves stays whole.
      if (total <= maxBytes) return Buffer.concat([headBuffer, tailBuffer]).toString("utf8");
      // Each cut edge is moved to a character's boundary, and what that drops is counted as left out.
      const headKept = headBuffer.subarray(0, utf8Prefix(headBuffer));
      const tailStart = tailBuffer.byteLength - tailLimit;
      const tailKept = tailBuffer.subarray(Math.max(0, tailStart) + utf8Continuations(tailBuffer, Math.max(0, tailStart)));
      const left = total - headKept.byteLength - tailKept.byteLength;
      return `${headKept.toString("utf8")}\n…[${left} bytes left out]…\n${tailKept.toString("utf8")}`;
    },
    dropped(): number {
      return Math.max(0, total - headBytes - Math.min(tailBytes, tailLimit));
    },
  };
}

/** How many of `bytes`' leading bytes end on a character's boundary: without a last character it cut off. */
function utf8Prefix(bytes: Buffer): number {
  let end = bytes.byteLength;
  let back = 0;
  // Step back over continuation bytes to the last lead byte, and drop it if its character is not whole.
  while (back < 3 && end - back - 1 >= 0 && ((bytes[end - back - 1] as number) & 0xc0) === 0x80) back += 1;
  const leadAt = end - back - 1;
  if (leadAt < 0) return end - back;
  const lead = bytes[leadAt] as number;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (back + 1 < length) end = leadAt;
  return end;
}

/** How many continuation bytes `bytes` holds from `from`: the rest of a character cut off before it. */
function utf8Continuations(bytes: Buffer, from: number): number {
  let count = 0;
  while (count < 3 && from + count < bytes.byteLength && ((bytes[from + count] as number) & 0xc0) === 0x80) count += 1;
  return count;
}

/** Node's warning that `NODE_USE_ENV_PROXY`'s agent is experimental, silenced after the command's own `NODE_OPTIONS`. */
const QUIET_PROXY_AGENT = "--disable-warning=UNDICI-EHPA";

function withQuietProxyAgent(nodeOptions: string | undefined): string {
  return nodeOptions === undefined || nodeOptions.trim() === "" ? QUIET_PROXY_AGENT : `${nodeOptions} ${QUIET_PROXY_AGENT}`;
}

/** The pinned refusal, and the detail every refusal while it holds carries. */
const PINNED_OFF = "the operator pinned the sandbox off (serve --sandbox-tier unavailable, or TAVI_SANDBOX=off)";

export function createRuntimeSandbox(options: RuntimeSandboxOptions = {}): SandboxPort {
  const manager = options.manager ?? SandboxManager;
  const spawnImpl = options.spawn ?? spawn;
  const sessions = new Map<string, SessionRecord>();
  const running = new Set<Promise<unknown>>();
  let closed = false;
  let initialization: Promise<void> | undefined;
  const platform = options.platform ?? process.platform;
  const compilePlatform: CompilePlatform = platform === "linux" ? "linux" : "darwin";
  const mechanism = platform === "darwin" ? ("seatbelt" as const) : platform === "linux" ? ("bubblewrap" as const) : undefined;
  const platforms = ["darwin", "linux"];
  /** The bubblewrap a run goes through, read now: `tavi sandbox setup --apply` (or `--remove`) while the owner runs is taken at the next run. */
  const bwrapPathNow = (): string | undefined => {
    if (typeof options.bwrapPath === "string") return options.bwrapPath;
    if (options.bwrapPath !== undefined) return options.bwrapPath();
    return platform === "linux" && existsSync(TAVI_BWRAP) ? TAVI_BWRAP : undefined;
  };
  if (options.stateDirectory !== undefined) {
    sweepStalePlaceholders(options.stateDirectory);
    if (platform === "linux") sweepOrphanedBridges();
  }
  /** Each distinct warning once: logged, and kept for `capabilities()`. */
  const warnings = new Set<string>();
  const warn = (message: string): void => {
    if (warnings.has(message)) return;
    if (warnings.size < WARNINGS_KEPT) warnings.add(message);
    options.onWarning?.(message);
  };

  /** Whether each limit is held here, for `capabilities()`. */
  function limitsOf(): Pick<SandboxCapabilities, "limits"> {
    if (options.limits === undefined)
      return { limits: { memory: platform === "darwin" ? "advisory" : "unavailable", pids: "unavailable", cpu: "unavailable" } };
    const { memory, pids, cpu } = options.limits.capabilities();
    return { limits: { memory, pids, cpu } };
  }

  /** What the host's tier allows, synchronously; `checking` lets a run through to `run()`, which waits for the answer. */
  function capabilities(settled?: SandboxStatus): SandboxCapabilities {
    const withMechanism = mechanism === undefined ? {} : { mechanism };
    if (options.pinnedOff === true)
      return {
        available: false,
        platforms,
        tier: "unavailable",
        detail: PINNED_OFF,
        fix: "start serve without --sandbox-tier unavailable, and unset TAVI_SANDBOX",
        ...withMechanism,
      };
    if (platform !== "darwin" && platform !== "linux") {
      const { cause, fix } = unsupportedPlatformFailure(platform);
      return { available: false, platforms, tier: "unavailable", detail: cause, fix, ...withMechanism };
    }
    if (options.host === undefined) {
      if (platform !== "darwin")
        return {
          available: false,
          platforms,
          tier: "unavailable",
          detail: `no host detection is configured for ${platform}; the sandbox runs here only under tavi serve`,
          ...withMechanism,
        };
      if (!manager.isSupportedPlatform())
        return {
          available: false,
          platforms,
          tier: "unavailable",
          detail: "the sandbox runtime reports this macOS host as unsupported",
          ...withMechanism,
        };
      return { available: true, installProbe: true, platforms, tier: "full", ...withMechanism, ...limitsOf() };
    }
    const status = settled ?? options.host.current();
    // srt's glob warnings (recorded once it has initialized) and what runs' compiles dropped.
    const compiled = [...warnings].map((detail) => ({ name: "policy compile", ok: false, severity: "warning" as const, detail }));
    const checks = [...status.checks, ...compiled];
    if (status.tier === "checking")
      return {
        available: true,
        installProbe: false,
        platforms,
        detail: "the sandbox check is in progress; a run waits for it",
        checks,
        ...withMechanism,
      };
    if (status.tier === "nested" && options.nested !== true)
      return {
        available: false,
        platforms,
        tier: "unavailable",
        detail: "only srt's weaker nested mode runs here",
        fix: "serve --sandbox-nested",
        checks,
        ...withMechanism,
      };
    if (sandboxConfines(status))
      return {
        available: true,
        installProbe: true,
        platforms,
        tier: status.tier === "nested" ? "nested" : "full",
        checks,
        ...withMechanism,
        ...limitsOf(),
      };
    return {
      available: false,
      platforms,
      tier: "unavailable",
      detail: status.cause ?? "the sandbox does not work on this host",
      ...(status.fix === undefined ? {} : { fix: status.fix }),
      checks,
      ...withMechanism,
    };
  }

  /** One probe for every run that arrives while the host is still checking. */
  let settling: Promise<SandboxStatus> | undefined;

  /** The tier a run goes at, waiting for the host's first answer; refused with its cause and fix otherwise. */
  async function admit(signal: AbortSignal): Promise<"full" | "nested"> {
    if (options.pinnedOff === true)
      throw new TaviError("UNAVAILABLE", `sandbox runtime is unavailable: ${PINNED_OFF}`, { details: { tier: "unavailable" } });
    let settled: SandboxStatus | undefined;
    if (options.host !== undefined && options.host.current().tier === "checking") {
      const host = options.host;
      settling ??= host.check({ nested: options.nested === true }).finally(() => (settling = undefined));
      // A cancel, a timeout or a shutdown ends the wait; the shared check goes on for the runs still waiting.
      settled = await waitFor(settling, signal);
    }
    // A failure that has stood a while is checked again before it refuses: a host fixed since
    // (`tavi sandbox setup --apply`) runs this call, not one ten minutes later.
    const recheck = settled === undefined ? options.host?.recheck?.(RECHECK_AFTER_MS) : undefined;
    if (recheck !== undefined) settled = await waitFor(recheck, signal, RECHECK_WAIT_MS);
    const caps = capabilities(settled);
    if (!caps.available || caps.tier === undefined || caps.tier === "unavailable") {
      throw new TaviError("UNAVAILABLE", `sandbox runtime is unavailable: ${caps.detail ?? "unsupported platform"}`, {
        details: { tier: "unavailable", ...(caps.fix === undefined ? {} : { fix: caps.fix }) },
      });
    }
    return caps.tier;
  }

  // srt's Linux helpers by absolute path: a service unit's narrow PATH still runs them. Looked up again
  // until both are found, so one installed while the owner runs (`tavi sandbox setup --apply`) is taken.
  let helpers: Pick<SandboxRuntimeConfig, "socatPath" | "ripgrep"> | undefined;
  const helperConfig = (): Pick<SandboxRuntimeConfig, "socatPath" | "ripgrep"> => {
    if (platform !== "linux") return {};
    if (helpers?.socatPath === undefined || helpers.ripgrep === undefined) helpers = srtHelperConfig(options.helperPath);
    return helpers;
  };
  /** This adapter's global config: the deny-everything base with its bubblewrap and mode. */
  const baseConfig = (bwrapPath: string | undefined): SandboxRuntimeConfig => ({
    ...BASE_CONFIG,
    ...(options.nested === true ? { enableWeakerNestedSandbox: true } : {}),
    ...(bwrapPath === undefined ? {} : { bwrapPath }),
    ...helperConfig(),
  });
  /** The bubblewrap srt's global config holds: srt reads it there, never from a wrap's own config. */
  let configuredBwrap: string | undefined;

  /** srt's config moved to the bubblewrap there is now, when that changed since the last run. */
  function followBwrap(bwrapPath: string | undefined): void {
    if (bwrapPath === configuredBwrap) return;
    configuredBwrap = bwrapPath;
    manager.updateConfig(baseConfig(bwrapPath));
  }

  function ensureInitialized(): Promise<void> {
    if (initialization === undefined) {
      // A minimal deny-everything base — `initialize()` requires *some*
      // valid config before first use. Every filesystem decision is made
      // per-run via `wrapWithSandboxArgv`'s own `customConfig`
      // (`compile`, `policy-compile.ts`). srt's network allowlist is this
      // global config's, so it stays empty here: a run granted domains
      // runs in a host process of its own (`runNetworked`). The log monitor is macOS's: Seatbelt logs each
      // refusal. srt's Linux monitor judges writes by this base config, not a
      // run's, so it would call every allowed write a violation.
      openAdapters.set(manager, (openAdapters.get(manager) ?? 0) + 1);
      configuredBwrap = bwrapPathNow();
      initialization = manager.initialize(baseConfig(configuredBwrap), undefined, platform === "darwin").then(() => {
        // srt's own warnings about its config, logged at start.
        for (const warning of manager.getLinuxGlobPatternWarnings?.() ?? [])
          warn(`srt cannot enforce ${warning} on Linux (a glob it does not expand)`);
      });
    }
    return initialization;
  }

  /**
   * Records what bubblewrap may leave for this run — the first absent
   * component of each absent deny path, a file or a folder — with the time
   * past which a change there is no longer the run's (its timeout, until it
   * ends), so the last run to end, or a start after a killed owner, can sweep
   * it and nothing a person made there later.
   */
  function recordPlaceholders(sessionId: string, config: SandboxRuntimeConfig, timeoutMs: number): (() => void) | undefined {
    if (options.stateDirectory === undefined || platform !== "linux") return undefined;
    const placeholders = placeholdersFor(
      (config.filesystem.denyWrite ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path)),
    );
    const paths = placeholders.map((placeholder) => placeholder.path);
    if (paths.length === 0) return undefined;
    const directory = join(options.stateDirectory, "placeholders");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `${process.pid}-${sessionId}.json`);
    // Past its timeout and the kill ladder the run is gone, whatever happens to the owner.
    writeFileSync(file, JSON.stringify({ paths, until: Date.now() + timeoutMs + 60_000 }), { mode: 0o600 });
    // Made here, before srt wraps the run: srt removes only what it made itself, so no srt — this process's, or a
    // networked run's host process — unlinks one while another run has a mount on it. The last run to end does.
    makePlaceholders(placeholders);
    // srt's cleanup is reference-counted: a placeholder outlives this run while another holds it. The record goes once
    // none is left, else it is closed at the run's end.
    return () => {
      const until = Date.now();
      if (!paths.some((path) => isStalePlaceholder(path, until))) rmSync(file, { force: true });
      else writeFileSync(file, JSON.stringify({ paths, until }), { mode: 0o600 });
    };
  }

  /** What the platform reported refused for a run: complete on macOS, partial on Linux. srt files them under the wrap's `commandId`. */
  function violationsFor(sessionId: string): readonly SandboxViolation[] {
    const store = manager.getSandboxViolationStore?.();
    if (store === undefined) return [];
    return store.getViolationsForCommand(sessionId).flatMap((event) => {
      const violation = violationOf(event.line);
      return violation === undefined ? [] : [violation];
    });
  }

  /** The session's CA (`ca.ts`), or the refusal when the engine has no folder for one. */
  function sessionCa(sessionId: string): ProxyCa {
    if (options.caDirectory === undefined)
      throw new TaviError(
        "UNAVAILABLE",
        "a sandboxed command with credentials needs a private folder for the proxy's certificate authority, and none is configured",
        { details: { sessionId } },
      );
    return proxyCa(options.caDirectory);
  }

  /** What the host process needs to inject the run's credentials: every one with its value, its hosts granted. */
  function credentialsFor(policy: SandboxPolicy, command: SandboxCommand, sessionId: string): Pick<HostProcessRequest, "credentials"> {
    const entries = policy.network.credentials ?? [];
    if (entries.length === 0) return {};
    const grants = policy.network.allowedHosts ?? [];
    for (const credential of entries) {
      if (!ENV_NAME.test(credential.env))
        throw new TaviError("INVALID_INPUT", `credential variable ${JSON.stringify(credential.env)} is not a valid name`, {
          details: { sessionId },
        });
      if (command.secrets?.[credential.env] === undefined)
        throw refusedEarly("NOT_CONFIGURED", `credential ${credential.env} has no value for this run`, {
          sessionId,
          credential: credential.env,
        });
      const ungranted = credential.hosts.find((host) => !/^[a-z0-9.-]+$/.test(host) || !grants.includes(host));
      if (ungranted !== undefined)
        throw new TaviError(
          "INVALID_INPUT",
          `credential ${credential.env}'s host ${ungranted} must be an exact host, with no port, that the run is granted`,
          { details: { sessionId, credential: credential.env } },
        );
    }
    const { certPath, keyPath } = sessionCa(sessionId);
    return {
      credentials: {
        entries,
        secrets: Object.fromEntries(entries.map((credential) => [credential.env, command.secrets?.[credential.env] ?? ""])),
        caCertPath: certPath,
        caKeyPath: keyPath,
      },
    };
  }

  /** The CA an inspected run's proxy terminates every grant's TLS with: the one its credentials use. */
  function inspectCa(sessionId: string): NonNullable<HostProcessRequest["inspectTls"]> {
    if (options.caDirectory === undefined)
      throw new TaviError(
        "UNAVAILABLE",
        "--sandbox-inspect-tls needs a private folder for the proxy's certificate authority, and none is configured",
        { details: { sessionId } },
      );
    const { certPath, keyPath } = sessionCa(sessionId);
    return { caCertPath: certPath, caKeyPath: keyPath };
  }

  /** A run's own cgroup, outermost, so everything it starts is inside; `argv` unchanged without limits. */
  function placeRun(argv: readonly string[], policy: SandboxPolicy): { readonly argv: readonly string[]; readonly groupId?: string } {
    return (
      options.limits?.place(argv, "run", {
        ...definedOnly({
          memoryBytes: policy.resources.maxMemoryBytes,
          processes: policy.resources.maxProcesses,
          cpuPercent: policy.resources.cpuQuotaPercent,
        }),
      }) ?? { argv }
    );
  }

  /** Throws when the run's cgroup stopped it (memory) or it never entered its cgroup. */
  function limitsOutcome(
    groupId: string | undefined,
    result: RunProcessResult,
    policy: SandboxPolicy,
    sessionId: string,
    reached: Readonly<Record<string, unknown>> = {},
  ): void {
    if (groupId !== undefined && options.limits?.outcome(groupId) === "oom") {
      throw new TaviError(
        "QUOTA_EXCEEDED",
        `the command ran out of memory: its cap is ${policy.resources.maxMemoryBytes === undefined ? "the sandbox's default" : `${String(Math.round(policy.resources.maxMemoryBytes / 1024 / 1024))} MiB`}`,
        { details: { sessionId, reason: "memory", ...reached } },
      );
    }
    if (result.exitCode === LIMITS_ENTRY_FAILED_EXIT && result.stderr.includes(LIMITS_ENTRY_FAILED)) {
      throw new TaviError(
        "UNAVAILABLE",
        "the command could not enter its resource limits (its cgroup), so it did not run; tavi doctor shows the limits",
        { details: { sessionId, reason: "limits", ...reached } },
      );
    }
  }

  /**
   * A network run: the srt host process, fed the compiled policy and
   * the run's grants on fd 3, its `TMPDIR` under the service's runtime
   * directory, its `cwd` the run's primary writable root (the command runs in
   * its own folder); each connection decided by the grants and reported back
   * for the audit.
   */
  async function runNetworked(run: {
    readonly sessionId: string;
    readonly controller: AbortController;
    readonly tier: "full" | "nested";
    readonly policy: SandboxPolicy;
    readonly command: SandboxCommand;
    readonly line: string;
    readonly config: SandboxRuntimeConfig;
    readonly grants: readonly string[];
    readonly bwrapPath: string | undefined;
    readonly warnings: readonly string[];
    /** The run's tag on macOS (`RUN_TAG`), its processes' to carry. */
    readonly tag: string | undefined;
    /** The run's marker on macOS, its processes' to hold open. */
    readonly marker: RunMarker | undefined;
    /** The run's proxy folder (`egressDirectory`), which the caller removes. */
    readonly directory: string;
  }): Promise<SandboxRunResult> {
    const { sessionId, controller, policy, command, directory } = run;
    const audit = requestAudit();
    const violations: SandboxViolation[] = [];
    let groupId: string | undefined;
    // srt in the host process makes bubblewrap's placeholders as the owner's would: recorded, so a sweep finds what a kill left.
    const forgetPlaceholders = recordPlaceholders(sessionId, run.config, policy.resources.timeoutMs);
    try {
      const request: HostProcessRequest = {
        config: {
          ...run.config,
          ...(options.nested === true ? { enableWeakerNestedSandbox: true } : {}),
          ...(run.bwrapPath === undefined ? {} : { bwrapPath: run.bwrapPath }),
          ...helperConfig(),
          network: {
            ...run.config.network,
            // Paste sites, and an allowed name never resolves into this host's private networks (DNS rebinding).
            ...egressDenyLists(run.grants, options.deniedDomains),
          },
        },
        grants: run.grants,
        ...(run.marker === undefined ? {} : { marker: true }),
        ...(options.inspectTls === true ? { inspectTls: inspectCa(sessionId) } : {}),
        ...(options.parentProxy === undefined ? {} : { parentProxy: options.parentProxy }),
        line: run.line,
        cwd: command.cwd ?? directory,
        // Node reads srt's proxy variables only when told to (Node 22.21+), and then warns on every start that its
        // proxy agent is experimental, which the command's stderr would carry; the run's tag finds what it leaves behind.
        env: {
          ...command.env,
          NODE_USE_ENV_PROXY: "1",
          NODE_OPTIONS: withQuietProxyAgent(
            command.env?.["NODE_OPTIONS"] ?? (command.inheritEnv === false ? undefined : process.env["NODE_OPTIONS"]),
          ),
          ...(run.tag === undefined ? {} : { [RUN_TAG]: run.tag }),
        },
        inheritEnv: command.inheritEnv !== false,
        ...credentialsFor(policy, command, sessionId),
      };
      const placed = placeRun([process.execPath, hostProcessPath()], policy);
      groupId = placed.groupId;
      const [executable, ...args] = placed.argv as [string, ...string[]];
      let exit: { readonly code: number | null } | undefined;
      let failure: { readonly message: string; readonly profileError?: string } | undefined;
      const result = await runProcess(spawnImpl, executable, args, {
        cwd: primaryRoot(policy, command) ?? command.cwd,
        // What srt itself needs, never the owner's whole environment: no provider key in this process's (a nested run
        // reads the host's /proc, though the owner's own process still holds its keys there), and no proxy variable
        // becomes srt's parent proxy unasked.
        env: { ...hostProcessEnvironment(process.env), TMPDIR: directory },
        signal: controller.signal,
        maxOutputBytes: policy.resources.maxOutputBytes,
        killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
        ...(groupId === undefined || options.limits === undefined ? {} : { killGroup: () => options.limits?.kill(groupId as string) }),
        ...(run.marker === undefined ? {} : { marker: run.marker.fd }),
        ...(run.tag === undefined ? {} : { sweep: () => sweepRun(run.tag as string, run.marker?.path, options.runLister ?? darwinLister) }),
        control: {
          request: JSON.stringify(request),
          onLine: (text) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              return;
            }
            // A line that is not an event is dropped, as one that does not parse is.
            const event = hostProcessEventOf(parsed);
            if (event === undefined) return;
            if (event.type === "request") audit.record(event.host, event.port, event.allowed);
            else if (event.type === "violation") {
              const violation = violationOf(event.line);
              if (violation !== undefined) violations.push(violation);
              // The deny list and the address guard refuse before or after the grants: the audit says so too.
              const refused = violation?.kind === "network" ? /^(.+):(\d+)$/.exec(violation.target) : null;
              // srt records the host as the client spelled it: the audit keys on the host it dials, as the grant decisions do.
              // The address guard's refusal (srt's `(resolved to loopback)`) comes after the grants let the request through.
              if (refused !== null)
                audit.refuse(dialedHost(refused[1] ?? "") ?? refused[1] ?? "", Number(refused[2]), ADDRESS_REFUSAL.test(event.line));
            } else if (event.type === "inject") audit.inject(event.host, event.port, event.credentials);
            else if (event.type === "exit") exit = { code: event.code };
            else failure = event;
          },
        },
      });
      // A run that fails after a request got through still brought in what a host sent: its error says so.
      const reached = audit.requests().some((request) => request.allowedCount > 0) ? { [SANDBOX_REACHED_NETWORK_DETAIL]: true } : {};
      limitsOutcome(groupId, result, policy, sessionId, reached);
      if (exit === undefined && !controller.signal.aborted) {
        if (failure?.profileError !== undefined) throw profileRefusal(failure.profileError, failure.message);
        throw new TaviError(
          "UNAVAILABLE",
          `the sandbox's network host did not run the command: ${failure?.message ?? (result.stderr.trim().slice(0, 300) || "no answer")}`,
          { details: { sessionId, ...reached } },
        );
      }
      const state: SandboxSessionState = controller.signal.aborted ? "cancelled" : "completed";
      sessions.set(sessionId, { state, controller });
      const pressure = groupId === undefined ? undefined : options.limits?.pressure?.(groupId);
      return {
        ...(pressure === undefined ? {} : { limitsHit: pressure }),
        session: { sessionId, state },
        exitCode: exit?.code ?? result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        tier: run.tier,
        ...(mechanism === undefined ? {} : { mechanism }),
        violations,
        violationsComplete: platform === "darwin",
        requests: audit.requests(),
        ...(audit.truncated() ? { requestsTruncated: true } : {}),
        ...warningsOf([...run.warnings, ...(result.swept === false ? [SWEEP_UNCHECKED] : [])]),
      };
    } finally {
      if (groupId !== undefined) options.limits?.release(groupId);
      // What its host process left (killed past its cleanup) goes when the last run of this owner ends (`run`).
      forgetPlaceholders?.();
    }
  }

  /**
   * The writable root a network run's host process starts in, so srt's own
   * mandatory-deny scan (rooted at its `cwd`) covers it: the one holding
   * the command's folder, else the first; none when nothing is writable or
   * the root is gone. The command still runs in its own folder (`request.cwd`).
   */
  function primaryRoot(policy: SandboxPolicy, command: SandboxCommand): string | undefined {
    const roots = policy.filesystem.allowWrite;
    const cwd = command.cwd;
    const root =
      (cwd === undefined
        ? undefined
        : roots.find((candidate) => cwd === candidate || cwd.startsWith(candidate.endsWith("/") ? candidate : `${candidate}/`))) ??
      roots[0];
    return root !== undefined && existsSync(root) ? root : undefined;
  }

  /**
   * Where a network run's srt keeps its bridge sockets and trust bundle: the
   * service's runtime directory (`RuntimeDirectory=tavi`), else the session's
   * (`$XDG_RUNTIME_DIR/tavi`) — never the temporary directory every policy
   * denies. A socket path stays under the 108 bytes Linux allows. The run
   * re-opens it for reading, since `$XDG_RUNTIME_DIR` is denied: bubblewrap
   * would otherwise mask the sockets, and every request would go unanswered.
   */
  function egressDirectory(sessionId: string): string {
    const base =
      options.runtimeDirectory ??
      process.env["RUNTIME_DIRECTORY"]?.split(":")[0] ??
      (process.env["XDG_RUNTIME_DIR"] === undefined ? undefined : join(process.env["XDG_RUNTIME_DIR"], "tavi")) ??
      (platform === "linux" ? undefined : join(tmpdir(), `tavi-srt-${String(process.getuid?.() ?? "owner")}`));
    if (base === undefined) {
      throw new TaviError(
        "UNAVAILABLE",
        "a sandboxed command granted the network needs a private runtime directory for its proxy: run Tavi under the generated unit (RuntimeDirectory=tavi), or in a login session ($XDG_RUNTIME_DIR)",
        { details: { sessionId } },
      );
    }
    const directory = join(base, "srt", `${sessionId}-${randomBytes(3).toString("hex")}`);
    if (platform === "linux" && directory.length > 64)
      throw new TaviError(
        "UNAVAILABLE",
        `the runtime directory ${base} is too deep for the proxy's sockets (a socket path holds 108 bytes)`,
        { details: { sessionId } },
      );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  async function run(policy: SandboxPolicy, command: SandboxCommand): Promise<SandboxRunResult> {
    if (closed) throw new TaviError("UNAVAILABLE", "the sandbox is shutting down");
    const sessionId = `sandbox-run-${(runCounter += 1)}`;
    activeRuns += 1;
    const controller = new AbortController();
    sessions.set(sessionId, { state: "running", controller });
    // Started first, so a run waiting for the host's answer, for the runtime
    // or behind another allowlist is still bounded by its own timeout and
    // reachable by `cancel()` and `close()`.
    // On macOS, where nothing else holds a detached process to its run, every process of the run carries this tag.
    const tag = platform === "darwin" ? `${String(process.pid)}.${sessionId}.${randomBytes(4).toString("hex")}` : undefined;
    // And holds its marker open, which finds those of its processes macOS shows no environment for.
    const marker = tag === undefined ? undefined : runMarker(tag, options.stateDirectory ?? tmpdir());
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, policy.resources.timeoutMs);
    // A run its timeout stopped says so, apart from one cancelled: the caller can ask for a longer one.
    const stamped = (result: SandboxRunResult): SandboxRunResult => (timedOut ? { ...result, timedOut: true } : result);
    let wrapped = false;
    let forgetPlaceholders: (() => void) | undefined;
    let groupId: string | undefined;
    let egress: string | undefined;

    try {
      const tier = await admit(controller.signal);
      await ensureInitialized();
      controller.signal.throwIfAborted();
      const line = renderShellCommand(command);
      // A run granted domains has its own proxy and allowlist, in its own srt host process. So does one
      // allowed to listen or use Unix sockets: srt reads those from its process-wide config, never a wrap's.
      const grants = policy.network.allow ? [...(policy.network.allowedHosts ?? [])] : [];
      const ownProcess = policy.local?.localBinding === true || (policy.local?.unixSocketsIn?.length ?? 0) > 0;
      const networked = grants.length > 0 || (ownProcess && platform === "darwin");
      // Its proxy's folder, made first: the run reads it though it lies in a denied place (`$XDG_RUNTIME_DIR`).
      egress = networked ? egressDirectory(sessionId) : undefined;
      // The one producer of srt's config: patterns on macOS, literals on Linux. On Linux srt runs its
      // seccomp helper from its package inside the sandbox, which may sit in a denied folder (Tavi under $HOME).
      const reopened = [...(compilePlatform === "linux" ? [srtHelpersDirectory()] : []), ...(egress === undefined ? [] : [egress])];
      const readable =
        reopened.length === 0
          ? policy
          : { ...policy, filesystem: { ...policy.filesystem, allowRead: [...policy.filesystem.allowRead, ...reopened] } };
      const { config, dropped } = compile(readable, command, compilePlatform, options.fs);
      // What this platform cannot express of the policy is said, never dropped silently.
      for (const entry of dropped) warn(`a run's policy entry was left out: ${entry}`);
      const bwrapPath = bwrapPathNow();
      if (egress !== undefined)
        return stamped(
          await runNetworked({
            sessionId,
            controller,
            tier,
            policy,
            command,
            line,
            directory: egress,
            config,
            grants,
            bwrapPath,
            warnings: dropped,
            tag,
            marker,
          }),
        );
      followBwrap(bwrapPath);
      // `command.cwd` is passed through uncanonicalized, unlike every
      // filesystem policy path above — safe today only because the
      // installed library's own source shows `cwd` is unused for
      // macOS/Linux permission decisions (it feeds Windows-only
      // `safe.directory` computation). This is a reliance on an
      // upstream implementation detail, not a guarantee: if a future
      // version starts using `cwd` for a macOS/Linux grant (e.g. an
      // implicit allow-cwd rule, mirroring the Windows path), this
      // would silently reopen the same class of symlink-mismatch bug
      // `canonicalize` exists to close — re-check on every dependency
      // upgrade.
      forgetPlaceholders = recordPlaceholders(sessionId, config, policy.resources.timeoutMs);
      let argvAndEnv: { readonly argv: string[]; readonly env: NodeJS.ProcessEnv };
      try {
        argvAndEnv = await manager.wrapWithSandboxArgv(line, undefined, config, controller.signal, command.cwd, { commandId: sessionId });
      } catch (error) {
        // A profile bubblewrap cannot run: what the caller passed (too long, a NUL) or what the host allows.
        if (error instanceof LinuxSandboxProfileError) throw profileRefusal(error.code, error.message);
        throw error;
      }
      wrapped = true;
      if (argvAndEnv.argv[0] === undefined) {
        throw new TaviError("INTERNAL", "the sandbox runtime returned an empty argv for this command", { details: { sessionId } });
      }
      // Its own cgroup, outermost, so srt, bubblewrap and the command are all inside.
      const placed = placeRun(argvAndEnv.argv, policy);
      groupId = placed.groupId;
      const [executable, ...args] = placed.argv as [string, ...string[]];
      // `env` from `wrapWithSandboxArgv` is currently just `process.env`
      // on macOS/Linux per the installed library's own source — nothing
      // sandbox-critical (credential masking, proxy settings) lives in
      // it to be clobbered by `command.env`; those are embedded in the
      // wrapped shell command string itself, not this returned object.
      // So `inheritEnv: false` may drop it whole: the child then sees
      // only `command.env` (and what the wrapper itself sets).
      const tagged = tag === undefined ? {} : { [RUN_TAG]: tag };
      const result = await runProcess(spawnImpl, executable, args, {
        cwd: command.cwd,
        env: command.inheritEnv === false ? { ...command.env, ...tagged } : { ...argvAndEnv.env, ...command.env, ...tagged },
        signal: controller.signal,
        maxOutputBytes: policy.resources.maxOutputBytes,
        killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
        ...(groupId === undefined || options.limits === undefined ? {} : { killGroup: () => options.limits?.kill(groupId as string) }),
        ...(marker === undefined ? {} : { marker: marker.fd }),
        ...(tag === undefined ? {} : { sweep: () => sweepRun(tag, marker?.path, options.runLister ?? darwinLister) }),
      });
      limitsOutcome(groupId, result, policy, sessionId);
      const state: SandboxSessionState = controller.signal.aborted ? "cancelled" : "completed";
      sessions.set(sessionId, { state, controller });
      const pressure = groupId === undefined ? undefined : options.limits?.pressure?.(groupId);
      return stamped({
        ...(pressure === undefined ? {} : { limitsHit: pressure }),
        session: { sessionId, state },
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        tier,
        ...(mechanism === undefined ? {} : { mechanism }),
        violations: violationsFor(sessionId),
        violationsComplete: platform === "darwin",
        ...warningsOf([...dropped, ...(result.swept === false ? [SWEEP_UNCHECKED] : [])]),
      });
    } catch (error) {
      // Distinguish an intentional abort (timeout or `cancel()`) from a
      // genuine failure, the same way the success path above does —
      // otherwise a timed-out run is recorded internally as "failed"
      // when it was actually "cancelled".
      const state: SandboxSessionState = controller.signal.aborted ? "cancelled" : "failed";
      sessions.set(sessionId, { state, controller });
      // Its timeout ran out before the command started (waiting on the host's check, or the runtime): say so.
      if (timedOut && !(error instanceof TaviError))
        throw new TaviError(
          "CANCELLED",
          `the command did not start within its ${String(Math.round(policy.resources.timeoutMs / 1000))} s timeout while the sandbox got ready; run it again, with a longer timeoutMs if this repeats`,
          { details: { sessionId, timedOut: true } },
        );
      throw error;
    } finally {
      activeRuns -= 1;
      clearTimeout(timeoutHandle);
      // Once per wrap that succeeded — after exit, a spawn error or an abort — and never after a wrap that threw.
      if (wrapped) manager.cleanupAfterCommand();
      if (groupId !== undefined) options.limits?.release(groupId);
      forgetPlaceholders?.();
      // The last run of this owner to end removes what any of its runs left (a networked one's, kept while this ran).
      if (activeRuns === 0 && platform === "linux" && options.stateDirectory !== undefined) sweepStalePlaceholders(options.stateDirectory);
      releaseMarker(marker);
      if (egress !== undefined) rmSync(egress, { recursive: true, force: true });
    }
  }

  return {
    capabilities,

    run(policy: SandboxPolicy, command: SandboxCommand): Promise<SandboxRunResult> {
      const pending = run(policy, command);
      // Tracking only: the run's own failure reaches its caller through `pending`.
      const settled = pending.catch(() => undefined).finally(() => running.delete(settled));
      running.add(settled);
      return pending;
    },

    async cancel(sessionId: string): Promise<void> {
      const record = sessions.get(sessionId);
      if (record === undefined) {
        throw new TaviError("NOT_FOUND", `No sandbox session ${sessionId}`);
      }
      // Only signals — `run()`'s own `finally`/completion path is what
      // actually settles the session's final state, based on whether the
      // signal ended up aborted by the time the process exited. Avoids a
      // race between this setting `"cancelled"` directly and `run()`
      // concurrently settling `"completed"`/`"failed"` from the real
      // process outcome.
      if (record.state === "running") record.controller.abort();
    },

    async dispose(sessionId: string): Promise<void> {
      if (!sessions.has(sessionId)) {
        throw new TaviError("NOT_FOUND", `No sandbox session ${sessionId}`);
      }
      sessions.delete(sessionId);
    },

    async ready(): Promise<SandboxCapabilities> {
      if (options.host !== undefined && options.host.current().tier === "checking") {
        const host = options.host;
        settling ??= host.check({ nested: options.nested === true }).finally(() => (settling = undefined));
        return capabilities(await settling);
      }
      return capabilities();
    },

    async close(): Promise<void> {
      // Graceful shutdown refuses new runs, cancels what runs (waiting for the host or the runtime too), and waits for each run's cleanup.
      closed = true;
      for (const record of sessions.values()) if (record.state === "running") record.controller.abort();
      await Promise.all([...running]);
      // srt's proxies and its macOS log monitor would keep the process alive past shutdown; the last adapter open resets them.
      if (initialization !== undefined) {
        const open = (openAdapters.get(manager) ?? 1) - 1;
        openAdapters.set(manager, open);
        initialization = undefined;
        if (open === 0) {
          await manager.reset?.();
        }
      }
    },
  };
}
