import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createCredentialKey,
  createEncryptedFileSecretStore,
  createKeychainCredentialKey,
  credentialKeyReference,
  deleteKeychainCredentialKey,
  ENCRYPTED_SECRET_PREFIX,
  readCredentialKey,
  systemCredentialKeychain,
  wincredKeychain,
  type CredentialKeychain,
  type KeyringEntry,
} from "@tavi/runtime";

import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

/**
 * The credential key kept in the OS keychain. Every test here uses an
 * in-memory keychain: none runs `security` or `secret-tool`, and none
 * touches the developer's own keychain.
 */

const directories = temporaryDirectories();

afterEach(() => {
  directories.cleanup();
});

/** An in-memory keychain that records what it was asked, and can be made to refuse. */
function memoryKeychain(options: { readonly refuse?: boolean; readonly kind?: CredentialKeychain["kind"] } = {}) {
  const items = new Map<string, string>();
  const calls: string[] = [];
  const keychain: CredentialKeychain = {
    kind: options.kind ?? "macos",
    label: "the test keychain",
    async get(account) {
      calls.push(`get ${account}`);
      if (options.refuse === true) throw new Error("the keychain is locked");
      return items.get(account);
    },
    async add(account, secret) {
      calls.push(`add ${account}`);
      if (options.refuse === true) throw new Error("the keychain is locked");
      if (items.has(account)) throw new Error("duplicate item");
      items.set(account, secret);
    },
    async delete(account) {
      calls.push(`delete ${account}`);
      if (options.refuse === true) throw new Error("the keychain is locked");
      items.delete(account);
    },
  };
  return { keychain, items, calls };
}

function keyFileIn(): { readonly directory: string; readonly keyFile: string } {
  const parent = directories.create("tavi-keychain-");
  const directory = join(parent, "credentials");
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  return { directory, keyFile: join(parent, "credentials.key") };
}

describe("a credential key kept in the OS keychain", () => {
  it("stores the key in the keychain and only a reference in credentials.key", async () => {
    const { keyFile } = keyFileIn();
    const { keychain, items } = memoryKeychain();
    expect(await createKeychainCredentialKey(keyFile, keychain)).toBe("created");
    const [account, secret] = [...items][0] ?? [];
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = readFileSync(keyFile, "utf8");
    expect(onDisk).toBe(`tavi-keychain:v1:macos:${account}\n`);
    expect(onDisk).not.toContain(secret as string);
    expect(lstatSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(keyFile, ".."))).toEqual(["credentials", "credentials.key"]);
    expect((await readCredentialKey(keyFile, { keychain }))?.toString("hex")).toBe(secret);
    expect(await credentialKeyReference(keyFile)).toEqual({ kind: "macos", account });
  });

  it("encrypts and decrypts through the store with the keychain's key, reading the keychain once", async () => {
    const { directory, keyFile } = keyFileIn();
    const { keychain, calls } = memoryKeychain();
    await createKeychainCredentialKey(keyFile, keychain);
    const store = createEncryptedFileSecretStore({ directory, keyFile, keychain, access: "read-write" }) as unknown as {
      setSecret(keyRef: string, secret: string): Promise<void>;
      getSecret(keyRef: string): Promise<string | null>;
    };
    calls.length = 0;
    await store.setSecret("openai.apiKey", "sk-live-secret-value");
    expect(readFileSync(join(directory, "openai.apiKey"), "utf8").startsWith(ENCRYPTED_SECRET_PREFIX)).toBe(true);
    expect(await store.getSecret("openai.apiKey")).toBe("sk-live-secret-value");
    expect(await store.getSecret("openai.apiKey")).toBe("sk-live-secret-value");
    // Kept in memory since it was created: the keychain is not asked on every access.
    expect(calls).toEqual([]);
  });

  it("never replaces a key: an existing key file is left alone, and the keychain is not written", async () => {
    const { keyFile } = keyFileIn();
    expect(await createCredentialKey(keyFile)).toBe(true);
    const before = readFileSync(keyFile, "utf8");
    const { keychain, calls } = memoryKeychain();
    expect(await createKeychainCredentialKey(keyFile, keychain)).toBe("exists");
    expect(readFileSync(keyFile, "utf8")).toBe(before);
    expect(calls).toEqual([]);
  });

  it("gives every key an account of its own, so no two data directories share an item", async () => {
    const { keychain, items } = memoryKeychain();
    const first = keyFileIn();
    const second = keyFileIn();
    await createKeychainCredentialKey(first.keyFile, keychain);
    // The same path again (a directory reset, or a new one where a moved one was): a new item, not the old one.
    rmSync(first.keyFile);
    await createKeychainCredentialKey(first.keyFile, keychain);
    await createKeychainCredentialKey(second.keyFile, keychain);
    expect(items.size).toBe(3);
    const accounts = await Promise.all([first.keyFile, second.keyFile].map(async (file) => (await credentialKeyReference(file))?.account));
    expect(new Set(accounts).size).toBe(2);
  });

  it("deletes the item a reference names, and an item already gone is not an error", async () => {
    const { keyFile } = keyFileIn();
    const { keychain, items } = memoryKeychain();
    await createKeychainCredentialKey(keyFile, keychain);
    const reference = await credentialKeyReference(keyFile);
    if (reference === undefined) throw new Error("no reference");
    await deleteKeychainCredentialKey(reference, keychain);
    expect(items.size).toBe(0);
    await deleteKeychainCredentialKey(reference, keychain);
    // Gone from the cache too: the reference no longer reads.
    await expect(readCredentialKey(keyFile, { keychain })).rejects.toMatchObject({ message: expect.stringContaining("missing") });
  });

  it("writes nothing when the keychain refuses, so the caller can fall back", async () => {
    const { keyFile } = keyFileIn();
    const { keychain } = memoryKeychain({ refuse: true });
    expect(await createKeychainCredentialKey(keyFile, keychain)).toBe("unavailable");
    expect(readdirSync(join(keyFile, ".."))).toEqual(["credentials"]);
  });

  it("refuses, naming the item, when the keychain no longer holds the key", async () => {
    const { keyFile } = keyFileIn();
    const { keychain } = memoryKeychain();
    writeFileSync(keyFile, `tavi-keychain:v1:macos:${"0".repeat(32)}\n`, { mode: 0o600 });
    await expect(readCredentialKey(keyFile, { keychain })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringMatching(/test keychain.*account 0{32}.*missing/),
    });
  });

  it("refuses when the keychain cannot be read, and a reference it does not understand", async () => {
    const { keyFile } = keyFileIn();
    writeFileSync(keyFile, `tavi-keychain:v1:macos:${"0".repeat(32)}\n`, { mode: 0o600 });
    await expect(readCredentialKey(keyFile, { keychain: memoryKeychain({ refuse: true }).keychain })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("could not be read: the keychain is locked"),
    });
    await expect(readCredentialKey(keyFile, { keychain: memoryKeychain({ kind: "libsecret" }).keychain })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    for (const reference of ["tavi-keychain:v2:macos:abc", "tavi-keychain:v1:windows:" + "0".repeat(32), "tavi-keychain:v1:macos:x"]) {
      writeFileSync(keyFile, reference, { mode: 0o600 });
      await expect(readCredentialKey(keyFile, { keychain: memoryKeychain().keychain })).rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("form this build does not read"),
      });
    }
  });

  it("offers no system keychain when TAVI_CREDENTIAL_KEYCHAIN=off, or where there is none", () => {
    expect(systemCredentialKeychain({ TAVI_CREDENTIAL_KEYCHAIN: "off" }, "darwin")).toBeUndefined();
    expect(systemCredentialKeychain({ TAVI_CREDENTIAL_KEYCHAIN: "OFF" }, "linux")).toBeUndefined();
    expect(systemCredentialKeychain({ TAVI_CREDENTIAL_KEYCHAIN: "off" }, "win32")).toBeUndefined();
    expect(systemCredentialKeychain({}, "freebsd")).toBeUndefined();
    // Windows always has Credential Manager.
    expect(systemCredentialKeychain({}, "win32")?.kind).toBe("wincred");
    // Linux without a session bus has no Secret Service to answer.
    expect(systemCredentialKeychain({ PATH: "/usr/bin:/bin" }, "linux")).toBeUndefined();
    // The test run itself turns it off (vitest.config.ts), so no test reaches the real keychain by default.
    expect(systemCredentialKeychain()).toBeUndefined();
  });
});

describe("Windows Credential Manager as the keychain", () => {
  /** Credential Manager in memory, keyed by service and account, as `@napi-rs/keyring`'s entries reach it. */
  function memoryCredentials(): {
    readonly items: Map<string, string>;
    readonly entryOf: (service: string, account: string) => KeyringEntry;
  } {
    const items = new Map<string, string>();
    return {
      items,
      entryOf: (service, account) => {
        const key = `${service}/${account}`;
        return {
          getPassword: async () => items.get(key) ?? null,
          setPassword: async (password) => {
            items.set(key, password);
          },
          deleteCredential: async () => items.delete(key),
        };
      },
    };
  }

  it("stores a key under tavi's service, reads it back, and deletes it; one already gone is not an error", async () => {
    const credentials = memoryCredentials();
    const keychain = wincredKeychain(credentials.entryOf);
    expect(keychain.kind).toBe("wincred");
    expect(await keychain.get("data-1")).toBeUndefined();
    await keychain.add("data-1", "secret-key");
    expect([...credentials.items.keys()]).toEqual(["tavi-credential-key/data-1"]);
    expect(await keychain.get("data-1")).toBe("secret-key");
    await keychain.delete("data-1");
    expect(await keychain.get("data-1")).toBeUndefined();
    await expect(keychain.delete("data-1")).resolves.toBeUndefined();
  });

  it("never replaces an item that exists", async () => {
    const credentials = memoryCredentials();
    const keychain = wincredKeychain(credentials.entryOf);
    await keychain.add("data-1", "first");
    await expect(keychain.add("data-1", "second")).rejects.toThrow(/already holds/);
    expect(await keychain.get("data-1")).toBe("first");
  });

  it("gives up on a Credential Manager that does not answer, and says so", async () => {
    const silent = new Promise<never>(() => undefined);
    const hung: KeyringEntry = { getPassword: () => silent, setPassword: () => silent, deleteCredential: () => silent };
    const keychain = wincredKeychain(() => hung, 20);
    await expect(keychain.get("data-1")).rejects.toThrow(/did not answer within 20 ms/);
    await expect(keychain.add("data-1", "key")).rejects.toThrow(/did not answer/);
    await expect(keychain.delete("data-1")).rejects.toThrow(/did not answer/);
  });
});
