import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CHANNEL_ABI, type ChannelsListAnswer, type ChannelsPayload, type ChannelsSaveAnswer } from "@tavi/contracts";
import { freePort, temporaryDirectories } from "@tavi/test-support";

import { channelDescriptorOf } from "../../src/features/channels/catalog.js";
import { channelsCommand } from "../../src/features/channels/owner.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * A channel from an external plugin: declared in the manifest and reviewed with it, its connector supplied
 * by `registerChannel`, configured and opened like a builtin one.
 */

const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});

const temp = () => {
  const path = dirs.create("tavi-channel-plugin-");
  return path;
};

const descriptor = {
  providerId: "pigeon",
  label: "Pigeon",
  kind: "chat",
  description: "Messages by carrier pigeon.",
  settings: [{ key: "loft", label: "Loft", type: "string", required: true }],
  auth: { kind: "secrets", fields: [{ key: "token", label: "Token" }] },
  sender: { label: "Pigeon ID", placeholder: "p-1", pattern: "p-\\d+", normalize: "none", authentication: "provider" },
  target: { label: "Pigeon ID", placeholder: "p-1", pattern: "p-\\d+", normalize: "none" },
  ingress: [{ name: "events", methods: ["POST"], scope: "connection", maxBodyBytes: 1024 }],
};

const PLUGIN_CODE = `
export function register({ registerChannel, z }) {
  registerChannel({
    providerId: "pigeon",
    version: "1.0.0",
    configSchema: z.object({ loft: z.string() }).passthrough(),
    capabilities: { receiveMode: "none", send: true, editOrProgress: false, formats: ["plain"], attachments: false, maxAttachmentBytes: 0, maxPartsPerMessage: 1, threads: false, interactions: false, deliveryReceipts: false, maxTextLength: 280, approvals: "none" },
    createConnection: ({ credentials }) => {
      let state = "stopped";
      return {
        start: async () => { if ((await credentials.get("token")) === null) throw new Error("no token"); state = "running"; },
        stop: async () => { state = "stopped"; },
        status: () => ({ state, since: "" }),
        probe: async () => ({ ok: true }),
        send: async () => ({ status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted", providerMessageId: "m1" }] }),
      };
    },
    destinationFor: (target) => ({ to: target.to }),
  });
}
`;

function createChannelPlugin(version: string, channelAbi = CHANNEL_ABI, code = PLUGIN_CODE): string {
  const path = temp();
  writeFileSync(join(path, "index.mjs"), code);
  writeFileSync(
    join(path, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.pigeon",
      version,
      name: "Pigeon channel",
      entry: "index.mjs",
      provides: ["channel"],
      channels: [descriptor],
      channelAbi,
      capabilities: [],
      tools: [],
      config: {},
    }),
  );
  return path;
}

async function compose(dataDirectory: string): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(dataDirectory, { scheduleSweepEnabled: false, openSavedChannels: true }), {
    requireModelTransport: false,
  });
  runtimes.push(runtime);
  // The webhook listener on a port of its own: the default one (8025) may be taken on the machine.
  await runtime.store.asPort().repositories.channelIngress.set({ host: "127.0.0.1", port: await freePort() }, "2026-10-18T00:00:00.000Z");
  return runtime;
}

async function installed(dataDirectory: string, source: string, version: string): Promise<void> {
  const setup = await compose(dataDirectory);
  await setup.plugins.registry.install(source, "operator");
  await setup.plugins.registry.decide("acme.pigeon", version, "approved", "operator");
  await setup.plugins.registry.configure("acme.pigeon", {}, [], "operator");
  await setup.plugins.registry.enable("acme.pigeon", "operator");
  runtimes.splice(runtimes.indexOf(setup), 1);
  await setup.close();
}

describe("a channel plugin", () => {
  it("is reviewed by what its channel may do, then configured and opened like a builtin one", async () => {
    const dataDirectory = temp();
    await installed(dataDirectory, createChannelPlugin("1.0.0"), "1.0.0");
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.pigeon").phase).toBe("ready");
    // Its review names what the channel may do and every address it reaches.
    const view = (await runtime.plugins.registry.list()).find((plugin) => plugin.id === "acme.pigeon");
    expect(view?.versions[0]?.channels).toEqual([
      {
        providerId: "pigeon",
        label: "Pigeon",
        kind: "chat",
        disclosure: "Receives messages from outside and can send as you on Pigeon",
        endpoints: ["webhook POST /hooks/<connection>/events (up to 1024 bytes)"],
        retention: "keep",
      },
    ]);
    expect(channelDescriptorOf("pigeon")?.label).toBe("Pigeon");
    const run = async <T>(payload: ChannelsPayload): Promise<T> =>
      (
        await channelsCommand(
          {
            dataDirectory,
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
    expect(
      (await run<{ channels: { providerId: string }[] }>({ action: "catalog" })).channels.map((channel) => channel.providerId),
    ).toContain("pigeon");
    const saved = await run<ChannelsSaveAnswer>({
      action: "save",
      workspaceId: "default",
      providerId: "pigeon",
      enabled: true,
      settings: { loft: "roof" },
      secrets: { token: "t" },
    });
    expect(saved).not.toHaveProperty("notApplied");
    expect((await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).connections).toEqual([
      expect.objectContaining({ connectionId: saved.connectionId, label: "Pigeon", status: expect.objectContaining({ state: "running" }) }),
    ]);
    expect(await run({ action: "test", workspaceId: "default", connectionId: saved.connectionId, to: "p-7" })).toEqual({
      status: "accepted",
    });
    // Disabled, its channel is withdrawn: its connection shows the channel missing, and nothing of it stays installed.
    await runtime.plugins.registry.disable("acme.pigeon", "operator");
    await expect
      .poll(async () => (await run<ChannelsListAnswer>({ action: "list", workspaceId: "default" })).connections[0]?.status.detail)
      .toBe("provider missing: its channel is not installed");
    expect(channelDescriptorOf("pigeon")).toBeUndefined();
    expect(runtime.messaging.capabilitiesOf(saved.connectionId)).toBeUndefined();
  });

  it("built for a channel ABI this tavi does not speak (3), is refused and registers nothing", async () => {
    const dataDirectory = temp();
    await installed(dataDirectory, createChannelPlugin("1.0.0", 3), "1.0.0");
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.pigeon").phase).not.toBe("ready");
    expect(JSON.stringify(runtime.plugins.status("acme.pigeon"))).toContain("channel ABI 3");
    expect(channelDescriptorOf("pigeon")).toBeUndefined();
  });

  it("built for channel ABI 1, still loads and registers its channel", async () => {
    const dataDirectory = temp();
    await installed(dataDirectory, createChannelPlugin("1.0.0", 1), "1.0.0");
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.pigeon").phase).toBe("ready");
    expect(channelDescriptorOf("pigeon")?.label).toBe("Pigeon");
  });

  it("built for channel ABI 2, is handed the host's services; one built for ABI 1 is not", async () => {
    // The plugin keeps what it was handed where the test can read it: channel plugins run in the owner's process.
    const code = PLUGIN_CODE.replace(
      "export function register({ registerChannel, z }) {",
      "export function register({ registerChannel, z, channelHost }) {\n  globalThis.__pigeonHost = channelHost ?? null;",
    ).replace("attachments: false, maxAttachmentBytes: 0", "attachments: true, maxAttachmentBytes: 8");
    const host = (): {
      now(): string;
      fetch: unknown;
      readArtifact(id: string, workspaceId: string, maxBytes: number): Promise<{ bytes: Uint8Array } | undefined>;
    } | null => (globalThis as { __pigeonHost?: ReturnType<typeof host> }).__pigeonHost ?? null;
    const dataDirectory = temp();
    await installed(dataDirectory, createChannelPlugin("1.0.0", 2, code), "1.0.0");
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.pigeon").phase).toBe("ready");
    const services = host();
    expect(typeof services?.now()).toBe("string");
    expect(typeof services?.fetch).toBe("function");
    const artifacts = runtime.store.asPort().repositories.artifacts;
    const small = await artifacts.putArtifact({ workspaceId: "default", contentType: "text/plain", body: "1234" });
    const large = await artifacts.putArtifact({ workspaceId: "default", contentType: "text/plain", body: "123456789" });
    const pending = await artifacts.putArtifact({
      workspaceId: "default",
      contentType: "text/plain",
      body: "1234",
      reviewState: "pending",
    });
    expect(new TextDecoder().decode((await services?.readArtifact(small.artifactId, "default", 1_000))?.bytes)).toBe("1234");
    // Capped at what the plugin's channel may send, whatever it asks for; never another workspace's, never an unapproved one.
    expect(await services?.readArtifact(large.artifactId, "default", 1_000)).toBeUndefined();
    expect(await services?.readArtifact(small.artifactId, "other", 1_000)).toBeUndefined();
    expect(await services?.readArtifact(pending.artifactId, "default", 1_000)).toBeUndefined();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await runtime.close();
    // Once the plugin's lifetime ends, what it was handed reads nothing.
    expect(await services?.readArtifact(small.artifactId, "default", 1_000)).toBeUndefined();

    // A channel that sends no attachments is handed no artifact at all.
    const noFiles = temp();
    await installed(
      noFiles,
      createChannelPlugin(
        "1.0.0",
        2,
        code.replace("attachments: true, maxAttachmentBytes: 8", "attachments: false, maxAttachmentBytes: 0"),
      ),
      "1.0.0",
    );
    const runtimeNoFiles = await compose(noFiles);
    const unsent = await runtimeNoFiles.store
      .asPort()
      .repositories.artifacts.putArtifact({ workspaceId: "default", contentType: "text/plain", body: "1" });
    expect(await host()?.readArtifact(unsent.artifactId, "default", 1_000)).toBeUndefined();
    runtimes.splice(runtimes.indexOf(runtimeNoFiles), 1);
    await runtimeNoFiles.close();

    const older = temp();
    await installed(older, createChannelPlugin("1.0.0", 1, code), "1.0.0");
    const runtimeAbi1 = await compose(older);
    expect(runtimeAbi1.plugins.status("acme.pigeon").phase).toBe("ready");
    expect(host()).toBeNull();
  });

  it("may not declare a channel already installed, and is refused before its code runs", async () => {
    const dataDirectory = temp();
    const source = createChannelPlugin("4.0.0", CHANNEL_ABI, "throw new Error('the code ran');");
    const manifest = JSON.parse(readFileSync(join(source, "tavi-plugin.json"), "utf8")) as { channels: { providerId: string }[] };
    manifest.channels[0]!.providerId = "telegram";
    writeFileSync(join(source, "tavi-plugin.json"), JSON.stringify(manifest));
    await installed(dataDirectory, source, "4.0.0");
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.pigeon").error).toMatch(/its channel telegram is already installed/);
    expect(channelDescriptorOf("telegram")?.label).toBe("Telegram");
  });

  it("is refused, with what it needs, when built for another channel contract", async () => {
    const dataDirectory = temp();
    await installed(dataDirectory, createChannelPlugin("2.0.0", CHANNEL_ABI + 1), "2.0.0");
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.pigeon").error).toMatch(
      new RegExp(`needs an update: its channels are built for channel ABI ${String(CHANNEL_ABI + 1)}`),
    );
    expect(channelDescriptorOf("pigeon")).toBeUndefined();
  });

  it("has its group capabilities read only at channel ABI 2, checked there, and a new room's trigger only what its connector reports", async () => {
    const GROUPS =
      'groups: { addressing: ["mention"], directToSender: false, listRooms: false, membershipEvents: false, leaveRoom: false },';
    const withGroups = (groups: string) => PLUGIN_CODE.replace('approvals: "none" }', `approvals: "none", ${groups} }`);
    const open = async (runtime: TaviRuntime): Promise<string> =>
      (
        (await channelsCommand(
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
          },
          {
            action: "save",
            workspaceId: "default",
            providerId: "pigeon",
            enabled: true,
            settings: { loft: "roof" },
            secrets: { token: "t" },
          },
        )) as { result: ChannelsSaveAnswer }
      ).result.connectionId;
    // Channel ABI 1 has no groups: what such a plugin says of them is not read.
    const older = temp();
    await installed(older, createChannelPlugin("1.0.0", 1, withGroups(GROUPS)), "1.0.0");
    const abi1 = await compose(older);
    expect(abi1.plugins.status("acme.pigeon").phase).toBe("ready");
    expect(abi1.messaging.capabilitiesOf(await open(abi1))?.groups).toBeUndefined();
    runtimes.splice(runtimes.indexOf(abi1), 1);
    await abi1.close();
    // At ABI 2 they must parse.
    const invalid = temp();
    await installed(
      invalid,
      createChannelPlugin(
        "1.0.0",
        2,
        withGroups("groups: { addressing: [], directToSender: false, listRooms: false, membershipEvents: false, leaveRoom: false },"),
      ),
      "1.0.0",
    );
    expect((await compose(invalid)).plugins.status("acme.pigeon").error).toMatch(/channel pigeon's group capabilities are invalid/);
    // And a new room's trigger may use only the address kinds the connector reports.
    const source = createChannelPlugin("1.0.0", 2, withGroups(GROUPS));
    const manifest = JSON.parse(readFileSync(join(source, "tavi-plugin.json"), "utf8")) as { channels: Record<string, unknown>[] };
    manifest.channels[0]!["groups"] = { unboundSenders: "drop", unlistedRooms: "drop", defaultTrigger: ["mention", "reply"] };
    writeFileSync(join(source, "tavi-plugin.json"), JSON.stringify(manifest));
    const unreported = temp();
    await installed(unreported, source, "1.0.0");
    expect((await compose(unreported)).plugins.status("acme.pigeon").error).toMatch(
      /default trigger uses reply, which its connector does not report/,
    );
  });

  it("may not supply a channel its manifest does not declare", async () => {
    const dataDirectory = temp();
    await installed(
      dataDirectory,
      createChannelPlugin("3.0.0", CHANNEL_ABI, PLUGIN_CODE.replace('providerId: "pigeon"', 'providerId: "raven"')),
      "3.0.0",
    );
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.pigeon").error).toMatch(/channel raven is not declared in the manifest/);
  });
});
