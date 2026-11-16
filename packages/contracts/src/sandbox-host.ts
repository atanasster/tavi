/**
 * Host detection: whether this host can confine at all, at which tier, and
 * why not, with the fix. Every consumer — `sandbox.run`, MCP stdio servers,
 * the PDF engine's children, `doctor` — reads one answer, so a host gets one
 * cause and one fix. `@tavi/plugin-sandbox` implements it; the owner chooses
 * an implementation in `apps/cli/src/features/sandbox/host.ts`.
 */

/**
 * `full`: every namespace, a fresh `/proc`, seccomp, and the live probe
 * passed. `nested`: the operator's weaker mode for a container that masks
 * `/proc`. `unavailable`: anything else, with a cause and fix. `checking`:
 * before the first probe settles.
 */
export const SANDBOX_TIERS = ["full", "nested", "unavailable", "checking"] as const;
export type SandboxTier = (typeof SANDBOX_TIERS)[number];

/** One line of the host's check: a hard error refuses the tier, a warning does not. */
export interface SandboxHostCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly severity?: "error" | "warning";
  readonly detail?: string;
}

export interface SandboxStatus {
  readonly tier: SandboxTier;
  /** What confines here: Seatbelt on macOS, bubblewrap on Linux. */
  readonly mechanism?: "seatbelt" | "bubblewrap";
  readonly checks: readonly SandboxHostCheck[];
  /** Why the tier is `unavailable`. */
  readonly cause?: string;
  /** What the operator runs to fix it. */
  readonly fix?: string;
}

/** Facts about this host the sandbox's failures are read against: what `doctor` and `tavi sandbox setup` print and plan from. */
export interface SandboxHostFacts {
  /** `process.platform`'s value. */
  readonly platform: string;
  readonly inContainer: boolean;
  /** Ubuntu 23.10+: `kernel.apparmor_restrict_unprivileged_userns = 1`. */
  readonly appArmorRestrictsUserNamespaces: boolean;
  readonly userNamespacesDisabled: boolean;
  readonly kernelRelease?: string;
  /** `/etc/os-release`'s `ID` and `VERSION_ID`, e.g. `ubuntu` and `24.04`. */
  readonly distribution?: { readonly id: string; readonly version?: string };
  readonly lsm?: readonly string[];
  /** The kernel has seccomp and srt ships a filter for this architecture. */
  readonly seccompAvailable?: boolean;
  /** How many seccomp filters this process runs under (`/proc/self/status` `Seccomp_filters`): the generated unit's `RestrictAddressFamilies=` adds one. */
  readonly seccompFilters?: number;
  readonly euid?: number;
  /** `CAP_SETFCAP` (bit 31) in the bounding set: what srt needs to map uid 0 when it runs as root. */
  readonly capSetfcapInBounding?: boolean;
  /** The bubblewrap srt will run, and whose it is. */
  readonly bwrap?: { readonly path: string; readonly version?: string; readonly owner: "tavi" | "distribution" };
  readonly socat?: string;
  readonly rg?: string;
  /** WSL's generation when this is WSL. */
  readonly wsl?: 1 | 2;
  /** Whether a socket family other than `AF_UNIX`, `AF_INET`, `AF_INET6` and `AF_NETLINK` can be made: `AF_ALG` is the one tried; undefined when nothing could try. */
  readonly socketFamiliesRestricted?: boolean;
  readonly cgroupV2?: boolean;
  /** Controllers available to this process's cgroup (`cgroup.controllers` of its own group). */
  readonly cgroupControllers?: readonly string[];
}

export interface SandboxHostPort {
  /** The last settled answer, synchronously: `checking` before the first. */
  current(): SandboxStatus;
  /** Detection and the live probe, run afresh; the answer becomes `current()`. `nested` probes the weaker mode. */
  check(options?: { readonly nested?: boolean }): Promise<SandboxStatus>;
  /**
   * When the last answer is a failure older than `olderThanMs`, a fresh check of the owner's own
   * mode — one shared by every caller while it runs — whose answer becomes `current()`; otherwise
   * `undefined`. What a run refused on a stale failure awaits, so a host fixed meanwhile runs it.
   */
  recheck?(olderThanMs: number): Promise<SandboxStatus> | undefined;
  /** This host's facts, read now, from the same source `check()` reads them: what `doctor` prints, so an override is the host it describes. */
  facts(): Promise<SandboxHostFacts>;
}

/** Whether a status lets a confined child run. */
export function sandboxConfines(status: SandboxStatus): boolean {
  return status.tier === "full" || status.tier === "nested";
}
