/**
 * Confining a long-lived child: what an MCP stdio server, the PDF engine's
 * children and,
 * later, plugin workers and the browser use of a sandbox, and what a sandbox
 * package implements. `@tavi/plugin-sandbox` implements it with one srt
 * process per child; the owner chooses an implementation in one place
 * (`apps/cli/src/features/sandbox/host.ts`), and nothing else imports it.
 *
 * `SandboxPort` stays the port for a rendered command with capped string
 * output; this one wraps a child whose stdio the caller keeps (binary frames,
 * JSON-RPC), so it returns a command to spawn rather than running it.
 */

/** What a confined child may touch. Reads are allowed unless denied; writes only where allowed. */
export interface ConfinementPolicy {
  /** Read-denied, except where an `allowRead` entry nested inside re-opens it. */
  readonly denyRead: readonly string[];
  readonly allowRead: readonly string[];
  /** The only places the child may write. */
  readonly allowWrite: readonly string[];
  /** The hosts it may reach; none reaches nothing. */
  readonly domains: readonly string[];
  /** The weaker nested mode, for a container that cannot nest namespaces: the operator's choice, never automatic. */
  readonly nested: boolean;
  /**
   * Variables of the launch's `env` the child never sees: it
   * reads a placeholder instead, and its proxy puts the value in only toward
   * `hosts` (exact hosts, no port), whose TLS alone it decrypts.
   */
  readonly credentials?: readonly { readonly env: string; readonly hosts: readonly string[] }[];
  /**
   * Folders the child may bind and connect Unix sockets in (the browser's
   * process singleton). macOS filters these by path; srt's Linux filter
   * refuses every `socket(AF_UNIX)` whatever this says.
   */
  readonly unixSockets?: readonly string[];
  /**
   * The child reaches no private (RFC 1918, unique-local) or carrier-grade
   * NAT address — by number, or by a name that resolves to one, connecting to
   * the address that was checked — besides the loopback, link-local and
   * metadata addresses no child reaches. `except` lists the addresses the
   * operator opened (an IP literal, optionally with `:port`). Absent: a child
   * granted every host (the browser) reaches the private network.
   */
  readonly privateAddresses?: { readonly except: readonly string[] };
}

/** A child's launch, before confinement. */
export interface ConfinedLaunch {
  readonly argv: readonly string[];
  /** The child's own environment; its `TMPDIR` is set inside the sandbox. */
  readonly env: Readonly<Record<string, string>>;
  /** An owner-private file the implementation records the policy in, written whole before the command is returned. */
  readonly policyFile: string;
  readonly policy: ConfinementPolicy;
}

/** What to spawn in the child's place. */
export interface ConfinedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /**
   * When the child must be started again (epoch ms): its credentials' proxy
   * CA, loaded once at start, runs out a day later. Absent: it may run on.
   */
  readonly renewBy?: number;
}

export interface ConfinementPort {
  /**
   * `launch`'s child wrapped to run under its policy. The interpreter the
   * owner runs on and the implementation's own helpers stay readable whatever
   * `denyRead` says, so a Node child can start.
   */
  wrap(launch: ConfinedLaunch): ConfinedCommand;
}
