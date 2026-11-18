import { TaviError } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { type RemoteMirror, readRemoteMirrorFile } from "@tavi/node-kit";

/**
 * A data directory that mirrors an owner on another computer.
 *
 * `tavi remote connect <ssh-target>` keeps a local directory whose `runtime/`
 * holds the remote owner's discovery (its endpoint rewritten to a socket
 * forwarded over SSH) and a copy of its token, so every client here attaches
 * to that owner as it would to a local one. The directory holds no database
 * and must never become one: `remote.json` marks it, ownership of it is
 * refused (so no offline command or `tavi serve` opens it), and a client that
 * cannot reach the remote owner says so instead of falling back to it.
 */
export { REMOTE_MIRROR_FILE, type RemoteMirror } from "@tavi/node-kit";

/** The mirror record of `dataDirectory`, or undefined for an ordinary data directory; a broken marker is `UNAVAILABLE`. */
export function readRemoteMirror(dataDirectory: string): RemoteMirror | undefined {
  try {
    return readRemoteMirrorFile(dataDirectory);
  } catch (error) {
    throw new TaviError("UNAVAILABLE", errorMessage(error), { details: { dataDirectory } });
  }
}

/** Why a remote mirror cannot be opened as a data directory of its own. */
export function remoteMirrorRefusal(dataDirectory: string, mirror: RemoteMirror): TaviError {
  return new TaviError(
    "UNAVAILABLE",
    `${dataDirectory} mirrors the owner on ${mirror.target} (${mirror.remoteDataDirectory}); it holds no data of its own. ` +
      `Run \`tavi remote connect ${mirror.target}\` and keep it running, then run this again.`,
    { details: { dataDirectory, remote: mirror.target } },
  );
}
