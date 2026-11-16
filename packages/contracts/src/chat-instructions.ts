import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";
import type { AsyncRepository } from "./persistence-types.js";
import { CHAT_MEMORY_MODES } from "./ports/tasks.js";
import { TASK_TITLE_MAX } from "./task-summaries.js";

/**
 * A chat's own instructions: the prompt
 * layer the reader writes for one chat, after the base and the persona and
 * before the runtime facts.
 *
 * Every save is a new revision, never an overwrite: the current text is the
 * highest revision, and an empty text is a reset. A turn is admitted under the
 * revision current then (`AdmissionRecord.instructionsRevision`), and every
 * model call of that turn reads that revision, so an edit applies from the
 * next turn and never changes one already running.
 */

/** The most characters a chat's instructions may hold: they are sent on every model call. */
export const CHAT_INSTRUCTIONS_MAX = 8_000;
/** The most revisions one history read returns. */
export const CHAT_INSTRUCTIONS_HISTORY_MAX = 50;

export const ChatInstructionsTextSchema = z
  .string()
  .max(CHAT_INSTRUCTIONS_MAX, `A chat's instructions are at most ${CHAT_INSTRUCTIONS_MAX} characters`);

export const ChatInstructionsRevisionSchema = z.strictObject({
  taskId: IdSchema,
  revision: z.number().int().positive(),
  /** Empty: the revision that cleared them. */
  text: z.string().max(CHAT_INSTRUCTIONS_MAX),
  /** Who saved it: `operator:ui`, `operator:cli`, or the principal a run payload carried it for. */
  author: z.string().min(1).max(256),
  recordedAt: z.string().min(1),
});
export type ChatInstructionsRevision = z.infer<typeof ChatInstructionsRevisionSchema>;

/** A save: compare-and-set on the revision the writer read (0 when the chat had none). */
export interface RecordChatInstructionsInput {
  readonly taskId: string;
  readonly text: string;
  readonly author: string;
  readonly expectedRevision: number;
  readonly now: string;
}

interface ChatInstructionsRepositoryPortDefinition {
  /** The chat's current revision; absent when it never had instructions. */
  current(taskId: string): ChatInstructionsRevision | undefined;
  /** One revision, as a turn pinned it; absent when there is no such revision. */
  get(taskId: string, revision: number): ChatInstructionsRevision | undefined;
  /** The revision an admission was made under; absent when the chat had none then. */
  forAdmission(admissionId: string): ChatInstructionsRevision | undefined;
  /** Revisions newest first, at most `limit` (bounded by `CHAT_INSTRUCTIONS_HISTORY_MAX`). */
  history(taskId: string, limit: number): readonly ChatInstructionsRevision[];
  /**
   * Save a new revision. A stale `expectedRevision` is `CONFLICT` with the
   * current revision in its details (never the text); an unknown task is
   * `NOT_FOUND`; text past `CHAT_INSTRUCTIONS_MAX` is `INVALID_INPUT`.
   */
  record(input: RecordChatInstructionsInput): ChatInstructionsRevision;
}

export type ChatInstructionsRepositoryPort = AsyncRepository<ChatInstructionsRepositoryPortDefinition>;

/**
 * The `chat-context` IPC command: a chat's
 * instructions, read and saved by the chat panel and `tavi tasks
 * instructions`. `set` and `reset` are compare-and-set on the revision the
 * writer read; `reset` saves an empty revision. The author is the front end
 * that asked, never a payload field.
 */
export const CHAT_CONTEXT_ACTIONS = [
  "get",
  "set",
  "reset",
  "history",
  "rename",
  "export",
  "forget",
  "compact",
  "rewind",
  "memory",
] as const;

const chatContextTarget = { workspaceId: IdSchema.optional(), taskId: IdSchema };
export const ChatContextPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("get"), ...chatContextTarget }),
  z.strictObject({
    action: z.literal("set"),
    ...chatContextTarget,
    text: ChatInstructionsTextSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({ action: z.literal("reset"), ...chatContextTarget, expectedRevision: z.number().int().nonnegative() }),
  z.strictObject({
    action: z.literal("history"),
    ...chatContextTarget,
    limit: z.number().int().min(1).max(CHAT_INSTRUCTIONS_HISTORY_MAX).optional(),
  }),
  /** Name the chat as the reader calls it; `null` goes back to the generated title. */
  z.strictObject({ action: z.literal("rename"), ...chatContextTarget, title: z.string().trim().min(1).max(TASK_TITLE_MAX).nullable() }),
  /**
   * The chat's saved history as Markdown, a page at a time, oldest page first,
   * so a reader can write each page as it comes; `after` is the
   * previous answer's `nextAfter`, and `noticeSkip` its `nextNoticeSkip`.
   */
  z.strictObject({
    action: z.literal("export"),
    ...chatContextTarget,
    after: z.number().int().nonnegative().optional(),
    noticeSkip: z.number().int().nonnegative().optional(),
  }),
  /**
   * Erase the chat's saved history from before `before` — or from before
   * epoch `epoch` began (its rollover's time) — and its older checkpoints.
   * Exactly one of the two. Its fold archives from
   * then go too, and the memory proposals it made then that still wait;
   * `withMemory` also forgets the approved memories it taught then.
   */
  z
    .strictObject({
      action: z.literal("forget"),
      ...chatContextTarget,
      before: TimestampSchema.optional(),
      epoch: z.number().int().positive().optional(),
      withMemory: z.literal(true).optional(),
    })
    .refine((value) => (value.before === undefined) !== (value.epoch === undefined), {
      message: "forget takes either before or epoch, not both and not neither",
    }),
  /**
   * Fresh context: the chat's next message starts a new epoch
   * whatever its length — everything before it folds into the epoch summary.
   * Held by the owner until that message; asked again, it is still one.
   */
  z.strictObject({ action: z.literal("compact"), ...chatContextTarget }),
  /**
   * Rewind: take back turn `seq` and every later one — the saved
   * history and what the model is given from the chat's next message on —
   * so the chat goes on from before it. `prompt` is the turn's message as
   * the reader saw it: a turn that is not it is refused, never rewound.
   */
  z.strictObject({
    action: z.literal("rewind"),
    ...chatContextTarget,
    seq: z.number().int().positive(),
    prompt: z.string().min(1).max(200_000),
  }),
  /**
   * Turn the chat's memory off or back on, from its next turn. Back on,
   * nothing said while it was off is
   * captured. A private chat stays private: `on` is refused `CONFLICT`, and
   * a chat is made private only when it is created (`run { memory }`).
   */
  z.strictObject({ action: z.literal("memory"), ...chatContextTarget, mode: z.enum(["on", "off"]) }),
]);
export type ChatContextPayload = z.infer<typeof ChatContextPayloadSchema>;

/** `get`, `set` and `reset` answer the chat's state after the call. */
export const ChatContextAnswerSchema = z.strictObject({
  taskId: IdSchema,
  /** The current revision, 0 when the chat never had instructions; what a save sends back as `expectedRevision`. */
  revision: z.number().int().nonnegative(),
  current: ChatInstructionsRevisionSchema.nullable(),
  /**
   * The chat a delegated task belongs to: a delegated task runs under its own
   * agent's instructions, not a chat layer, so its panel names this chat and
   * a `set` or `reset` on the delegated task is refused.
   */
  delegatedFrom: IdSchema.optional(),
  /** What the chat is called: the reader's name, else the generated title; absent before either exists. */
  title: z.string().min(1).max(TASK_TITLE_MAX).optional(),
  /** The title is the reader's name, not the generated one. */
  renamed: z.literal(true).optional(),
  /** The chat's memory mode: absent while memory is on; a worker's is its chat's. */
  memoryMode: z.enum(CHAT_MEMORY_MODES).optional(),
});
export type ChatContextAnswer = z.infer<typeof ChatContextAnswerSchema>;

export const ChatContextHistoryAnswerSchema = z.strictObject({
  taskId: IdSchema,
  revisions: z.array(ChatInstructionsRevisionSchema).max(CHAT_INSTRUCTIONS_HISTORY_MAX),
});
export type ChatContextHistoryAnswer = z.infer<typeof ChatContextHistoryAnswerSchema>;

/** How much Markdown one `export` answer carries, so a page always fits an IPC frame. */
export const CHAT_EXPORT_PAGE_CHARS = 256_000;

/**
 * `export`: one page of the chat's saved turns as Markdown, oldest first, with
 * the notices posted among them, and `nextAfter` while more remains: the turn
 * the page ended after, and `nextNoticeSkip` how many of the notices after it
 * the page already wrote (a page can end among notices; none is dropped).
 * `title` names the chat for the document's heading; the first page (no
 * `after`) carries the chat's latest epoch summary, when it has one.
 */
export const ChatContextExportAnswerSchema = z.strictObject({
  taskId: IdSchema,
  title: z.string(),
  turns: z.number().int().nonnegative(),
  markdown: z.string(),
  nextAfter: z.number().int().nonnegative().optional(),
  nextNoticeSkip: z.number().int().nonnegative().optional(),
  epochSummary: z.string().max(CHAT_EXPORT_PAGE_CHARS).optional(),
});
export type ChatContextExportAnswer = z.infer<typeof ChatContextExportAnswerSchema>;

/** How many related chats a `forget` answer names at most. */
export const CHAT_FORGET_RELATED_MAX = 100;

/**
 * `forget`: how many saved turns were erased, the instant they were erased
 * before, and how many older checkpoints were let go. `related` names the side
 * chats and workers begun from this chat before then: each keeps its own copy
 * of what it was given, and is forgotten on its own.
 */
export const ChatContextForgetAnswerSchema = z.strictObject({
  taskId: IdSchema,
  forgotten: z.number().int().nonnegative(),
  before: TimestampSchema,
  checkpointsPruned: z.number().int().nonnegative(),
  related: z.array(z.strictObject({ taskId: IdSchema, kind: z.enum(["side", "worker"]) })).max(CHAT_FORGET_RELATED_MAX),
  /**
   * The chat's own folder, which forget does not touch: its
   * path and size (`approximate` when the walk stopped at its bound), for the
   * reader to clear with `chatFolderPruneCommand`. Absent where the owner
   * cannot say.
   */
  folder: z
    .strictObject({ path: z.string().min(1).max(4_096), bytes: z.number().int().nonnegative(), approximate: z.literal(true).optional() })
    .optional(),
  /** How many of its fold archives went; absent from an older owner. */
  archives: z.number().int().nonnegative().optional(),
  /** How many memory proposals it made that were still waiting went; absent from an older owner. */
  proposals: z.number().int().nonnegative().optional(),
  /** How many approved memories it taught were forgotten, with `withMemory`. */
  memories: z.number().int().nonnegative().optional(),
  /** Approved memories it taught that stay because `withMemory` was not asked for. */
  memoriesKept: z.number().int().nonnegative().optional(),
  /** The chat is another person's (a bound person's), whose memory nobody else decides (invariant 21): none of it was read or touched. */
  memoryNotYours: z.literal(true).optional(),
  /** The memory providers the removal of what it forgot waits for (each receipt's `pendingProviders`), sorted; absent when none. */
  memoryWaitsFor: z.array(z.string().min(1).max(128)).max(16).optional(),
});
export type ChatContextForgetAnswer = z.infer<typeof ChatContextForgetAnswerSchema>;

/** `compact`: the chat's next message starts a fresh epoch. */
export const ChatContextCompactAnswerSchema = z.strictObject({ taskId: IdSchema, freshContext: z.literal("next-message") });
export type ChatContextCompactAnswer = z.infer<typeof ChatContextCompactAnswerSchema>;

/** `rewind`: how many saved turns went, and the rewound message, for the reader to send again. */
export const ChatContextRewindAnswerSchema = z.strictObject({
  taskId: IdSchema,
  seq: z.number().int().positive(),
  rewound: z.number().int().nonnegative(),
  prompt: z.string(),
});
export type ChatContextRewindAnswer = z.infer<typeof ChatContextRewindAnswerSchema>;
