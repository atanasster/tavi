import { describe, expect, it } from "vitest";
import { TaviError, absentWorkspaceSystemPrompt, type SerializableAdmitRequest } from "@tavi/contracts";
import { admitFixtureTask, createInMemoryTaskRepository } from "@tavi/test-support/fakes";
import { fixturePromptPolicy } from "./support/prompt-policy.js";
import { DEFAULT_SYSTEM_PROMPT, SHIPPED_SYSTEM_PROMPT_VERSION, systemPromptHash } from "../src/prompts/system-prompt.js";

const NOW = "2026-01-01T00:00:00.000Z";
function request(operationKey: string, overrides: Partial<SerializableAdmitRequest> = {}): SerializableAdmitRequest {
  return {
    workspaceId: "ws-1",
    principalId: "operator",
    operationKey,
    kind: "start",
    intent: { prompt: "hello" },
    checkpointNamespace: "",
    newTaskId: `task-${operationKey}`,
    newAdmissionId: `adm-${operationKey}`,
    newThreadId: `thread-${operationKey}`,
    now: NOW,
    prompt: fixturePromptPolicy,
    ...overrides,
  };
}
function boundSnapshot(taskId: string, text = DEFAULT_SYSTEM_PROMPT) {
  return {
    taskId,
    workspaceId: "ws-1",
    source: "builtin" as const,
    text,
    hash: systemPromptHash(text),
    revision: null,
    templateVersion: SHIPPED_SYSTEM_PROMPT_VERSION,
    boundAt: NOW,
  };
}

describe("the async in-memory repository mirrors admission transactions", () => {
  it("binds a fixture task to the shipped prompt, hashed as systemPromptHash hashes it", async () => {
    const tasks = createInMemoryTaskRepository();
    await admitFixtureTask(tasks, "task-fixture", fixturePromptPolicy);
    expect(await tasks.getPromptSnapshot("task-fixture")).toMatchObject({
      source: "builtin",
      text: DEFAULT_SYSTEM_PROMPT,
      templateVersion: SHIPPED_SYSTEM_PROMPT_VERSION,
      hash: systemPromptHash(DEFAULT_SYSTEM_PROMPT),
    });
  });

  it("leaves no task, admission or snapshot when reading workspace settings fails", async () => {
    const tasks = createInMemoryTaskRepository(() => {
      throw new TaviError("INTERNAL", "unreadable workspace setting");
    });
    await expect(tasks.admit(request("failure"))).rejects.toThrow(/unreadable/);
    expect(await tasks.getByOperationKey("ws-1", "operator", "failure")).toBeUndefined();
    expect(await tasks.get("task-failure")).toBeUndefined();
    expect(await tasks.getPromptSnapshot("task-failure")).toBeUndefined();
  });

  it("reads workspace settings for a creating admission and a follow-up prompt, never for a retry", async () => {
    let reads = 0;
    const tasks = createInMemoryTaskRepository((workspaceId) => {
      reads++;
      return { ...absentWorkspaceSystemPrompt(workspaceId), text: "first base", hash: systemPromptHash("first base"), revision: 1 };
    });
    const first = await tasks.admit(request("create"));
    const followUp = await tasks.admit(request("reply", { taskId: first.task.taskId, kind: "reply" }));
    expect(followUp.created).toBe(true);
    expect(await tasks.getPromptSnapshot(first.task.taskId)).toEqual(expect.objectContaining({ text: "first base" }));
    // An unchanged base pins nothing: the reply reads the task's own.
    expect(await tasks.getPromptSnapshot(first.task.taskId, followUp.admission.admissionId)).toEqual(
      expect.objectContaining({ text: "first base" }),
    );
    await tasks.admit(request("create"));
    await tasks.admit(request("reply", { taskId: first.task.taskId, kind: "reply" }));
    expect(reads).toBe(2);
  });

  it("serializes duplicate admissions while workspace settings are pending", async () => {
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const tasks = createInMemoryTaskRepository(async (workspaceId) => {
      reads++;
      await pending;
      return absentWorkspaceSystemPrompt(workspaceId);
    });
    const first = tasks.admit(request("race"));
    const second = tasks.admit(request("race", { newTaskId: "losing-task" }));
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.created)).toEqual([true, false]);
    expect(results[1]?.task.taskId).toBe(results[0]?.task.taskId);
    expect(await tasks.get("losing-task")).toBeUndefined();
    expect(reads).toBe(1);
  });

  it("does not consult corrupt workspace settings for an explicit prompt", async () => {
    const tasks = createInMemoryTaskRepository(() => {
      throw new Error("must not be read");
    });
    const result = await tasks.admit(request("explicit", { prompt: { ...fixturePromptPolicy, explicitPrompt: "pinned" } }));
    expect(await tasks.getPromptSnapshot(result.task.taskId)).toMatchObject({ source: "explicit", text: "pinned" });
  });

  it("rejects corrupt workspace hashes and rolls admission back", async () => {
    const tasks = createInMemoryTaskRepository((workspaceId) => ({
      ...absentWorkspaceSystemPrompt(workspaceId),
      text: "base",
      hash: systemPromptHash("different"),
      revision: 1,
    }));
    await expect(tasks.admit(request("bad-hash"))).rejects.toThrow(/hash/);
    expect(await tasks.getByOperationKey("ws-1", "operator", "bad-hash")).toBeUndefined();
  });

  it("refuses unreadable stored rows and rows that do not hash to their text", async () => {
    const tasks = createInMemoryTaskRepository();
    const { task } = await tasks.admit(request("read"));
    const malformed = boundSnapshot(task.taskId);
    Reflect.set(malformed, "source", "nonsense");
    tasks.seedPromptSnapshot(malformed);
    await expect(tasks.getPromptSnapshot(task.taskId)).rejects.toThrow(/unreadable prompt snapshot/);
    tasks.seedPromptSnapshot({ ...boundSnapshot(task.taskId), hash: systemPromptHash("other") });
    await expect(tasks.getPromptSnapshot(task.taskId)).rejects.toThrow(/does not hash/);
  });

  it("preserves immutable snapshots and refuses another task, workspace or hash", async () => {
    const tasks = createInMemoryTaskRepository();
    const { task } = await tasks.admit(
      request("put", { prompt: { ...fixturePromptPolicy, builtin: { text: "base-one", version: SHIPPED_SYSTEM_PROMPT_VERSION } } }),
    );
    const inserted = await tasks.putTaskSnapshot(boundSnapshot(task.taskId, "base-one"));
    const replay = await tasks.putTaskSnapshot({ ...inserted, boundAt: "2026-02-01T00:00:00.000Z" });
    expect(replay.boundAt).toBe(NOW);
    await expect(tasks.putTaskSnapshot(boundSnapshot(task.taskId, "base-two"))).rejects.toThrow(/different prompt base/);
    await expect(tasks.putTaskSnapshot(boundSnapshot("missing", "x"))).rejects.toThrow(TaviError);
    await expect(tasks.putTaskSnapshot({ ...boundSnapshot(task.taskId, "x"), workspaceId: "ws-2" })).rejects.toThrow(/workspace/);
    await expect(tasks.putTaskSnapshot({ ...boundSnapshot(task.taskId, "x"), hash: systemPromptHash("other") })).rejects.toThrow(/hash/);
    expect(await tasks.getPromptSnapshot(task.taskId)).toMatchObject({ text: "base-one" });
  });
});
