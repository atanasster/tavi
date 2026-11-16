import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describeHeartbeatConformance, describeSignalSourceConformance } from "@tavi/plugin-kit/heartbeat/conformance";
import { defaultHeartbeatConfig, type HeartbeatConfig, type ModelRequest, type SandboxPort } from "@tavi/contracts";
import { temporaryDirectories, until } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { createQueueSource } from "../../../../tests/fixtures/heartbeat-queue-signals/index.mjs";
import { createRuleProvider } from "../../../../tests/fixtures/heartbeat-rule-provider/index.mjs";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { renderPluginValidation, validatePlugin } from "../../src/features/plugins/validate.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Replacing the heartbeat with plugins: a
 * rule-based provider with no model and a job-queue signal source, installed,
 * approved and enabled as any plugin is. Both pass the conformance kit the
 * built-in ones pass. In an owner, the rule provider answers in place of the
 * built-in one from the queue's signals; with egress off it is given nothing
 * of the person's; what it answers is held to the contract; stopping it in
 * the middle of a check stops the check and pauses the heartbeat; and
 * `plugins validate` reports both registrations.
 */

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "tests", "fixtures");
const RULES = join(FIXTURES, "heartbeat-rule-provider");
const QUEUE = join(FIXTURES, "heartbeat-queue-signals");
const QUIET = join(FIXTURES, "heartbeat-quiet-weekends-mod");
const AT = "2026-10-11T09:00:00.000Z";

declare global {
  // What the rule provider was given each tick: the fixture keeps it here.
  var __taviRuleProviderSeen: { instructions?: string; signals: number; recent: number; memory: number }[] | undefined;
}

const directories = temporaryDirectories({ prefix: "tavi-heartbeat-plugins-" });
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
  globalThis.__taviRuleProviderSeen = undefined;
});

const JOBS = [
  { id: "nightly-0", name: "nightly-cleanup", status: "failed", at: AT },
  { id: "report-1", name: "weekly-report", status: "done", at: AT },
];

/** A feed with one failed job and one that ran. */
function feed(): string {
  const path = join(directories.create(), "jobs.json");
  writeFileSync(path, JSON.stringify(JOBS));
  return path;
}

/** The nightly backup fails: a job new since the first look, which only seeds what is already there. */
function backupFails(path: string): void {
  writeFileSync(path, JSON.stringify([...JOBS, { id: "nightly-1", name: "nightly-backup", status: "failed", at: AT }]));
}

describeHeartbeatConformance("the rule provider (fixture plugin)", () => createRuleProvider());
describeSignalSourceConformance("the job queue (fixture plugin)", () => createQueueSource(feed()));

describe("heartbeat plugins in an owner", () => {
  const requests: ModelRequest[] = [];

  const compose = async (dataDirectory: string): Promise<TaviRuntime> => {
    const fixture = createFixtureModel({ turns: [{ text: "done" }] });
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(dataDirectory, {
        workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
        providers: [{ connectionId: "fixture", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "fixture" }],
        approvalRequiredFor: ["mutating", "external"],
        heartbeatEnabled: true,
      }),
      {
        modelOverride: {
          ...fixture,
          stream: async (request, options) => {
            requests.push(request);
            return await fixture.stream(request, options);
          },
        },
        heartbeatTiming: { sweepMs: 20, intervalFloorMs: 1_000 },
      },
    );
    runtimes.push(runtime);
    return runtime;
  };

  /** An owner running both fixture plugins (and the quiet-weekends mod, set as given), installed, approved, configured and enabled, and the queue's feed. */
  const owner = async (mod?: Record<string, string>): Promise<{ readonly runtime: TaviRuntime; readonly jobs: string }> => {
    const dataDirectory = directories.create();
    const jobs = feed();
    const setup = await compose(dataDirectory);
    const plugins: (readonly [string, string, Record<string, string>])[] = [
      [RULES, "fixture.rules", {}],
      [QUEUE, "fixture.queue", { feed: jobs }],
      ...(mod === undefined ? [] : [[QUIET, "fixture.quietweekends", mod] as const]),
    ];
    for (const [path, id, config] of plugins) {
      await setup.plugins.registry.install(path, "operator");
      await setup.plugins.registry.decide(id, "1.0.0", "approved", "operator");
      await setup.plugins.registry.configure(id, config, [], "operator");
      await setup.plugins.registry.enable(id, "operator");
    }
    runtimes.splice(runtimes.indexOf(setup), 1);
    await setup.close();
    return { runtime: await compose(dataDirectory), jobs };
  };

  /** A heartbeat on the rule provider, due now. */
  const due = async (runtime: TaviRuntime, config: Partial<HeartbeatConfig>): Promise<void> => {
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
        everyMs: 2_000,
        deepCheckEveryMs: 4_000,
        providerId: "fixture.rules",
        instructions: "Tell me when the nightly backup fails",
        activeHours: { start: "00:00", end: "23:59" },
        model: { connectionId: "fixture", model: "fixture-model" },
        ...config,
      },
    });
  };
  const ticks = async (runtime: TaviRuntime) =>
    await runtime.store.asPort().repositories.heartbeats.listTicks({ workspaceId: "default", principalId: "alice", limit: 50 });
  /** The next check that ran after the `after` checks already recorded. */
  const nextTick = async (runtime: TaviRuntime, after = 0) => {
    const ran = (rows: Awaited<ReturnType<typeof ticks>>) => rows.filter((row) => row.outcome !== "skipped" && row.kind !== "window");
    await until(
      async () => ran(await ticks(runtime)).length,
      (count) => count > after,
    );
    await runtime.heartbeat.host()?.idle();
    return ran(await ticks(runtime)).at(-1 - after);
  };
  /** The first look, which seeds the feed's jobs as seen; then the backup fails, and the check after it. */
  const lookThenFail = async (runtime: TaviRuntime, jobs: string) => {
    await nextTick(runtime);
    backupFails(jobs);
    return await until(
      async () => (await ticks(runtime)).find((row) => row.outcome === "reported" || (row.outcome !== "skipped" && row.kind === "signal")),
      (row) => row !== undefined,
    );
  };
  const told = async (runtime: TaviRuntime) =>
    await runtime.store
      .asPort()
      .repositories.heartbeats.recentItems({ workspaceId: "default", principalId: "alice", since: "2000-01-01T00:00:00.000Z", limit: 50 });

  it("installs the rule provider and the queue source, and the rule provider answers in place of the built-in one, with no model", async () => {
    requests.length = 0;
    const { runtime, jobs } = await owner();
    expect(runtime.heartbeat.providers.ids()).toContain("fixture.rules");
    expect(runtime.heartbeat.signals.list().map((source) => source.id)).toContain("fixture.queue.queue");
    await due(runtime, { providerEgress: { instructions: true, signals: true, ledger: false, memory: false } });
    expect(await lookThenFail(runtime, jobs)).toMatchObject({ providerId: "fixture.rules", outcome: "reported", itemsNow: 1 });
    await runtime.heartbeat.host()?.idle();
    expect((await told(runtime)).map((item) => [item.key, item.title])).toEqual([
      ["rules:fixture.queue.queue:job:nightly-1", "Job nightly-backup failed"],
    ]);
    expect(requests).toEqual([]);
  });

  it("gives a provider with egress off nothing of the person's, and gives memory and the ledger to none that did not ask for them", async () => {
    const { runtime, jobs } = await owner();
    // Memory the person has, which a provider that did not ask for it must still not be given.
    await runtime.memory.remember({
      actor: { workspaceId: "default", principalId: "alice", caller: "test", authority: "operator" },
      scope: { kind: "personal", principalId: "alice" },
      kind: "preference",
      body: "Tell me about backups only in the morning",
      preferenceKey: "backups",
      preference: { valueType: "string", value: "morning" },
    });
    // Every switch on: a provider still receives only what its manifest asked for (instructions and signals).
    await due(runtime, { providerEgress: { instructions: true, signals: true, ledger: true, memory: true } });
    const looked = await lookThenFail(runtime, jobs);
    // The check gathered the person's memory: the provider was kept from it, not spared it for want of any.
    expect((looked?.inputs as { memory?: unknown[] } | null)?.memory?.length ?? 0).toBeGreaterThan(0);
    expect(globalThis.__taviRuleProviderSeen?.at(-1)).toEqual({
      instructions: "Tell me when the nightly backup fails",
      signals: 1,
      recent: 0,
      memory: 0,
    });
    // The first owner stops first: it ticks on with every switch on, and the fixture records into one global.
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await runtime.close();
    const off = await owner();
    globalThis.__taviRuleProviderSeen = undefined;
    await due(off.runtime, {});
    await nextTick(off.runtime);
    backupFails(off.jobs);
    expect(await nextTick(off.runtime, 1)).toMatchObject({ providerId: "fixture.rules", outcome: "quiet" });
    for (const seen of globalThis.__taviRuleProviderSeen ?? []) expect(seen).toEqual({ signals: 0, recent: 0, memory: 0 });
  });

  it("holds what a provider answers to the contract: 50 items are cut to 10, and an unknown field or a 1 MB body is refused", async () => {
    const flooded = await owner();
    await due(flooded.runtime, {
      instructions: "test: flood",
      providerEgress: { instructions: true, signals: true, ledger: false, memory: false },
    });
    await nextTick(flooded.runtime);
    expect((await told(flooded.runtime)).length).toBe(10);
    const odd = await owner();
    await due(odd.runtime, {
      instructions: "Tell me when the nightly backup fails\ntest: extra-field\ntest: huge",
      providerEgress: { instructions: true, signals: true, ledger: false, memory: false },
    });
    await lookThenFail(odd.runtime, odd.jobs);
    await odd.runtime.heartbeat.host()?.idle();
    expect((await told(odd.runtime)).map((item) => item.key)).toEqual(["rules:fixture.queue.queue:job:nightly-1"]);
  });

  it("lets a mod make an urgent item wait for the summary, or hold it back with a masked decision row", async () => {
    const every = "Mon,Tue,Wed,Thu,Fri,Sat,Sun";
    const quiet = await owner({ days: every });
    await due(quiet.runtime, { providerEgress: { instructions: true, signals: true, ledger: false, memory: false } });
    expect(await lookThenFail(quiet.runtime, quiet.jobs)).toMatchObject({
      providerId: "fixture.rules",
      outcome: "reported",
      itemsNow: 0,
      itemsLater: 1,
    });
    await quiet.runtime.heartbeat.host()?.idle();
    expect((await told(quiet.runtime)).map((item) => [item.key, item.urgency, item.state])).toEqual([
      ["rules:fixture.queue.queue:job:nightly-1", "later", "told"],
    ]);
    const held = await owner({ days: "", hold: "rules:" });
    await due(held.runtime, { providerEgress: { instructions: true, signals: true, ledger: false, memory: false } });
    const tick = await lookThenFail(held.runtime, held.jobs);
    await held.runtime.heartbeat.host()?.idle();
    expect(tick).toMatchObject({
      outcome: "quiet",
      itemsNow: 0,
      hookDecisions: [{ key: "rules:fixture.queue.queue:job:nightly-1", by: "fixture.quietweekends", action: "held back" }],
    });
    expect((await told(held.runtime)).map((item) => item.state)).toEqual(["filtered"]);
    const rows = await held.runtime.store.asPort().repositories.plugins.listHookEvents("fixture.quietweekends", 10);
    expect(rows).toEqual([
      expect.objectContaining({ kind: "decision", event: "heartbeat.item", detail: "held back: Held back: Job nightly-backup failed" }),
    ]);
  });

  it("stops a check when its provider is disabled in the middle of it, and pauses the heartbeat", async () => {
    const { runtime } = await owner();
    await due(runtime, {
      instructions: "test: hang",
      providerEgress: { instructions: true, signals: false, ledger: false, memory: false },
    });
    await until(
      async () => globalThis.__taviRuleProviderSeen?.length ?? 0,
      (seen) => seen > 0,
    );
    await runtime.plugins.registry.disable("fixture.rules", "operator");
    expect(await nextTick(runtime)).toMatchObject({
      providerId: "fixture.rules",
      outcome: "failed",
      error: "the heartbeat provider stopped during the check",
    });
    expect((await runtime.store.asPort().repositories.heartbeats.get("default", "alice"))?.config.paused).toMatchObject({
      reason: "provider",
    });
  });
});

describe("plugins validate", () => {
  /** Runs the command unconfined, as the sandbox would with everything allowed. */
  const direct: SandboxPort = {
    capabilities: () => ({ available: true, platforms: ["darwin"] }),
    run: async (_policy, command) => {
      const run = spawnSync(command.command, [...(command.args ?? [])], { cwd: command.cwd, encoding: "utf8" });
      return {
        session: { sessionId: "s", state: "completed" },
        exitCode: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        truncated: false,
      };
    },
    cancel: async () => {},
    dispose: async () => {},
  };

  it("reports a heartbeat provider and its signal sources", async () => {
    const rules = await validatePlugin(RULES, { sandbox: direct, platform: "darwin" });
    expect(rules).toMatchObject({ problems: [], warnings: [], registered: { heartbeat: { tick: true } } });
    expect(renderPluginValidation(RULES, rules)).toContain(", a heartbeat provider");
    const queue = await validatePlugin(QUEUE, { sandbox: direct, platform: "darwin" });
    expect(queue).toMatchObject({ problems: [], registered: { signals: ["queue"] } });
    expect(renderPluginValidation(QUEUE, queue)).toContain("1 heartbeat signal source (queue)");
    const mod = await validatePlugin(QUIET, { sandbox: direct, platform: "darwin" });
    expect(mod).toMatchObject({ problems: [], warnings: [], registered: { hooks: [{ event: "heartbeat.item", hook: true }] } });
  });
});
