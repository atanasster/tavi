import type { InboundEvent, OutboundMessage } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, waitFor } from "@tavi/test-support";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions, askingForMemoryProposals } from "../support/serve-fixture.js";

/**
 * Private approvals:
 * a round raised in a room, on a channel that reaches a sender one-to-one,
 * shows its card to its decider alone and the room only that it waits; both
 * are edited on settlement through their own destinations; a decider who
 * cannot be reached is told in the room to approve in Tavi, and the card is
 * never posted to the room.
 */

const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  directories.cleanup();
});

const propose = { toolCall: { id: "c1", name: "memory.propose", input: { kind: "fact", body: "the sky is blue" } } } as const;

interface Edit {
  readonly destination: unknown;
  readonly messageId: string;
  readonly text: string;
}

async function harness(
  turns: readonly ScriptedTurn[],
  options: { readonly unreachable?: boolean; readonly failEdits?: boolean; readonly oneToOne?: boolean } = {},
) {
  const directory = directories.create("tavi-private-approvals-");
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: ["mutating", "external"],
    }),
    { modelOverride: createFixtureModel({ turns }) },
  );
  // A memory proposal is these tests' asked call: its seeded allow rule is revoked.
  await askingForMemoryProposals(runtime);
  runtimes.push(runtime);
  const instances: FixtureMessagingConnectorInstance[] = [];
  const answered: { callbackId: string; text: string }[] = [];
  const edited: Edit[] = [];
  let counter = 0;
  const fixture = createFixtureMessagingConnectorDefinition({
    sendOutcome: (message) => {
      // A decider whose chat the platform will not open.
      if (options.unreachable === true && (message.destination as { dm?: string }).dm !== undefined) {
        return {
          status: "rejected",
          retryable: false,
          parts: [{ index: 0, status: "rejected", error: "cannot message this user", unreachable: true }],
        };
      }
      counter += 1;
      return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: `m-${counter}` }] };
    },
    onInstanceCreated: (instance) => instances.push(instance),
    capabilities: {
      interactions: true,
      editOrProgress: true,
      approvals: "buttons",
      groups: {
        addressing: ["mention"],
        directToSender: options.oneToOne !== false,
        listRooms: false,
        membershipEvents: false,
        leaveRoom: false,
      },
    },
  });
  runtime.messaging.registerConnector({
    ...fixture,
    createConnection: (input) => {
      const instance = fixture.createConnection(input);
      return {
        ...instance,
        send: (message) => instance.send(message),
        onInboundEvent: (next) => instance.onInboundEvent?.(next),
        answerInteraction: async (callbackId: string, text: string) => void answered.push({ callbackId, text }),
        editMessage: async (edit: { readonly destination: unknown; readonly messageId: string; readonly text: string }) => {
          if (options.failEdits === true) throw new Error("message to edit not found");
          edited.push({ destination: edit.destination, messageId: edit.messageId, text: edit.text });
        },
      };
    },
    destinationFromInbound: (replyTo) => ({ room: replyTo.externalConversationId }),
    ...(options.oneToOne === false ? {} : { directDestinationOf: (sender: string) => ({ dm: sender }) }),
  });
  await runtime.messaging.openConnection({
    connection: {
      connectionId: "conn-g",
      providerId: "fixture",
      accountIdentity: "bot-1",
      workspaceId: "default",
      configRevision: 1,
      enabled: true,
    },
    config: {},
  });
  const bind = async (externalSenderId: string, principalId: string) =>
    runtime.store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: "conn-g",
      externalSenderId,
      workspaceId: "default",
      principalId,
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  return { runtime, messages: (): readonly OutboundMessage[] => instances[0]?.sent ?? [], answered, edited, bind };
}

let counter = 0;
function roomMessage(content: string, sender: string): InboundEvent {
  counter += 1;
  return {
    connectionId: "conn-g",
    providerEventId: `evt-${counter}`,
    kind: "message",
    externalSenderId: sender,
    externalConversationId: "room-1",
    conversationKind: "group",
    externalMessageId: `room-msg-${counter}`,
    occurredAt: nowTimestamp(),
    receivedAt: nowTimestamp(),
    content,
  };
}
function press(data: string, sender: string, conversation: string): InboundEvent {
  counter += 1;
  return {
    connectionId: "conn-g",
    providerEventId: `press-${counter}`,
    kind: "interaction",
    externalSenderId: sender,
    externalConversationId: conversation,
    occurredAt: nowTimestamp(),
    receivedAt: nowTimestamp(),
    interaction: { data, callbackId: `cb-${counter}`, messageId: "m-1" },
  };
}

const text = (message: OutboundMessage | undefined): string => (message?.parts[0] as { content?: string } | undefined)?.content ?? "";

describe("a room's approval round", () => {
  it("shows its card to the decider alone, tells the room only that it waits, and edits both where they are", async () => {
    const { runtime, messages, edited, bind } = await harness([propose, { text: "done" }]);
    await bind("op-1", "alice");
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(roomMessage("remember that the sky is blue", "op-1"));
    const taskId = (await repositories.messagingConversations.get("conn-g", "room-1"))?.taskId ?? "";
    const round = await repositories.approvalRounds.get(taskId, 1);
    const token = round?.token ?? "";
    const card = messages().find((message) => (message.destination as { dm?: string }).dm === "op-1");
    const notice = messages().find((message) => (message.destination as { room?: string }).room === "room-1");
    // The card: buttons, no room message to reply to, and the call itself.
    expect(card?.buttons?.flat().map((button) => button.data)).toContain(`r:${token}:o`);
    expect(card?.replyToId).toBeUndefined();
    expect(text(card)).toContain("memory.propose");
    // The room: a reply that names no call, no destination, no value, and carries no buttons.
    expect(notice?.buttons).toBeUndefined();
    expect(notice?.replyToId).toMatch(/^room-msg-/);
    expect(text(notice)).toBe(`⏸ Waiting on the operator's approval (round ${token}).`);
    expect(
      messages().filter((message) => (message.destination as { room?: string }).room !== undefined && message.buttons !== undefined),
    ).toEqual([]);
    expect(
      (await repositories.approvalRoundDeliveries.listForRound(taskId, 1)).map((delivery) => [delivery.role, delivery.destination]),
    ).toEqual([
      ["card", { dm: "op-1" }],
      ["notice", { room: "room-1" }],
    ]);

    // Pressed in the decider's own chat: decided, and both copies edited through their own destinations.
    await runtime.messaging.ingest(press(`r:${token}:o`, "op-1", "op-1"));
    await waitFor(
      async () =>
        (await repositories.tasks.get(taskId))?.status === "completed" &&
        edited.some((edit) => (edit.destination as { room?: string }).room === "room-1"),
    );
    expect(edited.find((edit) => (edit.destination as { dm?: string }).dm === "op-1")?.text).toMatch(/✅ Approved by Tavi's owner/);
    expect(edited.find((edit) => (edit.destination as { room?: string }).room === "room-1")?.text).toMatch(
      /^⏸ Waiting on the operator's approval[\s\S]*✅ Approved/,
    );
  });

  it("refuses a press from a member of the room, who decides nothing", async () => {
    const { runtime, answered, bind } = await harness([propose, { text: "done" }]);
    await bind("op-1", "alice");
    await bind("member-1", "bob");
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(roomMessage("remember that the sky is blue", "op-1"));
    const taskId = (await repositories.messagingConversations.get("conn-g", "room-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    await runtime.messaging.ingest(press(`r:${token}:o`, "member-1", "room-1"));
    await waitFor(async () => answered.length > 0);
    expect(answered.at(-1)?.text).toMatch(/Only the person this chat belongs to can decide it/);
    expect((await repositories.approvalRounds.listEvents(taskId, 1)).map((event) => event.kind)).toContain("decision_refused");
    expect((await repositories.approvalRounds.get(taskId, 1))?.settledAt).toBeUndefined();
  });

  it("tells the room to approve in Tavi when the decider has no chat there, and shows the card nowhere", async () => {
    const { runtime, messages, bind } = await harness([propose, { text: "done" }]);
    // A person's room task: its rounds are the operator's, who is bound nowhere on this connection.
    await bind("member-1", "bob");
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(roomMessage("remember that the sky is blue", "member-1"));
    const taskId = (await repositories.messagingConversations.get("conn-g", "room-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    expect(messages().map((message) => [message.destination, text(message)])).toContainEqual([
      { room: "room-1" },
      `⏸ Round ${token} waits on the operator's approval in Tavi: the web app, the CLI or another chat.`,
    ]);
    expect(messages().filter((message) => message.buttons !== undefined)).toEqual([]);
    expect(messages().some((message) => text(message).includes("memory.propose"))).toBe(false);
  });

  it("tells the room to approve in Tavi when the platform will not open the decider's chat", async () => {
    const { runtime, messages, bind } = await harness([propose, { text: "done" }], { unreachable: true });
    await bind("op-1", "alice");
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(roomMessage("remember that the sky is blue", "op-1"));
    const taskId = (await repositories.messagingConversations.get("conn-g", "room-1"))?.taskId ?? "";
    const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
    const room = messages().filter((message) => (message.destination as { room?: string }).room === "room-1");
    expect(room.map(text)).toEqual([
      `⏸ Round ${token} waits on the operator's approval: open a one-to-one chat with me, or approve it in Tavi: the web app, the CLI or another chat.`,
    ]);
    expect((await repositories.approvalRoundDeliveries.listForRound(taskId, 1)).map((delivery) => delivery.role)).toEqual(["notice"]);
  });

  it("settles a round the decider could not be shown by editing the room's notice, or telling the room when it cannot", async () => {
    for (const failEdits of [false, true]) {
      const { runtime, messages, edited, bind } = await harness([propose, { text: "done" }], { unreachable: true, failEdits });
      await bind("op-1", "alice");
      const repositories = runtime.store.asPort().repositories;
      await runtime.messaging.ingest(roomMessage("remember that the sky is blue", "op-1"));
      const taskId = (await repositories.messagingConversations.get("conn-g", "room-1"))?.taskId ?? "";
      const token = (await repositories.approvalRounds.get(taskId, 1))?.token ?? "";
      // Decided by its person typing in the room; the room's notice carries the outcome.
      await runtime.messaging.ingest(roomMessage(`approve ${token}`, "op-1"));
      await waitFor(async () => (await repositories.approvalRounds.listEvents(taskId, 1)).some((event) => event.kind === "notified"));
      if (failEdits) {
        expect(
          messages()
            .filter((message) => (message.destination as { room?: string }).room === "room-1")
            .map(text)
            .some((line) => /✅ Approved/.test(line)),
        ).toBe(true);
      } else {
        expect(edited.map((entry) => [entry.destination, entry.text.split("\n")[0]])).toContainEqual([
          { room: "room-1" },
          `⏸ Round ${token} waits on the operator's approval: open a one-to-one chat with me, or approve it in Tavi: the web app, the CLI or another chat.`,
        ]);
      }
      // The card the platform refused is recorded nowhere, so nothing ever edits or resends it.
      expect((await repositories.approvalRoundDeliveries.listForRound(taskId, 1)).map((delivery) => delivery.role)).toEqual(["notice"]);
    }
  });
  it("settles a round with no delivery rows by editing it in the room it was announced in", async () => {
    // Before 0151 a room's round was announced in the room itself: a channel that cannot reach its decider one-to-one still does so.
    const { runtime, messages, edited, bind } = await harness([propose, { text: "done" }], { oneToOne: false });
    await bind("op-1", "alice");
    const repositories = runtime.store.asPort().repositories;
    await runtime.messaging.ingest(roomMessage("remember that the sky is blue", "op-1"));
    const taskId = (await repositories.messagingConversations.get("conn-g", "room-1"))?.taskId ?? "";
    const round = await repositories.approvalRounds.get(taskId, 1);
    const token = round?.token ?? "";
    const announcement = messages().find(
      (message) => (message.destination as { room?: string }).room === "room-1" && message.buttons !== undefined,
    );
    expect(text(announcement)).toContain("memory.propose");
    expect(round?.messageIds.length).toBeGreaterThan(0);
    expect(await repositories.approvalRoundDeliveries.listForRound(taskId, 1)).toEqual([]);
    const sentBefore = messages().length;
    await runtime.messaging.ingest(press(`r:${token}:o`, "op-1", "room-1"));
    await waitFor(async () => (await repositories.approvalRounds.listEvents(taskId, 1)).some((event) => event.kind === "notified"));
    // Edited in place, in the room, its outcome under its text; nothing new posted for it.
    expect(edited).toContainEqual({
      destination: { room: "room-1" },
      messageId: round?.messageIds[0],
      text: expect.stringMatching(/memory\.propose[\s\S]*✅ Approved/),
    });
    expect(
      messages()
        .slice(sentBefore)
        .filter((message) => /✅ Approved/.test(text(message))),
    ).toEqual([]);
  });
});
