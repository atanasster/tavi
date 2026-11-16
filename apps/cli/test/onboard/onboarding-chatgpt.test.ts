import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer } from "node:net";

import { nowTimestamp } from "@tavi/contracts/util";
import { listenLocally, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import {
  ChatGptSignIns,
  listenForChatGpt,
  revisionValue,
  CHATGPT_PLAN_SCOPE,
  CHATGPT_REGISTRATION_CLIENT,
  chatGptAwareResolver,
  chatGptCredentialOf,
  refreshChatGpt,
  signInWithChatGpt,
  startChatGptSignIn,
  verifyChatGptIdToken,
  type ChatGptCredential,
  type ChatGptEndpoints,
} from "../../src/features/onboard/chatgpt.js";

/**
 * Sign in with ChatGPT, against a stub
 * authorization server: PKCE and state checked, the ID token's signature,
 * issuer, audience and nonce verified, plan use required, a rotated refresh
 * token stored before it is used, and a refused refresh asking to sign in
 * again. No real OpenAI endpoint is called.
 */

const ENDPOINTS: ChatGptEndpoints = {
  issuer: "https://auth.example.test",
  authorize: "https://auth.example.test/api/accounts/authorize",
  token: "https://auth.example.test/api/accounts/oauth/token",
  jwks: "https://auth.example.test/.well-known/jwks.json",
  resource: "https://api.example.test/v1",
};
const HOST = "urn:uuid:11111111-1111-4111-8111-111111111111";
const ISSUED = "oaiapp_issued123";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(keys.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", alg: "RS256" };
function idToken(claims: Record<string, unknown>, key: KeyObject = keys.privateKey): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${part({ alg: "RS256", kid: "k1", typ: "JWT" })}.${part({ iat: Math.floor(Date.now() / 1000), ...claims })}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), key).toString("base64url")}`;
}

/** The stub: the JWKS, and a token endpoint recording each form; `answer` decides the reply. */
function authServer(answer: (form: URLSearchParams) => { status: number; body: unknown }) {
  const forms: URLSearchParams[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === ENDPOINTS.jwks) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    if (url === ENDPOINTS.token) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      forms.push(form);
      const reply = answer(form);
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }
    return await globalThis.fetch(input, init);
  };
  return { fetch, forms };
}

const tokens = (nonce: string, extra: Record<string, unknown> = {}) => ({
  access_token: "access-1",
  refresh_token: "refresh-1",
  token_type: "Bearer",
  expires_in: 3600,
  scope: `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_SCOPE}`,
  id_token: idToken({
    iss: ENDPOINTS.issuer,
    aud: ISSUED,
    sub: "user-1",
    email: "me@example.test",
    nonce,
    exp: Math.floor(Date.now() / 1000) + 600,
  }),
  ...extra,
});

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

/** A sign-in whose browser comes back with `callback(state)`'s query; the loopback is reached by a real request. */
async function signIn(
  callback: (url: URL) => Record<string, string>,
  answer: (form: URLSearchParams, nonce: string) => { status: number; body: unknown },
  returning?: ChatGptCredential,
) {
  let nonce = "";
  const server = authServer((form) => answer(form, nonce));
  let authorize: URL | undefined;
  const stop = new AbortController();
  stops.push(() => stop.abort());
  const result = signInWithChatGpt({
    hostId: HOST,
    endpoints: ENDPOINTS,
    fetch: server.fetch,
    signal: stop.signal,
    port: 0,
    ...(returning === undefined ? {} : { returning }),
    open: (url) => {
      authorize = new URL(url);
      nonce = authorize.searchParams.get("nonce") ?? "";
      const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
      // A stray request without this attempt's state is refused and changes nothing.
      void globalThis.fetch(`${redirect.toString()}?code=nope&state=wrong`).then(async () => {
        const back = new URL(redirect);
        for (const [name, value] of Object.entries(callback(authorize as URL))) back.searchParams.set(name, value);
        await globalThis.fetch(back);
      });
    },
  });
  return { result, server, authorize: () => authorize };
}

describe("Sign in with ChatGPT", () => {
  it("registers on first sign-in with PKCE, checks the state and ID token, and keeps the issued client id", async () => {
    const { result, server, authorize } = await signIn(
      (url) => ({ code: "code-1", state: url.searchParams.get("state") ?? "", client_id: ISSUED }),
      (_form, nonce) => ({ status: 200, body: tokens(nonce) }),
    );
    const credential = await result;
    const asked = authorize();
    expect(asked?.searchParams.get("client_id")).toBe(CHATGPT_REGISTRATION_CLIENT);
    expect(asked?.searchParams.get("agent_name_hint")).toBe("Tavi");
    expect(asked?.searchParams.get("ext_agent_host_id")).toBe(HOST);
    expect(asked?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(asked?.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/u);
    const [form] = server.forms;
    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.get("client_id")).toBe(ISSUED);
    expect(form?.get("redirect_uri")).toBe(asked?.searchParams.get("redirect_uri"));
    expect(form?.get("resource")).toBe(ENDPOINTS.resource);
    // The verifier is the one the challenge was made from.
    expect(
      createHash("sha256")
        .update(form?.get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(asked?.searchParams.get("code_challenge"));
    expect(credential).toMatchObject({
      client_id: ISSUED,
      subject: "user-1",
      email: "me@example.test",
      ext_agent_host_id: HOST,
      access_token: "access-1",
      refresh_token: "refresh-1",
    });
    expect(chatGptCredentialOf(JSON.stringify(credential))).toEqual(credential);
  });

  it("refuses a declined consent, a registration with no issued client, and a grant without plan use", async () => {
    const declined = await signIn(
      (url) => ({ error: "access_denied", state: url.searchParams.get("state") ?? "" }),
      () => ({ status: 500, body: {} }),
    );
    await expect(declined.result).rejects.toThrow("You didn't allow Tavi to use ChatGPT");
    expect(declined.server.forms).toHaveLength(0);
    const unissued = await signIn(
      (url) => ({ code: "c", state: url.searchParams.get("state") ?? "" }),
      () => ({ status: 500, body: {} }),
    );
    await expect(unissued.result).rejects.toThrow("did not finish registering");
    const noPlan = await signIn(
      (url) => ({ code: "c", state: url.searchParams.get("state") ?? "", client_id: ISSUED }),
      (_form, nonce) => ({ status: 200, body: tokens(nonce, { scope: "openid email offline_access" }) }),
    );
    await expect(noPlan.result).rejects.toThrow("ChatGPT plan use was not allowed");
  });

  it("signs a returning account in with its own client id and hints, and refuses another account or registration", async () => {
    const first = await (
      await signIn(
        (url) => ({ code: "c", state: url.searchParams.get("state") ?? "", client_id: ISSUED }),
        (_form, nonce) => ({ status: 200, body: tokens(nonce) }),
      )
    ).result;
    const again = await signIn(
      (url) => ({ code: "c2", state: url.searchParams.get("state") ?? "" }),
      (_form, nonce) => ({ status: 200, body: tokens(nonce) }),
      first,
    );
    expect((await again.result).client_id).toBe(ISSUED);
    expect(again.authorize()?.searchParams.get("client_id")).toBe(ISSUED);
    expect(again.authorize()?.searchParams.get("agent_name_hint")).toBeNull();
    expect(again.authorize()?.searchParams.get("id_token_hint")).toBe(first.id_token);
    const swapped = await signIn(
      (url) => ({ code: "c3", state: url.searchParams.get("state") ?? "", client_id: "oaiapp_other" }),
      () => ({ status: 500, body: {} }),
      first,
    );
    await expect(swapped.result).rejects.toThrow("another registration");
    const otherAccount = await signIn(
      (url) => ({ code: "c4", state: url.searchParams.get("state") ?? "" }),
      (_form, nonce) => ({
        status: 200,
        body: {
          ...tokens(nonce),
          id_token: idToken({ iss: ENDPOINTS.issuer, aud: ISSUED, sub: "user-2", nonce, exp: Math.floor(Date.now() / 1000) + 600 }),
        },
      }),
      first,
    );
    await expect(otherAccount.result).rejects.toThrow("another ChatGPT account");
  });

  it("verifies the ID token's signature, issuer, audience, expiry and nonce", async () => {
    const jwks = async () => ({ keys: [jwk] });
    const now = Date.now();
    const claims = { iss: ENDPOINTS.issuer, aud: ISSUED, sub: "user-1", nonce: "n", exp: Math.floor(now / 1000) + 60 };
    const expected = { issuer: ENDPOINTS.issuer, audience: ISSUED, nonce: "n", now, jwks };
    expect(await verifyChatGptIdToken(idToken(claims), expected)).toMatchObject({ sub: "user-1" });
    const forged = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await expect(verifyChatGptIdToken(idToken(claims, forged), expected)).rejects.toThrow("not signed by OpenAI");
    await expect(verifyChatGptIdToken(idToken({ ...claims, iss: "https://evil.test" }), expected)).rejects.toThrow("another issuer");
    await expect(verifyChatGptIdToken(idToken({ ...claims, aud: "oaiapp_x" }), expected)).rejects.toThrow("another client");
    await expect(verifyChatGptIdToken(idToken({ ...claims, exp: Math.floor(now / 1000) - 1 }), expected)).rejects.toThrow("expired");
    await expect(verifyChatGptIdToken(idToken({ ...claims, nonce: "other" }), expected)).rejects.toThrow("not this sign-in's");
  });

  it("builds a returning authorize address without the registration hint", () => {
    const start = startChatGptSignIn({
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      hostId: HOST,
      endpoints: ENDPOINTS,
      returning: { client_id: ISSUED, id_token: "id.tok.en", email: "me@example.test" },
    });
    const url = new URL(start.url);
    expect(url.searchParams.get("login_hint")).toBe("me@example.test");
    expect(url.searchParams.get("scope")).toContain(CHATGPT_PLAN_SCOPE);
    expect(start.clientId).toBe(ISSUED);
  });
});

describe("renewing a ChatGPT sign-in", () => {
  const record = (expiresIn: number): ChatGptCredential => ({
    kind: "chatgpt-sign-in",
    issuer: ENDPOINTS.issuer,
    subject: "user-1",
    client_id: ISSUED,
    ext_agent_host_id: HOST,
    id_token: "id.tok.en",
    access_token: "access-old",
    refresh_token: "refresh-old",
    token_type: "Bearer",
    expires_at: new Date(Date.now() + expiresIn).toISOString(),
    scopes: [CHATGPT_PLAN_SCOPE],
    saved_at: nowTimestamp(),
  });

  it("answers a fresh access token as it is, and passes any other credential through", async () => {
    const resolve = chatGptAwareResolver(
      async (reference) => (reference === "chatgpt" ? JSON.stringify(record(3_600_000)) : "sk-plain"),
      async () => {
        throw new Error("no write");
      },
    );
    expect(await resolve("chatgpt")).toBe("access-old");
    expect(await resolve("openai")).toBe("sk-plain");
  });

  it("renews near expiry once for calls at once, stores the rotated record first, and sends the issued client id", async () => {
    let stored = JSON.stringify(record(60_000));
    const writes: string[] = [];
    const server = authServer(() => ({
      status: 200,
      body: { access_token: "access-new", refresh_token: "refresh-new", token_type: "Bearer", expires_in: 3600 },
    }));
    const resolve = chatGptAwareResolver(
      async () => stored,
      async (_reference, value) => {
        writes.push(value);
        stored = value;
      },
      { fetch: server.fetch, endpoints: ENDPOINTS },
    );
    expect(await Promise.all([resolve("chatgpt"), resolve("chatgpt")])).toEqual(["access-new", "access-new"]);
    expect(server.forms).toHaveLength(1);
    expect(server.forms[0]?.get("grant_type")).toBe("refresh_token");
    expect(server.forms[0]?.get("client_id")).toBe(ISSUED);
    expect(server.forms[0]?.get("refresh_token")).toBe("refresh-old");
    expect(server.forms[0]?.get("scope")).toBeNull();
    expect(chatGptCredentialOf(writes[0] ?? "")).toMatchObject({ access_token: "access-new", refresh_token: "refresh-new" });
  });

  it("asks to sign in again on a refused refresh, keeping the stored record and never quoting the reply", async () => {
    const server = authServer(() => ({ status: 400, body: { error: "refresh_token_reused", detail: "refresh-old was used" } }));
    const writes: string[] = [];
    const resolve = chatGptAwareResolver(
      async () => JSON.stringify(record(0)),
      async (_reference, value) => void writes.push(value),
      { fetch: server.fetch, endpoints: ENDPOINTS },
    );
    const refused = resolve("chatgpt");
    await expect(refused).rejects.toThrow("The ChatGPT sign-in has ended. Sign in with ChatGPT again");
    await expect(refused).rejects.not.toThrow("refresh-old");
    expect(writes).toEqual([]);
    const down = authServer(() => ({ status: 503, body: {} }));
    await expect(refreshChatGpt(record(0), { fetch: down.fetch, endpoints: ENDPOINTS })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("a ChatGPT sign-in's revision", () => {
  it("is its client and account, so an hourly renewal keeps its verification, and another account is a new one", () => {
    const base = {
      kind: "chatgpt-sign-in",
      issuer: ENDPOINTS.issuer,
      subject: "user-1",
      client_id: ISSUED,
      ext_agent_host_id: HOST,
      id_token: "a.b.c",
      token_type: "Bearer",
      scopes: [CHATGPT_PLAN_SCOPE],
      expires_at: nowTimestamp(),
      saved_at: nowTimestamp(),
    };
    const before = revisionValue(JSON.stringify({ ...base, access_token: "a1", refresh_token: "r1" }));
    expect(revisionValue(JSON.stringify({ ...base, access_token: "a2", refresh_token: "r2" }))).toBe(before);
    expect(revisionValue(JSON.stringify({ ...base, subject: "user-2", access_token: "a1", refresh_token: "r1" }))).not.toBe(before);
    expect(revisionValue("sk-plain")).toBe("sk-plain");
    expect(revisionValue(null)).toBeNull();
  });
});

describe("the ID token, further", () => {
  const now = Date.now();
  const base = { iss: ENDPOINTS.issuer, aud: ISSUED, sub: "user-1", exp: Math.floor(now / 1000) + 60 };

  it("verifies an ES256 token against an EC key, and never reads one with a key of the other type", async () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ecJwk = { ...(ec.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "e1" };
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const head = `${part({ alg: "ES256", kid: "e1" })}.${part({ ...base, iat: Math.floor(now / 1000) })}`;
    const token = `${head}.${sign("SHA256", Buffer.from(head), { key: ec.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    expect(
      await verifyChatGptIdToken(token, { issuer: ENDPOINTS.issuer, audience: ISSUED, now, jwks: async () => ({ keys: [ecJwk] }) }),
    ).toMatchObject({ sub: "user-1" });
    // The RSA key named by the same kid is not tried for an ES256 token.
    await expect(
      verifyChatGptIdToken(token, {
        issuer: ENDPOINTS.issuer,
        audience: ISSUED,
        now,
        jwks: async () => ({ keys: [{ ...jwk, kid: "e1" }] }),
      }),
    ).rejects.toThrow("not signed by OpenAI");
  });

  it("refuses a token with no issue time, or one not valid yet", async () => {
    const jwks = async () => ({ keys: [jwk] });
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signed = (claims: Record<string, unknown>) => {
      const head = `${part({ alg: "RS256", kid: "k1" })}.${part(claims)}`;
      return `${head}.${sign("RSA-SHA256", Buffer.from(head), keys.privateKey).toString("base64url")}`;
    };
    await expect(verifyChatGptIdToken(signed(base), { issuer: ENDPOINTS.issuer, audience: ISSUED, now, jwks })).rejects.toThrow(
      "no time it was issued",
    );
    await expect(
      verifyChatGptIdToken(signed({ ...base, iat: Math.floor(now / 1000), nbf: Math.floor(now / 1000) + 3600 }), {
        issuer: ENDPOINTS.issuer,
        audience: ISSUED,
        now,
        jwks,
      }),
    ).rejects.toThrow("not valid yet");
  });

  it("checks a refreshed ID token before keeping it: another account ends the sign-in", async () => {
    const record: ChatGptCredential = {
      kind: "chatgpt-sign-in",
      issuer: ENDPOINTS.issuer,
      subject: "user-1",
      client_id: ISSUED,
      ext_agent_host_id: HOST,
      id_token: "a.b.c",
      access_token: "a",
      refresh_token: "r",
      token_type: "Bearer",
      expires_at: new Date(now).toISOString(),
      scopes: [CHATGPT_PLAN_SCOPE],
      saved_at: new Date(now).toISOString(),
    };
    const server = authServer(() => ({
      status: 200,
      body: { access_token: "a2", refresh_token: "r2", expires_in: 3600, id_token: idToken({ ...base, sub: "user-2" }) },
    }));
    await expect(refreshChatGpt(record, { fetch: server.fetch, endpoints: ENDPOINTS })).rejects.toThrow("another account");
  });
});

describe("the loopback", () => {
  it("listens on 127.0.0.1 only, falls back to a free port when the documented one is taken, and stops on close", async () => {
    const blocker = createServer();
    const taken = await listenLocally(blocker);
    try {
      const loopback = await listenForChatGpt(() => "s", { port: taken });
      const port = Number(new URL(loopback.redirectUri).port);
      expect(new URL(loopback.redirectUri).hostname).toBe("127.0.0.1");
      expect(port).not.toBe(taken);
      expect((await globalThis.fetch(`http://127.0.0.1:${String(port)}/auth/callback?state=other`)).status).toBe(404);
      loopback.close();
      await expect(loopback.callback).rejects.toThrow("stopped");
      await expect(globalThis.fetch(`http://127.0.0.1:${String(port)}/auth/callback?state=s`)).rejects.toThrow();
    } finally {
      blocker.close();
    }
  });
});

describe("the owner's ChatGPT sign-ins", () => {
  it("answers the address and state, stores the record when the browser comes back, and says how it stands", async () => {
    let nonce = "";
    const server = authServer(() => ({ status: 200, body: tokens(nonce) }));
    const signIns = new ChatGptSignIns({ hostId: async () => HOST, fetch: server.fetch, endpoints: ENDPOINTS, port: 0 });
    const stored: ChatGptCredential[] = [];
    const started = await signIns.start(async (credential) => {
      stored.push(credential);
      return { connectionId: "chatgpt", models: ["gpt-x"] };
    });
    const authorize = new URL(started.url);
    nonce = authorize.searchParams.get("nonce") ?? "";
    expect(started.state).toBe(authorize.searchParams.get("state"));
    expect(signIns.status(started.state)).toEqual({ state: "waiting" });
    const back = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", "c");
    back.searchParams.set("state", started.state);
    back.searchParams.set("client_id", ISSUED);
    await globalThis.fetch(back);
    for (let tries = 0; tries < 50 && signIns.status(started.state).state === "waiting"; tries += 1) await delay(20);
    expect(signIns.status(started.state)).toMatchObject({ state: "done", connectionId: "chatgpt" });
    expect(stored[0]?.client_id).toBe(ISSUED);
    expect(signIns.status("unknown")).toEqual({ state: "gone" });
  });

  it("no longer owns a sign-in past its ten minutes, and stops its listener", async () => {
    const server = authServer(() => ({ status: 500, body: {} }));
    const now = { value: 0 };
    const signIns = new ChatGptSignIns({
      hostId: async () => HOST,
      fetch: server.fetch,
      endpoints: ENDPOINTS,
      port: 0,
      now: () => now.value,
    });
    const started = await signIns.start(async () => ({ connectionId: "chatgpt", models: [] }));
    expect(signIns.owns(started.state)).toBe(true);
    now.value = 11 * 60_000;
    expect(signIns.owns(started.state)).toBe(false);
    expect(signIns.status(started.state)).toEqual({ state: "gone" });
    const back = new URL(new URL(started.url).searchParams.get("redirect_uri") ?? "");
    await expect(globalThis.fetch(back)).rejects.toThrow();
  });
});
