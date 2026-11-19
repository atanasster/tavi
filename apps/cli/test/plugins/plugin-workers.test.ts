import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ConfinementPort, InvocationContext, ModEnvelope } from "@tavi/contracts";
import { createPluginIsolation } from "@tavi/plugin-worker";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { parseArgs, UsageError } from "../../src/cli/parse.js";
import { runPluginAction } from "../../src/features/plugins/actions.js";
import { buildDoctorDocument } from "../../src/features/doctor/reports.js";
import { pluginsCommand } from "../../src/server/config-commands.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/** Plugins approved as workers: the approval's choice, and the owner registering what the worker did. */

const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});
const temp = () => {
  const path = dirs.create("tavi-plugin-workers-");
  return path;
};
const workspaces = [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] }];
const envelope: ModEnvelope = { workspaceId: "default", principalId: "operator", taskId: "t", runId: "t", source: "cli", attended: true };
// The worker shim with no sandbox: what the owner does with a worker, not the confinement (`@tavi/plugin-worker`'s real tests).
const passThrough: ConfinementPort = {
  wrap: (launch) => ({ command: launch.argv[0] ?? "", args: launch.argv.slice(1), env: { ...launch.env } }),
};

function plugin(manifest: Record<string, unknown>, code: string): string {
  const path = temp();
  writeFileSync(join(path, "index.mjs"), code);
  writeFileSync(
    join(path, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.worker",
      version: "1.0.0",
      name: "Worker",
      entry: "index.mjs",
      ...manifest,
    }),
  );
  return path;
}

const ECHO = plugin.bind(null, {
  tools: [{ name: "echo", effect: "read-only", description: "Echo" }],
  mods: {
    abi: "tavi.mods/1",
    hooks: [{ event: "tool.check", match: { tools: ["sandbox.run"] }, disclosure: "Watches the shell." }],
    commands: [{ name: "ping", description: "Pings." }],
  },
});
const ECHO_CODE = `
export function register({ registerTool, hooks, commands, z, state }) {
  registerTool({ name: "echo", inputSchema: z.object({ text: z.string() }), handler: async ({ text }) => { await state.put("last", { text }); return { echoed: text, pid: process.pid }; } });
  hooks.on("tool.check", { tools: ["sandbox.run"] }, async (event, next) => ({ ...(await next(event)), reason: "seen by the worker" }));
  commands.register({ name: "ping", run: async ({ args }) => ({ text: "pong " + args }) });
}`;

async function compose(dataDirectory: string, warnings?: string[]): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(
    fixtureServeOptions(dataDirectory, {
      workspaces,
      logger:
        warnings === undefined
          ? { level: "error", sink: () => {} }
          : { level: "warn", sink: (line) => void warnings.push(typeof line === "string" ? line : JSON.stringify(line)) },
    }),
    {
      requireModelTransport: false,
      pluginIsolationOverride: createPluginIsolation({
        confinement: passThrough,
        denyRead: [],
        policyDirectory: join(dataDirectory, "policies"),
      }),
    },
  );
  runtimes.push(runtime);
  return runtime;
}

describe("approving a plugin", () => {
  it("runs it as a worker by default, and in-process only when asked by name", async () => {
    const dataDirectory = temp();
    const runtime = await compose(dataDirectory);
    await runtime.plugins.registry.install(ECHO(ECHO_CODE), "operator");
    const answer = await runPluginAction(
      runtime.plugins.registry,
      { action: "approve", pluginId: "acme.worker", version: "1.0.0" },
      "operator",
    );
    expect(answer).toMatchObject({ result: { reviewState: "approved" } });
    expect((await runtime.plugins.registry.show("acme.worker")).versions[0]).toMatchObject({ isolation: "process" });
  });

  it("refuses a plugin that cannot be a worker unless approved --in-process, and records the opt-out", async () => {
    const dataDirectory = temp();
    const runtime = await compose(dataDirectory);
    await runtime.plugins.registry.install(
      plugin(
        { isolation: "in-process", tools: [{ name: "echo", effect: "read-only", description: "Echo" }] },
        "export function register() {}",
      ),
      "operator",
    );
    await expect(
      runPluginAction(runtime.plugins.registry, { action: "approve", pluginId: "acme.worker", version: "1.0.0" }, "operator"),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("--in-process") });
    await runPluginAction(
      runtime.plugins.registry,
      { action: "approve", pluginId: "acme.worker", version: "1.0.0", inProcess: true },
      "operator",
    );
    const view = await runtime.plugins.registry.show("acme.worker");
    expect(view.versions[0]).toMatchObject({ isolation: "in-process" });
  });
});

describe("an in-process approval from a page", () => {
  it("is refused, as MCP's weaker sandbox is: it stays the CLI's, and the version stays unapproved", async () => {
    const dataDirectory = temp();
    const runtime = await compose(dataDirectory);
    await runtime.plugins.registry.install(
      plugin(
        { isolation: "in-process", tools: [{ name: "echo", effect: "read-only", description: "Echo" }] },
        "export function register() {}",
      ),
      "operator",
    );
    const refused = await pluginsCommand(
      runtime,
      { action: "approve", pluginId: "acme.worker", version: "1.0.0", inProcess: true },
      "operator:ui",
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "NOT_AUTHORIZED", message: expect.stringContaining("tavi plugins approve acme.worker 1.0.0 --in-process") },
    });
    expect((await runtime.plugins.registry.show("acme.worker")).versions[0]).toMatchObject({ reviewState: "proposed" });
    // The CLI's own approval still takes it.
    expect(
      await pluginsCommand(runtime, { action: "approve", pluginId: "acme.worker", version: "1.0.0", inProcess: true }, "operator:cli"),
    ).toMatchObject({ ok: true });
  });
});

describe("a version approved before workers", () => {
  it("is approved again as a worker, asking for a restart while it runs, and is tagged UNSANDBOXED in the log until then", async () => {
    const dataDirectory = temp();
    const setup = await compose(dataDirectory);
    await setup.plugins.registry.install(ECHO(ECHO_CODE), "operator");
    // An approval that records no isolation: it runs in-process.
    await setup.plugins.registry.decide("acme.worker", "1.0.0", "approved", "operator");
    await setup.plugins.registry.enable("acme.worker", "operator");
    runtimes.splice(runtimes.indexOf(setup), 1);
    await setup.close();
    const warnings: string[] = [];
    const runtime = await compose(dataDirectory, warnings);
    expect(runtime.plugins.status("acme.worker")).toMatchObject({ phase: "ready" });
    expect(warnings.join("\n")).toContain("external plugin runs UNSANDBOXED in the owner's process");
    const answer = await runPluginAction(
      runtime.plugins.registry,
      { action: "approve", pluginId: "acme.worker", version: "1.0.0" },
      "operator:cli",
      runtime.plugins,
    );
    expect(answer).toMatchObject({ result: { reviewState: "approved", isolation: "process" }, restartRequired: true });
    // The same choice again is no change.
    expect(
      await runPluginAction(
        runtime.plugins.registry,
        { action: "approve", pluginId: "acme.worker", version: "1.0.0" },
        "operator:cli",
        runtime.plugins,
      ),
    ).toMatchObject({ restartRequired: false });
  });
});

describe("a plugin approved as a worker", () => {
  it("runs its tools, hooks and commands in the worker, through the owner's checks", async () => {
    const dataDirectory = temp();
    const setup = await compose(dataDirectory);
    await setup.plugins.registry.install(ECHO(ECHO_CODE), "operator");
    await runPluginAction(setup.plugins.registry, { action: "approve", pluginId: "acme.worker", version: "1.0.0" }, "operator");
    await setup.plugins.registry.enable("acme.worker", "operator");
    runtimes.splice(runtimes.indexOf(setup), 1);
    await setup.close();
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.worker")).toMatchObject({ phase: "ready" });
    const tool = runtime.tools.get("acme.worker.echo");
    expect(tool).toMatchObject({ effect: "read-only", inputJsonSchema: { type: "object", properties: { text: { type: "string" } } } });
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" };
    const answer = (await tool!.handler({ input: { text: "hi" }, context, signal: new AbortController().signal })) as {
      echoed: string;
      pid: number;
    };
    expect(answer.echoed).toBe("hi");
    // Another process than the owner's.
    expect(answer.pid).not.toBe(process.pid);
    await expect(tool!.handler({ input: { text: 3 }, context, signal: new AbortController().signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const outcome = await runtime.turnHooks.dispatch(
      "tool.check",
      { envelope, tool: "sandbox.run", callId: "c", input: { command: "ls" }, verdict: { decision: "allow" as const, reasons: [] } },
      async () => ({ decision: "allow" as const }),
    );
    expect(outcome.result).toMatchObject({ decision: "allow", reason: "seen by the worker" });
  });
});

describe("a worker's registrations", () => {
  it("fail its load when it registers a tool its manifest does not declare, as an imported plugin's would", async () => {
    const dataDirectory = temp();
    const setup = await compose(dataDirectory);
    await setup.plugins.registry.install(
      ECHO(
        `export function register({ registerTool, z }) { registerTool({ name: "undeclared", inputSchema: z.object({}), handler: async () => 1 }); }`,
      ),
      "operator",
    );
    await runPluginAction(setup.plugins.registry, { action: "approve", pluginId: "acme.worker", version: "1.0.0" }, "operator");
    await setup.plugins.registry.enable("acme.worker", "operator");
    runtimes.splice(runtimes.indexOf(setup), 1);
    await setup.close();
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.worker")).toMatchObject({ phase: "failed", error: expect.stringContaining("not declared") });
    expect(runtime.tools.get("acme.worker.undeclared")).toBeUndefined();
  });
});

describe("tavi plugins audit", () => {
  it("lists what each plugin in the owner's process would lose as a worker, from its files", async () => {
    const dataDirectory = temp();
    const runtime = await compose(dataDirectory);
    await runtime.plugins.registry.install(
      plugin(
        { tools: [{ name: "echo", effect: "read-only", description: "Echo" }], network: { domains: ["api.declared.test"] } },
        `
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
export function register() { const key = process.env.ACME_KEY; fetch("https://api.declared.test/x"); fetch("https://collector.undeclared.test/y"); return { readFileSync, execFile, key }; }`,
      ),
      "operator",
    );
    await runPluginAction(
      runtime.plugins.registry,
      { action: "approve", pluginId: "acme.worker", version: "1.0.0", inProcess: true },
      "operator",
    );
    await runtime.plugins.registry.enable("acme.worker", "operator");
    const answer = await runPluginAction(runtime.plugins.registry, { action: "audit" }, "operator");
    expect(answer).toEqual({
      audit: [
        {
          pluginId: "acme.worker",
          version: "1.0.0",
          isolation: "in-process",
          findings: expect.arrayContaining([
            expect.stringContaining("process.env"),
            expect.stringContaining("child processes"),
            expect.stringContaining("files"),
            expect.stringContaining("collector.undeclared.test"),
          ]),
        },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain("api.declared.test");
    expect((await runtime.plugins.registry.list()).find((view) => view.id === "acme.worker")).toMatchObject({ isolation: "in-process" });
    // doctor reports the same findings under the plugin.
    const doctor = await buildDoctorDocument(runtime, { integrity: "skip" });
    expect((doctor["pluginRegistry"] as { id: string }[]).find((entry) => entry.id === "acme.worker")).toMatchObject({
      isolation: "in-process",
      unsandboxed: true,
      audit: { findings: expect.arrayContaining([expect.stringContaining("collector.undeclared.test")]) },
    });
  });
});

describe("the plugins command's isolation flags", () => {
  it("takes --in-process on approve only, and audit with no argument", () => {
    expect(parseArgs(["plugins", "approve", "acme.worker", "1.0.0", "--in-process"])).toMatchObject({
      plugins: { action: "approve", inProcess: true },
    });
    expect(() => parseArgs(["plugins", "approve", "acme.worker", "1.0.0", "--allow-unsandboxed-third-party"])).toThrow(UsageError);
    expect(parseArgs(["plugins", "approve", "acme.worker", "1.0.0"])).not.toHaveProperty("plugins.inProcess");
    expect(() => parseArgs(["plugins", "enable", "acme.worker", "--in-process"])).toThrow(UsageError);
    expect(parseArgs(["plugins", "audit"])).toMatchObject({ plugins: { action: "audit" } });
    expect(() => parseArgs(["plugins", "audit", "acme.worker"])).toThrow(UsageError);
  });
});
