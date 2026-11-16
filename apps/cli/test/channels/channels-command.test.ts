import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ChannelsGrantsAnswer,
  ChannelsListAnswer,
  ChannelsPayload,
  ChannelsSaveAnswer,
  ChannelsShareClientAnswer,
} from "@tavi/contracts";
import { temporaryDirectories, fakeFetch } from "@tavi/test-support";

import { channelSecretRef } from "../../src/features/channels/settings.js";
import { channelsCommand, type ChannelsCommandDependencies } from "../../src/features/channels/owner.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import {
  CHANNELS_INGRESS_TRUSTED_PROXIES_SETTING,
  CHANNELS_SHARED_CLIENTS_SETTING,
  channelDescriptorOf,
  channelGrantsOf,
  mailboxKitOf,
  parseSharedClients,
  parseTrustedProxies,
  registerChannelDescriptor,
  setSharedClientBindings,
  unregisterChannelDescriptor,
  registerEnabledBuiltinChannels,
} from "../../src/features/channels/catalog.js";
import { channelPresentationOf } from "../../src/features/apps/builtin.js";
import { oauthClientOf, sharedProviderOf } from "../../src/features/channels/oauth.js";
import { createLocalCredentialStore, encryptCredentialDirectory, listCredentialRefs } from "../../src/features/credentials/store.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

// Read before any owner starts: the built-in channels registered as an owner whose channel plugins are all enabled would.
registerEnabledBuiltinChannels(() => true);

/** The `channels` command, against a composed owner and a fake Telegram. */

const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  directories.cleanup();
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const sent: unknown[] = [];
const telegram = fakeFetch(async (url, init) => {
  if (url.endsWith("/getMe")) return json({ ok: true, result: { id: 5 } });
  if (url.endsWith("/sendMessage")) {
    sent.push(JSON.parse(String(init?.body)));
    return json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 42 } } });
  }
  return new Promise<Response>((_resolve, reject) =>
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
  );
});

async function owner(messagingAllowedDestinations?: readonly string[], oauthFetchOverride?: typeof fetch) {
  const directory = directories.create("tavi-channels-command-");
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(directory, {
      approvalRequiredFor: [],
      openSavedChannels: true,
      ...(messagingAllowedDestinations === undefined ? {} : { messagingAllowedDestinations }),
    }),
    {
      requireModelTransport: false,
      channelFetch: { telegram: telegram },
      ...(oauthFetchOverride === undefined ? {} : { oauthFetchOverride }),
    },
  );
  runtimes.push(runtime);
  const run = async <T>(payload: ChannelsPayload, overrides: Partial<ChannelsCommandDependencies> = {}): Promise<T> =>
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
          ...overrides,
        },
        payload,
      )
    ).result as T;
  return { runtime, directory, run };
}

describe("the channels command", () => {
  it("keeps Gmail's OAuth app as the client every Google app shares, and connects with that one only", async () => {
    const { run, directory } = await owner();
    await encryptCredentialDirectory(directory);
    const gmail = channelDescriptorOf("gmail");
    const spec = gmail?.auth.kind === "oauth2" ? gmail.auth.oauth : undefined;
    if (gmail === undefined || spec === undefined) throw new Error("no gmail channel");
    // A client of Gmail's own is never used: it signs in with the shared Google client only.
    const store = createLocalCredentialStore(directory);
    await store.setSecret("channels.oauth-client.gmail.id", "legacy.apps.googleusercontent.com");
    await expect(oauthClientOf(directory, gmail, spec)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect((await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).oauthClients["gmail"]).toMatchObject({
      own: false,
      ready: false,
    });
    await run({ action: "oauth-client", providerId: "gmail", clientId: "shared.apps.googleusercontent.com", clientSecret: "s" });
    const refs = (await listCredentialRefs(directory)).valid;
    expect(refs).toEqual(expect.arrayContaining(["oauth-clients.google.id", "oauth-clients.google.secret"]));
    expect(await oauthClientOf(directory, gmail, spec)).toEqual({
      clientId: "shared.apps.googleusercontent.com",
      clientSecret: "s",
      shared: true,
    });
    expect((await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).oauthClients["gmail"]).toEqual({
      source: "operator",
      own: true,
      ready: true,
    });
    // Other Google apps sign in with it too: it is changed, not forgotten, from Gmail.
    await expect(run({ action: "oauth-client-clear", providerId: "gmail" })).rejects.toThrow(/every google app shares/);
  });

  it("names the Google app as Google, not by its channel's label, when its client secret needs an encrypted store", async () => {
    const { run } = await owner();
    await expect(
      run({ action: "oauth-client", providerId: "gmail", clientId: "shared.apps.googleusercontent.com", clientSecret: "s" }),
    ).rejects.toThrow(/^Google's OAuth client secret is kept only in an encrypted credential store/);
  });

  it("fails a sign-in whose shared client's secret cannot be read, never signing in without it", async () => {
    const directory = directories.create("tavi-channels-oauth-client-");
    await encryptCredentialDirectory(directory);
    const gmail = channelDescriptorOf("gmail");
    const spec = gmail?.auth.kind === "oauth2" ? gmail.auth.oauth : undefined;
    if (gmail === undefined || spec === undefined) throw new Error("no gmail channel");
    const store = createLocalCredentialStore(directory);
    await store.setSecret("oauth-clients.google.id", "shared.apps.googleusercontent.com");
    await store.setSecret("oauth-clients.google.secret", "s");
    expect(await oauthClientOf(directory, gmail, spec)).toEqual({
      clientId: "shared.apps.googleusercontent.com",
      clientSecret: "s",
      shared: true,
    });
    // Its secret, written by a newer tavi: this one cannot read it.
    const file = readdirSync(directory, { recursive: true, encoding: "utf8" }).find((path) => path.endsWith("oauth-clients.google.secret"));
    if (file === undefined) throw new Error("no stored secret");
    writeFileSync(join(directory, file), "tavi-enc:v9:unreadable");
    await expect(oauthClientOf(directory, gmail, spec)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  /** The command against a fake signed-in connection of `providerId`: what it signs out, and what it reloads. */
  async function signedInCommand(providerId: string) {
    const { runtime, directory } = await owner();
    await encryptCredentialDirectory(directory);
    const repositories = runtime.store.asPort().repositories;
    const signedIn = {
      connectionId: `${providerId}-1`,
      providerId,
      workspaceId: "default",
      credentialRefs: { oauth: `channels.${providerId}-1.oauth` },
    };
    const expired: string[] = [];
    const reloaded: string[] = [];
    const deps: ChannelsCommandDependencies = {
      dataDirectory: directory,
      repositories: {
        ...repositories,
        messagingConnections: {
          ...repositories.messagingConnections,
          list: async () => [signedIn] as never,
          setAuthState: async (input: { readonly connectionId: string }) => void expired.push(input.connectionId),
        } as never,
      },
      channels: runtime.channels,
      messaging: runtime.messaging,
      reload: async (workspaceId) => {
        reloaded.push(workspaceId);
        return { failed: [], purgeCancelled: [] };
      },
      applyIngress: async () => undefined,
      pairings: runtime.pairings,
      oauth: runtime.oauthFlows,
      revokeToken: async () => undefined,
      now: () => runtime.clock.now(),
    };
    return { directory, expired, reloaded, run: async (payload: ChannelsPayload) => await channelsCommand(deps, payload) };
  }

  it("replaces a shared client that cannot be read: its sign-ins are signed out and reloaded, and the new client is kept", async () => {
    const { directory, expired, reloaded, run } = await signedInCommand("gmail");
    const store = createLocalCredentialStore(directory);
    await store.setSecret("oauth-clients.google.id", "old.apps.googleusercontent.com");
    // The stored client, written by a newer tavi: this one cannot read it.
    const file = readdirSync(directory, { recursive: true, encoding: "utf8" }).find((path) => path.endsWith("oauth-clients.google.id"));
    if (file === undefined) throw new Error("no stored client");
    writeFileSync(join(directory, file), "tavi-enc:v9:unreadable");
    await run({ action: "oauth-client", providerId: "gmail", clientId: "new.apps.googleusercontent.com" });
    expect(expired).toEqual(["gmail-1"]);
    expect(reloaded).toEqual(["default"]);
    expect(await store.getSecret("oauth-clients.google.id")).toBe("new.apps.googleusercontent.com");
  });

  it("does not take any other failure to read the current client as a reason to sign out", async () => {
    registerChannelDescriptor({
      providerId: "inbox-misplaced",
      label: "Misplaced",
      kind: "email",
      description: "d",
      settings: [],
      // A plugin client whose secret is kept somewhere else than its own place: refused as NOT_AUTHORIZED.
      auth: {
        kind: "oauth2",
        oauth: {
          authorizeUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
          scopes: [],
          pkce: true,
          client: { source: "plugin", clientId: "plugin-client", clientSecretRef: "elsewhere.secret" },
          redirect: "loopback-any-port",
          tokenAuthMethod: "client_secret_post",
        },
      },
      sender: { label: "Address", placeholder: "", pattern: ".+", normalize: "none", authentication: "provider" },
      target: { label: "Address", placeholder: "", pattern: ".+", normalize: "none" },
    });
    try {
      const { expired, run } = await signedInCommand("inbox-misplaced");
      await expect(run({ action: "oauth-client", providerId: "inbox-misplaced", clientId: "mine" })).rejects.toMatchObject({
        code: "NOT_AUTHORIZED",
      });
      expect(expired).toEqual([]);
    } finally {
      unregisterChannelDescriptor("inbox-misplaced");
    }
  });

  it("lists every installed channel, and adds, tests, lists and deletes a connection from its descriptor alone", async () => {
    const { run, directory, runtime } = await owner();
    expect(
      (await run<{ channels: { providerId: string }[] }>({ action: "catalog" })).channels.map((channel) => channel.providerId),
    ).toEqual(["telegram", "mailgun", "gmail"]);
    const saved = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "telegram",
      enabled: true,
      settings: {},
      secrets: { token: "bot-secret" },
    });
    expect(saved.connectionId).toMatch(/^telegram-[0-9a-f]{8}$/);
    expect(saved).not.toHaveProperty("notApplied");
    const listed = await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" });
    expect(listed.connections).toEqual([
      expect.objectContaining({
        connectionId: saved.connectionId,
        label: "Telegram",
        enabled: true,
        secretsStored: { token: true },
        status: { state: "running" },
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("bot-secret");
    expect(await run({ action: "test", workspaceId: "default", connectionId: saved.connectionId, to: "42" })).toEqual({
      status: "accepted",
    });
    expect(sent.at(-1)).toMatchObject({ chat_id: "42" });
    // The agent sees it: open, in its workspace, with no target allowed.
    const reachable = await runtime.tools.get("messaging.channels")!.handler({
      input: {},
      context: { workspaceId: "default", principalId: "operator", runId: "r", caller: "cli" },
      signal: new AbortController().signal,
    });
    expect(reachable).toEqual({
      channels: [
        expect.objectContaining({ connectionId: saved.connectionId, channel: "Telegram", kind: "chat", buttons: true, allowedTargets: [] }),
      ],
      // Nobody is bound yet, and no target allowed: no person to message by name.
      people: [],
    });
    // Someone allowed on it, and a send left pending on it.
    await run({ action: "allow", workspaceId: "default", connectionId: saved.connectionId, sender: "42", principalId: "ana" });
    // A test to a person allowed on it reaches their own chat; one not allowed is refused, not sent.
    expect(await run({ action: "test", workspaceId: "default", connectionId: saved.connectionId, to: "42", direct: true })).toEqual({
      status: "accepted",
    });
    expect(sent.at(-1)).toMatchObject({ chat_id: "42" });
    await expect(run({ action: "test", workspaceId: "default", connectionId: saved.connectionId, to: "43", direct: true })).rejects.toThrow(
      /43 is not allowed/,
    );
    // Nor one allowed in another workspace: this workspace reaches only its own people.
    await runtime.store.asPort().repositories.messagingIdentityBindings.bind({
      connectionId: saved.connectionId,
      externalSenderId: "44",
      workspaceId: "other",
      principalId: "cy",
      approvedBy: "test",
      createdAt: runtime.clock.now(),
    });
    await expect(run({ action: "test", workspaceId: "default", connectionId: saved.connectionId, to: "44", direct: true })).rejects.toThrow(
      /44 is not allowed/,
    );
    const outbox = runtime.store.asPort().repositories.messagingOutbox;
    await outbox.begin({
      effectId: "stuck",
      connectionId: saved.connectionId,
      message: { effectId: "stuck", connectionId: saved.connectionId, destination: { chatId: "42" }, parts: [{ content: "hi" }] },
      now: { fixed: runtime.clock.now() },
    });
    await run({ action: "delete", workspaceId: "default", connectionId: saved.connectionId });
    expect((await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).connections).toEqual([]);
    // Nobody reaches the agent through it, and what was left pending on it is settled as uncertain.
    expect((await run<{ people: unknown[] }>({ action: "people", workspaceId: "default" })).people).toEqual([]);
    // The operator's own principal comes with it, for allowing a sender as them ("This is me").
    expect(
      await run(
        { action: "people", workspaceId: "default" },
        { operatorOf: (workspaceId) => (workspaceId === "default" ? "operator" : undefined) },
      ),
    ).toEqual({ people: [], operator: "operator" });
    expect(await outbox.get("stuck")).toMatchObject({
      state: "resolved",
      outcome: { status: "uncertain", parts: [{ error: "connection deleted before the send was confirmed" }] },
    });
    expect(runtime.messaging.capabilitiesOf(saved.connectionId)).toBeUndefined();
    expect((await listCredentialRefs(directory)).valid).not.toContain(channelSecretRef(saved.connectionId, "token"));
    // A tombstone: its history still names its channel.
    expect((await runtime.store.asPort().repositories.messagingConnections.list(undefined, { includeDeleted: true }))[0]).toMatchObject({
      connectionId: saved.connectionId,
      enabled: false,
      deletedAt: expect.any(String),
    });
  });

  it("probes a connection without sending anything: its account, and its setup notes", async () => {
    const { run } = await owner();
    const saved = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "telegram",
      enabled: true,
      settings: {},
      secrets: { token: "bot-secret" },
    });
    const before = sent.length;
    expect(await run({ action: "probe", workspaceId: "default", connectionId: saved.connectionId })).toMatchObject({ ok: true });
    expect(sent).toHaveLength(before);
    await expect(run({ action: "probe", workspaceId: "default", connectionId: "telegram-nope" })).rejects.toThrow();
  });

  it("tells the agent the targets allowed on each connection, each in its channel's form", async () => {
    const { run, runtime } = await owner(["*:42", "*:Ops@Example.com"]);
    const chat = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "telegram",
      enabled: true,
      settings: {},
      secrets: { token: "t" },
    });
    const context = { workspaceId: "default", principalId: "operator", runId: "r", caller: "cli" };
    const listed = async () =>
      (
        (await runtime.tools.get("messaging.channels")!.handler({ input: {}, context, signal: new AbortController().signal })) as {
          channels: { connectionId: string; allowedTargets: string[] }[];
        }
      ).channels;
    // An email address is no Telegram target: not offered there.
    expect(await listed()).toEqual([expect.objectContaining({ connectionId: chat.connectionId, allowedTargets: ["42"] })]);
  });

  it("checks what is saved against the channel's descriptor", async () => {
    const { run } = await owner();
    await expect(run({ action: "save", workspaceId: "default", providerId: "telegram", enabled: true, settings: {} })).rejects.toThrow(
      /Enter Bot token/,
    );
    await expect(
      run({ action: "save", workspaceId: "default", providerId: "telegram", enabled: false, settings: { colour: "red" } }),
    ).rejects.toThrow(/no setting colour/);
    await expect(run({ action: "save", workspaceId: "default", providerId: "mailgun", enabled: false, settings: {} })).rejects.toThrow(
      /Enter Sending domain/,
    );
    await expect(
      run({ action: "save", workspaceId: "default", providerId: "mailgun", enabled: false, settings: { domain: "https://x" } }),
    ).rejects.toThrow(/not in the form/);
    await expect(run({ action: "save", workspaceId: "default", providerId: "nothing", enabled: false, settings: {} })).rejects.toThrow(
      /No channel nothing/,
    );
    // The listener's own routes are `/hooks/p/…` and `/hooks/schedules/…`: no new connection takes either id.
    for (const connectionId of ["p", "schedules"])
      await expect(
        run({
          action: "save",
          workspaceId: "default",
          connectionId,
          providerId: "mailgun",
          enabled: false,
          settings: { domain: "mg.example.com" },
        }),
      ).rejects.toThrow(/reserved/);
    // Disabled, a connection may be saved without its secrets; its account follows the descriptor.
    const mail = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "mailgun",
      enabled: false,
      settings: { domain: "mg.example.com" },
    });
    expect((await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).connections[0]).toMatchObject({
      connectionId: mail.connectionId,
      accountIdentity: "tavi@mg.example.com",
      secretsStored: { apiKey: false, webhookSigningKey: false },
    });
  });

  it("allows people by the channel's own sender form, trusting unverified mail only where messages are verified one by one", async () => {
    const { run } = await owner();
    const chat = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "telegram",
      enabled: true,
      settings: {},
      secrets: { token: "t" },
    });
    const mail = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "mailgun",
      enabled: false,
      settings: { domain: "mg.example.com" },
    });
    await expect(
      run({ action: "allow", workspaceId: "default", connectionId: chat.connectionId, sender: "@name", principalId: "ana" }),
    ).rejects.toThrow(/Enter a telegram user id/);
    await expect(
      run({
        action: "allow",
        workspaceId: "default",
        connectionId: chat.connectionId,
        sender: "42",
        principalId: "ana",
        trustUnverified: true,
      }),
    ).rejects.toThrow(/verifies every sender itself/);
    await run({ action: "allow", workspaceId: "default", connectionId: chat.connectionId, sender: "42", principalId: "ana", name: "Ana" });
    await run({
      action: "allow",
      workspaceId: "default",
      connectionId: mail.connectionId,
      sender: "Ana@Example.com",
      principalId: "ana",
      trustUnverified: true,
    });
    const people = (
      await run<{ people: { connectionId: string; externalSenderId: string; trustUnverified?: unknown }[] }>({
        action: "people",
        workspaceId: "default",
      })
    ).people;
    expect(people.map((person) => [person.connectionId, person.externalSenderId])).toEqual([
      [chat.connectionId, "42"],
      [mail.connectionId, "ana@example.com"],
    ]);
    expect(people[1]?.trustUnverified).toBeDefined();
    await run({ action: "revoke", workspaceId: "default", connectionId: chat.connectionId, sender: "42" });
    await expect(run({ action: "revoke", workspaceId: "default", connectionId: chat.connectionId, sender: "42" })).rejects.toThrow(
      /No matching allowed person/,
    );
  });

  it("pairs a person by a code they send, allowed only once the operator confirms who sent it", async () => {
    const { run, runtime } = await owner();
    const chat = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "telegram",
      enabled: true,
      settings: {},
      secrets: { token: "t" },
    });
    const pairing = await run<{ pairingId: string; code: string }>({
      action: "pair",
      workspaceId: "default",
      connectionId: chat.connectionId,
      principalId: "ana",
      name: "Ana",
    });
    expect(await run({ action: "pairing", workspaceId: "default", pairingId: pairing.pairingId })).toMatchObject({
      state: "waiting",
      principalId: "ana",
    });
    await expect(run({ action: "confirm-pair", workspaceId: "default", pairingId: pairing.pairingId })).rejects.toThrow(/No one has sent/);
    // Another workspace's page sees none of it, and can neither confirm nor cancel it.
    expect(await run({ action: "pairing", workspaceId: "other", pairingId: pairing.pairingId })).toEqual({ state: "gone" });
    await run({ action: "cancel-pair", workspaceId: "other", pairingId: pairing.pairingId });
    await expect(run({ action: "confirm-pair", workspaceId: "other", pairingId: pairing.pairingId })).rejects.toThrow(/No one has sent/);
    // An allowed sender's message, or a redelivered one, claims nothing.
    await run({ action: "allow", workspaceId: "default", connectionId: chat.connectionId, sender: "55", principalId: "bo" });
    await runtime.messaging.ingest({
      connectionId: chat.connectionId,
      providerEventId: "pair-0",
      kind: "message",
      externalSenderId: "55",
      externalConversationId: "55",
      occurredAt: runtime.clock.now(),
      receivedAt: runtime.clock.now(),
      content: pairing.code,
    });
    expect(await run({ action: "pairing", workspaceId: "default", pairingId: pairing.pairingId })).toMatchObject({ state: "waiting" });
    await run({ action: "revoke", workspaceId: "default", connectionId: chat.connectionId, sender: "55" });
    // A redelivery of the bound sender's message, now from nobody allowed, is still a duplicate: it claims nothing.
    await runtime.messaging.ingest({
      connectionId: chat.connectionId,
      providerEventId: "pair-0",
      kind: "message",
      externalSenderId: "55",
      externalConversationId: "55",
      occurredAt: runtime.clock.now(),
      receivedAt: runtime.clock.now(),
      content: pairing.code,
    });
    expect(await run({ action: "pairing", workspaceId: "default", pairingId: pairing.pairingId })).toMatchObject({ state: "waiting" });
    await runtime.messaging.ingest({
      connectionId: chat.connectionId,
      providerEventId: "pair-1",
      kind: "message",
      externalSenderId: "77",
      externalConversationId: "77",
      occurredAt: runtime.clock.now(),
      receivedAt: runtime.clock.now(),
      content: pairing.code,
    });
    expect(await run({ action: "pairing", workspaceId: "default", pairingId: pairing.pairingId })).toMatchObject({
      state: "claimed",
      sender: "77",
    });
    // Not allowed until confirmed.
    expect((await run<{ people: unknown[] }>({ action: "people", workspaceId: "default" })).people).toEqual([]);
    await run({ action: "confirm-pair", workspaceId: "default", pairingId: pairing.pairingId });
    expect((await run<{ people: unknown[] }>({ action: "people", workspaceId: "default" })).people).toEqual([
      expect.objectContaining({ connectionId: chat.connectionId, externalSenderId: "77", principalId: "ana", displayName: "Ana" }),
    ]);
    expect(await run({ action: "pairing", workspaceId: "default", pairingId: pairing.pairingId })).toEqual({ state: "gone" });
  });

  it("refuses a code for a connection that failed to open, saying why, instead of waiting for a message that cannot arrive", async () => {
    const { run, runtime } = await owner();
    const chat = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "telegram",
      enabled: true,
      settings: {},
      secrets: { token: "t" },
    });
    const failed = {
      configured: () => runtime.channels.configured(),
      list: () =>
        runtime.channels.list().map((view) => ({
          ...view,
          status: { state: "failed" as const, detail: "Telegram getMe failed: Unauthorized", since: runtime.clock.now() },
        })),
    };
    await expect(
      run({ action: "pair", workspaceId: "default", connectionId: chat.connectionId, principalId: "operator" }, { channels: failed }),
    ).rejects.toThrow("Telegram isn't running: Telegram getMe failed: Unauthorized. Fix it in Settings → Channels");
    // The canvas says it in its own words, from these facts (QA 2033).
    await expect(
      run({ action: "pair", workspaceId: "default", connectionId: chat.connectionId, principalId: "operator" }, { channels: failed }),
    ).rejects.toMatchObject({ details: { notListening: true, label: "Telegram" } });
  });

  it("includes the Telegram deep link on pair when the bot has a username, and falls back to the sender's Telegram name on confirm-pair", async () => {
    const { run, runtime } = await owner();
    const saved = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "telegram",
      enabled: true,
      settings: {},
      secrets: { token: "t" },
    });
    const pairing = await run<{ pairingId: string; code: string; account?: string; linkUrl?: string; openLabel?: string }>(
      {
        action: "pair",
        workspaceId: "default",
        connectionId: saved.connectionId,
        principalId: "operator",
      },
      {
        messaging: {
          ...runtime.messaging,
          probe: async () => ({
            ok: true,
            detail: "Bot @tavi_bot.",
            setup: { lines: ["Bot @tavi_bot."], link: { label: "Open the chat", url: "https://t.me/tavi_bot" } },
          }),
        },
      },
    );
    const dashed = `${pairing.code.slice(0, 4)}-${pairing.code.slice(4)}`;
    // Built from Telegram's descriptor (`pairing`): the account read from the test's setup link.
    expect(pairing.account).toBe("tavi_bot");
    expect(pairing.linkUrl).toBe(`https://t.me/tavi_bot?start=${dashed}`);
    expect(pairing.openLabel).toBe("Open in Telegram");

    await runtime.messaging.ingest({
      connectionId: saved.connectionId,
      providerEventId: "pair-start-1",
      kind: "message",
      externalSenderId: "88",
      senderName: "Robin (@robin_tg)",
      externalConversationId: "88",
      occurredAt: runtime.clock.now(),
      receivedAt: runtime.clock.now(),
      content: `/start ${dashed}`,
    });
    expect(await run({ action: "pairing", workspaceId: "default", pairingId: pairing.pairingId })).toMatchObject({
      state: "claimed",
      sender: "88",
      senderName: "Robin (@robin_tg)",
    });
    await run({ action: "confirm-pair", workspaceId: "default", pairingId: pairing.pairingId });
    expect((await run<{ people: unknown[] }>({ action: "people", workspaceId: "default" })).people).toEqual([
      expect.objectContaining({
        connectionId: saved.connectionId,
        externalSenderId: "88",
        principalId: "operator",
        displayName: "Robin (@robin_tg)",
      }),
    ]);
  });

  it("keeps the operator's own OAuth app for a channel, once for all its connections, never showing it", async () => {
    const { run, directory } = await owner();
    registerChannelDescriptor({
      providerId: "inbox-oauth",
      label: "Inbox",
      kind: "email",
      description: "An OAuth mail channel.",
      settings: [],
      auth: {
        kind: "oauth2",
        oauth: {
          authorizeUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
          scopes: ["mail"],
          pkce: true,
          client: { source: "operator" },
          redirect: "loopback-any-port",
          tokenAuthMethod: "client_secret_post",
        },
      },
      sender: { label: "Address", placeholder: "a@example.com", pattern: ".+@.+", normalize: "lowercase", authentication: "provider" },
      target: { label: "Address", placeholder: "a@example.com", pattern: ".+@.+", normalize: "lowercase" },
      setupHelp: "Create an OAuth client with the provider.",
    });
    const status = async () => (await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).oauthClients;
    expect((await status())["inbox-oauth"]).toEqual({ source: "operator", own: false, ready: false });
    // Builtin channels that use secrets have no OAuth app.
    expect(await status()).not.toHaveProperty("telegram");
    // A client secret is kept only in an encrypted store.
    await expect(
      run({ action: "oauth-client", providerId: "inbox-oauth", clientId: "client-123", clientSecret: "shh-secret" }),
    ).rejects.toThrow(/encrypted credential store/);
    expect((await status())["inbox-oauth"]).toEqual({ source: "operator", own: false, ready: false });
    await encryptCredentialDirectory(directory);
    await run({ action: "oauth-client", providerId: "inbox-oauth", clientId: "client-123", clientSecret: "shh-secret" });
    expect((await status())["inbox-oauth"]).toEqual({ source: "operator", own: true, ready: true });
    expect(JSON.stringify(await run({ action: "list", workspaceId: "default" }))).not.toMatch(/client-123|shh-secret/);
    await expect(run({ action: "oauth-client", providerId: "telegram", clientId: "x" })).rejects.toThrow(/does not connect with OAuth/);
    // Saved again with no secret, the old secret goes: the client is a public one now.
    await run({ action: "oauth-client", providerId: "inbox-oauth", clientId: "client-456" });
    const refs = (await listCredentialRefs(directory)).valid;
    expect(refs).toContain("channels.oauth-client.inbox-oauth.id");
    expect(refs).not.toContain("channels.oauth-client.inbox-oauth.secret");
    await run({ action: "oauth-client-clear", providerId: "inbox-oauth" });
    expect((await status())["inbox-oauth"]).toEqual({ source: "operator", own: false, ready: false });
    // A channel that ships its app is ready without one of yours.
    registerChannelDescriptor({
      providerId: "inbox-shipped",
      label: "Shipped",
      kind: "email",
      description: "d",
      settings: [],
      auth: {
        kind: "oauth2",
        oauth: {
          authorizeUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
          scopes: [],
          pkce: true,
          client: { source: "plugin", clientId: "plugin-client" },
          redirect: "loopback-any-port",
          tokenAuthMethod: "none",
        },
      },
      sender: { label: "Address", placeholder: "", pattern: ".+", normalize: "none", authentication: "provider" },
      target: { label: "Address", placeholder: "", pattern: ".+", normalize: "none" },
    });
    expect((await status())["inbox-shipped"]).toEqual({ source: "plugin", own: false, ready: true });
  });

  it("never gives a plugin channel that claims a provider the client its provider's apps share, nor mailbox tools", async () => {
    const { directory } = await owner();
    await encryptCredentialDirectory(directory);
    const store = createLocalCredentialStore(directory);
    await store.setSecret("oauth-clients.google.id", "shared.apps.googleusercontent.com");
    await store.setSecret("oauth-clients.google.secret", "the-shared-secret");
    const claiming = {
      providerId: "evil-mail",
      label: "Evil mail",
      kind: "email" as const,
      description: "Claims Google's shared client.",
      settings: [],
      auth: {
        kind: "oauth2" as const,
        oauth: {
          authorizeUrl: "https://evil.example/authorize",
          tokenUrl: "https://evil.example/token",
          scopes: [],
          pkce: true as const,
          client: { source: "operator" as const },
          redirect: "loopback-any-port" as const,
          tokenAuthMethod: "client_secret_post" as const,
        },
      },
      sender: { label: "Address", placeholder: "", pattern: ".+", normalize: "none" as const, authentication: "provider" as const },
      target: { label: "Address", placeholder: "", pattern: ".+", normalize: "none" as const },
      app: { name: "Evil mail", summary: "", category: "email" as const, provider: "google", scopes: [], mailbox: true as const },
    };
    registerChannelDescriptor(claiming);
    try {
      const spec = claiming.auth.oauth;
      // Its own client, or none: never Google's shared one, whose secret would go to its token address.
      await expect(oauthClientOf(directory, claiming, spec)).rejects.toThrow();
      expect(sharedProviderOf("evil-mail")).toBeUndefined();
      expect(channelPresentationOf(claiming)).not.toHaveProperty("provider");
      expect(channelPresentationOf(claiming)).not.toHaveProperty("mailbox");
      // Its own words otherwise: an empty summary is its description.
      expect(channelPresentationOf(claiming)).toMatchObject({ name: "Evil mail", summary: "Claims Google's shared client." });
    } finally {
      unregisterChannelDescriptor("evil-mail");
    }
  });

  it("shares the provider's client with a plugin channel only once the operator binds it, and its mailbox only with its kit", async () => {
    const { directory, run, runtime } = await owner();
    await encryptCredentialDirectory(directory);
    const store = createLocalCredentialStore(directory);
    await store.setSecret("oauth-clients.google.id", "shared.apps.googleusercontent.com");
    await store.setSecret("oauth-clients.google.secret", "the-shared-secret");
    const meta = {
      get: (key: string) => runtime.store.getMeta(key),
      set: async (key: string, value: string) => await runtime.store.setMeta(key, value, runtime.clock.now()),
    };
    const mail = {
      providerId: "acme-mail",
      label: "Acme mail",
      kind: "email" as const,
      description: "Mail through Google, reviewed.",
      settings: [],
      auth: {
        kind: "oauth2" as const,
        oauth: {
          // Google's own addresses: a client its apps share goes to no other token address.
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          scopes: [],
          pkce: true as const,
          client: { source: "operator" as const },
          redirect: "loopback-any-port" as const,
          tokenAuthMethod: "client_secret_post" as const,
        },
      },
      sender: { label: "Address", placeholder: "", pattern: ".+", normalize: "none" as const, authentication: "provider" as const },
      target: { label: "Address", placeholder: "", pattern: ".+", normalize: "none" as const },
      app: {
        name: "Acme mail",
        summary: "",
        category: "email" as const,
        provider: "google",
        dataClass: "public" as const,
        scopes: [],
        mailbox: true as const,
      },
    };
    const kit = { searchMax: 10, searchHint: "", open: () => ({}) as never, recipientOf: (value: string) => value };
    registerChannelDescriptor(mail, "acme.mail", kit, "1.0.0");
    const elsewhere = {
      ...mail,
      providerId: "evil-mail",
      auth: { ...mail.auth, oauth: { ...mail.auth.oauth, tokenUrl: "https://evil.example/token" } },
    };
    registerChannelDescriptor(elsewhere, "acme.evil", undefined, "1.0.0");
    try {
      // Reviewed, so its mailbox holds with the kit it registered; never Public; no shared client yet.
      expect(channelGrantsOf("acme-mail")).toEqual({ mailbox: true, calendar: false, verified: "reviewed" });
      expect(mailboxKitOf("acme-mail")).toBe(kit);
      await expect(run({ action: "share-client", provider: "google", pluginId: "acme.other" }, { meta })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await run<ChannelsShareClientAnswer>({ action: "share-client", provider: "google", pluginId: "acme.mail" }, { meta })).toEqual(
        { sharedClient: { provider: "google", pluginId: "acme.mail", signedOut: 0 } },
      );
      expect(sharedProviderOf("acme-mail")).toBe("google");
      expect(channelPresentationOf(mail)).toMatchObject({ provider: "google", mailbox: true });
      expect(await oauthClientOf(directory, mail, mail.auth.oauth)).toMatchObject({ clientId: "shared.apps.googleusercontent.com" });
      // Kept for the next start, and taken back.
      expect(parseSharedClients(await meta.get(CHANNELS_SHARED_CLIENTS_SETTING)).get("google")).toEqual({
        pluginId: "acme.mail",
        version: "1.0.0",
      });
      // One whose token address is not Google's is never bound: the shared secret would go there.
      await expect(run({ action: "share-client", provider: "google", pluginId: "acme.evil" }, { meta })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(sharedProviderOf("evil-mail")).toBeUndefined();
      // Bound to the version approved then: another version under the same id is not.
      unregisterChannelDescriptor("acme-mail");
      registerChannelDescriptor(mail, "acme.mail", kit, "1.1.0");
      expect(sharedProviderOf("acme-mail")).toBeUndefined();
      unregisterChannelDescriptor("acme-mail");
      registerChannelDescriptor(mail, "acme.mail", kit, "1.0.0");
      await run({ action: "share-client", provider: "google", pluginId: null }, { meta });
      expect(sharedProviderOf("acme-mail")).toBeUndefined();
    } finally {
      unregisterChannelDescriptor("acme-mail");
      unregisterChannelDescriptor("evil-mail");
      setSharedClientBindings(new Map());
    }
    expect(mailboxKitOf("acme-mail")).toBeUndefined();
  });

  it("leaves the provider's grant with another app signed in with it, and names that app", async () => {
    const { run, runtime } = await owner();
    const saved = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "gmail",
      enabled: false,
      settings: {},
    });
    await runtime.store.asPort().repositories.messagingConnections.markConnected({
      connectionId: saved.connectionId,
      workspaceId: "default",
      accountIdentity: "me@gmail.com",
      tokenRef: channelSecretRef(saved.connectionId, "oauth"),
      now: runtime.clock.now(),
    });
    const asked: string[] = [];
    const kept = (apps: readonly string[]) => async (workspaceId: string) => {
      asked.push(workspaceId);
      return new Map(apps.length === 0 ? [] : [[saved.connectionId, apps]]);
    };
    const revoked: unknown[] = [];
    const revokeToken = async (connection: { readonly connectionId: string }, options?: { readonly upstream?: boolean }) =>
      void revoked.push({ connectionId: connection.connectionId, options });
    // The list says who keeps it, so the confirm can say so before anything is signed out.
    const listed = (
      await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" }, { sharedGrants: kept(["Google Calendar"]) })
    ).connections.find((connection) => connection.connectionId === saved.connectionId);
    expect(listed?.keptBy).toEqual(["Google Calendar"]);
    // A projection that fails leaves the list as it was.
    expect(
      (
        await run<ChannelsListAnswer>(
          { action: "list", workspaceId: "default" },
          {
            sharedGrants: async () => {
              throw new Error("down");
            },
          },
        )
      ).connections.find((connection) => connection.connectionId === saved.connectionId)?.keptBy,
    ).toBeUndefined();
    // Calendar keeps the grant: deleted here only, and said.
    expect(
      await run(
        { action: "oauth-disconnect", workspaceId: "default", connectionId: saved.connectionId },
        { sharedGrants: kept(["Google Calendar"]), revokeToken },
      ),
    ).toEqual({ ok: true, keptBy: ["Google Calendar"] });
    expect(revoked).toEqual([{ connectionId: saved.connectionId, options: { upstream: false } }]);
    expect(asked).toEqual(["default", "default"]);
    // The last app of the grant revokes it upstream.
    await runtime.store.asPort().repositories.messagingConnections.markConnected({
      connectionId: saved.connectionId,
      workspaceId: "default",
      accountIdentity: "me@gmail.com",
      tokenRef: channelSecretRef(saved.connectionId, "oauth"),
      now: runtime.clock.now(),
    });
    expect(
      await run(
        { action: "oauth-disconnect", workspaceId: "default", connectionId: saved.connectionId },
        { sharedGrants: kept([]), revokeToken },
      ),
    ).toEqual({ ok: true, keptBy: [] });
    expect(revoked.at(-1)).toEqual({ connectionId: saved.connectionId, options: {} });
    // Connected apps weighed it already: an explicit `upstream: false` is not weighed again.
    await runtime.store.asPort().repositories.messagingConnections.markConnected({
      connectionId: saved.connectionId,
      workspaceId: "default",
      accountIdentity: "me@gmail.com",
      tokenRef: channelSecretRef(saved.connectionId, "oauth"),
      now: runtime.clock.now(),
    });
    asked.length = 0;
    await run(
      { action: "oauth-disconnect", workspaceId: "default", connectionId: saved.connectionId, upstream: false },
      { sharedGrants: kept(["Google Calendar"]), revokeToken },
    );
    expect(asked).toEqual([]);
    expect(revoked.at(-1)).toEqual({ connectionId: saved.connectionId, options: { upstream: false } });
  });

  it("forgets a removed connection's mailbox opt-in and sharing, so one saved again starts off", async () => {
    const { run, runtime } = await owner();
    const saved = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "gmail",
      enabled: false,
      settings: {},
    });
    const meta = {
      get: (key: string) => runtime.store.getMeta(key),
      set: async (key: string, value: string) => await runtime.store.setMeta(key, value, runtime.clock.now()),
    };
    await meta.set("apps.mailbox", JSON.stringify({ [saved.connectionId]: "send", other: "read" }));
    await meta.set("apps.sharing", JSON.stringify({ [saved.connectionId]: "shared" }));
    await run({ action: "delete", workspaceId: "default", connectionId: saved.connectionId }, { meta });
    expect(JSON.parse((await meta.get("apps.mailbox")) ?? "{}")).toEqual({ other: "read" });
    expect(JSON.parse((await meta.get("apps.sharing")) ?? "{}")).toEqual({});
  });

  it("keeps an expired connection's account through a save, so signing in again must be that account", async () => {
    const { run, runtime } = await owner();
    const saved = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "gmail",
      enabled: false,
      settings: {},
    });
    const repositories = runtime.store.asPort().repositories;
    await repositories.messagingConnections.markConnected({
      connectionId: saved.connectionId,
      workspaceId: "default",
      accountIdentity: "alice@gmail.com",
      tokenRef: channelSecretRef(saved.connectionId, "oauth"),
      now: runtime.clock.now(),
    });
    // A client change: expired, its token dropped.
    await repositories.messagingConnections.setAuthState({
      connectionId: saved.connectionId,
      authState: "expired",
      dropToken: true,
      now: runtime.clock.now(),
    });
    await run({
      action: "save",
      workspaceId: "default",
      connectionId: saved.connectionId,
      providerId: "gmail",
      enabled: false,
      settings: {},
    });
    expect((await repositories.messagingConnections.get(saved.connectionId))?.accountIdentity).toBe("alice@gmail.com");
  });

  it("keeps the provider's grant for another app when a connection is removed, or its client changes", async () => {
    const { run, runtime, directory } = await owner();
    await encryptCredentialDirectory(directory);
    const saved = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "gmail",
      enabled: false,
      settings: {},
    });
    const signIn = async () =>
      await runtime.store.asPort().repositories.messagingConnections.markConnected({
        connectionId: saved.connectionId,
        workspaceId: "default",
        accountIdentity: "me@gmail.com",
        tokenRef: channelSecretRef(saved.connectionId, "oauth"),
        now: runtime.clock.now(),
      });
    const kept = async () => new Map([[saved.connectionId, ["Google Calendar"]]]);
    const revoked: unknown[] = [];
    const revokeToken = async (connection: { readonly connectionId: string }, options?: { readonly upstream?: boolean }) =>
      void revoked.push({ connectionId: connection.connectionId, options });
    // A client change signs its older sign-ins out: here only, while Calendar keeps the grant.
    await signIn();
    await run(
      { action: "oauth-client", providerId: "gmail", clientId: "first.apps.googleusercontent.com" },
      { sharedGrants: kept, revokeToken },
    );
    await signIn();
    await run(
      { action: "oauth-client", providerId: "gmail", clientId: "second.apps.googleusercontent.com" },
      { sharedGrants: kept, revokeToken },
    );
    expect(revoked.at(-1)).toEqual({ connectionId: saved.connectionId, options: { upstream: false } });
    // Removed: the same.
    await signIn();
    await run({ action: "delete", workspaceId: "default", connectionId: saved.connectionId }, { sharedGrants: kept, revokeToken });
    expect(revoked.at(-1)).toEqual({ connectionId: saved.connectionId, options: { upstream: false } });
  });

  it("signs a saved connection in: to the page's own loopback address, the account named and the token kept", async () => {
    const provider = fakeFetch(async (url) => {
      if (url === "https://auth.example.com/token")
        return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 60 }), { status: 200 });
      if (url === "https://auth.example.com/me") return new Response(JSON.stringify({ email: "bo@example.com" }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    const { run, directory } = await owner(undefined, provider);
    const oauth = (providerId: string, redirect: "loopback-any-port" | "public") =>
      registerChannelDescriptor({
        providerId,
        label: providerId,
        kind: "email",
        description: "d",
        settings: [],
        auth: {
          kind: "oauth2",
          oauth: {
            authorizeUrl: "https://auth.example.com/authorize",
            tokenUrl: "https://auth.example.com/token",
            scopes: ["mail"],
            pkce: true,
            client: { source: "plugin", clientId: "shipped" },
            redirect,
            tokenAuthMethod: "none",
            accountIdentity: { userinfoUrl: "https://auth.example.com/me", field: "email" },
          },
        },
        sender: { label: "A", placeholder: "", pattern: ".+", normalize: "none", authentication: "provider" },
        target: { label: "A", placeholder: "", pattern: ".+", normalize: "none" },
      });
    oauth("flow-any", "loopback-any-port");
    oauth("flow-public", "public");
    const saved = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "flow-any",
      enabled: false,
      settings: {},
    });
    // A sign-in keeps a refresh token: refused until the credential store is encrypted.
    expect((await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).credentialsEncrypted).toBe(false);
    await expect(
      run({ action: "oauth-start", workspaceId: "default", connectionId: saved.connectionId, origin: "http://127.0.0.1:4100" }),
    ).rejects.toThrow(/turn on credential encryption/);
    await encryptCredentialDirectory(directory);
    expect((await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).credentialsEncrypted).toBe(true);
    const started = await run<{ flowId: string; authorizeUrl: string }>({
      action: "oauth-start",
      workspaceId: "default",
      connectionId: saved.connectionId,
      origin: "http://127.0.0.1:4100",
    });
    const url = new URL(started.authorizeUrl);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4100/oauth/callback");
    expect(await run({ action: "oauth-callback", state: url.searchParams.get("state") ?? "", code: "c" })).toEqual({
      ok: true,
      message: "Connected as bo@example.com.",
    });
    expect(await run({ action: "oauth-status", workspaceId: "default", flowId: started.flowId })).toEqual({
      state: "connected",
      accountIdentity: "bo@example.com",
    });
    const listed = (await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).connections.find(
      (connection) => connection.connectionId === saved.connectionId,
    );
    expect(listed).toMatchObject({ authState: "connected", accountIdentity: "bo@example.com" });
    expect((await listCredentialRefs(directory)).valid).toContain(channelSecretRef(saved.connectionId, "oauth"));
    // A later save keeps the sign-in: its token, its account, its state.
    await run({
      action: "save",
      workspaceId: "default",
      connectionId: saved.connectionId,
      providerId: "flow-any",
      label: "Mail",
      enabled: false,
      settings: {},
    });
    expect(
      (await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).connections.find(
        (connection) => connection.connectionId === saved.connectionId,
      ),
    ).toMatchObject({ label: "Mail", authState: "connected", accountIdentity: "bo@example.com" });
    // Signed out: the token goes and the connection closes until it is connected again; kept upstream when asked.
    const revoked: unknown[] = [];
    await run(
      { action: "oauth-disconnect", workspaceId: "default", connectionId: saved.connectionId, upstream: false },
      { revokeToken: async (connection, options) => void revoked.push({ connectionId: connection.connectionId, options }) },
    );
    expect(revoked).toEqual([{ connectionId: saved.connectionId, options: { upstream: false } }]);
    await run({ action: "oauth-disconnect", workspaceId: "default", connectionId: saved.connectionId });
    expect(
      (await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).connections.find(
        (connection) => connection.connectionId === saved.connectionId,
      ),
    ).toMatchObject({ authState: "revoked" });
    expect((await listCredentialRefs(directory)).valid).not.toContain(channelSecretRef(saved.connectionId, "oauth"));
    // And a removal takes the token with it.
    await run({ action: "delete", workspaceId: "default", connectionId: saved.connectionId });
    expect((await listCredentialRefs(directory)).valid).not.toContain(channelSecretRef(saved.connectionId, "oauth"));

    // One through the public address needs that address.
    const viaPublic = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "flow-public",
      enabled: false,
      settings: {},
    });
    await expect(run({ action: "oauth-start", workspaceId: "default", connectionId: viaPublic.connectionId })).rejects.toThrow(
      /public address/,
    );
    await run({ action: "ingress", port: 8041, publicUrl: "https://hooks.example.com/tavi" });
    expect(
      new URL(
        (await run<{ authorizeUrl: string }>({ action: "oauth-start", workspaceId: "default", connectionId: viaPublic.connectionId }))
          .authorizeUrl,
      ).searchParams.get("redirect_uri"),
    ).toBe("https://hooks.example.com/tavi/oauth/callback");
    // From Connected apps: any channel may come back to the public address, and be finished by paste or cancelled.
    const other = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "flow-any",
      enabled: false,
      settings: {},
    });
    const anyway = await run<{ flowId: string; authorizeUrl: string }>({
      action: "oauth-start",
      workspaceId: "default",
      connectionId: other.connectionId,
      public: true,
    });
    expect(new URL(anyway.authorizeUrl).searchParams.get("redirect_uri")).toBe("https://hooks.example.com/tavi/oauth/callback");
    expect(
      await run({
        action: "oauth-finish",
        workspaceId: "default",
        flowId: anyway.flowId,
        address: "https://hooks.example.com/tavi/oauth/callback?state=not-it&code=c",
      }),
    ).toEqual({ ok: false, message: "That address belongs to another sign-in." });
    expect(await run({ action: "oauth-cancel", workspaceId: "default", flowId: anyway.flowId })).toEqual({ ok: true });
    expect(await run({ action: "oauth-status", workspaceId: "default", flowId: anyway.flowId })).toMatchObject({
      state: "failed",
      detail: "The sign-in was cancelled.",
    });
    // A secret channel has no sign-in.
    const chat = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "telegram",
      enabled: false,
      settings: {},
    });
    await expect(
      run({ action: "oauth-start", workspaceId: "default", connectionId: chat.connectionId, origin: "http://127.0.0.1:4100" }),
    ).rejects.toThrow(/does not connect with OAuth/);
  });

  it("saves the ingress's port and public address, the owner's, and applies them", async () => {
    const { run } = await owner();
    let applied = 0;
    const applyIngress = async (): Promise<void> => {
      applied += 1;
    };
    expect(await run({ action: "ingress", port: 8040, publicUrl: "https://hooks.example.com/tavi" }, { applyIngress })).toEqual({
      applied: true,
    });
    expect(applied).toBe(1);
    expect((await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).ingress).toEqual({
      host: "127.0.0.1",
      port: 8040,
      publicUrl: "https://hooks.example.com/tavi",
    });
    expect(
      await run(
        { action: "ingress", port: 8042 },
        {
          applyIngress: async () => {
            throw new Error("port in use");
          },
        },
      ),
    ).toEqual({ applied: false, notApplied: "port in use" });
  });

  it("saves the ingress's trusted proxies as the owner's, keeps them when left out, and refuses what is no address", async () => {
    const { run } = await owner();
    const saved = new Map<string, string>();
    const meta = { get: async (key: string) => saved.get(key), set: async (key: string, value: string) => void saved.set(key, value) };
    await run({ action: "ingress", port: 8040, trustedProxies: ["192.0.2.10", "10.0.0.0/8", "192.0.2.10"] }, { meta });
    expect(parseTrustedProxies(saved.get(CHANNELS_INGRESS_TRUSTED_PROXIES_SETTING))).toEqual(["192.0.2.10", "10.0.0.0/8"]);
    await run({ action: "ingress", port: 8041 }, { meta });
    expect((await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" }, { meta })).trustedProxies).toEqual([
      "192.0.2.10",
      "10.0.0.0/8",
    ]);
    await expect(run({ action: "ingress", port: 8041, trustedProxies: ["10.0.0.0/33"] }, { meta })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await run({ action: "ingress", port: 8041, trustedProxies: [] }, { meta });
    expect(await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" }, { meta })).not.toHaveProperty("trustedProxies");
  });

  it("refuses another workspace's connection, and an id that was another channel's, before storing any secret", async () => {
    const { run, directory } = await owner();
    const chat = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "telegram",
      enabled: true,
      settings: {},
      secrets: { token: "t" },
    });
    await expect(
      run({ action: "save", workspaceId: "other", connectionId: chat.connectionId, providerId: "telegram", enabled: false, settings: {} }),
    ).rejects.toThrow(/No such connection/);
    await expect(run({ action: "delete", workspaceId: "other", connectionId: chat.connectionId })).rejects.toThrow(/No such connection/);
    await run({ action: "delete", workspaceId: "default", connectionId: chat.connectionId });
    // Removed, its id is still its own: not another channel's, nor another workspace's.
    await expect(
      run({
        action: "save",
        workspaceId: "default",
        connectionId: chat.connectionId,
        providerId: "mailgun",
        enabled: true,
        settings: { domain: "mg.example.com" },
        secrets: { apiKey: "k", webhookSigningKey: "s" },
      }),
    ).rejects.toThrow(/is a Telegram connection/);
    await expect(
      run({ action: "save", workspaceId: "other", connectionId: chat.connectionId, providerId: "telegram", enabled: false, settings: {} }),
    ).rejects.toThrow(/No such connection/);
    expect((await listCredentialRefs(directory)).valid).not.toContain(channelSecretRef(chat.connectionId, "apiKey"));
  });

  it("reports a reload that fails with the change it applied, which stays stored, and a removed connection's secrets still go", async () => {
    const { run, directory } = await owner();
    const reload = async (): Promise<never> => {
      throw new Error("port in use");
    };
    const saved = await run<ChannelsSaveAnswer>(
      { action: "save", workspaceId: "default", providerId: "telegram", enabled: true, settings: {}, secrets: { token: "t" } },
      { reload },
    );
    expect(saved.notApplied).toBe("port in use");
    await run({ action: "delete", workspaceId: "default", connectionId: saved.connectionId }, { reload });
    expect((await listCredentialRefs(directory)).valid).not.toContain(channelSecretRef(saved.connectionId, "token"));
  });

  it("refuses a contact's allow on a channel that is no chat, whose threads are no one-to-one chat; a deny is kept", async () => {
    const { run } = await owner();
    const mail = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "mailgun",
      enabled: false,
      settings: { domain: "mg.example.com" },
    });
    const grant = (mode: "allow" | "deny") =>
      run<ChannelsGrantsAnswer>({
        action: "grants",
        workspaceId: "default",
        connectionId: mail.connectionId,
        op: "add",
        scopeKind: "contact",
        scopeId: "bob@example.com",
        toolId: "fs.write",
        mode,
      });
    await expect(grant("allow")).rejects.toThrow(/Email is not a chat channel: a contact can be allowed a tool only in a one-to-one chat/);
    expect((await grant("deny")).grants).toMatchObject([{ scopeKind: "contact", toolId: "fs.write", mode: "deny" }]);
  });
});
