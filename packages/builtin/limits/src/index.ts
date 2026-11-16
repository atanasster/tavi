import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { dirname, join } from "node:path";

import {
  LIMITS_ENTRY_FAILED,
  LIMITS_ENTRY_FAILED_EXIT,
  TaviError,
  VIDEO_LIMITS,
  type LimitWorkload,
  type ResourceLimitCapabilities,
  type ResourceLimitPort,
  type ResourceLimits,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

/**
 * Resource limits: every sandboxed
 * run, MCP server, worker, browser and PDF child in a cgroup of its own under
 * one aggregate parent, so no one of them — and not all of them together —
 * can take the owner down on 1 GiB.
 *
 * The rungs, in order:
 * - **delegated**: the service's delegated cgroup v2 subtree (`Delegate=`,
 *   `DelegateSubgroup=owner`, which needs `User=`). The owner sits in
 *   `owner/` (moved there itself on systemd < 254), every sandbox under
 *   `sbx/`, whose `memory.max` caps them all together; `owner/` keeps
 *   `memory.low` and a higher `cpu.weight`.
 * - **systemd-run**: a transient `systemd-run --user --scope` per child,
 *   where a user manager runs (a desktop).
 * - **none**: nothing enforces; `doctor` says so.
 *
 * A child enters its group itself, before it runs anything: its argv is
 * prefixed with a `/bin/sh` that writes `0` to the group's `cgroup.procs`
 * and then `exec`s, so a fast exec and every descendant are inside
 * (placing a pid after `spawn()` races the exec; `CLONE_INTO_CGROUP` is not
 * reachable from Node). Teardown writes `1` to `cgroup.kill`, which no
 * `setsid` or fork outruns.
 */

/** What the module reads and writes of cgroupfs (tests replace it). */
export interface CgroupFs {
  read(path: string): string | undefined;
  write(path: string, value: string): void;
  mkdir(path: string): void;
  rmdir(path: string): void;
  list(path: string): readonly string[];
}

export const nodeCgroupFs: CgroupFs = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  write(path, value) {
    writeFileSync(path, value);
  },
  mkdir(path) {
    mkdirSync(path, { mode: 0o755 });
  },
  rmdir(path) {
    rmdirSync(path);
  },
  list(path) {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
};

const MIB = 1024 * 1024;

/**
 * `sandbox.run`'s defaults, sized for a build or a test suite: a quarter of
 * the host's memory, from 256 MiB to 2 GiB (so a small host keeps what it
 * had, and every child together still fits under the aggregate), 1024
 * processes and threads (a test runner's workers each hold a dozen), and two
 * cores where the host has them.
 */
export function runDefaults(totalBytes: number = totalmem(), cores: number = availableParallelism()): Required<ResourceLimits> {
  return {
    memoryBytes: Math.min(Math.max(Math.floor(totalBytes / 4 / MIB) * MIB, 256 * MIB), 2048 * MIB),
    processes: 1024,
    cpuPercent: Math.min(200, Math.max(cores, 1) * 100),
  };
}

/** Each workload's defaults: `pids.max` counts threads, so it is set per workload. */
export const WORKLOAD_DEFAULTS: Readonly<Record<LimitWorkload, Required<ResourceLimits>>> = {
  run: runDefaults(),
  server: { memoryBytes: 192 * MIB, processes: 256, cpuPercent: 80 },
  worker: { memoryBytes: 256 * MIB, processes: 256, cpuPercent: 80 },
  browser: { memoryBytes: 512 * MIB, processes: 1024, cpuPercent: 80 },
  pdf: { memoryBytes: 512 * MIB, processes: 64, cpuPercent: 80 },
  // The video decoder and analysers: srt's Node, bwrap and FFmpeg's threads share 64 pids, as the PDF child's do.
  video: { memoryBytes: VIDEO_LIMITS.childMemoryMb * MIB, processes: VIDEO_LIMITS.processes, cpuPercent: 80 },
};

/** What the OS keeps for itself out of the unit's memory, and what the owner is promised. */
const OS_HEADROOM_BYTES = 128 * MIB;
const OWNER_FLOOR_BYTES = 192 * MIB;
const CONTROLLERS = ["memory", "pids", "cpu"] as const;
/** How long a new group counts at its cap toward the aggregate, before its `memory.current` is what it holds. */
const STARTUP_GRACE_MS = 10_000;

export interface LimitsOptions {
  /** Operator overrides for every workload (`serve --sandbox-memory`, `--sandbox-pids`, `--sandbox-cpu`). */
  readonly defaults?: Partial<Record<LimitWorkload, ResourceLimits>>;
  /** The platform (tests replace it). */
  readonly platform?: NodeJS.Platform;
  readonly fs?: CgroupFs;
  /** Where cgroup v2 is mounted. */
  readonly mount?: string;
  /** This process's `/proc/self/cgroup` (tests replace it). */
  readonly selfCgroup?: () => string | undefined;
  /** Whether a user manager answers `systemd-run --user` (tests replace it). */
  readonly userManager?: () => boolean;
  /** Total memory, when the unit sets no `memory.max`. */
  readonly totalMemory?: () => number;
  /** The kernel release (tests replace it): `cgroup.kill` needs 5.14. */
  readonly osRelease?: () => string;
  /** Runs `systemctl --user` for the scope rung (tests replace it). */
  readonly systemctl?: (args: readonly string[]) => { readonly status: number | null; readonly stdout: string };
}

/** A cgroup file's value as a number of bytes, or undefined for `max` or nothing. */
function bytesOf(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (text === undefined || text === "" || text === "max") return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

/** The delegated subtree, set up: where sandboxes go, and what they may use together. */
interface Delegated {
  readonly root: string;
  readonly sbx: string;
  readonly aggregate: number;
  /** `cgroup.kill` exists (Linux 5.14+); otherwise a group is emptied pid by pid. */
  readonly canKill: boolean;
}

/** A write that may fail without the rung failing. */
function optional(fs: CgroupFs, path: string, value: string): void {
  try {
    fs.write(path, value);
  } catch {
    // Not on this kernel or configuration.
  }
}

/** Whether a kernel release has `cgroup.kill` (5.14+): the file is write-only, so its presence cannot be read. */
function hasCgroupKill(release: string): boolean {
  const [major = 0, minor = 0] = (/^(\d+)\.(\d+)/.exec(release)?.slice(1) ?? []).map(Number);
  return major > 5 || (major === 5 && minor >= 14);
}

function osRelease(): string {
  try {
    return readFileSync("/proc/sys/kernel/osrelease", "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The service's delegated subtree, made ready: the owner in
 * `owner/` (moved there itself when `DelegateSubgroup=` did not), controllers
 * on for the children, `sbx/` with the aggregate cap, the owner protected.
 * Undefined when this process has no delegated cgroup it may write.
 */
function setUpDelegation(
  fs: CgroupFs,
  mount: string,
  self: string | undefined,
  totalMemory: number,
  release: string,
): Delegated | undefined {
  const own = /^0::(\/.*)$/m.exec(self ?? "")?.[1]?.trim();
  if (own === undefined) return undefined;
  const ownPath = join(mount, own);
  const inOwner = own.endsWith("/owner");
  const root = inOwner ? dirname(ownPath) : ownPath;
  // Only a cgroup that is Tavi's alone is divided: a service's, or a container's whole namespace (`0::/`);
  // a terminal's session scope holds the person's shell too.
  if (!/\.service$/.test(root) && own !== "/") return undefined;
  const available = (fs.read(join(root, "cgroup.controllers")) ?? "").trim().split(/\s+/);
  if (!CONTROLLERS.every((name) => available.includes(name))) return undefined;
  try {
    if (!inOwner) {
      // systemd < 254, or a user scope: the owner moves itself (and anything it already started) into `owner/`,
      // since a group with processes in it cannot hand controllers to its children ("no internal processes").
      const owner = join(root, "owner");
      if (fs.read(join(owner, "cgroup.procs")) === undefined) fs.mkdir(owner);
      for (const pid of (fs.read(join(root, "cgroup.procs")) ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""))
        fs.write(join(owner, "cgroup.procs"), pid);
    }
    fs.write(join(root, "cgroup.subtree_control"), CONTROLLERS.map((name) => `+${name}`).join(" "));
    const sbx = join(root, "sbx");
    if (fs.read(join(sbx, "cgroup.procs")) === undefined) fs.mkdir(sbx);
    fs.write(join(sbx, "cgroup.subtree_control"), CONTROLLERS.map((name) => `+${name}`).join(" "));
    // What every sandbox together may use: the unit's budget less the owner's working set and the OS's headroom.
    const budget = bytesOf(fs.read(join(root, "memory.max"))) ?? totalMemory;
    const ownerUse = Math.max(
      bytesOf(fs.read(join(root, "owner", "memory.peak"))) ?? bytesOf(fs.read(join(root, "owner", "memory.current"))) ?? 0,
      OWNER_FLOOR_BYTES,
    );
    const aggregate = Math.max(budget - ownerUse - OS_HEADROOM_BYTES, 64 * MIB);
    fs.write(join(sbx, "memory.max"), String(aggregate));
    // Best effort: swap accounting may be off, and an older kernel may lack a file; the caps above are what bound.
    optional(fs, join(sbx, "memory.swap.max"), "0");
    optional(fs, join(root, "owner", "memory.low"), String(ownerUse));
    // The owner stays responsive on one vCPU while a sandbox spins.
    optional(fs, join(root, "owner", "cpu.weight"), "200");
    optional(fs, join(sbx, "cpu.weight"), "100");
    return { root, sbx, aggregate, canKill: hasCgroupKill(release) };
  } catch {
    return undefined;
  }
}

function userManagerAnswers(): boolean {
  if (process.env["XDG_RUNTIME_DIR"] === undefined) return false;
  const probe = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "true"], { stdio: "ignore", timeout: 5_000 });
  return probe.status === 0;
}

/** The shell that enters the group and execs: a failed entry fails closed with a line the owner recognises (contracts' `LIMITS_ENTRY_FAILED`). */
export const ENTER_GROUP = `echo 0 > "$1/cgroup.procs" 2>/dev/null || { echo "${LIMITS_ENTRY_FAILED} $1" >&2; exit ${String(LIMITS_ENTRY_FAILED_EXIT)}; }; shift; exec "$@"`;

/** The limits port for this host: the first rung of the fallback ladder that works. */
export function createResourceLimits(options: LimitsOptions = {}): ResourceLimitPort {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? nodeCgroupFs;
  const defaults = (workload: LimitWorkload): Required<ResourceLimits> => ({
    ...WORKLOAD_DEFAULTS[workload],
    ...options.defaults?.[workload],
  });
  const systemctl =
    options.systemctl ??
    ((args: readonly string[]) => {
      const run = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 5_000 });
      return { status: run.status, stdout: run.stdout ?? "" };
    });
  // What needs no answer (a scope's kill, its unit forgotten) runs in the background: the owner never waits on systemd.
  const systemctlInBackground =
    options.systemctl === undefined
      ? (args: readonly string[]): void => {
          const child = spawn("systemctl", ["--user", ...args], { stdio: "ignore", timeout: 5_000 });
          child.on("error", () => undefined);
          child.unref();
        }
      : (args: readonly string[]): void => void options.systemctl?.(args);
  let delegated: Delegated | undefined;
  let rung: ResourceLimitCapabilities["rung"] = "none";
  let resolved = false;
  /** The rung, found at first use: a short command that never places a child never sets up a cgroup or asks systemd. */
  const resolve = (): void => {
    if (resolved) return;
    resolved = true;
    if (platform !== "linux") return;
    delegated = setUpDelegation(
      fs,
      options.mount ?? "/sys/fs/cgroup",
      (options.selfCgroup ?? (() => fs.read("/proc/self/cgroup")))(),
      (options.totalMemory ?? totalmem)(),
      (options.osRelease ?? osRelease)(),
    );
    rung = delegated !== undefined ? "delegated" : (options.userManager ?? userManagerAnswers)() ? "systemd-run" : "none";
  };
  const groups = new Map<
    string,
    {
      readonly path?: string;
      readonly scope?: string;
      readonly memory: number;
      readonly workload: LimitWorkload;
      readonly placedAt: number;
    }
  >();

  function capabilities(): ResourceLimitCapabilities {
    resolve();
    if (rung === "delegated")
      return {
        memory: "enforced",
        pids: "enforced",
        cpu: "enforced",
        rung,
        ...(delegated === undefined ? {} : { aggregateMemoryBytes: delegated.aggregate }),
        ...(delegated?.canKill === false
          ? { detail: "this kernel has no cgroup.kill (before 5.14): a group is emptied pid by pid, which a fork can outrun" }
          : {}),
      };
    if (rung === "systemd-run")
      return {
        memory: "enforced",
        pids: "enforced",
        cpu: "enforced",
        rung,
        detail: "each child in its own systemd --user scope; no aggregate cap for every sandbox together",
      };
    return {
      memory: platform === "linux" ? "unavailable" : "advisory",
      pids: "unavailable",
      cpu: "unavailable",
      rung,
      detail:
        platform === "linux"
          ? "no delegated cgroup and no user manager: run Tavi under the generated unit (tavi service unit --kind systemd), which delegates one"
          : `${platform} has no cgroups: a PDF child's memory is watched, nothing else is bounded`,
    };
  }

  /**
   * What a group holds toward the aggregate: its `memory.current`, so an idle
   * worker or server kept warm counts at what it uses, not at its cap. A group
   * still starting (or one whose file cannot be read) counts at its cap, so a
   * burst of placements cannot all be admitted against groups not yet grown.
   */
  function held(group: { readonly path?: string; readonly memory: number; readonly placedAt: number }): number {
    if (group.path === undefined || Date.now() - group.placedAt < STARTUP_GRACE_MS) return group.memory;
    return Math.min(bytesOf(fs.read(join(group.path, "memory.current"))) ?? group.memory, group.memory);
  }

  /** Refused up front when it would not fit beside what every sandbox already placed holds. */
  function admit(memory: number, workload: LimitWorkload): void {
    if (delegated === undefined) return;
    const holding = [...groups.entries()]
      .filter(([, group]) => group.path !== undefined)
      .map(([id, group]) => ({ id, workload: group.workload, bytes: held(group) }));
    const reserved = holding.reduce((total, group) => total + group.bytes, 0);
    if (reserved + memory <= delegated.aggregate) return;
    const holders = holding.map((group) => `${group.id} (${group.workload}, ${String(Math.round(group.bytes / MIB))} MiB)`).join(", ");
    throw new TaviError(
      "QUOTA_EXCEEDED",
      `a ${workload} needs ${String(Math.round(memory / MIB))} MiB, and every sandbox together may hold ${String(Math.round(delegated.aggregate / MIB))} MiB: ${holders === "" ? "nothing else" : holders} holds the rest; wait for one to finish`,
      { details: { workload, aggregateBytes: delegated.aggregate, reservedBytes: reserved } },
    );
  }

  return {
    capabilities,

    place(argv, workload, limits) {
      resolve();
      const caps: { memoryBytes: number; processes: number; cpuPercent: number } = { ...defaults(workload), ...limits };
      // sandbox.run's default memory is sized from the host's RAM; under a unit or container capped lower it
      // takes at most half of what every sandbox together may hold, so a run always fits alone. A cap the
      // operator or the caller set is left as given.
      if (
        workload === "run" &&
        delegated !== undefined &&
        limits?.memoryBytes === undefined &&
        options.defaults?.run?.memoryBytes === undefined
      )
        caps.memoryBytes = Math.min(caps.memoryBytes, Math.max(Math.floor(delegated.aggregate / 2 / MIB) * MIB, 64 * MIB));
      const id = `${workload}-${randomBytes(6).toString("hex")}`;
      if (rung === "delegated" && delegated !== undefined) {
        admit(caps.memoryBytes, workload);
        const path = join(delegated.sbx, id);
        fs.mkdir(path);
        try {
          fs.write(join(path, "memory.max"), String(caps.memoryBytes));
          optional(fs, join(path, "memory.swap.max"), "0");
          // One OOM ends the whole group, not one process of it.
          optional(fs, join(path, "memory.oom.group"), "1");
          fs.write(join(path, "pids.max"), String(caps.processes));
          fs.write(join(path, "cpu.max"), `${String(caps.cpuPercent * 1_000)} 100000`);
        } catch (error) {
          // Nothing half made is left behind, nor reserved.
          try {
            fs.rmdir(path);
          } catch {
            // Already gone.
          }
          throw new TaviError("UNAVAILABLE", `the ${workload}'s cgroup could not be set up: ${errorMessage(error)}`, {
            details: { workload },
          });
        }
        groups.set(id, { path, memory: caps.memoryBytes, workload, placedAt: Date.now() });
        return { argv: ["/bin/sh", "-c", ENTER_GROUP, "sh", path, ...argv], groupId: id };
      }
      if (rung === "systemd-run") {
        const scope = `tavi-sbx-${id}`;
        groups.set(id, { scope, memory: caps.memoryBytes, workload, placedAt: Date.now() });
        // systemd-run reaches the user manager through the owner's bus; the child's own environment never gets it.
        const bus = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((name) =>
          process.env[name] === undefined ? [] : [`${name}=${process.env[name] as string}`],
        );
        return {
          argv: [
            "/usr/bin/env",
            ...bus,
            "systemd-run",
            "--user",
            "--scope",
            "--quiet",
            `--unit=${scope}`,
            "-p",
            `MemoryMax=${String(caps.memoryBytes)}`,
            "-p",
            "MemorySwapMax=0",
            "-p",
            `TasksMax=${String(caps.processes)}`,
            "-p",
            `CPUQuota=${String(caps.cpuPercent)}%`,
            "--",
            "/usr/bin/env",
            "-u",
            "XDG_RUNTIME_DIR",
            "-u",
            "DBUS_SESSION_BUS_ADDRESS",
            ...argv,
          ],
          groupId: id,
        };
      }
      return { argv: [...argv] };
    },

    kill(groupId) {
      const group = groups.get(groupId);
      if (group?.path !== undefined) killGroupAt(fs, group.path, delegated?.canKill !== false);
      else if (group?.scope !== undefined) systemctlInBackground(["kill", "--signal=SIGKILL", `${group.scope}.scope`]);
    },

    outcome(groupId) {
      const group = groups.get(groupId);
      if (group?.path !== undefined) {
        const killed = /^oom_kill (\d+)$/m.exec(fs.read(join(group.path, "memory.events")) ?? "")?.[1];
        return killed !== undefined && Number(killed) > 0 ? "oom" : undefined;
      }
      if (group?.scope !== undefined)
        return /^Result=oom-kill$/m.test(systemctl(["show", "-p", "Result", `${group.scope}.scope`]).stdout) ? "oom" : undefined;
      return undefined;
    },

    pressure(groupId) {
      const path = groups.get(groupId)?.path;
      if (path === undefined) return undefined;
      // `pids.events`' `max` counts forks refused at `pids.max`; `cpu.stat`'s `throttled_usec` the time `cpu.max` held back.
      const refused = Number(/^max (\d+)$/m.exec(fs.read(join(path, "pids.events")) ?? "")?.[1] ?? 0);
      const throttled = Number(/^throttled_usec (\d+)$/m.exec(fs.read(join(path, "cpu.stat")) ?? "")?.[1] ?? 0);
      const pressure = {
        ...(refused > 0 ? { pidsExhausted: true as const } : {}),
        ...(throttled >= 1_000_000 ? { cpuThrottledMs: Math.round(throttled / 1_000) } : {}),
      };
      return Object.keys(pressure).length === 0 ? undefined : pressure;
    },

    release(groupId) {
      const group = groups.get(groupId);
      if (group === undefined) return;
      groups.delete(groupId);
      if (group.path === undefined) {
        // A scope: its processes killed, then the unit forgotten (kept until now so `outcome` could read its Result).
        if (group.scope !== undefined) {
          // In order: the unit is forgotten once its processes are killed.
          systemctlInBackground(["kill", "--signal=SIGKILL", `${group.scope}.scope`]);
          // Kept referenced: a one-shot command still forgets the unit before it exits.
          setTimeout(() => systemctlInBackground(["reset-failed", `${group.scope}.scope`]), 1_000);
        }
        return;
      }
      const path = group.path;
      // A group still holding processes (a setsid escapee) goes whole; rmdir follows once the kernel empties it.
      if (/^populated 1$/m.test(fs.read(join(path, "cgroup.events")) ?? "")) killGroupAt(fs, path, delegated?.canKill !== false);
      const remove = (attempt: number): void => {
        try {
          fs.rmdir(path);
        } catch {
          if (attempt < 20) setTimeout(() => remove(attempt + 1), 50).unref();
        }
      };
      remove(0);
    },
  };
}

/** Every process in the group at `path` killed: by `cgroup.kill` where the kernel has it, else pid by pid. */
function killGroupAt(fs: CgroupFs, path: string, canKill: boolean): void {
  if (canKill) {
    try {
      fs.write(join(path, "cgroup.kill"), "1");
      return;
    } catch {
      // Older than 5.14, or gone: by pid below.
    }
  }
  for (let round = 0; round < 5; round += 1) {
    const pids = (fs.read(join(path, "cgroup.procs")) ?? "")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

/** Sandboxes a previous owner left in `sbx/` (it was killed): emptied and removed at start. */
export function sweepStaleGroups(options: Pick<LimitsOptions, "fs" | "mount" | "selfCgroup"> = {}): void {
  const fs = options.fs ?? nodeCgroupFs;
  const own = /^0::(\/.*)$/m.exec((options.selfCgroup ?? (() => fs.read("/proc/self/cgroup")))() ?? "")?.[1]?.trim();
  if (own === undefined) return;
  const ownPath = join(options.mount ?? "/sys/fs/cgroup", own);
  const sbx = join(own.endsWith("/owner") ? dirname(ownPath) : ownPath, "sbx");
  for (const name of fs.list(sbx)) {
    const path = join(sbx, name);
    try {
      killGroupAt(fs, path, true);
      fs.rmdir(path);
    } catch {
      // Still emptying, or not ours to remove: the next start tries again.
    }
  }
}
