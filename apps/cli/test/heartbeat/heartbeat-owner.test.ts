import { HEARTBEAT_LIMITS, defaultHeartbeatConfig, type ModelOutcome, type ModelPort, type ModelRequest } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime, TaviRuntimeOptions, TaviRuntimeOverrides } from "../../src/runtime/types.js";
import { main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { buildDoctorDocument } from "../../src/features/doctor/reports.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The heartbeat host in a composed owner: it runs
 * only where `serve` asks for it, not at all while `tavi.heartbeat` is
 * disabled, sweeps on the test's timing, and is reported by `tavi doctor`.
 */

const directories = temporaryDirectories({ prefix: "tavi-heartbeat-owner-" });
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

const quiet: CliIo = { stdout: () => undefined, stderr: () => undefined, isTty: false };

async function compose(
  dataDirectory: string,
  extra: Partial<TaviRuntimeOptions> = {},
  overrides: Partial<TaviRuntimeOverrides> = {},
): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(dataDirectory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      // The heartbeat's own model names this connection, so choosing it for a turn is accepted; the fixture model answers.
      providers: [{ connectionId: "fixture", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "fixture" }],
      approvalRequiredFor: ["mutating", "external"],
      ...extra,
    }),
    { modelOverride: createFixtureModel({ turns: [] }), heartbeatTiming: { sweepMs: 20, intervalFloorMs: 1_000 }, ...overrides },
  );
  runtimes.push(runtime);
  return runtime;
}

/** An enabled heartbeat, due now, with instructions to look at, on the fixture model. */
async function saveDueHeartbeat(runtime: TaviRuntime): Promise<void> {
  const now = new Date(runtime.clock.now()).toISOString();
  await runtime.store.asPort().repositories.heartbeats.save({
    workspaceId: "default",
    principalId: "alice",
    expectedRevision: 0,
    author: "test",
    now,
    nextTickAt: now,
    config: {
      ...defaultHeartbeatConfig(),
      enabled: true,
      instructions: "Tell me if a payment fails",
      activeHours: { start: "00:00", end: "23:59" },
      model: { connectionId: "fixture", model: "fixture-model" },
    },
  });
}

/** A model that answers each call with `step(n, request)`, recording every request. */
function scriptedModel(
  step: (n: number, request: ModelRequest) => Pick<ModelOutcome, "text" | "toolCalls">,
): ModelPort & { readonly requests: ModelRequest[] } {
  const fixture = createFixtureModel({ turns: [{ text: "done" }] });
  const requests: ModelRequest[] = [];
  return {
    ...fixture,
    requests,
    stream: async (request: ModelRequest): Promise<ModelOutcome> => {
      requests.push(request);
      const answer = step(requests.length, request);
      return {
        status: "completed",
        attemptId: request.attemptId,
        text: answer.text,
        toolCalls: answer.toolCalls,
        ...(answer.toolCalls.length === 0 ? {} : { finishReason: "tool-calls" as const }),
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      };
    },
  };
}

const REPORTED = { key: "billing:payment:pay_1", urgency: "now", title: "A payment failed", sources: [{ label: "Billing" }] };

/** Wait for the first recorded tick. */
async function firstTick(runtime: TaviRuntime) {
  const deadline = Date.now() + 10_000;
  while ((await ticks(runtime)).length === 0 && Date.now() < deadline) await delay(20);
  await runtime.heartbeat.host()?.idle();
  return (await ticks(runtime))[0];
}

async function ticks(runtime: TaviRuntime) {
  return await runtime.store.asPort().repositories.heartbeats.listTicks({ workspaceId: "default", principalId: "alice", limit: 50 });
}

describe("the heartbeat host in an owner", () => {
  it("runs only where serve asks for it", async () => {
    expect((await compose(directories.create())).heartbeat.host()).toBeUndefined();
    expect((await compose(directories.create(), { heartbeatEnabled: true })).heartbeat.host()).toBeDefined();
    expect((await compose(directories.create(), { heartbeatEnabled: true, scheduleSweepEnabled: false })).heartbeat.host()).toBeUndefined();
  });

  it("offers sub-minute choices only to an owner started with a test floor", async () => {
    const tested = await compose(directories.create());
    expect(tested.heartbeat.options.every.slice(0, 2)).toEqual([2_000, 4_000]);
    expect(tested.heartbeat.options.deepCheckEvery[0]).toBe(4_000);
    const production = await compose(directories.create(), {}, { heartbeatTiming: {} });
    expect(Math.min(...production.heartbeat.options.every)).toBe(15 * 60_000);
  });

  it("sweeps an enabled heartbeat end to end: with no provider installed it pauses, says why, and doctor reports it", async () => {
    const dataDirectory = directories.create();
    expect(await main(["plugins", "disable", "tavi.heartbeatagent", "--data-dir", dataDirectory], { io: quiet })).toBe(0);
    const runtime = await compose(dataDirectory, { heartbeatEnabled: true });
    await saveDueHeartbeat(runtime);
    const deadline = Date.now() + 10_000;
    while ((await ticks(runtime)).length === 0 && Date.now() < deadline) await delay(20);
    expect((await ticks(runtime))[0]).toMatchObject({ outcome: "skipped", reason: "provider-unavailable" });
    const state = await runtime.store.asPort().repositories.heartbeats.get("default", "alice");
    expect(state?.config.paused).toEqual({ reason: "provider" });
    const doctor = await buildDoctorDocument(runtime, { integrity: "skip" });
    // Its skipped check is no check that ran: counted as Center → Heartbeat counts them.
    expect(doctor.heartbeat).toMatchObject({
      host: true,
      configured: true,
      enabled: true,
      providerId: "tavi.heartbeatagent",
      providerReady: false,
      paused: { reason: "provider" },
      today: { checks: 0 },
    });
  });

  it("reports what a provider says of itself in doctor, masked, with a warning when it is not ready", async () => {
    const runtime = await compose(directories.create());
    runtime.heartbeat.providers.install("acme.watch", {
      provider: {
        tick: async () => ({ items: [] }),
        status: () => ({ ready: false, detail: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 expired" }),
      },
      kind: "plugin",
      receives: [],
      usesTurns: false,
      maxTickSeconds: 5,
    });
    const heartbeats = runtime.store.asPort().repositories.heartbeats;
    await heartbeats.save({
      workspaceId: "default",
      principalId: "alice",
      config: { ...defaultHeartbeatConfig(), providerId: "acme.watch" },
      expectedRevision: 0,
      author: "test",
      now: nowTimestamp(),
    });
    const off = await buildDoctorDocument(runtime, { integrity: "skip" });
    expect(off.heartbeat).toMatchObject({
      providerId: "acme.watch",
      providerReady: true,
      providerStatus: { ready: false, detail: expect.stringContaining("expired") },
    });
    expect(JSON.stringify(off.heartbeat)).not.toContain("sk-ant-api03");
    // Off, it is no warning; on, it is.
    expect(off.heartbeat).not.toHaveProperty("warning");
    await heartbeats.save({
      workspaceId: "default",
      principalId: "alice",
      config: { ...defaultHeartbeatConfig(), providerId: "acme.watch", enabled: true },
      expectedRevision: 1,
      author: "test",
      now: nowTimestamp(),
    });
    expect((await buildDoctorDocument(runtime, { integrity: "skip" })).heartbeat).toMatchObject({
      warning: expect.stringContaining("acme.watch says it is not ready"),
    });
  });

  it("runs the built-in provider's turn: what it reports through heartbeat.report is recorded, with its task and usage", async () => {
    const model = scriptedModel((n) =>
      n === 1
        ? { text: "", toolCalls: [{ id: "call-report", name: "heartbeat.report", input: { items: [REPORTED] } }] }
        : { text: "Reported.", toolCalls: [] },
    );
    const runtime = await compose(directories.create(), { heartbeatEnabled: true }, { modelOverride: model });
    await saveDueHeartbeat(runtime);
    const tick = await firstTick(runtime);
    expect(tick).toMatchObject({
      outcome: "reported",
      kind: "deep",
      itemsNow: 1,
      itemsLater: 0,
      providerId: "tavi.heartbeatagent",
      tokens: 220,
    });
    expect(tick?.taskId).toBeTruthy();
    // Doctor sums today's spending from the turn's attempts; an unpriced model's dollars are unknown, never zero.
    expect((await buildDoctorDocument(runtime, { integrity: "skip" })).heartbeat).toMatchObject({
      today: { checks: 1, modelTicks: 1, tokens: 220, usd: "unknown" },
    });
    // What it reported is in the ledger, told once.
    expect(
      await runtime.store
        .asPort()
        .repositories.heartbeats.ledgerRows({ workspaceId: "default", principalId: "alice", keys: [REPORTED.key] }),
    ).toMatchObject([{ key: REPORTED.key, state: "told", urgency: "now" }]);
    // The turn saw the allowlist and nothing else, and its prompt fenced the instructions.
    const offered = model.requests[0]?.tools.map((tool) => tool.id).sort();
    expect(offered).toContain("heartbeat.report");
    // Every step's output is capped, so its reservation has a ceiling.
    expect(model.requests[0]?.maxOutputTokens).toBe(HEARTBEAT_LIMITS.turnOutputTokens);
    for (const id of offered ?? [])
      expect([
        "heartbeat.report",
        "memory.get",
        "memory.search",
        "projects.get",
        "reminders.list",
        "reports.history",
        "sessions.search",
      ]).toContain(id);
    expect(model.requests[0]?.messages.map((message) => message.text).join("\n")).toContain(
      '<untrusted source="instructions">\nTell me if a payment fails\n</untrusted>',
    );
  });

  it("forgets a heartbeat's history: its ledger, log and settled tasks go", async () => {
    const model = scriptedModel((n) =>
      n === 1
        ? { text: "", toolCalls: [{ id: "call-report", name: "heartbeat.report", input: { items: [REPORTED] } }] }
        : { text: "Reported.", toolCalls: [] },
    );
    const runtime = await compose(directories.create(), { heartbeatEnabled: true }, { modelOverride: model });
    await saveDueHeartbeat(runtime);
    const tick = await firstTick(runtime);
    const repositories = runtime.store.asPort().repositories;
    expect(await repositories.tasks.get(tick?.taskId ?? "")).toBeDefined();
    expect(await runtime.heartbeat.forget("default", "alice")).toMatchObject({ ticks: 1, items: 1, tasks: 1 });
    expect(await repositories.tasks.get(tick?.taskId ?? "")).toBeUndefined();
    expect(await ticks(runtime)).toEqual([]);
    expect(await repositories.heartbeats.ledgerRows({ workspaceId: "default", principalId: "alice", keys: [REPORTED.key] })).toEqual([]);
  });

  it("records a turn that only writes prose as quiet: nothing is reported", async () => {
    const model = scriptedModel(() => ({ text: "A payment failed! You should look at it.", toolCalls: [] }));
    const runtime = await compose(directories.create(), { heartbeatEnabled: true }, { modelOverride: model });
    await saveDueHeartbeat(runtime);
    expect(await firstTick(runtime)).toMatchObject({ outcome: "quiet", itemsNow: 0, itemsLater: 0 });
  });

  it("passes the provider's own hooks over in the turn it asked for, and names it to every other plugin's", async () => {
    const model = scriptedModel((n) =>
      n === 1
        ? { text: "", toolCalls: [{ id: "call-search", name: "memory.search", input: { query: "payment" } }] }
        : { text: "Nothing to tell.", toolCalls: [] },
    );
    const runtime = await compose(directories.create(), { heartbeatEnabled: true }, { modelOverride: model });
    const called: string[] = [];
    for (const pluginId of ["tavi.heartbeatagent", "acme.watcher"]) {
      runtime.turnHooks.register(pluginId, [{ event: "tool.call", disclosure: "test" }], "tool.call", undefined, async (event, next) => {
        called.push(`${pluginId}:${event.envelope.heartbeatProvider ?? ""}`);
        return await next(event);
      });
    }
    await saveDueHeartbeat(runtime);
    expect(await firstTick(runtime)).toMatchObject({ outcome: "quiet" });
    expect(called).toEqual(["acme.watcher:tavi.heartbeatagent"]);
  });

  it("stops a heartbeat turn at its step cap", async () => {
    const model = scriptedModel((n) => ({ text: "", toolCalls: [{ id: `call-${n}`, name: "reminders.list", input: {} }] }));
    const runtime = await compose(directories.create(), { heartbeatEnabled: true }, { modelOverride: model });
    await saveDueHeartbeat(runtime);
    await firstTick(runtime);
    expect(model.requests.length).toBeGreaterThan(1);
    expect(model.requests.length).toBeLessThanOrEqual(HEARTBEAT_LIMITS.turnSteps);
  });

  it("looks soon after a run fails, between its scheduled checks", async () => {
    const model = scriptedModel(() => ({ text: "Nothing to tell.", toolCalls: [] }));
    const runtime = await compose(
      directories.create(),
      { heartbeatEnabled: true },
      { modelOverride: model, heartbeatTiming: { sweepMs: 20, intervalFloorMs: 1_000, eventDebounceMs: 10 } },
    );
    const repositories = runtime.store.asPort().repositories;
    const now = new Date(runtime.clock.now());
    // Not due for an hour, with its last deep look just now: only an event makes it look.
    await repositories.heartbeats.save({
      workspaceId: "default",
      principalId: "alice",
      expectedRevision: 0,
      author: "test",
      now: now.toISOString(),
      nextTickAt: new Date(now.getTime() + 3_600_000).toISOString(),
      config: {
        ...defaultHeartbeatConfig(),
        enabled: true,
        instructions: "Tell me if a payment fails",
        activeHours: { start: "00:00", end: "23:59" },
        model: { connectionId: "fixture", model: "fixture-model" },
      },
    });
    const written = await repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "alice",
      operationKey: "failing-run",
      kind: "start",
      intent: { prompt: "export the report" },
      checkpointNamespace: "",
      newTaskId: "run-1",
      newAdmissionId: "adm-run-1",
      newThreadId: "thread-run-1",
      now: now.toISOString(),
    });
    await repositories.tasks.commitAdmission({
      admissionId: written.admission.admissionId,
      taskId: "run-1",
      state: "committed",
      result: { status: "completed", finalText: "" },
    });
    await repositories.tasks.updateStatus("run-1", "failed", null);
    runtime.runEventBus.markCompleted("run-1");
    expect(await firstTick(runtime)).toMatchObject({ wakeReason: "event", outcome: "quiet" });
  });

  it("ticks nothing while tavi.heartbeat is disabled: the global kill switch", async () => {
    const dataDirectory = directories.create();
    expect(await main(["plugins", "disable", "tavi.heartbeat", "--data-dir", dataDirectory], { io: quiet })).toBe(0);
    const runtime = await compose(dataDirectory, { heartbeatEnabled: true });
    expect(runtime.heartbeat.host()).toBeUndefined();
    await saveDueHeartbeat(runtime);
    await delay(200);
    expect(await ticks(runtime)).toEqual([]);
  });
});
