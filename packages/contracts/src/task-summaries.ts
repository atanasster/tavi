import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

import { IdSchema, TimestampSchema } from "./ids.js";

/**
 * Generated task titles and one-line summaries.
 *
 * `tavi_tasks.summary_state` is the queue: `pending` rows whose task has
 * finished (a terminal status and no admission still running) are summarized
 * by the owner's summarizer, one at a time. A new admission on a task sets it
 * back to `pending`, so a continued task is summarized again once it finishes
 * again, never mid-run. `NULL` is a task with no `start` or `reply` admission and no terminal status yet, or a Home (summarized per epoch).
 */
export const TASK_SUMMARY_STATES = ["pending", "done", "failed", "skipped"] as const;
export type TaskSummaryState = (typeof TASK_SUMMARY_STATES)[number];

/** The longest generated title and summary (the list row's title allows 120). */
export const TASK_SUMMARY_TITLE_MAX = 60;
export const TASK_SUMMARY_TEXT_MAX = 120;

/** How much of a task's text goes into the summary call. */
export const TASK_SUMMARY_PROMPT_CLIP = 2048;
export const TASK_SUMMARY_FOLLOW_UP_CLIP = 512;
export const TASK_SUMMARY_FOLLOW_UP_LIMIT = 5;
export const TASK_SUMMARY_ANSWER_CLIP = 2048;
export const TASK_SUMMARY_ERROR_CLIP = 300;

/** A connection and model, as the task's own attempts recorded them. */
export interface TaskSummaryTarget {
  readonly connectionId: string;
  readonly model: string;
}

/** One finished task waiting for its summary, with the text the call reads (already clipped). */
export interface TaskSummaryWork {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly status: "completed" | "failed" | "stopped" | "cancelled";
  /** The compare-and-set token: a task touched since this read is left pending for the next pass. */
  readonly updatedAt: string;
  /** A delegation worker: nested under its root in Activity, so it gets no summary of its own. */
  readonly delegated: boolean;
  /** A heartbeat tick: plumbing, never summarized. */
  readonly heartbeat?: boolean;
  readonly prompt: string | null;
  /** Follow-up prompts in order, system wakes (no text) left out. */
  readonly followUps: readonly string[];
  readonly finalText: string | null;
  /** Why the last turn failed, when it did. */
  readonly error: string | null;
  /** The connection and model of the task's latest generation attempt, whatever its state; absent when it made none. */
  readonly target?: TaskSummaryTarget;
  /** Every connection any of the task's generation attempts used: its text has been to each, and only to these. */
  readonly usedConnections: readonly string[];
  /** The title an earlier pass wrote, kept for good once there is one. */
  readonly title?: string;
  /** What the summary standing now was written from (`taskSummaryInputHash`), when it was. */
  readonly inputHash?: string;
}

export const RecordTaskSummaryInputSchema = z
  .strictObject({
    taskId: IdSchema,
    /** `updatedAt` of the work item this result was made from. */
    expectedUpdatedAt: z.string().min(1).max(64),
    state: z.enum(["done", "failed", "skipped"]),
    /** Written only with `done`. */
    title: z.string().min(1).max(TASK_SUMMARY_TITLE_MAX).optional(),
    summary: z.string().min(1).max(TASK_SUMMARY_TEXT_MAX).optional(),
    /** With `done`: what this summary was written from, so a later pass over the same words is not asked again. */
    inputHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    /** With `done`: the task's words are as the standing summary was written from; its text is kept as it is. */
    unchanged: z.literal(true).optional(),
    now: TimestampSchema,
  })
  .refine((input) => input.state !== "done" || input.title !== undefined || input.unchanged === true, {
    message: "a done summary needs its title",
    path: ["title"],
  });
export type RecordTaskSummaryInput = z.infer<typeof RecordTaskSummaryInputSchema>;

/** The most characters a reader's rename of a chat may hold, as a listed title does. */
export const TASK_TITLE_MAX = 120;

interface TaskSummaryRepositoryPortDefinition {
  /**
   * Rename a chat as the reader names it, shown before the generated title,
   * which the summarizer keeps writing; `null` restores the generated one.
   * An unknown task is `NOT_FOUND`.
   */
  rename(input: { readonly taskId: string; readonly title: string | null }): void;
  /** Finished tasks waiting for a summary, least recently updated first, leaving out `exclude`. */
  pending(limit: number, exclude?: readonly string[]): readonly TaskSummaryWork[];
  /**
   * Record the outcome for a pending task, only while it is still pending,
   * unchanged since it was read and not running again. `false`: it moved on,
   * and stays queued for the next pass.
   */
  record(input: RecordTaskSummaryInput): boolean;
}

export type TaskSummaryRepositoryPort = AsyncRepository<TaskSummaryRepositoryPortDefinition>;
