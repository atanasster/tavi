import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { endJob, jobPeakKb, killLadder, placeInJob, requireJob, residentKb, signalGroup, treeRss, watchRss } from "../src/index.js";

describe("bounding the child", () => {
  it("sums the resident set over the wrapper and everything under it", () => {
    const table = "  10     1  1000\n  11    10  2000\n  12    11 50000\n  13     1  9999\n";
    expect(treeRss(table, 10)).toBe(53_000);
    expect(treeRss(table, 99)).toBeUndefined();
  });

  it("fires once when a sample passes the cap, and keeps the peak", async () => {
    vi.useFakeTimers();
    try {
      const samples = [100, 900, 2_000, 3_000];
      const over = vi.fn();
      const watchdog = watchRss(1, 1_000, over, async () => samples.shift());
      for (let tick = 0; tick < 5; tick += 1) await vi.advanceTimersByTimeAsync(200);
      expect(over).toHaveBeenCalledTimes(1);
      expect(over).toHaveBeenCalledWith(2_000);
      expect(watchdog.peakKb()).toBe(3_000);
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates to SIGKILL when SIGTERM is not enough", async () => {
    const signals: (string | number)[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      signals.push(`${pid}:${String(signal)}`);
      if (signal === "SIGKILL") setTimeout(() => child.emit("exit"), 0);
      return true;
    });
    const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null });
    try {
      await killLadder(child, 10);
      expect(signals).toEqual(["-42:SIGTERM", "-42:SIGKILL", "-42:SIGKILL"]);
    } finally {
      kill.mockRestore();
    }
  });

  it("escalates its SIGKILL to the child's cgroup where it has one", async () => {
    const steps: string[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      steps.push(`${pid}:${String(signal)}`);
      return true;
    });
    const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null });
    try {
      await killLadder(child, 10, () => {
        steps.push("cgroup.kill");
        setTimeout(() => child.emit("exit"), 0);
      });
      expect(steps.slice(0, 3)).toEqual(["-42:SIGTERM", "-42:SIGKILL", "cgroup.kill"]);
    } finally {
      kill.mockRestore();
    }
  });

  it("signals the child itself when it leads no group to signal", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such group"), { code: "ESRCH" });
    });
    const sent: string[] = [];
    try {
      const child = Object.assign(new EventEmitter(), {
        pid: 42,
        exitCode: null,
        signalCode: null,
        kill: (signal?: NodeJS.Signals) => sent.push(String(signal)) > 0,
      });
      signalGroup(child, "SIGTERM", "linux");
      expect(sent).toEqual(["SIGTERM"]);
    } finally {
      kill.mockRestore();
    }
  });
});

describe("the ladder on Windows", () => {
  it("asks in band by closing stdin, and ends a child in no job by killing it, never signalling a group", () => {
    const kill = vi.spyOn(process, "kill");
    const steps: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      stdin: { end: () => steps.push("stdin.end") },
      kill: (signal?: NodeJS.Signals) => steps.push(`kill:${String(signal)}`) > 0,
    });
    try {
      signalGroup(child, "SIGTERM", "win32");
      signalGroup(child, "SIGKILL", "win32");
      expect(steps).toEqual(["stdin.end", "kill:SIGKILL"]);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("places no child in a job off Windows, and has none to end or measure", async () => {
    expect(placeInJob({ pid: 4242 }, "linux")).toBe(false);
    expect(placeInJob({ pid: undefined }, "win32")).toBe(false);
    expect(endJob(4242)).toBe(false);
    expect(jobPeakKb(4242)).toBeUndefined();
    // Windows measures a child by its job: one in none has nothing to read.
    expect(await residentKb(4242, "win32")).toBeUndefined();
  });

  it("ends a child Windows would not place in a job, and refuses its start", () => {
    const killed: (string | undefined)[] = [];
    const child = { pid: 4242, kill: (signal?: string) => killed.push(signal) > 0 };
    expect(() => requireJob(child, "win32", () => false)).toThrow(/could not be placed in a Job Object/);
    expect(killed).toEqual(["SIGKILL"]);
    expect(() => requireJob(child, "win32", () => true)).not.toThrow();
    expect(() => requireJob(child, "linux", () => false)).not.toThrow();
    expect(() => requireJob({ pid: undefined }, "win32", () => false)).not.toThrow();
    expect(killed).toEqual(["SIGKILL"]);
  });
});
