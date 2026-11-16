import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { keyHash, type ModelServer, startModelServer, writeKeyFile } from "../support/maintain.js";
import { walkGuide } from "../support/walk.js";

// Made-up keys for a made-up provider, served on this computer: never a real one.
const FIRST_KEY = "sk-test-lumen-0001-not-a-real-key";
const NEW_KEY = "sk-test-lumen-0002-not-a-real-key";

/** What the provider accepts now: the walk rewrites it when the provider "issues" a new key. */
let accepted = "";
let lumen: ModelServer | undefined;

interface Tested {
  readonly ok: boolean;
}

/** `tavi models test lumen`'s answer: a refused key exits 1, with the answer printed all the same. */
function tested(walk: { tavi(...args: string[]): string }): Tested {
  try {
    return JSON.parse(walk.tavi("models", "test", "lumen", "--format", "json")) as Tested;
  } catch (error) {
    return JSON.parse(String((error as { stdout?: unknown }).stdout ?? "{}")) as Tested;
  }
}

/** The key the server's last completion bore, by its hash. */
const lastKey = (server: ModelServer) => server.requests.filter((request) => request.line.endsWith("/chat/completions")).at(-1)?.key;

walkGuide("run-and-maintain/credentials", {
  configured: false,
  steps: {
    "store-the-key": async (walk) => {
      const file = writeKeyFile("lumen.key", FIRST_KEY);
      const screen = await walk.terminal({
        title: "tavi credentials set lumen.apiKey --file lumen.key",
        args: ["credentials", "set", "lumen.apiKey", "--file", file],
      });
      expect(screen.join("\n")).toContain("stored credential lumen.apiKey");
      expect(screen.join("\n")).not.toContain(FIRST_KEY);
      expect(walk.tavi("credentials", "list")).toMatch(/^lumen\.apiKey$/m);
    },
    "use-it-for-a-connection": async (walk) => {
      accepted = writeKeyFile("accepted.key", FIRST_KEY);
      lumen = await startModelServer({ port: 8089, models: ["lumen-chat-1"], acceptKeyFile: accepted });
      walk.tavi("models", "add", "lumen", "--base-url", lumen.baseUrl, "--credential", "lumen.apiKey", "--model", "lumen-chat-1");
      const screen = await walk.terminal({ title: "tavi models test lumen", args: ["models", "test", "lumen"] });
      expect(screen.join("\n")).toMatch(/"ok": true/);
      const server = lumen;
      await expect.poll(() => lastKey(server)).toBe(keyHash(FIRST_KEY));
    },
    "see-what-is-stored": async (walk) => {
      const page = await walk.open("/settings/credentials");
      await page.locator("section.settings").getByText("lumen.apiKey").waitFor();
      // The store's encryption, in one read-only line: encrypted with its key somewhere, or not with the command that does it.
      await page
        .locator(".credential-encryption")
        .getByText(/^(Encrypted; key in .+|Not encrypted: run tavi credentials encrypt)$/)
        .waitFor();
      await walk.shot();
    },
    "rotate-the-key": async (walk) => {
      const server = lumen as ModelServer;
      // The provider issues a new key and stops taking the old one: until Tavi has it, the test fails.
      writeFileSync(accepted, NEW_KEY);
      expect(tested(walk).ok).toBe(false);
      walk.tavi("credentials", "set", "lumen.apiKey", "--file", writeKeyFile("lumen-new.key", NEW_KEY));
      const screen = await walk.terminal({ title: "tavi models test lumen", args: ["models", "test", "lumen"] });
      expect(screen.join("\n")).toMatch(/"ok": true/);
      await expect.poll(() => lastKey(server)).toBe(keyHash(NEW_KEY));
    },
    "check-where-the-encryption-key-is": async (walk) => {
      walk.unwalked(
        "the OS keychain: walks keep keys out of it (TAVI_CREDENTIAL_KEYCHAIN=off), so the walk's new data directory starts unencrypted, as an older one does",
      );
      const screen = await walk.terminal({ title: "tavi credentials key", args: ["credentials", "key"] });
      expect(screen.join("\n")).toMatch(/not encrypted/);
    },
    "encrypt-an-older-store": async (walk) => {
      const screen = await walk.terminal({ title: "tavi credentials encrypt", args: ["credentials", "encrypt"] });
      expect(screen.join("\n")).toMatch(/encrypted 1 credential/);
      expect(readFileSync(join(walk.dataDir, "credentials", "lumen.apiKey"), "utf8")).toMatch(/^tavi-enc:/);
      // Encrypted, the connection still works.
      expect(tested(walk).ok).toBe(true);
      expect(walk.tavi("credentials", "encrypt")).toMatch(/encrypted no credential, 1 already encrypted/);
    },
  },
});
