import type { MemoryItem, MemoryListAnswer, MemoryPayload, MemoryServicePort } from "@tavi/contracts";
import { MemoryService, ToolRegistry } from "@tavi/runtime";
import { describe, expect, it } from "vitest";

import type { TaviRuntime } from "../../src/runtime/types.js";
import { centerCommand } from "../../src/server/center.js";
import type { heartbeatMemoryContext } from "../../src/features/heartbeat/sources.js";
import { memoryCommand } from "../../src/features/memory/owner.js";
import { registerMemoryTools } from "../../src/features/memory/tools.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * Every reader through the port: a plain object
 * implementing `MemoryServicePort` — no class, no private field — stands
 * wherever the owner took the class: the runtime's `memory`, the agent's
 * memory tools, the heartbeat's memory block, the `memory` command and the
 * Center's counts. The command's reads then reach only that object.
 */

/** A plain port over `inner`, recording which methods were called. */
function plainPort(inner: MemoryServicePort): MemoryServicePort & { readonly called: Set<string> } {
  const called = new Set<string>();
  const seen = <T>(name: string, value: T): T => {
    called.add(name);
    return value;
  };
  return {
    called,
    propose: async (input) => seen("propose", await inner.propose(input)),
    remember: async (input) => seen("remember", await inner.remember(input)),
    approve: async (input) => seen("approve", await inner.approve(input)),
    reject: async (input) => seen("reject", await inner.reject(input)),
    correct: async (input) => seen("correct", await inner.correct(input)),
    revoke: async (input) => seen("revoke", await inner.revoke(input)),
    forget: async (input) => seen("forget", await inner.forget(input)),
    get: async (input) => seen("get", await inner.get(input)),
    list: async (input) => seen("list", await inner.list(input)),
    search: async (input) => seen("search", await inner.search(input)),
    eligible: async (input) => seen("eligible", await inner.eligible(input)),
    resolvePreferences: async (input) => seen("resolvePreferences", await inner.resolvePreferences(input)),
    resolveFactConflicts: async (input) => seen("resolveFactConflicts", await inner.resolveFactConflicts(input)),
    export: async (input) => seen("export", await inner.export(input)),
    usage: async (input) => seen("usage", await inner.usage(input)),
    sweepExpired: async (input) => seen("sweepExpired", await inner.sweepExpired(input)),
    operatorView: async (input) => seen("operatorView", await inner.operatorView(input)),
    history: async (input) => seen("history", await inner.history(input)),
    related: async (input) => seen("related", await inner.related(input)),
    counts: async (input) => seen("counts", await inner.counts(input)),
    principals: async (input) => seen("principals", await inner.principals(input)),
  };
}

describe("a plain MemoryServicePort where the class was required", () => {
  it("type-checks as the runtime's memory, the tools', the heartbeat's and the commands', and serves the operator's page", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const port = plainPort(new MemoryService(store.asPort()));
    // Where `MemoryService` (the class) was once required.
    const runtimeMemory: TaviRuntime["memory"] = port;
    const registry = new ToolRegistry();
    registerMemoryTools(registry, runtimeMemory);
    expect(registry.list().map((tool) => tool.id)).toEqual([
      "memory.forget",
      "memory.get",
      "memory.list",
      "memory.propose",
      "memory.search",
    ]);
    const heartbeatMemory: Parameters<typeof heartbeatMemoryContext>[0] = port;
    expect(heartbeatMemory).toBe(port);

    const deps = {
      memory: port,
      repositories: store.asPort().repositories,
      principalOf: () => "operator",
      fromBridge: false,
      now: () => new Date(),
    };
    const run = async <T>(payload: MemoryPayload): Promise<T> => {
      const answer = await memoryCommand(deps, payload);
      if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`);
      return answer.result as T;
    };
    const kept = await run<MemoryItem>({
      action: "remember",
      kind: "fact",
      scope: "personal",
      body: "Travels to Lisbon every spring for work",
    });
    await port.propose({
      actor: { principalId: "operator", workspaceId: "default", caller: "test", authority: "model" },
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "Travels to Lisbon every spring for work trips",
    });
    const listed = await run<MemoryListAnswer>({ action: "list" });
    expect(listed.records.map((record) => record.body).sort()).toEqual([
      "Travels to Lisbon every spring for work",
      "Travels to Lisbon every spring for work trips",
    ]);
    // The proposal says what it is similar to: the service computed it.
    expect(listed.records.find((record) => record.status === "proposed")?.similarTo).toMatchObject({ recordId: kept.recordId });
    expect((await run<MemoryListAnswer>({ action: "list", query: "Lisbon" })).records).toHaveLength(1);
    expect((await run<{ record: MemoryItem }>({ action: "get", recordId: kept.recordId })).record.body).toBe(
      "Travels to Lisbon every spring for work",
    );
    expect(await run({ action: "usage" })).toMatchObject({ records: 2 });
    // Every read the page made went through the port.
    for (const method of ["operatorView", "list", "search", "get", "history", "related", "usage"])
      expect(port.called.has(method), method).toBe(true);

    // The Center rail's count is the port's.
    const center = await centerCommand(
      { repositories: store.asPort().repositories, memory: port, principalOf: () => "operator", now: () => new Date() },
      { action: "summary" },
    );
    expect(center).toMatchObject({ ok: true, result: { counts: { memoryProposals: 1 } } });
    expect(port.called.has("counts")).toBe(true);
  });
});
