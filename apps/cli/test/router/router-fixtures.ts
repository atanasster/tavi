import { join } from "node:path";
import { ATTENDED_TASK_POLICY, RouterSettingsSchema, type ModelRequest } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { type DatabaseClient, MemoryService, ModelAccounting, ModelConfigService, SkillService } from "@tavi/runtime";
import { SqliteStore, inspectDatabase } from "../support/database-fixture.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";

/** Shared harness for the router plugin and provider tests: a seeded data directory and a scripted model. */
export const scope = { workspaceId: "default", principalId: "operator" };
const actor = { ...scope, caller: "cli" as const, authority: "operator" as const };

export const ROUTED = RouterSettingsSchema.parse({
  enabled: true,
  modes: { tools: "active", memory: "active", skills: "active", model: "active" },
  egress: { taskText: true, toolDescriptions: true, memoryExcerpts: true, skillMetadata: true },
  providerSettings: { "tavi.router": { credentialRef: "jev.key" } },
  priceRevision: "jev-price",
});

/** An owner-only temporary directory, removed by `cleanup`. */
export function temporary(cleanup: (() => unknown)[]): string {
  const directories = temporaryDirectories();
  cleanup.push(() => directories.cleanup());
  return directories.create("tavi-router-plugin-");
}

/** Main/fast models, prices, a memory and an active skill, as in router-combined. */
export async function seed(directory: string): Promise<SqliteStore> {
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  const models = new ModelConfigService(store.asPort());
  for (const connectionId of ["main", "fast"]) {
    await models.putConnection({
      connectionId,
      kind: "openai-compatible",
      baseUrl: `https://${connectionId}.invalid/v1`,
      credentialRef: `${connectionId}.key`,
      label: connectionId,
    });
    await models.putCatalogEntry({
      connectionId,
      modelId: "m",
      provenance: "live",
      state: "capable",
      capabilities: ["tools", "streaming"],
      contextWindow: 256_000,
      maxTokens: 4096,
    });
  }
  await models.setRoleBinding({ workspaceId: "default", role: "fast", target: { connectionId: "fast", model: "m" }, fallback: [] });
  const accounting = new ModelAccounting(store.asPort());
  for (const [connectionId, model, price] of [
    ["main", "m", 2],
    ["fast", "m", 1],
    ["jev", "jev-1.13.0", 0.042],
  ] as const)
    await accounting.putPrice({
      revision: `${connectionId}-price`,
      connectionId,
      model,
      effectiveAt: "2026-01-01T00:00:00.000Z",
      currency: "USD",
      input: price,
      cacheRead: price,
      cacheWrite: price,
      output: connectionId === "jev" ? 0 : price,
    });
  const memory = new MemoryService(store.asPort());
  const record = await memory.propose({
    actor,
    scope: { kind: "personal", principalId: "operator" },
    kind: "fact",
    body: "wombat project uses TypeScript",
  });
  await memory.approve({ actor, recordId: record.recordId });
  const skills = new SkillService(store.asPort());
  await skills.import({
    actor,
    skillId: "wombat",
    version: "1.0.0",
    manifest: {
      name: "wombat",
      description: "wombat project help",
      supportedRuntimeVersions: ["1.0"],
      supportedToolContractVersions: ["1.0"],
    },
    packageBody: new TextEncoder().encode("Wombat instructions"),
    provenance: "fixture",
  });
  await skills.approve({ actor, skillId: "wombat", version: "1.0.0" });
  await skills.activate({ actor, skillId: "wombat", version: "1.0.0" });
  return store;
}

export async function seeded(cleanup: (() => unknown)[]): Promise<{ directory: string; store: SqliteStore }> {
  const directory = temporary(cleanup);
  return { directory, store: await seed(directory) };
}

export async function compose(
  directory: string,
  store: SqliteStore | undefined,
  routerFetch: typeof fetch,
  requests: ModelRequest[],
): Promise<TaviRuntime> {
  const providers = ["main", "fast"].map((connectionId) => ({
    connectionId,
    kind: "openai-compatible" as const,
    baseUrl: `https://${connectionId}.invalid/v1`,
    credentialRef: `${connectionId}.key`,
  }));
  return composeTaviRuntime(
    {
      dataDirectory: directory,
      workspaces: [{ ...scope, permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      providers,
      credentials: { "main.key": { value: "fixture" }, "fast.key": { value: "fixture" }, "jev.key": { value: "fixture" } },
      defaultConnectionId: "main",
      defaultModel: "m",
      logger: { level: "error", sink: () => {} },
      approvalRequiredFor: [],
    },
    {
      ...(store === undefined ? {} : { store }),
      routerFetch,
      modelOverride: {
        async stream(request) {
          requests.push(request);
          return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
        },
      },
    },
  );
}

export const run = async (runtime: TaviRuntime, key: string) =>
  runtime.workflow?.admit({
    context: { ...scope, runId: "pending", caller: "cli" },
    operationKey: key,
    kind: "start",
    prompt: "wombat",
    origin: "cli",
    executionPolicy: ATTENDED_TASK_POLICY,
  });
export const rows = (store: DatabaseClient, table: string): number =>
  (inspectDatabase(store).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
export const routerRows = (store: SqliteStore) => ({
  decisions: rows(store, "tavi_router_decisions"),
  routes: rows(store, "tavi_task_routes"),
  disclosures: rows(store, "tavi_tool_disclosures"),
  projections: rows(store, "tavi_context_projections"),
  attempts: (
    store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_provider_attempts WHERE json_extract(data, '$.purpose')='router'").get() as {
      n: number;
    }
  ).n,
});
