import { afterEach, describe, expect, it } from "vitest";
import {
  TaviError,
  estimateModelCost,
  type InvocationContext,
  type ModelPort,
  type ModelPriceSheet,
  type ModelRequest,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import { ModelAccounting, accountedModelPort, languageModelPort } from "../src/index.js";
import { DatabaseClient } from "../src/persistence/client.js";

const stores: DatabaseClient[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
const at = "2026-09-25T00:00:00.000Z";
const price: ModelPriceSheet = {
  revision: "price-1",
  connectionId: "main",
  model: "m",
  effectiveAt: at,
  currency: "USD",
  input: 2,
  cacheRead: 0.2,
  cacheWrite: 3,
  output: 10,
};
const request: ModelRequest = {
  connectionId: "main",
  model: "m",
  runId: "task-1",
  attemptId: "attempt-1",
  attemptNumber: 1,
  messages: [{ id: "msg-1", role: "user", text: "hello", createdAt: at }],
  tools: [],
};
const streamOptions = () => ({ signal: new AbortController().signal, onEvent: () => {} });
async function fixture() {
  const store = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  return { store, ledger: new ModelAccounting(store.asPort()) };
}

describe("model cost estimates", () => {
  it("prices disjoint input categories and includes reasoning in total output only once", () => {
    const usage = {
      inputTokens: 100,
      inputNoCacheTokens: 20,
      inputCacheReadTokens: 70,
      inputCacheWriteTokens: 10,
      outputTokens: 10,
      outputReasoningTokens: 8,
    };
    expect(estimateModelCost(usage, price)).toBeCloseTo(0.000184);
    expect(estimateModelCost(usage, { ...price, reasoning: 20 })).toBeCloseTo(0.000264);
  });
  it("does not turn partial, inconsistent or absent billing dimensions into savings", () => {
    expect(estimateModelCost({}, price)).toBeUndefined();
    expect(estimateModelCost({ inputTokens: 100, outputTokens: 10 }, price)).toBeUndefined();
    expect(
      estimateModelCost(
        { inputTokens: 100, outputTokens: 10, inputNoCacheTokens: 40, inputCacheReadTokens: 70, inputCacheWriteTokens: 10 },
        price,
      ),
    ).toBeUndefined();
    expect(
      estimateModelCost({ inputTokens: 0, outputTokens: 10, outputReasoningTokens: 11 }, { ...price, cacheRead: 2, cacheWrite: 2 }),
    ).toBeUndefined();
    expect(estimateModelCost({ inputTokens: 100, outputTokens: 10 }, { ...price, cacheRead: 2, cacheWrite: 2 })).toBeCloseTo(0.0003);
  });
});

describe("durable provider attempts", () => {
  it("selects the same effective rate across valid timestamp precisions", async () => {
    const { ledger } = await fixture();
    await ledger.putPrice({ ...price, revision: "earlier", effectiveAt: "2026-09-24T23:59:59.999Z" });
    await ledger.putPrice({ ...price, effectiveAt: "2026-09-25T00:00:00Z" });
    await ledger.putPrice(price);
    expect((await ledger.price("main", "m", "2026-09-24T23:59:59.999Z"))?.revision).toBe("earlier");
    expect((await ledger.price("main", "m", at))?.revision).toBe("price-1");
    expect((await ledger.price("main", "m", "2026-09-25T00:00:00Z"))?.revision).toBe("price-1");
  });
  it("accounts summaries and separate failover attempts once despite usage events", async () => {
    const { ledger } = await fixture();
    await ledger.putPrice({ ...price, cacheRead: 2, cacheWrite: 2 });
    let calls = 0;
    const models: ModelPort = {
      async stream(input, options) {
        calls++;
        const usage = { inputTokens: 100, outputTokens: 10 };
        options.onEvent({ type: "model.result", attemptId: input.attemptId, connectionId: input.connectionId, model: input.model, usage });
        return { attemptId: input.attemptId, status: calls === 1 ? "failed" : "completed", text: "", toolCalls: [], usage };
      },
    };
    const port = accountedModelPort(models, ledger, { ownerSession: "owner", now: () => at });
    await port.stream(request, streamOptions());
    await port.stream({ ...request, connectionId: "backup", attemptId: "attempt-2" }, streamOptions());
    await port.stream({ ...request, purpose: "summary", attemptId: "summary-1" }, streamOptions());
    const rows = await ledger.list(request.runId);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.estimatedUsd !== undefined)).toHaveLength(2);
    expect(rows.find((row) => row.purpose === "summary")).toMatchObject({
      state: "completed",
      estimatedUsd: 0.0003,
      priceRevision: "price-1",
    });
    expect(rows.find((row) => row.connectionId === "backup")?.estimatedUsd).toBeUndefined();
  });
  it("tells an observer how each call settled, and an observer that throws changes nothing", async () => {
    const { ledger } = await fixture();
    const seen: unknown[] = [];
    const failing: ModelPort = {
      async stream(input) {
        return {
          attemptId: input.attemptId,
          status: "failed",
          text: "",
          toolCalls: [],
          usage: {},
          error: { code: "auth", retryable: false, message: "refused" },
        };
      },
    };
    await accountedModelPort(failing, ledger, { ownerSession: "owner", now: () => at, onSettled: (settled) => seen.push(settled) }).stream(
      request,
      streamOptions(),
    );
    const thrown = new TaviError("MODEL_FAILED", "lost", { details: { code: "quota_exceeded" } });
    await expect(
      accountedModelPort(
        {
          async stream() {
            throw thrown;
          },
        },
        ledger,
        { ownerSession: "owner", now: () => at, onSettled: (settled) => seen.push(settled) },
      ).stream({ ...request, attemptId: "attempt-2" }, streamOptions()),
    ).rejects.toBe(thrown);
    expect(seen).toEqual([
      // A rejected key is what the failure says of the work; a billing limit says nothing a later try changes.
      {
        connectionId: "main",
        model: "m",
        purpose: "generation",
        context: undefined,
        status: "failed",
        errorCode: "auth",
        failure: "credentials",
      },
      { connectionId: "main", model: "m", purpose: "generation", context: undefined, status: "failed", errorCode: "quota_exceeded" },
    ]);
    const working: ModelPort = {
      async stream(input) {
        return { attemptId: input.attemptId, status: "completed", text: "ok", toolCalls: [], usage: {} };
      },
    };
    const outcome = await accountedModelPort(working, ledger, {
      ownerSession: "owner",
      now: () => at,
      onSettled: () => {
        throw new Error("observer broke");
      },
    }).stream({ ...request, attemptId: "attempt-3" }, streamOptions());
    expect(outcome).toMatchObject({ status: "completed", text: "ok" });
    // What a call used is told with it, so a scheduled run's tokens can be counted as they are spent.
    const counted: unknown[] = [];
    await accountedModelPort(
      {
        async stream(input) {
          return {
            attemptId: input.attemptId,
            status: "completed",
            text: "ok",
            toolCalls: [],
            usage: { inputTokens: 40, outputTokens: 2 },
          };
        },
      },
      ledger,
      { ownerSession: "owner", now: () => at, onSettled: (settled) => counted.push(settled.usage) },
    ).stream({ ...request, attemptId: "attempt-4" }, streamOptions());
    expect(counted).toEqual([{ inputTokens: 40, outputTokens: 2 }]);
  });
  it("retains unknown cost after thrown, canceled or owner-abandoned calls", async () => {
    const { ledger } = await fixture();
    const failure = new Error("transport lost");
    const throwing: ModelPort = {
      async stream() {
        throw failure;
      },
    };
    await expect(
      accountedModelPort(throwing, ledger, { ownerSession: "old", now: () => at }).stream(request, streamOptions()),
    ).rejects.toBe(failure);
    const aborted: ModelPort = {
      async stream(input) {
        return { attemptId: input.attemptId, status: "aborted", text: "", toolCalls: [], usage: {} };
      },
    };
    await accountedModelPort(aborted, ledger, { ownerSession: "old", now: () => at }).stream(
      { ...request, attemptId: "cancelled" },
      streamOptions(),
    );
    await ledger.begin({
      callId: "unfinished",
      runId: request.runId,
      attemptId: "pending",
      ownerSession: "old",
      connectionId: "main",
      model: "m",
      purpose: "generation",
      startedAt: at,
    });
    expect(await ledger.recoverPreviousOwner("new", at)).toBe(1);
    expect(await ledger.recoverPreviousOwner("new", at)).toBe(0);
    expect((await ledger.list(request.runId)).map((row) => row.state).sort()).toEqual(["aborted", "uncertain", "uncertain"]);
    expect((await ledger.list(request.runId)).every((row) => row.estimatedUsd === undefined)).toBe(true);
    // The check before each call reads only the attempts whose outcome is open.
    expect((await ledger.list(request.runId, { states: ["started", "uncertain"] })).map((row) => row.state)).toEqual([
      "uncertain",
      "uncertain",
    ]);
    expect((await ledger.list(request.runId, { states: ["aborted"] })).map((row) => row.attemptId)).toEqual(["cancelled"]);
    expect(await ledger.list(request.runId, { states: [] })).toEqual([]);
    await expect((async () => await ledger.finish("unfinished", "completed", { inputTokens: 0, outputTokens: 0 }, at))()).rejects.toThrow(
      "no longer pending",
    );
  });
  it("pins immutable dated rates at call start and preserves records across service restart", async () => {
    const { ledger, store } = await fixture();
    await ledger.putPrice({ ...price, cacheRead: 2, cacheWrite: 2 });
    await expect((async () => await ledger.putPrice({ ...price, input: 999 }))()).rejects.toThrow("immutable");
    expect(await ledger.price("main", "m", "2026-09-24T00:00:00.000Z")).toBeUndefined();
    const models: ModelPort = {
      async stream(input) {
        await ledger.putPrice({
          ...price,
          revision: "price-2",
          input: 100,
          cacheRead: 100,
          cacheWrite: 100,
          effectiveAt: "2026-09-25T01:00:00.000Z",
        });
        return { attemptId: input.attemptId, status: "completed", text: "", toolCalls: [], usage: { inputTokens: 100, outputTokens: 10 } };
      },
    };
    await accountedModelPort(models, ledger, { ownerSession: "owner", now: () => at }).stream(request, streamOptions());
    const restored = new ModelAccounting(store.asPort());
    expect((await restored.list(request.runId))[0]).toMatchObject({ priceRevision: "price-1", estimatedUsd: 0.0003 });
    expect(await restored.deleteRun(request.runId)).toBe(1);
  });
});

describe("model execution binding", () => {
  it("records the frozen operation and refuses missing scope, a changed authorization, and duplicate attempts", async () => {
    const { ledger } = await fixture();
    const context = { workspaceId: "ws", principalId: "owner", runId: request.runId, caller: "summary" };
    let calls = 0;
    const models: ModelPort = {
      async stream(input) {
        calls++;
        return { attemptId: input.attemptId, status: "completed", text: "ok", toolCalls: [], usage: {} };
      },
    };
    const { scopedProvider } = await import("../src/provider-execution.js");
    const execution = {
      ledger,
      ownerSession: "owner",
      implementationHash: "a".repeat(64),
      signal: new AbortController().signal,
      actsIn: (_workspaceId: string, principalId: string) => principalId === "owner",
    };
    const resolved = scopedProvider(
      execution,
      context,
      { kind: "model", instanceId: "account", accountId: "ref", endpoint: "https://provider.example", configRevision: "b".repeat(64) },
      models,
    );
    const port = accountedModelPort(models, ledger, { ownerSession: "owner", now: () => at, resolve: async () => resolved });
    await expect(port.stream(request, streamOptions())).rejects.toThrow(/authenticated run context/);
    await expect(port.stream(request, { ...streamOptions(), context, expectedBindingHash: "c".repeat(64) })).rejects.toThrow(
      /authorization/,
    );
    expect(await ledger.list(request.runId)).toHaveLength(0);
    await port.stream(request, { ...streamOptions(), context, expectedBindingHash: resolved.bindingHash });
    await expect(port.stream(request, { ...streamOptions(), context })).rejects.toThrow(/already been reserved/);
    expect(calls).toBe(1);
    const rows = await ledger.list(request.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operation).toMatchObject({
      version: 1,
      binding: { accountId: "ref", workspaceId: "ws", principalId: "owner" },
      caller: "summary",
      accountingRef: rows[0]?.callId,
    });
    expect(await ledger.operations(request.runId)).toMatchObject([{ state: "completed", operation: rows[0]?.operation }]);
  });
  it("refuses to resend an attempt of unknown outcome through a reconfigured binding", async () => {
    const { ledger } = await fixture();
    const context = { workspaceId: "ws", principalId: "owner", runId: request.runId, caller: "task" };
    let calls = 0;
    const interrupted: ModelPort = {
      async stream() {
        calls++;
        throw new Error("owner crashed mid-call");
      },
    };
    const completing: ModelPort = {
      async stream(input) {
        calls++;
        return { attemptId: input.attemptId, status: "completed", text: "ok", toolCalls: [], usage: {} };
      },
    };
    const { scopedProvider } = await import("../src/provider-execution.js");
    const execution = {
      ledger,
      ownerSession: "owner",
      implementationHash: "a".repeat(64),
      signal: new AbortController().signal,
      actsIn: (_workspaceId: string, principalId: string) => principalId === "owner",
    };
    const binding = {
      kind: "model" as const,
      instanceId: "account",
      accountId: "ref",
      endpoint: "https://provider.example",
      configRevision: "b".repeat(64),
    };
    const original = scopedProvider(execution, context, binding, interrupted);
    await expect(
      accountedModelPort(interrupted, ledger, { ownerSession: "owner", now: () => at, resolve: async () => original }).stream(request, {
        ...streamOptions(),
        context,
      }),
    ).rejects.toThrow(/mid-call/);
    const rotated = scopedProvider(execution, context, { ...binding, configRevision: "d".repeat(64) }, completing);
    const resumed = accountedModelPort(completing, ledger, { ownerSession: "owner", now: () => at, resolve: async () => rotated });
    await expect(resumed.stream({ ...request, attemptId: "attempt-2" }, { ...streamOptions(), context })).rejects.toSatisfy(
      (error: unknown) => error instanceof TaviError && error.code === "NOT_AUTHORIZED" && /outcome is unknown/.test(error.message),
    );
    expect(calls).toBe(1);
    expect((await ledger.list(request.runId)).map((row) => row.state)).toEqual(["uncertain"]);
    const unchanged = scopedProvider(execution, context, binding, completing);
    await accountedModelPort(completing, ledger, { ownerSession: "owner", now: () => at, resolve: async () => unchanged }).stream(
      { ...request, attemptId: "attempt-3" },
      { ...streamOptions(), context },
    );
    expect(calls).toBe(2);
  });
  it("still refuses to resend an attempt of unknown outcome once its request was stripped", async () => {
    const { ledger } = await fixture();
    const context = { workspaceId: "ws", principalId: "owner", runId: request.runId, caller: "task" };
    const interrupted: ModelPort = {
      async stream() {
        throw new Error("owner crashed mid-call");
      },
    };
    const completing: ModelPort = {
      async stream(input) {
        return { attemptId: input.attemptId, status: "completed", text: "ok", toolCalls: [], usage: {} };
      },
    };
    const { scopedProvider } = await import("../src/provider-execution.js");
    const execution = {
      ledger,
      ownerSession: "owner",
      implementationHash: "a".repeat(64),
      signal: new AbortController().signal,
      actsIn: (_workspaceId: string, principalId: string) => principalId === "owner",
    };
    const binding = {
      kind: "model" as const,
      instanceId: "account",
      accountId: "ref",
      endpoint: "https://provider.example",
      configRevision: "b".repeat(64),
    };
    const seen: (InvocationContext | undefined)[] = [];
    const keptRequests = (context: InvocationContext | undefined) => {
      seen.push(context);
      return 0;
    };
    await expect(
      accountedModelPort(interrupted, ledger, {
        ownerSession: "owner",
        now: () => at,
        keptRequests,
        resolve: async () => scopedProvider(execution, context, binding, interrupted),
      }).stream(request, { ...streamOptions(), context }),
    ).rejects.toThrow(/mid-call/);
    const [unknown] = await ledger.list(request.runId, { states: ["started", "uncertain"] });
    expect(unknown).toMatchObject({
      state: "uncertain",
      operation: { bindingHash: expect.any(String) },
      requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(unknown?.request).toBeUndefined();
    expect(seen).toEqual([context]);
    const rotated = scopedProvider(execution, context, { ...binding, configRevision: "d".repeat(64) }, completing);
    await expect(
      accountedModelPort(completing, ledger, { ownerSession: "owner", now: () => at, keptRequests, resolve: async () => rotated }).stream(
        { ...request, attemptId: "attempt-2" },
        { ...streamOptions(), context },
      ),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof TaviError && error.code === "NOT_AUTHORIZED" && /outcome is unknown/.test(error.message),
    );
  });
  it("keeps no copy of a background memory call's request, only its usage, and leaves the run's kept requests alone", async () => {
    const { store, ledger } = await fixture();
    const models: ModelPort = {
      async stream(input) {
        return {
          attemptId: input.attemptId,
          status: "completed",
          text: "ok",
          toolCalls: [],
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      },
    };
    const port = accountedModelPort(models, ledger, { ownerSession: "owner", now: () => at });
    await port.stream(request, streamOptions());
    await port.stream({ ...request, purpose: "extraction", attemptId: "memory-review-1" }, { ...streamOptions(), keepRequest: false });
    const rows = await ledger.list(request.runId);
    expect(rows.find((row) => row.attemptId === "memory-review-1")).toMatchObject({
      state: "completed",
      purpose: "extraction",
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    expect(rows.find((row) => row.attemptId === "memory-review-1")?.request).toBeUndefined();
    // The chat's own call keeps its request as before.
    expect(rows.find((row) => row.attemptId === "attempt-1")?.request?.attemptId).toBe("attempt-1");
    // Doctor's spend line reads it by its attempt id, on the workspace's chats: usage only.
    await store.asPort().repositories.tasks.admit({
      workspaceId: "ws",
      principalId: "owner",
      operationKey: request.runId,
      kind: "start",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      origin: "ipc",
      prompt: { builtin: { text: "Built in", version: "v1" } },
      now: at,
      newTaskId: request.runId,
      newThreadId: "thread-1",
      newAdmissionId: "admission-1",
    });
    // A call still running is neither completed nor failed.
    await ledger.begin({
      callId: "running",
      runId: request.runId,
      attemptId: "memory-review-2",
      ownerSession: "owner",
      connectionId: "main",
      model: "m",
      purpose: "extraction",
      startedAt: at,
    });
    expect(
      await store.memoryCallSpend({ workspaceIds: ["ws"], since: at, purpose: "extraction", attemptPrefix: "memory-review-" }),
    ).toMatchObject({ calls: 2, failed: 0, inputTokens: 100, outputTokens: 10 });
    expect(
      await store.memoryCallSpend({ workspaceIds: ["other"], since: at, purpose: "extraction", attemptPrefix: "memory-review-" }),
    ).toEqual({ calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 });
    // Summed over the workspaces asked for, and by purpose: a `summary` call (the flush's) is not the review's.
    expect(
      await store.memoryCallSpend({ workspaceIds: ["other", "ws"], since: at, purpose: "extraction", attemptPrefix: "memory-review-" }),
    ).toMatchObject({ calls: 2 });
    expect(
      await store.memoryCallSpend({ workspaceIds: ["ws"], since: at, purpose: "summary", attemptPrefix: "memory-review-" }),
    ).toMatchObject({ calls: 0 });
    expect(
      await store.memoryCallSpend({
        workspaceIds: ["ws"],
        since: "2026-09-26T00:00:00.000Z",
        purpose: "extraction",
        attemptPrefix: "memory-review-",
      }),
    ).toEqual({ calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 });
  });
  it("settles a call with the default retention when the workspace's cannot be read", async () => {
    const { ledger } = await fixture();
    const models: ModelPort = {
      async stream(input) {
        return { attemptId: input.attemptId, status: "completed", text: "ok", toolCalls: [], usage: {} };
      },
    };
    const unreadable = accountedModelPort(models, ledger, {
      ownerSession: "owner",
      now: () => at,
      keptRequests: () => {
        throw new Error("settings unavailable");
      },
    });
    const outOfRange = accountedModelPort(models, ledger, { ownerSession: "owner", now: () => at, keptRequests: () => -3 });
    await unreadable.stream(request, streamOptions());
    await outOfRange.stream({ ...request, attemptId: "attempt-2" }, streamOptions());
    expect((await ledger.list(request.runId)).map((row) => [row.state, row.request?.attemptId]).sort()).toEqual([
      ["completed", "attempt-1"],
      ["completed", "attempt-2"],
    ]);
  });
  it("holds back only the turn that left an attempt unknown; the next message uses the new configuration", async () => {
    const { ledger } = await fixture();
    const turnOne = {
      workspaceId: "ws",
      principalId: "owner",
      runId: request.runId,
      caller: "task",
      turnStartedAt: "2026-09-24T23:59:00.000Z",
    };
    let calls = 0;
    const interrupted: ModelPort = {
      async stream() {
        calls++;
        throw new Error("owner crashed mid-call");
      },
    };
    const completing: ModelPort = {
      async stream(input) {
        calls++;
        return { attemptId: input.attemptId, status: "completed", text: "ok", toolCalls: [], usage: {} };
      },
    };
    const { scopedProvider } = await import("../src/provider-execution.js");
    const execution = {
      ledger,
      ownerSession: "owner",
      implementationHash: "a".repeat(64),
      signal: new AbortController().signal,
      actsIn: (_workspaceId: string, principalId: string) => principalId === "owner",
    };
    const binding = {
      kind: "model" as const,
      instanceId: "account",
      accountId: "ref",
      endpoint: "https://provider.example",
      configRevision: "b".repeat(64),
    };
    await expect(
      accountedModelPort(interrupted, ledger, {
        ownerSession: "owner",
        now: () => at,
        resolve: async () => scopedProvider(execution, turnOne, binding, interrupted),
      }).stream(request, { ...streamOptions(), context: turnOne }),
    ).rejects.toThrow(/mid-call/);
    const rotated = { ...binding, configRevision: "d".repeat(64) };
    // The same turn, resumed: still refused, and the remedy is the next message.
    await expect(
      accountedModelPort(completing, ledger, {
        ownerSession: "owner",
        now: () => at,
        resolve: async () => scopedProvider(execution, turnOne, rotated, completing),
      }).stream({ ...request, attemptId: "attempt-2" }, { ...streamOptions(), context: turnOne }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TaviError &&
        error.code === "NOT_AUTHORIZED" &&
        /next message/.test(error.message) &&
        !/new task/.test(error.message),
    );
    // The next message is a turn of its own: the earlier turn's unknown attempt is not its work to resend.
    const later = "2026-09-25T00:01:00.000Z";
    const turnTwo = { ...turnOne, turnStartedAt: later };
    await accountedModelPort(completing, ledger, {
      ownerSession: "owner",
      now: () => later,
      resolve: async () => scopedProvider(execution, turnTwo, rotated, completing),
    }).stream({ ...request, attemptId: "attempt-3" }, { ...streamOptions(), context: turnTwo });
    expect(calls).toBe(2);
    expect((await ledger.list(request.runId)).map((row) => row.state).sort()).toEqual(["completed", "uncertain"]);
  });
});

it("records public fetch attempts and leaves interrupted work uncertain on owner replacement", async () => {
  const { ledger } = await fixture();
  const { boundPublicFetch, resolveFetchBinding } = await import("../src/fetch-tool.js");
  const context = { workspaceId: "ws", principalId: "owner", runId: "fetch-run", caller: "routine" };
  let wire = 0;
  const options = {
    networkMode: "open_web" as const,
    resolve: async () => ["93.184.216.34"],
    execution: {
      ledger,
      ownerSession: "old",
      implementationHash: "a".repeat(64),
      signal: new AbortController().signal,
      actsIn: (_workspaceId: string, principalId: string) => principalId === "owner",
    },
    transport: {
      exchange: async () => {
        wire++;
        return {
          status: 200,
          headers: { "content-type": "text/plain" },
          chunks: {
            async *[Symbol.asyncIterator]() {
              yield new TextEncoder().encode("hello");
            },
          },
        };
      },
    },
  };
  const input = { url: "https://public.example/article?query=private-search" };
  const resolved = await resolveFetchBinding(options, input, context);
  await expect(boundPublicFetch(options, input, context, new AbortController().signal)).rejects.toThrow(/authorization binding/);
  expect(wire).toBe(0);
  let reservations = 0;
  expect(
    await boundPublicFetch(options, input, context, new AbortController().signal, resolved.bindingHash, async () => {
      reservations++;
    }),
  ).toMatchObject({ content: { body: { kind: "text", content: "hello" } }, receipt: { addressClass: "public" } });
  expect(wire).toBe(1);
  expect(reservations).toBe(1);
  const records = await ledger.operations(context.runId);
  expect(records).toMatchObject([
    { state: "completed", operation: { version: 1, caller: "routine", binding: { endpoint: "https://public.example", kind: "fetch" } } },
  ]);
  expect(JSON.stringify(records)).not.toContain("private-search");
  const operation = records[0]?.operation;
  if (operation === undefined) throw new Error("missing operation");
  await ledger.reserveOperation({ ...operation, attemptId: "abandoned" }, "old");
  expect(await ledger.recoverPreviousOwner("new", at)).toBe(1);
  expect((await ledger.operations(context.runId)).find((record) => record.operation.attemptId === "abandoned")?.state).toBe("uncertain");
});

it("persists an immutable validated request before dispatch and retains it through recovery", async () => {
  const { ledger } = await fixture();
  let observed = false;
  const input = structuredClone(request);
  const port = accountedModelPort(
    {
      async stream(frozen) {
        const rows = await ledger.list(request.runId);
        expect(rows[0]?.request).toEqual(request);
        expect(Object.isFrozen(frozen.messages)).toBe(true);
        observed = true;
        throw new Error("interrupted");
      },
    },
    ledger,
    { ownerSession: "owner", now: () => at },
  );
  await expect(port.stream(input, streamOptions())).rejects.toThrow("interrupted");
  const first = input.messages[0];
  if (first === undefined) throw new Error("missing fixture message");
  first.text = "changed";
  const rows = await ledger.list(request.runId);
  expect(observed).toBe(true);
  expect(rows[0]).toMatchObject({ state: "uncertain", request, usage: {} });
  expect(rows[0]?.estimatedUsd).toBeUndefined();
  expect(await ledger.recoverPreviousOwner("new-owner", at)).toBe(0);
  expect((await ledger.list(request.runId))[0]?.request).toEqual(request);
});

it("refuses non-JSON and oversized request snapshots before reservation", async () => {
  const { ledger } = await fixture();
  const models: ModelPort = {
    async stream() {
      throw new Error("must not dispatch");
    },
  };
  const port = accountedModelPort(models, ledger, { ownerSession: "owner", now: () => at });
  await expect(
    port.stream({ ...request, tools: [{ id: "t", name: "t", description: "", inputJsonSchema: { fn: () => {} } }] }, streamOptions()),
  ).rejects.toThrow(/plain JSON/);
  await expect(
    port.stream(
      {
        ...request,
        messages: Array.from({ length: 32 }, (_, index) => ({
          id: `m-${index}`,
          role: "user",
          text: "x".repeat(128 * 1024),
          createdAt: at,
        })),
      },
      streamOptions(),
    ),
  ).rejects.toThrow(/2 MiB/);
  await expect(
    port.stream({ ...request, tools: [{ id: "t", name: "t", description: "", inputJsonSchema: { fn: () => {} } }] }, streamOptions()),
  ).rejects.toSatisfy((error: unknown) => error instanceof TaviError && error.code === "INVALID_INPUT");
  expect(await ledger.list(request.runId)).toEqual([]);
});

it("finishes a refusal raised before dispatch as failed rather than uncertain", async () => {
  const { ledger } = await fixture();
  const port = accountedModelPort(
    languageModelPort({
      listModels: () => [],
      resolveModel: async (provider, id) => ({ provider, id, name: id }),
      prepareCall: async () => {
        throw new Error("must not prepare");
      },
    }),
    ledger,
    { ownerSession: "owner", now: () => at },
  );
  // A tool whose schema is not an object is refused while the request is built, before any provider is asked.
  await expect(
    port.stream(
      { ...request, tools: [{ id: "fixture.echo", name: "fixture_echo", description: "echo", inputJsonSchema: [] as never }] },
      streamOptions(),
    ),
  ).rejects.toThrow(/JSON schema object/);
  const rows = await ledger.list(request.runId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "failed", usage: {} });
});

it("records the turn step and a hash of the system text at begin, kept after the request is stripped", async () => {
  const { ledger } = await fixture();
  const ok: ModelPort = {
    async stream(sent) {
      return {
        status: "completed",
        attemptId: sent.attemptId,
        text: "ok",
        toolCalls: [],
        usage: { inputTokens: 10, inputCacheReadTokens: 4 },
      };
    },
  };
  const port = accountedModelPort(ok, ledger, { ownerSession: "owner", now: () => at, keptRequests: () => 0 });
  const system = (text: string, attemptId: string, step?: number): ModelRequest => ({
    ...request,
    attemptId,
    ...(step === undefined ? {} : { step }),
    messages: [
      { id: `sys-${attemptId}`, role: "system", text, createdAt: at },
      { id: `sys2-${attemptId}`, role: "system", text: "  ", createdAt: at },
      ...request.messages,
    ],
  });
  await port.stream(system("  Be brief.\n", "a-1", 1), streamOptions());
  await port.stream(system("Be brief.", "a-2", 2), streamOptions());
  await port.stream(system("Be brief. Memory: Lisbon.", "a-3"), streamOptions());
  // One instant for every call, so the ledger's order is its random call ids': sort by attempt.
  const rows = [...(await ledger.list(request.runId))].sort((a, b) => a.attemptId.localeCompare(b.attemptId));
  expect(rows.map((row) => row.request)).toEqual([undefined, undefined, undefined]);
  const expected = sha256Hex("Be brief.").slice(0, 16);
  expect(rows.map((row) => [row.step, row.systemHash])).toEqual([
    [1, expected],
    [2, expected],
    [undefined, expect.stringMatching(/^[0-9a-f]{16}$/)],
  ]);
  expect(rows[2]?.systemHash).not.toBe(expected);
  // A router-style attempt without a request carries neither, whatever its caller supplies.
  await ledger.begin({
    callId: "router-call",
    runId: request.runId,
    attemptId: "router-call",
    ownerSession: "owner",
    connectionId: "main",
    model: "m",
    purpose: "router",
    startedAt: at,
    systemHash: "ffffffffffffffff",
    step: 9,
  });
  expect(await ledger.get("router-call")).not.toHaveProperty("systemHash");
  expect(await ledger.get("router-call")).not.toHaveProperty("step");
});

it("records a hash of the tool descriptors and the caller's site at begin, and never takes either from the caller's fields", async () => {
  const { ledger } = await fixture();
  const ok: ModelPort = {
    async stream(sent) {
      return { status: "completed", attemptId: sent.attemptId, text: "ok", toolCalls: [], usage: { inputTokens: 1 } };
    },
  };
  const port = accountedModelPort(ok, ledger, { ownerSession: "owner", now: () => at, keptRequests: () => 0 });
  const tool = { id: "fs.read", name: "fs_read", description: "Read a file", inputJsonSchema: { type: "object" } };
  await port.stream({ ...request, attemptId: "t-1", tools: [tool] }, { ...streamOptions(), site: "chat-step1" });
  await port.stream({ ...request, attemptId: "t-2", tools: [tool] }, streamOptions());
  await port.stream({ ...request, attemptId: "t-3", tools: [{ ...tool, description: "Read a text file" }] }, streamOptions());
  const rows = [...(await ledger.list(request.runId))].sort((a, b) => a.attemptId.localeCompare(b.attemptId));
  expect(rows.map((row) => row.site)).toEqual(["chat-step1", undefined, undefined]);
  expect(rows[0]?.toolsHash).toMatch(/^[0-9a-f]{16}$/);
  expect(rows[1]?.toolsHash).toBe(rows[0]?.toolsHash);
  expect(rows[2]?.toolsHash).not.toBe(rows[0]?.toolsHash);
  // The site rides beside the request, so the request's digest does not depend on it.
  const { ledger: other } = await fixture();
  const otherPort = accountedModelPort(ok, other, { ownerSession: "owner", now: () => at, keptRequests: () => 0 });
  await otherPort.stream({ ...request, attemptId: "t-1", tools: [tool] }, streamOptions());
  const withSite = (await ledger.list(request.runId)).find((row) => row.attemptId === "t-1");
  const withoutSite = (await other.list(request.runId)).find((row) => row.attemptId === "t-1");
  expect(withSite?.site).toBe("chat-step1");
  expect(withoutSite?.site).toBeUndefined();
  expect(withSite?.requestSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(withSite?.requestSha256).toBe(withoutSite?.requestSha256);
  await ledger.begin({
    callId: "router-tools",
    runId: request.runId,
    attemptId: "router-tools",
    ownerSession: "owner",
    connectionId: "main",
    model: "m",
    purpose: "router",
    startedAt: at,
    toolsHash: "ffffffffffffffff",
  });
  expect(await ledger.get("router-tools")).not.toHaveProperty("toolsHash");
});

describe("the embedding call", () => {
  const embedRequest = { connectionId: "main", model: "m", runId: "task-1", attemptId: "embed-1", texts: ["I live in Lisbon"] };
  const embedding: ModelPort = {
    async stream(input) {
      return { attemptId: input.attemptId, status: "completed", text: "", toolCalls: [], usage: {} };
    },
    async embed(input) {
      return {
        status: "completed",
        attemptId: input.attemptId,
        vectors: input.texts.map(() => Float32Array.from([1, 0])),
        usage: {
          inputTokens: 1_000,
          inputNoCacheTokens: 1_000,
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 0,
          outputTokens: 0,
          totalTokens: 1_000,
        },
      };
    },
  };
  it("records an attempt with purpose embedding, its usage and never its texts, priced when a sheet exists", async () => {
    const { ledger } = await fixture();
    const port = accountedModelPort(embedding, ledger, { ownerSession: "owner", now: () => at });
    const unpriced = await port.embed!(embedRequest, { signal: new AbortController().signal });
    expect(unpriced.vectors.map((vector) => [...vector])).toEqual([[1, 0]]);
    await ledger.putPrice(price);
    await port.embed!({ ...embedRequest, attemptId: "embed-2" }, { signal: new AbortController().signal });
    // One instant for both calls, so the ledger's order is its random call ids': sort by attempt.
    const rows = [...(await ledger.list(request.runId))].sort((a, b) => a.attemptId.localeCompare(b.attemptId));
    expect(rows.map((row) => [row.attemptId, row.purpose, row.state])).toEqual([
      ["embed-1", "embedding", "completed"],
      ["embed-2", "embedding", "completed"],
    ]);
    expect(rows.every((row) => row.request === undefined && row.requestSha256 === undefined)).toBe(true);
    expect(rows[0]?.estimatedUsd).toBeUndefined();
    // 1,000 input tokens at $2 a million, nothing out.
    expect(rows[1]).toMatchObject({ priceRevision: "price-1", estimatedUsd: 0.002, usage: { inputTokens: 1_000, outputTokens: 0 } });
    expect(JSON.stringify(rows)).not.toContain("Lisbon");
  });
  it("refuses an invalid request before reserving, and a transport that cannot embed with a typed error", async () => {
    const { ledger } = await fixture();
    const port = accountedModelPort(embedding, ledger, { ownerSession: "owner", now: () => at });
    for (const texts of [[], [""], Array.from({ length: 65 }, () => "x"), ["x".repeat(8_001)]]) {
      await expect(port.embed!({ ...embedRequest, texts }, { signal: new AbortController().signal })).rejects.toSatisfy(
        (error: unknown) => error instanceof TaviError && error.code === "INVALID_INPUT",
      );
    }
    expect(await ledger.list(request.runId)).toHaveLength(0);
    const chatOnly: ModelPort = { stream: embedding.stream };
    await expect(
      accountedModelPort(chatOnly, ledger, { ownerSession: "owner", now: () => at }).embed!(embedRequest, {
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((error: unknown) => error instanceof TaviError && error.code === "CAPABILITY_MISSING");
    // Refused by the host before anything was sent: failed, not uncertain.
    expect((await ledger.list(request.runId)).map((row) => row.state)).toEqual(["failed"]);
  });
  it("shares stream's dispatch checks: the run's context, the binding hash, and the provider failure is settled as failed", async () => {
    const { ledger } = await fixture();
    const context = { workspaceId: "ws", principalId: "owner", runId: request.runId, caller: "memory" };
    const { scopedProvider } = await import("../src/provider-execution.js");
    const execution = {
      ledger,
      ownerSession: "owner",
      implementationHash: "a".repeat(64),
      signal: new AbortController().signal,
      actsIn: (_workspaceId: string, principalId: string) => principalId === "owner",
    };
    let calls = 0;
    const failing: ModelPort = {
      ...embedding,
      async embed(input) {
        calls++;
        return {
          status: "failed",
          attemptId: input.attemptId,
          vectors: [],
          usage: {},
          error: { code: "rate_limit", message: "slow down", retryable: true },
        };
      },
    };
    const resolved = scopedProvider(
      execution,
      context,
      { kind: "model", instanceId: "account", accountId: "ref", endpoint: "https://provider.example", configRevision: "b".repeat(64) },
      failing,
    );
    const port = accountedModelPort(failing, ledger, { ownerSession: "owner", now: () => at, resolve: async () => resolved });
    await expect(port.embed!(embedRequest, { signal: new AbortController().signal })).rejects.toThrow(/authenticated run context/);
    await expect(
      port.embed!(embedRequest, { signal: new AbortController().signal, context, expectedBindingHash: "c".repeat(64) }),
    ).rejects.toThrow(/authorization/);
    await expect(port.embed!(embedRequest, { signal: AbortSignal.abort(), context })).rejects.toThrow();
    expect(calls).toBe(0);
    expect(await ledger.list(request.runId)).toHaveLength(0);
    const outcome = await port.embed!(embedRequest, { signal: new AbortController().signal, context });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "rate_limit" } });
    const rows = await ledger.list(request.runId);
    expect(rows).toMatchObject([{ purpose: "embedding", state: "failed", operation: { purpose: "embedding", caller: "memory" } }]);
  });
});
