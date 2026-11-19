import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CredentialKeychain } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import {
  credentialsEncrypted,
  createLocalCredentialStore,
  encryptCredentialDirectory,
  plainCredentialStoreWarning,
  provisionCredentialKey,
} from "../../src/features/credentials/store.js";
import { resetDataDirectoryAndKey, resetSummary } from "../../src/features/maintenance/reset.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntimeOptions } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";
import { memoryKeychain } from "../support/memory-keychain.js";

/**
 * The credential key in the OS keychain: a
 * new data directory is encrypted from its first open with no step of its
 * own, a directory that existed before is left exactly as it was, and
 * `tavi credentials encrypt` puts a new key in the keychain where it can.
 * Every keychain here is in memory: no test runs `security` or `secret-tool`.
 */

const directories = temporaryDirectories({ prefix: "tavi-keychain-" });

afterEach(() => {
  directories.cleanup();
});

const options = (directory: string): TaviRuntimeOptions => fixtureRuntimeOptions(directory, { approvalRequiredFor: [] });

/** Open the data directory as an owner does, then close it. */
async function open(directory: string, keychain: CredentialKeychain | null): Promise<void> {
  const runtime = await composeTaviRuntime(options(directory), { credentialKeychain: keychain, requireModelTransport: false });
  await runtime.close();
}

describe("a new data directory's credential key", () => {
  it("is put in the keychain on the first open, so the store is encrypted with no step of its own", async () => {
    const directory = directories.create();
    const { keychain, items } = memoryKeychain();
    await open(directory, keychain);
    expect(items.size).toBe(1);
    expect(readFileSync(join(directory, "credentials.key"), "utf8")).toMatch(/^tavi-keychain:v1:macos:[0-9a-f]{32}\n$/);
    expect(credentialsEncrypted(directory)).toBe(true);
  });

  it("is not made where there is no keychain, or it refuses: the store stays plain, as before", async () => {
    for (const keychain of [null, memoryKeychain({ refuse: true }).keychain]) {
      const directory = directories.create();
      await open(directory, keychain);
      expect(readdirSync(directory)).not.toContain("credentials.key");
      expect(credentialsEncrypted(directory)).toBe(false);
    }
  });

  it("is never added to a directory that existed before: an unencrypted one stays unencrypted", async () => {
    const directory = directories.create();
    await open(directory, null);
    const { keychain, items } = memoryKeychain();
    await open(directory, keychain);
    expect(items.size).toBe(0);
    expect(readdirSync(directory)).not.toContain("credentials.key");
  });

  it("leaves a directory encrypted with a key file as it was, and still reads it", async () => {
    const directory = directories.create();
    await open(directory, null);
    const store = createLocalCredentialStore(directory);
    await encryptCredentialDirectory(directory, undefined);
    const key = readFileSync(join(directory, "credentials.key"), "utf8");
    expect(key).toMatch(/^[0-9a-f]{64}\n$/);
    await store.setSecret("model.key", "sk-live-value");
    const { keychain, items } = memoryKeychain();
    await open(directory, keychain);
    expect(items.size).toBe(0);
    expect(readFileSync(join(directory, "credentials.key"), "utf8")).toBe(key);
    expect(await store.getSecret("model.key")).toBe("sk-live-value");
  });
});

describe("provisioning and reset", () => {
  it("encrypts a value stored before the key was created", async () => {
    const directory = directories.create();
    await createLocalCredentialStore(directory).setSecret("model.key", "sk-live-value");
    const { keychain } = memoryKeychain();
    expect(await provisionCredentialKey(directory, keychain)).toBe("created");
    expect(readFileSync(join(directory, "credentials", "model.key"), "utf8")).toMatch(/^tavi-enc:v1:/);
  });

  it("deletes the keychain item with the directory, and says so", async () => {
    const directory = directories.create();
    const { keychain, items } = memoryKeychain();
    await open(directory, keychain);
    expect(items.size).toBe(1);
    const result = await resetDataDirectoryAndKey(directory, [], keychain);
    expect(items.size).toBe(0);
    expect(readdirSync(directory)).not.toContain("credentials.key");
    expect(resetSummary(directory, result)).toMatch(
      /deleted the credential key in the test keychain \(service tavi-credential-key, account [0-9a-f]{32}\)/,
    );
  });

  it("still resets when the keychain refuses, naming the item left behind", async () => {
    const directory = directories.create();
    const { keychain, items } = memoryKeychain();
    await open(directory, keychain);
    const result = await resetDataDirectoryAndKey(directory, [], { ...keychain, delete: async () => Promise.reject(new Error("locked")) });
    expect(items.size).toBe(1);
    expect(readdirSync(directory)).not.toContain("credentials.key");
    expect(result.keychainItem).toMatch(/could not delete .*: locked; delete it in the test keychain/);
  });
});

describe("tavi credentials encrypt with a keychain", () => {
  it("creates the key in the keychain and encrypts the plain values under it", async () => {
    const directory = directories.create();
    const { keychain, items } = memoryKeychain();
    mkdirSync(join(directory, "credentials"), { mode: 0o700 });
    writeFileSync(join(directory, "credentials", "model.key"), "sk-live-value\n", { mode: 0o600 });
    const result = await encryptCredentialDirectory(directory, keychain);
    expect(result).toMatchObject({ keyCreated: true, keychain: "the test keychain", encrypted: ["model.key"] });
    expect(items.size).toBe(1);
    expect(readFileSync(join(directory, "credentials", "model.key"), "utf8")).toMatch(/^tavi-enc:v1:/);
    // A second run uses the same key and changes nothing.
    expect(await encryptCredentialDirectory(directory, keychain)).toMatchObject({
      keyCreated: false,
      keychain: "the test keychain",
      encrypted: [],
      alreadyEncrypted: ["model.key"],
    });
  });

  it("falls back to a key file when the keychain refuses", async () => {
    const directory = directories.create();
    const result = await encryptCredentialDirectory(directory, memoryKeychain({ refuse: true }).keychain);
    expect(result.keyCreated).toBe(true);
    expect(result.keychain).toBeUndefined();
    expect(readFileSync(join(directory, "credentials.key"), "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
  });
});

describe("a plain credential store with values in it", () => {
  it("is said, with the count and the fix, so a store a keychain-less host left plain is never silent", async () => {
    const directory = directories.create();
    expect(await plainCredentialStoreWarning(directory)).toBeUndefined();
    await createLocalCredentialStore(directory).setSecret("model.key", "sk-live-value");
    await createLocalCredentialStore(directory).setSecret("other.key", "sk-live-other");
    const warning = await plainCredentialStoreWarning(directory);
    expect(warning).toContain("2 credentials");
    expect(warning).toContain("not encrypted at rest");
    expect(warning).toContain("tavi credentials encrypt");
  });

  it("is not said once the store is encrypted", async () => {
    const directory = directories.create();
    await createLocalCredentialStore(directory).setSecret("model.key", "sk-live-value");
    await encryptCredentialDirectory(directory, undefined);
    expect(await plainCredentialStoreWarning(directory)).toBeUndefined();
  });
});
