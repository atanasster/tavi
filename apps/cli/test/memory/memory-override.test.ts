import { MEMORY_PORT_CONFORMANCE, type MemoryOverride, type MemoryOverrideDependencies, type MemoryServicePort } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { DatabaseClient, MemoryService } from "@tavi/runtime";
import { waitFor, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime, TaviRuntimeOverrides } from "../../src/runtime/types.js";
import { buildDoctorDocument } from "../../src/features/doctor/reports.js";
import { inspectDatabase } from "../support/database-fixture.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * An embedder's `memoryOverride`:
 * the owner starts on it only when it declares `@tavi/plugin-kit/memory`'s port
 * suite, then reads and writes memory through it alone, wakes the Center
 * through `onChange`, and doctor says backup and reset no longer cover it.
 */

const directories = temporaryDirectories({ prefix: "tavi-memory-override-" });
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  directories.cleanup();
});

const directory = (): string => directories.create();

async function compose(
  dataDirectory: string,
  memoryOverride: TaviRuntimeOverrides["memoryOverride"],
  extra: { readonly retentionSweepEnabled?: boolean; readonly retentionSweepIntervalMs?: number } = {},
): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(dataDirectory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      providers: [{ connectionId: "fixture", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "fixture" }],
      ...extra,
    }),
    { modelOverride: createFixtureModel({ turns: [] }), ...(memoryOverride === undefined ? {} : { memoryOverride }) },
  );
  cleanup.push(() => runtime.close());
  return runtime;
}

/** The embedder's service: the built-in over a database of its own, so none of its records are in the owner's. `calls` names each method called on it, in order. */
async function embedderService(
  calls: string[] = [],
): Promise<{ readonly override: MemoryOverride; readonly built: MemoryOverrideDependencies[] }> {
  const client = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  cleanup.push(() => client.close());
  const built: MemoryOverrideDependencies[] = [];
  return {
    built,
    override: {
      conformance: MEMORY_PORT_CONFORMANCE,
      create: (dependencies) => {
        built.push(dependencies);
        const service = new MemoryService(client, { now: dependencies.now });
        // Its writes wake the Center as the built-in's triggers would.
        return new Proxy(service as unknown as MemoryServicePort, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return async (...args: unknown[]) => {
              calls.push(String(property));
              const answer = await (value as (...input: unknown[]) => Promise<unknown>).apply(target, args);
              const scope = (answer as { readonly scope?: Parameters<MemoryOverrideDependencies["onChange"]>[0] } | undefined)?.scope;
              if (property !== "get" && scope !== undefined) await dependencies.onChange(scope);
              return answer;
            };
          },
        });
      },
    },
  };
}

describe("memoryOverride", () => {
  it("memory invariant 15: refuses to start on an override that does not declare the port suite, before owning the directory", async () => {
    const dataDirectory = directory();
    let built = 0;
    const create = () => {
      built += 1;
      throw new Error("never built");
    };
    for (const undeclared of [{ create }, { conformance: "tavi.memory-port/0", create }, { conformance: MEMORY_PORT_CONFORMANCE }]) {
      await expect(compose(dataDirectory, undeclared as unknown as MemoryOverride)).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: expect.stringContaining(MEMORY_PORT_CONFORMANCE),
      });
    }
    expect(built).toBe(0);
    // Nothing was owned: the same directory starts at once on the built-in.
    const runtime = await compose(dataDirectory, undefined);
    expect(runtime.memoryOverridden).toBeUndefined();
    expect((await buildDoctorDocument(runtime, { integrity: "skip" })).memory["service"]).toBeUndefined();
  });

  it("reads and writes memory through the override alone, wakes the Center, and doctor says what backup no longer covers", async () => {
    const calls: string[] = [];
    const { override, built } = await embedderService(calls);
    const runtime = await compose(directory(), override);
    expect(built).toHaveLength(1);
    expect(runtime.memoryOverridden).toBe(true);
    const actor = { principalId: "alice", workspaceId: "default", caller: "test", authority: "operator" } as const;

    const center = runtime.store.asPort().repositories.center;
    const before = await center.changes({ workspaceId: "default", principalId: "alice" });
    const record = await runtime.memory.remember({
      actor,
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      body: "Keeps bees",
    });
    expect((await center.changes({ workspaceId: "default", principalId: "alice", cursor: before.cursor })).changed).toEqual(["memory"]);
    expect((await runtime.memory.search({ actor, query: "bees" })).hits.map((hit) => hit.recordId)).toEqual([record.recordId]);
    // The owner's own memory tables hold none of it.
    expect(await runtime.store.asPort().repositories.memory.listRecords({ scopeKeys: [record.scopeKey], limit: 10 })).toEqual([]);
    // Forget goes through the override, around the owner's card edits.
    calls.length = 0;
    vi.spyOn(runtime.memoryChannelCards, "beforeForget").mockImplementation(async () => {
      calls.push("cards before");
      return { after: async () => void calls.push("cards after"), unreached: [] };
    });
    expect((await runtime.memory.forget({ actor, recordId: record.recordId, reason: "test" })).cleanupStatus).toBe("complete");
    expect(calls).toEqual(["cards before", "forget", "cards after"]);
    await expect(runtime.memory.get({ actor, recordId: record.recordId })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const doctor = await buildDoctorDocument(runtime, { integrity: "skip" });
    expect(doctor.memory["service"]).toMatchObject({ override: true, conformance: MEMORY_PORT_CONFORMANCE });
    // Tavi's own vector tables hold none of the override's records: doctor says nothing of them.
    expect(doctor.memory["vectors"]).toBeUndefined();
  });

  it("the retention sweep settles a memory card's rows by what the override says, keeping a pending one's", async () => {
    const { override } = await embedderService();
    const runtime = await compose(directory(), override, { retentionSweepEnabled: true, retentionSweepIntervalMs: 100 });
    const at = nowTimestamp();
    const db = inspectDatabase(runtime.store);
    db.prepare(
      "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at) VALUES('chat','default','alice','t','','completed',?,?)",
    ).run(at, at);
    db.close();
    const operator = { principalId: "alice", workspaceId: "default", caller: "test", authority: "operator" } as const;
    const model = { ...operator, agentId: "agent-main", caller: "model", authority: "model" } as const;
    const scope = { kind: "personal", principalId: "alice" } as const;
    const pending = await runtime.memory.propose({ actor: model, scope, kind: "fact", body: "Keeps bees" });
    const decided = await runtime.memory.propose({ actor: model, scope, kind: "fact", body: "Grows tomatoes" });
    const transcripts = runtime.store.asPort().repositories.transcripts;
    await transcripts.postMemoryCard({
      noticeId: "card",
      taskId: "chat",
      sourceKey: "memory:a1",
      createdAt: at,
      records: [pending.recordId, decided.recordId].map((recordId) => ({ recordId, workspaceId: "default", principalId: "alice" })),
    });
    await runtime.memory.approve({ actor: operator, recordId: decided.recordId });

    await waitFor(
      async () => (await transcripts.memoryPrompts("card")).some((row) => row.recordId === decided.recordId && row.settledAt !== undefined),
      10_000,
    );
    expect((await transcripts.memoryPrompts("card")).find((row) => row.recordId === pending.recordId)?.settledAt).toBeUndefined();
  }, 60_000);
});
