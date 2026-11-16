import {
  memoryCardChannelMessage,
  memoryCardLine,
  type MemoryActor,
  type MemoryCardAllAnswer,
  type MemoryCardAnswer,
  type MemoryGetAnswer,
  type MemoryItem,
  type MemoryListAnswer,
  type MemoryPayload,
  type ModelPort,
  type ModelRequest,
  type ModEnvelope,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { memoryCommand, type MemoryCommandDependencies } from "../../src/features/memory/owner.js";
import { runMemoryReview } from "../../src/features/memory/review.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Dedup and updates in the app, the terminal and the commands: the same
 * proposal from the
 * tool twice is one record and one card item; an update — a proposal whose
 * preference key or fact's topic a kept record holds — is shown with what it
 * updates and decided by *Replace* (a correction of the kept record, the
 * proposal discarded as applied) or, a fact, *Keep both*; every *Keep all*
 * leaves it waiting and counts it; and the person never meets
 * `MEMORY_CONFLICT` for it. A near duplicate the tool filed says what it is
 * similar to.
 */

const directories = temporaryDirectories({ prefix: "tavi-memory-dedup-" });
const runtimes: TaviRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

const OPERATOR = { workspaceId: "default", principalId: "operator" };
const PROPOSE_TWICE = "remember that I am vegetarian";
const pace = async (): Promise<void> => await delay(260);

/** Every request the model was sent. */
const requests: ModelRequest[] = [];

/** Proposes the same fact twice in one step when asked to; otherwise "Done.". */
const twiceModel: ModelPort = {
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
    if (last?.toolResults === undefined && last?.text.includes(PROPOSE_TWICE) === true) {
      return {
        ...done,
        text: "",
        finishReason: "tool-calls" as const,
        toolCalls: [
          { id: "p1", name: "memory.propose", input: { kind: "fact", body: "The person is vegetarian." } },
          { id: "p2", name: "memory.propose", input: { kind: "fact", body: "the person is   VEGETARIAN." } },
        ],
      };
    }
    return { ...done, text: "Done." };
  },
};

async function composed() {
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directories.create(), {
      workspaces: [{ ...OPERATOR, permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: [],
      memoryHostEnabled: true,
    }),
    { modelOverride: twiceModel },
  );
  runtimes.push(runtime);
  const repositories = runtime.store.asPort().repositories;
  const ipcAnswer = async (payload: MemoryPayload) =>
    await memoryCommand(
      {
        memory: runtime.memory,
        repositories,
        principalOf: () => "operator",
        fromBridge: true,
        now: () => new Date(),
        newId: runtime.clock.newId,
      },
      payload,
    );
  const ipc = async <T>(payload: MemoryPayload): Promise<T> => {
    const answer = await ipcAnswer(payload);
    if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`);
    return answer.result as T;
  };
  let count = 0;
  const turn = async (prompt: string): Promise<string> => {
    count += 1;
    const result = await runtime.workflow?.admit({
      context: { ...OPERATOR, runId: "pending-admission", caller: "cli" },
      operationKey: `turn-${count}`,
      kind: "start",
      prompt,
    });
    if (result === undefined) throw new Error("no workflow");
    return result.taskId;
  };
  const front = async (line: string, taskId: string): Promise<string> => {
    const [name = "", ...rest] = line.slice(1).split(" ");
    await pace();
    const envelope: ModEnvelope = Object.freeze({ ...OPERATOR, taskId, runId: taskId, source: "ipc", frontEnd: "ipc", attended: true });
    return (await runtime.turnHooks.runCommand(name, { envelope, args: rest.join(" ") }))?.text ?? "(no command)";
  };
  const model: MemoryActor = { ...OPERATOR, caller: "agent", authority: "model" };
  const personal = { kind: "personal" as const, principalId: "operator" };
  const keepPreference = async (key: string, value: string, body: string) =>
    await ipc<MemoryItem>({ action: "remember", kind: "preference", scope: "personal", preferenceKey: key, preferenceValue: value, body });
  const proposePreference = async (key: string, value: string, body: string) =>
    await runtime.memory.propose({
      actor: model,
      scope: personal,
      kind: "preference",
      preferenceKey: key,
      preference: { valueType: "string", value },
      body,
    });
  const card = async (taskId: string, recordIds: readonly string[]) =>
    (
      await repositories.transcripts.postMemoryCard({
        noticeId: runtime.clock.newId("notice"),
        taskId,
        sourceKey: `memory:test-${(count += 1)}`,
        createdAt: nowTimestamp(),
        records: recordIds.map((recordId) => ({ recordId, ...OPERATOR })),
      })
    ).notice.noticeId;
  const statusOf = async (recordId: string) => (await repositories.memory.getRecord(recordId))?.status;
  /** The memory commands over the runtime's service, with some of its calls replaced. */
  const commandWith = async (overrides: Partial<MemoryCommandDependencies["memory"]>, payload: MemoryPayload) =>
    await memoryCommand(
      {
        memory: {
          remember: async (input) => await runtime.memory.remember(input),
          correct: async (input) => await runtime.memory.correct(input),
          approve: async (input) => await runtime.memory.approve(input),
          reject: async (input) => await runtime.memory.reject(input),
          forget: async (input) => await runtime.memory.forget(input),
          usage: async (input) => await runtime.memory.usage(input),
          // Reads go through the port too.
          get: async (input) => await runtime.memory.get(input),
          list: async (input) => await runtime.memory.list(input),
          search: async (input) => await runtime.memory.search(input),
          history: async (input) => await runtime.memory.history(input),
          related: async (input) => await runtime.memory.related(input),
          operatorView: async (input) => await runtime.memory.operatorView(input),
          ...overrides,
        },
        repositories,
        principalOf: () => "operator",
        fromBridge: true,
        now: () => new Date(),
        newId: runtime.clock.newId,
      },
      payload,
    );
  return {
    runtime,
    repositories,
    ipc,
    ipcAnswer,
    turn,
    front,
    model,
    personal,
    keepPreference,
    proposePreference,
    card,
    statusOf,
    commandWith,
  };
}

const OPERATOR_ACTOR: MemoryActor = { ...OPERATOR, caller: "cli", authority: "operator" };

describe("the same proposal twice", () => {
  it("memory invariant 16: the tool's second proposal of the same words is one record and one card item, and says it is already known", async () => {
    const { repositories, turn, ipc } = await composed();
    const taskId = await turn(PROPOSE_TWICE);
    const proposed = await ipc<MemoryListAnswer>({ action: "list", statuses: ["proposed"] });
    expect(proposed.records.map((record) => record.body)).toEqual(["The person is vegetarian."]);
    const notices = (await repositories.transcripts.notices(taskId, { limit: 50 })).filter((notice) => notice.kind === "memory");
    expect(notices).toHaveLength(1);
    const shown = await ipc<MemoryCardAnswer>({ action: "card", noticeId: notices[0]?.noticeId ?? "" });
    expect(shown.items.map((item) => item.recordId)).toEqual([proposed.records[0]?.recordId]);
    // The model was told the second was already known.
    const results = requests.flatMap((request) => request.messages).flatMap((message) => message.toolResults ?? []);
    expect(results.filter((result) => JSON.stringify(result).includes("Already known"))).toHaveLength(1);
  }, 60_000);
});

describe("updates", () => {
  it("a preference update shows Replace, which leaves one active value and the old revision in history; MEMORY_CONFLICT is never shown", async () => {
    const { runtime, ipc, turn, front, keepPreference, proposePreference, card, statusOf } = await composed();
    const spanish = await keepPreference("reply.language", "es", "Reply in Spanish");
    const french = await proposePreference("reply.language", "fr", "Reply in French");
    const chat = await turn("hello");
    const noticeId = await card(chat, [french.recordId]);
    const shown = await ipc<MemoryCardAnswer>({ action: "card", noticeId });
    expect(shown.items[0]?.updates).toEqual({
      recordId: spanish.recordId,
      title: "Reply in Spanish",
      currentRevisionId: spanish.currentRevisionId,
    });
    // Nowhere offers a plain Keep for it: the terminal points to the app, a channel has no Keep button.
    expect(memoryCardLine(shown)).toContain("open Tavi to replace the update");
    expect(memoryCardLine(shown)).not.toContain("/memory keep 1");
    expect(memoryCardChannelMessage(shown, "buttons").buttons.map((button) => button.label)).toEqual(["Discard", "Open"]);
    const kept = await front("/memory keep 1", chat);
    expect(kept).toContain("needs a look");
    expect(kept).not.toContain("MEMORY_CONFLICT");
    expect(await statusOf(french.recordId)).toBe("proposed");

    const replaced = await ipc<MemoryItem>({
      action: "replace",
      recordId: french.recordId,
      ...(shown.items[0]?.updates?.currentRevisionId === undefined ? {} : { targetRevisionId: shown.items[0].updates.currentRevisionId }),
    });
    expect(replaced).toMatchObject({ recordId: spanish.recordId, status: "approved", body: "Reply in French" });
    const { preferences } = await runtime.memory.resolvePreferences({
      actor: { ...OPERATOR, caller: "cli", authority: "operator" },
      keys: ["reply.language"],
    });
    expect(preferences.map((preference) => [preference.value, preference.conflict])).toEqual([["fr", false]]);
    const history = await ipc<MemoryGetAnswer>({ action: "get", recordId: spanish.recordId });
    expect(history.revisions.map((revision) => revision.status)).toEqual(["active", "superseded"]);
    expect(await statusOf(french.recordId)).toBe("rejected");
    const discarded = await ipc<MemoryGetAnswer>({ action: "get", recordId: french.recordId });
    expect(discarded.reviews[0]).toMatchObject({ decision: "rejected", reason: "applied as a correction" });
    // Its card says it replaced the kept one, not that it was thrown away.
    expect((await ipc<MemoryCardAnswer>({ action: "card", noticeId })).items[0]?.state).toBe("replaced");
    // A stale Replace is a revision conflict, not a second correction.
    const again = await proposePreference("reply.language", "de", "Reply in German");
    await expect(ipc({ action: "replace", recordId: again.recordId, targetRevisionId: spanish.currentRevisionId ?? "x" })).rejects.toThrow(
      /REVISION_CONFLICT/,
    );
  }, 60_000);

  it("Keep all — a card's, a digest's, /memory keep all — leaves an update waiting and counts it as needing a look", async () => {
    const { ipc, turn, front, keepPreference, proposePreference, card, statusOf, runtime, model, personal } = await composed();
    await keepPreference("reply.language", "es", "Reply in Spanish");
    const update = await proposePreference("reply.language", "fr", "Reply in French");
    const plain = await runtime.memory.propose({ actor: model, scope: personal, kind: "fact", body: "Likes long walks" });
    const chat = await turn("hello");
    const noticeId = await card(chat, [plain.recordId, update.recordId]);
    expect(await ipc<MemoryCardAllAnswer>({ action: "card-all", noticeId, decision: "keep" })).toMatchObject({ kept: 1, needsLook: 1 });
    expect(await statusOf(plain.recordId)).toBe("approved");
    expect(await statusOf(update.recordId)).toBe("proposed");

    const other = await runtime.memory.propose({ actor: model, scope: personal, kind: "fact", body: "Owns a bicycle" });
    await card(chat, [other.recordId, update.recordId]);
    expect(await front("/memory keep all", chat)).toBe("Kept 1 · 1 needs a look — open Tavi to review. Undo it from the Saved card.");
    expect(await statusOf(update.recordId)).toBe("proposed");
    // `/memory review` names what it updates.
    expect(await front("/memory review", chat)).toContain("updates: Reply in Spanish, open Tavi to replace it");
  }, 60_000);

  it("a fact update offers Keep both, which keeps both, flagged as a conflict; tavi memory review replaces with r", async () => {
    const { runtime, ipc, model, personal, statusOf } = await composed();
    const lisbon = await ipc<MemoryItem>({
      action: "remember",
      kind: "fact",
      scope: "personal",
      topicKey: "home.city",
      body: "Lives in Lisbon",
    });
    const porto = await runtime.memory.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      topicKey: "home.city",
      body: "Lives in Porto",
    });
    const listed = await ipc<MemoryListAnswer>({ action: "list", statuses: ["proposed"] });
    expect(listed.records.find((record) => record.recordId === porto.recordId)?.updates?.recordId).toBe(lisbon.recordId);
    await ipc({ action: "approve", recordId: porto.recordId });
    const conflicts = await runtime.memory.resolveFactConflicts({
      actor: { ...OPERATOR, caller: "cli", authority: "operator" },
      topicKeys: ["home.city"],
    });
    expect(conflicts[0]?.conflict).toBe(true);

    // The terminal review: an update takes r, which replaces the kept record.
    const braga = await runtime.memory.propose({
      actor: model,
      scope: personal,
      kind: "preference",
      preferenceKey: "units",
      preference: { valueType: "string", value: "metric" },
      body: "Metric units",
    });
    await ipc({ action: "approve", recordId: braga.recordId });
    const imperial = await runtime.memory.propose({
      actor: model,
      scope: personal,
      kind: "preference",
      preferenceKey: "units",
      preference: { valueType: "string", value: "imperial" },
      body: "Imperial units",
    });
    const out: string[] = [];
    const answers = ["k", "r"];
    const summary = await runMemoryReview({
      request: async (payload) =>
        await memoryCommand(
          {
            memory: runtime.memory,
            repositories: runtime.store.asPort().repositories,
            principalOf: () => "operator",
            fromBridge: false,
            now: () => new Date(),
          },
          { ...payload, workspaceId: "default" } as MemoryPayload,
        ),
      ask: async () => answers.shift(),
      stdout: (chunk) => void out.push(chunk),
      stderr: (chunk) => void out.push(chunk),
      workspaceId: "default",
    });
    expect(out.join("")).toContain("updates: Metric units");
    expect(out.join("")).toContain("r, d, s or q");
    expect(summary.replaced).toBe(1);
    expect(await statusOf(imperial.recordId)).toBe("rejected");
  }, 60_000);

  it("Replace still answers the correction when the proposal was decided elsewhere after it landed", async () => {
    const { runtime, ipc, model, personal, statusOf, commandWith } = await composed();
    const lisbon = await ipc<MemoryItem>({
      action: "remember",
      kind: "fact",
      scope: "personal",
      topicKey: "home.city",
      body: "Lives in Lisbon",
    });
    const porto = await runtime.memory.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      topicKey: "home.city",
      body: "Lives in Porto",
    });
    // Kept with *Keep both* elsewhere, between the correction and the discard.
    const answer = await commandWith(
      {
        correct: async (input) => {
          const corrected = await runtime.memory.correct(input);
          await runtime.memory.approve({ actor: OPERATOR_ACTOR, recordId: porto.recordId });
          return corrected;
        },
      },
      { action: "replace", recordId: porto.recordId },
    );
    expect(answer).toMatchObject({ ok: true, result: { recordId: lisbon.recordId, status: "approved", body: "Lives in Porto" } });
    expect(await statusOf(porto.recordId)).toBe("approved");
  }, 60_000);

  it("a near duplicate the tool filed says what it is similar to", async () => {
    const { runtime, ipc, model, personal } = await composed();
    const kept = await ipc<MemoryItem>({
      action: "remember",
      kind: "fact",
      scope: "personal",
      title: "Pets",
      body: "Alice lives in Lisbon with her two cats and a dog",
    });
    const near = await runtime.memory.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      body: "Alice lives in Lisbon with her two cats and dog",
    });
    expect(near.known).toBeUndefined();
    const listed = await ipc<MemoryListAnswer>({ action: "list", statuses: ["proposed"] });
    expect(listed.records.find((record) => record.recordId === near.recordId)?.similarTo).toEqual({
      recordId: kept.recordId,
      title: "Pets",
    });
  }, 60_000);

  it("an untagged fact akin to a kept fact surfaces mayUpdate, waits on Keep all, and Replace assigns an auto.m_ topicKey", async () => {
    const { runtime, ipc, model, personal, turn, card, statusOf } = await composed();
    const lisbon = await ipc<MemoryItem>({
      action: "remember",
      kind: "fact",
      scope: "personal",
      body: "Lives in Lisbon",
    });
    expect(lisbon.topicKey).toBeUndefined();
    const porto = await runtime.memory.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      body: "Lives in Porto",
      nearMatch: "drop",
    });
    expect(porto.known).toBeUndefined();
    const listed = await ipc<MemoryListAnswer>({ action: "list", statuses: ["proposed"] });
    const shownPorto = listed.records.find((record) => record.recordId === porto.recordId);
    expect(shownPorto?.mayUpdate).toEqual({
      recordId: lisbon.recordId,
      title: "Lives in Lisbon",
      currentRevisionId: lisbon.currentRevisionId,
    });

    const chat = await turn("hello");
    const noticeId = await card(chat, [porto.recordId]);
    expect(await ipc<MemoryCardAllAnswer>({ action: "card-all", noticeId, decision: "keep" })).toMatchObject({ kept: 0, needsLook: 1 });
    expect(await statusOf(porto.recordId)).toBe("proposed");

    const replaced = await ipc<MemoryItem>({
      action: "replace",
      recordId: porto.recordId,
      expectedRevisionId: porto.currentRevisionId,
      targetRevisionId: lisbon.currentRevisionId,
    });
    expect(replaced.recordId).toBe(lisbon.recordId);
    expect(replaced.body).toBe("Lives in Porto");
    expect(replaced.topicKey).toMatch(/^auto\.m_[0-9a-f]{8}$/);
    expect(await statusOf(porto.recordId)).toBe("rejected");
  }, 60_000);
});

describe("Replace held to what the update was drafted against", () => {
  it("refuses with REVISION_CONFLICT when the target was corrected after the update was proposed, even at the revision the reviewer saw", async () => {
    const { runtime, ipc, model, personal } = await composed();
    const lisbon = await ipc<MemoryItem>({
      action: "remember",
      kind: "fact",
      scope: "personal",
      body: "Lives in Lisbon with two cats and a dog",
    });
    await pace();
    const porto = await runtime.memory.propose({
      actor: model,
      scope: personal,
      kind: "fact",
      body: "Lives in Porto with two cats and a dog",
      nearMatch: "drop",
    });
    await pace();
    const corrected = await ipc<MemoryItem>({
      action: "correct",
      recordId: lisbon.recordId,
      expectedRevisionId: lisbon.currentRevisionId,
      body: "Lives in Lisbon with two cats and a big dog",
    });
    const listed = await ipc<MemoryListAnswer>({ action: "list", statuses: ["proposed"] });
    const shown = listed.records.find((record) => record.recordId === porto.recordId);
    expect(shown?.mayUpdate?.currentRevisionId).toBe(corrected.currentRevisionId);
    await expect(
      ipc<MemoryItem>({
        action: "replace",
        recordId: porto.recordId,
        expectedRevisionId: porto.currentRevisionId,
        targetRevisionId: corrected.currentRevisionId,
      }),
    ).rejects.toThrow(/REVISION_CONFLICT/);
    expect((await runtime.memory.history({ actor: { ...OPERATOR_ACTOR }, recordId: lisbon.recordId })).revisions[0]?.body).toBe(
      "Lives in Lisbon with two cats and a big dog",
    );
  }, 60_000);
});

describe("remember and move into words already kept", () => {
  it("remember of kept words is that record; a move into a scope holding them, aborted by an edit mid-move, leaves that record kept", async () => {
    const { runtime, ipc, turn, statusOf, commandWith } = await composed();
    const chat = await turn("hello");
    const there = await ipc<MemoryItem>({ action: "remember", kind: "fact", scope: `chat:${chat}`, body: "Prefers short answers" });
    expect(
      (await ipc<MemoryItem>({ action: "remember", kind: "fact", scope: `chat:${chat}`, body: "prefers SHORT answers" })).recordId,
    ).toBe(there.recordId);
    const original = await ipc<MemoryItem>({ action: "remember", kind: "fact", scope: "personal", body: "Prefers short answers" });
    // The original is edited between the copy and its forget.
    const answer = await commandWith(
      {
        remember: async (input) => {
          const copied = await runtime.memory.remember(input);
          await runtime.memory.correct({ actor: OPERATOR_ACTOR, recordId: original.recordId, body: "Prefers very short answers" });
          return copied;
        },
      },
      { action: "move", recordId: original.recordId, to: `chat:${chat}` },
    );
    expect(answer).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    expect(await statusOf(there.recordId)).toBe("approved");
    expect(await statusOf(original.recordId)).toBe("approved");
  }, 60_000);
});
