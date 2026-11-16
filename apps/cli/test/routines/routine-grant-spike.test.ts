import { z } from "zod";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories, waitFor } from "@tavi/test-support";
import type { ModelPort, ModelRequest } from "@tavi/contracts";
import { runScheduleNow } from "@tavi/agent-host/schedule-scheduler";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

it.each(["granted", "revoked", "ungated"] as const)("probes scheduled child external effects with policy=%s", async (policy) => {
  const gated = policy !== "ungated";
  const directory = directories.create("tavi-routine-grant-");
  const calls: ModelRequest[] = [];
  const said = (request: ModelRequest, text: string) =>
    request.messages.some((message) => message.role === "user" && message.text.includes(text));
  const resultOf = (request: ModelRequest, toolName: string) =>
    request.messages.some((message) => message.role === "tool" && message.toolName === toolName);
  const model: ModelPort = {
    async stream(request) {
      calls.push(request);
      let toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
      if (said(request, "Read fixture")) {
        if (!resultOf(request, "fixture.read")) toolCalls = [{ id: "read", name: "fixture.read", input: {} }];
      } else if (!resultOf(request, "agents.spawn")) {
        toolCalls = [
          { id: "spawn", name: "agents.spawn", input: { agentDefinitionId: "news", input: "Read fixture", operationKey: "child" } },
        ];
      } else if (!resultOf(request, "agents.wait")) {
        // The spawn runs the child in the background: the run waits on it before it ends.
        const workerTaskId = /workerTaskId\\*":\\*"([^"\\]+)/.exec(JSON.stringify(request.messages))?.[1] ?? "";
        toolCalls = [
          {
            id: "wait",
            name: "agents.wait",
            input: { waitingOnWorkerTaskId: workerTaskId, deadlineAt: new Date(Date.now() + 3_600_000).toISOString() },
          },
        ];
      }
      // A turn that ends says something: one that answers nothing at all is asked once more (an empty answer is a provider's hiccup).
      return { status: "completed", attemptId: request.attemptId, text: toolCalls.length === 0 ? "done" : "", toolCalls, usage: {} };
    },
  };
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      defaultModel: "fixture",
      approvalRequiredFor: gated ? ["external", "mutating"] : [],
      scheduleSweepEnabled: false,
    }),
    { modelOverride: model },
  );
  try {
    let reads = 0;
    runtime.tools.register({
      id: "fixture.read",
      sink: "none",
      version: "1.0.0",
      description: "External fixture read",
      effect: "external",
      requiredPermissions: ["tools.invoke"],
      inputSchema: z.strictObject({}),
      handler: async () => {
        reads++;
        return "fixture evidence";
      },
    });
    const repositories = runtime.store.asPort().repositories;
    const now = "2026-09-20T06:00:00.000Z";
    await repositories.agents.create({
      agentId: "news",
      workspaceId: "default",
      name: "News",
      systemPrompt: "Read news",
      enabled: true,
      now,
    });
    await repositories.schedules.create({
      scheduleId: "probe",
      workspaceId: "default",
      principalId: "operator",
      name: "Probe",
      prompt: "Delegate news",
      spec: { at: "09:00", timezone: "Europe/Sofia" },
      missedRunPolicy: "skip",
      // The child's call is answered by the schedule's own list when it names the tool, and denied when it does not.
      autoApproveTools: policy === "revoked" ? ["agents.spawn"] : ["agents.spawn", "fixture.read"],
      enabled: true,
      nextRunAt: now,
      now,
    });
    const schedule = await repositories.schedules.get("probe");
    if (schedule === undefined || runtime.scheduleDependencies === undefined) throw new Error("fixture schedule unavailable");
    const outcome = await runScheduleNow(schedule, runtime.scheduleDependencies);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "ran" });
    await waitFor(async () => (await repositories.schedules.get("probe"))?.lastOutcome === "manual run: completed", 10_000, {
      what: "the run to end once its child did",
    });
    expect(reads).toBe(policy === "revoked" ? 0 : 1);
    // The model's key is namespaced by the spawning task and turn: read it as the run's child.
    const delegation =
      outcome?.kind === "ran" ? (await repositories.agentDelegations.listChildren("default", outcome.taskId, 10))[0] : undefined;
    if (delegation === undefined) throw new Error("child delegation was not recorded");
    // The child's round is decided by the schedule, never left pending for a person nobody asked.
    expect((await repositories.tasks.get(delegation.workerTaskId))?.status).toBe("completed");
    const approvals = await repositories.approvals.listForTask(delegation.workerTaskId);
    if (!gated) expect(approvals).toEqual([]);
    else if (policy === "granted")
      expect(approvals).toEqual([expect.objectContaining({ toolId: "fixture.read", state: "granted", decidedBy: "schedule:Probe" })]);
    else
      expect(approvals).toEqual([
        expect.objectContaining({
          toolId: "fixture.read",
          state: "denied",
          decidedBy: "schedule:Probe",
          note: "denied: not in this schedule's tool policy",
        }),
      ]);
  } finally {
    await runtime.close();
  }
});
