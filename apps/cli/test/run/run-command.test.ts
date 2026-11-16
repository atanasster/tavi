import { fixturePromptPolicy } from "../support/prompt-policy.js";
import {
  EXECUTION_BUSY,
  HOME_CHAT_INDEX,
  IPC_EXECUTION_BUSY,
  TaviError,
  approvalRoundKey,
  approvalRowId,
  joinLabels,
  trustedLabel,
  untrustedLabel,
  type AdmissionOutcome,
  type AdmissionResult,
  type AdmitInput,
  type ClientEvent,
  type RunPayload,
  type WorkflowPort,
} from "@tavi/contracts";
import {
  createInMemoryApprovalRepository,
  createInMemoryCancellationRepository,
  createInMemoryExecutionRepository,
  createInMemoryTaskRepository,
} from "@tavi/test-support/fakes";
import { createRunEventBus } from "@tavi/runtime";
import { waitFor, delay } from "@tavi/test-support";
import { describe, expect, it } from "vitest";

import { createAnsweringRuns, isSecondHome, startRun, type RunDependencies } from "../../src/features/run/owner.js";

/**
 * `startRun`'s branches a live owner cannot easily reach: a retry
 * refused before its claim, a failure before `onAdmitted`, a full connection,
 * and the answering loop's bounds and stops — against an in-memory task store
 * and a workflow double that records each admission the way the adapter does.
 */

const now = () => "2026-01-01T00:00:00.000Z";
const request: RunPayload = { prompt: "go", workspaceId: "default", principal: "operator", operationKey: "op-1", approval: "approve" };

function waitingOn(steps: number): AdmissionOutcome {
  return {
    status: "waiting",
    finalText: "",
    interrupt: { requests: [{ callId: `call-${steps}`, toolName: "t", summary: "s", input: {}, effect: "external", steps }] },
  };
}

/**
 * A workflow over an in-memory task store: each admission is written and
 * committed as the adapter would, with the outcome `next` gives it — so the
 * answering loop reads each pending round from the store, as it does live.
 */
function harness(next: (input: AdmitInput, count: number) => AdmissionOutcome | Error) {
  const tasks = createInMemoryTaskRepository();
  const admitted: AdmitInput[] = [];
  const logged: { level: string; message: string }[] = [];
  let released = 0;
  const workflow: WorkflowPort = {
    admit: async (input): Promise<AdmissionResult> => {
      admitted.push(input);
      const written = tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: input.context.workspaceId,
        principalId: input.context.principalId,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        operationKey: input.operationKey,
        kind: input.kind,
        intent: input.resume === undefined ? { prompt: input.prompt } : { resume: input.resume },
        checkpointNamespace: "",
        newTaskId: (() => "task-1")(),
        newAdmissionId: (() => `adm-${admitted.length}`)(),
        newThreadId: (() => "thread-1")(),
        now: now(),
      });
      input.onAdmitted?.({
        taskId: (await written).task.taskId,
        threadId: "thread-1",
        admissionId: (await written).admission.admissionId,
        created: (await written).created,
      });
      const outcome = next(input, admitted.length);
      if (outcome instanceof Error) throw outcome;
      input.onClaimed?.({
        taskId: (await written).task.taskId,
        threadId: "thread-1",
        admissionId: (await written).admission.admissionId,
        created: (await written).created,
      });
      tasks.commitAdmission({
        admissionId: (await written).admission.admissionId,
        taskId: (await written).task.taskId,
        state: "committed",
        result: outcome,
      });
      return { taskId: (await written).task.taskId, threadId: "thread-1", created: (await written).created, replay: false, outcome };
    },
    checkpoints: {} as never,
  };
  let done = (): void => {};
  const settled = new Promise<void>((resolve) => (done = resolve));
  const deps: RunDependencies = {
    workflow,
    repositories: {
      tasks,
      approvals: createInMemoryApprovalRepository(),
      cancellations: createInMemoryCancellationRepository(),
      executions: createInMemoryExecutionRepository(),
    },
    access: { authorize: () => undefined },
    target: { source: "flags", connectionId: "c", model: "m", workspaceId: "default" },
    ownerSession: "session-live",
    reserveSubscription: () => ({
      subscriptionId: "sub-1",
      attach: () => ({ replayed: 0, resync: false, truncated: false }),
      release: () => {
        released += 1;
      },
    }),
    log: (level, message) => {
      logged.push({ level, message });
      if (message.includes("answering limit") || message.includes("another front end") || message.includes("stopped admitting")) done();
    },
  };
  return { deps, tasks, admitted, logged, settled, released: () => released };
}

/** A fake of the owner's local-connection conversations, recording what a run does with them. */
function conversations(options: { readonly local?: string; readonly holder?: string; readonly failOpen?: boolean } = {}) {
  const opened: unknown[] = [];
  let holds = 0;
  let released = 0;
  const fake = {
    connectionFor: () => options.local,
    holderOf: async () => options.holder,
    hold: () => {
      holds += 1;
      return () => {
        released += 1;
      };
    },
    open: async (input: unknown) => {
      if (options.failOpen === true) throw new TaviError("CONFLICT", "a conversation that will not record");
      opened.push(input);
    },
  };
  return { fake, opened, holds: () => holds, released: () => released };
}

describe("a run's conversation on the local connection", () => {
  const plain = { ...request, approval: "client" as const };

  it("opens the run's conversation before answering, and names it in the answer", async () => {
    const { deps, admitted } = harness(() => ({ status: "completed", finalText: "done" }));
    const local = conversations({ local: "local-default" });
    const answer = await startRun({ ...deps, conversations: local.fake }, plain);
    expect(answer).toMatchObject({ ok: true, result: { conversationId: plain.operationKey } });
    expect(admitted[0]?.context.messagingReplyTo).toEqual({
      connectionId: "local-default",
      externalConversationId: plain.operationKey,
      externalSenderId: plain.principal,
      // The person's own app conversation is one-to-one (`private-group-reply`).
      audience: "one-to-one",
    });
    expect(local.opened).toEqual([
      {
        connectionId: "local-default",
        conversationId: plain.operationKey,
        taskId: "task-1",
        principalId: plain.principal,
        workspaceId: plain.workspaceId,
      },
    ]);
    await delay(10);
    expect(local.released()).toBeGreaterThanOrEqual(local.holds());
  });

  it("opens none, and names none, where the workspace has no local connection", async () => {
    const { deps, admitted } = harness(() => ({ status: "completed", finalText: "done" }));
    const answer = await startRun({ ...deps, conversations: conversations().fake }, plain);
    expect(answer.ok && "conversationId" in answer.result).toBe(false);
    expect(admitted[0]?.context.messagingReplyTo).toBeUndefined();
  });

  it("runs on without a conversation when it cannot be recorded, and says so", async () => {
    const { deps, logged } = harness(() => ({ status: "completed", finalText: "done" }));
    const answer = await startRun({ ...deps, conversations: conversations({ local: "local-default", failOpen: true }).fake }, plain);
    expect(answer.ok).toBe(true);
    expect(answer.ok && "conversationId" in answer.result).toBe(false);
    expect(logged).toContainEqual({ level: "warn", message: "a run's conversation could not be opened" });
  });

  it("refuses a key whose conversation another principal's run holds, admitting nothing", async () => {
    const { deps, admitted } = harness(() => ({ status: "completed", finalText: "done" }));
    const local = conversations({ local: "local-default", holder: "someone-else" });
    const answer = await startRun({ ...deps, conversations: local.fake }, plain);
    expect(answer).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", message: expect.stringContaining("another principal's conversation") },
    });
    expect(admitted).toHaveLength(0);
    expect(local.holds()).toBe(0);
    // The same principal's retry under its own key is the same run's conversation.
    const own = conversations({ local: "local-default", holder: plain.principal });
    expect((await startRun({ ...deps, conversations: own.fake }, plain)).ok).toBe(true);
  });
});

describe("startRun", () => {
  it("answers at most its round limit, each round under its own key, then leaves the next for an operator", async () => {
    const { deps, admitted, logged, settled } = harness((_input, count) => waitingOn(count));
    const answer = await startRun({ ...deps, policyRounds: 3 }, request);
    expect(answer).toMatchObject({ ok: true, result: { taskId: "task-1", subscriptionId: "sub-1", created: true, replay: false } });
    await settled;
    expect(admitted.map((input) => input.kind)).toEqual(["start", "approval", "approval", "approval"]);
    expect(admitted.slice(1).map((input) => input.operationKey)).toEqual([1, 2, 3].map((steps) => approvalRoundKey("task-1", steps)));
    expect(admitted[1]?.resume).toMatchObject({
      expectedSteps: 1,
      decisions: [{ callId: "call-1", approved: true, decidedBy: "auto:operator" }],
    });
    expect(logged).toContainEqual({ level: "warn", message: expect.stringContaining("3-round answering limit") });
  });

  it("denies, under approve, a call a run nobody attends must not approve, with its reason, and approves the rest", async () => {
    const mixed = (steps: number): AdmissionOutcome => ({
      status: "waiting",
      finalText: "",
      interrupt: {
        requests: [
          {
            callId: `taint-${steps}`,
            toolName: "http.request",
            summary: "s",
            input: {},
            effect: "external",
            steps,
            tainted: true,
            gateReason: "tainted-payload",
            risk: { level: "high", reasons: [], tainted: true },
          },
          {
            callId: `critical-${steps}`,
            toolName: "sandbox.run",
            summary: "s",
            input: {},
            effect: "external",
            steps,
            tainted: false,
            risk: { level: "critical", reasons: [], tainted: false },
          },
          {
            callId: `clean-${steps}`,
            toolName: "t",
            summary: "s",
            input: {},
            effect: "external",
            steps,
            tainted: false,
            risk: { level: "medium", reasons: [], tainted: false },
          },
        ],
      },
    });
    const { deps, admitted, settled } = harness((_input, count) => mixed(count));
    await startRun({ ...deps, policyRounds: 1 }, request);
    await settled;
    expect(admitted[1]?.resume).toMatchObject({
      decisions: [
        {
          callId: "taint-1",
          approved: false,
          decidedBy: "auto:operator",
          note: expect.stringContaining("untrusted content (tainted-payload)"),
        },
        { callId: "critical-1", approved: false, note: expect.stringContaining("critical") },
        { callId: "clean-1", approved: true, decidedBy: "auto:operator" },
      ],
    });
    expect((admitted[1]?.resume as { decisions: object[] }).decisions[2]).not.toHaveProperty("note");
  });

  it("stops without an error when another front end decided the round, or the owner stopped admitting", async () => {
    for (const [failure, level, text] of [
      [new TaviError("CONFLICT", "the round moved on"), "info", "another front end"],
      [new TaviError("UNAVAILABLE", "admission is closed"), "warn", "same operationKey"],
    ] as const) {
      const { deps, logged, settled } = harness((_input, count) => (count === 1 ? waitingOn(1) : failure));
      await startRun(deps, request);
      await settled;
      expect(logged).toContainEqual({ level, message: expect.stringContaining(text) });
      expect(logged.map((entry) => entry.message)).not.toContain("an IPC run ended in an error after it was admitted");
    }
  });

  it("publishes the round it leaves again, tagged with why: its round limit, and a stop of admitting", async () => {
    for (const [policyRounds, next, reason] of [
      [1, (_input: AdmitInput, count: number) => waitingOn(count), "round-limit"],
      [
        undefined,
        (_input: AdmitInput, count: number) => (count === 1 ? waitingOn(1) : new TaviError("UNAVAILABLE", "closed")),
        "unavailable",
      ],
    ] as const) {
      const { deps, settled } = harness(next);
      const stream = createRunEventBus({ epoch: "epoch-1" });
      const seen: ClientEvent[] = [];
      stream.subscribe({ taskId: "task-1", deliver: (event) => seen.push(event) });
      await startRun({ ...deps, stream, ...(policyRounds === undefined ? {} : { policyRounds }) }, request);
      await settled;
      await waitFor(() => seen.length > 0);
      // The round still pending: the limit's next one, or the one admitting refused.
      const steps = reason === "round-limit" ? 2 : 1;
      expect(seen).toMatchObject([{ kind: "approval.required", callId: `call-${steps}`, steps, policyStopped: { reason } }]);
    }
  });

  it("after another front end decided its round, leaves the round that resume suspends on for a person", async () => {
    const { deps, settled } = harness((_input, count) =>
      count === 1 ? waitingOn(1) : count === 2 ? new TaviError("CONFLICT", "the round moved on") : waitingOn(3),
    );
    const stream = createRunEventBus({ epoch: "epoch-1" });
    const seen: ClientEvent[] = [];
    stream.subscribe({ taskId: "task-1", deliver: (event) => seen.push(event) });
    await startRun({ ...deps, stream }, request);
    await settled;
    await delay(10);
    expect(seen).toEqual([]);
    // The other front end's resume suspends on the next round, published as the decorator publishes it.
    await deps.workflow?.admit({
      context: { workspaceId: "default", principalId: "operator", caller: "ipc", runId: "task-1" },
      taskId: "task-1",
      operationKey: "other-front-end",
      kind: "approval",
      resume: { decisions: [{ callId: "call-1", approved: false }], expectedSteps: 1 },
    });
    stream.publish("task-1", {
      kind: "approval.required",
      runId: "task-1",
      attemptId: "attempt-other",
      callId: "call-3",
      toolName: "t",
      summary: "s",
      input: {},
      steps: 3,
      approvalId: approvalRowId("task-1", "call-3", 3),
    });
    await waitFor(() => seen.length > 1);
    expect(seen[1]).toMatchObject({ kind: "approval.required", callId: "call-3", policyStopped: { reason: "decided-elsewhere" } });
    // The watch let go of the stream: only this test's own subscription is left.
    expect(stream.stats().subscriptions).toBe(1);
  });

  it("drops the watch for a round decided elsewhere once a `run` sent again answers the task's rounds", async () => {
    const { deps, settled } = harness((_input, count) =>
      count === 1 ? waitingOn(1) : count === 2 ? new TaviError("CONFLICT", "the round moved on") : waitingOn(count),
    );
    const stream = createRunEventBus({ epoch: "epoch-1" });
    const seen: ClientEvent[] = [];
    stream.subscribe({ taskId: "task-1", deliver: (event) => seen.push(event) });
    await startRun({ ...deps, stream }, request);
    await settled;
    expect(stream.stats().subscriptions).toBe(2);
    // The retry's loop starts answering: the earlier loop's watch ends, announcing nothing.
    const answering = createAnsweringRuns();
    const leave = answering.enter("task-1");
    await startRun({ ...deps, stream, answering, policyRounds: 1 }, request);
    await waitFor(() => stream.stats().subscriptions === 1);
    leave();
    await delay(10);
    expect(seen.filter((event) => event.kind === "approval.required" && event.policyStopped?.reason === "decided-elsewhere")).toEqual([]);
  });

  it("answers a retry refused before its claim with EXECUTION_BUSY and the recover command, releasing its subscription", async () => {
    // The owner died mid-run holding the lease; the retry is admitted under the
    // same key and refused by `acquire` — the decorator publishes nothing for it.
    const { deps, tasks, released } = harness(() => waitingOn(1));
    tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-1",
      kind: "start",
      intent: { prompt: "go" },
      checkpointNamespace: "",
      newTaskId: (() => "task-1")(),
      newAdmissionId: (() => "adm-crashed")(),
      newThreadId: (() => "thread-1")(),
      now: now(),
    });
    const busy = new TaviError("CONFLICT", "Task task-1 is already executing under session-dead", {
      details: { reason: EXECUTION_BUSY, generation: 3 },
    });
    const retried = await startRun(
      {
        ...deps,
        workflow: {
          ...deps.workflow!,
          admit: async (input) => {
            input.onAdmitted?.({ taskId: "task-1", threadId: "thread-1", admissionId: "adm-crashed", created: false });
            throw busy;
          },
        },
      },
      request,
    );
    expect(retried).toMatchObject({
      ok: false,
      error: { code: IPC_EXECUTION_BUSY, message: expect.stringContaining("tavi recover task-1 --generation 3") },
    });
    expect(released()).toBe(1);
  });

  it("hands a new chat's drafted instructions to its admission, attributed to the front end that sent them", async () => {
    for (const [origin, author] of [
      [undefined, "operator:cli"],
      ["web", "operator:ui"],
    ] as const) {
      const { deps, admitted } = harness(() => ({ status: "completed", finalText: "ok" }));
      await startRun({ ...deps, ...(origin === undefined ? {} : { origin }) }, { ...request, chatInstructions: "Answer in French." });
      expect(admitted[0]?.chatInstructions).toEqual({ text: "Answer in French.", author });
    }
    const { deps, admitted } = harness(() => ({ status: "completed", finalText: "ok" }));
    await startRun(deps, request);
    expect(admitted[0]?.chatInstructions).toBeUndefined();
  });

  it("answers a failure before onAdmitted as the error, releasing its subscription", async () => {
    const { deps, released } = harness(() => waitingOn(1));
    const answer = await startRun(
      {
        ...deps,
        workflow: {
          ...deps.workflow!,
          admit: async () => {
            throw new TaviError("CONFLICT", "operation key op-1 was already admitted with different content");
          },
        },
      },
      request,
    );
    expect(answer).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(released()).toBe(1);
  });

  it("refuses a connection that can hold no more subscriptions before admitting anything", async () => {
    const { deps, admitted } = harness(() => waitingOn(1));
    const answer = await startRun(
      {
        ...deps,
        reserveSubscription: () => {
          throw new TaviError("BUDGET_EXCEEDED", "this connection already holds 64 subscriptions");
        },
      },
      request,
    );
    expect(answer).toMatchObject({ ok: false, error: { code: "BUDGET_EXCEEDED" } });
    expect(admitted).toEqual([]);
  });
});

describe("a side chat", () => {
  const plain = { ...request, approval: "client" as const };
  /** A chat recorded before the run, as `principalId` in `workspaceId`. */
  const recorded = async (
    tasks: ReturnType<typeof harness>["tasks"],
    taskId: string,
    extra: {
      readonly principalId?: string;
      readonly workspaceId?: string;
      readonly chatKind?: "worker" | "home";
      readonly origin?: "messaging";
    } = {},
  ) =>
    await tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: extra.workspaceId ?? "default",
      principalId: extra.principalId ?? "operator",
      operationKey: `op-${taskId}`,
      kind: "start",
      intent: { prompt: "earlier" },
      checkpointNamespace: "",
      ...(extra.chatKind === undefined ? {} : { chatKind: extra.chatKind }),
      ...(extra.origin === undefined ? {} : { origin: extra.origin }),
      newTaskId: taskId,
      newAdmissionId: `adm-${taskId}`,
      newThreadId: `thread-${taskId}`,
      now: now(),
    });

  it("is admitted as a side chat of its parent, with the parent's seed ahead of its prompt", async () => {
    const { deps, tasks, admitted } = harness(() => ({ status: "completed", finalText: "ok" }));
    await recorded(tasks, "home-1", { chatKind: "home" });
    const seeded: string[] = [];
    const answer = await startRun(
      {
        ...deps,
        sideChatSeed: async (parent) => {
          seeded.push(parent.taskId);
          return { system: "[side-chat:seed] preamble", background: "[side-chat:background] quoted" };
        },
      },
      { ...plain, parentChatId: "home-1" },
    );
    expect(answer.ok).toBe(true);
    expect(seeded).toEqual(["home-1"]);
    expect(admitted[0]).toMatchObject({
      kind: "start",
      chatKind: "side",
      parentChatId: "home-1",
      seed: { system: "[side-chat:seed] preamble", background: "[side-chat:background] quoted" },
      prompt: "go",
    });
  });

  it("hands its admission the parent's label with the seed, as it is", async () => {
    const { deps, tasks, admitted } = harness(() => ({ status: "completed", finalText: "ok" }));
    await recorded(tasks, "home-1", { chatKind: "home" });
    const parentLabel = joinLabels(untrustedLabel("web"), trustedLabel("personal"));
    const answer = await startRun(
      {
        ...deps,
        sideChatSeed: async () => ({
          system: "[side-chat:seed] preamble",
          background: "[side-chat:background] quoted",
          label: parentLabel,
        }),
      },
      { ...plain, parentChatId: "home-1" },
    );
    expect(answer.ok).toBe(true);
    expect(admitted[0]?.context.inheritedLabel).toEqual(parentLabel);
    expect(admitted[0]?.seed?.label).toEqual(parentLabel);
  });

  it("keeps a side chat of a local chat on a local model: the parent's, and refuses a remote one chosen for it", async () => {
    const { deps, tasks, admitted } = harness(() => ({ status: "completed", finalText: "ok" }));
    await recorded(tasks, "home-1", { chatKind: "home" });
    const chosen: { taskId: string; connectionId: string }[] = [];
    const local = { connectionId: "ollama", model: "llama" };
    const localChats = {
      isLocal: async (_workspaceId: string, taskId: string) => taskId === "home-1",
      locality: async (connectionId: string) => (connectionId === "ollama" ? ("local" as const) : ("remote" as const)),
      localTargetOf: async () => local,
      ideaModel: async () => undefined,
    };
    const taskRouting = {
      accepts: async () => true,
      choose: async (_scope: unknown, taskId: string, target: { connectionId: string }) => {
        chosen.push({ taskId, connectionId: target.connectionId });
        return undefined as never;
      },
    };
    const answer = await startRun({ ...deps, localChats, taskRouting }, { ...plain, parentChatId: "home-1" });
    expect(answer.ok).toBe(true);
    expect(chosen).toEqual([{ taskId: expect.any(String), connectionId: "ollama" }]);
    const refused = await startRun(
      { ...deps, localChats, taskRouting },
      { ...plain, operationKey: "side-remote", parentChatId: "home-1", model: { connectionId: "cloud", model: "big" } },
    );
    expect(refused.ok).toBe(false);
    expect(refused.ok ? undefined : refused.error.code).toBe("NOT_CONFIGURED");
    expect(admitted).toHaveLength(1);
  });

  it("starts an idea's chat on a local model when the idea was written from local data, and refuses a remote one", async () => {
    const { deps } = harness(() => ({ status: "completed", finalText: "ok" }));
    const chosen: string[] = [];
    const local = { connectionId: "ollama", model: "llama" };
    const localChats = {
      isLocal: async () => false,
      locality: async (connectionId: string) => (connectionId === "ollama" ? ("local" as const) : ("remote" as const)),
      localTargetOf: async () => undefined,
      ideaModel: async () => local,
    };
    const taskRouting = {
      accepts: async () => true,
      choose: async (_scope: unknown, _taskId: string, target: { connectionId: string }) => {
        chosen.push(target.connectionId);
        return undefined as never;
      },
    };
    expect((await startRun({ ...deps, localChats, taskRouting }, { ...plain, fromIdeaId: "idea-1" })).ok).toBe(true);
    expect(chosen).toEqual(["ollama"]);
    const refused = await startRun(
      { ...deps, localChats, taskRouting },
      { ...plain, operationKey: "idea-remote", fromIdeaId: "idea-1", model: { connectionId: "cloud", model: "big" } },
    );
    expect(refused.ok ? undefined : refused.error.code).toBe("NOT_CONFIGURED");
  });

  it("begins without a seed when none can be built, saying so", async () => {
    const { deps, tasks, admitted, logged } = harness(() => ({ status: "completed", finalText: "ok" }));
    await recorded(tasks, "chat-1");
    const answer = await startRun(
      { ...deps, sideChatSeed: () => Promise.reject(new Error("no transcript")) },
      { ...plain, parentChatId: "chat-1" },
    );
    expect(answer.ok).toBe(true);
    expect(admitted[0]).toMatchObject({ chatKind: "side", parentChatId: "chat-1" });
    expect(admitted[0]?.seed).toBeUndefined();
    expect(logged).toContainEqual({ level: "warn", message: expect.stringContaining("seed could not be built") });
  });

  it("refuses an unknown parent, another person's or another workspace's as not found, and a worker, admitting nothing", async () => {
    const { deps, tasks, admitted } = harness(() => ({ status: "completed", finalText: "ok" }));
    await recorded(tasks, "theirs", { principalId: "mallory" });
    await recorded(tasks, "elsewhere", { workspaceId: "other" });
    await recorded(tasks, "worker-1", { chatKind: "worker" });
    for (const parentChatId of ["missing", "theirs", "elsewhere"]) {
      const answer = await startRun(deps, { ...plain, parentChatId });
      expect(answer).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }
    expect(await startRun(deps, { ...plain, parentChatId: "worker-1" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("worker") },
    });
    expect(await startRun(deps, { ...plain, parentChatId: "theirs", target: "run" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(admitted).toEqual([]);
  });

  it("refuses a side chat of a messaging chat: its settle would carry the canvas's words into the group", async () => {
    const { deps, tasks, admitted } = harness(() => ({ status: "completed", finalText: "ok" }));
    await recorded(tasks, "group-1", { origin: "messaging" });
    expect(await startRun(deps, { ...plain, parentChatId: "group-1" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("messaging conversation") },
    });
    expect(admitted).toEqual([]);
  });

  it("replies to a notice with a side chat of its chat, seeded with the run's output, and refuses another chat's notice", async () => {
    const { deps, tasks, admitted } = harness(() => ({ status: "completed", finalText: "ok" }));
    await recorded(tasks, "home-1", { chatKind: "home" });
    const seeded: unknown[] = [];
    const withNotices: RunDependencies = {
      ...deps,
      noticeSource: async (noticeId, parent) =>
        noticeId === "notice-1" && parent.taskId === "home-1"
          ? { title: "Scheduled run “brief”", sourceTaskId: "run-1", output: "Three headlines" }
          : undefined,
      sideChatSeed: async (_parent, notice) => {
        seeded.push(notice);
        return { system: "[side-chat:seed] preamble", background: "[side-chat:background] quoted" };
      },
    };
    expect(await startRun(withNotices, { ...plain, parentChatId: "home-1", fromNoticeId: "notice-2" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(admitted).toEqual([]);
    const answer = await startRun(withNotices, { ...plain, parentChatId: "home-1", fromNoticeId: "notice-1" });
    expect(answer.ok).toBe(true);
    expect(seeded).toEqual([{ title: "Scheduled run “brief”", sourceTaskId: "run-1", output: "Three headlines" }]);
    expect(admitted[0]).toMatchObject({ chatKind: "side", parentChatId: "home-1" });
  });
});

describe("a new Home", () => {
  it("posts its earlier-chats notice once the message that makes it is admitted, and not for a message to an existing Home", async () => {
    const { deps } = harness(() => ({ status: "completed", finalText: "ok" }));
    const created: string[] = [];
    let home: string | undefined;
    const homeDeps: RunDependencies = {
      ...deps,
      homeOf: async () => home,
      onHomeCreated: async (made) => {
        created.push(made.taskId);
      },
    };
    expect(await startRun(homeDeps, { ...request, approval: "client", target: "home" })).toMatchObject({ ok: true });
    expect(created).toEqual(["task-1"]);
    home = "task-1";
    expect(await startRun(homeDeps, { ...request, approval: "client", operationKey: "op-2", target: "home" })).toMatchObject({ ok: true });
    expect(created).toEqual(["task-1"]);
  });

  it("tells the owner which idea a new chat came from, with what was sent, and only when the chat is new", async () => {
    const { deps, admitted } = harness(() => ({ status: "completed", finalText: "ok" }));
    const seeded: unknown[] = [];
    const ideaDeps: RunDependencies = {
      ...deps,
      ideaSeeded: async (seed) => {
        seeded.push(seed);
      },
      ideaPrepared: async () => ({ title: "Watch fares", text: "Cheapest: €120." }),
    };
    expect(await startRun(ideaDeps, { ...request, approval: "client", fromIdeaId: "idea-1" })).toMatchObject({ ok: true });
    // What its prepared step found goes with the first turn, as an untrusted block.
    expect(JSON.stringify(admitted.at(-1))).toContain("Cheapest: €120.");
    expect(seeded).toEqual([
      { workspaceId: request.workspaceId, principalId: request.principal, ideaId: "idea-1", taskId: "task-1", sent: request.prompt },
    ]);
    // A link that fails leaves the run going.
    expect(
      await startRun(
        {
          ...deps,
          ideaSeeded: async () => {
            throw new Error("gone");
          },
        },
        { ...request, approval: "client", operationKey: "op-9", fromIdeaId: "idea-1" },
      ),
    ).toMatchObject({ ok: true });
  });

  it("refuses a message to Home while chat.home is off, admitting nothing", async () => {
    const { deps, admitted } = harness(() => ({ status: "completed", finalText: "ok" }));
    const created: string[] = [];
    const off: RunDependencies = {
      ...deps,
      homeOf: async () => undefined,
      homeOn: async () => false,
      onHomeCreated: async (made) => {
        created.push(made.taskId);
      },
    };
    expect(await startRun(off, { ...request, approval: "client", target: "home" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: "Home is off: `tavi config set chat.home on`" },
    });
    expect(admitted).toEqual([]);
    expect(created).toEqual([]);
    expect(await startRun({ ...off, homeOn: async () => true }, { ...request, approval: "client", target: "home" })).toMatchObject({
      ok: true,
    });
  });
});

describe("a second Home at the same moment", () => {
  it("is recognised by the store's typed conflict, never by SQLite's message", () => {
    expect(
      isSecondHome(new TaviError("CONFLICT", "This person already has a Home in this workspace", { details: { index: HOME_CHAT_INDEX } })),
    ).toBe(true);
    expect(isSecondHome(new Error("UNIQUE constraint failed: tavi_tasks.workspace_id, tavi_tasks.principal_id"))).toBe(false);
    expect(isSecondHome(new TaviError("CONFLICT", "tavi_tasks_home_idx"))).toBe(false);
    expect(isSecondHome(new TaviError("INVALID_INPUT", "x", { details: { index: HOME_CHAT_INDEX } }))).toBe(false);
  });
});
