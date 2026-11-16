import type { MemoryActor, ModelPort, ModelRequest } from "@tavi/contracts";
import { EPOCH_LINE_PATTERN, contextBlockOf } from "@tavi/test-support/fakes";
import { EPOCH_FLUSH_ATTEMPT_NUMBER } from "@tavi/agent-host/workflow";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Memory you can see, and a flush before compaction, as the owner composes them: fresh context asked for by
 * `requestFreshContext` is taken by the chat's next message, once; the
 * rollover posts an epoch divider naming its archive into the chat; and the
 * flush before it leaves proposals — never approved — shown as a memory card
 * and waiting in the Command Center. The request is a `fresh`
 * mark, so it outlives a restart and is still taken once.
 */

const directories = temporaryDirectories({ prefix: "tavi-epoch-memory-" });
afterEach(() => directories.cleanup());

const operator: MemoryActor = { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" };

/** A model that answers every turn "ok", and the flush with one fact and one chat note. */
function model(): ModelPort & { readonly calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async stream(request, options) {
      calls.push(request);
      const text =
        request.attemptNumber === EPOCH_FLUSH_ATTEMPT_NUMBER
          ? JSON.stringify({
              memories: [
                { kind: "fact", title: "Home city", body: "The person lives in Lisbon.", scope: "everywhere" },
                { kind: "lesson", body: "Keep this chat brief.", scope: "chat" },
              ],
            })
          : "ok";
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: `b-${request.attemptId}`, text });
      return { status: "completed", attemptId: request.attemptId, text, toolCalls: [], usage: {} };
    },
  };
}

/** An owner on `directory` whose model is `scripted`, as `tavi serve` composes it. */
async function composed(directory: string, scripted: ModelPort) {
  return await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), { modelOverride: scripted });
}

describe("fresh context, the epoch divider and the flush, as composed", () => {
  it("rolls the chat over at its next message, once, posting the divider and proposing what the span held", async () => {
    const scripted = model();
    const runtime = await composed(directories.create(), scripted);
    try {
      const context = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
      const first = await runtime.workflow?.admit({ context, operationKey: "op-1", kind: "start", prompt: "I live in Lisbon" });
      const taskId = first?.taskId ?? "";
      await runtime.requestFreshContext(taskId);
      const before = scripted.calls.length;
      await runtime.workflow?.admit({
        context: { ...context, runId: taskId },
        operationKey: "op-2",
        kind: "reply",
        taskId,
        prompt: "second",
      });
      const turn = scripted.calls.slice(before).find((request) => request.attemptNumber !== EPOCH_FLUSH_ATTEMPT_NUMBER);
      // The turn's context block (`v2`: on its person message) states the rollover.
      expect(contextBlockOf(turn)).toMatch(EPOCH_LINE_PATTERN);
      expect(scripted.calls.filter((request) => request.attemptNumber === EPOCH_FLUSH_ATTEMPT_NUMBER)).toHaveLength(1);

      const repositories = runtime.store.asPort().repositories;
      const notices = await repositories.transcripts.notices(taskId, { limit: 10 });
      // The flush's card (the flush is shown), then the divider.
      expect(notices.map((notice) => [notice.kind, notice.title])).toEqual([
        ["memory", "2 things to remember from before this chat rolled over"],
        ["epoch", "Epoch 1 began"],
      ]);
      const divider = notices.find((notice) => notice.kind === "epoch");
      expect(divider?.artifactId).toMatch(/\S/);
      expect(await repositories.artifacts.getArtifact(divider?.artifactId as string)).toMatchObject({ runId: taskId });

      // Proposed for review, never approved: one for everywhere, one note for this chat.
      const proposed = await runtime.memory.list({ actor: { ...operator, runId: taskId }, statuses: ["proposed"] });
      expect(proposed.map((record) => [record.kind, record.scope.kind, record.originTaskId])).toEqual(
        expect.arrayContaining([
          ["fact", "personal", taskId],
          ["lesson", "run_local", taskId],
        ]),
      );
      expect(await runtime.memory.list({ actor: { ...operator, runId: taskId }, statuses: ["approved"] })).toEqual([]);

      // Taken once: the next message rolls nothing over.
      await runtime.workflow?.admit({
        context: { ...context, runId: taskId },
        operationKey: "op-3",
        kind: "reply",
        taskId,
        prompt: "third",
      });
      expect(await repositories.transcripts.notices(taskId, { limit: 10 })).toHaveLength(2);
      expect(scripted.calls.filter((request) => request.attemptNumber === EPOCH_FLUSH_ATTEMPT_NUMBER)).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("keeps a request across a restart, and the restarted owner's next message takes it once", async () => {
    const directory = directories.create();
    const context = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    const before = model();
    const first = await composed(directory, before);
    let taskId = "";
    try {
      taskId = (await first.workflow?.admit({ context, operationKey: "op-1", kind: "start", prompt: "I live in Lisbon" }))?.taskId ?? "";
      await first.requestFreshContext(taskId);
    } finally {
      await first.close();
    }

    const scripted = model();
    const restarted = await composed(directory, scripted);
    try {
      const reply = { context: { ...context, runId: taskId }, kind: "reply" as const, taskId };
      await restarted.workflow?.admit({ ...reply, operationKey: "op-2", prompt: "second" });
      const turn = scripted.calls.find((request) => request.attemptNumber !== EPOCH_FLUSH_ATTEMPT_NUMBER);
      // The turn's context block (`v2`: on its person message) states the rollover.
      expect(contextBlockOf(turn)).toMatch(EPOCH_LINE_PATTERN);
      expect(scripted.calls.filter((request) => request.attemptNumber === EPOCH_FLUSH_ATTEMPT_NUMBER)).toHaveLength(1);
      const repositories = restarted.store.asPort().repositories;
      expect((await repositories.transcripts.notices(taskId, { limit: 10 })).filter((notice) => notice.kind === "epoch")).toHaveLength(1);
      // Taken: the row is gone, and the next message rolls nothing over.
      expect(await repositories.transcripts.takeMemoryMark({ taskId, kind: "fresh", mark: "next" })).toBe(false);
      await restarted.workflow?.admit({ ...reply, operationKey: "op-3", prompt: "third" });
      expect((await repositories.transcripts.notices(taskId, { limit: 10 })).filter((notice) => notice.kind === "epoch")).toHaveLength(1);
      expect(scripted.calls.filter((request) => request.attemptNumber === EPOCH_FLUSH_ATTEMPT_NUMBER)).toHaveLength(1);
    } finally {
      await restarted.close();
    }
  });
});
