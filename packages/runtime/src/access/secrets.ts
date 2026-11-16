import {
  TaviError,
  assertSecretKeyRef,
  type SecretReaderPort,
  type SecretSourceCapability,
  type SecretSourceKind,
  type SecretStorePort,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { NoFollowReadError, privacyProblem, privateExpectation, readNoFollow, writeFileAtomicAsync } from "@tavi/node-kit";
import {
  CREDENTIAL_KEYCHAIN_KINDS,
  CREDENTIAL_KEYCHAIN_SERVICE,
  credentialKeychainOfKind,
  type CredentialKeychain,
  type CredentialKeychainKind,
} from "./keychain.js";

/**
 * Headless secret sources.
 *
 * The launcher supplies a non-Electron `SecretStore`: explicit per-connection
 * references to service-manager-injected credential files, or transient session
 * values. Three rules shape the implementation:
 *
 *  - **`null` means absent.** A reference that resolves to nothing is reported as
 *    absent; a source that *was* declared but cannot be read — a missing
 *    directory, an unsafe mode, a symlink, an empty file — is a typed error, so
 *    unattended mode fails clearly instead of looking unconfigured;
 *  - **mutability is in the type.** Rotation of a service-manager file is the
 *    service manager's job, so the file store is read-only by default and refuses
 *    a write with a typed error; the session store is writable because its
 *    contents are transient;
 *  - **no secret reaches a message.** Errors name the reference and the remedy,
 *    never the value.
 */

export interface FileSecretStoreOptions {
  /**
   * Directory holding one file per reference, injected by the service manager
   * (systemd `LoadCredential=`). It must be private to the service identity.
   */
  readonly directory: string;
  /** `read-write` permits `setSecret`/`deleteSecret`; the default is read-only. */
  readonly access?: "read-only" | "read-write";
  /**
   * What an absent credential directory means.
   *
   * `error` (the default) is right when this directory is the declared source: a
   * service that was told to read injected credentials must say they are missing.
   * `absent` is right when the store is one link in a chain, where a directory the
   * service manager did not create simply means "not here — check the next
   * source". A directory that exists but is unsafe is an error in both modes.
   */
  readonly missingDirectory?: "error" | "absent";
}

const SAFE_DIRECTORY_MODE = 0o700;
const SAFE_FILE_MODE = 0o600;

/**
 * A credential directory provided by the service manager.
 *
 * Read-only by default: an external rotation is applied by the service manager
 * and picked up on reload/restart, not by pretending `setSecret` can write an
 * injected file.
 */
export function createFileSecretStore(options: FileSecretStoreOptions): SecretStorePort {
  const access = options.access ?? "read-only";
  const read = async (keyRef: string): Promise<string | null> => {
    if (options.missingDirectory === "absent" && (await pathIsAbsent(options.directory))) return null;
    const directory = await resolveSecretDirectory(options.directory);
    const path = await resolveExistingSecretFile(directory, assertKeyRef(keyRef));
    if (path === null) return null;
    const { readFile } = await import("node:fs/promises");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      throw new TaviError(
        "UNAVAILABLE",
        `Credential reference ${keyRef} could not be read from the configured credential directory: ${errorMessage(error)}`,
        { details: { keyRef } },
      );
    }
    const value = raw.trim();
    if (value === "") {
      // A declared source with no value is a misconfiguration, not an absent
      // credential: `printf %s "$UNSET" > file` is the usual cause.
      throw new TaviError(
        "UNAVAILABLE",
        `Credential reference ${keyRef} is bound to a file that is empty. Check that the variable it was ` +
          'written from is set (for example `printf %s "$OPENAI_API_KEY" > file` writes an empty file when unset).',
        { details: { keyRef } },
      );
    }
    return value;
  };

  if (access === "read-only") {
    return { access, getSecret: read };
  }

  return {
    access,
    getSecret: read,
    async setSecret(keyRef: string, secret: string): Promise<void> {
      const name = assertKeyRef(keyRef);
      if (secret === "") {
        throw new TaviError("INVALID_INPUT", `Refusing to store an empty value for ${name}`);
      }
      const directory = await resolveSecretDirectory(options.directory, { create: true });
      const path = joinPath(directory, name);
      // Written 0600 through a temporary file and renamed, so a reader never sees
      // a partial value and the mode is correct from the first instant it exists;
      // the temporary file is removed when any step fails.
      try {
        await writeFileAtomicAsync(path, secret, { mode: SAFE_FILE_MODE });
      } catch (error) {
        throw new TaviError("UNAVAILABLE", `Could not store credential reference ${name}: ${errorMessage(error)}`, {
          details: { keyRef: name },
        });
      }
    },
    async deleteSecret(keyRef: string): Promise<void> {
      const name = assertKeyRef(keyRef);
      const directory = await resolveSecretDirectory(options.directory);
      const path = await resolveExistingSecretFile(directory, name);
      if (path === null) return;
      const { unlink } = await import("node:fs/promises");
      await unlink(path);
    },
  };
}

/** What every encrypted credential file begins with, whatever its format's version. */
export const ENCRYPTED_SECRET_FAMILY = "tavi-enc:";
/** The one version this build writes and reads; a file without the family prefix is plain text, read as before. */
export const ENCRYPTED_SECRET_PREFIX = `${ENCRYPTED_SECRET_FAMILY}v1:`;

/** The length of the at-rest key, in bytes: AES-256. */
export const CREDENTIAL_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedFileSecretStoreOptions extends FileSecretStoreOptions {
  /**
   * The at-rest key: `<data-dir>/credentials.key`, 64 hex characters, `0600`,
   * not a symlink — the same checks a credential file gets. Absent, values are
   * written in plain text and only plain files are readable. It may instead
   * name a key kept in the OS keychain (`createKeychainCredentialKey`).
   */
  readonly keyFile: string;
  /** The keychain a key the file refers to is read from; by default the one its reference names. Tests inject one. */
  readonly keychain?: CredentialKeychain;
}

type WritableStore = SecretStorePort & {
  readonly access: "read-write";
  setSecret(keyRef: string, secret: string): Promise<void>;
  deleteSecret(keyRef: string): Promise<void>;
};
const isWritable = (store: SecretStorePort): store is WritableStore =>
  store.access === "read-write" &&
  typeof (store as { setSecret?: unknown }).setSecret === "function" &&
  typeof (store as { deleteSecret?: unknown }).deleteSecret === "function";

/**
 * The credential directory, optionally encrypted at rest: AES-256-GCM with a fresh 12-byte IV per value, a 16-byte tag,
 * the reference name as additional data (a file renamed to another reference
 * does not decrypt), and the key in its own file beside the directory.
 *
 * The benefit is narrow and stated: a copy of `credentials/` without the key
 * does not yield the values. A process running as the operator reads both,
 * and is outside the threat model either way. Plain files stay readable, so a
 * directory can be encrypted in place (`tavi credentials encrypt`); once the
 * key exists every new value is written encrypted. A key of the wrong length
 * is refused, naming the file — never regenerated, which would orphan every
 * value it wrote. The key is read on every access, not cached: `tavi
 * credentials encrypt` may create it while an owner runs.
 */
export function createEncryptedFileSecretStore(options: EncryptedFileSecretStoreOptions): SecretStorePort {
  const inner = createFileSecretStore(options);
  const keyOptions = options.keychain === undefined ? {} : { keychain: options.keychain };
  const getSecret = async (keyRef: string): Promise<string | null> => {
    const raw = await inner.getSecret(keyRef);
    if (raw === null || !raw.startsWith(ENCRYPTED_SECRET_FAMILY)) return raw;
    if (!raw.startsWith(ENCRYPTED_SECRET_PREFIX)) {
      // Another version's ciphertext — a newer tavi wrote it — is never taken for a plain value and sent.
      throw new TaviError(
        "UNAVAILABLE",
        `Credential reference ${keyRef} is encrypted in a format this build does not read (${raw.slice(0, raw.indexOf(":", ENCRYPTED_SECRET_FAMILY.length) + 1)}); use the tavi that wrote it`,
        { details: { keyRef } },
      );
    }
    const key = await readCredentialKey(options.keyFile, keyOptions);
    if (key === undefined) {
      throw new TaviError(
        "UNAVAILABLE",
        `Credential reference ${keyRef} is encrypted, but the key ${options.keyFile} is missing; restore it — a new key cannot read what the old one wrote`,
        { details: { keyRef, keyFile: options.keyFile } },
      );
    }
    return decryptSecret(raw, key, keyRef, options.keyFile);
  };
  if (!isWritable(inner)) return { access: inner.access, getSecret } as SecretStorePort;
  const store: WritableStore = {
    access: "read-write",
    getSecret,
    async setSecret(keyRef: string, secret: string): Promise<void> {
      // Trimmed as a plain read trims, so a value reads back the same either way.
      const value = secret.trim();
      if (value === "") {
        throw new TaviError("INVALID_INPUT", `Refusing to store an empty value for ${keyRef}`);
      }
      const key = await readCredentialKey(options.keyFile, keyOptions);
      if (key === undefined && value.startsWith(ENCRYPTED_SECRET_FAMILY)) {
        // Stored plain, it would read as ciphertext: refused rather than made unreadable.
        throw new TaviError(
          "INVALID_INPUT",
          `A value for ${keyRef} that begins with ${JSON.stringify(ENCRYPTED_SECRET_FAMILY)} cannot be stored in plain text; run \`tavi credentials encrypt\` first`,
          { details: { keyRef } },
        );
      }
      await inner.setSecret(keyRef, key === undefined ? value : await encryptSecret(value, key, assertKeyRef(keyRef)));
    },
    deleteSecret: (keyRef: string) => inner.deleteSecret(keyRef),
  };
  return store;
}

/**
 * A private file's contents, or `undefined` when it does not exist — read
 * from the inode that was checked: opened with `O_NOFOLLOW` and `fstat`ed, so
 * a path swapped for a symlink or a looser file between a check and the read
 * cannot be read through. A symlink, something other than a file, or a mode
 * other accounts can read is refused; `what` names it in the refusal.
 */
/** `path`'s permission bits in octal, for a refusal that names them; `unknown` when it cannot be read again. */
async function modeOf(path: string): Promise<string> {
  const { lstat } = await import("node:fs/promises");
  return lstat(path).then(
    (stats) => (stats.mode & 0o777).toString(8),
    () => "unknown",
  );
}

export async function readPrivateFile(path: string, what: string): Promise<string | undefined> {
  let bytes: Buffer | undefined;
  try {
    bytes = await readNoFollow(path, { privateOnly: true });
  } catch (error) {
    if (error instanceof NoFollowReadError) {
      const refusal =
        error.reason === "symlink"
          ? "is a symlink; refusing to follow it"
          : error.reason === "not-file"
            ? "is not a file; refusing to use it"
            : `is readable by other users (mode ${await modeOf(path)}); ${privateExpectation(SAFE_FILE_MODE.toString(8))}`;
      throw new TaviError("NOT_AUTHORIZED", `${what} ${path} ${refusal}`, { details: { path } });
    }
    throw new TaviError("UNAVAILABLE", `${what} ${path} could not be opened: ${errorMessage(error)}`, { details: { path } });
  }
  return bytes?.toString("utf8");
}

/** What a `credentials.key` that refers to a keychain item begins with, whatever its format's version. */
const KEYCHAIN_REFERENCE_FAMILY = "tavi-keychain:";
/** The one reference version this build writes and reads: `tavi-keychain:v1:<kind>:<account>`. */
const KEYCHAIN_REFERENCE_PREFIX = `${KEYCHAIN_REFERENCE_FAMILY}v1:`;
const KEYCHAIN_ACCOUNT_PATTERN = /^[0-9a-f]{32}$/;

export interface CredentialKeyOptions {
  /** The keychain a referenced key is read from (or created in); by default the one the reference names. */
  readonly keychain?: CredentialKeychain;
}

/**
 * The at-rest key, or `undefined` when there is none. A symlink, a key another
 * account can read, or one of the wrong length is refused, naming the file.
 * A file that refers to a keychain item yields that item's key, read once per
 * process: the item is never replaced, so what was read stays right.
 */
export async function readCredentialKey(keyFile: string, options: CredentialKeyOptions = {}): Promise<Buffer | undefined> {
  const raw = await readPrivateFile(keyFile, "The credential key");
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (text.startsWith(KEYCHAIN_REFERENCE_FAMILY)) return readKeychainKey(keyFile, text, options.keychain);
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length !== CREDENTIAL_KEY_BYTES * 2) {
    throw new TaviError(
      "UNAVAILABLE",
      `The credential key ${keyFile} must hold a ${CREDENTIAL_KEY_BYTES * 8}-bit key as ${CREDENTIAL_KEY_BYTES * 2} hex characters; ` +
        "it is never regenerated, since a new key cannot read what the old one wrote — restore it from where it was kept",
      { details: { keyFile } },
    );
  }
  return Buffer.from(text, "hex");
}

/** What the keychain holds for `account`, cached per keychain: an item is never replaced, so one read serves the process. */
const keychainKeys = new WeakMap<CredentialKeychain, Map<string, Buffer>>();
function keychainCache(keychain: CredentialKeychain): Map<string, Buffer> {
  let cache = keychainKeys.get(keychain);
  if (cache === undefined) {
    cache = new Map();
    keychainKeys.set(keychain, cache);
  }
  return cache;
}

const isKeyText = (text: string): boolean => /^[0-9a-fA-F]+$/.test(text) && text.length === CREDENTIAL_KEY_BYTES * 2;

/** The kind and account a keychain reference names, or `undefined` for one this build does not read. */
function parseKeychainReference(text: string): CredentialKeyReference | undefined {
  if (!text.startsWith(KEYCHAIN_REFERENCE_PREFIX)) return undefined;
  const [kind, account, ...rest] = text.slice(KEYCHAIN_REFERENCE_PREFIX.length).split(":");
  if (rest.length > 0 || account === undefined || !KEYCHAIN_ACCOUNT_PATTERN.test(account)) return undefined;
  if (!(CREDENTIAL_KEYCHAIN_KINDS as readonly string[]).includes(kind ?? "")) return undefined;
  return { kind: kind as CredentialKeychainKind, account };
}

async function readKeychainKey(keyFile: string, text: string, injected: CredentialKeychain | undefined): Promise<Buffer> {
  const reference = parseKeychainReference(text);
  if (reference === undefined) {
    throw new TaviError(
      "UNAVAILABLE",
      `The credential key ${keyFile} refers to a keychain item in a form this build does not read; use the tavi that wrote it`,
      { details: { keyFile } },
    );
  }
  const keychain = injected ?? credentialKeychainOfKind(reference.kind);
  if (keychain.kind !== reference.kind) {
    throw new TaviError("UNAVAILABLE", `The credential key ${keyFile} is kept in another keychain (${reference.kind})`, {
      details: { keyFile },
    });
  }
  const cache = keychainCache(keychain);
  const cached = cache.get(reference.account);
  if (cached !== undefined) return cached;
  let stored: string | undefined;
  try {
    stored = await keychain.get(reference.account);
  } catch (error) {
    throw new TaviError(
      "UNAVAILABLE",
      `The credential key ${keyFile} is kept in ${keychain.label}, which could not be read: ${errorMessage(error)}; unlock it and try again`,
      { details: { keyFile } },
    );
  }
  if (stored === undefined || !isKeyText(stored)) {
    throw new TaviError(
      "UNAVAILABLE",
      `The credential key ${keyFile} is kept in ${keychain.label} (service ${CREDENTIAL_KEYCHAIN_SERVICE}, account ${reference.account}), ` +
        `but that item is ${stored === undefined ? "missing" : "not a key"}; restore it — a new key cannot read what the old one wrote`,
      { details: { keyFile } },
    );
  }
  const key = Buffer.from(stored, "hex");
  cache.set(reference.account, key);
  return key;
}

/** The keychain item a key file refers to. */
export interface CredentialKeyReference {
  readonly kind: CredentialKeychainKind;
  readonly account: string;
}

/** The keychain item `keyFile` refers to, or `undefined` when it is a key file itself, a reference this build does not read, or absent. */
export async function credentialKeyReference(keyFile: string): Promise<CredentialKeyReference | undefined> {
  const raw = await readPrivateFile(keyFile, "The credential key");
  return raw === undefined ? undefined : parseKeychainReference(raw.trim());
}

/**
 * Delete the keychain item `reference` names, as a reset does once the data
 * directory that referred to it is gone: nothing else can read it after that.
 * An item already gone is not an error; a keychain that refuses or does not
 * answer throws.
 */
export async function deleteKeychainCredentialKey(
  reference: CredentialKeyReference,
  keychain: CredentialKeychain = credentialKeychainOfKind(reference.kind),
): Promise<void> {
  await keychain.delete(reference.account);
  keychainCache(keychain).delete(reference.account);
}

/** What moving the at-rest key between the keychain and its own file did. */
export type CredentialKeyMove =
  /** It was where it was asked to go already; nothing changed. */
  | { readonly moved: false }
  /**
   * It moved. `item` is the keychain item it left or went to; `deleteError`,
   * moving to a file, says why the item it left could not be deleted (the
   * file is written and used either way).
   */
  | { readonly moved: true; readonly item: CredentialKeyReference; readonly keychain: string; readonly deleteError?: string };

/**
 * Move the at-rest key out of the OS keychain into `keyFile` itself (`tavi
 * credentials key --to-file`): for a backup that must restore on another
 * machine, or a service with no keychain to read — a system unit, a launchd
 * daemon, a user unit whose keyring stays locked. Nothing is re-encrypted:
 * the same key moves. The key is read from the keychain, `keyFile` is
 * replaced by a flushed `0600` file holding it (a reader sees the reference
 * or the key, both the same key), read back, and only then is the keychain
 * item deleted. A key file already is left as it is.
 */
export async function moveCredentialKeyToFile(keyFile: string, options: CredentialKeyOptions = {}): Promise<CredentialKeyMove> {
  const before = await existingKeyText(keyFile);
  if (!before.startsWith(KEYCHAIN_REFERENCE_FAMILY)) {
    // Checked, so a damaged key file is said rather than called moved.
    await readCredentialKey(keyFile);
    return { moved: false };
  }
  const reference = parseKeychainReference(before);
  // Throws for a reference this build does not read, or a keychain that cannot be read: nothing is changed then.
  const key = await readCredentialKey(keyFile, options);
  if (reference === undefined || key === undefined)
    throw new TaviError("UNAVAILABLE", `The credential key ${keyFile} vanished as it was read`);
  const keychain = options.keychain ?? credentialKeychainOfKind(reference.kind);
  await replaceKeyFile(keyFile, before, `${key.toString("hex")}\n`);
  const written = await readCredentialKey(keyFile);
  if (written === undefined || !written.equals(key)) {
    // Never left pointing at nothing: the reference goes back, and the item stays.
    await writeFileAtomicAsync(keyFile, `${before}\n`, { mode: SAFE_FILE_MODE, durable: true });
    throw new TaviError("INTERNAL", `The credential key ${keyFile} did not read back as written; it still refers to ${keychain.label}`);
  }
  try {
    await deleteKeychainCredentialKey(reference, keychain);
    return { moved: true, item: reference, keychain: keychain.label };
  } catch (error) {
    return { moved: true, item: reference, keychain: keychain.label, deleteError: errorMessage(error) };
  }
}

/**
 * Move the at-rest key from `keyFile` into the OS keychain (`tavi credentials
 * key --to-keychain`), the reverse of `moveCredentialKeyToFile`: the same key
 * is stored under an account of its own and read back, then `keyFile` is
 * replaced by a reference to it. A keychain that refuses or does not answer
 * leaves `keyFile` as it was. A reference already is left as it is.
 */
export async function moveCredentialKeyToKeychain(keyFile: string, keychain: CredentialKeychain): Promise<CredentialKeyMove> {
  const before = await existingKeyText(keyFile);
  if (before.startsWith(KEYCHAIN_REFERENCE_FAMILY)) return { moved: false };
  const key = await readCredentialKey(keyFile);
  if (key === undefined) throw new TaviError("UNAVAILABLE", `The credential key ${keyFile} vanished as it was read`);
  const { randomBytes } = await import("node:crypto");
  const account = randomBytes(16).toString("hex");
  const hex = key.toString("hex");
  let stored: string | undefined;
  try {
    await keychain.add(account, hex);
    stored = await keychain.get(account);
  } catch (error) {
    throw new TaviError(
      "UNAVAILABLE",
      `${keychain.label} did not take the credential key: ${errorMessage(error)}; it stays in ${keyFile}`,
      {
        details: { keyFile },
      },
    );
  }
  const item = { kind: keychain.kind, account };
  if (stored?.toLowerCase() !== hex) {
    await keychain.delete(account).catch(() => undefined);
    throw new TaviError("UNAVAILABLE", `${keychain.label} did not keep the credential key as stored; it stays in ${keyFile}`, {
      details: { keyFile },
    });
  }
  try {
    await replaceKeyFile(keyFile, before, `${KEYCHAIN_REFERENCE_PREFIX}${keychain.kind}:${account}\n`);
  } catch (error) {
    // Referred to by nothing: removed, so the keychain does not collect strays.
    await keychain.delete(account).catch(() => undefined);
    throw error;
  }
  keychainCache(keychain).set(account, key);
  return { moved: true, item, keychain: keychain.label };
}

/** `keyFile`'s text, trimmed; a missing key is refused, since there is nothing to move. */
async function existingKeyText(keyFile: string): Promise<string> {
  const raw = await readPrivateFile(keyFile, "The credential key");
  if (raw === undefined) {
    throw new TaviError("NOT_FOUND", `There is no credential key at ${keyFile}; \`tavi credentials encrypt\` creates one`, {
      details: { keyFile },
    });
  }
  return raw.trim();
}

/**
 * Replace `keyFile` with `contents` — flushed, `0600`, renamed into place —
 * provided it still holds `expected`: another command that changed it
 * meanwhile is not overwritten.
 */
async function replaceKeyFile(keyFile: string, expected: string, contents: string): Promise<void> {
  if ((await readPrivateFile(keyFile, "The credential key"))?.trim() !== expected) {
    throw new TaviError("CONFLICT", `The credential key ${keyFile} changed while it was being moved; nothing was replaced`, {
      details: { keyFile },
    });
  }
  await writeFileAtomicAsync(keyFile, contents, { mode: SAFE_FILE_MODE, durable: true });
}

/**
 * Create the at-rest key in the OS keychain if there is no key: a random key
 * is stored under an account of its own (random too, so no two data
 * directories ever share an item, and a moved directory still finds its key
 * through its reference), read back to check it was kept, and then `keyFile`
 * is linked into place holding only a reference to it. `created` when this
 * call made `keyFile`; `exists` when a key file was there already;
 * `unavailable` when the keychain refused, failed or did not answer, and
 * nothing was written — the caller falls back to what it did before.
 */
export async function createKeychainCredentialKey(
  keyFile: string,
  keychain: CredentialKeychain,
): Promise<"created" | "exists" | "unavailable"> {
  if (!(await pathIsAbsent(keyFile))) return "exists";
  const { randomBytes } = await import("node:crypto");
  const account = randomBytes(16).toString("hex");
  let stored: string | undefined;
  try {
    await keychain.add(account, randomBytes(CREDENTIAL_KEY_BYTES).toString("hex"));
    // Read back, not assumed: the key used is the one the keychain kept.
    stored = await keychain.get(account);
  } catch {
    return "unavailable";
  }
  if (stored === undefined || !isKeyText(stored)) return "unavailable";
  keychainCache(keychain).set(account, Buffer.from(stored, "hex"));
  if (await linkPrivateFile(keyFile, `${KEYCHAIN_REFERENCE_PREFIX}${keychain.kind}:${account}\n`)) return "created";
  // Another process made a key file meanwhile: this item is referred to by nothing.
  await keychain.delete(account).catch(() => undefined);
  return "exists";
}

/**
 * Create the at-rest key if there is none: written to a temporary file,
 * flushed to disk, then linked into place — `link` refuses an existing name,
 * so two concurrent callers cannot each create a key, and a reader never sees
 * a half-written one. `true` when this call created it; an existing key is
 * never replaced.
 */
export async function createCredentialKey(keyFile: string): Promise<boolean> {
  const { randomBytes } = await import("node:crypto");
  return linkPrivateFile(keyFile, `${randomBytes(CREDENTIAL_KEY_BYTES).toString("hex")}\n`);
}

/** Write `contents` to a `0600` temporary file, flush it, and link it to `path`: `false` when `path` exists, which is never replaced. */
async function linkPrivateFile(path: string, contents: string): Promise<boolean> {
  const { open, link, unlink } = await import("node:fs/promises");
  const { randomBytes } = await import("node:crypto");
  const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  const handle = await open(temporary, "wx", SAFE_FILE_MODE);
  try {
    await handle.chmod(SAFE_FILE_MODE);
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    await handle.close();
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return false;
    throw error;
  } finally {
    // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    await unlink(temporary).catch(() => undefined);
  }
}

/** A value, encrypted for reference `keyRef`: the prefix, then base64 of IV, tag and ciphertext. */
export async function encryptSecret(value: string, key: Buffer, keyRef: string): Promise<string> {
  const { createCipheriv, randomBytes } = await import("node:crypto");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(keyRef, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${ENCRYPTED_SECRET_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

/** A stored value decrypted for `keyRef`; a wrong key, another reference's file or an altered one is refused. */
export async function decryptSecret(stored: string, key: Buffer, keyRef: string, keyFile: string): Promise<string> {
  const { createDecipheriv } = await import("node:crypto");
  const packed = Buffer.from(stored.slice(ENCRYPTED_SECRET_PREFIX.length), "base64");
  const refused = (): TaviError =>
    new TaviError(
      "UNAVAILABLE",
      `Credential reference ${keyRef} could not be decrypted with ${keyFile}: the key is not the one that wrote it, or the file was altered`,
      { details: { keyRef, keyFile } },
    );
  if (packed.length < IV_BYTES + TAG_BYTES + 1) throw refused();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(keyRef, "utf8"));
    decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw refused();
  }
}

/**
 * Whether a configured path is genuinely absent.
 *
 * `existsSync` follows links, so a *dangling* symlink reports as absent — and in
 * a chain that would fall through to a weaker source, ignoring a planted link.
 * Only `ENOENT` counts as absent here; anything else is resolved by the normal
 * validation, which refuses a symlink.
 */
async function pathIsAbsent(path: string): Promise<boolean> {
  const { lstat } = await import("node:fs/promises");
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT";
  }
}

/**
 * Validate the credential directory, creating it only for a write.
 *
 * A missing directory is a typed failure on the read path: the operator declared
 * this source, and unattended mode must say it is unavailable rather than look
 * unconfigured.
 */
async function resolveSecretDirectory(directory: string, options: { readonly create?: boolean } = {}): Promise<string> {
  const { lstat, stat, mkdir } = await import("node:fs/promises");
  // `lstat`, because `existsSync` follows links: a dangling symlink at this path
  // would look absent, and "absent" is exactly the case that falls through to a
  // weaker source.
  const existing = await lstat(directory).catch(() => undefined);

  if (existing === undefined) {
    if (options.create !== true) {
      throw new TaviError(
        "UNAVAILABLE",
        "The configured credential directory does not exist; the service manager must inject it before a task runs",
      );
    }
    await mkdir(directory, { recursive: true, mode: SAFE_DIRECTORY_MODE });
    return directory;
  }

  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new TaviError("NOT_AUTHORIZED", "The configured credential directory is a symlink or not a directory; refusing to use it");
  }
  const shared = privacyProblem(directory, await stat(directory));
  if (shared !== undefined) {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `Credential directory is accessible to other users (${shared}); ${privateExpectation(SAFE_DIRECTORY_MODE.toString(8))}`,
    );
  }
  return directory;
}

/**
 * Refuse a symlinked or group/world-readable credential file.
 *
 * Returns `null` when the reference is absent. A planted link or a shared mode
 * would hand the credential to another account, so neither is followed.
 */
async function resolveExistingSecretFile(directory: string, name: string): Promise<string | null> {
  const { lstat } = await import("node:fs/promises");
  const path = joinPath(directory, name);

  let stats;
  try {
    // `lstat`, never `existsSync`: a dangling symlink reports as non-existent
    // through a stat that follows links, and treating it as "absent" would hide
    // a planted link instead of refusing it.
    stats = await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new TaviError("UNAVAILABLE", `Credential reference ${name} could not be inspected: ${errorMessage(error)}`, {
      details: { keyRef: name },
    });
  }
  if (stats.isSymbolicLink()) {
    throw new TaviError("NOT_AUTHORIZED", `Credential file for ${name} is a symlink; refusing to follow it`, {
      details: { keyRef: name },
    });
  }
  const shared = privacyProblem(path, stats);
  if (shared !== undefined) {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `Credential file for ${name} is readable by other users (${shared}); ${privateExpectation(SAFE_FILE_MODE.toString(8))}`,
      { details: { keyRef: name } },
    );
  }
  return path;
}

/** Join inside the credential directory; `assertSecretKeyRef` rules out separators. */
function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/**
 * Transient credentials for a foreground session.
 *
 * Writable because its contents are deliberately ephemeral: an operator can
 * supply a value at a prompt and it lives only as long as the process.
 */
export function createSessionSecretStore(initial: Readonly<Record<string, string>> = {}): SecretStorePort {
  const values = new Map<string, string>();
  for (const [keyRef, value] of Object.entries(initial)) {
    assertKeyRef(keyRef);
    if (value !== "") values.set(keyRef, value);
  }
  return {
    access: "read-write",
    async getSecret(keyRef: string): Promise<string | null> {
      return values.get(assertKeyRef(keyRef)) ?? null;
    },
    async setSecret(keyRef: string, secret: string): Promise<void> {
      const name = assertKeyRef(keyRef);
      if (secret === "") throw new TaviError("INVALID_INPUT", `Refusing to store an empty value for ${name}`);
      values.set(name, secret);
    },
    async deleteSecret(keyRef: string): Promise<void> {
      values.delete(assertKeyRef(keyRef));
    },
  };
}

export interface EnvironmentSecretStoreOptions {
  /**
   * Explicit reference-to-variable bindings, e.g. `{ "openai.apiKey": "OPENAI_API_KEY" }`.
   *
   * A user-supplied environment binding is never an ambient fallback: a
   * reference that is not named here does not read the environment at all.
   */
  readonly bindings: Readonly<Record<string, string>>;
  readonly env?: NodeJS.ProcessEnv;
}

/** Read-only environment bindings, for development and CI. */
export function createEnvironmentSecretStore(options: EnvironmentSecretStoreOptions): SecretStorePort {
  const env = options.env ?? process.env;
  for (const keyRef of Object.keys(options.bindings)) assertKeyRef(keyRef);
  return {
    access: "read-only",
    async getSecret(keyRef: string): Promise<string | null> {
      const name = assertKeyRef(keyRef);
      const envVar = options.bindings[name];
      if (envVar === undefined) return null;
      const value = env[envVar];
      if (value === undefined) {
        // Declared but unset: an unattended run must say so rather than look
        // unconfigured.
        throw new TaviError("UNAVAILABLE", `Credential reference ${name} is bound to environment variable ${envVar}, which is not set`, {
          details: { keyRef: name },
        });
      }
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    },
  };
}

/**
 * A chain of sources, tried in order.
 *
 * The first source that *has* the reference wins. A source that fails loudly —
 * an unsafe file mode, an unreadable directory, a locked backend — stops the
 * chain instead of falling through: silently continuing to a weaker source is
 * how a misconfigured binding becomes an unexpected credential. Only `null`
 * (the reference is absent here) moves to the next source.
 */
export function createChainedSecretStore(stores: readonly SecretStorePort[]): SecretStorePort {
  if (stores.length === 0) throw new TaviError("INVALID_INPUT", "A secret chain needs at least one source");
  const allWritable = stores.every(
    (store): store is Extract<SecretStorePort, { access: "read-write" }> =>
      store.access === "read-write" &&
      typeof (store as { setSecret?: unknown }).setSecret === "function" &&
      typeof (store as { deleteSecret?: unknown }).deleteSecret === "function",
  );

  const read = async (keyRef: string): Promise<string | null> => {
    for (const store of stores) {
      const value = await store.getSecret(keyRef);
      if (value !== null) return value;
    }
    return null;
  };

  if (!allWritable) {
    // A read-only chain has no write surface at all. It also cannot be asked to
    // write: a source that cannot accept the value would make the write a lie,
    // because reads would keep returning an earlier source's value.
    return { access: "read-only", getSecret: read };
  }

  return {
    access: "read-write",
    getSecret: read,
    async setSecret(keyRef: string, secret: string): Promise<void> {
      // Write to the first source, after confirming no earlier read-only source
      // already holds the reference — otherwise the write would not take effect.
      for (const store of stores) {
        if (store.access === "read-write") {
          await store.setSecret(keyRef, secret);
          return;
        }
        if ((await store.getSecret(keyRef)) !== null) {
          throw new TaviError(
            "NOT_AUTHORIZED",
            `Credential reference ${keyRef} is held by a read-only source and cannot be replaced here`,
            { details: { keyRef } },
          );
        }
      }
    },
    async deleteSecret(keyRef: string): Promise<void> {
      // Delete everywhere it exists: removing it from one source while another
      // still holds it would report success and leave the credential resolvable.
      for (const store of stores) {
        if (store.access === "read-write") await store.deleteSecret(keyRef);
      }
    },
  };
}

/** Safe metadata about the active source, for Settings and attached clients. */
export function describeSecretStore(store: SecretStorePort, kind: SecretSourceKind): SecretSourceCapability {
  // `writable` is derived from the store's own shape rather than echoed from a
  // declared flag, so a capability record cannot advertise a write that the
  // store does not have.
  const writable = store.access === "read-write" && typeof (store as { setSecret?: unknown }).setSecret === "function";
  return {
    access: store.access,
    kind,
    writable,
    description:
      kind === "file"
        ? store.access === "read-write"
          ? "Credential files injected for this service identity (writable)"
          : "Credential files injected for this service identity (read-only)"
        : kind === "environment"
          ? "Named environment-variable bindings (read-only)"
          : kind === "chain"
            ? `Injected credential directory (encrypted at rest once its key exists), then declared launcher bindings (${
                store.access === "read-write" ? "writable" : "read-only"
              })`
            : "Transient session credentials (writable)",
  };
}

/** Narrow a store to the read interface the model adapter needs. */
export function asSecretReader(store: SecretStorePort): SecretReaderPort {
  return { getSecret: (keyRef: string) => store.getSecret(keyRef) };
}

function assertKeyRef(keyRef: string): string {
  try {
    return assertSecretKeyRef(keyRef);
  } catch (error) {
    throw new TaviError("INVALID_INPUT", errorMessage(error));
  }
}
