import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTENDED_TASK_POLICY, type ProviderInstanceConfig } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { resolveModelTarget } from "../../src/cli/run-target.js";
import { runtimeOptionsForTarget } from "../../src/cli/runtime-options.js";
import { discoverAndRecord, testAndRecord } from "../../src/features/models/actions.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { runPluginAction } from "../../src/features/plugins/actions.js";

const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});
const temp = () => {
  const path = dirs.create("tavi-provider-lifecycle-");
  return path;
};
const workspaces = ["a", "b"].map((workspaceId) => ({
  workspaceId,
  principalId: `owner-${workspaceId}`,
  permissions: ["tools.invoke", "models.invoke", "runs.create"],
}));
const context = (workspaceId = "a") => ({ workspaceId, principalId: `owner-${workspaceId}`, runId: "run", caller: "test" });
const instances: ProviderInstanceConfig[] = workspaces.flatMap(({ workspaceId }) =>
  ["model", "search"].map((factory) => ({
    id: `${factory}-${workspaceId}`,
    factory,
    workspaceId,
    accountId: workspaceId,
    settings: { endpoint: "in-process", label: workspaceId },
    credentials: {},
  })),
);
const moduleCode = `
export function register({ registerModel, registerSearch, registerTool, z }) {
  const settingsSchema = z.object({ endpoint: z.string(), label: z.string() });
  const wait = signal => new Promise((_, reject) => { signal.throwIfAborted(); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  registerModel("model", { settingsSchema, create: ({ settings, instanceId }) => ({
    listModels: () => [{ provider: instanceId, id: "fixture", name: "Fixture" }],
    resolveModel: async (provider, id) => ({ provider, id, name: id }),
    prepareCall: async (provider, id) => ({ model: { provider, id, name: id }, stream: async function* () { yield { type: "block-start", index: 0, blockType: "text" }; yield { type: "text-delta", index: 0, text: settings.label }; yield { type: "block-end", index: 0, block: { type: "text", text: settings.label } }; yield { type: "finish", reason: { kind: "stop" } }; } })
  }) });
  registerSearch("search", { settingsSchema, create: ({ settings, instanceId }) => ({
    id: instanceId, available: () => true,
    search: async (query, signal) => query.query === "wait" ? wait(signal) : ({ truncated: false, sources: [{ title: settings.label, url: "https://example.org" }] })
  }) });
  registerTool({ name: "wait", inputSchema: z.object({}), handler: (_, { signal }) => wait(signal) });
}
`;
function artifact(version = "1.0.0", code = moduleCode): string {
  const path = temp();
  writeFileSync(join(path, "index.mjs"), code);
  writeFileSync(
    join(path, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.providers",
      version,
      name: "Fixture providers",
      entry: "index.mjs",
      tools: [{ name: "wait", effect: "read-only", description: "Wait for cancellation" }],
      capabilities: ["model", "search"].map((kind) => ({
        id: kind,
        kind,
        settings: {
          endpoint: { type: "string", required: true, description: "Transport endpoint" },
          label: { type: "string", required: true, description: "Fixture label" },
        },
        credentials: [],
        disclosure: "In-process fixture",
      })),
    }),
  );
  return path;
}
async function compose(path: string, connection = "acme.providers.model-a", requireModelTransport = true) {
  const runtime = await composeTaviRuntime(
    {
      dataDirectory: path,
      workspaces,
      providers: [],
      credentials: {},
      defaultConnectionId: connection,
      defaultModel: "fixture",
      logger: { level: "error", sink: () => {} },
      scheduleSweepEnabled: false,
    },
    { requireModelTransport },
  );
  runtimes.push(runtime);
  return runtime;
}
async function prepare(source = artifact()) {
  const path = temp();
  const setup = await compose(path, "unused", false);
  await setup.plugins.registry.install(source, "operator");
  await setup.plugins.registry.decide("acme.providers", "1.0.0", "approved", "operator");
  await setup.plugins.registry.configure("acme.providers", {}, [], "operator", undefined, instances);
  await setup.plugins.registry.enable("acme.providers", "operator");
  await setup.close();
  return path;
}
async function search(runtime: TaviRuntime, workspace = "a", query = "hello") {
  const tool = runtime.tools.get("web_search")!;
  const identity = context(workspace);
  const binding = await tool.resolveBinding!({ query }, identity);
  return tool.handler({ input: { query }, context: identity, signal: AbortSignal.timeout(5000), expectedBindingHash: binding.bindingHash });
}

describe("external provider lifecycle in the real owner", () => {
  it("starts with external models only, scopes searches and persists separate account envelopes", async () => {
    const path = await prepare();
    const runtime = await compose(path);
    expect(runtime.plugins.status("acme.providers").phase).toBe("ready");
    const models = runtime.store.asPort().services.modelConfig;
    const connection = await models.getConnection("acme.providers.model-a");
    expect(connection.providerBinding).toMatchObject({ workspaceId: "a", principalId: "owner-a" });
    const noCredential = async () => {
      throw new Error("discovery must stay offline");
    };
    expect(await discoverAndRecord(models, connection.connectionId, noCredential)).toMatchObject({
      models: [{ modelId: "fixture", state: "available", capabilities: [] }],
    });
    await expect(testAndRecord(models, connection.connectionId, "fixture", noCredential)).rejects.toThrow(/approved task/);
    await expect(
      models.putConnection({
        connectionId: connection.connectionId,
        label: connection.label,
        baseUrl: connection.baseUrl,
        credentialRef: connection.credentialRef,
      }),
    ).rejects.toThrow(/plugin instance/);
    const result = await runtime.workflow!.admit({
      context: context(),
      kind: "start",
      operationKey: "external-model",
      prompt: "hello",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(result.outcome.status).toBe("completed");
    expect(await runtime.modelAccounting.operations(result.taskId)).toContainEqual(
      expect.objectContaining({
        operation: expect.objectContaining({ binding: expect.objectContaining({ instanceId: "acme.providers.model-a", accountId: "a" }) }),
      }),
    );
    expect(await search(runtime, "a")).toMatchObject({ provider: "acme.providers.search-a", sources: [{ title: "a" }] });
    expect(await search(runtime, "b")).toMatchObject({ provider: "acme.providers.search-b", sources: [{ title: "b" }] });
    const records = await runtime.modelAccounting.operations("run");
    expect(records.map((row) => row.operation.binding.accountId)).toEqual(["a", "b"]);
    expect(new Set(records.map((row) => row.operation.bindingHash)).size).toBe(2);
    await expect(
      runtime.tools.get("web_search")!.resolveBinding!({ query: "x" }, { ...context(), principalId: "owner-b" }),
    ).rejects.toThrow(/workspace or principal/);
  });

  it("selects configured instances even when provider classes share the same ID", async () => {
    const path = await prepare(
      artifact(
        "1.0.0",
        moduleCode
          .replace("id: instanceId,", 'id: "shared-class-id",')
          .replace(
            'query.query === "wait" ?',
            'query.query === "fallback" && settings.label === "backup" ? Promise.reject(new Error("down")) : query.query === "wait" ?',
          ),
      ),
    );
    const setup = await compose(path);
    await setup.plugins.registry.configure("acme.providers", {}, [], "operator", undefined, [
      ...instances,
      {
        id: "search-backup",
        factory: "search",
        workspaceId: "a",
        accountId: "backup",
        settings: { endpoint: "in-process", label: "backup" },
        credentials: {},
      },
    ]);
    await setup.close();
    writeFileSync(
      join(path, "web-providers.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspaces: { a: { search: { providers: ["acme.providers.search-backup", "acme.providers.search-a"] } } },
      }),
    );
    const runtime = await compose(path);
    expect(await search(runtime)).toMatchObject({ provider: "acme.providers.search-backup", sources: [{ title: "backup" }] });
    expect(await search(runtime, "a", "fallback")).toMatchObject({ provider: "acme.providers.search-a", sources: [{ title: "a" }] });
    expect((await runtime.modelAccounting.operations("run")).map((row) => row.operation.binding.accountId)).toEqual([
      "backup",
      "backup",
      "a",
    ]);
  });

  it.each(["disable", "reject"])("%s aborts existing search and tool calls and refuses retained handles", async (action) => {
    const runtime = await compose(await prepare());
    const retained = runtime.tools.get("acme.providers.wait")!;
    const pendingTool = retained.handler({ input: {}, context: context(), signal: AbortSignal.timeout(5000) });
    const toolResult = expect(pendingTool).rejects.toThrow(/withdrawn/);
    const searchTool = runtime.tools.get("web_search")!;
    const bound = await searchTool.resolveBinding!({ query: "wait" }, context());
    const pendingSearch = searchTool.handler({
      input: { query: "wait" },
      context: context(),
      signal: AbortSignal.timeout(5000),
      expectedBindingHash: bound.bindingHash,
    });
    const searchResult = expect(pendingSearch).rejects.toThrow();
    // Wait for the durable reservation, proving that withdrawal cancels a dispatched operation.
    await expect.poll(async () => (await runtime.modelAccounting.operations("run")).length).toBe(1);
    if (action === "disable") await runtime.plugins.registry.disable("acme.providers", "operator");
    else await runtime.plugins.registry.decide("acme.providers", "1.0.0", "rejected", "operator");
    await Promise.all([toolResult, searchResult]);
    expect(runtime.plugins.status("acme.providers").phase).toBe("stopped");
    await expect(retained.handler({ input: {}, context: context(), signal: AbortSignal.timeout(1000) })).rejects.toThrow(/not running/);
    await expect(search(runtime)).rejects.toThrow(/No enabled provider/);
    expect((await runtime.modelAccounting.operations("run"))[0]?.state).toBe("uncertain");
  });

  it("reports a failed cleanup once as a warning on the committed withdrawal", async () => {
    const runtime = await compose(
      await prepare(
        artifact(
          "1.0.0",
          `${moduleCode}
export function stop() { throw new Error("stop hook failed"); }
`,
        ),
      ),
    );
    const disabled = await runPluginAction(runtime.plugins.registry, { action: "disable", pluginId: "acme.providers" }, "operator");
    expect(disabled).toMatchObject({ result: { enabled: false }, cleanupWarning: expect.stringMatching(/stop hook failed/) });
    expect(runtime.plugins.status("acme.providers")).toMatchObject({ phase: "failed", error: expect.stringMatching(/stop hook failed/) });
    expect(await runtime.plugins.registry.disable("acme.providers", "operator")).not.toHaveProperty("cleanupWarning");
    expect(await runtime.plugins.registry.decide("acme.providers", "1.0.0", "rejected", "operator")).not.toHaveProperty("cleanupWarning");
    expect(await runtime.plugins.registry.remove("acme.providers", "1.0.0")).toMatchObject({ removed: ["1.0.0"] });
  });

  it("removes provider-managed model connections with their instance", async () => {
    const path = await prepare();
    const runtime = await compose(path);
    const models = runtime.store.asPort().repositories.modelConfig;
    expect((await models.listConnections()).map((connection) => connection.connectionId).sort()).toEqual([
      "acme.providers.model-a",
      "acme.providers.model-b",
    ]);
    await runtime.plugins.registry.configure(
      "acme.providers",
      {},
      [],
      "operator",
      undefined,
      instances.filter((instance) => instance.id !== "model-b"),
    );
    await runtime.close();
    const restarted = await compose(path);
    const stored = restarted.store.asPort().repositories.modelConfig;
    expect((await stored.listConnections()).map((connection) => connection.connectionId)).toEqual(["acme.providers.model-a"]);
    expect(await stored.listCatalog("acme.providers.model-b")).toEqual([]);
    await restarted.plugins.registry.disable("acme.providers", "operator");
    expect(await stored.listConnections()).toEqual([]);
    expect(await stored.listCatalog("acme.providers.model-a")).toEqual([]);
  });

  it("keeps configuration frozen until restart and rejects the loaded version after selecting a newer one", async () => {
    const path = await prepare();
    const runtime = await compose(path);
    await runtime.plugins.registry.configure(
      "acme.providers",
      {},
      [],
      "operator",
      undefined,
      instances.map((instance) => ({ ...instance, settings: { ...instance.settings, label: "changed" } })),
    );
    expect(await search(runtime)).toMatchObject({ sources: [{ title: "a" }] });
    await runtime.close();
    const restarted = await compose(path);
    expect(await search(restarted)).toMatchObject({ sources: [{ title: "changed" }] });
    await restarted.plugins.registry.install(artifact("2.0.0"), "operator");
    await restarted.plugins.registry.decide("acme.providers", "2.0.0", "approved", "operator");
    await restarted.plugins.registry.enable("acme.providers", "operator", "2.0.0");
    await restarted.plugins.registry.decide("acme.providers", "1.0.0", "rejected", "operator");
    expect(restarted.plugins.status("acme.providers").phase).toBe("stopped");
    await expect(search(restarted)).rejects.toThrow(/No enabled provider/);
  });

  it.each([
    ["missing availability", "id: instanceId,"],
    ["throwing availability", 'id: instanceId, available: () => { throw new Error("unavailable fixture"); },'],
    ["non-boolean availability", 'id: instanceId, available: () => "yes",'],
    ["missing identity", "available: () => true,"],
  ])("isolates %s from a healthy provider and owner", async (_label, replacement) => {
    const path = await prepare(artifact("1.0.0", moduleCode.replace("id: instanceId, available: () => true,", replacement)));
    const healthy = artifact();
    const manifestPath = join(healthy, "tavi-plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.id = "acme.healthy";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const setup = await composeTaviRuntime(
      {
        dataDirectory: path,
        workspaces,
        providers: [],
        credentials: {},
        defaultConnectionId: "unused",
        defaultModel: "fixture",
        externalPlugins: "verify",
        logger: { level: "error", sink: () => {} },
        scheduleSweepEnabled: false,
      },
      { requireModelTransport: false },
    );
    runtimes.push(setup);
    await setup.plugins.registry.install(healthy, "operator");
    await setup.plugins.registry.decide("acme.healthy", "1.0.0", "approved", "operator");
    await setup.plugins.registry.configure("acme.healthy", {}, [], "operator", undefined, instances);
    await setup.plugins.registry.enable("acme.healthy", "operator");
    await setup.close();
    const runtime = await compose(path, "acme.healthy.model-a");
    expect(runtime.plugins.status("acme.providers").phase).toBe("failed");
    expect(runtime.plugins.status("acme.healthy").phase).toBe("ready");
    expect(await search(runtime)).toMatchObject({ provider: "acme.healthy.search-a", sources: [{ title: "a" }] });
    const result = await runtime.workflow!.admit({
      context: context(),
      kind: "start",
      operationKey: "healthy-model",
      prompt: "hello",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(result.outcome.status).toBe("completed");
  });

  it("refuses external-only readiness when construction fails and cleans the partially created instances", async () => {
    const source = artifact(
      "1.0.0",
      moduleCode.replace(
        "create: ({ settings, instanceId }) => ({",
        'create: () => { throw new Error("constructor failed"); }, ignored: () => ({',
      ),
    );
    const path = await prepare(source);
    await expect(compose(path)).rejects.toThrow(/No model provider connection is ready/);
    // A subsequent diagnostic owner can still acquire the profile: failed startup released it.
    const diagnostic = await composeTaviRuntime(
      {
        dataDirectory: path,
        workspaces,
        providers: [],
        credentials: {},
        defaultConnectionId: "none",
        defaultModel: "none",
        externalPlugins: "verify",
        logger: { level: "error", sink: () => {} },
      },
      { requireModelTransport: false },
    );
    runtimes.push(diagnostic);
    expect(diagnostic.plugins.status("acme.providers").phase).toBe("verified");
  });
});

it("recognizes an offline configured model on the first CLI launch", async () => {
  const path = await prepare();
  const resolved = await resolveModelTarget({
    dataDirectory: path,
    connectionId: "acme.providers.model-a",
    model: "fixture",
    workspaceId: "a",
    principalId: "owner-a",
    prompt: "hello",
    format: "text",
    approval: "ask",
    quiet: true,
    inMemory: false,
  });
  const options = runtimeOptionsForTarget(resolved, {});
  expect(options.providers).toEqual([]);
  const runtime = await composeTaviRuntime({ ...options, workspaces, scheduleSweepEnabled: false });
  runtimes.push(runtime);
  expect(runtime.plugins.status("acme.providers").phase).toBe("ready");
});
