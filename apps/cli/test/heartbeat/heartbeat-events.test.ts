import type { NeedRow } from "@tavi/contracts";
import type { HeartbeatWakeEvent } from "@tavi/agent-host/heartbeat-host";
import { until, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { startHeartbeatEvents, type HeartbeatEvents } from "../../src/features/heartbeat/events.js";

/**
 * What wakes a heartbeat between its checks: a
 * failed run (never a heartbeat's own), a need once 80% of the time to its
 * deadline has passed (once), and a message from anyone but the operator.
 */

const started: HeartbeatEvents[] = [];
afterEach(() => {
  while (started.length > 0) started.pop()?.stop();
});

function events(
  options: {
    tasks?: Record<string, { status: string; origin: string | null }>;
    needs?: () => readonly NeedRow[];
    truncated?: () => boolean;
    now?: () => Date;
    writes?: () => number;
  } = {},
) {
  let reads = 0;
  const woken: (HeartbeatWakeEvent & { workspaceId: string; principalId: string })[] = [];
  const listeners: ((taskId: string) => void)[] = [];
  const handle = startHeartbeatEvents({
    wake: (workspaceId, principalId, event) => woken.push({ workspaceId, principalId, ...event }),
    repositories: {
      tasks: {
        get: async (taskId: string) =>
          options.tasks?.[taskId] === undefined
            ? undefined
            : { taskId, workspaceId: "default", principalId: "alice", ...options.tasks[taskId] },
      },
    } as never,
    needs: async () => {
      reads += 1;
      return { needs: options.needs?.() ?? [], truncated: options.truncated?.() ?? false };
    },
    workspaces: () => ["default"],
    principalOf: () => "alice",
    onCompleted: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    now: options.now ?? (() => new Date("2026-10-11T09:00:00.000Z")),
    pollMs: 10,
    ...(options.writes === undefined ? {} : { writes: options.writes }),
    log: () => undefined,
  });
  started.push(handle);
  return {
    handle,
    woken,
    reads: () => reads,
    complete: (taskId: string) => listeners.forEach((listener) => listener(taskId)),
  };
}

describe("heartbeat event wakes", () => {
  it("wakes the person whose run failed, never for a heartbeat's own run or one that completed", async () => {
    const { woken, complete } = events({
      tasks: {
        ok: { status: "completed", origin: "cli" },
        own: { status: "failed", origin: "heartbeat" },
        broke: { status: "failed", origin: "schedule" },
        stopped: { status: "stopped", origin: "cli" },
      },
    });
    for (const taskId of ["ok", "own", "stopped", "broke", "missing"]) complete(taskId);
    await until(
      async () => woken.length,
      (count) => count > 0,
    );
    await delay(20);
    expect(woken).toEqual([{ workspaceId: "default", principalId: "alice", reason: "failed-run", mode: "now" }]);
  });

  it("wakes the operator for a message someone else sent, and not for their own", () => {
    const { handle, woken } = events();
    handle.messageArrived("default", "alice");
    handle.messageArrived("default", "bob");
    // For the next check, not one now: a message is a signal only once it has waited an hour.
    expect(woken).toEqual([{ workspaceId: "default", principalId: "alice", reason: "message", mode: "next" }]);
  });
});

describe("a need close to its deadline", () => {
  it("wakes its person once 80% of the time to the deadline has passed, and only once", async () => {
    let now = new Date("2026-10-11T09:00:00.000Z");
    const question = {
      kind: "question",
      needId: "question:w1",
      taskId: "t",
      askedAt: "2026-10-11T08:00:00.000Z",
      deadlineAt: "2026-10-11T10:00:00.000Z",
      question: { principalId: "bob" },
    } as unknown as NeedRow;
    const open = {
      kind: "approval",
      needId: "approval:a1",
      taskId: "t",
      askedAt: "2026-10-11T08:00:00.000Z",
      approval: { principalId: "bob" },
    } as unknown as NeedRow;
    const { woken } = events({ now: () => now, needs: () => [question, open] });
    // Half-way to the deadline, and one with none: nothing yet.
    await delay(40);
    expect(woken).toEqual([]);
    now = new Date("2026-10-11T09:40:00.000Z");
    await until(
      async () => woken.length,
      (count) => count > 0,
    );
    await delay(40);
    expect(woken).toEqual([{ workspaceId: "default", principalId: "bob", reason: "need", mode: "now" }]);
  });

  it("forgets no need while the list is cut short, so one that drops out and comes back does not wake twice", async () => {
    const question = {
      kind: "question",
      needId: "question:w1",
      taskId: "t",
      askedAt: "2026-10-11T08:00:00.000Z",
      deadlineAt: "2026-10-11T09:10:00.000Z",
      question: { principalId: "bob" },
    } as unknown as NeedRow;
    let listed: readonly NeedRow[] = [question];
    let truncated = false;
    const { woken } = events({ needs: () => listed, truncated: () => truncated });
    await until(
      async () => woken.length,
      (count) => count > 0,
    );
    // Past the list's end for a while, then back.
    listed = [];
    truncated = true;
    await delay(40);
    listed = [question];
    truncated = false;
    await delay(40);
    expect(woken).toHaveLength(1);
  });

  it("with the store's write count, reads needs only after a write or once one reaches its share", async () => {
    let now = new Date("2026-10-11T09:00:00.000Z");
    let writes = 0;
    const question = {
      kind: "question",
      needId: "question:w1",
      taskId: "t",
      askedAt: "2026-10-11T08:00:00.000Z",
      deadlineAt: "2026-10-11T10:00:00.000Z",
      question: { principalId: "bob" },
    } as unknown as NeedRow;
    const { woken, reads } = events({ now: () => now, needs: () => [question], writes: () => writes });
    await until(reads, (count) => count > 0);
    // Nothing written and the need not yet at its share: the ticks read nothing.
    await delay(60);
    expect(reads()).toBe(1);
    writes += 1;
    await until(reads, (count) => count > 1);
    await delay(60);
    expect(reads()).toBe(2);
    expect(woken).toEqual([]);
    // Its share is reached with nothing written: the crossing the last read saw is read for.
    now = new Date("2026-10-11T09:36:00.000Z");
    await until(
      async () => woken.length,
      (count) => count > 0,
    );
    expect(woken).toEqual([{ workspaceId: "default", principalId: "bob", reason: "need", mode: "now" }]);
  });
});
