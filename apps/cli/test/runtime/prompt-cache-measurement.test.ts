import type { MemoryActor, ModelPort, ModelRequest } from "@tavi/contracts";
import { contextBlockOf } from "@tavi/test-support/fakes";
import type { ChatKindPromptCache } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The cache-hit measurement, as the owner composes it: every turn's
 * model calls are recorded with their step and a hash of the system text, and
 * `doctor`'s `chatMeasurement.promptCacheByChatKind` reads them back. Memory
 * retrieved for each new message once sat in the system text, so a
 * Home chat whose evidence changed between turns kept its first call's prefix
 * less often than with memory paused. It now sits in the call's context block:
 * the Home chat keeps its system text every turn, as the paused one
 * does.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const operator: MemoryActor = { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" };

/** Answers "ok", reporting a cache read of half its input on every call after the first. */
function model(): ModelPort & { readonly calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async stream(request, options) {
      calls.push(request);
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: `b-${request.attemptId}`, text: "ok" });
      const usage = { inputTokens: 1000, outputTokens: 1, inputCacheReadTokens: calls.length === 1 ? 0 : 500 };
      return { status: "completed", attemptId: request.attemptId, text: "ok", toolCalls: [], usage };
    },
  };
}

/**
 * Four turns of a Home chat in a fresh data directory, alternating between two
 * topics; returns Home's measurement. `paused` turns the workspace's memory off
 * (`enabled: false`) after the records are approved.
 */
async function homeChat(
  records: readonly string[],
  options: { readonly paused?: boolean } = {},
): Promise<{ readonly cache: ChatKindPromptCache | undefined; readonly calls: readonly ModelRequest[] }> {
  const directory = directories.create("tavi-prompt-cache-");
  const scripted = model();
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), { modelOverride: scripted });
  try {
    for (const body of records) {
      const { recordId } = await runtime.memory.propose({
        actor: operator,
        scope: { kind: "personal", principalId: "operator" },
        kind: "fact",
        body,
      });
      await runtime.memory.approve({ actor: operator, recordId });
    }
    if (options.paused === true) {
      const settings = runtime.store.asPort().repositories.workspaceSettings;
      await settings.set({
        workspaceId: "default",
        settings: { memory: { enabled: false } },
        expectedRevision: 0,
        actor: "operator:cli",
        now: runtime.clock.now(),
      });
    }
    const context = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    const prompts = ["tell me about the wombat", "and the kiwi?", "the wombat again", "the kiwi once more"];
    const first = await runtime.workflow?.admit({
      context,
      operationKey: "op-0",
      kind: "start",
      chatKind: "home",
      prompt: prompts[0] as string,
    });
    const taskId = first?.taskId ?? "";
    for (const [index, prompt] of prompts.slice(1).entries()) {
      await runtime.workflow?.admit({
        context: { ...context, runId: taskId },
        operationKey: `op-${index + 1}`,
        kind: "reply",
        taskId,
        prompt,
      });
    }
    const measured = await runtime.store.chatMeasurement({ now: runtime.clock.now() });
    return { cache: measured.promptCacheByChatKind.find((row) => row.kind === "home"), calls: scripted.calls };
  } finally {
    await runtime.close();
  }
}

describe("prompt-cache measurement, as composed", () => {
  it("a Home chat whose memory changes between turns keeps its first call's system text every turn, as one with memory off does", async () => {
    const records = ["wombat: the person keeps a wombat called Pip", "kiwi: the person grows kiwi fruit in Porto"];
    const withMemory = await homeChat(records);
    const withoutMemory = await homeChat(records, { paused: true });

    // Each turn's evidence is in its context block, never its system text: the first turn found the wombat only, the second the kiwi too.
    const system = (request: ModelRequest) =>
      request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.text)
        .join("\n");
    expect(withMemory.calls.map((request) => request.step)).toEqual([1, 1, 1, 1]);
    expect(
      withMemory.calls.slice(0, 2).map((request) => [contextBlockOf(request).includes("Pip"), contextBlockOf(request).includes("Porto")]),
    ).toEqual([
      [true, false],
      [true, true],
    ]);
    expect(withMemory.calls.some((request) => /Pip|Porto/.test(system(request)))).toBe(false);

    // Paused, the same records reach no turn.
    expect(withoutMemory.calls.some((request) => /Pip|Porto/.test(system(request) + contextBlockOf(request)))).toBe(false);
    expect(withoutMemory.cache?.firstStepPrefix).toEqual({ turnsCompared: 3, sameAsPreviousTurn: 3, share: 1 });
    // With memory, every turn's first call keeps the previous turn's system text too (the cache gate measured 1% when memory sat in the system text).
    expect(withMemory.cache?.firstStepPrefix).toEqual({ turnsCompared: 3, sameAsPreviousTurn: 3, share: 1 });
    // The usage the provider reported, read back per step: 1,500 of 4,000 first-call tokens were cache reads.
    expect(withMemory.cache?.firstStep).toEqual({ calls: 4, inputTokens: 4000, cacheReadTokens: 1500, share: 0.375 });
    expect(withMemory.cache?.laterSteps).toEqual({ calls: 0, inputTokens: 0, cacheReadTokens: 0, share: null });
  });
});
