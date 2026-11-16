import { reminderTaskOperationKey, type PersistencePort, type Reminder, type TaskRecord } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { lastingChat, toolPolicyOrigin } from "../../src/runtime/chat-scope.js";

/** The tool policy's origin for a reminder's task, when the reminder it fired from cannot be read. */

type Repositories = Pick<PersistencePort["repositories"], "tasks" | "agentDelegations" | "reminders">;

function repositoriesWith(reminder: () => Promise<Reminder | undefined>): Repositories {
  const task = {
    taskId: "fired-1",
    origin: "reminder",
    creationOperationKey: reminderTaskOperationKey("rem-1", "2026-10-04T08:00:00.000Z"),
  } as TaskRecord;
  const repositories = {
    tasks: { get: async (taskId: string) => (taskId === task.taskId ? task : undefined) },
    agentDelegations: { getByWorkerTaskId: async () => undefined },
    reminders: { get: reminder },
  };
  // Only the three reads the origin makes: the repositories' other methods are never called here.
  return repositories as unknown as Repositories;
}

describe("a reminder's task origin", () => {
  it("keeps its own origin when said in the app, and a chat's when said in one", async () => {
    expect(
      await toolPolicyOrigin(
        repositoriesWith(async () => ({ deliverTo: { kind: "app" } }) as Reminder),
        "fired-1",
      ),
    ).toBe("reminder");
    expect(
      await toolPolicyOrigin(
        repositoriesWith(async () => ({ deliverTo: { kind: "chat" } }) as unknown as Reminder),
        "fired-1",
      ),
    ).toBe("messaging");
  });

  it("fails, rather than guessing an origin, when the reminder cannot be read", async () => {
    const broken = repositoriesWith(async () => {
      throw new Error("database is locked");
    });
    await expect(toolPolicyOrigin(broken, "fired-1")).rejects.toThrow("database is locked");
    // A grant's lifetime is judged from the same origin: a failed read never makes it last a day.
    await expect(lastingChat(broken, "fired-1")).rejects.toThrow("database is locked");
  });
});
