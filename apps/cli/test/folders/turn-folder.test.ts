import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { TaviError, type ChatFolderRow, type InvocationContext, type WriteChatFolderInput } from "@tavi/contracts";
import { ChatFolders, ToolRegistry, type ChatFolderTask } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { registerFsTools } from "../../src/features/folders/fs-tools.js";
import { createTurnFolder } from "../../src/features/folders/turn-folder.js";

/**
 * The owner's `turnFolder`: every turn resolves its chat's
 * folder through the real `ChatFolders`, except a heartbeat tick's, which gets
 * none — nothing is created under `chats/` for it, and its file tools refuse.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

function setup() {
  const data = realpathSync(directories.create("tavi-turn-folder-"));
  const tasks = new Map<string, ChatFolderTask>();
  const rows = new Map<string, ChatFolderRow>();
  const folders = new ChatFolders({
    dataDirectory: data,
    homeDirectory: join(data, "home"),
    fsRoots: [],
    repository: {
      get: (taskId: string) => rows.get(taskId),
      revision: (taskId: string) => rows.get(taskId)?.revision ?? 0,
      write: (input: WriteChatFolderInput): ChatFolderRow => {
        if ((rows.get(input.taskId)?.revision ?? 0) !== input.expectedRevision) throw new TaviError("CONFLICT", "changed");
        const row: ChatFolderRow = {
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          primaryKind: input.primaryKind,
          attachments: [...input.attachments],
          revision: input.expectedRevision + 1,
          updatedAt: input.now,
        };
        rows.set(input.taskId, row);
        return row;
      },
    },
    tasks: { get: (taskId) => tasks.get(taskId) },
    agentDelegations: { getByWorkerTaskId: () => undefined },
    now: () => "2026-10-10T08:00:00.000Z",
  });
  const turnFolder = createTurnFolder({
    folders,
    notices: { postFolderBudget: async () => undefined },
    space: { crossing: async () => undefined },
    warn: () => undefined,
  });
  const task = (taskId: string, origin: ChatFolderTask["origin"]) =>
    tasks.set(taskId, { taskId, workspaceId: "default", principalId: "operator", origin });
  const context = (runId: string): InvocationContext => ({ workspaceId: "default", principalId: "operator", runId, caller: "test" });
  return { data, turnFolder, task, context };
}

describe("the owner's turnFolder", () => {
  it("gives a hundred heartbeat ticks no folder, and creates nothing under chats/ for them", async () => {
    const { data, turnFolder, task, context } = setup();
    for (let index = 0; index < 100; index += 1) {
      task(`tick-${index}`, "heartbeat");
      expect(await turnFolder(context(`tick-${index}`), { tainted: false, origin: "heartbeat" })).toBeUndefined();
    }
    expect(existsSync(join(data, "chats"))).toBe(false);
  });

  it("still resolves and creates a chat's own folder for any other origin", async () => {
    const { data, turnFolder, task, context } = setup();
    task("chat", "cli");
    const folder = await turnFolder(context("chat"), { tainted: false, origin: "cli" });
    expect(folder?.managed).toBe(join(data, "chats", "default", "chat"));
    expect(existsSync(join(data, "chats", "default", "chat"))).toBe(true);
  });

  it("leaves a tick's file tools refusing: a forced fs.read has no folder to read", async () => {
    const { data, turnFolder, task, context } = setup();
    task("tick", "heartbeat");
    const folder = await turnFolder(context("tick"), { tainted: false, origin: "heartbeat" });
    const registry = new ToolRegistry();
    registerFsTools(registry, { dataDirectory: data });
    const read = registry.get("fs.read");
    const invocation = folder === undefined ? context("tick") : { ...context("tick"), folder };
    await expect(read?.handler({ input: { path: "notes.md" }, context: invocation, signal: new AbortController().signal })).rejects.toThrow(
      /no working folder/,
    );
  });
});
