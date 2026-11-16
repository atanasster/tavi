import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  JEV_PROVIDER_ID,
  RouterSettingsSchema,
  routerProviderSettings,
  type RouterDecisionInput,
  type RouterProvider,
  type RouterProviderRequest,
} from "@tavi/contracts";
import { createJevProvider } from "@tavi/plugin-router";
import { ModelAccounting, RouterProviderSlot, RouterRepository, createRouterGuard } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { parseArgs } from "../../src/cli/parse.js";
import { main } from "../../src/main.js";
import { routerCommand } from "../../src/features/router/owner.js";
import { BUILTIN_ROUTER_PROVIDERS } from "../../src/features/plugins/catalog.js";

const at = "2026-09-25T00:00:00.000Z";
const directories = temporaryDirectories({ prefix: "tavi-router-provider-" });
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  directories.cleanup();
});
const temp = (): string => directories.create();
const routed = (extra: Record<string, unknown> = {}) =>
  RouterSettingsSchema.parse({
    enabled: true,
    modes: { memory: "shadow" },
    egress: { taskText: true, memoryExcerpts: true, toolDescriptions: true, skillMetadata: true },
    providerSettings: { "tavi.router": { credentialRef: "jev.key" } },
    priceRevision: "jev-price",
    ...extra,
  });

async function world() {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  cleanup.push(() => store.close());
  const repository = new RouterRepository(store, () => true);
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
  const router = createRouterGuard({ repository, accounting, slot });
  cleanup.push(() => router.dispose());
  let sequence = 0;
  const input = async (workspaceId = "default", operationId = "memory-1"): Promise<RouterDecisionInput> => {
    const id = ++sequence;
    const p = store.asPort().repositories;
    const admitted = await p.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId,
      principalId: "operator",
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
    return {
      scope: { workspaceId, principalId: "operator" },
      fence: { taskId: admitted.task.taskId, ownerSession: "owner", generation: lease.generation },
      operationId,
      turnId: "turn-1",
      feature: "memory",
      permissionRevision: "permission-1",
      prompt: "Remember the project preference",
      candidates: [{ id: "memory-1", revision: "1", description: "Project preference" }],
      signal: new AbortController().signal,
      isCurrent: () => true,
    };
  };
  const deps = {
    repository,
    service: router,
    accounting,
    readSecret: async () => "x",
    transaction: <T>(body: () => T) => store.handle.transaction(body)(),
    now: () => at,
    providerCandidate: async (providerId: string) =>
      providerId === JEV_PROVIDER_ID || providerId === "acme.router"
        ? { ok: true as const, enabled: true }
        : { ok: false as const, reason: `${providerId} is not installed` },
  };
  return { store, repository, accounting, slot, router, input, deps };
}

function fake(
  answer: (request: RouterProviderRequest) => Promise<{ probabilities: Record<string, number> }>,
): RouterProvider & { requests: RouterProviderRequest[] } {
  const requests: RouterProviderRequest[] = [];
  return {
    requests,
    pricing: { connectionId: "jev", model: "jev-1.13.0" },
    supportsBatch: true,
    maxCostUsd: () => 0.001,
    classify: async (request) => {
      requests.push(request);
      request.checkpoint();
      return answer(request);
    },
  };
}

describe("router settings with provider selection", () => {
  it("defaults a built-in provider's settings by its own schema, refuses the old top-level fields, and round-trips", () => {
    const checked = (input: unknown) => routerProviderSettings(RouterSettingsSchema.parse(input), BUILTIN_ROUTER_PROVIDERS);
    expect(
      RouterSettingsSchema.safeParse({ enabled: true, credentialRef: "jev.key", endpoint: "https://api.typesafe.ai/v1/systemone" }).success,
    ).toBe(false);
    const settings = checked({ enabled: true, providerSettings: { "tavi.router": { credentialRef: "jev.key" } } });
    expect(settings).toMatchObject({
      provider: "tavi.router",
      providerSettings: {
        "tavi.router": { credentialRef: "jev.key", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
      },
    });
    expect(checked(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    // Nothing configured is nothing stored: the provider fills its defaults where it runs.
    expect(checked({})).toMatchObject({ provider: "tavi.router", providerSettings: {} });
    expect(() => checked({ providerSettings: { "tavi.router": { endpoint: "https://elsewhere.example" } } })).toThrow(/tavi\.router/);
    expect(() => checked({ providerSettings: { "tavi.router": { apiKey: "secret" } } })).toThrow(/tavi\.router/);
    expect(() => checked({ provider: "acme.router", providerSettings: { "acme.router": { url: "x" } } })).toThrow(
      /not a built-in routing provider/,
    );
    expect(checked({ provider: "acme.router", providerSettings: { "acme.router": {} } })).toMatchObject({ provider: "acme.router" });
  });

  it("switches providers between turns without a restart, aborting the old provider's call", async () => {
    const f = await world();
    const scope = { workspaceId: "default", principalId: "operator" };
    f.repository.configure(scope, routed(), 0);
    const jev = fake(async () => new Promise<never>(() => {}));
    const acme = fake(async () => ({ probabilities: { "memory-1": 0.95 } }));
    f.slot.bind(JEV_PROVIDER_ID, jev);
    f.slot.bind("acme.router", acme);
    const first = await f.input();
    const pending = f.router.decide(first);
    await vi.waitFor(() => expect(jev.requests).toHaveLength(1), { interval: 1 });
    await expect(
      routerCommand(f.deps, { ...scope, action: "set-provider", providerId: "acme.router", expectedRevision: 0 }),
    ).rejects.toThrow("configuration changed");
    const switched = (await routerCommand(f.deps, {
      ...scope,
      action: "set-provider",
      providerId: "acme.router",
      expectedRevision: 1,
    })) as { configuration: { revision: number; settings: { provider: string } } };
    expect(switched.configuration).toMatchObject({ revision: 2, settings: { provider: "acme.router" } });
    expect(await pending).toMatchObject({ reason: "stale", providerId: "tavi.router", selectedIds: [] });
    const next = await f.router.decide({ ...(await f.input()), operationId: "memory-2" });
    expect(next).toMatchObject({ reason: "selected", providerId: "acme.router" });
    expect(acme.requests).toHaveLength(1);
    // The earlier operation's receipt belongs to the old provider and is never replayed.
    expect(await f.router.decide(first)).toMatchObject({ reason: "stale", selectedIds: [] });
    expect(acme.requests).toHaveLength(1);
    await expect(
      routerCommand(f.deps, { ...scope, action: "set-provider", providerId: "other.router", expectedRevision: 2 }),
    ).rejects.toThrow("not installed");
    await expect(
      routerCommand(f.deps, {
        ...scope,
        action: "configure",
        settings: { ...routed(), provider: "other.router" },
        expectedRevision: 2,
        priceSheets: [],
      }),
    ).rejects.toThrow("not installed");
    expect((await f.repository.configuration(scope)).revision).toBe(2);
    // A provider that is not the Jev one reports readiness nested, and a failing report does not fail status.
    const status = await routerCommand(
      {
        ...f.deps,
        providerReadiness: async () => {
          throw new Error("status bug");
        },
      },
      { ...scope, action: "status" },
    );
    expect(status).toMatchObject({
      provider: { id: "acme.router" },
      readiness: "unavailable",
      configuration: { settings: { provider: "acme.router" } },
    });
    const reported = await routerCommand(
      { ...f.deps, providerReadiness: async () => ({ configuration: "spoofed", signedIn: true }) },
      { ...scope, action: "status" },
    );
    expect(reported).toMatchObject({ readiness: { configuration: "spoofed", signedIn: true }, configuration: { revision: 2 } });
  });

  it("sends each workspace's own Jev credential through the single bound provider", async () => {
    const f = await world();
    const credentials: Record<string, string> = { "alpha.key": "alpha-secret", "beta.key": "beta-secret" };
    const seen: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      seen.push(String(new Headers(init?.headers).get("Authorization")));
      return new Response(JSON.stringify({ answers: { q0: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 10, output_tokens: 0 } }));
    });
    f.slot.bind(JEV_PROVIDER_ID, createJevProvider({ fetch, readSecret: async (reference) => credentials[reference] ?? null }));
    f.repository.configure(
      { workspaceId: "alpha", principalId: "operator" },
      routed({ providerSettings: { "tavi.router": { credentialRef: "alpha.key" } } }),
      0,
    );
    f.repository.configure(
      { workspaceId: "beta", principalId: "operator" },
      routed({ providerSettings: { "tavi.router": { credentialRef: "beta.key" } } }),
      0,
    );
    expect((await f.router.decide(await f.input("alpha"))).reason).toBe("selected");
    expect((await f.router.decide(await f.input("beta"))).reason).toBe("selected");
    expect(seen).toEqual(["Bearer alpha-secret", "Bearer beta-secret"]);
  });
});

describe("tavi router offline with provider selection", () => {
  const capture = () => {
    const out: string[] = [],
      err: string[] = [];
    return { io: { isTty: false, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) }, out, err };
  };

  it("parses set-provider and requires a revision", () => {
    expect(parseArgs(["router", "set-provider", "acme.router", "--revision", "3"]).router).toMatchObject({
      action: "set-provider",
      providerId: "acme.router",
      expectedRevision: 3,
    });
    expect(() => parseArgs(["router", "set-provider", "acme.router"])).toThrow("--revision");
    expect(() => parseArgs(["router", "set-provider"])).toThrow();
  });

  it("validates Jev settings and provider choices without an owner, even with tavi.router disabled", async () => {
    const directory = temp(),
      at = ["--data-dir", directory];
    const c = capture();
    expect(await main(["plugins", "disable", "tavi.router", ...at], { io: c.io })).toBe(0);
    const bad = join(directory, "bad.json");
    writeFileSync(bad, JSON.stringify({ settings: { providerSettings: { "tavi.router": { endpoint: "https://elsewhere.example" } } } }));
    expect(await main(["router", "configure", "--file", bad, "--revision", "0", ...at], { io: c.io })).not.toBe(0);
    expect(c.err.join("")).toContain("providerSettings.tavi.router.endpoint");
    const good = join(directory, "good.json");
    writeFileSync(good, JSON.stringify({ settings: { enabled: true, providerSettings: { "tavi.router": { credentialRef: "jev.key" } } } }));
    expect(await main(["router", "configure", "--file", good, "--revision", "0", ...at], { io: c.io })).toBe(0);
    expect(JSON.parse(c.out.pop() ?? "{}")).toMatchObject({
      configuration: {
        revision: 1,
        settings: { provider: "tavi.router", providerSettings: { "tavi.router": { credentialRef: "jev.key" } } },
      },
    });

    expect(await main(["router", "set-provider", "acme.router", "--revision", "1", ...at], { io: c.io })).not.toBe(0);
    expect(c.err.join("")).toContain("acme.router is not installed");
    const plugin = temp();
    writeFileSync(
      join(plugin, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.weather",
        version: "1.0.0",
        name: "Weather",
        entry: "index.mjs",
      }),
    );
    writeFileSync(join(plugin, "index.mjs"), "export function register() {}\n");
    expect(await main(["plugins", "install", plugin, ...at], { io: c.io })).toBe(0);
    expect(await main(["router", "set-provider", "acme.weather", "--revision", "1", ...at], { io: c.io })).not.toBe(0);
    expect(c.err.join("")).toContain("acme.weather has no approved version that declares a routing provider");

    expect(await main(["router", "set-provider", "tavi.router", "--revision", "1", ...at], { io: c.io })).toBe(0);
    expect(JSON.parse(c.out.pop() ?? "{}")).toMatchObject({
      configuration: { revision: 2 },
      warning: expect.stringContaining("tavi.router is not enabled"),
    });
    expect(await main(["router", "status", ...at], { io: c.io })).toBe(0);
    expect(JSON.parse(c.out.pop() ?? "{}")).toMatchObject({
      provider: { id: "tavi.router", state: "disabled" },
      credentialPresence: "missing",
      priceReady: false,
    });
  });
});
