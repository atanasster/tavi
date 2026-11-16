import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaviError, RouterSettingsSchema, type RouterPort, type TaskRoutingPort } from "@tavi/contracts";
import { ModelAccounting, ModelConfigService, RouterRepository } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import { resumeTargetRefusal } from "../../src/shared/ipc-decisions.js";
import { createTaskRouting, LOCAL_CHAIN_UNAVAILABLE, type TaskRoutingOptions } from "../../src/features/router/task-routing.js";
import { connectionLocality } from "@tavi/agent-host/task-summarizer";

const at = "2026-09-25T00:00:00.000Z";
const scope = { workspaceId: "default", principalId: "alice" };
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
async function fixture() {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  cleanup.push(() => store.close());
  const repositories = store.asPort().repositories;
  const models = repositories.modelConfig;
  const service = new ModelConfigService(store.asPort(), { now: () => at });
  await Promise.all(
    ["main", "fast", "backup"].map(
      async (id) =>
        await service.putConnection({ connectionId: id, label: id, baseUrl: `https://${id}.example/v1`, credentialRef: `${id}.key` }),
    ),
  );
  for (const id of ["main", "fast", "backup"])
    await service.putCatalogEntry({
      connectionId: id,
      modelId: id,
      provenance: "live",
      state: "capable",
      capabilities: ["tools", "streaming"],
      contextWindow: 128_000,
      maxTokens: 4096,
    });
  await service.setRoleBinding({
    workspaceId: scope.workspaceId,
    role: "fast",
    target: { connectionId: "fast", model: "fast" },
    fallback: [{ connectionId: "backup", model: "backup" }],
  });
  const repository = new RouterRepository(store, () => true);
  const settings = RouterSettingsSchema.parse({ enabled: true, modes: { model: "active" } });
  await repository.configure(scope, settings, 0);
  const accounting = new ModelAccounting(store.asPort());
  for (const id of ["main", "fast", "backup"])
    await accounting.putPrice({
      revision: `${id}-price`,
      connectionId: id,
      model: id,
      effectiveAt: at,
      currency: "USD",
      input: id === "main" ? 2 : 1,
      cacheRead: 0,
      cacheWrite: 0,
      output: 2,
    });
  let sequence = 0;
  const input = async (
    patch: Partial<Parameters<TaskRoutingPort["prepare"]>[0]> = {},
  ): Promise<Parameters<TaskRoutingPort["prepare"]>[0]> => {
    sequence++;
    const task = await repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      ...scope,
      operationKey: `start-${sequence}`,
      kind: "start",
      intent: {},
      checkpointNamespace: "",
      newTaskId: (() => `task-${sequence}`)(),
      newThreadId: (() => `thread-${sequence}`)(),
      newAdmissionId: (() => `admission-${sequence}`)(),
      now: (() => at)(),
    });
    const lease = await repositories.executions.acquire({
      taskId: task.task.taskId,
      admissionId: task.admission.admissionId,
      ownerSession: "owner",
      leaseMs: 60_000,
      now: { fixed: (() => at)() },
    });
    return {
      scope,
      fence: { taskId: task.task.taskId, generation: lease.generation, ownerSession: "owner" },
      turnId: task.admission.admissionId,
      newTask: true,
      explicit: false,
      interactive: true,
      prompt: "small edit",
      requestBytes: 1000,
      signal: new AbortController().signal,
      isCurrent: () => true,
      ...patch,
    };
  };
  const decide = vi.fn<RouterPort["decide"]>(async (request) => ({
    decisionId: "decision",
    operationId: request.operationId,
    taskId: request.fence.taskId,
    providerId: "tavi.router",
    turnId: request.turnId,
    feature: "model",
    mode: (await repository.configuration(scope)).settings.modes.model,
    configRevision: 1,
    policyVersion: "v1",
    candidateHash: "0".repeat(64),
    permissionRevision: "p",
    state: "finished",
    reason: "selected",
    selectedIds: request.beforeDecision === undefined || (await request.beforeDecision()) ? ["fast"] : [],
    probabilities: { fast: 0.99 },
    cacheHit: false,
    elapsedMs: 1,
    startedAt: at,
  }));
  const router: RouterPort = {
    configuration: async (actor) => await repository.configuration(actor),
    decide,
    disable() {},
    async dispose() {},
  };
  const create = async (patch: Partial<TaskRoutingOptions> = {}) =>
    createTaskRouting({
      router,
      repository,
      models,
      connection: async (id) => {
        const stored = await models.getConnection(id);
        if (stored === undefined) return undefined;
        const { headers, ...connection } = stored;
        return { ...connection, ...(headers === undefined ? {} : { headers }) };
      },
      baseline: { connectionId: "main", model: "main" },
      fallback: [],
      readSecret: async () => "key",
      price: async (target, time) => await accounting.price(target.connectionId, target.model, time),
      now: () => at,
      ...patch,
    });
  return { store, models, repository, settings, decide, input, create, routing: await create() };
}

describe("task-local model policy", () => {
  it("persists separate routes before use and restores them after restart and disable", async () => {
    const f = await fixture();
    const auto = await f.input();
    const explicit = await f.input({ explicit: true });
    const [routed, fixed] = await Promise.all([f.routing.prepare(auto), f.routing.prepare(explicit)]);
    expect(routed).toMatchObject({ origin: "router", target: { model: "fast" }, fallback: [{ model: "backup" }] });
    expect(fixed).toMatchObject({ origin: "explicit", target: { model: "main" } });
    await f.repository.configure(scope, { ...f.settings, enabled: false }, 1);
    expect(await (await f.create()).prepare({ ...auto, newTask: false })).toEqual(routed);
    expect(f.decide).toHaveBeenCalledOnce();
  });
  it.each([{ explicit: true }, { newTask: false }, { interactive: false }, { requestBytes: 200_000 }])(
    "never classifies ineligible admissions %j",
    async (patch) => {
      const f = await fixture();
      await f.routing.prepare(await f.input(patch));
      expect(f.decide).not.toHaveBeenCalled();
    },
  );
  it("requires an explicit fast binding and verified capability", async () => {
    const f = await fixture();
    await f.models.clearRoleBinding(scope.workspaceId, "fast");
    expect(await f.routing.prepare(await f.input())).toMatchObject({ origin: "baseline" });
    expect(f.decide).not.toHaveBeenCalled();
    const g = await fixture();
    await g.models.downgradeCapabilities("fast");
    expect(await g.routing.prepare(await g.input())).toMatchObject({ origin: "baseline" });
    expect(g.decide).not.toHaveBeenCalled();
  });
  it("keeps unknown price and shadow selections on main", async () => {
    const f = await fixture();
    f.store.handle.prepare("DELETE FROM tavi_model_price_sheets WHERE connection_id='fast'").run();
    expect(await f.routing.prepare(await f.input())).toMatchObject({ origin: "baseline" });
    expect(f.decide).toHaveBeenCalledOnce();
    const g = await fixture();
    await g.repository.configure(scope, { ...g.settings, modes: { ...g.settings.modes, model: "shadow" } }, 1);
    expect(await g.routing.prepare(await g.input())).toMatchObject({ origin: "baseline" });
  });
  it("uses only saved available fallbacks and refuses a removed chain", async () => {
    const f = await fixture();
    const input = await f.input();
    await f.routing.prepare(input);
    await f.models.deleteConnection("fast");
    expect(await f.routing.prepare({ ...input, newTask: false })).toMatchObject({ target: { model: "backup" }, fallback: [] });
    const task = await f.store.asPort().repositories.tasks.get((await input).fence.taskId);
    if (task === undefined) throw new Error("missing task fixture");
    const deps = {
      target: { connectionId: "main", model: "main", source: "role" },
      targetForTask: async () => ({
        ...((await f.routing.effectiveTarget?.(scope, (await input).fence.taskId)) ?? { connectionId: "missing", model: "missing" }),
        source: "saved",
      }),
    };
    expect(await resumeTargetRefusal(deps, { model: "backup" }, task)).toBeUndefined();
    expect((await resumeTargetRefusal(deps, { model: "main" }, task))?.error.code).toBe("INVALID_INPUT");
    await f.models.deleteConnection("backup");
    await expect(f.routing.prepare({ ...input, newTask: false })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
  it("lets a person choose a chat's model, replayed by its later turns", async () => {
    const f = await fixture();
    const input = await f.input();
    await f.routing.prepare(input);
    const taskId = input.fence.taskId;
    expect(await f.routing.choose?.(scope, taskId, { connectionId: "backup", model: "backup" })).toMatchObject({
      origin: "explicit",
      target: { model: "backup" },
      fallback: [],
    });
    expect(await f.routing.prepare({ ...input, newTask: false })).toMatchObject({ target: { model: "backup" } });
    expect(await f.routing.effectiveTarget?.(scope, taskId)).toEqual({ connectionId: "backup", model: "backup" });
    await expect(f.routing.choose?.(scope, taskId, { connectionId: "missing", model: "m" })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
    // A model its connection's catalog does not list is refused when picked, not at every later turn.
    await expect(f.routing.choose?.(scope, taskId, { connectionId: "backup", model: "typo" })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
    expect(await f.routing.accepts?.(scope, { connectionId: "backup", model: "typo" })).toBe(false);
    // Nothing discovered on a connection yet: any model is taken.
    await f.models.replaceCatalog("fast", []);
    expect(await f.routing.accepts?.(scope, { connectionId: "fast", model: "anything" })).toBe(true);
    expect(await f.routing.effectiveTarget?.(scope, taskId)).toEqual({ connectionId: "backup", model: "backup" });
  });
  it("replays a model chosen for a chat that had no saved route, with routing off", async () => {
    const f = await fixture();
    await f.repository.configure(scope, { ...f.settings, enabled: false }, 1);
    const input = await f.input();
    expect(await f.routing.prepare(input)).toBeUndefined();
    await f.routing.choose?.(scope, input.fence.taskId, { connectionId: "fast", model: "fast" });
    expect(await f.routing.prepare({ ...input, newTask: false })).toMatchObject({
      origin: "explicit",
      target: { model: "fast" },
      fallback: [],
    });
  });
  it("rejects stale provider results after permission revocation", async () => {
    const f = await fixture();
    let authorized = true;
    f.decide.mockImplementationOnce(async (request) => {
      authorized = false;
      return {
        decisionId: "d",
        operationId: request.operationId,
        taskId: request.fence.taskId,
        providerId: "tavi.router",
        turnId: request.turnId,
        feature: "model",
        mode: "active",
        configRevision: 1,
        policyVersion: "v1",
        candidateHash: "0".repeat(64),
        permissionRevision: "p",
        state: "finished",
        reason: "selected",
        selectedIds: ["fast"],
        probabilities: {},
        cacheHit: false,
        elapsedMs: 1,
        startedAt: at,
      };
    });
    const input = await f.input({ isCurrent: () => authorized });
    await expect(f.routing.prepare(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await f.repository.route(scope, (await input).fence.taskId)).toBeUndefined();
  });
});

it("preserves explicit transport overrides and does no route validation while globally off", async () => {
  const f = await fixture();
  const routing = await f.create({
    connection: async (id) =>
      id === "main"
        ? {
            connectionId: "main",
            kind: "openai-compatible",
            baseUrl: "https://explicit.example/v1",
            credentialRef: "override.key",
            headers: { "OpenAI-Organization": "override-org" },
          }
        : undefined,
  });
  expect(await (await routing).prepare(await f.input({ explicit: true }))).toMatchObject({ origin: "explicit", target: { model: "main" } });
  await f.repository.configure(scope, { ...f.settings, enabled: false }, 1);
  expect(await (await f.create({ connection: async () => undefined })).prepare(await f.input())).toBeUndefined();
});
it.each(["shadow", "active"] as const)("keeps baseline after typed optional credential failure in %s", async (mode) => {
  const f = await fixture();
  await f.repository.configure(scope, { ...f.settings, modes: { ...f.settings.modes, model: mode } }, 1);
  const routing = await f.create({
    readSecret: async () => {
      throw new TaviError("UNAVAILABLE", "credential key missing");
    },
  });
  expect(await (await routing).prepare(await f.input())).toMatchObject({ origin: "baseline", target: { model: "main" } });
});

it("runs the default as configured now for a chat with no saved route", async () => {
  const f = await fixture();
  let live: { connectionId: string; model: string }[] | undefined = [{ connectionId: "backup", model: "backup" }];
  const routing = await f.create({ liveBaseline: async () => live });
  expect(await routing.baseline?.(scope)).toEqual([{ connectionId: "backup", model: "backup" }]);
  expect(await routing.prepare(await f.input({ explicit: true }))).toMatchObject({ origin: "explicit", target: { model: "backup" } });
  live = undefined;
  expect(await routing.baseline?.(scope)).toBeUndefined();
  expect(await routing.prepare(await f.input({ explicit: true }))).toMatchObject({ target: { model: "main" } });
});
it("replays a scoped external baseline and refuses it after withdrawal", async () => {
  const f = await fixture();
  let active = true;
  const providerTarget = vi.fn(async (target, actor) =>
    target.connectionId === "plugin.model"
      ? active && actor.workspaceId === scope.workspaceId && actor.principalId === scope.principalId
      : undefined,
  );
  const routing = await f.create({
    baseline: { connectionId: "plugin.model", model: "m" },
    connection: async () => undefined,
    providerTarget,
  });
  const input = await f.input({ explicit: true });
  expect(await routing.prepare(input)).toMatchObject({ target: { connectionId: "plugin.model", model: "m" } });
  expect(await routing.effectiveTarget?.(scope, input.fence.taskId)).toEqual({ connectionId: "plugin.model", model: "m" });
  active = false;
  await expect(routing.prepare({ ...input, newTask: false })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  expect(providerTarget).toHaveBeenCalledWith({ connectionId: "plugin.model", model: "m" }, scope);
});

describe("a chat on a local connection", () => {
  /** The fixture plus a connection on this machine, `local`, the chat's default; `locality` read from the stored records. */
  async function local() {
    const f = await fixture();
    const service = new ModelConfigService(f.store.asPort(), { now: () => at });
    await service.putConnection({
      connectionId: "local",
      label: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      credentialRef: "local.key",
    });
    await service.putCatalogEntry({
      connectionId: "local",
      modelId: "local",
      provenance: "live",
      state: "capable",
      capabilities: ["tools", "streaming"],
      contextWindow: 128_000,
      maxTokens: 4096,
    });
    const locality = async (connectionId: string) => {
      const stored = await f.models.getConnection(connectionId);
      return stored === undefined ? undefined : connectionLocality(stored);
    };
    return { ...f, locality };
  }

  it("keeps only local fallbacks in its default chain", async () => {
    const f = await local();
    const routing = await f.create({
      baseline: { connectionId: "local", model: "local" },
      fallback: [
        { connectionId: "main", model: "main" },
        { connectionId: "local", model: "other" },
      ],
      locality: f.locality,
    });
    expect(await routing.baseline?.(scope)).toEqual([
      { connectionId: "local", model: "local" },
      { connectionId: "local", model: "other" },
    ]);
    // A remote default keeps its chain whole.
    const remote = await f.create({ fallback: [{ connectionId: "local", model: "local" }], locality: f.locality });
    expect(await remote.baseline?.(scope)).toBeUndefined();
  });

  it("never asks the router, nor saves a remote fallback, for a chat on a local default", async () => {
    const f = await local();
    const routing = await f.create({
      baseline: { connectionId: "local", model: "local" },
      fallback: [{ connectionId: "backup", model: "backup" }],
      locality: f.locality,
    });
    expect(await routing.prepare(await f.input())).toMatchObject({ origin: "baseline", target: { connectionId: "local" }, fallback: [] });
    expect(f.decide).not.toHaveBeenCalled();
  });

  it("keeps its local chain when the default later turns remote, with routing off", async () => {
    const f = await local();
    await f.repository.configure(scope, { ...f.settings, enabled: false }, 1);
    let live = [
      { connectionId: "local", model: "local" },
      { connectionId: "backup", model: "backup" },
    ];
    const routing = await f.create({ liveBaseline: async () => live, locality: f.locality });
    const input = await f.input();
    expect(await routing.prepare(input)).toMatchObject({ target: { connectionId: "local" }, fallback: [] });
    live = [{ connectionId: "main", model: "main" }];
    expect(await routing.prepare({ ...input, newTask: false })).toMatchObject({ target: { connectionId: "local" }, fallback: [] });
  });

  it("refuses the next turn of a chat that ran locally with no saved chain once the default is remote", async () => {
    const f = await local();
    await f.repository.configure(scope, { ...f.settings, enabled: false }, 1);
    const input = await f.input();
    const routing = await f.create({ locality: f.locality, chatIsLocal: async (_scope, taskId) => taskId === input.fence.taskId });
    await expect(routing.prepare({ ...input, newTask: false })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      message: LOCAL_CHAIN_UNAVAILABLE,
    });
    // A chat that never ran locally goes on as before.
    expect(await routing.prepare({ ...(await f.input()), newTask: false })).toBeUndefined();
  });

  it("refuses, saying why, rather than run a saved local route on its remote fallback", async () => {
    const f = await local();
    const routing = await f.create({ baseline: { connectionId: "local", model: "local" }, locality: f.locality });
    const input = await f.input();
    await f.repository.saveRoute(scope, input.fence, {
      taskId: input.fence.taskId,
      target: { connectionId: "local", model: "local" },
      fallback: [{ connectionId: "backup", model: "backup" }],
      origin: "explicit",
      configRevision: 1,
      createdAt: at,
    });
    await f.models.replaceCatalog("local", [
      { connectionId: "local", modelId: "local", provenance: "live", state: "unavailable", capabilities: [], updatedAt: at } as never,
    ]);
    await expect(routing.prepare({ ...input, newTask: false })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      message: LOCAL_CHAIN_UNAVAILABLE,
    });
  });
});
