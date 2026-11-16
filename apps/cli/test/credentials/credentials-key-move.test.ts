import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createEncryptedFileSecretStore, type CredentialKeychain } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import {
  createLocalCredentialStore,
  credentialKeyLocation,
  encryptCredentialDirectory,
  moveCredentialKey,
} from "../../src/features/credentials/store.js";
import { memoryKeychain } from "../support/memory-keychain.js";

/**
 * Moving the credential key between the OS keychain and `credentials.key`.
 * A key kept in the keychain does not travel with a backup, and a system
 * service cannot read it; `tavi credentials key --to-file` moves the same key
 * into the file, re-encrypting nothing. Every keychain here is in memory: no
 * test runs `security` or `secret-tool`.
 */

const directories = temporaryDirectories({ prefix: "tavi-key-move-" });

afterEach(() => {
  directories.cleanup();
});

/** A data directory encrypted under a key in `keychain`, holding one credential. */
async function encryptedInKeychain(keychain: CredentialKeychain): Promise<string> {
  const directory = directories.create();
  await encryptCredentialDirectory(directory, keychain);
  // Written through the in-memory keychain: the local store would ask the real one.
  const store = createEncryptedFileSecretStore({
    directory: join(directory, "credentials"),
    keyFile: join(directory, "credentials.key"),
    access: "read-write",
    missingDirectory: "absent",
    keychain,
  });
  if (store.access !== "read-write") throw new Error("expected a writable store");
  await store.setSecret("acme.token", "s3cret-value");
  return directory;
}

const credentialFile = (directory: string): string => readFileSync(join(directory, "credentials", "acme.token"), "utf8");

describe("moving the credential key into its file", () => {
  it("writes the same key 0600, deletes the keychain item after, and every credential still reads", async () => {
    const { keychain, items } = memoryKeychain();
    const directory = await encryptedInKeychain(keychain);
    const [stored] = [...items.values()];
    const ciphertext = credentialFile(directory);

    const result = await moveCredentialKey(directory, "file", keychain);

    expect(result).toMatchObject({ to: "file", moved: true, keychain: "the test keychain" });
    const keyFile = join(directory, "credentials.key");
    expect(readFileSync(keyFile, "utf8")).toBe(`${stored}\n`);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(items.size).toBe(0);
    // Nothing was re-encrypted: the stored ciphertext is byte for byte the same.
    expect(credentialFile(directory)).toBe(ciphertext);
    expect(await createLocalCredentialStore(directory).getSecret("acme.token")).toBe("s3cret-value");
    expect(await credentialKeyLocation(directory)).toMatchObject({ kept: "file" });
    // A second run is a no-op.
    expect(await moveCredentialKey(directory, "file", keychain)).toMatchObject({ moved: false });
  });

  it("restores on another machine: the data directory and its key file, copied, read with no keychain at all", async () => {
    const { keychain } = memoryKeychain();
    const directory = await encryptedInKeychain(keychain);
    await moveCredentialKey(directory, "file", keychain);
    // The backup's restore: the credentials directory and credentials.key, to a machine whose keychain never held the item.
    const restored = directories.create();
    mkdirSync(join(restored, "credentials"), { mode: 0o700 });
    writeFileSync(join(restored, "credentials", "acme.token"), credentialFile(directory), { mode: 0o600 });
    writeFileSync(join(restored, "credentials.key"), readFileSync(join(directory, "credentials.key")), { mode: 0o600 });
    expect(await createLocalCredentialStore(restored).getSecret("acme.token")).toBe("s3cret-value");
  });

  it("changes nothing when the keychain cannot be read", async () => {
    const { keychain, items } = memoryKeychain();
    const directory = await encryptedInKeychain(keychain);
    const reference = readFileSync(join(directory, "credentials.key"), "utf8");
    // A fresh process: nothing cached, and the keychain locked.
    const locked = memoryKeychain({ refuse: true }).keychain;
    await expect(moveCredentialKey(directory, "file", locked)).rejects.toThrow(/could not be read/);
    expect(readFileSync(join(directory, "credentials.key"), "utf8")).toBe(reference);
    expect(items.size).toBe(1);
  });

  it("keeps the file when the keychain item cannot be deleted, and says so", async () => {
    const { keychain, items } = memoryKeychain();
    const directory = await encryptedInKeychain(keychain);
    const stubborn: CredentialKeychain = {
      ...keychain,
      async delete() {
        throw new Error("denied");
      },
    };
    const result = await moveCredentialKey(directory, "file", stubborn);
    expect(result).toMatchObject({ moved: true, deleteError: "denied" });
    expect(items.size).toBe(1);
    expect(await createLocalCredentialStore(directory).getSecret("acme.token")).toBe("s3cret-value");
  });

  it("refuses a directory with no key", async () => {
    const { keychain } = memoryKeychain();
    await expect(moveCredentialKey(directories.create(), "file", keychain)).rejects.toThrow(/no credential key/);
  });
});

describe("moving the credential key into the keychain", () => {
  it("stores the same key under a new item, and the file then only refers to it", async () => {
    const directory = directories.create();
    await encryptCredentialDirectory(directory, undefined);
    await createLocalCredentialStore(directory).setSecret("acme.token", "s3cret-value");
    const key = readFileSync(join(directory, "credentials.key"), "utf8").trim();
    const ciphertext = credentialFile(directory);
    const { keychain, items } = memoryKeychain();

    const result = await moveCredentialKey(directory, "keychain", keychain);

    expect(result).toMatchObject({ to: "keychain", moved: true });
    expect([...items.values()]).toEqual([key]);
    expect(readFileSync(join(directory, "credentials.key"), "utf8")).toMatch(/^tavi-keychain:v1:macos:[0-9a-f]{32}\n$/);
    expect(credentialFile(directory)).toBe(ciphertext);
    expect(await credentialKeyLocation(directory)).toMatchObject({ kept: "keychain" });
    // And back again, to the same key.
    await moveCredentialKey(directory, "file", keychain);
    expect(readFileSync(join(directory, "credentials.key"), "utf8").trim()).toBe(key);
    expect(await createLocalCredentialStore(directory).getSecret("acme.token")).toBe("s3cret-value");
  });

  it("leaves the key file as it was when the keychain refuses", async () => {
    const directory = directories.create();
    await encryptCredentialDirectory(directory, undefined);
    const before = readFileSync(join(directory, "credentials.key"), "utf8");
    await expect(moveCredentialKey(directory, "keychain", memoryKeychain({ refuse: true }).keychain)).rejects.toThrow(/stays in/);
    expect(readFileSync(join(directory, "credentials.key"), "utf8")).toBe(before);
  });
});

describe("tavi credentials key", () => {
  it("says where the key is kept, never printing it", async () => {
    const directory = directories.create();
    await encryptCredentialDirectory(directory, undefined);
    const key = readFileSync(join(directory, "credentials.key"), "utf8").trim();
    const printed = capture();
    expect(await main(["credentials", "key", "--data-dir", directory], { io: printed.io })).toBe(EXIT.ok);
    expect(printed.stdout()).toContain("credentials.key");
    // One instruction, not two that cancel out: keep a copy, but not with the directory's backups.
    expect(printed.stdout()).toContain("keep a copy of it, but not with the data directory's backups");
    expect(printed.stdout() + printed.stderr()).not.toContain(key);
  });

  it("refuses --to-file with --to-keychain, and a credential reference", async () => {
    const both = capture();
    expect(await main(["credentials", "key", "--to-file", "--to-keychain"], { io: both.io })).toBe(EXIT.usage);
    expect(both.stderr()).toMatch(/not both/);
    const named = capture();
    expect(await main(["credentials", "key", "acme.token"], { io: named.io })).toBe(EXIT.usage);
  });

  it("refuses --to-keychain where there is no keychain, leaving the file", async () => {
    const directory = directories.create();
    await encryptCredentialDirectory(directory, undefined);
    const before = readFileSync(join(directory, "credentials.key"), "utf8");
    const previous = process.env["TAVI_CREDENTIAL_KEYCHAIN"];
    process.env["TAVI_CREDENTIAL_KEYCHAIN"] = "off";
    try {
      const printed = capture();
      expect(await main(["credentials", "key", "--to-keychain", "--data-dir", directory], { io: printed.io })).not.toBe(EXIT.ok);
      expect(printed.stderr()).toMatch(/no OS keychain/);
    } finally {
      if (previous === undefined) delete process.env["TAVI_CREDENTIAL_KEYCHAIN"];
      else process.env["TAVI_CREDENTIAL_KEYCHAIN"] = previous;
    }
    expect(readFileSync(join(directory, "credentials.key"), "utf8")).toBe(before);
  });
});
