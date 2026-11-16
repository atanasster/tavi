import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenerSpawn } from "@tavi/node-kit";
import { freePort, temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { mcpCommand, pluginsCommand } from "../../src/server/config-commands.js";
import { parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { runMcpAction, type McpActionContext } from "../../src/features/mcp/actions.js";
import { guardedFetch } from "../../src/features/mcp/fetch.js";
import { scopeList } from "../../src/features/mcp/client.js";
import { noticeWords } from "../../src/features/mcp/notices.js";
import {
  McpLogins,
  McpOAuthTokens,
  challengedMetadataUrl,
  clientMetadataDocument,
  loginCause,
  mcpOAuthRef,
  type McpGrantStore,
} from "../../src/features/mcp/oauth-provider.js";
import { OAuthCallbackRouter, endpointProblem, oauthSharedHostNote, openAuthorizationUrl } from "../../src/features/oauth/core.js";
import { createLocalCredentialStore, encryptCredentialDirectory } from "../../src/features/credentials/store.js";
import { runMcpLogin } from "../../src/features/mcp/login-client.js";
import { capture } from "../support/attached-owner.js";
import { startOAuthFake, type OAuthFake, type OAuthFakeOptions } from "../support/oauth-mcp-fake.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** OAuth for MCP servers. */

const fakes: OAuthFake[] = [];
const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const fake of fakes.splice(0)) await fake.close();
  directories.cleanup();
});

const fakeWith = async (options: OAuthFakeOptions = {}): Promise<OAuthFake> => {
  const fake = await startOAuthFake(options);
  fakes.push(fake);
  return fake;
};

function memoryStore(): McpGrantStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    read: async (reference) => values.get(reference) ?? null,
    write: async (reference, value) => void values.set(reference, value),
    delete: async (reference) => void values.delete(reference),
  };
}

function loginsFor(
  fake: OAuthFake,
  options: {
    readonly lan?: boolean;
    readonly publicUrl?: string;
    readonly client?: { readonly id: string; readonly secret?: string };
    readonly now?: () => number;
    readonly scope?: string;
  } = {},
) {
  const store = memoryStore();
  const fetchFor = () => guardedFetch({ lan: options.lan ?? true });
  const tokens = new McpOAuthTokens({ store, fetchFor, ...(options.now === undefined ? {} : { now: options.now }) });
  const signedIn: string[] = [];
  const logins = new McpLogins({
    tokens,
    fetchFor,
    server: async () => ({
      url: fake.mcpUrl,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.client === undefined
        ? {}
        : { clientId: options.client.id, ...(options.client.secret === undefined ? {} : { clientSecret: options.client.secret }) }),
    }),
    publicUrl: async () => options.publicUrl,
    signedIn: async (pluginId) => void signedIn.push(pluginId),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { store, tokens, logins, signedIn };
}

async function signIn(fake: OAuthFake, login: ReturnType<typeof loginsFor>) {
  const started = await login.logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" });
  const back = await fake.consent(started.authorizeUrl);
  const outcome = await login.logins.callback({ state: back.state, code: back.code });
  return { started, back, outcome };
}

describe("a login", () => {
  it("registers by DCR as Tavi (native, a loopback redirect), with PKCE and the resource, and stores the grant by issuer", async () => {
    const fake = await fakeWith();
    const login = loginsFor(fake);
    const { started, outcome } = await signIn(fake, login);
    expect(outcome).toEqual({ ok: true, message: "mcp.cal is signed in. You can close this page." });
    expect(login.signedIn).toEqual(["mcp.cal"]);
    expect(fake.registrations).toEqual([
      expect.objectContaining({ client_name: "Tavi", application_type: "native", redirect_uris: ["http://127.0.0.1:9/oauth/callback"] }),
    ]);
    const authorize = fake.authorizations[0] ?? {};
    expect(authorize).toMatchObject({
      code_challenge_method: "S256",
      resource: fake.mcpUrl,
      redirect_uri: "http://127.0.0.1:9/oauth/callback",
    });
    expect(authorize["state"]?.length).toBeGreaterThanOrEqual(40);
    expect(started.public).toBe(false);
    const stored = JSON.parse(login.store.values.get(mcpOAuthRef("mcp.cal")) ?? "{}") as {
      latest: string;
      grants: Record<string, { client: { client_id: string } }>;
    };
    expect(stored.latest).toBe(fake.base);
    expect(stored.grants[fake.base]?.client.client_id).toMatch(/^dcr-/);
    expect(await login.tokens.accessToken("mcp.cal")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("uses a pre-registered client first, and its secret", async () => {
    const fake = await fakeWith({ client: { id: "tavi-pre", secret: "s3cret" } });
    const login = loginsFor(fake, { client: { id: "tavi-pre", secret: "s3cret" } });
    expect((await signIn(fake, login)).outcome.ok).toBe(true);
    expect(fake.registrations).toEqual([]);
    expect(fake.tokenRequests[0]).toMatchObject({ client_id: "tavi-pre", client_secret: "s3cret" });
  });

  it("uses CIMD with a public https address: its URL is the client id, the redirect public", async () => {
    const fake = await fakeWith({ cimd: true });
    const login = loginsFor(fake, { publicUrl: "https://tavi.example/tavi" });
    const started = await login.logins.start({ pluginId: "mcp.cal" });
    expect(started.public).toBe(true);
    expect(fake.registrations).toEqual([]);
    expect(new URL(started.authorizeUrl).searchParams.get("client_id")).toBe("https://tavi.example/tavi/.well-known/tavi-mcp-client.json");
    expect(new URL(started.authorizeUrl).searchParams.get("redirect_uri")).toBe("https://tavi.example/tavi/oauth/callback");
    expect(login.logins.waitingPublic()).toBe(true);
    expect(clientMetadataDocument("https://tavi.example/tavi")).toEqual({
      client_id: "https://tavi.example/tavi/.well-known/tavi-mcp-client.json",
      client_name: "Tavi",
      redirect_uris: ["https://tavi.example/tavi/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });
  });

  it("adds a preset's authorization parameters and scope, never replacing what the SDK set (Google's offline access)", async () => {
    const fake = await fakeWith({ client: { id: "google-web", secret: "s" } });
    const fetchFor = () => guardedFetch({ lan: true });
    const logins = new McpLogins({
      tokens: new McpOAuthTokens({ store: memoryStore(), fetchFor }),
      fetchFor,
      publicUrl: async () => undefined,
      signedIn: async () => undefined,
      server: async () => ({
        url: fake.mcpUrl,
        clientId: "google-web",
        clientSecret: "s",
        authorizeParams: { access_type: "offline", prompt: "consent", state: "forged" },
        scope: "calendar.events",
      }),
    });
    const started = await logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" });
    const params = new URL(started.authorizeUrl).searchParams;
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("scope")).toBe("calendar.events");
    expect(params.getAll("state")).toHaveLength(1);
    expect(params.get("state")).not.toBe("forged");
  });

  it("tavi mcp login --port listens on that port, for a client that registered its redirect exactly (Google's Web client)", async () => {
    expect(parseArgs(["mcp", "login", "mcp.cal", "--port", "8765"])).toMatchObject({
      mcp: { action: "login", pluginId: "mcp.cal", port: 8765 },
    });
    expect(() => parseArgs(["mcp", "login", "mcp.cal", "--port", "80"])).toThrow(/--port takes 1024 to 65535/);
    const asked: unknown[] = [];
    await expect(
      runMcpLogin(
        "mcp.cal",
        async <T>(_command: "mcp" | "channels", payload: Readonly<Record<string, unknown>>): Promise<T> => {
          asked.push(payload["origin"]);
          throw new Error("stop here");
        },
        { stdout: () => undefined, stderr: () => undefined },
        { open: false, port: 48_765 },
      ),
    ).rejects.toThrow("stop here");
    expect(asked).toEqual(["http://127.0.0.1:48765"]);
  });

  it("finds the protected-resource metadata the server's 401 names (RFC 9728 §5.1) when it is not at a well-known path", async () => {
    const fake = await fakeWith({ authServerPath: "/as" });
    expect((await challengedMetadataUrl(fake.mcpUrl, guardedFetch({ lan: true })))?.href).toBe(`${fake.base}/custom/prm`);
    const { outcome } = await signIn(fake, loginsFor(fake));
    expect(outcome).toMatchObject({ ok: true });
  });

  it("asks for a client id when the server registers none and no CIMD applies", async () => {
    const fake = await fakeWith({ registration: false });
    await expect(loginsFor(fake).logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" })).rejects.toThrow(
      /registers no clients: create one there and set it with `tavi plugins config mcp.cal --set clientId=…/,
    );
    // A page is told so, with the redirect that client registers.
    await expect(loginsFor(fake).logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" })).rejects.toMatchObject({
      details: { needsClient: true, redirect: "http://127.0.0.1:9/oauth/callback" },
    });
  });
});

describe("the 2026-07-28 sign-in details", () => {
  it("adds offline_access when the server lists it, so a refresh token comes back", async () => {
    const fake = await fakeWith({ scopesSupported: ["calendar.read", "offline_access"] });
    const login = loginsFor(fake, { scope: "calendar.read" });
    const started = await login.logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" });
    expect(new URL(started.authorizeUrl).searchParams.get("scope")?.split(" ")).toEqual(["calendar.read", "offline_access"]);
  });

  it("signs in again for the union of what it held and what a refused call named", async () => {
    const fake = await fakeWith();
    const login = loginsFor(fake, { scope: "calendar.read" });
    fake.grantedScope = "calendar.read calendar.list";
    expect((await signIn(fake, login)).outcome.ok).toBe(true);
    await login.tokens.noteWantedScope("mcp.cal", "calendar.write");
    expect(await login.tokens.scopeToKeep("mcp.cal")).toBe("calendar.read calendar.list calendar.write");
    const again = await login.logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" });
    expect(new URL(again.authorizeUrl).searchParams.get("scope")?.split(" ").sort()).toEqual([
      "calendar.list",
      "calendar.read",
      "calendar.write",
    ]);
  });

  it("keeps the server's listed scopes when a step-up names one more and the server set none of its own", async () => {
    const fake = await fakeWith({ resourceScopes: ["calendar.read", "calendar.list"] });
    const login = loginsFor(fake);
    expect((await signIn(fake, login)).outcome.ok).toBe(true);
    await login.tokens.noteWantedScope("mcp.cal", "calendar.write");
    const again = await login.logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" });
    expect(new URL(again.authorizeUrl).searchParams.get("scope")?.split(" ").sort()).toEqual([
      "calendar.list",
      "calendar.read",
      "calendar.write",
    ]);
  });

  it("keeps a challenge's scope only when it is scope tokens", () => {
    expect(scopeList("calendar.write offline_access")).toBe("calendar.write offline_access");
    expect(scopeList('calendar "write"')).toBeUndefined();
    expect(scopeList("a\nb")).toBeUndefined();
    expect(scopeList("x".repeat(501))).toBeUndefined();
    expect(scopeList(undefined)).toBeUndefined();
  });

  it("refuses an answer, an error's included, from another issuer, without the server's words", async () => {
    const fake = await fakeWith();
    const login = loginsFor(fake);
    const started = await login.logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" });
    const state = new URL(started.authorizeUrl).searchParams.get("state") ?? "";
    const outcome = await login.logins.callback({ state, error: "access_denied", iss: "https://attacker.example" });
    expect(outcome).toEqual({
      ok: false,
      message: "mcp.cal was not signed in: the answer came from another server than the one the sign-in went to",
    });
  });

  it("refuses an answer without iss from a server that says it always sends one", async () => {
    const fake = await fakeWith({ issParameter: true });
    const login = loginsFor(fake);
    const { outcome } = await signIn(fake, login);
    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/another server than the one the sign-in went to/) });
    expect(fake.tokenRequests).toEqual([]);
  });
});

describe("refusals", () => {
  it("an issuer that does not match its address", async () => {
    const fake = await fakeWith({ issuerMismatch: true });
    await expect(loginsFor(fake).logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" })).rejects.toThrow();
    expect(fake.authorizations).toEqual([]);
  });

  it("metadata that advertises no PKCE", async () => {
    const fake = await fakeWith({ noPkce: true });
    await expect(loginsFor(fake).logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" })).rejects.toThrow(
      /does not advertise PKCE \(S256\)/,
    );
  });

  it("a javascript: or file: endpoint, never opened", async () => {
    const fake = await fakeWith({ scriptEndpoint: true });
    await expect(loginsFor(fake).logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" })).rejects.toThrow(
      /authorization server cannot be used|only https is opened/,
    );
    expect(fake.authorizations).toEqual([]);
    expect(endpointProblem("file:///etc/passwd", "authorization endpoint")).toBe(
      "its authorization endpoint is file: — only https is opened",
    );
    expect(endpointProblem("https://login.example/authorize", "authorization endpoint")).toBeUndefined();
  });

  it("the authorization URL: only https opened, its state on no macOS command line, and the shared-host note elsewhere", async () => {
    const spawned: { command: string; args: readonly string[]; stdin: string[] }[] = [];
    const spawn: OpenerSpawn = (command, args) => {
      const stdin: string[] = [];
      spawned.push({ command, args, stdin });
      const child = Object.assign(new EventEmitter(), {
        unref: () => undefined,
        stdin: Object.assign(new EventEmitter(), {
          end: (chunk: string) => {
            stdin.push(chunk);
            setImmediate(() => child.emit("exit", 0));
          },
        }),
      });
      setImmediate(() => child.emit("spawn"));
      return child;
    };
    expect(await openAuthorizationUrl("http://login.example/authorize?state=s", { platform: "darwin", spawn })).toBe(false);
    expect(spawned).toEqual([]);
    const url = "https://login.example/authorize?state=the-flow-state";
    expect(await openAuthorizationUrl(url, { platform: "darwin", spawn })).toBe(true);
    expect(spawned[0]).toMatchObject({ command: "osascript", args: [] });
    expect(spawned[0]?.stdin.join("")).toContain("the-flow-state");
    expect(await openAuthorizationUrl(url, { platform: "linux", spawn })).toBe(true);
    expect(spawned[1]).toMatchObject({ command: "xdg-open", args: [url] });
    expect(oauthSharedHostNote("use `--no-open`.", "darwin")).toBeUndefined();
    expect(oauthSharedHostNote("use `--no-open`.", "linux")).toMatch(/other people have accounts on this computer.*use `--no-open`\.\n$/);
  });

  it("a state that does not match: no token, and the link is spent", async () => {
    const fake = await fakeWith();
    const login = loginsFor(fake);
    const started = await login.logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" });
    const back = await fake.consent(started.authorizeUrl);
    const fallback = {
      owns: () => true,
      callback: async () => ({ ok: false, message: "This sign-in link has expired or was already used." }),
    };
    const router = new OAuthCallbackRouter([login.logins], fallback);
    expect(await router.callback({ state: `${back.state}x`, code: back.code })).toMatchObject({ ok: false });
    expect(login.store.values.size).toBe(0);
    expect(await router.callback({ state: back.state, code: back.code })).toMatchObject({ ok: true });
    expect(await router.callback({ state: back.state, code: back.code })).toMatchObject({ ok: false });
  });

  it("discovery to a private address without lan", async () => {
    const fake = await fakeWith();
    await expect(loginsFor(fake, { lan: false }).logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:9" })).rejects.toThrow(
      /lan|private|loopback/i,
    );
  });
});

describe("tokens", () => {
  it("learns a weekly sign-out from a refusal 7 days after signing in, and keeps it across sign-ins", async () => {
    const fake = await fakeWith({ expiresIn: 30 });
    let now = Date.parse("2026-10-01T09:00:00.000Z");
    const login = loginsFor(fake, { now: () => now });
    await signIn(fake, login);
    fake.refuseRefresh = true;
    now += 3 * 86_400_000;
    await expect(login.tokens.accessToken("mcp.cal")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect((await login.tokens.grant("mcp.cal"))?.learnedWeekly).toBe(false);
    now += 4 * 86_400_000;
    await expect(login.tokens.accessToken("mcp.cal")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect((await login.tokens.grant("mcp.cal"))?.learnedWeekly).toBe(true);
    fake.refuseRefresh = false;
    await signIn(fake, login);
    expect((await login.tokens.grant("mcp.cal"))?.learnedWeekly).toBe(true);
  });

  it("passes a logout's local-only ask on to the owner's logout", async () => {
    const asked: unknown[] = [];
    // Only the logout is called: the rest of the context is never reached.
    const context = {
      logout: async (pluginId: string, options?: { readonly upstream?: boolean }) => {
        asked.push({ pluginId, options });
        return { hadGrant: true, confirmed: false };
      },
    } as Partial<McpActionContext> as McpActionContext;
    expect(await runMcpAction(context, { action: "logout", pluginId: "mcp.cal", upstream: false }, "operator")).toEqual({
      loggedOut: { pluginId: "mcp.cal", hadGrant: true, confirmed: false },
    });
    await runMcpAction(context, { action: "logout", pluginId: "mcp.cal" }, "operator");
    expect(asked).toEqual([
      { pluginId: "mcp.cal", options: { upstream: false } },
      { pluginId: "mcp.cal", options: {} },
    ]);
  });

  it("forgets a grant here only when asked, sending the server no revocation", async () => {
    const fake = await fakeWith();
    const login = loginsFor(fake);
    await signIn(fake, login);
    expect(await login.tokens.revoke("mcp.cal", { upstream: false })).toEqual({ hadGrant: true, confirmed: false });
    expect(await login.tokens.signedIn("mcp.cal")).toBe(false);
    expect(fake.revoked).toEqual([]);
  });

  it("does not take a refusal well after a week for a weekly sign-out", async () => {
    const fake = await fakeWith({ expiresIn: 30 });
    let now = Date.parse("2026-10-01T09:00:00.000Z");
    const login = loginsFor(fake, { now: () => now });
    await signIn(fake, login);
    fake.refuseRefresh = true;
    now += 8 * 86_400_000;
    await expect(login.tokens.accessToken("mcp.cal")).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect((await login.tokens.grant("mcp.cal"))?.learnedWeekly).toBe(false);
  });

  it("refreshes once, a minute early, for calls that arrive together; a refused refresh is a login with its cause", async () => {
    const fake = await fakeWith({ expiresIn: 30 });
    const login = loginsFor(fake);
    await signIn(fake, login);
    const first = fake.tokenRequests.length;
    const [a, b, c] = await Promise.all([
      login.tokens.accessToken("mcp.cal"),
      login.tokens.accessToken("mcp.cal"),
      login.tokens.accessToken("mcp.cal"),
    ]);
    expect(new Set([a, b, c]).size).toBe(1);
    expect(fake.tokenRequests.slice(first).map((request) => request["grant_type"])).toEqual(["refresh_token"]);
    fake.refuseRefresh = true;
    await expect(login.tokens.accessToken("mcp.cal")).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
      details: { mcpFailure: "login", cause: "the server no longer accepts its sign-in (invalid_grant)" },
    });
  });

  it("names Google's 7-day Testing expiry in the login notice", () => {
    const cause = loginCause("https://accounts.google.com", "invalid_grant");
    expect(cause).toMatch(/an OAuth app in Testing signs in for 7 days at a time/);
    expect(noticeWords({ pluginId: "mcp.calendar", kind: "login", detail: { cause } }).summary).toMatch(
      /^Google refused its sign-in \(invalid_grant\): an OAuth app in Testing signs in for 7 days at a time.*`tavi mcp login mcp.calendar`\.$/,
    );
  });

  it("a logout revokes where the server allows and forgets the grant", async () => {
    const fake = await fakeWith();
    const login = loginsFor(fake);
    await signIn(fake, login);
    expect(await login.tokens.revoke("mcp.cal")).toEqual({ hadGrant: true, confirmed: true });
    expect(fake.revoked).toHaveLength(1);
    expect(login.store.values.size).toBe(0);
    await expect(login.tokens.accessToken("mcp.cal")).rejects.toMatchObject({ details: { mcpFailure: "login" } });
    expect(await login.tokens.revoke("mcp.cal")).toEqual({ hadGrant: false, confirmed: false });
  });

  it("a confidential client authenticates its revocation; one the server refuses is forgotten, and says it was not confirmed", async () => {
    const client = { id: "tavi-client", secret: "s3cret" };
    const fake = await fakeWith({ client, registration: false });
    const login = loginsFor(fake, { client });
    await signIn(fake, login);
    expect(await login.tokens.revoke("mcp.cal")).toEqual({ hadGrant: true, confirmed: true });
    expect(fake.revoked).toHaveLength(1);
    await signIn(fake, login);
    fake.refuseRevoke = true;
    expect(await login.tokens.revoke("mcp.cal")).toEqual({ hadGrant: true, confirmed: false });
    expect(login.store.values.size).toBe(0);
  });
});

describe("an OAuth server in the owner", () => {
  async function tavi(argv: readonly string[]) {
    const out = capture();
    const code = await main([...argv], { io: out.io });
    return { code, stdout: out.stdout(), stderr: out.stderr() };
  }

  it("needs a login to probe; signed in through the owner's router, its tools are called with the token; a refused token makes it login-required", async () => {
    const fake = await fakeWith();
    const data = directories.create("tavi-mcp-oauth-");
    // A sign-in keeps a refresh token, which only an encrypted store holds.
    await encryptCredentialDirectory(data);
    const at = ["--data-dir", data];
    expect((await tavi(["mcp", "add", "cal", "--url", fake.mcpUrl, "--lan", "--oauth", "--no-probe", ...at])).code).toBe(EXIT.ok);
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), {
      modelOverride: createFixtureModel({ turns: [{ text: "done" }] }),
    });
    runtimes.push(runtime);
    expect(await mcpCommand(runtime, { action: "probe", pluginId: "mcp.cal" }, "operator")).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/needs a login: it is not signed in; `tavi mcp login mcp\.cal`/) },
    });
    const started = await mcpCommand(runtime, { action: "login", pluginId: "mcp.cal", origin: "http://127.0.0.1:9" }, "operator");
    if (!started.ok) throw new Error(JSON.stringify(started));
    const back = await fake.consent((started.result as { login: { authorizeUrl: string } }).login.authorizeUrl);
    expect(await runtime.oauthCallbacks.callback({ state: back.state, code: back.code })).toMatchObject({ ok: true });
    expect((await mcpCommand(runtime, { action: "probe", pluginId: "mcp.cal" }, "operator")).ok).toBe(true);
    expect(
      (
        await mcpCommand(
          runtime,
          {
            action: "approve",
            pluginId: "mcp.cal",
            version: "1.0.0",
            effects: {},
            floors: {},
            timeouts: {},
            disabled: ["crash", "hang", "freeze"],
          },
          "operator",
        )
      ).ok,
    ).toBe(true);
    expect((await pluginsCommand(runtime, { action: "enable", pluginId: "mcp.cal" }, "operator")).ok).toBe(true);
    const context = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };
    expect(await runtime.tools.get("mcp.cal.echo")?.handler({ input: { text: "hi" }, context, signal: new AbortController().signal })).toBe(
      "hi",
    );
    // A call needing more access: a scope notice, and no login started.
    fake.forbid = true;
    await expect(
      runtime.tools.get("mcp.cal.echo")?.handler({ input: { text: "scope" }, context, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ details: { mcpFailure: "auth", status: 403 } });
    expect(runtime.mcp.supervisor.status("mcp.cal")).toMatchObject({ failures: 0 });
    expect(
      (await runtime.store.asPort().repositories.mcp.listNotices({ pluginId: "mcp.cal", open: true })).map((notice) => notice.kind),
    ).toEqual(["scope"]);
    // What it named is asked for at the next sign-in.
    const stepUp = await mcpCommand(runtime, { action: "login", pluginId: "mcp.cal", origin: "http://127.0.0.1:9" }, "operator");
    if (!stepUp.ok) throw new Error(JSON.stringify(stepUp));
    const stepUpUrl = new URL((stepUp.result as { login: { authorizeUrl: string } }).login.authorizeUrl);
    expect(stepUpUrl.searchParams.get("scope")?.split(" ")).toContain("calendar.write");
    fake.forbid = false;
    // A bare 403 is no scope to grant: the login notice is raised, but its tools are not stopped for it.
    fake.deny = true;
    await expect(
      runtime.tools.get("mcp.cal.echo")?.handler({ input: { text: "denied" }, context, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ details: { mcpFailure: "auth", status: 403 } });
    expect(
      (await runtime.store.asPort().repositories.mcp.listNotices({ pluginId: "mcp.cal", open: true })).map((notice) => notice.kind).sort(),
    ).toEqual(["login", "scope"]);
    expect(runtime.mcp.supervisor.status("mcp.cal").state).not.toBe("login-required");
    fake.deny = false;
    expect(
      await runtime.tools.get("mcp.cal.echo")?.handler({ input: { text: "allowed again" }, context, signal: new AbortController().signal }),
    ).toBe("allowed again");
    // Tavi's access revoked at the server: the next call is refused (401), the server needs a login, and a notice says so.
    fake.revokeAll();
    await runtime.mcp.supervisor.stop("mcp.cal");
    // The call that met it is a lapsed sign-in's: a login, so a person attending gets its Connect card and wait.
    await expect(
      runtime.tools.get("mcp.cal.echo")?.handler({ input: { text: "again" }, context, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ details: { mcpFailure: "login", pluginId: "mcp.cal" } });
    expect(runtime.mcp.supervisor.status("mcp.cal")).toMatchObject({ state: "login-required", failures: 0 });
    await expect(
      runtime.tools.get("mcp.cal.echo")?.handler({ input: { text: "fast" }, context, signal: new AbortController().signal }),
    ).rejects.toThrow(/needs a login/);
    expect(
      (await runtime.store.asPort().repositories.mcp.listNotices({ pluginId: "mcp.cal", open: true })).map((notice) => notice.kind).sort(),
    ).toEqual(["login", "scope"]);

    // `tavi mcp login`'s loop: its listener here takes the redirect back to the owner's router; signed in again, the notice closes.
    const out: string[] = [];
    await runMcpLogin(
      "mcp.cal",
      async <T>(command: "mcp" | "channels", payload: Readonly<Record<string, unknown>>): Promise<T> => {
        if (command === "channels") return (await runtime.oauthCallbacks.callback(payload as { state: string; code?: string })) as T;
        const answer = await mcpCommand(runtime, payload as Parameters<typeof mcpCommand>[1], "operator");
        if (!answer.ok) throw new Error(JSON.stringify(answer));
        return answer.result as T;
      },
      { stdout: (text) => void out.push(text), stderr: () => undefined },
      {
        open: true,
        // The person's browser: consents, and follows the redirect to the listener.
        openUrl: (url) => {
          void fetch(url, { redirect: "manual" }).then((answer) => fetch(answer.headers.get("location") ?? ""));
          return true;
        },
      },
    );
    expect(out).toEqual(["mcp.cal is signed in\n"]);
    expect(
      await runtime.tools.get("mcp.cal.echo")?.handler({ input: { text: "back" }, context, signal: new AbortController().signal }),
    ).toBe("back");
    expect(
      (await runtime.store.asPort().repositories.mcp.listNotices({ pluginId: "mcp.cal", open: true })).map((notice) => notice.kind),
    ).toEqual([]);
  }, 120_000);
});

describe("logout with no owner", () => {
  it("revokes at the server and forgets the grant", async () => {
    const fake = await fakeWith();
    const login = loginsFor(fake);
    await signIn(fake, login);
    const data = directories.create("tavi-mcp-logout-");
    const out = capture();
    expect(
      await main(["mcp", "add", "cal", "--url", fake.mcpUrl, "--lan", "--oauth", "--no-probe", "--data-dir", data], { io: out.io }),
    ).toBe(EXIT.ok);
    const credentials = createLocalCredentialStore(data);
    if (credentials.access !== "read-write") throw new Error("read-only store");
    await credentials.setSecret(mcpOAuthRef("mcp.cal"), login.store.values.get(mcpOAuthRef("mcp.cal")) ?? "");
    const loggedOut = capture();
    expect(await main(["mcp", "logout", "mcp.cal", "--data-dir", data], { io: loggedOut.io })).toBe(EXIT.ok);
    expect(loggedOut.stdout()).toContain("mcp.cal signed out");
    expect(fake.revoked).toHaveLength(1);
    expect(await credentials.getSecret(mcpOAuthRef("mcp.cal"))).toBeNull();
  }, 60_000);

  it("removing the server revokes its sign-in at the server and deletes it, as one of its credentials", async () => {
    const fake = await fakeWith();
    const login = loginsFor(fake);
    await signIn(fake, login);
    const data = directories.create("tavi-mcp-remove-oauth-");
    expect(
      await main(["mcp", "add", "cal", "--url", fake.mcpUrl, "--lan", "--oauth", "--no-probe", "--data-dir", data], { io: capture().io }),
    ).toBe(EXIT.ok);
    const credentials = createLocalCredentialStore(data);
    if (credentials.access !== "read-write") throw new Error("read-only store");
    await credentials.setSecret(mcpOAuthRef("mcp.cal"), login.store.values.get(mcpOAuthRef("mcp.cal")) ?? "");
    const removed = capture();
    expect(await main(["plugins", "remove", "mcp.cal", "--data-dir", data], { io: removed.io }), removed.stderr()).toBe(EXIT.ok);
    expect(removed.stdout()).toMatch(/deleted its home, 1 credentials/);
    expect(fake.revoked).toHaveLength(1);
    expect(await credentials.getSecret(mcpOAuthRef("mcp.cal"))).toBeNull();
  }, 60_000);

  it("a public login asks for the public listener once it waits", async () => {
    const fake = await fakeWith({ cimd: true });
    const store = memoryStore();
    const fetchFor = () => guardedFetch({ lan: true });
    let opened = 0;
    const logins = new McpLogins({
      tokens: new McpOAuthTokens({ store, fetchFor }),
      fetchFor,
      server: async () => ({ url: fake.mcpUrl }),
      publicUrl: async () => "https://tavi.example",
      signedIn: async () => undefined,
      awaitingPublic: async () => void (opened += 1),
    });
    await logins.start({ pluginId: "mcp.cal" });
    expect(opened).toBe(1);
  });

  it("starts no sign-in while the credential store is not encrypted: its refresh token would be kept in the clear", async () => {
    const store = memoryStore();
    const fetchFor = () => guardedFetch({ lan: true });
    let asked = 0;
    const logins = new McpLogins({
      tokens: new McpOAuthTokens({ store, fetchFor }),
      fetchFor,
      server: async () => ((asked += 1), { url: "https://mcp.example/mcp" }),
      publicUrl: async () => undefined,
      signedIn: async () => undefined,
      encrypted: () => false,
    });
    await expect(logins.start({ pluginId: "mcp.cal", origin: "http://127.0.0.1:8765" })).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
      message: expect.stringContaining("tavi credentials encrypt"),
    });
    expect(asked).toBe(0);
  });
});

describe("an expired sign-in in the owner", () => {
  it("a refused refresh makes the server login-required with a notice naming why; no token is ever outside the credential store", async () => {
    const fake = await fakeWith({ expiresIn: 30 });
    const data = directories.create("tavi-mcp-expiry-");
    // A sign-in keeps a refresh token, which only an encrypted store holds.
    await encryptCredentialDirectory(data);
    expect(
      await main(["mcp", "add", "cal", "--url", fake.mcpUrl, "--lan", "--oauth", "--no-probe", "--data-dir", data], { io: capture().io }),
    ).toBe(EXIT.ok);
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), {
      modelOverride: createFixtureModel({ turns: [{ text: "done" }] }),
    });
    runtimes.push(runtime);
    const started = await mcpCommand(runtime, { action: "login", pluginId: "mcp.cal", origin: "http://127.0.0.1:9" }, "operator");
    if (!started.ok) throw new Error(JSON.stringify(started));
    const back = await fake.consent((started.result as { login: { authorizeUrl: string } }).login.authorizeUrl);
    expect(await runtime.oauthCallbacks.callback({ state: back.state, code: back.code })).toMatchObject({ ok: true });
    expect((await mcpCommand(runtime, { action: "probe", pluginId: "mcp.cal" }, "operator")).ok).toBe(true);
    expect(
      (
        await mcpCommand(
          runtime,
          {
            action: "approve",
            pluginId: "mcp.cal",
            version: "1.0.0",
            effects: {},
            floors: {},
            timeouts: {},
            disabled: ["crash", "hang", "freeze"],
          },
          "operator",
        )
      ).ok,
    ).toBe(true);
    expect((await pluginsCommand(runtime, { action: "enable", pluginId: "mcp.cal" }, "operator")).ok).toBe(true);
    const context = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };
    expect(await runtime.tools.get("mcp.cal.echo")?.handler({ input: { text: "hi" }, context, signal: new AbortController().signal })).toBe(
      "hi",
    );
    // The grant expires within the minute, so the next call refreshes; the authorization server refuses it.
    fake.refuseRefresh = true;
    await runtime.mcp.supervisor.stop("mcp.cal");
    await expect(
      runtime.tools.get("mcp.cal.echo")?.handler({ input: { text: "again" }, context, signal: new AbortController().signal }),
    ).rejects.toThrow(/needs a login/);
    expect(runtime.mcp.supervisor.status("mcp.cal")).toMatchObject({ state: "login-required", failures: 0 });
    const notices = await runtime.store.asPort().repositories.mcp.listNotices({ pluginId: "mcp.cal", open: true });
    expect(notices.map((notice) => [notice.kind, notice.detail])).toEqual([
      ["login", { cause: "the server no longer accepts its sign-in (invalid_grant)" }],
    ]);
    // No token the server issued is anywhere but the credential store (encrypted at rest once its key is
    // set) — not in the database, the server's log, the plugin's files or the CLI's output.
    const logs = capture();
    expect(await main(["mcp", "logs", "mcp.cal", "--data-dir", data], { io: logs.io })).toBe(EXIT.ok);
    const seen = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return path === join(data, "credentials") ? [] : seen(path);
        return entry.isFile() ? [readFileSync(path).toString("latin1")] : [];
      });
    const everything = [...seen(data), logs.stdout(), logs.stderr()].join("\n");
    expect(fake.issued.length).toBeGreaterThan(1);
    expect(readFileSync(join(data, "credentials", mcpOAuthRef("mcp.cal")), "utf8").length).toBeGreaterThan(0);
    for (const token of fake.issued)
      expect(everything.includes(token), `token ${token.slice(0, 6)}… found in the data directory or output`).toBe(false);
  }, 120_000);
});

describe("a public sign-in through the owner's ingress (CIMD)", () => {
  it("serves Tavi's client document and takes the callback at the public address, and stays open while the sign-in names that document", async () => {
    const fake = await fakeWith({ cimd: true, registration: false });
    const data = directories.create("tavi-mcp-public-");
    // A sign-in keeps a refresh token, which only an encrypted store holds.
    await encryptCredentialDirectory(data);
    expect(
      await main(["mcp", "add", "cal", "--url", fake.mcpUrl, "--lan", "--oauth", "--no-probe", "--data-dir", data], { io: capture().io }),
    ).toBe(EXIT.ok);
    const port = await freePort();
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), { modelOverride: createFixtureModel({ turns: [] }) });
    runtimes.push(runtime);
    await runtime.store
      .asPort()
      .repositories.channelIngress.set({ host: "127.0.0.1", port, publicUrl: "https://tavi.example" }, "2026-10-14T00:00:00.000Z");
    // A login with no loopback listener comes back to the public address: the ingress opens for it.
    const started = await mcpCommand(runtime, { action: "login", pluginId: "mcp.cal" }, "operator");
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(started.result).toMatchObject({ login: { public: true } });
    const document = (await (await fetch(`http://127.0.0.1:${String(port)}/.well-known/tavi-mcp-client.json`)).json()) as {
      client_id: string;
      redirect_uris: string[];
      client_name: string;
    };
    expect(document).toMatchObject({
      client_id: "https://tavi.example/.well-known/tavi-mcp-client.json",
      client_name: "Tavi",
      redirect_uris: ["https://tavi.example/oauth/callback"],
    });
    const back = await fake.consent((started.result as { login: { authorizeUrl: string } }).login.authorizeUrl);
    expect(fake.authorizations.at(-1)?.["client_id"]).toBe(document.client_id);
    expect(back.redirect).toBe("https://tavi.example/oauth/callback");
    // The browser comes back to the public address, which reaches this listener.
    const page = await fetch(
      `http://127.0.0.1:${String(port)}/oauth/callback?state=${encodeURIComponent(back.state)}&code=${encodeURIComponent(back.code)}`,
    );
    expect(page.status).toBe(200);
    expect((await mcpCommand(runtime, { action: "probe", pluginId: "mcp.cal" }, "operator")).ok).toBe(true);
    // The sign-in names Tavi by that document: the authorization server may read it again at a refresh, so it stays served.
    expect(await runtime.mcp.oauth.publicClientInUse()).toBe(true);
    expect((await fetch(`http://127.0.0.1:${String(port)}/.well-known/tavi-mcp-client.json`)).status).toBe(200);
  }, 60_000);
});

describe("invariant 1: only the operator signs a server in", () => {
  it("no module but the mcp command's actions, the host and the login CLI reaches a login", () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
    const importers: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && /\bMcpLogins\b|logins\.start\(/.test(readFileSync(path, "utf8")))
          importers.push(relative(src, path));
      }
    };
    walk(src);
    expect(importers.sort()).toEqual(["features/mcp/actions.ts", "features/mcp/host.ts", "features/mcp/oauth-provider.ts"]);
  });
});
