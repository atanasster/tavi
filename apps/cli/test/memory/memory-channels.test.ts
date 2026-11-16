import {
  MEMORY_TIDY_UP_NEEDS_LOOK,
  TaviError,
  memoryCardChannelMessage,
  memoryCardPressData,
  type InboundEvent,
  type MemoryActor,
  type MemoryCardAnswer,
  type MemoryCardItem,
  type MemoryPayload,
  type ModelPort,
  type OutboundButton,
  type OutboundMessage,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, waitForValue, fakeFetch, delay } from "@tavi/test-support";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createWhatsappLikeDefinition } from "../../../../tests/fixtures/channel-whatsapp-like/index.mjs";
import { channelDescriptorOf, registerChannelDescriptor, unregisterChannelDescriptor } from "../../src/features/channels/catalog.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import {
  createMemoryChannelCards,
  disarmedMemoryCard,
  memoryCardEffectId,
  isMemoryPress,
} from "../../src/features/memory/channel-cards.js";
import { memoryCommand } from "../../src/features/memory/owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Memory cards on messaging channels: a card follows the reply in a direct chat of its person — with at
 * most three buttons where the channel has them, the `/memory` commands where
 * it has none, and no action on email — and never in a group. A press acts
 * for the presser's own memory only, within 7 days, and reads a decided
 * record's state; a forget edits the sent card where the channel can edit.
 */

const directories = temporaryDirectories({ prefix: "tavi-memory-channels-" });
const runtimes: TaviRuntime[] = [];
const descriptors: string[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
  while (descriptors.length > 0) unregisterChannelDescriptor(descriptors.pop() ?? "");
});

const PROPOSE = "remember that I am vegetarian";

/** Proposes one memory when asked to, and otherwise says "Done.". */
const proposingModel: ModelPort = {
  async stream(request) {
    const done = {
      attemptId: request.attemptId,
      status: "completed" as const,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    };
    if (request.purpose !== undefined && request.purpose !== "generation") return { ...done, text: "A chat" };
    const last = request.messages.at(-1);
    if (last?.toolResults === undefined && last?.text.includes(PROPOSE) === true) {
      return {
        ...done,
        text: "",
        finishReason: "tool-calls" as const,
        toolCalls: [
          { id: "p1", name: "memory.propose", input: { kind: "fact", title: "You're vegetarian", body: "The person is vegetarian." } },
        ],
      };
    }
    return { ...done, text: "Done." };
  },
};

const OPERATOR = { workspaceId: "default", principalId: "operator" };
let eventCounter = 0;

/** A channel's sends, button answers and edits. */
interface Channel {
  readonly sent: () => readonly OutboundMessage[];
  readonly answers: string[];
  readonly edits: { readonly messageId: string; readonly text: string; readonly buttons?: readonly (readonly OutboundButton[])[] }[];
}

async function composed() {
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directories.create(), {
      workspaces: [{ ...OPERATOR, permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: [],
      memoryHostEnabled: true,
    }),
    { modelOverride: proposingModel },
  );
  runtimes.push(runtime);
  const repositories = runtime.store.asPort().repositories;
  const mail = {
    ...(channelDescriptorOf("mailgun") ??
      (() => {
        throw new Error("no email descriptor");
      })()),
    providerId: "fixture-mail",
  };
  registerChannelDescriptor(mail);
  descriptors.push(mail.providerId);
  // A chat channel without buttons, named as its catalog entry names it.
  const plain = {
    ...(channelDescriptorOf("telegram") ??
      (() => {
        throw new Error("no chat descriptor");
      })()),
    providerId: "fixture-plain",
    label: "Plain Chat",
  };
  registerChannelDescriptor(plain);
  descriptors.push(plain.providerId);
  const channels = new Map<string, Channel>();
  /** While set, every channel's connector throws after taking a send. */
  const failing = { sends: false };
  // A chat channel with buttons and edits, one with neither, and email.
  for (const [providerId, connectionId, capabilities] of [
    ["fixture-buttons", "conn-tg", { interactions: true, editOrProgress: true }],
    ["fixture-plain", "conn-text", {}],
    ["fixture-mail", "conn-mail", {}],
  ] as const) {
    const answers: string[] = [];
    const edits: Channel["edits"] = [];
    let instance: FixtureMessagingConnectorInstance | undefined;
    let sends = 0;
    const fixture = createFixtureMessagingConnectorDefinition({
      providerId,
      capabilities,
      sendOutcome: () => {
        if (failing.sends) throw new Error("the channel dropped the connection");
        return {
          status: "accepted",
          retryable: false,
          parts: [{ index: 0, status: "accepted", providerMessageId: `msg-${(sends += 1)}` }],
        };
      },
      onInstanceCreated: (created) => {
        instance = created;
      },
    });
    runtime.messaging.registerConnector({
      ...fixture,
      destinationFromInbound: (replyTo) => ({ fixtureChat: replyTo.externalConversationId }),
      createConnection: (input) => {
        // As a channel with buttons and edits answers a press and edits a message.
        const created = fixture.createConnection(input) as FixtureMessagingConnectorInstance & Record<string, unknown>;
        if (capabilities.interactions === true)
          created["answerInteraction"] = async (_callbackId: string, text: string) => {
            answers.push(text);
          };
        if (capabilities.editOrProgress === true)
          created["editMessage"] = async (edit: Channel["edits"][number]) => {
            edits.push({ messageId: edit.messageId, text: edit.text, ...(edit.buttons === undefined ? {} : { buttons: edit.buttons }) });
          };
        return created;
      },
    });
    await runtime.messaging.openConnection({
      connection: {
        connectionId,
        providerId,
        accountIdentity: `acct-${connectionId}`,
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    channels.set(connectionId, { sent: () => instance?.sent ?? [], answers, edits });
  }
  // Bob is a person of the workspace, not its operator.
  for (const [connectionId, sender, principalId] of [
    ["conn-tg", "bob-1", "bob"],
    ["conn-tg", "op-1", "operator"],
    ["conn-text", "bob-t", "bob"],
    ["conn-mail", "bob@example.com", "bob"],
  ] as const) {
    await repositories.messagingIdentityBindings.bind({
      connectionId,
      externalSenderId: sender,
      workspaceId: "default",
      principalId,
      approvedBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }
  const channel = (connectionId: string): Channel => channels.get(connectionId) as Channel;
  const event = (connectionId: string, sender: string, extra: Partial<InboundEvent>): InboundEvent => {
    eventCounter += 1;
    return {
      connectionId,
      providerEventId: `evt-${eventCounter}`,
      kind: "message",
      externalSenderId: sender,
      externalConversationId: sender,
      conversationKind: "direct",
      occurredAt: nowTimestamp(),
      receivedAt: nowTimestamp(),
      ...(connectionId === "conn-mail" ? { senderAuthentication: "pass" as const } : {}),
      ...extra,
    } as InboundEvent;
  };
  /** A message in a chat, its turn waited for. */
  const say = async (content: string, connectionId: string, sender: string, extra: Partial<InboundEvent> = {}): Promise<string> => {
    const conversation = extra.externalConversationId ?? sender;
    await runtime.messaging.ingest(event(connectionId, sender, { content, ...extra }));
    const taskId = await waitForValue(async () => {
      const mapped = await repositories.messagingConversations.get(connectionId, conversation);
      const task = mapped === undefined ? undefined : await repositories.tasks.get(mapped.taskId);
      return task?.status === "completed" ? task.taskId : undefined;
    });
    return taskId;
  };
  /** A command typed in a chat, and its answer. */
  const command = async (line: string, connectionId: string, sender: string): Promise<string> => {
    await delay(260);
    const before = channel(connectionId).sent().length;
    await runtime.messaging.ingest(event(connectionId, sender, { content: line }));
    await waitForValue(async () => (channel(connectionId).sent().length > before ? true : undefined));
    return textOf(channel(connectionId).sent().at(-1));
  };
  /** A button press, and its answer. */
  const press = async (connectionId: string, sender: string, data: string, extra: Partial<InboundEvent> = {}): Promise<string> => {
    const answers = channel(connectionId).answers;
    const before = answers.length;
    await runtime.messaging.ingest(
      event(connectionId, sender, {
        kind: "interaction",
        interaction: { data, callbackId: `cb-${eventCounter}`, messageId: "msg-1" },
        ...extra,
      }),
    );
    await waitForValue(async () => (answers.length > before ? true : undefined));
    return answers.at(-1) ?? "";
  };
  const ipc = async <T>(payload: MemoryPayload, principalId = "operator", fromBridge = false): Promise<T> => {
    const answer = await memoryCommand(
      { memory: runtime.memory, repositories, principalOf: () => principalId, fromBridge, now: () => new Date() },
      payload,
    );
    if (!answer.ok) throw new TaviError(answer.error.code as never, answer.error.message);
    return answer.result as T;
  };
  const modelActor = (principalId: string): MemoryActor => ({ workspaceId: "default", principalId, caller: "agent", authority: "model" });
  const propose = async (principalId: string, body: string, sensitive = false) =>
    await runtime.memory.propose({
      actor: modelActor(principalId),
      scope: { kind: "personal", principalId },
      kind: "fact",
      body,
      ...(sensitive ? { sensitivity: "sensitive" as const } : {}),
    });
  /** A card in `taskId` holding `recordIds`, sent to the chat's channel as a turn's would be. */
  const card = async (taskId: string, principalId: string, recordIds: readonly string[], createdAt = nowTimestamp()) => {
    const posted = await repositories.transcripts.postMemoryCard({
      noticeId: runtime.clock.newId("notice"),
      taskId,
      sourceKey: `memory:test-${(eventCounter += 1)}`,
      createdAt,
      records: recordIds.map((recordId) => ({ recordId, workspaceId: "default", principalId })),
    });
    await runtime.memoryChannelCards.deliver({ noticeId: posted.notice.noticeId, taskId, workspaceId: "default", principalId });
    return posted;
  };
  const statusOf = async (recordId: string) => (await repositories.memory.getRecord(recordId))?.status;
  /** The newest message sent on a channel that carries buttons. */
  const buttonsOf = (message: OutboundMessage | undefined) => (message?.buttons ?? []).flat();
  const dataOf = (message: OutboundMessage | undefined, label: string): string =>
    buttonsOf(message).find((button) => button.label === label)?.data ?? "";
  const textOf = (message: OutboundMessage | undefined): string => (message?.parts[0] as { content?: string } | undefined)?.content ?? "";
  return { runtime, repositories, failing, channel, say, command, press, ipc, propose, card, statusOf, buttonsOf, dataOf, textOf };
}

describe("a turn's memory card on a channel with buttons", () => {
  it("follows the reply with Keep / Discard / Open; Keep approves, a second press says Already kept, and another sender is refused", async () => {
    const { repositories, channel, say, press, statusOf, buttonsOf, dataOf, textOf } = await composed();
    const chat = await say(PROPOSE, "conn-tg", "bob-1");
    const tg = channel("conn-tg");
    const sent = await waitForValue(async () => tg.sent().find((message) => buttonsOf(message).length > 0));
    expect(textOf(sent)).toBe("Proposed · remember everywhere\nYou're vegetarian\nThe person is vegetarian.");
    expect(buttonsOf(sent).map((button) => button.label)).toEqual(["Keep", "Discard", "Open"]);
    expect(isMemoryPress({ kind: "interaction", interaction: { data: dataOf(sent, "Keep") } } as InboundEvent)).toBe(true);
    // The card's words are not kept in the send's record (invariant 22).
    const [notice] = (await repositories.transcripts.notices(chat, { limit: 10 })).filter((each) => each.kind === "memory");
    const stored = repositories.transcripts.memoryCardMessages(memoryCardEffectId(notice?.noticeId ?? ""));
    expect(await stored).toMatchObject([{ connectionId: "conn-tg", messageId: expect.any(String) }]);
    const [row] = await repositories.transcripts.memoryPrompts(notice?.noticeId ?? "");
    const recordId = row?.recordId ?? "";

    expect(await press("conn-tg", "op-1", dataOf(sent, "Keep"))).toBe("That memory doesn't exist, or isn't yours.");
    expect(await statusOf(recordId)).toBe("proposed");
    expect(await press("conn-tg", "bob-1", dataOf(sent, "Open"))).toBe("Open Tavi to review: Center → Soul & memory.");
    expect(await press("conn-tg", "bob-1", dataOf(sent, "Keep"))).toBe("Kept.");
    expect(await statusOf(recordId)).toBe("approved");
    // Kept by its own person, with an operator review in their name (a non-operator deciding their own, invariant 21).
    expect((await repositories.memory.listReviews(recordId)).map((review) => [review.decision, review.reviewerPrincipalId])).toEqual([
      ["approved", "bob"],
    ]);
    // The message now shows the saved card, with Undo.
    expect(tg.edits.at(-1)).toMatchObject({ messageId: "msg-1", text: "Saved\nYou're vegetarian\nThe person is vegetarian." });
    expect(
      tg.edits
        .at(-1)
        ?.buttons?.flat()
        .map((button) => button.label),
    ).toEqual(["Undo", "Open"]);
    expect(await press("conn-tg", "bob-1", dataOf(sent, "Keep"))).toBe("Already kept.");
    expect(await press("conn-tg", "bob-1", dataOf(sent, "Discard"))).toBe("Already kept.");
    expect(await repositories.memory.listReviews(recordId)).toHaveLength(1);
  }, 60_000);

  it("memory invariant 22: a send that fails after the outbox took it keeps none of the card's words", async () => {
    const { repositories, failing, channel, say, propose, card, textOf } = await composed();
    const chat = await say("hello", "conn-tg", "bob-1");
    const record = await propose("bob", "I collect stamps");
    failing.sends = true;
    const posted = await card(chat, "bob", [record.recordId]);
    failing.sends = false;
    // The connector took it, then threw: the outbox row was written before it did.
    expect(textOf(channel("conn-tg").sent().at(-1))).toContain("stamps");
    // A throw after dispatch leaves the row pending (it may have gone out); its words are dropped all the same.
    const row = (await repositories.messagingOutbox.listPending(100, "conn-tg")).find(
      (each) => each.effectId === memoryCardEffectId(posted.notice.noticeId),
    );
    expect(row?.connectionId).toBe("conn-tg");
    expect(JSON.stringify(row)).not.toContain("stamps");
    expect(JSON.stringify(row)).not.toContain("y:");
  }, 60_000);

  it("memory invariant 9: a forget anywhere edits the sent card to say Forgotten, with no text and no buttons, and its token answers No longer available", async () => {
    const { repositories, channel, say, press, ipc, statusOf, buttonsOf, dataOf } = await composed();
    const chat = await say(PROPOSE, "conn-tg", "bob-1");
    const tg = channel("conn-tg");
    const sent = await waitForValue(async () => tg.sent().find((message) => buttonsOf(message).length > 0));
    const [notice] = (await repositories.transcripts.notices(chat, { limit: 10 })).filter((each) => each.kind === "memory");
    const [row] = await repositories.transcripts.memoryPrompts(notice?.noticeId ?? "");
    const recordId = row?.recordId ?? "";
    await ipc({ action: "approve", recordId }, "bob");
    expect(await press("conn-tg", "bob-1", dataOf(sent, "Keep"))).toBe("Already kept.");
    // A forget from elsewhere (the Center, a command) edits the delivered card; nothing of it keeps the text.
    await ipc({ action: "forget", recordId, reason: "test" }, "bob");
    expect(await statusOf(recordId)).toBe("deleted");
    await waitForValue(async () => (tg.edits.some((edit) => edit.text === "Forgotten") ? true : undefined));
    expect(tg.edits.at(-1)?.buttons).toBeUndefined();
    expect(JSON.stringify(tg.edits.at(-1))).not.toContain("vegetarian");
    expect(await press("conn-tg", "bob-1", dataOf(sent, "Keep"))).toBe("No longer available.");
  }, 60_000);
});

describe("a card's Undo names the memory providers its removal waits for", () => {
  it("answers Forgotten, with the provider that will be sent the removal when it next runs, for Undo and Undo all", async () => {
    const { runtime, repositories, say, ipc } = await composed();
    const chat = await say("hello", "conn-tg", "bob-1");
    const kept = await Promise.all(
      ["I take the train", "I cycle on Fridays"].map(
        async (body) =>
          await runtime.memory.remember({
            actor: { workspaceId: "default", principalId: "bob", caller: "test", authority: "operator" },
            scope: { kind: "personal", principalId: "bob" },
            kind: "fact",
            body,
          }),
      ),
    );
    // A provider that could not take the removal now: each receipt names it, as the provider sync answers.
    const memory = new Proxy(runtime.memory, {
      get: (target, property) =>
        property === "forget"
          ? async (input: Parameters<typeof target.forget>[0]) => ({
              ...(await target.forget(input)),
              cleanupStatus: "pending" as const,
              pendingProviders: ["acme.index"],
            })
          : Reflect.get(target, property),
    });
    const answers: string[] = [];
    const cards = createMemoryChannelCards({
      memory,
      repositories,
      messaging: {
        answerInteraction: async (_connectionId: string, _callbackId: string, text: string) => void answers.push(text),
      } as never,
      isEmailConnection: () => false,
      isLocalConnection: () => false,
      channelName: () => undefined,
      reachOf: async () => undefined,
      newId: (prefix) => runtime.clock.newId(prefix),
      now: () => nowTimestamp(),
      log: () => {},
    });
    const posted = async () =>
      (
        await repositories.transcripts.postMemoryCard({
          noticeId: runtime.clock.newId("notice"),
          taskId: chat,
          sourceKey: `memory:undo-${answers.length}`,
          createdAt: nowTimestamp(),
          records: kept.map((record) => ({ recordId: record.recordId, workspaceId: "default", principalId: "bob" })),
        })
      ).notice.noticeId;
    const press = async (data: string): Promise<string | undefined> => {
      await cards.handleInteraction({
        actor: { workspaceId: "default", principalId: "bob", caller: "test", authority: "operator" },
        event: {
          connectionId: "conn-tg",
          providerEventId: `evt-${data}`,
          kind: "interaction",
          externalSenderId: "bob-1",
          externalConversationId: "bob-1",
          conversationKind: "direct",
          occurredAt: nowTimestamp(),
          receivedAt: nowTimestamp(),
          interaction: { data, callbackId: "cb" },
        } as never,
      });
      return answers.at(-1);
    };
    const rows = await repositories.transcripts.memoryPrompts(await posted());
    expect(await press(`y:${rows[0]?.token}:u`)).toBe("Forgotten. It will be removed from acme.index when it next runs.");
    const all = await repositories.transcripts.memoryPrompts(await posted());
    expect(await press(`y:${all[0]?.token}:U`)).toBe("Forgotten 1. It will be removed from acme.index when it next runs.");
    expect((await ipc<{ records: readonly unknown[] }>({ action: "list", statuses: ["approved"] }, "bob")).records).toEqual([]);
  }, 60_000);
});

describe("a card of two proposals", () => {
  it("one of them sensitive: Keep all / Discard all / Open with both numbered; Keep all keeps the plain one, says 1 needs a look, and its Saved receipt's Undo forgets exactly that one", async () => {
    const { channel, say, press, propose, card, statusOf, buttonsOf, dataOf, textOf } = await composed();
    const chat = await say("hello", "conn-tg", "bob-1");
    const plain = await propose("bob", "I take the train to work");
    const secret = await propose("bob", "My diagnosis is private", true);
    await card(chat, "bob", [plain.recordId, secret.recordId]);
    const tg = channel("conn-tg");
    const sent = tg.sent().at(-1);
    expect(textOf(sent)).toBe("2 things to remember\n1. I take the train to work\n2. Sensitive item — open Tavi to review");
    // A sensitive proposal's text is on no channel card.
    expect(JSON.stringify(tg.sent())).not.toContain("diagnosis");
    expect(buttonsOf(sent).map((button) => button.label)).toEqual(["Keep all", "Discard all", "Open"]);

    expect(await press("conn-tg", "bob-1", dataOf(sent, "Keep all"))).toBe("Kept 1 · 1 needs a look — open Tavi to review.");
    expect(await statusOf(plain.recordId)).toBe("approved");
    expect(await statusOf(secret.recordId)).toBe("proposed");
    // Its receipt: a Saved card of what that press kept, with Undo.
    const receipt = tg.sent().at(-1);
    expect(textOf(receipt)).toBe("Saved\nI take the train to work");
    expect(buttonsOf(receipt).map((button) => button.label)).toEqual(["Undo", "Open"]);
    expect(await press("conn-tg", "bob-1", dataOf(receipt, "Undo"))).toBe("Forgotten.");
    expect(await statusOf(plain.recordId)).toBe("deleted");
    expect(await statusOf(secret.recordId)).toBe("proposed");
    // The forget edited the first card too: what is left on it is the sensitive one, unnamed, with only Open.
    const edited = await waitForValue(async () => tg.edits.find((edit) => edit.text.includes("sensitive item waiting")));
    expect(edited.text).toBe("1 thing to remember\n1 sensitive item waiting — open Tavi to review");
    expect(edited.buttons?.flat().map((button) => button.label)).toEqual(["Open"]);
    expect(JSON.stringify(tg.edits)).not.toContain("diagnosis");
  }, 60_000);

  it("one proposed after its chat read a page: the card says what the chat read, and Keep all keeps only the other", async () => {
    const { runtime, channel, say, press, propose, card, statusOf, buttonsOf, dataOf, textOf } = await composed();
    const chat = await say("hello", "conn-tg", "bob-1");
    const plain = await propose("bob", "I take the train to work");
    const read = await runtime.memory.propose({
      actor: { workspaceId: "default", principalId: "bob", caller: "agent", authority: "model" },
      scope: { kind: "personal", principalId: "bob" },
      kind: "fact",
      body: "Bob's invoices go to billing@attacker.example",
      provenance: {
        integrity: "untrusted",
        sources: ["web"],
        refs: [{ source: "web", ref: "call-9", host: "shop.example.com", at: "2026-10-13T00:00:00.000Z" }],
      },
    });
    await card(chat, "bob", [plain.recordId, read.recordId]);
    const tg = channel("conn-tg");
    const sent = tg.sent().at(-1);
    // Its words are a model's, written after the page: an address the chat does not know goes out defanged.
    expect(textOf(sent)).toContain(
      "2. Bob's invoices go to billing@attacker[.]example — Proposed after this chat read a web page (shop.example.com); Keep all leaves it waiting",
    );
    expect(buttonsOf(sent).map((button) => button.label)).toEqual(["Keep all", "Discard all", "Open"]);
    expect(await press("conn-tg", "bob-1", dataOf(sent, "Keep all"))).toBe("Kept 1 · 1 needs a look — open Tavi to review.");
    expect(await statusOf(plain.recordId)).toBe("approved");
    expect(await statusOf(read.recordId)).toBe("proposed");
  }, 60_000);

  it("Discard all discards every waiting one, sensitive or not, and the card then says so", async () => {
    const { channel, say, press, propose, card, statusOf, dataOf } = await composed();
    const chat = await say("hello", "conn-tg", "bob-1");
    const plain = await propose("bob", "I like jazz");
    const secret = await propose("bob", "My account number is private", true);
    await card(chat, "bob", [plain.recordId, secret.recordId]);
    const tg = channel("conn-tg");
    expect(await press("conn-tg", "bob-1", dataOf(tg.sent().at(-1), "Discard all"))).toBe("Discarded 2.");
    expect([await statusOf(plain.recordId), await statusOf(secret.recordId)]).toEqual(["rejected", "rejected"]);
    expect(tg.edits.at(-1)?.text).toBe("Discarded · 2\n1. I like jazz — discarded\n2. Sensitive item — discarded");
    expect(tg.edits.at(-1)?.buttons).toBeUndefined();
    expect(await press("conn-tg", "bob-1", dataOf(tg.sent().at(-1), "Keep all"))).toBe("Already discarded.");
  }, 60_000);

  it("a single sensitive proposal is sent with no text and only Open", async () => {
    const { channel, say, propose, card, buttonsOf, textOf } = await composed();
    const chat = await say("hello", "conn-tg", "bob-1");
    const secret = await propose("bob", "My salary is private", true);
    await card(chat, "bob", [secret.recordId]);
    const sent = channel("conn-tg").sent().at(-1);
    expect(textOf(sent)).toBe("Proposed · remember everywhere\n1 sensitive item waiting — open Tavi to review");
    expect(buttonsOf(sent).map((button) => button.label)).toEqual(["Open"]);
    expect(JSON.stringify(sent)).not.toContain("salary");
  }, 60_000);
});

describe("a tidy-up on a card and in the commands", () => {
  /** Two of Bob's kept records, and a tidy-up merging them that waits. */
  const tidyUp = async (runtime: TaviRuntime) => {
    const actor: MemoryActor = { workspaceId: "default", principalId: "bob", caller: "cli", authority: "operator" };
    const scope = { kind: "personal" as const, principalId: "bob" };
    const first = await runtime.memory.remember({ actor, scope, kind: "fact", body: "Bob cycles to work" });
    const second = await runtime.memory.remember({ actor, scope, kind: "fact", body: "Bob rides his bike to the office" });
    return await runtime.memory.propose({
      actor,
      scope,
      kind: "fact",
      title: "Cycles to work",
      body: "Bob cycles to the office",
      supersedes: [first, second].map((record) => ({ recordId: record.recordId, revisionId: record.currentRevisionId ?? "" })),
    });
  };

  it("is marked to compare in Tavi with only Discard / Open, and a Keep pressed anyway says it needs a look", async () => {
    const { runtime, channel, say, press, card, statusOf, buttonsOf, textOf } = await composed();
    const chat = await say("hello", "conn-tg", "bob-1");
    const tidy = await tidyUp(runtime);
    const posted = await card(chat, "bob", [tidy.recordId]);
    const sent = channel("conn-tg").sent().at(-1);
    expect(textOf(sent)).toBe(
      "Proposed · remember everywhere\nCycles to work\nBob cycles to the office\nA tidy-up — open Tavi to compare it with what it replaces",
    );
    expect(buttonsOf(sent).map((button) => button.label)).toEqual(["Discard", "Open"]);
    const [row] = await runtime.store.asPort().repositories.transcripts.memoryPrompts(posted.notice.noticeId);
    expect(await press("conn-tg", "bob-1", memoryCardPressData(row?.token ?? "", "k"))).toBe(MEMORY_TIDY_UP_NEEDS_LOOK);
    expect(await statusOf(tidy.recordId)).toBe("proposed");
  }, 60_000);

  it("/memory review lists it marked, /memory keep <n> leaves it waiting, and /memory keep all keeps none of it", async () => {
    const { runtime, say, command, statusOf } = await composed();
    await say("hello", "conn-text", "bob-t");
    const tidy = await tidyUp(runtime);
    expect(await command("/memory review", "conn-text", "bob-t")).toBe(
      "1 waiting:\n1. Cycles to work — tidy-up, open Tavi to compare\n/memory keep <n…> · /memory keep all · /memory discard <n…>",
    );
    expect(await command("/memory keep 1", "conn-text", "bob-t")).toBe(`1: Cycles to work: ${MEMORY_TIDY_UP_NEEDS_LOOK}`);
    expect(await command("/memory keep all", "conn-text", "bob-t")).toBe("Kept 0 · 1 needs a look — open Tavi to review.");
    expect(await statusOf(tidy.recordId)).toBe("proposed");
  }, 60_000);
});

describe("cards and the channels' house rule", () => {
  const item = (number: number, state: MemoryCardItem["state"], sensitive = false): MemoryCardItem => ({
    token: "abcdefghijklmnopqrstuvwxyzABCDEF",
    number,
    recordId: `mem-${number}`,
    state,
    kind: "fact",
    target: "personal",
    sensitive,
    title: sensitive ? null : `Item ${number}`,
    excerpt: null,
  });
  const variants: readonly MemoryCardAnswer[] = [
    [item(1, "proposed")],
    [item(1, "proposed", true)],
    [item(1, "saved")],
    [item(1, "discarded")],
    [item(1, "proposed"), item(2, "proposed", true)],
    [item(1, "proposed", true), item(2, "proposed", true)],
    [item(1, "saved"), item(2, "saved")],
    [item(1, "saved"), item(2, "discarded")],
    [item(1, "discarded"), item(2, "expired")],
    [],
  ].map((items) => ({ noticeId: "notice-1", taskId: "task-1", title: `${items.length} things to remember`, items, forgotten: 0 }));

  it("every card variant has at most 3 buttons, each label at most 20 characters and each callback at most 64 bytes", () => {
    for (const variant of variants) {
      const { buttons } = memoryCardChannelMessage(variant, "buttons");
      expect(buttons.length).toBeLessThanOrEqual(3);
      for (const button of buttons) {
        expect(button.label.length).toBeLessThanOrEqual(20);
        expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64);
        expect(isMemoryPress({ kind: "interaction", interaction: { data: button.data } } as InboundEvent)).toBe(true);
      }
      expect(memoryCardChannelMessage(variant, "text").buttons).toEqual([]);
      expect(memoryCardChannelMessage(variant, "email").buttons).toEqual([]);
    }
  });

  it("reach the WhatsApp-like channel's reply buttons, all of them", async () => {
    const sent: unknown[] = [];
    const definition = createWhatsappLikeDefinition({
      z,
      TaviError,
      fetch: fakeFetch(async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
      }),
    });
    const connection = {
      connectionId: "wa",
      providerId: "wa-like",
      accountIdentity: "1029384756",
      workspaceId: "default",
      configRevision: 1,
      enabled: true,
    };
    const instance = await definition.createConnection({
      connection,
      config: { phoneNumberId: "1029384756", apiBaseUrl: "https://graph.test/v20.0", requestTimeoutMs: 1_000 },
      credentials: { get: async () => "token", accessToken: async () => "token" },
    });
    const destination = definition.destinationFor?.({ to: "+15551234567" }, connection);
    await instance.start();
    for (const variant of variants) {
      const message = memoryCardChannelMessage(variant, "buttons");
      if (message.buttons.length === 0) continue;
      sent.length = 0;
      await instance.send({
        effectId: `e-${variant.items.length}`,
        connectionId: "wa",
        destination,
        parts: [{ content: message.text }],
        buttons: [message.buttons],
      });
      const interactive = (sent[0] as { interactive?: { action: { buttons: { reply: { id: string; title: string } }[] } } }).interactive;
      expect(interactive?.action.buttons.map((button) => button.reply)).toEqual(
        message.buttons.map((button) => ({ id: button.data, title: button.label })),
      );
    }
    await instance.stop();
  });
});

describe("cards where a channel has no buttons", () => {
  it("a chat channel without buttons gets the text and the /memory commands", async () => {
    const { channel, say, textOf, buttonsOf } = await composed();
    await say(PROPOSE, "conn-text", "bob-t");
    const sent = await waitForValue(async () =>
      channel("conn-text")
        .sent()
        .find((message) => textOf(message).startsWith("Proposed")),
    );
    expect(textOf(sent)).toBe(
      "Proposed · remember everywhere\nYou're vegetarian\nThe person is vegetarian.\n/memory keep 1 · /memory discard 1",
    );
    expect(buttonsOf(sent)).toEqual([]);
  }, 60_000);

  it("a forget names the channel whose sent card cannot be edited", async () => {
    const { repositories, channel, say, command, ipc, textOf } = await composed();
    const chat = await say(PROPOSE, "conn-text", "bob-t");
    await waitForValue(async () =>
      channel("conn-text")
        .sent()
        .find((message) => textOf(message).startsWith("Proposed")),
    );
    const [notice] = (await repositories.transcripts.notices(chat, { limit: 10 })).filter((each) => each.kind === "memory");
    const [row] = await repositories.transcripts.memoryPrompts(notice?.noticeId ?? "");
    await ipc({ action: "approve", recordId: row?.recordId ?? "" }, "bob");
    expect(await command(`/forget ${row?.recordId ?? ""}`, "conn-text", "bob-t")).toBe(
      "Forgotten: You're vegetarian. Chats that quoted or used it keep their copy until the chat is forgotten. Earlier messages in Plain Chat may still show it.",
    );
  }, 60_000);
});

describe("memory invariant 11: a card's buttons act only in a direct chat of the card's person — never on email or in a group", () => {
  it("email gets the card as text with no action", async () => {
    const { channel, say, textOf, buttonsOf } = await composed();
    await say(PROPOSE, "conn-mail", "bob@example.com");
    const sent = await waitForValue(async () =>
      channel("conn-mail")
        .sent()
        .find((message) => textOf(message).startsWith("Proposed")),
    );
    expect(textOf(sent)).toBe("Proposed · remember everywhere\nYou're vegetarian\nThe person is vegetarian.\nOpen Tavi to review.");
    expect(buttonsOf(sent)).toEqual([]);
    expect(textOf(sent)).not.toContain("/memory");
  }, 60_000);

  it("a group gets no card, and a press there is not acted on", async () => {
    const { repositories, runtime, channel, say, press, propose, statusOf, textOf } = await composed();
    const group = await say(PROPOSE, "conn-tg", "bob-1", { externalConversationId: "group-1", conversationKind: "group" });
    const before = channel("conn-tg").sent().length;
    // Even a card posted there by hand is never sent.
    const record = await propose("bob", "A note");
    const posted = await repositories.transcripts.postMemoryCard({
      noticeId: runtime.clock.newId("notice"),
      taskId: group,
      sourceKey: "memory:test-group",
      createdAt: nowTimestamp(),
      records: [{ recordId: record.recordId, workspaceId: "default", principalId: "bob" }],
    });
    await runtime.memoryChannelCards.deliver({
      noticeId: posted.notice.noticeId,
      taskId: group,
      workspaceId: "default",
      principalId: "bob",
    });
    expect(
      channel("conn-tg")
        .sent()
        .slice(before)
        .map(textOf)
        .filter((text) => text.includes("remember")),
    ).toEqual([]);
    const [row] = posted.prompts;
    expect(
      await press("conn-tg", "bob-1", `y:${row?.token ?? ""}:k`, { externalConversationId: "group-1", conversationKind: "group" }),
    ).toBe("Memory isn't decided in group chats or by email.");
    expect(await statusOf(record.recordId)).toBe("proposed");
  }, 60_000);
});

describe("memory invariant 21: a press acts only on the presser's own records", () => {
  it("a bound non-operator keeps their own proposal from their DM; the same press against another person's record is refused as not found", async () => {
    const { channel, say, press, propose, card, statusOf, dataOf } = await composed();
    const bobChat = await say("hello", "conn-tg", "bob-1");
    const opChat = await say("hello", "conn-tg", "op-1");
    const bobs = await propose("bob", "Bob walks to work");
    await card(bobChat, "bob", [bobs.recordId]);
    const bobCard = channel("conn-tg").sent().at(-1);
    const operators = await propose("operator", "The operator cycles to work");
    await card(opChat, "operator", [operators.recordId]);
    const opCard = channel("conn-tg").sent().at(-1);
    expect(await press("conn-tg", "bob-1", dataOf(opCard, "Keep"))).toBe("That memory doesn't exist, or isn't yours.");
    expect(await press("conn-tg", "op-1", dataOf(bobCard, "Discard"))).toBe("That memory doesn't exist, or isn't yours.");
    expect(await statusOf(operators.recordId)).toBe("proposed");
    expect(await statusOf(bobs.recordId)).toBe("proposed");
    expect(await press("conn-tg", "bob-1", dataOf(bobCard, "Keep"))).toBe("Kept.");
    expect(await statusOf(bobs.recordId)).toBe("approved");
  }, 60_000);

  it("Keep pressed on the channel and in the canvas at once: one approval and one review; the loser hears Already kept", async () => {
    const { repositories, channel, say, press, propose, card, ipc, statusOf, dataOf } = await composed();
    const opChat = await say("hello", "conn-tg", "op-1");
    const record = await propose("operator", "The operator likes tea");
    await card(opChat, "operator", [record.recordId]);
    const sent = channel("conn-tg").sent().at(-1);
    const [pressed, canvas] = await Promise.allSettled([
      press("conn-tg", "op-1", dataOf(sent, "Keep")),
      ipc(
        { action: "approve", recordId: record.recordId, expectedRevisionId: record.currentRevisionId ?? "" } as MemoryPayload,
        "operator",
        true,
      ),
    ]);
    expect(await statusOf(record.recordId)).toBe("approved");
    expect(await repositories.memory.listReviews(record.recordId)).toHaveLength(1);
    const pressAnswer = pressed.status === "fulfilled" ? pressed.value : "";
    // Exactly one of them won.
    expect([pressAnswer === "Kept.", canvas.status === "fulfilled"].filter(Boolean)).toHaveLength(1);
    if (canvas.status === "fulfilled") expect(pressAnswer).toBe("Already kept.");
  }, 60_000);

  it("a card older than 7 days is not acted on", async () => {
    const { channel, say, press, propose, card, statusOf, dataOf } = await composed();
    const chat = await say("hello", "conn-tg", "bob-1");
    const record = await propose("bob", "An old one");
    await card(chat, "bob", [record.recordId], new Date(Date.now() - 8 * 86_400_000).toISOString());
    expect(await press("conn-tg", "bob-1", dataOf(channel("conn-tg").sent().at(-1), "Keep"))).toBe(
      "This card is too old to act on — open Tavi to review.",
    );
    expect(await statusOf(record.recordId)).toBe("proposed");
  }, 60_000);
});

describe("a card's proposal made after its chat read untrusted content", () => {
  const item = (recordId: string, title: string, untrusted: boolean): MemoryCardItem => ({
    token: `tok-${recordId}`,
    number: 1,
    recordId,
    state: "proposed",
    kind: "fact",
    sensitive: false,
    title,
    excerpt: title,
    ...(untrusted ? { provenance: { integrity: "untrusted" as const, sources: ["web" as const], refs: [] } } : {}),
  });

  it("goes out with every address the chat does not know defanged, as a reply's; a plain proposal as it is", () => {
    const text = "Pay at https://shop.example/pay or https://collect.attacker.example/?d=1";
    const card = { items: [item("rec-1", text, true), item("rec-2", text, false)] };
    const disarmed = disarmedMemoryCard(card, new Set(["https://shop.example/pay"]));
    const defanged = "Pay at https://shop.example/pay or hxxps[:]//collect[.]attacker[.]example/?d=1";
    expect(disarmed.items.map((entry) => [entry.title, entry.excerpt])).toEqual([
      [defanged, defanged],
      [text, text],
    ]);
    // What the channel is sent.
    expect(
      memoryCardChannelMessage(
        { title: "Remember", forgotten: 0, ...disarmedMemoryCard({ items: [item("rec-1", text, true)] }, new Set()) },
        "text",
      ).text,
    ).not.toContain("https://");
    // Nothing to disarm: the card itself.
    const plain = { items: [item("rec-3", text, false)] };
    expect(disarmedMemoryCard(plain, new Set())).toBe(plain);
  });
});
