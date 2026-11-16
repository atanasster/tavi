import { describe, expect, it } from "vitest";

import {
  DISCORD_INTENTS,
  Gateway,
  IDENTIFY_BUDGET_PER_DAY,
  SENDS_PER_MINUTE,
  type GatewayDispatch,
  type GatewayState,
} from "../src/gateway.js";
import { fakeGateway, manualClock, settle } from "@tavi/test-support/discord";

/** Discord's Gateway client. */

const TOKEN = "MTIz.Gw.s3cret";

function harness(
  options: {
    readonly startsRemaining?: number;
    readonly failOn?: (dispatch: GatewayDispatch) => boolean;
    readonly identifies?: number[];
    readonly hold?: (dispatch: GatewayDispatch) => Promise<void> | undefined;
  } = {},
) {
  const gateway = fakeGateway();
  const clock = manualClock();
  const handled: GatewayDispatch[] = [];
  const arrived: GatewayDispatch[] = [];
  const states: GatewayState[] = [];
  let lookups = 0;
  const client = new Gateway({
    token: TOKEN,
    ...(options.identifies === undefined ? {} : { identifies: options.identifies }),
    gatewayBot: async () => {
      lookups += 1;
      return { url: "wss://gateway.discord.gg", sessionStartsRemaining: options.startsRemaining ?? 1000 };
    },
    webSocket: gateway.webSocket,
    clock,
    onDispatch: async (dispatch) => {
      await options.hold?.(dispatch);
      if (options.failOn?.(dispatch) === true) throw new Error("the host could not take it");
      handled.push(dispatch);
    },
    onArrival: (dispatch) => void arrived.push(dispatch),
    onState: (state) => states.push(state),
  });
  return { gateway, clock, handled, arrived, states, client, lookups: () => lookups };
}

/** Starts the client and answers its first connection with Hello and READY. */
async function started(options: Parameters<typeof harness>[0] = {}, interval = 40_000) {
  const run = harness(options);
  const start = run.client.start();
  await settle();
  run.gateway.latest().hello(interval);
  run.gateway.latest().ready(1);
  await start;
  return run;
}

describe("Discord Gateway", () => {
  it("identifies with its three intents and the channel-id opt-in, and heartbeats first at a random point of the interval", async () => {
    const { gateway, clock, client } = await started();
    const socket = gateway.latest();
    expect(socket.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    expect(socket.ops(2)[0]?.d).toMatchObject({ token: TOKEN, intents: DISCORD_INTENTS, capabilities: 1 << 15 });
    expect(DISCORD_INTENTS).toBe(4609);
    await clock.advance(19_999);
    expect(socket.ops(1)).toHaveLength(0);
    await clock.advance(1);
    expect(socket.ops(1)).toEqual([{ op: 1, d: 1 }]);
    // Discord asks for a beat: answered at once.
    socket.frame(1);
    expect(socket.ops(1)).toHaveLength(2);
    client.stop();
  });

  it("drops a message that is not a Gateway payload and goes on reading the next", async () => {
    const { gateway, client, handled } = await started();
    const socket = gateway.latest();
    for (const text of [
      "null",
      "[]",
      "42",
      '"text"',
      "{}",
      '{"op":"0"}',
      '{"op":0,"s":"2","t":"MESSAGE_CREATE"}',
      '{"op":0,"s":2,"t":7}',
      "{not json",
    ])
      socket.raw(text);
    socket.dispatch("MESSAGE_CREATE", { id: "2" }, 2);
    await settle();
    expect(handled.map((dispatch) => dispatch.s)).toEqual([2]);
    expect(socket.closedWith).toBeUndefined();
    client.stop();
  });

  it("closes a zombie connection and resumes on a fresh one", async () => {
    const { gateway, clock, client } = await started();
    const first = gateway.latest();
    await clock.advance(20_000);
    // No ack for that beat: at the next one, the connection is a zombie.
    await clock.advance(40_000);
    expect(first.closedWith).toBe(4900);
    await clock.advance(0);
    const second = gateway.latest();
    expect(second).not.toBe(first);
    expect(second.url).toBe("wss://resume.discord.gg/?v=10&encoding=json");
    second.hello();
    expect(second.ops(6)[0]?.d).toEqual({ token: TOKEN, session_id: "session-1", seq: 1 });
    client.stop();
  });

  it("resumes after a drop from the last event, takes the replay, and hands nothing over twice", async () => {
    const { gateway, clock, client, handled, lookups } = await started();
    const first = gateway.latest();
    for (let seq = 2; seq <= 42; seq += 1) first.dispatch("MESSAGE_CREATE", { id: String(seq) }, seq);
    await settle();
    first.drop(1006);
    await clock.advance(0);
    const second = gateway.latest();
    second.hello();
    expect(second.ops(6)[0]?.d).toMatchObject({ session_id: "session-1", seq: 42 });
    // Discord replays from 43, then says the session is resumed.
    second.dispatch("MESSAGE_CREATE", { id: "43" }, 43);
    second.dispatch("RESUMED", {}, 44);
    await settle();
    expect(handled.map((dispatch) => dispatch.s)).toEqual(Array.from({ length: 42 }, (_, index) => index + 2));
    // A resume reads no new Gateway address.
    expect(lookups()).toBe(1);
    client.stop();
  });

  it("replays a dispatch the host failed to take, by resuming from the one before it", async () => {
    let failures = 0;
    const { gateway, clock, client, handled } = await started({ failOn: (dispatch) => dispatch.s === 43 && failures++ === 0 });
    const first = gateway.latest();
    first.dispatch("MESSAGE_CREATE", { id: "42" }, 42);
    first.dispatch("MESSAGE_CREATE", { id: "43" }, 43);
    first.dispatch("MESSAGE_CREATE", { id: "44" }, 44);
    await settle();
    expect(first.closedWith).toBe(4900);
    // The resume waits a moment (1 s with jitter), so a fault that lasts never makes a loop of resumes.
    await clock.advance(0);
    expect(gateway.latest()).toBe(first);
    await clock.advance(1000);
    const second = gateway.latest();
    second.hello();
    expect(second.ops(6)[0]?.d).toMatchObject({ seq: 42 });
    second.dispatch("MESSAGE_CREATE", { id: "43" }, 43);
    second.dispatch("MESSAGE_CREATE", { id: "44" }, 44);
    await settle();
    expect(handled.map((dispatch) => dispatch.s)).toEqual([42, 43, 44]);
    client.stop();
  });

  it("waits longer before each resume while the host keeps failing a dispatch, and at once again once it takes one", async () => {
    let failures = 0;
    const { gateway, clock, client, handled } = await started({ failOn: (dispatch) => dispatch.s === 43 && failures++ < 3 });
    const waits: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const socket = gateway.latest();
      socket.dispatch("MESSAGE_CREATE", { id: "43" }, 43);
      await settle();
      expect(socket.closedWith).toBe(4900);
      // How long until the next socket opens, in steps of 250 ms.
      let waited = 0;
      while (gateway.latest() === socket) {
        await clock.advance(250);
        waited += 250;
      }
      waits.push(waited);
      gateway.latest().hello();
      gateway.latest().dispatch("RESUMED", {}, 42);
      await settle();
    }
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
    expect(waits[2]).toBeGreaterThan(waits[1] ?? 0);
    gateway.latest().dispatch("MESSAGE_CREATE", { id: "43" }, 43);
    await settle();
    expect(handled.map((dispatch) => dispatch.s)).toEqual([43]);
    client.stop();
  });

  it("shows each dispatch as it arrives, while an earlier one is still being handled, and a replayed one only once", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { gateway, client, handled, arrived } = await started({ hold: (dispatch) => (dispatch.s === 42 ? held : undefined) });
    gateway.latest().dispatch("MESSAGE_CREATE", { id: "42" }, 42);
    gateway.latest().dispatch("INTERACTION_CREATE", { id: "press" }, 43);
    await settle();
    expect(arrived.map((dispatch) => dispatch.s)).toEqual([42, 43]);
    expect(handled).toEqual([]);
    release();
    await settle();
    expect(handled.map((dispatch) => dispatch.s)).toEqual([42, 43]);
    // Discord sending one already handled again is not shown again.
    gateway.latest().dispatch("INTERACTION_CREATE", { id: "press" }, 43);
    await settle();
    expect(arrived).toHaveLength(2);
    client.stop();
  });

  it("resumes when asked to reconnect or told the session can resume; identifies again 1–5 s after one that cannot", async () => {
    const { gateway, clock, client } = await started();
    gateway.latest().frame(7);
    await settle();
    await clock.advance(0);
    gateway.latest().hello();
    expect(gateway.latest().ops(6)).toHaveLength(1);
    gateway.latest().dispatch("RESUMED", {}, 2);
    gateway.latest().frame(9, true);
    await settle();
    await clock.advance(0);
    gateway.latest().hello();
    expect(gateway.latest().ops(6)).toHaveLength(1);
    gateway.latest().dispatch("RESUMED", {}, 3);
    const before = gateway.sockets.length;
    gateway.latest().frame(9, false);
    await clock.advance(999);
    expect(gateway.sockets).toHaveLength(before);
    await clock.advance(3000);
    expect(gateway.sockets).toHaveLength(before + 1);
    expect(gateway.latest().url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    gateway.latest().hello();
    expect(gateway.latest().ops(2)).toHaveLength(1);
    client.stop();
  });

  it("never retries a refused token (4004) or a missing intent (4014), and names their repair", async () => {
    for (const [code, repair] of [
      [4004, "credentials"],
      [4014, "provider-settings"],
    ] as const) {
      const { gateway, clock, states } = await started();
      gateway.latest().drop(code);
      await clock.advance(120_000);
      expect(gateway.sockets).toHaveLength(1);
      expect(states.at(-1)).toMatchObject({ state: "failed", repair });
    }
  });

  it("fails start on a refused token before READY", async () => {
    const run = harness();
    const start = run.client.start();
    await settle();
    run.gateway.latest().hello();
    run.gateway.latest().drop(4004);
    await expect(start).rejects.toMatchObject({ repair: "credentials" });
  });

  it("reconnects at once after a healthy session, then backs off 1 s doubling to 60 s while attempts fail, resumable or not", async () => {
    const { gateway, clock, client } = await started();
    gateway.latest().drop(1006);
    await clock.advance(0);
    expect(gateway.sockets).toHaveLength(2);
    // An outage: each attempt fails before it is ready, and waits longer (jitter at its midpoint, 0.75 of the step).
    const waits: number[] = [];
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const count = gateway.sockets.length;
      gateway.latest().drop(1006);
      let waited = 0;
      while (gateway.sockets.length === count) {
        await clock.advance(250);
        waited += 250;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([750, 1500, 3000, 6000, 12_000, 24_000, 45_000, 45_000, 45_000]);
    client.stop();
  });

  it("keeps a session whose beats are acked", async () => {
    const { gateway, clock, client } = await started();
    const socket = gateway.latest();
    for (let beat = 0; beat < 5; beat += 1) {
      await clock.advance(40_000);
      socket.ack();
    }
    expect(socket.closedWith).toBeUndefined();
    expect(socket.ops(1).length).toBeGreaterThanOrEqual(5);
    client.stop();
  });

  it("fails without retrying on 4013 and on 4010–4012, 4013 naming the provider's settings", async () => {
    for (const code of [4010, 4011, 4012, 4013]) {
      const { gateway, clock, states } = await started();
      gateway.latest().drop(code);
      await clock.advance(120_000);
      expect(gateway.sockets).toHaveLength(1);
      expect(states.at(-1)).toMatchObject({ state: "failed", ...(code === 4013 ? { repair: "provider-settings" } : {}) });
    }
  });

  it("settles start() when stopped first, or when Discord cannot be reached", async () => {
    const run = harness();
    const start = run.client.start();
    run.client.stop();
    await expect(start).rejects.toThrow(/stopped/);
    const unreachable = new Gateway({
      token: TOKEN,
      gatewayBot: async () => {
        throw new Error("getaddrinfo ENOTFOUND discord.com");
      },
      webSocket: fakeGateway().webSocket,
      clock: manualClock(),
      onDispatch: async () => undefined,
      onState: () => undefined,
    });
    await expect(unreachable.start()).rejects.toThrow(/ENOTFOUND/);
  });

  it("keeps the bot's ids through a resume", async () => {
    const { gateway, clock, client, states } = await started();
    gateway.latest().drop(1006);
    await clock.advance(0);
    gateway.latest().hello();
    gateway.latest().dispatch("RESUMED", {}, 2);
    expect(states.at(-1)).toEqual({
      state: "ready",
      botUserId: "900000000000000001",
      applicationId: "900000000000000002",
      resumed: true,
      guildIds: [],
    });
    client.stop();
  });

  it("keeps to its identify budget, and refuses when Discord's session starts run low", async () => {
    const { gateway, clock, states, client } = await started();
    for (let index = 1; index < IDENTIFY_BUDGET_PER_DAY; index += 1) {
      gateway.latest().frame(9, false);
      await clock.advance(5000);
      gateway.latest().hello();
    }
    expect(gateway.sockets.flatMap((socket) => socket.ops(2))).toHaveLength(IDENTIFY_BUDGET_PER_DAY);
    gateway.latest().frame(9, false);
    await clock.advance(5000);
    gateway.latest().hello();
    expect(states.at(-1)).toMatchObject({ state: "failed" });
    client.stop();
    const low = harness({ startsRemaining: 5 });
    await expect(low.client.start()).rejects.toThrow(/session starts/);
  });

  it("counts its identify budget across the application's starts, not per connection", async () => {
    // A day's identifies already spent by earlier starts of the same application.
    const log: number[] = Array.from({ length: IDENTIFY_BUDGET_PER_DAY }, () => Date.parse("2026-10-18T00:00:00.000Z") - 1000);
    const again = harness({ identifies: log });
    const start = again.client.start();
    await settle();
    again.gateway.latest().hello();
    await expect(start).rejects.toThrow(/identified 50 times in a day/);
    expect(again.gateway.latest().ops(2)).toHaveLength(0);
    // A day later, they have lapsed.
    const later: number[] = Array.from({ length: IDENTIFY_BUDGET_PER_DAY }, () => Date.parse("2026-10-17T00:00:00.000Z"));
    const fresh = harness({ identifies: later });
    const started_ = fresh.client.start();
    await settle();
    fresh.gateway.latest().hello();
    fresh.gateway.latest().ready(1);
    await started_;
    expect(later).toHaveLength(1);
    fresh.client.stop();
  });

  it(`sends at most ${String(SENDS_PER_MINUTE)} frames a minute, the rest after`, async () => {
    // A long heartbeat interval, so no beat of its own falls in the minute measured.
    const { gateway, clock, client } = await started({}, 1_000_000);
    const socket = gateway.latest();
    for (let index = 0; index < 120; index += 1) socket.frame(1);
    // The identify was one of the minute's sends.
    expect(socket.sent).toHaveLength(SENDS_PER_MINUTE);
    await clock.advance(60_000);
    expect(socket.sent).toHaveLength(121);
    client.stop();
  });
});
