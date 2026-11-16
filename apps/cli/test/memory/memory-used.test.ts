import {
  TranscriptMemoryUsedSchema,
  type HeartbeatLedgerRow,
  type HeartbeatTickRecord,
  type MemoryItem,
  type MemoryListAnswer,
  type MemoryPayload,
  type MemoryWhyAnswer,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { heartbeatItemBecause } from "../../src/features/heartbeat/owner.js";
import { memoryCommand } from "../../src/features/memory/owner.js";
import { createMemoryReads } from "../../src/features/memory/reads.js";
import { memoryDateText, whyText } from "../../src/features/memory/slash.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Memory used in this answer: each
 * saved turn records the revisions its model calls were given and those its
 * memory tools fetched, at most 20 with a count past them, and how many
 * preferences applied; `/why`, `tavi memory why` and the canvas's chip read
 * that, as the memory rows say now. A heartbeat item names what its check used.
 */

const directories = temporaryDirectories({ prefix: "tavi-memory-used-" });
const runtimes: TaviRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

const OPERATOR = { workspaceId: "default", principalId: "operator" };
/** A prompt whose turn fetches one record by id with `memory.get` before it answers. */
const FETCH = "fetch-record";
/** A prompt whose turn calls `memory.list` before it answers. */
const LIST = "list-everything";

/** Answers "Done.", first calling `memory.get` for the id after FETCH when the prompt names one, and `memory.list` on LIST; records every request. */
function fetchingModel(requests: ModelRequest[]): ModelPort {
  return {
    async stream(request) {
      requests.push(request);
      const done = {
        attemptId: request.attemptId,
        status: "completed" as const,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      };
      if (request.purpose !== undefined && request.purpose !== "generation") return { ...done, text: "A chat" };
      const last = request.messages.at(-1);
      const asked = /fetch-record (\S+)/.exec(last?.text ?? "");
      if (last?.toolResults === undefined && asked?.[1] !== undefined) {
        return {
          ...done,
          text: "",
          finishReason: "tool-calls" as const,
          toolCalls: [{ id: "g1", name: "memory.get", input: { recordId: asked[1] } }],
        };
      }
      if (last?.toolResults === undefined && last?.text?.includes(LIST) === true) {
        return {
          ...done,
          text: "",
          finishReason: "tool-calls" as const,
          toolCalls: [{ id: "l1", name: "memory.list", input: {} }],
        };
      }
      return { ...done, text: "Done." };
    },
  };
}

async function composed() {
  const requests: ModelRequest[] = [];
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directories.create(), {
      workspaces: [{ ...OPERATOR, permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: [],
    }),
    { modelOverride: fetchingModel(requests) },
  );
  runtimes.push(runtime);
  const repositories = runtime.store.asPort().repositories;
  const ipc = async <T>(payload: MemoryPayload): Promise<T> => {
    const answer = await memoryCommand(
      { memory: runtime.memory, repositories, principalOf: () => "operator", fromBridge: true, now: () => new Date() },
      payload,
    );
    if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`);
    return answer.result as T;
  };
  let count = 0;
  const turn = async (prompt: string, taskId?: string): Promise<string> => {
    count += 1;
    const result = await runtime.workflow?.admit({
      context: { ...OPERATOR, runId: "pending-admission", caller: "cli" },
      operationKey: `turn-${count}`,
      kind: taskId === undefined ? "start" : "reply",
      ...(taskId === undefined ? {} : { taskId }),
      prompt,
    });
    if (result === undefined) throw new Error("no workflow");
    return result.taskId;
  };
  const remember = async (body: string, extra: Partial<MemoryPayload> = {}): Promise<MemoryItem> =>
    await ipc<MemoryItem>({ action: "remember", kind: "fact", scope: "personal", body, ...extra } as MemoryPayload);
  /** The newest saved turn of a chat, and its `memoryUsed`. */
  const saved = async (taskId: string) => {
    const entry = (await repositories.transcripts.page(taskId, { limit: 1 })).entries.at(-1);
    if (entry === undefined) throw new Error("no saved turn");
    return entry;
  };
  return { runtime, repositories, ipc, turn, remember, saved, requests };
}

describe("memory used in this answer", () => {
  it("memory invariant 12: a turn with two evidence hits and one memory.get records exactly those three revisions and its preference count, and /why shows those", async () => {
    const { turn, remember, saved, ipc } = await composed();
    const lisbon = await remember("The wombat lives in Lisbon");
    const porto = await remember("The wombat visits Porto on Fridays");
    const fetched = await remember("The person keeps bees");
    await remember("Spanish", {
      kind: "preference",
      preferenceKey: "reply.language",
      preferenceValue: "Spanish",
    } as Partial<MemoryPayload>);
    const chat = await turn(`where does the wombat go? ${FETCH} ${fetched.recordId}`);
    const entry = await saved(chat);
    const used = TranscriptMemoryUsedSchema.parse(entry.turn.memoryUsed);
    expect(new Set(used.records.map((ref) => `${ref.recordId}@${ref.revisionId}`))).toEqual(
      new Set([lisbon, porto, fetched].map((record) => `${record.recordId}@${record.currentRevisionId ?? "?"}`)),
    );
    expect(used.records).toHaveLength(3);
    expect(used).toMatchObject({ preferences: 1, more: 0 });
    // `/why` and `tavi memory why` name the same three, as the memory rows say now.
    const why = await ipc<MemoryWhyAnswer>({ action: "why", taskId: chat });
    expect(why.seq).toBe(entry.seq);
    expect(new Set(why.records.map((record) => record.recordId))).toEqual(new Set([lisbon.recordId, porto.recordId, fetched.recordId]));
    expect(why.used).toEqual({ recorded: true, used: 3, forgotten: 0, preferences: 1 });
    const text = await whyText(why, (iso) => memoryDateText(iso, "UTC"));
    expect(text.split("\n")[0]).toBe("The answer used 3 memories:");
    expect(text).toContain(`The person keeps bees — fact, `);
    expect(text.split("\n").at(-1)).toBe("1 preference applied.");
    // The chip's list: the same turn, one page, in the order used.
    const chip = await ipc<MemoryListAnswer>({ action: "list", statuses: ["approved"], usedInTurn: { taskId: chat, seq: entry.seq } });
    expect(chip.records.map((record) => record.recordId)).toEqual(used.records.map((ref) => ref.recordId));
    expect(chip.used).toEqual({ recorded: true, used: 3, forgotten: 0, hidden: 0, preferences: 1 });
  }, 60_000);

  it("a listing is recorded apart from what was used: looked through, not used, and no use of the record", async () => {
    const { runtime, turn, remember, saved, ipc } = await composed();
    const cat = await remember("The person has a cat called Miso");
    const car = await remember("The person drives an old Volvo");
    const language = await remember("Spanish", {
      kind: "preference",
      preferenceKey: "reply.language",
      preferenceValue: "Spanish",
    } as Partial<MemoryPayload>);
    const chat = await turn(`hello there ${LIST}`);
    const entry = await saved(chat);
    const used = TranscriptMemoryUsedSchema.parse(entry.turn.memoryUsed);
    expect(used.records).toEqual([]);
    expect(new Set(used.listed?.records.map((ref) => ref.recordId))).toEqual(new Set([cat.recordId, car.recordId, language.recordId]));
    expect(used).toMatchObject({ preferences: 1, more: 0, listed: { more: 0 } });
    const why = await ipc<MemoryWhyAnswer>({ action: "why", taskId: chat });
    expect(why.records).toEqual([]);
    expect(why.listed?.map((record) => record.recordId).sort()).toEqual([cat.recordId, car.recordId, language.recordId].sort());
    expect(why.used).toEqual({ recorded: true, used: 0, forgotten: 0, preferences: 1, listed: { count: 3, forgotten: 0 } });
    const text = await whyText(why, (iso) => memoryDateText(iso, "UTC"));
    expect(text.split("\n")[0]).toBe("Looked through 3 memories:");
    expect(text).toContain("The person drives an old Volvo — fact, ");
    expect(text).not.toContain("The answer used");
    expect(text.split("\n").at(-1)).toBe("1 preference applied.");
    // The chip's list says the same, and a record forgotten since is only counted there too.
    await ipc({ action: "forget", recordId: car.recordId, reason: "forgotten from an answer's memory list" });
    const chip = await ipc<MemoryListAnswer>({ action: "list", statuses: ["approved"], usedInTurn: { taskId: chat, seq: entry.seq } });
    expect(chip.records).toEqual([]);
    expect(chip.listed?.map((record) => record.recordId).sort()).toEqual([cat.recordId, language.recordId].sort());
    expect(chip.used).toEqual({
      recorded: true,
      used: 0,
      forgotten: 0,
      hidden: 0,
      preferences: 1,
      listed: { count: 3, forgotten: 1, hidden: 0 },
    });
    // Looking through a record is no use of it: nothing a lesson's ranking or a fact's confirmation counts.
    const repository = runtime.store.asPort().repositories;
    await expect(repository.memory.recordUseCounts({ recordIds: [cat.recordId] })).resolves.toEqual({});
    await expect(repository.memoryUse.list(chat, 10)).resolves.toEqual([]);
  }, 60_000);

  it("a turn that used one and listed the rest counts the used one once, in /why and the chip", async () => {
    const { turn, remember, saved, ipc } = await composed();
    const bees = await remember("The person keeps bees");
    const cat = await remember("The person has a cat called Miso");
    const chat = await turn(`tell me about the bees ${LIST}`);
    const entry = await saved(chat);
    const used = TranscriptMemoryUsedSchema.parse(entry.turn.memoryUsed);
    expect(used.records.map((ref) => ref.recordId)).toEqual([bees.recordId]);
    expect(used.listed?.records.map((ref) => ref.recordId)).toEqual([cat.recordId]);
    const why = await ipc<MemoryWhyAnswer>({ action: "why", taskId: chat });
    const lines = (await whyText(why, (iso) => memoryDateText(iso, "UTC"))).split("\n");
    expect(lines[0]).toBe("The answer used 1 memory:");
    expect(lines[1]).toContain("The person keeps bees");
    expect(lines[2]).toBe("Looked through 1 more:");
    expect(lines[3]).toContain("The person has a cat called Miso");
    expect(lines).toHaveLength(4);
  }, 60_000);

  it("forgetting one from the chip removes it from the next turn, and the earlier answer counts it as forgotten", async () => {
    const { turn, remember, saved, ipc, requests } = await composed();
    // Under `v2` (the default) a turn's block is kept and resent: the forget drops the kept block that showed it,
    // and the next turn's block shows again what else that block carried (Porto), counted as used there.
    const lisbon = await remember("The wombat lives in Lisbon");
    const porto = await remember("The wombat visits Porto on Fridays");
    const chat = await turn("where does the wombat go?");
    const first = await saved(chat);
    expect(first.turn.memoryUsed?.records.map((ref) => ref.recordId).sort()).toEqual([lisbon.recordId, porto.recordId].sort());
    // The chip's Forget: the `memory` command's own forget.
    await ipc({ action: "forget", recordId: lisbon.recordId, reason: "forgotten from an answer's memory list" });
    const before = requests.length;
    await turn("and where does the wombat go now?", chat);
    const next = await saved(chat);
    expect(next.turn.memoryUsed?.records.map((ref) => ref.recordId)).toEqual([porto.recordId]);
    // No copy anywhere in the request: neither a message's words nor a kept block (`contextText`).
    expect(requests.slice(before).length).toBeGreaterThan(0);
    expect(requests.slice(before).some((request) => JSON.stringify(request.messages).includes("Lisbon"))).toBe(false);
    // The earlier answer still says it used two; the forgotten one is not listed, only counted.
    const chip = await ipc<MemoryListAnswer>({ action: "list", statuses: ["approved"], usedInTurn: { taskId: chat, seq: first.seq } });
    expect(chip.records.map((record) => record.recordId)).toEqual([porto.recordId]);
    expect(chip.used).toEqual({ recorded: true, used: 2, forgotten: 1, hidden: 0, preferences: 0 });
    expect(JSON.stringify(chip)).not.toContain("Lisbon");
  }, 60_000);

  it("a turn with memory off records none, and is offered no memory tool", async () => {
    const { turn, remember, saved, repositories, requests } = await composed();
    const bees = await remember("The person keeps bees");
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { memory: { enabled: false } },
      expectedRevision: 0,
      actor: "operator:cli",
      now: nowTimestamp(),
    });
    const before = requests.length;
    const chat = await turn(`what about the bees? ${FETCH} ${bees.recordId}`);
    expect((await saved(chat)).turn.memoryUsed).toEqual({ records: [], preferences: 0, more: 0 });
    expect(
      requests
        .slice(before)
        .flatMap((request) => request.tools ?? [])
        .some((tool) => tool.id.startsWith("memory.")),
    ).toBe(false);
    expect(requests.length).toBeGreaterThan(before);
  }, 60_000);

  it("an answer saved before answers recorded their memory shows no chip, and /why says it was not recorded", async () => {
    const { turn, repositories, ipc } = await composed();
    const chat = await turn("hello");
    // As a turn saved before answers recorded their memory: no `memoryUsed`.
    const seq = await repositories.transcripts.append({
      taskId: chat,
      turn: { admissionKind: "reply", prompt: "older", items: [], outcome: { status: "completed", finalText: "Older." } },
      createdAt: nowTimestamp(),
    });
    const why = await ipc<MemoryWhyAnswer>({ action: "why", taskId: chat, seq });
    expect(why).toMatchObject({ seq, records: [], used: { recorded: false, used: 0 } });
    expect(await whyText(why, () => "Sun 11 Oct")).toBe(
      "Not recorded: this answer (Sun 11 Oct) is from before Tavi recorded which memories each answer used. The chat panel's Used here lists what the chat's turns were given.",
    );
    // And the chip's list is empty, saying the same.
    const chip = await ipc<MemoryListAnswer>({ action: "list", usedInTurn: { taskId: chat, seq } });
    expect(chip).toMatchObject({ records: [], used: { recorded: false } });
  }, 60_000);

  it("leaves the chat panel's Used here as it was: every record the chat's turns were given, most recent first", async () => {
    const { turn, remember, ipc } = await composed();
    const lisbon = await remember("The wombat lives in Lisbon");
    const chat = await turn("where does the wombat live?");
    const usedHere = await ipc<MemoryListAnswer>({ action: "list", statuses: ["approved"], usedInTaskId: chat });
    expect(usedHere.records.map((record) => record.recordId)).toEqual([lisbon.recordId]);
    expect(usedHere.records[0]?.usedAt).toBeDefined();
    expect(usedHere.used).toBeUndefined();
  }, 60_000);

  it("refuses a turn's use mixed with another listing", async () => {
    const { turn, runtime } = await composed();
    const chat = await turn("hello");
    const answer = await memoryCommand(
      {
        memory: runtime.memory,
        repositories: runtime.store.asPort().repositories,
        principalOf: () => "operator",
        fromBridge: true,
        now: () => new Date(),
      },
      { action: "list", usedInTurn: { taskId: chat }, query: "wombat" },
    );
    expect(answer).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  }, 60_000);
});

describe("what a memory tool read, held for the turn", () => {
  const context = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "cli" };
  it("is taken once, with the turn, and never holds a delegated worker's", () => {
    const reads = createMemoryReads();
    reads.note(context, [{ recordId: "r1", revisionId: "v1" }]);
    reads.note({ ...context, runId: "worker-1", memoryScopeRestricted: true }, [{ recordId: "r2", revisionId: "v2" }]);
    reads.note(context, [{ recordId: "r3", revisionId: "v3" }], "listed");
    reads.note({ ...context, runId: "worker-1", memoryScopeRestricted: true }, [{ recordId: "r2", revisionId: "v2" }], "listed");
    expect(reads.take("task-1")).toEqual({
      records: [{ recordId: "r1", revisionId: "v1" }],
      listed: [{ recordId: "r3", revisionId: "v3" }],
    });
    expect(reads.take("task-1")).toEqual({ records: [], listed: [] });
    expect(reads.take("worker-1")).toEqual({ records: [], listed: [] });
  });
});

describe("a heartbeat item that used memory", () => {
  const AT = "2026-10-11T08:00:00.000Z";
  const scope = { workspaceId: "default", principalId: "operator" };
  const tickOf = (memory: readonly { readonly recordId: string; readonly revisionId: string }[]): HeartbeatTickRecord => ({
    tickId: "tick-1",
    ...scope,
    kind: "signal",
    wakeReason: "interval",
    outcome: "reported",
    reason: null,
    pauseReason: null,
    providerId: "builtin",
    taskId: null,
    itemsNow: 1,
    itemsLater: 0,
    itemsRetracted: 0,
    inputs: { instructionsRevision: 1, signalKeys: [], memory },
    hookDecisions: null,
    tokens: 0,
    cacheReadTokens: 0,
    costUsd: null,
    durationMs: 10,
    error: null,
    providerDev: false,
    createdAt: AT,
  });

  it("names, from the check that told it, the memories it was given — at most two, never a sensitive one, and not one forgotten since", async () => {
    const { runtime, repositories, remember } = await composed();
    const travel = await remember("Travelling to Lisbon until Friday");
    const trains = await remember("Prefers trains");
    const health = await remember("A health matter", { sensitivity: "sensitive" } as Partial<MemoryPayload>);
    const third = await remember("Likes window seats");
    const refs = [health, travel, trains, third].map((record) => ({
      recordId: record.recordId,
      revisionId: record.currentRevisionId ?? "",
    }));
    const asked: unknown[] = [];
    const heartbeats = {
      listTicks: async (input: unknown) => {
        asked.push(input);
        return [tickOf(refs)];
      },
    };
    const item: Pick<HeartbeatLedgerRow, "lastToldAt"> = { lastToldAt: AT };
    const because = await heartbeatItemBecause({ heartbeats: heartbeats as never, memory: repositories.memory }, scope, item);
    expect(because).toEqual(["Travelling to Lisbon until Friday", "Prefers trains"]);
    // The first check that ran at or after the item was told.
    expect(asked).toEqual([{ ...scope, since: AT, ranOnly: true, oldestFirst: true, limit: 1 }]);
    await runtime.memory.forget({ actor: { ...scope, caller: "cli", authority: "operator" }, recordId: travel.recordId, reason: "test" });
    expect(await heartbeatItemBecause({ heartbeats: heartbeats as never, memory: repositories.memory }, scope, item)).toEqual([
      "Prefers trains",
      "Likes window seats",
    ]);
    // A check that used no memory, or none found, names nothing.
    expect(
      await heartbeatItemBecause({ heartbeats: { listTicks: async () => [] } as never, memory: repositories.memory }, scope, item),
    ).toEqual([]);
  }, 60_000);

  it("names nothing of another person's memories the check was given", async () => {
    const { repositories, remember } = await composed();
    const theirs = await remember("Travelling to Lisbon until Friday");
    const heartbeats = { listTicks: async () => [tickOf([{ recordId: theirs.recordId, revisionId: theirs.currentRevisionId ?? "" }])] };
    const someoneElse = { ...scope, principalId: "someone-else" };
    expect(
      await heartbeatItemBecause({ heartbeats: heartbeats as never, memory: repositories.memory }, someoneElse, { lastToldAt: AT }),
    ).toEqual([]);
  }, 60_000);

  it("names nothing when the check that told it was swept and a later check used memory", async () => {
    const { repositories, remember } = await composed();
    const travel = await remember("Travelling to Lisbon until Friday");
    const later = {
      ...tickOf([{ recordId: travel.recordId, revisionId: travel.currentRevisionId ?? "" }]),
      tickId: "tick-later",
      createdAt: "2026-10-20T08:00:00.000Z",
    };
    const heartbeats = { listTicks: async () => [later] };
    expect(await heartbeatItemBecause({ heartbeats: heartbeats as never, memory: repositories.memory }, scope, { lastToldAt: AT })).toEqual(
      [],
    );
  }, 60_000);
});
