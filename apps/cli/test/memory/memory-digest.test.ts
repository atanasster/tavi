import {
  TaviError,
  instantForLocalTime,
  localDateTime,
  type InboundEvent,
  type MemoryActor,
  type MemoryCardAllAnswer,
  type MemoryCardAnswer,
  type MemoryItem,
  type MemoryPayload,
  type ModelPort,
  type OutboundButton,
  type OutboundMessage,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, waitForValue, delay } from "@tavi/test-support";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { afterEach, describe, expect, it } from "vitest";

import { channelDescriptorOf, registerChannelDescriptor, unregisterChannelDescriptor } from "../../src/features/channels/catalog.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { memoryCommand } from "../../src/features/memory/owner.js";
import { createMemoryDigest, localDateKey, memoryDigestDue } from "../../src/features/memory/digest.js";
import { buildDoctorDocument } from "../../src/features/doctor/reports.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The review digest before proposals expire: weekly, or sooner when a proposal nears expiry that no
 * digest showed yet; at the first tick after 09:00 in the workspace's
 * timezone; at most once a local day per chat, a restart included; to the
 * operator's Home and direct targets, and to another person's direct chat;
 * ten titles at most, sensitive ones unnamed; *Keep all* keeps plain proposals only.
 */

const DAY_MS = 86_400_000;

const directories = temporaryDirectories({ prefix: "tavi-memory-digest-" });
const runtimes: TaviRuntime[] = [];
const descriptors: string[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
  while (descriptors.length > 0) unregisterChannelDescriptor(descriptors.pop() ?? "");
});

const quietModel: ModelPort = {
  async stream(request) {
    return {
      attemptId: request.attemptId,
      status: "completed" as const,
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      text: "Done.",
    };
  },
};

const OPERATOR = { workspaceId: "default", principalId: "operator" };
let counter = 0;

interface Channel {
  readonly sent: () => readonly OutboundMessage[];
  readonly answers: string[];
  readonly edits: { readonly messageId: string; readonly text: string; readonly buttons?: readonly (readonly OutboundButton[])[] }[];
}

/** A composed owner with a channel that has buttons and edits, and email; Bob is a person of the workspace with a Telegram DM. */
async function composed(
  input: { readonly dataDirectory?: string; readonly memoryTiming?: { readonly tickMs?: number; readonly now?: () => Date } } = {},
) {
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(input.dataDirectory ?? directories.create(), {
      workspaces: [{ ...OPERATOR, permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      approvalRequiredFor: [],
      memoryHostEnabled: true,
    }),
    { modelOverride: quietModel, memoryTiming: input.memoryTiming ?? { tickMs: 3_600_000 } },
  );
  runtimes.push(runtime);
  const repositories = runtime.store.asPort().repositories;
  if (channelDescriptorOf("fixture-mail-digest") === undefined) {
    const mail = {
      ...(channelDescriptorOf("mailgun") ??
        (() => {
          throw new Error("no email descriptor");
        })()),
      providerId: "fixture-mail-digest",
    };
    registerChannelDescriptor(mail);
    descriptors.push(mail.providerId);
  }
  const channels = new Map<string, Channel>();
  for (const [providerId, connectionId, capabilities] of [
    ["fixture-buttons", "conn-tg", { interactions: true, editOrProgress: true }],
    ["fixture-mail-digest", "conn-mail", {}],
  ] as const) {
    const answers: string[] = [];
    const edits: Channel["edits"] = [];
    let instance: FixtureMessagingConnectorInstance | undefined;
    let sends = 0;
    const fixture = createFixtureMessagingConnectorDefinition({
      providerId,
      capabilities,
      sendOutcome: () => ({
        status: "accepted",
        retryable: false,
        parts: [{ index: 0, status: "accepted", providerMessageId: `msg-${(sends += 1)}` }],
      }),
      onInstanceCreated: (created) => {
        instance = created;
      },
    });
    runtime.messaging.registerConnector({
      ...fixture,
      destinationFromInbound: (replyTo) => ({ fixtureChat: replyTo.externalConversationId }),
      createConnection: (created) => {
        const made = fixture.createConnection(created) as FixtureMessagingConnectorInstance & Record<string, unknown>;
        if (capabilities.interactions === true)
          made["answerInteraction"] = async (_callbackId: string, text: string) => {
            answers.push(text);
          };
        if (capabilities.editOrProgress === true)
          made["editMessage"] = async (edit: Channel["edits"][number]) => {
            edits.push({ messageId: edit.messageId, text: edit.text, ...(edit.buttons === undefined ? {} : { buttons: edit.buttons }) });
          };
        return made;
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
  for (const [connectionId, sender, principalId] of [
    ["conn-tg", "bob-1", "bob"],
    ["conn-tg", "op-1", "operator"],
    ["conn-mail", "op@example.com", "operator"],
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
  /** A chat of `principalId`'s, its first turn run; a Home when `chatKind` says so. */
  const admit = async (id: string, principalId: string, chatKind?: "home"): Promise<string> => {
    const workflow =
      runtime.workflow ??
      (() => {
        throw new Error("no workflow");
      })();
    // Begun in the canvas, as an attended chat is.
    const result = await workflow.admit({
      context: { workspaceId: "default", principalId, runId: "pending-admission", caller: "test" },
      operationKey: id,
      kind: "start",
      prompt: id,
      origin: "web",
      ...(chatKind === undefined ? {} : { chatKind }),
    });
    return result.taskId;
  };
  const channel = (connectionId: string): Channel => channels.get(connectionId) as Channel;
  const modelActor = (principalId: string): MemoryActor => ({ workspaceId: "default", principalId, caller: "agent", authority: "model" });
  /** A proposal by the model for `principalId`, a few milliseconds after the last, so their order is their age. */
  const propose = async (principalId: string, body: string, sensitive = false) => {
    await delay(3);
    return await runtime.memory.propose({
      actor: modelActor(principalId),
      scope: { kind: "personal", principalId },
      kind: "fact",
      title: body,
      body,
      ...(sensitive ? { sensitivity: "sensitive" as const } : {}),
    });
  };
  const ipc = async <T>(payload: MemoryPayload, principalId = "operator"): Promise<T> => {
    const answer = await memoryCommand(
      {
        memory: runtime.memory,
        repositories,
        principalOf: () => principalId,
        fromBridge: true,
        now: () => new Date(),
        newId: (prefix) => runtime.clock.newId(prefix),
      },
      payload,
    );
    if (!answer.ok) throw new TaviError(answer.error.code as never, answer.error.message);
    return answer.result as T;
  };
  const press = async (connectionId: string, sender: string, data: string): Promise<string> => {
    const answers = channel(connectionId).answers;
    const before = answers.length;
    counter += 1;
    await runtime.messaging.ingest({
      connectionId,
      providerEventId: `evt-${counter}`,
      kind: "interaction",
      externalSenderId: sender,
      externalConversationId: sender,
      conversationKind: "direct",
      occurredAt: nowTimestamp(),
      receivedAt: nowTimestamp(),
      interaction: { data, callbackId: `cb-${counter}`, messageId: "msg-1" },
    } as InboundEvent);
    await waitForValue(async () => (answers.length > before ? true : undefined));
    return answers.at(-1) ?? "";
  };
  const setTimezone = async (timezone: string) => {
    const current = await repositories.workspaceSettings.get("default");
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { ...current.settings, timezone },
      expectedRevision: current.revision,
      actor: "operator",
      now: nowTimestamp(),
    });
  };
  const setMemory = async (memory: Record<string, unknown>) => {
    const current = await repositories.workspaceSettings.get("default");
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { ...current.settings, memory },
      expectedRevision: current.revision,
      actor: "operator",
      now: nowTimestamp(),
    });
  };
  /** The digest cards posted in a chat, oldest first, as rendered now. */
  const digests = async (taskId: string): Promise<readonly MemoryCardAnswer[]> => {
    const cards: MemoryCardAnswer[] = [];
    for (const notice of (await repositories.transcripts.notices(taskId, { limit: 100 })).filter((each) => each.kind === "memory")) {
      const card = await ipc<MemoryCardAnswer>(
        { action: "card", noticeId: notice.noticeId } as MemoryPayload,
        (await repositories.tasks.get(taskId))?.principalId ?? "operator",
      );
      if (card.digest !== undefined) cards.push(card);
    }
    return cards;
  };
  /** A digest driven by a clock the test moves, sending to the operator's targets as the owner would. */
  const clock = { now: new Date() };
  const digest = createMemoryDigest({
    memory: runtime.memory,
    repositories,
    workspaces: () => [OPERATOR],
    memorySettings: runtime.memorySettings,
    timezoneOf: async () => (await repositories.workspaceSettings.get("default")).settings.timezone ?? "UTC",
    // A group target too, bound to nobody: the operator's memory titles never reach it.
    operatorTargets: async () => [
      { connectionId: "conn-tg", chatId: "op-1" },
      { connectionId: "conn-tg", chatId: "-100group" },
      { connectionId: "conn-mail", chatId: "op@example.com" },
    ],
    deliver: (card) => runtime.memoryChannelCards.deliver(card),
    newId: (prefix) => runtime.clock.newId(prefix),
    now: () => clock.now,
    log: () => {},
  });
  /** The instant `days` local days after today at `hour`:`minute` in `timezone`. */
  const localAt = (days: number, hour: number, minute: number, timezone: string): Date => {
    const today = localDateTime(new Date(), timezone);
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + days));
    return instantForLocalTime({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute }, timezone);
  };
  return { runtime, repositories, channel, admit, propose, ipc, press, setTimezone, setMemory, digests, digest, clock, localAt };
}

const textOf = (message: OutboundMessage | undefined): string => (message?.parts[0] as { content?: string } | undefined)?.content ?? "";
const buttonsOf = (message: OutboundMessage | undefined) => (message?.buttons ?? []).flat();
const dataOf = (message: OutboundMessage | undefined, label: string): string =>
  buttonsOf(message).find((button) => button.label === label)?.data ?? "";

describe("when a digest is due", () => {
  const item = (recordedAt: string, expiresAt: string): Pick<MemoryItem, "recordedAt" | "expiresAt"> => ({ recordedAt, expiresAt });
  const now = new Date("2026-10-20T09:30:00.000Z");

  it("never with nothing waiting; first with anything waiting; then weekly", () => {
    expect(memoryDigestDue({ today: "2026-10-20", now, last: undefined, waiting: [] })).toBe(false);
    const waiting = [item("2026-10-19T10:00:00.000Z", "2026-11-18T10:00:00.000Z")];
    expect(memoryDigestDue({ today: "2026-10-20", now, last: undefined, waiting })).toBe(true);
    expect(memoryDigestDue({ today: "2026-10-20", now, last: { mark: "2026-10-20", at: "2026-10-20T09:00:00.000Z" }, waiting })).toBe(
      false,
    );
    expect(memoryDigestDue({ today: "2026-10-20", now, last: { mark: "2026-10-14", at: "2026-10-14T09:00:00.000Z" }, waiting })).toBe(
      false,
    );
    expect(memoryDigestDue({ today: "2026-10-20", now, last: { mark: "2026-10-13", at: "2026-10-13T09:00:00.000Z" }, waiting })).toBe(true);
  });

  it("not for a proposal made within the hour, whose own card was just shown", () => {
    const fresh = [item("2026-10-20T09:29:57.000Z", "2026-10-27T09:29:57.000Z")];
    expect(memoryDigestDue({ today: "2026-10-20", now, last: undefined, waiting: fresh })).toBe(false);
    expect(
      memoryDigestDue({ today: "2026-10-20", now, last: { mark: "2026-10-13", at: "2026-10-13T09:00:00.000Z" }, waiting: fresh }),
    ).toBe(false);
    // An hour on, it is due as any other.
    const later = new Date("2026-10-20T10:30:00.000Z");
    expect(memoryDigestDue({ today: "2026-10-20", now: later, last: undefined, waiting: fresh })).toBe(true);
  });

  it("sooner for a proposal within 7 days of expiry proposed after the last digest, and never for one a digest already showed", () => {
    const last = { mark: "2026-10-18", at: "2026-10-18T09:00:00.000Z" };
    // Shown in the last digest, now near expiry: the near-expiry rule sends no second digest for it.
    expect(
      memoryDigestDue({ today: "2026-10-20", now, last, waiting: [item("2026-10-01T10:00:00.000Z", "2026-10-25T10:00:00.000Z")] }),
    ).toBe(false);
    // Proposed since, and near expiry (a 7-day window): the next morning's digest brings it.
    expect(
      memoryDigestDue({ today: "2026-10-20", now, last, waiting: [item("2026-10-19T10:00:00.000Z", "2026-10-26T10:00:00.000Z")] }),
    ).toBe(true);
    // Proposed since, but far from expiry: it waits for the weekly one.
    expect(
      memoryDigestDue({ today: "2026-10-20", now, last, waiting: [item("2026-10-19T10:00:00.000Z", "2026-11-18T10:00:00.000Z")] }),
    ).toBe(false);
  });
});

describe("the review digest", () => {
  it("is not sent with nothing waiting, nor before 09:00", async () => {
    const { runtime, repositories, admit, propose, digest, clock, localAt, digests } = await composed();
    const home = await admit("home", "operator", "home");
    clock.now = localAt(1, 10, 0, "UTC");
    await digest.tick();
    expect(await digests(home)).toEqual([]);
    expect(await repositories.transcripts.lastMemoryMark({ taskId: home, kind: "digest" })).toBeUndefined();
    await propose("operator", "I like tea");
    clock.now = localAt(1, 8, 59, "UTC");
    await digest.tick();
    expect(await digests(home)).toEqual([]);
    clock.now = localAt(1, 9, 0, "UTC");
    await digest.tick();
    expect(await digests(home)).toHaveLength(1);
    // Doctor: the digest on, and when each person's last went out.
    expect((await buildDoctorDocument(runtime, { integrity: "skip" })).memory["digest"]).toEqual({
      digest: "weekly",
      lastSent: [{ principalId: "operator", taskId: home, at: clock.now.toISOString() }],
    });
  }, 60_000);

  it("memory invariant 18: a proposal appears in a digest before its window runs out — weekly, with no second digest from the near-expiry rule once 24 days old", async () => {
    const { admit, propose, digest, clock, localAt, digests } = await composed();
    const home = await admit("home", "operator", "home");
    const record = await propose("operator", "I cycle to work");
    const expiresAt = Date.parse(record.recordedAt) + 30 * DAY_MS;
    const sentOn: number[] = [];
    for (let day = 1; localAt(day, 10, 0, "UTC").getTime() < expiresAt; day += 1) {
      clock.now = localAt(day, 10, 0, "UTC");
      const before = (await digests(home)).length;
      await digest.tick();
      if ((await digests(home)).length > before) sentOn.push(day);
    }
    // Weekly from the first morning; from day 23 it is within 7 days of expiry, but every digest since showed it.
    expect(sentOn).toEqual([1, 8, 15, 22, 29].filter((day) => localAt(day, 10, 0, "UTC").getTime() < expiresAt));
    const all = await digests(home);
    expect(all.every((card) => card.items.some((each) => each.recordId === record.recordId))).toBe(true);
    // At 24 days old it has already been in a digest, and none came that day.
    expect(sentOn.some((day) => day <= 24)).toBe(true);
    expect(sentOn.filter((day) => day > 22 && day < 29)).toEqual([]);
  }, 120_000);

  it("a proposal made since the last digest and close to expiry brings the next morning's digest forward", async () => {
    const { repositories, admit, propose, setMemory, setTimezone, digest, clock, localAt, digests } = await composed();
    const home = await admit("home", "operator", "home");
    // A zone where it is past 09:00 now, so the first digest can go out just before the second proposal is made.
    const zone =
      ["UTC", "Asia/Tokyo", "America/New_York", "Asia/Kolkata", "Pacific/Auckland", "America/Los_Angeles", "Europe/Berlin"].find(
        (timezone) => {
          const hour = localDateTime(new Date(Date.now() - 60_000), timezone).hour;
          return hour >= 9 && hour <= 22;
        },
      ) ?? "UTC";
    await setTimezone(zone);
    // A 7-day window: every new proposal is near its expiry.
    await setMemory({ limits: { proposalDays: 7 } });
    await propose("operator", "First");
    clock.now = new Date(Date.now() - 60_000);
    await digest.tick();
    // A proposal made within the hour brings no digest: its own card was just shown.
    expect(await digests(home)).toHaveLength(0);
    // Today's digest went out a minute ago (as it would have for something older): marked as the tick marks it.
    const today = localDateTime(clock.now, zone);
    await repositories.transcripts.claimMemoryMark({
      taskId: home,
      kind: "digest",
      mark: localDateKey(today),
      at: clock.now.toISOString(),
    });
    await propose("operator", "Second");
    // The next morning is a day after the last digest, not a week: only the near-expiry rule sends this one.
    clock.now = localAt(1, 9, 30, zone);
    await digest.tick();
    const [next] = await digests(home);
    expect(next?.items.map((item) => item.title)).toEqual(["First", "Second"]);
  }, 60_000);

  it("follows the workspace timezone's 09:00", async () => {
    const { admit, propose, setTimezone, digest, clock, localAt, digests } = await composed();
    const home = await admit("home", "operator", "home");
    await propose("operator", "I like jazz");
    await setTimezone("Asia/Tokyo");
    // 08:30 in Tokyo is 23:30 the day before in UTC: not yet.
    clock.now = localAt(2, 8, 30, "Asia/Tokyo");
    expect(localDateTime(clock.now, "UTC").hour).toBe(23);
    await digest.tick();
    expect(await digests(home)).toEqual([]);
    // 09:05 in Tokyo, 00:05 in UTC: due.
    clock.now = localAt(2, 9, 5, "Asia/Tokyo");
    await digest.tick();
    expect(await digests(home)).toHaveLength(1);
  }, 60_000);

  it("is not sent with digest off, and is sent while memory is paused", async () => {
    const { admit, propose, setMemory, digest, clock, localAt, digests } = await composed();
    const home = await admit("home", "operator", "home");
    await propose("operator", "I like jazz");
    await setMemory({ digest: "off" });
    clock.now = localAt(1, 10, 0, "UTC");
    await digest.tick();
    expect(await digests(home)).toEqual([]);
    await setMemory({ enabled: false });
    await digest.tick();
    expect(await digests(home)).toHaveLength(1);
  }, 60_000);

  it("memory invariant 22: lists ten titles at most, oldest expiry first, a sensitive one unnamed, and says how many more — on Home and the operator's direct targets, email with no actions", async () => {
    const { repositories, channel, admit, propose, digest, clock, localAt, digests } = await composed();
    const home = await admit("home", "operator", "home");
    await propose("operator", "My diagnosis is private", true);
    for (let index = 1; index <= 11; index += 1) await propose("operator", `Fact ${index}`);
    clock.now = localAt(1, 10, 0, "UTC");
    await digest.tick();
    const [card] = await digests(home);
    expect(card?.title).toMatch(/^10 of 12 things waiting to be remembered — the oldest expires \w{3} \d{1,2} \w{3}$/);
    expect(card?.digest).toEqual({ waiting: 12 });
    expect(card?.items.map((item) => (item.sensitive ? "sensitive" : item.title))).toEqual([
      "sensitive",
      ...Array.from({ length: 9 }, (_, index) => `Fact ${index + 1}`),
    ]);
    // The notice holds counts and a date; its rows hold ids.
    const notice = (await repositories.transcripts.notices(home, { limit: 10 })).find((each) => each.noticeId === card?.noticeId);
    expect(JSON.stringify(notice)).not.toMatch(/Fact|diagnosis/);
    const tg = channel("conn-tg").sent().at(-1);
    expect(tg?.destination).toEqual({ fixtureChat: "op-1" });
    expect(
      channel("conn-tg")
        .sent()
        .filter((message) => JSON.stringify(message.destination).includes("-100group")),
    ).toEqual([]);
    expect(textOf(tg).split("\n")).toEqual([
      card?.title,
      "1. Sensitive item — open Tavi to review",
      ...Array.from({ length: 9 }, (_, index) => `${index + 2}. Fact ${index + 1}`),
      "and 2 more — Review",
    ]);
    expect(buttonsOf(tg).map((button) => button.label)).toEqual(["Keep all", "Discard all", "Review"]);
    expect(JSON.stringify(channel("conn-tg").sent())).not.toContain("diagnosis");
    const mail = channel("conn-mail").sent().at(-1);
    expect(buttonsOf(mail)).toEqual([]);
    expect(textOf(mail)).toContain("Open Tavi to review.");
    expect(textOf(mail)).not.toContain("/memory");
  }, 60_000);

  it("goes to another person's direct chat, whose Keep all keeps exactly the listed plain ones; a listed sensitive one waits, and the receipt's Undo forgets exactly those kept", async () => {
    const { repositories, runtime, channel, admit, propose, press, digest, clock, localAt, digests } = await composed();
    const dm = await admit("bob-dm", "bob");
    await repositories.messagingConversations.record({
      connectionId: "conn-tg",
      externalConversationId: "bob-1",
      taskId: dm,
      createdAt: nowTimestamp(),
      conversationKind: "direct",
      replyTo: { connectionId: "conn-tg", externalConversationId: "bob-1", externalSenderId: "bob-1" },
    });
    const first = await propose("bob", "Bob walks to work");
    const second = await propose("bob", "Bob likes rain");
    const secret = await propose("bob", "Bob's diagnosis", true);
    clock.now = localAt(1, 10, 0, "UTC");
    await digest.tick();
    expect(await digests(dm)).toHaveLength(1);
    const sent = channel("conn-tg").sent().at(-1);
    expect(textOf(sent)).toMatch(/^3 things waiting to be remembered/);
    // More arrives after the digest went out: Keep all does not take it.
    const later = await propose("bob", "Bob arrived later");
    expect(await press("conn-tg", "bob-1", dataOf(sent, "Keep all"))).toBe("Kept 2 · 1 needs a look — open Tavi to review.");
    const status = async (recordId: string) => (await repositories.memory.getRecord(recordId))?.status;
    expect([
      await status(first.recordId),
      await status(second.recordId),
      await status(secret.recordId),
      await status(later.recordId),
    ]).toEqual(["approved", "approved", "proposed", "proposed"]);
    const receipt = channel("conn-tg").sent().at(-1);
    expect(textOf(receipt)).toBe("Saved · 2\n1. Bob walks to work — saved\n2. Bob likes rain — saved");
    expect(await press("conn-tg", "bob-1", dataOf(receipt, "Undo"))).toBe("Forgotten 2.");
    expect([
      await status(first.recordId),
      await status(second.recordId),
      await status(secret.recordId),
      await status(later.recordId),
    ]).toEqual(["deleted", "deleted", "proposed", "proposed"]);
    // The operator got none of Bob's.
    expect(await runtime.store.asPort().repositories.tasks.homeOf("default", "operator")).toBeUndefined();
  }, 60_000);

  it("in the app: Keep all keeps the listed plain ones and posts a Saved receipt; Discard all discards the rest", async () => {
    const { repositories, admit, propose, ipc, digest, clock, localAt, digests } = await composed();
    const home = await admit("home", "operator", "home");
    const plain = await propose("operator", "I like tea");
    const secret = await propose("operator", "My salary", true);
    clock.now = localAt(1, 10, 0, "UTC");
    await digest.tick();
    const [card] = await digests(home);
    const kept = await ipc<MemoryCardAllAnswer>({ action: "card-all", noticeId: card?.noticeId ?? "", decision: "keep" } as MemoryPayload);
    expect(kept).toMatchObject({ kept: 1, discarded: 0, needsLook: 1, receiptNoticeId: expect.any(String) });
    const receipt = await ipc<MemoryCardAnswer>({ action: "card", noticeId: kept.receiptNoticeId ?? "" } as MemoryPayload);
    expect(receipt.items.map((item) => [item.recordId, item.state])).toEqual([[plain.recordId, "saved"]]);
    expect((await repositories.memory.getRecord(secret.recordId))?.status).toBe("proposed");
    // The digest now says what is left, still as a digest.
    const after = await ipc<MemoryCardAnswer>({ action: "card", noticeId: card?.noticeId ?? "" } as MemoryPayload);
    expect(after.items.map((item) => item.state)).toEqual(["saved", "proposed"]);
    expect(
      await ipc<MemoryCardAllAnswer>({ action: "card-all", noticeId: card?.noticeId ?? "", decision: "discard" } as MemoryPayload),
    ).toEqual({ kept: 0, discarded: 1, needsLook: 0 });
    expect((await repositories.memory.getRecord(secret.recordId))?.status).toBe("rejected");
    // Nothing waits: a second Keep all keeps nothing and posts no receipt.
    expect(
      await ipc<MemoryCardAllAnswer>({ action: "card-all", noticeId: card?.noticeId ?? "", decision: "keep" } as MemoryPayload),
    ).toEqual({ kept: 0, discarded: 0, needsLook: 0 });
  }, 60_000);

  it("a post that fails is tried again at the next tick, its mark claimed only once the card is posted", async () => {
    const { runtime, repositories, admit, propose, clock, localAt, digests } = await composed();
    const home = await admit("home", "operator", "home");
    const transcripts = repositories.transcripts;
    let failures = 1;
    const failing = createMemoryDigest({
      memory: runtime.memory,
      repositories: {
        ...repositories,
        transcripts: {
          getNotice: (...args) => transcripts.getNotice(...args),
          memoryPrompts: (...args) => transcripts.memoryPrompts(...args),
          page: (...args) => transcripts.page(...args),
          claimMemoryMark: (...args) => transcripts.claimMemoryMark(...args),
          memoryMarksOf: (...args) => transcripts.memoryMarksOf(...args),
          memoryReviewChats: (...args) => transcripts.memoryReviewChats(...args),
          postMemoryCard: async (...args) => {
            if (failures > 0) {
              failures -= 1;
              throw new TaviError("INVALID_INPUT", "the card could not be posted");
            }
            return await transcripts.postMemoryCard(...args);
          },
        },
      },
      workspaces: () => [OPERATOR],
      memorySettings: runtime.memorySettings,
      timezoneOf: async () => "UTC",
      operatorTargets: async () => [],
      deliver: (card) => runtime.memoryChannelCards.deliver(card),
      newId: (prefix) => runtime.clock.newId(prefix),
      now: () => clock.now,
      log: () => {},
    });
    await propose("operator", "First");
    clock.now = localAt(1, 10, 0, "UTC");
    await failing.tick();
    expect(await digests(home)).toEqual([]);
    expect(await repositories.transcripts.lastMemoryMark({ taskId: home, kind: "digest" })).toBeUndefined();
    clock.now = localAt(1, 10, 1, "UTC");
    await failing.tick();
    const [card] = await digests(home);
    expect(card?.items.map((item) => item.title)).toEqual(["First"]);
    expect(await repositories.transcripts.lastMemoryMark({ taskId: home, kind: "digest" })).toEqual({
      mark: localAt(1, 10, 1, "UTC").toISOString().slice(0, 10),
      at: clock.now.toISOString(),
    });
  }, 60_000);

  it("skips a Home whose memory is off", async () => {
    const { repositories, admit, propose, digest, clock, localAt, digests } = await composed();
    const home = await admit("home", "operator", "home");
    await repositories.tasks.setMemoryMode({ taskId: home, mode: "off", now: nowTimestamp() });
    await propose("operator", "I like tea");
    clock.now = localAt(1, 10, 0, "UTC");
    await digest.tick();
    expect(await digests(home)).toEqual([]);
  }, 60_000);

  it("memory invariant 18: without a Home (off by default), the operator's digest goes to their latest chat whose memory is on, and on to their targets — once a day, weekly, wherever it went", async () => {
    const { repositories, admit, propose, digest, clock, localAt, digests, channel } = await composed();
    const older = await admit("older", "operator");
    const off = await admit("off", "operator");
    await repositories.tasks.setMemoryMode({ taskId: off, mode: "off", now: nowTimestamp() });
    expect(await repositories.tasks.homeOf("default", "operator")).toBeUndefined();
    await propose("operator", "I like tea");
    clock.now = localAt(1, 10, 0, "UTC");
    await digest.tick();
    // The memory-off chat is newer, but gets nothing: the digest goes to the newest chat whose memory is on.
    expect(await digests(off)).toEqual([]);
    expect(await digests(older)).toHaveLength(1);
    expect(
      channel("conn-tg")
        .sent()
        .some((message) => message.destination !== undefined && JSON.stringify(message.destination).includes("op-1")),
    ).toBe(true);
    // A newer chat the same day, and the days after: no second digest until a week has passed.
    const newer = await admit("newer", "operator");
    for (const day of [1, 2, 7]) {
      clock.now = localAt(day, 11, 0, "UTC");
      await digest.tick();
    }
    expect(await digests(newer)).toEqual([]);
    expect(await digests(older)).toHaveLength(1);
    clock.now = localAt(8, 10, 0, "UTC");
    await digest.tick();
    expect(await digests(newer)).toHaveLength(1);
    expect(await digests(older)).toHaveLength(1);
  }, 60_000);
});

describe("a digest listing a tidy-up", () => {
  /** Two kept records of the operator's, and a tidy-up that merges them, waiting. */
  const tidyUp = async (runtime: TaviRuntime) => {
    const actor: MemoryActor = { workspaceId: "default", principalId: "operator", caller: "cli", authority: "operator" };
    const scope = { kind: "personal" as const, principalId: "operator" };
    const first = await runtime.memory.remember({ actor, scope, kind: "fact", title: "Keeps a garden", body: "Keeps a vegetable garden" });
    const second = await runtime.memory.remember({
      actor,
      scope,
      kind: "fact",
      title: "Grows tomatoes",
      body: "Grows tomatoes in the garden",
    });
    const tidy = await runtime.memory.propose({
      actor,
      scope,
      kind: "fact",
      title: "Garden and tomatoes",
      body: "Keeps a vegetable garden and grows tomatoes in it",
      supersedes: [first, second].map((record) => ({ recordId: record.recordId, revisionId: record.currentRevisionId ?? "" })),
    });
    return { first, second, tidy };
  };

  it("memory invariant 18: lists a waiting tidy-up by title, marked to compare in Tavi; its Keep all leaves it waiting, and none is offered once only it waits", async () => {
    const { runtime, repositories, channel, admit, propose, ipc, press, digest, clock, localAt, digests } = await composed();
    const home = await admit("home", "operator", "home");
    const { tidy } = await tidyUp(runtime);
    const plain = await propose("operator", "I like tea");
    clock.now = localAt(1, 10, 0, "UTC");
    await digest.tick();
    const [card] = await digests(home);
    const listed = card?.items.find((item) => item.recordId === tidy.recordId);
    expect(listed).toMatchObject({ title: "Garden and tomatoes", tidyUp: true });
    const sent = channel("conn-tg")
      .sent()
      .find((message) => JSON.stringify(message.destination).includes("op-1"));
    expect(textOf(sent)).toContain(`${listed?.number}. Garden and tomatoes — tidy-up, open Tavi to compare`);
    expect(buttonsOf(sent).map((button) => button.label)).toEqual(["Keep all", "Discard all", "Review"]);
    expect(await press("conn-tg", "op-1", dataOf(sent, "Keep all"))).toBe("Kept 1 · 1 needs a look — open Tavi to review.");
    expect((await repositories.memory.getRecord(tidy.recordId))?.status).toBe("proposed");
    expect((await repositories.memory.getRecord(plain.recordId))?.status).toBe("approved");
    // Only the tidy-up waits now: no Keep all is offered, in the app or the edited message.
    expect(
      await ipc<MemoryCardAllAnswer>({ action: "card-all", noticeId: card?.noticeId ?? "", decision: "keep" } as MemoryPayload),
    ).toEqual({ kept: 0, discarded: 0, needsLook: 1 });
    expect(
      channel("conn-tg")
        .edits.at(-1)
        ?.buttons?.flat()
        .map((button) => button.label),
    ).toEqual(["Discard all", "Review"]);
  }, 60_000);

  it("memory invariant 9: forgetting one of its inputs edits the delivered digest, which no longer lists the tidy-up's words, and names the channel it cannot edit", async () => {
    const { runtime, channel, admit, ipc, digest, clock, localAt } = await composed();
    await admit("home", "operator", "home");
    const { first, tidy } = await tidyUp(runtime);
    clock.now = localAt(1, 10, 0, "UTC");
    await digest.tick();
    const tg = channel("conn-tg");
    expect(textOf(tg.sent().find((message) => JSON.stringify(message.destination).includes("op-1")))).toContain("Garden and tomatoes");
    expect(textOf(channel("conn-mail").sent().at(-1))).toContain("Garden and tomatoes");
    // The email's message cannot be edited: the receipt names it, read before the forget as every surface reads it.
    expect((await runtime.memoryChannelCards.beforeForget(first.recordId)).unreached).toHaveLength(1);
    await ipc({ action: "forget", recordId: first.recordId, reason: "test" } as MemoryPayload);
    expect((await runtime.store.asPort().repositories.memory.getRecord(tidy.recordId))?.status).toBe("deleted");
    const edit = await waitForValue(async () => tg.edits.at(-1));
    expect(edit.text).not.toContain("Garden and tomatoes");
    expect(edit.buttons).toBeUndefined();
  }, 60_000);
});

describe("the tavi.memory tick", () => {
  it("sends the digest on its own, and a restart does not repeat it", async () => {
    const dataDirectory = directories.create();
    const tomorrow = (() => {
      const today = localDateTime(new Date(), "UTC");
      return new Date(Date.UTC(today.year, today.month - 1, today.day + 1, 10, 0));
    })();
    const first = await composed({ dataDirectory, memoryTiming: { tickMs: 20, now: () => tomorrow } });
    await first.setTimezone("UTC");
    const home = await first.admit("home", "operator", "home");
    await first.propose("operator", "I like tea");
    await waitForValue(async () => ((await first.digests(home)).length === 1 ? true : undefined));
    await first.runtime.close();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);
    const second = await composed({ dataDirectory, memoryTiming: { tickMs: 20, now: () => tomorrow } });
    // Many ticks later, still the one digest.
    await delay(400);
    expect(await second.digests(home)).toHaveLength(1);
    expect(await second.repositories.transcripts.lastMemoryMark({ taskId: home, kind: "digest" })).toMatchObject({
      mark: tomorrow.toISOString().slice(0, 10),
    });
  }, 60_000);
});
