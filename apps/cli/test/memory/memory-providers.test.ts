import { describe, expect, it } from "vitest";
import { partialFake, delay } from "@tavi/test-support";

import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MEMORY_PROVIDER_LIMITS,
  RouterSettingsSchema,
  memoryScopeKey,
  type AccessPolicyPort,
  type MemoryActor,
  type MemoryProvider,
  type MemoryRecallRequest,
  type MemoryScope,
  type MemorySearchHit,
  type MemorySearchResult,
  type MemoryServicePort,
  type RouterPort,
} from "@tavi/contracts";
import { describeMemoryServiceConformance, type MemoryPortFactory } from "@tavi/plugin-kit/memory/conformance";
import { BUILTIN_MEMORY_DECLARATION, createBuiltinMemoryProvider } from "@tavi/plugin-defaults/memory";
import { assembleRoutedContext } from "@tavi/agent-host/context";
import { MemoryService } from "@tavi/runtime";

import {
  MemoryProviderRegistry,
  chatCaptureProviderOf,
  readableScopeKeys,
  recallThroughProviders,
  withProviderRecall,
  type MemoryRecallHost,
} from "../../src/features/memory/providers.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * Recall through the host's memory providers: the built-in answers exactly what the host's search does; any
 * provider's ids are re-checked against what that search found eligible, or
 * by id with the same filters, and rendered from the host's rows; a provider
 * that fails or runs late is replaced by the host's own answer, said to be
 * partial; a turn's step asks the provider once; an operator's search never
 * reaches a provider.
 */

type SearchInput = Parameters<MemoryServicePort["search"]>[0];
type EligibleInput = Parameters<MemoryServicePort["eligible"]>[0];

const hit = (n: number, overrides: Partial<MemorySearchHit> = {}): MemorySearchHit => ({
  recordId: `mem-${n}`,
  revisionId: `rev-${n}`,
  scope: { kind: "personal", principalId: "alice" },
  kind: "fact",
  title: `Record ${n}`,
  snippet: `What record ${n} says`,
  recordedAt: "2026-10-01T00:00:00.000Z",
  superseded: false,
  conflict: false,
  ...overrides,
});

/**
 * The host's search: what the actor may read, best first, cut to `limit`;
 * and its by-id check, answering those of `eligible` and `byId` asked for.
 * Every call recorded.
 */
function hostSearch(
  eligible: readonly MemorySearchHit[],
  result: Partial<MemorySearchResult> = {},
  byId: readonly MemorySearchHit[] = [],
): MemoryRecallHost & { readonly calls: SearchInput[]; readonly checks: EligibleInput[] } {
  const calls: SearchInput[] = [];
  const checks: EligibleInput[] = [];
  const search = async (input: SearchInput): Promise<MemorySearchResult> => {
    calls.push(input);
    if (input.query.trim() === "") throw new Error("A search query must not be blank");
    return { hits: eligible.slice(0, input.limit ?? 10), coverage: "complete", ...result };
  };
  const readable = [...eligible, ...byId];
  const check = async (input: EligibleInput): Promise<readonly MemorySearchHit[]> => {
    checks.push(input);
    return input.recordIds.flatMap((recordId) => readable.filter((row) => row.recordId === recordId));
  };
  return { search, eligible: check, calls, checks };
}

const actor = { workspaceId: "default", principalId: "alice", runId: "chat-1", caller: "workflow", authority: "model" as const };

/** The providers recall asks: `provider` as every workspace's choice, installed in the built-in's place. */
function registryWith(provider: MemoryProvider): Pick<MemoryProviderRegistry, "choice" | "get"> {
  const registry = new MemoryProviderRegistry();
  registry.install(BUILTIN_MEMORY_PROVIDER_ID, { provider, kind: "builtin", declaration: BUILTIN_MEMORY_DECLARATION });
  return registry;
}

/** A provider that ranks with an index of its own, never asking the host: `ranked` every time, its recalls counted. */
function ownIndex(ranked: readonly { readonly recordId: string; readonly revisionId: string }[]): MemoryProvider & { recalls: number } {
  const provider = {
    recalls: 0,
    async recall() {
      provider.recalls += 1;
      return { hits: ranked.map((entry, index) => ({ ...entry, score: ranked.length - index })) };
    },
  };
  return provider;
}

describe("recall through the built-in provider", () => {
  it("answers exactly what the host's search answers, for a turn, a tool call and a heartbeat check", async () => {
    const eligible = [hit(1), hit(2, { conflict: true, conflictsWith: ["mem-3"] }), hit(3)];
    for (const purpose of ["turn", "tool", "heartbeat"] as const) {
      const host = hostSearch(eligible, { coverage: "partial", reducedReason: "2 of 3 records have no vector yet" });
      const recall = recallThroughProviders(host, registryWith(createBuiltinMemoryProvider()));
      const input = { actor, query: "garden tea", match: "any" as const, limit: 2, semantic: "what do I grow in my garden?" };
      const direct = await host.search(input);
      expect(await recall({ ...input, purpose })).toEqual(direct);
      // One search of the host's own a recall, with what the caller asked (the semantic text too, for hybrid), and no check by id.
      expect(host.calls).toEqual([input, input]);
      expect(host.checks).toEqual([]);
    }
  });

  it("keeps a refused search the caller's error, as it is without a provider", async () => {
    const recall = recallThroughProviders(hostSearch([hit(1)]), registryWith(createBuiltinMemoryProvider()));
    await expect(recall({ actor, query: "   ", purpose: "tool" })).rejects.toThrow("must not be blank");
  });

  it("sends an operator's search, or one naming no purpose, straight to the service", async () => {
    let asked = 0;
    const provider: MemoryProvider = {
      recall: async () => {
        asked += 1;
        return { hits: [] };
      },
    };
    const host = hostSearch([hit(1)]);
    const recall = recallThroughProviders(host, registryWith(provider));
    expect((await recall({ actor, query: "garden" })).hits).toEqual([hit(1)]);
    expect((await recall({ actor, query: "garden", view: "operator", purpose: "turn" })).hits).toEqual([hit(1)]);
    expect(asked).toBe(0);
    // The service never sees `purpose`, nor a turn's `recallKey`.
    expect(host.calls.every((input) => !("purpose" in input) && !("recallKey" in input))).toBe(true);
  });

  it("is what the port's own recall uses once wrapped, and nothing else of the port changes", async () => {
    const { search, eligible } = hostSearch([hit(1), hit(2)]);
    const port = { search, eligible, get: async () => "got", marker: 7 } as unknown as MemoryServicePort;
    const wrapped = withProviderRecall(port, registryWith(createBuiltinMemoryProvider()));
    expect((await wrapped.search({ actor, query: "garden", purpose: "turn" })).hits.map((entry) => entry.recordId)).toEqual([
      "mem-1",
      "mem-2",
    ]);
    expect(await (wrapped as unknown as { get: () => Promise<string> }).get()).toBe("got");
    expect((wrapped as unknown as { marker: number }).marker).toBe(7);
  });

  it("never cuts the caller's query for the host's own search, whatever the provider is sent", async () => {
    const host = hostSearch([hit(1)]);
    const long = `garden ${"x".repeat(MEMORY_PROVIDER_LIMITS.queryChars)}`;
    const seen: string[] = [];
    const provider: MemoryProvider = {
      async recall(request) {
        seen.push(request.query);
        return { hits: await request.host.lexical(request.query, request.limit) };
      },
    };
    await recallThroughProviders(host, registryWith(provider))({ actor, query: long, purpose: "tool" });
    expect(seen[0]).toHaveLength(MEMORY_PROVIDER_LIMITS.queryChars);
    expect(host.calls.map((input) => input.query)).toEqual([long]);
  });
});

describe("memory invariant 4: recall is filtered before it is ranked", () => {
  it("re-checks a provider's ids against the actor's eligibility and renders only the host's own rows, in the provider's order", async () => {
    const seen: MemoryRecallRequest[] = [];
    const provider: MemoryProvider = {
      async recall(request) {
        seen.push(request);
        await request.host.lexical(request.query, request.limit);
        return {
          hits: [
            { recordId: "mem-2", revisionId: "rev-2", score: 9 },
            // Another person's record, or one forgotten: the host finds it eligible neither by words nor by id.
            { recordId: "mem-bob", revisionId: "rev-bob", score: 8 },
            // An eligible record at a revision that is no longer current.
            { recordId: "mem-1", revisionId: "rev-0", score: 7 },
            { recordId: "mem-3", revisionId: "rev-3", score: 6 },
            { recordId: "mem-2", revisionId: "rev-2", score: 5 },
          ],
        };
      },
    };
    const host = hostSearch([hit(1), hit(2), hit(3)]);
    const answer = await recallThroughProviders(host, registryWith(provider))({ actor, query: "garden", limit: 10, purpose: "tool" });
    expect(answer.hits).toEqual([hit(2), hit(3)]);
    // Only the id no search carried is checked by id, as the actor.
    expect(host.checks).toEqual([{ actor, recordIds: ["mem-bob"] }]);
    // The provider was asked for ids, never handed text, and given only the host's lexical search.
    expect(Object.keys(seen[0]!.host)).toEqual(["lexical"]);
    expect(seen[0]).toMatchObject({ query: "garden", purpose: "tool", limit: 10, scopeKeys: [] });
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("checks ids against the host's own search when the provider never asked it, so nothing it invents renders", async () => {
    const provider = ownIndex([
      { recordId: "mem-9", revisionId: "rev-9" },
      { recordId: "mem-1", revisionId: "rev-1" },
    ]);
    const answer = await recallThroughProviders(hostSearch([hit(1)]), registryWith(provider))({ actor, query: "garden", purpose: "turn" });
    expect(answer.hits).toEqual([hit(1)]);
  });

  it("renders an eligible record an own index ranked that the host's words never matched, checked by id", async () => {
    // mem-7 holds none of the query's words: only the by-id check finds it eligible, at its current revision.
    const host = hostSearch([hit(1)], {}, [hit(7)]);
    const provider = ownIndex([
      { recordId: "mem-7", revisionId: "rev-7" },
      { recordId: "mem-8", revisionId: "rev-8" },
      { recordId: "mem-1", revisionId: "rev-1" },
    ]);
    const answer = await recallThroughProviders(
      host,
      registryWith(provider),
    )({ actor, query: "garden", purpose: "tool", includeSensitive: false });
    expect(answer.hits).toEqual([hit(7), hit(1)]);
    expect(host.checks).toEqual([{ actor, recordIds: ["mem-7", "mem-8"], includeSensitive: false }]);
    // At a revision the check does not answer, it does not render.
    const stale = ownIndex([{ recordId: "mem-7", revisionId: "rev-6" }]);
    expect(
      (await recallThroughProviders(hostSearch([hit(1)], {}, [hit(7)]), registryWith(stale))({ actor, query: "garden", purpose: "tool" }))
        .hits,
    ).toEqual([]);
  });

  it("over the memory service, never renders another person's, a sensitive, a forgotten or a superseded record an own index ranks", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const service = new MemoryService(store.asPort());
    const alice: MemoryActor = { principalId: "alice", workspaceId: "default", caller: "cli", authority: "operator" };
    const personal: MemoryScope = { kind: "personal", principalId: "alice" };
    const kept = async (who: MemoryActor, scope: MemoryScope, body: string, extra: { readonly sensitivity?: "sensitive" } = {}) => {
      const proposal = await service.propose({ actor: who, scope, kind: "fact", body, ...extra });
      return await service.approve({ actor: who, recordId: proposal.recordId });
    };
    const garden = await kept(alice, personal, "Alice keeps a garden");
    const roses = await kept(alice, personal, "Roses climb the south wall");
    const bobs = await kept({ ...alice, principalId: "bob" }, { kind: "personal", principalId: "bob" }, "Bob keeps bees");
    const sensitive = await kept(alice, personal, "A confidential diagnosis", { sensitivity: "sensitive" });
    const forgotten = await kept(alice, personal, "Erased on request");
    await service.forget({ actor: alice, recordId: forgotten.recordId, reason: "operator request" });
    const corrected = await kept(alice, personal, "Tulips by the gate");
    const stale = corrected.currentRevisionId!;
    await service.correct({ actor: alice, recordId: corrected.recordId, body: "Tulips and irises by the gate" });
    const provider = ownIndex([
      { recordId: bobs.recordId, revisionId: bobs.currentRevisionId! },
      { recordId: sensitive.recordId, revisionId: sensitive.currentRevisionId! },
      { recordId: forgotten.recordId, revisionId: forgotten.currentRevisionId! },
      { recordId: corrected.recordId, revisionId: stale },
      { recordId: roses.recordId, revisionId: roses.currentRevisionId! },
      { recordId: garden.recordId, revisionId: garden.currentRevisionId! },
    ]);
    const port = withProviderRecall(service as unknown as MemoryServicePort, registryWith(provider));
    const answer = await port.search({ actor: { ...alice, authority: "model", caller: "workflow" }, query: "garden", purpose: "turn" });
    // Roses never matched "garden": the by-id check found it eligible. The rest are nobody's to see here.
    expect(answer.hits.map((entry) => entry.recordId)).toEqual([roses.recordId, garden.recordId]);
    expect(answer.hits[0]).toMatchObject({ snippet: "Roses climb the south wall", revisionId: roses.currentRevisionId });
    expect(answer.coverage).toBe("complete");
  });

  it("answers with the host's own search, said to be partial, when the provider throws, answers out of contract or runs past its deadline", async () => {
    const logged: Record<string, unknown>[] = [];
    const providers: MemoryProvider[] = [
      {
        recall: async () => {
          throw new Error("index offline: key sk-secret");
        },
      },
      { recall: async () => ({ hits: [{ recordId: "mem-1", revisionId: "rev-1", score: 1, text: "What record 1 says" }] }) as never },
      { recall: async () => await new Promise<never>(() => {}) },
    ];
    const answers: MemorySearchResult[] = [];
    for (const provider of providers) {
      const recall = recallThroughProviders(hostSearch([hit(1), hit(2)]), registryWith(provider), {
        log: (_message, fields) => logged.push(fields),
        deadlineMs: { turn: 20, other: 20 },
      });
      answers.push(await recall({ actor, query: "garden", purpose: "turn" }));
    }
    expect(answers.map((answer) => answer.hits)).toEqual([
      [hit(1), hit(2)],
      [hit(1), hit(2)],
      [hit(1), hit(2)],
    ]);
    // The manifest says the provider failed: `partial`, with why, never the provider's words.
    expect(answers.map((answer) => answer.coverage)).toEqual(["partial", "partial", "partial"]);
    expect(answers.map((answer) => answer.reducedReason)).toEqual([
      `memory provider ${BUILTIN_MEMORY_PROVIDER_ID} failed (transport); the host's own search answered`,
      `memory provider ${BUILTIN_MEMORY_PROVIDER_ID} failed (invalid); the host's own search answered`,
      `memory provider ${BUILTIN_MEMORY_PROVIDER_ID} failed (transport); the host's own search answered`,
    ]);
    // An answer out of contract is the provider's own failure, not the transport's.
    expect(logged.map((fields) => fields["reason"])).toEqual(["failed:transport", "failed:invalid", "failed:transport"]);
    // A failure is logged by its reason, never the provider's words.
    expect(JSON.stringify([logged, answers])).not.toContain("sk-secret");
  });

  it("keeps an unavailable index unavailable when the provider fails over to it", async () => {
    const failing: MemoryProvider = {
      recall: async () => {
        throw new Error("down");
      },
    };
    const answer = await recallThroughProviders(
      hostSearch([], { coverage: "unavailable", reducedReason: "index locked" }),
      registryWith(failing),
    )({ actor, query: "garden", purpose: "tool" });
    expect(answer).toEqual({ hits: [], coverage: "unavailable", reducedReason: "index locked" });
  });

  it("refuses a provider's host search once its recall has answered or run past its deadline, so no search runs for nothing", async () => {
    let kept: MemoryRecallRequest["host"] | undefined;
    const answering: MemoryProvider = {
      recall: async (request) => {
        kept = request.host;
        return { hits: [] };
      },
    };
    const host = hostSearch([hit(1)]);
    await recallThroughProviders(host, registryWith(answering))({ actor, query: "garden", purpose: "tool" });
    const asked = host.calls.length;
    await expect(kept!.lexical("garden", 5)).rejects.toMatchObject({ reason: "budget" });
    expect(host.calls).toHaveLength(asked);

    let late: MemoryRecallRequest["host"] | undefined;
    const hanging: MemoryProvider = {
      recall: async (request) => {
        late = request.host;
        return await new Promise<never>(() => {});
      },
    };
    const slow = hostSearch([hit(1)]);
    expect(
      (
        await recallThroughProviders(slow, registryWith(hanging), { deadlineMs: { turn: 20, other: 20 } })({
          actor,
          query: "garden",
          purpose: "turn",
        })
      ).hits,
    ).toEqual([hit(1)]);
    const before = slow.calls.length;
    await expect(late!.lexical("garden", 5)).rejects.toMatchObject({ reason: "budget" });
    expect(slow.calls).toHaveLength(before);
  });

  it(`holds a provider to ${MEMORY_PROVIDER_LIMITS.lexicalCalls} host searches a recall: the next throws budget and searches nothing`, async () => {
    const refusals: unknown[] = [];
    const greedy: MemoryProvider = {
      async recall(request) {
        let last: readonly { recordId: string; revisionId: string; score: number }[] = [];
        for (let call = 0; call < MEMORY_PROVIDER_LIMITS.lexicalCalls + 2; call += 1) {
          try {
            last = await request.host.lexical(`garden ${call}`, request.limit);
          } catch (error) {
            refusals.push(error);
          }
        }
        return { hits: last };
      },
    };
    const host = hostSearch([hit(1), hit(2)]);
    const answer = await recallThroughProviders(host, registryWith(greedy))({ actor, query: "garden", purpose: "tool" });
    expect(host.calls).toHaveLength(MEMORY_PROVIDER_LIMITS.lexicalCalls);
    expect(refusals).toHaveLength(2);
    expect(refusals.every((error) => (error as { reason?: unknown }).reason === "budget")).toBe(true);
    // What it ranked within its bound still renders.
    expect(answer.hits).toEqual([hit(1), hit(2)]);
  });

  it("does not blame the provider when the host's own search it asked for is what ran past the deadline", async () => {
    const logged: Record<string, unknown>[] = [];
    const search = async (input: SearchInput): Promise<MemorySearchResult> => {
      await delay(60);
      return { hits: [hit(1), hit(2)].slice(0, input.limit ?? 10), coverage: "complete" };
    };
    const recall = recallThroughProviders({ search, eligible: async () => [] }, registryWith(createBuiltinMemoryProvider()), {
      log: (_message, fields) => logged.push(fields),
      deadlineMs: { turn: 20, other: 20 },
    });
    expect(await recall({ actor, query: "garden", purpose: "turn" })).toEqual({ hits: [hit(1), hit(2)], coverage: "complete" });
    expect(logged).toEqual([]);
  });

  it("keeps a heartbeat check's recall on the built-in, whatever else is installed", async () => {
    let external = 0;
    const registry = registryWith(createBuiltinMemoryProvider());
    const recall = recallThroughProviders(hostSearch([hit(1)]), {
      get: (id) => registry.get(id),
      // Every switch on: the heartbeat still never asks it (invariant 26).
      choice: async () => ({
        chosen: "acme.memory",
        egress: { records: true, conversation: true, includePersonal: true },
        provider: {
          id: "acme.memory",
          kind: "plugin",
          declaration: BUILTIN_MEMORY_DECLARATION,
          provider: {
            recall: async () => {
              external += 1;
              return { hits: [] };
            },
          },
        },
      }),
    });
    expect((await recall({ actor, query: "invoice", purpose: "heartbeat" })).hits).toEqual([hit(1)]);
    expect(external).toBe(0);
    expect((await recall({ actor, query: "invoice", purpose: "turn" })).hits).toEqual([]);
    expect(external).toBe(1);
  });
});

describe("a turn calls recall once", () => {
  it("asks the provider once for every search of one turn step, and re-checks its ids against a fresh search each time", async () => {
    let eligible = [hit(1), hit(2)];
    const host: MemoryRecallHost & { calls: number } = {
      calls: 0,
      search: async (input) => {
        host.calls += 1;
        return { hits: eligible.slice(0, input.limit ?? 10), coverage: "complete" };
      },
      eligible: async () => [],
    };
    const provider = ownIndex([
      { recordId: "mem-2", revisionId: "rev-2" },
      { recordId: "mem-1", revisionId: "rev-1" },
    ]);
    const recall = recallThroughProviders(host, registryWith(provider));
    const input = { actor, query: "garden", purpose: "turn" as const, recallKey: "turn-1:0" };
    expect((await recall(input)).hits).toEqual([hit(2), hit(1)]);
    // Forgotten since: the fresh search no longer finds mem-2, and the reused ranking does not bring it back.
    eligible = [hit(1)];
    expect((await recall({ ...input })).hits).toEqual([hit(1)]);
    expect(provider.recalls).toBe(1);
    expect(host.calls).toBe(2);
    // The next step, or the same step asking something else, asks again.
    await recall({ ...input, recallKey: "turn-1:1" });
    await recall({ ...input, query: "roses" });
    await recall({ actor, query: "garden", purpose: "turn" });
    expect(provider.recalls).toBe(4);
  });

  it("keeps a failed recall failed for the rest of its step, answering the host's own search, said to be partial", async () => {
    let asked = 0;
    const failing: MemoryProvider = {
      recall: async () => {
        asked += 1;
        throw new Error("down");
      },
    };
    const recall = recallThroughProviders(hostSearch([hit(1)]), registryWith(failing));
    for (let read = 0; read < 3; read += 1) {
      const answer = await recall({ actor, query: "garden", purpose: "turn", recallKey: "turn-1:0" });
      expect(answer).toMatchObject({ hits: [hit(1)], coverage: "partial" });
    }
    expect(asked).toBe(1);
  });

  it("under the router, one routed context asks the provider once however often it reads memory", async () => {
    const settings = RouterSettingsSchema.parse({ enabled: true, modes: { memory: "active", skills: "active" } });
    const router: RouterPort = {
      configuration: async () => ({ revision: 1, settings }),
      disable() {},
      async dispose() {},
      async decide(input) {
        return {
          decisionId: "d",
          operationId: input.operationId,
          taskId: input.fence.taskId,
          turnId: input.turnId,
          feature: input.feature,
          mode: "active",
          providerId: "tavi.router",
          configRevision: 1,
          policyVersion: "v1",
          candidateHash: "0".repeat(64),
          permissionRevision: input.permissionRevision,
          state: "finished",
          reason: "selected",
          selectedIds: ["mem-2"],
          probabilities: { "mem-2": 0.99 },
          cacheHit: false,
          elapsedMs: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
        };
      },
    };
    let searches = 0;
    const { search, eligible } = hostSearch([hit(1), hit(2)]);
    const port = partialFake<MemoryServicePort>({
      search: async (input: SearchInput) => {
        searches += 1;
        return await search(input);
      },
      eligible,
      resolvePreferences: async () => ({ preferences: [], truncated: false }),
    });
    const provider = ownIndex([
      { recordId: "mem-1", revisionId: "rev-1" },
      { recordId: "mem-2", revisionId: "rev-2" },
    ]);
    const memory = withProviderRecall(port, registryWith(provider));
    const routing = {
      service: router,
      fence: { taskId: "chat-1", generation: 1, ownerSession: "owner" },
      turnId: "turn-1",
      step: 0,
      signal: new AbortController().signal,
      isCurrent: () => true,
      prompt: "what grows here?",
    };
    let isCurrent: (() => boolean | Promise<boolean>) | undefined;
    const manifest = await assembleRoutedContext(
      { memory },
      { actor, instructions: "sys", query: "garden", queryMatch: "any" },
      {
        ...routing,
        onProjection: (_data, current) => {
          isCurrent = current;
        },
      },
    );
    expect(manifest.evidence.map((entry) => entry.recordId)).toEqual(["mem-2", "mem-1"]);
    expect(await isCurrent?.()).toBe(true);
    // The router read memory many times — candidates, its freshness checks, the assembly, the projection — and asked the provider once.
    expect(searches).toBeGreaterThan(3);
    expect(provider.recalls).toBe(1);
    // The next step asks once more.
    await assembleRoutedContext({ memory }, { actor, instructions: "sys", query: "garden", queryMatch: "any" }, { ...routing, step: 1 });
    expect(provider.recalls).toBe(2);
  });
});

describe("the host's memory provider registry", () => {
  it("selects the built-in for every workspace, refuses a second install under one id, and forgets an uninstalled one", async () => {
    const registry = new MemoryProviderRegistry();
    expect(await registry.selected("default")).toBeUndefined();
    const uninstall = registry.install(BUILTIN_MEMORY_PROVIDER_ID, {
      provider: createBuiltinMemoryProvider(),
      kind: "builtin",
      declaration: BUILTIN_MEMORY_DECLARATION,
    });
    expect((await registry.selected("default"))?.id).toBe(BUILTIN_MEMORY_PROVIDER_ID);
    expect((await registry.selected("other"))?.id).toBe(BUILTIN_MEMORY_PROVIDER_ID);
    expect(() =>
      registry.install(BUILTIN_MEMORY_PROVIDER_ID, {
        provider: createBuiltinMemoryProvider(),
        kind: "builtin",
        declaration: BUILTIN_MEMORY_DECLARATION,
      }),
    ).toThrow(/already installed/);
    expect(registry.list().map((entry) => entry.id)).toEqual([BUILTIN_MEMORY_PROVIDER_ID]);
    uninstall();
    expect(await registry.selected("default")).toBeUndefined();
  });

  it("falls back to the built-in from a selected provider that is not installed, telling the operator once", async () => {
    const told: string[] = [];
    let provider = "acme.memory";
    const registry = new MemoryProviderRegistry({
      settingsOf: async () => ({ provider, providerEgress: { records: false, conversation: true, includePersonal: false } }),
      onFallback: (_workspaceId, notice) => told.push(notice),
    });
    registry.install(BUILTIN_MEMORY_PROVIDER_ID, {
      provider: createBuiltinMemoryProvider(),
      kind: "builtin",
      declaration: BUILTIN_MEMORY_DECLARATION,
    });
    for (let read = 0; read < 3; read += 1)
      expect(await registry.choice("default")).toMatchObject({
        chosen: "acme.memory",
        provider: { id: BUILTIN_MEMORY_PROVIDER_ID },
        fallback: expect.stringContaining("Use built-in"),
      });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/Pick another/);
    const uninstall = registry.install("acme.memory", {
      provider: createBuiltinMemoryProvider(),
      kind: "plugin",
      declaration: BUILTIN_MEMORY_DECLARATION,
    });
    expect((await registry.choice("default")).provider?.id).toBe("acme.memory");
    uninstall();
    await registry.choice("default");
    expect(told).toHaveLength(2);
    provider = BUILTIN_MEMORY_PROVIDER_ID;
    expect((await registry.choice("default")).fallback).toBeUndefined();
  });

  it("drafts a local chat's span with the built-in, never an external provider, even with conversation egress on", async () => {
    const registry = new MemoryProviderRegistry({
      settingsOf: async () => ({ provider: "acme.memory", providerEgress: { records: true, conversation: true, includePersonal: false } }),
    });
    registry.install(BUILTIN_MEMORY_PROVIDER_ID, {
      provider: createBuiltinMemoryProvider(),
      kind: "builtin",
      declaration: BUILTIN_MEMORY_DECLARATION,
    });
    registry.install("acme.memory", { provider: createBuiltinMemoryProvider(), kind: "plugin", declaration: BUILTIN_MEMORY_DECLARATION });
    expect((await chatCaptureProviderOf(registry, "default", async () => false))?.id).toBe("acme.memory");
    expect((await chatCaptureProviderOf(registry, "default", async () => true))?.id).toBe(BUILTIN_MEMORY_PROVIDER_ID);
    // Unknown is local.
    expect(
      (
        await chatCaptureProviderOf(registry, "default", async () => {
          throw new Error("unreadable");
        })
      )?.id,
    ).toBe(BUILTIN_MEMORY_PROVIDER_ID);
  });

  it("without a provider, recall is the host's own search", async () => {
    expect(
      (await recallThroughProviders(hostSearch([hit(1)]), new MemoryProviderRegistry())({ actor, query: "garden", purpose: "turn" })).hits,
    ).toEqual([hit(1)]);
  });
});

/** The reader grant of a workspace's shared scope, as the facade asks it. */
const MEMORY_READ_SHARED_PERMISSION = "memory:read-shared";

/** Who holds the shared reader grant; nobody else holds any permission. */
function grantPolicy(grants: readonly { readonly principalId: string; readonly workspaceId: string }[]): AccessPolicyPort {
  return {
    resolveWorkspace: () => undefined,
    missingPermissions: (context, required) =>
      grants.some((grant) => grant.principalId === context.principalId && grant.workspaceId === context.workspaceId)
        ? required.filter((permission) => permission !== MEMORY_READ_SHARED_PERMISSION)
        : required,
  };
}

/**
 * The port the owner runs (invariant 15): the memory service as the worker's
 * facade serves it, wrapped by `withProviderRecall` with the built-in
 * installed — `openMemoryService`'s plain construction, given the case's clock
 * and quotas where the owner reads them from settings. Every search the suite
 * makes as the model would (`purpose: "tool"`) so it goes through the built-in.
 */
const composed: MemoryPortFactory = async (environment) => {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const persistence = store.asPort();
  const service = new MemoryService(persistence, {
    now: environment.now,
    ...(environment.quotas === undefined ? {} : { quotas: environment.quotas }),
    policy: grantPolicy(environment.sharedReaders),
  });
  const registry = new MemoryProviderRegistry();
  registry.install(BUILTIN_MEMORY_PROVIDER_ID, {
    provider: createBuiltinMemoryProvider(),
    kind: "builtin",
    declaration: BUILTIN_MEMORY_DECLARATION,
  });
  const wrapped = withProviderRecall(service as unknown as MemoryServicePort, registry);
  const port = new Proxy(wrapped, {
    get(target, property) {
      if (property !== "search") return Reflect.get(target, property, target);
      return async (input: SearchInput) =>
        await target.search(input.view === undefined && input.purpose === undefined ? { ...input, purpose: "tool" } : input);
    },
  });
  return {
    port,
    share: async ({ recordId, workspaceId, kind, body }) => {
      const scope: MemoryScope = { kind: "shared_workspace", workspaceId };
      const at = environment.now();
      await persistence.repositories.memory.insertRecord({
        record: {
          recordId,
          kind,
          scope,
          scopeKey: memoryScopeKey(scope),
          status: "approved",
          sensitivity: "normal",
          currentRevisionId: `${recordId}-rev`,
          revocationGeneration: 0,
          recordedAt: at,
          updatedAt: at,
        },
        revision: {
          revisionId: `${recordId}-rev`,
          recordId,
          revisionNumber: 1,
          schemaVersion: 1,
          body,
          contentHash: "h",
          author: "operator",
          sourceIds: [],
          recordedAt: at,
          sensitivity: "normal",
          status: "active",
        },
      });
    },
    addSource: async ({ sourceId, scopeKey, revoked, recordId, observedAt }) => {
      await persistence.repositories.memory.insertEvidence({
        sourceId,
        scopeKey,
        operatorInput: true,
        observedAt: observedAt ?? environment.now(),
        contentHash: "h",
        captureBasis: "explicit",
        retentionPolicy: "standard",
        revocationStatus: revoked === true ? "revoked" : "active",
        ...(recordId === undefined ? {} : { recordId }),
      });
    },
    // No public path revokes a source: the row is flipped as an external revocation would.
    revokeSource: (sourceId) => {
      store.handle.prepare("UPDATE tavi_evidence_sources SET revocation_status = 'revoked' WHERE source_id = ?").run(sourceId);
    },
  };
};

describeMemoryServiceConformance("memory invariant 15: the owner's port, recall through the built-in provider", composed);

describe("what a provider's recall leaves to the host", () => {
  const PLUGIN = "acme.memory";
  /** `provider` as an approved plugin every workspace selects, with these switches. */
  const pluginRegistry = (
    provider: MemoryProvider,
    egress: { readonly records: boolean; readonly conversation: boolean; readonly includePersonal: boolean },
  ) => {
    const registry = new MemoryProviderRegistry({ settingsOf: async () => ({ provider: PLUGIN, providerEgress: egress }) });
    registry.install(PLUGIN, {
      kind: "plugin",
      provider,
      declaration: { abi: "tavi.memory/1", capabilities: ["recall"], index: "own", receives: ["records", "conversation"] },
    });
    return registry;
  };

  it("a failed provider is answered for by the caller's own query at the caller's limit, never the query or depth it asked through host.lexical", async () => {
    const rows = Array.from({ length: 30 }, (_, index) => hit(index + 1));
    const calls: SearchInput[] = [];
    const host: MemoryRecallHost = {
      search: async (input) => {
        calls.push(input);
        // The caller's words match the first three; the provider's own pick matches others.
        return {
          hits: input.query === "garden" ? rows.slice(0, Math.min(input.limit ?? 10, 3)) : rows.slice(10, 10 + (input.limit ?? 10)),
          coverage: "complete",
        };
      },
      eligible: async () => [],
    };
    const chooses: MemoryProvider = {
      async recall(request) {
        await request.host.lexical("the neighbour's diary", 50);
        throw new Error("down");
      },
    };
    const result = await recallThroughProviders(host, registryWith(chooses))({ actor, query: "garden", limit: 2, purpose: "turn" });
    expect(result.hits.map((row) => row.recordId)).toEqual(["mem-1", "mem-2"]);
    expect(result.coverage).toBe("partial");
    // A search of the caller's own query, deeper than the caller's limit, is reused cut to it.
    calls.length = 0;
    const deeper: MemoryProvider = {
      async recall(request) {
        await request.host.lexical(request.query, 20);
        throw new Error("down");
      },
    };
    const reused = await recallThroughProviders(host, registryWith(deeper))({ actor, query: "garden", limit: 2, purpose: "turn" });
    expect(reused.hits.map((row) => row.recordId)).toEqual(["mem-1", "mem-2"]);
    expect(calls).toHaveLength(1);
  });

  it("memory invariant 26: with records off, a provider that never asks the host still leaves the host's own recall in the answer", async () => {
    const own = hit(1, { scope: { kind: "personal_workspace", principalId: "alice", workspaceId: "default" } });
    // The host's search honours a scope it is narrowed to.
    const host: MemoryRecallHost = {
      search: async (input) => ({
        hits: input.scope === undefined || input.scope.kind === own.scope.kind ? [own] : [],
        coverage: "complete",
      }),
      eligible: async () => [],
    };
    const silent: MemoryProvider = { recall: async () => ({ hits: [] }) };
    const registry = pluginRegistry(silent, { records: false, conversation: true, includePersonal: false });
    expect(
      (await recallThroughProviders(host, registry)({ actor, query: "garden", purpose: "turn" })).hits.map((row) => row.recordId),
    ).toEqual([own.recordId]);
  });

  it("scope keys name the chat notes the service grants a delegated task and a side chat, and the shared scope only with the reader grant", async () => {
    const run = (runId: string): string => memoryScopeKey({ kind: "run_local", principalId: "alice", workspaceId: "default", runId });
    const shared = memoryScopeKey({ kind: "shared_workspace", workspaceId: "default" });
    const delegated: MemoryActor = { ...actor, runId: "worker-1", chatTaskId: "chat-1", parentChatId: "chat-0" };
    const keys = readableScopeKeys(delegated, { personal: false });
    expect(keys).toEqual(expect.arrayContaining([run("worker-1"), run("chat-1"), run("chat-0")]));
    expect(keys).not.toContain(shared);
    expect(readableScopeKeys(delegated, { personal: false, shared: true })).toContain(shared);
    // A group conversation reads its chats' notes only.
    expect(readableScopeKeys({ ...delegated, reach: "chat-only" }, { personal: true, shared: true })).toEqual([
      run("worker-1"),
      run("chat-1"),
      run("chat-0"),
    ]);
    // Through recall: the grant is the host's to say.
    const asked: MemoryRecallRequest[] = [];
    const registry = pluginRegistry(
      {
        recall: async (request) => {
          asked.push(request);
          return { hits: [] };
        },
      },
      { records: true, conversation: true, includePersonal: false },
    );
    await recallThroughProviders(hostSearch([]), registry, { sharedRead: () => false })({
      actor: delegated,
      query: "garden",
      purpose: "tool",
    });
    await recallThroughProviders(hostSearch([]), registry, { sharedRead: () => true })({
      actor: delegated,
      query: "garden",
      purpose: "tool",
    });
    expect(asked.map((request) => request.scopeKeys.includes(shared))).toEqual([false, true]);
  });

  it("memory invariant 26: an agent's scope with no workspace spans workspaces, as personal does: kept out of scopeKeys and host.lexical without includePersonal", async () => {
    const agentActor = { ...actor, agentId: "helper" };
    const spanning = memoryScopeKey({ kind: "personal_agent", principalId: "alice", agentId: "helper" });
    const here = memoryScopeKey({ kind: "personal_agent", principalId: "alice", agentId: "helper", workspaceId: "default" });
    expect(readableScopeKeys(agentActor, { personal: false })).not.toContain(spanning);
    expect(readableScopeKeys(agentActor, { personal: false })).toContain(here);
    expect(readableScopeKeys(agentActor, { personal: true })).toContain(spanning);
    // Through recall: the provider is not told the spanning record's id, and the host still recalls it.
    const agentWide = hit(1, { scope: { kind: "personal_agent", principalId: "alice", agentId: "helper" } });
    const local = hit(2, { scope: { kind: "personal_agent", principalId: "alice", agentId: "helper", workspaceId: "default" } });
    const host: MemoryRecallHost = {
      search: async (input) => ({
        hits: [agentWide, local].filter((row) => input.scope === undefined || memoryScopeKey(input.scope) === memoryScopeKey(row.scope)),
        coverage: "complete",
      }),
      eligible: async () => [],
    };
    const told: string[][] = [];
    const registry = pluginRegistry(
      {
        async recall(request) {
          const ranked = await request.host.lexical(request.query, 10);
          told.push(ranked.map((entry) => entry.recordId));
          return { hits: [...ranked] };
        },
      },
      { records: true, conversation: true, includePersonal: false },
    );
    const result = await recallThroughProviders(host, registry)({ actor: agentActor, query: "garden", purpose: "tool" });
    expect(told).toEqual([[local.recordId]]);
    expect(result.hits.map((row) => row.recordId).sort()).toEqual([agentWide.recordId, local.recordId]);
  });
});
