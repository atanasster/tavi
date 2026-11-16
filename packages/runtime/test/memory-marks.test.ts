import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MEMORY_MARK_KINDS,
  isMemoryReviewFailureMark,
  memoryDigestNoticeText,
  memoryDigestOf,
  memoryReviewFailureMark,
  memoryReviewMark,
  parseMemoryReviewMark,
  type ChatKind,
  type ChatMemoryMode,
  type TaskOrigin,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { temporaryDirectories } from "@tavi/test-support";

import { createSnapshot, restoreSnapshot } from "../src/persistence/administration.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Memory's durable marks and the digest's reads: `tavi_memory_marks` takes every kind the contract names; a mark is claimed once (and a
 * `fresh` one taken once), goes with
 * its chat, and survives a backup; a digest card's words are counts and a
 * date; a person's direct conversations are found by their binding; and a
 * card sent to several chats is found in each.
 */

const AT = "2026-10-11T08:00:00.000Z";

const cleanup: (() => void)[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  directories.cleanup();
});

function opened(databasePath = ":memory:") {
  const store = new SqliteStore(databasePath === ":memory:" ? { databasePath, inMemory: true } : { databasePath });
  cleanup.push(() => store.close());
  const repositories = store.asPort().repositories;
  const start = async (
    id: string,
    principalId = "operator",
    extra: {
      readonly origin?: TaskOrigin;
      readonly chatKind?: ChatKind;
      readonly memoryMode?: ChatMemoryMode;
      readonly parentChatId?: string;
    } = {},
  ) =>
    (
      await repositories.tasks.admit({
        workspaceId: "default",
        principalId,
        operationKey: id,
        kind: "start",
        intent: { prompt: `prompt ${id}` },
        checkpointNamespace: "",
        origin: extra.origin ?? "ipc",
        ...definedOnly({ chatKind: extra.chatKind, memoryMode: extra.memoryMode, parentChatId: extra.parentChatId }),
        now: () => AT,
        newTaskId: () => id,
        newThreadId: () => `thread-${id}`,
        newAdmissionId: () => `admission-${id}`,
      })
    ).task;
  return { store, repositories, start };
}

describe("memory marks", () => {
  it("take every kind the contract names, and refuse another", async () => {
    const { store, start } = opened();
    await start("chat");
    const insert = (kind: string) =>
      store.handle.prepare("INSERT INTO tavi_memory_marks(task_id, kind, mark, at) VALUES ('chat', ?, 'm', ?)").run(kind, AT);
    for (const kind of MEMORY_MARK_KINDS) expect(() => insert(kind), kind).not.toThrow();
    expect(() => insert("not-a-kind")).toThrow(/CHECK/);
  });

  it("are claimed once: a second claim of the same mark, as after a restart, writes nothing", async () => {
    const { repositories, start } = opened();
    await start("home");
    const { transcripts } = repositories;
    expect(await transcripts.lastMemoryMark({ taskId: "home", kind: "digest" })).toBeUndefined();
    expect(await transcripts.claimMemoryMark({ taskId: "home", kind: "digest", mark: "2026-10-11", at: AT })).toBe(true);
    expect(await transcripts.claimMemoryMark({ taskId: "home", kind: "digest", mark: "2026-10-11", at: "2026-10-11T09:00:00.000Z" })).toBe(
      false,
    );
    expect(await transcripts.claimMemoryMark({ taskId: "home", kind: "digest", mark: "2026-10-18", at: "2026-10-18T07:00:00.000Z" })).toBe(
      true,
    );
    // Another kind is its own.
    expect(await transcripts.claimMemoryMark({ taskId: "home", kind: "review", mark: "2026-10-11", at: AT })).toBe(true);
    expect(await transcripts.lastMemoryMark({ taskId: "home", kind: "digest" })).toEqual({
      mark: "2026-10-18",
      at: "2026-10-18T07:00:00.000Z",
    });
  });

  it("are taken once: a persisted Fresh context request is removed by the first take only", async () => {
    const { repositories, start } = opened();
    await start("home");
    const { transcripts } = repositories;
    expect(await transcripts.takeMemoryMark({ taskId: "home", kind: "fresh", mark: "next" })).toBe(false);
    expect(await transcripts.claimMemoryMark({ taskId: "home", kind: "fresh", mark: "next", at: AT })).toBe(true);
    // Asked again before it is taken: the same request.
    expect(await transcripts.claimMemoryMark({ taskId: "home", kind: "fresh", mark: "next", at: "2026-10-11T09:00:00.000Z" })).toBe(false);
    // Another kind's mark of the same name is not taken with it.
    await transcripts.claimMemoryMark({ taskId: "home", kind: "flush", mark: "next", at: AT });
    expect(await transcripts.takeMemoryMark({ taskId: "home", kind: "fresh", mark: "next" })).toBe(true);
    expect(await transcripts.takeMemoryMark({ taskId: "home", kind: "fresh", mark: "next" })).toBe(false);
    expect(await transcripts.lastMemoryMark({ taskId: "home", kind: "flush" })).toEqual({ mark: "next", at: AT });
  });

  it("give doctor each chat's newest digest with whose chat it is, and go when the chat goes", async () => {
    const { store, repositories, start } = opened();
    await start("home");
    await start("bob-dm", "bob");
    const { transcripts } = repositories;
    await transcripts.claimMemoryMark({ taskId: "home", kind: "digest", mark: "2026-10-04", at: "2026-10-04T07:00:00.000Z" });
    await transcripts.claimMemoryMark({ taskId: "home", kind: "digest", mark: "2026-10-11", at: AT });
    await transcripts.claimMemoryMark({ taskId: "bob-dm", kind: "digest", mark: "2026-10-10", at: "2026-10-10T07:00:00.000Z" });
    await transcripts.claimMemoryMark({ taskId: "bob-dm", kind: "review", mark: "x", at: "2026-10-12T07:00:00.000Z" });
    expect(await transcripts.memoryMarksOf({ workspaceId: "default", kind: "digest" })).toEqual([
      { taskId: "home", principalId: "operator", mark: "2026-10-11", at: AT },
      { taskId: "bob-dm", principalId: "bob", mark: "2026-10-10", at: "2026-10-10T07:00:00.000Z" },
    ]);
    expect(await transcripts.memoryMarksOf({ workspaceId: "other", kind: "digest" })).toEqual([]);
    store.handle.prepare("DELETE FROM tavi_tasks WHERE task_id = 'bob-dm'").run();
    expect(store.handle.prepare("SELECT count(*) AS n FROM tavi_memory_marks WHERE task_id = 'bob-dm'").get()).toEqual({ n: 0 });
  });

  it("are carried through a snapshot and a restore, so a restored owner does not repeat a digest", async () => {
    const root = directories.create("tavi-memory-marks-");
    const source = join(root, "source");
    const target = join(root, "target");
    for (const directory of [source, target]) {
      const { store, repositories, start } = opened(join(directory, "tavi.sqlite"));
      if (directory === source) {
        await start("home");
        await repositories.transcripts.claimMemoryMark({ taskId: "home", kind: "digest", mark: "2026-10-11", at: AT });
      }
      store.close();
      cleanup.pop();
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
    const { repositories } = opened(join(target, "tavi.sqlite"));
    expect(await repositories.transcripts.lastMemoryMark({ taskId: "home", kind: "digest" })).toEqual({ mark: "2026-10-11", at: AT });
    expect(await repositories.transcripts.claimMemoryMark({ taskId: "home", kind: "digest", mark: "2026-10-11", at: AT })).toBe(false);
  });
});

describe("a digest card", () => {
  it("memory invariant 22: its notice holds counts and a date, never a record's text", async () => {
    const { store, repositories, start } = opened();
    await start("home");
    const records = ["r1", "r2"].map((recordId) => ({ recordId, workspaceId: "default", principalId: "operator" }));
    const posted = await repositories.transcripts.postMemoryCard({
      noticeId: "digest-1",
      taskId: "home",
      sourceKey: "memory:digest:2026-10-11",
      createdAt: AT,
      records,
      digest: { waiting: 14, oldestExpires: "Thu 15 Oct" },
    });
    expect(posted.notice.title).toBe("2 of 14 things waiting to be remembered — the oldest expires Thu 15 Oct");
    expect(posted.notice.summary).toBe("");
    expect(posted.prompts.map((row) => row.number)).toEqual([1, 2]);
    expect(memoryDigestOf(posted.notice.title)).toEqual({ waiting: 14 });
    expect(JSON.stringify(store.handle.prepare("SELECT * FROM tavi_chat_notices").all())).not.toMatch(/r1|r2/);
    expect(memoryDigestNoticeText({ listed: 1, waiting: 1, oldestExpires: "Mon 12 Oct" }).title).toBe(
      "1 thing waiting to be remembered — the oldest expires Mon 12 Oct",
    );
    expect(memoryDigestOf("2 things to remember")).toBeUndefined();
  });

  it("sent to several chats, is found in each, so a forget edits every one", async () => {
    const { repositories } = opened();
    const { transcripts, messagingOutbox: outbox } = repositories;
    for (const [suffix, connectionId, id] of [
      ["", "conn-a", "1"],
      [":conn-b:7", "conn-b", "2"],
      [":conn-c:8", "conn-c", "3"],
    ] as const) {
      const effectId = `memory-card:digest-1${suffix}`;
      await outbox.begin({
        effectId,
        connectionId,
        message: { destination: { chatId: id }, parts: [{ content: "x" }] } as never,
        now: () => AT,
      });
      if (connectionId !== "conn-c")
        await outbox.resolve({
          effectId,
          outcome: { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: `m${id}` }] },
          now: () => AT,
        });
    }
    // Another card whose id starts the same is not this one's.
    await outbox.begin({
      effectId: "memory-card:digest-10",
      connectionId: "conn-a",
      message: { destination: { chatId: "9" }, parts: [{ content: "x" }] } as never,
      now: () => AT,
    });
    await outbox.resolve({
      effectId: "memory-card:digest-10",
      outcome: { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "m9" }] },
      now: () => AT,
    });
    expect(await transcripts.memoryCardMessages("memory-card:digest-1")).toEqual([
      { connectionId: "conn-a", destination: { chatId: "1" }, messageId: "m1" },
      { connectionId: "conn-b", destination: { chatId: "2" }, messageId: "m2" },
    ]);
  });
});

describe("a person's direct conversations", () => {
  it("are their active one-to-one chats whose sender is bound to them, newest first; never a group, another's or an unbound one", async () => {
    const { repositories, start } = opened();
    const { messagingConversations: conversations, messagingIdentityBindings: bindings } = repositories;
    for (const id of ["bob-tg", "bob-wa", "bob-group", "bob-unbound"]) await start(id, "bob");
    await start("carol-tg", "carol");
    await bindings.bind({
      connectionId: "tg",
      externalSenderId: "bob-1",
      workspaceId: "default",
      principalId: "bob",
      approvedBy: "operator",
      createdAt: AT,
    });
    await bindings.bind({
      connectionId: "wa",
      externalSenderId: "bob-2",
      workspaceId: "default",
      principalId: "bob",
      approvedBy: "operator",
      createdAt: AT,
    });
    await bindings.bind({
      connectionId: "tg",
      externalSenderId: "carol-1",
      workspaceId: "default",
      principalId: "carol",
      approvedBy: "operator",
      createdAt: AT,
    });
    const record = (
      taskId: string,
      connectionId: string,
      conversation: string,
      sender: string,
      kind: "direct" | "group",
      createdAt: string,
    ) =>
      conversations.record({
        connectionId,
        externalConversationId: conversation,
        taskId,
        createdAt,
        conversationKind: kind,
        replyTo: { connectionId, externalConversationId: conversation, externalSenderId: sender },
      });
    await record("bob-tg", "tg", "bob-1", "bob-1", "direct", "2026-10-01T00:00:00.000Z");
    await record("bob-wa", "wa", "bob-2", "bob-2", "direct", "2026-10-05T00:00:00.000Z");
    await record("bob-group", "tg", "group-9", "bob-1", "group", "2026-10-06T00:00:00.000Z");
    await record("bob-unbound", "tg", "stranger", "stranger", "direct", "2026-10-07T00:00:00.000Z");
    await record("carol-tg", "tg", "carol-1", "carol-1", "direct", "2026-10-08T00:00:00.000Z");
    expect((await conversations.directTasksOf("default", "bob")).map((mapping) => mapping.taskId)).toEqual(["bob-wa", "bob-tg"]);
    expect(await conversations.directTasksOf("other", "bob")).toEqual([]);
    // Ended by /new: no longer where anything is posted.
    await conversations.reset("wa", "bob-2", AT);
    expect((await conversations.directTasksOf("default", "bob")).map((mapping) => mapping.taskId)).toEqual(["bob-tg"]);
  });
});

describe("the idle review's reads", () => {
  const turn = (prompt: string) => ({
    admissionKind: "reply" as const,
    prompt,
    items: [],
    outcome: { status: "completed" as const, finalText: "ok" },
  });

  it("review marks sort by the turn they read through and read back what they say", () => {
    expect(memoryReviewMark({ seq: 42, outcome: "seed" })).toBe("r0000000042;seed");
    expect(memoryReviewMark({ seq: 42, outcome: "claimed" })).toBe("r0000000042");
    const reviewed = memoryReviewMark({
      seq: 42,
      outcome: "reviewed",
      filed: 2,
      dropped: { secret: 0, sensitive: 1, known: 3, similar: 0 },
    });
    expect(parseMemoryReviewMark(reviewed)).toEqual({
      seq: 42,
      outcome: "reviewed",
      filed: 2,
      dropped: { secret: 0, sensitive: 1, known: 3, similar: 0 },
    });
    expect(parseMemoryReviewMark("r0000000007;skipped")).toEqual({ seq: 7, outcome: "skipped" });
    expect(parseMemoryReviewMark("r0000000007")).toEqual({ seq: 7, outcome: "claimed" });
    expect(memoryReviewMark({ seq: 9, outcome: "seed" }) < memoryReviewMark({ seq: 10, outcome: "claimed" })).toBe(true);
    expect(memoryReviewFailureMark(7, 2)).toBe("x0000000007;2");
    expect(isMemoryReviewFailureMark("x0000000007;2")).toBe(true);
    expect(parseMemoryReviewMark("x0000000007;2")).toBeUndefined();
  });

  it("finds attended Home, side and ordinary chats with memory on — never a worker, a run, a messaging, reminder or heartbeat chat, nor one with memory off or private", async () => {
    const { repositories, start } = opened();
    await start("home", "operator", { origin: "web", chatKind: "home" });
    await start("side", "operator", { origin: "web", chatKind: "side", parentChatId: "home" });
    await start("plain", "operator", { origin: "cli" });
    await start("worker", "operator", { origin: "agent", chatKind: "worker" });
    await start("run", "operator", { origin: "cli", chatKind: "run" });
    await start("group", "operator", { origin: "messaging" });
    await start("routine", "operator", { origin: "reminder" });
    await start("tick", "operator", { origin: "heartbeat" });
    await start("off", "operator", { origin: "web", memoryMode: "off" });
    await start("private", "operator", { origin: "web", memoryMode: "private" });
    await start("empty", "operator", { origin: "web" });
    for (const taskId of ["home", "side", "plain", "worker", "run", "group", "routine", "tick", "off", "private"]) {
      await repositories.transcripts.append({ taskId, turn: turn("hello there"), createdAt: "2026-10-11T09:00:00.000Z" });
    }
    const found = await repositories.transcripts.memoryReviewChats({ workspaceId: "default", savedBefore: "2026-10-11T10:00:00.000Z" });
    expect(found.map((chat) => chat.taskId).sort()).toEqual(["home", "plain", "side"]);
    expect(await repositories.transcripts.memoryReviewChats({ workspaceId: "other", savedBefore: AT })).toEqual([]);
  });

  it("memory invariant 23: a chat's seed is its newest turn saved before the review first ran, and the span's failures are those after its mark", async () => {
    const { repositories, start } = opened();
    await start("home", "operator", { origin: "web", chatKind: "home" });
    // Saved before the upgrade, carrying no taint mark: never to be reviewed.
    for (const [index, at] of ["2026-10-11T08:00:00.000Z", "2026-10-11T08:30:00.000Z"].entries())
      await repositories.transcripts.append({ taskId: "home", turn: turn(`old ${index}`), createdAt: at });
    await repositories.transcripts.append({ taskId: "home", turn: turn("new"), createdAt: "2026-10-11T10:30:00.000Z" });
    const [chat] = await repositories.transcripts.memoryReviewChats({ workspaceId: "default", savedBefore: "2026-10-11T10:00:00.000Z" });
    expect(chat).toEqual({
      taskId: "home",
      principalId: "operator",
      newestSeq: 3,
      newestAt: "2026-10-11T10:30:00.000Z",
      seedSeq: 2,
      failures: 0,
    });
    const { transcripts } = repositories;
    await transcripts.claimMemoryMark({
      taskId: "home",
      kind: "review",
      mark: memoryReviewMark({ seq: 2, outcome: "seed" }),
      at: "2026-10-11T10:01:00.000Z",
    });
    await transcripts.claimMemoryMark({
      taskId: "home",
      kind: "review",
      mark: memoryReviewFailureMark(2, 1),
      at: "2026-10-11T10:41:00.000Z",
    });
    await transcripts.claimMemoryMark({
      taskId: "home",
      kind: "review",
      mark: memoryReviewFailureMark(2, 2),
      at: "2026-10-11T11:41:00.000Z",
    });
    // A failure on an older span is not this one's.
    await transcripts.claimMemoryMark({
      taskId: "home",
      kind: "review",
      mark: memoryReviewFailureMark(1, 1),
      at: "2026-10-11T07:00:00.000Z",
    });
    const [marked] = await transcripts.memoryReviewChats({ workspaceId: "default", savedBefore: "2026-10-11T10:00:00.000Z" });
    expect(marked).toMatchObject({
      review: { mark: "r0000000002;seed", at: "2026-10-11T10:01:00.000Z" },
      failures: 2,
      lastFailureAt: "2026-10-11T11:41:00.000Z",
    });
    // Skipped past it: the newest mark by the turn it reads through, and no failures on the new span.
    await transcripts.claimMemoryMark({
      taskId: "home",
      kind: "review",
      mark: memoryReviewMark({ seq: 3, outcome: "skipped" }),
      at: "2026-10-11T12:41:00.000Z",
    });
    const [skipped] = await transcripts.memoryReviewChats({ workspaceId: "default", savedBefore: "2026-10-11T10:00:00.000Z" });
    expect(skipped).toMatchObject({ review: { mark: "r0000000003;skipped" }, failures: 0 });
    expect(skipped?.lastFailureAt).toBeUndefined();
    // The day's marks, for the cap and doctor, newest first.
    expect(
      (await transcripts.memoryMarksSince({ workspaceId: "default", kind: "review", since: "2026-10-11T10:30:00.000Z" })).map(
        (mark) => mark.mark,
      ),
    ).toEqual(["r0000000003;skipped", "x0000000002;2", "x0000000002;1"]);
  });
});
