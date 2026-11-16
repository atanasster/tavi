/**
 * Resource limits: what a
 * confined or unconfined child may use of the host, so no command, server,
 * worker, browser, PDF or video child can take the owner down on 1 GiB. A limits
 * package implements it (`@tavi/plugin-limits`: delegated cgroups, the
 * `systemd-run --user` rung, or none); the owner chooses one in
 * `apps/cli/src/features/sandbox/host.ts`, and consumers see only this port.
 */

/** Who the limits are for: each has its own default, `pids.max` above all (threads count). */
export const LIMIT_WORKLOADS = ["run", "server", "worker", "browser", "pdf", "video"] as const;
export type LimitWorkload = (typeof LIMIT_WORKLOADS)[number];

/** A child's caps; what is left out takes its workload's default. */
export interface ResourceLimits {
  readonly memoryBytes?: number;
  /** Processes and threads together (`pids.max`). */
  readonly processes?: number;
  /** Percent of one core, 1-100 per core (`cpu.max`). */
  readonly cpuPercent?: number;
}

/** How a limit is held on this host: by the kernel, only watched, or not at all. */
export type LimitEnforcement = "enforced" | "advisory" | "unavailable";

export interface ResourceLimitCapabilities {
  readonly memory: LimitEnforcement;
  readonly pids: LimitEnforcement;
  readonly cpu: LimitEnforcement;
  /** Which mechanism: the service's delegated cgroup, a user manager's transient scope, or none. */
  readonly rung: "delegated" | "systemd-run" | "none";
  /** What every sandbox together may use (`sbx/memory.max`), where it is known. */
  readonly aggregateMemoryBytes?: number;
  readonly detail?: string;
}

/** What a child that could not enter its group prints, and the code it exits with, never having run its command. */
export const LIMITS_ENTRY_FAILED = "tavi-limits: could not enter";
export const LIMITS_ENTRY_FAILED_EXIT = 125;

/** What a child ran into under its caps: a fork refused at `pids.max`, time held back by `cpu.max`. */
export interface LimitPressure {
  readonly pidsExhausted?: true;
  readonly cpuThrottledMs?: number;
}

/** A child's argv, placed: it enters its group before it runs anything. */
export interface PlacedLaunch {
  readonly argv: readonly string[];
  /** The group it runs in, for `kill`, `outcome` and `release`; absent where nothing places it. */
  readonly groupId?: string;
}

export interface ResourceLimitPort {
  capabilities(): ResourceLimitCapabilities;
  /**
   * `argv` prefixed so the child enters a group of its own, with `limits`
   * over its workload's defaults, before it runs anything. Refused
   * (`QUOTA_EXCEEDED`, naming what holds the memory) when it would not
   * fit under what every sandbox together may use.
   */
  place(argv: readonly string[], workload: LimitWorkload, limits?: ResourceLimits): PlacedLaunch;
  /** Every process in the group, at once, race-free against fork and `setsid`. */
  kill(groupId: string): void;
  /** Why the group's processes ended, when the kernel ended them: an OOM kill. */
  outcome(groupId: string): "oom" | undefined;
  /** What the group ran into short of being killed, before it is released: where the host can tell. */
  pressure?(groupId: string): LimitPressure | undefined;
  /** Removes the group once it is empty; a group still holding processes is killed first. */
  release(groupId: string): void;
}
