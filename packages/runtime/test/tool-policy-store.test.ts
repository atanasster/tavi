import { join } from "node:path";

import type { ToolRule } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { SqliteStore } from "../src/persistence/store.js";

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

function openStore(): SqliteStore {
  const directory = directories.create("tavi-tool-policy-");
  return new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
}

const rule: ToolRule = {
  ruleId: "rule-1",
  workspaceId: "default",
  toolPattern: "sandbox.run",
  argMatcher: "npm test",
  decision: "allow",
  source: "operator",
  createdBy: "operator",
  createdVia: "cli",
  createdAt: "2026-09-27T00:00:00.000Z",
};

describe("SqliteToolPolicyRepository", () => {
  it("stores, replaces and deletes a workspace's rules", () => {
    const store = openStore();
    try {
      const policy = store.asPort().repositories.toolPolicy;
      policy.putRule(rule);
      policy.putRule({ ...rule, decision: "deny" });
      expect(policy.listRules("default")).toEqual([{ ...rule, decision: "deny" }]);
      expect(policy.listRules("other")).toEqual([]);
      expect(policy.getRule("default", "rule-1")?.decision).toBe("deny");
      expect(policy.deleteRule("default", "rule-1")).toBe(true);
      expect(policy.deleteRule("default", "rule-1")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("refuses to store a shipped or flag rule, or one with no workspace", () => {
    const store = openStore();
    try {
      const policy = store.asPort().repositories.toolPolicy;
      expect(() => policy.putRule({ ...rule, source: "shipped" })).toThrow(/not stored/);
      expect(() => policy.putRule({ ...rule, workspaceId: "*" })).toThrow(/names its workspace/);
    } finally {
      store.close();
    }
  });

  it("keeps session grants per task, idempotent by id, and clears them", () => {
    const store = openStore();
    try {
      const port = store.asPort();
      port.repositories.tasks.admit({
        workspaceId: "default",
        principalId: "operator",
        operationKey: "op-1",
        kind: "start",
        intent: { prompt: "hello" },
        checkpointNamespace: "",
        newTaskId: () => "task-1",
        newAdmissionId: () => "adm-1",
        newThreadId: () => "thread-1",
        now: () => "2026-09-27T00:00:00.000Z",
      });
      const grant = {
        grantId: "g1",
        taskId: "task-1",
        workspaceId: "default",
        toolId: "sandbox.run",
        argMatcher: "npm test",
        approvalId: "a1",
        createdBy: "operator",
        createdAt: "2026-09-27T00:00:00.000Z",
      };
      port.repositories.toolPolicy.addSessionGrant(grant);
      port.repositories.toolPolicy.addSessionGrant(grant);
      expect(port.repositories.toolPolicy.listSessionGrants("task-1")).toEqual([grant]);
      expect(port.repositories.toolPolicy.listSessionGrantsForWorkspace("default")).toEqual([grant]);
      expect(port.repositories.toolPolicy.revokeSessionGrant("other", "g1")).toBe(false);
      expect(port.repositories.toolPolicy.clearSessionGrants("task-1")).toBe(1);
      expect(port.repositories.toolPolicy.listSessionGrants("task-1")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("sweeps the grants past their end, and only those", () => {
    const store = openStore();
    try {
      const port = store.asPort();
      port.repositories.tasks.admit({
        workspaceId: "default",
        principalId: "operator",
        operationKey: "op-1",
        kind: "start",
        intent: { prompt: "hello" },
        checkpointNamespace: "",
        newTaskId: () => "task-1",
        newAdmissionId: () => "adm-1",
        newThreadId: () => "thread-1",
        now: () => "2026-09-27T00:00:00.000Z",
      });
      const grant = {
        taskId: "task-1",
        workspaceId: "default",
        toolId: "sandbox.run",
        approvalId: "a1",
        createdBy: "operator",
        createdAt: "2026-09-27T00:00:00.000Z",
      };
      port.repositories.toolPolicy.addSessionGrant({ ...grant, grantId: "lapsed", expiresAt: "2026-09-28T00:00:00.000Z" });
      port.repositories.toolPolicy.addSessionGrant({ ...grant, grantId: "now", expiresAt: "2026-09-28T12:00:00.000Z" });
      port.repositories.toolPolicy.addSessionGrant({ ...grant, grantId: "later", expiresAt: "2026-09-29T00:00:00.000Z" });
      port.repositories.toolPolicy.addSessionGrant({ ...grant, grantId: "no-end" });
      expect(port.repositories.toolPolicy.deleteExpiredSessionGrants("2026-09-28T12:00:00.000Z")).toBe(2);
      expect(
        port.repositories.toolPolicy
          .listSessionGrants("task-1")
          .map((entry) => entry.grantId)
          .sort(),
      ).toEqual(["later", "no-end"]);
    } finally {
      store.close();
    }
  });

  it("compares a grant's end as an instant, however it was written", () => {
    const store = openStore();
    try {
      const port = store.asPort();
      port.repositories.tasks.admit({
        workspaceId: "default",
        principalId: "operator",
        operationKey: "op-1",
        kind: "start",
        intent: { prompt: "hello" },
        checkpointNamespace: "",
        newTaskId: () => "task-1",
        newAdmissionId: () => "adm-1",
        newThreadId: () => "thread-1",
        now: () => "2026-09-27T00:00:00.000Z",
      });
      const grant = {
        taskId: "task-1",
        workspaceId: "default",
        toolId: "sandbox.run",
        approvalId: "a1",
        createdBy: "operator",
        createdAt: "2026-09-27T00:00:00.000Z",
      };
      const ends = {
        // At or before 12:00:00.000Z.
        "no-millis": "2026-09-28T12:00:00Z",
        "east-offset": "2026-09-28T14:00:00+02:00",
        "west-offset-millis": "2026-09-28T06:59:59.999-05:00",
        // After it.
        "one-ms-later": "2026-09-28T12:00:00.001Z",
        "later-offset": "2026-09-28T13:00:01+01:00",
        "not-an-instant": "tomorrow",
      };
      for (const [grantId, expiresAt] of Object.entries(ends))
        port.repositories.toolPolicy.addSessionGrant({ ...grant, grantId, expiresAt });
      // A bound written with an offset is the same instant.
      expect(port.repositories.toolPolicy.deleteExpiredSessionGrants("2026-09-28T07:00:00-05:00")).toBe(3);
      expect(
        port.repositories.toolPolicy
          .listSessionGrants("task-1")
          .map((entry) => entry.grantId)
          .sort(),
      ).toEqual(["later-offset", "not-an-instant", "one-ms-later"]);
      expect(port.repositories.toolPolicy.deleteExpiredSessionGrants("not a time")).toBe(0);
    } finally {
      store.close();
    }
  });

  it("clears the grants of a root's delegation tree, at any depth, in one statement", () => {
    const store = openStore();
    try {
      const port = store.asPort();
      for (const id of ["root", "w1", "w2", "w3", "other"]) {
        port.repositories.tasks.admit({
          workspaceId: "default",
          principalId: "operator",
          operationKey: `op-${id}`,
          kind: "start",
          intent: { prompt: "hello" },
          checkpointNamespace: "",
          newTaskId: () => id,
          newAdmissionId: () => `adm-${id}`,
          newThreadId: () => `thread-${id}`,
          now: () => "2026-09-27T00:00:00.000Z",
        });
      }
      const spawn = (workerTaskId: string, parentTaskId: string, rootTaskId: string | undefined) =>
        port.repositories.agentDelegations.recordSpawn({
          operationKey: `spawn-${workerTaskId}`,
          workspaceId: "default",
          principalId: "operator",
          workerTaskId,
          workerAgentId: `agent-${workerTaskId}`,
          parentTaskId,
          ...(rootTaskId === undefined ? {} : { rootTaskId }),
          createdAt: "2026-09-27T00:00:00.000Z",
          depth: 1,
          frontEnd: "web",
          heldChannel: "messaging",
          heldConnectionId: "tg-1",
        });
      spawn("w1", "root", "root");
      spawn("w2", "w1", "root");
      spawn("w3", "other", "other");
      const grant = (taskId: string) => ({
        grantId: `g-${taskId}`,
        taskId,
        workspaceId: "default",
        toolId: "sandbox.run",
        approvalId: "a1",
        createdBy: "operator",
        createdAt: "2026-09-27T00:00:00.000Z",
      });
      for (const id of ["root", "w1", "w2", "w3"]) port.repositories.toolPolicy.addSessionGrant(grant(id));
      expect(port.repositories.toolPolicy.clearTreeSessionGrants("default", "root")).toBe(2);
      expect(
        port.repositories.toolPolicy
          .listSessionGrantsForWorkspace("default")
          .map((entry) => entry.grantId)
          .sort(),
      ).toEqual(["g-root", "g-w3"]);
      // The front end the spawning turn was typed in is kept on the row.
      expect(port.repositories.agentDelegations.getByWorkerTaskId("w1")?.frontEnd).toBe("web");
      // So is the connection its channel turn came in on.
      expect(port.repositories.agentDelegations.getByWorkerTaskId("w1")?.heldConnectionId).toBe("tg-1");
    } finally {
      store.close();
    }
  });

  it("records gate observations once per call, counts them and prunes them past their retention", () => {
    const store = openStore();
    try {
      const policy = store.asPort().repositories.toolPolicy;
      const observation = {
        taskId: "task-1",
        callId: "call-1",
        toolId: "http.request",
        effect: "external",
        sink: "network",
        decisionEnforced: "allow",
        decisionObserved: "ask",
        gateReason: "tainted-payload",
        createdAt: "2026-10-10T00:00:00.000Z",
      } as const;
      expect(policy.recordGateObservation(observation)).toBe(true);
      // A generation judged again records nothing twice.
      expect(policy.recordGateObservation({ ...observation, decisionEnforced: "ask" })).toBe(false);
      expect(policy.recordGateObservation({ ...observation, callId: "call-2", decisionEnforced: "ask" })).toBe(true);
      expect(
        policy.recordGateObservation({
          ...observation,
          taskId: "task-2",
          callId: "call-3",
          toolId: "messaging.send_to",
          sink: "message",
          gateReason: "tainted-message",
        }),
      ).toBe(true);
      expect(policy.recordGateObservation({ ...observation, callId: "old", createdAt: "2026-09-01T00:00:00.000Z" })).toBe(true);

      expect(policy.summarizeGateObservations("2026-10-06T00:00:00.000Z", 5)).toEqual({
        calls: 3,
        tasks: 2,
        unasked: 2,
        topTools: [
          { toolId: "http.request", calls: 2 },
          { toolId: "messaging.send_to", calls: 1 },
        ],
      });
      expect(policy.summarizeGateObservations("2026-10-06T00:00:00.000Z", 1).topTools).toEqual([{ toolId: "http.request", calls: 2 }]);
      expect(() => policy.recordGateObservation({ ...observation, callId: "bad", gateReason: "because" as never })).toThrow(
        /Invalid gate observation/,
      );

      // Rows and bounds are compared as the clock writes them, however the caller spelled the instant:
      // `…00Z` stored as given would sort after `…00.500Z`.
      expect(policy.recordGateObservation({ ...observation, callId: "old-2", createdAt: "2026-09-01T00:00:00Z" })).toBe(true);
      expect(policy.summarizeGateObservations("2026-09-01T00:00:00Z", 5).calls).toBe(5);
      expect(policy.summarizeGateObservations("2026-09-01T00:00:00.500Z", 5).calls).toBe(3);
      expect(policy.deleteGateObservationsBefore("2026-09-13T00:00:00.000Z")).toBe(2);
      expect(policy.summarizeGateObservations("2000-01-01T00:00:00.000Z", 5).calls).toBe(3);
    } finally {
      store.close();
    }
  });
});
