import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { describeChannelConformance, type ProviderMood } from "@tavi/channel-kit/conformance";
import { createFixtureModel, type ScriptedTurn } from "@tavi/test-support/fakes";
import {
  TaviError,
  type ChannelDescriptor,
  type ChannelsListAnswer,
  type ChannelsPayload,
  type ChannelsSaveAnswer,
  type ReachableChannel,
} from "@tavi/contracts";
import { temporaryDirectories, fakeFetch } from "@tavi/test-support";

import { createWhatsappLikeDefinition } from "../../../../tests/fixtures/channel-whatsapp-like/index.mjs";
import manifest from "../../../../tests/fixtures/channel-whatsapp-like/tavi-plugin.json" with { type: "json" };
import { channelsCommand } from "../../src/features/channels/owner.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { SqliteStore } from "../support/database-fixture.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * A WhatsApp-shaped channel added only by a plugin: it passes the conformance suite, and through a
 * composed owner it is configured over IPC, listed, told to the agent, takes
 * in a verified delivery at its one provider-level address, admits only an
 * allowed sender, is replied to, is sent to with `send_to`, records delivery
 * statuses, takes in media, and says when the service window is closed.
 */

const FIXTURE = join(import.meta.dirname, "..", "..", "..", "..", "tests", "fixtures", "channel-whatsapp-like");
const descriptor = (manifest as unknown as { channels: ChannelDescriptor[] }).channels[0] as ChannelDescriptor;
const PHONE = "1029384756";
const SECRET = "app-s3cret";

const hang = (signal?: AbortSignal | null): Promise<Response> =>
  new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

function fakeGraph(mood: ProviderMood): typeof fetch {
  return fakeFetch(async (_url, init) => {
    if (mood === "hang") return hang(init?.signal);
    if (mood === "echo") throw new TypeError(`fetch failed with ${JSON.stringify(init?.headers)}`);
    if (mood === "garbled") return new Response("<html>proxy page</html>", { status: 200 });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
  });
}

describeChannelConformance("WhatsApp-like (fixture plugin)", {
  descriptor,
  provider: fakeGraph,
  create: (fetch) => createWhatsappLikeDefinition({ z, TaviError, fetch }),
  connection: {
    connectionId: "wa-conformance",
    providerId: "wa-like",
    accountIdentity: PHONE,
    workspaceId: "w",
    configRevision: 1,
    enabled: true,
  },
  config: { phoneNumberId: PHONE, apiBaseUrl: "https://graph.test/v20.0", requestTimeoutMs: 30 },
  secret: "EAAG-s3cret-token",
  target: "+15551234567",
});

const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});

/** A request as the ingress listener takes it; its body arrives once the handler listens. */
function request(method: string, url: string, body = "", headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string>; destroy: () => void };
  Object.assign(req, { method, url, headers, destroy: () => {} });
  setImmediate(() => {
    if (body !== "") req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req as unknown as IncomingMessage;
}

async function deliver(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  method: string,
  url: string,
  body = "",
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const state = { status: 200, body: "" };
    const res = {
      setHeader: () => {},
      writeHead: (status: number) => {
        state.status = status;
      },
      set statusCode(value: number) {
        state.status = value;
      },
      get statusCode() {
        return state.status;
      },
      end: (chunk?: string) => {
        state.body = chunk ?? "";
        resolve(state);
      },
    };
    listener(request(method, url, body, headers), res as unknown as ServerResponse);
  });
}

const signed = (body: string): Record<string, string> => ({
  "content-type": "application/json",
  "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
});
const webhook = (value: Record<string, unknown>) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "biz",
        changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: PHONE }, ...value } }],
      },
    ],
  });

describe("a WhatsApp-like channel added only by a plugin", () => {
  it("is configured, told to the agent, receives verified mail at its provider address, replies, sends, records delivery and refuses outside the window", async () => {
    const dataDirectory = dirs.create("tavi-walike-");
    // The provider: the Graph API's message and media endpoints.
    const sent: { to: string; text?: string; buttons?: number }[] = [];
    let throttled = 0;
    const graph = fakeFetch(async (url, init) => {
      if (url.endsWith(`/${PHONE}/messages`)) {
        const body = JSON.parse(String(init?.body)) as {
          to: string;
          text?: { body: string };
          interactive?: { action: { buttons: unknown[] } };
        };
        // The first `send_to` is throttled once: the host waits and sends it again.
        if (body.text?.body === "a note" && throttled++ === 0)
          return new Response(JSON.stringify({ error: { code: 130429 } }), { status: 429, headers: { "retry-after": "0" } });
        if (body.to === "15550000999")
          return new Response(JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }), { status: 400 });
        sent.push({
          to: body.to,
          ...(body.text === undefined ? {} : { text: body.text.body }),
          ...(body.interactive === undefined ? {} : { buttons: body.interactive.action.buttons.length }),
        });
        return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }));
      }
      if (url === "https://lookaside.test/media-1")
        return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
      if (url.endsWith("/media-1")) return new Response(JSON.stringify({ url: "https://lookaside.test/media-1" }));
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", graph);

    const compose = async (model?: ReturnType<typeof createFixtureModel>): Promise<TaviRuntime> => {
      const runtime = await composeTaviRuntime(
        fixtureRuntimeOptions(dataDirectory, {
          approvalRequiredFor: [],
          scheduleSweepEnabled: false,
          openSavedChannels: true,
          messagingAllowedDestinations: ["*:+15551234567", "*:+15550000999"],
        }),
        {
          requireModelTransport: false,
          ...(model === undefined ? {} : { modelOverride: model }),
          ingressCreateServerOverride: (listener) => {
            captured.listener = listener;
            return fakeServer();
          },
        },
      );
      runtimes.push(runtime);
      return runtime;
    };
    const captured: { listener?: (req: IncomingMessage, res: ServerResponse) => void } = {};
    try {
      const setup = await compose();
      await setup.plugins.registry.install(FIXTURE, "operator");
      await setup.plugins.registry.decide("fixture.walike", "1.0.0", "approved", "operator");
      await setup.plugins.registry.configure("fixture.walike", {}, [], "operator");
      await setup.plugins.registry.enable("fixture.walike", "operator");
      runtimes.splice(runtimes.indexOf(setup), 1);
      await setup.close();

      // The agent answers a message by replying in its conversation.
      const model = createFixtureModel({
        turns: [{ toolCalls: [{ id: "reply", name: "messaging.send", input: { content: "pong" } }] }, { text: "replied" }],
      });
      const runtime = await compose(model);
      const run = async <T>(payload: ChannelsPayload): Promise<T> =>
        (
          await channelsCommand(
            {
              dataDirectory,
              repositories: runtime.store.asPort().repositories,
              channels: runtime.channels,
              messaging: runtime.messaging,
              reload: (workspaceId) => runtime.reloadChannels(workspaceId),
              applyIngress: () => runtime.applyIngress(),
              pairings: runtime.pairings,
              oauth: runtime.oauthFlows,
              revokeToken: (connection) => runtime.oauthBroker.revoke(connection),
              now: () => runtime.clock.now(),
            },
            payload,
          )
        ).result as T;

      // Configured over IPC from its descriptor alone, and listed.
      expect(
        (await run<{ channels: { providerId: string }[] }>({ action: "catalog" })).channels.map((channel) => channel.providerId),
      ).toContain("wa-like");
      const saved = await run<ChannelsSaveAnswer>({
        action: "save",
        workspaceId: "default",
        providerId: "wa-like",
        enabled: true,
        settings: { phoneNumberId: PHONE },
        secrets: { accessToken: "EAAG-token", appSecret: SECRET, verifyToken: "verify-me" },
      });
      expect(saved).not.toHaveProperty("notApplied");
      expect((await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).connections[0]).toMatchObject({
        connectionId: saved.connectionId,
        accountIdentity: PHONE,
        status: { state: "running" },
      });

      // Told to the agent: what it is, what a message carries, who it may send to.
      const reachable = (await runtime.tools.get("messaging.channels")?.handler({
        input: {},
        context: { workspaceId: "default", principalId: "operator", runId: "r", caller: "cli" },
        signal: new AbortController().signal,
      })) as { channels: ReachableChannel[] };
      expect(reachable.channels).toEqual([
        expect.objectContaining({
          connectionId: saved.connectionId,
          channel: "WhatsApp-like",
          buttons: true,
          allowedTargets: ["+15551234567", "+15550000999"],
        }),
      ]);

      // Its one provider-level address: the verify challenge, then a signed delivery.
      const listener = captured.listener;
      if (listener === undefined) throw new Error("the ingress did not listen");
      expect(
        await deliver(listener, "GET", "/hooks/p/wa-like/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=4242"),
      ).toEqual({ status: 200, body: "4242" });
      expect(
        (await deliver(listener, "GET", "/hooks/p/wa-like/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status,
      ).toBe(403);
      // A second number with a verify token of its own passes the handshake too: each connection's own check is asked.
      await run<ChannelsSaveAnswer>({
        action: "save",
        workspaceId: "default",
        providerId: "wa-like",
        enabled: true,
        settings: { phoneNumberId: "5647382910" },
        secrets: { accessToken: "EAAG-token-2", appSecret: SECRET, verifyToken: "verify-two" },
      });
      expect(
        await deliver(listener, "GET", "/hooks/p/wa-like/webhook?hub.mode=subscribe&hub.verify_token=verify-two&hub.challenge=77"),
      ).toEqual({ status: 200, body: "77" });
      const forged = webhook({
        messages: [{ id: "wamid.in.0", from: "15551234567", type: "text", text: { body: "forged" }, timestamp: "1" }],
      });
      expect(
        (
          await deliver(listener, "POST", "/hooks/p/wa-like/webhook", forged, {
            "content-type": "application/json",
            "x-hub-signature-256": "sha256=00",
          })
        ).status,
      ).toBe(403);

      // A sender nobody allowed is held; an allowed one starts a turn the agent replies in.
      const stranger = webhook({
        messages: [{ id: "wamid.in.1", from: "15559998888", type: "text", text: { body: "hi" }, timestamp: "1" }],
      });
      expect((await deliver(listener, "POST", "/hooks/p/wa-like/webhook", stranger, signed(stranger))).status).toBe(200);
      expect(model.calls).toHaveLength(0);
      await run({
        action: "allow",
        workspaceId: "default",
        connectionId: saved.connectionId,
        sender: "+1 (555) 123-4567",
        principalId: "operator",
      });
      const ping = webhook({ messages: [{ id: "wamid.in.2", from: "15551234567", type: "text", text: { body: "ping" }, timestamp: "1" }] });
      expect((await deliver(listener, "POST", "/hooks/p/wa-like/webhook", ping, signed(ping))).status).toBe(200);
      await vi.waitFor(() => expect(sent).toContainEqual({ to: "15551234567", text: "pong" }), { timeout: 10_000 });

      // Sent to by `send_to`, as the operator allowed; outside the service window, said so.
      const sendTo = (to: string) =>
        runtime.tools.get("messaging.send_to")?.handler({
          input: { kind: "text", connectionId: saved.connectionId, to, content: "a note" },
          context: { workspaceId: "default", principalId: "operator", runId: "r", caller: "scheduler" },
          signal: new AbortController().signal,
        });
      expect(await sendTo("+15551234567")).toMatchObject({ status: "accepted" });
      expect(throttled).toBe(2);
      expect(await sendTo("+15550000999")).toMatchObject({
        status: "rejected",
        parts: [{ error: expect.stringMatching(/24-hour customer-service window/) }],
      });

      // Its delivery statuses are recorded on the send they name.
      const repositories = runtime.store.asPort().repositories;
      const delivered = webhook({ statuses: [{ id: "wamid.2", status: "read", recipient_id: "15551234567" }] });
      expect((await deliver(listener, "POST", "/hooks/p/wa-like/webhook", delivered, signed(delivered))).status).toBe(200);
      // A status only moves forward, so a later "delivered" names the send and leaves its "read".
      const named = await repositories.messagingOutbox.recordDelivery({
        connectionId: saved.connectionId,
        providerMessageId: "wamid.2",
        status: "delivered",
        at: "2026-10-09T00:00:00.000Z",
      });
      expect((await repositories.messagingOutbox.get(named?.effectId ?? ""))?.delivery?.status).toBe("read");

      // A signed delivery that is not the provider's shape is refused as such.
      const foreign = JSON.stringify({ object: "page", entry: [{ changes: [{ value: { metadata: { phone_number_id: PHONE } } }] }] });
      expect((await deliver(listener, "POST", "/hooks/p/wa-like/webhook", foreign, signed(foreign))).status).toBe(400);

      // Media by id: fetched by the host for an allowed sender, kept as an untrusted artifact.
      const photo = webhook({
        messages: [
          {
            id: "wamid.in.3",
            from: "15551234567",
            type: "image",
            image: { id: "media-1", mime_type: "image/png", caption: "look" },
            timestamp: "2",
          },
        ],
      });
      expect((await deliver(listener, "POST", "/hooks/p/wa-like/webhook", photo, signed(photo))).status).toBe(200);
      const kept = (await repositories.messagingInbox.get(saved.connectionId, "wamid.in.3"))?.payload.attachments?.[0];
      expect(await repositories.artifacts.getArtifact(kept?.artifactId ?? "")).toMatchObject({ contentType: "image/png", untrusted: true });

      // Each admitted message is noted for the heartbeat's unanswered-messages signal: the conversation's newest,
      // from whom, and its chat; the held stranger's is not.
      const reader = await SqliteStore.open({
        databasePath: join(dataDirectory, "tavi.sqlite"),
        artifactsDirectory: join(dataDirectory, "artifacts"),
      });
      try {
        const noted = reader.handle
          .prepare(
            "SELECT connection_id, conversation_key, sender_principal_id, provider_event_id, task_id FROM tavi_messaging_inbound_activity",
          )
          .all() as {
          connection_id: string;
          conversation_key: string;
          sender_principal_id: string;
          provider_event_id: string;
          task_id: string | null;
        }[];
        const chat = reader.handle
          .prepare("SELECT external_conversation_id, task_id FROM tavi_messaging_conversation_tasks WHERE connection_id = ? AND active = 1")
          .get(saved.connectionId) as { external_conversation_id: string; task_id: string } | undefined;
        expect(noted).toEqual([
          {
            connection_id: saved.connectionId,
            conversation_key: chat?.external_conversation_id,
            sender_principal_id: "operator",
            provider_event_id: "wamid.in.3",
            task_id: chat?.task_id,
          },
        ]);
      } finally {
        await reader.close();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

/** A server that never binds a port: the ingress's listener is captured instead. */
function fakeServer() {
  const emitter = new EventEmitter() as EventEmitter & {
    listen: (...args: unknown[]) => unknown;
    close: (callback?: () => void) => unknown;
    address: () => unknown;
  };
  emitter.listen = (...args: unknown[]) => {
    const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
    setImmediate(() => {
      callback?.();
      emitter.emit("listening");
    });
    return emitter;
  };
  emitter.close = (callback?: () => void) => {
    setImmediate(() => callback?.());
    return emitter;
  };
  emitter.address = () => ({ address: "127.0.0.1", port: 8025, family: "IPv4" });
  return emitter as unknown as import("node:http").Server;
}

describe("a person allowed under a principal of their own", () => {
  it("talks to the agent with the workspace's grant, and only the operator decides their task's approvals", async () => {
    const dataDirectory = dirs.create("tavi-walike-people-");
    const sent: { to: string; text: string; buttons: number }[] = [];
    vi.stubGlobal(
      "fetch",
      fakeFetch(async (url, init) => {
        if (!url.endsWith(`/${PHONE}/messages`)) return new Response("{}", { status: 404 });
        const body = JSON.parse(String(init?.body)) as {
          to: string;
          text?: { body: string };
          interactive?: { body: { text: string }; action: { buttons: unknown[] } };
        };
        sent.push({
          to: body.to,
          text: body.text?.body ?? body.interactive?.body.text ?? "",
          buttons: body.interactive?.action.buttons.length ?? 0,
        });
        return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }));
      }),
    );
    // Ana's turn sends to Bo, which waits for approval; once decided, it ends.
    const turns: ScriptedTurn[] = [{ text: "(not yet)" }];
    const captured: { listener?: (req: IncomingMessage, res: ServerResponse) => void } = {};
    const compose = async (model?: ReturnType<typeof createFixtureModel>): Promise<TaviRuntime> => {
      const runtime = await composeTaviRuntime(
        fixtureRuntimeOptions(dataDirectory, {
          scheduleSweepEnabled: false,
          openSavedChannels: true,
          messagingAllowedDestinations: ["*:+15550000999"],
        }),
        {
          requireModelTransport: false,
          ...(model === undefined ? {} : { modelOverride: model }),
          ingressCreateServerOverride: (listener) => {
            captured.listener = listener;
            return fakeServer();
          },
        },
      );
      runtimes.push(runtime);
      return runtime;
    };
    try {
      const setup = await compose();
      await setup.plugins.registry.install(FIXTURE, "operator");
      await setup.plugins.registry.decide("fixture.walike", "1.0.0", "approved", "operator");
      await setup.plugins.registry.configure("fixture.walike", {}, [], "operator");
      await setup.plugins.registry.enable("fixture.walike", "operator");
      runtimes.splice(runtimes.indexOf(setup), 1);
      await setup.close();

      const model = createFixtureModel({ turns });
      const runtime = await compose(model);
      const run = async <T>(payload: ChannelsPayload): Promise<T> =>
        (
          await channelsCommand(
            {
              dataDirectory,
              repositories: runtime.store.asPort().repositories,
              channels: runtime.channels,
              messaging: runtime.messaging,
              reload: (workspaceId) => runtime.reloadChannels(workspaceId),
              applyIngress: () => runtime.applyIngress(),
              pairings: runtime.pairings,
              oauth: runtime.oauthFlows,
              revokeToken: (connection) => runtime.oauthBroker.revoke(connection),
              now: () => runtime.clock.now(),
            },
            payload,
          )
        ).result as T;
      const saved = await run<ChannelsSaveAnswer>({
        action: "save",
        workspaceId: "default",
        providerId: "wa-like",
        enabled: true,
        settings: { phoneNumberId: PHONE },
        secrets: { accessToken: "EAAG-token", appSecret: SECRET, verifyToken: "verify-me" },
      });
      turns.splice(
        0,
        turns.length,
        {
          toolCall: {
            id: "note",
            name: "messaging.send_to",
            input: { kind: "text", connectionId: saved.connectionId, to: "+15550000999", content: "Ana says hi" },
          },
        },
        { text: "done" },
      );
      // Ana under her own principal; the operator's own number under the workspace's.
      await run({
        action: "allow",
        workspaceId: "default",
        connectionId: saved.connectionId,
        sender: "+15551234567",
        principalId: "ana",
        name: "Ana",
      });
      await run({
        action: "allow",
        workspaceId: "default",
        connectionId: saved.connectionId,
        sender: "+15550000999",
        principalId: "operator",
      });
      const listener = captured.listener;
      if (listener === undefined) throw new Error("the ingress did not listen");
      const say = async (id: string, from: string, text: string) => {
        const body = webhook({ messages: [{ id, from, type: "text", text: { body: text }, timestamp: "1" }] });
        expect((await deliver(listener, "POST", "/hooks/p/wa-like/webhook", body, signed(body))).status).toBe(200);
      };

      // Her message is a turn of her own, with the workspace's grant: its round is shown to her as the operator's to decide.
      await say("wamid.in.1", "15551234567", "tell Bo hi");
      await vi.waitFor(
        () => expect(sent.some((message) => message.to === "15551234567" && message.text.includes("Waiting for the operator"))).toBe(true),
        { timeout: 10_000 },
      );
      const notice = sent.find((message) => message.text.includes("Waiting for the operator"));
      expect(notice).toMatchObject({ buttons: 0 });
      expect(notice?.text).not.toMatch(/Reply: approve/);
      const repositories = runtime.store.asPort().repositories;
      const taskId = (await repositories.messagingConversations.get(saved.connectionId, "+15551234567"))?.taskId ?? "";
      expect((await repositories.tasks.get(taskId))?.principalId).toBe("ana");
      const round = (await repositories.approvalRounds.listForTask(taskId))[0];
      if (round === undefined) throw new Error("no round");

      // She cannot decide it, even by its token.
      await say("wamid.in.2", "15551234567", `approve ${round.token}`);
      await vi.waitFor(
        () =>
          expect(
            sent.some((message) => message.to === "15551234567" && message.text.includes("The operator decides this task's approvals")),
          ).toBe(true),
        { timeout: 10_000 },
      );
      expect(sent.some((message) => message.to === "15550000999" && message.text === "Ana says hi")).toBe(false);

      // The operator decides it from their own chat, by its token; the send goes out, in Ana's task.
      await say("wamid.in.3", "15550000999", `approve ${round.token}`);
      await vi.waitFor(() => expect(sent).toContainEqual({ to: "15550000999", text: "Ana says hi", buttons: 0 }), { timeout: 10_000 });
      await vi.waitFor(async () => expect((await repositories.tasks.get(taskId))?.status).toBe("completed"), { timeout: 10_000 });

      // Revoked, she no longer acts: her next message is held, and starts nothing.
      const calls = model.calls.length;
      await run({ action: "revoke", workspaceId: "default", connectionId: saved.connectionId, sender: "+15551234567" });
      await say("wamid.in.4", "15551234567", "again");
      expect(model.calls).toHaveLength(calls);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);
});
