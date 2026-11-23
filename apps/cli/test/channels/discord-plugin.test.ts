import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { TaviError, type MessagingConnectorDefinition } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { assertDiscordBuilt, DISCORD_BUNDLE as bundle } from "../support/group-channels.js";

/**
 * Discord's bundle as an operator installs it: `tavi plugins install` of its `dist-plugin/`, an
 * approval that must say `--in-process`, its descriptor read offline, and a
 * refusal from the bundle that is the host's own `TaviError`.
 */

const directories = temporaryDirectories();

beforeAll(() => {
  assertDiscordBuilt();
});
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

describe("discord.channel installed from its bundle", () => {
  it("is approved only to run in-process, then its channel is known offline from the approved manifest", async () => {
    const directory = directories.create("tavi-discord-plugin-");
    const dir = ["--data-dir", directory];
    const installed = await tavi(["plugins", "install", bundle, ...dir]);
    expect(installed.code, installed.stderr).toBe(EXIT.ok);
    // A channel cannot be a worker: an approval that does not say so is refused, with what to say.
    const refused = await tavi(["plugins", "approve", "discord.channel", "0.1.3", ...dir]);
    expect(refused.code).not.toBe(EXIT.ok);
    expect(refused.stderr).toContain("approve it with --in-process");
    for (const argv of [
      ["plugins", "approve", "discord.channel", "0.1.3", "--in-process"],
      ["plugins", "enable", "discord.channel"],
    ]) {
      const answer = await tavi([...argv, ...dir]);
      expect(answer.code, answer.stderr).toBe(EXIT.ok);
    }
    const types = await tavi(["channels", "types", ...dir]);
    expect(types.code, types.stderr).toBe(EXIT.ok);
    expect(types.stdout).toContain("discord\tDiscord (chat)");
    expect(types.stdout).toContain("--secret-file token=<path>");
  }, 60_000);
});

describe("a refusal from Discord's bundle", () => {
  it("is the host's TaviError, so a connection that is not running maps to UNAVAILABLE", async () => {
    const module = (await import(pathToFileURL(join(bundle, "index.mjs")).href)) as { readonly register: (ctx: unknown) => void };
    const registered: MessagingConnectorDefinition[] = [];
    module.register({ TaviError, z, registerChannel: (definition: MessagingConnectorDefinition) => registered.push(definition) });
    const definition = registered[0];
    if (definition === undefined) throw new Error("the bundle registered no channel");
    const instance = await definition.createConnection({
      connection: {
        connectionId: "discord-1",
        providerId: "discord",
        accountIdentity: "",
        workspaceId: "default",
        configRevision: 1,
        enabled: true,
      },
      config: {},
      credentials: { get: async () => null, accessToken: async () => "" },
    });
    const refusal = await instance.leaveRoom?.({ channelId: "711000000000000001" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(TaviError);
    expect(refusal).toMatchObject({ code: "UNAVAILABLE" });
  });
});
