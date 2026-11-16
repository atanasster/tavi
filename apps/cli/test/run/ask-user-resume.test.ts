import type { InboundEvent, InvocationContext, OutboundMessage } from "@tavi/contracts";
import { temporaryDirectories, delay } from "@tavi/test-support";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * A chat reply resumes a task that is waiting.
 *
 * The defect this pins: every inbound message admitted a fresh `kind: "reply"`
 * turn with no `resume`, so a task suspended on a wait never received the
 * answer — the suspended graph stayed suspended while the person's reply was
 * handled as an unrelated new turn. An orchestrator interviewing the operator
 * could therefore never finish.
 */

const directories = temporaryDirectories({ prefix: "tavi-ask-user-" });

afterEach(() => directories.cleanup());

/** The text of an outbound message, narrowed past the text/file part union. */
function textOf(message: OutboundMessage | undefined): string {
  const part = message?.parts[0];
  return part !== undefined && part.kind !== "file" ? part.content : "";
}

function inboundEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    connectionId: "telegram-main",
    providerEventId: `evt-${Math.random().toString(36).slice(2)}`,
    kind: "message",
    externalSenderId: "operator-chat",
    externalConversationId: "chat-1",
    externalMessageId: "msg-100",
    occurredAt: "2026-04-05T07:00:00.000Z",
    receivedAt: "2026-04-05T07:00:00.000Z",
    content: "the answer",
    ...overrides,
  };
}

async function harness(
  directory: string,
  turns: readonly ScriptedTurn[],
): Promise<{ readonly runtime: TaviRuntime; readonly model: ReturnType<typeof createFixtureModel> }> {
  const model = createFixtureModel({ turns });
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), { modelOverride: model });
  return { runtime, model };
}

/** Drive one inbound channel message through the real ingestion path. */
async function deliver(runtime: TaviRuntime, event: InboundEvent): Promise<void> {
  await runtime.messaging.ingest(event);
  // `ingest` admits asynchronously through the composition's own callback.
  await delay(30);
}

describe("a chat message answers the question a task is waiting on", () => {
  it("settles the wait with the operator's words and resumes the graph, instead of starting a fresh turn", async () => {
    const directory = directories.create();
    const { runtime } = await harness(directory, [{ text: "first" }, { text: "after the answer" }]);
    try {
      // An operator identity binding is what lets an inbound sender resolve to a
      // principal; without one the message is recorded but never admitted.
      await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "telegram-main",
        externalSenderId: "operator-chat",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "test",
        createdAt: "2026-04-05T00:00:00.000Z",
      });

      // A task exists on this conversation and is suspended on a wait — the
      // shape `agents.wait`, `agents.request` and a future `ask_user` all leave.
      const context: InvocationContext = {
        workspaceId: "default",
        principalId: "operator",
        runId: "pending-admission",
        caller: "cli",
      };
      const admitted = await runtime.workflow?.admit({ context, operationKey: "op-waiting", kind: "start", prompt: "ask the operator" });
      expect(admitted?.taskId).toBeDefined();
      const taskId = admitted?.taskId ?? "";
      await runtime.store.asPort().repositories.messagingConversations.record({
        connectionId: "telegram-main",
        externalConversationId: "chat-1",
        taskId,
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      // A durable wait the human's reply is expected to answer.
      await runtime.store.asPort().repositories.agentWaits.prepare({ waitId: "wait-1", taskId, deadlineAt: "2026-04-06T00:00:00.000Z" });
      await runtime.store.asPort().repositories.agentWaits.activate("wait-1");

      await deliver(runtime, inboundEvent({ content: "acme, globex" }));

      // The wait is settled with the human's own words, not an agent envelope.
      const settled = await runtime.store.asPort().repositories.agentWaits.get("wait-1");
      expect(settled?.state).toBe("settled");
      expect(settled?.settledOutcome).toMatchObject({ kind: "answered", replyText: "acme, globex", externalMessageId: "msg-100" });

      // The distinguishing evidence is the *resume*: a fresh read of the
      // transcript would not separate "the graph resumed" from "a new reply turn
      // ran", so this asserts the admission kind the resume path uses. A
      // `kind: "deadline"` admission on this task is the graph being advanced
      // with the wait's outcome as its resume value — the exact thing the
      // defect prevented.
      const admissions = await runtime.store.asPort().repositories.tasks.listAdmissions(taskId);
      expect(admissions.map((admission) => admission.kind)).toContain("deadline");
      // (`model.calls` is deliberately not asserted here: how the resumed graph
      // renders the answer into its next prompt is the workflow's business, and
      // pinning it would couple this test to that shape rather than to the resume's.)
    } finally {
      await runtime.close();
    }
  });

  it("never settles a wait that is expecting a peer agent or a worker", async () => {
    const directory = directories.create();
    const { runtime } = await harness(directory, [{ text: "first" }]);
    try {
      await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "telegram-main",
        externalSenderId: "operator-chat",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "test",
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      const admitted = await runtime.workflow?.admit({
        context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "cli" },
        operationKey: "op-peer-wait",
        kind: "start",
        prompt: "wait for a peer",
      });
      const taskId = admitted?.taskId ?? "";
      await runtime.store.asPort().repositories.messagingConversations.record({
        connectionId: "telegram-main",
        externalConversationId: "chat-1",
        taskId,
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      // A wait explicitly expecting a *peer agent's* correlated reply. (One
      // active wait per task is a database guarantee — migration `0016` — so a
      // worker-shaped wait gets its own task rather than sharing this one.)
      await runtime.store.asPort().repositories.agentWaits.prepare({
        waitId: "wait-peer",
        taskId,
        correlationId: "req-1",
        deadlineAt: "2026-04-06T00:00:00.000Z",
      });
      await runtime.store.asPort().repositories.agentWaits.activate("wait-peer");

      await deliver(runtime, inboundEvent({ content: "have you finished yet?" }));

      // An operator's chit-chat must not be handed to the model as the peer's
      // answer or the worker's result — the real reply or completion is still
      // coming, and consuming the wait with the wrong outcome loses it.
      expect((await runtime.store.asPort().repositories.agentWaits.get("wait-peer"))?.state).toBe("active");
    } finally {
      await runtime.close();
    }
  });

  it("clamps an over-long answer instead of storing a row no read can parse", async () => {
    const directory = directories.create();
    const { runtime } = await harness(directory, [{ text: "first" }]);
    try {
      await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "telegram-main",
        externalSenderId: "operator-chat",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "test",
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      const admitted = await runtime.workflow?.admit({
        context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "cli" },
        operationKey: "op-long",
        kind: "start",
        prompt: "ask",
      });
      const taskId = admitted?.taskId ?? "";
      await runtime.store.asPort().repositories.messagingConversations.record({
        connectionId: "telegram-main",
        externalConversationId: "chat-1",
        taskId,
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      await runtime.store.asPort().repositories.agentWaits.prepare({ waitId: "wait-long", taskId, deadlineAt: "2026-04-06T00:00:00.000Z" });
      await runtime.store.asPort().repositories.agentWaits.activate("wait-long");

      // Mailgun bodies are unbounded, and the read schema bounds this field —
      // so an unclamped write poisons the row permanently (reproduced in
      // review: the resumed graph saw TOOL_FAILED "does not match the current
      // schema" instead of the answer).
      await deliver(runtime, inboundEvent({ content: "x".repeat(40_000) }));

      const settled = await runtime.store.asPort().repositories.agentWaits.get("wait-long");
      expect(settled?.state).toBe("settled");
      // Within the bound the read schema enforces, not merely "has a marker":
      // the first version appended the marker *after* slicing to the cap, so it
      // stayed over the bound and poisoned the row anyway.
      expect(settled?.settledOutcome?.replyText?.length).toBeLessThanOrEqual(32_000);
      expect(settled?.settledOutcome?.replyText).toContain("[answer truncated");
    } finally {
      await runtime.close();
    }
  });

  it("does not settle on whitespace-only text, which Mailgun sends for an absent body", async () => {
    const directory = directories.create();
    const { runtime } = await harness(directory, [{ text: "first" }]);
    try {
      await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "telegram-main",
        externalSenderId: "operator-chat",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "test",
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      const admitted = await runtime.workflow?.admit({
        context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "cli" },
        operationKey: "op-blank",
        kind: "start",
        prompt: "ask",
      });
      const taskId = admitted?.taskId ?? "";
      await runtime.store.asPort().repositories.messagingConversations.record({
        connectionId: "telegram-main",
        externalConversationId: "chat-1",
        taskId,
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      await runtime.store
        .asPort()
        .repositories.agentWaits.prepare({ waitId: "wait-blank", taskId, deadlineAt: "2026-04-06T00:00:00.000Z" });
      await runtime.store.asPort().repositories.agentWaits.activate("wait-blank");

      await deliver(runtime, inboundEvent({ content: "   " }));

      expect((await runtime.store.asPort().repositories.agentWaits.get("wait-blank"))?.state).toBe("active");
    } finally {
      await runtime.close();
    }
  });

  it("starts an ordinary reply turn when the task is not waiting on anything", async () => {
    const directory = directories.create();
    const { runtime } = await harness(directory, [{ text: "first" }]);
    try {
      await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "telegram-main",
        externalSenderId: "operator-chat",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "test",
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      const admitted = await runtime.workflow?.admit({
        context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "cli" },
        operationKey: "op-idle",
        kind: "start",
        prompt: "hello",
      });
      await runtime.store.asPort().repositories.messagingConversations.record({
        connectionId: "telegram-main",
        externalConversationId: "chat-1",
        taskId: admitted?.taskId ?? "",
        createdAt: "2026-04-05T00:00:00.000Z",
      });

      await deliver(runtime, inboundEvent({ content: "just chatting" }));

      // Nothing was waiting, so no wait was invented and no answer was settled.
      const waits = await runtime.store.asPort().repositories.agentWaits.listActivePastDeadline("2030-01-01T00:00:00.000Z");
      expect(waits).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it("does not settle a wait for a message with no text", async () => {
    const directory = directories.create();
    const { runtime } = await harness(directory, [{ text: "first" }]);
    try {
      await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "telegram-main",
        externalSenderId: "operator-chat",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "test",
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      const admitted = await runtime.workflow?.admit({
        context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "cli" },
        operationKey: "op-empty",
        kind: "start",
        prompt: "hello",
      });
      const taskId = admitted?.taskId ?? "";
      await runtime.store.asPort().repositories.messagingConversations.record({
        connectionId: "telegram-main",
        externalConversationId: "chat-1",
        taskId,
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      await runtime.store.asPort().repositories.agentWaits.prepare({ waitId: "wait-2", taskId, deadlineAt: "2026-04-06T00:00:00.000Z" });
      await runtime.store.asPort().repositories.agentWaits.activate("wait-2");

      // An attachment-only message carries nothing to answer with; settling the
      // wait with empty text would tell the model the operator said nothing.
      const { content: _omitted, ...withoutContent } = inboundEvent();
      await deliver(runtime, withoutContent);

      const settled = await runtime.store.asPort().repositories.agentWaits.get("wait-2");
      expect(settled?.state).toBe("active");
    } finally {
      await runtime.close();
    }
  });
});

/**
 * The full loop: the orchestrator asks, the person answers in chat, the task
 * continues with the answer.
 *
 * This is the test that would have caught the whole feature being absent: it
 * drives a real model turn that calls `operator.ask_user`, checks the question
 * actually leaves through the messaging connector, and then answers it as the
 * operator would.
 */
describe("operator.ask_user", () => {
  /** Compose a runtime whose inbound channel is the fixture connector. */
  async function channelHarness(
    directory: string,
    turns: readonly ScriptedTurn[],
  ): Promise<{
    readonly runtime: TaviRuntime;
    readonly model: ReturnType<typeof createFixtureModel>;
    /** What the connector was actually asked to deliver — the question, as the operator would see it. */
    readonly sent: () => readonly OutboundMessage[];
  }> {
    const model = createFixtureModel({ turns });
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directory, {
        approvalRequiredFor: [],
        // The operator's own chat, allowlisted — `operator.ask_user` will not
        // address a conversation the operator did not authorize.
        messagingAllowedDestinations: ["chat-1"],
      }),
      { modelOverride: model },
    );
    let instance: FixtureMessagingConnectorInstance | undefined;
    runtime.messaging.registerConnector(
      createFixtureMessagingConnectorDefinition({
        onInstanceCreated: (created) => {
          instance = created;
        },
      }),
    );
    await runtime.messaging.openConnection({
      connection: {
        connectionId: "telegram-main",
        providerId: "fixture",
        accountIdentity: "op-bot",
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    const messages = (): readonly OutboundMessage[] => instance?.sent ?? [];
    return { runtime, model, sent: messages };
  }

  it("sends the question, suspends the task, and continues from the operator's answer", async () => {
    const directory = directories.create();
    // Turn 1 asks the operator; turn 2 is the resumed turn, whose transcript
    // must contain the answer.
    const { runtime, model, sent } = await channelHarness(directory, [
      {
        toolCall: {
          id: "call-1",
          name: "operator.ask_user",
          input: { question: "Which projects should I track?", connectionId: "telegram-main", chatId: "chat-1" },
        },
      },
      { text: "noted" },
    ]);
    try {
      await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "telegram-main",
        externalSenderId: "operator-chat",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "test",
        createdAt: "2026-04-05T00:00:00.000Z",
      });

      await runtime.messaging.ingest(inboundEvent({ content: "track these projects please" }));
      await delay(50);

      // The question reached the operator's chat, verbatim.
      expect(sent()).toHaveLength(1);
      // With when it stops waiting.
      expect(textOf(sent()[0])).toMatch(/^Which projects should I track\?\n⌛ Answer by (\w{3} \d{1,2} \w{3}, )?\d\d:\d\d UTC$/);

      // The task is suspended on a wait a human can answer — the bare-deadline
      // shape, with no correlation id and no worker to wait for.
      const taskId = (await runtime.store.asPort().repositories.messagingConversations.get("telegram-main", "chat-1"))?.taskId ?? "";
      expect(taskId).not.toBe("");
      const active = await runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId);
      expect(active).toBeDefined();
      expect(active?.correlationId).toBeUndefined();
      expect(active?.waitingOnWorkerTaskId).toBeUndefined();

      // The operator answers in the same conversation.
      await runtime.messaging.ingest(inboundEvent({ content: "ai-crucible and elections-bg", externalMessageId: "msg-200" }));
      await delay(50);

      const settled = await runtime.store.asPort().repositories.agentWaits.get(active?.waitId ?? "");
      expect(settled?.state).toBe("settled");
      expect(settled?.settledOutcome).toMatchObject({ kind: "answered", replyText: "ai-crucible and elections-bg" });
      // And the task advanced rather than starting over.
      expect((await runtime.store.asPort().repositories.tasks.listAdmissions(taskId)).map((admission) => admission.kind)).toContain(
        "deadline",
      );
      expect(model.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.close();
    }
  });

  it("does not ask twice when the resumed turn re-enters the node", async () => {
    const directory = directories.create();
    const { runtime, sent } = await channelHarness(directory, [
      {
        toolCall: {
          id: "call-1",
          name: "operator.ask_user",
          input: { question: "Which projects?", connectionId: "telegram-main", chatId: "chat-1" },
        },
      },
      { text: "noted" },
    ]);
    try {
      await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "telegram-main",
        externalSenderId: "operator-chat",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "test",
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      await runtime.messaging.ingest(inboundEvent({ content: "start" }));
      await delay(50);
      const taskId = (await runtime.store.asPort().repositories.messagingConversations.get("telegram-main", "chat-1"))?.taskId ?? "";
      const waitId = (await runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId))?.waitId ?? "";

      await runtime.messaging.ingest(inboundEvent({ content: "the answer" }));
      await delay(50);

      // A resume re-enters the node's branch. The wait's own durable row is what
      // records that the question was already delivered, so the operator is not
      // asked the same thing again.
      expect(sent()).toHaveLength(1);
      expect(waitId).not.toBe("");
    } finally {
      await runtime.close();
    }
  });

  it("fails visibly instead of suspending when no messaging channel is configured", async () => {
    const directory = directories.create();
    // No connector registered and no connection opened: the question could never
    // reach a person, so parking the task until its deadline would be a silent
    // loss dressed as patience.
    const model = createFixtureModel({
      turns: [{ toolCall: { id: "call-1", name: "operator.ask_user", input: { question: "Which projects?" } } }, { text: "recovered" }],
    });
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), { modelOverride: model });
    try {
      await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "telegram-main",
        externalSenderId: "operator-chat",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "test",
        createdAt: "2026-04-05T00:00:00.000Z",
      });
      await runtime.messaging.ingest(inboundEvent({ content: "start" }));
      await delay(50);

      const taskId = (await runtime.store.asPort().repositories.messagingConversations.get("telegram-main", "chat-1"))?.taskId ?? "";
      // Nothing suspended: the turn failed the tool call and the model recovered.
      expect(taskId === "" ? undefined : await runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId)).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});

describe("operator.ask_user refuses what it cannot deliver", () => {
  it("fails the tool call when the provider rejects the question, instead of suspending 24h", async () => {
    const directory = directories.create();
    const model = createFixtureModel({
      turns: [
        {
          toolCall: {
            id: "call-1",
            name: "operator.ask_user",
            input: { question: "Which projects?", connectionId: "telegram-main", chatId: "chat-1" },
          },
        },
        { text: "recovered" },
      ],
    });
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directory, { approvalRequiredFor: [], messagingAllowedDestinations: ["chat-1"] }),
      { modelOverride: model },
    );
    try {
      // A connector that *refuses* every send — a real provider outcome, not a
      // thrown error: `messaging.send` returns `{status: "rejected"}`.
      runtime.messaging.registerConnector(
        createFixtureMessagingConnectorDefinition({
          sendOutcome: () => ({ status: "rejected", retryable: false, parts: [{ index: 0, status: "rejected", error: "chat not found" }] }),
        }),
      );
      await runtime.messaging.openConnection({
        connection: {
          connectionId: "telegram-main",
          providerId: "fixture",
          accountIdentity: "op-bot",
          workspaceId: "default",
          configRevision: 1,
          enabled: true,
        },
        config: {},
      });
      await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "telegram-main",
        externalSenderId: "operator-chat",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "test",
        createdAt: "2026-04-05T00:00:00.000Z",
      });

      await runtime.messaging.ingest(inboundEvent({ content: "start" }));
      await delay(50);

      // The regression: the outcome was discarded, so the task suspended for a
      // question the operator never received — a question that cannot be
      // delivered must not leave the task waiting.
      const taskId = (await runtime.store.asPort().repositories.messagingConversations.get("telegram-main", "chat-1"))?.taskId ?? "";
      expect(taskId === "" ? undefined : await runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId)).toBeUndefined();
      // The model was told, rather than silently parked.
      const lastCall = JSON.stringify(model.calls.at(-1)?.messages ?? []);
      expect(lastCall).toContain("could not be delivered");
    } finally {
      await runtime.close();
    }
  });

  it("refuses an explicit destination the operator did not allowlist", async () => {
    const directory = directories.create();
    const model = createFixtureModel({
      turns: [
        {
          toolCall: {
            id: "call-1",
            name: "operator.ask_user",
            // A chat the operator never authorized: the model chose it.
            input: { question: "leak?", connectionId: "telegram-main", chatId: "@attacker" },
          },
        },
        { text: "recovered" },
      ],
    });
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directory, { approvalRequiredFor: [], messagingAllowedDestinations: ["chat-1"] }),
      { modelOverride: model },
    );
    try {
      let instance: FixtureMessagingConnectorInstance | undefined;
      runtime.messaging.registerConnector(
        createFixtureMessagingConnectorDefinition({
          onInstanceCreated: (created) => {
            instance = created;
          },
        }),
      );
      await runtime.messaging.openConnection({
        connection: {
          connectionId: "telegram-main",
          providerId: "fixture",
          accountIdentity: "op-bot",
          workspaceId: "default",
          configRevision: 1,
          enabled: true,
        },
        config: {},
      });
      await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "telegram-main",
        externalSenderId: "operator-chat",
        workspaceId: "default",
        principalId: "operator",
        approvedBy: "test",
        createdAt: "2026-04-05T00:00:00.000Z",
      });

      await runtime.messaging.ingest(inboundEvent({ content: "start" }));
      await delay(50);

      // Nothing left the process, and nothing was left suspended.
      expect(instance?.sent ?? []).toHaveLength(0);
      const taskId = (await runtime.store.asPort().repositories.messagingConversations.get("telegram-main", "chat-1"))?.taskId ?? "";
      expect(taskId === "" ? undefined : await runtime.store.asPort().repositories.agentWaits.getActiveByTask(taskId)).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});
