import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { JEV_PROVIDER_ID, RouterSettingsSchema, type RouterDecisionInput } from "@tavi/contracts";
import { createJevProvider } from "@tavi/plugin-router";
import { ModelAccounting, RouterProviderSlot, RouterRepository, createRouterGuard } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";

// Bodies and receipts recorded from the pre-guard `createJevRouter`:
// for these credential-free prompts, moving the checks into the host guard changes no byte on the
// wire. One intentional difference is not covered here: batched prompts are now scrubbed one
// feature at a time, where the old router scrubbed their joined JSON and could break its quoting.
const golden = JSON.parse(readFileSync(new URL("../fixtures/router-golden-bodies.json", import.meta.url), "utf8")) as {
  bodies: string[];
  receipts: unknown[];
};
const at = "2026-09-25T00:00:00.000Z";
const scope = { workspaceId: "default", principalId: "alice" };
const volatile = ["decisionId", "startedAt", "finishedAt", "elapsedMs", "callId", "batchDecisionId"];

it("sends byte-identical Jev requests and records the same receipts through the host guard", async () => {
  const bodies: string[] = [];
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const repository = new RouterRepository(store, () => true);
  await repository.configure(
    scope,
    RouterSettingsSchema.parse({
      enabled: true,
      modes: { memory: "shadow", model: "shadow", tools: "shadow", skills: "shadow" },
      egress: { taskText: true, memoryExcerpts: true, toolDescriptions: true, skillMetadata: true },
      providerSettings: { "tavi.router": { credentialRef: "jev.key" } },
      priceRevision: "jev-price",
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
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const body = JSON.parse(String(init?.body));
    const answers =
      body.questions.selection === undefined
        ? Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.99 }]))
        : { selection: { type: "choice", choice: "main", probabilities: { main: 0.7, fast: 0.3 } } };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 100, output_tokens: 0 } }));
  });
  const slot = new RouterProviderSlot();
  slot.bind(JEV_PROVIDER_ID, createJevProvider({ fetch: fetch as typeof globalThis.fetch, readSecret: async () => "fixture-credential" }));
  const router = createRouterGuard({ repository, accounting, slot });
  const p = store.asPort().repositories;
  let n = 0;
  const admit = async () => {
    const id = ++n;
    const admitted = await p.tasks.admit({
      prompt: fixturePromptPolicy,
      ...scope,
      operationKey: `s-${id}`,
      kind: "start",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      newTaskId: (() => `task-${id}`)(),
      newThreadId: (() => `thread-${id}`)(),
      newAdmissionId: (() => `adm-${id}`)(),
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
  const base: RouterDecisionInput = {
    scope,
    fence: await admit(),
    operationId: "memory-1",
    turnId: "turn-1",
    feature: "memory",
    permissionRevision: "p",
    prompt: "Remember the project preference sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    candidates: Array.from({ length: 40 }, (_, i) => ({
      id: `memory-${i}`,
      revision: "1",
      description: `Project preference ${i} ${"x".repeat(i * 20)}`,
    })),
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
  const receipts: unknown[] = [];
  receipts.push(await router.decide(base));
  receipts.push(
    await router.decide({
      ...base,
      fence: await admit(),
      feature: "model",
      operationId: "model-1",
      candidates: [
        { id: "main", revision: "1", description: "Default model" },
        { id: "fast", revision: "1", description: "Cheaper model" },
      ],
    }),
  );
  const batchFence = await admit();
  receipts.push(
    await router.decideBatch?.(
      (["tools", "memory", "skills"] as const).map((feature) => ({
        ...base,
        fence: batchFence,
        feature,
        operationId: `${feature}-b`,
        prompt: `${feature} prompt about files`,
        candidates: Array.from({ length: 20 }, (_, i) => ({
          id: `${feature}-${i}`,
          revision: "1",
          description: `${feature} candidate ${i} ${"y".repeat(i * 40)}`,
        })),
      })),
    ),
  );
  await router.dispose();
  store.close();
  expect(bodies).toEqual(golden.bodies);
  // Receipts gained `providerId` with provider selection; everything else is unchanged.
  const flat = receipts.flatMap((receipt) => (Array.isArray(receipt) ? receipt : [receipt])) as { providerId?: string }[];
  expect(flat.every((receipt) => receipt.providerId === "tavi.router")).toBe(true);
  expect(
    JSON.parse(JSON.stringify(receipts, (key, value: unknown) => (volatile.includes(key) || key === "providerId" ? undefined : value))),
  ).toEqual(golden.receipts);
});
