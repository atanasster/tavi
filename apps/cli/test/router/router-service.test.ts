import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { routerCommand } from "../../src/features/router/owner.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JEV_PROVIDER_ID, RouterSettingsSchema, type RouterDecisionInput, type RouterSettings } from "@tavi/contracts";
import { createJevProvider } from "@tavi/plugin-router";
import { ModelAccounting, RouterProviderSlot, RouterRepository, createRouterGuard } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";

const at = "2026-09-25T00:00:00.000Z";
const scope = { workspaceId: "default", principalId: "alice" };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const response = () =>
  new Response(JSON.stringify({ answers: { q0: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 100, output_tokens: 0 } }));
/**
 * A transport that never answers, and the moment it is first asked. Tests await
 * the dispatch itself rather than polling for it: the reservation and policy
 * checks before it cross the database worker, which can take seconds under load.
 */
function hanging() {
  const dispatched = Promise.withResolvers<void>();
  return {
    dispatched: dispatched.promise,
    fetch: async (): Promise<Response> => {
      dispatched.resolve();
      return new Promise<Response>(() => {});
    },
  };
}
/** A deadline no test outlives: these tests end the decision themselves, and must not race the database worker to the dispatch. */
const UNBOUNDED = { deadlineMs: 10_000 } as const;

async function fixture(
  options: {
    now?: () => number;
    fetch?: typeof fetch;
    settings?: Partial<RouterSettings>;
    readSecret?: (reference: string) => Promise<string | null>;
  } = {},
) {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  cleanup.push(() => store.close());
  const repository = new RouterRepository(
    store,
    (actor) => actor.workspaceId === scope.workspaceId && actor.principalId === scope.principalId,
  );
  const settings = RouterSettingsSchema.parse({
    enabled: true,
    modes: { memory: "shadow", model: "shadow", tools: "shadow", skills: "shadow" },
    egress: { taskText: true, memoryExcerpts: true, toolDescriptions: true, skillMetadata: true },
    providerSettings: { "tavi.router": { credentialRef: "jev.key" } },
    priceRevision: "jev-price",
    ...options.settings,
  });
  await repository.configure(scope, settings, 0);
  const accounting = new ModelAccounting(store.asPort());
  await accounting.putPrice({
    revision: "jev-price",
    connectionId: "jev",
    model: "jev-1.13.0",
    effectiveAt: at,
    currency: "USD",
    input: 0.042,
    cacheRead: 0.042,
    cacheWrite: 0.042,
    output: 0,
  });
  const fetch = vi.fn(options.fetch ?? (async () => response()));
  const slot = new RouterProviderSlot();
  slot.bind(JEV_PROVIDER_ID, createJevProvider({ fetch, readSecret: options.readSecret ?? (async () => "fixture-credential") }));
  const router = createRouterGuard({ repository, accounting, slot, ...(options.now === undefined ? {} : { now: options.now }) });
  cleanup.push(() => router.dispose());
  let sequence = 0;
  const admit = async (principalId = scope.principalId) => {
    const id = ++sequence;
    const p = store.asPort().repositories;
    const admitted = await p.tasks.admit({
      prompt: fixturePromptPolicy,
      ...scope,
      principalId,
      operationKey: `start-${id}`,
      kind: "start",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      newTaskId: (() => `task-${id}`)(),
      newThreadId: (() => `thread-${id}`)(),
      newAdmissionId: (() => `admission-${id}`)(),
      now: (() => at)(),
    });
    const lease = await p.executions.acquire({
      taskId: admitted.task.taskId,
      admissionId: admitted.admission.admissionId,
      ownerSession: "owner",
      leaseMs: 60_000,
      now: { fixed: (() => at)() },
    });
    return { taskId: admitted.task.taskId, ownerSession: "owner", generation: lease.generation };
  };
  const fence = await admit();
  const input: RouterDecisionInput = {
    scope,
    fence,
    operationId: "memory-1",
    turnId: "turn-1",
    feature: "memory",
    permissionRevision: "permission-1",
    prompt: "Remember the project preference",
    candidates: [{ id: "memory-1", revision: "1", description: "Project preference" }],
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
  return { store, repository, settings, accounting, fetch, router, input, admit };
}

describe("bounded Jev service", () => {
  it.each([
    { enabled: false },
    { modes: { model: "off", memory: "off", skills: "off", tools: "off" } },
    { egress: { taskText: true, memoryExcerpts: false, toolDescriptions: false, skillMetadata: false } },
  ] satisfies Partial<RouterSettings>[])("does no network work while disabled or disclosure is denied %#", async (settings) => {
    const f = await fixture({ settings });
    expect((await f.router.decide(f.input)).selectedIds).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.accounting.list(f.input.fence.taskId)).toEqual([]);
  });
  it("records shadow advice without changing supplied candidates and accounts one provider attempt", async () => {
    const f = await fixture();
    const before = JSON.stringify(f.input.candidates);
    const receipt = await f.router.decide(f.input);
    expect(receipt).toMatchObject({ mode: "shadow", state: "finished", reason: "selected", selectedIds: ["memory-1"] });
    expect(JSON.stringify(f.input.candidates)).toBe(before);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect(f.fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", method: "POST" });
    expect(await f.accounting.list(f.input.fence.taskId)).toMatchObject([
      { purpose: "router", state: "completed", usage: { inputTokens: 100, outputTokens: 0 }, estimatedUsd: expect.closeTo(0.0000042, 12) },
    ]);
    expect(await f.repository.spent(scope)).toBe(0.000005);
    expect(await f.router.decide(f.input)).toEqual(receipt);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each([{ feature: "model" as const }, { turnId: "turn-2" }])(
    "rejects replay with conflicting operation identity %j",
    async (change) => {
      const f = await fixture();
      await f.router.decide(f.input);
      expect(await f.router.decide({ ...f.input, ...change })).toMatchObject({ reason: "stale", selectedIds: [] });
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(await f.repository.receipts(scope, f.input.fence.taskId)).toHaveLength(1);
    },
  );
  it("uses scoped cache entries and rechecks permissions before a hit", async () => {
    const f = await fixture();
    await f.router.decide(f.input);
    expect(await f.router.decide({ ...f.input, operationId: "memory-2" })).toMatchObject({ reason: "cache", cacheHit: true });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(await f.router.decide({ ...f.input, operationId: "memory-3", isCurrent: () => false })).toMatchObject({
      reason: "stale",
      selectedIds: [],
    });
    await f.router.decide({ ...f.input, fence: await f.admit(), operationId: "new-task" });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(await f.repository.receipts(scope, f.input.fence.taskId)).toHaveLength(2);
  });
  it.each([401, 429, 529])("abstains on HTTP %s without retaining response text or retrying", async (status) => {
    const f = await fixture({ fetch: async () => new Response("sensitive provider response", { status }) });
    const receipt = await f.router.decide(f.input);
    expect(receipt.selectedIds).toEqual([]);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(await f.repository.receipts(scope, f.input.fence.taskId))).not.toContain("sensitive");
    expect((await (await f).accounting.list(f.input.fence.taskId))[0]?.estimatedUsd).toBeUndefined();
    expect(await f.repository.spent(scope)).toBe(0.002688);
    if (status === 401) {
      expect((await f.router.decide({ ...f.input, operationId: "two" })).reason).toBe("circuit");
      expect(f.fetch).toHaveBeenCalledOnce();
    }
  });
  it("bounds bodies and rejects missing answers", async () => {
    const f = await fixture({ fetch: async () => new Response(JSON.stringify({ answers: {} })) });
    expect((await f.router.decide(f.input)).reason).toBe("invalid");
    const g = await fixture({ fetch: async () => new Response("x".repeat(1_000)), settings: { maxResponseBytes: 256 } });
    expect((await g.router.decide(g.input)).reason).toBe("invalid");
    const h = await fixture({ settings: { maxRequestBytes: 256 } });
    expect((await h.router.decide(h.input)).reason).toBe("invalid");
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("retains a reservation after timeout and exhausts the aggregate turn deadline", async () => {
    // Start the deadline clock at provider dispatch. Worker scheduling under
    // load must not turn this post-dispatch reservation test into a preflight timeout.
    const beforeDispatch = Date.now();
    let dispatchedAt: number | undefined;
    const f = await fixture({
      settings: { deadlineMs: 20 },
      now: () => beforeDispatch + (dispatchedAt === undefined ? 0 : Date.now() - dispatchedAt),
      fetch: async () => {
        dispatchedAt = Date.now();
        return new Promise<Response>(() => {});
      },
    });
    expect((await f.router.decide(f.input)).reason).toBe("deadline");
    expect((await f.router.decide({ ...f.input, operationId: "second" })).reason).toBe("deadline");
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(await f.repository.spent(scope)).toBe(0.002688);
  });
  it("does not dispatch after a credential lookup outlives the deadline", async () => {
    let release: ((value: string) => void) | undefined;
    const f = await fixture({
      settings: { deadlineMs: 10 },
      readSecret: async () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    expect((await f.router.decide(f.input)).reason).toBe("deadline");
    release?.("late-secret");
    await Promise.resolve();
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.router.decide({ ...f.input, operationId: "two" })).reason).toBe("deadline");
    expect(await f.repository.spent(scope)).toBe(0);
  });
  it("rejects a reservation before starting the transport when the budget is exhausted", async () => {
    const f = await fixture({ settings: { maxTaskUsd: 0 } });
    expect((await f.router.decide(f.input)).reason).toBe("budget");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.accounting.list(f.input.fence.taskId)).toEqual([]);
  });
  it("rejects late answers after disable and cancels the outstanding request", async () => {
    let finish: ((response: Response) => void) | undefined;
    const dispatched = Promise.withResolvers<void>();
    const f = await fixture({
      settings: UNBOUNDED,
      fetch: async () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
          dispatched.resolve();
        }),
    });
    const pending = f.router.decide(f.input);
    await dispatched.promise;
    expect(f.fetch).toHaveBeenCalledOnce();
    await routerCommand(
      { repository: f.repository, service: f.router, accounting: f.accounting, readSecret: async () => "test", now: () => at },
      { ...scope, action: "configure", settings: { ...f.settings, enabled: false }, expectedRevision: 1, priceSheets: [] },
    );
    expect(await pending).toMatchObject({ reason: "stale", selectedIds: [] });
    finish?.(response());
    await Promise.resolve();
    expect((await (await f).repository.receipts(scope, f.input.fence.taskId))[0]?.selectedIds).toEqual([]);
    expect(await f.accounting.list(f.input.fence.taskId)).toHaveLength(1);
  });
  it("does not resend a pending operation after owner recovery", async () => {
    const transport = hanging();
    const f = await fixture({ fetch: transport.fetch, settings: UNBOUNDED });
    const pending = f.router.decide(f.input);
    await transport.dispatched;
    expect(f.fetch).toHaveBeenCalledOnce();
    expect((await f.router.decide(f.input)).reason).toBe("uncertain");
    expect(f.fetch).toHaveBeenCalledOnce();
    // The first decision is still waiting on its transport; end it here.
    f.router.disable();
    await pending;
  });
  it("drains aborted decision accounting before disposal returns", async () => {
    const transport = hanging();
    const f = await fixture({ fetch: transport.fetch, settings: UNBOUNDED });
    const pending = f.router.decide(f.input);
    await transport.dispatched;
    expect(f.fetch).toHaveBeenCalledOnce();
    await f.router.dispose();
    expect((await pending).reason).toBe("stale");
    expect((await (await f).accounting.list(f.input.fence.taskId))[0]?.state).toBe("uncertain");
    expect((await f.router.decide({ ...f.input, operationId: "after-disposal" })).reason).toBe("off");
  });
});

it("bounds host eligibility inside the shared deadline without dispatching Jev", async () => {
  const f = await fixture({ settings: { deadlineMs: 100 } });
  const receipt = await f.router.decide({ ...f.input, beforeDecision: async () => new Promise<boolean>(() => {}) });
  expect(receipt.reason).toBe("deadline");
  expect(f.fetch).not.toHaveBeenCalled();
  expect((await (await f).accounting.list(f.input.fence.taskId))[0]).toMatchObject({ state: "failed", estimatedUsd: 0 });
  expect((await f.router.decide({ ...f.input, operationId: "next" })).reason).toBe("deadline");
});

const batchResponse: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const answers =
    body.questions.selection === undefined
      ? Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.99 }]))
      : { selection: { type: "choice", choice: "main", probabilities: { main: 1 } } };
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 100, output_tokens: 0 } }));
};
function surfaces(input: RouterDecisionInput): RouterDecisionInput[] {
  return (["tools", "memory", "skills"] as const).map((feature) => ({
    ...input,
    feature,
    operationId: `${feature}-batch`,
    candidates: [{ id: `${feature}-candidate`, revision: "1", description: `${feature} private candidate` }],
  }));
}
describe("shared relevance decision", () => {
  it("advises all surfaces plus the model within the default two-call cap and charges once per transport", async () => {
    const f = await fixture({ fetch: batchResponse });
    const inputs = surfaces(f.input);
    const receipts = await f.router.decideBatch?.(inputs);
    expect(receipts?.map((receipt) => receipt.selectedIds)).toEqual(inputs.map((input) => [input.candidates[0]?.id]));
    expect(new Set(receipts?.map((receipt) => receipt.batchDecisionId)).size).toBe(1);
    expect(
      receipts?.every((receipt) => receipt.batchDecisionId !== undefined && receipt.callId === undefined && receipt.elapsedMs === 0),
    ).toBe(true);
    expect(await f.accounting.list(f.input.fence.taskId)).toHaveLength(1);
    expect(await f.repository.spent(scope)).toBe(0.000005);
    expect(
      await f.router.decide({
        ...f.input,
        feature: "model",
        operationId: "model",
        candidates: [{ id: "main", revision: "1", description: "main" }],
      }),
    ).toMatchObject({ reason: "selected", selectedIds: ["main"] });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(await f.router.decideBatch?.(inputs)).toEqual(receipts);
    expect(await f.router.decideBatch?.([...inputs].reverse())).toEqual([...(receipts ?? [])].reverse());
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(await f.accounting.list(f.input.fence.taskId)).toHaveLength(2);
  });
  it("keeps denied disclosures out of the batch and preserves individual thresholds and modes", async () => {
    const f = await fixture({
      fetch: batchResponse,
      settings: {
        egress: { taskText: true, toolDescriptions: true, memoryExcerpts: false, skillMetadata: true },
        modes: { tools: "shadow", skills: "active", memory: "active", model: "off" },
        featureThresholds: { skills: 1 },
      },
    });
    const receipts = await f.router.decideBatch?.(surfaces(f.input));
    expect(receipts).toMatchObject([
      { mode: "shadow", selectedIds: ["tools-candidate"] },
      { reason: "egress", selectedIds: [] },
      { mode: "active", reason: "threshold", selectedIds: [] },
    ]);
    expect(String(f.fetch.mock.calls[0]?.[1]?.body)).not.toContain("memory private");
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("allocates the bounded question budget across surfaces", async () => {
    const f = await fixture({ fetch: batchResponse, settings: { maxQuestions: 3 } });
    const inputs = surfaces(f.input).map((input) => ({
      ...input,
      candidates: Array.from({ length: 10 }, (_, index) => ({ id: `${input.feature}-${index}`, revision: "1", description: "candidate" })),
    }));
    const receipts = await f.router.decideBatch?.(inputs);
    expect(receipts?.map((receipt) => receipt.selectedIds)).toEqual([["tools-0"], ["memory-0"], ["skills-0"]]);
    expect(Object.keys(JSON.parse(String(f.fetch.mock.calls[0]?.[1]?.body)).questions)).toHaveLength(3);
  });
  it("does not hide invalid duplicate candidates inside opaque batch IDs", async () => {
    const f = await fixture({ fetch: batchResponse });
    const inputs = surfaces(f.input).map((input) =>
      input.feature === "memory" ? { ...input, candidates: [...input.candidates, ...input.candidates] } : input,
    );
    const receipts = await f.router.decideBatch?.(inputs);
    expect(receipts?.[1]).toMatchObject({ reason: "invalid", selectedIds: [] });
    expect(String(f.fetch.mock.calls[0]?.[1]?.body)).not.toContain("memory private");
  });
  it("drains cancelled batches on disposal without returning late advice", async () => {
    const transport = hanging();
    const f = await fixture({ fetch: transport.fetch, settings: UNBOUNDED });
    const pending = f.router.decideBatch?.(surfaces(f.input));
    await transport.dispatched;
    expect(f.fetch).toHaveBeenCalledOnce();
    await f.router.dispose();
    expect((await pending)?.every((receipt) => receipt.selectedIds.length === 0 && receipt.reason === "stale")).toBe(true);
    expect(await f.accounting.list(f.input.fence.taskId)).toMatchObject([{ state: "uncertain" }]);
  });
});

it.each(["disclosure", "disable"] as const)("fences a batch when %s changes while preparing an excluded surface", async (change) => {
  const f = await fixture({
    fetch: batchResponse,
    settings: { modes: { tools: "active", memory: "active", skills: "off", model: "off" } },
  });
  const original = f.router.decide;
  vi.spyOn(f.router, "decide").mockImplementation(async (input) => {
    const receipt = await original(input);
    if (change === "disable") f.router.disable();
    else f.repository.configure(scope, { ...f.settings, egress: { ...f.settings.egress, memoryExcerpts: false } }, 1);
    return receipt;
  });
  const receipts = await f.router.decideBatch?.(surfaces(f.input));
  expect(receipts?.every((receipt) => receipt.selectedIds.length === 0)).toBe(true);
  expect(f.fetch).not.toHaveBeenCalled();
});

it("does not reuse saved batch selections across disable during replay preparation", async () => {
  const f = await fixture({
    fetch: batchResponse,
    settings: { modes: { tools: "active", memory: "active", skills: "off", model: "off" } },
  });
  const inputs = surfaces(f.input);
  await f.router.decideBatch?.(inputs);
  const original = f.router.decide;
  vi.spyOn(f.router, "decide").mockImplementation(async (input) => {
    const receipt = await original(input);
    f.router.disable();
    return receipt;
  });
  expect((await f.router.decideBatch?.(inputs))?.every((receipt) => receipt.selectedIds.length === 0)).toBe(true);
  expect(f.fetch).toHaveBeenCalledOnce();
});

it("recovers partial batch projection persistence without another provider attempt", async () => {
  const f = await fixture({ fetch: batchResponse });
  const inputs = surfaces(f.input);
  const finish = f.repository.finish.bind(f.repository);
  const spy = vi.spyOn(f.repository, "finish").mockImplementation((scope, fence, receipt, cost) => {
    if (receipt.feature === "memory" && receipt.batchDecisionId !== undefined) throw new Error("simulated interruption");
    return finish(scope, fence, receipt, cost);
  });
  await expect(f.router.decideBatch?.(inputs)).rejects.toThrow("simulated interruption");
  spy.mockRestore();
  const recovered = await f.router.decideBatch?.(inputs);
  expect(recovered?.[0]?.selectedIds).toEqual(["tools-candidate"]);
  expect(recovered?.[1]).toMatchObject({ reason: "uncertain", selectedIds: [] });
  expect(recovered?.[2]?.selectedIds).toEqual(["skills-candidate"]);
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(await f.accounting.list(f.input.fence.taskId)).toHaveLength(1);
});

it("does not dispatch when cancellation arrives during the final database policy check", async () => {
  let credentialRead = false;
  let checked!: () => void;
  let release!: () => void;
  const checking = new Promise<void>((resolve) => {
    checked = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({
    settings: { deadlineMs: 10_000 },
    readSecret: async () => {
      credentialRead = true;
      return "fixture-credential";
    },
  });
  const controller = new AbortController();
  const decision = f.router.decide({
    ...f.input,
    signal: controller.signal,
    isCurrent: async () => {
      if (credentialRead) {
        checked();
        await resume;
      }
      return true;
    },
  });
  await checking;
  controller.abort();
  release();
  expect((await decision).reason).toBe("stale");
  expect(f.fetch).not.toHaveBeenCalled();
  expect(await f.repository.spent(scope)).toBe(0);
});
