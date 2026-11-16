import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CHAT_NOTICE_KINDS, memoryCardCountOf, type MemoryActor } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";

import { MemoryService } from "../src/memory/service.js";
import { createSnapshot, restoreSnapshot } from "../src/persistence/administration.js";
import type { Database } from "../src/persistence/sqlite-loader.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Memory cards' storage: the notices
 * table takes the `memory` kind, and `tavi_memory_prompts` holds a card's
 * records as ids; the transcripts repository
 * posts a card, the forget path deletes a record's rows, and the retention
 * sweep settles and deletes them. And a trap: a later
 * rebuild of the notices table must carry the prompt rows over.
 */

const AT = "2026-10-11T08:00:00.000Z";
const OPERATOR: MemoryActor = { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" };
const AGENT: MemoryActor = { ...OPERATOR, caller: "agent", authority: "model" };
const PERSONAL = { kind: "personal", principalId: "operator" } as const;

const cleanup: (() => void)[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  directories.cleanup();
});

function opened(): { readonly store: SqliteStore; readonly memory: MemoryService } {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  cleanup.push(() => store.close());
  let counter = 0;
  const memory = new MemoryService(store.asPort(), { now: () => AT, newId: (prefix) => `${prefix}-${(counter += 1)}` });
  store.handle
    .prepare(
      "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at) VALUES('chat','default','operator','t','','completed',?,?)",
    )
    .run(AT, AT);
  return { store, memory };
}

const rowOf = (recordId: string) => ({ recordId, workspaceId: "default", principalId: "operator" });

/** The notices table rebuilt the way 0131 does (`DROP TABLE` and rename); `keepPrompts` copies the cards' rows aside and back, as the trap note asks. */
function rebuildChatNotices(db: Database, options: { readonly keepPrompts: boolean }): void {
  db.transaction(() => {
    if (options.keepPrompts) db.exec("CREATE TEMP TABLE prompts_aside AS SELECT * FROM tavi_memory_prompts;");
    db.exec(`
CREATE TABLE tavi_chat_notices_next (
  notice_id         TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tavi_tasks (task_id) ON DELETE CASCADE,
  source_key        TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('run-result', 'run-settled', 'side-chat-settled', 'earlier-chats', 'reminder', 'conversation', 'epoch', 'folder', 'heartbeat', 'memory', 'a-later-kind')),
  source_task_id    TEXT,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  after_seq         INTEGER NOT NULL CHECK (after_seq >= 0),
  read_by           TEXT,
  created_at        TEXT NOT NULL,
  artifact_id       TEXT,
  heartbeat_item_id TEXT
);
INSERT INTO tavi_chat_notices_next SELECT * FROM tavi_chat_notices;
DROP TABLE tavi_chat_notices;
ALTER TABLE tavi_chat_notices_next RENAME TO tavi_chat_notices;
CREATE UNIQUE INDEX tavi_chat_notices_source_idx ON tavi_chat_notices (task_id, source_key);
CREATE INDEX tavi_chat_notices_task_idx ON tavi_chat_notices (task_id, after_seq, created_at);
`);
    if (options.keepPrompts) db.exec("INSERT INTO tavi_memory_prompts SELECT * FROM prompts_aside; DROP TABLE prompts_aside;");
  })();
}

describe("the notices table", () => {
  it("takes every kind the contract names, and refuses another", () => {
    const { store } = opened();
    const insert = (kind: string) =>
      store.handle
        .prepare(
          "INSERT INTO tavi_chat_notices(notice_id,task_id,source_key,kind,title,summary,after_seq,created_at) VALUES(?,'chat',?,?,'t','s',0,?)",
        )
        .run(`k-${kind}`, `k:${kind}`, kind, AT);
    for (const kind of CHAT_NOTICE_KINDS) expect(() => insert(kind), kind).not.toThrow();
    expect(() => insert("not-a-kind")).toThrow(/CHECK/);
  });

  it("the trap: a later rebuild of the notices table keeps every card's rows only when it copies them aside and back", async () => {
    for (const keepPrompts of [true, false]) {
      const { store } = opened();
      const transcripts = store.asPort().repositories.transcripts;
      await transcripts.postMemoryCard({
        noticeId: "card-1",
        taskId: "chat",
        sourceKey: "memory:a1",
        createdAt: AT,
        records: [rowOf("r1"), rowOf("r2")],
      });
      await transcripts.postMemoryCard({
        noticeId: "card-2",
        taskId: "chat",
        sourceKey: "memory:flush:e1",
        createdAt: AT,
        records: [rowOf("r3")],
      });
      const before = store.handle.prepare("SELECT * FROM tavi_memory_prompts ORDER BY token").all();
      expect(before).toHaveLength(3);
      rebuildChatNotices(store.handle as unknown as Database, { keepPrompts });
      const after = store.handle.prepare("SELECT * FROM tavi_memory_prompts ORDER BY token").all();
      // Migrations run with foreign keys on: a plain DROP cascades through `notice_id`.
      if (keepPrompts) expect(after).toEqual(before);
      else expect(after).toEqual([]);
    }
  });
});

describe("memory cards in the transcripts repository", () => {
  it("posts one card per key, numbers its records, adds only new ones, and holds counts, never text (memory invariant 22)", async () => {
    const { store, memory } = opened();
    const transcripts = store.asPort().repositories.transcripts;
    const first = await memory.propose({
      actor: AGENT,
      scope: PERSONAL,
      kind: "fact",
      title: "You're vegetarian",
      body: "The person is vegetarian",
    });
    const second = await memory.propose({ actor: AGENT, scope: PERSONAL, kind: "fact", body: "The person lives in Lisbon" });
    const one = await transcripts.postMemoryCard({
      noticeId: "card-1",
      taskId: "chat",
      sourceKey: "memory:a1",
      createdAt: AT,
      records: [rowOf(first.recordId)],
    });
    const two = await transcripts.postMemoryCard({
      noticeId: "ignored",
      taskId: "chat",
      sourceKey: "memory:a1",
      createdAt: AT,
      records: [rowOf(first.recordId), rowOf(second.recordId)],
    });
    expect(two.notice.noticeId).toBe(one.notice.noticeId);
    expect(two.prompts.map((row) => [row.recordId, row.number])).toEqual([
      [first.recordId, 1],
      [second.recordId, 2],
    ]);
    expect(two.notice).toMatchObject({ kind: "memory", title: "2 things to remember", summary: "" });
    expect(memoryCardCountOf(two.notice.title)).toBe(2);
    // Nothing on the notice or its rows is the records' words.
    const stored = JSON.stringify([
      store.handle.prepare("SELECT * FROM tavi_chat_notices").all(),
      store.handle.prepare("SELECT * FROM tavi_memory_prompts").all(),
    ]);
    for (const text of ["vegetarian", "Lisbon"]) expect(stored).not.toContain(text);
    expect(
      (
        await transcripts.postMemoryCard({
          noticeId: "flush",
          taskId: "chat",
          sourceKey: "memory:flush:e2",
          createdAt: AT,
          records: [rowOf(second.recordId)],
        })
      ).notice.title,
    ).toBe("1 thing to remember from before this chat rolled over");
  });

  it("numbers a command's listing per surface, never shows it, and reads the newest of the chat's cards and this surface's listing", async () => {
    const { store } = opened();
    const transcripts = store.asPort().repositories.transcripts;
    const later = (minutes: number): string => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
    await transcripts.postMemoryCard({
      noticeId: "card-1",
      taskId: "chat",
      sourceKey: "memory:a1",
      createdAt: later(1),
      records: [rowOf("r1"), rowOf("r2")],
    });
    // The terminal lists three, numbered its own way.
    const listed = await transcripts.postMemoryListing({
      noticeId: "list-ipc",
      taskId: "chat",
      surface: "ipc",
      createdAt: later(2),
      records: [rowOf("r3"), rowOf("r1"), rowOf("r3")],
    });
    expect(listed.map((row) => [row.number, row.recordId])).toEqual([
      [1, "r3"],
      [2, "r1"],
    ]);
    expect((await transcripts.memoryNumbers({ taskId: "chat", surface: "ipc" })).map((row) => row.recordId)).toEqual(["r3", "r1"]);
    // Telegram still reads the card it was shown: another surface's listing is not in the race.
    expect((await transcripts.memoryNumbers({ taskId: "chat", surface: "conn-a" })).map((row) => row.recordId)).toEqual(["r1", "r2"]);
    // A newer card wins over the terminal's older listing too.
    await transcripts.postMemoryCard({
      noticeId: "card-2",
      taskId: "chat",
      sourceKey: "memory:a2",
      createdAt: later(3),
      records: [rowOf("r4")],
    });
    expect((await transcripts.memoryNumbers({ taskId: "chat", surface: "ipc" })).map((row) => row.recordId)).toEqual(["r4"]);
    // A new listing replaces the surface's numbers; an empty one clears them.
    await transcripts.postMemoryListing({ noticeId: "ignored", taskId: "chat", surface: "ipc", createdAt: later(4), records: [] });
    expect(await transcripts.memoryNumbers({ taskId: "chat", surface: "ipc" })).toEqual([]);
    // Never shown: not among the chat's notices, nor on a transcript page.
    expect((await transcripts.notices("chat", { limit: 50 })).map((notice) => notice.noticeId)).toEqual(["card-1", "card-2"]);
    expect(((await transcripts.page("chat", { limit: 10 })).notices ?? []).map((notice) => notice.noticeId)).toEqual(["card-1", "card-2"]);
    expect(await transcripts.memoryNumbers({ taskId: "elsewhere", surface: "ipc" })).toEqual([]);
  });

  it("memory invariant 19: a card is posted read, so no turn ever claims its words", async () => {
    const { store } = opened();
    const transcripts = store.asPort().repositories.transcripts;
    await transcripts.postMemoryCard({ noticeId: "card-1", taskId: "chat", sourceKey: "memory:a1", createdAt: AT, records: [rowOf("r1")] });
    await transcripts.postNotice({
      noticeId: "other",
      taskId: "chat",
      kind: "run-result",
      sourceKey: "run:x",
      title: "A run",
      summary: "Completed",
      createdAt: AT,
    });
    const claim = await transcripts.claimNotices("chat", "turn-1", 10);
    expect(claim.notices.map((notice) => notice.kind)).toEqual(["run-result"]);
    expect(await transcripts.releaseOrphanedNotices()).toBe(1);
    expect((await transcripts.claimNotices("chat", "turn-2", 10)).notices.map((notice) => notice.kind)).toEqual(["run-result"]);
  });

  it("memory invariant 9: forgetting a record deletes its rows on every card, in the forget's transaction, with its journal row", async () => {
    const { store, memory } = opened();
    const transcripts = store.asPort().repositories.transcripts;
    const kept = await memory.propose({ actor: AGENT, scope: PERSONAL, kind: "fact", body: "The person likes tea" });
    const forgotten = await memory.propose({ actor: AGENT, scope: PERSONAL, kind: "fact", body: "The person is vegetarian" });
    await transcripts.postMemoryCard({
      noticeId: "card-1",
      taskId: "chat",
      sourceKey: "memory:a1",
      createdAt: AT,
      records: [rowOf(kept.recordId), rowOf(forgotten.recordId)],
    });
    await memory.forget({ actor: OPERATOR, recordId: forgotten.recordId, reason: "undone from a memory card" });
    expect((await transcripts.memoryPrompts("card-1")).map((row) => row.recordId)).toEqual([kept.recordId]);
    expect(store.handle.prepare("SELECT count(*) AS n FROM tavi_memory_deletions WHERE record_id = ?").get(forgotten.recordId)).toEqual({
      n: 1,
    });
    expect(JSON.stringify(store.handle.prepare("SELECT * FROM tavi_memory_prompts").all())).not.toContain(forgotten.recordId);
  });

  it("the sweep settles rows whose record no longer waits, and deletes a card's rows a week after all of them settled", async () => {
    const { store, memory } = opened();
    const transcripts = store.asPort().repositories.transcripts;
    const decided = await memory.propose({ actor: AGENT, scope: PERSONAL, kind: "fact", body: "The person likes tea" });
    const waiting = await memory.propose({ actor: AGENT, scope: PERSONAL, kind: "fact", body: "The person likes coffee" });
    await transcripts.postMemoryCard({
      noticeId: "mixed",
      taskId: "chat",
      sourceKey: "memory:a1",
      createdAt: AT,
      records: [rowOf(decided.recordId), rowOf(waiting.recordId)],
    });
    const lone = await memory.propose({ actor: AGENT, scope: PERSONAL, kind: "fact", body: "The person likes juice" });
    await transcripts.postMemoryCard({
      noticeId: "settled",
      taskId: "chat",
      sourceKey: "memory:a2",
      createdAt: AT,
      records: [rowOf(lone.recordId)],
    });
    await memory.approve({ actor: OPERATOR, recordId: decided.recordId });
    await memory.reject({ actor: OPERATOR, recordId: lone.recordId });

    expect(await transcripts.pruneMemoryPrompts({ now: AT, settledBefore: "2026-10-04T08:00:00.000Z" })).toEqual({
      settled: 2,
      deleted: 0,
    });
    // A week later: the card whose rows all settled goes; the one still waiting on a record stays whole.
    expect(await transcripts.pruneMemoryPrompts({ now: "2026-10-19T08:00:00.000Z", settledBefore: "2026-10-12T08:00:00.000Z" })).toEqual({
      settled: 0,
      deleted: 1,
    });
    expect(await transcripts.memoryPrompts("settled")).toEqual([]);
    expect((await transcripts.memoryPrompts("mixed")).map((row) => row.recordId)).toEqual([decided.recordId, waiting.recordId]);
  });
});

describe("memory cards on channels", () => {
  it("finds a card row by its token and a record's rows on every card; both go with a forget", async () => {
    const { store, memory } = opened();
    const transcripts = store.asPort().repositories.transcripts;
    const record = await memory.propose({ actor: AGENT, scope: PERSONAL, kind: "fact", body: "The person likes tea" });
    const one = await transcripts.postMemoryCard({
      noticeId: "card-1",
      taskId: "chat",
      sourceKey: "memory:a1",
      createdAt: AT,
      records: [rowOf(record.recordId)],
    });
    await transcripts.postMemoryCard({
      noticeId: "card-2",
      taskId: "chat",
      sourceKey: "memory:a2",
      createdAt: AT,
      records: [rowOf("other"), rowOf(record.recordId)],
    });
    const [row] = one.prompts;
    expect(await transcripts.memoryPromptByToken(row?.token ?? "")).toEqual(row);
    expect(await transcripts.memoryPromptByToken("no-such-token")).toBeUndefined();
    expect((await transcripts.memoryPromptsOfRecord(record.recordId)).map((each) => [each.noticeId, each.number])).toEqual([
      ["card-1", 1],
      ["card-2", 2],
    ]);
    await memory.forget({ actor: OPERATOR, recordId: record.recordId, reason: "test" });
    expect(await transcripts.memoryPromptByToken(row?.token ?? "")).toBeUndefined();
    expect(await transcripts.memoryPromptsOfRecord(record.recordId)).toEqual([]);
  });

  it("memory invariant 22: a sent card's send keeps where it went and its message id, never its words", async () => {
    const { store } = opened();
    const transcripts = store.asPort().repositories.transcripts;
    const outbox = store.asPort().repositories.messagingOutbox;
    const message = {
      effectId: "memory-card:card-1",
      connectionId: "conn-a",
      destination: { chatId: "42" },
      parts: [{ content: "Proposed · remember everywhere\nYou're vegetarian" }],
      buttons: [[{ label: "Keep", data: "y:abcdefghijklmnop:k" }]],
    };
    await outbox.begin({ effectId: message.effectId, connectionId: "conn-a", message, now: () => AT });
    expect(await transcripts.memoryCardMessages(message.effectId)).toEqual([]);
    await outbox.resolve({
      effectId: message.effectId,
      outcome: { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "777" }] },
      now: () => AT,
    });
    expect(await transcripts.eraseMemoryCardMessage(message.effectId)).toBe(true);
    expect(await transcripts.memoryCardMessages(message.effectId)).toEqual([
      { connectionId: "conn-a", destination: { chatId: "42" }, messageId: "777" },
    ]);
    const stored = JSON.stringify(store.handle.prepare("SELECT * FROM tavi_messaging_outbox").all());
    expect(stored).not.toContain("vegetarian");
    expect(stored).not.toContain("y:abcdefghijklmnop");
    expect(await transcripts.eraseMemoryCardMessage("memory-card:none")).toBe(false);
    // A send that never resolved (it threw, or the process stopped) is erased too.
    const pending = { ...message, effectId: "memory-card:card-2" };
    await outbox.begin({ effectId: pending.effectId, connectionId: "conn-a", message: pending, now: () => AT });
    expect(await transcripts.eraseMemoryCardMessage(pending.effectId)).toBe(true);
    expect(JSON.stringify(store.handle.prepare("SELECT * FROM tavi_messaging_outbox").all())).not.toContain("vegetarian");
  });
});

describe("a backup of memory cards", () => {
  it("carries the card and its rows through a snapshot and a restore", async () => {
    const root = directories.create("tavi-memory-cards-");
    const source = join(root, "source");
    const target = join(root, "target");
    for (const directory of [source, target]) {
      const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite") });
      if (directory === source) {
        store.handle
          .prepare(
            "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at) VALUES('chat','default','operator','t','','completed',?,?)",
          )
          .run(AT, AT);
        await store.asPort().repositories.transcripts.postMemoryCard({
          noticeId: "card-1",
          taskId: "chat",
          sourceKey: "memory:a1",
          createdAt: AT,
          records: [rowOf("r1"), rowOf("r2")],
        });
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
    const restored = new SqliteStore({ databasePath: join(target, "tavi.sqlite") });
    try {
      const transcripts = restored.asPort().repositories.transcripts;
      expect((await transcripts.getNotice("card-1"))?.kind).toBe("memory");
      expect((await transcripts.memoryPrompts("card-1")).map((row) => [row.recordId, row.number])).toEqual([
        ["r1", 1],
        ["r2", 2],
      ]);
    } finally {
      restored.close();
    }
  });
});
