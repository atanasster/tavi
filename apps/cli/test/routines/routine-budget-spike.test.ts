import { z } from "zod";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import type { ModelPort, ModelRequest } from "@tavi/contracts";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

it("measures delegated workflow calls, including fallback, behind a shared prototype budget", async () => {
  const directory = directories.create("tavi-routine-budget-");
  const calls: ModelRequest[] = [];
  const reads: string[] = [];
  let rejected = 0;
  let parentTurns = 0;
  let workerTurns = 0;
  // A prototype admission hook, neither durable nor scoped to a routine run.
  // It sits below workflow steps so fallback is charged.
  const model: ModelPort = {
    async stream(request) {
      const base = { attemptId: request.attemptId, text: "", toolCalls: [], usage: {} };
      if (calls.length === 5) {
        rejected++;
        return {
          ...base,
          status: "failed",
          error: { code: "quota_exceeded", message: "prototype run budget exhausted", retryable: false },
        };
      }
      calls.push(request);
      if (calls.length === 1)
        return { ...base, status: "failed", error: { code: "rate_limit", message: "fixture primary outage", retryable: true } };
      const worker = request.messages.some((message) => message.role === "system" && message.text.includes("R0_WORKER"));
      if (worker && ++workerTurns === 1)
        return {
          ...base,
          status: "completed",
          toolCalls: [
            { id: "search", name: "fixture.search", input: {} },
            { id: "read", name: "fixture.read", input: {} },
          ],
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      if (!worker && ++parentTurns === 1)
        return {
          ...base,
          status: "completed",
          toolCalls: [
            {
              id: "spawn",
              name: "agents.spawn",
              input: { agentDefinitionId: "llm-news", input: "Gather fixture news", operationKey: "worker-probe" },
            },
          ],
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      return {
        ...base,
        status: "completed",
        text: worker ? "Fixture model release, supported by fetched evidence" : "Summary with source links",
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      defaultConnectionId: "primary",
      defaultModel: "pinned-primary",
      modelFallback: [{ connectionId: "backup", model: "pinned-backup" }],
      approvalRequiredFor: [],
    }),
    { modelOverride: model },
  );
  try {
    await runtime.store.asPort().repositories.agents.create({
      agentId: "llm-news",
      workspaceId: "default",
      name: "LLM news",
      systemPrompt: "R0_WORKER: return supported news evidence.",
      enabled: true,
      now: "2026-09-20T06:00:00.000Z",
    });
    for (const id of ["fixture.search", "fixture.read"])
      runtime.tools.register({
        id,
        sink: "none",
        version: "1.0.0",
        description: "Fixture evidence",
        effect: "read-only",
        requiredPermissions: ["tools.invoke"],
        inputSchema: z.strictObject({}),
        handler: async () => {
          reads.push(id);
          return { url: "https://fixture.invalid/release", text: "Fixture model release" };
        },
      });
    const context = { workspaceId: "default", principalId: "operator", caller: "test", runId: "admission-probe" };
    const workflow = runtime.workflow;
    if (workflow === undefined) throw new Error("fixture workflow is unavailable");
    const result = await workflow.admit({
      kind: "start",
      operationKey: "parent-probe",
      context,
      prompt: "Delegate news gathering and summarize",
    });
    expect(result.outcome.status).toBe("completed");
    // Its spawn joined the worker: the worker had answered before the parent's second turn, which is told its result waits.
    expect(JSON.stringify(calls.at(-1)?.messages)).toContain("Agent mailbox: 1 more message(s) from agents are waiting");
    expect(reads).toEqual(["fixture.search", "fixture.read"]);
    expect(calls).toHaveLength(5);
    expect(parentTurns).toBe(2);
    expect(workerTurns).toBe(2);
    expect(calls.slice(0, 2).map((call) => call.connectionId)).toEqual(["primary", "backup"]);
    const exhausted = await workflow.admit({ kind: "start", operationKey: "exhaustion-probe", context, prompt: "One more call" });
    expect(exhausted.outcome.status).toBe("failed");
    expect(calls).toHaveLength(5);
    expect(rejected).toBe(1);
  } finally {
    await runtime.close();
  }
});
