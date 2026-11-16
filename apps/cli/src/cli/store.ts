import { TaviError } from "@tavi/contracts";
import type { DatabaseClient } from "@tavi/runtime";
import { resolveDataDirectory } from "../shared/data-directory.js";
import { isOwnershipContention } from "./exit.js";

/** Who holds a data directory, as its owner record names it: the pid and session of a live process. */
export interface DirectoryHolder {
  readonly pid: number;
  readonly sessionId: string;
}

/** What a command says it needs when it names nothing more specific. */
const NEEDS_IT_TO_ITSELF = "this command needs it to itself";

/**
 * The one refusal for a data directory another process holds: who holds it
 * (`tavi serve` and its pid, when it is serve), what this command would have
 * done to it, and how to free it. It says "already owns", which keeps its
 * exit code (`isOwnershipContention`).
 */
export function ownedRefusal(dataDirectory: string, holder: DirectoryHolder | undefined, consequence = NEEDS_IT_TO_ITSELF): string {
  if (holder?.sessionId.startsWith("serve-") === true) {
    return (
      `\`tavi serve\` (pid ${holder.pid}) already owns ${dataDirectory}; ${consequence}. ` +
      "Stop it first (Ctrl-C where it runs, or stop the launchd/systemd unit you installed with `tavi service unit`), then run this again."
    );
  }
  if (holder !== undefined) {
    return `Another tavi command (pid ${holder.pid}) already owns ${dataDirectory}; ${consequence}. Wait for it to finish, then run this again.`;
  }
  return (
    `Another process already owns ${dataDirectory}; ${consequence}. ` +
    "Stop it first (Ctrl-C where `tavi serve` runs, or stop the launchd/systemd unit you installed with `tavi service unit`), then run this again."
  );
}

/** The refusal `ownedRefusal` words for an ownership conflict from the lock, or `error` itself for any other failure. */
async function ownershipRefusal(error: unknown, dataDirectory: string, consequence?: string): Promise<unknown> {
  if (!(error instanceof TaviError) || error.code !== "CONFLICT" || !isOwnershipContention(error)) return error;
  const { liveOwnerProcess } = await import("@tavi/runtime/owner-attach");
  return new TaviError("CONFLICT", ownedRefusal(dataDirectory, liveOwnerProcess(dataDirectory), consequence), { cause: error });
}

/**
 * `withStore`, by its older name: an ownership conflict reads as
 * `ownedRefusal` words it, and any other refusal from the ownership layer (a
 * previous owner still alive, an unreadable record) keeps its own message.
 */
export async function withStorePreservingOwnership<T>(
  dataDirectory: string,
  body: (store: DatabaseClient) => Promise<T>,
  /** What the command would do to an owned directory, for the refusal. */
  refusal?: string,
): Promise<T> {
  return await withStore(dataDirectory, body, refusal);
}

/**
 * Open the data directory for a short-lived foreground command.
 *
 * Ownership is the gate, and it is the only gate: while an owner holds the
 * directory it is the sole writer, so a command that cannot take the directory
 * for itself must not open the database at all. Commands that must work *while*
 * an owner runs (`tasks`, `cancel`) reach it over authenticated IPC first and
 * never arrive here; if one does arrive and finds the directory owned, it is
 * racing an owner that published no discovery record, and refusing is the only
 * safe answer. WAL is not a licence to write here — one writer plus
 * readers still means this process must not write.
 */
export async function withStore<T>(
  dataDirectory: string,
  body: (store: DatabaseClient) => Promise<T>,
  /** What the command would do to an owned directory, for the refusal; absent, that it needs it to itself. */
  refusal?: string,
): Promise<T> {
  const { DatabaseClient, acquireDataDirectoryOwnership } = await import("@tavi/runtime");
  let ownership: Awaited<ReturnType<typeof acquireDataDirectoryOwnership>> | undefined;

  try {
    ownership = await acquireDataDirectoryOwnership({
      dataDirectory,
      sessionId: `cli-${process.pid}`,
    });
  } catch (error) {
    throw await ownershipRefusal(error, dataDirectory, refusal);
  }

  // Read before the database is created: whether this is the directory's first open.
  const credentials = await import("../features/credentials/store.js");
  const fresh = credentials.isNewDataDirectory(dataDirectory);
  let store: DatabaseClient;
  try {
    store = await DatabaseClient.open({
      databasePath: `${dataDirectory}/tavi.sqlite`,
      artifactsDirectory: `${dataDirectory}/artifacts`,
    });
  } catch (error) {
    // Construction can refuse (an unrecognised schema, an unreadable directory)
    // after the lock above was taken; without this the directory stays owned by a
    // process that is about to exit, and the next command is refused for a reason
    // that no longer exists.
    await ownership?.release();
    throw error;
  }
  try {
    // A new data directory is encrypted from its first open, whichever command opens it (`composeTaviRuntime` does the same).
    if (fresh) await credentials.provisionCredentialKey(dataDirectory);
    return await body(store);
  } finally {
    await store.close();
    await ownership?.release();
  }
}

/**
 * Take the data-directory ownership lock without opening the database.
 *
 * `tavi credentials` needs the same single-owner refusal every other
 * configuration command has, but it writes files under `credentials/`, not
 * rows — building a `DatabaseClient` (and running migrations) would make
 * credential provisioning fail for reasons unrelated to credentials, and would
 * create a database as a side effect on a fresh directory.
 */
export async function withOwnership<T>(
  dataDirectory: string,
  body: () => Promise<T>,
  /** What the command would do to an owned directory, for the refusal: "restoring would replace the database it is using". */
  refusal?: string,
): Promise<T> {
  const { acquireDataDirectoryOwnership } = await import("@tavi/runtime");
  let ownership: Awaited<ReturnType<typeof acquireDataDirectoryOwnership>> | undefined;
  try {
    ownership = await acquireDataDirectoryOwnership({ dataDirectory, sessionId: `cli-${process.pid}` });
  } catch (error) {
    throw await ownershipRefusal(error, dataDirectory, refusal);
  }
  try {
    return await body();
  } finally {
    await ownership?.release();
  }
}

/** Options whose data directory has already been put through {@link resolveDataDirectory}. */
export type ResolvedDataDirectory<T extends { readonly dataDirectory?: string }> = Omit<T, "dataDirectory"> & {
  readonly dataDirectory: string;
};

/** Apply the single data-directory resolution order to a parsed command. */
export function resolveCommand<T extends { readonly dataDirectory?: string }>(options: T): ResolvedDataDirectory<T> {
  return { ...options, dataDirectory: resolveDataDirectory(options.dataDirectory) };
}
