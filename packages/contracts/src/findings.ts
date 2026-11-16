import { z } from "zod";

import type { AsyncRepository } from "./persistence-types.js";

/**
 * A task's findings: the records it has
 * gathered — flights with their prices, products, listings — kept with the
 * task rather than only in its conversation, so a long search that compacts
 * its context still answers from everything it found. `browser.extract`
 * adds what it extracts; `findings.add` adds what the agent gathered another
 * way; `findings.list` reads them back for the answer and its check.
 *
 * Findings are what pages said: untrusted data, never instructions.
 */

/** The most findings one task keeps; past it the oldest are dropped. */
export const TASK_FINDINGS_MAX = 500;
/** The most JSON one finding's record may take, in UTF-16 units. */
export const TASK_FINDING_MAX_CHARS = 8_000;
/** A finding's kind: a short label the agent chooses ("flight", "hotel"). */
export const TASK_FINDING_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * What one write of findings carries: `findings.add`'s input, and each entry
 * of a plugin tool's `taviFindings`, which the owner keeps with the task and
 * leaves out of the model's view.
 */
export const FindingWriteInputSchema = z.object({
  kind: z.string().regex(TASK_FINDING_KIND_PATTERN).describe("A short label for what the records are: flight, hotel, product"),
  records: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
  sourceUrl: z.string().url().max(2_048).optional().describe("The page they came from"),
});
export type FindingWriteInput = z.infer<typeof FindingWriteInputSchema>;

/** The first record whose JSON is past `TASK_FINDING_MAX_CHARS`, or -1 when every record fits. */
export function oversizedFindingIndex(records: readonly unknown[]): number {
  return records.findIndex((record) => JSON.stringify(record).length > TASK_FINDING_MAX_CHARS);
}

/** The most `taviFindings` entries one plugin tool result may carry. */
export const PLUGIN_RESULT_FINDINGS_MAX = 8;

export interface TaskFinding {
  readonly taskId: string;
  /** Its place in the task's findings, from 1, in the order they were added. */
  readonly seq: number;
  readonly kind: string;
  readonly record: unknown;
  /** The page it came from, when it came from one. */
  readonly sourceUrl?: string;
  readonly createdAt: string;
}

interface TaskFindingRepositoryPortDefinition {
  /**
   * Add records of `kind`, in order, numbered after the task's last; past
   * `TASK_FINDINGS_MAX` the task's oldest are dropped. Answers the added ones.
   */
  add(input: {
    readonly taskId: string;
    readonly workspaceId: string;
    readonly kind: string;
    readonly records: readonly unknown[];
    readonly sourceUrl?: string | undefined;
    readonly createdAt: string;
  }): readonly TaskFinding[];
  /** The task's findings in order, of one `kind` or all, at most `limit`, after `afterSeq`. */
  list(input: {
    readonly taskId: string;
    readonly workspaceId: string;
    readonly kind?: string | undefined;
    readonly afterSeq?: number | undefined;
    readonly limit: number;
  }): readonly TaskFinding[];
}

export type TaskFindingRepositoryPort = AsyncRepository<TaskFindingRepositoryPortDefinition>;
