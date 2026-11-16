import {
  defaultHeartbeatConfig,
  effectiveMemorySettings,
  MEMORY_EMBEDDING_DISCLOSURE_REASON,
  MEMORY_EMBEDDING_PERSONAL_DISCLOSURE_REASON,
  TaviError,
  type EffectiveMemorySettings,
  type HeartbeatState,
  type MemoryActor,
  type ModelEmbedRequest,
  type ModelPort,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { retrievalQueryFrom } from "@tavi/agent-host/workflow";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { applyWorkspaceSetting, memoryRetrievalDisclosure, memorySettingsReader } from "../../src/server/workspace-settings-commands.js";
import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { MEMORY_EMBEDDING_ATTEMPT_PREFIX, type EmbeddingRoleService } from "../../src/features/memory/embedding-role.js";
import { heartbeatMemoryContext } from "../../src/features/heartbeat/sources.js";
import {
  createMemoryVectorBackfill,
  hybridNearMatch,
  hybridSearch,
  MEMORY_VECTOR_BACKOFF_MS,
  MEMORY_VECTOR_FAILURES_MAX,
  MEMORY_VECTOR_PER_MINUTE,
  memoryVectorsDoctor,
  MemoryRecallTimes,
} from "../../src/features/memory/vectors.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Hybrid recall in the composed owner: the backfill embeds approved records on the bound `embedding` role,
 * a turn's or tool's `semantic` text is embedded under the recall deadline and
 * fused with bm25 over eligible records, and every failure is words only with
 * `coverage: "partial"`. The embedder here is a scripted concept map, not a
 * model: it shows the pipeline, never recall quality.
 */

const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  directories.cleanup();
});

const OPERATOR: MemoryActor = { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" };
const TURN: MemoryActor = { ...OPERATOR, runId: "chat-1", chatTaskId: "chat-1", authority: "model", caller: "agent" };
const PERSONAL = { kind: "personal", principalId: "operator" } as const;
// The workspace's own records: a remote embedding connection receives personal ones only once their own disclosure is accepted.
const OWN = { kind: "personal_workspace", principalId: "operator", workspaceId: "default" } as const;

/** Words → a concept axis: "where do I live?" lands beside "Based in Lisbon", which share no word. */
const AXES: readonly (readonly string[])[] = [
  ["lisbon", "live", "based", "home", "city", "porto"],
  ["work", "job", "nurse", "hospital", "office"],
  ["eat", "vegetarian", "food", "meat", "dinner"],
  ["dog", "cat", "pet", "walks"],
];
function conceptVector(text: string, model: string): Float32Array {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const vector = AXES.map((axis) => words.filter((word) => axis.includes(word)).length + 0.01);
  // Another model places things differently: its vectors are not comparable with the first's.
  return Float32Array.from(model === "embed-2" ? [...vector].reverse() : vector);
}

/** A fixture transport whose `embed` answers concept vectors, or fails while `failing` holds. */
function fixtureModel() {
  const sent: ModelEmbedRequest[] = [];
  const state = { failing: false };
  const model: ModelPort = {
    async stream(request) {
      return { status: "completed", attemptId: request.attemptId, text: "ok", toolCalls: [], usage: {} };
    },
    async embed(request: ModelEmbedRequest) {
      sent.push(request);
      if (state.failing)
        return {
          status: "failed" as const,
          attemptId: request.attemptId,
          vectors: [],
          error: { code: "provider" as const, message: "the embedding service is down", retryable: true },
          usage: {},
        };
      return {
        status: "completed" as const,
        attemptId: request.attemptId,
        vectors: request.texts.map((text) => conceptVector(text, request.model)),
        usage: {
          inputTokens: 10,
          inputNoCacheTokens: 10,
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 0,
          outputTokens: 0,
          totalTokens: 10,
        },
      };
    },
  };
  return { model, sent, state };
}

async function owner() {
  const { model, sent, state } = fixtureModel();
  const dataDirectory = directories.create("tavi-memory-hybrid-");
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(dataDirectory, { approvalRequiredFor: [] }), { modelOverride: model });
  runtimes.push(runtime);
  const models = runtime.store.services.modelConfig;
  await models.putConnection({
    connectionId: "cloud",
    label: "cloud",
    baseUrl: "https://api.example.com/v1",
    credentialRef: "cloud.key",
    defaultModel: "chat",
  });
  await models.putConnection({
    connectionId: "ollama",
    label: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    credentialRef: "ollama.key",
    localOnly: true,
  });
  await models.setRoleBinding({ workspaceId: "default", role: "embedding", target: { connectionId: "cloud", model: "embed-1" } });
  const repositories = runtime.store.asPort().repositories;
  const memorySettings = memorySettingsReader(repositories.workspaceSettings);
  // Hybrid as if turned on with the remote connection's disclosure accepted.
  const setRetrieval = async (retrieval: "lexical" | "hybrid") => {
    const current = await repositories.workspaceSettings.get("default");
    const egress = current.settings.memory?.providerEgress === undefined ? {} : { providerEgress: current.settings.memory.providerEgress };
    const memory = retrieval === "hybrid" ? { retrieval, retrievalConnection: "cloud", ...egress } : { retrieval, ...egress };
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { ...current.settings, memory },
      expectedRevision: current.revision,
      actor: "test",
      now: nowTimestamp(),
    });
  };
  // Personal egress (`includePersonal`, with `records`), as `tavi memory egress personal on` stores it for an external provider.
  const setPersonalEgress = async (on: boolean) => {
    const current = await repositories.workspaceSettings.get("default");
    const { providerEgress: _egress, ...rest } = current.settings.memory ?? {};
    const memory = on ? { ...rest, providerEgress: { records: true, includePersonal: true } } : rest;
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { ...current.settings, memory },
      expectedRevision: current.revision,
      actor: "test",
      now: nowTimestamp(),
    });
  };
  /** The owner's own memory write: the check, and each disclosure when the connection is remote. */
  const write = (
    value: Record<string, unknown>,
    options: { readonly confirmed?: boolean; readonly confirmedConnection?: string; readonly retrievalPersonal?: boolean } = {},
  ) =>
    applyWorkspaceSetting(repositories.workspaceSettings, {
      workspaceId: "default",
      key: "memory",
      value: JSON.stringify(value),
      actor: "test",
      now: nowTimestamp(),
      retrievalCheck: () => memoryRetrievalDisclosure(models, repositories.memory, "default", "operator", nowTimestamp()),
      dropVectorCache: async () => repositories.memory.dropVectorCache("default"),
      ...options,
    });
  // Hybrid through the owner's own write (`tavi memory config retrieval hybrid [--include-personal] [--yes=<connection>]`):
  // `accepted` is the connection whose disclosure the confirm accepts.
  const turnOn = (accepted?: string, retrievalPersonal?: boolean) =>
    write(
      { retrieval: "hybrid" },
      {
        ...(accepted === undefined ? {} : { confirmed: true, confirmedConnection: accepted }),
        ...(retrievalPersonal === undefined ? {} : { retrievalPersonal }),
      },
    );
  // The real clock, moved on by `advance`: records are approved as the test runs, and a backlog read before then finds none in force.
  let offset = 0;
  const logs: string[] = [];
  const backfill = createMemoryVectorBackfill({
    memory: repositories.memory,
    embeddings: runtime.embeddings,
    workspaces: () => [{ workspaceId: "default", principalId: "operator", principalIds: ["operator"] }],
    memorySettings,
    now: () => new Date(Date.now() + offset),
    log: (message) => logs.push(message),
  });
  const advance = (ms: number) => {
    offset += ms;
  };
  const queries = () => sent.filter((request) => request.runId !== "memory-embeddings");
  return {
    runtime,
    dataDirectory,
    sent,
    state,
    models,
    repositories,
    memorySettings,
    setRetrieval,
    setPersonalEgress,
    write,
    turnOn,
    backfill,
    advance,
    queries,
    logs,
  };
}

describe("hybrid recall in the owner", () => {
  it("a message with no keyword recalls by meaning alone under hybrid; under lexical it answers no hits and no refusal, as when no search ran", async () => {
    const { runtime, setRetrieval, backfill, queries } = await owner();
    const home = await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Based in Lisbon" });
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Works as a nurse" });
    // The turn's query when the person's words hold no keyword: blank words, the message as `semantic`.
    const ask = () => runtime.memory.search({ actor: TURN, query: "", match: "any", purpose: "turn", semantic: "where do I live?" });
    expect(await ask()).toEqual({ hits: [], coverage: "complete" });
    expect(queries()).toEqual([]);
    await setRetrieval("hybrid");
    await backfill.tick();
    const answer = await ask();
    expect(answer.hits[0]?.recordId).toBe(home.recordId);
    expect(answer.coverage).toBe("complete");
    expect(queries().map((request) => request.texts)).toEqual([["where do I live?"]]);
    // Blank words with nothing to mean are still refused.
    await expect(Promise.resolve().then(() => runtime.memory.search({ actor: TURN, query: " " }))).rejects.toThrow(/blank/);
  });

  it("a paraphrase misses under lexical and hits under hybrid once the backfill embedded the record; the query is one embedding attempt on the turn's task", async () => {
    const { runtime, sent, setRetrieval, backfill, queries } = await owner();
    const home = await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Based in Lisbon" });
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Works as a nurse" });
    const ask = () => runtime.memory.search({ actor: TURN, query: "where", match: "any", semantic: "where do I live?" });
    // Lexical (the default): no word shared, no hit, and nothing sent anywhere.
    expect((await ask()).hits).toEqual([]);
    await backfill.tick();
    expect(sent).toEqual([]);
    await setRetrieval("hybrid");
    await backfill.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.texts).toEqual(["Based in Lisbon", "Works as a nurse"]);
    const answer = await ask();
    expect(answer.coverage).toBe("complete");
    expect(answer.hits[0]?.recordId).toBe(home.recordId);
    expect(queries().map((request) => request.texts)).toEqual([["where do I live?"]]);
    const attempts = await runtime.modelAccounting.list("chat-1");
    expect(attempts.map((attempt) => attempt.purpose)).toEqual(["embedding"]);
  });

  it("a failed embedding is words only, with coverage partial, never a failed turn", async () => {
    const { runtime, state, setRetrieval, backfill } = await owner();
    const record = await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Based in Lisbon" });
    await setRetrieval("hybrid");
    await backfill.tick();
    state.failing = true;
    const answer = await runtime.memory.search({ actor: TURN, query: "lisbon", match: "any", semantic: "anything about lisbon?" });
    expect(answer.coverage).toBe("partial");
    expect(answer.reducedReason).toMatch(/the embedding call failed/);
    expect(answer.hits.map((hit) => hit.recordId)).toEqual([record.recordId]);
  });

  it("changing the bound embedding model re-embeds every vector, and recall is partial until it is done", async () => {
    const { runtime, sent, models, setRetrieval, backfill } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Based in Lisbon" });
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Works as a nurse" });
    await setRetrieval("hybrid");
    await backfill.tick();
    await models.setRoleBinding({ workspaceId: "default", role: "embedding", target: { connectionId: "cloud", model: "embed-2" } });
    const before = await runtime.memory.search({ actor: TURN, query: "lisbon", match: "any", semantic: "where do I live?" });
    expect(before.coverage).toBe("partial");
    expect(before.reducedReason).toMatch(/2 of 2 records have no vector yet/);
    await backfill.tick();
    expect(sent.filter((request) => request.runId === "memory-embeddings").map((request) => request.model)).toEqual(["embed-1", "embed-2"]);
    const after = await runtime.memory.search({ actor: TURN, query: "lisbon", match: "any", semantic: "where do I live?" });
    expect(after.coverage).toBe("complete");
    expect(
      (
        await runtime.store.asPort().repositories.memory.vectorStats({
          workspaceId: "default",
          principalIds: ["operator"],
          modelKey: "cloud/embed-2",
          now: nowTimestamp(),
          maxFailures: 3,
        })
      ).indexed,
    ).toBe(2);
  });

  it("memory invariant 14: no query reaches an embedding model under lexical; a local chat's never reaches a remote connection; a heartbeat tick's never at all", async () => {
    const { runtime, models, setRetrieval, backfill, queries } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "ACME pays invoices late" });
    // Lexical: a turn's and a tool's semantic text go nowhere.
    await runtime.memory.search({ actor: TURN, query: "acme", match: "any", semantic: "what about ACME invoices?" });
    expect(queries()).toEqual([]);
    await setRetrieval("hybrid");
    await backfill.tick();
    // A heartbeat tick's memory: lexical always, whatever the setting.
    const state: HeartbeatState = {
      workspaceId: "default",
      principalId: "operator",
      config: { ...defaultHeartbeatConfig(), enabled: true, instructions: "Watch ACME invoices" },
      createdAt: "2026-10-11T09:00:00.000Z",
      updatedAt: "2026-10-11T09:00:00.000Z",
    };
    expect((await heartbeatMemoryContext(runtime.memory, state, { kind: "deep", signals: [] })).length).toBeGreaterThan(0);
    expect(queries()).toEqual([]);
    // A chat that ran on a local connection: its query stays here (lexical, partial).
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "ollama", model: "llama" } });
    const local = await runtime.memory.search({
      actor: { ...TURN, runId: "chat-local", chatTaskId: "chat-local" },
      query: "acme",
      match: "any",
      semantic: "what about ACME invoices?",
    });
    expect(local.coverage).toBe("partial");
    expect(local.reducedReason).toMatch(/local connection/);
    expect(queries()).toEqual([]);
    // A chat on a remote connection does send its query, the one path that may.
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "cloud", model: "chat" } });
    await runtime.memory.search({
      actor: { ...TURN, runId: "chat-remote", chatTaskId: "chat-remote" },
      query: "acme",
      match: "any",
      semantic: "what about ACME invoices?",
    });
    expect(queries().map((request) => request.texts)).toEqual([["what about ACME invoices?"]]);
  });

  it("capture drops a draft near a kept record by meaning once hybrid is on (cosine ≥ 0.92), under hybrid recall's locality rules", async () => {
    const { runtime, models, setRetrieval, backfill, queries } = await owner();
    const home = await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Based in Lisbon" });
    const capture = (runId: string, body: string, scope: typeof OWN | typeof PERSONAL = OWN) =>
      runtime.memory.propose({ actor: { ...TURN, runId, chatTaskId: runId }, scope, kind: "fact", body, nearMatch: "drop" });
    // Lexical: no word shared, so it is filed, and nothing is embedded.
    expect((await capture("chat-remote", "Home city is Porto")).known).toBeUndefined();
    expect(queries()).toEqual([]);
    await setRetrieval("hybrid");
    await backfill.tick();
    // A chat that ran on a local connection: its draft never goes to the remote embedding connection.
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "ollama", model: "llama" } });
    expect((await capture("chat-local", "Porto is the home city now")).known).toBeUndefined();
    expect(queries()).toEqual([]);
    // A remote chat: the draft is embedded as a record is, and its near match by meaning is dropped.
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "cloud", model: "chat" } });
    expect(await capture("chat-remote", "My home city is Porto")).toMatchObject({ recordId: home.recordId, known: "near" });
    expect(queries().map((request) => request.texts)).toEqual([["My home city is Porto"]]);
    // Far in meaning: filed. And a draft from the tool (no drop asked) is never embedded.
    expect((await capture("chat-remote", "Works night shifts at the office")).known).toBeUndefined();
    expect(
      (await runtime.memory.propose({ actor: TURN, scope: PERSONAL, kind: "fact", body: "Home in Lisbon city" })).known,
    ).toBeUndefined();
    expect(queries()).toHaveLength(2);
    // A personal draft goes to the remote connection only with personal memory's own opt-in: here it is off.
    expect((await capture("chat-remote", "My home town is Porto", PERSONAL)).known).toBeUndefined();
    expect(queries()).toHaveLength(2);
  });

  it("memory invariants 7/14: a sensitive draft is never embedded for the near match, marked or found by the host's list", async () => {
    const { runtime, models, setRetrieval, backfill, queries } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Based in Lisbon" });
    await setRetrieval("hybrid");
    await backfill.tick();
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "cloud", model: "chat" } });
    const actor = { ...TURN, runId: "chat-remote", chatTaskId: "chat-remote" };
    // Even asked for the drop (as a capture once did), neither a marked draft nor one on the host's list leaves for the embedder.
    await runtime.memory.propose({
      actor,
      scope: OWN,
      kind: "fact",
      body: "Home city is Porto, near the clinic",
      sensitivity: "sensitive",
      nearMatch: "drop",
    });
    await runtime.memory.propose({ actor, scope: OWN, kind: "fact", body: "Lives in Porto and has asthma", nearMatch: "drop" });
    expect(queries()).toEqual([]);
    // An ordinary draft still is.
    await runtime.memory.propose({ actor, scope: OWN, kind: "fact", body: "My home city is Porto", nearMatch: "drop" });
    expect(queries().map((request) => request.texts)).toEqual([["My home city is Porto"]]);
  });

  it("memory invariant 14: the memory.search tool recalls by meaning under hybrid, and a local chat's tool query stays here, words only", async () => {
    const { runtime, models, setRetrieval, backfill, queries } = await owner();
    const home = await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Based in Lisbon" });
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Works as a nurse" });
    const tool = runtime.tools.get("memory.search");
    if (tool === undefined) throw new Error("memory.search is not registered");
    const call = (runId: string, query: string) =>
      tool.handler({
        input: { query },
        context: { workspaceId: "default", principalId: "operator", runId, chatTaskId: runId, caller: "model" },
        signal: new AbortController().signal,
      }) as Promise<{ hits: { recordId: string }[]; coverage: string; reducedReason?: string }>;
    // Lexical: the model's words share none with the record.
    expect((await call("chat-tool", "city of residence")).hits).toEqual([]);
    expect(queries()).toEqual([]);
    await setRetrieval("hybrid");
    await backfill.tick();
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "cloud", model: "chat" } });
    const remote = await call("chat-tool-remote", "which city do I live in");
    expect(remote.hits[0]?.recordId).toBe(home.recordId);
    expect(remote.coverage).toBe("complete");
    expect(queries().map((request) => request.texts)).toEqual([["which city do I live in"]]);
    // A chat on a local connection: its tool query never reaches the remote embedding connection.
    await models.setWorkspaceDefault({ workspaceId: "default", target: { connectionId: "ollama", model: "llama" } });
    const local = await call("chat-tool-local", "which city do I live in");
    expect(local.coverage).toBe("partial");
    expect(local.reducedReason).toMatch(/local connection/);
    expect(queries()).toHaveLength(1);
  });

  it("a 2-character CJK word written on its own is a query term, and finds a record holding that word on its own", async () => {
    const { runtime } = await owner();
    const record = await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "住所: 東京 、 渋谷区" });
    const query = retrievalQueryFrom([{ id: "input-1", role: "user", text: "東京 の天気は?" }])!;
    expect(query.split(" ")).toContain("東京");
    const answer = await runtime.memory.search({ actor: TURN, query, match: "any" });
    expect(answer.hits.map((hit) => hit.recordId)).toEqual([record.recordId]);
  });

  it("doctor counts vectors indexed, missing and failed, the cache, and turn recall's p95", async () => {
    const { runtime, setRetrieval, backfill, memorySettings } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Based in Lisbon" });
    await setRetrieval("hybrid");
    await backfill.tick();
    await runtime.memory.search({ actor: TURN, query: "lisbon", match: "any", semantic: "where do I live?" });
    const doctor = await memoryVectorsDoctor({
      workspaceId: "default",
      principalId: "operator",
      principalIds: ["operator"],
      settings: await memorySettings("default"),
      memory: runtime.store.asPort().repositories.memory,
      embeddings: runtime.embeddings,
      times: runtime.memoryRecallTimes,
      now: nowTimestamp(),
      // The backfill's call and the turn's query, found by the attempt-id prefix.
      spend: await runtime.store.memoryEmbeddingSpend({
        since: new Date(Date.now() - 60_000).toISOString(),
        attemptPrefix: MEMORY_EMBEDDING_ATTEMPT_PREFIX,
      }),
    });
    expect(doctor).toMatchObject({
      retrieval: "hybrid",
      model: "cloud/embed-1",
      locality: "remote",
      retrievalConnection: "cloud",
      personal: false,
      indexed: 1,
      missing: 0,
      failed: 0,
      cache: { vectors: 1, bytes: 16 },
      recalls: 1,
      spend: { calls: 2, failed: 0, inputTokens: 20 },
    });
    expect(doctor.recallP95Ms).toEqual(expect.any(Number));
    // Back to lexical: the next tick drops the worker's cache.
    await setRetrieval("lexical");
    await backfill.tick();
    expect(
      (
        await runtime.store
          .asPort()
          .repositories.memory.vectorStats({ workspaceId: "default", principalIds: ["operator"], now: nowTimestamp(), maxFailures: 3 })
      ).cachedVectors,
    ).toBe(0);
  });

  it("`tavi memory export` holds no vector and no model key after a backfill", async () => {
    const { runtime, dataDirectory, repositories, setRetrieval, backfill } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Based in Lisbon" });
    await setRetrieval("hybrid");
    await backfill.tick();
    expect(
      (
        await repositories.memory.vectorStats({
          workspaceId: "default",
          principalIds: ["operator"],
          modelKey: "cloud/embed-1",
          now: nowTimestamp(),
          maxFailures: 3,
        })
      ).indexed,
    ).toBe(1);
    // The export is offline: the owner lets the directory go first.
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await runtime.close();
    let stdout = "";
    const io: CliIo = { stdout: (text) => void (stdout += text), stderr: () => {}, isTty: false };
    expect(await main(["memory", "export", "--format", "json", "--data-dir", dataDirectory], { io })).toBe(EXIT.ok);
    const bundle = JSON.parse(stdout) as { records: unknown[] };
    expect(bundle.records).toHaveLength(1);
    expect(stdout).not.toMatch(/vector|model_?key|modelKey|embed-1/i);
  });

  it("the settings write that turns hybrid back to lexical drops the worker's cache itself, with no backfill tick", async () => {
    const { runtime, repositories, setRetrieval, backfill } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Based in Lisbon" });
    await setRetrieval("hybrid");
    await backfill.tick();
    await runtime.memory.search({ actor: TURN, query: "lisbon", match: "any", semantic: "where do I live?" });
    const cached = async () =>
      (await repositories.memory.vectorStats({ workspaceId: "default", principalIds: ["operator"], now: nowTimestamp(), maxFailures: 3 }))
        .cachedVectors;
    expect(await cached()).toBe(1);
    let drops = 0;
    const write = (value: Record<string, unknown>) =>
      applyWorkspaceSetting(repositories.workspaceSettings, {
        workspaceId: "default",
        key: "memory",
        value: JSON.stringify(value),
        actor: "test",
        now: nowTimestamp(),
        dropVectorCache: async () => {
          drops += 1;
          await repositories.memory.dropVectorCache("default");
        },
      });
    // A write that keeps hybrid keeps the cache.
    await write({ retrieval: "hybrid", capture: "off" });
    expect(drops).toBe(0);
    await write({ retrieval: "lexical" });
    expect(drops).toBe(1);
    expect(await cached()).toBe(0);
    // Lexical to lexical: nothing to drop.
    await write({ retrieval: "lexical", capture: "off" });
    expect(drops).toBe(1);
  });
});

describe("the embedding connection's disclosure (invariant 14)", () => {
  it("on a remote connection names the workspace's memories only, says personal memory is not sent, and turns on only once accepted", async () => {
    const { runtime, repositories, turnOn } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Based in Lisbon" });
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Standup is at nine" });
    const refused = await turnOn().catch((error: unknown) => TaviError.from(error));
    expect(refused).toMatchObject({
      code: "APPROVAL_REQUIRED",
      details: { reason: MEMORY_EMBEDDING_DISCLOSURE_REASON, connectionId: "cloud", records: 1 },
    });
    expect((refused as TaviError).details).not.toHaveProperty("personal");
    expect((refused as TaviError).message).toMatch(/1 approved memory of this workspace now.*Personal memory is not sent/);
    expect((await repositories.workspaceSettings.get("default")).settings.memory?.retrieval).toBeUndefined();
    await turnOn("cloud");
    expect((await repositories.workspaceSettings.get("default")).settings.memory).toEqual({
      retrieval: "hybrid",
      retrievalConnection: "cloud",
    });
  });

  it("personal memory has its own disclosure: shown apart (with both when hybrid turns on with it), stored as the connection it was accepted for, and an external provider's personal egress does not stand in for it", async () => {
    const { runtime, repositories, turnOn, setPersonalEgress } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Based in Lisbon" });
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Standup is at nine" });
    const memory = async () => (await repositories.workspaceSettings.get("default")).settings.memory;
    // An external provider's `includePersonal` is that provider's switch: hybrid alone still sends no personal record.
    await setPersonalEgress(true);
    await turnOn("cloud");
    expect(await memory()).toMatchObject({ retrieval: "hybrid", retrievalConnection: "cloud" });
    expect(await memory()).not.toHaveProperty("retrievalPersonal");
    // Asked for with hybrid already accepted: only personal memory's disclosure, counting it.
    const refused = await turnOn(undefined, true).catch((error: unknown) => TaviError.from(error));
    expect(refused).toMatchObject({
      code: "APPROVAL_REQUIRED",
      details: { reason: MEMORY_EMBEDDING_PERSONAL_DISCLOSURE_REASON, connectionId: "cloud", personal: 1 },
    });
    expect((refused as TaviError).message).toMatch(
      /^Your personal memory is shared by all your workspaces: turning this on sends 1 of your approved personal memories .* to cloud.*Other people's personal memory is never sent there/,
    );
    expect(await memory()).not.toHaveProperty("retrievalPersonal");
    await turnOn("cloud", true);
    expect(await memory()).toMatchObject({ retrieval: "hybrid", retrievalConnection: "cloud", retrievalPersonal: "cloud" });
    // Asked again once accepted: nothing new to say.
    await turnOn(undefined, true);
    // From lexical, hybrid with personal memory says both.
    await turnOn(undefined, false);
    await setPersonalEgress(false);
    await applyWorkspaceSetting(repositories.workspaceSettings, {
      workspaceId: "default",
      key: "memory",
      value: JSON.stringify({}),
      actor: "test",
      now: nowTimestamp(),
    });
    const both = await turnOn(undefined, true).catch((error: unknown) => TaviError.from(error));
    expect((both as TaviError).message).toMatch(
      /1 approved memory of this workspace now.*Your personal memory is shared.*Confirm to turn hybrid recall on\.$/,
    );
    // Only with hybrid.
    await expect(
      applyWorkspaceSetting(repositories.workspaceSettings, {
        workspaceId: "default",
        key: "memory",
        value: JSON.stringify({ retrieval: "lexical" }),
        actor: "test",
        now: nowTimestamp(),
        retrievalPersonal: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("a client cannot set personal memory's opt-in itself: only the owner writes it, on acceptance", async () => {
    const { repositories, write } = await owner();
    await write({ retrieval: "hybrid" }, { confirmed: true, confirmedConnection: "cloud" });
    await write({ retrieval: "hybrid", retrievalConnection: "cloud", retrievalPersonal: "cloud", capture: "off" });
    expect((await repositories.workspaceSettings.get("default")).settings.memory).toEqual({
      retrieval: "hybrid",
      retrievalConnection: "cloud",
      capture: "off",
    });
    // A write that does not name it keeps it once accepted; hybrid turned off ends it.
    await write({ retrieval: "hybrid" }, { confirmed: true, confirmedConnection: "cloud", retrievalPersonal: true });
    await write({ retrieval: "hybrid", capture: "suggest" });
    expect((await repositories.workspaceSettings.get("default")).settings.memory).toMatchObject({ retrievalPersonal: "cloud" });
    await write({ retrieval: "lexical" });
    expect((await repositories.workspaceSettings.get("default")).settings.memory).toEqual({ retrieval: "lexical" });
  });

  it("memory invariant 14: without personal memory's opt-in no personal text reaches a remote embedder and recall finds personal records by their words, not partial; accepted, they are embedded and recalled by meaning; turned off, their vectors go", async () => {
    const { runtime, sent, turnOn, write, setPersonalEgress, backfill, memorySettings } = await owner();
    const personal = await runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Lives in Lisbon with a dog" });
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Works as a nurse" });
    // Even with an external provider's personal egress on: that switch is not this one.
    await setPersonalEgress(true);
    await turnOn("cloud");
    await backfill.tick();
    const embedded = () => sent.filter((request) => request.runId === "memory-embeddings").flatMap((request) => request.texts);
    expect(embedded()).toEqual(["Works as a nurse"]);
    // The personal record is still recalled, by its words, and is not counted as missing a vector.
    const answer = await runtime.memory.search({ actor: TURN, query: "lisbon", match: "any", semantic: "anything about lisbon?" });
    expect(answer.hits.map((hit) => hit.recordId)).toContain(personal.recordId);
    expect(answer.coverage).toBe("complete");
    const byMeaning = () => runtime.memory.search({ actor: TURN, query: "", match: "any", purpose: "turn", semantic: "where is home?" });
    expect((await byMeaning()).hits.map((hit) => hit.recordId)).not.toContain(personal.recordId);
    const doctor = async () =>
      memoryVectorsDoctor({
        workspaceId: "default",
        principalId: "operator",
        principalIds: ["operator"],
        settings: await memorySettings("default"),
        memory: runtime.store.asPort().repositories.memory,
        embeddings: runtime.embeddings,
        now: nowTimestamp(),
      });
    expect(await doctor()).toMatchObject({
      personal: false,
      retrievalConnection: "cloud",
      retrievalPersonal: null,
      indexed: 1,
      missing: 0,
    });
    // Accepted (`--include-personal --yes`): the personal record is embedded through the connection and found by meaning.
    await turnOn("cloud", true);
    await backfill.tick();
    expect(embedded()).toEqual(["Works as a nurse", "Lives in Lisbon with a dog"]);
    expect(await doctor()).toMatchObject({ personal: true, retrievalPersonal: "cloud", indexed: 2, missing: 0 });
    expect((await byMeaning()).hits.map((hit) => hit.recordId)).toContain(personal.recordId);
    const stats = () =>
      runtime.store.asPort().repositories.memory.vectorStats({
        workspaceId: "default",
        principalIds: ["operator"],
        modelKey: "cloud/embed-1",
        now: nowTimestamp(),
        maxFailures: 3,
      });
    expect((await stats()).indexed).toBe(2);
    // Turned off (`retrieval hybrid` without the flag): the next tick prunes its vector, out of the cache too.
    await write({ retrieval: "hybrid" }, { retrievalPersonal: false });
    expect(await memorySettings("default")).not.toHaveProperty("retrievalPersonal");
    await backfill.tick();
    expect((await stats()).indexed).toBe(1);
    // The write dropped the worker's cache; reloaded by the next recall, it holds the workspace's vector alone.
    expect((await byMeaning()).hits.map((hit) => hit.recordId)).not.toContain(personal.recordId);
    expect((await stats()).cachedVectors).toBe(1);
    expect(embedded()).toEqual(["Works as a nurse", "Lives in Lisbon with a dog"]);
  });

  it("offline, tavi memory config counts the workspace principal's personal records for the personal disclosure, as the owner resolves it — nobody's in a workspace the owner does not serve", async () => {
    const { runtime, models, dataDirectory } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Lives in Lisbon with a dog" });
    await models.setRoleBinding({ workspaceId: "team", role: "embedding", target: { connectionId: "cloud", model: "embed-1" } });
    // Offline: the owner lets the directory go first.
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await runtime.close();
    const cli = async (...argv: string[]) => {
      let stderr = "";
      const io: CliIo = { stdout: () => {}, stderr: (text) => void (stderr += text), isTty: false };
      const code = await main(["memory", "config", ...argv, "--data-dir", dataDirectory], { io });
      return { code, stderr };
    };
    for (const workspace of ["default", "team"]) {
      const accepted = await cli("retrieval", "hybrid", "--yes=cloud", "--workspace", workspace);
      expect(accepted.code, accepted.stderr).toBe(EXIT.ok);
    }
    const own = await cli("retrieval", "hybrid", "--include-personal");
    expect(own.code).not.toBe(EXIT.ok);
    expect(own.stderr).toContain("sends 1 of your approved personal memories");
    // No owner serves "team" for the operator, so it would embed nobody's personal memory: none to count.
    const team = await cli("retrieval", "hybrid", "--include-personal", "--workspace", "team");
    expect(team.code).not.toBe(EXIT.ok);
    expect(team.stderr).toContain("sends 0 of your approved personal memories");
  });

  it("memory invariant 14: personal memory's opt-in accepted for one connection sends nothing through another; accepting the other ends it", async () => {
    const { runtime, models, repositories, sent, turnOn, backfill, memorySettings } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Lives in Lisbon with a dog" });
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Works as a nurse" });
    await models.putConnection({
      connectionId: "cloud-b",
      label: "cloud-b",
      baseUrl: "https://api.example.org/v1",
      credentialRef: "cloud-b.key",
      defaultModel: "chat",
    });
    await turnOn("cloud", true);
    expect((await memorySettings("default")).retrievalPersonal).toBe("cloud");
    // Even stored beside an accepted connection B, an opt-in for A embeds no personal record through B.
    const current = await repositories.workspaceSettings.get("default");
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { ...current.settings, memory: { retrieval: "hybrid", retrievalConnection: "cloud-b", retrievalPersonal: "cloud" } },
      expectedRevision: current.revision,
      actor: "test",
      now: nowTimestamp(),
    });
    await models.setRoleBinding({ workspaceId: "default", role: "embedding", target: { connectionId: "cloud-b", model: "embed-1" } });
    await backfill.tick();
    const throughB = () => sent.filter((request) => request.connectionId === "cloud-b").flatMap((request) => request.texts);
    expect(throughB()).toEqual(["Works as a nurse"]);
    await runtime.memory.search({ actor: TURN, query: "lisbon", match: "any", semantic: "where is home?" });
    // Accepting B for hybrid (without the flag) leaves no opt-in for A behind; B's needs its own acceptance.
    await turnOn("cloud-b");
    expect(await memorySettings("default")).not.toHaveProperty("retrievalPersonal");
    await backfill.tick();
    expect(throughB()).not.toContain("Lives in Lisbon with a dog");
    await turnOn("cloud-b", true);
    await backfill.tick();
    expect(throughB()).toContain("Lives in Lisbon with a dog");
  });

  it("a confirm accepts only the connection its disclosure named: one bound since is refused with its own disclosure, for hybrid and for personal memory", async () => {
    const { runtime, models, repositories, turnOn, write } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Lives in Lisbon with a dog" });
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Works as a nurse" });
    await models.putConnection({
      connectionId: "cloud-b",
      label: "cloud-b",
      baseUrl: "https://api.example.org/v1",
      credentialRef: "cloud-b.key",
      defaultModel: "chat",
    });
    const memory = async () => (await repositories.workspaceSettings.get("default")).settings.memory;
    // The disclosure names cloud; the role is rebound to cloud-b before the yes.
    await expect(turnOn()).rejects.toMatchObject({ code: "APPROVAL_REQUIRED", details: { connectionId: "cloud" } });
    await models.setRoleBinding({ workspaceId: "default", role: "embedding", target: { connectionId: "cloud-b", model: "embed-1" } });
    await expect(turnOn("cloud")).rejects.toMatchObject({ code: "APPROVAL_REQUIRED", details: { connectionId: "cloud-b" } });
    // A confirm that names no connection accepts none.
    await expect(write({ retrieval: "hybrid" }, { confirmed: true })).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
      details: { connectionId: "cloud-b" },
    });
    expect(await memory()).toBeUndefined();
    await turnOn("cloud-b");
    expect(await memory()).toEqual({ retrieval: "hybrid", retrievalConnection: "cloud-b" });
    // Personal memory's disclosure names cloud-b; the role moves back to cloud before the yes.
    await expect(turnOn(undefined, true)).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
      details: { reason: MEMORY_EMBEDDING_PERSONAL_DISCLOSURE_REASON, connectionId: "cloud-b" },
    });
    await models.setRoleBinding({ workspaceId: "default", role: "embedding", target: { connectionId: "cloud", model: "embed-1" } });
    await expect(turnOn("cloud-b", true)).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
      details: { reason: MEMORY_EMBEDDING_PERSONAL_DISCLOSURE_REASON, connectionId: "cloud" },
    });
    expect(await memory()).toEqual({ retrieval: "hybrid", retrievalConnection: "cloud-b" });
  });

  it("memory invariant 14: personal memory's opt-in sends the accepting operator's own personal memory only; another person's is never sent to a remote embedder, counted, recalled or matched by meaning there", async () => {
    const { runtime, models, repositories, sent, turnOn, memorySettings } = await owner();
    const ALICE: MemoryActor = { ...OPERATOR, principalId: "alice" };
    await runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Lives in Lisbon with a dog" });
    await runtime.memory.remember({
      actor: ALICE,
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      body: "Alice lives in Porto with a cat",
    });
    // The disclosure counts the operator's own personal memory, not the other person's.
    const refused = await turnOn(undefined, true).catch((error: unknown) => TaviError.from(error));
    expect(refused).toMatchObject({ code: "APPROVAL_REQUIRED", details: { personal: 1 } });
    await turnOn("cloud", true);
    // The workspace serves alice too (bound on a channel): her personal record is still not embedded remotely.
    const backfill = createMemoryVectorBackfill({
      memory: repositories.memory,
      embeddings: runtime.embeddings,
      workspaces: () => [{ workspaceId: "default", principalId: "operator", principalIds: ["operator", "alice"] }],
      memorySettings,
      now: () => new Date(),
      log: () => {},
    });
    await backfill.tick();
    const texts = () => sent.flatMap((request) => request.texts);
    expect(texts()).toEqual(["Lives in Lisbon with a dog"]);
    const doctor = await memoryVectorsDoctor({
      workspaceId: "default",
      principalId: "operator",
      principalIds: ["operator", "alice"],
      settings: await memorySettings("default"),
      memory: repositories.memory,
      embeddings: runtime.embeddings,
      now: nowTimestamp(),
    });
    expect(doctor).toMatchObject({ personal: true, indexed: 1, missing: 0 });
    // Her recall ranks her personal records by their words alone; the operator's by meaning too.
    const queryVectors: unknown[] = [];
    const settings = await memorySettings("default");
    const deps = {
      memorySettings: async () => settings,
      embeddings: {
        role: async () => ({ target: { connectionId: "cloud", model: "embed-1" }, locality: "remote" as const }),
        embed: async () => ({
          target: { connectionId: "cloud", model: "embed-1" },
          locality: "remote" as const,
          vectors: [Float32Array.from([1, 0])],
          usage: {} as never,
        }),
      },
      chatIsLocal: async () => false,
      workspacePrincipal: () => "operator",
    };
    const search = hybridSearch(async (input) => {
      queryVectors.push(input.queryVector);
      return { hits: [], coverage: "complete" };
    }, deps);
    await search({ actor: { ...TURN, principalId: "alice" }, query: "porto", semantic: "where does she live?" });
    await search({ actor: TURN, query: "lisbon", semantic: "where do I live?" });
    expect(queryVectors).toEqual([expect.objectContaining({ personal: false }), expect.not.objectContaining({ personal: false })]);
    // Her personal draft is never embedded for the near match; the operator's is.
    const nearMatch = hybridNearMatch(deps);
    const draft = (principalId: string) => ({
      actor: { ...TURN, principalId },
      scope: { kind: "personal", principalId } as const,
      kind: "fact" as const,
      body: "Lives near the river",
      nearMatch: "drop" as const,
    });
    expect(await nearMatch(draft("alice"))).not.toHaveProperty("nearMatchVector");
    expect(await nearMatch(draft("operator"))).toHaveProperty("nearMatchVector");
    // A local connection embeds everyone's, as before.
    await models.setRoleBinding({ workspaceId: "default", role: "embedding", target: { connectionId: "ollama", model: "embed-local" } });
    await turnOn();
    await backfill.tick();
    expect(sent.filter((request) => request.connectionId === "ollama").flatMap((request) => request.texts)).toEqual(
      expect.arrayContaining(["Lives in Lisbon with a dog", "Alice lives in Porto with a cat"]),
    );
    expect(texts().filter((text) => text === "Alice lives in Porto with a cat")).toHaveLength(1);
  });

  it("a local embedding connection embeds personal memory without its opt-in: nothing leaves the machine", async () => {
    const { runtime, models, sent, turnOn, backfill, memorySettings } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Lives in Lisbon with a dog" });
    await models.setRoleBinding({ workspaceId: "default", role: "embedding", target: { connectionId: "ollama", model: "embed-local" } });
    await turnOn();
    expect(await memorySettings("default")).not.toHaveProperty("retrievalPersonal");
    await backfill.tick();
    expect(sent.filter((request) => request.runId === "memory-embeddings").flatMap((request) => request.texts)).toEqual([
      "Lives in Lisbon with a dog",
    ]);
  });

  it("rebinding the embedding role to a remote connection sends nothing there, records or queries, until its disclosure is accepted", async () => {
    const { runtime, models, repositories, sent, backfill, turnOn } = await owner();
    await runtime.memory.remember({ actor: OPERATOR, scope: OWN, kind: "fact", body: "Based in Lisbon" });
    await models.setRoleBinding({ workspaceId: "default", role: "embedding", target: { connectionId: "ollama", model: "embed-local" } });
    // A local connection needs no disclosure.
    await turnOn();
    await backfill.tick();
    expect(sent.map((request) => request.model)).toEqual(["embed-local"]);
    await models.setRoleBinding({ workspaceId: "default", role: "embedding", target: { connectionId: "cloud", model: "embed-1" } });
    await backfill.tick();
    const answer = await runtime.memory.search({ actor: TURN, query: "lisbon", match: "any", semantic: "where do I live?" });
    expect(answer.coverage).toBe("partial");
    expect(answer.reducedReason).toMatch(/cloud has no accepted disclosure/);
    // A client cannot name the accepted connection itself.
    await applyWorkspaceSetting(repositories.workspaceSettings, {
      workspaceId: "default",
      key: "memory",
      value: JSON.stringify({ retrieval: "hybrid", retrievalConnection: "cloud" }),
      actor: "test",
      now: nowTimestamp(),
    });
    expect((await repositories.workspaceSettings.get("default")).settings.memory).toEqual({ retrieval: "hybrid" });
    await backfill.tick();
    expect(sent.map((request) => request.model)).toEqual(["embed-local"]);
    // Accepted again (`--yes`): now the record and the query go there.
    await turnOn("cloud");
    await backfill.tick();
    await runtime.memory.search({ actor: TURN, query: "lisbon", match: "any", semantic: "where do I live?" });
    expect(sent.map((request) => request.model)).toEqual(["embed-local", "embed-1", "embed-1"]);
  });
});

describe("the recall deadline", () => {
  it("past 1.5 s the query is abandoned and recall is words only, partial", async () => {
    const settings: EffectiveMemorySettings = { ...effectiveMemorySettings(undefined), retrieval: "hybrid", retrievalConnection: "cloud" };
    const embeddings: Pick<EmbeddingRoleService, "role" | "embed"> = {
      role: async () => ({ target: { connectionId: "cloud", model: "embed-1" }, locality: "remote" }),
      embed: (call) =>
        new Promise((_resolve, reject) => {
          call.signal.addEventListener("abort", () => reject(new TaviError("ABORTED", "The operation was aborted due to timeout")));
        }),
    };
    const times = new MemoryRecallTimes();
    let lexicalCalls = 0;
    const search = hybridSearch(
      async (input) => {
        lexicalCalls += 1;
        expect(input.queryVector).toBeUndefined();
        return { hits: [], coverage: "complete" };
      },
      { memorySettings: async () => settings, embeddings, chatIsLocal: async () => false, times, deadlineMs: 30 },
    );
    const started = Date.now();
    const answer = await search({ actor: TURN, query: "lisbon", semantic: "where do I live?" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(answer).toMatchObject({ coverage: "partial", reducedReason: "the embedding call took too long" });
    expect(lexicalCalls).toBe(1);
    expect(times.count).toBe(1);
  });

  it("the deadline covers the lookups before the call: past it, no embedding call is made", async () => {
    let embedded = 0;
    const search = hybridSearch(async () => ({ hits: [], coverage: "complete" }), {
      memorySettings: async () => ({ ...effectiveMemorySettings(undefined), retrieval: "hybrid", retrievalConnection: "cloud" }),
      embeddings: {
        role: async () => ({ target: { connectionId: "cloud", model: "embed-1" }, locality: "remote" }),
        embed: async () => {
          embedded += 1;
          return {
            target: { connectionId: "cloud", model: "embed-1" },
            locality: "remote",
            vectors: [Float32Array.from([1, 0])],
            usage: {} as never,
          };
        },
      },
      chatIsLocal: () => new Promise((resolve) => setTimeout(() => resolve(false), 60)),
      deadlineMs: 20,
    });
    expect(await search({ actor: TURN, query: "lisbon", semantic: "where do I live?" })).toMatchObject({
      coverage: "partial",
      reducedReason: "the embedding call took too long",
    });
    expect(embedded).toBe(0);
  });

  it("a turn's text is embedded once however many model calls the turn makes, a failure too; another turn embeds its own", async () => {
    let embedded = 0;
    let failing = false;
    const vectors: unknown[] = [];
    const search = hybridSearch(
      async (input) => {
        vectors.push(input.queryVector);
        return { hits: [], coverage: "complete" };
      },
      {
        memorySettings: async () => ({ ...effectiveMemorySettings(undefined), retrieval: "hybrid", retrievalConnection: "cloud" }),
        embeddings: {
          role: async () => ({ target: { connectionId: "cloud", model: "embed-1" }, locality: "remote" }),
          embed: async () => {
            embedded += 1;
            if (failing) throw new TaviError("MODEL_FAILED", "down");
            return {
              target: { connectionId: "cloud", model: "embed-1" },
              locality: "remote",
              vectors: [Float32Array.from([1, 0])],
              usage: {} as never,
            };
          },
        },
        chatIsLocal: async () => false,
      },
    );
    // Three model calls of one turn (the tool loop's steps): one embedding call, the same vector each time.
    for (let step = 0; step < 3; step += 1) await search({ actor: TURN, query: "lisbon", semantic: "where do I live?" });
    expect(embedded).toBe(1);
    expect(vectors).toEqual(Array.from({ length: 3 }, () => ({ modelKey: "cloud/embed-1", vector: [1, 0], personal: false })));
    // A failed embed is remembered for its turn too: words only, without calling again.
    failing = true;
    const other = { ...TURN, runId: "chat-9", chatTaskId: "chat-9" };
    for (let step = 0; step < 3; step += 1)
      expect((await search({ actor: other, query: "lisbon", semantic: "where do I live?" })).coverage).toBe("partial");
    expect(embedded).toBe(2);
  });

  it("memory invariant 14: a heartbeat check's own memory.search stays lexical, its words never embedded", async () => {
    let embedded = 0;
    const search = hybridSearch(async (input) => ({ hits: [], coverage: input.queryVector === undefined ? "complete" : "partial" }), {
      memorySettings: async () => ({ ...effectiveMemorySettings(undefined), retrieval: "hybrid", retrievalConnection: "cloud" }),
      embeddings: {
        role: async () => ({ target: { connectionId: "cloud", model: "embed-1" }, locality: "remote" }),
        embed: async () => {
          embedded += 1;
          return {
            target: { connectionId: "cloud", model: "embed-1" },
            locality: "remote",
            vectors: [Float32Array.from([1, 0])],
            usage: {} as never,
          };
        },
      },
      chatIsLocal: async () => false,
      heartbeatTask: async (taskId) => taskId === "heartbeat-tick",
    });
    expect(
      await search({
        actor: { ...TURN, runId: "heartbeat-tick", chatTaskId: "heartbeat-tick" },
        query: "acme",
        semantic: "ACME invoice from Jane",
      }),
    ).toEqual({ hits: [], coverage: "complete" });
    expect(embedded).toBe(0);
    await search({ actor: TURN, query: "acme", semantic: "ACME invoices?" });
    expect(embedded).toBe(1);
  });

  it("a caller's own queryVector never reaches the worker: only the wrapper sets it", async () => {
    let seen: unknown;
    const search = hybridSearch(
      async (input) => {
        seen = input.queryVector;
        return { hits: [], coverage: "complete" };
      },
      {
        memorySettings: async () => effectiveMemorySettings(undefined),
        embeddings: {
          role: async () => {
            throw new Error("unused");
          },
          embed: async () => {
            throw new Error("unused");
          },
        },
        chatIsLocal: async () => false,
      },
    );
    await search({ actor: TURN, query: "lisbon", queryVector: { modelKey: "x/y", vector: [1, 0] } });
    expect(seen).toBeUndefined();
  });
});

describe("the vector backfill's bounds", () => {
  /** A fake backlog of `count` texts and an embedder that records each call; `failing` says whether a call fails. */
  function fake(count: number, failing: boolean | ((texts: readonly string[], call: number) => boolean) = false) {
    const pending = new Map(Array.from({ length: count }, (_, index) => [`rev-${index}`, `text ${index}`]));
    const failures = new Map<string, number>();
    const calls: number[] = [];
    let clock = Date.parse("2026-10-11T09:00:00.000Z");
    const backfill = createMemoryVectorBackfill({
      memory: {
        vectorBacklog: async (input) =>
          [...pending]
            .filter(
              ([id]) => (failures.get(id) ?? 0) < input.maxFailures && (input.revisionIds === undefined || input.revisionIds.includes(id)),
            )
            .slice(0, input.limit)
            .map(([revisionId, text]) => ({ revisionId, text })),
        putVectors: async (input) => {
          for (const entry of input.vectors) pending.delete(entry.revisionId);
          return input.vectors.length;
        },
        recordVectorFailures: async (input) => {
          for (const id of input.revisionIds) failures.set(id, (failures.get(id) ?? 0) + 1);
        },
        dropVectorCache: async () => {},
        pruneVectors: async () => 0,
      },
      embeddings: {
        role: async () => ({ target: { connectionId: "cloud", model: "embed-1" }, locality: "remote" }),
        embed: async (call) => {
          calls.push(call.texts.length);
          if (typeof failing === "function" ? failing(call.texts, calls.length - 1) : failing) throw new TaviError("MODEL_FAILED", "down");
          return {
            target: { connectionId: "cloud", model: "embed-1" },
            locality: "remote",
            vectors: call.texts.map(() => Float32Array.from([1, 0])),
            usage: {} as never,
          };
        },
      },
      workspaces: () => [{ workspaceId: "default", principalId: "operator", principalIds: ["operator"] }],
      memorySettings: async () => ({ ...effectiveMemorySettings(undefined), retrieval: "hybrid", retrievalConnection: "cloud" }),
      now: () => new Date(clock),
      log: () => {},
    });
    return { backfill, pending, failures, calls, advance: (ms: number) => void (clock += ms) };
  }

  it("embeds at most 64 texts a call and 600 a minute across the owner", async () => {
    const { backfill, pending, calls, advance } = fake(650);
    await backfill.tick();
    expect(Math.max(...calls)).toBeLessThanOrEqual(64);
    expect(calls.reduce((total, texts) => total + texts, 0)).toBe(MEMORY_VECTOR_PER_MINUTE);
    expect(pending.size).toBe(50);
    // The same minute: nothing more.
    advance(30_000);
    await backfill.tick();
    expect(pending.size).toBe(50);
    advance(31_000);
    await backfill.tick();
    expect(pending.size).toBe(0);
  });

  it("memory invariant 24: a failing embedding call is bounded — no retry within a tick, an hour's back-off after it, and its texts retried one by one", async () => {
    const { backfill, calls, failures, advance } = fake(5, true);
    for (let tick = 0; tick < 5; tick += 1) {
      await backfill.tick();
      advance(60_000);
    }
    // One call, then nothing for the hour.
    expect(calls).toEqual([5]);
    expect(failures.size).toBe(0);
    // Each hour after, one text alone; a lasting outage fails every call, so no failure counts against a text.
    for (let hour = 0; hour < 5; hour += 1) {
      advance(MEMORY_VECTOR_BACKOFF_MS);
      await backfill.tick();
    }
    expect(calls).toEqual([5, 1, 1, 1, 1, 1]);
    expect(failures.size).toBe(0);
  });

  it("memory invariant 24: a text that fails alone three times is skipped until the model changes; the batch's good texts are embedded", async () => {
    const { backfill, pending, failures, calls, advance } = fake(5, (texts) => texts.includes("text 2"));
    for (let hour = 0; hour < 5; hour += 1) {
      await backfill.tick();
      advance(MEMORY_VECTOR_BACKOFF_MS);
    }
    // The batch fails; then 0, 1 and the bad 2 alone; then 3, 4 and 2; then 2; then the backlog holds nothing due.
    expect(calls).toEqual([5, 1, 1, 1, 1, 1, 1, 1]);
    expect([...pending.keys()]).toEqual(["rev-2"]);
    expect(Object.fromEntries(failures)).toEqual({ "rev-2": MEMORY_VECTOR_FAILURES_MAX });
  });

  it("memory invariant 24: a transient outage over three ticks marks no good text failed", async () => {
    const { backfill, pending, failures, calls, advance } = fake(70, (_texts, call) => call < 3);
    for (let tick = 0; tick < 3; tick += 1) {
      await backfill.tick();
      advance(60_000);
    }
    expect(calls).toEqual([64]);
    advance(MEMORY_VECTOR_BACKOFF_MS);
    await backfill.tick();
    // The first retries fail too (the outage outlasts the hour): one text, once.
    expect(calls).toEqual([64, 1]);
    advance(MEMORY_VECTOR_BACKOFF_MS);
    await backfill.tick();
    advance(MEMORY_VECTOR_BACKOFF_MS);
    await backfill.tick();
    // Two texts failed alone while the service was down, and then embedded with every other: none counted.
    expect(failures.size).toBe(0);
    expect(pending.size).toBe(0);
  });

  it("memory invariant 24: a day-long outage fails out no good text; on recovery every text is embedded, and a bad one still fails out", async () => {
    let down = true;
    const { backfill, pending, failures, calls, advance } = fake(4, (texts) => down || texts.includes("text 3"));
    // 24 hours down: the batch, then one lone retry an hour, none of them counted.
    for (let hour = 0; hour < 24; hour += 1) {
      await backfill.tick();
      advance(MEMORY_VECTOR_BACKOFF_MS);
    }
    expect(calls.length).toBe(24);
    expect(failures.size).toBe(0);
    expect(pending.size).toBe(4);
    // Back up: the good texts are embedded; the bad one, failing alone after successes, counts each time.
    down = false;
    for (let hour = 0; hour < 6; hour += 1) {
      await backfill.tick();
      advance(MEMORY_VECTOR_BACKOFF_MS);
    }
    expect([...pending.keys()]).toEqual(["rev-3"]);
    expect(Object.fromEntries(failures)).toEqual({ "rev-3": MEMORY_VECTOR_FAILURES_MAX });
  });

  it("does nothing while memory is paused or recall is lexical", async () => {
    const calls: number[] = [];
    let dropped = 0;
    for (const settings of [
      { ...effectiveMemorySettings(undefined), retrieval: "hybrid" as const, retrievalConnection: "cloud", enabled: false },
      effectiveMemorySettings(undefined),
    ]) {
      const backfill = createMemoryVectorBackfill({
        memory: {
          vectorBacklog: async () => [{ revisionId: "r", text: "t" }],
          putVectors: async () => 1,
          recordVectorFailures: async () => {},
          dropVectorCache: async () => void (dropped += 1),
          pruneVectors: async () => 0,
        },
        embeddings: {
          role: async () => ({ target: { connectionId: "cloud", model: "embed-1" }, locality: "remote" }),
          embed: async (call) => (
            calls.push(call.texts.length),
            { target: { connectionId: "cloud", model: "embed-1" }, locality: "remote", vectors: [], usage: {} as never }
          ),
        },
        workspaces: () => [{ workspaceId: "default", principalId: "operator", principalIds: ["operator"] }],
        memorySettings: async () => settings,
        now: () => new Date(),
        log: () => {},
      });
      await backfill.tick();
    }
    expect(calls).toEqual([]);
    expect(dropped).toBe(1);
  });
});
