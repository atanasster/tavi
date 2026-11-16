import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChannelDescriptor, ChannelPurgeRecord, MessagingConnectionRecord } from "@tavi/contracts";

import { registerChannelDescriptor, unregisterChannelDescriptor } from "../../src/features/channels/catalog.js";
import {
  CHANNEL_PURGE_GRACE_MS,
  cancelOpenedPurges,
  purgePreview,
  rememberAccounts,
  rememberedAccount,
  runDuePurges,
  schedulePluginChannelPurges,
  schedulePurge,
  type ChannelPurgeDependencies,
} from "../../src/features/channels/purge.js";
import { runChannelsCli } from "../../src/features/channels/client.js";
import { countMemoryTaught } from "../../src/features/tasks/history-owner.js";
import { runPluginAction } from "../../src/features/plugins/actions.js";

/** Purge on removal, over fakes. */

const AT = "2026-10-18T00:00:00.000Z";
const base = {
  label: "x",
  kind: "chat",
  description: "d",
  settings: [],
  auth: { kind: "none" },
  sender: { label: "S", placeholder: "", pattern: ".+", normalize: "none", authentication: "provider" },
  target: { label: "T", placeholder: "", pattern: ".+", normalize: "none" },
};
const purging = { ...base, providerId: "purger", retention: "purge-on-remove" } as unknown as ChannelDescriptor;
const keeping = { ...base, providerId: "keeper" } as unknown as ChannelDescriptor;
const connection = (connectionId: string, providerId: string): MessagingConnectionRecord => ({
  connectionId,
  providerId,
  workspaceId: "default",
  accountIdentity: "acct",
  settings: {},
  credentialRefs: { token: `ref.${connectionId}` },
  enabled: true,
  configRevision: 1,
  authState: "none",
  createdAt: AT,
  updatedAt: AT,
});

function fakes(saved: readonly MessagingConnectionRecord[] = []) {
  const purges = new Map<string, ChannelPurgeRecord>();
  const forgotten: string[] = [];
  const removed: string[] = [];
  const order: string[] = [];
  const present = new Set(["art-1"]);
  let failNext = false;
  const deps: ChannelPurgeDependencies = {
    repositories: {
      channelPurges: {
        schedule: async (purge) => void purges.set(purge.connectionId, { ...purge, state: "scheduled" }),
        get: async (id) => purges.get(id),
        cancelForAccount: async () => [],
        listDue: async (now) =>
          [...purges.values()].filter((purge) => (purge.state === "scheduled" && purge.purgeAfter <= now) || purge.state === "running"),
        markRunning: async (id) => {
          const purge = purges.get(id);
          if (purge === undefined || (purge.state !== "scheduled" && purge.state !== "running")) return false;
          purges.set(id, { ...purge, state: "running" });
          return true;
        },
        recordProgress: async (id, counts) => {
          const purge = purges.get(id);
          if (purge?.state !== "running") return false;
          purges.set(id, { ...purge, counts });
          return true;
        },
        inventory: async () => ({
          taskIds: ["task-1", "task-2"],
          artifactIds: ["art-1"],
          conversations: 2,
          messages: 5,
          routineTargets: ["t-1"],
          heartbeats: [],
        }),
        erase: async (id, _taskIds, finished, at) => {
          const counts = { inbox: 5, ...finished };
          const purge = purges.get(id);
          if (finished !== undefined && at !== undefined && purge?.state === "running")
            purges.set(id, { ...purge, state: "done", counts, finishedAt: at });
          return { counts, routineTargets: [], heartbeats: [] };
        },
        senderFootprint: async () => ({ messages: 0, artifactIds: [], conversations: [] }),
        forgetSender: async () => ({ messages: 0, quoted: 0, bindingRemoved: false }),
        finish: async (id, counts, at) => {
          const purge = purges.get(id);
          if (purge?.state !== "running") return false;
          purges.set(id, { ...purge, state: "done", counts, finishedAt: at });
          return true;
        },
      },
      messagingConnections: {
        get: async (id: string) => saved.find((record) => record.connectionId === id),
        list: async () => saved,
      } as never,
    } as ChannelPurgeDependencies["repositories"],
    forgetTask: async (taskId) => {
      if (failNext) {
        failNext = false;
        throw new Error("the owner stopped");
      }
      forgotten.push(taskId);
      order.push("forget");
      return { turns: 3, notes: 1 };
    },
    // Each file is erased once: a resumed purge finds it gone.
    eraseArtifacts: async (ids) => {
      order.push("erase");
      const erased = ids.filter((id) => present.delete(id));
      return { artifacts: erased.length };
    },
    removeConnection: async (record) => void removed.push(record.connectionId),
    log: () => undefined,
    now: () => AT,
  };
  return {
    deps,
    purges,
    forgotten,
    removed,
    order,
    failOnce: () => {
      failNext = true;
    },
  };
}

beforeEach(() => {
  registerChannelDescriptor(purging);
  registerChannelDescriptor(keeping);
});
afterEach(() => {
  unregisterChannelDescriptor("purger");
  unregisterChannelDescriptor("keeper");
});

describe("purge on removal", () => {
  it("schedules a purging channel's removal 24 hours on, by the platform's account id, and a keep channel's not at all", async () => {
    const { deps, purges } = fakes();
    const scheduled = await schedulePurge(deps, connection("c-1", "purger"), "bot-42");
    expect(scheduled).toMatchObject({
      state: "scheduled",
      accountRef: "bot-42",
      purgeAfter: new Date(Date.parse(AT) + CHANNEL_PURGE_GRACE_MS).toISOString(),
    });
    expect(await schedulePurge(deps, connection("c-2", "keeper"), "bot-43")).toBeUndefined();
    expect([...purges.keys()]).toEqual(["c-1"]);
    // Without the platform's id, the account as Tavi names it.
    expect((await schedulePurge(deps, connection("c-3", "purger"), undefined))?.accountRef).toBe("acct");
    expect(await purgePreview(deps, connection("c-2", "keeper"))).toEqual({
      retention: "keep",
      conversations: 0,
      messages: 0,
      files: 0,
      tasks: [],
      moreTasks: 0,
      routineTargets: [],
      heartbeats: 0,
    });
    expect(await purgePreview(deps, connection("c-1", "purger"))).toEqual({
      retention: "purge-on-remove",
      conversations: 2,
      messages: 5,
      files: 1,
      tasks: ["task-1", "task-2"],
      moreTasks: 0,
      routineTargets: ["t-1"],
      heartbeats: 0,
    });
    // A running owner counts the chat notes too.
    expect((await purgePreview({ ...deps, countNotes: async (taskIds) => taskIds.length * 2 }, connection("c-1", "purger"))).notes).toBe(4);
    // A count that cannot be read is left out: the preview a removal asks first never stops it.
    const unread = await purgePreview(
      {
        ...deps,
        countNotes: async () => {
          throw new Error("memory is down");
        },
      },
      connection("c-1", "purger"),
    );
    expect(unread).toMatchObject({ retention: "purge-on-remove", conversations: 2 });
    expect(unread).not.toHaveProperty("notes");
  });

  it("remembers a purging connection's account while it runs, so a removal made once it is closed — its plugin disabled — still purges and is cancelled by it", async () => {
    const meta = new Map<string, string>();
    const memory = { get: async (key: string) => meta.get(key), set: async (key: string, value: string) => void meta.set(key, value) };
    await rememberAccounts(
      memory,
      [
        { connectionId: "c-1", providerId: "purger" },
        { connectionId: "c-2", providerId: "keeper" },
      ],
      (id) => (id === "c-1" ? "bot-42" : "bot-43"),
    );
    expect(await rememberedAccount(memory, "c-2")).toBeUndefined();
    const remembered = await rememberedAccount(memory, "c-1");
    expect(remembered).toEqual({ accountRef: "bot-42", retention: "purge-on-remove" });
    // Its plugin disabled: the catalog no longer holds its channel, and the connection is closed.
    unregisterChannelDescriptor("purger");
    const { deps, purges } = fakes();
    const closed = connection("c-1", "purger");
    expect((await purgePreview(deps, closed, remembered)).retention).toBe("purge-on-remove");
    expect(await schedulePurge(deps, closed, undefined, remembered)).toMatchObject({ accountRef: "bot-42" });
    expect(purges.get("c-1")?.state).toBe("scheduled");
  });

  it("cancels the purges of a purging channel's connections as they open, a keeping channel's never", async () => {
    const asked: [string, string][] = [];
    const { deps } = fakes();
    const cancelling = {
      ...deps,
      repositories: {
        ...deps.repositories,
        channelPurges: {
          ...deps.repositories.channelPurges,
          cancelForAccount: async (provider: string, ref: string) => {
            asked.push([provider, ref]);
            return [`old-${ref}`];
          },
        },
      },
    } as ChannelPurgeDependencies;
    // c-3 is not open: it has no account to cancel by.
    expect(
      await cancelOpenedPurges(
        cancelling,
        [
          { connectionId: "c-1", providerId: "purger" },
          { connectionId: "c-2", providerId: "keeper" },
          { connectionId: "c-3", providerId: "purger" },
        ],
        (id) => (id === "c-3" ? undefined : `bot-${id}`),
      ),
    ).toEqual(["old-bot-c-1"]);
    expect(asked).toEqual([["purger", "bot-c-1"]]);
  });

  it("tavi channels forget-sender says what it does and changes nothing without --yes, then names the conversations to forget", async () => {
    const asked: string[] = [];
    let stdout = "";
    let stderr = "";
    const ask = async <T>(payload: { readonly action: string }): Promise<T> => {
      asked.push(payload.action);
      return {
        sender: "bob",
        messages: 3,
        quoted: 0,
        files: 1,
        bindingRemoved: true,
        notes: 2,
        stillInTurns: [{ conversationId: "room-1", taskIds: ["task-9"] }],
      } as T;
    };
    const io = {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    };
    const options = {
      action: "forget-sender" as const,
      target: "c-1",
      field: "bob",
      settings: {},
      secretFiles: {},
      workspaceId: "default",
      format: "text" as const,
    };
    await expect(runChannelsCli(options, ask, io)).rejects.toThrow(/--yes/);
    expect(asked).toEqual([]);
    expect(stderr).toContain("This erases what bob sent on c-1");
    await runChannelsCli({ ...options, yes: true }, ask, io);
    expect(asked).toEqual(["forget-sender"]);
    expect(stdout).toContain("forgot bob on c-1: 3 message(s), 1 file(s), their binding, 2 note(s) and memories");
    expect(stdout).toMatch(/tavi tasks history task-9 forget --before \S+ --with-memory {2}\(room-1\)/);
  });

  it("tavi channels remove says what a purge erases and removes nothing without --yes", async () => {
    const asked: unknown[] = [];
    let stderr = "";
    const ask = async <T>(payload: { readonly action: string }): Promise<T> => {
      asked.push(payload.action);
      if (payload.action === "remove-preview")
        return {
          retention: "purge-on-remove",
          conversations: 2,
          messages: 9,
          files: 1,
          tasks: ["task-1"],
          moreTasks: 3,
          notes: 4,
          routineTargets: ["t-1"],
          heartbeats: 1,
        } as T;
      return { ok: true, purgeAfter: "2026-10-19T00:00:00.000Z" } as T;
    };
    const io = {
      stdout: () => undefined,
      stderr: (text: string) => {
        stderr += text;
      },
    };
    await expect(
      runChannelsCli({ action: "remove", target: "c-1", settings: {}, secretFiles: {}, workspaceId: "default", format: "text" }, ask, io),
    ).rejects.toThrow(/--yes/);
    expect(asked).toEqual(["remove-preview"]);
    expect(stderr).toContain("2 conversation(s), 9 message(s), 1 file(s)");
    expect(stderr).toContain("and 4 chat note(s) its chats taught");
    expect(stderr).toContain("Delivery targets on it go too: routine target(s) t-1 and 1 heartbeat target(s).");
    expect(stderr).toContain("tavi tasks history task-1 export");
    expect(stderr).toContain("and 3 more");
    await runChannelsCli(
      { action: "remove", target: "c-1", yes: true, settings: {}, secretFiles: {}, workspaceId: "default", format: "text" },
      ask,
      io,
    );
    expect(asked).toEqual(["remove-preview", "remove-preview", "delete"]);
  });

  it("runs only once due, forgets every task, erases files and rows, and resumes a purge a stopped owner left running", async () => {
    const saved = [connection("c-1", "purger")];
    const { deps, purges, forgotten, removed, order, failOnce } = fakes(saved);
    await schedulePurge(deps, connection("c-1", "purger"), "bot-42");
    expect(await runDuePurges(deps)).toBe(0);
    const later = { ...deps, now: () => new Date(Date.parse(AT) + CHANNEL_PURGE_GRACE_MS).toISOString() };
    failOnce();
    expect(await runDuePurges(later)).toBe(0);
    expect(purges.get("c-1")?.state).toBe("running");
    // The next sweep takes it up again, whatever the time.
    expect(await runDuePurges(deps)).toBe(1);
    expect(forgotten).toEqual(["task-1", "task-2"]);
    // Its file went in the first attempt, before the tasks were forgotten; the resumed one still counts it.
    expect(order.slice(0, 2)).toEqual(["erase", "erase"]);
    expect(purges.get("c-1")).toMatchObject({ state: "done", counts: { inbox: 5, tasks: 2, turns: 6, notes: 2, files: 1 } });
    // Still saved (its plugin was removed): it goes with its data.
    expect(removed).toEqual(["c-1"]);
  });

  it("schedules a removed channel plugin's purging channels' connections only", async () => {
    const saved = [connection("c-1", "purger"), connection("c-2", "keeper"), connection("c-3", "other")];
    const { deps, purges } = fakes(saved);
    expect(await schedulePluginChannelPurges(deps, ["purger"], async (id) => (id === "c-1" ? "bot-1" : undefined))).toEqual(["c-1"]);
    expect(purges.get("c-1")?.accountRef).toBe("bot-1");
    expect([...purges.keys()]).toEqual(["c-1"]);
  });

  it("asks the hook for the purging channels of a plugin whose last version is removed", async () => {
    const asked: (readonly string[])[] = [];
    const plugin = {
      id: "acme.chat",
      versions: [
        {
          version: "1.0.0",
          channels: [
            { providerId: "purger", retention: "purge-on-remove" },
            { providerId: "keeper", retention: "keep" },
          ],
        },
      ],
    };
    const registry = { list: async () => [plugin], remove: async () => ({ removed: ["1.0.0"] }) } as unknown as Parameters<
      typeof runPluginAction
    >[0];
    const answer = await runPluginAction(registry, { action: "remove", pluginId: "acme.chat" }, "operator", undefined, {
      channelPluginRemove: async (_id, providerIds) => {
        asked.push(providerIds);
        return ["c-1"];
      },
    });
    expect(asked).toEqual([["purger"]]);
    expect(answer).toMatchObject({ purgesScheduled: ["c-1"] });
    // Another version left installed: nothing is owed yet.
    const two = { ...plugin, versions: [...plugin.versions, { version: "1.1.0", channels: plugin.versions[0]?.channels }] };
    const kept = { list: async () => [two], remove: async () => ({ removed: ["1.0.0"] }) } as unknown as Parameters<
      typeof runPluginAction
    >[0];
    await runPluginAction(kept, { action: "remove", pluginId: "acme.chat", version: "1.0.0" }, "operator", undefined, {
      channelPluginRemove: async (_id, providerIds) => {
        asked.push(providerIds);
        return [];
      },
    });
    expect(asked).toHaveLength(1);
  });

  it("refuses an unconfirmed removal of a plugin whose connections are owed a purge, saying what would go, and removes it once confirmed", async () => {
    const removed: string[] = [];
    const plugin = {
      id: "acme.chat",
      versions: [{ version: "1.0.0", channels: [{ providerId: "purger", retention: "purge-on-remove" }] }],
    };
    const registry = {
      list: async () => [plugin],
      remove: async () => {
        removed.push("1.0.0");
        return { removed: ["1.0.0"] };
      },
    } as unknown as Parameters<typeof runPluginAction>[0];
    const context = {
      channelPluginRemove: async () => ["c-1"],
      channelPluginPreview: async () => ({ connections: 1, conversations: 2, messages: 9, files: 1 }),
    };
    await expect(
      runPluginAction(registry, { action: "remove", pluginId: "acme.chat" }, "operator", undefined, context),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(
        "erases what its 1 connection(s) brought in, 24 hours from now: 2 conversation(s), 9 message(s), 1 file(s)",
      ),
    });
    expect(removed).toEqual([]);
    expect(
      await runPluginAction(registry, { action: "remove", pluginId: "acme.chat", yes: true }, "operator", undefined, context),
    ).toMatchObject({ purgesScheduled: ["c-1"] });
    expect(removed).toEqual(["1.0.0"]);
    // With no connection on its channel, nothing is owed and nothing is asked.
    const none = { ...context, channelPluginPreview: async () => ({ connections: 0, conversations: 0, messages: 0, files: 0 }) };
    await runPluginAction(registry, { action: "remove", pluginId: "acme.chat" }, "operator", undefined, none);
    expect(removed).toHaveLength(2);
  });
});

describe("countMemoryTaught", () => {
  it("counts what a chat taught across pages, as a forget would read it", async () => {
    const asked: unknown[] = [];
    const record = { status: "proposed" } as never;
    const memory = {
      list: async (query: { readonly offset: number }) => {
        asked.push(query);
        return query.offset === 0 ? Array.from({ length: 100 }, () => record) : [record, record];
      },
    };
    expect(
      await countMemoryTaught(
        memory as never,
        { principalId: "bob", workspaceId: "default", caller: "retention", authority: "operator" },
        "task-1",
      ),
    ).toBe(102);
    expect(asked).toEqual([
      expect.objectContaining({ chats: ["task-1"], originTaskId: "task-1", statuses: ["proposed", "approved"], offset: 0, limit: 100 }),
      expect.objectContaining({ offset: 100 }),
    ]);
  });
});
