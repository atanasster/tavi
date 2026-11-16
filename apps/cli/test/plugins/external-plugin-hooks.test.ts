import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ModEnvelope } from "@tavi/contracts";
import { temporaryDirectories, delay } from "@tavi/test-support";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/** `hooks.on` in the external loader. */

const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});

const temp = () => {
  const path = dirs.create("tavi-plugin-hooks-");
  return path;
};

const workspaces = [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] }];
const envelope: ModEnvelope = { workspaceId: "default", principalId: "operator", taskId: "t", runId: "t", source: "cli", attended: true };

const GUARD = `
export function register({ hooks }) {
  hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => {
    const verdict = await next(e);
    return /rm -rf/.test(String(e.input?.command ?? "")) ? { decision: "ask", reason: "Deletes files." } : verdict;
  });
}
`;

function modPlugin(
  code: string,
  hooks: unknown[] = [{ event: "tool.check", match: { tools: ["sandbox.run"] }, disclosure: "Asks before deleting files." }],
): string {
  const path = temp();
  writeFileSync(join(path, "index.mjs"), code);
  writeFileSync(
    join(path, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.guard",
      version: "1.0.0",
      name: "Guard",
      entry: "index.mjs",
      mods: { abi: "tavi.mods/1", hooks },
    }),
  );
  return path;
}

async function compose(dataDirectory: string): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(fixtureServeOptions(dataDirectory, { workspaces }), { requireModelTransport: false });
  runtimes.push(runtime);
  return runtime;
}

/** Install, approve and enable `source`, then open a fresh runtime that loads it. */
async function loaded(source: string): Promise<TaviRuntime> {
  const dataDir = temp();
  const setup = await compose(dataDir);
  await setup.plugins.registry.install(source, "operator");
  await setup.plugins.registry.decide("acme.guard", "1.0.0", "approved", "operator");
  await setup.plugins.registry.enable("acme.guard", "operator");
  runtimes.splice(runtimes.indexOf(setup), 1);
  await setup.close();
  return compose(dataDir);
}

const check = (command: string) => ({
  envelope,
  tool: "sandbox.run",
  callId: "c",
  input: { command },
  verdict: { decision: "allow" as const, reasons: [] },
});

describe("plugin hooks through the external loader", () => {
  it("registers a declared hook once the plugin runs, and withdraws it when the plugin is disabled", async () => {
    const runtime = await loaded(modPlugin(GUARD));
    expect(runtime.plugins.status("acme.guard").phase).toBe("ready");
    expect(runtime.turnHooks.has("tool.check", envelope, "sandbox.run")).toBe(true);
    const outcome = await runtime.turnHooks.dispatch("tool.check", check("rm -rf build"), async () => ({ decision: "allow" as const }));
    expect(outcome).toEqual({ result: { decision: "ask", reason: "Deletes files." }, decidedBy: "acme.guard" });
    await runtime.plugins.registry.disable("acme.guard", "operator");
    expect(runtime.turnHooks.has("tool.check", envelope, "sandbox.run")).toBe(false);
  });

  it("fails the load of a plugin that registers a hook it did not declare, saying why", async () => {
    const runtime = await loaded(modPlugin(`export function register({ hooks }) { hooks.on("tool.result", async (e, next) => next(e)); }`));
    const status = runtime.plugins.status("acme.guard");
    expect(status.phase).toBe("failed");
    expect(status.error).toMatch(/did not declare a tool.result hook/);
    expect(runtime.turnHooks.has("tool.result", envelope, "fs.read")).toBe(false);
  });

  it("fails the load of one that widens its declared match", async () => {
    const runtime = await loaded(
      modPlugin(`export function register({ hooks }) { hooks.on("tool.check", { tools: ["fs.write"] }, async (e, next) => next(e)); }`),
    );
    expect(runtime.plugins.status("acme.guard").error).toMatch(/narrower match/);
  });

  it("fails the load of a match that is no match, keeps the one it checked, and refuses a seventeenth hook", async () => {
    const typo = await loaded(
      modPlugin(`export function register({ hooks }) { hooks.on("tool.check", { tools: "sandbox.run" }, async (e, next) => next(e)); }`, [
        { event: "tool.check", disclosure: "Any tool." },
      ]),
    );
    expect(typo.plugins.status("acme.guard").error).toMatch(/match is not one/);
    expect(() => typo.turnHooks.has("tool.check", envelope, "sandbox.run")).not.toThrow();
    const widened = await loaded(
      modPlugin(
        `export function register({ hooks }) { const m = { tools: ["sandbox.run"] }; hooks.on("tool.check", m, async (e, next) => next(e)); m.tools.push("*"); }`,
      ),
    );
    expect(widened.plugins.status("acme.guard").phase).toBe("ready");
    expect(widened.turnHooks.has("tool.check", envelope, "fs.write")).toBe(false);
    const many = await loaded(
      modPlugin(
        `export function register({ hooks }) { for (let i = 0; i < 17; i += 1) hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => next(e)); }`,
      ),
    );
    expect(many.plugins.status("acme.guard").error).toMatch(/more than 16 hooks/);
  });

  it("fails the load of a command registered twice", async () => {
    const path = temp();
    writeFileSync(
      join(path, "index.mjs"),
      `export function register({ commands }) { commands.register({ name: "tally", run: async () => ({ text: "1" }) }); commands.register({ name: "tally", run: async () => ({ text: "2" }) }); }`,
    );
    writeFileSync(
      join(path, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.guard",
        version: "1.0.0",
        name: "Guard",
        entry: "index.mjs",
        mods: { abi: "tavi.mods/1", hooks: [], commands: [{ name: "tally", description: "Counts." }] },
      }),
    );
    const runtime = await loaded(path);
    expect(runtime.plugins.status("acme.guard").error).toMatch(/registered its \/tally command twice/);
  });

  it("fails the load even when the plugin catches the refusal", async () => {
    const runtime = await loaded(
      modPlugin(`export function register({ hooks }) { try { hooks.on("tool.result", async (e, next) => next(e)); } catch {} }`),
    );
    expect(runtime.plugins.status("acme.guard").error).toMatch(/did not declare a tool.result hook/);
  });

  it("refuses hooks.on after register returned", async () => {
    const runtime = await loaded(
      modPlugin(
        `let late; export function register({ hooks }) { late = hooks; } export function start() { late.on("tool.check", async (e, next) => next(e)); }`,
      ),
    );
    expect(runtime.plugins.status("acme.guard").error).toMatch(/registration is closed/);
  });

  it("shows at most 4 lines a second, clipped, on a task the plugin's hooks were handed", async () => {
    const code = `export function register({ hooks, ui }) {
      hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => {
        for (let index = 0; index < 6; index += 1) ui.status(e.envelope, "line " + index + " " + "x".repeat(300));
        return next(e);
      });
    }`;
    const runtime = await loaded(modPlugin(code));
    // The task has a stream: an event published on it, as a turn would.
    runtime.runEventBus.publish("t", { kind: "run.started", runId: "t", attemptId: "a1", threadId: "thread-1", workspaceId: "default" });
    await runtime.turnHooks.dispatch("tool.check", check("ls"), async () => ({ decision: "allow" as const }));
    const { replayed } = runtime.runEventBus.subscribe({ taskId: "t", from: "beginning", deliver: () => {} });
    const lines = replayed.flatMap((event) => (event.kind === "plugin.status" ? [event.line ?? ""] : []));
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.length === 200)).toBe(true);
  });

  it("clears its line even past the limit", async () => {
    const code = `export function register({ hooks, ui }) {
      hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => {
        ui.status(e.envelope, "working");
        for (let index = 0; index < 4; index += 1) ui.notice(e.envelope, "note " + index);
        ui.status(e.envelope);
        ui.status(e.envelope);
        return next(e);
      });
    }`;
    const runtime = await loaded(modPlugin(code));
    runtime.runEventBus.publish("t", { kind: "run.started", runId: "t", attemptId: "a1", threadId: "thread-1", workspaceId: "default" });
    await runtime.turnHooks.dispatch("tool.check", check("ls"), async () => ({ decision: "allow" as const }));
    const { replayed } = runtime.runEventBus.subscribe({ taskId: "t", from: "beginning", deliver: () => {} });
    const statuses = replayed.flatMap((event) => (event.kind === "plugin.status" ? [event.line ?? null] : []));
    // Set, then cleared once: the second clear had no line to clear.
    expect(statuses).toEqual(["working", null]);
  });

  it("adds a declared slash command, and fails the load of an undeclared one", async () => {
    const declared = (code: string) => {
      const path = modPlugin(code, []);
      const manifestPath = join(path, "tavi-plugin.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          mods: { abi: "tavi.mods/1", commands: [{ name: "tally", description: "Counts this chat's tool calls." }] },
        }),
      );
      return path;
    };
    const runtime = await loaded(
      declared(
        `export function register({ commands }) { commands.register({ name: "tally", run: ({ args }) => ({ text: "tally " + args }) }); }`,
      ),
    );
    expect(runtime.turnHooks.commands()).toEqual([
      { name: "tally", pluginId: "acme.guard", description: "Counts this chat's tool calls." },
    ]);
    expect(await runtime.turnHooks.runCommand("tally", { envelope, args: "now" })).toEqual({ text: "tally now" });
    const refused = await loaded(
      declared(`export function register({ commands }) { commands.register({ name: "other", run: () => ({ text: "" }) }); }`),
    );
    expect(refused.plugins.status("acme.guard").error).toMatch(/did not declare a \/other command/);
  });

  it("publishes a value for its canvas contribution on the task's stream, masked, and refuses one too large", async () => {
    const code = `export function register({ hooks, ui, state }) {
      hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => {
        ui.publish(e.envelope, "plan", { steps: ["read", "key AKIAIOSFODNN7EXAMPLE"] });
        try { ui.publish(e.envelope, "big", "x".repeat(20000)); } catch { await state.put("big", "refused"); }
        return next(e);
      });
    }`;
    const runtime = await loaded(modPlugin(code));
    runtime.runEventBus.publish("t", { kind: "run.started", runId: "t", attemptId: "a1", threadId: "thread-1", workspaceId: "default" });
    await runtime.turnHooks.dispatch("tool.check", check("ls"), async () => ({ decision: "allow" as const }));
    const { replayed } = runtime.runEventBus.subscribe({ taskId: "t", from: "beginning", deliver: () => {} });
    expect(replayed.filter((event) => event.kind === "plugin.state")).toMatchObject([
      { pluginId: "acme.guard", stateKey: "plan", value: { steps: ["read", "key [redacted:aws-key]"] } },
    ]);
    expect((await runtime.store.asPort().repositories.plugins.loadPluginState("acme.guard"))["big"]).toBe("refused");
  });

  it("holds published values over the limit and sends the newest per key once it allows", async () => {
    const code = `export function register({ hooks, ui }) {
      hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => {
        for (const key of ["a", "b", "c", "d", "e"]) ui.publish(e.envelope, key, 1);
        ui.publish(e.envelope, "e", 2);
        ui.status(e.envelope, "still shown");
        return next(e);
      });
    }`;
    const runtime = await loaded(modPlugin(code));
    runtime.runEventBus.publish("t", { kind: "run.started", runId: "t", attemptId: "a1", threadId: "thread-1", workspaceId: "default" });
    await runtime.turnHooks.dispatch("tool.check", check("ls"), async () => ({ decision: "allow" as const }));
    const events = () => runtime.runEventBus.subscribe({ taskId: "t", from: "beginning", deliver: () => {} }).replayed;
    expect(
      events()
        .filter((event) => event.kind === "plugin.state")
        .map((event) => (event.kind === "plugin.state" ? event.stateKey : "")),
    ).toEqual(["a", "b", "c", "d"]);
    expect(events().some((event) => event.kind === "plugin.status")).toBe(true);
    await delay(1_200);
    expect(
      events()
        .filter((event) => event.kind === "plugin.state")
        .slice(4),
    ).toMatchObject([{ stateKey: "e", value: 2 }]);
  });

  it("clears its status lines when it is disabled", async () => {
    const code = `export function register({ hooks, ui }) {
      hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => { ui.status(e.envelope, "watching"); return next(e); });
    }`;
    const runtime = await loaded(modPlugin(code));
    runtime.runEventBus.publish("t", { kind: "run.started", runId: "t", attemptId: "a1", threadId: "thread-1", workspaceId: "default" });
    await runtime.turnHooks.dispatch("tool.check", check("ls"), async () => ({ decision: "allow" as const }));
    await runtime.plugins.registry.disable("acme.guard", "operator");
    const statuses = runtime.runEventBus
      .subscribe({ taskId: "t", from: "beginning", deliver: () => {} })
      .replayed.filter((event) => event.kind === "plugin.status");
    expect(statuses.map((event) => (event.kind === "plugin.status" ? event.line : "-"))).toEqual(["watching", undefined]);
  });

  it("withdraws the built-in guard at once when it is disabled (invariant 11)", async () => {
    const dataDir = temp();
    const setup = await compose(dataDir);
    await setup.plugins.registry.enable("tavi.guard", "operator");
    runtimes.splice(runtimes.indexOf(setup), 1);
    await setup.close();
    const runtime = await compose(dataDir);
    expect(runtime.turnHooks.has("tool.check", envelope, "sandbox.run")).toBe(true);
    await runtime.plugins.registry.disable("tavi.guard", "operator");
    expect(runtime.turnHooks.has("tool.check", envelope, "sandbox.run")).toBe(false);
  });

  it("keeps at most 64 published values waiting, dropping the oldest", async () => {
    const code = `export function register({ hooks, ui }) {
      hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => {
        for (let index = 0; index < 70; index += 1) ui.publish(e.envelope, "k" + index, index);
        return next(e);
      });
    }`;
    const runtime = await loaded(modPlugin(code));
    runtime.runEventBus.publish("t", { kind: "run.started", runId: "t", attemptId: "a1", threadId: "thread-1", workspaceId: "default" });
    await runtime.turnHooks.dispatch("tool.check", check("ls"), async () => ({ decision: "allow" as const }));
    const keys = () =>
      runtime.runEventBus
        .subscribe({ taskId: "t", from: "beginning", deliver: () => {} })
        .replayed.flatMap((event) => (event.kind === "plugin.state" ? [event.stateKey] : []));
    expect(keys()).toEqual(["k0", "k1", "k2", "k3"]);
    // 66 waited and 64 are kept: k4 and k5, the oldest, were dropped; the next second sends k6 on.
    await delay(1_200);
    expect(keys()).toEqual(["k0", "k1", "k2", "k3", "k6", "k7", "k8", "k9"]);
  });
});
