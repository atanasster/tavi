import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { createSnapshot, restoreSnapshot } from "../src/persistence/administration.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * A chat's memory mode:
 * `tavi_tasks.memory_mode` and `memory_on_at`, a NULL mode reading as on and
 * never turned off; a chat is created off or private,
 * a side chat takes the stricter of its own and its parent's, `setMemoryMode`
 * turns it off and back on (recording when) and never lifts private, and the
 * retention sweep finds the private chats whose last turn is a day old.
 */

const AT = "2026-10-11T08:00:00.000Z";

const cleanup: (() => void)[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  directories.cleanup();
});

/** Each store `opened` made, newest last: a test reads its other repositories. */
const cleanupStores: SqliteStore[] = [];

function opened(databasePath = ":memory:") {
  const store = new SqliteStore(databasePath === ":memory:" ? { databasePath, inMemory: true } : { databasePath });
  cleanup.push(() => store.close());
  cleanupStores.push(store);
  const { tasks, transcripts } = store.asPort().repositories;
  const start = async (id: string, extra: { readonly memoryMode?: "off" | "private"; readonly parentChatId?: string } = {}) =>
    (
      await tasks.admit({
        workspaceId: "default",
        principalId: "operator",
        operationKey: id,
        kind: "start",
        intent: { prompt: `prompt ${id}` },
        checkpointNamespace: "",
        origin: "ipc",
        ...(extra.memoryMode === undefined ? {} : { memoryMode: extra.memoryMode }),
        ...(extra.parentChatId === undefined ? {} : { chatKind: "side" as const, parentChatId: extra.parentChatId }),
        now: () => AT,
        newTaskId: () => id,
        newThreadId: () => `thread-${id}`,
        newAdmissionId: () => `admission-${id}`,
      })
    ).task;
  /** A saved turn of `id`, written `at`. */
  const saved = (id: string, at: string) =>
    store.handle
      .prepare("INSERT INTO tavi_transcript_entries(task_id, seq, admission_id, turn_json, created_at) VALUES (?, 1, NULL, '{}', ?)")
      .run(id, at);
  return { store, tasks, transcripts, start, saved };
}

describe("a chat's memory mode", () => {
  it("is set when a chat is created, and a side chat takes the stricter of its own and its parent's", async () => {
    const { tasks, start } = opened();
    expect((await start("off", { memoryMode: "off" })).memoryMode).toBe("off");
    expect((await start("private", { memoryMode: "private" })).memoryMode).toBe("private");
    await start("on");
    expect((await start("side-of-off", { parentChatId: "off" })).memoryMode).toBe("off");
    expect((await start("side-of-private", { parentChatId: "private", memoryMode: "off" })).memoryMode).toBe("private");
    expect((await start("private-side-of-on", { parentChatId: "on", memoryMode: "private" })).memoryMode).toBe("private");
    expect((await start("side-of-on", { parentChatId: "on" })).memoryMode).toBeUndefined();
    expect((await tasks.get("side-of-private"))?.memoryMode).toBe("private");
  });

  it("is turned off and back on, recording when; never lifted from a private chat; unknown chats are not found", async () => {
    const { tasks, start } = opened();
    await start("chat");
    await start("ghost", { memoryMode: "private" });
    expect((await tasks.setMemoryMode({ taskId: "chat", mode: "on", now: AT })).memoryOnAt).toBeUndefined();
    expect((await tasks.setMemoryMode({ taskId: "chat", mode: "off", now: AT })).memoryMode).toBe("off");
    // Off again changes nothing, nor the time it was last on.
    expect(await tasks.setMemoryMode({ taskId: "chat", mode: "off", now: "2026-10-11T09:00:00.000Z" })).not.toHaveProperty("memoryOnAt");
    const back = await tasks.setMemoryMode({ taskId: "chat", mode: "on", now: "2026-10-11T10:00:00.000Z" });
    expect(back.memoryMode).toBeUndefined();
    expect(back.memoryOnAt).toBe("2026-10-11T10:00:00.000Z");
    expect(() => tasks.setMemoryMode({ taskId: "ghost", mode: "on", now: AT })).toThrow(/private chat/);
    expect(() => tasks.setMemoryMode({ taskId: "ghost", mode: "off", now: AT })).toThrow(/private chat/);
    expect(() => tasks.setMemoryMode({ taskId: "nope", mode: "off", now: AT })).toThrow(/does not exist/);
  });

  it("the retention sweep's read: private chats whose newest saved turn is older than the cutoff, with no turn running", async () => {
    const { store, transcripts, start, saved } = opened();
    await start("old-ghost", { memoryMode: "private" });
    await start("new-ghost", { memoryMode: "private" });
    await start("running-ghost", { memoryMode: "private" });
    await start("empty-ghost", { memoryMode: "private" });
    await start("old-chat");
    await start("old-off", { memoryMode: "off" });
    await start("old-side", { parentChatId: "old-ghost" });
    for (const id of ["old-ghost", "running-ghost", "old-chat", "old-off", "old-side"]) saved(id, "2026-10-09T00:00:00.000Z");
    saved("new-ghost", "2026-10-11T07:00:00.000Z");
    // The others' admissions settled; one turn of running-ghost is still claimed.
    store.handle.prepare("UPDATE tavi_admissions SET state = 'committed', result = '{}' WHERE task_id <> 'running-ghost'").run();
    store.handle.prepare("UPDATE tavi_admissions SET state = 'claimed', result = NULL WHERE task_id = 'running-ghost'").run();
    expect(await transcripts.privateChatsDue({ idleBefore: "2026-10-10T08:00:00.000Z", limit: 10 })).toEqual(
      expect.arrayContaining(["old-ghost", "old-side"]),
    );
    expect(await transcripts.privateChatsDue({ idleBefore: "2026-10-10T08:00:00.000Z", limit: 10 })).toHaveLength(2);
    // Forgotten, they are due no more.
    await transcripts.forget("old-ghost", AT);
    await transcripts.forget("old-side", AT);
    expect(await transcripts.privateChatsDue({ idleBefore: "2026-10-10T08:00:00.000Z", limit: 10 })).toEqual([]);
  });

  it("is carried through a snapshot and a restore", async () => {
    const root = directories.create("tavi-chat-memory-mode-");
    const source = join(root, "source");
    const target = join(root, "target");
    for (const directory of [source, target]) {
      const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite") });
      if (directory === source) {
        const { tasks } = store.asPort().repositories;
        for (const [id, memoryMode] of [
          ["ghost", "private"],
          ["off", "off"],
          ["flipped", "off"],
        ] as const) {
          await tasks.admit({
            workspaceId: "default",
            principalId: "operator",
            operationKey: id,
            kind: "start",
            intent: { prompt: id },
            checkpointNamespace: "",
            origin: "ipc",
            memoryMode,
            now: () => AT,
            newTaskId: () => id,
            newThreadId: () => `thread-${id}`,
            newAdmissionId: () => `admission-${id}`,
          });
        }
        await tasks.setMemoryMode({ taskId: "flipped", mode: "on", now: AT });
      }
      store.close();
    }
    createSnapshot({
      dataDirectory: source,
      outDirectory: join(root, "snap"),
      buildId: "test",
      now: AT,
      includeArtifacts: false,
      includeCredentials: false,
      force: false,
    });
    restoreSnapshot({ snapshotDirectory: join(root, "snap"), dataDirectory: target, now: AT });
    const { tasks } = opened(join(target, "tavi.sqlite"));
    expect((await tasks.get("ghost"))?.memoryMode).toBe("private");
    expect((await tasks.get("off"))?.memoryMode).toBe("off");
    expect(await tasks.get("flipped")).toMatchObject({ memoryOnAt: AT });
    expect((await tasks.get("flipped"))?.memoryMode).toBeUndefined();
  });

  it("turned off, its chat is no longer quoted by an idea", async () => {
    const { tasks, start } = opened();
    await start("chat");
    const store = cleanupStores.at(-1)!;
    const ideas = store.asPort().repositories.ideas;
    await ideas.startRun({ runId: "run-1", workspaceId: "default", trigger: "schedule", now: AT });
    await ideas.store({
      workspaceId: "default",
      runId: "run-1",
      providerId: "tavi.ideasagent",
      now: AT,
      ideas: [
        {
          id: "idea-1",
          score: 0.5,
          draft: {
            key: "travel.a",
            category: "travel",
            icon: "✈️",
            title: "I can watch fares",
            pitch: "A pitch.",
            label: "Watch fares",
            prompt: "Watch fares.",
            basis: [{ kind: "task", ref: "chat", excerpt: "Trip budget" }],
            uses: [{ capability: "web", approval: false }],
          },
        },
      ],
    });
    await tasks.setMemoryMode({ taskId: "chat", mode: "off", now: AT });
    expect(await ideas.get("default", "idea-1")).toBeUndefined();
  });
});
