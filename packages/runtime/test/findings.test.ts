import { TASK_FINDINGS_MAX } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { SqliteStore } from "../src/persistence/store.js";

const AT = "2026-10-08T12:00:00.000Z";
const directories = temporaryDirectories();

afterEach(() => {
  directories.cleanup();
});

function fixture() {
  const artifactsDirectory = directories.create("tavi-findings-");
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true, artifactsDirectory });
  const { tasks, findings } = store.asPort().repositories;
  const task = (id: string, workspaceId = "default") =>
    tasks.admit({
      workspaceId,
      principalId: "operator",
      operationKey: id,
      kind: "start",
      intent: { prompt: `Prompt ${id}` },
      checkpointNamespace: "",
      origin: "ipc",
      now: () => AT,
      newTaskId: () => id,
      newThreadId: () => `thread-${id}`,
      newAdmissionId: () => `admission-${id}`,
    });
  return { store, findings, task };
}

describe("task findings", () => {
  it("keeps a task's records in order, by kind, with their source", () => {
    const { findings, task } = fixture();
    task("t1");
    const added = findings.add({
      taskId: "t1",
      workspaceId: "default",
      kind: "flight",
      records: [{ price: 898 }, { price: 803 }],
      sourceUrl: "https://flights.example/r",
      createdAt: AT,
    });
    expect(added.map((finding) => finding.seq)).toEqual([1, 2]);
    findings.add({ taskId: "t1", workspaceId: "default", kind: "hotel", records: [{ name: "Inn" }], createdAt: AT });
    expect(findings.list({ taskId: "t1", workspaceId: "default", limit: 10 }).map((finding) => [finding.seq, finding.kind])).toEqual([
      [1, "flight"],
      [2, "flight"],
      [3, "hotel"],
    ]);
    expect(findings.list({ taskId: "t1", workspaceId: "default", kind: "flight", afterSeq: 1, limit: 10 })).toEqual([
      { taskId: "t1", seq: 2, kind: "flight", record: { price: 803 }, sourceUrl: "https://flights.example/r", createdAt: AT },
    ]);
  });

  it("keeps another workspace's task out, and drops the oldest past the bound", () => {
    const { findings, task } = fixture();
    task("t1");
    expect(() => findings.add({ taskId: "t1", workspaceId: "other", kind: "flight", records: [{}], createdAt: AT })).toThrow(/No task t1/);
    expect(findings.list({ taskId: "t1", workspaceId: "other", limit: 10 })).toEqual([]);
    findings.add({
      taskId: "t1",
      workspaceId: "default",
      kind: "flight",
      records: Array.from({ length: TASK_FINDINGS_MAX + 3 }, (_, index) => ({ index })),
      createdAt: AT,
    });
    const kept = findings.list({ taskId: "t1", workspaceId: "default", limit: TASK_FINDINGS_MAX + 10 });
    expect(kept).toHaveLength(TASK_FINDINGS_MAX);
    expect(kept[0]?.seq).toBe(4);
  });

  it("goes with its task", () => {
    const { store, findings, task } = fixture();
    task("t1");
    findings.add({ taskId: "t1", workspaceId: "default", kind: "flight", records: [{}], createdAt: AT });
    store.handle.prepare("DELETE FROM tavi_tasks WHERE task_id = 't1'").run();
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_task_findings").get()).toEqual({ n: 0 });
  });
});
