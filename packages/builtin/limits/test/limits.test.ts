import { TaviError } from "@tavi/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  ENTER_GROUP,
  WORKLOAD_DEFAULTS,
  createResourceLimits as createLimits,
  runDefaults,
  sweepStaleGroups,
  type CgroupFs,
} from "../src/index.js";

/**
 * The limits port with `sandbox.run`'s caps fixed at 256 MiB, 128 processes and 80% of a core, so the
 * cgroup mechanics below read the same on every host (the real defaults follow the host: `runDefaults`).
 */
const RUN_CAPS = { memoryBytes: 256 * 1024 * 1024, processes: 128, cpuPercent: 80 };
const createResourceLimits = (options: Parameters<typeof createLimits>[0] = {}): ReturnType<typeof createLimits> =>
  createLimits({ ...options, defaults: { ...options.defaults, run: { ...RUN_CAPS, ...options.defaults?.run } } });

/** Resource limits over a fake cgroupfs, so the ladder is tested anywhere. */

const MIB = 1024 * 1024;

/** A cgroupfs of files; a directory exists once its `cgroup.procs` does. */
function fakeCgroupFs(files: Record<string, string>): CgroupFs & { readonly files: Record<string, string>; readonly writes: string[] } {
  const writes: string[] = [];
  return {
    files,
    writes,
    read: (path) => files[path],
    write: (path, value) => {
      writes.push(`${path}=${value}`);
      if (path.endsWith("/cgroup.procs")) files[path] = `${files[path] ?? ""}${value}\n`;
      else files[path] = value;
    },
    mkdir: (path) => {
      files[`${path}/cgroup.procs`] = "";
      files[`${path}/cgroup.controllers`] = "memory pids cpu";
    },
    rmdir: (path) => {
      for (const key of Object.keys(files)) if (key.startsWith(`${path}/`)) delete files[key];
    },
    list: (path) => [
      ...new Set(
        Object.keys(files)
          .filter((key) => key.startsWith(`${path}/`) && key.slice(path.length + 1).includes("/"))
          .map((key) => key.slice(path.length + 1).split("/")[0] as string),
      ),
    ],
  };
}

const UNIT = "/sys/fs/cgroup/system.slice/tavi.service";

/** A unit delegated with `DelegateSubgroup=owner` (systemd 254+). */
function delegatedUnit(extra: Record<string, string> = {}): ReturnType<typeof fakeCgroupFs> {
  return fakeCgroupFs({
    [`${UNIT}/cgroup.controllers`]: "cpuset cpu io memory pids",
    [`${UNIT}/cgroup.procs`]: "",
    [`${UNIT}/memory.max`]: String(1024 * MIB),
    [`${UNIT}/owner/cgroup.procs`]: "4242\n",
    [`${UNIT}/owner/memory.peak`]: String(300 * MIB),
    ...extra,
  });
}

describe("the delegated rung", () => {
  it("turns the controllers on, caps every sandbox together, and protects the owner", () => {
    const fs = delegatedUnit();
    const limits = createResourceLimits({
      platform: "linux",
      fs,
      selfCgroup: () => "0::/system.slice/tavi.service/owner\n",
      osRelease: () => "6.8.0",
    });
    expect(limits.capabilities()).toEqual({
      memory: "enforced",
      pids: "enforced",
      cpu: "enforced",
      rung: "delegated",
      aggregateMemoryBytes: (1024 - 300 - 128) * MIB,
    });
    expect(fs.files[`${UNIT}/cgroup.subtree_control`]).toBe("+memory +pids +cpu");
    expect(fs.files[`${UNIT}/sbx/cgroup.subtree_control`]).toBe("+memory +pids +cpu");
    expect(fs.files[`${UNIT}/owner/memory.low`]).toBe(String(300 * MIB));
    expect(fs.files[`${UNIT}/owner/cpu.weight`]).toBe("200");
    expect(fs.files[`${UNIT}/sbx/cpu.weight`]).toBe("100");
  });

  it("moves the owner into owner/ itself where systemd did not (< 254)", () => {
    const fs = delegatedUnit({ [`${UNIT}/cgroup.procs`]: "4242\n4300\n" });
    delete fs.files[`${UNIT}/owner/cgroup.procs`];
    createResourceLimits({
      platform: "linux",
      fs,
      selfCgroup: () => "0::/system.slice/tavi.service\n",
      osRelease: () => "6.8.0",
    }).capabilities();
    expect(fs.files[`${UNIT}/owner/cgroup.procs`]).toBe("4242\n4300\n");
    // Only after the root is empty of processes may its children have controllers.
    const moved = fs.writes.findIndex((write) => write.startsWith(`${UNIT}/owner/cgroup.procs=4300`));
    const enabled = fs.writes.findIndex((write) => write.startsWith(`${UNIT}/cgroup.subtree_control=`));
    expect(moved).toBeLessThan(enabled);
  });

  it("sizes sandbox.run for a build: a quarter of memory from 256 MiB to 2 GiB, 1024 processes, up to two cores", () => {
    expect(WORKLOAD_DEFAULTS.run).toEqual(runDefaults());
    expect(runDefaults(512 * MIB, 1)).toEqual({ memoryBytes: 256 * MIB, processes: 1024, cpuPercent: 100 });
    expect(runDefaults(4096 * MIB, 8)).toEqual({ memoryBytes: 1024 * MIB, processes: 1024, cpuPercent: 200 });
    expect(runDefaults(64 * 1024 * MIB, 16)).toEqual({ memoryBytes: 2048 * MIB, processes: 1024, cpuPercent: 200 });
  });

  it("keeps sandbox.run's host-sized default to half of what every sandbox may hold, so a run fits under a capped unit", () => {
    const fs = delegatedUnit();
    // The unit's 1 GiB, less the owner's 300 MiB and the OS's 128 MiB: 596 MiB for every sandbox together.
    const limits = createLimits({
      platform: "linux",
      fs,
      selfCgroup: () => "0::/system.slice/tavi.service/owner\n",
      osRelease: () => "6.8.0",
    });
    const placed = limits.place(["/usr/bin/true"], "run");
    expect(fs.files[`${UNIT}/sbx/${placed.groupId ?? ""}/memory.max`]).toBe(String(Math.min(WORKLOAD_DEFAULTS.run.memoryBytes, 298 * MIB)));
    // A cap the caller sets is left as given.
    const asked = limits.place(["/usr/bin/true"], "run", { memoryBytes: 64 * MIB });
    expect(fs.files[`${UNIT}/sbx/${asked.groupId ?? ""}/memory.max`]).toBe(String(64 * MIB));
  });

  it("says what a group ran into short of a kill: a fork refused at pids.max, time held back by cpu.max", () => {
    const fs = delegatedUnit();
    const limits = createResourceLimits({
      platform: "linux",
      fs,
      selfCgroup: () => "0::/system.slice/tavi.service/owner\n",
      osRelease: () => "6.8.0",
    });
    const placed = limits.place(["/usr/bin/true"], "run");
    const group = `${UNIT}/sbx/${placed.groupId ?? ""}`;
    expect(limits.pressure?.(placed.groupId ?? "")).toBeUndefined();
    fs.files[`${group}/pids.events`] = "max 3\n";
    fs.files[`${group}/cpu.stat`] = "usage_usec 9000000\nnr_throttled 40\nthrottled_usec 2500000\n";
    expect(limits.pressure?.(placed.groupId ?? "")).toEqual({ pidsExhausted: true, cpuThrottledMs: 2500 });
  });

  it("places a child in its own group, entered before it runs anything", () => {
    const fs = delegatedUnit();
    const limits = createResourceLimits({
      platform: "linux",
      fs,
      selfCgroup: () => "0::/system.slice/tavi.service/owner\n",
      osRelease: () => "6.8.0",
    });
    const placed = limits.place(["/usr/bin/python3", "-c", "1"], "run");
    expect(placed.groupId).toMatch(/^run-[0-9a-f]{12}$/);
    const group = `${UNIT}/sbx/${placed.groupId ?? ""}`;
    expect(placed.argv).toEqual(["/bin/sh", "-c", ENTER_GROUP, "sh", group, "/usr/bin/python3", "-c", "1"]);
    expect(fs.files[`${group}/memory.max`]).toBe(String(256 * MIB));
    expect(fs.files[`${group}/memory.swap.max`]).toBe("0");
    expect(fs.files[`${group}/memory.oom.group`]).toBe("1");
    expect(fs.files[`${group}/pids.max`]).toBe("128");
    expect(fs.files[`${group}/cpu.max`]).toBe("80000 100000");
    // pids.max counts threads, so each workload has its own.
    const browser = limits.place(["chrome"], "browser", { memoryBytes: 100 * MIB });
    expect(fs.files[`${UNIT}/sbx/${browser.groupId ?? ""}/pids.max`]).toBe("1024");
  });

  it("refuses a child that would not fit beside the rest, naming what holds the memory", () => {
    const limits = createResourceLimits({
      platform: "linux",
      fs: delegatedUnit(),
      selfCgroup: () => "0::/system.slice/tavi.service/owner\n",
      osRelease: () => "6.8.0",
    });
    limits.place(["a"], "browser");
    let error: unknown;
    try {
      limits.place(["b"], "browser");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TaviError);
    expect((error as TaviError).code).toBe("QUOTA_EXCEEDED");
    expect((error as TaviError).message).toMatch(/browser-[0-9a-f]+ \(browser, 512 MiB\) holds the rest/);
  });

  it("admits against what placed groups use, not their caps, once they have started", () => {
    vi.useFakeTimers();
    try {
      const fs = delegatedUnit();
      const limits = createResourceLimits({
        platform: "linux",
        fs,
        selfCgroup: () => "0::/system.slice/tavi.service/owner\n",
        osRelease: () => "6.8.0",
      });
      const settle = (placed: { readonly groupId?: string }, mib: number): void => {
        fs.files[`${UNIT}/sbx/${placed.groupId ?? ""}/memory.current`] = String(mib * MIB);
      };
      // Two idle workers (256 MiB caps) and an MCP server (192 MiB) kept warm: 704 MiB of caps against 596 MiB.
      const first = limits.place(["w1"], "worker");
      // While a group starts, it counts at its cap.
      const second = limits.place(["w2"], "worker");
      expect(() => limits.place(["mcp"], "server")).toThrow(/every sandbox together may hold 596 MiB/);
      vi.advanceTimersByTime(11_000);
      settle(first, 60);
      settle(second, 60);
      const server = limits.place(["mcp"], "server");
      vi.advanceTimersByTime(11_000);
      settle(server, 40);
      expect(limits.place(["run"], "run").groupId).toMatch(/^run-/);
      // Once they grow, the room is gone again.
      settle(first, 200);
      settle(second, 200);
      vi.advanceTimersByTime(11_000);
      expect(() => limits.place(["run2"], "run")).toThrow(/worker-[0-9a-f]+ \(worker, 200 MiB\)/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a group whole, reads an OOM kill, and releases its room", () => {
    const fs = delegatedUnit();
    const limits = createResourceLimits({
      platform: "linux",
      fs,
      selfCgroup: () => "0::/system.slice/tavi.service/owner\n",
      osRelease: () => "6.8.0",
    });
    const placed = limits.place(["x"], "browser");
    const id = placed.groupId ?? "";
    const group = `${UNIT}/sbx/${id}`;
    limits.kill(id);
    expect(fs.files[`${group}/cgroup.kill`]).toBe("1");
    fs.files[`${group}/memory.events`] = "low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n";
    expect(limits.outcome(id)).toBe("oom");
    limits.release(id);
    expect(fs.files[`${group}/cgroup.procs`]).toBeUndefined();
    // Its room is free again.
    expect(limits.place(["y"], "browser").groupId).toBeDefined();
  });

  it("sweeps what a killed owner left in sbx/", () => {
    const fs = delegatedUnit({ [`${UNIT}/sbx/cgroup.procs`]: "", [`${UNIT}/sbx/run-old/cgroup.procs`]: "77\n" });
    sweepStaleGroups({ fs, selfCgroup: () => "0::/system.slice/tavi.service/owner\n" });
    expect(fs.writes).toContain(`${UNIT}/sbx/run-old/cgroup.kill=1`);
    expect(fs.files[`${UNIT}/sbx/run-old/cgroup.procs`]).toBeUndefined();
  });
});

describe("the fallback ladder", () => {
  it("takes a user manager's scope where no cgroup is delegated", () => {
    const calls: string[][] = [];
    const limits = createResourceLimits({
      platform: "linux",
      fs: fakeCgroupFs({}),
      selfCgroup: () => "0::/user.slice/user-1000.slice/session-2.scope\n",
      userManager: () => true,
      systemctl: (args) => (calls.push([...args]), { status: 0, stdout: "Result=oom-kill\n" }),
    });
    expect(limits.capabilities().rung).toBe("systemd-run");
    const placed = limits.place(["python3"], "run", { memoryBytes: 64 * MIB });
    expect(placed.argv).toEqual(
      expect.arrayContaining([
        "systemd-run",
        "--user",
        "--scope",
        `MemoryMax=${String(64 * MIB)}`,
        "TasksMax=128",
        "CPUQuota=80%",
        "--",
        "python3",
      ]),
    );
    // systemd-run reaches the user bus; the child's own environment does not get it.
    expect(placed.argv.slice(placed.argv.indexOf("--"))).toEqual([
      "--",
      "/usr/bin/env",
      "-u",
      "XDG_RUNTIME_DIR",
      "-u",
      "DBUS_SESSION_BUS_ADDRESS",
      "python3",
    ]);
    expect(placed.argv).not.toContain("--collect");
    limits.kill(placed.groupId ?? "");
    expect(calls[0]).toEqual(["kill", "--signal=SIGKILL", expect.stringMatching(/^tavi-sbx-run-[0-9a-f]+\.scope$/)]);
    expect(limits.outcome(placed.groupId ?? "")).toBe("oom");
  });

  it("says nothing is enforced where neither works, and runs the argv as it is", () => {
    const limits = createResourceLimits({ platform: "linux", fs: fakeCgroupFs({}), selfCgroup: () => undefined, userManager: () => false });
    expect(limits.capabilities()).toMatchObject({
      memory: "unavailable",
      pids: "unavailable",
      cpu: "unavailable",
      rung: "none",
      detail: expect.stringContaining("tavi service unit"),
    });
    expect(limits.place(["true"], "run")).toEqual({ argv: ["true"] });
  });

  it("on macOS is advisory for memory and unavailable otherwise", () => {
    expect(createResourceLimits({ platform: "darwin" }).capabilities()).toMatchObject({
      memory: "advisory",
      pids: "unavailable",
      cpu: "unavailable",
      rung: "none",
    });
  });

  it("takes the operator's defaults over the workload's", () => {
    const fs = delegatedUnit();
    const limits = createResourceLimits({
      platform: "linux",
      fs,
      selfCgroup: () => "0::/system.slice/tavi.service/owner\n",
      osRelease: () => "6.8.0",
      defaults: { run: { memoryBytes: 128 * MIB, cpuPercent: 50 } },
    });
    const placed = limits.place(["x"], "run");
    expect(fs.files[`${UNIT}/sbx/${placed.groupId ?? ""}/memory.max`]).toBe(String(128 * MIB));
    expect(fs.files[`${UNIT}/sbx/${placed.groupId ?? ""}/cpu.max`]).toBe("50000 100000");
  });
});

describe("the delegated rung's edge cases", () => {
  it("divides only a service's cgroup, never a terminal's session scope", () => {
    const fs = fakeCgroupFs({
      "/sys/fs/cgroup/user.slice/user-1000.slice/session-2.scope/cgroup.controllers": "memory pids cpu",
      "/sys/fs/cgroup/user.slice/user-1000.slice/session-2.scope/cgroup.procs": "1\n",
    });
    const limits = createResourceLimits({
      platform: "linux",
      fs,
      selfCgroup: () => "0::/user.slice/user-1000.slice/session-2.scope\n",
      userManager: () => false,
      osRelease: () => "6.8.0",
    });
    expect(limits.capabilities().rung).toBe("none");
    expect(fs.writes).toEqual([]);
  });

  it("keeps the rung when an optional file is missing, and leaves nothing half made when a cap cannot be set", () => {
    const fs = delegatedUnit();
    const write = fs.write;
    fs.write = (path, value) => {
      if (path.endsWith("memory.swap.max")) throw new Error("ENOENT");
      if (path.endsWith("/pids.max")) throw new Error("EACCES");
      write(path, value);
    };
    const limits = createResourceLimits({
      platform: "linux",
      fs,
      selfCgroup: () => "0::/system.slice/tavi.service/owner\n",
      osRelease: () => "6.8.0",
    });
    expect(limits.capabilities().rung).toBe("delegated");
    expect(() => limits.place(["x"], "run")).toThrow(/could not be set up/);
    expect(fs.list(`${UNIT}/sbx`)).toEqual([]);
  });

  it("empties a group pid by pid on a kernel without cgroup.kill", () => {
    const fs = delegatedUnit();
    const limits = createResourceLimits({
      platform: "linux",
      fs,
      selfCgroup: () => "0::/system.slice/tavi.service/owner\n",
      osRelease: () => "5.10.0",
    });
    expect(limits.capabilities().detail).toMatch(/no cgroup.kill/);
    const placed = limits.place(["x"], "run");
    limits.kill(placed.groupId ?? "");
    expect(fs.writes.some((write) => write.includes("cgroup.kill"))).toBe(false);
  });
});
