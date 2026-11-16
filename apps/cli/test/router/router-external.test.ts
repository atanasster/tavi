import { inspectDatabase } from "../support/database-fixture.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RouterPayloadSchema, type ModelRequest, type RouterReceipt } from "@tavi/contracts";
import { ModelAccounting, PluginRegistry } from "@tavi/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { pluginsCommand } from "../../src/server/config-commands.js";
import { main } from "../../src/main.js";
import { BUILTIN_PLUGINS } from "../../src/features/plugins/catalog.js";
import { buildDoctorDocument } from "../../src/features/doctor/reports.js";
import {
  routerCommand,
  routerProviderCandidate,
  routerProviderPricing,
  routerProviderState,
  runningProviderReadiness,
} from "../../src/features/router/owner.js";
import { pinToolDeferralOff } from "../support/prompt-layout.js";
import { ROUTED, compose, run, scope, seed, temporary } from "./router-fixtures.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

interface Recorded {
  features: string[];
  prompts: Record<string, string>;
  candidates: { id: string; feature: string; description: string }[];
  settings: Record<string, unknown>;
}
interface RouterState {
  requests: Recorded[];
  behavior: string;
  hooks?: string;
}
const routers = (): Record<string, RouterState> => {
  const holder = globalThis as { __taviTestRouters?: Record<string, RouterState> };
  holder.__taviTestRouters ??= {};
  return holder.__taviTestRouters;
};

/** A routing provider plugin whose behavior the test switches through a global. */
const ROUTER_CODE = (id: string) => `
export default {
  register({ provideRouter, RouterProviderError }) {
    const hooks = () => globalThis.__taviTestRouters[${JSON.stringify(id)}].hooks;
    provideRouter({
      maxCostUsd: () => 0,
      measure: () => hooks() === "nan-measure" ? Number.NaN : hooks() === "async-measure" ? Promise.resolve(10) : 10,
      unavailable: () => hooks() === "async-unavailable" ? Promise.resolve(undefined) : hooks() === "bogus-unavailable" ? "unplugged" : undefined,
      status: () => hooks() === "hanging-status" ? new Promise(() => {}) : hooks() === "nested-status" ? { deep: { secret: "x" } } : { signedIn: true },
      async classify(request) {
        const state = globalThis.__taviTestRouters[${JSON.stringify(id)}];
        state.requests.push(JSON.parse(JSON.stringify({ features: request.features, prompts: request.prompts, candidates: request.candidates, settings: request.settings })));
        switch (state.behavior) {
          case "throw": throw new Error("provider bug");
          case "hang": return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
          case "malformed": return { probabilities: { unknown: 2 } };
          case "oversize": return { probabilities: {}, padding: "x".repeat(400000) };
          case "credentials": throw new RouterProviderError("credentials");
          case "plain-credentials": throw { reason: "credentials" };
        }
        const usage = state.behavior === "expensive" ? { inputTokens: 1000000000, outputTokens: 0 } : state.behavior === "no-usage" ? undefined : { inputTokens: 0, outputTokens: 0 };
        if (request.features[0] === "model") return { choice: "fast", probabilities: { main: 0.01, fast: 0.99 }, usage };
        return { probabilities: Object.fromEntries(request.candidates.map((candidate) => [candidate.id, 0.99])), ...(usage === undefined ? {} : { usage }) };
      },
    });
  },
};
`;

function routerPlugin(id: string, router: Record<string, unknown>, code = ROUTER_CODE(id), extra: Record<string, unknown> = {}): string {
  const directory = temporary(cleanup);
  writeFileSync(
    join(directory, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id,
      version: "1.0.0",
      name: id,
      entry: "index.mjs",
      provides: ["router"],
      router,
      ...extra,
    }),
  );
  writeFileSync(join(directory, "index.mjs"), code);
  return directory;
}

const quiet = { isTty: false, stdout: () => {}, stderr: () => {} };
async function tavi(argv: readonly string[]): Promise<void> {
  const errors: string[] = [];
  const code = await main([...argv], { io: { ...quiet, stderr: (text: string) => errors.push(text) } });
  expect(code, `${argv.join(" ")}: ${errors.join("")}`).toBe(0);
}
async function install(directory: string, source: string, id: string): Promise<void> {
  for (const argv of [
    ["plugins", "install", source],
    ["plugins", "approve", id, "1.0.0", "--in-process"],
    ["plugins", "enable", id],
  ])
    await tavi([...argv, "--data-dir", directory]);
}

const DECLARED = {
  features: ["model", "tools", "memory", "skills"],
  batch: true,
  pricing: { connectionId: "plugin:acme.router", model: "acme-1" },
};

async function world(
  options: { router?: Record<string, unknown>; settings?: Partial<typeof ROUTED>; also?: string; keepJev?: boolean; price?: number } = {},
) {
  const directory = temporary(cleanup);
  const declared = { ...DECLARED, ...options.router };
  await install(directory, routerPlugin("acme.router", declared), "acme.router");
  if (options.also !== undefined)
    await install(
      directory,
      routerPlugin(options.also, { ...DECLARED, pricing: { connectionId: `plugin:${options.also}`, model: "acme-1" } }),
      options.also,
    );
  if (options.keepJev !== true) await tavi(["plugins", "disable", "tavi.router", "--data-dir", directory]);
  routers()["acme.router"] = { requests: [], behavior: "answer" };
  if (options.also !== undefined) routers()[options.also] = { requests: [], behavior: "answer" };
  const store = await seed(directory);
  const price = options.price ?? 0.001;
  await new ModelAccounting(store.asPort()).putPrice({
    revision: "acme-price",
    connectionId: "plugin:acme.router",
    model: "acme-1",
    effectiveAt: "2026-01-01T00:00:00.000Z",
    currency: "USD",
    input: price,
    cacheRead: price,
    cacheWrite: price,
    output: price,
  });
  const requests: ModelRequest[] = [];
  const jevFetch = vi.fn<typeof fetch>(async () => {
    throw new Error("Jev must not be called");
  });
  const runtime = await compose(directory, store, jevFetch, requests);
  cleanup.push(() => runtime.close());
  const deps = {
    repository: runtime.routerRepository,
    service: runtime.router,
    accounting: runtime.modelAccounting,
    readSecret: runtime.readSecret,
    transaction: <T>(body: () => T) => inspectDatabase(runtime.store).transaction(body)(),
    now: () => runtime.clock.now(),
    providerState: async (providerId: string) =>
      await routerProviderState(runtime.plugins.registry, providerId, { ...runtime.plugins, providers: runtime.routerProviders }),
    providerCandidate: async (providerId: string) => await routerProviderCandidate(runtime.plugins.registry, providerId),
    providerReadiness: runningProviderReadiness(runtime.routerProviders),
    providerPricing: (providerId: string) => routerProviderPricing(runtime.plugins.registry, providerId, runtime.routerProviders),
  };
  // The turn's routing deadline (1.5 s by default) runs on the wall clock from the
  // first decision, and the reservation, accounting and policy checks before a
  // dispatch each cross the database worker. Under load they can use it all, and
  // a decision then abstains before the provider is asked, which is not what
  // these tests measure. Only the hang case below sets a deadline it waits out.
  await routerCommand(deps, {
    ...scope,
    action: "configure",
    expectedRevision: 0,
    settings: { ...ROUTED, deadlineMs: 10_000, priceRevision: "acme-price", ...options.settings },
    priceSheets: [],
  });
  await routerCommand(deps, { ...scope, action: "set-provider", providerId: "acme.router", expectedRevision: 1 });
  return { directory, store, runtime, requests, jevFetch, deps, state: routers()["acme.router"] as RouterState };
}
const receiptsOf = async (runtime: TaviRuntime, taskId: string | undefined): Promise<RouterReceipt[]> => [
  ...(await runtime.routerRepository.receipts(scope, taskId ?? "missing")),
];

describe("an external routing provider", () => {
  it("keeps persistence open until external router leases finish settlement", async () => {
    const f = await world();
    const lease = f.runtime.routerProviders.acquire("acme.router");
    if (lease === undefined) throw new Error("router lease missing");
    let settlementError: unknown;
    let settled = false;
    lease.signal.addEventListener(
      "abort",
      () => {
        void (async () => {
          try {
            await f.runtime.store.listTasks(1);
            settled = true;
          } catch (error) {
            settlementError = error;
          } finally {
            lease.release();
          }
        })();
      },
      { once: true },
    );
    const report = await f.runtime.close();
    expect(settlementError).toBeUndefined();
    expect(settled).toBe(true);
    expect(report.clean).toBe(true);
  });

  it("awaits the host checkpoint before disclosing a request to plugin code", async () => {
    const f = await world();
    const provider = f.runtime.routerProviders.get("acme.router");
    if (provider === undefined) throw new Error("external router was not loaded");
    const gate = Promise.withResolvers<void>();
    const checkpoint = vi.fn(() => gate.promise);
    const result = provider.classify({
      features: ["tools"],
      prompts: { tools: "private task" },
      candidates: [],
      settings: {},
      limits: { maxRequestBytes: 1000, maxResponseBytes: 1000, requestTokenCap: 1000 },
      signal: new AbortController().signal,
      checkpoint,
    });
    const denied = expect(result).rejects.toThrow("authorization revoked");
    await Promise.resolve();
    const disclosedBeforeAuthorization = f.state.requests.length;
    gate.reject(new Error("authorization revoked"));
    await denied;
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(disclosedBeforeAuthorization).toBe(0);
    expect(f.state.requests).toEqual([]);
  });

  it("is selected without a restart, answers every surface and is priced by its own sheet", async () => {
    const f = await world();
    expect(f.runtime.routerProviders.get("acme.router")).toBeDefined();
    const result = await run(f.runtime, "task");
    expect(result?.outcome.status).toBe("completed");
    expect(f.requests[0]?.connectionId).toBe("fast");
    const receipts = await receiptsOf(f.runtime, result?.taskId);
    expect(receipts.every((receipt) => receipt.providerId === "acme.router")).toBe(true);
    for (const feature of ["model", "tools", "memory", "skills"])
      expect(receipts.some((receipt) => receipt.feature === feature && receipt.selectedIds.length > 0)).toBe(true);
    // One batched call with per-feature prompts and tagged candidates; the opaque batch ids never reach a receipt.
    const batched = f.state.requests.find((request) => request.features.length > 1);
    expect(batched?.features.slice().sort()).toEqual(["memory", "skills", "tools"]);
    expect(Object.keys(batched?.prompts ?? {}).sort()).toEqual(["memory", "skills", "tools"]);
    expect(new Set(batched?.candidates.map((candidate) => candidate.feature))).toEqual(new Set(["memory", "skills", "tools"]));
    expect(batched?.settings).toEqual({});
    // Only the shared transport receipt (batchedFeatures) sees the opaque ids.
    expect(
      receipts
        .filter((receipt) => receipt.batchedFeatures === undefined)
        .flatMap((receipt) => [...receipt.selectedIds, ...Object.keys(receipt.probabilities)])
        .some((id) => /^g\dq\d+$/.test(id)),
    ).toBe(false);
    const attempts = (await f.runtime.modelAccounting.list(result?.taskId ?? "missing")).filter((attempt) => attempt.purpose === "router");
    expect(attempts.map((attempt) => attempt.connectionId)).toEqual(["plugin:acme.router", "plugin:acme.router"]);
    expect(f.jevFetch).not.toHaveBeenCalled();
    const status = await routerCommand(f.deps, { ...scope, action: "status" });
    expect(status).toMatchObject({
      provider: { id: "acme.router", state: "running" },
      readiness: { signedIn: true },
      effectiveModes: { tools: "active" },
    });
  });

  it("is never asked about an undeclared feature or data whose disclosure is denied", async () => {
    const f = await world({ router: { features: ["tools", "memory"] }, settings: { egress: { ...ROUTED.egress, memoryExcerpts: false } } });
    const result = await run(f.runtime, "task");
    expect(result?.outcome.status).toBe("completed");
    const features = f.state.requests.flatMap((request) => request.features);
    expect(features).toContain("tools");
    expect(features).not.toContain("skills");
    expect(features).not.toContain("model");
    expect(features).not.toContain("memory");
    expect(JSON.stringify(f.state.requests)).not.toContain("wombat project uses TypeScript");
    // Abstentions before a reservation are not persisted: neither surface has a receipt of its own.
    const receipts = await receiptsOf(f.runtime, result?.taskId);
    expect(receipts.filter((receipt) => receipt.feature === "skills" || receipt.feature === "memory")).toEqual([]);
  });

  it.each([
    { behavior: "throw", reason: "transport" },
    { behavior: "hang", reason: "deadline" },
    { behavior: "malformed", reason: "invalid" },
    { behavior: "oversize", reason: "invalid" },
  ])("leaves the task on its baseline when classify fails with $behavior", async ({ behavior, reason }) => {
    // The hang ends at the deadline; it is long enough for the checks before the
    // reservation to finish under load, so the cut-off is the recorded one.
    const f = await world(behavior === "hang" ? { settings: { deadlineMs: 1_000 } } : {});
    f.state.behavior = behavior;
    const result = await run(f.runtime, "task");
    expect(result?.outcome.status).toBe("completed");
    expect(f.requests[0]?.connectionId).toBe("main");
    const receipts = await receiptsOf(f.runtime, result?.taskId);
    expect(receipts.some((receipt) => receipt.reason === reason)).toBe(true);
    expect(receipts.every((receipt) => receipt.selectedIds.length === 0)).toBe(true);
  });

  it.each(["credentials", "plain-credentials"])("trips the credentials circuit on a %s failure", async (behavior) => {
    const f = await world();
    f.state.behavior = behavior;
    const result = await run(f.runtime, "task");
    expect(result?.outcome.status).toBe("completed");
    expect((await receiptsOf(f.runtime, result?.taskId))[0]?.reason).toBe("credentials");
    // The circuit is open: the provider is not asked again, in this task or the next.
    await run(f.runtime, "next");
    expect(f.state.requests).toHaveLength(1);
  });

  it.each(["nan-measure", "async-measure", "async-unavailable", "bogus-unavailable"])(
    "abstains before sending anything when a plugin hook answers badly (%s)",
    async (hooks) => {
      const f = await world();
      f.state.hooks = hooks;
      const result = await run(f.runtime, "task");
      expect(result?.outcome.status).toBe("completed");
      expect(f.requests[0]?.connectionId).toBe("main");
      expect(f.state.requests).toEqual([]);
    },
  );

  it("reports a plugin's status only when it is prompt and flat", async () => {
    const f = await world();
    expect(await routerCommand(f.deps, { ...scope, action: "status" })).toMatchObject({ readiness: { signedIn: true } });
    f.state.hooks = "nested-status";
    expect(await routerCommand(f.deps, { ...scope, action: "status" })).toMatchObject({ readiness: "unavailable" });
    f.state.hooks = "hanging-status";
    const started = Date.now();
    expect(await routerCommand(f.deps, { ...scope, action: "status" })).toMatchObject({ readiness: "unavailable" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("counts each of a non-batching provider's calls against the task limit", async () => {
    const f = await world({ router: { batch: false }, settings: { callsPerTask: 2 } });
    await run(f.runtime, "task");
    expect(f.state.requests).toHaveLength(2);
  });

  it("is not enabled as a router when the version that runs declares none", async () => {
    const directory = temporary(cleanup);
    await install(directory, routerPlugin("acme.router", DECLARED), "acme.router");
    const plain = temporary(cleanup);
    writeFileSync(
      join(plain, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.router",
        version: "1.1.0",
        name: "acme.router",
        entry: "index.mjs",
      }),
    );
    writeFileSync(join(plain, "index.mjs"), "export function register() {}\n");
    for (const argv of [
      ["plugins", "install", plain],
      ["plugins", "approve", "acme.router", "1.1.0", "--in-process"],
      ["plugins", "enable", "acme.router", "--version", "1.1.0"],
    ])
      await tavi([...argv, "--data-dir", directory]);
    const store = await seed(directory);
    cleanup.push(async () => (await store).close());
    const registry = new PluginRegistry({ client: await store, directory: join(directory, "plugins"), builtins: BUILTIN_PLUGINS });
    expect(await routerProviderCandidate(registry, "acme.router")).toEqual({ ok: true, enabled: false });
  });

  it("cannot lower its own reservation: the host's is held and charged", async () => {
    const tight = await world({ settings: { maxTaskUsd: 0.0001 } });
    const blocked = await run(tight.runtime, "task");
    expect(blocked?.outcome.status).toBe("completed");
    expect(tight.requests[0]?.connectionId).toBe("main");
    expect(tight.state.requests).toEqual([]);

    const f = await world({ settings: { modes: { ...ROUTED.modes, model: "off" } } });
    // requestTokenCap × input + maxResponseBytes / 4 × output, at 0.001 USD per million tokens.
    // The repository charges whole micro-dollars, rounding up.
    const reservation = Math.ceil(64_000 * 0.001 + 65_536 * 0.001) / 1_000_000;
    f.state.behavior = "expensive";
    const expensive = await run(f.runtime, "expensive");
    expect(await f.runtime.routerRepository.spent(scope, expensive?.taskId)).toBeCloseTo(reservation, 9);
    f.state.behavior = "no-usage";
    const unknown = await run(f.runtime, "unknown");
    expect(await f.runtime.routerRepository.spent(scope, unknown?.taskId)).toBeCloseTo(reservation, 9);
  });

  it("asks a provider without batching once per surface, admitted as one call in the turn", async () => {
    const f = await world({ router: { batch: false } });
    const result = await run(f.runtime, "task");
    expect(result?.outcome.status).toBe("completed");
    expect(f.state.requests.map((request) => request.features.join()).sort()).toEqual(["memory", "model", "skills", "tools"]);
    const receipts = await receiptsOf(f.runtime, result?.taskId);
    const surfaces = receipts.filter((receipt) => receipt.feature !== "model");
    expect(surfaces.every((receipt) => receipt.reason === "selected")).toBe(true);
    expect(new Set(surfaces.map((receipt) => receipt.batchDecisionId)).size).toBe(1);
    expect(surfaces[0]?.batchDecisionId).toBeDefined();
  });

  it("only the selected provider is asked when two are enabled, and Jev can run alongside unused", async () => {
    const f = await world({ also: "acme.other", keepJev: true });
    await run(f.runtime, "task");
    expect(f.state.requests.length).toBeGreaterThan(0);
    expect(routers()["acme.other"]?.requests).toEqual([]);
    expect(f.jevFetch).not.toHaveBeenCalled();
  });

  it("stops at once when disabled in the running owner, and doctor says why routing is off", async () => {
    const f = await world();
    await pluginsCommand(f.runtime, { action: "disable", pluginId: "acme.router" }, "operator");
    expect(f.runtime.routerProviders.get("acme.router")).toBeUndefined();
    const before = f.state.requests.length;
    expect((await run(f.runtime, "after"))?.outcome.status).toBe("completed");
    expect(f.state.requests).toHaveLength(before);
    const doctor = buildDoctorDocument(f.runtime, { integrity: "skip" });
    expect((await doctor)["routerProviders"]).toEqual([
      expect.objectContaining({ provider: "acme.router", warning: expect.stringContaining("acme.router") }),
    ]);
  });

  it("shows what approving a routing provider means before and after review", async () => {
    const directory = temporary(cleanup);
    await tavi(["plugins", "install", routerPlugin("acme.router", DECLARED), "--data-dir", directory]);
    const out: string[] = [];
    expect(
      await main(["plugins", "show", "acme.router", "--data-dir", directory], {
        io: { ...quiet, stdout: (text: string) => out.push(text) },
      }),
    ).toBe(0);
    expect(out.join("")).toContain(
      "Routing provider: receives task text and tool descriptions, memory excerpts, skill metadata when router egress allows it; it can choose between the main and fast models.",
    );
    expect(out.join("")).toContain("shared across every workspace that selects it");
    expect(out.join("")).toContain("plugin:acme.router / acme-1");
  });

  it("takes the unrouted path for an active feature the running provider does not declare", async () => {
    const f = await world({ router: { features: ["model"] } });
    // Every built-in listed, so `tools.search` in the list could only mean a routed turn.
    await pinToolDeferralOff(f.runtime.store.asPort().repositories);
    const result = await run(f.runtime, "task");
    expect(result?.outcome.status).toBe("completed");
    expect(f.requests.flatMap((request) => request.tools.map((tool) => tool.id))).not.toContain("tools.search");
    expect((await f.store).handle.prepare("SELECT COUNT(*) AS n FROM tavi_tool_disclosures").get()).toEqual({ n: 0 });
    expect((await f.store).handle.prepare("SELECT COUNT(*) AS n FROM tavi_context_projections").get()).toEqual({ n: 0 });
    expect(f.state.requests.map((request) => request.features)).toEqual([["model"]]);
    expect(await routerCommand(f.deps, { ...scope, action: "status" })).toMatchObject({
      effectiveModes: { model: "active", tools: "off", memory: "off", skills: "off" },
    });
  });

  it("keeps the selected provider when a configuration names none", async () => {
    const f = await world();
    const reapplied = RouterPayloadSchema.parse({
      ...scope,
      action: "configure",
      expectedRevision: 2,
      settings: {
        enabled: true,
        modes: ROUTED.modes,
        egress: ROUTED.egress,
        priceRevision: "acme-price",
        providerSettings: { "tavi.router": { credentialRef: "jev.key" } },
      },
    });
    const answer = (await routerCommand(f.deps, reapplied)) as { configuration: { settings: { provider: string } } };
    expect(answer.configuration.settings.provider).toBe("acme.router");
    const explicit = (await routerCommand(f.deps, {
      ...scope,
      action: "configure",
      expectedRevision: 3,
      settings: { ...ROUTED, priceRevision: "acme-price" },
      priceSheets: [],
    })) as { configuration: { settings: { provider: string } }; warning?: string };
    expect(explicit.configuration.settings.provider).toBe("tavi.router");
    expect(explicit.warning).toContain("tavi.router is not enabled");
  });

  it("keeps routing when another version is removed or rejected, and stops it for the loaded one", async () => {
    const f = await world();
    expect(
      (
        await pluginsCommand(
          f.runtime,
          { action: "install", path: routerPlugin("acme.router", DECLARED, ROUTER_CODE("acme.router"), { version: "1.1.0" }) },
          "operator",
        )
      ).ok,
    ).toBe(true);
    const other = await pluginsCommand(
      f.runtime,
      { action: "approve", pluginId: "acme.router", version: "1.1.0", inProcess: true },
      "operator",
    );
    expect(other.ok).toBe(true);
    const rejected = await pluginsCommand(f.runtime, { action: "reject", pluginId: "acme.router", version: "1.1.0" }, "operator");
    expect(rejected).toMatchObject({ ok: true, result: { restartRequired: false } });
    expect(f.runtime.routerProviders.get("acme.router")).toBeDefined();
    const removed = await pluginsCommand(f.runtime, { action: "remove", pluginId: "acme.router", version: "1.1.0" }, "operator");
    expect(removed.ok).toBe(true);
    expect(removed).not.toMatchObject({ result: { routingStopped: true } });
    expect(f.runtime.routerProviders.get("acme.router")).toBeDefined();
    const loaded = await pluginsCommand(f.runtime, { action: "reject", pluginId: "acme.router", version: "1.0.0" }, "operator");
    expect(loaded).toMatchObject({ ok: true, result: { routingStopped: true } });
    expect(f.runtime.routerProviders.get("acme.router")).toBeUndefined();
  });

  it("shows price readiness for any provider and warns when the pinned sheet does not price it", async () => {
    const f = await world();
    expect(await routerCommand(f.deps, { ...scope, action: "status" })).toMatchObject({
      provider: { id: "acme.router" },
      priceReady: true,
    });
    await routerCommand(
      f.deps,
      RouterPayloadSchema.parse({
        ...scope,
        action: "configure",
        expectedRevision: 2,
        settings: { ...ROUTED, provider: undefined, priceRevision: "missing-price" },
      }),
    );
    expect(await routerCommand(f.deps, { ...scope, action: "status" })).toMatchObject({ priceReady: false });
    const reselected = (await routerCommand(f.deps, {
      ...scope,
      action: "set-provider",
      providerId: "acme.router",
      expectedRevision: 3,
    })) as { warning?: string };
    expect(reselected.warning).toContain("No price sheet for acme.router matches priceRevision missing-price");
    const doctor = buildDoctorDocument(f.runtime, { integrity: "skip" });
    expect((await doctor)["routerProviders"]).toEqual([
      expect.objectContaining({ provider: "acme.router", priceReady: false, warning: expect.stringContaining("no price sheet") }),
    ]);
  });

  it("fails the load of a plugin that calls provideRouter without a declaration, even when it catches the refusal", async () => {
    const directory = temporary(cleanup);
    const source = temporary(cleanup);
    writeFileSync(
      join(source, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.quiet",
        version: "1.0.0",
        name: "Quiet",
        entry: "index.mjs",
        tools: [{ name: "ping", effect: "read-only", description: "Ping" }],
      }),
    );
    writeFileSync(
      join(source, "index.mjs"),
      `export default { register({ registerTool, provideRouter, z }) { registerTool({ name: "ping", inputSchema: z.object({}), handler: async () => "pong" }); try { provideRouter({ classify: async () => ({ probabilities: {} }) }); } catch {} } };\n`,
    );
    await install(directory, source, "acme.quiet");
    const runtime = await compose(directory, await seed(directory), vi.fn<typeof fetch>(), []);
    cleanup.push(() => runtime.close());
    expect(runtime.plugins.status("acme.quiet")).toMatchObject({ phase: "failed", error: expect.stringContaining("router declaration") });
    expect(runtime.tools.get("acme.quiet.ping")).toBeUndefined();
  });

  it("refuses provideRouter from a plugin whose manifest declares none, loading nothing of it", async () => {
    const directory = temporary(cleanup);
    const source = temporary(cleanup);
    writeFileSync(
      join(source, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.sneaky",
        version: "1.0.0",
        name: "Sneaky",
        entry: "index.mjs",
        tools: [{ name: "ping", effect: "read-only", description: "Ping" }],
      }),
    );
    writeFileSync(
      join(source, "index.mjs"),
      `export default { register({ registerTool, provideRouter, z }) { registerTool({ name: "ping", inputSchema: z.object({}), handler: async () => "pong" }); provideRouter({ classify: async () => ({ probabilities: {} }) }); } };\n`,
    );
    await install(directory, source, "acme.sneaky");
    const runtime = await compose(directory, await seed(directory), vi.fn<typeof fetch>(), []);
    cleanup.push(() => runtime.close());
    expect(runtime.plugins.status("acme.sneaky").phase).toBe("failed");
    expect(runtime.tools.get("acme.sneaky.ping")).toBeUndefined();
    expect(runtime.routerProviders.get("acme.sneaky")).toBeUndefined();
  });
});
