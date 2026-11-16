import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { channel } from "node:diagnostics_channel";
import { z } from "zod";
import { createAgentCommunicationService } from "@tavi/agent-host/agent-communication";
import type { ModelPort } from "@tavi/contracts";
import { AsyncCheckpointSaver } from "@tavi/agent-host/checkpoint";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(3));
};

it.each([1, 4, 8])(
  "isolates checkpoints and mailbox claims for %i concurrent workflows",
  async (count) => {
    const directory = directories.create("tavi-db-concurrency-");
    chmodSync(directory, 0o700);
    const taskIds: string[] = Array.from({ length: count }, () => "");
    const turns = new Map<string, number>();
    let admitted = 0;
    const ready = Promise.withResolvers<void>();
    const model: ModelPort = {
      stream: async (request) => {
        const index = taskIds.indexOf(request.runId);
        if (index < 0) throw new Error("model invoked before durable task registration");
        const turn = turns.get(request.runId) ?? 0;
        turns.set(request.runId, turn + 1);
        const recipient = taskIds[(index + 1) % count];
        if (recipient === undefined) throw new Error("missing recipient");
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: turn === 0 ? "" : `complete-${index}`,
          toolCalls:
            turn === 0
              ? [
                  {
                    id: `send-${index}`,
                    name: "fixture.send",
                    input: {
                      recipientTaskId: recipient,
                      recipientAgentId: recipient,
                      kind: "message",
                      content: `mail-${index}`,
                      wake: "none",
                    },
                  },
                ]
              : [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directory, { defaultModel: "fixture", approvalRequiredFor: [], scheduleSweepEnabled: false }),
      { modelOverride: model },
    );
    const workflow = runtime.workflow;
    if (workflow === undefined) throw new Error("missing workflow");
    const repositories = runtime.store.repositories;
    const agents = createAgentCommunicationService({
      tasks: repositories.tasks,
      mailbox: repositories.agentMailbox,
      waits: repositories.agentWaits,
      delegations: repositories.agentDelegations,
      workflow,
      access: runtime.access,
      artifacts: repositories.artifacts,
      cancelTask: async (input) => {
        await runtime.store.cancelTask({ ...input, now: { execution: true } });
      },
    });
    // Use the real communication service with deferred wakes. Each recipient
    // already has an active invocation; this fixture isolates persistence from
    // the separately tested wake/resume scheduler.
    const sendSchema = z.object({ recipientTaskId: z.string(), recipientAgentId: z.string(), content: z.string() });
    runtime.tools.register({
      id: "fixture.send",
      sink: "none",
      version: "1",
      description: "Send fixture mail",
      effect: "mutating",
      requiredPermissions: ["tools.invoke"],
      inputSchema: sendSchema,
      handler: async ({ input, context }) => agents.send({ ...sendSchema.parse(input), actor: context, kind: "message", wake: "none" }),
    });
    const events = channel("tavi.database.operation");
    const waits: number[] = [];
    let maximumDepth = 0;
    const observe = (value: unknown): void => {
      if (value === null || typeof value !== "object" || !("phase" in value) || value.phase !== "settled") return;
      if ("queueWaitMs" in value && typeof value.queueWaitMs === "number") waits.push(value.queueWaitMs);
      if ("queueDepth" in value && typeof value.queueDepth === "number") maximumDepth = Math.max(maximumDepth, value.queueDepth);
    };
    const delay = monitorEventLoopDelay({ resolution: 5 });
    try {
      events.subscribe(observe);
      delay.enable();
      const started = performance.now();
      const results = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          workflow.admit({
            context: { workspaceId: "default", principalId: "operator", runId: `initial-${index}`, caller: "test" },
            operationKey: `concurrent-${index}`,
            kind: "start",
            prompt: `private-prompt-${index}`,
            onAdmitted: async ({ taskId }) => {
              taskIds[index] = taskId;
              if (++admitted === count) ready.resolve();
              await ready.promise;
            },
          }),
        ),
      );
      const elapsedMs = performance.now() - started;
      delay.disable();
      events.unsubscribe(observe);
      expect(new Set(results.map((result) => result.taskId)).size).toBe(count);
      expect(new Set(results.map((result) => result.threadId)).size).toBe(count);
      const saver = new AsyncCheckpointSaver(runtime.store.checkpoints);
      try {
        for (const [index, result] of results.entries()) {
          expect(result.outcome).toMatchObject({ status: "completed", finalText: `complete-${index}` });
          expect(turns.get(result.taskId)).toBe(2);
          const history = await workflow.checkpoints.listCheckpoints(result.threadId, 100);
          expect(history.length).toBeGreaterThan(1);
          expect(history.every((row) => row.threadId === result.threadId && row.checkpointNamespace === "")).toBe(true);
          const state = await saver.getTuple({ configurable: { thread_id: result.threadId, checkpoint_ns: "" } });
          const serialized = JSON.stringify(state?.checkpoint.channel_values);
          expect(serialized).toContain(`private-prompt-${index}`);
          for (let other = 0; other < count; other++) if (other !== index) expect(serialized).not.toContain(`private-prompt-${other}`);
          const mailbox = runtime.store.repositories.agentMailbox;
          const pending = await mailbox.listPending(result.taskId, 10);
          expect(pending.map((row) => row.content)).toEqual([`mail-${(index + count - 1) % count}`]);
          const claims = await Promise.all(
            ["one", "two"].map((leaseId) =>
              mailbox.claim({ taskId: result.taskId, limit: 10, leaseId, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }),
            ),
          );
          expect(claims.flat()).toHaveLength(1);
          const winner = (claims[0]?.length ?? 0) > 0 ? "one" : "two";
          await mailbox.acknowledge({ taskId: result.taskId, leaseId: winner, messageIds: pending.map((row) => row.messageId) });
          const message = pending[0];
          if (message === undefined) throw new Error("missing mailbox message");
          expect((await mailbox.getEnvelope(message.messageId))?.deliveryState).toBe("acknowledged");
        }
      } finally {
        await saver.close();
      }
      expect(waits.length).toBeGreaterThan(count);
      const size = (path: string) => {
        try {
          return statSync(path).size;
        } catch {
          return 0;
        }
      };
      console.log(
        "DATABASE_CONCURRENCY",
        JSON.stringify({
          tasks: count,
          elapsedMs: Number(elapsedMs.toFixed(2)),
          eventLoopP95Ms: Number((delay.percentile(95) / 1e6).toFixed(3)),
          eventLoopMaxMs: Number((delay.max / 1e6).toFixed(3)),
          queueWaitP95Ms: percentile(waits, 0.95),
          queueWaitMaxMs: percentile(waits, 1),
          operations: waits.length,
          maximumDepth,
          databaseBytes: size(join(directory, "tavi.sqlite")),
          walBytes: size(join(directory, "tavi.sqlite-wal")),
        }),
      );
    } finally {
      delay.disable();
      events.unsubscribe(observe);
      await runtime.close();
    }
  },
  30_000,
);
