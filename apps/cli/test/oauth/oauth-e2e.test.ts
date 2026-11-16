import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { fakeFetch, temporaryDirectories, delay } from "@tavi/test-support";

import {
  TaviError,
  type ChannelsListAnswer,
  type ChannelsPayload,
  type ChannelsSaveAnswer,
  type MessagingCapabilities,
} from "@tavi/contracts";

import { registerChannelDescriptor } from "../../src/features/channels/catalog.js";
import { runChannelsCli } from "../../src/features/channels/client.js";
import { channelsCommand } from "../../src/features/channels/owner.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { encryptCredentialDirectory } from "../../src/features/credentials/store.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * OAuth end to end against a local fake provider: a real HTTP server that checks PKCE and the client, rotates
 * refresh tokens and can revoke them, with a composed owner signing a channel
 * in through its own flow, the broker refreshing, and the channel's connector
 * asking for an access token — and for nothing else.
 */

interface Grant {
  readonly challenge: string;
  readonly redirectUri: string;
}

/** The fake provider: authorize issues a code bound to its PKCE challenge; token checks it, and refreshes with rotation. */
async function fakeProvider() {
  const codes = new Map<string, Grant>();
  const refreshTokens = new Set<string>();
  const counts = { refreshes: 0, exchanges: 0 };
  let accessCounter = 0;
  const tokens = (expiresIn: number) => {
    accessCounter += 1;
    const refresh = `refresh-${randomUUID()}`;
    refreshTokens.add(refresh);
    return { access_token: `access-${accessCounter}`, refresh_token: refresh, expires_in: expiresIn, scope: "mail", token_type: "Bearer" };
  };
  let expiresIn = 3600;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://provider.invalid");
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/authorize") {
      if (url.searchParams.get("client_id") !== "e2e-client" || url.searchParams.get("code_challenge_method") !== "S256")
        return answer(400, { error: "invalid_request" });
      const code = `code-${randomUUID()}`;
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirectUri });
      response.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` });
      response.end();
      return;
    }
    if (url.pathname === "/me")
      return answer(request.headers.authorization?.startsWith("Bearer access-") === true ? 200 : 401, { email: "e2e@example.com" });
    if (url.pathname === "/token") {
      let raw = "";
      request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      request.on("end", () => {
        const body = new URLSearchParams(raw);
        if (body.get("client_id") !== "e2e-client" || body.get("client_secret") !== "e2e-secret")
          return answer(401, { error: "invalid_client" });
        if (body.get("grant_type") === "authorization_code") {
          counts.exchanges += 1;
          const grant = codes.get(body.get("code") ?? "");
          codes.delete(body.get("code") ?? "");
          const verifier = body.get("code_verifier") ?? "";
          if (
            grant === undefined ||
            grant.redirectUri !== body.get("redirect_uri") ||
            createHash("sha256").update(verifier).digest("base64url") !== grant.challenge
          )
            return answer(400, { error: "invalid_grant" });
          return answer(200, tokens(expiresIn));
        }
        if (body.get("grant_type") === "refresh_token") {
          counts.refreshes += 1;
          const old = body.get("refresh_token") ?? "";
          if (!refreshTokens.delete(old)) return answer(400, { error: "invalid_grant" });
          return answer(200, tokens(expiresIn));
        }
        return answer(400, { error: "unsupported_grant_type" });
      });
      return;
    }
    answer(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    server,
    counts,
    base: `http://127.0.0.1:${port}`,
    /** Every refresh token issued so far stops working: the user revoked the access. */
    revokeAll: () => refreshTokens.clear(),
    setExpiresIn: (seconds: number) => {
      expiresIn = seconds;
    },
    /** A code issued for a challenge other than the flow's own: what a stolen code looks like. */
    foreignCode: (redirectUri: string) => {
      const code = `code-${randomUUID()}`;
      codes.set(code, { challenge: createHash("sha256").update("someone-elses-verifier").digest("base64url"), redirectUri });
      return code;
    },
  };
}

const capabilities: MessagingCapabilities = {
  receiveMode: "none",
  send: true,
  editOrProgress: false,
  formats: ["plain"],
  attachments: false,
  maxAttachmentBytes: 0,
  maxPartsPerMessage: 1,
  threads: false,
  interactions: false,
  deliveryReceipts: false,
  maxTextLength: 4096,
  approvals: "none",
};

const directories = temporaryDirectories({ prefix: "tavi-oauth-e2e-" });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  directories.cleanup();
});

let registered = false;

async function owner() {
  const provider = await fakeProvider();
  cleanups.push(() => new Promise<void>((resolve) => provider.server.close(() => resolve())));
  if (!registered) {
    registered = true;
    registerChannelDescriptor({
      providerId: "e2e-mail",
      label: "E2E Mail",
      kind: "email",
      description: "A mail channel signed in with OAuth.",
      settings: [],
      auth: {
        kind: "oauth2",
        oauth: {
          authorizeUrl: "https://oauth.test/authorize",
          tokenUrl: "https://oauth.test/token",
          scopes: ["mail"],
          pkce: true,
          client: { source: "operator" },
          redirect: "loopback-any-port",
          tokenAuthMethod: "client_secret_post",
          accountIdentity: { userinfoUrl: "https://oauth.test/me", field: "email" },
        },
      },
      sender: { label: "Address", placeholder: "a@example.com", pattern: ".+@.+", normalize: "lowercase", authentication: "provider" },
      target: { label: "Address", placeholder: "a@example.com", pattern: ".+@.+", normalize: "lowercase" },
    });
  }
  const directory = directories.create();
  // The descriptor's https addresses, served by the local fake.
  const toProvider = fakeFetch((url, init) => fetch(url.replace("https://oauth.test", provider.base), init));
  const runtime: TaviRuntime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, { approvalRequiredFor: [], openSavedChannels: true }),
    { requireModelTransport: false, oauthFetchOverride: toProvider },
  );
  cleanups.push(async () => {
    await runtime.close();
  });
  // The channel's connector: it asks for an access token as it starts, and tries what it must not read.
  const seen: { tokens: string[]; oauthKey?: string } = { tokens: [] };
  let connectorCredentials: { accessToken(): Promise<string> } | undefined;
  runtime.messaging.registerConnector({
    providerId: "e2e-mail",
    version: "1",
    configSchema: z.record(z.string(), z.unknown()),
    capabilities,
    createConnection: ({ credentials }) => ({
      start: async () => {
        connectorCredentials = credentials;
        seen.tokens.push(await credentials.accessToken());
        // Refused by the host for what they are, not merely failing.
        const refusal = (error: unknown): string =>
          error instanceof TaviError && error.code === "NOT_AUTHORIZED" ? "refused" : `failed: ${String(error)}`;
        seen.oauthKey = await credentials.get("oauth").then(String, refusal);
      },
      stop: async () => {},
      status: () => ({ state: "running", since: "" }),
      probe: async () => ({ ok: true }),
      send: async () => ({ status: "accepted", retryable: false, parts: [] }),
    }),
  });
  const run = async <T>(payload: ChannelsPayload): Promise<T> =>
    (
      await channelsCommand(
        {
          dataDirectory: directory,
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
  await encryptCredentialDirectory(directory);
  await run({ action: "oauth-client", providerId: "e2e-mail", clientId: "e2e-client", clientSecret: "e2e-secret" });
  const saved = await run<ChannelsSaveAnswer>({
    action: "save",
    workspaceId: "default",
    providerId: "e2e-mail",
    enabled: true,
    settings: {},
  });
  /** Starts a sign-in and follows the provider's redirect as a browser would, without following it home. */
  const signIn = async () => {
    const started = await run<{ flowId: string; authorizeUrl: string }>({
      action: "oauth-start",
      workspaceId: "default",
      connectionId: saved.connectionId,
      origin: "http://127.0.0.1:4100",
    });
    const redirect = await fetch(started.authorizeUrl.replace("https://oauth.test", provider.base), { redirect: "manual" });
    const back = new URL(redirect.headers.get("location") ?? "");
    return {
      flowId: started.flowId,
      state: back.searchParams.get("state") ?? "",
      code: back.searchParams.get("code") ?? "",
      redirectUri: `${back.origin}${back.pathname}`,
    };
  };
  const connection = async () =>
    (await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).connections.find(
      (candidate) => candidate.connectionId === saved.connectionId,
    );
  return { runtime, run, provider, saved, signIn, connection, seen, credentials: () => connectorCredentials };
}

describe("OAuth end to end against a fake provider", () => {
  it("signs in from a terminal: tavi channels connect prints the address, takes the redirect on 127.0.0.1, and waits for it", async () => {
    const { run, saved, provider, connection } = await owner();
    let stderr = "";
    let stdout = "";
    const connecting = runChannelsCli(
      { action: "connect", target: saved.connectionId, settings: {}, secretFiles: {}, workspaceId: "default", format: "text" },
      run,
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    // The person opens the printed address; the provider sends the browser back to the terminal's listener.
    let authorizeUrl: string | undefined;
    for (let tries = 0; tries < 200 && authorizeUrl === undefined; tries += 1) {
      authorizeUrl = /https:\/\/oauth\.test\/authorize\S+/.exec(stderr)?.[0];
      if (authorizeUrl === undefined) await delay(10);
    }
    if (authorizeUrl === undefined) throw new Error(`no address printed: ${stderr}`);
    const redirect = await fetch(authorizeUrl.replace("https://oauth.test", provider.base), { redirect: "manual" });
    const back = new URL(redirect.headers.get("location") ?? "");
    expect(back.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await fetch(back);
    expect(await page.text()).toContain("Connected");
    await connecting;
    expect(stdout).toBe(`connected ${saved.connectionId} as e2e@example.com\n`);
    expect(await connection()).toMatchObject({ authState: "connected", accountIdentity: "e2e@example.com" });
    // And signed out from the terminal too.
    await runChannelsCli(
      { action: "disconnect", target: saved.connectionId, settings: {}, secretFiles: {}, workspaceId: "default", format: "text" },
      run,
      { stdout: () => undefined, stderr: () => undefined },
    );
    expect(await connection()).toMatchObject({ authState: "revoked" });
  }, 30_000);

  it("signs in with PKCE, opens the channel, and gives its connector an access token and nothing else", async () => {
    const { run, signIn, connection, seen, provider } = await owner();
    expect((await connection())?.status.detail).toBe("not connected: sign in to use it");
    const flow = await signIn();
    expect(flow.redirectUri).toBe("http://127.0.0.1:4100/oauth/callback");
    expect(await run({ action: "oauth-callback", state: flow.state, code: flow.code })).toEqual({
      ok: true,
      message: "Connected as e2e@example.com.",
    });
    expect(await run({ action: "oauth-status", workspaceId: "default", flowId: flow.flowId })).toEqual({
      state: "connected",
      accountIdentity: "e2e@example.com",
    });
    expect(await connection()).toMatchObject({ authState: "connected", accountIdentity: "e2e@example.com", status: { state: "running" } });
    expect(seen).toEqual({ tokens: ["access-1"], oauthKey: "refused" });
    expect(provider.counts.exchanges).toBe(1);
  });

  it("refuses a wrong state, a replayed one, and a code bound to another verifier", async () => {
    const { run, signIn, provider } = await owner();
    const flow = await signIn();
    expect(await run({ action: "oauth-callback", state: `${flow.state}x`, code: flow.code })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/no longer valid/),
    });
    expect(provider.counts.exchanges).toBe(0);
    // The right state still works once; replayed, it does not.
    expect(await run({ action: "oauth-callback", state: flow.state, code: flow.code })).toMatchObject({ ok: true });
    expect(await run({ action: "oauth-callback", state: flow.state, code: flow.code })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/no longer valid/),
    });
    expect(provider.counts.exchanges).toBe(1);
  });

  it("connects nothing with a code bound to another verifier", async () => {
    const { run, signIn, provider, connection, seen } = await owner();
    const other = await signIn();
    expect(await run({ action: "oauth-callback", state: other.state, code: provider.foreignCode(other.redirectUri) })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/refused the sign-in: invalid_grant/),
    });
    expect(await run({ action: "oauth-status", workspaceId: "default", flowId: other.flowId })).toMatchObject({ state: "failed" });
    expect((await connection())?.authState).toBe("none");
    expect(seen.tokens).toEqual([]);
  });

  it("refreshes once for concurrent callers with the rotated token, and asks to reconnect when the provider revokes the access", async () => {
    const { runtime, run, signIn, provider, connection, credentials, saved } = await owner();
    provider.setExpiresIn(30);
    const flow = await signIn();
    await run({ action: "oauth-callback", state: flow.state, code: flow.code });
    // Every token here expires within the minute it is refreshed ahead of: each round of callers refreshes it.
    const before = provider.counts.refreshes;
    const tokens = await Promise.all([1, 2, 3].map(() => credentials()?.accessToken()));
    expect(new Set(tokens).size).toBe(1);
    expect(provider.counts.refreshes).toBe(before + 1);
    // The rotated refresh token is the one used next: the provider takes it (an old one it would refuse).
    const next = await credentials()?.accessToken();
    expect(next).not.toBe(tokens[0]);
    expect(provider.counts.refreshes).toBe(before + 2);
    provider.revokeAll();
    await expect(credentials()?.accessToken()).rejects.toThrow(/reconnect it/);
    await expect.poll(async () => (await connection())?.status.detail).toBe("reconnect needed: its sign-in expired or was revoked");
    // Refused for good, it is not tried again.
    expect(provider.counts.refreshes).toBe(before + 3);
    expect((await connection())?.authState).toBe("expired");
    await expect(
      runtime.store.asPort().repositories.center.summary({
        workspaceId: "default",
        principalId: "operator",
        timezone: "UTC",
        days: 1,
        now: runtime.clock.now(),
      }),
    ).resolves.toMatchObject({ reconnect: [{ connectionId: saved.connectionId, authState: "expired" }] });
  });
});
