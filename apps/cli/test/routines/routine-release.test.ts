import { routineFixture, executionFixture } from "./routine-fixture.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RoutineCreateSchema, routineDefaults, type ModelPort, type RoutineDetail, type RoutineRun } from "@tavi/contracts";
import {
  RoutineControlService,
  RoutineDeliveryService,
  RoutineEvaluationService,
  RoutineNewsService,
  RoutinePublicationService,
  canonicalRoutineJson,
  routineHash,
} from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import { executeRoutinePipeline } from "../../src/features/routines/pipeline.js";
import { createSnapshot, exportTables, restoreSnapshot } from "../../src/features/maintenance/backup.js";
import { MIGRATIONS, ROUTINE_TABLES } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { runMigrations } from "../../../../packages/runtime/src/persistence/migrations.js";
const directories = temporaryDirectories({ prefix: "routine-release-" });
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      await store.close();
    } catch {}
  }
  directories.cleanup();
});
const scope = { workspaceId: "default", principalId: "operator" };
it("completes both configuration turns, retains receipts across restart, and restores all routine tables and bytes", async () => {
  const dir = directories.create();
  let now = "2026-09-20T05:59:00.000Z";
  let evaluationCalls = 0;
  let sends = 0;
  const models: ModelPort = {
    stream: async (request) => {
      evaluationCalls++;
      const data = JSON.parse(request.messages[1]!.text) as {
        now: string;
        sources: { sourceId: string; text: string; publishedAt: string | null; state?: string }[];
      };
      // One story per release identity, with a claim per supporting source: a
      // faithful selection groups the same release rather than emitting a story per
      // page, and the scorer counts claims.
      const supporting = data.sources.filter(
        (source) =>
          source.state !== "snippet" &&
          source.publishedAt !== null &&
          Date.parse(source.publishedAt) > Date.parse(data.now) - 86400000 &&
          /is now available/.test(source.text),
      );
      const grouped = new Map<
        string,
        { title: string; releaseIdentity: string; eventKind: "release"; claims: { text: string; sourceId: string }[] }
      >();
      for (const source of supporting) {
        const releaseIdentity = source.text.split(" is now")[0]!;
        const story = grouped.get(releaseIdentity) ?? {
          title: releaseIdentity,
          releaseIdentity,
          eventKind: "release" as const,
          claims: [],
        };
        story.claims.push({ text: source.text.split(/(?<=[.!?])\s+/)[0]!, sourceId: source.sourceId });
        grouped.set(releaseIdentity, story);
      }
      const stories = [...grouped.values()];
      return {
        attemptId: request.attemptId,
        status: "completed",
        usage: { totalTokens: 100 },
        toolCalls: [],
        text: JSON.stringify({ stories }),
      };
    },
  };
  const store = await SqliteStore.open({ databasePath: join(dir, "tavi.sqlite"), artifactsDirectory: join(dir, "artifacts") });
  stores.push(store);
  const routines = await routineFixture(store, { executionAvailable: true, deliveryAuthorization: "available", now: () => now });
  const runs = await executionFixture(routines, { ownerEpoch: "first", now: () => now });
  const news = new RoutineNewsService(runs);
  const publication = new RoutinePublicationService(runs, { now: () => now });
  const delivery = new RoutineDeliveryService(runs, {
    now: () => now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "fixture-message-42" }] };
      },
    },
  });
  const evaluation = new RoutineEvaluationService(routines, { models, ownerEpoch: "first", now: () => now, ready: () => true });
  const policy = { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] };
  const control = new RoutineControlService({
    routines,
    runs,
    news,
    publication,
    delivery,
    defaultModels: () => ({ research: policy, synthesis: policy }),
    allowedHosts: ["example.com"],
    wake: () => {},
  });
  const draft = (await control.execute({
    ...scope,
    action: "create",
    operationKey: "first-turn",
    conversationId: "chat",
    setup: { name: "LLM news", objective: "Find model releases", timezone: "Europe/Sofia", at: "09:00" },
  })) as RoutineDetail;
  await evaluation.drain();
  expect(evaluationCalls).toBe(((await evaluation.sample()).acceptance.length + (await evaluation.sample()).tuning.length) * 2);
  const fire = async (version: number): Promise<RoutineRun> => {
    const schedule = (await store.asPort().repositories.schedules.list(scope.workspaceId))[0]!;
    expect(schedule.nextRunAt).toBe(now);
    const run = (await runs.claim(schedule, now))!;
    const fence = (await runs.start(scope, (await run).runId))!;
    await runs.append(run, { version: 1, code: "model", step: "research" }, (await fence).attemptId, {
      kind: "prompt",
      text: (await run).snapshot.agent.instructions,
    });
    await executeRoutinePipeline(
      {
        runs,
        news,
        publication,
        delivery,
        renderer: {
          capabilities: () => ({ available: true, provider: "fixture" }),
          renderPdf: async () => ({ bytes: Buffer.from("%PDF-fixture-release") }),
        },
        workflow: async (_run, _fence, _instructions, capture) => {
          await capture("web_search", {}, { sources: [{ url: "https://example.com/release", snippet: "Discovery" }] });
          const text = `Example Model version ${version} is now available.`;
          const source = (await capture(
            "http.request",
            { url: "https://example.com/release" },
            { ok: true, body: `<meta property="article:published_time" content="${now}"><p>${text}</p>` },
          )) as { sourceId: string };
          return {
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
                    releaseIdentity: `Example Model version ${version}`,
                    eventKind: "release",
                    claims: [{ text, sourceId: source.sourceId }],
                  },
                ],
              }),
            },
          };
        },
      },
      run,
      fence,
    );
    return await runs.get(scope, (await run).runId);
  };
  now = "2026-09-20T06:00:00.000Z";
  const first = await fire(1);
  expect(first.revision).toBe(1);
  expect(sends).toBe(0);
  const active = await routines.get(scope, draft.routine.routineId);
  const target = await routines.putTarget(scope, {
    ...scope,
    targetId: "test-chat",
    connectionId: "fixture-telegram",
    chatId: "123",
    label: "Authorized fixture chat",
    authorizationRef: "operator-destination-allowlist",
    enabled: true,
    createdAt: now,
  });
  await control.execute({
    ...scope,
    action: "edit",
    conversationId: "chat",
    operationKey: "second-turn",
    expectedVersion: (await active).routine.version,
    edit: {
      report: { ...(await active).revision.snapshot.report, style: "summary", formats: ["in-app", "pdf"] },
      delivery: { ...(await active).revision.snapshot.delivery, targetIds: [(await target).targetId] },
    },
  });
  await evaluation.drain();
  expect(evaluationCalls).toBe(((await evaluation.sample()).acceptance.length + (await evaluation.sample()).tuning.length) * 2);
  now = "2026-09-21T06:00:00.000Z";
  const second = await fire(2);
  expect(second.revision).toBe(2);
  expect(second.snapshot.agent).toEqual(first.snapshot.agent);
  expect(sends).toBe(1);
  expect((await (await delivery).list(scope, second.runId))[0]?.data.providerMessageIds).toEqual(["fixture-message-42"]);
  const before = store.handle.prepare("SELECT * FROM tavi_routine_state").get();
  const preview = await runs.request(scope, draft.routine.routineId, "preview", "preview");
  const previewFence = (await runs.start(scope, (await preview).runId))!;
  await runs.finish(previewFence, "failed");
  expect(store.handle.prepare("SELECT * FROM tavi_routine_state").get()).toEqual(before);
  const published = (await publication.get(scope, second.runId))!;
  const bytes = (await store.readArtifactBody((await published).pdfArtifactId!))!;
  expect(() => runMigrations(store.handle, MIGRATIONS.slice(0, -1))).toThrow(/not known to this build/);
  // The schema is the source of truth for what the migrations actually created,
  // so it is read before the store is closed and compared to the declared sets.
  const createdRoutineTables = (
    store.handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tavi_routine%'").all() as { name: string }[]
  ).map((row) => row.name);
  await store.close();
  stores.splice(stores.indexOf(store), 1);
  const backup = join(directories.create(), "snapshot");
  const manifest = await createSnapshot({
    dataDirectory: dir,
    outDirectory: backup,
    buildId: "routine-fixture",
    now,
    includeArtifacts: true,
    includeCredentials: false,
    force: false,
  });
  // The two directions together are what makes the inventory meaningful, and
  // neither alone is enough: the constants must name tables the snapshot carries,
  // *and* every routine table the migrations created must appear in a constant,
  // so a migration that adds a table without declaring it cannot pass unnoticed
  // The constants are hand-kept, so the reverse check is the one that can
  // actually fail on a new migration.
  const declared: readonly string[] = ROUTINE_TABLES;
  for (const table of createdRoutineTables) expect(declared, table).toContain(table);
  for (const table of declared) {
    expect(manifest.applicationTables, table).toContain(table);
  }
  expect(manifest.applicationTables).toContain("tavi_routine_commands");
  expect(manifest.rowCounts["tavi_routine_runs"]).toBe(3);
  const exported = directories.create();
  await exportTables({ dataDirectory: dir, outDirectory: exported, force: false });
  expect(readFileSync(join(exported, "tavi_routine_revisions.ndjson"), "utf8").trim().split("\n")).toHaveLength(2);
  const restored = directories.create();
  await restoreSnapshot({ snapshotDirectory: backup, dataDirectory: restored, now });
  const reopened = await SqliteStore.open({ databasePath: join(restored, "tavi.sqlite"), artifactsDirectory: join(restored, "artifacts") });
  stores.push(reopened);
  const restoredRoutines = await routineFixture(reopened, {});
  const restoredRuns = await executionFixture(restoredRoutines, { ownerEpoch: "second" });
  expect(await restoredRuns.history(scope, draft.routine.routineId)).toHaveLength(3);
  expect((await restoredRuns.get(scope, first.runId)).revision).toBe(1);
  expect((await restoredRuns.get(scope, second.runId)).revision).toBe(2);
  expect(Buffer.from((await reopened.readArtifactBody((await published).pdfArtifactId!))!)).toEqual(Buffer.from(bytes));
  // The pinned revisions, the ledger envelopes *and* each run's durable grant
  // survive the round trip, and the restored chain still verifies.
  const restoredVerdict = await restoredRuns.verify(scope, draft.routine.routineId);
  expect(restoredVerdict).toMatchObject({ valid: true, anchored: false });
  expect(reopened.handle.prepare("SELECT COUNT(*) AS n FROM tavi_routine_grants").get()).toEqual({ n: 3 });
  expect((await (await restoredRuns.grantFor(scope, first.runId))!).networkMode).toBe("allowlist");
  expect((await (await restoredRuns.effectiveGrantPolicy(scope, first.runId))!).allowedHosts).toEqual(["example.com"]);
  expect(
    (await restoredRuns.ledger(scope, draft.routine.routineId)).some(
      (event) => event.envelope.decision === "allow" && event.envelope.grantId !== undefined,
    ),
  ).toBe(true);
  const restoredDelivery = new RoutineDeliveryService(restoredRuns, {
    now: () => now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        throw new Error("Accepted delivery must not resend");
      },
    },
  });
  await restoredDelivery.drain();
  expect((await (await restoredDelivery).list(scope, second.runId))[0]?.status).toBe("accepted");
  reopened.handle.prepare("UPDATE tavi_routine_details SET created_at='2020-01-01T00:00:00.000Z'").run();
  expect(await restoredRuns.pruneDueDetails(true)).toBeGreaterThan(0);
  await restoredRuns.pruneDueDetails();
  expect(await restoredRuns.verify(scope, draft.routine.routineId)).toMatchObject({ valid: true, prunedDetails: 2 });
  expect(canonicalRoutineJson((await restoredRuns.get(scope, first.runId)).snapshot)).toBe(canonicalRoutineJson(first.snapshot));
});

it("restores a snapshot without artifact bytes, and says so instead of sending", async () => {
  const dir = directories.create();
  let now = "2026-09-20T06:00:00.000Z";
  const store = await SqliteStore.open({ databasePath: join(dir, "tavi.sqlite"), artifactsDirectory: join(dir, "artifacts") });
  stores.push(store);
  const routines = await routineFixture(store, { executionAvailable: true, deliveryAuthorization: "available", now: () => now });
  const runs = await executionFixture(routines, { ownerEpoch: "first", now: () => now });
  const news = new RoutineNewsService(runs);
  const publication = new RoutinePublicationService(runs, { now: () => now });
  let sends = 0;
  const delivery = new RoutineDeliveryService(runs, {
    now: () => now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        sends++;
        return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "fixture" }] };
      },
    },
  });
  const policy = { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] };
  const created = await routines.create(
    scope,
    RoutineCreateSchema.parse({
      ...routineDefaults("Europe/Sofia"),
      operationKey: "no-bytes",
      name: "News",
      objective: "Find news",
      agent: { agentId: "news", name: "News", instructions: "Find evidence" },
      triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
      skills: [],
      models: { research: policy, synthesis: policy },
      permissions: { revision: 1, researchTools: ["http.request"], allowedHosts: ["example.com"], networkMode: "allowlist" },
    }),
  );
  await routines.finishEvaluation(scope, (await created).routine.routineId, 1, true, "pass");
  const target = await routines.putTarget(scope, {
    ...scope,
    targetId: "chat",
    connectionId: "fixture-telegram",
    chatId: "123",
    label: "Chat",
    authorizationRef: "operator-destination-allowlist",
    enabled: true,
    createdAt: now,
  });
  const schedule = (await store.asPort().repositories.schedules.list(scope.workspaceId))[0]!;
  await store.asPort().repositories.schedules.setEnabled({ scheduleId: schedule.scheduleId, enabled: true, nextRunAt: now, now });
  const due = (await store.asPort().repositories.schedules.get(schedule.scheduleId))!;
  const run = (await runs.claim(due, due.nextRunAt!))!;
  const fence = (await runs.start(scope, (await run).runId))!;
  const text = "Example Model version 2 is now available.";
  const source = (await news.capture(
    fence,
    "http.request",
    { url: "https://example.com/release" },
    { ok: true, body: `<meta property="article:published_time" content="2026-09-20T05:00:00Z"><p>${text}</p>` },
  )) as { sourceId: string };
  const report = await news.select(
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
    now,
  );
  const snapshot = {
    ...(await runs.get(scope, (await run).runId)).snapshot,
    report: { ...(await runs.get(scope, (await run).runId)).snapshot.report, formats: ["in-app", "pdf"] as const },
    delivery: { ...(await runs.get(scope, (await run).runId)).snapshot.delivery, targetIds: [(await target).targetId] },
  };
  store.handle
    .prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?")
    .run(canonicalRoutineJson(snapshot), (await run).runId);
  const { revokedAt: _a, revokedReason: _b, ...base } = (await runs.grantFor(scope, (await run).runId))!;
  const grant = { ...base, destinationIds: [(await target).targetId] };
  store.handle
    .prepare("UPDATE tavi_routine_grants SET grant_json=?,grant_hash=? WHERE run_id=?")
    .run(canonicalRoutineJson(grant), routineHash(grant), (await run).runId);
  await publication.stage(fence, "json", Buffer.from(canonicalRoutineJson(report)));
  await publication.stage(fence, "pdf", Buffer.from("%PDF-no-bytes"));
  const version = (store.handle.prepare("SELECT version FROM tavi_routine_state").get() as { version: number }).version;
  const published = await publication.publish(fence, report, version, delivery);
  // Left *pending* on purpose: the interesting restore is one with unsent work.
  expect((await (await delivery).list(scope, (await run).runId))[0]).toMatchObject({ status: "pending" });
  expect(sends).toBe(0);
  now = "2026-09-20T06:01:00.000Z";
  await store.close();
  stores.splice(stores.indexOf(store), 1);

  // A backup without bytes: the records are there, the reports are not.
  const backup = join(directories.create(), "snapshot");
  const manifest = await createSnapshot({
    dataDirectory: dir,
    outDirectory: backup,
    buildId: "routine-fixture",
    now,
    includeArtifacts: false,
    includeCredentials: false,
    force: false,
  });
  expect(manifest.includes).toMatchObject({ artifacts: false });
  expect(manifest.excluded.join(" ")).toMatch(/artifact/i);
  const restored = directories.create();
  await restoreSnapshot({ snapshotDirectory: backup, dataDirectory: restored, now });
  const reopened = await SqliteStore.open({ databasePath: join(restored, "tavi.sqlite"), artifactsDirectory: join(restored, "artifacts") });
  stores.push(reopened);
  // The restored owner rebuilds its services against the backup. The authorizer
  // is a deployment seam that production wires to real credential/authority
  // checks; this fixture answers yes so the case under test is the missing bytes
  // rather than a target the operator has not re-authorized.
  const restoredRoutines = await routineFixture(reopened, { executionAvailable: true, deliveryAuthorization: "available" });
  const restoredRuns = await executionFixture(restoredRoutines, { ownerEpoch: "second", now: () => now });
  // The run, its publication row and its grant survive …
  expect(
    ((await restoredRuns.get(scope, (await run).runId)).data as { publication?: { reportArtifactId: string } }).publication,
  ).toMatchObject({ reportArtifactId: (await published).reportArtifactId });
  expect((await (await restoredRuns.grantFor(scope, (await run).runId))!).destinationIds).toEqual([(await target).targetId]);
  // … the bytes do not, and the operator is told rather than left guessing.
  expect(await reopened.readArtifactBody((await published).pdfArtifactId!)).toBeUndefined();
  let resends = 0;
  const restoredDelivery = new RoutineDeliveryService(restoredRuns, {
    now: () => now,
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        resends++;
        throw new Error("must not send");
      },
    },
  });
  await restoredDelivery.drain();
  expect(resends).toBe(0);
  // The refusal names the artifact, which is the part an operator has to act on.
  expect((await (await restoredDelivery).list(scope, (await run).runId))[0]).toMatchObject({
    status: "failed",
    data: { error: "artifact_unavailable" },
  });
});
