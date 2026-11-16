import type { AddressInfo } from "node:net";

import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { InboundEvent, MessagingConnectorInstance } from "@tavi/contracts";

import { createDiscordConnectorDefinition } from "../src/connector.js";
import { APP, BOT, GUILD, ROOM, TOKEN, fakeDiscord, turns } from "@tavi/test-support/discord";

/**
 * One smoke test over a real socket: a `ws` server on 127.0.0.1, and the connector's own default, Node's
 * global `WebSocket`, carrying Hello, identify, READY and a message through.
 */

const servers: WebSocketServer[] = [];
const instances: MessagingConnectorInstance[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the Discord connector over a real socket", () => {
  it("connects with Node's WebSocket, identifies, and hands over a message once READY", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const frames: { readonly op: number; readonly d?: unknown }[] = [];
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000_000 }, s: null, t: null }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as { readonly op: number; readonly d?: unknown };
        frames.push(frame);
        if (frame.op !== 2) return;
        socket.send(
          JSON.stringify({
            op: 0,
            s: 1,
            t: "READY",
            d: {
              v: 10,
              session_id: "real-session",
              resume_gateway_url: `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
              user: { id: BOT, bot: true, username: "tavi" },
              application: { id: APP },
              guilds: [{ id: GUILD, unavailable: true }],
            },
          }),
        );
        socket.send(
          JSON.stringify({
            op: 0,
            s: 2,
            t: "GUILD_CREATE",
            d: {
              id: GUILD,
              name: "Fixture Guild",
              joined_at: "2026-10-01T00:00:00.000000+00:00",
              channels: [{ id: ROOM, type: 0, name: "general", position: 0 }],
              roles: [],
            },
          }),
        );
        setTimeout(
          () =>
            socket.send(
              JSON.stringify({
                op: 0,
                s: 3,
                t: "MESSAGE_CREATE",
                d: {
                  id: "742000000000000999",
                  channel_id: ROOM,
                  guild_id: GUILD,
                  type: 0,
                  author: { id: "800000000000000001", username: "operator" },
                  content: `<@${BOT}> over a real socket`,
                  mentions: [{ id: BOT, bot: true }],
                  mention_roles: [],
                  attachments: [],
                },
              }),
            ),
          50,
        );
      });
    });
    const discord = fakeDiscord();
    const url = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    // Discord's REST as the fake answers it, but its Gateway here.
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith("/gateway/bot")
        ? new Response(
            JSON.stringify({ url, shards: 1, session_start_limit: { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : discord.fetch(input, init)) as typeof globalThis.fetch;
    const definition = createDiscordConnectorDefinition({ z, version: "0.1.0", fetch });
    const instance = definition.createConnection({
      connection: {
        connectionId: "discord-real",
        providerId: "discord",
        accountIdentity: "tavi",
        workspaceId: "w",
        configRevision: 1,
        enabled: true,
      },
      config: {},
      credentials: { get: async () => TOKEN, accessToken: async () => TOKEN },
    });
    const received: InboundEvent[] = [];
    instance.onInboundEvent?.(async (event) => void received.push(event));
    instances.push(instance);
    await instance.start();
    expect(instance.status()).toMatchObject({ state: "running", accountRef: APP });
    expect(frames.find((frame) => frame.op === 2)?.d).toMatchObject({ token: TOKEN, intents: 4609 });
    for (let wait = 0; wait < 100 && received.length === 0; wait += 1) await turns(20);
    expect(received.at(-1)).toMatchObject({
      kind: "message",
      externalConversationId: ROOM,
      addressed: ["mention"],
      content: "over a real socket",
    });
  });
});
