import {
  HEARTBEAT_PRODUCTION_OPTIONS,
  defaultHeartbeatConfig,
  memoryCardChannelMessage,
  type InboundEvent,
  type MemoryCardItem,
  type ModEnvelope,
  type Reminder,
  type ReminderFire,
} from "@tavi/contracts";
import { coreEnglish } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { createFixtureMessagingConnectorDefinition } from "@tavi/test-support/messaging";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import {
  questionButtons,
  questionReceipt,
  renderQuestionText,
  renderRoundText,
  scopeButtons,
} from "../../src/features/approvals/channel-approval-text.js";
import { channelWords, zonedShortDay } from "../../src/features/channels/channel-words.js";
import { createHeartbeatButtons } from "../../src/features/heartbeat/buttons.js";
import { HEARTBEAT_OPEN_HINT, heartbeatButtons, heartbeatOpenHint } from "../../src/features/heartbeat/delivery.js";
import { heartbeatSlashCommand } from "../../src/features/heartbeat/slash.js";
import { memoryDecisionWords } from "../../src/features/memory/bulk.js";
import { createReminderButtons, reminderMessageText } from "../../src/features/reminders/delivery.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { SqliteStore } from "../support/database-fixture.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Chat apps are spoken to in the workspace's language (I18N-PLAN Tier 3 step 4):
 * a Bulgarian workspace's approval rounds, memory cards, heartbeat, reminders and
 * `/new` carry no English but the commands typed back (`approve`, `/forget`), names
 * and codes; an English one reads exactly as before.
 */

const bg = coreIn("bg");
const AT = "2026-10-11T09:00:00.000Z";

/** The Latin words left in `text` once `allowed` (commands, names, codes) are taken out. */
function englishLeft(text: string, allowed: readonly string[] = []): readonly string[] {
  const keep = new Set(["Tavi", "UTC", ...allowed].map((word) => word.toLowerCase()));
  return [...text.matchAll(/[A-Za-z]{3,}/g)].map((match) => match[0]).filter((word) => !keep.has(word.toLowerCase()));
}

const stores: SqliteStore[] = [];
const runtimes: TaviRuntime[] = [];
const directories = temporaryDirectories({ prefix: "tavi-channel-words-bg-" });
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

async function repositoriesIn(locale: "en" | "bg") {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const repositories = store.asPort().repositories;
  if (locale === "bg")
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { locale: "bg", timezone: "Europe/Sofia" },
      expectedRevision: (await repositories.workspaceSettings.get("default")).revision,
      actor: "operator",
      now: AT,
    });
  return repositories;
}

describe("the words a chat app is sent in", () => {
  it("are English without a reader, for an English workspace, and when the settings cannot be read", async () => {
    expect(await channelWords(undefined, "default")).toBe(coreEnglish);
    expect(await channelWords(async () => "en", "default")).toBe(coreEnglish);
    const warned: string[] = [];
    expect(
      await channelWords(
        async () => {
          throw new Error("store closed");
        },
        "default",
        (message) => warned.push(message),
      ),
    ).toBe(coreEnglish);
    expect(warned).toHaveLength(1);
    expect((await channelWords(async () => "bg", "default"))("channel.reminder.done")).toBe("Готово.");
  });

  it("say a September day as en-GB does in English, and by the catalogue in Bulgarian", () => {
    const september = new Date("2026-09-17T09:00:00.000Z");
    expect(zonedShortDay(september, "UTC")).toBe("Thu 17 Sept");
    expect(zonedShortDay(september, "UTC", bg)).toBe("чт, 17 сеп");
  });

  it("count one waiting thing in the singular in Bulgarian, English as before", () => {
    expect(bg("channel.memory.review.heading", { count: 1, n: "1" })).toBe("Чака 1:");
    expect(bg("channel.memory.review.heading", { count: 3, n: "3" })).toBe("Чакат 3:");
    expect(coreEnglish("channel.memory.review.heading", { count: 1, n: "1" })).toBe("1 waiting:");
    expect(bg("channel.approval.decide.approvedPending", { taskId: "t", scope: "", status: "running", count: 1, n: "1" })).toMatch(
      /а още 1 одобрение чака\.$/,
    );
  });
});

describe("an approval round in Bulgarian", () => {
  const invocation = { workspaceId: "w", principalId: "p", runId: "t", caller: "c" };
  const requests = [
    { callId: "a", toolName: "files.write", summary: "s", input: {}, allowedScopes: ["once", "session", "always"] as const },
  ];

  it("says its headline, risk, answers and expiry in Bulgarian, with only the typed commands left in English", () => {
    const round = { taskId: "t", steps: 1, invocation, requests };
    const text = renderRoundText(round, "abcdefgh", "2026-11-18T09:39:28.175Z", { t: bg });
    expect(text).toContain("🔐");
    expect(englishLeft(text, ["approve", "reject", "session", "always", "once", "abcdefgh", "files", "write", "reason"])).toEqual([]);
    // English is as it was.
    expect(renderRoundText(round, "abcdefgh", "2026-11-18T09:39:28.175Z")).toBe(
      renderRoundText(round, "abcdefgh", "2026-11-18T09:39:28.175Z", { t: coreEnglish }),
    );
    expect(renderRoundText(round, "abcdefgh", "2026-11-18T09:39:28.175Z")).toContain(
      "⌛ Not decided by Wed 18 Nov, 09:39 UTC, it is rejected.",
    );
  });

  it("labels its buttons in Bulgarian, their data unchanged", () => {
    const english = scopeButtons(["once", "session", "always"], "abcdefgh");
    const bulgarian = scopeButtons(["once", "session", "always"], "abcdefgh", undefined, bg);
    expect(bulgarian.flat().map((button) => button.data)).toEqual(english.flat().map((button) => button.data));
    for (const button of bulgarian.flat()) expect(englishLeft(button.label)).toEqual([]);
    expect(english.flat().map((button) => button.label)).toEqual(
      scopeButtons(["once", "session", "always"], "abcdefgh", undefined, coreEnglish)
        .flat()
        .map((button) => button.label),
    );
  });

  it("asks a question, labels its choices' buttons and gives its receipt in Bulgarian", () => {
    const choices = { options: [{ label: "Lisbon" }, { label: "Porto" }], multiSelect: true, allowOther: false };
    const text = renderQuestionText("Where to?", choices, { deadlineAt: "2026-11-18T09:39:28.175Z", now: AT }, bg);
    expect(englishLeft(text, ["Where", "Lisbon", "Porto"])).toEqual([]);
    const buttons = questionButtons("tok12345", choices, new Set([0]), bg);
    expect(buttons.flat().map((button) => button.data)).toEqual(
      questionButtons("tok12345", choices, new Set([0]))
        .flat()
        .map((button) => button.data),
    );
    for (const button of buttons.flat()) expect(englishLeft(button.label, ["Lisbon", "Porto"])).toEqual([]);
    const receipt = questionReceipt({ kind: "answered", answers: ["Lisbon"] } as never, "telegram", AT, "UTC", bg);
    expect(englishLeft(receipt, ["Lisbon", "telegram"])).toEqual([]);
  });
});

describe("memory cards in Bulgarian", () => {
  const item = (number: number, title: string): MemoryCardItem => ({
    token: `tok${number}abcdefgh`,
    number,
    recordId: `rec-${number}`,
    state: "proposed",
    kind: "fact",
    sensitive: false,
    title,
    excerpt: null,
  });

  it("label a card's buttons and say its receipts in Bulgarian", () => {
    const card = { title: "2 things to remember", items: [item(1, "Works from Porto"), item(2, "Likes tea")], forgotten: 0 };
    const english = memoryCardChannelMessage(card, "buttons");
    const bulgarian = memoryCardChannelMessage(card, "buttons", bg);
    expect(bulgarian.buttons.map((button) => button.data)).toEqual(english.buttons.map((button) => button.data));
    for (const button of bulgarian.buttons) expect(englishLeft(button.label)).toEqual([]);
    expect(english.buttons.map((button) => button.label)).toContain("Keep all");
    expect(englishLeft(memoryDecisionWords("Already kept", bg))).toEqual([]);
    expect(memoryDecisionWords("Already kept")).toBe("Already kept");
  });
});

describe("the heartbeat in Bulgarian", () => {
  async function command(locale: "en" | "bg") {
    const repositories = await repositoriesIn(locale);
    const run = heartbeatSlashCommand({
      repositories,
      principalOf: () => "operator",
      options: HEARTBEAT_PRODUCTION_OPTIONS,
      providers: () => [],
      host: () => ({ checkNow: async () => ({ status: "started" as const }) }),
      author: "command",
      now: () => new Date(AT),
    });
    const envelope: ModEnvelope = {
      workspaceId: "default",
      principalId: "operator",
      taskId: "t",
      runId: "t",
      source: "messaging",
      attended: true,
    };
    await repositories.heartbeats.save({
      workspaceId: "default",
      principalId: "operator",
      config: { ...defaultHeartbeatConfig(), enabled: true, daysOfWeek: [1, 2, 3, 4, 5] },
      expectedRevision: 0,
      author: "test",
      now: AT,
      nextTickAt: "2026-10-11T09:30:00.000Z",
    });
    return async (args: string) => (await run({ envelope, args, signal: new AbortController().signal })).text ?? "";
  }

  it("says its status, pause and usage in Bulgarian", async () => {
    const run = await command("bg");
    const status = await run("status");
    expect(status).toMatch(/^Пулсът е включен · следваща проверка \d\d:\d\d · на всеки 30\u00a0мин, пн–пт 08:00–22:00 /);
    expect(englishLeft(status, ["Europe", "Sofia"])).toEqual([]);
    const paused = await run("pause 2h");
    expect(paused).toMatch(/^Пулсът е на пауза от теб до \d\d:\d\d/);
    expect(englishLeft(paused, ["Europe", "Sofia"])).toEqual([]);
    expect(await run("now")).toBe("Проверявам сега.");
    expect(englishLeft(await run("every 1h"), ["heartbeat", "status", "pause", "resume", "now", "tavi"])).toEqual([]);
  });

  it("reads as before in English", async () => {
    const run = await command("en");
    expect(await run("status")).toMatch(/^Heartbeat on · next check \d\d:\d\d · every 30m, Mon–Fri 08:00–22:00 /);
    expect(await run("pause 2h")).toMatch(/^Heartbeat paused by you until \d\d:\d\d · every 30m, Mon–Fri 08:00–22:00 \S+\.$/);
  });

  it("labels an item's buttons and answers their presses in Bulgarian, their data unchanged", async () => {
    const english = heartbeatButtons("abcdefghijklmnop");
    const bulgarian = heartbeatButtons("abcdefghijklmnop", bg);
    expect(bulgarian.flat().map((button) => button.data)).toEqual(english.flat().map((button) => button.data));
    expect(english.flat().map((button) => button.label)).toEqual(["Open", "Snooze 1 h", "Don't tell me"]);
    for (const button of bulgarian.flat()) expect(englishLeft(button.label)).toEqual([]);
    expect(englishLeft(heartbeatOpenHint(bg))).toEqual([]);
    expect(heartbeatOpenHint()).toBe(HEARTBEAT_OPEN_HINT);

    const answered: string[] = [];
    const buttons = createHeartbeatButtons({
      repositories: { heartbeats: { itemByToken: async () => undefined } as never },
      messaging: {
        answerInteraction: async (_connectionId: string, _callbackId: string, text?: string) => {
          answered.push(text ?? "");
          return true;
        },
        buildReplyDestination: () => undefined,
        editMessage: async () => false,
      } as never,
      now: () => AT,
      localeOf: async () => "bg",
    });
    const press = (data: string): InboundEvent => ({
      connectionId: "conn-a",
      providerEventId: "evt-1",
      kind: "interaction",
      externalSenderId: "user-1",
      externalConversationId: "chat-1",
      occurredAt: AT,
      receivedAt: AT,
      interaction: { callbackId: "cb-1", data },
    });
    expect(
      await buttons.handleInteraction({
        actor: { workspaceId: "default", principalId: "operator" } as never,
        event: press("h:abcdefghijklmnop:s"),
      }),
    ).toBe(true);
    expect(answered).toEqual(["Този елемент вече не е наличен."]);
  });
});

describe("a reminder in Bulgarian", () => {
  const reminder: Reminder = {
    reminderId: "r",
    workspaceId: "default",
    principalId: "alice",
    text: "Зъболекар",
    when: { kind: "event", at: "2026-10-05T08:00:00.000Z", notify: ["-1h"] },
    timezone: "Europe/Berlin",
    deliverTo: { kind: "app" },
    status: "active",
    nextFireAt: null,
    lastFiredAt: null,
    createdBy: "agent",
    operationKey: "k",
    createdAt: AT,
    updatedAt: AT,
  };
  const fire: ReminderFire = {
    reminderId: "r",
    fireAt: "2026-10-05T07:00:00.000Z",
    firedAt: null,
    outcome: "pending",
    occurrence: "notice",
    noticeOffset: "-1h",
  };

  it("says when it is and that it is late in Bulgarian, English as before", () => {
    expect(reminderMessageText(reminder, fire, true, bg)).toBe("⏰ Зъболекар — пн, 5 окт 10:00 (закъсняло: трябваше да е в 09:00)");
    expect(reminderMessageText(reminder, fire, true)).toBe("⏰ Зъболекар — Mon 5 Oct 10:00 (late: was due 09:00)");
  });

  it("answers a press on a reminder that is gone in Bulgarian", async () => {
    const answered: string[] = [];
    const buttons = createReminderButtons({
      repositories: { reminders: { fireByToken: async () => undefined } as never },
      messaging: {
        answerInteraction: async (_connectionId: string, _callbackId: string, text?: string) => {
          answered.push(text ?? "");
          return true;
        },
        buildReplyDestination: () => undefined,
        editMessage: async () => false,
      } as never,
      now: () => AT,
      localeOf: async () => "bg",
    });
    await buttons.handleInteraction({
      actor: { workspaceId: "default", principalId: "alice" } as never,
      event: {
        connectionId: "conn-a",
        providerEventId: "evt-1",
        kind: "interaction",
        externalSenderId: "user-1",
        externalConversationId: "chat-1",
        occurredAt: AT,
        receivedAt: AT,
        interaction: { callbackId: "cb-1", data: "m:abcdefgh:d" },
      },
    });
    expect(answered).toEqual(["Това напомняне вече не е налично."]);
  });
});

describe("/new in a Bulgarian workspace", () => {
  it("is answered in Bulgarian", async () => {
    const directory = directories.create();
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directory, {
        workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      }),
      { modelOverride: createFixtureModel({ turns: [{ text: "first answer" }] }) },
    );
    runtimes.push(runtime);
    const repositories = runtime.store.asPort().repositories;
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { locale: "bg" },
      expectedRevision: (await repositories.workspaceSettings.get("default")).revision,
      actor: "operator",
      now: AT,
    });
    const sent: string[] = [];
    runtime.messaging.registerConnector({
      ...createFixtureMessagingConnectorDefinition({
        sendOutcome: (message) => {
          sent.push((message.parts[0] as { content?: string } | undefined)?.content ?? "");
          return { status: "accepted", retryable: false, parts: [] };
        },
      }),
      destinationFromInbound: (replyTo) => ({ fixtureChat: replyTo.externalConversationId }),
    });
    await runtime.messaging.openConnection({
      connection: {
        connectionId: "conn-a",
        providerId: "fixture",
        accountIdentity: "acct-a",
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    await repositories.messagingIdentityBindings.bind({
      connectionId: "conn-a",
      externalSenderId: "user-1",
      workspaceId: "default",
      principalId: "alice",
      approvedBy: "operator",
      createdAt: AT,
    });
    const inbound = (providerEventId: string, content: string): InboundEvent => ({
      connectionId: "conn-a",
      providerEventId,
      kind: "message",
      externalSenderId: "user-1",
      externalConversationId: "chat-1",
      occurredAt: AT,
      receivedAt: AT,
      content,
    });
    await runtime.messaging.ingest(inbound("evt-1", "/new"));
    expect(sent.at(-1)).toBe("Няма какво да започва отначало: следващото ти съобщение започва нов разговор.");
    await runtime.messaging.ingest(inbound("evt-2", "hi there"));
    await runtime.messaging.ingest(inbound("evt-3", "/new"));
    expect(sent.at(-1)).toBe("Започнах нов разговор. Предишният още може да се прочете в приложението Tavi.");
    expect(englishLeft(sent.at(-1) ?? "")).toEqual([]);
  });
});
