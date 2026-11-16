import { cpSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoutineCreateSchema, routineDefaults, type InvocationContext } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories } from "@tavi/test-support";
import { z } from "zod";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { main } from "../../src/main.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/** A plugin with every hook event, through a real owner's turn. */

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "mod-guard");
const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});
const temp = () => {
  const path = dirs.create("tavi-mods-e2e-");
  return path;
};
const workspaces = [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] }];
const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "r", caller: "test" };

async function compose(dataDirectory: string, turns: readonly ScriptedTurn[] = []): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(
    fixtureServeOptions(dataDirectory, { workspaces }),
    turns.length === 0 ? { requireModelTransport: false } : { modelOverride: createFixtureModel({ turns }) },
  );
  runtimes.push(runtime);
  return runtime;
}

/** Install, approve and enable the fixture in `dataDir`, with no owner left running. */
async function installPlugin(dataDir: string): Promise<void> {
  const source = temp();
  cpSync(FIXTURE, source, { recursive: true });
  const setup = await compose(dataDir);
  await setup.plugins.registry.install(source, "operator");
  await setup.plugins.registry.decide("acme.modguard", "1.0.0", "approved", "operator");
  await setup.plugins.registry.enable("acme.modguard", "operator");
  runtimes.splice(runtimes.indexOf(setup), 1);
  await setup.close();
}

async function installed(turns: readonly ScriptedTurn[], dataDir = temp()): Promise<TaviRuntime> {
  await installPlugin(dataDir);
  return compose(dataDir, turns);
}

describe("mods end to end", () => {
  it("runs every hook through a turn, refuses what the guard denies, and audits the decision", async () => {
    const runtime = await installed([
      { toolCall: { id: "c1", name: "plan.update", input: { items: [{ content: "Delete the build folder", status: "pending" }] } } },
      { toolCall: { id: "c2", name: "plan.update", input: { items: [{ content: "Read the logs", status: "in_progress" }] } } },
      { text: "done" },
    ]);
    if (runtime.workflow === undefined) throw new Error("workflow unavailable");
    const result = await runtime.workflow.admit({ context, operationKey: "op-e2e", kind: "start", prompt: "plan it" });
    expect(result.outcome.status).toBe("completed");
    const stored = () => runtime.store.asPort().repositories.plugins.loadPluginState("acme.modguard");
    // The observers are never awaited by the turn: wait for the last of them.
    await vi.waitFor(async () => expect(((await stored())["counts"] as Record<string, number> | undefined)?.["turn.complete"]).toBe(1), {
      timeout: 5_000,
    });
    const counts = (await stored())["counts"] as Record<string, number>;
    expect(counts).toMatchObject({
      "prompt.submit": 1,
      "turn.start": 1,
      "tool.check": 2,
      "tool.call": 1,
      "tool.result": 1,
      "turn.complete": 1,
    });
    expect(counts["model.step"]).toBeGreaterThanOrEqual(3);
    // Its status and notice on the task's own stream; a forged envelope shows nothing.
    await vi.waitFor(async () => expect((await stored())["forged"]).toBeDefined(), { timeout: 5_000 });
    const { replayed } = runtime.runEventBus.subscribe({ taskId: result.taskId, from: "beginning", deliver: () => {} });
    expect(replayed.filter((event) => event.kind.startsWith("plugin."))).toMatchObject([
      { kind: "plugin.status", pluginId: "acme.modguard", line: "turns: 1" },
      { kind: "plugin.notice", pluginId: "acme.modguard", notice: "the turn is done" },
    ]);
    expect((await stored())["forged"]).toBe("refused");
    // Its suggestion arrives with the turn, before its end.
    const kinds = replayed.map((event) => event.kind);
    expect(replayed.find((event) => event.kind === "turn.suggested")).toMatchObject({ suggestions: ["Run the tests"] });
    expect(kinds.indexOf("turn.suggested")).toBeLessThan(kinds.indexOf("task.completed"));
    const view = await runtime.plugins.registry.show("acme.modguard", runtime.plugins);
    expect(view.mods).toHaveLength(7);
    // Two decisions: the prompt's added block, then the refused step.
    await vi.waitFor(
      async () => expect((await runtime.plugins.registry.show("acme.modguard", runtime.plugins)).hookActivity?.decisions).toBe(2),
      { timeout: 5_000 },
    );
    expect((await runtime.plugins.registry.show("acme.modguard", runtime.plugins)).hookActivity?.recent[0]).toMatchObject({
      kind: "decision",
      event: "tool.check",
      tool: "plan.update",
      ruleId: "mod:acme.modguard",
      detail: "allow → deny: A plan may not say delete.",
    });
  });

  it("runs the hooks in an in-process `tavi run` as in the owner", async () => {
    const dataDir = temp();
    await installPlugin(dataDir);
    const model = createFixtureModel({
      turns: [
        { toolCall: { id: "c1", name: "plan.update", input: { items: [{ content: "Delete it all", status: "pending" }] } } },
        { text: "done" },
      ],
    });
    let stderr = "";
    const code = await main(["run", "--connection", "fixture-conn", "--model", "fixture-model", "--data-dir", dataDir, "plan it"], {
      io: { stdout: () => {}, stderr: (text) => void (stderr += text), isTty: false },
      runtimeFactory: (options) => composeTaviRuntime(options, { modelOverride: model }),
    });
    expect(code, stderr).toBe(0);
    // The prompt hook added its block; the guard refused the step that says delete.
    expect(JSON.stringify(model.calls[0]?.messages)).toContain("the fixture saw this prompt");
    expect(JSON.stringify(model.calls[1]?.messages)).toContain("A plan may not say delete.");
    const after = await compose(dataDir);
    expect(
      (await after.store.asPort().repositories.plugins.loadPluginState("acme.modguard"))["counts"] as Record<string, number>,
    ).toMatchObject({ "prompt.submit": 1, "tool.check": 1 });
  });

  it("gives a composed routine run the hooks and the redaction setting", async () => {
    const scope = { workspaceId: "default", principalId: "operator" };
    const runtime = await composeTaviRuntime(
      {
        dataDirectory: temp(),
        workspaces,
        providers: [],
        credentials: {},
        defaultConnectionId: "fixture",
        defaultModel: "fixture",
        approvalRequiredFor: [],
        logger: { level: "error", sink: () => {} },
        scheduleSweepEnabled: false,
      },
      {
        modelOverride: {
          stream: async (request) => {
            const base = { attemptId: request.attemptId, status: "completed" as const, usage: { totalTokens: 5 } };
            const called = request.messages.some((message) => message.role === "tool");
            if (request.model === "research")
              return called
                ? { ...base, text: "Fixture evidence", toolCalls: [] }
                : { ...base, text: "", toolCalls: [{ id: "search", name: "web_search", input: {} }] };
            return called
              ? { ...base, text: "Summary", toolCalls: [] }
              : {
                  ...base,
                  text: "",
                  toolCalls: [
                    {
                      id: "spawn",
                      name: "agents.spawn",
                      input: { agentDefinitionId: "news", input: "Find evidence", operationKey: "research" },
                    },
                  ],
                };
          },
        },
      },
    );
    runtimes.push(runtime);
    runtime.tools.register({
      id: "web_search",
      sink: "search",
      version: "1.0.0",
      description: "Fixture search",
      effect: "read-only",
      requiredPermissions: ["tools.invoke"],
      inputSchema: z.strictObject({}),
      handler: async () => ({ sources: [{ url: "https://example.com/release", snippet: "key AKIAIOSFODNN7EXAMPLE" }] }),
    });
    const seen: { source: string; output: unknown }[] = [];
    runtime.turnHooks.register(
      "acme.watch",
      [{ event: "tool.result", match: { tools: ["web_search"] }, disclosure: "Reads search results." }],
      "tool.result",
      undefined,
      async (e, next) => {
        seen.push({ source: e.envelope.source, output: e.output });
        return next(e);
      },
    );
    // One routine per run: a second manual request of the same routine is the same run.
    const fire = async (name: string, count: number) => {
      const created = await runtime.routines.create(
        scope,
        RoutineCreateSchema.parse({
          ...routineDefaults("Europe/Sofia"),
          operationKey: name,
          name,
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
      await runtime.routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
      await runtime.routineRuns.request(scope, created.routine.routineId, "manual");
      // The owner wakes its queue on a sweep; drained here so the test waits for no timer.
      await runtime.routineRuns.drain();
      await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(count), { timeout: 10_000 });
    };
    await fire("Masked", 1);
    // The search runs in the routine's research worker (origin `agent`), its result masked before the hook reads it.
    expect(seen).toMatchObject([{ source: "agent", output: { sources: [{ excerpt: "key [redacted:aws-key]" }] } }]);
    // Turned off for the workspace, a routine's results reach hooks as the tool gave them.
    const settings = runtime.store.asPort().repositories.workspaceSettings;
    const current = await settings.get("default");
    await settings.set({
      workspaceId: "default",
      settings: { ...current.settings, redactToolResults: false },
      expectedRevision: current.revision,
      actor: "operator",
      now: nowTimestamp(),
    });
    await fire("Plain", 2);
    expect(seen.at(-1)).toMatchObject({ output: { sources: [{ excerpt: "key AKIAIOSFODNN7EXAMPLE" }] } });
  });

  it("tells hooks a schedule's run is unattended", async () => {
    const runtime = await installed([{ text: "nothing to do" }]);
    if (runtime.workflow === undefined) throw new Error("workflow unavailable");
    await runtime.workflow.admit({
      context,
      operationKey: "op-sched",
      kind: "start",
      prompt: "check",
      origin: "schedule",
      originScheduleId: "schedule-1",
    });
    await vi.waitFor(
      async () => expect((await runtime.store.asPort().repositories.plugins.loadPluginState("acme.modguard"))["attended"]).toBe(false),
      { timeout: 5_000 },
    );
  });

  it("lists each hook, how it fails, and what it can read in `tavi plugins show`", async () => {
    const dataDir = temp();
    const runtime = await installed([], dataDir);
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await runtime.close();
    let out = "";
    await main(["plugins", "show", "acme.modguard", "--data-dir", dataDir], {
      io: {
        stdout: (text) => void (out += text),
        stderr: () => {},
        isTty: false,
      },
    });
    expect(out).toContain("hooks:");
    expect(out).toContain(
      "tool.check [tools plan.update] (fails: ask): Refuses a plan step that says delete. — Sees the input of `plan.update`, and can refuse the call.",
    );
    expect(out).toContain("turn.complete (fails: skip): Reads token usage.");
  });
});
