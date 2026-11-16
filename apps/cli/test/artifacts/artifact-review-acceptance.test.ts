import type { InvocationContext } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Real interrupt-then-resume acceptance tests for the artifact review
 * workflow, driven through `composeTaviRuntime` and
 * the real `browser.capture` tool (`registerBrowserTools`), using
 * composition's own default REAL Playwright browser adapter — not a
 * `browserOverride` — specifically because `composition.ts` only wires
 * `artifacts: persistencePort.repositories.artifacts` into its OWN
 * default `createPlaywrightBrowser(...)` call; a caller-supplied
 * `browserOverride` bypasses that wiring entirely (confirmed by hand:
 * an unwired fixture override's `capture()` throws `NOT_CONFIGURED`,
 * caught by `dispatchTool` and turned into an ordinary failed tool
 * result — the review gate never even sees it, since no artifact is
 * ever created). Using the real adapter means every artifact this file
 * exercises is genuinely wired the same way a live `tavi run` composes
 * it. Gated on real Chromium actually being launchable
 * (`chromiumAvailable`, matching `packages/builtin/browser/test
 * /playwright.real.test.ts`'s own precedent) via `ctx.skip()` so a host
 * without a cached binary reports these as skipped, not failed.
 *
 * `packages/agent-host/test/workflow.test.ts` already proves this same
 * mechanism end to end for a fixture tool's pending artifact; this file
 * proves it for a real producer — a
 * browser screenshot — through this application's own composition, not
 * a hand-built fixture tool.
 *
 * The same discipline as for `messagingReplyTo`: its surviving a real
 * checkpoint round-trip could only be proven by an actual suspend/resume
 * through the real graph, never a same-turn shortcut — the same
 * standard applies here to `pendingReviewArtifactIds`.
 */

const workspaces = [
  { workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
] as const;

const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "root", caller: "test" };

const directories = temporaryDirectories({ prefix: "tavi-artifact-review-acceptance-" });
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    if (runtime !== undefined) await runtime.close();
  }
  directories.cleanup();
});

const tempDirectory = (): string => directories.create();

async function harness(
  directory: string,
  turns: readonly ScriptedTurn[],
): Promise<{ readonly runtime: TaviRuntime; readonly model: ReturnType<typeof createFixtureModel> }> {
  const model = createFixtureModel({ turns });
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      workspaces: [...workspaces],
      approvalRequiredFor: [], // isolates the artifact-review gate from the (already-covered-elsewhere) approval gate
    }),
    { modelOverride: model }, // no browserOverride — see this file's own header comment on why
  );
  runtimes.push(runtime);
  return { runtime, model };
}

// The real Playwright adapter assigns deterministic, counter-based
// session ids (`browser-session-1`, ...) — the first session created in
// a fresh runtime is always this one, so the second scripted turn's
// `browser.capture` call can name it directly without reading back the
// first turn's real result.
const FIRST_SESSION_ID = "browser-session-1";

let chromiumAvailable = true;
beforeAll(async () => {
  const probeDirectories = temporaryDirectories();
  const directory = probeDirectories.create("tavi-artifact-review-probe-");
  let runtime: TaviRuntime | undefined;
  try {
    ({ runtime } = await harness(directory, []));
    const session = await runtime.tools.get("browser.create_session")?.handler({
      input: { workspaceId: "default" },
      context,
      signal: new AbortController().signal,
    });
    if ((session as { sessionId?: string } | undefined)?.sessionId === undefined) {
      throw new Error("expected a real session id");
    }
  } catch {
    chromiumAvailable = false;
  } finally {
    // Cleaned up here, not via the shared `runtimes`/`directories`
    // arrays those drain per-test — this probe runs once, before any
    // test, outside that per-test lifecycle.
    if (runtime !== undefined) {
      const index = runtimes.indexOf(runtime);
      if (index !== -1) runtimes.splice(index, 1);
      await runtime.close();
    }
    probeDirectories.cleanup();
  }
});

describe("artifact review — real interrupt-then-resume via browser.capture", () => {
  it("approves a pending screenshot artifact: the suspended task resumes and completes with the real artifact id", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    const directory = tempDirectory();
    const { runtime, model } = await harness(directory, [
      { toolCall: { id: "call-1", name: "browser.create_session", input: { workspaceId: "default" } } },
      { toolCall: { id: "call-2", name: "browser.capture", input: { sessionId: FIRST_SESSION_ID } } },
      { text: "captured" },
    ]);
    const workflow = runtime.workflow;
    if (workflow === undefined) throw new Error("expected a real workflow port");

    const suspended = await workflow.admit({
      context,
      operationKey: "op-approve",
      kind: "start",
      prompt: "take a screenshot",
    });
    expect(suspended.outcome.status).toBe("waiting");
    const artifactId = suspended.outcome.reviewInterrupt?.requests[0]?.artifactId ?? "";
    expect(artifactId).toMatch(/^art-/);
    expect((await runtime.store.asPort().repositories.artifacts.getArtifact(artifactId))?.reviewState).toBe("pending");

    await runtime.store.asPort().repositories.artifacts.setReviewState({
      artifactId,
      reviewState: "approved",
      reviewedBy: "operator",
      reviewedAt: "2026-01-01T00:00:01.000Z",
    });

    const resumed = await workflow.admit({
      context: { ...context, runId: suspended.taskId },
      taskId: suspended.taskId,
      operationKey: "op-approve:resume",
      kind: "approval",
      resume: { reviewAck: true },
    });
    expect(resumed.outcome.status).toBe("completed");

    const lastRequest = model.calls.at(-1);
    const toolResult = lastRequest?.messages
      .flatMap((message) => message.toolResults ?? [])
      .find((result) => result.toolCallId === "call-2");
    expect(toolResult?.isError).toBe(false);
    const output = toolResult?.output as { artifactId: string } | undefined;
    expect(output?.artifactId).toBe(artifactId);
  });

  it("rejects a pending screenshot artifact: the model receives a typed rejection, never the real artifact id", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    const directory = tempDirectory();
    const { runtime, model } = await harness(directory, [
      { toolCall: { id: "call-1", name: "browser.create_session", input: { workspaceId: "default" } } },
      { toolCall: { id: "call-2", name: "browser.capture", input: { sessionId: FIRST_SESSION_ID } } },
      { text: "acknowledged" },
    ]);

    const workflow = runtime.workflow;
    if (workflow === undefined) throw new Error("expected a real workflow port");

    const suspended = await workflow.admit({
      context,
      operationKey: "op-reject",
      kind: "start",
      prompt: "take a screenshot",
    });
    expect(suspended.outcome.status).toBe("waiting");
    const artifactId = suspended.outcome.reviewInterrupt?.requests[0]?.artifactId ?? "";
    expect(artifactId).toMatch(/^art-/);

    await runtime.store.asPort().repositories.artifacts.setReviewState({
      artifactId,
      reviewState: "rejected",
      reviewedBy: "operator",
      reviewedAt: "2026-01-01T00:00:01.000Z",
    });

    const resumed = await workflow.admit({
      context: { ...context, runId: suspended.taskId },
      taskId: suspended.taskId,
      operationKey: "op-reject:resume",
      kind: "approval",
      resume: { reviewAck: true },
    });
    expect(resumed.outcome.status).toBe("completed");

    const lastRequest = model.calls.at(-1);
    const toolResult = lastRequest?.messages
      .flatMap((message) => message.toolResults ?? [])
      .find((result) => result.toolCallId === "call-2");
    expect(toolResult?.isError).toBe(true);
    const output = toolResult?.output as { status: string; rejectedArtifactIds: readonly string[] } | undefined;
    expect(output?.status).toBe("rejected_by_review");
    expect(output?.rejectedArtifactIds).toEqual([artifactId]);
    // The real screenshot bytes are still in the artifact store — only
    // what the model saw was replaced.
    expect(await runtime.store.asPort().repositories.artifacts.readArtifactBody(artifactId)).toBeDefined();
  });
});
