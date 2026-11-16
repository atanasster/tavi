import { routineFixture, executionFixture } from "./routine-fixture.js";
import { afterEach, expect, it } from "vitest";
import { RoutineCreateSchema, routineDefaults } from "@tavi/contracts";
import { RoutineDeliveryService, RoutineNewsService, RoutinePublicationService, canonicalRoutineJson, routineHash } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { executeRoutinePipeline } from "../../src/features/routines/pipeline.js";
import { createRoutineNotices } from "../../src/features/routines/notices.js";
import { createChatNotices } from "../../src/features/tasks/notices.js";
import { fixturePromptPolicy } from "../support/prompt-policy.js";

/**
 * The composed restart matrix.
 *
 * Each boundary an owner can die at, asserted at the level an operator cares
 * about: the occurrence keeps its identity, the fence refuses the old owner, a
 * reservation nobody could reconcile is *retained* rather than refunded, a local
 * publication is not repeated, and an uncertain provider acceptance is never
 * retried on its own.
 */
const scope = { workspaceId: "default", principalId: "operator" };
const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

async function fixture() {
  const directory = directories.create("tavi-recovery-");
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true, artifactsDirectory: directory });
  const routines = await routineFixture(store, {
    executionAvailable: true,
    deliveryAuthorization: "available",
    now: () => "2026-09-20T06:00:00.000Z",
  });
  const created = await routines.create(
    scope,
    RoutineCreateSchema.parse({
      ...routineDefaults("Europe/Sofia"),
      operationKey: "create",
      name: "News",
      objective: "Find news",
      agent: { agentId: "news", name: "News", instructions: "Find evidence" },
      triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
      skills: [],
      models: {
        research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
        synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      },
      permissions: { revision: 1, researchTools: ["http.request"], allowedHosts: ["example.com"], networkMode: "allowlist" },
    }),
  );
  await routines.finishEvaluation(scope, (await created).routine.routineId, 1, true, "pass");
  const runs = await executionFixture(routines, { ownerEpoch: "first", now: () => "2026-09-20T06:00:00.000Z" });
  const news = new RoutineNewsService(runs);
  const publication = new RoutinePublicationService(runs, { now: () => "2026-09-20T06:00:00.000Z" });
  const delivery = new RoutineDeliveryService(runs, {
    now: () => "2026-09-20T06:00:00.000Z",
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        throw new Error("no sends in this fixture");
      },
    },
  });
  const schedule = (await store.asPort().repositories.schedules.list(scope.workspaceId))[0]!;
  await store.asPort().repositories.schedules.setEnabled({
    scheduleId: schedule.scheduleId,
    enabled: true,
    nextRunAt: "2026-09-20T06:00:00.000Z",
    now: "2026-09-20T06:00:00.000Z",
  });
  return {
    store,
    routines,
    runs,
    news,
    publication,
    delivery,
    schedule: (await store.asPort().repositories.schedules.get(schedule.scheduleId))!,
    routineId: (await created).routine.routineId,
    close: async () => await store.close(),
  };
}

it("claims one occurrence, and a crash before start re-dispatches the same identity", async () => {
  const f = await fixture();
  try {
    const claimed = (await f.runs.claim(f.schedule, f.schedule.nextRunAt!))!;
    // Dying between the claim and the start leaves a queued run; the occurrence
    // key is what makes a second claim of the same fire a no-op rather than a
    // duplicate run.
    expect((await claimed).status).toBe("queued");
    await f.runs.claim(f.schedule, f.schedule.nextRunAt!);
    expect(await f.runs.history(scope, f.routineId)).toHaveLength(1);
    const fence = (await f.runs.start(scope, (await claimed).runId))!;
    expect((await fence).generation).toBe(1);
    await f.runs.bindTask(fence, "task-a");
    expect((await f.runs.get(scope, (await claimed).runId)).taskId).toBe("task-a");
  } finally {
    f.close();
  }
});

it("fences the dead owner, keeps its unknown spend, and settles its waits", async () => {
  const f = await fixture();
  try {
    const run = (await f.runs.claim(f.schedule, f.schedule.nextRunAt!))!;
    const fence = (await f.runs.start(scope, (await run).runId))!;
    // A reservation the provider may have served: its usage never came back.
    await f.runs.reserveModel(fence, "research", "attempt-1", 5_000, { connectionId: "fixture", model: "v1" });
    expect((await f.runs.get(scope, (await run).runId)).data).toMatchObject({ tokensReserved: 5_000, tokensKnown: 0 });
    f.store.handle.prepare("UPDATE tavi_routine_state SET research_failures=2").run();

    const replacement = await executionFixture(f.routines, { ownerEpoch: "second", now: () => "2026-09-20T06:05:00.000Z" });
    expect(await replacement.recoverPreviousOwner()).toBe(1);
    const recovered = await replacement.get(scope, (await run).runId);
    expect((await recovered).status).toBe("interrupted");
    // The reservation is *retained*: the replacement cannot know whether the
    // provider served it, and a refund would understate what was charged.
    expect((await recovered).data).toMatchObject({ tokensReserved: 5_000, tokensKnown: 0, usageComplete: true });
    expect((await recovered).data.reservations).toEqual({ "attempt-1": 5_000 });
    // The dead owner's fence is refused, and its failure streak is not charged to
    // the replacement.
    await expect((async () => await replacement.finish(fence, "succeeded"))()).rejects.toThrow(/fenced/);
    expect(f.store.handle.prepare("SELECT research_failures FROM tavi_routine_state WHERE routine_id=?").get(f.routineId)).toEqual({
      research_failures: 2,
    });
    const next = (await replacement.start(scope, (await run).runId))!;
    expect((await next).generation).toBeGreaterThan((await fence).generation);
    await replacement.finish(next, "succeeded");
    expect((await replacement.get(scope, (await run).runId)).status).toBe("succeeded");
  } finally {
    f.close();
  }
});

it("publishes once, so a re-driven pipeline does not duplicate the local report", async () => {
  const f = await fixture();
  try {
    const run = (await f.runs.claim(f.schedule, f.schedule.nextRunAt!))!;
    const fence = (await f.runs.start(scope, (await run).runId))!;
    const text = "Example Model version 2 is now available.";
    const source = (await f.news.capture(
      fence,
      "web_search",
      {},
      { sources: [{ url: "https://example.com/release", snippet: text }] },
    )) as { sources: { sourceId: string }[] };
    await f.news.capture(
      fence,
      "http.request",
      { url: "https://example.com/release" },
      { ok: true, body: `<meta property="article:published_time" content="2026-09-20T05:00:00Z"><p>${text}</p>` },
    );
    const workflow = async (): Promise<never> =>
      ({
        taskId: "fixture",
        threadId: "fixture",
        admissionId: "fixture",
        created: true,
        replay: false,
        outcome: {
          status: "completed",
          finalText: JSON.stringify({
            stories: [
              {
                title: "Release",
                releaseIdentity: "Example Model version 2",
                eventKind: "release",
                claims: [{ text, sourceId: source.sources[0]!.sourceId }],
              },
            ],
          }),
        },
      }) as never;
    const renderer = {
      capabilities: () => ({ available: false, provider: "fixture" }),
      renderPdf: async () => {
        throw new Error("unexpected");
      },
    };
    await executeRoutinePipeline(
      { runs: f.runs, news: f.news, publication: f.publication, delivery: f.delivery, renderer, workflow },
      await f.runs.get(scope, (await run).runId),
      fence,
    );
    const published = (await f.publication.get(scope, (await run).runId))!;
    // A second drive of the same run returns the same publication and adds no
    // artifact: the publication row is the idempotency key.
    await executeRoutinePipeline(
      { runs: f.runs, news: f.news, publication: f.publication, delivery: f.delivery, renderer, workflow },
      await f.runs.get(scope, (await run).runId),
      fence,
    );
    expect(await f.publication.get(scope, (await run).runId)).toEqual(published);
    expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_routine_blob_refs WHERE run_id=?").get((await run).runId)).toEqual({
      n: 1,
    });
  } finally {
    f.close();
  }
});

it("never resends a provider acceptance that is uncertain, across a restart", async () => {
  const f = await fixture();
  try {
    const run = (await f.runs.claim(f.schedule, f.schedule.nextRunAt!))!;
    const fence = (await f.runs.start(scope, (await run).runId))!;
    const text = "Example Model version 2 is now available.";
    const source = (await f.news.capture(
      fence,
      "http.request",
      { url: "https://example.com/release" },
      { ok: true, body: `<meta property="article:published_time" content="2026-09-20T05:00:00Z"><p>${text}</p>` },
    )) as { sourceId: string };
    const report = await f.news.select(
      scope,
      (await run).runId,
      {
        stories: [
          {
            title: "Release",
            releaseIdentity: "Example Model version 2",
            eventKind: "release",
            claims: [{ text, sourceId: source.sourceId }],
          },
        ],
      },
      "2026-09-20T06:00:00.000Z",
    );
    const target = await f.routines.putTarget(scope, {
      ...scope,
      targetId: "chat",
      connectionId: "tg",
      chatId: "123",
      label: "Chat",
      authorizationRef: "operator-destination-allowlist",
      enabled: true,
      createdAt: "2026-09-20T06:00:00.000Z",
    });
    f.store.handle.prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?").run(
      canonicalRoutineJson({
        ...(await f.runs.get(scope, (await run).runId)).snapshot,
        report: { ...(await f.runs.get(scope, (await run).runId)).snapshot.report, formats: ["in-app", "pdf"] },
        delivery: { ...(await f.runs.get(scope, (await run).runId)).snapshot.delivery, targetIds: [(await target).targetId] },
      }),
      (await run).runId,
    );
    // The fixture edits the run's snapshot after admission, which production never
    // does; the grant is the authority, so it has to name the destination too.
    const { revokedAt: _revokedAt, revokedReason: _revokedReason, ...base } = (await f.runs.grantFor(scope, (await run).runId))!;
    const grant = { ...base, destinationIds: [(await target).targetId] };
    f.store.handle
      .prepare("UPDATE tavi_routine_grants SET grant_json=?,grant_hash=? WHERE run_id=?")
      .run(canonicalRoutineJson(grant), routineHash(grant), (await run).runId);
    const scoped = { ...report, runId: (await run).runId, revision: (await f.runs.get(scope, (await run).runId)).revision };
    await f.publication.stage(fence, "json", Buffer.from(canonicalRoutineJson(scoped)));
    await f.publication.stage(fence, "pdf", Buffer.from("%PDF-fixture"));
    let sends = 0;
    const delivery = new RoutineDeliveryService(f.runs, {
      now: () => "2026-09-20T06:00:00.000Z",
      messaging: {
        buildDestination: (_connectionId, target) => ({ chatId: target.to }),
        send: async () => {
          sends += 1;
          throw new Error("provider did not answer");
        },
      },
    });
    const version = (f.store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number }).version;
    await f.publication.publish(fence, scoped, version, delivery);
    // The provider never answered: the job is uncertain, and a *replacement* owner
    // draining it again must not send a second copy.
    await delivery.drain();
    expect(sends).toBe(1);
    const replacement = new RoutineDeliveryService(f.runs, {
      now: () => "2026-09-20T06:01:00.000Z",
      messaging: {
        buildDestination: (_connectionId, target) => ({ chatId: target.to }),
        send: async () => {
          sends += 1;
          throw new Error("must not resend");
        },
      },
    });
    await replacement.drain();
    expect(sends).toBe(1);
    expect((await (await replacement).list(scope, (await run).runId))[0]).toMatchObject({ status: "failed" });
  } finally {
    f.close();
  }
});

/**
 * The person's Home over the fixture's store, and the routine notices that
 * post into it, with a channel that answers `status` and counts its sends.
 */
async function noticesFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { readonly home?: boolean; readonly status?: "accepted" | "rejected" } = {},
) {
  const repositories = f.store.asPort().repositories;
  await repositories.tasks.admit({
    prompt: fixturePromptPolicy,
    workspaceId: scope.workspaceId,
    principalId: scope.principalId,
    operationKey: "op-home",
    kind: "start",
    intent: { prompt: "home" },
    checkpointNamespace: "",
    chatKind: "home",
    newTaskId: "home-1",
    newAdmissionId: "adm-home",
    newThreadId: "thread-home",
    now: "2026-09-20T06:00:00.000Z",
  });
  let id = 0;
  const chatNotices = createChatNotices({
    repositories: { ...repositories, workspaceSettings: { get: async () => ({ settings: { homeChat: true } }) } as never },
    isLocalConnection: () => false,
    homeOf: async () => (options.home === false ? undefined : "home-1"),
    newId: () => `notice-${++id}`,
    now: () => "2026-09-20T06:00:00.000Z",
    log: () => undefined,
  });
  const sent: string[] = [];
  const notices = createRoutineNotices({
    routines: f.routines,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async (message) => {
        sent.push(message.effectId!);
        const status = options.status ?? "accepted";
        return { status, retryable: false, parts: [{ index: 0, status }] };
      },
    },
    postHome: (input) => chatNotices.postAlert(input),
    log: () => undefined,
  });
  return { notices, sent, home: async () => await repositories.transcripts.notices("home-1", { limit: 20 }) };
}

it("tells a routine's pause with no delivery target once, in Home, and a repeat sweep tells nothing", async () => {
  const f = await fixture();
  try {
    const n = await noticesFixture(f);
    let told = 0;
    const runs = await executionFixture(f.routines, {
      ownerEpoch: "notices",
      now: () => "2026-09-20T06:00:00.000Z",
      onPaused: async (run, cause) => {
        told++;
        return n.notices.runPaused(run, cause);
      },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const run = await runs.request(scope, f.routineId, `fail-${attempt}`);
      await runs.finish((await runs.start(scope, run.runId))!, "failed");
    }
    expect((await f.routines.get(scope, f.routineId)).routine.status).toBe("paused-failures");
    // Before, the pause went through the routine schedule's alert target, which
    // a routine's schedule never has, and was dropped as sent.
    await runs.notifyPauses();
    await runs.notifyPauses();
    expect(told).toBe(1);
    expect(n.sent).toEqual([]);
    const home = await n.home();
    expect(home).toHaveLength(1);
    expect(home[0]).toMatchObject({ kind: "run-settled", title: "Routine “News” paused" });
    expect(home[0]!.summary).toMatch(/after 3 failed runs in a row.*Resume it/);
  } finally {
    await f.close();
  }
});

it("tells a run that expired before it could finish once, in Home", async () => {
  const f = await fixture();
  try {
    const n = await noticesFixture(f);
    let now = "2026-09-20T06:00:00.000Z";
    const runs = await executionFixture(f.routines, {
      ownerEpoch: "notices",
      now: () => now,
      onPaused: (run, cause) => n.notices.runPaused(run, cause),
    });
    const run = await runs.claim(f.schedule, f.schedule.nextRunAt!);
    // The owner slept past the run's queue window.
    now = new Date(Date.parse(run!.data.queueExpiresAt) + 60_000).toISOString();
    expect(await runs.start(scope, run!.runId)).toBeUndefined();
    expect(await runs.get(scope, run!.runId)).toMatchObject({ status: "skipped", data: { reason: "expired" } });
    await runs.notifyPauses();
    await runs.notifyPauses();
    const home = await n.home();
    expect(home).toHaveLength(1);
    expect(home[0]).toMatchObject({ title: "Routine “News” run expired" });
    expect(home[0]!.summary).toMatch(/expired before it could finish/);
  } finally {
    await f.close();
  }
});

it("keeps a pause pending while it can be told nowhere it was tried, and drops it with neither a target nor a Home", async () => {
  const f = await fixture();
  try {
    const n = await noticesFixture(f, { home: false });
    let told = 0;
    const runs = await executionFixture(f.routines, {
      ownerEpoch: "notices",
      now: () => "2026-09-20T06:00:00.000Z",
      onPaused: async (run, cause) => {
        told++;
        return n.notices.runPaused(run, cause);
      },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const run = await runs.request(scope, f.routineId, `fail-${attempt}`);
      await runs.finish((await runs.start(scope, run.runId))!, "failed");
    }
    // Nowhere to tell it: trying again on every sweep would change nothing.
    await runs.notifyPauses();
    await runs.notifyPauses();
    expect(told).toBe(1);
  } finally {
    await f.close();
  }
});

it("sends a routine's notice to its own target, and falls back to Home when that channel refuses or is the one that paused", async () => {
  const f = await fixture();
  try {
    await f.routines.putTarget(scope, {
      ...scope,
      targetId: "chat",
      connectionId: "tg",
      chatId: "123",
      label: "Team chat",
      authorizationRef: "operator-destination-allowlist",
      enabled: true,
      createdAt: "2026-09-20T06:00:00.000Z",
    });
    const claimed = await f.runs.claim(f.schedule, f.schedule.nextRunAt!);
    const run = { ...claimed!, snapshot: { ...claimed!.snapshot, delivery: { ...claimed!.snapshot.delivery, targetIds: ["chat"] } } };

    const accepting = await noticesFixture(f);
    expect(await accepting.notices.runPaused(run, "credential-grace")).toBe(true);
    expect(accepting.sent).toEqual([`routine-notice:${run.runId}:credential-grace`]);
    expect(await accepting.home()).toHaveLength(0);

    // A channel that refuses never swallows the notice.
    const refusing = await noticesFixture(f, { status: "rejected" });
    expect(await refusing.notices.runPaused(run, "failures")).toBe(true);
    expect(refusing.sent).toEqual([`routine-notice:${run.runId}:failures`]);
    expect((await refusing.home()).map((notice) => notice.title)).toEqual(["Routine “News” paused"]);

    // The target that paused is not sent its own pause: it goes to Home.
    expect(await refusing.notices.deliveryPaused(run, "chat", "failures")).toBe(true);
    expect(refusing.sent).toHaveLength(1);
    const delivery = (await refusing.home()).find((notice) => notice.title === "Routine “News” delivery paused");
    expect(delivery?.summary).toMatch(/delivery to “Team chat” paused because 3 sends failed in a row/);
  } finally {
    await f.close();
  }
});
