import type { ModelPort, ModelRequest } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, waitForValue, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { applyWorkspaceSetting } from "../../src/server/workspace-settings-commands.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime, TaviRuntimeOptions } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Task summaries in a composed owner: a
 * finished task gets a generated title and summary from one accounted,
 * tool-less call on its own model; with summaries off it keeps its prompt's
 * title and no call is made.
 */

const directories = temporaryDirectories({ prefix: "tavi-summaries-owner-" });
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

/** Answers a turn with "Done" and a summary call with its JSON; records every request. */
function model(requests: ModelRequest[]): ModelPort {
  return {
    async stream(request) {
      requests.push(request);
      const text =
        request.purpose === "summary"
          ? '{"title": "Plan the team offsite", "summary": "Drafted a two-day offsite agenda"}'
          : "Done: a two-day agenda.";
      return {
        attemptId: request.attemptId,
        status: "completed",
        text,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
  };
}

/** `timer: false` leaves the summarizer on its production timer, minutes long: only a task's end drains it. */
async function compose(requests: ModelRequest[], extra: Partial<TaviRuntimeOptions> = {}, timer = true): Promise<TaviRuntime> {
  const dataDirectory = directories.create();
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(dataDirectory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      taskSummariesEnabled: true,
      ...(timer ? { taskSummaryIntervalMs: 20 } : {}),
      ...extra,
    }),
    { modelOverride: model(requests) },
  );
  runtimes.push(runtime);
  return runtime;
}

const context = { workspaceId: "default", principalId: "alice", runId: "pending", caller: "test" } as const;

describe("task summaries in the owner", () => {
  it("summarize a finished task on its own model, record the cost against it, and show it in the list", async () => {
    const requests: ModelRequest[] = [];
    const runtime = await compose(requests);
    const admitted = await runtime.workflow?.admit({
      context,
      kind: "start",
      operationKey: "offsite",
      prompt: "can you sort out the offsite thing\nfor next month",
      origin: "ipc",
    });
    const taskId = admitted?.taskId ?? "";
    const row = await waitForValue(async () =>
      (await runtime.store.listTaskSessions({ workspaceId: "default" })).rows.find(
        (entry) => entry.taskId === taskId && entry.summaryState === "done",
      ),
    );
    expect(row).toMatchObject({
      title: "Plan the team offsite",
      titleSource: "generated",
      summary: "Drafted a two-day offsite agenda",
      promptPreview: "can you sort out the offsite thing\nfor next month",
    });
    // The task record carries them too: `tavi tasks <id>`, and a reminder's chat title.
    expect(await runtime.store.asPort().repositories.tasks.get(taskId)).toMatchObject({
      title: "Plan the team offsite",
      summary: "Drafted a two-day offsite agenda",
      summaryState: "done",
    });
    const summaryCall = requests.find((request) => request.purpose === "summary");
    expect(summaryCall).toMatchObject({ connectionId: "fixture", model: "fixture-model", runId: taskId, tools: [] });
    expect(summaryCall?.maxOutputTokens).toBeLessThanOrEqual(60);
    // Accounted like any other call, against the task.
    const attempts = await runtime.store.services.accounting.list(taskId);
    expect(attempts.map((attempt) => attempt.purpose).sort()).toEqual(["generation", "summary"]);
    expect(attempts.every((attempt) => attempt.state === "completed")).toBe(true);
  });

  it("summarize a task as soon as it ends, not at the summarizer's next timer", async () => {
    const requests: ModelRequest[] = [];
    const runtime = await compose(requests, {}, false);
    // The start-up drain has found nothing; the next timer is minutes away.
    await delay(50);
    const admitted = await runtime.workflow?.admit({
      context,
      kind: "start",
      operationKey: "ended",
      prompt: "Plan the offsite",
      origin: "ipc",
    });
    const taskId = admitted?.taskId ?? "";
    const row = await waitForValue(async () =>
      (await runtime.store.listTaskSessions({ workspaceId: "default" })).rows.find(
        (entry) => entry.taskId === taskId && entry.summaryState === "done",
      ),
    );
    expect(row).toMatchObject({ title: "Plan the team offsite" });
  });

  it("make no call when the workspace turned summaries off, and keep the prompt's title", async () => {
    const requests: ModelRequest[] = [];
    const runtime = await compose(requests);
    await applyWorkspaceSetting(runtime.store.asPort().repositories.workspaceSettings, {
      workspaceId: "default",
      key: "activitySummaries",
      value: "off",
      actor: "operator",
      now: nowTimestamp(),
    });
    const admitted = await runtime.workflow?.admit({
      context,
      kind: "start",
      operationKey: "quiet",
      prompt: "Book the train",
      origin: "ipc",
    });
    const row = await waitForValue(async () =>
      (await runtime.store.listTaskSessions({ workspaceId: "default" })).rows.find(
        (entry) => entry.taskId === admitted?.taskId && entry.summaryState === "skipped",
      ),
    );
    expect(row).toMatchObject({ title: "Book the train", titleSource: "prompt", summary: null });
    expect(requests.filter((request) => request.purpose === "summary")).toEqual([]);
  });

  it("are not written by a runtime that is not the serving owner", async () => {
    const requests: ModelRequest[] = [];
    const runtime = await compose(requests, { taskSummariesEnabled: false });
    await runtime.workflow?.admit({ context, kind: "start", operationKey: "one-shot", prompt: "Hello", origin: "ipc" });
    await delay(100);
    expect(requests.filter((request) => request.purpose === "summary")).toEqual([]);
  });
});
