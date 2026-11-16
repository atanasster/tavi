import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  statfsSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { openDirectoryNoFollow, openDirectoryNoFollowSync, retryWhileHeld, retryWhileHeldAsync, sameIdentity } from "@tavi/node-kit";

import {
  CHATS_CAP_DEFAULT_BYTES,
  CHAT_FOLDERS_PRUNE_COMMAND,
  CHAT_FOLDERS_TRASH,
  FOLDER_BUDGET_WARN_FRACTION,
  FOLDER_CAP_DEFAULT_BYTES,
  FOLDER_TRASH_KEEP_DAYS,
  FREE_SPACE_FLOOR_DEFAULT_BYTES,
  TaviError,
  byteSize,
  chatFolderPruneCommand,
  type ChatFolder,
  type ChatKind,
  type TaskStatus,
} from "@tavi/contracts";
import { errorMessage, plural } from "@tavi/contracts/util";

/**
 * Folder retention: how big a
 * chat's managed folder may grow, when its scratch is emptied, and how old
 * folders are reclaimed.
 *
 * The caps are a **budget**, not a ceiling. Past 80% of a cap the folder warns
 * (`folder show`, and once per crossing a notice in the chat); at the cap
 * `.tmp/` is emptied first, then host-side writes into the managed folder
 * (`fs.write`, `fs.edit`, an approved download's copy) and new `sandbox.run`
 * calls are refused with an error naming the size and the prune command. A
 * shell already running is never stopped, so it may overshoot within one call.
 * The free-space floor refuses the same, and any host-side write on the data
 * directory's volume, which `chats/` shares with `tavi.sqlite`.
 *
 * Nothing here follows a link (I-nofollow): sizes are `lstat`ed, emptying
 * removes a link itself and never what it points at, and a folder is entered
 * only while it is still the folder that was checked.
 */

type Maybe<T> = T | Promise<T>;

/** How many entries a size walk reads before it answers an approximate size (`forget`). */
const FOLDER_SIZE_WALK_MAX_ENTRIES = 20_000;

/** A folder's size, from a walk that never follows a link; `approximate` when it stopped at its bound — at least this much. */
export interface FolderMeasure {
  readonly path: string;
  readonly bytes: number;
  readonly approximate?: true;
}

/**
 * A folder's size: every entry `lstat`ed, never through
 * a link, the walk stopping at `maxEntries` (`approximate`). A folder not made
 * yet is 0 bytes.
 */
export async function measureFolder(path: string, maxEntries: number = FOLDER_SIZE_WALK_MAX_ENTRIES): Promise<FolderMeasure> {
  let bytes = 0;
  let seen = 0;
  const pending = [path];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      seen += 1;
      if (seen > maxEntries) return { path, bytes, approximate: true };
      try {
        const status = await lstat(join(directory, name));
        if (status.isDirectory()) pending.push(join(directory, name));
        else bytes += status.size;
      } catch {
        // Gone since it was listed.
      }
    }
  }
  return { path, bytes };
}

/** `path` under `root` or equal to it, by separator-aware `path.relative` — never a string prefix. */
function within(path: string, root: string): boolean {
  const between = relative(root, path);
  return between === "" || (between !== ".." && !between.startsWith(`..${sep}`) && !isAbsolute(between));
}

/** An error's `code`, when it has one (a Node system error). */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

const execFileAsync = promisify(execFile);

/** A failure of the folder's permission bits: a tool that made its folders read-only (Go's module cache under `.home/`). */
const DENIED: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);

/**
 * Remove a file `lstat`ed as `status`. On Windows a read-only file (Git
 * writes its packs so) cannot be deleted until its read-only attribute is
 * cleared, on the file itself, not its folder. `chmod` there follows a link,
 * so it runs only on a regular file that is still the one `lstat`ed; a link
 * swapped in between that check and the `chmod` is a residual race, as
 * `emptyNoFollow`'s.
 */
async function unlinkFile(path: string, status: Stats): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // Read-only on Windows: made writable, only while it is still the file that was found.
    if (errorCode(error) === "EPERM" && sameFile(await lstat(path), status)) await chmod(path, 0o600);
    // A file another process holds for a moment (an indexer's scan) is tried again briefly, as `unlinkFileSync` does.
    await retryWhileHeldAsync(() => unlink(path));
  }
}

/** Whether `now` is still the regular file `then` was (no link swapped in). */
const sameFile = (now: Stats, then: Stats): boolean => now.isFile() && then.isFile() && sameIdentity(now, then);

/** `unlinkFile`, synchronously. */
function unlinkFileSync(path: string, status: Stats): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // Read-only on Windows: made writable, only while it is still the file that was found.
    if (errorCode(error) === "EPERM" && sameFile(lstatSync(path), status)) chmodSync(path, 0o600);
    // A file another process holds for a moment (the database's, an indexer's scan) is tried again briefly.
    retryWhileHeld(() => unlinkSync(path));
  }
}

/**
 * Run `step` on an entry of `folder`; when `folder`'s mode denies it, make
 * `folder` its owner's to change (`0700`) and run it once more. `folder` is
 * one `emptyNoFollow` checked, as `checked`: the mode is set through a
 * descriptor opened without following a link and found to be that very
 * folder, never through a link (I-nofollow) — a link swapped in meanwhile is
 * refused, and what it points at keeps its mode. A folder with no read bit
 * cannot be opened: it is `lstat`ed as that very folder and changed with
 * macOS's `chmod -h` (`lchmod(2)`, which Node's own `lchmod` cannot apply to
 * a folder), which changes a link swapped in since, never its target. Off
 * macOS there is no sandbox to plant a link, and the mode is set by path.
 */
async function withWritable<T>(folder: string, checked: Pick<Stats, "dev" | "ino" | "birthtimeMs">, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (!DENIED.has(errorCode(error) ?? "")) throw error;
    const same = (status: Stats): boolean => status.isDirectory() && sameIdentity(status, checked);
    // No descriptor on Windows, which opens no directory this way: the folder is then changed by name, as when it cannot be opened.
    const handle = await openDirectoryNoFollow(folder).catch((failure: unknown) => {
      if (!DENIED.has(errorCode(failure) ?? "")) throw failure;
      return undefined;
    });
    if (handle === undefined) {
      if (!same(await lstat(folder))) throw new TaviError("CONFLICT", `${folder} changed while it was emptied`);
      await (process.platform === "darwin" ? execFileAsync("/bin/chmod", ["-h", "700", folder]) : chmod(folder, 0o700));
      if (!same(await lstat(folder))) throw new TaviError("CONFLICT", `${folder} changed while it was emptied`);
      return await step();
    }
    try {
      if (!same(await handle.stat())) throw new TaviError("CONFLICT", `${folder} changed while it was emptied`);
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
    return await step();
  }
}

/**
 * Empty a folder that was `lstat`ed as `status`, never through a link: it
 * must still resolve to itself (no ancestor swapped for a link) and still be
 * the inode checked before each entry goes. An entry that cannot be removed
 * is recorded in `failed` and the rest are still removed. Node has no
 * `unlinkat`, so a folder swapped between that check and one removal is a
 * residual race.
 */
async function emptyNoFollow(directory: string, status: Stats, failed: string[]): Promise<void> {
  if ((await realpath(directory)) !== directory)
    throw new TaviError("CONFLICT", `${directory} resolves elsewhere; it is never emptied through a link`);
  for (const name of await withWritable(directory, status, () => readdir(directory))) {
    const again = await lstat(directory);
    if (!again.isDirectory() || !sameIdentity(again, status)) throw new TaviError("CONFLICT", `${directory} changed while it was emptied`);
    try {
      await removeNoFollow(join(directory, name), failed, status);
    } catch (error) {
      failed.push(`${join(directory, name)}: ${errorMessage(error)}`);
    }
  }
}

/**
 * Remove a file, a link (the link itself, never what it points at) or a
 * folder and all it holds; what could not be removed inside is recorded in
 * `failed`. `path`'s parent must be real and checked, as `emptyNoFollow`'s —
 * `parent` is what it was found to be, `lstat`ed now when not given.
 */
async function removeNoFollow(path: string, failed: string[], parent?: Pick<Stats, "dev" | "ino" | "birthtimeMs">): Promise<void> {
  const container = parent ?? (await lstat(dirname(path)));
  let status: Stats;
  try {
    status = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!status.isDirectory()) {
    await withWritable(dirname(path), container, () => unlinkFile(path, status)).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    return;
  }
  await emptyNoFollow(path, status, failed);
  await withWritable(dirname(path), container, () => rmdir(path));
}

/** `withWritable`, synchronously: for what runs outside an owner's event loop (a reset, the database worker). */
function withWritableSync<T>(folder: string, checked: Pick<Stats, "dev" | "ino" | "birthtimeMs">, step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (!DENIED.has(errorCode(error) ?? "")) throw error;
    const same = (status: Stats): boolean => status.isDirectory() && sameIdentity(status, checked);
    let descriptor: number | undefined;
    try {
      descriptor = openDirectoryNoFollowSync(folder);
    } catch (failure) {
      if (!DENIED.has(errorCode(failure) ?? "")) throw failure;
    }
    if (descriptor === undefined) {
      if (!same(lstatSync(folder))) throw new TaviError("CONFLICT", `${folder} changed while it was removed`);
      if (process.platform === "darwin") execFileSync("/bin/chmod", ["-h", "700", folder]);
      else chmodSync(folder, 0o700);
      if (!same(lstatSync(folder))) throw new TaviError("CONFLICT", `${folder} changed while it was removed`);
      return step();
    }
    try {
      if (!same(fstatSync(descriptor))) throw new TaviError("CONFLICT", `${folder} changed while it was removed`);
      fchmodSync(descriptor, 0o700);
    } finally {
      closeSync(descriptor);
    }
    return step();
  }
}

/** `removeNoFollow`, synchronously, with `emptyNoFollow`'s checks. */
function removeNoFollowSync(path: string, failed: string[], parent?: Pick<Stats, "dev" | "ino" | "birthtimeMs">): void {
  const container = parent ?? lstatSync(dirname(path));
  let status: Stats;
  try {
    status = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!status.isDirectory()) {
    try {
      withWritableSync(dirname(path), container, () => unlinkFileSync(path, status));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return;
  }
  if (realpathSync.native(path) !== path) throw new TaviError("CONFLICT", `${path} resolves elsewhere; it is never removed through a link`);
  for (const name of withWritableSync(path, status, () => readdirSync(path))) {
    const again = lstatSync(path);
    if (!again.isDirectory() || !sameIdentity(again, status)) throw new TaviError("CONFLICT", `${path} changed while it was removed`);
    try {
      removeNoFollowSync(join(path, name), failed, status);
    } catch (error) {
      failed.push(`${join(path, name)}: ${errorMessage(error)}`);
    }
  }
  withWritableSync(dirname(path), container, () => retryWhileHeld(() => rmdirSync(path)));
}

/**
 * Remove `path` and all it holds (`tavi reset`, a snapshot's entries replaced
 * by `backup --force`), never through a link: a link is removed, never what
 * it points at, and a folder is entered only while it resolves to itself. A
 * folder whose mode denies a removal — a Go module cache left read-only, a
 * folder a shell made `000` — is made its owner's (`0700`) through a
 * descriptor checked to be that folder, and the removal tried once more. What
 * still cannot go is named in the error, after the rest is removed.
 */
export function removeTreeSync(path: string): void {
  let real: string;
  try {
    real = join(realpathSync.native(dirname(resolve(path))), basename(path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const failed: string[] = [];
  try {
    removeNoFollowSync(real, failed);
  } catch (error) {
    failed.push(errorMessage(error));
  }
  if (failed.length > 0) {
    throw new TaviError("UNAVAILABLE", `${real} could not be deleted whole: ${failed.slice(0, 3).join("; ")}`.slice(0, 1_000), {
      details: { path: real, failed: failed.length },
    });
  }
}

/**
 * Empty a chat's scratch, `<managed>/.tmp/`: when a turn ends and at an
 * epoch rollover, and first when a folder reaches its budget. `.home/` is
 * kept. A link the shell planted in `.tmp`'s place is removed and a plain
 * folder made again; nothing it pointed at is touched. `managed` is real, as
 * `ChatFolders` resolves it. The answer is what could not be removed.
 */
export async function emptyScratch(managed: string): Promise<readonly string[]> {
  const scratch = join(managed, ".tmp");
  let status: Stats;
  try {
    status = await lstat(scratch);
  } catch (error) {
    // Made again when the chat's next turn resolves its folder.
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  if (!status.isDirectory()) {
    await unlink(scratch);
    await mkdir(scratch, { mode: 0o700 });
    return [];
  }
  const failed: string[] = [];
  await emptyNoFollow(scratch, status, failed);
  return failed;
}

/** Free bytes on the volume holding `path` (`statfs`'s `bavail × bsize`), or undefined when it cannot be read. */
function statfsFreeBytes(path: string): number | undefined {
  try {
    const stats = statfsSync(path);
    return stats.bsize * stats.bavail;
  } catch {
    return undefined;
  }
}

/** The budget's numbers for one chat's folder (`folder show`). */
export interface FolderUsage {
  readonly managed: string;
  readonly bytes: number;
  readonly approximate?: true;
  readonly capBytes: number;
  /** Every managed folder together, `.trash/` included. */
  readonly chatsBytes: number;
  readonly chatsApproximate?: true;
  readonly chatsCapBytes: number;
  /** Past 80% of either cap: what the folder and the turn say. */
  readonly warning?: string;
}

export interface FolderSpaceOptions {
  /** The data directory: managed folders live in its `chats/`, which shares its volume with `tavi.sqlite`. */
  readonly dataDirectory: string;
  /** `serve --folder-cap`: one chat's managed folder, `.home/` and `.tmp/` included. */
  readonly folderCapBytes?: number;
  /** `serve --chats-cap`: every managed folder together, `.trash/` included. */
  readonly chatsCapBytes?: number;
  /** `serve --free-space-floor`: below it, host-side writes and new `sandbox.run` calls are refused. */
  readonly freeSpaceFloorBytes?: number;
  /** Free bytes on the volume holding a path; `statfs` unless a test says otherwise. */
  readonly freeBytes?: (path: string) => number | undefined;
  /** How long a free space read is reused before the volume is asked again (default 1 s): every stored artifact checks the floor. */
  readonly freeBytesTtlMs?: number;
  readonly now?: () => number;
  /** How long a measured size is reused before the folder is walked again (default 30 s). */
  readonly measureTtlMs?: number;
  /** How many entries one walk reads before it answers an approximate size (default 100,000). */
  readonly maxEntries?: number;
  /**
   * Whether a worker of the chat owning `managed` is still running: workers
   * share their root chat's folder and its `.tmp/`, which is then not
   * emptied under them. Absent, never; one that fails counts as in use.
   */
  readonly scratchInUse?: (managed: string) => Maybe<boolean>;
}

const MEASURE_TTL_MS = 30_000;
const FREE_BYTES_TTL_MS = 1_000;
const SPACE_WALK_MAX_ENTRIES = 100_000;

/**
 * The owner's view of its chats' folders against the budget and the
 * free-space floor. Sizes are measured at admission of a write
 * or a run, from a walk bounded by an entry count and reused for a short TTL,
 * so a huge folder is never walked on every call; an approximate size is a
 * lower bound, so a folder past its bound is still refused once it reaches
 * the cap within the walk.
 */
export class FolderSpace {
  readonly #options: FolderSpaceOptions;
  readonly #measured = new Map<string, { readonly measure: FolderMeasure; readonly at: number }>();
  readonly #walking = new Map<string, Promise<FolderMeasure>>();
  /** The folders past 80% when last looked at: a warning is posted when one crosses, not on every turn. */
  readonly #warned = new Set<string>();
  /** The last free space read, and when. */
  #free: { readonly bytes: number | undefined; readonly at: number } | undefined;

  constructor(options: FolderSpaceOptions) {
    this.#options = options;
  }

  get folderCapBytes(): number {
    return this.#options.folderCapBytes ?? FOLDER_CAP_DEFAULT_BYTES;
  }

  get chatsCapBytes(): number {
    return this.#options.chatsCapBytes ?? CHATS_CAP_DEFAULT_BYTES;
  }

  get freeSpaceFloorBytes(): number {
    return this.#options.freeSpaceFloorBytes ?? FREE_SPACE_FLOOR_DEFAULT_BYTES;
  }

  /** `<data-dir>/chats` as the filesystem spells it now. */
  get #chats(): string {
    const data = resolve(this.#options.dataDirectory);
    try {
      return join(realpathSync.native(data), "chats");
    } catch {
      return join(data, "chats");
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  async #scratchInUse(managed: string): Promise<boolean> {
    try {
      return (await this.#options.scratchInUse?.(managed)) === true;
    } catch {
      return true;
    }
  }

  async #measure(path: string, fresh: boolean): Promise<FolderMeasure> {
    const kept = this.#measured.get(path);
    if (!fresh && kept !== undefined && this.#now() - kept.at < (this.#options.measureTtlMs ?? MEASURE_TTL_MS)) return kept.measure;
    const running = this.#walking.get(path);
    if (running !== undefined) return running;
    const walk = measureFolder(path, this.#options.maxEntries ?? SPACE_WALK_MAX_ENTRIES)
      .then((measure) => {
        this.#measured.set(path, { measure, at: this.#now() });
        return measure;
      })
      .finally(() => this.#walking.delete(path));
    this.#walking.set(path, walk);
    return walk;
  }

  /** Forget the sizes measured for a folder and for every chat together: something was just removed or added. */
  forget(managed: string): void {
    this.#measured.delete(managed);
    this.#measured.delete(this.#chats);
  }

  /**
   * Forget one folder's size only (a `sandbox.run` ended in it): its own
   * budget is measured again at the next admission, while every chat's
   * together, a far longer walk, is kept for its 30 s.
   */
  forgetFolder(managed: string): void {
    this.#measured.delete(managed);
  }

  /** A chat's folder against its budget, and every chat's together (`folder show`). */
  async usage(managed: string, options: { readonly fresh?: boolean; readonly taskId?: string } = {}): Promise<FolderUsage> {
    const fresh = options.fresh === true;
    const [folder, chats] = await Promise.all([this.#measure(managed, fresh), this.#measure(this.#chats, fresh)]);
    const usage = {
      managed,
      bytes: folder.bytes,
      ...(folder.approximate === undefined ? {} : { approximate: true as const }),
      capBytes: this.folderCapBytes,
      chatsBytes: chats.bytes,
      ...(chats.approximate === undefined ? {} : { chatsApproximate: true as const }),
      chatsCapBytes: this.chatsCapBytes,
    };
    const warning = budgetWarning(usage, options.taskId);
    return warning === undefined ? usage : { ...usage, warning };
  }

  /**
   * The warning a turn posts for a chat's folder: only when the
   * folder (or every chat's together) has just crossed 80% of its cap since
   * it was last looked at, so a chat is not told again on every turn. Kept
   * for the owner's lifetime: a restarted owner tells a full folder once more.
   */
  async crossing(managed: string, taskId?: string): Promise<string | undefined> {
    const { warning } = await this.usage(managed, taskId === undefined ? {} : { taskId });
    if (warning === undefined) {
      this.#warned.delete(managed);
      return undefined;
    }
    if (this.#warned.has(managed)) return undefined;
    this.#warned.add(managed);
    return warning;
  }

  /**
   * Refuse when the volume holding the data directory has less free space
   * than the floor: a host-side write, a new `sandbox.run`, and every
   * artifact the owner stores (a download, a report, a screenshot, an
   * archived result). Unknown free space never refuses: a probe that fails
   * must not be the reason a turn cannot work. The free space is read at
   * most once per `freeBytesTtlMs`, so a burst of writes asks the volume once.
   */
  checkFloor(): void {
    const free = this.#freeBytes();
    if (free === undefined || free >= this.freeSpaceFloorBytes) return;
    throw new TaviError(
      "QUOTA_EXCEEDED",
      `Only ${byteSize(free)} is free on the disk that holds the tavi data directory, under its ${byteSize(this.freeSpaceFloorBytes)} floor (tavi serve --free-space-floor): file writes, stored files (downloads, reports, screenshots) and new sandbox.run calls are refused until space is freed. Free some space, or reclaim old chats' folders with \`${CHAT_FOLDERS_PRUNE_COMMAND}\`.`,
      { details: { freeBytes: free, floorBytes: this.freeSpaceFloorBytes } },
    );
  }

  #freeBytes(): number | undefined {
    const now = this.#now();
    if (this.#free !== undefined && now - this.#free.at < (this.#options.freeBytesTtlMs ?? FREE_BYTES_TTL_MS)) return this.#free.bytes;
    const bytes = (this.#options.freeBytes ?? statfsFreeBytes)(resolve(this.#options.dataDirectory));
    this.#free = { bytes, at: now };
    return bytes;
  }

  /**
   * Admit a write into a chat's managed folder (or a run that may write it):
   * past the folder's budget, or every chat's together, `.tmp/` is emptied
   * and the size taken again; still past it, refused, naming the size and
   * how to clear it.
   */
  async checkBudget(managed: string, taskId?: string): Promise<void> {
    const over = (usage: FolderUsage) => usage.bytes >= usage.capBytes || usage.chatsBytes >= usage.chatsCapBytes;
    if (!over(await this.usage(managed))) return;
    // Not under a worker still running in it: its scratch is the chat's.
    if (!(await this.#scratchInUse(managed))) await emptyScratch(managed).catch(() => undefined);
    this.forget(managed);
    const usage = await this.usage(managed, { fresh: true });
    if (!over(usage)) return;
    const prune = taskId === undefined ? CHAT_FOLDERS_PRUNE_COMMAND : chatFolderPruneCommand(taskId);
    if (usage.bytes >= usage.capBytes) {
      throw new TaviError(
        "QUOTA_EXCEEDED",
        `This chat's folder ${managed} holds ${usage.approximate === true ? "at least " : ""}${byteSize(usage.bytes)}, its whole ${byteSize(usage.capBytes)} budget (tavi serve --folder-cap), even with its .tmp/ emptied: writes into it and new sandbox.run calls are refused. Delete files from it, or clear it with \`${prune}\`.`,
        { details: { bytes: usage.bytes, capBytes: usage.capBytes } },
      );
    }
    throw new TaviError(
      "QUOTA_EXCEEDED",
      `Every chat's folder together holds ${usage.chatsApproximate === true ? "at least " : ""}${byteSize(usage.chatsBytes)}, the whole ${byteSize(usage.chatsCapBytes)} budget (tavi serve --chats-cap), even with this chat's .tmp/ emptied: writes into chats' folders and new sandbox.run calls are refused. Reclaim old chats' folders with \`${CHAT_FOLDERS_PRUNE_COMMAND}\`.`,
      { details: { bytes: usage.chatsBytes, capBytes: usage.chatsCapBytes } },
    );
  }

  /** A new `sandbox.run`: the floor, then the chat's budget (it may write its managed folder). */
  async admitRun(folder: ChatFolder, taskId?: string): Promise<void> {
    this.checkFloor();
    await this.checkBudget(folder.managed, taskId);
  }

  /**
   * A host-side write to `target` (`fs.write`, `fs.edit`): the floor when it
   * lands on the data directory's volume, and the budget when it lands in
   * the chat's managed folder. A host folder is the person's: it has no
   * budget, and a write to another volume does not touch the floor.
   */
  async admitWrite(folder: ChatFolder, target: string, taskId?: string): Promise<void> {
    if (sameVolume(target, this.#options.dataDirectory)) this.checkFloor();
    if (within(target, folder.managed)) await this.checkBudget(folder.managed, taskId);
  }

  /** A copy into a chat's managed folder: the floor and the budget. */
  async admitManagedWrite(managed: string, taskId?: string): Promise<void> {
    this.checkFloor();
    await this.checkBudget(managed, taskId);
  }

  /** Empty a chat's `.tmp/` (turn end, epoch rollover) and forget its size; left as it is while a worker of the chat runs. */
  async emptyScratch(managed: string): Promise<void> {
    if (await this.#scratchInUse(managed)) return;
    const failed = await emptyScratch(managed);
    this.forget(managed);
    if (failed.length > 0)
      throw new TaviError(
        "UNAVAILABLE",
        `${plural(failed.length, "entry", "entries")} of ${join(managed, ".tmp")} could not be removed: ${failed.slice(0, 3).join("; ")}`.slice(
          0,
          1_000,
        ),
      );
  }
}

/**
 * Whether an artifact is tavi's own bookkeeping, which the free-space floor
 * lets through: a browser session's thumbnail, or an approved
 * JSON or text record with no name, folder copy or untrusted mark — a
 * conversation fold's archive, a worker's or an envelope's offloaded text, a
 * proposed skill package. Refusing these frees nothing (checkpoints keep
 * writing the same disk) and would stop a chat compacting. Everything else —
 * a download, a screenshot, a report, inbound media, a file a call promoted,
 * an oversized tool result held for review — is for a person or the model,
 * and is refused below the floor.
 */
export function isBookkeepingArtifact(input: {
  readonly contentType: string;
  readonly purpose?: string | undefined;
  readonly reviewState?: string | undefined;
  readonly fileName?: string | undefined;
  readonly folderCopy?: string | undefined;
  readonly untrusted?: boolean | undefined;
}): boolean {
  if (input.purpose === "thumbnail") return true;
  return (
    (input.reviewState ?? "approved") === "approved" &&
    input.fileName === undefined &&
    input.folderCopy === undefined &&
    input.untrusted !== true &&
    /^(application\/json|text\/plain)(;|$)/.test(input.contentType)
  );
}

/** Whether `path` (or its deepest existing ancestor) lies on the volume holding `other`; true when it cannot be told. */
function sameVolume(path: string, other: string): boolean {
  try {
    let existing = resolve(path);
    for (;;) {
      try {
        return statSync(existing).dev === statSync(resolve(other)).dev;
      } catch (error) {
        const parent = dirname(existing);
        if (errorCode(error) !== "ENOENT" || parent === existing) return true;
        existing = parent;
      }
    }
  } catch {
    return true;
  }
}

/** What a folder past 80% of a cap says, or undefined below both. */
function budgetWarning(usage: Omit<FolderUsage, "warning">, taskId: string | undefined): string | undefined {
  const at = (bytes: number, approximate: boolean | undefined) => `${approximate === true ? "at least " : ""}${byteSize(bytes)}`;
  if (usage.bytes >= usage.capBytes * FOLDER_BUDGET_WARN_FRACTION) {
    return `This chat's folder holds ${at(usage.bytes, usage.approximate)} of its ${byteSize(usage.capBytes)} budget. At the budget its .tmp/ is emptied, then file writes into it and new sandbox.run calls are refused; delete what it no longer needs, or clear it with \`${taskId === undefined ? `${CHAT_FOLDERS_PRUNE_COMMAND} --chat <task-id>` : chatFolderPruneCommand(taskId)}\`.`;
  }
  if (usage.chatsBytes >= usage.chatsCapBytes * FOLDER_BUDGET_WARN_FRACTION) {
    return `Every chat's folder together holds ${at(usage.chatsBytes, usage.chatsApproximate)} of the ${byteSize(usage.chatsCapBytes)} budget. At the budget file writes into chats' folders and new sandbox.run calls are refused; reclaim old ones with \`${CHAT_FOLDERS_PRUNE_COMMAND}\`.`;
  }
  return undefined;
}

/* ------------------------------------------------------------------------ */
/* Prune (`tavi tasks folders prune`) and the trash                          */
/* ------------------------------------------------------------------------ */

/** The task fields prune decides by. */
export interface FolderPruneTask {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly status: TaskStatus;
  readonly updatedAt: string;
  readonly chatKind?: ChatKind;
}

export interface FolderPruneDependencies {
  readonly dataDirectory: string;
  readonly tasks: {
    get(taskId: string): Maybe<FolderPruneTask | undefined>;
    hasRunningAdmission(taskId: string): Maybe<boolean>;
  };
  /** How many workers of the chat's delegation tree have not ended (`agentDelegations.countRunningInTree`): they work in its folder. */
  readonly workersInProgress: (workspaceId: string, taskId: string) => Maybe<number>;
  /** The side chats opened from the chat, by task id: each reads its folder. */
  readonly sideChats: (workspaceId: string, taskId: string) => Maybe<readonly string[]>;
  /** The chat's stored folder: read so a chat whose configuration cannot be read is never cleared. */
  readonly folderRecord: (taskId: string) => Maybe<unknown>;
  /** A chat's managed folder, real, made or not (`ChatFolders.managedPath`). */
  readonly managedPath: (workspaceId: string, taskId: string) => string;
  /** The chat a task works for — a worker's root chat (`ChatFolders.chatOf`). */
  readonly chatOf: (workspaceId: string, taskId: string) => Promise<{ readonly taskId: string; readonly workspaceId: string }>;
  readonly now?: () => number;
}

export interface FolderPruneOptions {
  /** Folders whose chat was last active longer ago than this are taken. */
  readonly olderThanDays: number;
  /** Whether `--older-than` was given: with `chat`, the age applies only then. */
  readonly olderThanGiven?: boolean;
  /** `--chat`: this chat's folder only, whatever its kind — the only way a Home's or a side chat's is cleared. */
  readonly chat?: { readonly workspaceId: string; readonly taskId: string };
}

export interface FolderPruneEntry {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly kind: ChatKind | "chat";
  readonly path: string;
  readonly bytes: number;
  readonly approximate?: true;
  readonly lastActiveAt: string;
}

export interface FolderTrashEntry {
  readonly path: string;
  readonly bytes: number;
  readonly approximate?: true;
  /** When it was moved there; deleted once `FOLDER_TRASH_KEEP_DAYS` have passed. */
  readonly trashedAt: string;
  readonly expired: boolean;
}

export interface FolderPrunePlan {
  /** Moved to `chats/.trash/` when applied. */
  readonly folders: readonly FolderPruneEntry[];
  /** Left in place, and why. */
  readonly skipped: readonly { readonly taskId?: string; readonly path: string; readonly reason: string }[];
  /** What waits in the trash; `expired` entries are deleted when applied. */
  readonly trash: readonly FolderTrashEntry[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The turn of a task that has not settled: it may still read or write its folder. */
const IN_PROGRESS: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["admitted", "running", "waiting"]);

/** A trash entry's time, as its name records it (`<task>-20261010T120000Z`). */
function stampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function trashedAtOf(name: string): number | undefined {
  const match = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-\d+)?$/.exec(name);
  if (match === null) return undefined;
  const at = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  return Number.isNaN(at) ? undefined : at;
}

/** `<data-dir>/chats`, real, or undefined when it does not exist yet. */
function chatsOf(dataDirectory: string): string | undefined {
  try {
    const chats = join(realpathSync.native(resolve(dataDirectory)), "chats");
    return statSync(chats).isDirectory() ? chats : undefined;
  } catch {
    return undefined;
  }
}

/** What waits in `chats/.trash/`, oldest first; each entry's size only when `measure` (the plan prints it; emptying needs only the age). */
async function trashOf(chats: string, now: number, keepDays: number, measure: boolean): Promise<readonly FolderTrashEntry[]> {
  const trash = join(chats, CHAT_FOLDERS_TRASH);
  let names: string[];
  try {
    if (!(await lstat(trash)).isDirectory()) return [];
    names = await readdir(trash);
  } catch {
    return [];
  }
  const entries: FolderTrashEntry[] = [];
  for (const name of names) {
    const path = join(trash, name);
    let at = trashedAtOf(name);
    try {
      at ??= (await lstat(path)).mtimeMs;
    } catch {
      continue;
    }
    const size: FolderMeasure = measure ? await measureFolder(path) : { path, bytes: 0 };
    entries.push({
      path,
      bytes: size.bytes,
      ...(size.approximate === undefined ? {} : { approximate: true as const }),
      trashedAt: new Date(at).toISOString(),
      expired: now - at >= keepDays * DAY_MS,
    });
  }
  return entries.sort((a, b) => a.trashedAt.localeCompare(b.trashedAt));
}

/**
 * Delete what has waited in `chats/.trash/` for `FOLDER_TRASH_KEEP_DAYS` or
 * more: on prune and at the owner's start. Never through a link.
 */
export async function emptyFolderTrash(
  dataDirectory: string,
  now: number = Date.now(),
  keepDays: number = FOLDER_TRASH_KEEP_DAYS,
): Promise<FolderTrashEmptied> {
  const chats = chatsOf(dataDirectory);
  const removed: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  if (chats === undefined) return { removed, failed };
  // One entry that cannot go never keeps the others: each is tried, and what is left is reported.
  for (const entry of await trashOf(chats, now, keepDays, false)) {
    if (!entry.expired) continue;
    const inside: string[] = [];
    try {
      await removeNoFollow(entry.path, inside);
      removed.push(entry.path);
    } catch (error) {
      failed.push({ path: entry.path, reason: [...inside, errorMessage(error)].slice(0, 4).join("; ").slice(0, 1_000) });
    }
  }
  return { removed, failed };
}

/** What emptying the trash did: the entries deleted, and those that could not be, with why. */
export interface FolderTrashEmptied {
  readonly removed: readonly string[];
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * What `tavi tasks folders prune` would do, changing nothing:
 * the run-kind folders (`chatKind: "run"`) whose chat was last active longer
 * ago than `olderThanDays`, or with `chat` that chat's folder alone — the only
 * way a Home's, a side chat's or an ordinary chat's is cleared. A chat with a
 * turn in progress is skipped, and so is one whose folder configuration or
 * task record cannot be read: nothing is deleted on a guess. A folder a side
 * chat reads is never taken by age, and with `chat` not while a
 * side chat of it has a turn in progress. A folder under `chats/` that no
 * chat is recorded for is left alone.
 */
export async function planFolderPrune(deps: FolderPruneDependencies, options: FolderPruneOptions): Promise<FolderPrunePlan> {
  const now = (deps.now ?? Date.now)();
  const chats = chatsOf(deps.dataDirectory);
  const folders: FolderPruneEntry[] = [];
  const skipped: { taskId?: string; path: string; reason: string }[] = [];
  const cutoff = now - options.olderThanDays * DAY_MS;

  /** Whether `task`'s folder at `path` may go; why not, as a skip, when it may not and the reader should know. */
  const consider = async (task: FolderPruneTask, path: string, explicit: boolean): Promise<void> => {
    let status: Stats;
    try {
      status = await lstat(path);
    } catch {
      if (explicit) skipped.push({ taskId: task.taskId, path, reason: "it has no folder yet" });
      return;
    }
    if (!status.isDirectory()) {
      skipped.push({ taskId: task.taskId, path, reason: "it is not a folder tavi made (a link or a file)" });
      return;
    }
    const lastActive = Date.parse(task.updatedAt);
    if ((!explicit || options.olderThanGiven === true) && !(lastActive < cutoff)) {
      if (explicit) skipped.push({ taskId: task.taskId, path, reason: `it was used within the last ${options.olderThanDays} days` });
      return;
    }
    try {
      const working = async (chat: FolderPruneTask): Promise<boolean> =>
        IN_PROGRESS.has(chat.status) ||
        (await deps.tasks.hasRunningAdmission(chat.taskId)) ||
        (await deps.workersInProgress(chat.workspaceId, chat.taskId)) > 0;
      if (await working(task)) {
        skipped.push({ taskId: task.taskId, path, reason: "a turn is in progress" });
        return;
      }
      // Its side chats read this folder as `parent-chat`: never taken from under them by age, nor named while one works.
      const sides = await deps.sideChats(task.workspaceId, task.taskId);
      if (sides.length > 0 && !explicit) {
        skipped.push({
          taskId: task.taskId,
          path,
          reason: `a side chat reads it (${sides.slice(0, 3).join(", ")}${sides.length > 3 ? ", …" : ""}): clear it with --chat ${task.taskId}`,
        });
        return;
      }
      for (const sideId of sides) {
        const side = await deps.tasks.get(sideId);
        if (side !== undefined && (await working(side))) {
          skipped.push({ taskId: task.taskId, path, reason: `a side chat reading it (${sideId}) has a turn in progress` });
          return;
        }
      }
      await deps.folderRecord(task.taskId);
    } catch (error) {
      skipped.push({
        taskId: task.taskId,
        path,
        reason: `its configuration could not be read (${errorMessage(error)}); nothing of it is deleted`,
      });
      return;
    }
    const measure = await measureFolder(path);
    folders.push({
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      kind: task.chatKind ?? "chat",
      path,
      bytes: measure.bytes,
      ...(measure.approximate === undefined ? {} : { approximate: true as const }),
      lastActiveAt: task.updatedAt,
    });
  };

  if (options.chat !== undefined) {
    const named = await deps.tasks.get(options.chat.taskId);
    if (named === undefined || named.workspaceId !== options.chat.workspaceId)
      throw new TaviError("NOT_FOUND", `Task ${options.chat.taskId} does not exist`);
    // A worker works in its root chat's folder: that is the folder named.
    const chat = await deps.chatOf(named.workspaceId, named.taskId);
    const task = chat.taskId === named.taskId ? named : await deps.tasks.get(chat.taskId);
    if (task === undefined) throw new TaviError("NOT_FOUND", `Task ${chat.taskId} does not exist`);
    await consider(task, deps.managedPath(task.workspaceId, task.taskId), true);
  } else if (chats !== undefined) {
    for (const workspace of (await readdir(chats)).sort()) {
      // `.trash/` and anything else hidden is not a workspace's.
      if (workspace.startsWith(".")) continue;
      const directory = join(chats, workspace);
      let names: string[];
      try {
        if (!(await lstat(directory)).isDirectory()) continue;
        names = (await readdir(directory)).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(directory, name);
        let task: FolderPruneTask | undefined;
        try {
          task = await deps.tasks.get(name);
        } catch (error) {
          skipped.push({ path, reason: `its chat's record could not be read (${errorMessage(error)}); nothing of it is deleted` });
          continue;
        }
        // Only a folder whose chat is recorded, and is where that chat's folder is.
        if (task === undefined || deps.managedPath(task.workspaceId, task.taskId) !== path) continue;
        if (task.chatKind !== "run") continue;
        await consider(task, path, false);
      }
    }
  }
  return { folders, skipped, trash: chats === undefined ? [] : await trashOf(chats, now, FOLDER_TRASH_KEEP_DAYS, true) };
}

/** What applying a plan did. */
export interface FolderPruneResult {
  readonly moved: readonly { readonly taskId: string; readonly from: string; readonly to: string }[];
  readonly failed: readonly { readonly taskId: string; readonly path: string; readonly reason: string }[];
  /** Trash entries deleted, past their 7 days. */
  readonly removed: readonly string[];
  /** Trash entries past their 7 days that could not be deleted, with why. */
  readonly trashFailed: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * Apply a plan: each folder moved to `chats/.trash/<task-id>-<time>/` by a
 * rename on the same volume, never through a link (the folder and its parent
 * are checked again first), then the trash's expired entries deleted. A chat
 * whose folder moved gets an empty one again at its next turn.
 */
export async function applyFolderPrune(
  deps: Pick<FolderPruneDependencies, "dataDirectory" | "now">,
  plan: FolderPrunePlan,
): Promise<FolderPruneResult> {
  const now = (deps.now ?? Date.now)();
  const moved: { taskId: string; from: string; to: string }[] = [];
  const failed: { taskId: string; path: string; reason: string }[] = [];
  const chats = chatsOf(deps.dataDirectory);
  if (chats === undefined) return { moved, failed, removed: [], trashFailed: [] };
  const trash = join(chats, CHAT_FOLDERS_TRASH);
  if (plan.folders.length > 0) {
    await mkdir(trash, { mode: 0o700 }).catch((error: unknown) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    const status = await lstat(trash);
    if (!status.isDirectory() || (await realpath(trash)) !== trash)
      throw new TaviError("NOT_AUTHORIZED", `${trash} is not a plain folder; nothing is moved into it`);
  }
  for (const [index, entry] of plan.folders.entries()) {
    try {
      // Still a plain folder, in a parent that resolves to itself, inside `chats/`.
      const status = await lstat(entry.path);
      if (!status.isDirectory()) throw new TaviError("CONFLICT", "it is no longer a folder");
      if ((await realpath(dirname(entry.path))) !== dirname(entry.path) || !within(entry.path, chats))
        throw new TaviError("CONFLICT", "its parent resolves elsewhere");
      const to = join(trash, `${basename(entry.path)}-${stampOf(new Date(now))}${plan.folders.length > 1 ? `-${index + 1}` : ""}`);
      await rename(entry.path, to);
      moved.push({ taskId: entry.taskId, from: entry.path, to });
    } catch (error) {
      failed.push({ taskId: entry.taskId, path: entry.path, reason: errorMessage(error) });
    }
  }
  // What moved is answered whatever emptying the trash then meets.
  try {
    const emptied = await emptyFolderTrash(deps.dataDirectory, now);
    return { moved, failed, removed: emptied.removed, trashFailed: emptied.failed };
  } catch (error) {
    return { moved, failed, removed: [], trashFailed: [{ path: join(chats, CHAT_FOLDERS_TRASH), reason: errorMessage(error) }] };
  }
}
