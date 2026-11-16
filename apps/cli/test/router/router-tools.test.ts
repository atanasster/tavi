import { pinPromptLayoutV1 } from "../support/prompt-layout.js";
import { z } from "zod";
import * as contextModule from "@tavi/agent-host/context";
import {
  ALLOWLIST_ONLY_TOOL_IDS,
  ATTENDED_TASK_POLICY,
  RouterSettingsSchema,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";

/** What a turn under the attended policy is offered: every offered tool but those only a task's allowlist may name (`heartbeat.report`). */
const offeredToATurn = (tools: readonly { readonly id: string }[]): string[] =>
  tools.map((tool) => tool.id).filter((id) => !ALLOWLIST_ONLY_TOOL_IDS.includes(id));
const scope = { workspaceId: "default", principalId: "operator" };
const cleanup: (() => Promise<void>)[] = [];
const directories = temporaryDirectories({ prefix: "tavi-router-tools-" });
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  directories.cleanup();
});
const complete = (request: ModelRequest, toolCalls: ModelOutcome["toolCalls"] = []): ModelOutcome => ({
  status: "completed",
  attemptId: request.attemptId,
  text: toolCalls.length ? "" : "done",
  toolCalls,
  usage: {},
});
async function fixture(stream: ModelPort["stream"], mode: "off" | "shadow" | "active" = "active", fallback = false) {
  const directory = directories.create();
  const runtime = await composeTaviRuntime(
    {
      dataDirectory: directory,
      workspaces: [{ ...scope, permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      providers: ["fixture", ...(fallback ? ["backup"] : [])].map((connectionId) => ({
        connectionId,
        kind: "openai-compatible",
        baseUrl: "https://fixture.invalid/v1",
        credentialRef: `${connectionId}.key`,
      })),
      ...(fallback ? { modelFallback: [{ connectionId: "backup", model: "m" }] } : {}),
      credentials: {},
      defaultConnectionId: "fixture",
      defaultModel: "m",
      logger: { level: "error", sink: () => {} },
      approvalRequiredFor: ["mutating", "external"],
    },
    { modelOverride: { stream } },
  );
  cleanup.push(async () => {
    await runtime.close();
  });
  await runtime.routerRepository.configure(scope, RouterSettingsSchema.parse({ enabled: mode !== "off", modes: { tools: mode } }), 0);
  // These are routing's tests, under the layout that lists every tool: v2's deferral is tested beside it.
  await pinPromptLayoutV1(runtime.store.asPort().repositories, scope.workspaceId);
  const start = (prompt = "unrelated task") => {
    if (runtime.workflow === undefined) throw new Error("missing workflow");
    return runtime.workflow.admit({
      context: { ...scope, runId: "pending", caller: "cli" },
      operationKey: `start-${Math.random()}`,
      kind: "start",
      prompt,
      origin: "cli",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
  };
  return { runtime, start };
}
describe("routed tools in the workflow", () => {
  it("takes an undisclosed mutation called by its exact name with valid input as a discovery, through its normal approval", async () => {
    const requests: ModelRequest[] = [];
    const f = await fixture(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        expect(request.tools.some((tool) => tool.id === "fixture.zebra")).toBe(false);
        // Called by its exact name, with input its schema takes: a discovery, as a search would be.
        return complete(request, [{ id: "write", name: "fixture.zebra", input: {} }]);
      }
      return complete(request);
    });
    const execute = vi.fn(async () => ({ saved: true }));
    f.runtime.tools.register({
      id: "fixture.zebra",
      sink: "none",
      version: "1",
      description: "zebra mutation",
      effect: "mutating",
      requiredPermissions: ["tools.invoke"],
      inputSchema: z.strictObject({}),
      handler: execute,
    });
    const pending = await f.start();
    expect(pending.outcome.status).toBe("waiting");
    expect(execute).not.toHaveBeenCalled();
    const approvals = await f.runtime.store.asPort().repositories.approvals.listForTask(pending.taskId);
    expect(approvals.map((row) => row.callId)).toEqual(["write"]);
    const resumed = await f.runtime.workflow?.admit({
      context: { ...scope, runId: pending.taskId, caller: "cli" },
      taskId: pending.taskId,
      operationKey: "approve",
      kind: "approval",
      resume: { approved: true },
    });
    expect(resumed?.outcome.status).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
    for (const request of requests) {
      const disclosure = await f.runtime.routerRepository.disclosure(scope, pending.taskId, request.attemptId);
      expect(disclosure?.tools.map((tool) => tool.id)).toEqual(request.tools.map((tool) => tool.id));
      expect(request.tools.length).toBeLessThanOrEqual(64);
    }
    expect((await f.start()).outcome.status).toBe("completed");
    expect(requests.at(-1)?.tools.some((tool) => tool.id === "fixture.zebra")).toBe(false);
  });
  it("rechecks permissions before a special handler", async () => {
    let runtime: TaviRuntime | undefined;
    let count = 0;
    const f = await fixture(async (request) => {
      count++;
      if (count === 1) {
        if (runtime === undefined) throw new Error("runtime not initialized");
        const original = runtime.access.missingPermissions.bind(runtime.access);
        vi.spyOn(runtime.access, "missingPermissions").mockImplementation((context, required) => [
          ...new Set([...original(context, required), ...required.filter((permission) => permission === "tools.invoke")]),
        ]);
        return complete(request, [{ id: "ask", name: "operator.ask_user", input: { question: "hello" } }]);
      }
      expect(JSON.stringify(request.messages)).toContain("TOOL_NOT_DISCLOSED");
      return complete(request);
    });
    runtime = f.runtime;
    const result = await f.start();
    expect(result.outcome.status).toBe("completed");
    expect(await runtime.store.asPort().repositories.approvals.listForTask(result.taskId)).toEqual([]);
  });
  it.each(["off", "shadow"] as const)("keeps %s descriptors unchanged and excludes the discovery capability", async (mode) => {
    const requests: ModelRequest[] = [];
    const f = await fixture(async (request) => {
      requests.push(request);
      return complete(request);
    }, mode);
    const result = await f.start();
    expect(result.outcome.status).toBe("completed");
    expect(requests[0]?.tools.map((tool) => tool.id)).toEqual(
      offeredToATurn(await f.runtime.tools.listOffered({ workspaceId: "default", outsideConversation: true })),
    );
    expect(requests[0]?.tools.some((tool) => tool.id === "tools.search")).toBe(false);
  });
});

it("refuses revoked and unknown tools in a multi-call reply without invoking either", async () => {
  let visible = true;
  let count = 0;
  const execute = vi.fn(async () => "executed");
  const f = await fixture(async (request) => {
    count++;
    if (count === 1) {
      expect(request.tools.some((tool) => tool.id === "fixture.visible")).toBe(true);
      visible = false;
      return complete(request, [
        { id: "revoked", name: "fixture.visible", input: {} },
        { id: "unknown", name: "fixture.missing", input: {} },
      ]);
    }
    const errors = request.messages.filter((message) => message.role === "tool").flatMap((message) => message.toolResults ?? []);
    expect(errors).toHaveLength(2);
    expect(errors.every((result) => result.isError)).toBe(true);
    return complete(request);
  });
  f.runtime.tools.register({
    id: "fixture.visible",
    sink: "none",
    version: "1",
    description: "visible operation",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: z.strictObject({}),
    handler: execute,
    offered: () => visible,
  });
  expect((await f.start("visible")).outcome.status).toBe("completed");
  expect(execute).not.toHaveBeenCalled();
});
it("records disclosure for each transport fallback attempt", async () => {
  const requests: ModelRequest[] = [];
  const f = await fixture(
    async (request) => {
      requests.push(request);
      return request.connectionId === "fixture"
        ? { ...complete(request), status: "failed", error: { code: "provider", message: "down", retryable: true } }
        : complete(request);
    },
    "active",
    true,
  );
  const result = await f.start();
  expect(result.outcome.status).toBe("completed");
  expect(requests.map((request) => request.connectionId)).toEqual(["fixture", "backup"]);
  for (const request of requests)
    expect((await f.runtime.routerRepository.disclosure(scope, result.taskId, request.attemptId))?.tools.map((tool) => tool.id)).toEqual(
      request.tools.map((tool) => tool.id),
    );
});

it("rechecks tool policy after an awaited baseline context refresh", async () => {
  const requests: ModelRequest[] = [];
  const f = await fixture(async (request) => {
    requests.push(request);
    return complete(request);
  });
  const config = await f.runtime.routerRepository.configuration(scope);
  await f.runtime.routerRepository.configure(
    scope,
    { ...config.settings, modes: { ...config.settings.modes, memory: "active" } },
    config.revision,
  );
  const original = contextModule.assembleRoutedContext;
  let refreshed = false;
  const spy = vi.spyOn(contextModule, "assembleRoutedContext").mockImplementation(async (options, input, routing) => {
    if (routing.baselineOnly !== true)
      return original(options, input, { ...routing, onProjection: (projection) => routing.onProjection?.(projection, () => false) });
    // The disable happens while the caller is awaiting the refreshed context.
    const latest = await f.runtime.routerRepository.configuration(scope);
    await f.runtime.routerRepository.configure(scope, { ...latest.settings, enabled: false }, latest.revision);
    f.runtime.router.disable();
    refreshed = true;
    return original(options, input, routing);
  });
  try {
    expect((await f.start()).outcome.status).toBe("completed");
    expect(refreshed).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools.map((tool) => tool.id)).toEqual(
      offeredToATurn(await f.runtime.tools.listOffered({ workspaceId: "default", outsideConversation: true })),
    );
  } finally {
    spy.mockRestore();
  }
});

it("stops generation when model permission is revoked during a later tool decision", async () => {
  const requests: ModelRequest[] = [];
  const f = await fixture(async (request) => {
    requests.push(request);
    return complete(request, requests.length === 1 ? [{ id: "read", name: "fixture.visible", input: {} }] : []);
  });
  f.runtime.tools.register({
    id: "fixture.visible",
    sink: "none",
    version: "1",
    description: "visible read",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: z.strictObject({}),
    handler: async () => "read",
  });
  const decide = f.runtime.router.decide.bind(f.runtime.router);
  const permissions = f.runtime.access.missingPermissions.bind(f.runtime.access);
  let decisions = 0;
  vi.spyOn(f.runtime.router, "decide").mockImplementation(async (input) => {
    const receipt = await decide(input);
    if (input.feature === "tools" && ++decisions === 2)
      vi.spyOn(f.runtime.access, "missingPermissions").mockImplementation((actor, required) => [
        ...new Set([...permissions(actor, required), ...required.filter((permission) => permission === "models.invoke")]),
      ]);
    return receipt;
  });
  const result = await f.start("visible");
  expect(decisions).toBe(2);
  expect(requests).toHaveLength(1);
  expect(result.outcome.status).toBe("failed");
});

it("blocks a fallback provider after model permission is revoked by the first attempt", async () => {
  const requests: ModelRequest[] = [];
  let runtime: TaviRuntime | undefined;
  const f = await fixture(
    async (request) => {
      requests.push(request);
      if (runtime === undefined) throw new Error("missing runtime");
      const original = runtime.access.missingPermissions.bind(runtime.access);
      vi.spyOn(runtime.access, "missingPermissions").mockImplementation((actor, required) => [
        ...new Set([...original(actor, required), ...required.filter((permission) => permission === "models.invoke")]),
      ]);
      return { ...complete(request), status: "failed", error: { code: "provider", message: "down", retryable: true } };
    },
    "active",
    true,
  );
  runtime = f.runtime;
  expect((await f.start()).outcome.status).toBe("failed");
  expect(requests.map((request) => request.connectionId)).toEqual(["fixture"]);
});

it("keeps tools-only routing on the baseline context failure policy", async () => {
  const f = await fixture(async (request) => complete(request));
  const prepare = vi.spyOn(contextModule, "prepareContextAdvice");
  const baseline = vi.spyOn(contextModule, "assembleContext").mockImplementation(() => {
    throw new Error("memory unavailable");
  });
  try {
    expect((await f.start()).outcome.status).toBe("completed");
    expect(prepare).not.toHaveBeenCalled();
    expect(baseline).toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    baseline.mockRestore();
  }
});
