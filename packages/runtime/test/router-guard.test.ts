import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ROUTER_PROVIDER_FAILURES,
  RouterSettingsSchema,
  type RouterDecisionInput,
  type RouterProvider,
  type RouterProviderAnswer,
  type RouterProviderRequest,
} from "@tavi/contracts";
import { ModelAccounting, RouterProviderSlot, RouterRepository, createRouterGuard } from "../src/index.js";
import { DatabaseClient } from "../src/persistence/client.js";

const at = "2026-09-25T00:00:00.000Z";
const scope = { workspaceId: "default", principalId: "alice" };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fakeProvider(
  classify: (request: RouterProviderRequest) => Promise<RouterProviderAnswer>,
): RouterProvider & { readonly requests: RouterProviderRequest[] } {
  const requests: RouterProviderRequest[] = [];
  return {
    requests,
    pricing: { connectionId: "jev", model: "jev-1.13.0" },
    supportsBatch: true,
    maxCostUsd: () => 0.001,
    classify: async (request) => {
      requests.push(request);
      return classify(request);
    },
  };
}

async function fixture(provider?: RouterProvider, settings: Record<string, unknown> = {}) {
  const store = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  cleanup.push(() => store.close());
  const repository = new RouterRepository(store, () => true);
  await repository.configure(
    scope,
    RouterSettingsSchema.parse({
      enabled: true,
      modes: { memory: "shadow", model: "shadow", tools: "shadow", skills: "shadow" },
      egress: { taskText: true, memoryExcerpts: true, toolDescriptions: true, skillMetadata: true },
      providerSettings: { "tavi.router": { credentialRef: "jev.key" } },
      priceRevision: "jev-price",
      ...settings,
    }),
    0,
  );
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
  const slot = new RouterProviderSlot();
  const unbind = provider === undefined ? undefined : slot.bind("tavi.router", provider);
  const router = createRouterGuard({ repository, accounting, slot });
  cleanup.push(() => router.dispose());
  const p = store.asPort().repositories;
  const admitted = await p.tasks.admit({
    ...scope,
    operationKey: "start-1",
    kind: "start",
    intent: { prompt: "hello" },
    checkpointNamespace: "",
    newTaskId: "task-1",
    newThreadId: "thread-1",
    newAdmissionId: "admission-1",
    now: at,
    prompt: { builtin: { text: "test", version: "test" } },
  });
  const lease = await p.executions.acquire({
    taskId: "task-1",
    admissionId: admitted.admission.admissionId,
    ownerSession: "owner",
    leaseMs: 60_000,
    now: { fixed: at },
  });
  const input: RouterDecisionInput = {
    scope,
    fence: { taskId: "task-1", ownerSession: "owner", generation: lease.generation },
    operationId: "memory-1",
    turnId: "turn-1",
    feature: "memory",
    permissionRevision: "permission-1",
    prompt: "Remember the project preference",
    candidates: [{ id: "memory-1", revision: "1", description: "Project preference" }],
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
  return { repository, accounting, router, input, slot, unbind };
}

describe("router guard", () => {
  it("abstains with `provider` when none is bound, without reserving or accounting", async () => {
    const f = await fixture();
    expect(await f.router.decide(f.input)).toMatchObject({ reason: "provider", selectedIds: [] });
    expect(await f.repository.receipts(scope, "task-1")).toEqual([]);
    expect(await f.accounting.list("task-1")).toEqual([]);
  });

  it("records an unknown provider throw as transport, charges it as uncertain and does not fail the caller", async () => {
    const f = await fixture(
      fakeProvider(async (request) => {
        await request.checkpoint();
        throw new Error("provider bug");
      }),
    );
    const receipt = await f.router.decide(f.input);
    expect(receipt).toMatchObject({ reason: "transport", selectedIds: [] });
    expect(await f.accounting.list("task-1")).toMatchObject([{ state: "uncertain" }]);
    expect(await f.repository.spent(scope)).toBeGreaterThan(0);
  });

  it("classifies a thrown failure by its shape, not its class", async () => {
    const f = await fixture(
      fakeProvider(async () => {
        throw { reason: "credentials" };
      }),
    );
    expect((await f.router.decide(f.input)).reason).toBe("credentials");
    expect((await f.router.decide({ ...f.input, operationId: "memory-2" })).reason).toBe("circuit");
  });

  it.each([
    { name: "unknown id", answer: { probabilities: { other: 0.9 } } },
    { name: "out of range", answer: { probabilities: { "memory-1": 1.5 } } },
    { name: "not finite", answer: { probabilities: { "memory-1": Number.NaN } } },
    { name: "a choice for a relevance feature", answer: { probabilities: { "memory-1": 0.9 }, choice: "memory-1" } },
    {
      name: "oversize",
      answer: { probabilities: { "memory-1": 0.9 }, confidence: 0.5, padding: "x".repeat(300_000) } as RouterProviderAnswer,
    },
  ])("rejects an answer with $name as invalid", async ({ answer }) => {
    const f = await fixture(
      fakeProvider(async (request) => {
        await request.checkpoint();
        return answer;
      }),
    );
    expect(await f.router.decide(f.input)).toMatchObject({ reason: "invalid", selectedIds: [] });
  });

  it("applies the host threshold to provider probabilities", async () => {
    const f = await fixture(
      fakeProvider(async (request) => {
        await request.checkpoint();
        return { probabilities: { "memory-1": 0.5 }, usage: { inputTokens: 10, outputTokens: 0 } };
      }),
    );
    expect(await f.router.decide(f.input)).toMatchObject({ reason: "threshold", selectedIds: [], probabilities: { "memory-1": 0.5 } });
  });

  it("gives the provider scrubbed text tagged by feature and no host identity", async () => {
    const provider = fakeProvider(async (request) => {
      await request.checkpoint();
      return { probabilities: { "memory-1": 0.95 } };
    });
    const f = await fixture(provider);
    await f.router.decide({ ...f.input, prompt: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 please" });
    const request = provider.requests[0];
    expect(request?.prompts.memory).not.toContain("sk-ant-api03");
    expect(request?.candidates).toEqual([{ id: "memory-1", revision: "1", description: "Project preference", feature: "memory" }]);
    expect(JSON.stringify(request)).not.toContain("task-1");
  });

  it("aborts and drains in-flight decisions when the provider is unbound", async () => {
    let dispatched!: () => void;
    const dispatch = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const provider = fakeProvider(async (request) => {
      await request.checkpoint();
      dispatched();
      return new Promise<never>(() => {});
    });
    const f = await fixture(provider);
    const pending = f.router.decide(f.input);
    await dispatch;
    await f.unbind?.();
    expect(await pending).toMatchObject({ reason: "provider", selectedIds: [] });
    expect(await f.accounting.list("task-1")).toMatchObject([{ state: "uncertain" }]);
    expect((await f.router.decide({ ...f.input, operationId: "after" })).reason).toBe("provider");
  });

  it("does not trip the circuit when several in-flight decisions lose their provider", async () => {
    const hanging = fakeProvider(async (request) => {
      await request.checkpoint();
      return new Promise<never>(() => {});
    });
    const f = await fixture(hanging, { concurrency: 3 });
    const pending = ["a", "b", "c"].map((operationId) => f.router.decide({ ...f.input, operationId, turnId: `turn-${operationId}` }));
    await vi.waitFor(() => expect(hanging.requests).toHaveLength(3), { interval: 1 });
    await f.unbind?.();
    expect((await Promise.all(pending)).map((receipt) => receipt.reason)).toEqual(["provider", "provider", "provider"]);
    f.slot.bind(
      "tavi.router",
      fakeProvider(async (request) => {
        await request.checkpoint();
        return { probabilities: { "memory-1": 0.95 } };
      }),
    );
    expect((await f.router.decide({ ...f.input, operationId: "rebound", turnId: "turn-d" })).reason).toBe("selected");
  });

  it("abstains when a provider hook throws before reserving anything", async () => {
    const provider = {
      ...fakeProvider(async () => ({ probabilities: {} })),
      measure: () => {
        throw new Error("measure bug");
      },
    };
    const f = await fixture(provider);
    expect(await f.router.decide(f.input)).toMatchObject({ reason: "invalid", selectedIds: [] });
    expect(await f.repository.receipts(scope, "task-1")).toEqual([]);
    const batch = (["tools", "memory"] as const).map((feature) => ({ ...f.input, feature, operationId: `${feature}-batch` }));
    expect((await f.router.decideBatch?.(batch))?.map((receipt) => receipt.reason)).toEqual(["invalid", "invalid"]);
    const failing = await fixture({
      ...fakeProvider(async () => ({ probabilities: {} })),
      unavailable: () => {
        throw { reason: "credentials" };
      },
    });
    expect((await failing.router.decide(failing.input)).reason).toBe("credentials");
  });

  it("scrubs each batched prompt on its own, keeping the prompts well formed", async () => {
    const provider = fakeProvider(async (request) => {
      await request.checkpoint();
      return { probabilities: Object.fromEntries(request.candidates.map((candidate) => [candidate.id, 0.95])) };
    });
    const f = await fixture(provider);
    const batch = (["tools", "memory"] as const).map((feature) => ({
      ...f.input,
      feature,
      operationId: `${feature}-batch`,
      prompt: feature === "tools" ? "Authorization: Bearer abcdefghijklmnop" : "plain",
    }));
    await f.router.decideBatch?.(batch);
    const prompts = provider.requests[0]?.prompts;
    expect(prompts?.tools).not.toContain("abcdefghijklmnop");
    expect(JSON.parse(JSON.stringify(prompts))).toEqual(prompts);
    expect(provider.requests[0]?.candidates.map((candidate) => candidate.feature).sort()).toEqual(["memory", "tools"]);
  });

  it("validates against its own shortlist, not a copy the provider mutated", async () => {
    const provider = fakeProvider(async (request) => {
      await request.checkpoint();
      try {
        (request.candidates as { id: string; revision: string; description: string; feature: string }[]).push({
          id: "injected",
          revision: "1",
          description: "x",
          feature: "memory",
        });
      } catch {
        /* frozen */
      }
      return { probabilities: { "memory-1": 0.95, injected: 0.99 } };
    });
    const f = await fixture(provider);
    expect(await f.router.decide(f.input)).toMatchObject({ reason: "invalid", selectedIds: [], probabilities: {} });
    expect(Object.isFrozen(provider.requests[0]?.candidates)).toBe(true);
    expect(JSON.stringify(await f.repository.receipts(scope, "task-1"))).not.toContain("injected");
  });

  it.each([
    // Read once, as JSON: the second read that would throw never happens.
    {
      name: "a probabilities getter that throws on a later read",
      answer: () => {
        let reads = 0;
        return {
          get probabilities() {
            if (++reads > 1) throw new Error("gotcha");
            return { "memory-1": 0.95 };
          },
        };
      },
      reason: "selected",
    },
    // A proxy is read for `then` as the promise resolves, so it fails as the provider's own throw would.
    {
      name: "a proxy that throws",
      answer: () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error("gotcha");
            },
            ownKeys() {
              throw new Error("gotcha");
            },
          },
        ),
      reason: "transport",
    },
    {
      name: "a usage getter that throws",
      answer: () => ({
        probabilities: { "memory-1": 0.95 },
        get usage() {
          throw new Error("gotcha");
        },
      }),
      reason: "invalid",
    },
  ])("never lets $name escape", async ({ answer, reason }) => {
    const f = await fixture(
      fakeProvider(async (request) => {
        await request.checkpoint();
        return answer() as RouterProviderAnswer;
      }),
    );
    expect((await f.router.decide(f.input)).reason).toBe(reason);
  });

  it("records the usage a provider reports even when its answer is refused", async () => {
    const f = await fixture(
      fakeProvider(async (request) => {
        await request.checkpoint();
        return { probabilities: { unknown: 0.9 }, usage: { inputTokens: 100, outputTokens: 0 } };
      }),
    );
    expect((await f.router.decide(f.input)).reason).toBe("invalid");
    expect(await f.accounting.list("task-1")).toMatchObject([{ state: "uncertain", usage: { inputTokens: 100, outputTokens: 0 } }]);
  });

  it.each([
    {
      name: "a reason getter that throws",
      thrown: () => ({
        get reason() {
          throw new Error("gotcha");
        },
      }),
      classified: "transport",
      hooked: "invalid",
    },
    {
      name: "a usage getter that throws",
      thrown: () => ({
        reason: "credentials",
        get usage() {
          throw new Error("gotcha");
        },
      }),
      classified: "credentials",
      hooked: "credentials",
    },
    {
      name: "a throwing proxy",
      thrown: () =>
        new Proxy(
          {},
          {
            has() {
              throw new Error("gotcha");
            },
            get() {
              throw new Error("gotcha");
            },
          },
        ),
      classified: "transport",
      hooked: "invalid",
    },
  ])("never lets a provider throw with $name escape", async ({ thrown, classified, hooked: expected }) => {
    const f = await fixture(
      fakeProvider(async (request) => {
        await request.checkpoint();
        throw thrown();
      }),
    );
    expect((await f.router.decide(f.input)).reason).toBe(classified);
    const hooked = await fixture({
      ...fakeProvider(async () => ({ probabilities: {} })),
      measure: () => {
        throw thrown();
      },
    });
    expect((await hooked.router.decide(hooked.input)).reason).toBe(expected);
  });

  it("keeps the failure list a plugin receives frozen", () => {
    expect(Object.isFrozen(ROUTER_PROVIDER_FAILURES)).toBe(true);
    expect(() => {
      (ROUTER_PROVIDER_FAILURES as unknown as string[]).length = 0;
    }).toThrow();
  });

  it("turns off, in its effective configuration, every feature the bound provider does not declare", async () => {
    const f = await fixture({ ...fakeProvider(async () => ({ probabilities: {} })), features: ["memory"] });
    const effective = await f.router.configuration(scope);
    expect(effective.settings.modes).toEqual({ model: "off", memory: "shadow", tools: "off", skills: "off" });
    expect(effective.revision).toBe((await f.repository.configuration(scope)).revision);
    expect((await f.repository.configuration(scope)).settings.modes.tools).toBe("shadow");
  });

  it("refuses to bind one provider id twice", () => {
    const slot = new RouterProviderSlot();
    slot.bind(
      "tavi.router",
      fakeProvider(async () => ({ probabilities: {} })),
    );
    expect(() =>
      slot.bind(
        "tavi.router",
        fakeProvider(async () => ({ probabilities: {} })),
      ),
    ).toThrow(/already bound/);
  });
});
