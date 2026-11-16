import type { InvocationContext, ModelPort } from "@tavi/contracts";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The turn-latency probe: how many
 * worker operations one model step costs, counted by the store's debug
 * counter, with the fixture model answering in one step.
 *
 * The bounds are ratchets, set at the counts measured when the probe landed.
 * A change that cuts the step's worker round trips lowers these bounds to
 * its new measured count, and nothing should raise them.
 */

const directories = temporaryDirectories({ prefix: "tavi-turn-latency-" });
afterEach(() => directories.cleanup());

/**
 * Measured when the probe landed (on 170624c), on the second, steady-state turn: 89
 * operations before the first token, 122 for the whole step; 76 and 109 once
 * the owner remembered a chat's locality; 49 and 79 once a model step read its
 * task facts once (`StepFacts`), a shared offer predicate once a listing, and
 * the owner remembered workspace settings (all but the security reads, which
 * stay per call), delegation rows and task origins
 * until a write changes them (`createOwnerReadMemos`); 41 and 68 once an
 * admission read its thread's checkpoint once for every reading before its
 * graph runs, handed the task row it admitted to the memory-reach, chat-memory
 * and folder readings (and a step its own row to the chat-memory reading),
 * priced a model attempt in the request that records it (`beginPriced`),
 * recorded the checkpoint namespace with the admission's outcome, and read the
 * newest checkpoint's id in one request (`checkpoint.latest`); 42 and 69 once
 * a priced attempt dropped the chat's remembered used connections (9d7daef),
 * which 41 had kept stale past the call: the one bound raised, by a
 * correctness fix (a settled request does not say whether it committed, so
 * the memo cannot be updated in place). What remains is
 * admission, checkpoint I/O, the lease and cancellation fences (each a re-read
 * another process can race), accounting, context reads, the offered-tool
 * predicates, the post-turn rewind and steer re-checks and transcript writes.
 * The count is deterministic; lower these as later changes cut round trips.
 *
 * Time to first token (logged, never asserted: wall-clock time varies with
 * the machine and its load): on 29e3b4e, at 49 operations before the first
 * token, the steady-state turn reached its model call in 22–40 ms across
 * three runs on a developer Mac (about 41.5 ms on the commit before). Compare
 * the logged figure against this when a change claims to cut latency.
 */
const RATCHET_BEFORE_FIRST_TOKEN = 42;
const RATCHET_STEP = 69;

const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "cli" };

describe("turn latency", () => {
  it("counts the worker operations of one model step and before its first token", async () => {
    const fixture = createFixtureModel({ turns: [{ text: "done" }] });
    // Where each model call found the counter, and when.
    const calls: { readonly operations: number; readonly at: number }[] = [];
    const model: ModelPort = {
      ...fixture,
      stream: async (request, options) => {
        calls.push({ operations: runtime.store.operationCounts().total, at: performance.now() });
        return await fixture.stream(request, options);
      },
    };
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directories.create(), { approvalRequiredFor: [] }), {
      modelOverride: model,
    });
    try {
      const workflow = runtime.workflow;
      if (workflow === undefined) throw new Error("the fixture runtime has no workflow");
      // The first turn creates the chat and warms whatever a turn caches; the
      // second, a reply in the same chat, is the steady state a person waits on.
      const first = await workflow.admit({ context, operationKey: "op-1", kind: "start", prompt: "hello" });
      expect(first.outcome.status).toBe("completed");
      // The owner's due-work planner reads the deadlines a second after a write: let the first
      // turn's read land, so the measured turn counts its own round trips only.
      await delay(1_200);

      calls.length = 0;
      runtime.store.resetOperationCounts();
      const started = performance.now();
      const reply = await workflow.admit({ context, taskId: first.taskId, operationKey: "op-2", kind: "reply", prompt: "again" });
      expect(reply.outcome.status).toBe("completed");
      const counts = runtime.store.operationCounts();

      expect(calls).toHaveLength(1);
      const beforeFirstToken = calls[0]?.operations ?? Number.NaN;
      const firstTokenMs = (calls[0]?.at ?? Number.NaN) - started;
      const top = Object.entries(counts.byOperation)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 15)
        .map(([operation, count]) => `${operation}=${count}`)
        .join(", ");
      console.info(
        `turn-latency probe: ${counts.total} worker operations for one model step, ${beforeFirstToken} before the first token (${firstTokenMs.toFixed(1)} ms); top: ${top}`,
      );

      expect(beforeFirstToken).toBeGreaterThan(0);
      // Ratchets: lower these when a change cuts round trips, never raise them.
      expect(beforeFirstToken).toBeLessThanOrEqual(RATCHET_BEFORE_FIRST_TOKEN);
      expect(counts.total).toBeLessThanOrEqual(RATCHET_STEP);
    } finally {
      await runtime.close();
    }
  });
});
