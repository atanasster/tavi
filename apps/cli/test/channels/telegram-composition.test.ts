import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelPort } from "@tavi/contracts";
import { temporaryDirectories, fakeFetch } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it, vi } from "vitest";

import { channelSecretRef } from "../../src/features/channels/settings.js";
import { channelRooms } from "../../src/features/channels/rooms.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";
import { saveChannelConnection } from "../support/saved-channel.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * An end-to-end test proving CLI composition wires the real Telegram connector (not the
 * fixture) — credential resolution through the same `secrets` chain model
 * credentials already use, connection opening at startup, and `send()`
 * reaching the real adapter — through the full `composeTaviRuntime` path,
 * without ever making a real network call (`channelFetch`
 * substitutes a fake `fetch`).
 */

const directories = temporaryDirectories({ prefix: "tavi-telegram-composition-" });
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    if (runtime !== undefined) await runtime.close();
  }
  directories.cleanup();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function hangUntilAborted(signal?: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
}

function textUpdate(updateId: number, message: { readonly chatId: number; readonly senderId: number; readonly text: string }): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      text: message.text,
      chat: { id: message.chatId },
      from: { id: message.senderId },
    },
  };
}

/**
 * A fake Bot API that answers the Nth `getUpdates` call with the Nth batch and
 * then long-polls until shutdown, recording the `offset` each call asked for.
 *
 * The first batch is held until `release()`: the connection opens, and starts
 * polling, inside `composeTaviRuntime`, before a test can bind the sender whose
 * message it is about to deliver.
 */
function scriptedUpdates(batches: readonly (readonly unknown[])[]): {
  readonly fetch: typeof fetch;
  readonly offsets: readonly (number | undefined)[];
  readonly release: () => void;
} {
  const offsets: (number | undefined)[] = [];
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl = fakeFetch(async (url, init) => {
    if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
    if (url.includes("/sendMessage")) return jsonResponse({ ok: true, result: { message_id: 900, date: 0, chat: { id: 42 } } });
    if (url.includes("/getUpdates")) {
      offsets.push((JSON.parse(String(init?.body)) as { offset?: number }).offset);
      const batch = batches[offsets.length - 1];
      if (batch === undefined) return hangUntilAborted(init?.signal);
      // Raced with the abort so a test that fails before `release()` still closes.
      await Promise.race([released, hangUntilAborted(init?.signal)]);
      return jsonResponse({ ok: true, result: batch });
    }
    return hangUntilAborted(init?.signal);
  });
  return { fetch: fetchImpl, offsets, release };
}

async function bindSender(runtime: TaviRuntime, externalSenderId: string, principalId: string, workspaceId = "default"): Promise<void> {
  await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
    connectionId: "telegram-default",
    externalSenderId,
    workspaceId,
    principalId,
    approvedBy: "operator",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

/** The bot as `tavi channels add telegram` saves it, its token the bound file. */
const saveFlaglessTelegram = (directory: string): Promise<void> =>
  saveChannelConnection(directory, {
    connectionId: "telegram-default",
    providerId: "telegram",
    workspaceId: "default",
    accountIdentity: "tavi-bot",
    settings: {},
    credentialRefs: { token: "telegram.botToken" },
  });

async function composeWithTelegram(
  directory: string,
  botTokenFile: string,
  fetchImpl: typeof fetch,
  model?: ModelPort,
): Promise<TaviRuntime> {
  await saveFlaglessTelegram(directory);
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      credentials: { "telegram.botToken": { fromFile: botTokenFile } },
      approvalRequiredFor: [],
      // `messaging.send_to` denies every destination without one, so a test that expects a delivery has to configure it exactly
      // as an operator would.
      messagingAllowedDestinations: ["42", "8346819670"],
      openSavedChannels: true,
    }),
    {
      requireModelTransport: false,
      channelFetch: { telegram: fetchImpl },
      ...(model === undefined ? {} : { modelOverride: model }),
    },
  );
  runtimes.push(runtime);
  return runtime;
}

/**
 * Drives the *registered* `messaging.send_to` tool through the composed
 * runtime — the same entry point a scheduler-admitted task calls — so these
 * tests exercise composition's `readArtifact` wiring rather than reaching
 * into the connector directly.
 */
async function invokeSendTo(runtime: TaviRuntime, input: unknown, workspaceId = "default"): Promise<unknown> {
  const tool = runtime.tools.get("messaging.send_to");
  if (tool === undefined) throw new Error("messaging.send_to is not registered");
  return tool.handler({
    input,
    context: { workspaceId, principalId: "operator", runId: "run-m4", caller: "scheduler" },
    signal: new AbortController().signal,
  });
}

describe("composeTaviRuntime — real Telegram connector wiring", () => {
  it("resolves the bot token through the same secrets chain as model credentials, opens the connection at startup", async () => {
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });

    const fetchImpl = fakeFetch(async (url, init) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      return hangUntilAborted(init?.signal);
    });

    const runtime = await composeWithTelegram(directory, tokenFile, fetchImpl);
    expect(runtime).toBeDefined();
  });

  it("send() reaches the real connector through the composed runtime, mapping a successful sendMessage to accepted", async () => {
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });

    const fetchImpl = fakeFetch(async (url, init) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/sendMessage")) return jsonResponse({ ok: true, result: { message_id: 7, date: 0, chat: { id: 1 } } });
      return hangUntilAborted(init?.signal);
    });

    const runtime = await composeWithTelegram(directory, tokenFile, fetchImpl);
    const outcome = await runtime.messaging.send({
      effectId: "eff-1",
      connectionId: "telegram-default",
      destination: { chatId: 1 },
      parts: [{ content: "hello from tavi" }],
    });
    expect(outcome).toEqual({ status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "7" }] });
  });

  it("keeps a single-Telegram deployment's bare allowlist entry matching with the local connection open, through composition", async () => {
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });
    const sent: string[] = [];
    const fetchImpl = fakeFetch(async (url, init) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      if (url.includes("/sendMessage")) {
        sent.push(String(init?.body));
        return jsonResponse({ ok: true, result: { message_id: 8, date: 0, chat: { id: 42 } } });
      }
      return hangUntilAborted(init?.signal);
    });
    // The allowlist's entries are bare ("42"), as an operator with one Telegram bot writes them.
    const runtime = await composeWithTelegram(directory, tokenFile, fetchImpl);
    const sendTo = runtime.tools.get("messaging.send_to");
    if (sendTo === undefined) throw new Error("messaging.send_to is not registered");
    const context = { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" };
    // The workspace's local connection is open beside Telegram, and does not make the bare entry ambiguous.
    expect(runtime.localMessaging).toBeDefined();
    await sendTo.handler({
      input: { kind: "text", connectionId: "telegram-default", chatId: "42", content: "the brief" },
      context,
      signal: new AbortController().signal,
    });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({ chat_id: "42", text: "the brief" });
    // And the local connection is still no destination, bare entry or not.
    await expect(
      sendTo.handler({
        input: { kind: "text", connectionId: "local-default", chatId: "42", content: "x" },
        context,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/local connection, which is no destination/);
    expect(sent).toHaveLength(1);
  });

  it("a message polled from getUpdates reaches ingest and admits a task for its bound sender, and only then advances the offset", async () => {
    // Regression test: `MessagingService.openConnection` never registered the
    // connector's inbound handler, so the poll loop ran with none, treated each
    // update as handled and moved the offset past it — every inbound Telegram
    // message was acknowledged and dropped. The inbound acceptance tests call
    // `messaging.ingest` directly, so nothing drove poll → ingest end to end.
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });

    const updates = scriptedUpdates([[textUpdate(500, { chatId: 42, senderId: 8346819670, text: "status please" })]]);
    const model = createFixtureModel({ turns: [{ text: "all projects green" }] });
    const runtime = await composeWithTelegram(directory, tokenFile, updates.fetch, model);
    const repositories = runtime.store.asPort().repositories;
    await bindSender(runtime, "8346819670", "operator");
    updates.release();

    // Asking for 501 is the acknowledgement of 500. Everything below must
    // already be true by then, because the offset moves only after the handler
    // (ingest, and the admission it awaits) has returned.
    await vi.waitFor(() => expect(updates.offsets).toEqual([undefined, 501]), { timeout: 5000 });
    expect((await repositories.messagingInbox.get("telegram-default", "bot:1:chat:42:msg:500"))?.payload).toMatchObject({
      externalSenderId: "8346819670",
      externalConversationId: "42",
      content: "status please",
    });
    const conversation = await repositories.messagingConversations.get("telegram-default", "42");
    expect(conversation).toBeDefined();
    expect((await repositories.tasks.get(conversation?.taskId ?? ""))?.finalText).toBe("all projects green");
    expect(model.calls).toHaveLength(1);
  }, 15_000);

  it("an update whose ingest throws is not acknowledged: the next poll asks for it again, and the redelivery is absorbed as a duplicate", async () => {
    // A sender bound in another workspace, writing in a chat that already maps
    // to this workspace's task, is refused by the task router ("outside this
    // scope"; a member of the same workspace is admitted as quoted data
    // instead). That refusal is a real `ingest` failure, thrown
    // after the inbox row is written, so it exercises what a handler failure
    // does to the poll offset through the real handler rather than a stand-in.
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });

    const refused = textUpdate(501, { chatId: 42, senderId: 222, text: "me too" });
    const updates = scriptedUpdates([
      [textUpdate(500, { chatId: 42, senderId: 111, text: "hello" })],
      [refused],
      // Telegram redelivers from the unadvanced offset.
      [refused],
    ]);
    const model = createFixtureModel({ turns: [{ text: "hello back" }] });
    const runtime = await composeWithTelegram(directory, tokenFile, updates.fetch, model);
    const repositories = runtime.store.asPort().repositories;
    await bindSender(runtime, "111", "operator");
    await bindSender(runtime, "222", "bob", "w2");
    updates.release();

    // 501 is asked for twice: once after 500 was handled, and again after its
    // own ingest threw. Only the redelivery, which `ingest` recognises as a
    // duplicate and does not admit, moves the offset on. The default 2 s poll
    // backoff sits between the second and third call.
    await vi.waitFor(() => expect(updates.offsets).toEqual([undefined, 501, 501, 502]), { timeout: 10_000 });
    expect((await repositories.messagingInbox.get("telegram-default", "bot:1:chat:42:msg:501"))?.payload.content).toBe("me too");
    const conversation = await repositories.messagingConversations.get("telegram-default", "42");
    expect((await repositories.tasks.get(conversation?.taskId ?? ""))?.principalId).toBe("operator");
    expect(model.calls).toHaveLength(1);
  }, 15_000);

  it("a connection whose bot token credential file is missing is reported failed, rather than opened as a broken connector silently", async () => {
    const directory = directories.create();
    const missingTokenFile = join(directory, "does-not-exist");
    const fetchImpl = vi.fn(fakeFetch(async () => jsonResponse({ ok: true, result: { id: 1 } })));

    const runtime = await composeWithTelegram(directory, missingTokenFile, fetchImpl);
    expect(runtime.channels.statusOf("telegram-default")?.state).toBe("failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no Telegram connector opens when `telegram` is not configured — no fetch call at all", async () => {
    const directory = directories.create();
    const fetchImpl = fakeFetch(async () => {
      throw new Error("fetch must never be called when no telegram connector is configured");
    });
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directory, { approvalRequiredFor: [] }), {
      requireModelTransport: false,
      channelFetch: { telegram: fetchImpl },
    });
    runtimes.push(runtime);
    expect(runtime.messaging).toBeDefined();
  });

  it("delivers an approved artifact as a Telegram document through the composed runtime", async () => {
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });

    const fetchImpl = vi.fn(
      fakeFetch(async (url, init) => {
        if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
        if (url.includes("/sendDocument")) return jsonResponse({ ok: true, result: { message_id: 77, date: 0, chat: { id: 1 } } });
        return hangUntilAborted(init?.signal);
      }),
    );

    const runtime = await composeWithTelegram(directory, tokenFile, fetchImpl);
    const pdf = new TextEncoder().encode("%PDF-1.7\ncomposed fixture\n");
    const record = await runtime.store.asPort().repositories.artifacts.putArtifact({
      workspaceId: "default",
      contentType: "application/pdf",
      body: pdf,
      extension: "pdf",
      reviewState: "approved",
    });

    const outcome = (await invokeSendTo(runtime, {
      kind: "file",
      connectionId: "telegram-default",
      chatId: 42,
      artifactId: record.artifactId,
      filename: "daily-brief.pdf",
      caption: "Morning brief",
    })) as { readonly status: string };

    expect(outcome.status).toBe("accepted");
    const documentCall = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(([url]) =>
      String(url).includes("/sendDocument"),
    );
    expect(documentCall).toBeDefined();
    const form = documentCall![1].body as FormData;
    expect(form.get("chat_id")).toBe("42");
    expect(form.get("caption")).toBe("Morning brief");
    const document = form.get("document") as File;
    expect(document.name).toBe("daily-brief.pdf");
    expect(new Uint8Array(await document.arrayBuffer())).toEqual(pdf);
  });

  it("refuses to deliver an artifact that is still pending review, without making any request", async () => {
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });

    const fetchImpl = vi.fn(
      fakeFetch(async (url, init) => {
        if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
        if (url.includes("/sendDocument")) throw new Error("sendDocument must not be called for an unreleased artifact");
        return hangUntilAborted(init?.signal);
      }),
    );

    const runtime = await composeWithTelegram(directory, tokenFile, fetchImpl);
    const record = await runtime.store.asPort().repositories.artifacts.putArtifact({
      workspaceId: "default",
      contentType: "application/pdf",
      body: new TextEncoder().encode("%PDF-1.7\npending\n"),
      extension: "pdf",
      reviewState: "pending",
    });

    const outcome = (await invokeSendTo(runtime, {
      kind: "file",
      connectionId: "telegram-default",
      chatId: 42,
      artifactId: record.artifactId,
    })) as { readonly status: string; readonly parts: readonly { readonly error?: string }[] };

    // The review gate holds: the 64 KiB tool-output archive and anything else
    // an operator has not released must not reach a chat.
    expect(outcome.status).toBe("rejected");
    expect(outcome.parts[0]?.error).toMatch(/not available for delivery/);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/sendDocument"), expect.anything());
  });

  it("refuses to deliver another workspace's artifact by id", async () => {
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });

    const fetchImpl = vi.fn(
      fakeFetch(async (url, init) => {
        if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
        if (url.includes("/sendDocument")) throw new Error("sendDocument must not be called for another workspace's artifact");
        return hangUntilAborted(init?.signal);
      }),
    );

    const runtime = await composeWithTelegram(directory, tokenFile, fetchImpl);
    // `reports.generate` always stores under the invoking workspace, so an
    // artifact in a different workspace cannot come from the legitimate path —
    // only from a model naming an id it happens to know.
    const foreign = await runtime.store.asPort().repositories.artifacts.putArtifact({
      workspaceId: "someone-else",
      contentType: "application/pdf",
      body: new TextEncoder().encode("%PDF-1.7\nforeign\n"),
      extension: "pdf",
      reviewState: "approved",
    });

    const outcome = (await invokeSendTo(runtime, {
      kind: "file",
      connectionId: "telegram-default",
      chatId: 42,
      artifactId: foreign.artifactId,
    })) as { readonly status: string; readonly parts: readonly { readonly error?: string }[] };

    expect(outcome.status).toBe("rejected");
    expect(outcome.parts[0]?.error).toMatch(/not available for delivery/);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/sendDocument"), expect.anything());
  });

  it("refuses a send admitted in a different workspace than the connection's, before reading any artifact", async () => {
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });

    const fetchImpl = vi.fn(
      fakeFetch(async (url, init) => {
        if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
        if (url.includes("/sendDocument")) throw new Error("sendDocument must not be called from a foreign workspace");
        return hangUntilAborted(init?.signal);
      }),
    );

    const runtime = await composeWithTelegram(directory, tokenFile, fetchImpl);
    // An artifact the connection's OWN workspace legitimately owns. The
    // previous test proves a foreign *artifact* is refused; this proves the
    // caller's workspace is the thing being checked — the connection's
    // workspace is the target identity, so relying on it alone would let a
    // task in `w2` deliver `default`'s documents.
    const own = await runtime.store.asPort().repositories.artifacts.putArtifact({
      workspaceId: "default",
      contentType: "application/pdf",
      body: new TextEncoder().encode("%PDF-1.7\nown\n"),
      extension: "pdf",
      reviewState: "approved",
    });

    await expect(
      invokeSendTo(runtime, { kind: "file", connectionId: "telegram-default", chatId: 42, artifactId: own.artifactId }, "someone-else"),
    ).rejects.toThrow(/belongs to workspace default, not someone-else/);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("/sendDocument"), expect.anything());
  });

  it("close() awaits the Telegram connector's own shutdown rather than firing and forgetting it", async () => {
    // Were the `tavi.messaging` plugin's shutdown disposer to `void` the
    // `closeConnection` promise, `PluginHost.stop()` could report a clean drain before the
    // connector's real teardown (aborting the poll loop) had actually
    // finished. This proves `close()` genuinely waits for it: the fake
    // `getUpdates` only rejects a fixed delay *after* observing the abort
    // signal, so if `close()` resolved before that delay elapsed, `stopped`
    // would still be `false` here.
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });

    let stopped = false;
    const fetchImpl = fakeFetch(async (url, init) => {
      if (url.includes("/getMe")) return jsonResponse({ ok: true, result: { id: 1 } });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          setTimeout(() => {
            stopped = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, 20);
        });
      });
    });

    await saveFlaglessTelegram(directory);
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directory, {
        credentials: { "telegram.botToken": { fromFile: tokenFile } },
        approvalRequiredFor: [],
        openSavedChannels: true,
      }),
      { requireModelTransport: false, channelFetch: { telegram: fetchImpl } },
    );

    const report = await runtime.close();
    expect(report.clean).toBe(true);
    expect(stopped).toBe(true);
  });
});

describe("composeTaviRuntime — Telegram groups as rooms", () => {
  it("drops a group nobody listed and names it to the operator; added as a room, its next mention starts a task; Leave calls leaveChat", async () => {
    const directory = directories.create();
    const tokenFile = join(directory, "telegram-token");
    writeFileSync(tokenFile, "test-bot-token\n", { mode: 0o600 });
    const group = { id: -1001, type: "supergroup", title: "Team" };
    const batches: unknown[][] = [
      [
        {
          update_id: 1,
          message: {
            message_id: 1,
            date: 1_700_000_000,
            text: "@tavi_bot hello?",
            entities: [{ type: "mention", offset: 0, length: 9 }],
            chat: group,
            from: { id: 77 },
          },
        },
        {
          update_id: 2,
          my_chat_member: {
            chat: { id: -1002, type: "group", title: "Other" },
            from: { id: 77 },
            date: 1_700_000_000,
            old_chat_member: { status: "left" },
            new_chat_member: { status: "member" },
          },
        },
      ],
      [
        { update_id: 3, message: { message_id: 3, date: 1_700_000_001, text: "just talking", chat: group, from: { id: 77 } } },
        {
          update_id: 4,
          message: {
            message_id: 4,
            date: 1_700_000_002,
            text: "@tavi_bot what's next?",
            entities: [{ type: "mention", offset: 0, length: 9 }],
            chat: group,
            from: { id: 77 },
          },
        },
      ],
    ];
    const gates = batches.map(() => {
      let open = (): void => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    });
    const offsets: (number | undefined)[] = [];
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = fakeFetch(async (url, init) => {
      const method = url.split("/").pop() ?? "";
      if (method === "getMe") return jsonResponse({ ok: true, result: { id: 1, username: "tavi_bot" } });
      if (method === "getUpdates") {
        offsets.push((JSON.parse(String(init?.body)) as { offset?: number }).offset);
        const index = offsets.length - 1;
        const batch = batches[index];
        const gate = gates[index];
        if (batch === undefined || gate === undefined) return hangUntilAborted(init?.signal);
        await Promise.race([gate.opened, hangUntilAborted(init?.signal)]);
        return jsonResponse({ ok: true, result: batch });
      }
      calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return jsonResponse({ ok: true, result: method === "sendMessage" ? { message_id: 900, date: 0, chat: { id: -1001 } } : true });
    });
    const model = createFixtureModel({ turns: [{ text: "next is the review" }] });
    const runtime = await composeWithTelegram(directory, tokenFile, fetchImpl, model);
    const repositories = runtime.store.asPort().repositories;
    await bindSender(runtime, "77", "operator");
    gates[0]?.open();
    await vi.waitFor(() => expect(offsets).toEqual([undefined, 3]), { timeout: 5000 });
    // Nothing of the unlisted group is stored, and no task is started; both rooms wait for the operator.
    expect(await repositories.messagingInbox.get("telegram-default", "bot:1:chat:-1001:msg:1")).toBeUndefined();
    expect(await repositories.messagingConversations.get("telegram-default", "-1001")).toBeUndefined();
    expect(runtime.roomInvitations.list("telegram-default").map((room) => [room.conversationId, room.how])).toEqual([
      ["-1002", "added"],
      ["-1001", "spoke"],
    ]);

    const rooms = {
      repositories,
      channels: runtime.channels,
      messaging: runtime.messaging,
      roomInvitations: runtime.roomInvitations,
      operatorOf: () => "operator",
      now: () => runtime.clock.now(),
    };
    const added = await channelRooms(rooms, {
      action: "rooms",
      workspaceId: "default",
      connectionId: "telegram-default",
      op: "add",
      conversationId: "-1001",
      label: "Team",
    });
    expect(added.rooms).toMatchObject([{ conversationId: "-1001", trigger: ["mention", "reply", "command"], introState: "sent" }]);
    expect(calls.find((call) => call.method === "sendMessage")?.body).toMatchObject({ chat_id: "-1001" });
    await channelRooms(rooms, {
      action: "rooms",
      workspaceId: "default",
      connectionId: "telegram-default",
      op: "leave",
      conversationId: "-1002",
    });
    expect(calls).toContainEqual({ method: "leaveChat", body: { chat_id: "-1002" } });
    expect(runtime.roomInvitations.list("telegram-default")).toEqual([]);

    gates[1]?.open();
    await vi.waitFor(() => expect(offsets).toEqual([undefined, 3, 5]), { timeout: 5000 });
    // The plain message is not addressed and is dropped; the mention starts the room's task, its address taken off.
    expect(await repositories.messagingInbox.get("telegram-default", "bot:1:chat:-1001:msg:3")).toBeUndefined();
    expect((await repositories.messagingInbox.get("telegram-default", "bot:1:chat:-1001:msg:4"))?.payload).toMatchObject({
      content: "what's next?",
      addressed: ["mention"],
    });
    await vi.waitFor(async () => expect(await repositories.messagingConversations.get("telegram-default", "-1001")).toBeDefined(), {
      timeout: 5000,
    });
  }, 20_000);
});

describe("composeTaviRuntime — connections saved in Settings", () => {
  const base = (directory: string) => fixtureRuntimeOptions(directory, { approvalRequiredFor: [] });

  /** Saves an enabled Telegram connection the way Settings → Messaging does, then lets the owner go. */
  async function saveTelegram(directory: string): Promise<void> {
    const runtime = await composeTaviRuntime(base(directory), { requireModelTransport: false });
    try {
      await createLocalCredentialStore(directory).setSecret(channelSecretRef("telegram-default", "token"), "saved-token");
      await runtime.store.asPort().repositories.messagingConnections.save(
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
      await runtime.close();
    }
  }

  it("opens a connection saved in Settings", async () => {
    const directory = directories.create();
    await saveTelegram(directory);
    const updates = scriptedUpdates([]);
    const runtime = await composeTaviRuntime(
      { ...base(directory), openSavedChannels: true },
      { requireModelTransport: false, channelFetch: { telegram: updates.fetch } },
    );
    runtimes.push(runtime);
    expect(runtime.messaging.capabilitiesOf("telegram-default")).toBeDefined();
  });

  it("checks each allowlisted destination against its channel's target shape at startup", async () => {
    const directory = directories.create();
    await saveTelegram(directory);
    const options = (destinations: readonly string[]) => ({
      ...base(directory),
      messagingAllowedDestinations: [...destinations],
      openSavedChannels: true,
    });
    await expect(
      composeTaviRuntime(options(["telegram-default:@somebody"]), {
        requireModelTransport: false,
        channelFetch: { telegram: scriptedUpdates([]).fetch },
      }),
    ).rejects.toThrow(/is not a chat id on Telegram/);
    const runtime = await composeTaviRuntime(options(["telegram-default:42", "-100"]), {
      requireModelTransport: false,
      channelFetch: { telegram: scriptedUpdates([]).fetch },
    });
    runtimes.push(runtime);
  });

  it("applies a Settings save without a restart: a saved channel opens, and closes when disabled", async () => {
    const directory = directories.create();
    const runtime = await composeTaviRuntime(
      { ...base(directory), openSavedChannels: true },
      { requireModelTransport: false, channelFetch: { telegram: scriptedUpdates([]).fetch } },
    );
    runtimes.push(runtime);
    const { messagingConnections } = runtime.store.asPort().repositories;
    expect(runtime.messaging.capabilitiesOf("telegram-default")).toBeUndefined();
    const save = async (enabled: boolean) =>
      messagingConnections.save(
        {
          connectionId: "telegram-default",
          providerId: "telegram",
          workspaceId: "default",
          accountIdentity: "tavi-bot",
          settings: {},
          credentialRefs: { token: channelSecretRef("telegram-default", "token") },
          enabled,
          authState: "none",
        },
        "2026-10-09T00:00:00.000Z",
      );
    await createLocalCredentialStore(directory).setSecret(channelSecretRef("telegram-default", "token"), "saved-token");
    await save(true);
    await runtime.channels.reload();
    expect(runtime.messaging.capabilitiesOf("telegram-default")).toBeDefined();
    expect(runtime.channels.list().map((view) => [view.connectionId, view.label, view.status.state])).toEqual([
      ["telegram-default", "Telegram", "running"],
    ]);
    await save(false);
    await runtime.channels.reload();
    expect(runtime.messaging.capabilitiesOf("telegram-default")).toBeUndefined();
  });
});
