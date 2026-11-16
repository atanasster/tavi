import { existsSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { SECRET_KEY_REF_PATTERN, TaviError, assertSecretKeyRef, type SecretReaderPort } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { NoFollowReadError, privacyProblem, privateExpectation, readNoFollow } from "@tavi/node-kit";
import {
  createCredentialKey,
  createEncryptedFileSecretStore,
  createFileSecretStore,
  createKeychainCredentialKey,
  CREDENTIAL_KEYCHAIN_SERVICE,
  credentialKeyReference,
  credentialKeychainOfKind,
  decryptSecret,
  deleteKeychainCredentialKey,
  ENCRYPTED_SECRET_FAMILY,
  encryptSecret,
  moveCredentialKeyToFile,
  moveCredentialKeyToKeychain,
  readCredentialKey,
  systemCredentialKeychain,
  type CredentialKeychain,
  type CredentialKeyMove,
  type CredentialKeyReference,
} from "@tavi/runtime";

/**
 * The local credential store `tavi credentials` manages.
 *
 * The runtime's existing chain resolves `<dataDir>/credentials/<ref>` but is
 * read-only by construction — `runtime/models.ts` builds the file store without
 * `access`, and `createChainedSecretStore` is writable only when *every* member
 * is (`secrets.ts`). So there is no other way to put a credential there.
 * This module is that operator-facing write path, and nothing
 * else: it is deliberately **not** reachable from a tool or from the agent
 * (the agent may never mint, read or echo a credential).
 *
 * Two callers, both operator-facing: `tavi credentials` (`features/credentials/client.ts`), and — under
 * a live owner — the owner's IPC `credentials` handler (`config-commands.ts`),
 * where the value crosses the local socket once and is written
 * here. The owner composes no writable store of its own: its resolution chain
 * stays read-only, and this store is created per request by that handler only.
 *
 * Values are written 0600 through the runtime's own file store, and are never
 * printed, logged, or echoed by any command here.
 */

/**
 * The at-rest key, beside the credentials directory rather than in it:
 * a copy of `credentials/` — `tavi backup --include-credentials` makes one —
 * does not carry it.
 */
export function credentialKeyFile(dataDirectory: string): string {
  return join(dataDirectory, "credentials.key");
}

/** Whether the credential store is encrypted at rest: its key exists. A sign-in's token and a client secret are kept only then. */
export function credentialsEncrypted(dataDirectory: string): boolean {
  return existsSync(credentialKeyFile(dataDirectory));
}

/**
 * Whether `dataDirectory` is opened for the first time: no database yet, and
 * no credential key. Read before the database is created.
 */
export function isNewDataDirectory(dataDirectory: string): boolean {
  return !existsSync(join(dataDirectory, "tavi.sqlite")) && !existsSync(credentialKeyFile(dataDirectory));
}

/**
 * Turn on encryption for a new data directory, with no step of its own: the
 * key goes to the OS keychain and `credentials.key` refers to it, and a value
 * `tavi credentials set` stored before then is encrypted under it. Where there
 * is no keychain, or it refuses or does not answer, nothing is written and the
 * store stays plain, as before — `tavi credentials encrypt` still turns it on.
 * Never fails the caller: a store that stays plain is not an error.
 */
export async function provisionCredentialKey(
  dataDirectory: string,
  keychain: CredentialKeychain | null | undefined = systemCredentialKeychain(),
): Promise<"created" | "exists" | "unavailable"> {
  if (keychain === null || keychain === undefined) return "unavailable";
  const outcome = await createKeychainCredentialKey(credentialKeyFile(dataDirectory), keychain).catch(() => "unavailable" as const);
  if (outcome === "created" && existsSync(credentialsDirectory(dataDirectory))) {
    // Left plain, it stays readable: `tavi credentials encrypt` finishes what this could not.
    await encryptCredentialDirectory(dataDirectory, keychain).catch(() => undefined);
  }
  return outcome;
}

/** The keychain item `dataDirectory`'s credential key is kept in, read before a reset deletes the reference to it. */
export async function credentialKeyItemOf(dataDirectory: string): Promise<CredentialKeyReference | undefined> {
  return credentialKeyReference(credentialKeyFile(dataDirectory)).catch(() => undefined);
}

/**
 * Delete the keychain item a reset left without a reference: a note for the
 * reset's summary, saying what was deleted or why it could not be. Never
 * throws: the directory is already reset.
 */
export async function forgetCredentialKeyItem(item: CredentialKeyReference, keychain?: CredentialKeychain): Promise<string> {
  const where = (keychain ?? credentialKeychainOfKind(item.kind)).label;
  const name = `the credential key in ${where} (service ${CREDENTIAL_KEYCHAIN_SERVICE}, account ${item.account})`;
  try {
    await deleteKeychainCredentialKey(item, keychain);
    return `deleted ${name}`;
  } catch (error) {
    return `could not delete ${name}: ${errorMessage(error)}; delete it in ${where}`;
  }
}

/** Where `tavi credentials key` says the at-rest key is kept. */
export interface CredentialKeyLocation {
  readonly keyFile: string;
  /** `none`: no key, the store is plain; `file`: `keyFile` is the key; `keychain`: `keyFile` refers to an item there. */
  readonly kept: "none" | "file" | "keychain";
  /** For `keychain`: which one, and the item. */
  readonly keychain?: string;
  readonly item?: CredentialKeyReference;
}

/** Where `dataDirectory`'s credential key is kept; the key itself is never read. */
export async function credentialKeyLocation(dataDirectory: string): Promise<CredentialKeyLocation> {
  const keyFile = credentialKeyFile(dataDirectory);
  if (!existsSync(keyFile)) return { keyFile, kept: "none" };
  const item = await credentialKeyReference(keyFile);
  return item === undefined
    ? { keyFile, kept: "file" }
    : { keyFile, kept: "keychain", keychain: credentialKeychainOfKind(item.kind).label, item };
}

/** What `tavi credentials key --to-file|--to-keychain` did. */
export type CredentialKeyMoveResult = CredentialKeyMove & { readonly keyFile: string; readonly to: "file" | "keychain" };

/**
 * Move `dataDirectory`'s credential key into `credentials.key` itself, or
 * into the OS keychain (`tavi credentials key`). The same key moves, so no
 * value is re-encrypted, and none is read. Moving to the keychain needs one:
 * `keychain` defaults to this machine's, and there may be none.
 */
export async function moveCredentialKey(
  dataDirectory: string,
  to: "file" | "keychain",
  keychain: CredentialKeychain | undefined = to === "keychain" ? systemCredentialKeychain() : undefined,
): Promise<CredentialKeyMoveResult> {
  const keyFile = credentialKeyFile(dataDirectory);
  if (to === "file") return { keyFile, to, ...(await moveCredentialKeyToFile(keyFile, keychain === undefined ? {} : { keychain })) };
  if (keychain === undefined) {
    throw new TaviError(
      "UNAVAILABLE",
      "There is no OS keychain to use here (the macOS Keychain, a Secret Service on a session bus, or Windows Credential Manager), or TAVI_CREDENTIAL_KEYCHAIN=off; the key stays in its file",
    );
  }
  return { keyFile, to, ...(await moveCredentialKeyToKeychain(keyFile, keychain)) };
}

/** What `encryptCredentialDirectory` did. */
export interface CredentialEncryption {
  readonly keyFile: string;
  /** The key was created by this call, rather than found. */
  readonly keyCreated: boolean;
  /** Where the key is kept when `keyFile` only refers to it: "the macOS Keychain". Absent when `keyFile` is the key. */
  readonly keychain?: string;
  /** References rewritten encrypted by this call. */
  readonly encrypted: readonly string[];
  /** References that were encrypted already, and decrypt with this key. */
  readonly alreadyEncrypted: readonly string[];
  /** References that look encrypted but do not decrypt with this key — another directory's key, or altered. */
  readonly undecryptable: readonly string[];
  /** Files in the directory that are no reference, left as they were: whatever they hold is not encrypted. */
  readonly unencrypted: readonly string[];
  /** Temporary files an interrupted write left behind, removed: a copy of the directory must not carry them. */
  readonly removedTemporaries: number;
}

/**
 * Encrypt the credentials directory at rest (`tavi credentials encrypt`):
 * create the key if there is none — flushed and linked into place, so
 * it exists whole or not at all — then rewrite each plain value encrypted, one
 * file at a time, each through the store's temporary-file-and-rename write, so
 * a reader sees the old value or the new one and an interrupted run leaves
 * every file readable. Idempotent: a value already encrypted, and decrypting
 * with this key, is left as it is, and a second run changes nothing. What it
 * cannot encrypt is said, not skipped silently. A key that exists is used,
 * never replaced.
 */
export async function encryptCredentialDirectory(
  dataDirectory: string,
  keychain: CredentialKeychain | undefined = systemCredentialKeychain(),
): Promise<CredentialEncryption> {
  const keyFile = credentialKeyFile(dataDirectory);
  const keyOptions = keychain === undefined ? {} : { keychain };
  let keyCreated = false;
  if ((await readCredentialKey(keyFile, keyOptions)) === undefined) {
    // In the OS keychain where it takes the key; otherwise a key file, as before.
    const inKeychain = keychain === undefined ? "unavailable" : await createKeychainCredentialKey(keyFile, keychain);
    keyCreated = inKeychain === "created" || (inKeychain === "unavailable" && (await createCredentialKey(keyFile)));
  }
  const key = await readCredentialKey(keyFile, keyOptions);
  if (key === undefined) throw new TaviError("UNAVAILABLE", `The credential key ${keyFile} vanished as it was created`);
  const directory = credentialsDirectory(dataDirectory);
  // Orphaned in-progress writes carry a whole plain value: gone, before anything else.
  let removedTemporaries = 0;
  const hidden: string[] = [];
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (SECRET_TEMP_FILE_PATTERN.test(name)) {
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
      await unlink(join(directory, name)).catch(() => undefined);
      removedTemporaries += 1;
    } else if (name.startsWith(".")) {
      // A dotfile is no reference (`list` hides it), but a copy of the directory carries it.
      hidden.push(name);
    }
  }
  const listing = await listCredentialRefs(dataDirectory);
  // The raw file store: it reads a value as stored, encrypted or not.
  const raw = createFileSecretStore({ directory, access: "read-write", missingDirectory: "absent" }) as WritableCredentialStore;
  const encrypted: string[] = [];
  const alreadyEncrypted: string[] = [];
  const undecryptable: string[] = [];
  for (const reference of listing.valid) {
    const stored = await raw.getSecret(reference);
    if (stored === null) continue;
    if (stored.startsWith(ENCRYPTED_SECRET_FAMILY)) {
      // Checked, not assumed: a file copied from another directory, or altered, is said to be unreadable.
      const readable = await decryptSecret(stored, key, reference, keyFile).then(
        () => true,
        () => false,
      );
      (readable ? alreadyEncrypted : undecryptable).push(reference);
      continue;
    }
    await raw.setSecret(reference, await encryptSecret(stored, key, reference));
    encrypted.push(reference);
  }
  const kept = (await credentialKeyReference(keyFile))?.kind;
  return {
    keyFile,
    keyCreated,
    ...(kept === undefined ? {} : { keychain: (keychain?.kind === kept ? keychain : credentialKeychainOfKind(kept)).label }),
    encrypted,
    alreadyEncrypted,
    undecryptable,
    unencrypted: [...listing.invalid, ...hidden],
    removedTemporaries,
  };
}

/**
 * Credential writes on one data directory, one at a time. Offline the
 * ownership lock serialises commands; an owner answers IPC requests
 * concurrently, and an `encrypt` rewriting a file while a `set` writes it
 * would put the older value back — so the owner's handler runs each action
 * through here.
 */
const credentialQueues = new Map<string, Promise<unknown>>();
export function serializeCredentialAction<T>(dataDirectory: string, action: () => Promise<T>): Promise<T> {
  const previous = credentialQueues.get(dataDirectory) ?? Promise.resolve();
  const next = previous.then(action, action);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  credentialQueues.set(dataDirectory, settled);
  void settled.then(() => {
    if (credentialQueues.get(dataDirectory) === settled) credentialQueues.delete(dataDirectory);
  });
  return next;
}

/** Where credentials live, relative to the data directory. */
function credentialsDirectory(dataDirectory: string): string {
  return join(dataDirectory, "credentials");
}

/**
 * The secret store's in-progress write: `<ref>.tmp-<12 hex>`
 * (`packages/runtime/src/access/secrets.ts`). Only this shape is hidden from
 * `list`; a reference that merely contains `.tmp-` is a real, resolvable
 * credential and is listed.
 */
const SECRET_TEMP_FILE_PATTERN = /\.tmp-[0-9a-f]{12}$/;

/** A credential store that is definitely writable, not the read-only half of the port's union. */
export type WritableCredentialStore = SecretReaderPort & {
  readonly access: "read-write";
  setSecret(keyRef: string, secret: string): Promise<void>;
  deleteSecret(keyRef: string): Promise<void>;
};

/**
 * A writable store over the data directory's credential folder.
 *
 * `createFileSecretStore` is declared to return the `SecretStorePort` union, so
 * the read-write variant is asserted here; the literal `access` argument is what
 * makes the assertion sound, and the capability check below makes it fail loudly
 * if that ever stops being true (rather than becoming a silent no-op writer).
 *
 * `missingDirectory: "absent"` affects reads only: a fresh install has no
 * folder, and that is "no credential here", not an error. Writes create it 0700.
 */
export function createLocalCredentialStore(dataDirectory: string): WritableCredentialStore {
  // Encrypted at rest once `credentials.key` exists; plain until then.
  const store = createEncryptedFileSecretStore({
    directory: credentialsDirectory(dataDirectory),
    keyFile: credentialKeyFile(dataDirectory),
    access: "read-write",
    missingDirectory: "absent",
  });
  const candidate = store as { readonly access?: string; setSecret?: unknown; deleteSecret?: unknown };
  if (candidate.access !== "read-write" || typeof candidate.setSecret !== "function" || typeof candidate.deleteSecret !== "function") {
    throw new TaviError("INTERNAL", "the local credential store must be writable");
  }
  return store as WritableCredentialStore;
}

export interface CredentialListing {
  /** Names the store can actually resolve. */
  readonly valid: readonly string[];
  /** Files present but unusable as references — surfaced, never silently hidden. */
  readonly invalid: readonly string[];
}

/**
 * Credential reference names present on disk.
 *
 * Names only — a reference is an identifier like `acme.stripe.key`, never a
 * value. The directory is checked the same way the store checks it before
 * reading, so a symlinked or group-readable credential folder is refused rather
 * than listed. Files that cannot be resolved as a reference (a hand-dropped
 * `Upper.Ref`, `with space`, `a/b`) are reported separately instead of being
 * listed as configured.
 */
export async function listCredentialRefs(dataDirectory: string): Promise<CredentialListing> {
  const directory = credentialsDirectory(dataDirectory);
  let stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { valid: [], invalid: [] };
    throw new TaviError("UNAVAILABLE", `could not read the credential directory: ${String(error)}`);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new TaviError("NOT_AUTHORIZED", "the credential directory is a symlink or not a directory; refusing to use it");
  }
  const shared = privacyProblem(directory, stats);
  if (shared !== undefined) {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `the credential directory is accessible to other users (${shared}); ${privateExpectation("700")}`,
    );
  }
  // Dotfiles, plus the one temporary-file shape the secret store writes:
  // `<ref>.tmp-<12 hex>` (`packages/runtime/src/access/secrets.ts`), which is
  // created before the rename and must not be reported as a credential.
  // Excluding every name *containing* `.tmp-` would also hide legitimate
  // references the pattern accepts and the store resolves — `list` would then
  // disagree with what a task can actually use.
  const entries = (await readdir(directory)).filter((name) => !name.startsWith(".") && !SECRET_TEMP_FILE_PATTERN.test(name));
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const name of entries) {
    if (SECRET_KEY_REF_PATTERN.test(name)) valid.push(name);
    else invalid.push(name);
  }
  return { valid: valid.sort(), invalid: invalid.sort() };
}

/**
 * Read a credential's value from an operator-supplied file.
 *
 * Validation happens on the same inode that is read (`readNoFollow`: opened
 * `O_NOFOLLOW` and `fstat`ed), so a path swapped for a symlink or a looser file
 * between a check and the read cannot be read through — the lstat-then-read
 * shape the runtime's `readSecretFile` uses leaves that window open.
 */
export async function readCredentialValueFromFile(reference: string, file: string): Promise<string> {
  const name = assertSecretReference(reference);
  let bytes: Buffer | undefined;
  try {
    bytes = await readNoFollow(file, { privateOnly: true });
  } catch (error) {
    if (error instanceof NoFollowReadError) {
      // Its message names the path: said of the credential instead.
      const said = `the source file for ${name}${error.message.slice(file.length)}`;
      throw new TaviError(error.reason === "symlink" || error.reason === "shared" ? "NOT_AUTHORIZED" : "INVALID_INPUT", said);
    }
    throw new TaviError("INVALID_INPUT", `the source file for ${name} could not be opened: ${String(error)}`);
  }
  if (bytes === undefined) throw new TaviError("INVALID_INPUT", `the source file for ${name} could not be opened: it does not exist`);
  const value = bytes.toString("utf8").trim();
  if (value === "") throw new TaviError("INVALID_INPUT", `the source file for ${name} is empty`);
  // Ciphertext is not a value: stored or sent as one, it would become the key.
  if (value.startsWith(ENCRYPTED_SECRET_FAMILY)) {
    throw new TaviError(
      "INVALID_INPUT",
      `the source file for ${name} holds an encrypted credential, not its value; give a file with the plain value`,
    );
  }
  return value;
}

/** Reject a reference the store could never resolve, as a typed input error. */
export function assertSecretReference(reference: string): string {
  // The shape of an in-progress write: hidden from `list`, and removed by `encrypt` as one.
  if (SECRET_TEMP_FILE_PATTERN.test(reference)) {
    throw new TaviError(
      "INVALID_INPUT",
      `${reference} has the shape of the store's temporary files (\`<ref>.tmp-<12 hex>\`); choose another name`,
      {
        details: { credentialRef: reference },
      },
    );
  }
  try {
    return assertSecretKeyRef(reference);
  } catch (error) {
    throw new TaviError("INVALID_INPUT", errorMessage(error), {
      details: { credentialRef: reference },
    });
  }
}

/**
 * A credential's value as `credentials set` takes it: trimmed, not empty, and
 * never ciphertext, which stored as a value would be sent as the key.
 */
export function plainCredentialValue(name: string, raw: string): string {
  const value = raw.trim();
  if (value === "") throw new TaviError("INVALID_INPUT", `the value for ${name} is empty`);
  if (value.startsWith(ENCRYPTED_SECRET_FAMILY))
    throw new TaviError("INVALID_INPUT", `the value for ${name} is an encrypted credential, not its value; give the plain value`);
  return value;
}
