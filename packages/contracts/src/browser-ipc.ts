import { z } from "zod";

import { BROWSER_TITLE_MAX, BROWSER_URL_MAX } from "./browser-history.js";
import { IdSchema, TimestampSchema } from "./ids.js";
import { SITE_RECIPES_MAX } from "./site-recipes.js";

/**
 * `browser`: the Command Center's Browser
 * section — which sites the agent is on or was on, per task, as stored —
 * scrubbed URLs (scheme, host, port and path) and page titles, never a query
 * string or fragment. A thumbnail is named by its artifact id; its bytes come
 * from `artifacts read`, which serves thumbnails only. Its writes are the
 * operator's `close`: a session kept open after its task ended holds
 * a browser context in the owner's memory until closed; and `clear-profile`,
 * which forgets the workspace's browser profile.
 */

export const BROWSER_IPC_LIST_DEFAULT = 20;
export const BROWSER_IPC_LIST_MAX = 50;
export const BROWSER_IPC_VISITS_DEFAULT = 100;
export const BROWSER_IPC_VISITS_MAX = 200;

/** Opaque: only the owner interprets it. Base64url. */
export const BrowserCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const BrowserPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("list"),
    workspaceId: IdSchema.optional(),
    /** `true`: live sessions only; `false`: closed ones only; absent: both. Newest first either way. */
    open: z.boolean().optional(),
    /** Only the sessions one task opened (the chat panel's Details). */
    taskId: IdSchema.optional(),
    /** With `taskId`: its sessions and every task's under it, a sub-agent's included (the live view's "while active"). */
    tree: z.boolean().optional(),
    cursor: BrowserCursorSchema.optional(),
    limit: z.number().int().min(1).max(BROWSER_IPC_LIST_MAX).optional(),
  }),
  /** Close one session (`sessionId`), or every inactive one (`inactive: true`); recorded as closed by the operator. */
  z.strictObject({
    action: z.literal("close"),
    workspaceId: IdSchema.optional(),
    sessionId: IdSchema.optional(),
    inactive: z.literal(true).optional(),
  }),
  /**
   * The workspace's site recipes — the browser steps that last led to results
   * on each site — and, with `forget`, one
   * site's forgotten (a host), or every one (`true`), first; with `replay`,
   * one site's recipe marked to replay (`on`) or not, first.
   */
  z.strictObject({
    action: z.literal("recipes"),
    workspaceId: IdSchema.optional(),
    forget: z.union([z.string().min(1).max(253), z.literal(true)]).optional(),
    replay: z.strictObject({ host: z.string().min(1).max(253), on: z.boolean() }).optional(),
  }),
  /**
   * A site's recipe saved as a proposed site note (`tavi browser site-notes
   * --propose <host>`): written to the data directory's `site-notes/`, off
   * until the operator reviews it and turns it on. Never over a note there.
   */
  z.strictObject({
    action: z.literal("propose-site-note"),
    workspaceId: IdSchema.optional(),
    host: z.string().min(1).max(253),
  }),
  /** Forget the workspace's browser profile — cookies, consent choices, logins — closing its open sessions first. */
  z.strictObject({
    action: z.literal("clear-profile"),
    workspaceId: IdSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("visits"),
    workspaceId: IdSchema.optional(),
    sessionId: IdSchema,
    cursor: BrowserCursorSchema.optional(),
    limit: z.number().int().min(1).max(BROWSER_IPC_VISITS_MAX).optional(),
  }),
]);
export type BrowserPayload = z.infer<typeof BrowserPayloadSchema>;

const count = z.number().int().nonnegative();
const StoredUrlSchema = z.string().min(1).max(BROWSER_URL_MAX);
const StoredTitleSchema = z.string().min(1).max(BROWSER_TITLE_MAX);

/** One session as the Browser section shows it. */
export const BrowserSessionViewSchema = z.strictObject({
  sessionId: IdSchema,
  taskId: IdSchema,
  /** The task's generated title, else the first line of its prompt; absent when neither is known. */
  taskTitle: z.string().min(1).max(256).optional(),
  principalId: IdSchema,
  openedAt: TimestampSchema,
  closedAt: TimestampSchema.nullable(),
  closeReason: z.string().max(256).nullable(),
  /** In use now: not closed, and its task not over. */
  live: z.boolean(),
  /**
   * Its task is over, and the session is kept open for the chat's next turn:
   * shown as **Ended**, and closable by the operator. Absent while in
   * use and once closed.
   */
  inactive: z.literal(true).optional(),
  /** The last page's scrubbed URL, and its host (`null` for a page without one, such as `about:blank`). */
  lastUrl: StoredUrlSchema.nullable(),
  host: z.string().min(1).max(256).nullable(),
  lastTitle: StoredTitleSchema.nullable(),
  pages: count,
  /** Opened until closed (or until its task ended, for an inactive one), or until the answer for a live session. */
  durationMs: count,
  /** The last page's thumbnail, when one was kept (never for a page with a password field or on a blocked host). */
  thumbnail: z.strictObject({ artifactId: IdSchema }).optional(),
  /** The id of the `browser.create_session` call that opened it, as the task's tool events name it; absent when not recorded. */
  openedByCallId: z.string().min(1).max(256).optional(),
});
export type BrowserSessionView = z.infer<typeof BrowserSessionViewSchema>;

export const BrowserListAnswerSchema = z.strictObject({
  items: z.array(BrowserSessionViewSchema).max(BROWSER_IPC_LIST_MAX),
  /** Where the next page starts; absent after the last. */
  nextCursor: BrowserCursorSchema.optional(),
});
export type BrowserListAnswer = z.infer<typeof BrowserListAnswerSchema>;

export const BrowserVisitViewSchema = z.strictObject({
  seq: z.number().int().positive(),
  /** Scrubbed: scheme, host, port and path. */
  url: StoredUrlSchema,
  title: StoredTitleSchema.nullable(),
  at: TimestampSchema,
});
export type BrowserVisitView = z.infer<typeof BrowserVisitViewSchema>;

/** A session's visits, in the order they happened. */
export const BrowserVisitsAnswerSchema = z.strictObject({
  sessionId: IdSchema,
  items: z.array(BrowserVisitViewSchema).max(BROWSER_IPC_VISITS_MAX),
  nextCursor: BrowserCursorSchema.optional(),
});
export type BrowserVisitsAnswer = z.infer<typeof BrowserVisitsAnswerSchema>;

/** What `browser close` answers: the sessions it closed. */
export const BrowserCloseAnswerSchema = z.strictObject({ closed: z.array(IdSchema).max(BROWSER_IPC_LIST_MAX * 10) });
export type BrowserCloseAnswer = z.infer<typeof BrowserCloseAnswerSchema>;

/** `clear-profile`'s answer: how many open sessions it closed first. */
export const BrowserClearProfileAnswerSchema = z.strictObject({ closed: z.number().int().nonnegative() });
export type BrowserClearProfileAnswer = z.infer<typeof BrowserClearProfileAnswerSchema>;

/** `recipes`' answer: the workspace's recipes, newest first, and how many `forget` removed. */
export const BrowserRecipesAnswerSchema = z.strictObject({
  recipes: z
    .array(
      z.strictObject({
        host: z.string().min(1).max(253),
        steps: z
          .array(
            z.strictObject({
              kind: z.string().min(1).max(40),
              role: z.string().max(80).optional(),
              label: z.string().max(240).optional(),
              value: z.string().max(80).optional(),
            }),
          )
          .max(50),
        results: z.number().int().nonnegative(),
        uses: z.number().int().positive(),
        updatedAt: z.string().min(1).max(64),
        /** A person marked it to replay: the site's next session runs its steps first. */
        replay: z.literal(true).optional(),
      }),
    )
    .max(SITE_RECIPES_MAX),
  forgotten: z.number().int().nonnegative().optional(),
  /** How many recipes a `replay` change touched: 0 when the site has none. */
  replayChanged: z.number().int().nonnegative().optional(),
});
export type BrowserRecipesAnswer = z.infer<typeof BrowserRecipesAnswerSchema>;

/** `propose-site-note`'s answer: the note written, off, and its file in the data directory's `site-notes/`. */
export const BrowserSiteNoteProposedAnswerSchema = z.strictObject({
  proposed: z.strictObject({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(80),
    hosts: z.array(z.string().min(1).max(253)).min(1).max(16),
    /** The file's name within `site-notes/`; the CLI also says its full path. */
    file: z.string().min(1).max(80),
    /** Proposed notes are off until turned on: always false here. */
    on: z.literal(false),
  }),
});
export type BrowserSiteNoteProposedAnswer = z.infer<typeof BrowserSiteNoteProposedAnswerSchema>;

/**
 * A session's duration as the Browser cards and `tavi browser history` say it:
 * "45 s", "18 min", "2 h", "2 h 5 min".
 */
export function formatBrowserDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}
