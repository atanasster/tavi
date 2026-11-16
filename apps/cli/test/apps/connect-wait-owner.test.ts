import { temporaryDirectories, delay } from "@tavi/test-support";
import { ATTENDED_TASK_POLICY, UNATTENDED_TASK_POLICY, type TaskExecutionPolicy } from "@tavi/contracts";
import { sweepExpiredWaits } from "@tavi/agent-host/agent-wait-scheduler";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { awaitConnect } from "../../src/features/apps/connect-waits.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { answerNeed } from "../../src/features/approvals/needs-answer.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * A durable connect wait in the owner: a call that meets an account needing its sign-in waits in an
 * attended run; the account signing in resumes the task and the call runs
 * again; *Not now* tells the model; a run nobody attends does not wait.
 */

const directories = temporaryDirectories({ prefix: "tavi-connect-wait-" });
const runtimes: TaviRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
  directories.cleanup();
});

const request = { appName: "Google Calendar", accountId: "mcp.gcal", reason: "its sign-in expired", health: "needs-sign-in" as const };

async function owner(turns: readonly ScriptedTurn[], existing?: string) {
  const data = existing ?? directories.create();
  const model = createFixtureModel({ turns });
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data, { approvalRequiredFor: [] }), { modelOverride: model });
  runtimes.push(runtime);
  // An account that is signed in only once the test says so: its call waits for it until then.
  let signedIn = false;
  let runs = 0;
  runtime.tools.register({
    id: "fixture.calendar",
    version: "1.0.0",
    description: "Lists today's events.",
    effect: "read-only",
    sink: "none",
    requiredPermissions: ["tools.invoke"],
    inputSchema: z.object({}),
    handler: async ({ ask }) => {
      runs += 1;
      if (signedIn) return { events: ["Lunch"] };
      if (ask === undefined) throw new Error("Google Calendar needs a login");
      await awaitConnect(ask, request, { mcpFailure: "login", pluginId: "mcp.gcal" });
      throw new Error("still not signed in");
    },
  });
  return {
    runtime,
    model,
    data,
    signIn: () => {
      signedIn = true;
    },
    runs: () => runs,
  };
}

const listsEvents: ScriptedTurn[] = [{ toolCall: { id: "call-1", name: "fixture.calendar", input: {} } }, { text: "done" }];

async function start(runtime: TaviRuntime, executionPolicy: TaskExecutionPolicy = ATTENDED_TASK_POLICY): Promise<string> {
  const workflow =
    runtime.workflow ??
    (() => {
      throw new Error("no workflow");
    })();
  return (
    await workflow.admit({
      context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" },
      operationKey: `op-${Math.random().toString(36).slice(2)}`,
      kind: "start",
      prompt: "what's on today?",
      origin: "web",
      executionPolicy,
    })
  ).taskId;
}

async function status(runtime: TaviRuntime, taskId: string, wanted: readonly string[]): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await runtime.store.asPort().repositories.tasks.get(taskId);
    if (task !== undefined && wanted.includes(task.status)) return task.status;
    await delay(50);
  }
  throw new Error(`the task never reached ${wanted.join(" or ")}`);
}

const connects = async (runtime: TaviRuntime) =>
  (await runtime.store.asPort().repositories.approvalInbox.pendingWaits({ workspaceId: "default", limit: 10 })).connects ?? [];
const lastToolResult = (model: ReturnType<typeof createFixtureModel>): string => JSON.stringify(model.calls.at(-1)?.messages ?? []);

describe("a call that waits for its account", () => {
  it("waits in an attended run, and runs again once the account signs in", async () => {
    const { runtime, model, signIn, runs } = await owner(listsEvents);
    const taskId = await start(runtime);
    await status(runtime, taskId, ["waiting"]);
    const [need] = await connects(runtime);
    expect(need).toMatchObject({ taskId, ...request });
    // Not a question: no answer settles it.
    expect((await runtime.store.asPort().repositories.approvalInbox.pendingWaits({ workspaceId: "default", limit: 10 })).questions).toEqual(
      [],
    );
    signIn();
    expect(await runtime.connectWaits.connected("mcp.gcal")).toBe(1);
    expect(await status(runtime, taskId, ["completed", "failed"])).toBe("completed");
    expect(runs()).toBe(2);
    expect(lastToolResult(model)).toContain("Lunch");
    expect(await connects(runtime)).toEqual([]);
  }, 60_000);

  it("waits across an owner restart, and resumes there once the account signs in", async () => {
    const before = await owner(listsEvents);
    const taskId = await start(before.runtime);
    await status(before.runtime, taskId, ["waiting"]);
    expect((await connects(before.runtime)).map((row) => row.taskId)).toEqual([taskId]);
    await before.runtime.close();
    runtimes.splice(runtimes.indexOf(before.runtime), 1);
    // The owner starts again on the same data directory: the wait is still there.
    const after = await owner([{ toolCall: { id: "call-1", name: "fixture.calendar", input: {} } }, { text: "done" }], before.data);
    expect((await connects(after.runtime)).map((row) => row.taskId)).toEqual([taskId]);
    after.signIn();
    expect(await after.runtime.connectWaits.connected("mcp.gcal")).toBe(1);
    expect(await status(after.runtime, taskId, ["completed", "failed"])).toBe("completed");
    expect(after.runs()).toBe(1);
    expect(await connects(after.runtime)).toEqual([]);
  }, 90_000);

  it("tells the model the person chose not to connect, for that task alone", async () => {
    const { runtime, model } = await owner([...listsEvents, ...listsEvents]);
    const first = await start(runtime);
    await status(runtime, first, ["waiting"]);
    const second = await start(runtime);
    await status(runtime, second, ["waiting"]);
    const mine = (await connects(runtime)).find((row) => row.taskId === first);
    if (mine === undefined) throw new Error("no connect need");
    await runtime.connectWaits.decline(mine.waitId, "default");
    expect(await status(runtime, first, ["completed", "failed"])).toBe("completed");
    expect(lastToolResult(model)).toContain("the person chose not to sign in to Google Calendar again now");
    expect((await connects(runtime)).map((row) => row.taskId)).toEqual([second]);
  }, 60_000);

  it("is never settled by a typed answer, and denies the call when its deadline passes", async () => {
    const { runtime, model } = await owner(listsEvents);
    const taskId = await start(runtime);
    await status(runtime, taskId, ["waiting"]);
    const repositories = runtime.store.asPort().repositories;
    const typed = await answerNeed(
      { repositories, channelApprovals: runtime.channelApprovals, operatorOf: () => "operator" },
      {
        actor: { workspaceId: "default", principalId: "operator", caller: "cli", authority: "operator" },
        taskId,
        answer: "Connected",
        via: "cli",
      },
    );
    expect(typed).toMatchObject({ ok: false });
    expect((await connects(runtime)).map((row) => row.taskId)).toEqual([taskId]);
    const workflow =
      runtime.workflow ??
      (() => {
        throw new Error("no workflow");
      })();
    await sweepExpiredWaits({ waits: repositories.agentWaits, tasks: repositories.tasks, workflow, now: () => "2030-01-01T00:00:00.000Z" });
    expect(await status(runtime, taskId, ["completed", "failed"])).toBe("completed");
    expect(lastToolResult(model)).toContain("nobody signed in to Google Calendar again in time");
  }, 60_000);

  it("does not wait in a run nobody attends", async () => {
    const { runtime, model } = await owner(listsEvents);
    const taskId = await start(runtime, UNATTENDED_TASK_POLICY);
    expect(await status(runtime, taskId, ["completed", "failed"])).toBe("completed");
    expect(await connects(runtime)).toEqual([]);
    expect(lastToolResult(model)).toContain("needs a login");
    // The call is recorded with its tool and time, for its app's Recent activity.
    const calls = await runtime.store
      .asPort()
      .repositories.tasks.listCallsForTools({ workspaceId: "default", toolIds: ["fixture.calendar"], limit: 10 });
    expect(calls).toEqual([expect.objectContaining({ taskId, toolId: "fixture.calendar", callKey: `${taskId}:1:call-1` })]);
    expect(Number.isNaN(Date.parse(calls[0]?.at ?? ""))).toBe(false);
  }, 60_000);
});
