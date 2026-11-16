import {
  memoryScopeKey,
  type ChatKind,
  type ChatNotice,
  type MemoryActor,
  type MemoryCardAnswer,
  type MemoryGetAnswer,
  type MemoryPayload,
  type MemoryProvenance,
  type MemorySettings,
  type ModelPort,
  type TaskOrigin,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories } from "@tavi/test-support";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { createMemoryAutoApprove } from "../../src/features/memory/auto-approve.js";
import { memoryCommand } from "../../src/features/memory/owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Opt-in auto-approve: a
 * kind the operator ticked under *Keep without asking* is kept at once —
 * with the operator's authority and the review note `auto-approve (settings
 * revision N)` — only for the operator's own attended, untainted,
 * non-messaging turn or idle review, only when the host finds the words in
 * what the person typed in one message, never for a reserved preference key,
 * a sensitive, update, worker, flushed, consolidated or other person's
 * proposal. Its card shows it *Saved* with *Undo*. Everything else waits.
 */

const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

const OPERATOR = { workspaceId: "default", principalId: "operator" };
const OPERATOR_ACTOR: MemoryActor = { ...OPERATOR, caller: "test", authority: "operator" };
const VEGETARIAN = { kind: "fact", title: "You're vegetarian", body: "The person is vegetarian and cooks at home." };
/** The person's words for `VEGETARIAN`, with the phrase that has the model propose it. */
const SAID = "I'm vegetarian and cook at home, remember that";

/** What the model proposes for a message holding each phrase (the first that matches). */
const PROPOSALS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["remember that", VEGETARIAN],
  ["remember where I live", { kind: "fact", title: "Home city", body: "The person lives in Lisbon." }],
  ["remember my blood type", { kind: "fact", title: "Blood type", body: "The person's blood type is O negative." }],
  ["remember my diet", { ...VEGETARIAN, topicKey: "diet" }],
  ["remember my cycling", { kind: "fact", title: "Cycles to work", body: "The person cycles to work." }],
  [
    "remember my language",
    { kind: "preference", title: "Reply language", body: "Reply in Spanish.", preferenceKey: "reply.language", preferenceValue: "Spanish" },
  ],
  [
    "remember my payment",
    { kind: "preference", title: "Payment", body: "Pays with Visa.", preferenceKey: "payment.method", preferenceValue: "Visa" },
  ],
  [
    "remember my build",
    { kind: "preference", title: "Build command", body: "May run make build.", preferenceKey: "exec.allow", preferenceValue: "make build" },
  ],
];
const FLUSH_ANSWER = JSON.stringify({
  memories: [{ kind: "fact", title: "Home city", body: "The person lives in Lisbon.", scope: "everywhere" }],
});

function proposingModel(): ModelPort {
  return {
    async stream(request) {
      const done = {
        attemptId: request.attemptId,
        status: "completed" as const,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      };
      if (request.messages.some((message) => message.text.includes("[epoch-flush]"))) return { ...done, text: FLUSH_ANSWER };
      if (request.purpose !== undefined && request.purpose !== "generation") return { ...done, text: "A chat" };
      const last = request.messages.at(-1);
      const found = last?.toolResults === undefined ? PROPOSALS.find(([phrase]) => last?.text.includes(phrase) === true) : undefined;
      if (found !== undefined)
        return {
          ...done,
          text: "",
          finishReason: "tool-calls" as const,
          toolCalls: [{ id: "p1", name: "memory.propose", input: found[1] }],
        };
      return { ...done, text: "Done." };
    },
  };
}

async function composed(memory?: MemorySettings) {
  const dataDirectory = directories.create("tavi-memory-auto-");
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(dataDirectory, {
      workspaces: [{ ...OPERATOR, permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: [],
    }),
    { modelOverride: proposingModel() },
  );
  runtimes.push(runtime);
  const repositories = runtime.store.asPort().repositories;
  /** Sets the memory section as the operator does; answers the settings revision. */
  const settle = async (section: MemorySettings): Promise<number> => {
    const current = await repositories.workspaceSettings.get("default");
    return (
      await repositories.workspaceSettings.set({
        workspaceId: "default",
        settings: { ...current.settings, memory: section },
        expectedRevision: current.revision,
        actor: "operator:cli",
        now: nowTimestamp(),
      })
    ).revision;
  };
  if (memory !== undefined) await settle(memory);
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
  /** The items of every memory card in a chat, as the canvas renders them now. */
  const items = async (taskId: string) => {
    const notices: readonly ChatNotice[] = (await repositories.transcripts.notices(taskId, { limit: 50 })).filter(
      (notice) => notice.kind === "memory",
    );
    const cards: MemoryCardAnswer[] = [];
    for (const notice of notices) cards.push(await ipc<MemoryCardAnswer>({ action: "card", noticeId: notice.noticeId }));
    return cards.flatMap((card) => card.items);
  };
  /** One turn's single proposal, as its card shows it: its state, and the record's id. */
  const proposed = async (prompt: string): Promise<{ readonly state: string; readonly recordId: string; readonly taskId: string }> => {
    const taskId = await turn(prompt);
    const [item, ...rest] = await items(taskId);
    expect(rest, prompt).toEqual([]);
    if (item === undefined) throw new Error(`no card for ${prompt}`);
    return { state: item.state, recordId: item.recordId, taskId };
  };
  return { runtime, repositories, settle, ipc, turn, items, proposed };
}

describe("auto-approve after a turn", () => {
  it("memory invariant 1: with autoApprove [] (the default), a person's own words proposed by the model wait for a person", async () => {
    const { proposed, ipc } = await composed();
    const vegetarian = await proposed(SAID);
    expect(vegetarian.state).toBe("proposed");
    const got = await ipc<MemoryGetAnswer>({ action: "get", recordId: vegetarian.recordId });
    expect(got.record.status).toBe("proposed");
    expect(got.reviews).toEqual([]);
  }, 60_000);

  it("memory invariant 2: with Facts ticked, a fact in the person's own words arrives Saved, its review names the settings revision, and Undo forgets it", async () => {
    const { proposed, settle, ipc, repositories } = await composed();
    const revision = await settle({ autoApprove: ["fact"] });
    const vegetarian = await proposed(SAID);
    expect(vegetarian.state).toBe("saved");
    const got = await ipc<MemoryGetAnswer>({ action: "get", recordId: vegetarian.recordId });
    expect(got.record.status).toBe("approved");
    expect(got.reviews).toEqual([
      expect.objectContaining({
        decision: "approved",
        reviewerPrincipalId: "operator",
        reason: `auto-approve (settings revision ${revision})`,
      }),
    ]);
    // Undo on the Saved card forgets it, with a journal row.
    await ipc({ action: "forget", recordId: vegetarian.recordId, reason: "undone from a memory card" });
    const deletions = await repositories.memory.listDeletions({
      scopeKeys: [memoryScopeKey({ kind: "personal", principalId: "operator" })],
      limit: 10,
    });
    expect(deletions.filter((row) => row.recordId === vegetarian.recordId)).toHaveLength(1);
  }, 60_000);

  it("words only inside a > quote, a code fence or double quotes do not pass the quote check; the same words typed plainly do", async () => {
    const { proposed, settle, ipc } = await composed();
    await settle({ autoApprove: ["fact"] });
    for (const pasted of [
      "> I'm vegetarian and cook at home\n\nremember that",
      "```\nI'm vegetarian and cook at home\n```\nremember that",
      'She wrote "I\'m vegetarian and cook at home", remember that',
      "She wrote “I'm vegetarian and cook at home”, remember that",
    ]) {
      const waiting = await proposed(pasted);
      expect(waiting.state, pasted).toBe("proposed");
      // Discarded, so the same words are a new proposal next time rather than "already known".
      await ipc({ action: "reject", recordId: waiting.recordId });
    }
    expect((await proposed(SAID)).state).toBe("saved");
  }, 120_000);

  it("memory invariant 2: a sensitive one, an assistant-sourced one and an update stay proposed under Facts", async () => {
    const { proposed, settle, runtime } = await composed();
    await settle({ autoApprove: ["fact"] });
    expect((await proposed("My blood type, O negative: remember my blood type")).state).toBe("proposed");
    // The model's words, not the person's: Lisbon was never typed.
    expect((await proposed("remember where I live")).state).toBe("proposed");
    // An update of a kept fact (its topic key): Replace waits for the person.
    await runtime.memory.remember({
      actor: OPERATOR_ACTOR,
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "The person eats fish.",
      topicKey: "diet",
    });
    expect((await proposed("I'm vegetarian now, remember my diet")).state).toBe("proposed");
  }, 120_000);

  it("memory invariant 2: with Preferences ticked, a person-typed payment.method or exec.allow stays proposed, while reply.language is kept", async () => {
    const { proposed, settle } = await composed();
    await settle({ autoApprove: ["preference"] });
    expect((await proposed("I always pay with Visa, remember my payment")).state).toBe("proposed");
    expect((await proposed("You may always run make build, remember my build")).state).toBe("proposed");
    expect((await proposed("Please always reply in Spanish, remember my language")).state).toBe("saved");
    // Facts are not ticked: a fact waits.
    expect((await proposed(SAID)).state).toBe("proposed");
  }, 120_000);

  it("removing the kind stops it from the next proposal", async () => {
    const { proposed, settle } = await composed();
    await settle({ autoApprove: ["fact"] });
    expect((await proposed(SAID)).state).toBe("saved");
    await settle({});
    expect((await proposed("I cycle to work every day, remember my cycling")).state).toBe("proposed");
  }, 120_000);

  it("memory invariant 2: a flushed proposal stays proposed under Facts, though the person typed its words", async () => {
    const { runtime, turn, items, settle } = await composed();
    await settle({ autoApprove: ["fact"] });
    const taskId = await turn("I live in Lisbon");
    await runtime.requestFreshContext(taskId);
    await turn("let's plan the week", taskId);
    expect((await items(taskId)).map((item) => [item.title, item.state])).toEqual([["Home city", "proposed"]]);
  }, 60_000);
});

describe("auto-approve's sources", () => {
  /** A task, a saved turn in it, and a model's proposal of the person's words from it. */
  async function scene(input: {
    readonly principalId?: string;
    readonly chatKind?: ChatKind;
    readonly origin?: TaskOrigin;
    readonly tainted?: true;
    readonly channel?: "messaging";
    readonly author?: string;
    readonly title?: string;
    readonly body?: string;
    /** What the person typed in the turn; `SAID` unless given. */
    readonly said?: string;
    /** A record kept before the proposal, with its vector of `local/embed` when given. */
    readonly kept?: { readonly body: string; readonly vector?: readonly number[] };
    /** The draft's vector, as hybrid recall's rules would make it. */
    readonly draftVector?: readonly number[];
    /** The provenance `memory.propose` stamped from its call's context label. */
    readonly provenance?: MemoryProvenance;
  }) {
    const fixture = await composed({ autoApprove: ["fact"] });
    const { runtime, repositories } = fixture;
    const principalId = input.principalId ?? "operator";
    const taskId = `task-${principalId}-${input.chatKind ?? "chat"}-${input.origin ?? "cli"}`;
    const now = nowTimestamp();
    await repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId,
      operationKey: `op-${taskId}`,
      kind: "start",
      intent: { prompt: "I'm vegetarian" },
      checkpointNamespace: "",
      ...(input.chatKind === undefined ? {} : { chatKind: input.chatKind }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      newTaskId: taskId,
      newAdmissionId: `adm-${taskId}`,
      newThreadId: `thread-${taskId}`,
      now,
    });
    await repositories.transcripts.append({
      taskId,
      admissionId: `adm-${taskId}`,
      createdAt: now,
      turn: {
        admissionKind: "start",
        prompt: input.said ?? SAID,
        items: [],
        outcome: { status: "completed", finalText: "Noted." },
        ...(input.tainted === undefined ? {} : { tainted: true }),
        ...(input.channel === undefined ? {} : { channel: input.channel }),
      },
    });
    if (input.kept !== undefined) {
      const kept = await runtime.memory.remember({
        actor: { ...OPERATOR_ACTOR, principalId },
        scope: { kind: "personal", principalId },
        kind: "fact",
        body: input.kept.body,
      });
      if (input.kept.vector !== undefined)
        await repositories.memory.putVectors({
          vectors: [{ revisionId: kept.currentRevisionId ?? "", modelKey: "local/embed", vector: input.kept.vector }],
          now,
        });
    }
    const record = await runtime.memory.propose({
      actor: { workspaceId: "default", principalId, runId: taskId, caller: input.author ?? "agent", authority: "model" },
      scope: { kind: "personal", principalId },
      kind: "fact",
      title: input.title ?? VEGETARIAN.title,
      body: input.body ?? VEGETARIAN.body,
      originTaskId: taskId,
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    });
    const draftVector = input.draftVector;
    const auto = createMemoryAutoApprove({
      memory: runtime.memory,
      repositories,
      operatorOf: () => "operator",
      log: () => {},
      ...(draftVector === undefined ? {} : { draftVector: async () => ({ modelKey: "local/embed", vector: draftVector }) }),
    });
    const status = async (): Promise<string | undefined> => (await repositories.memory.getRecord(record.recordId))?.status;
    const replyAdmissionId = `adm-${taskId}-reply`;
    /** A later admission of the task, saved: its own turn, untainted unless `extra` says so. */
    const reply = async (prompt: string, extra: { readonly tainted?: true; readonly channel?: "messaging" } = {}): Promise<void> => {
      await repositories.transcripts.append({
        taskId,
        admissionId: replyAdmissionId,
        createdAt: nowTimestamp(),
        turn: { admissionKind: "reply", prompt, items: [], outcome: { status: "completed", finalText: "Noted." }, ...extra },
      });
    };
    return {
      auto,
      taskId,
      recordId: record.recordId,
      principalId,
      status,
      reply,
      replyAdmissionId,
      admissionId: `adm-${taskId}`,
      settle: fixture.settle,
      ipc: fixture.ipc,
      repositories,
    };
  }
  /** The scene's turn ended, its one proposal handed over as `features/memory/cards.ts` hands it, with the settings it was filed under. */
  const endTurn = (
    each: Awaited<ReturnType<typeof scene>>,
    settings?: { readonly kinds: readonly string[]; readonly revision: number } | null,
  ) =>
    each.auto.afterTurn({
      workspaceId: "default",
      principalId: "operator",
      runId: each.taskId,
      admissionId: each.admissionId,
      worker: false,
      messaging: false,
      proposals: [{ recordId: each.recordId, admissionId: each.admissionId, ...(settings === undefined ? {} : { settings }) }],
    });

  it("keeps the operator's own attended, untainted turn's fact; the same words stay proposed from a tainted, messaging, worker or unattended turn", async () => {
    const own = await scene({});
    expect(
      await own.auto.afterTurn({
        workspaceId: "default",
        principalId: "operator",
        runId: own.taskId,
        admissionId: `adm-${own.taskId}`,
        worker: false,
        messaging: false,
        proposals: [{ recordId: own.recordId, admissionId: own.admissionId }],
      }),
    ).toEqual([own.recordId]);
    expect(await own.status()).toBe("approved");
    for (const [what, input, worker] of [
      ["tainted", { tainted: true }, false],
      ["messaging", { channel: "messaging" }, false],
      ["worker", { chatKind: "worker" }, true],
      ["heartbeat", { origin: "heartbeat" }, false],
      ["run", { chatKind: "run" }, false],
    ] as const) {
      const other = await scene(input as Parameters<typeof scene>[0]);
      expect(
        await other.auto.afterTurn({
          workspaceId: "default",
          principalId: "operator",
          runId: other.taskId,
          admissionId: `adm-${other.taskId}`,
          worker,
          messaging: false,
          proposals: [{ recordId: other.recordId, admissionId: other.admissionId }],
        }),
        what,
      ).toEqual([]);
      expect(await other.status(), what).toBe("proposed");
    }
  }, 120_000);

  it("an explicit proposal stamped with untrusted provenance waits, though its saved turn reads clean (the call-time stamp is a lower bound)", async () => {
    const read = await scene({
      provenance: {
        integrity: "untrusted",
        sources: ["web"],
        refs: [{ source: "web", ref: "call-1", host: "example.com", at: "2026-10-13T00:00:00.000Z" }],
      },
    });
    expect(await endTurn(read)).toEqual([]);
    expect(await read.status()).toBe("proposed");
  }, 60_000);

  it("memory invariant 2: a proposal is judged by the admission that made it: one from a tainted admission stays proposed though a later clean reply holds its words", async () => {
    const tainted = await scene({ tainted: true });
    // The reply that resumed the chat after it waited: untainted, the person's words again.
    await tainted.reply("I'm vegetarian and cook at home, yes remember that");
    expect(
      await tainted.auto.afterTurn({
        workspaceId: "default",
        principalId: "operator",
        runId: tainted.taskId,
        admissionId: tainted.replyAdmissionId,
        worker: false,
        messaging: false,
        proposals: [{ recordId: tainted.recordId, admissionId: tainted.admissionId }],
      }),
    ).toEqual([]);
    expect(await tainted.status()).toBe("proposed");
  }, 60_000);

  it("memory invariant 2: a clean admission's proposal waits when a later admission of the turn was tainted or held to messaging, or when its saved turn cannot be read; it is kept by its own words", async () => {
    const ended = (each: Awaited<ReturnType<typeof scene>>, admissionId: string | undefined) =>
      each.auto.afterTurn({
        workspaceId: "default",
        principalId: "operator",
        runId: each.taskId,
        admissionId: each.replyAdmissionId,
        worker: false,
        messaging: false,
        proposals: [{ recordId: each.recordId, admissionId }],
      });
    for (const [what, extra] of [
      ["tainted", { tainted: true }],
      ["messaging", { channel: "messaging" }],
    ] as const) {
      const later = await scene({});
      await later.reply("thanks, that's all", extra);
      expect(await ended(later, later.admissionId), what).toEqual([]);
      expect(await later.status(), what).toBe("proposed");
    }
    const unknown = await scene({});
    await unknown.reply("thanks, that's all");
    expect(await ended(unknown, "adm-never-saved")).toEqual([]);
    expect(await ended(unknown, undefined)).toEqual([]);
    expect(await unknown.status()).toBe("proposed");
    // Its own admission's words count, not the reply's that ended the turn.
    const own = await scene({});
    await own.reply("thanks, that's all");
    expect(await ended(own, own.admissionId)).toEqual([own.recordId]);
  }, 120_000);

  it("memory invariant 2: a bound channel user's proposal is never kept without asking, whatever the setting", async () => {
    const alice = await scene({ principalId: "alice" });
    expect(
      await alice.auto.afterTurn({
        workspaceId: "default",
        principalId: "alice",
        runId: alice.taskId,
        admissionId: `adm-${alice.taskId}`,
        worker: false,
        messaging: false,
        proposals: [{ recordId: alice.recordId, admissionId: alice.admissionId }],
      }),
    ).toEqual([]);
    expect(await alice.status()).toBe("proposed");
  }, 60_000);

  it("after an idle review: a person-sourced draft is kept; an assistant-sourced one, and one claiming the person's words that no person message holds, wait", async () => {
    const kept = await scene({ author: "provider:tavi.memory:capture" });
    const review = {
      workspaceId: "default",
      principalId: "operator",
      taskId: kept.taskId,
      personMessages: ["I'm vegetarian and cook at home, honestly"],
    };
    expect(await kept.auto.afterReview({ ...review, filed: [{ recordId: kept.recordId, from: "person" }] })).toEqual([kept.recordId]);
    const assistant = await scene({ author: "provider:tavi.memory:capture" });
    expect(
      await assistant.auto.afterReview({
        ...review,
        taskId: assistant.taskId,
        filed: [{ recordId: assistant.recordId, from: "assistant" }],
      }),
    ).toEqual([]);
    const claimed = await scene({ author: "provider:tavi.memory:capture" });
    expect(
      await claimed.auto.afterReview({
        ...review,
        taskId: claimed.taskId,
        personMessages: ["what should I cook tonight?"],
        filed: [{ recordId: claimed.recordId, from: "person" }],
      }),
    ).toEqual([]);
    expect([await assistant.status(), await claimed.status()]).toEqual(["proposed", "proposed"]);
  }, 120_000);

  it("memory invariant 2: a fact akin to a kept one of its kind (a likely contradiction, no topic key) waits with its card; by words, or by meaning under hybrid", async () => {
    const said = "I live in Berlin with two cats";
    const body = "The person lives in Berlin with two cats.";
    const title = "Lives in Berlin";
    // Alone, it is kept.
    const alone = await scene({ said, title, body });
    expect(await endTurn(alone)).toEqual([alone.recordId]);
    // Beside a kept "Lisbon": the words differ by one, under the near match but akin (Jaccard ≥ 0.5).
    const beside = await scene({ said, title, body, kept: { body: "The person lives in Lisbon with two cats." } });
    expect(await endTurn(beside)).toEqual([]);
    expect(await beside.status()).toBe("proposed");
    // No word shared, but close in meaning (cosine 0.8) under hybrid; with no draft vector, by words alone, it is kept.
    const meaning = await scene({
      said,
      title,
      body,
      kept: { body: "Her home is the Portuguese capital", vector: [1, 0, 0, 0] },
      draftVector: [0.8, 0.6, 0, 0],
    });
    expect(await endTurn(meaning)).toEqual([]);
    expect(await meaning.status()).toBe("proposed");
    const far = await scene({
      said,
      title,
      body,
      kept: { body: "Her home is the Portuguese capital", vector: [1, 0, 0, 0] },
      draftVector: [0.5, 0.86, 0, 0],
    });
    expect(await endTurn(far)).toEqual([far.recordId]);
  }, 120_000);

  it("memory invariant 2: the kinds ticked when the proposal was filed and at the turn's end, whichever is stricter; the review note names the revision it was filed under", async () => {
    // Ticked when filed, unticked by the turn's end: it waits.
    const unticked = await scene({});
    const filed = (await unticked.repositories.workspaceSettings.get("default")).revision;
    await unticked.settle({});
    expect(await endTurn(unticked, { kinds: ["fact"], revision: filed })).toEqual([]);
    expect(await unticked.status()).toBe("proposed");
    // Not ticked when filed (or unreadable), ticked by the end: it waits too.
    const late = await scene({});
    expect(await endTurn(late, null)).toEqual([]);
    expect(await endTurn(late, { kinds: ["lesson"], revision: 1 })).toEqual([]);
    expect(await late.status()).toBe("proposed");
    // Ticked at both: kept, under the revision it was filed under.
    const both = await scene({});
    const at = (await both.repositories.workspaceSettings.get("default")).revision;
    await both.settle({ autoApprove: ["fact", "lesson"] });
    expect(await endTurn(both, { kinds: ["fact"], revision: at })).toEqual([both.recordId]);
    const got = await both.ipc<MemoryGetAnswer>({ action: "get", recordId: both.recordId });
    expect(got.reviews).toEqual([expect.objectContaining({ decision: "approved", reason: `auto-approve (settings revision ${at})` })]);
  }, 120_000);

  it("memory invariant 2: a flush's or consolidation's proposal is never kept, even handed in as a turn's", async () => {
    for (const author of ["epoch-flush:e2", "provider:tavi.memoryprovider:consolidate"]) {
      const handed = await scene({ author });
      expect(
        await handed.auto.afterTurn({
          workspaceId: "default",
          principalId: "operator",
          runId: handed.taskId,
          admissionId: `adm-${handed.taskId}`,
          worker: false,
          messaging: false,
          proposals: [{ recordId: handed.recordId, admissionId: handed.admissionId }],
        }),
        author,
      ).toEqual([]);
      expect(await handed.status(), author).toBe("proposed");
    }
  }, 120_000);
});
