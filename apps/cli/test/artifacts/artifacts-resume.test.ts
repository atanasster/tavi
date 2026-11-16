import type { ModelPort } from "@tavi/contracts";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { createFixtureSandbox } from "@tavi/test-support/sandbox";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { EXIT, main } from "../../src/main.js";
import type { RuntimeFactory } from "../../src/cli/runtime-options.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * `tavi artifacts approve|reject --resume`: deciding a pending
 * artifact records the decision durably, and `--resume` re-admits the task
 * waiting on it. This drives the full two-process flow a real operator
 * would use: `tavi run` suspends on a pending artifact a tool made
 * (`fixture.capture`, as `run-review-interrupt.test.ts` uses), then a SEPARATE `tavi
 * artifacts approve --resume` invocation — its own `composeTaviRuntime`
 * call, its own model instance — decides it and re-admits the specific
 * suspended task, proving it actually completes rather than staying
 * suspended.
 */

const directories = temporaryDirectories({ prefix: "tavi-artifacts-resume-" });
afterEach(() => directories.cleanup());

const tempDirectory = (): string => directories.create();

async function suspendOnPendingArtifact(
  dataDirectory: string,
): Promise<{ readonly artifactId: string; readonly taskId: string; readonly stderr: string }> {
  // `fixture.capture` makes an artifact a person must review, as `browser.capture` does.
  const model = createFixtureModel({
    turns: [{ toolCall: { id: "call-1", name: "fixture.capture", input: {} } }],
  });
  const runtimeFactory: RuntimeFactory = (options) =>
    composeTaviRuntime(
      { ...options, devFixtureTools: true },
      { modelOverride: model, sandboxOverride: createFixtureSandbox({ mode: "echo" }) },
    );

  const result = capture();
  const code = await main(
    [
      "run",
      "--connection",
      "fixture-conn",
      "--model",
      "fixture-model",
      // `ask`: under `approve` the run would release the artifact itself.
      "--approval",
      "ask",
      "--data-dir",
      dataDirectory,
      "do the thing",
    ],
    { io: result.io, runtimeFactory },
  );

  expect(code, result.stderr()).toBe(EXIT.reviewRequired);
  const artifactMatch = /Pending artifact review: (art-\S+)/.exec(result.stderr());
  expect(artifactMatch, result.stderr()).not.toBeNull();
  const taskMatch = /Task (\S+) is waiting on artifact review/.exec(result.stderr());
  expect(taskMatch, result.stderr()).not.toBeNull();
  return { artifactId: artifactMatch?.[1] ?? "", taskId: taskMatch?.[1] ?? "", stderr: result.stderr() };
}

describe("tavi artifacts approve|reject --resume", () => {
  it("approves a pending artifact and resumes the specific suspended task to completion", async () => {
    const dataDirectory = tempDirectory();
    const { artifactId } = await suspendOnPendingArtifact(dataDirectory);

    // A fresh model instance for the SEPARATE resume process — the task's
    // conversation already has the tool result; resuming needs one more
    // model turn to produce final text.
    const resumeModel = createFixtureModel({ turns: [{ text: "acknowledged" }] });
    const runtimeFactory: RuntimeFactory = (options) =>
      composeTaviRuntime({ ...options, devFixtureTools: true }, { modelOverride: resumeModel });

    const result = capture();
    const code = await main(
      [
        "artifacts",
        "approve",
        artifactId,
        "--resume",
        "--connection",
        "fixture-conn-2",
        "--model",
        "fixture-model-2",
        "--data-dir",
        dataDirectory,
      ],
      { io: result.io, runtimeFactory },
    );

    expect(code, result.stderr()).toBe(EXIT.ok);
    expect(result.stdout()).toContain(`"artifactId": "${artifactId}"`);
    expect(result.stdout()).toContain(`"reviewState": "approved"`);
    expect(result.stdout()).toContain("acknowledged");
  });

  it("rejects a pending artifact and resumes: the task completes with a typed rejection, not left suspended", async () => {
    const dataDirectory = tempDirectory();
    const { artifactId } = await suspendOnPendingArtifact(dataDirectory);

    const resumeModel = createFixtureModel({ turns: [{ text: "understood" }] });
    const runtimeFactory: RuntimeFactory = (options) =>
      composeTaviRuntime({ ...options, devFixtureTools: true }, { modelOverride: resumeModel });

    const result = capture();
    const code = await main(
      [
        "artifacts",
        "reject",
        artifactId,
        "--resume",
        "--connection",
        "fixture-conn-2",
        "--model",
        "fixture-model-2",
        "--data-dir",
        dataDirectory,
      ],
      { io: result.io, runtimeFactory },
    );

    expect(code, result.stderr()).toBe(EXIT.ok);
    expect(result.stdout()).toContain(`"reviewState": "rejected"`);
    expect(result.stdout()).toContain("understood");
  });

  it("without --resume, the decision is recorded but the task's own stored status stays non-terminal", async () => {
    const dataDirectory = tempDirectory();
    const { artifactId, taskId } = await suspendOnPendingArtifact(dataDirectory);

    const result = capture();
    const code = await main(["artifacts", "approve", artifactId, "--data-dir", dataDirectory], { io: result.io });

    expect(code, result.stderr()).toBe(EXIT.ok);
    expect(result.stdout()).toContain(`"reviewState": "approved"`);
    // No resume attempted: no model flags were given, no event stream printed.
    expect(result.stdout()).not.toMatch(/\[tool\]/);

    // Directly confirm the task's own stored status, not just the absence
    // of a resume attempt's side effects.
    const tasksResult = capture();
    const tasksCode = await main(["tasks", taskId, "--data-dir", dataDirectory], { io: tasksResult.io });
    expect(tasksCode, tasksResult.stderr()).toBe(EXIT.ok);
    const document = JSON.parse(tasksResult.stdout()) as { task: { status: string } | null };
    expect(document.task?.status).toBe("waiting");
  });

  it("--resume on an artifact with no associated task records the decision and returns EXIT.resumeNotApplicable", async () => {
    const dataDirectory = tempDirectory();

    // Seed a pending artifact directly with no `runId` — the shape an
    // internal producer (not a suspended task) can create.
    const seedModel = createFixtureModel({ turns: [{ text: "unused" }] });
    const seedRuntime = await composeTaviRuntime(fixtureRuntimeOptions(dataDirectory), { modelOverride: seedModel });
    const seeded = await seedRuntime.store.asPort().repositories.artifacts.putArtifact({
      workspaceId: "default",
      contentType: "text/plain",
      body: "no associated task",
      reviewState: "pending",
    });
    await seedRuntime.close();

    const resumeModel = createFixtureModel({ turns: [{ text: "unused" }] });
    const runtimeFactory: RuntimeFactory = (options) =>
      composeTaviRuntime({ ...options, devFixtureTools: true }, { modelOverride: resumeModel });

    const result = capture();
    const code = await main(
      [
        "artifacts",
        "approve",
        seeded.artifactId,
        "--resume",
        "--connection",
        "fixture-conn-2",
        "--model",
        "fixture-model-2",
        "--data-dir",
        dataDirectory,
      ],
      { io: result.io, runtimeFactory },
    );

    expect(code, result.stderr()).toBe(EXIT.resumeNotApplicable);
    expect(result.stdout()).toContain(`"reviewState": "approved"`);
    expect(result.stderr()).toMatch(/nothing to resume/);
  });

  it("marks the task failed when the resume admission throws, instead of leaving it stuck waiting", async () => {
    const dataDirectory = tempDirectory();
    const { artifactId, taskId } = await suspendOnPendingArtifact(dataDirectory);

    const throwingModel: ModelPort = {
      async stream(): Promise<never> {
        throw new Error("boom: simulated transport failure");
      },
    };
    const runtimeFactory: RuntimeFactory = (options) =>
      composeTaviRuntime({ ...options, devFixtureTools: true }, { modelOverride: throwingModel });

    const result = capture();
    const code = await main(
      [
        "artifacts",
        "approve",
        artifactId,
        "--resume",
        "--connection",
        "fixture-conn-2",
        "--model",
        "fixture-model-2",
        "--data-dir",
        dataDirectory,
      ],
      { io: result.io, runtimeFactory },
    );

    expect(code, result.stderr()).not.toBe(EXIT.ok);
    expect(result.stdout()).toContain(`"reviewState": "approved"`);

    const tasksResult = capture();
    const tasksCode = await main(["tasks", taskId, "--data-dir", dataDirectory], { io: tasksResult.io });
    expect(tasksCode, tasksResult.stderr()).toBe(EXIT.ok);
    const document = JSON.parse(tasksResult.stdout()) as { task: { status: string } | null };
    // Not left stuck "waiting" — the failed resume attempt is recorded.
    expect(document.task?.status).toBe("failed");
  });

  it("resumes after each acknowledgement when one turn flagged two artifacts", async () => {
    // The review node suspends again under the *same* round while a flagged
    // artifact is still undecided. Keyed on the round alone, the second
    // acknowledgement replayed the first and the task waited for good.
    const dataDirectory = tempDirectory();
    let attempts = 0;
    const twoCalls: ModelPort = {
      async stream(request, { onEvent }) {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [
              { id: "call-a", name: "fixture.capture", input: {} },
              { id: "call-b", name: "fixture.capture", input: {} },
            ],
            finishReason: "tool-calls",
            usage: {},
          };
        }
        // Streamed, as a real transport does: the foreground renders deltas.
        onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: `block-${request.attemptId}`, text: "both reviewed" });
        return { status: "completed", attemptId: request.attemptId, text: "both reviewed", toolCalls: [], usage: {} };
      },
    };
    const runtimeFactory: RuntimeFactory = (options) =>
      composeTaviRuntime(
        { ...options, devFixtureTools: true },
        { modelOverride: twoCalls, sandboxOverride: createFixtureSandbox({ mode: "echo" }) },
      );

    const run = capture();
    const runCode = await main(
      ["run", "--connection", "fixture-conn", "--model", "fixture-model", "--approval", "ask", "--data-dir", dataDirectory, "do both"],
      { io: run.io, runtimeFactory },
    );
    expect(runCode, run.stderr()).toBe(EXIT.reviewRequired);
    const artifactIds = [...run.stderr().matchAll(/Pending artifact review: (art-\S+)/g)].map((match) => match[1] ?? "");
    expect(artifactIds).toHaveLength(2);

    const resume = async (artifactId: string) => {
      const result = capture();
      const code = await main(
        [
          "artifacts",
          "approve",
          artifactId,
          "--resume",
          "--connection",
          "fixture-conn",
          "--model",
          "fixture-model",
          "--data-dir",
          dataDirectory,
        ],
        { io: result.io, runtimeFactory },
      );
      return { code, result };
    };
    const first = await resume(artifactIds[0] ?? "");
    // The other artifact is still pending, so the task suspends on it again.
    expect(first.code, first.result.stderr()).toBe(EXIT.reviewRequired);
    const second = await resume(artifactIds[1] ?? "");
    expect(second.code, second.result.stderr()).toBe(EXIT.ok);
    expect(second.result.stdout(), second.result.stderr()).toContain("both reviewed");
  });

  it("does not resume a task that is not waiting on a review, and says the decision was still recorded", async () => {
    const dataDirectory = tempDirectory();
    const { artifactId, taskId } = await suspendOnPendingArtifact(dataDirectory);
    const cancel = capture();
    expect(await main(["cancel", taskId, "--reason", "stop", "--data-dir", dataDirectory], { io: cancel.io }), cancel.stderr()).toBe(
      EXIT.ok,
    );

    const resumeModel = createFixtureModel({ turns: [{ text: "should not run" }] });
    const runtimeFactory: RuntimeFactory = (options) =>
      composeTaviRuntime({ ...options, devFixtureTools: true }, { modelOverride: resumeModel });
    const result = capture();
    const code = await main(
      [
        "artifacts",
        "approve",
        artifactId,
        "--resume",
        "--connection",
        "fixture-conn-2",
        "--model",
        "fixture-model-2",
        "--data-dir",
        dataDirectory,
      ],
      { io: result.io, runtimeFactory },
    );
    expect(code, result.stderr()).toBe(EXIT.resumeNotApplicable);
    expect(result.stdout()).toContain(`"reviewState": "approved"`);
    expect(result.stderr()).toMatch(/is cancelled/);
    expect(result.stderr()).toMatch(/decision is recorded/);
    expect(resumeModel.calls).toHaveLength(0);

    const tasksResult = capture();
    await main(["tasks", taskId, "--data-dir", dataDirectory], { io: tasksResult.io });
    expect((JSON.parse(tasksResult.stdout()) as { task: { status: string } }).task.status).toBe("cancelled");
  });
});
