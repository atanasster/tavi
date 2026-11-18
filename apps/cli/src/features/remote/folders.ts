import { posix } from "node:path";

import { TaviError } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { readRemoteMirrorFile } from "@tavi/node-kit";

/**
 * Folders, as a client of an owner on another computer names them.
 *
 * The owner checks a chat's folder on its own disk, so a path this computer
 * made up (its terminal's directory, its home) names nothing there, or worse,
 * names a different folder that happens to share the path. On a mirror
 * (`tavi remote connect`) a client therefore sends no `clientCwd`, reads `~`
 * as the remote user's home, and refuses a relative path.
 */
export interface RemoteFolders {
  /** The SSH destination the mirror reaches. */
  readonly target: string;
  /** The remote user's home: what `~` means to that owner. */
  readonly home: string;
}

/** The remote side of `dataDirectory` when it mirrors another computer's owner, else undefined. */
export function remoteFoldersOf(dataDirectory: string): RemoteFolders | undefined {
  let mirror;
  try {
    mirror = readRemoteMirrorFile(dataDirectory);
  } catch (error) {
    throw new TaviError("UNAVAILABLE", errorMessage(error), { details: { dataDirectory } });
  }
  return mirror === undefined ? undefined : { target: mirror.target, home: mirror.remoteHome };
}

/** The `clientCwd` a run may carry: this terminal's directory, but never to an owner on another computer. */
export function clientCwdFor(dataDirectory: string, cwd: string = process.cwd()): { readonly clientCwd?: string } {
  return remoteFoldersOf(dataDirectory) === undefined ? { clientCwd: cwd } : {};
}

/**
 * A folder typed for a remote owner: `~` and `~/…` under its home, an absolute
 * POSIX path as written, and a relative path refused, since it is relative to
 * a directory on this computer.
 */
export function remotePathOf(typed: string, remote: RemoteFolders): string {
  const trimmed = typed.trim();
  if (trimmed === "~") return remote.home;
  if (trimmed.startsWith("~/")) return posix.join(remote.home, trimmed.slice(2));
  if (posix.isAbsolute(trimmed)) return posix.normalize(trimmed);
  throw new TaviError(
    "INVALID_INPUT",
    `"${trimmed}" is relative to a folder on this computer, but the owner runs on ${remote.target}: ` +
      "name the folder there by its absolute path, or by ~/…",
  );
}
