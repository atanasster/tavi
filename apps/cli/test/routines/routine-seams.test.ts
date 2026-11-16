import { routineFixture, executionFixture } from "./routine-fixture.js";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { RoutineCreateSchema, TaviError, routineDefaults, type ModelPort, type RoutinesPayload } from "@tavi/contracts";
import { executeRoutinePipeline } from "../../src/features/routines/pipeline.js";
import {
  ToolRegistry,
  RoutineControlService,
  RoutineDeliveryService,
  RoutineEvaluationService,
  RoutineNewsService,
  RoutinePublicationService,
} from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { type CliIo, EXIT, main } from "../../src/main.js";
import { routineAction } from "../../src/features/routines/actions.js";
import { registerRoutineTools } from "../../src/features/routines/tools.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The seams an operator actually uses.
 *
 * The pieces are tested elsewhere; these tests drive the *wiring* — a real
 * `fireSchedule`, the chat tools against the real control service, the CLI route
 * through `main.ts`, and the control actions no first-party caller reaches. Each
 * one fails if the wiring is removed, not just if a unit misbehaves.
 */
const stores: SqliteStore[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  directories.cleanup();
});
const scope = { workspaceId: "default", principalId: "operator" };

async function fixture() {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const routines = await routineFixture(store, { executionAvailable: true, deliveryAuthorization: "available" });
  const runs = await executionFixture(routines, { ownerEpoch: "seams" });
  const news = new RoutineNewsService(runs);
  const publication = new RoutinePublicationService(runs);
  const delivery = new RoutineDeliveryService(runs, {
    messaging: {
      buildDestination: (_connectionId, target) => ({ chatId: target.to }),
      send: async () => {
        throw new Error("no sends");
      },
    },
  });
  const models: ModelPort = {
    stream: async (request) => ({
      attemptId: request.attemptId,
      status: "completed",
      usage: { totalTokens: 1 },
      toolCalls: [],
      text: JSON.stringify({ stories: [] }),
    }),
  };
  const evaluation = new RoutineEvaluationService(routines, { ownerEpoch: "seams", ready: () => true, models });
  const control = new RoutineControlService({
    routines,
    runs,
    news,
    publication,
    delivery,
    defaultModels: () => ({
      research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
    }),
    allowedHosts: ["example.com"],
    wake: () => {},
  });
  const created = (await control.execute({
    ...scope,
    action: "create",
    operationKey: "create",
    conversationId: "conversation",
    setup: { name: "Seams", objective: "Find news", timezone: "Europe/Sofia", at: "09:00" },
  })) as { routine: { routineId: string } };
  // Activated, because most seams are only reachable for a routine the owner is
  // actually admitting.
  await routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
  return { store, routines, runs, news, publication, delivery, evaluation, control, routineId: created.routine.routineId };
}

it("beats the service heartbeat only for routines the scheduler is still admitting", async () => {
  const f = await fixture();
  const before = f.store.handle.prepare("SELECT heartbeat_at FROM tavi_routine_state WHERE routine_id=?").get(f.routineId) as {
    heartbeat_at: string | null;
  };
  expect(before.heartbeat_at).toBeNull();
  await f.runs.serviceHeartbeat();
  expect(
    (
      f.store.handle.prepare("SELECT heartbeat_at FROM tavi_routine_state WHERE routine_id=?").get(f.routineId) as {
        heartbeat_at: string | null;
      }
    ).heartbeat_at,
  ).not.toBeNull();
  // A paused routine is not being admitted, so its heartbeat is not this
  // service's to claim — that is what makes a stale heartbeat meaningful.
  const version = (await f.routines.get(scope, f.routineId)).routine.version;
  await f.routines.setStatus(scope, f.routineId, version, "paused");
  f.store.handle.prepare("UPDATE tavi_routine_state SET heartbeat_at=NULL WHERE routine_id=?").run(f.routineId);
  await f.runs.serviceHeartbeat();
  expect(
    (
      f.store.handle.prepare("SELECT heartbeat_at FROM tavi_routine_state WHERE routine_id=?").get(f.routineId) as {
        heartbeat_at: string | null;
      }
    ).heartbeat_at,
  ).toBeNull();
});

it("drives the chat tools against the real control service, not a stub", async () => {
  const f = await fixture();
  const registry = new ToolRegistry();
  registerRoutineTools(registry, f.control);
  const context = { workspaceId: scope.workspaceId, principalId: scope.principalId, runId: "conversation", caller: "chat" };
  const listed = (await registry.get("routines.list")!.handler({ context, signal: AbortSignal.timeout(2000), input: {} })) as {
    routines: { routineId: string }[];
  };
  expect(await listed.routines.map((routine) => routine.routineId)).toEqual([f.routineId]);
  const version = (await f.routines.get(scope, f.routineId)).routine.version;
  const paused = (await registry
    .get("routines.pause")!
    .handler({ context, signal: AbortSignal.timeout(2000), input: { routineId: f.routineId, expectedVersion: version } })) as {
    routine: { status: string };
  };
  expect(paused.routine.status).toBe("paused");
  // The conversation link is what `routineId`-omitted calls resolve through, and
  // it is a property of the real service rather than of the tool.
  const resolved = (await registry.get("routines.get")!.handler({ context, signal: AbortSignal.timeout(2000), input: {} })) as {
    routine: { routineId: string };
  };
  expect(resolved.routine.routineId).toBe(f.routineId);
  await expect(
    registry.get("routines.get")!.handler({
      context: { workspaceId: scope.workspaceId, principalId: scope.principalId, runId: "unlinked", caller: "chat" },
      signal: AbortSignal.timeout(2000),
      input: {},
    }),
  ).rejects.toThrow(/no linked routine/);
});

it("archives, evaluates again, cancels a run and resumes a delivery target from chat, against the real control service", async () => {
  const f = await fixture();
  const registry = new ToolRegistry();
  registerRoutineTools(registry, f.control);
  const context = { workspaceId: scope.workspaceId, principalId: scope.principalId, runId: "conversation", caller: "chat" };
  const call = async (name: string, input: unknown) =>
    await registry.get(`routines.${name}`)!.handler({ context, signal: AbortSignal.timeout(2000), input });
  const health = () =>
    (
      JSON.parse(
        (f.store.handle.prepare("SELECT state_json FROM tavi_routine_state WHERE routine_id=?").get(f.routineId) as { state_json: string })
          .state_json,
      ) as { deliveryHealth?: Record<string, { failures: number }> }
    ).deliveryHealth;

  const run = await f.runs.request(scope, f.routineId, "manual");
  await f.runs.start(scope, run.runId);
  expect(await call("cancel_run", { runId: run.runId })).toMatchObject({ runId: run.runId, status: "cancelled" });
  await expect(call("cancel_run", { runId: "missing-run" })).rejects.toMatchObject({ code: "NOT_FOUND" });

  await f.routines.putTarget(scope, {
    ...scope,
    targetId: "chat",
    connectionId: "tg",
    chatId: "123",
    label: "Fixture chat",
    authorizationRef: "operator-destination-allowlist",
    enabled: true,
    createdAt: "2026-09-20T06:00:00.000Z",
  });
  f.store.handle
    .prepare("UPDATE tavi_routine_state SET state_json=json_set(state_json,'$.deliveryHealth',json(?)) WHERE routine_id=?")
    .run(JSON.stringify({ chat: { failures: 3, blockedSince: null, notified: true } }), f.routineId);
  // Omitted, the routine is this conversation's.
  expect(await call("resume_delivery", { targetId: "chat" })).toEqual({ resumed: true });
  expect(health()?.["chat"]).toMatchObject({ failures: 0 });
  await expect(call("resume_delivery", { targetId: "missing-target" })).rejects.toMatchObject({ code: "NOT_FOUND" });

  // Only a failed evaluation is run again; this routine's passed.
  const passed = await f.routines.get(scope, f.routineId);
  await expect(call("reevaluate", { expectedVersion: passed.routine.version })).rejects.toThrow(/Only a failed evaluation/);
  const failing = (await f.control.execute({
    ...scope,
    action: "create",
    operationKey: "create-failing",
    conversationId: "other",
    setup: { name: "Failing", objective: "Find news", timezone: "Europe/Sofia", at: "09:00" },
  })) as { routine: { routineId: string } };
  const failed = await f.routines.finishEvaluation(scope, failing.routine.routineId, 1, false, "provider down");
  expect(failed.evaluation.status).toBe("failed");
  const again = (await call("reevaluate", { routineId: failing.routine.routineId, expectedVersion: failed.routine.version })) as {
    evaluation: { status: string };
  };
  expect(again.evaluation.status).toBe("pending");

  const current = await f.routines.get(scope, f.routineId);
  const archived = (await call("archive", { expectedVersion: current.routine.version })) as {
    routine: { status: string; version: number };
  };
  expect(archived.routine.status).toBe("archived");
  await expect(call("archive", { expectedVersion: archived.routine.version })).rejects.toThrow(/already archived/);
  await expect(call("archive", { routineId: "missing-routine", expectedVersion: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("serves the control actions no first-party caller reaches", async () => {
  const f = await fixture();
  const run = await f.runs.request(scope, f.routineId, "manual");
  await f.runs.start(scope, (await run).runId);
  const explain = (await f.control.execute({ ...scope, action: "explain", routineId: f.routineId })) as {
    revision: unknown;
    deliveryReadiness: unknown[];
  };
  expect(explain).toMatchObject({ deliveryReadiness: [] });
  const history = (await f.control.execute({ ...scope, action: "history", routineId: f.routineId })) as { runs: { runId: string }[] };
  expect(await history.runs.map((entry) => entry.runId)).toEqual([(await run).runId]);
  // `update` takes a raw snapshot, `cancel` ends the run, `detach` and `artifact`
  // answer for themselves rather than 500ing.
  const current = await f.routines.get(scope, f.routineId);
  const updated = (await f.control.execute({
    ...scope,
    action: "update",
    operationKey: "raw",
    update: {
      routineId: f.routineId,
      operationKey: "raw",
      expectedVersion: (await current).routine.version,
      changeSummary: "Raw snapshot",
      snapshot: { ...(await current).revision.snapshot, objective: "Raw objective" },
    },
  })) as { revision: { revision: number } };
  expect(updated.revision.revision).toBe(2);
  const cancelled = (await f.control.execute({ ...scope, action: "cancel", runId: (await run).runId })) as { status: string };
  expect(cancelled.status).toBe("cancelled");
  await expect(
    (async () => await f.control.execute({ ...scope, action: "artifact", runId: (await run).runId, artifactKind: "json" }))(),
  ).rejects.toThrow(/unavailable|expired/i);
});

it("refuses run-now on a routine-owned schedule with the reason, through the CLI", async () => {
  const directory = directories.create("tavi-seam-");
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite") });
  stores.push(store);
  const routines = await routineFixture(store, { executionAvailable: true, deliveryAuthorization: "available" });
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
      permissions: { revision: 1, researchTools: ["web_search"], allowedHosts: ["example.com"], networkMode: "allowlist" },
    }),
  );
  await routines.finishEvaluation(scope, (await created).routine.routineId, 1, true, "pass");
  const schedule = (await store.asPort().repositories.schedules.list(scope.workspaceId))[0]!;
  await store.close();
  stores.length = 0;
  const out: string[] = [];
  const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => out.push(line) } as unknown as CliIo;
  // A model target must resolve before the routine check is reached, so the
  // connection is configured the way an operator would configure it.
  const added = await main(
    [
      "models",
      "add",
      "fixture",
      "--label",
      "Fixture",
      "--base-url",
      "http://127.0.0.1:1/v1",
      "--credential",
      "fixture.key",
      "--model",
      "fixture",
      "--data-dir",
      directory,
    ],
    { io },
  );
  expect(added, out.join("")).toBe(EXIT.ok);
  const code = await main(
    ["schedules", "run-now", schedule.scheduleId, "--connection", "fixture", "--model", "fixture", "--data-dir", directory],
    { io },
  );
  // The CLI route refuses a routine-owned schedule rather than admitting a run
  // that would bypass the routine's snapshot and policies.
  expect(code).toBe(EXIT.usage);
  expect(out.join("")).toContain("Use the routine run action to preserve its snapshot and policies");
});

it("drives a real schedule fire through the routine pipeline", async () => {
  const directory = directories.create("tavi-fire-");
  const modelled: string[] = [];
  // The sweep is off: this test fires the schedule itself, and the scheduler's
  // own first sweep at start would otherwise race it for the claim.
  const options = fixtureRuntimeOptions(directory, { defaultModel: "fixture", approvalRequiredFor: [], scheduleSweepEnabled: false });
  const runtime = await composeTaviRuntime(options, {
    modelOverride: {
      stream: async (request) => {
        modelled.push(request.model);
        // The research worker searches and reports evidence, before the root exists; the root then answers
        // with the selection the pipeline parses, from the evidence it is handed. Distinguishing them by the
        // pinned model keeps the script readable.
        if (request.model === "research") {
          const called = request.messages.some((message) => message.role === "tool");
          if (!called)
            return {
              attemptId: request.attemptId,
              status: "completed",
              text: "",
              toolCalls: [{ id: "search", name: "web_search", input: {} }],
              usage: { totalTokens: 5 },
            };
          return {
            attemptId: request.attemptId,
            status: "completed",
            text: "Fixture evidence",
            toolCalls: [],
            usage: { totalTokens: 5 },
          };
        }
        // The root's first call already holds the worker's evidence: no spawn step.
        expect(JSON.stringify(request.messages)).toContain("Fixture evidence");
        return {
          attemptId: request.attemptId,
          status: "completed",
          text: JSON.stringify({ stories: [] }),
          toolCalls: [],
          usage: { totalTokens: 5 },
        };
      },
    },
  });
  try {
    // A registered search tool, because a selection with no discovery and no
    // fetched page is refused — the pipeline's own guard, which this test should
    // exercise rather than route around.
    runtime.tools.register({
      id: "web_search",
      sink: "search",
      version: "1.0.0",
      description: "Fixture search",
      effect: "read-only",
      requiredPermissions: ["tools.invoke"],
      inputSchema: z.strictObject({}),
      handler: async () => ({ sources: [{ url: "https://example.com/release", snippet: "Model One version 2 is now available." }] }),
    });
    const routines = runtime.routines;
    const runs = runtime.routineRuns;
    const created = await routines.create(
      scope,
      RoutineCreateSchema.parse({
        ...routineDefaults("Europe/Sofia"),
        operationKey: "fire",
        name: "Fire",
        objective: "Find news",
        agent: { agentId: "news", name: "News", instructions: "Find evidence" },
        triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
        skills: [],
        models: {
          research: { primary: { connectionId: "fixture", model: "research" }, fallbacks: [] },
          synthesis: { primary: { connectionId: "fixture", model: "synthesis" }, fallbacks: [] },
        },
        permissions: { revision: 1, researchTools: ["web_search"], allowedHosts: ["example.com"], networkMode: "allowlist" },
      }),
    );
    await routines.finishEvaluation(scope, (await created).routine.routineId, 1, true, "pass");
    // The field is the reference handle to the composed workflow, and the fire
    // below reaches that same workflow through `deps.routineDispatch` — no seam is
    // substituted here, and the pipeline option is the substitution point.
    expect(typeof runtime.routineWorkflow).toBe("function");
    const schedule = (await runtime.store.asPort().repositories.schedules.list(scope.workspaceId)).find((entry) => entry.enabled)!;
    // Fire in the recent past: a catch-up window is bounded, so a synthetic
    // timestamp a day old is *correctly* recorded as missed.
    const firedAt = new Date(Date.now() - 1_000).toISOString();
    await runtime.store
      .asPort()
      .repositories.schedules.setEnabled({ scheduleId: schedule.scheduleId, enabled: true, nextRunAt: firedAt, now: firedAt });
    const deps = runtime.scheduleDependencies;
    if (deps === undefined) throw new Error("schedule dependencies are unavailable");
    const due = (await runtime.store.asPort().repositories.schedules.get(schedule.scheduleId))!;
    const outcome = await deps.routineDispatch!(due, due.nextRunAt!, false);
    // The fire claims the run and returns; the run itself is woken, not awaited,
    // so a long run never holds up the sweep that fired it.
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "routine", status: "queued" });
    await runs.drain();
    // The fire produced a durable run whose ledger records the workflow's effects.
    const runs_ = await runs.history(scope, (await created).routine.routineId);
    expect(runs_).toHaveLength(1);
    expect(runs_[0]?.status).toBe("succeeded");
    // Research first, then one synthesis call: the root no longer spends a call spawning its worker.
    expect(modelled).toEqual(["research", "research", "synthesis"]);
    // The chain the sweep really runs: dispatch -> pipeline -> workflow -> a
    // search and a publication, recorded in the run's ledger.
    const envelopes = (await runs.ledger(scope, (await created).routine.routineId)).map((event) => event.envelope);
    expect(envelopes.some((envelope) => envelope.code === "tool" && envelope.tool === "web_search")).toBe(true);
    expect(envelopes.some((envelope) => envelope.code === "published")).toBe(true);
  } finally {
    await runtime.close();
  }
});

it("prunes routine rows at most every 10 minutes, while the rest of the routine sweep runs every time", async () => {
  const directory = directories.create("tavi-prune-");
  const options = fixtureRuntimeOptions(directory, { defaultModel: "fixture", approvalRequiredFor: [], scheduleSweepEnabled: false });
  const runtime = await composeTaviRuntime(options, {
    modelOverride: {
      stream: async (request) => ({
        attemptId: request.attemptId,
        status: "completed",
        text: "",
        toolCalls: [],
        usage: { totalTokens: 1 },
      }),
    },
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const sweep = runtime.scheduleDependencies?.routineSweep;
    if (sweep === undefined) throw new Error("the routine sweep is unavailable");
    const serviceHeartbeat = vi.spyOn(runtime.routineRuns, "serviceHeartbeat");
    const pruneDueDetails = vi.spyOn(runtime.routineRuns, "pruneDueDetails");
    const pruneEvidence = vi.spyOn(runtime.routineNews, "pruneEvidence");
    const t0 = Date.parse("2026-10-10T10:00:00.000Z");
    const counts: number[][] = [];
    for (const at of [t0, t0 + 30_000, t0 + 10 * 60_000]) {
      vi.setSystemTime(at);
      await sweep();
      counts.push([pruneDueDetails.mock.calls.length, pruneEvidence.mock.calls.length]);
    }
    expect(counts).toEqual([
      [1, 1],
      [1, 1],
      [2, 2],
    ]);
    expect(serviceHeartbeat).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
    await runtime.close();
  }
});

it("refuses to create a routine on the unconfigured default placeholder, saying what to set", async () => {
  // `serve` with no model configured composes `default`/`default` so the owner
  // can start; a routine created then pinned that placeholder and could never
  // be evaluated. It is refused instead, with the fix in the message.
  const directory = directories.create("tavi-placeholder-");
  const runtime = await composeTaviRuntime({
    dataDirectory: directory,
    workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
    providers: [{ connectionId: "default", kind: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", credentialRef: "default.apiKey" }],
    credentials: {},
    defaultConnectionId: "default",
    defaultModel: "default",
    modelTargetUnconfigured: true,
    approvalRequiredFor: [],
    logger: { level: "error", sink: () => {} },
  });
  try {
    await expect(
      runtime.routineControl.execute({
        action: "create",
        workspaceId: "default",
        principalId: "operator",
        operationKey: "placeholder",
        setup: { name: "LLM news", objective: "Find news", at: "09:00", timezone: "Europe/Sofia" },
      }),
    ).rejects.toThrow(/No model is configured for routines\. Set a default model in Settings → Models/);
  } finally {
    await runtime.close();
  }
});

it("exposes the routines surface over IPC with no routines CLI subcommand", async () => {
  // The deliberate product boundary: the same actions are reachable from chat
  // tools, the Routines view and the owner IPC command, and `tavi routines` does
  // not exist. Recorded in docs/AUTOMATION.md.
  await expect(main(["routines", "list"], { io: { stdout: () => {}, stderr: () => {} } as unknown as CliIo })).resolves.toBeGreaterThan(0);
  // The IPC half: `serve.ts`'s `case "routines"` evaluates exactly this call with
  // the runtime's control service. Driving a real service is what the assertion is
  // about; a payload compared with the literal beside it would pass whatever the
  // routing did.
  const f = await fixture();
  const payload: RoutinesPayload = { action: "list", workspaceId: scope.workspaceId, principalId: scope.principalId };
  const listed = (await routineAction(f.control, payload)) as {
    routines: { routineId: string; lastRun: unknown; nextRunAt: unknown; triggers: { id: string }[] }[];
  };
  expect(await listed.routines.map((routine) => routine.routineId)).toEqual([f.routineId]);
  // `lastRun` is the control service's own mapping (a bare `RoutineService.list`
  // does not add it), so its presence shows the control path answered.
  expect(listed.routines[0]!.lastRun).toBeNull();
  // Each row carries its next fire and the current revision's triggers.
  expect(listed.routines[0]).toHaveProperty("nextRunAt");
  expect(listed.routines[0]!.triggers.length).toBeGreaterThan(0);
});

it("throws a render a shutdown rejected rather than publishing the run as degraded", async () => {
  const f = await fixture();
  const run = await f.runs.request(scope, f.routineId, "shutdown-render");
  const fence = (await f.runs.start(scope, run.runId))!;
  const admitted = await f.runs.get(scope, run.runId);
  const snapshot = { ...admitted.snapshot, report: { ...admitted.snapshot.report, formats: ["in-app", "pdf"] } };
  f.store.handle.prepare("UPDATE tavi_routine_runs SET snapshot_json=? WHERE run_id=?").run(JSON.stringify(snapshot), run.runId);
  const source = (await f.news.capture(
    fence,
    "http.request",
    { url: "https://example.com/model" },
    {
      ok: true,
      body:
        '<meta property="article:published_time" content="' +
        new Date(Date.now() - 3_600_000).toISOString() +
        '"><p>Model One version 2 is now available.</p>',
    },
  )) as { sourceId: string };
  const selection = {
    stories: [
      {
        title: "Release",
        releaseIdentity: "Model One version 2",
        eventKind: "release",
        claims: [{ text: "Model One version 2 is now available.", sourceId: source.sourceId }],
      },
    ],
  };
  const workflow = async () => ({
    taskId: "fixture",
    admissionId: "fixture",
    threadId: "fixture",
    created: true,
    replay: false,
    outcome: { status: "completed" as const, finalText: JSON.stringify(selection) },
  });
  const renderer = {
    capabilities: () => ({ available: true, provider: "fixture" }),
    renderPdf: async () => {
      throw new TaviError("UNAVAILABLE", "Background work is stopping");
    },
  };
  await expect(
    executeRoutinePipeline(
      { runs: f.runs, news: f.news, publication: f.publication, delivery: f.delivery, renderer, workflow, stopping: () => true },
      await f.runs.get(scope, run.runId),
      fence,
    ),
  ).rejects.toThrow(/stopping/);
  // Nothing was published: the drain leaves the run for the next owner to resume.
  expect(await f.publication.get(scope, run.runId)).toBeUndefined();
  expect((await f.runs.get(scope, run.runId)).status).toBe("running");
  // The same render failure outside a shutdown still degrades to the in-app report.
  await executeRoutinePipeline(
    { runs: f.runs, news: f.news, publication: f.publication, delivery: f.delivery, renderer, workflow, stopping: () => false },
    await f.runs.get(scope, run.runId),
    fence,
  );
  expect((await f.publication.get(scope, run.runId))?.pdfError).toMatch(/PDF generation failed/);
});
