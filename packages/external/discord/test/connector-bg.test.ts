import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { pluginTranslate, type PluginMessages } from "@tavi/contracts";
import type { MessagingConnectorInstance } from "@tavi/contracts";
import { TOKEN, fakeDiscord, turns } from "@tavi/test-support/discord";

import { createDiscordConnectorDefinition } from "../src/connector.js";
import { VERSION } from "../src/index.js";

/**
 * The connector's status and setup words in Settings → Channels, in a Bulgarian workspace: said through the plugin's
 * own messages (`ctx.t` over `locales/bg.json`), as the host says them; English as before in an English one.
 */

const pack = JSON.parse(readFileSync(join(import.meta.dirname, "..", "locales", "bg.json"), "utf8")) as {
  readonly messages: NonNullable<PluginMessages["bg"]>;
};
const messages: PluginMessages = { bg: pack.messages };

const connection = () => ({
  connectionId: "discord-1",
  providerId: "discord",
  accountIdentity: "tavi",
  workspaceId: "w",
  configRevision: 1,
  enabled: true,
  credentialRefs: { token: "ref.token" },
});
const instances: MessagingConnectorInstance[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop();
});

async function started(locale: string, application: Record<string, unknown> = {}, token: string | null = TOKEN) {
  const discord = fakeDiscord({ application });
  const definition = createDiscordConnectorDefinition({
    z,
    version: VERSION,
    fetch: discord.fetch,
    webSocket: discord.webSocket,
    gatewayClock: discord.clock,
    requestTimeoutMs: 40,
    locale: () => locale,
    // As the host's `ctx.t`: the workspace's language, else English's pack (none), else the key.
    t: (key, params) => pluginTranslate(messages, locale === "bg" ? "bg" : "en", key, params),
  });
  const instance = definition.createConnection({
    connection: connection(),
    config: {},
    credentials: { get: async () => token, accessToken: async () => token ?? "" },
  });
  instance.onInboundEvent?.(async () => undefined);
  instances.push(instance);
  return instance;
}

describe("the Discord connector in Bulgarian", () => {
  it("writes its setup notes, its invite link's label and its privileged intents in Bulgarian", async () => {
    const instance = await started("bg", { bot_public: true, flags: (1 << 19) | (1 << 15) | (1 << 13) });
    await instance.start();
    await turns();
    const probe = await instance.probe();
    expect(probe.setup?.lines).toEqual([
      "Бот tavi.",
      "Public Bot е включен: всеки с поканата може да добави бота в сървър. Изключи го в Developer Portal.",
      "Интентът Presence и интентът Server Members са включени за бота: Tavi не ги използва и можеш да ги изключиш.",
      "Интентът Message Content е включен: стая, настроена да чете последните си съобщения, ги чете.",
    ]);
    expect(probe.setup?.link?.label).toBe("Покани бота в сървър");
    expect(probe.detail).toContain("Покани го: https://discord.com/oauth2/authorize?");
  });

  it("says one privileged intent in the singular", async () => {
    const instance = await started("bg", { flags: 1 << 15 });
    await instance.start();
    await turns();
    expect((await instance.probe()).setup?.lines).toContain(
      "Интентът Server Members е включен за бота: Tavi не го използва и можеш да го изключиш.",
    );
  });

  it("names a missing token in Bulgarian on the status Settings → Channels shows", async () => {
    const instance = await started("bg", {}, null);
    await expect(instance.start()).rejects.toThrow("has no bot token");
    expect(instance.status()).toMatchObject({ state: "failed", detail: "липсва токен на бота", repair: "credentials" });
  });

  it("stays in English in an English workspace", async () => {
    const instance = await started("en", { flags: 1 << 15 });
    await instance.start();
    await turns();
    const probe = await instance.probe();
    expect(probe.setup?.lines).toContain("The Server Members intent is on for the bot: Tavi does not use it, and you can turn it off.");
    expect(probe.setup?.link?.label).toBe("Invite the bot to a server");
  });
});
