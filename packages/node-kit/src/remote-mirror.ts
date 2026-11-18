import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The marker of a data directory that mirrors an owner on another computer
 * (`tavi remote connect`). Read by the runtime, which refuses to own such a
 * directory, and by CLI clients, which then send no path of this computer to
 * that owner. Here, with no Tavi dependency, so a light CLI path can read it
 * without loading the runtime.
 */
export const REMOTE_MIRROR_FILE = "remote.json";

export interface RemoteMirror {
  readonly version: 1;
  /** The SSH destination, as given to `tavi remote connect` (`brook@mini.lan`, a `Host` alias). */
  readonly target: string;
  /** The owner's data directory on that computer. */
  readonly remoteDataDirectory: string;
  /** The home directory of the SSH user there: what `~` in a folder path means to the owner. */
  readonly remoteHome: string;
}

/**
 * The mirror record of `dataDirectory`, or undefined for an ordinary data
 * directory. A marker that is present but unreadable, a symbolic link or not
 * a valid record throws: it still marks the directory, and refusing is the
 * safe reading.
 */
export function readRemoteMirrorFile(dataDirectory: string): RemoteMirror | undefined {
  const path = join(dataDirectory, REMOTE_MIRROR_FILE);
  if (!existsSync(path)) return undefined;
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} marks ${dataDirectory} as a remote mirror but is a symbolic link`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} marks ${dataDirectory} as a remote mirror but cannot be read (${String(error)})`);
  }
  if (!isRemoteMirror(parsed)) throw new Error(`${path} marks ${dataDirectory} as a remote mirror but is not a valid record`);
  return parsed;
}

function isRemoteMirror(value: unknown): value is RemoteMirror {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const text = (key: string): boolean => typeof record[key] === "string" && record[key] !== "";
  return record["version"] === 1 && text("target") && text("remoteDataDirectory") && text("remoteHome");
}
