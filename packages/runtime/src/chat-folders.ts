import { closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  CHAT_FOLDER_ATTACHMENTS_MAX,
  CHAT_FOLDER_LABEL_MAX,
  CHAT_FOLDER_PARENT_LABEL,
  CHAT_FOLDER_RESET_COMMAND,
  TaviError,
  fsFold,
  hasLineUnsafeCharacters,
  lineSafe,
  type ChatFolder,
  type ChatFolderAttachment,
  type ChatFolderCaller,
  type ChatFolderMode,
  type ChatFolderChange,
  type ChatFolderPrimaryKind,
  type ChatFolderRow,
  type ChatFolderTaint,
  type HostFileIdentity,
  type ChatKind,
  type TaskOrigin,
  type TurnChannel,
  type WriteChatFolderInput,
} from "@tavi/contracts";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";
import { openDirectoryNoFollowSync, sameIdentity, sha256Hex } from "@tavi/node-kit";

/**
 * Each chat's working folder: what one turn
 * resolves it to, and how the owner changes it.
 *
 * The folder is the owner's record, never the model's choice: the
 * workflow stamps `resolve`'s answer on the turn's context once per admission,
 * and only `set` — reached from the owner's own commands — writes the record.
 * `fs.*` and `sandbox.run` read it.
 */

/** Homes of credentials a tool never touches, whatever a rule allows — `sandbox.run`'s deny list too, and never a chat's folder. */
export function credentialHomes(home: string = homedir()): readonly string[] {
  return [
    ".ssh",
    ".aws",
    ".gnupg",
    ".config/gcloud",
    ".kube",
    ".docker",
    ".netrc",
    ".npmrc",
    ".pypirc",
    // Key stores and secret managers.
    "Library/Keychains",
    ".age",
    ".passage",
    ".vault-token",
    ".sops",
    ".config/sops",
    ".config/1Password",
    ".config/op",
    ".config/Bitwarden CLI",
    // Cloud and hosting CLIs' stored tokens.
    ".config/doctl",
    ".config/railway",
    ".config/fly",
    ".fly",
    ".supabase",
    ".vercel",
    ".netlify",
    ".turso",
    ".wrangler",
    ".terraform.d",
    ".pulumi",
    ".azure",
    ".config/heroku",
    // Package registries' publish tokens.
    ".gem/credentials",
    ".composer/auth.json",
    ".config/composer/auth.json",
    ".gradle/gradle.properties",
    ".m2/settings.xml",
    ".m2/settings-security.xml",
    ".nuget/NuGet",
    ".config/NuGet",
    ".cargo/credentials",
    ".cargo/credentials.toml",
  ].map((entry) => join(home, entry));
}

/**
 * Windows's own places for keys and tokens, and what runs at logon or in each
 * PowerShell, under the profile: added on Windows to what `fs.*` and a chat's
 * folder never touch (`credentialHomes`, `credentialFiles` and
 * `persistenceLocations` name the macOS and Linux places, which the sandbox's
 * compiled policies hold too).
 */
export function windowsProtectedPlaces(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): { readonly credentials: readonly string[]; readonly persistence: readonly string[] } {
  if (platform !== "win32") return { credentials: [], persistence: [] };
  const under = (entries: readonly string[]): readonly string[] => entries.map((entry) => join(home, entry));
  return {
    credentials: under([
      "AppData/Roaming/Microsoft/Credentials",
      "AppData/Local/Microsoft/Credentials",
      "AppData/Roaming/Microsoft/Protect",
      "AppData/Roaming/Microsoft/Crypto",
      "AppData/Roaming/Microsoft/SystemCertificates",
      "AppData/Roaming/GitHub CLI",
      "AppData/Roaming/gcloud",
      "AppData/Roaming/Bitwarden CLI",
      "AppData/Local/1Password",
      "AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine",
      "_netrc",
    ]),
    persistence: under([
      "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
      "Documents/PowerShell",
      "Documents/WindowsPowerShell",
    ]),
  };
}

/**
 * The owner's files that commonly hold an exported API key or token — shell
 * profiles and histories, git's and gh's stored tokens — refused as
 * `credentialHomes` are, by name, wherever they lie in a folder a chat
 * reaches (`$HOME` attached): never read or written by `fs.*` or the folder's
 * file listing and download, denied to `sandbox.run`, and never a chat's folder.
 */
export function credentialFiles(home: string = homedir()): readonly string[] {
  return [
    ".zshrc",
    ".zshenv",
    ".zprofile",
    ".zsh_history",
    ".bashrc",
    ".bash_profile",
    ".bash_history",
    ".profile",
    ".git-credentials",
    ".gitconfig",
    ".config/gh",
  ].map((entry) => join(home, entry));
}

/**
 * What the owner's login, shell, git or desktop runs from `$HOME` on its own:
 * launch agents, git's user config (its hooks and `core.fsmonitor` among it),
 * the user's binary folders on `PATH`, login and logout shell profiles, fish's
 * and Neovim's config, autostart entries, systemd user units and session
 * environment (`environment.d`), and Python's per-user `site-packages` (a
 * `.pth` file there runs at every interpreter start) for each
 * `~/.local/lib/python*` folder present when asked. Never written by `fs.*` or
 * `sandbox.run`, whatever folder a chat attaches read-write — `~/.config` or
 * `~/Library` too, which hold some of them — but readable where the folder
 * is: `sandbox.run` re-opens `~/.local/bin` and `~/.cargo/bin` read-only as
 * toolchains, so they are kept out of `credentialHomes`, which closes reads.
 */
export function persistenceLocations(home: string = homedir()): readonly string[] {
  return [
    "Library/LaunchAgents",
    ".config/git",
    ".local/bin",
    ".cargo/bin",
    ".zlogin",
    ".zprofile",
    ".bash_login",
    ".config/fish",
    ".config/autostart",
    ".config/systemd/user",
    ".config/environment.d",
    ".config/nvim",
    ".bash_logout",
    ".zlogout",
    // What a terminal, multiplexer, prompt or window manager runs at its start.
    ".tmux.conf",
    ".config/tmux",
    ".config/direnv",
    ".config/mise",
    ".config/wezterm",
    ".wezterm.lua",
    ".config/kitty",
    ".config/ghostty",
    ".config/alacritty",
    ".config/starship.toml",
    ".config/i3",
    ".config/sway",
    ".config/hypr",
    "Library/Application Support/iTerm2/Scripts/AutoLaunch",
    // An editor's user tasks and settings, its profiles' too, and IPython's startup scripts.
    ...editorUserFiles(),
    ".ipython/profile_default/startup",
    ...pythonUserSites(home),
  ].map((entry) => join(home, entry));
}

/** VS Code's and its forks' user settings, tasks, key bindings and profiles, where macOS and Linux keep them, relative to `$HOME`. */
function editorUserFiles(): string[] {
  const editors = ["Code", "Code - Insiders", "VSCodium", "Cursor"];
  const parents = ["Library/Application Support", ".config"];
  return parents.flatMap((parent) =>
    editors.flatMap((editor) =>
      ["settings.json", "tasks.json", "keybindings.json", "profiles"].map((entry) => join(parent, editor, "User", entry)),
    ),
  );
}

/** `.local/lib/python*\/site-packages` for each Python version folder under `home`, relative to it; none when it cannot be listed. */
function pythonUserSites(home: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(home, ".local", "lib"));
  } catch {
    return [];
  }
  return names.filter((name) => name.startsWith("python")).map((name) => join(".local", "lib", name, "site-packages"));
}

/** The origins an attended person starts a chat from (`tavi`, `tavi chat`, `tavi run`, the canvas): they get the first root read-only. */
const INTERACTIVE_ORIGINS: ReadonlySet<string> = new Set<TaskOrigin>(["cli", "ipc", "web"]);

/** Whether the filesystem may fold case: refusals compare folded there, so matching too much is the safe side. */
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";

/**
 * Why the owner's `$HOME`, or a folder holding it, is never a chat's primary
 * nor attached read-write (`attach`): what trusting all of it would mean.
 * Read-only it may be attached (`--fs-root ~`).
 */
function homePrimaryRefusal(real: string, home: string, attach = false): string {
  if (attach)
    return withinFolded(real, home)
      ? "Your home folder itself cannot be attached read-write; attach it read-only, or a folder inside it"
      : `${real} holds your home folder, which a chat never writes whole; attach it read-only, or a folder inside your home folder`;
  return withinFolded(real, home)
    ? "Your home folder itself cannot be a chat's folder; choose a folder inside it"
    : `${real} holds your home folder, which a chat's folder never does; choose a folder inside your home folder`;
}

/** How a host entry is used, which `#checkHost` checks it for: a primary and a read-write attachment are written. */
type HostRole = "primary" | ChatFolderAttachment["mode"];

/** How deep a delegation chain or a side chat's parents are followed. */
const MAX_HOPS = 32;
const MAX_SIDE_DEPTH = 8;

/** The task fields a folder is resolved from. */
export interface ChatFolderTask {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly origin: TaskOrigin | null;
  readonly chatKind?: ChatKind;
  readonly parentChatId?: string;
}

type Maybe<T> = T | Promise<T>;

export interface ChatFoldersOptions {
  /** The data directory; managed folders live in its `chats/`, which is otherwise closed to every tool. */
  readonly dataDirectory: string;
  /** `tavi serve --fs-root`, absolute: the folders a chat may attach. */
  readonly fsRoots: readonly string[];
  /** `tavi serve --dev-plugin` folders: never a chat's primary or attachment. */
  readonly devPluginFolders?: readonly string[];
  /** The owner's `$HOME`: never a primary itself, and where the credential homes are. */
  readonly homeDirectory: string;
  readonly repository: {
    get(taskId: string): Maybe<ChatFolderRow | undefined>;
    revision(taskId: string): Maybe<number>;
    write(input: WriteChatFolderInput): Maybe<ChatFolderRow>;
    /** Folder taint; absent, no folder is ever read as tainted. */
    markTainted?(input: { readonly taskId: string; readonly workspaceId: string; readonly now: string }): Maybe<string>;
    taintedAt?(taskId: string): Maybe<string | undefined>;
    recordTaintedWrite?(input: {
      readonly workspaceId: string;
      readonly path: string;
      readonly sha256: string;
      readonly taskId?: string | undefined;
      readonly file?: HostFileIdentity | undefined;
      readonly now: string;
    }): Maybe<void>;
    taintedWriteOf?(input: {
      readonly workspaceId: string;
      readonly path: string;
      readonly sha256: string;
      readonly file?: HostFileIdentity | undefined;
    }): Maybe<{ readonly taskId?: string } | undefined>;
    taintedWritesUnder?(input: {
      readonly workspaceId: string;
      readonly roots: readonly string[];
    }): Maybe<readonly { readonly path: string; readonly sha256: string; readonly taskId?: string }[]>;
  };
  /**
   * Whether a chat's conversation is tainted now, from its checkpoint: how a
   * side chat or a worker learns that the chat whose folder it reads became
   * tainted during a turn not yet ended. Absent, only the recorded stamp and
   * the turn's own taint count.
   */
  readonly chatTainted?: (taskId: string) => Promise<boolean>;
  readonly tasks: { get(taskId: string): Maybe<ChatFolderTask | undefined> };
  /** Where a worker's delegation is recorded: a worker uses its root chat's folder. */
  readonly agentDelegations: {
    getByWorkerTaskId(
      workerTaskId: string,
    ): Maybe<{ readonly rootTaskId?: string | undefined; readonly parentTaskId?: string | undefined } | undefined>;
  };
  /** Whether a principal acts in a workspace (`AccessPolicy.actsIn`); `set` requires it when given. */
  readonly actsIn?: (workspaceId: string, principalId: string) => boolean;
  readonly now?: () => string;
}

/** What one turn's folder depends on besides the chat's record. */
export interface ChatFolderTurn {
  /** A turn held to a messaging channel sees the managed folder only (I-messaging). */
  readonly heldChannel?: TurnChannel | undefined;
  /** The conversation was tainted when the turn was admitted. */
  readonly tainted?: boolean | undefined;
  /**
   * The chat a worker's spawn names (`InvocationContext.chatTaskId`), for a
   * first turn that runs before its delegation is recorded — an unattended
   * spawn joins its worker and records it after: the worker then works in
   * that chat's folder from its first turn, never one of its own.
   * Honoured only for a worker with no delegation, and only for a chat of its
   * own workspace and principal.
   */
  readonly delegatedFrom?: string | undefined;
  /**
   * The task's own row as the caller read it in this admission: what is read
   * of it here (its workspace, origin, kind and parent) is fixed when it is
   * created, so it is not read again.
   */
  readonly task?: ChatFolderTask | undefined;
}

export interface ChatFolderScope {
  readonly workspaceId: string;
  readonly principalId: string;
}

/** The record a chat's folder is resolved from: its row, or the defaults it would have. */
interface Base {
  readonly primaryKind: ChatFolderPrimaryKind;
  readonly primaryPath?: string | undefined;
  readonly attachments: readonly ChatFolderAttachment[];
}

/** `path` under `root` or equal to it, by separator-aware `path.relative` — never a string prefix. */
function pathWithin(path: string, root: string): boolean {
  const between = relative(root, path);
  return between === "" || (between !== ".." && !between.startsWith(`..${sep}`) && !isAbsolute(between));
}

/** `pathWithin`, case-folded where the filesystem may be: for refusals, where matching too much is the safe side. */
function withinFolded(path: string, root: string): boolean {
  return FOLD_CASE ? pathWithin(fsFold(path), fsFold(root)) : pathWithin(path, root);
}

/** How `#validate` tells a refused path, by what it was to be: a chat's folder, or a file a schedule's pre-check reads. */
const VALIDATED_AS = {
  directory: {
    rename: "; rename the folder to use it",
    never: "a chat never uses it as its folder",
    noRoot: "This owner has no --fs-root, so a chat works only in its own folder",
  },
  file: {
    rename: "",
    never: "a schedule never reads it",
    noRoot: "This owner has no --fs-root, so a schedule reads no file of the host's",
  },
} as const;

/**
 * The on-disk spelling of a path: its deepest existing ancestor's real path
 * with the rest appended, so a folder not yet created under `/var` still
 * compares as the `/private/var` it will be.
 */
function canonical(path: string): string {
  const missing: string[] = [];
  for (let existing = path; ; ) {
    try {
      return join(realpathSync.native(existing), ...missing);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** A path segment for an id: readable, bounded, and distinct for distinct ids (as browser profiles are named). */
function segment(id: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
  const readable = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  return `${readable}-${sha256Hex(id).slice(0, 12)}`;
}

/** The error a folder that is gone or no longer allowed is refused with. */
function unavailable(what: string, path: string, why: string): TaviError {
  return new TaviError(
    "UNAVAILABLE",
    `This chat's ${what} ${path} ${why}. Run ${CHAT_FOLDER_RESET_COMMAND} to go back to the chat's own folder, or choose another.`,
    { details: { path } },
  );
}

/**
 * Create `relativePath`'s directories under `parent` one level at a time,
 * never through a link (I-nofollow): each component is made with mode `0700`
 * and `lstat`ed, and one that is a link or not a directory is refused. The
 * last is opened `O_NOFOLLOW` and its mode set through that descriptor, never
 * by path; it must still be where it was asked for once every link is
 * resolved, so an ancestor swapped for a link meanwhile is caught.
 */
function makeDirectoryNoFollow(parent: string, components: readonly string[]): string {
  let current = parent;
  let made: Stats | undefined;
  for (const component of components) {
    current = join(current, component);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const status = lstatSync(current);
    if (status.isSymbolicLink())
      throw new TaviError("NOT_AUTHORIZED", `${current} is a link; a chat's folder is never created through one`);
    if (!status.isDirectory()) throw new TaviError("NOT_AUTHORIZED", `${current} is not a directory`);
    made = status;
  }
  // Windows opens no directory this way (no descriptor): there the folder is checked by name, against what was
  // made before its path was resolved, and has no mode to set.
  const fd = openDirectoryNoFollowSync(current);
  try {
    const opened = fd === undefined ? (made ?? lstatSync(current)) : fstatSync(fd);
    if (!opened.isDirectory()) throw new TaviError("NOT_AUTHORIZED", `${current} is not a directory`);
    if (realpathSync.native(current) !== current)
      throw new TaviError("NOT_AUTHORIZED", `${current} resolves elsewhere; a chat's folder is never created through a link`);
    const named = lstatSync(current);
    if (!sameIdentity(named, opened)) throw new TaviError("NOT_AUTHORIZED", `${current} changed while it was created`);
    // Only once the descriptor is known to be the folder asked for.
    if (fd !== undefined && (opened.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return current;
}

/**
 * Resolves and changes chats' working folders. One instance per
 * owner, built with `serve`'s `--fs-root`, `--dev-plugin` and data directory.
 */
export class ChatFolders {
  readonly #options: ChatFoldersOptions;

  constructor(options: ChatFoldersOptions) {
    this.#options = options;
  }

  /** The data directory as the filesystem spells it now (`/var` is `/private/var` on macOS). */
  get #dataDirectory(): string {
    return canonical(resolve(this.#options.dataDirectory));
  }

  /** The owner's `$HOME`, as the filesystem spells it. */
  get #home(): string {
    return canonical(resolve(this.#options.homeDirectory));
  }

  /** What a chat's folder never is nor lies in, read as the filesystem spells it now. */
  get #protectedPaths(): readonly { readonly path: string; readonly why: string }[] {
    return [
      { path: this.#dataDirectory, why: "is inside the tavi data directory" },
      ...credentialHomes(this.#options.homeDirectory).map((path) => ({ path: canonical(path), why: "is a credential directory" })),
      ...credentialFiles(this.#options.homeDirectory).map((path) => ({ path: canonical(path), why: "holds keys or tokens" })),
      ...windowsProtectedPlaces(this.#options.homeDirectory).credentials.map((path) => ({
        path: canonical(path),
        why: "holds keys or tokens",
      })),
      ...(this.#options.devPluginFolders ?? []).map((path) => ({
        path: canonical(resolve(path)),
        why: "is a dev plugin's folder, whose code the owner runs on every save",
      })),
    ];
  }

  /** The current `--fs-root` set, as the filesystem spells it; a root that no longer exists is left out. */
  #roots(): readonly string[] {
    const roots: string[] = [];
    for (const root of this.#options.fsRoots) {
      try {
        const real = realpathSync.native(resolve(root));
        if (statSync(real).isDirectory() && !roots.includes(real)) roots.push(real);
      } catch {
        // A root that is gone grants nothing.
      }
    }
    return roots;
  }

  /** A chat's managed folder: `<data-dir>/chats/<workspace>/<task-id>`, real, whether or not it exists yet. */
  managedPath(workspaceId: string, taskId: string): string {
    return join(this.#dataDirectory, "chats", segment(workspaceId), segment(taskId));
  }

  /**
   * Create a chat's managed folder with its `.tmp/` and `.home/`, if missing
   * (tavi owns it, so a removed one is recreated empty), never
   * through a link (I-nofollow).
   */
  ensureManaged(workspaceId: string, taskId: string): string {
    const managed = makeDirectoryNoFollow(this.#dataDirectory, ["chats", segment(workspaceId), segment(taskId)]);
    makeDirectoryNoFollow(managed, [".tmp"]);
    makeDirectoryNoFollow(managed, [".home"]);
    return managed;
  }

  /**
   * The managed folder a task's approved downloads and reports are copied
   * into: its chat's own — a worker's root chat's — created if missing,
   * never through a link. Never a host folder, whatever the chat's primary is. A task of another workspace is
   * `NOT_FOUND`.
   */
  async managedFolderOf(workspaceId: string, taskId: string): Promise<string> {
    const task = await this.#options.tasks.get(taskId);
    if (task === undefined || task.workspaceId !== workspaceId) throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
    const chat = await this.#rootChat(task);
    return this.ensureManaged(chat.workspaceId, chat.taskId);
  }

  /**
   * The managed folder of a task's chat — a worker's root chat's —
   * as a path, without creating it: what `forget` names.
   */
  async managedFolderPath(workspaceId: string, taskId: string): Promise<string> {
    const task = await this.#options.tasks.get(taskId);
    if (task === undefined || task.workspaceId !== workspaceId) throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
    const chat = await this.#rootChat(task);
    return this.managedPath(chat.workspaceId, chat.taskId);
  }

  /**
   * The chat a task works for — itself, or a worker's root chat —
   * whose managed folder is the task's: what `tavi tasks folders prune
   * --chat` clears.
   */
  async chatOf(workspaceId: string, taskId: string): Promise<ChatFolderTask> {
    const task = await this.#options.tasks.get(taskId);
    if (task === undefined || task.workspaceId !== workspaceId) throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
    return this.#rootChat(task);
  }

  /**
   * Record that a task's chat — itself, or a worker's root chat,
   * following `delegatedFrom` as `resolve` does — is tainted: what a tainted
   * call writes into the chat's managed folder taints whoever reads it later, though the call's own turn was
   * admitted clean. Sticky; nothing without folder taint in the store.
   */
  async markTainted(workspaceId: string, taskId: string, delegatedFrom?: string): Promise<void> {
    const repository = this.#options.repository;
    if (repository.markTainted === undefined) return;
    const task = await this.#options.tasks.get(taskId);
    if (task === undefined || task.workspaceId !== workspaceId) throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
    const chat = await this.#rootChat(task, delegatedFrom);
    await repository.markTainted({ taskId: chat.taskId, workspaceId: chat.workspaceId, now: this.#options.now?.() ?? nowTimestamp() });
  }

  /**
   * Record that a call of this task's chat wrote tainted bytes to a
   * host-folder file, so a later read of the same
   * bytes there is untrusted, in any chat: credited to `from` when they are
   * derived from bytes another chat marked, else to the calling chat (a
   * worker's root chat). `file`: its identity, once it exists.
   */
  async recordTaintedWrite(
    workspaceId: string,
    taskId: string,
    delegatedFrom: string | undefined,
    path: string,
    sha256: string,
    from?: { readonly taskId?: string },
    file?: HostFileIdentity,
  ): Promise<void> {
    const repository = this.#options.repository;
    if (repository.recordTaintedWrite === undefined) return;
    const task = await this.#options.tasks.get(taskId);
    if (task === undefined || task.workspaceId !== workspaceId) throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
    const writer = from === undefined ? (await this.#rootChat(task, delegatedFrom)).taskId : from.taskId;
    await repository.recordTaintedWrite({
      workspaceId,
      path,
      sha256,
      ...(writer === undefined ? {} : { taskId: writer }),
      ...(file === undefined ? {} : { file }),
      now: this.#options.now?.() ?? nowTimestamp(),
    });
  }

  /**
   * The managed folders a turn of this task's chat reaches that are recorded
   * tainted now: its chat's own, and a side chat's parent's. Read at
   * read time, so a taint recorded since the turn's folder was resolved — a
   * worker's tainted write into its root chat's folder — is seen.
   */
  async taintedFoldersNow(workspaceId: string, taskId: string, delegatedFrom?: string): Promise<readonly ChatFolderTaint[]> {
    const repository = this.#options.repository;
    if (repository.taintedAt === undefined) return [];
    const task = await this.#options.tasks.get(taskId);
    if (task === undefined || task.workspaceId !== workspaceId) return [];
    const chat = await this.#rootChat(task, delegatedFrom);
    const chats = [chat.taskId, ...(chat.chatKind === "side" && chat.parentChatId !== undefined ? [chat.parentChatId] : [])];
    const tainted: ChatFolderTaint[] = [];
    for (const id of chats)
      if ((await repository.taintedAt(id)) !== undefined) tainted.push({ path: this.managedPath(chat.workspaceId, id), taskId: id });
    return tainted;
  }

  /** The tainted write that left a host-folder file holding exactly these bytes (`recordTaintedWrite`), if one did. */
  async taintedWriteOf(
    workspaceId: string,
    path: string,
    sha256: string,
    file?: HostFileIdentity,
  ): Promise<{ readonly taskId?: string } | undefined> {
    return await this.#options.repository.taintedWriteOf?.({ workspaceId, path, sha256, ...(file === undefined ? {} : { file }) });
  }

  /** The newest marks on host files under `roots` (`recordTaintedWrite`), for a shell call that can read them. */
  async taintedWritesUnder(
    workspaceId: string,
    roots: readonly string[],
  ): Promise<readonly { readonly path: string; readonly sha256: string; readonly taskId?: string }[]> {
    return (await this.#options.repository.taintedWritesUnder?.({ workspaceId, roots })) ?? [];
  }

  /** A chat's stored revision, 0 with no record: what `folder show` answers when the folder cannot be resolved. */
  async revisionOf(taskId: string): Promise<number> {
    return this.#options.repository.revision(taskId);
  }

  /** The current `--fs-root` folders, real and existing: where the canvas's picker starts. */
  attachableRoots(): readonly string[] {
    return this.#roots();
  }

  /**
   * Why a real path is never offered or used as a chat's folder, if it is not
   * (the folder picker's rule): inside the data directory, a credential home or a dev
   * plugin's folder, or spelled with a glob character the sandbox would read
   * as a pattern. Roots are not checked here.
   */
  refusalOf(real: string): string | undefined {
    if (/[*?[\]]/.test(real)) return "has *, ?, [ or ] in its path";
    if (hasLineUnsafeCharacters(real)) return "has a line break or a control character in its path";
    return this.#protectedPaths.find((entry) => withinFolded(real, entry.path))?.why;
  }

  /**
   * A host folder a run may start a chat in, checked before
   * anything is admitted: as `set` checks a primary — absolute, under a
   * current `--fs-root`, outside the data directory, the credential homes and
   * the dev plugins' folders, an existing directory — and never the owner's
   * `$HOME` itself. The answer is its real path.
   */
  checkPrimary(path: string): string {
    const real = this.#validate(path, this.#roots());
    if (withinFolded(this.#home, real)) throw new TaviError("NOT_AUTHORIZED", homePrimaryRefusal(real, this.#home));
    return real;
  }

  /**
   * A folder a new chat is to start with attached (`run.folderAttachments`),
   * checked before its run is admitted as an attach checks it: the answer is
   * its real path, or a refusal. Its overlaps are checked when it is attached.
   */
  checkAttachment(path: string, mode: ChatFolderMode): string {
    const real = this.#validate(path, this.#roots());
    if (mode === "rw" && withinFolded(this.#home, real)) throw new TaviError("NOT_AUTHORIZED", homePrimaryRefusal(real, this.#home, true));
    return real;
  }

  /**
   * A file a schedule's pre-check may read, checked when the schedule is saved
   * and again before each check: absolute, an existing regular file, under a
   * current `--fs-root`, and outside the data directory, the credential homes
   * and the dev plugins' folders — the folders' own rule. The answer is its
   * real path, so a link is checked, and read, where it leads.
   */
  checkReadableFile(path: string): string {
    return this.#validate(path, this.#roots(), "file");
  }

  /**
   * The folder one turn of a chat sees, resolved once per admission.
   *
   * A worker's is its root chat's. A turn held to a messaging channel
   * sees the managed folder only. A chat with no record gets its
   * origin's defaults (c), a side chat inheriting its parent's attachments
   * and its parent's managed folder read-only (f). Every host entry is
   * realpathed, `stat`ed and checked against the current roots, and a chat
   * whose host folder is gone or no longer allowed is refused with an error
   * naming `/folder reset` (j). A managed folder that cannot be created does
   * not refuse the turn: `managedUnavailable` says why.
   */
  async resolve(scope: ChatFolderScope, taskId: string, turn: ChatFolderTurn = {}): Promise<ChatFolder> {
    const task = await this.#task(scope, taskId, turn.task);
    const chat = await this.#rootChat(task, turn.delegatedFrom);
    const managed = this.managedPath(chat.workspaceId, chat.taskId);
    let managedUnavailable: string | undefined;
    try {
      this.ensureManaged(chat.workspaceId, chat.taskId);
    } catch (error) {
      managedUnavailable = `This chat's own folder ${managed} could not be created: ${errorMessage(error)}`.slice(0, 1_000);
    }
    // Folder taint: the chat whose managed folder this is, recorded once its conversation is tainted —
    // by this turn (a worker's turn writes its root chat's folder), or as its checkpoint now says.
    const taintedFolders: ChatFolderTaint[] = [];
    if (await this.#folderTainted(chat, turn.tainted === true, task.taskId !== chat.taskId))
      taintedFolders.push({ path: managed, taskId: chat.taskId });
    const common = {
      managed,
      scratch: join(managed, ".tmp"),
      home: join(managed, ".home"),
      ...(turn.tainted === true ? { tainted: true as const } : {}),
      ...(managedUnavailable === undefined ? {} : { managedUnavailable }),
    };
    const row = chat.chatKind === "worker" ? undefined : await this.#options.repository.get(chat.taskId);
    const revision = row?.revision ?? 0;
    if (turn.heldChannel === "messaging") {
      return {
        primary: managed,
        primaryKind: "managed",
        attachments: [],
        revision,
        ...common,
        ...(taintedFolders.length === 0 ? {} : { taintedFolders }),
      };
    }
    const base: Base = row ?? (await this.#defaults(chat, 0));
    const entries = this.#hostEntries(base);
    const primary = entries.primary ?? managed;
    const attachments = [...entries.attachments];
    // A side chat reads its parent's own folder, read-only, whatever its record.
    const parentManaged = await this.#parentManaged(chat);
    if (parentManaged !== undefined && !attachments.some((attachment) => attachment.path === parentManaged.attachment.path)) {
      attachments.push({ ...parentManaged.attachment, label: uniqueLabel(parentManaged.attachment.label, attachments) });
    }
    // What the side chat reads of its parent's folder is what the parent's conversation wrote there.
    if (parentManaged !== undefined && (await this.#folderTainted(parentManaged.parent, false, true)))
      taintedFolders.push({ path: parentManaged.attachment.path, taskId: parentManaged.parent.taskId });
    return {
      primary,
      primaryKind: primary === managed ? "managed" : "host",
      attachments,
      revision,
      ...common,
      ...(taintedFolders.length === 0 ? {} : { taintedFolders }),
    };
  }

  /**
   * Change a chat's folder, from the chat's next message on. The
   * caller's principal must own the chat in its workspace; a worker has no
   * folder of its own; a messaging chat and a web caller never name a host
   * path (I-web). The answer is the folder as the chat's next turn sees it.
   */
  async set(scope: ChatFolderScope, taskId: string, change: ChatFolderChange, caller: ChatFolderCaller): Promise<ChatFolder> {
    return this.#change(scope, taskId, change, caller, false);
  }

  /**
   * A new chat's primary folder, from the run that created it (`run.folder`
   * or `run.clientCwd`), before its first turn resolves its
   * folder. As `set` with a `primary` change, except that a default
   * attachment it overlaps — the first root read-only, or a side chat's
   * inherited one, which nobody chose for it — gives way to it rather than
   * refusing it. A chat that already has a record
   * is `CONFLICT`: only a run's own first admission begins a chat.
   */
  async begin(scope: ChatFolderScope, taskId: string, path: string, caller: ChatFolderCaller): Promise<ChatFolder> {
    return this.#change(scope, taskId, { kind: "primary", path }, caller, true);
  }

  async #change(
    scope: ChatFolderScope,
    taskId: string,
    change: ChatFolderChange,
    caller: ChatFolderCaller,
    beginning: boolean,
  ): Promise<ChatFolder> {
    const task = await this.#task(scope, taskId);
    // The chat's own principal, acting in a workspace this owner serves for it (`AccessPolicy`).
    if (task.principalId !== scope.principalId) throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
    if (this.#options.actsIn !== undefined && !this.#options.actsIn(scope.workspaceId, scope.principalId)) {
      throw new TaviError("NOT_AUTHORIZED", `${scope.principalId} does not act in workspace ${scope.workspaceId}`);
    }
    if (task.chatKind === "worker" || task.origin === "agent") {
      throw new TaviError("INVALID_INPUT", `task ${taskId} is a worker, not a chat: set the folder of the chat it works for`);
    }
    if (change.kind === "primary" || change.kind === "attach") {
      if (caller.frontEnd === "web" && caller.picked !== true)
        throw new TaviError("NOT_AUTHORIZED", "The canvas cannot name a host folder; pick one from the folder list instead");
      if (task.origin === "messaging")
        throw new TaviError("NOT_AUTHORIZED", "A chat a messaging conversation started works only in its own folder");
    }
    // A reset reads only the revision, so a record that can no longer be read is still cleared.
    const row = change.kind === "reset" ? undefined : await this.#options.repository.get(taskId);
    const expectedRevision = change.kind === "reset" ? await this.#options.repository.revision(taskId) : (row?.revision ?? 0);
    // A change starts from what the chat resolves to now: its defaults until it has a record.
    if (beginning && row !== undefined)
      throw new TaviError("CONFLICT", `Chat ${taskId} already has a folder; change it with ${CHAT_FOLDER_RESET_COMMAND.split(" ")[0]}`);
    // A side chat's defaults leave out what its parent has that is gone, so a reset always recovers it.
    const base: Base = row ?? (await this.#defaults(task, 0, true));
    // Defaults nobody chose (no record yet) give way to a folder inside or around one, as at a chat's beginning:
    // `/folder set ~/code/site` under a default `code` attachment works in site, rather than being refused.
    // A side chat's defaults are its parent's, whose modes it may only narrow: only its beginning gives way there.
    const givesWay =
      change.kind === "primary"
        ? beginning || row === undefined
        : change.kind === "attach" && row === undefined && task.chatKind !== "side";
    const next = this.#apply(
      givesWay && (change.kind === "primary" || change.kind === "attach")
        ? this.#givingWay(base, change.path, task.chatKind === "side")
        : base,
      change,
    );
    // Checked as the chat's next turn checks it, before it is stored: a change is never stored and then refused.
    this.#hostEntries(next);
    await this.#options.repository.write({
      taskId,
      workspaceId: task.workspaceId,
      primaryKind: next.primaryKind,
      ...(next.primaryKind === "host" && next.primaryPath !== undefined ? { primaryPath: next.primaryPath } : {}),
      attachments: next.attachments,
      expectedRevision,
      now: (this.#options.now ?? nowTimestamp)(),
    });
    return this.resolve(scope, taskId);
  }

  /**
   * A new chat's defaults with the attachments a primary at `path` would
   * overlap left out: nobody chose them (`begin`). A side chat's are its
   * parent's, whose modes it may only narrow: one gives way only
   * to a primary inside a folder the parent writes; a primary in or around
   * one the parent reads only is refused, never made writable.
   */
  #givingWay(base: Base, path: string, side: boolean): Base {
    if (!isAbsolute(path)) return base;
    const real = canonical(resolve(path));
    const overlapping = (attachment: ChatFolderAttachment): boolean =>
      withinFolded(real, attachment.path) || withinFolded(attachment.path, real);
    const widened = side
      ? base.attachments.find((attachment) => overlapping(attachment) && !(attachment.mode === "rw" && withinFolded(real, attachment.path)))
      : undefined;
    if (widened !== undefined) {
      throw new TaviError(
        "NOT_AUTHORIZED",
        `${real} overlaps "${widened.label}", a folder this side chat has from its parent chat ${widened.mode === "ro" ? "read-only" : "read-write"}; a side chat cannot write more of it than its parent gave it`,
      );
    }
    return { ...base, attachments: base.attachments.filter((attachment) => !overlapping(attachment)) };
  }

  #apply(base: Base, change: ChatFolderChange): Base {
    const roots = this.#roots();
    switch (change.kind) {
      case "reset":
        return base;
      case "managed":
        return { primaryKind: "managed", attachments: base.attachments };
      case "primary": {
        const path = this.#validate(change.path, roots);
        if (withinFolded(this.#home, path)) throw new TaviError("NOT_AUTHORIZED", homePrimaryRefusal(path, this.#home));
        const overlap = base.attachments.find((attachment) => withinFolded(path, attachment.path) || withinFolded(attachment.path, path));
        if (overlap !== undefined)
          throw new TaviError("CONFLICT", `${path} overlaps the attached folder "${overlap.label}"; detach it first`);
        return { primaryKind: "host", primaryPath: path, attachments: base.attachments };
      }
      case "attach": {
        const path = this.#validate(change.path, roots);
        // Only an attach is bounded: what a chat inherits may be more, and a reset or a detach always goes through.
        if (base.attachments.length >= CHAT_FOLDER_ATTACHMENTS_MAX) {
          const over = base.attachments.length - CHAT_FOLDER_ATTACHMENTS_MAX + 1;
          throw new TaviError(
            "INVALID_INPUT",
            `A chat attaches at most ${CHAT_FOLDER_ATTACHMENTS_MAX} folders; this one has ${base.attachments.length}: detach ${over === 1 ? "one" : over} first`,
          );
        }
        const mode = change.mode ?? "ro";
        if (mode === "rw" && withinFolded(this.#home, path))
          throw new TaviError("NOT_AUTHORIZED", homePrimaryRefusal(path, this.#home, true));
        const overlap = base.attachments.find((attachment) => withinFolded(path, attachment.path) || withinFolded(attachment.path, path));
        if (overlap !== undefined)
          throw new TaviError("CONFLICT", `${path} overlaps the attached folder "${overlap.label}"; detach it first`);
        if (
          base.primaryKind === "host" &&
          base.primaryPath !== undefined &&
          (withinFolded(path, base.primaryPath) || withinFolded(base.primaryPath, path))
        ) {
          throw new TaviError("CONFLICT", `${path} overlaps the chat's primary folder`);
        }
        const attachment = { path, mode, label: uniqueLabel(labelOf(path), base.attachments, true) } as const;
        return { ...base, attachments: [...base.attachments, attachment] };
      }
      case "detach": {
        if (!base.attachments.some((attachment) => attachment.label === change.label))
          throw new TaviError("NOT_FOUND", `This chat has no attached folder "${change.label}"`);
        return { ...base, attachments: base.attachments.filter((attachment) => attachment.label !== change.label) };
      }
    }
  }

  /**
   * A host path a chat is to use: absolute, its deepest existing ancestor
   * resolved, under a current `--fs-root` by separator-aware containment,
   * outside the data directory, the credential homes and every dev plugin's
   * folder, and an existing directory spelled without a glob character — or,
   * for a schedule's pre-check, an existing regular file.
   */
  #validate(path: string, roots: readonly string[], kind: "directory" | "file" = "directory"): string {
    if (!isAbsolute(path)) throw new TaviError("INVALID_INPUT", `${path} is not an absolute path`);
    const real = canonical(resolve(path));
    const told = VALIDATED_AS[kind];
    // `sandbox.run`'s policy reads a folder as a pattern, which would match other folders than this one.
    if (kind === "directory" && /[*?[\]]/.test(real))
      throw new TaviError(
        "INVALID_INPUT",
        `${real} has *, ?, [ or ] in its path, which the sandbox reads as a pattern; rename the folder to use it`,
      );
    // Its path is stated to the model on one line: a name that would break the line is never a chat's folder.
    if (hasLineUnsafeCharacters(real))
      throw new TaviError("INVALID_INPUT", `${lineSafe(real)} has a line break or a control character in its path${told.rename}`);
    const refused = this.#protectedPaths.find((entry) => withinFolded(real, entry.path));
    if (refused !== undefined) throw new TaviError("NOT_AUTHORIZED", `${real} ${refused.why}; ${told.never}`);
    if (!roots.some((root) => pathWithin(real, root))) {
      throw new TaviError("NOT_AUTHORIZED", roots.length === 0 ? told.noRoot : `${real} is not under an --fs-root`);
    }
    let matches = false;
    try {
      const status = statSync(real);
      matches = kind === "directory" ? status.isDirectory() : status.isFile();
    } catch {
      throw new TaviError("NOT_FOUND", `${real} does not exist`);
    }
    if (!matches) throw new TaviError("INVALID_INPUT", `${real} is not a ${kind}`);
    return real;
  }

  /** A folder's host entries as real paths, each checked as a turn checks it; the first that fails refuses. */
  #hostEntries(base: Base): { readonly primary?: string; readonly attachments: readonly ChatFolderAttachment[] } {
    const roots = this.#roots();
    return {
      ...(base.primaryKind === "host" && base.primaryPath !== undefined
        ? { primary: this.#checkHost("primary folder", base.primaryPath, roots, "primary") }
        : {}),
      attachments: base.attachments.map((attachment) => ({
        ...attachment,
        path: this.#checkHost(`attached folder "${attachment.label}"`, attachment.path, roots, attachment.mode),
      })),
    };
  }

  /** Whether a host entry `#checkHost` would accept now, in `role`. */
  #usable(path: string, role: HostRole): boolean {
    try {
      this.#checkHost("folder", path, this.#roots(), role);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A stored host entry, checked again for this turn: it exists,
   * is a directory, and is still allowed — and a primary, or a read-write
   * attachment, is never the owner's `$HOME` nor a folder holding it.
   */
  #checkHost(what: string, path: string, roots: readonly string[], role: HostRole): string {
    let real: string;
    try {
      real = realpathSync.native(path);
      if (!statSync(real).isDirectory()) throw new Error("not a directory");
    } catch {
      throw unavailable(what, path, "no longer exists");
    }
    // Swapped since for a link to a folder whose name the sandbox's policy or the prompt's line cannot take.
    if (/[*?[\]]/.test(real) || hasLineUnsafeCharacters(real))
      throw unavailable(
        what,
        path,
        "now leads to a folder with a character in its path (*, ?, [, ], a line break or a control character) that a chat's folder never has",
      );
    if (this.#protectedPaths.some((entry) => withinFolded(real, entry.path))) throw unavailable(what, path, "is no longer allowed");
    if (!roots.some((root) => pathWithin(real, root))) throw unavailable(what, path, "is no longer under an --fs-root");
    if (role !== "ro" && withinFolded(this.#home, real))
      throw unavailable(
        what,
        path,
        role === "rw"
          ? withinFolded(real, this.#home)
            ? "is your home folder itself, which a chat never writes whole"
            : "holds your home folder, which a chat never writes whole"
          : withinFolded(real, this.#home)
            ? "is your home folder itself, which is never a chat's folder"
            : "holds your home folder, which a chat's folder never does",
      );
    return real;
  }

  /**
   * What a chat with no record has: its managed folder, and for
   * an interactive origin the first root read-only. A side chat inherits its
   * parent's attachments with their modes, and its parent's host primary
   * read-only; its parent's managed folder is added at resolve.
   * `usableOnly` (a change, a reset above all) leaves out an inherited folder
   * that is gone or no longer allowed, so the side chat is never stuck with
   * its parent's: the parent's record is the parent's, and is left as it is.
   */
  async #defaults(task: ChatFolderTask, depth: number, usableOnly = false): Promise<Base> {
    if (task.chatKind === "side" && task.parentChatId !== undefined && depth < MAX_SIDE_DEPTH) {
      const parent = await this.#options.tasks.get(task.parentChatId);
      if (parent !== undefined && parent.workspaceId === task.workspaceId) {
        let parentRow: ChatFolderRow | undefined;
        try {
          parentRow = await this.#options.repository.get(parent.taskId);
        } catch (error) {
          // A parent's record that no longer reads (`UNAVAILABLE`, naming that record) is the parent's to reset:
          // a change inherits nothing from it. Any other failure (a store closing) is no answer, and fails the change.
          if (!usableOnly || !(error instanceof TaviError && error.code === "UNAVAILABLE" && error.details?.["taskId"] === parent.taskId))
            throw error;
          return { primaryKind: "managed", attachments: [] };
        }
        const parentBase: Base = parentRow ?? (await this.#defaults(parent, depth + 1, usableOnly));
        const keep = (path: string, role: HostRole): boolean => !usableOnly || this.#usable(path, role);
        const attachments: ChatFolderAttachment[] = [];
        if (parentBase.primaryKind === "host" && parentBase.primaryPath !== undefined && keep(parentBase.primaryPath, "ro")) {
          attachments.push({
            path: parentBase.primaryPath,
            mode: "ro",
            label: uniqueLabel(labelOf(parentBase.primaryPath), attachments, true),
          });
        }
        for (const attachment of parentBase.attachments) {
          if (attachments.some((entry) => entry.path === attachment.path) || !keep(attachment.path, attachment.mode)) continue;
          attachments.push({ ...attachment, label: uniqueLabel(attachment.label, attachments, true) });
        }
        // Every one, never cut to the attach bound: a parent's primary and its full set of attachments is one more.
        return { primaryKind: "managed", attachments };
      }
    }
    const first = this.#roots()[0];
    if (first === undefined || task.origin === null || !INTERACTIVE_ORIGINS.has(task.origin))
      return { primaryKind: "managed", attachments: [] };
    return { primaryKind: "managed", attachments: [{ path: first, mode: "ro", label: labelOf(first) }] };
  }

  /**
   * Whether `chat`'s managed folder is tainted: it
   * was recorded so, or `known` (this turn is tainted), or — for another
   * chat than the turn's own (`ask`), whose taint the turn already knows —
   * the chat's checkpoint says so now; the last two are recorded, sticky. A store that
   * cannot say is read as clean; a checkpoint that
   * cannot be read is read as tainted for this resolve (fail safe), and not
   * recorded.
   */
  async #folderTainted(chat: ChatFolderTask, known: boolean, ask: boolean): Promise<boolean> {
    const repository = this.#options.repository;
    if (repository.markTainted === undefined || repository.taintedAt === undefined) return known;
    if (!known && (await repository.taintedAt(chat.taskId)) !== undefined) return true;
    let tainted = known;
    if (!tainted && ask && this.#options.chatTainted !== undefined) {
      try {
        tainted = await this.#options.chatTainted(chat.taskId);
      } catch {
        // Unknown: this read is held tainted, but nothing is recorded — the next resolve asks again.
        return true;
      }
    }
    if (!tainted) return false;
    try {
      await repository.markTainted({ taskId: chat.taskId, workspaceId: chat.workspaceId, now: this.#options.now?.() ?? nowTimestamp() });
    } catch {
      // A chat whose record is gone has no folder left to protect; the read is still labelled.
    }
    return true;
  }

  /** A side chat's parent's managed folder, attached read-only; created as the parent's would be. */
  async #parentManaged(
    chat: ChatFolderTask,
  ): Promise<{ readonly attachment: ChatFolderAttachment; readonly parent: ChatFolderTask } | undefined> {
    if (chat.chatKind !== "side" || chat.parentChatId === undefined) return undefined;
    const parent = await this.#options.tasks.get(chat.parentChatId);
    if (parent === undefined || parent.workspaceId !== chat.workspaceId) return undefined;
    try {
      const path = this.ensureManaged(parent.workspaceId, parent.taskId);
      return { attachment: { path, mode: "ro", label: CHAT_FOLDER_PARENT_LABEL }, parent };
    } catch {
      // The parent's folder is the parent's: one that cannot be made is not attached.
      return undefined;
    }
  }

  async #task(scope: ChatFolderScope, taskId: string, known?: ChatFolderTask): Promise<ChatFolderTask> {
    const task = known?.taskId === taskId ? known : await this.#options.tasks.get(taskId);
    if (task === undefined || task.workspaceId !== scope.workspaceId) throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
    return task;
  }

  /**
   * The chat a task works for: itself, or a worker's delegation root.
   * A worker with no delegation yet follows `delegatedFrom`, its spawn's
   * chat; one whose root cannot be read keeps its own managed folder.
   */
  async #rootChat(task: ChatFolderTask, delegatedFrom?: string): Promise<ChatFolderTask> {
    let current = task;
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      if (current.chatKind !== "worker" && current.origin !== "agent") return current;
      const delegation = await this.#options.agentDelegations.getByWorkerTaskId(current.taskId);
      const named =
        hop === 0 && delegation === undefined && delegatedFrom !== undefined ? await this.#options.tasks.get(delegatedFrom) : undefined;
      const next =
        delegation?.rootTaskId ?? delegation?.parentTaskId ?? (named?.principalId === task.principalId ? named.taskId : undefined);
      if (next === undefined || next === current.taskId) return current;
      const record = await this.#options.tasks.get(next);
      if (record === undefined || record.workspaceId !== task.workspaceId) return current;
      current = record;
    }
    return current;
  }
}

/** An attachment's label: its folder's name, bounded. */
function labelOf(path: string): string {
  return (basename(path) || "folder").slice(0, CHAT_FOLDER_LABEL_MAX - 8);
}

/**
 * `label`, or `label-2`, `label-3`, … — the first no attachment has. A
 * stored attachment's (`reserved`) is never `parent-chat`, the label a side
 * chat's parent's folder is attached by at resolve, so it is never renamed
 * then — nor detached by a name it does not have.
 */
function uniqueLabel(label: string, taken: readonly ChatFolderAttachment[], reserved = false): string {
  const used = new Set([...taken.map((attachment) => attachment.label), ...(reserved ? [CHAT_FOLDER_PARENT_LABEL] : [])]);
  if (!used.has(label)) return label;
  for (let index = 2; ; index += 1) if (!used.has(`${label}-${index}`)) return `${label}-${index}`;
}
