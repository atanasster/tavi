import { TaviError } from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";

/**
 * Finding the live owner of a data directory, apart from `serve.ts`.
 *
 * Every attached command can reach it (`connectLiveOwner` asks it when a first
 * connection to the published owner fails, and tests ask it directly), so it
 * lives in a module of its own: importing it from the owner's `serve.ts` pulled
 * the whole owner (composition, workflow, plugins) into every CLI command's
 * start-up. The functions it reads
 * the discovery files with come from `@tavi/runtime/owner-attach`, loaded when
 * it runs: never the runtime's root, which loads the database client.
 */

/**
 * Attach to a live owner, if one exists.
 *
 * A foreground command never becomes a second writer: it either resolves the
 * live owner's discovery metadata and connects, or reports that no owner is
 * running. The token is read here and never placed in argv or a child
 * environment.
 */
export async function findLiveOwner(
  dataDirectory: string,
): Promise<
  { readonly sessionId: string; readonly endpoint: string; readonly token: string; readonly protocolVersion: number } | undefined
> {
  // Loaded when called, so importing this module stays cheap for every command.
  const { readDiscovery, readToken } = await import("@tavi/runtime/owner-attach");
  // `tavi serve` holds the directory a moment before it publishes where it
  // answers: a command in that window waits for it rather than finding no
  // owner and being refused by the lock it holds.
  const discovery = readDiscovery(dataDirectory) ?? (await startingOwnerDiscovery(dataDirectory));
  if (discovery === undefined) return undefined;

  // The three discovery files are removed only on a *clean* shutdown
  // (`shutdown`'s own `clearDiscovery`/`clearToken`), so a SIGKILL or a power loss
  // leaves them behind while the OS has already released `owner.lock`. Without
  // this probe the CLI trusts the leftovers, fails to connect, and reports "An
  // owner is running … but did not answer" for a process that is dead — and
  // `tavi tasks`/`doctor` then exit 4 until someone deletes three undocumented
  // files by hand.
  if (await takeOverStaleDiscovery(dataDirectory)) return undefined;

  // Read the token only after the staleness probe: when discovery exists but the
  // token does not, returning early would skip the probe entirely, so the
  // half-cleared pair would be re-read on every command and nothing would tidy it.
  const token = readToken(dataDirectory);
  if (token === undefined) return undefined;

  return {
    sessionId: discovery.sessionId,
    endpoint: discovery.endpoint,
    token,
    protocolVersion: discovery.protocolVersion,
  };
}

/** How long a command waits for a starting `tavi serve` to publish where it answers. */
const STARTING_OWNER_WAIT_MS = 15_000;
const STARTING_OWNER_POLL_MS = 50;

/**
 * The discovery a starting `tavi serve` publishes, waited for while its
 * process holds the directory and is alive: undefined at once when no serve
 * holds it (no owner, or another command that never answers over IPC), when
 * the serve holding it is stopping (it marked so when it withdrew), when
 * the starting owner stops, or after `STARTING_OWNER_WAIT_MS`.
 */
async function startingOwnerDiscovery(
  dataDirectory: string,
): Promise<ReturnType<typeof import("@tavi/runtime/owner-attach").readDiscovery>> {
  const { SERVE_SESSION_PREFIX, liveOwnerProcess, readDiscovery, readStopping } = await import("@tavi/runtime/owner-attach");
  const starting = liveOwnerProcess(dataDirectory);
  if (starting === undefined || !starting.sessionId.startsWith(SERVE_SESSION_PREFIX)) return undefined;
  // An owner draining after it withdrew its discovery is stopping, not starting: nothing to wait for.
  if (readStopping(dataDirectory) === starting.sessionId) return undefined;
  const deadline = Date.now() + STARTING_OWNER_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(STARTING_OWNER_POLL_MS);
    const discovery = readDiscovery(dataDirectory);
    if (discovery !== undefined) return discovery;
    // The owner that was starting stopped, or another took its place: nothing to wait for.
    const holder = liveOwnerProcess(dataDirectory);
    if (holder === undefined || holder.sessionId !== starting.sessionId) return undefined;
  }
  return undefined;
}

/**
 * Clear discovery left by a dead owner, and report whether it did.
 *
 * The cleanup runs **while holding the owner lock**, which is the whole point: an
 * earlier version probed the lock, released it, and only then deleted the files —
 * so a different owner that acquired and published in that window had its
 * credentials deleted by a command that was merely listing tasks. Holding the lock
 * across the delete is what makes that impossible; no owner can be publishing
 * while this function is inside it.
 *
 * Returns `false` — and touches nothing — whenever the lock cannot be taken,
 * including a `CONFLICT` from a launcher that is mid-acquisition. Refusing is the
 * safe direction, and the false-refusal case (the lock is *free*
 * because the owner is dead) still resolves to `true`.
 */
async function takeOverStaleDiscovery(dataDirectory: string): Promise<boolean> {
  const { acquireDataDirectoryOwnership, clearDiscovery, clearToken } = await import("@tavi/runtime/owner-attach");
  let probe: Awaited<ReturnType<typeof acquireDataDirectoryOwnership>>;
  try {
    probe = await acquireDataDirectoryOwnership({
      dataDirectory,
      sessionId: `probe-${process.pid}-${Date.now()}`,
      // A probe: one attempt, so a live owner is reported in milliseconds rather
      // than after the upgrade retry launchers need (≈1 s, paid by every
      // attached command before the retry was bounded by this timeout).
      lockTimeoutMs: 0,
    });
  } catch {
    // `CONFLICT` means somebody owns the directory, or a launcher is acquiring it;
    // any other failure (permissions, an unreadable lock file) must be read the
    // same way. Only a lock we actually hold lets us touch the files.
    return false;
  }
  clearDiscovery(dataDirectory);
  clearToken(dataDirectory);
  const release = await probe.release();
  if (!release.released) {
    // `release()` reports rather than throws, so the result must be checked: a
    // leaked lock would otherwise be reported as a free directory, and the next
    // command would fail against a lock this process still holds.
    throw new TaviError(
      "UNAVAILABLE",
      `Cleared stale owner discovery on ${dataDirectory} but could not release the ownership probe: ${release.error ?? "unknown error"}`,
      { details: { dataDirectory } },
    );
  }
  return true;
}
