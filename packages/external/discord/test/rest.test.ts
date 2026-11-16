import { describe, expect, it } from "vitest";

import { TaviError } from "@tavi/contracts";

import { majorOf, routeOf } from "../src/buckets.js";
import { DiscordRest, INVALID_REQUESTS_MAX } from "../src/rest.js";
import { fakeRest, virtualClock, type FakeAnswer } from "@tavi/test-support/discord";
import rateLimited from "./fixtures/rate-limit-429.json" with { type: "json" };

/** Discord's REST client. */

const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.Gabcde.s3cret-token-value";
const CHANNEL = "111111111111111111";
const OTHER = "222222222222222222";

function client(route: (path: string, method: string) => FakeAnswer | Promise<FakeAnswer>, clock = virtualClock()) {
  const rest = fakeRest((request) => route(request.path, request.method));
  return { rest: new DiscordRest({ fetch: rest.fetch, token: () => TOKEN, version: "0.1.0", clock }), requests: rest.requests, clock };
}

describe("Discord REST", () => {
  it("keys a bucket by route and top-level resource, the other ids folded", () => {
    expect(majorOf(`/channels/${CHANNEL}/messages/333333333333333333`)).toBe(`channels:${CHANNEL}`);
    expect(routeOf("PATCH", `/channels/${CHANNEL}/messages/333333333333333333`)).toBe(`PATCH /channels/${CHANNEL}/messages/:id`);
    expect(routeOf("POST", "/users/@me/channels")).toBe("POST /users/@me/channels");
  });

  it("sends as the bot, with Discord's User-Agent form", async () => {
    const { rest, requests } = client(() => ({ body: { id: "1" } }));
    await rest.request("POST", `/channels/${CHANNEL}/messages`, { body: { content: "hi" }, reason: "tavi effect e-1" });
    expect(requests[0]?.headers).toMatchObject({
      authorization: `Bot ${TOKEN}`,
      "user-agent": "DiscordBot (https://github.com/atanasster/tavi, 0.1.0)",
      "content-type": "application/json",
      "x-audit-log-reason": "tavi%20effect%20e-1",
    });
  });

  it("sends one request at a time in a shared bucket, and another channel's at once", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const { rest, requests } = client(async (path) => {
      order.push(path);
      return path.includes(CHANNEL) && order.filter((entry) => entry.includes(CHANNEL)).length === 1
        ? {
            hold: held,
            headers: { "x-ratelimit-bucket": "abc", "x-ratelimit-remaining": "4", "x-ratelimit-reset-after": "1" },
            body: { id: "1" },
          }
        : { headers: { "x-ratelimit-bucket": "abc", "x-ratelimit-remaining": "4" }, body: { id: "2" } };
    });
    const first = rest.request("POST", `/channels/${CHANNEL}/messages`, { body: {} });
    const second = rest.request("POST", `/channels/${CHANNEL}/messages`, { body: {} });
    const elsewhere = rest.request("POST", `/channels/${OTHER}/messages`, { body: {} });
    await elsewhere;
    // The other channel went; the same channel's second waits for the first.
    expect(requests.map((request) => request.path)).toEqual([`/channels/${CHANNEL}/messages`, `/channels/${OTHER}/messages`]);
    release();
    await Promise.all([first, second]);
    expect(requests).toHaveLength(3);
  });

  it("waits while a bucket has nothing left, until it resets", async () => {
    const clock = virtualClock();
    const { rest } = client(
      () => ({ headers: { "x-ratelimit-bucket": "b1", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2.5" }, body: {} }),
      clock,
    );
    await rest.request("GET", `/channels/${CHANNEL}`);
    expect(clock.slept).toEqual([]);
    await rest.request("GET", `/channels/${CHANNEL}`);
    expect(clock.slept).toEqual([2500]);
  });

  it("takes the larger of Retry-After and the body's retry_after, and counts a shared bucket's 429 against nobody", async () => {
    // The recorded shape: a body's retry_after of 1.5 and a Retry-After of 2.
    const { rest } = client(() => rateLimited);
    expect(await rest.request("POST", `/channels/${CHANNEL}/messages`, { body: {} })).toMatchObject({
      ok: false,
      status: 429,
      retryAfterMs: 2000,
      scope: "user",
    });
    const shared = client(() => ({
      status: 429,
      headers: { "retry-after": "0", "x-ratelimit-scope": "shared" },
      body: { retry_after: 0.01 },
    }));
    for (let index = 0; index <= INVALID_REQUESTS_MAX; index += 1) await shared.rest.request("GET", `/channels/${CHANNEL}`);
    expect(shared.rest.tripped).toBe(false);
  });

  it("holds every request for a global 429", async () => {
    const clock = virtualClock();
    let first = true;
    const { rest } = client(() => {
      if (!first) return { body: {} };
      first = false;
      return { status: 429, headers: { "retry-after": "3", "x-ratelimit-scope": "global" }, body: { retry_after: 3, global: true } };
    }, clock);
    await rest.request("GET", `/channels/${CHANNEL}`);
    await rest.request("GET", `/guilds/${OTHER}`);
    expect(clock.slept).toEqual([3000]);
  });

  it("keeps to 45 requests a second across every bucket", async () => {
    const clock = virtualClock();
    const { rest } = client(() => ({ body: {} }), clock);
    for (let index = 0; index < 46; index += 1)
      await rest.request("GET", `/channels/${(BigInt("100000000000000000") + BigInt(index)).toString()}`);
    expect(clock.slept).toEqual([1000]);
  });

  it("stops after too many refusals in ten minutes, and says so, once", async () => {
    let told = 0;
    const rest = new DiscordRest({
      fetch: fakeRest(() => ({ status: 401, body: { message: "401: Unauthorized", code: 0 } })).fetch,
      token: () => TOKEN,
      version: "0.1.0",
      clock: virtualClock(),
      onTripped: () => {
        told += 1;
      },
    });
    for (let index = 0; index <= INVALID_REQUESTS_MAX + 5; index += 1) await rest.request("GET", "/users/@me").catch(() => undefined);
    expect(rest.tripped).toBe(true);
    expect(told).toBe(1);
    await expect(rest.request("GET", "/users/@me")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(rest.request("GET", "/users/@me")).rejects.toBeInstanceOf(TaviError);
  });

  it("keeps the token out of every error, answer and thrown failure", async () => {
    const echo = client(() => ({ status: 400, body: { message: `Invalid token ${TOKEN}`, code: 50035 } }));
    const answer = await echo.rest.request("GET", "/users/@me");
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    expect(answer).toMatchObject({ ok: false, status: 400, code: 50035 });
    const failing = new DiscordRest({
      fetch: (async (url: string, init: RequestInit) => {
        throw new TypeError(`fetch failed for ${url} with ${JSON.stringify(init.headers)}`);
      }) as unknown as typeof fetch,
      token: () => TOKEN,
      version: "0.1.0",
      clock: virtualClock(),
    });
    const thrown = await failing.request("GET", "/users/@me").catch((error: unknown) => error);
    expect((thrown as Error).name).toBe("TypeError");
    expect(String((thrown as Error).message)).not.toContain(TOKEN);
  });

  it("folds a reaction's emoji and a webhook's token out of a route", () => {
    expect(routeOf("PUT", `/channels/${CHANNEL}/messages/333333333333333333/reactions/%F0%9F%91%8D/@me`)).toBe(
      `PUT /channels/${CHANNEL}/messages/:id/reactions/:emoji/@me`,
    );
    expect(routeOf("POST", `/webhooks/${OTHER}/s3cret-webhook-token`)).toBe(`POST /webhooks/${OTHER}/:token`);
  });

  it("lets the body's retry_after win when it is the larger, and counts a 403 against the breaker", async () => {
    const { rest } = client(() => ({ status: 429, headers: { "retry-after": "1" }, body: { retry_after: 4.2 } }));
    expect((await rest.request("GET", `/channels/${CHANNEL}`)).retryAfterMs).toBe(4200);
    const forbidden = client(() => ({ status: 403, body: { code: 50013, message: "Missing Permissions" } }));
    for (let index = 0; index <= INVALID_REQUESTS_MAX; index += 1)
      await forbidden.rest.request("POST", `/channels/${CHANNEL}/messages`, { body: {} });
    expect(forbidden.rest.tripped).toBe(true);
  });

  it("forgets refusals older than ten minutes", async () => {
    const clock = virtualClock();
    const { rest } = client(() => ({ status: 401, body: {} }), clock);
    for (let index = 0; index < INVALID_REQUESTS_MAX; index += 1) await rest.request("GET", "/users/@me");
    clock.advance(10 * 60 * 1000 + 1);
    for (let index = 0; index < 10; index += 1) await rest.request("GET", "/users/@me");
    expect(rest.tripped).toBe(false);
  });

  it("serialises two routes Discord says share one bucket", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = false;
    const { rest, requests } = client(async (_path, method) => {
      const shared = { "x-ratelimit-bucket": "same", "x-ratelimit-remaining": "3" };
      if (holding && method === "PATCH") {
        holding = false;
        return { hold: held, headers: shared, body: {} };
      }
      return { headers: shared, body: {} };
    });
    // Both routes learn the shared bucket.
    await rest.request("POST", `/channels/${CHANNEL}/messages`, { body: {} });
    await rest.request("PATCH", `/channels/${CHANNEL}/messages/333333333333333333`, { body: {} });
    holding = true;
    const edit = rest.request("PATCH", `/channels/${CHANNEL}/messages/333333333333333333`, { body: {} });
    const send = rest.request("POST", `/channels/${CHANNEL}/messages`, { body: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(3);
    release();
    await Promise.all([edit, send]);
    expect(requests).toHaveLength(4);
  });

  it("sends a file as multipart with its payload_json, and answers a 204 with no body", async () => {
    const { rest, requests } = client((path) => (path.endsWith("/typing") ? { status: 204 } : { body: { id: "9" } }));
    const form = new FormData();
    form.set("files[0]", new Blob([new Uint8Array([1, 2, 3])]), "a.pdf");
    expect(await rest.request("POST", `/channels/${CHANNEL}/messages`, { body: { content: "the file" }, form })).toMatchObject({
      ok: true,
      body: { id: "9" },
    });
    expect(requests[0]?.body).toEqual({ content: "the file" });
    expect(requests[0]?.headers["content-type"]).toBeUndefined();
    expect(await rest.request("POST", `/channels/${CHANNEL}/typing`)).toEqual({ ok: true, status: 204 });
  });

  it("gives up its place when aborted while waiting, and cuts a long reason by code point", async () => {
    const clock = virtualClock();
    let calls = 0;
    const { rest, requests } = client(
      () => {
        calls += 1;
        return { headers: { "x-ratelimit-bucket": "w", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "60" }, body: {} };
      },
      { ...clock, sleep: () => new Promise(() => undefined) },
    );
    await rest.request("GET", `/channels/${CHANNEL}`, { reason: `${"a".repeat(511)}😀😀` });
    expect(decodeURIComponent(requests[0]?.headers["x-audit-log-reason"] ?? "")).toBe(`${"a".repeat(511)}😀`);
    const controller = new AbortController();
    const waiting = rest.request("GET", `/channels/${CHANNEL}`, { signal: controller.signal });
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    expect(calls).toBe(1);
  });
});
