import {
  MEMORY_SEARCH_MAX,
  TOOL_LABEL_KEY,
  TRUSTED_PUBLIC,
  TaviError,
  evaluateGate,
  isUntrusted,
  joinLabels,
  labelledResult,
  memoryScopeKey,
  seededWebSearchRule,
  toolResultLabel,
  trustedLabel,
  untrustedLabel,
  type AccessPolicyPort,
  type InvocationContext,
  type MemoryRecord,
  type MemoryScope,
} from "@tavi/contracts";
import { MemoryService, ToolRegistry } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import { describe, expect, it } from "vitest";

import { assessWebSearch } from "../../src/features/approvals/call-assessors.js";
import { registerMemoryTools } from "../../src/features/memory/tools.js";

/**
 * The governed model tool surface for personal memory:
 * `memory.list`, `memory.search`, `memory.get`, `memory.propose`, and `memory.forget`.
 * A model can suggest memory but cannot approve, correct or revoke it —
 * `MemoryService` refuses those for a `"model"` actor, and no tool exists
 * for them. `memory.forget` forgets only on the operator's own approval of
 * that very call.
 */

const OPERATOR = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" } as const;
const PERSONAL = { kind: "personal", principalId: "alice" } as const;

const context: InvocationContext = {
  workspaceId: "w1",
  principalId: "alice",
  runId: "run-1",
  caller: "model",
};

async function fixture(): Promise<{ readonly registry: ToolRegistry; readonly store: SqliteStore; readonly memory: MemoryService }> {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const memory = new MemoryService(store.asPort());
  const registry = new ToolRegistry();
  registerMemoryTools(registry, memory);
  return { registry, store, memory };
}

async function invoke(registry: ToolRegistry, id: string, input: unknown, as: InvocationContext = context): Promise<unknown> {
  const tool = registry.get(id);
  if (tool === undefined) throw new Error(`tool ${id} not registered`);
  return tool.handler({ input, context: as, signal: new AbortController().signal });
}

describe("memory tools", () => {
  it("registers exactly list, search, get, propose and forget — never approve or correct", async () => {
    const { registry } = await fixture();
    const ids = registry.list().map((tool) => tool.id);
    expect(ids).toEqual(["memory.forget", "memory.get", "memory.list", "memory.propose", "memory.search"]);
  });

  it("memory.list shows what is kept when no word of the question is in it", async () => {
    const { registry, store, memory } = await fixture();
    const kept = await memory.remember({
      actor: OPERATOR,
      scope: PERSONAL,
      kind: "fact",
      title: "Sci-fi taste",
      body: "Loves thoughtful science fiction about people solving problems.",
    });
    expect(await invoke(registry, "memory.search", { query: "film movie cinema" })).toMatchObject({ hits: [] });
    const listed = (await invoke(registry, "memory.list", {})) as { hits: { recordId: string; title?: string; excerpt?: string }[] };
    expect(listed.hits.map((hit) => hit.recordId)).toEqual([kept.recordId]);
    expect(listed.hits[0]).toMatchObject({ title: "Sci-fi taste" });
    expect(listed).toHaveProperty(TOOL_LABEL_KEY, { confidentiality: "personal" });
    store.close();
  });

  it("memory.list holds to what a search may show", async () => {
    const { registry, store, memory } = await fixture();
    const remember = async (body: string, extra: object = {}) =>
      await memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body, ...extra });
    const inForce = await remember("Keeps bees");
    await remember("Took a blood test", { sensitivity: "sensitive" });
    await remember("Was in Lisbon", { validTo: "2020-01-01T00:00:00.000Z" });
    await invoke(registry, "memory.propose", { kind: "fact", body: "Might like opera" });
    const listed = (await invoke(registry, "memory.list", {})) as { hits: { recordId: string }[] };
    expect(listed.hits.map((hit) => hit.recordId)).toEqual([inForce.recordId]);
    // A group chat reads no personal memory, so a listing has none to show.
    const group = (await invoke(registry, "memory.list", {}, { ...context, memoryReach: "chat-only" })) as { hits: unknown[] };
    expect(group.hits).toEqual([]);
    store.close();
  });

  it("memory.list narrows by kind and pages through everything kept", async () => {
    const { registry, store, memory } = await fixture();
    const lesson = await memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "lesson", body: "When booking, ask for an aisle seat" });
    for (let index = 0; index < MEMORY_SEARCH_MAX + 1; index += 1) {
      await memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: `Kept fact number ${index}` });
    }
    const lessons = (await invoke(registry, "memory.list", { kinds: ["lesson"] })) as { hits: { recordId: string }[] };
    expect(lessons.hits.map((hit) => hit.recordId)).toEqual([lesson.recordId]);
    const first = (await invoke(registry, "memory.list", {})) as { hits: { recordId: string }[]; nextOffset?: number };
    expect(first.hits).toHaveLength(MEMORY_SEARCH_MAX);
    expect(first.nextOffset).toBe(MEMORY_SEARCH_MAX);
    const second = (await invoke(registry, "memory.list", { offset: first.nextOffset })) as {
      hits: { recordId: string }[];
      nextOffset?: number;
    };
    expect(second.hits).toHaveLength(2);
    expect(second.nextOffset).toBeUndefined();
    expect(new Set([...first.hits, ...second.hits].map((hit) => hit.recordId)).size).toBe(MEMORY_SEARCH_MAX + 2);
    store.close();
  });

  it("memory.propose creates a proposal, never an approved record", async () => {
    const { registry, store } = await fixture();
    const result = (await invoke(registry, "memory.propose", {
      kind: "fact",
      body: "Alice keeps a garden",
    })) as { recordId: string; status: string };
    expect(result.status).toBe("proposed");
    store.close();
  });

  it("memory.propose records the chat it came from, and keeps a chat note in the chat's own scope", async () => {
    const { registry, store } = await fixture();
    const everywhere = (await invoke(registry, "memory.propose", { kind: "fact", body: "Alice keeps a garden" })) as {
      scope: { kind: string };
      originTaskId?: string;
      durable?: boolean;
    };
    expect(everywhere).toMatchObject({ scope: { kind: "personal" }, originTaskId: "run-1" });
    expect(everywhere.durable).toBeUndefined();
    const note = (await invoke(registry, "memory.propose", { kind: "fact", body: "The site is shop.example.com", scope: "chat" })) as {
      scope: { kind: string; runId?: string };
      durable?: boolean;
    };
    expect(note).toMatchObject({ scope: { kind: "run_local", runId: "run-1" }, durable: true });
    // A delegated task records its chat as the origin, and cannot write the chat's notes.
    const worker: InvocationContext = { ...context, runId: "worker-1", memoryScopeRestricted: true, chatTaskId: "run-1" };
    expect(
      (await invoke(registry, "memory.propose", { kind: "fact", body: "Found the sitemap" }, worker)) as { originTaskId?: string },
    ).toMatchObject({ originTaskId: "run-1" });
    await expect(invoke(registry, "memory.propose", { kind: "fact", body: "x", scope: "chat" }, worker)).rejects.toThrow(
      /cannot keep notes for its chat/,
    );
    // A group's worker can keep neither, and is told so for either scope.
    const groupWorker: InvocationContext = { ...worker, memoryReach: "chat-only" };
    await expect(invoke(registry, "memory.propose", { kind: "fact", body: "x", scope: "chat" }, groupWorker)).rejects.toThrow(
      /A worker in a group chat cannot propose memory/,
    );
    await expect(invoke(registry, "memory.propose", { kind: "fact", body: "x" }, groupWorker)).rejects.toThrow(
      /A worker in a group chat cannot propose memory/,
    );
    store.close();
  });

  it("memory.propose requires both preferenceKey and preferenceValue for a preference", async () => {
    const { registry } = await fixture();
    await expect(invoke(registry, "memory.propose", { kind: "preference", body: "x", preferenceKey: "ui.theme" })).rejects.toThrow(
      /needs both/,
    );
  });

  it("memory.propose refuses preferenceKey/preferenceValue on a non-preference kind", async () => {
    const { registry } = await fixture();
    await expect(invoke(registry, "memory.propose", { kind: "fact", body: "x", preferenceKey: "ui.theme" })).rejects.toThrow(
      /only valid when kind is 'preference'/,
    );
    await expect(invoke(registry, "memory.propose", { kind: "fact", body: "x", preferenceValue: "dark" })).rejects.toThrow(
      /only valid when kind is 'preference'/,
    );
  });

  it("memory.propose accepts topicKey for any kind, including fact", async () => {
    const { registry, store } = await fixture();
    const result = (await invoke(registry, "memory.propose", {
      kind: "fact",
      body: "Alice lives in Lisbon",
      topicKey: "alice.city",
    })) as { topicKey?: string };
    expect(result.topicKey).toBe("alice.city");
    store.close();
  });

  it("memory.get and memory.search see a proposal's author's own scope, but the proposal is not searchable until approved", async () => {
    const { registry, memory } = await fixture();
    const proposed = (await invoke(registry, "memory.propose", {
      kind: "fact",
      body: "unapproved coffee preference",
    })) as { recordId: string };

    const fetched = (await invoke(registry, "memory.get", { recordId: proposed.recordId })) as { status: string };
    expect(fetched.status).toBe("proposed");

    const found = (await invoke(registry, "memory.search", { query: "coffee" })) as { hits: unknown[] };
    expect(found.hits).toEqual([]);

    // Once an operator approves it, it becomes searchable.
    await memory.approve({
      actor: { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" },
      recordId: proposed.recordId,
    });
    const foundAfter = (await invoke(registry, "memory.search", { query: "coffee" })) as { hits: unknown[] };
    expect(foundAfter.hits).toHaveLength(1);
  });

  it("cannot escalate: the tool surface has no way to approve, correct or revoke", async () => {
    const { registry, memory } = await fixture();
    const proposed = (await invoke(registry, "memory.propose", { kind: "fact", body: "x" })) as { recordId: string };
    // There is no memory.approve/correct/revoke tool at all — the only way a
    // caller with this surface could even attempt it is by calling
    // MemoryService directly with the model's own authority, which the
    // service itself refuses (#requireOperator).
    expect(registry.get("memory.approve")).toBeUndefined();
    expect(registry.get("memory.correct")).toBeUndefined();
    expect(registry.get("memory.revoke")).toBeUndefined();
    await expect(
      (async () =>
        await memory.approve({
          actor: { principalId: "alice", workspaceId: "w1", caller: "model", authority: "model" },
          recordId: proposed.recordId,
        }))(),
    ).rejects.toThrow(TaviError);
  });

  it("memory.propose maps validUntil by kind: a fact's ends it, a preference's or lesson's expires it, through that day in the workspace's zone", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const memory = new MemoryService(store.asPort());
    const registry = new ToolRegistry();
    registerMemoryTools(registry, memory, { now: () => "2026-10-11T10:00:00.000Z", timeZoneOf: async () => "Europe/Berlin" });
    const fact = (await invoke(registry, "memory.propose", {
      kind: "fact",
      body: "Travelling to Lisbon until Friday",
      validUntil: "2026-10-16",
    })) as { validTo?: string; expiryAt?: string };
    // Friday in Berlin ends at 22:00 UTC.
    expect(fact).toMatchObject({ validTo: "2026-10-16T22:00:00.000Z" });
    expect(fact.expiryAt).toBeUndefined();
    const preference = (await invoke(registry, "memory.propose", {
      kind: "preference",
      body: "Reply in Spanish until Friday",
      preferenceKey: "reply.language",
      preferenceValue: "es",
      validUntil: "2026-10-16",
    })) as { validTo?: string; expiryAt?: string };
    expect(preference).toMatchObject({ expiryAt: "2026-10-16T22:00:00.000Z" });
    expect(preference.validTo).toBeUndefined();
    const lesson = (await invoke(registry, "memory.propose", {
      kind: "lesson",
      body: "Draft in Spanish this week",
      validUntil: "2026-10-16T18:00:00Z",
    })) as { expiryAt?: string };
    expect(lesson.expiryAt).toBe("2026-10-16T18:00:00.000Z");
    // Sensitive when the model says so: masked for review, out of automatic recall.
    expect(
      (await invoke(registry, "memory.propose", { kind: "fact", body: "Has asthma", sensitive: true })) as { sensitivity: string },
    ).toMatchObject({ sensitivity: "sensitive" });
  });

  it("memory.propose refuses a validUntil in the past and a summary, which is the host's own kind", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const memory = new MemoryService(store.asPort());
    const registry = new ToolRegistry();
    registerMemoryTools(registry, memory, { now: () => "2026-10-11T10:00:00.000Z" });
    await expect(invoke(registry, "memory.propose", { kind: "fact", body: "Was in Lisbon", validUntil: "2026-10-01" })).rejects.toThrow(
      /must be in the future/,
    );
    await expect(invoke(registry, "memory.propose", { kind: "fact", body: "Far off", validUntil: "2040-01-01" })).rejects.toThrow(
      /at most 5 years/,
    );
    await expect(invoke(registry, "memory.propose", { kind: "summary", body: "A summary" })).rejects.toThrow(/invalid arguments/);
    expect(await memory.list({ actor: { principalId: "alice", workspaceId: "w1", caller: "test", authority: "operator" } })).toEqual([]);
  });

  it("memory.propose files a health fact the person asked for, marked sensitive even unmarked, whatever the workspace's setting", async () => {
    const { registry, store } = await fixture();
    // "Remember my blood type": the setting governs automatic capture only, so the person's own request is filed.
    const unmarked = (await invoke(registry, "memory.propose", { kind: "fact", body: "Blood type is O negative" })) as {
      status: string;
      sensitivity: string;
    };
    expect(unmarked).toMatchObject({ status: "proposed", sensitivity: "sensitive" });
    const diagnosis = (await invoke(registry, "memory.propose", {
      kind: "fact",
      title: "Diagnosis",
      body: "Was diagnosed with diabetes last year",
    })) as { sensitivity: string };
    expect(diagnosis.sensitivity).toBe("sensitive");
    // The topic key is read too.
    const byTopic = (await invoke(registry, "memory.propose", {
      kind: "fact",
      body: "Has a long-term condition",
      topicKey: "health.diabetes",
    })) as { sensitivity: string };
    expect(byTopic.sensitivity).toBe("sensitive");
    // An ordinary fact stays ordinary.
    expect(
      ((await invoke(registry, "memory.propose", { kind: "fact", body: "Keeps a vegetable garden" })) as { sensitivity: string })
        .sensitivity,
    ).toBe("normal");
    store.close();
  });

  it("memory.propose never files a key-shaped secret", async () => {
    const { registry, store, memory } = await fixture();
    for (const input of [
      { kind: "fact", body: "Their OpenAI key is sk-proj-abcdefghijklmnopqrstuvwxyz0123" },
      { kind: "fact", title: "AWS", body: "The deploy uses AKIAABCDEFGHIJKLMNOP" },
      { kind: "fact", body: "The wifi password is hunter2" },
      {
        kind: "preference",
        body: "Use this token",
        preferenceKey: "github.token",
        preferenceValue: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
    ]) {
      await expect(invoke(registry, "memory.propose", input)).rejects.toThrow(/password, key or token/);
    }
    expect(await memory.list({ actor: { principalId: "alice", workspaceId: "w1", caller: "test", authority: "operator" } })).toEqual([]);
    store.close();
  });

  it("rejects invalid arguments as INVALID_INPUT before touching the service", async () => {
    const { registry } = await fixture();
    await expect(invoke(registry, "memory.search", { query: "" })).rejects.toThrow(/invalid arguments/);
    await expect(invoke(registry, "memory.get", {})).rejects.toThrow(/invalid arguments/);
  });

  it("memory.propose in a tainted chat is filed with the chat's provenance, and a kept one is recalled as trusted", async () => {
    const { registry, store, memory } = await fixture();
    const tool = registry.get("memory.propose")!;
    const at = "2026-10-13T00:00:00.000Z";
    const contextLabel = untrustedLabel("web", {
      ref: { ref: "call-1", host: "example.com", title: "Deals", at },
      confidentiality: "personal",
      principal: "host:example.com",
    });
    const filed = (await tool.handler({
      input: { kind: "fact", body: "Alice flies to Porto in May" },
      context,
      signal: new AbortController().signal,
      operationEnvelope: { tainted: true },
      contextLabel,
    })) as { recordId: string; status: string };
    // Nothing is refused: someone asked for it.
    expect(filed.status).toBe("proposed");
    const operator = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" as const };
    const provenance = (await memory.history({ actor: operator, recordId: filed.recordId })).revisions[0]?.provenance;
    expect(provenance).toEqual({
      integrity: "untrusted",
      sources: ["web"],
      refs: [{ source: "web", ref: "call-1", host: "example.com", title: "Deals", at }],
    });
    // A tainted call with no label reads as `unknown-source`; a clean one stamps nothing.
    const unlabelled = (await tool.handler({
      input: { kind: "fact", body: "Alice owns a red bicycle" },
      context,
      signal: new AbortController().signal,
      operationEnvelope: { tainted: true },
    })) as { recordId: string };
    expect((await memory.history({ actor: operator, recordId: unlabelled.recordId })).revisions[0]?.provenance).toEqual({
      integrity: "untrusted",
      sources: ["unknown-source"],
      refs: [],
    });
    const clean = (await tool.handler({
      input: { kind: "fact", body: "Alice speaks Portuguese" },
      context,
      signal: new AbortController().signal,
      operationEnvelope: { tainted: false },
      contextLabel: trustedLabel("personal"),
    })) as { recordId: string };
    expect((await memory.history({ actor: operator, recordId: clean.recordId })).revisions[0]?.provenance).toBeUndefined();
    // The person's keep endorses it: recall is unchanged — no untrusted output — and the provenance stays for `tavi memory show`.
    await memory.approve({ actor: operator, recordId: filed.recordId });
    expect(registry.get("memory.search")?.untrustedOutput).not.toBe(true);
    const hits = (await invoke(registry, "memory.search", { query: "Porto" })) as { hits: { recordId: string }[] };
    expect(hits.hits.map((hit) => hit.recordId)).toEqual([filed.recordId]);
    expect((await memory.history({ actor: operator, recordId: filed.recordId })).revisions[0]?.provenance?.integrity).toBe("untrusted");
    // As the workflow dispatches it: the kept record's recall enters the conversation trusted.
    const { dispatchTool } = await import("@tavi/agent-host/workflow");
    const { createInMemoryEffectRepository } = await import("@tavi/test-support/fakes");
    const access = { resolveWorkspace: () => ({ principalId: "alice" }), missingPermissions: () => [] };
    const dispatched = await dispatchTool(
      registry,
      access,
      createInMemoryEffectRepository(),
      { id: "call-search", name: "memory.search", input: { query: "Porto" } },
      context,
      { taskId: "task-1", admissionId: "admission-1", steps: 1, now: () => at },
      undefined,
      undefined,
    );
    expect(dispatched.isError).toBe(false);
    expect(JSON.stringify(dispatched.output)).toContain(filed.recordId);
    expect(dispatched.label === undefined || !isUntrusted(dispatched.label)).toBe(true);
    store.close();
  });

  it("memory.search in a tainted chat stays in the host: no provider purpose, no query to embed, and partial coverage", async () => {
    const asked: Record<string, unknown>[] = [];
    const memory = {
      search: async (input: Record<string, unknown>) => {
        asked.push(input);
        return { hits: [], coverage: "complete" as const };
      },
    };
    const registry = new ToolRegistry();
    registerMemoryTools(registry, memory as never);
    const tool = registry.get("memory.search")!;
    const tainted = (await tool.handler({
      input: { query: "invoice account" },
      context,
      signal: new AbortController().signal,
      operationEnvelope: { tainted: true },
    })) as { coverage: string; reducedReason?: string };
    expect(tainted).toMatchObject({ coverage: "partial" });
    expect(tainted.reducedReason).toMatch(/stayed on this device/);
    expect(asked[0]).not.toHaveProperty("purpose");
    expect(asked[0]).not.toHaveProperty("semantic");
    // A clean chat's search recalls as before: through the provider, hybrid.
    await tool.handler({
      input: { query: "invoice account" },
      context,
      signal: new AbortController().signal,
      operationEnvelope: { tainted: false },
    });
    expect(asked[1]).toMatchObject({ purpose: "tool", semantic: "invoice account" });
  });

  describe("what a search leaves the chat holding", () => {
    /** The label a search's result enters the chat with, as the dispatcher reads it, and what a later web search does under taint. */
    const searched = async (registry: ToolRegistry, query: string) => {
      const tool = registry.get("memory.search")!;
      const output = await tool.handler({
        input: { query },
        context,
        signal: new AbortController().signal,
        operationEnvelope: { tainted: true },
      });
      const marked = labelledResult(output);
      const label = toolResultLabel(
        tool,
        { id: "c1", input: { query } },
        { untrusted: marked.untrusted, label: marked.label },
        "2026-11-04T00:00:00.000Z",
      );
      const gate = evaluateGate({
        toolId: "web_search",
        effect: "external",
        sink: "search",
        assessment: assessWebSearch({ query: "honda civic 2018 recalls" }),
        rules: [seededWebSearchRule("w1", "2026-11-04T00:00:00.000Z")],
        sessionGrants: [],
        gatedEffects: new Set(["external"]),
        tainted: true,
        label: joinLabels(untrustedLabel("search"), label),
      });
      return { label, gate };
    };

    it("holds nothing private after a search that read no record, so a tainted chat's web search runs", async () => {
      const { registry, store } = await fixture();
      const { label, gate } = await searched(registry, "honda recall");
      expect(label).toEqual(TRUSTED_PUBLIC);
      expect(gate.decision).toBe("allow");
      store.close();
    });

    it("holds a record it read as personal, so a tainted chat's web search still asks, once", async () => {
      const { registry, store, memory } = await fixture();
      const proposed = (await invoke(registry, "memory.propose", { kind: "fact", body: "Alice drives a Honda Civic" })) as {
        recordId: string;
      };
      await memory.approve({ actor: OPERATOR, recordId: proposed.recordId });
      const { label, gate } = await searched(registry, "honda");
      expect(label).toMatchObject({ integrity: "trusted", confidentiality: "personal" });
      expect(gate).toMatchObject({ decision: "ask", gateReason: "private-search", allowedScopes: ["once"] });
      store.close();
    });
  });

  it("memory.search never calls a miss complete: words that found nothing prove nothing, and it says so", async () => {
    const { registry, store, memory } = await fixture();
    const proposed = (await invoke(registry, "memory.propose", {
      kind: "fact",
      body: "Loves thoughtful science fiction about people solving problems.",
    })) as { recordId: string };
    await memory.approve({ actor: OPERATOR, recordId: proposed.recordId });
    const missed = (await invoke(registry, "memory.search", { query: "film movie cinema" })) as {
      hits: unknown[];
      coverage: string;
      reducedReason?: string;
    };
    expect(missed.hits).toEqual([]);
    expect(missed.coverage).toBe("partial");
    expect(missed.reducedReason).toMatch(/other words/);
    // A hit was looked for and found: it stays as the index answered.
    expect(await invoke(registry, "memory.search", { query: "science fiction" })).toMatchObject({ coverage: "complete" });
    store.close();
  });

  it("memory.search keeps saying when it could not look at all", async () => {
    const registry = new ToolRegistry();
    registerMemoryTools(registry, { search: async () => ({ hits: [], coverage: "unavailable" as const }) } as never);
    expect(await invoke(registry, "memory.search", { query: "anything" })).toMatchObject({ coverage: "unavailable" });
  });

  it("memory.search falls back to partial matches when no memory holds every word, and says so in reducedReason", async () => {
    const { registry, store, memory } = await fixture();
    const operator = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" as const };
    const dog = await memory.remember({
      actor: operator,
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      body: "Dog is named Mochi",
    });
    const clean = (await invoke(registry, "memory.search", { query: "dog breed" })) as {
      hits: { recordId: string }[];
      coverage: string;
      match?: string;
      reducedReason?: string;
    };
    expect(clean.hits.map((hit) => hit.recordId)).toEqual([dog.recordId]);
    expect(clean.coverage).toBe("complete");
    expect(clean.match).toBe("any");
    expect(clean.reducedReason).toBe("No memory held every word; these hold some of them");

    const tool = registry.get("memory.search")!;
    const tainted = (await tool.handler({
      input: { query: "dog breed" },
      context,
      signal: new AbortController().signal,
      operationEnvelope: { tainted: true },
    })) as { hits: { recordId: string }[]; coverage: string; match?: string; reducedReason?: string };
    expect(tainted.hits.map((hit) => hit.recordId)).toEqual([dog.recordId]);
    expect(tainted.coverage).toBe("partial");
    expect(tainted.match).toBe("any");
    expect(tainted.reducedReason).toContain("stayed on this device");
    expect(tainted.reducedReason).toContain("No memory held every word; these hold some of them");
    store.close();
  });

  it("memory.search forwards includePast to return ended and replaced facts with their date markers", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    let clock = "2026-01-10T10:00:00.000Z";
    const memory = new MemoryService(store.asPort(), { now: () => clock });
    const registry = new ToolRegistry();
    registerMemoryTools(registry, memory, { now: () => clock });
    const operator = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" as const };

    const ended = await memory.remember({
      actor: operator,
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      body: "Temporarily based in Coimbra.",
      validTo: "2026-02-01T00:00:00.000Z",
    });
    const replaced = await memory.remember({
      actor: operator,
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      title: "Former role",
      body: "Worked as a junior analyst in Coimbra.",
    });
    clock = "2026-03-01T10:00:00.000Z";
    await memory.correct({
      actor: operator,
      recordId: replaced.recordId,
      title: "Staff analyst",
      body: "Works as a staff analyst in Porto.",
    });

    clock = "2026-04-01T10:00:00.000Z";
    const withoutPast = (await invoke(registry, "memory.search", { query: "Coimbra" })) as {
      hits: { recordId: string; snippet: string }[];
    };
    expect(withoutPast.hits).toEqual([]);

    const withPast = (await invoke(registry, "memory.search", { query: "Coimbra", includePast: true })) as {
      hits: { recordId: string; snippet: string; superseded: boolean }[];
    };
    const byId = new Map(withPast.hits.map((hit) => [hit.recordId, hit]));
    expect(byId.get(ended.recordId)?.snippet).toContain("(ended 2026-02-01)");
    expect(byId.get(replaced.recordId)?.snippet).toContain("(replaced 2026-03-01 by Staff analyst)");
    expect(byId.get(replaced.recordId)?.superseded).toBe(true);
    store.close();
  });

  it("memory.propose indexes write-time keywords, rejects secret keywords, and marks sensitive keywords", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const memory = new MemoryService(store.asPort(), { now: () => "2026-03-01T10:00:00.000Z" });
    const registry = new ToolRegistry();
    registerMemoryTools(registry, memory, { now: () => "2026-03-01T10:00:00.000Z" });
    const operator = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" as const };

    await expect(
      invoke(registry, "memory.propose", {
        kind: "fact",
        body: "Uses a cloud API key for deployments.",
        keywords: ["password: super-secret-value"],
      }),
    ).rejects.toThrow(/password, key or token/);

    const sensitiveByKeyword = (await invoke(registry, "memory.propose", {
      kind: "fact",
      body: "Visits Dr. Meyer every Tuesday.",
      keywords: ["medical diagnosis", "physiotherapy"],
    })) as MemoryRecord;
    expect(sensitiveByKeyword.sensitivity).toBe("sensitive");

    const normalWithKeywords = (await invoke(registry, "memory.propose", {
      kind: "fact",
      title: "Emma",
      body: "Emma attends Lincoln Elementary.",
      keywords: ["daughter", "school", "kid"],
    })) as MemoryRecord;
    expect(normalWithKeywords.sensitivity).toBe("normal");
    await memory.approve({ actor: operator, recordId: normalWithKeywords.recordId });

    const found = (await invoke(registry, "memory.search", { query: "daughter school" })) as {
      hits: { recordId: string; snippet: string }[];
    };
    expect(found.hits.map((hit) => hit.recordId)).toEqual([normalWithKeywords.recordId]);
    expect(found.hits[0]?.snippet).toBe("Emma attends Lincoln Elementary.");
    store.close();
  });

  it("memory.propose names the kept fact or lesson it updates, so its card offers Replace", async () => {
    const { registry, store, memory } = await fixture();
    const fact = await memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Alice lives in Berlin" });
    const lesson = await memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "lesson", body: "When deploying, run the tests first" });
    const factUpdate = (await invoke(registry, "memory.propose", {
      kind: "fact",
      body: "Alice lives in Lisbon",
      updates: fact.recordId,
    })) as MemoryRecord;
    expect(factUpdate.supersedesRecordId).toBe(fact.recordId);
    expect((await memory.related({ actor: OPERATOR, recordId: factUpdate.recordId })).updates?.recordId).toBe(fact.recordId);
    const lessonUpdate = (await invoke(registry, "memory.propose", {
      kind: "lesson",
      body: "When deploying, run the tests and the linter first",
      updates: lesson.recordId,
    })) as MemoryRecord;
    expect(lessonUpdate.supersedesRecordId).toBe(lesson.recordId);
    expect((await memory.related({ actor: OPERATOR, recordId: lessonUpdate.recordId })).updates?.recordId).toBe(lesson.recordId);
    // A lesson cannot replace a fact, and a preference replaces by its key.
    await expect(
      invoke(registry, "memory.propose", { kind: "lesson", body: "When asked, say Lisbon", updates: fact.recordId }),
    ).rejects.toThrow(/not an approved lesson in force/);
    await expect(
      invoke(registry, "memory.propose", {
        kind: "preference",
        body: "Dark theme",
        preferenceKey: "ui.theme",
        preferenceValue: "dark",
        updates: fact.recordId,
      }),
    ).rejects.toThrow(/only valid for a fact or lesson/);
    store.close();
  });

  it("memory.forget asks once, attended, with the record's own words, after it was read", async () => {
    const { registry, store, memory } = await fixture();
    const kept = await memory.remember({
      actor: OPERATOR,
      scope: PERSONAL,
      kind: "fact",
      title: "Home city",
      body: "Alice lives in Berlin",
    });
    const tool = registry.get("memory.forget");
    expect(tool).toMatchObject({ effect: "mutating", sink: "persist" });
    const input = { recordId: kept.recordId, reason: "she moved" };
    // Unread: nothing is shown that the person could not see, so no card.
    expect(tool?.assess?.(input, context).hardDeny).toMatch(/memory\.get first/);
    await invoke(registry, "memory.get", { recordId: kept.recordId });
    const assessed = tool?.assess?.(input, context);
    expect(assessed).toMatchObject({
      display: { title: "Forget “Home city”", destructive: true },
      onceOnly: true,
      attendedOnly: true,
      risk: "high",
      subjects: [kept.recordId],
    });
    expect(assessed?.hardDeny).toBeUndefined();
    expect(assessed?.display.detail).toContain("Alice lives in Berlin");
    expect(assessed?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    store.close();
  });

  it("memory.forget forgets only on the operator's own approval of the call as it was shown", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const memory = new MemoryService(store.asPort());
    const registry = new ToolRegistry();
    const before: string[] = [];
    registerMemoryTools(registry, memory, {
      operatorOf: () => "alice",
      beforeForget: async (recordId) => {
        before.push(recordId);
        return { unreached: ["Telegram"] };
      },
    });
    const kept = await memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Alice lives in Berlin" });
    await invoke(registry, "memory.get", { recordId: kept.recordId });
    const tool = registry.get("memory.forget");
    const input = { recordId: kept.recordId, reason: "she moved" };
    const shown = tool?.assess?.(input, context).contentHash;
    const forget = (approvedBy: string | undefined, approvedContentHash: string | undefined = shown) =>
      tool?.handler({
        input,
        context,
        signal: new AbortController().signal,
        ...(approvedBy === undefined ? {} : { approvedBy }),
        ...(approvedContentHash === undefined ? {} : { approvedContentHash }),
      });
    // No person saw it (a rule, a grant, a policy), or someone other than the operator decided it.
    await expect(forget(undefined)).rejects.toThrow(/Only the person's own approval/);
    await expect(forget("bob")).rejects.toThrow(/Only the person's own approval/);
    // The record changed since the card: refused.
    await expect(forget("alice", "0".repeat(64))).rejects.toThrow(/changed since/);
    expect(before).toEqual([]);
    const receipt = (await forget("alice")) as { recordId: string; unreached: string[] };
    expect(receipt.recordId).toBe(kept.recordId);
    expect(receipt.unreached).toContain("Earlier messages in Telegram may still show it.");
    expect(before).toEqual([kept.recordId]);
    await expect((async () => await memory.get({ actor: OPERATOR, recordId: kept.recordId }))()).rejects.toThrow();
    // Five requests this chat, refused or not: the next is refused before any card, and by the handler too.
    await expect(forget("alice")).rejects.toThrow();
    await expect(forget("alice")).rejects.toThrow(/already asked to forget 5/);
    expect(tool?.assess?.(input, context).hardDeny).toMatch(/already asked to forget 5/);
    store.close();
  });

  it("memory.forget hides a sensitive record's text, takes the CLI's own decision, and forgets nothing with no operator known", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const memory = new MemoryService(store.asPort());
    const setup = (operatorOf?: () => string | undefined) => {
      const registry = new ToolRegistry();
      registerMemoryTools(registry, memory, {
        ...(operatorOf === undefined ? {} : { operatorOf }),
        beforeForget: async () => ({ unreached: [] }),
      });
      return registry;
    };
    const forgetWith = async (registry: ToolRegistry, recordId: string, approvedBy: string) => {
      await invoke(registry, "memory.get", { recordId });
      const tool = registry.get("memory.forget");
      const input = { recordId, reason: "not true" };
      const assessed = tool?.assess?.(input, context);
      return {
        assessed,
        run: () =>
          tool?.handler({
            input,
            context,
            signal: new AbortController().signal,
            approvedBy,
            ...(assessed?.contentHash === undefined ? {} : { approvedContentHash: assessed.contentHash }),
          }),
      };
    };
    const secret = await memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Has asthma", sensitivity: "sensitive" });
    const hidden = await forgetWith(
      setup(() => "alice"),
      secret.recordId,
      "operator",
    );
    expect(hidden.assessed?.display.title).toContain("a sensitive memory");
    expect(hidden.assessed?.display.detail ?? "").not.toContain("asthma");
    // The CLI's own decision is the operator's.
    expect(await hidden.run()).toMatchObject({ recordId: secret.recordId });
    // No operator known for the workspace: nobody's click is the operator's.
    const plain = await memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Alice lives in Berlin" });
    for (const operatorOf of [undefined, () => undefined]) {
      const unknown = await forgetWith(setup(operatorOf), plain.recordId, "alice");
      await expect(unknown.run()).rejects.toThrow(/Only the person's own approval/);
    }
    store.close();
  });

  it("memory.forget refuses a shared workspace record before any card, and its handler refuses it too", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const persistence = store.asPort();
    // Alice may read the workspace's shared scope, so memory.get reads the record and the card would show it.
    const policy: AccessPolicyPort = {
      resolveWorkspace: () => undefined,
      missingPermissions: (actor, required) =>
        actor.principalId === "alice" && actor.workspaceId === "w1"
          ? required.filter((permission) => permission !== "memory:read-shared")
          : [...required],
    };
    const memory = new MemoryService(persistence, { policy });
    const registry = new ToolRegistry();
    registerMemoryTools(registry, memory, { operatorOf: () => "alice", beforeForget: async () => ({ unreached: [] }) });
    // Inserted as an explicit share would leave it (the way the runtime's own memory tests share one).
    const scope: MemoryScope = { kind: "shared_workspace", workspaceId: "w1" };
    const at = new Date().toISOString();
    persistence.repositories.memory.insertRecord({
      record: {
        recordId: "shared-1",
        kind: "fact",
        scope,
        scopeKey: memoryScopeKey(scope),
        status: "approved",
        sensitivity: "normal",
        currentRevisionId: "shared-1-rev",
        revocationGeneration: 0,
        recordedAt: at,
        updatedAt: at,
      },
      revision: {
        revisionId: "shared-1-rev",
        recordId: "shared-1",
        revisionNumber: 1,
        schemaVersion: 1,
        body: "The team deploys on Fridays",
        contentHash: "h",
        author: "operator",
        sourceIds: [],
        recordedAt: at,
        sensitivity: "normal",
        status: "active",
      },
    });
    expect(((await invoke(registry, "memory.get", { recordId: "shared-1" })) as { recordId: string }).recordId).toBe("shared-1");
    const tool = registry.get("memory.forget");
    const input = { recordId: "shared-1", reason: "not true" };
    const assessed = tool?.assess?.(input, context);
    expect(assessed?.hardDeny).toBe("Shared workspace memory is changed by an explicit share, not from a chat");
    expect(assessed?.contentHash).toBeUndefined();
    // Even approved by the operator, the handler forgets nothing shared.
    await expect(
      tool?.handler({ input, context, signal: new AbortController().signal, approvedBy: "alice", approvedContentHash: "0".repeat(64) }),
    ).rejects.toThrow(/Shared workspace memory is changed by an explicit share/);
    expect((await memory.get({ actor: OPERATOR, recordId: "shared-1" })).recordId).toBe("shared-1");
    store.close();
  });
});
