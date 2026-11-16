import { TaviError, refusedEarly } from "./errors.js";
import type { LimitEnforcement, LimitPressure } from "./limits.js";
import type { SandboxHostCheck } from "./sandbox-host.js";
import type { ToolDefinition } from "./tools.js";

/**
 * Sandboxed command execution contract: one small `SandboxProvider`
 * contract — availability/capabilities, run with policy, cancel and
 * dispose — returning session handles, bounded output, artifacts and typed
 * failure.
 *
 * "No unsandboxed fallback": a tool
 * declaring `requiresSandbox: true` (`ToolDefinition`, `./tools.js`) is
 * refused with a typed capability error when no sandbox is configured,
 * never silently run outside one.
 */

export interface SandboxCapabilities {
  readonly available: boolean;
  /** Reported, not enforced by this contract — the adapter's own job to make true. */
  readonly platforms: readonly string[];
  readonly detail?: string;
  /** How strongly this host confines: `nested` gives up PID and `/proc` isolation, by the operator's choice. */
  readonly tier?: "full" | "nested" | "unavailable";
  readonly mechanism?: "seatbelt" | "bubblewrap";
  readonly checks?: readonly SandboxHostCheck[];
  /** What the operator runs when the tier is `unavailable`. */
  readonly fix?: string;
  /** Whether `plugins.validate` may run a plugin's `register` here: macOS, and Linux once its tier has settled usable. */
  readonly installProbe?: boolean;
  /** Whether each resource limit is held by the kernel here. */
  readonly limits?: { readonly memory: LimitEnforcement; readonly pids: LimitEnforcement; readonly cpu: LimitEnforcement };
}

/** How many distinct hosts and ports one network run's audit keeps; past it the result says `requestsTruncated`. */
export const SANDBOX_REQUESTS_MAX = 256;

/**
 * A `TaviError` detail, `true` on a network run that failed after a request
 * got through (`allowedCount` above 0): the error carries no audit, yet the
 * run brought in what a host sent.
 */
export const SANDBOX_REACHED_NETWORK_DETAIL = "reachedNetwork";

/**
 * A host and port a network run asked for, and whether it was let through
 * (the run's audit): refused by its grants, the deny list, or an address
 * the run may not dial. `count` is how many times it was asked.
 */
export interface SandboxRequest {
  readonly host: string;
  readonly port: number;
  /** Nothing to this host and port was refused: the card's verdict. Some requests may still have got through when it is false. */
  readonly allowed: boolean;
  readonly count: number;
  /** How many requests to it got through: the grants let them and no guard refused them after. Above 0, the run reached the network. */
  readonly allowedCount: number;
  /** The credentials (`SandboxCredential.env`) its proxy cleared to put in, names only; sent only when the upstream's certificate verified. */
  readonly credentials?: readonly string[];
}

/** One thing the sandbox refused during a run, as far as the platform reports it. */
export interface SandboxViolation {
  readonly kind: "read" | "write" | "network" | "socket";
  readonly target: string;
}

/**
 * Filesystem/network/resource constraints as plain validated data, the
 * same way `WorkflowInvokeOptions`/`ToolDefinition`'s effect
 * classification already express constraints as data rather than
 * executable code. "No provider keys, host home mounts, Docker sockets or
 * broad network access reach commands" is why `network.allow`
 * defaults to denial-by-omission rather than an unlimited default.
 */
export interface SandboxFilesystemPolicy {
  /**
   * Folders re-opened for reading inside a `denyRead` entry. Reads are allowed
   * unless denied, so this narrows nothing on its own: it carves exceptions
   * out of `denyRead`, and a `denyRead` entry nested inside one of these is
   * still denied (the more specific path wins).
   */
  readonly allowRead: readonly string[];
  /** The only places a command may write (beside the runtime's own defaults, which `denyWrite` closes). */
  readonly allowWrite: readonly string[];
  /** Explicit deny overrides, for reads and writes alike, checked ahead of any `allowRead`/`allowWrite` entry — private host areas the adapter must never expose regardless of what else is granted. */
  readonly denyPaths?: readonly string[];
  /**
   * Read-denied, except where an `allowRead` entry nested inside re-opens it:
   * `$HOME` or the data directory denied whole, with the chat's own
   * folders re-opened. Never denies writes, so a read deny of the data
   * directory leaves the chat's own folder inside it writable.
   */
  readonly denyRead?: readonly string[];
  /** Write-denied wherever they are, whatever `allowWrite` grants. Never denies reads. */
  readonly denyWrite?: readonly string[];
  /**
   * Names write-denied at any depth under a writable root — what git, a shell
   * or an editor runs on the host. The
   * adapter compiles them per platform: patterns on macOS, literal paths
   * from a bounded walk on Linux, where a write-deny pattern is ignored.
   */
  readonly protectedNames?: readonly SandboxProtectedNames[];
}

/** Protected names under one writable root. */
export interface SandboxProtectedNames {
  readonly root: string;
  /** Write-denied at any depth below `root`, `root` itself included; a name may hold a `/` (`.git/hooks`). */
  readonly names: readonly string[];
  /** Write-denied at `root` only: a bare repository's `HEAD`, which git would find there. */
  readonly rootNames?: readonly string[];
}

/** How many domains one grant list may hold (`serve --sandbox-domain`, a workspace's `sandbox.domains`). */
export const SANDBOX_DOMAINS_MAX = 64;

const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const SANDBOX_DOMAIN = new RegExp(`^(?:\\*\\.(?=${DOMAIN_LABEL}\\.))?${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*(?::(\\d{1,5}))?$`);

/** A name whose last label is a number (decimal, or `0x` hex) is an IPv4 address to a URL parser, however it is spelled. */
const NUMERIC_LABEL = /(?:^|\.)(?:\d+|0x[0-9a-f]*)$/;
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const CANONICAL_IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

/** Addresses no grant reaches, whatever it names: this host, the unspecified address, link-local and cloud metadata. */
function neverGranted(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (!CANONICAL_IPV4.test(host)) return false;
  const [first, second] = host.split(".").map(Number);
  return (
    first === 127 || first === 0 || (first === 169 && second === 254) || ["168.63.129.16", "100.100.100.200", "192.0.0.192"].includes(host)
  );
}

/**
 * What git, a shell or an editor runs on the host from a folder on its own,
 * the next time someone uses the folder there: git's hooks, config,
 * attributes and `commondir` (which points git at another gitdir's config and
 * hooks), the hook managers' config (husky, pre-commit, lefthook), shell
 * profiles, direnv and mise, and editor and agent settings, hooks and skills.
 * `sandbox.run` never writes them, at any depth of any folder it writes
 * (patterns on macOS, literal paths on Linux), and the file tools write them
 * in a host folder only with a person shown the change each time.
 */
export const PROJECT_PROTECTED_NAMES = [
  ".git/hooks",
  ".git/config",
  ".git/config.worktree",
  ".git/commondir",
  ".git/info/attributes",
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".zshrc",
  ".zprofile",
  ".zlogin",
  ".profile",
  ".envrc",
  ".husky",
  ".pre-commit-config.yaml",
  "lefthook.yml",
  ".lefthook.yml",
  "mise.toml",
  ".mise.toml",
  ".ripgreprc",
  ".mcp.json",
  ".vscode",
  ".idea",
  ".zed",
  ".helix",
  ".cursor",
  ".codex",
  ".gemini",
  ".claude/commands",
  ".claude/agents",
  ".claude/hooks",
  ".claude/skills",
  ".claude/settings.json",
  ".claude/settings.local.json",
] as const;

/**
 * What a package manager, mise or a dev container runs on the host from a
 * folder on its own: the package managers' config that runs code
 * (`.yarnrc.yml`'s `yarnPath` and the release and plugins it names,
 * `.pnpmfile.cjs`, `bunfig.toml`'s `preload`, `.npmrc`'s `node-options`,
 * cargo's `rustc-wrapper`), mise's other config files, and dev containers'
 * host commands. Protected in host folders only, beside
 * `PROJECT_PROTECTED_NAMES`: the host never runs a package manager in a
 * chat's own folder, where `npm login` writes the sandbox home's `.npmrc`.
 */
export const HOST_PROTECTED_NAMES = [
  "mise.local.toml",
  ".mise.local.toml",
  ".mise/config.toml",
  "mise/config.toml",
  ".config/mise.toml",
  ".config/mise",
  ".tool-versions",
  ".yarnrc.yml",
  ".yarnrc",
  ".yarn/releases",
  ".yarn/plugins",
  ".pnpmfile.cjs",
  "bunfig.toml",
  ".npmrc",
  ".cargo/config.toml",
  ".cargo/config",
  ".devcontainer",
] as const;

/**
 * Named sets of domains `sandbox.run`'s grants may list as one
 * (`@registries`): the package registries installs need, and the hosts their
 * packages download from. Each serves what its publishers upload, as any
 * registry does; none is general file storage or a paste site
 * (`storage.googleapis.com`, `github.com` gists, `raw.githubusercontent.com`
 * stay explicit).
 */
export const SANDBOX_DOMAIN_PRESETS: Readonly<Record<string, readonly string[]>> = {
  "@registries": [
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "static.crates.io",
    "index.crates.io",
    "proxy.golang.org",
    "sum.golang.org",
    "rubygems.org",
    "index.rubygems.org",
    "repo.maven.apache.org",
    "repo1.maven.org",
    "ghcr.io",
    "pkg-containers.githubusercontent.com",
    "playwright.download.prss.microsoft.com",
    "cdn.playwright.dev",
  ],
};

/**
 * A grant of `sandbox.run`'s (`serve --sandbox-domain`, the workspace's
 * `sandbox.domains`) in stored form: a domain (`normalizeSandboxDomain`), or
 * a preset (`@registries`), which only those lists expand.
 */
export function normalizeSandboxGrant(value: string): string | undefined {
  const preset = value.trim().toLowerCase();
  return Object.hasOwn(SANDBOX_DOMAIN_PRESETS, preset) ? preset : normalizeSandboxDomain(value);
}

/** Grants with every preset (`@registries`) replaced by the domains it names. */
export function expandSandboxDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.flatMap((domain) => SANDBOX_DOMAIN_PRESETS[domain] ?? [domain]))];
}

/**
 * A domain `sandbox.run` may reach in its stored form, or
 * `undefined` when `value` is not one: `host`, or `*.domain` for its
 * subdomains (never a bare `*` or `*.tld`), either with `:port`; lower case,
 * no trailing dot. An address is a canonical dotted IPv4 one (`127.1`,
 * `2130706433` or `0x7f.0.0.1` are refused: the proxy would dial them as
 * another address than the grant reads), and never this host's, the
 * unspecified one, a link-local or a metadata one, which the proxy refuses
 * whatever is granted. The operator grants these; a model's run may only ask a
 * person for one (`requestableSandboxDomain`).
 */
export function normalizeSandboxDomain(value: string): string | undefined {
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/\.(?=:\d+$|$)/, "");
  if (domain.length === 0 || domain.length > 260) return undefined;
  const match = SANDBOX_DOMAIN.exec(domain);
  if (match === null) return undefined;
  const host = domain.replace(/:\d+$/, "");
  if (NUMERIC_LABEL.test(host) && (host.startsWith("*.") || !CANONICAL_IPV4.test(host))) return undefined;
  if (neverGranted(host)) return undefined;
  const port = match[1] === undefined ? undefined : Number(match[1]);
  return port === undefined || (port >= 1 && port <= 65_535) ? domain : undefined;
}

/** Hosts no grant opens: paste and file-drop sites, where anything sent is published. */
export const SANDBOX_DENIED_DOMAINS = [
  "pastebin.com",
  "*.pastebin.com",
  "paste.ee",
  "hastebin.com",
  "termbin.com",
  "0x0.st",
  "transfer.sh",
  "file.io",
  "*.file.io",
  "webhook.site",
  "*.webhook.site",
  "requestbin.com",
  "*.requestbin.com",
] as const;

/** How many domains one `sandbox.run` may ask the person for (`requestDomains`). */
export const SANDBOX_REQUEST_DOMAINS_MAX = 8;

/**
 * A domain a `sandbox.run` may ask the person for, in stored form: one host
 * by name, with an optional `:port` — never a pattern, a preset, an address
 * (which the person cannot judge by eye) or a paste site.
 */
export function requestableSandboxDomain(value: string): string | undefined {
  const domain = normalizeSandboxDomain(value);
  if (domain === undefined || domain.startsWith("*.")) return undefined;
  const host = domain.replace(/:\d+$/, "");
  if (CANONICAL_IPV4.test(host)) return undefined;
  const denied = SANDBOX_DENIED_DOMAINS.some((entry) => (entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry));
  return denied ? undefined : domain;
}

/**
 * A credential a network run may use without holding it: the command sees
 * a placeholder in `env`, and the run's proxy puts
 * the real value in its place only on requests to `hosts`, whose TLS it
 * terminates for that. The value travels in `SandboxCommand.secrets`.
 */
export interface SandboxCredential {
  /** The variable the command reads; it holds the placeholder. */
  readonly env: string;
  /** Exact hosts (`api.example.com`), never a pattern or a port (srt matches inject hosts by name alone): the only ones that receive the value. */
  readonly hosts: readonly string[];
  /** The one request header the placeholder may travel in (lower case); default `authorization`. */
  readonly header?: string;
  /** When set, the only methods a request carrying it may use. */
  readonly methods?: readonly string[];
  /** When set, the only path prefixes a request carrying it may reach. */
  readonly pathPrefixes?: readonly string[];
}

export interface SandboxNetworkPolicy {
  readonly allow: boolean;
  readonly allowedHosts?: readonly string[];
  /** Credentials injected by the run's proxy; their hosts must be among `allowedHosts`. */
  readonly credentials?: readonly SandboxCredential[];
}

export interface SandboxResourcePolicy {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Enforced on Linux by the run's cgroup; advisory on macOS. */
  readonly maxMemoryBytes?: number;
  /** Processes and threads together. */
  readonly maxProcesses?: number;
  /** Percent of one core. */
  readonly cpuQuotaPercent?: number;
}

/**
 * What a run may do on this machine itself, beyond files and the network.
 * macOS needs each said (Seatbelt refuses them); on Linux a run's own
 * namespace already allows a pseudo-terminal and binding its own localhost,
 * and its seccomp filter refuses every Unix socket whatever this says.
 */
export interface SandboxLocalPolicy {
  /**
   * Allocate pseudo-terminals (`script`, `expect`, node-pty tests). On macOS
   * this also opens every `/dev/ttys*` of the same user — the person's own
   * terminals — to read and write, so it is an operator's opt-in.
   */
  readonly pty?: boolean;
  /**
   * Folders a run may create and reach Unix sockets in (everything under
   * each): its own scratch, so IPC within the run works and nothing else is
   * reached. Each must lie in one of the policy's write roots.
   */
  readonly unixSocketsIn?: readonly string[];
  /**
   * Listen for connections (srt grants every interface on macOS, so a
   * listener on 0.0.0.0 is reachable from the network) and connect to this
   * host's own ports, the owner's services' too: an operator's opt-in.
   */
  readonly localBinding?: boolean;
}

/** A container engine's socket, or a folder known to hold one: each hands a child the host. */
const ENGINE_SOCKET =
  /(^|\/)\.?(docker|podman|containerd|buildkit|crio|colima|lima|orbstack|rancher)[^/]*$|(^|\/)(var\/)?run$|\/\.(docker|colima|lima|orbstack|rd)(\/|$)/i;

/**
 * Why a confined child may not be given Unix sockets under `path`, or
 * `undefined` when it may: never a container engine's socket or a folder
 * that holds one, and, with `within`, only a folder inside one of those
 * (the child's own writable folders). `path` is canonical.
 */
export function refusedUnixSocketFolder(path: string, within?: readonly string[]): string | undefined {
  if (ENGINE_SOCKET.test(path))
    return `a sandboxed child is never given the Unix sockets in ${path}: a container engine's socket would hand it the host`;
  if (within !== undefined && !within.some((root) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)))
    return `a sandboxed child is given Unix sockets only in a folder it may write, not ${path}`;
  return undefined;
}

export interface SandboxPolicy {
  readonly filesystem: SandboxFilesystemPolicy;
  readonly network: SandboxNetworkPolicy;
  readonly resources: SandboxResourcePolicy;
  readonly local?: SandboxLocalPolicy;
}

export interface SandboxCommand {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Whether the child starts from the caller's environment with `env` laid
   * over it (the default), or from `env` alone. `false` keeps the owner's
   * secrets and settings out of a child that must not see them.
   */
  readonly inheritEnv?: boolean;
  /**
   * Variables the runtime unsets in the child whatever the environment — a
   * backstop for `inheritEnv: false`, so a mis-built `env` still cannot pass
   * a provider key. Names only; each must be a valid identifier.
   */
  readonly denyEnv?: readonly string[];
  /** The real values of `network.credentials`, by `env`: given to the run's proxy only, never to the command. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Text written to the command's standard input, which then closes; absent, it reads end-of-file at once. */
  readonly stdin?: string;
}

export const SANDBOX_SESSION_STATES = ["running", "completed", "failed", "cancelled"] as const;
export type SandboxSessionState = (typeof SANDBOX_SESSION_STATES)[number];

export interface SandboxSessionHandle {
  readonly sessionId: string;
  readonly state: SandboxSessionState;
}

/** Bounded output and artifacts, never an unbounded stream. */
export interface SandboxRunResult {
  readonly session: SandboxSessionHandle;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly artifactIds?: readonly string[];
  /** The tier the run was confined at; `nested` is weaker, and every result says so. */
  readonly tier?: "full" | "nested";
  readonly mechanism?: "seatbelt" | "bubblewrap";
  /** What the sandbox refused, so a refusal reads as policy rather than a bare `EPERM`. */
  readonly violations?: readonly SandboxViolation[];
  /** False where the platform reports only some refusals (Linux: no read denials). */
  readonly violationsComplete?: boolean;
  /** Every host and port a network run asked for, allowed or not (values and bodies never), up to `SANDBOX_REQUESTS_MAX`. */
  readonly requests?: readonly SandboxRequest[];
  /** More distinct hosts and ports were asked for than `requests` keeps. */
  readonly requestsTruncated?: boolean;
  /** What this platform could not express of the run's policy (a write-deny pattern Linux cannot hold, say), each with why. */
  readonly warnings?: readonly string[];
  /** The run was stopped at its timeout, not cancelled. */
  readonly timedOut?: true;
  /** What the run ran into under its resource caps, where the host can tell (`LimitPressure`). */
  readonly limitsHit?: LimitPressure;
}

/**
 * Enforcement of "no unsandboxed fallback" lives entirely in
 * `dispatchSandboxedTool` below, not here — nothing on this interface
 * itself stops a caller holding a `SandboxPort` reference from calling
 * `run` directly, bypassing any tool's `requiresSandbox` declaration.
 * Integrators must route every sandboxed tool call through
 * `dispatchSandboxedTool` and must never hand a raw `SandboxPort` to code
 * that skips it.
 */
export interface SandboxPort {
  capabilities(): SandboxCapabilities;
  run(policy: SandboxPolicy, command: SandboxCommand): Promise<SandboxRunResult>;
  cancel(sessionId: string): Promise<void>;
  dispose(sessionId: string): Promise<void>;
  /** Graceful shutdown: every run in flight is cancelled and waited for. */
  close?(): Promise<void>;
  /** `capabilities()` once the host's check has settled: what a caller deciding before a download awaits. */
  ready?(): Promise<SandboxCapabilities>;
}

/**
 * The dispatch-time gate: a tool that declares a sandbox effect
 * requirement dispatches through `SandboxPort`, and is denied with a typed
 * capability error when no sandbox is configured. A plain function (not
 * baked into `workflow.ts`'s LangGraph dispatch pipeline), so the gate
 * itself is provable and testable in isolation, the same way
 * `boundToolOutput` (`./tools.js`) is a plain function rather than baked
 * into one specific call site.
 */
export async function dispatchSandboxedTool(
  tool: ToolDefinition,
  sandbox: SandboxPort | undefined,
  policy: SandboxPolicy,
  command: SandboxCommand,
): Promise<SandboxRunResult> {
  if (tool.requiresSandbox !== true) {
    throw new TaviError("INVALID_INPUT", `Tool ${tool.id} does not declare requiresSandbox; nothing to gate`);
  }
  // "No unsandboxed fallback" — `command` is never called
  // directly, regardless of how it got here. The two denial cases are
  // kept distinct — "nothing wired up" vs. "wired up but not usable right
  // now" — matching this codebase's existing `NOT_CONFIGURED`/`UNAVAILABLE`
  // convention (`packages/contracts/src/errors.ts`, already applied
  // consistently by `packages/runtime/src/models/config.ts` for model
  // resolution) rather than collapsing both into one code.
  if (sandbox === undefined) {
    throw refusedEarly("NOT_CONFIGURED", `Tool ${tool.id} requires a sandbox, but none is configured`, { toolId: tool.id });
  }
  const capabilities = sandbox.capabilities();
  if (!capabilities.available) {
    // The refusal names the cause and the fix: what the operator reads, not only what a caller parses.
    const cause = capabilities.detail === undefined ? "" : `: ${capabilities.detail}`;
    const fix = capabilities.fix === undefined ? "" : `; fix: ${capabilities.fix}`;
    throw new TaviError("UNAVAILABLE", `Tool ${tool.id} requires a sandbox, but the configured sandbox is unavailable${cause}${fix}`, {
      details: {
        toolId: tool.id,
        ...(capabilities.detail === undefined ? {} : { detail: capabilities.detail }),
        ...(capabilities.fix === undefined ? {} : { fix: capabilities.fix }),
      },
    });
  }
  return sandbox.run(policy, command);
}
