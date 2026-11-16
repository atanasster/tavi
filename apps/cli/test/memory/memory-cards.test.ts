import {
  MEMORY_CARD_EXCERPT_CHARS,
  MemoryCardAnswerSchema,
  memoryCardChannelMessage,
  memoryCardLine,
  memoryScopeKey,
  type ChatNotice,
  type InvocationContext,
  type MemoryActor,
  type MemoryCardAnswer,
  type MemoryGetAnswer,
  type MemoryPayload,
  type MemoryRecord,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { EPOCH_FLUSH_ATTEMPT_PREFIX } from "@tavi/agent-host/workflow";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import type { MemoryAutoApproveTurn } from "../../src/features/memory/auto-approve.js";
import { createMemoryCards } from "../../src/features/memory/cards.js";
import { memoryCommand } from "../../src/features/memory/owner.js";
import { inspectDatabase } from "../support/database-fixture.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Memory cards in the app and the terminal: a turn that proposed memory gets one card after it, an epoch's
 * flush one card per epoch; the card holds ids and is rendered from the
 * memory rows when read, so a decision made anywhere shows on it and a
 * forgotten record leaves no text behind; and it never reaches a turn.
 */

const directories = temporaryDirectories({ prefix: "tavi-memory-cards-" });
const runtimes: TaviRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

const PROPOSE_TWO = "remember two things about me";
/** The person asks for a health fact to be kept: the model proposes it unmarked. */
const PROPOSE_HEALTH = "remember my blood type, O negative";
/** A span with a health statement: the flush drafts it unmarked, beside an ordinary fact. */
const HEALTH_SPAN = "I am allergic to penicillin and I work from Porto";
const HEALTH_FLUSH_ANSWER = JSON.stringify({
  memories: [
    { kind: "fact", title: "Allergy", body: "The person is allergic to penicillin." },
    { kind: "fact", title: "Works from Porto", body: "The person works from Porto." },
  ],
});
const FLUSH_ANSWER = JSON.stringify({
  memories: [{ kind: "fact", title: "Home city", body: "The person lives in Lisbon.", scope: "everywhere" }],
});
/** A later epoch's flush: something new, since the first's words again are already known and make no card. */
const LATER_FLUSH_ANSWER = JSON.stringify({
  memories: [{ kind: "fact", title: "Work", body: "The person works from home.", scope: "everywhere" }],
});

/**
 * A model that proposes two memories when asked to, answers the epoch flush
 * with one, and otherwise says "Done.", recording every request.
 */
function proposingModel(requests: ModelRequest[]): ModelPort {
  let flushes = 0;
  return {
    async stream(request) {
      requests.push(request);
      const done = {
        attemptId: request.attemptId,
        status: "completed" as const,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      };
      const flush = request.messages.find((message) => message.text.includes("[epoch-flush]"));
      if (flush?.text.includes("penicillin") === true) return { ...done, text: HEALTH_FLUSH_ANSWER };
      if (flush !== undefined) return { ...done, text: (flushes += 1) === 1 ? FLUSH_ANSWER : LATER_FLUSH_ANSWER };
      if (request.purpose !== undefined && request.purpose !== "generation") return { ...done, text: "A chat" };
      const last = request.messages.at(-1);
      if (last?.toolResults === undefined && last?.text.includes(PROPOSE_TWO) === true) {
        return {
          ...done,
          text: "",
          finishReason: "tool-calls" as const,
          toolCalls: [
            {
              id: "p1",
              name: "memory.propose",
              input: { kind: "fact", title: "You're vegetarian", body: "The person is vegetarian and cooks at home." },
            },
            { id: "p2", name: "memory.propose", input: { kind: "fact", body: "The person prefers metric units", scope: "chat" } },
          ],
        };
      }
      if (last?.toolResults === undefined && last?.text.includes(PROPOSE_HEALTH) === true) {
        return {
          ...done,
          text: "",
          finishReason: "tool-calls" as const,
          toolCalls: [
            {
              id: "h1",
              name: "memory.propose",
              input: { kind: "fact", title: "Blood type", body: "The person's blood type is O negative." },
            },
          ],
        };
      }
      return { ...done, text: "Done." };
    },
  };
}

const OPERATOR = { workspaceId: "default", principalId: "operator" };

async function composed() {
  const requests: ModelRequest[] = [];
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directories.create(), {
      workspaces: [{ ...OPERATOR, permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: [],
    }),
    { modelOverride: proposingModel(requests) },
  );
  runtimes.push(runtime);
  const repositories = runtime.store.asPort().repositories;
  // As the canvas asks, through its bridge: an edit is the operator's.
  const ipc = async <T>(payload: MemoryPayload): Promise<T> => {
    const answer = await memoryCommand(
      { memory: runtime.memory, repositories, principalOf: () => "operator", fromBridge: true, now: () => new Date() },
      payload,
    );
    if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`);
    return answer.result as T;
  };
  let count = 0;
  const turn = async (
    prompt: string,
    taskId?: string,
  ): Promise<{ readonly taskId: string; readonly requests: readonly ModelRequest[] }> => {
    count += 1;
    const before = requests.length;
    const result = await runtime.workflow?.admit({
      context: { ...OPERATOR, runId: "pending-admission", caller: "cli" },
      operationKey: `turn-${count}`,
      kind: taskId === undefined ? "start" : "reply",
      ...(taskId === undefined ? {} : { taskId }),
      prompt,
    });
    if (result === undefined) throw new Error("no workflow");
    return { taskId: result.taskId, requests: requests.slice(before) };
  };
  const cards = async (taskId: string): Promise<readonly ChatNotice[]> =>
    (await repositories.transcripts.notices(taskId, { limit: 50 })).filter((notice) => notice.kind === "memory");
  const card = (noticeId: string) => ipc<MemoryCardAnswer>({ action: "card", noticeId });
  return { runtime, repositories, ipc, turn, cards, card, requests };
}

describe("sensitive topics on cards", () => {
  it("a health fact the person asked for is filed, marked sensitive though the model did not mark it, and masked on the card, the terminal and a channel", async () => {
    const { turn, cards, card, repositories } = await composed();
    const { taskId } = await turn(PROPOSE_HEALTH);
    const posted = await cards(taskId);
    expect(posted).toHaveLength(1);
    const shown = await card((posted[0] as ChatNotice).noticeId);
    expect(shown.items.map((item) => [item.state, item.sensitive, item.title, item.excerpt])).toEqual([["proposed", true, null, null]]);
    const record = await repositories.memory.getRecord(shown.items[0]!.recordId);
    expect(record).toMatchObject({ status: "proposed", sensitivity: "sensitive" });
    expect(memoryCardLine(shown)).not.toMatch(/blood/i);
    const channel = memoryCardChannelMessage(shown, "buttons");
    expect(channel.text).toContain("1 sensitive item waiting — open Tavi to review");
    expect(channel.text).not.toMatch(/blood/i);
    expect(channel.buttons.map((button) => button.label)).toEqual(["Open"]);
  }, 60_000);

  it("a health statement in a flushed span files no proposal by default, and a masked sensitive one when the workspace asks for sensitive topics suggested", async () => {
    for (const sensitive of [undefined, "suggest"] as const) {
      const { runtime, repositories, turn, cards, card } = await composed();
      if (sensitive !== undefined) {
        await repositories.workspaceSettings.set({
          workspaceId: "default",
          settings: { memory: { sensitive } },
          expectedRevision: 0,
          actor: "operator:cli",
          now: nowTimestamp(),
        });
      }
      const { taskId } = await turn(HEALTH_SPAN);
      await runtime.requestFreshContext(taskId);
      await turn("let's plan the week", taskId);
      const posted = await cards(taskId);
      expect(posted).toHaveLength(1);
      const shown = await card((posted[0] as ChatNotice).noticeId);
      if (sensitive === undefined) {
        // Only the ordinary fact: the allergy was dropped before it reached the service.
        expect(shown.items.map((item) => [item.sensitive, item.title])).toEqual([[false, "Works from Porto"]]);
        const kept = await runtime.memory.list({ actor: { ...OPERATOR, caller: "test", authority: "operator" }, statuses: ["proposed"] });
        expect(JSON.stringify(kept)).not.toContain("penicillin");
      } else {
        expect(shown.items.map((item) => [item.sensitive, item.title])).toEqual([
          [true, null],
          [false, "Works from Porto"],
        ]);
        expect(memoryCardLine(shown)).not.toContain("penicillin");
      }
    }
  }, 120_000);
});

describe("a turn's memory card", () => {
  it("a turn calling memory.propose twice gives one card after it, listing both, rendered from the memory rows", async () => {
    const { turn, cards, card, repositories } = await composed();
    const { taskId } = await turn(PROPOSE_TWO);
    const posted = await cards(taskId);
    expect(posted).toHaveLength(1);
    const [notice] = posted as [ChatNotice];
    expect(notice).toMatchObject({ title: "2 things to remember", summary: "" });
    // After the turn that proposed them.
    const page = await repositories.transcripts.page(taskId, { limit: 10 });
    expect(notice.afterSeq).toBe(page.entries.at(-1)?.seq);
    const shown = await card(notice.noticeId);
    expect(shown.items.map((item) => [item.number, item.state, item.title, item.target])).toEqual([
      [1, "proposed", "You're vegetarian", "personal"],
      [2, "proposed", "The person prefers metric units", `chat:${taskId}`],
    ]);
    expect(shown.items[0]?.excerpt).toBe("The person is vegetarian and cooks at home.");
    // The terminal's line names both, and how to decide them with the chat commands.
    expect(memoryCardLine(shown)).toBe(
      "◆ Proposed: 1. You're vegetarian; 2. The person prefers metric units — /memory keep <n> · /memory keep all · /memory discard <n>",
    );
    // A second turn that proposes nothing posts no card.
    await turn("thanks", taskId);
    expect(await cards(taskId)).toHaveLength(1);
  }, 60_000);

  it("memory invariant 1: nothing a model proposed is kept until a person keeps it; Keep approves with an operator review, and a keep from the Center shows on the card", async () => {
    const { runtime, turn, cards, card, ipc } = await composed();
    const { taskId } = await turn(PROPOSE_TWO);
    const [notice] = (await cards(taskId)) as [ChatNotice];
    const [first, second] = (await card(notice.noticeId)).items;
    if (first === undefined || second === undefined) throw new Error("the card lost an item");
    // Model authority commits nothing.
    const model: MemoryActor = { ...OPERATOR, caller: "agent", authority: "model" };
    await expect(runtime.memory.approve({ actor: model, recordId: first.recordId })).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect((await card(notice.noticeId)).items.map((item) => item.state)).toEqual(["proposed", "proposed"]);

    // Keep on the card: the memory IPC's approve, held to the revision the card showed.
    await ipc({
      action: "approve",
      recordId: first.recordId,
      ...(first.currentRevisionId === undefined ? {} : { expectedRevisionId: first.currentRevisionId }),
    });
    const got = await ipc<MemoryGetAnswer>({ action: "get", recordId: first.recordId });
    expect(got.record.status).toBe("approved");
    expect(got.reviews).toEqual([expect.objectContaining({ decision: "approved", reviewerPrincipalId: "operator" })]);
    // The Center keeps the other through the same command: the transcript's card shows it kept.
    await ipc({ action: "reject", recordId: second.recordId });
    const now = await card(notice.noticeId);
    expect(now.items.map((item) => item.state)).toEqual(["saved", "discarded"]);
    expect(memoryCardLine(now)).toBe("◆ Saved: 1. You're vegetarian · Discarded: 2. The person prefers metric units");
  }, 60_000);

  it("cuts a long excerpt to the schema's length in UTF-16 units, never splitting an emoji, so the answer stays valid", async () => {
    const { turn, cards, card, ipc } = await composed();
    const { taskId } = await turn(PROPOSE_TWO);
    const [notice] = (await cards(taskId)) as [ChatNotice];
    const [first] = (await card(notice.noticeId)).items;
    if (first === undefined) throw new Error("no item");
    await ipc({ action: "approve", recordId: first.recordId });
    await ipc({ action: "correct", recordId: first.recordId, body: "🌱".repeat(200) });
    const shown = MemoryCardAnswerSchema.parse(await card(notice.noticeId));
    const excerpt = shown.items[0]?.excerpt ?? "";
    expect(excerpt.length).toBe(MEMORY_CARD_EXCERPT_CHARS);
    expect(excerpt).toBe("🌱".repeat(MEMORY_CARD_EXCERPT_CHARS / 2));
  }, 60_000);

  it("memory invariant 9: Undo forgets a saved record with a journal row; the card then says Forgotten, and no notice row, card row or rendered card holds its text", async () => {
    const { repositories, turn, cards, card, ipc } = await composed();
    const { taskId } = await turn(PROPOSE_TWO);
    const [notice] = (await cards(taskId)) as [ChatNotice];
    const [first] = (await card(notice.noticeId)).items;
    if (first === undefined) throw new Error("no item");
    await ipc({ action: "approve", recordId: first.recordId });
    await ipc({ action: "forget", recordId: first.recordId, reason: "undone from a memory card" });
    const deletions = await repositories.memory.listDeletions({
      scopeKeys: [memoryScopeKey({ kind: "personal", principalId: "operator" })],
      limit: 10,
    });
    expect(deletions.filter((deletion) => deletion.recordId === first.recordId)).toHaveLength(1);
    const shown = await card(notice.noticeId);
    expect(shown.forgotten).toBe(1);
    expect(shown.items.map((item) => item.recordId)).not.toContain(first.recordId);
    expect(memoryCardLine(shown)).toBe(
      "◆ Proposed: The person prefers metric units · Forgotten: 1 item — /memory keep 2 · /memory discard 2",
    );
    // Memory invariant 22: what the card stores is ids and counts, never words, before and after.
    const stored = JSON.stringify([await cards(taskId), await repositories.transcripts.memoryPrompts(notice.noticeId), shown]);
    expect(stored).not.toContain("vegetarian");
    expect(stored).not.toContain(first.recordId);
  }, 60_000);

  it("a card whose records were all forgotten still says Forgotten after the week's sweep; a decided card's swept rows read as decided", async () => {
    const { runtime, repositories, turn, cards, card, ipc } = await composed();
    const forgottenChat = await turn(PROPOSE_TWO);
    const [forgottenCard] = (await cards(forgottenChat.taskId)) as [ChatNotice];
    for (const item of (await card(forgottenCard.noticeId)).items)
      await ipc({ action: "forget", recordId: item.recordId, reason: "undone from a memory card" });
    const decidedChat = await turn(PROPOSE_TWO);
    const [decidedCard] = (await cards(decidedChat.taskId)) as [ChatNotice];
    for (const item of (await card(decidedCard.noticeId)).items) await ipc({ action: "reject", recordId: item.recordId });

    // A week and a day on, the sweep has settled and deleted the decided card's rows.
    const later = new Date(Date.now() + 8 * 86_400_000);
    await repositories.transcripts.pruneMemoryPrompts({ now: nowTimestamp(), settledBefore: later.toISOString() });
    expect(await repositories.transcripts.memoryPrompts(decidedCard.noticeId)).toEqual([]);
    const readLater = async (noticeId: string): Promise<MemoryCardAnswer> => {
      const answer = await memoryCommand(
        { memory: runtime.memory, repositories, principalOf: () => "operator", fromBridge: true, now: () => later },
        { action: "card", noticeId },
      );
      if (!answer.ok) throw new Error(answer.error.message);
      return answer.result as MemoryCardAnswer;
    };
    const forgotten = await readLater(forgottenCard.noticeId);
    expect([forgotten.items, forgotten.forgotten]).toEqual([[], 2]);
    expect(memoryCardLine(forgotten)).toContain("Forgotten");
    expect((await readLater(decidedCard.noticeId)).forgotten).toBe(0);
    // Memory invariant 22: the card's words are a count and a word, never a record's.
    expect(JSON.stringify(await cards(forgottenChat.taskId))).not.toContain("vegetarian");
  }, 60_000);

  it("memory invariant 19: a card's words never reach the next turn's prompt", async () => {
    const { turn, cards } = await composed();
    const { taskId } = await turn(PROPOSE_TWO);
    expect(await cards(taskId)).toHaveLength(1);
    const next = await turn("what should I cook tonight?", taskId);
    const said = JSON.stringify(next.requests.map((request) => request.messages.map((message) => message.text)));
    expect(said).not.toContain("things to remember");
    expect(said).not.toContain("Proposed ·");
  }, 60_000);

  it("the flush posts one card per epoch, in the chat that rolled over", async () => {
    const { runtime, turn, cards, card } = await composed();
    const { taskId } = await turn("I live in Lisbon");
    await runtime.requestFreshContext(taskId);
    await turn("let's plan the week", taskId);
    const first = await cards(taskId);
    expect(first.map((notice) => notice.title)).toEqual(["1 thing to remember from before this chat rolled over"]);
    const shown = await card((first[0] as ChatNotice).noticeId);
    expect(shown.items.map((item) => [item.state, item.title])).toEqual([["proposed", "Home city"]]);
    await runtime.requestFreshContext(taskId);
    await turn("and the weekend", taskId);
    expect((await cards(taskId)).map((notice) => notice.title)).toEqual([
      "1 thing to remember from before this chat rolled over",
      "1 thing to remember from before this chat rolled over",
    ]);
  }, 60_000);

  it("a flush's call keeps no copy of its request, under its own attempt prefix, and doctor counts its spend", async () => {
    const { runtime, turn, cards } = await composed();
    const { taskId } = await turn("I live in Lisbon");
    await runtime.requestFreshContext(taskId);
    await turn("let's plan the week", taskId);
    expect(await cards(taskId)).toHaveLength(1);
    const db = inspectDatabase(runtime.store);
    const flushes = db
      .prepare(
        `SELECT call_id FROM tavi_provider_attempts WHERE run_id = ? AND substr(attempt_id, 1, ${EPOCH_FLUSH_ATTEMPT_PREFIX.length}) = ?`,
      )
      .all(taskId, EPOCH_FLUSH_ATTEMPT_PREFIX) as { call_id: string }[];
    expect(flushes).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS n FROM tavi_provider_attempt_requests WHERE call_id = ?").get(flushes[0]!.call_id)).toEqual({
      n: 0,
    });
    // A turn's own call still keeps its request: only the flush is left out.
    expect(
      (db.prepare("SELECT count(*) AS n FROM tavi_provider_attempt_requests WHERE run_id = ?").get(taskId) as { n: number }).n,
    ).toBeGreaterThan(0);
    const spend = await runtime.store.memoryCallSpend({
      workspaceIds: ["default"],
      since: "2000-01-01T00:00:00.000Z",
      purpose: "summary",
      attemptPrefix: EPOCH_FLUSH_ATTEMPT_PREFIX,
    });
    expect(spend).toMatchObject({ calls: 1, failed: 0, inputTokens: 10, outputTokens: 2 });
  }, 60_000);
});

describe("where a card goes", () => {
  const AT = "2026-10-11T08:00:00.000Z";
  function harness() {
    const turns: MemoryAutoApproveTurn[] = [];
    /** *Keep without asking* as the stub reads it now; each read is a new revision. */
    const ticked: string[] = ["fact"];
    let revision = 0;
    const posted: { readonly taskId: string; readonly sourceKey: string; readonly records: readonly string[] }[] = [];
    const chats: Record<string, { readonly chatKind?: string }> = { root: { chatKind: "chat" }, worker: { chatKind: "worker" }, group: {} };
    const cards = createMemoryCards({
      repositories: {
        tasks: {
          get: async (taskId: string) =>
            chats[taskId] === undefined ? undefined : { taskId, workspaceId: "default", principalId: "operator", ...chats[taskId] },
        },
        transcripts: {
          postMemoryCard: async (input: {
            readonly taskId: string;
            readonly sourceKey: string;
            readonly records: readonly { readonly recordId: string }[];
          }) => {
            posted.push({ taskId: input.taskId, sourceKey: input.sourceKey, records: input.records.map((record) => record.recordId) });
            return { notice: {}, prompts: [] };
          },
        },
      } as never,
      newId: () => "notice-1",
      now: () => AT,
      log: () => {},
      autoApprove: {
        afterTurn: async (turn) => {
          turns.push(turn);
          return [];
        },
        settingsNow: async () => (ticked.length === 0 ? undefined : { kinds: [...ticked], revision: (revision += 1) }),
      },
    });
    const record = (recordId: string, originTaskId: string): MemoryRecord => ({
      recordId,
      kind: "fact",
      scope: { kind: "personal", principalId: "operator" },
      scopeKey: "k",
      status: "proposed",
      sensitivity: "normal",
      revocationGeneration: 0,
      recordedAt: AT,
      updatedAt: AT,
      originTaskId,
    });
    const context = (runId: string, extra: Partial<InvocationContext> = {}): InvocationContext => ({
      ...OPERATOR,
      runId,
      caller: "agent",
      ...extra,
    });
    return { cards, posted, record, context, turns, ticked };
  }

  it("memory invariant 2: a turn asked from a non-local reply target (the operator's Telegram DM linked to Home) reaches auto-approve as messaging; the owner's local connection does not", async () => {
    const { cards, record, context, turns } = harness();
    const replyTo = (connectionId: string) => ({
      messagingReplyTo: { connectionId, externalConversationId: "dm-1", externalSenderId: "operator-tg" },
    });
    cards.onAdmissionClaimed("root", "a1");
    cards.noteProposed(context("root", replyTo("telegram-1")), record("m1", "root"));
    await cards.onTaskEnded("root", "a1");
    cards.onAdmissionClaimed("root", "a2");
    cards.noteProposed(context("root", replyTo("local-owner")), record("m2", "root"));
    await cards.onTaskEnded("root", "a2");
    expect(turns.map((turn) => [turn.admissionId, turn.messaging])).toEqual([
      ["a1", true],
      ["a2", false],
    ]);
  });

  it("memory invariant 2: a turn that waited and was resumed hands auto-approve each proposal with the admission that made it; one filed before any claim carries none", async () => {
    const { cards, record, context, turns, posted } = harness();
    cards.noteProposed(context("root"), record("m0", "root"));
    cards.onAdmissionClaimed("root", "a1");
    cards.noteProposed(context("root"), record("m1", "root"));
    // a1 waits (operator.ask_user): no end is told; the reply a2 is claimed and completes.
    cards.onAdmissionClaimed("root", "a2");
    cards.noteProposed(context("root"), record("m2", "root"));
    await cards.onTaskEnded("root", "a2");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      runId: "root",
      admissionId: "a2",
      proposals: [{ recordId: "m0" }, { recordId: "m1", admissionId: "a1" }, { recordId: "m2", admissionId: "a2" }],
    });
    expect(turns[0]?.proposals[0]?.admissionId).toBeUndefined();
    expect(posted).toEqual([{ taskId: "root", sourceKey: "memory:a2", records: ["m0", "m1", "m2"] }]);
  });

  it("memory invariant 2: each proposal carries *Keep without asking* as it was when it was filed, not only at the turn's end", async () => {
    const { cards, record, context, turns, ticked } = harness();
    cards.onAdmissionClaimed("root", "a1");
    cards.noteProposed(context("root"), record("m1", "root"));
    await Promise.resolve();
    ticked.length = 0;
    cards.noteProposed(context("root"), record("m2", "root"));
    await cards.onTaskEnded("root", "a1");
    expect(turns[0]?.proposals).toEqual([
      { recordId: "m1", admissionId: "a1", settings: { kinds: ["fact"], revision: 1 } },
      { recordId: "m2", admissionId: "a1", settings: null },
    ]);
  });

  it("a worker's proposal goes to the chat it works for, as its own card when the worker's turn ends", async () => {
    const { cards, posted, record, context } = harness();
    cards.noteProposed(context("worker", { chatTaskId: "root" }), record("m1", "root"));
    await cards.onTaskEnded("root", "a-root");
    expect(posted).toEqual([]);
    await cards.onTaskEnded("worker", "a-worker");
    expect(posted).toEqual([{ taskId: "root", sourceKey: "memory:a-worker", records: ["m1"] }]);
    // Taken once: a later end of the worker posts nothing again.
    await cards.onTaskEnded("worker", "a-worker-2");
    expect(posted).toHaveLength(1);
  });

  it("a group's proposals get no card", async () => {
    const { cards, posted, record, context } = harness();
    cards.noteProposed(context("group", { memoryReach: "chat-only" }), record("m1", "group"));
    await cards.onTaskEnded("group", "a1");
    expect(posted).toEqual([]);
  });
});
