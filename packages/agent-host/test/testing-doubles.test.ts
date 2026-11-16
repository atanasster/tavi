import { fixturePromptPolicy } from "./support/prompt-policy.js";
import { describe, expect, it } from "vitest";

import { TaviError } from "@tavi/contracts";
import { createInMemoryApprovalRepository, createInMemoryTaskRepository } from "@tavi/test-support/fakes";

/**
 * The in-memory doubles mirror the store's rules.
 *
 * Every adapter test runs against these, so a double that is more permissive
 * than the store masks exactly the defects those tests exist to catch.
 */

const admitRequest = {
  prompt: fixturePromptPolicy,
  workspaceId: "ws-1",
  principalId: "operator",
  operationKey: "op-1",
  kind: "start" as const,
  intent: { prompt: "hello" },
  checkpointNamespace: "",
  newTaskId: (() => "task-1")(),
  newAdmissionId: (() => "adm-1")(),
  newThreadId: (() => "thread-1")(),
  now: (() => "2026-01-01T00:00:00.000Z")(),
};

describe("in-memory task repository", () => {
  it("leaves a task's status alone when its admission is committed refused", async () => {
    const tasks = createInMemoryTaskRepository();
    const { task, admission } = await tasks.admit(admitRequest);
    await tasks.commitAdmission({
      admissionId: admission.admissionId,
      taskId: task.taskId,
      state: "committed",
      result: { status: "waiting", finalText: "" },
    });
    expect((await tasks.get(task.taskId))?.status).toBe("waiting");

    // A stale decision refused in the queue must leave a waiting task waiting.
    await tasks.commitAdmission({
      admissionId: admission.admissionId,
      taskId: task.taskId,
      state: "refused",
      result: { status: "failed", finalText: "stale round", error: { code: "CONFLICT", message: "stale round" } },
    });
    expect((await tasks.get(task.taskId))?.status).toBe("waiting");
  });

  it("refuses the origin pairings the store refuses", async () => {
    const tasks = createInMemoryTaskRepository();
    await expect((async () => await tasks.admit({ ...admitRequest, origin: "schedule" }))()).rejects.toThrowError(TaviError);
    await expect((async () => await tasks.admit({ ...admitRequest, origin: "cli", originScheduleId: "sched-1" }))()).rejects.toThrowError(
      TaviError,
    );
    expect((await tasks.admit({ ...admitRequest, origin: "schedule", originScheduleId: "sched-1" })).task.origin).toBe("schedule");
  });
});

describe("in-memory approval repository", () => {
  it("resolves a call by its round, or without one by the newest round", async () => {
    const approvals = createInMemoryApprovalRepository();
    const request = (callId: string, steps: number) =>
      approvals.request({
        approvalId: `approval:${callId}:${steps}`,
        taskId: "task-1",
        admissionId: "adm-1",
        toolId: "fixture.write",
        callId,
        steps,
        inputs: { value: "x" },
        now: { fixed: "2026-01-01T00:00:00.000Z" },
      });
    await request("call-1", 3);
    await request("call-1", 4);
    expect((await approvals.getForCall("task-1", "call-1", 3))?.steps).toBe(3);
    expect((await approvals.getForCall("task-1", "call-1"))?.steps).toBe(4);
    expect(await approvals.getForCall("task-1", "call-1", 5)).toBeUndefined();
  });
});
