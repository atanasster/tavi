import { join } from "node:path";

import { EXECUTION_SUPERSEDED, TaviError, approvalRoundKey, type ClientEvent, type ModelOutcome, type ModelPort } from "@tavi/contracts";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { EXIT, main } from "../../src/main.js";
import type { RuntimeFactory } from "../../src/cli/runtime-options.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The foreground renders the task's bus stream: one epoch, one
 * contiguous sequence, and exactly one terminal event — including on the failure
 * paths, where the decorator may have published nothing.
 */

const directories = temporaryDirectories({ prefix: "tavi-foreground-" });
afterEach(() => directories.cleanup());

const ndjson = (text: string): ClientEvent[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ClientEvent);

/** One stream: a single epoch, and sequences that count up by one from the first. */
function expectOneStream(events: readonly ClientEvent[]): void {
  expect(new Set(events.map((event) => event.epoch)).size).toBe(1);
  const first = events[0]?.sequence ?? 0;
  expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => first + index));
}

const terminals = (events: readonly ClientEvent[]) =>
  events.filter((event) => event.kind === "task.completed" || event.kind === "task.failed");

/** A model that asks for a mutating tool (an approval round), then answers. */
function gatedFactory(): RuntimeFactory {
  const model = createFixtureModel({
    turns: [{ toolCall: { id: "call-1", name: "browser.create_session", input: {} } }, { text: "carried on" }],
  });
  return (options) => composeTaviRuntime(options, { modelOverride: model, browserOverride: createFixtureBrowser() });
}

const runArgs = (directory: string, extra: readonly string[]) => [
  "run",
  "--connection",
  "fixture-conn",
  "--model",
  "fixture-model",
  "--format",
  "json",
  "--data-dir",
  directory,
  ...extra,
  "open a browser",
];

describe("the foreground's rendered stream", () => {
  it("ends a failed run with exactly one task.failed", async () => {
    const failing: ModelPort = {
      ...createFixtureModel({ turns: [{ text: "x" }] }),
      stream: async (request): Promise<ModelOutcome> => ({
        status: "failed",
        attemptId: request.attemptId,
        text: "",
        toolCalls: [],
        usage: {},
        error: { code: "provider", message: "upstream 500", retryable: true },
      }),
    };
    const run = capture();
    const code = await main(runArgs(directories.create(), []), {
      io: run.io,
      runtimeFactory: (options) => composeTaviRuntime(options, { modelOverride: failing }),
    });
    expect(code).toBe(EXIT.taskFailed);
    const events = ndjson(run.stdout());
    expectOneStream(events);
    expect(terminals(events)).toEqual([expect.objectContaining({ kind: "task.failed", errorCode: "MODEL_FAILED" })]);
  });

  it("does not report a resume refused before it ran as a failed task, and keeps one stream", async () => {
    // Re-running a finished run's key with the opposite verdict: the first
    // admission replays its round, and the resume under that round's key is
    // refused — a different decision for a round already decided — before it is
    // ever claimed. Nothing ran: the task is as it was (completed), so it is
    // neither marked failed nor given a `task.failed`, and what was rendered is
    // one stream (a separate failure sink used to restart the epoch mid-stream).
    const directory = directories.create();
    const factory = gatedFactory();
    const first = capture();
    expect(
      await main(runArgs(directory, ["--operation-key", "op-once", "--approval", "approve"]), { io: first.io, runtimeFactory: factory }),
      first.stderr(),
    ).toBe(EXIT.ok);

    const again = capture();
    const code = await main(runArgs(directory, ["--operation-key", "op-once", "--approval", "deny"]), {
      io: again.io,
      runtimeFactory: factory,
    });
    expect(code).toBe(EXIT.unavailable);
    expect(again.stderr()).toContain("refused (CONFLICT)");
    const events = ndjson(again.stdout());
    expect(events.map((event) => event.kind)).toContain("approval.required");
    expectOneStream(events);
    expect(terminals(events)).toEqual([]);
    // The task the first run completed is still completed.
    const store = await composeTaviRuntime(
      fixtureRuntimeOptions(directory, {
        workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["runs.create"] }],
        defaultConnectionId: "fixture-conn",
      }),
      { requireModelTransport: false },
    );
    try {
      expect((await store.store.asPort().repositories.tasks.get(events[0]?.runId ?? ""))?.status).toBe("completed");
    } finally {
      await store.close();
    }
  });

  it("says a resume superseded while it ran was superseded, not refused, and leaves the task to its new owner", async () => {
    // The lease fence's CONFLICT is raised after the graph ran: work may have
    // happened, so "the admission was refused" would be wrong. The task belongs
    // to the generation that superseded this one and is not marked failed.
    const directory = directories.create();
    const inner = gatedFactory();
    const runtimeFactory: RuntimeFactory = async (options, composition) => {
      const runtime = await inner(options, composition);
      const workflow = runtime.workflow;
      if (workflow === undefined) return runtime;
      return {
        ...runtime,
        workflow: {
          ...workflow,
          admit: async (input, admitOptions) => {
            if (input.kind !== "approval") return workflow.admit(input, admitOptions);
            throw new TaviError("CONFLICT", "Execution 1 for task t was superseded by generation 2", {
              details: { reason: EXECUTION_SUPERSEDED },
            });
          },
        },
      };
    };
    const run = capture();
    const code = await main(runArgs(directory, ["--approval", "approve"]), { io: run.io, runtimeFactory });
    expect(code).toBe(EXIT.unavailable);
    expect(run.stderr()).toMatch(/superseded while it ran/);
    expect(run.stderr()).not.toMatch(/was refused/);
    const events = ndjson(run.stdout());
    expect(terminals(events)).toEqual([]);
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      expect((await store.asPort().repositories.tasks.get(events[0]?.runId ?? ""))?.status).toBe("waiting");
    } finally {
      store.close();
    }
  });

  it("keys the foreground loop's resume on the round it decides", async () => {
    const directory = directories.create();
    const run = capture();
    expect(await main(runArgs(directory, ["--approval", "approve"]), { io: run.io, runtimeFactory: gatedFactory() })).toBe(EXIT.ok);
    const taskId = ndjson(run.stdout())[0]?.runId ?? "";
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directory, {
        workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["runs.create"] }],
        defaultConnectionId: "fixture-conn",
      }),
      { requireModelTransport: false },
    );
    try {
      const keys = (await runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).map((admission) => admission.operationKey);
      expect(keys).toContain(approvalRoundKey(taskId, 1));
    } finally {
      await runtime.close();
    }
  });

  it("renders an offline approval's resumed turn from the task's stream, with no second start", async () => {
    const directory = directories.create();
    const factory = gatedFactory();
    const suspended = capture();
    expect(await main(runArgs(directory, ["--approval", "ask"]), { io: suspended.io, runtimeFactory: factory })).toBe(
      EXIT.approvalRequired,
    );
    const taskId = ndjson(suspended.stdout())[0]?.runId ?? "";

    const decided = capture();
    const code = await main(
      [
        "approvals",
        "approve",
        taskId,
        "--connection",
        "fixture-conn",
        "--model",
        "fixture-model",
        "--format",
        "json",
        "--data-dir",
        directory,
      ],
      { io: decided.io, runtimeFactory: factory },
    );
    expect(code, decided.stderr()).toBe(EXIT.ok);
    const events = ndjson(decided.stdout());
    expect(events.map((event) => event.kind)).not.toContain("run.started");
    expect(events.every((event) => event.runId === taskId)).toBe(true);
    expectOneStream(events);
    expect(terminals(events)).toEqual([expect.objectContaining({ kind: "task.completed", finalText: "carried on" })]);
  });
});
