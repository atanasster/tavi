import { describe, expect, it } from "vitest";

import { BOT, ROOM, fakeDiscord, fakeGateway, fakeRest, manualClock, settle, virtualClock } from "../src/discord.js";
import { delay } from "../src/wait.js";

describe("the fake Discord", () => {
  it("answers the REST routes the connector reads, recording each request", async () => {
    const discord = fakeDiscord();
    const me = await discord.fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: "Bot token" } });
    expect(await me.json()).toEqual({ id: BOT, bot: true, username: "tavi" });
    expect(discord.requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /users/@me"]);
    expect(discord.requests[0]?.headers["authorization"]).toBe("Bot token");
  });

  it("refuses a token other than the one it was given", async () => {
    const discord = fakeDiscord({ onlyToken: "right" });
    expect((await discord.fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: "Bot wrong" } })).status).toBe(401);
  });

  it("scripts a gateway socket from the server's side and records what the client sends", async () => {
    const gateway = fakeGateway();
    const socket = gateway.webSocket("wss://gateway.discord.gg");
    const received: unknown[] = [];
    socket.addEventListener("message", (event: { readonly data: unknown }) => received.push(JSON.parse(String(event.data))));
    socket.hello(1_000);
    socket.send(JSON.stringify({ op: 2, d: { token: "t" } }));
    expect(received).toEqual([{ op: 10, d: { heartbeat_interval: 1_000 }, s: null, t: null }]);
    expect(gateway.latest().ops(2)).toHaveLength(1);
    const closes: number[] = [];
    socket.addEventListener("close", (event: { readonly code: number }) => closes.push(event.code));
    socket.close(4000);
    await settle();
    await delay(5);
    expect(closes).toEqual([4000]);
  });

  it("runs timers only when its clock is moved on", async () => {
    const clock = manualClock();
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(clock.now()), 100);
    await clock.advance(99);
    expect(fired).toEqual([]);
    await clock.advance(1);
    expect(fired).toHaveLength(1);
    const rest = virtualClock(0);
    await rest.sleep(250);
    expect(rest.now()).toBe(250);
    expect(rest.slept).toEqual([250]);
  });

  it("serves a scripted REST route with a held answer", async () => {
    let release = (): void => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const rest = fakeRest(() => ({ status: 204, hold }));
    const pending = rest.fetch(`https://discord.com/api/v10/channels/${ROOM}/typing`, { method: "POST" });
    release();
    expect((await pending).status).toBe(204);
    expect(rest.requests[0]?.path).toBe(`/channels/${ROOM}/typing`);
  });
});
