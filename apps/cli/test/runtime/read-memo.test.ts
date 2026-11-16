import type { PersistencePort } from "@tavi/contracts";
import { describe, expect, it } from "vitest";
import { createOwnerReadMemos } from "../../src/runtime/read-memo.js";

/** The owner's memos of a turn's repeated reads, and the writes that drop them. */

function harness() {
  const reads = { settings: 0, delegations: 0, tasks: 0 };
  let origin: string | undefined;
  let delegation: { readonly rootTaskId: string } | undefined;
  let listener: (operation: string, input: unknown) => void = () => {};
  const repositories = {
    workspaceSettings: {
      get: async (workspaceId: string) => ({ workspaceId, revision: ++reads.settings, settings: {} }),
      set: async () => ({}),
      list: async () => [],
    },
    agentDelegations: {
      getByWorkerTaskId: async () => {
        reads.delegations += 1;
        return delegation;
      },
      recordSpawn: async () => {},
    },
    tasks: {
      get: async (taskId: string) => {
        reads.tasks += 1;
        return origin === undefined ? undefined : { taskId, origin };
      },
    },
  } as unknown as PersistencePort["repositories"];
  const memos = createOwnerReadMemos(
    {
      onSettled: (next) => {
        listener = next;
        return () => {};
      },
    },
    repositories,
  );
  return {
    memos,
    reads,
    settle: (operation: string) => listener(operation, []),
    setOrigin: (next: string) => {
      origin = next;
    },
    setDelegation: (next: { readonly rootTaskId: string }) => {
      delegation = next;
    },
  };
}

describe("createOwnerReadMemos", () => {
  it("reads a workspace's settings once until a settings write settles", async () => {
    const { memos, reads, settle } = harness();
    await memos.workspaceSettings.get("default");
    await memos.workspaceSettings.get("default");
    settle("repository.workspaceSettings.get");
    settle("repository.tasks.admit");
    expect(reads.settings).toBe(1);
    settle("repository.workspaceSettings.set");
    expect((await memos.workspaceSettings.get("default")).revision).toBe(2);
  });

  it("asks again for a delegation once a spawn is recorded: a chat with none may have gained one", async () => {
    const { memos, reads, settle, setDelegation } = harness();
    expect(await memos.agentDelegations.getByWorkerTaskId("task-1")).toBeUndefined();
    expect(await memos.agentDelegations.getByWorkerTaskId("task-1")).toBeUndefined();
    expect(reads.delegations).toBe(1);
    setDelegation({ rootTaskId: "root" });
    settle("repository.agentDelegations.recordSpawn");
    expect(await memos.agentDelegations.getByWorkerTaskId("task-1")).toEqual({ rootTaskId: "root" });
    expect(reads.delegations).toBe(2);
  });

  it("keeps a task's origin only once its row exists", async () => {
    const { memos, reads, setOrigin } = harness();
    expect(await memos.taskOrigin("task-1")).toBeUndefined();
    setOrigin("chat");
    expect(await memos.taskOrigin("task-1")).toBe("chat");
    expect(await memos.taskOrigin("task-1")).toBe("chat");
    expect(reads.tasks).toBe(2);
  });
});
