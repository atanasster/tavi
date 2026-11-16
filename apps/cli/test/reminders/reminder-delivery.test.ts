import { join } from "node:path";

import type {
  InboundEvent,
  MemoryActor,
  MessagingCapabilities,
  OutboundMessage,
  Reminder,
  ReminderFire,
  ReminderWhen,
  SendOutcome,
} from "@tavi/contracts";
import { TaviError, reminderIdOfTaskKey, reminderTaskOperationKey, untrustedLabel } from "@tavi/contracts";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { createMessagingService } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createReminderButtons,
  createReminderDelivery,
  reminderMessageText,
  reminderReplyTarget,
  type ReminderReplyTarget,
} from "../../src/features/reminders/delivery.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * Saying a reminder where it was asked: the chat it came from, with
 * buttons; retries while the channel refuses, then the app; never a
 * conversation it may not reach; and the task a prompt starts, once.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const T = "2026-10-01T13:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T) + seconds * 1000).toISOString();

const CAPABILITIES: MessagingCapabilities = {
  receiveMode: "poll",
  send: true,
  editOrProgress: true,
  formats: ["text"],
  attachments: false,
  maxAttachmentBytes: 0,
  maxPartsPerMessage: 1,
  threads: false,
  interactions: true,
  deliveryReceipts: false,
  maxTextLength: 4096,
  approvals: "buttons",
};
const ACCEPTED: SendOutcome = { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "m-1" }] };
const REFUSED: SendOutcome = {
  status: "rejected",
  retryable: true,
  parts: [{ index: 0, status: "rejected", error: "connection is down" }],
};

async function fixture(
  options: {
    refusals?: number;
    interactions?: boolean;
    targetsFail?: boolean;
    noModel?: boolean;
    home?: boolean;
    revoked?: readonly string[];
    modelReady?: { ready: boolean };
  } = {},
) {
  const directory = directories.create("tavi-reminder-delivery-");
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  const repositories = store.asPort().repositories;
  const admit = async (taskId: string, principalId: string) =>
    repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId,
      operationKey: `op-${taskId}`,
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: taskId,
      newAdmissionId: `adm-${taskId}`,
      newThreadId: `thread-${taskId}`,
      now: "2026-10-01T12:00:00.000Z",
    });
  // Alice asked in chat-1; Bob talks to the agent in chat-2.
  await admit("t-alice", "alice");
  await admit("t-bob", "bob");
  await repositories.messagingConversations.record({
    connectionId: "conn-a",
    externalConversationId: "chat-1",
    taskId: "t-alice",
    createdAt: T,
    replyTo: { connectionId: "conn-a", externalConversationId: "chat-1", externalSenderId: "user-alice" },
  });
  await repositories.messagingConversations.record({
    connectionId: "conn-a",
    externalConversationId: "chat-2",
    taskId: "t-bob",
    createdAt: T,
    replyTo: { connectionId: "conn-a", externalConversationId: "chat-2", externalSenderId: "user-bob" },
  });

  const sent: OutboundMessage[] = [];
  const answered: { callbackId: string; text: string }[] = [];
  const edited: { messageId: string; text: string; buttons?: unknown }[] = [];
  let refusals = options.refusals ?? 0;
  const messaging = {
    send: (message: OutboundMessage) => {
      sent.push(message);
      return Promise.resolve((refusals -= 1) >= 0 ? REFUSED : ACCEPTED);
    },
    buildReplyDestination: (
      _connectionId: string,
      replyTo: { readonly externalConversationId: string; readonly externalSenderId: string },
    ) => ({ chat: replyTo.externalConversationId, to: replyTo.externalSenderId }),
    capabilitiesOf: () => (options.interactions === false ? { ...CAPABILITIES, interactions: false } : CAPABILITIES),
    answerInteraction: (_connectionId: string, callbackId: string, text: string) => {
      answered.push({ callbackId, text });
      return Promise.resolve();
    },
    editMessage: (_connectionId: string, input: { readonly messageId: string; readonly text: string; readonly buttons?: unknown }) => {
      edited.push({ messageId: input.messageId, text: input.text, ...(input.buttons === undefined ? {} : { buttons: input.buttons }) });
      return Promise.resolve(true);
    },
  };
  const diagnostics: string[] = [];
  const started: { reminderId: string; replyTo?: ReminderReplyTarget }[] = [];
  const homePosts: { text: string; taskId?: string }[] = [];
  let now = T;
  const delivery = createReminderDelivery({
    repositories,
    messaging,
    operatorTargets: (_workspaceId, principalId) =>
      options.targetsFail === true
        ? Promise.reject(new Error("routine targets are unreadable"))
        : Promise.resolve(principalId === "alice" ? [{ connectionId: "conn-a", chatId: "family-group" }] : []),
    isLocalConnection: (connectionId) => connectionId.startsWith("local:"),
    ...(options.noModel === true
      ? {}
      : {
          startTask: ({ reminder, replyTo }: { readonly reminder: Reminder; readonly replyTo?: ReminderReplyTarget }) => {
            started.push({ reminderId: reminder.reminderId, ...(replyTo === undefined ? {} : { replyTo }) });
            return Promise.resolve(`task-for-${reminder.reminderId}`);
          },
        }),
    ...(options.modelReady === undefined ? {} : { modelReady: async () => options.modelReady?.ready === true }),
    postHome: async ({ text, taskId }) => {
      homePosts.push({ text, ...(taskId === undefined ? {} : { taskId }) });
      return options.home === true;
    },
    now: () => now,
    ...(options.revoked === undefined
      ? {}
      : { ownerAllowed: (_workspaceId: string, principalId: string) => !options.revoked?.includes(principalId) }),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  const buttons = createReminderButtons({ repositories, messaging, now: () => now });
  let serial = 0;
  const create = async (
    overrides: Partial<Pick<Reminder, "principalId" | "prompt" | "deliverTo" | "originTaskId" | "text" | "label">> & {
      when?: ReminderWhen;
    } = {},
  ) => {
    serial += 1;
    return (
      await repositories.reminders.create({
        reminderId: `rem-${serial}`,
        workspaceId: "default",
        principalId: "alice",
        text: "Take your pills",
        timezone: "Europe/Berlin",
        when: { kind: "once", at: T },
        deliverTo: { kind: "conversation", connectionId: "conn-a", conversationId: "chat-1" },
        originTaskId: "t-alice",
        createdBy: "agent",
        operationKey: `op-${serial}`,
        now: "2026-10-01T12:00:00.000Z",
        ...overrides,
      })
    ).reminder;
  };
  /** Claim what is due at `when` and deliver it, recording the outcome as the scheduler does. */
  const fire = async (when: string) => {
    now = when;
    const outcomes = [];
    for (const claimed of (await repositories.reminders.claimDue({ now: when, limit: 10 })).claimed) {
      const result = await delivery.deliver(claimed);
      await repositories.reminders.recordOutcome({
        reminderId: claimed.reminder.reminderId,
        fireAt: claimed.fire.fireAt,
        outcome: result.outcome,
        ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
        ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
        now: when,
      });
      outcomes.push(result);
    }
    return outcomes;
  };
  const fires = async (reminderId: string) => repositories.reminders.fires({ workspaceId: "default", reminderId, limit: 10 });
  const press = (
    data: string,
    sender: { principalId: string; conversation?: string } = { principalId: "alice" },
  ): { actor: MemoryActor; event: InboundEvent } => ({
    actor: { principalId: sender.principalId, workspaceId: "default", caller: "messaging", authority: "operator" },
    event: {
      connectionId: "conn-a",
      providerEventId: `press-${data}-${sender.principalId}`,
      kind: "interaction",
      externalSenderId: `user-${sender.principalId}`,
      externalConversationId: sender.conversation ?? "chat-1",
      occurredAt: now,
      receivedAt: now,
      interaction: { data, callbackId: `cb-${sender.principalId}`, messageId: "m-1" },
    },
  });
  return {
    store,
    repositories,
    sent,
    answered,
    edited,
    diagnostics,
    started,
    homePosts,
    create,
    fire,
    fires,
    buttons,
    press,
    setNow: (value: string) => {
      now = value;
    },
  };
}

describe("delivering into Home", () => {
  it("says a fire as a notice in Home and starts its task with its approvals in the app, sending nothing to a chat", async () => {
    const { create, fire, sent, started, homePosts, store } = await fixture({ home: true });
    try {
      await create({ deliverTo: { kind: "home" }, prompt: "Check the train" });
      expect(await fire(at(5))).toEqual([{ outcome: "delivered", taskId: "task-for-rem-1" }]);
      expect(sent).toEqual([]);
      expect(started).toEqual([{ reminderId: "rem-1" }]);
      expect(homePosts).toEqual([{ text: "⏰ Take your pills", taskId: "task-for-rem-1" }]);
    } finally {
      await store.close();
    }
  });

  it("says it in the app when there is no Home", async () => {
    const { create, fire, homePosts, store } = await fixture({ home: false });
    try {
      await create({ deliverTo: { kind: "home" } });
      expect(await fire(at(5))).toEqual([{ outcome: "delivered-in-app" }]);
      expect(homePosts).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
});

describe("delivering to the conversation", () => {
  it("shows a revoked person's reminder in the app only: nothing to their chat, and no task", async () => {
    const { create, fire, sent, started, diagnostics, store } = await fixture({ revoked: ["alice"] });
    try {
      await create({ prompt: "Check the pharmacy hours" });
      const [outcome] = await fire(at(5));
      expect(outcome?.outcome).not.toBe("delivered");
      expect(sent).toEqual([]);
      expect(started).toEqual([]);
      expect(diagnostics).toContain("a reminder's owner is no longer allowed in its workspace; it was shown in the app only");
    } finally {
      await store.close();
    }
  });

  it("sends to the chat the reminder was asked in, with Done and Snooze buttons", async () => {
    const { create, fire, sent, fires, store } = await fixture();
    try {
      const reminder = await create();
      expect(await fire(at(5))).toEqual([{ outcome: "delivered" }]);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        connectionId: "conn-a",
        workspaceId: "default",
        destination: { chat: "chat-1", to: "user-alice" },
        parts: [{ content: "⏰ Take your pills" }],
      });
      const token = (await fires(reminder.reminderId))[0]?.token ?? "";
      expect(sent[0]?.buttons).toEqual([
        [
          { label: "✅ Done", data: `m:${token}:d` },
          { label: "⏰ Snooze 10 min", data: `m:${token}:s` },
          { label: "⏰ Snooze 1 h", data: `m:${token}:h` },
        ],
      ]);
      expect((await fires(reminder.reminderId))[0]).toMatchObject({ outcome: "delivered" });
    } finally {
      await store.close();
    }
  });

  it("disarms the words of a reminder made under taint, in the chat and in Home, and leaves a clean one's links", async () => {
    const { create, fire, sent, homePosts, store } = await fixture();
    try {
      const label = untrustedLabel("web", { ref: { ref: "call-1", host: "shop.example", at: T } });
      await create({ text: "Renew at https://evil.example/pay?u=1", label });
      await create({ text: "Renew at https://shop.example/renew", when: { kind: "once", at: at(1) } });
      await create({ text: "See https://evil.example/home", label, deliverTo: { kind: "home" } });
      await fire(at(5));
      expect(sent.map((message) => message.parts)).toEqual([
        [{ content: "⏰ Renew at hxxps[:]//evil[.]example/pay?u=1" }],
        [{ content: "⏰ Renew at https://shop.example/renew" }],
      ]);
      expect(homePosts.map((post) => post.text)).toEqual(["⏰ See hxxps[:]//evil[.]example/home"]);
    } finally {
      await store.close();
    }
  });

  it("retries a refused send with backoff, then falls back to the app after 15 minutes", async () => {
    const { create, fire, sent, fires, store } = await fixture({ refusals: 100 });
    try {
      const reminder = await create();
      expect(await fire(at(5))).toEqual([{ outcome: "retry", retryAt: at(35) }]);
      expect(await fire(at(20))).toEqual([]);
      expect(await fire(at(35))).toEqual([{ outcome: "retry", retryAt: at(95) }]);
      expect((await fires(reminder.reminderId))[0]).toMatchObject({ outcome: "pending", attempts: 2, retryUntil: at(905) });
      // Each attempt is its own outbox effect.
      expect(sent.map((message) => message.effectId)).toEqual([`reminder:rem-1:${T}:0`, `reminder:rem-1:${T}:1`]);
      let when = 95;
      for (let round = 0; round < 10; round += 1) {
        const [result] = await fire(at(when));
        if (result?.outcome !== "retry") {
          expect(result).toEqual({ outcome: "delivered-in-app" });
          break;
        }
        when = (Date.parse(result.retryAt ?? T) - Date.parse(T)) / 1000;
      }
      expect(when).toBe(905);
      expect((await fires(reminder.reminderId))[0]).toMatchObject({ outcome: "delivered-in-app" });
      expect(await fixtureUnseen(fires, reminder.reminderId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("recovers when the channel comes back within the window", async () => {
    const { create, fire, store } = await fixture({ refusals: 1 });
    try {
      await create();
      expect(await fire(at(5))).toEqual([{ outcome: "retry", retryAt: at(35) }]);
      expect(await fire(at(35))).toEqual([{ outcome: "delivered" }]);
    } finally {
      await store.close();
    }
  });

  it("sends a retry after an attempt whose result is unknown under that attempt's outbox effect, so it is not sent twice", async () => {
    const { create, fire, sent, repositories, store } = await fixture();
    try {
      const reminder = await create();
      // The first attempt began its send and then timed out: the scheduler recorded a retry.
      const [claimed] = (await repositories.reminders.claimDue({ now: at(5), limit: 10 })).claimed;
      expect(claimed).toBeDefined();
      await repositories.messagingOutbox.begin({
        effectId: `reminder:${reminder.reminderId}:${T}:0`,
        connectionId: "conn-a",
        message: {
          effectId: `reminder:${reminder.reminderId}:${T}:0`,
          connectionId: "conn-a",
          destination: {},
          parts: [{ content: "⏰ Take your pills" }],
        },
        now: { fixed: at(5) },
      });
      await repositories.reminders.recordOutcome({
        reminderId: reminder.reminderId,
        fireAt: T,
        outcome: "retry",
        retryAt: at(35),
        now: at(65),
      });
      expect(await fire(at(35))).toEqual([{ outcome: "delivered" }]);
      expect(sent.map((message) => message.effectId)).toEqual([`reminder:${reminder.reminderId}:${T}:0`]);
    } finally {
      await store.close();
    }
  });

  it("sends on the retry when the connector refused the first attempt before dispatch (not running)", async () => {
    const { create, repositories, fires, store } = await fixture();
    try {
      // The real messaging service and outbox, with a connector that is restarting for the first send.
      const dispatched: OutboundMessage[] = [];
      let running = false;
      const messaging = createMessagingService(store.asPort(), { now: () => T });
      messaging.registerConnector({
        providerId: "fixture",
        version: "1",
        configSchema: z.unknown(),
        capabilities: CAPABILITIES,
        destinationFromInbound: (replyTo) => ({ chat: replyTo.externalConversationId }),
        createConnection: () => ({
          start: async () => {},
          stop: async () => {},
          status: () => ({ state: "running", since: T }),
          probe: async () => ({ ok: true }),
          send: (message) => {
            if (!running) return Promise.reject(new TaviError("UNAVAILABLE", "connection conn-a is not running"));
            dispatched.push(message);
            return Promise.resolve(ACCEPTED);
          },
        }),
      });
      await messaging.openConnection({
        connection: {
          connectionId: "conn-a",
          providerId: "fixture",
          accountIdentity: "fixture",
          workspaceId: "default",
          configRevision: 1,
          enabled: true,
        },
        config: {},
      });
      const delivery = createReminderDelivery({
        repositories,
        messaging,
        operatorTargets: () => Promise.resolve([]),
        isLocalConnection: () => false,
        now: () => T,
      });
      const reminder = await create();
      const deliver = async (when: string) => {
        const outcomes = [];
        for (const claimed of (await repositories.reminders.claimDue({ now: when, limit: 10 })).claimed) {
          const result = await delivery.deliver(claimed);
          await repositories.reminders.recordOutcome({
            reminderId: claimed.reminder.reminderId,
            fireAt: claimed.fire.fireAt,
            outcome: result.outcome,
            ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
            now: when,
          });
          outcomes.push(result.outcome);
        }
        return outcomes;
      };
      expect(await deliver(at(5))).toEqual(["retry"]);
      running = true;
      expect(await deliver(at(35))).toEqual(["delivered"]);
      expect(dispatched.map((message) => message.effectId)).toEqual([`reminder:${reminder.reminderId}:${T}:1`]);
      expect((await fires(reminder.reminderId))[0]).toMatchObject({ outcome: "delivered" });
      await messaging.closeConnection("conn-a");
    } finally {
      await store.close();
    }
  });

  it("refuses a conversation the person never used, and sends to an operator-added target", async () => {
    const { create, fire, sent, store } = await fixture();
    try {
      // Bob's chat, for Alice.
      await create({ deliverTo: { kind: "conversation", connectionId: "conn-a", conversationId: "chat-2" } });
      expect(await fire(at(5))).toEqual([{ outcome: "delivered-in-app" }]);
      expect(sent).toEqual([]);
      await create({
        deliverTo: { kind: "conversation", connectionId: "conn-a", conversationId: "family-group" },
        when: { kind: "once", at: at(60) },
      });
      expect(await fire(at(65))).toEqual([{ outcome: "delivered" }]);
      expect(sent[0]?.destination).toEqual({ chat: "family-group", to: "family-group" });
    } finally {
      await store.close();
    }
  });

  it("retries when the chat cannot be checked, then shows the reminder in the app and starts its task there", async () => {
    const { create, fire, sent, fires, started, store } = await fixture({ targetsFail: true });
    try {
      const reminder = await create({
        prompt: "Check the car",
        deliverTo: { kind: "conversation", connectionId: "conn-a", conversationId: "family-group" },
      });
      expect(await fire(at(5))).toEqual([{ outcome: "retry", retryAt: at(35) }]);
      expect(started).toEqual([]);
      let when = 35;
      let last;
      for (let round = 0; round < 10; round += 1) {
        [last] = await fire(at(when));
        if (last?.outcome !== "retry") break;
        when = (Date.parse(last.retryAt ?? T) - Date.parse(T)) / 1000;
      }
      expect(last).toEqual({ outcome: "delivered-in-app", taskId: `task-for-${reminder.reminderId}` });
      expect(started).toEqual([{ reminderId: reminder.reminderId }]);
      expect(sent).toEqual([]);
      expect(await fixtureUnseen(fires, reminder.reminderId)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("says when it is late, and the event's time for a notice", async () => {
    const { store } = await fixture();
    try {
      const reminder = (when: ReminderWhen): Reminder => ({
        reminderId: "r",
        workspaceId: "default",
        principalId: "alice",
        text: "Dentist appointment",
        when,
        timezone: "Europe/Berlin",
        deliverTo: { kind: "app" },
        status: "active",
        nextFireAt: null,
        lastFiredAt: null,
        createdBy: "agent",
        operationKey: "k",
        createdAt: T,
        updatedAt: T,
      });
      const notice = reminder({ kind: "event", at: "2026-10-05T08:00:00.000Z", notify: ["-1h"] });
      expect(
        reminderMessageText(
          notice,
          {
            reminderId: "r",
            fireAt: "2026-10-05T07:00:00.000Z",
            firedAt: null,
            outcome: "pending",
            occurrence: "notice",
            noticeOffset: "-1h",
          },
          false,
        ),
      ).toBe("⏰ Dentist appointment — Mon 5 Oct 10:00");
      expect(
        reminderMessageText(
          reminder({ kind: "once", at: T }),
          { reminderId: "r", fireAt: T, firedAt: null, outcome: "pending", occurrence: "once" },
          true,
        ),
      ).toBe("⏰ Dentist appointment (late: was due 15:00)");
    } finally {
      await store.close();
    }
  });
});

describe("a reminder with a prompt", () => {
  it("starts its task once, with its approvals announced to the reminder's chat, and records the task on the fire", async () => {
    const { create, fire, fires, started, store } = await fixture({ refusals: 1 });
    try {
      const reminder = await create({ prompt: "Check the Frankfurt connection" });
      expect(await fire(at(5))).toEqual([{ outcome: "retry", retryAt: at(35), taskId: "task-for-rem-1" }]);
      expect(await fire(at(35))).toEqual([{ outcome: "delivered", taskId: "task-for-rem-1" }]);
      expect(started).toEqual([
        {
          reminderId: reminder.reminderId,
          replyTo: { connectionId: "conn-a", externalConversationId: "chat-1", externalSenderId: "user-alice" },
        },
      ]);
      expect((await fires(reminder.reminderId))[0]).toMatchObject({ taskId: "task-for-rem-1", outcome: "delivered" });
    } finally {
      await store.close();
    }
  });

  it("says its task was not started when no model is configured, and logs why", async () => {
    const { create, fire, sent, diagnostics, store } = await fixture({ noModel: true });
    try {
      await create({ prompt: "Check the Frankfurt connection" });
      expect(await fire(at(5))).toEqual([{ outcome: "delivered" }]);
      expect(sent[0]?.parts).toEqual([{ content: "⏰ Take your pills (task not started: no model is configured)" }]);
      expect(diagnostics).toContain("a reminder's task was not started: no model is configured");
    } finally {
      await store.close();
    }
  });

  it("reads whether a model is configured at each fire, so one added to the running owner starts the next task", async () => {
    const model = { ready: false };
    const { create, fire, sent, started, diagnostics, store } = await fixture({ modelReady: model });
    try {
      await create({ prompt: "Check the Frankfurt connection" });
      expect(await fire(at(5))).toEqual([{ outcome: "delivered" }]);
      expect(sent[0]?.parts).toEqual([{ content: "⏰ Take your pills (task not started: no model is configured)" }]);
      expect(started).toEqual([]);
      expect(diagnostics).toContain("a reminder's task was not started: no model is configured");

      model.ready = true;
      const next = await create({ prompt: "Check the Munich connection" });
      expect(await fire(at(5))).toEqual([{ outcome: "delivered", taskId: `task-for-${next.reminderId}` }]);
      expect(sent.at(-1)?.parts).toEqual([{ content: "⏰ Take your pills" }]);
      expect(started.map((entry) => entry.reminderId)).toEqual([next.reminderId]);
    } finally {
      await store.close();
    }
  });
});

describe("the buttons", () => {
  it("marks a reminder done or snoozes it for the person it is for, and ignores anyone else's press", async () => {
    const { create, fire, fires, buttons, press, answered, edited, repositories, store } = await fixture();
    try {
      const reminder = await create();
      await fire(at(5));
      const token = (await fires(reminder.reminderId))[0]?.token ?? "";

      // Bob, in Alice's chat, and Alice from another chat: neither acts.
      expect(await buttons.handleInteraction(press(`m:${token}:d`, { principalId: "bob" }))).toBe(true);
      expect(await buttons.handleInteraction(press(`m:${token}:s`, { principalId: "alice", conversation: "chat-2" }))).toBe(true);
      expect(answered.map((entry) => entry.text)).toEqual([
        "Only the person this reminder is for can use its buttons.",
        "Only the person this reminder is for can use its buttons.",
      ]);
      expect((await fires(reminder.reminderId))[0]).toMatchObject({ outcome: "delivered" });
      expect((await fires(reminder.reminderId))[0]?.acknowledgedAt).toBeUndefined();

      expect(edited).toEqual([]);
      expect(await buttons.handleInteraction(press(`m:${token}:s`))).toBe(true);
      expect(answered.at(-1)?.text).toBe("Snoozed until 15:10.");
      // The buttons give way to what the press did.
      expect(edited).toEqual([{ messageId: "m-1", text: "⏰ Take your pills\n\nSnoozed until 15:10" }]);
      expect(await repositories.reminders.get(reminder.reminderId)).toMatchObject({ status: "active", nextFireAt: at(605) });

      // The follow-up fires ten minutes on, and Done settles it.
      await fire(at(605));
      const followUp = (await fires(reminder.reminderId)).find((entry) => entry.fireAt === at(605));
      expect(await buttons.handleInteraction(press(`m:${followUp?.token ?? ""}:d`))).toBe(true);
      expect(answered.at(-1)?.text).toBe("Done.");
      expect(edited.at(-1)).toEqual({ messageId: "m-1", text: "⏰ Take your pills\n\nDone ✓" });
      expect((await fires(reminder.reminderId)).find((entry) => entry.fireAt === at(605))?.acknowledgedAt).toBe(at(605));

      // Not a reminder's press: left to the approvals.
      expect(await buttons.handleInteraction(press("r:abcdefgh:o"))).toBe(false);
    } finally {
      await store.close();
    }
  });
});

async function fixtureUnseen(fires: (reminderId: string) => Promise<readonly ReminderFire[]>, reminderId: string): Promise<boolean> {
  return (await fires(reminderId)).some((fire) => fire.outcome === "delivered-in-app" && fire.acknowledgedAt === undefined);
}

describe("a reminder task's key", () => {
  it("names the reminder it was started for, and nothing else", () => {
    expect(reminderIdOfTaskKey(reminderTaskOperationKey("rem-1:odd", T))).toBe("rem-1:odd");
    for (const key of [null, "reminder:", `reminder:${T}`, "reminder:rem-1:not-a-time-at-all-here", "schedule:s:x", `rem-1:${T}`]) {
      expect(reminderIdOfTaskKey(key)).toBeUndefined();
    }
  });
});

describe("a reminder asked in a forum topic's side chat", () => {
  it("is said back in that topic of its group", async () => {
    const origin = {
      connectionId: "telegram-w1",
      externalConversationId: "-100#topic:7",
      taskId: "side-1",
      createdAt: T,
      epoch: 0,
      replyTo: { connectionId: "telegram-w1", externalConversationId: "-100", externalSenderId: "9", externalThreadId: "7" },
    };
    const deps = {
      repositories: {
        messagingConversations: {
          getByTask: async (taskId: string) => (taskId === "side-1" ? origin : undefined),
          get: async () => undefined,
        },
        tasks: { get: async () => undefined },
      } as never,
      operatorTargets: async () => [],
      isLocalConnection: (connectionId: string) => connectionId.startsWith("local-"),
    };
    expect(
      await reminderReplyTarget(deps, { workspaceId: "w1", principalId: "alice", originTaskId: "side-1" }, "telegram-w1", "-100"),
    ).toEqual({
      connectionId: "telegram-w1",
      externalConversationId: "-100",
      externalSenderId: "9",
      externalThreadId: "7",
    });
    // Another group is not that topic's.
    expect(
      await reminderReplyTarget(deps, { workspaceId: "w1", principalId: "alice", originTaskId: "side-1" }, "telegram-w1", "-200"),
    ).toBeUndefined();
  });
});
