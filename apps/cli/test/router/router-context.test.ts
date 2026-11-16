import { ATTENDED_TASK_POLICY, RouterSettingsSchema, type ModelPort } from "@tavi/contracts";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

it("persists final context exposure before each generation attempt, including fallback", async () => {
  const directory = directories.create("tavi-router-context-");
  let runtime: TaviRuntime | undefined;
  const model: ModelPort = {
    async stream(request) {
      const projections = runtime?.routerRepository.contextProjections({ workspaceId: "default", principalId: "operator" }, request.runId);
      expect((await projections)?.some((projection) => projection.attemptId === request.attemptId)).toBe(true);
      if (request.connectionId === "main" && runtime !== undefined) {
        const scope = { workspaceId: "default", principalId: "operator" };
        const config = await runtime.routerRepository.configuration(scope);
        await runtime.routerRepository.configure(scope, { ...config.settings, enabled: false }, config.revision);
        runtime.router.disable();
      }
      return request.connectionId === "main"
        ? {
            status: "failed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [],
            usage: {},
            error: { code: "provider", message: "fixture failure", retryable: true },
          }
        : { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
    },
  };
  try {
    runtime = await composeTaviRuntime(
      {
        dataDirectory: directory,
        workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
        providers: ["main", "backup"].map((connectionId) => ({
          connectionId,
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credentialRef: `${connectionId}.key`,
        })),
        credentials: {},
        defaultConnectionId: "main",
        defaultModel: "m",
        modelFallback: [{ connectionId: "backup", model: "m" }],
        logger: { level: "error", sink: () => {} },
        approvalRequiredFor: [],
      },
      { modelOverride: model },
    );
    await runtime.routerRepository.configure(
      { workspaceId: "default", principalId: "operator" },
      RouterSettingsSchema.parse({ enabled: true, modes: { memory: "active", skills: "active" } }),
      0,
    );
    const result = await runtime.workflow?.admit({
      context: { workspaceId: "default", principalId: "operator", runId: "pending", caller: "cli" },
      operationKey: "context",
      kind: "start",
      prompt: "hello",
      origin: "cli",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(result?.outcome.status).toBe("completed");
    const projections = await runtime.routerRepository.contextProjections(
      { workspaceId: "default", principalId: "operator" },
      result?.taskId ?? "missing",
    );
    expect(projections.map((projection) => projection.configRevision)).toEqual([1, 2]);
    expect(projections[1]?.recommendedSkills).toEqual([]);
  } finally {
    await runtime?.close();
  }
});

it("notes the memories a routed call's context was given, for the chat's Used here", async () => {
  const directory = directories.create("tavi-router-used-");
  let runtime: TaviRuntime | undefined;
  const model: ModelPort = {
    async stream(request) {
      return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
    },
  };
  try {
    runtime = await composeTaviRuntime(
      {
        dataDirectory: directory,
        workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
        providers: [{ connectionId: "main", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "main.key" }],
        credentials: {},
        defaultConnectionId: "main",
        defaultModel: "m",
        logger: { level: "error", sink: () => {} },
        approvalRequiredFor: [],
      },
      { modelOverride: model },
    );
    await runtime.routerRepository.configure(
      { workspaceId: "default", principalId: "operator" },
      RouterSettingsSchema.parse({ enabled: true, modes: { memory: "active", skills: "active" } }),
      0,
    );
    const remembered = await runtime.memory.remember({
      actor: { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" },
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "The garden has tomatoes",
    });
    const result = await runtime.workflow?.admit({
      context: { workspaceId: "default", principalId: "operator", runId: "pending", caller: "cli" },
      operationKey: "used",
      kind: "start",
      prompt: "garden has tomatoes",
      origin: "cli",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(result?.outcome.status).toBe("completed");
    const exposed = (
      await runtime.routerRepository.contextProjections({ workspaceId: "default", principalId: "operator" }, result?.taskId ?? "missing")
    ).flatMap((projection) => projection.memoryExposed.map((ref) => ref.recordId));
    const used = (await runtime.store.asPort().repositories.memoryUse.list(result?.taskId ?? "missing", 10)).map((use) => use.recordId);
    // What the routed context exposed is what the chat is told it used.
    expect(used).toEqual([...new Set(exposed)]);
    expect(used).toContain(remembered.recordId);
  } finally {
    await runtime?.close();
  }
});
