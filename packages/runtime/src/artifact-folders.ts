import { lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  FOLDER_FILE_NAME_VARIANTS,
  TaviError,
  folderFileName,
  folderFileNameVariant,
  type ArtifactFolderCopy,
  type ArtifactRecord,
  type ArtifactRepositoryPort,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { openNoFollow, readNoFollow, sameIdentity, sha256Hex, type FileIdentity } from "@tavi/node-kit";

/**
 * Approved artifacts copied into their chat's folder: a browser download into `downloads/`, a PDF
 * report into `reports/`, in the chat's **managed** folder — never a host
 * primary — so the shell and the file tools find them where the chat works.
 *
 * Only an `approved` artifact is copied (I-pending): `materialize` reads the
 * review state itself, so a caller that runs it on a pending or rejected
 * artifact copies nothing. The copy is a copy, never a hard link, so a later
 * edit of the folder file never reaches the reviewed bytes. It is written
 * without following a link the sandbox could have planted (I-nofollow):
 * `downloads/` (or `reports/`) is made one level under the managed folder and
 * `lstat`ed, the file is created `O_CREAT | O_EXCL | O_NOFOLLOW`, and the
 * path must still resolve to the descriptor's own inode before a byte is
 * written. The name is the artifact's own, made safe (`folderFileName`); a
 * taken name gets ` (2)`, ` (3)`, … — unless that file already holds exactly
 * these bytes, when nothing is copied again.
 *
 * A copy that cannot be made never undoes or fails the approval it follows:
 * the outcome says why, and the caller logs it.
 */

export type MaterializeOutcome =
  | { readonly status: "copied"; readonly path: string }
  /** A file in the folder already holds these bytes under the name or a suffixed one. */
  | { readonly status: "present"; readonly path: string }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

export interface ArtifactMaterializerOptions {
  readonly artifacts: Pick<ArtifactRepositoryPort, "getArtifact" | "readArtifactBody">;
  /** The managed folder of a task's chat (`ChatFolders.managedFolderOf`). */
  readonly folders: { managedFolderOf(workspaceId: string, taskId: string): Promise<string> };
  /** Where a copy that could not be made is reported; the approval stands. */
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
  /**
   * The free-space floor and the folder's budget: a copy into
   * a full folder, or onto a disk under its floor, is not made — the approval
   * stands, and approving again retries it once there is room.
   */
  readonly space?: { admitManagedWrite(managed: string, taskId?: string): Promise<void> };
  /** Runs between the folder's last check and each open: the seam a test swaps the folder through, to show what the race leaves. */
  readonly beforeOpen?: () => Promise<void>;
}

/** Copy an approved artifact into its chat's folder; never throws. */
export type MaterializeArtifact = (artifactId: string) => Promise<MaterializeOutcome>;

/** The name a copy gets when its record has none, or one that cleans to nothing. */
function fallbackName(record: ArtifactRecord, folder: ArtifactFolderCopy): string {
  const extension = record.relativePath.split(".").pop() ?? "bin";
  return `${folder === "reports" ? "report" : "download"}-${record.artifactId.slice(4, 12)}.${extension}`;
}

export function createArtifactMaterializer(options: ArtifactMaterializerOptions): MaterializeArtifact {
  return async (artifactId) => {
    let outcome: MaterializeOutcome;
    try {
      outcome = await materialize(options, artifactId);
    } catch (error) {
      outcome = { status: "failed", reason: errorMessage(error) };
    }
    if (outcome.status === "failed")
      options.log?.("an approved artifact could not be copied into its chat's folder", { artifactId, reason: outcome.reason });
    return outcome;
  };
}

async function materialize(options: ArtifactMaterializerOptions, artifactId: string): Promise<MaterializeOutcome> {
  const record = await options.artifacts.getArtifact(artifactId);
  if (record === undefined) return { status: "skipped", reason: "no such artifact" };
  const folder = record.folderCopy;
  if (folder === undefined) return { status: "skipped", reason: "not an artifact copied into a folder" };
  // I-pending: what is not approved is never copied, whoever asked.
  if (record.reviewState !== "approved") return { status: "skipped", reason: `the artifact is ${record.reviewState}` };
  if (record.runId === null) return { status: "skipped", reason: "the artifact belongs to no chat" };
  const body = await options.artifacts.readArtifactBody(artifactId);
  if (body === undefined) return { status: "failed", reason: "the artifact's body is missing" };
  // What was reviewed is what is copied: a body that no longer matches its record is not.
  const sha256 = sha256Hex(body);
  if (body.byteLength !== record.byteSize || sha256 !== record.sha256)
    return { status: "failed", reason: "the artifact's body does not match its record" };
  const managed = await options.folders.managedFolderOf(record.workspaceId, record.runId);
  const name = folderFileName(record.fileName ?? "", fallbackName(record, folder));
  if (options.space !== undefined) {
    try {
      // A refusal names the prune that clears this chat's folder (`--chat` takes a worker's id for its chat's).
      await options.space.admitManagedWrite(managed, record.runId);
    } catch (error) {
      return { status: "failed", reason: errorMessage(error) };
    }
  }
  return await writeCopy(managed, folder, name, body, sha256, options.beforeOpen);
}

/** An error's `code`, when it has one (a Node system error). */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** A plain folder as checked: its path and the inode it named then. */
interface CheckedFolder extends FileIdentity {
  readonly path: string;
}

/**
 * `downloads/` or `reports/` under `managed`, made if missing and never a
 * link: it must be a plain folder that resolves to itself.
 */
async function folderIn(managed: string, folder: ArtifactFolderCopy): Promise<CheckedFolder> {
  const directory = join(managed, folder);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const status = await lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory())
    throw new TaviError("NOT_AUTHORIZED", `${directory} is not a plain folder; a copy never passes through a link`);
  if ((await realpath(directory)) !== directory)
    throw new TaviError("NOT_AUTHORIZED", `${directory} resolves elsewhere; a copy never passes through a link`);
  return { path: directory, dev: status.dev, ino: status.ino, birthtimeMs: status.birthtimeMs };
}

/** Whether the folder is still the one checked: the same inode, not a link, resolving to itself. */
async function stillThere(folder: CheckedFolder): Promise<boolean> {
  // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
  const status = await lstat(folder.path).catch(() => undefined);
  if (status === undefined || status.isSymbolicLink() || !status.isDirectory() || !sameIdentity(status, folder)) return false;
  // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
  return (await realpath(folder.path).catch(() => undefined)) === folder.path;
}

/** Whether `path` is a plain, single-named file holding exactly these bytes; never follows a link. */
async function holds(path: string, size: number, sha256: string): Promise<boolean> {
  // A file with another name may change through it: it is not this copy.
  const bytes = await readNoFollow(path, { singleLink: true, maxBytes: size }).catch(() => undefined);
  return bytes !== undefined && bytes.byteLength === size && sha256Hex(bytes) === sha256;
}

/**
 * Create the copy under the first free name. Node has no `openat`, so
 * `O_NOFOLLOW` guards only the file's own name: the folder is checked again
 * just before each open and again after it (the same inode, still resolving
 * to itself), and the opened file must be the one the path names, before a
 * byte is written. A folder swapped for a link between the last check and
 * the open is still followed by the open: nothing is written then, and the
 * empty file it made at the link's target is left there (removed only while
 * the folder is still the one checked).
 */
async function writeCopy(
  managed: string,
  folder: ArtifactFolderCopy,
  name: string,
  body: Uint8Array,
  sha256: string,
  beforeOpen?: () => Promise<void>,
): Promise<MaterializeOutcome> {
  const checked = await folderIn(managed, folder);
  const directory = checked.path;
  const changed = () => new TaviError("NOT_AUTHORIZED", `${directory} changed while a copy was being made; nothing was copied`);
  for (let index = 1; index <= FOLDER_FILE_NAME_VARIANTS; index += 1) {
    const candidate = join(directory, folderFileNameVariant(name, index));
    if (!(await stillThere(checked))) throw changed();
    await beforeOpen?.();
    let handle;
    try {
      handle = await openNoFollow(candidate, "create", { mode: 0o644 });
    } catch (error) {
      // Taken — by a file, a folder or a link, none of which is followed.
      if (errorCode(error) !== "EEXIST") throw error;
      if (await holds(candidate, body.byteLength, sha256)) return { status: "present", path: candidate };
      continue;
    }
    let written = false;
    let info: FileIdentity | undefined;
    try {
      info = await handle.stat();
      // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
      const again = await realpath(candidate).catch(() => undefined);
      // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
      const named = again === undefined ? undefined : await lstat(again).catch(() => undefined);
      if (!(await stillThere(checked)) || again !== candidate || named === undefined || !sameIdentity(named, info)) throw changed();
      await handle.writeFile(body);
      written = true;
    } finally {
      await handle.close();
      // A copy cut short (a full disk, a swapped folder) is not left under the artifact's name — removed only
      // while the folder is still the one checked and the name still holds the file this call made.
      if (!written && info !== undefined && (await stillThere(checked))) {
        // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
        const left = await lstat(candidate).catch(() => undefined);
        // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
        if (left !== undefined && left.isFile() && sameIdentity(left, info)) await unlink(candidate).catch(() => undefined);
      }
    }
    return { status: "copied", path: candidate };
  }
  return { status: "failed", reason: `${directory} already holds ${FOLDER_FILE_NAME_VARIANTS} files named like ${name}` };
}
