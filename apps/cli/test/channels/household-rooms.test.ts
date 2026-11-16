import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gmailChannel } from "@tavi/plugin-gmail/channel";
import type {
  ChannelsGrantsAnswer,
  ChannelsPayload,
  ChannelsSaveAnswer,
  ConnectableApp,
  InvocationContext,
  MessagingConnectionRecord,
} from "@tavi/contracts";
import { temporaryDirectories, fakeFetch } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGroupLikePlatform } from "../../../../tests/fixtures/channel-group-like/index.mjs";
import { mailboxToolPrefix } from "../../src/features/apps/mailbox-catalog.js";
import { registerMailboxTools } from "../../src/features/apps/mailbox-tools.js";
import { APPS_SHARING_SETTING, parseSharing, sharingOf } from "../../src/features/apps/sharing.js";
import { channelsCommand } from "../../src/features/channels/owner.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { appsOwnerCommand } from "../../src/server/config-commands.js";
import { EXIT, main } from "../../src/main.js";
import { capture } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Household enforcement in rooms: a Personal account's tools, from every account-backed
 * source — a mailbox, an MCP server, an external plugin — are never offered
 * or callable in a room's turn (`memoryReach: "chat-only"`), whatever grant an
 * operator tries; the group tools stay offered there.
 */

const RAW = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp"), "raw-server.mjs");
const GROUP_LIKE = join(import.meta.dirname, "..", "..", "..", "..", "tests", "fixtures", "channel-group-like");
const NOW = "2026-10-18T09:00:00.000Z";
const directories = temporaryDirectories();
let runtime: TaviRuntime;
let connectionId = "";
let sharedInRoom = false;
const platform = createGroupLikePlatform();

async function tavi(argv: readonly string[]): Promise<{ readonly code: number; readonly stderr: string }> {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stderr: out.stderr() };
}

/** A plugin whose account is Personal by its manifest: a calendar's. */
function personalPlugin(): string {
  const directory = directories.create("tavi-household-plugin-");
  writeFileSync(
    join(directory, "index.mjs"),
    "export function register({ registerTool, z }) { registerTool({ name: 'events', inputSchema: z.object({}), handler: async () => 'lunch with Ana' }); }\n",
  );
  writeFileSync(
    join(directory, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.cal",
      version: "1.0.0",
      name: "Calendar fixture",
      entry: "index.mjs",
      tools: [{ name: "events", effect: "read-only", description: "Today's events" }],
      config: {},
      apps: { abi: "tavi.apps/1", apps: [{ id: "acme-cal", name: "Calendar", category: "calendar", dataClass: "personal" }] },
    }),
  );
  return directory;
}

const channels = async <T>(payload: ChannelsPayload): Promise<T> =>
  (
    await channelsCommand(
      {
        dataDirectory: runtime.dataDirectory,
        repositories: runtime.store.asPort().repositories,
        channels: runtime.channels,
        messaging: runtime.messaging,
        reload: (workspaceId) => runtime.reloadChannels(workspaceId),
        applyIngress: () => runtime.applyIngress(),
        pairings: runtime.pairings,
        oauth: runtime.oauthFlows,
        revokeToken: (connection) => runtime.oauthBroker.revoke(connection),
        now: () => runtime.clock.now(),
        roomInvitations: runtime.roomInvitations,
        operatorOf: () => "operator",
      },
      payload,
    )
  ).result as T;

beforeAll(async () => {
  const data = directories.create("tavi-household-rooms-");
  const at = ["--data-dir", data];
  // An MCP server, made Personal on its app's page.
  const server = directories.create("tavi-household-mcp-");
  writeFileSync(join(server, "raw.mjs"), readFileSync(RAW));
  for (const argv of [
    ["mcp", "add", "raw", "--dir", server, "--unsandboxed", ...at, "--", "node", "raw.mjs"],
    ["mcp", "approve", "mcp.raw", "1.0.0", "--unsandboxed", "--effect", "connect=external", ...at],
    ["plugins", "enable", "mcp.raw", ...at],
    ["mcp", "on", ...at],
  ]) {
    const done = await tavi(argv);
    expect(done.code, done.stderr).toBe(EXIT.ok);
  }
  // A plugin whose manifest says its account is Personal, and the group channel the rooms are on.
  for (const argv of [
    ["plugins", "install", personalPlugin()],
    // In-process: the household rule is the point, not the worker's confinement, which not every host has.
    ["plugins", "approve", "acme.cal", "1.0.0", "--in-process"],
    ["plugins", "enable", "acme.cal"],
    ["plugins", "install", GROUP_LIKE],
    ["plugins", "approve", "fixture.grouplike", "1.0.0", "--in-process"],
    ["plugins", "enable", "fixture.grouplike"],
  ]) {
    const done = await tavi([...argv, ...at]);
    expect(done.code, done.stderr).toBe(EXIT.ok);
  }
  runtime = await composeTaviRuntime(fixtureRuntimeOptions(data, { openSavedChannels: true }), {
    requireModelTransport: false,
    modelOverride: createFixtureModel({ turns: [{ text: "ok" }] }),
    channelFetch: { "group-like": platform.fetch },
  });
  // Shared, as it starts, the server is offered in a room's turn: being Personal is what will withhold it there.
  sharedInRoom = (
    await runtime.tools.listOffered({ workspaceId: "default", principalId: "operator", operator: true, memoryReach: "chat-only" })
  ).some((tool) => tool.id === "mcp.raw.echo");
  // Made Personal on its app's page, as an operator would.
  const listed = await appsOwnerCommand(runtime, { action: "list", workspaceId: "default" }, "operator");
  const app = (listed.ok ? (listed.result as { apps: ConnectableApp[] }).apps : []).find((candidate) =>
    candidate.accounts.some((account) => account.accountId === "mcp.raw"),
  );
  if (app === undefined) throw new Error("the MCP server is no app");
  const sharing = await appsOwnerCommand(
    runtime,
    { action: "sharing", appId: app.appId, accountId: "mcp.raw", sharing: "personal", workspaceId: "default" },
    "operator",
  );
  expect(sharing.ok).toBe(true);
  const saved = await channels<ChannelsSaveAnswer>({
    action: "save",
    workspaceId: "default",
    providerId: "group-like",
    enabled: true,
    settings: {},
    secrets: { token: platform.token },
  });
  connectionId = saved.connectionId;
  // A Gmail mailbox the operator opted into, its Personal and operator as `tavi serve` reads them (a mailbox is Personal by default).
  const gmail: MessagingConnectionRecord = {
    connectionId: "gmail-1",
    providerId: "gmail",
    workspaceId: "default",
    accountIdentity: "me@gmail.com",
    settings: {},
    credentialRefs: { oauth: "channels.gmail-1.oauth" },
    enabled: true,
    configRevision: 1,
    authState: "connected",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const mailbox = registerMailboxTools(runtime.tools, {
    channel: { providerId: "gmail", label: "Gmail", kit: gmailChannel.mailbox },
    connections: async () => [gmail],
    mailbox: async () => ({ "gmail-1": "read" }),
    personal: async (id) => sharingOf(parseSharing(await runtime.store.getMeta(APPS_SHARING_SETTING)), id, "personal") === "personal",
    operatorOf: (workspaceId) => runtime.access.resolveWorkspace(workspaceId)?.principalId,
    accessToken: async () => "token-1",
    fetch: fakeFetch(async () => new Response(JSON.stringify({ messages: [] }), { status: 200 })),
    apiBaseUrl: "https://gmail.test/v1/users/me",
  });
  await mailbox.refresh();
}, 120_000);

afterAll(async () => {
  await runtime?.close();
  directories.cleanup();
});

const personal = (id: string): boolean => id.startsWith("mcp.raw.") || id.startsWith("acme.cal.") || id.startsWith("gmail.");

describe("a Personal account's tools in a room (household rule)", () => {
  it("are offered in the operator's own chat, and in a room's turn none is, while the group tools are", async () => {
    const own = (await runtime.tools.listOffered({ workspaceId: "default", operator: true })).map((tool) => tool.id);
    // Each source's Personal tools, in the operator's own chat.
    for (const prefix of ["mcp.raw.", "acme.cal.", "gmail."])
      expect(
        own.some((id) => id.startsWith(prefix)),
        prefix,
      ).toBe(true);
    // The operator's own turn in a room: its memory reaches the chat alone.
    const inRoom = (
      await runtime.tools.listOffered({ workspaceId: "default", principalId: "operator", operator: true, memoryReach: "chat-only" })
    ).map((tool) => tool.id);
    expect(sharedInRoom).toBe(true);
    expect(inRoom.filter(personal)).toEqual([]);
    expect(inRoom).toEqual(expect.arrayContaining(["messaging.create_poll", "messaging.poll_results", "messaging.create_event"]));
  });

  it("are refused if called in a room's turn, the operator's own included", async () => {
    const room: InvocationContext = {
      workspaceId: "default",
      principalId: "operator",
      runId: "task-room",
      caller: "test",
      memoryReach: "chat-only",
    };
    const search = `${mailboxToolPrefix("gmail", "gmail-1")}search`;
    for (const [id, input] of [
      ["mcp.raw.echo", { text: "hi" }],
      ["acme.cal.events", {}],
      [search, { query: "invoice" }],
    ] as const) {
      const tool = runtime.tools.get(id);
      expect(tool, id).toBeDefined();
      await expect(
        Promise.resolve().then(() => tool?.handler({ input, context: room, signal: new AbortController().signal })),
        id,
      ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
      // The same call in the operator's own chat answers: what refused it was the room.
      await expect(
        Promise.resolve().then(() =>
          tool?.handler({ input, context: { ...room, memoryReach: undefined }, signal: new AbortController().signal }),
        ),
        id,
      ).resolves.toBeDefined();
    }
  });

  it("cannot be granted into a room or a chat: a room is never allowed, and only a tool chats are held back from may be allowed a person", async () => {
    const rooms = runtime.store.asPort().repositories.channelRooms;
    await rooms.upsert({
      connectionId,
      conversationId: "room-1",
      workspaceId: "default",
      label: "Room",
      trigger: ["mention"],
      members: "bound",
      context: "off",
      introState: "sent",
      createdAt: NOW,
      updatedAt: NOW,
    });
    // A room is only ever denied: a deny saves; an allow is refused for the room's own sake, whatever the tool.
    expect(
      (
        await channels<ChannelsGrantsAnswer>({
          action: "grants",
          workspaceId: "default",
          connectionId,
          op: "add",
          scopeKind: "room",
          scopeId: "room-1",
          toolId: "acme.cal.events",
          mode: "deny",
        })
      ).grants,
    ).toHaveLength(1);
    await expect(
      channels({
        action: "grants",
        workspaceId: "default",
        connectionId,
        op: "add",
        scopeKind: "room",
        scopeId: "room-1",
        toolId: "sandbox.run",
        mode: "allow",
      }),
    ).rejects.toThrow(/a room can never be allowed sandbox.run/);
    for (const toolId of ["mcp.raw.echo", "acme.cal.events", `${mailboxToolPrefix("gmail", "gmail-1")}search`]) {
      await expect(
        channels({
          action: "grants",
          workspaceId: "default",
          connectionId,
          op: "add",
          scopeKind: "room",
          scopeId: "room-1",
          toolId,
          mode: "allow",
        }),
      ).rejects.toThrow(/a room can only be denied tools/);
      await expect(
        channels({
          action: "grants",
          workspaceId: "default",
          connectionId,
          op: "add",
          scopeKind: "contact",
          scopeId: "op",
          toolId,
          mode: "allow",
        }),
      ).rejects.toThrow(/not held back from chats/);
    }
  });
});
