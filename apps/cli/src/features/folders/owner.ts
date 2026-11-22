import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

import { openNoFollow, sameIdentity } from "@tavi/node-kit";

import {
  DEFAULT_WORKSPACE_ID,
  FOLDER_BROWSE_MAX_DEPTH,
  FOLDER_BROWSE_MAX_ENTRIES,
  FOLDER_FILES_MAX_ENTRIES,
  FOLDER_READ_CHUNK_BYTES,
  FOLDER_READ_MAX_BYTES,
  MANAGED_FOLDER_LABEL,
  TaviError,
  keyedError,
  byteSize,
  type BrowseAnswer,
  type BrowseEntry,
  type BrowsePayload,
  type ChatFolder,
  type ChatFolderCaller,
  type ChatFolderChange,
  type FolderFilesAnswer,
  type FolderPayload,
  type FolderReadAnswer,
  type FolderRoot,
  type FolderView,
  type PersistencePort,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { ChatFolders, FolderSpace, FolderUsage } from "@tavi/runtime";

import type { FolderReadScope } from "./fs-tools.js";
import { refusalFrom, type IpcAnswer } from "../../shared/ipc-decisions.js";
import { GLYPHS } from "../../tui/theme.js";
import { type RemoteFolders, remotePathOf } from "../remote/folders.js";

/**
 * A chat's working folder over IPC: the
 * `folder` command — show, change, list, download — and `browse`, the
 * canvas's attach picker.
 *
 * The web bridge never names a host path (I-web). `browse` lists the folders
 * under the `--fs-root` set and answers each with a token issued on the
 * asking connection (`FolderPicks`); a page redeems a token where a terminal
 * client sends a path, and `ChatFolders` validates the path behind it again.
 * A path from the bridge is refused by `ChatFolders.set` itself.
 */

/** How many picker tokens one connection holds; the oldest go first. */
const PICKS_PER_CONNECTION = 4_096;

/**
 * The picker tokens one connection was issued (`browse`): a token maps to the
 * real path it was issued for, and means nothing on any other connection.
 */
export class FolderPicks {
  readonly #paths = new Map<string, string>();

  issue(path: string): string {
    const token = randomBytes(18).toString("base64url");
    this.#paths.set(token, path);
    if (this.#paths.size > PICKS_PER_CONNECTION) {
      const oldest = this.#paths.keys().next().value;
      if (oldest !== undefined) this.#paths.delete(oldest);
    }
    return token;
  }

  /** The path a token was issued for here, or undefined for one this connection was never given. */
  redeem(token: string): string | undefined {
    return this.#paths.get(token);
  }
}

/** `path` under `root` or equal to it, by separator-aware `path.relative` — never a string prefix. */
function within(path: string, root: string): boolean {
  const between = relative(root, path);
  return between === "" || (between !== ".." && !between.startsWith(`..${sep}`) && !isAbsolute(between));
}

export interface FolderCommandDependencies {
  readonly folders: Pick<ChatFolders, "resolve" | "set" | "managedFolderPath" | "revisionOf" | "attachableRoots" | "refusalOf">;
  readonly repositories: Pick<PersistencePort["repositories"], "tasks">;
  /** The operator principal a workspace is served for, or undefined for one this owner does not serve. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  /** The front end that asked, from the connection: `web` never names a path. */
  readonly frontEnd: "web" | "ipc";
  /** The tokens this connection was issued; absent, a `pick` is never redeemed. */
  readonly picks?: FolderPicks;
  /** How `fs.read` and `fs.list` reach a resolved folder (`folderReadScope`): `files` and `read` reach no further. */
  readonly readScope: (folder: ChatFolder) => FolderReadScope;
  /** The folders' budget: `show` states the chat's folder against it. */
  readonly space?: Pick<FolderSpace, "usage">;
}

/** A refusal, as the other commands answer one. */
function refusal(error: unknown): IpcAnswer<never> {
  return refusalFrom(error, TaviError.from(error).details);
}

/** The workspace's operator, and the chat when it is theirs in that workspace; `NOT_FOUND` alike for anything else. */
async function chatScope(
  deps: FolderCommandDependencies,
  workspaceId: string | undefined,
  taskId: string,
): Promise<{ readonly workspaceId: string; readonly principalId: string }> {
  const workspace = workspaceId ?? DEFAULT_WORKSPACE_ID;
  const principalId = deps.principalOf(workspace);
  if (principalId === undefined)
    throw keyedError("NOT_FOUND", "error.workspace.notConfigured", { workspaceId: workspace }, { details: { workspaceId: workspace } });
  const task = await deps.repositories.tasks.get(taskId);
  if (task === undefined || task.workspaceId !== workspace || task.principalId !== principalId)
    throw keyedError("NOT_FOUND", "error.task.notFound", { taskId });
  return { workspaceId: workspace, principalId };
}

/** A resolved folder as `show` answers it, with its budget when the owner keeps one. */
function folderView(taskId: string, folder: ChatFolder, usage?: FolderUsage): FolderView {
  return {
    taskId,
    revision: folder.revision,
    managed: folder.managed,
    primary: {
      kind: folder.primaryKind,
      path: folder.primary,
      label: folder.primaryKind === "managed" ? MANAGED_FOLDER_LABEL : basename(folder.primary) || folder.primary,
    },
    attachments: folder.attachments.map((attachment) => ({ ...attachment })),
    ...(folder.managedUnavailable === undefined ? {} : { managedUnavailable: folder.managedUnavailable }),
    ...(usage === undefined
      ? {}
      : {
          budget: {
            bytes: usage.bytes,
            capBytes: usage.capBytes,
            ...(usage.approximate === undefined ? {} : { approximate: true as const }),
            ...(usage.warning === undefined ? {} : { warning: usage.warning.slice(0, 1_000) }),
          },
        }),
  };
}

/** The chat's folder now, or — when its host folder is gone or no longer allowed — why, with Reset as the remedy. */
async function view(
  deps: FolderCommandDependencies,
  scope: { readonly workspaceId: string; readonly principalId: string },
  taskId: string,
): Promise<FolderView> {
  try {
    const folder = await deps.folders.resolve(scope, taskId);
    return folderView(taskId, folder, await deps.space?.usage(folder.managed, { taskId }));
  } catch (error) {
    const failure = TaviError.from(error);
    if (failure.code !== "UNAVAILABLE") throw failure;
    return {
      taskId,
      revision: await deps.folders.revisionOf(taskId),
      managed: await deps.folders.managedFolderPath(scope.workspaceId, taskId),
      attachments: [],
      unavailable: failure.message.slice(0, 1_000),
    };
  }
}

/** The path a `{ path }` or `{ pick }` names, and the caller to change the folder as. */
function sourceOf(
  deps: FolderCommandDependencies,
  source: { readonly path: string } | { readonly pick: string },
): { readonly path: string; readonly caller: ChatFolderCaller } {
  if ("path" in source) return { path: source.path, caller: { frontEnd: deps.frontEnd } };
  const path = deps.picks?.redeem(source.pick);
  if (path === undefined) throw keyedError("NOT_FOUND", "error.folders.noLongerOffered");
  return { path, caller: { frontEnd: deps.frontEnd, picked: true } };
}

/** The folders `files` and `read` reach: the primary, the managed folder when it is not the primary, and each attachment. */
function rootsOf(folder: ChatFolder): readonly FolderRoot[] {
  return [
    {
      id: "primary",
      label: folder.primaryKind === "managed" ? MANAGED_FOLDER_LABEL : basename(folder.primary) || folder.primary,
      path: folder.primary,
      mode: "rw",
    },
    ...(folder.primaryKind === "host" ? [{ id: "managed", label: MANAGED_FOLDER_LABEL, path: folder.managed, mode: "rw" as const }] : []),
    ...folder.attachments.map((attachment) => ({
      id: `attachment:${attachment.label}`,
      label: attachment.label,
      path: attachment.path,
      mode: attachment.mode,
    })),
  ];
}

/**
 * A path inside one of the chat's folders, resolved and confined as `fs.read`
 * resolves one (`scope`: the data directory closed but for the chat's own
 * managed folders, the credential homes refused), and still inside the
 * folder named once every link is resolved; whether it lies in a managed
 * folder, where a hard-linked file is refused.
 */
async function inside(
  folder: ChatFolder,
  scope: FolderReadScope,
  rootId: string | undefined,
  relativePath: string,
): Promise<{ readonly root: FolderRoot; readonly rootReal: string; readonly real: string; readonly managed: boolean }> {
  const roots = rootsOf(folder);
  const root = roots.find((entry) => entry.id === (rootId ?? "primary"));
  if (root === undefined)
    throw rootId === undefined
      ? keyedError("NOT_FOUND", "error.folders.noPrimaryFolder")
      : keyedError("NOT_FOUND", "error.folders.noFolder", { rootId });
  const rootReal = await realpath(root.path);
  const parts = relativePath.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) throw keyedError("INVALID_INPUT", "error.folders.pathWithDots");
  const real = scope.resolve(join(rootReal, ...parts));
  try {
    await lstat(real);
  } catch {
    throw keyedError("NOT_FOUND", "error.folders.pathMissing", {
      path: relativePath === "" ? root.label : relativePath,
      folder: root.label,
    });
  }
  if (!within(real, rootReal)) throw keyedError("NOT_AUTHORIZED", "error.folders.leadsOutside", { path: relativePath, folder: root.label });
  return { root, rootReal, real, managed: scope.inManagedFolder(real) };
}

/** The scratch and home of a managed folder, which `files` does not list (`.tmp/` is emptied, `.home/` is the sandbox's). */
const MANAGED_HIDDEN = new Set([".tmp", ".home"]);

async function listFiles(
  taskId: string,
  folder: ChatFolder,
  scope: FolderReadScope,
  rootId: string | undefined,
  dir: string,
): Promise<FolderFilesAnswer> {
  const { root, rootReal, real, managed } = await inside(folder, scope, rootId, dir);
  if (!(await stat(real)).isDirectory()) throw keyedError("INVALID_INPUT", "error.folders.notAFolder", { path: dir });
  // A protected entry is left out: it is never read, though `fs.list` still names it.
  const names = (await readdir(real))
    .filter((name) => !(managed && real === rootReal && MANAGED_HIDDEN.has(name)) && !scope.hidden(join(real, name)))
    .sort((a, b) => a.localeCompare(b));
  const entries: FolderFilesAnswer["entries"][number][] = [];
  for (const name of names.slice(0, FOLDER_FILES_MAX_ENTRIES)) {
    try {
      const status = await lstat(join(real, name));
      const kind = status.isFile() ? "file" : status.isDirectory() ? "directory" : status.isSymbolicLink() ? "link" : "other";
      entries.push({ name, kind, size: kind === "file" ? status.size : 0, modifiedAt: status.mtime.toISOString() });
    } catch {
      // Gone since it was listed.
    }
  }
  entries.sort((a, b) => ((a.kind === "directory") === (b.kind === "directory") ? 0 : a.kind === "directory" ? -1 : 1));
  return {
    taskId,
    root,
    roots: [...rootsOf(folder)],
    dir: relative(rootReal, real).split(sep).join("/"),
    entries,
    truncated: names.length > FOLDER_FILES_MAX_ENTRIES,
  };
}

/** The SHA-256 of an open file's whole body, read through its descriptor. */
async function hashOf(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(Math.min(FOLDER_READ_CHUNK_BYTES, Math.max(size, 1)));
  for (let position = 0; ; ) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

/**
 * One chunk of a file in the chat's folders, for a download. Checked at
 * every chunk: the path resolves inside the folder, the file is opened
 * without following a link and is the file resolved, a file in a managed
 * folder has one name, and it is at most `FOLDER_READ_MAX_BYTES`. The
 * first chunk answers the file's SHA-256; every later one must name it, and
 * the last hashes the file again — folder files are mutable, so a file that
 * changed meanwhile is refused rather than handed over spliced.
 */
export async function readChunk(
  taskId: string,
  folder: ChatFolder,
  scope: FolderReadScope,
  rootId: string | undefined,
  path: string,
  offset: number,
  expected: string | undefined,
): Promise<FolderReadAnswer> {
  if (offset > 0 && expected === undefined)
    throw new TaviError("INVALID_INPUT", "a chunk after the first names the file's sha256 the first chunk answered");
  const { real, managed } = await inside(folder, scope, rootId, path);
  const handle = await openNoFollow(real, "read").catch((error: unknown) => {
    throw keyedError("NOT_FOUND", "error.folders.couldNotOpen", { path, reason: errorMessage(error) });
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw keyedError("INVALID_INPUT", "error.folders.notAFile", { path });
    // Resolved again once open, as `fs.read` does: an ancestor swapped for a link meanwhile is followed by the open
    // and by an `lstat` alike, so the path must still resolve to itself, confined, and name the open file.
    const again = await realpath(real).catch(() => undefined);
    // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
    const named = again === undefined ? undefined : await lstat(again).catch(() => undefined);
    let confined = false;
    try {
      confined = again !== undefined && scope.resolve(again) === real;
    } catch {
      confined = false;
    }
    if (again !== real || !confined || named === undefined || !sameIdentity(named, opened))
      throw keyedError("CONFLICT", "error.folders.changedWhileOpened", { path });
    if (managed && opened.nlink > 1) throw keyedError("NOT_AUTHORIZED", "error.folders.hardLink", { path });
    if (opened.size > FOLDER_READ_MAX_BYTES)
      throw keyedError("UNSUPPORTED", "error.folders.overDownloadLimit", { path, size: String(FOLDER_READ_MAX_BYTES / (1024 * 1024)) });
    if (offset > opened.size || (offset > 0 && offset === opened.size))
      throw new TaviError("INVALID_INPUT", `offset ${offset} is past the end of ${path}`);
    const buffer = Buffer.alloc(Math.min(FOLDER_READ_CHUNK_BYTES, opened.size - offset));
    const { bytesRead } = buffer.length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, buffer.length, offset);
    const end = offset + bytesRead;
    const last = end >= opened.size;
    let hash = expected;
    if (offset === 0) hash = await hashOf(handle, opened.size);
    else if (last && (await hashOf(handle, opened.size)) !== expected)
      throw keyedError("CONFLICT", "error.folders.changedWhileDownloaded", { path });
    return {
      taskId,
      name: basename(real),
      hash: hash as string,
      totalBytes: opened.size,
      offset,
      base64: buffer.subarray(0, bytesRead).toString("base64"),
      nextOffset: last ? null : end,
    };
  } finally {
    await handle.close();
  }
}

/**
 * `folder`: a chat's working folder — show it, change it from the
 * chat's next message, list it and download from it. A change from
 * the web bridge names a folder only by a token `browse` issued on its own
 * connection (I-web).
 */
export async function folderCommand(
  deps: FolderCommandDependencies,
  payload: FolderPayload,
): Promise<IpcAnswer<FolderView | FolderFilesAnswer | FolderReadAnswer>> {
  try {
    const scope = await chatScope(deps, payload.workspaceId, payload.taskId);
    const change = async (next: ChatFolderChange, caller: ChatFolderCaller): Promise<IpcAnswer<FolderView>> => ({
      ok: true,
      result: folderView(payload.taskId, await deps.folders.set(scope, payload.taskId, next, caller)),
    });
    switch (payload.action) {
      case "show":
        return { ok: true, result: await view(deps, scope, payload.taskId) };
      case "set": {
        if ("managed" in payload.folder) return await change({ kind: "managed" }, { frontEnd: deps.frontEnd });
        const source = sourceOf(deps, payload.folder);
        return await change({ kind: "primary", path: source.path }, source.caller);
      }
      case "attach": {
        const source = sourceOf(deps, payload.folder);
        return await change(
          { kind: "attach", path: source.path, ...(payload.mode === undefined ? {} : { mode: payload.mode }) },
          source.caller,
        );
      }
      case "detach":
        return await change({ kind: "detach", label: payload.label }, { frontEnd: deps.frontEnd });
      case "reset":
        // A folder that is gone is cleared too: reset reads no stored folder.
        return await change({ kind: "reset" }, { frontEnd: deps.frontEnd });
      case "files": {
        const folder = await deps.folders.resolve(scope, payload.taskId);
        return { ok: true, result: await listFiles(payload.taskId, folder, deps.readScope(folder), payload.root, payload.dir ?? "") };
      }
      case "read": {
        const folder = await deps.folders.resolve(scope, payload.taskId);
        return {
          ok: true,
          result: await readChunk(
            payload.taskId,
            folder,
            deps.readScope(folder),
            payload.root,
            payload.path,
            payload.offset,
            payload.sha256,
          ),
        };
      }
    }
  } catch (error) {
    return refusal(error);
  }
}

/** A folder `browse` may offer: a directory, not hidden, not refused (`ChatFolders.refusalOf`), under a current root. */
async function offered(
  deps: Pick<FolderCommandDependencies, "folders">,
  path: string,
  roots: readonly string[],
): Promise<{ readonly real: string; readonly root: string } | undefined> {
  try {
    const real = await realpath(path);
    if (!(await stat(real)).isDirectory()) return undefined;
    if (deps.folders.refusalOf(real) !== undefined) return undefined;
    const root = roots.find((candidate) => within(real, candidate));
    // Hidden by where it resolves, not by a link's name: a link to `.git` is a hidden folder too.
    if (
      root === undefined ||
      (real !== root &&
        relative(root, real)
          .split(sep)
          .some((part) => part.startsWith(".")))
    )
      return undefined;
    return { real, root };
  } catch {
    return undefined;
  }
}

/** How many folders below its root `path` lies. */
const depthBelow = (path: string, root: string): number => (path === root ? 0 : relative(root, path).split(sep).length);

/**
 * `browse`: the folders a chat may use, one level at a time, for the
 * canvas's attach picker — directories only, under the current `--fs-root`
 * set, never the data directory, a credential home, a dev plugin's folder, a
 * hidden folder or one whose path has a glob character; each by its real
 * path, with a token issued on this connection.
 */
export async function browseCommand(
  deps: Pick<FolderCommandDependencies, "folders" | "principalOf" | "picks">,
  payload: BrowsePayload,
): Promise<IpcAnswer<BrowseAnswer>> {
  try {
    const workspace = payload.workspaceId ?? DEFAULT_WORKSPACE_ID;
    if (deps.principalOf(workspace) === undefined)
      throw keyedError("NOT_FOUND", "error.workspace.notConfigured", { workspaceId: workspace }, { details: { workspaceId: workspace } });
    const picks = deps.picks;
    if (picks === undefined) throw keyedError("UNAVAILABLE", "error.folders.notOffered");
    const roots = deps.folders.attachableRoots();
    const entry = (real: string, root: string): BrowseEntry => ({
      token: picks.issue(real),
      name: basename(real) || real,
      path: real,
      opens: depthBelow(real, root) < FOLDER_BROWSE_MAX_DEPTH,
    });
    if (payload.under === undefined) {
      const listed: BrowseEntry[] = [];
      for (const root of roots) {
        const found = await offered(deps, root, roots);
        if (found !== undefined) listed.push(entry(found.real, found.root));
      }
      return {
        ok: true,
        result: { entries: listed.slice(0, FOLDER_BROWSE_MAX_ENTRIES), truncated: listed.length > FOLDER_BROWSE_MAX_ENTRIES },
      };
    }
    const named = picks.redeem(payload.under);
    // Checked again: the roots may have changed, or the folder been swapped for a link, since the token was issued.
    const at = named === undefined ? undefined : await offered(deps, named, roots);
    if (at === undefined) throw keyedError("NOT_FOUND", "error.folders.noLongerOffered");
    if (depthBelow(at.real, at.root) >= FOLDER_BROWSE_MAX_DEPTH)
      throw keyedError("INVALID_INPUT", "error.folders.pickerDepth", { depth: String(FOLDER_BROWSE_MAX_DEPTH) });
    const names = (await readdir(at.real, { withFileTypes: true }))
      .filter((dirent) => !dirent.name.startsWith(".") && (dirent.isDirectory() || dirent.isSymbolicLink()))
      .map((dirent) => dirent.name)
      .sort((a, b) => a.localeCompare(b));
    const entries: BrowseEntry[] = [];
    let truncated = false;
    for (const name of names) {
      const found = await offered(deps, join(at.real, name), roots);
      if (found === undefined) continue;
      if (entries.length >= FOLDER_BROWSE_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push(entry(found.real, found.root));
    }
    const parent = at.real === at.root ? undefined : await offered(deps, dirname(at.real), roots);
    return {
      ok: true,
      result: {
        at: entry(at.real, at.root),
        ...(parent === undefined ? {} : { parent: entry(parent.real, parent.root) }),
        entries,
        truncated,
      },
    };
  } catch (error) {
    return refusal(error);
  }
}

/**
 * A folder a person typed at a terminal (`tavi run --folder`, `/folder set`,
 * `tavi tasks folder`), as the owner takes it: `~` is their home, and a
 * relative path is the terminal's directory's.
 */
export function hostPathOf(
  typed: string,
  cwd: string = process.cwd(),
  home: string = homedir(),
  /** The owner's computer, when it is not this one: see `remotePathOf`. */
  remote?: RemoteFolders,
): string {
  if (remote !== undefined) return remotePathOf(typed, remote);
  const trimmed = typed.trim();
  if (trimmed === "~") return home;
  if (/^~[\\/]/.test(trimmed)) return join(home, trimmed.slice(2));
  return resolvePath(cwd, trimmed);
}

/**
 * A chat's folder as a terminal shows it (`/folder`, `tavi tasks folder`):
 * where it works, its attachments with their modes, its own folder when the
 * primary is a host folder. `changed` words
 * it as what the chat's next message sees. A folder that is gone says
 * why, with the reset that recovers it.
 */
export function folderLines(view: FolderView, changed = false): readonly string[] {
  if (view.unavailable !== undefined || view.primary === undefined) {
    return [`${GLYPHS.failed} ${view.unavailable ?? "This chat's folder could not be read."}`];
  }
  const where = view.primary.kind === "managed" ? `its own folder, ${view.primary.path}` : view.primary.path;
  const lines = [
    `${changed ? `${GLYPHS.more} from its next message, this chat works in` : `${GLYPHS.more} this chat works in`} ${where}`,
    ...view.attachments.map(
      (attachment) => `  ${attachment.label} (${attachment.mode === "rw" ? "read-write" : "read-only"}): ${attachment.path}`,
    ),
    ...(view.primary.kind === "host" ? [`  its own folder: ${view.managed}`] : []),
    ...(view.managedUnavailable === undefined ? [] : [`  ${GLYPHS.failed} ${view.managedUnavailable}`]),
    // Its own folder against the budget: warned past 80%.
    ...(view.budget === undefined
      ? []
      : [
          `  size: ${view.budget.approximate === true ? "at least " : ""}${byteSize(view.budget.bytes)} of its ${byteSize(view.budget.capBytes)} budget`,
        ]),
    ...(view.budget?.warning === undefined ? [] : [`  ! ${view.budget.warning}`]),
  ];
  return lines;
}
