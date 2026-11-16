import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";
import type { AsyncRepository } from "./persistence-types.js";
import type { FrontEnd } from "./task-origins.js";

/**
 * A chat's working folder: where its file
 * tools and its shell work, recorded by the owner and never chosen by the
 * model.
 *
 * By default a managed folder, `<data-dir>/chats/<workspace>/<task-id>/`
 * (`0700`), which tavi creates on first use; a chat may instead use a host
 * folder under an `--fs-root` as its primary, and attach host folders
 * read-only or read-write. Reads reach the primary and every attachment;
 * writes the primary, the managed folder and read-write attachments.
 */

/** How a chat may use an attached folder: read it (`ro`, the default) or also write it (`rw`). */
export const CHAT_FOLDER_MODES = ["ro", "rw"] as const;
export type ChatFolderMode = (typeof CHAT_FOLDER_MODES)[number];
export const ChatFolderModeSchema = z.enum(CHAT_FOLDER_MODES);

/** Whether a chat's primary folder is its managed one or a host folder under an `--fs-root`. */
export const CHAT_FOLDER_PRIMARY_KINDS = ["managed", "host"] as const;
export type ChatFolderPrimaryKind = (typeof CHAT_FOLDER_PRIMARY_KINDS)[number];

/** The most host folders one chat may attach. */
export const CHAT_FOLDER_ATTACHMENTS_MAX = 16;
/**
 * The most a stored record holds: more than a chat attaches, since a side
 * chat inherits its parent's host primary beside its attachments — a reset
 * or a detach must always be storable. One under a resolved folder's bound, which
 * adds a side chat's parent's own folder.
 */
export const CHAT_FOLDER_STORED_ATTACHMENTS_MAX = 255;
/** The longest absolute path a folder entry may hold. */
export const CHAT_FOLDER_PATH_MAX = 4_096;
/** The longest label an attachment is shown and addressed by. */
export const CHAT_FOLDER_LABEL_MAX = 128;

/**
 * The label a side chat's parent's managed folder is attached by (decision
 * f): no stored attachment ever has it, so a folder attached by it marks a
 * side chat's — or a side chat's worker's — folder.
 */
export const CHAT_FOLDER_PARENT_LABEL = "parent-chat";

export const ChatFolderAttachmentSchema = z.strictObject({
  /** Absolute and real (every link resolved) when recorded, and again when resolved for a turn. */
  path: z.string().min(1).max(CHAT_FOLDER_PATH_MAX),
  mode: ChatFolderModeSchema,
  /** Unique within the chat: the folder's basename, then `basename-2`, …. */
  label: z.string().min(1).max(CHAT_FOLDER_LABEL_MAX),
});
export interface ChatFolderAttachment {
  readonly path: string;
  readonly mode: ChatFolderMode;
  readonly label: string;
}

/**
 * A chat's folder as one turn sees it, resolved once per admission
 * (`ChatFolders.resolve`) and stamped on `InvocationContext.folder` — never
 * from model input. Every path is absolute and real.
 *
 * `revision` is the chat's stored revision, 0 for a chat that has none (its
 * origin's defaults). `tainted` records that the conversation was tainted when
 * the turn was admitted: `sandbox.run` treats read-write
 * attachments as read-only then. `managedUnavailable` says why the managed
 * folder could not be created (disk full, permissions, a planted link): the
 * tools that need it fail with that message while reads of the attachments
 * still work.
 *
 * The optional fields carry an explicit `| undefined` for the reason
 * `InvocationContext.memoryScopeRestricted` gives: `ChatFolderSchema` is what
 * round-trips through a checkpoint.
 */
export interface ChatFolder {
  readonly primary: string;
  readonly primaryKind: ChatFolderPrimaryKind;
  /** The chat's managed folder, always — also when the primary is a host folder. */
  readonly managed: string;
  /** `<managed>/.tmp`: scratch, emptied when a turn ends and at an epoch rollover — never inside a host folder. */
  readonly scratch: string;
  /** `<managed>/.home`: the sandbox's `HOME`, kept across turns. */
  readonly home: string;
  readonly attachments: readonly ChatFolderAttachment[];
  readonly revision: number;
  readonly tainted?: true | undefined;
  /**
   * The managed folders this turn reaches whose chat is tainted
   * (`tavi_task_folders.tainted_at`): its own chat's, a worker's root
   * chat's, a side chat's
   * parent's. A read in one is untrusted (`sandbox`), so a side chat or a
   * worker reading what a tainted chat wrote is tainted too.
   */
  readonly taintedFolders?: readonly ChatFolderTaint[] | undefined;
  readonly managedUnavailable?: string | undefined;
}

/** A managed folder whose chat was tainted, and that chat. */
export interface ChatFolderTaint {
  readonly path: string;
  readonly taskId: string;
}

export const ChatFolderSchema = z.strictObject({
  primary: z.string().min(1).max(CHAT_FOLDER_PATH_MAX),
  primaryKind: z.enum(CHAT_FOLDER_PRIMARY_KINDS),
  managed: z.string().min(1).max(CHAT_FOLDER_PATH_MAX),
  scratch: z.string().min(1).max(CHAT_FOLDER_PATH_MAX),
  home: z.string().min(1).max(CHAT_FOLDER_PATH_MAX),
  // A side chat adds its parent's own folder to what its stored row bounds.
  attachments: z.array(ChatFolderAttachmentSchema).max(256),
  revision: z.number().int().nonnegative(),
  tainted: z.literal(true).optional(),
  taintedFolders: z
    .array(z.strictObject({ path: z.string().min(1).max(CHAT_FOLDER_PATH_MAX), taskId: IdSchema }))
    .max(2)
    .optional(),
  managedUnavailable: z.string().min(1).max(1_000).optional(),
});

/**
 * A chat's stored folder (`tavi_task_folders`). No row means
 * "managed, with its origin's default attachments"; a worker
 * never has one, it resolves through its root chat.
 */
export const ChatFolderRowSchema = z.strictObject({
  taskId: IdSchema,
  workspaceId: IdSchema,
  primaryKind: z.enum(CHAT_FOLDER_PRIMARY_KINDS),
  /** The host folder's real path when `primaryKind` is `host`; absent for `managed`. */
  primaryPath: z.string().min(1).max(CHAT_FOLDER_PATH_MAX).optional(),
  attachments: z.array(ChatFolderAttachmentSchema).max(CHAT_FOLDER_STORED_ATTACHMENTS_MAX),
  revision: z.number().int().positive(),
  updatedAt: TimestampSchema,
});
export type ChatFolderRow = z.infer<typeof ChatFolderRowSchema>;

/** A save: compare-and-set on the revision the writer read (0 when the chat had no row). */
export interface WriteChatFolderInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly primaryKind: ChatFolderPrimaryKind;
  readonly primaryPath?: string;
  readonly attachments: readonly ChatFolderAttachment[];
  readonly expectedRevision: number;
  readonly now: string;
}

interface TaskFoldersRepositoryPortDefinition {
  /** The chat's stored folder; absent when it has none (its origin's defaults). */
  get(taskId: string): ChatFolderRow | undefined;
  /** The chat's stored revision, 0 when it has none; read without parsing the row, so a reset can clear one that no longer parses. */
  revision(taskId: string): number;
  /**
   * Save the chat's folder as the next revision. A stale `expectedRevision`
   * is `CONFLICT` with the current revision in its details; an unknown task
   * is `NOT_FOUND`; a row outside `ChatFolderRowSchema`'s bounds is
   * `INVALID_INPUT`. The caller (`ChatFolders.set`) has validated the paths.
   */
  write(input: WriteChatFolderInput): ChatFolderRow;
  /**
   * Record that the chat is tainted: sticky, the first stamp kept. A chat
   * with no stored folder
   * gets a taint-only row (revision 0), which `get` does not return and a
   * first `write` (expecting revision 0) fills in. Answers the stamp; an
   * unknown task is `NOT_FOUND`.
   */
  markTainted(input: { readonly taskId: string; readonly workspaceId: string; readonly now: string }): string;
  /** When the chat was first recorded tainted; absent when it never was. */
  taintedAt(taskId: string): string | undefined;
  /**
   * Record a tainted write of a host-folder file:
   * its real path, the SHA-256 of what was written and, once it exists, the
   * file's identity; `taskId` the chat it is credited to (none when unknown).
   * A row per path and bytes, the newest `HOST_WRITE_MARKS_PER_PATH` per path
   * kept, so a failed or racing write never drops an earlier mark.
   */
  recordTaintedWrite(input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly sha256: string;
    readonly taskId?: string | undefined;
    readonly file?: HostFileIdentity | undefined;
    readonly now: string;
  }): void;
  /**
   * The tainted write that left this file — by `path`, or by `file` under
   * another name — holding exactly these bytes, in any workspace; its chat
   * (`taskId`) only when it is `workspaceId`'s and not forgotten. Undefined
   * when none did.
   */
  taintedWriteOf(input: {
    readonly workspaceId: string;
    readonly path: string;
    readonly sha256: string;
    readonly file?: HostFileIdentity | undefined;
  }): { readonly taskId?: string } | undefined;
  /** The newest marks on files under `roots` (any workspace's), at most `HOST_WRITE_MARKS_LISTED`; `taskId` as `taintedWriteOf` gives it. */
  taintedWritesUnder(input: {
    readonly workspaceId: string;
    readonly roots: readonly string[];
  }): readonly { readonly path: string; readonly sha256: string; readonly taskId?: string }[];
}

/** A host file's identity, its device and inode as decimal strings: a mark follows the file under another name (a hard link). */
export interface HostFileIdentity {
  readonly dev: string;
  readonly ino: string;
}

/** How many marked versions of one host path are kept (`recordTaintedWrite`). */
export const HOST_WRITE_MARKS_PER_PATH = 8;
/** How many marks a shell call checks at most (`taintedWritesUnder`), newest first. */
export const HOST_WRITE_MARKS_LISTED = 200;

export type TaskFoldersRepositoryPort = AsyncRepository<TaskFoldersRepositoryPortDefinition>;

/**
 * One change to a chat's folder (`ChatFolders.set`): a host folder as
 * primary, the managed folder as primary, attach a host folder (read-only
 * unless `rw`), detach one by its label, or reset — back to the origin's
 * defaults.
 */
export const ChatFolderChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("primary"), path: z.string().min(1).max(CHAT_FOLDER_PATH_MAX) }),
  z.strictObject({ kind: z.literal("managed") }),
  z.strictObject({ kind: z.literal("attach"), path: z.string().min(1).max(CHAT_FOLDER_PATH_MAX), mode: ChatFolderModeSchema.optional() }),
  z.strictObject({ kind: z.literal("detach"), label: z.string().min(1).max(CHAT_FOLDER_LABEL_MAX) }),
  z.strictObject({ kind: z.literal("reset") }),
]);
export type ChatFolderChange = z.infer<typeof ChatFolderChangeSchema>;

/**
 * Who asks for a folder change: the front end it was typed in, set by the
 * owner from the connection and never from a payload — `web` through `tavi
 * ui`'s bridge, `ipc` from another attached client — or `local` for the
 * owner's own in-process commands. A `web` caller can never name a host path;
 * it redeems picker tokens.
 */
export interface ChatFolderCaller {
  readonly frontEnd: FrontEnd | "local";
  /**
   * The path was redeemed from a picker token this owner issued on the
   * caller's own connection (`browse`), not sent by the caller: a `web`
   * caller may use it. Set by the owner only.
   */
  readonly picked?: true;
}

/** The command a chat whose folder is unavailable is told to run. */
export const CHAT_FOLDER_RESET_COMMAND = "/folder reset";

/** The command that reclaims chats' own folders. */
export const CHAT_FOLDERS_PRUNE_COMMAND = "tavi tasks folders prune";

/**
 * The command that clears one chat's own folder, named where
 * forget leaves it in place and where a full folder refuses a write.
 */
export const chatFolderPruneCommand = (taskId: string): string => `${CHAT_FOLDERS_PRUNE_COMMAND} --chat ${taskId}`;

/**
 * Folder retention, as `tavi serve` defaults it. The caps
 * are a budget, not a ceiling: past `FOLDER_BUDGET_WARN_FRACTION` the folder
 * and the turn warn; at the cap `.tmp/` is emptied first, then host-side
 * writes and new `sandbox.run` calls are refused. A shell may overshoot within
 * one call. The free-space floor refuses the same, on the data directory's
 * volume, which `chats/` shares with `tavi.sqlite`.
 */
export const FOLDER_CAP_DEFAULT_BYTES = 2 * 1024 ** 3;
/** Every managed folder together, `.trash/` included (`serve --chats-cap`). */
export const CHATS_CAP_DEFAULT_BYTES = 20 * 1024 ** 3;
/** `serve --free-space-floor`. */
export const FREE_SPACE_FLOOR_DEFAULT_BYTES = 1024 ** 3;
/** The share of a cap past which a folder warns. */
export const FOLDER_BUDGET_WARN_FRACTION = 0.8;
/** How old a run's folder is before `tavi tasks folders prune` takes it by default (days). */
export const FOLDER_PRUNE_DEFAULT_DAYS = 30;
/** How long a pruned folder waits in `chats/.trash/` before it is deleted (days). */
export const FOLDER_TRASH_KEEP_DAYS = 7;
/** Where pruned folders wait, under the data directory's `chats/`: never a workspace's name, which `segment` never starts with a dot. */
export const CHAT_FOLDERS_TRASH = ".trash";

/** A size as a person reads it: bytes, KB, MB, GB or TB (powers of 1024). */
export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * A size an operator typed (`--folder-cap 2GB`): a number of bytes, or a
 * number with `K`, `M`, `G` or `T` (powers of 1024, as `byteSize` prints
 * them; `KB`, `KiB` and `k` alike). `undefined` for anything else.
 */
export function parseByteSize(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:([kmgt])(?:i?b)?|b)?\s*$/i.exec(text);
  if (match === null) return undefined;
  const power = match[2] === undefined ? 0 : "kmgt".indexOf(match[2].toLowerCase()) + 1;
  const bytes = Math.floor(Number(match[1]) * 1024 ** power);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

/**
 * Where an approved artifact is copied in its chat's managed folder: a
 * browser download into `downloads/`, a PDF
 * report into `reports/`. Never a host folder.
 */
export const ARTIFACT_FOLDER_COPIES = ["downloads", "reports"] as const;
export type ArtifactFolderCopy = (typeof ARTIFACT_FOLDER_COPIES)[number];

/** The longest name, in UTF-8 bytes, a file copied into a chat's folder gets. */
export const FOLDER_FILE_NAME_MAX_BYTES = 128;

/** Control and format characters (bidi embeddings, overrides and isolates U+202A–U+202E and U+2066–U+2069, marks, zero-width characters, U+FEFF) and the line and paragraph separators: a name shows what it is, on one line. */
const UNSAFE_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/**
 * `text` kept on one line where it is shown to a model or a person (a folder's
 * path or label in the system prompt): each control or format character
 * and each line or paragraph separator written as a `\u{…}` escape, so a
 * name on disk can never start a line of its own.
 */
export function lineSafe(text: string): string {
  return text.replace(UNSAFE_NAME_CHARACTERS, (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`);
}

/** Whether `text` holds a character `lineSafe` would escape. */
export function hasLineUnsafeCharacters(text: string): boolean {
  return text.search(UNSAFE_NAME_CHARACTERS) !== -1;
}

/** `text` cut to at most `limit` UTF-8 bytes, never inside a character. */
function cutToBytes(text: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > limit) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * A name a file may safely be given in a chat's folder, from a name a
 * web page or a model suggested: its last path component only; no control,
 * bidi-override or path characters (`/`, `\`, `:`); no leading dot (so never
 * hidden, never `.` or `..`) and no surrounding spaces; at most
 * `FOLDER_FILE_NAME_MAX_BYTES` bytes, the extension kept. `fallback` when
 * nothing is left.
 */
export function folderFileName(suggested: string, fallback: string): string {
  const last = suggested.normalize("NFC").split(/[/\\]/).pop() ?? "";
  const cleaned = last
    .replace(UNSAFE_NAME_CHARACTERS, "")
    .replace(/:/g, "")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  const name = cleaned === "" ? fallback : cleaned;
  if (new TextEncoder().encode(name).byteLength <= FOLDER_FILE_NAME_MAX_BYTES) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  const stem = cutToBytes(
    name.slice(0, name.length - extension.length),
    FOLDER_FILE_NAME_MAX_BYTES - new TextEncoder().encode(extension).byteLength,
  ).replace(/[.\s]+$/, "");
  return stem === "" ? cutToBytes(name, FOLDER_FILE_NAME_MAX_BYTES) : `${stem}${extension}`;
}

/** How many ` (n)` names are tried before a copy, or a new file at a default name, gives up. */
export const FOLDER_FILE_NAME_VARIANTS = 100;

/**
 * The name a copy takes when `name` is taken: `report (2).pdf`, `report (3).pdf`,
 * … — still within the byte limit and never starting with a space: the stem is
 * cut first, and an extension that leaves no stem (or one longer than 16
 * characters) is cut with it.
 */
export function folderFileNameVariant(name: string, index: number): string {
  if (index <= 1) return name;
  const suffix = ` (${index})`;
  const budget = FOLDER_FILE_NAME_MAX_BYTES - new TextEncoder().encode(suffix).byteLength;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  const stem = cutToBytes(name.slice(0, name.length - extension.length), budget - new TextEncoder().encode(extension).byteLength).replace(
    /[.\s]+$/,
    "",
  );
  if (stem !== "") return `${stem}${suffix}${extension}`;
  const whole = cutToBytes(name, budget).replace(/[.\s]+$/, "");
  return `${whole === "" ? "file" : whole}${suffix}`;
}
