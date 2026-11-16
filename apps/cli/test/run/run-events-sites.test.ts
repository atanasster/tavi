import type { ClientEvent, InboundEvent, InvocationContext, ModelEvent, ModelOutcome, ModelPort, ModelRequest } from "@tavi/contracts";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createAgentCommunicationService } from "@tavi/agent-host/agent-communication";
import { createIpcClient } from "@tavi/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime, TaviRuntimeOptions } from "../../src/runtime/types.js";
import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import type { RuntimeFactory } from "../../src/cli/runtime-options.js";
import { findLiveOwner, serve } from "../../src/server/serve.js";
import { requestWithSubscription } from "../support/ipc-run.js";
import { buildTaskShowDocument } from "../../src/features/doctor/reports.js";
import type { RecordedTask } from "@tavi/client";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, waitFor } from "@tavi/test-support";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Every admission site publishes its stream.
 *
 * The decorator wraps the one `WorkflowPort` every admitting path receives, so a
 * subscriber sees a terminal event however the task was admitted: a chat
 * message, a chat reply resuming the task, a schedule fire, an agent spawn and
 * the `agents.wait` deadline sweep. And the foreground `tavi run` renders the
 * same stream an attached client receives (the parity test).
 */

// The scripted model calls `fixture.echo`, which only composition's devFixtureTools option registers.
vi.mock("../../src/runtime/composition.js", async (original) =>
  (await import("../support/dev-fixture-tool.js")).withFixtureTools(await original()),
);

const directories = temporaryDirectories({ prefix: "tavi-sites-" });
const runtimes: TaviRuntime[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

const baseOptions = (directory: string): TaviRuntimeOptions =>
  fixtureRuntimeOptions(directory, { approvalRequiredFor: [], agentWaitSweepIntervalMs: 20, scheduleSweepIntervalMs: 20 });

/** A model answering each call from `turns` in order, the last repeating. */
function turnsModel(turns: readonly ((request: ModelRequest) => Omit<ModelOutcome, "attemptId">)[]): ModelPort {
  let call = 0;
  return {
    async stream(
      request: ModelRequest,
      options: { readonly signal: AbortSignal; readonly onEvent: (event: ModelEvent) => void },
    ): Promise<ModelOutcome> {
      const turn = turns[Math.min(call, turns.length - 1)];
      call += 1;
      const outcome = turn?.(request) ?? { status: "completed", text: "", toolCalls: [], usage: {} };
      if (outcome.text !== "") options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: outcome.text });
      return { ...outcome, attemptId: request.attemptId };
    },
  };
}

const say = (text: string) => (): Omit<ModelOutcome, "attemptId"> => ({ status: "completed", text, toolCalls: [], usage: {} });

async function compose(directory: string, model: ModelPort): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(baseOptions(directory), { modelOverride: model });
  runtimes.push(runtime);
  return runtime;
}

/**
 * Everything the bus holds and will deliver for a task, from its beginning: one
 * subscription, whose array fills as events arrive — poll the array, not this.
 */
function watch(runtime: TaviRuntime, taskId: string): ClientEvent[] {
  const events: ClientEvent[] = [];
  const { replayed } = runtime.runEventBus.subscribe({ taskId, from: "beginning", deliver: (event) => events.push(event) });
  events.unshift(...replayed);
  return events;
}

const kinds = (events: readonly ClientEvent[]): string[] => events.map((event) => event.kind);

function inbound(content: string, id: string): InboundEvent {
  return {
    connectionId: "chat-main",
    providerEventId: id,
    kind: "message",
    externalSenderId: "operator-chat",
    externalConversationId: "chat-1",
    externalMessageId: id,
    occurredAt: "2026-04-05T07:00:00.000Z",
    receivedAt: "2026-04-05T07:00:00.000Z",
    content,
  };
}

describe("every admission site publishes a stream a subscriber can follow to its end", () => {
  it("restores metrics and tool calls after the owner's event ring is lost", async () => {
    const directory = directories.create();
    const tool = (value: string) => (): Omit<ModelOutcome, "attemptId"> => ({
      status: "completed",
      text: "",
      toolCalls: [{ id: "reused", name: "fixture.echo", input: { message: value } }],
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    const runtime = await composeTaviRuntime(
      { ...baseOptions(directory), devFixtureTools: true },
      {
        modelOverride: turnsModel([
          tool("first"),
          tool("second"),
          () => ({ status: "completed", text: "Done", toolCalls: [], usage: { totalTokens: 20 } }),
        ]),
      },
    );
    runtimes.push(runtime);
    const result = await runtime.workflow!.admit({
      context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" },
      operationKey: "history",
      kind: "start",
      prompt: "echo twice",
    });
    expect(result.outcome.status).toBe("completed");
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    const restarted = await compose(directory, turnsModel([say("unused")]));
    expect(restarted.runEventBus.retains(result.taskId)).toBe(false);
    const document = (await buildTaskShowDocument(restarted.store, directory, result.taskId, restarted.clock.now())) as RecordedTask;
    expect(document.history?.metrics).toEqual({ models: ["fixture/fixture-model"], totalTokens: 52, partial: false });
    expect(document.history?.startedAt).toBeTruthy();
    expect(Date.parse(document.history!.lastAt!)).toBeGreaterThanOrEqual(Date.parse(document.history!.startedAt!));
    // Working time: the executions' own spans, never more than first start to last end.
    expect(document.history?.activeMs).toEqual(expect.any(Number));
    expect(document.history!.activeMs!).toBeLessThanOrEqual(
      Date.parse(document.history!.lastAt!) - Date.parse(document.history!.startedAt!),
    );
    expect(document.history?.tools).toMatchObject([
      {
        callId: "reused",
        input: { message: "first" },
        output: { echoed: "first" },
        status: "completed",
        model: "fixture/fixture-model",
        durationMs: expect.any(Number),
      },
      {
        callId: "reused",
        input: { message: "second" },
        output: { echoed: "second" },
        status: "completed",
        model: "fixture/fixture-model",
        durationMs: expect.any(Number),
      },
    ]);
    expect(new Set(document.history?.tools.map((call) => call.key)).size).toBe(2);
    expect(document.history?.partial).toBe(false);
  });

  it("a Home's first turn starts its stream, though a schedule started the Home", async () => {
    const runtime = await compose(directories.create(), turnsModel([say("hello")]));
    const taskId = (await runtime.workflow?.openHome?.({ workspaceId: "default", principalId: "operator" })) ?? "";
    const events = watch(runtime, taskId);
    await runtime.workflow?.admit({
      context: { workspaceId: "default", principalId: "operator", runId: taskId, caller: "test" },
      operationKey: "home-first",
      kind: "reply",
      taskId,
      prompt: "hi",
    });
    await waitFor(() => events.some((event) => event.kind === "task.completed"));
    expect(kinds(events)[0]).toBe("run.started");
  });

  it("a chat message starts one, and a reply resumes it with an attempt boundary", async () => {
    const runtime = await compose(directories.create(), turnsModel([say("hello back"), say("and again")]));
    await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "chat-main",
      externalSenderId: "operator-chat",
      workspaceId: "default",
      principalId: "operator",
      approvedBy: "test",
      createdAt: "2026-04-05T00:00:00.000Z",
    });

    await runtime.messaging.ingest(inbound("hello", "evt-1"));
    const taskId = (await runtime.store.asPort().repositories.messagingConversations.get("chat-main", "chat-1"))?.taskId ?? "";
    const events = watch(runtime, taskId);
    await waitFor(() => events.some((event) => event.kind === "task.completed"));
    expect(kinds(events).slice(0, 1)).toEqual(["run.started"]);

    await runtime.messaging.ingest(inbound("more", "evt-2"));
    await waitFor(() => events.filter((event) => event.kind === "task.completed").length === 2);
    const both = kinds(events);
    // One stream: one start, then a boundary for the reply, then its end.
    expect(both.filter((kind) => kind === "run.started")).toHaveLength(1);
    expect(both).toContain("attempt.replaced");
    expect(both.at(-1)).toBe("task.completed");
  });

  it("a schedule fire", async () => {
    const runtime = await compose(directories.create(), turnsModel([say("the brief")]));
    const due = new Date(Date.now() - 60_000).toISOString();
    await runtime.store.asPort().repositories.schedules.create({
      scheduleId: "sched-1",
      workspaceId: "default",
      principalId: "operator",
      name: "brief",
      prompt: "write the brief",
      spec: { at: "07:00", timezone: "UTC" },
      missedRunPolicy: "run-once-if-missed-within-6h",
      autoApproveTools: [],
      enabled: true,
      nextRunAt: due,
      now: due,
    });
    await waitFor(async () => (await runtime.store.listTasks(10)).length > 0);
    const taskId = (await runtime.store.listTasks(10))[0]?.taskId ?? "";
    expect((await runtime.store.asPort().repositories.tasks.get(taskId))?.origin).toBe("schedule");
    const events = watch(runtime, taskId);
    await waitFor(() => events.at(-1)?.kind === "task.completed");
    expect(kinds(events)[0]).toBe("run.started");
  });

  it("an agent spawn", async () => {
    const runtime = await compose(directories.create(), turnsModel([say("worker done")]));
    await runtime.store.asPort().repositories.agents.create({
      agentId: "worker",
      workspaceId: "default",
      name: "worker",
      systemPrompt: "Act as the worker.",
      enabled: true,
      now: nowTimestamp(),
    });
    const spawn = runtime.tools.get("agents.spawn");
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "root", caller: "test" };
    const spawned = (await spawn?.handler({
      input: { agentDefinitionId: "worker", input: "do the thing", operationKey: "op-spawn" },
      context,
      signal: new AbortController().signal,
    })) as { workerTaskId: string };
    const events = watch(runtime, spawned.workerTaskId);
    await waitFor(() => events.at(-1)?.kind === "task.completed");
    expect(kinds(events)[0]).toBe("run.started");
  });

  it("the agents.wait deadline sweep", async () => {
    const runtime = await compose(
      directories.create(),
      turnsModel([
        () => ({
          status: "completed",
          text: "",
          toolCalls: [{ id: "call-wait", name: "agents.wait", input: { deadlineAt: "2020-01-01T00:00:00.000Z" } }],
          usage: {},
        }),
        say("resumed at the deadline"),
      ]),
    );
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    const suspended = await runtime.workflow?.admit({ context, operationKey: "op-wait", kind: "start", prompt: "wait" });
    expect(suspended?.outcome.status).toBe("waiting");
    const taskId = suspended?.taskId ?? "";
    // The sweep — not this test — resumes it.
    const watched = watch(runtime, taskId);
    await waitFor(() => watched.at(-1)?.kind === "task.completed");
    const events = kinds(watched);
    expect(events).toContain("task.waiting");
    expect(events).toContain("attempt.replaced");
  });
});

describe("the resuming admission sites publish on the task's stream too", () => {
  const bindOperator = async (runtime: TaviRuntime): Promise<void> => {
    await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "chat-main",
      externalSenderId: "operator-chat",
      workspaceId: "default",
      principalId: "operator",
      approvedBy: "test",
      createdAt: "2026-04-05T00:00:00.000Z",
    });
  };
  const chatTaskOf = async (runtime: TaviRuntime): Promise<string> =>
    (await runtime.store.asPort().repositories.messagingConversations.get("chat-main", "chat-1"))?.taskId ?? "";
  const later = (): string => new Date(Date.now() + 3_600_000).toISOString();

  it("a chat `approve` deciding the conversation's round", async () => {
    const directory = directories.create();
    // The default approval policy, which gates the browser's session tool.
    const { approvalRequiredFor: _none, ...options } = baseOptions(directory);
    const runtime = await composeTaviRuntime(options, {
      modelOverride: turnsModel([
        () => ({
          status: "completed",
          text: "",
          toolCalls: [{ id: "call-open", name: "browser.create_session", input: {} }],
          finishReason: "tool-calls",
          usage: {},
        }),
        say("opened"),
      ]),
      browserOverride: createFixtureBrowser(),
    });
    runtimes.push(runtime);
    await bindOperator(runtime);
    await runtime.messaging.ingest(inbound("open a browser", "evt-1"));
    await waitFor(
      async () =>
        (await chatTaskOf(runtime)) !== "" &&
        (await runtime.store.asPort().repositories.tasks.get(await chatTaskOf(runtime)))?.status === "waiting",
    );
    const events = watch(runtime, await chatTaskOf(runtime));
    await runtime.messaging.ingest(inbound("approve", "evt-2"));
    await waitFor(() => events.at(-1)?.kind === "task.completed");
    expect(kinds(events)).toEqual(expect.arrayContaining(["approval.required", "approval.settled", "attempt.replaced"]));
  });

  it("a chat message answering the wait the task asked on", async () => {
    const runtime = await compose(
      directories.create(),
      turnsModel([
        () => ({
          status: "completed",
          text: "",
          toolCalls: [{ id: "call-wait", name: "agents.wait", input: { deadlineAt: later() } }],
          usage: {},
        }),
        say("thanks for the answer"),
      ]),
    );
    await bindOperator(runtime);
    await runtime.messaging.ingest(inbound("ask me something", "evt-1"));
    await waitFor(
      async () =>
        (await chatTaskOf(runtime)) !== "" &&
        (await runtime.store.asPort().repositories.tasks.get(await chatTaskOf(runtime)))?.status === "waiting",
    );
    const events = watch(runtime, await chatTaskOf(runtime));
    const taskId = await chatTaskOf(runtime);
    const wait = await runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId);
    expect(wait).toBeDefined();
    await runtime.messaging.ingest(inbound("acme, globex", "evt-2"));
    await waitFor(() => events.at(-1)?.kind === "task.completed");
    expect(kinds(events)).toEqual(expect.arrayContaining(["task.waiting", "attempt.replaced"]));
    // The wait's own resume, not an ordinary reply turn: the answer settled it.
    expect((await runtime.store.asPort().repositories.agentWaits.get(wait?.waitId ?? ""))?.settledOutcome).toMatchObject({
      kind: "answered",
    });
    expect((await runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).map((admission) => admission.kind)).toContain(
      "deadline",
    );
  });

  it("a worker's result settling the wait its orchestrator correlated on", async () => {
    // Only a delegated worker's own `worker-result:<id>` result settles a wait.
    let workerTaskId = "";
    const runtime = await compose(
      directories.create(),
      turnsModel([
        say("the worker ran"),
        () => ({
          status: "completed",
          text: "",
          toolCalls: [
            { id: "call-wait", name: "agents.wait", input: { correlationId: `worker-result:${workerTaskId}`, deadlineAt: later() } },
          ],
          usage: {},
        }),
        say("the orchestrator heard back"),
      ]),
    );
    const workflow = runtime.workflow;
    if (workflow === undefined) throw new Error("no workflow");
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    const worker = await workflow.admit({ context, operationKey: "op-worker", kind: "start", prompt: "work" });
    workerTaskId = worker.taskId;
    const orchestrator = await workflow.admit({ context, operationKey: "op-orchestrator", kind: "start", prompt: "delegate" });
    expect(orchestrator.outcome.status).toBe("waiting");
    await runtime.store.asPort().repositories.agentDelegations.recordSpawn({
      operationKey: "op-worker",
      workspaceId: context.workspaceId,
      principalId: context.principalId,
      workerTaskId: worker.taskId,
      workerAgentId: "worker",
      depth: 1,
      parentTaskId: orchestrator.taskId,
      rootTaskId: orchestrator.taskId,
      createdAt: new Date().toISOString(),
    });
    const events = watch(runtime, orchestrator.taskId);
    const wait = await runtime.store.asPort().repositories.agentWaits.getActiveByTask(orchestrator.taskId);
    expect(wait?.correlationId).toBe(`worker-result:${worker.taskId}`);
    const send = runtime.tools.get("agents.send");
    if (send === undefined) throw new Error("agents.send is not registered");
    await send.handler({
      input: {
        recipientAgentId: "orchestrator",
        recipientTaskId: orchestrator.taskId,
        kind: "result",
        content: "done",
        correlationId: `worker-result:${worker.taskId}`,
      },
      context: { ...context, runId: worker.taskId },
      signal: new AbortController().signal,
    });
    await waitFor(() => events.at(-1)?.kind === "task.completed");
    expect(kinds(events)).toEqual(expect.arrayContaining(["task.waiting", "attempt.replaced"]));
    // Settled by the worker's envelope, and resumed with it — not a wake.
    expect((await runtime.store.asPort().repositories.agentWaits.get(wait?.waitId ?? ""))?.settledOutcome).toMatchObject({
      kind: "replied",
    });
    expect(
      (await runtime.store.asPort().repositories.tasks.listAdmissions(orchestrator.taskId)).map((admission) => admission.kind),
    ).toContain("deadline");
  });

  it("a wake, over the wrapped port agent communication is built on", async () => {
    // Nothing in the CLI calls `wake` today, and composition keeps its service
    // to itself; one built the same way, over `runtime.workflow`, is driven here.
    const runtime = await compose(directories.create(), turnsModel([say("first"), say("woken")]));
    const workflow = runtime.workflow;
    if (workflow === undefined) throw new Error("no workflow");
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" };
    const first = await workflow.admit({ context, operationKey: "op-first", kind: "start", prompt: "go" });
    const events = watch(runtime, first.taskId);
    const repositories = runtime.store.asPort().repositories;
    const agents = createAgentCommunicationService({
      mailbox: repositories.agentMailbox,
      waits: repositories.agentWaits,
      delegations: repositories.agentDelegations,
      tasks: repositories.tasks,
      workflow,
      access: runtime.access,
      cancelTask: () => {
        throw new Error("not exercised");
      },
      now: () => runtime.clock.now(),
      newId: (prefix) => runtime.clock.newId(prefix),
    });
    await agents.wake({ actor: { principalId: "operator", workspaceId: "default", caller: "test" }, taskId: first.taskId });
    await waitFor(() => events.filter((event) => event.kind === "task.completed").length === 2);
    expect(kinds(events)).toContain("attempt.replaced");
  });
});

describe("the foreground and an attached client see the same stream", () => {
  /** A model turn that calls the dev fixture tool, then one that answers. */
  const toolThenAnswer = (): ModelPort =>
    turnsModel([
      () => ({
        status: "completed",
        text: "checking… ",
        toolCalls: [{ id: "call-1", name: "fixture.echo", input: { message: "ping", uppercase: true } }],
        usage: {},
      }),
      say("the tool said PING"),
    ]);

  /**
   * NDJSON with the per-run identities normalized: `epoch` and `at` differ by
   * construction, task, thread and attempt ids are minted per run (each is
   * replaced by the order it first appeared in), and wall-clock measurements —
   * a tool's `durationMs`, the fixture tool's `observedAt` — are timing, like
   * `at`.
   */
  function normalized(events: readonly ClientEvent[]): unknown[] {
    const seen = new Map<string, string>();
    const id = (value: string, prefix: string): string => {
      if (!seen.has(value)) seen.set(value, `${prefix}-${seen.size}`);
      return seen.get(value) ?? value;
    };
    return events.map((event) => {
      const { epoch: _epoch, at: _at, ...rest } = event;
      const copy: Record<string, unknown> = { ...rest, runId: id(event.runId, "run"), attemptId: id(event.attemptId, "attempt") };
      if ("threadId" in event) copy["threadId"] = id(event.threadId, "thread");
      if ("supersededAttemptId" in event) copy["supersededAttemptId"] = id(event.supersededAttemptId, "attempt");
      if ("durationMs" in copy) copy["durationMs"] = "<duration>";
      if ("output" in copy)
        copy["output"] = JSON.parse(JSON.stringify(copy["output"]).replace(/"observedAt":"[^"]*"/g, '"observedAt":"<at>"'));
      return copy;
    });
  }

  it("renders one fixture run to the same NDJSON in the foreground, on the bus and over IPC, modulo epoch and at", async () => {
    // Foreground: `tavi run --format json`.
    const directory = directories.create();
    let stdout = "";
    const io: CliIo = { stdout: (chunk) => (stdout += chunk), stderr: () => {}, isTty: false };
    const factory: RuntimeFactory = async (options, overrides) => {
      const runtime = await composeTaviRuntime(
        { ...options, logger: { level: "error", sink: () => {} } },
        {
          ...overrides,
          modelOverride: toolThenAnswer(),
        },
      );
      return runtime;
    };
    const code = await main(
      ["run", "please echo ping", "--connection", "fixture", "--model", "fixture-model", "--format", "json", "--data-dir", directory],
      { io, runtimeFactory: factory },
    );
    expect(code).toBe(EXIT.ok);
    const foreground = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as ClientEvent);

    // Attached: the same run admitted inside an owner, watched on its bus.
    const runtime = await composeTaviRuntime(
      { ...baseOptions(directories.create()), devFixtureTools: true },
      { modelOverride: toolThenAnswer() },
    );
    runtimes.push(runtime);
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "cli" };
    let attached: ClientEvent[] = [];
    await runtime.workflow?.admit({
      context,
      operationKey: "op-parity",
      kind: "start",
      origin: "cli",
      prompt: "please echo ping",
      onAdmitted: (admitted) => {
        attached = watch(runtime, admitted.taskId);
      },
    });

    expect(kinds(foreground)).toEqual(["run.started", "text.delta", "tool.started", "tool.completed", "text.delta", "task.completed"]);
    expect(normalized(foreground)).toEqual(normalized(attached));

    // Over IPC: the same run sent with `run`, received on the subscription its
    // response names — what `tavi run` under an owner will render.
    const ownerDirectory = directories.create();
    const owner = await serve(
      { ...baseOptions(ownerDirectory), devFixtureTools: true, scheduleSweepEnabled: false },
      { dataDirectory: ownerDirectory, drainDeadlineMs: 5_000 },
      { stdout: () => {}, stderr: () => {}, isTty: false },
      { modelOverride: toolThenAnswer() },
    );
    let client: Awaited<ReturnType<typeof createIpcClient>> | undefined;
    try {
      const discovered = await findLiveOwner(ownerDirectory);
      if (discovered === undefined) throw new Error("serve did not publish discovery");
      client = await createIpcClient(discovered);
      const { response, events: overIpc } = await requestWithSubscription(
        client,
        "run",
        { prompt: "please echo ping", workspaceId: "default", principal: "operator", operationKey: "op-parity", approval: "client" },
        "run-parity",
      );
      expect(response.ok, JSON.stringify(response.error)).toBe(true);
      await waitFor(() => overIpc.some((event) => event.kind === "task.completed"));
      expect(normalized(overIpc)).toEqual(normalized(foreground));
    } finally {
      client?.close();
      await owner.shutdown("parity test done");
    }
  });
});

describe("the owner session (the stream's epoch)", () => {
  it("is unique per runtime, not per pid, so a restart can never accept an old cursor", async () => {
    // A restarted daemon that reuses its pid — PID 1 in a container, every time —
    // got the same epoch, and a cursor from before the restart was answered
    // against the new numbering with no resync.
    const first = await composeTaviRuntime({ ...baseOptions(directories.create()), inMemory: true }, { requireModelTransport: false });
    runtimes.push(first);
    const second = await composeTaviRuntime({ ...baseOptions(directories.create()), inMemory: true }, { requireModelTransport: false });
    runtimes.push(second);
    expect(first.ownerSession).not.toBe(second.ownerSession);
  });
});
