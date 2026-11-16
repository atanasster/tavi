import { closeSync, fstatSync, lstatSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";

import { z } from "zod";

import {
  CHAT_FOLDER_RESET_COMMAND,
  FOLDER_FILE_NAME_VARIANTS,
  HOST_PROTECTED_NAMES,
  PROJECT_PROTECTED_NAMES,
  TOOL_LABEL_KEY,
  TOOL_UNTRUSTED_KEY,
  TaviError,
  folderFileName,
  folderFileNameVariant,
  fsFold,
  globMatches,
  isUntrusted,
  joinLabels,
  trustedLabel,
  untrustedLabel,
  type CallAssessment,
  type ChatFolder,
  type ChatFolderAttachment,
  type ChatFolderTaint,
  type ContentLabel,
  type HostFileIdentity,
  type InvocationContext,
} from "@tavi/contracts";
import { clip, errorMessage, textPageEnd } from "@tavi/contracts/util";
import { openNoFollow, openNoFollowSync, sameIdentity, sha256Hex, windowsPathRefusal, type FileIdentity } from "@tavi/node-kit";
import { credentialFiles, credentialHomes, persistenceLocations, windowsProtectedPlaces, type ToolRegistry } from "@tavi/runtime";

/**
 * Workspace file tools, confined per call to the invoking chat's working
 * folder: they read its primary folder, its managed
 * folder and every attached folder, and write the primary, the managed folder
 * and read-write attachments. The folder is the one the workflow stamped on
 * the turn's context (`InvocationContext.folder`), never model input; a turn
 * whose folder could not be resolved is refused with the reason, which names
 * `/folder reset` — there is no owner-wide fallback. They are
 * always registered: without `--fs-root` a chat works in its
 * managed folder.
 *
 * A path is resolved against the primary folder when relative, then through
 * every symlink (`realpath`), and must still lie in a folder of the chat: a
 * link cannot lead out. Credential homes, the files that hold keys and tokens
 * (`credentialFiles`: shell profiles and histories, git's and gh's tokens) and
 * the tavi data directory are refused outright, whatever a rule says — except
 * the chat's own managed folder and, for a side chat, its parent's, read-only.
 * `fs.read`, `fs.list`, `fs.glob` and `fs.grep` are read-only; `fs.write` and
 * `fs.edit` are mutating, and their round shows the diff.
 *
 * Paths are resolved with the native `realpath`, which on a case-insensitive
 * filesystem (macOS, Windows) returns the on-disk spelling: the JavaScript one
 * keeps the case as typed, so `.SSH/id_rsa` would not have been under `~/.ssh`.
 * A protected path is also compared case-folded on those platforms, for a tail
 * that does not exist yet and so has no on-disk spelling to resolve to.
 */

/**
 * A read's per-call label: what a host folder
 * holds is the person's, so a read there is `personal`; the chat's own
 * managed folder is not (`TOOL_LABEL_KEY`, which can only raise).
 */
function hostFolderLabel(
  scope: { readonly inManagedFolder: (absolute: string) => boolean },
  absolute: string,
): { readonly [TOOL_LABEL_KEY]?: { readonly confidentiality: "personal" } } {
  return scope.inManagedFolder(absolute) ? {} : { [TOOL_LABEL_KEY]: { confidentiality: "personal" } };
}

/**
 * A read's label: `hostFolderLabel` of the
 * read's folder, and — when what it returns came from a tainted chat's
 * managed folder (`ChatFolder.taintedFolders`) — untrusted `sandbox`, naming
 * that chat. So a side chat or a worker reading what a tainted chat wrote is
 * tainted too, as is any chat reading a host-folder file that still holds
 * what a tainted chat wrote there (`written`, `FsToolOptions.hostWrites`). A file in `downloads/` is labelled by `TOOL_UNTRUSTED_KEY`
 * already (`download`), so it is left out here.
 */
function readLabel(
  scope: Confinement,
  absolute: string,
  returned: readonly string[],
  written: readonly { readonly taskId?: string }[] = [],
): {
  readonly [TOOL_LABEL_KEY]?: {
    readonly confidentiality?: "personal";
    readonly untrusted?: true;
    readonly source?: "sandbox";
    readonly refs?: readonly string[];
  };
} {
  const chats = [
    ...new Set([
      ...returned.filter((path) => !scope.inDownloads(path)).flatMap((path) => scope.taintedChatOf(path) ?? []),
      ...written.flatMap((write) => write.taskId ?? []),
    ]),
  ];
  if (chats.length === 0 && written.length === 0) return hostFolderLabel(scope, absolute);
  return {
    [TOOL_LABEL_KEY]: {
      ...hostFolderLabel(scope, absolute)[TOOL_LABEL_KEY],
      untrusted: true,
      source: "sandbox",
      refs: chats.slice(0, 16).map((taskId) => `chat:${taskId}`),
    },
  };
}

/** Whether a write by a call in this context is tainted. */
function taintedWrite(context: InvocationContext, contextLabel: ContentLabel | undefined): boolean {
  return context.folder?.tainted === true || (contextLabel !== undefined && isUntrusted(contextLabel));
}

/** Whether a write by a call in this context, to this path, is a tainted write into the chat's managed folder. */
function taintedManagedWrite(
  scope: Confinement,
  absolute: string,
  context: InvocationContext,
  contextLabel: ContentLabel | undefined,
): boolean {
  return scope.inManagedFolder(absolute) && taintedWrite(context, contextLabel);
}

/**
 * A host-folder write's mark: a tainted call's
 * bytes, or bytes derived from marked ones — the file held bytes a tainted
 * chat wrote, `before` — credited to that chat. Recorded before the write (a
 * failure refuses it); the answer records it again with the file's identity
 * once written. The mark ends only when the file holds bytes no write
 * recorded: the person edited it outside Tavi.
 */
async function hostWriteMark(
  options: Pick<FsToolOptions, "hostWrites">,
  scope: Confinement,
  context: InvocationContext,
  contextLabel: ContentLabel | undefined,
  absolute: string,
  before: string | undefined,
  sha256: string,
): Promise<() => Promise<void>> {
  const hostWrites = options.hostWrites;
  const unmarked = async (): Promise<void> => undefined;
  if (hostWrites === undefined || scope.inManagedFolder(absolute)) return unmarked;
  const tainted = taintedWrite(context, contextLabel);
  const from =
    tainted || before === undefined ? undefined : await hostWrites.writerOf(context.workspaceId, absolute, before, hostIdentity(absolute));
  if (!tainted && from === undefined) return unmarked;
  await hostWrites.record(context, absolute, sha256, from, hostIdentity(absolute));
  return async () => await hostWrites.record(context, absolute, sha256, from, hostIdentity(absolute));
}

/** A file's identity (device and inode), so a mark follows it under another name; undefined when it does not exist. */
function hostIdentity(absolute: string): HostFileIdentity | undefined {
  const info = statSync(absolute, { bigint: true, throwIfNoEntry: false });
  return info === undefined ? undefined : { dev: String(info.dev), ino: String(info.ino) };
}

/** No mark is checked on a file larger than this: no write a mark records is near it. */
const MAX_MARKED_BYTES = 64 * 1024 * 1024;

/** The SHA-256 of a file's bytes now; undefined when it is gone or not a plain file within `MAX_MARKED_BYTES`. */
async function fileSha256(absolute: string): Promise<string | undefined> {
  const info = await stat(absolute).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
    throw error;
  });
  if (info === undefined || !info.isFile() || info.size > MAX_MARKED_BYTES) return undefined;
  return sha256Hex(await readFile(absolute));
}

/**
 * The marks of `marks` whose file still holds the marked bytes:
 * what a shell call that reaches them can read.
 */
export async function currentHostMarks<T extends { readonly path: string; readonly sha256: string }>(
  marks: readonly T[],
): Promise<readonly T[]> {
  const now = new Map<string, string | undefined>();
  const held: T[] = [];
  for (const mark of marks) {
    if (!now.has(mark.path)) now.set(mark.path, await fileSha256(mark.path));
    if (now.get(mark.path) === mark.sha256) held.push(mark);
  }
  return held;
}

/** Why a hard-linked file in a managed folder is refused, read or written */
const HARD_LINKED = "has other hard links; a file in a chat's own folder is read or written only when it has one name";

/** A file larger than this is refused rather than read into a tool result. */
const MAX_READ_BYTES = 256 * 1024;
/** A read returns at most this much text; `offset` pages through the rest. */
const MAX_TEXT_CHARS = 48 * 1024;
/** And at most this many bytes of UTF-8: under the 64 KiB a result is archived past, whatever the script. */
const MAX_TEXT_BYTES = 40_000;
/** The largest file `fs.read` pages through: a log or a data file, read a window at a time. */
const MAX_PAGED_READ_BYTES = 16 * 1024 * 1024;
/** The largest file `fs.grep` searches: a long log, not a database. */
const MAX_GREP_FILE_BYTES = 4 * 1024 * 1024;
/** The most lines a line-addressed read returns when `lineCount` is not given. */
const DEFAULT_LINE_COUNT = 400;
/** Directory walks stop here, and say so. */
const MAX_ENTRIES = 2_000;
/** A walk visits at most this many directories: a tree of empty directories has no files to count. */
const MAX_DIRECTORIES = 2_000;
const MAX_MATCHES = 200;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".tavi"]);
/** A walk (and the grep over it) stops after this long, and says it is truncated. */
const SEARCH_BUDGET_MS = 5_000;
/** Each line is searched up to here: minified files are one very long line. */
const MAX_GREP_LINE_CHARS = 2_000;
/** The approval shows at most this much of a diff (`ApprovalDisplaySchema.detail`). */
const MAX_DIFF_CHARS = 2_000;
/** Titles and reasons are cut here (`GateVerdictSchema`), so a long path cannot fail the checkpoint. */
const MAX_LABEL_CHARS = 300;
/** The longest rule subject a verdict records (`GateVerdictSchema`): a write's target is one, whole. */
const MAX_SUBJECT_CHARS = 4_000;

/** Case-insensitive filesystems by default; a protected path is compared case-folded there. */
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";

/**
 * Why a grep pattern is refused before it runs, or `undefined`.
 *
 * - A quantified group that holds a quantifier or an alternation at any depth
 *   — `(a+)+`, `((a)+)+`, `(?:(?:a)+)+`, `(a|aa)*`, `(a+){2}` — is what
 *   backtracks exponentially.
 * - A backreference (`\1`, `\k<name>`) makes matching NP-hard in general.
 *
 * Escapes and character classes are skipped so `\(` or `[+]` do not count.
 * This is only the cheap first refusal: polynomial blow-ups such as `.*.*.*x`
 * pass it, so the search itself runs in a worker that is terminated at the
 * deadline (`grepInWorker`).
 */
export function unsafePatternReason(pattern: string): string | undefined {
  /** Per open group: whether it holds a quantifier or alternation anywhere inside. */
  const open: boolean[] = [];
  /** The group that just closed, if the previous token was `)`: whether it held one. */
  let closed: boolean | undefined;
  const quantifierAt = (index: number): number => {
    const char = pattern[index];
    if (char === "*" || char === "+" || char === "?") return 1;
    if (char === "{") {
      const brace = /^\{\d+(,\d*)?\}/.exec(pattern.slice(index));
      return brace === null ? 0 : brace[0].length;
    }
    return 0;
  };
  for (let index = 0; index < pattern.length; ) {
    const char = pattern[index]!;
    const length = quantifierAt(index);
    if (length > 0) {
      if (closed === true) return "a pattern with a repeated group that itself repeats (like (a+)+) is refused; simplify it";
      if (open.length > 0) open[open.length - 1] = true;
      closed = undefined;
      index += length;
      // A lazy or possessive-looking suffix (`+?`) modifies the quantifier; it is not another.
      if (pattern[index] === "?") index += 1;
      continue;
    }
    closed = undefined;
    if (char === "\\") {
      const next = pattern[index + 1] ?? "";
      if (/[1-9]/.test(next) || (next === "k" && pattern[index + 2] === "<"))
        return "a pattern with a backreference (like \\1) is refused; rewrite it without one";
      index += 2;
    } else if (char === "[") {
      // Skip the class: `]` right after `[` or `[^` is literal only in other dialects; in JavaScript it closes.
      index += 1;
      while (index < pattern.length && pattern[index] !== "]") index += pattern[index] === "\\" ? 2 : 1;
      index += 1;
    } else if (char === "(") {
      open.push(false);
      index += 1;
      // `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>`: the `?` opens a group kind, it quantifies nothing.
      if (pattern[index] === "?") {
        index += 1;
        if (pattern[index] === "<" && pattern[index + 1] !== "=" && pattern[index + 1] !== "!") {
          while (index < pattern.length && pattern[index] !== ">") index += 1;
        }
        index += 1;
      }
    } else if (char === ")") {
      const inner = open.pop() ?? false;
      if (inner && open.length > 0) open[open.length - 1] = true;
      closed = inner;
      index += 1;
    } else {
      if (char === "|" && open.length > 0) open[open.length - 1] = true;
      index += 1;
    }
  }
  return undefined;
}

export interface FsToolOptions {
  /**
   * The tavi data directory: never read or written by a tool, except
   * the invoking chat's own managed folder in its `chats/` and, for a side
   * chat, its parent's, read-only.
   */
  readonly dataDirectory?: string;
  /** Further directories no tool reads or writes, besides the credential homes and the data directory. */
  readonly protectedPaths?: readonly string[];
  /** The owner's `$HOME` (default the process's): where the credential homes and the user persistence locations are. */
  readonly homeDirectory?: string;
  /**
   * Directories a tool may read but never write: a `tavi serve --dev-plugin`
   * folder, whose code the owner runs on save — wherever it appears,
   * also inside a host primary or a read-write attachment.
   */
  readonly readOnlyPaths?: readonly string[];
  /** How long a walk or grep may run (default five seconds); tests shorten it. */
  readonly searchBudgetMs?: number;
  /**
   * The free-space floor and the folders' budget: a write on
   * the data directory's volume under the floor, or into a managed folder
   * past its budget once its `.tmp/` is emptied, is refused at dispatch.
   */
  readonly space?: { admitWrite(folder: ChatFolder, target: string, taskId?: string): Promise<void> };
  /**
   * Record the calling task's chat — a worker's root chat — as tainted:
   * called before a tainted call
   * writes into the chat's managed folder, so what it wrote taints whoever
   * reads it later, though the turn was admitted clean. A failure refuses the
   * write.
   */
  readonly markFolderTainted?: (context: InvocationContext) => Promise<void>;
  /**
   * Host-folder files a tainted call wrote: `record`
   * runs before such a write (a failure refuses it), and again with the file's
   * identity once written; a write of a file that holds marked bytes is
   * recorded too, credited as `from`. A read of a host file that still holds
   * marked bytes — by its path, or the same file under another name — is
   * untrusted, naming the chat (`writerOf`).
   */
  readonly hostWrites?: {
    record(
      context: InvocationContext,
      path: string,
      sha256: string,
      from?: { readonly taskId?: string },
      file?: HostFileIdentity,
    ): Promise<void>;
    writerOf(workspaceId: string, path: string, sha256: string, file?: HostFileIdentity): Promise<{ readonly taskId?: string } | undefined>;
  };
  /**
   * The managed folders this call's chat reaches that are recorded tainted
   * now (`ChatFolders.taintedFoldersNow`): a read joins them to the folder's
   * `taintedFolders`, so a taint recorded mid-turn is seen.
   */
  readonly taintedFoldersNow?: (context: InvocationContext) => Promise<readonly ChatFolderTaint[]>;
}

const PathSchema = z.string().min(1).max(4_096);

const ReadSchema = z.strictObject({
  path: PathSchema.describe("A file: relative to your working folder, or absolute in it or in an attached folder"),
  offset: z.number().int().min(0).optional().describe("Character offset to start from, to page through a long file: a result's nextOffset"),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The first line to read, counting from 1 (an fs.grep match's line); instead of offset"),
  lineCount: z
    .number()
    .int()
    .min(1)
    .max(5_000)
    .optional()
    .describe(`How many lines to read from startLine, ${DEFAULT_LINE_COUNT} when omitted`),
});
const ListSchema = z.strictObject({ path: PathSchema.optional().describe("A directory (default: your working folder)") });
const GlobSchema = z.strictObject({
  pattern: z
    .string()
    .min(1)
    .max(512)
    .describe("A glob over paths relative to the searched directory: * and ? match any characters (including /)"),
  path: PathSchema.optional().describe("The directory to search (default: your working folder)"),
});
const GrepSchema = z.strictObject({
  pattern: z.string().min(1).max(512).describe("A regular expression to search file contents for"),
  path: PathSchema.optional().describe("The directory to search (default: your working folder)"),
  glob: z.string().min(1).max(512).optional().describe("Only files whose relative path matches this glob"),
  ignoreCase: z.boolean().optional().describe("Match regardless of case"),
  context: z.number().int().min(0).max(3).optional().describe("Lines of context to show before and after each match (0–3)"),
  filesOnly: z.boolean().optional().describe("List only the files that match, with how many matches each, not the lines"),
});
const WriteSchema = z.strictObject({
  path: PathSchema.describe(
    "The file to create or replace: relative to your working folder, or absolute in it or in an attached folder you may write",
  ),
  content: z.string().max(MAX_READ_BYTES).describe("The whole new content"),
});
const OneEditSchema = z.strictObject({
  oldText: z.string().min(1).max(MAX_READ_BYTES).describe("Exact text to replace; must occur once unless replaceAll"),
  newText: z.string().max(MAX_READ_BYTES).describe("The replacement"),
  replaceAll: z.boolean().optional().describe("Replace every occurrence (default: exactly one must exist)"),
});
const EditSchema = z.strictObject({
  path: PathSchema.describe("The file to edit: relative to your working folder, or absolute in it or in an attached folder you may write"),
  oldText: z.string().min(1).max(MAX_READ_BYTES).optional().describe("Exact text to replace; must occur once unless replaceAll"),
  newText: z.string().max(MAX_READ_BYTES).optional().describe("The replacement"),
  replaceAll: z.boolean().optional().describe("Replace every occurrence (default: exactly one must exist)"),
  edits: z
    .array(OneEditSchema)
    .min(1)
    .max(50)
    .optional()
    .describe("Several replacements in one file, applied in order as one change with one approval; instead of oldText/newText"),
});

/** The replacements an `fs.edit` input asks for, in order: its `edits`, or its one `oldText`/`newText`. */
function editsOf(input: z.infer<typeof EditSchema>): readonly z.infer<typeof OneEditSchema>[] {
  if (input.edits !== undefined) {
    if (input.oldText !== undefined || input.newText !== undefined)
      throw new TaviError("INVALID_INPUT", "fs.edit takes `edits` or `oldText`/`newText`, not both");
    return input.edits;
  }
  if (input.oldText === undefined || input.newText === undefined)
    throw new TaviError("INVALID_INPUT", "fs.edit needs `oldText` and `newText`, or `edits`");
  return [{ oldText: input.oldText, newText: input.newText, ...(input.replaceAll === undefined ? {} : { replaceAll: input.replaceAll }) }];
}

/** The refusal for a call with no folder and no recorded reason: one made outside a chat's turn. */
const NO_FOLDER_MESSAGE = `This call has no working folder, so the file tools cannot run: they work only in a chat's turn, in that chat's folder. If this is a chat, run ${CHAT_FOLDER_RESET_COMMAND}.`;

export const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
/** `within`, case-folded where the filesystem is: used for refusals, where matching too much is the safe side. */
export const withinFolded = (path: string, root: string): boolean => (FOLD_CASE ? within(fsFold(path), fsFold(root)) : within(path, root));

/**
 * The on-disk spelling of a path (native realpath); for one that does not
 * exist yet, its nearest existing ancestor's spelling with the rest appended —
 * so a protected directory not yet created under `/var` still covers the
 * `/private/var` spelling a target resolves to.
 */
export function canonical(path: string): string {
  const missing: string[] = [];
  for (let existing = path; ; ) {
    try {
      return join(realpathSync.native(existing), ...missing);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      missing.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
  }
}

/** Why a resolved path is off limits, or `undefined`. */
type ProtectedReason = (absolute: string) => string | undefined;

/** What never changes between calls: the protected paths, each as named and as resolved. */
interface Protection {
  readonly credentials: readonly string[];
  /** What the owner's login, shell, git or desktop runs from `$HOME` (`persistenceLocations`): read, never written. */
  readonly persistence: readonly string[];
  readonly data: readonly string[];
  /** `<data-dir>/chats`: where managed folders live. */
  readonly chats: readonly string[];
  readonly readOnly: readonly string[];
}

function protection(options: FsToolOptions): Protection {
  // As named and as resolved: a resolved target must not slip past a
  // protected path spelled through a symlink.
  const spellings = (path: string): string[] => {
    const real = canonical(path);
    return real === path ? [path] : [path, real];
  };
  const dataDirectory = options.dataDirectory === undefined ? undefined : resolve(options.dataDirectory);
  return {
    credentials: [
      ...credentialHomes(options.homeDirectory),
      ...credentialFiles(options.homeDirectory),
      ...windowsProtectedPlaces(options.homeDirectory).credentials,
    ].flatMap(spellings),
    persistence: [...persistenceLocations(options.homeDirectory), ...windowsProtectedPlaces(options.homeDirectory).persistence].flatMap(
      spellings,
    ),
    data: [...(options.protectedPaths ?? []).map((path) => resolve(path)), ...(dataDirectory === undefined ? [] : [dataDirectory])].flatMap(
      spellings,
    ),
    chats: dataDirectory === undefined ? [] : spellings(join(dataDirectory, "chats")),
    readOnly: (options.readOnlyPaths ?? []).map((path) => resolve(path)).flatMap(spellings),
  };
}

/**
 * How one call sees its chat's folder: the read and write roots, the
 * protected paths with the chat's own carve-outs, and how a path is shown and
 * matched. Built per call from the context, by the handlers and the gate's
 * assessors alike, so both read a path the same way.
 */
interface Confinement {
  readonly primary: string;
  readonly managed: string;
  /** Why the managed folder could not be created: a path in it is refused with this. */
  readonly managedUnavailable: string | undefined;
  /** `[primary, managed, ...attachments]`, as the filesystem spells them. */
  readonly readRoots: readonly string[];
  /** `[primary, managed, ...read-write attachments]`. */
  readonly writeRoots: readonly string[];
  readonly attachments: readonly ChatFolderAttachment[];
  /**
   * A side chat: the workflow stamped its parent on the turn, or
   * its parent's managed folder is attached, so it reaches more than one
   * managed folder. Its rules for host files would also apply in its parent,
   * which shares them.
   */
  readonly sideChat: boolean;
  readonly protectedReason: ProtectedReason;
  /** Why a write may not land at a path a read may: a dev plugin's folder, a user persistence location. */
  readonly writeProtectedReason: ProtectedReason;
  /** Whether a path lies in a chat's managed folder, where a hard-linked file is refused; anywhere else is a host folder. */
  readonly inManagedFolder: (absolute: string) => boolean;
  /**
   * Whether a path lies in a managed folder's `downloads/`, where approved
   * browser downloads are copied: what a web page supplied, so a read of
   * it is untrusted.
   */
  readonly inDownloads: (absolute: string) => boolean;
  /** The chat whose tainted managed folder a path lies in (`ChatFolder.taintedFolders`), if it does. */
  readonly taintedChatOf: (absolute: string) => string | undefined;
  /** The read-write attachment a path lies in, unless it is also in the primary or managed folder. */
  readonly rwAttachmentOf: (absolute: string) => ChatFolderAttachment | undefined;
  /**
   * A path as results, titles and diffs show it: relative to the primary
   * folder, `<label>/<rel>` in an attachment, else absolute.
   */
  readonly shown: (absolute: string) => string;
  /**
   * A path as rules match it: `chat:<task-id>/<rel>` in
   * a managed folder — the task id as its folder is named — and the absolute
   * real path in a host folder, so a rule saved for one chat's `notes.md`
   * never allows another chat's.
   */
  readonly subject: (absolute: string) => string;
}

/** The deepest of `roots` that holds `path`. */
function deepest<T>(entries: readonly T[], pathOf: (entry: T) => string, path: string): T | undefined {
  let best: T | undefined;
  for (const entry of entries)
    if (within(path, pathOf(entry)) && (best === undefined || pathOf(entry).length > pathOf(best).length)) best = entry;
  return best;
}

/**
 * The call's confinement, from the folder stamped on its context. A context
 * with none is refused with the reason the workflow recorded —
 * never answered with roots the chat was not given.
 */
function confinementFor(
  shared: Protection,
  context: Pick<InvocationContext, "folder" | "folderUnavailable" | "parentChatId">,
): Confinement {
  const folder = context.folder;
  if (folder === undefined) throw new TaviError("UNAVAILABLE", context.folderUnavailable ?? NO_FOLDER_MESSAGE);
  // The resolver realpaths every entry; spelled again here so a check never compares two spellings of one folder.
  const primary = canonical(folder.primary);
  const managed = canonical(folder.managed);
  const attachments = folder.attachments.map((attachment) => ({ ...attachment, path: canonical(attachment.path) }));
  const readRoots = [...new Set([primary, managed, ...attachments.map((attachment) => attachment.path)])];
  const writeRoots = [
    ...new Set([primary, managed, ...attachments.filter((attachment) => attachment.mode === "rw").map((attachment) => attachment.path)]),
  ];
  // The managed folders this call reaches: its own, and a side chat's parent's (an attachment the resolver put under `chats/`).
  const managedFolders = [
    managed,
    ...attachments
      .filter((attachment) => shared.chats.some((chats) => within(attachment.path, chats)))
      .map((attachment) => attachment.path),
  ];
  const protectedReason: ProtectedReason = (absolute) => {
    if (shared.credentials.some((path) => withinFolded(absolute, path)))
      return "credential directories and files that hold keys or tokens are never read or written by a tool";
    // The chat's own managed folders are the one carve-out, compared exactly: on the resolved path.
    if (shared.data.some((path) => withinFolded(absolute, path)) && !managedFolders.some((folderPath) => within(absolute, folderPath)))
      return "the tavi data directory is never read or written by a tool";
    return undefined;
  };
  const writeProtectedReason: ProtectedReason = (absolute) => {
    if (shared.readOnly.some((path) => withinFolded(absolute, path)))
      return "this folder is a dev plugin's: the owner runs its code, unsandboxed, on every save, so no tool writes it";
    if (shared.persistence.some((path) => withinFolded(absolute, path)))
      return "this path is a protected user startup or persistence location: the owner's login, shell, git or desktop runs what it holds, so no tool writes it";
    // A read of `downloads/` is what a web page supplied: a file a model wrote there would read as one.
    if (inDownloads(absolute)) return "downloads/ holds only what the browser downloaded: write the file elsewhere in your folder";
    // As `sandbox.run` is held: a `.git` in a host folder — a gitfile or a repository's own — is git's to write, on the host.
    const root = inManagedFolder(absolute) ? undefined : writeRoots.find((path) => within(absolute, path));
    if (
      root !== undefined &&
      relative(root, absolute)
        .split(sep)
        .some((part) => fsFold(part) === ".git")
    )
      return "a .git in a host folder is never written by a tool: git on the host runs the hooks and config found there";
    // Nor a repository's hooks and config in the managed folder: git runs them there too, a read-only `git status` included.
    if (inManagedFolder(absolute) && GIT_INTERNALS.test(fsFold(absolute.split(sep).join("/"))))
      return "a repository's hooks and config are git's to write, never a tool's: git runs what they name";
    return undefined;
  };
  const inManagedFolder = (absolute: string): boolean => [...shared.chats, ...managedFolders].some((path) => within(absolute, path));
  const inDownloads = (absolute: string): boolean => managedFolders.some((path) => within(absolute, join(path, "downloads")));
  const taintedFolders = (folder.taintedFolders ?? []).map((taint) => ({ path: canonical(taint.path), taskId: taint.taskId }));
  const taintedChatOf = (absolute: string): string | undefined => deepest(taintedFolders, (taint) => taint.path, absolute)?.taskId;
  const rwAttachmentOf = (absolute: string): ChatFolderAttachment | undefined => {
    if (within(absolute, primary) || within(absolute, managed)) return undefined;
    const attachment = deepest(attachments, (entry) => entry.path, absolute);
    return attachment?.mode === "rw" ? attachment : undefined;
  };
  const shown = (absolute: string): string => {
    if (within(absolute, primary)) return relative(primary, absolute) || ".";
    const attachment = deepest(attachments, (entry) => entry.path, absolute);
    if (attachment === undefined) return absolute;
    const rest = relative(attachment.path, absolute);
    return rest === "" ? attachment.label : `${attachment.label}/${rest}`;
  };
  const subject = (absolute: string): string => {
    const owner = deepest(managedFolders, (path) => path, absolute);
    if (owner === undefined) return absolute;
    const rest = relative(owner, absolute).split(sep).join("/");
    return `chat:${basename(owner)}${rest === "" ? "" : `/${rest}`}`;
  };
  return {
    // The workflow stamps a side chat's parent on every turn: a side chat whose parent's folder could not be attached is one still.
    primary,
    managed,
    managedUnavailable: folder.managedUnavailable,
    readRoots,
    writeRoots,
    attachments,
    sideChat: managedFolders.length > 1 || context.parentChatId !== undefined,
    protectedReason,
    writeProtectedReason,
    inManagedFolder,
    inDownloads,
    taintedChatOf,
    rwAttachmentOf,
    shown,
    subject,
  };
}

/**
 * A path resolved as the file tools resolve one: against the
 * invoking chat's primary folder when relative, through every link, and still
 * in one of the chat's folders — else refused. For another tool that reads
 * the chat's folder (`plugins.validate`).
 */
export function fsRootResolver(options: FsToolOptions): (path: string, context: InvocationContext) => string {
  const shared = protection(options);
  return (path, context) => {
    const real = resolveConfined(path, confinementFor(shared, context), "read");
    if (typeof real !== "string") throw new TaviError(real.code, real.message);
    return real;
  };
}

/**
 * What `fs.read` refuses of a file another reader of the chat's folders reads
 * by its real path (`plugins.validate`): one outside the chat's folders
 * or under a protected path, and a hard-linked one in a managed folder.
 * The answer is why, or `undefined`.
 */
export function folderFileCheck(
  options: FsToolOptions,
): (context: InvocationContext) => (real: string, opened: { readonly nlink: number }) => string | undefined {
  const shared = protection(options);
  return (context) => {
    const scope = confinementFor(shared, context);
    return (real, opened) => {
      const confined = resolveConfined(real, scope, "read");
      if (typeof confined !== "string") return `is refused: ${confined.message}`;
      return opened.nlink > 1 && scope.inManagedFolder(confined) ? HARD_LINKED : undefined;
    };
  };
}

/** A chat's folder as `fs.read` and `fs.list` reach it, for another reader of it: the `folder` command's `files` and `read`. */
export interface FolderReadScope {
  /** An absolute path resolved and confined as `fs.read` resolves one; a refusal is thrown. */
  readonly resolve: (path: string) => string;
  /** Whether a listed entry is left out, as `fs.list` leaves out a protected path. */
  readonly hidden: (absolute: string) => boolean;
  /** Whether a path lies in a managed folder, where a hard-linked file is refused. */
  readonly inManagedFolder: (absolute: string) => boolean;
}

/**
 * The file tools' confinement for a resolved folder: the data directory closed but for the chat's own managed
 * folders, the credential homes refused, as the file tools hold them.
 */
export function folderReadScope(options: FsToolOptions): (folder: ChatFolder) => FolderReadScope {
  const shared = protection(options);
  return (folder) => {
    const scope = confinementFor(shared, { folder });
    return {
      resolve: (path) => {
        const real = resolveConfined(path, scope, "read");
        if (typeof real !== "string") throw new TaviError(real.code, real.message);
        return real;
      },
      hidden: (absolute) => scope.protectedReason(absolute) !== undefined,
      inManagedFolder: scope.inManagedFolder,
    };
  };
}

/**
 * The label a folder file is read with, as `fs.read` gives one: a download's, a tainted chat's, a host
 * folder's. The PDF and video tools read their folder files with it.
 */
export function folderFileLabel(
  file: FolderFile,
  taint: { readonly chats: readonly string[] },
  context: InvocationContext,
  at: string,
): ContentLabel {
  const managed =
    context.folder === undefined
      ? undefined
      : (() => {
          try {
            return realpathSync(context.folder.managed);
          } catch {
            return context.folder.managed;
          }
        })();
  const inManaged = managed !== undefined && (file.absolute === managed || file.absolute.startsWith(`${managed}${sep}`));
  const confidentiality = inManaged ? "public" : "personal";
  if (file.downloaded === true) return untrustedLabel("download", { confidentiality });
  if (taint.chats.length > 0)
    return taint.chats
      .slice(0, 16)
      .reduce<ContentLabel>(
        (label, chat) => joinLabels(label, untrustedLabel("sandbox", { confidentiality, ref: { ref: `chat:${chat}`, at } })),
        untrustedLabel("sandbox", { confidentiality }),
      );
  return trustedLabel(confidentiality);
}

/** A file of the chat's folder, read once: its bytes and what an approval card shows of them. */
export interface FolderFile {
  readonly absolute: string;
  /** As results and cards show it: primary-relative, `<label>/<rel>`, or absolute. */
  readonly shown: string;
  /** Its own name, made safe to present elsewhere (`folderFileName`). */
  readonly name: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  /** It lies in a managed folder's `downloads/`: what a web page supplied. */
  readonly downloaded?: true;
  /** It lies in a tainted chat's managed folder: that chat's id. */
  readonly taintedChat?: string;
  /** The file read (device and inode), for its host-folder mark (`folderFileTaint`). */
  readonly identity: HostFileIdentity;
}

/**
 * What a folder file read to be sent out carries beyond its turn's stamped
 * folder taint: a taint recorded since the turn
 * began (`taintedFoldersNow`), and a host file's mark on exactly these bytes
 * (`hostWrites`) — the chats to name, and whether it is marked at all.
 */
export function folderFileTaint(
  options: Pick<FsToolOptions, "taintedFoldersNow" | "hostWrites">,
): (file: FolderFile, context: InvocationContext) => Promise<{ readonly chats: readonly string[]; readonly marked: boolean }> {
  return async (file, context) => {
    const late = ((await options.taintedFoldersNow?.(context)) ?? []).map((taint) => ({
      path: canonical(taint.path),
      taskId: taint.taskId,
    }));
    const folder = deepest(late, (taint) => taint.path, file.absolute)?.taskId;
    const writer = await options.hostWrites?.writerOf(context.workspaceId, file.absolute, file.sha256, file.identity);
    const chats = [...new Set([file.taintedChat, folder, writer?.taskId].flatMap((chat) => chat ?? []))];
    return { chats, marked: chats.length > 0 || writer !== undefined };
  };
}

/**
 * Read a file of the invoking chat's folder, whole and once, under the
 * confinement `fs.read` has: resolved against
 * the primary folder, through every link, still in one of the chat's folders
 * and outside every protected path; opened without following a link at the
 * target, the open file checked to be the resolved one, a hard-linked file
 * in a managed folder refused; at most `maxBytes`. Binary files are read as
 * they are. Synchronous, because the gate's assessor reads it to show its
 * size and hash; the handler reads it again and stores those very bytes.
 */
export function folderFileReader(options: FsToolOptions): (path: string, context: InvocationContext, maxBytes: number) => FolderFile {
  const shared = protection(options);
  return (path, context, maxBytes) => {
    const scope = confinementFor(shared, context);
    const real = resolveConfined(path, scope, "read");
    if (typeof real !== "string") throw new TaviError(real.code, real.message);
    const label = clip(scope.shown(real), MAX_LABEL_CHARS - 80);
    let fd: number;
    try {
      fd = openNoFollowSync(real, "read");
    } catch (error) {
      throw new TaviError(
        errorCode(error) === "ENOENT" ? "NOT_FOUND" : "NOT_AUTHORIZED",
        errorCode(error) === "ENOENT" ? `${label} does not exist` : `${label} cannot be opened: ${errorCode(error) ?? "error"}`,
      );
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) throw new TaviError("INVALID_INPUT", `${label} is not a file`);
      let again: string | undefined;
      try {
        again = realpathSync.native(real);
      } catch {
        again = undefined;
      }
      const confirmed = again === undefined ? undefined : statSync(again, { throwIfNoEntry: false });
      if (
        again === undefined ||
        resolveConfined(again, scope, "read") !== again ||
        confirmed === undefined ||
        !sameIdentity(confirmed, info)
      ) {
        throw new TaviError("NOT_AUTHORIZED", `${label} changed while it was being opened`);
      }
      if (info.nlink > 1 && scope.inManagedFolder(again)) throw new TaviError("NOT_AUTHORIZED", `${label} ${HARD_LINKED}`);
      if (info.size > maxBytes)
        throw new TaviError("INVALID_INPUT", `${label} is ${info.size} bytes, over the ${maxBytes}-byte limit for a file sent out`);
      // Read to the end, once, into a buffer one byte larger than the file: a file that grows meanwhile is refused, not cut.
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      for (;;) {
        if (length === bytes.byteLength)
          throw new TaviError("CONFLICT", `${label} grew while it was being read; try again once it is complete`);
        const read = readSync(fd, bytes, length, bytes.byteLength - length, null);
        if (read === 0) break;
        length += read;
      }
      const body = bytes.subarray(0, length);
      const taintedChat = scope.taintedChatOf(again);
      const identity = fstatSync(fd, { bigint: true });
      return {
        absolute: again,
        shown: scope.shown(again),
        name: folderFileName(basename(again), "file"),
        bytes: body,
        sha256: sha256Hex(body),
        identity: { dev: String(identity.dev), ino: String(identity.ino) },
        ...(scope.inDownloads(again) ? { downloaded: true as const } : {}),
        ...(taintedChat === undefined ? {} : { taintedChat }),
      };
    } finally {
      closeSync(fd);
    }
  };
}

/** Where a new file goes: an explicit path, refused if taken; or a default name in a managed subfolder, the next free variant if taken. */
export type NewFileTarget =
  /** `decided`: the file a gate decided, which the path must still resolve to as it is written. */
  { readonly path: string; readonly decided?: string } | { readonly managedSubfolder: string; readonly name: string };

/**
 * Write bytes to a new file of the invoking chat's folder, never over one:
 * confined as `fs.write` is, with its side
 * effects in its order — the space admission, a tainted chat's managed folder
 * marked, a host write recorded before and after. An explicit path that
 * exists is refused; a default name that is taken gets the next free
 * ` (n)` variant (`folderFileNameVariant`, at most
 * `FOLDER_FILE_NAME_VARIANTS`), each opened `O_EXCL` so two writes never
 * take one name.
 */
export function folderFileWriter(
  options: FsToolOptions,
): (
  target: NewFileTarget,
  bytes: Uint8Array,
  context: InvocationContext,
  contextLabel: ContentLabel | undefined,
) => Promise<{ readonly absolute: string; readonly shown: string }> {
  const shared = protection(options);
  return async (target, bytes, context, contextLabel) => {
    const scope = confinementFor(shared, context);
    const confined = (path: string): string => {
      const absolute = resolveConfined(path, scope, "write");
      if (typeof absolute !== "string") throw new TaviError(absolute.code, absolute.message);
      return absolute;
    };
    // `writeContainedBytes`'s refusal of a name already taken.
    const taken = (error: unknown): boolean =>
      error instanceof TaviError && error.code === "CONFLICT" && error.details?.["reason"] === "exists";
    if ("path" in target) {
      const absolute = confined(target.path);
      // Resolved once here, as it is written: a link swapped since the gate's own resolution cannot move the file.
      if (target.decided !== undefined && absolute !== target.decided)
        throw new TaviError("CONFLICT", `${clip(target.path, 200)} no longer names the file that was approved; nothing was written`);
      // Refused before any side effect: no admission, taint mark or host-write record for bytes never written.
      if ((await lstat(absolute).catch(() => undefined)) !== undefined)
        throw new TaviError("CONFLICT", `${clip(scope.shown(absolute), MAX_LABEL_CHARS - 80)} already exists; nothing was overwritten`, {
          details: { reason: "exists" },
        });
      if (context.folder !== undefined) await options.space?.admitWrite(context.folder, absolute, context.runId);
      if (taintedManagedWrite(scope, absolute, context, contextLabel)) await options.markFolderTainted?.(context);
      const marked = await hostWriteMark(options, scope, context, contextLabel, absolute, undefined, sha256Hex(bytes));
      await writeContainedBytes(absolute, bytes, scope.writeRoots, writableIn(scope), scope.inManagedFolder);
      await marked();
      return { absolute, shown: scope.shown(absolute) };
    }
    const name = folderFileName(target.name, "file");
    const first = confined(join(scope.managed, target.managedSubfolder, name));
    // A managed folder: admitted and marked once, for the folder the variants all share; no host write.
    if (context.folder !== undefined) await options.space?.admitWrite(context.folder, first, context.runId);
    if (taintedManagedWrite(scope, first, context, contextLabel)) await options.markFolderTainted?.(context);
    for (let index = 1; index <= FOLDER_FILE_NAME_VARIANTS; index += 1) {
      const absolute = index === 1 ? first : confined(join(scope.managed, target.managedSubfolder, folderFileNameVariant(name, index)));
      try {
        await writeContainedBytes(absolute, bytes, scope.writeRoots, writableIn(scope), scope.inManagedFolder);
      } catch (error) {
        if (taken(error)) continue;
        throw error;
      }
      return { absolute, shown: scope.shown(absolute) };
    }
    throw new TaviError("CONFLICT", `${target.managedSubfolder}/ already holds ${FOLDER_FILE_NAME_VARIANTS} files named like ${name}`);
  };
}

/**
 * A write's target as the gate decided it: the path
 * is resolved again at dispatch, and one whose rule subject is not among
 * the verdict's — a link swapped in since, leading into another folder — is
 * refused, so a rule, a grant or a person's approval never writes a file it
 * was not about, and a write the gate held in the managed folder never
 * lands in a host folder unasked under taint.
 */
function decidedTarget(scope: Confinement, absolute: string, assessed: readonly string[] | undefined, path: string): void {
  if (assessed === undefined || assessed.includes(scope.subject(absolute))) return;
  throw new TaviError(
    "CONFLICT",
    `${clip(path, MAX_LABEL_CHARS - 120)} now resolves to ${clip(scope.shown(absolute), MAX_LABEL_CHARS - 120)}, not the file this call was decided for; nothing was written. Call again to have it decided as it is now.`,
  );
}

/** Another tool's save of bytes into a new file of the chat's folder (`http.request`'s `saveTo`), held as `fs.write` holds one. */
export interface FolderSaver {
  /**
   * `fs.write`'s assessment of creating `path`: resolved and confined as a
   * write, its folder-qualified subject, `none` in the managed folder and
   * `persist` (asking under taint) in a host folder. A path that exists
   * already is refused — bytes nobody can diff never replace a file.
   */
  readonly assess: (path: string, context: InvocationContext, verb: string) => CallAssessment;
  /** Write the new file (`folderFileWriter`), refused when `path` now resolves to a file the gate did not decide (`assessedSubjects`). */
  readonly save: (
    path: string,
    bytes: Uint8Array,
    context: InvocationContext,
    contextLabel: ContentLabel | undefined,
    assessedSubjects: readonly string[] | undefined,
  ) => Promise<{ readonly absolute: string; readonly shown: string }>;
}

export function folderSaver(options: FsToolOptions): FolderSaver {
  const shared = protection(options);
  const write = folderFileWriter(options);
  return {
    assess: (path, context, verb) => {
      let scope: Confinement;
      try {
        scope = confinementFor(shared, context);
      } catch (error) {
        return refusal(path, verb, errorMessage(error));
      }
      const real = resolveConfined(path, scope, "write");
      if (typeof real === "string" && lstatSync(real, { throwIfNoEntry: false }) !== undefined)
        return refusal(path, verb, `${scope.shown(real)} already exists; nothing is overwritten, so name a new file`);
      return assessChangeSync(scope, path, () => undefined, verb);
    },
    save: async (path, bytes, context, contextLabel, assessedSubjects) => {
      const scope = confinementFor(shared, context);
      const absolute = resolveConfined(path, scope, "write");
      if (typeof absolute !== "string") throw new TaviError(absolute.code, absolute.message);
      decidedTarget(scope, absolute, assessedSubjects, path);
      return await write({ path, decided: absolute }, bytes, context, contextLabel);
    },
  };
}

/** Whether `real` is a path the scope may write, as the resolver reads it. */
function writableIn(scope: Confinement): (real: string) => boolean {
  return (real) => resolveConfined(real, scope, "write") === real;
}

export function registerFsTools(registry: ToolRegistry, options: FsToolOptions): void {
  const shared = protection(options);
  const budgetMs = options.searchBudgetMs ?? SEARCH_BUDGET_MS;
  const scopeOf = (context: InvocationContext): Confinement => confinementFor(shared, context);
  /** A host-folder write's mark (`hostWriteMark`), for text. */
  const markHostWrite = async (
    scope: Confinement,
    context: InvocationContext,
    contextLabel: ContentLabel | undefined,
    absolute: string,
    before: string | undefined,
    next: string,
  ): Promise<() => Promise<void>> => await hostWriteMark(options, scope, context, contextLabel, absolute, before, sha256Hex(next));
  /** A read's confinement, its tainted folders read again now: a taint recorded since the turn began is seen. */
  const readScopeOf = async (context: InvocationContext): Promise<Confinement> => {
    const scope = scopeOf(context);
    const late = ((await options.taintedFoldersNow?.(context)) ?? []).map((taint) => ({
      path: canonical(taint.path),
      taskId: taint.taskId,
    }));
    if (late.length === 0) return scope;
    return {
      ...scope,
      taintedChatOf: (absolute) => scope.taintedChatOf(absolute) ?? deepest(late, (taint) => taint.path, absolute)?.taskId,
    };
  };

  /**
   * How many times each `replaceAll` edit's `oldText` occurred when the gate
   * showed its diff, keyed by the chat and the call's input. The input cannot
   * carry it, so dispatch looks it up and refuses an edit whose count has
   * changed since — the person approved N replacements, not M. Bounded; lost
   * on restart, when dispatch falls back to applying the edit to the file as
   * it then is.
   */
  const assessedCounts = new Map<string, number>();
  const countKey = (context: InvocationContext, input: unknown, edit = 0): string =>
    `${context.runId}\u0000${edit}\u0000${JSON.stringify(input)}`;
  const rememberCount = (key: string, count: number): void => {
    assessedCounts.delete(key);
    assessedCounts.set(key, count);
    const oldest = assessedCounts.keys().next();
    if (assessedCounts.size > 256 && oldest.done !== true) assessedCounts.delete(oldest.value);
  };

  /** Resolve through symlinks and require the result in the chat's folders; for a new file, its nearest existing parent must be. */
  const confine = async (scope: Confinement, path: string, forWrite: boolean): Promise<string> => {
    const real = resolveConfined(path, scope, forWrite ? "write" : "read");
    if (typeof real !== "string") throw new TaviError(real.code, real.message);
    if (!forWrite) {
      try {
        await stat(real);
      } catch {
        throw new TaviError("NOT_FOUND", `${clip(path, MAX_LABEL_CHARS)} does not exist`);
      }
    }
    return real;
  };

  /**
   * Read a confined file. The open does not follow a link at the target
   * (`O_NOFOLLOW`) nor block on a FIFO (`O_NONBLOCK`); the checks run on the
   * open descriptor, and the path is resolved again afterwards and must still
   * be confined and name the same inode — so a directory swapped for a link
   * between `confine` and the open is caught rather than read through. A
   * file with other hard links is refused in a managed folder:
   * a name there must not reach content kept elsewhere. Host
   * folders are not checked, where package stores make such links normal.
   */
  const readText = async (scope: Confinement, absolute: string, maxBytes = MAX_READ_BYTES): Promise<string> => {
    const handle = await openNoFollow(absolute, "read");
    try {
      const info = await handle.stat();
      const label = clip(scope.shown(absolute), MAX_LABEL_CHARS);
      if (!info.isFile()) throw new TaviError("INVALID_INPUT", `${label} is not a file`);
      // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
      const again = await realpath(absolute).catch(() => undefined);
      // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
      const confirmed = again === undefined ? undefined : await stat(again).catch(() => undefined);
      if (
        again === undefined ||
        resolveConfined(again, scope, "read") !== again ||
        confirmed === undefined ||
        !sameIdentity(confirmed, info)
      ) {
        throw new TaviError("NOT_AUTHORIZED", `${label} changed while it was being opened`);
      }
      if (info.nlink > 1 && scope.inManagedFolder(again)) throw new TaviError("NOT_AUTHORIZED", `${label} ${HARD_LINKED}`);
      if (info.size > maxBytes)
        throw new TaviError("INVALID_INPUT", `${label} is ${info.size} bytes, over the ${maxBytes}-byte read limit`);
      const bytes = await handle.readFile();
      if (bytes.byteLength > maxBytes) throw new TaviError("INVALID_INPUT", `${label} grew past the ${maxBytes}-byte read limit`);
      if (bytes.includes(0))
        throw new TaviError(
          "UNSUPPORTED",
          `${label} is binary; only text files are read (a PDF with pdf.read, anything else with sandbox.run)`,
        );
      return bytes.toString("utf8");
    } finally {
      await handle.close();
    }
  };

  /** A write's checks again, on a path already resolved: whether it may be written now. */

  /**
   * Every file under a directory, relative to it, skipping VCS and dependency
   * trees and protected paths. Bounded by files, by directories visited, and
   * by time; cancelled with the call.
   */
  const walk = async (
    scope: Confinement,
    directory: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }> => {
    const files: string[] = [];
    const pending = [directory];
    for (let next = 0; next < pending.length; next += 1) {
      if (signal.aborted) throw new TaviError("CANCELLED", "the file search was cancelled");
      const current = pending[next];
      if (current === undefined || next >= MAX_DIRECTORIES || Date.now() > deadline) return { files, truncated: true };
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (files.length >= MAX_ENTRIES) return { files, truncated: true };
        const path = join(current, entry.name);
        if (scope.protectedReason(path) !== undefined) continue;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
        } else if (entry.isFile()) {
          files.push(relative(directory, path));
        }
      }
    }
    return { files, truncated: false };
  };

  /** A write's assessment in the call's folder; a call with no folder is refused at the gate with its reason. */
  const assessIn = (
    context: InvocationContext,
    path: string,
    verb: string,
    next: (current: string | undefined) => string | undefined,
  ): CallAssessment => {
    let scope: Confinement;
    try {
      scope = scopeOf(context);
    } catch (error) {
      return refusal(path, verb, errorMessage(error));
    }
    return assessChangeSync(scope, path, next, verb);
  };

  registry.register({
    id: "fs.read",
    sink: "none",
    // A read marked untrusted is of the chat's `downloads/`: it names the download.
    outputSource: "download",
    version: "1.0.0",
    description:
      "Read a text file in your working folder or an attached folder, of any size up to 16 MiB. A long file is returned a page at a time: pass `nextOffset` back as `offset`, or read lines with `startLine` (an fs.grep match's line) and `lineCount`.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: ReadSchema,
    handler: async ({ input, context }) => {
      const parsed = ReadSchema.parse(input);
      if (parsed.startLine !== undefined && parsed.offset !== undefined)
        throw new TaviError("INVALID_INPUT", "fs.read takes `offset` or `startLine`, not both");
      const scope = await readScopeOf(context);
      const absolute = await confine(scope, parsed.path, false);
      const text = await readText(scope, absolute, MAX_PAGED_READ_BYTES);
      const written = scope.inManagedFolder(absolute)
        ? undefined
        : await options.hostWrites?.writerOf(context.workspaceId, absolute, sha256Hex(text), hostIdentity(absolute));
      const lines = parsed.startLine === undefined ? undefined : lineWindow(text, parsed.startLine, parsed.lineCount ?? DEFAULT_LINE_COUNT);
      const offset = lines?.offset ?? parsed.offset ?? 0;
      let end = Math.min(lines?.end ?? text.length, textPageEnd(text, offset, MAX_TEXT_CHARS, MAX_TEXT_BYTES));
      // A line read the page's bound cut short ends at its last whole line, so `nextLine` loses no text.
      if (lines !== undefined && end < lines.end) {
        const lastNewline = text.lastIndexOf("\n", end - 1);
        if (lastNewline >= offset) end = lastNewline + 1;
      }
      const slice = text.slice(offset, end);
      const lastLine = lines === undefined ? undefined : lines.firstLine + slice.split("\n").length - (slice.endsWith("\n") ? 1 : 0) - 1;
      return {
        path: scope.shown(absolute),
        content: slice,
        // A line-addressed read says its line numbers, and where to read on; every read gives its offset too.
        offset,
        ...(offset === 0 && end === text.length ? {} : { totalChars: text.length }),
        ...(lines === undefined
          ? {}
          : { firstLine: lines.firstLine, ...(end < text.length && lastLine !== undefined ? { nextLine: lastLine + 1 } : {}) }),
        ...(end < text.length ? { nextOffset: end } : {}),
        // A downloaded file is what a web page supplied: reading it taints the conversation.
        ...(scope.inDownloads(absolute) ? { [TOOL_UNTRUSTED_KEY]: true } : {}),
        ...readLabel(scope, absolute, [absolute], written === undefined ? [] : [written]),
      };
    },
  });

  registry.register({
    id: "fs.list",
    sink: "none",
    // A read marked untrusted is of the chat's `downloads/`: it names the download.
    outputSource: "download",
    version: "1.0.0",
    description: "List a directory in your working folder or an attached folder: names, with a trailing / on directories.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: ListSchema,
    handler: async ({ input, context }) => {
      const parsed = ListSchema.parse(input);
      const scope = await readScopeOf(context);
      const absolute = await confine(scope, parsed.path ?? ".", false);
      const entries = await readdir(absolute, { withFileTypes: true });
      const names = entries
        .slice(0, MAX_ENTRIES)
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort();
      // A downloaded file's name is what a web page chose.
      return {
        path: scope.shown(absolute),
        entries: names,
        truncated: entries.length > MAX_ENTRIES,
        ...(names.length > 0 && scope.inDownloads(absolute) ? { [TOOL_UNTRUSTED_KEY]: true } : {}),
        ...readLabel(scope, absolute, names.length > 0 ? [absolute] : []),
      };
    },
  });

  registry.register({
    id: "fs.glob",
    sink: "none",
    // A read marked untrusted is of the chat's `downloads/`: it names the download.
    outputSource: "download",
    version: "1.0.0",
    description:
      "Find files in your working folder or an attached folder whose path, relative to the searched directory, matches a glob (* and ? match any characters, including /).",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: GlobSchema,
    handler: async ({ input, context, signal }) => {
      const parsed = GlobSchema.parse(input);
      const scope = await readScopeOf(context);
      const absolute = await confine(scope, parsed.path ?? ".", false);
      const { files, truncated } = await walk(scope, absolute, signal, Date.now() + budgetMs);
      const matches = files.filter((file) => globMatches(parsed.pattern, file.split(sep).join("/"))).slice(0, MAX_MATCHES);
      // A downloaded file's name is what a web page chose.
      const untrusted = matches.some((file) => scope.inDownloads(join(absolute, file)));
      return {
        path: scope.shown(absolute),
        matches,
        truncated: truncated || matches.length === MAX_MATCHES,
        ...(untrusted ? { [TOOL_UNTRUSTED_KEY]: true } : {}),
        ...readLabel(
          scope,
          absolute,
          matches.map((file) => join(absolute, file)),
        ),
      };
    },
  });

  registry.register({
    id: "fs.grep",
    sink: "none",
    // A read marked untrusted is of the chat's `downloads/`: it names the download.
    outputSource: "download",
    version: "1.0.0",
    description:
      "Search text files in your working folder or an attached folder for a regular expression; returns path, line number and line for each match.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: GrepSchema,
    handler: async ({ input, context, signal }) => {
      const parsed = GrepSchema.parse(input);
      // The pattern is the model's and has no round in front of it: the
      // shapes that backtrack without bound are refused up front, and the
      // matching itself runs in a worker that is terminated at the deadline —
      // a single `test` cannot be interrupted on the owner's event loop.
      const unsafe = unsafePatternReason(parsed.pattern);
      if (unsafe !== undefined) throw new TaviError("INVALID_INPUT", unsafe);
      try {
        new RegExp(parsed.pattern);
      } catch (error) {
        throw new TaviError("INVALID_INPUT", `not a regular expression: ${errorMessage(error)}`);
      }
      const scope = await readScopeOf(context);
      const deadline = Date.now() + budgetMs;
      const absolute = await confine(scope, parsed.path ?? ".", false);
      const { files, truncated } = await walk(scope, absolute, signal, deadline);
      const searcher = grepWorker(parsed.pattern, parsed.ignoreCase === true ? "i" : "");
      // A match from a downloaded file quotes what a web page supplied: the result taints the conversation.
      let untrusted = false;
      // The files a match quotes, for a tainted chat's folder, and the host files a tainted chat wrote.
      const quoted = new Set<string>();
      const written: { readonly taskId?: string }[] = [];
      const result = (value: { readonly matches: readonly unknown[]; readonly truncated: boolean }) => ({
        ...(untrusted ? { ...value, [TOOL_UNTRUSTED_KEY]: true } : value),
        ...readLabel(scope, absolute, [...quoted], written),
      });
      try {
        const matches: (
          | { path: string; line: number; text: string; before?: string[]; after?: string[] }
          | { path: string; count: number }
        )[] = [];
        for (const file of files) {
          if (signal.aborted) throw new TaviError("CANCELLED", "fs.grep was cancelled");
          if (Date.now() > deadline) return result({ matches, truncated: true });
          const slashed = file.split(sep).join("/");
          if (parsed.glob !== undefined && !globMatches(parsed.glob, slashed)) continue;
          let text: string;
          try {
            text = await readText(scope, join(absolute, file), MAX_GREP_FILE_BYTES);
          } catch {
            continue;
          }
          const lines = text.split("\n");
          const hits = await searcher.search(
            lines.map((line) => line.slice(0, MAX_GREP_LINE_CHARS)),
            deadline,
            signal,
          );
          if (hits === undefined) return result({ matches, truncated: true });
          if (hits.length > 0 && scope.inDownloads(join(absolute, file))) untrusted = true;
          if (hits.length > 0) quoted.add(join(absolute, file));
          const writer =
            hits.length === 0 || scope.inManagedFolder(join(absolute, file))
              ? undefined
              : await options.hostWrites?.writerOf(
                  context.workspaceId,
                  join(absolute, file),
                  sha256Hex(text),
                  hostIdentity(join(absolute, file)),
                );
          if (writer !== undefined) written.push(writer);
          if (parsed.filesOnly === true) {
            if (hits.length > 0) matches.push({ path: slashed, count: hits.length });
            if (matches.length >= MAX_MATCHES) return result({ matches, truncated: true });
            continue;
          }
          const around = parsed.context ?? 0;
          for (const index of hits) {
            const shown = (at: number) => (lines[at] ?? "").slice(0, 300);
            matches.push({
              path: slashed,
              line: index + 1,
              text: shown(index),
              ...(around === 0
                ? {}
                : {
                    before: lines.slice(Math.max(0, index - around), index).map((line) => line.slice(0, 300)),
                    after: lines.slice(index + 1, index + 1 + around).map((line) => line.slice(0, 300)),
                  }),
            });
            if (matches.length >= MAX_MATCHES) return result({ matches, truncated: true });
          }
        }
        return result({ matches, truncated });
      } finally {
        await searcher.close();
      }
    },
  });

  registry.register({
    id: "fs.write",
    // The static sink: a write outside the managed folder outlives the
    // chat. Inside it the census says `none`; the per-call assessment narrows
    // to that, as this tool's assessor already tells the two apart.
    sink: "persist",
    version: "1.0.0",
    description:
      "Create a text file, or replace one whole, in your working folder or an attached folder you may write; to change part of a file, use fs.edit. The operator sees the diff before it runs.",
    effect: "mutating",
    // Writing the same content again changes nothing. Not marked destructive: most writes make a file, and a
    // destructive tool is asked about every time.
    annotations: { idempotent: true },
    requiredPermissions: ["tools.invoke"],
    inputSchema: WriteSchema,
    // The gate calls an assessor synchronously, so it reads the current file synchronously to show the diff.
    assess: (input, context) => {
      const parsed = WriteSchema.parse(input);
      return assessIn(context, parsed.path, "Write", () => parsed.content);
    },
    handler: async ({ input, context, assessedSubjects, contextLabel }) => {
      const parsed = WriteSchema.parse(input);
      const scope = scopeOf(context);
      const absolute = await confine(scope, parsed.path, true);
      decidedTarget(scope, absolute, assessedSubjects, parsed.path);
      if (context.folder !== undefined) await options.space?.admitWrite(context.folder, absolute, context.runId);
      if (taintedManagedWrite(scope, absolute, context, contextLabel)) await options.markFolderTainted?.(context);
      const marked = await markHostWrite(
        scope,
        context,
        contextLabel,
        absolute,
        scope.inManagedFolder(absolute) ? undefined : await fileSha256(absolute),
        parsed.content,
      );
      await writeContained(absolute, parsed.content, scope.writeRoots, writableIn(scope), scope.inManagedFolder);
      await marked();
      return { path: scope.shown(absolute), bytes: Buffer.byteLength(parsed.content, "utf8") };
    },
  });

  registry.register({
    id: "fs.edit",
    // The static sink: a write outside the managed folder outlives the
    // chat. Inside it the census says `none`; the per-call assessment narrows
    // to that, as this tool's assessor already tells the two apart.
    sink: "persist",
    version: "1.0.0",
    description:
      "Replace exact text in a file in your working folder, or in an attached folder you may write; to create a file or rewrite it whole, use fs.write. `oldText` must occur exactly once unless `replaceAll`; for several changes in one file pass `edits`, applied in order as one change. The operator sees the diff before it runs.",
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: EditSchema,
    assess: (input, context) => {
      const parsed = EditSchema.parse(input);
      const edits = editsOf(parsed);
      return assessIn(context, parsed.path, "Edit", (current) => {
        if (current === undefined) return undefined;
        let next: string | undefined = current;
        edits.forEach((edit, index) => {
          if (next === undefined) return;
          if (edit.replaceAll === true) rememberCount(countKey(context, parsed, index), occurrences(next, edit.oldText));
          next = applyEdit(next, edit);
        });
        return next;
      });
    },
    handler: async ({ input, context, assessedSubjects, contextLabel }) => {
      const parsed = EditSchema.parse(input);
      const scope = scopeOf(context);
      const absolute = await confine(scope, parsed.path, true);
      decidedTarget(scope, absolute, assessedSubjects, parsed.path);
      const current = await readText(scope, absolute);
      // Every edit applies to the text the ones before it left, or none is written: one change, never half of it.
      let next = current;
      let replaced = 0;
      for (const [index, edit] of editsOf(parsed).entries()) {
        const which = parsed.edits === undefined ? "oldText" : `edits[${index}].oldText`;
        const count = occurrences(next, edit.oldText);
        const shownCount = edit.replaceAll === true ? assessedCounts.get(countKey(context, parsed, index)) : undefined;
        if (shownCount !== undefined && shownCount !== count) {
          throw new TaviError(
            "CONFLICT",
            `the file changed since the edit was approved: ${which} occurred ${shownCount} times then and ${count} now; read it again and retry`,
          );
        }
        const edited = applyEdit(next, edit);
        if (edited === undefined) {
          throw new TaviError(
            "INVALID_INPUT",
            count === 0
              ? `${which} does not occur in the file`
              : `${which} occurs ${count} times; pass replaceAll or a longer, unique oldText`,
          );
        }
        next = edited;
        replaced += edit.replaceAll === true ? count : 1;
      }
      if (context.folder !== undefined) await options.space?.admitWrite(context.folder, absolute, context.runId);
      if (taintedManagedWrite(scope, absolute, context, contextLabel)) await options.markFolderTainted?.(context);
      const marked = await markHostWrite(scope, context, contextLabel, absolute, sha256Hex(current), next);
      await writeContained(absolute, next, scope.writeRoots, writableIn(scope), scope.inManagedFolder);
      await marked();
      return { path: scope.shown(absolute), replaced };
    },
  });
}

/**
 * The span of `text` that lines `firstLine` to `firstLine + count - 1` take,
 * counting from 1: where they start, and where the last one ends (after its
 * newline). A first line past the end is refused with how many lines there are.
 */
function lineWindow(
  text: string,
  firstLine: number,
  count: number,
): { readonly firstLine: number; readonly offset: number; readonly end: number } {
  // A final newline ends the last line; it starts no empty one.
  const lineTotal = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  if (firstLine > lineTotal)
    throw new TaviError("INVALID_INPUT", `the file has ${lineTotal} lines; startLine ${firstLine} is past its end`);
  let offset = 0;
  for (let line = 1; line < firstLine; line += 1) offset = text.indexOf("\n", offset) + 1;
  let end = offset;
  for (let line = 0; line < count && end < text.length; line += 1) {
    const next = text.indexOf("\n", end);
    end = next === -1 ? text.length : next + 1;
  }
  return { firstLine, offset, end };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The edit applied, or `undefined` when `oldText` is missing or (without `replaceAll`) not unique. */
function applyEdit(
  current: string,
  edit: { readonly oldText: string; readonly newText: string; readonly replaceAll?: boolean | undefined },
): string | undefined {
  const count = occurrences(current, edit.oldText);
  if (count === 0 || (count > 1 && edit.replaceAll !== true)) return undefined;
  return edit.replaceAll === true ? current.split(edit.oldText).join(edit.newText) : current.replace(edit.oldText, () => edit.newText);
}

/** A write the gate refuses outright, with the reason the model reads. */
function refusal(path: string, verb: string, message: string): CallAssessment {
  const reason = clip(message, MAX_LABEL_CHARS);
  return {
    display: { title: clip(`${verb} ${path}`, MAX_LABEL_CHARS) },
    subjects: [path],
    risk: "high",
    reasons: [reason],
    hardDeny: `fs refused: ${reason}`,
  };
}

/**
 * The gate's synchronous reading of a write: where it really lands (symlinks
 * resolved, as the handler will resolve them), and — only when that is in a
 * folder the chat may write — the current file, read once to show the diff. A
 * target outside those folders, in a read-only attachment, under a protected
 * path or a dev plugin's folder, or one that is not a regular file (a FIFO
 * would block the gate), is refused here already.
 *
 * Its rule subject is folder-qualified: rules match the resolved
 * path, never the spelling the model chose, and never another chat's file of
 * the same name. A write that leaves the chat's own managed folder — into a
 * host primary (a legacy chat's first root among them) or a read-write
 * attachment, folders other chats may read — asks whenever the conversation
 * is tainted, whatever a rule or grant allows; the gate's taint
 * is the conversation's sticky one. A side chat's write into a host folder is
 * rated `high`, which withholds `always`: the rule would name the same
 * absolute path in its parent, and a side chat's rule never applies there.
 * `session` stays, since a grant is the side chat's own.
 *
 * A change whose diff does not fit the approval — cut at `MAX_DIFF_CHARS`, or
 * an existing file too large to diff — is assessed `high`, which withholds
 * `always`: a standing rule should not grow out of a change the person saw
 * only part of.
 */
function assessChangeSync(
  scope: Confinement,
  path: string,
  next: (current: string | undefined) => string | undefined,
  verb: string,
): CallAssessment {
  const real = resolveConfined(path, scope, "write");
  if (typeof real !== "string") return refusal(path, verb, real.message);
  const shownPath = scope.shown(real);
  const subject = scope.subject(real);
  // The verdict records it whole, and the handler writes only the target it names.
  if (subject.length > MAX_SUBJECT_CHARS) return refusal(path, verb, `its path is longer than ${MAX_SUBJECT_CHARS} characters`);
  const subjects = [subject];
  const title = clip(`${verb} ${shownPath}`, MAX_LABEL_CHARS);
  const attachment = scope.rwAttachmentOf(real);
  const host = !scope.inManagedFolder(real);
  // A deny or ask rule matches a spelling the filesystem folds to the same name.
  // Its sink: a write outside the managed folder outlives the chat; inside, it does not.
  const held: Pick<CallAssessment, "askWhenTainted" | "foldCase" | "sink"> = {
    sink: host ? "persist" : "none",
    ...(host ? { askWhenTainted: true } : {}),
    ...(FOLD_CASE ? { foldCase: true } : {}),
  };
  const sideHost = host && scope.sideChat;
  const where = [
    ...(attachment === undefined ? [] : [clip(`writes into the attached folder "${attachment.label}"`, MAX_LABEL_CHARS)]),
    ...(sideHost ? ["a side chat's standing rule for this file would also apply in its parent chat"] : []),
  ];
  // What a tool runs on its own from a folder: shown, and approved, one write at a time. Read on the resolved path, so a
  // folder attached from inside one (`repo/.claude/skills`) is no way around it.
  const runsOnItsOwn = host && protectedProjectFile(real);
  if (runsOnItsOwn) where.push("a file git, a shell, an editor or a package manager runs on its own: approved for this write only");
  const floor = sideHost || runsOnItsOwn ? "high" : "medium";
  let size: number | undefined;
  try {
    const info = statSync(real);
    if (!info.isFile()) return refusal(path, verb, `${shownPath} is not a regular file`);
    if (info.nlink > 1 && !host) return refusal(path, verb, `${shownPath} ${HARD_LINKED}`);
    size = info.size;
  } catch {
    size = undefined;
  }
  if (size !== undefined && size > MAX_READ_BYTES) {
    const reason = `replaces an existing ${size}-byte file (too large to show a diff)`;
    return { display: { title, detail: reason }, subjects, risk: "high", reasons: [reason, ...where], onceOnly: true, ...held };
  }
  let current: string | undefined;
  if (size !== undefined) {
    try {
      current = readFileSync(real).toString("utf8");
    } catch {
      current = undefined;
    }
  }
  const after = next(current);
  const reasons = [current === undefined ? "creates a file" : "changes a file", ...where];
  const once = runsOnItsOwn ? { onceOnly: true } : {};
  if (after === undefined) return { display: { title }, subjects, risk: floor, reasons, ...held, ...once };
  const diff = clipDiff(unifiedDiff(shownPath, current ?? "", after), MAX_DIFF_CHARS);
  if (diff.truncated) reasons.push("the diff is too long to show whole");
  // What was not shown cannot be approved for later: a partly-shown write is decided once.
  return {
    display: { title, detail: diff.text },
    subjects,
    risk: diff.truncated ? "high" : floor,
    reasons,
    ...(diff.truncated ? { onceOnly: true } : {}),
    ...held,
    ...once,
  };
}

/**
 * A repository's hooks and config, anywhere: what git runs or reads to run
 * something — its own, a submodule's (`.git/modules/<name>/`, nested) and a
 * linked worktree's (`.git/worktrees/<name>/`).
 */
const GIT_INTERNALS = /\/\.git\/(?:(?:modules|worktrees)\/.+\/)?(hooks(\/|$)|config$|config\.worktree$|commondir$|info\/attributes$)/i;

/** The names `protectedProjectFile` looks for. */
const PROTECTED_FILE_NAMES = [...PROJECT_PROTECTED_NAMES, ...HOST_PROTECTED_NAMES].map(fsFold);

/** Whether a path is, or lies in, a name `PROJECT_PROTECTED_NAMES` or `HOST_PROTECTED_NAMES` lists, or a VS Code workspace file. */
export function protectedProjectFile(path: string): boolean {
  const normal = `/${fsFold(path.split(sep).join("/"))}`;
  if (normal.endsWith(".code-workspace")) return true;
  return PROTECTED_FILE_NAMES.some((name) => normal.endsWith(`/${name}`) || normal.includes(`/${name}/`));
}

/** A diff cut at a line boundary to fit `limit`, with a visible marker saying how much is hidden. */
export function clipDiff(diff: string, limit: number): { readonly text: string; readonly truncated: boolean } {
  if (diff.length <= limit) return { text: diff, truncated: false };
  const lines = diff.split("\n");
  const kept: string[] = [];
  let used = 0;
  const marker = (hidden: number) => `…diff truncated (${hidden} more lines)`;
  for (const line of lines) {
    // Room for this line, its newline, and the marker after it.
    if (used + line.length + 1 + marker(lines.length).length > limit) break;
    kept.push(line);
    used += line.length + 1;
  }
  return { text: [...kept, marker(lines.length - kept.length)].join("\n"), truncated: true };
}

/**
 * Where a path really is: resolved against the chat's primary folder, then
 * through every symlink; for a path that does not exist yet, its nearest
 * existing ancestor is resolved and the rest appended — but a link on the way
 * that resolves to nothing (dangling) is refused, since writing through it
 * would follow it out. The result must lie in one of the chat's folders —
 * one it may write, for a write — outside every protected path. Returns the
 * real path, or why it is refused.
 */
function resolveConfined(
  path: string,
  scope: Confinement,
  mode: "read" | "write",
): string | { readonly code: "NOT_AUTHORIZED" | "NOT_FOUND" | "UNAVAILABLE"; readonly message: string } {
  const label = clip(path, MAX_LABEL_CHARS - 60);
  // A name Windows reads as another file (a stream, a device, a dropped trailing dot) is never resolved.
  const form = windowsPathRefusal(path);
  if (form !== undefined) return { code: "NOT_AUTHORIZED", message: `${label} ${form}` };
  const target = isAbsolute(path) ? resolve(path) : resolve(scope.primary, path);
  let existing = target;
  const missing: string[] = [];
  for (;;) {
    try {
      existing = realpathSync.native(existing);
      break;
    } catch {
      // Present but unresolvable is a dangling link, not a new file.
      try {
        lstatSync(existing);
        return { code: "NOT_AUTHORIZED", message: `${label} is a link to something that does not exist` };
      } catch {
        // absent: walk up
      }
      const parent = dirname(existing);
      if (parent === existing) return { code: "NOT_FOUND", message: `${label} does not exist` };
      missing.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
  }
  const real = join(existing, ...missing);
  // A chat whose own folder could not be made reads its attachments still; its own folder is refused with why.
  if (scope.managedUnavailable !== undefined && within(real, scope.managed))
    return { code: "UNAVAILABLE", message: scope.managedUnavailable };
  // Containment is on the on-disk spelling, compared exactly: folding case
  // here would admit a sibling on a case-sensitive volume.
  if (!scope.readRoots.some((root) => within(real, root)))
    return { code: "NOT_AUTHORIZED", message: `${label} is outside your working folder and attached folders` };
  const refused = scope.protectedReason(real);
  if (refused !== undefined) return { code: "NOT_AUTHORIZED", message: refused };
  if (mode === "read") return real;
  if (!scope.writeRoots.some((root) => within(real, root)))
    return { code: "NOT_AUTHORIZED", message: `${label} is in a folder attached read-only` };
  const readOnly = scope.writeProtectedReason(real);
  return readOnly === undefined ? real : { code: "NOT_AUTHORIZED", message: readOnly };
}

/** An error's `code`, when it has one (a Node system error). */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * Write a file the checks have resolved, without following a link the
 * sandbox or anyone else could plant between the check and the write — at the
 * target or at any ancestor.
 *
 * - Missing directories are made one level at a time from the write root the
 *   path lies in, each `lstat`ed: a component that is a link or not a
 *   directory is refused, so no `mkdir({ recursive: true })` walks through one.
 * - A new file is opened `O_CREAT | O_EXCL | O_NOFOLLOW`, an existing one
 *   `O_NOFOLLOW` without creating: a link at the target fails the open.
 *   Neither blocks on a FIFO (`O_NONBLOCK`), and anything but a regular file
 *   is refused before a byte is written.
 * - Once open, the path is resolved again and must still be itself — the
 *   real path the checks resolved — be writable (`writable`) and name the
 *   descriptor's own inode (`lstat` against `fstat`): an ancestor swapped for
 *   a link after the walk is caught here, even one leading into another
 *   folder the chat may write.
 *   Nothing is written then, and a file this call created is removed only
 *   when its parent is still one the chat may write — never by following the
 *   link that misled the open.
 * - An existing file with other hard links in a managed folder is refused, as
 *   a read of it is (`inManagedFolder`): a name there must not change
 *   content kept elsewhere.
 *
 * `beforeOpen` runs between the walk and the open: the seam a test swaps an
 * ancestor through, to show the race is caught.
 */
export async function writeContained(
  absolute: string,
  content: string,
  roots: readonly string[],
  writable: (real: string) => boolean,
  inManagedFolder: (real: string) => boolean,
  beforeOpen?: () => Promise<void>,
): Promise<void> {
  await writeContainedFile(absolute, content, roots, writable, inManagedFolder, "replace", beforeOpen);
}

/**
 * `writeContained` for bytes that must land in a new file: the same walk,
 * `O_CREAT | O_EXCL | O_NOFOLLOW` open, re-resolve and inode check and
 * managed-folder hard-link refusal, but an existing target is refused
 * (`CONFLICT`, `details.reason` `exists`) and never truncated, and a file it
 * created and could not finish is removed.
 */
export async function writeContainedBytes(
  absolute: string,
  bytes: Uint8Array,
  roots: readonly string[],
  writable: (real: string) => boolean,
  inManagedFolder: (real: string) => boolean,
  beforeOpen?: () => Promise<void>,
): Promise<void> {
  await writeContainedFile(absolute, bytes, roots, writable, inManagedFolder, "create", beforeOpen);
}

async function writeContainedFile(
  absolute: string,
  content: string | Uint8Array,
  roots: readonly string[],
  writable: (real: string) => boolean,
  inManagedFolder: (real: string) => boolean,
  mode: "replace" | "create",
  beforeOpen?: () => Promise<void>,
): Promise<void> {
  const label = clip(absolute, MAX_LABEL_CHARS - 80);
  const root = deepest(roots, (entry) => entry, absolute);
  if (root === undefined) throw new TaviError("NOT_AUTHORIZED", `${label} is outside the folders this chat may write`);
  let current = root;
  for (const component of relative(root, dirname(absolute))
    .split(sep)
    .filter((entry) => entry !== "")) {
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o755 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const status = await lstat(current);
    if (status.isSymbolicLink() || !status.isDirectory())
      throw new TaviError(
        "NOT_AUTHORIZED",
        `${clip(current, MAX_LABEL_CHARS - 80)} is not a plain folder; a write never passes through a link`,
      );
  }
  await beforeOpen?.();
  let created = false;
  let handle;
  try {
    handle = await openNoFollow(absolute, "create", { mode: 0o644 });
    created = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    if (mode === "create")
      throw new TaviError("CONFLICT", `${label} already exists; nothing was overwritten`, { details: { reason: "exists" } });
    try {
      handle = await openNoFollow(absolute, "write");
    } catch (again) {
      if (errorCode(again) === "ELOOP") throw new TaviError("NOT_AUTHORIZED", `${label} is a link; a write never follows one`);
      throw again;
    }
  }
  let opened: FileIdentity | undefined;
  try {
    const info = await handle.stat();
    opened = info;
    if (!info.isFile()) throw new TaviError("INVALID_INPUT", "the target is not a regular file");
    // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
    const again = await realpath(absolute).catch(() => undefined);
    // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
    const named = again === undefined ? undefined : await lstat(again).catch(() => undefined);
    if (again !== absolute || !writable(again) || named === undefined || !sameIdentity(named, info)) {
      if (created) await removeIfContained(absolute, info, writable);
      opened = undefined;
      throw new TaviError("NOT_AUTHORIZED", `${label} changed while it was being opened; nothing was written`);
    }
    if (!created && info.nlink > 1 && inManagedFolder(again)) throw new TaviError("NOT_AUTHORIZED", `${label} ${HARD_LINKED}`);
    await handle.truncate(0);
    if (typeof content === "string") await handle.writeFile(content, "utf8");
    else await handle.writeFile(content);
  } catch (error) {
    // A new file that could not be finished is not left behind half-written.
    if (mode === "create" && created && opened !== undefined) await removeIfContained(absolute, opened, writable);
    throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Remove a file a refused write created, only where the chat may write and
 * only when it is the very file opened: its parent is resolved first, so the
 * unlink never goes through a planted link.
 */
async function removeIfContained(absolute: string, opened: FileIdentity, writable: (real: string) => boolean): Promise<void> {
  // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
  const parent = await realpath(dirname(absolute)).catch(() => undefined);
  if (parent === undefined) return;
  const candidate = join(parent, basename(absolute));
  if (!writable(candidate)) return;
  // Unreadable is unconfirmed: the check below refuses it (or leaves the file alone).
  const status = await lstat(candidate).catch(() => undefined);
  // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
  if (status !== undefined && sameIdentity(status, opened)) await unlink(candidate).catch(() => undefined);
}

/** The worker's code: compile the pattern once, answer each batch of lines with the indexes that match. */
const GREP_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const pattern = new RegExp(workerData.pattern, workerData.flags);
parentPort.on("message", (lines) => {
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) if (pattern.test(lines[index])) hits.push(index);
  parentPort.postMessage(hits);
});
`;

/**
 * A regular expression run off the event loop. `search` resolves `undefined`
 * when the deadline passes first, and the worker is then terminated — which,
 * unlike anything on the main thread, stops a backtracking `test` mid-run.
 */
function grepWorker(
  pattern: string,
  flags = "",
): {
  search(lines: readonly string[], deadline: number, signal: AbortSignal): Promise<readonly number[] | undefined>;
  close(): Promise<void>;
} {
  let worker: Worker | undefined;
  const close = async () => {
    const running = worker;
    worker = undefined;
    if (running !== undefined) await running.terminate();
  };
  return {
    close,
    search: (lines, deadline, signal) =>
      new Promise<readonly number[] | undefined>((resolvePromise, reject) => {
        worker ??= new Worker(GREP_WORKER_SOURCE, { eval: true, workerData: { pattern, flags } });
        const running = worker;
        const settle = (finish: () => void) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          running.off("message", onMessage);
          running.off("error", onError);
          finish();
        };
        const onMessage = (hits: number[]) => settle(() => resolvePromise(hits));
        const onError = (error: Error) => settle(() => reject(new TaviError("INVALID_INPUT", `the search failed: ${error.message}`)));
        const onAbort = () => settle(() => void close().then(() => reject(new TaviError("CANCELLED", "fs.grep was cancelled")), reject));
        const timer = setTimeout(
          () => settle(() => void close().then(() => resolvePromise(undefined), reject)),
          Math.max(0, deadline - Date.now()),
        );
        running.on("message", onMessage);
        running.on("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        running.postMessage(lines);
      }),
  };
}

/** A text's lines: none for an empty one (a new file), and no empty line after its final newline. */
function diffLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** The longest middle region `unifiedDiff` compares line by line; past it, one span stands for the change. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * A small unified diff: each changed region with three lines of context, so
 * edits far apart in a file are shown as separate hunks, not one span with
 * every line between them. It is for a person deciding, not for `patch`; a
 * large change is summarised.
 */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return `${path}: no change`;
  const a = diffLines(before);
  const b = diffLines(after);
  if (a.length === b.length && a.every((line, index) => line === b[index])) return `${path}: only the newline at the end changes`;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  // The middle, line by line where it is small enough to compare: which lines each side keeps.
  const rows = endA - start + 1;
  const columns = endB - start + 1;
  const ops: { readonly kind: " " | "-" | "+"; readonly text: string; readonly at: number; readonly atB: number }[] = [];
  for (let index = Math.max(0, start - 3); index < start; index += 1) ops.push({ kind: " ", text: a[index] ?? "", at: index, atB: index });
  if (rows > 0 && columns > 0 && rows * columns <= MAX_DIFF_CELLS) {
    const width = columns + 1;
    const common = new Uint32Array((rows + 1) * width);
    for (let row = rows - 1; row >= 0; row -= 1)
      for (let column = columns - 1; column >= 0; column -= 1)
        common[row * width + column] =
          a[start + row] === b[start + column]
            ? (common[(row + 1) * width + column + 1] as number) + 1
            : Math.max(common[(row + 1) * width + column] as number, common[row * width + column + 1] as number);
    let row = 0;
    let column = 0;
    while (row < rows || column < columns) {
      if (row < rows && column < columns && a[start + row] === b[start + column]) {
        ops.push({ kind: " ", text: a[start + row] ?? "", at: start + row, atB: start + column });
        row += 1;
        column += 1;
      } else if (
        row < rows &&
        (column === columns || (common[(row + 1) * width + column] as number) >= (common[row * width + column + 1] as number))
      ) {
        // A line only the old side has goes first: a change reads as its removed lines, then its added ones.
        ops.push({ kind: "-", text: a[start + row] ?? "", at: start + row, atB: start + column });
        row += 1;
      } else {
        ops.push({ kind: "+", text: b[start + column] ?? "", at: start + row, atB: start + column });
        column += 1;
      }
    }
  } else {
    for (let index = start; index <= endA; index += 1) ops.push({ kind: "-", text: a[index] ?? "", at: index, atB: start });
    for (let index = start; index <= endB; index += 1) ops.push({ kind: "+", text: b[index] ?? "", at: endA + 1, atB: index });
  }
  for (let index = endA + 1; index <= Math.min(a.length - 1, endA + 3); index += 1)
    ops.push({ kind: " ", text: a[index] ?? "", at: index, atB: index - endA + endB });
  // Hunks: each change with up to three unchanged lines around it; changes closer than that share a hunk.
  const lines = [`--- ${path}`, `+++ ${path}`];
  const changed = ops.map((op, index) => (op.kind === " " ? -1 : index)).filter((index) => index >= 0);
  let hunkStart = -1;
  let hunkEnd = -1;
  const flush = () => {
    if (hunkStart < 0) return;
    const hunk = ops.slice(hunkStart, hunkEnd + 1);
    const first = hunk[0] as (typeof ops)[number];
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    // An empty side starts before its first line: a new file's hunk is `-0,0`.
    lines.push(`@@ -${oldCount === 0 ? first.at : first.at + 1},${oldCount} +${newCount === 0 ? first.atB : first.atB + 1},${newCount} @@`);
    for (const op of hunk) lines.push(`${op.kind}${op.text}`);
  };
  for (const index of changed) {
    const from = Math.max(0, index - 3);
    const to = Math.min(ops.length - 1, index + 3);
    if (hunkStart >= 0 && from <= hunkEnd + 1) hunkEnd = Math.max(hunkEnd, to);
    else {
      flush();
      hunkStart = from;
      hunkEnd = to;
    }
  }
  flush();
  return lines.join("\n");
}
