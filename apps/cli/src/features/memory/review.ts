import {
  memoryCardScopeLabel,
  memoryMayUpdateLine,
  memoryProvenanceLine,
  memoryUpdatesLine,
  type MemoryGetAnswer,
  type MemoryItem,
  type MemoryListAnswer,
  type MemoryPayload,
} from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

import { MEMORY_TIDY_STALE } from "./bulk.js";
import { terminalText } from "../../shared/terminal-text.js";

/**
 * `tavi memory review`: the waiting
 * proposals one at a time, oldest first, each with its kind, where it would
 * apply, its expiry, the chat it came from and how much evidence it cites;
 * `k` keeps it, `d` discards it, `e` takes new words and keeps it as written
 * (keep, then correct: only approved memory is corrected), `s` skips it and
 * `q` stops. A sensitive proposal's text is withheld until `v` asks for it.
 * An update names the kept record it updates and takes `r` to
 * replace it — a correction of that record, the proposal then discarded — or,
 * a fact, `k` to keep both; a near duplicate says what it is similar to.
 * One proposed after its chat read untrusted content says what the chat read:
 * the hosts Tavi parsed first, a page's own title
 * only as what it calls itself. Every decision goes through the owner's `memory` command as the operator,
 * held to the revision shown, so one decided elsewhere meanwhile is said to be.
 */

/** One `memory` request to the owner: its answer, or its refusal. */
type MemoryReviewRequest = (
  payload: MemoryPayload,
) => Promise<
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
>;

export interface MemoryReviewDependencies {
  readonly request: MemoryReviewRequest;
  /** The person's answer to `question`; undefined once input ended. */
  readonly ask: (question: string) => Promise<string | undefined>;
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly workspaceId: string;
}

export interface MemoryReviewSummary {
  readonly kept: number;
  readonly replaced: number;
  readonly discarded: number;
  readonly edited: number;
  readonly skipped: number;
  readonly failed: number;
}

/** Proposals one review walks through, at most. */
const REVIEW_PAGE = 100;

export async function runMemoryReview(deps: MemoryReviewDependencies): Promise<MemoryReviewSummary> {
  const counts = { kept: 0, replaced: 0, discarded: 0, edited: 0, skipped: 0, failed: 0 };
  const listed = await deps.request({ action: "list", workspaceId: deps.workspaceId, statuses: ["proposed"], limit: REVIEW_PAGE });
  if (!listed.ok) {
    deps.stderr(`${terminalText(listed.error.message)}\n`);
    return { ...counts, failed: 1 };
  }
  const pending = [...(listed.result as MemoryListAnswer).records]
    .filter((record) => record.target !== "shared")
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  if (pending.length === 0) {
    deps.stdout("Nothing waiting to be remembered.\n");
    return counts;
  }
  /** A refusal said, and counted. */
  const failed = (message: string): void => {
    counts.failed += 1;
    deps.stderr(`  ${terminalText(message)}\n`);
  };
  /**
   * The record's state now, when a decision found it changed. A tidy-up that still waits is stale: an input
   * changed since it was suggested, so it is discarded and the next weekly run suggests it again.
   */
  const decidedElsewhere = async (record: MemoryItem): Promise<string> => {
    const now = await deps.request({ action: "get", workspaceId: deps.workspaceId, recordId: record.recordId });
    const status = now.ok ? (now.result as MemoryGetAnswer).record.status : "deleted";
    if (status === "proposed" && record.supersedes !== undefined) return MEMORY_TIDY_STALE;
    return status === "approved" ? "Already kept." : status === "rejected" ? "Already discarded." : "No longer waiting.";
  };

  review: for (const [index, record] of pending.entries()) {
    deps.stdout(`\n${describe(record, index + 1, pending.length)}`);
    // An update is replaced, or a fact's kept beside it; it is not kept, nor edited, as a plain one.
    const targetRef = record.updates ?? record.mayUpdate;
    const update = targetRef !== undefined;
    const keepable = !update || record.kind === "fact";
    const choices = update
      ? `r replace${keepable ? " · k keep both" : ""} · d discard · s skip · q quit > `
      : "k keep · d discard · e edit · s skip · q quit > ";
    for (;;) {
      const answer = (await deps.ask(choices))?.trim().toLowerCase();
      if (answer === undefined || answer === "q") break review;
      if (answer === "r" && update) {
        const replaced = await deps.request({
          action: "replace",
          workspaceId: deps.workspaceId,
          recordId: record.recordId,
          ...(record.currentRevisionId === undefined ? {} : { expectedRevisionId: record.currentRevisionId }),
          ...(targetRef.currentRevisionId === undefined ? {} : { targetRevisionId: targetRef.currentRevisionId }),
        });
        if (replaced.ok) {
          counts.replaced += 1;
          deps.stdout("  Replaced.\n");
        } else if (replaced.error.code === "REVISION_CONFLICT" || replaced.error.code === "CONFLICT") {
          deps.stdout(`  ${await decidedElsewhere(record)}\n`);
        } else {
          failed(replaced.error.message);
        }
        continue review;
      }
      if (answer === "s") {
        counts.skipped += 1;
        continue review;
      }
      if (answer === "v" && record.redacted) {
        const shown = await deps.request({ action: "get", workspaceId: deps.workspaceId, recordId: record.recordId, reveal: true });
        if (shown.ok) deps.stdout(`  ${terminalText((shown.result as MemoryGetAnswer).record.body ?? "")}\n`);
        else failed(shown.error.message);
        continue;
      }
      if ((answer === "k" && keepable) || answer === "d") {
        const decided = await deps.request({
          action: answer === "k" ? "approve" : "reject",
          workspaceId: deps.workspaceId,
          recordId: record.recordId,
          ...(record.currentRevisionId === undefined ? {} : { expectedRevisionId: record.currentRevisionId }),
        });
        if (decided.ok) {
          if (answer === "k") counts.kept += 1;
          else counts.discarded += 1;
          deps.stdout(answer === "k" ? "  Kept.\n" : "  Discarded.\n");
        } else if (decided.error.code === "REVISION_CONFLICT" || decided.error.code === "CONFLICT") {
          deps.stdout(`  ${await decidedElsewhere(record)}\n`);
        } else {
          failed(decided.error.message);
        }
        continue review;
      }
      if (answer === "e" && !update) {
        const text = (await deps.ask("New words (empty to go back) > "))?.trim();
        if (text === undefined) break review;
        if (text === "") continue;
        const kept = await deps.request({
          action: "approve",
          workspaceId: deps.workspaceId,
          recordId: record.recordId,
          ...(record.currentRevisionId === undefined ? {} : { expectedRevisionId: record.currentRevisionId }),
        });
        if (!kept.ok) {
          if (kept.error.code === "REVISION_CONFLICT" || kept.error.code === "CONFLICT")
            deps.stdout(`  ${await decidedElsewhere(record)}\n`);
          else failed(kept.error.message);
          continue review;
        }
        const revision = (kept.result as MemoryItem).currentRevisionId;
        const corrected = await deps.request({
          action: "correct",
          workspaceId: deps.workspaceId,
          recordId: record.recordId,
          ...(revision === undefined ? {} : { expectedRevisionId: revision }),
          body: text,
        });
        if (corrected.ok) {
          counts.edited += 1;
          deps.stdout("  Kept, in your words.\n");
        } else {
          counts.kept += 1;
          failed(`Kept as proposed; the edit was not saved: ${corrected.error.message}`);
        }
        continue review;
      }
      deps.stdout(
        `  ${update ? (keepable ? "r, k, d, s or q" : "r, d, s or q") : "k, d, e, s or q"}${record.redacted ? " (v shows a sensitive one)" : ""}.\n`,
      );
    }
  }
  const parts = [
    `kept ${counts.kept}`,
    ...(counts.replaced > 0 ? [`replaced ${counts.replaced}`] : []),
    `discarded ${counts.discarded}`,
    `edited ${counts.edited}`,
    `skipped ${counts.skipped}`,
    ...(counts.failed > 0 ? [`failed ${counts.failed}`] : []),
  ];
  deps.stdout(`\n${parts.join(" · ")}.\n`);
  return counts;
}

/** A proposal as the review shows it: never a sensitive one's text unasked. */
function describe(record: MemoryItem, position: number, total: number): string {
  const lines = [
    `[${position}/${total}] ${record.kind} · ${memoryCardScopeLabel(record.target)}${record.expiresAt === undefined ? "" : ` · expires ${record.expiresAt.slice(0, 10)}`}`,
  ];
  if (record.redacted) {
    lines.push("  (sensitive — v shows it)");
  } else {
    if (record.title !== null) lines.push(`  ${terminalText(record.title)}`);
    if (record.body !== null) lines.push(`  ${terminalText(record.body.replace(/\s+/g, " ").trim())}${record.truncated ? "…" : ""}`);
  }
  if (record.updates !== undefined) lines.push(`  ${terminalText(memoryUpdatesLine(record.updates))}`);
  else if (record.mayUpdate !== undefined) lines.push(`  ${terminalText(memoryMayUpdateLine(record.mayUpdate))}`);
  if (record.similarTo !== undefined) lines.push(`  similar to: ${terminalText(record.similarTo.title ?? "a kept memory")}`);
  const read = memoryProvenanceLine(record.provenance, { tidyUp: record.supersedes !== undefined });
  if (read !== undefined) lines.push(`  ${terminalText(read)}`);
  const from = [
    record.originTaskId === undefined ? undefined : `from chat ${record.originTaskId}`,
    record.sourceCount > 0 ? plural(record.sourceCount, "source") : undefined,
  ].filter((part) => part !== undefined);
  if (from.length > 0) lines.push(`  ${from.join(" · ")}`);
  return `${lines.join("\n")}\n`;
}
