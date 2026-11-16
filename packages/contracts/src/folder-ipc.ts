import { z } from "zod";

import {
  CHAT_FOLDER_ATTACHMENTS_MAX,
  CHAT_FOLDER_LABEL_MAX,
  CHAT_FOLDER_PATH_MAX,
  CHAT_FOLDER_PRIMARY_KINDS,
  ChatFolderAttachmentSchema,
  ChatFolderModeSchema,
} from "./chat-folders.js";
import { IdSchema, TimestampSchema } from "./ids.js";

/**
 * A chat's working folder over IPC: the
 * `folder` command — show, change, list and download — and `browse`, the
 * canvas's attach picker, plus the `run` payload's `folder` and `clientCwd`.
 *
 * The web bridge never names a host path (I-web): `browse` answers each folder
 * it lists with a token the owner issued on that connection, and a page
 * redeems a token where a terminal client may send a path. The owner maps
 * tokens to paths itself; a token is worth nothing on another connection, or
 * once that connection closes.
 */

/** A picker token: opaque, owner-issued, valid on the connection it was issued on. */
export const FolderPickTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

/**
 * Where a new chat works (`run.folder`): its own managed folder, a host
 * folder named by path (a terminal client, never the web bridge), or a
 * folder a `browse` answer offered (`pick`).
 */
export const ChatFolderChoiceSchema = z.union([
  z.strictObject({ managed: z.literal(true) }),
  z.strictObject({ path: z.string().min(1).max(CHAT_FOLDER_PATH_MAX) }),
  z.strictObject({ pick: FolderPickTokenSchema }),
]);
export type ChatFolderChoice = z.infer<typeof ChatFolderChoiceSchema>;

/** A host folder to attach: by path from a terminal, by a picker token from the canvas. */
export const ChatFolderSourceSchema = z.union([
  z.strictObject({ path: z.string().min(1).max(CHAT_FOLDER_PATH_MAX) }),
  z.strictObject({ pick: FolderPickTokenSchema }),
]);
export type ChatFolderSource = z.infer<typeof ChatFolderSourceSchema>;

/**
 * The folders a new chat starts with attached (`run.folderAttachments`): each
 * a host folder by path (a terminal) or a `browse` token (the canvas), with
 * its mode. Picked on an empty chat before its first message.
 */
export const RunFolderAttachmentsSchema = z
  .array(z.strictObject({ folder: ChatFolderSourceSchema, mode: ChatFolderModeSchema }))
  .min(1)
  .max(CHAT_FOLDER_ATTACHMENTS_MAX);
export type RunFolderAttachments = z.infer<typeof RunFolderAttachmentsSchema>;

/** The longest `clientCwd` a run may carry: a folder path. */
export const CLIENT_CWD_MAX = CHAT_FOLDER_PATH_MAX;

/** How many entries one `folder files` answer lists; more is `truncated`. */
export const FOLDER_FILES_MAX_ENTRIES = 500;
/** How many folders one `browse` answer lists; more is `truncated`. */
export const FOLDER_BROWSE_MAX_ENTRIES = 200;
/** How deep below an `--fs-root` `browse` goes: a folder deeper than this is listed but not opened. */
export const FOLDER_BROWSE_MAX_DEPTH = 12;
/** One `folder read` chunk, before base64. */
export const FOLDER_READ_CHUNK_BYTES = 256 * 1024;
/** The largest file `folder read` serves (a download in the canvas). */
export const FOLDER_READ_MAX_BYTES = 32 * 1024 * 1024;
/** The longest relative path `folder files` and `folder read` take inside a folder. */
export const FOLDER_RELATIVE_PATH_MAX = 1_024;

/**
 * Which of a chat's folders a `files` or `read` names: `primary` (the chat's
 * working folder), `managed` (its own folder, when the primary is a host
 * folder), or `attachment:<label>`.
 */
export const FolderRootIdSchema = z
  .string()
  .min(1)
  .max(CHAT_FOLDER_LABEL_MAX + 16)
  .regex(/^(primary|managed|attachment:.+)$/);

const FolderTargetFields = {
  workspaceId: IdSchema.optional(),
  taskId: IdSchema,
};

/** A relative path inside one of the chat's folders: `/`-separated, never absolute, never `..`. */
const relativePath = (min: number) =>
  z
    .string()
    .min(min)
    .max(FOLDER_RELATIVE_PATH_MAX)
    .refine((path) => !path.includes("\0") && !path.startsWith("/") && !path.split("/").includes(".."), {
      message: "a path inside the folder, relative and without ..",
    });

export const FolderPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("show"), ...FolderTargetFields }),
  /** The chat's primary folder: its own (`managed`), or a host folder. */
  z.strictObject({ action: z.literal("set"), ...FolderTargetFields, folder: ChatFolderChoiceSchema }),
  z.strictObject({
    action: z.literal("attach"),
    ...FolderTargetFields,
    folder: ChatFolderSourceSchema,
    mode: ChatFolderModeSchema.optional(),
  }),
  z.strictObject({ action: z.literal("detach"), ...FolderTargetFields, label: z.string().min(1).max(CHAT_FOLDER_LABEL_MAX) }),
  /** Back to the origin's defaults; also clears a folder that is gone. */
  z.strictObject({ action: z.literal("reset"), ...FolderTargetFields }),
  /** One folder's entries, a level at a time: `dir` relative to it, the folder itself when absent. */
  z.strictObject({
    action: z.literal("files"),
    ...FolderTargetFields,
    root: FolderRootIdSchema.optional(),
    dir: relativePath(0).optional(),
  }),
  /** A file, a chunk at a time from `offset`; after the first chunk, `sha256` is the hash the first answered. */
  z.strictObject({
    action: z.literal("read"),
    ...FolderTargetFields,
    root: FolderRootIdSchema.optional(),
    path: relativePath(1),
    offset: z.number().int().nonnegative(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
]);
export type FolderPayload = z.infer<typeof FolderPayloadSchema>;
export type FolderAction = FolderPayload["action"];

/**
 * A chat's folder as `folder show` (and every change) answers it: the
 * primary, the managed folder and the attachments with their modes.
 * `unavailable` is set when the chat's host
 * folder is gone or no longer allowed: the rest is then absent
 * but `managed`, and Reset is the remedy.
 */
export const FolderViewSchema = z.strictObject({
  taskId: IdSchema,
  revision: z.number().int().nonnegative(),
  managed: z.string().min(1).max(CHAT_FOLDER_PATH_MAX),
  primary: z
    .strictObject({
      kind: z.enum(CHAT_FOLDER_PRIMARY_KINDS),
      path: z.string().min(1).max(CHAT_FOLDER_PATH_MAX),
      /** "Chat files" for the managed folder, else the host folder's name. */
      label: z.string().min(1).max(CHAT_FOLDER_LABEL_MAX),
    })
    .optional(),
  attachments: z.array(ChatFolderAttachmentSchema).max(256),
  managedUnavailable: z.string().min(1).max(1_000).optional(),
  unavailable: z.string().min(1).max(1_000).optional(),
  /**
   * The chat's own folder against its budget: its size
   * (`approximate` when the walk stopped at its bound, so at least this), the
   * per-folder cap, and `warning` once it or every chats' folder together is
   * past 80% of its cap. Absent where the owner keeps no budget.
   */
  budget: z
    .strictObject({
      bytes: z.number().int().nonnegative(),
      capBytes: z.number().int().positive(),
      approximate: z.literal(true).optional(),
      warning: z.string().min(1).max(1_000).optional(),
    })
    .optional(),
});
export type FolderView = z.infer<typeof FolderViewSchema>;

/** The label a chat's own managed folder is shown by. */
export const MANAGED_FOLDER_LABEL = "Chat files";

export const FOLDER_ENTRY_KINDS = ["file", "directory", "link", "other"] as const;

/** One of the folders `folder files` can list. */
export const FolderRootSchema = z.strictObject({
  id: FolderRootIdSchema,
  label: z.string().min(1).max(CHAT_FOLDER_LABEL_MAX),
  path: z.string().min(1).max(CHAT_FOLDER_PATH_MAX),
  mode: ChatFolderModeSchema,
});
export type FolderRoot = z.infer<typeof FolderRootSchema>;

export const FolderFilesAnswerSchema = z.strictObject({
  taskId: IdSchema,
  root: FolderRootSchema,
  roots: z.array(FolderRootSchema).max(260),
  /** The listed folder, relative to `root`; "" for the root itself. */
  dir: z.string().max(FOLDER_RELATIVE_PATH_MAX),
  entries: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(1_024),
        kind: z.enum(FOLDER_ENTRY_KINDS),
        size: z.number().int().nonnegative(),
        modifiedAt: TimestampSchema,
      }),
    )
    .max(FOLDER_FILES_MAX_ENTRIES),
  truncated: z.boolean(),
});
export type FolderFilesAnswer = z.infer<typeof FolderFilesAnswerSchema>;

/**
 * One `folder read` chunk. `hash` is the whole file's SHA-256 when its first
 * chunk was read; the owner hashes the file again at the last chunk and
 * refuses (`CONFLICT`) a file that changed meanwhile. A page saves the bytes
 * as `application/octet-stream` whatever the name says, so a folder's HTML
 * file is never rendered on the canvas's origin.
 */
export const FolderReadAnswerSchema = z.strictObject({
  taskId: IdSchema,
  name: z.string().min(1).max(1_024),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  totalBytes: z.number().int().nonnegative().max(FOLDER_READ_MAX_BYTES),
  offset: z.number().int().nonnegative(),
  base64: z.string().max(Math.ceil(FOLDER_READ_CHUNK_BYTES / 3) * 4),
  nextOffset: z.number().int().positive().nullable(),
});
export type FolderReadAnswer = z.infer<typeof FolderReadAnswerSchema>;

/**
 * `browse`: the folders a chat may use, for the canvas's picker. Without
 * `under`, the `--fs-root` folders; with it, the folders inside the one that
 * token was issued for. Directories only, never the data directory, a
 * credential home, a dev plugin's folder, a hidden folder or one whose path
 * has a glob character; each listed by its real path with a fresh token.
 */
export const BrowsePayloadSchema = z.strictObject({
  workspaceId: IdSchema.optional(),
  under: FolderPickTokenSchema.optional(),
});
export type BrowsePayload = z.infer<typeof BrowsePayloadSchema>;

export const BrowseEntrySchema = z.strictObject({
  token: FolderPickTokenSchema,
  name: z.string().min(1).max(1_024),
  path: z.string().min(1).max(CHAT_FOLDER_PATH_MAX),
  /** False past `FOLDER_BROWSE_MAX_DEPTH`: it may be picked, not opened. */
  opens: z.boolean(),
});
export type BrowseEntry = z.infer<typeof BrowseEntrySchema>;

export const BrowseAnswerSchema = z.strictObject({
  /** The folder listed (absent at the top, which lists the roots). */
  at: BrowseEntrySchema.optional(),
  /** The folder above `at`, while it is still under a root; absent, going up lists the roots. */
  parent: BrowseEntrySchema.optional(),
  entries: z.array(BrowseEntrySchema).max(FOLDER_BROWSE_MAX_ENTRIES),
  truncated: z.boolean(),
});
export type BrowseAnswer = z.infer<typeof BrowseAnswerSchema>;

/**
 * What a run says of the new chat's folder (`RunResult.folder`): its primary
 * kind and, for a host folder, its path; `note` is a line the client prints —
 * a `clientCwd` that was not used, and why, or a folder picked before the first
 * message that could not be attached.
 */
export const RunFolderResultSchema = z.strictObject({
  kind: z.enum(CHAT_FOLDER_PRIMARY_KINDS),
  path: z.string().min(1).max(CHAT_FOLDER_PATH_MAX).optional(),
  note: z.string().min(1).max(1_000).optional(),
});
export type RunFolderResult = z.infer<typeof RunFolderResultSchema>;
