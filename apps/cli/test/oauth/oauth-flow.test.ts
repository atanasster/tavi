import { createHash } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ChannelDescriptorSchema, type ChannelDescriptor } from "@tavi/contracts";
import { temporaryDirectories, fakeFetch as scriptedFetch } from "@tavi/test-support";

import { connectionOptIns, saveOAuthClient } from "../../src/features/channels/oauth.js";
import { providerRefusal } from "../../src/features/oauth/core.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";
import { OAUTH_FLOW_TTL_MS, OAuthFlows, boundAccountOf, oauthCallbackPage, oauthTokenRef } from "../../src/features/oauth/flow.js";

/** The host's OAuth authorization-code flow with PKCE. */

const directories = temporaryDirectories();
afterAll(() => directories.cleanup());

const descriptor: ChannelDescriptor = {
  providerId: "inbox",
  label: "Inbox",
  kind: "email",
  description: "d",
  settings: [],
  auth: {
    kind: "oauth2",
    oauth: {
      authorizeUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      scopes: ["mail.read", "mail.send"],
      pkce: true,
      client: { source: "operator" },
      redirect: "loopback-any-port",
      tokenAuthMethod: "client_secret_basic",
      extraAuthorizeParams: { access_type: "offline" },
      accountIdentity: { userinfoUrl: "https://auth.example.com/me", field: "email" },
    },
  },
  sender: { label: "Address", placeholder: "", pattern: ".+", normalize: "lowercase", authentication: "provider" },
  target: { label: "Address", placeholder: "", pattern: ".+", normalize: "lowercase" },
};

async function setup(channel: ChannelDescriptor = descriptor) {
  const directory = directories.create("tavi-oauth-flow-");
  await saveOAuthClient(directory, channel, { clientId: "client-1", clientSecret: "client-secret" });
  let now = Date.parse("2026-10-09T00:00:00.000Z");
  let gone: string | undefined;
  let refuse = false;
  const exchanges: { body: URLSearchParams; authorization: string | null }[] = [];
  const connected: unknown[] = [];
  const fakeFetch = scriptedFetch(async (url, init) => {
    if (url === "https://auth.example.com/token") {
      if (refuse)
        return new Response(JSON.stringify({ error: `invalid_client: ${new URLSearchParams(String(init?.body)).get("code") ?? ""}` }), {
          status: 400,
        });
      exchanges.push({ body: new URLSearchParams(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(
        JSON.stringify({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          scope: "mail.read mail.send",
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    }
    if (url === "https://auth.example.com/me") return new Response(JSON.stringify({ email: "ana@example.com" }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  const flows = new OAuthFlows({
    dataDirectory: directory,
    fetch: fakeFetch,
    now: () => now,
    descriptorOf: (id) => (id === "inbox" ? channel : undefined),
    connected: async (input) => {
      connected.push(input);
      return gone !== input.connectionId;
    },
  });
  const start = () =>
    flows.start({ connectionId: "inbox-1", workspaceId: "w", providerId: "inbox", redirectUri: "http://127.0.0.1:4100/oauth/callback" });
  return {
    directory,
    flows,
    start,
    exchanges,
    connected,
    advance: (ms: number) => {
      now += ms;
    },
    removeConnection: (id: string) => {
      gone = id;
    },
    refuseExchange: () => {
      refuse = true;
    },
  };
}

describe("OAuthFlows", () => {
  it("sends the browser to the provider with an S256 challenge, exchanges the code with its verifier, and stores the tokens", async () => {
    const { flows, start, exchanges, connected, directory } = await setup();
    const { flowId, authorizeUrl } = await start();
    const url = new URL(authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "http://127.0.0.1:4100/oauth/callback",
      scope: "mail.read mail.send",
      code_challenge_method: "S256",
      access_type: "offline",
    });
    const state = url.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(flows.status(flowId, "w")).toMatchObject({ state: "pending" });
    // Another workspace's page sees nothing of it.
    expect(flows.status(flowId, "other")).toBeUndefined();

    expect(await flows.callback({ state, code: "code-1" })).toEqual({ ok: true, message: "Connected as ana@example.com." });
    const exchange = exchanges[0];
    expect(exchange?.body.get("code")).toBe("code-1");
    expect(
      createHash("sha256")
        .update(exchange?.body.get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(url.searchParams.get("code_challenge"));
    expect(exchange?.authorization).toBe(`Basic ${Buffer.from("client-1:client-secret").toString("base64")}`);
    expect(exchange?.body.has("client_secret")).toBe(false);
    expect(connected).toEqual([
      { connectionId: "inbox-1", workspaceId: "w", accountIdentity: "ana@example.com", tokenRef: oauthTokenRef("inbox-1") },
    ]);
    const stored = JSON.parse((await createLocalCredentialStore(directory).getSecret(oauthTokenRef("inbox-1"))) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(stored).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: "2026-10-09T01:00:00.000Z",
      scopes: ["mail.read", "mail.send"],
      tokenType: "Bearer",
    });
    expect(flows.status(flowId, "w")).toMatchObject({ state: "connected", accountIdentity: "ana@example.com" });
  });

  it("takes a state once, and none that is unknown or expired; a provider's refusal is said", async () => {
    const { flows, start, exchanges, advance } = await setup();
    const state = new URL((await start()).authorizeUrl).searchParams.get("state") ?? "";
    expect((await flows.callback({ state, code: "c" })).ok).toBe(true);
    // Replayed: nothing is exchanged again.
    expect(await flows.callback({ state, code: "c" })).toMatchObject({ ok: false, message: expect.stringMatching(/no longer valid/) });
    expect(exchanges).toHaveLength(1);
    expect((await flows.callback({ state: "x".repeat(43), code: "c" })).ok).toBe(false);
    const late = await start();
    advance(OAUTH_FLOW_TTL_MS);
    expect((await flows.callback({ state: new URL(late.authorizeUrl).searchParams.get("state") ?? "", code: "c" })).ok).toBe(false);
    expect(flows.status(late.flowId, "w")?.state).toBe("expired");
    const denied = await start();
    expect(await flows.callback({ state: new URL(denied.authorizeUrl).searchParams.get("state") ?? "", error: "access_denied" })).toEqual({
      ok: false,
      message: "You didn't allow access. Nothing was connected.",
    });
    expect(flows.status(denied.flowId, "w")).toMatchObject({ state: "failed" });
    // A redirect the client does not list says which one to register; any other refusal is named as given.
    const mismatched = await start();
    expect(
      (await flows.callback({ state: new URL(mismatched.authorizeUrl).searchParams.get("state") ?? "", error: "redirect_uri_mismatch" }))
        .message,
    ).toBe(
      `The provider refused the redirect. Register exactly ${new URL(mismatched.authorizeUrl).searchParams.get("redirect_uri") ?? ""} on your client.`,
    );
    // An organization's block and an unknown client each name their fix.
    const blocked = await start();
    expect(
      (await flows.callback({ state: new URL(blocked.authorizeUrl).searchParams.get("state") ?? "", error: "admin_policy_enforced" }))
        .message,
    ).toMatch(/administrator does not allow this app/);
    const unknown = await start();
    expect(
      (await flows.callback({ state: new URL(unknown.authorizeUrl).searchParams.get("state") ?? "", error: "invalid_client" })).message,
    ).toMatch(/does not know this client, or its secret: check them where the client was made/);
    const other = await start();
    expect(
      (await flows.callback({ state: new URL(other.authorizeUrl).searchParams.get("state") ?? "", error: "invalid_scope" })).message,
    ).toBe("The provider did not allow it: invalid_scope");
  });

  it("keeps no token for a connection removed while it signed in, and never says the code in a refusal", async () => {
    const { flows, start, directory, removeConnection, refuseExchange } = await setup();
    removeConnection("inbox-1");
    const state = new URL((await start()).authorizeUrl).searchParams.get("state") ?? "";
    expect(await flows.callback({ state, code: "c" })).toEqual({
      ok: false,
      message: "The connection was removed while it was signing in.",
    });
    expect(await createLocalCredentialStore(directory).getSecret(oauthTokenRef("inbox-1"))).toBeNull();
    refuseExchange();
    const second = new URL((await start()).authorizeUrl).searchParams.get("state") ?? "";
    const refused = await flows.callback({ state: second, code: "secret-code-xyz" });
    expect(refused.ok).toBe(false);
    // The token endpoint's refusal of the client is said as the fix it needs, never with the code.
    expect(refused.message).toContain("does not know this client, or its secret");
    expect(refused.message).not.toContain("secret-code-xyz");
  });

  it("refuses a channel's extra authorize parameter that would stand in for one of the flow's own", () => {
    const oauth = descriptor.auth.kind === "oauth2" ? descriptor.auth.oauth : undefined;
    expect(
      ChannelDescriptorSchema.safeParse({
        ...descriptor,
        auth: { kind: "oauth2", oauth: { ...oauth, extraAuthorizeParams: { redirect_uri: "https://evil.example/cb" } } },
      }).success,
    ).toBe(false);
    expect(
      ChannelDescriptorSchema.safeParse({
        ...descriptor,
        auth: { kind: "oauth2", oauth: { ...oauth, extraAuthorizeParams: { prompt: "consent" } } },
      }).success,
    ).toBe(true);
  });

  it("renders a callback page with no script and the message escaped", () => {
    const page = oauthCallbackPage({ ok: false, message: "<script>x</script>" });
    expect(page.status).toBe(400);
    expect(page.body).not.toContain("<script>");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
  });
});

describe("an account's opt-in that asks for more access", () => {
  it("asks for the calendar's scopes with the channel's own once the account's calendar is on, and only then", async () => {
    const directory = directories.create("tavi-oauth-optins-");
    if (descriptor.auth.kind !== "oauth2") throw new Error("an OAuth channel");
    const withCalendar: ChannelDescriptor = {
      ...descriptor,
      auth: { kind: "oauth2", oauth: { ...descriptor.auth.oauth, optInScopes: { calendar: ["cal.read"] } } },
    };
    await saveOAuthClient(directory, withCalendar, { clientId: "client-1", clientSecret: "client-secret" });
    let calendar = false;
    const flows = new OAuthFlows({
      dataDirectory: directory,
      fetch: scriptedFetch(async () => new Response("{}", { status: 404 })),
      now: () => Date.parse("2026-10-09T00:00:00.000Z"),
      descriptorOf: () => withCalendar,
      optInsOf: async () => ({ calendar }),
      connected: async () => true,
    });
    const scopeOf = async () =>
      new URL(
        (
          await flows.start({
            connectionId: "inbox-1",
            workspaceId: "w",
            providerId: "inbox",
            redirectUri: "http://127.0.0.1:4100/oauth/callback",
          })
        ).authorizeUrl,
      ).searchParams.get("scope");
    expect(await scopeOf()).toBe("mail.read mail.send");
    calendar = true;
    expect(await scopeOf()).toBe("mail.read mail.send cal.read");
  });
});

describe("what a connection has on", () => {
  it("asks for mail while it takes mail in or its mailbox is on, and for the calendar only while that is on", () => {
    expect(connectionOptIns({}, false, false)).toEqual({ mail: true, calendar: false });
    expect(connectionOptIns(undefined, false, true)).toEqual({ mail: true, calendar: true });
    expect(connectionOptIns({ receive: false }, false, true)).toEqual({ mail: false, calendar: true });
    expect(connectionOptIns({ receive: false }, true, false)).toEqual({ mail: true, calendar: false });
  });
});

describe("a refusal for a provider's shared Desktop app client", () => {
  it("names the kind of client to make, and a token endpoint's unknown client as the callback would", () => {
    const google = { provider: "Google", redirect: "http://127.0.0.1:5000/oauth/callback", desktopClient: true };
    expect(providerRefusal("redirect_uri_mismatch", google)).toMatch(/not a Desktop app client.*drop its file/);
    expect(providerRefusal("The provider refused the token: invalid_client (Unauthorized)", google)).toBe(
      "Google does not know this client, or its secret: drop the Desktop app client's file again.",
    );
    expect(providerRefusal("org_internal", google)).toMatch(/administrator does not allow this app/);
  });
});

describe("paste-back for a channel", () => {
  it("finishes a flow of the workspace's from the address its browser landed on, and refuses another workspace or another state", async () => {
    const { flows, start } = await setup();
    const { flowId, authorizeUrl } = await start();
    const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
    const address = `http://127.0.0.1:4100/oauth/callback?state=${encodeURIComponent(state)}&code=code-1`;
    expect(await flows.finish(flowId, "other", address)).toMatchObject({ ok: false });
    expect(await flows.finish(flowId, "w", "http://127.0.0.1:4100/oauth/callback?state=nope&code=x")).toEqual({
      ok: false,
      message: "That address belongs to another sign-in.",
    });
    expect(flows.status(flowId, "w")).toMatchObject({ state: "pending" });
    expect(await flows.finish(flowId, "w", address)).toEqual({ ok: true, message: "Connected as ana@example.com." });
    expect(await flows.finish(flowId, "w", address)).toMatchObject({
      ok: false,
      message: "This sign-in is no longer waiting: start it again.",
    });
  });
});

describe("the issuer a channel's redirect names (RFC 9207)", () => {
  it("is not checked for a provider that declares none", async () => {
    const { flows, start } = await setup();
    const { authorizeUrl } = await start();
    const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
    expect((await flows.callback({ state, code: "code-1", iss: "https://elsewhere.example.com" })).ok).toBe(true);
  });

  it("refuses a redirect naming another issuer or none when the provider declares one, by callback and by paste-back", async () => {
    const declared = structuredClone(descriptor);
    if (declared.auth.kind === "oauth2") declared.auth.oauth.issuer = "https://auth.example.com";
    expect(ChannelDescriptorSchema.safeParse(declared).success).toBe(true);
    const { flows, start, exchanges } = await setup(declared);
    const begin = async () => {
      const { flowId, authorizeUrl } = await start();
      return { flowId, state: new URL(authorizeUrl).searchParams.get("state") ?? "" };
    };
    const other = await begin();
    expect(await flows.callback({ state: other.state, code: "code-1", iss: "https://evil.example.com" })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/names another issuer/),
    });
    expect(flows.status(other.flowId, "w")).toMatchObject({ state: "failed" });
    const none = await begin();
    expect((await flows.callback({ state: none.state, code: "code-1" })).message).toMatch(/names another issuer/);
    const address = (state: string, iss: string) =>
      `http://127.0.0.1:4100/oauth/callback?state=${encodeURIComponent(state)}&code=code-1&iss=${encodeURIComponent(iss)}`;
    const pasted = await begin();
    expect((await flows.finish(pasted.flowId, "w", address(pasted.state, "https://evil.example.com"))).message).toMatch(
      /names another issuer/,
    );
    // No code was exchanged for any of them.
    expect(exchanges).toHaveLength(0);
    const right = await begin();
    expect(await flows.callback({ state: right.state, code: "code-1", iss: "https://auth.example.com" })).toEqual({
      ok: true,
      message: "Connected as ana@example.com.",
    });
    const pastedRight = await begin();
    expect((await flows.finish(pastedRight.flowId, "w", address(pastedRight.state, "https://auth.example.com"))).ok).toBe(true);
  });
});

describe("cancelling a channel's sign-in", () => {
  it("ends a waiting flow of the workspace's, so its browser coming back later signs nothing in", async () => {
    const { flows, start } = await setup();
    const { flowId, authorizeUrl } = await start();
    const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
    expect(flows.cancel(flowId, "other")).toBe(false);
    expect(flows.cancel(flowId, "w")).toBe(true);
    expect(flows.status(flowId, "w")).toMatchObject({ state: "failed", detail: "The sign-in was cancelled." });
    expect(await flows.callback({ state, code: "code-1" })).toMatchObject({ ok: false });
    expect(flows.cancel(flowId, "w")).toBe(false);
  });
});

describe("what a sign-in must show before it is kept", () => {
  async function signIn(answer: { readonly scope?: string; readonly email?: string | null }, signedInAs?: string) {
    const directory = directories.create("tavi-oauth-checks-");
    await saveOAuthClient(directory, descriptor, { clientId: "client-1", clientSecret: "client-secret" });
    const connected: unknown[] = [];
    const fakeFetch = scriptedFetch(async (url) => {
      if (url === "https://auth.example.com/token")
        return new Response(
          JSON.stringify({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
            scope: answer.scope ?? "mail.read mail.send",
          }),
        );
      if (url === "https://auth.example.com/me")
        return answer.email === null
          ? new Response("{}", { status: 403 })
          : new Response(JSON.stringify({ email: answer.email ?? "ana@example.com" }));
      return new Response("{}", { status: 404 });
    });
    const flows = new OAuthFlows({
      dataDirectory: directory,
      fetch: fakeFetch,
      now: () => Date.parse("2026-10-09T00:00:00.000Z"),
      descriptorOf: () => descriptor,
      connected: async (input) => {
        connected.push(input);
        return true;
      },
      signedInAccount: async () => signedInAs,
    });
    const { authorizeUrl } = await flows.start({
      connectionId: "inbox-1",
      workspaceId: "w",
      providerId: "inbox",
      redirectUri: "http://127.0.0.1:4100/oauth/callback",
    });
    const outcome = await flows.callback({ state: new URL(authorizeUrl).searchParams.get("state") ?? "", code: "code-1" });
    const kept = await createLocalCredentialStore(directory).getSecret(oauthTokenRef("inbox-1"));
    return { outcome, connected, kept };
  }

  it("refuses a sign-in that withheld an access the channel asks for, or whose account it cannot name, and keeps nothing", async () => {
    const narrow = await signIn({ scope: "mail.read" });
    expect(narrow.outcome).toEqual({ ok: false, message: expect.stringMatching(/did not allow mail\.send/) });
    expect(narrow).toMatchObject({ connected: [], kept: null });
    const nameless = await signIn({ email: null });
    expect(nameless.outcome).toEqual({ ok: false, message: expect.stringMatching(/did not say which account/) });
    expect(nameless).toMatchObject({ connected: [], kept: null });
  });

  it("signs a connection in again only as the account it was signed in as", async () => {
    const other = await signIn({ email: "bob@example.com" }, "ana@example.com");
    expect(other.outcome).toEqual({
      ok: false,
      message:
        "You signed in as bob@example.com, but this connection is ana@example.com. Add it as another account instead, or disconnect this one first.",
    });
    expect(other).toMatchObject({ connected: [], kept: null });
    expect((await signIn({ email: "Ana@Example.com" }, "ana@example.com")).outcome).toMatchObject({ ok: true });
  });
});

describe("a sign-in by code (RFC 8628)", () => {
  const deviceDescriptor: ChannelDescriptor = {
    ...descriptor,
    providerId: "boxed",
    label: "Boxed",
    auth: {
      kind: "oauth2",
      oauth: {
        ...(descriptor.auth.kind === "oauth2" ? descriptor.auth.oauth : ({} as never)),
        deviceAuthorizationUrl: "https://auth.example.com/device",
      },
    },
  };

  async function deviceSetup(
    answers: readonly (() => Response)[],
    device: () => Response | Promise<Response> = () =>
      Response.json({
        device_code: "device-secret",
        user_code: "WDJB-MJHT",
        verification_uri: "https://auth.example.com/activate",
        verification_uri_complete: "https://auth.example.com/activate?user_code=WDJB-MJHT",
        expires_in: 900,
        interval: 5,
      }),
  ) {
    const directory = directories.create("tavi-oauth-device-");
    await saveOAuthClient(directory, deviceDescriptor, { clientId: "client-1", clientSecret: "client-secret" });
    let now = Date.parse("2026-10-16T00:00:00.000Z");
    const asked: URLSearchParams[] = [];
    const connected: unknown[] = [];
    let next = 0;
    let account: () => Response | Promise<Response> = () => Response.json({ email: "ana@example.com" });
    const fakeFetch = scriptedFetch(async (url, init) => {
      if (url === "https://auth.example.com/device") return device();
      if (url === "https://auth.example.com/token") {
        asked.push(new URLSearchParams(String(init?.body)));
        const answer = answers[Math.min(next, answers.length - 1)] ?? (() => new Response("{}", { status: 500 }));
        next += 1;
        return answer();
      }
      if (url === "https://auth.example.com/me") return await account();
      return new Response("{}", { status: 404 });
    });
    const flows = new OAuthFlows({
      dataDirectory: directory,
      fetch: fakeFetch,
      now: () => now,
      descriptorOf: (id) => (id === "boxed" ? deviceDescriptor : id === "inbox" ? descriptor : undefined),
      connected: async (input) => {
        connected.push(input);
        return true;
      },
    });
    return {
      flows,
      asked,
      connected,
      directory,
      advance: (ms: number) => {
        now += ms;
      },
      slowAccount: (answer: () => Promise<Response>) => {
        account = answer;
      },
    };
  }

  const pending = () => Response.json({ error: "authorization_pending" }, { status: 400 });
  const slowDown = () => Response.json({ error: "slow_down" }, { status: 400 });
  const granted = () =>
    Response.json({
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      scope: "mail.read mail.send",
      token_type: "Bearer",
    });

  it("shows a code, asks at the interval (five seconds more after slow_down), and keeps the sign-in once entered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const { flows, asked, connected, directory } = await deviceSetup([pending, slowDown, granted]);
      const started = await flows.startDevice({ connectionId: "boxed-1", workspaceId: "w", providerId: "boxed" });
      expect(started).toMatchObject({
        userCode: "WDJB-MJHT",
        verificationUri: "https://auth.example.com/activate",
        verificationUriComplete: "https://auth.example.com/activate?user_code=WDJB-MJHT",
      });
      // The device code is the owner's: never in what the page is told.
      expect(JSON.stringify(started)).not.toContain("device-secret");
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      expect(Object.fromEntries(asked[0] ?? [])).toMatchObject({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "device-secret",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(asked).toHaveLength(2));
      // slow_down: the next ask waits ten seconds, not five.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(asked).toHaveLength(2);
      expect(flows.status(started.flowId, "w")).toMatchObject({ state: "pending" });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() =>
        expect(flows.status(started.flowId, "w")).toMatchObject({ state: "connected", accountIdentity: "ana@example.com" }),
      );
      expect(asked).toHaveLength(3);
      expect(connected).toEqual([
        { connectionId: "boxed-1", workspaceId: "w", accountIdentity: "ana@example.com", tokenRef: oauthTokenRef("boxed-1") },
      ]);
      expect(JSON.parse((await createLocalCredentialStore(directory).getSecret(oauthTokenRef("boxed-1"))) ?? "{}")).toMatchObject({
        accessToken: "access-1",
        refreshToken: "refresh-1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits five seconds longer after each outage, but never more than a minute between asks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const outage = () => new Response("", { status: 503 });
      const { flows, asked } = await deviceSetup(Array.from({ length: 20 }, () => outage));
      await flows.startDevice({ connectionId: "boxed-1", workspaceId: "w", providerId: "boxed" });
      // Each ask is made, then the next one is scheduled: one second short of its wait nothing is asked, at it, the next ask.
      const nextAsk = async (count: number, seconds: number): Promise<void> => {
        await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
        await vi.advanceTimersByTimeAsync(seconds * 1000 - 1_000);
        expect(asked).toHaveLength(count - 1);
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.waitFor(() => expect(asked).toHaveLength(count));
      };
      // Waits of 5, 10, … 60 seconds, then a minute each time.
      for (let ask = 1; ask <= 14; ask += 1) await nextAsk(ask, Math.min(60, 5 * ask));
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends on a refusal or when the code lapses, and asks no more once cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const denied = await deviceSetup([() => Response.json({ error: "access_denied" }, { status: 400 })]);
      const one = await denied.flows.startDevice({ connectionId: "boxed-1", workspaceId: "w", providerId: "boxed" });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() =>
        expect(denied.flows.status(one.flowId, "w")).toEqual({
          state: "failed",
          connectionId: "boxed-1",
          detail: "The sign-in was not allowed.",
        }),
      );
      expect(denied.connected).toEqual([]);

      const lapsing = await deviceSetup([pending]);
      const two = await lapsing.flows.startDevice({ connectionId: "boxed-1", workspaceId: "w", providerId: "boxed" });
      lapsing.advance(16 * 60_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() =>
        expect(lapsing.flows.status(two.flowId, "w")).toMatchObject({
          state: "failed",
          detail: "The sign-in code expired before it was entered: start again.",
        }),
      );
      expect(lapsing.asked).toHaveLength(0);

      const cancelled = await deviceSetup([pending]);
      const three = await cancelled.flows.startDevice({ connectionId: "boxed-1", workspaceId: "w", providerId: "boxed" });
      expect(cancelled.flows.cancel(three.flowId, "w")).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(cancelled.asked).toHaveLength(0);
      expect(cancelled.flows.status(three.flowId, "w")).toMatchObject({ state: "failed", detail: "The sign-in was cancelled." });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a cancel once its token is being kept, so the page is never told cancelled of a kept sign-in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const keeping = await deviceSetup([granted]);
      let named: (response: Response) => void = () => undefined;
      keeping.slowAccount(
        () =>
          new Promise<Response>((resolve) => {
            named = resolve;
          }),
      );
      const started = await keeping.flows.startDevice({ connectionId: "boxed-1", workspaceId: "w", providerId: "boxed" });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(keeping.asked).toHaveLength(1));
      // The token came back and is being kept (its account still being named): too late to cancel.
      await vi.waitFor(() => expect(keeping.flows.cancel(started.flowId, "w")).toBe(false));
      named(Response.json({ email: "ana@example.com" }));
      await vi.waitFor(() => expect(keeping.flows.status(started.flowId, "w")).toMatchObject({ state: "connected" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes only an https address to enter the code at, and the pre-filled one only on that same site", async () => {
    const plain = await deviceSetup([pending], () =>
      Response.json({ device_code: "d", user_code: "C", verification_uri: "http://127.0.0.1/activate", expires_in: 900 }),
    );
    await expect(plain.flows.startDevice({ connectionId: "boxed-1", workspaceId: "w", providerId: "boxed" })).rejects.toMatchObject({
      message: expect.stringContaining("no https address"),
    });
    const elsewhere = await deviceSetup([pending], () =>
      Response.json({
        device_code: "d",
        user_code: "C",
        verification_uri: "https://auth.example.com/activate",
        verification_uri_complete: "https://evil.example/activate?user_code=C",
        expires_in: 900,
      }),
    );
    const started = await elsewhere.flows.startDevice({ connectionId: "boxed-1", workspaceId: "w", providerId: "boxed" });
    expect(started.verificationUriComplete).toBeUndefined();
    expect(started.verificationUri).toBe("https://auth.example.com/activate");
  });

  it("asks again after a server error or no answer, and never names its device code in a refusal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const flaky = await deviceSetup([
        () => new Response("down", { status: 503 }),
        () => {
          throw new TypeError("fetch failed");
        },
        granted,
      ]);
      const one = await flaky.flows.startDevice({ connectionId: "boxed-1", workspaceId: "w", providerId: "boxed" });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(flaky.asked).toHaveLength(1));
      // Five seconds longer after each.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(flaky.asked).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(flaky.flows.status(one.flowId, "w")).toMatchObject({ state: "connected" }));

      const echoing = await deviceSetup([() => Response.json({ error: "invalid_grant device-secret" }, { status: 400 })]);
      const two = await echoing.flows.startDevice({ connectionId: "boxed-1", workspaceId: "w", providerId: "boxed" });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(echoing.flows.status(two.flowId, "w")).toMatchObject({ state: "failed" }));
      expect(JSON.stringify(echoing.flows.status(two.flowId, "w"))).not.toContain("device-secret");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is refused for a channel that declares no device address, and never declared beside disallowsDeviceFlow", async () => {
    const { flows } = await deviceSetup([pending]);
    await expect(flows.startDevice({ connectionId: "inbox-1", workspaceId: "w", providerId: "inbox" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: "Inbox does not sign in with a code",
    });
    const google = {
      ...deviceDescriptor,
      auth: {
        kind: "oauth2",
        oauth: {
          ...(deviceDescriptor.auth.kind === "oauth2" ? deviceDescriptor.auth.oauth : ({} as never)),
          disallowsDeviceFlow: true,
        },
      },
    };
    expect(JSON.stringify(ChannelDescriptorSchema.safeParse(google).error?.issues)).toContain("declares no device address");
    expect(ChannelDescriptorSchema.safeParse(deviceDescriptor).success).toBe(true);
  });
});

describe("the account a connection is bound to", () => {
  const record = (authState: string, token: boolean, accountIdentity = "alice@example.com") => ({
    authState,
    accountIdentity,
    credentialRefs: token ? { oauth: "channels.c.oauth" } : {},
  });
  it("stays its account's after a client change drops its token, until it is disconnected", () => {
    expect(boundAccountOf(record("connected", true))).toBe("alice@example.com");
    // A client change marks it expired and drops the token: signing in as bob@ must still be refused.
    expect(boundAccountOf(record("expired", false))).toBe("alice@example.com");
    // Disconnected: free for another account.
    expect(boundAccountOf(record("revoked", false))).toBeUndefined();
    // Never signed in.
    expect(boundAccountOf(record("none", false, ""))).toBeUndefined();
  });
});
