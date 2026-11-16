import { join } from "node:path";
import type { ModelRequest } from "@tavi/contracts";
import { ModelConfigService, PluginRegistry } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { pluginsCommand } from "../../src/server/config-commands.js";
import { main } from "../../src/main.js";
import { BUILTIN_PLUGINS } from "../../src/features/plugins/catalog.js";
import { routerCommand, routerProviderState } from "../../src/features/router/owner.js";
import { pinToolDeferralOff } from "../support/prompt-layout.js";
import { ROUTED, compose, rows, routerRows, run, scope, seeded as fixtureSeeded } from "./router-fixtures.js";

const answering = () =>
  vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    return new Response(
      JSON.stringify({
        answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.99 }])),
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
    );
  });

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const seeded = () => fixtureSeeded(cleanup);

/** What the model saw, without the per-run identities (run, memory, admission ids and timestamps). */
const seen = (request: ModelRequest | undefined) =>
  request === undefined
    ? undefined
    : {
        connectionId: request.connectionId,
        model: request.model,
        tools: request.tools.map((tool) => tool.id),
        messages: JSON.stringify(request.messages)
          .replaceAll(request.runId, "<run>")
          .replace(/(mem|memrev)-[0-9a-f-]{36}/g, "$1-<id>")
          .replace(/input-admission-[a-z0-9-]+/g, "input-<id>")
          .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>")
          // The runtime facts' local time is the minute the turn ran in: runs compared here may straddle a minute.
          .replace(/The current local time is [^.]+\./g, "The current local time is <now>.")
          // The working folder is each owner's own data directory's: the runs compared here have one each.
          .replace(/Your working folder is [^;]+;/g, "Your working folder is <folder>;"),
      };
const refuse = () =>
  vi.fn<typeof fetch>(async () => {
    throw new Error("router must not send while its provider is disabled");
  });

describe("tavi.router as a plugin", () => {
  it("binds its provider before the owner admits work", async () => {
    const { directory, store } = await seeded();
    const runtime = await compose(directory, store, refuse(), []);
    cleanup.push(() => runtime.close());
    expect(runtime.routerProviders.get("tavi.router")).toBeDefined();
    expect(BUILTIN_PLUGINS.find((plugin) => plugin.id === "tavi.router")).toMatchObject({ core: false });
  });

  it("disabled or stopped, a fully configured router leaves every task exactly on its baseline", async () => {
    // (a) routing never configured.
    const baseline = await seeded();
    const baselineRequests: ModelRequest[] = [];
    const a = await compose((await baseline).directory, (await baseline).store, refuse(), baselineRequests);
    cleanup.push(() => a.close());
    // Every built-in listed, so `tools.search` in a list could only mean a routed turn.
    await pinToolDeferralOff(a.store.asPort().repositories);
    expect((await run(a, "task"))?.outcome.status).toBe("completed");

    // (b) configured, with tavi.router disabled before the owner starts.
    const disabled = await seeded();
    new PluginRegistry({
      client: (await disabled).store,
      directory: join((await disabled).directory, "plugins"),
      builtins: BUILTIN_PLUGINS,
    }).disable("tavi.router", "operator");
    const disabledFetch = refuse();
    const disabledRequests: ModelRequest[] = [];
    const b = await compose((await disabled).directory, (await disabled).store, disabledFetch, disabledRequests);
    cleanup.push(() => b.close());
    await pinToolDeferralOff(b.store.asPort().repositories);
    b.routerRepository.configure(scope, ROUTED, 0);
    expect(b.routerProviders.get("tavi.router")).toBeUndefined();
    expect((await b.router.configuration(scope)).settings.enabled).toBe(false);
    expect((await run(b, "task"))?.outcome.status).toBe("completed");

    // (c) configured and running, then disabled in the running owner.
    const stopped = await seeded();
    const stoppedFetch = refuse();
    const stoppedRequests: ModelRequest[] = [];
    const c = await compose((await stopped).directory, (await stopped).store, stoppedFetch, stoppedRequests);
    cleanup.push(() => c.close());
    await pinToolDeferralOff(c.store.asPort().repositories);
    c.routerRepository.configure(scope, ROUTED, 0);
    const answer = await pluginsCommand(c, { action: "disable", pluginId: "tavi.router" }, "operator");
    expect(answer).toMatchObject({ ok: true, result: { restartRequired: true } });
    expect(c.routerProviders.get("tavi.router")).toBeUndefined();
    expect((await run(c, "task"))?.outcome.status).toBe("completed");

    expect(disabledFetch).not.toHaveBeenCalled();
    expect(stoppedFetch).not.toHaveBeenCalled();
    const expected = baselineRequests.map(seen);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.flatMap((request) => request?.tools ?? [])).not.toContain("tools.search");
    expect(disabledRequests.map(seen)).toEqual(expected);
    expect(stoppedRequests.map(seen)).toEqual(expected);
    const none = { decisions: 0, routes: 0, disclosures: 0, projections: 0, attempts: 0 };
    expect(routerRows((await disabled).store)).toEqual(none);
    expect(routerRows((await stopped).store)).toEqual(none);
  });

  it("stops egress immediately: disabling in a running owner aborts the in-flight decision", async () => {
    const { directory, store } = await seeded();
    const routerFetch = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const requests: ModelRequest[] = [];
    const runtime = await compose(directory, store, routerFetch, requests);
    cleanup.push(() => runtime.close());
    // Every built-in listed, so `tools.search` in the list could only mean a routed turn.
    await pinToolDeferralOff(runtime.store.asPort().repositories);
    await runtime.routerRepository.configure(scope, { ...ROUTED, deadlineMs: 10_000 }, 0);
    const pending = run(runtime, "slow");
    await vi.waitFor(() => expect(routerFetch).toHaveBeenCalled(), { interval: 5, timeout: 5_000 });
    await pluginsCommand(runtime, { action: "disable", pluginId: "tavi.router" }, "operator");
    expect((await pending)?.outcome.status).toBe("completed");
    const receipts = store.handle.prepare("SELECT data FROM tavi_router_decisions").all() as { data: string }[];
    expect(receipts.length).toBeGreaterThan(0);
    for (const row of receipts) {
      const receipt = JSON.parse(row.data) as { state: string; reason: string; selectedIds: string[] };
      expect(receipt.state).not.toBe("pending");
      if (receipt.reason !== "no-candidates") expect(["provider", "stale"]).toContain(receipt.reason);
      expect(receipt.selectedIds).toEqual([]);
    }
    // Every reservation and provider attempt was settled, not left pending.
    expect(
      store.handle.prepare("SELECT state FROM tavi_provider_attempts WHERE json_extract(data, '$.purpose')='router'").all(),
    ).not.toContainEqual({ state: "started" });
    expect(await runtime.routerRepository.spent(scope)).toBeGreaterThan(0);
    const calls = routerFetch.mock.calls.length;
    expect((await run(runtime, "after"))?.outcome.status).toBe("completed");
    expect(routerFetch).toHaveBeenCalledTimes(calls);
    expect(requests.at(-1)?.tools.map((tool) => tool.id)).not.toContain("tools.search");
  });

  it("resumes after re-enabling and a restart, with the configuration and earlier receipts intact", async () => {
    const { directory, store } = await seeded();
    const first = await compose(directory, store, answering(), []);
    first.routerRepository.configure(scope, { ...ROUTED, modes: { ...ROUTED.modes, model: "off" } }, 0);
    await run(first, "routed");
    await pluginsCommand(first, { action: "disable", pluginId: "tavi.router" }, "operator");
    await run(first, "while-disabled");
    await first.close();
    const reopened = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    new PluginRegistry({ client: reopened, directory: join(directory, "plugins"), builtins: BUILTIN_PLUGINS }).enable(
      "tavi.router",
      "operator",
    );
    const receiptsBefore = rows(reopened, "tavi_router_decisions");
    expect(receiptsBefore).toBeGreaterThan(0);
    reopened.close();
    const answer = answering();
    const second = await compose(directory, undefined, answer, []);
    cleanup.push(() => second.close());
    expect(await second.router.configuration(scope)).toMatchObject({ revision: 1, settings: { enabled: true } });
    expect((await run(second, "after-restart"))?.outcome.status).toBe("completed");
    expect(answer).toHaveBeenCalled();
    expect(rows(second.store, "tavi_router_decisions")).toBeGreaterThan(receiptsBefore);
  });

  it("reports the provider's state through the owner and offline", async () => {
    const { directory, store } = await seeded();
    const runtime = await compose(directory, store, refuse(), []);
    const deps = {
      repository: runtime.routerRepository,
      service: runtime.router,
      accounting: runtime.modelAccounting,
      readSecret: runtime.readSecret,
      transaction: <T>(body: () => T) => body(),
      now: () => runtime.clock.now(),
      providerState: async (providerId: string) =>
        await routerProviderState(runtime.plugins.registry, providerId, { ...runtime.plugins, providers: runtime.routerProviders }),
    };
    await routerCommand(deps, { ...scope, action: "configure", expectedRevision: 0, settings: ROUTED, priceSheets: [] });
    expect(await routerCommand(deps, { ...scope, action: "status" })).toMatchObject({
      provider: { id: "tavi.router", state: "running" },
      effectiveModes: { tools: "active" },
    });
    await pluginsCommand(runtime, { action: "disable", pluginId: "tavi.router" }, "operator");
    expect(await routerCommand(deps, { ...scope, action: "status" })).toMatchObject({
      provider: { state: "disabled" },
      configuration: { settings: { enabled: true } },
      effectiveModes: { tools: "off" },
    });
    await runtime.close();
    store.close();
    const output: string[] = [];
    expect(
      await main(["router", "status", "--data-dir", directory], {
        io: {
          isTty: false,
          stdout: (text: string) => output.push(text),
          stderr: () => {},
        },
      }),
    ).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      provider: { id: "tavi.router", state: "disabled" },
      effectiveModes: { tools: "off" },
    });
  });

  it("reports a failed provider with its error, and one that is not installed", async () => {
    const { directory, store } = await seeded();
    cleanup.push(() => store.close());
    const registry = new PluginRegistry({ client: store, directory: join(directory, "plugins"), builtins: BUILTIN_PLUGINS });
    const live = { providers: { get: () => undefined }, status: () => ({ phase: "failed" as const, error: "no credential" }) };
    expect(await routerProviderState(registry, "tavi.router", live)).toEqual({ state: "failed", error: "no credential" });
    expect(await routerProviderState(registry, "acme.router", live)).toEqual({ state: "not-installed" });
  });
});

describe("saved model routes without a provider", () => {
  const choosingFast = () =>
    vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const answers =
        body.questions["selection"] === undefined
          ? Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.99 }]))
          : { selection: { type: "choice", choice: "fast", probabilities: { main: 0.01, fast: 0.99 } } };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 0 } }));
    });
  const reply = (runtime: TaviRuntime, taskId: string, key: string) =>
    runtime.workflow?.admit({
      context: { ...scope, runId: taskId, caller: "cli" },
      operationKey: key,
      kind: "reply",
      taskId,
      prompt: "and again",
    });

  it("keeps a routed task on its saved model and fallback after the provider is disabled", async () => {
    const { directory, store } = await seeded();
    const models = new ModelConfigService(store.asPort());
    await models.setRoleBinding({
      workspaceId: "default",
      role: "fast",
      target: { connectionId: "fast", model: "m" },
      fallback: [{ connectionId: "main", model: "m" }],
    });
    const routerFetch = choosingFast();
    const requests: ModelRequest[] = [];
    const runtime = await compose(directory, store, routerFetch, requests);
    cleanup.push(() => runtime.close());
    await runtime.routerRepository.configure(scope, ROUTED, 0);
    const started = await run(runtime, "routed");
    const taskId = started?.taskId ?? "missing";
    const route = await runtime.routerRepository.route(scope, taskId);
    expect(route).toMatchObject({ origin: "router", target: { connectionId: "fast" }, fallback: [{ connectionId: "main", model: "m" }] });
    expect(requests.at(-1)?.connectionId).toBe("fast");
    await pluginsCommand(runtime, { action: "disable", pluginId: "tavi.router" }, "operator");
    const calls = routerFetch.mock.calls.length;
    const modelReceipts = (await runtime.routerRepository.receipts(scope, taskId)).filter((receipt) => receipt.feature === "model").length;
    expect((await reply(runtime, taskId, "after-disable"))?.outcome.status).toBe("completed");
    expect(requests.at(-1)?.connectionId).toBe("fast");
    expect(await runtime.routerRepository.route(scope, taskId)).toEqual(route);
    expect(await runtime.taskRouting.effectiveTarget?.(scope, taskId)).toEqual({ connectionId: "fast", model: "m" });
    // With its target gone, the task falls back along its saved chain, still without the provider.
    await models.putCatalogEntry({ connectionId: "fast", modelId: "m", provenance: "live", state: "unavailable", capabilities: [] });
    expect((await reply(runtime, taskId, "fallback"))?.outcome.status).toBe("completed");
    expect(requests.at(-1)?.connectionId).toBe("main");
    expect(await runtime.taskRouting.effectiveTarget?.(scope, taskId)).toEqual({ connectionId: "main", model: "m" });
    expect((await runtime.routerRepository.receipts(scope, taskId)).filter((receipt) => receipt.feature === "model")).toHaveLength(
      modelReceipts,
    );
    expect(routerFetch).toHaveBeenCalledTimes(calls);
  });

  it("saves no route for a new task while the provider is disabled", async () => {
    const { directory, store } = await seeded();
    new PluginRegistry({ client: store, directory: join(directory, "plugins"), builtins: BUILTIN_PLUGINS }).disable(
      "tavi.router",
      "operator",
    );
    const requests: ModelRequest[] = [];
    const runtime = await compose(directory, store, refuse(), requests);
    cleanup.push(() => runtime.close());
    await runtime.routerRepository.configure(scope, ROUTED, 0);
    const started = await run(runtime, "new");
    expect(await runtime.routerRepository.route(scope, started?.taskId ?? "missing")).toBeUndefined();
    expect(requests.at(-1)?.connectionId).toBe("main");
  });

  it.each([
    {
      name: "its model is unavailable",
      change: async (models: ModelConfigService) =>
        await models.putCatalogEntry({ connectionId: "fast", modelId: "m", provenance: "live", state: "unavailable", capabilities: [] }),
    },
    {
      name: "its connection was removed",
      change: async (_models: ModelConfigService, store: SqliteStore) =>
        await store.asPort().repositories.modelConfig.deleteConnection("fast"),
    },
  ])("still refuses a saved target when $name", async ({ change }) => {
    const { directory, store } = await seeded();
    const runtime = await compose(directory, store, choosingFast(), []);
    cleanup.push(() => runtime.close());
    await runtime.routerRepository.configure(scope, ROUTED, 0);
    const taskId = (await run(runtime, "routed"))?.taskId ?? "missing";
    await pluginsCommand(runtime, { action: "disable", pluginId: "tavi.router" }, "operator");
    await change(new ModelConfigService(store.asPort()), store);
    await expect(Promise.resolve(reply(runtime, taskId, "gone"))).rejects.toThrow(/saved model route is unavailable/);
  });
});
