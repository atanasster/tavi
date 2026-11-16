import { join } from "node:path";
import {
  ATTENDED_TASK_POLICY,
  RouterSettingsSchema,
  type HeartbeatState,
  type MemoryActor,
  type MemoryServicePort,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { MemoryService, ModelAccounting, ModelConfigService } from "@tavi/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime, TaviRuntimeOptions } from "../../src/runtime/types.js";
import { withLocalChatMemory, withoutLocalChats, withoutLocalOrigin } from "../../src/features/models/local-chats.js";
import { ideasMemoryContext } from "../../src/features/ideas/sources.js";
import { heartbeatMemoryContext } from "../../src/features/heartbeat/sources.js";

/**
 * Keep local chats local: a chat on a connection on this machine never sends
 * its text, or what it produced, to a remote model — not through its
 * fallback, the router, nor memory recalled into a chat on a remote model.
 */

const scope = { workspaceId: "default", principalId: "operator" };
const LOCAL = {
  connectionId: "local",
  kind: "openai-compatible" as const,
  baseUrl: "http://127.0.0.1:11434/v1",
  credentialRef: "local.key",
};
const CLOUD = {
  connectionId: "cloud",
  kind: "openai-compatible" as const,
  baseUrl: "https://cloud.invalid/v1",
  credentialRef: "cloud.key",
};
const directories = temporaryDirectories({ prefix: "tavi-local-chats-" });
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  directories.cleanup();
});

const directory = (): string => directories.create();

async function compose(
  options: Partial<TaviRuntimeOptions> & { readonly dataDirectory: string },
  overrides: Parameters<typeof composeTaviRuntime>[1],
): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(
    {
      workspaces: [{ ...scope, permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      providers: [LOCAL, CLOUD],
      credentials: { "local.key": { value: "fixture" }, "cloud.key": { value: "fixture" } },
      defaultConnectionId: "local",
      defaultModel: "m",
      logger: { level: "error", sink: () => {} },
      approvalRequiredFor: [],
      ...options,
    },
    overrides,
  );
  cleanup.push(() => runtime.close());
  return runtime;
}

const admit = async (runtime: TaviRuntime, key: string, prompt = "hello") =>
  await runtime.workflow?.admit({
    context: { ...scope, runId: "pending", caller: "cli" },
    operationKey: key,
    kind: "start",
    prompt,
    origin: "cli",
    executionPolicy: ATTENDED_TASK_POLICY,
  });

describe("a chat on a local connection", () => {
  it("never fails over to a remote fallback: the call fails instead", async () => {
    const requests: ModelRequest[] = [];
    const model: ModelPort = {
      async stream(request) {
        requests.push(request);
        return request.connectionId === "local"
          ? {
              status: "failed",
              attemptId: request.attemptId,
              text: "",
              toolCalls: [],
              usage: {},
              error: { code: "provider", message: "the local model is down", retryable: true },
            }
          : { status: "completed", attemptId: request.attemptId, text: "from the cloud", toolCalls: [], usage: {} };
      },
    };
    const runtime = await compose(
      { dataDirectory: directory(), modelFallback: [{ connectionId: "cloud", model: "m" }] },
      { modelOverride: model },
    );
    const result = await admit(runtime, "fallback");
    expect(result?.outcome.status).toBe("failed");
    expect(
      requests.filter((request) => (request.purpose ?? "generation") === "generation").map((request) => request.connectionId),
    ).not.toContain("cloud");
    expect(requests.length).toBeGreaterThan(0);
  });

  it("never asks the router, for its model nor its context, when its default is local", async () => {
    const dataDirectory = directory();
    const store = await SqliteStore.open({
      databasePath: join(dataDirectory, "tavi.sqlite"),
      artifactsDirectory: join(dataDirectory, "artifacts"),
    });
    const models = new ModelConfigService(store.asPort());
    for (const provider of [LOCAL, CLOUD]) {
      await models.putConnection({ ...provider, label: provider.connectionId });
      await models.putCatalogEntry({
        connectionId: provider.connectionId,
        modelId: "m",
        provenance: "live",
        state: "capable",
        capabilities: ["tools", "streaming"],
        contextWindow: 256_000,
        maxTokens: 4096,
      });
    }
    await models.setRoleBinding({ workspaceId: "default", role: "fast", target: { connectionId: "cloud", model: "m" }, fallback: [] });
    const accounting = new ModelAccounting(store.asPort());
    for (const [connectionId, model, price] of [
      ["local", "m", 2],
      ["cloud", "m", 1],
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
    const remembered = await new MemoryService(store.asPort()).remember({
      actor: { ...scope, caller: "cli", authority: "operator" },
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "wombat project uses TypeScript",
    });
    expect(remembered.status).toBe("approved");
    const requests: ModelRequest[] = [];
    const routerFetch = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 1, output_tokens: 0 } })),
    );
    const runtime = await compose(
      {
        dataDirectory,
        credentials: { "local.key": { value: "fixture" }, "cloud.key": { value: "fixture" }, "jev.key": { value: "fixture" } },
      },
      {
        store,
        routerFetch,
        modelOverride: {
          async stream(request) {
            requests.push(request);
            return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
          },
        },
      },
    );
    await runtime.routerRepository.configure(
      scope,
      RouterSettingsSchema.parse({
        enabled: true,
        modes: { tools: "active", memory: "active", skills: "active", model: "active" },
        egress: { taskText: true, toolDescriptions: true, memoryExcerpts: true, skillMetadata: true },
        providerSettings: { "tavi.router": { credentialRef: "jev.key" } },
        priceRevision: "jev-price",
      }),
      0,
    );
    const result = await admit(runtime, "routed", "wombat");
    expect(result?.outcome.status).toBe("completed");
    expect(routerFetch).not.toHaveBeenCalled();
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.filter((request) => (request.purpose ?? "generation") === "generation").every((request) => request.connectionId === "local"),
    ).toBe(true);
  });

  it("stamps what it writes to memory, and a chat on a remote model neither recalls nor fetches it", async () => {
    const runtime = await compose(
      { dataDirectory: directory() },
      {
        modelOverride: {
          async stream(request) {
            return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
          },
        },
      },
    );
    const local = await admit(runtime, "local-chat");
    const localChat = local?.taskId ?? "missing";
    const operator: MemoryActor = { ...scope, caller: "cli", authority: "operator" };
    const asChat = (runId: string): MemoryActor => ({ ...scope, runId, caller: "memory.propose", authority: "model" });
    const proposed = await runtime.memory.propose({
      actor: asChat(localChat),
      scope: { kind: "personal", principalId: "operator" },
      originTaskId: localChat,
      kind: "fact",
      body: "The garden has tomatoes",
    });
    await runtime.memory.approve({ actor: operator, recordId: proposed.recordId });
    expect((await runtime.memory.get({ actor: operator, recordId: proposed.recordId })).localOrigin).toBe(true);
    // Another chat, moved to a remote model.
    const remote = await admit(runtime, "remote-chat");
    const remoteChat = remote?.taskId ?? "missing";
    await runtime.taskRouting.choose?.(scope, remoteChat, { connectionId: "cloud", model: "m" });
    const recalled = async (runId: string) =>
      (await runtime.memory.search({ actor: asChat(runId), query: "garden tomatoes", match: "any", purpose: "tool" })).hits.map(
        (hit) => hit.recordId,
      );
    expect(await recalled(localChat)).toContain(proposed.recordId);
    expect(await recalled(remoteChat)).not.toContain(proposed.recordId);
    await expect(runtime.memory.get({ actor: asChat(remoteChat), recordId: proposed.recordId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Nor does it list it, read its history, or see what it relates to (what capture is told is already kept).
    expect(
      (await runtime.memory.list({ actor: asChat(remoteChat), scope: { kind: "personal", principalId: "operator" } })).map(
        (record) => record.recordId,
      ),
    ).not.toContain(proposed.recordId);
    expect(
      (await runtime.memory.list({ actor: asChat(localChat), scope: { kind: "personal", principalId: "operator" } })).map(
        (record) => record.recordId,
      ),
    ).toContain(proposed.recordId);
    await expect(runtime.memory.history({ actor: asChat(remoteChat), recordId: proposed.recordId })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: `Memory record ${proposed.recordId} does not exist`,
    });
    await expect(runtime.memory.related({ actor: asChat(remoteChat), recordId: proposed.recordId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // What a chat on a remote model writes is not stamped.
    const fresh = await admit(runtime, "remote-only");
    await runtime.taskRouting.choose?.(scope, fresh?.taskId ?? "missing", { connectionId: "cloud", model: "m" });
    expect(await recalled(fresh?.taskId ?? "missing")).not.toContain(proposed.recordId);
  });
});

describe("work a local chat started", () => {
  it("a reminder set in a local chat fires on that chat's local model, not the remote default", async () => {
    const requests: ModelRequest[] = [];
    const runtime = await compose(
      { dataDirectory: directory(), defaultConnectionId: "cloud", reminderSweepEnabled: true, reminderSweepIntervalMs: 25 },
      {
        modelOverride: {
          async stream(request) {
            requests.push(request);
            return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
          },
        },
      },
    );
    const chat = (await admit(runtime, "local-chat"))?.taskId ?? "missing";
    await runtime.taskRouting.choose?.(scope, chat, { connectionId: "local", model: "m" });
    const repositories = runtime.store.asPort().repositories;
    await repositories.reminders.create({
      reminderId: "rem-local",
      workspaceId: "default",
      principalId: "operator",
      text: "Check",
      prompt: "Check the garden plan",
      originTaskId: chat,
      when: { kind: "once", at: new Date(Date.now() + 500).toISOString() },
      timezone: "UTC",
      deliverTo: { kind: "app" },
      createdBy: "user",
      operationKey: "rem-local",
      now: new Date().toISOString(),
    });
    const deadline = Date.now() + 20_000;
    let fired: string | undefined;
    while (fired === undefined && Date.now() < deadline) {
      fired = (await repositories.reminders.fires({ workspaceId: "default", reminderId: "rem-local", limit: 5 })).find(
        (entry) => entry.taskId !== undefined && entry.outcome !== "pending",
      )?.taskId;
      await delay(25);
    }
    expect(fired).toBeDefined();
    while (!requests.some((request) => request.runId === fired) && Date.now() < deadline) await delay(25);
    const calls = requests
      .filter((request) => request.runId === fired && (request.purpose ?? "generation") === "generation")
      .map((request) => request.connectionId);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(["local"]));
  });

  it("sessions.search from a chat on a remote model finds no local chat's words", async () => {
    const runtime = await compose(
      { dataDirectory: directory() },
      {
        modelOverride: {
          async stream(request) {
            return { status: "completed", attemptId: request.attemptId, text: "noted the zebra crossing", toolCalls: [], usage: {} };
          },
        },
      },
    );
    const local = (await admit(runtime, "local-zebra", "plan the zebra crossing"))?.taskId ?? "missing";
    const remote = (await admit(runtime, "remote-reader", "hello"))?.taskId ?? "missing";
    await runtime.taskRouting.choose?.(scope, remote, { connectionId: "cloud", model: "m" });
    const other = (await admit(runtime, "local-reader", "hello"))?.taskId ?? "missing";
    const search = async (runId: string) =>
      (await runtime.tools
        .get("sessions.search")
        ?.handler({ input: { query: "zebra" }, context: { ...scope, runId, caller: "cli" }, signal: new AbortController().signal })) as {
        readonly matches: readonly { readonly taskId: string }[];
      };
    expect((await search(other)).matches.map((match) => match.taskId)).toContain(local);
    expect((await search(remote)).matches.map((match) => match.taskId)).not.toContain(local);
  });
});

describe("jobs on a remote fast model", () => {
  it("Ideas and the heartbeat read nothing a local chat wrote", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    cleanup.push(() => store.close());
    const service = new MemoryService(store.asPort());
    const actor = { ...scope, caller: "cli", authority: "operator" as const };
    const personal = { kind: "personal" as const, principalId: "operator" };
    const local = await service.remember({ actor, scope: personal, kind: "fact", body: "The garden has tomatoes", localOrigin: true });
    const plain = await service.remember({ actor, scope: personal, kind: "fact", body: "The garden has peppers" });
    const memory = {
      list: async (input: Parameters<MemoryService["list"]>[0]) => service.list(input),
      eligible: async (input: Parameters<MemoryService["eligible"]>[0]) => service.eligible(input),
      search: async (input: Parameters<MemoryService["search"]>[0]) => service.search(input),
      resolvePreferences: async (input: Parameters<MemoryService["resolvePreferences"]>[0]) => service.resolvePreferences(input),
    };
    const now = new Date().toISOString();
    expect((await ideasMemoryContext(memory, scope, now)).map((excerpt) => excerpt.recordId)).toContain(local.recordId);
    expect((await ideasMemoryContext(withoutLocalOrigin(memory), scope, now)).map((excerpt) => excerpt.recordId)).toEqual([plain.recordId]);
    const state = { ...scope, config: { instructions: "garden" } } as unknown as HeartbeatState;
    const deep = { kind: "deep" as const, signals: [] };
    expect((await heartbeatMemoryContext(memory, state, deep)).map((excerpt) => excerpt.recordId)).toContain(local.recordId);
    expect((await heartbeatMemoryContext(withoutLocalOrigin(memory), state, deep)).map((excerpt) => excerpt.recordId)).toEqual([
      plain.recordId,
    ]);
  });
});

describe("a chat on a remote model reading a record that cannot be read", () => {
  it("is told it does not exist: an unreadable record's history and relations are never handed over", async () => {
    const actor = { ...scope, caller: "cli", authority: "operator" as const, runId: "remote-chat" } as MemoryActor;
    const port = {
      get: async () => {
        throw new Error("database is locked");
      },
      history: async () => ({ revisions: [{ body: "said in a local chat" }] }),
      related: async () => ({ similarTo: { recordId: "mem-2", title: "said in a local chat" } }),
    };
    // Only the reads the wrapper makes: the port's other methods are never called here.
    const memory = withLocalChatMemory(port as unknown as MemoryServicePort, {
      chatIsLocal: async () => false,
      chatRunsLocal: async () => false,
    });
    await expect(memory.history({ actor, recordId: "mem-1" } as Parameters<MemoryServicePort["history"]>[0])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(memory.related({ actor, recordId: "mem-1" } as Parameters<MemoryServicePort["related"]>[0])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("past-chat hits read from a chat on a remote model", () => {
  it("keeps only chats answered remote: one answered local, or not answered at all, is left out", async () => {
    const hits = [
      { taskId: "a", text: "first" },
      { taskId: "b", text: "local" },
      { taskId: "c", text: "unjudged" },
      { taskId: "a", text: "second" },
    ];
    const asked: (readonly string[])[] = [];
    const chats = {
      runsLocal: async () => false,
      areLocal: async (_workspaceId: string, taskIds: readonly string[]) => {
        asked.push(taskIds);
        return new Map([
          ["a", false],
          ["b", true],
        ]);
      },
    };
    expect(await withoutLocalChats(hits, chats, "default", "reader")).toEqual([
      { taskId: "a", text: "first" },
      { taskId: "a", text: "second" },
    ]);
    expect(asked).toHaveLength(1);
  });

  it("keeps every hit for a reader on a local model, asking no chat's locality", async () => {
    const hits = [{ taskId: "b", text: "local" }];
    const areLocal = vi.fn(async () => new Map([["b", true]]));
    expect(await withoutLocalChats(hits, { runsLocal: async () => true, areLocal }, "default", "reader")).toEqual(hits);
    expect(areLocal).not.toHaveBeenCalled();
  });
});

describe("a chat whose saved route cannot be read", () => {
  it("is judged local, not by the remote model it started on: what it writes is stamped", async () => {
    const runtime = await compose(
      { dataDirectory: directory(), defaultConnectionId: "cloud" },
      {
        modelOverride: {
          async stream(request) {
            return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
          },
        },
      },
    );
    const chat = (await admit(runtime, "moved-local"))?.taskId ?? "missing";
    await runtime.taskRouting.choose?.(scope, chat, { connectionId: "local", model: "m" });
    vi.spyOn(runtime.routerRepository, "route").mockRejectedValue(new Error("database is locked"));
    const actor: MemoryActor = { ...scope, runId: chat, caller: "memory.propose", authority: "model" };
    const proposed = await runtime.memory.propose({
      actor,
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "The shed is blue",
    });
    vi.restoreAllMocks();
    expect(
      (await runtime.memory.get({ actor: { ...scope, caller: "cli", authority: "operator" }, recordId: proposed.recordId })).localOrigin,
    ).toBe(true);
  });

  it("answers local while the read fails, and is judged afresh once it reads again", async () => {
    const runtime = await compose(
      { dataDirectory: directory(), defaultConnectionId: "cloud" },
      {
        modelOverride: {
          async stream(request) {
            return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
          },
        },
      },
    );
    const chat = (await admit(runtime, "remote-route"))?.taskId ?? "missing";
    await runtime.taskRouting.choose?.(scope, chat, { connectionId: "cloud", model: "m" });
    vi.spyOn(runtime.routerRepository, "route").mockRejectedValue(new Error("database is locked"));
    expect(await runtime.localChats.areLocal("default", [chat])).toEqual(new Map([[chat, true]]));
    vi.restoreAllMocks();
    expect(await runtime.localChats.areLocal("default", [chat])).toEqual(new Map([[chat, false]]));
  });
});

describe("a chat's locality, remembered between reads", () => {
  const LOCALITY_READS =
    /^(service\.accounting\.(usedConnections|summaries)|service\.router\.route|repository\.modelConfig\.|service\.modelConfig\.)/;
  const localityReads = (runtime: TaviRuntime) =>
    Object.entries(runtime.store.operationCounts().byOperation).filter(([operation]) => LOCALITY_READS.test(operation));

  it("costs no worker round trip on repeated memory reads, and one per turn after a call is recorded", async () => {
    const runtime = await compose(
      { dataDirectory: directory(), defaultConnectionId: "cloud" },
      {
        modelOverride: {
          async stream(request) {
            return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
          },
        },
      },
    );
    const chat = (await admit(runtime, "remembered"))?.taskId ?? "missing";
    const actor: MemoryActor = { ...scope, runId: chat, caller: "memory.search", authority: "model" };
    const search = async () => await runtime.memory.search({ actor, query: "garden", match: "any", purpose: "tool" });
    await search();
    runtime.store.resetOperationCounts();
    await search();
    await search();
    await runtime.localChats.isLocal("default", chat);
    expect(localityReads(runtime)).toEqual([]);
    // A turn records a generation attempt for the chat: its connections are read once again, and nothing else.
    expect(await runtime.localChats.isLocal("default", chat)).toBe(false);
    await runtime.workflow?.admit({
      context: { ...scope, runId: chat, caller: "cli" },
      operationKey: "remembered-reply",
      kind: "reply",
      taskId: chat,
      prompt: "again",
    });
    runtime.store.resetOperationCounts();
    expect(await runtime.localChats.isLocal("default", chat)).toBe(false);
    expect(localityReads(runtime)).toEqual([["service.accounting.usedConnections", 1]]);
  });

  it("reads many unremembered chats' connections in one worker request, and remembers no failed read", async () => {
    const runtime = await compose(
      { dataDirectory: directory(), defaultConnectionId: "cloud" },
      {
        modelOverride: {
          async stream(request) {
            return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
          },
        },
      },
    );
    const chats = ["many-1", "many-2", "many-3", "many-4"];
    const accountingReads = () =>
      Object.entries(runtime.store.operationCounts().byOperation).filter(([operation]) =>
        operation.startsWith("service.accounting.usedConnections"),
      );
    // A failed read answers local for every chat it covered, and is remembered for none.
    const failing = vi.spyOn(ModelAccounting.prototype, "usedConnectionsOf").mockRejectedValueOnce(new Error("database is locked"));
    expect(await runtime.localChats.areLocal("default", chats)).toEqual(new Map(chats.map((chat) => [chat, true])));
    failing.mockRestore();
    runtime.store.resetOperationCounts();
    expect(await runtime.localChats.areLocal("default", [...chats, "many-1"])).toEqual(new Map(chats.map((chat) => [chat, false])));
    expect(accountingReads()).toEqual([["service.accounting.usedConnectionsOf", 1]]);
    // What it read is remembered, for the batch and for one chat asked alone.
    runtime.store.resetOperationCounts();
    expect(await runtime.localChats.areLocal("default", chats)).toEqual(new Map(chats.map((chat) => [chat, false])));
    expect(await runtime.localChats.isLocal("default", "many-2")).toBe(false);
    expect(accountingReads()).toEqual([]);
  });

  it("is judged again after a model configuration write or a chosen route", async () => {
    const runtime = await compose(
      { dataDirectory: directory(), defaultConnectionId: "cloud" },
      {
        modelOverride: {
          async stream(request) {
            return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
          },
        },
      },
    );
    // Never run: judged by the default it would start on.
    expect(await runtime.localChats.runsLocal("default", "never-run")).toBe(false);
    expect(await runtime.localChats.areLocal("default", ["never-run"])).toEqual(new Map([["never-run", false]]));
    const models = runtime.store.services.modelConfig;
    await models.putConnection({ ...LOCAL, label: "local" });
    await models.putCatalogEntry({
      connectionId: "local",
      modelId: "m",
      provenance: "live",
      state: "capable",
      capabilities: ["tools", "streaming"],
      contextWindow: 256_000,
      maxTokens: 4096,
    });
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "local", model: "m" } });
    expect(await runtime.localChats.runsLocal("default", "never-run")).toBe(true);
    expect(await runtime.localChats.areLocal("default", ["never-run"])).toEqual(new Map([["never-run", true]]));
    await models.clearWorkspaceDefault("default");
    expect(await runtime.localChats.runsLocal("default", "never-run")).toBe(false);
    // A chat on the remote default, moved to the local connection.
    const chat = (await admit(runtime, "moved"))?.taskId ?? "missing";
    expect(await runtime.localChats.runsLocal("default", chat)).toBe(false);
    await runtime.taskRouting.choose?.(scope, chat, { connectionId: "local", model: "m" });
    expect(await runtime.localChats.runsLocal("default", chat)).toBe(true);
  });
});
