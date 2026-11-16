import { capture, temporaryDirectories } from "@tavi/test-support";
import { createFixtureSandbox } from "@tavi/test-support/sandbox";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import type { RuntimeFactory } from "../../src/cli/runtime-options.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { approveReviewRound } from "../../src/features/run/workers.js";

/**
 * `tavi run`'s `reviewInterrupt`/`EXIT.reviewRequired` handling: a
 * `reviewInterrupt`-only "waiting" outcome must be reported as waiting on
 * artifact review, not fall through to the `task.failed` reporting path
 * (the approval loop must check `outcome.reviewInterrupt`, not only
 * `outcome.interrupt`). This drives `main(["run", ...])` through a
 * `fixture.capture` call, which makes a `reviewState: "pending"` artifact
 * as `browser.capture` does, and asserts `main()` reports it correctly.
 *
 * Uses a custom `runtimeFactory` (not `main()`'s default) to inject both
 * a scripted fixture model and the fixture sandbox (`mode: "echo"`) —
 * `RuntimeFactory`'s own public type only exposes `modelOverride` to
 * `main()`'s CLI-facing callers (deliberately, per its own doc comment),
 * but a caller providing its own factory implementation is not limited
 * to that narrower surface; it can call `composeTaviRuntime` with
 * whatever overrides it needs internally.
 */

const directories = temporaryDirectories({ prefix: "tavi-run-review-" });

afterAll(() => directories.cleanup());

/** A run whose model takes a stand-in screenshot a person must review, then answers. */
function capturing() {
  const model = createFixtureModel({
    turns: [{ toolCall: { id: "call-1", name: "fixture.capture", input: {} } }, { text: "done" }],
  });
  const runtimeFactory: RuntimeFactory = (options) =>
    composeTaviRuntime(
      { ...options, devFixtureTools: true },
      { modelOverride: model, sandboxOverride: createFixtureSandbox({ mode: "echo" }) },
    );
  return { model, runtimeFactory };
}

const runArgs = (directory: string, approval: "ask" | "approve" | "deny") => [
  "run",
  "--connection",
  "fixture-conn",
  "--model",
  "fixture-model",
  "--approval",
  approval,
  "--data-dir",
  directory,
  "do the thing",
];

describe("tavi run — reviewInterrupt reporting", () => {
  it.each(["ask", "deny"] as const)(
    "reports EXIT.reviewRequired, not EXIT.taskFailed, under --approval %s when a turn produces a pending artifact",
    async (approval) => {
      const directory = directories.create();
      const { runtimeFactory } = capturing();

      const result = capture();
      const code = await main(runArgs(directory, approval), { io: result.io, runtimeFactory });

      expect(code, result.stderr()).toBe(EXIT.reviewRequired);
      expect(result.stderr()).toMatch(/waiting on artifact review/);
      expect(result.stderr()).toMatch(/Pending artifact review: art-/);
      // Never misreported as a failure.
      expect(result.stdout()).not.toContain("task.failed");
    },
  );

  it("under --approval approve releases the pending artifact as it approves calls, and the turn goes on to its answer", async () => {
    const directory = directories.create();
    const { model, runtimeFactory } = capturing();

    const result = capture();
    const code = await main(runArgs(directory, "approve"), { io: result.io, runtimeFactory });

    expect(code, result.stderr()).toBe(EXIT.ok);
    expect(result.stdout()).toContain("done");
    expect(result.stderr()).not.toMatch(/waiting on artifact review/);
    // The model's second turn read the capture's result, not a rejection.
    expect(model.calls).toHaveLength(2);
    expect(JSON.stringify(model.calls[1])).not.toContain("rejected_by_review");

    // Recorded in the review history as decided by the run's automatic decider, never as a person.
    const listed = capture();
    expect(await main(["approvals", "history", "--kind", "review", "--data-dir", directory], { io: listed.io }), listed.stderr()).toBe(
      EXIT.ok,
    );
    expect(listed.stdout()).toContain("auto:");
  });
});

describe("approveReviewRound", () => {
  it("approves only the run's own pending artifacts: another task's or workspace's, and a gone one, stay for a person", async () => {
    const records = new Map(
      [
        { artifactId: "art-own", workspaceId: "w1", runId: "task-1", reviewState: "pending" },
        { artifactId: "art-other-task", workspaceId: "w1", runId: "task-2", reviewState: "pending" },
        { artifactId: "art-other-workspace", workspaceId: "w2", runId: "task-1", reviewState: "pending" },
      ].map((record) => [record.artifactId, record]),
    );
    const decided: string[] = [];
    const deps = {
      artifacts: {
        getArtifact: async (artifactId: string) => records.get(artifactId) as never,
        setReviewState: async (input: { artifactId: string }) => {
          decided.push(input.artifactId);
          return undefined as never;
        },
      },
      now: () => "2026-10-28T00:00:00.000Z",
    };
    const owner = { workspaceId: "w1", taskId: "task-1" };

    expect(await approveReviewRound(deps, owner, ["art-own"], "auto:p")).toBe(true);
    expect(await approveReviewRound(deps, owner, ["art-other-task"], "auto:p")).toBe(false);
    expect(await approveReviewRound(deps, owner, ["art-other-workspace"], "auto:p")).toBe(false);
    expect(await approveReviewRound(deps, owner, ["art-gone"], "auto:p")).toBe(false);
    expect(decided).toEqual(["art-own"]);
  });
});
