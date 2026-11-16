import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { join } from "node:path";

import { SqliteStore } from "../support/database-fixture.js";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { buildTaskDocument, buildTaskShowDocument } from "../../src/features/doctor/reports.js";

/**
 * `buildTaskShowDocument` (`tavi tasks <task-id>`).
 *
 * The property under test: a shown task's own cancellation/approval/effect
 * records are found by direct per-task lookup, not by filtering a globally
 * bounded "50 most recent across the system" list the way `buildTaskDocument`
 * deliberately does — so an older task's own records are never silently
 * dropped just because 50+ *other* tasks have more recent ones.
 */

const AT = "2026-01-01T00:00:00.000Z";
const directories = temporaryDirectories();

afterEach(() => directories.cleanup());

async function fixture(): Promise<SqliteStore> {
  const directory = directories.create("tavi-reports-");
  return await SqliteStore.open({
    databasePath: join(directory, "tavi.sqlite"),
    artifactsDirectory: join(directory, "artifacts"),
  });
}

async function admitTask(store: SqliteStore, taskId: string, now: string): Promise<void> {
  await store.asPort().repositories.tasks.admit({
    prompt: fixturePromptPolicy,
    workspaceId: "default",
    principalId: "operator",
    operationKey: `op-${taskId}`,
    kind: "start",
    intent: { prompt: "hi" },
    checkpointNamespace: "",
    newTaskId: (() => taskId)(),
    newAdmissionId: (() => `adm-${taskId}`)(),
    newThreadId: (() => `thread-${taskId}`)(),
    now: (() => now)(),
  });
}

describe("buildTaskShowDocument", () => {
  it("still surfaces an older task's own cancellation, pending approval and unresolved effect when 50+ other tasks have more recent ones", async () => {
    const store = await fixture();
    const repositories = store.asPort().repositories;

    // The task under test, cancelled first — its own record is the oldest.
    await admitTask(store, "old-task", AT);
    await repositories.cancellations.request({
      taskId: "old-task",
      requestedBy: "operator",
      reason: "investigating",
      now: { fixed: (() => AT)() },
    });
    await repositories.approvals.request({
      approvalId: "approval-old",
      taskId: "old-task",
      steps: 1,
      admissionId: "adm-old-task",
      toolId: "fixture.echo",
      callId: "call-old",
      inputs: {},
      now: { fixed: (() => AT)() },
    });
    const beginOld = await repositories.effects.begin({
      effectKey: "effect-old",
      taskId: "old-task",
      admissionId: "adm-old-task",
      toolId: "fixture.echo",
      inputs: {},
      now: { fixed: (() => AT)() },
    });
    expect(beginOld.effect.state).toBe("pending");

    // 55 other tasks, each with a strictly more recent cancellation/approval/
    // effect — enough to push "old-task"'s own rows outside any bounded
    // top-50-by-recency window if one were still used.
    for (let index = 0; index < 55; index += 1) {
      const taskId = `newer-task-${index}`;
      const at = `2026-01-02T00:00:${String(index).padStart(2, "0")}.000Z`;
      await admitTask(store, taskId, at);
      await repositories.cancellations.request({ taskId, requestedBy: "operator", reason: "noise", now: { fixed: (() => at)() } });
      await repositories.approvals.request({
        approvalId: `approval-${taskId}`,
        taskId,
        steps: 1,
        admissionId: `adm-${taskId}`,
        toolId: "fixture.echo",
        callId: `call-${taskId}`,
        inputs: {},
        now: { fixed: (() => at)() },
      });
      await repositories.effects.begin({
        effectKey: `effect-${taskId}`,
        taskId,
        admissionId: `adm-${taskId}`,
        toolId: "fixture.echo",
        inputs: {},
        now: { fixed: (() => at)() },
      });
    }

    const document = buildTaskShowDocument(store, store.databasePath, "old-task", "2026-01-03T00:00:00.000Z");
    expect(((await document)["cancellations"] as { taskId: string }[]).map((r) => r.taskId)).toEqual(["old-task"]);
    expect(((await document)["pendingApprovals"] as { taskId: string }[]).map((r) => r.taskId)).toEqual(["old-task"]);
    expect(((await document)["unresolvedEffects"] as { taskId: string }[]).map((r) => r.taskId)).toEqual(["old-task"]);
    store.close();
  });

  it("reports found: false and null fields for an unknown task id", async () => {
    const store = await fixture();
    const document = buildTaskShowDocument(store, store.databasePath, "no-such-task", AT);
    expect((await document)["found"]).toBe(false);
    expect((await document)["task"]).toBeNull();
    expect((await document)["cancellations"]).toEqual([]);
    store.close();
  });
});

describe("task documents mask a call's stored input", () => {
  it("masks pending approvals and unresolved effects as tools.redactResults says, inputsHash included", async () => {
    const store = await fixture();
    const repositories = store.asPort().repositories;
    await admitTask(store, "task-secret", AT);
    const inputs = { path: "notes.md", content: "key AKIAIOSFODNN7EXAMPLE" };
    await repositories.approvals.request({
      approvalId: "approval-secret",
      taskId: "task-secret",
      admissionId: "adm-task-secret",
      toolId: "fs.write",
      callId: "call-secret",
      steps: 1,
      inputs,
      now: { fixed: AT },
    });
    await repositories.effects.begin({
      effectKey: "effect-secret",
      taskId: "task-secret",
      admissionId: "adm-task-secret",
      toolId: "fs.write",
      inputs,
      now: { fixed: AT },
    });

    const listing = JSON.stringify(await buildTaskDocument(store, store.databasePath, AT));
    const shown = JSON.stringify(await buildTaskShowDocument(store, store.databasePath, "task-secret", AT));
    for (const document of [listing, shown]) {
      expect(document).toContain("key [redacted:aws-key]");
      expect(document).not.toContain("AKIAIOSFODNN7EXAMPLE");
    }

    // Off for the workspace: shown as stored, where the call runs from.
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { redactToolResults: false },
      expectedRevision: 0,
      actor: "operator",
      now: AT,
    });
    expect(JSON.stringify(await buildTaskShowDocument(store, store.databasePath, "task-secret", AT))).toContain("AKIAIOSFODNN7EXAMPLE");
    store.close();
  });
});
