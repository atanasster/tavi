import type { AgentDelegationAdmissionRecord, SessionGrant, TaskRecord } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createChatGrants } from "../../src/features/permissions/chat-grants.js";

/** The two repositories the grants read, in memory: a Home, a conversation's chat and a side chat. */
function repositories() {
  const kinds: Record<string, Partial<TaskRecord>> = {
    "home-1": { chatKind: "home" },
    "chat-1": { origin: "messaging" },
    "side-1": { chatKind: "side", parentChatId: "home-1" },
  };
  const stored = new Map<string, SessionGrant>();
  const row = (workerTaskId: string, parentTaskId: string, rootTaskId?: string) =>
    ({ workerTaskId, parentTaskId, ...(rootTaskId === undefined ? {} : { rootTaskId }) }) as AgentDelegationAdmissionRecord;
  const delegations = [
    row("worker-1", "home-1", "home-1"),
    row("worker-2", "home-1", "home-1"),
    row("worker-3", "worker-1", "home-1"),
    row("worker-old", "home-1"),
    row("worker-old-child", "worker-old"),
  ];
  return {
    stored,
    repositories: {
      tasks: {
        get: async (taskId: string) =>
          kinds[taskId] === undefined ? undefined : ({ taskId, workspaceId: "w1", origin: null, ...kinds[taskId] } as TaskRecord),
      },
      toolPolicy: {
        listSessionGrants: async (taskId: string) => [...stored.values()].filter((grant) => grant.taskId === taskId),
        addSessionGrant: async (grant: SessionGrant) => {
          stored.set(grant.grantId, grant);
          return grant;
        },
        revokeSessionGrant: async (_workspaceId: string, grantId: string) => stored.delete(grantId),
        clearSessionGrants: async (taskId: string) => {
          let removed = 0;
          for (const [id, grant] of stored) if (grant.taskId === taskId && stored.delete(id)) removed += 1;
          return removed;
        },
        listSessionGrantsForWorkspace: async (workspaceId: string) =>
          [...stored.values()].filter((grant) => grant.workspaceId === workspaceId),
        clearTreeSessionGrants: async (_workspaceId: string, rootTaskId: string) => {
          let removed = 0;
          const tree = new Set(delegations.filter((row) => row.rootTaskId === rootTaskId).map((row) => row.workerTaskId));
          for (const [id, grant] of stored) if (tree.has(grant.taskId) && stored.delete(id)) removed += 1;
          return removed;
        },
        deleteExpiredSessionGrants: async (at: string) => {
          let removed = 0;
          for (const [id, grant] of stored) if (grant.expiresAt !== undefined && grant.expiresAt <= at && stored.delete(id)) removed += 1;
          return removed;
        },
      },
      // Home's tree: two workers, one of which spawned a third, all recorded under
      // their root; and one recorded before roots were, with a child of its own.
      agentDelegations: {
        listChildren: async (_workspaceId: string, parentTaskId: string) => delegations.filter((row) => row.parentTaskId === parentTaskId),
        getByWorkerTaskId: async (workerTaskId: string) => delegations.find((row) => row.workerTaskId === workerTaskId),
      },
    },
  };
}

const grant = (taskId: string): SessionGrant => ({
  grantId: `g-${taskId}`,
  taskId,
  workspaceId: "w1",
  toolId: "web.fetch",
  approvalId: `a-${taskId}`,
  createdBy: "alice",
  createdAt: "2026-10-04T00:00:00.000Z",
});

describe("a worker's grants", () => {
  it("inherits what a person allowed the tasks that delegated to it, at any depth, and nothing of a sibling's", async () => {
    const { stored, repositories: fake } = repositories();
    const grants = createChatGrants({ repositories: fake, now: () => "2026-10-04T00:00:01.000Z" });
    for (const owner of ["home-1", "worker-1", "worker-2"]) stored.set(`g-${owner}`, grant(owner));
    expect((await grants.sessionGrants("worker-3")).map((entry) => entry.taskId)).toEqual(["worker-1", "home-1"]);
    expect((await grants.sessionGrants("worker-2")).map((entry) => entry.taskId)).toEqual(["worker-2", "home-1"]);
    expect((await grants.sessionGrants("home-1")).map((entry) => entry.taskId)).toEqual(["home-1"]);
  });

  it("keeps what a person allowed a worker on its chat, so the chat's next worker isn't asked", async () => {
    const { repositories: fake } = repositories();
    const grants = createChatGrants({ repositories: fake, now: () => "2026-10-04T00:00:01.000Z" });
    await grants.grantSession(grant("worker-3"));
    expect((await grants.sessionGrants("worker-2")).map((entry) => entry.taskId)).toEqual(["home-1"]);
    expect((await grants.sessionGrants("home-1"))[0]?.expiresAt).toBe("2026-10-05T00:00:01.000Z");
    await grants.grantSession(grant("worker-old-child"));
    expect(await grants.sessionGrants("home-1")).toHaveLength(2);
  });

  it("leaves an automatic grant on the worker it was made for", async () => {
    const { repositories: fake } = repositories();
    const grants = createChatGrants({ repositories: fake, now: () => "2026-10-04T00:00:01.000Z" });
    await grants.grantSession({ ...grant("worker-1"), createdBy: "auto:policy" });
    expect(await grants.sessionGrants("worker-2")).toEqual([]);
    expect((await grants.sessionGrants("worker-1")).map((entry) => entry.taskId)).toEqual(["worker-1"]);
  });
});

describe("grants that expire", () => {
  it("gives a Home's and a conversation's grant a day, and lets any other last the chat", async () => {
    const { stored, repositories: fake } = repositories();
    let now = "2026-10-04T00:00:00.000Z";
    const grants = createChatGrants({ repositories: fake, now: () => now });
    for (const taskId of ["home-1", "chat-1", "side-1"]) await grants.grantSession(grant(taskId));
    expect((await grants.sessionGrants("home-1"))[0]?.expiresAt).toBe("2026-10-05T00:00:00.000Z");
    expect((await grants.sessionGrants("chat-1"))[0]?.expiresAt).toBe("2026-10-05T00:00:00.000Z");
    expect((await grants.sessionGrants("side-1"))[0]?.expiresAt).toBeUndefined();
    now = "2026-10-05T00:00:00.000Z";
    expect(await grants.sessionGrants("home-1")).toEqual([]);
    // Dropped as it was found.
    expect(stored.has("g-home-1")).toBe(false);
    expect(await grants.sessionGrants("side-1")).toHaveLength(1);
  });

  it("ends a lasting chat's grants at its rollover, and no other chat's", async () => {
    const grants = createChatGrants({ repositories: repositories().repositories, now: () => "2026-10-04T00:00:00.000Z" });
    for (const taskId of ["home-1", "side-1"]) await grants.grantSession(grant(taskId));
    await grants.onEpochRollover("home-1");
    await grants.onEpochRollover("side-1");
    expect(await grants.sessionGrants("home-1")).toEqual([]);
    expect(await grants.sessionGrants("side-1")).toHaveLength(1);
  });

  it("ends a grant made before ends existed a day after it was made, in a chat that never ends", async () => {
    const { stored, repositories: fake } = repositories();
    stored.set("g-old", { ...grant("home-1"), grantId: "g-old" });
    const grants = createChatGrants({ repositories: fake, now: () => "2026-10-05T00:00:01.000Z" });
    expect(await grants.sessionGrants("home-1")).toEqual([]);
  });

  it("judges a worker's grants by the chat it was delegated from", async () => {
    const { repositories: fake } = repositories();
    const grants = createChatGrants({
      repositories: fake,
      now: () => "2026-10-04T00:00:00.000Z",
      lastingChat: async (taskId) => taskId === "home-1",
    });
    await grants.grantSession(grant("worker-1"));
    expect((await grants.sessionGrants("worker-1"))[0]?.expiresAt).toBe("2026-10-05T00:00:00.000Z");
  });

  it("ends the grants of a Home's workers, at any depth, at its rollover (audit fixes, 2026-10-05)", async () => {
    const { stored, repositories: fake } = repositories();
    // Workers count as their Home, as the composition judges them.
    const grants = createChatGrants({
      repositories: fake,
      now: () => "2026-10-04T00:00:00.000Z",
      lastingChat: async (taskId) => taskId !== "side-1",
    });
    for (const taskId of ["home-1", "worker-1", "worker-2", "worker-3", "worker-old", "worker-old-child", "side-1"])
      await grants.grantSession(grant(taskId));
    await grants.onEpochRollover("home-1");
    expect([...stored.keys()]).toEqual(["g-side-1"]);
  });

  it("lists a grant made before ends existed with the end it lapses at, and leaves out one that lapsed (audit fixes, 2026-10-05)", async () => {
    const { stored, repositories: fake } = repositories();
    stored.set("g-old", { ...grant("home-1"), grantId: "g-old", createdAt: "2026-10-03T12:00:00.000Z" });
    stored.set("g-older", { ...grant("home-1"), grantId: "g-older", createdAt: "2026-10-02T00:00:00.000Z" });
    stored.set("g-side", grant("side-1"));
    stored.set("g-other", { ...grant("home-1"), grantId: "g-other", workspaceId: "w2" });
    const grants = createChatGrants({ repositories: fake, now: () => "2026-10-04T00:00:00.000Z" });
    const listed = await grants.listInForce("w1");
    expect(listed.map((entry) => [entry.grantId, entry.expiresAt])).toEqual([
      ["g-old", "2026-10-04T12:00:00.000Z"],
      ["g-side-1", undefined],
    ]);
    expect((await grants.listInForce("w1", "home-1")).map((entry) => entry.grantId)).toEqual(["g-old"]);
    // Listing deletes nothing: the reader of the task's grants, or the sweep, does.
    expect(stored.has("g-older")).toBe(true);
  });

  it("sweeps the grants past their end on the owner's clock (audit fixes, 2026-10-05)", async () => {
    const { stored, repositories: fake } = repositories();
    let now = "2026-10-04T00:00:00.000Z";
    const grants = createChatGrants({ repositories: fake, now: () => now });
    for (const taskId of ["home-1", "side-1"]) await grants.grantSession(grant(taskId));
    expect(await grants.sweepExpired()).toBe(0);
    now = "2026-10-05T00:00:00.000Z";
    expect(await grants.sweepExpired()).toBe(1);
    expect([...stored.keys()]).toEqual(["g-side-1"]);
  });
});
