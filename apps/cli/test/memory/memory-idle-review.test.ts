import {
  BUILTIN_MEMORY_PROVIDER_ID,
  effectiveMemorySettings,
  memoryReviewFailureMark,
  type ChatKind,
  type ChatMemoryMode,
  type EffectiveMemorySettings,
  type ModelPort,
  type ModelRequest,
  type TaskOrigin,
  type TranscriptTurn,
  memoryDigestOf,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createBuiltinMemoryProvider } from "@tavi/plugin-defaults/memory";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { MEMORY_REVIEW_ATTEMPT_PREFIX } from "@tavi/agent-host/workflow";
import { MEMORY_REVIEW_MARKER } from "@tavi/plugin-kit/memory";
import { DatabaseClient, MemoryService } from "@tavi/runtime";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { createMemoryAutoApprove } from "../../src/features/memory/auto-approve.js";
import { createMemoryCards } from "../../src/features/memory/cards.js";
import { memoryChatOf } from "../../src/features/memory/digest.js";
import { createMemoryIdleReview, memoryIdleReviewDoctor } from "../../src/features/memory/idle-review.js";
import { buildDoctorDocument } from "../../src/features/doctor/reports.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The idle review on the `tavi.memory` tick: a quiet chat's new substantive messages are read once, on
 * the extraction role, through the capture pipeline, into one card; never a
 * messaging, group, memory-off, private, worker or heartbeat chat, never a
 * tainted turn, never history from before the upgrade; bounded per tick and
 * per person per day, with failures backed off and skipped after three.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-10-11T08:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const REVIEW_ANSWER = JSON.stringify({
  memories: [
    { kind: "fact", title: "Home city", body: "The person lives in Lisbon.", scope: "everywhere" },
    { kind: "preference", body: "Replies in English", key: "reply.language", value: "en" },
  ],
});

/** A model that answers reviews with `answer` (or throws it) and anything else with "Done."; each review call is kept. */
function scriptedModel(answer: () => string | Error = () => REVIEW_ANSWER) {
  const reviews: { readonly request: ModelRequest; readonly keepRequest: unknown }[] = [];
  const model: ModelPort = {
    async stream(request, options) {
      if (request.attemptId.startsWith(MEMORY_REVIEW_ATTEMPT_PREFIX)) {
        reviews.push({ request, keepRequest: options.keepRequest });
        const text = answer();
        if (text instanceof Error) throw text;
        return { attemptId: request.attemptId, status: "completed", text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
      }
      return {
        attemptId: request.attemptId,
        status: "completed",
        text: "Done.",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };
  return { model, reviews };
}

const SIX = [
  "I moved to Lisbon last spring with my family",
  "I work as a backend engineer at a fintech startup",
  "Please always answer me in English, never Portuguese",
  "My team ships releases every second Thursday afternoon",
  "I prefer concise bullet points over long paragraphs",
  "Remind me that the quarterly planning starts in November",
];

async function fixture(input: { readonly settings?: Partial<EffectiveMemorySettings> } = {}) {
  const store = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  closers.push(() => store.close());
  const repositories = store.asPort().repositories;
  let ids = 0;
  const memory = new MemoryService(store.asPort(), { now: () => clock.now.toISOString(), newId: (prefix) => `${prefix}-${(ids += 1)}` });
  const clock = { now: T0 };
  const logs: { readonly message: string; readonly fields: Record<string, unknown> }[] = [];
  const cards = createMemoryCards({ repositories, newId: () => `notice-${(ids += 1)}`, now: () => clock.now.toISOString(), log: () => {} });
  const settings: EffectiveMemorySettings = { ...effectiveMemorySettings(undefined), ...input.settings };
  /** A chat of the operator's, as the canvas starts one unless told otherwise. */
  const chat = async (
    id: string,
    extra: {
      readonly origin?: TaskOrigin;
      readonly chatKind?: ChatKind;
      readonly memoryMode?: ChatMemoryMode;
      readonly principalId?: string;
      readonly workspaceId?: string;
      readonly parentChatId?: string;
    } = {},
  ) =>
    (
      await repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: extra.workspaceId ?? "default",
        principalId: extra.principalId ?? "operator",
        operationKey: id,
        kind: "start",
        intent: { prompt: id },
        checkpointNamespace: "",
        origin: extra.origin ?? "web",
        ...(extra.origin === "schedule" ? { originScheduleId: `schedule-${id}` } : {}),
        ...(extra.parentChatId === undefined ? {} : { parentChatId: extra.parentChatId }),
        ...(extra.chatKind === undefined ? {} : { chatKind: extra.chatKind }),
        ...(extra.memoryMode === undefined ? {} : { memoryMode: extra.memoryMode }),
        now: T0.toISOString(),
        newTaskId: id,
        newThreadId: `thread-${id}`,
        newAdmissionId: `admission-${id}`,
      })
    ).task.taskId;
  /** Saved turns, one per prompt, saved at `when`. */
  const say = async (taskId: string, prompts: readonly string[], when: Date, extra: Partial<TranscriptTurn> = {}) => {
    for (const prompt of prompts) {
      await repositories.transcripts.append({
        taskId,
        turn: {
          admissionKind: "reply",
          prompt,
          items: [],
          outcome: { status: "completed", finalText: `Noted: ${prompt.slice(0, 20)}` },
          ...extra,
        },
        createdAt: when.toISOString(),
      });
    }
  };
  const job = (model: ModelPort, startedAt: Date = T0, overrides: Partial<Parameters<typeof createMemoryIdleReview>[0]> = {}) =>
    createMemoryIdleReview({
      models: model,
      memory,
      repositories,
      workspaces: () => [{ workspaceId: "default" }],
      memorySettings: async () => settings,
      timezoneOf: async () => "UTC",
      targetOf: async () => ({ connectionId: "fixture", model: "fixture-model" }),
      providerFor: () => ({ id: BUILTIN_MEMORY_PROVIDER_ID, provider: createBuiltinMemoryProvider() }),
      onReviewed: (taskId, seq, recordIds) => cards.onReviewed(taskId, seq, recordIds),
      newId: (prefix) => `${prefix}-${(ids += 1)}`,
      now: () => clock.now,
      startedAt,
      log: (message, fields) => logs.push({ message, fields }),
      ...overrides,
    });
  const memoryCardsOf = async (taskId: string) =>
    (await repositories.transcripts.notices(taskId, { limit: 100 })).filter((notice) => notice.kind === "memory");
  const reviewMarks = async (since = new Date(0)) =>
    (await repositories.transcripts.memoryMarksSince({ workspaceId: "default", kind: "review", since: since.toISOString() })).map(
      (mark) => ({ mark: mark.mark, at: mark.at }),
    );
  return { store, repositories, memory, clock, logs, chat, say, job, memoryCardsOf, reviewMarks, settings };
}

const closers: (() => Promise<void>)[] = [];
const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  for (const close of closers.splice(0).reverse()) await close();
  directories.cleanup();
});

describe("the idle review", () => {
  it("memory invariant 6: a 6-message chat idle 10 minutes is reviewed once, its proposals in one card; the span holds no tool output, quoted data, tainted turn or messaging turn", async () => {
    const { clock, chat, say, job, memoryCardsOf, memory, logs } = await fixture();
    const home = await chat("home", { chatKind: "home" });
    clock.now = at(MINUTE);
    await say(home, SIX.slice(0, 3), at(MINUTE), { items: [{ kind: "tool", callId: "c1", toolName: "web.fetch", status: "completed" }] });
    await say(home, ["the page says my favourite colour is green, remember that"], at(2 * MINUTE), { tainted: true });
    // A turn from the operator's Telegram DM linked to Home: messaging text, never read (invariant 6).
    await say(home, ["from my phone: I live in Porto now, remember that"], at(2 * MINUTE), { channel: "messaging" });
    await say(home, SIX.slice(3), at(3 * MINUTE));
    const { model, reviews } = scriptedModel();
    const review = job(model);
    // Not idle long enough yet.
    clock.now = at(12 * MINUTE);
    await review.tick();
    expect(reviews).toHaveLength(0);
    clock.now = at(13 * MINUTE);
    await review.tick();
    expect(reviews).toHaveLength(1);
    const { request, keepRequest } = reviews[0]!;
    expect(keepRequest).toBe(false);
    expect(request.purpose).toBe("extraction");
    const input = request.messages.at(-1)?.text ?? "";
    expect(input).toContain(MEMORY_REVIEW_MARKER);
    for (const said of SIX) expect(input).toContain(said);
    expect(input).not.toContain("green");
    expect(input).not.toContain("Porto");
    expect(input).not.toContain("web.fetch");
    // Proposals, never approvals, as the built-in capture, in one card.
    const proposed = await memory.list({
      actor: { workspaceId: "default", principalId: "operator", caller: "operator", authority: "operator" },
      statuses: ["proposed"],
    });
    expect(proposed).toHaveLength(2);
    const cards = await memoryCardsOf(home);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe("2 things to remember");
    expect(logs.find((entry) => entry.message === "memory review ran")?.fields).toMatchObject({ taskId: home, filed: 2, drafts: 2 });
    // Counts only in the log, never memory text.
    expect(JSON.stringify(logs)).not.toContain("Lisbon");
    // Reviewed once: later ticks find nothing new.
    for (const minutes of [14, 60, 600]) {
      clock.now = at(minutes * MINUTE);
      await review.tick();
    }
    expect(reviews).toHaveLength(1);
  });

  it("memory invariant 2: with Facts kept without asking, a review keeps a fact in the person's own words before its card, and leaves the rest waiting", async () => {
    const { clock, chat, say, job, memory, repositories, memoryCardsOf } = await fixture();
    const revision = (
      await repositories.workspaceSettings.set({
        workspaceId: "default",
        settings: { memory: { autoApprove: ["fact"] } },
        expectedRevision: 0,
        actor: "operator:cli",
        now: T0.toISOString(),
      })
    ).revision;
    const home = await chat("home", { chatKind: "home" });
    clock.now = at(MINUTE);
    await say(home, SIX, at(MINUTE));
    const { model } = scriptedModel(() =>
      JSON.stringify({
        memories: [
          { kind: "fact", title: "Moved to Lisbon", body: "The person moved to Lisbon last spring.", scope: "everywhere", from: "person" },
          { kind: "fact", title: "Team", body: "The team uses Kotlin and Postgres.", scope: "everywhere", from: "assistant" },
          { kind: "preference", body: "Replies in English", key: "reply.language", value: "English" },
        ],
      }),
    );
    const auto = createMemoryAutoApprove({ memory, repositories, operatorOf: () => "operator", log: () => {} });
    clock.now = at(20 * MINUTE);
    await job(model, T0, { autoApprove: auto }).tick();
    const operator = { workspaceId: "default", principalId: "operator", caller: "operator", authority: "operator" as const };
    const approved = await memory.list({ actor: operator, statuses: ["approved"] });
    expect(approved).toHaveLength(1);
    const { reviews } = await memory.history({ actor: operator, recordId: approved[0]!.recordId });
    expect(reviews.map((review) => review.reason)).toEqual([`auto-approve (settings revision ${revision})`]);
    // The assistant's draft and the preference (not ticked) wait; the card holds all three, the kept one Saved.
    expect(await memory.list({ actor: operator, statuses: ["proposed"] })).toHaveLength(2);
    expect(await memoryCardsOf(home)).toHaveLength(1);
  });

  it("a chat that runs as an agent is reviewed as that agent: its own memory is among what is already kept", async () => {
    const { clock, chat, say, job, memory } = await fixture();
    const agentScope = { kind: "personal_agent", principalId: "operator", workspaceId: "default", agentId: "planner" } as const;
    memory.remember({
      actor: { principalId: "operator", workspaceId: "default", agentId: "planner", caller: "cli", authority: "operator" },
      scope: agentScope,
      kind: "fact",
      title: "Planner sprint length",
      body: "Sprints last two weeks",
    });
    const home = await chat("home", { chatKind: "home" });
    clock.now = at(MINUTE);
    await say(home, SIX, at(MINUTE));
    const asAgent = scriptedModel();
    clock.now = at(13 * MINUTE);
    await job(asAgent.model, T0, { agentOf: async (_workspaceId, taskId) => (taskId === home ? "planner" : undefined) }).tick();
    expect(asAgent.reviews[0]?.request.messages.at(-1)?.text ?? "").toContain("Planner sprint length");
  });

  it("a chat with no agent is not told an agent's memory", async () => {
    const { clock, chat, say, job, memory } = await fixture();
    memory.remember({
      actor: { principalId: "operator", workspaceId: "default", agentId: "planner", caller: "cli", authority: "operator" },
      scope: { kind: "personal_agent", principalId: "operator", workspaceId: "default", agentId: "planner" },
      kind: "fact",
      title: "Planner sprint length",
      body: "Sprints last two weeks",
    });
    const home = await chat("home", { chatKind: "home" });
    clock.now = at(MINUTE);
    await say(home, SIX, at(MINUTE));
    const plain = scriptedModel();
    clock.now = at(13 * MINUTE);
    await job(plain.model).tick();
    expect(plain.reviews).toHaveLength(1);
    expect(plain.reviews[0]?.request.messages.at(-1)?.text ?? "").not.toContain("Planner sprint length");
  });

  it("memory invariant 17: a restart does not review the same span again, and the next span is its own", async () => {
    const { clock, chat, say, job } = await fixture();
    const home = await chat("home", { chatKind: "home" });
    await say(home, SIX, at(MINUTE));
    const first = scriptedModel();
    clock.now = at(20 * MINUTE);
    await job(first.model).tick();
    expect(first.reviews).toHaveLength(1);
    // A new owner, started later: the chat's mark is durable.
    const second = scriptedModel();
    const restarted = job(second.model, at(30 * MINUTE));
    clock.now = at(40 * MINUTE);
    await restarted.tick();
    expect(second.reviews).toHaveLength(0);
    // Three new substantive messages make it due again, and only they are read.
    await say(
      home,
      ["I started learning the piano this autumn", "My daughter Maria turns ten in December", "I drink my coffee black with no sugar"],
      at(41 * MINUTE),
    );
    clock.now = at(52 * MINUTE);
    await restarted.tick();
    expect(second.reviews).toHaveLength(1);
    const input = second.reviews[0]!.request.messages.at(-1)?.text ?? "";
    expect(input).toContain("piano");
    expect(input).not.toContain("Lisbon");
  });

  it('memory invariant 5: never reviews a messaging, group, memory-off, private, worker, run, heartbeat, schedule or agent chat; "ok", "thanks", "done" are not due, three 12-character Japanese sentences are', async () => {
    const { clock, chat, say, job } = await fixture();
    const reviewed = new Set<string>();
    const { model, reviews } = scriptedModel();
    const chats = {
      messaging: await chat("messaging", { origin: "messaging" }),
      // A group conversation's Home: messaging too, whatever its kind (invariant 6).
      group: await chat("group", { origin: "messaging", chatKind: "home" }),
      schedule: await chat("schedule", { origin: "schedule" }),
      agent: await chat("agent", { origin: "agent" }),
      off: await chat("off", { memoryMode: "off" }),
      private: await chat("private", { memoryMode: "private" }),
      worker: await chat("worker", { origin: "agent", chatKind: "worker" }),
      run: await chat("run", { origin: "cli", chatKind: "run" }),
      heartbeat: await chat("heartbeat", { origin: "heartbeat" }),
      reminder: await chat("reminder", { origin: "reminder" }),
      polite: await chat("polite"),
      japanese: await chat("japanese"),
    };
    for (const sentence of ["明日東京で会議があります", "毎朝六時に起きて走ります", "猫二匹と犬一匹を飼います"])
      expect([...sentence]).toHaveLength(12);
    for (const [name, taskId] of Object.entries(chats)) {
      if (name === "polite") await say(taskId, ["ok", "thanks", "done", "ありがとうございます"], at(MINUTE));
      else if (name === "japanese")
        await say(taskId, ["明日東京で会議があります", "毎朝六時に起きて走ります", "猫二匹と犬一匹を飼います"], at(MINUTE));
      else await say(taskId, SIX, at(MINUTE));
    }
    const review = job(model);
    for (let tick = 0; tick < 12; tick += 1) {
      clock.now = at((20 + tick) * MINUTE);
      const before = reviews.length;
      await review.tick();
      if (reviews.length > before) reviewed.add(reviews.at(-1)!.request.runId);
    }
    expect([...reviewed]).toEqual([chats.japanese]);
  });

  it("memory invariant 5: a side chat, and one nested in it, that talked while its parent was off is not reviewed then, and once the parent is back on its span starts then; nor is it the digest's chat meanwhile", async () => {
    const { clock, chat, say, job, repositories } = await fixture();
    const parent = await chat("parent");
    const side = await chat("side", { chatKind: "side", parentChatId: parent });
    const nested = await chat("nested", { chatKind: "side", parentChatId: side });
    await repositories.tasks.setMemoryMode({ taskId: parent, mode: "off", now: T0.toISOString() });
    await say(side, SIX, at(MINUTE));
    await say(nested, SIX, at(MINUTE));
    const { model, reviews } = scriptedModel();
    const review = job(model);
    for (let tick = 0; tick < 4; tick += 1) {
      clock.now = at((20 + tick) * MINUTE);
      await review.tick();
    }
    expect(reviews).toHaveLength(0);
    // The digest's fallback chat is read by the same query: not a side chat of an off chat either.
    expect(
      await memoryChatOf(repositories, { workspaceId: "default", principalId: "operator", operator: true, now: clock.now }),
    ).toBeUndefined();
    // Back on: each is a review chat again, its span from when the parent was turned on, so what it said
    // meanwhile is never read (only turns admitted from `memoryOnAt` are, as the composed test below shows).
    const onAt = at(30 * MINUTE).toISOString();
    await repositories.tasks.setMemoryMode({ taskId: parent, mode: "on", now: onAt });
    const found = await repositories.transcripts.memoryReviewChats({ workspaceId: "default", savedBefore: T0.toISOString() });
    expect(
      found.filter((entry) => entry.taskId === side || entry.taskId === nested).map((entry) => [entry.taskId, entry.memoryOnAt]),
    ).toEqual(
      expect.arrayContaining([
        [side, onAt],
        [nested, onAt],
      ]),
    );
    for (let tick = 0; tick < 4; tick += 1) {
      clock.now = at((45 + tick) * MINUTE);
      await review.tick();
    }
    // Their saved turns were all admitted before then: nothing is read.
    expect(reviews).toHaveLength(0);
  });

  it("memory invariant 24: the daily cap holds — a provider that always throws is called at most 24 times a day — and a span failing three times is skipped and shown in doctor", async () => {
    const { clock, chat, say, job } = await fixture();
    for (let index = 0; index < 30; index += 1) {
      const taskId = await chat(`chat-${index}`);
      await say(taskId, SIX, at(MINUTE));
    }
    const { model, reviews } = scriptedModel(() => new Error("provider down"));
    const review = job(model);
    // A day of ticks, one a minute.
    for (let minute = 20; minute < 20 + 24 * 60; minute += 1) {
      clock.now = at(minute * MINUTE);
      await review.tick();
    }
    expect(reviews).toHaveLength(24);
    // At most one call a tick, never two in the same minute.
    expect(new Set(reviews.map((entry) => entry.request.messages[0]?.createdAt)).size).toBe(24);

    // One chat alone: retried no sooner than an hour, and skipped after its third failure.
    const lone = await fixture();
    const home = await lone.chat("home", { chatKind: "home" });
    await lone.say(home, SIX, at(MINUTE));
    const failing = scriptedModel(() => new Error("provider down"));
    const single = lone.job(failing.model);
    for (let minute = 20; minute < 20 + 5 * 60; minute += 1) {
      lone.clock.now = at(minute * MINUTE);
      await single.tick();
    }
    expect(failing.reviews).toHaveLength(3);
    const marks = await lone.reviewMarks();
    expect(marks.map((mark) => mark.mark).sort()).toEqual(
      [
        "r0000000000;seed",
        "r0000000006;skipped",
        memoryReviewFailureMark(0, 1),
        memoryReviewFailureMark(0, 2),
        memoryReviewFailureMark(0, 3),
      ].sort(),
    );
    const failures = marks
      .filter((mark) => mark.mark.startsWith("x"))
      .map((mark) => Date.parse(mark.at))
      .sort();
    expect(failures[1]! - failures[0]!).toBeGreaterThanOrEqual(HOUR);
    expect(failures[2]! - failures[1]!).toBeGreaterThanOrEqual(HOUR);
    const doctor = memoryIdleReviewDoctor({
      capture: "suggest",
      month: marks,
      todaySince: T0.toISOString(),
      spend: { calls: 3, failed: 3, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 },
    });
    expect(doctor).toMatchObject({ capture: "suggest", lastReview: null, today: { reviews: 0, failures: 3, skipped: 1, filed: 0 } });
    expect(lone.logs.some((entry) => entry.message === "a memory review failed three times; its span is skipped")).toBe(true);
  }, 120_000);

  it("memory invariant 24: the daily cap is per person, not per workspace — one person's chats in two workspaces are reviewed at most 24 times a day in all, and another person's still go", async () => {
    const { clock, chat, say, job } = await fixture();
    const owners = new Map<string, string>();
    for (let index = 0; index < 30; index += 1) {
      const taskId = await chat(`chat-${index}`, { workspaceId: index % 2 === 0 ? "default" : "second" });
      owners.set(taskId, "operator");
      await say(taskId, SIX, at(MINUTE));
    }
    const other = await chat("other-home", { principalId: "someone-else" });
    owners.set(other, "someone-else");
    // Said later, so it is idle the shortest and waits behind the operator's chats.
    await say(other, SIX, at(5 * MINUTE));
    const { model, reviews } = scriptedModel(() => new Error("provider down"));
    const review = job(model, T0, { workspaces: () => [{ workspaceId: "default" }, { workspaceId: "second" }] });
    for (let minute = 20; minute < 20 + 24 * 60; minute += 1) {
      clock.now = at(minute * MINUTE);
      await review.tick();
    }
    const reviewedTask = (entry: (typeof reviews)[number]) => entry.request.runId;
    const byOperator = reviews.filter((entry) => owners.get(reviewedTask(entry) ?? "") === "operator");
    expect(byOperator).toHaveLength(24);
    expect(reviews.length - byOperator.length).toBeGreaterThan(0);
  }, 120_000);

  it("ten chats due at once, as after a machine slept for 8 hours, are reviewed one a tick, idle longest first", async () => {
    const { clock, chat, say, job } = await fixture();
    const order: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const taskId = await chat(`chat-${index}`);
      order.push(taskId);
      // Newest saved later for each next chat: chat-0 has been idle longest.
      await say(taskId, SIX, at((index + 1) * MINUTE));
    }
    const { model, reviews } = scriptedModel();
    const review = job(model);
    clock.now = at(8 * HOUR);
    for (let tick = 0; tick < 12; tick += 1) {
      const before = reviews.length;
      await review.tick();
      expect(reviews.length - before).toBeLessThanOrEqual(1);
      clock.now = new Date(clock.now.getTime() + MINUTE);
    }
    expect(reviews.map((entry) => entry.request.runId)).toEqual(order);
  });

  it("memory invariant 23: a directory from before the idle review with 50 idle chats — the first ticks review none of them, and only what is said after", async () => {
    const { clock, chat, say, job, reviewMarks } = await fixture();
    const chats: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const taskId = await chat(`old-${index}`);
      chats.push(taskId);
      // Saved before the upgrade: no taint mark, never to be reviewed.
      await say(taskId, SIX, at(MINUTE));
    }
    const { model, reviews } = scriptedModel();
    // The owner with this step starts a day later.
    const review = job(model, at(24 * HOUR));
    for (let tick = 0; tick < 5; tick += 1) {
      clock.now = at(24 * HOUR + tick * MINUTE);
      await review.tick();
    }
    expect(reviews).toHaveLength(0);
    expect((await reviewMarks()).filter((mark) => mark.mark === "r0000000006;seed")).toHaveLength(50);
    // What one of them says after the upgrade is reviewed, and only that.
    await say(
      chats[7]!,
      ["I started learning the piano this autumn", "My daughter Maria turns ten in December", "I drink my coffee black with no sugar"],
      at(24 * HOUR + 10 * MINUTE),
    );
    clock.now = at(24 * HOUR + 30 * MINUTE);
    await review.tick();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.request.runId).toBe(chats[7]);
    expect(reviews[0]!.request.messages.at(-1)?.text).not.toContain("Lisbon");
  });

  it("while learning from chats is off, a quiet chat's words are passed over for good, and none is reviewed", async () => {
    const off = await fixture({ settings: { capture: "off" } });
    const home = await off.chat("home", { chatKind: "home" });
    await off.say(home, SIX, at(MINUTE));
    const { model, reviews } = scriptedModel();
    off.clock.now = at(20 * MINUTE);
    await off.job(model).tick();
    await off.job(model).tick();
    expect(reviews).toHaveLength(0);
    expect((await off.reviewMarks()).map((mark) => mark.mark)).toEqual(expect.arrayContaining(["r0000000000;seed", "r0000000006;seed"]));
  });

  it("memory invariant 13: while memory is paused, an idle tick calls no model and files nothing, and a quiet chat's words are passed over for good", async () => {
    const paused = await fixture({ settings: { enabled: false } });
    const home = await paused.chat("home", { chatKind: "home" });
    await paused.say(home, SIX, at(MINUTE));
    const { model, reviews } = scriptedModel();
    for (const minutes of [20, 21, 90]) {
      paused.clock.now = at(minutes * MINUTE);
      await paused.job(model).tick();
    }
    expect(reviews).toHaveLength(0);
    expect(
      await paused.memory.list({
        actor: { workspaceId: "default", principalId: "operator", caller: "operator", authority: "operator" },
        statuses: ["proposed", "approved"],
      }),
    ).toEqual([]);
    expect(await paused.memoryCardsOf(home)).toEqual([]);
    expect((await paused.reviewMarks()).map((mark) => mark.mark)).toEqual(expect.arrayContaining(["r0000000006;seed"]));
  });

  it("a review whose span was claimed and then failed writes no failure mark, so it counts once toward the day's cap (invariant 24)", async () => {
    const { clock, chat, say, job, repositories, reviewMarks, logs } = await fixture();
    const home = await chat("home", { chatKind: "home" });
    await say(home, SIX, at(MINUTE));
    const { model, reviews } = scriptedModel();
    // The mark that records what the review filed cannot be written.
    const transcripts = {
      ...repositories.transcripts,
      claimMemoryMark: async (input: Parameters<typeof repositories.transcripts.claimMemoryMark>[0]) => {
        if (input.mark.includes("filed=")) throw new Error("disk full");
        return await repositories.transcripts.claimMemoryMark(input);
      },
    };
    clock.now = at(20 * MINUTE);
    await job(model, T0, { repositories: { ...repositories, transcripts } }).tick();
    expect(reviews).toHaveLength(1);
    expect((await reviewMarks()).map((mark) => mark.mark).sort()).toEqual(["r0000000000;seed", "r0000000006"]);
    expect(
      logs.some((entry) => entry.message === "a memory review failed after its span was claimed; the span is not reviewed again"),
    ).toBe(true);
  });

  it("logs a failed review's reason cut to 200 characters, so a provider's error quoting its input never reaches the log whole", async () => {
    const { clock, chat, say, job, logs } = await fixture();
    const home = await chat("home", { chatKind: "home" });
    await say(home, SIX, at(MINUTE));
    const { model } = scriptedModel(() => new Error(`bad request: ${"x".repeat(300)} I moved to Lisbon last spring`));
    clock.now = at(20 * MINUTE);
    await job(model).tick();
    const failed = logs.find((entry) => entry.message === "a memory review failed; it is tried again in an hour");
    expect(String(failed?.fields["reason"]).length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(logs)).not.toContain("Lisbon");
  });

  it('memory invariant 7: a review\'s sensitive draft is dropped under sensitive: "skip" and filed marked sensitive under "suggest"', async () => {
    const HEALTH = JSON.stringify({
      memories: [
        { kind: "fact", title: "Allergy", body: "The person is allergic to penicillin." },
        { kind: "fact", title: "Works from Porto", body: "The person works from Porto." },
      ],
    });
    for (const sensitive of ["skip", "suggest"] as const) {
      const { clock, chat, say, job, memory, logs } = await fixture({ settings: { sensitive } });
      const home = await chat("home", { chatKind: "home" });
      await say(home, SIX, at(MINUTE));
      clock.now = at(20 * MINUTE);
      await job(scriptedModel(() => HEALTH).model).tick();
      const proposed = await memory.list({
        actor: { workspaceId: "default", principalId: "operator", caller: "operator", authority: "operator" },
        statuses: ["proposed"],
      });
      // The model marked neither: the pipeline finds the health statement itself.
      const sensitivities = proposed.map((record) => record.sensitivity).sort();
      if (sensitive === "skip") {
        expect(sensitivities).toEqual(["normal"]);
        expect(logs.find((entry) => entry.message === "memory review ran")?.fields).toMatchObject({ filed: 1, droppedSensitive: 1 });
      } else {
        expect(sensitivities).toEqual(["normal", "sensitive"]);
        expect(logs.find((entry) => entry.message === "memory review ran")?.fields).toMatchObject({ filed: 2, droppedSensitive: 0 });
      }
    }
  });

  it("a near duplicate of a record in force is dropped, never on the card, and recorded in the review's log line", async () => {
    const { clock, chat, say, job, memory, memoryCardsOf, logs } = await fixture();
    const operator = { workspaceId: "default", principalId: "operator", caller: "operator", authority: "operator" as const };
    await memory.remember({
      actor: operator,
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "The person lives in Lisbon, Portugal.",
    });
    const home = await chat("home", { chatKind: "home" });
    await say(home, SIX, at(MINUTE));
    clock.now = at(20 * MINUTE);
    await job(scriptedModel().model).tick();
    // The preference is filed; the near duplicate of the kept fact is not.
    expect(await memory.list({ actor: operator, statuses: ["proposed"] })).toHaveLength(1);
    expect((await memoryCardsOf(home)).map((card) => card.title)).toEqual(["1 thing to remember"]);
    expect(logs.find((entry) => entry.message === "memory review ran")?.fields).toMatchObject({
      taskId: home,
      drafts: 2,
      filed: 1,
      droppedSimilar: 1,
      droppedKnown: 0,
    });
  });

  it("a chat with no model it may use is looked at again after the retry interval, so a model bound meanwhile reviews it without a new turn", async () => {
    const { clock, chat, say, job, logs } = await fixture();
    const home = await chat("home", { chatKind: "home" });
    await say(home, SIX, at(MINUTE));
    const { model, reviews } = scriptedModel();
    let target: { readonly connectionId: string; readonly model: string } | undefined;
    const review = job(model, T0, { targetOf: async () => target });
    clock.now = at(20 * MINUTE);
    await review.tick();
    await review.tick();
    expect(reviews).toHaveLength(0);
    // Parked: logged once, not on every tick.
    expect(logs.filter((entry) => entry.message.startsWith("a memory review has no model"))).toHaveLength(1);
    target = { connectionId: "fixture", model: "fixture-model" };
    clock.now = at(30 * MINUTE);
    await review.tick();
    expect(reviews).toHaveLength(0);
    clock.now = at(20 * MINUTE + HOUR);
    await review.tick();
    expect(reviews).toHaveLength(1);
  });

  it("passes a workspace's span by when no provider drafts proposals (the built-in disabled), and calls no model", async () => {
    for (const provider of [undefined, { id: "acme.memory", provider: {} }]) {
      const { clock, chat, say, job, reviewMarks, logs } = await fixture();
      const home = await chat("home", { chatKind: "home" });
      await say(home, SIX, at(MINUTE));
      const { model, reviews } = scriptedModel();
      clock.now = at(20 * MINUTE);
      await job(model, T0, { providerFor: () => provider }).tick();
      expect(reviews).toHaveLength(0);
      // Passed by, as capture off passes it: no failure is counted or retried.
      expect((await reviewMarks()).map((mark) => mark.mark)).not.toContain(memoryReviewFailureMark(0, 1));
      expect(logs.filter((entry) => entry.message === "a memory review failed; it is tried again in an hour")).toHaveLength(0);
    }
  });

  it("passes the owner's stop signal to the review's call, so shutdown does not wait for its timeout", async () => {
    const { clock, chat, say, job, reviewMarks } = await fixture();
    const home = await chat("home", { chatKind: "home" });
    await say(home, SIX, at(MINUTE));
    const stopping = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const model: ModelPort = {
      async stream(request, options) {
        seen.push(options.signal);
        stopping.abort();
        options.signal?.throwIfAborted();
        return { attemptId: request.attemptId, status: "completed", text: REVIEW_ANSWER, toolCalls: [], usage: {} };
      },
    };
    clock.now = at(20 * MINUTE);
    await job(model, T0, { signal: stopping.signal }).tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
    // The aborted call is a failure: retried an hour later.
    expect((await reviewMarks()).map((mark) => mark.mark)).toContain("x0000000000;1");
  });
});

describe("the idle review in the composed owner", () => {
  it("runs on the tavi.memory tick: one card, no request kept in the ledger, doctor's line, a chat turned back on read only from then, and no second review after a restart", async () => {
    const dataDirectory = directories.create("tavi-idle-review-");
    const clock = { now: new Date() };
    const { model, reviews } = scriptedModel();
    const compose = async () => {
      const runtime = await composeTaviRuntime(fixtureRuntimeOptions(dataDirectory, { approvalRequiredFor: [], memoryHostEnabled: true }), {
        modelOverride: model,
        memoryTiming: { tickMs: 20, now: () => clock.now },
      });
      runtimes.push(runtime);
      return runtime;
    };
    const runtime = await compose();
    const workflow =
      runtime.workflow ??
      (() => {
        throw new Error("no workflow");
      })();
    const context = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    const first = await workflow.admit({
      context,
      operationKey: "c-0",
      kind: "start",
      prompt: "I'm vegetarian and I never eat fish or meat",
      origin: "web",
      chatKind: "home",
    });
    const home = first.taskId;
    const repositories = runtime.store.asPort().repositories;
    // Off, then back on: what was said before is never read.
    await repositories.tasks.setMemoryMode({ taskId: home, mode: "off", now: nowTimestamp() });
    await delay(5);
    await repositories.tasks.setMemoryMode({ taskId: home, mode: "on", now: nowTimestamp() });
    await delay(5);
    for (const [index, prompt] of SIX.slice(0, 3).entries()) {
      await workflow.admit({ context, taskId: home, operationKey: `c-${index + 1}`, kind: "reply", prompt });
    }
    // Ten minutes and more of quiet.
    clock.now = new Date(Date.now() + 11 * MINUTE);
    const deadline = Date.now() + 20_000;
    while (reviews.length === 0 && Date.now() < deadline) await delay(20);
    expect(reviews).toHaveLength(1);
    const input = reviews[0]!.request.messages.at(-1)?.text ?? "";
    expect(input).toContain(SIX[0]);
    expect(input).not.toContain("vegetarian");
    // One card in the chat.
    const cardDeadline = Date.now() + 10_000;
    // The review's card: the digest may post its own on the same tick, after 09:00 local.
    const reviewCards = async () =>
      (await repositories.transcripts.notices(home, { limit: 100 })).filter(
        (notice) => notice.kind === "memory" && memoryDigestOf(notice.title) === undefined,
      );
    let cards = await reviewCards();
    while (cards.length === 0 && Date.now() < cardDeadline) {
      await delay(20);
      cards = await reviewCards();
    }
    expect(cards.map((card) => card.title)).toEqual(["2 things to remember"]);
    // The ledger has the call's usage, never its request.
    const attempts = await runtime.modelAccounting.list(home);
    const call = attempts.find((attempt) => attempt.attemptId.startsWith(MEMORY_REVIEW_ATTEMPT_PREFIX));
    expect(call).toMatchObject({ purpose: "extraction", state: "completed" });
    expect(call?.request).toBeUndefined();
    // Doctor: the review's line, counts only.
    const doctor = (await buildDoctorDocument(runtime, { integrity: "skip" })).memory["review"] as Record<string, unknown>;
    expect(doctor).toMatchObject({
      capture: "suggest",
      today: { reviews: 1, filed: 2, failures: 0, skipped: 0, spend: { calls: 1, inputTokens: 10, outputTokens: 5 } },
    });
    expect(typeof doctor["lastReview"]).toBe("string");
    // A restart: many ticks later, still the one review.
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await compose();
    await delay(400);
    expect(reviews).toHaveLength(1);
  }, 60_000);

  it("doctor's review and consolidation lines count every workspace the owner serves, as the jobs run in each", async () => {
    const dataDirectory = directories.create("tavi-idle-review-");
    const permissions = ["tools.invoke", "models.invoke", "runs.create"];
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(dataDirectory, {
        workspaces: [
          { workspaceId: "default", principalId: "operator", permissions },
          { workspaceId: "team", principalId: "teamlead", permissions },
        ],
        approvalRequiredFor: [],
      }),
      { modelOverride: scriptedModel().model },
    );
    runtimes.push(runtime);
    const repositories = runtime.store.asPort().repositories;
    const now = nowTimestamp();
    await repositories.tasks.admit({
      workspaceId: "team",
      principalId: "teamlead",
      operationKey: "team-chat",
      kind: "start",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      origin: "web",
      prompt: { builtin: { text: "Built in", version: "v1" } },
      now,
      newTaskId: "team-chat",
      newThreadId: "team-thread",
      newAdmissionId: "team-admission",
    });
    // A review that ran in the second workspace, and a consolidation failure there.
    await repositories.transcripts.claimMemoryMark({ taskId: "team-chat", kind: "review", mark: "r0000000004", at: now });
    await repositories.transcripts.claimMemoryMark({
      taskId: "team-chat",
      kind: "review",
      mark: "r0000000004;filed=1;secret=0;sensitive=0;known=0;similar=0",
      at: now,
    });
    await repositories.transcripts.claimMemoryMark({ taskId: "team-chat", kind: "consolidate", mark: "x2026-10-12;1", at: now });
    const memory = (await buildDoctorDocument(runtime, { integrity: "skip" })).memory;
    expect(memory["review"]).toMatchObject({ lastReview: now, today: { reviews: 1, filed: 1 } });
    expect(memory["consolidation"]).toMatchObject({ failures: 1 });
  }, 60_000);

  it("a chat that used a local connection is reviewed on that connection, never on a remote extraction role; one with no recorded call is not reviewed", async () => {
    const dataDirectory = directories.create("tavi-idle-review-local-");
    const clock = { now: new Date() };
    const { model, reviews } = scriptedModel();
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(dataDirectory, {
        defaultConnectionId: "ollama",
        defaultModel: "llama3",
        approvalRequiredFor: [],
        memoryHostEnabled: true,
      }),
      { modelOverride: model, memoryTiming: { tickMs: 20, now: () => clock.now } },
    );
    runtimes.push(runtime);
    const models = runtime.store.services.modelConfig;
    await models.putConnection({
      connectionId: "cloud",
      label: "cloud",
      baseUrl: "https://api.example.com/v1",
      credentialRef: "cloud.key",
      defaultModel: "chat",
    });
    await models.putConnection({
      connectionId: "ollama",
      label: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      credentialRef: "ollama.key",
      localOnly: true,
    });
    await models.setRoleBinding({ workspaceId: "default", role: "extraction", target: { connectionId: "cloud", model: "chat" } });
    const workflow =
      runtime.workflow ??
      (() => {
        throw new Error("no workflow");
      })();
    const repositories = runtime.store.asPort().repositories;
    const context = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    // A chat whose turns ran on the local connection.
    const first = await workflow.admit({ context, operationKey: "l-0", kind: "start", prompt: SIX[0]!, origin: "web", chatKind: "home" });
    for (const [index, prompt] of SIX.slice(1, 3).entries())
      await workflow.admit({ context, taskId: first.taskId, operationKey: `l-${index + 1}`, kind: "reply", prompt });
    const used = await runtime.modelAccounting.list(first.taskId);
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((attempt) => attempt.connectionId === "ollama")).toBe(true);
    // A chat with saved turns and no recorded model call: where its words went is unknown.
    const bare = (
      await repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "default",
        principalId: "operator",
        operationKey: "bare",
        kind: "start",
        intent: { prompt: "bare" },
        checkpointNamespace: "",
        origin: "web",
        now: nowTimestamp(),
        newTaskId: "bare",
        newThreadId: "thread-bare",
        newAdmissionId: "admission-bare",
      })
    ).task.taskId;
    for (const prompt of SIX)
      await repositories.transcripts.append({
        taskId: bare,
        turn: { admissionKind: "reply", prompt, items: [], outcome: { status: "completed", finalText: "Noted." } },
        createdAt: nowTimestamp(),
      });
    clock.now = new Date(Date.now() + 11 * MINUTE);
    const deadline = Date.now() + 20_000;
    while (reviews.length === 0 && Date.now() < deadline) await delay(20);
    await delay(400);
    // The local chat went to its own local model; nothing ever went to the remote role, and the bare chat was not reviewed.
    expect(reviews.map((entry) => [entry.request.runId, entry.request.connectionId])).toEqual([[first.taskId, "ollama"]]);
  }, 60_000);
});
