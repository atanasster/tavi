import { describe, expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";

/** A connect wait in the store and its readers. */

const T0 = "2026-10-16T09:00:00.000Z";
const connect = { appName: "Google Calendar", accountId: "mcp.gcal", reason: "its sign-in expired", health: "needs-sign-in" as const };

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const port = store.asPort().repositories;
  const task = (taskId: string) =>
    port.tasks.admit({
      workspaceId: "default",
      principalId: "operator",
      operationKey: taskId,
      kind: "start",
      intent: { prompt: `Plan ${taskId}` },
      checkpointNamespace: "",
      origin: "ipc",
      now: () => T0,
      newTaskId: () => taskId,
      newThreadId: () => `thread-${taskId}`,
      newAdmissionId: () => `admission-${taskId}`,
    });
  const wait = (waitId: string, taskId: string) => {
    port.agentWaits.prepare({
      waitId,
      taskId,
      deadlineAt: "2026-10-16T09:30:00.000Z",
      question: "Google Calendar needs you to sign in again.",
      connect,
    });
    port.agentWaits.activate(waitId);
  };
  return { store, port, task, wait };
}

describe("a connect wait", () => {
  it("is kept on its row, listed as a connect need and never as a question, and counted", () => {
    const { store, port, task, wait } = fixture();
    try {
      task("t1");
      wait("w1", "t1");
      expect(port.agentWaits.get("w1")).toMatchObject({ state: "active", connect });
      expect(port.agentWaits.listActiveConnects().map((row) => row.waitId)).toEqual(["w1"]);
      expect(port.agentWaits.listActiveHandoffs()).toEqual([]);
      const waits = port.approvalInbox.pendingWaits({ workspaceId: "default", limit: 10 });
      expect(waits.questions).toEqual([]);
      expect(waits.connects).toEqual([
        expect.objectContaining({ taskId: "t1", waitId: "w1", ...connect, deadlineAt: "2026-10-16T09:30:00.000Z" }),
      ]);
      expect(
        port.center.summary({ workspaceId: "default", principalId: "operator", timezone: "UTC", days: 1, now: T0, memoryProposals: 0 })
          .counts,
      ).toMatchObject({ connects: 1, questions: 0 });
    } finally {
      store.close();
    }
  });

  it("records how each was decided: connected, not now, or expired", () => {
    const { store, port, task, wait } = fixture();
    try {
      for (const id of ["t1", "t2", "t3"]) task(id);
      wait("w1", "t1");
      wait("w2", "t2");
      wait("w3", "t3");
      port.agentWaits.settle({
        waitId: "w1",
        outcome: { kind: "answered", connect: { outcome: "connected" } },
        resume: true,
        by: "operator",
        via: "connected-apps",
      });
      port.agentWaits.settle({
        waitId: "w2",
        outcome: { kind: "answered", connect: { outcome: "declined" } },
        resume: true,
        by: "operator",
        via: "connected-apps",
      });
      port.agentWaits.settle({ waitId: "w3", outcome: { kind: "wait-timeout" }, resume: true, by: "policy" });
      expect(port.agentWaits.listActiveConnects()).toEqual([]);
      const history = port.approvalInbox.history({ workspaceId: "default", limit: 10 });
      const states = Object.fromEntries(history.items.flatMap((item) => (item.kind === "connect" ? [[item.waitId, item.state]] : [])));
      expect(states).toEqual({ w1: "connected", w2: "declined", w3: "expired" });
      expect(history.items.every((item) => item.kind === "connect")).toBe(true);
      expect(
        port.approvalInbox
          .history({ workspaceId: "default", kinds: ["connect"], states: ["declined"], limit: 10 })
          .items.map((item) => (item.kind === "connect" ? item.waitId : "")),
      ).toEqual(["w2"]);
    } finally {
      store.close();
    }
  });
});
