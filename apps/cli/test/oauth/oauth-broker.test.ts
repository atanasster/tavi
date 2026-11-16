import { afterAll, describe, expect, it } from "vitest";

import type { ChannelDescriptor, MessagingConnectionAuthState } from "@tavi/contracts";
import { temporaryDirectories, fakeFetch as scriptedFetch, delay } from "@tavi/test-support";

import { saveOAuthClient } from "../../src/features/channels/oauth.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";
import { OAuthBroker } from "../../src/features/oauth/broker.js";
import { oauthTokenRef } from "../../src/features/oauth/flow.js";

/** The token broker behind `credentials.accessToken()`. */

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
      authorizeUrl: "https://auth.example.com/a",
      tokenUrl: "https://auth.example.com/token",
      revokeUrl: "https://auth.example.com/revoke",
      scopes: ["mail.read"],
      pkce: true,
      client: { source: "operator" },
      redirect: "loopback-any-port",
      tokenAuthMethod: "client_secret_post",
    },
  },
  sender: { label: "A", placeholder: "", pattern: ".+", normalize: "none", authentication: "provider" },
  target: { label: "A", placeholder: "", pattern: ".+", normalize: "none" },
};
const connection = { connectionId: "inbox-1", providerId: "inbox" };

async function setup(token: Record<string, unknown>, answer: () => Response) {
  const directory = directories.create("tavi-oauth-broker-");
  await saveOAuthClient(directory, descriptor, { clientId: "client-1", clientSecret: "client-secret" });
  await createLocalCredentialStore(directory).setSecret(oauthTokenRef("inbox-1"), JSON.stringify(token));
  const now = Date.parse("2026-10-09T00:00:00.000Z");
  const calls: { url: string; body: URLSearchParams }[] = [];
  const states: MessagingConnectionAuthState[] = [];
  const fakeFetch = scriptedFetch(async (url, init) => {
    calls.push({ url, body: new URLSearchParams(String(init?.body)) });
    await delay(5);
    return answer();
  });
  const broker = new OAuthBroker({
    dataDirectory: directory,
    fetch: fakeFetch,
    now: () => now,
    descriptorOf: () => descriptor,
    setAuthState: async (_id, state) => void states.push(state),
  });
  const stored = async () =>
    JSON.parse((await createLocalCredentialStore(directory).getSecret(oauthTokenRef("inbox-1"))) ?? "null") as Record<
      string,
      unknown
    > | null;
  return { broker, calls, states, stored, directory };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("OAuthBroker", () => {
  it("answers a fresh token as it is, and refreshes one about to expire once for every caller, keeping a rotated refresh token", async () => {
    const fresh = await setup(
      { accessToken: "a-1", refreshToken: "r-1", expiresAt: "2026-10-09T01:00:00.000Z", scopes: ["mail.read"], tokenType: "Bearer" },
      () => json({}),
    );
    expect(await fresh.broker.accessToken(connection)).toBe("a-1");
    expect(fresh.calls).toEqual([]);

    const expiring = await setup(
      { accessToken: "a-1", refreshToken: "r-1", expiresAt: "2026-10-09T00:00:30.000Z", scopes: ["mail.read"], tokenType: "Bearer" },
      () => json({ access_token: "a-2", refresh_token: "r-2", expires_in: 3600 }),
    );
    const tokens = await Promise.all([
      expiring.broker.accessToken(connection),
      expiring.broker.accessToken(connection),
      expiring.broker.accessToken(connection),
    ]);
    expect(tokens).toEqual(["a-2", "a-2", "a-2"]);
    expect(expiring.calls).toHaveLength(1);
    expect(Object.fromEntries(expiring.calls[0]?.body ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "r-1",
      client_id: "client-1",
      client_secret: "client-secret",
    });
    expect(await expiring.stored()).toMatchObject({ accessToken: "a-2", refreshToken: "r-2", expiresAt: "2026-10-09T01:00:00.000Z" });
  });

  it("marks a sign-in the provider refused for good expired, once, and leaves one a network failure interrupted as it was", async () => {
    const refused = await setup(
      { accessToken: "a-1", refreshToken: "r-1", expiresAt: "2026-10-09T00:00:00.000Z", scopes: ["mail.read"], tokenType: "Bearer" },
      () => json({ error: "invalid_grant" }, 400),
    );
    // Marked as a sign-in, so a mailbox tool's chat shows the Connect card.
    await expect(refused.broker.accessToken(connection)).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      message: expect.stringMatching(/reconnect it/),
      details: { signIn: true, connectionId: connection.connectionId },
    });
    expect(refused.states).toEqual(["expired"]);
    // An app the grant was not made with is refused for good too, never retried every poll.
    const otherApp = await setup(
      { accessToken: "a-1", refreshToken: "r-1", expiresAt: "2026-10-09T00:00:00.000Z", scopes: ["mail.read"], tokenType: "Bearer" },
      () => json({ error: "unauthorized_client" }, 400),
    );
    await expect(otherApp.broker.accessToken(connection)).rejects.toThrow(/reconnect it/);
    expect(otherApp.states).toEqual(["expired"]);
    const down = await setup(
      { accessToken: "a-1", refreshToken: "r-1", expiresAt: "2026-10-09T00:00:00.000Z", scopes: ["mail.read"], tokenType: "Bearer" },
      () => {
        throw new Error("connect ECONNREFUSED r-1");
      },
    );
    const failure = await down.broker.accessToken(connection).then(
      () => "",
      (error: unknown) => String(error),
    );
    expect(failure).toMatch(/could not be refreshed/);
    expect(failure).not.toContain("r-1");
    expect(down.states).toEqual([]);
    const noRefresh = await setup(
      { accessToken: "a-1", expiresAt: "2026-10-09T00:00:00.000Z", scopes: ["mail.read"], tokenType: "Bearer" },
      () => json({}),
    );
    await expect(noRefresh.broker.accessToken(connection)).rejects.toThrow(/expired/);
    expect(noRefresh.states).toEqual(["expired"]);
  });

  it("does not refresh again with a refresh token another caller's refresh already rotated, and signs out only after a refresh ends", async () => {
    let refreshes = 0;
    const rotating = await setup(
      { accessToken: "a-1", refreshToken: "r-1", expiresAt: "2026-10-09T00:00:00.000Z", scopes: ["mail.read"], tokenType: "Bearer" },
      () => {
        refreshes += 1;
        return json({ access_token: `a-${refreshes + 1}`, refresh_token: `r-${refreshes + 1}`, expires_in: 3600 });
      },
    );
    expect(await rotating.broker.accessToken(connection)).toBe("a-2");
    // A caller that read the old token before that refresh ended finds the new one, and refreshes nothing.
    expect(await rotating.broker.accessToken(connection)).toBe("a-2");
    expect(refreshes).toBe(1);
    const racing = await setup(
      { accessToken: "a-1", refreshToken: "r-1", expiresAt: "2026-10-09T00:00:00.000Z", scopes: ["mail.read"], tokenType: "Bearer" },
      () => json({ access_token: "a-2", refresh_token: "r-2", expires_in: 3600 }),
    );
    const refreshing = racing.broker.accessToken(connection).then(
      () => "kept",
      () => "refused",
    );
    await racing.broker.revoke(connection);
    expect(await refreshing).toBe("refused");
    expect(await racing.stored()).toBeNull();
  });

  it("asks for consent when the channel wants scopes the token lacks, using the token meanwhile, and signs out at the provider", async () => {
    const narrow = await setup({ accessToken: "a-1", refreshToken: "r-1", scopes: [], tokenType: "Bearer" }, () => json({}));
    expect(await narrow.broker.accessToken(connection)).toBe("a-1");
    expect(narrow.states).toEqual(["needs-consent"]);
    await narrow.broker.revoke(connection);
    expect(narrow.calls).toEqual([
      {
        url: "https://auth.example.com/revoke",
        body: new URLSearchParams({ token: "r-1", client_id: "client-1", client_secret: "client-secret" }),
      },
    ]);
    expect(await narrow.stored()).toBeNull();
    // Another app keeps the provider's grant: the token goes here, nothing is sent.
    const kept = await setup({ accessToken: "a-1", refreshToken: "r-1", scopes: [], tokenType: "Bearer" }, () => json({}));
    await kept.broker.revoke(connection, { upstream: false });
    expect(kept.calls).toEqual([]);
    expect(await kept.stored()).toBeNull();
    // A token made with a client no longer in force is revoked with that client.
    const older = await setup({ accessToken: "a-1", refreshToken: "r-1", scopes: [], tokenType: "Bearer" }, () => json({}));
    await older.broker.revoke(connection, { client: { clientId: "old-client", clientSecret: "old-secret" } });
    expect(older.calls).toEqual([
      {
        url: "https://auth.example.com/revoke",
        body: new URLSearchParams({ token: "r-1", client_id: "old-client", client_secret: "old-secret" }),
      },
    ]);
  });

  it("never writes a refreshed token over a sign-in made while it ran", async () => {
    const raced = await setup(
      { accessToken: "a-1", refreshToken: "r-1", expiresAt: "2026-10-09T00:00:30.000Z", scopes: ["mail.read"], tokenType: "Bearer" },
      () => json({ access_token: "a-old", refresh_token: "r-old", expires_in: 3600 }),
    );
    const signInAgain = async (): Promise<void> =>
      createLocalCredentialStore(raced.directory).setSecret(
        oauthTokenRef("inbox-1"),
        JSON.stringify({
          accessToken: "a-new",
          refreshToken: "r-new",
          expiresAt: "2026-10-09T01:00:00.000Z",
          scopes: ["mail.read"],
          tokenType: "Bearer",
        }),
      );
    const refreshing = raced.broker.accessToken(connection);
    // The operator signs in again while the refresh is with the provider.
    await signInAgain();
    expect(await refreshing).toBe("a-new");
    expect(await raced.stored()).toMatchObject({ accessToken: "a-new", refreshToken: "r-new" });
  });

  it("asks to allow more only for the channel's own access, never for an opt-in its tools ask for themselves", async () => {
    if (descriptor.auth.kind !== "oauth2") throw new Error("an OAuth channel");
    const withCalendar: ChannelDescriptor = {
      ...descriptor,
      auth: { kind: "oauth2", oauth: { ...descriptor.auth.oauth, optInScopes: { calendar: ["cal.read"] } } },
    };
    const { directory } = await setup(
      { accessToken: "a-1", refreshToken: "r-1", expiresAt: "2026-10-09T01:00:00.000Z", scopes: ["mail.read"], tokenType: "Bearer" },
      () => json({}),
    );
    const states: MessagingConnectionAuthState[] = [];
    const broker = new OAuthBroker({
      dataDirectory: directory,
      fetch: scriptedFetch(async () => json({})),
      now: () => Date.parse("2026-10-09T00:00:00.000Z"),
      descriptorOf: () => withCalendar,
      setAuthState: async (_id, state) => void states.push(state),
    });
    expect(await broker.accessToken(connection)).toBe("a-1");
    expect(states).toEqual([]);
  });

  it("asks to allow more when an account takes mail in that its token was not granted, and not once it stops", async () => {
    if (descriptor.auth.kind !== "oauth2") throw new Error("an OAuth channel");
    const withMail: ChannelDescriptor = {
      ...descriptor,
      auth: { kind: "oauth2", oauth: { ...descriptor.auth.oauth, optInScopes: { mail: ["mail.modify"] } } },
    };
    const { directory } = await setup(
      { accessToken: "a-1", refreshToken: "r-1", expiresAt: "2026-10-09T01:00:00.000Z", scopes: ["mail.read"], tokenType: "Bearer" },
      () => json({}),
    );
    const states: MessagingConnectionAuthState[] = [];
    let mail = false;
    const broker = new OAuthBroker({
      dataDirectory: directory,
      fetch: scriptedFetch(async () => json({})),
      now: () => Date.parse("2026-10-09T00:00:00.000Z"),
      descriptorOf: () => withMail,
      optInsOf: async () => ({ mail, calendar: true }),
      setAuthState: async (_id, state) => void states.push(state),
    });
    expect(await broker.accessToken(connection)).toBe("a-1");
    expect(states).toEqual([]);
    mail = true;
    expect(await broker.accessToken(connection)).toBe("a-1");
    expect(states).toEqual(["needs-consent"]);
  });

  it("marks an account whose mailbox was turned on as needing consent at once, before any call, and not one already granted", async () => {
    if (descriptor.auth.kind !== "oauth2") throw new Error("an OAuth channel");
    const withMail: ChannelDescriptor = {
      ...descriptor,
      auth: { kind: "oauth2", oauth: { ...descriptor.auth.oauth, optInScopes: { mail: ["mail.modify"] } } },
    };
    const brokerFor = async (scopes: string[], mail: boolean) => {
      const { directory } = await setup({ accessToken: "a-1", refreshToken: "r-1", scopes, tokenType: "Bearer" }, () => json({}));
      const states: MessagingConnectionAuthState[] = [];
      const broker = new OAuthBroker({
        dataDirectory: directory,
        fetch: scriptedFetch(async () => json({})),
        now: () => Date.parse("2026-10-09T00:00:00.000Z"),
        descriptorOf: () => withMail,
        optInsOf: async () => ({ mail, calendar: false }),
        setAuthState: async (_id, state) => void states.push(state),
      });
      return { broker, states };
    };
    const lacking = await brokerFor(["mail.read"], true);
    expect(await lacking.broker.markMailConsentMissing(connection)).toBe(true);
    expect(lacking.states).toEqual(["needs-consent"]);
    const granted = await brokerFor(["mail.read", "mail.modify"], true);
    expect(await granted.broker.markMailConsentMissing(connection)).toBe(false);
    const off = await brokerFor(["mail.read"], false);
    expect(await off.broker.markMailConsentMissing(connection)).toBe(false);
    expect([...granted.states, ...off.states]).toEqual([]);
  });
});
