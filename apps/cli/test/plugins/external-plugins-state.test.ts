import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/** The context an assessor is given with a call; these tools do not read it. */
const assessContext = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };

const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});

const temp = () => {
  const path = dirs.create("tavi-plugin-state-");
  return path;
};

const workspaces = [
  {
    workspaceId: "default",
    principalId: "operator",
    permissions: ["tools.invoke", "models.invoke", "runs.create"],
  },
];

const PLUGIN_CODE = `
export function register({ registerTool, state, z }) {
  registerTool({
    name: "save",
    inputSchema: z.object({ key: z.string(), val: z.any() }),
    handler: async (input) => {
      await state.put(input.key, input.val);
      return { ok: true };
    },
  });

  registerTool({
    name: "read",
    inputSchema: z.object({}),
    handler: async () => {
      const data = await state.load();
      return { data };
    },
  });

  registerTool({
    name: "guarded",
    inputSchema: z.object({ allowed: z.boolean() }),
    beforeCall: async (input) => {
      if (!input.allowed) {
        return { deny: true, reason: "Access denied by beforeCall" };
      }
      return { deny: false };
    },
    handler: async (input) => {
      return { executed: true, input };
    },
  });

  registerTool({
    name: "proceed_guarded",
    inputSchema: z.object({ proceed: z.boolean() }),
    beforeCall: async (input) => {
      if (!input.proceed) {
        return { proceed: false, reason: "Forbidden by proceed guard" };
      }
      return { proceed: true };
    },
    handler: async (input) => {
      return { success: true, input };
    },
  });

  registerTool({
    name: "no_risk",
    inputSchema: z.object({}),
    handler: async () => ({ ok: true }),
  });
}
`;

function createPlugin(version = "1.0.0", code = PLUGIN_CODE): string {
  const path = temp();
  writeFileSync(join(path, "index.mjs"), code);
  writeFileSync(
    join(path, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.sample",
      version,
      name: "Sample Plugin",
      entry: "index.mjs",
      tools: [
        { name: "save", effect: "external", description: "Save state", minRisk: "critical", untrustedOutput: true },
        { name: "read", effect: "external", description: "Read state", minRisk: "critical", untrustedOutput: true, proves: ["trends"] },
        { name: "guarded", effect: "external", description: "Guarded tool", minRisk: "critical", untrustedOutput: true },
        { name: "proceed_guarded", effect: "external", description: "Proceed guarded tool", minRisk: "critical", untrustedOutput: true },
        { name: "no_risk", effect: "external", description: "Tool without minRisk", untrustedOutput: true },
      ],
      capabilities: [],
      config: {},
    }),
  );
  return path;
}

async function compose(dataDirectory: string): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(fixtureServeOptions(dataDirectory, { workspaces }), { requireModelTransport: false });
  runtimes.push(runtime);
  return runtime;
}

describe("external plugins state and beforeCall hooks", () => {
  it("persists plugin state, runs beforeCall hooks, and gives a declared risk floor its reason", async () => {
    const dataDir = temp();
    const source = createPlugin();

    // 1. Install, approve, configure, enable
    const setup = await compose(dataDir);
    await setup.plugins.registry.install(source, "operator");
    await setup.plugins.registry.decide("acme.sample", "1.0.0", "approved", "operator");
    await setup.plugins.registry.configure("acme.sample", {}, [], "operator");
    await setup.plugins.registry.enable("acme.sample", "operator");
    const setupIdx = runtimes.indexOf(setup);
    if (setupIdx !== -1) runtimes.splice(setupIdx, 1);
    await setup.close();

    // 2. Reopen runtime and check loaded tools
    const runtime = await compose(dataDir);
    expect(runtime.plugins.status("acme.sample").phase).toBe("ready");

    const saveTool = runtime.tools.get("acme.sample.save");
    const readTool = runtime.tools.get("acme.sample.read");
    // What Ideas may offer while it is registered: the manifest's declaration, on the tool's definition.
    expect(readTool?.proves).toEqual(["trends"]);
    expect(saveTool?.proves).toBeUndefined();
    const guardedTool = runtime.tools.get("acme.sample.guarded");
    const proceedTool = runtime.tools.get("acme.sample.proceed_guarded");
    const noRiskTool = runtime.tools.get("acme.sample.no_risk");

    expect(saveTool).toBeDefined();
    expect(readTool).toBeDefined();
    expect(guardedTool).toBeDefined();
    expect(proceedTool).toBeDefined();
    expect(noRiskTool).toBeDefined();

    // A declared minRisk is the assessment's floor, with the manifest named as its reason
    const assessment = saveTool!.assess?.(
      {
        input: { key: "foo", val: "bar" },
        context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
      },
      assessContext,
    );
    expect(assessment?.risk).toBe("critical");
    expect(assessment?.reasons).toContain("the plugin's approved manifest rates this tool at least critical risk");
    expect(saveTool!.untrustedOutput).toBe(true);
    expect(saveTool!.effect).toBe("external");

    // A tool without a declared floor gets no assessor.
    expect(noRiskTool!.assess).toBeUndefined();

    // Execute save tool
    const saveResult = await saveTool!.handler({
      input: { key: "pref", val: { theme: "dark", count: 42 } },
      context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
      signal: AbortSignal.timeout(5000),
    });
    expect(saveResult).toEqual({ ok: true });

    // Execute read tool
    const readResult = await readTool!.handler({
      input: {},
      context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
      signal: AbortSignal.timeout(5000),
    });
    expect(readResult).toEqual({
      data: {
        pref: { theme: "dark", count: 42 },
      },
    });

    // Test beforeCall: allowed = true
    const allowResult = await guardedTool!.handler({
      input: { allowed: true },
      context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
      signal: AbortSignal.timeout(5000),
    });
    expect(allowResult).toEqual({ executed: true, input: { allowed: true } });

    // Test beforeCall: allowed = false -> should throw TOOL_FAILED
    await expect(
      guardedTool!.handler({
        input: { allowed: false },
        context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow("Access denied by beforeCall");

    // Test beforeCall with proceed: false
    await expect(
      proceedTool!.handler({
        input: { proceed: false },
        context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow("Forbidden by proceed guard");

    const proceedResult = await proceedTool!.handler({
      input: { proceed: true },
      context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
      signal: AbortSignal.timeout(5000),
    });
    expect(proceedResult).toEqual({ success: true, input: { proceed: true } });

    // Write serialization: concurrent puts do not collide
    await Promise.all([
      saveTool!.handler({
        input: { key: "c1", val: 1 },
        context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
        signal: AbortSignal.timeout(5000),
      }),
      saveTool!.handler({
        input: { key: "c2", val: 2 },
        context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
        signal: AbortSignal.timeout(5000),
      }),
      saveTool!.handler({
        input: { key: "c3", val: 3 },
        context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    const afterConcurrent = (await readTool!.handler({
      input: {},
      context: { workspaceId: "default", principalId: "operator", runId: "r1", caller: "test" },
      signal: AbortSignal.timeout(5000),
    })) as { data: Record<string, unknown> };
    expect(afterConcurrent.data["c1"]).toBe(1);
    expect(afterConcurrent.data["c2"]).toBe(2);
    expect(afterConcurrent.data["c3"]).toBe(3);

    // 3. Uninstall plugin and verify state is cleared
    await runtime.plugins.registry.disable("acme.sample", "operator");
    await runtime.plugins.registry.remove("acme.sample", "1.0.0");
    const stateAfterRemoval = await runtime.store.asPort().repositories.plugins.loadPluginState("acme.sample");
    expect(stateAfterRemoval).toEqual({});
  });
});
