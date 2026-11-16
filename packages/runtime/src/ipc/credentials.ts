import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  IPC_DISCOVERY_FILE,
  IPC_RUNTIME_DIRECTORY,
  IPC_SOCKET_FILE,
  IPC_TOKEN_FILE,
  IpcDiscoverySchema,
  TaviError,
  type IpcDiscovery,
} from "@tavi/contracts";
import { privacyProblem, privateExpectation, privateRemedy, writeJsonAtomic } from "@tavi/node-kit";

/** Bytes of entropy behind the bearer cookie: 256 bits. */
const TOKEN_BYTES = 32;

/** The capability a caller must hold to mint a cookie or publish discovery. */
export interface OwnershipProof {
  readonly dataDirectory: string;
  readonly sessionId: string;
  readonly released: boolean;
}

/**
 * The IPC credential and discovery directory.
 *
 * `runtime/` under the data directory holds the bearer cookie and the discovery
 * metadata. It is a separate directory the backup protocol skips, and it is never
 * granted to a sandboxed child.
 *
 * Both writers require the caller to present live **exclusive ownership** of the
 * data directory. A second launcher cannot take ownership, so it can neither
 * rotate the cookie nor replace another launcher's discovery metadata.
 */
export interface IpcCredentialPaths {
  readonly directory: string;
  readonly tokenPath: string;
  readonly discoveryPath: string;
  /** Where a Unix owner binds its socket, published to clients as discovery's `endpoint`. */
  readonly socketPath: string;
}

export function ipcPaths(dataDirectory: string): IpcCredentialPaths {
  const directory = join(dataDirectory, IPC_RUNTIME_DIRECTORY);
  return {
    directory,
    tokenPath: join(directory, IPC_TOKEN_FILE),
    discoveryPath: join(directory, IPC_DISCOVERY_FILE),
    socketPath: join(directory, IPC_SOCKET_FILE),
  };
}

/**
 * Refuse to act without live exclusive ownership of the directory.
 *
 * This is what makes "a second launcher must not rotate a live owner's token"
 * structural rather than advisory.
 */
export function assertOwnership(dataDirectory: string, ownership: OwnershipProof): void {
  if (ownership.released) {
    throw new TaviError("CONFLICT", "Cannot publish IPC credentials after ownership was released");
  }
  if (resolve(ownership.dataDirectory) !== resolve(dataDirectory)) {
    throw new TaviError("INVALID_INPUT", `Ownership of ${ownership.dataDirectory} does not cover ${resolve(dataDirectory)}`);
  }
  if (ownership.sessionId.trim() === "") {
    throw new TaviError("INVALID_INPUT", "Ownership proof has no session identity");
  }
}

/**
 * Create the credential directory privately and mint a fresh cookie.
 *
 * The directory and file are created with their final permissions rather than
 * created permissively and corrected afterwards, because the window in which a
 * cookie is world-readable is exactly the window that matters.
 */
export function mintToken(
  dataDirectory: string,
  ownership: OwnershipProof,
): { readonly token: string; readonly paths: IpcCredentialPaths } {
  assertOwnership(dataDirectory, ownership);
  const paths = ipcPaths(dataDirectory);
  ensurePrivateDirectory(paths.directory);
  assertNotSymlink(paths.tokenPath);

  // Rotation is safe precisely because ownership is held: no other launcher can
  // be live on this directory while it is.
  const token = randomBytes(TOKEN_BYTES).toString("base64");
  writeFileSync(paths.tokenPath, token, { mode: 0o600, flag: "w" });
  chmodSync(paths.tokenPath, 0o600);
  return { token, paths };
}

/**
 * Read an existing token, refusing an unsafe one.
 *
 * A token other users can read is not a credential, so this refuses rather than
 * warning.
 */
export function readToken(dataDirectory: string): string | undefined {
  const paths = ipcPaths(dataDirectory);
  // Check the symlink first: a dangling symlink reports as non-existent while
  // still being a redirection the owner never created.
  assertNotSymlink(paths.tokenPath);
  if (!existsSync(paths.tokenPath)) return undefined;
  const stats = statSync(paths.tokenPath);
  const shared = privacyProblem(paths.tokenPath, stats);
  if (shared !== undefined) {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `IPC token ${paths.tokenPath} is readable by other users (${shared}); ${privateExpectation("0600")}`,
      {
        details: { mode: (stats.mode & 0o777).toString(8) },
      },
    );
  }
  return readFileSync(paths.tokenPath, "utf8").trim();
}

/**
 * Publish discovery metadata atomically.
 *
 * The temporary file is created exclusively and in the same directory, so a
 * reader never observes a half-written file and a symlink at the temporary path
 * cannot be followed to clobber an unrelated file.
 */
export function publishDiscovery(dataDirectory: string, discovery: IpcDiscovery, ownership: OwnershipProof): void {
  assertOwnership(dataDirectory, ownership);
  const paths = ipcPaths(dataDirectory);
  ensurePrivateDirectory(paths.directory);

  const parsed = IpcDiscoverySchema.safeParse(discovery);
  if (!parsed.success) {
    throw new TaviError("INVALID_INPUT", "Refusing to publish malformed discovery metadata");
  }

  writeJsonAtomic(paths.discoveryPath, parsed.data);
}

export function readDiscovery(dataDirectory: string): IpcDiscovery | undefined {
  const paths = ipcPaths(dataDirectory);
  assertNotSymlink(paths.discoveryPath);
  if (!existsSync(paths.discoveryPath)) return undefined;
  try {
    // Validated rather than cast: a partially written or hand-edited file must
    // not become a typed value with undefined fields.
    const parsed = IpcDiscoverySchema.safeParse(JSON.parse(readFileSync(paths.discoveryPath, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // A corrupt discovery file is indistinguishable from an absent one to a
    // client, which re-reads rather than trusting a partial result.
    return undefined;
  }
}

export function clearDiscovery(dataDirectory: string): void {
  const paths = ipcPaths(dataDirectory);
  // The same guard its sibling applies: a symlinked path is refused rather than
  // followed, so a planted link cannot make this delete something else.
  assertNotSymlink(paths.discoveryPath);
  if (existsSync(paths.discoveryPath)) unlinkSync(paths.discoveryPath);
}

/** The file a stopping owner leaves while it drains: its session id. */
const STOPPING_FILE = "ipc.stopping";

/**
 * Mark the owner as stopping, once it has withdrawn its discovery: a command
 * that then finds the directory held does not wait for it to answer, as it
 * waits for a starting owner (`findLiveOwner`).
 */
export function markStopping(dataDirectory: string, ownership: OwnershipProof): void {
  assertOwnership(dataDirectory, ownership);
  const path = join(ipcPaths(dataDirectory).directory, STOPPING_FILE);
  assertNotSymlink(path);
  writeFileSync(path, ownership.sessionId, { mode: 0o600 });
}

/** The session a stopping owner marked, or undefined when none did (or the mark cannot be read). */
export function readStopping(dataDirectory: string): string | undefined {
  const path = join(ipcPaths(dataDirectory).directory, STOPPING_FILE);
  try {
    assertNotSymlink(path);
    return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Remove a stopping mark a previous owner left: the owner publishing now is not stopping. */
export function clearStopping(dataDirectory: string): void {
  const path = join(ipcPaths(dataDirectory).directory, STOPPING_FILE);
  assertNotSymlink(path);
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Remove the bearer cookie.
 *
 * The cookie is an ephemeral credential: an owner that has stopped should not
 * leave one on disk for the next process to inherit.
 */
export function clearToken(dataDirectory: string): void {
  const paths = ipcPaths(dataDirectory);
  assertNotSymlink(paths.tokenPath);
  if (existsSync(paths.tokenPath)) unlinkSync(paths.tokenPath);
}

/**
 * Compare a presented cookie against the expected one in constant time.
 *
 * Lengths are compared first because `timingSafeEqual` throws on a length
 * mismatch; the length of a fixed-size token is not a secret.
 */
export function tokenMatches(expected: string, presented: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const presentedBytes = Buffer.from(presented, "utf8");
  if (expectedBytes.length !== presentedBytes.length) return false;
  return timingSafeEqual(expectedBytes, presentedBytes);
}

/**
 * Create the directory privately, refusing a symlinked path.
 *
 * `lstat` is used on the directory itself as well as the files inside it: a
 * symlinked `runtime/` would let the token be written somewhere the owner never
 * chose.
 */
function ensurePrivateDirectory(directory: string): void {
  assertNotSymlink(directory);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const stats = lstatSync(directory);
  if (!stats.isDirectory()) {
    throw new TaviError("INVALID_INPUT", `${directory} exists and is not a directory`);
  }
  const shared = privacyProblem(directory, stats);
  if (shared !== undefined) {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `IPC directory ${directory} is accessible to other users (${shared}); ` +
        `expected a private directory. Run: ${privateRemedy(directory, "directory")}`,
      { details: { mode: (stats.mode & 0o777).toString(8) } },
    );
  }
}

function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new TaviError("INVALID_INPUT", `Refusing a symlinked IPC path at ${path}`);
    }
  } catch (error) {
    if (error instanceof TaviError) throw error;
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}
