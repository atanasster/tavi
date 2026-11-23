import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  PluginManifestSchema,
  type ChannelDescriptor,
  type MessagingConnectorDefinition,
  type PluginIsolationPort,
  type PluginWorkerLaunch,
  type PluginVersionRecord,
  type WorkspaceSettings,
} from "@tavi/contracts";
import type { Locale } from "@tavi/contracts/i18n";
import { PluginHost, ToolRegistry, hashPluginDirectory } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { APP, GUILD, OPEN_USER, ROOM, TOKEN, fakeDiscord, turns } from "@tavi/test-support/discord";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadExternalPlugins, type ExternalChannelHost, type ExternalPluginLanguage } from "../../src/features/plugins/external.js";
import { canvasPluginLocale, pluginLanguage } from "../../src/features/plugins/localized.js";
import { assertDiscordBuilt, DISCORD_BUNDLE } from "../support/group-channels.js";
import { foundationPlugin, silentLog } from "../support/plugin-host.js";

/**
 * A plugin's `ctx.locale` and `ctx.t`: the workspace's language, read live, and
 * the plugin's own messages in it with English, then the key, behind them — in
 * the owner's process, in a confined worker, and in Discord's bundle answering a
 * command.
 */

const directories = temporaryDirectories();
afterEach(() => {
  vi.unstubAllGlobals();
  directories.cleanup();
});

/** A workspace language a test switches, heard as the owner's settings cell would tell it. */
function switchable(initial: Locale): ExternalPluginLanguage & { set(locale: Locale): void } {
  let current = initial;
  const listeners = new Set<(locale: Locale) => void>();
  return {
    current: () => current,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (locale) => {
      current = locale;
      for (const listener of listeners) listener(locale);
    },
  };
}

/** The loader with only what these tests hand it: channels, a worker host, the workspace's language. */
async function load(
  resolved: Parameters<typeof loadExternalPlugins>[0],
  tools: ToolRegistry,
  extra: { readonly channels?: ExternalChannelHost; readonly isolation?: PluginIsolationPort; readonly language?: ExternalPluginLanguage },
) {
  const none = undefined;
  return await loadExternalPlugins(
    resolved,
    tools,
    silentLog,
    async () => null,
    { bind: () => async () => {} },
    none,
    none,
    extra.channels,
    none,
    none,
    none,
    none,
    extra.isolation,
    none,
    none,
    none,
    none,
    none,
    extra.language,
  );
}

const MANIFEST = {
  schemaVersion: 3,
  abi: "tavi.providers/1",
  provenance: { format: "bundled-esm", packages: [] },
  id: "acme.greeter",
  version: "1.0.0",
  name: "Greeter",
  entry: "index.mjs",
  tools: [{ name: "greet", effect: "read-only", description: "Greets", sink: "none" }],
  config: {},
  locales: { bg: "locales/bg.json", en: "locales/en.json" },
};

function greeter(isolation?: "process"): { readonly record: PluginVersionRecord; readonly directory: string; readonly entryPath: string } {
  const directory = directories.create("tavi-plugin-language-");
  const entryPath = join(directory, "index.mjs");
  writeFileSync(
    entryPath,
    "export function register(ctx) { ctx.registerTool({ name: 'greet', inputSchema: ctx.z.object({}), handler: async () => ({ locale: ctx.locale, hello: ctx.t('hello', { name: 'Ana' }), bye: ctx.t('bye'), none: ctx.t('none') }) }); }\n",
  );
  mkdirSync(join(directory, "locales"));
  writeFileSync(join(directory, "locales", "bg.json"), JSON.stringify({ messages: { hello: "Здравей, {name}" } }));
  writeFileSync(join(directory, "locales", "en.json"), JSON.stringify({ messages: { hello: "Hello, {name}", bye: "Bye" } }));
  const record: PluginVersionRecord = {
    pluginId: "acme.greeter",
    version: "1.0.0",
    // Its packs are read only from a snapshot with its approved hash: this one's own.
    contentHash: hashPluginDirectory(directory).hash,
    manifest: PluginManifestSchema.parse(MANIFEST),
    reviewState: "approved",
    installedBy: "test",
    installedAt: "2026-11-23T00:00:00.000Z",
    ...(isolation === undefined ? {} : { isolation }),
  };
  return { record, directory, entryPath };
}

describe("ctx.locale and ctx.t in the owner's process", () => {
  it("read the workspace's language live, and the plugin's messages with English, then the key, behind them", async () => {
    const plugin = greeter();
    const language = switchable("bg");
    const tools = new ToolRegistry();
    const loaded = await load([{ ok: true, ...plugin, config: {}, instances: [] }], tools, { language });
    const host = new PluginHost([foundationPlugin(), ...loaded.definitions], { buildId: "language-test" });
    await host.start();
    try {
      const greet = async () =>
        await tools.get("acme.greeter.greet")?.handler({
          input: {},
          context: { workspaceId: "default", principalId: "ana", runId: "task-1", caller: "test" },
          signal: new AbortController().signal,
        } as never);
      expect(await greet()).toEqual({ locale: "bg", hello: "Здравей, Ana", bye: "Bye", none: "none" });
      language.set("en");
      expect(await greet()).toEqual({ locale: "en", hello: "Hello, Ana", bye: "Bye", none: "none" });
    } finally {
      await host.stop();
    }
  });

  it("are English without a language from the owner", async () => {
    const plugin = greeter();
    const tools = new ToolRegistry();
    const loaded = await load([{ ok: true, ...plugin, config: {}, instances: [] }], tools, {});
    const host = new PluginHost([foundationPlugin(), ...loaded.definitions], { buildId: "language-test-en" });
    await host.start();
    try {
      const answer = await tools.get("acme.greeter.greet")?.handler({
        input: {},
        context: { workspaceId: "default", principalId: "ana", runId: "task-1", caller: "test" },
        signal: new AbortController().signal,
      } as never);
      expect(answer).toEqual({ locale: "en", hello: "Hello, Ana", bye: "Bye", none: "none" });
    } finally {
      await host.stop();
    }
  });
});

describe("ctx.locale in a confined worker", () => {
  it("starts it with the language and its messages, and tells it each change", async () => {
    const plugin = greeter("process");
    const language = switchable("bg");
    const launches: PluginWorkerLaunch[] = [];
    const told: Locale[] = [];
    const isolation: PluginIsolationPort = {
      start: async (launch) => {
        launches.push(launch);
        return {
          registrations: { tools: [], hooks: [], commands: [], signalSources: [] },
          callTool: async () => undefined,
          beforeCall: async () => undefined,
          collect: async () => [],
          hook: async () => undefined,
          command: async () => ({ text: "" }),
          status: () => ({ state: "running", restarts: 0 }),
          stop: async () => undefined,
          setLocale: (locale) => told.push(locale),
        };
      },
    };
    const loaded = await load([{ ok: true, ...plugin, config: {}, instances: [] }], new ToolRegistry(), { isolation, language });
    const host = new PluginHost([foundationPlugin(), ...loaded.definitions], { buildId: "language-worker" });
    await host.start();
    try {
      expect(launches[0]?.locale).toBe("bg");
      expect(launches[0]?.messages).toEqual({ bg: { hello: "Здравей, {name}" }, en: { hello: "Hello, {name}", bye: "Bye" } });
      language.set("en");
      expect(told).toEqual(["en"]);
    } finally {
      await host.stop();
    }
    // Stopped, it hears no more.
    language.set("bg");
    expect(told).toEqual(["en"]);
  });
});

describe("the owner's language cell", () => {
  it("follows a settings write, and the canvas reads plugin words in it, never the terminal", async () => {
    let settings: WorkspaceSettings = { locale: "bg" } as WorkspaceSettings;
    const listeners = new Set<(operation: string) => void>();
    const repository = { get: async () => ({ settings }) } as never;
    const cell = await pluginLanguage(repository, "default", (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const heard: Locale[] = [];
    cell.onChange?.((locale) => heard.push(locale));
    expect(cell.current()).toBe("bg");
    settings = { locale: "en" } as WorkspaceSettings;
    // A read is no change; a write is read again.
    for (const listener of listeners) listener("repository.workspaceSettings.get");
    await turns();
    expect(cell.current()).toBe("bg");
    for (const listener of listeners) listener("repository.workspaceSettings.set");
    await vi.waitFor(() => expect(cell.current()).toBe("en"));
    expect(heard).toEqual(["en"]);
    cell.close();
    expect(listeners.size).toBe(0);
    settings = { locale: "bg" } as WorkspaceSettings;
    expect(await canvasPluginLocale(repository, "default", true)).toBe("bg");
    expect(await canvasPluginLocale(repository, "default", false)).toBeUndefined();
    settings = {} as WorkspaceSettings;
    expect(await canvasPluginLocale(repository, "default", true)).toBeUndefined();
  });
});

describe("Discord's bundle", () => {
  it("answers a command in Bulgarian through the owner's ctx.locale, and in English once the language changes", async () => {
    assertDiscordBuilt();
    const discord = fakeDiscord();
    // The bundle opens its Gateway on the global WebSocket: here, the fake's.
    vi.stubGlobal("WebSocket", function FakeWebSocket(url: string) {
      return discord.webSocket(url);
    });
    const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(join(DISCORD_BUNDLE, "tavi-plugin.json"), "utf8")));
    const record: PluginVersionRecord = {
      pluginId: manifest.id,
      version: manifest.version,
      contentHash: "c".repeat(64),
      manifest,
      reviewState: "approved",
      installedBy: "test",
      installedAt: "2026-11-23T00:00:00.000Z",
    };
    const language = switchable("bg");
    const definitions: MessagingConnectorDefinition[] = [];
    const channels: ExternalChannelHost = {
      register: (_descriptor: ChannelDescriptor, definition: MessagingConnectorDefinition) => {
        definitions.push(definition);
        return async () => undefined;
      },
      taken: () => false,
      services: () => ({ now: () => new Date().toISOString(), fetch: discord.fetch, readArtifact: async () => undefined }),
    };
    const loaded = await load(
      [{ ok: true, record, directory: DISCORD_BUNDLE, entryPath: join(DISCORD_BUNDLE, "index.mjs"), config: {}, instances: [] }],
      new ToolRegistry(),
      { channels, language },
    );
    const host = new PluginHost([foundationPlugin(), ...loaded.definitions], { buildId: "language-discord" });
    await host.start();
    const definition = definitions[0];
    if (definition === undefined) throw new Error("the bundle registered no channel");
    const instance = definition.createConnection({
      connection: {
        connectionId: "discord-1",
        providerId: "discord",
        accountIdentity: "tavi",
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
        credentialRefs: { token: "ref.token" },
      },
      config: {},
      credentials: { get: async () => TOKEN, accessToken: async () => TOKEN },
    });
    try {
      instance.onInboundEvent?.(async () => ({ accepted: true, duplicate: false, dropped: "flood" as const }));
      await instance.start();
      await turns();
      let next = 0;
      const ask = () => {
        next += 1;
        return {
          id: (BigInt("762000000000000900") + BigInt(next)).toString(),
          application_id: APP,
          type: 2,
          token: `lang-${String(next)}`,
          channel_id: ROOM,
          guild_id: GUILD,
          member: { user: { id: OPEN_USER } },
          data: { name: "tavi", type: 1, options: [{ type: 1, name: "ask", options: [{ type: 3, name: "question", value: "hi" }] }] },
        };
      };
      const bulgarian = ask();
      discord.dispatch("INTERACTION_CREATE", bulgarian);
      await turns();
      language.set("en");
      const english = ask();
      discord.dispatch("INTERACTION_CREATE", english);
      await turns();
      expect(discord.posted.find((post) => post.channel === `interaction:${bulgarian.token}`)?.content).toBe(
        "Твърде много съобщения тук. Опитай пак след минута.",
      );
      expect(discord.posted.find((post) => post.channel === `interaction:${english.token}`)?.content).toBe(
        "Too many messages here right now: try again in a minute.",
      );
    } finally {
      await instance.stop();
      await host.stop();
    }
  });
});
