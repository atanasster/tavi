import { spawn, spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { LIMITS_ENTRY_FAILED } from "@tavi/contracts";

import { ENTER_GROUP, createResourceLimits } from "../src/index.js";

/**
 * The delegated rung against a real cgroup v2: run where
 * this process may delegate its own cgroup (`TAVI_LIMITS_REAL=1`; the sandbox
 * matrix's `docker-cgroup` case, a privileged container with a cgroup
 * namespace of its own, or the unit job's VM).
 */

const REAL = process.env["TAVI_LIMITS_REAL"] === "1";
const MIB = 1024 * 1024;

/** Runs a placed argv to its end: exit code, signal and stderr. */
function run(
  argv: readonly string[],
  timeoutMs = 20_000,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((done) => {
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, stdout, stderr });
    });
  });
}

describe.skipIf(!REAL)("the delegated rung on a real cgroup v2", () => {
  const limits = createResourceLimits();

  it("is delegated here", () => {
    expect(limits.capabilities().rung).toBe("delegated");
  });

  it("ends an allocation past its cap as an OOM kill, the owner untouched", async () => {
    const placed = limits.place([process.execPath, "-e", "const a=[];for(;;){a.push(Buffer.alloc(16*1024*1024,1))}"], "run", {
      memoryBytes: 64 * MIB,
    });
    const result = await run(placed.argv);
    expect(result.signal ?? result.code).toBeTruthy();
    expect(limits.outcome(placed.groupId ?? "")).toBe("oom");
    limits.release(placed.groupId ?? "");
  }, 60_000);

  it("bounds a fork bomb by pids.max", async () => {
    const placed = limits.place(
      ["/bin/sh", "-c", "i=0; while [ $i -lt 400 ]; do sleep 5 & i=$((i+1)); done 2>/dev/null; echo $(jobs -p | wc -l)"],
      "run",
      { processes: 32 },
    );
    const result = await run(placed.argv);
    expect(Number(result.stdout.trim())).toBeLessThan(32);
    limits.kill(placed.groupId ?? "");
    limits.release(placed.groupId ?? "");
  }, 60_000);

  it("takes a setsid grandchild down with its group", async () => {
    const marker = `tavi-limits-${String(process.pid)}`;
    const placed = limits.place(
      ["/bin/sh", "-c", `setsid sh -c 'sleep 600; :' ${marker} >/dev/null 2>&1 </dev/null & echo started`],
      "run",
    );
    expect((await run(placed.argv)).stdout).toContain("started");
    expect(spawnSync("pgrep", ["-f", marker]).status).toBe(0);
    limits.kill(placed.groupId ?? "");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spawnSync("pgrep", ["-f", marker]).status).not.toBe(0);
    limits.release(placed.groupId ?? "");
  }, 60_000);

  it("fails closed when the group cannot be entered", async () => {
    const result = await run(["/bin/sh", "-c", ENTER_GROUP, "sh", "/sys/fs/cgroup/does-not-exist", "true"]);
    expect(result.code).toBe(125);
    expect(result.stderr).toContain(LIMITS_ENTRY_FAILED);
  });
});
