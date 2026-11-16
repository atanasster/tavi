import {
  ATTENDED_TASK_POLICY,
  HEARTBEAT_FETCH_TOOL_ID,
  HEARTBEAT_TASK_POLICY,
  defaultHeartbeatConfig,
  policyAllowsTool,
  type AdmitInput,
  type HeartbeatState,
  type ModelRoleBinding,
  type WorkflowInvokeOptions,
} from "@tavi/contracts";
import { tickBudget, type HeartbeatTurnRequest } from "@tavi/agent-host/heartbeat-host";
import { WITHHELD_BY_PLUGIN } from "@tavi/agent-host/workflow";
import { describe, expect, it } from "vitest";

import { ToolRegistry } from "@tavi/runtime";

import {
  HeartbeatReports,
  createHeartbeatTurnRunner,
  registerHeartbeatFetchTool,
  type HeartbeatTurnDependencies,
} from "../../src/features/heartbeat/turns.js";

/**
 * A heartbeat provider's model turn as the owner runs it: admitted unattended under the tick's allowlist, on the heartbeat's
 * model, with its worst case reserved first and its real spend counted after.
 */

const AT = "2026-10-11T09:00:00.000Z";
const ITEM = { key: "billing:payment:pay_1", urgency: "now", title: "A payment failed", sources: [{ label: "Billing" }] };

function state(config: Partial<HeartbeatState["config"]> = {}): HeartbeatState {
  return {
    workspaceId: "default",
    principalId: "alice",
    config: { ...defaultHeartbeatConfig(), enabled: true, instructions: "Watch payments", ...config },
    createdAt: AT,
    updatedAt: AT,
  };
}

/** A fake owner: its workflow runs `turn` as the admitted task, reporting through `reports` as the tool would. */
function owner(
  turn: (
    taskId: string,
    options: WorkflowInvokeOptions | undefined,
    reports: HeartbeatReports,
  ) => Promise<"completed" | "failed"> = async () => "completed",
  binding?: ModelRoleBinding,
) {
  const reports = new HeartbeatReports();
  const admitted: AdmitInput[] = [];
  const chosen: string[] = [];
  const cancelled: string[] = [];
  const deps: HeartbeatTurnDependencies = {
    workflow: {
      admit: async (input, options) => {
        admitted.push(input);
        await input.onAdmitted?.({ taskId: "task-1", threadId: "thread-1", admissionId: "adm-1", created: true });
        const status = await turn("task-1", options, reports);
        return { taskId: "task-1", threadId: "thread-1", outcome: { status, finalText: "" }, created: true, replay: false };
      },
    },
    reports,
    models: { getRoleBinding: async () => binding, listCatalog: async () => [] },
    choose: async (_scope, taskId, target) => {
      chosen.push(`${taskId} ${target.connectionId}/${target.model}`);
    },
    accounting: {
      price: async () => undefined,
      summaries: async () => [
        {
          callId: "c1",
          attemptId: "a1",
          connectionId: "main",
          model: "small",
          state: "completed",
          purpose: "generation",
          usage: { inputTokens: 300, outputTokens: 20, totalTokens: 320, inputCacheReadTokens: 200 },
          startedAt: AT,
        },
      ],
      costTotals: async () => ({ attempts: 1, priced: 0, usd: 0 }),
    },
    readOnlyTool: (toolId) => toolId !== "acme.write",
    pluginTool: (toolId) => toolId.startsWith("acme."),
    cancel: async (taskId) => {
      cancelled.push(taskId);
    },
    now: () => AT,
  };
  return { run: createHeartbeatTurnRunner(deps), deps, admitted, chosen, cancelled };
}

function request(overrides: Partial<HeartbeatTurnRequest> = {}): HeartbeatTurnRequest {
  return {
    state: state({ model: { connectionId: "main", model: "small" } }),
    operationKey: "heartbeat:default:alice:2026-10-11T09:00:00.000Z:interval:1",
    prompt: "check",
    tools: ["memory.search", "acme.read", "acme.write", "fs.read", "heartbeat.report"],
    model: "fast",
    personal: true,
    tickKey: "heartbeat:default:alice:2026-10-11T09:00:00.000Z:interval",
    budget: tickBudget({ modelTicks: 10, tokens: 1_000_000 }),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("a heartbeat turn", () => {
  it("is admitted unattended, from the heartbeat, on its model, and hands back what it reported with its usage", async () => {
    const { run, admitted, chosen } = owner(async (taskId, _options, reports) => {
      reports.report(taskId, [ITEM]);
      return "completed";
    });
    const result = await run(request());
    expect(admitted[0]).toMatchObject({
      kind: "start",
      chatKind: "run",
      origin: "heartbeat",
      operationKey: "heartbeat:default:alice:2026-10-11T09:00:00.000Z:interval:1",
      executionPolicy: { mode: "unattended", humanQuestionsAllowed: false },
    });
    // A plugin tool joins only when it is read-only, and an extra tool only when it is a plugin's (`fs.read` is read-only but built in).
    expect(admitted[0]?.executionPolicy?.toolAllowlist).toEqual(["memory.search", "acme.read", "heartbeat.report"]);
    expect(chosen).toEqual(["task-1 main/small"]);
    expect(result).toMatchObject({
      items: [ITEM],
      taskId: "task-1",
      tokens: 320,
      cacheReadTokens: 200,
      costUsd: null,
      withheld: false,
      completed: true,
    });
  });

  it("starts with where its instructions came from when a chat proposed them under taint, and clean otherwise", async () => {
    const { run, admitted } = owner();
    const provenance = {
      integrity: "untrusted" as const,
      sources: ["web" as const],
      refs: [{ source: "web" as const, ref: "call-1", host: "deals.example", at: AT }],
    };
    await run(request({ state: state({ model: { connectionId: "main", model: "small" }, provenance }) }));
    await run(request());
    expect(admitted[0]?.context).toMatchObject({ inheritedTaint: true, inheritedLabel: { integrity: "untrusted", sources: ["web"] } });
    expect(admitted[1]?.context.inheritedLabel).toBeUndefined();
    expect(admitted[1]?.context.inheritedTaint).toBeUndefined();
  });

  it("runs the fast role's model when the heartbeat names none, and refuses when neither is set", async () => {
    const bound = owner(undefined, {
      workspaceId: "default",
      role: "fast",
      target: { connectionId: "cheap", model: "mini" },
      fallback: [],
      updatedAt: AT,
    });
    await bound.run(request({ state: state() }));
    expect(bound.chosen).toEqual(["task-1 cheap/mini"]);
    const unbound = owner();
    await expect(unbound.run(request({ state: state() }))).rejects.toMatchObject({ reason: "invalid" });
    expect(unbound.admitted).toEqual([]);
  });

  it("is refused before it runs when its worst case does not fit what is left of the budget", async () => {
    const { run, admitted } = owner();
    await expect(run(request({ budget: tickBudget({ modelTicks: 10, tokens: 1_000 }) }))).rejects.toMatchObject({ reason: "budget" });
    expect(admitted).toEqual([]);
  });

  it("counts what it really spent in place of its reservation", async () => {
    const budget = tickBudget({ modelTicks: 10, tokens: 100_000 });
    await owner().run(request({ budget }));
    // 320 spent: what is left now fits a reservation of all but those tokens, and no more.
    expect(budget.reserve({ tokens: 100_000 - 320 })).toBe(true);
    expect(budget.reserve({ tokens: 1 })).toBe(false);
  });

  it("counts what its priced calls cost within the tick even when some had no price", async () => {
    const budget = tickBudget({ modelTicks: 10, tokens: 1_000_000, usd: 0.1 });
    const runner = createHeartbeatTurnRunner({
      ...owner().deps,
      accounting: { ...owner().deps.accounting, costTotals: async () => ({ attempts: 2, priced: 1, usd: 0.08 }) },
    });
    const result = await runner(request({ budget }));
    expect(result.costUsd).toBeNull();
    // 0.08 spent of 0.10: the next call fits only what is left.
    expect(budget.reserve({ tokens: 1, usd: 0.03 })).toBe(false);
    expect(budget.reserve({ tokens: 1, usd: 0.01 })).toBe(true);
  });

  it("says when a hook withheld a tool result in it", async () => {
    const { run } = owner(async (_taskId, options) => {
      await options?.onToolEvent?.({
        phase: "failed",
        callId: "c1",
        toolName: "memory.search",
        message: JSON.stringify({ error: WITHHELD_BY_PLUGIN, plugin: "acme.guard", reason: "no" }),
      });
      return "completed";
    });
    expect((await run(request())).withheld).toBe(true);
  });

  it("says when the run did not complete, still counting what it spent, and reports nothing of it", async () => {
    const budget = tickBudget({ modelTicks: 10, tokens: 100_000 });
    const result = await owner(async (taskId, _options, reports) => {
      reports.report(taskId, [ITEM]);
      return "failed";
    }).run(request({ budget }));
    expect(result).toMatchObject({ completed: false, items: [], taskId: "task-1", tokens: 320 });
    expect(budget.reserve({ tokens: 100_000 - 320 })).toBe(true);
  });

  it("stops the run when the tick runs past its time, even before the run was admitted", async () => {
    const controller = new AbortController();
    const stopped = owner(async () => {
      controller.abort(new Error("the heartbeat tick ran past its time"));
      return "failed";
    });
    await stopped.run(request({ signal: controller.signal }));
    expect(stopped.cancelled).toEqual(["task-1"]);
    const early = new AbortController();
    early.abort(new Error("the heartbeat tick ran past its time"));
    const late = owner();
    await late.run(request({ signal: early.signal }));
    expect(late.cancelled).toEqual(["task-1"]);
  });

  it("lets its reservation go when it could not be admitted", async () => {
    const budget = tickBudget({ modelTicks: 10, tokens: 100_000 });
    const runner = createHeartbeatTurnRunner({
      ...owner().deps,
      workflow: {
        admit: async () => {
          throw new Error("the store is closed");
        },
      },
    });
    await expect(runner(request({ budget }))).rejects.toThrow("the store is closed");
    expect(budget.reserve({ tokens: 100_000 })).toBe(true);
  });
});

describe("heartbeat.fetch", () => {
  /** A registry with the tool, an open turn watching example.com/pricing, and a site whose pages the test sets. */
  function fetching() {
    const tools = new ToolRegistry();
    const reports = new HeartbeatReports();
    const pages: Record<string, string> = {
      "https://example.com/pricing":
        "Pricing. Pro: $20. See https://example.com/pro, https://elsewhere.test/x and https://example.com/changelog.",
      "https://example.com/pro": "Pro details; see https://example.com/deeper",
    };
    const fetched: string[] = [];
    registerHeartbeatFetchTool(tools, reports, async (url, hosts) => {
      fetched.push(`${url} ${hosts.join(",")}`);
      return { status: 200, text: pages[url] ?? "no such page" };
    });
    reports.open("task-1", "tavi.heartbeatagent", { hosts: ["example.com"], pages: ["https://example.com/pricing"] });
    const call = async (url: string, runId = "task-1") =>
      await tools.get(HEARTBEAT_FETCH_TOOL_ID)?.handler({
        input: { url },
        context: { workspaceId: "default", principalId: "alice", runId, caller: "test" },
        signal: new AbortController().signal,
      } as never);
    return { call, fetched, reports, tools };
  }

  it("is a read-only, untrusted, allowlist-only tool no other task can use", async () => {
    const { tools, call } = fetching();
    const tool = tools.get(HEARTBEAT_FETCH_TOOL_ID);
    expect(tool).toMatchObject({ effect: "read-only", untrustedOutput: true });
    expect(policyAllowsTool(ATTENDED_TASK_POLICY, HEARTBEAT_FETCH_TOOL_ID)).toBe(false);
    expect(policyAllowsTool(HEARTBEAT_TASK_POLICY, HEARTBEAT_FETCH_TOOL_ID)).toBe(true);
    await expect(call("https://example.com/pricing", "chat-1")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("reads a watched page, then a link found on it, on an allowed site only, and never a URL the model composed", async () => {
    const { call, fetched } = fetching();
    expect(await call("https://example.com/pricing#plans")).toMatchObject({
      url: "https://example.com/pricing",
      status: 200,
      text: expect.stringContaining("Pro: $20"),
    });
    expect(await call("https://example.com/pro")).toMatchObject({ text: expect.stringContaining("Pro details") });
    // One hop only: a link on a linked page is not followed.
    await expect(call("https://example.com/deeper")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    // A link to a site it may not read, and a page nothing linked to (as a URL carrying what the turn read would be).
    await expect(call("https://elsewhere.test/x")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(call("https://example.com/?q=ACME+pays+late")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(call("http://example.com/pricing")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetched).toEqual(["https://example.com/pricing example.com", "https://example.com/pro example.com"]);
  });

  it("holds a watched page to the site profiles' rules, read as unattended", async () => {
    const tools = new ToolRegistry();
    const reports = new HeartbeatReports();
    const asked: unknown[] = [];
    const fetched: string[] = [];
    const sites = {
      beforeNavigate: async (input: { readonly url: string; readonly unattended: boolean }) => (
        asked.push(input),
        input.url.startsWith("https://jobs.example/")
          ? { refused: "Jobs Board is read only while the person attends", host: "jobs.example" }
          : undefined
      ),
    };
    registerHeartbeatFetchTool(tools, reports, async (url) => (fetched.push(url), { status: 200, text: "ok" }), sites);
    reports.open("task-1", "tavi.heartbeatagent", {
      hosts: ["jobs.example", "example.com"],
      pages: ["https://jobs.example/search", "https://example.com/pricing"],
    });
    const call = (url: string) =>
      tools.get(HEARTBEAT_FETCH_TOOL_ID)?.handler({
        input: { url },
        context: { workspaceId: "default", principalId: "alice", runId: "task-1", caller: "test" },
        signal: new AbortController().signal,
      } as never);
    await expect(call("https://jobs.example/search")).rejects.toThrow(/only while the person attends/);
    await expect(call("https://example.com/pricing")).resolves.toMatchObject({ status: 200 });
    expect(fetched).toEqual(["https://example.com/pricing"]);
    expect(asked).toMatchObject([
      { url: "https://jobs.example/search", unattended: true, taskId: "task-1" },
      { url: "https://example.com/pricing", unattended: true },
    ]);
  });

  it("vouches to the gate for a watched page and a link the check read, never for a composed URL", async () => {
    const { call, tools } = fetching();
    const assess = (url: string, runId = "task-1") =>
      tools.get(HEARTBEAT_FETCH_TOOL_ID)?.assess?.({ url }, { workspaceId: "default", principalId: "alice", runId, caller: "test" });
    expect(assess("https://example.com/pricing")).toMatchObject({
      urls: ["https://example.com/pricing"],
      vouchedUrls: ["https://example.com/pricing"],
    });
    expect(assess("https://example.com/pro")?.vouchedUrls).toBeUndefined();
    await call("https://example.com/pricing");
    expect(assess("https://example.com/pro")?.vouchedUrls).toEqual(["https://example.com/pro"]);
    expect(assess("https://example.com/?q=ACME+pays+late")).toMatchObject({ urls: ["https://example.com/?q=ACME+pays+late"] });
    expect(assess("https://example.com/?q=ACME+pays+late")?.vouchedUrls).toBeUndefined();
    expect(assess("https://example.com/pricing", "chat-1")?.vouchedUrls).toBeUndefined();
  });

  it("counts its five pages across the check's turns, not per turn", async () => {
    const { call, reports } = fetching();
    reports.take("task-1");
    const scope = { hosts: ["example.com"], pages: ["https://example.com/pricing"] };
    reports.open("turn-1", "tavi.heartbeatagent", scope, { tickKey: "tick-a" });
    reports.open("turn-2", "tavi.heartbeatagent", scope, { tickKey: "tick-a" });
    for (let index = 0; index < 3; index += 1) await call("https://example.com/pricing", "turn-1");
    for (let index = 0; index < 2; index += 1) await call("https://example.com/pricing", "turn-2");
    await expect(call("https://example.com/pricing", "turn-1")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    // Another check starts its own count once this one's turns are closed.
    reports.take("turn-1");
    reports.take("turn-2");
    reports.open("turn-3", "tavi.heartbeatagent", scope, { tickKey: "tick-b" });
    expect(await call("https://example.com/pricing", "turn-3")).toMatchObject({ status: 200 });
  });

  it("reads at most five pages a check, and nothing once the turn is closed", async () => {
    const { call, reports } = fetching();
    for (let index = 0; index < 5; index += 1) await call("https://example.com/pricing");
    await expect(call("https://example.com/pricing")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    reports.take("task-1");
    await expect(call("https://example.com/pricing")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });
});

describe("a heartbeat turn's tool results", () => {
  it("are masked whatever the workspace's switch, and only a heartbeat turn's are", () => {
    const reports = new HeartbeatReports();
    reports.open("task-1", "tavi.heartbeatagent");
    expect(reports.alwaysRedacted({ caller: "workflow", runId: "task-1" })).toBe(true);
    expect(reports.alwaysRedacted({ caller: "heartbeat", runId: "pending-heartbeat-admission" })).toBe(true);
    expect(reports.alwaysRedacted({ caller: "cli", runId: "chat-1" })).toBe(false);
  });
});

describe("a heartbeat turn kept from the person", () => {
  it("is marked so while it runs, runs without the persona, and no heartbeat turn's prompt gets a second memory context", async () => {
    const seen: boolean[] = [];
    const { run, admitted } = owner(async (taskId, _options, reports) => {
      seen.push(reports.memoryWithheld(taskId));
      return "completed";
    });
    const withPersona = state({ model: { connectionId: "main", model: "small" }, agentId: "writer" });
    await run(request({ state: withPersona, personal: false }));
    await run(request({ state: withPersona, personal: true }));
    expect(seen).toEqual([true, true]);
    expect(admitted[0]?.context.agentDefinitionId).toBeUndefined();
    expect(admitted[1]?.context.agentDefinitionId).toBe("writer");
  });

  it("is marked as carrying the memory block only when its provider was handed memory, from before its first call until it closes", async () => {
    const seen: boolean[] = [];
    const { run, deps } = owner(async (taskId, _options, reports) => {
      seen.push(reports.memoryShown(taskId));
      return "completed";
    });
    await run(request({ memoryShown: true }));
    await run(request({ memoryShown: false }));
    await run(request());
    expect(seen).toEqual([true, false, false]);
    expect(deps.reports.memoryShown("task-1")).toBe(false);
  });
});

describe("a heartbeat turn's fetch scope", () => {
  it("is the heartbeat's hosts and its watched pages on them, as they were when the check began", async () => {
    let scope: { hosts: readonly string[]; pages: ReadonlySet<string> } | undefined;
    const { run } = owner(async (taskId, _options, reports) => {
      const open = reports.fetchScope(taskId);
      scope = open === undefined ? undefined : { hosts: [...open.hosts], pages: new Set(open.pages) };
      return "completed";
    });
    const watching = state({
      model: { connectionId: "main", model: "small" },
      fetchHosts: ["example.com"],
      instructions: "watch: https://example.com/pricing\nwatch: https://removed.test/news",
    });
    await run(request({ state: watching }));
    expect(scope).toEqual({ hosts: ["example.com"], pages: new Set(["https://example.com/pricing"]) });
  });
});

describe("a heartbeat turn's prompt-cache lifetime", () => {
  it("shares one key across a provider's ticks, and is kept an hour when the next check comes after five minutes and within 55", () => {
    const reports = new HeartbeatReports();
    const minutes = (count: number) => count * 60_000;
    reports.open("t-15", "p", undefined, { everyMs: minutes(15) });
    reports.open("t-5", "p", undefined, { everyMs: minutes(5) });
    reports.open("t-60", "p", undefined, { everyMs: minutes(60) });
    reports.open("t-none", "p");
    expect(["t-15", "t-5", "t-60", "t-none"].map((taskId) => reports.cacheOf(taskId))).toEqual([
      { key: "heartbeat:p", ttl: "1h" },
      { key: "heartbeat:p" },
      { key: "heartbeat:p" },
      { key: "heartbeat:p" },
    ]);
    reports.take("t-15");
    expect(reports.cacheOf("t-15")).toBeUndefined();
    expect(reports.cacheOf("never-opened")).toBeUndefined();
  });
});
