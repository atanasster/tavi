import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { heartbeatSignalsOf, type ConnectableApp, type ModelPort } from "@tavi/contracts";
import { temporaryDirectories, until, waitFor, fakeFetch } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { channelSecretRef } from "../../src/features/channels/settings.js";
import { channelRooms } from "../../src/features/channels/rooms.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { appsOwnerCommand } from "../../src/server/config-commands.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";
import { appsSignalsSource } from "../../src/features/heartbeat/sources.js";
import { saveChannelConnection } from "../support/saved-channel.js";
import { askingForMemoryProposals, fixtureRuntimeOptions, fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * Telegram on the group-chat seam, end to end through a composed owner over a
 * fake Bot API, for the cases its capabilities declare: private approvals for a
 * room's task, a member's refused press, a revoked token's repair, a group
 * waiting to be listed, an unbound member held on a `hold` channel, and command
 * addressing.
 */

const BOT = 1;
const GROUP = -1001;
const OPERATOR = 77;
const BOB = 88;
const STRANGER = 99;

const directories = temporaryDirectories({ prefix: "tavi-telegram-groups-" });
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface BotCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/**
 * A fake Bot API for `@tavi_bot` (id 1). `emit` queues an update and resolves
 * once a later poll acknowledged it: the connector advances its offset only
 * after the host's ingest returned, so by then the update was taken in.
 * A private chat in `closed` never started the bot, and Telegram answers 403
 * to a send there; `revoke()` makes every later poll a 401.
 */
function botApi(options: { readonly closed?: readonly number[] } = {}) {
  let seq = 0;
  let messageId = 1000;
  let revoked = false;
  const polls = { count: 0, refused: 0 };
  const queue: unknown[] = [];
  const calls: BotCall[] = [];
  const acknowledged: { readonly id: number; readonly resolve: () => void }[] = [];
  let wake: (() => void) | undefined;
  const fetchImpl = fakeFetch(async (url, init) => {
    const method = url.split("/").pop() ?? "";
    if (url.includes("/file/bot")) {
      calls.push({ method: "file", body: {} });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method === "getMe") return json({ ok: true, result: { id: BOT, is_bot: true, username: "tavi_bot" } });
    if (method === "getUpdates") {
      polls.count += 1;
      if (revoked) {
        polls.refused += 1;
        return json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
      }
      const offset = typeof body["offset"] === "number" ? body["offset"] : 0;
      for (const waiter of acknowledged.filter((entry) => entry.id < offset)) {
        acknowledged.splice(acknowledged.indexOf(waiter), 1);
        waiter.resolve();
      }
      while (queue.length === 0 && !revoked) {
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }
      if (revoked) return json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
      return json({ ok: true, result: queue.splice(0) });
    }
    calls.push({ method, body });
    if (method === "sendMessage") {
      const chat = Number(body["chat_id"]);
      if (options.closed?.includes(chat) === true)
        return json({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" }, 403);
      messageId += 1;
      return json({ ok: true, result: { message_id: messageId, date: 0, chat: { id: chat } } });
    }
    if (method === "getFile") return json({ ok: true, result: { file_id: body["file_id"], file_path: "photos/p.jpg" } });
    return json({ ok: true, result: true });
  });

  return {
    fetch: fetchImpl,
    calls,
    polls,
    revoke(): void {
      revoked = true;
      wake?.();
    },
    /** Queues one update and resolves once the connector acknowledged it. */
    async emit(update: Record<string, unknown>): Promise<void> {
      seq += 1;
      const id = seq;
      queue.push({ update_id: id, ...update });
      wake?.();
      await new Promise<void>((resolve) => acknowledged.push({ id, resolve }));
    },
    nextMessageId: (): number => (messageId += 1),
    sendsTo: (chat: number): readonly BotCall[] =>
      calls.filter((call) => call.method === "sendMessage" && String(call.body["chat_id"]) === String(chat)),
    editsOf: (chat: number): readonly BotCall[] =>
      calls.filter((call) => call.method === "editMessageText" && String(call.body["chat_id"]) === String(chat)),
  };
}
type BotApi = ReturnType<typeof botApi>;

const supergroup = { id: GROUP, type: "supergroup", title: "Team" };

/** A message in the group from `from`; `mention` addresses `@tavi_bot` the way Telegram marks it. */
function groupMessage(
  api: BotApi,
  from: number,
  text: string,
  how: { readonly mention?: boolean; readonly command?: number; readonly extra?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const entities =
    how.mention === true
      ? [{ type: "mention", offset: 0, length: "@tavi_bot".length }]
      : how.command !== undefined
        ? [{ type: "bot_command", offset: 0, length: how.command }]
        : undefined;
  return {
    message: {
      message_id: api.nextMessageId(),
      date: 1_700_000_000,
      text: how.mention === true ? `@tavi_bot ${text}` : text,
      ...(entities === undefined ? {} : { entities }),
      chat: supergroup,
      from: { id: from, is_bot: false },
      ...how.extra,
    },
  };
}

const press = (api: BotApi, from: number, data: string, chat: number, messageId: number): Record<string, unknown> => ({
  callback_query: {
    id: `cb-${String(api.nextMessageId())}`,
    from: { id: from },
    data,
    message: { message_id: messageId, chat: { id: chat } },
  },
});

async function compose(directory: string, api: BotApi, model: ModelPort, extra: { readonly saved?: boolean } = {}): Promise<TaviRuntime> {
  const tokenFile = join(directory, "telegram-token");
  writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });
  // The bot as `tavi channels add telegram` saves it, its token the bound file; a test that saved its own keeps it.
  if (extra.saved !== true)
    await saveChannelConnection(directory, {
      connectionId: "telegram-default",
      providerId: "telegram",
      workspaceId: "default",
      accountIdentity: "tavi-bot",
      settings: {},
      credentialRefs: { token: "telegram.botToken" },
    });
  const runtime = await composeTaviRuntime(
    fixtureServeOptions(directory, {
      credentials: extra.saved === true ? {} : { "telegram.botToken": { fromFile: tokenFile } },
      approvalRequiredFor: ["mutating", "external"],
      openSavedChannels: true,
    }),
    { requireModelTransport: false, modelOverride: model, channelFetch: { telegram: api.fetch } },
  );
  runtimes.push(runtime);
  // The rooms' rounds are `memory.propose`'s: with its seeded allow rule revoked (as an operator may), it asks.
  return askingForMemoryProposals(runtime);
}

async function bind(runtime: TaviRuntime, sender: number, principalId: string): Promise<void> {
  await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
    connectionId: "telegram-default",
    externalSenderId: String(sender),
    workspaceId: "default",
    principalId,
    approvedBy: "operator",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

const roomsOf = (runtime: TaviRuntime) => ({
  repositories: runtime.store.asPort().repositories,
  channels: runtime.channels,
  messaging: runtime.messaging,
  roomInvitations: runtime.roomInvitations,
  operatorOf: () => "operator",
  now: () => runtime.clock.now(),
});

async function listGroup(runtime: TaviRuntime): Promise<void> {
  await channelRooms(roomsOf(runtime), {
    action: "rooms",
    workspaceId: "default",
    connectionId: "telegram-default",
    op: "add",
    conversationId: String(GROUP),
    label: "Team",
  });
}

const taskOf = async (runtime: TaviRuntime, conversation: number): Promise<string> =>
  (
    await until(
      () => runtime.store.asPort().repositories.messagingConversations.get("telegram-default", String(conversation)),
      (mapped) => mapped !== undefined,
    )
  )?.taskId ?? "";

const roundOf = async (runtime: TaviRuntime, taskId: string) =>
  until(
    () => runtime.store.asPort().repositories.approvalRounds.get(taskId, 1),
    (round) => round !== undefined,
  );

const buttonsOf = (call: BotCall | undefined): readonly string[] =>
  ((call?.body["reply_markup"] as { inline_keyboard?: { callback_data: string }[][] } | undefined)?.inline_keyboard ?? [])
    .flat()
    .map((button) => button.callback_data);

const propose = { toolCall: { id: "c1", name: "memory.propose", input: { kind: "fact", body: "the sky is blue" } } } as const;

/** A room task waiting on its round, started by the operator's mention in the listed group. */
async function roomRound(runtime: TaviRuntime, api: BotApi, from = OPERATOR): Promise<{ readonly taskId: string; readonly token: string }> {
  await api.emit(groupMessage(api, from, "remember the sky is blue", { mention: true }));
  const taskId = await taskOf(runtime, GROUP);
  return { taskId, token: (await roundOf(runtime, taskId))?.token ?? "" };
}

describe("Telegram rooms: approvals are private", () => {
  it("a room task's card goes to the decider's private chat with buttons, the group gets only a notice, and both are edited on settlement", async () => {
    const directory = directories.create();
    const api = botApi();
    const runtime = await compose(directory, api, createFixtureModel({ turns: [propose, { text: "done" }] }));
    await bind(runtime, OPERATOR, "operator");
    await listGroup(runtime);
    const { taskId, token } = await roomRound(runtime, api);

    await waitFor(() => api.sendsTo(OPERATOR).some((call) => buttonsOf(call).some((data) => data.startsWith(`r:${token}:`))));
    const card = api.sendsTo(OPERATOR).find((call) => buttonsOf(call).some((data) => data.startsWith(`r:${token}:`)));
    expect(String(card?.body["text"])).toContain("memory.propose");
    expect(buttonsOf(card)).toContain(`r:${token}:o`);
    await waitFor(() => api.sendsTo(GROUP).some((call) => String(call.body["text"]).includes(`round ${token}`)));
    expect(
      api
        .sendsTo(GROUP)
        .filter((call) => String(call.body["text"]).includes(`round ${token}`))
        .map((call) => call.body["text"]),
    ).toEqual([`⏸ Waiting on the operator's approval (round ${token}).`]);
    // Nothing pressable is ever in the group.
    expect(api.sendsTo(GROUP).filter((call) => call.body["reply_markup"] !== undefined)).toEqual([]);

    const cardId = (
      await runtime.store.asPort().repositories.approvalRoundDeliveries.listForRound(taskId, (await roundOf(runtime, taskId))?.steps ?? 1)
    ).find((delivery) => delivery.role === "card")?.messageIds[0];
    expect(cardId).toBeDefined();
    await api.emit(press(api, OPERATOR, `r:${token}:o`, OPERATOR, Number(cardId)));
    await waitFor(async () => (await runtime.store.asPort().repositories.tasks.get(taskId))?.status === "completed");
    // Both edited: the card loses its buttons, and the notice says how it ended.
    await waitFor(
      () =>
        api.editsOf(OPERATOR).some((call) => /approved/i.test(String(call.body["text"]))) &&
        api.editsOf(GROUP).some((call) => /approved/i.test(String(call.body["text"]))),
    );
    expect(api.editsOf(OPERATOR).at(-1)?.body["reply_markup"]).toEqual({ inline_keyboard: [] });
    expect(api.editsOf(OPERATOR).at(-1)?.body["message_id"]).toBe(Number(cardId));
  }, 30_000);

  it("a decider who never started the bot (403 to the private send) gets the approve-in-Tavi notice in the group, and the card never falls back to the group", async () => {
    const directory = directories.create();
    const api = botApi({ closed: [OPERATOR] });
    const runtime = await compose(directory, api, createFixtureModel({ turns: [propose, { text: "done" }] }));
    await bind(runtime, OPERATOR, "operator");
    await listGroup(runtime);
    const { token } = await roomRound(runtime, api);

    await waitFor(() => api.sendsTo(GROUP).some((call) => String(call.body["text"]).includes(`Round ${token}`)));
    expect(api.sendsTo(GROUP).find((call) => String(call.body["text"]).includes(`Round ${token}`))?.body["text"]).toBe(
      `⏸ Round ${token} waits on the operator's approval: open a one-to-one chat with me, or approve it in Tavi: the web app, the CLI or another chat.`,
    );
    // The card was tried privately, refused there, and never sent to the group.
    expect(api.sendsTo(OPERATOR).some((call) => buttonsOf(call).some((data) => data.startsWith(`r:${token}:`)))).toBe(true);
    expect(api.sendsTo(GROUP).filter((call) => call.body["reply_markup"] !== undefined)).toEqual([]);
    expect(api.sendsTo(GROUP).some((call) => String(call.body["text"]).includes("memory.propose"))).toBe(false);
  }, 30_000);

  it("a member's press in the group is refused privately with answerCallbackQuery, nothing shows in the group, and the round stays open", async () => {
    const directory = directories.create();
    const api = botApi();
    const runtime = await compose(directory, api, createFixtureModel({ turns: [propose, { text: "done" }] }));
    const repositories = runtime.store.asPort().repositories;
    await bind(runtime, OPERATOR, "operator");
    await bind(runtime, BOB, "bob");
    await listGroup(runtime);
    const { taskId, token } = await roomRound(runtime, api);
    await waitFor(() => api.sendsTo(GROUP).some((call) => String(call.body["text"]).includes(`round ${token}`)));
    const groupBefore = api.sendsTo(GROUP).length;
    const editsBefore = api.editsOf(GROUP).length;

    const noticeId = (await repositories.approvalRoundDeliveries.listForRound(taskId, (await roundOf(runtime, taskId))?.steps ?? 1)).find(
      (delivery) => delivery.role === "notice",
    )?.messageIds[0];
    const tap = press(api, BOB, `r:${token}:o`, GROUP, Number(noticeId ?? 1));
    await api.emit(tap);
    const callbackId = (tap["callback_query"] as { id: string }).id;
    await waitFor(() => api.calls.some((call) => call.method === "answerCallbackQuery" && call.body["callback_query_id"] === callbackId));
    // A callback answer is shown on the presser's own client alone.
    expect(
      api.calls.find((call) => call.method === "answerCallbackQuery" && call.body["callback_query_id"] === callbackId)?.body["text"],
    ).toEqual(expect.stringMatching(/\S/));
    expect(api.sendsTo(GROUP)).toHaveLength(groupBefore);
    expect(api.editsOf(GROUP)).toHaveLength(editsBefore);
    const events = await repositories.approvalRounds.listEvents(taskId, 1);
    expect(events.find((event) => event.kind === "decision_refused")?.detail).toMatchObject({ reason: "not-owner" });
    expect((await repositories.approvalRounds.get(taskId, 1))?.settledAt).toBeUndefined();
    expect((await repositories.tasks.get(taskId))?.status).not.toBe("completed");
  }, 30_000);
});

describe("Telegram's refused token", () => {
  it("a 401 from the Bot API makes the connection needs-sign-in in Connected apps, and the heartbeat apps source raises it", async () => {
    const directory = directories.create();
    // Saved in Settings, as Connected apps lists connections.
    const setup = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), { requireModelTransport: false });
    try {
      await createLocalCredentialStore(directory).setSecret(channelSecretRef("telegram-default", "token"), "saved-token");
      await setup.store.asPort().repositories.messagingConnections.save(
        {
          connectionId: "telegram-default",
          providerId: "telegram",
          workspaceId: "default",
          accountIdentity: "tavi-bot",
          settings: {},
          credentialRefs: { token: channelSecretRef("telegram-default", "token") },
          enabled: true,
          authState: "none",
        },
        "2026-10-09T00:00:00.000Z",
      );
    } finally {
      await setup.close();
    }
    const api = botApi();
    const runtime = await compose(directory, api, createFixtureModel({ turns: [{ text: "ok" }] }), { saved: true });
    expect(runtime.channels.statusOf("telegram-default")?.state).toBe("running");
    // The token is revoked while the connection runs: the next poll is refused.
    api.revoke();
    await waitFor(() => api.polls.refused > 0 && runtime.channels.statusOf("telegram-default")?.state === "failed");
    expect(runtime.channels.statusOf("telegram-default")).toMatchObject({ state: "failed", repair: "credentials" });

    const answer = await appsOwnerCommand(runtime, { action: "list", workspaceId: "default" }, "operator");
    expect(answer.ok).toBe(true);
    const listed = answer.ok ? (answer.result as { apps: ConnectableApp[] }).apps : [];
    const app = listed.find((candidate) => candidate.accounts.some((account) => account.accountId === "telegram-default"));
    expect(app?.accounts.find((account) => account.accountId === "telegram-default")?.health).toBe("needs-sign-in");
    const repair = app?.repairs.find((candidate) => candidate.accountId === "telegram-default");
    expect(repair?.kind).toBe("sign-in");
    const signals = heartbeatSignalsOf(
      await appsSignalsSource({
        apps: async () => listed,
        connections: runtime.store.asPort().repositories.messagingConnections,
        operatorOf: () => "operator",
        usedIn: async () => [],
      }).collect({
        workspaceId: "default",
        principalId: "operator",
        now: runtime.clock.now(),
        timezone: "UTC",
        signal: new AbortController().signal,
      }),
    );
    expect(signals.find((signal) => signal.key === "app:telegram-default")).toMatchObject({
      title: repair?.title,
      source: "Connected apps",
    });
  }, 30_000);
});

describe("Telegram rooms: listing, holding and addressing", () => {
  it("a group the bot is added to waits to be listed", async () => {
    const directory = directories.create();
    const api = botApi();
    const model = createFixtureModel({ turns: [] });
    const runtime = await compose(directory, api, model);
    const repositories = runtime.store.asPort().repositories;
    await bind(runtime, OPERATOR, "operator");

    // Nothing of a group the bot is added to is admitted until the operator lists it.
    const fresh = { id: -1003, type: "supergroup", title: "New" };
    await api.emit({
      my_chat_member: {
        chat: fresh,
        from: { id: OPERATOR },
        date: 1_700_000_100,
        old_chat_member: { status: "left", user: { id: BOT } },
        new_chat_member: { status: "member", user: { id: BOT } },
      },
    });
    const asked = {
      message: {
        message_id: api.nextMessageId(),
        date: 1_700_000_101,
        text: "@tavi_bot hello?",
        entities: [{ type: "mention", offset: 0, length: 9 }],
        chat: fresh,
        from: { id: OPERATOR },
      },
    };
    await api.emit(asked);
    expect(
      await repositories.messagingInbox.get("telegram-default", `bot:${BOT}:chat:-1003:msg:${String(asked.message.message_id)}`),
    ).toBeUndefined();
    expect(await repositories.messagingConversations.get("telegram-default", "-1003")).toBeUndefined();
    expect(runtime.roomInvitations.list("telegram-default").find((room) => room.conversationId === "-1003")).toMatchObject({
      how: "added",
    });
    expect(api.sendsTo(-1003)).toEqual([]);
  }, 30_000);

  it("on a hold channel: an unbound member addressing the agent in a listed room is held, not dropped, and their attachment is not fetched", async () => {
    const directory = directories.create();
    const api = botApi();
    const model = createFixtureModel({ turns: [{ text: "should not run" }] });
    const runtime = await compose(directory, api, model);
    const repositories = runtime.store.asPort().repositories;
    await bind(runtime, OPERATOR, "operator");
    await listGroup(runtime);
    const update = {
      message: {
        message_id: api.nextMessageId(),
        date: 1_700_000_000,
        caption: "@tavi_bot look at this",
        caption_entities: [{ type: "mention", offset: 0, length: 9 }],
        photo: [
          { file_id: "photo-small", file_size: 10 },
          { file_id: "photo-large", file_size: 100 },
        ],
        chat: supergroup,
        from: { id: STRANGER, is_bot: false },
      },
    };
    await api.emit(update);
    const key = `bot:${BOT}:chat:${GROUP}:msg:${String(update.message.message_id)}`;
    // Held for the operator to pair, never dropped: the room policy let it through and ingest kept it.
    expect(runtime.messaging.roomDrops?.("telegram-default")["unbound"] ?? 0).toBe(0);
    expect((await repositories.messagingInbox.get("telegram-default", key))?.state).toBe("received");
    expect(
      (await repositories.messagingInbox.listHeld({ limit: 100, connectionIds: ["telegram-default"] })).held.map((held) => [
        held.providerEventId,
        held.externalSenderId,
        held.resolvedPrincipalId,
      ]),
    ).toEqual([[key, String(STRANGER), null]]);
    // No task, and the photo was never downloaded.
    expect(await repositories.messagingConversations.get("telegram-default", String(GROUP))).toBeUndefined();
    expect(api.calls.filter((call) => call.method === "getFile" || call.method === "file")).toEqual([]);
    expect(model.calls).toHaveLength(0);
  }, 30_000);

  it("command addressing: /ask@tavi_bot in a listed room with the default trigger starts a turn; /ask@other_bot does not", async () => {
    const directory = directories.create();
    const api = botApi();
    const model = createFixtureModel({ turns: [{ text: "the review is next" }] });
    const runtime = await compose(directory, api, model);
    const repositories = runtime.store.asPort().repositories;
    await bind(runtime, OPERATOR, "operator");
    await listGroup(runtime);
    const drops = (): number => runtime.messaging.roomDrops?.("telegram-default")["not-addressed"] ?? 0;

    const other = groupMessage(api, OPERATOR, "/ask@other_bot what's next?", { command: "/ask@other_bot".length });
    await api.emit(other);
    expect(drops()).toBe(1);
    expect(
      await repositories.messagingInbox.get(
        "telegram-default",
        `bot:${BOT}:chat:${GROUP}:msg:${String((other["message"] as { message_id: number }).message_id)}`,
      ),
    ).toBeUndefined();
    expect(await repositories.messagingConversations.get("telegram-default", String(GROUP))).toBeUndefined();

    const ours = groupMessage(api, OPERATOR, "/ask@tavi_bot what's next?", { command: "/ask@tavi_bot".length });
    await api.emit(ours);
    expect(
      (
        await repositories.messagingInbox.get(
          "telegram-default",
          `bot:${BOT}:chat:${GROUP}:msg:${String((ours["message"] as { message_id: number }).message_id)}`,
        )
      )?.payload,
    ).toMatchObject({ content: "/ask what's next?", addressed: ["command"] });
    const taskId = await taskOf(runtime, GROUP);
    await waitFor(async () => (await repositories.tasks.get(taskId))?.finalText === "the review is next");
    expect(model.calls).toHaveLength(1);
    expect(drops()).toBe(1);
  }, 30_000);
});
