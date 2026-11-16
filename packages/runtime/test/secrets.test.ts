import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { TaviError } from "@tavi/contracts";
import {
  asSecretReader,
  createChainedSecretStore,
  createCredentialKey,
  createEncryptedFileSecretStore,
  createEnvironmentSecretStore,
  createFileSecretStore,
  ENCRYPTED_SECRET_PREFIX,
  readCredentialKey,
  createSecretReader,
  createSessionSecretStore,
  describeSecretStore,
} from "@tavi/runtime";

import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

/**
 * Headless secret sources.
 *
 * The properties under test are the ones an operator depends on: an absent
 * reference is distinguishable from an unreadable one, mutability is a backend
 * capability rather than an always-throwing setter, another account cannot read
 * the credential file, and no message carries the value.
 */

const directories = temporaryDirectories();

afterEach(() => {
  directories.cleanup();
});

function credentialDirectory(mode = 0o700): string {
  const parent = directories.create("tavi-secrets-");
  const directory = join(parent, "credentials");
  mkdirSync(directory, { mode });
  chmodSync(directory, mode);
  return directory;
}

function credentialFile(directory: string, name: string, value: string, mode = 0o600): string {
  const path = join(directory, name);
  writeFileSync(path, value, { mode });
  chmodSync(path, mode);
  return path;
}

describe("file secret store", () => {
  it("resolves a private credential file and treats an absent reference as null", async () => {
    const directory = credentialDirectory();
    credentialFile(directory, "openai.apiKey", "sk-from-file\n");
    const store = createFileSecretStore({ directory });
    expect(store.access).toBe("read-only");
    await expect(store.getSecret("openai.apiKey")).resolves.toBe("sk-from-file");
    // Absent is not an error: the operator may simply not have bound it.
    await expect(store.getSecret("unbound.ref")).resolves.toBeNull();
  });

  it("distinguishes a missing directory from an absent credential", async () => {
    const parent = directories.create("tavi-secrets-");
    const store = createFileSecretStore({ directory: join(parent, "not-created") });
    // A declared source that is not there must fail clearly in unattended mode.
    await expect(store.getSecret("openai.apiKey")).rejects.toThrowError(/directory does not exist/);
  });

  it("refuses an empty credential file with the operator's likely mistake named", async () => {
    const directory = credentialDirectory();
    credentialFile(directory, "openai.apiKey", "   \n");
    const store = createFileSecretStore({ directory });
    await expect(store.getSecret("openai.apiKey")).rejects.toThrowError(/file that is empty/);
  });

  it("refuses a credential readable by other users, and a symlinked one", async () => {
    const directory = credentialDirectory();
    credentialFile(directory, "openai.apiKey", "sk-loose", 0o644);
    const store = createFileSecretStore({ directory });
    await expect(store.getSecret("openai.apiKey")).rejects.toThrowError(/readable by other users/);

    // A symlink is refused rather than followed: following it would resolve
    // whatever the link points at, possibly outside the credential directory.
    rmSync(join(directory, "openai.apiKey"));
    const target = join(directory, "elsewhere");
    credentialFile(directory, "elsewhere", "sk-target");
    symlinkSync(target, join(directory, "openai.apiKey"));
    await expect(store.getSecret("openai.apiKey")).rejects.toThrowError(/symlink/);
  });

  it("refuses a credential directory other users can reach", async () => {
    const directory = credentialDirectory(0o755);
    credentialFile(directory, "openai.apiKey", "sk-loose");
    const store = createFileSecretStore({ directory });
    await expect(store.getSecret("openai.apiKey")).rejects.toThrowError(/directory is accessible to other users/);
  });

  it("refuses a dangling symlink instead of reporting it as absent", async () => {
    const directory = credentialDirectory();
    symlinkSync(join(directory, "does-not-exist"), join(directory, "openai.apiKey"));
    const store = createFileSecretStore({ directory });
    // `existsSync` (which follows links) would call this absent and silently
    // ignore a planted link; the store must refuse it.
    await expect(store.getSecret("openai.apiKey")).rejects.toThrowError(/symlink/);
  });

  it("refuses a reference that is not an opaque slug", async () => {
    const directory = credentialDirectory();
    const store = createFileSecretStore({ directory });
    for (const keyRef of ["../escape", "/etc/passwd", "OPENAI_API_KEY", "has space", ""]) {
      await expect(store.getSecret(keyRef)).rejects.toThrowError(/Invalid credential reference/);
    }
  });

  it("has no write surface when read-only, and writes 0600 when writable", async () => {
    const directory = credentialDirectory();
    const readOnly = createFileSecretStore({ directory });
    expect("setSecret" in readOnly).toBe(false);

    const writable = createFileSecretStore({ directory, access: "read-write" });
    if (writable.access !== "read-write") throw new Error("expected a writable store");
    await writable.setSecret("openai.apiKey", "sk-written");
    expect(lstatSync(join(directory, "openai.apiKey")).mode & 0o777).toBe(0o600);
    await expect(writable.getSecret("openai.apiKey")).resolves.toBe("sk-written");

    await writable.setSecret("openai.apiKey", "sk-rotated");
    await expect(writable.getSecret("openai.apiKey")).resolves.toBe("sk-rotated");

    await writable.deleteSecret("openai.apiKey");
    await expect(writable.getSecret("openai.apiKey")).resolves.toBeNull();

    // An empty secret is a mistake, not a way to clear a value.
    await expect(writable.setSecret("openai.apiKey", "")).rejects.toThrowError(/empty value/);
  });

  it("leaves no temporary file behind when a write fails, and reports a typed error", async () => {
    const parent = directories.create("tavi-secrets-");
    const directory = join(parent, "credentials");
    mkdirSync(directory, { mode: 0o700 });
    const writable = createFileSecretStore({ directory, access: "read-write" });
    if (writable.access !== "read-write") throw new Error("expected a writable store");

    // A directory where the credential file should be makes the final rename
    // fail; the temporary file must not survive it.
    mkdirSync(join(directory, "openai.apiKey"));
    const failure = await writable.setSecret("openai.apiKey", "sk-secret").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TaviError);
    expect(String(failure)).not.toContain("sk-secret");
    // Only the blocking directory is left: no temporary file beside it.
    expect(readdirSync(directory)).toEqual(["openai.apiKey"]);
  });
});

describe("session secret store", () => {
  it("holds transient values and never echoes them in an error", async () => {
    const store = createSessionSecretStore({ "openai.apiKey": "sk-session" });
    if (store.access !== "read-write") throw new Error("the session store is writable by design");
    await expect(store.getSecret("openai.apiKey")).resolves.toBe("sk-session");
    await expect(store.getSecret("other.ref")).resolves.toBeNull();

    await store.setSecret("other.ref", "sk-other");
    await expect(store.getSecret("other.ref")).resolves.toBe("sk-other");
    await store.deleteSecret("other.ref");
    await expect(store.getSecret("other.ref")).resolves.toBeNull();

    const failure = await store.setSecret("bad ref", "sk-secret-value").catch((error: unknown) => error);
    expect(String(failure)).not.toContain("sk-secret-value");
    expect(String(failure)).toContain("Invalid credential reference");
  });

  it("ignores empty initial values rather than reporting them as present", async () => {
    const store = createSessionSecretStore({ "openai.apiKey": "" });
    await expect(store.getSecret("openai.apiKey")).resolves.toBeNull();
  });
});

describe("environment secret store", () => {
  it("reads only the named bindings, and reports a declared-but-unset variable", async () => {
    const store = createEnvironmentSecretStore({
      bindings: { "openai.apiKey": "TAVI_TEST_KEY" },
      env: { TAVI_TEST_KEY: "from-env", OPENAI_API_KEY: "ambient-should-be-ignored" },
    });
    await expect(store.getSecret("openai.apiKey")).resolves.toBe("from-env");
    // A reference with no named binding is absent — the ambient provider
    // variable is never consulted.
    await expect(store.getSecret("ambient")).resolves.toBeNull();

    const declaredButUnset = createEnvironmentSecretStore({
      bindings: { "openai.apiKey": "TAVI_ABSENT" },
      env: {},
    });
    await expect(declaredButUnset.getSecret("openai.apiKey")).rejects.toThrowError(/not set/);
  });
});

describe("capability metadata", () => {
  it("describes the source without leaking a path or a value", () => {
    const directory = credentialDirectory();
    const capability = describeSecretStore(createFileSecretStore({ directory }), "file");
    expect(capability).toEqual({
      access: "read-only",
      kind: "file",
      writable: false,
      description: expect.stringContaining("read-only"),
    });
    expect(JSON.stringify(capability)).not.toContain(directory);
    expect(describeSecretStore(createSessionSecretStore(), "session").writable).toBe(true);
  });

  it("narrows a store to the read interface the model adapter needs", async () => {
    const reader = asSecretReader(createSessionSecretStore({ k: "v" }));
    expect(Object.keys(reader)).toEqual(["getSecret"]);
    await expect(reader.getSecret("k")).resolves.toBe("v");
  });
});

describe("chained sources", () => {
  it("takes the first source that has the reference and reports the chain", async () => {
    const directory = credentialDirectory();
    credentialFile(directory, "openai.apiKey", "from-file");
    const chain = createChainedSecretStore([
      createFileSecretStore({ directory }),
      createSessionSecretStore({ "openai.apiKey": "from-session", "other.ref": "only-session" }),
    ]);
    await expect(chain.getSecret("openai.apiKey")).resolves.toBe("from-file");
    await expect(chain.getSecret("other.ref")).resolves.toBe("only-session");
    await expect(chain.getSecret("absent.ref")).resolves.toBeNull();
    expect(describeSecretStore(chain, "chain")).toEqual({
      access: "read-only",
      kind: "chain",
      writable: false,
      description: expect.stringContaining("credential directory"),
    });
  });

  it("deletes from every writable source, and refuses a write an earlier read-only source would shadow", async () => {
    const first = createSessionSecretStore({ "openai.apiKey": "first" });
    const second = createSessionSecretStore({ "openai.apiKey": "second" });
    const chain = createChainedSecretStore([first, second]);
    if (chain.access !== "read-write") throw new Error("two writable sources make a writable chain");
    await expect(chain.getSecret("openai.apiKey")).resolves.toBe("first");

    // Deleting only from the first source would report success while the second
    // still served the credential.
    await chain.deleteSecret("openai.apiKey");
    await expect(first.getSecret("openai.apiKey")).resolves.toBeNull();
    await expect(second.getSecret("openai.apiKey")).resolves.toBeNull();
    await expect(chain.getSecret("openai.apiKey")).resolves.toBeNull();
  });

  it("has no write surface when any source is read-only", async () => {
    const directory = credentialDirectory();
    credentialFile(directory, "openai.apiKey", "from-file");
    const chain = createChainedSecretStore([createFileSecretStore({ directory }), createSessionSecretStore()]);
    expect(chain.access).toBe("read-only");
    expect("deleteSecret" in chain).toBe(false);
  });

  it("treats only a genuinely absent directory as absent in a chain", async () => {
    const parent = directories.create("tavi-secrets-");
    // A dangling symlink at the credential-directory path must not be mistaken
    // for "not here", which would fall through to a weaker source.
    const planted = join(parent, "credentials");
    symlinkSync(join(parent, "nowhere"), planted);
    const chain = createChainedSecretStore([
      createFileSecretStore({ directory: planted, missingDirectory: "absent" }),
      createSessionSecretStore({ "openai.apiKey": "from-session" }),
    ]);
    await expect(chain.getSecret("openai.apiKey")).rejects.toThrowError(/symlink|not a directory/);
  });

  it("falls through when the injected directory is genuinely absent", async () => {
    const parent = directories.create("tavi-secrets-");
    const chain = createChainedSecretStore([
      createFileSecretStore({ directory: join(parent, "credentials"), missingDirectory: "absent" }),
      createSessionSecretStore({ "openai.apiKey": "from-session" }),
    ]);
    await expect(chain.getSecret("openai.apiKey")).resolves.toBe("from-session");
  });

  it("stops at a source that fails loudly instead of falling through", async () => {
    const directory = credentialDirectory();
    // An unsafe mode in the first source is a misconfiguration: silently using
    // the second source would hide it and use a different credential.
    credentialFile(directory, "openai.apiKey", "from-file", 0o644);
    const chain = createChainedSecretStore([
      createFileSecretStore({ directory }),
      createSessionSecretStore({ "openai.apiKey": "from-session" }),
    ]);
    await expect(chain.getSecret("openai.apiKey")).rejects.toThrowError(/readable by other users/);
  });
});

describe("typed failures", () => {
  it("uses a TaviError code so a caller can distinguish refusal from absence", async () => {
    const directory = credentialDirectory();
    const store = createFileSecretStore({ directory });
    const failure = await store.getSecret("../escape").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TaviError);
    expect((failure as TaviError).code).toBe("INVALID_INPUT");
  });
});

describe("the credential store encrypted at rest", () => {
  const KEY = "a".repeat(64);
  /** A credentials directory beside its key file, the key written with `mode`. */
  function encrypted(key: string | null = KEY, mode = 0o600) {
    const directory = credentialDirectory();
    const keyFile = join(directory, "..", "credentials.key");
    if (key !== null) {
      writeFileSync(keyFile, `${key}\n`, { mode });
      chmodSync(keyFile, mode);
    }
    const store = createEncryptedFileSecretStore({ directory, keyFile, access: "read-write" }) as ReturnType<
      typeof createFileSecretStore
    > & {
      setSecret(keyRef: string, secret: string): Promise<void>;
      deleteSecret(keyRef: string): Promise<void>;
    };
    return { directory, keyFile, store };
  }
  const onDisk = (directory: string, reference: string) => readFileSync(join(directory, reference), "utf8");

  it("writes a value encrypted once the key exists, reads it back, and never stores it in the clear", async () => {
    const { directory, store } = encrypted();
    await store.setSecret("openai.apiKey", "sk-live-secret-value");
    const stored = onDisk(directory, "openai.apiKey");
    expect(stored.startsWith(ENCRYPTED_SECRET_PREFIX)).toBe(true);
    expect(stored).not.toContain("sk-live");
    expect(lstatSync(join(directory, "openai.apiKey")).mode & 0o777).toBe(0o600);
    expect(await store.getSecret("openai.apiKey")).toBe("sk-live-secret-value");
    // A fresh IV each time: the same value is never the same bytes twice.
    await store.setSecret("again.apiKey", "sk-live-secret-value");
    expect(onDisk(directory, "again.apiKey")).not.toBe(stored);
  });

  it("reads a plain value as before, and writes plain while there is no key", async () => {
    const { directory, store } = encrypted(null);
    await store.setSecret("plain.key", "value-1");
    expect(onDisk(directory, "plain.key")).toBe("value-1");
    expect(await store.getSecret("plain.key")).toBe("value-1");
    expect(await store.getSecret("absent.key")).toBeNull();
  });

  it("binds each value to its reference: a file renamed to another is refused, as is one altered", async () => {
    const { directory, keyFile, store } = encrypted();
    await store.setSecret("first.key", "value-1");
    writeFileSync(join(directory, "second.key"), onDisk(directory, "first.key"), { mode: 0o600 });
    await expect(store.getSecret("second.key")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining(`could not be decrypted with ${keyFile}`),
    });
    const tampered = onDisk(directory, "first.key").slice(0, -4) + "AAAA";
    writeFileSync(join(directory, "first.key"), tampered, { mode: 0o600 });
    await expect(store.getSecret("first.key")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("refuses a key of the wrong length, naming the file, and never regenerates it", async () => {
    const { keyFile, store, directory } = encrypted("abcd");
    writeFileSync(join(directory, "some.key"), `${ENCRYPTED_SECRET_PREFIX}AAAA`, { mode: 0o600 });
    await expect(store.getSecret("some.key")).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining(keyFile) });
    await expect(store.setSecret("new.key", "v")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("never regenerated"),
    });
    expect(readFileSync(keyFile, "utf8")).toBe("abcd\n");
  });

  it("refuses a symlinked key, and one other accounts can read", async () => {
    const { keyFile, store } = encrypted();
    const elsewhere = `${keyFile}.real`;
    writeFileSync(elsewhere, KEY, { mode: 0o600 });
    rmSync(keyFile);
    symlinkSync(elsewhere, keyFile);
    await expect(store.setSecret("x.key", "v")).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
      message: expect.stringContaining("symlink"),
    });
    const shared = encrypted(KEY, 0o640);
    await expect(shared.store.setSecret("x.key", "v")).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
      message: expect.stringContaining("readable by other users"),
    });
  });

  it("says an encrypted value needs its key when the key is gone", async () => {
    const { keyFile, store } = encrypted();
    await store.setSecret("gone.key", "value");
    rmSync(keyFile);
    await expect(store.getSecret("gone.key")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("a new key cannot read"),
    });
  });

  it("refuses another version's ciphertext, and a plain value that would read as ciphertext", async () => {
    const { directory, store } = encrypted();
    writeFileSync(join(directory, "future.key"), "tavi-enc:v2:AAAA", { mode: 0o600 });
    await expect(store.getSecret("future.key")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("tavi-enc:v2:"),
    });
    const plain = encrypted(null);
    await expect(plain.store.setSecret("odd.key", "tavi-enc:not-a-secret")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // With a key, the same value is simply encrypted, and reads back.
    await store.setSecret("odd.key", "tavi-enc:not-a-secret");
    expect(await store.getSecret("odd.key")).toBe("tavi-enc:not-a-secret");
  });

  it("reads a key written with a line ending, spaces or upper case, and trims a value as a plain read does", async () => {
    for (const written of [`${KEY}\r\n`, `  ${KEY}  `, KEY.toUpperCase()]) {
      const { store } = encrypted(written);
      await store.setSecret("v.key", "  padded value \n");
      expect(await store.getSecret("v.key")).toBe("padded value");
    }
  });

  it("creates the key once, whole, and never over another", async () => {
    const parent = directories.create("tavi-key-");
    const keyFile = join(parent, "credentials.key");
    expect(await createCredentialKey(keyFile)).toBe(true);
    const first = readFileSync(keyFile, "utf8");
    expect(first).toMatch(/^[0-9a-f]{64}\n$/);
    expect(lstatSync(keyFile).mode & 0o777).toBe(0o600);
    expect(await createCredentialKey(keyFile)).toBe(false);
    expect(readFileSync(keyFile, "utf8")).toBe(first);
    // Racing: exactly one wins, and no temporary is left.
    const race = directories.create("tavi-key-");
    const raced = await Promise.all(Array.from({ length: 8 }, () => createCredentialKey(join(race, "credentials.key"))));
    expect(raced.filter(Boolean)).toHaveLength(1);
    expect(readdirSync(race)).toEqual(["credentials.key"]);
  });

  it("refuses a key that is not a file", async () => {
    const parent = directories.create("tavi-key-");
    mkdirSync(join(parent, "credentials.key"), { mode: 0o700 });
    await expect(readCredentialKey(join(parent, "credentials.key"))).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("refuses a key other accounts can read, naming its mode", async () => {
    const parent = directories.create("tavi-key-");
    const key = join(parent, "credentials.key");
    writeFileSync(key, "x".repeat(64), { mode: 0o644 });
    chmodSync(key, 0o644);
    await expect(readCredentialKey(key)).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
      message: expect.stringContaining("readable by other users (mode 644); expected 600"),
    });
  });
});

describe("a credential bound from a file", () => {
  it("refuses ciphertext as the value: it would be sent as the key", async () => {
    const directory = credentialDirectory();
    const file = join(directory, "bound");
    writeFileSync(file, "tavi-enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", { mode: 0o600 });
    const reader = createSecretReader({ bindings: { "model.key": { fromFile: file } } });
    await expect(reader.getSecret("model.key")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("encrypted credential"),
    });
  });
});
