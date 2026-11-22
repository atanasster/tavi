import {
  BrowseAnswerSchema,
  FOLDER_READ_CHUNK_BYTES,
  FOLDER_READ_MAX_BYTES,
  FolderFilesAnswerSchema,
  FolderReadAnswerSchema,
  FolderViewSchema,
  type BrowseAnswer,
  type ChatFolderMode,
  type FolderFilesAnswer,
  type FolderReadAnswer,
  type FolderView,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { readChunks } from "../../lib/chunks.js";
import { translateNow } from "../../lib/i18n.js";
import { saveFile } from "../../lib/download.js";
import { read, type Outcome, type SettingsClient } from "../../lib/ipc.js";

/**
 * A chat's working folder from the canvas:
 * the owner's `folder` and `browse` commands. The page never names a host
 * path (I-web): a host folder is chosen by a `browse` token, valid on this
 * connection only, and a chat's own folder by `{ managed: true }`.
 */

/** The owner commands the folder chip and its panel need; each is feature-detected on `ready.features`. */
export const FOLDER_FEATURE = "folder";
export const BROWSE_FEATURE = "browse";

/** Where a chat may work: its own folder, or one a `browse` answer offered. */
export type FolderPick = { readonly managed: true } | { readonly pick: string };

const target = (workspaceId: string, taskId: string) => ({ workspaceId, taskId });

/** The chat's folder now: primary, attachments, unavailable. */
export function showFolder(client: SettingsClient, workspaceId: string, taskId: string): Promise<Outcome<FolderView>> {
  return read(client, "folder", { action: "show", ...target(workspaceId, taskId) }, FolderViewSchema);
}

/** Work in the chat's own folder, or in a folder the picker offered. */
export function setFolder(client: SettingsClient, workspaceId: string, taskId: string, folder: FolderPick): Promise<Outcome<FolderView>> {
  return read(
    client,
    "folder",
    { action: "set", ...target(workspaceId, taskId), folder: "managed" in folder ? { managed: true } : { pick: folder.pick } },
    FolderViewSchema,
  );
}

/** Attach a folder the picker offered, read-only or read-write. */
export function attachFolder(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  pick: string,
  mode: ChatFolderMode,
): Promise<Outcome<FolderView>> {
  return read(client, "folder", { action: "attach", ...target(workspaceId, taskId), folder: { pick }, mode }, FolderViewSchema);
}

export function detachFolder(client: SettingsClient, workspaceId: string, taskId: string, label: string): Promise<Outcome<FolderView>> {
  return read(client, "folder", { action: "detach", ...target(workspaceId, taskId), label }, FolderViewSchema);
}

/** Back to the origin's defaults: the remedy for a folder that is gone. */
export function resetFolder(client: SettingsClient, workspaceId: string, taskId: string): Promise<Outcome<FolderView>> {
  return read(client, "folder", { action: "reset", ...target(workspaceId, taskId) }, FolderViewSchema);
}

/** One level of one of the chat's folders: `root` the primary when absent, `dir` relative to it. */
export function listFolderFiles(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  root?: string,
  dir?: string,
): Promise<Outcome<FolderFilesAnswer>> {
  return read(
    client,
    "folder",
    {
      action: "files",
      ...target(workspaceId, taskId),
      ...(root === undefined ? {} : { root }),
      ...(dir === undefined || dir === "" ? {} : { dir }),
    },
    FolderFilesAnswerSchema,
  );
}

/** The folders a chat may use: the `--fs-root` folders, or those inside the one `under` was issued for. */
export function browseFolders(client: SettingsClient, workspaceId: string, under?: string): Promise<Outcome<BrowseAnswer>> {
  return read(client, "browse", { workspaceId, ...(under === undefined ? {} : { under }) }, BrowseAnswerSchema);
}

/** The most chunks a download asks for: the size cap's worth, and the empty last one. */
const MAX_CHUNKS = Math.ceil(FOLDER_READ_MAX_BYTES / FOLDER_READ_CHUNK_BYTES) + 1;

const hex = (digest: ArrayBuffer): string => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A file of the chat's folder, read chunk by chunk: refused past
 * `FOLDER_READ_MAX_BYTES`; every chunk after the first carries the first
 * chunk's hash, so the owner refuses a file that changed; the chunks must
 * tile the file exactly; and the assembled bytes must hash to it. Folder
 * files are mutable, so each check fails in words rather than saving a mix.
 */
export async function readFolderFile(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  root: string | undefined,
  path: string,
): Promise<Outcome<{ readonly name: string; readonly bytes: Uint8Array<ArrayBuffer> }>> {
  const name = path.split("/").at(-1) ?? path;
  const changed = translateNow("chatPanel.download.changed", { name });
  let first: string | undefined;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let filled = 0;
  const last = await readChunks<FolderReadAnswer>(
    (offset) =>
      read(
        client,
        "folder",
        {
          action: "read",
          ...target(workspaceId, taskId),
          ...(root === undefined ? {} : { root }),
          path,
          offset,
          ...(first === undefined ? {} : { sha256: first }),
        },
        FolderReadAnswerSchema,
      ),
    (chunk) => {
      if (chunk.totalBytes > FOLDER_READ_MAX_BYTES)
        return translateNow("chatPanel.download.tooLargeMax", { name, size: String(FOLDER_READ_MAX_BYTES / (1024 * 1024)) });
      first ??= chunk.hash;
      bytes ??= new Uint8Array(chunk.totalBytes);
      if (chunk.totalBytes !== bytes.length) return changed;
      let part: Uint8Array;
      try {
        part = Uint8Array.from(atob(chunk.base64), (character) => character.charCodeAt(0));
      } catch {
        return translateNow("chatPanel.download.unreadable", { name });
      }
      // The chunks tile the file: each starts where the last ended, none is empty but an empty file's, none runs past the end.
      if (
        chunk.offset !== filled ||
        (part.length === 0 && bytes.length !== 0) ||
        chunk.offset + part.length > bytes.length ||
        (chunk.nextOffset !== null && chunk.nextOffset !== chunk.offset + part.length)
      )
        return translateNow("chatPanel.download.pieces", { name });
      bytes.set(part, chunk.offset);
      filled = chunk.offset + part.length;
      return undefined;
    },
    { changed, maxChunks: MAX_CHUNKS, tooLarge: translateNow("chatPanel.download.tooLarge", { name }) },
  );
  if (!last.ok) return last.code === "CONFLICT" ? { ok: false, message: changed, code: "CONFLICT" } : last;
  if (bytes === undefined || filled !== bytes.length)
    return { ok: false, message: translateNow("chatPanel.download.incomplete", { name }) };
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return { ok: false, message: translateNow("chatPanel.download.insecure") };
  let digest: string;
  try {
    digest = hex(await subtle.digest("SHA-256", bytes));
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  if (digest !== last.value.hash) return { ok: false, message: translateNow("chatPanel.download.checksum", { name }) };
  return { ok: true, value: { name: last.value.name, bytes } };
}

/** Read a file of the chat's folder and save it; answers why it was not saved, or nothing. */
export async function downloadFolderFile(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  root: string | undefined,
  path: string,
): Promise<string | undefined> {
  const file = await readFolderFile(client, workspaceId, taskId, root, path);
  if (!file.ok) return file.message;
  // Never the file's own type: a folder's HTML file is saved, not rendered on the canvas's origin.
  saveFile(file.value.bytes, "application/octet-stream", file.value.name);
  return undefined;
}
