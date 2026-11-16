import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nowTimestamp } from "@tavi/contracts/util";
import { afterAll, describe, expect, it, vi } from "vitest";

import { DatabaseClient } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";

import { channelSecretRef } from "../../src/features/channels/settings.js";
import { runChannelsCli } from "../../src/features/channels/client.js";
import { parseChannels } from "../../src/features/channels/parse.js";
import { keptByNote } from "../../src/features/apps/shared-grants.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";
import { parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";

/**
 * `tavi channels` and the generalized `tavi bindings`, on a data directory with no owner running: a channel is
 * configured from its descriptor alone.
 */

const directories = temporaryDirectories({ prefix: "tavi-channels-cli-" });
afterAll(() => directories.cleanup());

async function tavi(args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    isTty: false,
  };
  const code = await main([...args], { io });
  return { code, stdout, stderr };
}

describe("tavi channels", () => {
  it("parses settings as flags of their own, and refuses what an action does not take", () => {
    expect(
      parseArgs(["channels", "add", "mailgun", "--domain", "mg.example.com", "--secret-file", "apiKey=/k", "--disabled"]),
    ).toMatchObject({
      command: "channels",
      channels: {
        action: "add",
        target: "mailgun",
        settings: { domain: "mg.example.com" },
        secretFiles: { apiKey: "/k" },
        disabled: true,
        workspaceId: "default",
        format: "text",
      },
    });
    expect(() => parseArgs(["channels", "list", "--domain", "x"])).toThrow(/does not accept --domain/);
    expect(() => parseArgs(["channels", "test", "c1"])).toThrow(/needs --to/);
    expect(() => parseArgs(["channels", "secret", "c1", "apiKey"])).toThrow(/needs --file/);
    expect(() => parseArgs(["channels", "nope"])).toThrow(/Unknown channels action/);
    expect(parseArgs(["channels", "link", "telegram-default", "--principal", "ana", "--name", "Ana", "--yes"])).toMatchObject({
      command: "channels",
      channels: {
        action: "link",
        target: "telegram-default",
        principalId: "ana",
        name: "Ana",
        yes: true,
      },
    });
    expect(parseArgs(["channels", "pair", "--trust-unverified"])).toMatchObject({
      command: "channels",
      channels: {
        action: "pair",
        trustUnverified: true,
      },
    });
    expect(parseArgs(["channels", "unlink", "telegram-default", "123456"])).toMatchObject({
      command: "channels",
      channels: {
        action: "unlink",
        target: "telegram-default",
        field: "123456",
        sender: "123456",
      },
    });
    expect(parseArgs(["channels", "revoke", "telegram-default", "--sender", "123456"])).toMatchObject({
      command: "channels",
      channels: {
        action: "revoke",
        target: "telegram-default",
        sender: "123456",
      },
    });
    expect(parseArgs(["channels", "people", "telegram-default"])).toMatchObject({
      command: "channels",
      channels: {
        action: "people",
        target: "telegram-default",
      },
    });
    expect(() => parseArgs(["channels", "unlink", "telegram-default"])).toThrow(/needs a sender/);
    expect(() => parseArgs(["channels", "unlink", "telegram-default", "123", "--sender", "456"])).toThrow(/takes <connection> <sender>/);
    expect(() => parseArgs(["channels", "link", "c1", "c2"])).toThrow(/at most one connection/);
    expect(() => parseArgs(["channels", "link", "--name", "   "])).toThrow(/--name must be 1-80 non-blank characters/);
    expect(() => parseArgs(["channels", "link", "--principal", "   "])).toThrow(/--principal must not be empty/);
  });

  it("signs a Gmail connection out with no owner, weighing the other Google apps first, and names one that keeps the sign-in", async () => {
    const directory = directories.create();
    const dir = ["--data-dir", directory];
    const added = await tavi(["channels", "add", "gmail", "--disabled", ...dir]);
    expect(added.code, added.stderr).toBe(EXIT.ok);
    const connectionId = added.stdout.trim();
    // A sign-in keeps its token in the credential directory.
    mkdirSync(join(directory, "credentials"), { mode: 0o700 });
    const store = await DatabaseClient.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      await store.asPort().repositories.messagingConnections.markConnected({
        connectionId,
        workspaceId: "default",
        accountIdentity: "me@gmail.com",
        tokenRef: channelSecretRef(connectionId, "oauth"),
        now: nowTimestamp(),
      });
    } finally {
      await store.close();
    }
    // No other Google app is signed in: the apps are projected from the data directory, and nothing keeps it.
    const out = await tavi(["channels", "disconnect", connectionId, "--format", "json", ...dir]);
    expect(out.code, out.stderr).toBe(EXIT.ok);
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, keptBy: [] });
    // Said as `tavi apps disconnect` says it when another app keeps the grant.
    expect(keptByNote([])).toBe("");
    expect(keptByNote(["Google Calendar"])).toBe(
      ": its sign-in forgotten here; Google Calendar stays connected, so the provider still lists Tavi until you disconnect it too",
    );
  });

  it("with no owner, leaves Google's grant to another connection of the same account and project, and names it", async () => {
    const directory = directories.create();
    const dir = ["--data-dir", directory];
    mkdirSync(join(directory, "credentials"), { mode: 0o700 });
    const credentials = createLocalCredentialStore(directory);
    // One Google client for every connection: the same Cloud project.
    await credentials.setSecret("oauth-clients.google.id", "111-shared.apps.googleusercontent.com");
    const signedInAt = nowTimestamp();
    /** A Gmail connection signed in as the same account, with a token a revoke would send to Google. */
    const signedIn = async (token: string): Promise<string> => {
      const added = await tavi(["channels", "add", "gmail", "--disabled", ...dir]);
      expect(added.code, added.stderr).toBe(EXIT.ok);
      const connectionId = added.stdout.trim();
      await credentials.setSecret(
        channelSecretRef(connectionId, "oauth"),
        JSON.stringify({ accessToken: `${token}-a`, refreshToken: `${token}-r`, scopes: [], tokenType: "Bearer" }),
      );
      const store = await DatabaseClient.open({
        databasePath: join(directory, "tavi.sqlite"),
        artifactsDirectory: join(directory, "artifacts"),
      });
      try {
        await store.asPort().repositories.messagingConnections.markConnected({
          connectionId,
          workspaceId: "default",
          accountIdentity: "Me@Gmail.com",
          tokenRef: channelSecretRef(connectionId, "oauth"),
          now: signedInAt,
        });
      } finally {
        await store.close();
      }
      return connectionId;
    };
    const first = await signedIn("first");
    const second = await signedIn("second");
    // The list names the other connection before anything is signed out.
    const listed = await tavi(["channels", "list", "--format", "json", ...dir]);
    expect(listed.code, listed.stderr).toBe(EXIT.ok);
    expect(
      (JSON.parse(listed.stdout) as { connections: { connectionId: string; keptBy?: string[] }[] }).connections.find(
        (connection) => connection.connectionId === first,
      )?.keptBy,
    ).toEqual([`Google (${second})`]);
    const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const out = await tavi(["channels", "disconnect", first, ...dir]);
      expect(out.code, out.stderr).toBe(EXIT.ok);
      expect(out.stdout).toBe(
        `signed ${first} out of Gmail: its sign-in forgotten here; Google (${second}) stays connected, so the provider still lists Tavi until you disconnect it too\n`,
      );
      // Nothing went to Google: its revoke would have ended the other connection's sign-in too.
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
    expect(await credentials.getSecret(channelSecretRef(first, "oauth"))).toBeNull();
    expect(await credentials.getSecret(channelSecretRef(second, "oauth"))).toContain("second-r");
  });

  it("lists the installed channels, adds, changes, disables and removes a connection on the data directory", async () => {
    const directory = directories.create();
    const dir = ["--data-dir", directory];
    const types = await tavi(["channels", "types", ...dir]);
    expect(types.code, types.stderr).toBe(EXIT.ok);
    expect(types.stdout).toContain("--domain");
    expect(types.stdout).toContain("--secret-file apiKey=<path>");
    // A setting whose name is also one of `channels`' own flags is given with --set, as types says and add's refusal names.
    expect(types.stdout).toContain("  --set label=<value>\tLabel to read");
    expect(types.stdout).not.toMatch(/^ {2}--label\t/m);
    const asFlag = await tavi(["channels", "add", "gmail", "--label", "tavi", ...dir]);
    expect(asFlag.code).toBe(EXIT.usage);
    expect(asFlag.stderr).toContain("channels add does not accept --label: give the setting as --set label=<value>");
    // A port out of range says the range, not a schema's words.
    const port = await tavi(["channels", "ingress", "--port", "80", ...dir]);
    expect(port.code).toBe(EXIT.usage);
    expect(port.stderr).toContain("--port must be between 1024 and 65535");
    // A connection that is not there is named, with where to look, as every other action says it.
    const rooms = await tavi(["channels", "rooms", "discord-110494dd", ...dir]);
    expect(rooms.stderr).toContain("No connection discord-110494dd in workspace default (`tavi channels list`)");

    const key = join(directory, "key.txt");
    writeFileSync(key, "secret-key\n");
    const added = await tavi([
      "channels",
      "add",
      "mailgun",
      "--domain",
      "mg.example.com",
      "--secret-file",
      `apiKey=${key}`,
      "--disabled",
      "--name",
      "Support",
      ...dir,
    ]);
    expect(added.code, added.stderr).toBe(EXIT.ok);
    const connectionId = added.stdout.trim();
    expect(connectionId).toMatch(/^mailgun-[0-9a-f]{8}$/);

    const changed = await tavi(["channels", "set", connectionId, "--from", "help@mg.example.com", ...dir]);
    expect(changed.code, changed.stderr).toBe(EXIT.ok);
    const listed = await tavi(["channels", "list", "--format", "json", ...dir]);
    const connection = (
      JSON.parse(listed.stdout) as {
        connections: { connectionId: string; label: string; settings: object; enabled: boolean; secretsStored: object }[];
      }
    ).connections[0];
    expect(connection).toMatchObject({
      connectionId,
      label: "Support",
      settings: { domain: "mg.example.com", from: "help@mg.example.com" },
      enabled: false,
      secretsStored: { apiKey: true, webhookSigningKey: false },
    });
    expect(listed.stdout).not.toContain("secret-key");
    // An EU-region domain is reached at Mailgun's EU API: the region is one of the two Mailgun has, us unless set.
    expect(types.stdout).toContain("  --region\tRegion: us, eu (default us)");
    expect(connection?.settings).toMatchObject({ region: "us" });
    expect((await tavi(["channels", "set", connectionId, "--set", "region=eu", ...dir])).code).toBe(EXIT.ok);
    const freeUrl = await tavi(["channels", "set", connectionId, "--region", "https://api.example.com/v3", ...dir]);
    expect(freeUrl.code).toBe(EXIT.usage);
    expect(freeUrl.stderr).toContain("Region must be one of us, eu");
    const euAdded = await tavi(["channels", "add", "mailgun", "--domain", "eu.example.com", "--set", "region=eu", "--disabled", ...dir]);
    expect(euAdded.code, euAdded.stderr).toBe(EXIT.ok);
    const regions = (
      JSON.parse((await tavi(["channels", "list", "--format", "json", ...dir])).stdout) as {
        connections: { settings: { region?: string } }[];
      }
    ).connections.map((entry) => entry.settings.region);
    expect(regions).toEqual(["eu", "eu"]);
    expect((await tavi(["channels", "remove", euAdded.stdout.trim(), ...dir])).code).toBe(EXIT.ok);

    // Enabling needs every secret; the refusal names the missing one.
    const refused = await tavi(["channels", "enable", connectionId, ...dir]);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.stderr).toMatch(/Enter Webhook signing key/);
    const unknown = await tavi(["channels", "set", connectionId, "--colour", "red", ...dir]);
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.stderr).toMatch(/no setting colour/);

    // A test send needs a running owner.
    const tested = await tavi(["channels", "test", connectionId, "--to", "ana@example.com", ...dir]);
    expect(tested.code).toBe(EXIT.unavailable);
    expect(tested.stderr).toMatch(/needs a running owner/);

    // Its secret from a file, then enabled; disabled again; a setting cleared with an empty value.
    const signing = join(directory, "signing.txt");
    writeFileSync(signing, "signing-key\n");
    expect((await tavi(["channels", "secret", connectionId, "webhookSigningKey", "--file", signing, ...dir])).code).toBe(EXIT.ok);
    const enabled = await tavi(["channels", "enable", connectionId, ...dir]);
    expect(enabled.code, enabled.stderr).toBe(EXIT.ok);
    expect((await tavi(["channels", "disable", connectionId, "--set", "from=", ...dir])).code).toBe(EXIT.usage);
    expect((await tavi(["channels", "set", connectionId, "--set", "from=", ...dir])).code).toBe(EXIT.ok);
    const after = JSON.parse((await tavi(["channels", "list", "--format", "json", ...dir])).stdout) as {
      connections: { label: string; enabled: boolean; settings: object }[];
    };
    expect(after.connections[0]).toMatchObject({ label: "Support", enabled: true, settings: { domain: "mg.example.com" } });
    expect(after.connections[0]?.settings).not.toHaveProperty("from");
    expect((await tavi(["channels", "disable", connectionId, ...dir])).code).toBe(EXIT.ok);

    // What a running owner would refuse is refused here too.
    const badPort = await tavi(["channels", "ingress", "--port", "80", ...dir]);
    expect(badPort.code).toBe(EXIT.usage);
    expect((await tavi(["channels", "ingress", "--port", "8040", "--public-url", "https://hooks.example.com", ...dir])).code).toBe(EXIT.ok);
    expect((await tavi(["channels", "list", ...dir])).stdout).toContain("webhooks: port 8040, https://hooks.example.com");
    expect((await tavi(["channels", "ingress", "--port", "8040", "--trusted-proxies", "proxy.example.com", ...dir])).code).not.toBe(
      EXIT.ok,
    );
    expect((await tavi(["channels", "ingress", "--port", "8040", "--trusted-proxies", "192.0.2.10, 10.0.0.0/8", ...dir])).code).toBe(
      EXIT.ok,
    );
    expect((await tavi(["channels", "list", ...dir])).stdout).toContain("webhooks: port 8040, trusted proxies 192.0.2.10, 10.0.0.0/8");

    const removed = await tavi(["channels", "remove", connectionId, ...dir]);
    expect(removed.code, removed.stderr).toBe(EXIT.ok);
    expect((await tavi(["channels", "list", ...dir])).stdout).toMatch(/^no connections/);
  });

  it("changes a connection saved with a setting its channel does not declare, and keeps an unnamed one unnamed", async () => {
    const directory = directories.create();
    const dir = ["--data-dir", directory];
    const added = await tavi(["channels", "add", "mailgun", "--domain", "mg.example.com", "--disabled", ...dir]);
    const connectionId = added.stdout.trim();
    // A setting the channel does not declare (as a plugin's earlier version may have left one).
    const { DatabaseClient } = await import("@tavi/runtime");
    const db = await DatabaseClient.open({ databasePath: join(directory, "tavi.sqlite") });
    const row = await db.repositories.messagingConnections.get(connectionId);
    if (row === undefined) throw new Error("the connection was not saved");
    await db.repositories.messagingConnections.save({ ...row, settings: { ...row.settings, webhookPort: 8099 } }, nowTimestamp());
    await db.close();
    const changed = await tavi(["channels", "set", connectionId, "--from", "help@mg.example.com", ...dir]);
    expect(changed.code, changed.stderr).toBe(EXIT.ok);
    const listed = JSON.parse((await tavi(["channels", "list", "--format", "json", ...dir])).stdout) as {
      connections: { label: string }[];
    };
    expect(listed.connections[0]?.label).toBe("Email");
  });

  it("binds a sender in its connection's channel form, and refuses one that is not a sender there", async () => {
    const directory = directories.create();
    const dir = ["--data-dir", directory];
    const added = await tavi(["channels", "add", "mailgun", "--domain", "mg.example.com", "--disabled", ...dir]);
    const connectionId = added.stdout.trim();
    const bound = await tavi([
      "bindings",
      "bind",
      "--connection",
      connectionId,
      "--sender",
      "Ana@Example.com",
      "--principal",
      "ana",
      "--format",
      "json",
      ...dir,
    ]);
    expect(bound.code, bound.stderr).toBe(EXIT.ok);
    expect(JSON.parse(bound.stdout)).toMatchObject({ externalSenderId: "ana@example.com" });
    const refused = await tavi([
      "bindings",
      "bind",
      "--connection",
      connectionId,
      "--sender",
      "not an address",
      "--principal",
      "ana",
      ...dir,
    ]);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.stderr).toMatch(/is not a/);

    const listedPeople = await tavi(["channels", "people", "mailgun", ...dir]);
    expect(listedPeople.code, listedPeople.stderr).toBe(EXIT.ok);
    expect(listedPeople.stdout).toContain(`${connectionId}\tana@example.com\tana`);

    const unlinked = await tavi(["channels", "unlink", "mailgun", "Ana@Example.com", ...dir]);
    expect(unlinked.code, unlinked.stderr).toBe(EXIT.ok);
    expect(unlinked.stdout).toBe(`revoked ana@example.com on ${connectionId}\n`);

    const rebound = await tavi([
      "bindings",
      "bind",
      "--connection",
      connectionId,
      "--sender",
      "ana@example.com",
      "--principal",
      "ana",
      ...dir,
    ]);
    expect(rebound.code, rebound.stderr).toBe(EXIT.ok);
    const unlinkedSingle = await tavi(["channels", "unlink", "--sender", "Ana@Example.com", ...dir]);
    expect(unlinkedSingle.code, unlinkedSingle.stderr).toBe(EXIT.ok);
    expect(unlinkedSingle.stdout).toBe(`revoked ana@example.com on ${connectionId}\n`);

    const afterUnlink = await tavi(["channels", "people", connectionId, ...dir]);
    expect(afterUnlink.code, afterUnlink.stderr).toBe(EXIT.ok);
    expect(afterUnlink.stdout).toBe("no allowed people; link one with `tavi channels link [connection]`\n");

    const offlineLink = await tavi(["channels", "link", connectionId, ...dir]);
    expect(offlineLink.code).toBe(EXIT.unavailable);
    expect(offlineLink.stderr).toMatch(/pairing needs a running owner/);
  });

  it("links a Telegram user via channels link, printing the code, /link command, and deep link, and confirms or cancels", async () => {
    const parsed = parseChannels(["link", "telegram"]);
    if (parsed.command !== "channels" || parsed.channels === undefined) throw new Error("expected channels command");

    let polls = 0;
    const requests: unknown[] = [];
    let out = "";
    let err = "";
    const prompts: string[] = [];

    await runChannelsCli(
      parsed.channels,
      async <T>(payload: unknown): Promise<T> => {
        requests.push(payload);
        const action = (payload as { readonly action: string }).action;
        if (action === "list") {
          return {
            connections: [
              {
                connectionId: "telegram-default",
                providerId: "telegram",
                label: "Telegram",
                workspaceId: "default",
                accountIdentity: "@tavi_test_bot",
                settings: {},
                secretsStored: { token: true },
                enabled: true,
                authState: "none",
                status: { state: "open" },
              },
            ],
            oauthClients: {},
            credentialsEncrypted: false,
            ingress: { host: "127.0.0.1", port: 8025 },
          } as T;
        }
        if (action === "people") {
          return { people: [], operator: "operator" } as T;
        }
        if (action === "pair") {
          return {
            pairingId: "11111111-1111-4111-8111-111111111111",
            code: "4KX9QM2P",
            expiresAt: "2026-10-20T10:10:00.000Z",
            account: "tavi_test_bot",
            linkUrl: "https://t.me/tavi_test_bot?start=4KX9-QM2P",
            openLabel: "Open in Telegram",
          } as T;
        }
        if (action === "pairing") {
          polls += 1;
          return (
            polls < 2
              ? { state: "waiting" }
              : {
                  state: "claimed",
                  sender: "99887766",
                  senderName: "Alice (@alice)",
                }
          ) as T;
        }
        return { ok: true } as T;
      },
      {
        stdout: (text) => {
          out += text;
        },
        stderr: (text) => {
          err += text;
        },
        sleep: async () => undefined,
        confirm: async (question) => {
          prompts.push(question);
          return true;
        },
      },
    );

    const until = new Date("2026-10-20T10:10:00.000Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(err).toContain(`Code: 4KX9-QM2P (valid until ${until}, once)`);
    expect(err).toContain("Command: /link 4KX9-QM2P");
    expect(err).toContain("Open in Telegram: https://t.me/tavi_test_bot?start=4KX9-QM2P");
    expect(prompts).toEqual(["A message from Alice (@alice) (99887766) carried the code. Allow them as operator? [y/N] "]);
    expect(out).toBe("linked Alice (@alice) (99887766) as operator on telegram-default\n");
    expect(requests).toContainEqual({
      action: "confirm-pair",
      workspaceId: "default",
      pairingId: "11111111-1111-4111-8111-111111111111",
    });

    // Declining calls cancel-pair and throws CANCELLED.
    await expect(
      runChannelsCli(
        parsed.channels,
        async <T>(payload: unknown): Promise<T> => {
          requests.push(payload);
          const action = (payload as { readonly action: string }).action;
          if (action === "list") {
            return {
              connections: [
                {
                  connectionId: "telegram-default",
                  providerId: "telegram",
                  label: "Telegram",
                  workspaceId: "default",
                  accountIdentity: "@tavi_test_bot",
                  settings: {},
                  secretsStored: { token: true },
                  enabled: true,
                  authState: "none",
                  status: { state: "open" },
                },
              ],
              oauthClients: {},
              credentialsEncrypted: false,
              ingress: { host: "127.0.0.1", port: 8025 },
            } as T;
          }
          if (action === "people") return { people: [], operator: "operator" } as T;
          if (action === "pair") {
            return {
              pairingId: "22222222-2222-4222-8222-222222222222",
              code: "AAAABBBB",
              expiresAt: "2026-10-20T10:10:00.000Z",
            } as T;
          }
          if (action === "pairing") {
            return { state: "claimed", sender: "55443322", senderName: "Mallory" } as T;
          }
          return { ok: true } as T;
        },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          sleep: async () => undefined,
          confirm: async () => false,
        },
      ),
    ).rejects.toThrow(/Not linked: Mallory \(55443322\) was not allowed/);
    expect(requests).toContainEqual({
      action: "cancel-pair",
      workspaceId: "default",
      pairingId: "22222222-2222-4222-8222-222222222222",
    });

    // Supports --yes and --format json with omitted connection (auto-resolving the single connection),
    // and cancels the pairing if confirm throws or throws UNAVAILABLE when expired.
    const autoParsed = parseChannels(["pair", "--yes", "--format", "json"]);
    if (autoParsed.command !== "channels" || autoParsed.channels === undefined) throw new Error("expected channels command");
    let jsonOut = "";
    const confirmSpy = vi.fn(async () => false);
    await runChannelsCli(
      autoParsed.channels,
      async <T>(payload: unknown): Promise<T> => {
        const action = (payload as { readonly action: string }).action;
        if (action === "list") {
          return {
            connections: [
              {
                connectionId: "telegram-default",
                providerId: "telegram",
                label: "Telegram",
                workspaceId: "default",
                accountIdentity: "@tavi_test_bot",
                settings: {},
                secretsStored: { token: true },
                enabled: true,
                authState: "none",
                status: { state: "open" },
              },
            ],
            oauthClients: {},
            credentialsEncrypted: false,
            ingress: { host: "127.0.0.1", port: 8025 },
          } as T;
        }
        if (action === "people") return { people: [], operator: "operator" } as T;
        if (action === "pair") {
          return {
            pairingId: "33333333-3333-4333-8333-333333333333",
            code: "778899AA",
            expiresAt: "2026-10-20T10:10:00.000Z",
          } as T;
        }
        if (action === "pairing") return { state: "claimed", sender: "11223344", senderName: "Bob" } as T;
        return { ok: true } as T;
      },
      {
        stdout: (text) => {
          jsonOut += text;
        },
        stderr: () => undefined,
        sleep: async () => undefined,
        confirm: confirmSpy,
      },
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(JSON.parse(jsonOut)).toEqual({
      ok: true,
      connectionId: "telegram-default",
      sender: "11223344",
      senderName: "Bob",
      principalId: "operator",
    });

    await expect(
      runChannelsCli(
        parsed.channels,
        async <T>(payload: unknown): Promise<T> => {
          const action = (payload as { readonly action: string }).action;
          if (action === "list") {
            return {
              connections: [
                {
                  connectionId: "telegram-default",
                  providerId: "telegram",
                  label: "Telegram",
                  workspaceId: "default",
                  accountIdentity: "@tavi_test_bot",
                  settings: {},
                  secretsStored: { token: true },
                  enabled: true,
                  authState: "none",
                  status: { state: "open" },
                },
              ],
              oauthClients: {},
              credentialsEncrypted: false,
              ingress: { host: "127.0.0.1", port: 8025 },
            } as T;
          }
          if (action === "people") return { people: [], operator: "operator" } as T;
          if (action === "pair") {
            return {
              pairingId: "44444444-4444-4444-8444-444444444444",
              code: "EXP12345",
              expiresAt: "2026-10-20T10:10:00.000Z",
            } as T;
          }
          if (action === "pairing") return { state: "expired" } as T;
          return { ok: true } as T;
        },
        {
          stdout: () => undefined,
          stderr: () => undefined,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow(/link ID expired/);
  });
});

describe("tavi channels offline, with a channel a plugin adds", () => {
  it("knows the channel from the plugin's approved manifest: lists it, adds a connection of it, and names it", async () => {
    const directory = directories.create();
    const fixture = join(import.meta.dirname, "..", "..", "..", "..", "tests", "fixtures", "channel-whatsapp-like");
    for (const argv of [
      ["plugins", "install", fixture],
      ["plugins", "approve", "fixture.walike", "1.0.0", "--in-process"],
      ["plugins", "enable", "fixture.walike"],
    ]) {
      expect((await tavi([...argv, "--data-dir", directory])).code).toBe(EXIT.ok);
    }
    const types = await tavi(["channels", "types", "--data-dir", directory]);
    expect(types.stdout).toContain("wa-like");
    const secret = join(directory, "token");
    writeFileSync(secret, "EAAG-token");
    const added = await tavi([
      "channels",
      "add",
      "wa-like",
      "--phoneNumberId",
      "1029384756",
      "--disabled",
      "--secret-file",
      `accessToken=${secret}`,
      "--data-dir",
      directory,
    ]);
    expect(added.code, added.stderr).toBe(EXIT.ok);
    const listed = await tavi(["channels", "list", "--data-dir", directory]);
    expect(listed.stdout).toContain("WhatsApp-like");
    expect(listed.stdout).not.toContain("provider missing");
  }, 60_000);
});
