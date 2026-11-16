import { WorkflowWaitSuspend, isRefusedEarly, type AgentWaitIntentRecord, type AgentWaitOutcome, type ToolQuestion } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { awaitConnect, createConnectWaits } from "../../src/features/apps/connect-waits.js";
import { delay } from "@tavi/test-support";

/** Settling connect waits, and a call that waits for its account. */

const request = { appName: "Google Calendar", accountId: "mcp.gcal", reason: "its sign-in expired", health: "needs-sign-in" as const };
const waitOf = (waitId: string, taskId: string, accountId = "mcp.gcal"): AgentWaitIntentRecord => ({
  waitId,
  taskId,
  deadlineAt: "2026-10-16T09:30:00.000Z",
  state: "active",
  connect: { ...request, accountId },
});

function waits(rows: AgentWaitIntentRecord[], recheckMs: readonly number[] = []) {
  const settled: { waitId: string; outcome: AgentWaitOutcome; by?: string; via?: string }[] = [];
  const repositories = {
    agentWaits: {
      listActiveConnects: async () => rows.filter((row) => row.state === "active"),
      get: async (waitId: string) => rows.find((row) => row.waitId === waitId),
      settle: async (input: { waitId: string; outcome: AgentWaitOutcome; by?: string; via?: string }) => {
        const index = rows.findIndex((row) => row.waitId === input.waitId && row.state === "active");
        if (index < 0) return false;
        rows[index] = { ...(rows[index] as AgentWaitIntentRecord), state: "settled", settledOutcome: input.outcome };
        settled.push(input);
        return true;
      },
    },
    tasks: { get: async (taskId: string) => ({ taskId, workspaceId: taskId === "elsewhere" ? "other" : "default" }) },
    agentDelegations: {},
  } as never;
  return { connectWaits: createConnectWaits({ repositories, workflow: () => undefined, log: () => undefined, recheckMs }), settled };
}

describe("settling connect waits", () => {
  it("settles every wait for the account that signed in, and only those", async () => {
    const { connectWaits, settled } = waits([waitOf("w1", "t1"), waitOf("w2", "t2"), waitOf("w3", "t3", "mcp.other")]);
    expect(await connectWaits.connected("mcp.gcal")).toBe(2);
    expect(settled.map((entry) => [entry.waitId, entry.outcome, entry.via])).toEqual([
      ["w1", { kind: "answered", connect: { outcome: "connected" } }, "connected-apps"],
      ["w2", { kind: "answered", connect: { outcome: "connected" } }, "connected-apps"],
    ]);
  });

  it("looks again shortly after a sign-in, for a wait made as it landed", async () => {
    const rows: AgentWaitIntentRecord[] = [];
    const { connectWaits, settled } = waits(rows, [20]);
    expect(await connectWaits.connected("mcp.gcal")).toBe(0);
    // Its task suspends a moment later: the wait is active only now.
    rows.push(waitOf("w1", "t1"));
    await delay(60);
    expect(settled.map((entry) => entry.waitId)).toEqual(["w1"]);
  });

  it("settles Not now for that task's wait alone, in its own workspace, once", async () => {
    const { connectWaits, settled } = waits([waitOf("w1", "t1"), waitOf("w2", "t2"), waitOf("w9", "elsewhere")]);
    await connectWaits.decline("w1", "default");
    expect(settled).toEqual([expect.objectContaining({ waitId: "w1", outcome: { kind: "answered", connect: { outcome: "declined" } } })]);
    await expect(connectWaits.decline("w1", "default")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(connectWaits.decline("w9", "default")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a call waiting for its account", () => {
  const asking = (outcome: AgentWaitOutcome | undefined) => {
    const asked: ToolQuestion[] = [];
    const ask = async (question: ToolQuestion): Promise<AgentWaitOutcome> => {
      asked.push(question);
      if (outcome === undefined) throw new WorkflowWaitSuspend({ waitId: "w1", deadlineAt: "2026-10-16T09:30:00.000Z", connect: request });
      return outcome;
    };
    return { ask, asked };
  };

  it("suspends the task on a connect wait of half an hour, no question to answer", async () => {
    const { ask, asked } = asking(undefined);
    await expect(awaitConnect(ask, request, { mcpFailure: "login", pluginId: "mcp.gcal" })).rejects.toBeInstanceOf(WorkflowWaitSuspend);
    expect(asked).toEqual([
      {
        key: "connect",
        question: "Google Calendar needs you to sign in again. Open Tavi on your computer → Connected apps.",
        deadlineMs: 30 * 60_000,
        connect: request,
      },
    ]);
  });

  it("goes on once connected, and ends the call with what happened otherwise, marked a sign-in", async () => {
    expect(await awaitConnect(asking({ kind: "answered", connect: { outcome: "connected" } }).ask, request, {})).toBe("connected");
    await expect(
      awaitConnect(asking({ kind: "answered", connect: { outcome: "declined" } }).ask, request, {
        mcpFailure: "login",
        pluginId: "mcp.gcal",
      }),
    ).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
      message: "Google Calendar is not signed in: the person chose not to sign in to Google Calendar again now.",
      details: { mcpFailure: "login", pluginId: "mcp.gcal" },
    });
    await expect(awaitConnect(asking({ kind: "wait-timeout" }).ask, request, {})).rejects.toMatchObject({
      message: "Google Calendar is not signed in: nobody signed in to Google Calendar again in time.",
    });
  });

  it("ends the call in Tavi's own words, so the chat reads nothing (QA 2090), and a first sign-in is not one again", async () => {
    const declined = await awaitConnect(asking({ kind: "answered", connect: { outcome: "declined" } }).ask, request, {}).catch(
      (error: unknown) => error,
    );
    expect(isRefusedEarly(declined)).toBe(true);
    const timedOut = await awaitConnect(asking({ kind: "wait-timeout" }).ask, { ...request, health: "not-set-up" }, {}).catch(
      (error: unknown) => error,
    );
    expect(isRefusedEarly(timedOut)).toBe(true);
    expect(timedOut).toMatchObject({ message: "Google Calendar is not signed in: nobody signed in to Google Calendar in time." });
  });
});
