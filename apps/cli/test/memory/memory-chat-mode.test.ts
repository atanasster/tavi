import {
  ChatContextPayloadSchema,
  PRIVATE_CHAT_KEEP_MS,
  RunPayloadSchema,
  type MemoryActor,
  type ModelPort,
  type ModelRequest,
  type ModEnvelope,
  type TaskRecord,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, waitFor, delay } from "@tavi/test-support";
import { instructionsAndContextOf } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { pastChatSearchTerms } from "../../src/features/tools/assistant.js";
import { chatContextCommand } from "../../src/features/tasks/history-owner.js";
import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { chatMemoryOf } from "../../src/runtime/chat-scope.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { MEMORY_OFF_ANSWER, MEMORY_PRIVATE_ANSWER } from "../../src/features/memory/slash.js";
import { inspectDatabase } from "../support/database-fixture.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Memory off per chat, and private chats: an off chat reads no memory, offers no `memory.*` or
 * `sessions.search` tool and captures nothing, until it is turned back on;
 * a private chat is off for good, set when it is created, left out of
 * past-chat search and *Earlier chats*, and its saved turns are forgotten 24 h
 * after its last turn. Side chats and workers follow their chat.
 */

const directories = temporaryDirectories({ prefix: "tavi-memory-chat-mode-" });
const runtimes: TaviRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

const OPERATOR = { workspaceId: "default", principalId: "operator" };
const OPERATOR_ACTOR: MemoryActor = { ...OPERATOR, caller: "test", authority: "operator" };
const PERSONAL = { kind: "personal", principalId: "operator" } as const;
const MEMORY_TOOLS = (tools: readonly string[]): readonly string[] =>
  tools.filter((id) => id.startsWith("memory.") || id === "sessions.search");

/** Answers every turn with "Done", recording each request. */
function recordingModel(requests: ModelRequest[]): ModelPort {
  return {
    async stream(request) {
      requests.push(request);
      return {
        attemptId: request.attemptId,
        status: "completed",
        text: "Done.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      };
    },
  };
}

async function composed(
  extra: { readonly retentionSweepEnabled?: boolean; readonly retentionSweepIntervalMs?: number; readonly dataDirectory?: string } = {},
) {
  const requests: ModelRequest[] = [];
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(extra.dataDirectory ?? directories.create(), {
      workspaces: [{ ...OPERATOR, permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: [],
      memoryHostEnabled: true,
      ...(extra.retentionSweepEnabled === undefined ? {} : { retentionSweepEnabled: extra.retentionSweepEnabled }),
      ...(extra.retentionSweepIntervalMs === undefined ? {} : { retentionSweepIntervalMs: extra.retentionSweepIntervalMs }),
    }),
    { modelOverride: recordingModel(requests) },
  );
  runtimes.push(runtime);
  const repositories = runtime.store.asPort().repositories;
  let count = 0;
  /** A turn: a new chat (with `start`'s options) or the next turn of `taskId`; answers its chat and what its generation call was given. */
  const turn = async (
    prompt: string,
    target: { readonly taskId?: string; readonly memoryMode?: "off" | "private"; readonly parentChatId?: string } = {},
  ) => {
    count += 1;
    const before = requests.length;
    const result = await runtime.workflow?.admit({
      context: { ...OPERATOR, runId: "pending-admission", caller: "cli" },
      operationKey: `turn-${count}`,
      ...(target.taskId === undefined
        ? {
            kind: "start" as const,
            ...(target.memoryMode === undefined ? {} : { memoryMode: target.memoryMode }),
            ...(target.parentChatId === undefined ? {} : { chatKind: "side" as const, parentChatId: target.parentChatId }),
          }
        : { kind: "reply" as const, taskId: target.taskId }),
      prompt,
    });
    if (result === undefined) throw new Error("no workflow");
    const request = requests.slice(before).find((entry) => entry.purpose === undefined || entry.purpose === "generation");
    if (request === undefined) throw new Error("the turn made no model call");
    return {
      taskId: result.taskId,
      // The system text and the call's context block, where the manifest goes.
      instructionsAndContext: instructionsAndContextOf(request),
      tools: request.tools.map((tool) => tool.id),
    };
  };
  const chatContext = (payload: Record<string, unknown>) =>
    chatContextCommand(
      { repositories, author: "operator:cli", principalOf: () => "operator", now: () => nowTimestamp() },
      ChatContextPayloadSchema.parse({ workspaceId: "default", ...payload }),
    );
  /** A memory command from the terminal, as `plugin-commands` runs it, in chat `taskId`. */
  const command = async (line: string, taskId: string): Promise<string> => {
    const [name = "", ...rest] = line.slice(1).split(" ");
    // Under the per-sender command rate.
    await delay(260);
    const envelope: ModEnvelope = Object.freeze({ ...OPERATOR, taskId, runId: taskId, source: "ipc", frontEnd: "ipc", attended: true });
    return (await runtime.turnHooks.runCommand(name, { envelope, args: rest.join(" ") }))?.text ?? "(no command)";
  };
  const search = async (query: string) =>
    await runtime.store.searchTaskHistory({ ...OPERATOR, terms: pastChatSearchTerms(query), limit: 50 });
  return { runtime, repositories, turn, chatContext, command, search, requests };
}

describe("memory off per chat", () => {
  it("memory invariant 5: an off chat's next turn has no manifest and no memory.* or sessions.search tool; turning it on restores both from the next turn", async () => {
    const { runtime, turn, chatContext } = await composed();
    await runtime.memory.remember({ actor: OPERATOR_ACTOR, scope: PERSONAL, kind: "fact", body: "The person is vegetarian" });
    const on = await turn("ideas for a vegetarian dinner");
    expect(on.instructionsAndContext).toMatch(/The person is \[?vegetarian/);
    expect(MEMORY_TOOLS(on.tools)).toEqual(expect.arrayContaining(["memory.search", "memory.get", "memory.propose", "sessions.search"]));

    const turnedOff = await chatContext({ action: "memory", taskId: on.taskId, mode: "off" });
    expect(turnedOff).toMatchObject({ ok: true, result: { memoryMode: "off" } });
    expect(
      (await runtime.store.listTaskSessions({ ...OPERATOR, limit: 10 })).rows.find((row) => row.taskId === on.taskId)?.memoryMode,
    ).toBe("off");
    const off = await turn("ideas for a vegetarian dinner", { taskId: on.taskId });
    expect(off.instructionsAndContext).not.toMatch(/The person is \[?vegetarian/);
    expect(off.instructionsAndContext).not.toContain("Retrieved memory evidence");
    expect(MEMORY_TOOLS(off.tools)).toEqual([]);
    // Another chat keeps its memory: the mode is the chat's own.
    const other = await turn("ideas for a vegetarian dinner");
    expect(other.instructionsAndContext).toMatch(/The person is \[?vegetarian/);

    const turnedOn = await chatContext({ action: "memory", taskId: on.taskId, mode: "on" });
    expect(turnedOn.ok).toBe(true);
    expect(turnedOn.ok && "memoryMode" in turnedOn.result ? turnedOn.result.memoryMode : undefined).toBeUndefined();
    expect((await runtime.store.asPort().repositories.tasks.get(on.taskId))?.memoryOnAt).toBeDefined();
    const back = await turn("ideas for a vegetarian dinner", { taskId: on.taskId });
    expect(back.instructionsAndContext).toMatch(/The person is \[?vegetarian/);
    expect(MEMORY_TOOLS(back.tools)).toEqual(expect.arrayContaining(["memory.search", "memory.get", "memory.propose", "sessions.search"]));
    // Nothing was deleted.
    expect(await runtime.memory.list({ actor: OPERATOR_ACTOR, statuses: ["approved"] })).toHaveLength(1);
  }, 60_000);

  it("a side chat of an off chat is off, and a worker follows the chat it works for", async () => {
    const { runtime, turn, chatContext } = await composed();
    await runtime.memory.remember({ actor: OPERATOR_ACTOR, scope: PERSONAL, kind: "fact", body: "The person is vegetarian" });
    const parent = await turn("plan a dinner");
    await chatContext({ action: "memory", taskId: parent.taskId, mode: "off" });
    const side = await turn("ideas for a vegetarian dinner", { parentChatId: parent.taskId });
    expect((await runtime.store.asPort().repositories.tasks.get(side.taskId))?.memoryMode).toBe("off");
    expect(side.instructionsAndContext).not.toMatch(/The person is \[?vegetarian/);
    expect(MEMORY_TOOLS(side.tools)).toEqual([]);

    // A worker reads its chat's mode through its delegation, whatever its own row says.
    const tasks = new Map<string, Partial<TaskRecord>>([
      ["chat", { taskId: "chat", origin: "ipc", memoryMode: "off" }],
      ["worker", { taskId: "worker", origin: "agent" }],
      ["private-chat", { taskId: "private-chat", origin: "ipc", memoryMode: "private" }],
      ["private-worker", { taskId: "private-worker", origin: "agent" }],
      ["on-chat", { taskId: "on-chat", origin: "ipc", memoryOnAt: "2026-10-11T00:00:00.000Z" }],
    ]);
    const roots = new Map([
      ["worker", "chat"],
      ["private-worker", "private-chat"],
    ]);
    const repositories = {
      tasks: { get: async (taskId: string) => tasks.get(taskId) as TaskRecord | undefined },
      agentDelegations: {
        getByWorkerTaskId: async (taskId: string) => (roots.has(taskId) ? { rootTaskId: roots.get(taskId) } : undefined),
      },
    } as unknown as Parameters<typeof chatMemoryOf>[0];
    expect(await chatMemoryOf(repositories, "worker")).toEqual({ mode: "off" });
    expect(await chatMemoryOf(repositories, "private-worker")).toEqual({ mode: "private" });
    expect(await chatMemoryOf(repositories, "on-chat")).toEqual({ onAt: "2026-10-11T00:00:00.000Z" });
    // A worker of a worker of an off chat is off too; the chat panel names its chat's mode.
    expect(await chatMemoryOf(repositories, "chat")).toEqual({ mode: "off" });
  }, 60_000);

  it("a side chat opened before its parent was turned off reads no memory afterwards, and is left out of past-chat search", async () => {
    const { runtime, turn, chatContext, search } = await composed();
    await runtime.memory.remember({ actor: OPERATOR_ACTOR, scope: PERSONAL, kind: "fact", body: "The person is vegetarian" });
    const parent = await turn("plan a dinner");
    const side = await turn("ideas for a vegetarian dinner, the quince one", { parentChatId: parent.taskId });
    expect(side.instructionsAndContext).toMatch(/The person is \[?vegetarian/);
    await chatContext({ action: "memory", taskId: parent.taskId, mode: "off" });
    // Its own row still says on; its parent's mode is read live and the stricter stands.
    expect((await runtime.store.asPort().repositories.tasks.get(side.taskId))?.memoryMode).toBeUndefined();
    const after = await turn("ideas for a vegetarian dinner", { taskId: side.taskId });
    expect(after.instructionsAndContext).not.toMatch(/The person is \[?vegetarian/);
    expect(MEMORY_TOOLS(after.tools)).toEqual([]);
    expect((await search("quince")).map((hit) => hit.taskId)).not.toContain(side.taskId);
    // The parent back on: the side chat reads memory again.
    await chatContext({ action: "memory", taskId: parent.taskId, mode: "on" });
    expect((await turn("ideas for a vegetarian dinner", { taskId: side.taskId })).instructionsAndContext).toMatch(
      /The person is \[?vegetarian/,
    );
  }, 60_000);

  it("memory invariant 25: a side chat, one nested in it and a side chat's worker that talked while the parent was off are never found for those words, nor named by their titles, once the parent is back on", async () => {
    const { runtime, repositories, turn, chatContext, search } = await composed();
    const parent = await turn("plan a dinner");
    const side = await turn("a side chat about dinner", { parentChatId: parent.taskId });
    const nested = await turn("a nested side chat about dinner", { parentChatId: side.taskId });
    const worker = await turn("a side chat's worker");
    const db = inspectDatabase(runtime.store);
    db.prepare(
      "INSERT INTO tavi_agent_delegation_admissions(workspace_id,principal_id,operation_key,worker_task_id,worker_agent_id,created_at,parent_task_id,root_task_id) VALUES('default','operator','spawn-side-worker',?,'agent',?,?,?)",
    ).run(worker.taskId, nowTimestamp(), side.taskId, side.taskId);
    db.prepare("UPDATE tavi_tasks SET origin = 'agent' WHERE task_id = ?").run(worker.taskId);
    db.close();
    await delay(5);
    await chatContext({ action: "memory", taskId: parent.taskId, mode: "off" });
    await turn("the medlar said in the side chat while its parent was off", { taskId: side.taskId });
    await turn("the medlar said in the nested chat while its grandparent was off", { taskId: nested.taskId });
    await turn("the medlar a side chat's worker said while the parent was off", { taskId: worker.taskId });
    // A title written from those words (a generated one) must not name the chat either.
    const titled = inspectDatabase(runtime.store);
    titled
      .prepare("UPDATE tavi_tasks SET title = 'Medlar secrets' WHERE task_id IN (?, ?, ?)")
      .run(side.taskId, nested.taskId, worker.taskId);
    titled.close();
    await delay(5);
    await chatContext({ action: "memory", taskId: parent.taskId, mode: "on" });
    await delay(5);
    await turn("the medlar said in the side chat after the parent was back on", { taskId: side.taskId });
    // The flush reads the chain's latest `memory_on_at`, as the turn path does.
    const onAt = (await repositories.tasks.get(parent.taskId))?.memoryOnAt;
    expect(onAt).toBeDefined();
    expect(await chatMemoryOf(repositories, side.taskId)).toEqual({ onAt });
    expect(await chatMemoryOf(repositories, nested.taskId)).toEqual({ onAt });
    expect(await chatMemoryOf(repositories, worker.taskId)).toEqual({ onAt });
    const hits = await search("medlar");
    const excerpts = hits.map((hit) => hit.excerpt);
    expect(excerpts.some((excerpt) => excerpt.includes("after the parent was back on"))).toBe(true);
    expect(excerpts.some((excerpt) => excerpt.includes("while its parent was off"))).toBe(false);
    expect(excerpts.some((excerpt) => excerpt.includes("while its grandparent was off"))).toBe(false);
    expect(excerpts.some((excerpt) => excerpt.includes("worker said while the parent was off"))).toBe(false);
    expect(hits.map((hit) => hit.title)).not.toContain("Medlar secrets");
  }, 60_000);

  it("memory invariant 25: past-chat search leaves out a worker whose delegation root is a run or a heartbeat tick", async () => {
    const { runtime, turn, search } = await composed();
    const standalone = await runtime.workflow?.admit({
      context: { ...OPERATOR, runId: "pending-admission", caller: "cli" },
      operationKey: "a-run",
      kind: "start",
      chatKind: "run",
      prompt: "a run",
    });
    if (standalone === undefined) throw new Error("no workflow");
    const ordinary = await turn("the loquat said in an ordinary chat");
    const runWorker = await turn("the loquat a run's research worker found");
    const tickWorker = await turn("the loquat a heartbeat tick's worker found");
    const tick = await turn("a heartbeat tick");
    const db = inspectDatabase(runtime.store);
    db.prepare("UPDATE tavi_tasks SET origin = 'heartbeat' WHERE task_id = ?").run(tick.taskId);
    const delegate = db.prepare(
      "INSERT INTO tavi_agent_delegation_admissions(workspace_id,principal_id,operation_key,worker_task_id,worker_agent_id,created_at,parent_task_id,root_task_id) VALUES('default','operator',?,?,'agent',?,?,?)",
    );
    delegate.run("spawn-run-worker", runWorker.taskId, nowTimestamp(), standalone.taskId, standalone.taskId);
    delegate.run("spawn-tick-worker", tickWorker.taskId, nowTimestamp(), tick.taskId, tick.taskId);
    db.close();
    const found = (await search("loquat")).map((hit) => hit.taskId);
    expect(found).toContain(ordinary.taskId);
    expect(found).not.toContain(runWorker.taskId);
    expect(found).not.toContain(tickWorker.taskId);
  }, 60_000);

  it("memory invariant 12: an answer in a chat with memory off, and in a private chat, records no memory used", async () => {
    const { runtime, repositories, turn, chatContext } = await composed();
    await runtime.memory.remember({ actor: OPERATOR_ACTOR, scope: PERSONAL, kind: "fact", body: "The person is vegetarian" });
    const on = await turn("ideas for a vegetarian dinner");
    const usedOf = async (taskId: string) => (await repositories.transcripts.page(taskId, { limit: 1 })).entries.at(-1)?.turn.memoryUsed;
    expect((await usedOf(on.taskId))?.records).toHaveLength(1);
    await chatContext({ action: "memory", taskId: on.taskId, mode: "off" });
    await turn("ideas for a vegetarian dinner", { taskId: on.taskId });
    expect((await usedOf(on.taskId))?.records ?? []).toEqual([]);
    const ghost = await turn("ideas for a vegetarian dinner", { memoryMode: "private" });
    expect((await usedOf(ghost.taskId))?.records ?? []).toEqual([]);
  }, 60_000);

  it("memory invariant 5: a scheduled prompt's turn is a routine's: no manifest, no memory.* or sessions.search tool, no memory guidance, and no memory used", async () => {
    const { runtime, repositories, requests } = await composed();
    await runtime.memory.remember({ actor: OPERATOR_ACTOR, scope: PERSONAL, kind: "fact", body: "The person is vegetarian" });
    const before = requests.length;
    const fired = await runtime.workflow?.admit({
      context: { ...OPERATOR, runId: "pending-admission", caller: "cli" },
      operationKey: "schedule-fire",
      kind: "start",
      prompt: "ideas for a vegetarian dinner",
      origin: "schedule",
      originScheduleId: "schedule-1",
    });
    if (fired === undefined) throw new Error("no workflow");
    const request = requests.slice(before).find((entry) => entry.purpose === undefined || entry.purpose === "generation");
    if (request === undefined) throw new Error("the fire made no model call");
    const instructionsAndContext = instructionsAndContextOf(request);
    expect(instructionsAndContext).not.toMatch(/The person is \[?vegetarian/);
    expect(instructionsAndContext).not.toContain("Retrieved memory evidence");
    expect(instructionsAndContext).not.toMatch(/Memory can be out of date/i);
    expect(MEMORY_TOOLS(request.tools.map((tool) => tool.id))).toEqual([]);
    expect((await repositories.transcripts.page(fired.taskId, { limit: 1 })).entries.at(-1)?.turn.memoryUsed?.records ?? []).toEqual([]);
  }, 60_000);

  it("the operator cannot turn another person's chat memory on or off: their chat is not found", async () => {
    const { runtime, repositories, turn, chatContext } = await composed();
    // A bound person's DM, which they turned off with /memory off: a chat whose person is Bob.
    const bobs = await turn("hello");
    const db = inspectDatabase(runtime.store);
    db.prepare("UPDATE tavi_tasks SET principal_id = 'bob' WHERE task_id = ?").run(bobs.taskId);
    db.close();
    await repositories.tasks.setMemoryMode({ taskId: bobs.taskId, mode: "off", now: nowTimestamp() });
    expect(await chatContext({ action: "memory", taskId: bobs.taskId, mode: "on" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect((await repositories.tasks.get(bobs.taskId))?.memoryMode).toBe("off");
  }, 60_000);

  it("a standalone run and an agent's task have no memory mode of their own to change", async () => {
    const { runtime, chatContext } = await composed();
    const standalone = await runtime.workflow?.admit({
      context: { ...OPERATOR, runId: "pending-admission", caller: "cli" },
      operationKey: "standalone",
      kind: "start",
      chatKind: "run",
      prompt: "a run",
    });
    if (standalone === undefined) throw new Error("no workflow");
    expect(await chatContext({ action: "memory", taskId: standalone.taskId, mode: "off" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("standalone run") },
    });
    // The chat list carries a chat's mode, which the canvas's header shows.
    const listed = await runtime.store.listTaskSessions({ ...OPERATOR, limit: 10 });
    expect(listed.rows.find((row) => row.taskId === standalone.taskId)).not.toHaveProperty("memoryMode");
  }, 60_000);

  it("/memory off and /memory on turn this chat's memory, and an off chat takes no other memory command", async () => {
    const { runtime, turn, command } = await composed();
    const chat = await turn("hello");
    expect(await command("/memory off", chat.taskId)).toMatch(/^Memory off in this chat/);
    expect((await runtime.store.asPort().repositories.tasks.get(chat.taskId))?.memoryMode).toBe("off");
    expect(await command("/memory off", chat.taskId)).toBe("Memory is already off in this chat.");
    expect(await command("/memory", chat.taskId)).toContain("off in this chat (/memory on)");
    expect(await command("/remember I like tea", chat.taskId)).toBe(MEMORY_OFF_ANSWER);
    expect(await command("/why", chat.taskId)).toBe(MEMORY_OFF_ANSWER);
    expect(await command("/memory review", chat.taskId)).toBe(MEMORY_OFF_ANSWER);
    expect(await runtime.memory.list({ actor: OPERATOR_ACTOR, statuses: ["approved", "proposed"] })).toEqual([]);
    expect(await command("/memory on", chat.taskId)).toMatch(/^Memory on in this chat from the next answer/);
    expect((await runtime.store.asPort().repositories.tasks.get(chat.taskId))?.memoryMode).toBeUndefined();
    expect(await command("/memory on", chat.taskId)).toBe("Memory is already on in this chat.");
  }, 60_000);
});

describe("private chats", () => {
  it("private is set when the chat is created, never after its first message, and never lifted", async () => {
    const { runtime, turn, chatContext, command } = await composed();
    await runtime.memory.remember({ actor: OPERATOR_ACTOR, scope: PERSONAL, kind: "fact", body: "The person is vegetarian" });
    const ghost = await turn("ideas for a vegetarian dinner", { memoryMode: "private" });
    expect((await runtime.store.asPort().repositories.tasks.get(ghost.taskId))?.memoryMode).toBe("private");
    expect(ghost.instructionsAndContext).not.toMatch(/The person is \[?vegetarian/);
    expect(MEMORY_TOOLS(ghost.tools)).toEqual([]);
    // No way to make a chat private once it exists: `chat-context` takes on and off only.
    expect(ChatContextPayloadSchema.safeParse({ action: "memory", taskId: ghost.taskId, mode: "private" }).success).toBe(false);
    const ordinary = await turn("hello");
    expect(ChatContextPayloadSchema.safeParse({ action: "memory", taskId: ordinary.taskId, mode: "private" }).success).toBe(false);
    // And no way back: on is refused, as is /memory on.
    expect(await chatContext({ action: "memory", taskId: ghost.taskId, mode: "on" })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(await command("/memory on", ghost.taskId)).toBe(MEMORY_PRIVATE_ANSWER);
    expect(await command("/remember I like tea", ghost.taskId)).toBe(MEMORY_PRIVATE_ANSWER);
    // A run sets it with the chat it creates, and never into Home or a standalone run.
    expect(
      RunPayloadSchema.safeParse({
        prompt: "hi",
        workspaceId: "default",
        principal: "operator",
        operationKey: "k",
        approval: "client",
        memory: "private",
      }).success,
    ).toBe(true);
    expect(
      RunPayloadSchema.safeParse({
        prompt: "hi",
        workspaceId: "default",
        principal: "operator",
        operationKey: "k",
        approval: "client",
        memory: "private",
        target: "home",
      }).success,
    ).toBe(false);
    expect(
      RunPayloadSchema.safeParse({
        prompt: "hi",
        workspaceId: "default",
        principal: "operator",
        operationKey: "k",
        approval: "client",
        memory: "off",
        target: "run",
      }).success,
    ).toBe(false);
    // A side chat of a private chat is private too.
    const side = await turn("more ideas", { parentChatId: ghost.taskId, memoryMode: "off" });
    expect((await runtime.store.asPort().repositories.tasks.get(side.taskId))?.memoryMode).toBe("private");
  }, 60_000);

  it("memory invariant 25: past-chat search never finds a private chat, an off chat, or what a chat said before its memory was turned back on", async () => {
    const { runtime, turn, chatContext, search } = await composed();
    await turn("the kumquat recipe is ordinary", {});
    await turn("the kumquat recipe is a secret", { memoryMode: "private" });
    const off = await turn("the kumquat recipe is off the record");
    await chatContext({ action: "memory", taskId: off.taskId, mode: "off" });
    const flipped = await turn("the kumquat said while it was on");
    await chatContext({ action: "memory", taskId: flipped.taskId, mode: "off" });
    await turn("the kumquat said while it was off", { taskId: flipped.taskId });
    // A worker spawned while its chat was off: its own row has no mode, its chat's cut stands for it.
    const worker = await turn("the kumquat a worker said while its chat was off");
    const db = inspectDatabase(runtime.store);
    db.prepare(
      "INSERT INTO tavi_agent_delegation_admissions(workspace_id,principal_id,operation_key,worker_task_id,worker_agent_id,created_at,parent_task_id,root_task_id) VALUES('default','operator','spawn-worker',?,'agent',?,?,?)",
    ).run(worker.taskId, nowTimestamp(), flipped.taskId, flipped.taskId);
    db.close();
    await delay(5);
    await chatContext({ action: "memory", taskId: flipped.taskId, mode: "on" });
    await delay(5);
    await turn("the kumquat said after it was back on", { taskId: flipped.taskId });
    const hits = (await search("kumquat")).map((hit) => hit.excerpt);
    expect(hits.some((excerpt) => excerpt.includes("ordinary"))).toBe(true);
    expect(hits.some((excerpt) => excerpt.includes("after it was back on"))).toBe(true);
    expect(hits.some((excerpt) => excerpt.includes("secret"))).toBe(false);
    expect(hits.some((excerpt) => excerpt.includes("off the record"))).toBe(false);
    expect(hits.some((excerpt) => excerpt.includes("while it was off"))).toBe(false);
    expect(hits.some((excerpt) => excerpt.includes("while its chat was off"))).toBe(false);
    // Conservative: what was said before it went off is left out too, once it has been off.
    expect(hits.some((excerpt) => excerpt.includes("while it was on"))).toBe(false);
  }, 60_000);

  it("memory invariant 5: a private chat is absent from past-chat search, from the moment it is made", async () => {
    const { turn, search } = await composed();
    const ordinary = await turn("the persimmon tart, said in an ordinary chat");
    const ghost = await turn("the persimmon tart, said in a private chat", { memoryMode: "private" });
    const hits = (await search("persimmon")).map((hit) => hit.taskId);
    expect(hits).toContain(ordinary.taskId);
    expect(hits).not.toContain(ghost.taskId);
  }, 60_000);

  it("memory invariant 5: a private chat's saved turns are forgotten by the retention sweep 24 h after its last turn, and an ordinary chat's are kept", async () => {
    const { runtime, turn, repositories } = await composed();
    const ghost = await turn("a private thought", { memoryMode: "private" });
    const recent = await turn("a fresh private thought", { memoryMode: "private" });
    const ordinary = await turn("an ordinary thought");
    // The first private chat and the ordinary one last spoke two days ago.
    const db = inspectDatabase(runtime.store);
    const old = new Date(Date.now() - PRIVATE_CHAT_KEEP_MS - 86_400_000).toISOString();
    db.prepare("UPDATE tavi_transcript_entries SET created_at = ? WHERE task_id IN (?, ?)").run(old, ghost.taskId, ordinary.taskId);
    db.close();
    const due = await repositories.transcripts.privateChatsDue({
      idleBefore: new Date(Date.now() - PRIVATE_CHAT_KEEP_MS).toISOString(),
      limit: 10,
    });
    expect(due).toEqual([ghost.taskId]);
    await runtimes.pop()?.close();

    // The owner's sweep, as `serve` runs it.
    const swept = await composed({ dataDirectory: runtime.dataDirectory, retentionSweepEnabled: true, retentionSweepIntervalMs: 100 });
    await waitFor(async () => (await swept.repositories.transcripts.page(ghost.taskId, { limit: 5 })).entries.length === 0, 10_000);
    expect((await swept.repositories.transcripts.page(recent.taskId, { limit: 5 })).entries).toHaveLength(1);
    expect((await swept.repositories.transcripts.page(ordinary.taskId, { limit: 5 })).entries).toHaveLength(1);
    // Its words are gone from the admission record too, so nothing finds them.
    expect((await swept.search("private thought")).map((hit) => hit.taskId)).not.toContain(ghost.taskId);
  }, 60_000);

  it("memory invariant 5: the sweep of a private chat past 24 h leaves no checkpoint, kept model request, fold archive or saved turn of it", async () => {
    const { runtime, turn } = await composed();
    const ghost = await turn("a private thought about quinces", { memoryMode: "private" });
    await turn("and more about quinces", { taskId: ghost.taskId });
    const ordinary = await turn("an ordinary thought about quinces");
    const db = inspectDatabase(runtime.store);
    const threadOf = (taskId: string) =>
      (db.prepare("SELECT thread_id FROM tavi_tasks WHERE task_id = ?").get(taskId) as { thread_id: string }).thread_id;
    const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    const ghostThread = threadOf(ghost.taskId);
    const ordinaryThread = threadOf(ordinary.taskId);
    // A fold archive of it, as a rollover writes one.
    db.prepare(
      "INSERT INTO tavi_artifacts(artifact_id, workspace_id, run_id, relative_path, content_type, byte_size, sha256, created_at, fold) SELECT 'fold-archive-ghost', workspace_id, task_id, 'fold/ghost.json', 'application/json', 2, 'x', created_at, 'epoch' FROM tavi_tasks WHERE task_id = ?",
    ).run(ghost.taskId);
    expect(count("SELECT count(*) AS n FROM checkpoints WHERE thread_id = ?", ghostThread)).toBeGreaterThan(0);
    expect(count("SELECT count(*) AS n FROM tavi_provider_attempt_requests WHERE run_id = ?", ghost.taskId)).toBeGreaterThan(0);
    const old = new Date(Date.now() - PRIVATE_CHAT_KEEP_MS - 86_400_000).toISOString();
    db.prepare("UPDATE tavi_transcript_entries SET created_at = ? WHERE task_id IN (?, ?)").run(old, ghost.taskId, ordinary.taskId);
    db.close();
    await runtimes.pop()?.close();

    const swept = await composed({ dataDirectory: runtime.dataDirectory, retentionSweepEnabled: true, retentionSweepIntervalMs: 100 });
    const left = (sql: string, ...args: unknown[]): number => {
      const after = inspectDatabase(swept.runtime.store);
      try {
        return (after.prepare(sql).get(...args) as { n: number }).n;
      } finally {
        after.close();
      }
    };
    await waitFor(async () => left("SELECT count(*) AS n FROM checkpoints WHERE thread_id = ?", ghostThread) === 0, 10_000);
    expect(left("SELECT count(*) AS n FROM writes WHERE thread_id = ?", ghostThread)).toBe(0);
    expect(left("SELECT count(*) AS n FROM tavi_provider_attempt_requests WHERE run_id = ?", ghost.taskId)).toBe(0);
    expect(left("SELECT count(*) AS n FROM tavi_artifacts WHERE run_id = ? AND fold IS NOT NULL", ghost.taskId)).toBe(0);
    expect(left("SELECT count(*) AS n FROM tavi_transcript_entries WHERE task_id = ?", ghost.taskId)).toBe(0);
    // An ordinary chat keeps its own.
    expect(left("SELECT count(*) AS n FROM checkpoints WHERE thread_id = ?", ordinaryThread)).toBeGreaterThan(0);
    expect(left("SELECT count(*) AS n FROM tavi_provider_attempt_requests WHERE run_id = ?", ordinary.taskId)).toBeGreaterThan(0);
  }, 60_000);

  it("is left out of a new Home's Earlier chats", async () => {
    const { runtime, turn, repositories } = await composed();
    const ghost = await turn("a private chat", { memoryMode: "private" });
    const ordinary = await turn("an ordinary chat");
    await runtime.store.asPort().repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { homeChat: true },
      expectedRevision: (await repositories.workspaceSettings.get("default")).revision,
      actor: "operator",
      now: nowTimestamp(),
    });
    const home = await runtime.workflow?.admit({
      context: { ...OPERATOR, runId: "pending-admission", caller: "cli" },
      operationKey: "home-1",
      kind: "start",
      chatKind: "home",
      prompt: "hello home",
    });
    if (home === undefined) throw new Error("no workflow");
    await runtime.chatNotices.postEarlierChats({ workspaceId: "default", principalId: "operator", taskId: home.taskId });
    const notices = await repositories.transcripts.noticesAfter(home.taskId, { fromSeq: 0, skip: 0, limit: 20 });
    const earlier = notices.find((notice) => notice.kind === "earlier-chats");
    expect(earlier?.summary).toContain(ordinary.taskId);
    expect(earlier?.summary).not.toContain(ghost.taskId);
  }, 60_000);
});

describe("tavi chat --no-memory | --private", () => {
  it("parses either flag for the chat it starts, never both, and never with --attach or --replay", () => {
    expect(parseArgs(["chat", "--no-memory"])).toMatchObject({ command: "chat", chat: { memory: "off" } });
    expect(parseArgs(["chat", "--private"])).toMatchObject({ command: "chat", chat: { memory: "private" } });
    expect(parseArgs(["chat"])).not.toHaveProperty("chat.memory");
    expect(() => parseArgs(["chat", "--no-memory", "--private"])).toThrow(UsageError);
    expect(() => parseArgs(["chat", "--private", "--attach", "task-1"])).toThrow(/starts a new chat/);
  });
});
