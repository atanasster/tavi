import {
  BUILTIN_MEMORY_PROVIDER_ID,
  effectiveMemorySettings,
  type EffectiveMemorySettings,
  type MemoryReindexAnswer,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { BUILTIN_MEMORY_DECLARATION, createBuiltinMemoryProvider } from "@tavi/plugin-defaults/memory";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { MEMORY_CONSOLIDATION_ATTEMPT_PREFIX, MEMORY_REVIEW_ATTEMPT_PREFIX } from "@tavi/agent-host/workflow";
import { DatabaseClient, MemoryService } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgs } from "../../src/cli/parse.js";
import { EVAL_OWNER_OFF } from "../../src/server/eval-owner.js";
import { main } from "../../src/main.js";
import { createMemoryConsolidation } from "../../src/features/memory/consolidation.js";
import { startMemoryTick } from "../../src/features/memory/digest.js";
import { createMemoryIdleReview } from "../../src/features/memory/idle-review.js";
import { createMemoryJobsSlot, memoryReindexNote, runMemoryReindex } from "../../src/features/memory/jobs-now.js";
import { MemoryProviderRegistry } from "../../src/features/memory/providers.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * The memory host's background jobs on demand (`tavi memory reindex`,
 * `review-now`, `consolidate-now`): the same job code as the tick, without
 * its schedule, every other rule kept.
 */

const MINUTE = 60_000;
const T0 = new Date("2026-10-12T00:30:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const REVIEW_ANSWER = JSON.stringify({
  memories: [{ kind: "fact", title: "Home city", body: "The person lives in Lisbon.", scope: "everywhere" }],
});
const TIDY_MERGE = JSON.stringify({
  tidy: [
    {
      action: "merge",
      ids: ["m1", "m2"],
      title: "Garden",
      body: "Keeps a vegetable garden and grows tomatoes in it",
      reason: "the same garden",
    },
  ],
});
const SAID = [
  "I moved to Lisbon last spring with my family",
  "I work as a backend engineer at a fintech startup",
  "My team ships releases every second Thursday afternoon",
];

/** Answers reviews and tidy-ups as scripted, anything else "Done."; counts each job's calls. */
function scriptedModel() {
  const calls: ModelRequest[] = [];
  const model: ModelPort = {
    async stream(request) {
      calls.push(request);
      const text = request.attemptId.startsWith(MEMORY_REVIEW_ATTEMPT_PREFIX)
        ? REVIEW_ANSWER
        : request.attemptId.startsWith(MEMORY_CONSOLIDATION_ATTEMPT_PREFIX)
          ? TIDY_MERGE
          : "Done.";
      return { attemptId: request.attemptId, status: "completed", text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  const of = (prefix: string) => calls.filter((call) => call.attemptId.startsWith(prefix)).length;
  return { model, of };
}

const closers: (() => Promise<void>)[] = [];
const handles: ServeHandle[] = [];
const directories = temporaryDirectories({ prefix: "tavi-memory-jobs-" });
afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  for (const close of closers.splice(0).reverse()) await close();
  directories.cleanup();
});

async function fixture(settingsIn: Partial<EffectiveMemorySettings> = {}) {
  const store = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  closers.push(() => store.close());
  const repositories = store.asPort().repositories;
  const clock = { now: T0 };
  let ids = 0;
  const newId = (prefix: string) => `${prefix}-${(ids += 1)}`;
  const memory = new MemoryService(store.asPort(), { now: () => clock.now.toISOString(), newId });
  const settings: EffectiveMemorySettings = { ...effectiveMemorySettings(undefined), ...settingsIn };
  /** A Home, or an ordinary chat (`"chat"`), begun in the canvas. */
  const chat = async (id: string, kind: "home" | "chat" = "home") =>
    (
      await repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "default",
        principalId: "operator",
        operationKey: id,
        kind: "start",
        intent: { prompt: id },
        checkpointNamespace: "",
        origin: "web",
        ...(kind === "home" ? { chatKind: "home" as const } : {}),
        now: T0.toISOString(),
        newTaskId: id,
        newThreadId: `thread-${id}`,
        newAdmissionId: `admission-${id}`,
      })
    ).task.taskId;
  const say = async (taskId: string, prompts: readonly string[], when: Date) => {
    for (const prompt of prompts)
      await repositories.transcripts.append({
        taskId,
        turn: { admissionKind: "reply", prompt, items: [], outcome: { status: "completed", finalText: "Noted." } },
        createdAt: when.toISOString(),
      });
  };
  const { model, of } = scriptedModel();
  const review = createMemoryIdleReview({
    models: model,
    memory,
    repositories,
    workspaces: () => [{ workspaceId: "default" }],
    memorySettings: async () => settings,
    timezoneOf: async () => "UTC",
    targetOf: async () => ({ connectionId: "fixture", model: "fixture-model" }),
    providerFor: () => ({ id: BUILTIN_MEMORY_PROVIDER_ID, provider: createBuiltinMemoryProvider() }),
    onReviewed: async () => {},
    newId,
    now: () => clock.now,
    startedAt: T0,
    log: () => {},
  });
  const providers = new MemoryProviderRegistry();
  providers.install(BUILTIN_MEMORY_PROVIDER_ID, {
    kind: "builtin",
    provider: createBuiltinMemoryProvider(),
    declaration: BUILTIN_MEMORY_DECLARATION,
  });
  const consolidation = createMemoryConsolidation({
    models: model,
    memory,
    repositories,
    workspaces: () => [{ workspaceId: "default", principalId: "operator" }],
    peopleOf: () => ["operator"],
    memorySettings: async () => settings,
    timezoneOf: async () => "Europe/Lisbon",
    providers,
    targetOf: async () => ({ connectionId: "fixture", model: "fixture-model" }),
    newId,
    now: () => clock.now,
    log: () => {},
  });
  const proposed = async () =>
    await memory.list({
      actor: { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" },
      view: "operator",
      statuses: ["proposed"],
    });
  return { memory, clock, chat, say, review, consolidation, of, proposed };
}

describe("tavi memory review-now", () => {
  it("reviews a chat at once, without the idle wait, and says what it filed; a span reviewed is not reviewed again", async () => {
    const { clock, chat, say, review, of, proposed } = await fixture();
    const home = await chat("home");
    await say(home, SAID, at(MINUTE));
    clock.now = at(2 * MINUTE);
    // The tick waits for ten minutes of quiet; review-now does not.
    await review.tick();
    expect(of(MEMORY_REVIEW_ATTEMPT_PREFIX)).toBe(0);
    const first = await review.reviewNow({ workspaceId: "default" });
    expect(first).toEqual([{ taskId: home, outcome: "reviewed", filed: [expect.any(String)] }]);
    expect((await proposed()).map((record) => record.recordId)).toEqual(first[0]?.filed);
    expect(await review.reviewNow({ workspaceId: "default" })).toEqual([{ taskId: home, outcome: "not-due", filed: [] }]);
    expect(of(MEMORY_REVIEW_ATTEMPT_PREFIX)).toBe(1);
  });

  it("keeps every other rule: fewer than three substantive messages are not due, capture off reviews nothing, and the daily cap holds", async () => {
    const short = await fixture();
    const quiet = await short.chat("quiet", "chat");
    await short.say(quiet, ["ok", "thanks", SAID[0]!], at(MINUTE));
    expect(await short.review.reviewNow({ workspaceId: "default", taskId: quiet })).toEqual([
      { taskId: quiet, outcome: "not-due", filed: [] },
    ]);
    expect(short.of(MEMORY_REVIEW_ATTEMPT_PREFIX)).toBe(0);
    // A chat named that the review never reads says so, rather than "nothing new".
    expect(await short.review.reviewNow({ workspaceId: "default", taskId: "not-a-chat" })).toEqual([
      { taskId: "not-a-chat", outcome: "not-eligible", filed: [] },
    ]);

    const off = await fixture({ capture: "off" });
    const home = await off.chat("home");
    await off.say(home, SAID, at(MINUTE));
    expect(await off.review.reviewNow({ workspaceId: "default" })).toEqual([{ taskId: home, outcome: "capture-off", filed: [] }]);
    expect(off.of(MEMORY_REVIEW_ATTEMPT_PREFIX)).toBe(0);

    const busy = await fixture();
    const chats: string[] = [];
    for (let index = 0; index < 25; index += 1) chats.push(await busy.chat(`chat-${index}`, "chat"));
    for (const id of chats) await busy.say(id, SAID, at(MINUTE));
    const results = await busy.review.reviewNow({ workspaceId: "default" });
    expect(results.filter((result) => result.outcome === "reviewed")).toHaveLength(24);
    expect(results.filter((result) => result.outcome === "capped")).toHaveLength(1);
  });
});

describe("the memory host's tick and its jobs on demand", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const gate = (): { readonly promise: Promise<void>; readonly open: () => void } => {
    let open: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  };

  it("starts a job on demand only after the tick running ends, skips a tick due during it, and a failed job blocks none after it", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const slow = gate();
    let ticks = 0;
    const tick = startMemoryTick({
      everyMs: 1_000,
      jobs: [
        async () => {
          ticks += 1;
          order.push("tick");
          if (ticks === 1) await slow.promise;
          order.push("tick end");
        },
      ],
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const job = tick.exclusive(async () => {
      order.push("job");
      return 7;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["tick"]);
    slow.open();
    await expect(job).resolves.toBe(7);
    expect(order).toEqual(["tick", "tick end", "job"]);

    const held = gate();
    const long = tick.exclusive(async () => await held.promise);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(ticks).toBe(1);
    held.open();
    await long;
    await expect(
      tick.exclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(tick.exclusive(async () => "next")).resolves.toBe("next");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ticks).toBe(2);
    tick.stop();
  });

  it("`running` waits for a job on demand as well as the tick", async () => {
    vi.useFakeTimers();
    const tick = startMemoryTick({ everyMs: 60_000, jobs: [], log: () => {} });
    const held = gate();
    let done = false;
    const job = tick.exclusive(async () => {
      await held.promise;
      done = true;
    });
    let settled = false;
    const running = tick.running().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    held.open();
    await running;
    expect(done).toBe(true);
    await job;
    tick.stop();
  });

  it("with no interval starts no tick: the jobs run only on demand", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const tick = startMemoryTick({
      jobs: [
        async () => {
          ticks += 1;
        },
      ],
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(ticks).toBe(0);
    await expect(tick.exclusive(async () => "ran")).resolves.toBe("ran");
    tick.stop();
  });
});

describe("tavi memory consolidate-now", () => {
  it("runs before the day's 03:00, files its tidy-ups as proposals, and once a day; off answers undefined", async () => {
    const own = await fixture({ consolidation: "weekly" });
    // The Home the run's mark is kept on.
    await own.chat("home");
    const scope = { kind: "personal_workspace", principalId: "operator", workspaceId: "default" } as const;
    const actor = { principalId: "operator", workspaceId: "default", caller: "cli", authority: "operator" } as const;
    await own.memory.remember({ actor, scope, kind: "fact", body: "Keeps a vegetable garden" });
    await own.memory.remember({ actor, scope, kind: "fact", body: "Grows tomatoes in the garden" });
    // 01:30 in Lisbon: the tick waits for 03:00, consolidate-now does not.
    await own.consolidation.tick();
    expect(own.of(MEMORY_CONSOLIDATION_ATTEMPT_PREFIX)).toBe(0);
    const ran = await own.consolidation.consolidateNow({ workspaceId: "default" });
    expect(ran).toEqual([{ principalId: "operator", outcome: "ran", filed: [expect.any(String)], drafts: 1 }]);
    expect((await own.proposed()).map((record) => record.recordId)).toEqual(ran?.[0]?.filed);
    // One run a day: a second answers it ran already, and calls no model.
    expect(await own.consolidation.consolidateNow({ workspaceId: "default" })).toEqual([
      { principalId: "operator", outcome: "already", filed: [], drafts: 0 },
    ]);
    expect(own.of(MEMORY_CONSOLIDATION_ATTEMPT_PREFIX)).toBe(1);
    const off = await fixture();
    expect(await off.consolidation.consolidateNow({ workspaceId: "default" })).toBeUndefined();
  });
});

describe("tavi memory reindex", () => {
  const answer = (over: Partial<MemoryReindexAnswer>): MemoryReindexAnswer => ({
    workspaceId: "default",
    retrieval: "hybrid",
    model: "c/m",
    embedded: 0,
    failed: 0,
    limited: false,
    backingOff: false,
    indexed: 0,
    missing: 0,
    failedTotal: 0,
    ...over,
  });

  it("passes until nothing is missing, waiting out the minute's allowance between passes", async () => {
    const passes = [
      answer({ embedded: 600, limited: true, retryInMs: 30_000, indexed: 600, missing: 100 }),
      answer({ embedded: 100, indexed: 700, missing: 0 }),
    ];
    const waits: number[] = [];
    const lines: string[] = [];
    let now = 0;
    const outcome = await runMemoryReindex({
      pass: async () => passes.shift()!,
      maxWaitMs: 600_000,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
      progress: (line) => lines.push(line),
    });
    expect(outcome).toMatchObject({ stopped: "done", embedded: 700, passes: 2, last: { indexed: 700, missing: 0 } });
    expect(waits).toEqual([30_000]);
    expect(lines[0]).toBe("indexed 600, missing 100, failed 0 (this pass: 600 embedded)");
    expect(memoryReindexNote(outcome)).toBeUndefined();
  });

  it("stops when nothing more can be embedded, on a failed call, at its time limit, and under lexical recall", async () => {
    const run = async (answers: MemoryReindexAnswer[], maxWaitMs = 600_000) =>
      await runMemoryReindex({
        pass: async () => answers.shift() ?? answers.at(-1)!,
        maxWaitMs,
        now: () => 0,
        sleep: async () => {},
        progress: () => {},
      });
    expect((await run([answer({ missing: 3, failedTotal: 3 })])).stopped).toBe("stuck");
    expect((await run([answer({ missing: 3, backingOff: true, failed: 3 })])).stopped).toBe("backing-off");
    expect((await run([answer({ embedded: 600, limited: true, retryInMs: 60_000, missing: 5 })], 30_000)).stopped).toBe("timeout");
    const lexical = await run([answer({ retrieval: "lexical", model: null })]);
    expect(lexical.stopped).toBe("lexical");
    expect(memoryReindexNote(lexical)).toContain("retrieval is lexical");
    expect((await run([answer({ blocked: "memory is paused", missing: 4 })])).stopped).toBe("blocked");
  });

  it("is UNAVAILABLE without the memory host", async () => {
    const slot = createMemoryJobsSlot();
    await expect(slot.jobs.reindex("default")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const unset = slot.set({
      reindex: async () => answer({}),
      reviewNow: async () => ({ workspaceId: "default", capturing: true, chats: [] }),
      consolidateNow: async () => ({ workspaceId: "default", consolidation: "off", enabled: true, people: [] }),
    });
    await expect(slot.jobs.reindex("default")).resolves.toMatchObject({ retrieval: "hybrid" });
    unset();
    await expect(slot.jobs.reviewNow("default")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("the memory job verbs at the CLI", () => {
  it("parses each verb and its options", () => {
    expect(parseArgs(["memory", "reindex", "--max-wait", "120"])).toMatchObject({
      command: "memory",
      memory: { action: "reindex", maxWaitSeconds: 120 },
    });
    expect(parseArgs(["memory", "review-now", "--chat", "task-1", "--format", "json"])).toMatchObject({
      memory: { action: "review-now", chatTaskId: "task-1", format: "json" },
    });
    expect(parseArgs(["memory", "consolidate-now", "--principal", "alice"])).toMatchObject({
      memory: { action: "consolidate-now", forPrincipalId: "alice" },
    });
    expect(() => parseArgs(["memory", "reindex", "--max-wait", "0"])).toThrow(/--max-wait/);
    expect(() => parseArgs(["memory", "review-now", "task-1"])).toThrow(/positional/);
    expect(() => parseArgs(["memory", "consolidate-now", "--chat", "x"])).toThrow(/does not accept --chat/);
  });

  it("parses `serve --eval`, which opens no messaging channel", () => {
    expect(parseArgs(["serve", "--eval"])).toMatchObject({ command: "serve", serve: { evalOwner: true } });
    expect(parseArgs(["serve"])).not.toMatchObject({ serve: { evalOwner: true } });
  });

  it("serves `--eval` with no sweep, tick or channel, and no task summary model call", () => {
    expect(EVAL_OWNER_OFF).toEqual({
      reminderSweepEnabled: false,
      heartbeatEnabled: false,
      scheduleSweepEnabled: false,
      scheduleWatchersEnabled: false,
      memoryTickEnabled: false,
      openSavedChannels: false,
      taskSummariesEnabled: false,
    });
  });

  it("runs on a live owner over IPC: review-now files from a Home that is not idle, consolidate-now says it is off, reindex that recall is lexical", async () => {
    const dataDirectory = directories.create();
    const { model, of } = scriptedModel();
    const handle = await serve(
      fixtureServeOptions(dataDirectory, { memoryHostEnabled: true }),
      { dataDirectory, drainDeadlineMs: 5_000 },
      { stdout: () => {}, stderr: () => {}, isTty: false },
      { modelOverride: model, memoryTiming: { tickMs: 3_600_000 } },
    );
    handles.push(handle);
    const workflow =
      handle.runtime.workflow ??
      (() => {
        throw new Error("no workflow");
      })();
    const context = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    const home = (await workflow.admit({ context, operationKey: "h-0", kind: "start", prompt: SAID[0]!, origin: "web", chatKind: "home" }))
      .taskId;
    for (const [index, prompt] of SAID.slice(1).entries())
      await workflow.admit({ context, taskId: home, operationKey: `h-${index + 1}`, kind: "reply", prompt });

    const review = capture();
    expect(await main(["memory", "review-now", "--data-dir", dataDirectory], { io: review.io })).toBe(0);
    expect(review.out()).toMatch(new RegExp(`^${home}\\treviewed\\t1 filed: \\S+\\n$`));
    expect(of(MEMORY_REVIEW_ATTEMPT_PREFIX)).toBe(1);

    const consolidate = capture();
    expect(await main(["memory", "consolidate-now", "--data-dir", dataDirectory], { io: consolidate.io })).toBe(0);
    expect(consolidate.out()).toContain("consolidation is off");

    const reindex = capture();
    expect(await main(["memory", "reindex", "--data-dir", dataDirectory, "--format", "json"], { io: reindex.io })).toBe(0);
    expect(JSON.parse(reindex.out())).toMatchObject({ retrieval: "lexical", stopped: "lexical" });
  }, 60_000);

  it("runs offline under ownership in a runtime of its own", async () => {
    const dataDirectory = directories.create();
    const consolidate = capture();
    expect(await main(["memory", "consolidate-now", "--data-dir", dataDirectory], { io: consolidate.io })).toBe(0);
    expect(consolidate.out()).toContain("consolidation is off");
    const review = capture();
    expect(await main(["memory", "review-now", "--data-dir", dataDirectory], { io: review.io })).toBe(0);
    expect(review.out()).toContain("no chat has anything new to review");
  }, 60_000);
});
