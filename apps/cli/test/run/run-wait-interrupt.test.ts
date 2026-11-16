import type { ClientEvent } from "@tavi/contracts";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { waitingText } from "../../src/features/run/waiting-text.js";
import { afterAll, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { EXIT, main } from "../../src/main.js";
import type { RuntimeFactory } from "../../src/cli/runtime-options.js";

/**
 * `tavi run`'s `waitInterrupt`/`EXIT.taskWaiting` handling — the sibling
 * of its `reviewInterrupt` handling. A `waitInterrupt`-only "waiting"
 * outcome (`agents.wait`) must not fall through to the `task.failed`
 * reporting path, which would misreport a task genuinely still
 * waiting on a correlated reply/worker completion/deadline as if it had
 * failed outright. Unlike a review decision, a wait resolves on its own
 * — there is deliberately no CLI verb suggested here to "decide" it,
 * only an honest status report.
 */

const directories = temporaryDirectories({ prefix: "tavi-run-wait-" });

afterAll(() => directories.cleanup());

/** Parses `--format json`'s one-event-per-line stdout into events. */
function parseEvents(stdout: string): ClientEvent[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ClientEvent);
}

async function runWait(
  waitInput: Record<string, unknown>,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string; readonly events: ClientEvent[] }> {
  const directory = directories.create();
  const model = createFixtureModel({
    turns: [{ toolCall: { id: "call-1", name: "agents.wait", input: waitInput } }, { text: "done" }],
  });

  const runtimeFactory: RuntimeFactory = (options) => composeTaviRuntime(options, { modelOverride: model });
  const result = capture();
  const code = await main(
    [
      "run",
      "--connection",
      "fixture-conn",
      "--model",
      "fixture-model",
      "--approval",
      "approve",
      "--data-dir",
      directory,
      "--format",
      "json",
      "wait for something",
    ],
    { io: result.io, runtimeFactory },
  );

  return { code, stdout: result.stdout(), stderr: result.stderr(), events: parseEvents(result.stdout()) };
}

describe("tavi run — waitInterrupt reporting", () => {
  it("reports EXIT.taskWaiting, not EXIT.taskFailed, when a turn suspends on a deadline-only agents.wait", async () => {
    const deadlineAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { code, stderr, events } = await runWait({ deadlineAt });

    expect(code, stderr).toBe(EXIT.taskWaiting);
    expect(stderr).toMatch(/is waiting on/);
    expect(stderr).toMatch(/its deadline/);
    expect(stderr).toMatch(/tavi tasks/);
    // Never misreported as a failure — checked against the actual parsed
    // event stream, not a substring guess about how text-mode renders it.
    expect(events.some((event) => event.kind === "task.failed")).toBe(false);
  });

  it("reports the correlationId reason when the wait is keyed on a correlated reply", async () => {
    const deadlineAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { code, stderr, events } = await runWait({ correlationId: "msg-1", deadlineAt });

    expect(code, stderr).toBe(EXIT.taskWaiting);
    expect(stderr).toMatch(/is waiting on a reply correlated to msg-1/);
    expect(events.some((event) => event.kind === "task.failed")).toBe(false);
  });

  it("reports the waitingOnWorkerTaskId reason when the wait is keyed on a worker task", async () => {
    const deadlineAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { code, stderr, events } = await runWait({ waitingOnWorkerTaskId: "task-worker-1", deadlineAt });

    expect(code, stderr).toBe(EXIT.taskWaiting);
    expect(stderr).toMatch(/is waiting on worker task task-worker-1 completing/);
    expect(events.some((event) => event.kind === "task.failed")).toBe(false);
  });
});

describe("waitingText", () => {
  it("says how to answer a question a task asks you, and that any other wait resolves on its own", () => {
    expect(
      waitingText("task-1", {
        on: "its deadline",
        deadlineAt: "2026-11-01T20:00:00.000Z",
        question: "Italian or Thai?",
        choices: { options: [{ label: "Italian" }, { label: "Thai" }], multiSelect: false, allowOther: false },
      }),
    ).toBe(
      "Task task-1 asks you: Italian or Thai?  [1. Italian  2. Thai]\nAnswer with `tavi answer task-1 <answer>` (until 2026-11-01T20:00:00.000Z).\n",
    );
    expect(waitingText("task-2", { on: "worker task w-1 completing", deadlineAt: "2026-11-01T20:00:00.000Z" })).toMatch(
      /resolves on its own/,
    );
  });
});
