import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { CHAT_FOLDER_RESET_COMMAND, type ChatFolder, type InvocationContext, TaviError } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { canonical, within } from "../folders/fs-tools.js";
import type { SandboxBase } from "./sandbox-policy.js";

/** The chat's folders as the shell reaches them: where it runs, its own `.home/` and `.tmp/`, and which are the person's. */

/** The chat's folders, as the filesystem spells them now. */
export function foldersOf(folder: ChatFolder): {
  readonly primary: string;
  readonly managed: string;
  readonly attachments: readonly { readonly path: string; readonly mode: "ro" | "rw" }[];
} {
  return {
    primary: canonical(folder.primary),
    managed: canonical(folder.managed),
    attachments: folder.attachments.map((attachment) => ({ path: canonical(attachment.path), mode: attachment.mode })),
  };
}

/** The refusal for a call with no folder and no recorded reason: one made outside a chat's turn. */
const NO_FOLDER_MESSAGE = `This call has no working folder, so sandbox.run cannot run: it works only in a chat's turn, in that chat's folder. If this is a chat, run ${CHAT_FOLDER_RESET_COMMAND}.`;

/**
 * The chat's `.home/` or `.tmp/`, a real folder: made when missing (one level,
 * under a managed folder tavi made), refused when something else — a link
 * the shell planted — stands there (I-nofollow).
 */
export function ensureOwnFolder(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new TaviError("UNAVAILABLE", `sandbox.run could not make ${path}: ${errorMessage(error)}`);
  }
  if (!lstatSync(path).isDirectory())
    throw new TaviError(
      "UNAVAILABLE",
      `${path} is not a folder (a link or a file stands there), so sandbox.run will not use it; remove it and try again`,
    );
}

/**
 * The folder the command runs in: the primary folder when the call names
 * none, a relative one resolved there. Checked on the resolved path, through
 * every link, against the chat's folders, and refused unless it is an
 * existing folder: nothing is spawned in a dead cwd.
 */
export function cwdFor(folder: ChatFolder, requested: string | undefined): string {
  const { primary, managed, attachments } = foldersOf(folder);
  const wanted = requested === undefined ? primary : resolve(primary, requested);
  let real: string;
  try {
    real = realpathSync.native(wanted);
  } catch {
    throw new TaviError(
      requested === undefined ? "UNAVAILABLE" : "INVALID_INPUT",
      requested === undefined
        ? `This chat's working folder ${wanted} does not exist, so sandbox.run cannot run there; run ${CHAT_FOLDER_RESET_COMMAND}`
        : `sandbox.run's cwd ${wanted} does not exist`,
    );
  }
  const roots = [primary, managed, ...attachments.map((attachment) => attachment.path)];
  if (!roots.some((root) => within(real, root))) {
    throw new TaviError(
      "INVALID_INPUT",
      `sandbox.run's cwd must be in the chat's working folder or an attached folder: ${[...new Set(roots)].join(", ")}`,
      { details: { cwd: real, folders: [...new Set(roots)] } },
    );
  }
  if (!statSync(real).isDirectory()) throw new TaviError("INVALID_INPUT", `sandbox.run's cwd ${real} is not a folder`);
  return real;
}

/**
 * Whether the shell reaches a host folder: a primary or an attached
 * folder outside the data directory's chat folders. Read from the turn's
 * folder, never from model input.
 */
export function reachesHostFolder(base: SandboxBase, folder: ChatFolder): boolean {
  return hostFoldersOf(base, folder).length > 0;
}

/** The host folders the shell reaches: a primary or an attached folder outside the data directory's chat folders. */
export function hostFoldersOf(base: SandboxBase, folder: ChatFolder): readonly string[] {
  const chats = canonical(join(base.dataDirectory, "chats"));
  const { primary, attachments } = foldersOf(folder);
  return [primary, ...attachments.map((attachment) => attachment.path)].filter((path) => !within(path, chats));
}

/**
 * Whether a managed folder the chat reaches — its own, a side chat's
 * parent's — has anything in `downloads/`, where approved browser downloads
 * are copied. Read from the turn's folder, never from model input.
 */
export function holdsDownloads(dataDirectory: string, folder: Pick<ChatFolder, "managed" | "attachments">): boolean {
  const chats = canonical(join(dataDirectory, "chats"));
  const managedFolders = [
    folder.managed,
    ...folder.attachments.map((attachment) => attachment.path).filter((path) => within(canonical(path), chats)),
  ];
  return managedFolders.some((path) => {
    try {
      return readdirSync(join(path, "downloads")).length > 0;
    } catch (error) {
      // No `downloads/` (or no folder) holds nothing; one that cannot be listed may hold anything: untrusted.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return code !== "ENOENT" && code !== "ENOTDIR";
    }
  });
}

/** The call's folder, or the refusal naming why there is none. */
export function folderOf(context: InvocationContext): ChatFolder {
  if (context.folder === undefined) throw new TaviError("UNAVAILABLE", context.folderUnavailable ?? NO_FOLDER_MESSAGE);
  return context.folder;
}

/**
 * Project files the host runs on purpose, which the shell may write (a
 * build or test changes them as part of its work): `package.json`'s scripts
 * and hooks, a `Makefile`, the commit-hook tools' config, and the
 * instructions other agents read. A run that changes one says so, for the
 * person to look at before they run anything there.
 */
const SENSITIVE_FILES = [
  "package.json",
  "Makefile",
  "makefile",
  "GNUmakefile",
  ".lintstagedrc",
  ".lintstagedrc.json",
  ".lintstagedrc.yaml",
  ".lintstagedrc.yml",
  ".lintstagedrc.js",
  ".lintstagedrc.cjs",
  ".lintstagedrc.mjs",
  "lint-staged.config.js",
  "lint-staged.config.cjs",
  "lint-staged.config.mjs",
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.yaml",
  ".commitlintrc.yml",
  ".commitlintrc.js",
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
] as const;

/** Each sensitive file of the host folders, by path, as it stands: what `changedSensitiveFiles` compares. */
export function sensitiveFilesNow(roots: readonly string[]): ReadonlyMap<string, string> {
  const seen = new Map<string, string>();
  // One file a case-insensitive filesystem finds by two names (`Makefile`, `makefile`) is kept once.
  const inodes = new Set<string>();
  for (const root of roots)
    for (const name of SENSITIVE_FILES) {
      const path = join(root, name);
      try {
        const info = statSync(path);
        const inode = `${String(info.dev)}:${String(info.ino)}`;
        if (!info.isFile() || inodes.has(inode)) continue;
        inodes.add(inode);
        // `ctime` too: a rewrite that puts the old size and modification time back (`touch -r`) still moves it.
        seen.set(path, `${String(info.size)}:${String(info.mtimeMs)}:${String(info.ctimeMs)}:${String(info.ino)}`);
      } catch {
        // Not there.
      }
    }
  return seen;
}

/** The sensitive files a run made, changed or removed, by path. */
export function changedSensitiveFiles(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
}
